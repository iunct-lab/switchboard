// test-reads: apps/web/src/backlogQueue.ts
import { describe, expect, test } from "bun:test";
import type { BacklogItem, BacklogQueue } from "@switchboard/protocol";
import { pickTop } from "./backlogQueue.ts";
import { keepOpen, queueWithSelected, rowsOf, sameRows, selectable, selectedOf, toggleSelected } from "./backlogSelect.ts";

const item = (number: number, over: Partial<BacklogItem> = {}): BacklogItem =>
  ({ workspaceId: "ws_a", workspaceName: "A", number, title: `t${number}`, type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-11-01T00:00:00Z", ...over }) as BacklogItem;
const queue = (...items: Array<[string, number]>): BacklogQueue => ({ items: items.map(([workspaceId, number]) => ({ workspaceId, number })), ended: [] }) as unknown as BacklogQueue;
const e = (workspaceId: string, number: number) => ({ workspaceId, number });

describe("backlog selection", () => {
  test("queueWithSelected は既にキューにある組を足さず、選んだ順で末尾に足す", () => {
    const q = queue(["ws_a", 1], ["ws_a", 2]);
    expect(queueWithSelected(q, [e("ws_a", 5), e("ws_a", 2), e("ws_a", 4)])).toEqual([e("ws_a", 1), e("ws_a", 2), e("ws_a", 5), e("ws_a", 4)]);
  });

  test("queueWithSelected は同じ番号で workspaceId の違う 2 件を両方足す", () => {
    const q = queue(["ws_a", 1]);
    expect(queueWithSelected(q, [e("ws_b", 1), e("ws_a", 7), e("ws_b", 7)])).toEqual([e("ws_a", 1), e("ws_b", 1), e("ws_a", 7), e("ws_b", 7)]);
  });

  test("toggleSelected は選んだ順を保ち、もう一度で外す", () => {
    let s = toggleSelected([], e("ws_a", 3));
    s = toggleSelected(s, e("ws_b", 3));
    s = toggleSelected(s, e("ws_a", 1));
    expect(s).toEqual([e("ws_a", 3), e("ws_b", 3), e("ws_a", 1)]);
    expect(toggleSelected(s, e("ws_a", 3))).toEqual([e("ws_b", 3), e("ws_a", 1)]);
  });

  test("selectedOf(pickTop(…)) は pickTop と同じ PBI を同じ順で選ぶ", () => {
    const items = [item(1, { priority: "P2" }), item(2, { priority: "P0" }), item(3, { priority: "P1" }), item(4, { type: "request", stage: "request" } as Partial<BacklogItem>)];
    const q = queue(["ws_a", 1]);
    const top = pickTop(items, q, "priority", 5, true);
    expect(top.length).toBeGreaterThan(0);
    expect(selectedOf(top)).toEqual(top.map((i) => e(i.workspaceId, i.number)));
    expect(selectedOf(top).map((x) => x.number)).toEqual([2, 3]);
  });

  test("keepOpen は一覧に無い組を外す", () => {
    const items = [item(1), item(2, { workspaceId: "ws_b" })];
    const s = [e("ws_a", 1), e("ws_a", 2), e("ws_b", 2), e("ws_b", 1)];
    expect(keepOpen(s, items)).toEqual([e("ws_a", 1), e("ws_b", 2)]);
    expect(keepOpen([e("ws_a", 1)], items)).toEqual([e("ws_a", 1)]);
  });

  test("keepOpen は判断待ちになった PBI を外す", () => {
    const items = [item(1, { stage: "needs-decision" }), item(2)];
    expect(keepOpen([e("ws_a", 1), e("ws_a", 2)], items)).toEqual([e("ws_a", 2)]);
  });

  test("sameRows は同じ組が同じ順のときだけ真", () => {
    expect(sameRows([e("ws_a", 1), e("ws_a", 2)], [e("ws_a", 1), e("ws_a", 2)])).toBe(true);
    expect(sameRows([e("ws_a", 1), e("ws_a", 2)], [e("ws_a", 1)])).toBe(false);
    expect(sameRows([e("ws_a", 1), e("ws_a", 2)], [e("ws_a", 2), e("ws_a", 1)])).toBe(false);
    expect(sameRows([e("ws_a", 1)], [e("ws_b", 1)])).toBe(false);
  });

  test("selectable は判断待ちと要望を選ばせない", () => {
    expect(selectable(item(1))).toBe(true);
    expect(selectable(item(1, { stage: "needs-decision" }))).toBe(false);
    expect(selectable(item(1, { type: "request" } as Partial<BacklogItem>))).toBe(false);
  });

  test("rowsOf は選んだ順の行を返す", () => {
    const items = [item(1), item(2), item(3)];
    expect(rowsOf([e("ws_a", 3), e("ws_a", 9), e("ws_a", 1)], items).map((i) => i.number)).toEqual([3, 1]);
  });
});
