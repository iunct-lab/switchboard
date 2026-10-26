/**
 * Which status a Task may move to, and what outcome the move implies (#1140).
 * TaskManager checks `canTransition` before it writes, and `Db.updateTask` throws
 * `InvalidTaskTransitionError` for a move the table does not have, so a row never takes a status it may not have.
 */
import type { Task, TaskStatus } from "@switchboard/protocol";

/** A Task that has ended. A person's action (a reply, a resume, a retry) moves it on, or a turn its attached runner starts on its own. */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "error", "aborted"]);

/** A Task with a turn in progress: the only states a runner's events may change. */
export const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "waiting"]);

/**
 * Moves to a different status (staying put is always allowed). `idle` is where a Cloud Task lands when its start
 * process is over (and a waiting one that a daemon restart cut); `done` from `waiting` is a turn that ended with an
 * approval left open.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  idle: new Set<TaskStatus>(["running", "error", "aborted"]),
  running: new Set<TaskStatus>(["waiting", "done", "error", "aborted", "idle"]),
  waiting: new Set<TaskStatus>(["running", "done", "error", "aborted", "idle"]),
  done: new Set<TaskStatus>(["running", "error"]),
  error: new Set<TaskStatus>(["running"]),
  aborted: new Set<TaskStatus>(["running", "error"]),
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].has(to);
}

export class InvalidTaskTransitionError extends Error {
  constructor(readonly taskId: string, readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`task ${taskId}: cannot move from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

/**
 * The outcome a status change implies (#492): waiting on the person → needs_action, error / aborted → failed, a new
 * turn → unknown, no longer reviewed and no longer judged (#493: the judgement was of the previous reply). done / idle
 * keep what the task has (the turn's start made it unknown; the last reply is judged by #493). A Cloud Task is never
 * judged here, so its outcome stays unknown.
 */
export function outcomeOnStatus(status: TaskStatus, executionMode: Task["executionMode"]): Partial<Pick<Task, "outcome" | "reviewedAt" | "judgedResult" | "judgedReason" | "judgedBy" | "judgingAt">> {
  const cleared = { reviewedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null };
  if (executionMode === "cloud") return status === "running" ? { outcome: "unknown", ...cleared } : { outcome: "unknown" };
  if (status === "waiting") return { outcome: "needs_action" };
  if (status === "error" || status === "aborted") return { outcome: "failed" };
  if (status === "running") return { outcome: "unknown", ...cleared };
  return {};
}
