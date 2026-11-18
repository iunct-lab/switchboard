import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const perfCols = columns("perf_samples");
  if (!perfCols.has("task_id")) db.exec("ALTER TABLE perf_samples ADD COLUMN task_id TEXT"); // earlier rows stay null
  if (!perfCols.has("bytes")) db.exec("ALTER TABLE perf_samples ADD COLUMN bytes INTEGER");
  if (!perfCols.has("events")) db.exec("ALTER TABLE perf_samples ADD COLUMN events INTEGER");
}

export const migration: Migration = { number: 37, name: "perf-sample-columns", run };
