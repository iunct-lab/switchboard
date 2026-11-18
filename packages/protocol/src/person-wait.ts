import type { StopReasonCode } from "./events.ts";
import type { TaskStatus } from "./model/shared.ts";
import type { Task } from "./model/task.ts";

/** Statuses where the Task is at work or not started, so it waits on no one. `waiting` (an open approval) is not here. */
const AT_WORK: ReadonlySet<TaskStatus> = new Set(["running", "background", "idle"]);

/** Whether a Task waits on the person: needs them, failed, not judged yet, only waits on something else, or nothing. */
export type PersonWait = "needs" | "failed" | "unjudged" | "waits" | "none";

/** Stop reasons that wait for the person's decision or operation. `unknown` is here on purpose: not knowing is not a reason to hide it. */
export const HUMAN_STOP_REASONS: ReadonlySet<StopReasonCode> = new Set(["decision", "auth", "permission", "input", "disk-full", "unknown"]);

/**
 * The one rule for "is this Task waiting on the person", called by every place that shows or acts on it. Reviewed (確認済み)
 * or working > approval open > the outcome. The outcome is written from the stop records when they are recorded (the
 * stops' own signal), so no stop is read here: `needs_action` needs the person, `waits` waits on something else.
 */
export function personWait(t: Pick<Task, "status" | "reviewedAt" | "outcome">): PersonWait {
  if (t.reviewedAt !== null || AT_WORK.has(t.status)) return "none";
  if (t.status === "waiting") return "needs";
  switch (t.outcome) {
    case "needs_action": return "needs";
    case "failed": return "failed";
    case "unknown": return "unjudged";
    case "waits": return "waits";
    default: return "none";
  }
}
