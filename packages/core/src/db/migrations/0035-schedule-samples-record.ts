import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";
import { safeJson } from "../util.ts";

/** The samples an instance from before the samples' list is recorded as holding (see `migrate`). */
export const SAMPLES_BEFORE_THE_LIST: readonly string[] = [
  "ui-layers-check", "eval-weekly", "review-trends", "upstream-ideas", "deps-update", "public-sync",
  "stop-reasons", "backlog-inventory", "schedule-review", "rubric-calibration", "aws-cost-weekly",
];

function run(db: Database) {
  // The monthly check was seeded under a flag of its own; the samples have one record (`schedules.samples`, the ids
  // put in). A database with the flag is an instance from before the samples: the kinds of work the first samples do
  // already run there as the person's own rows, so those ids are recorded as put in and no disabled copy is added.
  // The ids are the list at the time of this move; a sample added to the list later goes in as on any instance.
  // The flag stays (a release rolled back to reads it, and without it would seed the monthly check again, enabled); every
  // start records the same ids again, which changes nothing.
  if (db.query("SELECT 1 FROM settings WHERE key = 'uiLayers.seeded'").get()) {
    const row = db.query("SELECT json FROM settings WHERE key = 'schedules.samples'").get() as { json: string } | null;
    const have = row ? safeJson<string[]>(row.json, []) : [];
    const ids = [...new Set([...(Array.isArray(have) ? have : []), ...SAMPLES_BEFORE_THE_LIST])];
    db.query("INSERT INTO settings (key, json) VALUES ('schedules.samples', ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(JSON.stringify(ids));
  }
}

export const migration: Migration = { number: 35, name: "schedule-samples-record", run };
