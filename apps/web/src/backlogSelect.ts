import type { BacklogItem, BacklogQueue, BacklogQueueEntry } from "@switchboard/protocol";

const same = (a: BacklogQueueEntry, b: BacklogQueueEntry) => a.workspaceId === b.workspaceId && a.number === b.number;
const entryOf = (e: BacklogQueueEntry): BacklogQueueEntry => ({ workspaceId: e.workspaceId, number: e.number });

/** Whether a row can be selected: an open PBI, not a decision card (a question to answer, not something to push forward). */
export const selectable = (item: BacklogItem): boolean => item.type === "pbi" && item.stage !== "needs-decision";

/** `selected` (in the order chosen) with `entry` taken out when it is in, or put at the end when it is not. Compared by workspace and number. */
export function toggleSelected(selected: BacklogQueueEntry[], entry: BacklogQueueEntry): BacklogQueueEntry[] {
  return selected.some((e) => same(e, entry)) ? selected.filter((e) => !same(e, entry)) : [...selected, entryOf(entry)];
}

/** The queue's entries followed by the selected ones it does not have yet, in the order chosen. Compared by workspace and number, never by number alone. */
export function queueWithSelected(queue: BacklogQueue, selected: BacklogQueueEntry[]): BacklogQueueEntry[] {
  const out = queue.items.slice();
  for (const e of selected) if (!out.some((q) => same(q, e))) out.push(entryOf(e));
  return out;
}

/** The rows as a selection, in the same order. */
export const selectedOf = (items: BacklogItem[]): BacklogQueueEntry[] => items.map(entryOf);

/** The selection without what the list no longer has (a PBI closed since it was chosen) or no longer lets be chosen (it now waits for a decision: its row has no box to untick). */
export const keepOpen = (selected: BacklogQueueEntry[], items: BacklogItem[]): BacklogQueueEntry[] => {
  const kept = selected.filter((e) => items.some((i) => same(i, e) && selectable(i)));
  return kept.length === selected.length ? selected : kept;
};

/** The selected entries as the list's rows, in the order chosen (what the list no longer has is left out). */
export const rowsOf = (selected: BacklogQueueEntry[], items: BacklogItem[]): BacklogItem[] => selected.flatMap((e) => items.find((i) => same(i, e)) ?? []);

/** Whether two lists of rows are the same PBIs in the same order (what a confirmation showed against what is chosen now). */
export const sameRows = (a: BacklogQueueEntry[], b: BacklogQueueEntry[]): boolean => a.length === b.length && a.every((e, i) => same(e, b[i]!));
