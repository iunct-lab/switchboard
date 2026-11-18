import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the backlog queue's last decision gained its time; a queue stored before has none (null), once
  db.exec(`UPDATE settings SET json = json_set(json, '$.lastNoteAt', json('null')) WHERE key = 'backlogQueue' AND json_valid(json) AND json_type(json, '$.lastNoteAt') IS NULL`);
}

export const migration: Migration = { number: 38, name: "backlog-queue-last-note-at", run };
