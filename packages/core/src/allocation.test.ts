import { expect, test } from "bun:test";
import { allocationOf, sweepOrder, weekWindowStart, type Spend } from "./allocation.ts";

const ws = (id: string, share: number | null) => ({ id, allocation: { share, mode: "continuing" as const } });
const three = [ws("a", 0.5), ws("b", 0.3), ws("c", 0.2)];
const noFlow = () => new Set<number>();

test("allocationOf: actual is each workspace's part of the spend and shortfall = share - actual, positive when under", () => {
  const spend: Spend[] = [
    { workspaceId: "a", issue: 1, costUsd: 80, billedUsd: 0 },
    { workspaceId: "b", issue: null, costUsd: 15, billedUsd: 0 },
    { workspaceId: "c", issue: 3, costUsd: 5, billedUsd: 0 },
  ];
  const r = allocationOf(three, spend, noFlow, 0.25);
  const by = Object.fromEntries(r.workspaces.map((w) => [w.workspaceId, w]));
  expect(by.a!.actual).toBeCloseTo(0.8);
  expect(by.a!.shortfall).toBeCloseTo(-0.3);
  expect(by.b!.shortfall).toBeCloseTo(0.15);
  expect(by.c!.shortfall).toBeCloseTo(0.15);
  expect(r.flow).toEqual({ limit: 0.25, actual: 0 });
});

test("allocationOf: a row with only billed_usd counts, and a workspace with no share has a null shortfall", () => {
  const r = allocationOf([ws("a", 0.5), ws("b", null)], [{ workspaceId: "a", issue: null, costUsd: 0, billedUsd: 10 }, { workspaceId: "b", issue: null, costUsd: 10, billedUsd: 0 }], noFlow, 0.25);
  expect(r.workspaces[0]!.actual).toBeCloseTo(0.5);
  expect(r.workspaces[1]).toMatchObject({ share: null, shortfall: null });
  expect(r.workspaces[1]!.actual).toBeCloseTo(0.5);
});

test("allocationOf: with nothing spent every actual is 0", () => {
  const r = allocationOf(three, [], noFlow, 0.25);
  expect(r.workspaces.map((w) => w.actual)).toEqual([0, 0, 0]);
  expect(r.workspaces.map((w) => w.shortfall)).toEqual([0.5, 0.3, 0.2]);
  expect(r.flow.actual).toBe(0);
});

test("allocationOf: flow actual is the part spent on flow-improvement Issues of the same workspace, billed included", () => {
  const spend: Spend[] = [
    { workspaceId: "a", issue: 7, costUsd: 20, billedUsd: 0 },
    { workspaceId: "a", issue: 8, costUsd: 60, billedUsd: 0 },
    { workspaceId: "b", issue: 7, costUsd: 0, billedUsd: 20 },
  ];
  // `#7` is flow in a only; in b the same number is an ordinary Issue
  const r = allocationOf(three, spend, (id) => (id === "a" ? new Set([7]) : new Set()), 0.25);
  expect(r.flow.actual).toBeCloseTo(0.2);
});

test("weekWindowStart: claude's seven_day reset minus 7 days; none, past, or another runner's window is the last 7 days", () => {
  const now = Date.UTC(2026, 10, 15);
  const day = 86400;
  const reset = now / 1000 + 2 * day;
  expect(weekWindowStart([{ runner: "claude", window: "seven_day", resetsAt: reset }], now)).toBe((reset - 7 * day) * 1000);
  expect(weekWindowStart([], now)).toBe(now - 7 * day * 1000);
  expect(weekWindowStart([{ runner: "claude", window: "seven_day", resetsAt: now / 1000 - 10 }], now)).toBe(now - 7 * day * 1000);
  expect(weekWindowStart([{ runner: "codex", window: "seven_day", resetsAt: reset }, { runner: "claude", window: "five_hour", resetsAt: reset }], now)).toBe(now - 7 * day * 1000);
});

const row = (workspaceId: string, share: number | null, actual: number) => ({ workspaceId, share, mode: "continuing" as const, actual, shortfall: share === null ? null : share - actual });

test("sweepOrder: the largest shortfall first, then no share in the given order, and those at or over their share are `over`", () => {
  const alloc = { workspaces: [row("a", 0.5, 0.45), row("b", 0.3, 0.1), row("c", null, 0.2), row("d", 0.2, 0.2), row("e", 0.1, 0.35)] };
  const r = sweepOrder(alloc, ["a", "b", "c", "d", "e", "f"]);
  expect(r.first).toEqual(["b", "a", "c", "f"]); // f is unknown to the allocation: no share
  expect(r.over).toEqual([{ workspaceId: "d", share: 0.2, actual: 0.2 }, { workspaceId: "e", share: 0.1, actual: 0.35 }]);
});

test("sweepOrder: with no share anywhere the given order stays and nothing is over", () => {
  expect(sweepOrder({ workspaces: [row("a", null, 0.5), row("b", null, 0.5)] }, ["b", "a"])).toEqual({ first: ["b", "a"], over: [] });
});
