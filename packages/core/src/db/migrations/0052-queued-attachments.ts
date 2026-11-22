import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // The attachments of the turn a waiting Task will start with, as a JSON array of attachment ids (null = none). A row
  // already waiting has none: the files its prompt named were chosen by path before, and are not guessed again.
  const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "queued_attachments")) db.exec("ALTER TABLE tasks ADD COLUMN queued_attachments TEXT");
}

export const migration: Migration = { number: 52, name: "queued-attachments", run };
