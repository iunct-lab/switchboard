import { describe, expect, test } from "bun:test";
import type { Ask, AskBatch, StopRecord, Task, TaskStatus } from "@switchboard/protocol";
import { approvalBatches, batchKindOf, BatchAnswers } from "./approval-batch.ts";
import { parseAskBlock, stopAskId } from "./asks.ts";
import { stopKey } from "./stops.ts";

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
  const run = async (...statuses: TaskStatus[]) => {
    const sent: string[] = [];
    let status = statuses[0]!;
    const batch = { id: "batch:sso", kind: "sso", asks: [{ taskId: "t2" }], loggingIn: null, deviceAuth: null } as unknown as AskBatch;
    const b = new BatchAnswers({ send: async (id) => void sent.push(id), task: () => task(status), stopRecords: () => [], batches: async () => [batch], deviceAuth: () => null });
    b.pendingSso = { first: "t1", rest: ["t2"], at: 0 };
    const waits: boolean[] = [];
    for (const s of statuses) {
      status = s;
      await b.turnEnded("t1");
      waits.push(b.pendingSso !== null);
    }
    return { sent, waits };
  };

  test("the rest are sent on when the first Task is done; not when it errored", async () => {
    expect(await run("done")).toEqual({ sent: ["t2"], waits: [false] });
    expect(await run("error")).toEqual({ sent: [], waits: [false] });
    expect(await run("aborted")).toEqual({ sent: [], waits: [false] });
  });

  test("a background process left (or its notification running the next turn) keeps the wait; the rest go once it is done", async () => {
    expect(await run("background", "running", "background", "done")).toEqual({ sent: ["t2"], waits: [true, true, true, false] });
    expect(await run("background", "error")).toEqual({ sent: [], waits: [true, false] });
  });

  test("background processes lost with the runner end the wait without sending the rest on", async () => {
    const sent: string[] = [];
    const batch = { id: "batch:sso", kind: "sso", asks: [{ taskId: "t2" }], loggingIn: null, deviceAuth: null } as unknown as AskBatch;
    const b = new BatchAnswers({ send: async (id) => void sent.push(id), task: () => task("done"), stopRecords: () => [], batches: async () => [batch], deviceAuth: () => null });
    b.pendingSso = { first: "t1", rest: ["t2"], at: 0 };
    expect(await b.turnEnded("t1", true)).toEqual([]);
    expect(sent).toEqual([]);
    expect(b.pendingSso).toBeNull();
  });
});

describe("BatchAnswers: the wait stays only while the login can still finish", () => {
  const batch = (...ids: string[]) => ({ id: "batch:sso", kind: "sso", asks: ids.map((taskId) => ({ taskId })), loggingIn: null, deviceAuth: null }) as unknown as AskBatch;
  const make = (status: () => TaskStatus, onBatches: () => void = () => {}, statusAt = 10) => {
    const sent: string[] = [];
    const b = new BatchAnswers({
      send: async (id) => void sent.push(id),
      task: (id) => ({ id, title: id, status: id === "t1" ? status() : "waiting", statusAt }) as Task,
      stopRecords: () => [],
      batches: async () => (onBatches(), [batch("t2")]),
      deviceAuth: (id) => (id === "t1" ? ({ url: "u", code: "c" } as never) : null),
    });
    b.pendingSso = { first: "t1", rest: ["t2"], at: 5 };
    return { b, sent };
  };

  test("a background mark that comes after the turn's end, while the rest are being read, keeps the wait; the empty background sends them", async () => {
    let status: TaskStatus = "done";
    const { b, sent } = make(() => status, () => (status = "background"));
    expect(await b.turnEnded("t1")).toEqual([]);
    expect(sent).toEqual([]);
    expect(b.pendingSso).not.toBeNull();
    // the card still shows who logs in and the device code
    expect(b.decorate([batch("t1", "t2")])[0]).toMatchObject({ loggingIn: { taskId: "t1" }, deviceAuth: { code: "c" } });
    const again = make(() => "done");
    again.b.pendingSso = b.pendingSso;
    expect(await again.b.turnEnded("t1")).toEqual(["t2"]);
  });

  test("the Task sent to log in was aborted without a turn's end: the wait is dropped, and the batch can be pressed again", async () => {
    const { b, sent } = make(() => "aborted");
    expect(b.decorate([batch("t1", "t2")])[0]).toMatchObject({ loggingIn: null });
    expect(b.pendingSso).toBeNull();
    b.pendingSso = { first: "t1", rest: ["t2"], at: 5 };
    const r = await b.answer("batch:sso", undefined, undefined);
    expect(r.body).toMatchObject({ already: false });
    expect(sent).toEqual(["t2"]);
  });

  test("a Task that had failed before the click is the one being sent on: its status does not drop the wait", async () => {
    const { b } = make(() => "error", () => {}, 1);
    expect(b.decorate([batch("t1", "t2")])[0]).toMatchObject({ loggingIn: { taskId: "t1" } });
    expect((await b.answer("batch:sso", undefined, undefined)).body).toMatchObject({ already: true });
  });

  test("a turn that ended failed drops the wait even when the next turn already runs: nothing is sent when that one ends done", async () => {
    let status: TaskStatus = "running";
    const { b, sent } = make(() => status);
    expect(await b.turnEnded("t1", true)).toEqual([]);
    expect(b.pendingSso).toBeNull();
    status = "done";
    expect(await b.turnEnded("t1")).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("a turn's end and an empty background together send the rest once; a lost background while the rest are read sends none", async () => {
    const both = make(() => "done");
    const [x, y] = await Promise.all([both.b.turnEnded("t1"), both.b.turnEnded("t1")]);
    expect([...x, ...y]).toEqual(["t2"]);
    expect(both.sent).toEqual(["t2"]);
    let lost!: BatchAnswers;
    const cut = make(() => "done", () => void lost.turnEnded("t1", true));
    lost = cut.b;
    expect(await cut.b.turnEnded("t1")).toEqual([]);
    expect(cut.sent).toEqual([]);
  });
});

describe("approvalBatches", () => {
  const task = (id: string, createdAt: number) => ({ id, title: id, status: "done", outcome: "needs_action", shadowOf: null, workspaceId: null, createdAt }) as Task;
  const refused = (taskId: string): StopRecord => ({ id: `${taskId}/p`, work: { workspaceId: null, issue: null, taskId }, op: "sam deploy", target: "stack", reason: "permission", evidence: "denied", safety: "before-effect", conditions: [], answer: null, actions: [], state: "waiting", at: 1000 }) as StopRecord;
  const listed = (over: Partial<Ask>) => ({ kind: "stop", state: "open", ...over }) as Ask;

  test("batch ask id is a listed one: a Task's question id is the listed question's own, and a Task tied to no listed question is in no batch", () => {
    const entries = ["t1", "t2", "t3"].map((id, n) => ({ task: task(id, n), records: [refused(id)] }));
    // t1's stop is listed as its own question (with the time its content took its form); t2's folded into its check; t3 has none listed
    const stopId = stopAskId({ key: stopKey(refused("t1")), contentAt: 777 });
    const asks = [listed({ id: stopId, task: { id: "t1", title: null } }), listed({ id: "check:t2", kind: "check", task: { id: "t2", title: null } }), listed({ id: "check:t3", kind: "check", state: "answered", task: { id: "t3", title: null } })];
    const [batch, ...rest] = approvalBatches(entries, asks);
    expect(rest).toEqual([]);
    expect(batch).toMatchObject({ id: "batch:deploy", asks: [{ taskId: "t1", askId: stopId }, { taskId: "t2", askId: "check:t2" }] });
    expect(stopId).toMatch(/@777$/);
    // every id of the batch is an id of the list
    for (const a of batch!.asks) expect(asks.map((q) => q.id)).toContain(a.askId);
    // none listed at all: no batch
    expect(approvalBatches(entries, [])).toEqual([]);
    // a login waits for no version of a question: a Task whose stop is tied to no listed question stays in the sso batch
    const login = (id: string): StopRecord => ({ ...refused(id), op: "aws sso login", reason: "auth" });
    const sso = approvalBatches([{ task: task("t4", 4), records: [login("t4")] }], []);
    expect(sso).toMatchObject([{ id: "batch:sso", asks: [{ taskId: "t4" }] }]);
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
