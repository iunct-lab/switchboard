import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the model and thinking effort a review job ran with; a job from before has none (null: not recorded)
  const cols = new Set((db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const name of ["model", "effort"]) if (!cols.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} TEXT`);
}

export const migration: Migration = { number: 59, name: "job-model", run };
