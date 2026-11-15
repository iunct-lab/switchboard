// types only: a value import would pull the whole protocol (zod schemas) into the page's bundle
import type { BalanceCapacity, BalanceKinds, BalanceRow } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";
import { fmtUsd, pct } from "./components/ui.tsx";

const DASH = "-";

/** A count that may be unknown (the workspace's Issues are not stored): null is a dash, never 0. */
const count = (n: number | null): string => (n === null ? DASH : String(n));

/** The cells after the repository name, in the order of the table's columns. A ratio over no delivered PBI is a dash. */
export function balanceCells(row: BalanceRow): string[] {
  const delivered = row.deliveredPbis !== null && row.deliveredPbis > 0;
  return [
    String(row.tasks),
    fmtUsd(row.costUsd),
    pct(row.costShare),
    fmtUsd(row.billedUsd),
    count(row.interventions),
    count(row.deliveredPbis),
    delivered && row.costPerPbi !== null ? fmtUsd(row.costPerPbi) : DASH,
    delivered && row.interventionsPerPbi !== null ? row.interventionsPerPbi.toFixed(1) : DASH,
    row.net === null ? DASH : row.net > 0 ? `+${row.net}` : String(row.net),
  ];
}

export type KindKey = keyof BalanceKinds;
const KEYS: KindKey[] = ["build", "maintain", "selfImprove", "unlinked"];

/** Each kind's share of the cost as a whole percent; the largest remainder takes the leftover points so they add up to 100. All 0 when nothing was spent. */
export function kindShares(kinds: BalanceKinds): Array<{ key: KindKey; share: number }> {
  const total = KEYS.reduce((s, k) => s + kinds[k].costUsd, 0);
  if (total <= 0) return KEYS.map((key) => ({ key, share: 0 }));
  const exact = KEYS.map((key) => (kinds[key].costUsd / total) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return KEYS.map((key, i) => ({ key, share: shares[i]! }));
}

/** What the quota leaves, in a phrase: none when it is the limit, a dash when it cannot be known. */
export function capacityText(c: BalanceCapacity): string {
  if (c.limitedBy === "quota") return t(m.balanceNoRoom);
  if (c.moreRepos === null) return DASH;
  return t(m.balanceMoreRepos, { n: c.moreRepos });
}
