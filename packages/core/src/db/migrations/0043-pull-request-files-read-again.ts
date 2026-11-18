import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a stored PR gained `updatedAt` and `files`; one stored before is dropped and the next import reads it again
  db.exec(`DELETE FROM backlog_records WHERE object_kind = 'pull-request' AND json_type(remote, '$.files') IS NULL AND json_type(remote, '$.updatedAt') IS NULL`);
}

export const migration: Migration = { number: 43, name: "pull-request-files-read-again", run };
