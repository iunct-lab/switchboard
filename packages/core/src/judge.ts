import type { AgentEvent, JudgeSettings, RunnerAdapter, RunnerId, TaskJudgement } from "@switchboard/protocol";
import { jsonCandidates, oneLine, readOnlyMode, runSuggestionTurn } from "./suggest-llm.ts";

/**
 * Who judges when the configured runner cannot (#493): not installed, no read-only mode, its limit, an error, no
 * answer in time, or an answer that does not read. The person chose Haiku as the stand-in (2026-09-28); it is the
 * default of the setting `judgeAndChoice` (#835), which the daemon passes as `JudgeOptions.fallback`.
 */
export const JUDGE_FALLBACK = { runner: "claude", model: "claude-haiku-4-5" } as const satisfies { runner: RunnerId; model: string };

/** How long one judging turn may take: a real Haiku turn measured 6.6 s (#141), and nothing waits on it. The default of `judgeAndChoice.judgeTimeoutMs` (#835). */
export const JUDGE_TIMEOUT_MS = 60_000;

/** The prompt asks for 60 characters; a model that ignores it still gets one line of this length on the task screen. */
const REASON_CHARS = 200;

export interface JudgeInput {
  title: string;
  /** The request that started the task. */
  prompt: string;
  /** The last reply of the turn (`turn.end.summary`). */
  lastReply: string;
}

export interface JudgeOptions {
  adapters: Map<RunnerId, RunnerAdapter>;
  settings: JudgeSettings;
  /** Directory the turn runs in — the daemon's data dir, never a repository the agent could edit. */
  cwd: string;
  /** Each turn's reported usage, with the runner that spent it, so the caller can put it in the ledger. */
  onUsage?: (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => void;
  log?: (msg: string) => void;
  /** Gives up at once (the daemon is stopping): the turn's session is closed and nothing more is tried. */
  signal?: AbortSignal;
  /** Asked once when the configured runner fails (#835). Absent = `JUDGE_FALLBACK`. */
  fallback?: { runner: RunnerId; model: string };
  /** How long one turn may take (#835). Absent = `JUDGE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Judges a finished turn as done / needs action (#493): one read-only turn of the configured runner, and when that
 * fails for any reason, one turn of the fallback (`JUDGE_FALLBACK` unless set). Throws the last error when neither answers; the caller then
 * leaves the task unjudged.
 */
export async function judgeTurn(input: JudgeInput, opts: JudgeOptions): Promise<TaskJudgement & { runner: RunnerId; model: string }> {
  const prompt = buildJudgePrompt(input);
  const tries: Array<{ runner: RunnerId; model: string }> = [{ runner: opts.settings.runner, model: opts.settings.model }];
  const fallback = opts.fallback ?? JUDGE_FALLBACK;
  if (opts.settings.runner !== fallback.runner || opts.settings.model !== fallback.model) tries.push(fallback);
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  let last: unknown;
  for (const t of tries) {
    if (opts.signal?.aborted) break;
    try {
      const adapter = opts.adapters.get(t.runner);
      if (!adapter) throw new Error(`${t.runner} is not installed`);
      // A runner with modes but none known to be read-only would run in its default (writing) mode; a judgement is not worth that.
      const ro = readOnlyMode(adapter);
      if (ro.unconstrained && adapter.permissionModes?.length) throw new Error(`${t.runner} has no read-only permission mode`);
      const text = await runSuggestionTurn({ adapter, cwd: opts.cwd, model: t.model, permissionMode: ro.mode, onUsage: (ev) => opts.onUsage?.(t.runner, ev), log: opts.log }, prompt, opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
      return { ...parseJudgement(text), ...t };
    } catch (e) {
      last = e;
      opts.log?.(`judge: ${t.runner}:${t.model} could not judge (${String((e as Error).message ?? e)})`);
    }
  }
  throw last ?? new Error("the daemon is stopping");
}

/** The prompt: instructions, then the task and its last reply. Both come from the runner / the person and are capped, not trusted. */
export function buildJudgePrompt(input: JudgeInput): string {
  return [
    "あなたはエージェントのタスクが「完了」か「要対応」かを、最後の返答から判定します。JSON だけを返してください。",
    'ほかの文章・コードブロック・前置きは書かないこと。形式: {"result": "done|needs_action", "reason": "<日本語で 60 字以内の理由>"}',
    "- done（完了）: 依頼された作業を終えて、その結果を報告している",
    "- needs_action（要対応）: 利用者に質問・選択・確認・作業を求めて止まっている",
    "",
    "## 依頼",
    `title: ${oneLine(input.title)}`,
    `prompt: ${oneLine(input.prompt).slice(0, 1200)}`,
    "",
    "## 最後の返答",
    input.lastReply.trim().slice(0, 2000),
  ].join("\n");
}

/** The first JSON object whose `result` is done / needs_action (same scan as `parseSuggestion`, which also skips the echoed format line). */
export function parseJudgement(text: string): TaskJudgement {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const obj = parsed as { result?: unknown; reason?: unknown };
    if (obj?.result !== "done" && obj?.result !== "needs_action") continue;
    const reason = typeof obj.reason === "string" ? oneLine(obj.reason).slice(0, REASON_CHARS) : "";
    return { result: obj.result, reason: reason || "（理由なし）" };
  }
  throw new Error(`no judgement in the answer: ${oneLine(text).slice(0, 200)}`);
}
