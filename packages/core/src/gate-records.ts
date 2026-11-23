/** The merge verdicts the app ran of a PR (gate jobs), as a merge question reads them: which head was judged and what was asked. */

import type { Job } from "@switchboard/protocol";

/** A merge verdict the app ran (a gate job's `result.gate`): the head it judged, when it started, and the kinds it asked and left for a recheck. */
export interface GateRecord { head: string; startedAt: number; ask: string[]; recheck: string[] }

/** How far before a question a stack's verdict that named the PR (run for the stack's top PR) is looked for. */
export const STACK_GATE_LOOKBACK_MS = 14 * 86_400_000;

/**
 * The merge verdicts of a PR the app ran (gate jobs with a judgement), oldest first. A stack's verdict gives each PR its own entry
 * (`stack[]`: its head and kinds, as merge-audit reads it), so a lower PR's verdict is found in the top PR's job, looked for from
 * `sinceMs` on; a single PR's verdict is its own record. `repo` as the jobs record it (lower case).
 */
export function gateRecordsOf(db: { jobsOf(repo: string, prs: number[]): Job[]; jobsSince(repo: string, sinceMs: number): Job[] }, repo: string, pr: number, sinceMs: number): GateRecord[] {
  const key = repo.toLowerCase();
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === "string") : null);
  const jobs = new Map<number, Job>();
  for (const j of [...db.jobsOf(key, [pr]), ...db.jobsSince(key, sinceMs)]) if (j.kind === "gate") jobs.set(j.id, j);
  return [...jobs.values()].sort((a, b) => a.id - b.id).flatMap((j) => {
    const g = (j.result as { gate?: { head?: unknown; ask?: unknown; recheck?: unknown; stack?: unknown } } | null)?.gate;
    if (!g) return [];
    if (Array.isArray(g.stack)) {
      const e = (g.stack as Array<{ pr?: unknown; head?: unknown; ask?: unknown; recheck?: unknown }>).find((x) => x?.pr === pr);
      const head = typeof e?.head === "string" ? e.head : e && j.pr === pr && typeof g.head === "string" ? g.head : null;
      const ask = strs(e?.ask), recheck = strs(e?.recheck);
      return head && ask && recheck ? [{ head: head.toLowerCase(), startedAt: j.startedAt, ask, recheck }] : [];
    }
    const ask = strs(g.ask), recheck = strs(g.recheck);
    return j.pr === pr && typeof g.head === "string" && ask && recheck ? [{ head: g.head.toLowerCase(), startedAt: j.startedAt, ask, recheck }] : [];
  });
}
