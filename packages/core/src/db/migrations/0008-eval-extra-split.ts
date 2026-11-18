import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";
import { safeJson } from "../util.ts";

function run(db: Database) {
  // The person's answer `extra` ("unasked complexity or an alternative?") asked two things at once and split into
  // `complexity` and `detour`: "none" said neither happened, so it becomes both "none"; "some" cannot tell which, so it goes.
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 6) {
    db.transaction(() => {
      const rows = db.query("SELECT task_id AS taskId, json FROM task_evals WHERE source = 'human' AND json_extract(json, '$.extra') IS NOT NULL").all() as Array<{ taskId: string; json: string }>;
      const set = db.query("UPDATE task_evals SET json = ? WHERE task_id = ? AND source = 'human'");
      for (const r of rows) {
        const { extra, ...rest } = safeJson<Record<string, unknown>>(r.json, {});
        set.run(JSON.stringify(extra === "none" ? { ...rest, complexity: "none", detour: "none" } : rest), r.taskId);
      }
      db.exec("PRAGMA user_version = 6");
    })();
  }
}

export const migration: Migration = { number: 8, name: "eval-extra-split", version: 6, run };
