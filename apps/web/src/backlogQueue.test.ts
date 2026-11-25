import { describe, expect, test } from "bun:test";
import type { BacklogItem, BacklogQueue } from "@switchboard/protocol";
import { dropIndex, holderOwner, moveEntry, noteParts, noteSummary, noteUrlOf, pickTop, queueFacts, queueSaver, queueSections, withRemoved, withWaiting } from "./backlogQueue.ts";

const item = (number: number, over: Partial<BacklogItem> = {}): BacklogItem =>
  ({ number, title: `題 ${number}`, type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", activeTaskId: null, workspaceId: "w1", workspaceName: "one", ...over }) as BacklogItem;
const queue = (over: Partial<BacklogQueue> = {}): BacklogQueue => ({ enabled: false, concurrency: 1, items: [], ended: [], lastNote: null, lastNoteAt: null, stall: null, ...over });
const e = (number: number, workspaceId = "w1") => ({ workspaceId, number });

describe("queueSections", () => {
  test("running = queued with a stage Task, waiting = the rest in the queue's order, an entry not read stays with no row", () => {
    const items = [item(1), item(2, { activeTaskId: "tsk" }), item(3), item(3, { workspaceId: "w2" })];
    const s = queueSections(queue({ items: [e(3), e(9), e(2), e(1)] }), items);
    expect(s.running.map((r) => r.entry.number)).toEqual([2]);
    expect(s.waiting.map((r) => [r.entry.number, r.item?.workspaceId ?? null])).toEqual([[3, "w1"], [9, null], [1, "w1"]]);
  });

  test("outside = the PBIs not queued that are Ready or not yet split, by Priority (none last); requests and other stages are not", () => {
    const items = [
      item(1, { priority: "P2" }),
      item(2, { stage: "needs-tasks", priority: "P0" }),
      item(3, { stage: "in-progress", priority: "P0" }),
      item(4, { type: "request", stage: "request", priority: "P0" }),
      item(5, { stage: "needs-decision", priority: "P0" }),
      item(6),
      item(7, { priority: "P1" }),
      item(7, { workspaceId: "w2", priority: "P3" }),
    ];
    const s = queueSections(queue({ items: [e(7)] }), items);
    expect(s.outside.map((i) => `${i.workspaceId}#${i.number}`)).toEqual(["w1#2", "w1#1", "w2#7", "w1#6"]);
  });

  test("ended is the queue's", () => {
    const ended = [{ workspaceId: "w1", number: 4, title: "t", at: 1, reason: "closed" as const }];
    expect(queueSections(queue({ ended }), []).ended).toEqual(ended);
  });
});

describe("withRemoved", () => {
  test("removes only the entry named; the same number of another workspace is another entry", () => {
    const q = queue({ items: [e(1), e(2)] });
    expect(withRemoved(q, e(1))).toEqual([e(2)]);
    expect(withRemoved(q, e(1, "w2"))).toEqual([e(1), e(2)]);
  });
});

describe("queueSaver", () => {
  type Q = { items: number[] };
  /** A daemon whose answers the test gives one by one; what the screen shows. */
  function rig() {
    const sent: Array<{ items: number[]; answer: (ok: boolean) => void }> = [];
    let stored: Q = { items: [] };
    let shown: Q | null = { items: [] };
    const failures: unknown[] = [];
    let slowReread = false;
    let failReread = false;
    let rereadLater = () => {};
    const save = queueSaver<Q, Q>({
      send: (input) =>
        new Promise((resolve, reject) => sent.push({ items: input.items, answer: (ok) => (ok ? ((stored = input), resolve(input)) : reject(new Error("refused"))) })),
      show: (f) => void (shown = f(shown)),
      apply: (_q, input) => input,
      reread: () => (failReread ? Promise.reject(new Error("unreachable")) : slowReread ? new Promise<Q>((resolve) => (rereadLater = () => resolve(stored))) : Promise.resolve(stored)),
      failed: (e) => void failures.push(e),
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { sent, save, shown: () => shown, stored: () => stored, failures, tick, slow: () => void (slowReread = true), unreachable: () => void (failReread = true), answerReread: () => rereadLater() };
  }

  test("two quick changes: shown at once, the second sent only after the first is answered, both kept", async () => {
    const r = rig();
    const a = r.save({ items: [1] });
    const b = r.save({ items: [1, 2] });
    expect(r.shown()).toEqual({ items: [1, 2] });
    await r.tick();
    expect(r.sent.map((s) => s.items)).toEqual([[1]]);
    r.sent[0]!.answer(true);
    await a;
    // the first answer is not shown over the newer change
    expect(r.shown()).toEqual({ items: [1, 2] });
    await r.tick();
    expect(r.sent.map((s) => s.items)).toEqual([[1], [1, 2]]);
    r.sent[1]!.answer(true);
    await b;
    expect(r.stored()).toEqual({ items: [1, 2] });
    expect(r.shown()).toEqual({ items: [1, 2] });
  });

  test("a failed save with a later one waiting does not read back over it; the later answer takes the place", async () => {
    const r = rig();
    const a = r.save({ items: [1] });
    const b = r.save({ items: [1, 2] });
    await r.tick();
    r.sent[0]!.answer(false);
    await a;
    expect(r.failures).toHaveLength(1);
    expect(r.shown()).toEqual({ items: [1, 2] });
    const c = r.save({ items: [1, 2, 3] });
    await r.tick();
    r.sent[1]!.answer(true);
    await b;
    await r.tick();
    r.sent[2]!.answer(true);
    await c;
    expect(r.stored()).toEqual({ items: [1, 2, 3] });
    expect(r.shown()).toEqual({ items: [1, 2, 3] });
  });

  test("a failed save that cannot be read back either shows no queue (the unsaved rows are not shown as saved)", async () => {
    const r = rig();
    r.unreachable();
    const a = r.save({ items: [1] });
    expect(r.shown()).toEqual({ items: [1] });
    await r.tick();
    r.sent[0]!.answer(false);
    await a;
    expect(r.failures.length).toBe(1);
    expect(r.shown()).toBeNull();
    expect(r.stored()).toEqual({ items: [] });
  });

  test("a change made while a failed save reads back is not overwritten by that read", async () => {
    const r = rig();
    r.slow();
    const a = r.save({ items: [1] });
    await r.tick();
    r.sent[0]!.answer(false);
    await r.tick();
    const b = r.save({ items: [2] });
    r.answerReread();
    await a;
    expect(r.shown()).toEqual({ items: [2] });
    await r.tick();
    r.sent[1]!.answer(true);
    await b;
    expect(r.shown()).toEqual({ items: [2] });
    expect(r.stored()).toEqual({ items: [2] });
  });

  test("the last save failing reads the stored queue back", async () => {
    const r = rig();
    const a = r.save({ items: [1] });
    await r.tick();
    r.sent[0]!.answer(true);
    await a;
    const b = r.save({ items: [1, 2] });
    await r.tick();
    r.sent[1]!.answer(false);
    await b;
    expect(r.shown()).toEqual({ items: [1] });
  });
});

describe("moveEntry / dropIndex / withWaiting", () => {
  test("moveEntry: up, down, the same place, out of range", () => {
    const xs = ["a", "b", "c", "d"];
    expect(moveEntry(xs, 2, 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveEntry(xs, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveEntry(xs, 1, 2)).toEqual(["a", "c", "b", "d"]);
    expect(moveEntry(xs, 1, 1)).toBe(xs);
    expect(moveEntry(xs, 4, 0)).toBe(xs);
    expect(moveEntry(xs, 0, -1)).toBe(xs);
  });

  test("dropIndex: between rows, above the first, below the last", () => {
    const mids = [10, 30, 50];
    expect(dropIndex(mids, 20)).toBe(1);
    expect(dropIndex(mids, 40)).toBe(2);
    expect(dropIndex(mids, -5)).toBe(0);
    expect(dropIndex(mids, 99)).toBe(3);
    expect(dropIndex([], 5)).toBe(0);
  });

  test("withWaiting: the waiting ones in the new order, the running ones where they were", () => {
    const q = queue({ items: [e(1), e(2), e(3), e(4)] });
    expect(withWaiting(q, [e(2)], [e(4), e(1), e(3)])).toEqual([e(4), e(2), e(1), e(3)]);
    expect(withWaiting(q, [], [e(3), e(1), e(2), e(4)])).toEqual([e(3), e(1), e(2), e(4)]);
  });
});

describe("pickTop", () => {
  const items = [
    item(1, { priority: "P2", storyPoints: 5, tasks: { total: 4, done: 1, doneAt: null }, createdAt: "2026-10-03T00:00:00Z" }),
    item(2, { stage: "needs-tasks", priority: "P0", storyPoints: null, tasks: null, createdAt: "2026-10-05T00:00:00Z" }),
    item(3, { priority: null, storyPoints: 2, tasks: { total: 2, done: 2, doneAt: null }, createdAt: "2026-10-01T00:00:00Z" }),
    item(4, { priority: "P1", storyPoints: 3, tasks: { total: 3, done: 0, doneAt: null }, createdAt: "2026-10-02T00:00:00Z", overlap: { hits: [{ ref: "PR #9", path: "a.ts", working: true, pbi: null }], unknown: null } }),
    item(5, { stage: "in-progress", priority: "P0" }),
    item(6, { type: "request", stage: "request", priority: "P0" }),
    item(7, { priority: "P0", storyPoints: 1 }),
  ].map((i) => ({ url: `https://github.com/acme/app/issues/${i.number}`, waits: [], waitsAt: null, waitsUntil: null, confirmations: [], prereqs: [], stopSummary: [], replyWaiting: false, lastTask: null, overlap: null, ...i }) as BacklogItem);
  const nums = (xs: BacklogItem[]) => xs.map((i) => i.number);
  const q = queue({ items: [e(7)] });

  test("the four axes, over the Ready and not yet split PBIs not in the queue", () => {
    expect(nums(pickTop(items, q, "priority", 12, true))).toEqual([2, 4, 1, 3]);
    expect(nums(pickTop(items, q, "progress", 12, true))).toEqual([3, 1, 4, 2]);
    expect(nums(pickTop(items, q, "small", 12, true))).toEqual([3, 4, 1, 2]);
    expect(nums(pickTop(items, q, "old", 12, true))).toEqual([3, 4, 1, 2]);
  });

  test("the number cuts the top, and the queued PBI is not taken again", () => {
    expect(nums(pickTop(items, q, "priority", 3, true))).toEqual([2, 4, 1]);
    expect(nums(pickTop(items, queue(), "priority", 3, true))).toEqual([2, 7, 4]);
  });

  test("without the waiting ones, a PBI with an overlap, a wait or a prerequisite is left out", () => {
    expect(nums(pickTop(items, q, "priority", 12, false))).toEqual([2, 1, 3]);
    const waiting = items.map((i) => (i.number === 1 ? ({ ...i, waits: [{ number: 9, kind: "pr", open: true, state: "pending", reason: "overlap", pbi: null }], waitsAt: "2026-10-04T00:00:00Z" } as BacklogItem) : i));
    expect(nums(pickTop(waiting, q, "priority", 12, false))).toEqual([2, 3]);
    // a prerequisite not done yet (前提) and one a person has to look at (進められない) leave it out too
    const prereq = (state: "pending" | "withdrawn") => [{ number: 77, kind: "issue" as const, need: "done" as const, state, via: [], confirming: false }];
    const held = items.map((i) => (i.number === 3 ? ({ ...i, prereqs: prereq("pending") } as BacklogItem) : i.number === 1 ? ({ ...i, prereqs: prereq("withdrawn") } as BacklogItem) : i));
    expect(nums(pickTop(held, q, "priority", 12, false))).toEqual([2]);
    expect(nums(pickTop(held, q, "priority", 12, true))).toEqual([2, 4, 1, 3]);
  });
});

describe("queueFacts / noteSummary", () => {
  test("queueFacts: workspace · Task n/m · SP · P · stage, the values it has only", () => {
    expect(queueFacts(item(1, { tasks: { total: 4, done: 1, doneAt: null }, storyPoints: 5, priority: "P2" }))).toBe("one · Task 1/4 · SP 5 · P2 · Ready");
    expect(queueFacts(item(2, { stage: "needs-tasks", tasks: null }))).toMatch(/^one · \S/);
    expect(queueFacts(item(2, { stage: "needs-tasks", tasks: null }))).not.toContain("Task 0");
    expect(queueFacts(item(2, { stage: "needs-tasks", tasks: null })).split(" · ")).toHaveLength(2);
  });

  test("noteSummary: what started and how many reasons, one line alone as it is", () => {
    expect(noteSummary("キューが空")).toEqual({ line: "キューが空", rest: 0 });
    expect(noteSummary("app: 前提: #1（PR #2 マージ待ち）\napp: 重なり: #3（PR #4: a.ts・PR #5: b.ts）\napp #6 を complete で開始 task_x")).toEqual({ line: "app #6 を complete で開始 task_x", rest: 2 });
    expect(noteSummary("app: 前提: #1（PR #2 マージ待ち）\napp: 保留: #7\n進められる項目が無い")).toEqual({ line: "進められる項目が無い", rest: 2 });
  });
});

describe("noteParts", () => {
  const urlOf = (w: string) => (w === "one" ? "https://github.com/o/r/issues/12" : null);
  test("links the holder, the planned resume and the checks-only numbers to the workspace's Issues and PRs", () => {
    expect(noteParts("one: Task #3007 が 3 件を止めている（作業していない）", urlOf)).toEqual(["one: ", { text: "Task #3007", url: "https://github.com/o/r/issues/3007" }, " が 3 件を止めている（作業していない）"]);
    expect(noteParts("one: 再開の予約: #2999（11/17 12:41 に再開）", urlOf)).toEqual(["one: 再開の予約: ", { text: "#2999", url: "https://github.com/o/r/issues/2999" }, "（11/17 12:41 に再開）"]);
    expect(noteParts("one: 利用者確認だけ: #3467 #2799", urlOf)).toEqual(["one: 利用者確認だけ: ", { text: "#3467", url: "https://github.com/o/r/issues/3467" }, " ", { text: "#2799", url: "https://github.com/o/r/issues/2799" }]);
    expect(noteParts("one: 重なり: PR #5170", urlOf)).toEqual(["one: 重なり: ", { text: "PR #5170", url: "https://github.com/o/r/pull/5170" }]);
  });
  test("a workspace that is not known, or a line with no workspace, stays a sentence", () => {
    expect(noteParts("two: Task #1 が 3 件を止めている", urlOf)).toEqual(["two: Task #1 が 3 件を止めている"]);
    expect(noteParts("進められる項目が無い", urlOf)).toEqual(["進められる項目が無い"]);
  });
  test("a known workspace whose URL is not an Issue / PR URL stays a sentence", () => {
    expect(noteParts("one: Task #1 が 3 件を止めている", () => "")).toEqual(["one: Task #1 が 3 件を止めている"]);
    expect(noteParts("one: Task #1 が 3 件を止めている", () => "https://example.com/board")).toEqual(["one: Task #1 が 3 件を止めている"]);
  });
  test("holder line opens the owner's Task: the PBI a hit with the same ref names in that workspace, and its stage Task", () => {
    const u = (n: number) => `https://github.com/o/r/issues/${n}`;
    const hit = (ref: string, pbi: number | null) => ({ ref, path: "src/a.ts", working: true, pbi });
    const items = [
      item(1, { url: u(1), overlap: { hits: [hit("PR #50", null), hit("Task #60", null)], unknown: null } }),
      item(2, { url: u(2), overlap: { hits: [hit("PR #50", 20), hit("Task #60", 30)], unknown: null } }),
      item(20, { url: u(20), title: "PBI 20", activeTaskId: "task_run" }),
      item(30, { url: u(30), title: "PBI 30", lastTask: null }),
      // another workspace's hit on the same ref names another PBI
      item(5, { workspaceId: "w2", workspaceName: "two", url: "https://github.com/x/y/issues/5", overlap: { hits: [hit("PR #50", 99)], unknown: null } }),
    ] as BacklogItem[];
    const of = (line: string) => holderOwner(line, items, (ws) => noteUrlOf(items, ws));
    expect(of("one: 実装の枠: PR #50 が 2 件を止めている（作業中）")).toEqual({ pbi: { number: 20, title: "PBI 20", url: u(20) }, task: { id: "task_run", running: true, label: "動いている" } });
    expect(of("one: Task #60 が 1 件を止めている（作業していない）")).toEqual({ pbi: { number: 30, title: "PBI 30", url: u(30) }, task: null });
    expect(of("two: PR #50 が 1 件を止めている（作業中）")).toMatchObject({ pbi: { number: 99, url: "https://github.com/x/y/issues/99" }, task: "unknown" });
    // no hit names a PBI, not a holder line, or a workspace not known: nothing
    expect(of("one: PR #77 が 1 件を止めている（作業中）")).toBeNull();
    expect(of("one: 重なり: PR #50")).toBeNull();
    expect(of("three: PR #50 が 2 件を止めている（作業中）")).toBeNull();
  });
  test("noteUrlOf: the workspace's Issue URL, none when two workspaces share the name", () => {
    const u = (n: number) => `https://github.com/o/r/issues/${n}`;
    expect(noteUrlOf([item(1, { url: u(1) }), item(2, { workspaceId: "w2", workspaceName: "two" })], "one")).toBe(u(1));
    expect(noteUrlOf([item(1, { url: u(1) }), item(2, { workspaceId: "w2", url: "https://github.com/x/y/issues/2" })], "one")).toBeNull();
    expect(noteUrlOf([item(1, { url: u(1) })], "three")).toBeNull();
    expect(noteUrlOf([item(1, { url: "https://example.com/kept" }), item(2, { url: u(2) })], "one")).toBe(u(2));
  });
});
