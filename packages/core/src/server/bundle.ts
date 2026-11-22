import { BUNDLE_HOLD_KEY, BundleHold } from "@switchboard/protocol";
import type { ServerContext } from "./context.ts";

/**
 * The hold a bundle of work has put on the daemon; null when there is none. A stored value that does not read as a
 * hold still holds (no promotion is let through on a row it cannot read), with no schedules to turn back on.
 */
export const bundleHold = (sc: Pick<ServerContext, "db">): BundleHold | null => {
  const raw = sc.db.getSetting<unknown>(BUNDLE_HOLD_KEY, null);
  if (raw === null) return null;
  const parsed = BundleHold.safeParse(raw);
  return parsed.success ? parsed.data : { taskId: "不明", since: 0, schedules: [], base: null };
};

/**
 * Begin a hold: every enabled schedule is turned off and its id kept, and from here no promotion is asked for
 * (`promotionStep`, `requestPromote`). A hold that already exists is an error: one bundle at a time.
 */
export const holdForBundle = (sc: Pick<ServerContext, "db" | "scheduler">, taskId: string, base: string | null): BundleHold => {
  const had = bundleHold(sc);
  if (had) throw new Error(`束の作業中（Task ${had.taskId}）。止めを解いてから始める`);
  const schedules = sc.scheduler.list().filter((s) => s.enabled).map((s) => s.id);
  const hold: BundleHold = { taskId, since: Date.now(), schedules, base };
  // the record first: a stop that fails half-way still knows what to turn back on
  sc.db.setSetting(BUNDLE_HOLD_KEY, hold);
  for (const id of schedules) sc.scheduler.update(id, { enabled: false });
  return hold;
};

/**
 * End the hold: only the schedules it stopped that still exist and are still off are turned back on (one the person
 * turned on or deleted meanwhile is left as it is). Without a hold nothing is done.
 */
export const releaseBundle = (sc: Pick<ServerContext, "db" | "scheduler">): { released: boolean; restored: string[] } => {
  const hold = bundleHold(sc);
  if (!hold) return { released: false, restored: [] };
  const now = new Map(sc.scheduler.list().map((s) => [s.id, s]));
  const restored = hold.schedules.filter((id) => now.get(id)?.enabled === false);
  for (const id of restored) sc.scheduler.update(id, { enabled: true });
  sc.db.setSetting(BUNDLE_HOLD_KEY, null);
  return { released: true, restored };
};
