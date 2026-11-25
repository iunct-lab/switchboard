import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the backlog queue gained the stall it keeps (starting nothing, since when, held by whom); a queue stored before has none (null), once
  db.exec(`UPDATE settings SET json = json_set(json, '$.stall', json('null')) WHERE key = 'backlogQueue' AND json_valid(json) AND json_type(json, '$.stall') IS NULL`);
}

export const migration: Migration = { number: 58, name: "backlog-queue-stall", run };
