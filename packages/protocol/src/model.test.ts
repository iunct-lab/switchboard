import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgentEvent, StopRecord } from "./events.ts";
import { BacklogHeldEdit, BacklogSyncConflict, CloudSessionRef, CreateTaskInput, FlowPbi, PendingApproval, Settings } from "./model.ts";

test("creation defaults Local and preserves explicit Cloud", () => {
  expect(CreateTaskInput.parse({ title: "task", prompt: "explain" }).executionMode).toBe("local");
  expect(CreateTaskInput.parse({ title: "task", prompt: "explain" }).runner).toBe("claude");
  expect(CreateTaskInput.parse({ title: "task", prompt: "explain", executionMode: "cloud" }).executionMode).toBe("cloud");
});

test("Cloud references reject foreign hosts, credentials, query strings and mismatched IDs", () => {
  const id = "session_0123456789abcdefghijklmn";
  expect(CloudSessionRef.parse({ id, url: `https://claude.ai/code/${id}` }).id).toBe(id);
  for (const url of [`http://claude.ai/code/${id}`, `https://example.com/code/${id}`, `https://user@claude.ai/code/${id}`, `https://claude.ai/code/${id}?code=secret`, `https://claude.ai/code/session_other`, `https://claude.ai/code/${id}#secret`]) {
    expect(CloudSessionRef.safeParse({ id, url }).success).toBe(false);
  }
  // an ID that is not a session ID is refused even when the URL is built from it
  for (const bad of ["abc", "session_a/../b", "session_a?x=1"]) expect(CloudSessionRef.safeParse({ id: bad, url: `https://claude.ai/code/${bad}` }).success).toBe(false);
});

describe("what zod 4 changed, kept as zod 3 had it (#2968)", () => {
  test("an empty settings row still fills the nested defaults: .prefault, not 4's .default that stops at {}", () => {
    const s = Settings.parse({});
    expect(s.routing.llm.timeoutMs).toBe(5000);
    expect(s.evals.judge.enabled).toBe(true);
    expect(s.titles.auto).toBe(true);
    expect(s.quotaAndResume.maxLimitStops).toBe(8);
  });

  test("a flow row may leave out a stage: 4's z.record over an enum would need every key", () => {
    const pbi = { repo: "o/r", number: 1, title: "t", url: "u", storyPoints: null, closedAt: "c", stages: {}, userWaitMs: 0 };
    const shape = FlowPbi.pick({ stages: true });
    expect(shape.safeParse(pbi).success).toBe(true);
  });

  test("a key of unknown value may be absent: JSON.stringify drops undefined, and 4 refuses a missing z.unknown()", () => {
    const conflict = { field: null, remoteRead: false, revision: "r" };
    expect(BacklogSyncConflict.pick({ base: true, local: true, remote: true }).safeParse(conflict).success).toBe(true);
    expect(BacklogHeldEdit.shape.conflict.safeParse({ remoteRead: false, revision: "r" }).success).toBe(true);
    expect(PendingApproval.shape.input.safeParse(undefined).success).toBe(true);
    expect(z.object({ input: PendingApproval.shape.input }).safeParse({}).success).toBe(true);
    expect(AgentEvent.safeParse({ t: "tool.call", id: "c", name: "Read", summary: "s" }).success).toBe(true);
    expect(AgentEvent.safeParse({ t: "permission.ask", id: "p", kind: "other", tool: "T", detail: "d" }).success).toBe(true);
  });

  test("a stop's lenient keys stay optional in the tools/list schema: 4 lists a bare .catch() as required", () => {
    const required = (z.toJSONSchema(StopRecord, { io: "input" }) as { required: string[] }).required;
    expect(required).not.toContainAnyValues(["reason", "safety", "state"]);
    const stop = { id: "s", work: { workspaceId: null, issue: null, taskId: "t" }, op: "o", at: 1 };
    expect(StopRecord.parse(stop)).toMatchObject({ reason: "unknown", safety: "unknown", state: "waiting" });
    expect(StopRecord.parse({ ...stop, reason: "nope", safety: null, state: 1 })).toMatchObject({ reason: "unknown", safety: "unknown", state: "waiting" });
  });
});
