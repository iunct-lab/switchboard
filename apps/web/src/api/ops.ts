import type { OpsLatency, OpsLoad, OpsResources, OpsStops, PerfSample, PerfSummaryRow } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const opsApi = {
  perf: (rows: PerfSample[]) => req<{ ok: true; count: number }>("/api/perf", { method: "POST", body: JSON.stringify(rows) }),
  perfSummary: () => req<PerfSummaryRow[]>("/api/perf/summary"),
  opsLatency: (days = 7) => req<OpsLatency>(`/api/ops/latency?days=${days}`),
  opsStops: (days = 7) => req<OpsStops>(`/api/ops/stops?days=${days}`),
  opsResources: () => req<OpsResources>("/api/ops/resources"),
  opsLoad: (days = 7, task?: string) => req<OpsLoad>(`/api/ops/load?days=${days}${task ? `&task=${encodeURIComponent(task)}` : ""}`),
};
