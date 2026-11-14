import type { StopReasonCode } from "./events.ts";
import type { Task, TaskStatus, TaskStopMark } from "./model.ts";

/** Statuses where the Task is at work or not started, so it waits on no one. `waiting` (an open approval) is not here. */
const AT_WORK: ReadonlySet<TaskStatus> = new Set(["running", "background", "idle"]);

/** Whether a Task waits on the person: needs them, failed, not judged yet, only waits on something else, or nothing. */
export type PersonWait = "needs" | "failed" | "unjudged" | "waits" | "none";

/** Stop reasons that wait for the person's decision or operation. `unknown` is here on purpose: not knowing is not a reason to hide it. */
export const HUMAN_STOP_REASONS: ReadonlySet<StopReasonCode> = new Set(["decision", "auth", "permission", "input", "disk-full", "unknown"]);

/**
 * The one rule for "is this Task waiting on the person", called by every place that shows or acts on it. Priority:
 * reviewed (確認済み) or working > approval open > failed > the last stop record > the outcome. The Task's own signals
 * (approval, stop record) come before the judge's guess (outcome); who set the outcome does not change the order.
 * `stop` is the Task's own last stop (null when it has none). A stop the person answered says nothing more (they acted;
 * what the Task did after decides), and a resolved one only keeps a `needs_action` outcome from asking — the Task said
 * its stop is over, so a judged `done` / `unknown` stands.
 */
export function personWait(t: Pick<Task, "status" | "reviewedAt" | "outcome">, stop: Pick<TaskStopMark, "reason" | "state" | "answered"> | null): PersonWait {
  if (t.reviewedAt !== null || AT_WORK.has(t.status)) return "none";
  if (t.status === "waiting") return "needs";
  if (t.outcome === "failed") return "failed";
  if (stop && !stop.answered) {
    if (stop.state !== "resolved") return HUMAN_STOP_REASONS.has(stop.reason) && (stop.state === "waiting" || stop.state === "exhausted") ? "needs" : "waits";
    if (t.outcome === "needs_action") return "waits";
  }
  if (t.outcome === "needs_action") return "needs";
  if (t.outcome === "unknown") return "unjudged";
  return "none";
}
