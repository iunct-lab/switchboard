import { existsSync, readFileSync } from "node:fs";
import type { AgentEvent, LedgerRow, PricingTable, RunnerId, Task } from "@switchboard/protocol";
import { PricingTable as PricingSchema } from "@switchboard/protocol";

/**
 * Pricing (proposal Screen D, issue #14): the price table is data, not code. Runners that report tokens but no cost
 * (Codex) get an API-equivalent figure from it; subscription runners show 実課金 0 next to the API-equivalent number.
 */
export function loadPricing(paths: string[], log: (m: string) => void = (m) => console.warn(m)): { table: PricingTable; source: string; problems: string[] } {
  const problems: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = PricingSchema.safeParse(JSON.parse(readFileSync(p, "utf8")));
      if (parsed.success) return { table: parsed.data, source: p, problems };
      problems.push(`${p}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    } catch (e) {
      problems.push(`${p}: ${String((e as Error).message ?? e)}`);
    }
    log(`pricing: ignoring invalid table ${problems.at(-1)}`);
  }
  return { table: { version: 1, billing: {}, models: {}, aliases: {} }, source: "builtin", problems };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The 1-hour part of cacheWriteTokens, priced at cacheWrite1h (falls back to cacheWrite). */
  cacheWrite1hTokens?: number;
}

/**
 * Resolve a model name to a price row: exact, then alias, then the name without a trailing date suffix
 * (claude-sonnet-5-20260301 → claude-sonnet-5), then the longest priced name it starts with. A context-window tag
 * (claude-fable-5-1[1m]) is dropped first. The prefix match skips a version segment (claude-fable-5-2 is not
 * claude-fable-5): a newer minor is a different price tier, so it stays unpriced. Only when the runner reported no
 * model at all does the runner's alias (its default model) apply — a named but unknown model is unpriced.
 */
export function resolveModel(table: PricingTable, model: string | null | undefined, runner: RunnerId): { name: string; price: PricingTable["models"][string] } | null {
  const hit = (m: string | undefined) => (m && table.models[m] ? { name: m, price: table.models[m]! } : null);
  if (model) {
    const name = model.replace(/\[[^\]]*\]$/, "");
    const direct = hit(name) ?? hit(table.aliases[name]) ?? hit(name.replace(/-\d{8}$/, ""));
    if (direct) return direct;
    const prefix = Object.keys(table.models)
      .filter((m) => name.startsWith(m + "@") || (name.startsWith(m + "-") && !/^\d{1,7}(\D|$)/.test(name.slice(m.length + 1))))
      .sort((a, b) => b.length - a.length)[0];
    return hit(prefix);
  }
  return hit(table.aliases[runner]);
}

type Price = PricingTable["models"][string];

/** The row's price at `ts` (ms): the last change whose `from` (00:00 UTC) is not after `ts`, over the row. No `ts` = the row. */
export function effectivePrice(price: Price, ts?: number): Price {
  if (ts === undefined || !price.changes?.length) return price;
  const change = [...price.changes].sort((a, b) => a.from.localeCompare(b.from)).filter((c) => Date.parse(`${c.from}T00:00:00Z`) <= ts).at(-1);
  if (!change) return price;
  const { from: _from, ...fields } = change;
  return { ...price, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
}

/** API-equivalent cost in USD at `ts` (the usage time); `priced` is false when the model is unknown (cost 0, flagged in the UI). */
export function priceUsage(table: PricingTable, model: string | null | undefined, runner: RunnerId, u: Usage, ts?: number): { costUsd: number; priced: boolean; model: string | null } {
  const r = resolveModel(table, model, runner);
  if (!r) return { costUsd: 0, priced: false, model: model ?? null };
  const p = effectivePrice(r.price, ts);
  const perM = (n: number, price: number) => (n / 1_000_000) * price;
  const write1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens);
  const costUsd = perM(u.inputTokens, p.input) + perM(u.outputTokens, p.output) + perM(u.cacheReadTokens, p.cacheRead) + perM(u.cacheWriteTokens - write1h, p.cacheWrite) + perM(write1h, p.cacheWrite1h ?? p.cacheWrite);
  return { costUsd: Math.round(costUsd * 1e6) / 1e6, priced: true, model: r.name };
}

/**
 * What the user actually pays for this usage: API price for pay-as-you-go runners, 0 under a subscription.
 * A runner missing from `billing` counts as pay-as-you-go: the conservative reading for the money column.
 */
export function billedUsd(table: PricingTable, runner: RunnerId, apiCostUsd: number): number {
  return (table.billing[runner] ?? "api") === "api" ? apiCostUsd : 0;
}

/**
 * The ledger row for one usage event: the runner's own cost when it reported one (`reported`), else the table's
 * API-equivalent figure (`priced`; `unpriced` = unknown model, cost 0). The runner's model name is what is recorded,
 * not the price row it resolved to. Shared by the live task path and the history importer so both books agree.
 */
export function ledgerRowFor(table: PricingTable | undefined, task: Pick<Task, "id" | "runner" | "model">, ev: Extract<AgentEvent, { t: "usage" }>, ts: number): LedgerRow {
  const priced = ev.costUsd === undefined && table ? priceUsage(table, ev.model ?? task.model, task.runner, ev, ts) : null;
  const costUsd = ev.costUsd ?? priced?.costUsd ?? 0;
  return {
    taskId: task.id,
    runner: task.runner,
    model: ev.model ?? task.model ?? priced?.model ?? null,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    cacheRead: ev.cacheReadTokens,
    cacheWrite: ev.cacheWriteTokens,
    cacheWrite1h: ev.cacheWrite1hTokens ?? 0,
    costUsd,
    billedUsd: table ? billedUsd(table, task.runner, costUsd) : costUsd,
    source: ev.costUsd !== undefined ? "reported" : priced?.priced ? "priced" : "unpriced",
    ts,
  };
}

/** What a ledger row keeps of a cumulative report (#2353): the runner session and its running total for the row's model. */
export interface ReportedTotal {
  session?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  /** The part of costUsd already booked by the migrated rows (`credit` of usageSince), on the model's first row after them. */
  carried?: number;
}

const TOTAL_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const;

/**
 * The turn's share of a cumulative usage (`ev.cumulative`, Claude's `result`): the difference from `prev`, the previous
 * total of the same Task and model. A total that went down, or one of another runner session, starts again from 0
 * (a new session that does not carry the old one's total). With no `prev`, `credit` is what the Task's migrated rows
 * already booked of this same session, which they could not split by model (#2353; 0 for another session): the
 * model's first total is counted against it, and the part used goes into `carried`. null when nothing grew — a result repeating the last total adds no row.
 */
export function usageSince(prev: ReportedTotal | null, ev: Extract<AgentEvent, { t: "usage" }>, session: string | null, credit = 0): { usage: Extract<AgentEvent, { t: "usage" }>; total: ReportedTotal } | null {
  const total: ReportedTotal = { session, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWriteTokens: ev.cacheWriteTokens, costUsd: ev.costUsd ?? 0 };
  const { cumulative: _c, ...turn } = ev;
  const fresh = !prev || (!!prev.session && !!session && prev.session !== session) || TOTAL_KEYS.some((k) => prev[k] !== undefined && total[k]! < prev[k]!);
  const carried = prev ? 0 : Math.min(total.costUsd, Math.max(0, credit));
  if (carried > 0) total.carried = carried;
  const less = (k: (typeof TOTAL_KEYS)[number]) => (fresh ? total[k]! : total[k]! - (prev[k] ?? 0));
  const usage = { ...turn, inputTokens: less("inputTokens"), outputTokens: less("outputTokens"), cacheReadTokens: less("cacheReadTokens"), cacheWriteTokens: less("cacheWriteTokens"), costUsd: Math.round((less("costUsd") - carried) * 1e10) / 1e10 };
  if (TOTAL_KEYS.every((k) => usage[k] === 0)) return null;
  return { usage, total };
}
