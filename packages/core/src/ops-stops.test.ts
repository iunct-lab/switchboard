import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { classifyStop, type DaemonRun, endDaemonRun, readReleaseHistory, type StopInput, startDaemonRun } from "./ops-stops.ts";

const T0 = 1_792_500_000_000;
const prev = (over: Partial<DaemonRun> = {}): DaemonRun => ({ id: 1, started_at: T0, ended_at: null, end_reason: null, end_detail: null, clean_exit: null, version: "aaa", boot_id: "boot-1", interrupted_task_ids: "[]", ...over });
const input = (over: Partial<StopInput> = {}): StopInput => ({ now: T0 + 3_600_000, version: "aaa", bootId: "boot-1", journal: [], history: [], ...over });
const OOMD = `${(T0 + 600_000) / 1000}.250000 host systemd[1]: switchboard.service: systemd-oomd killed 290 process(es) in this unit.`;
const EXIT75 = `${(T0 + 900_000) / 1000}.000000 host systemd[1]: switchboard.service: Main process exited, code=exited, status=75/TEMPFAIL`;

test("classifyStop: the daemon's own exit 75 is a restart", () => {
  expect(classifyStop(prev({ clean_exit: "restart", ended_at: T0 + 5 }), input({ journal: [OOMD] }))).toMatchObject({ reason: "restart", endedAt: T0 + 5 });
});

test("classifyStop: a promotion in history.jsonl, or a changed version, is a promote", () => {
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input({ history: [{ ts: T0 + 600_000, action: "promote" }] })).reason).toBe("promote");
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input({ history: [{ ts: T0 + 600_000, action: "restore-db" }] })).reason).toBe("promote");
  // the line of the promotion that started this run, written once it was confirmed: not how the run ended
  expect(classifyStop(prev(), input({ history: [{ ts: T0 + 15_000, action: "promote" }], journal: [OOMD] })).reason).toBe("oomd");
  // sb-rescue writes the line only after the new daemon is confirmed: the version tells it at once
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input({ version: "bbb" })).reason).toBe("promote");
  // a line from before the run is not about this stop
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input({ history: [{ ts: T0 - 10, action: "promote" }] })).reason).toBe("restart");
  expect(classifyStop(prev(), input({ history: [{ ts: T0 + 600_000, action: "restart" }] })).reason).toBe("restart");
});

test("classifyStop: oomd in the journal, at the journal line's time", () => {
  expect(classifyStop(prev(), input({ journal: [OOMD, EXIT75] }))).toMatchObject({ reason: "oomd", endedAt: T0 + 600_250 });
  // a daemon that exited by itself was not the one killed
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input({ journal: [OOMD] })).reason).toBe("restart");
});

test("classifyStop: a new boot id is a host stop", () => {
  expect(classifyStop(prev({ clean_exit: "shutdown", ended_at: T0 + 7 }), input({ bootId: "boot-2" }))).toMatchObject({ reason: "host-stop", endedAt: T0 + 7 });
});

test("classifyStop: exit 75 in the journal is a restart", () => {
  expect(classifyStop(prev(), input({ journal: [EXIT75] }))).toMatchObject({ reason: "restart", endedAt: T0 + 900_000 });
});

test("classifyStop: no journal is unknown", () => {
  expect(classifyStop(prev(), input({ journal: null }))).toMatchObject({ reason: "unknown", endedAt: T0 + 3_600_000 });
});

test("classifyStop: a handled signal is a restart, nothing at all a crash", () => {
  expect(classifyStop(prev({ clean_exit: "shutdown" }), input()).reason).toBe("restart");
  expect(classifyStop(prev(), input())).toMatchObject({ reason: "crash", endedAt: T0 + 3_600_000 });
  expect(classifyStop(prev(), input()).detail).not.toContain("systemd");
});

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-ops-stops-"));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () => db.sqlite.query("SELECT * FROM daemon_runs ORDER BY id").all() as DaemonRun[];

test("startDaemonRun closes the previous run and adds the orphaned tasks", () => {
  const since: number[] = [];
  const journal = (s: number) => (since.push(s), [OOMD]);
  const first = startDaemonRun(db, { now: T0, version: "aaa", bootId: "boot-1", journal, history: [], orphaned: [] });
  expect(since).toEqual([]); // nothing to close, nothing read
  endDaemonRun(db, first, { cleanExit: "shutdown", endedAt: T0 + 100, taskIds: ["t1", "t2"] });
  const second = startDaemonRun(db, { now: T0 + 200, version: "aaa", bootId: "boot-1", journal, history: [], orphaned: ["t2", "t3"] });
  expect(since).toEqual([T0]);
  const third = startDaemonRun(db, { now: T0 + 3_600_000, version: "aaa", bootId: "boot-1", journal, history: [], orphaned: ["t4"] });
  expect(rows()).toEqual([
    { id: first, started_at: T0, ended_at: T0 + 100, end_reason: "restart", end_detail: "the daemon stopped on a signal", clean_exit: "shutdown", version: "aaa", boot_id: "boot-1", interrupted_task_ids: '["t1","t2","t3"]' },
    { id: second, started_at: T0 + 200, ended_at: T0 + 600_250, end_reason: "oomd", end_detail: "journal: systemd-oomd killed the unit", clean_exit: null, version: "aaa", boot_id: "boot-1", interrupted_task_ids: '["t4"]' },
    { id: third, started_at: T0 + 3_600_000, ended_at: null, end_reason: null, end_detail: null, clean_exit: null, version: "aaa", boot_id: "boot-1", interrupted_task_ids: "[]" },
  ]);
});

test("readReleaseHistory skips broken lines and a missing file", () => {
  expect(readReleaseHistory(dir)).toEqual([]);
  mkdirSync(join(dir, "releases"));
  writeFileSync(join(dir, "releases", "history.jsonl"), `{"ts":1,"action":"promote","from":"a"}\n{"ts":2,"act\n{"ts":3,"action":"restart"}\n`);
  expect(readReleaseHistory(dir)).toEqual([{ ts: 1, action: "promote" }, { ts: 3, action: "restart" }]);
});

test("never calls fetch: the cause comes from local records only", () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => (calls++, new Response("")), { preconnect: saved.preconnect }) as typeof fetch;
  try {
    const id = startDaemonRun(db, { now: T0, version: null, bootId: null, journal: () => null, history: [], orphaned: [] });
    endDaemonRun(db, id, { cleanExit: "shutdown", endedAt: T0 + 1, taskIds: [] });
    startDaemonRun(db, { now: T0 + 2, version: null, bootId: null, journal: () => null, history: [], orphaned: [] });
    expect(rows()[0]!.end_reason).toBe("unknown");
  } finally {
    globalThis.fetch = saved;
  }
  expect(calls).toBe(0);
});
