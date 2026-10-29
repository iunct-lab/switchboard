import { describe, expect, test } from "bun:test";
import { batchKindOf } from "./approval-batch.ts";

describe("batchKindOf", () => {
  test("batchKindOf tells sso and deploy", () => {
    expect(batchKindOf({ reason: "auth", op: "aws sso login", target: "profile", state: "waiting" })).toBe("sso");
    expect(batchKindOf({ reason: "permission", op: "POST /api/daemon/promote", target: "main", state: "waiting" })).toBe("deploy");
    expect(batchKindOf({ reason: "permission", op: "aws cloudformation deploy", target: "stack", state: "exhausted" })).toBe("deploy");
    expect(batchKindOf({ reason: "permission", op: "gh stack merge", target: "PR #12", state: "waiting" })).toBeNull();
    // a resolved stop waits on nothing; a deploy word with another reason is not a refused deploy
    expect(batchKindOf({ reason: "auth", op: "aws sso login", target: "profile", state: "resolved" })).toBeNull();
    expect(batchKindOf({ reason: "decision", op: "sam deploy", target: "stack", state: "waiting" })).toBeNull();
  });
});
