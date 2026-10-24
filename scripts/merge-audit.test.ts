import { currentRepo } from "./repo.ts";
import { describe, expect, test } from "bun:test";
import { alreadyFiled, filedNumber } from "./file-request";
import { filingLine, main, formatProposals, gaps, formatGaps, format, parseMarks, parseReverts, period, proposals, readHistory, requestFor, revertedShas, RunError, STREAK, tally, type PrRecord, type Run } from "./merge-audit";
import fx from "./merge-audit.fixture.json";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const c = (body: string, created_at = "2026-10-02T00:00:00Z") => ({ body, created_at });

/** Replays the fixture: issues/comments as gh -q prints it (one JSON per line), pulls/<n> (404 when absent), git. */
/** offMain = commits the clone has that are not on main; onMain = commits on main beyond the fixture's; ambiguous = short sha → extra candidate commits it also matches. */
const replay = (opts: { offMain?: string[]; onMain?: string[]; ambiguous?: Record<string, string[]> } = {}): { run: Run; calls: string[][] } => {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    const [bin, ...a] = cmd;
    if (bin === "git" && a[0] === "fetch") return "";
    if (bin === "git" && a[0] === "log") return fx.log;
    const known = fx.revParse as Record<string, string>;
    const offMain = opts.offMain ?? [];
    if (bin === "git" && a[0] === "cat-file") return a[2]!.startsWith("b10b") ? "blob\n" : "commit\n";
    if (bin === "git" && a[0] === "rev-parse") {
      const short = a[1]!.replace("--disambiguate=", "");
      const extra = opts.ambiguous?.[short];
      if (extra) return [known[short], ...extra].filter(Boolean).join("\n") + "\n";
      return known[short] ? `${known[short]}\n` : offMain.find((x) => x.startsWith(short)) ? `${offMain.find((x) => x.startsWith(short))}\n` : "";
    }
    if (bin === "git" && a[0] === "merge-base") {
      if (Object.values(known).includes(a[2]!) || opts.onMain?.includes(a[2]!)) return "";
      if (offMain.includes(a[2]!)) throw new RunError("git merge-base --is-ancestor failed (exit 1): ", 1);
      throw new RunError(`git merge-base --is-ancestor failed (exit 128): fatal: Not a valid commit name ${a[2]}`, 128);
    }
    const path = a[1] === "-X" ? a[3]! : a[1]!;
    const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
    if (path.endsWith("/issues/comments")) return lines(fx.comments);
    if (path === "search/issues") return `page false ${fx.merged.length}\n${fx.merged.join("\n")}\n`;
    const own = /\/issues\/(\d+)\/comments$/.exec(path);
    if (own) return lines(fx.comments.filter((x) => x.issue_url.endsWith(`/issues/${own[1]}`)).map(({ issue_url: _, ...x }) => x));
    const pull = /\/pulls\/(\d+)$/.exec(path);
    if (pull) {
      const p = (fx.pulls as Record<string, unknown>)[pull[1]!];
      if (!p) throw new Error("gh api repos/example/development/pulls failed: gh: Not Found (HTTP 404)");
      return JSON.stringify(p);
    }
    const commit = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (commit) return JSON.stringify((fx.commitPulls as Record<string, unknown>)[commit[1]!] ?? []);
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { run, calls };
};

describe("parseMarks", () => {
  test("reads the three marks on the first line, with the comment's time", () => {
    expect(parseMarks([
      c(`[merge-ask] security,size ${SHA}\n\nPR #1 をマージしてよいか`, "2026-10-02T01:00:00Z"),
      c(`[merge-answer] no rescue ${SHA}`, "2026-10-02T02:00:00Z"),
      c(`[recheck] migration pass ${SHA}\npatch-id x`, "2026-10-02T03:00:00Z"),
    ])).toEqual([
      { kind: "ask", kinds: ["security", "size"], sha: SHA, at: "2026-10-02T01:00:00Z" },
      { kind: "no", kinds: ["rescue"], sha: SHA, at: "2026-10-02T02:00:00Z" },
      { kind: "recheck", kinds: ["migration"], sha: SHA, at: "2026-10-02T03:00:00Z" },
    ]);
  });

  test("a short sha, a mark on a later line, and unknown kinds are not marks", () => {
    expect(parseMarks([
      c(`[merge-ask] security ${SHA.slice(0, 7)}`),
      c(`see\n[merge-answer] yes security ${SHA}`),
      c(`[merge-ask] everything ${SHA}`),
      c(`[recheck] security pass ${SHA}`),
    ])).toEqual([]);
    // the kinds keep MERGE_KINDS' order and drop the unknown ones
    expect(parseMarks([c(`[merge-ask] size,bogus,rescue ${SHA}`)])[0]!.kinds).toEqual(["rescue", "size"]);
  });
});

describe("parseReverts", () => {
  test("git revert and rollback-pr both name what they take back; other lines that look alike do not", () => {
    expect(revertedShas(`Revert "x"\n\nThis reverts commit ${SHA}.\n`)).toEqual([SHA]);
    expect(revertedShas("revert: v0.9.0 に戻す\n\nv0.9.0..origin/main:\n- 5555555 feat: y (#905)\n- 6666666 fix: z\n")).toEqual(["5555555", "6666666"]);
    expect(revertedShas("fix: z\n\n- 1234567 a line that looks like a rollback's\n")).toEqual([]);
    // only the list right under `<tag>..origin/main:`; a later hand-written bullet is not a commit taken back
    expect(revertedShas("revert: v0.9.0 に戻す\n\nv0.9.0..origin/main:\n- 5555555 feat: y\n\n- deadbee note\n")).toEqual(["5555555"]);
    // prose quoting git's line is not a revert; only the line of its own
    expect(revertedShas(`docs: how a revert reads\n\nExample: This reverts commit ${SHA}.\n`)).toEqual([]);
    expect(revertedShas(`docs: x\n\nThis reverts commit ${SHA} is an example, not a revert.\n`)).toEqual([]);
    expect(revertedShas(`docs: x\n\nThis reverts commit ${SHA.slice(0, 7)}.\n`)).toEqual([]); // git writes the full sha
    expect(revertedShas(`Revert "Merge x"\n\nThis reverts commit ${SHA}, reversing\nchanges made to ${"9".repeat(40)}.\n`)).toEqual([SHA]);
  });

  test("the taken-back commits become PR numbers; a commit that reverts nothing is not a revert", () => {
    const prOf = (s: string) => ({ [SHA]: [904], "5555555": [905], "6666666": [] } as Record<string, number[]>)[s] ?? [];
    expect(parseReverts([
      { sha: "r1", at: "2026-10-03T00:00:00Z", message: `Revert "x"\n\nThis reverts commit ${SHA}.` },
      { sha: "r2", at: "2026-10-04T00:00:00Z", message: "revert: v0.9.0 に戻す\n\nv0.9.0..origin/main:\n- 6666666 fix: z\n- 5555555 feat: y\n" },
      { sha: "c3", at: "2026-10-04T00:00:00Z", message: "feat: y (#905)" },
    ], prOf)).toEqual([
      { sha: "r1", at: "2026-10-03T00:00:00Z", reverted: [904] },
      { sha: "r2", at: "2026-10-04T00:00:00Z", reverted: [905] },
    ]);
  });
});

describe("readHistory + tally (fixture)", () => {
  const P = { since: "2026-09-26T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" };

  test("reads the PRs marked or merged in the period with all their marks; skips a plain Issue, outsiders, unmarked PRs", async () => {
    const { run, calls } = replay();
    const h = await readHistory(P.since, run);
    // #910: merged in the period, its only mark from before it (read through the PR's own comments)
    expect(h.prs.map((p) => p.number)).toEqual([804, 901, 902, 903, 904, 905, 906, 910, 912, 913, 914]);
    expect(calls.some((x) => x.join(" ").includes("909"))).toBe(false); // a review comment is not a mark
    expect(calls.some((x) => x.join(" ").includes("pulls/908"))).toBe(false); // CONTRIBUTOR
    expect(calls.some((x) => x.join(" ").includes("pulls/911"))).toBe(false); // merged without a mark
    expect(calls.find((x) => x.includes("search/issues"))).toContain(`q=repo:${currentRepo()} is:pr is:merged merged:>=2026-09-26`);
    expect(h.reverts).toEqual([
      { sha: "7".repeat(40), at: "2026-10-03T00:00:00+00:00", reverted: [904] },
      { sha: "8".repeat(40), at: "2026-10-04T00:00:00+00:00", reverted: [905, 911] },
      // a revert inside a PR's branch: its pre-rebase sha is not on main, so it took no merged PR back (and is no error)
      { sha: "9".repeat(40), at: "2026-10-02T03:00:00+00:00", reverted: [] },
    ]);
  });

  test("per kind: asked, answered, the median wait, recheck merges and the reverted ones", async () => {
    const { prs, reverts } = await readHistory(P.since, replay().run);
    const rows = Object.fromEntries(tally(prs, reverts, P).map((r) => [r.kind, r]));
    expect(rows.rescue).toEqual({ kind: "rescue", asked: 1, yes: 1, no: 0, waitHours: 2, waitTotalHours: 2, recheckMerged: [], reverted: [] });
    // #901 has `[recheck] size pass` of its head too, but the user's yes lifted size: not a recheck merge
    expect(prs.find((p) => p.number === 901)!.marks.some((m) => m.kind === "recheck")).toBe(true);
    expect(rows.size).toMatchObject({ asked: 1, yes: 1, recheckMerged: [903, 910], reverted: [] });
    expect(rows["design-rules"]).toMatchObject({ asked: 1, yes: 0, no: 1, waitHours: 8 });
    // #804's mark (the recorded shape, made-up values) is of an earlier head than the one it merged at
    expect(rows.responsibility).toMatchObject({ recheckMerged: [904], reverted: [904] });
    expect(rows.migration).toMatchObject({ recheckMerged: [905], reverted: [905] });
    // #913 asked (no answer), #914 asked once and answered yes twice (one PR); #912 answered with no ask: asked 2, yes 2, waits 2h and 4h
    expect(rows.security).toMatchObject({ asked: 2, yes: 2, no: 0, waitHours: 3, recheckMerged: [] });
  });

  test("an old head's recheck mark is not a recheck merge (PR #906)", async () => {
    const { prs, reverts } = await readHistory(P.since, replay().run);
    expect(tally(prs, reverts, P).flatMap((r) => r.recheckMerged)).not.toContain(906);
  });

  test("marks before the period still give the wait and the recheck merge of a PR answered or merged in it", () => {
    const H = "2026-10-01T23:00:00Z";
    const prs = [
      { number: 1, mergedAt: "2026-10-02T05:00:00Z", headSha: SHA, marks: parseMarks([c(`[merge-ask] rescue ${SHA}`, H), c(`[merge-answer] yes rescue ${SHA}`, "2026-10-02T01:00:00Z")]) },
      { number: 2, mergedAt: "2026-10-02T05:00:00Z", headSha: SHA, marks: parseMarks([c(`[recheck] size pass ${SHA}`, H)]) },
    ];
    const rows = tally(prs, [], { since: "2026-10-02T00:00:00Z", until: "2026-10-03T00:00:00Z" });
    expect(rows.find((r) => r.kind === "rescue")).toMatchObject({ asked: 0, yes: 1, waitHours: 2 });
    expect(rows.find((r) => r.kind === "size")).toMatchObject({ recheckMerged: [2] });
  });

  test("a PR's answers count once, by its latest answer (PR #1033's shape)", () => {
    const H2 = "b".repeat(40);
    const at = (h: number) => `2026-10-02T${String(h).padStart(2, "0")}:00:00Z`;
    const marks = (last: "yes" | "no") => parseMarks([c(`[merge-ask] rescue ${SHA}`, at(1)), c(`[merge-answer] yes rescue ${SHA}`, at(3)), c(`[merge-answer] ${last} rescue ${H2}`, at(5))]);
    const period = { since: "2026-10-02T00:00:00Z", until: "2026-10-03T00:00:00Z" };
    const row = (last: "yes" | "no") => tally([{ number: 1, mergedAt: null, headSha: H2, marks: marks(last) }], [], period).find((r) => r.kind === "rescue")!;
    expect(row("yes")).toMatchObject({ asked: 1, yes: 1, no: 0, waitHours: 3, waitTotalHours: 6 }); // the waits stay per answer: 2h and 4h; the sum is how long the person was waited for in all (#1272)
    expect(row("no")).toMatchObject({ asked: 1, yes: 0, no: 1, waitHours: 3 });
  });

  test("gaps: an answer with no ask before it, and an asked PR merged without an answer", async () => {
    const { prs } = await readHistory(P.since, replay().run);
    expect(gaps(prs, P)).toEqual({ answeredWithoutAsk: [912], mergedWithoutAnswer: [913] });
    expect(formatGaps(gaps(prs, P))).toEqual(["印の欠け: 聞かずに返事 #912 / 返事なしでマージ #913"]);
    // #914 (asked, answered twice) and #901 (asked, answered) are in neither
    expect(gaps(prs, P).answeredWithoutAsk).not.toContain(914);
    expect(gaps(prs, P).mergedWithoutAnswer).not.toContain(901);
    // asked again on a new head after a yes, then merged without an answer to that ask: merged without an answer
    const H2 = "b".repeat(40);
    const again = { number: 2, mergedAt: "2026-10-02T06:00:00Z", headSha: H2, marks: parseMarks([c(`[merge-ask] rescue ${SHA}`, "2026-10-02T01:00:00Z"), c(`[merge-answer] yes rescue ${SHA}`, "2026-10-02T02:00:00Z"), c(`[merge-ask] rescue ${H2}`, "2026-10-02T04:00:00Z")]) };
    expect(gaps([again], P)).toEqual({ answeredWithoutAsk: [], mergedWithoutAnswer: [2] });
    // merged outside the period: not named; nothing missing → no line
    expect(gaps([{ ...again, mergedAt: "2026-10-05T00:00:00Z" }], P).mergedWithoutAnswer).toEqual([]);
    expect(formatGaps({ answeredWithoutAsk: [], mergedWithoutAnswer: [] })).toEqual([]);
    expect(formatGaps({ answeredWithoutAsk: [3], mergedWithoutAnswer: [] })).toEqual(["印の欠け: 聞かずに返事 #3"]);
  });

  test("合計: the waits of a kind are summed next to the median; no wait → no sum (#1272)", async () => {
    const { prs, reverts } = await readHistory(P.since, replay().run);
    const rows = Object.fromEntries(tally(prs, reverts, P).map((r) => [r.kind, r]));
    expect(rows.security).toMatchObject({ waitHours: 3, waitTotalHours: 6 }); // #914: 2h and 4h
    expect(rows.responsibility).toMatchObject({ waitHours: null, waitTotalHours: 0 });
    expect(format(tally(prs, reverts, P)).find((l) => l.startsWith("responsibility"))).toContain("返事まで 中央値 - / ");
  });

  test("案なし: the lines after the table name each proposal, or say there is none (#1272)", () => {
    expect(formatProposals([])).toEqual(["案なし"]);
    expect(formatProposals([{ to: "recheck", kind: "rescue", evidence: [1, 2, 3, 4, 5] }])[0]).toMatch(/^案: /);
  });

  test("要望: --file-request says what it did — filed, the same title already open, or nothing to file (#1272)", () => {
    expect(filingLine({ filed: 1300 })).toBe("要望: 起票した #1300");
    expect(filingLine({ filed: null })).toBe("要望: 起票した（番号は上の出力）");
    expect(filingLine({ open: 1299 })).toBe("要望: 同じ題の開いた要望 #1299 があるので起票しない");
    expect(filingLine(null)).toBe("要望: 案が無いので起票しない");
    expect(filedNumber(">> 要望を作成: #42 https://github.com/example/repo/issues/42\n>> Project に追加: #42\n")).toBe(42);
    expect(filedNumber("request_issue.sh: something else")).toBeNull();
  });

  test("outside the period nothing counts", async () => {
    const { prs, reverts } = await readHistory(P.since, replay().run);
    expect(format(tally(prs, reverts, { since: "2026-10-05T00:00:00Z", until: "2026-10-06T00:00:00Z" }))).toEqual([]);
  });

  test("format: one line per kind with something to count, in MERGE_KINDS' order", async () => {
    const { prs, reverts } = await readHistory(P.since, replay().run);
    expect(format(tally(prs, reverts, P))).toEqual([
      "security 聞いた 2 / 認めた 2 / 認めなかった 0 / 返事まで 中央値 3h（合計 6h） / 再チェックで自動マージ 0 / 戻された 0",
      "rescue 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 0 / 戻された 0",
      "design-rules 聞いた 1 / 認めた 0 / 認めなかった 1 / 返事まで 中央値 8h（合計 8h） / 再チェックで自動マージ 0 / 戻された 0",
      "size 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 2 / 戻された 0",
      "responsibility 聞いた 0 / 認めた 0 / 認めなかった 0 / 返事まで 中央値 - / 再チェックで自動マージ 1 / 戻された 1（#904）",
      "migration 聞いた 0 / 認めた 0 / 認めなかった 0 / 返事まで 中央値 - / 再チェックで自動マージ 1 / 戻された 1（#905）",
    ]);
  });

  test("an incomplete search, or one over 1,000 results, is an error rather than short counts", async () => {
    for (const page of ["page true 12", "page false 1001"]) {
      const { run } = replay();
      const short: Run = async (cmd) => (cmd.includes("search/issues") ? `${page}\n804\n` : run(cmd));
      await expect(readHistory(P.since, short)).rejects.toThrow("検索が不完全");
    }
  });

  test("a reverted commit the clone has off main takes nothing back; an ambiguous sha or a git failure is an error", async () => {
    const pre = "3".repeat(40); // the fixture's in-branch revert names it
    const { run, calls } = replay({ offMain: [pre] });
    const h = await readHistory(P.since, run);
    expect(h.reverts.find((r) => r.sha === "9".repeat(40))?.reverted).toEqual([]);
    // skipped before asking GitHub for the commit's PR (which would be the PR it was made in)
    expect(calls.some((x) => x.join(" ").includes(`commits/${pre}/pulls`))).toBe(false);
    const base = replay().run;
    const fatal: Run = async (cmd) => {
      if (cmd[1] === "merge-base") throw new RunError("git merge-base failed (exit 128): fatal: bad object", 128);
      return base(cmd);
    };
    await expect(readHistory(P.since, fatal)).rejects.toThrow("exit 128");
  });

  test("a short sha that a blob shares is still the one commit", async () => {
    const { run } = replay();
    const blob: Run = async (cmd) => (cmd[2] === "--disambiguate=5555555" ? `${"5".repeat(40)}\nb10b${"5".repeat(36)}\n` : run(cmd));
    const h = await readHistory(P.since, blob);
    expect(h.reverts.find((r) => r.sha === "8".repeat(40))?.reverted).toEqual([905, 911]);
  });

  test("an ambiguous short sha with one candidate on main is that commit", async () => {
    const other = `5555555${"a".repeat(33)}`;
    const h = await readHistory(P.since, replay({ ambiguous: { "5555555": [other] }, offMain: [other] }).run);
    expect(h.reverts.find((r) => r.sha === "8".repeat(40))?.reverted).toEqual([905, 911]);
  });

  test("an ambiguous short sha with two candidates on main is an error", async () => {
    const other = `5555555${"a".repeat(33)}`;
    await expect(readHistory(P.since, replay({ ambiguous: { "5555555": [other] }, onMain: [other] }).run)).rejects.toThrow("曖昧");
  });

  test("a failing gh call other than a PR's 404 is an error (exit 2 in the CLI)", async () => {
    const run: Run = async () => {
      throw new Error("gh api failed: HTTP 502");
    };
    await expect(readHistory(P.since, run)).rejects.toThrow("HTTP 502");
  });
});

describe("tally", () => {
  const P = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" };
  const at = (h: number, kind: "ask" | "yes", kinds = ["security"]) => ({ at: `2026-10-01T${String(h).padStart(2, "0")}:00:00Z`, kind, kinds, sha: SHA });

  test("median of an even count is the mean of the middle two", () => {
    const waits = [1, 2, 4, 10];
    const prs = waits.map((w, i) => ({ number: 1 + i, mergedAt: null, headSha: SHA, marks: [at(0, "ask"), at(w, "yes")] }));
    expect(tally(prs as PrRecord[], [], P).find((r) => r.kind === "security")?.waitHours).toBe(3);
  });

  test("a PR asked twice waits from the latest ask before the answer", () => {
    const pr = { number: 1, mergedAt: null, headSha: SHA, marks: [at(0, "ask"), at(5, "ask"), at(6, "yes")] };
    expect(tally([pr] as PrRecord[], [], P).find((r) => r.kind === "security")?.waitHours).toBe(1);
  });
});

describe("period", () => {
  const now = Date.parse("2026-10-02T15:00:00Z");
  test("the default is the last 7 days, today included", () => {
    expect(period([], now)).toEqual({ since: "2026-09-26T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" });
  });
  test("--since / --until are UTC days, until inclusive", () => {
    expect(period(["--since", "2026-09-01", "--until", "2026-09-30"], now)).toEqual({ since: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" });
    expect(() => period(["--since", "9/1"], now)).toThrow("YYYY-MM-DD");
    expect(() => period(["--since", "2026-10-01", "--until", "2026-09-01"], now)).toThrow("--until 以前");
  });
});

describe("proposals", () => {
  const SINCE = "2026-07-01T00:00:00Z";
  const W = { since: SINCE, until: "2026-10-01T00:00:00Z" };
  const at = (i: number) => `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`;
  /** One PR per answer, oldest first: the user's answer on `kind` asked with [merge-ask]. */
  const answered = (kind: string, answers: ("yes" | "no")[], from = 100): PrRecord[] =>
    answers.map((a, i) => ({
      number: from + i, mergedAt: a === "yes" ? at(i) : null, headSha: SHA,
      marks: parseMarks([c(`[merge-ask] ${kind} ${SHA}`, at(i)), c(`[merge-answer] ${a} ${kind} ${SHA}`, at(i))]),
    }));
  const rechecked = (n: number, kind: string, mergedAt = at(1)): PrRecord =>
    ({ number: n, mergedAt, headSha: SHA, marks: parseMarks([c(`[recheck] ${kind} pass ${SHA}`, mergedAt)]) });

  test("a recheck merge taken back → that kind back to asking (one is enough)", () => {
    const prs = [rechecked(1, "responsibility"), rechecked(2, "responsibility"), rechecked(3, "size")];
    const R = "7".repeat(40);
    expect(proposals(prs, [{ sha: R, at: at(5), reverted: [2] }, { sha: "8".repeat(40), at: at(6), reverted: [9] }], W))
      .toEqual([{ to: "ask", kind: "responsibility", evidence: [2], reverts: [R] }]);
    // not taken back, or merged before the look-back: nothing
    expect(proposals(prs, [], W)).toEqual([]);
    expect(proposals([rechecked(2, "responsibility", "2026-06-01T00:00:00Z")], [{ sha: "r", at: at(5), reverted: [2] }], W)).toEqual([]);
  });

  test(`the latest ${STREAK} answers on an asked kind all yes → to the recheck side`, () => {
    expect(STREAK).toBe(5);
    expect(proposals(answered("rescue", ["no", "yes", "yes", "yes", "yes", "yes"]), [], W))
      .toEqual([{ to: "recheck", kind: "rescue", evidence: [101, 102, 103, 104, 105] }]);
  });

  test("4 answers only, or a no among the latest 5 → nothing", () => {
    expect(proposals(answered("design-rules", ["yes", "yes", "yes", "yes"]), [], W)).toEqual([]);
    expect(proposals(answered("design-rules", ["yes", "yes", "no", "yes", "yes"]), [], W)).toEqual([]);
    // answers before the look-back do not count
    expect(proposals(answered("design-rules", ["yes", "yes", "yes", "yes", "yes"]), [], { ...W, since: "2026-09-12T00:00:00Z" })).toEqual([]);
    // nor answers after the window's end (a past --until)
    expect(proposals(answered("design-rules", ["yes", "yes", "yes", "yes", "yes"]), [], { ...W, until: "2026-09-12T00:00:00Z" })).toEqual([]);
  });

  test("the streak counts PRs: 5 yes on one PR (asked again after each new head) are one", () => {
    const one: PrRecord = {
      number: 7, mergedAt: at(9), headSha: SHA,
      marks: parseMarks([0, 1, 2, 3, 4].flatMap((i) => [c(`[merge-ask] rescue ${SHA}`, at(i)), c(`[merge-answer] yes rescue ${SHA}`, at(i))])),
    };
    expect(proposals([one], [], W)).toEqual([]);
    // its latest answer is what counts: 4 other PRs' yes + this one's yes make 5
    expect(proposals([one, ...answered("rescue", ["yes", "yes", "yes", "yes"], 200)], [], W)).toEqual([{ to: "recheck", kind: "rescue", evidence: [7, 200, 201, 202, 203] }]);
  });

  test("the latest answers are ordered by time, not by string", () => {
    // the same instant written with +09:00 sorts before every Z string of that day, as text
    const jp = (n: number, iso: string, offset: string): PrRecord => ({
      number: n, mergedAt: null, headSha: SHA,
      marks: parseMarks([c(`[merge-ask] rescue ${SHA}`, "2026-09-01T00:00:00Z"), { ...c(`[merge-answer] yes rescue ${SHA}`), created_at: iso.replace("Z", offset) }]),
    });
    // 1: 2026-09-20T09:00+09:00 = 00:00Z (the oldest). 2–6: 2026-09-20T02:00Z..06:00Z. As strings "…T09:00+09:00" > "…T06:00Z".
    const prs = [jp(1, "2026-09-20T09:00:00Z", "+09:00"), ...[2, 3, 4, 5, 6].map((n) => jp(n, `2026-09-20T0${n}:00:00Z`, "Z"))];
    expect(proposals(prs, [], W)).toEqual([{ to: "recheck", kind: "rescue", evidence: [2, 3, 4, 5, 6] }]);
  });

  test("a revert after the window's end (a past --until) proposes nothing, whatever git's offset", () => {
    const prs = [rechecked(2, "responsibility")];
    expect(proposals(prs, [{ sha: "r", at: "2026-10-02T00:00:00Z", reverted: [2] }], W)).toEqual([]);
    // 2026-09-30T23:30-07:00 is 2026-10-01T06:30Z: after the window that ends at 2026-10-01T00:00Z
    expect(proposals(prs, [{ sha: "r", at: "2026-09-30T23:30:00-07:00", reverted: [2] }], W)).toEqual([]);
    // 2026-10-01T08:00+09:00 is 2026-09-30T23:00Z: inside it
    expect(proposals(prs, [{ sha: "r", at: "2026-10-01T08:00:00+09:00", reverted: [2] }], W)).toEqual([{ to: "ask", kind: "responsibility", evidence: [2], reverts: ["r"] }]);
  });

  test("a PR's latest answer is the one that counts: a no then a yes is a yes, a yes then a no is a no", () => {
    const twice = (n: number, first: "yes" | "no", last: "yes" | "no"): PrRecord => ({
      number: n, mergedAt: null, headSha: SHA,
      marks: parseMarks([c(`[merge-answer] ${first} rescue ${SHA}`, at(1)), c(`[merge-answer] ${last} rescue ${SHA}`, at(2))]),
    });
    const four = answered("rescue", ["yes", "yes", "yes", "yes"], 200);
    expect(proposals([twice(7, "no", "yes"), ...four], [], W).map((p) => p.kind)).toEqual(["rescue"]);
    expect(proposals([twice(7, "yes", "no"), ...four], [], W)).toEqual([]);
  });

  test("security is never proposed, even after 5 yes", () => {
    expect(proposals(answered("security", ["yes", "yes", "yes", "yes", "yes"]), [], W)).toEqual([]);
  });

  test("a kind already on that side is not proposed (asked kinds are not taken back to asking; recheck kinds not moved to recheck)", () => {
    // a size question answered yes 5 times (asked together with rescue) is not a proposal for size
    expect(proposals(answered("rescue,size", ["yes", "yes", "yes", "yes", "yes"]), [], W).map((p) => p.kind)).toEqual(["rescue"]);
  });
});

describe("main", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const log = console.log, err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return await f();
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  const filing = () => {
    const filed: { title: string; body: string }[] = [];
    return { filed, file: async (r: { title: string; body: string }) => (filed.push(r), { filed: 1 }) };
  };

  test("no proposal → exit 0, nothing filed even with --file-request", async () => {
    const { filed, file } = filing();
    const code = await quiet(() => main(["--since", "2026-09-26", "--until", "2026-10-02", "--file-request"], replay().run, NOW, file));
    expect(code).toBe(0);
    expect(filed).toEqual([]);
  });

  test("a proposal → exit 1; --file-request files it, without the flag nothing is filed", async () => {
    const withFlag = filing();
    expect(await quiet(() => main(["--since", "2026-09-26", "--until", "2026-10-04", "--file-request"], replay().run, NOW, withFlag.file))).toBe(1);
    expect(withFlag.filed.length).toBe(1);
    const without = filing();
    expect(await quiet(() => main(["--since", "2026-09-26", "--until", "2026-10-04"], replay().run, NOW, without.file))).toBe(1);
    expect(without.filed).toEqual([]);
  });

  test("a failing read → exit 2 and nothing filed", async () => {
    const { filed, file } = filing();
    const run: Run = async () => {
      throw new Error("gh api failed: HTTP 502");
    };
    expect(await quiet(() => main(["--file-request"], run, NOW, file))).toBe(2);
    expect(filed).toEqual([]);
  });

  test("reads from min(since, until - LOOKBACK_DAYS)", async () => {
    const q = async (args: string[]) => {
      const { run, calls } = replay();
      await quiet(() => main(args, run, NOW, filing().file));
      return calls.find((x) => x.includes("search/issues"))?.find((x) => x.startsWith("q="));
    };
    // until 2026-10-02 inclusive → ends 2026-10-03; 90 days before is 2026-07-05
    expect(await q(["--since", "2026-10-01", "--until", "2026-10-02"])).toContain("merged:>=2026-07-05");
    expect(await q(["--since", "2026-01-01", "--until", "2026-10-02"])).toContain("merged:>=2026-01-01");
  });
});

describe("requestFor", () => {
  const src = { date: "2026-10-05" };
  test("the 出典 says 誰の言葉: 定期の検査 (#1818)", () => {
    expect(requestFor([{ to: "ask", kind: "size", evidence: [9] }], src)!.body).toContain("## 出典\n- 誰の言葉: 定期の検査\n");
  });
  test("none → null; the title is the same whatever the proposals' order", () => {
    expect(requestFor([], src)).toBeNull();
    const back = { to: "ask", kind: "migration", evidence: [3], reverts: ["abcdef0123456789abcdef0123456789abcdef01"] } as const;
    const a = requestFor([back, { to: "recheck", kind: "rescue", evidence: [1, 2] }], src)!;
    const b = requestFor([{ to: "recheck", kind: "rescue", evidence: [1, 2] }, back], src)!;
    expect(a.title).toBe("マージ規則の見直し: rescue を再チェックへ / migration を聞くへ");
    expect(b.title).toBe(a.title);
    expect(a.body).toContain("- rescue を再チェックへ（直近 5 件の返事がすべて認めた: #1, #2）");
    // the commit that took it back is named, to read why it was undone
    expect(a.body).toContain("- migration を聞くへ（再チェックで自動マージして戻された: #3。戻したコミット: abcdef0）");
    expect(a.body).toMatch(/^## 出典\n- 誰の言葉: 定期の検査\n`bun scripts\/merge-audit.ts --file-request`（定期実行） \/ 2026-10-05$/m);
  });

  test("already filed request is detected: the same proposals' open request is not filed again", () => {
    const title = requestFor([{ to: "ask", kind: "size", evidence: [9] }], src)!.title;
    expect(alreadyFiled(title, [{ number: 601, title: "モデル一覧の設定化" }, { number: 900, title }])).toBe(900);
    expect(alreadyFiled(title, [{ number: 901, title: `${title} / rescue を再チェックへ` }])).toBeNull();
  });
});
