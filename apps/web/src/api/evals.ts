import type { EvalsListRow, EvalsSummary } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const evalsApi = {
  /** The Evals list: every task's counts, rubric score and rating, newest first; the daemon filters, the screen sorts. */
  evalsList: (q: { workspaceId?: string; runner?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (q.workspaceId) qs.set("workspaceId", q.workspaceId);
    if (q.runner) qs.set("runner", q.runner);
    if (q.limit) qs.set("limit", String(q.limit));
    const query = qs.toString();
    return req<EvalsListRow[]>(`/api/evals${query ? `?${query}` : ""}`);
  },
  evalsSummary: (q: { workspaceId?: string } = {}) => req<EvalsSummary>(`/api/evals/summary${q.workspaceId ? `?workspaceId=${encodeURIComponent(q.workspaceId)}` : ""}`),
};
