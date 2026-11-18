/** What an answer to a question did. */

import type { AskAnswerResult } from "@switchboard/protocol";
import { BacklogQueries } from "./backlog.ts";

/** What an answer to a question did. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class AskAnswerQueries extends BacklogQueries {
  /**
   * What an answer to a question did, by the question's id: `result` (what the answer answered, null while only a failed
   * start is known) and `failure` (a start that failed after the answer). A field not passed keeps its value.
   */
  rememberAskAnswer(id: string, row: { at: number; result?: AskAnswerResult | null; failure?: { at: number; reason: string } | null }): void {
    const had = this.askAnswer(id);
    const result = row.result === undefined ? (had?.result ?? null) : row.result;
    const failure = row.failure === undefined ? (had?.failure ?? null) : row.failure;
    this.sqlite
      .query("INSERT INTO ask_answers (id, at, result, failure) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, result = excluded.result, failure = excluded.failure")
      .run(id, row.at, result ? JSON.stringify(result) : null, failure ? JSON.stringify(failure) : null);
  }

  askAnswer(id: string): { at: number; result: AskAnswerResult | null; failure: { at: number; reason: string } | null } | null {
    const r = this.sqlite.query("SELECT at, result, failure FROM ask_answers WHERE id = ?").get(id) as { at: number; result: string | null; failure: string | null } | null;
    return r ? { at: r.at, result: r.result ? (JSON.parse(r.result) as AskAnswerResult) : null, failure: r.failure ? (JSON.parse(r.failure) as { at: number; reason: string }) : null } : null;
  }

  /** Forgets the answers older than `before` (ms). */
  pruneAskAnswers(before: number): void {
    this.sqlite.query("DELETE FROM ask_answers WHERE at < ?").run(before);
  }
}
