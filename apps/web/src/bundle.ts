import type { BacklogItem, BundleHold } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { bundle as m } from "./i18n/bundle.ts";
import { jstClock } from "./time.ts";

/** Whether a bundle can start, with the PBI numbers in the order chosen, or why not (empty = nothing to say yet). */
export type BundleGate = { ok: true; pbis: number[] } | { ok: false; reason: string };

/** A read that failed: the value to hand `bundleGate` instead of a list or hold it could not read. */
export const UNREAD = "unread" as const;

/**
 * Whether the selected rows can start a bundle, and why not when they cannot. The API reads the numbers in the
 * Switchboard workspace only, so the rows are judged by `workspaceId` (a number alone would start the bundle on a
 * different PBI of the same number): a hold standing, a row of another workspace, or fewer than two rows says no.
 * `metaId` null = the workspace list is not read yet, `hold` undefined = the hold is not read yet (unknown is not
 * "none"): no, with no reason to show. `UNREAD` = the read failed: no, with the reason to read again.
 */
export function bundleGate(selected: BacklogItem[], metaId: string | null | typeof UNREAD, hold: BundleHold | null | undefined | typeof UNREAD): BundleGate {
  if (metaId === UNREAD) return { ok: false, reason: t(m.gateWorkspacesUnread) };
  if (hold === UNREAD) return { ok: false, reason: t(m.gateHoldUnread) };
  if (metaId === null || hold === undefined) return { ok: false, reason: "" };
  if (hold) return { ok: false, reason: t(m.gateHeld) };
  const other = selected.find((i) => i.workspaceId !== metaId);
  if (other) return { ok: false, reason: t(m.gateOther, { workspace: other.workspaceName, n: other.number }) };
  if (selected.length < 2) return { ok: false, reason: t(m.gateOne) };
  return { ok: true, pbis: selected.map((i) => i.number) };
}

/**
 * A read whose answer stands only while no later read has started: an older answer or failure that arrives after a
 * newer read began is dropped, so a slow failed read does not replace a newer answer with `UNREAD`.
 */
export function latestRead<T>(read: () => Promise<T>, set: (v: T | typeof UNREAD) => void): () => Promise<void> {
  let seq = 0;
  return () => {
    const n = ++seq;
    return read().then(
      (v) => void (n === seq && set(v)),
      () => void (n === seq && set(UNREAD)),
    );
  };
}

/** A hold whose record the daemon could not read: it still holds, but has no Task, time or version to show (`since` 0). */
export const unreadableHold = (hold: BundleHold): boolean => hold.since === 0;

/** The one line shown while the hold stands: how many schedules it stopped, since when, and the version to go back to. */
export function holdLine(hold: BundleHold, now: number): string {
  if (unreadableHold(hold)) return t(m.holdUnreadable);
  return t(m.holdLine, { n: hold.schedules.length, since: jstClock(hold.since, now), base: hold.base ?? t(m.baseNone) });
}

/**
 * Why a confirmation closed under the person: a hold now stands (a bundle is under way), or else the chosen rows
 * changed. null when the hold could not be read: the gate's own reason says that, and the rows may not have changed.
 */
export function bundleClosedReason(hold: BundleHold | null | undefined | typeof UNREAD): string | null {
  if (hold === UNREAD) return null;
  return hold ? t(m.closedHeld) : t(m.closedChanged);
}

/**
 * The one line under the button: the gate's reason, with the reason the confirmation closed in front when it just did
 * (`closed`). When it closed for the hold that the gate names, the hold is not said twice; when the gate is ok the
 * line says to open it again.
 */
export function bundleReasonLine(closed: string | null, gate: BundleGate): string {
  if (!closed) return gate.ok ? "" : gate.reason;
  if (gate.ok) return t(m.closedThen, { closed, next: t(m.reopen) });
  if (closed === t(m.closedHeld) && gate.reason === t(m.gateHeld)) return closed;
  return t(m.closedThen, { closed, next: gate.reason });
}
