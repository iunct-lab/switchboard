import { expect, test } from "bun:test";
import { foldTranscript } from "./transcript.ts";
import { canFork } from "./fork.ts";

const local = { executionMode: "local" as const };
const ok = { status: "ok" as const, turn: "uuid-1" };
const forks = { forks: true };

test("canFork: a finished turn of a local Task on a runner that forks", () => {
  expect(canFork(local, ok, forks)).toBe(true);
});

test("canFork: not a turn that ended in error or was aborted", () => {
  expect(canFork(local, { status: "error", turn: "uuid-1" }, forks)).toBe(false);
  expect(canFork(local, { status: "aborted", turn: "uuid-1" }, forks)).toBe(false);
});

test("canFork: not a turn without the runner's pointer (a record from before it was kept)", () => {
  expect(canFork(local, { status: "ok" }, forks)).toBe(false);
  expect(canFork(local, { status: "ok", turn: "" }, forks)).toBe(false);
});

test("canFork: not a Cloud Task", () => {
  expect(canFork({ executionMode: "cloud" }, ok, forks)).toBe(false);
});

test("canFork: not on a runner that cannot fork, or one the daemon did not list", () => {
  expect(canFork(local, ok, { forks: false })).toBe(false);
  expect(canFork(local, ok, undefined)).toBe(false);
});

test("a turn's end row carries the seq of its session.end and the runner's pointer, which the fork button sends", () => {
  const events = [{ t: "message.delta", role: "assistant", text: "a" }, { t: "session.end", status: "ok", turn: "uuid-1" }, { t: "message.delta", role: "assistant", text: "b" }, { t: "session.end", status: "ok" }] as const;
  const ends = foldTranscript(events.map((ev, i) => ({ taskId: "t", seq: i + 10, ts: i, ev }))).items.filter((i) => i.kind === "end");
  expect(ends.map((e) => ({ seq: e.seq, turn: e.turn }))).toEqual([{ seq: 11, turn: "uuid-1" }, { seq: 13, turn: undefined }]);
  expect(ends.map((e) => canFork(local, e, forks))).toEqual([true, false]);
});
