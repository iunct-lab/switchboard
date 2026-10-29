import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AskBatch, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { approvalWindowNote } from "./approval-batch.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Scheduler } from "./scheduler.ts";
import { scanAllRepos } from "./secretscan.ts";
import { scanFindings } from "./asks.ts";
import { startServer } from "./server.ts";
import { TaskManager } from "./tasks.ts";

/** A runner that finishes instantly with a scripted status, so a schedule's "previous run" can be controlled. */
const started: StartOptions[] = [];
function fakeAdapter(script: AgentEvent[]): RunnerAdapter {
  return {
    id: "claude",
    efforts: [{ value: "low", label: "low" }, { value: "high", label: "high" }],
    async detect() {
      return { available: true };
    },
    start(opts: StartOptions, emit) {
      started.push(opts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => {
        for (const ev of script) emit(ev);
        resolveExit(0);
      });
      const session: RunnerSession = {
        send: () => undefined,
        respondPermission: () => undefined,
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      };
      return session;
    },
  };
}

let home: string;
let db: Db;
let tasks: TaskManager;
let broadcasts: unknown[];
let wsId: string;
let now: number;

beforeEach(() => {
  started.length = 0;
  home = mkdtempSync(join(tmpdir(), "sb-scheduler-"));
  db = new Db(join(home, "db.sqlite"));
  broadcasts = [];
  tasks = new TaskManager(db, new Map([["claude", fakeAdapter([{ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: home }, { t: "session.end", status: "ok" }])]]), (m) => broadcasts.push(m), { idleMs: 0 });
  wsId = db.upsertWorkspace({ name: "w", path: home, kind: "repo" }).id;
  now = Date.parse("2026-09-06T00:00:00");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("scheduler (#20)", () => {
  test("create validates the cron and workspace, computes nextRunAt", () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(s.nextRunAt).toBe(Date.parse("2026-09-06T03:00:00"));
    expect(() => sc.create({ title: "x", cron: "bad", workspaceId: wsId, runner: "claude", prompt: "p" })).toThrow();
    expect(() => sc.create({ title: "x", cron: "@nightly", workspaceId: "nope", runner: "claude", prompt: "p" })).toThrow(/workspace/);
  });

  test("tick fires due schedules exactly once, advances nextRunAt, and skips a schedule whose previous run is still active", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    now = Date.parse("2026-09-06T02:00:00");
    expect((await sc.tick())).toHaveLength(0); // not due yet
    now = Date.parse("2026-09-06T03:00:00");
    const started = await sc.tick();
    expect(started).toHaveLength(1);
    expect(started[0]!.scheduleId).toBe(s.id);
    expect(db.getSchedule(s.id)!.nextRunAt).toBe(Date.parse("2026-09-07T03:00:00"));
    expect(db.getSchedule(s.id)!.lastTaskId).toBe(started[0]!.id);
    // manually mark it still running to simulate an overlapping firing
    db.updateTask(started[0]!.id, { status: "running" });
    now = Date.parse("2026-09-07T03:00:00");
    expect((await sc.tick())).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("skipped");
    expect(db.getSchedule(s.id)!.nextRunAt).toBe(Date.parse("2026-09-08T03:00:00")); // still advances so it isn't stuck
  });

  test("disabled schedules never fire; runNow works regardless of enabled and records the log", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "off", cron: "* * * * *", workspaceId: wsId, runner: "claude", prompt: "p", enabled: false });
    now += 120_000;
    expect((await sc.tick())).toHaveLength(0);
    const task = await sc.runNow(s.id, "manual");
    expect(task).not.toBeNull();
    expect(sc.recentLog().at(-1)).toContain("started");
    await expect(sc.runNow("nope")).rejects.toThrow(/not found/);
  });

  test("a schedule's model starts its task on that model; empty is the CLI default; PATCH changes it (model)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "m", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", model: "m1", prompt: "p" });
    expect(s.model).toBe("m1");
    expect(db.getTask((await sc.runNow(s.id))!.id)!.model).toBe("m1");
    expect(started.at(-1)!.model).toBe("m1");
    const none = sc.create({ title: "n", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(none.model).toBe("");
    expect(db.getTask((await sc.runNow(none.id))!.id)!.model).toBeNull();
    expect(started.at(-1)!.model).toBeUndefined();
    expect(sc.update(s.id, { model: "m2" }).model).toBe("m2");
    expect(db.getSchedule(s.id)!.model).toBe("m2");
    expect(sc.update(s.id, { model: "" }).model).toBe("");
  });

  test("a schedule's effort starts its task with it; empty is the CLI default; one the runner does not list is refused (schedule effort, #833)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "e", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", effort: "high", prompt: "p" });
    expect(s.effort).toBe("high");
    expect(db.getTask((await sc.runNow(s.id))!.id)!.effort).toBe("high");
    expect(started.at(-1)!.effort).toBe("high");
    const none = sc.create({ title: "n", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(none.effort).toBe("");
    expect(db.getTask((await sc.runNow(none.id))!.id)!.effort).toBeNull();
    expect(started.at(-1)!.effort).toBeUndefined();
    expect(() => sc.create({ title: "x", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", effort: "max", prompt: "p" })).toThrow('unknown effort "max"');
    expect(sc.update(s.id, { effort: "low" }).effort).toBe("low");
    expect(() => sc.update(s.id, { effort: "max" })).toThrow('unknown effort "max"');
    expect(db.getSchedule(s.id)!.effort).toBe("low"); // the refused update saved nothing
    db.updateSchedule(s.id, { effort: "ultra" }); // kept from a version whose list had it
    expect(sc.update(s.id, { enabled: false }).enabled).toBe(false); // a kept effort does not block another change
    expect(sc.update(s.id, { runner: "codex" }).effort).toBe(""); // another runner's list: back to the CLI default
  });

  test("a database from before schedules had an effort reads its rows with an empty one (schedule effort)", () => {
    const p = join(home, "old-effort.sqlite");
    const raw = new (require("bun:sqlite").Database)(p);
    raw.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL, budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'prompt', model TEXT NOT NULL DEFAULT '');
      INSERT INTO schedules (id, title, cron, workspace_id, runner, prompt, created_at) VALUES ('sch_old', 'old', '0 3 * * *', 'w', 'codex', 'p', 1);`);
    raw.close();
    const old = new Db(p);
    expect(old.getSchedule("sch_old")).toMatchObject({ runner: "codex", effort: "" });
    old.close();
  });

  test("a database from before schedules had a model reads its rows with an empty one (model)", () => {
    const p = join(home, "old.sqlite");
    const raw = new (require("bun:sqlite").Database)(p);
    raw.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL, budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'prompt');
      INSERT INTO schedules (id, title, cron, workspace_id, runner, prompt, created_at) VALUES ('sch_old', 'old', '0 3 * * *', 'w', 'codex', 'p', 1);`);
    raw.close();
    const old = new Db(p);
    expect(old.getSchedule("sch_old")).toMatchObject({ runner: "codex", model: "" });
    old.close();
  });

  test("update changes cron/runner/prompt and recomputes nextRunAt; delete removes it", () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "t", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    const updated = sc.update(s.id, { cron: "0 9 * * *" });
    expect(updated.nextRunAt).toBe(Date.parse("2026-09-06T09:00:00"));
    sc.remove(s.id);
    expect(db.getSchedule(s.id)).toBeNull();
  });

  test("create/update/runNow reject a workspace whose directory no longer exists on disk", async () => {
    const gone = mkdtempSync(join(tmpdir(), "sb-scheduler-gone-"));
    const goneWsId = db.upsertWorkspace({ name: "gone", path: gone, kind: "repo" }).id;
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "t", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    rmSync(gone, { recursive: true, force: true });
    // create() against an already-deleted workspace
    expect(() => sc.create({ title: "x", cron: "0 3 * * *", workspaceId: goneWsId, runner: "claude", prompt: "p" })).toThrow(/directory does not exist/);
    // update() re-pointing an existing schedule at a deleted workspace
    expect(() => sc.update(s.id, { workspaceId: goneWsId })).toThrow(/directory does not exist/);
    // a schedule whose workspace directory is deleted after the schedule was created — bypass sc.update()'s own
    // validation via a direct db write, since that's exactly the scenario the checks in create/update can't catch
    // (the directory existed at schedule-creation time and was removed later, out from under it).
    sc.remove(s.id); // otherwise it would also be due at the tick() below and confuse the assertion
    const s2 = sc.create({ title: "y", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    db.updateSchedule(s2.id, { workspaceId: goneWsId });
    await expect(sc.runNow(s2.id, "manual")).rejects.toThrow(/no longer exists on disk/);
    // tick() catches this the same way a bad workspace or missing adapter fails: logged, nextRunAt still advances
    now = Date.parse("2026-09-06T03:00:00");
    expect((await sc.tick())).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("failed to start");
    expect(db.getSchedule(s2.id)!.nextRunAt).toBe(Date.parse("2026-09-07T03:00:00"));
  });

  test("queue() surfaces waiting tasks, staged writes, and scheduled task history with cost", async () => {
    const t = tasks.create({ workspaceId: wsId, cwd: home, title: "manual", prompt: "p", runner: "claude" });
    db.appendEvent(t.id, { t: "permission.ask", id: "ask1", kind: "write", tool: "Write", input: {}, detail: "write x.txt" });
    for (const path of ["a.txt", "b.txt"]) {
      db.insertStaged({ id: `stg-${path}`, taskId: t.id, path, rel: path, kind: "write", before: null, after: "x", status: "pending", ts: now, decidedAt: null, diff: "", stat: "+1" });
    }
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    const started = (await sc.runNow(s.id, "manual"))!;
    // after the await: the fake runner ends `t` on a microtask, which would overwrite an earlier "waiting"
    // written straight to the row: done → waiting is not a transition (task-status.ts), the queue only reads the status
    db.sqlite.query("UPDATE tasks SET status = 'waiting' WHERE id = ?").run(t.id);
    db.insertLedger({ taskId: started.id, runner: "claude", model: "m", inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0.5, billedUsd: 0, source: "reported", ts: now });
    const q = sc.queue();
    expect(q.waiting).toEqual([{ taskId: t.id, title: "manual", runner: "claude", ask: "write x.txt", since: expect.any(Number) }]);
    expect(q.staged).toEqual([{ taskId: t.id, title: "manual", pending: 2 }]);
    expect(q.scheduled).toHaveLength(1);
    expect(q.scheduled[0]).toMatchObject({ taskId: started.id, scheduleTitle: "nightly", costUsd: 0.5 });
  });
});

describe("scheduler backlog-next (#267)", () => {
  let repoId: string;
  beforeEach(() => {
    // backlog-next works on the meta workspace's backlog only
    repoId = wsId;
    mkdirSync(join(home, "meta"));
    wsId = db.upsertWorkspace({ name: "m", path: join(home, "meta"), kind: "meta" }).id;
  });

  test("backlog-next is refused on a workspace other than meta, on create and on update", () => {
    const sc = new Scheduler(db, tasks, () => now);
    expect(() => sc.create({ title: "b", cron: "0 3 * * *", workspaceId: repoId, runner: "claude", prompt: "", action: "backlog-next" })).toThrow(/meta workspace only/);
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    expect(() => sc.update(s.id, { workspaceId: repoId })).toThrow(/meta workspace only/);
  });

  test("a tick while the previous one is still firing does nothing (a backlog-next firing can outlast the interval)", async () => {
    let release!: () => void;
    let calls = 0;
    const t = tasks.create({ workspaceId: wsId, cwd: home, title: "#1 実装: x", prompt: "p", runner: "claude" });
    const sc = new Scheduler(db, tasks, () => now, () => (calls++, new Promise((r) => (release = () => r({ started: [{ task: t, label: "#1 を complete" }], skipped: [] })))));
    sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    now = Date.parse("2026-09-06T03:00:00");
    const first = sc.tick();
    expect(await sc.tick()).toEqual([]);
    expect(calls).toBe(1);
    // the second tick did not even reach the schedule (no "still picking" skip was logged)
    expect(sc.recentLog().some((l) => l.includes("前の発火がまだ項目を選んでいる"))).toBe(false);
    release();
    expect((await first).map((x) => x.id)).toEqual([t.id]);
  });

  test("runUnblocked (#1879): one asked while another workspace's run is under way is kept and run after it; one asked during a full firing too", async () => {
    let release!: () => void;
    const calls: Array<{ workspaceId: string; numbers: number[] } | undefined> = [];
    let hold = true;
    const sc = new Scheduler(db, tasks, () => now, (_id, only) => (calls.push(only), hold ? new Promise((r) => (release = () => r({ started: [], skipped: [] }))) : Promise.resolve({ started: [], skipped: [] })));
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    const first = sc.runUnblocked(s.id, "ws_a", [1]);
    expect(await sc.runUnblocked(s.id, "ws_b", [2])).toBeNull();
    expect(await sc.runUnblocked(s.id, "ws_b", [3])).toBeNull();
    // the firing's own read coming back with what it reads is not kept again
    expect(await sc.runUnblocked(s.id, "ws_a", [1])).toBeNull();
    expect(calls).toEqual([{ workspaceId: "ws_a", numbers: [1] }]);
    hold = false;
    release();
    await first;
    await Bun.sleep(0);
    expect(calls).toEqual([{ workspaceId: "ws_a", numbers: [1] }, { workspaceId: "ws_b", numbers: [2, 3] }]);
    // one of those kept failing does not drop the ones after it
    calls.length = 0;
    hold = true;
    const sc2 = new Scheduler(db, tasks, () => now, (_id, only) => (calls.push(only), hold ? new Promise((r) => (release = () => r({ started: [], skipped: [] }))) : only?.workspaceId === "ws_b" ? Promise.reject(new Error("boom")) : Promise.resolve({ started: [], skipped: [] })));
    const again = sc2.runUnblocked(s.id, "ws_a", [1]);
    await sc2.runUnblocked(s.id, "ws_b", [2]);
    await sc2.runUnblocked(s.id, "ws_c", [3]);
    hold = false;
    release();
    await again;
    await Bun.sleep(0);
    expect(calls.map((c) => c?.workspaceId)).toEqual(["ws_a", "ws_b", "ws_c"]);
    expect(sc2.recentLog()).toContainEqual(expect.stringContaining("始められない (待ちが解けた): boom"));
    // a full firing read each workspace once, maybe before the wait cleared: what is asked meanwhile is run after it
    calls.length = 0;
    const full = sc.runNow(s.id, "manual");
    expect(await sc.runUnblocked(s.id, "ws_b", [2])).toBeNull();
    await full;
    await Bun.sleep(0);
    expect(calls).toEqual([undefined, { workspaceId: "ws_b", numbers: [2] }]);
  });

  test("runUnblocked (#1879): a due firing during a narrow one waits for it and runs, and what was kept is left to it", async () => {
    let release!: () => void;
    const calls: Array<{ workspaceId: string; numbers: number[] } | undefined> = [];
    let hold = true;
    const sc = new Scheduler(db, tasks, () => now, (_id, only) => (calls.push(only), hold ? new Promise((r) => (release = () => r({ started: [], skipped: [] }))) : Promise.resolve({ started: [], skipped: [] })));
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    const narrow = sc.runUnblocked(s.id, "ws_a", [1]);
    await sc.runUnblocked(s.id, "ws_b", [2]);
    const due = sc.runNow(s.id, "due");
    hold = false;
    release();
    await narrow;
    await due;
    await Bun.sleep(0);
    expect(calls).toEqual([{ workspaceId: "ws_a", numbers: [1] }, undefined]);
    expect(sc.recentLog().some((l) => l.includes("前の発火がまだ項目を選んでいる"))).toBe(false);
    expect(db.getSchedule(s.id)!.lastRunAt).toBe(now);
  });

  test("a prompt schedule needs a prompt; a backlog-next one does not", () => {
    const sc = new Scheduler(db, tasks, () => now);
    expect(() => sc.create({ title: "x", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: " " })).toThrow(/prompt is required/);
    const s = sc.create({ title: "b", cron: "0 */3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    expect(db.getSchedule(s.id)!.action).toBe("backlog-next");
    expect(() => sc.update(s.id, { action: "prompt" })).toThrow(/prompt is required/);
  });

  test("a firing asks startNext and logs what it started, recording the task as the schedule's last run", async () => {
    const t = tasks.create({ workspaceId: wsId, cwd: home, title: "#304 実装: x", prompt: "p", runner: "claude" });
    const calls: string[] = [];
    const sc = new Scheduler(db, tasks, () => now, async (id) => (calls.push(id), { started: [{ task: t, label: "#304 を complete" }], skipped: [] }));
    const s = sc.create({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    expect((await sc.runNow(s.id, "manual"))!.id).toBe(t.id);
    expect(calls).toEqual([s.id]);
    expect(db.getSchedule(s.id)!.lastTaskId).toBe(t.id);
    expect(sc.recentLog().at(-1)).toContain("バックログを進める: #304 を complete で開始");
  });

  test("a skipped firing logs the reason and still advances nextRunAt", async () => {
    const sc = new Scheduler(db, tasks, () => now, async () => ({ started: [], skipped: ["Claude の使用量 five_hour が 85%（80% 以上）"] }));
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    now = Date.parse("2026-09-06T03:00:00");
    expect(await sc.tick()).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("飛ばした (due): Claude の使用量 five_hour が 85%");
    expect(db.getSchedule(s.id)!.nextRunAt).toBe(Date.parse("2026-09-07T03:00:00"));
  });

  test("backlog-next parallel: every started Task and every skip is a log line; its last Task still running does not hold the next firing (#561)", async () => {
    const started = [1, 2, 3, 4, 5, 6].map((n) => ({ task: tasks.create({ workspaceId: wsId, cwd: home, title: `#${n} 実装: x`, prompt: "p", runner: "claude" }), label: `ws${n} #${n} を complete` }));
    let calls = 0;
    const sc = new Scheduler(db, tasks, () => now, async () => (calls++, { started, skipped: ["lib: GitHub を読めない: HTTP 404"] }));
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    expect((await sc.runNow(s.id, "manual"))!.id).toBe(started[5]!.task.id);
    expect(db.getSchedule(s.id)!.lastTaskId).toBe(started[5]!.task.id);
    const log = sc.recentLog();
    expect(log.filter((l) => / で開始 task_/.test(l))).toHaveLength(6);
    for (const x of started) expect(log.some((l) => l.includes(`b: ${x.label} で開始 ${x.task.id} (manual)`))).toBe(true);
    expect(log.at(-1)).toContain("b: 飛ばした (manual): lib: GitHub を読めない: HTTP 404");
    // the last Task is running (a prompt schedule would skip here); backlog-next asks startNext again
    db.updateTask(started[5]!.task.id, { status: "running" });
    await sc.runNow(s.id, "manual");
    expect(calls).toBe(2);
  });

  test("a second firing while the first is still picking starts nothing", async () => {
    let release!: () => void;
    const t = tasks.create({ workspaceId: wsId, cwd: home, title: "#1 実装: x", prompt: "p", runner: "claude" });
    const sc = new Scheduler(db, tasks, () => now, () => new Promise((r) => (release = () => r({ started: [{ task: t, label: "#1 を complete" }], skipped: [] }))));
    const s = sc.create({ title: "b", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "backlog-next" });
    const first = sc.runNow(s.id, "manual");
    expect(await sc.runNow(s.id, "manual")).toBeNull();
    expect(sc.recentLog().at(-1)).toContain("前の発火がまだ項目を選んでいる");
    release();
    expect((await first)!.id).toBe(t.id);
  });
});

describe("scheduler secret-scan (#775)", () => {
  let repoId: string;
  beforeEach(() => {
    repoId = wsId;
    mkdirSync(join(home, "meta"));
    wsId = db.upsertWorkspace({ name: "m", path: join(home, "meta"), kind: "meta" }).id;
  });

  const token = ["ghp", "_", "Q".repeat(36)].join("");
  // Each workspace's checkout answers `gh repo view` with its repository; "gone" is a checkout gh cannot read
  const repoOfPath: Record<string, string> = {};
  const gh = async (args: string[], cwd: string) => (repoOfPath[cwd] ? { code: 0, stdout: `${repoOfPath[cwd]} true\n`, stderr: "" } : { code: 1, stdout: "", stderr: `not a git repository ${token}` });
  // scan-issues as the kit prints it, per repository: o/clean has nothing, o/leak has two hits, o/down cannot be read
  const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
    "o/clean": { code: 0, stdout: "hits: 0 / scanned: 12\n", stderr: "" },
    "o/leak": { code: 1, stdout: `https://github.com/o/leak/issues/3: github-token（2 行目）\nhttps://github.com/o/leak/issues/3#issuecomment-9: account-id（1 行目）\nstray ${token}\nhits: 2 / scanned: 40\n`, stderr: "" },
    // whatever a failure prints stays out of the log and the note (it could quote anything)
    "o/down": { code: 2, stdout: "", stderr: `issues の取得に失敗（3 回）: HTTP 502 ${token}` },
    // bun's own exit 1 (the kit's file is missing) is not "hits"
    "o/nokit": { code: 1, stdout: "", stderr: "error: Module not found" },
  };
  const scans: string[][] = [];
  const spawn = async (cmd: string[]) => (scans.push(cmd), answers[cmd.at(-1)!]!);
  const setUp = () => {
    scans.length = 0;
    const add = (name: string, repo: string | null) => {
      const path = join(home, name);
      mkdirSync(path);
      if (repo) repoOfPath[path] = repo;
      db.upsertWorkspace({ name, path, kind: "repo" });
    };
    repoOfPath[home] = "o/clean";
    repoOfPath[join(home, "meta")] = "o/clean";
    add("clean-2", "o/clean"); // a second checkout of the same repository
    add("leak", "o/leak");
    add("down", "o/down");
    add("nokit", "o/nokit");
    add("gone", null);
  };

  test("secret-scan: a firing scans every workspace's repository once and records 0 hits / hits / could not scan apart", async () => {
    setUp();
    const sc = new Scheduler(db, tasks, () => now, undefined, () => scanAllRepos({ workspaces: db.listWorkspaces(), metaPath: join(home, "meta"), gh, spawn }));
    const s = sc.create({ title: "検査", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    // the host was stopped through two firings: one firing when it is up again, the next one tomorrow
    now = Date.parse("2026-09-08T09:00:00");
    expect(await sc.tick()).toEqual([]);
    expect(await sc.tick()).toEqual([]);
    expect(scans.map((c) => c.at(-1)).sort()).toEqual(["o/clean", "o/down", "o/leak", "o/nokit"]);
    expect(scans[0]!.slice(1, 3)).toEqual([join(home, "meta", "ops-kit/src/cli.ts"), "scan-issues"]);
    expect(db.getSchedule(s.id)).toMatchObject({ lastRunAt: now, nextRunAt: Date.parse("2026-09-09T04:00:00") });
    // the result stays on the schedule (#1274): counts and the log lines, read back from the database
    const kept = db.getSchedule(s.id)!.lastResult!;
    expect(kept).toMatchObject({ at: now, repos: 4, hits: 2, failed: 3 });
    expect(kept.lines).toContain("o/clean: 0 件（scanned 12）");
    expect(kept.lines).toContain("o/leak: 当たり 2 件（scanned 40）");
    expect(kept.lines.join("\n")).not.toContain(token);
    const fresh = new Db(join(home, "db.sqlite")); // not memory: a fresh handle on the same file reads it
    expect(fresh.getSchedule(s.id)!.lastResult).toEqual(kept);
    fresh.close();
    const log = sc.recentLog().join("\n");
    expect(log).toContain("検査: o/clean: 0 件（scanned 12） (due)");
    expect(log).toContain("検査: o/leak: 当たり 2 件（scanned 40） (due)");
    expect(log).toContain("検査: o/down: 検査できなかった（exit 2） (due)");
    expect(log).toContain("検査: o/nokit: 検査できなかった（exit 1） (due)");
    expect(log).toContain("検査: gone: 検査できなかった（リポジトリを特定できない） (due)");
    expect(log).not.toContain(token);
    // no Task and no runner
    expect(started).toHaveLength(0);
    expect(db.listTasksByStatus("running")).toHaveLength(0);
  });

  test("secret-scan: the second firing reads from the first one's time, keeps it across a restart, and a failed repository keeps its old time", async () => {
    setUp();
    const sc = new Scheduler(db, tasks, () => now, undefined, (_s, cursors) => scanAllRepos({ workspaces: db.listWorkspaces(), metaPath: join(home, "meta"), gh, spawn, cursors, now: () => now }));
    const s = sc.create({ title: "検査", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    now = Date.parse("2026-09-08T04:00:00Z");
    await sc.runNow(s.id, "manual");
    // no cursor yet: every repository read whole
    expect(scans.every((c) => !c.includes("--since"))).toBe(true);
    const first = new Date(now).toISOString();
    expect(db.getSchedule(s.id)!.lastResult!.cursors).toEqual({
      "o/clean": { since: first, hits: [] },
      "o/leak": { since: first, hits: ["https://github.com/o/leak/issues/3", "https://github.com/o/leak/issues/3#issuecomment-9"] },
    });
    // a restart: a new scheduler on the same database; o/clean cannot be read this time
    scans.length = 0;
    const clean = answers["o/clean"]!;
    answers["o/clean"] = { code: 2, stdout: "", stderr: "HTTP 502" };
    now = Date.parse("2026-09-09T04:00:00Z");
    const again = new Scheduler(db, tasks, () => now, undefined, (_s, cursors) => scanAllRepos({ workspaces: db.listWorkspaces(), metaPath: join(home, "meta"), gh, spawn, cursors, now: () => now }));
    await again.runNow(s.id, "manual");
    answers["o/clean"] = clean;
    const leak = scans.find((c) => c.at(-1) === "o/leak")!;
    expect(leak.slice(3)).toEqual(["--since", first, "--recheck", "https://github.com/o/leak/issues/3", "--recheck", "https://github.com/o/leak/issues/3#issuecomment-9", "o/leak"]);
    expect(scans.find((c) => c.at(-1) === "o/down")!.slice(3)).toEqual(["o/down"]);
    expect(db.getSchedule(s.id)!.lastResult!.cursors).toEqual({
      "o/clean": { since: first, hits: [] },
      "o/leak": { since: new Date(now).toISOString(), hits: ["https://github.com/o/leak/issues/3", "https://github.com/o/leak/issues/3#issuecomment-9"] },
    });
    // a workspace whose repository cannot be identified this time keeps that repository's cursor
    const leakPath = join(home, "leak");
    delete repoOfPath[leakPath];
    await again.runNow(s.id, "manual");
    repoOfPath[leakPath] = "o/leak";
    expect(db.getSchedule(s.id)!.lastResult!.cursors!["o/leak"]!.since).toBe(new Date(now).toISOString());
    expect(scans.filter((c) => c.at(-1) === "o/leak")).toHaveLength(1);
    // a scan that throws keeps the cursors as they were
    const kept = db.getSchedule(s.id)!.lastResult!.cursors;
    const broken = new Scheduler(db, tasks, () => now, undefined, async () => { throw new Error("x"); });
    await broken.runNow(s.id, "manual");
    expect(db.getSchedule(s.id)!.lastResult!.cursors).toEqual(kept);
  });

  test("secret-scan: a scan that throws leaves a failed result with the reason, and the schedule still moves to the next day (#1274)", async () => {
    setUp();
    const sc = new Scheduler(db, tasks, () => now, undefined, async () => { throw new Error(`gh is not logged in ${token}`); });
    const s = sc.create({ title: "検査", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    now = Date.parse("2026-09-08T09:00:00");
    expect(await sc.tick()).toEqual([]);
    const kept = db.getSchedule(s.id)!;
    expect(kept).toMatchObject({ lastRunAt: now, nextRunAt: Date.parse("2026-09-09T04:00:00") });
    // the error's name only — its message could quote a value (docs/design/secret-guard.md): not in the result, not in the log
    expect(kept.lastResult).toEqual({ at: now, repos: 0, hits: 0, failed: 1, lines: ["検査が失敗した（Error。理由は scan_issues.sh を手で走らせて見る）"] });
    expect(sc.recentLog().at(-1)).toContain("検査: 検査が失敗した（Error。");
    expect(sc.recentLog().join("\n")).not.toContain(token);
    // a clean firing after it replaces the failed result; a prompt schedule never gets one
    const ok = new Scheduler(db, tasks, () => now, undefined, async () => ({ lines: ["o/clean: 0 件（scanned 12）"], summary: { repos: 1, hits: 0, failed: 0 } }));
    now = Date.parse("2026-09-09T04:00:30");
    expect(await ok.tick()).toEqual([]);
    expect(db.getSchedule(s.id)!.lastResult).toEqual({ at: now, repos: 1, hits: 0, failed: 0, lines: ["o/clean: 0 件（scanned 12）"] });
    const prompt = ok.create({ title: "p", cron: "0 5 * * *", workspaceId: wsId, runner: "claude", prompt: "hello" });
    expect(prompt.lastResult).toBeNull();
    ok.update(prompt.id, { enabled: false }); // due at 05:00 below otherwise
    // turned into another action, the schedule drops the scan's result (the other actions never carry one)
    expect(ok.update(s.id, { action: "prompt", prompt: "hello" }).lastResult).toBeNull();
    expect(db.getSchedule(s.id)!.lastResult).toBeNull();
    ok.update(s.id, { enabled: false }); // the prompt schedule would otherwise fire a Task at the next 04:00 below
    // turned into another action while a scan runs: the finishing scan writes no result onto the prompt schedule either
    const s2 = ok.create({ title: "検査 2", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    const racing = new Scheduler(db, tasks, () => now, undefined, async () => {
      racing.update(s2.id, { action: "prompt", prompt: "hello", enabled: false }); // disabled too: a due prompt schedule would fire a Task in this very tick
      return { lines: ["o/clean: 0 件（scanned 12）"], summary: { repos: 1, hits: 0, failed: 0 } };
    });
    now = Date.parse("2026-09-10T04:00:30");
    expect(await racing.tick()).toEqual([]);
    expect(db.getSchedule(s2.id)).toMatchObject({ action: "prompt", lastResult: null, lastRunAt: now });
  });

  test("a database from before schedules kept a result reads its rows with none (lastResult, #1274)", () => {
    const p = join(home, "old-result.sqlite");
    const raw = new (require("bun:sqlite").Database)(p);
    raw.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL, budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'prompt', model TEXT NOT NULL DEFAULT '');
      INSERT INTO schedules (id, title, cron, workspace_id, runner, prompt, action, created_at) VALUES ('sch_old', 'old', '0 3 * * *', 'w', 'claude', '', 'secret-scan', 1);`);
    raw.close();
    const old = new Db(p);
    expect(old.getSchedule("sch_old")).toMatchObject({ action: "secret-scan", lastResult: null });
    const result = { at: 2, repos: 1, hits: 0, failed: 0, lines: ["o/x: 0 件（scanned 1）"] };
    expect(old.updateSchedule("sch_old", { lastResult: result })!.lastResult).toEqual(result);
    expect(old.getSchedule("sch_old")!.lastResult).toEqual(result);
    old.close();
  });

  test("secret-scan: hits and failures are in the lines, places and kinds only", async () => {
    setUp();
    const r = await scanAllRepos({ workspaces: db.listWorkspaces(), metaPath: join(home, "meta"), gh, spawn });
    expect(r.lines).toContain("  https://github.com/o/leak/issues/3: github-token（2 行目）");
    expect(r.lines).toContain("  https://github.com/o/leak/issues/3#issuecomment-9: account-id（1 行目）");
    expect(r.lines).toContain("o/down: 検査できなかった（exit 2）");
    // what 判断待ち's notice reads from them (#2866)
    const f = scanFindings({ at: 0, ...r.summary, lines: r.lines });
    expect(f.hits).toHaveLength(2);
    expect(f.failed).toHaveLength(3);
    // of scan-issues' output only the hit lines are kept: a stray line with a value does not reach the log
    expect(r.lines.join("\n")).not.toContain(token);
    // a day with nothing found: the log only
    const clean = await scanAllRepos({ workspaces: [{ name: "w", path: home }], metaPath: join(home, "meta"), gh, spawn });
    expect(clean).toEqual({ lines: ["o/clean: 0 件（scanned 12）"], summary: { repos: 1, hits: 0, failed: 0 }, cursors: { "o/clean": { since: expect.any(String), hits: [] } } });
    expect(scanFindings({ at: 0, ...clean.summary, lines: clean.lines }).fingerprint).toBe("");
    expect(r.summary).toEqual({ repos: 4, hits: 2, failed: 3 });
  });

  test("secret-scan: a firing that ends after the next due time does not fire again the same day", async () => {
    setUp();
    // overdue since yesterday's 04:00, the host up at 03:59: the scan ends at 04:08
    const sc = new Scheduler(db, tasks, () => now, undefined, async () => {
      now = Date.parse("2026-09-08T04:08:00");
      return { lines: ["o/clean: 0 件（scanned 12）"], summary: { repos: 1, hits: 0, failed: 0 } };
    });
    const s = sc.create({ title: "検査", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    now = Date.parse("2026-09-08T03:59:00");
    await sc.tick();
    expect(db.getSchedule(s.id)!.nextRunAt).toBe(Date.parse("2026-09-09T04:00:00"));
  });

  test("secret-scan: refused on a non-meta workspace", () => {
    const sc = new Scheduler(db, tasks, () => now);
    expect(() => sc.create({ title: "x", cron: "0 4 * * *", workspaceId: repoId, runner: "claude", prompt: "", action: "secret-scan" })).toThrow(/secret-scan runs on the meta workspace only/);
    const s = sc.create({ title: "x", cron: "0 4 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "secret-scan" });
    expect(() => sc.update(s.id, { workspaceId: repoId })).toThrow(/meta workspace only/);
  });

  test("secret-scan: POST /api/schedules/:id/run answers 202 at once; the lines reach the log and a hit is a notice in 判断待ち until dismissed", async () => {
    // the meta checkout's kit, faked: scan-issues prints one hit, after a while (a real scan takes minutes)
    const meta = join(home, "meta");
    mkdirSync(join(meta, "ops-kit/src"), { recursive: true });
    writeFileSync(join(meta, "ops-kit/src/cli.ts"), `await Bun.sleep(300); console.log("https://github.com/acme/app/issues/9: device-code（1 行目）\\nhits: 1 / scanned: 7"); process.exit(1);\n`);
    const gh = async () => ({ code: 0, stdout: "acme/app true\n", stderr: "" });
    const cfg = loadConfig({ SWITCHBOARD_HOME: join(home, "daemon"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: meta });
    const core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
    try {
      const base = `http://127.0.0.1:${core.server.port}`;
      const metaId = core.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
      const s = (await (await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "検査", cron: "0 4 * * *", workspaceId: metaId, runner: "claude", prompt: "", action: "secret-scan" }) })).json()) as { id: string };
      const r = await fetch(`${base}/api/schedules/${s.id}/run`, { method: "POST" });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ scanning: true });
      const log = async () => (await (await fetch(`${base}/api/schedules/log`)).json()) as string[];
      for (const t0 = Date.now(); !(await log()).some((l) => l.includes("acme/app: 当たり")) && Date.now() - t0 < 20_000; ) await Bun.sleep(25);
      expect(await log()).toContainEqual(expect.stringContaining("検査: acme/app: 当たり 1 件（scanned 7） (manual)"));
      // no Inbox note (#2866): the notice is in 判断待ち
      expect(await (await fetch(`${base}/api/inbox`)).json()).toEqual([]);
      const notices = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; kind: string; state: string; question: string; reason: string; source: { label: string }; answers: string[] }> }).asks.filter((a) => a.kind === "notice");
      const [n] = await notices();
      expect(n).toMatchObject({ state: "open", question: "認証の値の検査: 当たり 1 件 / 検査できなかった 0 リポジトリ", reason: "https://github.com/acme/app/issues/9: device-code（1 行目）", source: { label: "予定「検査」" }, answers: ["dismiss"] });
      const answer = (body: object) => fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify(body) });
      // only dismiss answers it
      expect((await answer({ id: n!.id, answer: { kind: "text", text: "x" } })).status).toBe(422);
      // a disabled schedule's findings stay: only a clean result resolves them
      expect((await fetch(`${base}/api/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status).toBe(200);
      expect((await notices()).map((x) => x.state)).toEqual(["open"]);
      expect((await fetch(`${base}/api/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })).status).toBe(200);
      const dismissed = await answer({ id: n!.id, answer: { kind: "dismiss" } });
      expect(dismissed.status).toBe(200);
      // the answer's question is closed, with no button left on it
      expect(((await dismissed.json()) as { ask: { state: string; answers: string[] } }).ask).toMatchObject({ state: "resolved", answers: [] });
      expect(await notices()).toEqual([]);
      // sent again (the reply lost): already written, not a 409
      const again = await answer({ id: n!.id, answer: { kind: "dismiss" } });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ ask: { state: "resolved", answers: [] }, already: true });
      // the same hit on the next firing stays closed
      const hitLines = async () => (await log()).filter((l) => l.includes("acme/app: 当たり")).length;
      expect((await fetch(`${base}/api/schedules/${s.id}/run`, { method: "POST" })).status).toBe(202);
      for (const t0 = Date.now(); (await hitLines()) < 2 && Date.now() - t0 < 20_000; ) await Bun.sleep(25);
      expect(await notices()).toEqual([]);
      // the result is on the schedule (#1274): what the API hands the Schedules screen
      const kept = (await (await fetch(`${base}/api/schedules/${s.id}`)).json()) as { lastResult: { repos: number; hits: number; failed: number; lines: string[] } | null };
      expect(kept.lastResult).toMatchObject({ repos: 1, hits: 1, failed: 0, lines: ["acme/app: 当たり 1 件（scanned 7）", "  https://github.com/acme/app/issues/9: device-code（1 行目）"] });
    } finally {
      core.stop();
    }
  }, 30_000); // a bun subprocess under a loaded full suite: over the 5 s default (docs/design/perf.md "テストの揺れ")
});

describe("scheduler approval-window (#2046)", () => {
  beforeEach(() => {
    mkdirSync(join(home, "meta"));
    wsId = db.upsertWorkspace({ name: "m", path: join(home, "meta"), kind: "meta" }).id;
  });

  test("approval window memo", async () => {
    let batches: AskBatch[] = [
      { id: "batch:sso", kind: "sso", asks: [{ askId: "s1", taskId: "tk_a", title: "A", workspaceId: "ws_1", op: "aws sso login", at: 1 }, { askId: "s2", taskId: "tk_b", title: "B", workspaceId: "ws_2", op: "aws sso login", at: 2 }], loggingIn: null, deviceAuth: null },
      { id: "batch:deploy", kind: "deploy", asks: [{ askId: "s3", taskId: "tk_c", title: "C", workspaceId: null, op: "sam deploy", at: 3 }], loggingIn: null, deviceAuth: null },
    ];
    const notes: { title: string; body: string; schedule: string }[] = [];
    const window = async (s: { id: string }) => {
      const n = approvalWindowNote(batches);
      if (!n) return "待ちなし（メモは書かない）";
      notes.push({ ...n, schedule: s.id });
      return `メモを書いた: ${n.title}`;
    };
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, undefined, window);
    const s = sc.create({ title: "承認待ち", cron: "0 0 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "approval-window" });
    // runs on the meta workspace only
    expect(() => sc.create({ title: "x", cron: "0 0 * * *", workspaceId: db.upsertWorkspace({ name: "r", path: home, kind: "repo" }).id, runner: "claude", prompt: "", action: "approval-window" })).toThrow("meta workspace only");
    now = s.nextRunAt!;
    expect(await sc.tick()).toEqual([]);
    expect(notes).toEqual([{ schedule: s.id, title: "SSO・配備の承認待ち: 3", body: "SSO のログイン待ち（2 件）\n- A — aws sso login\n- B — aws sso login\n\n配備の承認待ち（1 件）\n- C — sam deploy" }]);
    expect(db.getSchedule(s.id)).toMatchObject({ lastRunAt: now, nextRunAt: now + 86_400_000, lastResult: { at: now, failed: 0, lines: ["メモを書いた: SSO・配備の承認待ち: 3"] } });
    expect(sc.recentLog().join("\n")).toContain("承認待ち: メモを書いた: SSO・配備の承認待ち: 3 (due)");
    // a firing while one is still writing is skipped
    let release!: () => void;
    const slow = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, undefined, () => new Promise<string>((r) => (release = () => r("遅いメモ"))));
    const first = slow.runNow(s.id, "manual");
    expect(await slow.runNow(s.id, "manual")).toBeNull();
    expect(slow.recentLog().join("\n")).toContain("承認待ち: 飛ばした (manual): 前の発火がまだ終わっていない");
    release();
    await first;
    expect(slow.recentLog().join("\n")).toContain("承認待ち: 遅いメモ (manual)");
    // nothing waits the next day: no note
    batches = [];
    now += 86_400_000;
    expect(await sc.tick()).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(sc.recentLog().join("\n")).toContain("承認待ち: 待ちなし（メモは書かない） (due)");
    // no Task and no runner
    expect(started).toHaveLength(0);
  });
});
