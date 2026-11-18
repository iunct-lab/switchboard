/** The ledger: what was spent. */

import type { LedgerDaily, LedgerModelRow, LedgerBilling, LedgerRow, LedgerSummary, LedgerTaskRow, RunnerId } from "@switchboard/protocol";
import { billingFromRow } from "../pricing.ts";
import type { ReportedTotal } from "../pricing.ts";
import { ACCOUNT_SHOWN_CHARS } from "./quota.ts";
import { IssueWorkQueries } from "./issue-work.ts";

/** The ledger: what was spent. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class LedgerQueries extends IssueWorkQueries {
  /* ---------- ledger ---------- */

  /**
   * `reportedTotal`: the running total the row is the difference of (a cumulative report), kept for the next row.
   * A row made without a billing kind (not by `ledgerRowFor`) gets the one its own figures say (`billingFromRow`).
   */
  insertLedger(row: Omit<LedgerRow, "billing"> & { billing?: LedgerBilling }, reportedTotal?: ReportedTotal) {
    this.sqlite
      .query(
        `INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cache_write_1h, cost_usd, billed_usd, source, ts, reported_total, billing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.taskId, row.runner, row.model, row.inputTokens, row.outputTokens, row.cacheRead, row.cacheWrite, row.cacheWrite1h, row.costUsd, row.billedUsd, row.source, row.ts, reportedTotal ? JSON.stringify(reportedTotal) : null, row.billing ?? billingFromRow(row.runner, row.model, row.billedUsd > 0));
  }

  /** The last running total booked for this Task and model; null before the first. Migrated rows are not one model's. */
  lastReportedTotal(taskId: string, model: string | null): ReportedTotal | null {
    const r = this.sqlite
      .query("SELECT reported_total AS t FROM ledger WHERE task_id = ? AND model IS ? AND reported_total IS NOT NULL AND json_extract(reported_total, '$.migrated') IS NULL ORDER BY id DESC LIMIT 1")
      .get(taskId, model) as { t: string } | null;
    return r ? (JSON.parse(r.t) as ReportedTotal) : null;
  }

  /**
   * What the Task's migrated rows booked that no later row has counted against yet: the last migrated total
   * is all the models of its session together, so the first total of each model after it is counted against the rest.
   * 0 for another runner session, or when the Task had none to resume at the migration: a new session does not carry
   * the old total.
   */
  migratedCredit(taskId: string, session: string | null): number {
    const r = this.sqlite
      .query(
        `SELECT json_extract(m.reported_total, '$.costUsd') AS total, json_extract(m.reported_total, '$.session') AS session,
                (SELECT COALESCE(SUM(json_extract(l.reported_total, '$.carried')), 0) FROM ledger l WHERE l.task_id = m.task_id AND l.id > m.id) AS used
         FROM ledger m WHERE m.task_id = ? AND json_extract(m.reported_total, '$.migrated') = 1 ORDER BY m.id DESC LIMIT 1`,
      )
      .get(taskId) as { total: number; session: string | null; used: number } | null;
    if (!r || !r.session || r.session !== session) return 0;
    return Math.max(0, r.total - r.used);
  }

  taskCost(taskId: string): { costUsd: number; tokens: number } {
    const r = this.sqlite
      .query("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(input_tokens+output_tokens+cache_read+cache_write),0) AS t FROM ledger WHERE task_id = ?")
      .get(taskId) as { c: number; t: number };
    return { costUsd: r?.c ?? 0, tokens: r?.t ?? 0 };
  }

  /**
   * The ledger's spend since `since` (ms) per workspace × stage Issue (null = a Task with no stage Issue), both the
   * metered cost and what was billed. Rows with no Task are left out.
   */
  spendSince(since: number): Array<{ workspaceId: string; issue: number | null; costUsd: number; billedUsd: number }> {
    return this.sqlite
      .query(
        `SELECT t.workspace_id AS workspaceId, t.stage_issue AS issue, SUM(l.cost_usd) AS costUsd, SUM(l.billed_usd) AS billedUsd
         FROM ledger l JOIN tasks t ON t.id = l.task_id WHERE l.ts >= ? AND t.workspace_id IS NOT NULL GROUP BY t.workspace_id, t.stage_issue`,
      )
      .all(since) as Array<{ workspaceId: string; issue: number | null; costUsd: number; billedUsd: number }>;
  }

  /** Day × runner totals for the last `days` days (JST calendar days, as the Ledger screen shows them). `billing` = only the rows of that billing kind (the same on the two below). */
  ledgerDaily(days = 7, now = Date.now(), billing?: LedgerBilling): LedgerDaily[] {
    const from = new Date(jstDayStart(now, days - 1));
    const rows = this.sqlite.query("SELECT runner, ts, cost_usd, billed_usd, input_tokens + output_tokens + cache_read + cache_write AS tokens FROM ledger WHERE ts >= ?1 AND (?2 IS NULL OR billing = ?2) ORDER BY ts").all(from.getTime(), billing ?? null) as Array<{ runner: RunnerId; ts: number; cost_usd: number; billed_usd: number; tokens: number }>;
    const acc = new Map<string, LedgerDaily>();
    for (const r of rows) {
      const day = jstDay(r.ts);
      const key = `${day}|${r.runner}`;
      const cur = acc.get(key) ?? { day, runner: r.runner, costUsd: 0, billedUsd: 0, tokens: 0 };
      cur.costUsd += r.cost_usd;
      cur.billedUsd += r.billed_usd;
      cur.tokens += r.tokens;
      acc.set(key, cur);
    }
    return [...acc.values()].sort((a, b) => a.day.localeCompare(b.day) || a.runner.localeCompare(b.runner));
  }

  ledgerTasks(days = 7, now = Date.now(), limit = 50, billing?: LedgerBilling): LedgerTaskRow[] {
    const weekTs = now - days * 24 * 3600 * 1000;
    return this.sqlite
      .query(
        `SELECT l.task_id AS taskId, t.title AS title, t.runner AS runner, t.origin AS origin, MAX(l.model) AS model, SUM(l.cost_usd) AS costUsd, SUM(l.billed_usd) AS billedUsd,
                SUM(l.input_tokens + l.output_tokens + l.cache_read + l.cache_write) AS tokens, MAX(l.source = 'unpriced') AS unpriced, MAX(l.ts) AS lastTs
         FROM ledger l JOIN tasks t ON t.id = l.task_id WHERE l.ts >= ?1 AND (?3 IS NULL OR l.billing = ?3) GROUP BY l.task_id ORDER BY costUsd DESC LIMIT ?2`,
      )
      .all(weekTs, limit, billing ?? null)
      .map((r) => ({ ...(r as Omit<LedgerTaskRow, "unpriced"> & { unpriced: number }), unpriced: (r as { unpriced: number }).unpriced === 1 }));
  }

  /** Ledger screen: the period (the same days as `ledgerDaily`) per runner × model × billing kind, costliest first; `tasks` counts Tasks, not usage rows (the PBI's 件数). */
  ledgerModels(days = 7, now = Date.now(), billing?: LedgerBilling): LedgerModelRow[] {
    const from = new Date(jstDayStart(now, days - 1));
    return (
      this.sqlite
        .query(
          `SELECT runner, model, billing, COUNT(DISTINCT task_id) AS n, SUM(input_tokens + output_tokens + cache_read + cache_write) AS tokens, SUM(cost_usd) AS costUsd,
                  SUM(billed_usd) AS billedUsd, MAX(source = 'unpriced') AS unpriced
           FROM ledger WHERE ts >= ?1 AND (?2 IS NULL OR billing = ?2) GROUP BY runner, model, billing ORDER BY costUsd DESC, tokens DESC, runner, model, billing`,
        )
        .all(from.getTime(), billing ?? null) as Array<{ runner: RunnerId; model: string | null; billing: LedgerBilling; n: number; tokens: number; costUsd: number; billedUsd: number; unpriced: number }>
    ).map((r) => ({ runner: r.runner, model: r.model, billing: r.billing, tasks: r.n, tokens: r.tokens, costUsd: r.costUsd, billedUsd: r.billedUsd, unpriced: r.unpriced === 1 }));
  }

  ledgerSummary(now = Date.now()): LedgerSummary {
    const dayTs = jstDayStart(now);
    const weekTs = now - 7 * 24 * 3600 * 1000;
    const today = this.sqlite.query("SELECT runner, COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(billed_usd),0) AS b FROM ledger WHERE ts >= ? GROUP BY runner").all(dayTs) as Array<{ runner: string; c: number; b: number }>;
    const week = this.sqlite.query("SELECT COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(billed_usd),0) AS b FROM ledger WHERE ts >= ?").get(weekTs) as { c: number; b: number };
    // the account's name is cut for showing: enough to tell two apart, and never the provider's id
    const quota = this.quotaAll().map((q) => ({ ...q, account: q.account.slice(0, ACCOUNT_SHOWN_CHARS) }));
    // where the spend was made: Tasks an uplink brought carry their machine's name, this instance's own have none (null).
    // A work machine holds only its own rows, so it has the one line; the instance has one per machine, and the totals above are their sum.
    const byMachine = this.sqlite
      .query(
        `SELECT t.machine AS machine,
                COALESCE(SUM(CASE WHEN l.ts >= ?1 THEN l.cost_usd END), 0) AS todayUsd, COALESCE(SUM(l.cost_usd), 0) AS weekUsd,
                COALESCE(SUM(CASE WHEN l.ts >= ?1 THEN l.billed_usd END), 0) AS billedTodayUsd, COALESCE(SUM(l.billed_usd), 0) AS billedWeekUsd
         FROM ledger l LEFT JOIN tasks t ON t.id = l.task_id WHERE l.ts >= ?2 GROUP BY t.machine ORDER BY t.machine IS NOT NULL, t.machine`,
      )
      .all(dayTs, weekTs) as LedgerSummary["byMachine"];
    const top = this.sqlite
      .query(
        `SELECT l.task_id AS taskId, t.title AS title, l.runner AS runner, SUM(l.cost_usd) AS costUsd,
                SUM(l.input_tokens + l.output_tokens + l.cache_read + l.cache_write) AS tokens
         FROM ledger l JOIN tasks t ON t.id = l.task_id
         WHERE l.ts >= ? GROUP BY l.task_id ORDER BY costUsd DESC LIMIT 5`,
      )
      .all(weekTs) as LedgerSummary["topTasks"];
    const byRunnerToday: Record<string, number> = {};
    for (const r of today) byRunnerToday[r.runner] = r.c;
    return {
      todayUsd: today.reduce((a, r) => a + r.c, 0),
      weekUsd: week?.c ?? 0,
      billedTodayUsd: today.reduce((a, r) => a + r.b, 0),
      billedWeekUsd: week?.b ?? 0,
      byRunnerToday,
      quota,
      byMachine,
      topTasks: top,
      github: null, // the daemon's gh reads it (routes/ledger.ts); the DB does not keep it
    };
  }
}

const JST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" });
/** `YYYY-MM-DD` of the JST date, whatever the daemon's time zone. */
export function jstDay(ts: number): string {
  return JST_DAY.format(new Date(ts));
}

/** 00:00 JST of the day `back` days before `now`'s JST day. JST has no daylight saving, so every day is 24 h. */
export function jstDayStart(now: number, back = 0): number {
  return Date.parse(`${jstDay(now)}T00:00:00+09:00`) - back * 86_400_000;
}
