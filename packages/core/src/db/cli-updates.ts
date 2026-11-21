/** The history of the host CLIs' versions: what was installed, refused, left waiting, not tested, or rolled back. */

import { OpsQueries } from "./ops.ts";

export type CliUpdateOutcome = "installed" | "refused" | "waiting" | "untested" | "rolled-back";
export interface CliUpdateRow {
  runner: string;
  at: number;
  fromVersion: string | null;
  toVersion: string;
  outcome: CliUpdateOutcome;
  sha256: string | null;
  reason: string;
  /** `auto` = the daemon decided; `person` = a person asked. */
  by: "auto" | "person";
}
export type CliUpdateRecord = CliUpdateRow & { id: number };

interface Raw {
  id: number;
  runner: string;
  at: number;
  from_version: string | null;
  to_version: string;
  outcome: CliUpdateOutcome;
  sha256: string | null;
  reason: string;
  by: "auto" | "person";
}
const toRecord = (r: Raw): CliUpdateRecord => ({ id: r.id, runner: r.runner, at: r.at, fromVersion: r.from_version, toVersion: r.to_version, outcome: r.outcome, sha256: r.sha256, reason: r.reason, by: r.by });

/** The history of the host CLIs' versions. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class CliUpdateQueries extends OpsQueries {
  addCliUpdate(row: CliUpdateRow): void {
    this.sqlite
      .query("INSERT INTO cli_updates (runner, at, from_version, to_version, outcome, sha256, reason, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.runner, row.at, row.fromVersion, row.toVersion, row.outcome, row.sha256, row.reason, row.by);
  }

  /** The newest rows first. */
  listCliUpdates(limit: number): CliUpdateRecord[] {
    return (this.sqlite.query("SELECT * FROM cli_updates ORDER BY id DESC LIMIT ?").all(limit) as Raw[]).map(toRecord);
  }

  /** The rows that moved a runner's link (`installed` and `rolled-back`), the newest first. */
  linkMoves(runner: string): CliUpdateRecord[] {
    return (
      this.sqlite.query("SELECT * FROM cli_updates WHERE runner = ? AND outcome IN ('installed', 'rolled-back') ORDER BY id DESC").all(runner) as Raw[]
    ).map(toRecord);
  }

  /** The newest row of a runner (of one outcome, when given), or null. */
  lastCliUpdate(runner: string, outcome?: CliUpdateOutcome): CliUpdateRecord | null {
    const r = (outcome
      ? this.sqlite.query("SELECT * FROM cli_updates WHERE runner = ? AND outcome = ? ORDER BY id DESC LIMIT 1").get(runner, outcome)
      : this.sqlite.query("SELECT * FROM cli_updates WHERE runner = ? ORDER BY id DESC LIMIT 1").get(runner)) as Raw | null;
    return r ? toRecord(r) : null;
  }
}
