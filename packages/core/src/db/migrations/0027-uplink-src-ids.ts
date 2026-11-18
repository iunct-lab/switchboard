import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const logCols = columns("routing_log");
  const lcols = columns("ledger");
  if (!lcols.has("src_id")) db.exec("ALTER TABLE ledger ADD COLUMN src_id INTEGER");
  if (!logCols.has("src_id")) db.exec("ALTER TABLE routing_log ADD COLUMN src_id INTEGER");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ledger_src ON ledger (task_id, src_id) WHERE src_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS routing_log_src ON routing_log (task_id, src_id) WHERE src_id IS NOT NULL");
}

export const migration: Migration = { number: 27, name: "uplink-src-ids", run };
