import { z } from "zod";
import { StopCondition, StopReasonCode, StopRecord, StopState } from "../events.ts";

/**
 * What changed since the previous stop of the same work + op + target: a new answer, a condition that came to be
 * met, a condition whose value moved, or a different cause (another reason, or for `unknown` other evidence).
 */
export const StopChange = z.object({ kind: z.enum(["answer", "condition-met", "condition", "cause"]), detail: z.string() });
export type StopChange = z.infer<typeof StopChange>;

/**
 * What the work needs next: none = it went on; resume = an answer / condition changed, so going on once is due;
 * wait = nothing to do until a condition changes (no new question, no 「続けて」); retry = a bounded retry is running;
 * decide = the person has to answer (retries used up, or a reason only a person can fix — auth / permission / input /
 * decision / unknown — that has no answer of its own yet: an answer counts for the stop that was newest when it was
 * given). A new cause of such a reason is always asked; one that time or a condition fixes waits.
 */
export const StopNext = z.enum(["none", "resume", "wait", "retry", "decide"]);
export type StopNext = z.infer<typeof StopNext>;

/**
 * One series of stops: the stops with the same key (`stopKey`), told from the daemon's `stop.record` events.
 * `count` = how many times it stopped; the rest is from the newest stop. `lastAnswer` = the newest answer in the series.
 * `unchanged` = it stopped again with nothing changed since the previous stop.
 */
export const StopSummary = z.object({
  key: z.string(),
  work: StopRecord.shape.work,
  op: z.string(),
  target: z.string(),
  reason: StopReasonCode,
  evidence: z.string(),
  safety: StopRecord.shape.safety,
  count: z.number(),
  state: StopState,
  firstAt: z.number(),
  lastAt: z.number(),
  lastAnswer: StopRecord.shape.answer,
  /** The newest stop has the person's answer, given after it came (one the daemon saw them give, to this series): the person already acted on it. An answer carried over from an earlier stop is not one. */
  answered: z.boolean(),
  /** The newest stop's grant. */
  grant: z.string().nullable(),
  conditions: z.array(StopCondition),
  actions: StopRecord.shape.actions,
  changes: z.array(StopChange),
  unchanged: z.boolean(),
  next: StopNext,
});
export type StopSummary = z.infer<typeof StopSummary>;
