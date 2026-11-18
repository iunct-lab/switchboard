import type { Database } from "bun:sqlite";
import { OWNER } from "../../merge-grants.ts";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // grants and scope stops name their repository and who gave them (task_grants / task_scope_stops). The rows so far did
  // not say who sent the text they were read from (a text another Task sent was recorded like the person's): they are
  // moved once under the repository of their task's workspace and marked the person's, which says more than was known.
  // They carry no head, so none of them answers a merge or answer check any more (0049); one whose repository cannot be
  // told is left behind (a grant for any repository is not made). The answers remembered as used (the setting
  // `mergeGrantAnswers`) become spent sources, so an answer that already gave its grants does not give them again.
  // The setting itself stays: a release rolled back to reads it, and without it would give those grants a second time
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 8) {
    db.transaction(() => {
      const repoOf = "(SELECT lower(json_extract(w.backlog_source, '$.repository')) FROM tasks t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = g.task_id)";
      db.exec(`INSERT OR IGNORE INTO task_grants (task_id, repo, kind, target, by, source, at) SELECT g.task_id, ${repoOf}, g.kind, g.target, '${OWNER}', '', g.at FROM merge_grants g WHERE ${repoOf} IS NOT NULL`);
      db.exec(`INSERT OR IGNORE INTO task_scope_stops (task_id, repo, issue, pr, at) SELECT g.task_id, ${repoOf}, g.issue, g.pr, g.at FROM merge_scope_stops g WHERE ${repoOf} IS NOT NULL`);
      const used = db.query("SELECT json FROM settings WHERE key = 'mergeGrantAnswers'").get() as { json: string } | null;
      const spent = db.query(`INSERT OR IGNORE INTO task_grants (task_id, repo, kind, target, by, source, at) VALUES ('', '', 'spent', 0, '${OWNER}', ?, 0)`);
      for (const id of used ? (JSON.parse(used.json) as unknown[]) : []) if (typeof id === "string" && id) spent.run(id);
      db.exec("PRAGMA user_version = 8");
    })();
  }
}

export const migration: Migration = { number: 48, name: "task-grants-by-repository", version: 8, run };
