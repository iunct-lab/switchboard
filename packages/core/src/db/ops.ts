/** The measurements kept for the operator: load, API requests, journey timings. */

import { SizeClass } from "@switchboard/protocol";
import type { LoadKind, Journey, PerfSample, PerfSummaryRow } from "@switchboard/protocol";
import { CheckRunQueries } from "./check-runs.ts";

/** How long the everyday journey timings are kept: older rows go when new ones are saved. */
const PERF_KEEP_MS = 30 * 24 * 3600 * 1000;
/** The speed table's period: the last 7 days against the 7 before them. */
const PERF_PERIOD_MS = 7 * 24 * 3600 * 1000;
const OPS_LOAD_KEEP_MS = 7 * 24 * 3600 * 1000;
const API_REQUESTS_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A row of api_requests. `bytes` = the response's content-length, null when it has none. */
export type ApiRequestRow = { ts: number; method: string; route: string; status: number; ms: number; bytes: number | null };
/** A row of ops_load: the unit's cgroup at one minute; `top` is the JSON of the 10 largest processes. */
export type OpsLoadRow = { memCurrent: number; memMax: number | null; swapCurrent: number; eventsMax: number; cpuPct: number | null; pressureSome: number | null; pressureFull: number | null; dockerMem: number | null; top: string };
export type OpsLoadGroupRow = { taskId: string | null; owner: "task" | "daemon" | "other"; kind: LoadKind; rssBytes: number; cpuMs: number; procs: number };

/** The measurements kept for the operator: load, API requests, journey timings. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class OpsQueries extends CheckRunQueries {
  /** One minute of the host's load and its groups, dropping both tables' rows older than 7 days, in one transaction. */
  insertOpsLoad(row: OpsLoadRow, groups: OpsLoadGroupRow[], now = Date.now()) {
    const group = this.sqlite.query("INSERT INTO ops_load_groups (ts, task_id, owner, kind, rss, cpu_ms, procs) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      this.sqlite
        .query("INSERT OR REPLACE INTO ops_load (ts, mem_current, mem_max, swap_current, events_max, cpu_pct, pressure_some, pressure_full, docker_mem, top) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(now, row.memCurrent, row.memMax, row.swapCurrent, row.eventsMax, row.cpuPct, row.pressureSome, row.pressureFull, row.dockerMem, row.top);
      for (const g of groups) group.run(now, g.taskId, g.owner, g.kind, g.rssBytes, g.cpuMs, g.procs);
      this.sqlite.query("DELETE FROM ops_load WHERE ts < ?").run(now - OPS_LOAD_KEEP_MS);
      this.sqlite.query("DELETE FROM ops_load_groups WHERE ts < ?").run(now - OPS_LOAD_KEEP_MS);
    })();
  }

  /** Saves buffered API requests and drops those older than 7 days, in one transaction. */
  insertApiRequests(rows: ApiRequestRow[], now = Date.now()) {
    const insert = this.sqlite.query("INSERT INTO api_requests (ts, method, route, status, ms, bytes) VALUES (?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      for (const r of rows) insert.run(r.ts, r.method, r.route, r.status, r.ms, r.bytes);
      this.sqlite.query("DELETE FROM api_requests WHERE ts < ?").run(now - API_REQUESTS_KEEP_MS);
    })();
  }

  /** Saves the Web UI's journey timings and drops those older than 30 days, in one transaction. */
  insertPerfSamples(rows: PerfSample[], now = Date.now()) {
    const insert = this.sqlite.query("INSERT INTO perf_samples (ts, journey, device, build, ms, task_id, bytes, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.sqlite.transaction(() => {
      for (const r of rows) insert.run(now, r.journey, r.device, r.build, r.ms, r.taskId, r.bytes, r.events);
      this.sqlite.query("DELETE FROM perf_samples WHERE ts < ?").run(now - PERF_KEEP_MS);
    })();
  }

  /**
   * Journey timings per journey × device × size: the last 7 days against the 7 days before them. A
   * comparison by build stopped working once a build lasted a few hours (promoted 8 times a day). p50 / p90 are nearest-rank.
   */
  perfSummary(now = Date.now()): PerfSummaryRow[] {
    const rows = this.sqlite.query("SELECT ts, journey, device, ms, events FROM perf_samples WHERE ts >= ?").all(now - 2 * PERF_PERIOD_MS) as Array<{ ts: number; journey: Journey; device: PerfSample["device"]; ms: number; events: number | null }>;
    const groups = new Map<string, { journey: Journey; device: PerfSample["device"]; size: SizeClass | null; current: number[]; previous: number[] }>();
    for (const r of rows) {
      const size = sizeClass(r.events);
      const key = `${r.journey}|${r.device}|${size}`;
      const g = groups.get(key) ?? { journey: r.journey, device: r.device, size, current: [], previous: [] };
      (r.ts >= now - PERF_PERIOD_MS ? g.current : g.previous).push(r.ms);
      groups.set(key, g);
    }
    const stats = (ms: number[]) => {
      if (ms.length === 0) return null;
      const sorted = ms.sort((a, b) => a - b);
      return { count: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9) };
    };
    const order = (s: SizeClass | null) => (s === null ? -1 : SizeClass.options.indexOf(s));
    return [...groups.values()]
      .sort((a, b) => a.journey.localeCompare(b.journey) || a.device.localeCompare(b.device) || order(a.size) - order(b.size))
      .map((g) => ({ journey: g.journey, device: g.device, size: g.size, current: stats(g.current), previous: stats(g.previous) }));
  }
}

/** A Task's size class by its event count; null when the sample has none. */
export function sizeClass(events: number | null): SizeClass | null {
  return events === null ? null : events <= 1000 ? "small" : events <= 5000 ? "medium" : "large";
}

/** The nearest-rank `p` quantile of an ascending, non-empty list (perfSummary, opsLatency). */
export function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
