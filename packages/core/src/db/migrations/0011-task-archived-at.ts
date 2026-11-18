import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("archived_at")) db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER");
}

export const migration: Migration = { number: 11, name: "task-archived-at", run };
