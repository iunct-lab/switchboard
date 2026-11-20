/**
 * bun scripts/review-rounds.ts [--days 30] [--repo <owner/name>] [--json <file>] — one row per rule (each recheck kind of
 * merge-gate, the main review route `review`, and `direct`), with what was found after the merge: the PRs auto-merged by
 * the kind's recheck, how many were reverted, and what the weekly post-merge audit found among them. The counting is
 * merge-audit's (`tally` / `auditRows`); this file only lines it up per rule. Read-only, REST only.
 * Tab-separated, under the header group "拾った問題". The kinds only a user's answer lifts have no row (no recheck runs for them).
 * Exit 0 = printed / 2 = could not read or bad arguments.
 */
import { writeFileSync } from "node:fs";
import { auditRows, readHistory, tally, type PrRecord, type Revert } from "./merge-audit";
import { RECHECK_KINDS } from "./merge-gate";
import { currentRepo } from "./repo.ts";

type Period = { since: string; until: string };

/** The after-merge side of one rule. `autoMerged` / `reverted` only for a recheck kind; `audited` / `findings` are the latest `[post-audit]` in the period over the rule's PRs. */
export interface AfterMergeRow { rule: string; autoMerged: number | null; reverted: number | null; audited: number; findings: number }

export function afterMergeRows(prs: PrRecord[], reverts: Revert[], period: Period): AfterMergeRow[] {
  const latestAudit = (pr: PrRecord) => pr.marks.filter((m) => m.kind === "post-audit" && m.at >= period.since && m.at < period.until).at(-1);
  const kindRows = tally(prs, reverts, period).filter((t) => (RECHECK_KINDS as string[]).includes(t.kind)).map((t): AfterMergeRow => {
    let audited = 0;
    let findings = 0;
    for (const pr of prs.filter((p) => t.recheckMerged.includes(p.number))) {
      const last = latestAudit(pr);
      if (!last) continue;
      audited++;
      if (last.verdict === "finding") findings++;
    }
    return { rule: t.kind, autoMerged: t.recheckMerged.length, reverted: t.reverted.length, audited, findings };
  });
  const routeRows = auditRows(prs, period).filter((r) => r.route !== "recheck")
    .map((r): AfterMergeRow => ({ rule: r.route, autoMerged: null, reverted: null, audited: r.sampled, findings: r.findings }));
  return [...kindRows, ...routeRows];
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 1000) / 10}%`);

/** A tab-separated table: a group line (拾った問題), the column names, one line per rule. */
export function format(rows: AfterMergeRow[]): string[] {
  const dash = (n: number | null) => (n === null ? "-" : String(n));
  return [
    ["", "拾った問題", "", "", "", ""].join("\t"),
    ["決まり", "自動マージ", "戻された", "監査の抜き取り", "監査の finding", "finding の率"].join("\t"),
    ...rows.map((r) => [r.rule, dash(r.autoMerged), dash(r.reverted), r.audited, r.findings, pct(r.findings, r.audited)].join("\t")),
  ];
}

const DAY = 86_400_000;

export async function main(args: string[], now = Date.now()): Promise<number> {
  try {
    const arg = (flag: string) => {
      const i = args.indexOf(flag);
      if (i < 0) return undefined;
      const v = args[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`${flag} に値が要る`);
      return v;
    };
    const days = Number(arg("--days") ?? 30);
    if (!Number.isInteger(days) || days < 1) throw new Error("--days は 1 以上の整数");
    const repo = arg("--repo") ?? currentRepo();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo は owner/name");
    const json = arg("--json");
    const until = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") + DAY;
    const period = { since: new Date(until - days * DAY).toISOString(), until: new Date(until).toISOString() };
    const { prs, reverts } = await readHistory(period.since, undefined, repo);
    const rows = afterMergeRows(prs, reverts, period);
    for (const line of format(rows)) console.log(line);
    if (json) writeFileSync(json, JSON.stringify({ period, rows }, null, 2));
  } catch (e) {
    console.error(`読めなかった: ${(e as Error).message}`);
    return 2;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
