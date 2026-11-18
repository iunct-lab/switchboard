import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const lcols = columns("ledger");
  // Claude's `total_cost_usd` is the session's running total, and every turn booked it whole. The rows of a
  // Task's own turns (a reported usage event of the same Task at the same time; the judge's and the routing's one-shot
  // rows have none and are each a whole fresh session) become the difference from the Task's previous row, a total
  // that went down being a new session. The total (all the models of the session together) stays in reported_total,
  // marked migrated, with the session the Task's next turn resumes (`runner_session_id`; none = it starts a new one):
  // the next rows of that session count each model's first total against it (`migratedCredit`).
  if (!lcols.has("reported_total")) {
    db.transaction(() => {
      db.exec("ALTER TABLE ledger ADD COLUMN reported_total TEXT");
      const rows = db
        .query(
          `SELECT id, task_id AS taskId, cost_usd AS cost, billed_usd AS billed, (SELECT runner_session_id FROM tasks t WHERE t.id = l.task_id) AS session
           FROM ledger l
           WHERE runner = 'claude' AND source = 'reported' AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = l.task_id AND e.ts = l.ts
             AND json_extract(e.json, '$.t') = 'usage' AND json_extract(e.json, '$.source') = 'reported')
           ORDER BY task_id, id`,
        )
        .all() as Array<{ id: number; taskId: string; cost: number; billed: number; session: string | null }>;
      const set = db.query("UPDATE ledger SET cost_usd = ?, billed_usd = ?, reported_total = ? WHERE id = ?");
      let task = "";
      let prev = 0;
      for (const r of rows) {
        if (r.taskId !== task) [task, prev] = [r.taskId, 0];
        const turn = r.cost >= prev ? Math.round((r.cost - prev) * 1e10) / 1e10 : r.cost;
        prev = r.cost;
        set.run(turn, r.billed === r.cost ? turn : r.billed, JSON.stringify({ costUsd: r.cost, migrated: true, ...(r.session ? { session: r.session } : {}) }), r.id);
      }
    })();
  }
}

export const migration: Migration = { number: 29, name: "ledger-reported-total", run };
