import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the monthly check was a kind of its own with its prompt in the code; it is a prompt schedule now (the steps are in docs/design/ui-layers.md).
  // The sentence is the one at the time of this move, not the current constant: a row moved once stays as it was moved.
  db.query("UPDATE schedules SET action = 'prompt', prompt = ? WHERE action = 'ui-layers'").run(
    "床・天井・壁の月次の点検をしてください。手順は docs/design/ui-layers.md の「The monthly check」の節に従います。",
  );
}

export const migration: Migration = { number: 34, name: "ui-layers-schedule-prompt", run };
