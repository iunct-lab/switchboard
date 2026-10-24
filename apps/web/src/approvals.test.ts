import { expect, test } from "bun:test";
import type { AgentEvent, EventEnvelope, PendingApproval } from "@switchboard/protocol";
import { applyApprovalEvent, mergeFetched, summarize } from "./approvals.ts";

const env = (taskId: string, ev: AgentEvent, ts = 1): EventEnvelope => ({ taskId, seq: ts, ts, ev });
const ask = (id: string): AgentEvent => ({ t: "permission.ask", id, kind: "write", tool: "Write", input: { file_path: "src/a.ts" }, detail: "write src/a.ts\nsecond\nthird" });

test("an ask adds a row on top, once; only its answer removes it (the daemon keeps an ask open past session.end)", () => {
  let list: PendingApproval[] = [];
  list = applyApprovalEvent(list, env("t1", ask("p1"), 10));
  list = applyApprovalEvent(list, env("t2", ask("p1"), 20));
  list = applyApprovalEvent(list, env("t2", ask("p1"), 20));
  expect(list.map((a) => [a.taskId, a.id, a.askedAt])).toEqual([["t2", "p1", 20], ["t1", "p1", 10]]);
  list = applyApprovalEvent(list, env("t1", { t: "permission.resolved", id: "p1", decision: "allow", by: "user" }));
  expect(list.map((a) => a.taskId)).toEqual(["t2"]);
  expect(applyApprovalEvent(list, env("t2", { t: "session.end", status: "ok" }))).toBe(list);
});

test("other events leave the list as it is; a new row shows the task id until the title is looked up", () => {
  const list = applyApprovalEvent([], env("t9", ask("p"), 5));
  expect(list[0]!.taskTitle).toBe("t9");
  expect(applyApprovalEvent(list, env("t9", { t: "message.delta", role: "assistant", text: "x" }))).toBe(list);
});

test("a fetched list replaces what the stream built, keeping asks that arrived after the request went out", () => {
  const row = (taskId: string, askedAt: number) => applyApprovalEvent([], env(taskId, ask("p"), askedAt))[0]!;
  // missed while disconnected: t1 is gone on the daemon, t2 was asked meanwhile; t3 arrived over the socket during the fetch
  const current = [row("t3", 50), row("t1", 10)];
  const fetched = [row("t2", 30)];
  expect(mergeFetched(fetched, current, 40).map((a) => a.taskId)).toEqual(["t3", "t2"]);
});

test("summarize keeps the first two lines", () => {
  expect(summarize({ detail: "a\nb\nc", input: {} })).toBe("a\nb");
  expect(summarize({ detail: "", input: { command: "ls" } })).toBe('{"command":"ls"}');
});
