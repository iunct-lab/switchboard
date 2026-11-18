/** Self-dev check runs. */

import type { CheckRun } from "@switchboard/protocol";
import { safeJson } from "./util.ts";
import { JobQueries } from "./jobs.ts";

/** Self-dev check runs. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class CheckRunQueries extends JobQueries {
  /* ---------- self-dev check runs ---------- */

  saveCheckRun(run: CheckRun) {
    this.sqlite
      .query("INSERT INTO check_runs (task_id, ok, json, ts) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET ok = excluded.ok, json = excluded.json, ts = excluded.ts")
      .run(run.taskId, run.ok ? 1 : 0, JSON.stringify(run), run.ts);
  }

  getCheckRun(taskId: string): CheckRun | null {
    const r = this.sqlite.query("SELECT json FROM check_runs WHERE task_id = ?").get(taskId) as { json: string } | null;
    return r ? safeJson<CheckRun | null>(r.json, null) : null;
  }
}
