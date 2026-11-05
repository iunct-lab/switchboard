import type { Schedule } from "@switchboard/protocol";
import { jstStamp } from "./time.ts";
import { t } from "./i18n.ts";
import { backlog as m } from "./i18n/backlog.ts";

/** `M/D HH:MM` in JST, as the Task list shows times. */
const stamp = jstStamp;

/**
 * The one line a secret-scan schedule's row shows for its last firing (#1274, PBI #1286): when it ended and what it
 * found, so a clean day reads as "checked, 0 hits" and not as "nothing happened". null for the other actions and before
 * the first firing — the row then shows nothing. A firing whose scan itself failed (`repos: 0, failed: 1`) shows the
 * reason the scheduler kept as its one line.
 */
export function scheduleResultLine(s: Pick<Schedule, "action" | "lastResult">): string | null {
  if (s.action !== "secret-scan" || !s.lastResult) return null;
  const r = s.lastResult;
  // the scan itself failed (the scheduler's `repos: 0, failed: 1` with the reason as its one line); two checkouts the
  // scanner could not place (`failed: 2`) are a normal result and keep their count below
  if (r.repos === 0 && r.failed === 1 && r.hits === 0) return t(m.scanFailed, { at: stamp(r.at), reason: r.lines[0] ?? t(m.scanNoReason) });
  const failed = r.failed > 0 ? t(m.scanUnchecked, { n: r.failed }) : "";
  return t(m.scanResult, { at: stamp(r.at), repos: r.repos, hits: r.hits, failed });
}
