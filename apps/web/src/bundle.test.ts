// test-reads: apps/web/src/i18n.ts apps/web/src/i18n/bundle.ts apps/web/src/time.ts
import { describe, expect, test } from "bun:test";
import type { BundleHold } from "@switchboard/protocol";
import { canStartBundle, holdLine, parsePbiNumbers, unreadableHold } from "./bundle.ts";
import { jstClock } from "./time.ts";

const hold = (over: Partial<BundleHold> = {}): BundleHold => ({ taskId: "task_x", since: Date.UTC(2026, 10, 18, 11, 40), schedules: ["a", "b", "c"], base: "v1.529.4", ...over });

describe("bundle input and line", () => {
  test("parsePbiNumbers reads commas, spaces and #", () => {
    expect(parsePbiNumbers("5232, 5233 #5354,#5355")).toEqual([5232, 5233, 5354, 5355]);
    expect(parsePbiNumbers("7 7 8")).toEqual([7, 8]);
    expect(parsePbiNumbers("abc 0 -3 4.5 9")).toEqual([9]);
    expect(parsePbiNumbers("")).toEqual([]);
  });

  test("canStartBundle needs two and no hold", () => {
    expect(canStartBundle([1, 2], null)).toBe(true);
    expect(canStartBundle([1], null)).toBe(false);
    expect(canStartBundle([], null)).toBe(false);
    expect(canStartBundle([1, 2], hold())).toBe(false);
  });

  test("holdLine names the schedules, the time and the version", () => {
    const h = hold();
    const line = holdLine(h, h.since);
    expect(line).toBe(`束の作業中: 定期実行 3 件と昇格を止めています（${jstClock(h.since, h.since)} から、戻す先 v1.529.4）`);
    expect(holdLine(hold({ schedules: [], base: null }), h.since)).toContain("定期実行 0 件");
    expect(holdLine(hold({ base: null }), h.since)).toContain("戻す先 なし");
  });

  test("an unreadable hold shows no 1970 time and no Task", () => {
    const h = hold({ taskId: "不明", since: 0, schedules: [], base: null });
    expect(unreadableHold(h)).toBe(true);
    expect(unreadableHold(hold())).toBe(false);
    expect(holdLine(h, Date.UTC(2026, 10, 21))).toBe("束の作業中: 止めの記録が読めないため、定期実行と昇格を止めたものとして扱っています");
  });
});
