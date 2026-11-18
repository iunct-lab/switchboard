import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  // where a finished task's event bodies went (S3 key, when, how many rows); the rows stay, as skeletons.
  if (!cols.has("events_archive_key")) db.exec("ALTER TABLE tasks ADD COLUMN events_archive_key TEXT");
  if (!cols.has("events_archived_at")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_at INTEGER");
  if (!cols.has("events_archived_count")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_count INTEGER");
  if (!cols.has("events_archived_max_seq")) db.exec("ALTER TABLE tasks ADD COLUMN events_archived_max_seq INTEGER");
}

export const migration: Migration = { number: 18, name: "task-events-archive-columns", run };
