import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  // when a task came to its status was not kept; rows from before take their last update, the best known bound
  if (!cols.has("status_at")) {
    db.transaction(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN status_at INTEGER");
      db.exec("UPDATE tasks SET status_at = updated_at");
    })();
  }
}

export const migration: Migration = { number: 19, name: "task-status-at", run };
