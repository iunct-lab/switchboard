import type { Schedule } from "@switchboard/protocol";
import { jstStamp } from "./time.ts";

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
  if (r.repos === 0 && r.failed === 1 && r.hits === 0) return `最後の検査 ${stamp(r.at)}: 失敗（${r.lines[0] ?? "理由なし"}）`;
  const failed = r.failed > 0 ? ` / 検査できなかった ${r.failed}` : "";
  return `最後の検査 ${stamp(r.at)}: ${r.repos} リポジトリ / 当たり ${r.hits} 件${failed}`;
}
