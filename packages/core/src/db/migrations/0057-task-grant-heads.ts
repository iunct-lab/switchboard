import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // every time a merge / answer grant was given for a head, one row each: `task_grants` keeps one row per Task, PR and way it was said, so a
  // newer grant overwrites the older head and time there (the gate asks only for the head the PR has now). This table keeps each grant of
  // each head, for the tables that count who allowed what and when (scripts/merge-audit.ts). The grants kept so far are copied once.
  db.exec("CREATE TABLE IF NOT EXISTS task_grant_heads (task_id TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, target INTEGER NOT NULL, head TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (task_id, repo, kind, target, head, by, at))");
  db.exec("INSERT OR IGNORE INTO task_grant_heads (task_id, repo, kind, target, head, by, at) SELECT task_id, lower(repo), kind, target, lower(head), by, at FROM task_grants WHERE kind IN ('answer', 'merge') AND head != ''");
}

export const migration: Migration = { number: 57, name: "task-grant-heads", run };
