/**
 * The backlog queue: the PBIs the person chose to implement, in order, across the workspaces. One row of
 * `settings` (`QUEUE_KEY`), not part of `Settings`, so a settings PATCH and a queue PUT do not write over each other.
 */
import { BacklogQueue, type BacklogQueueEnded, type BacklogQueueEntry, type BacklogQueueInput } from "@switchboard/protocol";
import type { Db } from "./db.ts";

export const QUEUE_KEY = "backlogQueue";

/** How many of the PBIs that left the queue are kept. */
export const ENDED_KEEP = 20;

export const EMPTY_QUEUE: BacklogQueue = { enabled: false, concurrency: 1, items: [], ended: [], lastNote: null, lastNoteAt: null };

const keyOf = (e: BacklogQueueEntry) => `${e.workspaceId}#${e.number}`;

/** The stored queue; none, or a row that does not parse, reads as the empty, disabled queue. */
export function readQueue(db: Db): BacklogQueue {
  const parsed = BacklogQueue.safeParse(db.getSetting<unknown>(QUEUE_KEY, null));
  return parsed.success ? parsed.data : EMPTY_QUEUE;
}

/** The entries in order, each PBI once (the first one stays). */
const unique = (items: BacklogQueueEntry[]): BacklogQueueEntry[] => {
  const seen = new Set<string>();
  return items.filter((e) => !seen.has(keyOf(e)) && seen.add(keyOf(e)));
};

const withEnded = (ended: BacklogQueueEnded[], add: BacklogQueueEnded[]): BacklogQueueEnded[] => [...add, ...ended].slice(0, ENDED_KEEP);

/**
 * The queue after `input` (the fields left out stay), stored. An entry dropped from `items` goes to `ended` as
 * "removed", with its title from `titleOf` (the number when not known).
 */
export function saveQueue(db: Db, input: BacklogQueueInput, titleOf: (e: BacklogQueueEntry) => string | null = () => null, now = Date.now()): BacklogQueue {
  const before = readQueue(db);
  const items = input.items ? unique(input.items) : before.items;
  const kept = new Set(items.map(keyOf));
  const removed = before.items.filter((e) => !kept.has(keyOf(e))).map((e): BacklogQueueEnded => ({ ...e, title: titleOf(e) ?? `#${e.number}`, at: now, reason: "removed" }));
  const queue: BacklogQueue = { ...before, enabled: input.enabled ?? before.enabled, concurrency: input.concurrency ?? before.concurrency, items, ended: withEnded(before.ended, removed) };
  db.setSetting(QUEUE_KEY, queue);
  return queue;
}

/**
 * The queue without the PBIs closed since: an entry `closed` answers a title for goes to `ended` as "closed". Only what
 * the stored Issue says (closed) counts — an entry not stored or not read now stays. Returns the same object when
 * nothing moved.
 */
export function pruneClosed(queue: BacklogQueue, closed: (e: BacklogQueueEntry) => { title: string } | null, now = Date.now()): BacklogQueue {
  const gone = queue.items.flatMap((e) => {
    const c = closed(e);
    return c ? [{ e, title: c.title }] : [];
  });
  if (!gone.length) return queue;
  const goneKeys = new Set(gone.map((g) => keyOf(g.e)));
  return {
    ...queue,
    items: queue.items.filter((e) => !goneKeys.has(keyOf(e))),
    ended: withEnded(queue.ended, gone.map(({ e, title }) => ({ ...e, title, at: now, reason: "closed" as const }))),
  };
}

/** Keeps what the queue's last start decided, on the queue as stored now. */
export function noteQueue(db: Db, lines: string[], now = Date.now()): BacklogQueue {
  const queue = { ...readQueue(db), lastNote: lines.join("\n"), lastNoteAt: now };
  db.setSetting(QUEUE_KEY, queue);
  return queue;
}
