import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // what the automatic promotion decided that is not in sb-rescue's history (promotion-log.ts): one row per version and kind, which a repeated decision advances
  db.exec(
    "CREATE TABLE IF NOT EXISTS promotion_decisions (sha TEXT NOT NULL, kind TEXT NOT NULL, tag TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, times INTEGER NOT NULL, tasks INTEGER NOT NULL, reason TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', file_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sha, kind))",
  );
  db.exec("CREATE INDEX IF NOT EXISTS promotion_decisions_last ON promotion_decisions (last_at)");
}

export const migration: Migration = { number: 60, name: "promotion-decisions", run };
