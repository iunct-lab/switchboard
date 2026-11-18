import type { LedgerBilling, LedgerModelRow } from "@switchboard/protocol";
import { t, type Msg } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

/** The billing kinds in the order the Ledger offers them: the three of a claude login first, then the other runners' two. */
const BILLING_LABELS: Record<LedgerBilling, Msg> = {
  "claude.ai": m.billingClaudeAi,
  console: m.billingConsole,
  bedrock: m.billingBedrock,
  subscription: m.billingSubscription,
  api: m.billingApi,
};

/** The name of a billing kind as the Ledger shows it (the three logins by the names Anthropic gives them). */
export const billingLabel = (b: LedgerBilling): string => t(BILLING_LABELS[b]);

/** The kinds the Ledger's 課金 select offers after 「すべて」: those the period's rows have and the picked one (it stays offered while the rows are read again), in the fixed order. */
export function billingChoices(models: Pick<LedgerModelRow, "billing">[], picked: LedgerBilling | "" = ""): LedgerBilling[] {
  return (Object.keys(BILLING_LABELS) as LedgerBilling[]).filter((b) => b === picked || models.some((r) => r.billing === b));
}

/** The rows the model table shows: every row for 「すべて」, else the picked kind's (the same model is one row per kind). */
export function billingRows(models: LedgerModelRow[], picked: LedgerBilling | ""): LedgerModelRow[] {
  return picked === "" ? models : models.filter((r) => r.billing === picked);
}

/** What one read of the ledger was for: the period and the billing kind picked. */
export const ledgerReadKey = (days: number, billing: LedgerBilling | ""): string => `${days}:${billing}`;

/** Rows kept with what they were read for. */
export interface ReadFor<T> { key: string; rows: T[] }

/**
 * The rows to show under the heading of `key`: the ones read for it, and none otherwise. The numbers of the period or
 * billing kind picked before are never under the new name — not while the new read is under way, and not when it failed.
 */
export const rowsFor = <T>(held: ReadFor<T> | null, key: string): T[] => (held && held.key === key ? held.rows : []);
