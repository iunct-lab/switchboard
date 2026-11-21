import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a comment the app wrote keeps the time its operation was made as `createdAt` (Db.writtenComment); the records stored
  // before took the service's time when they were sent or imported. The same rule for what is stored: a comment that
  // an operation names is moved back to it (not a second or more past the service's time, which GitHub gives to the second), one no operation names (written elsewhere) is left. Setting the same value again changes nothing.
  const written = `(SELECT strftime('%Y-%m-%dT%H:%M:%S', o.created_at / 1000, 'unixepoch') || '.' || printf('%03d', o.created_at % 1000) || 'Z'
                    FROM backlog_operations o WHERE o.service = r.service AND o.host = r.host AND o.repository = r.repository AND o.target_kind = 'comment' AND o.target = r.external_id AND o.kind = 'comment' ORDER BY o.seq LIMIT 1)`;
  db.transaction(() => {
    for (const col of ["remote", "base"])
      db.exec(`UPDATE backlog_records AS r SET ${col} = json_set(${col}, '$.createdAt', ${written}) WHERE object_kind = 'comment' AND ${col} IS NOT NULL AND ${written} IS NOT NULL AND julianday(${written}) < julianday(json_extract(${col}, '$.createdAt'), '+1 second')`);
  }).immediate();
}

export const migration: Migration = { number: 51, name: "comment-written-at", run };
