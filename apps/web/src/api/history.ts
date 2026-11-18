import type { HistoryScanResult, HistoryStatus } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const historyApi = {
  /** Terminal history: the session-log import's status, and a pass on request. */
  history: () => req<HistoryStatus>("/api/history"),
  historyImport: () => req<HistoryScanResult>("/api/history/import", { method: "POST" }),
};
