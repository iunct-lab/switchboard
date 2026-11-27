import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // a custom runner cannot be the saved parallel-run default any more (routes/settings.ts shadowChoosable); one saved before that becomes "do not run in parallel".
  // The per-kind parallel runs (autoStart.byKind.*.shadow) and every other key stay as they are.
  const settingsRow = db.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string } | null;
  if (settingsRow) {
    try {
      const saved = JSON.parse(settingsRow.json) as { shadowRunner?: unknown };
      if (saved && typeof saved === "object" && typeof saved.shadowRunner === "string" && saved.shadowRunner.startsWith("custom:")) {
        saved.shadowRunner = null;
        db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify(saved));
      }
    } catch {
      // a malformed row is left as it is: reading it falls back to the defaults (db/core.ts getSetting)
    }
  }
}

export const migration: Migration = { number: 63, name: "shadow-default-custom", run };
