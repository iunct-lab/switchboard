import { expect, test } from "bun:test";
import type { TaskStopMark } from "@switchboard/protocol";
import { repliesFor, shortReply } from "./presetReplies.ts";

const mark = (over: Partial<TaskStopMark> = {}): TaskStopMark => ({ key: "k", reason: "decision", state: "waiting", conditions: [], count: 1, answered: false, replies: [{ id: "p1", name: "再開して", text: "再開して" }], ...over });

test("repliesFor shows the replies only while the Task waits on the person's reply", () => {
  expect(repliesFor("done", mark()).map((r) => r.id)).toEqual(["p1"]);
  expect(repliesFor("done", null)).toEqual([]);
  // a write approval (許可 / 拒否) or work in progress: no buttons
  expect(repliesFor("waiting", mark())).toEqual([]);
  expect(repliesFor("running", mark())).toEqual([]);
  // the stop already answered
  expect(repliesFor("done", mark({ answered: true }))).toEqual([]);
});

test("shortReply keeps a short text and folds whitespace", () => {
  expect(shortReply("再開して")).toBe("再開して");
  expect(shortReply("a\n  b")).toBe("a b");
});

test("shortReply cuts a long text to max characters with an ellipsis", () => {
  const s = shortReply("あ".repeat(40), 10);
  expect(Array.from(s).length).toBe(10);
  expect(s.endsWith("…")).toBe(true);
});
