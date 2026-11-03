// test-reads: scripts/merge-gate.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checksFromRuns, designRulesTouched, judge, localCiOf, main, MERGE_ANSWER, MERGE_ASK, PROTECTED, readGitlabPr, readPr, RECHECK_PASS, type PrFacts, type RecheckKind } from "./merge-gate";
import { resultComment } from "./local-ci";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The default repository (no --repo) is GH_REPO, else the origin (scripts/repo.ts): fixed here, so a leak of it shows.
const REPO = "example/development";
const savedRepo = process.env.GH_REPO;
beforeAll(() => { process.env.GH_REPO = REPO; });
afterAll(() => { if (savedRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = savedRepo; });

const base = (over: Partial<PrFacts> = {}): PrFacts => ({
  files: [{ path: "packages/core/src/tasks.ts", additions: 20, deletions: 5 }],
  headCommittedAt: "2026-09-24T10:00:00Z",
  checks: [{ name: "test", conclusion: "SUCCESS" }],
  unresolvedThreads: 0,
  mergeState: "CLEAN",
  reviewComments: [{ body: "[codex] review\n\n### Intent and design", createdAt: "2026-09-24T11:00:00Z" }],
  ...over,
});
const off = { allowLarge: false };
const HEAD = "a".repeat(40);
/** The facts with the user's yes of the head (--allow-large lifts nothing without it). */
const yes = (kinds: string, over: Partial<PrFacts> = {}) => base({
  ...over,
  head: HEAD,
  reviewComments: [...base().reviewComments, { body: `[merge-answer] yes ${kinds} ${HEAD}`, createdAt: "2026-09-24T12:00:00Z" }],
});

describe("merge-gate judge", () => {
  test("a small reviewed PR with green CI merges", () => {
    expect(judge(base(), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
  });

  test("301 counted lines is large and stops", () => {
    const j = judge(base({ files: [{ path: "apps/web/src/App.tsx", additions: 300, deletions: 1 }] }), off);
    expect(j.impact).toBe("large");
    expect(j.verdict).toBe("stop");
    expect(j.reasons).toEqual(["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている"]);
  });

  test("300 counted lines is still small", () => {
    expect(judge(base({ files: [{ path: "apps/web/src/App.tsx", additions: 300, deletions: 0 }] }), off).impact).toBe("small");
  });

  test("tests, e2e scripts and docs do not count", () => {
    const files = [
      { path: "packages/core/src/tasks.test.ts", additions: 1000, deletions: 0 },
      { path: "scripts/backlog-e2e.ts", additions: 400, deletions: 0 },
      { path: "docs/guide/backlog.md", additions: 400, deletions: 0 },
      { path: "README.md", additions: 400, deletions: 0 },
    ];
    expect(judge(base({ files }), off)).toMatchObject({ verdict: "merge", impact: "small" });
  });

  test("skill markdown counts and is a responsibility", () => {
    const j = judge(base({ files: [{ path: ".claude/skills/pbi-complete/SKILL.md", additions: 1, deletions: 0 }] }), off);
    expect(j.impact).toBe("large");
    expect(j.reasons).toEqual(["[再チェック responsibility] 責務: .claude/skills/pbi-complete/SKILL.md"]);
    const big = judge(base({ files: [{ path: ".claude/skills/pbi-complete/SKILL.md", additions: 301, deletions: 0 }] }), off);
    expect(big.reasons[0]).toBe("[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている");
    // the shared skills in the kit are skills too
    const kit = judge(base({ files: [{ path: "ops-kit/skills/pbi-complete/SKILL.md", additions: 301, deletions: 0 }] }), off);
    expect(kit.impact).toBe("large");
    expect(kit.reasons).toEqual(["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている", "[再チェック responsibility] 責務: ops-kit/skills/pbi-complete/SKILL.md"]);
  });

  test.each([
    ["rescue/src/server.ts", "[再チェック rescue] rescue"],
    [".github/workflows/ci.yml", "[聞く] セキュリティ（security:github）"],
    ["packages/core/src/db.ts", "[再チェック migration] 保護するパスに触れている"],
    ["packages/core/src/schema-baseline.json", "[再チェック migration] 保護するパスに触れている"],
    ["packages/core/src/auth.ts", "[聞く] セキュリティ（security:words）"],
    ["packages/core/src/approval.ts", "[聞く] セキュリティ（security:words）"],
    ["packages/core/src/selfdev.ts", "[再チェック size] 保護するパスに触れている"],
    ["packages/core/config/pricing.json", "[再チェック size] 保護するパスに触れている"],
    ["scripts/setup/lint_backlog.sh", "[再チェック size] 保護するパスに触れている"],
    [".claude/skills/x/SKILL.md", "[再チェック responsibility] 責務"],
    ["ops-kit/skills/x/SKILL.md", "[再チェック responsibility] 責務"],
    ["package.json", "[再チェック size] 保護するパスに触れている"],
    ["bun.lock", "[聞く] セキュリティ（security:lockfile）"],
  ])("one line in %s is large: %s", (path, why) => {
    const j = judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);
    expect(j.impact).toBe("large");
    expect(j.reasons).toEqual([`${why}: ${path}`]);
  });

  test("every PROTECTED pattern is covered above", () => {
    expect(PROTECTED.length).toBe(13);
  });

  test("a nested package.json is not protected", () => {
    expect(judge(base({ files: [{ path: "apps/web/package.json", additions: 1, deletions: 0 }] }), off).impact).toBe("small");
  });

  test("a failing or pending check stops", () => {
    const j = judge(base({ checks: [{ name: "test", conclusion: "FAILURE" }, { name: "lint", conclusion: "" }] }), off);
    expect(j.verdict).toBe("stop");
    expect(j.reasons).toEqual(["CI のチェック test が FAILURE", "CI のチェック lint が 未完了"]);
  });

  test("skipped checks pass, no checks at all stops", () => {
    expect(judge(base({ checks: [{ name: "a", conclusion: "SUCCESS" }, { name: "b", conclusion: "SKIPPED" }] }), off).verdict).toBe("merge");
    expect(judge(base({ checks: [] }), off).reasons).toEqual(["CI のチェックが 1 つも無い"]);
  });

  test("an unresolved review thread stops", () => {
    expect(judge(base({ unresolvedThreads: 2 }), off).reasons).toEqual(["解決していないレビュースレッドが 2 件ある"]);
  });

  test("a commit after the last main review stops", () => {
    const j = judge(base({ headCommittedAt: "2026-09-24T12:00:00Z" }), off);
    expect(j.verdict).toBe("stop");
    expect(j.reasons).toEqual([
      "最後のコミット（2026-09-24T12:00:00Z）より新しい主レビュー（[codex] review / [claude] review）が無い",
    ]);
  });

  test("a [claude] review counts, a [dak] review or a triage summary does not", () => {
    const at = "2026-09-24T11:00:00Z";
    expect(judge(base({ reviewComments: [{ body: "[claude] review\n", createdAt: at }] }), off).verdict).toBe("merge");
    const j = judge(base({ reviewComments: [{ body: "[dak] review\n", createdAt: at }, { body: "## レビュー対応 [codex] review", createdAt: at }] }), off);
    expect(j.verdict).toBe("stop");
  });

  test("a merge state other than CLEAN stops", () => {
    expect(judge(base({ mergeState: "BLOCKED" }), off).reasons).toEqual(["mergeStateStatus が CLEAN でない: BLOCKED"]);
  });

  test("--allow-large lifts the security and responsibility stops too", () => {
    const files = [
      { path: "src/auth/session.ts", additions: 1, deletions: 0 },
      { path: "docs/design/x.md", additions: 1, deletions: 0 },
    ];
    expect(judge(base({ files }), off).reasons).toEqual(["[聞く] セキュリティ（security:words）: src/auth/session.ts", "[再チェック responsibility] 責務: docs/design/x.md"]);
    expect(judge(yes("security:words,responsibility,design-rules", { files, designRulesTouched: true }), { allowLarge: true })).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: ["security:words"], recheck: ["responsibility", "design-rules"] });
  });

  test("--allow-large lifts every large reason, not the others", () => {
    const files = [{ path: "rescue/src/server.ts", additions: 400, deletions: 0 }];
    expect(judge(yes("rescue,size", { files }), { allowLarge: true })).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: ["size", "rescue"] });
    const j = judge(yes("rescue,size", { files, headCommittedAt: "2026-09-24T12:30:00Z" }), { allowLarge: true });
    expect(j.verdict).toBe("stop");
    expect(j.impact).toBe("large");
    expect(j.reasons).toHaveLength(1);
    expect(j.reasons[0]).toStartWith("最後のコミット");
  });

  test("allow-large needs merge-answer", () => {
    const files = [{ path: "src/auth/session.ts", additions: 1, deletions: 0 }, { path: "docs/design/x.md", additions: 1, deletions: 0 }];
    const large = ["[聞く] セキュリティ（security:words）: src/auth/session.ts", "[再チェック responsibility] 責務: docs/design/x.md"];
    const missing = expect.stringContaining("[merge-answer] yes が無い: security:words,responsibility");
    const allow = { allowLarge: true };
    // no mark: the reasons of a judgement without the flag, and the missing mark
    const none = judge(base({ files, head: HEAD }), allow);
    expect(none).toMatchObject({ verdict: "stop", impact: "large" });
    expect(none.reasons).toEqual([...large, missing]);
    // a kind is missing from the mark, the ask side or the recheck side
    expect(judge(yes("security:words", { files }), allow).reasons).toEqual([...large, missing]);
    expect(judge(yes("responsibility", { files }), allow).reasons).toEqual([...large, missing]);
    // every kind
    expect(judge(yes("security:words,responsibility", { files }), allow)).toMatchObject({ verdict: "merge", reasons: [] });
    // another head, a no
    const other = base({ files, head: "b".repeat(40), reviewComments: yes("security:words,responsibility").reviewComments });
    expect(judge(other, allow).verdict).toBe("stop");
    const no = base({ files, head: HEAD, reviewComments: [...base().reviewComments, { body: `[merge-answer] no security:words,responsibility ${HEAD}`, createdAt: "2026-09-24T12:00:00Z" }] });
    expect(judge(no, allow).verdict).toBe("stop");
    // a no after the yes takes it back; a yes after the no counts
    const said = (...answers: string[]) => base({ files, head: HEAD, reviewComments: [...base().reviewComments, ...answers.map((a) => ({ body: `[merge-answer] ${a} security:words,responsibility ${HEAD}`, createdAt: "2026-09-24T12:00:00Z" }))] });
    expect(judge(said("yes", "no"), allow).verdict).toBe("stop");
    expect(judge(said("no", "yes"), allow).verdict).toBe("merge");
    // by time, not by the order of the list
    const newestFirst = said("no", "yes");
    newestFirst.reviewComments[1]!.createdAt = "2026-09-24T13:00:00Z";
    expect(judge(newestFirst, allow).verdict).toBe("stop");
    // a recheck kind already marked is not asked of the yes
    expect(judge(yes("security:words", { files, rechecks: ["responsibility"] }), allow)).toMatchObject({ verdict: "merge", reasons: [] });
    // nothing large: the flag does nothing and asks for no mark
    expect(judge(base(), allow)).toMatchObject({ verdict: "merge", impact: "small", reasons: [] });
    expect(judge(base({ files: [files[1]!], rechecks: ["responsibility"] }), allow)).toMatchObject({ verdict: "merge", impact: "large", reasons: [] });
  });
});

describe("security", () => {
  test.each([
    ["src/auth.ts", "words"],
    ["internal/auth/x.go", "words"],
    ["app/Approval.py", "words"],
    ["server/permissions.ts", "words"],
    ["config/secrets.yaml", "words"],
    ["pkg/credential_store.rs", "words"],
    ["api/tokens/refresh.ts", "words"],
    ["src/crypto-utils.ts", "words"],
    ["runner/sandbox/profile.sb", "words"],
    [".github/workflows/release.yml", "github"],
    [".github/CODEOWNERS", "github"],
    [".env", "words"],
    ["apps/api/.env.production", "words"],
    [".gitleaks.toml", "words"],
    ["bun.lock", "lockfile"],
    ["apps/web/package-lock.json", "lockfile"],
    ["pnpm-lock.yaml", "lockfile"],
    ["yarn.lock", "lockfile"],
    ["py/uv.lock", "lockfile"],
    ["poetry.lock", "lockfile"],
    ["requirements.txt", "lockfile"],
    ["svc/requirements-dev.txt", "lockfile"],
    ["go.sum", "lockfile"],
    ["crates/x/Cargo.lock", "lockfile"],
    // the gate and the stand-in for CI decide merges themselves (#751)
    ["scripts/merge-gate.ts", "gates"],
    ["scripts/local-ci.ts", "gates"],
  ])("one line in %s stops as セキュリティ（security:%s）", (path, group) => {
    const j = judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", ask: [`security:${group}`] });
    expect(j.reasons).toEqual([`[聞く] セキュリティ（security:${group}）: ${path}`]);
  });

  test("a security reason for aws/host/** points at #852; other security reasons do not change (#852)", () => {
    const host = judge(base({ files: [{ path: "aws/host/sb-env.sh", additions: 1, deletions: 0 }] }), off);
    expect(host).toMatchObject({ verdict: "stop", impact: "large", ask: ["security:host"] });
    expect(host.reasons).toEqual([expect.stringMatching(/^\[聞く\] セキュリティ（security:host）: aws\/host\/sb-env\.sh（aws\/host は.*root が main から.*#852.*docs\/design\/cloud-hosting\.md §6\.5）$/)]);
    const ci = judge(base({ files: [{ path: ".github/workflows/ci.yml", additions: 1, deletions: 0 }] }), off);
    expect(ci.reasons).toEqual(["[聞く] セキュリティ（security:github）: .github/workflows/ci.yml"]);
  });

  test.each(["src/tokenizer.ts", "apps/web/package.json", "src/authorize.ts", "docs/guide/sandboxing.md"])("%s alone does not stop", (path) => {
    expect(judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
  });

  test("the paths of a group go in one reason, in the PR's order; the groups in SECURITY_KINDS' order", () => {
    const files = ["src/a.ts", "go.sum", "src/token.ts", "src/secret.ts"].map((path) => ({ path, additions: 1, deletions: 0 }));
    expect(judge(base({ files }), off)).toMatchObject({
      reasons: ["[聞く] セキュリティ（security:words）: src/token.ts, src/secret.ts", "[聞く] セキュリティ（security:lockfile）: go.sum"],
      ask: ["security:words", "security:lockfile"],
    });
  });
});

describe("security sub-kinds", () => {
  const one = (path: string) => judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);

  test.each([
    ["docs/design/secret-guard.md", "security:docs"],
    ["src/auth/x.ts", "security:words"],
    [".env.local", "security:words"],
    ["bun.lock", "security:lockfile"],
    [".github/workflows/ci.yml", "security:github"],
    ["scripts/local-ci.ts", "security:gates"],
    ["aws/host/sb-host-update.sh", "security:host"],
  ] as const)("%s → %s: the reason names the group, ask has it, still asked", (path, kind) => {
    const j = one(path);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", ask: [kind], recheck: [] });
    expect(j.reasons).toHaveLength(1);
    expect(j.reasons[0]).toStartWith(`[聞く] セキュリティ（${kind}）: ${path}`);
  });

  test("a path in two groups is in both", () => {
    expect(one(".github/workflows/secret-scan.yml")).toMatchObject({
      verdict: "stop",
      reasons: ["[聞く] セキュリティ（security:words）: .github/workflows/secret-scan.yml", "[聞く] セキュリティ（security:github）: .github/workflows/secret-scan.yml"],
      ask: ["security:words", "security:github"],
    });
  });

  test("a document is security:docs alone, before the other groups; an instruction is not a document", () => {
    // a document under a group's paths is docs only, and the host note goes with security:host only
    expect(one("aws/host/README.md")).toMatchObject({ reasons: ["[聞く] セキュリティ（security:docs）: aws/host/README.md"], ask: ["security:docs"] });
    expect(one("docs/design/session-sandbox.md").ask).toEqual(["security:docs"]);
    // skills, CLAUDE.md, AGENTS.md and the .github templates decide what a Task gets: their group, not docs
    expect(one(".github/PULL_REQUEST_TEMPLATE.md").ask).toEqual(["security:github"]);
    expect(one(".github/workflows/README.md").ask).toEqual(["security:github"]);
    expect(one(".claude/skills/auth/SKILL.md").ask).toEqual(["security:words"]);
    expect(one("ops-kit/skills/secret-x/SKILL.md").ask).toEqual(["security:words"]);
    expect(one("aws/host/CLAUDE.md").ask).toEqual(["security:host"]);
    expect(one("auth/AGENTS.md").ask).toEqual(["security:words"]);
  });

  test("--allow-large needs a yes naming every group left", () => {
    const files = [{ path: "bun.lock", additions: 1, deletions: 0 }, { path: "scripts/merge-gate.ts", additions: 1, deletions: 0 }];
    const allow = { allowLarge: true };
    expect(judge(yes("security:lockfile", { files }), allow).verdict).toBe("stop");
    expect(judge(yes("security", { files }), allow).verdict).toBe("stop");
    expect(judge(yes("security:lockfile,security:gates", { files }), allow)).toMatchObject({ verdict: "merge", ask: ["security:lockfile", "security:gates"] });
  });
});

describe("responsibility", () => {
  test.each(["docs/design/x.md", "CLAUDE.md", "packages/core/CLAUDE.md", "AGENTS.md", "ops.config.json", ".claude/skills/a/SKILL.md", "ops-kit/skills/a/SKILL.md"])(
    "one line in %s stops as 責務",
    (path) => {
      const j = judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);
      expect(j).toMatchObject({ verdict: "stop", impact: "large" });
      expect(j.reasons).toEqual([`[再チェック responsibility] 責務: ${path}`]);
    },
  );

  test("docs outside docs/design do not stop", () => {
    expect(judge(base({ files: [{ path: "docs/guide/setup.md", additions: 1, deletions: 0 }] }), off).verdict).toBe("merge");
  });

  test("README.md's Design rules: in the reason when touched, nothing when not", () => {
    const files = [{ path: "README.md", additions: 1, deletions: 0 }];
    expect(judge(base({ files, designRulesTouched: true }), off).reasons).toEqual(["[再チェック design-rules] 責務: README.md の ## Design rules"]);
    expect(judge(base({ files }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
  });

  // lines: 1 # T / 2 intro / 3 (blank) / 4 ## Design rules / 5 - rule one / 6 - rule two / 7 (blank) / 8 ## License / 9 Apache
  const readme = "# T\nintro\n\n## Design rules\n- rule one\n- rule two\n\n## License\nApache\n";

  test("designRulesTouched: a line outside the section does not count", () => {
    expect(designRulesTouched(readme, "@@ -1,3 +1,3 @@\n # T\n-intro\n+intro, changed\n \n")).toBe(false);
    expect(designRulesTouched(readme, "@@ -8,2 +8,3 @@\n ## License\n Apache\n+more\n")).toBe(false);
    // added just before the heading: still outside
    expect(designRulesTouched(readme, "@@ -2,2 +2,3 @@\n intro\n \n+new\n")).toBe(false);
  });

  test("designRulesTouched: a changed, deleted or added line inside counts", () => {
    expect(designRulesTouched(readme, "@@ -4,3 +4,3 @@\n ## Design rules\n-- rule one\n+- rule 1\n - rule two\n")).toBe(true);
    expect(designRulesTouched(readme, "@@ -5,2 +5,1 @@\n - rule one\n-- rule two\n")).toBe(true);
    // appended at the end of the section, right before ## License
    expect(designRulesTouched(readme, "@@ -6,3 +6,4 @@\n - rule two\n \n+- rule three\n ## License\n")).toBe(true);
    // a hunk with no context: -6,0 adds after old line 6
    expect(designRulesTouched(readme, "@@ -6,0 +7 @@\n+- rule three\n")).toBe(true);
    // the heading itself
    expect(designRulesTouched(readme, "@@ -4 +4 @@\n-## Design rules\n+## Rules\n")).toBe(true);
  });

  test("designRulesTouched: a README without the heading is not looked at", () => {
    expect(designRulesTouched("# T\nall about it\n", "@@ -2 +2 @@\n-all about it\n+changed\n")).toBe(false);
  });

  test("designRulesTouched: the section runs to the end when no heading follows", () => {
    expect(designRulesTouched("# T\n## Design rules\n- a\n", "@@ -3 +3,2 @@\n - a\n+- b\n")).toBe(true);
  });
});

describe("recheck", () => {
  const one = (path: string, additions = 1) => [{ path, additions, deletions: 0 }];
  const marked = (files: PrFacts["files"], rechecks: RecheckKind[], over: Partial<PrFacts> = {}) => judge(base({ files, rechecks, ...over }), off);

  test.each([
    ["security only", one("src/auth.ts"), ["[聞く] セキュリティ（security:words）: src/auth.ts"], ["security:words"], []],
    ["rescue only", one("rescue/src/server.ts"), ["[再チェック rescue] rescue: rescue/src/server.ts"], [], ["rescue"]],
    ["Design rules only", one("README.md"), ["[再チェック design-rules] 責務: README.md の ## Design rules"], [], ["design-rules"]],
    ["responsibility only", one("docs/design/x.md"), ["[再チェック responsibility] 責務: docs/design/x.md"], [], ["responsibility"]],
    ["size only", one("apps/web/src/App.tsx", 301), ["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている"], [], ["size"]],
    ["another protected path", one("scripts/setup/x.sh"), ["[再チェック size] 保護するパスに触れている: scripts/setup/x.sh"], [], ["size"]],
    ["db.ts only", one("packages/core/src/db.ts"), ["[再チェック migration] 保護するパスに触れている: packages/core/src/db.ts"], [], ["migration"]],
  ] as const)("%s: the reason's head, ask and recheck", (_, files, reasons, ask, recheck) => {
    const j = judge(base({ files: [...files], designRulesTouched: files[0]!.path === "README.md" || undefined }), off);
    expect(j).toEqual({ verdict: "stop", impact: "large", reasons: [...reasons], ask: [...ask], recheck: [...recheck] });
  });

  test("security stays an ask kind: a mark does not lift it, --allow-large does", () => {
    const files = [...one("src/auth.ts"), ...one("go.sum")];
    const ask = ["security:words", "security:lockfile"];
    expect(judge(base({ files }), off).ask).toEqual(ask);
    expect(judge(base({ files, rechecks: ["size", "rescue"] }), off)).toMatchObject({ verdict: "stop", reasons: ["[聞く] セキュリティ（security:words）: src/auth.ts", "[聞く] セキュリティ（security:lockfile）: go.sum"], ask, recheck: [] });
    expect(judge(yes("security:words,security:lockfile", { files }), { allowLarge: true })).toMatchObject({ verdict: "merge", reasons: [], ask });
    // a yes for one group does not lift the other
    expect(judge(yes("security:words", { files }), { allowLarge: true })).toMatchObject({ verdict: "stop" });
    expect(RECHECK_PASS.exec(`[recheck] security pass ${"a".repeat(40)}`)).toBeNull();
    expect(RECHECK_PASS.exec(`[recheck] security:lockfile pass ${"a".repeat(40)}`)).toBeNull();
  });

  test("rescue is a recheck kind: its mark lifts it, another kind's or none does not", () => {
    const files = one("rescue/src/x.ts");
    expect(judge(base({ files }), off)).toMatchObject({ verdict: "stop", impact: "large", ask: [], recheck: ["rescue"], reasons: ["[再チェック rescue] rescue: rescue/src/x.ts"] });
    expect(marked(files, ["rescue"])).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    expect(marked(files, ["size"]).reasons).toEqual(["[再チェック rescue] rescue: rescue/src/x.ts"]);
    // a responsibility file inside rescue is still rescue; a security one there says セキュリティ
    expect(marked(one("rescue/CLAUDE.md"), ["responsibility"])).toMatchObject({ verdict: "stop", reasons: ["[再チェック rescue] rescue: rescue/CLAUDE.md"], recheck: ["rescue"] });
    expect(marked(one("rescue/src/auth.ts"), ["rescue"]).reasons).toEqual(["[聞く] セキュリティ（security:words）: rescue/src/auth.ts"]);
  });

  test("design-rules is a recheck kind: its mark lifts it, another kind's or none does not", () => {
    const files = one("README.md");
    const over = { designRulesTouched: true };
    expect(judge(base({ files, ...over }), off)).toMatchObject({ verdict: "stop", impact: "large", ask: [], recheck: ["design-rules"], reasons: ["[再チェック design-rules] 責務: README.md の ## Design rules"] });
    expect(marked(files, ["design-rules"], over)).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    expect(marked(files, ["responsibility"], over).reasons).toEqual(["[再チェック design-rules] 責務: README.md の ## Design rules"]);
  });

  test("the kinds come once each, in the order size, responsibility, migration", () => {
    const files = [
      { path: "packages/core/src/db.ts", additions: 1, deletions: 0 },
      { path: "docs/design/x.md", additions: 1, deletions: 0 },
      { path: "apps/web/src/App.tsx", additions: 301, deletions: 0 },
      { path: "package.json", additions: 1, deletions: 0 },
    ];
    expect(judge(base({ files }), off).recheck).toEqual(["size", "responsibility", "migration"]);
  });

  test("a recheck-only PR with a mark per kind merges; impact stays large", () => {
    expect(marked(one("docs/design/x.md"), ["responsibility"])).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    const files = [...one("apps/web/src/App.tsx", 301), ...one("docs/design/x.md"), ...one("packages/core/src/schema-baseline.json")];
    expect(marked(files, ["size", "responsibility", "migration"])).toMatchObject({ verdict: "merge", reasons: [], ask: [], recheck: [] });
  });

  test("a kind without its mark still stops, and only that kind is left", () => {
    const files = [...one("apps/web/src/App.tsx", 301), ...one("docs/design/x.md")];
    expect(marked(files, ["responsibility"])).toEqual({
      verdict: "stop",
      impact: "large",
      reasons: ["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている"],
      ask: [],
      recheck: ["size"],
    });
  });

  test("a mark does not lift an ask reason", () => {
    const files = [...one("src/auth.ts"), ...one("docs/design/x.md")];
    expect(marked(files, ["size", "responsibility", "migration"])).toMatchObject({ verdict: "stop", reasons: ["[聞く] セキュリティ（security:words）: src/auth.ts"], recheck: [] });
  });

  test.each([
    ["a failing CI", { checks: [{ name: "test", conclusion: "FAILURE" }] }, "CI のチェック test が FAILURE"],
    ["an unresolved thread", { unresolvedThreads: 1 }, "解決していないレビュースレッドが 1 件ある"],
    ["a commit after the review", { headCommittedAt: "2026-09-24T12:00:00Z" }, "最後のコミット（2026-09-24T12:00:00Z）より新しい主レビュー（[codex] review / [claude] review）が無い"],
    ["not CLEAN", { mergeState: "BLOCKED" }, "mergeStateStatus が CLEAN でない: BLOCKED"],
  ] as const)("a mark does not lift %s", (_, over, reason) => {
    expect(marked(one("docs/design/x.md"), ["responsibility"], over as Partial<PrFacts>)).toMatchObject({ verdict: "stop", reasons: [reason] });
  });
});

describe("task scope", () => {
  const file = (path: string) => ({ path, additions: 1, deletions: 0 });
  const task = (named: string[], siblings: { number: number; paths: string[] }[] = []) => ({ numbers: [2346], named, siblings });

  test("outside the task: stops and lists every outside path in the PR's order; a directory covers what is under it", () => {
    const files = ["z.ts", "ops-kit/src/x.ts", "scripts/a.ts", "b.ts", "scripts/a.test.ts"].map(file);
    const j = judge(base({ files, task: task(["ops-kit/", "scripts/a.ts"]) }), off);
    expect(j.verdict).toBe("stop");
    expect(j.impact).toBe("small");
    expect(j.reasons).toEqual(["Task #2346 の本文に名指しの無いファイル: z.ts, b.ts, scripts/a.test.ts"]);
  });

  test("outside the task: nothing outside adds no reason; two Tasks are both named", () => {
    expect(judge(base({ files: [file("a.ts")], task: task(["a.ts"]) }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
    expect(judge(base({ files: [file("b.ts")], task: { numbers: [1, 2], named: ["a.ts"], siblings: [] } }), off).reasons)
      .toEqual(["Task #1, #2 の本文に名指しの無いファイル: b.ts"]);
  });

  test("named by a sibling: the Tasks that name it follow the path, the smaller number first", () => {
    const j = judge(base({
      files: ["packages/core/src/policies.ts", "b.ts"].map(file),
      task: task(["a.ts"], [{ number: 2352, paths: ["packages/"] }, { number: 2351, paths: ["packages/core/src/policies.ts"] }, { number: 2353, paths: ["c.ts"] }]),
    }), off);
    expect(j.reasons).toEqual(["Task #2346 の本文に名指しの無いファイル: packages/core/src/policies.ts（Task #2351、Task #2352 が名指し）, b.ts"]);
  });

  test("allow-large keeps the reason, as an unresolved thread; naming the path in the Task lifts it", () => {
    const files = [file("rescue/x.ts")];
    const kept = judge(yes("rescue", { files, task: task(["a.ts"]) }), { allowLarge: true });
    expect(kept).toMatchObject({ verdict: "stop", impact: "large" });
    expect(kept.reasons).toEqual(["Task #2346 の本文に名指しの無いファイル: rescue/x.ts"]);
    expect(judge(yes("rescue", { files, task: task(["a.ts", "rescue/x.ts"]) }), { allowLarge: true })).toMatchObject({ verdict: "merge", reasons: [] });
  });

  test("no task: a PR without one judges as before; a Task with no path does not stop and says so in notes", () => {
    expect(judge(base(), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
    expect(judge(base({ task: task([]) }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [], notes: ["Task #2346 の本文からパスが読めない（範囲の検査をしていない）"] });
  });
});

describe("merge-gate readPr", () => {
  const view = {
    files: [{ path: "a.ts", additions: 1, deletions: 2, changeType: "MODIFIED" }],
    commits: [
      { authoredDate: "2026-09-24T09:00:00Z", committedDate: "2026-09-24T13:00:00Z" },
      { authoredDate: "2026-09-24T10:00:00Z", committedDate: "2026-09-24T13:00:00Z" },
    ],
    headRefName: "work-a",
    headRefOid: "abc123",
    mergeStateStatus: "CLEAN",
    comments: [{ body: "[codex] review", createdAt: "2026-09-24T11:00:00Z", author: { login: "x" }, authorAssociation: "MEMBER" }],
  };
  const threads = (nodes: { isResolved: boolean }[], totalCount = nodes.length) =>
    ({ data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } } });
  const runs = {
    total_count: 3,
    workflow_runs: [
      { id: 2, name: "CI", status: "completed", conclusion: "success", created_at: "2026-09-24T12:00:00Z" }, // a later run of the same workflow
      { id: 1, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-09-24T11:00:00Z" },
      { id: 3, name: "labels", status: "in_progress", conclusion: null, created_at: "2026-09-24T11:30:00Z" },
    ],
  };
  const calls: string[][] = [];
  const fake = (t: unknown) => async (args: string[]) => {
    calls.push(args);
    return JSON.stringify(args[0] === "pr" ? view : args[1]?.includes("/actions/runs") ? runs : t);
  };

  test("maps gh output to PrFacts; the head time is the newest author date", async () => {
    const f = await readPr(1, fake(threads([{ isResolved: true }, { isResolved: false }])));
    expect(f).toEqual({
      files: [{ path: "a.ts", additions: 1, deletions: 2 }],
      headCommittedAt: "2026-09-24T10:00:00Z",
      checks: [{ name: "CI", conclusion: "SUCCESS" }, { name: "labels", conclusion: "" }],
      unresolvedThreads: 1,
      mergeState: "CLEAN",
      reviewComments: [{ body: "[codex] review", createdAt: "2026-09-24T11:00:00Z" }],
      head: "abc123",
      base: undefined,
    });
  });

  test("CI comes from the head commit's Actions runs, not statusCheckRollup (a fine-grained token has no Checks)", async () => {
    calls.length = 0;
    await readPr(1, fake(threads([])));
    expect(calls[0]!.join(" ")).not.toContain("statusCheckRollup");
    expect(calls[0]!.join(" ")).toContain("headRefOid");
    expect(calls.find((a) => a[0] === "api" && a[1]!.includes("/actions/runs"))![1]).toBe(`repos/${REPO}/actions/runs?head_sha=abc123&per_page=100`);
  });

  test("another repository (--repo): the PR, its runs and its review threads are read there", async () => {
    calls.length = 0;
    await readPr(7, fake(threads([])), "acme/lib");
    expect(calls[0]!.slice(0, 5)).toEqual(["pr", "view", "7", "-R", "acme/lib"]);
    expect(calls.find((a) => a[0] === "api" && a[1]!.includes("/actions/runs"))![1]).toBe("repos/acme/lib/actions/runs?head_sha=abc123&per_page=100");
    const q = calls.find((a) => a[1] === "graphql")!;
    expect(q[q.indexOf("o=acme") - 1]).toBe("-f"); // a string even for a name like "123" or "true"
    expect(q[q.indexOf("r=lib") - 1]).toBe("-f");
    expect(calls.flat().join(" ")).not.toContain("switchboard");
  });

  describe("the Tasks a PR closes (#2498)", () => {
    const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
    const issues: Record<number, unknown> = {
      5: {
        number: 5, body: "`scripts/a.ts:3`、`ops-kit/` と new/x.ts", labels: labels("type:task"),
        parent: { subIssues: { nodes: [
          { number: 5, body: "`scripts/a.ts`", labels: labels("type:task") },
          { number: 6, body: "`scripts/b.ts`", labels: labels("type:task") },
          { number: 7, body: "`scripts/c.ts`", labels: labels("type:pbi") },
        ] } },
      },
      9: { number: 9, body: "`scripts/a.ts`", labels: labels("type:pbi"), parent: null },
    };
    const gate = (pr: { body: string; headRefName: string }, seen: string[][] = []) => async (args: string[]) => {
      seen.push(args);
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ ...view, ...pr, files: [{ path: "new/x.ts", additions: 1, deletions: 0 }] });
      if (args[0] === "pr") return "[]";
      if (args[1]?.includes("/actions/runs")) return JSON.stringify(runs);
      if (args[1]?.endsWith("/contents")) return JSON.stringify([{ name: "scripts", type: "dir" }, { name: "ops-kit", type: "dir" }]);
      const n = args.find((a) => a.startsWith("n="));
      if (args[1] === "graphql" && args.some((a) => a.includes("issue(number"))) return JSON.stringify({ data: { repository: { issue: issues[Number(n!.slice(2))] } } });
      return JSON.stringify(threads([]));
    };

    test("Closes #N and the branch sb/<n>- name the same Task once; the PR's new top directory starts a path", async () => {
      const seen: string[][] = [];
      const f = await readPr(1, gate({ body: "Closes #5。", headRefName: "sb/5-a" }, seen));
      expect(f.task).toEqual({ numbers: [5], named: ["scripts/a.ts", "new/x.ts", "ops-kit/"], siblings: [{ number: 6, paths: ["scripts/b.ts"] }] });
      expect(seen.filter((a) => a.some((x) => x.includes("issue(number")))).toHaveLength(1);
      expect(seen[0]!.join(" ")).toContain("body,");
    });

    test("the branch alone links a Task", async () => {
      expect((await readPr(1, gate({ body: "", headRefName: "sb/5-a" }))).task?.numbers).toEqual([5]);
    });

    test("an Issue that is not type:task, or a `Backlog-Task:` line, gives no task", async () => {
      expect(await readPr(1, gate({ body: "Closes #9", headRefName: "work-a" }))).not.toHaveProperty("task");
      const seen: string[][] = [];
      expect(await readPr(1, gate({ body: "Backlog-Task: 5\n", headRefName: "sb/5-a" }, seen))).not.toHaveProperty("task");
      expect(seen.some((a) => a.some((x) => x.includes("issue(number")))).toBe(false);
    });

    test("an Issue that cannot be read throws (not judged)", async () => {
      const run = gate({ body: "Closes #5", headRefName: "work-a" });
      await expect(readPr(1, async (a) => {
        if (a.some((x) => x.includes("issue(number"))) throw new Error("gh api graphql failed");
        return run(a);
      })).rejects.toThrow("gh api graphql failed");
    });
  });

  test("checksFromRuns: the newest run per workflow; not completed is 未完了; the conclusion upper-cased", () => {
    expect(checksFromRuns([
      { id: 1, name: "CI", status: "completed", conclusion: "success", created_at: "2026-09-24T12:00:00Z" },
      { id: 2, name: "CI", status: "queued", conclusion: null, created_at: "2026-09-24T13:00:00Z" }, // a later run just started
      { id: 3, name: "release", status: "completed", conclusion: "skipped", created_at: "2026-09-24T12:00:00Z" },
    ])).toEqual([{ name: "CI", conclusion: "" }, { name: "release", conclusion: "SKIPPED" }]);
    expect(judge({ files: [], headCommittedAt: "2026-09-24T10:00:00Z", checks: checksFromRuns([{ id: 1, name: "CI", status: "completed", conclusion: "failure", created_at: "x" }]), unresolvedThreads: 0, mergeState: "CLEAN", reviewComments: [{ body: "[codex] review", createdAt: "2026-09-24T11:00:00Z" }] }, { allowLarge: false }).reasons)
      .toEqual(["CI のチェック CI が FAILURE"]);
    expect(checksFromRuns([])).toEqual([]);
  });

  describe("local CI in place of an Actions CI that never started or never ran (#387, #914, #2940, #3118)", () => {
    const BASE = "3333333333333333333333333333333333333333";
    /**
     * A real repository (#3118): `url` is "GitHub" (a bare one), `clone` the worktree merge-gate runs in (empty: it fetches
     * what it judges by). `S`: named commits. main0 ← b1 ← b2 ← b3 is the stack (#1, #2, #3: one commit each, its own file);
     * main1 is main after another commit and #1's rebase merge, b2r #2 rebased onto it by GitHub (another sha, the same
     * diff); b2fix #2 with a fix commit on it, b2changed #2's commit made again with another diff, b2merge #2 with a merge
     * commit that changes a file; s1 a single PR on main0.
     */
    let dir = "";
    let url = "";
    let clone = "";
    const S: Record<string, string> = {};
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "merge-gate-cherry."));
      url = join(dir, "gh.git");
      clone = join(dir, "clone");
      const a = join(dir, "author");
      execFileSync("git", ["init", "-q", "--bare", url]);
      execFileSync("git", ["init", "-q", "-b", "main", a]);
      execFileSync("git", ["init", "-q", clone]);
      git(a, "config", "user.name", "t");
      git(a, "config", "user.email", "t@example.com");
      git(a, "config", "commit.gpgsign", "false");
      const commit = (file: string, text: string) => {
        writeFileSync(join(a, file), text);
        git(a, "add", file);
        git(a, "commit", "-q", "-m", `${file}: ${text}`);
        return git(a, "rev-parse", "HEAD");
      };
      const at = (sha: string) => git(a, "checkout", "-q", "--detach", sha);
      S.main0 = commit("README", "base\n");
      S.b1 = commit("one", "1\n");
      S.b2 = commit("two", "2\n");
      S.b3 = commit("three", "3\n");
      S.b2fix = (at(S.b2), commit("two", "2 fixed\n"));
      S.b2changed = (at(S.b1), commit("two", "2 other\n"));
      // #2 with #3's commit merged in, and a change made in the merge commit (as a conflict resolved there)
      at(S.b2);
      git(a, "merge", "-q", "--no-ff", "--no-commit", S.b3);
      writeFileSync(join(a, "two"), "2 resolved\n");
      git(a, "add", "two");
      git(a, "commit", "-q", "-m", "merge");
      S.b2merge = git(a, "rev-parse", "HEAD");
      at(S.main0);
      commit("other", "x\n");
      git(a, "cherry-pick", S.b1);
      S.main1 = git(a, "rev-parse", "HEAD");
      git(a, "cherry-pick", S.b2);
      S.b2r = git(a, "rev-parse", "HEAD");
      S.s1 = (at(S.main0), commit("single", "s\n"));
      for (const [name, sha] of Object.entries(S)) git(a, "push", "-q", url, `${sha}:refs/heads/${name}`);
    });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    /** A result mark, the first line only (another repository's copy of local-ci writes no more). */
    const pass = (head: string, base = BASE) => `[local-ci] pass ${head} base=${base}\n\n| 手順 | 結果 |`;
    const fail = (head: string, base = BASE) => `[local-ci] fail ${head} base=${base}\n\n結果: \`bun test\` が exit 1`;
    const owner = (bodies: string[]) => bodies.map((body, i) => ({ body, createdAt: `2026-09-24T11:3${i}:00Z`, authorAssociation: "OWNER" }));
    /**
     * PR `n` (head branch `b<n>`, head `head` and base tip `baseTip`, by default the stack's) and its stack: `above` = the
     * open PRs per base branch (`b1: [2]` → #2 is on #1), the top's comments `top`. `comment` / `comments`: PR n's, by the
     * owner, a minute apart. `runs: false` = no Actions run at all; `conclusion`: the one run's (default failure).
     * `root` / `from`: where merge-gate fetches to and from (default the clone and "GitHub").
     */
    const facts = (opts: { n?: number; comment?: string; comments?: string[]; steps: number; runs?: boolean; conclusion?: string; mergeState?: string; above?: Record<string, number[]>; top?: string[]; head?: string; baseTip?: string; root?: string; from?: string }) => {
      const n = opts.n ?? 1;
      const bodies = opts.comments ?? (opts.comment ? [opts.comment] : []);
      const v = {
        ...view,
        headRefName: `b${n}`,
        headRefOid: opts.head ?? S[`b${n}`],
        baseRefName: "main",
        baseRefOid: opts.baseTip ?? (n === 1 ? S.main0 : S[`b${n - 1}`]),
        mergeStateStatus: opts.mergeState ?? "CLEAN",
        comments: [...view.comments, ...owner(bodies)],
      };
      const r = { workflow_runs: opts.runs === false ? [] : [{ id: 7, name: "CI", status: "completed", conclusion: opts.conclusion ?? "failure", created_at: "2026-09-24T12:00:00Z" }] };
      const jobs = { jobs: [{ name: "test", steps: Array.from({ length: opts.steps }, () => ({ name: "x" })) }] };
      const asked: string[] = [];
      const run = async (args: string[]) => {
        asked.push(args.join(" "));
        if (args[0] === "pr" && args[1] === "list") {
          const ref = args[args.indexOf("--base") + 1]!;
          return JSON.stringify((opts.above?.[ref] ?? []).map((number) => ({ number, headRefName: `b${number}` })));
        }
        // an outsider's pass on the top (newer than the owner's) does not count
        if (args[0] === "pr" && args.at(-1) === "comments") return JSON.stringify({ comments: [...owner(opts.top ?? []), { body: pass(S.b2fix!), createdAt: "2026-09-24T13:00:00Z", authorAssociation: "NONE" }] });
        if (args[0] === "pr") return JSON.stringify(v);
        if (args[1]?.endsWith("/actions/runs/7/jobs")) return JSON.stringify(jobs);
        if (args[1]?.includes("/actions/runs")) return JSON.stringify(r);
        return JSON.stringify(threads([]));
      };
      return { asked, run, read: (repo?: string) => readPr(n, run, repo, { root: opts.root ?? clone, url: opts.from ?? url }) };
    };
    const reasons = (f: PrFacts) => judge({ ...f, unresolvedThreads: 0 }, { allowLarge: false }).reasons;
    const SUCCESS = [{ name: "CI（Actions が始まらず、ローカルで pass）", conclusion: "SUCCESS" }];
    const STACK = { b1: [2], b2: [3] };

    test("never started (no steps) + its own pass → SUCCESS; the base's tip is not read from GitHub", async () => {
      const x = facts({ comment: pass(S.b1!), steps: 0 });
      const f = await x.read();
      expect(f.checks).toEqual(SUCCESS);
      expect(f.localCi).toBe(true);
      expect(x.asked.some((a) => a.includes("/git/ref/"))).toBe(false);
      // GitHub calls it UNSTABLE for the failed run; that alone does not stop the merge then
      expect(reasons({ ...f, mergeState: "UNSTABLE" })).toEqual([]);
      expect(reasons({ ...f, mergeState: "UNSTABLE", localCi: undefined })).toEqual(["mergeStateStatus が CLEAN でない: UNSTABLE"]);
    });

    test("a narrowed pass counts as any pass: the comment's added lines change nothing (#3297)", async () => {
      const body = resultComment({ sha: S.b1!, base: BASE, ok: true, results: [], selection: { files: ["a.test.ts"], total: 200, reason: "x" } });
      expect(await localCiOf(1, 1, [{ body, createdAt: "2026-11-01T00:00:00Z" }], async () => "", "o/r", async (h) => h === S.b1)).toEqual({ pass: true });
    });

    test("no Actions run at all + the pass → one local-ci SUCCESS check; without it, no check", async () => {
      const f = await facts({ comment: pass(S.b1!), steps: 0, runs: false }).read();
      expect(f.checks).toEqual([{ name: "local-ci（Actions の run が無く、ローカルで pass）", conclusion: "SUCCESS" }]);
      expect(f.localCi).toBe(true);
      expect(reasons(f)).toEqual([]);
      expect(reasons(await facts({ steps: 0, runs: false }).read())).toEqual(["CI のチェックが 1 つも無い"]);
    });

    test("every run skipped (the job's repository variable is not on) counts as no run: it passes only with a local pass", async () => {
      expect(reasons(await facts({ steps: 0, conclusion: "skipped" }).read())).toEqual(["CI のチェックが 1 つも無い"]);
      const f = await facts({ comment: pass(S.b1!), steps: 0, conclusion: "skipped" }).read();
      expect(f.checks).toEqual([{ name: "local-ci（Actions の run が無く、ローカルで pass）", conclusion: "SUCCESS" }]);
      expect(reasons(f)).toEqual([]);
    });

    test("--repo: another repository's pass → SUCCESS, read from that repository (#1203)", async () => {
      const x = facts({ steps: 0, above: { b1: [2] }, top: [pass(S.b2!)] });
      const f = await x.read("o/r");
      expect(f.checks).toEqual(SUCCESS);
      expect(x.asked.length).toBeGreaterThan(0);
      for (const a of x.asked) expect(a.includes("o/r") || a.includes("o=o")).toBe(true);
      expect(x.asked.some((a) => a.includes(REPO))).toBe(false);
    });

    test("a CI whose steps ran and failed stays FAILURE even with the pass", async () => {
      const f = await facts({ comment: pass(S.b1!), steps: 5 }).read();
      expect(f.checks).toEqual([{ name: "CI", conclusion: "FAILURE" }]);
      expect(f.localCi).toBeUndefined();
    });

    test("the older head-only mark, a mark not at the start, or none: FAILURE with no note; the jobs are not read", async () => {
      for (const comment of [`[local-ci] pass ${S.b1}`, `ok ${pass(S.b1!)}`, undefined]) {
        const x = facts({ comment, steps: 0 });
        const f = await x.read();
        expect(f.checks).toEqual([{ name: "CI", conclusion: "FAILURE" }]);
        expect(f.localCiNote).toBeUndefined();
        expect(x.asked.some((a) => a.includes("/jobs"))).toBe(false);
      }
    });

    test("the newest result of the top counts: a fail after a pass is no pass; a pass after a fail is", async () => {
      const failed = await facts({ comments: [pass(S.b1!), fail(S.b1!)], steps: 0 }).read();
      expect(reasons(failed)).toContain("一番上の PR #1 の local-ci の最新が fail");
      expect((await facts({ comments: [fail(S.b1!), pass(S.b1!)], steps: 0 }).read()).checks).toEqual(SUCCESS);
    });

    test("BLOCKED with the local pass: the base branch's protection stops it, and the reason says local-ci cannot meet it", async () => {
      const f = await facts({ comment: pass(S.b1!), steps: 0, mergeState: "BLOCKED" }).read();
      expect(reasons(f)).toEqual(["mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果は PR コメントで、GitHub の必須チェックにはならない（docs/merge-gate.md の「保護枝とローカルの結果」）"]);
      // without a local pass BLOCKED is said as before
      expect(reasons({ ...f, localCi: undefined, checks: [{ name: "CI", conclusion: "SUCCESS" }] })).toEqual(["mergeStateStatus が CLEAN でない: BLOCKED"]);
    });

    test("unknown: mergeStateStatus UNKNOWN is no judgement (readPr throws → exit 2)", async () => {
      await expect(facts({ comment: pass(S.b1!), steps: 0, mergeState: "UNKNOWN" }).read()).rejects.toThrow("UNKNOWN");
    });

    test("stack: a first-line-only pass on the top counts for the bottom and the middle; the top's newest fail does not", async () => {
      // #1 ← #2 ← #3; only #3 has a result, by the owner (an outsider's newer pass on #3 does not count)
      const x = facts({ steps: 0, above: STACK, top: [pass(S.b3!)] });
      const f = await x.read();
      expect(f.checks).toEqual(SUCCESS);
      expect(f.localCiNote).toBeUndefined();
      expect(reasons(f)).toEqual([]);
      expect(x.asked).toContain(`pr view 3 -R ${REPO} --json comments`);
      expect(reasons(await facts({ n: 2, steps: 0, above: { b2: [3] }, top: [pass(S.b3!)] }).read())).toEqual([]);
      expect(reasons(await facts({ steps: 0, above: STACK, top: [pass(S.b3!), fail(S.b3!)] }).read())).toContain("一番上の PR #3 の local-ci の最新が fail");
    });

    test("stack: GitHub's rebase after the bottom merges still counts", async () => {
      // #1 merged into main by rebase (after another commit); #2 is on main now: another sha, its commit's diff the same
      const f = await facts({ n: 2, head: S.b2r, baseTip: S.main1, steps: 0, above: { b2: [3] }, top: [pass(S.b3!)] }).read();
      expect(f.checks).toEqual(SUCCESS);
      expect(reasons(f)).toEqual([]);
    });

    test("stack: a fix commit or a conflict resolution that changes the diff does not", async () => {
      for (const head of [S.b2fix, S.b2changed, S.b2merge]) {
        const f = await facts({ n: 2, head, steps: 0, above: { b2: [3] }, top: [pass(S.b3!)] }).read();
        expect(reasons(f)).toEqual(["CI のチェック CI が FAILURE", `この PR のコミットが #3 の pass（${S.b3!.slice(0, 7)}）に同じ差分で入っていない（一番上で回し直す）`]);
      }
    });

    test("single PR and the top: their own pass, base moved is no rerun", async () => {
      // a single PR on main0, judged after main moved to main1
      expect((await facts({ head: S.s1, baseTip: S.main1, comment: pass(S.s1!), steps: 0 }).read()).checks).toEqual(SUCCESS);
      expect((await facts({ n: 3, comment: pass(S.b3!), steps: 0 }).read()).checks).toEqual(SUCCESS);
      // two PRs on it (a fork): the walk ends at this one, and its own pass is what counts
      expect((await facts({ comment: pass(S.b1!), steps: 0, above: { b1: [2, 3] }, top: [pass(S.b2!)] }).read()).checks).toEqual(SUCCESS);
      // a merge commit in the PR counts when the pass's head has it (its own pass)
      expect((await facts({ n: 2, head: S.b2merge, comment: pass(S.b2merge!), steps: 0 }).read()).checks).toEqual(SUCCESS);
      // its own pass of an older head (a commit added since) is not
      expect(reasons(await facts({ n: 2, head: S.b2fix, comment: pass(S.b2!), steps: 0 }).read())).toContain(`この PR のコミットが #2 の pass（${S.b2!.slice(0, 7)}）に同じ差分で入っていない（一番上で回し直す）`);
    });

    test("not judged: no git worktree or a fetch that fails throws, main exits 2", async () => {
      const plain = join(dir, "plain");
      mkdirSync(plain, { recursive: true });
      await expect(facts({ comment: pass(S.b1!), steps: 0, root: plain }).read()).rejects.toThrow("git の作業ツリーでない");
      // an empty worktree: the commits are not there yet (git does not ask the remote for commits it already has)
      const empty = join(dir, "empty");
      execFileSync("git", ["init", "-q", empty]);
      await expect(facts({ comment: pass(S.b1!), steps: 0, root: empty, from: join(dir, "none.git") }).read()).rejects.toThrow("を fetch できない");
      const errs: string[] = [];
      const code = await main(["1", "--repo", "o/r"], facts({ comment: pass(S.b1!), steps: 0 }).run, () => {}, (e) => errs.push(e), () => undefined, undefined, plain);
      expect(code).toBe(2);
      expect(errs.join("\n")).toContain("git の作業ツリーでない");
    });
  });

  test("recheck: only the head's [recheck] <kind> pass marks go in rechecks", async () => {
    const HEAD = "0123456789abcdef0123456789abcdef01234567";
    const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
    const read = (bodies: string[]) => {
      const v = { ...view, headRefOid: HEAD, comments: [...view.comments, ...bodies.map((body) => ({ body, createdAt: "2026-09-24T11:30:00Z", authorAssociation: "COLLABORATOR" }))] };
      return readPr(1, async (args) => JSON.stringify(args[0] === "pr" ? v : args[1]?.includes("/actions/runs") ? runs : threads([])));
    };
    const f = await read([
      `[recheck] migration pass ${HEAD}\n\n24 pass`,
      `[recheck] responsibility pass ${HEAD}`,
      `[recheck] rescue pass ${HEAD}`,
      `[recheck] design-rules pass ${OTHER}`, // an older head
      `[recheck] size pass ${OTHER}`, // an older head
      `ok [recheck] size pass ${HEAD}`, // not at the start
      `[recheck] security pass ${HEAD}`, // not a kind
    ]);
    expect(f.rechecks).toEqual(["responsibility", "migration", "rescue"]);
    expect((await read([])).rechecks).toBeUndefined();
  });

  test("marks by an author outside the repository (a public --repo) do not count: review, [local-ci], [recheck]", async () => {
    const HEAD = "0123456789abcdef0123456789abcdef01234567";
    const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
    const outsider = (body: string, authorAssociation?: string) => ({ body, createdAt: "2026-09-24T11:30:00Z", ...(authorAssociation ? { authorAssociation } : {}) });
    const v = {
      ...view,
      headRefOid: HEAD,
      comments: [
        outsider("[claude] review"),
        outsider(`[recheck] migration pass ${HEAD}`, "CONTRIBUTOR"),
        outsider(`[local-ci] pass ${HEAD} base=${OTHER}`, "NONE"),
        { ...view.comments[0]!, authorAssociation: "FIRST_TIME_CONTRIBUTOR" },
      ],
    };
    const r = { workflow_runs: [{ id: 7, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-09-24T12:00:00Z" }] };
    const f = await readPr(1, async (args) => JSON.stringify(args[0] === "pr" ? v : args[1]?.endsWith("/jobs") ? { jobs: [{ steps: [] }] } : args[1]?.includes("/actions/runs") ? r : threads([])));
    expect(f.reviewComments).toEqual([]);
    expect(f.rechecks).toBeUndefined();
    expect(f.checks).toEqual([{ name: "CI", conclusion: "FAILURE" }]);
  });

  describe("README.md's Design rules", () => {
    const readme = "# T\n\n## Design rules\n- a\n\n## License\n";
    const read = (file: object | null, changeType = "MODIFIED", base = readme) => {
      const asked: string[][] = [];
      const v = { ...view, baseRefOid: "base1", files: [{ path: "README.md", additions: 1, deletions: 0, changeType }] };
      return {
        asked,
        facts: readPr(1, async (args) => {
          asked.push(args);
          if (args[0] === "pr" && args[1] === "list") return "[]";
          if (args[0] === "pr") return JSON.stringify(v);
          if (args.some((a) => a.includes("/pulls/1/files"))) return file ? JSON.stringify(file) + "\n" : "";
          if (args.some((a) => a.includes("/compare/"))) return "merge1\n";
          if (args.some((a) => a.includes("/contents/README.md"))) return base;
          if (args[1]?.includes("/actions/runs")) return JSON.stringify(runs);
          return JSON.stringify(threads([]));
        }),
      };
    };

    test("the patch is read against the README at the merge base", async () => {
      const x = read({ filename: "README.md", patch: "@@ -4 +4 @@\n-- a\n+- b\n" });
      expect((await x.facts).designRulesTouched).toBe(true);
      expect(x.asked.find((a) => a.some((s) => s.includes("/compare/")))).toContain(`repos/${REPO}/compare/base1...abc123`);
      expect(x.asked.find((a) => a.some((s) => s.includes("/contents/")))).toContain(`repos/${REPO}/contents/README.md?ref=merge1`);
    });

    test("outside the section: no field", async () => {
      expect((await read({ filename: "README.md", patch: "@@ -1 +1 @@\n-# T\n+# U\n" }).facts).designRulesTouched).toBeUndefined();
    });

    test("no patch (too large for GitHub) counts as touched when the README has the heading", async () => {
      expect((await read({ filename: "README.md" }).facts).designRulesTouched).toBe(true);
      const x = read({ filename: "README.md" }, "MODIFIED", "# T\nno rules here\n");
      expect((await x.facts).designRulesTouched).toBeUndefined();
      expect(x.asked.some((a) => a.some((s) => s.includes("/pulls/1/files")))).toBe(false);
    });

    test("a new README, or none in the PR, reads nothing more", async () => {
      const x = read(null, "ADDED");
      expect((await x.facts).designRulesTouched).toBeUndefined();
      expect(x.asked.some((a) => a.some((s) => s.includes("/pulls/1/files") || s.includes("/contents/")))).toBe(false);
      calls.length = 0;
      await readPr(1, fake(threads([])));
      expect(calls.some((a) => a.some((s) => s.includes("/pulls/1/files")))).toBe(false);
    });
  });

  test("more review threads than one page fails instead of judging", async () => {
    const nodes = Array.from({ length: 100 }, () => ({ isResolved: true }));
    expect(readPr(1, fake(threads(nodes, 101)))).rejects.toThrow("101");
  });
});

describe("merge command merges only on verdict merge", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const view = (over: Record<string, unknown> = {}) => ({
    files: [{ path: "a.ts", additions: 1, deletions: 2, changeType: "MODIFIED" }],
    commits: [{ authoredDate: "2026-09-24T10:00:00Z" }],
    baseRefName: "main",
    headRefOid: SHA,
    mergeStateStatus: "CLEAN",
    comments: [{ body: "[codex] review", createdAt: "2026-09-24T11:00:00Z", authorAssociation: "MEMBER" }],
    ...over,
  });
  const runs = { workflow_runs: [{ id: 1, name: "CI", status: "completed", conclusion: "success", created_at: "2026-09-24T12:00:00Z" }] };
  const threads = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } };
  const gate = async (args: string[], v: Record<string, unknown> | Error = view(), o: { local?: string; headNow?: string } = {}) => {
    const calls: string[][] = [];
    const errs: string[] = [];
    const code = await main(args, async (a) => {
      calls.push(a);
      if (a[0] === "pr" && a[1] === "view") {
        if (v instanceof Error) throw v;
        return a.includes("-q") ? `${o.headNow ?? SHA}\n` : JSON.stringify(v);
      }
      if (a[0] === "repo") return "main\n";
      if (a[0] === "pr" && a[1] === "list") return "[]";
      if (a[0] === "pr" || a[0] === "stack") return "";
      return JSON.stringify(a[1]?.includes("/actions/runs") ? runs : threads);
    }, () => {}, (e) => errs.push(e), () => o.local ?? REPO);
    return { code, merges: calls.filter((a) => (a[0] === "pr" && a[1] === "merge") || a[0] === "stack"), errs };
  };

  test("--merge on verdict merge calls gh pr merge once, with the repository", async () => {
    const r = await gate(["7", "--merge", "--repo", "acme/lib"]);
    expect(r.code).toBe(0);
    expect(r.merges).toEqual([["pr", "merge", "7", "-R", "acme/lib", "--rebase", "--delete-branch", "--match-head-commit", SHA]]);
  });

  test("--merge-stack calls gh stack merge for the bottom PR of the working tree's repository at the judged head", async () => {
    const r = await gate(["7", "--merge-stack"]);
    expect(r.code).toBe(0);
    expect(r.merges).toEqual([["stack", "merge", "7", "--rebase", "-y"]]);
    // gh stack merges everything below the PR: an upper PR (base = another branch) is not merged
    expect(await gate(["7", "--merge-stack"], view({ baseRefName: "sb/1-lower" }))).toMatchObject({ code: 1, merges: [] });
    // gh stack takes no -R: a --repo other than the working tree's origin would merge another repository's PR of that number
    expect(await gate(["7", "--merge-stack", "--repo", "acme/lib"])).toMatchObject({ code: 1, merges: [] });
    // a push after the judgement
    expect(await gate(["7", "--merge-stack"], view(), { headNow: "e".repeat(40) })).toMatchObject({ code: 1, merges: [] });
  });

  test("stop (exit 1) and not judged (exit 2) do not merge; both flags at once are a usage error", async () => {
    expect(await gate(["7", "--merge"], view({ mergeStateStatus: "DIRTY" }))).toMatchObject({ code: 1, merges: [] });
    expect(await gate(["7", "--merge"], new Error("network"))).toMatchObject({ code: 2, merges: [] });
    expect(await gate(["7", "--merge"], view({ mergeStateStatus: "UNKNOWN" }))).toMatchObject({ code: 2, merges: [] });
    expect(await gate(["7", "--merge", "--merge-stack"])).toMatchObject({ code: 2, merges: [] });
  });

  test("--allow-large merges only after a [merge-answer] yes of the head", async () => {
    const large = { files: [{ path: "rescue/run.sh", additions: 1, deletions: 0, changeType: "MODIFIED" }] };
    const review = { body: "[codex] review", createdAt: "2026-09-24T11:00:00Z", authorAssociation: "MEMBER" };
    const answer = (sha: string, yes = "yes") => ({ body: `[merge-answer] ${yes} rescue ${sha}`, createdAt: "2026-09-24T12:00:00Z", authorAssociation: "MEMBER" });
    expect(await gate(["7", "--merge", "--allow-large"], view(large))).toMatchObject({ code: 1, merges: [] });
    expect(await gate(["7", "--merge", "--allow-large"], view({ ...large, comments: [review, answer("f".repeat(40))] }))).toMatchObject({ code: 1, merges: [] });
    expect(await gate(["7", "--merge", "--allow-large"], view({ ...large, comments: [review, answer(SHA, "no")] }))).toMatchObject({ code: 1, merges: [] });
    expect((await gate(["7", "--merge", "--allow-large"], view({ ...large, comments: [review, answer(SHA)] }))).merges).toHaveLength(1);
    // a yes about another kind does not lift this one
    const security = { files: [{ path: "packages/core/src/auth.ts", additions: 1, deletions: 0, changeType: "MODIFIED" }] };
    expect(await gate(["7", "--merge", "--allow-large"], view({ ...security, comments: [review, answer(SHA)] }))).toMatchObject({ code: 1, merges: [] });
    // the marks of an author who is not a member do not count, and the judgement alone asks for the mark too
    expect(await gate(["7", "--allow-large"], view({ ...large, comments: [review, { ...answer(SHA), authorAssociation: "NONE" }] }))).toMatchObject({ code: 1, merges: [] });
    expect(await gate(["7", "--allow-large"], view({ ...large, comments: [review, answer(SHA)] }))).toMatchObject({ code: 0, merges: [] });
  });

  test("a failed merge is exit 1 with gh's first line", async () => {
    const errs: string[] = [];
    const code = await main(["7", "--merge"], async (a) => {
      if (a[0] === "pr" && a[1] === "merge") throw new Error("gh pr merge failed: not mergeable\nmore");
      if (a[0] === "pr") return JSON.stringify(view());
      return JSON.stringify(a[1]?.includes("/actions/runs") ? runs : threads);
    }, () => {}, (e) => errs.push(e));
    expect(code).toBe(1);
    expect(errs).toEqual(["マージできなかった: gh pr merge failed: not mergeable"]);
  });
});

describe("record marks", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  test("[merge-ask] reads the kinds and the head sha on the first line", () => {
    expect(MERGE_ASK.exec(`[merge-ask] security,size ${SHA}`)?.slice(1)).toEqual(["security,size", SHA]);
    expect(MERGE_ASK.exec(`[merge-ask] design-rules ${SHA}\n\nPR #1 をマージしてよいか`)?.slice(1)).toEqual(["design-rules", SHA]);
    // the security groups (PBI #1873)
    expect(MERGE_ASK.exec(`[merge-ask] security:lockfile,rescue ${SHA}`)?.slice(1)).toEqual(["security:lockfile,rescue", SHA]);
  });

  test("[merge-answer] reads yes / no, the kinds and the head sha", () => {
    expect(MERGE_ANSWER.exec(`[merge-answer] yes rescue,responsibility ${SHA}`)?.slice(1)).toEqual(["yes", "rescue,responsibility", SHA]);
    expect(MERGE_ANSWER.exec(`[merge-answer] no security ${SHA}`)?.slice(1)).toEqual(["no", "security", SHA]);
    expect(MERGE_ANSWER.exec(`[merge-answer] yes security:lockfile,rescue ${SHA}`)?.slice(1)).toEqual(["yes", "security:lockfile,rescue", SHA]);
  });

  test.each([
    [MERGE_ASK, `[merge-ask] security ${SHA.slice(0, 7)}`], // a short sha
    [MERGE_ASK, `ok [merge-ask] security ${SHA}`], // not at the start
    [MERGE_ASK, `x\n[merge-ask] security ${SHA}`], // not the first line
    [MERGE_ANSWER, `[merge-answer] maybe security ${SHA}`], // not yes / no
    [MERGE_ANSWER, `[merge-answer] yes ${SHA}`], // no kinds
  ])("%p does not read %p", (re, body) => {
    expect(re.exec(body)).toBeNull();
  });
});

describe("merge-gate reads GitHub, not the stored backlog (#909)", () => {
  test("it does not import the daemon's database or the stored backlog: a PR's head, reviews, checks and protection are read from gh each time", async () => {
    const src = await Bun.file(new URL("./merge-gate.ts", import.meta.url)).text();
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
    expect(imports.filter((i) => /packages\/core|db|backlog|sqlite|parallel-guard/.test(i))).toEqual([]);
    expect(src).not.toMatch(/bun:sqlite|switchboard\.db|readStoredBacklog|listBacklogRecords/);
  });
});

describe("GitLab MR (#924)", () => {
  const HEAD = "1".repeat(40);
  const BASE = "2".repeat(40);
  const lab = { service: "gitlab", host: "gitlab.example.com", repository: "group/app" };
  const M = "projects/group%2Fapp/merge_requests/7";
  /** A fake GitLab MR: good to merge unless `over` says otherwise. */
  function gitlab(over: { status?: string; pipeline?: { sha: string; status: string } | null; notes?: Array<{ body: string; created_at: string; author: number }>; resolved?: boolean; files?: string[]; diffs?: unknown[]; merge?: number } = {}) {
    const calls: string[][] = [];
    const notes = over.notes ?? [{ body: "[codex] review\n\n### Verdict\nmergeable as is", created_at: "2026-10-28T02:00:00Z", author: 1 }];
    const sh = async (cmd: string[]) => {
      calls.push(cmd);
      const p = cmd.at(-1)!.replace(/[?&]per_page=100&page=\d+$/, "");
      const answer = ((): unknown => {
        if (p === M) return { iid: 7, web_url: "u", state: "opened", source_branch: "sb/1-x", target_branch: "main", sha: HEAD, diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE }, detailed_merge_status: over.status ?? "mergeable", head_pipeline: over.pipeline === undefined ? { sha: HEAD, status: "success" } : over.pipeline };
        if (p === `${M}/diffs`) return over.diffs ?? (over.files ?? ["src/a.ts"]).map((f) => ({ old_path: f, new_path: f, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }));
        if (p === `${M}/commits`) return [{ authored_date: "2026-10-28T01:00:00Z" }];
        if (p === `${M}/notes?sort=asc&order_by=created_at`) return [...notes.map((n, k) => ({ id: k, body: n.body, created_at: n.created_at, system: false, author: { id: n.author } })), { id: 99, body: "added 1 commit", created_at: "2026-10-28T03:00:00Z", system: true, author: null }];
        if (p.startsWith("projects/group%2Fapp/members/all/")) return { access_level: p.endsWith("/1") ? 30 : 20 };
        if (p === `${M}/discussions`) return [{ id: "a".repeat(40), notes: [{ id: 1, body: "x", resolvable: true, resolved: over.resolved ?? true, system: false }] }];
        if (p === "projects/group%2Fapp/repository/branches/main") return { commit: { id: BASE } };
        if (p === `${M}/merge`) {
          if (over.merge) throw new Error(`glab: error (HTTP ${over.merge})`);
          return { state: "merged" };
        }
        throw new Error(`fake GitLab: ${p}`);
      })();
      return JSON.stringify(answer);
    };
    return { sh, calls };
  }

  test("an MR whose head pipeline passed, reviewed after its last commit, with every discussion resolved, merges", async () => {
    const f = await readGitlabPr(7, gitlab().sh, lab);
    expect(f).toMatchObject({ files: [{ path: "src/a.ts", additions: 2, deletions: 1 }], headCommittedAt: "2026-10-28T01:00:00Z", checks: [{ name: "GitLab pipeline", conclusion: "SUCCESS" }], unresolvedThreads: 0, mergeState: "CLEAN", head: HEAD, base: "main" });
    expect(judge(f, { allowLarge: false })).toMatchObject({ verdict: "merge", impact: "small" });
  });

  test("an old pipeline, a failed one, an open discussion, a review by someone below Developer, or a status not mergeable stop it", async () => {
    const stop = async (over: Parameters<typeof gitlab>[0], reason: string) => {
      const j = judge(await readGitlabPr(7, gitlab(over).sh, lab), { allowLarge: false });
      expect({ verdict: j.verdict, reasons: j.reasons.filter((r) => r.includes(reason)).length }).toEqual({ verdict: "stop", reasons: 1 });
    };
    await stop({ pipeline: { sha: "3".repeat(40), status: "success" } }, "CI のチェックが 1 つも無い");
    await stop({ pipeline: { sha: HEAD, status: "failed" } }, "GitLab pipeline が FAILED");
    await stop({ pipeline: { sha: HEAD, status: "running" } }, "GitLab pipeline が 未完了");
    await stop({ resolved: false }, "解決していないレビュースレッドが 1 件");
    await stop({ notes: [{ body: "[codex] review\n\nok", created_at: "2026-10-28T02:00:00Z", author: 2 }] }, "主レビュー");
    await stop({ notes: [{ body: "[codex] review\n\nok", created_at: "2026-10-28T00:00:00Z", author: 1 }] }, "主レビュー");
    await stop({ status: "conflict" }, "CLEAN でない: conflict");
    await stop({ status: "not_approved" }, "CLEAN でない: not_approved");
    // README.md counts as touched on GitLab (its Design rules section is not read there)
    await stop({ files: ["README.md"] }, "[再チェック design-rules] 責務");
    await expect(readGitlabPr(7, gitlab({ status: "checking" }).sh, lab)).rejects.toThrow("計算中");
    // a security file renamed away is asked as on GitHub (the old path counts)
    await stop({ diffs: [{ old_path: "src/auth.ts", new_path: "src/login.ts", diff: "" }] }, "[聞く] セキュリティ（security:words）: src/auth.ts");
    // a patch GitLab left out is no size: not judged
    await expect(readGitlabPr(7, gitlab({ diffs: [{ old_path: "big.ts", new_path: "big.ts", diff: "", too_large: true }] }).sh, lab)).rejects.toThrow("差分を GitLab が省いた（big.ts）");
  });

  test("without a pipeline of the head, the local pass of the head and the target's tip now is the CI; one of an older base is not", async () => {
    const review = { body: "[codex] review\n\nok", created_at: "2026-10-28T02:00:00Z", author: 1 };
    const pass = (base: string, author = 1) => ({ body: `[local-ci] pass ${HEAD} base=${base}`, created_at: "2026-10-28T02:30:00Z", author });
    const ok = await readGitlabPr(7, gitlab({ pipeline: null, status: "ci_must_pass", notes: [review, pass(BASE)] }).sh, lab);
    expect(ok).toMatchObject({ checks: [{ name: expect.stringContaining("local-ci"), conclusion: "SUCCESS" }], localCi: true, mergeState: "UNSTABLE" });
    expect(judge(ok, { allowLarge: false }).verdict).toBe("merge");
    const old = await readGitlabPr(7, gitlab({ pipeline: null, status: "ci_must_pass", notes: [review, pass("4".repeat(40))] }).sh, lab);
    expect(judge(old, { allowLarge: false }).reasons).toEqual(expect.arrayContaining(["CI のチェックが 1 つも無い", "mergeStateStatus が CLEAN でない: ci_must_pass"]));
    expect(old.localCiNote).toContain("base が進んだ");
    // a pass a Reporter wrote is no mark
    const theirs = await readGitlabPr(7, gitlab({ pipeline: null, status: "ci_must_pass", notes: [review, pass(BASE, 2)] }).sh, lab);
    expect(theirs.checks).toEqual([]);
  });

  test("the command judges the checkout's GitLab MR and merges it at the judged head only; --merge-stack is refused", async () => {
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "merge-gate-lab-"));
    try {
      Bun.spawnSync(["git", "init", "-q", dir]);
      Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://gitlab.example.com/group/app.git"]);
      require("node:fs").writeFileSync(`${dir}/ops.config.json`, JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "group/app" } }));
      const noGh = async (a: string[]) => {
        throw new Error(`gh is not asked: ${a.join(" ")}`);
      };
      const quiet = () => undefined;
      const g = gitlab();
      expect(await main(["7", "--merge"], noGh, quiet, quiet, () => undefined, g.sh, dir)).toBe(0);
      const merged = g.calls.find((c) => c.at(-1) === `${M}/merge`)!;
      expect(merged.slice(4)).toEqual(["-X", "PUT", "-f", `sha=${HEAD}`, "-f", "should_remove_source_branch=true", `${M}/merge`]);
      // the head moved after the judgement: GitLab refuses (409) and nothing is merged
      expect(await main(["7", "--merge"], noGh, quiet, quiet, () => undefined, gitlab({ merge: 409 }).sh, dir)).toBe(1);
      expect(await main(["7", "--merge"], noGh, quiet, quiet, () => undefined, gitlab({ resolved: false }).sh, dir)).toBe(1);
      expect(await main(["7", "--merge-stack"], noGh, quiet, quiet, () => undefined, g.sh, dir)).toBe(2);
      expect(await main(["7"], noGh, quiet, quiet, () => undefined, gitlab({ status: "checking" }).sh, dir)).toBe(2);
    } finally {
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    }
  });
});
