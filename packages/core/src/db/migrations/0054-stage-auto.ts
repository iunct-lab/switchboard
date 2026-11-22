import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // 1 = a stage Task started by itself (the queue, the schedule, the resume after an answer); a button's start stays 0.
  // A Task already there counts as 0: its Issue's first automatic start after this has no previous one and may go.
  const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "stage_auto")) db.exec("ALTER TABLE tasks ADD COLUMN stage_auto INTEGER NOT NULL DEFAULT 0");
}

export const migration: Migration = { number: 54, name: "stage-auto", run };
