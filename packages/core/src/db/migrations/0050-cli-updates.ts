import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the history of the host CLIs' versions (cli-update-install.ts): one row per decision about a version, so it grows
  db.exec(
    "CREATE TABLE IF NOT EXISTS cli_updates (id INTEGER PRIMARY KEY, runner TEXT NOT NULL, at INTEGER NOT NULL, from_version TEXT, to_version TEXT NOT NULL, outcome TEXT NOT NULL, sha256 TEXT, reason TEXT NOT NULL, by TEXT NOT NULL)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS cli_updates_runner ON cli_updates (runner, id)");
}

export const migration: Migration = { number: 50, name: "cli-updates", run };
