// test-reads: ops.config.json
import { describe, expect, test } from "bun:test";
import { RECHECK_KINDS } from "./merge-gate";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGh } from "../ops-kit/src/gh.ts";
import { loadConfig } from "../ops-kit/src/config.ts";
import { lint } from "../ops-kit/src/lint.ts";
import { auditorOf, main, settingFromEnv, parseVerdict, pbiFor, pbiTitle, POST_AUDIT, prepare, promptFor, pbiTitlePrefix, record, routeOf, select, settleFound, VIEWPOINTS, type MergedPr } from "./post-audit";
import type { Run } from "./merge-audit";
import type { MergeHistory } from "../ops-kit/src/merge-records.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const kind = RECHECK_KINDS[0]!;
const pr = (n: number, o: Partial<MergedPr> = {}): MergedPr => ({
  number: n, mergedAt: `2026-11-0${(n % 7) + 1}T00:00:00Z`, headSha: SHA, mergeSha: `${n}`.padStart(40, "0"), marks: [], reviewed: true, audited: false, implementer: null, ...o,
});
const recheck = { kind: "recheck" as const, kinds: [kind], sha: SHA, at: "2026-11-01T00:00:00Z" };
const yes = { kind: "yes" as const, kinds: [kind], sha: SHA, at: "2026-11-01T01:00:00Z" };
const P = { since: "2026-11-01T00:00:00.000Z", until: "2026-11-08T00:00:00.000Z" };

describe("routeOf", () => {
  test("3 つの通り方と判定の順", () => {
    expect(routeOf(pr(1))).toBe("review");
    expect(routeOf(pr(1, { reviewed: false }))).toBe("direct");
    expect(routeOf(pr(1, { marks: [recheck] }))).toBe("recheck");
    // recheck は direct より先
    expect(routeOf(pr(1, { marks: [recheck], reviewed: false }))).toBe("recheck");
    // 利用者の yes があれば recheck ではない（レビューも無ければ direct）
    expect(routeOf(pr(1, { marks: [recheck, yes], reviewed: false }))).toBe("direct");
    // マージした head と別の head の pass は数えない
    expect(routeOf(pr(1, { marks: [{ ...recheck, sha: "f".repeat(40) }] }))).toBe("review");
  });
});

describe("auditorOf", () => {
  test("実装が claude なら codex、codex なら claude、分からなければ claude の実装として codex", () => {
    expect(auditorOf("claude")).toBe("codex");
    expect(auditorOf("codex")).toBe("claude");
    expect(auditorOf(null)).toBe("codex");
  });
  test("auditorOf: the recheck setting same names the implementer's main reviewer; an unknown or missing environment value is other", () => {
    expect(auditorOf("claude", { review: "same", recheck: "same" })).toBe("claude");
    expect(auditorOf("claude", { review: "other", recheck: "same" })).toBe("codex");
    expect(auditorOf("codex", { review: "same", recheck: "same" })).toBe("codex");
    expect(auditorOf("codex", { review: "other", recheck: "same" })).toBe("claude");
    expect(auditorOf("claude", { review: "same", recheck: "other" })).toBe("codex");
    expect(settingFromEnv({})).toEqual({ review: "other", recheck: "other" });
    expect(settingFromEnv({ OPS_KIT_REVIEW_RUNNER: "same", OPS_KIT_RECHECK_RUNNER: "bogus" })).toEqual({ review: "same", recheck: "other" });
  });
});

describe("select", () => {
  const many = Array.from({ length: 40 }, (_, i) => pr(100 + i));
  test("select は同じ期間で同じ PR を選ぶ", () => {
    const a = select(many, { ...P, sample: 5, max: 15 });
    expect(a.selected).toHaveLength(5);
    expect(select([...many].reverse(), { ...P, sample: 5, max: 15 })).toEqual(a);
    expect(select(many, { since: "2026-11-02T00:00:00.000Z", until: P.until, sample: 5, max: 15 }).selected.map((s) => s.pr)).not.toEqual(a.selected.map((s) => s.pr));
  });
  test("印のある PR を外す", () => {
    const prs = [pr(1, { audited: true, reviewed: false }), pr(2, { reviewed: false }), pr(3, { audited: true })];
    expect(select(prs, { ...P, sample: 5, max: 15 }).selected.map((s) => s.pr)).toEqual([2]);
  });
  test("recheck と direct は全件、review は定数本", () => {
    const prs = [...many, pr(1, { marks: [recheck] }), pr(2, { reviewed: false })];
    const r = select(prs, { ...P, sample: 3, max: 15 });
    expect(r.selected.map((s) => s.route).sort()).toEqual(["direct", "recheck", "review", "review", "review"]);
    expect(r.overflow).toBe(0);
  });
  test("上限を超える候補で上限の本数だけ選ぶ", () => {
    const prs = [...many, ...Array.from({ length: 20 }, (_, i) => pr(200 + i, { reviewed: false }))];
    const r = select(prs, { ...P, sample: 5, max: 15 });
    expect(r.selected).toHaveLength(15);
    expect(r.selected.every((s) => s.route === "direct")).toBe(true);
    expect(r.overflow).toBe(10);
  });
  test("recheck が上限を超えても review の抜き取りを確保し、direct が先、recheck はハッシュ順", () => {
    const rechecks = Array.from({ length: 30 }, (_, i) => pr(300 + i, { marks: [recheck], mergedAt: `2026-11-01T00:${String(i).padStart(2, "0")}:00Z` }));
    const directs = [pr(1, { reviewed: false }), pr(2, { reviewed: false })];
    const r = select([...rechecks, ...directs, ...many], { ...P, sample: 5, max: 15 });
    expect(r.selected.map((s) => s.route)).toEqual([...Array(2).fill("direct"), ...Array(5).fill("review"), ...Array(8).fill("recheck")]);
    expect(r.overflow).toBe(2 + 5 + 30 - 15);
    const picked = r.selected.filter((s) => s.route === "recheck").map((s) => s.pr);
    expect(picked).not.toEqual(rechecks.slice(0, 8).map((p) => p.number)); // 古い順ではない
    expect(select([...rechecks].reverse().concat(directs, many), { ...P, sample: 5, max: 15 })).toEqual(r);
  });
  test("direct が上限を埋めたら review は入らない", () => {
    const directs = Array.from({ length: 4 }, (_, i) => pr(400 + i, { reviewed: false }));
    const r = select([...directs, ...many], { ...P, sample: 5, max: 3 });
    expect(r.selected.map((s) => s.route)).toEqual(["direct", "direct", "direct"]);
    expect(r.overflow).toBe(4 + 5 - 3);
  });
});

test("POST_AUDIT は印の行だけ", () => {
  expect(POST_AUDIT.test(`[post-audit] pass ${SHA}`)).toBe(true);
  expect(POST_AUDIT.test(`[post-audit] finding ${SHA} #1`)).toBe(true);
  expect(POST_AUDIT.test(`text [post-audit] pass ${SHA}`)).toBe(false);
  expect(POST_AUDIT.test("[post-audit] pass abc")).toBe(false);
});

describe("main", () => {
  /** git and gh both fail: the selection reads the app's records only. */
  const failing: Run = async (cmd) => {
    throw new Error(`no command may run: ${cmd.join(" ")}`);
  };
  const job = (id: number, pr: number, over: object) => ({ id, kind: "gate", taskId: `t${pr}`, pr, runner: null, status: "pass", exitCode: 0, startedAt: Date.parse("2026-11-02T00:00:00Z") + id, endedAt: Date.parse("2026-11-02T00:00:00Z") + id, repo: "o/r", head: SHA, base: null, as: null, kinds: [], result: null, taskRunner: "claude", ...over });
  const gate = (merged: boolean, over: object = {}) => ({ gate: { verdict: "merge", head: SHA, ask: [], recheck: [], reasons: [], allowLarge: false, reviewSkipped: false, merged, ...over } });
  const pull = (number: number, mergedAt: string | null, mergeCommit: string | null) => ({ number, stored: mergeCommit !== null, state: mergedAt ? "MERGED" : null, mergedAt, closedAt: mergedAt, head: SHA, mergeCommit });
  const history: MergeHistory = {
    jobs: [
      // 11: merged, its verdict skipped the main review (direct); the Task is a codex one
      job(1, 11, { result: gate(true, { reviewSkipped: true }), taskRunner: "codex" }),
      // 12: merged after the period
      job(2, 12, { result: gate(true) }),
      // 13: a main review and a merge, and an audit job that passed: audited
      job(3, 13, { kind: "review", runner: "codex", result: { review: { findings: [], firstLine: "[codex] review" } } }),
      job(4, 13, { result: gate(true) }),
      // 13's audit job read another commit (SHA, not its merge commit): not a record; its [post-audit] comment of the owner (below) is
      job(5, 13, { kind: "review", runner: "claude", as: "audit", taskId: "audit", taskRunner: "claude", result: { review: { findings: [], firstLine: "pass" } } }),
      // 16: the app's audit job read its merge commit and kept `pass`: audited, with no comment
      job(9, 16, { kind: "review", runner: "claude", as: "audit", taskId: "audit", head: "e".repeat(40), result: { review: { findings: [], firstLine: "pass" } } }),
      job(10, 16, { result: gate(true) }),
      // 14: merged in the period, never stored (no merge commit to read)
      job(6, 14, { result: gate(true) }),
      // 15: merged with a main review, claude's Task
      job(7, 15, { kind: "review", runner: "codex", result: { review: { findings: [], firstLine: "[codex] review" } } }),
      job(8, 15, { result: gate(true) }),
    ] as MergeHistory["jobs"],
    grants: [],
    pulls: [pull(11, "2026-11-02T00:00:00Z", "a".repeat(40)), pull(12, "2026-11-09T00:00:00Z", "b".repeat(40)), pull(13, "2026-11-03T00:00:00Z", "c".repeat(40)), pull(14, null, null), pull(15, "2026-11-04T00:00:00Z", "d".repeat(40)), pull(16, "2026-11-05T00:00:00Z", "e".repeat(40))],
    comments: [
      { issue: 13, body: `[post-audit] pass ${"c".repeat(40)}`, createdAt: "2026-11-06T00:00:00Z", authorAssociation: "OWNER" },
      // a comment by someone else, and one stored with no author: not counted, the PR is selected again, and both are said
      { issue: 11, body: `[post-audit] pass ${"a".repeat(40)}`, createdAt: "2026-11-06T00:00:00Z", authorAssociation: "NONE" },
      { issue: 15, body: `[post-audit] pass ${"d".repeat(40)}`, createdAt: "2026-11-06T00:00:00Z" },
    ],
    since: Date.parse("2026-10-01T00:00:00Z"),
  };
  const select = async (args: string[], env: Record<string, string | undefined> = {}, h: MergeHistory = history) => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-post-audit-"));
    writeFileSync(join(dir, "key"), "k\n");
    const urls: string[] = [];
    const out: string[] = [];
    const log = console.log, err = console.error;
    console.log = (x: string) => void out.push(x);
    console.error = () => {};
    try {
      const code = await main(["select", ...args], failing, Date.parse("2026-11-07T12:00:00Z"), { MERGE_RECORDS_URL: "http://app.test", MERGE_RECORDS_TOKEN_FILE: join(dir, "key"), ...env }, async (url) => (urls.push(url), Response.json(h)));
      return { code, urls, json: out[0] ? JSON.parse(out[0]) : null };
    } finally {
      console.log = log;
      console.error = err;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const A = ["--since", "2026-11-01", "--until", "2026-11-07", "--repo", "o/r"];

  test("select reads merged PRs, routes and audited ones from the app's records with a run that fails on gh", async () => {
    const r = await select(A);
    expect(r.code).toBe(0);
    expect(r.urls).toEqual([`http://app.test/api/merge-records/history?${new URLSearchParams({ repo: "o/r", since: String(Date.parse("2026-11-01T00:00:00Z")), titlePrefix: pbiTitlePrefix("o/r") })}`]);
    // 11 is direct (its verdict skipped the main review; a codex Task implemented it, so claude audits), 15 is a reviewed one by claude (codex audits);
    // 12 is after the period, 13 was audited (a passed audit job), 14 has no merge commit: named, not selected
    expect(r.json.selected).toEqual([
      { pr: 11, route: "direct", auditor: "claude", implementerKnown: true, mergeSha: "a".repeat(40) },
      { pr: 15, route: "review", auditor: "codex", implementerKnown: true, mergeSha: "d".repeat(40) },
    ]);
    expect(r.json.repo).toBe("o/r");
    expect(r.json.unsaved).toEqual([14]);
    expect(r.json.uncountedAudits).toBe(2);
  });

  test("an audit job the implementing Task asked for is no audit; a finding job settles the PR only once its PBI is in the backlog", async () => {
    // 16's passing audit asked for by the Task that asked for its verdict: not counted, 16 is selected again
    const self: MergeHistory = { ...history, jobs: history.jobs.map((j) => (j.id === 9 ? { ...j, taskId: "t16" } : j)) };
    expect((await select(A, {}, self)).json.selected.map((s: { pr: number }) => s.pr).sort()).toEqual([11, 15, 16]);
    // 16's audit kept `finding`: with no PBI of that title among the app's stored Issues (record stopped before filing it) it is selected again
    const found = (titles: string[]): MergeHistory => ({ ...history, titles, jobs: history.jobs.map((j) => (j.id === 9 ? { ...j, result: { review: { findings: [], firstLine: "finding" } } } : j)) });
    const near = await select(A, {}, found([`${pbiTitle("o/r", 16)}0`, pbiTitle("o/x", 16)]));
    expect(near.json.selected.map((s: { pr: number }) => s.pr).sort()).toEqual([11, 15, 16]);
    // its PBI is stored (open or closed alike): audited; the app is asked for the titles with the audit PBI's prefix, and nothing runs (gh or the backlog)
    const filed = await select(A, {}, found([pbiTitle("o/r", 16)]));
    expect(filed.json.selected.map((s: { pr: number }) => s.pr).sort()).toEqual([11, 15]);
    expect(new URL(filed.urls[0]!).searchParams.get("titlePrefix")).toBe(pbiTitlePrefix("o/r"));
    expect(settleFound([{ ...pr(16), auditFound: true }], "o/r", [pbiTitle("o/r", 16)])[0]!.audited).toBe(true);
    // a stored Issue with the audit PBI's title and no audit job of the app (11: its mark is someone else's) settles nothing: anyone can open one
    expect((await select(A, {}, { ...history, titles: [pbiTitle("o/r", 11)] })).json.selected.map((s: { pr: number }) => s.pr)).toEqual([11, 15]);
    expect(settleFound([pr(11)], "o/r", [pbiTitle("o/r", 11)])[0]!.audited).toBe(false);
  });

  test("a stored PR with no merge commit is skipped, not named as never stored; an unknown implementer is said", async () => {
    const h: MergeHistory = { ...history, pulls: history.pulls.map((p) => (p.number === 15 ? { ...p, mergeCommit: null } : p)), jobs: history.jobs.map((j) => ({ ...j, taskRunner: null, runner: null })) };
    const r = await select(A, {}, h);
    expect(r.json.unsaved).toEqual([14]);
    expect(r.json.selected.map((s: { pr: number }) => s.pr)).toEqual([11]);
    expect(r.json.selected[0].implementerKnown).toBe(false);
  });

  test("the cap and the Task's settings reach the selection; a bad number or a --repo with no value is exit 2", async () => {
    // 環境変数の上限が select に渡る: 何も選ばず、候補は overflow に数える
    const capped = (await select(A, { SWITCHBOARD_POST_AUDIT_MAX: "0" })).json;
    expect(capped.selected).toEqual([]);
    expect(capped.overflow).toBe(2);
    expect((await select(["--repo", "o/r"], { SWITCHBOARD_POST_AUDIT_MAX: "x" })).code).toBe(2);
    expect((await select(["--repo"])).code).toBe(2);
    // the settings: recheck same + review other → the implementer's main reviewer is the other runner (11: codex's Task → claude); review same → the implementer itself
    expect((await select(A, { OPS_KIT_RECHECK_RUNNER: "same" })).json.selected.map((s: { auditor: string }) => s.auditor)).toEqual(["claude", "codex"]);
    expect((await select(A, { OPS_KIT_RECHECK_RUNNER: "same", OPS_KIT_REVIEW_RUNNER: "same" })).json.selected.map((s: { auditor: string }) => s.auditor)).toEqual(["codex", "claude"]);
  });

  test("the app not answering is exit 2 and prints nothing selected", async () => {
    const r = await select(A, { MERGE_RECORDS_TOKEN_FILE: "/nonexistent/key" });
    expect([r.code, r.json]).toEqual([2, null]);
  });
});

describe("parseVerdict", () => {
  test("1 行目が pass か finding。finding の `- ` 行が items。それ以外は null", () => {
    expect(parseVerdict("pass\n")).toEqual({ verdict: "pass", items: [] });
    expect(parseVerdict("\n finding \n- a.ts:1 認証 x\nメモ\n- b.ts:2 秘密 y")).toEqual({ verdict: "finding", items: ["a.ts:1 認証 x", "b.ts:2 秘密 y"] });
    expect(parseVerdict("問題は無い\npass")).toBeNull();
    expect(parseVerdict("passed")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("promptFor / pbiFor", () => {
  test("プロンプトは観点 6 つと出力の形を持つ", () => {
    const t = promptFor({ repo: "o/r", pr: 7, mergeSha: SHA, title: "feat: x" });
    for (const v of VIEWPOINTS) expect(t).toContain(v);
    expect(VIEWPOINTS).toHaveLength(6);
    expect(t).toContain(SHA);
    expect(t).toContain("`pass`");
    // 秘密の値そのものを書かせない（出力は PR のコメントと Issue に写る）
    expect(t).toContain("秘密の値");
  });
  test("起票の本文は ops-kit lint --fresh の PBI の検査で violations 0", async () => {
    const cfg = loadConfig(join(import.meta.dir, "../ops.config.json"));
    const pbi = pbiFor({ repo: "o/r", pr: 7, mergeSha: SHA, items: ["a.ts:1 認証 x"] });
    expect(pbi.title).toBe(pbiTitle("o/r", 7));
    const node = { number: 10, body: pbi.body, labels: { nodes: [{ name: "type:pbi" }, { name: "bug" }, { name: "security" }] }, parent: null, subIssues: { totalCount: 0 } };
    const page = () => ({ repositoryOwner: { projectV2: { id: "P" } }, repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } });
    const saved = process.env.GH_REPO;
    process.env.GH_REPO = "example/repo";
    try {
      const r = await lint(fakeGh([page]), cfg, { withProject: false, sleep: async () => undefined });
      expect(r.violations).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = saved;
    }
    expect(pbi.body).toContain("- 誰の言葉: 定期の検査");
  });
});

describe("record", () => {
  const MERGE = "c".repeat(40);
  const fake = (existing: { number: number; title: string; state: "OPEN" | "CLOSED" }[] = []) => {
    const calls: string[][] = [];
    const run: Run = async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "gh" && cmd[1] === "api") return JSON.stringify({ merged_at: "2026-11-02T00:00:00Z", merge_commit_sha: MERGE });
      // the shape `ops-kit backlog list --json` prints (backlog-client.ts)
      if (cmd.includes("list")) return JSON.stringify({ repository: "o/r", items: existing.map((i) => ({ type: "issue", status: null, labels: ["type:pbi"], ...i })), unread: [] });
      return "";
    };
    return { run, calls };
  };
  const writes = (calls: string[][]) => calls.filter((c) => (c[0] === "gh" && c[1] === "pr") || c.includes("create"));
  const finding = "finding\n- a.ts:1 認証 無認証で呼べる";

  test("record pass は印だけ", async () => {
    const f = fake();
    const r = await record({ pr: 7, repo: "o/r", text: "pass\n", dryRun: false }, f.run);
    expect(writes(f.calls)).toEqual([["gh", "pr", "comment", "7", "-R", "o/r", "--body", `[post-audit] pass ${MERGE}`]]);
    expect(r.pbi).toBeNull();
    expect(POST_AUDIT.test(r.mark)).toBe(true);
  });
  test("record finding は印と PBI", async () => {
    const f = fake();
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false }, f.run);
    const w = writes(f.calls);
    expect(w).toHaveLength(2);
    const create = w[0]!;
    expect(create).toContain("create");
    expect(create.slice(create.indexOf("--title"), create.indexOf("--title") + 2)).toEqual(["--title", pbiTitle("o/r", 7)]);
    for (const l of ["type:pbi", "bug", "security"]) expect(create.join(" ")).toContain(`--label ${l}`);
    const fields = create.flatMap((x, i) => (x === "--field" ? [create[i + 1]] : []));
    expect(fields).toEqual(["Status=Backlog", "Priority=P2", "Story Points=2"]);
    expect(w[1]!.slice(0, 7)).toEqual(["gh", "pr", "comment", "7", "-R", "o/r", "--body"]);
    expect(w[1]![7]).toBe(`[post-audit] finding ${MERGE}\n\n- a.ts:1 認証 無認証で呼べる`);
  });
  test("同じ題の開いた PBI があれば起票しない（閉じた PBI は数えない）", async () => {
    const t = pbiTitle("o/r", 7);
    const f = fake([{ number: 99, title: t, state: "OPEN" }]);
    const r = await record({ pr: 7, repo: "o/r", text: finding, dryRun: false }, f.run);
    expect(r.existing).toBe(99);
    expect(writes(f.calls).map((c) => c[1])).toEqual(["pr"]);
    const g = fake([{ number: 98, title: t, state: "CLOSED" }]);
    expect((await record({ pr: 7, repo: "o/r", text: finding, dryRun: false }, g.run)).existing).toBeNull();
    expect(writes(g.calls)).toHaveLength(2);
  });
  test("Task の外でほかのリポジトリへ起票するとき、Project の URL が無ければ何も書かない", async () => {
    const f = fake();
    await expect(record({ pr: 7, repo: "o/r", text: finding, dryRun: false, backlogEnv: true }, f.run)).rejects.toThrow("SWITCHBOARD_PROJECT_URL");
    expect(writes(f.calls)).toEqual([]);
    const g = fake();
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false, backlogEnv: true, projectUrl: "https://github.com/orgs/o/projects/1" }, g.run);
    expect(writes(g.calls)).toHaveLength(2);
    const h = fake();
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false, backlogEnv: true, workspace: "ws_1" }, h.run);
    expect(writes(h.calls)).toHaveLength(2);
  });
  test("dry-run は何も書かない", async () => {
    const f = fake();
    const r = await record({ pr: 7, repo: "o/r", text: finding, dryRun: true }, f.run);
    expect(writes(f.calls)).toEqual([]);
    expect(r.dryRun).toBe(true);
    expect(r.mark).toBe(`[post-audit] finding ${MERGE}`);
    expect(r.pbi?.title).toBe(pbiTitle("o/r", 7));
  });
  test("読めない出力は印を書かない（main は exit 2）", async () => {
    const f = fake();
    await expect(record({ pr: 7, repo: "o/r", text: "たぶん問題なし", dryRun: false }, f.run)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  test("別のリポジトリのバックログは --workspace か GH_REPO で名指しする", async () => {
    const f = fake();
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false, workspace: "ws_1" }, f.run);
    expect(f.calls.filter((c) => c.includes("backlog")).every((c) => c.includes("--workspace") && c.includes("ws_1"))).toBe(true);
    const g = fake();
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false, backlogEnv: true, projectUrl: "https://github.com/orgs/o/projects/1" }, g.run);
    expect(g.calls.filter((c) => c.includes("backlog")).every((c) => c[0] === "env" && c[1] === "GH_REPO=o/r")).toBe(true);
  });
});

describe("prepare", () => {
  test("prompt と out は clone（仕事の cwd）の中に置く", async () => {
    const dir = mkdtempSync(join(tmpdir(), "post-audit.prepare."));
    try {
      const run: Run = async (cmd) => (cmd[0] === "gh" && cmd[1] === "api" ? JSON.stringify({ merged_at: "2026-11-02T00:00:00Z", merge_commit_sha: SHA, title: "feat: x" }) : cmd[1] === "pr" ? "diff --git a/x b/x\n" : "");
      const p = await prepare(7, "o/r", dir, run);
      // the daemon's review job takes --prompt and --out only inside --cwd (packages/core/src/jobs.ts)
      for (const f of [p.prompt, p.out]) expect(f.startsWith(`${p.cwd}/`)).toBe(true);
      expect(readFileSync(p.prompt, "utf8")).toContain(SHA);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
