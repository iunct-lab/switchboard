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
