import type { BalanceCapacity, BalanceKinds, BalanceRow, BalanceView, RunnerId, Workspace } from "@switchboard/protocol";
import { FLOW_LABEL } from "./backlog-item.ts";
import { readStoredRecords } from "./backlog-stored.ts";
import type { Db, QuotaWindowRow } from "./db.ts";
import { backlogGrowth, closedPbis, flowOfStored, median } from "./flow.ts";
import { collectInterventions, issueOfTask } from "./interventions.ts";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";

const DAY = 86_400_000;
type StoredIssue = StoredRecords["issues"][number];
const MAINTAIN = new Set(["bug", "deps", "chore", "tech-watch", "eval"]);

/** A workspace's stored Issues by number, built once per workspace for `kindOf`. */
export const issuesByNumber = (records: StoredRecords | null): Map<number, StoredIssue> => new Map((records?.issues ?? []).map((i) => [i.number, i]));

/**
 * What kind of work a Task's Issue was: the Issue itself, or the PBI above it for a `type:task`. `flow-improvement` is self-improvement,
 * Kind `feature` builds, the five maintenance Kinds keep; an Issue that is not stored, has no Kind, or has a Kind outside these six
 * (another repository's own) is `unlinked`. Exclusive, so the four add up.
 */
export function kindOf(issue: number | null, byNumber: Map<number, StoredIssue>): keyof BalanceKinds {
  let i: StoredIssue | undefined = issue === null ? undefined : byNumber.get(issue);
  if (i?.labels.includes("type:task")) i = i.parent === null ? undefined : byNumber.get(i.parent);
  if (!i) return "unlinked";
  if (i.labels.includes(FLOW_LABEL)) return "selfImprove";
  const kind = i.fields?.Kind;
  if (kind === "feature") return "build";
  return typeof kind === "string" && MAINTAIN.has(kind) ? "maintain" : "unlinked";
}

/** `x` over each delivered PBI; null when none was delivered or it is not known. */
export const perDelivered = (x: number, delivered: number | null): number | null => (delivered ? x / delivered : null);

/**
 * One row per workspace for the last `days` days: the Tasks created in it, the ledger spent in it (by `tasks.workspace_id`),
 * the interventions at it, and the PBIs closed and the net growth (the definitions of the flow view) from the stored Issues.
 * Counted at each call from the tables; nothing is kept.
 */
export function balanceRows(db: Db, workspaces: Workspace[], days: 7 | 30, now = Date.now()): BalanceRow[] {
  const since = now - days * DAY;
  const kinds = (): BalanceKinds => ({ build: { tasks: 0, costUsd: 0 }, maintain: { tasks: 0, costUsd: 0 }, selfImprove: { tasks: 0, costUsd: 0 }, unlinked: { tasks: 0, costUsd: 0 } });
  const rows = workspaces.map((ws) => {
    const records = readStoredRecords(db, ws);
    return { ws, records, issues: issuesByNumber(records), row: { workspaceId: ws.id, name: ws.name, tasks: 0, costUsd: 0, costShare: 0, billedUsd: 0, interventions: 0, deliveredPbis: null, net: null, costPerPbi: null, interventionsPerPbi: null, kinds: kinds() } as BalanceRow };
  });
  const byId = new Map(rows.map((r) => [r.ws.id, r]));

  const tasks = db.sqlite
    .query(
      `SELECT t.workspace_id AS workspaceId, t.title AS title, t.stage_issue AS stageIssue, t.created_at AS createdAt, COALESCE(c.cost, 0) AS cost, COALESCE(c.billed, 0) AS billed
       FROM tasks t LEFT JOIN (SELECT task_id, SUM(cost_usd) AS cost, SUM(billed_usd) AS billed FROM ledger WHERE ts >= ? GROUP BY task_id) c ON c.task_id = t.id
       WHERE t.workspace_id IS NOT NULL AND (t.created_at >= ? OR c.task_id IS NOT NULL)`,
    )
    .all(since, since) as Array<{ workspaceId: string; title: string; stageIssue: number | null; createdAt: number; cost: number; billed: number }>;
  for (const t of tasks) {
    const r = byId.get(t.workspaceId);
    if (!r) continue;
    const k = r.row.kinds[kindOf(issueOfTask({ title: t.title, stageIssue: t.stageIssue }), r.issues)];
    r.row.costUsd += t.cost;
    r.row.billedUsd += t.billed;
    k.costUsd += t.cost;
    if (t.createdAt >= since) r.row.tasks++, k.tasks++;
  }

  // An intervention on an Issue whose PBI cannot be named is not counted by collectInterventions (it goes to `unknown`); in a workspace
  // whose Issues are not stored that is every intervention on an Issue, so only those on no Issue would be left — a partial count, set
  // to null below rather than shown as a number. Counts are read by the rows, so a deleted workspace's Tasks (their id kept) are left out.
  const counted = new Map<string, number>();
  for (const i of collectInterventions(db, workspaces).items)
    if (i.at >= since && i.at <= now) counted.set(i.workspaceId, (counted.get(i.workspaceId) ?? 0) + 1);

  const total = rows.reduce((s, r) => s + r.row.costUsd, 0);
  for (const { row, records } of rows) {
    row.costShare = total > 0 ? row.costUsd / total : 0;
    row.interventions = records ? (counted.get(row.workspaceId) ?? 0) : null;
    if (records) {
      row.deliveredPbis = closedPbis(records, days, now).length;
      row.net = backlogGrowth(flowOfStored(records, [], days, now).growth, [], records.repository, days, now).reduce((s, w) => s + w.net, 0);
    }
    row.costPerPbi = perDelivered(row.costUsd, row.deliveredPbis);
    row.interventionsPerPbi = row.interventions === null ? null : perDelivered(row.interventions, row.deliveredPbis);
  }
  return rows.map((r) => r.row);
}

/**
 * What the weekly quota leaves, from the 7-day rows, the runners' windows (newest first) and the interventions of the last 7 days.
 * `spent` is what each runner's current window has cost so far. A runner's remaining money is `spent / use * (1 - use)`; a runner with no
 * window, a window already reset, or no spend gives no estimate (null, not 0). Any runner whose current or previous window (one that reset
 * within the last 7 days) reached 100% limits the capacity: `moreRepos` is 0 then.
 */
export function capacityOf(rows7: BalanceRow[], windows: QuotaWindowRow[], interventions7: number, now: number, spent: ReadonlyMap<RunnerId, number> = new Map()): BalanceCapacity {
  const byRunner = new Map<RunnerId, QuotaWindowRow[]>();
  for (const w of windows) byRunner.set(w.runner, [...(byRunner.get(w.runner) ?? []), w]);
  let remaining = 0;
  let known = false;
  const runners = [...byRunner].map(([runner, ws]) => {
    const live = ws[0]!.resetsAt * 1000 > now; // newest first: an expired newest window means the current one has no record yet
    const current = live ? ws[0]! : null;
    // the previous window counts only when it reset within the last 7 days: an old window of a runner not used since is not "recent"
    const before = live ? ws[1] : ws[0];
    const previous = before && before.resetsAt * 1000 > now - 7 * DAY ? before : undefined;
    const utilization = current ? current.peak : 0;
    const saturated = (current?.peak ?? 0) >= 1 || (previous?.peak ?? 0) >= 1;
    const cost = spent.get(runner) ?? 0;
    if (current && utilization > 0 && cost > 0) {
      remaining += utilization >= 1 ? 0 : (cost / utilization) * (1 - utilization);
      known = true;
    }
    return { runner, utilization, resetsAt: current?.resetsAt ?? null, saturated };
  });
  const medianWeeklyUsd = median(rows7.filter((r) => r.costUsd > 0).map((r) => r.costUsd));
  const limited = runners.some((r) => r.saturated);
  const moreRepos = limited ? 0 : known && medianWeeklyUsd ? Math.floor(remaining / medianWeeklyUsd) : null;
  return { runners, interventionsPerDay: interventions7 / 7, medianWeeklyUsd, moreRepos, limitedBy: limited ? "quota" : null };
}

/** The `days` rows and the capacity (always from the last 7 days), counted at each call. */
export function balanceView(db: Db, workspaces: Workspace[], days: 7 | 30, now = Date.now()): BalanceView {
  const rows7 = balanceRows(db, workspaces, 7, now);
  const windows = db.quotaWindows();
  const spent = new Map<RunnerId, number>();
  for (const w of windows) if (w.resetsAt * 1000 > now && !spent.has(w.runner)) spent.set(w.runner, db.windowShares(w.runner, w.resetsAt).reduce((s, x) => s + x.costUsd, 0));
  const interventions7 = rows7.reduce((s, r) => s + (r.interventions ?? 0), 0);
  return { days, rows: days === 7 ? rows7 : balanceRows(db, workspaces, 30, now), capacity: capacityOf(rows7, windows, interventions7, now, spent) };
}
