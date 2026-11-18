import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";
import { safeJson } from "../util.ts";

function run(db: Database) {
  // Settings `outbound` starts off; a database that already ran Tasks (this environment) keeps what it sent until now: both on, once
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 4) {
    db.transaction(() => {
      if (db.query("SELECT 1 FROM tasks LIMIT 1").get()) {
        const row = db.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string } | null;
        const saved = row ? safeJson<Record<string, unknown>>(row.json, {}) : {};
        saved.outbound = { classifierLog: true, runnerTelemetry: true };
        db.query("INSERT INTO settings (key, json) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(JSON.stringify(saved));
      }
      db.exec("PRAGMA user_version = 4");
    })();
  }
}

export const migration: Migration = { number: 6, name: "outbound-kept-on", version: 4, run };
