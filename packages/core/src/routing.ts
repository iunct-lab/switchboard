import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { RunnerId, type LlmSuggestion, type RoutingSuggestion, type WorkspaceKind } from "@switchboard/protocol";
import { z } from "zod";

/**
 * Rule-table routing (proposal §3, issue #6). v1 is pure data: no LLM. The suggestion and the user's actual
 * choice are recorded per task so a later LLM router (Phase 3) has training data.
 */
// Strict: a typo'd key in a user file (`keyword:`) must be an error, not an always-matching empty condition.
export const RoutingRule = z
  .object({
    id: z.string().min(1),
    when: z
      .object({
        minRepos: z.number().int().positive().optional(),
        maxRepos: z.number().int().positive().optional(),
        keywords: z.array(z.string().min(1)).optional(),
        kinds: z.array(z.string().min(1)).optional(),
        workspaceKind: z.enum(["meta", "repo"]).optional(),
      })
      .strict()
      .default({}),
    runner: RunnerId,
    /** Model the rule proposes (a runner model id). Absent = no proposal; the runner's CLI default stays. */
    model: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();
export type RoutingRule = z.infer<typeof RoutingRule>;

export const RoutingTable = z
  .object({
    version: z.literal(1),
    rules: z.array(RoutingRule),
    fallback: z.object({ runner: RunnerId, reason: z.string().min(1) }).strict().default({ runner: "claude", reason: "既定" }),
  })
  .strict();
export type RoutingTable = z.infer<typeof RoutingTable>;

export interface RoutingContext {
  title: string;
  prompt: string;
  /** cwd + extra scope dirs (deduplicated). */
  scope: string[];
  kind?: string;
  workspaceKind?: WorkspaceKind;
  /** Runner last used for a task in the same workspace / cwd, if any. */
  previousRunner?: RunnerId;
  /** Runners the daemon detected. A suggestion for a missing runner is still returned, flagged unavailable. */
  available: ReadonlySet<RunnerId>;
}

/**
 * First readable, valid table wins. An invalid file is reported (`problems`) and skipped so a bad
 * ~/.switchboard/routing.yaml never keeps the daemon from booting; the shipped table is the safety net.
 */
export function loadRoutingTable(paths: string[], log: (msg: string) => void = (m) => console.warn(m)): { table: RoutingTable; source: string; problems: string[] } {
  const problems: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = RoutingTable.safeParse(parseYaml(readFileSync(p, "utf8")));
      if (parsed.success) return { table: parsed.data, source: p, problems };
      problems.push(`${p}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    } catch (e) {
      problems.push(`${p}: ${String((e as Error).message ?? e)}`);
    }
    log(`routing: ignoring invalid table ${problems.at(-1)}`);
  }
  return { table: { version: 1, rules: [], fallback: { runner: "claude", reason: "既定" } }, source: "builtin", problems };
}

/**
 * Does a rule match? Every specified condition must hold. An explicit task kind is authoritative: when the caller
 * passes `kind`, rules that declare `kinds` must list it (keywords cannot override the user's classification);
 * rules without `kinds` still match on keywords. Without a kind, keywords decide.
 */
export function ruleMatches(rule: RoutingRule, ctx: RoutingContext): boolean {
  const w = rule.when;
  const repos = new Set(ctx.scope.filter(Boolean).map(normalizeDir)).size;
  if (w.minRepos !== undefined && repos < w.minRepos) return false;
  if (w.maxRepos !== undefined && repos > w.maxRepos) return false;
  if (w.workspaceKind !== undefined && ctx.workspaceKind !== w.workspaceKind) return false;
  const hasKinds = !!w.kinds?.length;
  const hasKeywords = !!w.keywords?.length;
  if (!hasKinds && !hasKeywords) return true;
  if (ctx.kind && hasKinds) return w.kinds!.includes(ctx.kind);
  if (ctx.kind && !hasKinds && hasKeywords) return keywordHit(w.keywords!, ctx);
  if (hasKeywords && keywordHit(w.keywords!, ctx)) return true;
  return false;
}

function normalizeDir(d: string): string {
  return d.replace(/\/+$/, "") || "/";
}

/** ASCII keywords match on word boundaries (so `format` does not hit "information"); CJK keywords match as substrings. */
export function keywordHit(keywords: string[], ctx: Pick<RoutingContext, "title" | "prompt">): boolean {
  const text = `${ctx.title}\n${ctx.prompt}`.toLowerCase();
  return keywords.some((k) => {
    const kw = k.toLowerCase();
    if (/^[\x00-\x7f]+$/.test(kw)) return new RegExp(`(^|[^a-z0-9_])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`).test(text);
    return text.includes(kw);
  });
}

export function suggestRunner(table: RoutingTable, ctx: RoutingContext): RoutingSuggestion {
  const matched = table.rules.filter((r) => ruleMatches(r, ctx));
  const first = matched[0];
  const alternatives = matched.slice(1).map((r) => ({ runner: r.runner, reason: r.reason, ruleId: r.id }));
  if (first) {
    return { runner: first.runner, reason: first.reason, ruleId: first.id, model: first.model ?? null, available: ctx.available.has(first.runner), alternatives: dedupe(alternatives, first.runner), llm: null };
  }
  if (ctx.previousRunner) {
    return { runner: ctx.previousRunner, reason: "前回このリポジトリで使ったランナー", ruleId: "previous", model: null, available: ctx.available.has(ctx.previousRunner), alternatives: [], llm: null };
  }
  return { runner: table.fallback.runner, reason: table.fallback.reason, ruleId: "fallback", model: null, available: ctx.available.has(table.fallback.runner), alternatives: [], llm: null };
}

/** Longest reason a suggester may attach. It is shown in the Brief and stored in `routing_log`; a runaway answer is not advice. */
export const MAX_LLM_REASON = 300;

/**
 * What the primary returned, or a throw. A `Suggester` is an interface anyone can implement — including an LLM
 * that answered in free text — so nothing here may be trusted: a missing `reason` used to reach the NOT NULL
 * column in `routing_log` and turn the whole task creation into a 409 with no task at all.
 */
function checkedLlmSuggestion(answer: RoutingSuggestion): LlmSuggestion {
  const runner = RunnerId.safeParse(answer?.runner);
  if (!runner.success) return failSuggestion(`suggested runner ${JSON.stringify(answer?.runner)} is not a runner id`);
  const reason = typeof answer?.reason === "string" ? answer.reason.trim() : "";
  if (!reason) return failSuggestion("the suggestion came back without a reason");
  return { runner: runner.data, reason: reason.length > MAX_LLM_REASON ? `${reason.slice(0, MAX_LLM_REASON)}…` : reason };
}

function failSuggestion(why: string): never {
  throw new Error(why);
}

function dedupe(alts: RoutingSuggestion["alternatives"], chosen: RunnerId): RoutingSuggestion["alternatives"] {
  const seen = new Set<RunnerId>([chosen]);
  return alts.filter((a) => (seen.has(a.runner) ? false : (seen.add(a.runner), true)));
}

/* ---------- suggesters (#25): where a suggestion comes from ---------- */

/**
 * A source of routing suggestions. The rule table is one; an LLM asked through a runner adapter is another. Async
 * and abortable because the second kind spawns a process: the caller (a task creation) must be able to give up on it.
 * What a suggestion is recorded as (`routing_log.suggested_by`) follows from where it ended up on the task, not
 * from the object that produced it.
 */
export interface Suggester {
  suggest(ctx: RoutingContext, signal: AbortSignal): Promise<RoutingSuggestion>;
}

/** The rule table as a Suggester. The table is read per call so a reload is picked up without rebuilding anything. */
export class RuleSuggester implements Suggester {
  constructor(private table: () => RoutingTable) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async suggest(ctx: RoutingContext): Promise<RoutingSuggestion> {
    return suggestRunner(this.table(), ctx);
  }
}

/**
 * Rule table + an optional second opinion (#25). The fallback (the rule table) always decides what is suggested;
 * the primary's answer is attached as `llm` and shown next to it — an LLM proposes, it never routes. A primary that
 * throws, returns something unusable, or takes longer than `timeoutMs` is dropped with a log line and the task is
 * created with the rule table's suggestion alone: a creation must never fail or hang because a runner misbehaved.
 */
export class CompositeSuggester implements Suggester {
  constructor(
    private primary: Suggester,
    private fallback: Suggester,
    private timeoutMs = 5000,
    private log: (msg: string) => void = (m) => console.warn(m),
  ) {}

  async suggest(ctx: RoutingContext, signal: AbortSignal): Promise<RoutingSuggestion> {
    const base = await this.fallback.suggest(ctx, signal);
    if (signal.aborted) return base;
    const ac = new AbortController();
    const abort = (why: string) => ac.abort(new Error(why));
    const onOuterAbort = () => abort("the caller gave up");
    signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => abort(`no answer in ${this.timeoutMs}ms`), this.timeoutMs);
    // The deadline is enforced by the race, not by the signal alone: a primary that ignores its AbortSignal (or
    // cannot interrupt the process it started) must not hold the task creation open past `timeoutMs`.
    const giveUp = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason instanceof Error ? ac.signal.reason : new Error(String(ac.signal.reason))), { once: true });
    });
    // Nothing else ever handles `giveUp`: when the primary wins the race, the `abort("done")` below rejects it and
    // an unhandled rejection takes the process down (Bun's default). The same applies when `suggest()` throws
    // synchronously — then the race is never even constructed — which is why the call is wrapped in a promise.
    giveUp.catch(() => undefined);
    try {
      const answer = await Promise.race([Promise.resolve().then(() => this.primary.suggest(ctx, ac.signal)), giveUp]);
      return { ...base, llm: checkedLlmSuggestion(answer) };
    } catch (e) {
      this.log(`routing: the LLM suggestion was dropped (${String((e as Error).message ?? e)}); using the rule table`);
      return base;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
      // A primary that resolved in time still has to be told the race is over (a process it left running must end).
      abort("done");
    }
  }
}
