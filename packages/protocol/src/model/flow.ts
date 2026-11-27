import { z } from "zod";

/**
 * The stages of a PBI's way from the request to its close, each cut by marks the skills always leave (Issue / PR
 * times, the Task's claim comment, the `[codex|claude|dak] review` comment) — not by the Project's Status, whose changes
 * through the API leave no event. docs/design/flow-metrics.md.
 */
export const FlowStage = z.enum(["request", "split", "wait", "build", "review-wait", "review", "close"]);
export type FlowStage = z.infer<typeof FlowStage>;

/** One merged PR: how many review rounds it had, and how many REGRESSION lines its last readable `[<runner>] compare` comment holds (null = no comparison). */
export const FlowPrRecord = z.object({ number: z.number(), reviews: z.number(), regressions: z.number().nullable() });
export type FlowPrRecord = z.infer<typeof FlowPrRecord>;

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
   * The Switchboard Tasks of the PBI or one of its Tasks (a stage Task, or a title starting with `#<number> `) and the bundle
   * Tasks that took the PBI, each once and in full (a bundle over three PBIs is in each one's count and cost); null when the DB was not read.
   * `implementLaunches`: the PBI's stage Tasks of 実装 (`stage.action` `complete`; a resume counts as one too).
   */
  tasks: z
    .object({
      count: z.number(),
      runMs: z.number(),
      costUsd: z.number(),
      implementLaunches: z.number(),
      /** Each of those Tasks (a bundle Task that took the PBI is among them once): its cost and run time. */
      items: z.array(z.object({ id: z.string(), costUsd: z.number(), runMs: z.number() })),
      /** When the earliest bundle Task that took this PBI was created (ms); null = none did. */
      bundleStartAt: z.number().nullable(),
      /** The pull requests those bundle Tasks opened, of the repository whose PRs the flow reads (the numbers). */
      bundlePrs: z.array(z.number()),
    })
    .nullable(),
  /** How the PBI was worked: a bundle Task took it (`p3-bundle`), else a Task under `p0-pipeline` worked on it; null = neither is recorded (a Task from before the provenance, or none). */
  process: z.enum(["p3-bundle", "p0-pipeline"]).nullable(),
  /** When work started (ms): the end of stage `wait` (the first claim mark, else the first PR's creation); null = neither is recorded. */
  startAt: z.number().nullable(),
  /** When the last of its merged PRs was merged (ms); null = none. */
  mainAt: z.number().nullable(),
  /** Its merged PRs: the review marks each has, and the REGRESSION lines of the last comparison with main (null = never compared). */
  prs: z.array(FlowPrRecord),
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

/** The closed PBIs of one way of working (`process`; null = not recorded), pooled: a bundle Task's cost and PRs count once however many PBIs it took. */
export const FlowProcessRow = z.object({
  process: z.enum(["p3-bundle", "p0-pipeline"]).nullable(),
  pbis: z.number(),
  storyPoints: z.number(),
  /** Median from the start (the earlier of the first claim and the bundle Task's creation) to the last merge; ms. */
  toMainP50: z.number().nullable(),
  /** Median from the start to the PBI's close; ms. */
  toCloseP50: z.number().nullable(),
  /** null = no PBI of the way had its Tasks read (no DB). */
  costUsd: z.number().nullable(),
  /** The cost of the PBIs with Story Points / their Story Points; null when none has them (or no cost was read). */
  costPerSp: z.number().nullable(),
  /** Median review rounds over the PRs. */
  reviewsP50: z.number().nullable(),
  /** REGRESSION lines summed over the PRs that were compared. */
  regressions: z.number(),
  comparedPrs: z.number(),
  prs: z.number(),
  /** Fewer than 3 PBIs: too few to read a median from. */
  few: z.boolean(),
});
export type FlowProcessRow = z.infer<typeof FlowProcessRow>;
