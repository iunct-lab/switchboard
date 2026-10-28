import { z } from "zod";
import { PermissionKind, RunnerId, StopCondition, StopReasonCode, StopRecord, StopState } from "./events.ts";

export const WorkspaceKind = z.enum(["repo", "meta"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/**
 * backlog-next's slots of one workspace (#561, per workspace since #2656): how many stage Tasks of each kind it keeps
 * running there. 0 = that slot is not moved automatically there.
 */
export const WorkspaceSweep = z.object({ implement: z.number().int().min(0).max(3), plan: z.number().int().min(0).max(3) });
export type WorkspaceSweep = z.infer<typeof WorkspaceSweep>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  kind: WorkspaceKind,
  createdAt: z.number(),
  /**
   * The repository variable that holds this workspace's GitHub Project URL, for the backlog. Unset = SWITCHBOARD_PROJECT_URL.
   * Each repository keeps the URL under its own name (e.g. the one its Actions add Issues to the Project with).
   */
  projectVar: z.string().optional(),
  /**
   * Where the workspace's backlog is kept (#2265): `github` = imported from and sent to its GitHub repository and
   * Project; `switchboard` = only in Switchboard's stored data (no GitHub Issue or Project). PRs and CI stay with the
   * repository's forge either way.
   */
  backlog: z.enum(["github", "switchboard"]).default("github"),
  /** backlog-next's slots here (#2656); a new workspace starts with one of each. */
  sweep: WorkspaceSweep.default({ implement: 1, plan: 1 }),
});
export type Workspace = z.infer<typeof Workspace>;

export const TaskStatus = z.enum(["idle", "running", "waiting", "done", "error", "aborted"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * What a stopped task came to, for the person (#492), apart from whether its runner is running (`status`):
 * `done` = finished, nothing to do; `needs_action` = waits on the person (an approval, a question); `failed` = error /
 * aborted; `unknown` = not judged yet. Set by the rule in `Db.updateTask` when the status changes, by the person, and
 * (#493) by reading the last reply.
 */
export const TaskOutcome = z.enum(["done", "needs_action", "failed", "unknown"]);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

/**
 * The user journeys the Web UI times (#637): each starts with the person's action and ends once the result is drawn.
 * `launch` = page load → the list and the composer usable; `new-task` = send on Home → the first event drawn;
 * `open-task` = a task picked in the rail → its transcript's last row drawn; `send` = send in a task → the reply's end drawn.
 */
export const Journey = z.enum(["launch", "new-task", "open-task", "send"]);
export type Journey = z.infer<typeof Journey>;

/**
 * Where a task was started (#91): `switchboard` = created here (UI, API, schedule, inbox); `terminal` = a Claude Code
 * session the person ran in a terminal, imported from `~/.claude/projects`. The origin never changes: a terminal
 * session continued from Switchboard (`--resume`) stays `terminal`, and the other way round.
 */
export const TaskOrigin = z.enum(["switchboard", "terminal"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

/**
 * What an LLM suggester proposed (#25). Advice only: it never selects the runner, it is shown next to the rule
 * table's reason and recorded so the two can be compared.
 */
export const LlmSuggestion = z.object({ runner: RunnerId, reason: z.string() });
export type LlmSuggestion = z.infer<typeof LlmSuggestion>;

/** Output of the rule-table router (core/routing.ts). Recorded per task so v2 (LLM routing) has training data. */
export const RoutingSuggestion = z.object({
  runner: RunnerId,
  reason: z.string(),
  /** Matching rule id, or "previous" / "fallback". */
  ruleId: z.string(),
  /** Model the matching rule proposes. null = no proposal; the runner's CLI default stays. */
  model: z.string().nullable().default(null),
  /** Whether the suggested runner is installed. The UI still shows the reason when it is not. */
  available: z.boolean(),
  alternatives: z.array(z.object({ runner: RunnerId, reason: z.string(), ruleId: z.string() })),
  /** The LLM's proposal for the same task (#25), when that is switched on and answered in time; null otherwise. */
  llm: LlmSuggestion.nullable().default(null),
});
export type RoutingSuggestion = z.infer<typeof RoutingSuggestion>;

/** What was suggested vs. what the user picked, stored on the task. */
export const TaskRouting = z.object({
  suggested: RunnerId,
  ruleId: z.string(),
  reason: z.string(),
  overridden: z.boolean(),
  /** What the LLM suggested at creation (#25), if it was on and answered in time. The task's runner never follows it. */
  llm: LlmSuggestion.nullable().default(null),
});
export type TaskRouting = z.infer<typeof TaskRouting>;

/**
 * One row of the routing decision log joined with how the task ended (#25): the training data an LLM router is
 * given. `GET /api/routing/log` returns these, `?format=jsonl` one per line.
 */
export const RoutingLogRow = z.object({
  taskId: z.string(),
  title: z.string(),
  suggested: RunnerId,
  ruleId: z.string(),
  reason: z.string(),
  chosen: RunnerId,
  /** Which suggester produced this row (#25): the rule table, or the LLM asked alongside it. */
  suggestedBy: z.enum(["rule", "llm"]),
  /** Status the task is in now — only whether the runner has stopped, not whether it went well. */
  status: TaskStatus,
  /** How the task turned out (#492): done / needs_action / failed / unknown. */
  outcome: TaskOutcome,
  /** Ledger total of the task in API-equivalent USD (0 when nothing was priced). */
  costUsd: z.number(),
  /** Creation → last status change, in ms. Still growing while the task runs. */
  durationMs: z.number(),
  ts: z.number(),
});
export type RoutingLogRow = z.infer<typeof RoutingLogRow>;

export const ExecutionMode = z.enum(["local", "cloud"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

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

export const SuggestInput = z.object({
  executionMode: ExecutionMode.default("local"),
  cwd: z.string().optional(),
  workspaceId: z.string().optional(),
  title: z.string().default(""),
  prompt: z.string().default(""),
  scope: z.array(z.string()).optional(),
  kind: z.string().optional(),
});
export type SuggestInput = z.infer<typeof SuggestInput>;

/**
 * One runner's record over the stats window (#612): per runner actually run (`chosen`), one per task (the rule row —
 * an LLM row for the same task is not counted again). A runner with no records in the window has no entry.
 */
export const RunnerStats = z.object({
  runner: RunnerId,
  total: z.number(),
  outcomes: z.object({ done: z.number(), needs_action: z.number(), failed: z.number(), unknown: z.number() }),
  /** Median ledger total in API-equivalent USD; null when there are no tasks. */
  medianCostUsd: z.number().nullable(),
  /** Median creation → last event, in ms; null when there are no tasks. */
  medianDurationMs: z.number().nullable(),
});
export type RunnerStats = z.infer<typeof RunnerStats>;

/**
 * How often each suggester's proposal matched the runner the person actually picked (#25). `agreed / total` is the
 * agreement rate and `total` is how many decisions that source actually produced a proposal for — which is *not*
 * the same denominator for both: a rule suggestion exists for every task, while an LLM proposal that failed or
 * missed its deadline writes nothing at all. The LLM's rate is therefore over the proposals it managed to make,
 * and the two percentages are not directly comparable; the UI shows both counts for that reason.
 */
export const RoutingStats = z.object({
  rule: z.object({ total: z.number(), agreed: z.number() }),
  llm: z.object({ total: z.number(), agreed: z.number() }),
  /** Rows in the window from any other source (a newer daemon's): counted so the UI never claims "no records". */
  otherTotal: z.number(),
  /** The window the numbers cover, in days — after clamping, so a caller can label what it actually got. */
  days: z.number(),
  /** How each runner's tasks turned out in the window (#612), most tasks first. */
  byRunner: z.array(RunnerStats),
});
export type RoutingStats = z.infer<typeof RoutingStats>;

/**
 * The stage a row's button starts (#265): request → PBI, PBI → Tasks (Ready), Ready → merged (/pbi-complete), in-progress → 状況確認 (#522).
 * `close` (#523): a `closable` in-progress PBI → its results written and closed (pbi-complete step 6); not tied to a stage.
 */
export const BacklogAction = z.enum(["to-pbi", "to-tasks", "complete", "check", "close"]);
export type BacklogAction = z.infer<typeof BacklogAction>;

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
  /** Budget in API-equivalent USD (#15); null = unlimited. Exceeding it raises a confirmation and blocks new turns. */
  budgetUsd: z.number().nullable(),
  /** Set when the task was started by a schedule (#20). */
  scheduleId: z.string().nullable(),
  /**
   * Runner-native permission mode the task runs in (#58): Claude `auto | acceptEdits | default | plan | dontAsk |
   * bypassPermissions`, Codex preset `auto | read-only | untrusted | full-access`. Resolved at creation (explicit →
   * saved runner default → adapter default) so the record says what the task actually ran with; null = the runner
   * has no such knob (DAK).
   */
  permissionMode: z.string().nullable(),
  /** Runner-native thinking effort fixed at creation (#833); null = the CLI's own default. */
  effort: z.string().nullable(),
  origin: TaskOrigin,
  /**
   * The task stopped on the runner's usage limit (#102): when the limit is expected to lift (ms). With auto-resume on
   * for the runner the daemon sends a follow-up turn then; off, it is only shown. null = no resume planned. Cleared
   * by any turn the person sends and by 中断.
   */
  resumeAt: z.number().nullable(),
  /**
   * What `resumeAt` waits for (#550): the runner's usage limit, or GitHub's API limit a turn met in its commands. null =
   * no plan, or a plan made before #550 (treated as the runner's limit).
   */
  resumeReason: z.enum(["limit", "github"]).nullable(),
  /**
   * Shadow run (#99): id of the primary task this one mirrors. A shadow task is a normal task (own transcript, diff,
   * ledger, approvals) created with the primary's cwd / scope / title / prompt on another runner; follow-up turns
   * sent to the primary are copied to it. Set at creation, never changed; null = not a shadow.
   */
  shadowOf: z.string().nullable(),
  /** Shadow run (#99): the user stopped this shadow (中断), so replies to the primary are no longer copied to it. */
  shadowStopped: z.boolean(),
  /** Why the daemon picked this task's Workspace (#135); null = the person picked it. Set at creation, never changed. */
  workspaceReason: z.string().nullable(),
  /** The title is provisional (#491): it is set once more after the first turn. A title the person gave or changed is false. */
  titlePending: z.boolean(),
  /** What the task came to (#492); separate from `status`. Set by the rule on a status change, by the person, and by #493's judge. */
  outcome: TaskOutcome,
  /** When the person marked the task 確認済み (ms) (#492); null = not reviewed. A new turn clears it. */
  reviewedAt: z.number().nullable(),
  /** When the Task was hidden from the list (ms) (#1142); null = not hidden. Only a stopped Task (done / error / aborted) gets one. */
  archivedAt: z.number().nullable(),
  /**
   * The judge's reading of the last reply (#493), kept next to `outcome` so a hand-set outcome and the judgement can
   * be compared later. null = not judged (a new turn clears it). `judgedBy` is `<runner>:<model>`.
   */
  judgedResult: z.enum(["done", "needs_action"]).nullable(),
  judgedReason: z.string().nullable(),
  judgedBy: z.string().nullable(),
  /** When the judgement of the last reply began (ms); null = not judging, or done. A new turn clears it; a restart that cut it short has it judged again once at start (#1139). */
  judgingAt: z.number().nullable(),
  /** The backlog Issue and stage this Task runs (a button, a schedule or an answer's follow-up made it); null for any other Task. Set at creation, never changed (#1139). */
  stage: z.object({ issue: z.number().int().positive(), action: BacklogAction }).nullable(),
  /** When the task came to its current `status` (ms) (#2029). Other changes (title, outcome, 確認済み…) leave it; `updatedAt` moves on any change. */
  statusAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof Task>;

/* ---------- Evals (#1218): what a task's record says about how it went ---------- */

/** Who wrote an eval row: the rule counter, the rubric judge (#1219), or the person (#1220). One row per task and source. */
export const EvalSource = z.enum(["rules", "judge", "human"]);
export type EvalSource = z.infer<typeof EvalSource>;

/** Counts over a task's events (#1218). Every number is over the whole task, not the last turn. */
export const RuleMetrics = z.object({
  /** `session.end` events: turns the runner finished (a turn cut by the daemon has none). */
  turns: z.number(),
  /** `tool.call` events. */
  toolCalls: z.number(),
  /** `tool.result` events with `ok: false`. */
  toolFailures: z.number(),
  /** `error` events. */
  errors: z.number(),
  /** `permission.ask` events: approvals the runner asked for. */
  asks: z.number(),
  /** `permission.resolved` events with `decision: deny`. */
  denials: z.number(),
  /** `stop.record` events (#939), and how many of them per stop reason code. */
  stops: z.number(),
  stopReasons: z.record(z.string(), z.number()),
  /** The person's messages after the first one (follow-ups, steers), without the daemon's own resume messages. */
  userInstructions: z.number(),
  /** How the last finished turn ended; null when no turn finished. */
  lastEnd: z.enum(["ok", "error", "aborted"]).nullable(),
  /** From the first event to the last (ms); null without events. */
  durationMs: z.number().nullable(),
});
export type RuleMetrics = z.infer<typeof RuleMetrics>;

/** The rule counter's row: the metrics, and what the task stood at when they were counted. */
export const RuleEval = z.object({
  metrics: RuleMetrics,
  status: TaskStatus,
  outcome: TaskOutcome,
  /** The task's ledger total at the time (API-equivalent USD). */
  costUsd: z.number(),
  /** The counter's version (`rules@1`): a change in what is counted bumps it, so old rows can be told apart. */
  by: z.string(),
  ts: z.number(),
});
export type RuleEval = z.infer<typeof RuleEval>;

/**
 * One criterion of a rubric (#1219): what the judge scores, with the wording for 1, 3 and 5 points so a lightweight
 * model has something concrete to compare the task against. `id` is the key under `JudgeEval.scores`.
 */
export const RubricCriterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
  anchors: z.object({ "1": z.string(), "3": z.string(), "5": z.string() }),
});
export type RubricCriterion = z.infer<typeof RubricCriterion>;

/**
 * A rubric (#1219): the default ships with core (`rubric.default.json`); the person's own replaces it from
 * `<SWITCHBOARD_HOME>/evals/rubric.json`. `id@version` is kept on every judge row, so a later edit does not confuse
 * old scores with new ones.
 */
export const Rubric = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    version: z.number().int().positive(),
    criteria: z.array(RubricCriterion).min(1).max(10),
  })
  // scores are keyed by criterion id: a duplicate would lose one score without a word
  .refine((r) => new Set(r.criteria.map((c) => c.id)).size === r.criteria.length, { message: "criterion ids must be unique", path: ["criteria"] });
export type Rubric = z.infer<typeof Rubric>;

/** One criterion's score (1–5) and the judge's one-line reason. */
export const RubricScore = z.object({ score: z.number().int().min(1).max(5), reason: z.string() });
export type RubricScore = z.infer<typeof RubricScore>;

/**
 * The rubric judge's row (#1219): a score per criterion the judge answered for (a criterion it left out is absent),
 * a one-line summary, the rubric as `id@version`, the judge as `<runner>:<model>`, and when it judged.
 */
export const JudgeEval = z.object({
  scores: z.record(z.string(), RubricScore),
  summary: z.string(),
  rubric: z.string(),
  by: z.string(),
  ts: z.number(),
});
export type JudgeEval = z.infer<typeof JudgeEval>;

/**
 * The person's own evaluation of a task (#1220): one rating and a note. Optional — most tasks never get one, and the
 * list and its sums stand without it. Kept next to the judge's row so the two can be compared later.
 */
export const HumanEval = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000),
  by: z.literal("user"),
  ts: z.number(),
});
export type HumanEval = z.infer<typeof HumanEval>;

/** `PUT /api/tasks/:id/evals/human` body. */
export const HumanEvalInput = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).default("") });
export type HumanEvalInput = z.infer<typeof HumanEvalInput>;

/** `GET /api/tasks/:id/evals`: one slot per source. null = not evaluated (a Cloud task has no rules row; a judge row needs a reply; a human row is the person's choice). */
export const TaskEvals = z.object({
  rules: RuleEval.nullable(),
  judge: JudgeEval.nullable(),
  human: HumanEval.nullable(),
  /** The models the task ran on: the distinct `model` of its `session.start` events, in the order first used, empty ones not counted ([] = not known). Two or more = the model was changed mid-task. */
  models: z.array(z.string()),
});
export type TaskEvals = z.infer<typeof TaskEvals>;

/**
 * One line of the Evals list (#1221): the task as it stands (status / outcome / updatedAt from `tasks`, the cost from
 * the ledger — the eval rows' own snapshots are not trusted) and the gist of each eval source, null where the task has
 * none. Sorting is the screen's; the daemon returns the newest first.
 */
export const EvalsListRow = z.object({
  taskId: z.string(),
  title: z.string(),
  runner: RunnerId,
  workspaceId: z.string().nullable(),
  status: TaskStatus,
  outcome: TaskOutcome,
  updatedAt: z.number(),
  costUsd: z.number(),
  /** As `TaskEvals.models`: the distinct `session.start` models in the order first used. Two or more = the model was changed mid-task. */
  models: z.array(z.string()),
  /** The task's thinking depth (`tasks.effort`); null = the CLI's default. */
  effort: z.string().nullable(),
  rules: z.object({ toolCalls: z.number(), toolFailures: z.number(), errors: z.number(), userInstructions: z.number(), stops: z.number(), lastEnd: z.enum(["ok", "error", "aborted"]).nullable() }).nullable(),
  judge: z.object({ average: z.number(), scores: z.record(z.string(), z.number()), rubric: z.string(), by: z.string() }).nullable(),
  human: z.object({ rating: z.number(), comment: z.string() }).nullable(),
});
export type EvalsListRow = z.infer<typeof EvalsListRow>;

export const FeedbackInput = z.object({
  text: z.string().min(1).max(20_000),
  attachmentIds: z.array(z.string()).optional(),
  /** The screen the feedback was sent from, as the UI names it (#262): Home, Task「<title>」(<id>), … */
  screen: z.string().max(200).optional(),
  /** request = register it as a request (request-to-backlog); fix = start a Task that fixes it now (#263). */
  mode: z.enum(["request", "fix"]).default("request"),
  /** Where a request is filed: the workspace whose repository and Project get it. Omitted = the meta workspace. すぐ直す always fixes Switchboard. */
  workspaceId: z.string().optional(),
  /** Evals (#1221): the request was drafted from a task's evaluations; the task goes into the request's 出典. */
  source: z.object({ kind: z.literal("eval"), taskId: z.string() }).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

/** 新しいリポジトリ (#1447): the name and what it is for. Everything else is decided in the Task's conversation. */
export const NewRepoInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  purpose: z.string().trim().min(1).max(2_000),
});
export type NewRepoInput = z.infer<typeof NewRepoInput>;

export const CreateTaskInput = z.object({
  executionMode: ExecutionMode.default("local"),
  workspaceId: z.string().optional(),
  /** Omitted together with `workspaceId` = "自動" (#135): the daemon asks the LLM to pick a registered Workspace, or answers 409. */
  cwd: z.string().optional(),
  /** Omitted = a provisional title from the prompt, set again after the first turn (#491). */
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
  /** Thinking effort (one of the runner's `efforts`, #833); omitted = the CLI's own default. */
  effort: z.string().optional(),
  /**
   * Shadow run (#99): also start the same prompt on this runner as a linked shadow task. Omitted = follow
   * `Settings.shadowRunner`; null = no shadow even if a default is saved. Must differ from `runner` and be detected.
   */
  shadowRunner: RunnerId.nullable().optional(),
  /** Attachments (#125): ids from `POST /api/attachments`, not yet attached to another task. Their paths go at the end of the prompt. */
  attachmentIds: z.array(z.string()).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/** `PATCH /api/tasks/:id` (#491): the person renames the task; it is never set again automatically. */
export const PatchTaskInput = z.object({ title: z.string().trim().min(1).max(200) });
export type PatchTaskInput = z.infer<typeof PatchTaskInput>;

/** `POST /api/tasks/:id/send`. Text, attachments, or both (an attachment-only turn gets a fixed sentence). */
export const SendTaskInput = z.object({
  text: z.string().default(""),
  attachmentIds: z.array(z.string()).optional(),
});
export type SendTaskInput = z.infer<typeof SendTaskInput>;

/** `POST /api/tasks/:id/outcome` (#492): mark reviewed / not reviewed, set the outcome by hand, or both. */
export const SetOutcomeInput = z
  .object({ outcome: TaskOutcome.optional(), reviewed: z.boolean().optional() })
  .refine((x) => x.outcome !== undefined || x.reviewed !== undefined, { message: "outcome or reviewed is required" });
export type SetOutcomeInput = z.infer<typeof SetOutcomeInput>;

/** `POST /api/tasks/:id/archive` (#1142): hide a stopped Task from the list, or bring it back. */
export const SetArchivedInput = z.object({ archived: z.boolean() });
export type SetArchivedInput = z.infer<typeof SetArchivedInput>;

/**
 * A file the person attached to a turn (#125). Uploaded into the daemon's data directory, then moved under the task
 * it was sent with; the runner gets its absolute `path` in the prompt (DAK, which cannot reach the path, also gets the
 * contents in the message, #124). `taskId` null = uploaded
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

/**
 * A report the person registered on the Task screen (#1777): a file or folder copied into the daemon's data
 * directory (so it opens after the original is gone), or a URL (not copied). `entry` is the file name (file), the
 * page to open inside the copied folder (dir) or null (url). `removedAt` set = in the undo window, swept after a day.
 */
export const Artifact = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  kind: z.enum(["file", "dir", "url"]),
  source: z.string(),
  entry: z.string().nullable(),
  mime: z.string(),
  size: z.number(),
  removedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Artifact = z.infer<typeof Artifact>;

/** A row across Tasks (#1835 reports, #1833 every artifact): an artifact with its Task's title and, when a schedule started that Task, the schedule's. */
export const ReportRow = Artifact.extend({ taskTitle: z.string(), scheduleTitle: z.string().nullable() });
export type ReportRow = z.infer<typeof ReportRow>;

/** One selectable permission mode of a runner, as the UI lists it. `danger` marks modes that skip approvals. */
export const PermissionModeOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string(),
  danger: z.boolean().optional(),
});
export type PermissionModeOption = z.infer<typeof PermissionModeOption>;

/** A model the runner accepts as `StartOptions.model` (#155). The list is the adapter's; anything else can still be typed. */
export const ModelOption = z.object({ value: z.string(), label: z.string() });
export type ModelOption = z.infer<typeof ModelOption>;

/**
 * LLM routing suggestions (#25). The runner is asked through its own adapter (Switchboard holds no API key), so the
 * choice of runner and model decides whose subscription quota a task creation spends. `model` empty = the CLI default.
 */
export const LlmRoutingSettings = z
  .object({
    enabled: z.boolean().default(false),
    runner: RunnerId.default("claude"),
    model: z.string().default(""),
    /**
     * How long a task creation waits for the suggestion before going with the rule table alone. The default is the
     * 5 s the design asks for, but a real `claude -p` turn (CLI start + extended thinking) measured ~12 s, so it is
     * a knob: raising it trades a slower Create button for actually getting a suggestion.
     */
    timeoutMs: z.number().int().min(1000).max(60_000).default(5000),
  })
  .default({});
export type LlmRoutingSettings = z.infer<typeof LlmRoutingSettings>;

export const RoutingSettings = z.object({ llm: LlmRoutingSettings }).default({});
export type RoutingSettings = z.infer<typeof RoutingSettings>;

/**
 * The automatic judgement at the end of a turn (#493): one read-only turn of this runner reads the last reply and
 * says whether the task is done or waiting on the person. On by default with Codex (the person's choice,
 * 2026-09-28); when it cannot answer, Claude Haiku is asked once instead (`judgeAndChoice.judgeFallbackRunner` / `judgeFallbackModel`, #835).
 */
export const JudgeSettings = z
  .object({
    enabled: z.boolean().default(true),
    runner: RunnerId.default("codex"),
    model: z.string().default("gpt-6-luna"),
  })
  .default({});
export type JudgeSettings = z.infer<typeof JudgeSettings>;

/**
 * Evals (#1219): the rubric judge at the end of a `done` turn. On by default, like the two-way judge; the runner and
 * model are the `judge` setting's (one setting, one subscription), so this only switches it off.
 */
export const EvalsSettings = z.object({ judge: z.object({ enabled: z.boolean().default(true) }).default({}) }).default({});
export type EvalsSettings = z.infer<typeof EvalsSettings>;

/** Naming a task after its first turn (#491). On by default: it spends a runner's quota once per task. Runner and model are not settings (`TITLE_RUNNERS`). */
export const TitlesSettings = z.object({ auto: z.boolean().default(true) }).default({});
export type TitlesSettings = z.infer<typeof TitlesSettings>;

/** One answer of the judge: `done` = the work asked for is finished and reported, `needs_action` = it stopped for the person. */
export const TaskJudgement = z.object({ result: z.enum(["done", "needs_action"]), reason: z.string() });
export type TaskJudgement = z.infer<typeof TaskJudgement>;

/**
 * The kinds of Task that start by themselves (#1337): the feedback modes (`FeedbackInput.mode`) and the backlog stages
 * (`BacklogAction`), under their own names.
 */
export const AutoStartKind = z.enum(["fix", "request", "to-pbi", "to-tasks", "complete", "check", "close", "new-repo"]);
export type AutoStartKind = z.infer<typeof AutoStartKind>;

/** One kind's own runner / model / effort (#1337); `model` / `effort` empty = that runner's CLI default. */
export const AutoStartChoice = z.object({ runner: RunnerId, model: z.string().default(""), effort: z.string().default("") });
export type AutoStartChoice = z.infer<typeof AutoStartChoice>;

/**
 * What a Task that starts by itself runs on (#832): the backlog stage buttons and the feedback button. A schedule has
 * its own runner / model / effort. `model` / `effort` (#833) empty = that runner's CLI default. `byKind` (#1337): a
 * kind with its own choice starts on it; a kind without one follows these common values (a schedule, its own).
 */
export const AutoStartSettings = z
  .object({
    runner: RunnerId.default("claude"),
    model: z.string().default(""),
    effort: z.string().default(""),
    byKind: z
      .object({
        fix: AutoStartChoice.optional(),
        request: AutoStartChoice.optional(),
        "to-pbi": AutoStartChoice.optional(),
        "to-tasks": AutoStartChoice.optional(),
        complete: AutoStartChoice.optional(),
        check: AutoStartChoice.optional(),
        close: AutoStartChoice.optional(),
        "new-repo": AutoStartChoice.optional(),
      })
      .default({}),
    /**
     * 上限のときの代わり (#834): while the decided runner has a usage window at `fallbackAt` or more that has not reset,
     * the next usable runner of this order starts the Task instead, on its CLI default model. Empty = no switch.
     */
    fallback: z.array(RunnerId).default([]),
    fallbackAt: z.number().min(0.5).max(1).default(0.9),
  })
  .default({});
export type AutoStartSettings = z.infer<typeof AutoStartSettings>;

/**
 * Values the person may want to tune while running (#835), one group per section of the settings screen. The ranges
 * are written once here (no defaults) and used by both `Settings` (with the defaults) and `SettingsPatch` (partial).
 * The defaults are the constants core used before; those constants stay in core as the source of the defaults.
 */
const quotaAndResumeFields = {
  /** backlog-next holds back to one stage Task overall when the Claude usage is at or above this (`QUOTA_LIMIT`). */
  backlogQuotaLimit: z.number().gt(0).max(1),
  /** Wait before resuming a usage-limit stop whose reset time is unknown; doubles per attempt up to `retryMaxDelayMs`. */
  retryDelayMs: z.number().int().min(60_000).max(86_400_000),
  retryMaxDelayMs: z.number().int().min(60_000).max(86_400_000),
  /** Give up resuming after this many usage-limit stops in a row (`MAX_CONSECUTIVE_STOPS`). */
  maxLimitStops: z.number().int().min(1).max(100),
  /** The text sent on a usage-limit resume. The daemon puts `[Switchboard 自動再開] ` before it, so it is still told apart. */
  resumePrompt: z.string().trim().min(1).max(2000),
  /** How many times a Task stopped by a daemon stop is resumed (`MAX_STOP_RESUMES`). */
  maxStopResumes: z.number().int().min(1).max(10),
  /** The runner comparison marks a row with fewer Tasks than this as a thin sample (`THIN_SAMPLE` in web). */
  thinSample: z.number().int().min(1).max(1000),
};
const judgeAndChoiceFields = {
  /** Asked once when the judge's runner cannot answer (`JUDGE_FALLBACK`). */
  judgeFallbackRunner: RunnerId,
  judgeFallbackModel: z.string().max(200),
  /** How long one judge turn may take (`JUDGE_TIMEOUT_MS`). */
  judgeTimeoutMs: z.number().int().min(1000).max(600_000),
  /**
   * How long the automatic Workspace choice of a task creation may take before the creation is refused (409). Kept
   * apart from the suggestion's `timeoutMs`: that one is a soft deadline (go with the rule table), this one is a hang
   * guard and must not be shortened by tuning the suggestion.
   */
  workspaceChoiceTimeoutMs: z.number().int().min(1000).max(600_000),
};
const newDefaultsFields = {
  /** The runner Home's creation form starts on. */
  taskRunner: RunnerId,
  /** The cron a new schedule starts with. Checked with core's `parseCron` on PATCH. */
  scheduleCron: z.string().trim().min(1).max(100),
};

export const QuotaAndResumeSettings = z
  .object({
    backlogQuotaLimit: quotaAndResumeFields.backlogQuotaLimit.default(0.8),
    retryDelayMs: quotaAndResumeFields.retryDelayMs.default(15 * 60_000),
    retryMaxDelayMs: quotaAndResumeFields.retryMaxDelayMs.default(4 * 3600_000),
    maxLimitStops: quotaAndResumeFields.maxLimitStops.default(8),
    resumePrompt: quotaAndResumeFields.resumePrompt.default("使用上限がリセットされました。中断した箇所から作業を続けてください。"),
    maxStopResumes: quotaAndResumeFields.maxStopResumes.default(2),
    thinSample: quotaAndResumeFields.thinSample.default(5),
  })
  .default({});
export type QuotaAndResumeSettings = z.infer<typeof QuotaAndResumeSettings>;

export const JudgeAndChoiceSettings = z
  .object({
    judgeFallbackRunner: judgeAndChoiceFields.judgeFallbackRunner.default("claude"),
    judgeFallbackModel: judgeAndChoiceFields.judgeFallbackModel.default("claude-haiku-4-5"),
    judgeTimeoutMs: judgeAndChoiceFields.judgeTimeoutMs.default(60_000),
    workspaceChoiceTimeoutMs: judgeAndChoiceFields.workspaceChoiceTimeoutMs.default(60_000),
  })
  .default({});
export type JudgeAndChoiceSettings = z.infer<typeof JudgeAndChoiceSettings>;

export const NewDefaultsSettings = z
  .object({
    taskRunner: newDefaultsFields.taskRunner.default("claude"),
    scheduleCron: newDefaultsFields.scheduleCron.default("0 3 * * *"),
  })
  .default({});
export type NewDefaultsSettings = z.infer<typeof NewDefaultsSettings>;

/** A dated price change (#115): valid from 00:00 UTC of `from`; a field left out keeps the row's value. */
export const PriceChange = z.object({
  // a real calendar day: Date.parse rolls 2027-02-30 over to March and gives NaN for month 13, so round-trip it
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const t = Date.parse(`${s}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    }, "not a calendar date"),
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
});
export const ModelPrice = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
  /** The 1-hour cache write (Claude: 2x input); absent = cacheWrite. */
  cacheWrite1h: z.number().nonnegative().optional(),
  /** Scheduled price changes; a table without them prices every time the same. */
  changes: z.array(PriceChange).optional(),
});
/** A price row entered on the settings screen (#1402): no dated changes, the row is the price from now on. */
export const SettingsPrice = ModelPrice.omit({ changes: true });
export type SettingsPrice = z.infer<typeof SettingsPrice>;

/** Daemon settings the UI can change (#58). Stored in sqlite; `~/.switchboard` files stay for the other knobs. */
export const Settings = z.object({
  /** runner → permission mode used when a task is created without one. Absent = the adapter's own default. */
  defaultPermissionMode: z.record(z.string()).default({}),
  /** runner → resume a task stopped on the usage limit once it lifts (#102). Absent = off. */
  autoResume: z.record(z.boolean()).default({}),
  /** Shadow run (#99): runner every new task is mirrored to unless the creation says otherwise; null = off. */
  shadowRunner: RunnerId.nullable().default(null),
  /** LLM runner suggestions (#25). Off by default: switching it on spends the runner's quota on every task creation. */
  routing: RoutingSettings.default({}),
  /** Judge each finished turn as done / needs action (#493). On by default: it spends the runner's quota once per turn. */
  judge: JudgeSettings.default({}),
  /** Runner and model of the Tasks that start by themselves (#832). */
  autoStart: AutoStartSettings.default({}),
  /** The rubric judge (#1219). */
  evals: EvalsSettings.default({}),
  /** Name a task after its first turn (#491). */
  titles: TitlesSettings.default({}),
  /** Usage threshold and automatic resume (#835). */
  quotaAndResume: QuotaAndResumeSettings.default({}),
  /** The judge's fallback and timeouts, the Workspace choice's timeout (#835). */
  judgeAndChoice: JudgeAndChoiceSettings.default({}),
  /** What the creation forms start with (#835). */
  newDefaults: NewDefaultsSettings.default({}),
  /**
   * runner → region of Amazon Bedrock (#1730). Absent = the runner runs on its own login (the Claude account). Only
   * what the user chose is saved: no key, no profile; the CLI reads AWS credentials its own way (docs/design/bedrock.md).
   */
  bedrock: z.record(z.object({ region: z.string() })).default({}),
  /** model → price (USD / 1M tokens) over pricing.json's row of the same model (#1402); read on every use, no restart. */
  prices: z.record(SettingsPrice).default({}),
  /**
   * runner → the model choices (#1400), in the order shown. Absent = the adapter's bundled list. Replaces the list of
   * the runner's own login only: on Amazon Bedrock the ids are spelled differently and the adapter's Bedrock list stays.
   */
  models: z.record(z.array(ModelOption)).default({}),
});
export type Settings = z.infer<typeof Settings>;

const autoStartChoicePatch = z.object({ runner: RunnerId, model: z.string(), effort: z.string() }).partial().nullable();

/** PATCH body: null removes the override (back to the adapter default / off). */
export const SettingsPatch = z.object({
  defaultPermissionMode: z.record(z.string().nullable()).optional(),
  autoResume: z.record(z.boolean().nullable()).optional(),
  /** null = back to the runner's own login (#1730). */
  bedrock: z.record(z.object({ region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/) }).nullable()).optional(),
  /** The whole list per runner (#1400); null = back to the adapter's bundled list. */
  models: z.record(z.array(ModelOption).nullable()).optional(),
  shadowRunner: RunnerId.nullable().optional(),
  /** Partial: `{ routing: { llm: { enabled: true } } }` leaves the saved runner / model alone. */
  routing: z.object({ llm: z.object({ enabled: z.boolean(), runner: RunnerId, model: z.string(), timeoutMs: z.number().int().min(1000).max(60_000) }).partial().optional() }).partial().optional(),
  /** Partial: `{ judge: { enabled: false } }` leaves the saved runner / model alone. */
  judge: z.object({ enabled: z.boolean(), runner: RunnerId, model: z.string() }).partial().optional(),
  /**
   * Partial: `{ autoStart: { model: "x" } }` leaves the saved runner alone. `byKind` (#1337): a partial choice per kind
   * over that kind's saved one (else the common values); `null` = back to the common values.
   */
  autoStart: z
    .object({
      runner: RunnerId,
      model: z.string(),
      effort: z.string(),
      byKind: z
        .object({
          fix: autoStartChoicePatch,
          request: autoStartChoicePatch,
          "to-pbi": autoStartChoicePatch,
          "to-tasks": autoStartChoicePatch,
          complete: autoStartChoicePatch,
          check: autoStartChoicePatch,
          close: autoStartChoicePatch,
          "new-repo": autoStartChoicePatch,
        })
        .partial(),
      /** Replaces the whole order (#834). */
      fallback: z.array(RunnerId),
      fallbackAt: z.number().min(0.5).max(1),
    })
    .partial()
    .optional(),
  /** `{ evals: { judge: { enabled: false } } }` switches the rubric judge off (#1219). */
  evals: z.object({ judge: z.object({ enabled: z.boolean() }).partial().optional() }).partial().optional(),
  titles: z.object({ auto: z.boolean() }).partial().optional(),
  /** Partial: `{ quotaAndResume: { maxLimitStops: 3 } }` leaves the rest alone; null puts the whole group back to the defaults (#835). */
  quotaAndResume: z.object(quotaAndResumeFields).partial().nullable().optional(),
  judgeAndChoice: z.object(judgeAndChoiceFields).partial().nullable().optional(),
  newDefaults: z.object(newDefaultsFields).partial().nullable().optional(),
  /** model → price row; null removes the row (back to pricing.json's row, if any) (#1402). */
  prices: z.record(SettingsPrice.nullable()).optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const LedgerRow = z.object({
  taskId: z.string(),
  runner: RunnerId,
  model: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** The 1-hour part of cacheWrite (#115); kept so a row can be repriced. */
  cacheWrite1h: z.number(),
  /** API-equivalent USD (reported by the runner, or priced from pricing.json). */
  costUsd: z.number(),
  /** Actually charged USD (0 under a subscription). */
  billedUsd: z.number(),
  /** reported = runner gave the cost · priced = computed from the table · unpriced = unknown model (cost 0) */
  source: z.string(),
  ts: z.number(),
});
export type LedgerRow = z.infer<typeof LedgerRow>;

/** GitHub's GraphQL budget of the user the daemon's `gh` signs in as (#549): `resetsAt` in epoch seconds, as `quota`. */
export const GithubBudget = z.object({ remaining: z.number(), limit: z.number(), resetsAt: z.number() });
export type GithubBudget = z.infer<typeof GithubBudget>;

export const LedgerSummary = z.object({
  /** API-equivalent (list price) figures. */
  todayUsd: z.number(),
  weekUsd: z.number(),
  /** What is actually charged (subscription runners count 0). */
  billedTodayUsd: z.number(),
  billedWeekUsd: z.number(),
  byRunnerToday: z.record(z.number()),
  quota: z.array(z.object({ runner: RunnerId, window: z.string(), utilization: z.number(), resetsAt: z.number(), ts: z.number() })),
  topTasks: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, costUsd: z.number(), tokens: z.number() })),
  /** null while it cannot be read (#549). */
  github: GithubBudget.nullable(),
});
export type LedgerSummary = z.infer<typeof LedgerSummary>;

/** Ledger screen (#14): one row per day × runner. */
export const LedgerDaily = z.object({ day: z.string(), runner: RunnerId, costUsd: z.number(), billedUsd: z.number(), tokens: z.number() });
export type LedgerDaily = z.infer<typeof LedgerDaily>;

export const LedgerTaskRow = z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, origin: TaskOrigin, model: z.string().nullable(), costUsd: z.number(), billedUsd: z.number(), tokens: z.number(), unpriced: z.boolean(), lastTs: z.number() });
export type LedgerTaskRow = z.infer<typeof LedgerTaskRow>;

/** Ledger screen (#1836): the period's usage per runner × model, costliest first. `tasks` = Tasks that used it; `unpriced` = a usage of the pair had no price. */
export const LedgerModelRow = z.object({ runner: RunnerId, model: z.string().nullable(), tasks: z.number(), tokens: z.number(), costUsd: z.number(), billedUsd: z.number(), unpriced: z.boolean() });
export type LedgerModelRow = z.infer<typeof LedgerModelRow>;

/**
 * One finished journey as the Web UI timed it in everyday use (#639): `build` = the hash in the loaded JS file's name
 * (`dev` under the dev server), `device` = `mobile` below 700 px wide. Kept only in this daemon's database, 30 days.
 */
export const PerfSample = z.object({
  journey: Journey,
  device: z.enum(["desktop", "mobile"]),
  build: z.string().min(1).max(64),
  ms: z.number().nonnegative().max(600_000),
  /** The Task's size (#2100), for `open-task` / `send` only (null otherwise). bytes = that Task's `GET /api/tasks/:id` response (decoded). */
  taskId: z.string().min(1).max(64).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  events: z.number().int().nonnegative().nullable(),
});
export type PerfSample = z.infer<typeof PerfSample>;
/** `POST /api/perf`: what the Web UI sends at once. */
export const PerfSamplesInput = z.array(PerfSample).min(1).max(50);

/** A Task's size by its event count (#2103): small up to 1,000, medium up to 5,000, large above. */
export const SizeClass = z.enum(["small", "medium", "large"]);
export type SizeClass = z.infer<typeof SizeClass>;
export const PerfPeriodStats = z.object({ count: z.number(), p50: z.number(), p90: z.number() });
/**
 * `GET /api/perf/summary` (#639, #2103): per journey × device × size (null: no event count, as `launch`), the last 7
 * days (`current`) against the 7 days before them (`previous`); a period without samples is null.
 */
export const PerfSummaryRow = z.object({ journey: Journey, device: PerfSample.shape.device, size: SizeClass.nullable(), current: PerfPeriodStats.nullable(), previous: PerfPeriodStats.nullable() });
export type PerfSummaryRow = z.infer<typeof PerfSummaryRow>;

/** Why a daemon run ended (#2085). */
export const StopReason = z.enum(["oomd", "restart", "host-stop", "promote", "crash", "unknown"]);
export type StopReason = z.infer<typeof StopReason>;
/** One JST day × cause: the stops, the turns they cut (one per task per stop) and the tasks. */
export const OpsStopsRow = z.object({ day: z.string(), reason: StopReason, stops: z.number(), turns: z.number(), taskIds: z.array(z.string()) });
export type OpsStopsRow = z.infer<typeof OpsStopsRow>;
/** `GET /api/ops/stops?days=`: the closed runs of the period, and the run in progress. */
export const OpsStops = z.object({ days: z.number(), rows: z.array(OpsStopsRow), running: z.object({ startedAt: z.number(), version: z.string().nullable() }).nullable() });
export type OpsStops = z.infer<typeof OpsStops>;

/** What a process of the daemon's unit is doing (#2086). */
export const LoadKind = z.enum(["runner", "subagent", "test", "browser", "docker", "build", "judge", "archive", "backlog", "other"]);
export type LoadKind = z.infer<typeof LoadKind>;
/** One JST hour of the unit's load: its peaks, and how many times it reached memory.max. */
export const OpsLoadHour = z.object({
  hour: z.string() /* JST "YYYY-MM-DD HH" */,
  maxMem: z.number(),
  memMax: z.number().nullable(),
  maxSwap: z.number(),
  limitHits: z.number(),
  maxCpuPct: z.number().nullable(),
  maxPressureFull: z.number().nullable(),
  maxDockerMem: z.number().nullable(),
});
export type OpsLoadHour = z.infer<typeof OpsLoadHour>;
/** Task × owner × kind over the period: the largest RSS of one minute, and the CPU time used. */
export const OpsLoadGroup = z.object({ taskId: z.string().nullable(), owner: z.enum(["task", "daemon", "other"]), kind: LoadKind, maxRss: z.number(), cpuMs: z.number() });
export type OpsLoadGroup = z.infer<typeof OpsLoadGroup>;
/** `GET /api/ops/load?days=&task=`. `available` false: this host has no cgroup v2 / /proc to read (macOS). */
export const OpsLoad = z.object({ available: z.boolean(), days: z.number(), hours: z.array(OpsLoadHour), groups: z.array(OpsLoadGroup) });
export type OpsLoad = z.infer<typeof OpsLoad>;
/** One method × route of api_requests (#2102): request count, nearest-rank p50 / p90 of ms, the p50 of the known bytes (null: none known). */
export const OpsLatencyStat = z.object({ method: z.string(), route: z.string(), count: z.number(), p50: z.number(), p90: z.number(), bytesP50: z.number().nullable() });
export type OpsLatencyStat = z.infer<typeof OpsLatencyStat>;
/** `GET /api/ops/latency?days=`: `total` over the whole period (largest p90 first), `byDay` per JST day (newest first). */
export const OpsLatency = z.object({ days: z.number(), total: z.array(OpsLatencyStat), byDay: z.array(OpsLatencyStat.extend({ day: z.string() })) });
export type OpsLatency = z.infer<typeof OpsLatency>;

export const PricingTable = z.object({
  version: z.literal(1),
  /** api = pay-as-you-go (実課金 = API 換算) · subscription = covered by a plan (実課金 0) */
  billing: z.record(z.enum(["api", "subscription"])).default({}),
  /** USD per 1M tokens */
  models: z.record(ModelPrice).default({}),
  /** model or runner name → model name in `models` */
  aliases: z.record(z.string()).default({}),
});
export type PricingTable = z.infer<typeof PricingTable>;

export const Footprint = z.object({
  files: z.number(),
  bytes: z.number(),
  estTokens: z.number(),
  truncated: z.boolean(),
});
export type Footprint = z.infer<typeof Footprint>;

/** Frontmatter of a knowledge document. Unknown keys pass through; known keys are validated. */
export const KnowledgeTarget = z.enum(["claude", "codex", "agents-md", "commands"]);
export type KnowledgeTarget = z.infer<typeof KnowledgeTarget>;

export const KnowledgeFrontmatter = z
  .object({
    /** YAML turns `title: 2026` into a number; accept and stringify rather than invalidating the whole block. */
    title: z.union([z.string(), z.number()]).transform(String).optional(),
    /** Which generated files this document feeds (Materializer). */
    targets: z.array(KnowledgeTarget).optional(),
    /** Absolute repository path(s) this applies to; omitted = global. */
    repo: z.string().optional(),
    repos: z.array(z.string()).optional(),
    /** Approval rules matched against permission.ask (glob patterns on the touched path / command). */
    approval: z.object({ confirm: z.array(z.string()).optional(), allow: z.array(z.string()).optional() }).optional(),
    tags: z.array(z.string()).optional(),
    /** Set by the indexer when the frontmatter did not validate. */
    _invalid: z.string().optional(),
  })
  .passthrough();
export type KnowledgeFrontmatter = z.infer<typeof KnowledgeFrontmatter>;

export const KnowledgeDoc = z.object({
  /** Path relative to the knowledge folder, "/"-separated. */
  path: z.string(),
  title: z.string(),
  kind: z.enum(["rules", "commands", "notes", "docs", "other"]),
  frontmatter: KnowledgeFrontmatter,
  mtime: z.number(),
  size: z.number(),
});
export type KnowledgeDoc = z.infer<typeof KnowledgeDoc>;

export const KnowledgeSearchHit = z.object({ path: z.string(), title: z.string(), kind: KnowledgeDoc.shape.kind, snippet: z.string(), rank: z.number() });
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHit>;

export const InboxNote = z.object({
  path: z.string(),
  title: z.string(),
  body: z.string(),
  created: z.string(),
  /** Free-text hint about where this belongs (a workspace name), if the user gave one. */
  workspaceHint: z.string().optional(),
  status: z.enum(["inbox", "promoted", "closed"]),
  taskId: z.string().optional(),
  /** Set on a notice the daemon left (which schedule put it there); a note without it is the user's own draft. */
  source: z.object({ schedule: z.string(), title: z.string() }).optional(),
});
export type InboxNote = z.infer<typeof InboxNote>;

export const InboxAddInput = z.object({ text: z.string().min(1), title: z.string().optional(), workspaceHint: z.string().optional() });
export type InboxAddInput = z.infer<typeof InboxAddInput>;

export const InboxPromoteInput = z.object({ path: z.string().min(1), workspaceId: z.string().min(1), runner: RunnerId.optional(), title: z.string().optional() });
export type InboxPromoteInput = z.infer<typeof InboxPromoteInput>;

export const InboxCloseInput = z.object({ path: z.string().min(1) });
export type InboxCloseInput = z.infer<typeof InboxCloseInput>;

export const MaterializeApplyInput = z.object({
  workspaceId: z.string().min(1).optional(),
  paths: z.array(z.string()).optional(),
  /** relPath → hash of the previewed content; the daemon refuses to write a file whose plan moved since the preview. */
  expected: z.record(z.string()).optional(),
  /** Overwrite managed blocks that were edited by hand in the repository file. */
  force: z.boolean().optional(),
});
export type MaterializeApplyInput = z.infer<typeof MaterializeApplyInput>;

/** A write the agent asked for through Workspace MCP; lives here until the user applies or rejects it (#11). */
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

/** One entry of the task's 差分 tab (#12). */
export const TaskDiffFile = z.object({
  path: z.string(),
  rel: z.string(),
  stat: z.string(),
  diff: z.string(),
  /** staging = proposed through Workspace MCP and not yet applied · worktree = the repository as changed by the runner */
  source: z.enum(["staging", "worktree"]),
  stagedId: z.string().optional(),
});
export type TaskDiffFile = z.infer<typeof TaskDiffFile>;

/** Self-dev (#18): results of the repository's checks after a task on the meta workspace. */
export const CheckResult = z.object({
  kind: z.enum(["typecheck", "test"]),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  summary: z.string(),
  output: z.string(),
  durationMs: z.number(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckRun = z.object({ taskId: z.string(), ok: z.boolean(), results: z.array(CheckResult), ts: z.number() });
export type CheckRun = z.infer<typeof CheckRun>;

/**
 * What a secret-scan firing found, kept on the schedule (#1274): the time it ended, `repos` = repositories identified from
 * the workspaces (one whose scan then failed counts too), `hits`, `failed` = scans that failed plus workspaces whose
 * repository could not be identified, and its log lines (places and kinds only, never a value). A firing whose scan
 * itself threw is `repos: 0, failed: 1` with one line carrying the error's name only.
 */
export const ScheduleResult = z.object({ at: z.number(), repos: z.number(), hits: z.number(), failed: z.number(), lines: z.array(z.string()) });
export type ScheduleResult = z.infer<typeof ScheduleResult>;

/** A recurring task (#20): a cron expression that starts a task with this prompt on a workspace. */
export const Schedule = z.object({
  id: z.string(),
  title: z.string(),
  cron: z.string(),
  workspaceId: z.string(),
  runner: RunnerId,
  /** The model the runner starts on (#832); empty = that runner's CLI default. */
  model: z.string(),
  /** The thinking effort the runner starts with (#833); empty = that runner's CLI default. */
  effort: z.string(),
  prompt: z.string(),
  /**
   * `prompt` = start a task with the prompt; `backlog-next` = move one backlog item to its next stage (#267);
   * `secret-scan` = check every registered repository for values written on GitHub (#775); those two use no runner.
   * `insights` = run Claude Code's /insights as a Task of its own and keep the report as its artifact (#1838; claude, no prompt).
   */
  action: z.enum(["prompt", "backlog-next", "secret-scan", "insights"]),
  budgetUsd: z.number().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  lastTaskId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  /** The last secret-scan firing's result (#1274); null on the other actions and before the first firing. */
  lastResult: ScheduleResult.nullable(),
  createdAt: z.number(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleInput = z.object({
  title: z.string().min(1),
  cron: z.string().min(1),
  workspaceId: z.string().min(1),
  runner: RunnerId,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Required (non-blank) when action is `prompt` — checked by the scheduler, since PATCH takes a partial of this; the other kinds take none (#1838). */
  prompt: z.string().optional(),
  action: z.enum(["prompt", "backlog-next", "secret-scan", "insights"]).optional(),
  budgetUsd: z.number().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** The morning view (#20): what needs a person, and what ran unattended. */
export const Queue = z.object({
  waiting: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, ask: z.string(), since: z.number() })),
  staged: z.array(z.object({ taskId: z.string(), title: z.string(), pending: z.number() })),
  scheduled: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, status: z.string(), scheduleId: z.string(), scheduleTitle: z.string(), costUsd: z.number(), createdAt: z.number() })),
});
export type Queue = z.infer<typeof Queue>;

/** One unanswered permission.ask across all tasks (#26): answered with POST /api/tasks/:taskId/permission { id }. */
export const PendingApproval = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  workspace: z.string().nullable(),
  id: z.string(),
  kind: PermissionKind,
  tool: z.string(),
  input: z.unknown(),
  detail: z.string(),
  askedAt: z.number(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

/**
 * Where an open question comes from (#935): approval = a tool approval of a Task, decision = an Issue's `## 判断待ち`,
 * check = an operational check asked in a Task's conversation, confirmation = an acceptance criterion waiting on the
 * user's own check, stop = a stop record (`stop.record`), wait = a PBI waiting for PRs / Issues to close.
 */
export const AskKind = z.enum(["approval", "decision", "check", "confirmation", "stop", "wait"]);
export type AskKind = z.infer<typeof AskKind>;

/**
 * open = not answered yet (the screen's 未回答), held = the person put it on hold (`## 保留`, #936; still theirs to answer),
 * answered = an answer is recorded and the work has not gone on yet, resolved = it went on.
 */
export const AskState = z.enum(["open", "held", "answered", "resolved"]);
export type AskState = z.infer<typeof AskState>;

const answerText = z.string().trim().max(20_000);
/**
 * One answer to a question (#936): choice = one of its choices (and a note), text = free text, hold = put it on hold
 * (not an approval), allow / deny = a tool approval, confirm = an acceptance criterion checked by the user (ok) or not.
 */
export const AskAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), choice: z.string().min(1), note: answerText.optional() }),
  z.object({ kind: z.literal("text"), text: answerText.min(1) }),
  z.object({ kind: z.literal("hold"), text: answerText.optional() }),
  z.object({ kind: z.literal("allow") }),
  z.object({ kind: z.literal("deny") }),
  z.object({ kind: z.literal("confirm"), ok: z.boolean(), text: answerText.optional() }),
  /** Send the stop's grant (#2745) as the reply, once. */
  z.object({ kind: z.literal("grant") }),
]);
export type AskAnswer = z.infer<typeof AskAnswer>;
export const AskAnswerKind = z.enum(["choice", "text", "hold", "allow", "deny", "confirm", "grant"]);
export type AskAnswerKind = z.infer<typeof AskAnswerKind>;

/**
 * A saved answer policy (#938): one answer reused next time under a scope and conditions. Matched on structured values
 * only (tool kind + path / command, or the stop record's op / target / conditions), never on the wording of a question.
 */
export const PolicyScope = z.enum(["once", "pbi", "repo"]);
export type PolicyScope = z.infer<typeof PolicyScope>;
const PolicyCondition = z.object({ key: z.string(), value: z.string() });
export const PolicySubject = z.object({
  kind: z.enum(["approval", "check", "decision"]),
  op: z.string().max(100),
  target: z.string().max(200),
  conditions: z.array(PolicyCondition),
  /** Head sha of the PR the work stopped at, when there is one. */
  head: z.string().nullable(),
});
export type PolicySubject = z.infer<typeof PolicySubject>;
export const AnswerPolicy = z.object({
  id: z.string(),
  scope: PolicyScope,
  workspaceId: z.string(),
  pbi: z.number().nullable(),
  askId: z.string().nullable(),
  kind: PolicySubject.shape.kind,
  op: z.string(),
  /** A glob, same rules as the approval rules' globMatch. */
  target: z.string(),
  /** Applies only when the current conditions hold every one of these values. */
  when: z.array(PolicyCondition),
  answer: AskAnswer,
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** The question it was saved from. */
  from: PolicySubject,
  /** Newest 20 uses. */
  uses: z.array(
    z.object({ at: z.number(), askId: z.string(), taskId: z.string().nullable(), issue: z.number().nullable(), subject: PolicySubject, /** The answered question's id, when the question's id changes with its answer (a decision's). */ answered: z.string().optional() }),
  ),
});
export type AnswerPolicy = z.infer<typeof AnswerPolicy>;
export const PolicyInput = z.object({
  scope: PolicyScope,
  target: z.string().trim().min(1).max(200),
  when: z.array(PolicyCondition),
  expiresAt: z.number().nullable(),
});
export type PolicyInput = z.infer<typeof PolicyInput>;
export const PolicyPatch = PolicyInput.omit({ scope: true }).partial().extend({ revoked: z.boolean().optional() });
export type PolicyPatch = z.infer<typeof PolicyPatch>;

/**
 * What stands in the way that an answer does not take away (#936): depends = a PR / Issue still open, condition = a stop
 * condition not met (e.g. `ci: failure`), runner = the runner refused (permission / auth) with no tool approval to answer.
 */
export const AskBlocker = z.object({ kind: z.enum(["depends", "condition", "runner"]), detail: z.string() });
export type AskBlocker = z.infer<typeof AskBlocker>;

/**
 * How the work goes on after the answer (#936), read from the records each time: answered = written, the work not asked to
 * go on (yet), queued = waits to be resumed (`reason`), running = the work runs (`taskId`), failed = it
 * did not start or ended in error (`reason`). `at` = when that state was seen to begin (ms).
 */
export const AskResume = z.object({ state: z.enum(["answered", "queued", "running", "failed"]), reason: z.string().nullable(), taskId: z.string().nullable(), at: z.number() });
export type AskResume = z.infer<typeof AskResume>;

/**
 * One question across the Tasks and the backlog (#935), built from the records each time it is read,
 * never stored. null = not known (the screen says 不明). `needs`: person = someone has to answer, auto = it goes on by itself
 * once its `conditions` are met. `route` = where the screen sends the person to answer it.
 *
 * `id` (#936 answers to it):
 * - `decision:<workspaceId>#<the Issue asked on>@<the ## 判断待ち's at>` (`@` and nothing after it when the ## 判断待ち
 *   cannot be read); an answered one, whose question is gone from the records, is `decision:<workspaceId>#<PBI>@<answeredAt>`
 * - `confirm:<workspaceId>#<PBI>:<n>` (n = the criterion's number, BacklogItem.confirmations)
 * - `wait:<workspaceId>#<PBI>@<waitsAt>`
 * - `stop:<StopSummary.key with each \0 written as |>`
 */
/**
 * What the screen shows about saved policies for one question (#938): `scopes` = the ranges it can be saved under ([] = it
 * cannot, with `note`), `defaults` = what the form starts with, `applied` = the policy that answered it, `previous` = the
 * earlier answer that no longer applies, and what differs.
 */
export const AskPolicy = z.object({
  scopes: z.array(PolicyScope),
  note: z.string().nullable(),
  defaults: z.object({ target: z.string(), when: AnswerPolicy.shape.when, expiresAt: z.number().nullable() }).nullable(),
  applied: z.object({ id: z.string(), scope: PolicyScope, at: z.number(), summary: z.string() }).nullable(),
  previous: z.object({ id: z.string(), answer: AskAnswer, at: z.number(), why: z.string(), changes: z.array(z.string()) }).nullable(),
});
export type AskPolicy = z.infer<typeof AskPolicy>;

export const Ask = z.object({
  id: z.string(),
  kind: AskKind,
  needs: z.enum(["person", "auto"]),
  state: AskState,
  /** When it was asked (ms). */
  at: z.number(),
  /** When its state last changed (ms); `at` while it is open. Answered / resolved ones are shown for a day after it. */
  changedAt: z.number(),
  workspace: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** The backlog item it belongs to: a PBI, or a request. */
  pbi: z.object({ number: z.number(), title: z.string(), url: z.string() }).nullable(),
  /** The Issue it is asked on (a PBI or one of its Tasks). */
  issue: z.object({ number: z.number(), url: z.string() }).nullable(),
  task: z.object({ id: z.string(), title: z.string().nullable(), /** The Issue a stage Task works on (`Task.stage.issue`); null for an ordinary Task. */ stageIssue: z.number().nullable().optional() }).nullable(),
  reason: z.string().nullable(),
  question: z.string().nullable(),
  choices: z.array(z.string()),
  /** Each choice's grant (#2745: the ` — 許可: <文>` of its line), in the order of `choices`; null = the choice has none. */
  grants: z.array(z.string().nullable()).default([]),
  /** A permission stop's grant (#2745), sent once by the `grant` answer. */
  grant: z.string().nullable().default(null),
  recommendation: z.object({ choice: z.string(), why: z.string() }).nullable(),
  /** What goes on once it is answered. */
  next: z.string().nullable(),
  /** The record it was read from: an Issue (url) or a Task's conversation (taskId). */
  source: z.object({ label: z.string(), url: z.string().nullable(), taskId: z.string().nullable() }),
  route: z.enum(["approval", "backlog", "task", "issue", "none"]),
  conditions: z.array(StopCondition),
  /** The kinds of answer it takes (#936); empty = not answered from the screen (automatic, or the runner refused). */
  answers: z.array(AskAnswerKind),
  /** Where the work stopped (`**止めた場所**:`), with the first `PR #n` it names (#936: a merge check is about that PR's head). */
  place: z.object({ text: z.string(), pr: z.number().nullable() }).nullable(),
  /** The screen mockups to compare before answering (#2221): the HTML artifacts, not removed, of the Task the question's `**画面イメージ**:` names. */
  mockups: z.array(Artifact).default([]),
  blockers: z.array(AskBlocker),
  /** null = not answered yet, or the answer's work is over (resolved). */
  resume: AskResume.nullable(),
  /** What a saved policy is matched on (#938): the operation and target. null = none recorded. */
  subject: PolicySubject.nullable(),
  /** What the screen shows about policies (#938). */
  policy: AskPolicy,
});
export type Ask = z.infer<typeof Ask>;

/** POST /api/asks/answer (#936): the answer to the question `id` as it was on screen. */
export const AskAnswerInput = z.object({ id: z.string().min(1), answer: AskAnswer, /** Save the answer as a policy with it (#938). */ policy: PolicyInput.optional() });
export type AskAnswerInput = z.infer<typeof AskAnswerInput>;
/**
 * `already` = the question was answered before (a resend): nothing was written again. `ask` = the question now, null when
 * it is gone. `changes` = what had moved on the PR it stopped at when a text answer was written (written with it too).
 */
export const AskAnswerResult = z.object({ ask: Ask.nullable(), already: z.boolean(), changes: z.array(z.string()).default([]), /** The policy saved with the answer (#938). */ policy: AnswerPolicy.nullable().optional() });
/** GET /api/policies (#938). */
export const PolicyList = z.object({ policies: z.array(AnswerPolicy) });
export type PolicyList = z.infer<typeof PolicyList>;

/**
 * A saved instruction (#940): a name and a short request text, with `{{target}}` where the chosen
 * Issue / PR goes. It carries no approval mode, runner or model — it is what to ask, never a standing permission.
 */
export const Preset = z.object({ id: z.string(), name: z.string().trim().min(1).max(60), text: z.string().trim().min(1).max(8000), createdAt: z.number(), updatedAt: z.number() });
export type Preset = z.infer<typeof Preset>;
/** POST /api/presets, PATCH (partial): any other key (`permissionMode`, `runner`, …) is 400. */
export const PresetInput = Preset.pick({ name: true, text: true }).strict();
export type PresetInput = z.infer<typeof PresetInput>;
export const PresetList = z.object({ presets: z.array(Preset) });
export type PresetList = z.infer<typeof PresetList>;
/** POST /api/presets/:id/expand: the workspace to send in and the Issue / PR (`12`, `#12`, `owner/name#12`, its URL). */
export const PresetExpandInput = z.object({ workspaceId: z.string().optional(), target: z.string().optional() }).strict();
export type PresetExpandInput = z.infer<typeof PresetExpandInput>;
/** The text to put in the request / reply box as it will be sent; `target` = `owner/name#n`, null when not used. */
export const PresetExpansion = z.object({ title: z.string(), text: z.string(), repo: z.string().nullable(), target: z.string().nullable() });
export type PresetExpansion = z.infer<typeof PresetExpansion>;
export type AskAnswerResult = z.infer<typeof AskAnswerResult>;
/** 409's body: the question changed since it was shown — what changed, and the question now (null = none waits). */
export const AskChanged = z.object({ error: z.string(), changes: z.array(z.string()), current: Ask.nullable() });
export type AskChanged = z.infer<typeof AskChanged>;

/**
 * What changed since the previous stop of the same work + op + target (#939): a new answer, a condition that came to be
 * met, a condition whose value moved, or a different cause (another reason, or for `unknown` other evidence).
 */
export const StopChange = z.object({ kind: z.enum(["answer", "condition-met", "condition", "cause"]), detail: z.string() });
export type StopChange = z.infer<typeof StopChange>;

/**
 * What the work needs next (#939): none = it went on; resume = an answer / condition changed, so going on once is due;
 * wait = nothing to do until a condition changes (no new question, no 「続けて」); retry = a bounded retry is running;
 * decide = the person has to answer (retries used up, or a reason only a person can fix — auth / permission / input /
 * decision / unknown — that has no answer of its own yet: an answer counts for the stop that was newest when it was
 * given). A new cause of such a reason is always asked; one that time or a condition fixes waits.
 */
export const StopNext = z.enum(["none", "resume", "wait", "retry", "decide"]);
export type StopNext = z.infer<typeof StopNext>;

/**
 * One series of stops (#939): the stops with the same key (`stopKey`), told from the daemon's `stop.record` events.
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
  /** The newest stop's grant (#2745). */
  grant: z.string().nullable(),
  conditions: z.array(StopCondition),
  actions: StopRecord.shape.actions,
  changes: z.array(StopChange),
  unchanged: z.boolean(),
  next: StopNext,
});
export type StopSummary = z.infer<typeof StopSummary>;

/** One session log the daemon follows (#91): which task it feeds and how far it has been read. */
export const HistorySession = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  origin: TaskOrigin,
  /** Absolute path of the `.jsonl` under the Claude projects folder. */
  path: z.string(),
  /** The same with the daemon user's home shortened to `~` (the browser does not know homedir()). */
  pathDisplay: z.string(),
  /** Bytes of the file already imported. */
  offset: z.number(),
  importedAt: z.number(),
});
export type HistorySession = z.infer<typeof HistorySession>;

export const HistoryScanResult = z.object({
  ts: z.number(),
  /** `.jsonl` files seen. */
  files: z.number(),
  /** Terminal sessions that became new tasks. */
  created: z.number(),
  /** Files whose new records were appended to an existing task. */
  appended: z.number(),
  /** Files whose cwd is under no registered workspace (add the workspace and they come in on the next pass). */
  skippedForeign: z.number(),
  /** Files written only by an SDK host (Switchboard or another program) that no task claims. */
  skippedOtherHost: z.number(),
  errors: z.array(z.string()),
});
export type HistoryScanResult = z.infer<typeof HistoryScanResult>;

export const HistoryStatus = z.object({
  dir: z.string(),
  /** The folder exists (Claude Code has been used on this machine). */
  enabled: z.boolean(),
  /** Interval between passes; 0 = only at boot and on request. */
  pollMs: z.number(),
  lastScanAt: z.number().nullable(),
  lastResult: HistoryScanResult.nullable(),
  sessions: z.array(HistorySession),
});
export type HistoryStatus = z.infer<typeof HistoryStatus>;

/** The runner's own login (#180): `ok`, `expired` (its status command or the last turn said not logged in), `unknown`. */
export const RunnerLogin = z.enum(["ok", "expired", "unknown"]);
export type RunnerLogin = z.infer<typeof RunnerLogin>;

/** Which login is in use (#2528): `claude.ai` = a Claude account, `console` = an Anthropic Console account. Only from `claude auth status`'s `authMethod`; no account name, email or organization. */
export const LoginKind = z.enum(["claude.ai", "console", "bedrock"]);
export type LoginKind = z.infer<typeof LoginKind>;

export const RunnerInfo = z.object({
  id: RunnerId,
  available: z.boolean(),
  version: z.string().optional(),
  path: z.string().optional(),
  note: z.string().optional(),
  /** Modes the runner offers (empty = no knob; DAK). */
  permissionModes: z.array(PermissionModeOption).default([]),
  /** Effective default for new tasks: the saved setting, else the adapter's default. */
  defaultPermissionMode: z.string().optional(),
  /** Tasks of this runner stopped on the usage limit are resumed by the daemon once it lifts (#102). */
  autoResume: z.boolean().optional(),
  /** Models the runner offers (#155; empty = the runner decides itself; DAK). */
  models: z.array(ModelOption).default([]),
  /** Thinking efforts the runner offers (#833; empty = the runner decides itself; DAK). */
  efforts: z.array(ModelOption).default([]),
  /** What the CLI runs a task on when its model is left empty (the user's own CLI setting); absent = not known. */
  cliDefaultModel: z.string().optional(),
  /** Absent = the runner has no login of its own (DAK). */
  login: RunnerLogin.optional(),
  /** Which login `login: "ok"` is (#2528); absent = not known (an older CLI, another runner, or not logged in). `bedrock` = the user chose Amazon Bedrock in the settings (#1730). */
  loginKind: LoginKind.optional(),
  /** The runner can run on Amazon Bedrock (it has `bedrockModels`, #1730). */
  bedrockAvailable: z.boolean().default(false),
  /** What to type in a terminal tab to log in again. */
  loginHint: z.string().optional(),
});
export type RunnerInfo = z.infer<typeof RunnerInfo>;

/**
 * Where "continue locally" is for a Cloud Task (#1306): the official Teleport running, waiting for the person's answer
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
 * What Claude Code in a Task's terminal tab says it is doing (OSC 7501, #1574): working, waiting for the person
 * (a permission or a dialog), or done with its turn. Memory only, never stored.
 */
export const TerminalStatus = z.enum(["working", "waiting", "done"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/**
 * A Task waiting for an approval elsewhere (#662, docs/design/device-auth.md): the URL and one-time code a command
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

/**
 * Where an open request or PBI of the meta workspace's GitHub backlog stands (#264). Read from GitHub on request, never
 * stored: `request` = a request with no derived PBI yet, `needs-tasks` = a PBI not yet Ready (Project Status Backlog or
 * unset), `ready`, `in-progress` = In progress / In review, `needs-decision` = labelled `needs-decision` (wins over the rest).
 */
export const BacklogStage = z.enum(["request", "needs-tasks", "ready", "in-progress", "needs-decision"]);
export type BacklogStage = z.infer<typeof BacklogStage>;

/**
 * How one prerequisite or wait of a PBI stands (#937), judged from the stored records each time they are read: `met` =
 * done (an Issue closed as completed, a PR merged, and for `need: "release"` its merge commit in the running release);
 * `pending` = not yet (open, Draft too, or merged but not released); `withdrawn` = closed without being done (NOT_PLANNED
 * / DUPLICATE, a PR closed unmerged); `missing` = not stored (404, or never read); `cycle` = it waits back on the PBI;
 * `unknown` = cannot be judged here (a release that cannot be checked). Only `met` lets the PBI go on.
 */
export const BacklogPrereqState = z.enum(["met", "pending", "withdrawn", "missing", "cycle", "unknown"]);
export type BacklogPrereqState = z.infer<typeof BacklogPrereqState>;

/**
 * How a stored Issue (or a workspace's whole backlog) stands against GitHub (#908): `synced` = nothing waits to be sent
 * and the last read was complete; `pending` = an edit is stored here and not (known to be) sent; `conflict` = an edit is
 * held until chosen on; `error` = it cannot be told or sent (an import failed, GitHub no longer shows it, an edit was refused).
 */
export const BacklogSyncState = z.enum(["synced", "pending", "conflict", "error"]);
export type BacklogSyncState = z.infer<typeof BacklogSyncState>;

/**
 * Why a state is not `synced` and not just "waiting to send": `failed` = an edit GitHub refused, `unknown` = a post whose
 * answer was lost (looked for before it is sent again), `unavailable` / `forbidden` = GitHub answered 404 / 403 for it,
 * `unfetched` = never read in full, `import` = the last import of the workspace failed or is held back until `retryAt`.
 */
export const BacklogSyncReason = z.enum(["failed", "unknown", "unavailable", "forbidden", "unfetched", "import"]);
export type BacklogSyncReason = z.infer<typeof BacklogSyncReason>;

/** A held conflict as the list shows it: the three values of `BacklogHeldEdit.conflict`, with the field and the revision a choice names. */
export const BacklogSyncConflict = z.object({ field: z.string().nullable(), base: z.unknown(), local: z.unknown(), remote: z.unknown(), remoteRead: z.boolean(), revision: z.string() });
export type BacklogSyncConflict = z.infer<typeof BacklogSyncConflict>;

/**
 * The sync of one Issue or one workspace (#908). `lastSuccessfulSync` = when it was last read in full (ms; null = never —
 * a failed read never moves it); `retryAt` = GitHub is not asked before this (ms); `pendingCount` = edits stored here, not
 * done; `guarantee` = what a send promises: "A" = checked against GitHub just before and after each write.
 */
export const BacklogSyncInfo = z.object({
  state: BacklogSyncState,
  reason: BacklogSyncReason.nullable(),
  lastSuccessfulSync: z.number().nullable(),
  retryAt: z.number().nullable(),
  pendingCount: z.number(),
  conflicts: z.array(BacklogSyncConflict),
  guarantee: z.literal("A"),
});
export type BacklogSyncInfo = z.infer<typeof BacklogSyncInfo>;

/**
 * A prerequisite a PBI or one of its open Tasks names on its `**前提**:` line (#937). `kind` null = not stored; `need` =
 * what makes it met (`done` an Issue, `merged` a PR, `release` with `（リリース）`); `via` = the Task that names it, null
 * for the PBI's own.
 */
export const BacklogPrereq = z.object({ number: z.number(), kind: z.enum(["issue", "pr"]).nullable(), need: z.enum(["done", "merged", "release"]), state: BacklogPrereqState, via: z.number().nullable() });
export type BacklogPrereq = z.infer<typeof BacklogPrereq>;

export const BacklogItem = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  type: z.enum(["request", "pbi"]),
  stage: BacklogStage,
  /** Project fields; null when the Issue is not in the Project or the field is unset. */
  priority: z.string().nullable(),
  storyPoints: z.number().nullable(),
  createdAt: z.string(),
  /**
   * Sub-issues (Tasks) of a PBI; null for a request. `doneAt` = the newest `updatedAt` of the closed sub-issues (ISO), null
   * when none is closed (#1051).
   */
  tasks: z.object({ total: z.number(), done: z.number(), doneAt: z.string().nullable() }).nullable(),
  /**
   * The open question of a needs-decision item (#266); always null until then. `issue` = the Issue it is asked on: the item
   * itself, or an open Task of an in-progress PBI (#562) — the answer is written there.
   */
  decision: z.object({ body: z.string(), at: z.string(), issue: z.number() }).nullable(),
  /** The newest `## 回答` on an in-progress PBI or its Tasks (#562); null for the other stages or when there is none. */
  answeredAt: z.string().nullable(),
  /** The `## 保留` newer than the item's `## 判断待ち`, on the Issue asked on (#936); null when none (or not needs-decision). */
  heldAt: z.string().nullable(),
  /** A running / waiting stage Task started for this Issue (its title starts with "#<number> "; #265); null when none. */
  activeTaskId: z.string().nullable(),
  /** The Project's Status by name (In progress / In review / …; #522); null when the Issue is not in the Project or it is unset. */
  projectStatus: z.string().nullable(),
  /** When the Issue was last updated on GitHub (ISO string). */
  updatedAt: z.string(),
  /**
   * The newest-created stage Task of this Issue in any state (#522); a finished one's `updatedAt` is when it finished.
   * `action` = the stage named in its title (#624); null when the title names none.
   * `outcome` / `reviewedAt` (#492) and `resumeAt` (a usage-limit stop's planned resume) are the Task's own, so backlog-next
   * can leave an item whose Task ended asking the person or could not run (#1275).
   */
  lastTask: z.object({ id: z.string(), status: TaskStatus, statusAt: z.number(), createdAt: z.number(), updatedAt: z.number(), action: BacklogAction.nullable(), outcome: TaskOutcome, reviewedAt: z.number().nullable(), resumeAt: z.number().nullable() }).nullable(),
  /**
   * Its last stage Task waits for the person's reply (#1619): `awaitingReply` (#1275), or that Task's newest stop series
   * is `next = "decide"`. The daemon adds it (withActive), not stored.
   */
  replyWaiting: z.boolean(),
  /** The newest `## 状況` comment of an in-progress item (#522); always null for the other stages. */
  report: z.object({ body: z.string(), at: z.string() }).nullable(),
  /**
   * The acceptance criteria of an In progress / In review PBI still waiting on the user's own check (#523): unchecked lines
   * of `## 到達点 / 受け入れ条件` outside fences with `（利用者確認: …）`. `n` = the line's number among all the section's
   * checkbox lines (checked ones too, from 1); `text` = the line after `- [ ] `. Empty for the other items.
   */
  confirmations: z.array(z.object({ n: z.number(), text: z.string() })),
  /** An in-progress PBI whose Tasks are all closed and with no confirmation left (#523): its row offers 閉じる. */
  closable: z.boolean(),
  /**
   * What a Ready / in-progress PBI stopped to wait for (#817): the PRs / Issues of the same repository named by its newest
   * /pbi-complete release, with whether each is still open. Deferred PRs and explicitly recorded overlap waits on decision Tasks are excluded. Empty when there is no such record, a later one cleared it,
   * the item is not a Ready / in-progress PBI, or an 実装 (`complete`) stage Task was created after `waitsAt` (the daemon empties it then).
   * #1046: `open` null = its state could not be read (not stored; `kind` is then "issue"), neither open nor closed, and it
   * still holds the PBI. `reason` = why the release named it: "overlap" (`--overlap-waits`, the files overlap) or
   * "prerequisite" (`--waits`, a Task it builds on is not done; a `waits=` written before `--overlap-waits` existed may
   * have been an overlap too — held until closed either way). `pbi` (#1183) = the PBI that moves the wait forward: an
   * Issue's own number when it is a PBI, else its parent; a PR's from the Issues it closes (`closes`), the first that
   * gives one. `title` null = that PBI is not stored; `pbi` null = none found (不明). Its stage Task is read from that
   * PBI's own item in the same answer (`activeTaskId` / `lastTask`), not copied here.
   * #937: `state` = how it stands (BacklogPrereqState): an overlap is met once closed, a prerequisite once done (a PR
   * closed unmerged or an Issue closed as not planned is `withdrawn`, and holds). `open` follows it: false = met, true =
   * pending, null = anything else.
   */
  waits: z.array(z.object({ number: z.number(), kind: z.enum(["issue", "pr"]), open: z.boolean().nullable(), state: BacklogPrereqState, reason: z.enum(["overlap", "prerequisite"]), pbi: z.object({ number: z.number(), title: z.string().nullable() }).nullable() })),
  /**
   * What a Ready / in-progress PBI's open Tasks touch that other work touches too (#1044), judged from the stored records
   * (an open PR's files, an In progress Task's body) by the rule of scripts/parallel-guard.ts. `hits` = the other side's
   * `ref` (`PR #n` / `Task #m`) and its `path`; `unknown` = why it cannot be judged (a PR's files are not all stored).
   * null = not judged (not such a PBI, no path named) or no overlap.
   */
  overlap: z.object({ hits: z.array(z.object({ ref: z.string(), path: z.string() })), unknown: z.string().nullable() }).nullable(),
  /** When that release was written (ISO string); retained when deferred waits are filtered out so the item can resume, null when no release applies. Compared with an 実装 stage Task's creation time. */
  waitsAt: z.string().nullable(),
  /**
   * The prerequisites of a Ready / in-progress PBI (#937): those its body names, and those its open Tasks name outside
   * the PBI when every open Task has one not met (one Task free to go lets the PBI go on). Empty for the other items.
   */
  prereqs: z.array(BacklogPrereq),
  /** The stops of the Issue's stage Tasks, one per series (#948); empty until the daemon adds them. */
  stopSummary: z.array(StopSummary),
  /** The Task a PBI's body names on its `**画面イメージ**:` line outside fences, the first id in it (#2296); null for a request or no line. */
  mockupTask: z.string().nullable(),
  /** That Task's screen mockups (#2296): its HTML artifacts, not removed, as a question's `mockups` (#2221); empty until the daemon adds them. */
  mockups: z.array(Artifact),
  /** How this Issue stands against GitHub (#908); what a start (#909) is judged on, not only shown. */
  sync: BacklogSyncInfo,
  /** The registered workspace whose repository the Issue is in (#294). */
  workspaceId: z.string(),
  workspaceName: z.string(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

/** `workspaceId`: the registered workspace whose repository the Issue is in (#n is per repository). */
export const BacklogStartInput = z.object({ workspaceId: z.string(), action: BacklogAction });
export type BacklogStartInput = z.infer<typeof BacklogStartInput>;

/**
 * The user's answer to a needs-decision item (#266): written on the Issue as `## 回答` + text. `issue`: the Issue of the
 * question on screen (`decision.issue`, #562); the answer is refused when the item now asks on another one.
 * `confirm` (#523): the answer to confirmation `n` of the item's `confirmations` instead — `ok` checks that line of the
 * PBI's body, otherwise `text` is the reason it is not right (required then).
 */
export const BacklogAnswerInput = z
  .object({
    workspaceId: z.string(),
    text: z.string().trim().max(20_000).default(""),
    issue: z.number().int().positive().optional(),
    confirm: z.object({ n: z.number().int().positive(), ok: z.boolean() }).optional(),
  })
  .refine((a) => a.confirm?.ok || a.text.length > 0, { message: "text is required", path: ["text"] });
export type BacklogAnswerInput = z.infer<typeof BacklogAnswerInput>;

/** A plain comment on a stored Issue (#910), kept here and sent later like an answer — without an answer's label change. */
export const BacklogCommentInput = z.object({ workspaceId: z.string(), text: z.string().trim().min(1).max(20_000) }).strict();
export type BacklogCommentInput = z.infer<typeof BacklogCommentInput>;

/** `POST /api/backlog/sync` (#918): the workspace whose stored backlog is brought up to date. */
export const BacklogSyncInput = z.object({ workspaceId: z.string() }).strict();

/**
 * What a backlog error asks of the owner (#2362), decided where gh was called (not read back from its wording):
 * `gh-login` = gh is not logged in or its login was refused, `project-var` = the repository variable holding the
 * Project URL is missing, `other` = anything else (a limit, no directory, …; its message says it).
 */
export const BacklogErrorKind = z.enum(["gh-login", "project-var", "other"]).default("other");
export type BacklogErrorKind = z.infer<typeof BacklogErrorKind>;

export const Backlog = z.object({
  /**
   * When the stored backlog was imported from GitHub (ms; #885): the oldest of the GitHub-synced workspaces shown, now
   * when none ever was. A workspace kept only here (`backlog: "switchboard"`) is not counted: it is not read from GitHub.
   */
  fetchedAt: z.number(),
  items: z.array(BacklogItem),
  /**
   * Workspaces whose last import failed or that were never imported (#294, #885): the reason. What a workspace had
   * stored still comes; one never imported has no items — never an empty list as if read.
   */
  errors: z.array(z.object({ workspaceId: z.string(), workspaceName: z.string(), message: z.string(), kind: BacklogErrorKind })).default([]),
  /** Each workspace's sync (#885): an import under way, and when the last complete one was stored (null = never). */
  syncs: z.array(z.object({
    workspaceId: z.string(),
    /** Whether its backlog syncs with GitHub (#2266): the same values as `Workspace.backlog`. */
    backlog: z.enum(["github", "switchboard"]),
    /** Turning its GitHub sync on (#2266): the Issues made here only to make on GitHub, and those made; null = not under way. */
    enabling: z.object({ total: z.number(), done: z.number() }).nullable(),
    /** The repository its stored backlog is of (`owner/name`, #918: the kit's `backlog` finds the workspace by it); null = never imported. */
    repository: z.string().nullable(),
    syncing: z.boolean(),
    syncedAt: z.number().nullable(),
    /** The workspace as a whole (#908): the worst of its Issues', or an import that failed / never ran. */
    sync: BacklogSyncInfo,
    /** Issues made here that GitHub has not numbered yet (#886): no number to start a stage on. */
    creates: z.array(z.object({ localId: z.string(), title: z.string(), state: BacklogSyncState })).default([]),
    /** Numbered Issues that hold operations not sent (#1872), Closed ones too: opened from the sync line to be resolved. */
    issues: z.array(z.object({
      number: z.number(), title: z.string(), url: z.string(), closed: z.boolean(),
      state: BacklogSyncState, pendingCount: z.number(), conflictCount: z.number(),
    })).default([]),
  })).default([]),
});
export type Backlog = z.infer<typeof Backlog>;

/** GET /api/asks (#935): the open questions, and those answered / resolved within the last day. `errors` = the backlog's. */
export const AskList = z.object({ fetchedAt: z.number(), asks: z.array(Ask), errors: Backlog.shape.errors });
export type AskList = z.infer<typeof AskList>;

/**
 * Where a stored backlog record comes from (#885): one repository of one service. The Issue number alone is not an id —
 * two repositories have a #12 each. `repository` is `owner/name` as GitHub spells it (`gh repo view`'s nameWithOwner):
 * GitHub ignores case there, the key does not.
 */
/** `service`: `github`, or `switchboard` = a workspace whose backlog is kept here only (#2265; `repository` = the workspace id). */
export const BacklogRepositoryKey = z.object({ service: z.enum(["github", "switchboard"]), host: z.string(), repository: z.string() });
export type BacklogRepositoryKey = z.infer<typeof BacklogRepositoryKey>;

/**
 * What a stored record is (#885): an Issue, one comment of one, an Issue's item in a Project, or a pull request a PBI
 * waits for (#817).
 */
export const BacklogObjectKind = z.enum(["issue", "comment", "project-item", "pull-request"]);
export type BacklogObjectKind = z.infer<typeof BacklogObjectKind>;

/**
 * How the last import left a record (#885): `fetched` = read in full; `unfetched` = needed but not read yet (an empty
 * answer is not this); `unavailable` = GitHub answered 404 (gone or hidden — not a proof of deletion); `forbidden` = 403.
 * A record that is not `fetched` keeps the `remote` it had.
 */
export const BacklogFetchState = z.enum(["fetched", "unfetched", "unavailable", "forbidden"]);
export type BacklogFetchState = z.infer<typeof BacklogFetchState>;

/** An Issue as stored (#885): body (Markdown) and the standard fields; `parent` / `subIssues` are Issue numbers of the same repository. */
export const BacklogIssueData = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  /** How it was closed (#937): COMPLETED is done; NOT_PLANNED / DUPLICATE are withdrawn. null = never read (made here). */
  stateReason: z.enum(["COMPLETED", "NOT_PLANNED", "DUPLICATE", "REOPENED"]).nullable(),
  body: z.string(),
  labels: z.array(z.string()),
  milestone: z.string().nullable(),
  parent: z.number().nullable(),
  subIssues: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When it was closed (#651); null = open, never read, or stored before this was kept (the next import fills it). */
  closedAt: z.string().nullable(),
});
export type BacklogIssueData = z.infer<typeof BacklogIssueData>;

export const BacklogCommentData = z.object({ issue: z.number(), body: z.string(), createdAt: z.string() });
export type BacklogCommentData = z.infer<typeof BacklogCommentData>;

/**
 * An Issue's item in a Project (#885): the field values by field name (Status, Priority, Story Points, …). A Project
 * number is unique per owner only, so `owner` (its login) comes with it.
 */
export const BacklogProjectItemData = z.object({ issue: z.number(), owner: z.string(), project: z.number(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])) });
export type BacklogProjectItemData = z.infer<typeof BacklogProjectItemData>;

/**
 * A pull request as stored (#885): what a PBI's wait reads (#817) and, for an open one, what it changes (#1059): `updatedAt` and `files` (the changed paths; null = more than the 100 read, i.e. not fully known, never "no files"). `closes` (#1183) = the Issues it closes, read
 * from its body's `Closes #n` and its branch `sb/<n>-` (no duplicates, ascending); the body and branch are not stored.
 */
export const BacklogPullRequestData = z.object({ number: z.number(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), labels: z.array(z.string()), closes: z.array(z.number()), mergeCommit: z.string().nullable(), updatedAt: z.string(), files: z.array(z.string()).nullable(), closedAt: z.string().nullable(), mergedAt: z.string().nullable() });
export type BacklogPullRequestData = z.infer<typeof BacklogPullRequestData>;

/**
 * One stored record (#885). `externalId` = the service's id of the object (a node id). `remote` = what the service last
 * answered, `base` = the value both sides agreed on at the last sync, `local` = an edit not sent yet (null = none);
 * null `remote` / `base` = never read. `fetchedAt` = when `remote` was read (ms).
 */
const record = <K extends BacklogObjectKind, D extends z.ZodTypeAny>(kind: K, data: D) =>
  BacklogRepositoryKey.extend({
    objectKind: z.literal(kind),
    externalId: z.string(),
    remote: data.nullable(),
    base: data.nullable(),
    local: data.nullable(),
    fetchedAt: z.number().nullable(),
    fetchState: BacklogFetchState,
  });
export const BacklogRecord = z.discriminatedUnion("objectKind", [record("issue", BacklogIssueData), record("comment", BacklogCommentData), record("project-item", BacklogProjectItemData), record("pull-request", BacklogPullRequestData)]);
export type BacklogRecord = z.infer<typeof BacklogRecord>;

/**
 * A repository's sync state (#885): `cursor` = where the next incremental read starts, `lastSuccessfulSync` = when the
 * last complete import was stored (ms), `retryAt` = not before this (a limit or an outage); null = never / none.
 */
export const BacklogRepositorySync = BacklogRepositoryKey.extend({ cursor: z.string().nullable(), lastSuccessfulSync: z.number().nullable(), retryAt: z.number().nullable() });
export type BacklogRepositorySync = z.infer<typeof BacklogRepositorySync>;

/**
 * Where a workspace's backlog comes from (#885): its repository and the Project it reads (`projectVar` /
 * SWITCHBOARD_PROJECT_URL; a Project number is unique per owner only). Written by each import, so the stored backlog is
 * read without asking GitHub which repository the checkout is. `disabled`: the workspace's GitHub sync is off (#2266) —
 * its records stay under this key and nothing reads or writes GitHub's Issues or Project until it is on again.
 * `enabling` / `numbers`: turning it on (backlog-enable.ts).
 */
export const BacklogSource = BacklogRepositoryKey.extend({
  project: z.object({ owner: z.string(), number: z.number() }),
  disabled: z.literal(true).optional(),
  /**
   * Its GitHub sync being turned on (#2266): since when; the Issues made here only are being made on GitHub. `queued`:
   * all are, and their bodies, parents and comments (with `#N` rewritten to GitHub's numbers) are being sent.
   */
  enabling: z.object({ since: z.number(), queued: z.literal(true).optional() }).optional(),
  /** The Issues made on GitHub by turning it on (#2266): their number here (`from`) and GitHub's (`to`). */
  numbers: z.array(z.object({ from: z.number(), to: z.number() })).optional(),
  /**
   * Whether GitHub says the repository is private, written by each import. The host's rebuild checks a clone against it
   * and `repository` (#2799): a renamed repository's old name may now be a public one.
   */
  private: z.boolean().optional(),
});
export type BacklogSource = z.infer<typeof BacklogSource>;

/**
 * An edit of an Issue held, not sent (#887): a `conflict` (GitHub's value moved off the one it was made on), `failed`
 * (refused: a permission, an input) or `unknown` (a post whose answer was lost). `reason` = why, as the last check
 * said; `updatedAt` = when (ms). A conflict carries the three values: `base` = the value the edit was made on, `local`
 * = the edit's, `remote` = GitHub's as last imported (`remoteRead` false: not read, then `remote` is null), and the
 * `revision` a choice on it names (PATCH `resolve`).
 */
export const BacklogHeldEdit = z.object({
  operation: z.string(),
  kind: z.enum(["create", "set", "comment"]),
  field: z.string().nullable(),
  status: z.enum(["conflict", "failed", "unknown"]),
  reason: z.string().nullable(),
  updatedAt: z.number(),
  conflict: z.object({ base: z.unknown(), local: z.unknown(), remote: z.unknown(), remoteRead: z.boolean(), revision: z.string() }).nullable(),
});
export type BacklogHeldEdit = z.infer<typeof BacklogHeldEdit>;

/**
 * One stored Issue (#885, `GET /api/backlog/:number`): its body and fields, every stored comment (oldest first) and its
 * fields in the workspace's Project (null = not in it). `fetchedAt` = when it was last read; `fetchState` = how.
 */
export const BacklogIssueDetail = z.object({
  workspaceId: z.string(),
  issue: BacklogIssueData,
  /** `id`: the stored record's id (#2265; GitHub's comment id, or `sb:<seq>` on a backlog kept here) — the order the parallel guard decides who came first by. */
  comments: z.array(BacklogCommentData.extend({ id: z.string() })),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
  fetchedAt: z.number().nullable(),
  fetchState: BacklogFetchState,
  /** An Issue made here (#886): the id it is read and edited by before GitHub gives it a number (0 until then), and after. */
  localId: z.string().nullable().default(null),
  /** Edits of it not sent to GitHub yet (#886). */
  pending: z.number().default(0),
  /** Those of them held (#887): not sent until chosen on (a conflict) or looked into. */
  held: z.array(BacklogHeldEdit).default([]),
  /** How this Issue stands against GitHub (#908), as its row in the list tells. */
  sync: BacklogSyncInfo,
  /** What the check before and after a send can and cannot keep (#887, 初期方式 A). */
  limits: z.string(),
});
export type BacklogIssueDetail = z.infer<typeof BacklogIssueDetail>;

const fieldValue = z.union([z.string(), z.number(), z.null()]);
const issueText = { title: z.string().trim().min(1).max(256), body: z.string().max(65_536) };

/**
 * An edit of one stored Issue (`PATCH /api/backlog/:number`, #886), kept here and sent to GitHub later: only the fields
 * given change. `labels` adds / removes names; `project` puts it in the workspace's Project or takes it out, `fields`
 * sets that Project's fields by name. An unknown key is refused.
 */
export const BacklogEditInput = z
  .object({
    workspaceId: z.string(),
    title: issueText.title.optional(),
    body: issueText.body.optional(),
    labels: z.object({ add: z.array(z.string().min(1)).default([]), remove: z.array(z.string().min(1)).default([]) }).strict().optional(),
    state: z.enum(["OPEN", "CLOSED"]).optional(),
    milestone: z.string().min(1).nullable().optional(),
    parent: z.number().int().positive().nullable().optional(),
    project: z.boolean().optional(),
    fields: z.record(z.string().min(1), fieldValue).optional(),
    /**
     * A choice on a held conflict (#887) instead of an edit: `field` as the held edit names it, `local` = send the value
     * made here (on GitHub's), `remote` = keep GitHub's; `expectedRevision` = the conflict's `revision` as read.
     */
    resolve: z.object({ field: z.string().min(1), choice: z.enum(["local", "remote"]), expectedRevision: z.string().min(1) }).strict().optional(),
  })
  .strict()
  .refine((e) => !e.resolve || Object.keys(e).every((k) => k === "workspaceId" || k === "resolve"), { message: "resolve は編集と一緒には送れません" });
export type BacklogEditInput = z.infer<typeof BacklogEditInput>;

/** A new Issue (`POST /api/backlog`, #886), kept here and created on GitHub later; `fields` puts it in the workspace's Project. */
export const BacklogCreateInput = z
  .object({
    workspaceId: z.string(),
    title: issueText.title,
    body: issueText.body.default(""),
    labels: z.array(z.string().min(1)).default([]),
    milestone: z.string().min(1).nullable().default(null),
    parent: z.number().int().positive().nullable().default(null),
    fields: z.record(z.string().min(1), fieldValue).nullable().default(null),
  })
  .strict();
export type BacklogCreateInput = z.infer<typeof BacklogCreateInput>;

/**
 * The stages of a PBI's way from the request to its close (#650), each cut by marks the skills always leave (Issue / PR
 * times, the Task's claim comment, the `[codex|claude|dak] review` comment) — not by the Project's Status, whose changes
 * through the API leave no event. docs/design/flow-metrics.md.
 */
export const FlowStage = z.enum(["request", "split", "wait", "build", "review-wait", "review", "close"]);
export type FlowStage = z.infer<typeof FlowStage>;

/** One closed PBI's flow. A stage is ms, or null when a mark it needs is missing (never guessed). */
export const FlowPbi = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  storyPoints: z.number().nullable(),
  closedAt: z.string(),
  stages: z.record(FlowStage, z.number().nullable()),
  /** Sum of `## 判断待ち` → the next `## 回答` on the PBI and its Tasks (ms). */
  userWaitMs: z.number(),
  /** Per PR: how many `[codex|claude|dak] review` comments it got. */
  reviewRounds: z.array(z.number()),
  /** The Switchboard Tasks whose title starts with `#<PBI or Task number> `; null when the DB was not read. */
  tasks: z.object({ count: z.number(), runMs: z.number(), costUsd: z.number() }).nullable(),
});
export type FlowPbi = z.infer<typeof FlowPbi>;

/** A stage over the PBIs closed in a period: median / p90 of the known times (ms) and how many PBIs had one. */
export const FlowStageSummary = z.object({ p50: z.number().nullable(), p90: z.number().nullable(), count: z.number() });
export type FlowStageSummary = z.infer<typeof FlowStageSummary>;

export const FlowSummary = z.object({
  stages: z.object({ request: FlowStageSummary, split: FlowStageSummary, wait: FlowStageSummary, build: FlowStageSummary, "review-wait": FlowStageSummary, review: FlowStageSummary, close: FlowStageSummary }),
  /** The stage with the largest median; null when no stage is known. */
  bottleneck: FlowStage.nullable(),
  closed: z.number(),
  storyPoints: z.number(),
});
export type FlowSummary = z.infer<typeof FlowSummary>;

/**
 * `GET /api/flow` (#651): the last `days` days and the `days` before, over every registered workspace's repository, and
 * the five PBIs of the period that took longest (the sum of their known stages). A workspace GitHub could not be read for
 * is in `errors`; the others are still answered. A workspace with no imported repository is named in `unread`. Held in memory for an hour (`fetchedAt`), never stored.
 */
export const FlowView = z.object({
  days: z.number(),
  fetchedAt: z.number(),
  current: FlowSummary,
  previous: FlowSummary,
  slowest: z.array(FlowPbi),
  errors: z.array(z.object({ workspace: z.string(), message: z.string() })),
  /** Workspaces with no imported repository (never imported, or no GitHub one): their PBIs are not in the numbers. */
  unread: z.array(z.string()),
});
export type FlowView = z.infer<typeof FlowView>;

/**
 * A person's intervention (#651), counted from Switchboard's records and the stored copy of the Issues — not kept as a table:
 * `approval` (a tool or question the person allowed / denied), `decision` (a `## 回答` on an Issue, a later message to a Task),
 * `resume` (a stage Task started by the button). `ref` points at the record: `comment:<node id>` / `task:<id>#seq:<n>` /
 * `task:<id>`. `afterWaits` is for a resume only: true = the PBI waited for something (a /pbi-complete release with `waits=`)
 * and all of it was closed before this start, false = it did not or something was still open, null = not known (a record missing).
 */
export const Intervention = z.object({
  kind: z.enum(["approval", "decision", "resume"]),
  at: z.number(),
  workspaceId: z.string(),
  issue: z.number().nullable(),
  pbi: z.number().nullable(),
  taskId: z.string().nullable(),
  ref: z.string(),
  afterWaits: z.boolean().nullable(),
});
export type Intervention = z.infer<typeof Intervention>;

/** What could not be counted (#651): shown as 不明, never as 0. `issue` null = the whole workspace. */
export const InterventionUnknown = z.object({ workspaceId: z.string(), issue: z.number().nullable(), why: z.string(), /** The PBI it belongs to when the Issue says so but the PBI is not stored. */ pbi: z.number().optional() });
export type InterventionUnknown = z.infer<typeof InterventionUnknown>;

/** Why people were needed (#651): the stops of a period by reason, with the Issues and Tasks to look at. */
export const InterventionReason = z.object({
  reason: StopReasonCode,
  count: z.number(),
  /** Stops of this reason that did not go on by themselves: left exhausted or waiting, or a person intervened on the same Issue / Task after. */
  notAutoResumed: z.number(),
  /** The newest five. `url` is the Issue as stored; null when it names none or is not stored. */
  evidence: z.array(z.object({ workspaceId: z.string().nullable(), issue: z.number().nullable(), pbi: z.number().nullable(), taskId: z.string(), url: z.string().nullable(), evidence: z.string(), at: z.number() })),
});
export type InterventionReason = z.infer<typeof InterventionReason>;

/**
 * Interventions over `[from, to)` (ms) of `days` days (#651). `total` / `byKind` are the interventions in it; `unknown` is how
 * many places could not be counted at all (a workspace never imported, an Issue not stored): they have no time, so it is the
 * same in every window, and a count shown with it is "at least". `completed` is over the PBIs closed in the window (all their
 * interventions, however old); `open` / `done` split the window's interventions by whether their PBI is open or closed now.
 */
export const InterventionWindow = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  from: z.number(),
  to: z.number(),
  total: z.number(),
  byKind: z.object({ approval: z.number(), decision: z.number(), resume: z.number() }),
  unknown: z.number(),
  /** Stops that needed a person and stopped again after the person had answered the same one. */
  reAsks: z.number(),
  resumesAfterWaits: z.object({ count: z.number(), unknown: z.number() }),
  open: z.object({ pbis: z.number(), interventions: z.number() }),
  done: z.object({ pbis: z.number(), interventions: z.number() }),
  completed: z.object({ pbis: z.number(), perPbi: z.number().nullable(), unknownPbis: z.number() }),
  reasons: z.array(InterventionReason),
});
export type InterventionWindow = z.infer<typeof InterventionWindow>;

/** `GET /api/interventions` (#651): the last 7 and 30 days, each against the period before it. */
export const InterventionView = z.object({
  now: z.number(),
  windows: z.array(z.object({ current: InterventionWindow, previous: InterventionWindow })),
});
export type InterventionView = z.infer<typeof InterventionView>;
