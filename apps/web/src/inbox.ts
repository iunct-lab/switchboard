import type { InboxNote } from "@switchboard/protocol";

/** The Inbox draft opened under its row on Home (#3032): one at a time, with the title and body being edited. */
export type DraftEdit = { path: string; title: string; text: string };

/** Pressing a draft's title: opens it with its whole body, or closes it when it is the one already open. */
export function toggleDraft(open: DraftEdit | null, n: InboxNote): DraftEdit | null {
  return open?.path === n.path ? null : { path: n.path, title: n.title, text: n.body };
}

/** Whether there is anything to save: the daemon trims both, so whitespace around them is not a change. */
export function editChanged(e: DraftEdit, n: InboxNote): boolean {
  return e.title.trim() !== n.title || e.text.trim() !== n.body;
}
