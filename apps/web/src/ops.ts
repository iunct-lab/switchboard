import type { LoadKind, OpsLatency, OpsLoadGroup, OpsLoadHour, OpsStopsRow, StopReason } from "@switchboard/protocol";
import { fmtMs } from "./perf.ts";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

/** What a daemon stop's cause is called on screen (#2093). */
export const reasonLabel: Record<StopReason, string> = {
  oomd: t(m.reasonOomd),
  restart: t(m.reasonRestart),
  "host-stop": t(m.reasonHostStop),
  promote: t(m.reasonPromote),
  crash: t(m.reasonCrash),
  unknown: t(m.reasonUnknown),
};

const ORDER: StopReason[] = ["oomd", "crash", "host-stop", "restart", "promote", "unknown"];

export interface StopsDay {
  day: string;
  counts: Record<StopReason, number>;
  turns: number;
  taskIds: string[];
}

const zero = (): Record<StopReason, number> => Object.fromEntries(ORDER.map((r) => [r, 0])) as Record<StopReason, number>;

/** The stops table: a row per day, the newest first; a column per cause that occurred; a total row. */
export function stopsTable(rows: OpsStopsRow[]): { reasons: StopReason[]; days: StopsDay[]; total: StopsDay } {
  const byDay = new Map<string, StopsDay>();
  const total: StopsDay = { day: t(m.total), counts: zero(), turns: 0, taskIds: [] };
  for (const r of rows) {
    const d = byDay.get(r.day) ?? { day: r.day, counts: zero(), turns: 0, taskIds: [] };
    for (const t of [d, total]) {
      t.counts[r.reason] += r.stops;
      t.turns += r.turns;
      t.taskIds = [...new Set([...t.taskIds, ...r.taskIds])];
    }
    byDay.set(r.day, d);
  }
  return { reasons: ORDER.filter((r) => total.counts[r] > 0), days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)), total };
}

/** What a kind of load is called on screen (#2086). */
export const kindLabel: Record<LoadKind, string> = {
  runner: t(m.kindRunner),
  subagent: t(m.kindSubagent),
  test: t(m.kindTest),
  browser: "headless Chrome",
  docker: "docker",
  build: t(m.kindBuild),
  judge: t(m.kindJudge),
  archive: t(m.kindArchive),
  backlog: t(m.kindBacklog),
  other: t(m.kindOther),
};

const GB = 1024 ** 3;
/** `1.2 GB` from 1 GB up, `350 MB` below. */
export function fmtBytes(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

export interface LoadDay {
  day: string;
  maxMem: number;
  memMax: number | null;
  /** maxMem / memMax; null without a limit. */
  ratio: number | null;
  limitHits: number;
  maxSwap: number;
}

/** The API's JST hours as JST days, the newest first: the peaks of the day and its limit hits. */
export function loadDays(hours: OpsLoadHour[]): LoadDay[] {
  const byDay = new Map<string, LoadDay>();
  for (const h of hours) {
    const day = h.hour.slice(0, 10);
    const d = byDay.get(day) ?? { day, maxMem: 0, memMax: null, ratio: null, limitHits: 0, maxSwap: 0 };
    d.maxMem = Math.max(d.maxMem, h.maxMem);
    d.memMax = h.memMax === null ? d.memMax : Math.max(d.memMax ?? 0, h.memMax);
    d.limitHits += h.limitHits;
    d.maxSwap = Math.max(d.maxSwap, h.maxSwap);
    d.ratio = d.memMax ? d.maxMem / d.memMax : null;
    byDay.set(day, d);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/** The `n` heaviest task × kind (and the daemon's own work), largest RSS first, with what the screen calls them. */
export function topGroups(groups: OpsLoadGroup[], n = 10): Array<{ key: string; taskId: string | null; label: string; maxRss: number; cpuMs: number }> {
  return [...groups]
    .sort((a, b) => b.maxRss - a.maxRss)
    .slice(0, n)
    .map((g) => ({
      taskId: g.owner === "task" ? g.taskId : null,
      key: `${g.owner}/${g.taskId ?? ""}/${g.kind}`,
      label: g.owner === "daemon" ? t(m.groupDaemon, { kind: kindLabel[g.kind] }) : g.owner === "task" ? t(m.groupTask, { id: g.taskId ?? "", kind: kindLabel[g.kind] }) : g.kind === "other" ? t(m.kindOther) : t(m.groupOther, { kind: kindLabel[g.kind] }),
      maxRss: g.maxRss,
      cpuMs: g.cpuMs,
    }));
}

/**
 * The Brief's 負荷 line for one task: the sum of each kind's largest minute (an upper bound: the kinds may peak at
 * different minutes) and the kinds, largest first. null when the task has no rows.
 */
export function taskLoadLine(groups: OpsLoadGroup[]): string | null {
  if (groups.length === 0) return null;
  const sorted = [...groups].sort((a, b) => b.maxRss - a.maxRss);
  const total = sorted.reduce((a, g) => a + g.maxRss, 0);
  return t(m.taskLoad, { total: fmtBytes(total), kinds: sorted.map((g) => `${kindLabel[g.kind]} ${fmtBytes(g.maxRss)}`).join(" / ") });
}

/** A response's size (#2104): `850 B`, `12.3 KB`, `3.3 MB`. */
export function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export interface LatencyRow {
  key: string;
  method: string;
  route: string;
  count: string;
  p50: string;
  p90: string;
  bytes: string;
  days: Array<{ day: string; p50: string; p90: string; count: number }>;
}

/** The API 所要時間 table (#2104): the period's `top` slowest method × route by p90, each with its days, the newest first. */
export function latencyRows(l: OpsLatency, top = 10): LatencyRow[] {
  return l.total.slice(0, top).map((t) => ({
    key: `${t.method} ${t.route}`,
    method: t.method,
    route: t.route,
    count: t.count.toLocaleString("en-US"),
    p50: fmtMs(t.p50),
    p90: fmtMs(t.p90),
    bytes: t.bytesP50 === null ? "—" : fmtSize(t.bytesP50),
    days: l.byDay
      .filter((d) => d.method === t.method && d.route === t.route)
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((d) => ({ day: d.day, p50: fmtMs(d.p50), p90: fmtMs(d.p90), count: d.count })),
  }));
}
