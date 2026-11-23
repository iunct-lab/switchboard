// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prViewsOf, type PrRecord, type Revert } from "./merge-audit";
import type { MergeHistory } from "../ops-kit/src/merge-records.ts";
import { RECHECK_KINDS } from "./merge-gate";
import fx from "./review-rounds.fixture.json";
import { currentRepo } from "./repo.ts";
import {
  afterMergeRows, CANDIDATE_MAX_FIXES_PER_ROUND, CANDIDATE_MIN_PRS, CANDIDATE_MIN_ROUNDS, format, formatCandidates, githubTime, main, passesOf, parseTriage, readTable, repeatPaths, reviewCandidates, roundRows, roundsOf, tableRows, type PrComment, type RoundRow,
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

  test("from the app's records of a PR, through merge-audit's prViewsOf, to the kind's row", async () => {
    const sha = "a".repeat(40);
    const gate = (id: number, verdict: "stop" | "merge", ask: string[], recheck: string[], merged: boolean) => ({ id, kind: "gate", taskId: "t", pr: 5864, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-10-09T00:00:00Z") + id * 3_600_000, endedAt: Date.parse("2026-10-09T00:00:00Z") + id * 3_600_000, repo: "o/r", head: sha, base: null, as: null, kinds: [], taskRunner: "claude", result: { gate: { verdict, head: sha, ask, recheck, reasons: recheck.map((k) => `[再チェック ${k}] x`), allowLarge: false, reviewSkipped: false, merged } } });
    const records = (grants: MergeHistory["grants"]): MergeHistory => ({
      // a stop on the kind, a recheck review that passed, the merge; and the audit's comment
      jobs: [gate(0, "stop", [], ["responsibility"], false), { ...gate(1, "stop", [], [], false), kind: "review", as: "recheck", kinds: ["responsibility"], runner: "codex", result: { review: { findings: [], firstLine: "[codex] review" } } }, gate(2, "merge", [], [], true)] as MergeHistory["jobs"],
      grants,
      pulls: [{ number: 5864, stored: true, state: "MERGED", mergedAt: at, closedAt: at, head: sha, mergeCommit: "b".repeat(40) }],
      comments: [{ issue: 5864, body: `[post-audit] finding ${"b".repeat(40)}`, createdAt: "2026-10-12T00:00:00Z", authorAssociation: "OWNER" }],
      since: Date.parse("2026-10-01T00:00:00Z"),
    });
    const [pr] = await prViewsOf(records([]));
    expect(afterMergeRows([pr!], [], period).find((r) => r.rule === "responsibility")).toEqual({ rule: "responsibility", autoMerged: 1, reverted: 0, audited: 1, findings: 1 });
    // the person's grant of the head: lifted by an answer, not by the recheck
    const [answered] = await prViewsOf(records([{ taskId: "t", target: 5864, head: sha, at: Date.parse("2026-10-09T02:00:00Z") }]));
    expect(afterMergeRows([answered!], [], period).find((r) => r.rule === "responsibility")).toMatchObject({ autoMerged: 0, audited: 0 });
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

const jobsFx = fx.jobs as MergeHistory["jobs"];
const commentsFx = fx.comments as MergeHistory["comments"];
const triageFx: PrComment[] = commentsFx.map((c) => ({ pr: c.issue, body: c.body, created_at: githubTime(Date.parse(c.createdAt)) }));
const fixturePeriod = { since: "2026-11-19T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" };

/** A review job as the app records it at its end. */
const job = (id: number, pr: number, over: Partial<MergeHistory["jobs"][number]>, findings: { severity: string; path: string; line: number }[] | null = []): MergeHistory["jobs"][number] => ({
  id, kind: "review", taskId: "t", pr, runner: "claude", status: "pass", exitCode: 0, startedAt: Date.parse("2026-11-01T00:00:00Z"), endedAt: Date.parse("2026-11-01T00:10:00Z"),
  repo: "o/r", head: SHA(1), base: null, as: null, kinds: [], taskRunner: "claude", result: findings ? { review: { findings, firstLine: "[claude] review" } } : null, ...over,
});
const finding = (path: string, severity = "nit") => ({ severity, path, line: 1 });

describe("roundsOf (the review jobs of two merged PRs, from their real review comments)", () => {
  const rounds = roundsOf(jobsFx);
  const counts = (pr: number, rule: string) => rounds.filter((r) => r.pr === pr && r.rule === rule).map((r) => r.findings.length);

  test("the responsibility recheck of one PR: 7 rounds, the first 5 with 2, 4, 1, 3, 2 findings", () => {
    const c = counts(5864, "responsibility");
    expect(c).toHaveLength(7);
    expect(c.slice(0, 5)).toEqual([2, 4, 1, 3, 2]);
  });

  test("the size recheck of another PR: the first 3 rounds with 13, 14, 15 findings", () => {
    expect(counts(5845, "size").slice(0, 3)).toEqual([13, 14, 15]);
  });

  test("a round has the findings of its own job: the claude review jobs between the codex rounds take none of codex's findings", () => {
    const claude = rounds.filter((r) => r.pr === 5845 && r.rule === "review" && r.at > "2026-11-20T01:08:22Z" && r.at < "2026-11-20T01:26:54Z");
    expect(claude.map((r) => [r.runner, r.findings.length])).toEqual([["claude", 5]]);
    expect(rounds.filter((r) => r.pr === 5845 && r.rule === "size").every((r) => r.runner === "codex")).toBe(true);
  });

  test("the main review route is `review`; a round starts when its job began", () => {
    const first = rounds.find((r) => r.pr === 5864 && r.rule === "review")!;
    expect(first.findings).toHaveLength(3);
    expect(first.from < first.at).toBe(true);
    expect(rounds.find((r) => r.pr === 5864 && r.rule === "responsibility")!.from).toBe("2026-11-19T20:11:43Z");
  });
});

describe("roundsOf (shapes)", () => {
  const rule = (js: MergeHistory["jobs"]) => roundsOf(js).map((r) => [r.rule, r.findings.length]);

  test("the main review (no `as`, or `fallback`) is the rule `review`; an audit, an attacking review, a failed job and an output with no Findings section are no round", () => {
    expect(rule([job(1, 1, {}, [finding("a.ts")]), job(2, 1, { as: "fallback", runner: "codex" }), job(3, 1, { as: "audit" }), job(4, 1, { as: "attack" }), job(5, 1, { status: "fail" }), job(6, 1, {}, null), job(7, 1, { endedAt: null })]))
      .toEqual([["review", 1], ["review", 0]]);
  });

  test("a recheck job of several kinds is one round of each kind, counting all its findings; a kind only a user's answer lifts (`limits`) is not a rule", () => {
    expect(rule([job(1, 1, { as: "recheck", kinds: ["size", "responsibility", "limits"] }, [finding("a.ts", "blocker")])])).toEqual([["size", 1], ["responsibility", 1]]);
    expect(rule([job(2, 1, { as: "recheck", kinds: ["security:docs"] }, [finding("docs/a.md", "should-fix")])])).toEqual([["security:docs", 1]]);
  });

  test("a finding whose place could not be read (no path) is not counted", () => {
    expect(roundsOf([job(1, 1, {}, [finding("", "blocker"), finding("b.ts")])])[0]!.findings).toEqual([{ severity: "nit", path: "b.ts" }]);
  });

  test("a round's times are in GitHub's form, from the job's start to its end", () => {
    expect(roundsOf([job(1, 1, { startedAt: Date.parse("2026-11-01T00:00:00.500Z"), endedAt: Date.parse("2026-11-01T00:10:00.900Z") })])[0]).toMatchObject({ from: "2026-11-01T00:00:00Z", at: "2026-11-01T00:10:00Z", pr: 1, runner: "claude" });
  });
});

describe("passesOf", () => {
  test("a passing recheck job, or a recheck review with no blocker and no should-fix; not a failed one, a review of another kind, or one with a blocker", () => {
    const passes = passesOf([
      job(1, 1, { kind: "recheck", kinds: ["migration"] }, null),
      job(2, 1, { as: "recheck", kinds: ["size", "responsibility"] }, [finding("a.ts", "nit")]),
      job(3, 1, { as: "recheck", kinds: ["rescue"] }, [finding("a.ts", "blocker")]),
      job(4, 1, { kind: "recheck", kinds: ["security:lockfile"], status: "fail" }, null),
      job(5, 1, { as: "recheck", kinds: ["design-rules"] }, null),
      job(6, 1, { kinds: ["size"] }),
    ]);
    expect(passes.map((p) => p.kind)).toEqual(["migration", "size", "responsibility"]);
    expect(passes[0]).toEqual({ pr: 1, kind: "migration", at: "2026-11-01T00:10:00Z" });
  });
});

describe("passesOf follows merge-gate's rule per kind", () => {
  const t = (hms: string) => Date.parse(`2026-11-01T${hms}Z`);
  const cmd = (id: number, kind: string, hms: string) => job(id, 1, { kind: "recheck", kinds: [kind], endedAt: t(hms) }, null);
  const rev = (id: number, kind: string, hms: string) => job(id, 1, { as: "recheck", kinds: [kind], endedAt: t(hms) }, []);

  test("rescue passes only when both its command and its review have, at the later time", () => {
    expect(passesOf([cmd(1, "rescue", "00:10:00")])).toEqual([]);
    expect(passesOf([rev(1, "rescue", "00:10:00")])).toEqual([]);
    expect(passesOf([cmd(1, "rescue", "00:10:00"), rev(2, "rescue", "00:30:00")])).toEqual([{ pr: 1, kind: "rescue", at: "2026-11-01T00:30:00Z" }]);
    expect(passesOf([rev(2, "rescue", "00:05:00"), cmd(1, "rescue", "00:10:00")])).toEqual([{ pr: 1, kind: "rescue", at: "2026-11-01T00:10:00Z" }]);
  });

  test("a command kind (migration, security:lockfile) is not passed by a review alone; a review kind is not passed by a command alone", () => {
    expect(passesOf([rev(1, "migration", "00:10:00"), rev(2, "security:lockfile", "00:10:00"), cmd(3, "size", "00:10:00")])).toEqual([]);
    expect(passesOf([cmd(1, "security:lockfile", "00:10:00")]).map((p) => p.kind)).toEqual(["security:lockfile"]);
  });
});

describe("repeatPaths and roundRows", () => {
  const rounds = roundsOf(jobsFx);

  test("a finding on a path an earlier round already named counts from the 2nd round: the out-of-scope doc of the size recheck", () => {
    const repeats = repeatPaths(rounds).filter((r) => r.pr === 5845 && r.rule === "size" && r.path === "docs/design/network-egress.md");
    expect([...new Set(repeats.map((r) => r.round))]).toEqual([2, 3, 5, 6]);
    expect(repeats.filter((r) => r.round === 2)).toHaveLength(2);
    expect(repeatPaths(rounds).filter((r) => r.round === 1)).toEqual([]);
  });

  const rows = roundRows(rounds, parseTriage(triageFx), [], fixturePeriod);
  const row = (rule: string) => rows.find((r) => r.rule === rule)!;

  test("a rule's row: PRs, rounds, findings by severity, what the triage tables say, repeats", () => {
    expect(row("responsibility")).toMatchObject({ prs: 1, roundsP50: 7, roundsMax: 7, shouldFix: 20, question: 1, blocker: 0, nit: 0, fixed: 16, notNeeded: 4, answered: 1, issued: 0 });
    expect(row("size")).toMatchObject({ prs: 1, roundsMax: 6, repeatPath: repeatPaths(rounds).filter((r) => r.rule === "size").length });
    expect(row("size")!.blocker).toBe(16);
  });

  test("the triage of one cell per rule: `claude（修正の見直し…）` is the main review", () => {
    expect(parseTriage(triageFx).filter((t) => t.pr === 5864 && t.rule === "review").map((t) => t.fixed)).toEqual([3, 2, 0, 1, 1, 1, 2]);
    expect(parseTriage(triageFx).filter((t) => t.pr === 5864 && t.rule === "responsibility")).toHaveLength(7);
    const c = (body: string): PrComment[] => [{ pr: 1, body, created_at: "2026-11-01T00:00:00Z" }];
    const multi = parseTriage(c("## レビュー対応\n| codex（recheck size responsibility、2 回目） | 3 | 1 | 1 | 1 | 0 |"));
    expect(multi.map((t) => [t.rule, t.fixed, t.issued, t.notNeeded])).toEqual([["size", 1, 1, 1], ["responsibility", 1, 1, 1]]);
    expect(parseTriage(c("## レビュー対応\n| codex（recheck security:docs） | 2 | 2 | 0 | 0 | 0 |")).map((t) => [t.rule, t.fixed])).toEqual([["security:docs", 2]]);
    const dak = parseTriage(c("## レビュー対応\n| dak | 1 | 1 | 0 | 0 | 0 |\n| dak（recheck size） | 2 | 2 | 0 | 0 | 0 |"));
    expect(dak.map((t) => [t.rule, t.fixed])).toEqual([["size", 2]]);
    // a comment that does not begin with the heading is no triage
    expect(parseTriage(c("memo\n| claude | 1 | 1 | 0 | 0 | 0 |"))).toEqual([]);
  });

  const day = { since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z" };
  const at = (hms: string) => Date.parse(`2026-11-01T${hms}Z`);

  test("minutes until the pass: a recheck from its first round's start to its pass; the main review to its last round", () => {
    const js = [
      job(1, 7, { as: "recheck", kinds: ["size"], startedAt: at("00:00:00"), endedAt: at("00:10:00") }, [finding("a.ts", "should-fix")]),
      job(2, 7, { as: "recheck", kinds: ["size"], startedAt: at("00:20:00"), endedAt: at("00:30:00") }, [finding("a.ts", "should-fix")]),
      job(3, 7, { as: "recheck", kinds: ["size"], startedAt: at("00:40:00"), endedAt: at("01:00:00") }, []),
      job(4, 7, { startedAt: at("02:00:00"), endedAt: at("02:20:00") }, [finding("a.ts")]), job(5, 7, { startedAt: at("02:30:00"), endedAt: at("03:30:00") }),
    ];
    const r = roundRows(roundsOf(js), [], passesOf(js), day);
    expect(r.find((x) => x.rule === "size")).toMatchObject({ roundsMax: 3, untilPassP50: 60 });
    expect(r.find((x) => x.rule === "review")).toMatchObject({ roundsMax: 2, untilPassP50: 90 });
  });

  test("the time until the pass ends inside the period: a later round or pass does not move it", () => {
    const js = [
      job(1, 8, { startedAt: at("23:00:00"), endedAt: at("23:30:00") }), job(2, 8, { startedAt: Date.parse("2026-11-02T04:00:00Z"), endedAt: Date.parse("2026-11-02T05:00:00Z") }),
      job(3, 8, { as: "recheck", kinds: ["size"], startedAt: at("23:00:00"), endedAt: at("23:10:00") }, [finding("a.ts", "blocker")]),
      job(4, 8, { as: "recheck", kinds: ["size"], startedAt: Date.parse("2026-11-02T00:30:00Z"), endedAt: Date.parse("2026-11-02T01:00:00Z") }, []),
    ];
    const r = roundRows(roundsOf(js), [], passesOf(js), day);
    expect(r.find((x) => x.rule === "review")).toMatchObject({ roundsMax: 1, untilPassP50: 30 });
    expect(r.find((x) => x.rule === "size")).toMatchObject({ untilPassP50: null });
  });

  test("the time until the pass is the median over the PRs, rounded after it (two PRs of 24 seconds give 0.4)", () => {
    const js = [11, 12].map((pr) => job(pr, pr, { startedAt: at("00:00:00"), endedAt: at("00:00:24") }));
    expect(roundRows(roundsOf(js), [], [], day)[0]).toMatchObject({ untilPassP50: 0.4 });
    expect(githubTime(Date.parse("2026-11-01T00:00:00Z"))).toBe("2026-11-01T00:00:00Z");
  });

  test("the period is cut by the round's end, but the round number and the repeats count from the PR's first round", () => {
    const js = [
      job(1, 7, { startedAt: Date.parse("2026-10-30T00:00:00Z"), endedAt: Date.parse("2026-10-30T00:01:00Z") }, [finding("a.ts")]),
      job(2, 7, { startedAt: at("00:00:00"), endedAt: at("00:01:00") }, [finding("a.ts")]),
    ];
    expect(roundRows(roundsOf(js), [], [], day)).toEqual([expect.objectContaining({ rule: "review", prs: 1, roundsMax: 1, nit: 1, repeatPath: 1 })]);
  });
});

describe("format and tableRows", () => {
  const rows = tableRows(afterMergeRows(prs, reverts, period), roundRows(roundsOf(jobsFx), parseTriage(triageFx), [], fixturePeriod));

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
    const only = tableRows([], roundRows(roundsOf(jobsFx), [], [], fixturePeriod));
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

/** A `run` that fails on any `gh` and answers git as a clone with no new commit on main. */
const noGh = async (cmd: string[]) => {
  if (cmd[0] === "gh") throw new Error(`gh was called: ${cmd.join(" ")}`);
  return "";
};

describe("readTable and main", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "switchboard.rr.test."));
  writeFileSync(join(dir, "key"), "k\n");
  const env = { MERGE_RECORDS_URL: "http://app.test", MERGE_RECORDS_TOKEN_FILE: join(dir, "key") };
  const records = (h: Partial<MergeHistory>) => ({ env, fetch: async () => Response.json({ jobs: [], grants: [], pulls: [], comments: [], since: null, ...h }) });
  const now = Date.parse("2026-11-20T00:00:00Z");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the table comes from the app's records with a run that fails on gh", async () => {
    const calls: string[] = [];
    const app = { env, fetch: async (url: string) => (calls.push(url), Response.json({ jobs: jobsFx, grants: [], pulls: [], comments: commentsFx, since: Date.parse("2026-11-01T00:00:00Z") })) };
    const { rows, since, period } = await readTable(3, currentRepo(), now, noGh, app);
    expect(period.since).toBe("2026-11-18T00:00:00Z");
    expect(since).toBe(Date.parse("2026-11-01T00:00:00Z"));
    // one call to the app, the history; the rounds and the triage of the fixture are in the rows
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/merge-records/history?repo=");
    expect(rows.find((r) => r.rule === "responsibility")!.rounds).toMatchObject({ prs: 1, roundsMax: 7, shouldFix: 20, fixed: 16 });
    expect(rows.find((r) => r.rule === "size")!.rounds).toMatchObject({ roundsMax: 6, blocker: 16 });
  });

  test("a revert on main of a stored PR's merge commit is that PR's (the merge commits carry the PR and its merge time)", async () => {
    const M = "4".repeat(40), R = "5".repeat(40);
    const pull = { number: 41, stored: true, state: "MERGED" as const, mergedAt: "2026-11-19T00:00:00Z", closedAt: "2026-11-19T00:00:00Z", head: "6".repeat(40), mergeCommit: M };
    const git = async (cmd: string[]) => {
      if (cmd[0] === "gh") throw new Error(`gh was called: ${cmd.join(" ")}`);
      if (cmd[1] === "log") return `${R}\t2026-11-19T06:00:00Z\tRevert "x"\n\nThis reverts commit ${M}.\n\0`;
      if (cmd[1] === "rev-parse") return `${M}\n`;
      if (cmd[1] === "cat-file") return "commit\n";
      return "";
    };
    const { reverts } = await readTable(3, currentRepo(), now, git, records({ pulls: [pull] }));
    expect(reverts.map((r) => [r.sha, r.reverted])).toEqual([[R, [41]]]);
  });

  test("bad arguments exit 2", async () => {
    expect(await main(["--days", "0"])).toBe(2);
    expect(await main(["--repo", "nope"])).toBe(2);
    expect(await main(["--json"])).toBe(2);
  });

  test("the app not answering exits 2, with nothing printed; the table's first line says when the records begin", async () => {
    expect(await main(["--days", "3", "--repo", "o/r"], now, noGh, { env, fetch: async () => { throw new Error("boom"); } })).toBe(2);
    const out: string[] = [];
    const log = console.log;
    console.log = (l: string) => void out.push(l);
    try {
      expect(await main(["--days", "3", "--json", join(dir, "rows.json")], now, noGh, records({ jobs: jobsFx, comments: commentsFx, since: Date.parse("2026-11-01T00:00:00Z") }))).toBe(0);
      expect(out[0]).toBe("記録は 2026-11-01 から");
      expect(out.find((l) => l.startsWith("responsibility\t"))!.split("\t").slice(14, 17)).toEqual(["1", "7", "7"]);
      out.length = 0;
      expect(await main(["--days", "3"], now, noGh, records({}))).toBe(0);
      expect(out[0]).toBe("記録はまだ無い");
    } finally {
      console.log = log;
    }
    const json = JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")) as { since: number; rows: { rule: string; rounds: { roundsMax: number } | null }[] };
    expect(json.since).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(json.rows.map((r) => r.rule)).toEqual(expect.arrayContaining(["responsibility", "size", "review", "direct"]));
    expect(json.rows.find((r) => r.rule === "size")!.rounds!.roundsMax).toBe(6);
  });
});
