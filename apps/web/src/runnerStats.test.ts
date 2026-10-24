import { expect, test } from "bun:test";
import type { RoutingStats, RunnerId, RunnerStats } from "@switchboard/protocol";
import { countLabel, fmtMedianDuration, runnerRows, THIN_SAMPLE } from "./runnerStats.ts";

const rec = (runner: string, total: number): RunnerStats => ({ runner: runner as RunnerId, total, outcomes: { done: total, needs_action: 0, failed: 0, unknown: 0 }, medianCostUsd: 1, medianDurationMs: 60_000 });
const stats = (byRunner: RunnerStats[]): RoutingStats => ({ rule: { total: 0, agreed: 0 }, llm: { total: 0, agreed: 0 }, otherTotal: 0, days: 30, byRunner });

test("runnerRows: every runner gets a row, and fewer than 5 records is thin (#612)", () => {
  expect(THIN_SAMPLE).toBe(5);
  const rows = runnerRows(stats([rec("newrunner", 7), rec("codex", 5), rec("claude", 4)]), ["claude", "codex", "dak"]);
  // (c) the given order, a runner only the daemon knows at the end
  expect(rows.map((r) => r.runner)).toEqual(["claude", "codex", "dak", "newrunner"]);
  // (b) 4 is thin, 5 is not
  expect(rows.map((r) => [r.total, r.thin])).toEqual([[4, true], [5, false], [0, true], [7, false]]);
  // (a) a runner with no record in the window is a zero row, not a missing one
  expect(rows[2]).toEqual({ runner: "dak", total: 0, outcomes: { done: 0, needs_action: 0, failed: 0, unknown: 0 }, medianCostUsd: null, medianDurationMs: null, thin: true });
});

test("the count cell says a thin runner is not worth comparing, and a short median is in seconds (#612)", () => {
  const [claude, codex, dak] = runnerRows(stats([rec("claude", 4), rec("codex", 5)]), ["claude", "codex", "dak"]);
  expect(countLabel(claude!)).toBe("比べるには記録が少ない（4 件）");
  expect(countLabel(codex!)).toBe("5");
  expect(countLabel(dak!)).toBe("比べるには記録が少ない（0 件）");
  expect(fmtMedianDuration(null)).toBe("—");
  expect(fmtMedianDuration(20_000)).toBe("20 秒");
  expect(fmtMedianDuration(1_200_000)).toBe("20 分");
});

test("runnerRows: a thin sample count from the settings (#835) replaces the default", () => {
  const rows = runnerRows(stats([rec("claude", 3), rec("codex", 1)]), ["claude", "codex"], 2);
  expect(rows.map((r) => [r.runner, r.thin])).toEqual([["claude", false], ["codex", true]]);
});
