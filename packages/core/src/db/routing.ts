/** The routing log and its statistics. */

import type { LlmSuggestion, RoutingLogRow, RoutingStats, RunnerId, RunnerStats, Task, TaskOutcome } from "@switchboard/protocol";
import { OUTCOME_SQL } from "../task-status.ts";
import { taskDurationSql } from "./tasks.ts";
import { EventQueries } from "./events.ts";

/**
 * What a routed task cost and how long it took, for a query over `routing_log r JOIN tasks t`. The
 * duration runs to the task's last event that is not a trailing `status` rather than `updated_at` (see `routingLog`).
 */
const TASK_COST_SQL = "COALESCE((SELECT SUM(cost_usd) FROM ledger l WHERE l.task_id = r.task_id), 0)";

/** The routing log and its statistics. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class RoutingQueries extends EventQueries {
  /**
   * Keeps what the LLM proposed for a task that already exists: the proposal is worked out after the task
   * started, so it can arrive at any status, also after the end. Only `routing.llm` and its own log row change: the
   * rule row stays, `chosen` is the runner the task runs on, `ts` is the arrival, and `updatedAt` stays because advice
   * is not a change of the task's own. The first proposal stands; null = nothing written (no such task, no routing,
   * already answered).
   */
  attachLlmSuggestion(id: string, suggestion: LlmSuggestion): Task | null {
    return this.sqlite.transaction(() => {
      const cur = this.getTask(id);
      if (!cur?.routing || cur.routing.llm) return null;
      if (this.sqlite.query("SELECT 1 FROM routing_log WHERE task_id = ? AND suggested_by = 'llm'").get(id)) return null;
      const next: Task = { ...cur, routing: { ...cur.routing, llm: suggestion } };
      this.sqlite.query("UPDATE tasks SET routing = ? WHERE id = ?").run(JSON.stringify(next.routing), id);
      this.sqlite
        .query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, ?, ?, ?, 'llm', ?, ?, ?, 'llm')")
        .run(id, cur.workspaceId, cur.cwd, suggestion.runner, suggestion.reason, cur.runner, Date.now());
      return next;
    })();
  }

  /**
   * Runner of the most recent task for the same workspace *or* the same directory (tasks created through the raw API
   * or a scheduler carry no workspaceId) — the routing fallback "what you used last time". Tasks that errored or were
   * aborted do not count as "used", nor does a shadow: the person chose the primary's runner, not the shadow's.
   */
  lastRunnerFor(workspaceId: string | undefined, cwd: string | undefined): RunnerId | undefined {
    if (!workspaceId && !cwd) return undefined;
    const r = this.sqlite
      .query("SELECT runner FROM tasks WHERE (workspace_id = ?1 OR cwd = ?2) AND status NOT IN ('error', 'aborted') AND shadow_of IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(workspaceId ?? "", cwd ?? "");
    return (r as { runner?: RunnerId } | null)?.runner;
  }

  /**
   * The decision log joined with how each task ended: status, outcome, what it cost, how long it took.
   *
   * `durationMs` is creation → the task's last recorded event other than a trailing `status` (the cleanup after `done`), not `updated_at`: every patch stamps `updated_at`,
   * so raising a budget days later would otherwise report days of "work" for a decision that took a minute. It
   * keeps growing while the task is still running, and falls back to `updated_at` for a task with no events at all.
   * Clamped at 0 because an imported record can carry timestamps older than its `createdAt`.
   *
   * Ordered by `ts` then `id`: two rows of the same task (rule + llm) and tasks created in the same millisecond
   * would otherwise come back in an arbitrary order, which makes `?limit=` / `| head -n` unreproducible.
   */
  routingLog(limit = 200): RoutingLogRow[] {
    return this.sqlite
      .query(
        `SELECT r.task_id AS taskId, t.title AS title, r.suggested, r.rule_id AS ruleId, r.reason, r.chosen, r.suggested_by AS suggestedBy, r.suggested_model AS suggestedModel, r.chosen_model AS chosenModel, t.status, ${OUTCOME_SQL} AS outcome,
                ${TASK_COST_SQL} AS costUsd, ${taskDurationSql("r.task_id")} AS durationMs, r.ts
         FROM routing_log r JOIN tasks t ON t.id = r.task_id ORDER BY r.ts DESC, r.id DESC LIMIT ?`,
      )
      .all(limit) as RoutingLogRow[];
  }

  /**
   * Agreement rate per suggester over the last `days` days: how often `suggested` was the runner the task
   * actually ran on, counted from `routing_log` (one row per suggestion).
   *
   * The two denominators are not the same population and the numbers must not be read as a head-to-head score: a
   * rule suggestion is recorded for every task, an LLM one only when it answered in time, and a task a
   * schedule creates directly never asks the LLM at all. A dropped LLM answer lowers its `total`, it is not a miss.
   * Rows from any other source are reported as `otherTotal` rather than dropped, so "no records" stays truthful.
   */
  routingStats(days = 30, now = Date.now()): RoutingStats {
    const since = now - days * 24 * 3600 * 1000;
    const rows = this.sqlite
      .query("SELECT suggested_by AS suggestedBy, COUNT(*) AS total, SUM(suggested = chosen) AS agreed FROM routing_log WHERE ts >= ? GROUP BY suggested_by")
      .all(since) as Array<{ suggestedBy: string; total: number; agreed: number }>;
    const stats: RoutingStats = { rule: { total: 0, agreed: 0 }, llm: { total: 0, agreed: 0 }, otherTotal: 0, days, byRunner: [] };
    // GROUP BY never yields an empty group and both columns are NOT NULL, so `agreed` is an integer, never null.
    for (const r of rows) {
      if (r.suggestedBy === "rule" || r.suggestedBy === "llm") stats[r.suggestedBy] = { total: r.total, agreed: r.agreed };
      else stats.otherTotal += r.total;
    }
    stats.byRunner = this.runnerStats(since);
    return stats;
  }

  /**
   * How each runner's tasks turned out since `since`. Only the rule rows are read: every routed task has
   * exactly one, so a task the LLM also proposed for is not counted twice. The medians are taken here rather than in
   * SQL (SQLite has no median) — a window is a few hundred rows.
   */
  private runnerStats(since: number): RunnerStats[] {
    const rows = this.sqlite
      .query(
        `SELECT r.chosen AS runner, ${OUTCOME_SQL} AS outcome, ${TASK_COST_SQL} AS costUsd, ${taskDurationSql("r.task_id")} AS durationMs
         FROM routing_log r JOIN tasks t ON t.id = r.task_id WHERE r.suggested_by = 'rule' AND r.ts >= ?`,
      )
      .all(since) as Array<{ runner: RunnerId; outcome: TaskOutcome; costUsd: number; durationMs: number }>;
    const by = new Map<RunnerId, { outcomes: RunnerStats["outcomes"]; costs: number[]; durations: number[] }>();
    for (const r of rows) {
      let acc = by.get(r.runner);
      if (!acc) by.set(r.runner, (acc = { outcomes: { finished: 0, needs_action: 0, waits: 0, failed: 0, unknown: 0 }, costs: [], durations: [] }));
      // a value this version does not know (a newer daemon's) still counts, as not yet judged
      acc.outcomes[Object.hasOwn(acc.outcomes, r.outcome) ? r.outcome : "unknown"] += 1;
      acc.costs.push(r.costUsd);
      acc.durations.push(r.durationMs);
    }
    return [...by]
      .map(([runner, a]) => ({ runner, total: a.costs.length, outcomes: a.outcomes, medianCostUsd: median(a.costs), medianDurationMs: median(a.durations) }))
      .sort((a, b) => b.total - a.total || a.runner.localeCompare(b.runner));
  }
}

/** The middle value; the mean of the middle two for an even count; null for none. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
