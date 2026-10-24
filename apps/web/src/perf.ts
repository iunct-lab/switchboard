import type { Journey, PerfSample, PerfSummaryRow, SizeClass } from "@switchboard/protocol";
import { api } from "./api.ts";

// Journey timing (#637): the start is a mark at the person's action, the end a measure `sb:<journey>` left after the
// result is painted; perf-bench reads the measures from the page. Each measure is also sent to this daemon (#639),
// which keeps it 30 days for the ledger's 速さ table — and nowhere else.

/** Started journeys and their start time. `launch` starts with the navigation itself (performance.timeOrigin = 0). */
const started = new Map<Journey, number>([["launch", 0]]);

export function journeyStart(name: Journey): void {
  started.set(name, performance.mark(`sb:${name}:start`).startTime);
}

/** Drops a started journey whose action failed, so a later unrelated end does not close it. */
export function journeyCancel(name: Journey): void {
  started.delete(name);
}

/**
 * Ends a started journey after the next paint. An end without a start, and a second end, do nothing. `size` = the Task
 * the journey drew (#2100; `open-task` / `send`), kept with the sample so a slow open can be told from a big Task.
 */
export function journeyEnd(name: Journey, size?: { taskId: string; events: number }): void {
  const start = started.get(name);
  if (start === undefined) return;
  started.delete(name);
  // the first frame runs before the paint of what was just committed, the second one after it. The start is taken
  // now: a new start of the same journey before the paint must not move this one's
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const m = performance.measure(`sb:${name}`, { start });
      queueSample({ journey: name, device: deviceKind(), build: buildId(), ms: m.duration, taskId: size?.taskId ?? null, bytes: size ? detailBytes(size.taskId) : null, events: size?.events ?? null });
    }),
  );
}

/**
 * The decoded size of the Task's last whole `GET /api/tasks/<id>` response (#2100), from Resource Timing. A read with
 * a query — the catch-up (`?after=`, #1137), the rest after a turn (`?limit=0`) or an older page (`?before=`, #1142) — is
 * a slice, not the Task's size, so it is skipped. Null when there is none or it reads 0 (a
 * cross-origin response without Timing-Allow-Origin).
 */
// The browser keeps 250 resource entries and then records no more: a tab left open (polling, catch-up reads) would stop
// seeing new detail responses. Emptying the buffer when it fills lets the next ones in; an entry dropped then reads null.
performance.addEventListener("resourcetimingbufferfull", () => performance.clearResourceTimings());

export function detailBytes(taskId: string, entries: PerformanceEntryList = performance.getEntriesByType("resource")): number | null {
  const path = `/api/tasks/${taskId}`;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as PerformanceResourceTiming;
    const url = new URL(e.name, location.href);
    if (url.pathname === path && url.search === "") return e.decodedBodySize || null;
  }
  return null;
}

/** The running build (#639): the hash in the loaded module script's name (`/assets/index-<hash>.js`); `dev` under the dev server. */
export function buildId(): string {
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");
  const file = src?.split("/").pop()?.replace(/\.js$/, "");
  return file ? (file.split(/-(.*)/)[1] || file).slice(0, 64) : "dev";
}

/** `mobile` below 700 px wide (PBI #639; a phone-sized window — the layout itself switches at 767 px, styles.css). */
export function deviceKind(): PerfSample["device"] {
  return innerWidth < 700 ? "mobile" : "desktop";
}

const FLUSH_MS = 5000;
const MAX_SEND = 50; // what POST /api/perf takes at once
// PerfSample's ms ceiling: one longer sample (a turn over 10 minutes, a tab in the background until it ends) would get the whole batch refused
const MAX_MS = 600_000;
const pending: PerfSample[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function queueSample(s: PerfSample) {
  if (s.ms > MAX_MS) return;
  pending.push(s);
  flushTimer ??= setTimeout(() => void flushSamples(api.perf), FLUSH_MS);
}

/** Sends what is waiting (at most 50; the rest is dropped). A failure is dropped silently: timing never gets in the way. */
export async function flushSamples(send: (rows: PerfSample[]) => Promise<unknown>): Promise<void> {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  const rows = pending.splice(0).slice(0, MAX_SEND);
  if (rows.length === 0) return;
  try {
    await send(rows);
  } catch {
    // the daemon is away or refused: the samples are not worth retrying
  }
}

/**
 * One row of the 速さ table (#2103): journey × device × size, the last 7 days against the 7 before them. `slower` = the
 * last 7 days' median is 20% or more above the 7 days before.
 */
export interface PerfRow {
  journey: Journey;
  device: PerfSample["device"];
  size: string;
  now: string;
  before: string;
  change: string;
  slower: boolean;
}

/** `240 ms` under a second, `1.5 s` from a second up. */
export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const SIZE_LABEL: Record<SizeClass, string> = { small: "〜1,000 件", medium: "〜5,000 件", large: "5,000 件超" };
const period = (p: PerfSummaryRow["current"]) => (p ? `${fmtMs(p.p50)} / ${fmtMs(p.p90)}（${p.count} 件）` : "—");

export function perfRows(summary: PerfSummaryRow[]): PerfRow[] {
  return summary.map(({ journey, device, size, current, previous }) => {
    // the change to 0.1%, and red is decided on that same number: what reads +20% is red, +19.9% is not
    const change = current && previous && previous.p50 > 0 ? Math.round(((current.p50 - previous.p50) / previous.p50) * 1000) / 10 : null;
    return {
      journey,
      device,
      size: size ? SIZE_LABEL[size] : "—",
      now: period(current),
      before: period(previous),
      change: change === null ? "—" : `${change > 0 ? "+" : ""}${change}%`,
      slower: change !== null && change >= 20,
    };
  });
}
