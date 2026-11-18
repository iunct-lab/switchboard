/** Schedules and their log. */

import type { Schedule, Task } from "@switchboard/protocol";
import { rowToTask } from "./tasks.ts";
import { StagingQueries } from "./staging.ts";

/** How long the schedules log keeps its lines. */
export const SCHEDULE_LOG_KEEP_MS = 90 * 24 * 3600 * 1000;

/** Schedules and their log. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class ScheduleQueries extends StagingQueries {
  /* ---------- schedules ---------- */

  listSchedules(): Schedule[] {
    return this.sqlite.query("SELECT * FROM schedules ORDER BY created_at").all().map(rowToSchedule);
  }

  getSchedule(id: string): Schedule | null {
    const r = this.sqlite.query("SELECT * FROM schedules WHERE id = ?").get(id);
    return r ? rowToSchedule(r) : null;
  }

  insertSchedule(s: Schedule): Schedule {
    this.sqlite
      .query("INSERT INTO schedules (id, title, cron, workspace_id, runner, model, effort, prompt, action, budget_usd, enabled, last_run_at, last_task_id, next_run_at, last_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.title, s.cron, s.workspaceId, s.runner, s.model, s.effort, s.prompt, s.action, s.budgetUsd, s.enabled ? 1 : 0, s.lastRunAt, s.lastTaskId, s.nextRunAt, s.lastResult ? JSON.stringify(s.lastResult) : null, s.createdAt);
    return s;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "createdAt">>): Schedule | null {
    const cur = this.getSchedule(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    // a result belongs to the secret-scan action: a schedule turned into another action starts without one
    if (patch.action !== undefined && patch.action !== cur.action && patch.lastResult === undefined) n.lastResult = null;
    this.sqlite
      .query("UPDATE schedules SET title = ?, cron = ?, workspace_id = ?, runner = ?, model = ?, effort = ?, prompt = ?, action = ?, budget_usd = ?, enabled = ?, last_run_at = ?, last_task_id = ?, next_run_at = ?, last_result = ? WHERE id = ?")
      .run(n.title, n.cron, n.workspaceId, n.runner, n.model, n.effort, n.prompt, n.action, n.budgetUsd, n.enabled ? 1 : 0, n.lastRunAt, n.lastTaskId, n.nextRunAt, n.lastResult ? JSON.stringify(n.lastResult) : null, id);
    return n;
  }

  deleteSchedule(id: string) {
    this.sqlite.query("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /** Tasks started by schedules, newest first. */
  scheduledTasks(sinceTs: number): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE schedule_id IS NOT NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 100").all(sinceTs).map(rowToTask);
  }

  /** Saves a schedules log line and drops those older than 90 days, in one transaction. */
  addScheduleLog(row: { ts: number; scheduleId: string | null; text: string }) {
    this.sqlite.transaction(() => {
      this.sqlite.query("INSERT INTO schedule_log (ts, schedule_id, text) VALUES (?, ?, ?)").run(row.ts, row.scheduleId, row.text);
      this.sqlite.query("DELETE FROM schedule_log WHERE ts < ?").run(row.ts - SCHEDULE_LOG_KEEP_MS);
    })();
  }

  /** The last `limit` lines of the schedules log, oldest first. */
  recentScheduleLog(limit: number): Array<{ ts: number; scheduleId: string | null; text: string }> {
    const rows = this.sqlite.query("SELECT ts, schedule_id, text FROM schedule_log ORDER BY ts DESC, rowid DESC LIMIT ?").all(limit) as Array<{ ts: number; schedule_id: string | null; text: string }>;
    return rows.reverse().map((r) => ({ ts: r.ts, scheduleId: r.schedule_id, text: r.text }));
  }

  /**
   * The schedules log from `since` (epoch ms) on, oldest first: at most the newest `limit` rows, and `total` = how many
   * there are from `since` on (more than `rows` = the older ones were cut). Both read by the index on `ts`.
   */
  scheduleLogSince(since: number, limit: number): { rows: Array<{ ts: number; scheduleId: string | null; text: string }>; total: number } {
    const rows = this.sqlite.query("SELECT ts, schedule_id, text FROM schedule_log WHERE ts >= ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(since, limit) as Array<{ ts: number; schedule_id: string | null; text: string }>;
    const total = rows.length < limit ? rows.length : (this.sqlite.query("SELECT COUNT(*) AS n FROM schedule_log WHERE ts >= ?").get(since) as { n: number }).n;
    return { rows: rows.reverse().map((r) => ({ ts: r.ts, scheduleId: r.schedule_id, text: r.text })), total };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToSchedule(r: any): Schedule {
  return { id: r.id, title: r.title, cron: r.cron, workspaceId: r.workspace_id, runner: r.runner, model: r.model ?? "", effort: r.effort ?? "", prompt: r.prompt, action: r.action ?? "prompt", budgetUsd: r.budget_usd ?? null, enabled: r.enabled === 1, lastRunAt: r.last_run_at ?? null, lastTaskId: r.last_task_id ?? null, nextRunAt: r.next_run_at ?? null, lastResult: r.last_result ? (JSON.parse(r.last_result) as Schedule["lastResult"]) : null, stuck: null, createdAt: r.created_at };
}
