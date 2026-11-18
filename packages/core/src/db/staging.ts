/** Staged writes. */

import type { StagedChange } from "@switchboard/protocol";
import { KnowledgeQueries } from "./knowledge.ts";

/** Staged writes. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class StagingQueries extends KnowledgeQueries {
  /* ---------- staged writes ---------- */

  insertStaged(c: StagedChange) {
    this.sqlite
      .query("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts, decided_at, diff_text, stat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.taskId, c.path, c.rel, c.kind, c.before, c.after, c.status, c.ts, c.decidedAt, c.diff, c.stat);
  }

  getStaged(id: string): StagedChange | null {
    const r = this.sqlite.query("SELECT * FROM staging WHERE id = ?").get(id);
    return r ? rowToStaged(r) : null;
  }

  listStaged(taskId: string): StagedChange[] {
    return this.sqlite.query("SELECT * FROM staging WHERE task_id = ? ORDER BY ts").all(taskId).map(rowToStaged);
  }

  updateStaged(id: string, status: StagedChange["status"]): StagedChange | null {
    this.sqlite.query("UPDATE staging SET status = ?, decided_at = ? WHERE id = ?").run(status, Date.now(), id);
    return this.getStaged(id);
  }

  /**
   * One row per task with at least one pending staged change (the queue's "staged" section) — a single grouped join
   * instead of a per-task pending-count query run against every task the workspace has ever had.
   */
  pendingStagedByTask(): Array<{ taskId: string; title: string; pending: number }> {
    return this.sqlite
      .query(
        `SELECT s.task_id AS taskId, t.title AS title, COUNT(*) AS pending
         FROM staging s JOIN tasks t ON t.id = s.task_id
         WHERE s.status = 'pending'
         GROUP BY s.task_id`,
      )
      .all() as Array<{ taskId: string; title: string; pending: number }>;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToStaged(r: any): StagedChange {
  return { id: r.id, taskId: r.task_id, path: r.path, rel: r.rel, kind: r.kind, before: r.before_text ?? null, after: r.after_text, status: r.status, ts: r.ts, decidedAt: r.decided_at ?? null, diff: r.diff_text ?? "", stat: r.stat ?? "" };
}
