import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // What a job's record says about what it was run on, so a reader can tell a result by its target: the repository, the
  // head a review read, the base, why it was asked for, the kinds of a recheck, and what its end recorded. A job from before
  // has no head and is not moved: nothing counts it for a head.
  const cols = new Set((db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map((c) => c.name));
  const add: Array<[string, string]> = [["repo", "TEXT NOT NULL DEFAULT ''"], ["head", "TEXT"], ["base", "TEXT"], ["as_reason", "TEXT"], ["kinds", "TEXT NOT NULL DEFAULT ''"], ["result", "TEXT"]];
  for (const [name, type] of add) if (!cols.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  db.exec("CREATE INDEX IF NOT EXISTS jobs_target ON jobs (repo, pr)");
}

export const migration: Migration = { number: 56, name: "job-facts", run };
