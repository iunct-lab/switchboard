import { expect, test } from "bun:test";
import type { Schedule } from "@switchboard/protocol";
import { stuckLine, stuckReason, stuckSchedules, type StuckSchedule } from "./stuck.ts";

const row = (id: string, stuck: Schedule["stuck"]): Schedule => ({ id, title: `定期 ${id}`, cron: "0 * * * *", workspaceId: "w", runner: "claude", model: null, effort: null, prompt: "", action: "prompt", budgetUsd: null, enabled: true, lastRunAt: null, lastTaskId: null, nextRunAt: null, lastResult: null, stuck, createdAt: 0 } as Schedule);
const stuck = (over: Partial<NonNullable<Schedule["stuck"]>> = {}) => ({ count: 11, reason: "decision", evidence: "lock が残っている", firstAt: 1_000_000, taskId: "t9", ...over });

test("stuckSchedules keeps only the rows with stuck, the longest-stuck first; none gives an empty list (no section)", () => {
  expect(stuckSchedules([row("a", null), row("b", null)])).toEqual([]);
  expect(stuckSchedules([row("a", stuck({ firstAt: 5 })), row("b", null), row("c", stuck({ firstAt: 2 }))]).map((s) => s.id)).toEqual(["c", "a"]);
});

test("stuckReason puts the reason's label before the stop's words; a code without a label is said as it is; no words = the label only", () => {
  expect(stuckReason(stuck())).toBe("判断待ち: lock が残っている");
  expect(stuckReason(stuck({ reason: "something-new", evidence: "x" }))).toBe("something-new: x");
  expect(stuckReason(stuck({ evidence: "  " }))).toBe("判断待ち");
});

test("stuckLine says the count, the reason, since when and that it no longer fires", () => {
  const s = row("a", stuck()) as StuckSchedule;
  const line = stuckLine(s, 1_000_000 + 3 * 24 * 60 * 60_000);
  for (const want of ["11 回続けて同じ理由", "判断待ち: lock が残っている", "3 日前から", "発火を止めている"]) expect(line).toContain(want);
});
