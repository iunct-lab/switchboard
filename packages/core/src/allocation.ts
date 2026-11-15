import type { BacklogAllocation, RunnerId, Workspace } from "@switchboard/protocol";

const WEEK_MS = 7 * 86400 * 1000;

/**
 * Where the week's window begins (ms). One window for every runner: Claude's `seven_day` window, which started 7 days
 * before it resets; with none, or one already past, the last 7 days.
 */
export function weekWindowStart(quota: Array<{ runner: RunnerId; window: string; resetsAt: number }>, now: number): number {
  const week = quota.find((q) => q.runner === "claude" && q.window === "seven_day" && q.resetsAt * 1000 > now);
  return week ? week.resetsAt * 1000 - WEEK_MS : now - WEEK_MS;
}

export type Spend = { workspaceId: string; issue: number | null; costUsd: number; billedUsd: number };

/**
 * Each workspace's part of the window's spend against its share, and flow-improvement's part against its limit. A part is
 * (metered + billed) over everything spent, so work that ran on billing counts too; with nothing spent every part is 0.
 */
export function allocationOf(
  workspaces: Array<Pick<Workspace, "id" | "allocation">>,
  spend: Spend[],
  flowIssues: (workspaceId: string) => Set<number>,
  flowShareLimit: number,
): Omit<BacklogAllocation, "windowStart"> {
  const total = spend.reduce((a, r) => a + r.costUsd + r.billedUsd, 0);
  const part = (usd: number) => (total > 0 ? usd / total : 0);
  const flows = new Map<string, Set<number>>();
  let flowUsd = 0;
  for (const r of spend) {
    if (r.issue === null) continue;
    if (!flows.has(r.workspaceId)) flows.set(r.workspaceId, flowIssues(r.workspaceId));
    if (flows.get(r.workspaceId)!.has(r.issue)) flowUsd += r.costUsd + r.billedUsd;
  }
  return {
    workspaces: workspaces.map((w) => {
      const actual = part(spend.filter((r) => r.workspaceId === w.id).reduce((a, r) => a + r.costUsd + r.billedUsd, 0));
      const share = w.allocation.share;
      return { workspaceId: w.id, share, mode: w.allocation.mode, actual, shortfall: share === null ? null : share - actual };
    }),
    flow: { limit: flowShareLimit, actual: part(flowUsd) },
  };
}

/**
 * The order a backlog sweep visits workspaces in. `first`: the workspaces under their share, the largest shortfall first,
 * then those with no share, in the order given. `over`: the workspaces at or over their share, visited only when nothing
 * else started. With no share set anywhere `first` is the given order and `over` is empty.
 */
export function sweepOrder(alloc: Pick<BacklogAllocation, "workspaces">, workspaceIds: string[]): { first: string[]; over: Array<{ workspaceId: string; share: number; actual: number }> } {
  const of = new Map(alloc.workspaces.map((w) => [w.workspaceId, w]));
  const under = workspaceIds.filter((id) => (of.get(id)?.shortfall ?? 0) > 0).sort((a, b) => of.get(b)!.shortfall! - of.get(a)!.shortfall!);
  const unset = workspaceIds.filter((id) => of.get(id)?.shortfall == null);
  const over = workspaceIds.flatMap((id) => {
    const w = of.get(id);
    return w && w.share !== null && w.shortfall !== null && w.shortfall <= 0 ? [{ workspaceId: id, share: w.share, actual: w.actual }] : [];
  });
  return { first: [...under, ...unset], over };
}
