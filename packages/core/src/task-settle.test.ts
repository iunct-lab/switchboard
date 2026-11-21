// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personWait, type BacklogSource, type Task } from "@switchboard/protocol";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { TaskManager } from "./tasks/manager.ts";
import { SETTLE_MARK, settleGoneTasks, settleReason, startSettleSweep, type SettleFacts } from "./task-settle.ts";

const NOW = Date.parse("2026-11-21T00:00:00Z");
const HOUR = 3_600_000;

/** A stopped stage Task of Issue 12 under 要対応, last moved an hour ago. */
const task = (over: Partial<Task> = {}): Task =>
  ({ id: "tk_old", workspaceId: "ws", title: "t", runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, origin: "switchboard", resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 12, action: "complete" }, statusAt: NOW - HOUR, createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR, ...over }) as Task;

/** Nothing ended and no other Task: every Task stays. */
const facts = (over: Partial<SettleFacts> = {}): SettleFacts => ({ stageEnded: () => false, newestStageTask: () => null, newestRun: () => null, ...over });

describe("settleReason", () => {
  test("a Task whose stage Issue closed is settled", () => {
    const closed = facts({ stageEnded: (ws, n) => ws === "ws" && n === 12 });
    expect(settleReason(task(), closed)).toBe("#12 が閉じた");
    expect(settleReason(task({ outcome: "waits" }), closed)).toBe("#12 が閉じた");
    expect(settleReason(task({ outcome: "unknown" }), closed)).toBe("#12 が閉じた");
    // another Issue's end is not this Task's
    expect(settleReason(task({ stage: { issue: 13, action: "complete" } }), closed)).toBeNull();
  });

  test("an older stage Task is settled once a newer one started", () => {
    const newer = facts({ newestStageTask: () => ({ id: "tk_new", createdAt: NOW - HOUR + 1 }) });
    expect(settleReason(task(), newer)).toBe("#12 のより新しい工程 Task が始まった");
    // one that started before this Task stopped ran beside it: the work did not go on past this one
    expect(settleReason(task(), facts({ newestStageTask: () => ({ id: "tk_new", createdAt: NOW - HOUR }) }))).toBeNull();
  });

  test("the newest stage Task of an open Issue stays", () => {
    const self = facts({ newestStageTask: () => ({ id: "tk_old", createdAt: NOW - 2 * HOUR }) });
    expect(settleReason(task(), self)).toBeNull();
    expect(settleReason(task({ outcome: "waits" }), self)).toBeNull();
    // the same id is never "newer", whatever the times say
    expect(settleReason(task({ updatedAt: NOW - 3 * HOUR }), self)).toBeNull();
  });

  test("an older run of the same schedule is settled", () => {
    const run = task({ stage: null, scheduleId: "sch_1", outcome: "waits" });
    const later = facts({ newestRun: (id) => (id === "sch_1" ? { id: "tk_next", createdAt: NOW } : null) });
    expect(settleReason(run, later)).toBe("同じ定期実行のより新しい回が始まった");
    expect(settleReason(task({ stage: null, scheduleId: "sch_2" }), later)).toBeNull();
    // a run that started before this one stopped ran beside it
    expect(settleReason(run, facts({ newestRun: () => ({ id: "tk_next", createdAt: NOW - HOUR }) }))).toBeNull();
  });

  test("a stage Task a schedule started is not settled by that schedule's later runs", () => {
    // バックログを進める starts every stage Task under its own id: a later run is another Issue's Task
    const later = facts({ newestStageTask: () => ({ id: "tk_old", createdAt: NOW - 2 * HOUR }), newestRun: () => ({ id: "tk_other_issue", createdAt: NOW }) });
    expect(settleReason(task({ scheduleId: "sch_next" }), later)).toBeNull();
  });

  test("the newest run of a schedule stays", () => {
    const run = task({ stage: null, scheduleId: "sch_1" });
    expect(settleReason(run, facts({ newestRun: () => ({ id: "tk_old", createdAt: NOW - 2 * HOUR }) }))).toBeNull();
    // the same id is never a later run, whatever the times say
    expect(settleReason(task({ stage: null, scheduleId: "sch_1", updatedAt: NOW - 3 * HOUR }), facts({ newestRun: () => ({ id: "tk_old", createdAt: NOW - 2 * HOUR }) }))).toBeNull();
  });

  test("a Task with no stage and no schedule stays", () => {
    const everything = facts({ stageEnded: () => true, newestStageTask: () => ({ id: "tk_new", createdAt: NOW }), newestRun: () => ({ id: "tk_new", createdAt: NOW }) });
    expect(settleReason(task({ stage: null }), everything)).toBeNull();
    // a stage with no workspace has no Issue to read
    expect(settleReason(task({ workspaceId: null }), everything)).toBeNull();
  });

  test("an open approval, a Task at work, a failed, a finished and a reviewed one are not settled", () => {
    const closed = facts({ stageEnded: () => true });
    for (const over of [{ status: "waiting" }, { status: "running" }, { status: "idle" }, { status: "background" }, { status: "error", outcome: "failed" }, { outcome: "finished" }, { reviewedAt: NOW }] as Array<Partial<Task>>) expect(settleReason(task(over), closed)).toBeNull();
  });
});

// The sweep against a real database, the real Task manager and the stored backlog records: nothing is faked but the runners (there are none).
describe("settleGoneTasks", () => {
  const SOURCE: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  const issue = (n: number, state: "OPEN" | "CLOSED"): BacklogSnapshotEntry => ({
    objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched",
    remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state, stateReason: null, body: "", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: state === "CLOSED" ? "2026-10-03T00:00:00Z" : null },
  });
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-settle-"));
    db = new Db(join(home, "db.sqlite"));
    db.upsertWorkspace({ id: "ws", name: "app", path: home, kind: "repo" });
    // Issue 12 is open, Issue 13 is closed
    db.putBacklogSnapshot(SOURCE, { records: [issue(12, "OPEN"), issue(13, "CLOSED")], cursor: null, syncedAt: 5000 });
    db.setWorkspaceBacklogSource("ws", SOURCE);
    tasks = new TaskManager(db, new Map(), () => undefined, { idleMs: -1 });
  });
  afterEach(async () => {
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const put = (over: Partial<Task>) => db.insertTask(task({ cwd: home, scope: [home], ...over }));
  const waitOf = (id: string) => personWait(db.getTask(id)!);
  const marks = (id: string) => db.listEvents(id).flatMap((e) => (e.ev.t === "status" && e.ev.text.startsWith(SETTLE_MARK) ? [e.ev.text] : []));

  test("the sweep leaves the newest stage Task of an open Issue", () => {
    // the stage Tasks were started by the backlog schedule, which started another Issue's Task after them
    put({ id: "tk_first", scheduleId: "sch_next", createdAt: NOW - 4 * HOUR, updatedAt: NOW - 3 * HOUR });
    put({ id: "tk_last", scheduleId: "sch_next", outcome: "needs_action", createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR });
    put({ id: "tk_other", scheduleId: "sch_next", stage: { issue: 14, action: "complete" }, status: "running", outcome: "unknown", createdAt: NOW, updatedAt: NOW });
    put({ id: "tk_run1", stage: null, scheduleId: "sch", outcome: "waits", createdAt: NOW - 4 * HOUR, updatedAt: NOW - 3 * HOUR });
    put({ id: "tk_run2", stage: null, scheduleId: "sch", outcome: "waits", createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR });
    put({ id: "tk_adhoc", stage: null, createdAt: NOW - 4 * HOUR, updatedAt: NOW - 3 * HOUR });
    expect(settleGoneTasks({ db, tasks })).toBe(2);
    // the older ones are off 要対応 / 待ち, the newest of the open Issue and of the schedule and the ad-hoc Task are where they were
    expect(["tk_first", "tk_last", "tk_run1", "tk_run2", "tk_adhoc"].map(waitOf)).toEqual(["none", "needs", "none", "waits", "needs"]);
    expect(db.getTask("tk_last")!.reviewedAt).toBeNull();
    // the outcome is how the Task ended: not rewritten
    expect(db.getTask("tk_first")!.outcome).toBe("needs_action");
    // nothing more to settle
    expect(settleGoneTasks({ db, tasks })).toBe(0);
  });

  test("settling records the reason and can be undone", () => {
    put({ id: "tk_closed", stage: { issue: 13, action: "complete" } });
    expect(settleGoneTasks({ db, tasks })).toBe(1);
    expect(waitOf("tk_closed")).toBe("none");
    expect(marks("tk_closed")).toEqual([`${SETTLE_MARK}: #13 が閉じた`]);
    // the person puts it back: it is under 要対応 again, and the next sweeps leave it there
    tasks.setOutcome("tk_closed", { reviewed: false });
    expect(waitOf("tk_closed")).toBe("needs");
    expect(settleGoneTasks({ db, tasks })).toBe(0);
    expect(waitOf("tk_closed")).toBe("needs");
    expect(marks("tk_closed")).toHaveLength(1);
    // a note written on the stopped Task after the settling (a cancelled resume, a restart) does not hide it
    tasks.record("tk_closed", { t: "status", text: "自動再開を取り消しました" });
    expect(settleGoneTasks({ db, tasks })).toBe(0);
    expect(waitOf("tk_closed")).toBe("needs");
    // once it stopped again after a new turn (its status moved after the settling), it is judged afresh
    db.sqlite.query("UPDATE tasks SET status_at = ? WHERE id = ?").run(Date.now() + 1000, "tk_closed");
    expect(settleGoneTasks({ db, tasks })).toBe(1);
    expect(marks("tk_closed")).toHaveLength(2);
  });

  test("a workspace with no stored backlog settles only by a newer Task; an archived Task and another machine's are not looked at", () => {
    db.upsertWorkspace({ id: "ws_bare", name: "bare", path: join(home, "bare"), kind: "repo" });
    put({ id: "tk_bare", workspaceId: "ws_bare", stage: { issue: 13, action: "complete" } });
    put({ id: "tk_archived", stage: { issue: 13, action: "complete" }, archivedAt: NOW });
    put({ id: "tk_away", stage: { issue: 13, action: "complete" }, machine: "pc" });
    expect(settleGoneTasks({ db, tasks })).toBe(0);
    expect(db.getTask("tk_bare")!.reviewedAt).toBeNull();
  });

  test("the sweep runs at start and on the interval", async () => {
    // waits for what the timers do, up to 5 s: a loaded host only makes this slower
    const until = async (id: string) => {
      for (let n = 0; n < 500 && waitOf(id) !== "none"; n++) await Bun.sleep(10);
      return waitOf(id);
    };
    put({ id: "tk_closed", stage: { issue: 13, action: "complete" } });
    // the interval is far longer than the wait: only the first sweep can have taken this one
    const first = startSettleSweep({ db, tasks, firstMs: 5, everyMs: 3_600_000 });
    try {
      expect(await until("tk_closed")).toBe("none");
    } finally {
      first();
    }
    // the first sweep is far away: only a sweep of the interval can take this one
    put({ id: "tk_later", stage: { issue: 13, action: "complete" }, outcome: "waits" });
    const every = startSettleSweep({ db, tasks, firstMs: 3_600_000, everyMs: 20 });
    try {
      expect(await until("tk_later")).toBe("none");
    } finally {
      every();
    }
    // stopped: nothing is swept any more
    put({ id: "tk_after", stage: { issue: 13, action: "complete" } });
    await Bun.sleep(100);
    expect(waitOf("tk_after")).toBe("needs");
  });
});
