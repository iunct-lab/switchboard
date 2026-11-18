import { z } from "zod";
import { RunnerId } from "../events.ts";
import { TaskOrigin } from "./shared.ts";

/**
 * Where the bill of a usage goes, kept on the ledger row when it is recorded (the login changes over time). A claude row is
 * `claude.ai` (a Claude account: covered by the plan), `console` (an Anthropic Console account: charged at the API
 * price) or `bedrock` (Amazon Bedrock, any runner: charged by AWS). Another runner's row keeps pricing.json's `billing`
 * (`subscription` / `api`), and so does a claude row whose login is not known, read as `claude.ai` / `console`.
 */
export const LedgerBilling = z.enum(["claude.ai", "console", "bedrock", "subscription", "api"]);
export type LedgerBilling = z.infer<typeof LedgerBilling>;

export const LedgerRow = z.object({
  taskId: z.string(),
  runner: RunnerId,
  model: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** The 1-hour part of cacheWrite; kept so a row can be repriced. */
  cacheWrite1h: z.number(),
  /** API-equivalent USD (reported by the runner, or priced from pricing.json). */
  costUsd: z.number(),
  /** Actually charged USD (0 under a subscription). */
  billedUsd: z.number(),
  billing: LedgerBilling,
  /** reported = runner gave the cost · priced = computed from the table · unpriced = unknown model (cost 0) */
  source: z.string(),
  ts: z.number(),
});
export type LedgerRow = z.infer<typeof LedgerRow>;

/** GitHub's GraphQL budget of the user the daemon's `gh` signs in as: `resetsAt` in epoch seconds, as `quota`. */
export const GithubBudget = z.object({ remaining: z.number(), limit: z.number(), resetsAt: z.number() });
export type GithubBudget = z.infer<typeof GithubBudget>;

export const LedgerSummary = z.object({
  /** API-equivalent (list price) figures. */
  todayUsd: z.number(),
  weekUsd: z.number(),
  /** What is actually charged (subscription runners count 0). */
  billedTodayUsd: z.number(),
  billedWeekUsd: z.number(),
  byRunnerToday: z.record(z.string(), z.number()),
  /**
   * The last usage-limit report per runner × account × window. `account` is the first characters of the stored name
   * of the account (a hash; "" = unknown), enough to tell two accounts of one runner apart — never the provider's id.
   */
  quota: z.array(z.object({ runner: RunnerId, account: z.string(), window: z.string(), utilization: z.number(), resetsAt: z.number(), ts: z.number() })),
  /** The week's and today's spend by the machine the Task ran on (null = this instance). One row on a machine that holds only its own Tasks; the totals above are the sum. */
  byMachine: z.array(z.object({ machine: z.string().nullable(), todayUsd: z.number(), weekUsd: z.number(), billedTodayUsd: z.number(), billedWeekUsd: z.number() })),
  topTasks: z.array(z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, costUsd: z.number(), tokens: z.number() })),
  /** null while it cannot be read. */
  github: GithubBudget.nullable(),
});
export type LedgerSummary = z.infer<typeof LedgerSummary>;

/** Ledger screen: one row per day × runner. */
export const LedgerDaily = z.object({ day: z.string(), runner: RunnerId, costUsd: z.number(), billedUsd: z.number(), tokens: z.number() });
export type LedgerDaily = z.infer<typeof LedgerDaily>;

export const LedgerTaskRow = z.object({ taskId: z.string(), title: z.string(), runner: RunnerId, origin: TaskOrigin, model: z.string().nullable(), costUsd: z.number(), billedUsd: z.number(), tokens: z.number(), unpriced: z.boolean(), lastTs: z.number() });
export type LedgerTaskRow = z.infer<typeof LedgerTaskRow>;

/** Ledger screen: the period's usage per runner × model × billing kind, costliest first. `tasks` = Tasks that used it; `unpriced` = a usage of the row had no price. */
export const LedgerModelRow = z.object({ runner: RunnerId, model: z.string().nullable(), billing: LedgerBilling, tasks: z.number(), tokens: z.number(), costUsd: z.number(), billedUsd: z.number(), unpriced: z.boolean() });
export type LedgerModelRow = z.infer<typeof LedgerModelRow>;
