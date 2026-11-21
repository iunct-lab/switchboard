/** Task rows: reads, the run queue, stage Tasks, waits, the diff copy. */

import { CloudSessionRef } from "@switchboard/protocol";
import { realpathSync } from "node:fs";
import type { StoredOutcome, BacklogAction, Provenance, RunnerId, Task, TaskDiffFile, TaskDiffSnapshot, TaskOrigin, TaskStatus } from "@switchboard/protocol";
import { teleportWorktreePath } from "../config.ts";
import { canTransition, IN_FLIGHT, InvalidTaskOutcomeError, InvalidTaskTransitionError, outcomeOf, outcomeOnStatus, STORED_OUTCOMES, workingSql } from "../task-status.ts";
import type { WorkPurpose } from "../task-status.ts";
import { safeJson } from "./util.ts";
import { GrantQueries } from "./grants.ts";

/**
 * The end of a task's duration for the task whose id is `idColumn`: its last event that is not a `status`, so the notes that
 * follow `done` (the container cleanup, a daemon's stop note) do not count as work. A task with only `status` events runs to its
 * last event, a task with no events to `updated_at`. Clamped at 0 because an imported record can carry timestamps older than `created_at`.
 */
export const taskDurationSql = (idColumn: string): string =>
  `MAX(COALESCE((SELECT ts FROM events e WHERE e.task_id = ${idColumn} AND substr(e.json, 1, 14) <> '{"t":"status",' ORDER BY e.seq DESC LIMIT 1), (SELECT MAX(ts) FROM events e WHERE e.task_id = ${idColumn}), t.updated_at) - t.created_at, 0)`;

/** A Task waiting for a free run slot: idle with `queued_at` set. */
const QUEUED_SQL = "(status = 'idle' AND queued_at IS NOT NULL)";

/**
 * A stage Task still at work: running / waiting; a turn ended on background jobs that start its next turn (the
 * `background` mark, cleared when they end or the runner goes); a turn ended on a job it asked the daemon for (`jobs`
 * running — local CI or a review whose end resumes it); or a turn that ended done whose last reply is still
 * being judged (`judging_at` — until then its outcome is unknown, so a question it ended on does not hold the
 * Issue yet). Starting the same Issue's stage again in any of these runs it twice. `dedupe` also counts a planned resume
 * (it would run the stage again); `slot` (the capacity of a slot) does not (task-status.ts COUNTS). A Task waiting for a
 * run slot (QUEUED_SQL) is at work too: it starts on its own once a slot is free.
 */
const activeStage = (purpose: "dedupe" | "slot") => `(${workingSql(purpose)} OR ${QUEUED_SQL} OR judging_at IS NOT NULL OR id IN (SELECT task_id FROM jobs WHERE status = 'running'))`;

/** Task rows: reads, the run queue, stage Tasks, waits, the diff copy. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class TaskQueries extends GrantQueries {
  /* ---------- tasks ---------- */

  /** The list: Tasks not archived; `archived` = only the archived ones. */
  listTasks(archived = false): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC`).all().map(rowToTask);
  }

  getTask(id: string): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE id = ?").get(id);
    return r ? rowToTask(r) : null;
  }

  /** The newest Task of an origin with exactly this title (a release check is `<title> <tag>`); null = none. */
  findTaskByOrigin(origin: Task["origin"], title: string): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE origin = ? AND title = ? ORDER BY created_at DESC LIMIT 1").get(origin, title);
    return r ? rowToTask(r) : null;
  }

  /** The task's provenance (K1), written once right after creation; a task from before it was recorded has none. */
  setTaskProvenance(id: string, p: Provenance): void {
    this.sqlite.query("UPDATE tasks SET provenance = ?, updated_at = MAX(updated_at, ?) WHERE id = ?").run(JSON.stringify(p), Date.now(), id);
  }

  getTaskProvenance(id: string): Provenance | null {
    const r = this.sqlite.query("SELECT provenance FROM tasks WHERE id = ?").get(id) as { provenance: string | null } | null;
    return r?.provenance ? safeJson<Provenance | null>(r.provenance, null) : null;
  }

  /**
   * This machine's own Tasks changed at or after `ms`, newest first. What reads it acts on what it finds (the automatic
   * resume, the questions put to the person): a Task taken in from another machine is not this daemon's to act on, so
   * it is not in the list.
   */
  listTasksUpdatedSince(ms: number): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE updated_at >= ? AND machine IS NULL ORDER BY updated_at DESC").all(ms).map(rowToTask);
  }

  /** Tasks in one status — a small, naturally-bounded live set (unlike listTasks(), which is every task ever). */
  listTasksByStatus(status: TaskStatus): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC").all(status).map(rowToTask);
  }

  /** Tasks waiting for a free run slot, in the order they entered: idle with `queued_at` set. */
  listQueuedTasks(): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE ${QUEUED_SQL} ORDER BY queued_at, created_at`).all().map(rowToTask);
  }

  /** Put a Task in the wait for a run slot with the prompt it will start with. */
  setQueued(id: string, prompt: string, at: number): void {
    this.sqlite.query("UPDATE tasks SET queued_at = ?, queued_prompt = ?, updated_at = ? WHERE id = ?").run(at, prompt, Date.now(), id);
  }

  /**
   * A reply to a Task whose process is closed, waiting for a run slot: the queue is the idle rows with `queued_at`, so a
   * done / error / aborted row moves to idle through updateTask (the transition table applies, and it shows again if
   * archived). A new turn is coming, so the outcome is written as a start would (unknown, 確認済み and the judgement off).
   * A row already waiting gets the reply after its prompt and keeps its place.
   */
  queueReply(id: string, text: string, at: number): void {
    const cur = this.getTask(id);
    if (!cur) return;
    if (cur.queuedAt !== null) {
      this.sqlite.query("UPDATE tasks SET queued_prompt = COALESCE(queued_prompt, '') || char(10) || char(10) || ?, updated_at = ? WHERE id = ?").run(text, at, id);
      return;
    }
    this.sqlite.transaction(() => {
      this.updateTask(id, { status: "idle", outcome: "unknown", reviewedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, updatedAt: at });
      this.setQueued(id, text, at);
    })();
  }

  /** Take a Task out of the wait: returns the prompt it was queued with (null = it was not waiting) and clears both columns. */
  takeQueued(id: string): string | null {
    const row = this.sqlite.query("SELECT queued_at, queued_prompt FROM tasks WHERE id = ?").get(id) as { queued_at: number | null; queued_prompt: string | null } | null;
    if (!row || row.queued_at === null) return null;
    this.sqlite.query("UPDATE tasks SET queued_at = NULL, queued_prompt = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return row.queued_prompt;
  }

  /** Tasks that count as working for `purpose` (task-status.ts `isWorking`, in SQL): a turn, an open approval, a wait on background jobs, and for `dedupe` a planned resume. */
  listWorkingTasks(purpose: WorkPurpose): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE ${workingSql(purpose)} ORDER BY updated_at DESC`).all().map(rowToTask);
  }

  /** Tasks that hold the daemon (`gate`) or wait for a run slot: what a restart for a promotion would cut or leave waiting. */
  listActiveTasks(): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE ${workingSql("gate")} OR ${QUEUED_SQL}`).all().map(rowToTask);
  }

  /** The Tasks whose judgement of the last reply was under way: after a restart, those it cut short. */
  listTasksJudging(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE judging_at IS NOT NULL").all().map(rowToTask);
  }

  /**
   * The newest active stage Task of a backlog Issue in a workspace: running / waiting, waiting for a run slot,
   * or one whose turn ended but whose work is not over (activeStage: its runner's background jobs, a daemon job it asked for,
   * its reply being judged).
   */
  activeStageTask(workspaceId: string, issue: number): Task | null {
    const r = this.sqlite.query(`SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND ${activeStage("dedupe")} ORDER BY updated_at DESC LIMIT 1`).get(workspaceId, issue);
    return r ? rowToTask(r) : null;
  }

  /**
   * As activeStageTask, less a Task that only has a resume planned (it takes no slot and changes nothing before the time).
   * The overlap judgement of the backlog reads this.
   */
  workingStageTask(workspaceId: string, issue: number): Task | null {
    const r = this.sqlite.query(`SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND ${activeStage("slot")} ORDER BY updated_at DESC LIMIT 1`).get(workspaceId, issue);
    return r ? rowToTask(r) : null;
  }

  /** The Issues of a workspace that have a Task workingStageTask finds, in one read: what the overlap judgement of every item asks. */
  workingStageIssues(workspaceId: string): Set<number> {
    return this.stageIssues(workspaceId, "slot");
  }

  /** The Issues of a workspace that have a Task activeStageTask finds, in one read. */
  activeStageIssues(workspaceId: string): Set<number> {
    return this.stageIssues(workspaceId, "dedupe");
  }

  private stageIssues(workspaceId: string, purpose: "dedupe" | "slot"): Set<number> {
    const rows = this.sqlite.query(`SELECT DISTINCT stage_issue FROM tasks WHERE workspace_id = ? AND stage_issue IS NOT NULL AND ${activeStage(purpose)}`).all(workspaceId) as Array<{ stage_issue: number }>;
    return new Set(rows.map((r) => r.stage_issue));
  }

  /**
   * Whether a stage Task of an Issue that left its place (not activeStage, whatever its outcome) ran at `at` (milliseconds,
   * as the columns): started at or before it and ended at or after it. Asked only for a PBI with a claim of /pbi-complete, one
   * read each. An Issue whose stage Task runs now can be in it with an earlier Task too, so the caller asks `active` first.
   */
  endedStageRanAt(workspaceId: string, issue: number, at: number): boolean {
    return !!this.sqlite.query(`SELECT 1 FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND created_at <= ? AND status_at >= ? AND NOT ${activeStage("dedupe")} LIMIT 1`).get(workspaceId, issue, at, at);
  }

  /** The newest-created stage Task of a backlog Issue, of `action` only when given. */
  lastStageTask(workspaceId: string, issue: number, action?: BacklogAction): Task | null {
    const r = action
      ? this.sqlite.query("SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? AND stage_action = ? ORDER BY created_at DESC LIMIT 1").get(workspaceId, issue, action)
      : this.sqlite.query("SELECT * FROM tasks WHERE workspace_id = ? AND stage_issue = ? ORDER BY created_at DESC LIMIT 1").get(workspaceId, issue);
    return r ? rowToTask(r) : null;
  }

  /**
   * The stage Task of `actions` in a workspace that left its slot (not activeStage) last, of this machine's own: how one
   * ended says something of this machine (its login), and a Task taken in from a work machine ended there.
   */
  lastEndedStageTask(workspaceId: string, actions: BacklogAction[]): Task | null {
    const r = this.sqlite.query(`SELECT * FROM tasks WHERE workspace_id = ? AND machine IS NULL AND stage_action IN (${actions.map(() => "?").join(", ")}) AND NOT ${activeStage("slot")} ORDER BY status_at DESC LIMIT 1`).get(workspaceId, ...actions);
    return r ? rowToTask(r) : null;
  }

  /** Ids of every stage Task of a backlog Issue in a workspace. */
  stageTaskIds(workspaceId: string, issue: number): string[] {
    return (this.sqlite.query("SELECT id FROM tasks WHERE workspace_id = ? AND stage_issue = ?").all(workspaceId, issue) as Array<{ id: string }>).map((r) => r.id);
  }

  /** The ids of a schedule's newest Tasks, newest first. */
  recentScheduleTaskIds(scheduleId: string, limit: number): string[] {
    return (this.sqlite.query("SELECT id FROM tasks WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?").all(scheduleId, limit) as Array<{ id: string }>).map((r) => r.id);
  }

  /** Every stage Task taking a slot (as activeStageTask's, less a planned resume), whatever the workspace. */
  listActiveStageTasks(): Task[] {
    return this.sqlite.query(`SELECT * FROM tasks WHERE stage_issue IS NOT NULL AND ${activeStage("slot")}`).all().map(rowToTask);
  }

  /** Every task, as much as the intervention count needs of it. */
  listTaskRefs(): Array<{ id: string; workspaceId: string | null; title: string; stageIssue: number | null; scheduleId: string | null; createdAt: number }> {
    return (this.sqlite.query("SELECT id, workspace_id, title, stage_issue, schedule_id, created_at FROM tasks ORDER BY created_at").all() as Array<{ id: string; workspace_id: string | null; title: string; stage_issue: number | null; schedule_id: string | null; created_at: number }>)
      .map((r) => ({ id: r.id, workspaceId: r.workspace_id, title: r.title, stageIssue: r.stage_issue, scheduleId: r.schedule_id, createdAt: r.created_at }));
  }

  insertTask(t: Task): Task {
    // A row is never inserted waiting for a run slot: the wait is written only by setQueued / takeQueued, with its prompt
    t = { ...t, queuedAt: null };
    // the column keeps only what the status does not decide: the outcome a Task shows is derived from it, so a derived one is not written
    const storedOutcome = STORED_OUTCOMES[t.status].has(t.outcome as StoredOutcome) ? (t.outcome as StoredOutcome) : "unknown";
    if (storedOutcome === "unknown" && t.outcome !== "unknown" && t.outcome !== outcomeOf(t.status, "unknown")) throw new InvalidTaskOutcomeError(t.id, t.status, t.outcome);
    if (t.cloudSession) CloudSessionRef.parse(t.cloudSession);
    this.validateCloudSource(t);
    this.sqlite.transaction(() => {
      this.sqlite
        .query(
          `INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, runner_session_id, model, routing, budget_usd, schedule_id, permission_mode, effort, subagent_effort, subagent_model, origin, resume_at, resume_reason, resume_window, resume_since, resume_planned_at, queued_at, deferred_prompt, shadow_of, fork_of, fork_seq, fork_turn, shadow_stopped, workspace_reason, outcome, reviewed_at, archived_at, judged_result, judged_reason, judged_by, created_at, updated_at, execution_mode, cloud_session, source_cloud_task_id, stage_issue, stage_action, judging_at, status_at, title_pending, machine)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(t.id, t.workspaceId, t.title, t.runner, t.cwd, JSON.stringify(t.scope), t.status, t.runnerSessionId, t.model, t.routing ? JSON.stringify(t.routing) : null, t.budgetUsd, t.scheduleId, t.permissionMode, t.effort, t.subagentEffort ?? null, t.subagentModel ?? null, t.origin, t.resumeAt, t.resumeReason, t.resumeWindow, t.resumeSince, t.resumePlannedAt, t.queuedAt, t.deferredPrompt, t.shadowOf, t.forkOf, t.forkSeq, t.forkTurn, t.shadowStopped ? 1 : 0, t.workspaceReason, storedOutcome, t.reviewedAt, t.archivedAt, t.judgedResult, t.judgedReason, t.judgedBy, t.createdAt, t.updatedAt, t.executionMode, t.cloudSession ? JSON.stringify(t.cloudSession) : null, t.sourceCloudTaskId, t.stage?.issue ?? null, t.stage?.action ?? null, t.judgingAt, t.statusAt, t.titlePending ? 1 : 0, t.machine ?? null);
      if (t.routing) {
        const logRow = this.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        logRow.run(t.id, t.workspaceId, t.cwd, t.routing.suggested, t.routing.ruleId, t.routing.reason, t.runner, t.createdAt, "rule");
        // An LLM suggestion is a second opinion on the same decision, so it is a second row rather than a
        // column: each source is then scored against the same `chosen` on its own (`routingStats`).
        if (t.routing.llm) logRow.run(t.id, t.workspaceId, t.cwd, t.routing.llm.runner, "llm", t.routing.llm.reason, t.runner, t.createdAt, "llm");
      }
    })();
    return t;
  }

  /** The shadow task mirroring `primaryId`, if one was created with it. At most one: `shadow_of` is unique. */
  shadowTaskOf(primaryId: string): Task | null {
    const r = this.sqlite.query("SELECT * FROM tasks WHERE shadow_of = ?").get(primaryId);
    return r ? rowToTask(r) : null;
  }

  /** The Tasks forked from `parentId`, oldest first. */
  forksOf(parentId: string): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE fork_of = ? ORDER BY created_at, id").all(parentId).map(rowToTask);
  }

  /** Imported Local Tasks associated with the original Cloud Task. */
  listLocalTasksForCloud(cloudTaskId: string): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE source_cloud_task_id = ? ORDER BY created_at, id").all(cloudTaskId).map(rowToTask);
  }

  private validateCloudSource(t: Task, previous?: Task): void {
    const changed = !previous || previous.runnerSessionId !== t.runnerSessionId || previous.sourceCloudTaskId !== t.sourceCloudTaskId;
    const owners = changed && t.runnerSessionId ? this.listTasksBySession(t.runner, t.runnerSessionId).filter(other => other.id !== t.id) : [];
    if (owners.some(other => other.sourceCloudTaskId !== null) || (t.sourceCloudTaskId !== null && owners.length > 0)) {
      throw new Error("Local session already has a Task owner");
    }
    if (t.sourceCloudTaskId === null) return;
    const source = this.getTask(t.sourceCloudTaskId);
    let sameCwd = previous?.sourceCloudTaskId === t.sourceCloudTaskId || source?.cwd === t.cwd;
    if (source && !sameCwd) {
      // The Cloud Task's own cwd, or the worktree that "continue locally" made for it.
      for (const want of [source.cwd, teleportWorktreePath(source.cwd, source.id)]) {
        try { sameCwd = realpathSync(want) === realpathSync(t.cwd); } catch { /* Missing paths cannot prove identity. */ }
        if (sameCwd) break;
      }
    }
    if (t.executionMode !== "local" || t.runner !== "claude" || !t.runnerSessionId || !source || source.executionMode !== "cloud" || source.runner !== "claude" || !sameCwd || source.workspaceId !== t.workspaceId || source.id === t.id) {
      throw new Error("Local continuation must reference a Cloud Task in the same working directory and Workspace");
    }
  }

  /** Tasks of a runner session, earliest first (Switchboard tasks record theirs from session.start; imported ones at creation). */
  listTasksBySession(runner: RunnerId, sessionId: string): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE runner = ? AND runner_session_id = ? ORDER BY created_at").all(runner, sessionId).map(rowToTask);
  }

  /**
   * `updatedAt` may be given by an importer replaying old records; everything else stamps now. A status change without
   * an `outcome` in the patch sets the outcome by rule (`outcomeOnStatus` in task-status.ts) — the one place the rule lives. A status the table (`TASK_TRANSITIONS`) does
   * does not allow is not stored: it throws `InvalidTaskTransitionError`.
   */
  updateTask(id: string, patch: Partial<Pick<Task, "sourceCloudTaskId" | "cloudSession" | "status" | "runnerSessionId" | "model" | "title" | "titlePending" | "budgetUsd" | "permissionMode" | "effort" | "resumeAt" | "resumeReason" | "resumeWindow" | "resumeSince" | "resumePlannedAt" | "deferredPrompt" | "shadowStopped" | "scope" | "reviewedAt" | "archivedAt" | "judgedResult" | "judgedReason" | "judgedBy" | "judgingAt" | "updatedAt">> & { outcome?: StoredOutcome }): Task | null {
    if (patch.cloudSession) CloudSessionRef.parse(patch.cloudSession);
    const cur = this.getTask(id);
    if (!cur) return null;
    // the column holds what is stored; `cur.outcome` is the derived one
    const storedBefore = (this.sqlite.query("SELECT outcome FROM tasks WHERE id = ?").get(id) as { outcome: StoredOutcome }).outcome;
    const moves = patch.status !== undefined && patch.status !== cur.status;
    if (moves && !canTransition(cur.status, patch.status!)) throw new InvalidTaskTransitionError(id, cur.status, patch.status!);
    const rule = moves && patch.outcome === undefined ? outcomeOnStatus(patch.status!, cur.executionMode, cur.status) : {};
    const updatedAt = patch.updatedAt ?? Date.now();
    // statusAt moves only when the status does: a title, outcome or 確認済み change keeps when the task came to it
    // a new turn shows the Task again: only a stopped one stays archived
    const shown = moves && (IN_FLIGHT.has(patch.status!) || patch.status === "idle") ? { archivedAt: null } : {};
    // The wait for a run slot is written only by setQueued / takeQueued; a status that leaves idle ends it (prompt too),
    // so a Task started some other way does not come back into the queue when it is idle again
    const queuedAt = moves && patch.status !== "idle" ? null : cur.queuedAt;
    const status = patch.status ?? cur.status;
    const stored: StoredOutcome = patch.outcome ?? rule.outcome ?? storedBefore;
    // only a pair of the table (STORED_OUTCOMES) is stored; a row the patch leaves alone is not judged here
    if ((patch.status !== undefined || patch.outcome !== undefined) && !STORED_OUTCOMES[status].has(stored)) throw new InvalidTaskOutcomeError(id, status, stored);
    const next: Task = { ...cur, ...rule, ...patch, ...shown, queuedAt, updatedAt, statusAt: moves ? updatedAt : cur.statusAt, outcome: outcomeOf(status, stored) };
    this.validateCloudSource(next, cur);
    this.sqlite
      .query("UPDATE tasks SET status = ?, runner_session_id = ?, model = ?, title = ?, title_pending = ?, budget_usd = ?, permission_mode = ?, effort = ?, resume_at = ?, resume_reason = ?, resume_window = ?, resume_since = ?, resume_planned_at = ?, queued_at = ?, queued_prompt = CASE WHEN ? IS NULL THEN NULL ELSE queued_prompt END, deferred_prompt = ?, shadow_stopped = ?, scope = ?, outcome = ?, reviewed_at = ?, archived_at = ?, judged_result = ?, judged_reason = ?, judged_by = ?, judging_at = ?, updated_at = ?, status_at = ?, cloud_session = ?, source_cloud_task_id = ? WHERE id = ?")
      .run(next.status, next.runnerSessionId, next.model, next.title, next.titlePending ? 1 : 0, next.budgetUsd, next.permissionMode, next.effort, next.resumeAt, next.resumeReason, next.resumeWindow, next.resumeSince, next.resumePlannedAt, next.queuedAt, next.queuedAt, next.deferredPrompt, next.shadowStopped ? 1 : 0, JSON.stringify(next.scope), stored, next.reviewedAt, next.archivedAt, next.judgedResult, next.judgedReason, next.judgedBy, next.judgingAt, next.updatedAt, next.statusAt, next.cloudSession ? JSON.stringify(next.cloudSession) : null, next.sourceCloudTaskId, id);
    return next;
  }

  /** Tasks waiting on a usage limit: resume_at set. A small live set — the column is cleared as soon as a task moves on. */
  listTasksWithResume(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE resume_at IS NOT NULL ORDER BY resume_at").all().map(rowToTask);
  }

  /** Not through updateTask: the runner's jobs changing is not a change of the task's own, so updatedAt stays. */
  /** What the Task waits for, as the wait watch last saw it (waits.ts); null or empty = nothing. `updated_at` does not move: looking is no change of the Task. */
  setTaskWaits(id: string, waits: Task["waits"]) {
    this.sqlite.query("UPDATE tasks SET waits = ? WHERE id = ?").run(waits?.length ? JSON.stringify(waits) : null, id);
  }

  /** This machine's own Tasks with a wait stored (another machine's waits are that machine's to watch). */
  listTasksWithWaits(): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE waits IS NOT NULL AND machine IS NULL").all().map(rowToTask);
  }

  /** The Tasks changed at or after `since` whose turn ended on a stop that is still theirs: not reviewed, not archived, the stored outcome `waits` or `needs_action`. */
  listTasksOnStops(since: number): Task[] {
    return this.sqlite.query("SELECT * FROM tasks WHERE updated_at >= ? AND machine IS NULL AND archived_at IS NULL AND reviewed_at IS NULL AND outcome IN ('waits', 'needs_action')").all(since).map(rowToTask);
  }

  setTaskBackground(id: string, background: Task["background"]) {
    this.sqlite.query("UPDATE tasks SET background = ?, updated_at = MAX(updated_at, ?) WHERE id = ?").run(background ? JSON.stringify(background) : null, Date.now(), id);
  }

  /* ---------- diff copy ---------- */

  getTaskDiffSnapshot(taskId: string): TaskDiffSnapshot | null {
    const r = this.sqlite.query("SELECT at, json FROM task_diffs WHERE task_id = ?").get(taskId) as { at: number; json: string } | null;
    if (!r) return null;
    try {
      return { at: r.at, files: JSON.parse(r.json) as TaskDiffFile[] };
    } catch {
      return null;
    }
  }

  putTaskDiffSnapshot(taskId: string, s: TaskDiffSnapshot) {
    this.sqlite
      .query("INSERT INTO task_diffs (task_id, at, json) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET at = excluded.at, json = excluded.json")
      .run(taskId, s.at, JSON.stringify(s.files));
  }

  /** Where a task's event bodies went: the S3 keys (one per line, oldest first), when, and how many rows; null if never moved. */
  eventsArchiveOf(taskId: string): { key: string; at: number; count: number } | null {
    const r = this.sqlite.query("SELECT events_archive_key AS key, events_archived_at AS at, events_archived_count AS count FROM tasks WHERE id = ?").get(taskId) as { key: string | null; at: number; count: number } | null;
    return r?.key ? { key: r.key, at: r.at, count: r.count } : null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToTask(r: any): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id ?? null,
    title: r.title,
    runner: r.runner as RunnerId,
    cwd: r.cwd,
    scope: safeJson<string[]>(r.scope, []),
    status: r.status as TaskStatus,
    executionMode: r.execution_mode,
    sourceCloudTaskId: r.source_cloud_task_id,
    cloudSession: r.cloud_session === null ? null : CloudSessionRef.parse(JSON.parse(r.cloud_session)),
    runnerSessionId: r.runner_session_id ?? null,
    model: r.model ?? null,
    routing: r.routing ? safeJson(r.routing, null) : null,
    budgetUsd: r.budget_usd ?? null,
    scheduleId: r.schedule_id ?? null,
    permissionMode: r.permission_mode ?? null,
    effort: r.effort ?? null,
    subagentEffort: r.subagent_effort ?? null,
    subagentModel: r.subagent_model ?? null,
    origin: (r.origin ?? "switchboard") as TaskOrigin,
    resumeAt: r.resume_at ?? null,
    resumeReason: r.resume_reason ?? null,
    resumeWindow: r.resume_window ?? null,
    resumeSince: r.resume_since ?? null,
    resumePlannedAt: r.resume_planned_at ?? null,
    queuedAt: r.queued_at ?? null,
    deferredPrompt: r.deferred_prompt ?? null,
    background: r.background ? JSON.parse(r.background) : null,
    waits: r.waits ? JSON.parse(r.waits) : null,
    shadowOf: r.shadow_of ?? null,
    forkOf: r.fork_of ?? null,
    forkSeq: r.fork_seq ?? null,
    forkTurn: r.fork_turn ?? null,
    shadowStopped: !!r.shadow_stopped,
    workspaceReason: r.workspace_reason ?? null,
    outcome: outcomeOf(r.status, (r.outcome ?? "unknown") as StoredOutcome),
    reviewedAt: r.reviewed_at ?? null,
    archivedAt: r.archived_at ?? null,
    judgedResult: (r.judged_result ?? null) as Task["judgedResult"],
    judgedReason: r.judged_reason ?? null,
    judgedBy: r.judged_by ?? null,
    judgingAt: r.judging_at ?? null,
    stage: r.stage_issue == null ? null : { issue: r.stage_issue, action: r.stage_action as BacklogAction },
    statusAt: r.status_at,
    titlePending: !!r.title_pending,
    machine: r.machine ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
