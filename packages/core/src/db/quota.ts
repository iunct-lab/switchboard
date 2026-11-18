/** The runners' usage limits, per account. */

import type { RunnerId } from "@switchboard/protocol";
import { accountKey } from "./core.ts";
import { AttachmentQueries } from "./attachments.ts";

export type QuotaWindowRow = { runner: RunnerId; window: string; resetsAt: number; peak: number; firstTs: number; lastTs: number };

/** How much of an account's name the API and the screen show: enough to tell two accounts apart. */
export const ACCOUNT_SHOWN_CHARS = 8;

/** The runners' usage limits, per account. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class QuotaQueries extends AttachmentQueries {
  /**
   * Last quota report of a runner, per window (from `quota` events; the saturated window's reset time is read from it),
   * for the account the runner is logged in to on this machine: what this daemon starts, holds and resumes by. Another
   * account's rows (a work machine's, taken in) never stop this machine's Tasks.
   */
  quotaFor(runner: RunnerId): Array<{ window: string; utilization: number; resetsAt: number; ts: number }> {
    return this.sqlite.query("SELECT window, utilization, resets_at AS resetsAt, ts FROM quota_by_account WHERE runner = ? AND account = ? ORDER BY window").all(runner, this.accountOf(runner)) as Array<{ window: string; utilization: number; resetsAt: number; ts: number }>;
  }

  /**
   * A runner's adapter named the account its usage-limit report is about: that is the account this machine's runner is
   * logged in to from here on. Rows kept under the empty name (reports from before any account was named, and the rows
   * moved from the old per-runner table) are that account's too; where the account already has a row, the newer report stays.
   */
  noteAccount(runner: RunnerId, account: string) {
    const before = this.getSetting<string>(accountKey(runner), "");
    if (before === account) return;
    this.sqlite.transaction(() => {
      this.setSetting(accountKey(runner), account);
      if (before !== "") return;
      this.sqlite
        .query(
          `INSERT INTO quota_by_account (runner, account, window, utilization, resets_at, ts) SELECT runner, ?, window, utilization, resets_at, ts FROM quota_by_account WHERE runner = ? AND account = ''
           ON CONFLICT(runner, account, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, ts = excluded.ts WHERE excluded.ts > quota_by_account.ts`,
        )
        .run(account, runner);
      this.sqlite.query("DELETE FROM quota_by_account WHERE runner = ? AND account = ''").run(runner);
    })();
  }

  /** Every account's last report: what the ledger shows and what an uplink carries. `account` is the name its adapter gave it, never the provider's id. */
  quotaAll(): Array<{ runner: RunnerId; account: string; window: string; utilization: number; resetsAt: number; ts: number }> {
    return this.sqlite.query("SELECT runner, account, window, utilization, resets_at AS resetsAt, ts FROM quota_by_account ORDER BY runner, account, window").all() as Array<{ runner: RunnerId; account: string; window: string; utilization: number; resetsAt: number; ts: number }>;
  }

  /**
   * A usage-limit report of this machine's runner, kept under the account it is logged in to: the row of that
   * runner, account and window becomes this report. The provider reports the account's use, so the same account's
   * report from another machine lands on the same row; those come in by an uplink, which keeps the newer of the two.
   */
  upsertQuota(runner: RunnerId, window: string, utilization: number, resetsAt: number, ts = Date.now(), account = this.accountOf(runner)) {
    this.sqlite.transaction(() => {
      this.sqlite
        .query(
          `INSERT INTO quota_by_account (runner, account, window, utilization, resets_at, ts) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(runner, account, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, ts = excluded.ts`,
        )
        .run(runner, account, window, utilization, resetsAt, ts);
      // a report without a reset time (the adapters write 0) names no window
      if (window !== "seven_day" || resetsAt <= 0) return;
      // The reported reset time drifts by seconds between reports: a window kept within an hour of it is the same window (the kept key
      // is rounded, so a drift across the half hour is up to an hour from it; windows are 7 days apart); a new one is keyed by the hour.
      const near = this.sqlite
        .query("SELECT resets_at AS at FROM quota_windows WHERE runner = ? AND window = ? AND ABS(resets_at - ?) <= 3600 ORDER BY ABS(resets_at - ?) LIMIT 1")
        .get(runner, window, resetsAt, resetsAt) as { at: number } | null;
      this.sqlite
        .query(
          `INSERT INTO quota_windows (runner, window, resets_at, peak, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(runner, window, resets_at) DO UPDATE SET peak = MAX(peak, excluded.peak), last_ts = excluded.last_ts`,
        )
        .run(runner, window, near?.at ?? Math.round(resetsAt / 3600) * 3600, utilization, ts, ts);
    })();
  }

  /** The runners' weekly windows, newest first, each with the highest use it reached (`quota` keeps only the latest window). */
  quotaWindows(limit = 8): QuotaWindowRow[] {
    return this.sqlite
      .query("SELECT runner, window, resets_at AS resetsAt, peak, first_ts AS firstTs, last_ts AS lastTs FROM quota_windows ORDER BY resets_at DESC, runner LIMIT ?")
      .all(limit) as QuotaWindowRow[];
  }

  /** Spend in the 7 days before `resetsAt` (epoch s) split by workspace; empty when nothing was spent. */
  windowShares(runner: RunnerId, resetsAt: number): Array<{ workspaceId: string | null; costUsd: number; share: number }> {
    const rows = this.sqlite
      .query(
        `SELECT t.workspace_id AS workspaceId, SUM(l.cost_usd) AS costUsd FROM ledger l LEFT JOIN tasks t ON t.id = l.task_id
         WHERE l.runner = ? AND l.ts >= ? AND l.ts < ? GROUP BY t.workspace_id ORDER BY costUsd DESC`,
      )
      .all(runner, (resetsAt - 7 * 86400) * 1000, resetsAt * 1000) as Array<{ workspaceId: string | null; costUsd: number }>;
    const total = rows.reduce((a, r) => a + r.costUsd, 0);
    return total > 0 ? rows.map((r) => ({ ...r, share: r.costUsd / total })) : [];
  }
}
