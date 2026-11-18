import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const wsCols = columns("workspaces");
  if (!wsCols.has("project_var")) db.exec("ALTER TABLE workspaces ADD COLUMN project_var TEXT");
  if (!wsCols.has("backlog_source")) db.exec("ALTER TABLE workspaces ADD COLUMN backlog_source TEXT");
  if (!wsCols.has("upstream")) db.exec("ALTER TABLE workspaces ADD COLUMN upstream TEXT");
  if (!wsCols.has("rules")) db.exec("ALTER TABLE workspaces ADD COLUMN rules TEXT");
  // the workspace's settings kept here instead of an `ops.config.json` committed to its repository (the JSON text as saved)
  if (!wsCols.has("config")) db.exec("ALTER TABLE workspaces ADD COLUMN config TEXT");
  if (!wsCols.has("runner_config_ok")) db.exec("ALTER TABLE workspaces ADD COLUMN runner_config_ok TEXT");
}

export const migration: Migration = { number: 20, name: "workspace-columns", run };
