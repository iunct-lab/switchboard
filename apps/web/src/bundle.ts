import type { BacklogItem, BundleHold } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { bundle as m } from "./i18n/bundle.ts";
import { jstClock } from "./time.ts";

/** Whether a bundle can start, with the PBI numbers in the order chosen, or why not (empty = nothing to say yet). */
export type BundleGate = { ok: true; pbis: number[] } | { ok: false; reason: string };

/**
 * Whether the selected rows can start a bundle, and why not when they cannot. The API reads the numbers in the
 * Switchboard workspace only, so the rows are judged by `workspaceId` (a number alone would start the bundle on a
 * different PBI of the same number): a hold standing, a row of another workspace, or fewer than two rows says no.
 * `metaId` null = the workspace list is not read yet, `hold` undefined = the hold is not read yet (unknown is not
 * "none"): no, with no reason to show.
 */
export function bundleGate(selected: BacklogItem[], metaId: string | null, hold: BundleHold | null | undefined): BundleGate {
  if (metaId === null || hold === undefined) return { ok: false, reason: "" };
  if (hold) return { ok: false, reason: t(m.gateHeld) };
  const other = selected.find((i) => i.workspaceId !== metaId);
  if (other) return { ok: false, reason: t(m.gateOther, { workspace: other.workspaceName, n: other.number }) };
  if (selected.length < 2) return { ok: false, reason: t(m.gateOne) };
  return { ok: true, pbis: selected.map((i) => i.number) };
}

/** A hold whose record the daemon could not read: it still holds, but has no Task, time or version to show (`since` 0). */
export const unreadableHold = (hold: BundleHold): boolean => hold.since === 0;

/** The one line shown while the hold stands: how many schedules it stopped, since when, and the version to go back to. */
export function holdLine(hold: BundleHold, now: number): string {
  if (unreadableHold(hold)) return t(m.holdUnreadable);
  return t(m.holdLine, { n: hold.schedules.length, since: jstClock(hold.since, now), base: hold.base ?? t(m.baseNone) });
}
