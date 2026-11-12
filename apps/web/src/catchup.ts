import type { EventEnvelope, Task } from "@switchboard/protocol";
import type { TaskDetail } from "./api.ts";

/**
 * A Task's events after a dropped WebSocket (#1137): what the page holds, what came live, and what GET /api/tasks/:id?after=
 * brought back can overlap and arrive in any order. One union by seq, ascending, so none shows twice or out of place.
 * Nothing new → the same array (React keeps the state as is).
 */
export function mergeEvents(current: EventEnvelope[], incoming: EventEnvelope[]): EventEnvelope[] {
  const have = new Set(current.map((e) => e.seq));
  const added = incoming.filter((e) => !have.has(e.seq) && (have.add(e.seq), true));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.seq - b.seq);
}

/** The cursor for ?after=: the largest seq held, 0 when none. */
export function lastSeq(events: EventEnvelope[]): number {
  let max = 0;
  for (const e of events) if (e.seq > max) max = e.seq;
  return max;
}

/**
 * One held Task after its ?after= read. The answer replaces the detail except its events, which are merged. No answer (the
 * read failed) forgets the detail: a live event would otherwise move its cursor past the gap for good, and the open Task
 * is read again whole once it is gone. A Task let go meanwhile stays gone.
 */
export function caughtUp(details: Record<string, TaskDetail>, id: string, fetched: TaskDetail | null): Record<string, TaskDetail> {
  const held = details[id];
  if (!held) return details;
  if (!fetched) {
    const { [id]: _forgotten, ...rest } = details;
    return rest;
  }
  return { ...details, [id]: { ...fetched, events: mergeEvents(held.events, fetched.events) } };
}

/**
 * Reading Task details (#1137): `load` reads one whole (opening it); `connected` — on each WebSocket connect, the first
 * too — reads each held one past its last seq. A whole read still on its way when the socket connected may have missed an
 * event sent before the subscription, so it is followed by a read past its own last seq. So is one during which `missed`
 * was told of a live event for that Task (#1142): the page drops events of a Task it does not hold yet, and nothing reads
 * the Task whole again later. Events that arrived live while a read was on its way are newer than its answer and stay.
 */
export function taskReader(deps: {
  read: (id: string, after?: number) => Promise<TaskDetail>;
  held: () => Record<string, TaskDetail>;
  update: (f: (prev: Record<string, TaskDetail>) => Record<string, TaskDetail>) => void;
  failed: (e: Error, id: string) => void;
}) {
  let connects = 0;
  /** Tasks with a whole read on its way, and whether a live event of theirs was dropped meanwhile. */
  const loading = new Map<string, boolean>();
  /**
   * The reads on their way per Task, each with the last Task a task.updated sent for it while that read was out (#2834).
   * The socket sends each change after the read's snapshot, so that Task is the newer one; `updatedAt` cannot tell (a
   * title or a judgement keeps it). Each read has its own: a read started later does not take an earlier read's. And
   * a read answering after one started later has answered brings its events only: its Task is the older one.
   */
  type Slot = { n: number; task?: Task };
  let started = 0;
  const reading = new Map<string, Set<Slot>>();
  const answered = new Map<string, number>();
  const begin = (id: string): Slot => {
    const slot: Slot = { n: ++started };
    reading.set(id, (reading.get(id) ?? new Set()).add(slot));
    return slot;
  };
  const end = (id: string, slot: Slot): void => {
    const set = reading.get(id);
    set?.delete(slot);
    if (set?.size === 0) reading.delete(id);
  };
  /** The Task a read's answer brings: the update that came while it was out, else its own; null when a later read answered. */
  const settle = (id: string, slot: Slot, fetched: Task): Task | null => {
    end(id, slot);
    if ((answered.get(id) ?? 0) > slot.n) return null;
    answered.set(id, slot.n);
    return slot.task ?? fetched;
  };
  const follow = (id: string, after: number) => {
    const slot = begin(id);
    return deps.read(id, after).then(
      (fetched) => {
        const task = settle(id, slot, fetched.task);
        deps.update((prev) =>
          task ? caughtUp(prev, id, { ...fetched, task }) : prev[id] ? { ...prev, [id]: { ...prev[id]!, events: mergeEvents(prev[id]!.events, fetched.events) } } : prev,
        );
      },
      () => {
        end(id, slot);
        deps.update((prev) => caughtUp(prev, id, null));
      },
    );
  };
  return {
    connected(): void {
      connects++;
      for (const [id, d] of Object.entries(deps.held())) void follow(id, lastSeq(d.events));
    },
    load(id: string): Promise<void> {
      const at = connects;
      loading.set(id, false);
      const slot = begin(id);
      return deps.read(id).then(
        (d) => {
          const dropped = loading.get(id);
          loading.delete(id);
          const task = settle(id, slot, d.task);
          deps.update((prev) => ({ ...prev, [id]: { ...(task || !prev[id] ? { ...d, task: task ?? d.task } : prev[id]!), events: mergeEvents(d.events, prev[id]?.events ?? []) } }));
          if (connects !== at || dropped) void follow(id, lastSeq(d.events));
        },
        (e: Error) => {
          loading.delete(id);
          end(id, slot);
          deps.failed(e, id);
        },
      );
    },
    /** A task.updated came: a read of that Task on its way answers with it instead of its older snapshot (#2834). */
    updated(task: Task): void {
      for (const slot of reading.get(task.id) ?? []) slot.task = task;
    },
    /** A live event of a Task the page does not hold came and was dropped. */
    missed(id: string): void {
      if (loading.has(id)) loading.set(id, true);
    },
  };
}
