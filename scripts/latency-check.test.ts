import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSecrets } from "../ops-kit/src/secrets.ts";
import { Db } from "../packages/core/src/db.ts";
import type { FileDeps } from "./file-request.ts";
import { main, report, requestFor, slowHours, TITLE } from "./latency-check.ts";

// 2026-10-27 23:30 JST = 14:30 UTC
const NOW = Date.parse("2026-10-27T14:45:00Z");
const AT = Date.parse("2026-10-27T14:10:00Z");
type Row = { ts: number; method: string; route: string; status: number; ms: number; bytes: number | null };
const row = (method: string, route: string, ms: number, ts = AT): Row => ({ ts, method, route, status: 200, ms, bytes: null });

function withDb<T>(rows: Row[], fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.latency-test."));
  const path = join(dir, "switchboard.db");
  try {
    const w = new Db(path);
    w.insertApiRequests(rows, NOW);
    w.close();
    const db = new Database(path, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const healthy = (n: number, ms: number) => Array.from({ length: n }, (_, i) => row("GET", "/api/health", ms + (i === 0 ? 100_000 : 0), AT + i));
const busy: Row[] = [
  row("GET", "/api/daemon/release", 30_000),
  row("POST", "/api/backlog/sync", 20_000),
  row("POST", "/api/backlog/sync", 20_000),
  row("GET", "/api/ledger/summary", 9000),
  row("GET", "/api/backlog", 8000),
  row("GET", "/api/flow", 5000),
  row("GET", "/api/tasks/:id/footprint", 100),
];

function fakeFile() {
  const filed: string[] = [];
  const comments: string[][] = [];
  const deps: FileDeps = {
    env: { GH_REPO: "acme/app" },
    exec: async (cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "api") return { out: filed.map((t, i) => JSON.stringify({ number: 100 + i, title: t })).join("\n"), code: 0 };
      if (cmd[0] === "bash") {
        filed.push(cmd[2]!);
        return { out: `要望を作成: #${99 + filed.length}\n`, code: 0 };
      }
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "comment") {
        comments.push(cmd);
        return { out: "", code: 0 };
      }
      throw new Error(`unexpected ${cmd.join(" ")}`);
    },
    records: async () => ({ issues: [] }),
    out: () => {},
  };
  return { deps, filed, comments };
}

describe("latency-check (#2821)", () => {
  test("slowHours: an hour with 5+ /api/health over 2 s is reported with its top 5 routes (#2821)", () => {
    const hours = withDb([...healthy(52, 2500), ...busy], (db) => slowHours(db, NOW));
    expect(hours).toHaveLength(1);
    const h = hours[0]!;
    expect(h.hour).toBe("2026-10-27 23");
    expect(h.slow).toBe(52);
    expect(h.maxMs).toBe(102_500);
    expect(h.top.map((t) => `${t.method} ${t.route}`)).toEqual(["POST /api/backlog/sync", "GET /api/daemon/release", "GET /api/ledger/summary", "GET /api/backlog", "GET /api/flow"]);
    expect(h.top.some((t) => t.route === "/api/health")).toBe(false);
    expect(h.top[0]).toMatchObject({ count: 2, totalMs: 40_000, maxMs: 20_000 });
    expect(withDb([...healthy(4, 2500), ...busy], (db) => slowHours(db, NOW))).toEqual([]);
    // rows older than 24 h are not read
    expect(withDb(healthy(10, 2500), (db) => slowHours(db, NOW + 25 * 3_600_000))).toEqual([]);
  });

  test("requestFor + fileRequest: the second run comments on the open request instead of filing (#2821)", async () => {
    const hours = withDb([...healthy(52, 2500), ...busy], (db) => slowHours(db, NOW));
    const f = fakeFile();
    const log: string[] = [];
    const deps = { read: () => hours, file: f.deps, now: () => new Date(NOW), log: (l: string) => log.push(l) };
    expect(await main(["--file-request"], deps)).toBe(1);
    expect(f.filed).toHaveLength(1);
    expect(f.comments).toHaveLength(0);
    expect(log.at(-1)).toBe("要望: 起票した #100");
    // the listing now returns the filed title
    f.filed[0] = TITLE;
    expect(await main(["--file-request"], deps)).toBe(1);
    expect(f.filed).toHaveLength(1);
    expect(f.comments).toHaveLength(1);
    expect(f.comments[0]!.slice(0, 4)).toEqual(["gh", "issue", "comment", "100"]);
    expect(log.at(-1)).toBe("要望: 既存 #100 に追記した");
    expect(requestFor(hours, { date: "2026-10-28" }).title).toBe(TITLE);
  });

  test("no slow hour files and comments nothing (#2821)", async () => {
    const hours = withDb([...healthy(30, 300), ...busy], (db) => slowHours(db, NOW));
    expect(hours).toEqual([]);
    expect(report(hours)).toEqual({ code: 0, lines: ["遅れなし（直近 24 時間）"] });
    let calls = 0;
    const deps: FileDeps = { env: {}, exec: async () => (calls++, { out: "", code: 0 }), records: async () => (calls++, { issues: [] }) };
    expect(await main(["--file-request"], { read: () => hours, file: deps, now: () => new Date(NOW), log: () => {} })).toBe(0);
    expect(calls).toBe(0);
  });

  test("main cannot tell when the database cannot be read: exit 2, nothing filed (#2821)", async () => {
    const log: string[] = [];
    const code = await main(["--file-request"], { read: () => { throw new Error("api_requests の表が無い"); }, file: fakeFile().deps, now: () => new Date(NOW), log: (l) => log.push(l) });
    expect(code).toBe(2);
    expect(log[0]).toBe("判定できない（api_requests の表が無い）");
  });

  test("the request has no secret and no address (#2821)", () => {
    const hours = withDb([...healthy(52, 2500), ...busy], (db) => slowHours(db, NOW));
    const r = requestFor(hours, { date: "2026-10-28" });
    for (const text of [r.body, r.comment]) {
      expect(findSecrets(text)).toHaveLength(0);
      expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(text).not.toMatch(/\b[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\b/i);
    }
    expect(r.body).toContain("## 出典\n- 誰の言葉: 定期の検査\n");
  });
});
