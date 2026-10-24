import { currentRepo } from "./repo.ts";
import { LOCAL_CI_RESULT } from "./local-ci";

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
 * Security: a path word (split at / . _ -, lower-cased) in SECURITY_WORDS, or SECURITY_FILES (CI and repository settings,
 * secrets files, lock files — adding a dependency changes the lock). Responsibility: design rules, design docs, agent
 * instructions and operating settings; README.md's `## Design rules` section is judged per line (designRulesTouched).
 */
export const SECURITY_WORDS = ["auth", "approval", "permission", "permissions", "secret", "secrets", "credential", "credentials", "token", "tokens", "crypto", "sandbox"];
export const SECURITY_FILES = [
  ".github/**",
  "**/.env*",
  "**/.gitleaks.toml",
  "**/{bun.lock,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,go.sum,Cargo.lock}",
  "**/requirements*.txt",
  // the gate and local CI decide merges like CI does: a small change to them is still the user's to approve (#751)
  "scripts/merge-gate.ts",
  "scripts/local-ci.ts",
  // Switchboard's own (a --repo without aws/host never meets it): the cloud host runs main's host scripts as root at
  // every start (sb-host-update, #435)
  "aws/host/**",
].map((p) => new Bun.Glob(p));
// aws/host/** says more than the path: root runs it from main, which is #852's concern (docs/design/cloud-hosting.md §6.5)
const HOST_ROOT = new Bun.Glob("aws/host/**");
const HOST_ROOT_NOTE = "（aws/host は起動のたびに root が main から入れて走らせる。root で走る範囲が増えるなら #852 の見直しの契機: docs/design/cloud-hosting.md §6.5）";
export const RESPONSIBILITY = [
  "docs/design/**",
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "ops.config.json",
  ".claude/skills/**",
  "ops-kit/skills/**",
].map((p) => new Bun.Glob(p));
const DESIGN_RULES = "README.md の ## Design rules";

/**
 * Two kinds of large reason (#751). Ask: only the user lifts it (--allow-large) — security, rescue (the rollback itself)
 * and README.md's Design rules. Recheck: a `[recheck] <kind> pass <head sha>` PR comment lifts it, per kind (size: line
 * count and the other protected paths; responsibility: the other responsibility files; migration: MIGRATION).
 */
export type RecheckKind = "size" | "responsibility" | "migration";
export const RECHECK_KINDS: RecheckKind[] = ["size", "responsibility", "migration"];
export const RECHECK_PASS = /^\[recheck\] (size|responsibility|migration) pass ([0-9a-f]{40})\b/;
export type AskKind = "security" | "rescue" | "design-rules";
export const ASK_KINDS: AskKind[] = ["security", "rescue", "design-rules"];
/** The words of the record marks (#752), in this order: who lifted which kind of a large PR. */
export const MERGE_KINDS = ["security", "rescue", "design-rules", "size", "responsibility", "migration"] as const;
export type MergeKind = (typeof MERGE_KINDS)[number];
/**
 * Record marks for the user's side (#761; the recheck side is RECHECK_PASS): asked with `[merge-ask] <kinds> <head sha>`,
 * answered with `[merge-answer] <yes|no> <kinds> <head sha>` (kinds comma-separated; the comment's createdAt is the time).
 * merge-audit reads them; merge-gate's judgement does not.
 */
export const MERGE_ASK = /^\[merge-ask\] ([a-z-]+(?:,[a-z-]+)*) ([0-9a-f]{40})\b/;
export const MERGE_ANSWER = /^\[merge-answer\] (yes|no) ([a-z-]+(?:,[a-z-]+)*) ([0-9a-f]{40})\b/;
export const ASK_PROTECTED = ["rescue/**"].map((p) => new Bun.Glob(p));
export const MIGRATION = ["packages/core/src/db.ts", "packages/core/src/schema-baseline.json"].map((p) => new Bun.Glob(p));
const DESIGN_RULES_HEADING = /^## Design rules[ \t]*$/m;

const TESTS = ["**/*.test.ts", "scripts/*-e2e.ts"].map((p) => new Bun.Glob(p));
const DOCS = ["docs/**", "**/*.md"].map((p) => new Bun.Glob(p));
const REVIEW = /^\[(codex|claude)\] review/;
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
}

export interface Judgement {
  verdict: "merge" | "stop";
  impact: "small" | "large";
  reasons: string[];
  /** The ask kinds among the large reasons (kept with --allow-large: what the user's yes lifted). */
  ask: AskKind[];
  /** The recheck kinds among the large reasons that have no mark of the head yet. */
  recheck: RecheckKind[];
}

const matches = (globs: Bun.Glob[], path: string) => globs.some((g) => g.match(path));

export function classify(path: string): "security" | "responsibility" | null {
  if (matches(SECURITY_FILES, path) || path.toLowerCase().split(/[\/._-]/).some((w) => SECURITY_WORDS.includes(w))) return "security";
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
  // rescue is asked whatever else its file is (rescue/CLAUDE.md too); a security file there says セキュリティ instead
  const rescue = (p: string) => classify(p) !== "security" && matches(ASK_PROTECTED, p);
  const touched = paths.filter((p) => classify(p) === null && matches(PROTECTED, p) && !rescue(p));
  const security = paths.filter((p) => classify(p) === "security");
  add("security", "セキュリティ", security, security.some((p) => HOST_ROOT.match(p)) ? HOST_ROOT_NOTE : "");
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

  const reasons = opts.allowLarge
    ? []
    : large
      .filter((l) => isAsk(l.kind) || !marked.has(l.kind))
      .map((l) => `${isAsk(l.kind) ? "[聞く]" : `[再チェック ${l.kind}]`} ${l.text}`);
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

  return { verdict: reasons.length === 0 ? "merge" : "stop", impact, reasons, ask, recheck };
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
 * When Actions does not start (billing: the job fails with no steps and no runner), or there is no run at all, the local
 * pass of `bun scripts/local-ci.ts` counts as the CI's success (#387, #914). Only for a run that never started (a CI
 * whose tests really failed still stops the merge) and only when it is of the head and the base branch's tip now.
 */
const LOCAL_CI_SUFFIX = "（Actions が始まらず、ローカルで pass）";
const LOCAL_CI_ONLY = "local-ci（Actions の run が無く、ローカルで pass）";
const PROTECTION_DOC = "docs/design/merge-gate.md の「保護枝とローカルの結果」";

/**
 * Whether the newest local-ci result of the head and the base branch's tip now is a pass; else why not (#914). Only
 * results with the base count (`LOCAL_CI_RESULT`); the base's tip is read only when there is one of the head.
 */
export async function localCiOf(comments: { body: string; createdAt: string }[], head: string, baseRef: string, run: (args: string[]) => Promise<string>, repo: string): Promise<{ pass: boolean; note?: string }> {
  const ofHead = comments
    .map((c) => ({ m: LOCAL_CI_RESULT.exec(c.body), at: Date.parse(c.createdAt) }))
    .filter((x): x is { m: RegExpExecArray; at: number } => x.m?.[2] === head);
  if (ofHead.length === 0) return { pass: false };
  const base = (await run(["api", `repos/${repo}/git/ref/heads/${baseRef}`, "-q", ".object.sha"])).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`base の枝 ${baseRef} の先端が読めない`);
  const newest = ofHead.filter((x) => x.m[3] === base).sort((a, b) => a.at - b.at).at(-1);
  if (!newest) return { pass: false, note: `local-ci の結果が今の base（${baseRef} ${base.slice(0, 7)}）のものでない（base が進んだ。回し直す）` };
  return newest.m[1] === "pass" ? { pass: true } : { pass: false, note: "local-ci の最新の結果が fail（今の head と base で落ちた）" };
}

async function checksWithLocalCi(runs: WorkflowRun[], localPass: boolean, run: (args: string[]) => Promise<string>, repo: string): Promise<PrFacts["checks"]> {
  if (localPass && runs.length === 0) return [{ name: LOCAL_CI_ONLY, conclusion: "SUCCESS" }];
  const checks: PrFacts["checks"] = [];
  for (const r of newestRuns(runs)) {
    const c = toCheck(r);
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

/** `repo`: owner/name; another repository's backlog stage Task passes its own with --repo (the rules stay these). */
export async function readPr(n: number, run = gh, repo = currentRepo()): Promise<PrFacts> {
  const [owner, name] = repo.split("/");
  const pr = JSON.parse(
    await run(["pr", "view", String(n), "-R", repo, "--json", "files,commits,baseRefName,baseRefOid,headRefOid,mergeStateStatus,comments"]),
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
  const local = await localCiOf(comments, pr.headRefOid, pr.baseRefName, run, repo);
  const checks = await checksWithLocalCi(runs.workflow_runs, local.pass, run, repo);
  const rechecks = RECHECK_KINDS.filter((k) =>
    comments.some((c) => {
      const m = RECHECK_PASS.exec(c.body);
      return m?.[1] === k && m[2] === pr.headRefOid;
    }));
  const authored: string[] = pr.commits.map((c: { authoredDate: string }) => c.authoredDate);
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
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  const repoAt = args.indexOf("--repo");
  const repo = repoAt >= 0 ? args[repoAt + 1] : currentRepo();
  if (!n || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error("usage: bun scripts/merge-gate.ts <PR> [--allow-large] [--repo <owner/name>]");
    process.exit(2);
  }
  let facts: PrFacts;
  try {
    facts = await readPr(n, gh, repo);
  } catch (e) {
    console.error(`判定できなかった: ${(e as Error).message}`);
    process.exit(2);
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  console.log(JSON.stringify(j, null, 2));
  process.exit(j.verdict === "merge" ? 0 : 1);
}
