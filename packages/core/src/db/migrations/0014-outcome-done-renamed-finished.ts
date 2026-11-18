import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the outcome `done` was renamed `finished` so no outcome shares a name with the status `done`; rows from before are rewritten (a no-op once none is left)
  db.exec("UPDATE tasks SET outcome = 'finished' WHERE outcome = 'done'");
  db.exec("UPDATE tasks SET judged_result = 'finished' WHERE judged_result = 'done'");
  db.exec("UPDATE task_evals SET json = json_set(json, '$.outcome', 'finished') WHERE source = 'rules' AND json_extract(json, '$.outcome') = 'done'"); // the rules row keeps the task's outcome of its moment
}

export const migration: Migration = { number: 14, name: "outcome-done-renamed-finished", run };
