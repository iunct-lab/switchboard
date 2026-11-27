import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // experiments registered before the work and what they decided after (db/experiments.ts)
  db.exec(
    "CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, question TEXT NOT NULL, branch_a TEXT NOT NULL, branch_b TEXT NOT NULL, metric TEXT NOT NULL, window_days INTEGER NOT NULL, registered_at INTEGER NOT NULL, decided_at INTEGER, changed INTEGER, note TEXT)",
  );
}

export const migration: Migration = { number: 62, name: "experiments", run };
