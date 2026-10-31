import { currentRepo, originRepo } from "./repo.ts";
import { LOCAL_CI_RESULT, patchIdOf, sh, stackOf } from "./local-ci";
import { forgeTargetOf, originOf, type ForgeTarget } from "../ops-kit/src/forge.ts";
import { mergeGitlabMr, readGitlabMerge, runGlab, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { linkedIssues, overlaps, scopeIn } from "./task-paths.ts";

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
  /** The head's sha (a `[merge-answer] yes` must name it for --allow-large with --merge; --merge merges only this head); absent = not read. */
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

/** `answered`: with --merge / --merge-stack, --allow-large lifts the large reasons only after a `[merge-answer] yes` of the head. */
export function judge(f: PrFacts, opts: { allowLarge: boolean; answered?: boolean }): Judgement {
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
  // the yes must be for this head and for every ask kind (a yes about rescue does not lift a security reason)
  if (opts.allowLarge && opts.answered && !f.reviewComments.some((c) => {
    const m = MERGE_ANSWER.exec(c.body);
    const kinds = m?.[2]?.split(",") ?? [];
    return m?.[1] === "yes" && m[3] === f.head && ask.every((k) => kinds.includes(k));
  })) reasons.push(`[merge-answer] yes の印が無い（head ${f.head ?? "不明"}、kinds ${ask.join(",") || "なし"}）`);
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
 * When Actions does not start (billing: the job fails with no steps and no runner), or there is no run at all, the local
 * pass of `bun scripts/local-ci.ts` counts as the CI's success (#387, #914). Only for a run that never started (a CI
 * whose tests really failed still stops the merge) and only when the newest result of the stack's top is a pass that
 * names this PR's diff as it is now (`localCiOf`, #2940).
 */
const LOCAL_CI_SUFFIX = "（Actions が始まらず、ローカルで pass）";
const LOCAL_CI_ONLY = "local-ci（Actions の run が無く、ローカルで pass）";
const PROTECTION_DOC = "docs/merge-gate.md の「保護枝とローカルの結果」";

/**
 * The top of `n`'s stack (#2940): up by the one open PR whose base is this one's head branch. None or two above → here.
 * gh stack's state is a worktree's local file, and GitHub's API has no stack, so the PRs' branches are what is read.
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

/**
 * Whether the newest local-ci result of the stack's top `top` (this PR itself when alone) is a pass whose stack line
 * (`stackOf`) has this PR's patch-id now; else why not (#2940). The base's tip is not compared: a conflict with another
 * PR is mergeStateStatus's, a fault of two PRs together the tag CI's. A pass without the stack line is none.
 */
export async function localCiOf(n: number, top: number, comments: { body: string; createdAt: string }[], run: (args: string[]) => Promise<string>, repo: string, patchId: (pr: number) => Promise<string>): Promise<{ pass: boolean; note?: string }> {
  const ofTop = top === n ? comments : (JSON.parse(await run(["pr", "view", String(top), "-R", repo, "--json", "comments"])).comments as Array<{ body: string; createdAt: string; authorAssociation?: string }>)
    .filter((c) => MARK_AUTHORS.includes(c.authorAssociation ?? ""));
  const newest = ofTop
    .map((c) => ({ c, m: LOCAL_CI_RESULT.exec(c.body), at: Date.parse(c.createdAt) }))
    .filter((x) => x.m)
    .sort((a, b) => a.at - b.at)
    .at(-1);
  if (!newest) return { pass: false };
  if (newest.m![1] !== "pass") return { pass: false, note: `一番上の PR #${top} の local-ci の最新が fail` };
  const recorded = stackOf(newest.c.body)?.get(n);
  if (!recorded) return { pass: false, note: `一番上の PR #${top} の pass にこの PR が入っていない（一番上で回す）` };
  if (recorded !== await patchId(n)) return { pass: false, note: `この PR の差分が #${top} の pass のときから変わった（一番上で回し直す）` };
  return { pass: true };
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
 * `patchId`: a PR's diff's patch-id now (local-ci's `patchIdOf`; tests give their own).
 */
export async function readPr(n: number, run = gh, repo = currentRepo(), patchId = (pr: number) => patchIdOf(pr, repo, sh)): Promise<PrFacts> {
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
  const local = await localCiOf(n, await stackTop(n, pr.headRefName, run, repo), comments, run, repo, patchId);
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

const USAGE = "usage: bun scripts/merge-gate.ts <PR> [--allow-large] [--merge | --merge-stack] [--repo <owner/name>]";

/** The command: 0 = merge (and merged, with --merge / --merge-stack) / 1 = stop, or the merge failed / 2 = not judged. Only a merge verdict merges. */
export async function main(args: string[], run: (args: string[]) => Promise<string> = gh, log = console.log, err = console.error, stackRepo: () => string | undefined = originRepo, glab: Sh = runGlab, cwd = process.cwd()): Promise<number> {
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
    facts = await readPr(n, run, repo);
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large"), answered: modes.length > 0 });
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
  const j = judge(facts, { allowLarge: args.includes("--allow-large"), answered: modes.length > 0 });
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
