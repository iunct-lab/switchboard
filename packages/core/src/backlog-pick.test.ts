import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { awaitingReply, claimedLine, endedUnmarked, failedSince, isClosable, pickNext } from "./backlog-pick.ts";
import { item } from "./api-test-harness.ts";

// The "nothing since the last Task" judgments read the written time of the Issue's comments, never the Issue's updatedAt.

const T0 = Date.parse("2026-11-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** The last stage Task started at T0 and ended at T0 + 60 s. */
const task = (over: Partial<NonNullable<BacklogItem["lastTask"]>>): NonNullable<BacklogItem["lastTask"]> =>
  ({ id: "tk", status: "done", statusAt: T0 + 60_000, createdAt: T0, updatedAt: T0 + 60_000, action: "complete", outcome: "unknown", reviewedAt: null, resumeAt: null, started: true, ...over });
/** `commentedAt` is when the newest comment was written; the Issue's updatedAt is later than the Task in both cases (GitHub received the Task's own comment after it ended). */
const at = (over: Partial<BacklogItem>, commentedMs: number | null): BacklogItem => item({ updatedAt: iso(T0 + 300_000), commentedAt: commentedMs === null ? null : iso(commentedMs), ...over });
const BEFORE_END = T0 + 30_000;
const AFTER_END = T0 + 90_000;

describe("failedSince", () => {
  const base: Partial<BacklogItem> = { stage: "in-progress", lastTask: task({ status: "error" }) };
  test("own comments arriving later do not release it", () => expect(failedSince(at(base, BEFORE_END))).toBe(true));
  test("a comment written after the Task releases it", () => expect(failedSince(at(base, AFTER_END))).toBe(false));
});

describe("awaitingReply", () => {
  // a request: its answers are not read, so any comment since lets it go
  const base: Partial<BacklogItem> = { type: "request", stage: "request", lastTask: task({ action: "to-pbi", outcome: "needs_action" }) };
  test("own comments arriving later do not release it", () => expect(awaitingReply(at(base, BEFORE_END))).toBe(true));
  test("a comment written after the Task releases it", () => expect(awaitingReply(at(base, AFTER_END))).toBe(false));
});

describe("isClosable", () => {
  const base: Partial<BacklogItem> = { stage: "in-progress", closable: true, lastTask: task({ action: "close" }) };
  test("own comments arriving later do not release it", () => expect(isClosable(at(base, BEFORE_END))).toBe(false));
  test("a comment written after the Task releases it", () => expect(isClosable(at(base, AFTER_END))).toBe(true));
});

describe("endedUnmarked", () => {
  // a resume that wrote nothing: any comment written after it started is its mark
  const base: Partial<BacklogItem> = { stage: "in-progress", tasks: { total: 2, done: 1, doneAt: null }, lastTask: task({ action: "complete" }) };
  test("own comments arriving later do not release it", () => expect(endedUnmarked(at(base, T0 - 10_000))).toBe(true));
  test("a comment written after the Task releases it", () => expect(endedUnmarked(at(base, BEFORE_END))).toBe(false));
});

describe("a PBI a session holds", () => {
  // an in-progress PBI is picked when it was answered since its last stage Task ended (a Ready or needs-tasks one is picked as it is)
  const held = (over: Partial<BacklogItem>) => item({ number: 7, ...(over.stage === "in-progress" ? { answeredAt: iso(T0 + 100_000), lastTask: task({ updatedAt: T0 }) } : {}), ...over });
  test("a PBI a session holds is picked for no stage until it is released", () => {
    for (const [stage, slot] of [["needs-tasks", "plan"], ["ready", "implement"], ["in-progress", "implement"]] as const) {
      const claim = { taskId: "t_holder" };
      expect(pickNext([held({ stage, claim })], slot)).toBeNull();
      expect(pickNext([held({ stage, claim: null })], slot)).toMatchObject({ item: { number: 7 } });
      // a stage Task of its own running on it is its own work, not a claim to wait for: the item is left for that reason
      expect(pickNext([held({ stage, claim, activeTaskId: "t_stage" })], slot)).toBeNull();
    }
    expect(claimedLine([held({ claim: { taskId: "t_holder" } }), held({ number: 8, claim: { taskId: null } }), held({ number: 9 })], "implement")).toBe("占有中: #7（Task t_holder） #8");
    expect(claimedLine([held({ stage: "request", claim: { taskId: "t_holder" } })], "implement")).toBeNull();
  });
});
