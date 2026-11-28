import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

/**
 * routing_log keeps the model the rule table proposed and the model the task was created with, next to the runners. Rows written
 * before this stay null: the rule table and the input of that day cannot be rebuilt.
 */
function run(db: Database, columns: Columns) {
  const logCols = columns("routing_log");
  if (!logCols.has("suggested_model")) db.exec("ALTER TABLE routing_log ADD COLUMN suggested_model TEXT");
  if (!logCols.has("chosen_model")) db.exec("ALTER TABLE routing_log ADD COLUMN chosen_model TEXT");
}

export const migration: Migration = { number: 64, name: "routing-log-models", run };
