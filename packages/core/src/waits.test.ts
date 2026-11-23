// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overWaits, QuotaAndResumeSettings, silentSince, type AgentEvent, type RunnerAdapter, type RunnerSession, type ServerMessage, type StopRecord, type Task, type WaitRecord } from "@switchboard/protocol";
import { waitFileName, type WaitFile } from "../../../ops-kit/src/wait.ts";
import { asksFromTasks } from "./asks.ts";
import { loadConfig } from "./config.ts";
import { abortOrphanedTasks, Db, type BacklogSnapshotEntry } from "./db.ts";
import { startServer } from "./server.ts";
import { reduceStops } from "./stops.ts";
import { TaskManager } from "./tasks/manager.ts";
import { boundsOf, checkWaits, DEPENDS_LIMIT_MS, readWaitFiles, shownWaits, SILENT_AFTER_MS, stopsOfWait, WAIT_ANSWER_NEXT, WAIT_KEPT_ACTION, WAIT_LIMIT_MS, WAIT_REPEATED_NOTE, WAIT_STOPPED_ACTION, waitsDirOf, waitsOf, type WaitBounds, type WaitFacts } from "./waits.ts";
import { resumeDepends } from "./depends-resume.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BOUNDS: WaitBounds = { silentMs: 10 * MIN, ownMs: 6 * HOUR, othersMs: 3 * DAY, graceMs: 30 * MIN };
const T0 = Date.parse("2026-11-10T00:00:00Z");

const wfile = (over: Partial<WaitFile> = {}): WaitFile => ({ taskId: "task_a", pid: process.pid, label: "PR 12 のマージ", startedAt: T0, timeoutAt: T0 + 30 * MIN, stallSec: null, progressAt: T0, cut: null, ...over });

test("the settings' defaults are the constants here, and the grace of a due resume is six looks", () => {
  const d = QuotaAndResumeSettings.parse({});
  expect([d.silentAfterMs, d.waitLimitMs, d.dependsLimitMs]).toEqual([SILENT_AFTER_MS, WAIT_LIMIT_MS, DEPENDS_LIMIT_MS]);
  expect(boundsOf(d)).toEqual(BOUNDS);
});

describe("readWaitFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-waitfiles-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (f: WaitFile) => writeFileSync(join(dir, waitFileName(f.taskId, f.pid)), JSON.stringify(f));

  test("a running command's record is its Task's; a gone command's and an unreadable one are removed; a cut one is handed over", () => {
    put(wfile());
    put(wfile({ pid: 999_999_1, label: "消えたコマンド" }));
    put(wfile({ taskId: "task_b", pid: 999_999_2, cut: { reason: "timeout", at: T0 + 30 * MIN } }));
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "task_c-1.json"), JSON.stringify({ taskId: "task_c" }));
    const r = readWaitFiles(dir, (pid) => pid === process.pid);
    expect([...r.waiting]).toEqual([["task_a", [wfile()]]]);
    expect(r.cut.map((c) => c.file.taskId)).toEqual(["task_b"]);
    expect(readdirSync(dir).sort()).toEqual([waitFileName("task_a", process.pid), waitFileName("task_b", 999_999_2)].sort());
    expect(readWaitFiles(join(dir, "none"))).toEqual({ waiting: new Map(), cut: [] });
  });
});

describe("waitsOf: every wait in one form, each with its limit", () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({ id: "task_a", status: "done", outcome: "finished", reviewedAt: null, archivedAt: null, executionMode: "local", statusAt: T0, updatedAt: T0, resumeAt: null, resumeReason: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, background: null, waits: null, workspaceId: null, stage: null, ...over }) as Task;
  const stop = (over: Partial<StopRecord> = {}): StopRecord => ({ id: "task_a/s1", work: { workspaceId: null, issue: null, taskId: "task_a" }, op: "merge", target: "pr#12", reason: "depends", evidence: "", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: T0, ...over });
  const of = (over: Partial<WaitFacts>) => waitsOf({ task: task(), stops: [], files: [], lastEventAt: null, superseded: false, queue: null, now: T0 + MIN, bounds: BOUNDS, ...over });
  const brief = (ws: WaitRecord[]) => ws.map((w) => [w.kind, w.key, w.label, w.since - T0, w.until - T0]);

  test("a finished Task waits for nothing", () => {
    expect(of({})).toEqual([]);
    // nor does one whose stops are open but whose outcome says it is over, or that the person reviewed
    const stops = [stop({ conditions: [{ key: "pr#12", value: "open", met: false }] })];
    expect(of({ stops })).toEqual([]);
    expect(of({ stops, task: task({ outcome: "waits", reviewedAt: T0 }) })).toEqual([]);
    // nor one whose Issue a later stage Task took over
    expect(of({ stops, task: task({ outcome: "waits" }), superseded: true })).toEqual([]);
    expect(of({ stops, task: task({ outcome: "waits" }) })).toHaveLength(1);
  });

  test("a running ops-kit wait: its label and its own limit, with the progress it watches", () => {
    expect(of({ files: [wfile({ stallSec: 120, progressAt: T0 + 5_000 })] })).toEqual([{ kind: "command", key: `command:${process.pid}`, label: "PR 12 のマージ", since: T0, until: T0 + 30 * MIN, progressAt: T0 + 5_000, stallSec: 120 }]);
  });

  test("a turn or the runner's background jobs: the next event, the silence limit after the last one — unless a command wait says what the quiet is for", () => {
    expect(brief(of({ task: task({ status: "running", outcome: "unknown" }), lastEventAt: T0 }))).toEqual([["output", "output", "ランナーの出力", 0, 10 * MIN]]);
    expect(brief(of({ task: task({ status: "background" }), lastEventAt: T0 }))).toEqual([["output", "output", "裏の処理の知らせ", 0, 10 * MIN]]);
    expect(of({ task: task({ status: "running" }), lastEventAt: T0, files: [wfile()] }).map((w) => w.kind)).toEqual(["command"]);
    // the command's limit passed and it still runs: the quiet is the runner's again
    expect(of({ task: task({ status: "running" }), lastEventAt: T0, files: [wfile()], now: T0 + 31 * MIN }).map((w) => w.kind)).toEqual(["command", "output"]);
    // an open approval is the person's, a finished turn nobody's, a Cloud Task's events are not the runner's
    expect(of({ task: task({ status: "waiting" }), lastEventAt: T0 }).map((w) => w.kind)).toEqual(["person"]);
    expect(of({ task: task({ status: "done" }), lastEventAt: T0 })).toEqual([]);
    expect(of({ task: task({ status: "running", executionMode: "cloud" }), lastEventAt: T0 })).toEqual([]);
  });

  test("the person: an open approval, or a turn that ended needing them", () => {
    expect(brief(of({ task: task({ status: "waiting" }) }))).toEqual([["person", "approval", "ツールの承認", 0, 3 * DAY]]);
    expect(brief(of({ task: task({ outcome: "needs_action" }) }))).toEqual([["person", "person", "利用者の対応", 0, 3 * DAY]]);
  });

  test("a planned resume: its time and the grace; with a try before a long wait, the later of the two", () => {
    expect(brief(of({ task: task({ resumeAt: T0 + HOUR, resumeReason: "limit", resumeSince: T0 }) }))).toEqual([["resume", "resume", "使用上限の解除", 0, HOUR + 30 * MIN]]);
    expect(brief(of({ task: task({ resumeAt: T0 + HOUR, resumeReason: "limit", resumeSince: T0, resumePlannedAt: T0 + 5 * HOUR }) }))).toEqual([["resume", "resume", "使用上限の解除", 0, 5 * HOUR + 30 * MIN]]);
    expect(of({ task: task({ resumeAt: T0, resumeReason: null }) })[0]).toMatchObject({ label: "中断からの自動再開", until: T0 + 30 * MIN });
    expect(of({ task: task({ resumeAt: T0, resumeReason: "github" }) })[0]!.label).toBe("GitHub の API 上限の解除");
  });

  test("a place in the queue: what the queue waits for, and the own limit", () => {
    expect(brief(of({ task: task({ status: "idle", outcome: "unknown", queuedAt: T0 }), queue: "promotion" }))).toEqual([["queue", "queue", "昇格（動いている Task の終わり）", 0, 6 * HOUR]]);
    expect(of({ task: task({ status: "idle", queuedAt: T0 }), queue: "slot" })[0]!.label).toBe("実行枠の空き");
  });

  test("a queued reply that was refused: the row names the refusal, with the same kind, key and limit", () => {
    const t = task({ status: "idle", outcome: "unknown", queuedAt: T0 });
    expect(brief(of({ task: t, queue: "slot", refusal: "budget exceeded" }))).toEqual([["queue", "queue", "返信の開始の条件（budget exceeded）", 0, 6 * HOUR]]);
    expect(of({ task: t, queue: "slot", refusal: null })[0]!.label).toBe("実行枠の空き");
    expect(of({ task: t, queue: null, refusal: "budget exceeded" })[0]!.label).toBe("返信の開始の条件（budget exceeded）");
  });

  test("the open stops of a stopped Task: each unmet condition is a wait — a PR, an Issue, a job, a date, another runner's limit", () => {
    const stops = [
      stop({ conditions: [{ key: "pr#12", value: "open", met: false }, { key: "issue#7", value: "open", met: false }, { key: "pr#3", value: "merged", met: true }, { key: "job#5", value: "running", met: false }, { key: "after", value: "2026-11-12T00:00:00Z", met: false }] }),
      stop({ id: "task_a/s2", reason: "usage-limit", at: T0 + MIN, conditions: [{ key: "runner#codex", value: "2026-11-10T05:00:00Z", met: false }, { key: "ci", value: "red", met: false }] }),
    ];
    expect(brief(of({ task: task({ outcome: "waits" }), stops, now: T0 + 2 * MIN }))).toEqual([
      ["depends", "pr#12", "PR #12", 0, 3 * DAY],
      ["depends", "issue#7", "Issue #7", 0, 3 * DAY],
      ["job", "job#5", "頼んだ仕事 job#5", 0, 6 * HOUR],
      ["date", "after:2026-11-12T00:00:00Z", "期日 2026-11-12T00:00:00Z", 0, 2 * DAY + 30 * MIN],
      ["resume", "runner#codex", "codex の使用上限の解除", MIN, 5 * HOUR + 30 * MIN],
      ["stop", "task_a/s2:ci", "ci: red", MIN, MIN + 3 * DAY],
    ]);
  });

  test("a stop reported again keeps its first time; one resolved and back waits from its return; two stops on one PR are one wait", () => {
    const c = [{ key: "pr#12", value: "open", met: false }];
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c }), stop({ conditions: c, at: T0 + HOUR })] }))).toEqual([["depends", "pr#12", "PR #12", 0, 3 * DAY]]);
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c }), stop({ state: "resolved", at: T0 + HOUR }), stop({ conditions: c, at: T0 + 2 * HOUR })] }))).toEqual([["depends", "pr#12", "PR #12", 2 * HOUR, 2 * HOUR + 3 * DAY]]);
    expect(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c }), stop({ id: "task_a/s2", conditions: c, at: T0 + HOUR })] })).toHaveLength(1);
    // a resolved stop, another Task's stop of the same work, and a Task in a turn: no wait
    expect(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c }), stop({ state: "resolved", at: T0 + HOUR })] })).toEqual([]);
    expect(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c, work: { workspaceId: null, issue: null, taskId: "task_other" } })] })).toEqual([]);
    expect(of({ task: task({ outcome: "waits", status: "running" }), stops: [stop({ conditions: c })] })).toEqual([]);
  });

  test("stopsOfWait: the Task's open stops that make a wait's key — by the same keys waitsOf gives", () => {
    const pr = [{ key: "pr#12", value: "open", met: false }];
    const a = stop({ conditions: [...pr, { key: "after", value: "2026-11-12T00:00:00Z", met: false }, { key: "ci", value: "red", met: false }] });
    const b = stop({ id: "task_a/s2", conditions: [...pr, { key: "job#5", value: "running", met: false }, { key: "runner#codex", value: "2026-11-10T05:00:00Z", met: false }] });
    const bare = stop({ id: "task_a/s3", op: "ci", target: "" });
    const stops = [a, b, bare, stop({ id: "task_a/s4", conditions: pr, state: "resolved" }), stop({ id: "task_b/s1", conditions: pr, work: { workspaceId: null, issue: null, taskId: "task_b" } }), stop({ id: "task_a/s5", conditions: [{ key: "pr#12", value: "merged", met: true }, { key: "pr#9", value: "open", met: false }] })];
    const ids = (key: string) => stopsOfWait(stops, "task_a", key).map((s) => s.id);
    // every key waitsOf gives is found again, and names the stops it came from
    const keys = of({ task: task({ outcome: "waits" }), stops }).map((w) => w.key);
    expect(keys).toEqual(["pr#12", "after:2026-11-12T00:00:00Z", "task_a/s1:ci", "job#5", "runner#codex", "task_a/s3", "pr#9"]);
    expect(keys.map(ids)).toEqual([["task_a/s1", "task_a/s2"], ["task_a/s1"], ["task_a/s1"], ["task_a/s2"], ["task_a/s2"], ["task_a/s3"], ["task_a/s5"]]);
    // a key no open stop of the Task makes: none (a met condition, another Task's stop, a stop's id when it has conditions)
    expect([ids("pr#3"), ids("task_a/s1"), stopsOfWait(stops, "task_c", "pr#12")]).toEqual([[], [], []]);
  });

  test("待ち続ける: a wait the person answered to keep counts its limit from that answer — that key only, the last answer, never earlier than the stop came back", () => {
    const c = [{ key: "pr#12", value: "open", met: false }, { key: "job#5", value: "running", met: false }];
    const kept = (at: number, key = "pr#12") => ({ attempt: 1, at, what: `${WAIT_KEPT_ACTION}: ${key}`, ok: true });
    const waits = (actions: StopRecord["actions"], more: StopRecord[] = []) => brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: c }), ...more, stop({ conditions: c, actions, at: T0 + 5 * DAY })], now: T0 + 5 * DAY }));
    expect(waits([kept(T0 + 4 * DAY)])).toEqual([["depends", "pr#12", "PR #12", 4 * DAY, 7 * DAY], ["job", "job#5", "頼んだ仕事 job#5", 0, 6 * HOUR]]);
    expect(waits([kept(T0 + DAY), kept(T0 + 4 * DAY), { attempt: 3, at: T0 + 5 * DAY, what: "待ちが片づいた: pr#12", ok: true }])[0]).toEqual(["depends", "pr#12", "PR #12", 4 * DAY, 7 * DAY]);
    // an answer from before the stop was resolved and came back is older than its return
    expect(waits([kept(T0 + DAY)], [stop({ state: "resolved", at: T0 + 2 * DAY }), stop({ conditions: c, at: T0 + 3 * DAY })])[0]).toEqual(["depends", "pr#12", "PR #12", 3 * DAY, 6 * DAY]);
    // a date's limit is its time, or one more limit from the answer when that is later: answered past its time, it is not over at once
    const due = [{ key: "after", value: "2026-11-12T00:00:00Z", met: false }];
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: due, actions: [kept(T0 + DAY, "after:2026-11-12T00:00:00Z")] })] }))).toEqual([["date", "after:2026-11-12T00:00:00Z", "期日 2026-11-12T00:00:00Z", DAY, 4 * DAY]]);
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: due })] }))).toEqual([["date", "after:2026-11-12T00:00:00Z", "期日 2026-11-12T00:00:00Z", 0, 2 * DAY + 30 * MIN]]);
    // an answer older than the stop's return does not move a fixed limit either
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ conditions: due, actions: [kept(T0 + HOUR, "after:2026-11-12T00:00:00Z")] }), stop({ state: "resolved", at: T0 + 2 * HOUR }), stop({ conditions: due, actions: [kept(T0 + HOUR, "after:2026-11-12T00:00:00Z")], at: T0 + 3 * HOUR })], now: T0 + 3 * HOUR }))).toEqual([["date", "after:2026-11-12T00:00:00Z", "期日 2026-11-12T00:00:00Z", 3 * HOUR, 2 * DAY + 30 * MIN]]);
  });

  test("a depends stop that names nothing to wait for still has a limit", () => {
    expect(brief(of({ task: task({ outcome: "waits" }), stops: [stop({ op: "ci", target: "" })] }))).toEqual([["stop", "task_a/s1", "ci", 0, 3 * DAY]]);
  });

  test("shown: the runner's output only once it is over its limit; what is over and not the person's is asked about", () => {
    const waits = of({ task: task({ status: "running", outcome: "unknown", resumeAt: T0, resumeReason: null }), lastEventAt: T0 });
    expect(shownWaits(waits, T0 + 9 * MIN).map((w) => w.kind)).toEqual(["resume"]);
    expect(shownWaits(waits, T0 + 10 * MIN).map((w) => w.kind)).toEqual(["output", "resume"]);
    const person: WaitRecord = { kind: "person", key: "person", label: "利用者の対応", since: T0, until: T0 + DAY };
    expect(overWaits({ waits: [...waits, person] }, T0 + 20 * MIN).map((w) => w.kind)).toEqual(["output"]);
    expect(overWaits({ waits: [...waits, person] }, T0 + 2 * DAY).map((w) => w.kind)).toEqual(["output", "resume"]);
    expect(silentSince({ waits })).toBe(T0);
    expect(silentSince({ waits: [person] })).toBeNull();
  });
});

describe("checkWaits: the one look at every wait", () => {
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let broadcasts: ServerMessage[];
  let emit: (ev: AgentEvent) => void;
  let aborted: number;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const START: AgentEvent = { t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" };

  // a runner that says only what the test tells it to
  const adapter = (): RunnerAdapter => ({
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(opts, e) {
      emit = e;
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      // as the real runners do, the prompt comes back as the user's message
      queueMicrotask(() => {
        e(START);
        e({ t: "message.delta", role: "user", text: opts.prompt });
      });
      const session: RunnerSession = {
        send: (text) => {
          e({ t: "message.delta", role: "user", text });
          queueMicrotask(() => e(START));
        },
        respondPermission: () => undefined,
        abort: async () => {
          aborted++;
          resolveExit(null);
        },
        close: async () => resolveExit(0),
        exited,
      };
      return session;
    },
  } as RunnerAdapter);

  const look = (now: number) => checkWaits({ db, tasks, dir: waitsDirOf(home), bounds: () => BOUNDS, broadcastTask: (task) => broadcasts.push({ type: "task.updated", task }) }, now);
  const updates = (id: string) => broadcasts.filter((m): m is Extract<ServerMessage, { type: "task.updated" }> => m.type === "task.updated" && m.task.id === id);
  const stopsOf = (id: string) => db.listStopRecords([id]);
  const asks = (now: number) =>
    asksFromTasks({ approvals: [], tasks: db.listTasks(false), lastTurnQuestions: () => null, permissionEvents: () => [], stops: (t) => reduceStops(db.listStopRecords([t.id])), workspaceName: () => null, now });
  const cutFile = (taskId: string, label: string, at: number, over: Partial<WaitFile> = {}) => {
    mkdirSync(waitsDirOf(home), { recursive: true });
    writeFileSync(join(waitsDirOf(home), waitFileName(taskId, at % 100_000)), JSON.stringify(wfile({ taskId, pid: at % 100_000, label, startedAt: at - 30 * MIN, timeoutAt: at, cut: { reason: "timeout", at }, ...over })));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-waits-"));
    db = new Db(join(home, "db.sqlite"));
    broadcasts = [];
    aborted = 0;
    tasks = new TaskManager(db, new Map([["claude", adapter()]]), (m) => broadcasts.push(m), { idleMs: -1, holdQueue: true });
  });
  afterEach(async () => {
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("応答なし: a turn with no event past the limit is marked silent and asked about; the next event ends it at once", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    const now = Date.now();
    await look(now + 9 * MIN);
    expect(db.getTask(t.id)!.waits).toBeNull();
    broadcasts = [];
    await look(now + 11 * MIN);
    const marked = db.getTask(t.id)!;
    expect(marked.waits).toMatchObject([{ kind: "output", key: "output", label: "ランナーの出力" }]);
    expect(silentSince(marked)).toBeLessThanOrEqual(now);
    expect(updates(t.id).at(-1)!.task.waits).toEqual(marked.waits!);
    expect(marked.status).toBe("running"); // told, never stopped
    const silent = asks(now + 11 * MIN).filter((a) => a.id.startsWith("waitover:"));
    expect(silent).toMatchObject([{ kind: "wait", needs: "person", state: "open", route: "task", task: { id: t.id }, source: { taskId: t.id } }]);
    expect(silent[0]!.reason).toStartWith("応答なし: ランナーの出力が ");
    // looking again changes nothing and tells nobody
    broadcasts = [];
    await look(now + 12 * MIN);
    expect(updates(t.id)).toEqual([]);
    emit({ t: "message.delta", role: "assistant", text: "まだ動いています" });
    await settle();
    expect(db.getTask(t.id)!.waits).toBeNull();
    expect(updates(t.id).at(-1)!.task.waits).toBeNull();
    expect(asks(Date.now()).filter((a) => a.id.startsWith("waitover:"))).toEqual([]);
  });

  test("応答なし: a runner that keeps giving events through a long turn is never silent; an open approval and a finished turn are not either", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    const start = Date.now();
    // 30 minutes of a look every 9: an event came before each
    for (let i = 1; i <= 3; i++) {
      emit({ t: "status", text: `step ${i}` });
      await settle();
      await look(Date.now() + 9 * MIN);
      expect(db.getTask(t.id)!.waits).toBeNull();
    }
    expect(Date.now() - start).toBeLessThan(MIN);
    emit({ t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", detail: "rm -rf x" } as AgentEvent);
    await settle();
    expect(db.getTask(t.id)!.status).toBe("waiting");
    await look(Date.now() + HOUR);
    expect(db.getTask(t.id)!.waits!.map((w) => w.kind)).toEqual(["person"]);
    emit({ t: "permission.resolved", id: "p1", decision: "allow", by: "user" } as AgentEvent);
    emit({ t: "session.end", status: "ok", summary: "done" });
    await settle();
    await look(Date.now() + HOUR);
    expect(db.getTask(t.id)!.waits).toBeNull();
  });

  test("応答なし: a turn that ended on background jobs is silent too, unless an ops-kit wait says what it waits for", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    emit({ t: "background", count: 1, jobs: ["sleep 3600"] } as AgentEvent);
    emit({ t: "session.end", status: "ok", summary: "waiting" });
    await settle();
    expect(db.getTask(t.id)!.status).toBe("background");
    const now = Date.now();
    mkdirSync(waitsDirOf(home), { recursive: true });
    const record = join(waitsDirOf(home), waitFileName(t.id, process.pid));
    writeFileSync(record, JSON.stringify(wfile({ taskId: t.id, label: "local-ci の結果", startedAt: now, timeoutAt: now + 30 * MIN, progressAt: now })));
    await look(now + 11 * MIN);
    expect(db.getTask(t.id)!.waits).toEqual([{ kind: "command", key: `command:${process.pid}`, label: "local-ci の結果", since: now, until: now + 30 * MIN, progressAt: null, stallSec: null }]);
    // the command ended (its record is gone): the quiet is not explained any more
    rmSync(record);
    await look(now + 12 * MIN);
    expect(db.getTask(t.id)!.waits).toMatchObject([{ kind: "output", label: "裏の処理の知らせ" }]);
  });

  test("a wait past its limit is asked about: a resume that was due and never came", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    emit({ t: "session.end", status: "error", summary: "limit" });
    await settle();
    const due = Date.now();
    db.updateTask(t.id, { resumeAt: due, resumeReason: "limit", resumeSince: due - HOUR });
    await look(due + MIN);
    expect(db.getTask(t.id)!.waits).toEqual([{ kind: "resume", key: "resume", label: "使用上限の解除", since: due - HOUR, until: due + 30 * MIN }]);
    expect(asks(due + 29 * MIN).filter((a) => a.id.startsWith("waitover:"))).toEqual([]);
    const over = asks(due + 31 * MIN).filter((a) => a.id.startsWith("waitover:"));
    expect(over).toMatchObject([{ id: `waitover:${t.id}:resume@${due + 30 * MIN}`, kind: "wait", needs: "person", state: "open", answers: [] }]);
    expect(over[0]!.reason).toStartWith("待ちが上限を過ぎた: 使用上限の解除 を ");
    // the plan gone (resumed, or the person wrote): the wait is gone at the next look
    db.updateTask(t.id, { resumeAt: null });
    await look(due + 32 * MIN);
    expect(db.getTask(t.id)!.waits).toBeNull();
  });

  test("待ちが切れた: a cut ops-kit wait is a stop that waits for the person, and the Task goes on", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    const at = Date.now();
    cutFile(t.id, "PR 12 のマージ", at);
    await look(at + 1000);
    expect(readdirSync(waitsDirOf(home))).toEqual([]);
    expect(stopsOf(t.id)).toMatchObject([{ op: "wait", target: "PR 12 のマージ", reason: "decision", evidence: "待ちが上限（30 分）で切れた", state: "waiting", conditions: [] }]);
    expect(db.getTask(t.id)!.status).toBe("running");
    expect(aborted).toBe(0);
    expect(reduceStops(stopsOf(t.id))[0]!.next).toBe("decide");
    expect(asks(at + 1000).filter((a) => a.kind === "stop")).toMatchObject([{ needs: "person", state: "open", reason: "decision: 待ちが上限（30 分）で切れた", task: { id: t.id } }]);
    // a cut for want of progress says so
    cutFile(t.id, "相手の Task のログ", at + 5, { stallSec: 120, cut: { reason: "stalled", at: at + 5 } });
    await look(at + 2000);
    expect(stopsOf(t.id).at(-1)).toMatchObject({ target: "相手の Task のログ", evidence: "待ちが無進捗（120 秒）で切れた", state: "waiting" });
    // another wait is another series: the turn is not stopped
    expect(db.getTask(t.id)!.status).toBe("running");
    expect(aborted).toBe(0);
  });

  test("待ちが切れた: the same wait cut a second time, nothing new in between, stops the turn; after the person's answer it may be waited for again", async () => {
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    const at = Date.now();
    cutFile(t.id, "PR 12 のマージ", at);
    await look(at + 1000);
    cutFile(t.id, "PR 12 のマージ", at + 7);
    await look(at + 2000);
    expect(stopsOf(t.id).map((s) => s.state)).toEqual(["waiting", "exhausted"]);
    expect(aborted).toBe(1);
    expect(db.getTask(t.id)!.status).toBe("aborted");
    expect(db.listEvents(t.id).map((e) => e.ev).filter((e) => e.t === "status").map((e) => (e as { text: string }).text)).toContain(`${WAIT_REPEATED_NOTE}: PR 12 のマージ`);
    expect(reduceStops(stopsOf(t.id))[0]).toMatchObject({ count: 2, state: "exhausted", next: "decide" });
    expect(asks(at + 2000).filter((a) => a.kind === "stop")).toMatchObject([{ needs: "person", state: "open" }]);

    // the person answers (a reply): the same wait cut once more is a first cut again
    await tasks.send(t.id, "もう一度待ってよい");
    await settle();
    expect(db.getTask(t.id)!.status).toBe("running");
    cutFile(t.id, "PR 12 のマージ", at + 13);
    await look(at + 3000);
    expect(stopsOf(t.id).at(-1)!.state).toBe("waiting");
    expect(aborted).toBe(1);
    expect(db.getTask(t.id)!.status).toBe("running");
    // and cut yet again with no new answer, it stops the turn again
    cutFile(t.id, "PR 12 のマージ", at + 19);
    await look(at + 4000);
    expect(stopsOf(t.id).at(-1)!.state).toBe("exhausted");
    expect(aborted).toBe(2);
  });

  test("a cut wait of a Task that is gone is dropped, and nothing is written without a waits directory", async () => {
    expect(existsSync(waitsDirOf(home))).toBe(false);
    await look(Date.now());
    cutFile("task_gone", "x", Date.now());
    await look(Date.now());
    expect(readdirSync(waitsDirOf(home))).toEqual([]);
  });
});

describe("the daemon: the waits reach the screens through the Task's own answers", () => {
  test("a Task's ops-kit wait is in GET /api/tasks and /api/tasks/:id; past its limit it is one of /api/asks; the record gone, it is gone", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-waits-http-"));
    const envs: Array<Record<string, string> | undefined> = [];
    const runner = {
      id: "claude",
      async detect() {
        return { available: true };
      },
      start(opts, e) {
        envs.push(opts.env);
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        queueMicrotask(() => e({ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }));
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(null), close: async () => resolveExit(0), exited } as RunnerSession;
      },
    } as RunnerAdapter;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(h, "no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [runner], { port: 0, waitCheckMs: 20 });
    const b = `http://127.0.0.1:${c.server.port}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const get = (path: string) => fetch(`${b}${path}`).then((r) => r.json() as Promise<any>);
    const until = async (ok: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await ok()).toBe(true);
    };
    try {
      const made = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", prompt: "go", cwd: h, runner: "claude" }) });
      expect(made.status).toBeLessThan(300);
      const id: string = ((await made.json()) as { id: string }).id;
      await until(async () => envs.length > 0);
      // the Task's commands are told where to leave the record, by the kit's own names
      expect(envs[0]).toMatchObject({ OPS_KIT_WAITS_DIR: waitsDirOf(h), OPS_KIT_TASK_ID: id });
      const now = Date.now();
      const record = join(waitsDirOf(h), waitFileName(id, process.pid));
      mkdirSync(waitsDirOf(h), { recursive: true });
      writeFileSync(record, JSON.stringify(wfile({ taskId: id, label: "PR 12 のマージ", startedAt: now - HOUR, timeoutAt: now - MIN, progressAt: now - HOUR })));
      const shown = [{ kind: "command", key: `command:${process.pid}`, label: "PR 12 のマージ", since: now - HOUR, until: now - MIN, progressAt: null, stallSec: null }];
      await until(async () => !!(await get(`/api/tasks/${id}`)).task.waits);
      expect((await get(`/api/tasks/${id}`)).task.waits).toMatchObject(shown);
      expect((await get("/api/tasks")).find((t: Task) => t.id === id).waits).toMatchObject(shown);
      const over = (await get("/api/asks")).asks.filter((a: { id: string }) => a.id.startsWith("waitover:"));
      expect(over).toMatchObject([{ id: `waitover:${id}:command:${process.pid}@${now - MIN}`, needs: "person", state: "open", task: { id } }]);
      rmSync(record);
      await until(async () => !(await get(`/api/tasks/${id}`)).task.waits?.some((w: WaitRecord) => w.kind === "command"));
      expect((await get("/api/asks")).asks.filter((a: { id: string }) => a.id.startsWith("waitover:"))).toEqual([]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("checkWaits: which stopped Tasks are looked at", () => {
  let home: string;
  let db: Db;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-waits-stopped-"));
    db = new Db(join(home, "db.sqlite"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const none = { lastEvents: () => new Map<string, number>(), queueWait: () => null, queueRefusal: () => null, recordStop: () => ({ ok: false as const, why: "" }), record: () => undefined, abort: async () => { throw new Error("not called"); } };
  const look = (now: number) => checkWaits({ db, tasks: none, dir: waitsDirOf(home), bounds: () => BOUNDS, broadcastTask: () => undefined }, now);
  const stopped = (id: string, updatedAt: number, stage: number | null = null) => {
    db.insertTask({ id, workspaceId: stage === null ? null : "ws", title: id, runner: "claude", cwd: home, scope: [home], status: "done", runnerSessionId: "s", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "waits", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: stage === null ? null : { issue: stage, action: "complete" }, statusAt: updatedAt, createdAt: updatedAt, updatedAt });
    db.appendEvent(id, { t: "stop.record", stop: { id: `${id}/s1`, work: { workspaceId: stage === null ? null : "ws", issue: stage, taskId: id }, op: "merge", target: "", reason: "depends", evidence: "", safety: "unknown", conditions: [{ key: "pr#12", value: "open", met: false }], answer: null, actions: [], state: "waiting", at: updatedAt } });
    db.sqlite.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  };

  test("a Task stopped on a PR is looked at while the daemon still resumes it, and then for as long as its wait lasts; old ones from before are not dug up; a stage Task another took over waits for nothing", async () => {
    const now = Date.now();
    stopped("task_recent", now - DAY);
    stopped("task_old", now - 30 * DAY);
    stopped("task_stage_old", now - 2 * DAY, 7);
    stopped("task_stage_new", now - DAY, 7);
    await look(now);
    expect(db.getTask("task_recent")!.waits).toMatchObject([{ kind: "depends", key: "pr#12", label: "PR #12" }]);
    expect(db.getTask("task_old")!.waits).toBeNull();
    expect(db.getTask("task_stage_old")!.waits).toBeNull();
    expect(db.getTask("task_stage_new")!.waits).toHaveLength(1);
    // ten days on, the daemon no longer resumes it — the wait is still shown, over its limit, until it ends
    await look(now + 10 * DAY);
    expect(overWaits(db.getTask("task_recent")!, now + 10 * DAY)).toHaveLength(1);
    // reviewed by the person: gone
    db.updateTask("task_recent", { reviewedAt: now + 10 * DAY });
    await look(now + 10 * DAY);
    expect(db.getTask("task_recent")!.waits).toBeNull();
  });

  test("the watch asks for the refusal of each queued Task by its id", async () => {
    const now = Date.now();
    stopped("task_refused", now);
    stopped("task_plain", now);
    for (const id of ["task_refused", "task_plain"]) db.sqlite.query("UPDATE tasks SET status = 'idle', outcome = 'unknown', queued_at = ? WHERE id = ?").run(now, id);
    const tasks = { ...none, queueWait: () => "slot" as const, queueRefusal: (id: string) => (id === "task_refused" ? "budget exceeded" : null) };
    await checkWaits({ db, tasks, dir: waitsDirOf(home), bounds: () => BOUNDS, broadcastTask: () => undefined }, now);
    expect(db.getTask("task_refused")!.waits?.find((w) => w.kind === "queue")?.label).toBe("返信の開始の条件（budget exceeded）");
    expect(db.getTask("task_plain")!.waits?.find((w) => w.kind === "queue")?.label).toBe("実行枠の空き");
  });
});

describe("the daemon: a wait past its limit of a stopped Task is answered 止める or 待ち続ける", () => {
  const KEY = { service: "github" as const, host: "github.com", repository: "acme/app" };
  const PR5 = { objectKind: "pull-request" as const, externalId: "PR_5", remote: { number: 5, state: "MERGED", isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: "", files: [], closedAt: null, mergedAt: null, head: null }, fetchState: "fetched" } as BacklogSnapshotEntry;
  /** A daemon with one Task whose turn ended, stopped four days ago on `pr#5` (its wait is a day past the limit), and the question for that wait. */
  const stoppedOnPr = async (over: { reason?: "depends" | "usage-limit"; conditions?: Array<{ key: string; value: string; met: boolean }> } = {}) => {
    const h = mkdtempSync(join(tmpdir(), "sb-waits-answer-"));
    const sends: string[] = [];
    const turn: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "session.end", status: "ok", summary: "done" }];
    const runner = {
      id: "claude",
      async detect() {
        return { available: true };
      },
      start(_opts, e) {
        let resolveExit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (resolveExit = r));
        const play = () => queueMicrotask(() => turn.forEach(e));
        play();
        return { send: (text: string) => (sends.push(text), play()), respondPermission: () => undefined, abort: async () => resolveExit(null), close: async () => resolveExit(0), exited } as RunnerSession;
      },
    } as RunnerAdapter;
    const never = () => new Promise<never>(() => undefined);
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(h, "no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [runner], { port: 0, waitCheckMs: 20, judge: never, rubricJudge: never, titleSuggester: never, gh: async () => ({ code: 1, stdout: "", stderr: "no gh in this test" }) });
    const b = `http://127.0.0.1:${c.server.port}`;
    const until = async (ok: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 150 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await ok()).toBe(true);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overAsks = async (): Promise<any[]> => ((await (await fetch(`${b}/api/asks`)).json()) as { asks: Array<{ id: string }> }).asks.filter((a) => a.id.startsWith("waitover:"));
    const answer = (id: string, a: object) => fetch(`${b}/api/asks/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, answer: a }) });
    c.db.upsertWorkspace({ id: "ws_app", name: "app", path: h, kind: "repo" });
    c.db.setWorkspaceBacklogSource("ws_app", { ...KEY, project: { owner: "acme", number: 1 }, private: true });
    const t = c.tasks.create({ cwd: h, title: "t", prompt: "go", runner: "claude", workspaceId: "ws_app" });
    await until(() => c.db.getTask(t.id)!.status === "done");
    const came = Date.now() - 4 * DAY;
    c.db.appendEvent(t.id, { t: "stop.record", stop: { id: `${t.id}/s1`, work: { workspaceId: "ws_app", issue: null, taskId: t.id }, op: "merge", target: "", reason: over.reason ?? "depends", evidence: "", safety: "unknown", conditions: over.conditions ?? [{ key: "pr#5", value: "open", met: false }], answer: null, actions: [], state: "waiting", at: came } });
    c.db.sqlite.query("UPDATE tasks SET outcome = 'waits' WHERE id = ?").run(t.id);
    await until(async () => (await overAsks()).length === 1);
    const [ask] = await overAsks();
    const stopNow = () => c.db.listStopRecords([t.id]).at(-1)!;
    const prMerged = () => c.db.putBacklogSnapshot(KEY, { records: [PR5], cursor: null, syncedAt: Date.now() });
    const resume = () => resumeDepends({ db: c.db, tasks: c.tasks, workspaceId: "ws_app", now: Date.now() });
    const close = async () => {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    };
    return { c, t, came, ask, sends, overAsks, answer, stopNow, prMerged, resume, until, close };
  };

  test("止める: the stop that makes the wait is resolved, the question is gone from the open ones, and the Task is not resumed when the PR ends later", async () => {
    const d = await stoppedOnPr();
    try {
      expect(d.ask).toMatchObject({ id: `waitover:${d.t.id}:pr#5@${d.came + DEPENDS_LIMIT_MS}`, kind: "wait", needs: "person", state: "open", wait: { kind: "depends", key: "pr#5" }, choices: ["止める", "待ち続ける"], answers: ["choice"], next: WAIT_ANSWER_NEXT, policy: { scopes: [] } });
      // an answer that is not one of the two choices writes nothing
      for (const a of [{ kind: "choice", choice: "進める" }, { kind: "text", text: "止める" }]) {
        const refused = await d.answer(d.ask.id, a);
        expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, "選択肢が変わりました"]);
      }
      expect(d.stopNow()).toMatchObject({ state: "waiting", actions: [] });
      const r = await d.answer(d.ask.id, { kind: "choice", choice: "止める" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ask: { id: d.ask.id, state: "answered", answers: [] }, already: false });
      expect(d.stopNow()).toMatchObject({ id: `${d.t.id}/s1`, state: "resolved", actions: [{ what: `${WAIT_STOPPED_ACTION}: pr#5`, ok: true }] });
      // gone at once, not at the watch's next look: the Task's waits were worked out again with the answer
      expect((await d.overAsks()).filter((a) => a.state === "open")).toEqual([]);
      expect(d.c.db.getTask(d.t.id)!.waits).toBeNull();
      // the PR ends later: nothing is sent to the Task
      d.prMerged();
      expect(await d.resume()).toEqual([]);
      await new Promise((r) => setTimeout(r, 40));
      expect(d.sends).toEqual([]);
    } finally {
      await d.close();
    }
  });

  test("待ち続ける on another runner's limit only adds its action: no resume is planned and nothing is said to the Task", async () => {
    const d = await stoppedOnPr({ reason: "usage-limit", conditions: [{ key: "runner#codex", value: new Date(Date.now() - 2 * DAY).toISOString(), met: false }] });
    try {
      expect(d.ask).toMatchObject({ wait: { kind: "resume", key: "runner#codex" }, answers: ["choice"] });
      const events = d.c.db.listEvents(d.t.id).length;
      const r = await d.answer(d.ask.id, { kind: "choice", choice: "待ち続ける" });
      expect(r.status).toBe(200);
      expect(d.stopNow()).toMatchObject({ state: "waiting", actions: [{ what: "利用者が待ち続けると答えた: runner#codex" }] });
      await new Promise((r) => setTimeout(r, 100));
      expect(d.c.db.getTask(d.t.id)).toMatchObject({ resumeAt: null, status: "done" });
      // the stop's record with the action, and nothing else: no line about a planned resume
      expect(d.c.db.listEvents(d.t.id).length).toBe(events + 1);
      expect(d.sends).toEqual([]);
      expect((await d.overAsks()).filter((a) => a.state === "open")).toEqual([]);
    } finally {
      await d.close();
    }
  });

  test("待ち続ける: the stop stays open and the limit counts again from the answer — past it the question is asked again; the Task is resumed when the PR ends", async () => {
    const d = await stoppedOnPr();
    try {
      const r = await d.answer(d.ask.id, { kind: "choice", choice: "待ち続ける" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ask: { id: d.ask.id, state: "answered", answers: [] }, already: false });
      const kept = d.stopNow();
      expect(kept).toMatchObject({ state: "waiting", conditions: [{ key: "pr#5", met: false }], actions: [{ what: `${WAIT_KEPT_ACTION}: pr#5`, ok: true }] });
      const at = kept.actions[0]!.at;
      expect((await d.overAsks()).filter((a) => a.state === "open")).toEqual([]);
      expect(d.c.db.getTask(d.t.id)!.waits).toMatchObject([{ kind: "depends", key: "pr#5", since: at, until: at + DEPENDS_LIMIT_MS }]);
      // the limit (the setting's, as it was) past the answer, and still waiting: the same wait is asked about again
      const later = at + DEPENDS_LIMIT_MS + MIN;
      await checkWaits({ db: d.c.db, tasks: d.c.tasks, dir: waitsDirOf(d.c.db.getTask(d.t.id)!.cwd), bounds: () => boundsOf(QuotaAndResumeSettings.parse({})), broadcastTask: () => undefined }, later);
      const again = asksFromTasks({ approvals: [], tasks: [d.c.db.getTask(d.t.id)!], lastTurnQuestions: () => null, permissionEvents: () => [], stops: () => [], workspaceName: () => "app", now: later }).filter((a) => a.id.startsWith("waitover:"));
      expect(again).toMatchObject([{ id: `waitover:${d.t.id}:pr#5@${at + DEPENDS_LIMIT_MS}`, state: "open", wait: { kind: "depends", key: "pr#5" }, choices: ["止める", "待ち続ける"], answers: ["choice"] }]);
      // the PR ends: the Task goes on as before
      d.prMerged();
      expect(await d.resume()).toEqual([d.t.id]);
      await d.until(() => d.sends.length === 1);
    } finally {
      await d.close();
    }
  });
});

test("laterScheduleTaskDone: when a later run of the same schedule ended as done — not a run still going, another schedule's, an earlier one, or for a stage Task", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-waits-later-"));
  const db = new Db(join(home, "db.sqlite"));
  try {
    const mk = (id: string, scheduleId: string | null, createdAt: number, status: Task["status"], stage: number | null = null) => {
      db.insertTask({ id, workspaceId: stage === null ? null : "ws", title: id, runner: "claude", cwd: home, scope: [home], status, runnerSessionId: "s", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: stage === null ? null : { issue: stage, action: "complete" }, statusAt: createdAt, createdAt, updatedAt: createdAt + MIN });
      db.sqlite.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(createdAt + MIN, id);
    };
    mk("task_first", "sch_1", T0, "done");
    mk("task_other", "sch_2", T0 + HOUR, "done");
    mk("task_none", null, T0, "done");
    expect([db.laterScheduleTaskDone("task_first"), db.laterScheduleTaskDone("task_none"), db.laterScheduleTaskDone("task_gone")]).toEqual([null, null, null]);
    mk("task_running", "sch_1", T0 + 2 * HOUR, "running");
    expect(db.laterScheduleTaskDone("task_first")).toBeNull();
    mk("task_done", "sch_1", T0 + 3 * HOUR, "done");
    expect(db.laterScheduleTaskDone("task_first")).toBe(T0 + 3 * HOUR + MIN);
    expect(db.laterScheduleTaskDone("task_done")).toBeNull();
    // a stage Task's wait is its Issue's to end
    mk("task_stage", "sch_3", T0, "done", 7);
    mk("task_stage_later", "sch_3", T0 + HOUR, "done");
    expect(db.laterScheduleTaskDone("task_stage")).toBeNull();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a daemon start ends the silences stored by the one before it (the runners are gone) and keeps the other waits", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-waits-start-"));
  const db = new Db(join(home, "db.sqlite"));
  try {
    const t0 = Date.now();
    const mk = (id: string) => db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: home, scope: [home], status: "done", runnerSessionId: "s", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "waits", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: t0, createdAt: t0, updatedAt: t0 });
    const pr: WaitRecord = { kind: "depends", key: "pr#12", label: "PR #12", since: t0, until: t0 + DAY };
    const silent: WaitRecord = { kind: "output", key: "output", label: "ランナーの出力", since: t0, until: t0 + MIN };
    mk("task_a");
    mk("task_b");
    db.setTaskWaits("task_a", [silent, pr]);
    db.setTaskWaits("task_b", [silent]);
    abortOrphanedTasks(db);
    expect(db.getTask("task_a")!.waits).toEqual([pr]);
    expect(db.getTask("task_b")!.waits).toBeNull();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
