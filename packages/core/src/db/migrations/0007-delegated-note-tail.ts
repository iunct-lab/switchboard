import type { Database } from "bun:sqlite";
import { delegatedNote } from "../../evals.ts";
import type { Migration } from "../migration.ts";
import { safeJson } from "../util.ts";

function run(db: Database) {
  // The 実装 Task's note of the model it handed each Task to lost its "（試験）" tail: rows written with it are rewritten once, here
  // (the old tail lives only in this block; evals.ts reads one form). Only a `status` row of that exact shape: a tool call that quotes the sentence stays.
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version < 5) {
    db.transaction(() => {
      const head = "Task ごとの実装は ";
      const oldTail = " に任せます（試験）";
      const rows = db.query("SELECT task_id AS taskId, seq, json FROM events WHERE json LIKE '%に任せます（試験）%'").all() as Array<{ taskId: string; seq: number; json: string }>;
      const set = db.query("UPDATE events SET json = ? WHERE task_id = ? AND seq = ?");
      for (const r of rows) {
        const ev = safeJson<{ t?: string; text?: unknown } | null>(r.json, null);
        if (!ev || ev.t !== "status" || typeof ev.text !== "string" || !ev.text.startsWith(head) || !ev.text.endsWith(oldTail)) continue;
        const model = ev.text.slice(head.length, -oldTail.length);
        if (model) set.run(JSON.stringify({ ...ev, text: delegatedNote(model) }), r.taskId, r.seq);
      }
      db.exec("PRAGMA user_version = 5");
    })();
  }
}

export const migration: Migration = { number: 7, name: "delegated-note-tail", version: 5, run };
