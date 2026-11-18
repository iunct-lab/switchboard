import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  if (!cols.has("provenance")) db.exec("ALTER TABLE tasks ADD COLUMN provenance TEXT"); // docs/design/process-kernel.md K1: what the task was started with, JSON, written once
}

export const migration: Migration = { number: 17, name: "task-provenance", run };
