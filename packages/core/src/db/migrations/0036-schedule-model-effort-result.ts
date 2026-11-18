import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const schCols = columns("schedules");
  if (!schCols.has("model")) db.exec("ALTER TABLE schedules ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  if (!schCols.has("effort")) db.exec("ALTER TABLE schedules ADD COLUMN effort TEXT NOT NULL DEFAULT ''");
  if (!schCols.has("last_result")) db.exec("ALTER TABLE schedules ADD COLUMN last_result TEXT"); // JSON of ScheduleResult
}

export const migration: Migration = { number: 36, name: "schedule-model-effort-result", run };
