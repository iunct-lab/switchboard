// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpsLatency, OpsLoad, OpsResources, OpsStops } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import * as heavyModule from "../../../ops-kit/src/heavy.ts";
import * as opsLoadModule from "./ops-load.ts";
import { opsResources, readMemInfo, TASK_MIN_FREE_MB_DEFAULT } from "./ops-resources.ts";
import { TaskManager } from "./tasks/manager.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

describe("ops stops", () => {
  test("GET /api/ops/stops: closed runs per JST day × cause, cut turns and distinct tasks, the run in progress; days is an integer 1..90", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-stops-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const day = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(ts));
      const today = Date.parse(`${day(Date.now())}T12:00:00+09:00`);
      const yesterday = today - 86_400_000;
      const add = (endedAt: number, reason: string, ids: string[]) => c.db.sqlite.query("INSERT INTO daemon_runs (started_at, ended_at, end_reason, interrupted_task_ids) VALUES (?, ?, ?, ?)").run(endedAt - 1000, endedAt, reason, JSON.stringify(ids));
      add(yesterday, "oomd", ["t1", "t2"]);
      add(today, "oomd", ["t1"]);
      add(today + 60_000, "oomd", ["t1", "t3"]); // the same task cut again: 2 turns, 1 task
      add(today, "promote", []);
      add(today - 40 * 86_400_000, "crash", ["t9"]); // outside 7 days
      const body = OpsStops.parse(await fetch(`${b}/api/ops/stops?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.rows).toEqual([
        { day: day(yesterday), reason: "oomd", stops: 1, turns: 2, taskIds: ["t1", "t2"] },
        { day: day(today), reason: "oomd", stops: 2, turns: 3, taskIds: ["t1", "t3"] },
        { day: day(today), reason: "promote", stops: 1, turns: 0, taskIds: [] },
      ]);
      expect(body.running?.startedAt).toBeGreaterThan(0); // this daemon's own row
      expect(OpsStops.parse(await fetch(`${b}/api/ops/stops?days=90`).then(j)).rows.map((r) => r.reason)).toContain("crash");
      for (const q of ["?days=0", "?days=91", "?days=abc", "?days=", "?days=1.5"]) expect((await fetch(`${b}/api/ops/stops${q}`)).status).toBe(400);
      expect((await fetch(`${b}/api/ops/stops`)).status).toBe(200); // absent = 7
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops latency", () => {
  test("GET /api/ops/latency: method × route over the period (largest p90 first) and per JST day (newest first), p50 / p90 / count / bytes p50", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-latency-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const day = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(ts));
      const today = Date.parse(`${day(Date.now())}T00:30:00+09:00`);
      const yesterday = today - 86_400_000;
      const row = (ts: number, route: string, ms: number, bytes: number | null, method = "GET") => ({ ts, method, route, status: 200, ms, bytes });
      c.db.insertApiRequests([
        // yesterday: the detail is slow
        ...[100, 200, 300, 400, 5000].map((ms, i) => row(yesterday + i, "/api/tasks/:id", ms, 1000 * (i + 1))),
        row(yesterday, "/api/tasks", 5, null),
        // today: faster detail; the list twice, one without bytes
        ...[50, 60].map((ms) => row(today, "/api/tasks/:id", ms, 9000)),
        row(today, "/api/tasks", 7, 300),
        row(today, "/api/tasks", 9, null),
        row(today - 10 * 86_400_000, "/api/old", 99_999, 1), // before the period
      ]);
      const body = OpsLatency.parse(await fetch(`${b}/api/ops/latency?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.total).toEqual([
        { method: "GET", route: "/api/tasks/:id", count: 7, p50: 200, p90: 5000, bytesP50: 4000 },
        { method: "GET", route: "/api/tasks", count: 3, p50: 7, p90: 9, bytesP50: 300 },
      ]);
      expect(body.byDay).toEqual([
        { day: day(today), method: "GET", route: "/api/tasks/:id", count: 2, p50: 50, p90: 60, bytesP50: 9000 },
        { day: day(today), method: "GET", route: "/api/tasks", count: 2, p50: 7, p90: 9, bytesP50: 300 },
        { day: day(yesterday), method: "GET", route: "/api/tasks/:id", count: 5, p50: 300, p90: 5000, bytesP50: 3000 },
        { day: day(yesterday), method: "GET", route: "/api/tasks", count: 1, p50: 5, p90: 5, bytesP50: null },
      ]);
      // one day: only today's
      // the daemon's own api_requests flush (every 10 s) may add this test's own request
      expect([...new Set(OpsLatency.parse(await fetch(`${b}/api/ops/latency?days=1`).then(j)).byDay.map((r) => r.day))]).toEqual([day(today)]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 30_000); // startServer and the API round trips: over the 5 s default on a loaded host (docs/design/perf.md "Test flakiness")
});

describe("ops resources", () => {
  test("now: free memory and the floor, the slots with their Tasks, who waits (outside a Task too), the latest minute's RSS — without walking /proc's processes", () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-resources-"));
    const db = new Db(join(h, "x.db"));
    const procs = spyOn(opsLoadModule, "readProcs");
    try {
      const now = Date.now();
      db.insertTask({ id: "t_ci", workspaceId: null, title: "PBI の local-ci", runner: "claude", cwd: h, scope: [h], status: "running", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      // ops-kit heavy's files: one holding the slot in Task t_ci, one waiting outside a Task, one of a process that is gone
      const state = join(h, ".local", "state", "ops-kit", "heavy");
      mkdirSync(state, { recursive: true });
      mkdirSync(join(h, ".config", "ops-kit"), { recursive: true });
      writeFileSync(join(h, ".config", "ops-kit", "heavy.json"), JSON.stringify({ max: 1, minFreeMb: 1536 }));
      const live = process.pid;
      writeFileSync(join(state, "slot-0.json"), JSON.stringify({ pid: live, name: "local-ci 3639", cwd: "/w", taskId: "t_ci", queuedAt: "2026-11-03T10:00:00.000Z", startedAt: "2026-11-03T10:00:05.000Z", token: "a" }));
      writeFileSync(join(state, `wait-${live}-b.json`), JSON.stringify({ pid: live, name: "bun test", cwd: "/w", taskId: null, queuedAt: "2026-11-03T10:01:00.000Z", reason: "slot" }));
      writeFileSync(join(state, "wait-999999999-c.json"), JSON.stringify({ pid: 999_999_999, name: "gone", cwd: "/w", taskId: null, queuedAt: "2026-11-03T09:00:00.000Z", reason: "memory" }));
      // a full history (500 lines): local-ci runs of 10 minutes, and 3 bun test runs of 20
      const entry = (name: string, min: number) => JSON.stringify({ name, taskId: null, queuedAt: "2026-11-02T00:00:00.000Z", startedAt: "2026-11-02T00:00:00.000Z", endedAt: new Date(Date.parse("2026-11-02T00:00:00.000Z") + min * 60_000).toISOString(), exitCode: 0 });
      writeFileSync(join(state, "history.jsonl"), `${[...Array.from({ length: 497 }, (_, i) => entry(`local-ci ${3000 + i}`, 10)), ...Array.from({ length: 3 }, () => entry("bun test", 20))].join("\n")}\n`);
      const reads = spyOn(heavyModule, "readHeavyHistory");
      const at = Date.parse("2026-11-03T10:30:05.000Z"); // the local-ci has run 30 minutes, 3 times its median
      const proc = join(h, "proc");
      mkdirSync(proc);
      writeFileSync(join(proc, "meminfo"), "MemTotal:        3921000 kB\nMemFree:          100000 kB\nMemAvailable:    1000000 kB\nSwapTotal:       2097148 kB\nSwapFree:        1997148 kB\n");
      // nothing sampled yet: no consumers
      expect(opsResources(db, { home: h, procRoot: proc, now: at }).consumers).toBeNull();
      const group = (ts: number, task: string | null, owner: string, kind: string, rss: number, n: number) =>
        db.sqlite.query("INSERT INTO ops_load_groups (ts, task_id, owner, kind, rss, cpu_ms, procs) VALUES (?, ?, ?, ?, ?, 0, ?)").run(ts, task, owner, kind, rss, n);
      group(now - 120_000, "t_ci", "task", "test", 9_000_000_000, 1); // an older minute: not now
      group(now - 60_000, "t_ci", "task", "browser", 300_000_000, 3);
      group(now - 60_000, "t_ci", "task", "test", 700_000_000, 4);
      group(now - 60_000, null, "daemon", "judge", 50_000_000, 1);
      group(now - 60_000, "t_unknown", "task", "runner", 100_000_000, 1);
      // the jobs Tasks asked for: one running, one ended an hour ago, one ended 8 days ago (not shown)
      const job = (pr: number) => db.insertJob({ kind: pr === 3 ? "review" : "local-ci", taskId: pr === 2 ? "t_unknown" : "t_ci", pr, runner: pr === 3 ? "codex" : null, cwd: "/w", startedAt: at - 9 * 24 * 3600_000, repo: "", head: null, as: null, kinds: [] });
      const running = job(1);
      const ended = job(2);
      db.finishJob(ended.id, { status: "fail", exitCode: 1, summary: "fail", endedAt: at - 3600_000 });
      db.finishJob(job(3).id, { status: "pass", exitCode: 0, summary: "pass", endedAt: at - 8 * 24 * 3600_000 });
      const raw = opsResources(db, { home: h, procRoot: proc, now: at });
      expect(reads).toHaveBeenCalledTimes(1); // the second read of an unchanged history uses the first's medians
      reads.mockRestore();
      expect(Object.keys(raw)).toEqual(["memory", "slots", "eta", "taskWaits", "consumers", "jobs"]); // the history's lines are not in the answer
      // a run ends: the history changes, and the next read takes it in
      appendFileSync(join(state, "history.jsonl"), `${entry("bun test", 20)}\n`);
      expect(opsResources(db, { home: h, procRoot: proc, now: at }).slots.waiting[0]!.samples).toBe(4);
      const r = OpsResources.parse(raw);
      expect(r.memory).toEqual({ availableBytes: 1_000_000 * 1024, totalBytes: 3_921_000 * 1024, swapUsedBytes: 100_000 * 1024, floorBytes: 1536 * 1024 * 1024, safetyBytes: 300 * 1024 * 1024 });
      expect(r.slots.max).toBe(1);
      expect(r.slots.running).toEqual([{ pid: live, name: "local-ci 3639", cwd: "/w", taskId: "t_ci", taskTitle: "PBI の local-ci", queuedAt: "2026-11-03T10:00:00.000Z", startedAt: "2026-11-03T10:00:05.000Z", typicalMs: 600_000, samples: 497, verdict: "long" }]);
      expect(r.slots.waiting).toEqual([{ pid: live, name: "bun test", cwd: "/w", taskId: null, taskTitle: null, queuedAt: "2026-11-03T10:01:00.000Z", reason: "slot", memoryOnly: false, typicalMs: 1_200_000, samples: 3 }]);
      expect(r.eta).toEqual({ etaMs: 1_200_000, unknown: 0 }); // the local-ci is past its median: the bun test's 20 minutes
      expect(r.consumers!.at).toBe(now - 60_000);
      expect(r.consumers!.groups.map((g) => `${g.taskId}/${g.taskTitle}/${g.kind}/${g.rssBytes}/${g.procs}`)).toEqual([
        "t_ci/PBI の local-ci/test/700000000/4",
        "t_ci/PBI の local-ci/browser/300000000/3",
        "t_unknown/null/runner/100000000/1",
        "null/null/judge/50000000/1",
      ]);
      expect(r.jobs).toEqual([
        { id: ended.id, kind: "local-ci", taskId: "t_unknown", taskTitle: null, pr: 2, runner: null, status: "fail", exitCode: 1, startedAt: at - 9 * 24 * 3600_000, endedAt: at - 3600_000, as: null, model: null, effort: null },
        { id: running.id, kind: "local-ci", taskId: "t_ci", taskTitle: "PBI の local-ci", pr: 1, runner: null, status: "running", exitCode: null, startedAt: at - 9 * 24 * 3600_000, endedAt: null, as: null, model: null, effort: null },
      ]);
      expect(procs).not.toHaveBeenCalled();
      // no meminfo (macOS): no memory, the rest as before
      expect(readMemInfo(join(h, "none"))).toBeNull();
      expect(opsResources(db, { home: h, procRoot: join(h, "none") }).memory).toBeNull();
      // no ops-kit heavy on this machine yet: the defaults and no jobs
      const empty = mkdtempSync(join(tmpdir(), "switchboard-ops-resources-empty-"));
      expect(opsResources(db, { home: empty, procRoot: proc }).slots).toEqual({ max: 1, running: [], beside: [], waiting: [] });
      expect(opsResources(db, { home: empty, procRoot: proc }).eta).toEqual({ etaMs: null, unknown: 0 });
      rmSync(empty, { recursive: true, force: true });
    } finally {
      procs.mockRestore();
      db.sqlite.close();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops resources task waits", () => {
  const queued = (id: string, title: string, queuedAt: number, h: string) => ({ id, workspaceId: null, title, runner: "claude" as const, cwd: h, scope: [h], status: "idle" as const, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto" as const, effort: null, origin: "switchboard" as const, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown" as const, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: queuedAt, createdAt: queuedAt, updatedAt: queuedAt });
  test("taskWaits: only a memory wait lists the queue (in its order) and safetyBytes is heavy.json's taskMinFreeMb; slots and eta do not move; the reason is TaskManager's own", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-taskwaits-"));
    const db = new Db(join(h, "x.db"));
    try {
      mkdirSync(join(h, ".config", "ops-kit"), { recursive: true });
      writeFileSync(join(h, ".config", "ops-kit", "heavy.json"), JSON.stringify({ max: 2, minFreeMb: 1536, taskMinFreeMb: 250 }));
      const proc = join(h, "proc");
      mkdirSync(proc);
      writeFileSync(join(proc, "meminfo"), "MemTotal:        3921000 kB\nMemFree:          100000 kB\nMemAvailable:    1000000 kB\nSwapTotal:       2097148 kB\nSwapFree:        1997148 kB\n");
      const t0 = Date.parse("2026-11-13T10:00:00.000Z");
      db.insertTask(queued("t_second", "二つ目", t0 + 1000, h)); // inserted first, queued later
      db.insertTask(queued("t_first", "一つ目", t0, h));
      db.setQueued("t_second", "p", t0 + 1000, []);
      db.setQueued("t_first", "p", t0, []);
      const at = t0 + 60_000;
      const read = (queueWait?: () => "slot" | "memory" | null) => OpsResources.parse(opsResources(db, { home: h, procRoot: proc, now: at, queueWait }));
      // (a) a memory wait: both queued Tasks in the queue's order, the valve from heavy.json
      const mem = read(() => "memory");
      expect(mem.taskWaits).toEqual([
        { taskId: "t_first", taskTitle: "一つ目", queuedAt: new Date(t0).toISOString(), reason: "memory" },
        { taskId: "t_second", taskTitle: "二つ目", queuedAt: new Date(t0 + 1000).toISOString(), reason: "memory" },
      ]);
      expect(mem.memory!.safetyBytes).toBe(250 * 1024 * 1024);
      // (b) a slot wait, null or no function: none
      for (const w of [() => "slot" as const, () => null, undefined]) expect(read(w).taskWaits).toEqual([]);
      // (c) slots and eta are the same with and without the Task waits
      const { taskWaits: _a, ...withWaits } = mem;
      const { taskWaits: _b, ...without } = read(() => "slot");
      expect(withWaits).toEqual(without);
      // no taskMinFreeMb in the file: the default valve
      writeFileSync(join(h, ".config", "ops-kit", "heavy.json"), JSON.stringify({ max: 2 }));
      expect(read().memory!.safetyBytes).toBe(TASK_MIN_FREE_MB_DEFAULT * 1024 * 1024);
    } finally {
      db.sqlite.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("taskWaits with a TaskManager held back by the safety valve: the second Task shows, and is gone once the memory is back and drain() has started it", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-taskwaits-tm-"));
    const db = new Db(join(h, "x.db"));
    const MB = 1048576;
    let headroom: { free: number; floor: number; safety: number } = { free: 100 * MB, floor: 500 * MB, safety: 200 * MB };
    const tm = new TaskManager(db, new Map([["claude", fakeAdapter(SCRIPT, { lingers: true })]]), () => undefined, { maxRunners: () => 8, memoryHeadroom: () => headroom });
    try {
      const input = (title: string) => ({ cwd: h, title, prompt: title, runner: "claude" as const });
      const read = () => opsResources(db, { home: h, queueWait: () => tm.queueWait() }).taskWaits;
      expect(tm.queueWait()).toBeNull(); // nothing queued: the memory is not read
      tm.create(input("t1"));
      expect(read()).toEqual([]); // the first Task is not held for memory
      const t2 = tm.create(input("t2"));
      expect(tm.queueWait()).toBe("memory");
      expect(read().map((w) => `${w.taskId}/${w.taskTitle}/${w.reason}`)).toEqual([`${t2.id}/t2/memory`]);
      headroom = { free: 300 * MB, floor: 500 * MB, safety: 200 * MB };
      tm.drain();
      expect(tm.queueWait()).toBeNull();
      expect(read()).toEqual([]);
    } finally {
      await tm.shutdown();
      db.sqlite.close();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops load", () => {
  test("GET /api/ops/load: JST hours with peaks and limit hits (a unit created again restarts the count), task × kind largest first, ?task= narrows; days is an integer 1..90", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-load-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the daemon's own first sample (on a Linux host) is not part of this test
      c.db.sqlite.run("DELETE FROM ops_load");
      c.db.sqlite.run("DELETE FROM ops_load_groups");
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
      const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00+09:00`);
      const row = (ts: number, mem: number, ev: number) =>
        c.db.sqlite.query("INSERT INTO ops_load (ts, mem_current, mem_max, swap_current, events_max, cpu_pct, pressure_some, pressure_full, docker_mem, top) VALUES (?, ?, 3000, 10, ?, 20, 1, 0.5, 700, '[]')").run(ts, mem, ev);
      row(at("10:00"), 2000, 100);
      row(at("10:01"), 2900, 105);
      row(at("10:59"), 2500, 110);
      row(at("11:00"), 1000, 3); // the unit was created again: its count starts over
      row(at("11:01"), 1100, 4);
      const group = (ts: number, task: string | null, owner: string, kind: string, rss: number, cpu: number) =>
        c.db.sqlite.query("INSERT INTO ops_load_groups (ts, task_id, owner, kind, rss, cpu_ms, procs) VALUES (?, ?, ?, ?, ?, ?, 1)").run(ts, task, owner, kind, rss, cpu);
      group(at("10:00"), "t1", "task", "browser", 500, 100);
      group(at("10:01"), "t1", "task", "browser", 700, 200);
      group(at("10:01"), "t1", "task", "runner", 300, 50);
      group(at("10:01"), null, "daemon", "judge", 100, 10);
      group(at("11:00"), "t2", "task", "runner", 900, 5);
      const body = OpsLoad.parse(await fetch(`${b}/api/ops/load?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.hours).toEqual([
        { hour: `${day} 10`, maxMem: 2900, memMax: 3000, maxSwap: 10, limitHits: 10, maxCpuPct: 20, maxPressureFull: 0.5, maxDockerMem: 700 },
        { hour: `${day} 11`, maxMem: 1100, memMax: 3000, maxSwap: 10, limitHits: 4, maxCpuPct: 20, maxPressureFull: 0.5, maxDockerMem: 700 },
      ]);
      expect(body.groups).toEqual([
        { taskId: "t2", owner: "task", kind: "runner", maxRss: 900, cpuMs: 5 },
        { taskId: "t1", owner: "task", kind: "browser", maxRss: 700, cpuMs: 300 },
        { taskId: "t1", owner: "task", kind: "runner", maxRss: 300, cpuMs: 50 },
        { taskId: null, owner: "daemon", kind: "judge", maxRss: 100, cpuMs: 10 },
      ]);
      const one = OpsLoad.parse(await fetch(`${b}/api/ops/load?days=7&task=t1`).then(j));
      expect(one.hours).toEqual([]);
      expect(one.groups.map((g) => `${g.taskId}/${g.kind}`)).toEqual(["t1/browser", "t1/runner"]);
      for (const q of ["?days=0", "?days=91", "?days=abc", "?days=1.5"]) expect((await fetch(`${b}/api/ops/load${q}`)).status).toBe(400);
      expect((await fetch(`${b}/api/ops/load`)).status).toBe(200); // absent = 7
      // the resources screen's route answers in its shape (what it reads is "ops resources" below)
      OpsResources.parse(await fetch(`${b}/api/ops/resources`).then(j));
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
