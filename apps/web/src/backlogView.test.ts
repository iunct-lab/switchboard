import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { applyView, DEFAULT_VIEW, itemMarks, loadView, resetView, saveView, VIEW_KEY, viewSummary, type BacklogView } from "./backlogView.ts";

const item = (number: number, over: Partial<BacklogItem> = {}): BacklogItem =>
  ({ number, title: `題 ${number}`, type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over }) as BacklogItem;
const view = (over: Partial<BacklogView>): BacklogView => ({ ...DEFAULT_VIEW, ...over });
const numbers = (items: BacklogItem[]) => items.map((i) => i.number);

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("sort", () => {
  const items = [
    item(1, { priority: "P2", storyPoints: 3, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }),
    item(2, { priority: null, storyPoints: null, createdAt: "", updatedAt: "" }),
    item(3, { priority: "P0", storyPoints: 8, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }),
    item(4, { priority: "P2", storyPoints: 5, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" }),
  ];
  test("default keeps the order given", () => {
    expect(numbers(applyView(items, DEFAULT_VIEW))).toEqual([1, 2, 3, 4]);
  });
  test("priority P0 first, equal priorities keep their order, unset last", () => {
    expect(numbers(applyView(items, view({ sort: "priority" })))).toEqual([3, 1, 4, 2]);
  });
  test("updated and created newest first, no date last", () => {
    expect(numbers(applyView(items, view({ sort: "updated" })))).toEqual([3, 1, 4, 2]);
    expect(numbers(applyView(items, view({ sort: "created" })))).toEqual([4, 1, 3, 2]);
  });
  test("story points largest first, unset last", () => {
    expect(numbers(applyView(items, view({ sort: "points" })))).toEqual([3, 4, 1, 2]);
  });
  test("an unknown priority sorts with the unset ones", () => {
    expect(numbers(applyView([item(1, { priority: "高" }), item(2, { priority: "P3" })], view({ sort: "priority" })))).toEqual([2, 1]);
    expect(numbers(applyView([item(1), item(2, { priority: "P9" }), item(3, { priority: "P3" })], view({ sort: "priority" })))).toEqual([3, 1, 2]);
  });
});

describe("filter", () => {
  const items = [
    item(10, { stage: "ready", type: "pbi", priority: "P1", title: "Backlog を並べ替える" }),
    item(11, { stage: "request", type: "request", priority: null, title: "ソートしたい" }),
    item(12, { stage: "in-progress", type: "pbi", priority: "P2", title: "ボード表示" }),
    item(120, { stage: "ready", type: "pbi", priority: "P2", title: "別の話" }),
  ];
  test("stage, type and priority keep only the matching rows; a row without a priority never matches one", () => {
    expect(numbers(applyView(items, view({ stages: ["ready"] })))).toEqual([10, 120]);
    expect(numbers(applyView(items, view({ types: ["request"] })))).toEqual([11]);
    expect(numbers(applyView(items, view({ priorities: ["P1", "P2"] })))).toEqual([10, 12, 120]);
  });
  test("the query matches part of a title, case-insensitively", () => {
    expect(numbers(applyView(items, view({ query: "backlog" })))).toEqual([10]);
    expect(numbers(applyView(items, view({ query: "  " })))).toEqual([10, 11, 12, 120]);
  });
  test("a number matches that number exactly, with or without #", () => {
    expect(numbers(applyView(items, view({ query: "12" })))).toEqual([12]);
    expect(numbers(applyView(items, view({ query: "#120" })))).toEqual([120]);
  });
  test("conditions combine, then sort", () => {
    expect(numbers(applyView(items, view({ stages: ["ready", "in-progress"], priorities: ["P2"], sort: "priority" })))).toEqual([12, 120]);
    expect(numbers(applyView(items, view({ types: ["pbi"], query: "ソート" })))).toEqual([]);
  });
});

describe("summary", () => {
  test("the default has none", () => {
    expect(viewSummary(DEFAULT_VIEW)).toBeNull();
    expect(viewSummary(view({ query: " " }))).toBeNull();
  });
  test("only the conditions in effect, joined by ·", () => {
    expect(viewSummary(view({ priorities: ["P1", "P2"], types: ["pbi"], sort: "priority" }))).toBe("P1, P2 · PBI · Priority 順");
    expect(viewSummary(view({ stages: ["ready", "needs-decision"], query: " 並べ " }))).toBe("Ready, 判断待ち · 「並べ」");
    expect(viewSummary(view({ sort: "points" }))).toBe("Story Points 順");
  });
});

describe("load", () => {
  test("a saved view reads back", () => {
    const s = memory();
    const v = view({ sort: "updated", stages: ["ready"], types: ["pbi"], priorities: ["P1"], query: "x" });
    saveView(s, v);
    expect(loadView(s)).toEqual(v);
  });
  test("saving the default removes what was kept", () => {
    const s = memory({ [VIEW_KEY]: JSON.stringify(view({ sort: "priority" })) });
    saveView(s, DEFAULT_VIEW);
    expect(s.m.has(VIEW_KEY)).toBe(false);
    expect(loadView(s)).toEqual(DEFAULT_VIEW);
  });
  test("nothing, broken JSON or another shape reads as the default", () => {
    expect(loadView(memory())).toEqual(DEFAULT_VIEW);
    expect(loadView(memory({ [VIEW_KEY]: "{" }))).toEqual(DEFAULT_VIEW);
    expect(loadView(memory({ [VIEW_KEY]: JSON.stringify({ ...DEFAULT_VIEW, sort: "title" }) }))).toEqual(DEFAULT_VIEW);
    expect(loadView(memory({ [VIEW_KEY]: JSON.stringify({ ...DEFAULT_VIEW, stages: ["done"] }) }))).toEqual(DEFAULT_VIEW);
    expect(loadView(memory({ [VIEW_KEY]: JSON.stringify({ sort: "default" }) }))).toEqual(DEFAULT_VIEW);
  });
});

describe("layout", () => {
  test("a board view reads back as a board", () => {
    const s = memory();
    saveView(s, view({ layout: "board" }));
    expect(loadView(s)).toEqual(view({ layout: "board" }));
    saveView(s, view({ layout: "board", priorities: ["P1"] }));
    expect(loadView(s)).toEqual(view({ layout: "board", priorities: ["P1"] }));
    // the queue (#3957) is kept and read back the same way
    saveView(s, view({ layout: "queue" }));
    expect(loadView(s)).toEqual(view({ layout: "queue" }));
  });
  test("a kept view without a layout, or with an unknown one, reads as the list", () => {
    const { layout: _, ...old } = view({ sort: "priority" });
    expect(loadView(memory({ [VIEW_KEY]: JSON.stringify(old) }))).toEqual(view({ sort: "priority", layout: "list" }));
    expect(loadView(memory({ [VIEW_KEY]: JSON.stringify({ ...view({ sort: "priority" }), layout: "grid" }) }))).toEqual(view({ sort: "priority", layout: "list" }));
  });
  test("the layout is not a condition: no summary line, and 元に戻す keeps it", () => {
    expect(viewSummary(view({ layout: "board" }))).toBeNull();
    expect(viewSummary(view({ layout: "board", sort: "points" }))).toBe("Story Points 順");
    expect(resetView(view({ layout: "board", sort: "points", priorities: ["P1"], query: "x" }))).toEqual(view({ layout: "board" }));
  });
  test("going back to the list removes what was kept", () => {
    const s = memory();
    saveView(s, view({ layout: "board" }));
    saveView(s, DEFAULT_VIEW);
    expect(s.m.has(VIEW_KEY)).toBe(false);
  });
});

describe("itemMarks", () => {
  // the shape inProgress.test.ts builds a row with: nothing to mark
  const row = (over: Partial<BacklogItem> = {}): BacklogItem =>
    item(1, { url: "https://github.com/o/r/issues/1", tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, waits: [], waitsAt: null, overlap: null, prereqs: [], stopSummary: [], ...over });
  const wait = (state: BacklogItem["waits"][number]["state"]) => ({ kind: "pr", number: 9, state, reason: "overlap", open: state !== "met", pbi: null }) as unknown as BacklogItem["waits"][number];
  const prereq = (state: BacklogItem["prereqs"][number]["state"]) => ({ number: 7, kind: "issue", need: "done", state, via: null }) as BacklogItem["prereqs"][number];
  const stop = (next: "decide" | "wait", state: "waiting" | "resolved" = "waiting", count = 1) =>
    ({ key: `k${next}${state}${count}`, op: "op", target: "", reason: "depends", evidence: "", count, state, lastAt: 1, lastAnswer: null, changes: [], actions: [], next }) as unknown as BacklogItem["stopSummary"][number];
  const keys = (i: BacklogItem, auto = false) => itemMarks(i, auto).map((x) => x.key);

  test("a row with nothing to mark has none", () => {
    expect(itemMarks(row(), false)).toEqual([]);
  });
  test("待ち while a wait is open; none once every wait is met", () => {
    expect(itemMarks(row({ waitsAt: "2026-11-01T00:00:00Z", waits: [wait("pending")] }), true)).toEqual([{ key: "waits", label: "待ち", warn: false }]);
    expect(keys(row({ waitsAt: "2026-11-01T00:00:00Z", waits: [wait("met")] }))).toEqual([]);
    expect(keys(row({ waitsAt: null, waits: [wait("pending")] }))).toEqual([]);
  });
  test("前提待ち for a pending prerequisite, 進められない (warn) for one a person fixes, none for a met one", () => {
    expect(itemMarks(row({ prereqs: [prereq("pending")] }), false)).toEqual([{ key: "prereq", label: "前提待ち", warn: false }]);
    expect(itemMarks(row({ prereqs: [prereq("withdrawn")] }), false)).toEqual([{ key: "stuck", label: "進められない", warn: true }]);
    expect(keys(row({ prereqs: [prereq("pending"), prereq("missing")] }))).toEqual(["prereq", "stuck"]);
    expect(keys(row({ prereqs: [prereq("met")] }))).toEqual([]);
  });
  test("重なり (warn) for a hit or an unknown overlap, none for an empty one", () => {
    expect(itemMarks(row({ overlap: { hits: [{ ref: "PR #5", path: "a.ts" }], unknown: null } as BacklogItem["overlap"] }), false)).toEqual([{ key: "overlap", label: "重なり", warn: true }]);
    expect(keys(row({ overlap: { hits: [], unknown: "読めない" } as BacklogItem["overlap"] }))).toEqual(["overlap"]);
    expect(keys(row({ overlap: { hits: [], unknown: null } as BacklogItem["overlap"] }))).toEqual([]);
  });
  test("停止 N counts the shown stops; warn when one needs a person; a resolved one-off is not shown", () => {
    expect(itemMarks(row({ stopSummary: [stop("wait"), stop("wait", "resolved", 2)] }), false)).toEqual([{ key: "stops", label: "停止 2", warn: false }]);
    expect(itemMarks(row({ stopSummary: [stop("wait"), stop("decide")] }), false)).toEqual([{ key: "stops", label: "停止 2", warn: true }]);
    expect(keys(row({ stopSummary: [stop("wait", "resolved", 1)] }))).toEqual([]);
  });
  test("返事待ち where the row's last Task line says so: a last Task not running; not on a needs-decision row", () => {
    const last = { id: "task_1", status: "done", updatedAt: 0 } as BacklogItem["lastTask"];
    expect(itemMarks(row({ replyWaiting: true, lastTask: last }), false)).toEqual([{ key: "reply", label: "返事待ち", warn: false }]);
    expect(keys(row({ stage: "in-progress", replyWaiting: true, lastTask: last }))).toEqual(["reply"]);
    expect(keys(row({ replyWaiting: true, lastTask: null }))).toEqual([]);
    expect(keys(row({ replyWaiting: true, lastTask: last, activeTaskId: "task_1" }))).toEqual([]);
    expect(keys(row({ replyWaiting: false, lastTask: last }))).toEqual([]);
  });
  test("a needs-decision row has none (its list card shows only the question, the sync line and 編集)", () => {
    expect(keys(row({ stage: "needs-decision", prereqs: [prereq("pending")], stopSummary: [stop("decide")] }))).toEqual([]);
  });
  test("the marks keep the order of the row's sections", () => {
    const i = row({
      waitsAt: "2026-11-01T00:00:00Z", waits: [wait("pending")], prereqs: [prereq("pending"), prereq("withdrawn")],
      overlap: { hits: [{ ref: "Task #4", path: "b.ts" }], unknown: null } as BacklogItem["overlap"], stopSummary: [stop("wait")],
      replyWaiting: true, lastTask: { id: "task_1", status: "done", updatedAt: 0 } as BacklogItem["lastTask"],
    });
    expect(keys(i)).toEqual(["waits", "prereq", "stuck", "overlap", "stops", "reply"]);
  });
});
