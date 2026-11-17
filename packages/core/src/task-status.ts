/**
 * Which status a Task may move to, and what outcome the move implies.
 * TaskManager checks `canTransition` before it writes, and `Db.updateTask` throws
 * `InvalidTaskTransitionError` for a move the table does not have, so a row never takes a status it may not have.
 */
import type { StoredOutcome, Task, TaskOutcome, TaskStatus } from "@switchboard/protocol";

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
 * process is over (and a waiting one that a daemon restart cut), and where a stopped local Task waits in the run-slot
 * queue with a reply; `done` from `waiting` is a turn that ended with an approval left open.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  idle: new Set<TaskStatus>(["running", "error", "aborted"]),
  running: new Set<TaskStatus>(["waiting", "background", "done", "error", "aborted", "idle"]),
  waiting: new Set<TaskStatus>(["running", "background", "done", "error", "aborted", "idle"]),
  background: new Set<TaskStatus>(["running", "done", "error", "aborted"]),
  done: new Set<TaskStatus>(["running", "background", "error", "idle"]),
  error: new Set<TaskStatus>(["running", "idle"]),
  aborted: new Set<TaskStatus>(["running", "error", "idle"]),
};

/** A status a planned start or resume waits in: an ended Task, or one made without starting (`idle`, held to its runner's reset). */
const RESUMABLE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([...TERMINAL, "idle"]);

/** Where a Task is in its work, from its status and `resumeAt` (docs/design/task-work-phase.md). `resume` is not a status: a stopped Task with a planned resume, or one made without starting whose start is planned. */
export type WorkPhase = "turn" | "approval" | "background" | "resume" | "stopped";

export function workPhase(t: Pick<Task, "status" | "resumeAt">): WorkPhase {
  if (t.status === "running") return "turn";
  if (t.status === "waiting") return "approval";
  if (t.status === "background") return "background";
  if (RESUMABLE.has(t.status) && t.resumeAt !== null) return "resume";
  return "stopped";
}

/** What a count of "working" Tasks is for. The set is fixed, not a setting. */
export type WorkPurpose = "dedupe" | "slot" | "gate" | "display" | "drain";

/** Which phases count as working for each purpose: the one table (the same one is in docs/design/task-work-phase.md). */
export const COUNTS: Record<WorkPurpose, ReadonlySet<WorkPhase>> = {
  dedupe: new Set<WorkPhase>(["turn", "approval", "background", "resume"]),
  slot: new Set<WorkPhase>(["turn", "approval", "background"]),
  gate: new Set<WorkPhase>(["turn", "approval", "background"]),
  display: new Set<WorkPhase>(["turn", "approval", "background"]),
  drain: new Set<WorkPhase>(["turn", "background"]),
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
  if (COUNTS[purpose].has("resume")) parts.push(`(${col("resume_at")} IS NOT NULL AND ${col("status")} IN (${[...RESUMABLE].map((s) => `'${s}'`).join(", ")}))`);
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
 * The outcome stored with a status: the ones the status does not decide. A Task waiting on the person (`waiting`) or
 * stopped by a failure (`error` / `aborted`) has its outcome from the status (`outcomeOf`), so only `unknown` is
 * stored there; a turn in progress (`running`) or one not started (`idle`) has no outcome yet. `done` and `background` (the turn has ended) keep what the judge, the
 * person or a question the turn ended on said. Both the write rule and the DB's check read this table (docs/design/task-outcome.md).
 */
export const STORED_OUTCOMES: Readonly<Record<TaskStatus, ReadonlySet<StoredOutcome>>> = {
  idle: new Set<StoredOutcome>(["unknown"]),
  running: new Set<StoredOutcome>(["unknown", "needs_action", "waits"]),
  waiting: new Set<StoredOutcome>(["unknown"]),
  background: new Set<StoredOutcome>(["finished", "needs_action", "waits", "unknown"]),
  done: new Set<StoredOutcome>(["finished", "needs_action", "waits", "unknown"]),
  error: new Set<StoredOutcome>(["unknown"]),
  aborted: new Set<StoredOutcome>(["unknown"]),
};

/** The statuses whose outcome is the status's, not a stored one. */
const DERIVED_OUTCOME: Readonly<Partial<Record<TaskStatus, TaskOutcome>>> = { waiting: "needs_action", error: "failed", aborted: "failed" };

/** The outcome a Task shows: from its status when the status decides it (waiting → needs_action, error / aborted → failed), otherwise what is stored. */
export function outcomeOf(status: TaskStatus, stored: StoredOutcome): TaskOutcome {
  return DERIVED_OUTCOME[status] ?? stored;
}

/** The SQL expression that equals `outcomeOf(status, outcome)` for a `tasks` row (columns `status`, `outcome`). */
export function outcomeSql(alias?: string): string {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const whens = Object.entries(DERIVED_OUTCOME).map(([s, o]) => `WHEN '${s}' THEN '${o}'`).join(" ");
  return `(CASE ${col("status")} ${whens} ELSE ${col("outcome")} END)`;
}

/** `outcomeSql` for a `tasks` row joined as `t`. */
export const OUTCOME_SQL = outcomeSql("t");

/** A person's outcome the Task's status does not take: its status decides it, or the status stores only unknown. */
export class OutcomeNotSettableError extends Error {
  constructor(readonly status: TaskStatus) {
    super(`この Task（${status}）の結果は手では付けられません`);
    this.name = "OutcomeNotSettableError";
  }
}

export class InvalidTaskOutcomeError extends Error {
  constructor(readonly taskId: string, readonly status: TaskStatus, readonly outcome: string) {
    super(`task ${taskId}: outcome ${outcome} cannot be stored with status ${status}`);
    this.name = "InvalidTaskOutcomeError";
  }
}

/**
 * The stored outcome a status change implies: a new turn → unknown, no longer reviewed and no longer judged (the
 * judgement was of the previous reply). waiting / error / aborted / idle → unknown: the first three show their
 * outcome from the status (`outcomeOf`), and none of the four has a stored one. A turn that ends from `waiting`
 * (done / background) leaves the approval open, so it stores needs_action. done / background otherwise keep what
 * the task has (the last reply is judged afterwards by `judge.ts`). A Cloud Task is never judged here, so its stored outcome stays
 * unknown (the outcome it shows still comes from its status through `outcomeOf`: a failed Cloud Task shows failed).
 */
export function outcomeOnStatus(status: TaskStatus, executionMode: Task["executionMode"], from?: TaskStatus): Partial<Pick<Task, "reviewedAt" | "judgedResult" | "judgedReason" | "judgedBy" | "judgingAt">> & { outcome?: StoredOutcome } {
  const cleared = { reviewedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null };
  if (executionMode === "cloud") return status === "running" ? { outcome: "unknown", ...cleared } : { outcome: "unknown" };
  if (status === "running") return { outcome: "unknown", ...cleared };
  if (status === "waiting" || status === "error" || status === "aborted" || status === "idle") return { outcome: "unknown" };
  if (from === "waiting" && (status === "done" || status === "background")) return { outcome: "needs_action" };
  return {};
}
