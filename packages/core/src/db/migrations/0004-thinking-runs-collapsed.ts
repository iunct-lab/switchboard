import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

/** The status a runner sends while it thinks, as stored: the one form in the events. */
const THINKING_JSON = JSON.stringify({ t: "status", text: "thinking" });

function run(db: Database) {
  // a run of status `thinking` (a DAK turn writes thousands) buried the reply under the transcript's tail; once, keep
  // each run's last row only — the task's last seq and ts do not move, and nothing reads the others (TaskManager now records one)
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 2) {
    db.transaction(() => {
      db.query(
        `DELETE FROM events WHERE (task_id, seq) IN (
           SELECT task_id, seq FROM (
             SELECT task_id, seq, json, LEAD(json) OVER (PARTITION BY task_id ORDER BY seq) AS next FROM events
             WHERE task_id IN (SELECT DISTINCT task_id FROM events WHERE json = ?1))
           WHERE json = ?1 AND next = ?1)`,
      ).run(THINKING_JSON);
      db.exec("PRAGMA user_version = 2");
    })();
  }
}

export const migration: Migration = { number: 4, name: "thinking-runs-collapsed", version: 2, run };
