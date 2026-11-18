import { z } from "zod";
import { RunnerId } from "../events.ts";

/** What a workspace's Tasks of a period were for: the Tasks created in it and the ledger cost spent in it, by the kind of work. The four add up to the row's `tasks` and `costUsd`. */
const BalanceKind = z.object({ tasks: z.number(), costUsd: z.number() });
export const BalanceKinds = z.object({
  /** The Issue's Kind is `feature`. */
  build: BalanceKind,
  /** The Kind is `bug`, `deps`, `chore`, `tech-watch` or `eval`. */
  maintain: BalanceKind,
  /** The Issue carries the `flow-improvement` label. */
  selfImprove: BalanceKind,
  /** No stored Issue to read (no Issue, or not stored), no Kind, or a Kind outside the six above. */
  unlinked: BalanceKind,
});
export type BalanceKinds = z.infer<typeof BalanceKinds>;

/**
 * One workspace's balance over the last 7 or 30 days: what its Tasks spent (`costUsd` is the quota used, `costShare` its share of
 * every workspace's; `billedUsd` the API charge), how often the person stepped in, and what reached the end (`deliveredPbis`, the
 * PBIs closed in exactly the period; `net` the PBIs and requests opened minus closed, summed over the weeks of the growth chart from
 * the Monday on or before the period's start, so it can reach up to 6 days further back than `deliveredPbis`). A workspace whose Issues
 * are not stored has no `interventions` / `deliveredPbis` / `net` (null, not 0: its interventions cannot be placed), and a ratio over no
 * delivered PBI is null.
 */
export const BalanceRow = z.object({
  workspaceId: z.string(),
  name: z.string(),
  tasks: z.number(),
  costUsd: z.number(),
  costShare: z.number(),
  billedUsd: z.number(),
  interventions: z.number().nullable(),
  deliveredPbis: z.number().nullable(),
  net: z.number().nullable(),
  costPerPbi: z.number().nullable(),
  interventionsPerPbi: z.number().nullable(),
  kinds: BalanceKinds,
});
export type BalanceRow = z.infer<typeof BalanceRow>;

/**
 * What the weekly quota leaves. Per runner: the use of the current window (0 once it has reset or when the current window has no record), when
 * it resets (epoch s, null when the current window has no record), and `saturated` when the current or the previous window (reset within
 * the last 7 days) reached 100%. A runner with no window recorded at all has no entry. `interventionsPerDay` is the last 7 days' count
 * over 7. `medianWeeklyUsd` is the median spend of the workspaces that spent in the last 7 days; `moreRepos` the whole number of such
 * workspaces the remaining quota would carry at the same use (0 when `limitedBy` is "quota"; null when the use or the median is unknown).
 */
export const BalanceCapacity = z.object({
  runners: z.array(z.object({ runner: RunnerId, utilization: z.number().nullable(), resetsAt: z.number().nullable(), saturated: z.boolean() })),
  interventionsPerDay: z.number(),
  medianWeeklyUsd: z.number().nullable(),
  moreRepos: z.number().nullable(),
  limitedBy: z.literal("quota").nullable(),
});
export type BalanceCapacity = z.infer<typeof BalanceCapacity>;

/** The workspaces' balance over `days` days and the capacity left. */
export const BalanceView = z.object({ days: z.union([z.literal(7), z.literal(30)]), rows: z.array(BalanceRow), capacity: BalanceCapacity });
export type BalanceView = z.infer<typeof BalanceView>;
