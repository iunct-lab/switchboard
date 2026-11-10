/**
 * Which status a Task may move to, and what outcome the move implies (#1140).
 * TaskManager checks `canTransition` before it writes, and `Db.updateTask` throws
 * `InvalidTaskTransitionError` for a move the table does not have, so a row never takes a status it may not have.
 */
import type { Task, TaskStatus } from "@switchboard/protocol";

/** A Task that has ended. A person's action (a reply, a resume, a retry) moves it on, or a turn its attached runner starts on its own. */
export const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "error", "aborted"]);

/** The turn has ended: `TERMINAL` plus `background` (the runner is done with the turn, a background process is not). What runs after a turn (judge, checks, batches) takes this; what clears a Task's record, tmp or MCP stays on `TERMINAL`. */
export const TURN_ENDED: ReadonlySet<TaskStatus> = new Set<TaskStatus>([...TERMINAL, "background"]);

/** The turn ended ok (`done`, or `background` when a background process remains): what a reply is judged, checked and sent on after. `error` / `aborted` are in `TURN_ENDED` but not here. */
export const TURN_DONE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "background"]);

/** A Task with a turn in progress: the only states a runner's events may change. */
export const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "waiting"]);

/**
 * Moves to a different status (staying put is always allowed). `idle` is where a Cloud Task lands when its start
 * process is over (and a waiting one that a daemon restart cut); `done` from `waiting` is a turn that ended with an
 * approval left open.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  idle: new Set<TaskStatus>(["running", "error", "aborted"]),
  running: new Set<TaskStatus>(["waiting", "background", "done", "error", "aborted", "idle"]),
  waiting: new Set<TaskStatus>(["running", "background", "done", "error", "aborted", "idle"]),
  background: new Set<TaskStatus>(["running", "done", "error", "aborted"]),
  done: new Set<TaskStatus>(["running", "background", "error"]),
  error: new Set<TaskStatus>(["running"]),
  aborted: new Set<TaskStatus>(["running", "error"]),
};

/** Where a Task is in its work, from its status and `resumeAt` (docs/design/task-work-phase.md). `resume` is not a status: a stopped Task with a planned resume. */
export type WorkPhase = "turn" | "approval" | "background" | "resume" | "stopped";

export function workPhase(t: Pick<Task, "status" | "resumeAt">): WorkPhase {
  if (t.status === "running") return "turn";
  if (t.status === "waiting") return "approval";
  if (t.status === "background") return "background";
  if (TERMINAL.has(t.status) && t.resumeAt !== null) return "resume";
  return "stopped";
}

/** What a count of "working" Tasks is for. The set is fixed, not a setting. */
export type WorkPurpose = "dedupe" | "slot" | "gate" | "display";

/** Which phases count as working for each purpose: the one table (the same one is in docs/design/task-work-phase.md). */
export const COUNTS: Record<WorkPurpose, ReadonlySet<WorkPhase>> = {
  dedupe: new Set<WorkPhase>(["turn", "approval", "background", "resume"]),
  slot: new Set<WorkPhase>(["turn", "approval", "background"]),
  gate: new Set<WorkPhase>(["turn", "approval", "background"]),
  display: new Set<WorkPhase>(["turn", "approval", "background"]),
};

export function isWorking(t: Pick<Task, "status" | "resumeAt">, purpose: WorkPurpose): boolean {
  return COUNTS[purpose].has(workPhase(t));
}

const STATUS_OF_PHASE = { turn: "running", approval: "waiting", background: "background" } as const;

/** The SQL condition on `tasks` rows (columns `status`, `resume_at`) that selects the same rows as `isWorking(·, purpose)`. */
export function workingSql(purpose: WorkPurpose, alias?: string): string {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const statuses = (Object.keys(STATUS_OF_PHASE) as Array<keyof typeof STATUS_OF_PHASE>).filter((p) => COUNTS[purpose].has(p)).map((p) => `'${STATUS_OF_PHASE[p]}'`);
  const parts: string[] = [];
  if (statuses.length) parts.push(`${col("status")} IN (${statuses.join(", ")})`);
  if (COUNTS[purpose].has("resume")) parts.push(`(${col("resume_at")} IS NOT NULL AND ${col("status")} IN (${[...TERMINAL].map((s) => `'${s}'`).join(", ")}))`);
  return parts.length ? `(${parts.join(" OR ")})` : "0";
}

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
