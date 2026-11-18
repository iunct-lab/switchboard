/** Evaluations of Tasks and of requests. */

import { HumanEval, JudgeEval, RequestEval, RuleEval } from "@switchboard/protocol";
import type { EvalSource, EvalsListRow, RunnerId, Task, TaskEvals, TaskOutcome, TaskStatus } from "@switchboard/protocol";
import { RULES_BY } from "../evals.ts";
import { OUTCOME_SQL } from "../task-status.ts";
import { safeJson } from "./util.ts";
import { HistoryImportQueries } from "./history.ts";

/** One evaluation of a task: `json` is a `RuleEval` for `rules`; `rubric` names the rubric and version a judge used, null otherwise. */
export interface EvalRow {
  taskId: string;
  source: EvalSource;
  by: string;
  rubric: string | null;
  json: unknown;
  ts: number;
}

/** Evaluations of Tasks and of requests. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class EvalQueries extends HistoryImportQueries {
  /* ---------- evals: one row per task and source; a new evaluation replaces the old one ---------- */

  upsertEval(row: EvalRow) {
    this.sqlite
      .query(
        `INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, source) DO UPDATE SET by = excluded.by, rubric = excluded.rubric, json = excluded.json, ts = excluded.ts`,
      )
      .run(row.taskId, row.source, row.by, row.rubric, JSON.stringify(row.json), row.ts);
  }

  /* The person's evaluation of a closed request with its PBIs as one unit: one row per workspace and request, the latest.
     Not in task_evals: that table's key is a Task, and its list and its judge-vs-human gap read every row as a Task. */
  upsertRequestEval(workspaceId: string, issue: number, row: RequestEval) {
    this.sqlite
      .query("INSERT INTO request_evals (workspace_id, issue, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, issue) DO UPDATE SET json = excluded.json, ts = excluded.ts")
      .run(workspaceId, issue, JSON.stringify(row), row.ts);
  }

  getRequestEval(workspaceId: string, issue: number): RequestEval | null {
    const r = this.sqlite.query("SELECT json FROM request_evals WHERE workspace_id = ? AND issue = ?").get(workspaceId, issue) as { json: string } | null;
    const parsed = r ? RequestEval.safeParse(safeJson<unknown>(r.json, null)) : null;
    return parsed?.success ? parsed.data : null;
  }

  deleteRequestEval(workspaceId: string, issue: number) {
    this.sqlite.query("DELETE FROM request_evals WHERE workspace_id = ? AND issue = ?").run(workspaceId, issue);
  }

  /** The request evaluations written at or after `from`, newest first; of one workspace when named. */
  requestEvalsSince(from: number, workspaceId?: string): Array<{ workspaceId: string; issue: number; eval: RequestEval }> {
    const rows = this.sqlite
      .query("SELECT workspace_id AS workspaceId, issue, json FROM request_evals WHERE ts >= ?1 AND (?2 IS NULL OR workspace_id = ?2) ORDER BY ts DESC, issue DESC")
      .all(from, workspaceId ?? null) as Array<{ workspaceId: string; issue: number; json: string }>;
    return rows.flatMap((r) => {
      const parsed = RequestEval.safeParse(safeJson<unknown>(r.json, null));
      return parsed.success ? [{ workspaceId: r.workspaceId, issue: r.issue, eval: parsed.data }] : [];
    });
  }

  getEval(taskId: string, source: EvalSource): EvalRow | null {
    const r = this.sqlite.query("SELECT task_id, source, by, rubric, json, ts FROM task_evals WHERE task_id = ? AND source = ?").get(taskId, source) as { task_id: string; source: EvalSource; by: string; rubric: string | null; json: string; ts: number } | null;
    return r ? { taskId: r.task_id, source: r.source, by: r.by, rubric: r.rubric, json: JSON.parse(r.json) as unknown, ts: r.ts } : null;
  }

  deleteEval(taskId: string, source: EvalSource) {
    this.sqlite.query("DELETE FROM task_evals WHERE task_id = ? AND source = ?").run(taskId, source);
  }

  /** The task's evals as the API returns them. A row that no longer parses (an older counter, an older judge shape), or a rules row of another counter version, reads as null. */
  evalsOf(taskId: string): TaskEvals {
    const rules = this.getEval(taskId, "rules");
    const judge = this.getEval(taskId, "judge");
    const human = this.getEval(taskId, "human");
    const r = rules ? RuleEval.safeParse(rules.json) : null;
    const j = judge ? JudgeEval.safeParse(judge.json) : null;
    const h = human ? HumanEval.safeParse(human.json) : null;
    return { rules: r?.success && rules?.by === RULES_BY ? r.data : null, judge: j?.success ? j.data : null, human: h?.success ? h.data : null, models: this.taskStarts([taskId]).get(taskId)?.models ?? [] };
  }

  /**
   * What each task started its sessions with: the distinct `model` and `effort` of its `session.start`
   * events, in the order first used. A model that is empty is not counted; an effort of "" (the CLI default) is, one that
   * is absent (a start from before it was recorded) is not. Read from the events rather than `tasks.model` / `tasks.effort`
   * (the last one only) or the ledger (judging, routing and a runner's background model share the task id). A task with
   * no start is absent from the map.
   */
  taskStarts(taskIds: string[]): Map<string, { models: string[]; efforts: string[] }> {
    const out = new Map<string, { models: string[]; efforts: string[] }>();
    if (!taskIds.length) return out;
    const rows = this.sqlite
      .query(
        `SELECT task_id AS taskId, json_extract(json, '$.model') AS model, json_extract(json, '$.effort') AS effort FROM events
         WHERE task_id IN (${taskIds.map(() => "?").join(", ")}) AND json_extract(json, '$.t') = 'session.start' ORDER BY task_id, seq`,
      )
      .all(...taskIds) as Array<{ taskId: string; model: string | null; effort: string | null }>;
    for (const r of rows) {
      const cur = out.get(r.taskId) ?? { models: [], efforts: [] };
      if (r.model && !cur.models.includes(r.model)) cur.models.push(r.model);
      if (r.effort !== null && !cur.efforts.includes(r.effort)) cur.efforts.push(r.effort);
      out.set(r.taskId, cur);
    }
    return out;
  }

  /**
   * The Evals list: every task (newest first, `limit` of them), filtered by workspace / runner, with the gist of
   * its rules / judge / human rows. One query: the three eval rows are LEFT JOINed by source, the cost is the ledger's
   * sum. A row that no longer parses reads as null, as in `evalsOf`. `judgedFrom` / `judgedTo` keep the tasks whose judge
   * row was written in [from, to); `rated` the ones with a human row (the summary).
   */
  evalsList(q: { workspaceId?: string; runner?: RunnerId; judgedFrom?: number; judgedTo?: number; rated?: boolean; limit: number }): EvalsListRow[] {
    const rows = this.sqlite
      .query(
        `SELECT t.id AS taskId, t.title AS title, t.runner AS runner, t.workspace_id AS workspaceId, t.status AS status, ${OUTCOME_SQL} AS outcome, t.judged_result AS judgedResult, t.updated_at AS updatedAt, t.subagent_effort AS subagentEffort,
                (SELECT COALESCE(SUM(cost_usd), 0) FROM ledger WHERE task_id = t.id) AS costUsd,
                r.json AS rulesJson, r.by AS rulesBy, j.json AS judgeJson, j.ts AS judgeTs, h.json AS humanJson
         FROM tasks t
         LEFT JOIN task_evals r ON r.task_id = t.id AND r.source = 'rules'
         LEFT JOIN task_evals j ON j.task_id = t.id AND j.source = 'judge'
         LEFT JOIN task_evals h ON h.task_id = t.id AND h.source = 'human'
         WHERE (? IS NULL OR t.workspace_id = ?) AND (? IS NULL OR t.runner = ?)
           AND (? IS NULL OR j.ts >= ?) AND (? IS NULL OR j.ts < ?) AND (? = 0 OR h.task_id IS NOT NULL)
         ORDER BY t.updated_at DESC LIMIT ?`,
      )
      .all(q.workspaceId ?? null, q.workspaceId ?? null, q.runner ?? null, q.runner ?? null, q.judgedFrom ?? null, q.judgedFrom ?? null, q.judgedTo ?? null, q.judgedTo ?? null, q.rated ? 1 : 0, q.limit) as Array<{ taskId: string; title: string; runner: RunnerId; workspaceId: string | null; status: TaskStatus; outcome: TaskOutcome; judgedResult: Task["judgedResult"]; updatedAt: number; subagentEffort: string | null; costUsd: number; rulesJson: string | null; rulesBy: string | null; judgeJson: string | null; judgeTs: number | null; humanJson: string | null }>;
    const parse = <T>(json: string | null, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T | null => {
      if (!json) return null;
      try {
        const r = schema.safeParse(JSON.parse(json));
        return r.success ? (r.data as T) : null;
      } catch {
        return null;
      }
    };
    const starts = this.taskStarts(rows.map((r) => r.taskId));
    return rows.map((r) => {
      const rules = r.rulesBy === RULES_BY ? parse(r.rulesJson, RuleEval) : null;
      const judge = parse(r.judgeJson, JudgeEval);
      const human = parse(r.humanJson, HumanEval);
      const scores = judge ? Object.fromEntries(Object.entries(judge.scores).map(([k, v]) => [k, v.score])) : {};
      const values = Object.values(scores);
      return {
        taskId: r.taskId, title: r.title, runner: r.runner, workspaceId: r.workspaceId, status: r.status, outcome: r.outcome, judgedResult: r.judgedResult, updatedAt: r.updatedAt, costUsd: r.costUsd,
        models: starts.get(r.taskId)?.models ?? [], efforts: starts.get(r.taskId)?.efforts ?? [], subagentEffort: r.subagentEffort,
        rules: rules ? { toolCalls: rules.metrics.toolCalls, toolFailures: rules.metrics.toolFailures, errors: rules.metrics.errors, userInstructions: rules.metrics.userInstructions, stops: rules.metrics.stops, decisionStops: rules.metrics.stopReasons.decision ?? 0, lastEnd: rules.metrics.lastEnd, daemonStops: rules.metrics.daemonStops, lastCutByDaemon: rules.metrics.lastCutByDaemon } : null,
        judge: judge && values.length ? { average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10, scores, rubric: judge.rubric, by: judge.by, ts: r.judgeTs ?? 0 } : null,
        human: human ? { rating: human.rating, comment: human.comment, intent: human.intent, complexity: human.complexity, detour: human.detour, value: human.value } : null,
      };
    });
  }
}
