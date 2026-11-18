import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const scols = columns("staging");
  if (!scols.has("diff_text")) db.exec("ALTER TABLE staging ADD COLUMN diff_text TEXT NOT NULL DEFAULT ''");
  if (!scols.has("stat")) db.exec("ALTER TABLE staging ADD COLUMN stat TEXT NOT NULL DEFAULT ''");
}

export const migration: Migration = { number: 40, name: "staging-diff-columns", run };
