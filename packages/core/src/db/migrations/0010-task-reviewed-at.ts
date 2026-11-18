import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("reviewed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN reviewed_at INTEGER");
    // Tasks that stopped before the 確認済み mark existed count as reviewed, so 要対応 starts empty rather than listing the whole history.
    db.exec("UPDATE tasks SET reviewed_at = updated_at WHERE status NOT IN ('running', 'waiting', 'idle')");
  }
}

export const migration: Migration = { number: 10, name: "task-reviewed-at", run };
