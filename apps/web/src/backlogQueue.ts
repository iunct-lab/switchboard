import type { BacklogItem, BacklogQueue, BacklogQueueEnded, BacklogQueueEntry } from "@switchboard/protocol";
import { applyView, DEFAULT_VIEW, itemMarks, STAGES } from "./backlogView.ts";

/** One entry of the queue with its row (#3957); `item` null = its workspace's backlog does not have it on this screen. */
export interface QueueRow {
  entry: BacklogQueueEntry;
  item: BacklogItem | null;
}

const same = (a: BacklogQueueEntry, b: BacklogQueueEntry) => a.workspaceId === b.workspaceId && a.number === b.number;

/**
 * The queue view's parts (#3957): `running` = the queued PBIs with a stage Task running or waiting, `waiting` = the rest
 * in the queue's order, `outside` = the open PBIs not queued that are Ready or not yet split into Tasks, by Priority,
 * `ended` = the queue's newest left ones.
 */
export function queueSections(queue: BacklogQueue, items: BacklogItem[]): { running: QueueRow[]; waiting: QueueRow[]; outside: BacklogItem[]; ended: BacklogQueueEnded[] } {
  const rows = queue.items.map((entry): QueueRow => ({ entry, item: items.find((i) => same(i, entry)) ?? null }));
  const outside = items.filter((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "needs-tasks") && !queue.items.some((e) => same(e, i)));
  return {
    running: rows.filter((r) => r.item?.activeTaskId),
    waiting: rows.filter((r) => !r.item?.activeTaskId),
    outside: applyView(outside, { ...DEFAULT_VIEW, sort: "priority" }),
    ended: queue.ended,
  };
}

/** The queue's entries with `entry` at the end (once). */
export const withAdded = (queue: BacklogQueue, entry: BacklogQueueEntry): BacklogQueueEntry[] => [...queue.items.filter((e) => !same(e, entry)), { workspaceId: entry.workspaceId, number: entry.number }];

/** The queue's entries without `entry`. */
export const withRemoved = (queue: BacklogQueue, entry: BacklogQueueEntry): BacklogQueueEntry[] => queue.items.filter((e) => !same(e, entry));

/**
 * How the queue view saves (#3957): each change is shown at once (`show`, on what is shown now) and sent after the one
 * before it has been answered, so two quick changes do not send two lists made from the same old queue. Only the
 * newest answer is shown. A save that fails says so (`failed`); the stored queue is read back (`reread`) only when no
 * later change is waiting to be sent — that one was made on what was shown and its answer takes the place.
 */
export function queueSaver<Q, I>(deps: { send: (input: I) => Promise<Q>; show: (apply: (q: Q | null) => Q | null) => void; apply: (q: Q, input: I) => Q; reread: () => Promise<Q>; failed: (e: unknown) => void }): (input: I) => Promise<void> {
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;
  return (input) => {
    deps.show((q) => q && deps.apply(q, input));
    const n = ++seq;
    const done = chain.then(() =>
      deps.send(input).then(
        (q) => void (n === seq && deps.show(() => q)),
        (e) => {
          deps.failed(e);
          // a change made while it is read back is newer than what it reads: its own answer takes the place
          if (n === seq) return deps.reread().then((q) => void (n === seq && deps.show(() => q)), () => undefined);
        },
      ),
    );
    chain = done;
    return done.then(() => undefined);
  };
}

/** `items` with the one at `from` moved to `to` (`to` = its index afterwards); the same array when it does not move or an index is out of range. */
export function moveEntry<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/**
 * Where a dragged row lands (#3958): its index among the other rows, from their middles (`mids`, top to bottom) and
 * the dragged row's middle `y` — the number of rows whose middle it is below.
 */
export const dropIndex = (mids: number[], y: number): number => mids.filter((m) => m < y).length;

/** The queue's entries with its waiting ones in `waiting`'s order; the running ones keep their places. */
export function withWaiting(queue: BacklogQueue, running: BacklogQueueEntry[], waiting: BacklogQueueEntry[]): BacklogQueueEntry[] {
  const rest = waiting.slice();
  return queue.items.map((e) => (running.some((r) => same(r, e)) ? e : rest.shift()!));
}

/** What to put first when the queue takes several PBIs at once (#3959). */
export type PickAxis = "priority" | "progress" | "small" | "old";

/** The marks that leave a PBI out when the waiting ones are not included: 待ち, 前提, 進められない and 重なり. */
const WAITING_MARKS = new Set(["waits", "prereq", "stuck", "overlap"]);

/**
 * The first `n` PBIs not in the queue that are Ready or not yet split into Tasks, by `axis` (#3959): `priority` = the
 * Priority sort of the 表示 (none last), `progress` = the larger share of done Tasks first (none last), `small` = the
 * fewer story points first (none last), `old` = the oldest created first; equal ones keep the backlog's order. Without
 * `includeWaiting`, a PBI with a mark of 待ち / 前提 / 重なり (`itemMarks`, `auto` per workspace) is left out.
 */
export function pickTop(items: BacklogItem[], queue: BacklogQueue, axis: PickAxis, n: number, includeWaiting: boolean, auto: (workspaceId: string) => boolean = () => false): BacklogItem[] {
  const open = items.filter((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "needs-tasks") && !queue.items.some((e) => same(e, i)));
  const kept = includeWaiting ? open : open.filter((i) => !itemMarks(i, auto(i.workspaceId)).some((m) => WAITING_MARKS.has(m.key)));
  if (axis === "priority") return applyView(kept, { ...DEFAULT_VIEW, sort: "priority" }).slice(0, n);
  const key = (i: BacklogItem): number | null =>
    axis === "progress" ? (i.tasks && i.tasks.total > 0 ? -(i.tasks.done / i.tasks.total) : null) : axis === "small" ? i.storyPoints : Date.parse(i.createdAt);
  const keyed = kept.map((i) => ({ i, k: key(i) }));
  keyed.sort((a, b) => (a.k === null ? (b.k === null ? 0 : 1) : b.k === null ? -1 : a.k - b.k));
  return keyed.slice(0, n).map((x) => x.i);
}

/** What a queue row says under its title (#4055): `workspace · Task n/m · SP n · P · 段`, the values it has only. */
export function queueFacts(item: BacklogItem): string {
  const stage = STAGES.find(([s]) => s === item.stage)?.[1] ?? item.stage;
  return [item.workspaceName, item.tasks ? `Task ${item.tasks.done}/${item.tasks.total}` : null, item.storyPoints !== null ? `SP ${item.storyPoints}` : null, item.priority, stage].filter(Boolean).join(" · ");
}

/**
 * The queue's last decision in one line (#4055): what it started, and how many lines say why the rest were left (the
 * lines themselves are shown folded). One line alone is shown as it is (キューが空, 同時に動かす数に達している…).
 */
export function noteSummary(lastNote: string): { line: string; rest: number } {
  const lines = lastNote.split("\n").filter(Boolean);
  if (lines.length <= 1) return { line: lines[0] ?? "", rest: 0 };
  const started = lines.filter((l) => / を \S+ で開始 /.test(l + " "));
  const rest = lines.length - started.length;
  return { line: started.length ? started.join(" ・ ") : lines.find((l) => l === "進められる項目が無い") ?? lines[0]!, rest: started.length ? rest : rest - 1 };
}
