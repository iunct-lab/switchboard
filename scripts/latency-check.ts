/**
 * bun scripts/latency-check.ts [--file-request] — hours (JST) of the last 24 hours in which GET /api/health took over
 * 2 s five times or more, with the routes that took longest in that hour (PBI #2821, docs/design/ops-metrics.md "API の所要時間").
 * Exit 0 = no slow hour / 1 = some / 2 = cannot tell (no database, no table, unreadable). Read-only: api_requests is read
 * through bun:sqlite readonly, and only ts / method / route / ms.
 *
 * --file-request (the daily schedule): on exit 1 also file one request with a fixed title, or comment on the open
 * request with that title (scripts/file-request.ts). The exit code is the same with or without it.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commentRequest, FILE_DEPS, type FileDeps, fileRequest } from "./file-request.ts";

export const SLOW_MS = 2000;
export const SLOW_PER_HOUR = 5;
export const TOP_ROUTES = 5;
export const WINDOW_MS = 24 * 3_600_000;
const HEALTH = "/api/health";

export interface RouteLoad {
  method: string;
  route: string;
  count: number;
  totalMs: number;
  maxMs: number;
}
export interface SlowHour {
  /** `YYYY-MM-DD HH`, JST */
  hour: string;
  /** GET /api/health requests over SLOW_MS in the hour */
  slow: number;
  /** the longest GET /api/health in the hour */
  maxMs: number;
  top: RouteLoad[];
}

const JST_HOUR = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function jstHour(ts: number): string {
  const p = Object.fromEntries(JST_HOUR.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}`;
}

/** The hours of the last 24 with SLOW_PER_HOUR or more slow health checks, newest first. */
export function slowHours(db: Database, now = Date.now()): SlowHour[] {
  const rows = db.query("SELECT ts, method, route, ms FROM api_requests WHERE ts >= ?").all(now - WINDOW_MS) as Array<{ ts: number; method: string; route: string; ms: number }>;
  const byHour = new Map<string, { slow: number; maxMs: number; routes: Map<string, RouteLoad> }>();
  for (const r of rows) {
    const key = jstHour(r.ts);
    const h = byHour.get(key) ?? { slow: 0, maxMs: 0, routes: new Map() };
    byHour.set(key, h);
    if (r.method === "GET" && r.route === HEALTH) {
      if (r.ms > SLOW_MS) h.slow++;
      h.maxMs = Math.max(h.maxMs, r.ms);
      continue;
    }
    const k = `${r.method} ${r.route}`;
    const l = h.routes.get(k) ?? { method: r.method, route: r.route, count: 0, totalMs: 0, maxMs: 0 };
    l.count++;
    l.totalMs += r.ms;
    l.maxMs = Math.max(l.maxMs, r.ms);
    h.routes.set(k, l);
  }
  return [...byHour.entries()]
    .filter(([, h]) => h.slow >= SLOW_PER_HOUR)
    .map(([hour, h]) => ({ hour, slow: h.slow, maxMs: h.maxMs, top: [...h.routes.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, TOP_ROUTES) }))
    .sort((a, b) => (a.hour < b.hour ? 1 : -1));
}

const sec = (ms: number) => `${(Math.round(ms) / 1000).toFixed(1)} 秒`;

export function report(hours: SlowHour[]): { code: 0 | 1; lines: string[] } {
  if (hours.length === 0) return { code: 0, lines: ["遅れなし（直近 24 時間）"] };
  const lines = hours.flatMap((h) => [
    `${h.hour} 時: ${HEALTH} の ${sec(SLOW_MS)}超 ${h.slow} 回、最大 ${sec(h.maxMs)}`,
    ...h.top.map((t) => `  ${t.method} ${t.route}: ${t.count} 回、合計 ${sec(t.totalMs)}、最大 ${sec(t.maxMs)}`),
  ]);
  return { code: 1, lines };
}

export const TITLE = `デーモンの応答の遅れ: ${HEALTH} の 2 秒超が 1 時間に 5 回以上`;

function tables(hours: SlowHour[]): string[] {
  return [
    "| 時間帯（JST） | 2 秒超の回数 | 最大 |",
    "|---|---|---|",
    ...hours.map((h) => `| ${h.hour} 時 | ${h.slow} | ${sec(h.maxMs)} |`),
    "",
    ...hours.flatMap((h) => [
      `${h.hour} 時に長くかかっていた route（${HEALTH} を除く、合計の大きい順の上位 ${TOP_ROUTES} 件）`,
      "",
      "| route | 回数 | 合計 | 最大 |",
      "|---|---|---|---|",
      ...(h.top.length ? h.top.map((t) => `| ${t.method} ${t.route} | ${t.count} | ${sec(t.totalMs)} | ${sec(t.maxMs)} |`) : ["| （なし） | | | |"]),
      "",
    ]),
  ];
}

/** The request for slow hours. The title is fixed: the same slowness is the open request with this title. */
export function requestFor(hours: SlowHour[], source: { date: string }): { title: string; body: string; comment: string } {
  const body = [
    "## 要望",
    `デーモンの応答が遅れた時間帯があります。調べ方は docs/design/ops-metrics.md の「API の所要時間」と Insights の「運用」。`,
    "",
    ...tables(hours),
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `\`bun scripts/latency-check.ts --file-request\`（定期実行） / ${source.date}`,
  ].join("\n");
  const comment = [`## ${source.date} の検査`, "", ...tables(hours)].join("\n");
  return { title: TITLE, body, comment };
}

export interface Deps {
  /** SlowHour[] for the database, or throws when it cannot be read */
  read: () => SlowHour[];
  file: FileDeps;
  now: () => Date;
  log: (line: string) => void;
}

function dbPath(): string {
  return join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
}

function readSlowHours(path: string): SlowHour[] {
  if (!existsSync(path)) throw new Error(`${path} が無い`);
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_requests'").get()) throw new Error("api_requests の表が無い");
    return slowHours(db);
  } finally {
    db.close();
  }
}

export async function main(args: string[], deps: Deps = { read: () => readSlowHours(dbPath()), file: FILE_DEPS, now: () => new Date(), log: console.log }): Promise<0 | 1 | 2> {
  let hours: SlowHour[];
  try {
    hours = deps.read();
  } catch (e) {
    deps.log(`判定できない（${(e as Error).message}）`);
    return 2;
  }
  const r = report(hours);
  for (const l of r.lines) deps.log(l);
  if (r.code === 1 && args.includes("--file-request")) {
    const req = requestFor(hours, { date: deps.now().toISOString().slice(0, 10) });
    try {
      const filed = await fileRequest({ title: req.title, body: req.body }, deps.file);
      if ("open" in filed) {
        await commentRequest(filed.open, req.comment, deps.file);
        deps.log(`要望: 既存 ${filed.open} に追記した`);
      } else {
        deps.log(`要望: 起票した ${filed.filed === null ? "（番号は上の出力）" : `#${filed.filed}`}`);
      }
    } catch (e) {
      deps.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  return r.code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
