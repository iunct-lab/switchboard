import type { BalanceKinds, BalanceRow, Workspace } from "@switchboard/protocol";
import { FLOW_LABEL, readStoredRecords } from "./backlog.ts";
import type { Db } from "./db.ts";
import { backlogGrowth, closedPbis, flowOfStored } from "./flow.ts";
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
