import { currentRepo } from "./repo.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyFiled, filedNumber } from "./file-request";
import { auditRows, filingLine, formatAudit, formatSince, formatUnsaved, main, formatProposals, gaps, formatGaps, format, parseReverts, period, prViewsOf, proposals, readHistory, requestFor, revertedShas, revertsSince, routeOf, RunError, tally, type Mark, type PrRecord, type Run } from "./merge-audit";
import type { MergeHistory } from "../ops-kit/src/merge-records.ts";
import fx from "./merge-audit.fixture.json";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const c = (body: string, created_at = "2026-10-02T00:00:00Z") => ({ body, created_at });

/** The marks the tallies count, written the way the tests say them (`[merge-ask] <kinds> <sha>` …): a test-only way to build `Mark`s, which the app's records produce in the code (`prViewsOf`). */
function parseMarks(comments: { body: string; created_at: string }[]): Mark[] {
  const marks: Mark[] = [];
  for (const { body, created_at: at } of comments) {
    let m: RegExpExecArray | null;
    const kinds = (list: string) => list.split(",");
    if ((m = /^\[merge-ask\] (\S+) ([0-9a-f]{40})/.exec(body))) marks.push({ kind: "ask", kinds: kinds(m[1]!) as Mark["kinds"], sha: m[2]!, at });
    else if ((m = /^\[merge-answer\] (yes|no) (\S+) ([0-9a-f]{40})/.exec(body))) marks.push({ kind: m[1] as "yes" | "no", kinds: kinds(m[2]!) as Mark["kinds"], sha: m[3]!, at });
    else if ((m = /^\[recheck\] (\S+) pass ([0-9a-f]{40})/.exec(body))) marks.push({ kind: "recheck", kinds: [m[1]!] as Mark["kinds"], sha: m[2]!, at });
    else if ((m = /^\[post-audit\] (pass|finding) ([0-9a-f]{40})/.exec(body))) marks.push({ kind: "post-audit", kinds: [], sha: m[2]!, at, verdict: m[1] as "pass" | "finding" });
  }
  return marks;
}

/** The fixture was recorded when a review run as `recheck` lifted a kind: the same jobs as the arbiter's pass, which is how the gate lifts a kind now. */
const arbitrated = (jobs: MergeHistory["jobs"]): MergeHistory["jobs"] => jobs.map((j) => j.kind === "review" && j.as === "recheck"
  ? { ...j, as: "arbiter", kinds: [], result: { review: { findings: [], firstLine: "[claude] arbiter", rulings: { reviewerSide: [], missing: [], unreadable: [] } } } }
  : j);
const history = { ...(fx.history as unknown as MergeHistory), jobs: arbitrated((fx.history as unknown as MergeHistory).jobs) };

/** The app, as the tests' fetch sees it: it answers the history the fixture holds and writes down what it was asked. */
const app = (h: MergeHistory = history) => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-merge-audit-"));
  writeFileSync(join(dir, "key"), "k\n");
  const urls: string[] = [];
  const f = async (url: string) => (urls.push(url), Response.json(h));
  return { env: { MERGE_RECORDS_URL: "http://app.test", MERGE_RECORDS_TOKEN_FILE: join(dir, "key") }, f, urls, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * Replays main's commits as git prints them. A call to gh fails: this repository's tables ask GitHub nothing.
 * offMain = commits the clone has that are not on main; onMain = commits on main beyond the fixture's; ambiguous = short sha → extra candidate commits it also matches.
 */
const replay = (opts: { offMain?: string[]; onMain?: string[]; ambiguous?: Record<string, string[]> } = {}): { run: Run; calls: string[][] } => {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    const [bin, ...a] = cmd;
    if (bin === "gh") throw new Error(`gh must not be called: ${cmd.join(" ")}`);
    if (bin === "git" && a[0] === "fetch") return "";
    if (bin === "git" && a[0] === "log" && a.includes("-1")) return "2026-10-02T00:00:00+00:00\n";
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
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { run, calls };
};

/** Another repository: main's commits come from `commits` (REST) and a short sha from `commits/<sha>` + `compare` (the API; this clone has no such history). */
const replayRemote = (compare = "ahead"): { run: Run; calls: string[][] } => {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    const path = cmd[1] === "api" ? (cmd[2] === "-X" ? cmd[4]! : cmd[2]!) : "";
    if (cmd[0] === "gh" && /\/commits$/.test(path)) return fx.log.split("\0").map((x) => x.replace(/^\n/, "")).filter(Boolean).map((x) => {
      const [sha, at, ...message] = x.split("\t");
      return JSON.stringify({ sha, at, message: message.join("\t") });
    }).join("\n") + "\n";
    const short = /\/commits\/([0-9a-f]{7,40})$/.exec(path)?.[1];
    if (short) return `${(fx.revParse as Record<string, string>)[short] ?? short.padEnd(40, "0")}\n`;
    if (/\/compare\//.test(path)) return `${compare}\n`;
    const commit = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
    if (commit) return JSON.stringify((fx.commitPulls as Record<string, unknown>)[commit[1]!] ?? []);
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  return { run, calls };
};

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

/** `readHistory` over the fixture's records and the replayed git; a gh call fails. */
const read = async (since: string, run: Run = replay().run, repo = currentRepo()) => {
  const a = app();
  try {
    return await readHistory(since, run, repo, a.env, a.f);
  } finally {
    a.done();
  }
};

describe("readHistory + tally (fixture)", () => {
  const P = { since: "2026-09-26T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" };

  test("reads the PRs with marks from the app's records and the reverts from main, and asks gh nothing", async () => {
    const a = app();
    const { run, calls } = replay();
    try {
      const h = await readHistory(P.since, run, currentRepo(), a.env, a.f);
      // the PRs with something to count: PR 906 (only the recheck of an earlier head), PR 911 (no job) and PR 930 (never stored) have no mark
      expect(h.prs.map((p) => p.number)).toEqual([901, 902, 903, 904, 905, 910, 912, 913, 914, 921, 922, 923, 924]);
      expect(h.unsaved).toEqual([{ number: 930, mergedAt: "2026-10-02T06:00:00.000Z" }, { number: 931, mergedAt: "2026-07-20T00:00:00.000Z" }]);
      expect(h.since).toBe((fx.history as { since: number }).since);
      expect(a.urls).toEqual([`http://app.test/api/merge-records/history?repo=${encodeURIComponent(currentRepo())}&since=${Date.parse(P.since)}`]);
      expect(calls.some((x) => x[0] === "gh")).toBe(false);
      expect(h.reverts).toEqual([
        { sha: "7".repeat(40), at: "2026-10-03T00:00:00+00:00", reverted: [904] },
        { sha: "8".repeat(40), at: "2026-10-04T00:00:00+00:00", reverted: [905, 911] },
        // a revert inside a PR's branch: its pre-rebase sha is not on main, so it took no merged PR back (and is no error)
        { sha: "9".repeat(40), at: "2026-10-02T03:00:00+00:00", reverted: [] },
      ]);
    } finally {
      a.done();
    }
  });

  test("the marks come from the verdicts, the grants and the recheck records of each head", async () => {
    const by = new Map((await prViewsOf(history)).map((v) => [v.number, v]));
    const kinds = (n: number) => by.get(n)!.marks.filter((m) => m.kind !== "post-audit").map((m) => [m.kind, m.kinds, m.at]);
    // asked (the ask and the recheck kinds left), then the person's grant of the head; the merge verdict that lifted it asks nothing new
    expect(kinds(901)).toEqual([["ask", ["rescue", "size"], "2026-10-02T01:00:00.000Z"], ["yes", ["rescue", "size"], "2026-10-02T03:00:00.000Z"]]);
    // asked, then the PR went on at another head with no grant: not answered
    expect(kinds(902)).toEqual([["ask", ["design-rules"], "2026-10-02T01:00:00.000Z"], ["no", ["design-rules"], "2026-10-02T09:00:00.000Z"]]);
    // merged by its recheck: the kind the verdicts stopped for, and a passing record of the merged head
    expect(kinds(903)).toEqual([["recheck", ["size"], "2026-10-02T02:20:00.000Z"]]);
    expect(kinds(905)).toEqual([["recheck", ["migration"], "2026-10-02T02:20:00.000Z"]]);
    // the recheck passed an earlier head only
    expect(kinds(906)).toEqual([]);
    // a grant with no verdict that stopped before it: a yes with the kinds the lifting verdict named, and no ask
    expect(kinds(912)).toEqual([["yes", ["security:words"], "2026-10-02T04:00:00.000Z"]]);
    expect(kinds(913)).toEqual([["ask", ["security:words"], "2026-10-02T04:00:00.000Z"]]);
    // a grant from before the records began is no answer without an ask: with the records beginning at 04:30, PR 912's grant (04:00) is dropped, PR 914's second one (05:00) stays
    const late = new Map((await prViewsOf({ ...history, since: Date.parse("2026-10-02T04:30:00Z") })).map((v) => [v.number, v]));
    expect(late.get(912)!.marks).toEqual([]);
    expect(late.get(914)!.marks.filter((m) => m.kind === "yes").map((m) => m.at)).toEqual(["2026-10-02T05:00:00.000Z"]);
    expect(by.get(930)).toMatchObject({ stored: false, mergedAt: "2026-10-02T06:00:00.000Z" });
    expect(by.get(904)).toMatchObject({ headSha: "d".repeat(40), mergeSha: "4".repeat(40), implementer: "claude", audited: false });
    expect(by.get(923)!.audited).toBe(true);
  });

  test("a recheck merge counts the kinds a verdict at the head required, whether the recheck came before it or after; an unreadable audit job is no audit", async () => {
    const H = "7a".repeat(20);
    const job = (id: number, over: object) => ({ id, kind: "gate", taskId: "t", pr: 7, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, endedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, repo: "o/r", head: H, base: null, as: null, kinds: [], result: null, taskRunner: "claude", ...over });
    const verdict = { gate: { verdict: "merge", head: H, ask: [], recheck: [], reasons: [], allowLarge: false, reviewSkipped: false, merged: true } };
    // the recheck passed before the verdict: its reason never appears, the kind is only in `required`
    verdict.gate = { ...verdict.gate, required: ["size"] } as typeof verdict.gate;
    // an older record (no `required`) is read by its reasons
    const stop = { gate: { ...verdict.gate, required: undefined, verdict: "stop", recheck: ["size"], reasons: ["[再チェック size] a"], merged: false } };
    const records = (extra: object[]): MergeHistory => ({
      jobs: [job(1, { kind: "review", runner: "codex", as: "arbiter", result: { review: { findings: [], firstLine: "[codex] arbiter", rulings: { reviewerSide: [], missing: [], unreadable: [] } } } }), job(2, { kind: "review", runner: "codex", result: { review: { findings: [], firstLine: "[codex] review" } } }), job(3, { result: verdict }), ...extra] as MergeHistory["jobs"],
      grants: [], pulls: [{ number: 7, stored: true, state: "MERGED", mergedAt: "2026-10-02T01:00:00Z", closedAt: null, head: H, mergeCommit: "c".repeat(40) }], comments: [], since: Date.parse("2026-10-01T00:00:00Z"),
    });
    const [pr] = await prViewsOf(records([]));
    expect(pr!.marks.filter((m) => m.kind === "recheck").map((m) => m.kinds)).toEqual([["size"]]);
    expect(routeOf(pr!)).toBe("recheck");
    // a recheck record for a kind the verdict did not require (it was run needlessly) is no recheck merge
    const needless = records([job(5, { kind: "recheck", kinds: ["migration"] })]);
    expect((await prViewsOf(needless))[0]!.marks.filter((m) => m.kind === "recheck").map((m) => m.kinds)).toEqual([["size"]]);
    // an older verdict record with no `required`: the kinds its reasons named (a stop that named it, then the merge)
    const older = records([]);
    older.jobs = [...older.jobs.filter((j) => j.id !== 3), job(0, { result: stop }), job(3, { result: { gate: { ...verdict.gate, required: undefined } } })] as MergeHistory["jobs"];
    expect((await prViewsOf(older))[0]!.marks.filter((m) => m.kind === "recheck").map((m) => m.kinds)).toEqual([["size"]]);
    older.jobs = older.jobs.filter((j) => j.id !== 0);
    expect((await prViewsOf(older))[0]!.marks.filter((m) => m.kind === "recheck")).toEqual([]);
    // the app's audit job is the record of an audit when it read the merge commit and kept pass or finding as its first line;
    // only a pass settles the PR here: a finding is `auditFound` (post-audit settles it once its PBI is in the backlog)
    const audit = (over: object) => job(4, { kind: "review", as: "audit", runner: "claude", taskId: "t_audit", head: "c".repeat(40), result: { review: { findings: [], firstLine: "finding" } }, ...over });
    const audited = async (x: object) => (await prViewsOf(records([audit(x)])))[0]!;
    const found = await audited({});
    expect([found.audited, found.auditFound, found.marks.filter((m) => m.kind === "post-audit").map((m) => [m.verdict, m.sha])]).toEqual([false, true, [["finding", "c".repeat(40)]]]);
    const passed = await audited({ result: { review: { findings: [], firstLine: "pass" } } });
    expect([passed.audited, passed.auditFound, passed.marks.filter((m) => m.kind === "post-audit").map((m) => [m.verdict, m.sha])]).toEqual([true, false, [["pass", "c".repeat(40)]]]);
    // asked for by the Task that asked for the PR's other jobs (the one that implemented it): no audit
    const own = await audited({ taskId: "t", result: { review: { findings: [], firstLine: "pass" } } });
    expect([own.audited, own.auditFound, own.marks.filter((m) => m.kind === "post-audit")]).toEqual([false, false, []]);
    // not another commit's audit, not an output that is neither word, not one that left no result, not one that failed
    for (const x of [{ head: H }, { result: { review: { findings: [], firstLine: "looks fine" } } }, { result: null }, { status: "fail" }]) expect([(await audited(x)).audited, (await audited(x)).marks.filter((m) => m.kind === "post-audit")]).toEqual([false, []]);
    // no job names the Task's runner: the other of the main reviewer's, else unknown
    expect((await prViewsOf(records([])).then((v) => v.map((x) => x.implementer)))).toEqual(["claude"]);
    const noTask = records([]);
    noTask.jobs = noTask.jobs.map((j) => ({ ...j, taskRunner: null }));
    expect((await prViewsOf(noTask))[0]!.implementer).toBe("claude");
    noTask.jobs = noTask.jobs.filter((j) => j.kind !== "review" || j.as === "arbiter").map((j) => ({ ...j, runner: null }));
    expect((await prViewsOf(noTask))[0]!.implementer).toBeNull();
  });

  test("a stop for another reason after the person's grant lifted the ask is not asked again", async () => {
    const H = "8a".repeat(20);
    const gate = (id: number, verdict: "stop" | "merge", over: object) => ({ id, kind: "gate", taskId: "t", pr: 8, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, endedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, repo: "o/r", head: H, base: null, as: null, kinds: [], taskRunner: "claude", result: { gate: { verdict, head: H, ask: ["rescue"], recheck: [], reasons: [], allowLarge: false, reviewSkipped: false, merged: false, ...over } } });
    const h: MergeHistory = {
      // asked; the person said yes; then the lifted verdict stopped on CI (the ask stays in its record because it was lifted)
      jobs: [gate(1, "stop", {}), gate(3, "stop", { allowLarge: true, reasons: ["CI のチェックが 1 つも無い"] })] as MergeHistory["jobs"],
      grants: [{ taskId: "t", target: 8, head: H, at: Date.parse("2026-10-02T00:00:02Z") }],
      pulls: [{ number: 8, stored: true, state: "OPEN", mergedAt: null, closedAt: null, head: H, mergeCommit: null }], comments: [], since: Date.parse("2026-10-01T00:00:00Z"),
    };
    const asks = async (x: MergeHistory) => (await prViewsOf(x))[0]!.marks.filter((m) => m.kind === "ask").map((m) => m.at);
    expect(await asks(h)).toEqual(["2026-10-02T00:00:01.000Z"]);
    // only the lifted stop is recorded (its ask was lifted by the person's grant of the head): it is no ask
    expect(await asks({ ...h, jobs: h.jobs.slice(1) })).toEqual([]);
    // no grant of the head: the same stop is an ask; a grant without --allow-large lifted nothing
    expect(await asks({ ...h, jobs: h.jobs.slice(1), grants: [] })).toHaveLength(1);
    expect(await asks({ ...h, jobs: [gate(3, "stop", { allowLarge: false })] as MergeHistory["jobs"] })).toHaveLength(1);
  });

  test("per kind: asked, answered, the median wait, recheck merges and the reverted ones", async () => {
    const { prs, reverts } = await read(P.since);
    const rows = Object.fromEntries(tally(prs, reverts, P).map((r) => [r.kind, r]));
    expect(rows.rescue).toEqual({ kind: "rescue", asked: 1, yes: 1, no: 0, waitHours: 2, waitTotalHours: 2, recheckMerged: [], reverted: [] });
    // `#901` was asked size too and the person said yes: not a recheck merge
    expect(prs.find((p) => p.number === 901)!.marks.some((m) => m.kind === "recheck")).toBe(false);
    expect(rows.size).toMatchObject({ asked: 1, yes: 1, recheckMerged: [903, 910], reverted: [] });
    expect(rows["design-rules"]).toMatchObject({ asked: 1, yes: 0, no: 1, waitHours: 8 });
    expect(rows.responsibility).toMatchObject({ recheckMerged: [904], reverted: [904] });
    expect(rows.migration).toMatchObject({ recheckMerged: [905], reverted: [905] });
    // `#913` asked (no answer), `#914` asked once and answered yes twice (one PR); `#912` answered with no ask: asked 2, yes 2, waits 2h and 4h
    expect(rows["security:words"]).toMatchObject({ asked: 2, yes: 2, no: 0, waitHours: 3, recheckMerged: [] });
  });

  test("a recheck record of an earlier head is not a recheck merge", async () => {
    const { prs, reverts } = await read(P.since);
    expect(tally(prs, reverts, P).flatMap((r) => r.recheckMerged)).not.toContain(906);
  });

  test("marks before the period still give the wait and the recheck merge of a PR answered or merged in it", () => {
    const H = "2026-10-01T23:00:00Z";
    const prs = [
      { number: 1, mergedAt: "2026-10-02T05:00:00Z", headSha: SHA, reviewed: true, marks: parseMarks([c(`[merge-ask] rescue ${SHA}`, H), c(`[merge-answer] yes rescue ${SHA}`, "2026-10-02T01:00:00Z")]) },
      { number: 2, mergedAt: "2026-10-02T05:00:00Z", headSha: SHA, reviewed: true, marks: parseMarks([c(`[recheck] size pass ${SHA}`, H)]) },
    ];
    const rows = tally(prs, [], { since: "2026-10-02T00:00:00Z", until: "2026-10-03T00:00:00Z" });
    expect(rows.find((r) => r.kind === "rescue")).toMatchObject({ asked: 0, yes: 1, waitHours: 2 });
    expect(rows.find((r) => r.kind === "size")).toMatchObject({ recheckMerged: [2] });
  });

  test("a PR's answers count once, by its latest answer (one ask, answered again on a new head)", () => {
    const H2 = "b".repeat(40);
    const at = (h: number) => `2026-10-02T${String(h).padStart(2, "0")}:00:00Z`;
    const marks = (last: "yes" | "no") => parseMarks([c(`[merge-ask] rescue ${SHA}`, at(1)), c(`[merge-answer] yes rescue ${SHA}`, at(3)), c(`[merge-answer] ${last} rescue ${H2}`, at(5))]);
    const period = { since: "2026-10-02T00:00:00Z", until: "2026-10-03T00:00:00Z" };
    const row = (last: "yes" | "no") => tally([{ number: 1, mergedAt: null, headSha: H2, reviewed: true, marks: marks(last) }], [], period).find((r) => r.kind === "rescue")!;
    expect(row("yes")).toMatchObject({ asked: 1, yes: 1, no: 0, waitHours: 3, waitTotalHours: 6 }); // the waits stay per answer: 2h and 4h; the sum is how long the person was waited for in all
    expect(row("no")).toMatchObject({ asked: 1, yes: 0, no: 1, waitHours: 3 });
  });

  test("gaps: an answer with no ask before it, and an asked PR merged without an answer", async () => {
    const { prs } = await read(P.since);
    expect(gaps(prs, P)).toEqual({ answeredWithoutAsk: [912], mergedWithoutAnswer: [913] });
    expect(formatGaps(gaps(prs, P))).toEqual(["印の欠け: 聞かずに返事 #912 / 返事なしでマージ #913"]);
    // `#914` (asked, answered twice) and `#901` (asked, answered) are in neither
    expect(gaps(prs, P).answeredWithoutAsk).not.toContain(914);
    expect(gaps(prs, P).mergedWithoutAnswer).not.toContain(901);
    // asked again on a new head after a yes, then merged without an answer to that ask: merged without an answer
    const H2 = "b".repeat(40);
    const again = { number: 2, mergedAt: "2026-10-02T06:00:00Z", headSha: H2, reviewed: true, marks: parseMarks([c(`[merge-ask] rescue ${SHA}`, "2026-10-02T01:00:00Z"), c(`[merge-answer] yes rescue ${SHA}`, "2026-10-02T02:00:00Z"), c(`[merge-ask] rescue ${H2}`, "2026-10-02T04:00:00Z")]) };
    expect(gaps([again], P)).toEqual({ answeredWithoutAsk: [], mergedWithoutAnswer: [2] });
    // merged outside the period: not named; nothing missing → no line
    expect(gaps([{ ...again, mergedAt: "2026-10-05T00:00:00Z" }], P).mergedWithoutAnswer).toEqual([]);
    expect(formatGaps({ answeredWithoutAsk: [], mergedWithoutAnswer: [] })).toEqual([]);
    expect(formatGaps({ answeredWithoutAsk: [3], mergedWithoutAnswer: [] })).toEqual(["印の欠け: 聞かずに返事 #3"]);
  });

  test("合計: the waits of a kind are summed next to the median; no wait → no sum", async () => {
    const { prs, reverts } = await read(P.since);
    const rows = Object.fromEntries(tally(prs, reverts, P).map((r) => [r.kind, r]));
    expect(rows["security:words"]).toMatchObject({ waitHours: 3, waitTotalHours: 6 }); // 2h and 4h
    expect(rows.responsibility).toMatchObject({ waitHours: null, waitTotalHours: 0 });
    expect(format(tally(prs, reverts, P)).find((l) => l.startsWith("responsibility"))).toContain("返事まで 中央値 - / ");
  });

  test("案なし: the lines after the table name each proposal, or say there is none", () => {
    expect(formatProposals([])).toEqual(["案なし"]);
    expect(formatProposals([{ kind: "size", evidence: [1], reverts: ["abcdef0"], audited: [] }])[0]).toMatch(/^案: /);
  });

  test("要望: --file-request says what it did — filed, the same title already open, or nothing to file", () => {
    expect(filingLine({ filed: 1300 })).toBe("要望: 起票した #1300");
    expect(filingLine({ filed: null })).toBe("要望: 起票した（番号は上の出力）");
    expect(filingLine({ open: "#1299" })).toBe("要望: 同じ題の開いた要望 #1299 があるので起票しない");
    expect(filingLine({ open: "op_7f3a" })).toBe("要望: 同じ題の開いた要望 op_7f3a があるので起票しない");
    expect(filingLine(null)).toBe("要望: 案が無いので起票しない");
    expect(filedNumber(">> 要望を作成: #42 https://github.com/example/repo/issues/42\n>> Project に追加: #42\n")).toBe(42);
    expect(filedNumber("request_issue.sh: something else")).toBeNull();
  });

  test("outside the period nothing counts", async () => {
    const { prs, reverts } = await read(P.since);
    expect(format(tally(prs, reverts, { since: "2026-10-05T00:00:00Z", until: "2026-10-06T00:00:00Z" }))).toEqual([]);
  });

  test("format: one line per kind with something to count, in MERGE_KINDS' order", async () => {
    const { prs, reverts } = await read(P.since);
    expect(format(tally(prs, reverts, P))).toEqual([
      "security:words 聞いた 2 / 認めた 2 / 認めなかった 0 / 返事まで 中央値 3h（合計 6h） / 再チェックで自動マージ 0 / 戻された 0",
      "rescue 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 0 / 戻された 0",
      "design-rules 聞いた 1 / 認めた 0 / 認めなかった 1 / 返事まで 中央値 8h（合計 8h） / 再チェックで自動マージ 0 / 戻された 0",
      "size 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 2 / 戻された 0",
      "responsibility 聞いた 0 / 認めた 0 / 認めなかった 0 / 返事まで 中央値 - / 再チェックで自動マージ 1 / 戻された 1（#904）",
      "migration 聞いた 0 / 認めた 0 / 認めなかった 0 / 返事まで 中央値 - / 再チェックで自動マージ 1 / 戻された 1（#905）",
    ]);
  });

  test("the app not answering is an error rather than empty counts", async () => {
    const a = app();
    try {
      await expect(readHistory(P.since, replay().run, currentRepo(), a.env, async () => new Response("{}", { status: 500 }))).rejects.toThrow("backlog: 500");
      await expect(readHistory(P.since, replay().run, currentRepo(), a.env, async () => Response.json({ jobs: [] }))).rejects.toThrow("no history");
    } finally {
      a.done();
    }
  });

  test("a reverted commit the clone has off main takes nothing back; an ambiguous sha or a git failure is an error", async () => {
    const pre = "3".repeat(40); // the fixture's in-branch revert names it
    const { run, calls } = replay({ offMain: [pre] });
    const h = await read(P.since, run);
    expect(h.reverts.find((r) => r.sha === "9".repeat(40))?.reverted).toEqual([]);
    // skipped before looking for the commit's PR (which would be the PR it was made in)
    expect(calls.some((x) => x.join(" ").includes("rev-list") || x.join(" ").includes(pre) && x[1] === "log")).toBe(false);
    const base = replay().run;
    const fatal: Run = async (cmd) => {
      if (cmd[1] === "merge-base") throw new RunError("git merge-base failed (exit 128): fatal: bad object", 128);
      return base(cmd);
    };
    await expect(read(P.since, fatal)).rejects.toThrow("exit 128");
  });

  test("a short sha that a blob shares is still the one commit", async () => {
    const { run } = replay();
    const blob: Run = async (cmd) => (cmd[2] === "--disambiguate=5555555" ? `${"5".repeat(40)}\nb10b${"5".repeat(36)}\n` : run(cmd));
    const h = await read(P.since, blob);
    expect(h.reverts.find((r) => r.sha === "8".repeat(40))?.reverted).toEqual([905, 911]);
  });

  test("an ambiguous short sha with one candidate on main is that commit", async () => {
    const other = `5555555${"a".repeat(33)}`;
    const h = await read(P.since, replay({ ambiguous: { "5555555": [other] }, offMain: [other] }).run);
    expect(h.reverts.find((r) => r.sha === "8".repeat(40))?.reverted).toEqual([905, 911]);
  });

  test("an ambiguous short sha with two candidates on main is an error", async () => {
    const other = `5555555${"a".repeat(33)}`;
    await expect(read(P.since, replay({ ambiguous: { "5555555": [other] }, onMain: [other] }).run)).rejects.toThrow("曖昧");
  });

  test("a revert's PR: the stored PR's merge commit, or an earlier commit of a rebase merge (merge time as committer time, then its merge commit); a PR never stored is not credited to the next", async () => {
    const reverted = "a".repeat(40);
    const mine = "b".repeat(40);
    const at = Date.parse("2026-10-02T00:00:00Z");
    const git = (committed: string, list: string[]) => async (cmd: string[]) => {
      if (cmd[1] === "fetch") return "";
      if (cmd[1] === "log" && cmd.includes("-1")) return `${committed}\n`;
      if (cmd[1] === "log") return `${"1".repeat(40)}\t2026-10-03T00:00:00+00:00\tRevert "x"\n\nThis reverts commit ${reverted}.\n\0`;
      if (cmd[1] === "rev-parse") return `${reverted}\n`;
      if (cmd[1] === "cat-file") return "commit\n";
      if (cmd[1] === "merge-base") return "";
      if (cmd[1] === "rev-list") return list.join("\n") + "\n";
      throw new Error(`unexpected ${cmd.join(" ")}`);
    };
    const since = "2026-09-26T00:00:00.000Z";
    const of = async (merges: [string, number][], committed: string, list: string[]) => (await revertsSince(since, git(committed, list), currentRepo(), new Map(merges.map(([c, pr]) => [c, { pr, at }]))))[0]!.reverted;
    // the merge commit itself
    expect(await of([[reverted, 77]], "2026-10-02T00:00:00+00:00", [])).toEqual([77]);
    // the first of a PR's two commits: committed at the PR's merge time, its merge commit comes after it
    expect(await of([[mine, 78]], "2026-10-02T09:00:00+09:00", ["c".repeat(40), mine])).toEqual([78]);
    // a PR the app never stored: the next stored PR's merge commit was merged at another time, so it is not that PR's
    expect(await of([[mine, 79]], "2026-09-30T00:00:00+00:00", [mine])).toEqual([]);
    // no stored merge commit within 50 commits
    expect(await of([[mine, 80]], "2026-10-02T00:00:00+00:00", [...Array.from({ length: 50 }, (_, i) => String(i).padStart(40, "e")), mine])).toEqual([]);
  });

  test("a stack's verdict gives each PR its own entry: the lower PR is a recheck merge of its own head", async () => {
    const L = "5a".repeat(20), T = "5b".repeat(20);
    const base = (id: number, pr: number, over: object) => ({ id, kind: "gate", taskId: "t", pr, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, endedAt: Date.parse("2026-10-02T00:00:00Z") + id * 1000, repo: "o/r", head: L, base: null, as: null, kinds: [], result: null, taskRunner: "claude", ...over });
    const entry = (pr: number, head: string, required: string[]) => ({ pr, head, ask: [], recheck: [], required, merged: true });
    // --merge-stack on PR 31 (top) over PR 30: the union lists size, the reasons would carry `PR 30:`; the lower PR's recheck passed before the verdict
    const gate = { verdict: "merge", head: T, ask: [], recheck: [], required: ["size"], reasons: [], allowLarge: false, reviewSkipped: false, merged: true, stack: [entry(30, L, ["size"]), entry(31, T, [])] };
    const pull = (number: number, head: string) => ({ number, stored: true, state: "MERGED" as const, mergedAt: "2026-10-02T01:00:00Z", closedAt: null, head, mergeCommit: head });
    const h: MergeHistory = {
      jobs: [base(1, 30, { kind: "review", runner: "codex", as: "arbiter", result: { review: { findings: [], firstLine: "[codex] arbiter", rulings: { reviewerSide: [], missing: [], unreadable: [] } } } }), base(2, 30, { kind: "review", runner: "codex", result: { review: { findings: [], firstLine: "[codex] review" } } }), base(3, 31, { head: T, result: { gate } })] as MergeHistory["jobs"],
      grants: [], pulls: [pull(30, L), pull(31, T)], comments: [], since: Date.parse("2026-10-01T00:00:00Z"),
    };
    const by = new Map((await prViewsOf(h)).map((v) => [v.number, v]));
    expect(by.get(30)!.marks.filter((m) => m.kind === "recheck").map((m) => [m.kinds, m.sha])).toEqual([[["size"], L]]);
    // the top PR required nothing of its own
    expect(by.get(31)!.marks.filter((m) => m.kind === "recheck")).toEqual([]);
    // an older record of the stack (no entries): its reasons with `#<n>:` are the lower PRs', not the named PR's
    const old = { ...gate, stack: undefined, required: undefined, recheck: ["size"], reasons: ["#30: [再チェック size] x"] };
    const olderRecords: MergeHistory = { ...h, jobs: h.jobs.map((j) => (j.id === 3 ? { ...j, result: { gate: old } } : j)) as MergeHistory["jobs"] };
    expect((await prViewsOf(olderRecords)).find((v) => v.number === 31)!.marks.filter((m) => m.kind === "recheck")).toEqual([]);
    // a lower PR whose own entry says its main review was skipped is a direct one, though it has a main review record (the same PR without the entry's field is reviewed)
    expect(by.get(30)!.reviewed).toBe(true);
    const direct: MergeHistory = { ...h, jobs: h.jobs.map((j) => (j.id === 3 ? { ...j, result: { gate: { ...gate, stack: [{ ...entry(30, L, ["size"]), reviewSkipped: true }, { ...entry(31, T, []), reviewSkipped: false }] } } } : j)) as MergeHistory["jobs"] };
    expect((await prViewsOf(direct)).find((v) => v.number === 30)!.reviewed).toBe(false);
  });

  test("a verdict run with --allow-large before the person's grant had not lifted the ask: the stop is an ask", async () => {
    const H = "8b".repeat(20);
    const gateJob = { id: 1, kind: "gate", taskId: "t", pr: 9, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-10-02T00:00:10Z"), endedAt: Date.parse("2026-10-02T00:00:10Z"), repo: "o/r", head: H, base: null, as: null, kinds: [], taskRunner: "claude", result: { gate: { verdict: "stop", head: H, ask: ["rescue"], recheck: [], reasons: ["利用者の許可の記録が無い: rescue"], allowLarge: true, reviewSkipped: false, merged: false } } };
    const h = (grantAt: string): MergeHistory => ({ jobs: [gateJob] as MergeHistory["jobs"], grants: [{ taskId: "t", target: 9, head: H, at: Date.parse(grantAt) }], pulls: [{ number: 9, stored: true, state: "OPEN", mergedAt: null, closedAt: null, head: H, mergeCommit: null }], comments: [], since: Date.parse("2026-10-01T00:00:00Z") });
    const asks = async (x: MergeHistory) => (await prViewsOf(x))[0]!.marks.filter((m) => m.kind === "ask").length;
    // granted after the verdict: it was a stop on the ask itself
    expect(await asks(h("2026-10-02T00:01:00Z"))).toBe(1);
    // granted before it: the ask was lifted
    expect(await asks(h("2026-10-02T00:00:05Z"))).toBe(0);
  });
});

describe("tally", () => {
  const P = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" };
  const at = (h: number, kind: "ask" | "yes", kinds = ["security:words"]) => ({ at: `2026-10-01T${String(h).padStart(2, "0")}:00:00Z`, kind, kinds, sha: SHA });

  test("median of an even count is the mean of the middle two", () => {
    const waits = [1, 2, 4, 10];
    const prs = waits.map((w, i) => ({ number: 1 + i, mergedAt: null, headSha: SHA, reviewed: true, marks: [at(0, "ask"), at(w, "yes")] }));
    expect(tally(prs as PrRecord[], [], P).find((r) => r.kind === "security:words")?.waitHours).toBe(3);
  });

  test("a PR asked twice waits from the latest ask before the answer", () => {
    const pr = { number: 1, mergedAt: null, headSha: SHA, reviewed: true, marks: [at(0, "ask"), at(5, "ask"), at(6, "yes")] };
    expect(tally([pr] as PrRecord[], [], P).find((r) => r.kind === "security:words")?.waitHours).toBe(1);
  });
});

describe("security sub-kinds", () => {
  const P = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" };
  const t = (h: number) => `2026-10-01T${String(h).padStart(2, "0")}:00:00Z`;
  const pr = (number: number, mergedAt: string | null, ...comments: [string, number][]): PrRecord =>
    ({ number, mergedAt, headSha: SHA, reviewed: true, marks: parseMarks(comments.map(([body, h]) => c(body, t(h)))) });
  const prs = [
    pr(1, t(4), [`[merge-ask] security:lockfile,security:github ${SHA}`, 1], [`[merge-answer] yes security:lockfile,security:github ${SHA}`, 3]),
    pr(2, null, [`[merge-ask] security:words ${SHA}`, 1], [`[merge-answer] no security:words ${SHA}`, 5]),
    // the single security kind from before the kinds were split is not read
    pr(3, t(6), [`[merge-ask] security ${SHA}`, 1], [`[merge-answer] yes security ${SHA}`, 2]),
  ];

  test("tally: security:tests has a row of its own (asked before the owner moved it, rechecked after)", () => {
    const asked = pr(5, t(4), [`[merge-ask] security:tests ${SHA}`, 1], [`[merge-answer] yes security:tests ${SHA}`, 2]);
    const rechecked: PrRecord = { number: 6, mergedAt: t(4), headSha: SHA, reviewed: true, marks: parseMarks([c(`[recheck] security:tests pass ${SHA}`, t(3))]) };
    const row = tally([asked, rechecked], [], P).find((r) => r.kind === "security:tests");
    expect(row).toMatchObject({ asked: 1, yes: 1, no: 0, waitHours: 1, recheckMerged: [6] });
    expect(format(tally([asked, rechecked], [], P))[0]).toStartWith("security:tests 聞いた 1 / 認めた 1");
  });

  test("tally: one row per group, with asked, yes, no and the wait", () => {
    const rows = tally(prs, [], P).filter((r) => r.asked + r.yes + r.no > 0);
    expect(rows.map((r) => r.kind)).toEqual(["security:words", "security:lockfile", "security:github"]);
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(by["security:lockfile"]).toMatchObject({ asked: 1, yes: 1, no: 0, waitHours: 2, waitTotalHours: 2, recheckMerged: [] });
    expect(by["security:github"]).toMatchObject({ asked: 1, yes: 1, no: 0, waitHours: 2 });
    expect(by["security:words"]).toMatchObject({ asked: 1, yes: 0, no: 1, waitHours: 4 });
  });

  test("format: each line starts with the group's word", () => {
    expect(format(tally(prs, [], P)).map((l) => l.split(" ")[0])).toEqual(["security:words", "security:lockfile", "security:github"]);
    expect(format(tally(prs, [], P))[1]).toBe("security:lockfile 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 0 / 戻された 0");
  });

  test("proposals: an asked security group is never proposed; a group moved to a recheck goes back to asking when its recheck merge is taken back", () => {
    const rechecked = (number: number, kind: string): PrRecord => ({ number, mergedAt: t(4), headSha: SHA, reviewed: true, marks: parseMarks([c(`[recheck] ${kind} pass ${SHA}`, t(3))]) });
    const lock = rechecked(4, "security:lockfile");
    expect(tally([lock], [], P).find((r) => r.kind === "security:lockfile")).toMatchObject({ recheckMerged: [4] });
    // the asked groups' PRs (`#1`, `#3`) taken back: nothing; the moved group's PR taken back: back to asking
    expect(proposals(prs, [{ sha: "7".repeat(40), at: t(8), reverted: [1, 3] }], P)).toEqual([]);
    expect(proposals([...prs, lock], [{ sha: "7".repeat(40), at: t(8), reverted: [1, 3, 4] }], P)).toMatchObject([{ kind: "security:lockfile", evidence: [4], reverts: ["7".repeat(40)] }]);
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
      number: from + i, mergedAt: a === "yes" ? at(i) : null, headSha: SHA, reviewed: true,
      marks: parseMarks([c(`[merge-ask] ${kind} ${SHA}`, at(i)), c(`[merge-answer] ${a} ${kind} ${SHA}`, at(i))]),
    }));
  const rechecked = (n: number, kind: string, mergedAt = at(1)): PrRecord =>
    ({ number: n, mergedAt, headSha: SHA, reviewed: true, marks: parseMarks([c(`[recheck] ${kind} pass ${SHA}`, mergedAt)]) });

  test("a recheck merge taken back → that kind back to asking (one is enough)", () => {
    const prs = [rechecked(1, "responsibility"), rechecked(2, "responsibility"), rechecked(3, "size")];
    const R = "7".repeat(40);
    expect(proposals(prs, [{ sha: R, at: at(5), reverted: [2] }, { sha: "8".repeat(40), at: at(6), reverted: [9] }], W))
      .toEqual([{ kind: "responsibility", evidence: [2], reverts: [R], audited: [] }]);
    // not taken back, or merged before the look-back: nothing
    expect(proposals(prs, [], W)).toEqual([]);
    expect(proposals([rechecked(2, "responsibility", "2026-06-01T00:00:00Z")], [{ sha: "r", at: at(5), reverted: [2] }], W)).toEqual([]);
  });

  test("a revert after the window's end (a past --until) proposes nothing, whatever git's offset", () => {
    const prs = [rechecked(2, "responsibility")];
    expect(proposals(prs, [{ sha: "r", at: "2026-10-02T00:00:00Z", reverted: [2] }], W)).toEqual([]);
    // 2026-09-30T23:30-07:00 is 2026-10-01T06:30Z: after the window that ends at 2026-10-01T00:00Z
    expect(proposals(prs, [{ sha: "r", at: "2026-09-30T23:30:00-07:00", reverted: [2] }], W)).toEqual([]);
    // 2026-10-01T08:00+09:00 is 2026-09-30T23:00Z: inside it
    expect(proposals(prs, [{ sha: "r", at: "2026-10-01T08:00:00+09:00", reverted: [2] }], W)).toEqual([{ kind: "responsibility", evidence: [2], reverts: ["r"], audited: [] }]);
  });

  test("rescue and design-rules as recheck kinds: a recheck merge counts in their rows, a taken-back one proposes asking, 5 yes propose nothing", () => {
    const prs = [rechecked(2, "rescue"), rechecked(3, "design-rules")];
    const rows = tally(prs, [], W);
    expect(rows.find((r) => r.kind === "rescue")).toMatchObject({ asked: 0, recheckMerged: [2] });
    expect(rows.find((r) => r.kind === "design-rules")).toMatchObject({ asked: 0, recheckMerged: [3] });
    expect(proposals(prs, [{ sha: "r", at: at(5), reverted: [2, 3] }], W)).toEqual([
      { kind: "rescue", evidence: [2], reverts: ["r"], audited: [] },
      { kind: "design-rules", evidence: [3], reverts: ["r"], audited: [] },
    ]);
    expect(proposals([...answered("rescue", ["yes", "yes", "yes", "yes", "yes"]), ...answered("design-rules", ["yes", "yes", "yes", "yes", "yes"], 200)], [], W)).toEqual([]);
  });

  test("security is never proposed, even after 5 yes", () => {
    expect(proposals(answered("security:words", ["yes", "yes", "yes", "yes", "yes"]), [], W)).toEqual([]);
  });

});

describe("監査の行", () => {
  const A = { since: "2026-10-04T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z" };
  const run = (repo = currentRepo()) => read(A.since, replay().run, repo);

  test("a `[post-audit] pass|finding <merge sha>` comment is the audit's mark with its verdict; a short sha, or a mark on a later line, is not one", async () => {
    const sha = "c".repeat(40);
    const one = (body: string, authorAssociation?: string) => prViewsOf({ ...history, pulls: [{ number: 5, stored: true, state: "MERGED", mergedAt: "2026-10-04T03:00:00Z", closedAt: null, head: sha, mergeCommit: sha }], jobs: [], grants: [], comments: [{ issue: 5, body, createdAt: "2026-10-04T05:00:00Z", ...(authorAssociation ? { authorAssociation } : {}) }] }).then((v) => v[0]!);
    expect((await one(`[post-audit] finding ${sha}\n\n- a.ts:1 x`, "OWNER")).marks).toEqual([{ kind: "post-audit", kinds: [], sha, at: "2026-10-04T05:00:00Z", verdict: "finding" }]);
    expect((await one("[post-audit] pass abc1234", "OWNER")).marks).toEqual([]);
    expect((await one(`see\n[post-audit] pass ${sha}`, "OWNER")).marks).toEqual([]);
    // only an owner's, member's or collaborator's mark is an audit; one by anyone else, or stored with no author, is not counted (and is said)
    expect((await one(`[post-audit] pass ${sha}`, "MEMBER")).audited).toBe(true);
    for (const who of ["NONE", "CONTRIBUTOR", undefined]) {
      const v = await one(`[post-audit] pass ${sha}`, who);
      expect([v.audited, v.marks, v.uncountedAudits]).toEqual([false, [], 1]);
    }
  });

  test("監査の行が通り方ごとに出る", async () => {
    const { prs } = await run();
    const rows = auditRows(prs, A);
    expect(rows).toEqual([
      { route: "review", sampled: 1, findings: 0, rate: 0 },
      { route: "direct", sampled: 1, findings: 0, rate: 0 },
      { route: "recheck", sampled: 2, findings: 1, rate: 0.5 },
    ]);
    expect(formatAudit("example/development", rows)).toEqual([
      "監査 example/development review 抜き取り 1 / finding 0 / 率 0%",
      "監査 example/development direct 抜き取り 1 / finding 0 / 率 0%",
      "監査 example/development recheck 抜き取り 2 / finding 1 / 率 50%",
    ]);
  });

  test("抜き取り 0 の通り方も 0 で出る", async () => {
    const { prs } = await run();
    // a period with no audit mark: every route is a line of 0
    const none = auditRows(prs, { since: "2026-09-26T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" });
    expect(formatAudit("o/r", none)).toEqual([
      "監査 o/r review 抜き取り 0 / finding 0 / 率 0%",
      "監査 o/r direct 抜き取り 0 / finding 0 / 率 0%",
      "監査 o/r recheck 抜き取り 0 / finding 0 / 率 0%",
    ]);
    // only the review route sampled: direct stays a 0 line
    const only = auditRows(prs.filter((p) => p.number === 921), A);
    expect(only.map((r) => [r.route, r.sampled])).toEqual([["review", 1], ["direct", 0], ["recheck", 0]]);
  });

  test("再チェックだけで出た PR の finding が案の根拠になる", async () => {
    const { prs, reverts } = await run();
    const W = { since: "2026-07-06T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z" };
    // `#923` was lifted by a recheck of its head and no revert took it back; the audit's finding alone proposes asking
    expect(reverts.flatMap((r) => r.reverted)).not.toContain(923);
    const ps = proposals(prs, reverts, W).filter((x) => x.evidence.includes(923));
    expect(ps.map((x) => [x.kind, x.audited])).toEqual([["size", [923]]]);
    expect(formatProposals(ps)[0]).toContain("再チェックで自動マージして戻された / 監査の指摘: #923");
    // no revert: no empty "戻したコミット" part
    expect(formatProposals(ps)[0]).not.toContain("戻したコミット");
    // a pass, a finding on a PR with a review (not a recheck merge), or a finding after the window's end: nothing
    expect(proposals(prs.filter((p) => p.number === 924), [], W)).toEqual([]);
    const reviewed = prs.find((p) => p.number === 921)!;
    const reviewedFinding = { ...reviewed, marks: [...reviewed.marks, ...parseMarks([c(`[post-audit] finding ${"d".repeat(40)}`, "2026-10-04T06:00:00Z")])] };
    expect(proposals([reviewedFinding], [], W)).toEqual([]);
    expect(proposals(prs, reverts, { ...W, until: "2026-10-04T05:00:00.000Z" }).some((x) => x.evidence.includes(923))).toBe(false);
  });

  test("別のリポジトリで、既定の枝の祖先でない短い sha は数えない", async () => {
    const ahead = await read(A.since, replayRemote().run, "other/repo");
    const diverged = await read(A.since, replayRemote("diverged").run, "other/repo");
    const of = (h: typeof ahead) => h.reverts.flatMap((r) => r.reverted).sort((a, b) => a - b);
    expect(of(diverged).length).toBeLessThan(of(ahead).length);
  });

  test("--repo が読みに渡る", async () => {
    const { run: r, calls } = replayRemote();
    const a = app();
    try {
      await readHistory(A.since, r, "other/repo", a.env, a.f);
      expect(a.urls[0]).toContain("repo=other%2Frepo");
    } finally {
      a.done();
    }
    const gh = calls.filter((x) => x[0] === "gh").map((x) => x.join(" "));
    expect(gh.length).toBeGreaterThan(0);
    expect(gh.every((x) => x.includes("repos/other/repo/"))).toBe(true);
    // a repository that is not this clone's: no git, main's commits come from the API
    expect(calls.some((x) => x[0] === "git")).toBe(false);
    expect(gh.some((x) => x.includes("repos/other/repo/commits "))).toBe(true);
  });

  test("main: --repo の表に監査の行が出る / owner/name でなければ exit 2 / --file-request は別のリポジトリでは起票しない", async () => {
    const a = app();
    const lines: string[] = [];
    const log = console.log, err = console.error;
    console.log = (x: string) => void lines.push(x);
    console.error = () => {};
    let filed = 0;
    try {
      const remote = replayRemote();
      const code = await main(["--since", "2026-10-04", "--until", "2026-10-04", "--repo", "example/development", "--file-request"], remote.run, Date.parse("2026-10-05T12:00:00Z"), async () => (filed++, { filed: 1 }), { env: a.env, fetch: a.f });
      expect(code).toBe(1);
      expect(a.urls[0]).toContain(`repo=example%2Fdevelopment&since=${Date.parse("2026-07-07T00:00:00Z")}`);
      expect(lines.filter((l) => l.startsWith("監査 example/development "))).toHaveLength(3);
      expect(lines.at(-1)).toContain("別のリポジトリ");
      expect(filed).toBe(0);
      expect(await main(["--repo", "nope"], replay().run, Date.now(), undefined, { env: a.env, fetch: a.f })).toBe(2);
      expect(await main(["--repo"], replay().run, Date.now(), undefined, { env: a.env, fetch: a.f })).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
      a.done();
    }
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

  /** main with the fixture's app and replayed git: the app's address and key, and its answers, go in. */
  const run = async (args: string[], file: (r: { title: string; body: string }) => Promise<{ filed: number }>, r: Run = replay().run) => {
    const a = app();
    try {
      return { code: await quiet(() => main(args, r, NOW, file, { env: a.env, fetch: a.f })), urls: a.urls };
    } finally {
      a.done();
    }
  };

  test("the table comes from the app's records with a run that fails on gh", async () => {
    const a = app();
    const lines: string[] = [];
    const log = console.log, err = console.error;
    console.log = (x: string) => void lines.push(x);
    console.error = () => {};
    try {
      // `replay` fails on every gh call: a table that is printed asked GitHub nothing
      const code = await main(["--since", "2026-09-26", "--until", "2026-10-02"], replay().run, NOW, undefined, { env: a.env, fetch: a.f });
      expect(code).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
      a.done();
    }
    expect(lines.slice(0, 2)).toEqual(["2026-09-26〜2026-10-02", `記録は ${new Date((fx.history as { since: number }).since).toISOString().slice(0, 10)} から`]);
    expect(lines).toContain("security:words 聞いた 2 / 認めた 2 / 認めなかった 0 / 返事まで 中央値 3h（合計 6h） / 再チェックで自動マージ 0 / 戻された 0");
    expect(lines).toContain("size 聞いた 1 / 認めた 1 / 認めなかった 0 / 返事まで 中央値 2h（合計 2h） / 再チェックで自動マージ 2 / 戻された 0");
    expect(lines).toContain("印の欠け: 聞かずに返事 #912 / 返事なしでマージ #913");
    // PR 931 is unstored too but merged long before the period: not in this table's line
    expect(lines).toContain("保存に無い PR 1 件（#930）: 取込みの間に開いて閉じたため、状態とコメントが無い");
    expect(lines.at(-1)).toBe("案なし");
  });

  test("no proposal → exit 0, nothing filed even with --file-request", async () => {
    const { filed, file } = filing();
    expect((await run(["--since", "2026-09-26", "--until", "2026-10-02", "--file-request"], file)).code).toBe(0);
    expect(filed).toEqual([]);
  });

  test("a proposal → exit 1; --file-request files it, without the flag nothing is filed", async () => {
    const withFlag = filing();
    expect((await run(["--since", "2026-09-26", "--until", "2026-10-04", "--file-request"], withFlag.file)).code).toBe(1);
    expect(withFlag.filed.length).toBe(1);
    const without = filing();
    expect((await run(["--since", "2026-09-26", "--until", "2026-10-04"], without.file)).code).toBe(1);
    expect(without.filed).toEqual([]);
  });

  test("a repository the app has no GitHub workspace for (404) → exit 2 naming it, with no table and nothing filed", async () => {
    const { filed, file } = filing();
    const dir = mkdtempSync(join(tmpdir(), "switchboard-merge-audit-"));
    writeFileSync(join(dir, "key"), "k\n");
    const out: string[] = [];
    const errs: string[] = [];
    const log = console.log, err = console.error;
    console.log = (x: string) => void out.push(x);
    console.error = (x: string) => void errs.push(x);
    try {
      const f = async () => Response.json({ error: "nobody/none はアプリに登録されていない（GitHub のバックログにも、workspace の checkout にも無く、head のある仕事の記録も無い）。集計にはそのリポジトリの登録が要る" }, { status: 404 });
      const code = await main(["--since", "2026-09-26", "--until", "2026-10-02", "--repo", "nobody/none", "--file-request"], replay().run, NOW, file, { env: { MERGE_RECORDS_URL: "http://app.test", MERGE_RECORDS_TOKEN_FILE: join(dir, "key") }, fetch: f });
      expect(code).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(errs.join("\n")).toContain("nobody/none");
    expect(errs.join("\n")).toContain("登録");
    expect(out).toEqual([]);
    expect(filed).toEqual([]);
  });

  test("a failing read (the app, or git) → exit 2 and nothing filed", async () => {
    const { filed, file } = filing();
    const a = app();
    try {
      expect(await quiet(() => main(["--file-request"], replay().run, NOW, file, { env: a.env, fetch: async () => { throw new Error("connection refused"); } }))).toBe(2);
      const git: Run = async () => { throw new Error("git failed"); };
      expect((await run(["--file-request"], file, git)).code).toBe(2);
    } finally {
      a.done();
    }
    expect(filed).toEqual([]);
  });

  test("reads from min(since, until - LOOKBACK_DAYS)", async () => {
    const q = async (args: string[]) => (await run(args, filing().file)).urls[0]!.split("since=")[1];
    // until 2026-10-02 inclusive → ends 2026-10-03; 90 days before is 2026-07-05
    expect(await q(["--since", "2026-10-01", "--until", "2026-10-02"])).toBe(String(Date.parse("2026-07-05T00:00:00Z")));
    expect(await q(["--since", "2026-01-01", "--until", "2026-10-02"])).toBe(String(Date.parse("2026-01-01T00:00:00Z")));
  });

  test("formatSince and formatUnsaved: from when the records begin, and the PRs the app never stored (none → no line)", () => {
    expect(formatSince(Date.parse("2026-11-23T05:00:00Z"))).toBe("記録は 2026-11-23 から");
    expect(formatSince(null)).toBe("記録はまだ無い");
    expect(formatUnsaved([])).toEqual([]);
    expect(formatUnsaved([5, 9])).toEqual(["保存に無い PR 2 件（#5, #9）: 取込みの間に開いて閉じたため、状態とコメントが無い"]);
  });
});

describe("requestFor", () => {
  const src = { date: "2026-10-05" };
  test("the 出典 says 誰の言葉: 定期の検査", () => {
    expect(requestFor([{ kind: "size", evidence: [9], reverts: [], audited: [] }], src)!.body).toContain("## 出典\n- 誰の言葉: 定期の検査\n");
  });
  test("none → null; the title is the same whatever the proposals' order", () => {
    expect(requestFor([], src)).toBeNull();
    const back = { kind: "migration" as const, evidence: [3], reverts: ["abcdef0123456789abcdef0123456789abcdef01"], audited: [] };
    const a = requestFor([back, { kind: "rescue", evidence: [1, 2], reverts: ["1234567890"], audited: [] }], src)!;
    const b = requestFor([{ kind: "rescue", evidence: [1, 2], reverts: ["1234567890"], audited: [] }, back], src)!;
    expect(a.title).toBe("マージ規則の見直し: rescue を聞くへ / migration を聞くへ");
    expect(b.title).toBe(a.title);
    expect(a.body).toContain("- rescue を聞くへ（再チェックで自動マージして戻された: #1, #2。戻したコミット: 1234567）");
    // the commit that took it back is named, to read why it was undone
    expect(a.body).toContain("- migration を聞くへ（再チェックで自動マージして戻された: #3。戻したコミット: abcdef0）");
    expect(a.body).toMatch(/^## 出典\n- 誰の言葉: 定期の検査\n`bun scripts\/merge-audit.ts --file-request`（定期実行） \/ 2026-10-05$/m);
  });

  test("already filed request is detected: the same proposals' open request is not filed again", () => {
    const title = requestFor([{ kind: "size", evidence: [9], reverts: [], audited: [] }], src)!.title;
    expect(alreadyFiled(title, [{ ref: "#601", title: "モデル一覧の設定化" }, { ref: "#900", title }])).toBe("#900");
    expect(alreadyFiled(title, [{ ref: "#901", title: `${title} / rescue を聞くへ` }])).toBeNull();
  });
});
