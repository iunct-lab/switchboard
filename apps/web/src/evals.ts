import type { EvalsListRow, RuleMetrics, RunnerInfo, TaskEvals } from "@switchboard/protocol";
import { effortLabel } from "./effortOptions.ts";

/** The default rubric's criteria as the screen names them (#1219); an id the screen does not know is shown as is. */
const CRITERION_TITLES: Record<string, string> = { goal: "依頼の達成", instructions: "指示の遵守", efficiency: "効率", communication: "報告", safety: "安全" };

/** One line of the 評価 section of the Brief (#1218). `warn` = a count that points at trouble (a failure, an error, a denial, a stop, a bad end). */
export interface MetricRow {
  label: string;
  value: string;
  warn?: boolean;
}

/** The rule metrics as the Brief lists them, in a fixed order; nothing when the task has no rules row yet (a Cloud task never has one). The cost is not among them: the コスト block below shows it live. */
export function metricRows(e: TaskEvals): MetricRow[] {
  const r = e.rules;
  if (!r) return [];
  const m = r.metrics;
  const reasons = Object.entries(m.stopReasons).map(([k, n]) => `${k} ${n}`).join(", ");
  return [
    { label: "ツール呼び出し", value: String(m.toolCalls) },
    { label: "失敗", value: String(m.toolFailures), warn: m.toolFailures > 0 },
    { label: "エラー", value: String(m.errors), warn: m.errors > 0 },
    { label: "追加指示", value: String(m.userInstructions) },
    { label: "承認 / 拒否", value: `${m.asks} / ${m.denials}`, warn: m.denials > 0 },
    { label: "停止", value: reasons ? `${m.stops}（${reasons}）` : String(m.stops), warn: m.stops > 0 },
    { label: "ターン", value: String(m.turns) },
    { label: "所要時間", value: fmtDuration(m.durationMs) },
    { label: "終わり方", value: endLabel(m.lastEnd), warn: m.lastEnd === "error" || m.lastEnd === "aborted" },
  ];
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} 分 ${s % 60} 秒`;
  return `${Math.floor(min / 60)} 時間 ${min % 60} 分`;
}

export function endLabel(end: RuleMetrics["lastEnd"]): string {
  return end === "ok" ? "正常" : end === "error" ? "エラー" : end === "aborted" ? "中断" : "-";
}

/** One criterion's line of the rubric judge's row (#1219). `warn` = 2 or below. */
export interface JudgeRow {
  id: string;
  title: string;
  score: number;
  reason: string;
  warn: boolean;
}

/** The judge's scores in the rubric's order for the ids it knows, then the rest; nothing without a judge row. */
export function judgeRows(e: TaskEvals): JudgeRow[] {
  const j = e.judge;
  if (!j) return [];
  const known = Object.keys(CRITERION_TITLES).filter((id) => id in j.scores);
  const rest = Object.keys(j.scores).filter((id) => !(id in CRITERION_TITLES));
  return [...known, ...rest].map((id) => ({ id, title: CRITERION_TITLES[id] ?? id, score: j.scores[id]!.score, reason: j.scores[id]!.reason, warn: j.scores[id]!.score <= 2 }));
}

/** The mean of the scores, one decimal; null without a judge row or without scores. */
export function judgeAverage(e: TaskEvals): number | null {
  const scores = e.judge ? Object.values(e.judge.scores).map((s) => s.score) : [];
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
}

/** The person's own rating as the Brief shows it (#1220): `4 / 5`, with the note after a dot; null without one. */
export function humanLabel(e: TaskEvals): string | null {
  if (!e.human) return null;
  return e.human.comment ? `${e.human.rating} / 5 · ${e.human.comment}` : `${e.human.rating} / 5`;
}

/** The models the task ran on as the Brief shows them (#1801): the one, or every one in the order used with （混在） after; null when not known. */
export function modelsLabel(e: Pick<TaskEvals, "models">): string | null {
  if (!e.models.length) return null;
  return e.models.length === 1 ? e.models[0]! : `${e.models.join(" → ")}（混在）`;
}

/* ---------- the Evals list (#1221) ---------- */

export type EvalsSortKey = "updatedAt" | "judge" | "human" | "toolCalls" | "toolFailures" | "errors" | "userInstructions" | "stops" | "costUsd";

/** The number a row sorts by for a key; null = the row has no such value and goes last whichever way the sort runs. */
export function evalSortValue(row: EvalsListRow, key: EvalsSortKey): number | null {
  switch (key) {
    case "updatedAt":
      return row.updatedAt;
    case "costUsd":
      return row.costUsd;
    case "judge":
      return row.judge?.average ?? null;
    case "human":
      return row.human?.rating ?? null;
    default:
      return row.rules?.[key] ?? null;
  }
}

/** Rows sorted by `key`; a row without the value stays at the end in both directions. Stable for equal values. */
export function sortEvalRows(rows: EvalsListRow[], key: EvalsSortKey, dir: "asc" | "desc"): EvalsListRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: evalSortValue(row, key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return a.v === b.v ? a.i - b.i : (a.v - b.v) * sign;
    })
    .map((x) => x.row);
}

/** The direction a column sorts in on its first click: a score shows the weak tasks first, a count the heavy ones, the date the newest. */
export function firstSortDir(key: EvalsSortKey): "asc" | "desc" {
  return key === "judge" || key === "human" ? "asc" : "desc";
}

/**
 * The text of a row's cells that are not plain numbers; "-" where the task has no such eval. `model` is every model the
 * task ran on in the order first used (#1801: the list is distinct, so its last entry is not always the one running at
 * the end); `mixed` = two or more.
 */
export function evalCells(row: EvalsListRow, runner?: Pick<RunnerInfo, "efforts">): { judge: string; human: string; end: string; model: string; mixed: boolean; effort: string } {
  return {
    judge: row.judge ? row.judge.average.toFixed(1) : "-",
    human: row.human ? `${row.human.rating} / 5` : "-",
    end: endLabel(row.rules?.lastEnd ?? null),
    model: row.models.length ? row.models.join(" → ") : "-",
    mixed: row.models.length >= 2,
    effort: effortLabel(row.effort, runner),
  };
}

/**
 * The rows that used `model` and ran at `effort` (#1801); an empty value does not filter, "-" is the CLI default. Done on
 * the rows the screen read: the daemon has no index to filter its events by.
 */
export function filterEvalRows(rows: EvalsListRow[], f: { model: string; effort: string }): EvalsListRow[] {
  return rows.filter((r) => (!f.model || r.models.includes(f.model)) && (!f.effort || (r.effort ?? "-") === f.effort));
}

/** The choices of the model and effort selects (#1801): the values in the rows read, distinct and sorted; "-" when a task ran at the CLI default. */
export function evalFilterOptions(rows: EvalsListRow[]): { models: string[]; efforts: string[] } {
  return {
    models: [...new Set(rows.flatMap((r) => r.models))].sort(),
    efforts: [...new Set(rows.map((r) => r.effort ?? "-"))].sort(),
  };
}

/** Whether a row points at trouble: a failure, an error or a stop, a low rubric average, or a low rating. */
export function evalRowWarn(row: EvalsListRow): boolean {
  const r = row.rules;
  return !!((r && (r.toolFailures > 0 || r.errors > 0 || r.stops > 0)) || (row.judge && row.judge.average <= 2.5) || (row.human && row.human.rating <= 2));
}
