import type { EvalsListRow, EvalsSummary, RuleMetrics, RunnerInfo, TaskEvals } from "@switchboard/protocol";
import { effortLabel } from "./effortOptions.ts";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

/** The default rubric's criteria as the screen names them (#1219); an id the screen does not know is shown as is. */
const CRITERION_TITLES: Record<string, string> = { goal: t(m.critGoal), instructions: t(m.critInstructions), efficiency: t(m.critEfficiency), communication: t(m.critCommunication), safety: t(m.critSafety) };

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
  const x = r.metrics;
  const reasons = Object.entries(x.stopReasons).map(([k, n]) => `${k} ${n}`).join(", ");
  return [
    { label: t(m.toolCalls), value: String(x.toolCalls) },
    { label: t(m.failures), value: String(x.toolFailures), warn: x.toolFailures > 0 },
    { label: t(m.errors), value: String(x.errors), warn: x.errors > 0 },
    { label: t(m.userInstructions), value: String(x.userInstructions) },
    { label: t(m.asksDenials), value: `${x.asks} / ${x.denials}`, warn: x.denials > 0 },
    { label: t(m.classifier), value: classifierValue(x.classifier) },
    { label: t(m.stops), value: reasons ? `${x.stops}${t(m.paren, { text: reasons })}` : String(x.stops), warn: x.stops > 0 },
    { label: t(m.daemonStopsShort), value: String(x.daemonStops), warn: x.daemonStops > 0 },
    { label: t(m.turns), value: String(x.turns) },
    { label: t(m.duration), value: fmtDuration(x.durationMs) },
    // a last turn the daemon's stop cut ended that way by the stop, not by the task (#2089): デーモン停止 carries the mark
    { label: t(m.ending), value: endLabel(x.lastEnd), warn: (x.lastEnd === "error" || x.lastEnd === "aborted") && !x.lastCutByDaemon },
    // the model an 実装 Task handed each Task to (試験, #2769); no row without one
    ...(x.delegatedModel ? [{ label: t(m.delegatedModel), value: t(m.delegatedModelValue, { model: x.delegatedModel }) }] : []),
  ];
}

/** Claude Code's auto-mode classifier (#2236): what it let through and stopped, the stopped ones per kind; 不明 when nothing was recorded (Codex, not Auto). */
function classifierValue(c: RuleMetrics["classifier"]): string {
  if (!c) return t(m.unknown);
  const kinds = Object.entries(c.byCategory).map(([k, n]) => `${k === "asked" ? t(m.askedPerson) : k} ${n}`).join(", ");
  return `${t(m.classifierValue, { allowed: c.allowed, denied: c.denied })}${kinds ? t(m.paren, { text: kinds }) : ""}`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return t(m.seconds, { n: s });
  const min = Math.floor(s / 60);
  if (min < 60) return t(m.durMinSec, { m: min, s: s % 60 });
  return t(m.durHourMin, { h: Math.floor(min / 60), m: min % 60 });
}

export function endLabel(end: RuleMetrics["lastEnd"]): string {
  return end === "ok" ? t(m.endOk) : end === "error" ? t(m.endError) : end === "aborted" ? t(m.endAborted) : "-";
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

/** The human − judge gap as Insights shows it (#1877): the signed mean to one decimal and the count, or that none is rated yet. */
export function gapLabel(gap: EvalsSummary["gap"]): string {
  if (!gap.count || gap.mean === null) return t(m.noHumanRating);
  const sign = gap.mean > 0 ? "+" : gap.mean < 0 ? "−" : "";
  return t(m.gap, { gap: `${sign}${Math.abs(gap.mean).toFixed(1)}`, count: gap.count });
}

/** The models the task ran on as the Brief shows them (#1801): the one, or every one in the order used with （混在） after; null when not known. */
export function modelsLabel(e: Pick<TaskEvals, "models">): string | null {
  if (!e.models.length) return null;
  return e.models.length === 1 ? e.models[0]! : t(m.mixedModels, { models: e.models.join(" → ") });
}

/* ---------- the Evals list (#1221) ---------- */

export type EvalsSortKey = "updatedAt" | "judge" | "human" | "toolCalls" | "toolFailures" | "errors" | "userInstructions" | "stops" | "daemonStops" | "costUsd";

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

/** Whether a row points at trouble: a failure, an error or a stop, a low rubric average, or a low rating. A daemon stop is not the task's weakness and does not count (#2089). */
export function evalRowWarn(row: EvalsListRow): boolean {
  const r = row.rules;
  return !!((r && (r.toolFailures > 0 || r.errors > 0 || r.stops > 0)) || (row.judge && row.judge.average <= 2.5) || (row.human && row.human.rating <= 2));
}
