import { describe, expect, test } from "bun:test";
import type { BalanceCapacity, BalanceKinds, BalanceRow } from "@switchboard/protocol";
import { balanceCells, capacityText, kindShares } from "./balance.ts";

const kind = (costUsd: number) => ({ tasks: 1, costUsd });
const kinds = (b: number, m: number, s: number, u: number): BalanceKinds => ({ build: kind(b), maintain: kind(m), selfImprove: kind(s), unlinked: kind(u) });
const row = (over: Partial<BalanceRow>): BalanceRow => ({ workspaceId: "ws_1", name: "switchboard", tasks: 466, costUsd: 120, costShare: 0.93, billedUsd: 0, interventions: 410, deliveredPbis: 101, net: 24, costPerPbi: 14.2, interventionsPerPbi: 4.06, kinds: kinds(1, 1, 1, 1), ...over });
const cap = (over: Partial<BalanceCapacity>): BalanceCapacity => ({ runners: [], interventionsPerDay: 60, medianWeeklyUsd: 10, moreRepos: 2, limitedBy: null, ...over });

describe("balance cells", () => {
  test("a row with delivered PBIs shows the figures", () => {
    expect(balanceCells(row({}))).toEqual(["466", "$120.00", "93%", "$0.00", "410", "101", "$14.20", "4.1", "+24"]);
  });
  test("no delivered PBI or an unknown count shows a dash, never 0", () => {
    const none = balanceCells(row({ deliveredPbis: 0, costPerPbi: 9, interventionsPerPbi: 3, net: 0 }));
    expect(none.slice(5)).toEqual(["0", "-", "-", "0"]);
    const unknown = balanceCells(row({ interventions: null, deliveredPbis: null, net: null, costPerPbi: null, interventionsPerPbi: null }));
    expect(unknown.slice(4)).toEqual(["-", "-", "-", "-", "-"]);
  });
});

describe("kind shares", () => {
  test("the shares add up to 100", () => {
    for (const k of [kinds(1, 1, 1, 0), kinds(38, 21, 34, 7), kinds(0.1, 0.2, 0.3, 0.4)]) expect(kindShares(k).reduce((s, x) => s + x.share, 0)).toBe(100);
  });
  test("nothing spent is all 0", () => {
    expect(kindShares(kinds(0, 0, 0, 0)).map((x) => x.share)).toEqual([0, 0, 0, 0]);
  });
});

describe("capacity text", () => {
  test("limited by the quota says there is no room", () => {
    expect(capacityText(cap({ limitedBy: "quota", moreRepos: 0 }))).toBe("余力なし（枠）");
  });
  test("an unknown count is a dash, a known one is said", () => {
    expect(capacityText(cap({ moreRepos: null }))).toBe("-");
    expect(capacityText(cap({ moreRepos: 2 }))).toContain("2");
  });
});
