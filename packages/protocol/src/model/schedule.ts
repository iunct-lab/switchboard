import { z } from "zod";
import { RunnerId } from "../events.ts";

/**
 * What a secret-scan firing found, kept on the schedule: the time it ended, `repos` = repositories identified from
 * the workspaces (one whose scan then failed counts too), `hits`, `failed` = scans that failed plus workspaces whose
 * repository could not be identified, and its log lines (places and kinds only, never a value). A firing whose scan
 * itself threw is `repos: 0, failed: 1` with one line carrying the error's name only.
 */
/** Per repository (`<owner>/<name>`), where the next secret-scan starts: the time its last read began and its hits' URLs. */
export const ScanCursors = z.record(z.string(), z.object({ since: z.string(), hits: z.array(z.string()) }));
export type ScanCursors = z.infer<typeof ScanCursors>;
export const ScheduleResult = z.object({ at: z.number(), repos: z.number(), hits: z.number(), failed: z.number(), lines: z.array(z.string()), cursors: ScanCursors.optional() });
export type ScheduleResult = z.infer<typeof ScheduleResult>;

/** A recurring task: a cron expression that starts a task with this prompt on a workspace. */
export const Schedule = z.object({
  id: z.string(),
  title: z.string(),
  cron: z.string(),
  workspaceId: z.string(),
  runner: RunnerId,
  /** The model the runner starts on; empty = that runner's CLI default. */
  model: z.string(),
  /** The thinking effort the runner starts with; empty = that runner's CLI default. */
  effort: z.string(),
  prompt: z.string(),
  /**
   * `prompt` = start a task with the prompt; `backlog-next` = move one backlog item to its next stage;
   * `secret-scan` = check every registered repository for values written on GitHub; those two use no runner.
   * `insights` = run Claude Code's /insights as a Task of its own and keep the report as its artifact (claude, no prompt).
   * `approval-window` = the SSO / deploy batches still waiting are one notice in 判断待ち, none when there are none (no runner).
   */
  action: z.enum(["prompt", "backlog-next", "secret-scan", "insights", "approval-window"]),
  budgetUsd: z.number().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  lastTaskId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  /** The last secret-scan firing's result; null on the other actions and before the first firing. */
  lastResult: ScheduleResult.nullable(),
  /** Set by the list API only: the schedule's Tasks stopped the same way in a row; `taskId` is the newest one's. null elsewhere. */
  stuck: z.object({ count: z.number().int(), reason: z.string(), evidence: z.string(), firstAt: z.number(), taskId: z.string() }).nullable(),
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
  /** Required (non-blank) when action is `prompt` — checked by the scheduler, since PATCH takes a partial of this; the other kinds take none. */
  prompt: z.string().optional(),
  action: z.enum(["prompt", "backlog-next", "secret-scan", "insights", "approval-window"]).optional(),
  budgetUsd: z.number().positive().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;
