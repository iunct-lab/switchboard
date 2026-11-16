import { describe, expect, test } from "bun:test";
import { allocationCells, parseShare, saveOrder, shareText } from "./allocation.ts";

const row = (share: number | null, actual: number) => ({ workspaceId: "w", share, mode: "continuing" as const, actual, shortfall: share === null ? null : share - actual });

describe("allocationCells", () => {
  test("over the share shows the points over with a plus", () => {
    expect(allocationCells(row(0.5, 0.93))).toEqual({ share: "50%", actual: "93%（+43）" });
  });
  test("under the share shows the points under with a minus", () => {
    expect(allocationCells(row(0.4, 0.1))).toEqual({ share: "40%", actual: "10%（−30）" });
  });
  test("no share: no share text and no gap", () => {
    expect(allocationCells(row(null, 0.07))).toEqual({ share: "", actual: "7%" });
  });
});

describe("parseShare", () => {
  test("empty is not set", () => {
    expect(parseShare("  ")).toBeNull();
  });
  test("percent to a 0〜1 part", () => {
    expect(parseShare("50")).toBe(0.5);
    expect(parseShare("33.3%")).toBe(0.333);
    expect(parseShare("0")).toBe(0);
    expect(parseShare("100")).toBe(1);
  });
  test("out of range or not a number is invalid", () => {
    expect(parseShare("101")).toBe("invalid");
    expect(parseShare("-5")).toBe("invalid");
    expect(parseShare("abc")).toBe("invalid");
  });
  test("shareText round-trips", () => {
    expect(shareText(0.333)).toBe("33.3");
    expect(shareText(null)).toBe("");
    expect(parseShare(shareText(0.29))).toBe(0.29);
  });
});

describe("saveOrder", () => {
  test("a cut is saved before a raise, so moving share between workspaces stays within the sum", () => {
    const changes = [
      { id: "a", from: 0.4, to: 0.6 },
      { id: "b", from: 0.5, to: 0.3 },
      { id: "c", from: null, to: 0.05 },
      { id: "d", from: 0.1, to: null },
    ];
    expect(saveOrder(changes).map((c) => c.id)).toEqual(["b", "d", "c", "a"]);
  });
});
