import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // Status conflicts held before the send told GitHub's Project automation from a person: the send looks at each again.
  // Once: one held after this stays a conflict until it is chosen on
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 1) {
    db.exec("UPDATE backlog_operations SET status = 'pending', retry_at = NULL, error = NULL WHERE status = 'conflict' AND field = 'field:Status' AND overwritten IS NULL");
    db.exec("PRAGMA user_version = 1");
  }
}

export const migration: Migration = { number: 3, name: "status-conflicts-sent-again", version: 1, run };
