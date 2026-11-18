import type { RoutingLogRow, RoutingStats } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const routingApi = {
  /** Routing decision log joined with each task's outcome. The daemon also serves it as JSONL for export. */
  routingLog: (limit = 200) => req<RoutingLogRow[]>(`/api/routing/log?limit=${limit}`),
  /** Agreement rate of each suggester with the runner actually chosen. */
  routingStats: (days = 30) => req<RoutingStats>(`/api/routing/stats?days=${days}`),
};
