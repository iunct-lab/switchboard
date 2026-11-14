// test-reads: ops.config.json
import { describe, expect, test } from "bun:test";
import { RECHECK_KINDS } from "./merge-gate";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGh } from "../ops-kit/src/gh.ts";
import { loadConfig } from "../ops-kit/src/config.ts";
import { lint } from "../ops-kit/src/lint.ts";
import { auditorOf, main, parseVerdict, pbiFor, pbiTitle, POST_AUDIT, prepare, promptFor, record, routeOf, select, VIEWPOINTS, type MergedPr } from "./post-audit";
import type { Run } from "./merge-audit";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const kind = RECHECK_KINDS[0]!;
const pr = (n: number, o: Partial<MergedPr> = {}): MergedPr => ({
  number: n, mergedAt: `2026-11-0${(n % 7) + 1}T00:00:00Z`, headSha: SHA, mergeSha: `${n}`.padStart(40, "0"), marks: [], reviewed: true, audited: false, ...o,
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
  test("実装が claude なら codex、無ければ claude", () => {
    expect(auditorOf([{ message: "feat: x\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" }])).toBe("codex");
    expect(auditorOf([{ message: "feat: x" }])).toBe("claude");
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
  const gh = (): Run => async (cmd) => {
    const path = cmd[2] === "-X" ? cmd[4]! : cmd[2]!;
    if (path === "search/issues") return `page false 2\n11\n12\n`;
    const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
    if (path.endsWith("/pulls/11")) return JSON.stringify({ merged_at: "2026-11-02T00:00:00Z", head: { sha: SHA }, merge_commit_sha: "a".repeat(40) });
    if (path.endsWith("/pulls/12")) return JSON.stringify({ merged_at: "2026-11-09T00:00:00Z", head: { sha: SHA }, merge_commit_sha: "b".repeat(40) });
    if (path.endsWith("/issues/11/comments")) return lines([{ body: "[codex] review ok", created_at: "2026-11-01T00:00:00Z", author_association: "NONE" }]);
    if (path.endsWith("/pulls/11/commits")) return lines([{ message: "x\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" }]);
    throw new Error(`unexpected ${cmd.join(" ")}`);
  };
  test("期間外を外し、MARK_AUTHORS 以外の印は数えず、環境変数の本数で切る", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try {
      const now = Date.parse("2026-11-07T12:00:00Z");
      expect(await main(["select", "--since", "2026-11-01", "--until", "2026-11-07", "--repo", "o/r"], gh(), now, {})).toBe(0);
      expect(await main(["select", "--since", "2026-11-01", "--until", "2026-11-07", "--repo", "o/r"], gh(), now, { SWITCHBOARD_POST_AUDIT_MAX: "0" })).toBe(0);
      expect(await main(["select", "--repo", "o/r"], gh(), now, { SWITCHBOARD_POST_AUDIT_MAX: "x" })).toBe(2);
      // 値の無い --repo は今のリポジトリに落ちず exit 2
      expect(await main(["select", "--repo"], gh(), now, {})).toBe(2);
    } finally {
      console.log = log;
    }
    const j = JSON.parse(out[0]!);
    // 11 の `[codex] review` は OWNER でないので数えない → direct。12 は期間外
    expect(j.selected).toEqual([{ pr: 11, route: "direct", auditor: "codex", mergeSha: "a".repeat(40) }]);
    expect(j.repo).toBe("o/r");
    // SWITCHBOARD_POST_AUDIT_MAX=0 が select に渡る: 何も選ばず、候補は overflow に数える
    const capped = JSON.parse(out[1]!);
    expect(capped.selected).toEqual([]);
    expect(capped.overflow).toBe(1);
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
    await record({ pr: 7, repo: "o/r", text: finding, dryRun: false, backlogEnv: true }, g.run);
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
