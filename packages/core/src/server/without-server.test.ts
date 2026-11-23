// The functions that used to be closures of startServer take the context first: here they are called with a
// context made by hand (only the fields each one reads), with no daemon, port or runner.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ask, type Backlog, type BacklogQueue, StopRecord, type Task, type Workspace } from "@switchboard/protocol";
import type { NoticeRecord } from "../asks-notices.ts";
import { readQueue } from "../backlog-queue.ts";
import { Db } from "../db.ts";
import { answerAsk, currentAsks } from "./asks.ts";
import { readBacklog } from "./backlog-read.ts";
import { startNext } from "./backlog-next.ts";
import { queueOnce, startFromQueue } from "./queue.ts";

let home: string;
let db: Db;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchboard-test-without-server-"));
  db = new Db(join(home, "db.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

/** A context with only the fields the test gives: a field the function reads beyond them is undefined and the call fails. */
const contextFor = <F extends (sc: never, ...a: never[]) => unknown>(_fn: F, fields: Partial<Parameters<F>[0]>) => fields as Parameters<F>[0];
const notes = () => {
  const lines: string[] = [];
  return { lines, scheduler: { note: (line: string) => void lines.push(line), notes: (texts: string[]) => void lines.push(...texts) } as never };
};
const queue = (over: Partial<BacklogQueue>): BacklogQueue => ({ enabled: true, concurrency: 1, items: [], ended: [], lastNote: null, lastNoteAt: null, ...over });
const ask = (over: Partial<Ask>) => ({ id: "notice:scan@1", kind: "notice", state: "open", answers: ["dismiss"], blockers: [], task: null, issue: null, ...over }) as unknown as Ask;

describe("queueOnce without a server", () => {
  test("a queue that is off notes nothing; an enabled empty queue says so in the log and in the queue's last note", async () => {
    const off = notes();
    await queueOnce(contextFor(queueOnce, { prunedQueue: () => queue({ enabled: false }), scheduler: off.scheduler, db }), "saved");
    expect(off.lines).toEqual([]);
    expect(readQueue(db).lastNote).toBeNull();

    const on = notes();
    await queueOnce(contextFor(queueOnce, { prunedQueue: () => queue({}), scheduler: on.scheduler, db }), "saved");
    expect(on.lines).toEqual(["キュー: キューが空 (saved)"]);
    expect(readQueue(db).lastNote).toBe("キューが空");
  });

  test("as many 実装 Tasks as the queue's concurrency: nothing is read or started, and the note says why", async () => {
    const n = notes();
    const meta = db.upsertWorkspace({ name: "meta", path: home, kind: "meta" });
    const q = queue({ concurrency: 2, items: [{ workspaceId: meta.id, number: 7 }] });
    await queueOnce(contextFor(queueOnce, { prunedQueue: () => q, scheduler: n.scheduler, db, metaWorkspace: () => meta, queueRunning: () => 2 }), "task-end");
    expect(n.lines).toEqual(["キュー: 同時に動かす数 2 に達している (task-end)"]);
  });
});

describe("startFromQueue without a server", () => {
  test("a call while one runs joins it and makes it run once more; the shared marks are back to idle after", async () => {
    const n = notes();
    let runs = 0;
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const sc = contextFor(startFromQueue, { queueRun: null, queueAgain: false, scheduler: n.scheduler, queueOnce: async () => void (++runs === 1 && (await first)) });
    const a = startFromQueue(sc, "saved");
    const b = startFromQueue(sc, "import");
    expect(b).toBe(a);
    expect(sc.queueAgain).toBe(true);
    release();
    await a;
    expect(runs).toBe(2);
    expect(sc.queueRun).toBeNull();
    expect(sc.queueAgain).toBe(false);
  });

  test("a start that throws is noted with its reason and does not reject", async () => {
    const n = notes();
    const sc = contextFor(startFromQueue, { queueRun: null, queueAgain: false, scheduler: n.scheduler, queueOnce: async () => { throw new Error("gh is down"); } });
    await startFromQueue(sc, "boot");
    expect(n.lines).toEqual(["キュー: 始められない (boot): gh is down"]);
  });
});

describe("answerAsk without a server", () => {
  const asks = (list: Ask[]) => async () => ({ asks: list, batches: [], backlog: { fetchedAt: 0, items: [], errors: [], changes: [], syncs: [] } });

  test("a question that is gone is a 409 that says so, and one that was renewed names the current one", async () => {
    const gone = await answerAsk(contextFor(answerAsk, { currentAsks: asks([]) }), "decision:ws:5@1", { kind: "text", text: "A" });
    expect(gone).toMatchObject({ status: 409, body: { error: "問いがもうありません（対象の Issue が閉じたか、別の所で答えられました）", current: null } });

    const renewed = ask({ id: "decision:ws:5@2", kind: "decision" });
    const moved = await answerAsk(contextFor(answerAsk, { currentAsks: asks([renewed]) }), "decision:ws:5@1", { kind: "text", text: "A" });
    expect(moved).toMatchObject({ status: 409, body: { error: "問いが新しくなりました", current: { id: "decision:ws:5@2" } } });
  });

  test("dismissing a scan's notice closes it in the stored record with the hits it showed; any other answer is refused", async () => {
    const record: NoticeRecord = { "scan:ws": { id: "notice:scan@1", at: 1, resolvedAt: null, question: "q", source: "s", workspace: null, fingerprint: "a.ts:1 aws-key" } };
    db.setSetting("notices", record);
    const sc = contextFor(answerAsk, { currentAsks: asks([ask({})]), db, NOTICES_KEY: "notices" });
    expect(await answerAsk(sc, "notice:scan@1", { kind: "text", text: "ok" })).toMatchObject({ status: 422 });
    expect(db.getSetting<NoticeRecord>("notices", {})["scan:ws"]!.closed).toBeUndefined();

    const done = await answerAsk(sc, "notice:scan@1", { kind: "dismiss" });
    expect(done).toMatchObject({ status: 200, body: { already: false, ask: { state: "resolved", answers: [] } } });
    expect(db.getSetting<NoticeRecord>("notices", {})["scan:ws"]).toMatchObject({ closed: true, dismissed: "a.ts:1 aws-key" });
  });
});

/** A daemon that runs alone (no SWITCHBOARD_UPLINK): the sweep is this daemon's to run. */
const ALONE = { uplink: { mode: null }, candidate: false } as never;

describe("startNext without a server", () => {
  test("on a work machine the sweep chooses nothing, whoever fired it", async () => {
    const meta = db.upsertWorkspace({ name: "meta", path: home, kind: "meta" });
    expect(await startNext(contextFor(startNext, { cfg: { uplink: { mode: "send" }, candidate: false } as never, metaWorkspace: () => meta }), "sched-1")).toEqual({ started: [], skipped: ["作業場のマシンでは行いません（GitHub への書き込みと自動の判断は Switchboard 本体だけが行います）"] });
  });

  test("no meta workspace: nothing starts and the result says why", async () => {
    expect(await startNext(contextFor(startNext, { cfg: ALONE, metaWorkspace: () => undefined }), "sched-1")).toEqual({ started: [], skipped: ["meta workspace がありません"] });
  });

  test("a promotion that holds the firing is its whole result; a narrow firing that asked for one notes it on the schedule", async () => {
    const n = notes();
    const meta = db.upsertWorkspace({ name: "meta", path: home, kind: "meta" });
    const sc = contextFor(startNext, { cfg: ALONE, metaWorkspace: () => meta, askPromotion: async () => "v1.2.3 を昇格する", promotionHold: null, scheduler: n.scheduler, db });
    expect(await startNext(sc, "sched-1")).toEqual({ started: [], skipped: [], promotion: "v1.2.3 を昇格する" });
    expect(n.lines).toEqual([]);
    expect(await startNext(sc, "sched-1", { workspaceId: meta.id, numbers: [7] })).toMatchObject({ promotion: "v1.2.3 を昇格する" });
    expect(n.lines).toEqual(["バックログを進める: v1.2.3 を昇格する (待ちが解けた)"]);
  });
});

describe("currentAsks without a server", () => {
  const task = (id: string): Task =>
    ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/tmp", scope: [], status: "waiting", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgingAt: null, judgedBy: null, titlePending: false, stage: null, statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }) as Task;

  test("each Task's stop records are read once in one call, however many times the asks look at its stops", async () => {
    for (const [i, id] of ["tk_a", "tk_b"].entries()) {
      db.insertTask(task(id));
      db.appendEvent(id, { t: "stop.record", stop: StopRecord.parse({ id: `s_${id}`, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "CI が終わっていない", at: Date.now(), work: { workspaceId: "ws1", issue: 939 + i, taskId: id } }) });
    }
    const reads: string[][] = [];
    const counted = new Proxy(db, { get: (d, k) => (k === "listStopRecords" ? (ids: string[]) => (reads.push(ids), d.listStopRecords(ids)) : Reflect.get(d, k, d)) });
    const sc = contextFor(currentAsks, {
      db: counted,
      readBacklog: async () => ({ fetchedAt: 0, items: [], errors: [], changes: [], syncs: [] }),
      policyEnv: () => ({ policies: [], pbiOpen: () => false, approval: () => ({ subject: null, confirmHit: null }), confirm: () => null }) as never,
      tasks: { pendingApprovals: () => [] } as never,
      failed: () => null,
      mockupsOf: () => [],
      approvalPendingOf: () => () => false,
      tieAnswers: () => undefined,
      headMisses: new Map(),
      batchAnswers: { decorate: (b: never) => b } as never,
      currentNotices: () => [],
    });
    const { asks } = await currentAsks(sc);
    expect(asks.filter((a) => a.task !== null).map((a) => a.task!.id).sort()).toEqual(["tk_a", "tk_b"]);
    expect(reads.map((r) => r.join()).sort()).toEqual(["tk_a", "tk_b"]);
  });
});

describe("readBacklog without a server", () => {
  test("the settings are parsed once for a read of several workspaces, and a setting saved before the read is the one used", async () => {
    const metas = ["m1", "m2"].map((name) => (mkdirSync(join(home, name)), db.upsertWorkspace({ name, path: join(home, name), kind: "meta" })));
    let parsed = 0;
    let developSelf = false;
    const stored = async () => ({ items: [], changes: [], proceeding: [], error: null, fetchedAt: 1 });
    const sc = contextFor(readBacklog, {
      db,
      settings: () => ((parsed += 1), { developSelf } as never),
      backlog: {} as never,
      storedBacklogReleased: stored as never,
      withActive: (b: Backlog) => b,
      syncEntry: (ws: Workspace) => ({ workspaceId: ws.id }) as never,
    });
    expect((await readBacklog(sc, false)).syncs).toEqual([]);
    expect(parsed).toBe(1);
    developSelf = true;
    parsed = 0;
    expect((await readBacklog(sc, false)).syncs.map((s) => s.workspaceId).sort()).toEqual(metas.map((m) => m.id).sort());
    expect(parsed).toBe(1);
  });
});
