import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  // the days a throwaway app read the API through the screen, and the request Task started for it
  const artCols = columns("artifacts");
  if (!artCols.has("app_days")) db.exec("ALTER TABLE artifacts ADD COLUMN app_days INTEGER NOT NULL DEFAULT 0");
  if (!artCols.has("app_last_day")) db.exec("ALTER TABLE artifacts ADD COLUMN app_last_day TEXT");
  if (!artCols.has("app_request_task_id")) db.exec("ALTER TABLE artifacts ADD COLUMN app_request_task_id TEXT");
}

export const migration: Migration = { number: 39, name: "artifact-app-columns", run };
