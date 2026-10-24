import { jstClock, jstStamp } from "./time.ts";

/** The runners' usage windows (`quota` events) in words (#1836). An unknown window keeps its name, `_` as spaces. */
const WINDOW_LABELS: Record<string, string> = { five_hour: "5 時間", seven_day: "7 日", seven_day_overage_included: "7 日・超過込み", seven_day_opus: "7 日・Opus", seven_day_sonnet: "7 日・Sonnet" };
export const windowLabel = (window: string): string => (Object.hasOwn(WINDOW_LABELS, window) ? WINDOW_LABELS[window]! : window.replace(/_/g, " "));

/** A window the runner has not reported for this long is shown faded with its time: it may be far from the truth. */
export const QUOTA_STALE_MS = 24 * 3600 * 1000;
export const quotaStale = (ts: number, now = Date.now()): boolean => now - ts > QUOTA_STALE_MS;

/** When the runner last reported the window (`ts` in ms): `M/D HH:MM 時点` (JST). */
export const quotaAsOf = (ts: number): string => `${jstStamp(ts)} 時点`;
/** When the window resets (`resetsAt` in epoch seconds): the clock when today, the date too on another day, `—` when unknown. */
export function resetLabel(resetsAt: number, now = Date.now()): string {
  if (!resetsAt) return "—";
  return `${jstClock(resetsAt * 1000, now)} に戻る`;
}

/** The quota rows grouped per runner: claude, codex, dak in that order (the Ledger's), then any other, each runner's rows as given. */
export function quotaByRunner<T extends { runner: string }>(rows: T[]): Array<{ runner: string; rows: T[] }> {
  const order = ["claude", "codex", "dak"];
  const runners = [...order.filter((r) => rows.some((q) => q.runner === r)), ...rows.map((q) => q.runner).filter((r, i, all) => !order.includes(r) && all.indexOf(r) === i)];
  return runners.map((runner) => ({ runner, rows: rows.filter((q) => q.runner === runner) }));
}
