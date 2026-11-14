import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentRepo, originRepo } from "./repo.ts";
import { LOCAL_CI_RESULT, sh } from "./local-ci";
import { forgeTargetOf, originOf, type ForgeTarget } from "../ops-kit/src/forge.ts";
import { mergeGitlabMr, readGitlabMerge, runGlab, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { linkedIssues, overlaps, scopeIn } from "./task-paths.ts";
import { runBacklog, type Detail } from "../ops-kit/src/backlog-client.ts";

export const LARGE_LINES = 300;

export const PROTECTED = [
  "rescue/**",
  ".github/**",
  "packages/core/src/db.ts",
  "packages/core/src/schema-baseline.json",
  "packages/core/src/auth.ts",
  "packages/core/src/approval.ts",
  "packages/core/src/selfdev.ts",
  "packages/core/config/**",
  "scripts/setup/**",
  ".claude/skills/**",
  "ops-kit/skills/**",
  "package.json",
  "bun.lock",
].map((p) => new Bun.Glob(p));

/**
 * Rules for any repository (--repo too): a PR touching one of these is large whatever its size, with the class as the reason (#563).
 * Security: a path word (split at / . _ -, lower-cased) in SECURITY_WORDS, or a path of SECURITY_GROUPS (CI and repository
 * settings, lock files — adding a dependency changes the lock —, the gates, the host scripts) or SECURITY_WORD_FILES (secrets
 * files). Responsibility: design rules, design docs, agent instructions and operating settings; README.md's
 * `## Design rules` section is judged per line (designRulesTouched).
 */
export const SECURITY_WORDS = ["auth", "approval", "permission", "permissions", "secret", "secrets", "credential", "credentials", "token", "tokens", "crypto", "sandbox"];
/**
 * The security reason split by the group of paths it met (PBI #1873), so the asks and answers count per group and a group
 * the user approves can move to a recheck later. docs: a document only (decided before the others, alone); words: a path
 * word or a secrets file; the rest: SECURITY_GROUPS. A path in two groups is in both (a yes for one does not lift the other).
 */
export const SECURITY_KINDS = ["security:docs", "security:words", "security:lockfile", "security:github", "security:gates", "security:host"] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];
const glob = (ps: string[]) => ps.map((p) => new Bun.Glob(p));
/** Secrets files: in the words group (they hold the secrets the words name). */
const SECURITY_WORD_FILES = glob(["**/.env*", "**/.gitleaks.toml"]);
export const SECURITY_GROUPS: Record<Exclude<SecurityKind, "security:docs" | "security:words">, Bun.Glob[]> = {
  "security:lockfile": glob(["**/{bun.lock,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,go.sum,Cargo.lock}", "**/requirements*.txt"]),
  "security:github": glob([".github/**"]),
  // the gate and local CI decide merges like CI does, local-merge makes them (#2489) and forge-resync pushes main (#2705):
  // a small change to them is still the user's to approve (#751)
  "security:gates": glob(["scripts/merge-gate.ts", "ops-kit/reversibility.json", "scripts/local-ci.ts", "scripts/local-merge.ts", "scripts/forge-resync.ts"]),
  // Switchboard's own (a --repo without aws/host never meets it): the cloud host runs main's host scripts as root at
  // every start (sb-host-update, #435)
  "security:host": glob(["aws/host/**"]),
};
/**
 * Documents that instruct the Task (skills, CLAUDE.md, AGENTS.md) are not security:docs: they decide what a Task does. Nor is
 * a .md under .github (the PR and Issue templates are inputs of the development, and GitHub reads them as settings).
 */
const INSTRUCTIONS = glob([".claude/skills/**", "ops-kit/skills/**", "**/CLAUDE.md", "**/AGENTS.md", ".github/**"]);
const HOST_ROOT_NOTE = "（aws/host は起動のたびに root が main から入れて走らせる。root で走る範囲が増えるなら #852 の見直しの契機: docs/design/cloud-hosting.md §6.5）";
// Design documents are not here: they do not decide what a Task does, and a PR fixes them with the change, so they would
// match nearly every PR. Whether a PBI's scope holds for them is the main review's (cross-runner-review).
export const RESPONSIBILITY = [
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "ops.config.json",
  ".claude/skills/**",
  "ops-kit/skills/**",
].map((p) => new Bun.Glob(p));
const DESIGN_RULES = "README.md の ## Design rules";

/**
 * Two kinds of large reason (#751). Ask: only the user lifts it (--allow-large) — the security groups the table answers
 * irreversible. Recheck: a `[recheck] <kind> pass <head sha>` PR comment lifts it, per kind (size: line count and the other
 * protected paths; responsibility: the other responsibility files; migration: MIGRATION; rescue: RESCUE, the rollback itself;
 * design-rules: README.md's Design rules; security:docs and security:lockfile: the security groups the owner moved to a
 * recheck, docs/design/merge-gate.md).
 */
export type RecheckKind = "size" | "responsibility" | "migration" | "rescue" | "design-rules" | "security:docs" | "security:lockfile";
export type AskKind = SecurityKind;
/** The words of the record marks (#752), in this order: who lifted which kind of a large PR. */
export const MERGE_KINDS = [...SECURITY_KINDS, "rescue", "design-rules", "size", "responsibility", "migration"] as const;
export type MergeKind = (typeof MERGE_KINDS)[number];

/**
 * The split into ask and recheck comes from the reversibility table (ops-kit/reversibility.json, docs/design/process-kernel.md K3):
 * a gateKind whose answer is `irreversible` is asked of the user, any other is lifted by a recheck. The globs stay here.
 * Throws, with the reason, on a table of the wrong shape (unknown effect or answer, a repeated or missing kind).
 */
export const REVERSIBILITY_PATH = join(import.meta.dir, "..", "ops-kit", "reversibility.json");
/** The fixed vocabulary of the table: the file must list exactly these, so a table cannot widen its own words. */
const EFFECTS = ["repository", "state", "external", "person"];
const ANSWERS = ["reversible", "compensable", "irreversible"];
export function loadReversibility(path = REVERSIBILITY_PATH): { ask: AskKind[]; recheck: RecheckKind[] } {
  const t = JSON.parse(readFileSync(path, "utf8"));
  const bad = (m: string): never => { throw new Error(`reversibility table ${path}: ${m}`); };
  if (t?.v !== 1 || !Array.isArray(t.effects) || !Array.isArray(t.answers) || !Array.isArray(t.rows)) bad("expected { v: 1, effects, answers, rows }");
  if (JSON.stringify(t.effects) !== JSON.stringify(EFFECTS)) bad(`effects must be ${JSON.stringify(EFFECTS)}`);
  if (JSON.stringify(t.answers) !== JSON.stringify(ANSWERS)) bad(`answers must be ${JSON.stringify(ANSWERS)}`);
  const ask: string[] = [];
  const recheck: string[] = [];
  const seen = new Set<string>();
  for (const row of t.rows) {
    if (!t.effects.includes(row.effect)) bad(`unknown effect ${JSON.stringify(row.effect)} in "${row.op}"`);
    if (!t.answers.includes(row.answer)) bad(`unknown answer ${JSON.stringify(row.answer)} in "${row.op}"`);
    if (row.gateKind == null) continue;
    if (seen.has(row.gateKind)) bad(`kind ${row.gateKind} appears twice`);
    seen.add(row.gateKind);
    (row.answer === "irreversible" ? ask : recheck).push(row.gateKind);
  }
  const missing = MERGE_KINDS.filter((k) => !seen.has(k));
  if (missing.length) bad(`kinds missing: ${missing.join(", ")}`);
  const unknown = [...seen].filter((k) => !(MERGE_KINDS as readonly string[]).includes(k));
  if (unknown.length) bad(`unknown kinds: ${unknown.join(", ")}`);
  return { ask: ask as AskKind[], recheck: recheck as RecheckKind[] };
}
const REVERSIBILITY = loadReversibility();
export const RECHECK_KINDS: RecheckKind[] = REVERSIBILITY.recheck;
export const ASK_KINDS: AskKind[] = REVERSIBILITY.ask;
export const RECHECK_PASS = new RegExp(`^\\[recheck\\] (${RECHECK_KINDS.join("|")}) pass ([0-9a-f]{40})\\b`);
/**
 * Record marks for the user's side (#761; the recheck side is RECHECK_PASS): asked with `[merge-ask] <kinds> <head sha>`,
 * answered with `[merge-answer] <yes|no> <kinds> <head sha>` (kinds comma-separated; the comment's createdAt is the time).
 * merge-audit reads them; `[merge-answer] yes` is what --allow-large needs to take effect (judge).
 */
export const MERGE_ASK = /^\[merge-ask\] ([a-z:-]+(?:,[a-z:-]+)*) ([0-9a-f]{40})\b/;
export const MERGE_ANSWER = /^\[merge-answer\] (yes|no) ([a-z:-]+(?:,[a-z:-]+)*) ([0-9a-f]{40})\b/;
export const RESCUE = ["rescue/**"].map((p) => new Bun.Glob(p));
export const MIGRATION = ["packages/core/src/db.ts", "packages/core/src/schema-baseline.json"].map((p) => new Bun.Glob(p));
const DESIGN_RULES_HEADING = /^## Design rules[ \t]*$/m;

const TESTS = ["**/*.test.ts", "scripts/*-e2e.ts"].map((p) => new Bun.Glob(p));
const DOCS = ["docs/**", "**/*.md"].map((p) => new Bun.Glob(p));
export const REVIEW = /^\[(codex|claude)\] review/;
/** Only these comment authors' marks count (review, [local-ci], [recheck]): on a public --repo anyone can comment. */
export const MARK_AUTHORS = ["OWNER", "MEMBER", "COLLABORATOR"];

export interface PrFacts {
  files: { path: string; additions: number; deletions: number }[];
  // Newest author date: a rebase keeps it, a new fix commit moves it.
  headCommittedAt: string;
  checks: { name: string; conclusion: string }[];
  /** README.md's `## Design rules` section changed (designRulesTouched); absent = not. */
  designRulesTouched?: boolean;
  /** A CI run that never started, or none, was replaced by the local pass of the head and the base's tip (#914); GitHub still calls the PR UNSTABLE for a failed run. */
  localCi?: boolean;
  /** Why the PR's local-ci results did not count (an older base, a newer fail); absent = none, or one counted. */
  localCiNote?: string;
  /** The kinds with a `[recheck] <kind> pass <head sha>` of the head; absent = none. */
  rechecks?: RecheckKind[];
  unresolvedThreads: number;
  mergeState: string;
  reviewComments: { body: string; createdAt: string }[];
  /** The head's sha (a `[merge-answer] yes` must name it for --allow-large; --merge merges only this head); absent = not read. */
  head?: string;
  /** The base branch (--merge-stack merges only a PR on the default branch: the bottom of its stack); absent = not read. */
  base?: string;
  /** The Tasks the PR closes: the paths their bodies name, and what the other Tasks of their PBIs name; absent = the PR closes no Task. */
  task?: { numbers: number[]; named: string[]; siblings: { number: number; paths: string[] }[] };
}

export interface Judgement {
  verdict: "merge" | "stop";
  impact: "small" | "large";
  reasons: string[];
  /** The ask kinds among the large reasons (kept with --allow-large: what the user's yes lifted). */
  ask: AskKind[];
  /** The recheck kinds among the large reasons that have no mark of the head yet. */
  recheck: RecheckKind[];
  /** What was not checked: it does not stop the merge. Absent = nothing. */
  notes?: string[];
}

const matches = (globs: Bun.Glob[], path: string) => globs.some((g) => g.match(path));

/** The security groups of a path (PBI #1873); empty = not security. A document that is not an instruction is security:docs alone. */
export function securityKinds(path: string): SecurityKind[] {
  const words = matches(SECURITY_WORD_FILES, path) || path.toLowerCase().split(/[\/._-]/).some((w) => SECURITY_WORDS.includes(w));
  const groups = (Object.keys(SECURITY_GROUPS) as (keyof typeof SECURITY_GROUPS)[]).filter((k) => matches(SECURITY_GROUPS[k], path));
  if (!words && groups.length === 0) return [];
  if (matches(DOCS, path) && !matches(INSTRUCTIONS, path)) return ["security:docs"];
  return [...(words ? ["security:words" as const] : []), ...groups];
}

export function classify(path: string): "security" | "responsibility" | null {
  if (securityKinds(path).length > 0) return "security";
  if (matches(RESPONSIBILITY, path)) return "responsibility";
  return null;
}

/**
 * Whether a unified diff of README.md deletes or changes a line of the base README's `## Design rules` section (the heading
 * to the line before the next `## `), or adds a line inside it. No such heading → false (the rest of a README is not a rule).
 */
export function designRulesTouched(readme: string, patch: string): boolean {
  const lines = readme.split("\n");
  const at = lines.findIndex((l) => DESIGN_RULES_HEADING.test(l));
  if (at < 0) return false;
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  const first = at + 1;
  const last = next < 0 ? lines.length : next; // 1-based: the line before the next heading
  let old = 0;
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(l);
    if (hunk) {
      old = hunk[2] === "0" ? Number(hunk[1]) + 1 : Number(hunk[1]); // -a,0: the lines are added after old line a
      continue;
    }
    if (l.startsWith("-")) {
      if (old >= first && old <= last) return true;
      old++;
    } else if (l.startsWith("+")) {
      if (old - 1 >= first && old - 1 <= last) return true; // added after old line old-1
    } else if (l.startsWith(" ")) old++;
  }
  return false;
}

function countsTowardSize(path: string): boolean {
  if (matches(TESTS, path)) return false;
  if (path.startsWith(".claude/skills/") || path.startsWith("ops-kit/skills/")) return true;
  return !matches(DOCS, path);
}

/** The Task-scope reason, or the note that it could not be checked (#2498). The files of the PR no path of its Tasks covers, in the PR's order. */
function taskScope(f: PrFacts): { reason?: string; note?: string } {
  if (!f.task) return {};
  const { numbers, named, siblings } = f.task;
  const tasks = numbers.map((n) => `#${n}`).join(", ");
  if (named.length === 0) return { note: `Task ${tasks} の本文からパスが読めない（範囲の検査をしていない）` };
  const outside = f.files.map((x) => x.path).filter((p) => !named.some((q) => overlaps(p, q)));
  if (outside.length === 0) return {};
  const owners = (p: string) => siblings.filter((s) => s.paths.some((q) => overlaps(p, q))).map((s) => s.number).sort((a, b) => a - b);
  const listed = outside.map((p) => {
    const by = owners(p);
    return by.length > 0 ? `${p}（${by.map((n) => `Task #${n}`).join("、")} が名指し）` : p;
  });
  return { reason: `Task ${tasks} の本文に名指しの無いファイル: ${listed.join(", ")}` };
}

/** --allow-large lifts the large reasons only with a `[merge-answer] yes` of the head that names every kind left. */
export function judge(f: PrFacts, opts: { allowLarge: boolean }): Judgement {
  const large: { kind: RecheckKind | AskKind; text: string }[] = [];
  const add = (kind: RecheckKind | AskKind, head: string, paths: string[], note = "") => {
    if (paths.length > 0) large.push({ kind, text: `${head}: ${paths.join(", ")}${note}` });
  };
  const lines = f.files
    .filter((x) => countsTowardSize(x.path))
    .reduce((n, x) => n + x.additions + x.deletions, 0);
  if (lines > LARGE_LINES) {
    large.push({ kind: "size", text: `テストと docs を除いた変更が ${lines} 行で、${LARGE_LINES} 行を超えている` });
  }
  const paths = f.files.map((x) => x.path);
  // rescue is its own kind whatever else its file is (rescue/CLAUDE.md too); a security file there says セキュリティ instead
  const rescue = (p: string) => classify(p) !== "security" && matches(RESCUE, p);
  const touched = paths.filter((p) => classify(p) === null && matches(PROTECTED, p) && !rescue(p));
  for (const kind of SECURITY_KINDS) {
    add(kind, `セキュリティ（${kind}）`, paths.filter((p) => securityKinds(p).includes(kind)), kind === "security:host" ? HOST_ROOT_NOTE : "");
  }
  add("rescue", "rescue", paths.filter(rescue));
  add("design-rules", "責務", f.designRulesTouched ? [DESIGN_RULES] : []);
  add("responsibility", "責務", paths.filter((p) => classify(p) === "responsibility" && !rescue(p)));
  add("migration", "保護するパスに触れている", touched.filter((p) => matches(MIGRATION, p)));
  add("size", "保護するパスに触れている", touched.filter((p) => !matches(MIGRATION, p)));
  const impact = large.length > 0 ? "large" : "small";
  const marked = new Set(f.rechecks ?? []);
  const recheck = RECHECK_KINDS.filter((k) => !marked.has(k) && large.some((l) => l.kind === k));
  const ask = ASK_KINDS.filter((k) => large.some((l) => l.kind === k));
  const isAsk = (k: RecheckKind | AskKind): k is AskKind => (ASK_KINDS as string[]).includes(k);

  // the last answer of this head decides (a later no takes the yes back); a yes must name every kind left (a yes about
  // size does not lift a security reason)
  const left = [...ask, ...recheck];
  const answer = f.reviewComments.map((c) => ({ at: Date.parse(c.createdAt), m: MERGE_ANSWER.exec(c.body) })).filter((a) => a.m?.[3] === f.head).sort((a, b) => a.at - b.at).at(-1)?.m;
  const lifted = opts.allowLarge && (left.length === 0 || (answer?.[1] === "yes" && left.every((k) => answer[2]!.split(",").includes(k))));
  const reasons = lifted
    ? []
    : large
      .filter((l) => isAsk(l.kind) || !marked.has(l.kind))
      .map((l) => `${isAsk(l.kind) ? "[聞く]" : `[再チェック ${l.kind}]`} ${l.text}`);
  if (opts.allowLarge && !lifted) reasons.push(`[merge-answer] yes が無い: ${left.join(",")}（--allow-large は head の最後の印が yes で ask と recheck を全部含むときだけ効く）`);
  const scope = taskScope(f);
  if (scope.reason) reasons.push(scope.reason);
  if (f.checks.length === 0) reasons.push("CI のチェックが 1 つも無い");
  for (const c of f.checks) {
    if (c.conclusion !== "SUCCESS" && c.conclusion !== "SKIPPED") {
      reasons.push(`CI のチェック ${c.name} が ${c.conclusion || "未完了"}`);
    }
  }
  if (f.localCiNote && reasons.some((r) => r.startsWith("CI のチェック"))) reasons.push(f.localCiNote);
  if (f.unresolvedThreads > 0) reasons.push(`解決していないレビュースレッドが ${f.unresolvedThreads} 件ある`);
  const head = Date.parse(f.headCommittedAt);
  if (!f.reviewComments.some((c) => REVIEW.test(c.body) && Date.parse(c.createdAt) > head)) {
    reasons.push(`最後のコミット（${f.headCommittedAt}）より新しい主レビュー（[codex] review / [claude] review）が無い`);
  }
  const unstableForLocalCi = f.mergeState === "UNSTABLE" && f.localCi === true;
  if (f.mergeState === "BLOCKED" && f.localCi) {
    // the local pass is a PR comment: a required status check or review of the base branch is not met by it (#914)
    reasons.push(`mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果は PR コメントで、GitHub の必須チェックにはならない（${PROTECTION_DOC}）`);
  } else if (f.mergeState !== "CLEAN" && !unstableForLocalCi) reasons.push(`mergeStateStatus が CLEAN でない: ${f.mergeState}`);

  return { verdict: reasons.length === 0 ? "merge" : "stop", impact, reasons, ask, recheck, ...(scope.note ? { notes: [scope.note] } : {}) };
}

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${err.trim()}`);
  return out;
}

interface WorkflowRun { id: number; name: string; status: string; conclusion: string | null; created_at: string }

/**
 * CI = the Actions workflow runs of the head commit, the newest per workflow (a later run of the same workflow on the same
 * commit, e.g. after the PR is closed and reopened, wins; a re-run keeps its run and only updates its status and conclusion).
 * Not statusCheckRollup: it includes check runs, which need Checks — a permission a fine-grained token cannot have (#381).
 */
function newestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const newest = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const had = newest.get(r.name);
    if (!had || r.created_at > had.created_at || (r.created_at === had.created_at && r.id > had.id)) newest.set(r.name, r);
  }
  return [...newest.values()];
}

const toCheck = (r: WorkflowRun) => ({ name: r.name, conclusion: r.status === "completed" ? (r.conclusion ?? "").toUpperCase() : "" });

export function checksFromRuns(runs: WorkflowRun[]): PrFacts["checks"] {
  return newestRuns(runs).map(toCheck);
}

/**
 * When Actions does not start (billing: the job fails with no steps and no runner, or the run stays queued), or there is no run at all, the local
 * pass of `bun scripts/local-ci.ts` counts as the CI's success (#387, #914). Only for a run that never started (a CI
 * whose tests really failed still stops the merge) and only when the newest result of the stack's top is a pass whose
 * head has this PR's commits as they are now, by `git cherry` (`localCiOf`, #2940, #3118).
 */
const LOCAL_CI_SUFFIX = "（Actions が始まらず、ローカルで pass）";
const LOCAL_CI_ONLY = "local-ci（Actions の run が無く、ローカルで pass）";
const PROTECTION_DOC = "docs/merge-gate.md の「Branch protection and local results」";

/**
 * The top of `n`'s stack (#2940): up by the one open PR whose base is this one's head branch. None or two above → here.
 * gh stack's tracking is a catalog local to one clone (`<common-dir>/gh-stack`), and GitHub's API has no stack, so the PRs' branches are what is read.
 */
export async function stackTop(n: number, headRefName: string, run: (args: string[]) => Promise<string>, repo: string): Promise<number> {
  const seen = new Set([n]);
  for (let top = n, ref = headRefName; ;) {
    const above = JSON.parse(await run(["pr", "list", "-R", repo, "--base", ref, "--state", "open", "--json", "number,headRefName"])) as Array<{ number: number; headRefName: string }>;
    if (!Array.isArray(above) || above.length !== 1 || seen.has(above[0]!.number)) return top;
    top = above[0]!.number;
    ref = above[0]!.headRefName;
    seen.add(top);
  }
}

/** The newest `[local-ci]` result among comments already filtered to MARK_AUTHORS. local-ci's reuse reads the same one (#1882). */
export function newestLocalCi<C extends { body: string; createdAt: string }>(comments: C[]): { c: C; m: RegExpExecArray } | undefined {
  return comments
    .map((c) => ({ c, m: LOCAL_CI_RESULT.exec(c.body), at: Date.parse(c.createdAt) }))
    .filter((x): x is { c: C; m: RegExpExecArray; at: number } => x.m !== null)
    .sort((a, b) => a.at - b.at)
    .at(-1);
}

/**
 * Whether the newest local-ci result of the stack's top `top` (this PR itself when alone) is a pass whose head has this
 * PR's commits as they are now (`covered`, by `git cherry`: `inPass`); else why not (#2940, #3118). Only the first line
 * (`LOCAL_CI_RESULT`) is read, so another repository's copy of local-ci counts as it writes it. The base's tip is not
 * compared: a conflict with another PR is mergeStateStatus's, a fault of two PRs together the tag CI's.
 */
export async function localCiOf(n: number, top: number, comments: { body: string; createdAt: string }[], run: (args: string[]) => Promise<string>, repo: string, covered: (passHead: string) => Promise<boolean>): Promise<{ pass: boolean; note?: string }> {
  const ofTop = top === n ? comments : (JSON.parse(await run(["pr", "view", String(top), "-R", repo, "--json", "comments"])).comments as Array<{ body: string; createdAt: string; authorAssociation?: string }>)
    .filter((c) => MARK_AUTHORS.includes(c.authorAssociation ?? ""));
  const newest = newestLocalCi(ofTop);
  if (!newest) return { pass: false };
  if (newest.m![1] !== "pass") return { pass: false, note: `一番上の PR #${top} の local-ci の最新が fail` };
  const passHead = newest.m![2]!;
  if (!await covered(passHead)) return { pass: false, note: `この PR のコミットが #${top} の pass（${passHead.slice(0, 7)}）に同じ差分で入っていない（一番上で回し直す）` };
  return { pass: true };
}

/**
 * Whether every commit of the PR now (from its merge-base with the base's tip to its head) is in the pass's head's history
 * with the same diff: `git cherry` prints no `+` line (#3118), and every merge commit among them (which git cherry skips) is
 * in that history as is. GitHub's rebase after a merge below keeps each commit's diff; a fix commit or a conflict
 * resolution that changes one does not. The three commits are fetched from `url` into `root`
 * without writing a ref. Not a worktree or a failed fetch throws: no judgement (exit 2).
 */
export async function inPass(git: { root: string; url: string }, passHead: string, prHead: string, baseTip: string): Promise<boolean> {
  const at = ["git", "-C", git.root];
  await sh([...at, "rev-parse", "--git-dir"]).catch(() => { throw new Error("git の作業ツリーでない（判定に要るコミットを取れない）"); });
  await sh([...at, "fetch", "-q", "--no-tags", "--no-write-fetch-head", git.url, passHead, prHead, baseTip])
    .catch(() => { throw new Error(`${[passHead, prHead, baseTip].map((x) => x.slice(0, 7)).join(" / ")} を fetch できない（通信か、一番上で回し直す）`); });
  const mergeBase = (await sh([...at, "merge-base", baseTip, prHead])).trim();
  if ((await sh([...at, "cherry", passHead, prHead, mergeBase])).split("\n").some((l) => l.startsWith("+ "))) return false;
  // git cherry skips merge commits: one in the PR (a conflict resolved in it) counts only when the pass's head has it as is
  for (const m of (await sh([...at, "rev-list", "--merges", `${mergeBase}..${prHead}`])).split("\n").filter(Boolean)) {
    if (!await sh([...at, "merge-base", "--is-ancestor", m, passHead]).then(() => true, () => false)) return false;
  }
  return true;
}

async function checksWithLocalCi(runs: WorkflowRun[], localPass: boolean, run: (args: string[]) => Promise<string>, repo: string): Promise<PrFacts["checks"]> {
  // every run skipped = CI ran nowhere (a job behind <PREFIX>_ACTIONS without the variable): the same as no run, not a pass
  const ran = newestRuns(runs).some((r) => toCheck(r).conclusion !== "SKIPPED");
  if (!ran) return localPass ? [{ name: LOCAL_CI_ONLY, conclusion: "SUCCESS" }] : [];
  const checks: PrFacts["checks"] = [];
  for (const r of newestRuns(runs)) {
    const c = toCheck(r);
    // a run still queued (or waiting) has not started: with the local pass it counts like a run that never started
    if (localPass && ["queued", "waiting", "requested", "pending"].includes(r.status)) {
      checks.push({ name: `${r.name}${LOCAL_CI_SUFFIX}`, conclusion: "SUCCESS" });
      continue;
    }
    if (localPass && c.conclusion === "FAILURE") {
      const jobs = JSON.parse(await run(["api", `repos/${repo}/actions/runs/${r.id}/jobs`])).jobs as Array<{ steps?: unknown[] }>;
      if (jobs.length > 0 && jobs.every((j) => (j.steps ?? []).length === 0)) {
        checks.push({ name: `${r.name}${LOCAL_CI_SUFFIX}`, conclusion: "SUCCESS" });
        continue;
      }
    }
    checks.push(c);
  }
  return checks;
}

/**
 * The README at the merge base (the PR's diff is against it, not the base branch's tip) and the PR's README.md patch.
 * GitHub leaves the patch out of a very large diff; then a section that is there cannot be ruled out, so it counts as touched.
 */
async function readmeDesignRulesTouched(n: number, run: (args: string[]) => Promise<string>, repo: string, base: string, head: string): Promise<boolean> {
  const mergeBase = (await run(["api", `repos/${repo}/compare/${base}...${head}`, "-q", ".merge_base_commit.sha"])).trim();
  const readme = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/README.md?ref=${mergeBase}`]);
  if (!DESIGN_RULES_HEADING.test(readme)) return false; // the rest of a README is not a rule, whatever the patch
  const file = (await run(["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`, "-q", '.[] | select(.filename == "README.md")'])).trim();
  const patch: string | undefined = file ? JSON.parse(file).patch : undefined;
  return patch === undefined ? true : designRulesTouched(readme, patch);
}

const TASK_LABEL = "type:task";
const BACKLOG_TASK = /^Backlog-Task: \d+\s*$/im;
const ISSUE_QUERY = "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ number body labels(first:20){nodes{name}} parent{ subIssues(first:100){ nodes{ number body labels(first:20){nodes{name}} } } } } } }";

interface TaskIssue { number: number; body: string; labels: { nodes: { name: string }[] } }
const isTask = (i: TaskIssue) => i.labels.nodes.some((l) => l.name === TASK_LABEL);

/**
 * The Tasks a PR closes, read from GitHub's Issues (#2498; not the stored backlog, #909). `Backlog-Task:` names an Issue of
 * the app only, which GitHub does not have. `files`: a path a PR adds at the top of the tree still starts a path (as readOthers).
 */
async function readTask(pr: { body: string | null; headRefName: string | null }, files: string[], run: (args: string[]) => Promise<string>, repo: string): Promise<PrFacts["task"]> {
  if (BACKLOG_TASK.test(pr.body ?? "")) return undefined;
  const [owner, name] = repo.split("/");
  const issues: (TaskIssue & { parent: { subIssues: { nodes: TaskIssue[] } } | null })[] = [];
  for (const n of new Set(linkedIssues(pr))) {
    const out = await run(["api", "graphql", "-f", `query=${ISSUE_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`]);
    issues.push(JSON.parse(out).data.repository.issue);
  }
  const tasks = issues.filter(isTask);
  if (tasks.length === 0) return undefined;
  const top: { name: string; dir: boolean }[] = (JSON.parse(await run(["api", `repos/${repo}/contents`])) as { name: string; type: string }[])
    .map((e) => ({ name: e.name, dir: e.type === "dir" }));
  for (const f of files) {
    const [head, ...more] = f.split("/");
    if (!top.some((t) => t.name === head)) top.push({ name: head!, dir: more.length > 0 });
  }
  const numbers = tasks.map((t) => t.number);
  const others = new Map(tasks.flatMap((t) => t.parent?.subIssues.nodes ?? []).filter((s) => isTask(s) && !numbers.includes(s.number)).map((s) => [s.number, s]));
  return {
    numbers,
    named: [...new Set(tasks.flatMap((t) => scopeIn(t.body, top)))],
    siblings: [...others.values()].map((s) => ({ number: s.number, paths: scopeIn(s.body, top) })),
  };
}

/**
 * `repo`: owner/name; another repository's backlog stage Task passes its own with --repo (the rules stay these).
 * `git`: where `inPass` fetches the commits to (`root`, a git worktree) and from (`url`, the repository's own, even when
 * the worktree's origin is another: --repo).
 */
export async function readPr(n: number, run = gh, repo = currentRepo(), git = { root: process.cwd(), url: `https://github.com/${repo}.git` }): Promise<PrFacts> {
  const [owner, name] = repo.split("/");
  const pr = JSON.parse(
    await run(["pr", "view", String(n), "-R", repo, "--json", "body,files,commits,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,comments"]),
  );
  // GitHub has not worked it out yet (just after a push or a base change): nothing to judge by
  if (pr.mergeStateStatus === "UNKNOWN") throw new Error("mergeStateStatus が UNKNOWN（GitHub が計算中。少し待ってやり直す）");
  const comments: { body: string; createdAt: string }[] = pr.comments.filter((c: { authorAssociation?: string }) => MARK_AUTHORS.includes(c.authorAssociation ?? ""));
  const rules = pr.files.some((x: { path: string; changeType?: string }) => x.path === "README.md" && x.changeType !== "ADDED")
    && await readmeDesignRulesTouched(n, run, repo, pr.baseRefOid, pr.headRefOid);
  const runs = JSON.parse(await run(["api", `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`]));
  const threads = JSON.parse(
    await run([
      "api", "graphql",
      "-f", "query=query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ totalCount nodes{ isResolved } } } } }",
      "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`, // -f: a name like "123" or "true" stays a String (-F would type it)
    ]),
  ).data.repository.pullRequest.reviewThreads;
  if (threads.totalCount > threads.nodes.length) {
    throw new Error(`レビュースレッドが ${threads.totalCount} 件あり、1 ページ（${threads.nodes.length} 件）で読み切れない`);
  }
  const local = await localCiOf(n, await stackTop(n, pr.headRefName, run, repo), comments, run, repo, (passHead) => inPass(git, passHead, pr.headRefOid, pr.baseRefOid));
  const checks = await checksWithLocalCi(runs.workflow_runs, local.pass, run, repo);
  const rechecks = RECHECK_KINDS.filter((k) =>
    comments.some((c) => {
      const m = RECHECK_PASS.exec(c.body);
      return m?.[1] === k && m[2] === pr.headRefOid;
    }));
  const authored: string[] = pr.commits.map((c: { authoredDate: string }) => c.authoredDate);
  const task = await readTask(pr, pr.files.map((x: { path: string }) => x.path), run, repo);
  return {
    files: pr.files.map((x: PrFacts["files"][number]) => ({ path: x.path, additions: x.additions, deletions: x.deletions })),
    headCommittedAt: authored.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
    checks,
    ...(rules ? { designRulesTouched: true } : {}),
    ...(checks.some((c) => c.name.endsWith(LOCAL_CI_SUFFIX) || c.name === LOCAL_CI_ONLY) ? { localCi: true } : {}),
    ...(local.note ? { localCiNote: local.note } : {}),
    ...(rechecks.length > 0 ? { rechecks } : {}),
    unresolvedThreads: threads.nodes.filter((t: { isResolved: boolean }) => !t.isResolved).length,
    mergeState: pr.mergeStateStatus,
    reviewComments: comments.map((c) => ({ body: c.body, createdAt: c.createdAt })),
    head: pr.headRefOid,
    base: pr.baseRefName,
    ...(task ? { task } : {}),
  };
}

/** A local change as `ops-kit backlog view --json` reads it (#2487): the stored change and its branch tips now. */
export type ChangeDetail = Detail & { issue: Detail["issue"] & { change: NonNullable<Detail["issue"]["change"]> }; changeRefs: { head: string | null; base: string | null } };

/**
 * A local change (`--change <n>`, #2487) from the app (`ops-kit backlog view <n> --json`: BACKLOG_URL and
 * BACKLOG_WORKSPACE, as the kit picks the workspace) — what a GitHub PR's view gives otherwise. Not a change, a branch
 * gone or the app not answering throws: no judgement (exit 2).
 */
export async function readChangeDetail(n: number, env: Record<string, string | undefined>, opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; cwd?: string } = {}): Promise<ChangeDetail> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBacklog(["view", String(n), "--json"], env, { out: (s) => out.push(s), err: (s) => err.push(s) }, opts);
  if (code !== 0) throw new Error(`#${n} を読めない: ${err.join(" ").trim() || `exit ${code}`}`);
  const d = JSON.parse(out.join("\n")) as Detail;
  if (!d.issue.change) throw new Error(`#${n} は変更ではない`);
  if (!d.changeRefs?.head || !d.changeRefs.base) throw new Error(`#${n} の枝が無い（${!d.changeRefs?.head ? d.issue.change.head : d.issue.change.base}）`);
  return d as ChangeDetail;
}

/**
 * The newest `[local-ci]` result of a local change (#2487) counts only for its head and its base's tip now: there is no
 * tag CI after the merge to catch a fault of two changes together, so a base that moved runs it again.
 */
export function localCiOfChange(comments: { body: string; createdAt: string }[], head: string, baseTip: string): { pass: boolean; note?: string } {
  const newest = newestLocalCi(comments);
  if (!newest) return { pass: false };
  const [, result, passHead, passBase] = newest.m;
  if (result !== "pass") return { pass: false, note: "local-ci の最新が fail" };
  if (passHead !== head) return { pass: false, note: `local-ci の pass（${passHead!.slice(0, 7)}）は今の head（${head.slice(0, 7)}）のものでない（回し直す）` };
  if (passBase !== baseTip) return { pass: false, note: `local-ci の pass の base（${passBase!.slice(0, 7)}）が今の base の先端（${baseTip.slice(0, 7)}）でない（回し直す）` };
  return { pass: true };
}

export const LOCAL_CHANGE_CI = "local-ci（ローカルで pass）";

/**
 * The facts of a local change (#2487) from the app and the checkout `root` (its own git; nothing is fetched, gh is not
 * called): the same PrFacts readPr gives a PR, judged by the same `judge`. No review threads (findings and their triage
 * are comments); every comment counts (only the app's API writes them: the person and their Tasks, trusted on loopback).
 */
export async function readChange(d: ChangeDetail, root: string): Promise<PrFacts> {
  const git = (...args: string[]) => sh(["git", "-C", root, ...args]);
  const { head, base } = d.changeRefs as { head: string; base: string };
  const range = `${base}...${head}`;
  const files = (await git("diff", "--numstat", "--no-renames", range)).split("\n").filter(Boolean).map((l) => {
    const [add, del, ...path] = l.split("\t");
    // a binary file is "-": no lines
    return { path: path.join("\t"), additions: Number(add) || 0, deletions: Number(del) || 0 };
  });
  const dates = (await git("log", "--format=%aI", `${base}..${head}`)).split("\n").filter(Boolean);
  const headCommittedAt = dates.length ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : (await git("log", "-1", "--format=%aI", head)).trim();
  const comments = d.comments.map((c) => ({ body: c.body, createdAt: c.createdAt }));
  const local = localCiOfChange(comments, head, base);
  let rules = false;
  if (files.some((f) => f.path === "README.md")) {
    const mergeBase = (await git("merge-base", base, head)).trim();
    const readme = await git("show", `${mergeBase}:README.md`).catch(() => "");
    rules = DESIGN_RULES_HEADING.test(readme) && designRulesTouched(readme, await git("diff", range, "--", "README.md"));
  }
  const rechecks = RECHECK_KINDS.filter((k) => comments.some((c) => {
    const m = RECHECK_PASS.exec(c.body);
    return m?.[1] === k && m[2] === head;
  }));
  // a conflict with the base's tip: the merge cannot be made as is. Only exit 1 is a conflict; any other failure (an old
  // git without --write-tree, a missing object) is no judgement
  const tree = Bun.spawnSync(["git", "-C", root, "merge-tree", "--write-tree", base, head], { stdout: "ignore", stderr: "pipe" });
  if (tree.exitCode !== 0 && tree.exitCode !== 1) throw new Error(`git merge-tree が exit ${tree.exitCode}: ${tree.stderr.toString().trim().split("\n")[0]}`);
  const clean = tree.exitCode === 0;
  return {
    files,
    headCommittedAt,
    checks: local.pass ? [{ name: LOCAL_CHANGE_CI, conclusion: "SUCCESS" }] : [],
    ...(rules ? { designRulesTouched: true } : {}),
    ...(local.note ? { localCiNote: local.note } : {}),
    ...(rechecks.length > 0 ? { rechecks } : {}),
    unresolvedThreads: 0,
    mergeState: d.issue.state === "CLOSED" ? "CLOSED" : clean ? "CLEAN" : "DIRTY",
    reviewComments: comments,
    head,
    base: d.issue.change.base,
  };
}

/** GitLab's Developer: the access level whose notes count as marks (as MARK_AUTHORS on GitHub). */
export const GITLAB_MARK_LEVEL = 30;
/** GitLab is still working the MR's merge status out: nothing to judge by yet. */
const GITLAB_PENDING = ["unchecked", "checking", "preparing", "approvals_syncing"];

/**
 * A GitLab MR (#924) as the facts `judge` reads; the rules stay the same. CI = the head pipeline, only when it ran on
 * the head; none (or an older one) = the local pass of the head and the target branch's tip now. A pipeline that ran and
 * failed stops the merge. Marks count from notes of a Developer or above. README.md's Design rules section is not read
 * on GitLab: an MR touching README.md counts as touching it (asked). `mergeState`: GitLab's `detailed_merge_status`,
 * `mergeable` as CLEAN; one still being worked out throws (not judged). Approvals (a paid API) are not read.
 */
export async function readGitlabPr(iid: number, sh: Sh, target: ForgeTarget): Promise<PrFacts> {
  const r = await readGitlabMerge(sh, target, iid);
  const status = r.mr.mergeStatus;
  if (!status || GITLAB_PENDING.includes(status)) throw new Error(`detailed_merge_status が ${status ?? "無い"}（GitLab が計算中。少し待ってやり直す）`);
  const head = r.mr.head;
  const marks = r.notes.filter((n) => n.access >= GITLAB_MARK_LEVEL).map(({ body, createdAt }) => ({ body, createdAt }));
  const ofHead = marks.map((c) => ({ m: LOCAL_CI_RESULT.exec(c.body), at: Date.parse(c.createdAt) })).filter((x): x is { m: RegExpExecArray; at: number } => x.m?.[2] === head);
  const newest = ofHead.filter((x) => x.m[3] === r.baseTip).sort((a, b) => a.at - b.at).at(-1);
  const localPass = newest?.m[1] === "pass";
  const localCiNote = !ofHead.length ? undefined : !newest ? `local-ci の結果が今の base（${r.mr.target} ${r.baseTip.slice(0, 7)}）のものでない（base が進んだ。回し直す）` : localPass ? undefined : "local-ci の最新の結果が fail（今の head と base で落ちた）";
  const ran = r.pipeline && r.pipeline.sha === head ? r.pipeline : null;
  const checks: PrFacts["checks"] = ran
    ? [{ name: "GitLab pipeline", conclusion: ran.status === "success" ? "SUCCESS" : ran.status === "skipped" ? "SKIPPED" : ["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"].includes(ran.status) ? "" : ran.status.toUpperCase() }]
    : localPass ? [{ name: LOCAL_CI_ONLY, conclusion: "SUCCESS" }] : [];
  const localCi = !ran && localPass;
  const rechecks = RECHECK_KINDS.filter((k) => marks.some((c) => {
    const m = RECHECK_PASS.exec(c.body);
    return m?.[1] === k && m[2] === head;
  }));
  // GitLab says the CI must pass when it has no pipeline of the head: the local pass is that CI here, as UNSTABLE is on GitHub
  const mergeState = status === "mergeable" ? "CLEAN" : localCi && (status === "ci_must_pass" || status === "ci_still_running") ? "UNSTABLE" : status;
  if (!r.authored.length) throw new Error(`!${iid} のコミットが読めない`);
  return {
    files: r.files,
    headCommittedAt: r.authored.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
    checks,
    ...(r.files.some((f) => f.path === "README.md") ? { designRulesTouched: true } : {}),
    ...(localCi ? { localCi: true } : {}),
    ...(localCiNote ? { localCiNote } : {}),
    ...(rechecks.length ? { rechecks } : {}),
    unresolvedThreads: r.unresolved,
    mergeState,
    reviewComments: marks,
    head,
    base: r.mr.target,
  };
}

export type MergeMode = "merge" | "merge-stack";

/**
 * merge: one PR, only at the judged head (`gh pr merge --match-head-commit`). merge-stack: the bottom of a stack (`gh stack merge`
 * merges every PR below the one named, so only a PR on the default branch, which has none below it). gh stack takes no -R and
 * no head to match: it runs in the stack's worktree, whose origin must be the judged repository, and the head is read again
 * just before it (a push in between stops it; one in the last moment is not caught).
 */
export async function mergePr(n: number, repo: string, mode: MergeMode, facts: PrFacts, run: (args: string[]) => Promise<string>, stackRepo: () => string | undefined = originRepo): Promise<void> {
  if (!facts.head) throw new Error("head の sha が読めていない");
  if (mode === "merge") {
    await run(["pr", "merge", String(n), "-R", repo, "--rebase", "--delete-branch", "--match-head-commit", facts.head]);
    return;
  }
  const local = stackRepo();
  if (local !== repo) throw new Error(`--merge-stack は作業ツリーの origin（${local ?? "不明"}）のスタックをマージする。判定した ${repo} と違う`);
  const branch = (await run(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
  if (facts.base !== branch) throw new Error(`--merge-stack はスタックの最下段（base が ${branch}）だけ。この PR の base は ${facts.base}（下の PR も一緒にマージされる）`);
  const now = (await run(["pr", "view", String(n), "-R", repo, "--json", "headRefOid", "-q", ".headRefOid"])).trim();
  if (now !== facts.head) throw new Error(`判定の後に head が変わった（${facts.head} → ${now}）。判定し直す`);
  await run(["stack", "merge", String(n), "--rebase", "-y"]);
}

const USAGE = "usage: bun scripts/merge-gate.ts <PR> [--allow-large] [--merge | --merge-stack] [--repo <owner/name>]\n       bun scripts/merge-gate.ts --change <n> [--allow-large]";

/** The command: 0 = merge (and merged, with --merge / --merge-stack) / 1 = stop, or the merge failed / 2 = not judged. Only a merge verdict merges. */
export async function main(args: string[], run: (args: string[]) => Promise<string> = gh, log = console.log, err = console.error, stackRepo: () => string | undefined = originRepo, glab: Sh = runGlab, cwd = process.cwd(), backlog: { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = { env: process.env }): Promise<number> {
  const changeAt = args.indexOf("--change");
  if (changeAt >= 0) return changeMain(args, changeAt, log, err, cwd, backlog);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  const repoAt = args.indexOf("--repo");
  const modes = (["merge", "merge-stack"] as const).filter((m) => args.includes(`--${m}`));
  // the checkout's GitLab project (#924, its ops.config.json `forge`): the MR is judged by the same rules, merged by GitLab
  let lab: ForgeTarget | null = null;
  if (repoAt < 0) {
    try {
      const t = forgeTargetOf(cwd, originOf(cwd));
      if (t.service === "gitlab") lab = t;
    } catch (e) {
      err(`判定できなかった: ${(e as Error).message}`);
      return 2;
    }
  }
  if (lab) return gitlabMain(n, lab, args, modes, glab, log, err);
  const repo = repoAt >= 0 ? args[repoAt + 1] : currentRepo(cwd);
  if (!n || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || modes.length > 1) {
    err(USAGE);
    return 2;
  }
  let facts: PrFacts;
  try {
    facts = await readPr(n, run, repo, { root: cwd, url: `https://github.com/${repo}.git` });
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  if (j.verdict !== "merge") return 1;
  const mode = modes[0];
  if (!mode) return 0;
  try {
    await mergePr(n, repo, mode, facts, run, stackRepo);
  } catch (e) {
    err(`マージできなかった: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  return 0;
}

/**
 * `--change <n>` (#2487): a local change judged by the same rules from the app and the checkout's git, gh never called.
 * It only judges: the merge is scripts/local-merge.ts. A PR number, --repo or a merge mode with it is not judged (2).
 */
async function changeMain(args: string[], at: number, log: (s: string) => void, err: (s: string) => void, cwd: string, backlog: { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): Promise<number> {
  const value = args[at + 1] ?? "";
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (!/^\d+$/.test(value) || rest.some((a) => a !== "--allow-large")) {
    err(USAGE);
    return 2;
  }
  let facts: PrFacts;
  try {
    const root = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    facts = await readChange(await readChangeDetail(Number(value), backlog.env, { fetch: backlog.fetch, cwd }), root);
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  return j.verdict === "merge" ? 0 : 1;
}

/** The command on a GitLab MR: --merge merges only the judged head; there is no stack to merge (--merge-stack is refused). */
async function gitlabMain(n: number, target: ForgeTarget, args: string[], modes: MergeMode[], glab: Sh, log: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!n || modes.length > 1 || modes[0] === "merge-stack") {
    err(modes[0] === "merge-stack" ? "GitLab の MR は --merge だけ（スタックのマージは無い）" : USAGE);
    return 2;
  }
  let facts: PrFacts;
  try {
    facts = await readGitlabPr(n, glab, target);
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  if (j.verdict !== "merge") return 1;
  if (!modes[0]) return 0;
  try {
    await mergeGitlabMr(glab, target, n, facts.head!);
  } catch (e) {
    err(`マージできなかった: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
