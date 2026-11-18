import { z } from "zod";
import { RunnerId } from "../events.ts";
import { ExecutionMode, TaskOutcome, TaskStatus } from "./shared.ts";

/**
 * What an LLM suggester proposed. Advice only: it never selects the runner, it is shown next to the rule
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
  /** The LLM's proposal for the same task, when that is switched on and answered in time; null otherwise. */
  llm: LlmSuggestion.nullable().default(null),
});
export type RoutingSuggestion = z.infer<typeof RoutingSuggestion>;

/** What was suggested vs. what the user picked, stored on the task. */
export const TaskRouting = z.object({
  suggested: RunnerId,
  ruleId: z.string(),
  reason: z.string(),
  overridden: z.boolean(),
  /** What the LLM suggested, if it was on and answered in time. It may arrive after the task was created, or after it ended. The task's runner never follows it. */
  llm: LlmSuggestion.nullable().default(null),
});
export type TaskRouting = z.infer<typeof TaskRouting>;

/**
 * One row of the routing decision log joined with how the task ended: the training data an LLM router is
 * given. `GET /api/routing/log` returns these, `?format=jsonl` one per line.
 */
export const RoutingLogRow = z.object({
  taskId: z.string(),
  title: z.string(),
  suggested: RunnerId,
  ruleId: z.string(),
  reason: z.string(),
  chosen: RunnerId,
  /** Which suggester produced this row: the rule table, or the LLM asked alongside it. */
  suggestedBy: z.enum(["rule", "llm"]),
  /** Status the task is in now — only whether the runner has stopped, not whether it went well. */
  status: TaskStatus,
  /** How the task turned out: done / needs_action / failed / unknown. */
  outcome: TaskOutcome,
  /** Ledger total of the task in API-equivalent USD (0 when nothing was priced). */
  costUsd: z.number(),
  /** Creation → last status change, in ms. Still growing while the task runs. */
  durationMs: z.number(),
  ts: z.number(),
});
export type RoutingLogRow = z.infer<typeof RoutingLogRow>;

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
 * One runner's record over the stats window: per runner actually run (`chosen`), one per task (the rule row —
 * an LLM row for the same task is not counted again). A runner with no records in the window has no entry.
 */
export const RunnerStats = z.object({
  runner: RunnerId,
  total: z.number(),
  outcomes: z.object({ finished: z.number(), needs_action: z.number(), waits: z.number(), failed: z.number(), unknown: z.number() }),
  /** Median ledger total in API-equivalent USD; null when there are no tasks. */
  medianCostUsd: z.number().nullable(),
  /** Median creation → last event (trailing `status` events, such as the cleanup note after `done`, not counted), in ms; null when there are no tasks. */
  medianDurationMs: z.number().nullable(),
});
export type RunnerStats = z.infer<typeof RunnerStats>;

/**
 * How often each suggester's proposal matched the runner the person actually picked. `agreed / total` is the
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
  /** How each runner's tasks turned out in the window, most tasks first. */
  byRunner: z.array(RunnerStats),
});
export type RoutingStats = z.infer<typeof RoutingStats>;
