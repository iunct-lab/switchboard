import type { AgentEvent, JudgeEval, JudgeSettings, Rubric, RubricScore, RuleMetrics, RunnerAdapter, RunnerId } from "@switchboard/protocol";
import { JUDGE_FALLBACK } from "./judge.ts";
import { transcriptLines } from "./recap.ts";
import { rubricKey } from "./rubric.ts";
import { jsonCandidates, oneLine, readOnlyMode, runSuggestionTurn } from "./suggest-llm.ts";

/** One rubric judgement reads the transcript, so it gets more time than the two-way judge (#493, 60 s). */
export const RUBRIC_JUDGE_TIMEOUT_MS = 90_000;
/** How much of the transcript the judge sees (the newest part). Enough for a day's task; small enough for a lightweight model. */
export const RECAP_CHARS = 12_000;
const REASON_CHARS = 200;

export interface RubricJudgeInput {
  title: string;
  /** The request that started the task. */
  prompt: string;
  events: AgentEvent[];
  metrics: RuleMetrics;
  rubric: Rubric;
}

export interface RubricJudgeOptions {
  adapters: Map<RunnerId, RunnerAdapter>;
  /** The same runner / model as the two-way judge (#493): one setting, one subscription. */
  settings: JudgeSettings;
  /** Directory the turn runs in — the daemon's data dir, never a repository the agent could edit. */
  cwd: string;
  onUsage?: (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => void;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** The two-way judge's fallback (#835), so one setting moves both. Absent = `JUDGE_FALLBACK`. */
  fallback?: { runner: RunnerId; model: string };
}

/**
 * Scores a task against the rubric (#1219): one read-only turn of the configured judge runner, then one of
 * the fallback (`JUDGE_FALLBACK` unless set) when that fails for any reason — the same order as `judgeTurn`. Throws the last error when neither
 * answers; the caller leaves the task unscored.
 */
export async function judgeRubric(input: RubricJudgeInput, opts: RubricJudgeOptions): Promise<JudgeEval> {
  const prompt = buildRubricPrompt(input);
  const tries: Array<{ runner: RunnerId; model: string }> = [{ runner: opts.settings.runner, model: opts.settings.model }];
  const fallback = opts.fallback ?? JUDGE_FALLBACK;
  if (opts.settings.runner !== fallback.runner || opts.settings.model !== fallback.model) tries.push(fallback);
  let last: unknown;
  for (const t of tries) {
    if (opts.signal?.aborted) break;
    try {
      const adapter = opts.adapters.get(t.runner);
      if (!adapter) throw new Error(`${t.runner} is not installed`);
      const ro = readOnlyMode(adapter);
      if (ro.unconstrained && adapter.permissionModes?.length) throw new Error(`${t.runner} has no read-only permission mode`);
      const timeout = AbortSignal.timeout(RUBRIC_JUDGE_TIMEOUT_MS);
      const text = await runSuggestionTurn({ adapter, cwd: opts.cwd, model: t.model, permissionMode: ro.mode, onUsage: (ev) => opts.onUsage?.(t.runner, ev), log: opts.log }, prompt, opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout);
      return { ...parseRubricJudgement(text, input.rubric), rubric: rubricKey(input.rubric), by: `${t.runner}:${t.model}`, ts: Date.now() };
    } catch (e) {
      last = e;
      opts.log?.(`rubric judge: ${t.runner}:${t.model} could not score (${String((e as Error).message ?? e)})`);
    }
  }
  throw last ?? new Error("the daemon is stopping");
}

/** The prompt: the format, the rubric, then the request, the counts and the transcript. All task text is capped and untrusted. */
export function buildRubricPrompt(input: RubricJudgeInput): string {
  const m = input.metrics;
  return [
    "あなたはエージェントが終えたタスクを、下のルーブリックに沿って観点ごとに 1〜5 点で採点します。JSON だけを返してください。",
    'ほかの文章・コードブロック・前置きは書かないこと。形式: {"scores": {"<観点id>": {"score": 1-5, "reason": "<日本語で 40 字以内>"}}, "summary": "<日本語で 80 字以内の総評>"}',
    "点は目安の文に最も近いものを選ぶ（2 と 4 はその間）。判断できない観点は省いてよい。",
    "",
    "## ルーブリック",
    ...input.rubric.criteria.flatMap((c) => [`- ${c.id}（${c.title}）: 5 = ${oneLine(c.anchors["5"])} / 3 = ${oneLine(c.anchors["3"])} / 1 = ${oneLine(c.anchors["1"])}`]),
    "",
    "## 依頼",
    `title: ${oneLine(input.title).slice(0, 200)}`,
    `prompt: ${oneLine(input.prompt).slice(0, 1200)}`,
    "",
    "## 指標（記録から数えたもの）",
    `ツール呼び出し ${m.toolCalls} / 失敗 ${m.toolFailures} / エラー ${m.errors} / 利用者の追加指示 ${m.userInstructions} / 停止 ${m.stops} / 最後のターンの終わり方 ${m.lastEnd ?? "-"}`,
    "",
    "## 会話（新しい部分を優先）",
    transcriptLines(input.events, RECAP_CHARS),
  ].join("\n");
}

/**
 * The first JSON object with `scores`. A criterion not in the rubric, or with a score that is not an integer 1–5, is
 * dropped; reasons and the summary are one line, capped. Throws when no criterion survives.
 */
export function parseRubricJudgement(text: string, rubric: Rubric): Pick<JudgeEval, "scores" | "summary"> {
  const known = new Set(rubric.criteria.map((c) => c.id));
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const obj = parsed as { scores?: unknown; summary?: unknown };
    if (!obj || typeof obj.scores !== "object" || obj.scores === null) continue;
    const scores: Record<string, RubricScore> = {};
    for (const [id, v] of Object.entries(obj.scores as Record<string, unknown>)) {
      if (!known.has(id) || !v || typeof v !== "object") continue;
      const { score, reason } = v as { score?: unknown; reason?: unknown };
      if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) continue;
      scores[id] = { score, reason: (typeof reason === "string" && oneLine(reason).slice(0, REASON_CHARS)) || "（理由なし）" };
    }
    if (!Object.keys(scores).length) continue;
    return { scores, summary: typeof obj.summary === "string" ? oneLine(obj.summary).slice(0, REASON_CHARS) : "" };
  }
  throw new Error(`no scores in the answer: ${oneLine(text).slice(0, 200)}`);
}
