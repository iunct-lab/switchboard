import type { BundleHold } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { bundle as m } from "./i18n/bundle.ts";
import { jstClock } from "./time.ts";

/** The PBI numbers in what was typed: commas, spaces and a leading `#` allowed; each once, in the order typed; anything that is not a positive integer is dropped. */
export function parsePbiNumbers(text: string): number[] {
  const out: number[] = [];
  for (const word of text.split(/[\s,、]+/)) {
    const w = word.replace(/^#/, "");
    if (!/^\d+$/.test(w)) continue;
    const n = Number(w);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** A bundle can be started with two or more PBIs and no hold standing (one bundle at a time). */
export const canStartBundle = (nums: number[], hold: BundleHold | null): boolean => nums.length >= 2 && hold === null;

/** A hold whose record the daemon could not read: it still holds, but has no Task, time or version to show (`since` 0). */
export const unreadableHold = (hold: BundleHold): boolean => hold.since === 0;

/** The one line shown while the hold stands: how many schedules it stopped, since when, and the version to go back to. */
export function holdLine(hold: BundleHold, now: number): string {
  if (unreadableHold(hold)) return t(m.holdUnreadable);
  return t(m.holdLine, { n: hold.schedules.length, since: jstClock(hold.since, now), base: hold.base ?? t(m.baseNone) });
}
