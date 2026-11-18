import type { Database } from "bun:sqlite";
import type { Columns, Migration } from "../migration.ts";

function run(db: Database, columns: Columns) {
  const cols = columns("tasks");
  // a stage Task's Issue and stage were read off its title; they are columns now. Rows from before take them from
  // the title once, here (the title forms are a copy of what startTitle wrote then; nothing reads a title afterwards).
  // One transaction: an interruption between the ALTERs and the backfill would otherwise leave the columns present and the block skipped for good.
  if (!cols.has("stage_issue")) {
    db.transaction(() => {
      db.exec("ALTER TABLE tasks ADD COLUMN stage_issue INTEGER");
      db.exec("ALTER TABLE tasks ADD COLUMN stage_action TEXT");
      const actionOfName: Record<string, string> = { "PBI にする": "to-pbi", "Task に分解": "to-tasks", "実装": "complete", "状況確認": "check", "閉じる": "close" };
      const set = db.query("UPDATE tasks SET stage_issue = ?, stage_action = ? WHERE id = ?");
      for (const r of db.query("SELECT id, title FROM tasks WHERE title GLOB '#[0-9]* *'").all() as Array<{ id: string; title: string }>) {
        const m = /^#(\d+) (PBI にする|Task に分解|実装|状況確認|閉じる): /.exec(r.title);
        if (m) set.run(Number(m[1]), actionOfName[m[2]!]!, r.id);
      }
    })();
  }
  db.exec("CREATE INDEX IF NOT EXISTS tasks_stage ON tasks (workspace_id, stage_issue)");
}

export const migration: Migration = { number: 12, name: "task-stage-columns", run };
