import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const wsCols = columns("workspaces");
  if (!wsCols.has("alloc_share")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN alloc_share REAL");
    db.exec("ALTER TABLE workspaces ADD COLUMN alloc_mode TEXT NOT NULL DEFAULT 'continuing'");
  }
}

export const migration: Migration = { number: 23, name: "workspace-allocation", run };
