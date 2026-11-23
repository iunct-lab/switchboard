/** Grants of Tasks. */

import { OWNER, USED_ANSWERS_KEPT, USED_ANSWERS_KEY } from "../merge-grants.ts";
import { AskAnswerQueries } from "./asks.ts";

export { USED_ANSWERS_KEPT, USED_ANSWERS_KEY };

/** Grants of Tasks. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class GrantQueries extends AskAnswerQueries {
  /**
   * Records one grant (the table's comment says what each field is); a repeat moves its time and its head, unless the
   * record already holds a later time (a read of the person's words that ends after a later sentence keeps that sentence's). `head`: the
   * head the PR had when a merge / answer grant was given, '' when it could not be read (the grant then answers for no head).
   */
  recordMergeGrant(g: { taskId: string; repo: string; kind: string; target: number; by: string; source?: string; head?: string }, at = Date.now()): void {
    this.sqlite
      .query("INSERT INTO task_grants (task_id, repo, kind, target, by, source, at, head) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, repo, kind, target, by, source) DO UPDATE SET at = excluded.at, head = excluded.head WHERE excluded.at >= task_grants.at")
      .run(g.taskId, g.repo.toLowerCase(), g.kind, g.target, g.by, g.source ?? "", at, g.head ?? "");
  }

  /**
   * Records the grants one text gave (`recordMergeGrant` each), all or none. `source`: the screen answer the text is.
   * Its id is spent here by the rows that carry it, and it is written to the setting the release before this one keeps
   * its used answers in (`USED_ANSWERS_KEY`) in the same transaction — after a rollback that release reads the setting,
   * not this table, and would give the answer's grants to the next stage Task again. The form is that release's: an
   * array of ids, the newest `USED_ANSWERS_KEPT` of them.
   */
  recordMergeGrants(rows: Array<Parameters<GrantQueries["recordMergeGrant"]>[0]>, at = Date.now(), source?: string): void {
    this.sqlite.transaction(() => {
      for (const r of rows) this.recordMergeGrant(r, at);
      if (!source || !rows.length) return;
      const kept = this.getSetting<unknown>(USED_ANSWERS_KEY, []);
      const used = Array.isArray(kept) ? kept.filter((x): x is string => typeof x === "string") : [];
      if (!used.includes(source)) this.setSetting(USED_ANSWERS_KEY, [...used, source].slice(-USED_ANSWERS_KEPT));
    })();
  }

  /**
   * When a grant recorded as the person's (`by = 'owner'`: merge-grants.ts says what that does and does not mean) was last
   * given to the task (ms), or null. A row another Task's text left, or one whose sender was not told, does not answer.
   * A merge or answer grant answers only for `head`, the head the PR had when it was given: no head asked with, a grant
   * recorded without one, or a PR that has moved since is null. An `answer` question (the ask reason) is also answered by
   * a `merge` record of the same PR and head: whoever allows the merge that skips the gate allows the step before it; a
   * `merge` question is answered by a `merge` record only.
   */
  mergeGrantAt(taskId: string, repo: string, kind: string, target: number, head?: string): number | null {
    if (!head) return null;
    const r = this.sqlite.query("SELECT MAX(at) AS at FROM task_grants WHERE task_id = ? AND repo = ? AND kind IN (?, ?) AND target = ? AND by = ? AND head = ?").get(taskId, repo.toLowerCase(), kind, kind === "answer" ? "merge" : kind, target, OWNER, head.toLowerCase()) as { at: number | null };
    return r.at;
  }

  hasMergeGrant(taskId: string, repo: string, kind: string, target: number, head?: string): boolean {
    return this.mergeGrantAt(taskId, repo, kind, target, head) !== null;
  }

  /** Whether the screen answer `source` (its comment operation id) already gave its grants to a task: it gives them once, however long ago. The old `scope` rows are not read. */
  mergeGrantSourceSpent(source: string): boolean {
    return this.sqlite.query("SELECT 1 FROM task_grants WHERE source = ? AND kind != 'scope' LIMIT 1").get(source) !== null;
  }
}
