import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // The Task (with a proof) that asked for the operation; NULL = no proof, a work machine's envelope, or written before this column.
  const cols = db.query("PRAGMA table_info(backlog_operations)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "task_id")) db.exec("ALTER TABLE backlog_operations ADD COLUMN task_id TEXT");
}

export const migration: Migration = { number: 61, name: "operation-task", run };
