import type { OpsLatency, OpsLatencyStat } from "@switchboard/protocol";
import { type Db, jstDay, jstDayStart, nearestRank } from "./db.ts";

/**
 * `GET /api/ops/latency` (#2102, docs/design/ops-metrics.md): api_requests over the last `days` JST days, per method ×
 * route for the whole period and per day. api_requests keeps 7 days, so a longer period still answers 7 days; requests
 * of the last 10 s are still in the daemon's buffer.
 */
export function opsLatency(db: Db, days: number, now = Date.now()): OpsLatency {
  const rows = db.sqlite.query("SELECT ts, method, route, ms, bytes FROM api_requests WHERE ts >= ?").all(jstDayStart(now, days - 1)) as Array<{ ts: number; method: string; route: string; ms: number; bytes: number | null }>;
  const total = new Map<string, typeof rows>();
  const byDay = new Map<string, typeof rows>();
  const add = (m: Map<string, typeof rows>, key: string, r: (typeof rows)[number]) => {
    const g = m.get(key);
    if (g) g.push(r);
    else m.set(key, [r]);
  };
  for (const r of rows) {
    add(total, `${r.method} ${r.route}`, r);
    add(byDay, `${jstDay(r.ts)} ${r.method} ${r.route}`, r);
  }
  const stat = (g: typeof rows): OpsLatencyStat => {
    const ms = g.map((r) => r.ms).sort((a, b) => a - b);
    const bytes = g.flatMap((r) => (r.bytes === null ? [] : [r.bytes])).sort((a, b) => a - b);
    return { method: g[0]!.method, route: g[0]!.route, count: g.length, p50: nearestRank(ms, 0.5), p90: nearestRank(ms, 0.9), bytesP50: bytes.length ? nearestRank(bytes, 0.5) : null };
  };
  return {
    days,
    total: [...total.values()].map(stat).sort((a, b) => b.p90 - a.p90 || b.count - a.count),
    byDay: [...byDay.values()]
      .map((g) => ({ day: jstDay(g[0]!.ts), ...stat(g) }))
      .sort((a, b) => b.day.localeCompare(a.day) || b.p90 - a.p90 || b.count - a.count),
  };
}
