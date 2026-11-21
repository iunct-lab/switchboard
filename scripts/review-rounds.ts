/**
 * bun scripts/review-rounds.ts [--days 30] [--repo <owner/name>] [--json <file>] [--pages-per-day 14] — one row per rule (each recheck kind of
 * merge-gate, the main review route `review`, and `direct`), in two groups of columns. "拾った問題" is what a rule caught:
 * the findings and what became of them (from the review comments and the triage tables), and what was found after the
 * merge (the PRs auto-merged by the kind's recheck, how many were reverted, the weekly post-merge audit; merge-audit's
 * `tally` / `auditRows`). "掛かった往復" is what it took: the rounds per PR, the findings repeated on a path an earlier
 * round already named, and the minutes until the pass. Read-only, REST only, nothing is stored.
 * Tab-separated. The kinds only a user's answer lifts have no row (no recheck runs for them).
 * Exit 0 = printed / 1 = the REST budget is too low to read / 2 = could not read or bad arguments.
 */
import { writeFileSync } from "node:fs";
import { auditRows, readHistory, spawnRun, tally, type PrRecord, type Revert, type Run } from "./merge-audit";
import { MARK_AUTHORS, RECHECK_KINDS, RECHECK_PASS, REVIEW } from "./merge-gate";
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


// ---- The rounds: from the comments of a PR (a summary closes a round; findings go to the next summary of the same runner) ----

export type Severity = "blocker" | "should-fix" | "nit" | "question";
export interface Finding { severity: Severity; path: string }
/** One round of one rule on one PR. `from` is the earliest comment of the round (its first finding, or the summary). */
export interface Round { pr: number; runner: string; rule: string; at: string; from: string; findings: Finding[] }
/** A comment as `readRounds` reduces it: the first line of the body (a triage summary keeps its table rows too). */
export interface IssueComment { pr: number; id?: number; body: string; created_at: string; author_association: string }
export interface InlineComment extends IssueComment { in_reply_to_id: number | null }

const WORDS = "[a-z][a-z:-]*(?: [a-z][a-z:-]*)*";
const SUMMARY = new RegExp(`^\\[(codex|claude|dak)\\] (review(?![\\w-])|recheck (${WORDS})(?![\\w:-]))`);
const FINDING = /^\[(codex|claude|dak)\] - \[(blocker|should-fix|nit|question)\] `([^`]+:\d+(?:-\d+)?)`/;
const kindsIn = (words: string) => words.split(" ").filter((w) => (RECHECK_KINDS as readonly string[]).includes(w));
const byAt = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/**
 * The rounds of every PR in the comments. A summary (`[<runner>] review` or `[<runner>] recheck <kinds>`, the first line)
 * closes a round, one per kind of a recheck. A finding (`[<runner>] - [<severity>] `path:line``, a general comment or the top
 * of an inline thread; replies are not findings) goes to the first summary of the same runner at or after its time; one
 * with no summary yet is not counted. A recheck of several kinds posts one summary and its findings are not told apart by
 * kind, so each kind's round counts them all. Only MARK_AUTHORS' comments count.
 */
export function parseRounds(issue: IssueComment[], inline: InlineComment[]): Round[] {
  type Item = { pr: number; runner: string; at: string; rules: string[] | null; finding: Finding | null };
  const items: Item[] = [];
  for (const c of [...issue, ...inline.filter((i) => i.in_reply_to_id == null)]) {
    if (!MARK_AUTHORS.includes(c.author_association)) continue;
    const line = c.body.split("\n")[0]!;
    const s = SUMMARY.exec(line);
    if (s) {
      // the main review is the summary merge-gate counts (`REVIEW`: codex or claude), so that its rounds and its audit fall on the same row
      const rules = s[2] === "review" ? (REVIEW.test(line) ? ["review"] : []) : kindsIn(s[3]!);
      if (rules.length) items.push({ pr: c.pr, runner: s[1]!, at: c.created_at, rules, finding: null });
      continue;
    }
    const f = FINDING.exec(line);
    if (f) items.push({ pr: c.pr, runner: f[1]!, at: c.created_at, rules: null, finding: { severity: f[2] as Severity, path: f[3]!.replace(/:\d+(?:-\d+)?$/, "") } });
  }
  const rounds: Round[] = [];
  for (const mine of groupBy(items, (i) => String(i.pr)).values()) {
    mine.sort(byAt);
    const summaries = mine.filter((i) => i.rules);
    const got = new Map<Item, { from: string; findings: Finding[] }>();
    for (const f of mine.filter((i) => i.finding)) {
      const to = summaries.find((s) => s.runner === f.runner && s.at >= f.at);
      if (!to) continue;
      const g = got.get(to) ?? { from: f.at, findings: [] };
      g.findings.push(f.finding!);
      got.set(to, g);
    }
    for (const s of summaries) {
      for (const rule of s.rules!) rounds.push({ pr: s.pr, runner: s.runner, rule, at: s.at, from: got.get(s)?.from ?? s.at, findings: got.get(s)?.findings ?? [] });
    }
  }
  return rounds.sort((a, b) => a.pr - b.pr || byAt(a, b));
}

/** What the triage summary of one round says became of its findings, for one rule. */
export interface TriageRow { pr: number; rule: string; at: string; fixed: number; issued: number; notNeeded: number; answered: number }

/**
 * The tables of the `## レビュー対応` summaries (`TRIAGE_HEADING`): per reviewer cell, `claude` / `claude（修正の見直し、2 回目）`
 * is the main review, `codex（recheck responsibility、2 回目）` is that kind (a cell of several kinds counts each in full).
 * The columns are 件数・修正・Issue 化・対処不要・回答.
 */
export function parseTriage(issue: IssueComment[]): TriageRow[] {
  const rows: TriageRow[] = [];
  for (const c of issue) {
    if (!MARK_AUTHORS.includes(c.author_association) || !c.body.startsWith("## レビュー対応")) continue;
    for (const line of c.body.split("\n").filter((l) => l.startsWith("|"))) {
      const cells = line.split("|").slice(1, -1).map((x) => x.trim());
      const who = /^(?:codex|claude|dak)(?:（(.*)）)?$/.exec(cells[0] ?? "");
      if (cells.length !== 6 || !who || !cells.slice(1).every((x) => /^\d+$/.test(x))) continue;
      const kinds = /recheck ([a-z: -]+)/.exec(who[1] ?? "");
      // a reviewer cell without a recheck is the main review, by the same runners as `REVIEW` (a DAK cell is not)
      const rules = kinds ? kindsIn(kinds[1]!.trim()) : cells[0]!.startsWith("dak") ? [] : ["review"];
      const [, , fixed, issued, notNeeded, answered] = cells.map(Number) as [number, number, number, number, number, number];
      for (const rule of rules) rows.push({ pr: c.pr, rule, at: c.created_at, fixed, issued, notNeeded, answered });
    }
  }
  return rows;
}

/** A `[recheck] <kind> pass <sha>` mark. */
export interface Pass { pr: number; kind: string; at: string }
export function parsePasses(issue: IssueComment[]): Pass[] {
  return issue.filter((c) => MARK_AUTHORS.includes(c.author_association) && RECHECK_PASS.test(c.body))
    .map((c) => ({ pr: c.pr, kind: RECHECK_PASS.exec(c.body)![1]!, at: c.created_at }));
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

// ---- Reading the comment streams ----

/** Of every comment of the repository: the first line of the body, and the table rows of a triage summary. One paginated call each. */
const ISSUE_Q = '.[] | {created_at, author_association, issue_url, html_url, body: ((.body // "") | if startswith("## レビュー対応") then (["## レビュー対応"] + [split("\\n")[] | select(startswith("|"))] | join("\\n")) else split("\\n")[0] end)}';
const INLINE_Q = '.[] | select(.in_reply_to_id == null) | {created_at, author_association, in_reply_to_id, pull_request_url, body: ((.body // "") | split("\\n")[0])}';

/** `issues/comments` and `pulls/comments` of the repository since `since` (by update; the ones created before it are dropped here). Two paginated calls, not one per PR. */
export async function readRounds(since: string, run: Run, repo: string): Promise<{ issue: IssueComment[]; inline: InlineComment[] }> {
  const lines = <T>(out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
  const read = (what: string, q: string) => run(["gh", "api", "-X", "GET", `repos/${repo}/${what}/comments`, "-f", `since=${since}`, "-f", "per_page=100", "--paginate", "-q", q]);
  const prOf = (url: string) => Number(url.split("/").at(-1));
  // the issue stream carries the comments of plain Issues too; only a pull request's page is under /pull/
  const issue = lines<IssueComment & { issue_url: string; html_url: string }>(await read("issues", ISSUE_Q))
    .filter((c) => c.created_at >= since && /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+(?:[/#?]|$)/.test(c.html_url)).map(({ html_url: _, ...c }) => ({ ...c, pr: prOf(c.issue_url) }));
  const inline = lines<InlineComment & { pull_request_url: string }>(await read("pulls", INLINE_Q)).filter((c) => c.created_at >= since).map((c) => ({ ...c, pr: prOf(c.pull_request_url) }));
  return { issue, inline };
}

/** Reading a day of the comment streams takes about this many REST calls; `--pages-per-day` overrides it for a repository with more or fewer comments. */
export const PAGES_PER_DAY = 14;

/** The comments are read from this many days before the period, so that a PR whose rounds began just before it keeps its first rounds. */
export const LOOKBACK_DAYS = 7;

/** Thrown when the REST budget (core) is under twice what reading the period is expected to take: nothing is read. */
export class LowRate extends Error {}

export async function checkRate(days: number, run: Run, pagesPerDay = PAGES_PER_DAY): Promise<void> {
  const need = 2 * pagesPerDay * (days + LOOKBACK_DAYS);
  const out = (await run(["gh", "api", "rate_limit", "-q", ".resources.core.remaining"])).trim();
  const remaining = /^\d+$/.test(out) ? Number(out) : NaN;
  if (!Number.isFinite(remaining)) throw new Error("gh api rate_limit の core の残りが読めない");
  if (remaining < need) throw new LowRate(`REST の残りが足りない（core ${remaining}、${days} 日分を読むには ${need} 以上）`);
}

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

/** The period's ends in GitHub's form (`…T00:00:00Z`, no milliseconds), so that comparing them with a comment's time as strings is right at midnight. */
export const githubTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The period of the last `days` days up to the end of `now`'s day (UTC). */
export function periodOf(days: number, now: number): Period {
  const until = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z") + DAY;
  return { since: githubTime(until - days * DAY), until: githubTime(until) };
}

/** Reads the REST budget, the history and the comment streams of the period, and builds the table. Throws LowRate when the budget is too low (nothing else is read). */
export async function readTable(days: number, repo: string, now: number, run: Run, pagesPerDay = PAGES_PER_DAY): Promise<{ period: Period; rows: TableRow[] }> {
  const period = periodOf(days, now);
  await checkRate(days, run, pagesPerDay);
  const { prs, reverts } = await readHistory(period.since, run, repo);
  // earlier than the period: a round that began before it has its findings and first rounds there, and `since` is by update
  const { issue, inline } = await readRounds(githubTime(Date.parse(period.since) - LOOKBACK_DAYS * DAY), run, repo);
  return { period, rows: tableRows(afterMergeRows(prs, reverts, period), roundRows(parseRounds(issue, inline), parseTriage(issue), parsePasses(issue), period)) };
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

export async function main(args: string[], now = Date.now(), run: Run = spawnRun): Promise<number> {
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
    const pages = Number(arg("--pages-per-day") ?? PAGES_PER_DAY);
    if (!Number.isInteger(pages) || pages < 1) throw new Error("--pages-per-day は 1 以上の整数");
    const { period, rows } = await readTable(days, repo, now, run, pages);
    for (const line of format(rows)) console.log(line);
    if (json) writeFileSync(json, JSON.stringify({ period, rows }, null, 2));
  } catch (e) {
    console.error(`${e instanceof LowRate ? "読まなかった" : "読めなかった"}: ${(e as Error).message}`);
    return e instanceof LowRate ? 1 : 2;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
