// test-reads: scripts/ui-layers-metrics.ts scripts/ui-layers-placement.ts scripts/ui-layers-report.ts scripts/ui-layers-requests.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AskBatch, type RunnerAdapter, type RunnerSession, type StartOptions, StopRecord, type Task } from "@switchboard/protocol";
import { approvalWindowNote, securityMergeNote } from "./approval-batch.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Scheduler, UI_LAYERS_PROMPT } from "./scheduler.ts";
import { scanAllRepos } from "./secretscan.ts";
import { noticeAsks, scanFindings } from "./asks.ts";
import { promotionNote, type PromotionHold } from "./backlog.ts";
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

  test("a schedule whose last two Tasks stopped the same way is not fired by the clock; an answer releases it; a manual run still fires (#4496)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    const stopOf = (taskId: string, at: number, over: Record<string, unknown> = {}) =>
      StopRecord.parse({ id: `st-${taskId}`, op: "schedule run", target: "", reason: "input", evidence: "need input", at, ...over, work: { workspaceId: null, issue: null, taskId, scheduleId: s.id } });
    const fire = async (iso: string) => {
      now = Date.parse(iso);
      const out = await sc.tick();
      for (const t of out) db.updateTask(t.id, { status: "done" });
      return out;
    };
    const [t1] = await fire("2026-09-06T03:00:00");
    const [t2] = await fire("2026-09-07T03:00:00");
    db.appendEvent(t1!.id, { t: "stop.record", stop: stopOf(t1!.id, 1) });
    db.appendEvent(t2!.id, { t: "stop.record", stop: stopOf(t2!.id, 2) });
    // (a) the next due time starts nothing, says why, and moves on
    expect(await fire("2026-09-08T03:00:00")).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("飛ばした (due): 同じ理由で 2 回続けて止まっている（input）");
    expect(db.getSchedule(s.id)!.nextRunAt).toBe(Date.parse("2026-09-09T03:00:00"));
    // (c) a person's run now is not held
    const manual = await sc.runNow(s.id, "manual");
    expect(manual && "id" in manual).toBe(true);
    db.updateTask((manual as Task).id, { status: "done" });
    // the manual Task ended without stopping, so the series is no longer stuck; stop it again to test (b)
    db.appendEvent((manual as Task).id, { t: "stop.record", stop: stopOf((manual as Task).id, 3) });
    expect(await fire("2026-09-09T03:00:00")).toHaveLength(0);
    // (b) the person answered: the clock fires again
    db.appendEvent((manual as Task).id, { t: "stop.record", stop: stopOf((manual as Task).id, 4, { answer: { ref: "seq:9", at: 4 } }) });
    expect(await fire("2026-09-10T03:00:00")).toHaveLength(1);
  });

  test("defers at the limit (#2768): a prompt schedule whose runner has no way round the limit is made without starting and logs why", async () => {
    const at = Date.parse("2026-09-06T04:00:00") + 60_000;
    const held = { runner: "claude" as const, deferUntil: at, deferNote: "claude が上限（0.99、04:00 に戻る）のため戻る時刻に開始" };
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, (r) => ({ ...held, runner: r }));
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    now = Date.parse("2026-09-06T03:00:00");
    const ran = await sc.tick();
    const t = ran.find((x) => x.scheduleId === s.id)!;
    expect(t).toMatchObject({ status: "idle", resumeReason: "start", resumeAt: at });
    expect(started).toHaveLength(0);
    expect(db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text === held.deferNote)).toBe(true);
    expect(sc.recentLog().some((l) => l.includes(`nightly: ${held.deferNote}`))).toBe(true);
  });

  test("a schedule without a budget takes the settings' default budget; its own budget is kept", async () => {
    let dflt: number | null = 3;
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, undefined, undefined, () => dflt);
    const plain = sc.create({ title: "plain", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    const own = sc.create({ title: "own", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p", budgetUsd: 1 });
    now = Date.parse("2026-09-06T03:00:00");
    const started = await sc.tick();
    expect(started.find((t) => t.scheduleId === plain.id)!.budgetUsd).toBe(3);
    expect(started.find((t) => t.scheduleId === own.id)!.budgetUsd).toBe(1);
    dflt = null; // no default: no budget, as before
    now = Date.parse("2026-09-07T03:00:00");
    db.updateTask(started[0]!.id, { status: "done" });
    db.updateTask(started[1]!.id, { status: "done" });
    const next = await sc.tick();
    expect(next.find((t) => t.scheduleId === plain.id)!.budgetUsd).toBeNull();
  });

  test("tick skips a schedule whose previous run waits for a run slot, however long since (#1141)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    now = Date.parse("2026-09-06T03:00:00");
    const started = await sc.tick();
    db.updateTask(started[0]!.id, { status: "running" });
    db.updateTask(started[0]!.id, { status: "idle" });
    db.setQueued(started[0]!.id, "p", now);
    now = Date.parse("2026-09-07T03:00:00");
    expect(await sc.tick()).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("is still queued");
    expect(db.getSchedule(s.id)!.lastTaskId).toBe(started[0]!.id);
  });

  test("tick skips a schedule whose previous run waits on background jobs", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "nightly", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    now = Date.parse("2026-09-06T03:00:00");
    const started = await sc.tick();
    db.updateTask(started[0]!.id, { status: "background" });
    now = Date.parse("2026-09-07T03:00:00");
    expect((await sc.tick())).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toContain("is still background");
    expect(db.getSchedule(s.id)!.lastTaskId).toBe(started[0]!.id);
  });

  test("disabled schedules never fire; runNow works regardless of enabled and records the log", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "off", cron: "* * * * *", workspaceId: wsId, runner: "claude", prompt: "p", enabled: false });
    now += 120_000;
    expect((await sc.tick())).toHaveLength(0);
    const task = (await sc.runNow(s.id, "manual")) as Task | null;
    expect(task).not.toBeNull();
    expect(sc.recentLog().at(-1)).toContain("started");
    // a schedule's Task records no candidate and the schedule as its reason (docs/design/process-kernel.md, K1)
    expect(db.getTaskProvenance(task!.id)).toMatchObject({ process: null, processReason: `schedule ${s.id}` });
    await expect(sc.runNow("nope")).rejects.toThrow(/not found/);
  });

  test("a schedule's model starts its task on that model; empty is the CLI default; PATCH changes it (model)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "m", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", model: "m1", prompt: "p" });
    expect(s.model).toBe("m1");
    expect(db.getTask(((await sc.runNow(s.id)) as Task).id)!.model).toBe("m1");
    expect(started.at(-1)!.model).toBe("m1");
    const none = sc.create({ title: "n", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(none.model).toBe("");
    expect(db.getTask(((await sc.runNow(none.id)) as Task).id)!.model).toBeNull();
    expect(started.at(-1)!.model).toBeUndefined();
    expect(sc.update(s.id, { model: "m2" }).model).toBe("m2");
    expect(db.getSchedule(s.id)!.model).toBe("m2");
    expect(sc.update(s.id, { model: "" }).model).toBe("");
  });

  test("a schedule's effort starts its task with it; empty is the CLI default; one the runner does not list is refused (schedule effort, #833)", async () => {
    const sc = new Scheduler(db, tasks, () => now);
    const s = sc.create({ title: "e", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", effort: "high", prompt: "p" });
    expect(s.effort).toBe("high");
    expect(db.getTask(((await sc.runNow(s.id)) as Task).id)!.effort).toBe("high");
    expect(started.at(-1)!.effort).toBe("high");
    const none = sc.create({ title: "n", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(none.effort).toBe("");
    expect(db.getTask(((await sc.runNow(none.id)) as Task).id)!.effort).toBeNull();
    expect(started.at(-1)!.effort).toBeUndefined();
    expect(() => sc.create({ title: "x", cron: "0 3 * * *", workspaceId: wsId, runner: "claude", effort: "max", prompt: "p" })).toThrow('unknown effort "max"');
    expect(sc.update(s.id, { effort: "low" }).effort).toBe("low");
    expect(() => sc.update(s.id, { effort: "max" })).toThrow('unknown effort "max"');
    expect(db.getSchedule(s.id)!.effort).toBe("low"); // the refused update saved nothing
    db.updateSchedule(s.id, { effort: "ultra" }); // kept from a version whose list had it
    expect(sc.update(s.id, { enabled: false }).enabled).toBe(false); // a kept effort does not block another change
    expect(sc.update(s.id, { runner: "codex" }).effort).toBe(""); // another runner's list: back to the CLI default
  });

  test("a database from before schedules had a model or an effort reads its rows with an empty one", () => {
    const p = join(home, "old.sqlite");
    const raw = new (require("bun:sqlite").Database)(p);
    raw.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT NOT NULL, cron TEXT NOT NULL, workspace_id TEXT NOT NULL, runner TEXT NOT NULL, prompt TEXT NOT NULL, budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_task_id TEXT, next_run_at INTEGER, created_at INTEGER NOT NULL, action TEXT NOT NULL DEFAULT 'prompt');
      INSERT INTO schedules (id, title, cron, workspace_id, runner, prompt, created_at) VALUES ('sch_old', 'old', '0 3 * * *', 'w', 'codex', 'p', 1);`);
    raw.close();
    const old = new Db(p);
    expect(old.getSchedule("sch_old")).toMatchObject({ runner: "codex", model: "", effort: "" });
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
    const started = (await sc.runNow(s.id, "manual")) as Task;
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

  test("queue().queued lists the Tasks waiting for a run slot in queuedAt order, and takeQueued takes one out (#1141)", () => {
    const base = db.getTask(tasks.create({ workspaceId: wsId, cwd: home, title: "base", prompt: "p", runner: "claude" }).id)!;
    const mk = (id: string, createdAt: number): Task => ({ ...base, id, title: id, status: "idle", queuedAt: null, createdAt, updatedAt: createdAt, statusAt: createdAt });
    db.insertTask(mk("tsk_q_late", 1));
    db.insertTask(mk("tsk_q_early", 2));
    db.insertTask(mk("tsk_q_none", 3));
    db.setQueued("tsk_q_late", "second", 2000);
    db.setQueued("tsk_q_early", "first", 1000);
    const sc = new Scheduler(db, tasks, () => now);
    expect(sc.queue().queued).toEqual([
      { taskId: "tsk_q_early", title: "tsk_q_early", runner: "claude", since: 1000, position: 1 },
      { taskId: "tsk_q_late", title: "tsk_q_late", runner: "claude", since: 2000, position: 2 },
    ]);
    expect(db.getTask("tsk_q_early")!.queuedAt).toBe(1000);
    expect(db.takeQueued("tsk_q_early")).toBe("first");
    expect(db.takeQueued("tsk_q_early")).toBeNull();
    expect(db.takeQueued("tsk_q_none")).toBeNull();
    expect(sc.queue().queued).toEqual([{ taskId: "tsk_q_late", title: "tsk_q_late", runner: "claude", since: 2000, position: 1 }]);
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
    expect(((await sc.runNow(s.id, "manual")) as Task).id).toBe(t.id);
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
    expect(((await sc.runNow(s.id, "manual")) as Task).id).toBe(started[5]!.task.id);
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
    expect(((await first) as Task).id).toBe(t.id);
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
  }, 30_000); // a bun subprocess under a loaded full suite: over the 5 s default (docs/design/perf.md "Test flakiness")
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

  test("security merge memo", async () => {
    const hour = 3_600_000;
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, undefined, async () => "待ちなし");
    const s = sc.create({ title: "承認待ち", cron: "0 0 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "approval-window" });
    const stop = (n: number, at: number) => ({ askId: `a${n}`, taskId: `tk_${n}`, title: `Task ${n}`, workspaceId: null, op: `PR #${n}`, at, pr: n });
    const batch = (...at: number[]): AskBatch[] => (at.length ? [{ id: "batch:security-merge", kind: "security-merge", asks: at.map((x, i) => stop(i + 1, x)), loggingIn: null, deviceAuth: null }] : []);
    const shown = (bs: AskBatch[], at: number, record = {}) =>
      noticeAsks({ unusable: [], merges: [{ schedule: { id: s.id, title: "承認待ち" }, workspace: null, note: securityMergeNote(bs, db.getSchedule(s.id)!.lastRunAt, at) }], now: at }, record);
    // not fired yet: nothing, however long they wait
    expect(shown(batch(s.nextRunAt! - 5 * hour), s.nextRunAt! - hour).asks).toEqual([]);
    now = s.nextRunAt!;
    await sc.tick();
    const fired = now;
    // two waiting at the firing: one notice, its title has the count and the longest wait in hours (rounded up)
    const first = shown(batch(fired - 5 * hour + 1, fired - hour), fired);
    expect(first.asks).toHaveLength(1);
    expect(first.asks[0]).toMatchObject({ kind: "notice", state: "open", question: "セキュリティのマージ確認 2 件（最長 5 時間）— 判断待ちから答えられる" });
    expect(first.asks[0]!.reason).toBe("- PR #1 — Task 1\n- PR #2 — Task 2");
    // later the same day: still that one notice, and a check that stopped after the firing is not in it (it waits for the next)
    const again = shown(batch(fired - 5 * hour + 1, fired - hour, fired + hour), fired + 2 * hour, first.record);
    expect(again.asks.map((a) => a.id)).toEqual([first.asks[0]!.id]);
    expect(again.asks[0]!.question).toStartWith("セキュリティのマージ確認 2 件");
    // a check that stops at noon after a firing with none waiting: no notice until the next firing
    expect(shown(batch(fired + 12 * hour), fired + 12 * hour + 1).asks).toEqual([]);
    // all answered: the open one is resolved; one stopping again that day does not bring a second notice
    const resolved = shown([], fired + 3 * hour, again.record);
    expect(resolved.asks.map((a) => [a.id, a.state])).toEqual([[first.asks[0]!.id, "resolved"]]);
    expect(shown(batch(fired + 4 * hour), fired + 5 * hour, resolved.record).asks.filter((a) => a.state === "open")).toEqual([]);
    // the next firing: the one that stopped since is that day's notice
    now = db.getSchedule(s.id)!.nextRunAt!;
    await sc.tick();
    const next = shown(batch(fired + 4 * hour), now, resolved.record);
    expect(next.asks.filter((a) => a.state === "open").map((a) => a.question)).toEqual(["セキュリティのマージ確認 1 件（最長 20 時間）— 判断待ちから答えられる"]);
    expect(next.asks.find((a) => a.state === "open")!.id).not.toBe(first.asks[0]!.id);
  });

  test("daily promotion memo", async () => {
    // the approval-window firing at 00:00 UTC is what a held promotion waits for (#2148)
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, undefined, undefined, async () => "待ちなし");
    const s = sc.create({ title: "承認待ち", cron: "0 0 * * *", workspaceId: wsId, runner: "claude", prompt: "", action: "approval-window" });
    const hour = 3_600_000;
    const hold: PromotionHold = { tag: "v0.9.0", failed: false, reason: "2 件の Task が動いているので v0.9.0 の昇格を待つ", since: s.nextRunAt! - 5 * hour };
    const shown = (h: PromotionHold | null, busy: number, at: number, record = {}) => {
      const sch = db.getSchedule(s.id)!;
      return noticeAsks({ unusable: [], promotions: [{ schedule: { id: s.id, title: sch.title }, workspace: null, note: promotionNote(h, busy, sch.lastRunAt, at) }], now: at }, record);
    };
    // held before the schedule ever fired: nothing yet
    expect(shown(hold, 2, s.nextRunAt!).asks).toEqual([]);
    now = s.nextRunAt!;
    await sc.tick();
    const fired = db.getSchedule(s.id)!;
    expect(fired.lastRunAt).toBe(now);
    // one firing a day: the next one is the next day's 00:00
    expect(fired.nextRunAt).toBe(now + 86_400_000);
    const first = shown(hold, 2, now + hour);
    expect(first.asks).toHaveLength(1);
    expect(first.asks[0]).toMatchObject({
      id: `notice:promotion:${s.id}@${hold.since}`,
      kind: "notice",
      state: "open",
      question: "昇格待ち: v0.9.0（6 時間、動いている Task 2 件）— ヘッダーの「新しい版 →」から昇格できる",
      source: { label: "予定「承認待ち」" },
    });
    expect(first.asks[0]!.reason).toContain("待たずに昇格する");
    // the same notice later that day: one notice, its first sight kept
    const later = shown(hold, 1, now + 3 * hour, first.record);
    expect(later.asks.map((a) => a.id)).toEqual([`notice:promotion:${s.id}@${hold.since}`]);
    // no hold, a failed tag, no Task running: no notice (the open one is resolved)
    for (const [h, busy] of [[null, 2], [{ ...hold, failed: true }, 2], [hold, 0]] as const) {
      const r = shown(h, busy, now + 4 * hour, later.record);
      expect(r.asks.map((a) => [a.id, a.state])).toEqual([[`notice:promotion:${s.id}@${hold.since}`, "resolved"]]);
    }
    // the same hold back after a moment without it (promoteWhenIdle clears it before asking again): still one notice
    const gone = shown(null, 2, now + 4 * hour, later.record);
    const back = shown(hold, 1, now + 4 * hour + 1, gone.record);
    expect(back.asks.map((a) => [a.id, a.state])).toEqual([[`notice:promotion:${s.id}@${hold.since}`, "open"]]);
    // a hold that began after the firing (a new tag) waits for the next day's firing
    const newer: PromotionHold = { ...hold, tag: "v0.9.1", since: now + 6 * hour };
    expect(shown(newer, 2, now + 7 * hour).asks).toEqual([]);
    now += 86_400_000;
    await sc.tick();
    expect(shown(newer, 2, now + 1).asks.map((a) => a.question)).toEqual(["昇格待ち: v0.9.1（18 時間、動いている Task 2 件）— ヘッダーの「新しい版 →」から昇格できる"]);
  });
});

describe("scheduler ui-layers (#3353)", () => {
  test("ui-layers: claude only on meta; a firing starts the check's Task with its fixed instruction, and a hot 7-day window skips it with the reason", async () => {
    const metaPath = join(home, "meta");
    mkdirSync(metaPath);
    const metaId = db.upsertWorkspace({ name: "meta", path: metaPath, kind: "meta" }).id;
    const sc = new Scheduler(db, tasks, () => now, undefined, undefined, () => 0.8);
    expect(() => sc.create({ title: "点検", cron: "0 9 1 * *", workspaceId: metaId, runner: "codex", action: "ui-layers" })).toThrow("ui-layers runs on claude");
    expect(() => sc.create({ title: "点検", cron: "0 9 1 * *", workspaceId: wsId, runner: "claude", action: "ui-layers" })).toThrow("meta workspace only");
    const s = sc.create({ title: "点検", cron: "0 9 1 * *", workspaceId: metaId, runner: "claude", action: "ui-layers" });
    expect(() => sc.update(s.id, { runner: "codex" })).toThrow("ui-layers runs on claude");

    // at the threshold, the window not reset yet: no Task, the reason in the log
    db.upsertQuota("claude", "seven_day", 0.85, now / 1000 + 3600);
    expect(await sc.runNow(s.id)).toBeNull();
    expect(db.listTasks()).toHaveLength(0);
    expect(sc.recentLog().at(-1)).toMatch(/点検: ui-layers を飛ばした \(manual\): Claude の 7 日枠が 85% で閾値 80% 以上/);

    // under it: one Task on claude with the fixed instruction, tied to the schedule
    db.upsertQuota("claude", "seven_day", 0.5, now / 1000 + 3600);
    const t = await sc.runNow(s.id);
    expect(t).toMatchObject({ runner: "claude", scheduleId: s.id, title: "床・天井・壁の点検 (2026-09-06 00:00)" });
    // the instruction goes with the usual preamble (unlike insights' bare /insights): the Task registers its report as an artifact
    expect(started.at(-1)!.prompt).toContain(UI_LAYERS_PROMPT);
    expect(started.at(-1)!.preamble).toContain("switchboard-artifact");
  });
});

test("UI_LAYERS_PROMPT names scripts that exist, with flags they read (#3353)", () => {
  const root = join(import.meta.dir, "../../..");
  const calls = [...UI_LAYERS_PROMPT.matchAll(/bun (scripts\/[\w-]+\.ts)([^。（\n]*)/g)];
  expect(calls.map((c) => c[1])).toEqual(["scripts/ui-layers-metrics.ts", "scripts/ui-layers-placement.ts", "scripts/ui-layers-report.ts", "scripts/ui-layers-requests.ts"]);
  for (const [, script, rest] of calls) {
    expect(existsSync(join(root, script!))).toBe(true);
    const src = readFileSync(join(root, script!), "utf8");
    for (const [flag] of rest!.matchAll(/--[\w-]+/g)) expect(`${script} ${flag}: ${src.includes(`"${flag}"`)}`).toBe(`${script} ${flag}: true`);
  }
  expect(readFileSync(join(root, "scripts/ui-layers-report.ts"), "utf8")).toContain('"--history"');
});
