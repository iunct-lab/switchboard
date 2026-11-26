import type { Ask } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";

/** The id every notice of a stalled backlog queue starts with (`notice:queue-stall@<since>`). */
const STALL_PREFIX = "notice:queue-stall@";

/** The notice of a stalled backlog queue among the questions, or null: at most one is listed. */
export function stallAskOf(asks: Ask[]): Ask | null {
  return asks.find((a) => a.id.startsWith(STALL_PREFIX)) ?? null;
}

export type StallPersonRow = { text: string; badge: string | null; href: string | null; taskId: string | null };
export type StallHolderRow = { text: string; href: string | null };

/**
 * The lines of a stalled queue's notice, as Home and the questions' card show them: what waits for the person
 * (`#<PBI> <label> — <n> 件待ち`, marked when the head moved after the person's answer; it opens its Task, else its Issue)
 * and the holders (`<ref> — <n> 件（作業中 | 作業していない）`; a place waited for has no work, so no brackets). A
 * notice without `stall` has no lines.
 */
export function stallRows(a: Ask): { person: StallPersonRow[]; holders: StallHolderRow[] } {
  const s = a.stall;
  if (!s) return { person: [], holders: [] };
  return {
    person: s.person.map((p) => ({
      text: t(home.stallPersonRow, { pbi: p.pbi.number, label: p.label, n: p.held }),
      badge: p.headMoved ? t(home.stallHeadMoved) : null,
      href: p.url,
      taskId: p.taskId,
    })),
    holders: s.holders.map((h) => ({
      text: h.working === null ? t(home.stallHolderRow, { ref: h.ref, n: h.held }) : t(home.stallHolderRowWork, { ref: h.ref, n: h.held, work: t(h.working ? home.stallWorking : home.stallIdle) }),
      href: h.url,
    })),
  };
}

/**
 * After the limit, one more read this long past it: the browser's clock may run ahead of the daemon's. A clock ahead by
 * more than this is not covered: the open Home then shows the card on its next signal (a Task's row, a stop record) or
 * when it is opened again, not at the limit.
 */
export const STALL_RECHECK_GRACE_MS = 60_000;

/**
 * How long until the queue's stall reaches the limit and its notice is due (ms), or null when none is: the queue is
 * off or not stalled, or the stall is past the limit by more than the grace (the notice is read with the queue then).
 * Before the limit the wait ends 1 s past it; within the grace after it, once more at its end, for a browser clock that
 * runs ahead of the daemon's. `now` is taken before the read, so a read that crosses the limit still sets a clock.
 */
export function stallRecheckIn(q: { enabled: boolean; stall: { since: number } | null }, limitMs: number, now: number): number | null {
  if (!q.enabled || !q.stall) return null;
  const due = q.stall.since + limitMs;
  if (due > now) return due - now + 1000;
  if (due + STALL_RECHECK_GRACE_MS > now) return due + STALL_RECHECK_GRACE_MS - now;
  return null;
}

/**
 * Home's read of the stall: the notice when the queue is stalled and it is listed, and otherwise how long until the
 * queue is read again (`stallRecheckIn`). The limit (Settings) is read only then; a failed limit read only leaves no
 * clock, the card is still cleared. `at` is the time before the read.
 */
export async function readStall(
  api: {
    backlogQueue(): Promise<{ enabled: boolean; stall: { since: number } | null }>;
    asks(): Promise<{ asks: Ask[] }>;
    settings(): Promise<{ quotaAndResume: { queueStallMs: number } }>;
  },
  at: number,
): Promise<{ ask: Ask | null; wait: number | null }> {
  const q = await api.backlogQueue();
  if (!q.enabled || !q.stall) return { ask: null, wait: null };
  const ask = stallAskOf((await api.asks()).asks);
  if (ask) return { ask, wait: null };
  const limit = await api.settings().then((s) => s.quotaAndResume.queueStallMs, () => null);
  return { ask: null, wait: limit === null ? null : stallRecheckIn(q, limit, at) };
}
