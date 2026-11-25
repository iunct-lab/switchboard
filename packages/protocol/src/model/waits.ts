import { z } from "zod";

/**
 * What a wait is for: `command` = an `ops-kit wait` the Task runs, `output` = the runner's next event (a turn or its
 * background jobs), `hook` = the runner runs a hook and its heartbeats keep arriving, `person` = the person's answer or approval, `resume` = a planned resume (a usage limit, GitHub's
 * limit, a full disk, a cut turn), `depends` = a PR / an Issue, `job` = a job the daemon runs for the Task, `date` = a
 * date, `queue` = a run slot (or a promotion letting new turns start again), `stop` = another condition of an open stop.
 */
export const WaitKind = z.enum(["command", "output", "hook", "person", "resume", "depends", "job", "date", "queue", "stop"]);
export type WaitKind = z.infer<typeof WaitKind>;

/**
 * One wait of a Task, whatever it waits for: what, since when, and until when at the latest. Every wait has the limit
 * (`until`): one that lasts past it is shown as over and the person is told (docs/design/waits.md).
 */
export const WaitRecord = z.object({
  kind: WaitKind,
  /** Tells the Task's waits apart (`pr#12`, `resume`, `command:<pid>`). */
  key: z.string(),
  /** What is waited for, as shown. */
  label: z.string(),
  since: z.number(),
  /** The limit (ms): the wait is over its limit from this time on. */
  until: z.number(),
  /** A command wait that watches the other side's progress: when that last moved, and how long it may stand still (s). */
  progressAt: z.number().nullable().optional(),
  stallSec: z.number().nullable().optional(),
});
export type WaitRecord = z.infer<typeof WaitRecord>;
/** Whether a wait has lasted past its limit. The one check of every kind of wait. */
export const waitOver = (w: Pick<WaitRecord, "until">, now: number): boolean => now >= w.until;
