import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const opCols = columns("backlog_operations");
  if (!opCols.has("overwritten")) db.exec("ALTER TABLE backlog_operations ADD COLUMN overwritten TEXT");
}

export const migration: Migration = { number: 2, name: "backlog-operations-overwritten", run };
