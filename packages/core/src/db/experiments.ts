/** Experiments: registered before the work, and what they decided recorded once after. */

import type { Experiment, ExperimentInput, ExperimentOutcomeInput } from "@switchboard/protocol";
import { CliUpdateQueries } from "./cli-updates.ts";
import { newId } from "./util.ts";

interface Raw {
  id: string;
  question: string;
  branch_a: string;
  branch_b: string;
  metric: string;
  window_days: number;
  registered_at: number;
  decided_at: number | null;
  changed: number | null;
  note: string | null;
}
const toExperiment = (r: Raw): Experiment => ({
  id: r.id,
  question: r.question,
  branchA: r.branch_a,
  branchB: r.branch_b,
  metric: r.metric,
  windowDays: r.window_days,
  registeredAt: r.registered_at,
  decidedAt: r.decided_at,
  changed: r.changed === null ? null : r.changed === 1,
  note: r.note,
});

/** Experiments. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class ExperimentQueries extends CliUpdateQueries {
  registerExperiment(input: ExperimentInput, now: number): Experiment {
    const id = newId("exp");
    this.sqlite
      .query("INSERT INTO experiments (id, question, branch_a, branch_b, metric, window_days, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.question, input.branchA, input.branchB, input.metric, input.windowDays, now);
    return this.getExperiment(id)!;
  }

  getExperiment(id: string): Experiment | null {
    const r = this.sqlite.query("SELECT * FROM experiments WHERE id = ?").get(id) as Raw | null;
    return r ? toExperiment(r) : null;
  }

  /** Records the outcome once. Null = no such experiment, or one already recorded (the first record stands; `getExperiment` tells which). */
  recordExperimentOutcome(id: string, input: ExperimentOutcomeInput, now: number): Experiment | null {
    const res = this.sqlite
      .query("UPDATE experiments SET decided_at = ?, changed = ?, note = ? WHERE id = ? AND decided_at IS NULL")
      .run(now, input.changed ? 1 : 0, input.note ?? null, id);
    return res.changes === 0 ? null : this.getExperiment(id);
  }

  /** The newest registered first. */
  listExperiments(): Experiment[] {
    return (this.sqlite.query("SELECT * FROM experiments ORDER BY registered_at DESC, rowid DESC").all() as Raw[]).map(toExperiment);
  }
}
