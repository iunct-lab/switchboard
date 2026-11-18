import { z } from "zod";

/**
 * The stages of a PBI's way from the request to its close, each cut by marks the skills always leave (Issue / PR
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
  stages: z.partialRecord(FlowStage, z.number().nullable()),
  /** Sum of `## 判断待ち` → the next `## 回答` on the PBI and its Tasks (ms). */
  userWaitMs: z.number(),
  /** Per PR: how many `[codex|claude|dak] review` comments it got. */
  reviewRounds: z.array(z.number()),
  /** How many Task Issues (sub-issues) the PBI has; fewer when the list was cut. */
  taskIssues: z.number(),
  /**
   * The Switchboard Tasks whose title starts with `#<PBI or Task number> `; null when the DB was not read.
   * `implementLaunches`: the PBI's stage Tasks of 実装 (`stage.action` `complete`; a resume counts as one too).
   */
  tasks: z.object({ count: z.number(), runMs: z.number(), costUsd: z.number(), implementLaunches: z.number() }).nullable(),
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
 * One week of the backlog: from `weekStart` (YYYY-MM-DD, a Monday, 00:00 UTC) for 7 days, the PBIs and requests
 * opened and closed, `net` = opened − closed (both kinds), and the Tasks whose final report put something off that week
 * (`deferredTasks`) with the Issues of this repository they opened (`deferredIssues`).
 */
export const FlowWeek = z.object({
  weekStart: z.string(),
  pbiOpened: z.number(),
  pbiClosed: z.number(),
  requestOpened: z.number(),
  requestClosed: z.number(),
  net: z.number(),
  deferredTasks: z.number(),
  deferredIssues: z.number(),
});
export type FlowWeek = z.infer<typeof FlowWeek>;

/**
 * `GET /api/flow`: the last `days` days and the `days` before, over every registered workspace's repository, and
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
  /** The weeks of the last `days` days, every repository read summed; not shown on the screen. */
  weeks: z.array(FlowWeek),
});
export type FlowView = z.infer<typeof FlowView>;
