import type { AgentEvent, RunnerAdapter, RunnerId } from "@switchboard/protocol";
import type { GhRunner } from "./backlog.ts";
import { oneLine, readOnlyMode, runSuggestionTurn } from "./suggest-llm.ts";

/**
 * Who names a task after its first turn (#491), in this order: the person chose codex `gpt-6-luna`, and Haiku when it
 * cannot answer (2026-09-28, the same answer as the judge's, #493). Not a setting: only `Settings.titles.auto` is.
 */
export const TITLE_RUNNERS: Array<{ runner: RunnerId; model: string }> = [
  { runner: "codex", model: "gpt-6-luna" },
  { runner: "claude", model: "claude-haiku-4-5" },
];

/** How long one turn may take: a real Haiku turn measured 6.6 s (#141), and nothing waits on it. */
export const TITLE_TIMEOUT_MS = 60_000;

const TITLE_CHARS = 60;

export interface TitleInput {
  /** The request that started the task. */
  prompt: string;
  /** The last reply of the first turn (`turn.end.summary`); empty when there was none. */
  reply: string;
}

export interface TitleOptions {
  adapters: Map<RunnerId, RunnerAdapter>;
  /** Directory the turn runs in — the daemon's data dir, never a repository the agent could edit. */
  cwd: string;
  /** Each turn's reported usage, with the runner that spent it, so the caller can put it in the ledger. */
  onUsage?: (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => void;
  log?: (msg: string) => void;
  /** Gives up at once (the daemon is stopping). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The prompt: the request and the last reply, both capped and not trusted. */
export function buildTitlePrompt(input: TitleInput): string {
  return [
    "あなたはエージェントのタスクに短いタイトルを付けます。タイトルだけを 1 行で返してください。",
    "依頼と同じ言語で、何をした（している）タスクか分かる 40 字以内にすること。引用符・「タイトル:」などの前置き・説明は書かない。",
    "",
    "## 依頼",
    oneLine(input.prompt).slice(0, 1200),
    "",
    "## 最後の返答",
    oneLine(input.reply).slice(0, 1200) || "(なし)",
  ].join("\n");
}

/** The first non-empty line, without quotes, a leading `#` or `タイトル:`, cut to 60 characters. Throws when nothing is left. */
export function parseTitle(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const title = line
    .replace(/^#+\s*/, "")
    .replace(/^(タイトル|title)\s*[:：]\s*/i, "")
    .replace(/^["'「『“”‘’`]+|["'」』“”‘’`]+$/g, "")
    .trim()
    .slice(0, TITLE_CHARS);
  if (!title) throw new Error("the answer has no title");
  return title;
}

/** One title: each of `TITLE_RUNNERS` is asked in turn, and a runner that cannot answer (any reason) hands over to the next. Throws the last error when none does. */
export async function suggestTitle(input: TitleInput, opts: TitleOptions): Promise<{ title: string; runner: RunnerId; model: string }> {
  const prompt = buildTitlePrompt(input);
  const timeoutMs = opts.timeoutMs ?? TITLE_TIMEOUT_MS;
  let last: unknown;
  for (const t of TITLE_RUNNERS) {
    if (opts.signal?.aborted) break;
    try {
      const adapter = opts.adapters.get(t.runner);
      if (!adapter) throw new Error(`${t.runner} is not installed`);
      // A runner with modes but none known to be read-only would run in its default (writing) mode; a title is not worth that.
      const ro = readOnlyMode(adapter);
      if (ro.unconstrained && adapter.permissionModes?.length) throw new Error(`${t.runner} has no read-only permission mode`);
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const text = await runSuggestionTurn({ adapter, cwd: opts.cwd, model: t.model, permissionMode: ro.mode, onUsage: (ev) => opts.onUsage?.(t.runner, ev), log: opts.log }, prompt, signal);
      return { title: parseTitle(text), ...t };
    } catch (e) {
      last = e;
      opts.log?.(`title: ${t.runner}:${t.model} could not name the task (${String((e as Error).message ?? e)})`);
    }
  }
  throw last ?? new Error("the daemon is stopping");
}

/** `/pbi-complete 123`: a skill command on the first line, with the Issue it works on. */
export function parseSkillCommand(prompt: string): { command: string; issue: number } | null {
  const m = /^\/([\w:-]+)\s+#?(\d+)\b/.exec(prompt.split("\n")[0] ?? "");
  return m ? { command: m[1]!, issue: Number(m[2]) } : null;
}

const SKILL_TITLE_CHARS = 120;
const GH_TIMEOUT_MS = 5000;

/**
 * The title of a task started with a skill command (#491): `/<command> #<n> <the Issue's title>`, so nothing waits on a
 * model. null when the prompt is no such command or `gh` cannot say (no answer in 5 s, a failure, an empty title).
 */
export async function skillCommandTitle(prompt: string, cwd: string, gh: GhRunner): Promise<string | null> {
  const cmd = parseSkillCommand(prompt);
  if (!cmd) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([gh(["issue", "view", String(cmd.issue), "--json", "title", "--jq", ".title"], cwd), new Promise<null>((res) => (timer = setTimeout(() => res(null), GH_TIMEOUT_MS)))]);
    const title = r && r.code === 0 ? oneLine(r.stdout) : "";
    return title ? `/${cmd.command} #${cmd.issue} ${title}`.slice(0, SKILL_TITLE_CHARS) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
