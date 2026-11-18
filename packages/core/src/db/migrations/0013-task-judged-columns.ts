import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("judged_result")) db.exec("ALTER TABLE tasks ADD COLUMN judged_result TEXT");
  if (!cols.has("judged_reason")) db.exec("ALTER TABLE tasks ADD COLUMN judged_reason TEXT");
  if (!cols.has("judged_by")) db.exec("ALTER TABLE tasks ADD COLUMN judged_by TEXT");
  if (!cols.has("judging_at")) db.exec("ALTER TABLE tasks ADD COLUMN judging_at INTEGER");
}

export const migration: Migration = { number: 13, name: "task-judged-columns", run };
