import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // 1 = every turn a waiting Task will start with is an automatic one (a resume or a daemon turn); a person's reply
  // puts it back to 0. A row already waiting counts as 0: it is not cancelled on its own.
  const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "queued_resume")) db.exec("ALTER TABLE tasks ADD COLUMN queued_resume INTEGER NOT NULL DEFAULT 0");
}

export const migration: Migration = { number: 53, name: "queued-resume", run };
