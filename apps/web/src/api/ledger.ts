import type { LedgerBilling, LedgerDaily, LedgerModelRow, LedgerSummary, LedgerTaskRow, PricingTable } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const ledgerApi = {
  ledger: () => req<LedgerSummary>("/api/ledger/summary"),
  /** `billing`: only the rows of that billing kind ("" = every kind together). */
  ledgerDaily: (days = 7, billing: LedgerBilling | "" = "") => req<LedgerDaily[]>(`/api/ledger/daily?days=${days}${billing && `&billing=${billing}`}`),
  ledgerTasks: (days = 7, billing: LedgerBilling | "" = "") => req<LedgerTaskRow[]>(`/api/ledger/tasks?days=${days}${billing && `&billing=${billing}`}`),
  /** Ledger: the period per runner × model × billing kind, costliest first. */
  ledgerModels: (days = 7) => req<LedgerModelRow[]>(`/api/ledger/models?days=${days}`),
  pricing: () => req<PricingTable & { fromSettings: string[]; source: string; problems: string[] }>("/api/ledger/pricing"),
};
