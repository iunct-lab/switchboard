import type { EventEnvelope, PendingApproval } from "@switchboard/protocol";

/**
 * The approvals list (#26) kept current from the event stream: an ask adds a row, its answer (permission.resolved)
 * removes it. Nothing else does — the daemon keeps an ask open past session.end — so the list is fetched again when the
 * connection comes back and when a turn ends. Newest first, like GET /api/approvals. The title is looked up at render.
 */
export function applyApprovalEvent(list: PendingApproval[], env: EventEnvelope): PendingApproval[] {
  const ev = env.ev;
  if (ev.t === "permission.ask") {
    if (list.some((a) => a.taskId === env.taskId && a.id === ev.id)) return list;
    const row: PendingApproval = { taskId: env.taskId, taskTitle: env.taskId, workspace: null, id: ev.id, kind: ev.kind, tool: ev.tool, input: ev.input, detail: ev.detail, askedAt: env.ts };
    return [row, ...list];
  }
  if (ev.t === "permission.resolved") return list.filter((a) => !(a.taskId === env.taskId && a.id === ev.id));
  return list;
}

/**
 * GET /api/approvals is the daemon's view when the request was made: it replaces the list, except for asks that
 * arrived over the WebSocket after the request went out (`since`), which the answer may not include yet.
 */
export function mergeFetched(fetched: PendingApproval[], current: PendingApproval[], since: number): PendingApproval[] {
  const key = (a: PendingApproval) => `${a.taskId}\u0000${a.id}`;
  const known = new Set(fetched.map(key));
  const newer = current.filter((a) => a.askedAt >= since && !known.has(key(a)));
  return [...newer, ...fetched].sort((a, b) => b.askedAt - a.askedAt);
}

/** The first lines of what the runner wants to do, for a phone-sized row. */
export function summarize(a: Pick<PendingApproval, "detail" | "input">, lines = 2): string {
  const text = a.detail.trim() || JSON.stringify(a.input ?? "");
  return text.split("\n").slice(0, lines).join("\n");
}
