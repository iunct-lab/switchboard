import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { applyView, DEFAULT_VIEW, loadView, saveView, VIEW_KEY, viewSummary, type BacklogView } from "./backlogView.ts";

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
