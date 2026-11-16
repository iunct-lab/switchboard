import type { BacklogAllocation } from "@switchboard/protocol";

type Row = BacklogAllocation["workspaces"][number];

/** A 0〜1 part as a whole percent ("0.93" -> "93%"). */
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The share and the week's actual of one workspace as shown in the Settings card. `actual` carries the gap to the share
 * in points (over = "+", under = "-"); with no share set there is no gap to show.
 */
export function allocationCells(a: Row): { share: string; actual: string } {
  if (a.share === null) return { share: "", actual: pct(a.actual) };
  const gap = Math.round(a.actual * 100) - Math.round(a.share * 100);
  return { share: pct(a.share), actual: `${pct(a.actual)}（${gap >= 0 ? "+" : "−"}${Math.abs(gap)}）` };
}

/** A saved share (0〜1 or null) as the text of its input: whole or one-decimal percent without float noise. */
export function shareText(share: number | null): string {
  return share === null ? "" : String(Math.round(share * 10000) / 100);
}

/** The text of a share input as 0〜1: empty = not set (null), a number 0〜100 (%) = that part, anything else "invalid". */
export function parseShare(text: string): number | null | "invalid" {
  const s = text.trim().replace(/%$/, "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return "invalid";
  const n = Number(s);
  return n > 100 ? "invalid" : Math.round(n * 100) / 10000;
}

/**
 * The order to save changed shares in: the ones that go down first. The daemon checks the sum on each save, so moving
 * share from one workspace to another would be refused if the raise were sent before the cut. Not set counts as 0.
 */
export function saveOrder<T extends { from: number | null; to: number | null }>(changes: T[]): T[] {
  return [...changes].sort((a, b) => (a.to ?? 0) - (a.from ?? 0) - ((b.to ?? 0) - (b.from ?? 0)));
}
