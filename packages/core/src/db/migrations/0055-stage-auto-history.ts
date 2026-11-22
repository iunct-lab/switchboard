import type { Database } from "bun:sqlite";
import type { Migration } from "../migration.ts";

function run(db: Database) {
  // Once: every stage Task started before the gate (stage-start-gate.ts) counts as an automatic start, so an Issue whose
  // last stage Task ended with nothing new since stays held until something happens once. Without this each of them has no
  // previous automatic start, and the first one goes at once — the Ready, 分解待ち and 要望 items the old "nothing changed
  // since the last Task" check held would all start together. A button's start stays 0.
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 9) {
    db.transaction(() => {
      // only the ones made before the first automatic start the gate recorded: a 0 after that is a button's start (the
      // entries pass `auto` since then), which never counts. With none recorded yet, every stage Task is from before the gate
      db.exec("UPDATE tasks SET stage_auto = 1 WHERE stage_issue IS NOT NULL AND stage_auto = 0 AND created_at < COALESCE((SELECT MIN(created_at) FROM tasks WHERE stage_auto = 1), 9223372036854775807)");
      db.exec("PRAGMA user_version = 9");
    })();
  }
}

export const migration: Migration = { number: 55, name: "stage-auto-history", version: 9, run };
