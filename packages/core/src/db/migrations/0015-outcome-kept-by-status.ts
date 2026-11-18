import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a waiting, error or aborted Task shows its outcome from its status, so the column keeps only what the status does not decide (docs/design/task-outcome.md); idempotent
  db.exec("UPDATE tasks SET outcome = 'unknown' WHERE outcome = 'failed' OR (status IN ('waiting', 'error', 'aborted', 'running', 'idle') AND outcome <> 'unknown')");
}

export const migration: Migration = { number: 15, name: "outcome-kept-by-status", run };
