// test-reads: apps/web/src/forkCompare.ts apps/web/src/transcript.ts packages/protocol/src/model/
import { expect, test } from "bun:test";
import type { AgentEvent, EventEnvelope } from "@switchboard/protocol";
import { canArchive, forkSides } from "./forkCompare.ts";

const log = (taskId: string, evs: AgentEvent[], from = 1): EventEnvelope[] => evs.map((ev, i) => ({ taskId, seq: from + i, ts: 1000 * (from + i), ev }));
const user = (text: string): AgentEvent => ({ t: "message.delta", role: "user", text });
const reply = (text: string): AgentEvent => ({ t: "message.delta", role: "assistant", text });
const end = (status: "ok" | "error" | "aborted" = "ok"): AgentEvent => ({ t: "session.end", status });

// the parent: turn 1 ends at seq 3 (the fork point), then two more turns
const parent = { task: { id: "task_p" }, events: log("task_p", [user("first"), reply("shared reply"), end(), user("go left"), reply("left 1"), end(), user("more"), reply("left 2"), end("aborted")]) };
const child = { task: { id: "task_c", forkSeq: 3 }, events: log("task_c", [user("go right"), reply("right "), reply("1"), end()]) };

test("forkSides uses the parent's events after forkSeq only", () => {
  const [p] = forkSides(parent, child);
  expect(p).toEqual({ taskId: "task_p", role: "parent", lastReply: "left 2", end: { status: "aborted", at: 9000 }, turns: 2 });
  // a parent that did nothing after the fork: the reply both sides share is not its result
  const [idle] = forkSides({ ...parent, events: parent.events.slice(0, 3) }, child);
  expect(idle).toEqual({ taskId: "task_p", role: "parent", lastReply: "", end: null, turns: 0 });
});

test("forkSides takes the child's last turn", () => {
  const [, c] = forkSides(parent, child);
  expect(c).toEqual({ taskId: "task_c", role: "child", lastReply: "right 1", end: { status: "ok", at: 4000 }, turns: 1 });
});

test("a side with no finished turn has end null", () => {
  const running = { task: child.task, events: [...child.events, ...log("task_c", [user("again"), reply("working")], 5)] };
  const [, c] = forkSides(parent, running);
  expect(c.end).toBeNull(); // the turn before it ended, this one has not
  expect(c).toMatchObject({ lastReply: "working", turns: 2 });
  expect(forkSides(parent, { task: child.task, events: [] })[1]).toEqual({ taskId: "task_c", role: "child", lastReply: "", end: null, turns: 0 });
});

test("canArchive refuses running, waiting and idle", () => {
  for (const status of ["running", "waiting", "idle"] as const) {
    const r = canArchive({ status });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  }
  expect(canArchive({ status: "running" }).reason).not.toBe(canArchive({ status: "idle" }).reason);
  for (const status of ["done", "error", "aborted"] as const) expect(canArchive({ status })).toEqual({ ok: true });
});
