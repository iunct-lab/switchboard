import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const logCols = columns("routing_log");
  // Rows written before the routing log kept who suggested are all rule-table suggestions, which is what the default says.
  if (!logCols.has("suggested_by")) db.exec("ALTER TABLE routing_log ADD COLUMN suggested_by TEXT NOT NULL DEFAULT 'rule'");
}

export const migration: Migration = { number: 25, name: "routing-log-suggested-by", run };
