import { z } from "zod";

/**
 * One line of the sources table: the requests of one repository that came from one speaker (and, for the scheduled checks and the agent, one route; `route` null = the speaker's total).
 * `opened` = requests created in the period; `planned` = those with a PBI naming them as 元要望; `dropped` = closed without being delivered;
 * `delivered` = every PBI derived from it is closed as completed and the request is closed; `daysToDeliver` = the median days from the request's creation to its close over the delivered ones;
 * `stale` = still open after `staleDays` with no PBI. The "派生" speaker counts only `opened`: the Issues a deferred Task opened.
 * `reverted` = the PRs of the delivered PBIs taken back on main (git revert / rollback-pr); `followUpBugs` = the bugs filed within `reworkDays` of such a PBI's close that name the PBI or its PR.
 */
export const SourceRow = z.object({
  repo: z.string(),
  speaker: z.enum(["利用者", "エージェント", "定期の検査", "読めない", "派生"]),
  route: z.string().nullable(),
  opened: z.number(),
  planned: z.number(),
  dropped: z.number(),
  delivered: z.number(),
  daysToDeliver: z.number().nullable(),
  stale: z.number(),
  reverted: z.number(),
  followUpBugs: z.number(),
});
export type SourceRow = z.infer<typeof SourceRow>;

/** `GET /api/sources`: the last `days` days, counted at each look from the stored records and the Tasks. `unread` = workspaces not counted in full: never imported (no rows), or whose clone has no readable default branch (rows come, with `reverted` and `followUpBugs` 0). */
export const SourceView = z.object({
  days: z.number(),
  now: z.number(),
  staleDays: z.number(),
  reworkDays: z.number(),
  rows: z.array(SourceRow),
  unread: z.array(z.string()),
});
export type SourceView = z.infer<typeof SourceView>;
