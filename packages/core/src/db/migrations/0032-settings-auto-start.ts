import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // the Tasks that start by themselves ran on routing.llm.runner; they now have settings.autoStart, which starts at that value.
  const settingsRow = db.query("SELECT json FROM settings WHERE key = 'settings'").get() as { json: string } | null;
  if (settingsRow) {
    try {
      const saved = JSON.parse(settingsRow.json) as { autoStart?: unknown; routing?: { llm?: { runner?: string } } };
      if (saved && typeof saved === "object" && !saved.autoStart) {
        saved.autoStart = { runner: saved.routing?.llm?.runner ?? "claude", model: "" };
        db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify(saved));
      }
    } catch {
      // a malformed row is reported and replaced by the defaults when it is read (server/settings.ts settings())
    }
  }
}

export const migration: Migration = { number: 32, name: "settings-auto-start", run };
