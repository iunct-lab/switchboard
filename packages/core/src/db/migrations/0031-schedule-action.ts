import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  // staging gained diff_text / stat after it was first made; a database from before that made every fs.write / fs.patch fail.
  const schCols = columns("schedules");
  if (!schCols.has("action")) db.exec("ALTER TABLE schedules ADD COLUMN action TEXT NOT NULL DEFAULT 'prompt'");
}

export const migration: Migration = { number: 31, name: "schedule-action", run };
