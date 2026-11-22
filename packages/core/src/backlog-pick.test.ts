import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { awaitingReply, endedUnmarked, failedSince, isClosable } from "./backlog-pick.ts";
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
