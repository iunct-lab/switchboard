import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("shadow_stopped")) db.exec("ALTER TABLE tasks ADD COLUMN shadow_stopped INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("workspace_reason")) db.exec("ALTER TABLE tasks ADD COLUMN workspace_reason TEXT");
  if (!cols.has("outcome")) db.exec("ALTER TABLE tasks ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown'");
}

export const migration: Migration = { number: 9, name: "task-outcome-columns", run };
