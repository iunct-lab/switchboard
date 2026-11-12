import { describe, expect, test } from "bun:test";
import type { AskBatch, Task, TaskStatus } from "@switchboard/protocol";
import { batchKindOf, BatchAnswers } from "./approval-batch.ts";
import { parseAskBlock } from "./asks.ts";

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

describe("BatchAnswers.turnEnded", () => {
  const task = (status: TaskStatus) => ({ id: "t1", status }) as Task;
  const run = async (status: TaskStatus) => {
    const sent: string[] = [];
    const batch = { id: "batch:sso", kind: "sso", asks: [{ taskId: "t2" }], loggingIn: null, deviceAuth: null } as unknown as AskBatch;
    const b = new BatchAnswers({ send: async (id) => void sent.push(id), task: () => task(status), stopRecords: () => [], batches: async () => [batch], deviceAuth: () => null, ask: async () => null, answerAsk: async () => ({ status: 200, body: {} }) });
    b.pendingSso = { first: "t1", rest: ["t2"], at: 0 };
    await b.turnEnded("t1");
    return sent;
  };

  test("the rest are sent on when the first Task's turn ended with a background process left; not when it errored (#4212)", async () => {
    expect(await run("done")).toEqual(["t2"]);
    expect(await run("background")).toEqual(["t2"]);
    expect(await run("error")).toEqual([]);
  });
});

describe("parseAskBlock", () => {
  test("parseAskBlock reads reasons and diff under 止めた場所", () => {
    const text = "**確認**: マージしてよいか\n**止めた場所**: PR #12 のマージ判定\n[聞く] セキュリティ: security:github（+40/-3）\n- [再チェック security] 未実施\n[聞く] rescue\n説明の行\n**選択肢**:\n- A: マージする";
    expect(parseAskBlock(text).place).toEqual({ text: "PR #12 のマージ判定", pr: 12, reasons: ["[聞く] セキュリティ: security:github（+40/-3）", "[再チェック security] 未実施", "[聞く] rescue"], diff: "+40/-3" });
    expect(parseAskBlock(text).choices).toEqual(["A: マージする"]);
    // reasons outside the place are not read
    expect(parseAskBlock("**確認**: x\n[聞く] セキュリティ\n**止めた場所**: PR #3").place?.reasons).toEqual([]);
    // a standalone diff summary under the place is read and does not end the reasons after it
    expect(parseAskBlock("**確認**: x\n**止めた場所**: PR #12\n+40/-3\n[聞く] セキュリティ: security:github").place).toEqual({ text: "PR #12", pr: 12, reasons: ["[聞く] セキュリティ: security:github"], diff: "+40/-3" });
  });
});
