import { z } from "zod";
import { RunnerId } from "../events.ts";
import { TaskOutcome, TaskStatus } from "./shared.ts";

/* ---------- Evals: what a task's record says about how it went ---------- */

/** Who wrote an eval row: the rule counter, the rubric judge, or the person. One row per task and source. */
export const EvalSource = z.enum(["rules", "judge", "human"]);
export type EvalSource = z.infer<typeof EvalSource>;

/** Counts over a task's events. Every number is over the whole task, not the last turn. */
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
  /** `stop.record` events, and how many of them per stop reason code. */
  stops: z.number(),
  stopReasons: z.record(z.string(), z.number()),
  /** The person's messages after the first one (follow-ups, steers), without the daemon's own resume messages. */
  userInstructions: z.number(),
  /** How the last finished turn ended; null when no turn finished. */
  lastEnd: z.enum(["ok", "error", "aborted"]).nullable(),
  /** `status` events that begin with the daemon-stop note: turns cut by the daemon stopping — an oomd kill, a host stop, a promotion — not the task's failure. */
  daemonStops: z.number(),
  /** Whether the last finished turn was cut by a daemon stop; its `lastEnd` is then the cut, not the task's. */
  lastCutByDaemon: z.boolean(),
  /** From the first event to the last (ms); null without events. */
  durationMs: z.number().nullable(),
  /**
   * Claude Code's auto-mode classifier: calls it let through (`classifier.decision` allow) and stopped (block, and
   * the asks it sent to the person, `permission.ask` reason classifier), the stopped ones per kind (a block's category,
   * `asked` for the asks). null = nothing recorded: not Claude, not Auto, or a runner that reports no such thing.
   */
  classifier: z.object({ allowed: z.number(), denied: z.number(), byCategory: z.record(z.string(), z.number()) }).nullable(),
  /**
   * Task ごとの実装のモデル: the model an 実装 Task handed each Task's implementation to, from the note it
   * started with — what was handed over, not what ran. null = none (同じ, another kind, a row counted before it).
   */
  delegatedModel: z.string().nullable().default(null),
});
export type RuleMetrics = z.infer<typeof RuleMetrics>;

/** The rule counter's row: the metrics, and what the task stood at when they were counted. */
export const RuleEval = z.object({
  metrics: RuleMetrics,
  status: TaskStatus,
  outcome: TaskOutcome,
  /** The task's ledger total at the time (API-equivalent USD). */
  costUsd: z.number(),
  /** The counter's version (`rules@2`): a change in what is counted bumps it, so old rows can be told apart. */
  by: z.string(),
  ts: z.number(),
});
export type RuleEval = z.infer<typeof RuleEval>;

/**
 * One criterion of a rubric: what the judge scores, with the wording for 1, 3 and 5 points so a lightweight
 * model has something concrete to compare the task against. `id` is the key under `JudgeEval.scores`.
 */
export const RubricCriterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  title: z.string().min(1),
  anchors: z.object({ "1": z.string(), "3": z.string(), "5": z.string() }),
});
export type RubricCriterion = z.infer<typeof RubricCriterion>;

/**
 * A rubric: the default ships with core (`rubric.default.json`); the person's own replaces it from
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
 * The rubric judge's row: a score per criterion the judge answered for (a criterion it left out is absent),
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
 * The person's answers to the four value questions, one matter each and each optional: was the intent of the request met,
 * did it add features, settings or layers nobody asked for (`complexity`), did it propose or build an alternative that leads
 * to no value (`detour`), were its outputs used (merged, adopted, used by the next stage). A row without them reads as before.
 */
export const HumanAnswers = z.object({
  intent: z.enum(["fit", "partial", "wrong", "unknown"]).optional(),
  complexity: z.enum(["none", "some", "unknown"]).optional(),
  detour: z.enum(["none", "some", "unknown"]).optional(),
  value: z.enum(["used", "unused", "unknown"]).optional(),
});
export type HumanAnswers = z.infer<typeof HumanAnswers>;

/**
 * The person's own evaluation of a task: one rating and a note. Optional — most tasks never get one, and the
 * list and its sums stand without it. Kept next to the judge's row so the two can be compared later.
 */
export const HumanEval = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000),
  by: z.literal("user"),
  ts: z.number(),
}).extend(HumanAnswers.shape);
export type HumanEval = z.infer<typeof HumanEval>;

/** `PUT /api/tasks/:id/evals/human` body. Strict: a key it does not know (the old `extra`) is a 400, not dropped. */
export const HumanEvalInput = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).default("") }).extend(HumanAnswers.shape).strict();
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
 * One line of the Evals list: the task as it stands (status / outcome / updatedAt from `tasks`, the cost from
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
  /** The auto-judge's result (`tasks.judged_result`), kept to be compared with `outcome` on the Evals list; null = not judged. */
  judgedResult: z.enum(["finished", "needs_action"]).nullable(),
  updatedAt: z.number(),
  costUsd: z.number(),
  /** As `TaskEvals.models`: the distinct `session.start` models in the order first used. Two or more = the model was changed mid-task. */
  models: z.array(z.string()),
  /** The distinct `session.start` efforts in the order first used. "" = the CLI's default (counted). [] = never started. Two or more = the effort was changed mid-task. */
  efforts: z.array(z.string()),
  /** The thinking depth the task's subagents started with (`tasks.subagent_effort`); null = not set. */
  subagentEffort: z.string().nullable(),
  rules: z.object({ toolCalls: z.number(), toolFailures: z.number(), errors: z.number(), userInstructions: z.number(), stops: z.number(), /** the stops whose reason is `decision`: with `userInstructions`, how often the person had to step in */ decisionStops: z.number(), lastEnd: z.enum(["ok", "error", "aborted"]).nullable(), daemonStops: z.number(), lastCutByDaemon: z.boolean() }).nullable(),
  /** `ts`: when the judge row was written (`task_evals.ts`) — the weekly sample picks by it. */
  judge: z.object({ average: z.number(), scores: z.record(z.string(), z.number()), rubric: z.string(), by: z.string(), ts: z.number() }).nullable(),
  human: z.object({ rating: z.number(), comment: z.string() }).extend(HumanAnswers.shape).nullable(),
});
export type EvalsListRow = z.infer<typeof EvalsListRow>;

/**
 * What a person needs to rate a task without opening its conversation. `request`: a stage Task's Issue read as the PBI
 * (the Issue itself when it is a PBI, its parent when it is a Task; null = not stored) with the first `## 元要望`
 * Issue's `## 要望` head (null = none); any other Task's first message, cut. `interventions`: the person's follow-up
 * instructions and the stops whose reason is `decision`. `outputs`: the pull requests, local changes and Issues the Task
 * opened, with their stored state (null = not in the workspace's copy); `pbiStatus`: a stage Task's PBI's Project Status
 * (null = not stored, or not a stage Task).
 */
export const EvalContext = z.object({
  request: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("stage"),
      pbi: z.object({ number: z.number(), title: z.string(), story: z.string(), outOfScope: z.string() }).nullable(),
      source: z.object({ number: z.number(), head: z.string() }).nullable(),
    }),
    z.object({ kind: z.literal("prompt"), text: z.string() }),
  ]),
  interventions: z.object({ userInstructions: z.number(), decisionStops: z.number() }),
  outputs: z.array(z.object({ kind: z.enum(["pr", "change", "issue"]), repo: z.string(), number: z.number(), title: z.string().nullable(), state: z.enum(["open", "merged", "closed"]).nullable() })),
  pbiStatus: z.string().nullable(),
});
export type EvalContext = z.infer<typeof EvalContext>;

/**
 * Where a closed request went wrong, as the person chose: nowhere (`none`), in how the request was read (`request`),
 * in how the PBIs were cut (`pbi`), in the implementation (`impl`) or in the report (`report`). Never guessed by a model.
 */
export const EvalStage = z.enum(["none", "request", "pbi", "impl", "report"]);
export type EvalStage = z.infer<typeof EvalStage>;
/** One or more stages, each once; `none` stands alone. */
const EvalStages = z.array(EvalStage).min(1).refine((s) => new Set(s).size === s.length && (!s.includes("none") || s.length === 1), "stages: each once, and none only by itself");

/** The person's evaluation of a closed request with its PBIs as one unit: the stages that went wrong, a rating and a note. One per request, the latest. */
export const RequestEval = z.object({ stages: EvalStages, rating: z.number().int().min(1).max(5), comment: z.string().max(1000), by: z.literal("user"), ts: z.number() });
export type RequestEval = z.infer<typeof RequestEval>;
/** `PUT /api/backlog/:number/evals/human` body. */
export const RequestEvalInput = z.object({ workspaceId: z.string().min(1), stages: EvalStages, rating: z.number().int().min(1).max(5), comment: z.string().max(1000).default("") }).strict();
export type RequestEvalInput = z.infer<typeof RequestEvalInput>;

/**
 * A closed request asked to be rated as one unit: its `## 要望` head, the stage Tasks of the request itself (to-pbi,
 * direct) and each derived PBI with its stage Tasks, what they produced (as `EvalContext.outputs`) and how often the
 * person stepped in (follow-up instructions + `decision` stops, summed over the Tasks).
 */
export const EvalsRequestRow = z.object({
  kind: z.literal("request"),
  workspaceId: z.string(),
  number: z.number(),
  title: z.string(),
  /** When the request was closed (ms). */
  closedAt: z.number(),
  head: z.string(),
  taskIds: z.array(z.string()),
  outputs: EvalContext.shape.outputs,
  pbis: z.array(z.object({ number: z.number(), title: z.string(), /** the Project's Status; null = not stored */ status: z.string().nullable(), /** closed as not planned (やらない) */ dropped: z.boolean(), taskIds: z.array(z.string()), outputs: EvalContext.shape.outputs, interventions: z.number() })),
  interventions: z.number(),
  human: RequestEval.nullable(),
});
export type EvalsRequestRow = z.infer<typeof EvalsRequestRow>;
export const EvalsTaskRow = EvalsListRow.extend({ kind: z.literal("task"), context: EvalContext });
export type EvalsTaskRow = z.infer<typeof EvalsTaskRow>;
/** One line of 評価をお願い: a Task, or a closed request with its PBIs. */
export const EvalsSampleRow = z.discriminatedUnion("kind", [EvalsTaskRow, EvalsRequestRow]);
export type EvalsSampleRow = z.infer<typeof EvalsSampleRow>;

/**
 * The Insights summary: what is asked to be rated this week (`sample`: the requests closed and the tasks judged in the
 * week before `weekStart`, the Monday 0:00 UTC of now — the ones the person stepped into most first), how far the
 * person's rating sits from the judge's average over every task that has both (`gap`: human − judge, mean to one
 * decimal, null when none), and how often each stage was chosen in the request evaluations since `stages.from`
 * (the last 4 weeks; every stage has a row, `examples` newest first, at most 5). Counted on every read, not stored.
 */
export const EvalsSummary = z.object({
  weekStart: z.number(),
  sample: z.array(EvalsSampleRow),
  stages: z.object({ from: z.number(), rows: z.array(z.object({ stage: EvalStage, count: z.number(), examples: z.array(z.object({ workspaceId: z.string(), number: z.number() })) })) }),
  gap: z.object({
    count: z.number(),
    mean: z.number().nullable(),
    /** The judge's `intent` score averaged over the tasks the person answered "partial" or "wrong" to the intent question (a row without an `intent` score is not counted). */
    intent: z.object({ count: z.number(), mean: z.number().nullable() }),
    /** The judge's `minimal` score averaged over the tasks the person answered "some" to the complexity or the detour question. */
    minimal: z.object({ count: z.number(), mean: z.number().nullable() }),
    /** The judge's `value` score averaged over the tasks the person answered "unused" to the value question. */
    value: z.object({ count: z.number(), mean: z.number().nullable() }),
  }),
});
export type EvalsSummary = z.infer<typeof EvalsSummary>;
