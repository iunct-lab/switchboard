import { z } from "zod";

export const TaskStatus = z.enum(["idle", "running", "waiting", "background", "done", "error", "aborted"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Whether a status is "working" for display (turn in progress, approval open, or a background process left): the part of core's `COUNTS.display` that status alone decides. A planned resume (`resumeAt`) is not counted here. The web calls this instead of listing statuses; a core test keeps the two equal. */
export function isWorkingStatus(status: TaskStatus): boolean {
  return status === "running" || status === "waiting" || status === "background";
}

/** A Task with a turn in progress (a turn running, or an approval open in it): the only states a runner's events may change. */
export const IN_FLIGHT: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "waiting"]);

/**
 * Why a Task in this status cannot be archived, or null when it can: a turn in progress or an open approval
 * (`in-flight`), or a Task that has not been replied to yet (`idle`). The daemon refuses with it and the web disables
 * its buttons with it, so the two never disagree.
 */
export function archiveRefusal(status: TaskStatus): "in-flight" | "idle" | null {
  return IN_FLIGHT.has(status) ? "in-flight" : status === "idle" ? "idle" : null;
}

/**
 * What a stopped task came to, for the person, apart from whether its runner is running (`status`):
 * `finished` = finished, nothing to do (not the status `done`: the two sets share no value); `needs_action` = waits on the person (an approval, a question); `failed` = error /
 * aborted; `waits` = waits on something other than the person (another job, a limit, a retry; no action needed);
 * `unknown` = not judged yet. Set by the rule in `Db.updateTask` when the status changes, by the person, by reading the
 * last reply, and from the stop records each time one is written (`outcomeFromStops`).
 */
export const TaskOutcome = z.enum(["finished", "needs_action", "waits", "failed", "unknown"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/** The outcomes written to the `outcome` column. `needs_action` for a waiting Task and `failed` for an error / aborted one come from the status, so they are not stored there. */
export const StoredOutcome = z.enum(["finished", "needs_action", "waits", "unknown"]);
export type StoredOutcome = z.infer<typeof StoredOutcome>;

/**
 * Where a task was started: `switchboard` = created here (UI, API, schedule); `terminal` = a Claude Code
 * session the person ran in a terminal, imported from `~/.claude/projects`. The origin never changes: a terminal
 * session continued from Switchboard (`--resume`) stays `terminal`, and the other way round.
 */
export const TaskOrigin = z.enum(["switchboard", "terminal", "release-review"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const ExecutionMode = z.enum(["local", "cloud"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

/**
 * The stage a row's button starts: request → PBI, PBI → Tasks (Ready), Ready → merged (/pbi-complete), in-progress → 状況確認.
 * `close`: an in-progress PBI whose Tasks are all closed → its results written and closed (pbi-complete step 6); not tied to a stage.
 *   The UI offers it only when `closable` (user confirmations done too); the API also takes one with confirmations left (`progress.closableByApi`).
 * `direct`: a request → one Task of the `p1-direct` candidate, no PBI or Task Issue; only the person's button starts it.
 */
export const BacklogAction = z.enum(["to-pbi", "to-tasks", "complete", "check", "close", "direct"]);
export type BacklogAction = z.infer<typeof BacklogAction>;
