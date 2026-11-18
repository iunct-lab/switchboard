import type { Database } from "bun:sqlite";
import type { WorkspaceSweep } from "@switchboard/protocol";
import type { Columns, Migration } from "../migration.ts";
import { safeJson } from "../util.ts";

function run(db: Database, columns: Columns) {
  const wsCols = columns("workspaces");
  // backlog-next's slots move from the one setting backlogSweep to every workspace, once
  if (!wsCols.has("sweep_implement")) {
    db.transaction(() => {
      db.exec("ALTER TABLE workspaces ADD COLUMN sweep_implement INTEGER NOT NULL DEFAULT 1");
      db.exec("ALTER TABLE workspaces ADD COLUMN sweep_plan INTEGER NOT NULL DEFAULT 1");
      const r = db.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string } | null;
      const settings = r ? safeJson<Record<string, unknown>>(r.json, {}) : {};
      const old = settings.backlogSweep as Partial<WorkspaceSweep> | undefined;
      if (!old) return;
      db.query("UPDATE workspaces SET sweep_implement = ?, sweep_plan = ?").run(old.implement ?? 1, old.plan ?? 1);
      delete settings.backlogSweep;
      db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify(settings));
    })();
  }
}

export const migration: Migration = { number: 22, name: "workspace-sweep", run };
