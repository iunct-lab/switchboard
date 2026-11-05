import { jstClock, jstStamp } from "./time.ts";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

/** The runners' usage windows (`quota` events) in words (#1836). An unknown window keeps its name, `_` as spaces. */
const WINDOW_LABELS: Record<string, string> = { five_hour: t(m.window5h), seven_day: t(m.window7d), seven_day_overage_included: t(m.window7dOverage), seven_day_opus: t(m.window7dOpus), seven_day_sonnet: t(m.window7dSonnet) };
export const windowLabel = (window: string): string => (Object.hasOwn(WINDOW_LABELS, window) ? WINDOW_LABELS[window]! : window.replace(/_/g, " "));

/** A window the runner has not reported for this long is shown faded with its time: it may be far from the truth. */
export const QUOTA_STALE_MS = 24 * 3600 * 1000;
export const quotaStale = (ts: number, now = Date.now()): boolean => now - ts > QUOTA_STALE_MS;

/** When the runner last reported the window (`ts` in ms): `M/D HH:MM 時点` (JST). */
export const quotaAsOf = (ts: number): string => t(m.asOf, { time: jstStamp(ts) });
/** When the window resets (`resetsAt` in epoch seconds): the clock when today, the date too on another day, `—` when unknown. */
export function resetLabel(resetsAt: number, now = Date.now()): string {
  if (!resetsAt) return "—";
  return t(m.resetsAt, { time: jstClock(resetsAt * 1000, now) });
}

/** The quota rows grouped per runner: claude, codex, dak in that order (the Ledger's), then any other, each runner's rows as given. */
export function quotaByRunner<T extends { runner: string }>(rows: T[]): Array<{ runner: string; rows: T[] }> {
  const order = ["claude", "codex", "dak"];
  const runners = [...order.filter((r) => rows.some((q) => q.runner === r)), ...rows.map((q) => q.runner).filter((r, i, all) => !order.includes(r) && all.indexOf(r) === i)];
  return runners.map((runner) => ({ runner, rows: rows.filter((q) => q.runner === runner) }));
}
