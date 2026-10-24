import { expect, test } from "bun:test";
import type { EventEnvelope } from "@switchboard/protocol";
import type { TaskDetail } from "./api.ts";
import { caughtUp, lastSeq, mergeEvents, taskReader } from "./catchup.ts";

const env = (seq: number): EventEnvelope => ({ taskId: "t1", seq, ts: seq, ev: { t: "message.delta", role: "assistant", text: `m${seq}` } });
const seqs = (events: EventEnvelope[]) => events.map((e) => e.seq);

test("a live event that came before the catch-up answer shows once, in seq order (#1137)", () => {
  const live = mergeEvents([env(8), env(9)], [env(12)]);
  expect(seqs(mergeEvents(live, [env(10), env(11), env(12)]))).toEqual([8, 9, 10, 11, 12]);
});

test("the events missed while away fill the gap", () => {
  expect(seqs(mergeEvents([env(1), env(2)], [env(3), env(4), env(5)]))).toEqual([1, 2, 3, 4, 5]);
});

test("nothing new returns the same array, and a repeat inside one answer counts once", () => {
  const current = [env(1), env(2)];
  expect(mergeEvents(current, [])).toBe(current);
  expect(mergeEvents(current, [env(2), env(1)])).toBe(current);
  expect(seqs(mergeEvents(current, [env(3), env(3)]))).toEqual([1, 2, 3]);
});

test("lastSeq is the largest seq, 0 when none", () => {
  expect(lastSeq([])).toBe(0);
  expect(lastSeq([env(5), env(3), env(9), env(7)])).toBe(9);
});

const detail = (seqList: number[], status = "running"): TaskDetail => ({ task: { id: "t1", status }, events: seqList.map(env) }) as unknown as TaskDetail;

test("a catch-up answer replaces the detail and merges its events; a failed read forgets the Task so it is read whole again", () => {
  const held = { t1: detail([1, 2, 5]), t2: detail([7]) };
  const ok = caughtUp(held, "t1", detail([3, 4, 5], "done"));
  expect(seqs(ok.t1!.events)).toEqual([1, 2, 3, 4, 5]);
  expect(ok.t1!.task.status).toBe("done");
  expect(ok.t2).toBe(held.t2);
  // [1, 2] held, [3, 4] missed, live 5 arrived, the read failed: keeping [1, 2, 5] would make the next cursor 5 and lose 3, 4
  const failed = caughtUp(held, "t1", null);
  expect("t1" in failed).toBe(false);
  expect(failed.t2).toBe(held.t2);
  expect(caughtUp(failed, "t1", detail([3]))).toBe(failed);
});

/** A daemon whose answers the test releases one at a time, and the page's details. */
function harness() {
  let details: Record<string, TaskDetail> = {};
  const calls: { id: string; after: number; answer: (d: TaskDetail | null) => void }[] = [];
  const reader = taskReader({
    read: (id, after = 0) => new Promise((resolve, reject) => calls.push({ id, after, answer: (d) => (d ? resolve(d) : reject(new Error("offline"))) })),
    held: () => details,
    update: (f) => void (details = f(details)),
    failed: () => undefined,
  });
  const live = (seq: number) => (details = details.t1 ? { ...details, t1: { ...details.t1, events: mergeEvents(details.t1.events, [env(seq)]) } } : details);
  return { reader, calls, live, details: () => details };
}

test("a whole read on its way when the socket connects is followed past its snapshot: the event sent before the subscription shows (#1137)", async () => {
  const h = harness();
  const load = h.reader.load("t1"); // the daemon snapshots [1, 2]; 3 is sent before the socket subscribes
  h.reader.connected(); // nothing held yet: nothing to catch up
  expect(h.calls).toHaveLength(1);
  h.calls[0]!.answer(detail([1, 2]));
  await load;
  expect(h.calls.map((c) => [c.id, c.after])).toEqual([["t1", 0], ["t1", 2]]);
  h.calls[1]!.answer(detail([3]));
  await Bun.sleep(0);
  expect(seqs(h.details().t1!.events)).toEqual([1, 2, 3]);
});

test("a whole read with no connect meanwhile is not followed, and keeps the live events that came while it was read", async () => {
  const h = harness();
  h.reader.connected();
  const first = h.reader.load("t1");
  h.calls[0]!.answer(detail([1]));
  await first;
  const again = h.reader.load("t1"); // read again (a turn ended); 3 comes live before the answer [1, 2]
  h.live(3);
  h.calls[1]!.answer(detail([1, 2]));
  await again;
  expect(h.calls).toHaveLength(2);
  expect(seqs(h.details().t1!.events)).toEqual([1, 2, 3]);
});

test("a live event for a Task whose whole read is on its way is followed past the snapshot (#1142: a turn's end no longer reads it whole)", async () => {
  const h = harness();
  h.reader.connected();
  const load = h.reader.load("t1"); // the daemon snapshots [1]; 2 and 3 come live before the detail is held
  h.reader.missed("t1");
  h.reader.missed("t2"); // a Task not being read: nothing to do
  h.calls[0]!.answer(detail([1]));
  await load;
  expect(h.calls.map((c) => [c.id, c.after])).toEqual([["t1", 0], ["t1", 1]]);
  h.calls[1]!.answer(detail([2, 3]));
  await Bun.sleep(0);
  expect(seqs(h.details().t1!.events)).toEqual([1, 2, 3]);
});

test("each connect reads every held Task past its last seq", async () => {
  const h = harness();
  const load = h.reader.load("t1");
  h.calls[0]!.answer(detail([1, 2, 5]));
  await load;
  h.reader.connected();
  expect(h.calls.map((c) => [c.id, c.after])).toEqual([["t1", 0], ["t1", 5]]);
  h.calls[1]!.answer(null); // the read failed: the detail is forgotten, so the open Task is read whole again
  await Bun.sleep(0);
  expect("t1" in h.details()).toBe(false);
});

test("an older page (#1142) goes in front of what the page holds; a row both have shows once", () => {
  const held = [env(201), env(202), env(203)];
  const merged = mergeEvents(held, [env(1), env(2), env(201)]);
  expect(merged.map((e) => e.seq)).toEqual([1, 2, 201, 202, 203]);
  expect(mergeEvents(merged, [])).toBe(merged);
});
