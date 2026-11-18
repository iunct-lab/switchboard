import type { BalanceView, FlowView, InterventionView, SourceView } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const insightsApi = {
  /** How often a person stepped in and what made work stop, the last 7 and 30 days against the period before each; counted from the daemon's records at each look. */
  interventions: () => req<InterventionView>("/api/interventions"),
  /** What became of the requests of each speaker and route in the last `days` days (the daemon's default 30, 1 to 3650); counted from the stored records, held an hour by the daemon. */
  sources: (days?: number) => req<SourceView>(`/api/sources${days ? `?days=${days}` : ""}`),
  /** How long the PBIs closed in the last 30 days took, stage by stage, against the 30 before; held an hour by the daemon, refresh reads again. */
  flow: (refresh = false) => req<FlowView>(`/api/flow${refresh ? "?refresh=1" : ""}`),
  /** リポジトリ横断 (Insights): each workspace's spend, interventions and delivered PBIs over 7 or 30 days, and the capacity left */
  balance: (days: 7 | 30) => req<BalanceView>(`/api/balance?days=${days}`),
};
