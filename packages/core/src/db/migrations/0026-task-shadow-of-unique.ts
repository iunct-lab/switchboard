import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // After the ALTER (the index needs the column). Unique: one shadow per primary; NULLs (every other task) do not collide.
  db.exec("DROP INDEX IF EXISTS tasks_shadow_of");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_shadow_of_unique ON tasks (shadow_of)");
}

export const migration: Migration = { number: 26, name: "task-shadow-of-unique", run };
