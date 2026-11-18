import type { Health } from "./api/daemon.ts";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/**
 * A Task whose record came from another machine (a work machine's uplink) is read only here: why the reply box is
 * off, in the words the API refuses a reply with. Null = this instance's own Task.
 */
export function readOnlyReason(task: { machine?: string | null }): string | null {
  return task.machine ? t(m.machineReadOnly, { machine: task.machine }) : null;
}

/** The band shown while deltas from a newer database wait to be taken in: one line per machine, with both levels. Null = none wait. */
export function uplinkSkippedBanner(skipped: Health["uplinkSkipped"]): string | null {
  if (!skipped?.length) return null;
  const latest = new Map(skipped.map((s) => [s.machine, s]));
  return [...latest.values()].map((s) => t(m.uplinkSkipped, { machine: s.machine, theirs: s.theirs, ours: s.ours })).join(" / ");
}
