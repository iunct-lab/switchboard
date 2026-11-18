import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("title_pending")) db.exec("ALTER TABLE tasks ADD COLUMN title_pending INTEGER NOT NULL DEFAULT 0"); // rows from before keep their title
}

export const migration: Migration = { number: 16, name: "task-title-pending", run };
