import { expect, test } from "bun:test";
import type { BacklogIssueData } from "@switchboard/protocol";
import { ownerPbiOf } from "./backlog-overlap.ts";

const issue = (number: number, parent: number | null): BacklogIssueData => ({ number, title: `Task ${number}`, url: "", state: "OPEN", stateReason: null, body: "", labels: ["type:task"], milestone: null, parent, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null });
const pull = (number: number, closes: number[]) => ({ number, isDraft: false, labels: [], closes, updatedAt: "2026-10-01T00:00:00Z", files: ["src/a.ts"], state: "OPEN" });

test("a hit names the PBI that owns it", () => {
  const issues = new Map([issue(21, 2), issue(22, null), issue(31, 3)].map((i) => [i.number, i]));
  // 22 has no parent and 40 is not stored: the first closed Issue that gives a parent decides
  const pulls = [pull(90, [22, 40, 31, 21]), pull(91, []), pull(92, [22])];
  expect(ownerPbiOf("PR #90", pulls, issues)).toBe(3);
  expect(ownerPbiOf("Task #21", pulls, issues)).toBe(2);
  expect(ownerPbiOf("PR #91", pulls, issues)).toBeNull();
  expect(ownerPbiOf("PR #92", pulls, issues)).toBeNull();
  expect(ownerPbiOf("Task #22", pulls, issues)).toBeNull();
  expect(ownerPbiOf("PR #99", pulls, issues)).toBeNull();
});
