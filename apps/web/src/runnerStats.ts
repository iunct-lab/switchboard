import type { RoutingStats, RunnerId, RunnerStats } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

/** Fewer tasks than this in the window and a runner's record is too thin to compare with the others (#612). The default of `quotaAndResume.thinSample` (#835). */
export const THIN_SAMPLE = 5;

export type RunnerRow = RunnerStats & { thin: boolean };

/**
 * One row per runner for the Ledger's per-runner card (#612): `runners` in their order, a runner with no record in the
 * window as a zero row (the API only lists runners that have records), then any runner only the daemon knows. `thin`:
 * the setting's count (#835).
 */
export function runnerRows(stats: RoutingStats, runners: RunnerId[], thin = THIN_SAMPLE): RunnerRow[] {
  const empty = (runner: RunnerId): RunnerStats => ({ runner, total: 0, outcomes: { done: 0, needs_action: 0, failed: 0, unknown: 0 }, medianCostUsd: null, medianDurationMs: null });
  const known = runners.map((r) => stats.byRunner.find((s) => s.runner === r) ?? empty(r));
  const extra = stats.byRunner.filter((s) => !runners.includes(s.runner));
  return [...known, ...extra].map((s) => ({ ...s, thin: s.total < thin }));
}

/** The count cell: the number, or why the row is not worth comparing. */
export function countLabel(row: RunnerRow): string {
  return row.thin ? t(m.tooThin, { n: row.total }) : String(row.total);
}

/** A median duration: minutes, or seconds under a minute (so a short task does not read as "0 分"); — for none. */
export function fmtMedianDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000 ? t(m.seconds, { n: Math.round(ms / 1000) }) : t(m.minutes, { n: Math.round(ms / 60_000) });
}
