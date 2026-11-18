import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a stored Issue gained `stateReason`, a PR `mergeCommit`; null until the next import, which reads every Issue
  // again when a value GitHub gave lacked them (one made here gets them when it is sent)
  // a stored Issue / PR gained `closedAt` (a PR `mergedAt`): the same, so a closed one is read again for its time
  const reasonless = `(object_kind = 'issue' AND (json_type(remote, '$.stateReason') IS NULL OR json_type(remote, '$.closedAt') IS NULL)) OR (object_kind = 'pull-request' AND (json_type(remote, '$.mergeCommit') IS NULL OR json_type(remote, '$.closedAt') IS NULL OR json_type(remote, '$.mergedAt') IS NULL))`;
  // IMMEDIATE: a deferred one reads first and then cannot write when another connection (the daemon, while a CLI such
  // as events-archive opens the file) committed in between — SQLITE_BUSY_SNAPSHOT, which busy_timeout does not wait out
  db.transaction(() => {
    if (db.query(`SELECT 1 FROM backlog_records WHERE remote IS NOT NULL AND (${reasonless}) LIMIT 1`).get()) db.exec("UPDATE backlog_repositories SET cursor = NULL");
    for (const col of ["remote", "base", "local"])
      for (const [kind, key] of [["issue", "stateReason"], ["issue", "closedAt"], ["pull-request", "mergeCommit"], ["pull-request", "closedAt"], ["pull-request", "mergedAt"]])
        db.exec(`UPDATE backlog_records SET ${col} = json_set(${col}, '$.${key}', json('null')) WHERE object_kind = '${kind}' AND ${col} IS NOT NULL AND json_type(${col}, '$.${key}') IS NULL`);
  }).immediate();
}

export const migration: Migration = { number: 46, name: "backlog-close-fields", run };
