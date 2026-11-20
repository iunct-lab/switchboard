// test-reads: scripts/merge-gate.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ASK_KINDS, checksFromRuns, configScopeOf, designRulesTouched, judge, sharedMoved, loadReversibility, localCiOf, main, mergePr, commentOnlyChange, fileSecurityKinds, plainDiffHeader, MERGE_ANSWER, MERGE_DIRECT, MERGE_ASK, PROTECTED, RECHECK_KINDS, REVERSIBILITY_PATH, SECURITY_KINDS, readGitlabPr, readPr, RECHECK_PASS, type PrFacts, type RecheckKind } from "./merge-gate";
import { markedLinesTouched } from "./merge-gate-rules";
import { resultComment } from "./local-ci";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The default repository (no --repo) is GH_REPO, else the origin (scripts/repo.ts): fixed here, so a leak of it shows.
const REPO = "example/development";
const savedRepo = process.env.GH_REPO;
beforeAll(() => { process.env.GH_REPO = REPO; });
afterAll(() => { if (savedRepo === undefined) delete process.env.GH_REPO; else process.env.GH_REPO = savedRepo; });

const base = (over: Partial<PrFacts> = {}): PrFacts => ({
  files: [{ path: "packages/core/src/tasks/manager.ts", additions: 20, deletions: 5 }],
  headCommittedAt: "2026-09-24T10:00:00Z",
  checks: [{ name: "test", conclusion: "SUCCESS" }],
  unresolvedThreads: 0,
  mergeState: "CLEAN",
  reviewComments: [{ body: "[codex] review\n\n### Intent and design", createdAt: "2026-09-24T11:00:00Z" }],
  ...over,
});
const off = { allowLarge: false };
/** The security groups the owner moved from asking to a recheck (docs/design/merge-gate.md). */
const MOVED: string[] = ["security:docs", "security:tests", "security:lockfile"];
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

  test("skill markdown counts and is an instruction file", () => {
    const j = judge(base({ files: [{ path: ".claude/skills/pbi-complete/SKILL.md", additions: 1, deletions: 0 }] }), off);
    expect(j.impact).toBe("large");
    expect(j.reasons).toEqual(["[聞く] 指示のファイル: .claude/skills/pbi-complete/SKILL.md"]);
    const big = judge(base({ files: [{ path: ".claude/skills/pbi-complete/SKILL.md", additions: 301, deletions: 0 }] }), off);
    expect(big.reasons[0]).toBe("[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている");
    // the shared skills in the kit are skills too
    const kit = judge(base({ files: [{ path: "ops-kit/skills/pbi-complete/SKILL.md", additions: 301, deletions: 0 }] }), off);
    expect(kit.impact).toBe("large");
    expect(kit.reasons).toEqual(["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている", "[聞く] 指示のファイル: ops-kit/skills/pbi-complete/SKILL.md"]);
  });

  test.each([
    ["rescue/src/server.ts", "[再チェック rescue] rescue"],
    [".github/workflows/ci.yml", "[聞く] セキュリティ（security:github）"],
    ["packages/core/src/db.ts", "[再チェック migration] 保護するパスに触れている"],
    ["packages/core/src/db/migrations/0001-task-columns.ts", "[再チェック migration] 保護するパスに触れている"],
    ["packages/core/src/schema-baseline.json", "[再チェック migration] 保護するパスに触れている"],
    ["packages/core/src/auth.ts", "[聞く] セキュリティ（security:words）"],
    ["packages/core/src/approval.ts", "[聞く] セキュリティ（security:words）"],
    ["packages/core/src/selfdev.ts", "[再チェック size] 保護するパスに触れている"],
    ["packages/core/config/pricing.json", "[再チェック size] 保護するパスに触れている"],
    ["scripts/setup/lint_backlog.sh", "[再チェック size] 保護するパスに触れている"],
    [".claude/skills/x/SKILL.md", "[聞く] 指示のファイル"],
    ["ops-kit/skills/x/SKILL.md", "[聞く] 指示のファイル"],
    ["package.json", "[再チェック size] 保護するパスに触れている"],
    ["bun.lock", "[再チェック security:lockfile] セキュリティ（security:lockfile）"],
  ])("one line in %s is large: %s", (path, why) => {
    const j = judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);
    expect(j.impact).toBe("large");
    expect(j.reasons).toEqual([`${why}: ${path}`]);
  });

  test("every PROTECTED pattern is covered above", () => {
    expect(PROTECTED.length).toBe(14);
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
      { path: "ops.config.json", additions: 1, deletions: 0 },
    ];
    expect(judge(base({ files }), off).reasons).toEqual(["[聞く] セキュリティ（security:words）: src/auth/session.ts", "[再チェック responsibility] 責務: ops.config.json"]);
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
    const files = [{ path: "src/auth/session.ts", additions: 1, deletions: 0 }, { path: "ops.config.json", additions: 1, deletions: 0 }];
    const large = ["[聞く] セキュリティ（security:words）: src/auth/session.ts", "[再チェック responsibility] 責務: ops.config.json"];
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
    // the mark is read in the form the check in front of a Task's post compares (the kit's markText): a yes the store
    // trimmed, or one with a full-width bracket, is the same yes — and so is the one the check stops
    for (const spelled of [`  [merge-answer] yes security:words,responsibility ${HEAD}`, `［merge-answer］\u3000YES security:words,responsibility ${HEAD}`, `\uFEFF[merge-answer] yes security:words,responsibility ${HEAD}\nrest`]) {
      const f = base({ files, head: HEAD, reviewComments: [...base().reviewComments, { body: spelled, createdAt: "2026-09-24T12:00:00Z" }] });
      expect([spelled, judge(f, allow).verdict]).toEqual([spelled, "merge"]);
    }
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

describe("direct PR (branch sb/direct-)", () => {
  const noReview = { reviewComments: [] };
  test("a direct PR with no large reason merges without a main review and says so", () => {
    expect(judge(base({ direct: true, ...noReview }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [], reviewSkipped: true });
  });

  test("a direct PR still needs CI, resolved threads and CLEAN", () => {
    const j = judge(base({ direct: true, ...noReview, checks: [], unresolvedThreads: 1, mergeState: "BEHIND" }), off);
    expect(j.verdict).toBe("stop");
    expect(j.reasons).toHaveLength(3);
    expect(j.reasons.join("\n")).not.toContain("主レビュー");
  });

  test("a direct PR touching a gate file is large and asks", () => {
    const j = judge(base({ direct: true, ...noReview, files: [{ path: "scripts/merge-gate.ts", additions: 1, deletions: 0 }] }), off);
    expect(j.verdict).toBe("stop");
    expect(j.reviewSkipped).toBeUndefined();
    expect(j.reasons.some((r) => r.includes("security:gates"))).toBe(true);
    expect(j.reasons.some((r) => r.includes("主レビュー"))).toBe(true);
  });

  test("a PR that is not direct stops without a main review", () => {
    const j = judge(base(noReview), off);
    expect(j.verdict).toBe("stop");
    expect(j.reviewSkipped).toBeUndefined();
    expect(j.reasons.some((r) => r.includes("主レビュー"))).toBe(true);
  });

  test("mergePr gives the gh that merges OPS_MERGE_GATE_PR=<n>, in both modes, and no other call", async () => {
    const HEAD40 = "c".repeat(40);
    const facts = base({ head: HEAD40, base: "main" });
    for (const mode of ["merge", "merge-stack"] as const) {
      const calls: Array<[string[], Record<string, string> | undefined]> = [];
      await mergePr(7, REPO, mode, facts, async (a, env) => { calls.push([a, env]); return a[0] === "repo" ? "main\n" : a[0] === "pr" && a[1] === "view" ? `${HEAD40}\n` : ""; }, () => REPO);
      const merging = calls.filter(([a]) => (a[0] === "pr" && a[1] === "merge") || a[0] === "stack");
      expect(merging.map(([, env]) => env)).toEqual([{ OPS_MERGE_GATE_PR: "7" }]);
      expect(calls.filter(([a]) => !merging.some(([m]) => m === a)).every(([, env]) => env === undefined)).toBe(true);
    }
  });

  test("mergePr puts [merge-direct] <head> on the PR before it merges, in both modes", async () => {
    const HEAD40 = "c".repeat(40);
    const facts = base({ head: HEAD40, base: "main", direct: true });
    for (const mode of ["merge", "merge-stack"] as const) {
      const calls: string[][] = [];
      await mergePr(7, REPO, mode, facts, async (a) => { calls.push(a); return a[0] === "repo" ? "main\n" : a[0] === "pr" && a[1] === "view" ? `${HEAD40}\n` : ""; }, () => REPO, true);
      const at = calls.findIndex((a) => a[0] === "pr" && a[1] === "comment");
      const merge = calls.findIndex((a) => (a[0] === "pr" && a[1] === "merge") || a[0] === "stack");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(calls[at]).toEqual(["pr", "comment", "7", "-R", REPO, "--body", `[merge-direct] ${HEAD40}`]);
      expect(MERGE_DIRECT.exec(calls[at]![6]!)?.[1]).toBe(HEAD40);
      expect(at).toBeLessThan(merge);
    }
    const none: string[][] = [];
    await mergePr(7, REPO, "merge", facts, async (a) => { none.push(a); return ""; });
    expect(none.some((a) => a[1] === "comment")).toBe(false);
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
    // the gate and the stand-in for CI decide merges themselves
    ["scripts/merge-gate.ts", "gates"],
    ["scripts/local-ci.ts", "gates"],
  ])("one line in %s stops as セキュリティ（security:%s）", (path, group) => {
    const kind = `security:${group}`;
    const moved = MOVED.includes(kind);
    const j = judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", ask: moved ? [] : [kind], recheck: moved ? [kind] : [] });
    expect(j.reasons).toEqual([`${moved ? `[再チェック ${kind}]` : "[聞く]"} セキュリティ（${kind}）: ${path}`]);
  });

  test("a security reason for aws/host/** points at the review of main's protection; other security reasons do not change", () => {
    const host = judge(base({ files: [{ path: "aws/host/sb-env.sh", additions: 1, deletions: 0 }] }), off);
    expect(host).toMatchObject({ verdict: "stop", impact: "large", ask: ["security:host"] });
    expect(host.reasons).toEqual([expect.stringMatching(/^\[聞く\] セキュリティ（security:host）: aws\/host\/sb-env\.sh（aws\/host は.*root が main から.*main の保護の見直しの契機.*docs\/design\/cloud-hosting\.md §6\.5）$/)]);
    const ci = judge(base({ files: [{ path: ".github/workflows/ci.yml", additions: 1, deletions: 0 }] }), off);
    expect(ci.reasons).toEqual(["[聞く] セキュリティ（security:github）: .github/workflows/ci.yml"]);
  });

  test.each(["src/tokenizer.ts", "apps/web/package.json", "src/authorize.ts", "docs/guide/sandboxing.md"])("%s alone does not stop", (path) => {
    expect(judge(base({ files: [{ path, additions: 1, deletions: 0 }] }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
  });

  test("the paths of a group go in one reason, in the PR's order; the groups in SECURITY_KINDS' order", () => {
    const files = ["src/a.ts", "go.sum", "src/token.ts", "src/secret.ts"].map((path) => ({ path, additions: 1, deletions: 0 }));
    expect(judge(base({ files }), off)).toMatchObject({
      reasons: ["[聞く] セキュリティ（security:words）: src/token.ts, src/secret.ts", "[再チェック security:lockfile] セキュリティ（security:lockfile）: go.sum"],
      ask: ["security:words"],
      recheck: ["security:lockfile"],
    });
  });
});

describe("security sub-kinds", () => {
  const one = (path: string) => judge(base({ files: [{ path, additions: 1, deletions: 0, status: "modified" }] }), off);
  const groups = (j: ReturnType<typeof judge>) => [...j.ask, ...j.recheck];

  test.each([
    ["docs/design/secret-guard.md", "security:docs"],
    ["bun.lock", "security:lockfile"],
  ] as const)("%s → %s: the reason names the group, recheck has it (moved by the owner)", (path, kind) => {
    const j = one(path);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", ask: [], recheck: [kind] });
    expect(j.reasons).toEqual([`[再チェック ${kind}] セキュリティ（${kind}）: ${path}`]);
  });

  test.each([
    ["src/auth/x.ts", "security:words"],
    [".env.local", "security:words"],
    [".github/workflows/ci.yml", "security:github"],
    ["scripts/local-ci.ts", "security:gates"],
    ["scripts/forge-resync.ts", "security:gates"],
    ["ops-kit/reversibility.json", "security:gates"],
    ["scripts/merge-gate-limits.ts", "security:gates"],
    ["scripts/merge-gate-rules.ts", "security:gates"],
    ["aws/host/sb-host-update.sh", "security:host"],
  ] as const)("%s → %s: the reason names the group, ask has it, still asked", (path, kind) => {
    const j = one(path);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", ask: [kind], recheck: [] });
    expect(j.reasons).toHaveLength(1);
    expect(j.reasons[0]).toStartWith(`[聞く] セキュリティ（${kind}）: ${path}`);
  });

  test("security:tests: a word or a host path met only by tests, fixtures or comment-only host files is rechecked; anything else is asked as before", () => {
    const of = (...files: { path: string; commentOnly?: boolean }[]) => judge(base({ files: files.map((x) => ({ additions: 1, deletions: 0, status: "modified" as const, ...x })) }), off);
    const tests = of({ path: "packages/core/src/approval.test.ts" }, { path: "packages/core/src/auth.test.ts" });
    expect(tests).toMatchObject({ verdict: "stop", impact: "large", ask: [], recheck: ["security:tests"] });
    expect(tests.reasons).toEqual(["[再チェック security:tests] セキュリティ（security:tests）: packages/core/src/approval.test.ts, packages/core/src/auth.test.ts"]);
    // the mark of the head lifts it
    expect(judge(base({ files: [{ path: "packages/core/src/auth.test.ts", additions: 1, deletions: 0, status: "modified" }], rechecks: ["security:tests"] }), off)).toMatchObject({ verdict: "merge", reasons: [] });
    // one path that is not a test keeps its own ask; the tests stay a recheck
    const mixed = of({ path: "packages/core/src/approval.test.ts" }, { path: "packages/core/src/approval.ts" });
    expect(mixed).toMatchObject({ ask: ["security:words"], recheck: ["security:tests"] });
    expect(mixed.reasons).toContain("[聞く] セキュリティ（security:words）: packages/core/src/approval.ts");
    expect(of({ path: "aws/host/host.test.ts" })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    expect(of({ path: "packages/adapters/claude/fixtures/permission-denied.jsonl" })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    expect(of({ path: "scripts/auth-e2e.ts" })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    // a host file: only with a diff read as comments only, and only where # is a comment
    expect(of({ path: "aws/host/offload.sh", commentOnly: true })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    expect(of({ path: "aws/host/offload.sh" })).toMatchObject({ ask: ["security:host"], recheck: [] });
    expect(of({ path: "aws/host/cloudwatch-agent.json", commentOnly: true })).toMatchObject({ ask: ["security:host"], recheck: [] });
    // comment-only is the host's alone: a word path that is not a test is asked whatever its diff
    expect(of({ path: "packages/core/src/auth.ts", commentOnly: true })).toMatchObject({ ask: ["security:words"], recheck: [] });
    // CI settings, the gates and secrets files keep their groups even as tests or fixtures
    expect(of({ path: ".github/scripts/auth.test.ts" })).toMatchObject({ ask: ["security:words", "security:github"], recheck: [] });
    expect(of({ path: "packages/core/fixtures/.env.sample" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    // a test with no word and no host path is no security reason at all
    expect(of({ path: "packages/core/src/tasks.test.ts" })).toMatchObject({ verdict: "merge", impact: "small" });
  });

  // A host script like aws/host/bootstrap.sh: a sudoers file written by a here-document, and a command continued by `\`.
  const SCRIPT = [
    "#!/usr/bin/env bash",
    "# installs the host",
    "set -euo pipefail",
    "",
    "curl -fsSL \"$URL\" \\",
    "  --output /tmp/x \\",
    "  --checksum \"$SUM\"",
    "cat > /etc/sudoers.d/switchboard <<SUDO",
    "$HOST_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart switchboard",
    "SUDO",
    "chmod 440 /etc/sudoers.d/switchboard",
    "",
  ];
  /** The script with `add` put in before line `at` (0-based), as the two whole files. */
  const put = (at: number, ...add: string[]) => [SCRIPT.join("\n"), [...SCRIPT.slice(0, at), ...add, ...SCRIPT.slice(at)].join("\n")] as const;
  const sh = (base: string, head: string) => commentOnlyChange("aws/host/bootstrap.sh", base, head);

  test("commentOnlyChange: a comment or a blank line where it does nothing, added, removed or reworded, is comment-only", () => {
    expect(sh(...put(3, "# why the checksum is read", "   ", "\t# indented"))).toBe(true);
    expect(sh(...put(11, "# after the here-document"))).toBe(true);
    const [base, head] = put(3, "# gone");
    expect(sh(head, base)).toBe(true); // removed
    expect(sh(SCRIPT.join("\n"), SCRIPT.join("\n").replace("# installs the host", "# sets the host up"))).toBe(true);
    // a comment with a quote or a here-document mark in it opens nothing
    expect(sh(...put(3, "# don't read <<EOF here \\"))).toBe(true);
    // systemd units and YAML
    expect(commentOnlyChange("aws/host/x.service", "[Unit]\nDescription=x\n", "[Unit]\n# why\nDescription=x\n")).toBe(true);
    expect(commentOnlyChange("aws/host/litestream.yml", "dbs:\n  - path: /a\n    replicas:\n      - url: s3://b\n", "dbs:\n  - path: /a\n    # where\n    replicas:\n      - url: s3://b\n")).toBe(true);
  });

  test("commentOnlyChange: a # line inside a here-document is content (#includedir in a sudoers file the script writes)", () => {
    expect(sh(...put(8, "#includedir /home/host/x"))).toBe(false);
    expect(sh(...put(9, "#includedir /home/host/x"))).toBe(false);
    expect(sh(...put(7, "#includedir /home/host/x"))).toBe(true); // the same line above the here-document is a comment
    expect(sh(...put(9, ""))).toBe(false); // a blank line there is in the file written
    // the tab-stripping and the quoted forms, and one that never ends
    for (const open of ["cat <<-EOF", "cat <<'EOF'", "cat << \"EOF\" > /etc/x", "cat <<\\EOF"]) {
      const body = [open, "a", "EOF", "true"];
      expect(sh(["#!/bin/sh", ...body].join("\n"), ["#!/bin/sh", open, "#include x", "a", "EOF", "true"].join("\n"))).toBe(false);
      expect(sh(["#!/bin/sh", ...body].join("\n"), ["#!/bin/sh", ...body, "# after"].join("\n"))).toBe(true);
    }
    expect(sh("#!/bin/sh\ncat <<EOF\na\n", "#!/bin/sh\n# c\ncat <<EOF\na\n")).toBe(false);
  });

  test("commentOnlyChange: in a here-document with an unquoted word, a line ending in a backslash joins the next one, so the end word after it is not the end", () => {
    const file = (open: string, joined: string, hash: string) => ["#!/bin/sh", open, joined, "EOF", hash, "EOF", "true", ""].join("\n");
    // the shell reads `a EOF`, then the # line, then the end: the # line is in the file written
    expect(sh(file("cat <<EOF", "a \\", "#includedir x"), file("cat <<EOF", "a \\", "#includedir y"))).toBe(false);
    expect(sh(file("cat <<-EOF", "a \\", "#includedir x"), file("cat <<-EOF", "a \\", "#includedir y"))).toBe(false);
    // a quoted word takes the backslash as it is, and two backslashes are one backslash, not a continuation: the first EOF ends it
    for (const [open, joined] of [["cat <<'EOF'", "a \\"], ["cat <<\\EOF", "a \\"], ["cat <<EOF", "a \\\\"]] as const) expect(sh(file(open, joined, "# x"), file(open, joined, "# y"))).toBe(true);
  });

  test("commentOnlyChange: a # line or a blank line between lines joined by a trailing backslash cuts the command", () => {
    expect(sh(...put(5, "# note"))).toBe(false);
    expect(sh(...put(6, "# note"))).toBe(false);
    expect(sh(...put(6, ""))).toBe(false);
    expect(sh(...put(4, "# before the command"))).toBe(true);
    expect(sh(...put(7, "# after its last line"))).toBe(true);
    expect(commentOnlyChange("aws/host/x.service", "[Service]\nExecStart=/bin/a \\\n  b\n", "[Service]\nExecStart=/bin/a \\\n# c\n  b\n")).toBe(false);
  });

  test("commentOnlyChange: inside a quoted string or a YAML block scalar, on the first line, or in a file the scanner cannot follow, nothing is a comment", () => {
    const quoted = (...mid: string[]) => ["#!/bin/sh", "python3 -c \"", ...mid, "print(1)", "\"", "jq '", ...mid, ".a'", ""].join("\n");
    expect(sh(quoted(), quoted("# in the string"))).toBe(false);
    expect(sh("#!/bin/sh\nx=\"$(echo \"a\"\n)\"\n", "#!/bin/sh\nx=\"$(echo \"a\"\n# c\n)\"\n")).toBe(false);
    // the interpreter line: a comment put above it, or the line itself reworded
    expect(sh("#!/bin/sh\ntrue\n", "# first\n#!/bin/sh\ntrue\n")).toBe(false);
    expect(sh("#!/bin/sh\ntrue\n", "#!/usr/bin/env python3\ntrue\n")).toBe(false);
    // a code line, a trailing comment, a comment turned into code
    expect(sh("#!/bin/sh\ntrue\n", "#!/bin/sh\ntrue\nrm -rf /var/x\n")).toBe(false);
    expect(sh("#!/bin/sh\ntrue # a\n", "#!/bin/sh\ntrue # b\n")).toBe(false);
    expect(sh("#!/bin/sh\n# rm -rf /var/x\n", "#!/bin/sh\nrm -rf /var/x\n")).toBe(false);
    // a no-break space is no blank to the shell: the line is a command
    expect(sh("#!/bin/sh\ntrue\n", "#!/bin/sh\n # x\ntrue\n")).toBe(false);
    // not followed with certainty: backticks, an open string at the end, a here-document inside a string, CRLF
    for (const odd of ["x=`date`", "echo \"open", "x=\"$(cat <<EOF\na\nEOF\n)\"", "true\r", "y=$((1 +\n2))", "echo a;# b"]) {
      expect(sh(`#!/bin/sh\n${odd}\ntrue\n`, `#!/bin/sh\n${odd}\n# c\ntrue\n`)).toBe(false);
    }
    // YAML: a block scalar's lines, and a scalar continued over lines
    const yml = (...mid: string[]) => ["write_files:", "  - content: |", "      Defaults x", ...mid, "      root ALL", "    path: /etc/sudoers.d/x", ""].join("\n");
    expect(commentOnlyChange("aws/host/x.yml", yml(), yml("      #includedir /home/host/x"))).toBe(false);
    expect(commentOnlyChange("aws/host/x.yml", yml(), yml("#includedir /home/host/x"))).toBe(false);
    expect(commentOnlyChange("aws/host/x.yml", yml(), yml() + "# after\n")).toBe(true);
    expect(commentOnlyChange("aws/host/x.yml", "a: one\n  two\n", "a: one\n# c\n  two\n")).toBe(false);
    // no file on a side, no difference, or a kind of file where # is no comment
    expect(sh(undefined as unknown as string, "#!/bin/sh\n")).toBe(false);
    expect(commentOnlyChange("aws/host/x.sh", "#!/bin/sh\n", undefined)).toBe(false);
    expect(sh("#!/bin/sh\n", "#!/bin/sh\n")).toBe(false);
    expect(commentOnlyChange("aws/host/x.json", "{}\n", "{}\n# c\n")).toBe(false);
  });

  test("plainDiffHeader: a mode change, a rename, a new or removed file, a symlink or no section of the file is not a plain content change", () => {
    const git = (...head: string[]) => ["diff --git a/aws/host/x.sh b/aws/host/x.sh", ...head, "@@ -1 +1 @@", "-# a", "+# b", ""].join("\n");
    const names = ["--- a/aws/host/x.sh", "+++ b/aws/host/x.sh"];
    expect(plainDiffHeader(git("index 1111111..2222222 100644", ...names), "aws/host/x.sh")).toBe(true);
    expect(plainDiffHeader(`diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n${git("index 1111111..2222222 100755", ...names)}`, "aws/host/x.sh")).toBe(true);
    expect(plainDiffHeader(git("old mode 100644", "new mode 100755", "index 1111111..2222222", ...names), "aws/host/x.sh")).toBe(false);
    expect(plainDiffHeader(git("index 1111111..2222222 120000", ...names), "aws/host/x.sh")).toBe(false);
    expect(plainDiffHeader(git("new file mode 100644", "index 0000000..2222222", "--- /dev/null", names[1]!), "aws/host/x.sh")).toBe(false);
    expect(plainDiffHeader("diff --git a/aws/host/w.sh b/aws/host/x.sh\nsimilarity index 90%\nrename from aws/host/w.sh\nrename to aws/host/x.sh\nindex 1..2 100644\n--- a/aws/host/w.sh\n+++ b/aws/host/x.sh\n@@ -1 +1 @@\n-# a\n+# b\n", "aws/host/x.sh")).toBe(false);
    expect(plainDiffHeader(git("index 1111111..2222222 100644", ...names), "aws/host/y.sh")).toBe(false);
    expect(plainDiffHeader("", "aws/host/x.sh")).toBe(false);
  });

  test("a file is judged by its path before a rename too: product code moved into a test or fixture path is still asked", () => {
    const of = (x: Partial<PrFacts["files"][number]> & { path: string }) => judge(base({ files: [{ additions: 1, deletions: 0, ...x }] }), off);
    const moved = of({ path: "aws/fixtures/auth.ts", status: "renamed", previous: "aws/auth.ts" });
    expect(moved).toMatchObject({ ask: ["security:words"], recheck: [] });
    expect(moved.reasons).toEqual(["[聞く] セキュリティ（security:words）: aws/fixtures/auth.ts（改名前: aws/auth.ts）"]);
    expect(of({ path: "packages/core/src/approval.test.ts", status: "renamed", previous: "packages/core/src/approval.ts" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    expect(of({ path: "aws/host/fixtures/sb-env.sh", status: "copied", previous: "aws/host/sb-env.sh" })).toMatchObject({ ask: ["security:host"], recheck: [] });
    // moved out of a guarded path to one no word meets: the old path is named
    const away = of({ path: "packages/core/src/login.test.ts", status: "renamed", previous: "packages/core/src/auth.ts" });
    expect(away.reasons).toEqual(["[聞く] セキュリティ（security:words）: packages/core/src/login.test.ts（改名前: packages/core/src/auth.ts）"]);
    expect(of({ path: "docs/design/auth.md", status: "renamed", previous: "packages/core/src/auth.ts" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    // a test renamed to a test is still a test, on either path
    expect(of({ path: "packages/core/src/login.test.ts", status: "renamed", previous: "packages/core/src/auth.test.ts" })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    expect(of({ path: "packages/core/src/auth.test.ts", status: "added" })).toMatchObject({ ask: [], recheck: ["security:tests"] });
    expect(fileSecurityKinds({ path: "a/fixtures/token.json", additions: 0, deletions: 1, status: "removed" })).toEqual(["security:tests"]);
  });

  test("how the file changed is not known (no status, a type change, a rename with no old path): a test, a fixture or a document is asked", () => {
    const of = (x: Partial<PrFacts["files"][number]> & { path: string }) => judge(base({ files: [{ additions: 1, deletions: 0, ...x }] }), off);
    expect(of({ path: "packages/core/src/auth.test.ts" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    expect(of({ path: "packages/core/src/auth.test.ts", status: "changed" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    expect(of({ path: "aws/fixtures/auth.ts", status: "renamed" })).toMatchObject({ ask: ["security:words"], recheck: [] });
    expect(of({ path: "aws/host/README.md" })).toMatchObject({ ask: ["security:host"], recheck: [] });
    // comment-only is a modified file's alone
    expect(of({ path: "aws/host/offload.sh", commentOnly: true })).toMatchObject({ ask: ["security:host"], recheck: [] });
    expect(of({ path: "aws/host/offload.sh", commentOnly: true, status: "added" })).toMatchObject({ ask: ["security:host"], recheck: [] });
    expect(of({ path: "aws/host/offload.sh", commentOnly: true, status: "renamed", previous: "aws/host/off.sh" })).toMatchObject({ ask: ["security:host"], recheck: [] });
    // a path no group meets stays no reason
    expect(of({ path: "packages/core/src/tasks.test.ts" })).toMatchObject({ verdict: "merge", impact: "small" });
  });

  test("a rescue test a path word meets keeps the rescue recheck beside security:tests", () => {
    const j = judge(base({ files: [{ path: "rescue/src/auth.test.ts", additions: 1, deletions: 0, status: "modified" }] }), off);
    expect(j).toMatchObject({ ask: [], recheck: ["security:tests", "rescue"] });
    expect(judge(base({ files: [{ path: "rescue/src/auth.ts", additions: 1, deletions: 0, status: "modified" }] }), off)).toMatchObject({ ask: ["security:words"], recheck: [] });
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
    expect(one("aws/host/README.md")).toMatchObject({ reasons: ["[再チェック security:docs] セキュリティ（security:docs）: aws/host/README.md"], ask: [], recheck: ["security:docs"] });
    expect(groups(one("docs/design/session-sandbox.md"))).toEqual(["security:docs"]);
    // skills, CLAUDE.md, AGENTS.md and the .github templates decide what a Task gets: their group, not docs
    expect(groups(one(".github/PULL_REQUEST_TEMPLATE.md"))).toEqual(["security:github"]);
    expect(groups(one(".github/workflows/README.md"))).toEqual(["security:github"]);
    // and an instruction file is asked as instructions too, whatever group its path is in
    expect(groups(one(".claude/skills/auth/SKILL.md"))).toEqual(["security:words", "instructions"]);
    expect(groups(one("ops-kit/skills/secret-x/SKILL.md"))).toEqual(["security:words", "instructions"]);
    expect(groups(one("aws/host/CLAUDE.md"))).toEqual(["security:host", "instructions"]);
    expect(groups(one("auth/AGENTS.md"))).toEqual(["security:words", "instructions"]);
  });

  test("--allow-large needs a yes naming every group left", () => {
    const files = [{ path: "bun.lock", additions: 1, deletions: 0 }, { path: "scripts/merge-gate.ts", additions: 1, deletions: 0 }];
    const allow = { allowLarge: true };
    expect(judge(yes("security:lockfile", { files }), allow).verdict).toBe("stop");
    expect(judge(yes("security", { files }), allow).verdict).toBe("stop");
    expect(judge(yes("security:lockfile,security:gates", { files }), allow)).toMatchObject({ verdict: "merge", ask: ["security:gates"], recheck: ["security:lockfile"] });
  });
});

describe("approved security sub-kind rechecks", () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, additions: 1, deletions: 0, status: "modified" as const }));
  const marked = (paths: string[], rechecks: RecheckKind[]) => judge(base({ files: files(...paths), rechecks }), off);

  test.each([
    ["docs/design/secret-guard.md", "security:docs"],
    ["bun.lock", "security:lockfile"],
  ] as const)("%s alone: [再チェック %s] stops, its mark of the head lifts it", (path, kind) => {
    expect(marked([path], [])).toEqual({ verdict: "stop", impact: "large", reasons: [`[再チェック ${kind}] セキュリティ（${kind}）: ${path}`], ask: [], recheck: [kind] });
    expect(marked([path], [kind])).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    // another kind's mark does not lift it
    expect(marked([path], ["size"]).verdict).toBe("stop");
  });

  test("a group not moved is still asked, and a mark of the same shape is not read", () => {
    expect(RECHECK_PASS.exec(`[recheck] security:lockfile pass ${HEAD}`)?.slice(1)).toEqual(["security:lockfile", HEAD]);
    expect(RECHECK_PASS.exec(`[recheck] security:docs pass ${HEAD}`)?.slice(1)).toEqual(["security:docs", HEAD]);
    for (const k of ["security:words", "security:github", "security:gates", "security:host"]) expect(RECHECK_PASS.exec(`[recheck] ${k} pass ${HEAD}`)).toBeNull();
    expect(marked(["src/auth.ts"], [])).toMatchObject({ verdict: "stop", reasons: ["[聞く] セキュリティ（security:words）: src/auth.ts"], ask: ["security:words"] });
  });

  test("a PR touching a moved group and an asked one: the marks lift the moved group, the other is still asked", () => {
    expect(marked(["bun.lock", "docs/design/secret-guard.md", "scripts/merge-gate.ts"], ["security:lockfile", "security:docs"])).toEqual({
      verdict: "stop",
      impact: "large",
      reasons: ["[聞く] セキュリティ（security:gates）: scripts/merge-gate.ts"],
      ask: ["security:gates"],
      recheck: [],
    });
  });
});

describe("instructions", () => {
  const file = (path: string, over: Partial<PrFacts["files"][number]> = {}) => ({ path, additions: 1, deletions: 0, ...over });

  test.each(["CLAUDE.md", "packages/core/CLAUDE.md", "AGENTS.md", ".claude/skills/a/SKILL.md", "ops-kit/skills/a/SKILL.md"])(
    "instructions: one line in %s is asked of the owner, whose yes of the head lifts it and no recheck does",
    (path) => {
      const j = judge(base({ files: [file(path)] }), off);
      expect(j).toEqual({ verdict: "stop", impact: "large", reasons: [`[聞く] 指示のファイル: ${path}`], ask: ["instructions"], recheck: [] });
      expect(judge(base({ files: [file(path)], rechecks: ["responsibility", "size"] }), off).verdict).toBe("stop");
      expect(judge(yes("instructions", { files: [file(path)] }), { allowLarge: true })).toMatchObject({ verdict: "merge", reasons: [] });
      expect(judge(yes("size", { files: [file(path)] }), { allowLarge: true }).verdict).toBe("stop");
      // instructions is no recheck kind: its mark is not read at all
      expect(RECHECK_PASS.exec(`[recheck] instructions pass ${"a".repeat(40)}`)).toBeNull();
    },
  );

  test("instructions mixed: an instruction file with a file that is no test is split, and no yes lifts it", () => {
    const allow = { allowLarge: true };
    for (const other of ["scripts/x.ts", "docs/design/x.md", "README.md"]) {
      const files = [file(".claude/skills/x/SKILL.md"), file(other)];
      const split = `[分ける] 指示のファイル（.claude/skills/x/SKILL.md）とほかのファイル（${other}）を同じ PR で変えている。指示のファイルだけの PR に分けて出し直す`;
      expect(judge(base({ files }), off).reasons).toContain(split);
      const lifted = judge(yes("instructions", { files }), allow);
      expect(lifted).toMatchObject({ verdict: "stop", reasons: [split] });
    }
    // a test beside the instruction file is no mix (the test's name is data; the file is not changed)
    const withTest = [file("ops-kit/skills/x/SKILL.md"), file("ops-kit/src/x.test.ts")];
    expect(judge(base({ files: withTest }), off).reasons).toEqual(["[聞く] 指示のファイル: ops-kit/skills/x/SKILL.md"]);
    expect(judge(yes("instructions,security:tests", { files: withTest }), allow).verdict).toBe("merge");
    // a rename out of an instruction path is the instruction file's change too
    const renamed = [file("docs/x.md", { status: "renamed", previous: "CLAUDE.md" }), file("scripts/y.ts")];
    expect(judge(base({ files: renamed }), off).reasons).toContainEqual(expect.stringContaining("[分ける] 指示のファイル（docs/x.md（改名前: CLAUDE.md））とほかのファイル（docs/x.md, scripts/y.ts）"));
  });

  test("rescue/CLAUDE.md is an instruction file too: asked, and split from the rescue code", () => {
    const alone = judge(base({ files: [file("rescue/CLAUDE.md")] }), off);
    expect(alone).toMatchObject({ verdict: "stop", ask: ["instructions"], recheck: ["rescue"] });
    expect(alone.reasons).toContain("[聞く] 指示のファイル: rescue/CLAUDE.md");
    const j = judge(base({ files: [file("rescue/CLAUDE.md"), file("rescue/src/x.ts")] }), off);
    expect(j.reasons.some((r) => r.startsWith("[分ける]"))).toBe(true);
  });

  test("a rename out of an instruction path is asked, and split as a local change shows it (a file removed and a file added)", () => {
    const j = judge(base({ files: [{ path: "docs/old-rules.md", additions: 0, deletions: 0, status: "renamed", previous: "CLAUDE.md" }] }), off);
    expect(j).toMatchObject({ verdict: "stop", ask: ["instructions"] });
    expect(j.reasons).toContain("[聞く] 指示のファイル: docs/old-rules.md（改名前: CLAUDE.md）");
    expect(j.reasons).toContain("[分ける] 指示のファイル（docs/old-rules.md（改名前: CLAUDE.md））とほかのファイル（docs/old-rules.md）を同じ PR で変えている。指示のファイルだけの PR に分けて出し直す");
    // a copy out of an instruction file changes no instruction file, as a local change sees it (a file added)
    const copy = judge(base({ files: [{ path: "docs/rules-copy.md", additions: 3, deletions: 0, status: "copied", previous: "CLAUDE.md" }] }), off);
    expect(copy.ask).toEqual([]);
    expect(copy.reasons.some((r) => r.includes("指示のファイル"))).toBe(false);
    // a rename into an instruction path removes an ordinary file: split, as a local change shows it
    const into = judge(base({ files: [{ path: "CLAUDE.md", additions: 0, deletions: 0, status: "renamed", previous: "src/notes.ts" }] }), off);
    expect(into.reasons).toContain("[分ける] 指示のファイル（CLAUDE.md）とほかのファイル（src/notes.ts（改名で消える））を同じ PR で変えている。指示のファイルだけの PR に分けて出し直す");
    // a rename between instruction paths is not a mix
    const inside = judge(base({ files: [{ path: ".claude/skills/b/SKILL.md", additions: 0, deletions: 0, status: "renamed", previous: ".claude/skills/a/SKILL.md" }] }), off);
    expect(inside.reasons.some((r) => r.startsWith("[分ける]"))).toBe(false);
  });
});

describe("responsibility", () => {
  test("one line in ops.config.json stops as 責務", () => {
    const j = judge(base({ files: [{ path: "ops.config.json", additions: 1, deletions: 0 }] }), off);
    expect(j).toMatchObject({ verdict: "stop", impact: "large" });
    expect(j.reasons).toEqual(["[再チェック responsibility] 責務: ops.config.json"]);
  });

  test("ops.config.json alone (where the CI steps live) is a responsibility recheck, not security:github", () => {
    const j = judge(base({ files: [{ path: "ops.config.json", additions: 3, deletions: 1 }] }), off);
    expect(j.ask).toEqual([]);
    expect(j.ask).not.toContain("security:github");
    expect(j.recheck).toEqual(["responsibility"]);
    expect(j.reasons).toEqual(["[再チェック responsibility] 責務: ops.config.json"]);
  });

  test("docs/design alone is not a responsibility file (the scope is the main review's)", () => {
    const design = { path: "docs/design/x.md", additions: 1, deletions: 0 };
    expect(judge(base({ files: [design] }), off)).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
    const j = judge(base({ files: [design, { path: "ops.config.json", additions: 1, deletions: 0 }] }), off);
    expect(j.recheck).toEqual(["responsibility"]);
    expect(j.reasons).toEqual(["[再チェック responsibility] 責務: ops.config.json"]);
  });

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

describe("user-marked lines", () => {
  const file = "# C\n- a\n- b（2026-11-03 の利用者の指摘）\n- c（2026-11-07 の利用者の決定）\n- d\n";
  test("a deleted or rewritten marked line is listed by its base line number", () => {
    expect(markedLinesTouched(file, "@@ -2,3 +2,2 @@\n - a\n-- b（2026-11-03 の利用者の指摘）\n - c（2026-11-07 の利用者の決定）\n")).toEqual([3]);
    expect(markedLinesTouched(file, "@@ -3,2 +3,2 @@\n-- b（2026-11-03 の利用者の指摘）\n+- b, reworded\n-- c（2026-11-07 の利用者の決定）\n+- c2\n")).toEqual([3, 4]);
  });

  test("an unmarked line changed, or a line only added, is not listed", () => {
    expect(markedLinesTouched(file, "@@ -2 +2 @@\n-- a\n+- a2\n")).toEqual([]);
    expect(markedLinesTouched(file, "@@ -3,0 +4 @@\n+- new（2026-11-09 の利用者の指示）\n")).toEqual([]);
    expect(markedLinesTouched(file, "@@ -3 +3,2 @@\n - b（2026-11-03 の利用者の指摘）\n+- more\n")).toEqual([]);
  });

  test("the reason of an instruction file's change names the lines; none, no note", () => {
    const files = [{ path: "CLAUDE.md", additions: 1, deletions: 1 }];
    const j = judge(base({ files, userRulesTouched: ["CLAUDE.md:3", "AGENTS.md:9"] }), off);
    expect(j.reasons).toEqual(["[聞く] 指示のファイル: CLAUDE.md（利用者の決まりの行を消す・変える: CLAUDE.md:3, AGENTS.md:9）"]);
    expect(judge(base({ files }), off).reasons).toEqual(["[聞く] 指示のファイル: CLAUDE.md"]);
    expect(judge(base({ files, userRulesTouched: [] }), off).reasons).toEqual(["[聞く] 指示のファイル: CLAUDE.md"]);
    // the responsibility reason carries no such note
    expect(judge(base({ files: [{ path: "ops.config.json", additions: 1, deletions: 0 }], userRulesTouched: ["CLAUDE.md:3"] }), off).reasons.filter((r) => r.includes("責務"))).toEqual(["[再チェック responsibility] 責務: ops.config.json"]);
  });

  test("the lines are never dropped: an instruction file that is security, in rescue, or renamed out still lists them on the instructions reason", () => {
    const note = "（利用者の決まりの行を消す・変える: ";
    // a skill under a security path word: the security reason, and the lines on instructions
    const sec = judge(base({ files: [{ path: ".claude/skills/auth/SKILL.md", additions: 1, deletions: 1 }], userRulesTouched: [".claude/skills/auth/SKILL.md:4"] }), off);
    expect(sec.reasons).toContain(`[聞く] 指示のファイル: .claude/skills/auth/SKILL.md${note}.claude/skills/auth/SKILL.md:4）`);
    expect(sec.ask).toEqual(["security:words", "instructions"]);
    // under rescue: the rescue recheck, and the lines on instructions
    const res = judge(base({ files: [{ path: "rescue/CLAUDE.md", additions: 1, deletions: 1 }], userRulesTouched: ["rescue/CLAUDE.md:2"] }), off);
    expect(res.reasons).toEqual(["[再チェック rescue] rescue: rescue/CLAUDE.md", "[聞く] 指示のファイル: rescue/CLAUDE.md" + note + "rescue/CLAUDE.md:2）"]);
    // renamed out of an instruction path (the PR's paths hold the new path only): the lines name the old one
    const moved = judge(base({ files: [{ path: "docs/rules.md", additions: 0, deletions: 0, status: "renamed", previous: "CLAUDE.md" }], userRulesTouched: ["CLAUDE.md:3"] }), off);
    expect(moved.reasons).toContain(`[聞く] 指示のファイル: docs/rules.md（改名前: CLAUDE.md）${note}CLAUDE.md:3）`);
    expect(moved.ask).toEqual(["instructions"]);
  });
});

describe("recheck", () => {
  const one = (path: string, additions = 1) => [{ path, additions, deletions: 0 }];
  const marked = (files: PrFacts["files"], rechecks: RecheckKind[], over: Partial<PrFacts> = {}) => judge(base({ files, rechecks, ...over }), off);

  test.each([
    ["security only", one("src/auth.ts"), ["[聞く] セキュリティ（security:words）: src/auth.ts"], ["security:words"], []],
    ["rescue only", one("rescue/src/server.ts"), ["[再チェック rescue] rescue: rescue/src/server.ts"], [], ["rescue"]],
    ["Design rules only", one("README.md"), ["[再チェック design-rules] 責務: README.md の ## Design rules"], [], ["design-rules"]],
    ["instructions only", one(".claude/skills/x/SKILL.md"), ["[聞く] 指示のファイル: .claude/skills/x/SKILL.md"], ["instructions"], []],
    ["responsibility only", one("ops.config.json"), ["[再チェック responsibility] 責務: ops.config.json"], [], ["responsibility"]],
    ["size only", one("apps/web/src/App.tsx", 301), ["[再チェック size] テストと docs を除いた変更が 301 行で、300 行を超えている"], [], ["size"]],
    ["another protected path", one("scripts/setup/x.sh"), ["[再チェック size] 保護するパスに触れている: scripts/setup/x.sh"], [], ["size"]],
    ["db.ts only", one("packages/core/src/db.ts"), ["[再チェック migration] 保護するパスに触れている: packages/core/src/db.ts"], [], ["migration"]],
  ] as const)("%s: the reason's head, ask and recheck", (_, files, reasons, ask, recheck) => {
    const j = judge(base({ files: [...files], designRulesTouched: files[0]!.path === "README.md" || undefined }), off);
    expect(j).toEqual({ verdict: "stop", impact: "large", reasons: [...reasons], ask: [...ask], recheck: [...recheck] });
  });

  test("an asked security group stays asked: a mark does not lift it, --allow-large does", () => {
    const files = [...one("src/auth.ts"), ...one("go.sum")];
    const ask = ["security:words"];
    expect(judge(base({ files }), off)).toMatchObject({ ask, recheck: ["security:lockfile"] });
    expect(judge(base({ files, rechecks: ["size", "rescue", "security:lockfile"] }), off)).toMatchObject({ verdict: "stop", reasons: ["[聞く] セキュリティ（security:words）: src/auth.ts"], ask, recheck: [] });
    expect(judge(yes("security:words,security:lockfile", { files }), { allowLarge: true })).toMatchObject({ verdict: "merge", reasons: [], ask });
    // a yes for one group does not lift the other
    expect(judge(yes("security:words", { files }), { allowLarge: true })).toMatchObject({ verdict: "stop" });
    expect(RECHECK_PASS.exec(`[recheck] security pass ${"a".repeat(40)}`)).toBeNull();
    expect(RECHECK_PASS.exec(`[recheck] security:words pass ${"a".repeat(40)}`)).toBeNull();
  });

  test("rescue is a recheck kind: its mark lifts it, another kind's or none does not", () => {
    const files = one("rescue/src/x.ts");
    expect(judge(base({ files }), off)).toMatchObject({ verdict: "stop", impact: "large", ask: [], recheck: ["rescue"], reasons: ["[再チェック rescue] rescue: rescue/src/x.ts"] });
    expect(marked(files, ["rescue"])).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    expect(marked(files, ["size"]).reasons).toEqual(["[再チェック rescue] rescue: rescue/src/x.ts"]);
    // an instruction file inside rescue is rescue and instructions; a security one there says セキュリティ
    expect(marked(one("rescue/CLAUDE.md"), ["rescue"])).toMatchObject({ verdict: "stop", reasons: ["[聞く] 指示のファイル: rescue/CLAUDE.md"], recheck: [] });
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
      { path: "ops.config.json", additions: 1, deletions: 0 },
      { path: "apps/web/src/App.tsx", additions: 301, deletions: 0 },
      { path: "package.json", additions: 1, deletions: 0 },
    ];
    expect(judge(base({ files }), off).recheck).toEqual(["size", "responsibility", "migration"]);
  });

  test("a recheck-only PR with a mark per kind merges; impact stays large", () => {
    expect(marked(one("ops.config.json"), ["responsibility"])).toEqual({ verdict: "merge", impact: "large", reasons: [], ask: [], recheck: [] });
    const files = [...one("apps/web/src/App.tsx", 301), ...one("ops.config.json"), ...one("packages/core/src/schema-baseline.json")];
    expect(marked(files, ["size", "responsibility", "migration"])).toMatchObject({ verdict: "merge", reasons: [], ask: [], recheck: [] });
  });

  test("a kind without its mark still stops, and only that kind is left", () => {
    const files = [...one("apps/web/src/App.tsx", 301), ...one("ops.config.json")];
    expect(marked(files, ["responsibility"])).toEqual({
      verdict: "stop",
      impact: "large",
      reasons: ["[再チェック size] テストと docs を除いた変更が 302 行で、300 行を超えている"],
      ask: [],
      recheck: ["size"],
    });
  });

  test("a mark does not lift an ask reason", () => {
    const files = [...one("src/auth.ts"), ...one("ops.config.json")];
    expect(marked(files, ["size", "responsibility", "migration"])).toMatchObject({ verdict: "stop", reasons: ["[聞く] セキュリティ（security:words）: src/auth.ts"], recheck: [] });
  });

  test.each([
    ["a failing CI", { checks: [{ name: "test", conclusion: "FAILURE" }] }, "CI のチェック test が FAILURE"],
    ["an unresolved thread", { unresolvedThreads: 1 }, "解決していないレビュースレッドが 1 件ある"],
    ["a commit after the review", { headCommittedAt: "2026-09-24T12:00:00Z" }, "最後のコミット（2026-09-24T12:00:00Z）より新しい主レビュー（[codex] review / [claude] review）が無い"],
    ["not CLEAN", { mergeState: "BLOCKED" }, "mergeStateStatus が CLEAN でない: BLOCKED"],
  ] as const)("a mark does not lift %s", (_, over, reason) => {
    expect(marked(one("ops.config.json"), ["responsibility"], over as Partial<PrFacts>)).toMatchObject({ verdict: "stop", reasons: [reason] });
  });
});

describe("task scope", () => {
  const file = (path: string) => ({ path, additions: 1, deletions: 0 });
  const task = (named: string[], siblings: { number: number; paths: string[] }[] = []) => ({ numbers: [2346], named, siblings });

  test("outside the task: stops and lists every outside path in the PR's order; a directory covers what is under it", () => {
    const files = ["z.ts", "ops-kit/src/x.ts", "scripts/a.ts", "b.ts", "scripts/c.test.ts"].map(file);
    const j = judge(base({ files, task: task(["ops-kit/", "scripts/a.ts"]) }), off);
    expect(j.verdict).toBe("stop");
    expect(j.impact).toBe("small");
    expect(j.reasons).toEqual(["Task #2346 の本文に名指しの無いファイル: z.ts, b.ts, scripts/c.test.ts"]);
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

describe("task scope: companion files", () => {
  const file = (path: string, more: Partial<PrFacts["files"][number]> = {}) => ({ path, additions: 1, deletions: 0, ...more });
  const task = (named: string[]) => ({ numbers: [2346], named, siblings: [] });
  const named = task(["packages/core/src/x.ts"]);
  const STOP = "Task #2346 の本文に名指しの無いファイル: ";
  const scope = (r: string[]) => r.filter((x) => x.includes("名指しの無いファイル"));

  test("the test next to a named file and a design document pass without being named, and the notes list them", () => {
    const j = judge(base({ files: ["packages/core/src/x.ts", "packages/core/src/x.test.ts", "docs/design/y.md"].map((p) => file(p)), task: named }), off);
    expect(j).toMatchObject({ verdict: "merge", reasons: [], notes: ["付いてくるファイル: packages/core/src/x.test.ts, docs/design/y.md"] });
    expect(judge(base({ files: [file("apps/web/src/V.test.tsx")], task: task(["apps/web/src/V.tsx"]) }), off).reasons).toEqual([]);
  });

  test("code elsewhere, a test of a file not named, scripts, workflows and rescue stop as before, next to the companions' note", () => {
    const outside = ["packages/core/src/z.ts", "packages/core/src/z.test.ts", "scripts/w.ts", ".github/workflows/ci.yml", "rescue/x.ts", "docs/other.md", "scripts/perf-budget.json", "ops.config.json"];
    const j = judge(base({ files: ["packages/core/src/x.test.ts", ...outside].map((p) => file(p)), task: named }), off);
    expect(scope(j.reasons)).toEqual([STOP + outside.join(", ")]);
    expect(j.notes).toEqual(["付いてくるファイル: packages/core/src/x.test.ts"]);
  });

  test("ops.config.json passes only when it lists the PR's own files for the public copy and changes nothing else", () => {
    const run = (configScope: PrFacts["configScope"], files = [file("docs/design/y.md", { status: "added" }), file("ops.config.json", { status: "modified" })]) => scope(judge(base({ files, task: named, configScope }), off).reasons);
    expect(run({ added: ["docs/design/y.md"], removed: [], other: false })).toEqual([]);
    // another line of the file (the merge gate's own setting), a path the PR does not add, a path it does not remove
    expect(run({ added: ["docs/design/y.md"], removed: [], other: true })).toEqual([STOP + "ops.config.json"]);
    expect(run({ added: ["private/"], removed: [], other: false })).toEqual([STOP + "ops.config.json"]);
    expect(run({ added: [], removed: ["private/"], other: false })).toEqual([STOP + "ops.config.json"]);
    // the change was not read: it stops
    expect(run(undefined)).toEqual([STOP + "ops.config.json"]);
    // a file the PR only modifies is not one it adds
    expect(run({ added: ["docs/design/y.md"], removed: [], other: false }, [file("docs/design/y.md", { status: "modified" }), file("ops.config.json")])).toEqual([STOP + "ops.config.json"]);
    // a rename: the new path comes in, the old one goes out; a removed file's line goes out
    const moved = [file("docs/design/new.md", { status: "renamed", previous: "docs/design/old.md" }), file("docs/design/gone.md", { status: "removed" }), file("ops.config.json", { status: "modified" })];
    expect(run({ added: ["docs/design/new.md"], removed: ["docs/design/old.md", "docs/design/gone.md"], other: false }, moved)).toEqual([]);
  });

  test("configScopeOf reads the two lists' paths and tells any other change apart", () => {
    const cfg = (over: object = {}, sync: object = {}) => JSON.stringify({ mergeGate: "scripts/merge-gate.ts", publicSync: { target: "o/public", include: ["a.md"], exclude: ["private/"], ...sync }, ...over });
    expect(configScopeOf(cfg(), cfg({}, { include: ["a.md", "docs/design/y.md"] }))).toEqual({ added: ["docs/design/y.md"], removed: [], other: false });
    expect(configScopeOf(cfg(), cfg({}, { include: [], exclude: ["private/", "b.md"] }))).toEqual({ added: ["b.md"], removed: ["a.md"], other: false });
    expect(configScopeOf(cfg(), cfg({}, { exclude: [] }))).toEqual({ added: [], removed: ["private/"], other: false });
    expect(configScopeOf(cfg(), cfg({ mergeGate: "x.ts" })).other).toBe(true);
    expect(configScopeOf(cfg(), cfg({}, { target: "o/other" })).other).toBe(true);
    expect(configScopeOf(cfg(), cfg({ sharedFiles: ["a.ts"] })).other).toBe(true);
    // a version that is not there or does not parse cannot be told: other
    expect(configScopeOf("", cfg()).other).toBe(true);
    expect(configScopeOf(cfg(), "{").other).toBe(true);
  });

  test("a companion's large reason stays: ops.config.json still asks for its recheck", () => {
    const files = [file("packages/core/src/x.ts"), file("docs/design/y.md", { status: "added" }), file("ops.config.json", { status: "modified" })];
    const j = judge(base({ files, task: named, configScope: { added: ["docs/design/y.md"], removed: [], other: false } }), off);
    expect(j).toMatchObject({ verdict: "stop", impact: "large", recheck: ["responsibility"], notes: ["付いてくるファイル: docs/design/y.md, ops.config.json"] });
    expect(j.reasons).toEqual(["[再チェック responsibility] 責務: ops.config.json"]);
  });
});

describe("shared files: a pass counts only while the base has not moved on a shared file the PR touches", () => {
  /** main0 ← pr (touches server.ts and own.ts). After the pass on main0, main moves: `other` on another file, `server` on server.ts, `merged` = the PR's own commit landed (a rebase merge). */
  let dir = "";
  let url = "";
  let clone = "";
  const S: Record<string, string> = {};
  const SHARED = ["src/server.ts"];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-gate-shared."));
    url = join(dir, "gh.git");
    clone = join(dir, "clone");
    const a = join(dir, "author");
    execFileSync("git", ["init", "-q", "--bare", url]);
    execFileSync("git", ["init", "-q", "-b", "main", a]);
    execFileSync("git", ["init", "-q", clone]);
    for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(a, "config", k!, v!);
    mkdirSync(join(a, "src"));
    const commit = (file: string, text: string) => {
      writeFileSync(join(a, file), text);
      git(a, "add", file);
      git(a, "commit", "-q", "-m", `${file}: ${text}`);
      return git(a, "rev-parse", "HEAD");
    };
    const at = (sha: string) => git(a, "checkout", "-q", "--detach", sha);
    S.main0 = commit("src/server.ts", "a\nb\nc\nd\ne\n");
    S.pr = commit("src/server.ts", "a\nb\nc\nd\ne mine\n");
    S.quiet = (at(S.main0), commit("src/own.ts", "x\n"));
    S.other = (at(S.main0), commit("src/other.ts", "o\n"));
    S.server = commit("src/server.ts", "a theirs\nb\nc\nd\ne\n");
    at(S.other);
    git(a, "cherry-pick", S.pr);
    S.merged = git(a, "rev-parse", "HEAD");
    for (const [name, sha] of Object.entries(S)) git(a, "push", "-q", url, `${sha}:refs/heads/${name}`);
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const verdict = async (head: string, baseTip: string, shared = SHARED) => {
    const mark = { body: `[local-ci] pass ${head} base=${S.main0}`, createdAt: "2026-09-24T11:30:00Z" };
    const local = await localCiOf(1, 1, [mark], async () => "", "o/r", async () => true, (passHead, passBase) => sharedMoved({ root: clone, url }, shared, passHead, passBase, baseTip));
    return { local, j: judge(base({ checks: local.pass ? [{ name: "local-ci", conclusion: "SUCCESS" }] : [], ...(local.note ? { localCiNote: local.note } : {}), ...(local.pass ? { localCi: true } : {}) }), off) };
  };

  test("the base moved on a shared file the PR touches: the pass does not count and the reason names the file", async () => {
    const { local, j } = await verdict(S.pr!, S.server!);
    expect(local.pass).toBe(false);
    expect(local.note).toContain("合流ファイルが base で進んだ: src/server.ts");
    expect(j.verdict).toBe("stop");
    expect(j.reasons.some((r) => r.includes("合流ファイル"))).toBe(true);
  });

  test("the base moved on other files only, the PR touches no shared file, or there is no list: the pass counts as before", async () => {
    expect((await verdict(S.pr!, S.other!)).j.verdict).toBe("merge");
    expect((await verdict(S.quiet!, S.server!)).j.verdict).toBe("merge");
    expect((await verdict(S.pr!, S.server!, [])).j.verdict).toBe("merge");
    expect((await verdict(S.pr!, S.main0!)).j.verdict).toBe("merge");
  });

  test("the PR's own commit landing on the base (the rebase after a merge below it) is not the base moving", async () => {
    expect(await sharedMoved({ root: clone, url }, SHARED, S.pr!, S.main0!, S.merged!)).toEqual([]);
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

  /**
   * A PR of host files as GitHub answers: the REST list (`rows`), the PR's whole diff (a section per file of `modes`:
   * the header lines after `diff --git`) and each file whole at the merge base `mb1`, the base's tip `base1` and the head.
   */
  const hostPr = (rows: { filename: string; status: string; previous_filename?: string }[], texts: Record<string, Partial<Record<"mb1" | "base1" | "abc123", string>>>, modes: Record<string, string[]> = {}, mergeBase = "base1") => {
    const asked: string[][] = [];
    const run = async (args: string[]) => {
      asked.push(args);
      if (args.some((x) => x.includes("/pulls/1/files"))) return rows.map((x) => JSON.stringify(x)).join("\n");
      if (args.includes("Accept: application/vnd.github.diff")) {
        return rows.map((x) => [`diff --git a/${x.filename} b/${x.filename}`, ...(modes[x.filename] ?? ["index 1111111..2222222 100644"]), `--- a/${x.filename}`, `+++ b/${x.filename}`, "@@ -1 +1 @@", "-x", "+y", ""].join("\n")).join("");
      }
      if (args.some((x) => x.includes("/compare/"))) return `${mergeBase}\n`;
      const at = args.find((x) => x.includes("/contents/"));
      if (at) {
        const m = /\/contents\/(.+)\?ref=(.+)$/.exec(at)!;
        const text = texts[m[1]!]?.[m[2] as "mb1"];
        if (text === undefined) throw new Error("404");
        return text;
      }
      return JSON.stringify(args[0] === "pr" ? { ...view, baseRefOid: "base1", files: rows.map((x) => ({ path: x.filename, additions: 1, deletions: 1 })) } : args[1]?.includes("/actions/runs") ? runs : threads([]));
    };
    return { asked, facts: readPr(1, run) };
  };
  const security = (f: PrFacts) => judge(f, off).reasons.filter((r) => r.includes("セキュリティ"));
  const BOOT = ["#!/bin/sh", "set -eu", "cat > /etc/sudoers.d/x <<SUDO", "host ALL=(root) NOPASSWD: /usr/bin/true", "SUDO", "curl \"$U\" \\", "  --checksum \"$S\"", ""];
  const boot = (at: number, ...add: string[]) => [...BOOT.slice(0, at), ...add, ...BOOT.slice(at)].join("\n");

  test("host files: each is read whole at the merge base and the head; a true comment edit is rechecked, a code line, an added file or a file not read is asked", async () => {
    const host = ["aws/host/a.sh", "aws/host/b.sh", "aws/host/c.sh", "aws/host/d.sh"];
    const x = hostPr(
      [{ filename: host[0]!, status: "modified" }, { filename: host[1]!, status: "modified" }, { filename: host[2]!, status: "modified" }, { filename: host[3]!, status: "added" }],
      {
        [host[0]!]: { base1: BOOT.join("\n"), abc123: boot(2, "# why the file is written") },
        [host[1]!]: { base1: BOOT.join("\n"), abc123: boot(2, "# words", "rm -rf /var/x") },
        [host[2]!]: { base1: BOOT.join("\n") }, // the head's file is not read
        [host[3]!]: { abc123: "# new\n" },
      },
    );
    const f = await x.facts;
    expect(f.files.map((y) => [y.status, y.commentOnly])).toEqual([["modified", true], ["modified", undefined], ["modified", undefined], ["added", undefined]]);
    expect(security(f)).toEqual([
      "[再チェック security:tests] セキュリティ（security:tests）: aws/host/a.sh",
      expect.stringMatching(/^\[聞く\] セキュリティ（security:host）: aws\/host\/b\.sh, aws\/host\/c\.sh, aws\/host\/d\.sh/),
    ]);
    // a PR with no host file reads no diff and no file
    calls.length = 0;
    await readPr(1, fake(threads([])));
    expect(calls.some((a) => a.some((s) => s.includes("vnd.github.diff") || s.includes("/contents/")))).toBe(false);
  });

  test("limit files: read at the merge base and the head, not at the base's tip", async () => {
    const budget = (n: number) => JSON.stringify({ local: { journeys: { launch: { layoutCount: n } } }, exceptions: [] });
    const x = hostPr([{ filename: "scripts/perf-budget.json", status: "modified" }], { "scripts/perf-budget.json": { mb1: budget(7), base1: budget(10), abc123: budget(10) } }, {}, "mb1");
    expect((await x.facts).limitsRaised).toEqual(["scripts/perf-budget.json local.journeys.launch.layoutCount: 7 → 10"]);
  });

  test("host files: a # line in the sudoers here-document, a # or blank line between continued lines, and a mode change are asked", async () => {
    const asked = [expect.stringMatching(/^\[聞く\] セキュリティ（security:host）: aws\/host\/bootstrap\.sh/)];
    const pr = (head: string, modes?: string[]) => hostPr([{ filename: "aws/host/bootstrap.sh", status: "modified" }], { "aws/host/bootstrap.sh": { base1: BOOT.join("\n"), abc123: head } }, modes ? { "aws/host/bootstrap.sh": modes } : {});
    expect(security(await pr(boot(4, "#includedir /home/host/x")).facts)).toEqual(asked);
    expect(security(await pr(boot(6, "# note")).facts)).toEqual(asked);
    expect(security(await pr(boot(6, "")).facts)).toEqual(asked);
    const comment = boot(5, "# where the download comes from");
    expect(security(await pr(comment, ["old mode 100644", "new mode 100755", "index 1111111..2222222"]).facts)).toEqual(asked);
    // the same comment edit with no mode change is the recheck
    expect(security(await pr(comment).facts)).toEqual(["[再チェック security:tests] セキュリティ（security:tests）: aws/host/bootstrap.sh"]);
  });

  test("host files: the base moved on the file since the fork, or the PR's diff is not read: asked", async () => {
    const path = "aws/host/bootstrap.sh";
    const head = boot(5, "# where the download comes from");
    const asked = [expect.stringMatching(/^\[聞く\] セキュリティ（security:host）: aws\/host\/bootstrap\.sh/)];
    // the base's tip opened a here-document above the PR's line: the merged file is not the head's
    const moved = hostPr([{ filename: path, status: "modified" }], { [path]: { mb1: BOOT.join("\n"), base1: "cat <<X\n" + BOOT.join("\n"), abc123: head } }, {}, "mb1");
    expect(security(await moved.facts)).toEqual(asked);
    const same = hostPr([{ filename: path, status: "modified" }], { [path]: { mb1: BOOT.join("\n"), base1: BOOT.join("\n"), abc123: head } }, {}, "mb1");
    expect(security(await same.facts)).toEqual(["[再チェック security:tests] セキュリティ（security:tests）: aws/host/bootstrap.sh"]);
    // no section of the file in the diff (GitHub cut it, or the path is quoted)
    const cut = hostPr([{ filename: path, status: "modified" }], { [path]: { base1: BOOT.join("\n"), abc123: head } }, { [path]: ["index 1111111..2222222 100644", "--- a/other"] });
    expect(security(await cut.facts)).toEqual(asked);
  });

  test("a rename is read with its old path (GitHub's REST list): product code moved into a fixture path, or out of a guarded path, is asked; an unknown status takes a test for no test", async () => {
    const pr = (rows: { filename: string; status: string; previous_filename?: string }[]) => hostPr(rows, {}).facts;
    const f = await pr([{ filename: "aws/fixtures/auth.ts", status: "renamed", previous_filename: "aws/auth.ts" }, { filename: "src/login.ts", status: "renamed", previous_filename: "src/auth.ts" }, { filename: "src/token.test.ts", status: "modified" }]);
    expect(f.files.map((x) => [x.status, x.previous])).toEqual([["renamed", "aws/auth.ts"], ["renamed", "src/auth.ts"], ["modified", undefined]]);
    expect(security(f)).toEqual([
      "[再チェック security:tests] セキュリティ（security:tests）: src/token.test.ts",
      "[聞く] セキュリティ（security:words）: aws/fixtures/auth.ts（改名前: aws/auth.ts）, src/login.ts（改名前: src/auth.ts）",
    ]);
    // a rename with no old path, a status GitHub does not document, and a file the list does not have
    const odd = await pr([{ filename: "a/fixtures/auth.ts", status: "renamed" }, { filename: "b/auth.test.ts", status: "unknown" }]);
    expect(odd.files.map((x) => x.status)).toEqual([undefined, undefined]);
    expect(security(odd)).toEqual(["[聞く] セキュリティ（security:words）: a/fixtures/auth.ts, b/auth.test.ts"]);
    const view2 = await readPr(1, async (args) => (args[0] === "pr" ? JSON.stringify({ ...view, files: [{ path: "b/auth.test.ts", additions: 1, deletions: 0 }] }) : args.some((s) => s.includes("/pulls/1/files")) ? "" : args[1]?.includes("/actions/runs") ? JSON.stringify(runs) : JSON.stringify(threads([]))));
    expect(security(view2)).toEqual(["[聞く] セキュリティ（security:words）: b/auth.test.ts"]);
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

  describe("the Tasks a PR closes", () => {
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

    test("a Task's PR that touches ops.config.json: each file's change and the file's two versions are read, and listing its own new document passes", async () => {
      const cfg = (include: string[]) => JSON.stringify({ publicSync: { target: "o/p", include } });
      const seen: string[][] = [];
      const withConfig = (headInclude: string[]) => async (args: string[]) => {
        seen.push(args);
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ ...view, body: "Closes #5", headRefName: "x", baseRefOid: "base1", files: [{ path: "scripts/a.ts", additions: 1, deletions: 0 }, { path: "docs/design/y.md", additions: 1, deletions: 0 }, { path: "ops.config.json", additions: 1, deletions: 0 }] });
        if (args.some((x) => x.includes("/pulls/1/files"))) return ['{"filename":"scripts/a.ts","status":"modified"}', '{"filename":"docs/design/y.md","status":"added"}', '{"filename":"ops.config.json","status":"modified"}'].join("\n");
        if (args[1]?.includes("/compare/")) return "mb1\n";
        if (args.some((x) => x.includes("contents/ops.config.json?ref=mb1"))) return cfg([]);
        if (args.some((x) => x.includes("contents/ops.config.json?ref=abc123"))) return cfg(headInclude);
        return gate({ body: "", headRefName: "" })(args);
      };
      const f = await readPr(1, withConfig(["docs/design/y.md"]));
      expect(f.configScope).toEqual({ added: ["docs/design/y.md"], removed: [], other: false });
      expect(f.files.map((x) => x.status)).toEqual(["modified", "added", "modified"]);
      expect(judge(f, off).reasons.filter((r) => r.includes("名指しの無いファイル"))).toEqual([]);
      expect(judge(f, off).notes).toEqual(["付いてくるファイル: docs/design/y.md, ops.config.json"]);
      // a directory listed for the public copy is not a file the PR adds
      const wide = await readPr(1, withConfig(["docs/"]));
      expect(judge(wide, off).reasons.filter((r) => r.includes("名指しの無いファイル"))).toEqual(["Task #5 の本文に名指しの無いファイル: ops.config.json"]);
    });

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

    test("a stop for a file no Task names records it in the app for each Task, and does not change the output; another stop records nothing", async () => {
      const posts: Array<{ url: string; body: unknown }> = [];
      const fetchApp = async (url: string, init?: RequestInit) => { posts.push({ url, body: JSON.parse(String(init?.body)) }); return Response.json({ recorded: true }); };
      const env = { BACKLOG_URL: "http://127.0.0.1:1/api/backlog", OPS_KIT_TASK_ID: "t1" };
      const stop = async (path: string, e: Record<string, string | undefined>, f: typeof fetchApp | (() => never) = fetchApp) => {
        const g = gate({ body: "Closes #5", headRefName: "sb/5-a" });
        const out: string[] = [];
        const code = await main(["12", "--repo", REPO], async (a) => (a[0] === "pr" && a[1] === "view" ? JSON.stringify({ ...JSON.parse(await g(a)), files: [{ path, additions: 1, deletions: 0 }] }) : g(a)), (l) => out.push(l), () => {}, () => REPO, undefined, process.cwd(), { env: e, fetch: f as typeof fetchApp });
        return { code, out: out.join("\n") };
      };
      const outside = await stop("zzz/other.ts", env);
      expect(outside.code).toBe(1);
      expect(outside.out).toContain("の本文に名指しの無いファイル: zzz/other.ts");
      expect(posts).toEqual([{ url: "http://127.0.0.1:1/api/merge-grants/scope-stop", body: { taskId: "t1", repo: REPO, issue: 5, pr: 12 } }]);
      // the app failing or absent leaves the output as it is
      const failing = await stop("zzz/other.ts", env, () => { throw new Error("down"); });
      expect(failing).toEqual(outside);
      expect(await stop("zzz/other.ts", {})).toEqual(outside);
      // a file a Task names is not a scope stop
      posts.length = 0;
      await stop("scripts/a.ts", env);
      expect(posts).toEqual([]);
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

  describe("local CI in place of an Actions CI that never started or never ran", () => {
    const BASE = "3333333333333333333333333333333333333333";
    /**
     * A real repository: `url` is "GitHub" (a bare one), `clone` the worktree merge-gate runs in (empty: it fetches
     * what it judges by). `S`: named commits. main0 ← b1 ← b2 ← b3 is the stack (`#1`, `#2`, `#3`: one commit each, its own file);
     * main1 is main after another commit and `#1`'s rebase merge, b2r `#2` rebased onto it by GitHub (another sha, the same
     * diff); b2fix `#2` with a fix commit on it, b2changed `#2`'s commit made again with another diff, b2merge `#2` with a merge
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
      // `#2` with `#3`'s commit merged in, and a change made in the merge commit (as a conflict resolved there)
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
     * open PRs per base branch (`b1: [2]` → `#2` is on `#1`), the top's comments `top`. `comment` / `comments`: PR n's, by the
     * owner, a minute apart. `runs: false` = no Actions run at all; `conclusion`: the one run's (default failure).
     * `root` / `from`: where merge-gate fetches to and from (default the clone and "GitHub").
     */
    const facts = (opts: { n?: number; comment?: string; comments?: string[]; steps: number; runs?: boolean; conclusion?: string; status?: string; mergeState?: string; above?: Record<string, number[]>; top?: string[]; head?: string; baseTip?: string; root?: string; from?: string }) => {
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
      const r = { workflow_runs: opts.runs === false ? [] : [{ id: 7, name: "CI", status: opts.status ?? "completed", conclusion: opts.status ? null : opts.conclusion ?? "failure", created_at: "2026-09-24T12:00:00Z" }] };
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
      return { asked, run, read: (repo?: string, held?: Parameters<typeof readPr>[4]) => readPr(n, run, repo, { root: opts.root ?? clone, url: opts.from ?? url }, held) };
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

    test("a narrowed pass counts as any pass: the comment's added lines change nothing", async () => {
      const body = resultComment({ sha: S.b1!, base: BASE, ok: true, results: [], selection: { files: ["a.test.ts"], total: 200, reason: "x" } });
      expect(await localCiOf(1, 1, [{ body, createdAt: "2026-11-01T00:00:00Z" }], async () => "", "o/r", async (h) => h === S.b1)).toEqual({ pass: true });
    });

    test("an incremental pass of the head after a fix commit counts as any pass: the 増分 line changes nothing", async () => {
      const incremental = resultComment({ sha: S.b2fix!, base: BASE, ok: true, results: [], incremental: { pass: S.b2!, commits: 1, files: 1 }, selection: { files: ["a.test.ts"], total: 200, reason: "x" } });
      expect(incremental).toContain(`増分: ${S.b2!.slice(0, 7)} の pass の後の 1 コミット（変更 1 ファイル）`);
      // `#2` is the top here: the fix commit is in the pass's head, with the same diff
      const f = await facts({ n: 2, head: S.b2fix, comments: [pass(S.b2!), incremental], steps: 0 }).read();
      expect(f.checks).toEqual(SUCCESS);
      expect(f.localCi).toBe(true);
      expect(reasons(f)).toEqual([]);
      // the same without the line (a full run of that head) counts the same
      expect(reasons(await facts({ n: 2, head: S.b2fix, comments: [pass(S.b2!), pass(S.b2fix!)], steps: 0 }).read())).toEqual([]);
    });

    test("before the incremental pass is posted, the newest result is the earlier pass and the fix commit is not counted", async () => {
      const f = await facts({ n: 2, head: S.b2fix, comment: pass(S.b2!), steps: 0 }).read();
      expect(f.checks).toEqual([{ name: "CI", conclusion: "FAILURE" }]);
      expect(reasons(f)).toContain(`この PR のコミットが #2 の pass（${S.b2!.slice(0, 7)}）に同じ差分で入っていない（一番上で回し直す）`);
    });

    test("a pass whose comment has no perf step counts as SUCCESS: the gate asks for the mark only (a PR's run does not measure perf)", async () => {
      const steps = ["bun install --frozen-lockfile", "bun run typecheck", "bun test"].map((name) => ({ name, code: 0, seconds: 1 }));
      const body = resultComment({ sha: S.b1!, base: BASE, ok: true, results: steps as never, selection: { files: ["a.test.ts"], total: 200, reason: "x" } });
      expect(body).not.toMatch(/perf-bench|perf-ratchet|bundle:|grew:/);
      const f = await facts({ comment: body, steps: 0, runs: false }).read();
      expect(f.checks).toEqual([{ name: "local-ci（Actions の run が無く、ローカルで pass）", conclusion: "SUCCESS" }]);
      expect(f.localCi).toBe(true);
      expect(reasons(f)).toEqual([]);
    });

    test("a pass that subtracted known failures merges like any pass: the gate reads the first line only", async () => {
      const steps = ["bun install --frozen-lockfile", "bun run typecheck"].map((name) => ({ name, code: 0, seconds: 1 }));
      const bun = { name: "bun test", run: "bun test", code: 1, seconds: 1, tail: "", fails: [] };
      const known = { subtracted: [{ line: "(fail) a.test.ts > flaky [1.0ms]", issue: 4826, until: "2026-12-01" }], expired: [] };
      const body = resultComment({ sha: S.b1!, base: BASE, ok: true, results: [...steps, bun] as never, known });
      expect(body).toContain("既知の失敗を差し引いた（known-failures.json、base の登録）:");
      expect(body.split("\n")[0]).toBe(`[local-ci] pass ${S.b1} base=${BASE}`);
      const f = await facts({ comment: body, steps: 0, runs: false }).read();
      expect(f.checks).toEqual([{ name: "local-ci（Actions の run が無く、ローカルで pass）", conclusion: "SUCCESS" }]);
      expect(f.localCi).toBe(true);
      expect(reasons(f)).toEqual([]);
    });

    test("a pass whose steps came from the settings Switchboard keeps for the workspace (nothing in the repository, no Actions run) merges like any pass when those steps are the ones the person confirmed; with other steps, or none confirmed, it is no CI check", async () => {
      const body = resultComment({ sha: S.b1!, base: BASE, ok: true, results: [{ name: "check", run: "make check", code: 0, seconds: 1, tail: "" }], source: { workspace: "lib", hash: "0123456789ab" } });
      expect(body.split("\n")[0]).toBe(`[local-ci] pass ${S.b1} base=${BASE}`);
      expect(body).toContain("手順の出どころ: Switchboard の側の設定（workspace `lib`、手順のハッシュ `0123456789ab`）");
      const held = { workspace: "lib", version: "aaaaaaaaaaaa", ciHash: "0123456789ab", pending: null };
      const f = await facts({ comment: body, steps: 0, runs: false }).read(undefined, held);
      expect(f.checks).toEqual([{ name: "local-ci（Actions の run が無く、ローカルで pass）", conclusion: "SUCCESS" }]);
      expect(reasons(f)).toEqual([]);
      expect(f.held).toEqual(held);
      // the same comment against other confirmed steps, or with nothing confirmed for the clone: the pass does not count
      for (const other of [{ ...held, ciHash: "ffffffffffff" }, undefined]) {
        const g = await facts({ comment: body, steps: 0, runs: false }).read(undefined, other);
        expect(g.checks).toEqual([]);
        expect(reasons(g)).toEqual(["CI のチェックが 1 つも無い", expect.stringContaining("利用者の確かめた設定の手順")]);
      }
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

    test("--repo: another repository's pass → SUCCESS, read from that repository", async () => {
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

    test("a run still queued + the pass → SUCCESS; without the pass it is 未完了; in_progress stays 未完了 even with the pass", async () => {
      const queued = await facts({ comment: pass(S.b1!), steps: 0, status: "queued" }).read();
      expect(queued.checks).toEqual(SUCCESS);
      expect(reasons(queued)).toEqual([]);
      expect(reasons(await facts({ steps: 0, status: "queued" }).read())).toContain("CI のチェック CI が 未完了");
      expect(reasons(await facts({ comment: pass(S.b1!), steps: 0, status: "in_progress" }).read())).toContain("CI のチェック CI が 未完了");
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
      expect(reasons(f)).toEqual(["mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果は PR コメントで、GitHub の必須チェックにはならない（docs/merge-gate.md の「Branch protection and local results」）"]);
      // without a local pass BLOCKED is said as before
      expect(reasons({ ...f, localCi: undefined, checks: [{ name: "CI", conclusion: "SUCCESS" }] })).toEqual(["mergeStateStatus が CLEAN でない: BLOCKED"]);
    });

    test("unknown: mergeStateStatus UNKNOWN is no judgement (readPr throws → exit 2)", async () => {
      await expect(facts({ comment: pass(S.b1!), steps: 0, mergeState: "UNKNOWN" }).read()).rejects.toThrow("UNKNOWN");
    });

    test("stack: a first-line-only pass on the top counts for the bottom and the middle; the top's newest fail does not", async () => {
      // `#1` ← `#2` ← `#3`; only `#3` has a result, by the owner (an outsider's newer pass on `#3` does not count)
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
      // `#1` merged into main by rebase (after another commit); `#2` is on main now: another sha, its commit's diff the same
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
      `[recheck] security:lockfile pass ${HEAD}`, // a security group the owner moved to a recheck
      `[recheck] security:words pass ${HEAD}`, // an asked group: not a recheck kind
    ]);
    expect(f.rechecks).toEqual(["security:lockfile", "responsibility", "migration", "rescue"]);
    expect((await read([])).rechecks).toBeUndefined();
  });

  test("marks by an author outside the repository (a public --repo) do not count: review, [local-ci], [recheck]", async () => {
    // a pass that would count but for its author: the PR's head on the PR's base, both in a real repository (inPass reads them)
    const dir = mkdtempSync(join(tmpdir(), "merge-gate-outsider."));
    try {
      const url = join(dir, "gh.git");
      const a = join(dir, "author");
      const clone = join(dir, "clone");
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
      for (const x of [["--bare", url], ["-b", "main", a], [clone]]) execFileSync("git", ["init", "-q", ...x]);
      for (const [k, val] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(a, "config", k!, val!);
      const commit = (file: string) => (writeFileSync(join(a, file), `${file}\n`), git(a, "add", file), git(a, "commit", "-q", "-m", file), git(a, "rev-parse", "HEAD"));
      const BASE = commit("README");
      const HEAD = commit("one");
      git(a, "push", "-q", url, `${HEAD}:refs/heads/pr`);
      const outsider = (body: string, authorAssociation?: string) => ({ body, createdAt: "2026-09-24T11:30:00Z", ...(authorAssociation ? { authorAssociation } : {}) });
      const facts = (localCiAuthor: string) => {
        const v = {
          ...view,
          headRefOid: HEAD,
          baseRefOid: BASE,
          comments: [
            outsider("[claude] review"),
            outsider(`[recheck] migration pass ${HEAD}`, "CONTRIBUTOR"),
            outsider(`[local-ci] pass ${HEAD} base=${BASE}`, localCiAuthor),
            { ...view.comments[0]!, authorAssociation: "FIRST_TIME_CONTRIBUTOR" },
          ],
        };
        const r = { workflow_runs: [{ id: 7, name: "CI", status: "completed", conclusion: "failure", created_at: "2026-09-24T12:00:00Z" }] };
        return readPr(1, async (args) => JSON.stringify(args[0] === "pr" ? v : args[1]?.endsWith("/jobs") ? { jobs: [{ steps: [] }] } : args[1]?.includes("/actions/runs") ? r : threads([])), REPO, { root: clone, url });
      };
      const f = await facts("NONE");
      expect(f.reviewComments).toEqual([]);
      expect(f.rechecks).toBeUndefined();
      expect(f.checks).toEqual([{ name: "CI", conclusion: "FAILURE" }]);
      // the same mark by the owner counts: only the author rule kept it out above
      expect((await facts("OWNER")).checks).toEqual([{ name: "CI（Actions が始まらず、ローカルで pass）", conclusion: "SUCCESS" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      expect(x.asked.some((a) => a.some((s) => s.includes("select(.filename")))).toBe(false);
    });

    test("a new README, or none in the PR, reads nothing more", async () => {
      const x = read(null, "ADDED");
      expect((await x.facts).designRulesTouched).toBeUndefined();
      expect(x.asked.some((a) => a.some((s) => s.includes("select(.filename") || s.includes("/contents/")))).toBe(false);
      calls.length = 0;
      await readPr(1, fake(threads([])));
      expect(calls.some((a) => a.some((s) => s.includes("select(.filename") || s.includes("/contents/")))).toBe(false);
    });
  });

  describe("user-marked lines (readPr)", () => {
    const file = "# C\n- a\n- b（2026-11-03 の利用者の指摘）\n- c\n";
    const read = (instruction: string, patch: string, changeType = "MODIFIED", changes = 2, previous?: string) => {
      const v = { ...view, baseRefOid: "base1", files: [{ path: instruction, additions: 1, deletions: 1, changeType }] };
      return readPr(1, async (args) => {
        if (args[0] === "pr" && args[1] === "list") return "[]";
        if (args[0] === "pr") return JSON.stringify(v);
        if (args.some((a) => a.includes("/pulls/1/files"))) return JSON.stringify({ filename: instruction, previous_filename: previous ?? null, status: changeType.toLowerCase(), changes, patch: patch ?? null }) + "\n"; // as jq writes it: a missing key is null
        if (args.some((a) => a.includes("/compare/"))) return "merge1\n";
        if (args.some((a) => a.includes("/contents/"))) return file;
        if (args[1]?.includes("/actions/runs")) return JSON.stringify(runs);
        return JSON.stringify(threads([]));
      });
    };

    test("a rewritten marked line is read against the file at the merge base", async () => {
      const facts = await read("packages/core/CLAUDE.md", "@@ -3 +3 @@\n-- b（2026-11-03 の利用者の指摘）\n+- b2\n");
      expect(facts.userRulesTouched).toEqual(["packages/core/CLAUDE.md:3"]);
      expect(judge(facts, off).reasons[0]).toContain("packages/core/CLAUDE.md:3");
    });

    test("an unmarked line, or a file that is new, gives no field", async () => {
      expect((await read("CLAUDE.md", "@@ -2 +2 @@\n-- a\n+- a2\n")).userRulesTouched).toBeUndefined();
      expect((await read("CLAUDE.md", "@@ -0,0 +1 @@\n+x\n", "ADDED")).userRulesTouched).toBeUndefined();
    });

    test("a rename out of an instruction path is read at the path before it", async () => {
      const facts = await read("docs/rules.md", "@@ -3 +3 @@\n-- b（2026-11-03 の利用者の指摘）\n+- b2\n", "RENAMED", 2, "CLAUDE.md");
      expect(facts.userRulesTouched).toEqual(["CLAUDE.md:3"]);
      // and judge gets the rename from the same rows: asked and split
      const j = judge(facts, off);
      expect(j.reasons).toContain("[聞く] 指示のファイル: docs/rules.md（改名前: CLAUDE.md）（利用者の決まりの行を消す・変える: CLAUDE.md:3）");
      expect(j.reasons.some((r) => r.startsWith("[分ける]"))).toBe(true);
    });

    test("a copy out of an instruction file reads no line of it", async () => {
      const facts = await read("docs/copy.md", "@@ -3 +3 @@\n-- b（2026-11-03 の利用者の指摘）\n+- b2\n", "COPIED", 2, "CLAUDE.md");
      expect(facts.userRulesTouched).toBeUndefined();
    });

    test("a file whose patch GitHub leaves out is listed as not read", async () => {
      expect((await read("CLAUDE.md", undefined as unknown as string)).userRulesTouched).toEqual(["CLAUDE.md: 差分を読めない"]);
      // a pure rename or a binary file has no patch and no changed line
      expect((await read("CLAUDE.md", undefined as unknown as string, "RENAMED", 0)).userRulesTouched).toBeUndefined();
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

  test("--merge of a direct branch without a main review marks the head, then merges", async () => {
    const calls: string[][] = [];
    const code = await main(["7", "--merge"], async (a) => {
      calls.push(a);
      if (a[0] === "pr" && a[1] === "view") return JSON.stringify(view({ headRefName: "sb/direct-x", comments: [] }));
      if (a[0] === "pr" && a[1] === "list") return "[]";
      if (a[0] === "pr") return "";
      return JSON.stringify(a[1]?.includes("/actions/runs") ? runs : threads);
    }, () => {}, () => {}, () => REPO);
    expect(code).toBe(0);
    expect(calls.filter((a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "merge")).map((a) => a[1])).toEqual(["comment", "merge"]);
    expect(calls.find((a) => a[1] === "comment")![6]).toBe(`[merge-direct] ${SHA}`);
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
    // the security groups
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

describe("merge-gate reads GitHub, not the stored backlog", () => {
  test("it does not import the daemon's database or the stored backlog: a PR's head, reviews, checks and protection are read from gh each time", async () => {
    const src = await Bun.file(new URL("./merge-gate.ts", import.meta.url)).text();
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
    // a local change (--change) has no other place than the app: its view, through the kit's client, never a PR's
    expect(imports.filter((i) => /packages\/core|db|backlog|sqlite|parallel-guard/.test(i))).toEqual(["../ops-kit/src/backlog-client.ts"]);
    // readPr (a PR) never reads it
    expect(src.slice(src.indexOf("export async function readPr("), src.indexOf("/** A local change as")).includes("Backlog")).toBe(false);
    expect(src).not.toMatch(/bun:sqlite|switchboard\.db|readStoredBacklog|listBacklogRecords/);
  });
});

describe("GitLab MR", () => {
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

describe("local change", () => {
  const BACKLOG = "http://app/api/backlog";
  /** A repository with no remote: main, and a branch sb/5-x of `lines` added lines in one commit dated 2026-01-01. */
  function repo(lines = 3) {
    const dir = mkdtempSync(join(tmpdir(), "merge-gate-change-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    git("checkout", "-q", "-b", "sb/5-x");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), Array.from({ length: lines }, (_, i) => `b${i}\n`).join(""));
    git("add", "-A");
    git("commit", "-q", "-m", "b");
    git("checkout", "-q", "main");
    return { dir, git, tip: (b: string) => git("rev-parse", b) };
  }
  type Repo = ReturnType<typeof repo>;
  const REVIEW = { body: "[claude] review\n\n### Intent and design", createdAt: "2026-01-02T00:00:00Z" };
  /** The app's answers: the workspace list, and change `#7` with these comments and the tips of `r` now. */
  type Stored = { number: number; labels: string[]; body: string; parent: number | null };
  /** `github`: the workspace's Issues are GitHub's (`issues`, as last imported) and the change is numbered apart from them; `pr`: the PR it stands in for. */
  type World = { github?: boolean; issues?: Stored[]; pr?: number; body?: string };
  function app(r: Repo, comments: { body: string; createdAt: string }[], state = "OPEN", w: World = {}) {
    const calls: string[] = [];
    const posts: Array<{ path: string; body: unknown }> = [];
    const service = w.github ? "github" : "switchboard";
    const fetch = async (url: string, init?: RequestInit) => {
      const path = url.replace(BACKLOG, "").replace("http://app", "");
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return new Response("{}");
      }
      calls.push(path);
      const body = path === "/syncs"
        ? { syncs: [{ workspaceId: "ws_local", backlog: service, repository: w.github ? "acme/app" : "ws_local", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] }
        : path.startsWith("/records")
          ? { workspaceId: "ws_local", service, repository: w.github ? "acme/app" : "ws_local", project: { owner: "o", number: 0 }, fetchedAt: 1, top: [{ name: "src", dir: true }, { name: "a.ts", dir: false }], unread: [], pulls: [], comments: [], issues: (w.issues ?? []).map((i) => ({ title: "t", url: "", state: "OPEN", stateReason: null, subIssues: [], createdAt: "", updatedAt: "", closedAt: null, fields: null, ...i })) }
          : { workspaceId: "ws_local", issue: { number: 7, title: "変更", state, labels: [], milestone: null, parent: null, subIssues: [], body: w.body ?? "", url: "", change: { head: "sb/5-x", base: "main", mergeCommit: null, mergedAt: null, reviewedHead: null, pr: w.pr ?? null, reportedAt: null } }, changeRefs: { head: r.tip("sb/5-x"), base: r.tip("main") }, comments: comments.map((c, i) => ({ id: `sb:${i}`, ...c })), fields: null, fetchedAt: 1, localId: null, pending: 0, held: [], sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } };
      return new Response(JSON.stringify(body));
    };
    return { fetch, calls, posts };
  }
  /** main --change 7 in `r` with gh failing the test if called. */
  async function gate(r: Repo, comments: { body: string; createdAt: string }[], extra: string[] = [], state = "OPEN", w: World = {}) {
    const a = app(r, comments, state, w);
    const out: string[] = [];
    const err: string[] = [];
    const ghCalls: string[][] = [];
    const run = async (args: string[]) => { ghCalls.push(args); throw new Error("gh called"); };
    const code = await main(["--change", "7", ...extra], run, (s) => out.push(s), (s) => err.push(s), () => undefined, async () => { throw new Error("glab called"); }, r.dir, { env: { BACKLOG_URL: BACKLOG, BACKLOG_WORKSPACE: "ws_local", OPS_KIT_TASK_ID: "task_1" }, fetch: a.fetch });
    expect(ghCalls).toEqual([]);
    return { code, j: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n"), calls: a.calls, posts: a.posts };
  }
  const mark = (result: "pass" | "fail", r: Repo) => `[local-ci] ${result} ${r.tip("sb/5-x")} base=${r.tip("main")}\n\n結果`;
  const pass = (r: Repo, at = "2026-01-03T00:00:00Z") => ({ body: mark("pass", r), createdAt: at });
  const repos: Repo[] = [];
  const fresh = (lines?: number) => {
    const r = repo(lines);
    repos.push(r);
    return r;
  };
  afterAll(() => { for (const r of repos) rmSync(r.dir, { recursive: true, force: true }); });

  test("(a) reviewed and a local-ci pass of the head and base now: merge, read from the app and git only", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r)]);
    expect(g.code).toBe(0);
    expect(g.j).toEqual({ verdict: "merge", impact: "small", reasons: [], ask: [], recheck: [] });
    // read as a change (never the Issue of the same number), and the workspace's stored Issues for the Task-scope check
    expect(g.calls).toEqual(["/syncs", "/7?workspaceId=ws_local&change=1", "/records?workspaceId=ws_local"]);
  });

  test("(b) a commit after the review: no newer main review stops", async () => {
    const r = fresh();
    r.git("checkout", "-q", "sb/5-x");
    writeFileSync(join(r.dir, "src", "c.ts"), "c\n");
    r.git("add", "-A");
    execFileSync("git", ["-C", r.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-05T00:00:00Z" } });
    r.git("checkout", "-q", "main");
    const g = await gate(r, [REVIEW, pass(r, "2026-01-06T00:00:00Z")]);
    expect(g.code).toBe(1);
    expect(g.j.reasons).toEqual([expect.stringContaining("より新しい主レビュー")]);
  });

  test("(c) a pass of an older base: no CI, with the note", async () => {
    const r = fresh();
    const old = pass(r);
    writeFileSync(join(r.dir, "z.ts"), "z\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "z");
    const g = await gate(r, [REVIEW, old]);
    expect(g.code).toBe(1);
    expect(g.j.reasons).toEqual(["CI のチェックが 1 つも無い", expect.stringMatching(/^local-ci の pass の base（[0-9a-f]{7}）が今の base の先端（[0-9a-f]{7}）でない/)]);
    // none at all: no note
    const none = await gate(r, [REVIEW]);
    expect(none.j.reasons).toEqual(["CI のチェックが 1 つも無い"]);
  });

  test("(c') a fail after the pass does not count the pass", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r), { body: mark("fail", r), createdAt: "2026-01-04T00:00:00Z" }]);
    expect(g.j.reasons).toEqual(["CI のチェックが 1 つも無い", "local-ci の最新が fail"]);
  });

  test("(d) a conflict with the base's tip: DIRTY", async () => {
    const r = fresh();
    mkdirSync(join(r.dir, "src"));
    writeFileSync(join(r.dir, "src", "b.ts"), "other\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "conflict");
    const g = await gate(r, [REVIEW, pass(r)]);
    expect(g.code).toBe(1);
    expect(g.j.reasons).toEqual(["mergeStateStatus が CLEAN でない: DIRTY"]);
  });

  test("(e) a closed change stops", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r)], [], "CLOSED");
    expect(g.j.reasons).toEqual(["mergeStateStatus が CLEAN でない: CLOSED"]);
  });

  test("(f) over 300 lines: [再チェック size], lifted by its mark of the head", async () => {
    const r = fresh(301);
    const g = await gate(r, [REVIEW, pass(r)]);
    expect(g.code).toBe(1);
    expect(g.j).toMatchObject({ impact: "large", recheck: ["size"], reasons: [expect.stringMatching(/^\[再チェック size\] .*301 行/)] });
    const marked = await gate(r, [REVIEW, pass(r), { body: `[recheck] size pass ${r.tip("sb/5-x")}`, createdAt: "2026-01-04T00:00:00Z" }]);
    expect(marked.code).toBe(0);
  });

  test("readChange instructions and limits", async () => {
    const r = fresh();
    const budget = (n: number) => JSON.stringify({ local: { journeys: { launch: { layoutCount: n } } }, exceptions: [] }, null, 2) + "\n";
    mkdirSync(join(r.dir, "scripts"));
    writeFileSync(join(r.dir, "scripts", "perf-budget.json"), budget(7));
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "budget");
    r.git("checkout", "-q", "sb/5-x");
    r.git("rebase", "-q", "main");
    writeFileSync(join(r.dir, "scripts", "perf-budget.json"), budget(10));
    writeFileSync(join(r.dir, "CLAUDE.md"), "a rule\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "raise");
    r.git("checkout", "-q", "main");
    const g = await gate(r, [REVIEW, pass(r)]);
    expect(g.code).toBe(1);
    expect(g.j.ask).toEqual(["instructions", "limits"]);
    expect(g.j.recheck).toEqual([]);
    expect(g.j.reasons).toContain("[聞く] 検査の上限・許可リストを上げる: scripts/perf-budget.json local.journeys.launch.layoutCount: 7 → 10");
    // the limit file beside CLAUDE.md is a mix: split, and no yes lifts it, whatever kinds it names
    expect(g.j.reasons).toContainEqual(expect.stringContaining("[分ける] 指示のファイル（CLAUDE.md）とほかのファイル（scripts/perf-budget.json, src/b.ts）"));
    const yes = (kinds: string) => ({ body: `[merge-answer] yes ${kinds} ${r.tip("sb/5-x")}`, createdAt: "2026-01-04T00:00:00Z" });
    const lifted = await gate(r, [REVIEW, pass(r), yes("instructions,limits")], ["--allow-large"]);
    expect(lifted.code).toBe(1);
    expect(lifted.j.reasons.filter((x: string) => x.startsWith("[聞く]"))).toEqual([]);
  });

  describe("host files and renames, from git alone", () => {
    const HOST = ["#!/bin/sh", "set -eu", "cat > /etc/sudoers.d/x <<SUDO", "host ALL=(root) NOPASSWD: /usr/bin/true", "SUDO", "curl \"$U\" \\", "  --checksum \"$S\"", ""];
    const host = (at: number, ...add: string[]) => [...HOST.slice(0, at), ...add, ...HOST.slice(at)].join("\n");
    /** main has aws/host/bootstrap.sh and aws/auth.ts; the branch then does `change` in one commit. */
    async function changed(change: (dir: string, git: Repo["git"]) => void) {
      const r = fresh();
      mkdirSync(join(r.dir, "aws", "host"), { recursive: true });
      writeFileSync(join(r.dir, "aws", "host", "bootstrap.sh"), HOST.join("\n"));
      writeFileSync(join(r.dir, "aws", "auth.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "host");
      r.git("checkout", "-q", "sb/5-x");
      r.git("merge", "-q", "--no-edit", "main");
      change(r.dir, r.git);
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "change");
      r.git("checkout", "-q", "main");
      const g = await gate(r, [REVIEW, pass(r)]);
      return { ask: g.j.ask as string[], recheck: g.j.recheck as string[] };
    }
    const boot = (text: string) => (dir: string) => writeFileSync(join(dir, "aws", "host", "bootstrap.sh"), text);

    test("a true comment edit of a host script is the recheck; a # line in its here-document or between continued lines is asked", async () => {
      expect(await changed(boot(host(2, "# why the file is written", "")))).toEqual({ ask: [], recheck: ["security:tests"] });
      expect(await changed(boot(host(4, "#includedir /home/host/x")))).toEqual({ ask: ["security:host"], recheck: [] });
      expect(await changed(boot(host(6, "# note")))).toEqual({ ask: ["security:host"], recheck: [] });
      expect(await changed(boot(host(6, "")))).toEqual({ ask: ["security:host"], recheck: [] });
    });

    test("a mode change with a comment edit is asked", async () => {
      expect(await changed((dir) => {
        boot(host(2, "# why the file is written"))(dir);
        chmodSync(join(dir, "aws", "host", "bootstrap.sh"), 0o755);
      })).toEqual({ ask: ["security:host"], recheck: [] });
    });

    test("an instruction file under a non-ASCII directory is read by its plain path, not git's quoted one", async () => {
      const r = fresh();
      r.git("checkout", "-q", "sb/5-x");
      mkdirSync(join(r.dir, "文書"));
      writeFileSync(join(r.dir, "文書", "CLAUDE.md"), "a rule\n");
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "rules");
      r.git("checkout", "-q", "main");
      const g = await gate(r, [REVIEW, pass(r)]);
      expect(g.j.ask).toContain("instructions");
      expect(g.j.reasons).toContainEqual(expect.stringContaining("[聞く] 指示のファイル: 文書/CLAUDE.md"));
    });

    test("CLAUDE.md renamed out of an instruction path: asked and split, as on GitHub", async () => {
      const r = fresh();
      writeFileSync(join(r.dir, "CLAUDE.md"), "a rule\n");
      r.git("add", "-A");
      r.git("commit", "-q", "-m", "rules");
      r.git("checkout", "-q", "sb/5-x");
      r.git("merge", "-q", "--no-edit", "main");
      mkdirSync(join(r.dir, "docs"));
      r.git("mv", "CLAUDE.md", "docs/old-rules.md");
      r.git("commit", "-q", "-m", "move");
      r.git("checkout", "-q", "main");
      const g = await gate(r, [REVIEW, pass(r)]);
      expect(g.j.ask).toContain("instructions");
      expect(g.j.reasons).toContainEqual(expect.stringMatching(/^\[分ける\] 指示のファイル（CLAUDE\.md）とほかのファイル（.*docs\/old-rules\.md/));
    });

    test("product code renamed into a fixture path is asked by its old path (a rename is a file removed and a file added)", async () => {
      expect(await changed((dir, git) => {
        mkdirSync(join(dir, "aws", "fixtures"));
        git("mv", "aws/auth.ts", "aws/fixtures/auth.ts");
      })).toEqual({ ask: ["security:words"], recheck: ["security:tests"] });
      // a test alone is the recheck
      expect(await changed((dir) => writeFileSync(join(dir, "aws", "auth.test.ts"), "x\n"))).toEqual({ ask: [], recheck: ["security:tests"] });
    });
  });

  // A change of a GitHub workspace made while GitHub could not be used: every stop a PR gets, it gets — from the app's stored
  // Issues and git alone.
  const TASK = (body: string): Stored[] => [{ number: 4, labels: ["type:pbi"], body: "", parent: null }, { number: 5, labels: ["type:task"], body, parent: 4 }, { number: 6, labels: ["type:task"], body: "触る場所: `a.ts`", parent: 4 }];
  const CLOSES = "Closes #5";

  test("github workspace (a): reviewed, a local-ci pass, the Task names the files: merge", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r)], [], "OPEN", { github: true, body: CLOSES, issues: TASK("触る場所: `src/b.ts`") });
    expect([g.code, g.j.verdict, g.j.reasons]).toEqual([0, "merge", []]);
  });

  test("github workspace (b): a file the Task does not name stops, as a PR's does, and the stop is kept for the Task", async () => {
    const r = fresh();
    r.git("checkout", "-q", "sb/5-x");
    writeFileSync(join(r.dir, "a.ts"), "a\nmore\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "outside");
    r.git("checkout", "-q", "main");
    const g = await gate(r, [REVIEW, pass(r)], [], "OPEN", { github: true, body: CLOSES, issues: TASK("触る場所: `src/b.ts`") });
    expect(g.code).toBe(1);
    expect(g.j.reasons).toEqual(["Task #5 の本文に名指しの無いファイル: a.ts（Task #6 が名指し）"]);
    expect(g.posts).toEqual([{ path: "/api/merge-grants/scope-stop", body: { taskId: "task_1", repo: "acme/app", issue: 5, pr: 7 } }]);
  });

  test("github workspace (c): no review, no local-ci, a pass of an older head, a conflict — each stops", async () => {
    const r = fresh();
    const w = { github: true, body: CLOSES, issues: TASK("触る場所: `src/`") };
    expect((await gate(r, [pass(r)], [], "OPEN", w)).j.reasons).toEqual([expect.stringContaining("より新しい主レビュー")]);
    expect((await gate(r, [REVIEW], [], "OPEN", w)).j.reasons).toEqual(["CI のチェックが 1 つも無い"]);
    const old = { body: `[local-ci] pass ${"a".repeat(40)} base=${r.tip("main")}`, createdAt: "2026-01-03T00:00:00Z" };
    expect((await gate(r, [REVIEW, old], [], "OPEN", w)).j.reasons).toEqual(["CI のチェックが 1 つも無い", expect.stringContaining("今の head")]);
    expect((await gate(r, [REVIEW, { body: mark("fail", r), createdAt: "2026-01-03T00:00:00Z" }], [], "OPEN", w)).code).toBe(1);
    writeFileSync(join(r.dir, "src-conflict"), "x");
    mkdirSync(join(r.dir, "src"), { recursive: true });
    writeFileSync(join(r.dir, "src", "b.ts"), "other\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "main moved");
    const dirty = await gate(r, [REVIEW, pass(r)], [], "OPEN", w);
    expect(dirty.code).toBe(1);
    expect(dirty.j.reasons).toContain("mergeStateStatus が CLEAN でない: DIRTY");
  });

  test("github workspace (d): a gate file asks the person, and --allow-large without the person's yes does not lift it", async () => {
    const r = fresh();
    r.git("checkout", "-q", "sb/5-x");
    mkdirSync(join(r.dir, "scripts"));
    writeFileSync(join(r.dir, "scripts", "merge-gate.ts"), "x\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "gate");
    r.git("checkout", "-q", "main");
    const w = { github: true, body: CLOSES, issues: TASK("触る場所: `src/b.ts`、`scripts/merge-gate.ts`") };
    const g = await gate(r, [REVIEW, pass(r)], [], "OPEN", w);
    expect(g.code).toBe(1);
    expect(g.j).toMatchObject({ impact: "large", ask: ["security:gates"], reasons: [expect.stringMatching(/^\[聞く\] セキュリティ（security:gates）: scripts\/merge-gate\.ts/)] });
    const forced = await gate(r, [REVIEW, pass(r)], ["--allow-large"], "OPEN", w);
    expect(forced.code).toBe(1);
    expect(forced.j.reasons.join("\n")).toContain("[merge-answer] yes が無い: security:gates");
  });

  test("github workspace (e): a change that stands in for a PR is not merged here — its review threads cannot be read", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r)], [], "OPEN", { github: true, pr: 77, body: CLOSES, issues: TASK("触る場所: `src/b.ts`") });
    expect(g.code).toBe(1);
    expect(g.j.reasons).toEqual([expect.stringContaining("PR #77 のレビュースレッドを読めない")]);
    // and --allow-large does not lift it: it is no large reason
    expect((await gate(r, [REVIEW, pass(r)], ["--allow-large"], "OPEN", { github: true, pr: 77, body: CLOSES, issues: TASK("触る場所: `src/b.ts`") })).code).toBe(1);
  });

  test("github workspace (f): the Issue the change closes is not stored, or the app's records cannot be read: not judged, never a pass", async () => {
    const r = fresh();
    const g = await gate(r, [REVIEW, pass(r)], [], "OPEN", { github: true, body: "Closes #99", issues: TASK("x") });
    expect([g.code, g.j]).toEqual([2, null]);
    expect(g.err).toContain("#99 が保存されていない");
    const a = app(r, [REVIEW, pass(r)], "OPEN", { github: true, body: CLOSES, issues: TASK("触る場所: `src/b.ts`") });
    const down = async (url: string, init?: RequestInit) => (url.includes("/records") ? new Response("{}", { status: 500 }) : a.fetch(url, init));
    const err: string[] = [];
    expect(await main(["--change", "7"], async () => { throw new Error("gh"); }, () => {}, (s) => err.push(s), () => undefined, async () => { throw new Error("glab"); }, r.dir, { env: { BACKLOG_URL: BACKLOG, BACKLOG_WORKSPACE: "ws_local" }, fetch: down })).toBe(2);
    expect(err.join("")).toContain("判定できなかった");
  });

  test("not judged (2): not a change, a branch gone, a PR number or --repo or a merge mode with it", async () => {
    const r = fresh();
    for (const extra of [["12"], ["--repo", "a/b"], ["--merge"]]) expect((await gate(r, [REVIEW], extra)).code).toBe(2);
    const noChange = async (url: string) => new Response(JSON.stringify(url.endsWith("/api/backlog/syncs") ? { syncs: [{ workspaceId: "ws_local", backlog: "switchboard", repository: "ws_local", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] } : { issue: { number: 7, title: "x", state: "OPEN", labels: [], milestone: null, parent: null, subIssues: [], body: "", url: "" }, changeRefs: null, comments: [], fields: null, fetchedAt: 1, localId: null, pending: 0, sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } }));
    const err: string[] = [];
    expect(await main(["--change", "7"], async () => { throw new Error("gh"); }, () => {}, (s) => err.push(s), () => undefined, async () => { throw new Error("glab"); }, r.dir, { env: { BACKLOG_URL: BACKLOG, BACKLOG_WORKSPACE: "ws_local" }, fetch: noChange })).toBe(2);
    expect(err.join("")).toContain("#7 は変更ではない");
    // a branch gone: the app answers its tip as null
    const gone = async (url: string) => {
      const body = JSON.parse(await (await app(r, [REVIEW]).fetch(url)).text());
      if (body.changeRefs) body.changeRefs.head = null;
      return new Response(JSON.stringify(body));
    };
    const goneErr: string[] = [];
    expect(await main(["--change", "7"], async () => { throw new Error("gh"); }, () => {}, (s) => goneErr.push(s), () => undefined, async () => { throw new Error("glab"); }, r.dir, { env: { BACKLOG_URL: BACKLOG, BACKLOG_WORKSPACE: "ws_local" }, fetch: gone })).toBe(2);
    expect(goneErr.join("")).toContain("#7 の枝が無い（sb/5-x）");
  });
});

describe("reversibility table", () => {
  const W = mkdtempSync(join(tmpdir(), "switchboard.t3718.test."));
  afterAll(() => rmSync(W, { recursive: true, force: true }));
  const table = () => JSON.parse(require("node:fs").readFileSync(REVERSIBILITY_PATH, "utf8"));
  const write = (name: string, t: unknown) => { const p = join(W, name); writeFileSync(p, JSON.stringify(t)); return p; };

  test("derives the ask and recheck kinds from the table (the owner moved security:docs, security:tests and security:lockfile to a recheck)", () => {
    expect(ASK_KINDS).toEqual([...SECURITY_KINDS.filter((k) => !MOVED.includes(k)), "instructions", "limits"]);
    expect(RECHECK_KINDS).toEqual(["security:docs", "security:tests", "security:lockfile", "size", "responsibility", "migration", "rescue", "design-rules"]);
    expect(RECHECK_PASS.test(`[recheck] design-rules pass ${"a".repeat(40)}`)).toBe(true);
    expect(RECHECK_PASS.test(`[recheck] security:gates pass ${"a".repeat(40)}`)).toBe(false);
  });

  test("moving a kind to irreversible moves it to the ask side", () => {
    const t = table();
    t.rows.find((r: { gateKind: string }) => r.gateKind === "size").answer = "irreversible";
    const d = loadReversibility(write("size.json", t));
    expect(d.ask).toContain("size" as never);
    expect(d.recheck).not.toContain("size");
  });

  test("a table with a missing kind, an unknown answer or a repeated kind throws with the reason", () => {
    const t = table();
    t.rows = t.rows.filter((r: { gateKind: string }) => r.gateKind !== "migration");
    expect(() => loadReversibility(write("missing.json", t))).toThrow(/kinds missing: migration/);
    const u = table();
    u.rows[0].answer = "maybe";
    expect(() => loadReversibility(write("answer.json", u))).toThrow(/unknown answer "maybe"/);
    const d = table();
    d.rows.push({ ...d.rows.find((r: { gateKind: string }) => r.gateKind === "size") });
    expect(() => loadReversibility(write("dup.json", d))).toThrow(/size appears twice/);
    const a = table();
    a.answers.push("maybe");
    a.rows.find((r: { gateKind: string }) => r.gateKind === "security:docs").answer = "maybe";
    expect(() => loadReversibility(write("own-answer.json", a))).toThrow(/answers must be/);
    const e = table();
    e.effects.push("weather");
    e.rows[0].effect = "weather";
    expect(() => loadReversibility(write("own-effect.json", e))).toThrow(/effects must be/);
  });
});
