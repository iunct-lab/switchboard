import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const wsCols = columns("workspaces");
  // off for every workspace there is: attaching reports to GitHub's Issues is turned on by the person, per workspace
  if (!wsCols.has("issue_artifacts")) db.exec("ALTER TABLE workspaces ADD COLUMN issue_artifacts INTEGER NOT NULL DEFAULT 0");
}

export const migration: Migration = { number: 21, name: "workspace-issue-artifacts", run };
