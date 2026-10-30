import { RunnerId, type AgentEvent, type RoutingLogRow, type RoutingSuggestion, type RunnerAdapter } from "@switchboard/protocol";
import { DAEMON_JOB_MARK } from "./detached.ts";
import type { RoutingContext, Suggester } from "./routing.ts";

/** How many past decisions are put in front of the model. Enough to show a pattern, small enough to stay cheap. */
export const DEFAULT_EXAMPLE_COUNT = 20;

export interface LlmSuggesterOptions {
  /** The runner that produces the suggestion. Switchboard holds no API key: the runner's own CLI / session does. */
  adapter: RunnerAdapter;
  /** Directory the one-turn session runs in — the daemon's data dir, never a repository the agent could edit. */
  cwd: string;
  /** Recent decisions with their outcome (`Db.routingLog()`), newest first. */
  examples: () => RoutingLogRow[];
  model?: string;
  exampleCount?: number;
  /** Read-only mode for the runner (Claude `plan`); adapters without modes ignore it. */
  permissionMode?: string;
  /**
   * Called with the turn's *reported* usage (the runner's own final figure) so the caller can put it in the
   * ledger — asking costs quota and must be visible. Per-call `turn` counters are skipped for the same reason
   * `TaskManager` skips them: they carry no model and no cost, so pricing them would guess a model and a price.
   */
  onUsage?: (ev: Extract<AgentEvent, { t: "usage" }>) => void;
  log?: (msg: string) => void;
}

/**
 * Asks a runner which runner a task should go to (#25). Advice only: `CompositeSuggester` attaches the answer next
 * to the rule table's suggestion, and the person still picks. One turn, no tools, JSON out — anything else throws,
 * and the composite then falls back to the rule table.
 */
export class LlmSuggester implements Suggester {
  readonly kind = "llm";
  constructor(private opts: LlmSuggesterOptions) {}

  async suggest(ctx: RoutingContext, signal: AbortSignal): Promise<RoutingSuggestion> {
    const candidates = [...ctx.available];
    if (candidates.length === 0) throw new Error("no runner is installed");
    const prompt = buildPrompt(ctx, this.opts.examples().slice(0, this.opts.exampleCount ?? DEFAULT_EXAMPLE_COUNT));
    const text = await runSuggestionTurn(this.opts, prompt, signal);
    const answer = parseSuggestion(text, candidates);
    return { runner: answer.runner, reason: answer.reason, ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
  }
}

/** What one suggestion turn needs: shared by the runner suggester here and the Workspace suggester (#135). */
export type SuggestionTurnOptions = Pick<LlmSuggesterOptions, "adapter" | "cwd" | "model" | "permissionMode" | "onUsage" | "log">;

/** One turn of the runner, collected as text. The session is always closed, including when the caller gives up. */
export async function runSuggestionTurn(opts: SuggestionTurnOptions, prompt: string, signal: AbortSignal): Promise<string> {
  let out = "";
  let failure: string | null = null;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  // not saved (#2908): these turns run hundreds of times a day and would fill the 200 sessions `/insights` reads and
  // ~/.claude/projects; nothing resumes them
  const session = opts.adapter.start({ cwd: opts.cwd, scope: [opts.cwd], prompt, model: opts.model || undefined, permissionMode: opts.permissionMode, persistSession: false, env: { [DAEMON_JOB_MARK]: "judge" } }, (ev) => {
    if (ev.t === "message.delta" && ev.role === "assistant") out += ev.text;
    else if (ev.t === "usage" && ev.source === "reported") opts.onUsage?.(ev);
    // A suggestion turn must not ask for anything: it has no tools and nothing to approve. If the runner asks
    // anyway (Claude reaches for ExitPlanMode in `plan` mode), the turn is over — there is nobody to answer a
    // question the person never started. Same for a mid-turn error. Neither voids text that already arrived:
    // `failure` is only reported when there is nothing to parse.
    else if (ev.t === "permission.ask") (failure ??= "the suggestion turn asked for a permission"), done();
    else if (ev.t === "error") (failure ??= ev.message), done();
    else if (ev.t === "session.end") done();
  });
  const onAbort = () => done();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([finished, session.exited]);
    if (signal.aborted) throw new Error(String((signal.reason as Error)?.message ?? "aborted"));
    if (!out.trim()) throw new Error(failure ?? `${opts.adapter.id} answered nothing`);
    return out;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // close() rather than abort(): nothing is in flight worth interrupting, and a runner that is already gone
    // must not turn a parse error into an unhandled rejection.
    void session.close({ graceMs: 0 }).catch((e) => opts.log?.(`suggest-llm: closing the session failed (${String((e as Error).message ?? e)})`));
  }
}

/**
 * The runner's own read-only mode for a suggestion turn. `undefined` from an adapter that *has* modes would mean
 * "the adapter's default" (Claude `auto`, Codex workspace-write), not "no constraint needed" — so the caller must
 * treat that as "cannot ask this runner safely" rather than as a green light. An adapter with no modes at all
 * (DAK) has no such knob: its own configuration governs what it may do.
 */
export function readOnlyMode(adapter: RunnerAdapter): { mode?: string; unconstrained: boolean } {
  const preferred: Record<string, string> = { claude: "plan", codex: "read-only" };
  const want = preferred[adapter.id];
  if (!adapter.permissionModes?.length) return { unconstrained: true };
  const mode = adapter.permissionModes.find((m) => m.value === want)?.value;
  return { mode, unconstrained: mode === undefined };
}

/**
 * The prompt. System-style instructions first (the adapters have no separate system channel), then the task, then
 * the past decisions as a table. Kept short: this runs on every task creation.
 */
export function buildPrompt(ctx: RoutingContext, examples: RoutingLogRow[]): string {
  const candidates = [...ctx.available];
  // Titles are one line and capped: they come from Inbox notes and imported sessions, so they are neither short
  // nor trusted, and a table row that runs for a page buys nothing.
  const rows = examples.map((e) => `| ${e.suggestedBy} | ${e.suggested} | ${e.chosen} | ${e.status} | ${e.outcome} | ${e.costUsd.toFixed(4)} | ${Math.round(e.durationMs / 1000)}s | ${oneLine(e.title).slice(0, 120).replace(/\|/g, "／")} |`);
  return [
    "あなたはタスクをどのエージェント（ランナー）に振るかを提案します。JSON だけを返してください。",
    'ほかの文章・コードブロック・前置きは書かないこと。形式: {"runner": "<候補のいずれか>", "reason": "<日本語で 60 字以内の理由>"}',
    "",
    `候補のランナー: ${candidates.join(", ")}`,
    "",
    "## 判断してほしいタスク",
    `title: ${oneLine(ctx.title)}`,
    `prompt: ${oneLine(ctx.prompt).slice(0, 1200)}`,
    `作業ディレクトリ数: ${ctx.scope.length}`,
    `scope: ${ctx.scope.map(oneLine).join(", ") || "(なし)"}`,
    ctx.kind ? `kind: ${ctx.kind}` : "",
    ctx.workspaceKind ? `workspace: ${ctx.workspaceKind}` : "",
    "",
    "## 過去の判断と結末（新しい順）",
    rows.length ? "| 提案元 | 提案 | 実際 | 状態 | 結果 | USD | 所要 | title |" : "（まだ記録がありません）",
    rows.length ? "| --- | --- | --- | --- | --- | --- | --- | --- |" : "",
    ...rows,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The first JSON object in the answer. Runners wrap JSON in prose or fences however they like, so the text is
 * scanned rather than parsed whole; a runner outside the candidate list is refused (the composite then falls back
 * to the rule table) because suggesting something that is not installed is worse than no suggestion.
 */
export function parseSuggestion(text: string, candidates: RunnerId[]): { runner: RunnerId; reason: string } {
  const rejected: string[] = [];
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const obj = parsed as { runner?: unknown; reason?: unknown };
    if (typeof obj?.runner !== "string") continue;
    const runner = RunnerId.safeParse(obj.runner);
    // A runner nobody has is not the answer — but it is not the end of the search either: the prompt itself shows
    // the format with a placeholder `runner`, and a model that echoes the format line before answering would
    // otherwise be thrown away. Keep reading; report everything that was refused if nothing usable turns up.
    if (!runner.success || !candidates.includes(runner.data)) {
      rejected.push(obj.runner);
      continue;
    }
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    return { runner: runner.data, reason: reason || "（理由なし）" };
  }
  if (rejected.length) throw new Error(`suggested ${rejected.map((r) => JSON.stringify(r)).join(", ")}, none of which is one of ${candidates.join(", ")}`);
  throw new Error(`no JSON object in the answer: ${oneLine(text).slice(0, 200)}`);
}

/** How much of an answer is scanned for JSON, and how many `{` spans are tried. A runner that streams a novel is not answering. */
const MAX_SCAN_CHARS = 64_000;
const MAX_CANDIDATES = 200;

/**
 * Every balanced `{...}` span in the text, outer before inner: a fenced block, an object after prose, the whole
 * answer, or an object nested inside another (`{"thinking": …, "answer": {"runner": …}}`) — the scan does not skip
 * past a span it already yielded, because the answer is not always the outermost object.
 *
 * Bounded on purpose: this runs synchronously on the `POST /api/tasks` path, and an answer full of unmatched `{`
 * would otherwise be quadratic.
 */
export function* jsonCandidates(text: string): Generator<string> {
  const scan = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  let tried = 0;
  for (let i = 0; i < scan.length && tried < MAX_CANDIDATES; i++) {
    if (scan[i] !== "{") continue;
    tried++;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let k = i; k < scan.length; k++) {
      const ch = scan[k]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        yield scan.slice(i, k + 1);
        break;
      }
    }
  }
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
