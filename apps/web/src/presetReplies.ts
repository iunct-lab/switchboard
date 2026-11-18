import { isWorkingStatus, type PresetReply, type TaskStatus, type TaskStopMark } from "@switchboard/protocol";

/**
 * The one-press replies to show for a Task: its mark's `replies` while the Task waits on the person's reply — none
 * while it works or waits on a write approval (許可 / 拒否 stays the answer there), and none once the stop is answered.
 */
export function repliesFor(status: TaskStatus, mark: TaskStopMark | null | undefined): PresetReply[] {
  if (!mark || mark.answered || isWorkingStatus(status)) return [];
  return mark.replies;
}

/** How long a pressed one-press reply waits, and can be cancelled, before it is sent. */
export const UNDO_MS = 5000;

/** The text a reply button shows: one line, cut at `max` characters (the whole text goes in the title). */
export function shortReply(text: string, max = 28): string {
  const one = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : one;
}
