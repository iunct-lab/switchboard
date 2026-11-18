import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  // Rows another machine's daemon sent (an uplink): where a Task ran (NULL = this instance) and the id a ledger / routing_log row
  // had there (AUTOINCREMENT ids collide across machines, so a row is the same by its Task and src_id; NULL = our own row).
  if (!cols.has("machine")) db.exec("ALTER TABLE tasks ADD COLUMN machine TEXT");
}

export const migration: Migration = { number: 24, name: "task-machine", run };
