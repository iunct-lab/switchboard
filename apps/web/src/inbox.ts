import type { InboxNote } from "@switchboard/protocol";

/** Notes the daemon left (they carry `source`) are notices; the rest are the user's own drafts. The API's order is kept. */
export function splitInbox(notes: InboxNote[]): { notices: InboxNote[]; drafts: InboxNote[] } {
  return { notices: notes.filter((n) => n.source), drafts: notes.filter((n) => !n.source) };
}

export function noticeSource(n: InboxNote): string {
  return n.source ? `予定「${n.source.title}」から` : "";
}
