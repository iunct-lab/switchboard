import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogAction, type AgentEvent, type Ask, type BacklogItem, type RunnerAdapter, type RunnerSession, type Task, type Workspace } from "@switchboard/protocol";
import { asksFromBacklog, unanswered } from "./asks.ts";
import { item } from "./api-test-harness.ts";
import { noteQueue, readQueue, saveQueue } from "./backlog-queue.ts";
import { SLOT_OF_ACTION } from "./backlog-item.ts";
import { Db } from "./db.ts";
import { nextStall, queueStallAsk, staleGrant, stallHolders } from "./queue-stall.ts";
import { queueOnce } from "./server/queue.ts";
import { reduceStops } from "./stops.ts";
import { TaskManager } from "./tasks/manager.ts";

let home: string;
let db: Db;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchboard-test-queue-stall-"));
  db = new Db(join(home, "db.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const hit = (ref: string, pbi: number | null, working = false) => ({ ref, path: "packages/core/src/a.ts", working, pbi });
const overlapped = (number: number, workspaceId: string, hits: NonNullable<BacklogItem["overlap"]>["hits"]) =>
  item({ number, workspaceId, stage: "ready", tasks: { total: 1, done: 0, doneAt: null }, overlap: { hits, unknown: null } });
const ready = (number: number, workspaceId: string) => item({ number, workspaceId, stage: "ready", tasks: { total: 1, done: 0, doneAt: null } });

describe("the stall's record", () => {
  test("a firing that starts nothing keeps the first since", () => {
    // two workspaces, each with its own holders: a PR holding two PBIs, a Task, and a place waited for
    const read = [
      { workspaceId: "ws_a", items: [overlapped(1, "ws_a", [hit("PR #9", 40)]), overlapped(2, "ws_a", [hit("PR #9", 40, true), { ...hit("Task #77", null), turn: 30 }])] },
      { workspaceId: "ws_b", items: [overlapped(1, "ws_b", [hit("Task #5", 3)])] },
    ];
    const holders = stallHolders(read);
    expect(holders).toEqual([
      { workspaceId: "ws_a", ref: "PR #9", pbi: 40, held: [1, 2], working: true },
      { workspaceId: "ws_a", ref: "#30 の順番", pbi: 30, held: [2], working: null },
      { workspaceId: "ws_b", ref: "Task #5", pbi: 3, held: [1], working: false },
    ]);

    saveQueue(db, { enabled: true, items: [{ workspaceId: "ws_a", number: 1 }, { workspaceId: "ws_b", number: 1 }] });
    noteQueue(db, ["進められる項目が無い"], 1_000, nextStall(readQueue(db).stall, { stalled: true, holders: holders.slice(0, 1) }, 1_000));
    noteQueue(db, ["進められる項目が無い"], 61_000, nextStall(readQueue(db).stall, { stalled: true, holders }, 61_000));
    // the first firing's time stays; the holders are the latest firing's, both workspaces'
    expect(readQueue(db).stall).toEqual({ since: 1_000, holders });
    expect(new Set(readQueue(db).stall!.holders.map((h) => h.workspaceId))).toEqual(new Set(["ws_a", "ws_b"]));
    // a firing that is not stalled ends it; the next stall starts afresh
    expect(nextStall(readQueue(db).stall, { stalled: false, holders }, 90_000)).toBeNull();
    expect(nextStall(null, { stalled: true, holders: [] }, 90_000)).toEqual({ since: 90_000, holders: [] });
  });

  test("the holders are the ten holding the most", () => {
    const items = Array.from({ length: 12 }, (_, k) => overlapped(k + 1, "ws_a", Array.from({ length: k + 1 }, (_, j) => hit(`PR #${100 + j}`, null))));
    const holders = stallHolders([{ workspaceId: "ws_a", items }]);
    expect(holders).toHaveLength(10);
    expect(holders.map((h) => h.held.length)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });
});

const SLOT_ACTIONS = BacklogAction.options.filter((a) => SLOT_OF_ACTION[a] === "implement");
const workspace = (name: string): Workspace => {
  const path = join(home, name);
  mkdirSync(path, { recursive: true });
  return db.upsertWorkspace({ name, path, kind: name === "meta" ? "meta" : "repo" });
};
/** queueOnce with the backlog `items` gives per workspace, `running` 実装 Tasks, `usage` per action, and a start that always starts. */
const fire = async (world: { items: Map<string, BacklogItem[]>; running: number; usage: (a: BacklogAction) => string; meta: Workspace; started: number[] }) => {
  const sc = {
    prunedQueue: () => readQueue(db),
    scheduler: { note: () => undefined, notes: () => undefined },
    db,
    metaWorkspace: () => world.meta,
    queueRunning: () => world.running,
    SLOT_ACTIONS,
    queueUsage: world.usage,
    backlogReads: () => true,
    withActive: (b: { items: BacklogItem[] }) => b,
    itemsToAdvance: async (ws: Workspace) => world.items.get(ws.id) ?? [],
    leftLines: () => [],
    settings: () => ({ quotaAndResume: { flowLimit: 1 } }),
    queueKey: (w: string, n: number) => `${w}:${n}`,
    startStage: async (input: { item: BacklogItem }) => {
      world.started.push(input.item.number);
      // a started PBI has its Task running from then on
      world.running++;
      return { task: { id: `tsk_${input.item.number}` } as Task };
    },
    storedBacklogReleased: async (ws: Workspace) => ({ items: world.items.get(ws.id) ?? [] }),
  };
  await queueOnce(sc as unknown as Parameters<typeof queueOnce>[0], "task-end");
  return readQueue(db).stall;
};

describe("queueOnce keeps the stall", () => {
  test("a start, a running Task or disabling clears the stall", async () => {
    const meta = workspace("meta");
    const a = workspace("a");
    const b = workspace("b");
    saveQueue(db, { enabled: true, concurrency: 2, items: [{ workspaceId: a.id, number: 1 }, { workspaceId: b.id, number: 2 }, { workspaceId: a.id, number: 3 }] });
    const items = new Map([[a.id, [overlapped(1, a.id, [hit("PR #9", 40)])]], [b.id, [overlapped(2, b.id, [hit("Task #5", 3, true)])]]]);
    const world = { items, running: 0, usage: () => "", meta, started: [] as number[] };

    // nothing to start, nothing running: stalled, held by both workspaces' holders; a second firing keeps its since
    const first = await fire(world);
    expect(first?.holders.map((h) => `${h.workspaceId} ${h.ref}`).sort()).toEqual([`${a.id} PR #9`, `${b.id} Task #5`].sort());
    expect((await fire(world))?.since).toBe(first!.since);

    // one starts: the stall ends
    items.set(a.id, [...items.get(a.id)!, ready(3, a.id)]);
    expect(await fire(world)).toBeNull();
    expect(world.started).toEqual([3]);

    // nothing more to start, but its Task runs: no stall
    items.set(a.id, [overlapped(1, a.id, [hit("PR #9", 40)])]);
    expect(world.running).toBe(1);
    expect(await fire(world)).toBeNull();

    // nothing running again: stalled; turned off, the stall is gone
    world.running = 0;
    expect(await fire(world)).not.toBeNull();
    saveQueue(db, { enabled: false });
    expect(readQueue(db).stall).toBeNull();
  });

  test("a firing held only by the usage limit records no stall", async () => {
    const meta = workspace("meta");
    const a = workspace("a");
    saveQueue(db, { enabled: true, items: [{ workspaceId: a.id, number: 1 }, { workspaceId: a.id, number: 3 }] });
    const items = new Map([[a.id, [overlapped(1, a.id, [hit("PR #9", 40)])]]]);
    const world = { items, running: 0, usage: (_: BacklogAction) => "", meta, started: [] as number[] };
    expect(await fire(world)).not.toBeNull();

    // a PBI that could go is left for its runner's usage limit: the firing starts nothing, and is no stall
    items.set(a.id, [...items.get(a.id)!, ready(3, a.id)]);
    world.usage = (action) => (action === "complete" ? "claude の使用量 five_hour が 95%（80% 以上）: 始めない" : "");
    expect(await fire(world)).toBeNull();
    expect(world.started).toEqual([]);
    expect(readQueue(db).lastNote).toContain("進められる項目が無い");

    // every runner at its limit returns early: no stall either
    world.usage = () => "claude の使用量 five_hour が 95%（80% 以上）: 始めない";
    expect(await fire(world)).toBeNull();
  });
});

const HOUR = 3_600_000;
/** The notice as `GET /api/asks` makes it, from the queue as stored now. */
const stallAsk = (over: Partial<Parameters<typeof queueStallAsk>[0]> & { now: number }) =>
  queueStallAsk({ queue: readQueue(db), running: 0, limitMs: HOUR, asks: [], pbiOf: () => null, refUrl: () => null, staleGrant: () => false, workspaceName: (id) => `name of ${id}`, ...over });
const question = (over: Partial<Ask> & { id: string }): Ask => ({
  ...unanswered,
  kind: "stop",
  needs: "person",
  state: "open",
  at: 0,
  changedAt: 0,
  workspace: { id: "ws_a", name: "a" },
  pbi: null,
  issue: null,
  task: null,
  reason: null,
  question: null,
  choices: [],
  recommendation: null,
  next: null,
  source: { label: "", url: null, taskId: null },
  route: "task",
  conditions: [],
  ...over,
});
const pbiRef = (number: number) => ({ number, title: `PBI ${number}`, url: `https://github.com/acme/app/issues/${number}` });
/** A runner whose every turn ends ok (depends-resume.test.ts's fake, cut down). */
function fakeAdapter(): RunnerAdapter {
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

describe("the stall's notice", () => {
  test("a queue with nothing to start for the limit raises one ask", () => {
    const read = [
      { workspaceId: "ws_a", items: [overlapped(1, "ws_a", [hit("PR #9", 40)])] },
      { workspaceId: "ws_b", items: [overlapped(1, "ws_b", [hit("Task #5", 3, true)])] },
    ];
    saveQueue(db, { enabled: true, items: [{ workspaceId: "ws_a", number: 1 }, { workspaceId: "ws_b", number: 1 }] });
    noteQueue(db, ["進められる項目が無い"], 1_000, nextStall(readQueue(db).stall, { stalled: true, holders: stallHolders(read) }, 1_000));

    // before the limit: none
    expect(stallAsk({ now: 1_000 + HOUR - 1 })).toBeNull();
    const first = stallAsk({ now: 1_000 + HOUR + 20 * 60_000 })!;
    expect(first).toMatchObject({ id: "notice:queue-stall@1000", kind: "notice", needs: "person", state: "open", at: 1_000, question: "キューが 1 時間 20 分止まっています", reason: "始められる PBI が無い（実装の Task 0 件）", answers: [] });
    // both workspaces' holders, by the same rule
    expect(first.stall!.holders.map((h) => `${h.workspace.name} ${h.ref} ${h.held}`).sort()).toEqual(["name of ws_a PR #9 1", "name of ws_b Task #5 1"]);

    // the next firing still starts nothing: still one, with the same id
    noteQueue(db, ["進められる項目が無い"], 2 * HOUR, nextStall(readQueue(db).stall, { stalled: true, holders: stallHolders(read) }, 2 * HOUR));
    const again = stallAsk({ now: 3 * HOUR });
    expect(again?.id).toBe(first.id);
    expect(again?.question).toBe("キューが 2 時間 59 分止まっています");
  });

  test("the ask names the top holders and what waits for the person", () => {
    // four holders in ws_a: PR 9 (PBI 40) holds 1, 2, 3; Task 5 (PBI 50) holds 1, 2; the place of PBI 30 holds 4; PR 11 (no PBI) holds 5
    const items = [
      overlapped(1, "ws_a", [hit("PR #9", 40), hit("Task #5", 50, true)]),
      overlapped(2, "ws_a", [hit("PR #9", 40), hit("Task #5", 50, true)]),
      overlapped(3, "ws_a", [hit("PR #9", 40)]),
      overlapped(4, "ws_a", [{ ...hit("Task #77", null), turn: 30 }]),
      overlapped(5, "ws_a", [hit("PR #11", null)]),
    ];
    saveQueue(db, { enabled: true, items: [1, 2, 3, 4, 5].map((number) => ({ workspaceId: "ws_a", number })) });
    noteQueue(db, ["進められる項目が無い"], 0, nextStall(null, { stalled: true, holders: stallHolders([{ workspaceId: "ws_a", items }]) }, 0));
    const asks = [
      // PBI 40's stage Task stopped for a merge (no pbi on it, its stage Issue): holds what PR 9 holds
      question({ id: "stop:tk_40", task: { id: "tk_40", title: "t", stageIssue: 40 }, question: "PR #12 のマージの許可", source: { label: "Task", url: null, taskId: "tk_40" } }),
      // PBI 50's decision: what Task 5 holds and the PBIs waiting for it, each once
      question({ id: "decision:ws_a#50@x", kind: "decision", pbi: pbiRef(50), issue: { number: 50, url: pbiRef(50).url }, question: "進め方の問い", source: { label: "#50", url: pbiRef(50).url, taskId: null }, waiting: [pbiRef(6), pbiRef(7), pbiRef(1)], at: 5 }),
      // a queued PBI's own check, holding nothing else
      question({ id: "check:tk_3", kind: "check", pbi: pbiRef(3), task: { id: "tk_3", title: "t" }, question: "昇格してよいか", source: { label: "Task", url: null, taskId: "tk_3" } }),
      // not listed: answered, automatic, a wait, a PBI neither queued nor holding, another workspace's PBI 40
      question({ id: "decision:ws_a#40@old", kind: "decision", pbi: pbiRef(40), state: "answered" }),
      question({ id: "stop:auto", needs: "auto", pbi: pbiRef(40) }),
      question({ id: "wait:ws_a#1@x", kind: "wait", pbi: pbiRef(1) }),
      question({ id: "decision:ws_a#99@x", kind: "decision", pbi: pbiRef(99) }),
      question({ id: "decision:ws_b#40@x", kind: "decision", workspace: { id: "ws_b", name: "b" }, pbi: pbiRef(40) }),
    ];
    const got = stallAsk({ now: HOUR, asks, pbiOf: (_w, n) => pbiRef(n), refUrl: (_w, ref) => `url of ${ref}` })!;
    expect(got.stall!.holders).toEqual([
      { workspace: { id: "ws_a", name: "name of ws_a" }, ref: "PR #9", url: "url of PR #9", pbi: pbiRef(40), held: 3, working: false },
      { workspace: { id: "ws_a", name: "name of ws_a" }, ref: "Task #5", url: "url of Task #5", pbi: pbiRef(50), held: 2, working: true },
      { workspace: { id: "ws_a", name: "name of ws_a" }, ref: "#30 の順番", url: "url of #30 の順番", pbi: pbiRef(30), held: 1, working: null },
    ]);
    expect(got.stall!.person).toEqual([
      { askId: "decision:ws_a#50@x", workspace: { id: "ws_a", name: "a" }, pbi: pbiRef(50), label: "判断待ち: 進め方の問い", taskId: null, url: pbiRef(50).url, held: 4, headMoved: false },
      { askId: "stop:tk_40", workspace: { id: "ws_a", name: "a" }, pbi: pbiRef(40), label: "止まり: PR #12 のマージの許可", taskId: "tk_40", url: null, held: 3, headMoved: false },
      { askId: "check:tk_3", workspace: { id: "ws_a", name: "a" }, pbi: pbiRef(3), label: "返事待ち: 昇格してよいか", taskId: "tk_3", url: null, held: 0, headMoved: false },
    ]);
  });

  test("an answer made stale by a moved head is listed as waiting again", async () => {
    const a = workspace("a");
    const tasks = new TaskManager(db, new Map([["claude", fakeAdapter()]]), () => undefined, { idleMs: -1 });
    try {
      // a turn ends when the fake has played it: wait for that, not for a fixed time (a loaded machine is slower)
      const settle = async (id: string) => {
        for (let k = 0; k < 500 && db.getTask(id)?.status !== "done"; k++) await new Promise((r) => setTimeout(r, 10));
        expect(db.getTask(id)!.status).toBe("done");
      };
      const merge = (pr: number, id = `merge-${pr}`) => ({ id, op: "gh pr merge", target: `PR #${pr}`, reason: "permission" as const, evidence: "マージ判定が聞く", safety: "unknown" as const, conditions: [], actions: [], state: "waiting" as const, grant: `PR #${pr} をマージしてよい` });
      const start = async (pbi: number) => {
        const t = tasks.create({ cwd: home, title: `#${pbi} を完了`, prompt: "go", runner: "claude", workspaceId: a.id, stage: { issue: pbi, action: "complete" } });
        await settle(t.id);
        return t;
      };
      const head = "a".repeat(40);
      // the stage Task of PBI 40 stops asking to merge PR 12, the person answers it, and the grant is recorded with PR 12's head then
      const same = await start(40);
      expect(tasks.recordStop(same.id, merge(12)).ok).toBe(true);
      // a reply in the stop's own millisecond reads as given before it (answerOwner), which no person's reply is: let the clock move on first
      const stoppedAt = Date.now();
      while (Date.now() <= stoppedAt) await new Promise((r) => setTimeout(r, 1));
      await tasks.send(same.id, "PR #12 をマージしてよい");
      await settle(same.id);
      db.recordMergeGrant({ taskId: same.id, repo: "acme/app", kind: "answer", target: 12, by: "owner", head });
      // the head moves: the gate asks again, and the same Task stops again with the same grant
      expect(tasks.recordStop(same.id, merge(12, "merge-12-again")).ok).toBe(true);
      // PBI 41's Task asks for PR 13, allowed to another Task only; PBI 42's for PR 14, allowed it with no head read
      const other = await start(41);
      expect(tasks.recordStop(other.id, merge(13)).ok).toBe(true);
      db.recordMergeGrant({ taskId: "tk_other", repo: "acme/app", kind: "answer", target: 13, by: "owner", head });
      const none = await start(42);
      expect(tasks.recordStop(none.id, merge(14)).ok).toBe(true);
      db.recordMergeGrant({ taskId: none.id, repo: "acme/app", kind: "answer", target: 14, by: "owner" });

      // the questions as GET /api/asks reads them: each PBI's stage Task's stop records, through the backlog's items
      const items = ([[40, same], [41, other], [42, none]] as const).map(([number, t]) => item({ number, workspaceId: a.id, stage: "in-progress", stopSummary: reduceStops(db.listStopRecords([t.id]), { newestTaskId: t.id }) }));
      const asks = asksFromBacklog(items, Date.now(), { taskOf: (id) => db.getTask(id) });
      const stopOf = (t: Task) => asks.find((q) => q.kind === "stop" && q.task?.id === t.id)!;
      // asked again after an answer, the stop waits by itself (not the person's to answer, as the stop rules say)
      expect(stopOf(same)).toMatchObject({ needs: "auto", state: "open", grant: "PR #12 をマージしてよい" });

      saveQueue(db, { enabled: true, items: [40, 41, 42].map((number) => ({ workspaceId: a.id, number })) });
      noteQueue(db, ["進められる項目が無い"], 0, nextStall(null, { stalled: true, holders: [] }, 0));
      const got = stallAsk({ now: HOUR, asks, staleGrant: (q) => staleGrant(q, "acme/app", (taskId, repo, kind, target) => db.lastOwnerGrant(taskId, repo, kind, target)) })!;
      const marks = Object.fromEntries(got.stall!.person.map((p) => [p.taskId, p.headMoved]));
      expect(marks).toEqual({ [same.id]: true, [other.id]: false, [none.id]: false });
      // a merge grant answers an answer question too, as the gate reads it (mergeGrantAt)
      db.recordMergeGrant({ taskId: none.id, repo: "acme/app", kind: "merge", target: 15, by: "owner", head });
      expect(db.lastOwnerGrant(none.id, "acme/app", "answer", 15)).not.toBeNull();
      expect(db.lastOwnerGrant(none.id, "acme/app", "merge", 16)).toBeNull();
    } finally {
      await tasks.shutdown();
    }
  });

  test("the ask goes once the queue starts something", async () => {
    const meta = workspace("meta");
    const a = workspace("a");
    saveQueue(db, { enabled: true, items: [{ workspaceId: a.id, number: 1 }, { workspaceId: a.id, number: 3 }] });
    const items = new Map([[a.id, [overlapped(1, a.id, [hit("PR #9", 40)])]]]);
    const world = { items, running: 0, usage: () => "", meta, started: [] as number[] };
    const since = (await fire(world))!.since;
    expect(stallAsk({ now: since + HOUR })?.id).toBe(`notice:queue-stall@${since}`);
    // an 実装 Task of the queue runs before the next firing: none, read now
    expect(stallAsk({ now: since + HOUR, running: 1 })).toBeNull();
    // disabled before the next firing: none, read now
    expect(stallAsk({ now: since + HOUR, queue: { ...readQueue(db), enabled: false } })).toBeNull();

    // one starts: the record is gone, and the ask with it
    items.set(a.id, [...items.get(a.id)!, ready(3, a.id)]);
    expect(await fire(world)).toBeNull();
    expect(stallAsk({ now: since + 2 * HOUR })).toBeNull();

    // stalled afresh, then turned off: none
    world.running = 0;
    items.set(a.id, [overlapped(1, a.id, [hit("PR #9", 40)])]);
    const next = (await fire(world))!.since;
    expect(stallAsk({ now: next + HOUR })).not.toBeNull();
    saveQueue(db, { enabled: false });
    expect(stallAsk({ now: next + HOUR })).toBeNull();
  });

  test("a usage limit alone raises none", async () => {
    const meta = workspace("meta");
    const a = workspace("a");
    saveQueue(db, { enabled: true, items: [{ workspaceId: a.id, number: 1 }, { workspaceId: a.id, number: 3 }] });
    const items = new Map([[a.id, [overlapped(1, a.id, [hit("PR #9", 40)]), ready(3, a.id)]]]);
    // the PBI that could go is left for its runner's usage limit: nothing starts, and no ask comes however long it lasts
    const world = { items, running: 0, usage: (action: BacklogAction) => (action === "complete" ? "claude の使用量 five_hour が 95%（80% 以上）: 始めない" : ""), meta, started: [] as number[] };
    expect(await fire(world)).toBeNull();
    expect(world.started).toEqual([]);
    expect(stallAsk({ now: Date.now() + 10 * HOUR })).toBeNull();
  });
});
