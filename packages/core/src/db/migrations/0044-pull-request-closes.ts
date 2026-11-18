import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a stored PR gained `closes`; one stored before reads as closing nothing until the next import reads it
  for (const col of ["remote", "base", "local"])
    db.exec(`UPDATE backlog_records SET ${col} = json_set(${col}, '$.closes', json('[]')) WHERE object_kind = 'pull-request' AND ${col} IS NOT NULL AND json_type(${col}, '$.closes') IS NULL`);
}

export const migration: Migration = { number: 44, name: "pull-request-closes", run };
