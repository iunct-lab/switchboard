import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StopRecord, type AgentEvent, type BacklogRecord, type RunnerAdapter, type RunnerSession } from "@switchboard/protocol";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { dependsResumePrompt, dependsWaits, jobResumePrompt, resumeDepends, resumeDueAfters, resumeJobsOnTurnEnd, stateFromRecords, waitsClosed } from "./depends-resume.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { TaskManager } from "./tasks.ts";

// A Task that stopped on another session's work is resumed when that work closes (#2045): which stops wait on what.

let n = 0;
const stop = (over: Partial<StopRecord> = {}): StopRecord =>
  StopRecord.parse({
    id: `t1/s${++n}`,
    work: { workspaceId: "ws1", issue: null, taskId: "t1" },
    op: "parallel-guard overlap",
    target: "Task #52",
    reason: "depends",
    conditions: [{ key: "pr#12", value: "open", met: false }],
    state: "waiting",
    at: n * 1000,
    ...over,
  });

const KEY = { service: "github" as const, host: "github.com", repository: "acme/app" };
const PROJECT = { owner: "acme", number: 1 };
const rec = (r: Record<string, unknown>) => ({ ...KEY, base: null, local: null, fetchedAt: 1, fetchState: "fetched", ...r }) as BacklogRecord;
const pr = (number: number, state: "OPEN" | "MERGED" | "CLOSED", over: Record<string, unknown> = {}) =>
  rec({ objectKind: "pull-request", externalId: `PR_${number}`, remote: { number, state, isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: "", files: [], closedAt: null, mergedAt: null }, ...over });
const issue = (number: number, state: "OPEN" | "CLOSED", labels = ["type:task"]) =>
  rec({ objectKind: "issue", externalId: `I_${number}`, remote: { number, title: "", url: "", state, stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: "", updatedAt: "", closedAt: null } });
const item = (number: number, status: string | null, project = PROJECT) =>
  rec({ objectKind: "project-item", externalId: `PVTI_${number}_${project.owner}_${project.number}`, remote: { issue: number, owner: project.owner, project: project.number, fields: { Status: status } } });

describe("depends-resume (#2045)", () => {
  test("dependsWaits picks open depends stops with wait keys", () => {
    const pick = stop({ conditions: [{ key: "pr#12", value: "open", met: false }, { key: "issue#34", value: "open", met: false }, { key: "issue#35", value: "open", met: true }] });
    const records = [
      pick,
      stop({ reason: "decision" }), // not a wait on other work
      stop({ conditions: [] }), // waits on nothing it names
      stop({ conditions: [{ key: "pr#12", value: "open", met: false }, { key: "resetsAt", value: "1", met: false }] }), // a time is not closed by GitHub
      stop({ conditions: [{ key: "pr#12", value: "merged", met: true }] }), // nothing left to wait for
      stop({ state: "resolved" }),
    ];
    expect(dependsWaits(records)).toEqual([{ stop: pick, numbers: [12, 34], jobs: [] }]);
    // a job of the daemon (#3993) is a wait too, kept apart from GitHub's numbers
    const job = stop({ conditions: [{ key: "job#7", value: "done", met: false }, { key: "pr#12", value: "open", met: false }] });
    expect(dependsWaits([job])).toEqual([{ stop: job, numbers: [12], jobs: [7] }]);
    // the newest record of a stop decides: one resolved later is not open
    const later = { ...pick, state: "resolved" as const, at: pick.at + 1 };
    expect(dependsWaits([pick, later])).toEqual([]);
  });

  test("after: a date with a time zone is a wait, kept apart from the numbers; a value that is no such time is not one", () => {
    const due = "2026-11-20T09:00:00+09:00";
    const only = stop({ conditions: [{ key: "after", value: due, met: false }] });
    const both = stop({ conditions: [{ key: "pr#12", value: "open", met: false }, { key: "after", value: due, met: false }] });
    expect(dependsWaits([only, both])).toEqual([
      { stop: only, numbers: [], jobs: [], after: Date.parse(due) },
      { stop: both, numbers: [12], jobs: [], after: Date.parse(due) },
    ]);
    // no zone, or no time at all: nothing to wait for by the clock
    expect(dependsWaits([stop({ conditions: [{ key: "after", value: "2026-11-20T09:00:00", met: false }] }), stop({ conditions: [{ key: "after", value: "soon", met: false }] })])).toEqual([]);
    // a date already marked met is over
    expect(dependsWaits([stop({ conditions: [{ key: "after", value: due, met: true }] })])).toEqual([]);
  });

  test("after: waitsClosed is open before the date, closed at it and after", () => {
    const at = Date.parse("2026-11-20T00:00:00Z");
    const states = () => "closed" as const;
    expect(waitsClosed({ numbers: [], after: at }, states, undefined, at - 1)).toBe(false);
    expect(waitsClosed({ numbers: [], after: at }, states, undefined, at)).toBe(true);
    expect(waitsClosed({ numbers: [], after: at }, states, undefined, at + 1)).toBe(true);
    expect(waitsClosed({ numbers: [12], after: at }, () => "open", undefined, at + 1)).toBe(false);
  });

  test("dependsResumePrompt after names the date that passed", () => {
    expect(dependsResumePrompt([], ["2026-11-20T09:00:00+09:00"])).toContain("期日 2026-11-20T09:00:00+09:00 を過ぎました");
    expect(dependsResumePrompt(["pr#12"], ["2026-11-20T09:00:00+09:00"])).toContain("待っていた pr#12 が片づきました。期日 2026-11-20T09:00:00+09:00 を過ぎました");
  });

  test("waitsClosed needs every wait closed", () => {
    const states = stateFromRecords([
      pr(12, "MERGED"), pr(13, "CLOSED"), pr(14, "OPEN"),
      issue(30, "CLOSED"), issue(31, "OPEN"), issue(32, "OPEN"), issue(33, "OPEN"), issue(36, "OPEN", ["type:pbi"]),
      item(31, "Backlog"), item(32, "In progress"), item(33, "In progress", { owner: "other", number: 1 }),
      pr(15, "MERGED", { fetchState: "unavailable" }),
    ], PROJECT);
    expect([12, 13, 14, 30, 31, 32, 33, 36, 15, 99].map(states)).toEqual([
      "closed", "closed", "open", // a PR merged or closed is closed
      "closed", "closed", "open", // a Task closed, or not In progress any more, is closed
      "unknown", // a Status of another Project does not count
      "open", // an open Issue that is not a Task
      "unknown", "unknown", // not read as it is, not stored
    ]);
    expect(waitsClosed({ numbers: [12, 13, 30, 31] }, states)).toBe(true);
    expect(waitsClosed({ numbers: [12, 14] }, states)).toBe(false);
    expect(waitsClosed({ numbers: [12, 32] }, states)).toBe(false);
    expect(waitsClosed({ numbers: [12, 99] }, states)).toBe(false);
  });

  test("an edit made here and not sent yet counts over what GitHub last answered", () => {
    const local = (r: BacklogRecord, value: unknown) => ({ ...r, local: value }) as BacklogRecord;
    const backlog = item(31, "Backlog");
    const reopened = issue(30, "CLOSED");
    const states = stateFromRecords([
      issue(31, "OPEN"), local(backlog, { ...backlog.remote!, fields: { Status: "In progress" } }), // set In progress here
      local(reopened, { ...reopened.remote!, state: "OPEN" }), item(30, "In progress"), // reopened here
    ], PROJECT);
    expect([31, 30].map(states)).toEqual(["open", "open"]);
  });
});

/** A runner whose every turn ends ok in session `sess-1`; records the turns it was sent (ratelimit.test.ts's fake, cut down). `ctl.failSend` refuses the next send. */
function fakeAdapter(sends: string[], ctl: { failSend?: boolean } = {}): RunnerAdapter {
  const turn: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "done" }, { t: "session.end", status: "ok", summary: "done" }];
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(_opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const play = () => queueMicrotask(() => turn.forEach(emit));
      play();
      const session: RunnerSession = {
        send: (text) => {
          if (ctl.failSend) {
            ctl.failSend = false;
            throw new Error("runner process has exited; resume the task instead");
          }
          sends.push(text);
          emit({ t: "message.delta", role: "user", text });
          play();
        },
        respondPermission: () => undefined,
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      };
      return session;
    },
  };
}

describe("resumeDepends (#2045)", () => {
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let sends: string[];
  const ctl: { failSend?: boolean } = {};
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const SOURCE = { ...KEY, project: PROJECT, private: true };
  const WAIT = { id: "overlap", op: "parallel-guard overlap", target: "Task #52", reason: "depends" as const, evidence: "PR #12 と同じファイル", safety: "read-only" as const, conditions: [{ key: "pr#12", value: "open", met: false }, { key: "issue#34", value: "open", met: false }], actions: [], state: "waiting" as const };
  const store = (records: BacklogRecord[]) => db.putBacklogSnapshot(KEY, { records: records.map((r) => ({ objectKind: r.objectKind, externalId: r.externalId, remote: r.remote, fetchState: r.fetchState }) as BacklogSnapshotEntry), cursor: null, syncedAt: Date.now() });
  const stopOf = (id: string) => db.listStopRecords([id]).filter((r) => r.id === `${id}/overlap`).at(-1)!;
  const start = async (over: { stage?: { issue: number; action: "complete" } } = {}) => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude", workspaceId: "ws_app", ...over });
    await settle();
    expect(db.getTask(t.id)!.status).toBe("done");
    expect(tasks.recordStop(t.id, WAIT).ok).toBe(true);
    return t;
  };
  const resume = () => resumeDepends({ db, tasks, workspaceId: "ws_app", now: Date.now() });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-depends-"));
    db = new Db(join(home, "db.sqlite"));
    db.upsertWorkspace({ id: "ws_app", name: "app", path: home, kind: "repo" });
    db.setWorkspaceBacklogSource("ws_app", SOURCE);
    sends = [];
    ctl.failSend = false;
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter(sends, ctl)]]), () => undefined, { idleMs: -1 });
  });
  afterEach(async () => {
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("resumes the same task when its waits close: the follow-up turn in its session, the stop resolved under the same id", async () => {
    const t = await start();
    tasks.recordStop(t.id, { ...WAIT, id: "ask", op: "ask", target: "", reason: "decision", conditions: [] }); // another stop, still open
    store([pr(12, "MERGED"), issue(34, "OPEN"), item(34, "Backlog")]);
    expect(await resume()).toEqual([t.id]);
    await settle();
    // the daemon's turn is no answer of the person's to the task's other stops (send's `daemon`)
    expect(db.listStopRecords([t.id]).filter((r) => r.id === `${t.id}/ask`).at(-1)!).toMatchObject({ state: "waiting", answer: null });
    expect(sends).toEqual([dependsResumePrompt(["pr#12", "issue#34"])]);
    expect(sends[0]).toStartWith(AUTO_RESUME_HEAD);
    const s = stopOf(t.id);
    expect(s).toMatchObject({ state: "resolved", reason: "depends", conditions: [{ key: "pr#12", met: true }, { key: "issue#34", met: true }] });
    expect(s.actions.at(-1)).toMatchObject({ what: "待ちが片づいた: pr#12, issue#34", ok: true });
    expect(s.answer).toBeNull(); // the daemon's turn is no answer of the person's
  });

  describe("after (#4616)", () => {
    // a few days ahead of the real clock: the Task's stops are looked at for a week after it changed
    const DUE = Math.floor((Date.now() + 3 * 24 * 3600_000) / 1000) * 1000;
    const DUE_TEXT = new Date(DUE).toISOString();
    const waitAfter = (conditions: { key: string; value: string; met: boolean }[]) => ({ ...WAIT, conditions });
    const startAfter = async (conditions: { key: string; value: string; met: boolean }[], workspaceId = "ws_app") => {
      const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude", workspaceId });
      await settle();
      expect(tasks.recordStop(t.id, waitAfter(conditions)).ok).toBe(true);
      return t;
    };
    const at = (now: number, workspaceId: string | null = "ws_app") => resumeDepends({ db, tasks, workspaceId, now });

    test("after: not sent before the date, sent at it and after, with the date in the turn", async () => {
      const t = await startAfter([{ key: "after", value: DUE_TEXT, met: false }]);
      expect(await at(DUE - 1)).toEqual([]);
      await settle();
      expect(sends).toEqual([]);
      expect(stopOf(t.id).state).toBe("waiting");
      expect(await at(DUE)).toEqual([t.id]); // exactly at the date is over
      await settle();
      expect(sends).toEqual([dependsResumePrompt([], [DUE_TEXT])]);
      expect(stopOf(t.id)).toMatchObject({ state: "resolved", conditions: [{ key: "after", met: true }] });
      expect(await at(DUE + 1000)).toEqual([]); // not sent twice
    });

    test("after: sent after the date too", async () => {
      const t = await startAfter([{ key: "after", value: DUE_TEXT, met: false }]);
      expect(await at(DUE + 3600_000)).toEqual([t.id]);
    });

    test("after with pr#N: waits for both", async () => {
      const t = await startAfter([{ key: "pr#12", value: "open", met: false }, { key: "after", value: DUE_TEXT, met: false }]);
      store([pr(12, "OPEN")]);
      expect(await at(DUE + 1)).toEqual([]); // the date is past, the PR is not
      store([pr(12, "MERGED")]);
      expect(await at(DUE - 1)).toEqual([]); // the PR is closed, the date is not past
      expect(await at(DUE)).toEqual([t.id]);
      await settle();
      expect(sends).toEqual([dependsResumePrompt(["pr#12"], [DUE_TEXT])]);
    });

    test("after: a Task of a workspace that is not backlog-synced is sent too", async () => {
      db.upsertWorkspace({ id: "ws_other", name: "other", path: home, kind: "repo" });
      const t = await startAfter([{ key: "after", value: DUE_TEXT, met: false }], "ws_other");
      expect(await at(DUE - 1, "ws_other")).toEqual([]);
      expect(await at(DUE, "ws_other")).toEqual([t.id]);
    });

    test("after: resumeDueAfters sends without an import, to a workspace that is not backlog-synced and to a Task without a workspace", async () => {
      db.upsertWorkspace({ id: "ws_other", name: "other", path: home, kind: "repo" });
      const other = await startAfter([{ key: "after", value: DUE_TEXT, met: false }], "ws_other");
      const none = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
      await settle();
      expect(tasks.recordStop(none.id, waitAfter([{ key: "after", value: DUE_TEXT, met: false }])).ok).toBe(true);
      expect(await resumeDueAfters({ db, tasks, now: DUE - 1 })).toEqual([]);
      expect((await resumeDueAfters({ db, tasks, now: DUE })).sort()).toEqual([other.id, none.id].sort());
      await settle();
      expect(sends).toEqual([dependsResumePrompt([], [DUE_TEXT]), dependsResumePrompt([], [DUE_TEXT])]);
      expect(await resumeDueAfters({ db, tasks, now: DUE + 1000 })).toEqual([]); // once
    });
  });

  test("stage task stop is only resolved: backlog-next starts what comes next", async () => {
    const t = await start({ stage: { issue: 50, action: "complete" } });
    store([pr(12, "MERGED"), issue(34, "CLOSED")]);
    expect(await resume()).toEqual([]);
    await settle();
    expect(sends).toEqual([]);
    expect(stopOf(t.id).state).toBe("resolved");
  });

  test("does not resume while a wait is open, not read, or the task has no session or a resume planned", async () => {
    const t = await start();
    const before = db.listStopRecords([t.id]).length;
    for (const records of [[pr(12, "MERGED"), issue(34, "OPEN"), item(34, "In progress")], [pr(12, "MERGED")], [pr(12, "MERGED"), issue(34, "CLOSED", ["type:task"]), pr(12, "OPEN")]]) {
      store(records);
      expect(await resume()).toEqual([]);
    }
    store([pr(12, "MERGED"), issue(34, "CLOSED")]);
    tasks.setResumeAt(t.id, Date.now() + 60_000); // a usage-limit resume will continue it
    expect(await resume()).toEqual([]);
    tasks.setResumeAt(t.id, null);
    db.updateTask(t.id, { status: "background" }); // its runner's background jobs are still going
    expect(await resume()).toEqual([]);
    db.updateTask(t.id, { status: "done" });
    db.updateTask(t.id, { runnerSessionId: null });
    expect(await resume()).toEqual([]);
    await settle();
    expect(sends).toEqual([]);
    expect(db.listStopRecords([t.id])).toHaveLength(before); // the record did not move
    expect(stopOf(t.id).state).toBe("waiting");
  });

  test("sends once: the next import finds the stop resolved", async () => {
    const t = await start();
    store([pr(12, "MERGED"), issue(34, "CLOSED")]);
    expect(await resume()).toEqual([t.id]);
    await settle();
    expect(await resume()).toEqual([]);
    await settle();
    expect(sends).toHaveLength(1);
  });

  test("a turn that could not be sent puts the stop back to waiting with the reason; the next import sends it", async () => {
    const t = await start();
    store([pr(12, "MERGED"), issue(34, "CLOSED")]);
    ctl.failSend = true;
    expect(await resume()).toEqual([]);
    const s = stopOf(t.id);
    expect(s.state).toBe("waiting");
    expect(s.actions.at(-1)).toMatchObject({ ok: false, what: expect.stringContaining("続きを送れなかった: runner process has exited") });
    expect(await resume()).toEqual([t.id]);
    await settle();
    expect(sends).toHaveLength(1);
    expect(stopOf(t.id).state).toBe("resolved");
  });

  test("中断 while the turn waits for the runner's process to close: nothing is sent", async () => {
    const t = await start();
    store([pr(12, "MERGED"), issue(34, "CLOSED")]);
    let open!: () => void;
    (tasks as unknown as { closing: Map<string, Promise<void>> }).closing.set(t.id, new Promise<void>((r) => (open = r)));
    const resumed = resume();
    await settle();
    await tasks.abort(t.id);
    open();
    expect(await resumed).toEqual([]);
    await settle();
    expect(sends).toEqual([]);
  });

  test("a task that stopped twice gets one turn, once neither of its stops still waits", async () => {
    const t = await start(); // stop `overlap` waits on pr#12 and issue#34
    tasks.recordStop(t.id, { ...WAIT, id: "overlap-2", conditions: [{ key: "pr#13", value: "open", met: false }] });
    store([pr(12, "MERGED"), issue(34, "CLOSED"), pr(13, "OPEN")]);
    expect(await resume()).toEqual([]); // pr#13 still holds it: the closed stop is resolved, nothing is sent
    expect(stopOf(t.id).state).toBe("resolved");
    store([pr(12, "MERGED"), issue(34, "CLOSED"), pr(13, "MERGED")]);
    expect(await resume()).toEqual([t.id]);
    await settle();
    expect(sends).toEqual([dependsResumePrompt(["pr#13"])]);
    // both closed at once: one turn naming every key
    const u = await start();
    tasks.recordStop(u.id, { ...WAIT, id: "overlap-2", conditions: [{ key: "pr#13", value: "open", met: false }] });
    sends.length = 0;
    expect(await resume()).toEqual([u.id]);
    await settle();
    expect(sends).toEqual([dependsResumePrompt(["pr#12", "issue#34", "pr#13"])]);
  });
  describe("job#<id> (#3993)", () => {
    const JOB_WAIT = { ...WAIT, id: "overlap", op: "ops-kit job request", target: "PR #12", evidence: "ローカル CI を頼んだ", conditions: [{ key: "job#1", value: "done", met: false }] };
    const startJob = async (over: { stage?: { issue: number; action: "complete" } } = {}, wait = JOB_WAIT) => {
      const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude", workspaceId: "ws_app", ...over });
      await settle();
      const job = db.insertJob({ kind: "local-ci", taskId: t.id, pr: 12, runner: null, cwd: home, startedAt: Date.now() });
      expect(tasks.recordStop(t.id, { ...wait, conditions: wait.conditions.map((c) => (c.key === "job#1" ? { ...c, key: `job#${job.id}` } : c)) }).ok).toBe(true);
      return { t, job };
    };
    const end = (id: number, code = 1) => db.finishJob(id, { status: code === 0 ? "pass" : "fail", exitCode: code, summary: `fail（終了コード ${code}）\nerror: 2 tests failed\nログ: /jobs/${id}/log`, endedAt: Date.now() })!;

    test("waits while the job runs; once it ends, one turn with its result", async () => {
      const { t, job } = await startJob();
      expect(await resume()).toEqual([]);
      expect(stopOf(t.id).state).toBe("waiting");
      const ended = end(job.id);
      expect(await resume()).toEqual([t.id]);
      await settle();
      expect(sends).toEqual([jobResumePrompt([ended])]);
      expect(sends[0]).toStartWith(AUTO_RESUME_HEAD);
      expect(sends[0]).toContain(`job#${job.id} local-ci PR #12: fail（終了コード 1）`);
      expect(sends[0]).toContain("error: 2 tests failed");
      expect(stopOf(t.id)).toMatchObject({ state: "resolved", conditions: [{ key: `job#${job.id}`, met: true }] });
      expect(await resume()).toEqual([]); // once
    });

    test("after with a job: goes on once both are over, and the turn says the date passed", async () => {
      const due = Math.floor((Date.now() + 24 * 3600_000) / 1000) * 1000;
      const dueText = new Date(due).toISOString();
      const { t, job } = await startJob({}, { ...JOB_WAIT, conditions: [{ key: "job#1", value: "done", met: false }, { key: "after", value: dueText, met: false }] });
      const ended = end(job.id, 0);
      expect(await resumeDepends({ db, tasks, workspaceId: "ws_app", now: due - 1 })).toEqual([]); // the job ended, the date is not past
      expect(await resumeDepends({ db, tasks, workspaceId: "ws_app", now: due })).toEqual([t.id]);
      await settle();
      expect(sends).toEqual([jobResumePrompt([ended], [], [dueText])]);
      expect(sends[0]).toContain(`期日 ${dueText} を過ぎました`);
    });

    test("a stop on a PR and a job goes on once both closed", async () => {
      const { t, job } = await startJob({}, { ...JOB_WAIT, conditions: [{ key: "pr#12", value: "open", met: false }, { key: "job#1", value: "done", met: false }] });
      end(job.id, 0);
      expect(await resume()).toEqual([]); // the PR is not read yet
      store([pr(12, "MERGED")]);
      expect(await resume()).toEqual([t.id]);
      await settle();
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain("pass（終了コード 0）");
      expect(sends[0]).toContain("pr#12");
    });

    test("a job stop is held while another depends stop waits, so the last turn still carries the job's result", async () => {
      const { t, job } = await startJob({ stage: { issue: 50, action: "complete" } });
      expect(tasks.recordStop(t.id, { ...WAIT, id: "pr", conditions: [{ key: "pr#12", value: "open", met: false }] }).ok).toBe(true);
      end(job.id);
      expect(await resume()).toEqual([]); // the PR still waits: nothing resolved, nothing sent
      expect(stopOf(t.id).state).toBe("waiting");
      store([pr(12, "MERGED")]);
      expect(await resume()).toEqual([t.id]);
      await settle();
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain(`job#${job.id} local-ci PR #12: fail`);
      expect(stopOf(t.id).state).toBe("resolved");
    });

    test("a job that ended while the Task was still in its turn is picked up when the turn ends (resumeJobsOnTurnEnd)", async () => {
      const stop = resumeJobsOnTurnEnd(db, tasks);
      const { t, job } = await startJob();
      db.sqlite.query("UPDATE tasks SET workspace_id = NULL WHERE id = ?").run(t.id); // no import will look again
      db.updateTask(t.id, { status: "running" }); // the turn that asked for the job has not ended yet
      const ended = end(job.id);
      expect(await resumeDepends({ db, tasks, workspaceId: null, now: Date.now() })).toEqual([]); // the job's end: skipped
      db.updateTask(t.id, { status: "done" });
      await tasks.send(t.id, "続き", { daemon: true }); // a turn of the Task ends
      await settle();
      await settle();
      expect(sends).toEqual(["続き", jobResumePrompt([ended])]);
      stop();
    });

    test("a stage Task gets its job's turn too", async () => {
      const { t, job } = await startJob({ stage: { issue: 50, action: "complete" } });
      end(job.id);
      expect(await resume()).toEqual([t.id]);
      await settle();
      expect(sends).toHaveLength(1);
    });
  });
});
