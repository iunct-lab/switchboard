import { describe, expect, test } from "bun:test";
import type { BacklogItem } from "@switchboard/protocol";
import { awaitingReply, claimedLine, flowCounted, notResumed, pickNext } from "./backlog-pick.ts";
import { turnWorks } from "./backlog-overlap.ts";
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

describe("awaitingReply", () => {
  // a request: its answers are not read, so any comment since lets it go
  const base: Partial<BacklogItem> = { type: "request", stage: "request", lastTask: task({ action: "to-pbi", outcome: "needs_action" }) };
  test("own comments arriving later do not release it", () => expect(awaitingReply(at(base, BEFORE_END))).toBe(true));
  test("a comment written after the Task releases it", () => expect(awaitingReply(at(base, AFTER_END))).toBe(false));
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

describe("a PBI the gate holds is neither counted nor keeps a turn", () => {
  const hold = { previousTaskId: "tk", action: "complete" as const };
  const flowing = (over: Partial<BacklogItem>) => item({ number: 7, flow: true, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, lastTask: task({ status: "error" }), ...over });
  test("an in-progress flow PBI the gate holds is not in the flow count, and one it does not hold is, whatever way its last Task ended", () => {
    for (const status of ["error", "aborted", "done"] as const) {
      expect(flowCounted([flowing({ lastTask: task({ status }), autoHeld: hold })]).map((i) => i.number)).toEqual([]);
      expect(flowCounted([flowing({ lastTask: task({ status }) })]).map((i) => i.number)).toEqual([7]);
    }
  });
  test("it is picked for no stage while held, and again once the gate lets go", () => {
    expect(pickNext([flowing({ autoHeld: hold })], "implement")).toBeNull();
    expect(pickNext([flowing({ autoHeld: null })], "implement")).toMatchObject({ item: { number: 7 }, action: "complete", resume: true });
    // a closable one the gate holds for 閉じる is held in the same way
    expect(pickNext([flowing({ closable: true, tasks: { total: 3, done: 3, doneAt: null }, autoHeld: { previousTaskId: "tk", action: "close" } })], "implement")).toBeNull();
  });
  test("it keeps no place in an overlap turn, and keeps its place once the gate lets go", () => {
    // PBI 7 yielded to PR 90 (a.ts) and has one open Task naming a.ts
    const issues = new Map([[7, { subIssues: [71] }], [71, { state: "OPEN", parent: 7 }]]) as never;
    const pulls = [{ number: 90, state: "OPEN", closes: [], files: ["a.ts"] }] as never;
    const comments = () => [{ body: "<!-- pbi-complete:release overlap=90 -->", createdAt: iso(T0) }] as never;
    const turns = (i: BacklogItem) => turnWorks([i], issues, pulls, new Map(), comments, (n) => (n === 71 ? ["a.ts"] : []), T0 + 1000, () => false, notResumed);
    expect(turns(flowing({ autoHeld: hold }))).toEqual([]);
    expect(turns(flowing({ autoHeld: null })).map((t) => t.task)).toEqual([71]);
  });
  test("an unblocked PBI goes on though the gate would hold it", () => {
    const unblocked = flowing({ autoHeld: hold, waitsAt: iso(T0), waits: [{ number: 5, kind: "issue", open: false, state: "met", reason: "overlap", pbi: null }] });
    expect(pickNext([unblocked], "implement")).toMatchObject({ item: { number: 7 } });
  });
});
