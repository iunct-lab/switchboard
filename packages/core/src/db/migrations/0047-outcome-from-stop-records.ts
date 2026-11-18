import type { Database } from "bun:sqlite";
import type { StopRecord } from "@switchboard/protocol";
import { outcomeFromStops } from "../../stops.ts";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // `outcome` comes from the stop records (docs/design/task-outcome.md): a stopped Task not reviewed nor archived takes the outcome its
  // own stop records decide (one that waits for the person → needs_action, one that waits on something else → waits). `updated_at` stays.
  // Only `done`: `error` / `aborted` store `unknown` alone (their status decides the outcome), and `waiting` is the person's already.
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 7) {
    db.transaction(() => {
      const byTask = new Map<string, StopRecord[]>();
      const rows = db
        .query(
          `SELECT e.task_id AS taskId, e.json AS json FROM events e JOIN tasks t ON t.id = e.task_id
           WHERE substr(e.json, 1, 19) = '{"t":"stop.record",' AND t.reviewed_at IS NULL AND t.archived_at IS NULL AND t.status = 'done'
           ORDER BY e.ts, e.seq`,
        )
        .all() as Array<{ taskId: string; json: string }>;
      for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), (JSON.parse(r.json) as { stop: StopRecord }).stop]);
      const set = db.query("UPDATE tasks SET outcome = ? WHERE id = ?");
      for (const [id, records] of byTask) {
        // only an open stop moves the outcome: stops all closed say nothing of a later turn without a stop (the judge's or the person's outcome stays)
        const outcome = outcomeFromStops(records, false);
        if (outcome === "needs_action" || outcome === "waits") set.run(outcome, id);
      }
      db.exec("PRAGMA user_version = 7");
    })();
  }
}

export const migration: Migration = { number: 47, name: "outcome-from-stop-records", version: 7, run };
