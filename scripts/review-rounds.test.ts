// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prRecordOf, type PrRecord, type Revert } from "./merge-audit";
import { RECHECK_KINDS } from "./merge-gate";
import fx from "./review-rounds.fixture.json";
import {
  afterMergeRows, CANDIDATE_MAX_FIXES_PER_ROUND, CANDIDATE_MIN_PRS, CANDIDATE_MIN_ROUNDS, checkRate, format, formatCandidates, githubTime, LowRate, main, parsePasses, parseRounds, parseTriage, readRounds, repeatPaths, reviewCandidates, roundRows, tableRows, type RoundRow,
  type InlineComment, type IssueComment,
} from "./review-rounds";

const SHA = (n: number) => String(n).padStart(40, "0");
const period = { since: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" };
const at = "2026-10-10T00:00:00Z";

/** A PR merged by the responsibility recheck: ask → answer-less recheck pass on the merged head. */
const rechecked = (number: number, audit?: "pass" | "finding"): PrRecord => ({
  number, mergedAt: at, headSha: SHA(number), reviewed: false,
  marks: [
    { kind: "ask", kinds: ["responsibility"], sha: SHA(number), at: "2026-10-09T00:00:00Z" },
    { kind: "recheck", kinds: ["responsibility"], sha: SHA(number), at },
    ...(audit ? [{ kind: "post-audit" as const, kinds: [], sha: SHA(number), at: "2026-10-12T00:00:00Z", verdict: audit }] : []),
  ],
});
const plain = (number: number, reviewed: boolean, audit?: "pass" | "finding"): PrRecord => ({
  number, mergedAt: at, headSha: SHA(number), reviewed,
  marks: audit ? [{ kind: "post-audit", kinds: [], sha: SHA(number), at: "2026-10-12T00:00:00Z", verdict: audit }] : [],
});

const prs = [rechecked(1, "finding"), rechecked(2, "pass"), rechecked(3), plain(4, true, "finding"), plain(5, true, "pass"), plain(6, false, "pass")];
const reverts: Revert[] = [{ sha: "abc", at: "2026-10-15T00:00:00Z", reverted: [2] }];

describe("afterMergeRows", () => {
  const rows = afterMergeRows(prs, reverts, period);
  const row = (rule: string) => rows.find((r) => r.rule === rule)!;

  test("a recheck kind's row counts auto-merged, reverted and the audit over those PRs only", () => {
    expect(row("responsibility")).toEqual({ rule: "responsibility", autoMerged: 3, reverted: 1, audited: 2, findings: 1 });
    expect(row("size")).toEqual({ rule: "size", autoMerged: 0, reverted: 0, audited: 0, findings: 0 });
  });

  test("one row per recheck kind; a kind only a user's answer lifts has none", () => {
    expect(rows.filter((r) => r.autoMerged !== null).map((r) => r.rule).sort()).toEqual([...RECHECK_KINDS].sort());
    expect(row("limits")).toBeUndefined();
  });

  test("from a PR's comments, through merge-audit's prRecordOf, to the kind's row", async () => {
    const sha = "a".repeat(40);
    const c = (body: string, created_at: string) => ({ body, created_at, author_association: "OWNER" });
    const comments = [
      c(`[merge-ask] responsibility ${sha}\n\nPR をマージしてよいか`, "2026-10-09T00:00:00Z"),
      c(`[recheck] responsibility pass ${sha}`, "2026-10-09T01:00:00Z"),
      c(`[post-audit] finding ${sha}`, "2026-10-12T00:00:00Z"),
    ];
    const run = async () => JSON.stringify({ merged_at: at, head: { sha } });
    const pr = (await prRecordOf(5864, comments, run, "o/r"))!;
    expect(afterMergeRows([pr], [], period).find((r) => r.rule === "responsibility")).toEqual({ rule: "responsibility", autoMerged: 1, reverted: 0, audited: 1, findings: 1 });
    const answered = (await prRecordOf(5864, [...comments, c(`[merge-answer] yes responsibility ${sha}`, "2026-10-09T02:00:00Z")], run, "o/r"))!;
    expect(afterMergeRows([answered], [], period).find((r) => r.rule === "responsibility")).toMatchObject({ autoMerged: 0, audited: 0 });
  });

  test("review and direct rows are the audit of that route, without auto-merge or revert counts", () => {
    expect(row("review")).toEqual({ rule: "review", autoMerged: null, reverted: null, audited: 2, findings: 1 });
    expect(row("direct")).toEqual({ rule: "direct", autoMerged: null, reverted: null, audited: 1, findings: 0 });
  });

  test("an audit outside the period is not counted", () => {
    const old = { ...plain(7, true), marks: [{ kind: "post-audit" as const, kinds: [], sha: SHA(7), at: "2026-09-01T00:00:00Z", verdict: "finding" as const }] };
    expect(afterMergeRows([old], [], period).find((r) => r.rule === "review")).toMatchObject({ audited: 0, findings: 0 });
  });
});

const issueFx = fx.issue as IssueComment[];
const inlineFx = fx.inline as InlineComment[];
const fixturePeriod = { since: "2026-11-19T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" };

describe("parseRounds (the real comments of two merged PRs, reduced)", () => {
  const rounds = parseRounds(issueFx, inlineFx);
  const counts = (pr: number, rule: string) => rounds.filter((r) => r.pr === pr && r.rule === rule).map((r) => r.findings.length);

  test("the responsibility recheck of one PR: 7 rounds, the first 5 with 2, 4, 1, 3, 2 findings (inline threads)", () => {
    const c = counts(5864, "responsibility");
    expect(c).toHaveLength(7);
    expect(c.slice(0, 5)).toEqual([2, 4, 1, 3, 2]);
  });

  test("the size recheck of another PR: the first 3 rounds with 13, 14, 15 findings, (general comments)", () => {
    expect(counts(5845, "size").slice(0, 3)).toEqual([13, 14, 15]);
  });

  test("a finding goes to the next summary of its own runner: the claude review summaries between the codex rounds take none of codex's findings", () => {
    const claude = rounds.filter((r) => r.pr === 5845 && r.rule === "review" && r.at > "2026-11-20T01:08:22Z" && r.at < "2026-11-20T01:26:54Z");
    expect(claude.map((r) => [r.runner, r.findings.length])).toEqual([["claude", 5]]);
    expect(rounds.filter((r) => r.pr === 5845 && r.rule === "size").every((r) => r.runner === "codex")).toBe(true);
  });

  test("the main review route is `review`; a round starts at its first finding", () => {
    const first = rounds.find((r) => r.pr === 5864 && r.rule === "review")!;
    expect(first.findings).toHaveLength(3);
    expect(first.from < first.at).toBe(true);
    expect(rounds.find((r) => r.pr === 5864 && r.rule === "responsibility")!.from).toBe("2026-11-19T20:11:43Z");
  });
});

describe("parseRounds (shapes)", () => {
  const c = (pr: number, body: string, created_at: string, author_association = "MEMBER"): IssueComment => ({ pr, body, created_at, author_association });
  const reply = (body: string, at: string): InlineComment => ({ ...c(1, body, at), in_reply_to_id: 9 });

  test("a reply is not a finding, a stranger's comment is not counted, a finding with no summary yet is not counted", () => {
    const rounds = parseRounds(
      [c(1, "[codex] - [nit] `a.ts:1`", "2026-11-01T00:00:00Z"), c(1, "[claude] review（別セッション）", "2026-11-01T00:01:00Z"),
        c(1, "[claude] - [nit] `a.ts:1`", "2026-11-01T00:02:00Z", "NONE"), c(1, "[claude] review", "2026-11-01T00:03:00Z"), c(1, "[codex] - [nit] `b.ts:2`", "2026-11-01T00:04:00Z")],
      [reply("[claude] - [nit] `a.ts:1`", "2026-11-01T00:02:30Z")],
    );
    expect(rounds.map((r) => [r.runner, r.at, r.findings.length])).toEqual([["claude", "2026-11-01T00:01:00Z", 0], ["claude", "2026-11-01T00:03:00Z", 0]]);
  });

  test("a recheck of several kinds is one round of each kind, and only a merge-gate kind is a rule", () => {
    const rounds = parseRounds([c(1, "[claude] - [blocker] `a.ts:1-3`", "2026-11-01T00:00:00Z"), c(1, "[codex] recheck size responsibility（不合格）", "2026-11-01T00:00:01Z"),
      c(1, "[claude] recheck nonsense", "2026-11-01T00:00:02Z")], []);
    expect(rounds.map((r) => r.rule)).toEqual(["size", "responsibility"]);
    expect(rounds[0]!.findings).toEqual([]);
    const both = parseRounds([c(1, "[codex] - [blocker] `a.ts:1-3`", "2026-11-01T00:00:00Z"), c(1, "[codex] recheck size responsibility", "2026-11-01T00:00:01Z")], []);
    expect(both.map((r) => r.findings)).toEqual([[{ severity: "blocker", path: "a.ts" }], [{ severity: "blocker", path: "a.ts" }]]);
  });

  test("a kind with a colon (`security:docs`) is a rule, alone or with another kind", () => {
    const rounds = parseRounds([c(1, "[codex] - [should-fix] `docs/a.md:3`", "2026-11-01T00:00:00Z"), c(1, "[codex] recheck security:docs", "2026-11-01T00:00:01Z"),
      c(1, "[codex] recheck responsibility security:tests", "2026-11-01T00:00:02Z")], []);
    expect(rounds.map((r) => [r.rule, r.findings.length])).toEqual([["security:docs", 1], ["responsibility", 0], ["security:tests", 0]]);
  });
});

describe("repeatPaths and roundRows", () => {
  const rounds = parseRounds(issueFx, inlineFx);

  test("a finding on a path an earlier round already named counts from the 2nd round: the out-of-scope doc of the size recheck", () => {
    const repeats = repeatPaths(rounds).filter((r) => r.pr === 5845 && r.rule === "size" && r.path === "docs/design/network-egress.md");
    expect([...new Set(repeats.map((r) => r.round))]).toEqual([2, 3, 5, 6]);
    expect(repeats.filter((r) => r.round === 2)).toHaveLength(2);
    expect(repeatPaths(rounds).filter((r) => r.round === 1)).toEqual([]);
  });

  const rows = roundRows(rounds, parseTriage(issueFx), parsePasses(issueFx), fixturePeriod);
  const row = (rule: string) => rows.find((r) => r.rule === rule)!;

  test("a rule's row: PRs, rounds, findings by severity, what the triage tables say, repeats", () => {
    expect(row("responsibility")).toMatchObject({ prs: 1, roundsP50: 7, roundsMax: 7, shouldFix: 20, question: 1, blocker: 0, nit: 0, fixed: 16, notNeeded: 4, answered: 1, issued: 0 });
    expect(row("size")).toMatchObject({ prs: 1, roundsMax: 6, repeatPath: repeatPaths(rounds).filter((r) => r.rule === "size").length });
    expect(row("size")!.blocker).toBe(16);
  });

  test("the triage of one cell per rule: `claude（修正の見直し…）` is the main review", () => {
    expect(parseTriage(issueFx).filter((t) => t.pr === 5864 && t.rule === "review").map((t) => t.fixed)).toEqual([3, 2, 0, 1, 1, 1, 2]);
    expect(parseTriage(issueFx).filter((t) => t.pr === 5864 && t.rule === "responsibility")).toHaveLength(7);
    const multi = parseTriage([{ pr: 1, body: "## レビュー対応\n| codex（recheck size responsibility、2 回目） | 3 | 1 | 1 | 1 | 0 |", created_at: "2026-11-01T00:00:00Z", author_association: "MEMBER" }]);
    expect(multi.map((t) => [t.rule, t.fixed, t.issued, t.notNeeded])).toEqual([["size", 1, 1, 1], ["responsibility", 1, 1, 1]]);
    const colon = parseTriage([{ pr: 1, body: "## レビュー対応\n| codex（recheck security:docs） | 2 | 2 | 0 | 0 | 0 |", created_at: "2026-11-01T00:00:00Z", author_association: "MEMBER" }]);
    expect(colon.map((t) => [t.rule, t.fixed])).toEqual([["security:docs", 2]]);
    const dak = parseTriage([{ pr: 1, body: "## レビュー対応\n| dak | 1 | 1 | 0 | 0 | 0 |\n| dak（recheck size） | 2 | 2 | 0 | 0 | 0 |", created_at: "2026-11-01T00:00:00Z", author_association: "MEMBER" }]);
    expect(dak.map((t) => [t.rule, t.fixed])).toEqual([["size", 2]]);
  });

  test("minutes until the pass: a recheck from its first comment to its `[recheck] <kind> pass`; the main review to its last summary", () => {
    const c = (body: string, created_at: string): IssueComment => ({ pr: 7, body, created_at, author_association: "MEMBER" });
    const issue = [
      c("[codex] - [nit] `a.ts:1`", "2026-11-01T00:00:00Z"), c("[codex] recheck size", "2026-11-01T00:10:00Z"), c("[codex] recheck size", "2026-11-01T00:30:00Z"),
      c(`[recheck] size pass ${"a".repeat(40)}`, "2026-11-01T01:00:00Z"),
      c("[claude] - [nit] `a.ts:1`", "2026-11-01T02:00:00Z"), c("[claude] review", "2026-11-01T02:20:00Z"), c("[claude] review", "2026-11-01T03:00:00Z"),
    ];
    const r = roundRows(parseRounds(issue, []), [], parsePasses(issue), { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" });
    expect(r.find((x) => x.rule === "size")).toMatchObject({ roundsMax: 2, untilPassP50: 60 });
    expect(r.find((x) => x.rule === "review")).toMatchObject({ roundsMax: 2, untilPassP50: 60 });
  });

  test("the time until the pass ends inside the period: a later summary or pass mark does not move it", () => {
    const c = (body: string, created_at: string): IssueComment => ({ pr: 8, body, created_at, author_association: "MEMBER" });
    const issue = [
      c("[claude] - [nit] `a.ts:1`", "2026-11-01T23:00:00Z"), c("[claude] review", "2026-11-01T23:30:00Z"), c("[claude] review", "2026-11-02T05:00:00Z"),
      c("[codex] recheck size", "2026-11-01T23:00:00Z"), c(`[recheck] size pass ${"a".repeat(40)}`, "2026-11-02T01:00:00Z"),
    ];
    const r = roundRows(parseRounds(issue, []), [], parsePasses(issue), { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" });
    expect(r.find((x) => x.rule === "review")).toMatchObject({ roundsMax: 1, untilPassP50: 30 });
    expect(r.find((x) => x.rule === "size")).toMatchObject({ untilPassP50: null });
  });

  test("a finding without a line is not counted, and a DAK review is not the main review merge-gate counts", () => {
    const c = (body: string, created_at: string): IssueComment => ({ pr: 10, body, created_at, author_association: "MEMBER" });
    const rounds = parseRounds([c("[claude] - [nit] `a.ts`", "2026-11-01T00:00:00Z"), c("[claude] - [nit] `b.ts:2`", "2026-11-01T00:00:01Z"), c("[claude] review", "2026-11-01T00:00:02Z"),
      c("[dak] - [nit] `c.ts:3`", "2026-11-01T00:00:03Z"), c("[dak] review", "2026-11-01T00:00:04Z")], []);
    expect(rounds.map((r) => [r.runner, r.findings.map((f) => f.path)])).toEqual([["claude", ["b.ts"]]]);
  });

  test("the time until the pass is the median over the PRs, rounded after it (two PRs of 24 seconds give 0.4)", () => {
    const c = (pr: number, body: string, created_at: string): IssueComment => ({ pr, body, created_at, author_association: "MEMBER" });
    const issue = [11, 12].flatMap((pr) => [c(pr, "[claude] - [nit] `a.ts:1`", "2026-11-01T00:00:00Z"), c(pr, "[claude] review", "2026-11-01T00:00:24Z")]);
    expect(roundRows(parseRounds(issue, []), [], [], { since: githubTime(Date.parse("2026-11-01T00:00:00Z")), until: githubTime(Date.parse("2026-11-02T00:00:00Z")) })[0]).toMatchObject({ untilPassP50: 0.4 });
    expect(githubTime(Date.parse("2026-11-01T00:00:00Z"))).toBe("2026-11-01T00:00:00Z");
  });

  test("a kind only a user's answer lifts (`limits`) is not a rule even in a summary", () => {
    const c = (body: string, created_at: string): IssueComment => ({ pr: 9, body, created_at, author_association: "MEMBER" });
    expect(parseRounds([c("[codex] recheck limits", "2026-11-01T00:00:00Z")], [])).toEqual([]);
    // a known kind as the head of an unknown word is not that kind
    expect(parseRounds([c("[codex] - [nit] `a.ts:1`", "2026-11-01T00:00:00Z"), c("[codex] recheck size2", "2026-11-01T00:00:01Z")], [])).toEqual([]);
  });

  test("the period is cut by the summary's time, but the round number and the repeats count from the PR's first round", () => {
    const c = (body: string, created_at: string): IssueComment => ({ pr: 7, body, created_at, author_association: "MEMBER" });
    const issue = [
      c("[claude] - [nit] `a.ts:1`", "2026-10-30T00:00:00Z"), c("[claude] review", "2026-10-30T00:01:00Z"),
      c("[claude] - [nit] `a.ts:9`", "2026-11-01T00:00:00Z"), c("[claude] review", "2026-11-01T00:01:00Z"),
    ];
    const r = roundRows(parseRounds(issue, []), [], [], { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" });
    expect(r).toEqual([expect.objectContaining({ rule: "review", prs: 1, roundsMax: 1, nit: 1, repeatPath: 1 })]);
  });
});

describe("readRounds", () => {
  test("two paginated calls (issue and pull request comments, since the time), not one per PR; the PR comes from the URL; older ones and plain Issues' are dropped", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => {
      calls.push(cmd);
      return cmd.some((a) => a.endsWith("/issues/comments"))
        ? [{ id: 1, created_at: "2026-11-02T00:00:00Z", author_association: "MEMBER", issue_url: "https://api.github.com/repos/o/r/issues/12", html_url: "https://github.com/o/r/pull/12#issuecomment-1", body: "[claude] review" },
          { id: 2, created_at: "2026-10-01T00:00:00Z", author_association: "MEMBER", issue_url: "https://api.github.com/repos/o/r/issues/12", html_url: "https://github.com/o/r/pull/12#issuecomment-2", body: "[claude] review" },
          // a plain Issue's comment in the same stream is not a PR's, also when the owner or the repository is named `pull`
          { id: 4, created_at: "2026-11-02T00:00:00Z", author_association: "MEMBER", issue_url: "https://api.github.com/repos/o/r/issues/14", html_url: "https://github.com/o/r/issues/14#issuecomment-4", body: "[claude] review" },
          { id: 5, created_at: "2026-11-02T00:00:00Z", author_association: "MEMBER", issue_url: "https://api.github.com/repos/pull/15/issues/14", html_url: "https://github.com/pull/15/issues/14#issuecomment-5", body: "[claude] review" }].map((x) => JSON.stringify(x)).join("\n")
        : JSON.stringify({ id: 3, created_at: "2026-11-03T00:00:00Z", author_association: "MEMBER", in_reply_to_id: null, pull_request_url: "https://api.github.com/repos/o/r/pulls/13", body: "[codex] - [nit] `a.ts:1`" });
    };
    const got = await readRounds("2026-11-01T00:00:00.000Z", run, "o/r");
    expect(got.issue.map((c) => [c.pr, c.created_at])).toEqual([[12, "2026-11-02T00:00:00Z"]]);
    expect(got.inline.map((c) => [c.pr, c.created_at])).toEqual([[13, "2026-11-03T00:00:00Z"]]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toEqual(expect.arrayContaining(["--paginate", "since=2026-11-01T00:00:00.000Z"]));
    expect(calls.map((c) => c.find((a) => a.startsWith("repos/")))).toEqual(["repos/o/r/issues/comments", "repos/o/r/pulls/comments"]);
  });
});

describe("format and tableRows", () => {
  const rows = tableRows(afterMergeRows(prs, reverts, period), roundRows(parseRounds(issueFx, inlineFx), parseTriage(issueFx), parsePasses(issueFx), fixturePeriod));

  test("two groups; every line has the same number of columns; a rule with no rounds shows 0 and -", () => {
    const lines = format(rows);
    expect(lines[0]!.split("\t").filter(Boolean)).toEqual(["拾った問題", "掛かった往復"]);
    expect(new Set(lines.map((l) => l.split("\t").length))).toEqual(new Set([19]));
    const col = (rule: string) => Object.fromEntries(lines[1]!.split("\t").map((h, i) => [h, lines.find((l) => l.startsWith(`${rule}\t`))!.split("\t")[i]]));
    expect(col("migration")).toMatchObject({ 自動マージ: "0", "finding の率": "-", PR: "0", 往復の中央値: "-", 同じ場所への再指摘: "0" });
    expect(col("direct")).toMatchObject({ 自動マージ: "-", 監査の抜き取り: "1", PR: "0", 往復の最大: "-" });
  });

  test("the rounds of a rule with an after-merge side sit on its line (responsibility)", () => {
    const line = format(rows).find((l) => l.startsWith("responsibility\t"))!.split("\t");
    expect(line.slice(0, 6)).toEqual(["responsibility", "3", "1", "2", "1", "50%"]);
    expect(line.slice(6)).toEqual(["0", "20", "0", "1", "16", "0", "4", "1", "1", "7", "7", String(rows.find((r) => r.rule === "responsibility")!.rounds!.repeatPath), "-"]);
  });

  test("a rule that only has rounds is added after the after-merge rules", () => {
    const only = tableRows([], roundRows(parseRounds(issueFx, inlineFx), [], [], fixturePeriod));
    expect(only.map((r) => r.rule)).toEqual(["review", "size", "responsibility"]);
    expect(only.every((r) => r.afterMerge === null)).toBe(true);
  });
});

describe("reviewCandidates", () => {
  const base: RoundRow = { rule: "size", prs: 3, rounds: 6, roundsP50: 2, roundsMax: 3, blocker: 1, shouldFix: 4, nit: 2, question: 0, fixed: 5, issued: 0, notNeeded: 2, answered: 0, repeatPath: 0, untilPassP50: null };
  const named = (r: Partial<RoundRow>) => reviewCandidates([{ rule: "size", afterMerge: { rule: "size", autoMerged: 4, reverted: 1, audited: 3, findings: 2 }, rounds: { ...base, ...r } }]).map((c) => c.rule);

  test("the thresholds are 3 PRs, a median of 2 rounds, under 1 fix a round", () => {
    expect([CANDIDATE_MIN_PRS, CANDIDATE_MIN_ROUNDS, CANDIDATE_MAX_FIXES_PER_ROUND]).toEqual([3, 2, 1]);
  });

  test("fixes under 1 a round (5 in 6 rounds) is named; 1 a round (6 in 6) is not", () => {
    expect(named({})).toEqual(["size"]);
    expect(named({ fixed: 6 })).toEqual([]);
    expect(named({ fixed: 0 })).toEqual(["size"]);
  });

  test("a median of 2 rounds is named, 1 is not (a half counts: 1.5 is not)", () => {
    expect(named({ roundsP50: 2 })).toEqual(["size"]);
    expect(named({ roundsP50: 1.5 })).toEqual([]);
    expect(named({ roundsP50: 1 })).toEqual([]);
  });

  test("3 PRs are named, 2 are not; a rule with no rounds is never named", () => {
    expect(named({ prs: 3 })).toEqual(["size"]);
    expect(named({ prs: 2 })).toEqual([]);
    expect(reviewCandidates([{ rule: "direct", afterMerge: { rule: "direct", autoMerged: null, reverted: null, audited: 3, findings: 3 }, rounds: null }])).toEqual([]);
  });

  test("the basis is one sentence with the counts, the audit and the reverts; the line names the rule; none is `なし`", () => {
    const rows = [{ rule: "size", afterMerge: { rule: "size", autoMerged: 4, reverted: 1, audited: 3, findings: 2 }, rounds: base }];
    expect(formatCandidates(reviewCandidates(rows))).toEqual(["見直しの候補: size（PR 3 件、往復の中央値 2、6 回で指摘 7 件・修正 5 件、監査の finding 2/3、戻された 1）"]);
    expect(formatCandidates([])).toEqual(["見直しの候補: なし"]);
  });
});

describe("main", () => {
  test("bad arguments exit 2", async () => {
    expect(await main(["--days", "0"])).toBe(2);
    expect(await main(["--repo", "nope"])).toBe(2);
    expect(await main(["--json"])).toBe(2);
  });

  test("the REST budget under twice the expected calls: nothing else is read, exit 1", async () => {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => (calls.push(cmd), "100");
    expect(await main(["--days", "30", "--repo", "o/r"], Date.parse("2026-11-20T00:00:00Z"), run)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("rate_limit");
    await expect(checkRate(30, async () => "1035")).rejects.toBeInstanceOf(LowRate);
    await checkRate(30, async () => "1036");
    await checkRate(30, async () => "74", 1);
    await expect(checkRate(30, async () => "x")).rejects.not.toBeInstanceOf(LowRate);
    await expect(checkRate(30, async () => "")).rejects.not.toBeInstanceOf(LowRate);
  });

  test("a read failure exits 2; a run replays the fixture's comments and prints the table and the json", async () => {
    expect(await main(["--days", "3", "--repo", "o/r"], Date.parse("2026-11-20T00:00:00Z"), async () => { throw new Error("boom"); })).toBe(2);
    const lines = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n");
    const run = async (cmd: string[]) => {
      const path = cmd.find((a) => a.startsWith("repos/")) ?? "";
      if (cmd.includes("rate_limit")) return "4000";
      if (cmd.includes("search/issues")) return "page false 0";
      if (path === "repos/o/r/issues/comments") return lines(issueFx.map((c) => ({ ...c, issue_url: `https://api.github.com/repos/o/r/issues/${c.pr}`, html_url: `https://github.com/o/r/pull/${c.pr}` })));
      if (path === "repos/o/r/pulls/comments") return lines(inlineFx.map((c) => ({ ...c, pull_request_url: `https://api.github.com/repos/o/r/pulls/${c.pr}` })));
      if (/^repos\/o\/r\/issues\/\d+\/comments$/.test(path)) return lines(issueFx.filter((c) => path.includes(`/${c.pr}/`)));
      if (/^repos\/o\/r\/pulls\/\d+$/.test(path)) return JSON.stringify({ merged_at: "2026-11-19T22:31:00Z", head: { sha: "2d24ee961c492c29cd2f1f25ca78c8b2f1591770" } });
      if (path === "repos/o/r/commits") return "";
      throw new Error(`unexpected: ${cmd.join(" ")}`);
    };
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "switchboard.rr.test."));
    const out: string[] = [];
    const log = console.log;
    console.log = (l: string) => void out.push(l);
    try {
      expect(await main(["--days", "3", "--repo", "o/r", "--json", join(dir, "rows.json")], Date.parse("2026-11-20T00:00:00Z"), run)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(out.find((l) => l.startsWith("responsibility\t"))!.split("\t").slice(14, 17)).toEqual(["1", "7", "7"]);
    const json = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")) as { rows: { rule: string; rounds: { roundsMax: number } | null }[] };
    expect(json.rows.map((r) => r.rule)).toEqual(expect.arrayContaining(["responsibility", "size", "review", "direct"]));
    expect(json.rows.find((r) => r.rule === "size")!.rounds!.roundsMax).toBe(6);
    rmSync(dir, { recursive: true });
  });
});
