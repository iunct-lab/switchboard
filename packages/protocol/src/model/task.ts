import { z } from "zod";
import { RunnerId } from "../events.ts";
import { PresetReply } from "./preset.ts";
import { TaskRouting } from "./routing.ts";
import { BacklogAction, ExecutionMode, StoredOutcome, TaskOrigin, TaskOutcome, TaskStatus } from "./shared.ts";
import { StopSummary } from "./stop.ts";
import { WaitRecord, waitOver } from "./waits.ts";

/** Canonical official session reference; authorization URLs are never stored. */
export const CloudSessionRef = z.object({
  id: z.string().regex(/^session_[A-Za-z0-9_-]+$/),
  url: z.string(),
}).refine((r) => r.url === `https://claude.ai/code/${r.id}`, { message: "Cloud URL must match the official session ID" });
export type CloudSessionRef = z.infer<typeof CloudSessionRef>;

export const CloudPreparation = z.object({
  repository: z.string().nullable(), branch: z.string().nullable(), dirty: z.boolean().nullable(),
  unpushed: z.boolean().nullable(), warnings: z.array(z.string()),
});
export type CloudPreparation = z.infer<typeof CloudPreparation>;

export const Task = z.object({
  executionMode: ExecutionMode,
  cloudSession: CloudSessionRef.nullable(),
  sourceCloudTaskId: z.string().nullable(),
  id: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  runner: RunnerId,
  cwd: z.string(),
  scope: z.array(z.string()),
  status: TaskStatus,
  runnerSessionId: z.string().nullable(),
  model: z.string().nullable(),
  routing: TaskRouting.nullable(),
  /** Budget in API-equivalent USD; null = unlimited. Exceeding it raises a confirmation and blocks new turns. */
  budgetUsd: z.number().nullable(),
  /** Set when the task was started by a schedule. */
  scheduleId: z.string().nullable(),
  /**
   * Runner-native permission mode the task runs in: Claude `auto | acceptEdits | default | plan | dontAsk |
   * bypassPermissions`, Codex preset `auto | read-only | untrusted | full-access`. Resolved at creation (explicit →
   * saved runner default → adapter default) so the record says what the task actually ran with; null = the runner
   * has no such knob (DAK).
   */
  permissionMode: z.string().nullable(),
  /** Runner-native thinking effort fixed at creation; null = the CLI's own default. */
  effort: z.string().nullable(),
  /** Subagent thinking effort fixed at creation (the setting `subagentEffort`); passed as CLAUDE_CODE_SUBAGENT_EFFORT; null = same as the task. */
  subagentEffort: z.string().nullable().optional(),
  /** Subagent model fixed at creation (the setting `subagentModel`); passed as CLAUDE_CODE_SUBAGENT_MODEL; null = same as the task. */
  subagentModel: z.string().nullable().optional(),
  origin: TaskOrigin,
  /**
   * The task stopped on the runner's usage limit: when the limit is expected to lift (ms). With auto-resume on
   * for the runner the daemon sends a follow-up turn then; off, it is only shown. null = no resume planned. Cleared
   * by any turn the person sends and by 中断.
   */
  /**
   * Jobs the runner still has in the background and since when (the last `background` event). Set while the status is
   * `background`: the turn ended waiting for them. Cleared when they end or are lost.
   */
  background: z.object({ jobs: z.array(z.string()), since: z.number() }).nullable().optional(),
  /**
   * What the Task waits for now, each with its limit (`WaitRecord`), as the daemon last looked (core's waits.ts). The
   * runner's own output is among them only once it has been silent past its limit (`silentSince`). null = waits for nothing.
   */
  waits: z.array(WaitRecord).nullable().optional(),
  resumeAt: z.number().nullable(),
  /**
   * What `resumeAt` waits for: the runner's usage limit, GitHub's API limit a turn met in its commands, space on a full disk, or `start`: a Task made at the limit that has not run a turn yet. null =
   * no plan, or a plan made before `resumeReason` existed (treated as the runner's limit).
   */
  resumeReason: z.enum(["limit", "github", "disk", "start"]).nullable(),
  /**
   * A Task made without starting (`resumeReason: "start"`): the prompt (attachment lines included) its first turn
   * sends when `resumeAt` comes. null = not waiting to start.
   */
  deferredPrompt: z.string().nullable(),
  /**
   * A usage-limit wait: the window that stopped the turn (`five_hour`, `seven_day`, …; from the quota report) and
   * when it stopped (ms). A report of that window under 100 % after `resumeSince` resumes the task before `resumeAt`.
   * null = no plan, a GitHub wait, or a stop whose window is not known (the banner's time only).
   */
  resumeWindow: z.string().nullable(),
  resumeSince: z.number().nullable(),
  /**
   * A long usage-limit wait with one try before it: `resumeAt` is the try, this is the reset (+ margin) the wait
   * goes back to when the try is refused. null = no try planned.
   */
  resumePlannedAt: z.number().nullable(),
  /** When the Task entered the wait for a free run slot; null = not waiting. Waiting is `status: "idle"` + this, not a new status. */
  queuedAt: z.number().nullable(),
  /**
   * Shadow run: id of the primary task this one mirrors. A shadow task is a normal task (own transcript, diff,
   * ledger, approvals) created with the primary's cwd / scope / title / prompt on another runner; follow-up turns
   * sent to the primary are copied to it. Set at creation, never changed; null = not a shadow.
   */
  shadowOf: z.string().nullable(),
  /**
   * Fork: id of the Task this one branched from at a past turn. The child continues the parent's conversation up to
   * that turn (its first reply starts a forked runner session) and then goes its own way; it shares the parent's
   * working tree. Set at creation, never changed; null = not a fork.
   */
  forkOf: z.string().nullable(),
  /** Fork: the seq of the parent's `session.end` event the branch was taken at; null = not a fork. */
  forkSeq: z.number().int().nullable(),
  /** Fork: that `session.end`'s `turn` (the runner's own pointer to the turn); null = not a fork. */
  forkTurn: z.string().nullable(),
  /** Shadow run: the user stopped this shadow (中断), so replies to the primary are no longer copied to it. */
  shadowStopped: z.boolean(),
  /** Why the daemon picked this task's Workspace; null = the person picked it. Set at creation, never changed. */
  workspaceReason: z.string().nullable(),
  /** Which machine the Task ran on, when its record came from another one (an uplink); null or absent = this instance itself. */
  machine: z.string().nullable().optional(),
  /** The title is provisional: it is set once more after the first turn. A title the person gave or changed is false. */
  titlePending: z.boolean(),
  /** What the task came to; separate from `status`. Derived from the stored outcome and the status (`outcomeOf` in core): waiting → needs_action and error / aborted → failed come from the status; the rest is what the rule on a status change, the person or the judge of the last reply stored. */
  outcome: TaskOutcome,
  /** When the person marked the task 確認済み (ms); null = not reviewed. A new turn clears it. */
  reviewedAt: z.number().nullable(),
  /** When the Task was hidden from the list (ms); null = not hidden. Only a stopped Task (done / error / aborted) gets one. */
  archivedAt: z.number().nullable(),
  /**
   * The judge's reading of the last reply, kept next to `outcome` so a hand-set outcome and the judgement can
   * be compared later. null = not judged (a new turn clears it). `judgedBy` is `<runner>:<model>`.
   */
  judgedResult: z.enum(["finished", "needs_action"]).nullable(),
  judgedReason: z.string().nullable(),
  judgedBy: z.string().nullable(),
  /** When the judgement of the last reply began (ms); null = not judging, or done. A new turn clears it; a restart that cut it short has it judged again once at start. */
  judgingAt: z.number().nullable(),
  /** The backlog Issue and stage this Task runs (a button, a schedule or an answer's follow-up made it); null for any other Task. Set at creation, never changed. */
  stage: z.object({ issue: z.number().int().positive(), action: BacklogAction, /** Started by itself (the queue, the schedule, the resume after an answer), not by a button. Absent = by a button. */ auto: z.literal(true).optional() }).nullable(),
  /** When the task came to its current `status` (ms). Other changes (title, outcome, 確認済み…) leave it; `updatedAt` moves on any change. */
  statusAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

/** Since when the Task's runner has given no output past its limit (the time of its last event); null = it is not silent. */
export const silentSince = (t: Pick<Task, "waits">): number | null => t.waits?.find((w) => w.kind === "output")?.since ?? null;

/** The Task's waits that are over their limit and not already the person's to end: what the asks screen asks about, and what the list marks. */
export const overWaits = (t: Pick<Task, "waits">, now: number): WaitRecord[] => (t.waits ?? []).filter((w) => w.kind !== "person" && waitOver(w, now));

/** What the Task list needs of a Task (rail, Home, attention, notices). The rest is read from GET /api/tasks/:id when a Task is opened. */
export const TaskSummary = Task.pick({
  id: true,
  title: true,
  status: true,
  archivedAt: true,
  workspaceId: true,
  outcome: true,
  reviewedAt: true,
  updatedAt: true,
  createdAt: true,
  statusAt: true,
  cwd: true,
  origin: true,
  resumeAt: true,
  resumeReason: true,
  resumePlannedAt: true,
  background: true,
  waits: true,
  queuedAt: true,
  shadowOf: true,
  shadowStopped: true,
  forkOf: true,
  runner: true,
  executionMode: true,
  machine: true,
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export function taskSummary(t: Task): TaskSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    archivedAt: t.archivedAt,
    workspaceId: t.workspaceId,
    outcome: t.outcome,
    reviewedAt: t.reviewedAt,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    statusAt: t.statusAt,
    cwd: t.cwd,
    origin: t.origin,
    resumeAt: t.resumeAt,
    resumeReason: t.resumeReason,
    resumePlannedAt: t.resumePlannedAt,
    background: t.background,
    waits: t.waits,
    queuedAt: t.queuedAt,
    shadowOf: t.shadowOf,
    shadowStopped: t.shadowStopped,
    forkOf: t.forkOf,
    runner: t.runner,
    executionMode: t.executionMode,
    // set only on a Task whose record came from another machine
    machine: t.machine ?? null,
  };
}

export const CreateTaskInput = z.object({
  executionMode: ExecutionMode.default("local"),
  workspaceId: z.string().optional(),
  /** Omitted together with `workspaceId` = "自動": the daemon asks the LLM to pick a registered Workspace, or answers 409. */
  cwd: z.string().optional(),
  /** Omitted = a provisional title from the prompt, set again after the first turn. */
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  runner: RunnerId.default("claude"),
  scope: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Optional explicit task kind (design | research | review | maintenance | …) for the router; authoritative over keywords. */
  kind: z.string().optional(),
  budgetUsd: z.number().positive().optional(),
  scheduleId: z.string().optional(),
  /** Runner-native permission mode; omitted = the saved runner default, else the adapter's default. */
  permissionMode: z.string().optional(),
  /** Thinking effort (one of the runner's `efforts`); omitted = the CLI's own default. */
  effort: z.string().optional(),
  /**
   * Shadow run: also start the same prompt on this runner as a linked shadow task. Omitted = follow
   * `Settings.shadowRunner`; null = no shadow even if a default is saved. Must differ from `runner` and be detected.
   */
  shadowRunner: RunnerId.nullable().optional(),
  /** Attachments: ids from `POST /api/attachments`, not yet attached to another task. Their paths go at the end of the prompt. */
  attachmentIds: z.array(z.string()).optional(),
  /** The process candidate the task is started under (`ops-kit/processes/<id>.md`, docs/design/process-kernel.md K4); omitted = none named. Recorded in the task's provenance, nothing else reads it yet. */
  process: z.string().optional(),
  /** Why that candidate (free text, e.g. `backlog stage complete`); recorded with it. */
  processReason: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/**
 * Provenance (docs/design/process-kernel.md, K1): what a task was started with, written once at creation and read at
 * `GET /api/tasks/:id/provenance`. `bundle` holds sha256 hashes of the instruction sources the task could read (null = that
 * source is not there); `instructionBytes` is the size of the root instruction files and project skills in its working directory.
 */
export const Provenance = z.object({
  v: z.literal(1),
  process: z.object({ id: z.string(), version: z.number().int() }).nullable(),
  processReason: z.string().nullable(),
  bundle: z.object({ skills: z.string().nullable(), repoSkills: z.string().nullable(), claudeMd: z.string().nullable(), processes: z.string().nullable() }),
  repo: z.object({ head: z.string().nullable() }),
  runner: RunnerId,
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  instructionBytes: z.number().int().nullable(),
  recordedAt: z.number(),
});
export type Provenance = z.infer<typeof Provenance>;

/** One process candidate as `GET /api/processes` lists it (the entries' texts are not sent; they are the file's). */
export const ProcessSummary = z.object({ id: z.string(), version: z.number().int(), title: z.string(), fits: z.array(z.string()) });
export type ProcessSummary = z.infer<typeof ProcessSummary>;

/** `PATCH /api/tasks/:id`: the person renames the task; it is never set again automatically. */
export const PatchTaskInput = z.object({ title: z.string().trim().min(1).max(200) });
export type PatchTaskInput = z.infer<typeof PatchTaskInput>;

/**
 * `POST /api/tasks/:id/send`. Text, attachments, or both (an attachment-only turn gets a fixed sentence). `from`: the id of
 * the Task that sends it, when it is not the person: the text then goes under a line that names the sender, and a
 * merge-grant sentence in it is not recorded as the person's.
 */
export const SendTaskInput = z.object({
  text: z.string().default(""),
  attachmentIds: z.array(z.string()).optional(),
  from: z.string().trim().min(1).max(200).regex(/^[\w.:-]+$/).optional(),
});
export type SendTaskInput = z.infer<typeof SendTaskInput>;

/** `POST /api/tasks/:id/outcome`: mark reviewed / not reviewed, set the outcome by hand, or both. Only a stored outcome can be set by hand (`failed` comes from the status). */
export const SetOutcomeInput = z
  .object({ outcome: StoredOutcome.exclude(["waits"]).optional(), reviewed: z.boolean().optional() })
  .refine((x) => x.outcome !== undefined || x.reviewed !== undefined, { message: "outcome or reviewed is required" });
export type SetOutcomeInput = z.infer<typeof SetOutcomeInput>;

/** `POST /api/tasks/:id/archive`: hide a stopped Task from the list, or bring it back. */
export const SetArchivedInput = z.object({ archived: z.boolean() });
export type SetArchivedInput = z.infer<typeof SetArchivedInput>;

/** `POST /api/tasks/:id/fork`: the seq of the `session.end` of the turn to branch from. */
export const ForkTaskInput = z.object({ seq: z.number().int().positive() });
export type ForkTaskInput = z.infer<typeof ForkTaskInput>;

/**
 * A file the person attached to a turn. Uploaded into the daemon's data directory, then moved under the task
 * it was sent with; the runner gets its absolute `path` in the prompt (DAK, which cannot reach the path, also gets the
 * contents in the message). `taskId` null = uploaded
 * but not sent yet (swept after a day).
 */
export const Attachment = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  path: z.string(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof Attachment>;

/** One answer of the judge: `finished` = the work asked for is finished and reported, `needs_action` = it stopped for the person. */
export const TaskJudgement = z.object({ result: z.enum(["finished", "needs_action"]), reason: z.string() });
export type TaskJudgement = z.infer<typeof TaskJudgement>;

/** A write the agent asked for through Workspace MCP; lives here until the user applies or rejects it. */
export const StagedChange = z.object({
  id: z.string(),
  taskId: z.string(),
  /** Absolute path inside the task scope. */
  path: z.string(),
  /** Path relative to the scope root (for display). */
  rel: z.string(),
  kind: z.enum(["write", "patch"]),
  /** File content when staged (null = file did not exist). Apply refuses if the file changed since. */
  before: z.string().nullable(),
  after: z.string(),
  status: z.enum(["pending", "applied", "rejected"]),
  ts: z.number(),
  decidedAt: z.number().nullable(),
  /** Unified diff before → after, computed once when staged. */
  diff: z.string(),
  /** "+n −m" from the diff. */
  stat: z.string(),
});
export type StagedChange = z.infer<typeof StagedChange>;

/** One entry of the task's 差分 tab. */
export const TaskDiffFile = z.object({
  path: z.string(),
  rel: z.string(),
  stat: z.string(),
  diff: z.string(),
  /**
   * staging = proposed through Workspace MCP and not yet applied · worktree = the repository as changed by the runner ·
   * removed = the Task wrote under `path`, which no longer exists; `rel` is the same path, `stat` and `diff` are empty ·
   * snapshot = a worktree row copied while the place still existed, returned under its `removed` row
   */
  source: z.enum(["staging", "worktree", "removed", "snapshot"]),
  stagedId: z.string().optional(),
  /** The top of the working tree a worktree or snapshot row came from. */
  root: z.string().optional(),
  /** When a snapshot row was last seen live (ms). */
  at: z.number().optional(),
});
export type TaskDiffFile = z.infer<typeof TaskDiffFile>;

/** The copy of a Task's diff kept in the DB (`task_diffs`): worktree rows, so a removed worktree can still be shown. */
export const TaskDiffSnapshot = z.object({ at: z.number(), files: z.array(TaskDiffFile) });
export type TaskDiffSnapshot = z.infer<typeof TaskDiffSnapshot>;

/** The morning view: what needs a person, and what ran unattended. */
export const Queue = z.object({
  waiting: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, ask: z.string(), since: z.number() })),
  staged: z.array(z.object({ taskId: z.string(), title: z.string(), pending: z.number() })),
  scheduled: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, status: z.string(), scheduleId: z.string(), scheduleTitle: z.string(), costUsd: z.number(), createdAt: z.number() })),
  /** Tasks waiting for a free run slot, oldest first; `since` = the Task's `queuedAt`, `position` counts from 1. */
  queued: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, since: z.number(), position: z.number().int() })),
});
export type Queue = z.infer<typeof Queue>;

/**
 * The last stop of a Task, for the 要対応 list: the newest series' key, reason, state, conditions, how many
 * times it stopped, whether the person answered it and up to 3 presets answered to that reason before (`replies`). Read from the `stop.record` events by `GET /api/tasks/stops`; it is not on `Task`.
 */
export const TaskStopMark = StopSummary.pick({ key: true, reason: true, state: true, conditions: true, count: true, answered: true }).extend({ replies: z.array(PresetReply).default([]) });
export type TaskStopMark = z.infer<typeof TaskStopMark>;

/** One entry of `GET /api/tasks`: the summary plus the Task's last stop (`stop`), left off when it has none. */
export const TaskListItem = TaskSummary.extend({ stop: TaskStopMark.optional() });
export type TaskListItem = z.infer<typeof TaskListItem>;

/**
 * Where "continue locally" is for a Cloud Task: the official Teleport running, waiting for the person's answer
 * in the terminal, being ended, importing, and how it ended. Memory only, never stored.
 */
export const TeleportProgress = z.object({
  phase: z.enum(["teleporting", "needs-input", "exiting", "importing", "done", "unconfirmed"]),
  /** needs-input: the last lines the CLI printed. */
  question: z.string().optional(),
  /** done / unconfirmed: what to tell the person. */
  message: z.string().optional(),
  /** done: the Local Task that was created. */
  localTaskId: z.string().optional(),
});
export type TeleportProgress = z.infer<typeof TeleportProgress>;

/**
 * What Claude Code in a Task's terminal tab says it is doing (OSC 7501): working, waiting for the person
 * (a permission or a dialog), or done with its turn. Memory only, never stored.
 */
export const TerminalStatus = z.enum(["working", "waiting", "done"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/**
 * A Task waiting for an approval elsewhere (docs/design/device-auth.md): the URL and one-time code a command
 * printed, relayed by the kit's `device-auth`. Kept in the daemon's memory only and sent over the WebSocket, never stored.
 */
export const DeviceAuthView = z.object({
  url: z.string(),
  code: z.string().optional(),
  /** The command that printed it, so the person can tell whether to trust the URL. */
  command: z.string(),
  /** Epoch ms; the screen hides it then, without waiting for the daemon. */
  expiresAt: z.number(),
});
export type DeviceAuthView = z.infer<typeof DeviceAuthView>;
