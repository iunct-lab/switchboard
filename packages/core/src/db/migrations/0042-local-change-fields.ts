import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a local change gained `reviewedHead`, then the PR it stands in for (`pr`) and when its summary was left on the
  // service (`reportedAt`); one stored before (merged or not) has none: null, once
  for (const col of ["remote", "base", "local"])
    for (const key of ["reviewedHead", "pr", "reportedAt"])
      db.exec(`UPDATE backlog_records SET ${col} = json_set(${col}, '$.change.${key}', json('null')) WHERE object_kind = 'issue' AND ${col} IS NOT NULL AND json_type(${col}, '$.change') = 'object' AND json_type(${col}, '$.change.${key}') IS NULL`);
}

export const migration: Migration = { number: 42, name: "local-change-fields", run };
