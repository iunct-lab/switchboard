import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // an add to the Project refused as "already exists" (its auto-add came first) failed the operation; the sender now takes
  // the item that is there, so such an operation is sent again (a create only with the Issue it made: never made twice).
  // GitHub's "Something went wrong" failed it at once too; it is an outage now, sent again (not one failed after 5 tries)
  db.exec(`UPDATE backlog_operations SET status = 'pending', attempt = 0, retry_at = NULL, error = NULL WHERE status = 'failed' AND (error LIKE '%already exists in this project%' OR error LIKE 'gh api %: gh: Something went wrong while executing your query%') AND (kind != 'create' OR remote_id IS NOT NULL)`);
}

export const migration: Migration = { number: 41, name: "backlog-operations-failed-sent-again", run };
