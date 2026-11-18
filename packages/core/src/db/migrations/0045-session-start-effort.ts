import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a session.start gained `effort` (the effort the process was started with); one recorded before reads as the task's
  // own, which no one could change until then ("" = the CLI's default)
  db.exec(`UPDATE events SET json = json_set(json, '$.effort', COALESCE((SELECT effort FROM tasks WHERE id = events.task_id), '')) WHERE substr(json, 1, 21) = '{"t":"session.start",' AND json_type(json, '$.effort') IS NULL`);
}

export const migration: Migration = { number: 45, name: "session-start-effort", run };
