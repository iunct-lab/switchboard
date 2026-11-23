/**
 * bun scripts/review-rounds.ts [--days 30] [--repo <owner/name>] [--json <file>] — one row per rule (each recheck kind of
 * merge-gate, the main review route `review`, and `direct`), in two groups of columns. "拾った問題" is what a rule caught:
 * the findings and what became of them (from the review jobs' records and the triage tables), and what was found after the
 * merge (the PRs auto-merged by the kind's recheck, how many were reverted, the weekly post-merge audit; merge-audit's
 * `tally` / `auditRows`). "掛かった往復" is what it took: the rounds per PR, the findings repeated on a path an earlier
 * round already named, and the minutes until the pass. Read-only, nothing is stored. All of it comes from the app's records
 * (`GET /api/merge-records/history`, one call: the review jobs and their findings, the stored comments of the PRs) and main's
 * commits (this clone's `git log`): GitHub is not asked for this repository's PRs. The first line says when the records begin.
 * Tab-separated. The kinds only a user's answer lifts have no row (no recheck runs for them).
 * Exit 0 = printed / 2 = could not read or bad arguments.
 */
import { writeFileSync } from "node:fs";
import { mergeHistory, type MergeHistory, type MergeHistoryJob } from "../ops-kit/src/merge-records.ts";
import { auditRows, formatSince, mergeCommitsOf, prViewsOf, revertsSince, spawnRun, tally, type PrRecord, type Revert, type Run } from "./merge-audit";
import { RECHECK_KINDS } from "./merge-gate";
import { COMMAND_RECHECKS, commandPassOf, reviewPassOf } from "./merge-gate-records.ts";
import { mergeRecordsEnv } from "./merge-records-env.ts";
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


// ---- The rounds: from the review jobs the app recorded (one job = one round) ----

export type Severity = "blocker" | "should-fix" | "nit" | "question";
export interface Finding { severity: Severity; path: string }
/** One round of one rule on one PR. `from` is when the review job began, `at` when it ended (GitHub's time form, no milliseconds). */
export interface Round { pr: number; runner: string; rule: string; at: string; from: string; findings: Finding[] }
/** A PR comment the app stored, as the triage reads it. */
export interface PrComment { pr: number; body: string; created_at: string }

const byAt = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
const kindsOf = (j: MergeHistoryJob) => j.kinds.filter((k) => (RECHECK_KINDS as readonly string[]).includes(k));

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

type JobReview = { findings: { severity: Severity; path: string }[] };
/** The findings a review job's end recorded; none when its output had no Findings section. */
const reviewOf = (j: MergeHistoryJob): JobReview | undefined => {
  const r = (j.result as { review?: JobReview } | null)?.review;
  return r && Array.isArray(r.findings) ? r : undefined;
};

/**
 * The rounds of every PR in the jobs. A review job that passed and left its findings is one round: of the rule `review` when it
 * is the main review (`as` none, or `fallback` at a usage limit: the jobs merge-gate counts), of each recheck kind it names when
 * it ran as `recheck` (a job of several kinds is one round of each kind, counting all its findings); an audit or an attacking
 * review is not a round. A finding whose place could not be read (no path) is not counted.
 */
export function roundsOf(jobs: MergeHistoryJob[]): Round[] {
  const rounds: Round[] = [];
  for (const j of jobs) {
    const r = reviewOf(j);
    if (j.kind !== "review" || j.status !== "pass" || !r || j.endedAt === null) continue;
    const rules = j.as === null || j.as === "fallback" ? ["review"] : j.as === "recheck" ? kindsOf(j) : [];
    const findings = r.findings.filter((f) => f.path !== "").map((f) => ({ severity: f.severity, path: f.path }));
    for (const rule of rules) rounds.push({ pr: j.pr, runner: j.runner ?? "", rule, at: githubTime(j.endedAt), from: githubTime(j.startedAt), findings });
  }
  return rounds.sort((a, b) => a.pr - b.pr || byAt(a, b));
}

/** What the triage summary of one round says became of its findings, for one rule. */
export interface TriageRow { pr: number; rule: string; at: string; fixed: number; issued: number; notNeeded: number; answered: number }

/**
 * The tables of the `## レビュー対応` summaries (the stored comments that begin so): per reviewer cell, `claude` / `claude（修正の見直し、2 回目）`
 * is the main review, `codex（recheck responsibility、2 回目）` is that kind (a cell of several kinds counts each in full).
 * The columns are 件数・修正・Issue 化・対処不要・回答.
 */
export function parseTriage(comments: PrComment[]): TriageRow[] {
  const rows: TriageRow[] = [];
  for (const c of comments) {
    if (!c.body.startsWith("## レビュー対応")) continue;
    for (const line of c.body.split("\n").filter((l) => l.startsWith("|"))) {
      const cells = line.split("|").slice(1, -1).map((x) => x.trim());
      const who = /^(?:codex|claude|dak)(?:（(.*)）)?$/.exec(cells[0] ?? "");
      if (cells.length !== 6 || !who || !cells.slice(1).every((x) => /^\d+$/.test(x))) continue;
      const kinds = /recheck ([a-z: -]+)/.exec(who[1] ?? "");
      // a reviewer cell without a recheck is the main review, by the same runners as the main review (a DAK cell is not)
      const rules = kinds ? kinds[1]!.trim().split(" ").filter((w) => (RECHECK_KINDS as readonly string[]).includes(w)) : cells[0]!.startsWith("dak") ? [] : ["review"];
      const [, , fixed, issued, notNeeded, answered] = cells.map(Number) as [number, number, number, number, number, number];
      for (const rule of rules) rows.push({ pr: c.pr, rule, at: c.created_at, fixed, issued, notNeeded, answered });
    }
  }
  return rows;
}

/** A recheck kind's pass on a PR, at the time the rule of merge-gate's `rechecksOf` is first met. */
export interface Pass { pr: number; kind: string; at: string }
/**
 * The rule is `rechecksOf`'s (merge-gate-records.ts): a kind a command decides (`COMMAND_RECHECKS`) passes with a passing recheck job,
 * `rescue` needs a passing recheck review as well, any other kind passes with the review alone. The time is the end of the job that
 * completes it (the later of the two for `rescue`). The head is not compared: the first pass of the PR is what is wanted.
 */
export function passesOf(jobs: MergeHistoryJob[]): Pass[] {
  const out: Pass[] = [];
  for (const [pr, mine] of groupBy(jobs.filter((j) => j.endedAt !== null), (j) => String(j.pr))) {
    const first = (pred: (j: MergeHistoryJob) => boolean) => Math.min(...mine.filter(pred).map((j) => j.endedAt!));
    for (const kind of new Set(mine.flatMap(kindsOf))) {
      const cmd = first((j) => commandPassOf(j, kind));
      const review = first((j) => reviewPassOf(j, kind));
      const at = COMMAND_RECHECKS.includes(kind) ? Math.max(cmd, kind === "rescue" ? review : cmd) : review;
      if (Number.isFinite(at)) out.push({ pr: Number(pr), kind, at: githubTime(at) });
    }
  }
  return out;
}

/** The findings of a round on a path an earlier round of the same PR and rule already named (the 1st round has none). `at` is the round's. */
export function repeatPaths(rounds: Round[]): { pr: number; rule: string; round: number; at: string; path: string }[] {
  const out: { pr: number; rule: string; round: number; at: string; path: string }[] = [];
  for (const rs of groupBy(rounds, (r) => `${r.pr} ${r.rule}`).values()) {
    const seen = new Set<string>();
    [...rs].sort(byAt).forEach((r, i) => {
      for (const f of r.findings) if (i > 0 && seen.has(f.path)) out.push({ pr: r.pr, rule: r.rule, round: i + 1, at: r.at, path: f.path });
      for (const f of r.findings) seen.add(f.path);
    });
  }
  return out;
}

const tenth = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** One rule's rounds. A round and a triage summary count when their time (the summary's) is in the period; the round number counts from the PR's first round. */
export interface RoundRow {
  rule: string; prs: number; rounds: number; roundsP50: number | null; roundsMax: number | null;
  blocker: number; shouldFix: number; nit: number; question: number;
  fixed: number; issued: number; notNeeded: number; answered: number;
  repeatPath: number; untilPassP50: number | null;
}

/** The rows per rule that has a round or a triage row. `untilPassP50` is in minutes. */
export function roundRows(rounds: Round[], triage: TriageRow[], passes: Pass[], period: Period): RoundRow[] {
  const inPeriod = (at: string) => at >= period.since && at < period.until;
  const repeats = repeatPaths(rounds).filter((r) => inPeriod(r.at));
  const rules = [...new Set([...rounds.map((r) => r.rule), ...triage.map((t) => t.rule)])];
  return rules.map((rule): RoundRow => {
    const all = rounds.filter((r) => r.rule === rule);
    const mine = all.filter((r) => inPeriod(r.at));
    const perPr = [...groupBy(mine, (r) => String(r.pr)).values()];
    const count = (s: Severity) => mine.reduce((n, r) => n + r.findings.filter((f) => f.severity === s).length, 0);
    const tri = triage.filter((t) => t.rule === rule && inPeriod(t.at));
    const sum = (k: "fixed" | "issued" | "notNeeded" | "answered") => tri.reduce((n, t) => n + t[k], 0);
    const mins: number[] = [];
    for (const pr of perPr.map((x) => x[0]!.pr)) {
      const rs = all.filter((r) => r.pr === pr).sort(byAt);
      const start = Date.parse(rs[0]!.from);
      const last = rs.filter((r) => r.at < period.until).at(-1)!;
      const end = rule === "review" ? Date.parse(last.at)
        : passes.filter((p) => p.pr === pr && p.kind === rule && Date.parse(p.at) >= start && p.at < period.until).map((p) => Date.parse(p.at)).sort((a, b) => a - b)[0];
      if (end !== undefined) mins.push((end - start) / 60_000);
    }
    return {
      rule, prs: perPr.length, rounds: mine.length,
      roundsP50: median(perPr.map((x) => x.length)), roundsMax: perPr.length ? Math.max(...perPr.map((x) => x.length)) : null,
      blocker: count("blocker"), shouldFix: count("should-fix"), nit: count("nit"), question: count("question"),
      fixed: sum("fixed"), issued: sum("issued"), notNeeded: sum("notNeeded"), answered: sum("answered"),
      repeatPath: repeats.filter((r) => r.rule === rule).length, untilPassP50: tenth(median(mins)),
    };
  });
}

/** The records are read from this many days before the period, so that a PR whose rounds began just before it keeps its first rounds. */
export const LOOKBACK_DAYS = 7;

// ---- The table ----

/** A rule's line: its after-merge side and its rounds (null for a rule that has none). */
export interface TableRow { rule: string; afterMerge: AfterMergeRow | null; rounds: RoundRow | null }

/** One row per rule: the after-merge rows' order, then a rule that only has rounds. */
export function tableRows(after: AfterMergeRow[], rounds: RoundRow[]): TableRow[] {
  const rows = after.map((a): TableRow => ({ rule: a.rule, afterMerge: a, rounds: rounds.find((r) => r.rule === a.rule) ?? null }));
  return [...rows, ...rounds.filter((r) => !after.some((a) => a.rule === r.rule)).map((r): TableRow => ({ rule: r.rule, afterMerge: null, rounds: r }))];
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 1000) / 10}%`);
const dash = (n: number | null) => (n === null ? "-" : String(n));

/** A tab-separated table: a group line (拾った問題, 掛かった往復), the column names, one line per rule. */
export function format(rows: TableRow[]): string[] {
  const caught = ["自動マージ", "戻された", "監査の抜き取り", "監査の finding", "finding の率", "blocker", "should-fix", "nit", "question", "修正", "Issue 化", "対処不要", "回答"];
  const took = ["PR", "往復の中央値", "往復の最大", "同じ場所への再指摘", "合格までの分の中央値"];
  const pad = (n: number) => Array<string>(n - 1).fill("");
  return [
    ["", "拾った問題", ...pad(caught.length), "掛かった往復", ...pad(took.length)].join("\t"),
    ["決まり", ...caught, ...took].join("\t"),
    ...rows.map(({ rule, afterMerge: a, rounds: r }) => [
      rule,
      dash(a?.autoMerged ?? null), dash(a?.reverted ?? null), a?.audited ?? 0, a?.findings ?? 0, a ? pct(a.findings, a.audited) : "-",
      r?.blocker ?? 0, r?.shouldFix ?? 0, r?.nit ?? 0, r?.question ?? 0, r?.fixed ?? 0, r?.issued ?? 0, r?.notNeeded ?? 0, r?.answered ?? 0,
      r?.prs ?? 0, dash(r?.roundsP50 ?? null), dash(r?.roundsMax ?? null), r?.repeatPath ?? 0, dash(r?.untilPassP50 ?? null),
    ].join("\t")),
  ];
}

const DAY = 86_400_000;

/** A time in GitHub's form (`…T00:00:00Z`, no milliseconds), so that the period's ends and a round's time compare as strings right at midnight. */
export const githubTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The period of the last `days` days up to the end of `now`'s day (UTC). */
export function periodOf(days: number, now: number): Period {
  const until = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") + DAY;
  return { since: githubTime(until - days * DAY), until: githubTime(until) };
}

/** Where the app's records are read from (the tests give the address, the key and a fetch; a run from a terminal or a Task uses the usual ones). */
export type AppReach = { env?: Record<string, string | undefined>; fetch?: Parameters<typeof mergeHistory>[2] };

/**
 * Reads the app's records of the period (one call) and main's reverts, and builds the table. `since` is when the records begin
 * (null: none): a period before it is not in the table, and the caller says so. Nothing is asked of GitHub for this repository.
 */
export async function readTable(days: number, repo: string, now: number, run: Run, app: AppReach = {}): Promise<{ period: Period; rows: TableRow[]; since: number | null; reverts: Revert[] }> {
  const period = periodOf(days, now);
  // earlier than the period: a round that began before it has its findings and first rounds there
  const h: MergeHistory = await mergeHistory(mergeRecordsEnv(app.env ?? process.env), { repo, sinceMs: Date.parse(period.since) - LOOKBACK_DAYS * DAY }, app.fetch);
  const views = await prViewsOf(h);
  const prs = views.filter((v) => v.marks.length > 0);
  const reverts = await revertsSince(period.since, run, repo, mergeCommitsOf(views));
  const comments = h.comments.map((c): PrComment => ({ pr: c.issue, body: c.body, created_at: githubTime(Date.parse(c.createdAt)) }));
  return { period, since: h.since, reverts, rows: tableRows(afterMergeRows(prs, reverts, period), roundRows(roundsOf(h.jobs), parseTriage(comments), passesOf(h.jobs), period)) };
}

// ---- Candidates for review: a rule whose rounds do not pay ----

/** A rule is named when at least this many PRs went through it in the period, ... */
export const CANDIDATE_MIN_PRS = 3;
/** ... the median of its rounds per PR is at least this, ... */
export const CANDIDATE_MIN_ROUNDS = 2;
/** ... and the fixes per round are under this: the rounds ran, but little was fixed. */
export const CANDIDATE_MAX_FIXES_PER_ROUND = 1;

export interface Candidate { rule: string; basis: string }

/** The rules whose rounds do not pay (the three constants above), each with its counts in one sentence. It names; whether to change the rule is a person's call over the whole table. */
export function reviewCandidates(rows: TableRow[]): Candidate[] {
  const out: Candidate[] = [];
  for (const { rule, afterMerge: a, rounds: r } of rows) {
    if (!r || r.prs < CANDIDATE_MIN_PRS || (r.roundsP50 ?? 0) < CANDIDATE_MIN_ROUNDS || r.fixed / r.rounds >= CANDIDATE_MAX_FIXES_PER_ROUND) continue;
    const found = r.blocker + r.shouldFix + r.nit + r.question;
    out.push({ rule, basis: `PR ${r.prs} 件、往復の中央値 ${r.roundsP50}、${r.rounds} 回で指摘 ${found} 件・修正 ${r.fixed} 件、監査の finding ${a?.findings ?? 0}/${a?.audited ?? 0}、戻された ${a?.reverted ?? 0}` });
  }
  return out;
}

/** One line per candidate; one line saying there is none. */
export const formatCandidates = (candidates: Candidate[]): string[] =>
  candidates.length ? candidates.map((c) => `見直しの候補: ${c.rule}（${c.basis}）`) : ["見直しの候補: なし"];

export async function main(args: string[], now = Date.now(), run: Run = spawnRun, app: AppReach = {}): Promise<number> {
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
    const { period, rows, since } = await readTable(days, repo, now, run, app);
    console.log(formatSince(since));
    for (const line of format(rows)) console.log(line);
    if (json) writeFileSync(json, JSON.stringify({ period, since, rows }, null, 2));
  } catch (e) {
    console.error(`読めなかった: ${(e as Error).message}`);
    return 2;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
