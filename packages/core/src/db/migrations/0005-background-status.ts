import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a turn that ended on background jobs is status `background`, not `done` with a mark; once
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 3) {
    db.exec("UPDATE tasks SET status = 'background' WHERE status = 'done' AND background IS NOT NULL");
    db.exec("PRAGMA user_version = 3");
  }
}

export const migration: Migration = { number: 5, name: "background-status", version: 3, run };
