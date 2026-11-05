/**
 * CI on this machine when GitHub Actions does not start (#387): `bun scripts/local-ci.ts <PR>` runs the `run:` steps of
 * .github/workflows/ci.yml — its `bun scripts/ci.ts` step as that checkout's scripts/ci.ts steps, the ones Actions runs
 * (#912) — on what Actions' pull_request run tests: the PR's latest head merged into its base branch's latest tip, merged
 * here (#913: GitHub's pull/<n>/merge is not needed) — in a throwaway worktree under ~/.cache (not /tmp: a small RAM
 * tmpfs on the cloud host) with TMPDIR under the OS's temp dir (the one the `local` perf ceilings were measured with:
 * on the disk, launch.layoutShift goes over, #1056), with only PATH and HOME from this environment, plus the external
 * recordings directory only when supplied (a daemon's SWITCHBOARD_* would change what the tests see).
 * The result goes on the PR whether or not Actions ran: all green → `[local-ci] pass <head sha> base=<base sha>`, which
 * merge-gate takes in place of an Actions CI that never started; a failure or a conflict → `[local-ci] fail <head sha>
 * base=<base sha>` and exit 1. Before posting, head and base are read again: either moved → nothing posted, exit 1
 * (run again). Each failed step's whole output stays in a log dir under ~/.cache (a perf step's failure does not stop
 * `bun test`, so a run can have two, #2945); a perf step's failure also leaves perf-result.json and summary.md there
 * (head / base, environment, over / improved / raised, #1056).
 * A perf check that is `over` also measures the base (main's tip) the same way in a second worktree,
 * so the summary says per key whether main goes over too or the PR does (#1191); the run stays a failure either way.
 * After every step passed, the type check's and bun test's seconds are compared with the `local` ceilings of the checkout's
 * scripts/perf-budget.json (#1887), bun test's only when every test ran (#3297): over one → a failure like a failed step,
 * named `DURATION_STEP`. A checkout without that file or those ceilings is not compared.
 * `bun test` runs the tests of the checkout's scripts/test-select.ts for what the PR and the PRs below it changed; a
 * change it cannot judge, or a selection that cannot be read, runs all of them, and so does `--all`. Only this script
 * narrows: tag-ci's `runCheckout` runs every test, and the other steps always run (#3297).
 * A head whose newest result merge-gate already counts as a pass is not run again (`existingPass`, #1882): `--force` runs
 * it, and `--all` does too (a narrowed pass is not what it asks for). GitHub only.
 * `--repo <owner/name>` (#1203): another repository's PR, run from that repository's working tree (its origin must be
 * owner/name); the mark goes on that PR. Without it: the repository of the clone this script is in (that clone's
 * origin), run in that clone.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgeOf, forgeTargetOf, LOCAL_SERVICE, originOf, runForgeOperation } from "../ops-kit/src/forge.ts";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { gitlabForge, runGlab, viewGitlabMr, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { githubForge } from "../ops-kit/src/forge-github.ts";
import { appForge } from "../ops-kit/src/forge-app.ts";
import { IDLE_KILLED_LINE, runIdle } from "../ops-kit/src/idle-run.ts";
import { hostAws } from "../ops-kit/src/secrets.ts";
import { ciExit, runCi, STEP_IDLE_SECONDS, type Step } from "./ci.ts";
import { judgeDurations, recordRow, RECORDS_BRANCH, RECORDS_HEADER, RECORDS_PATH, type Budgets } from "./perf-ratchet.ts";
import { localCiOf, localCiOfChange, MARK_AUTHORS, newestLocalCi, readChangeDetail } from "./merge-gate.ts";
import { isTest } from "./test-select.ts";

export type { Step };

/** A result's first line: pass or fail, the head, then the base it was merged into (#913). A mark without the base is none. */
export const LOCAL_CI_RESULT = /^\[local-ci\] (pass|fail) ([0-9a-f]{40}) base=([0-9a-f]{40})(?=\s|$)/;

/** A pass's line after the first line (#1886): the type check's and bun test's seconds as JSON, hidden in GitHub's view. */
export const LOCAL_CI_SECONDS = /^<!-- local-ci-seconds (\{.*\}) -->$/m;

/** The type check's and bun test's seconds of a run. */
export interface StepSeconds { typecheck: number; test: number }

/** The steps whose seconds a pass carries, by their name (a narrowed `bun test` has another `run`). */
const SECONDS_STEPS: Record<keyof StepSeconds, string> = { typecheck: "bun run typecheck", test: "bun test" };

/** The seconds of the two steps, to one decimal; either missing throws (the CI changed them: the seconds would silently go). */
export function stepSeconds(results: StepResult[]): StepSeconds {
  const of = (run: string) => {
    const r = results.find((x) => x.name === run);
    if (!r) throw new Error(`CI の手順に \`${run}\` が無い（stepSeconds）`);
    return Math.round(r.seconds * 10) / 10;
  };
  return { typecheck: of(SECONDS_STEPS.typecheck), test: of(SECONDS_STEPS.test) };
}

/** The seconds a result's body carries, or undefined when it has none. */
export function markerSeconds(body: string): StepSeconds | undefined {
  const m = LOCAL_CI_SECONDS.exec(body);
  if (!m) return undefined;
  const v = JSON.parse(m[1]!) as Partial<StepSeconds>;
  return typeof v.typecheck === "number" && typeof v.test === "number" ? { typecheck: v.typecheck, test: v.test } : undefined;
}

/** A result's machine line of its tests (#3297): how many files ran, null = all of them, of how many. */
export const LOCAL_CI_TESTS = /^<!-- local-ci-tests (\{.*\}) -->$/m;

/** The tests a result's body carries, or undefined when it has none (a run before #3297, `--all`). */
export function testsOf(body: string): { ran: number | null; total: number } | undefined {
  const m = LOCAL_CI_TESTS.exec(body);
  if (!m) return undefined;
  const v = JSON.parse(m[1]!) as { ran?: unknown; total?: unknown };
  return (typeof v.ran === "number" || v.ran === null) && typeof v.total === "number" ? { ran: v.ran, total: v.total } : undefined;
}

/** `log` = where the whole output of a step that failed was kept (#1232), `fails` = its failLines; passing steps keep nothing. */
export interface StepResult extends Step { code: number; seconds: number; tail: string; log?: string; fails?: string[] }

/** The lines of a step's output that name what failed: bun test's `(fail)` lines, perf-ratchet's `over:` / `raised:` / `improved:` / `grew:` lines and idle-run's reason, once each, in order. */
export function failLines(output: string): string[] {
  const perf = (l: string) => l.includes("over:") || l.startsWith("raised: ") || l.startsWith("improved: ") || l.startsWith("grew: ");
  return [...new Set(output.split("\n").filter((l) => l.startsWith("(fail)") || perf(l) || l.startsWith("無進捗で打ち切り")))];
}

/** What perf-ratchet's check said: its `ceilings:` environment and its over / improved / raised / grew lines as printed (grew = the bundle 1% or more above main's tip). `unknown` = none of the four (the bench failed, or the check stopped before judging). */
export interface PerfVerdict { env: string | null; over: string[]; improved: string[]; raised: string[]; grew: string[]; unknown: boolean }

export function perfVerdict(output: string): PerfVerdict {
  const lines = output.split("\n");
  const of = (kind: string) => lines.filter((l) => l.startsWith(`${kind}: `));
  const [over, improved, raised, grew] = [of("over"), of("improved"), of("raised"), of("grew")];
  const env = lines.map((l) => /^ceilings: (\S+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  return { env, over, improved, raised, grew, unknown: over.length + improved.length + raised.length + grew.length === 0 };
}

/** The perf bench, main's measure (`perf-ratchet.ts base`) or the ratchet's check: their failure gets a verdict (a bench or base failure is one with no judgement). */
export const isPerfStep = (s: Step) => /scripts\/perf-(bench|ratchet)\.ts/.test(s.run);
/** The ratchet's check alone: the step whose output has the verdict and the bundle lines. */
export const isPerfCheck = (s: Step) => s.run.includes("perf-ratchet") && s.run.includes(" check ");

/** What the base (main) measured the same way: its check's verdict, or null when a step before it failed. */
export interface Baseline { sha: string; verdict: PerfVerdict | null }

/** The steps that measure a checkout: the install, then the web build up to the last perf step (main's fetch, fonts, bench, check; not bun test after them). */
export function perfSteps(steps: Step[]): Step[] {
  const install = steps.find((s) => s.run.trim() === "bun install --frozen-lockfile");
  const build = steps.findIndex((s) => s.run.trim() === "bun run --cwd apps/web build");
  const last = steps.map((s) => isPerfStep(s)).lastIndexOf(true);
  if (!install || build < 0 || last < build) throw new Error("CI の手順に `bun install --frozen-lockfile` か `bun run --cwd apps/web build` とその後の性能の手順が無い（perfSteps）");
  return [install, ...steps.slice(build, last + 1)];
}

/** The step of ci.yml that runs scripts/ci.ts: Actions runs those steps in one go, local-ci one by one (#912). */
export const SHARED_ENTRY = "bun scripts/ci.ts";

/**
 * What a checkout's CI runs: ci.yml's `run:` steps, with the shared entry replaced by that checkout's own scripts/ci.ts
 * steps (another repository's ci.yml has none, #1203). Those are the PR's code: read by `--list` in a process of its
 * own with `env` (the steps' environment), never imported into this one.
 */
export async function checkoutSteps(dir: string, env: Record<string, string>): Promise<Step[]> {
  const steps: Step[] = [];
  for (const s of workflowSteps(await Bun.file(join(dir, ".github/workflows/ci.yml")).text())) {
    if (s.run.trim() !== SHARED_ENTRY) { steps.push(s); continue; }
    const p = Bun.spawn([process.execPath, "scripts/ci.ts", "--list"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`scripts/ci.ts --list が exit ${code}: ${err.trim()}`);
    steps.push(...(JSON.parse(out) as Step[]));
  }
  return steps;
}

const overKey = (line: string) => /^over: (\S+) = /.exec(line)?.[1] ?? line;

/** Per key the PR is over on: main over it too, or the PR's own; one line when main's measure failed. Then main's over lines. */
export function baselineLines(over: string[], b: Baseline): string[] {
  const out = [`main（${b.sha.slice(0, 7)}）との比較:`];
  if (!b.verdict || b.verdict.unknown) return [...out, "main の計測に失敗（原因不明）"];
  const mainKeys = new Set(b.verdict.over.map(overKey));
  out.push(...over.map((l) => `${overKey(l)}: ${mainKeys.has(overKey(l)) ? "main でも超過（PR の変更によらない）" : "PR 固有の悪化"}`));
  return b.verdict.over.length ? [...out, "main の over:", ...b.verdict.over] : out;
}

/** The summary of a failed step that stays readable after the run: head / base, the environment, and for a perf step the verdict by kind. */
export function failureSummary(r: { sha: string; base: string; step: StepResult; env: Record<string, string>; output: string; perf?: PerfVerdict; baseline?: Baseline }): string {
  const out = [`head ${r.sha} / base ${r.base}`, `手順 ${r.step.name}: exit ${r.step.code}`];
  if (!r.perf) return [...out, r.step.tail].join("\n");
  const p = r.perf;
  out.push(`環境: ceilings ${p.env ?? "?"}, TMPDIR ${r.env.TMPDIR ?? "?"}, CI=${r.env.CI ?? "?"}`);
  const kinds: Array<[string, string[]]> = [["超過（over）", p.over], ["改善による予算更新要求（improved）", p.improved], ["main より予算引上げ（raised）", p.raised], ["1% 以上の増加（grew）", p.grew]];
  for (const [title, lines] of kinds) if (lines.length) out.push(`${title}:`, ...lines);
  if (p.unknown) out.push("原因不明（判定の行が無い）:", ...r.output.trimEnd().split("\n").slice(-10));
  if (r.baseline) out.push(...baselineLines(p.over, r.baseline));
  return out.join("\n");
}

/** The `run:` steps of every job in ci.yml, in order (`uses:` steps are the checkout and Bun, which this machine has). */
export function workflowSteps(yaml: string): Step[] {
  const doc = Bun.YAML.parse(yaml) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  return Object.values(doc.jobs).flatMap((j) => j.steps.filter((s) => s.run).map((s) => ({ name: s.name ?? s.run!.split("\n")[0]!, run: s.run! })));
}

/** What one run tested and how it went; `conflict` = the head did not merge into the base, nothing ran. */
/** `seconds`: a pass's type check and bun test seconds (#1886), for a checkout with scripts/ci.ts. */
/** `selection`: what chose this run's tests, none with `--all` (#3297). `bundle`: the perf check's `bundle:` and `grew:` lines, pass or fail. */
export interface LocalCiResult { sha: string; base: string; results: StepResult[]; ok: boolean; seconds?: StepSeconds; conflict?: boolean; perf?: PerfVerdict; baseline?: Baseline; selection?: TestSelection; bundle?: string[] }

/** What a run's bun test covered, for the comment: the seen line and the machine line; a selection's reason can list every changed file. */
function testsLines(s: TestSelection | undefined): string[] {
  if (!s) return ["テスト: 全ファイル（--all）"];
  const seen = s.files ? `テスト: ${s.files.length} / ${s.total} ファイル（影響範囲の選択）` : `テスト: 全 ${s.total} ファイル（全テストに倒した: ${s.reason.length > 300 ? `${s.reason.slice(0, 300)}…` : s.reason}）`;
  const loaded = s.loaded && !s.loaded.run ? [`loaded（量と重なりの計測）: 測らなかった（${s.loaded.reason}）`] : [];
  return [seen, ...loaded, `<!-- local-ci-tests ${JSON.stringify({ ran: s.files?.length ?? null, total: s.total })} -->`];
}

/** The PR comment of a run, pass or not (#913): the mark (the first line only: merge-gate reads no more, #3118), a pass's seconds line, what was tested, the bundle against main's tip, every step that ran; a failure names its step and what failed in it. */
export function resultComment(r: LocalCiResult): string {
  const head = [
    `[local-ci] ${r.ok ? "pass" : "fail"} ${r.sha} base=${r.base}`,
    ...(r.ok && r.seconds ? [`<!-- local-ci-seconds ${JSON.stringify(r.seconds)} -->`] : []),
    "",
    "`.github/workflows/ci.yml` の手順（`bun scripts/ci.ts` は `scripts/ci.ts` の各手順）を、PR の head を base にマージしたものでローカルで実行した（`bun scripts/local-ci.ts`）。",
    "",
    `対象: head \`${r.sha}\` を base \`${r.base}\` にマージ`,
  ];
  if (r.conflict) return [...head, "", "結果: head を base にマージできない（衝突）。手順は実行していない。base を取り込んでから回し直す。"].join("\n");
  // every failed step: a perf step's failure does not stop bun test (#2945)
  const failed = r.results.filter((x) => x.code !== 0);
  return [
    ...head,
    ...testsLines(r.selection),
    ...(r.bundle?.length ? ["", "bundle（gzip、マージ後と main の先端の差）:", ...r.bundle.map((l) => `    ${l}`)] : []),
    // a fenced block: 4 spaces right after a paragraph line are no code block in CommonMark (they join the paragraph)
    ...failed.flatMap((f) => {
      const fails = (f.fails ?? []).slice(0, 20);
      // one backtick longer than the longest run in the lines: a line holding ``` does not close it
      const fence = "`".repeat(Math.max(3, ...fails.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((x) => x.length)) + 1)));
      return ["", `結果: \`${f.name}\` が exit ${f.code}。${f.log ? "全文は実行したホストの記録（~/.cache の下）。" : ""}`, ...(fails.length ? [fence, ...fails, fence] : [])];
    }),
    "",
    "| 手順 | 結果 | 秒 |",
    "|---|---|---|",
    ...r.results.map((x) => `| \`${x.name.replaceAll("|", "\\|")}\` | ${x.code === 0 ? "pass" : `exit ${x.code}`} | ${x.seconds.toFixed(0)} |`),
  ].join("\n");
}

export interface Deps {
  /** Runs a command; throws on a non-zero exit. */
  sh: (cmd: string[], cwd?: string) => Promise<string>;
  /** Runs one step in `cwd` with `env` only. */
  step: (script: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; output: string }>;
  log: (line: string) => void;
  /** Runs `fn` holding one of the machine's heavy-job slots (ops-kit heavy: waits while they are all held). */
  slot: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * The PR's head and its base branch's tip as they are now, both fetched into `repoRoot` (#913). The head comes by
 * refs/pull/<n>/head, which GitHub keeps for every PR (a fork's too); it must be the head the PR names.
 * Each is fetched into a ref of its own, refs/local-ci/<n>/base and refs/local-ci/<n>/head, and read from there: another
 * fetch in the same clone (a local-ci of another PR alongside) rewrites FETCH_HEAD in between.
 */
export async function readTarget(pr: number, repoRoot: string, repo: string, d: Pick<Deps, "sh">, glab: Sh = runGlab): Promise<{ head: string; base: string }> {
  // a GitLab checkout (#892): the MR `pr` of the project its forge names; GitLab keeps refs/merge-requests/<iid>/head
  const named = forgeTargetOf(repoRoot, originOf(repoRoot));
  const view = named.service === "gitlab"
    ? await viewGitlabMr(glab, named, pr).then((m) => ({ headRefOid: m.head, baseRefName: m.target }))
    : JSON.parse(await d.sh(["gh", "pr", "view", String(pr), "-R", repo, "--json", "headRefOid,baseRefName"])) as { headRefOid: string; baseRefName: string };
  const headRef = named.service === "gitlab" ? `refs/merge-requests/${pr}/head` : `refs/pull/${pr}/head`;
  const fetched = async (ref: string, into: string) => {
    await d.sh(["git", "-C", repoRoot, "fetch", "-q", "origin", `+${ref}:${into}`]);
    return (await d.sh(["git", "-C", repoRoot, "rev-parse", into])).trim();
  };
  const base = await fetched(`refs/heads/${view.baseRefName}`, `refs/local-ci/${pr}/base`);
  const head = await fetched(headRef, `refs/local-ci/${pr}/head`);
  if (head !== view.headRefOid) throw new Error(`${headRef} は ${head.slice(0, 7)} で、PR の head ${view.headRefOid.slice(0, 7)} ではない（push の直後なら少し待ってやり直す）`);
  return { head, base };
}

/** `files: null` = every test; `total` = the checkout's test files; `reason` = why these tests, or why all of them; `unjudged`: the selection itself did not run or could not be read. */
/** `loaded`: whether the change reaches perf-bench's `loaded` (#3635); none = not judged, and it runs. */
export interface TestSelection { files: string[] | null; total: number; reason: string; unjudged?: true; loaded?: { run: boolean; reason: string } }

/**
 * The tests for what changed since the commit `base` gives, by the checkout's scripts/test-select.ts: its code, run in
 * a process of its own with `env` (as checkoutSteps runs the checkout's scripts/ci.ts), never imported into this one.
 * A checkout without it, a failure or an output it cannot read → every test. A failure's text goes to the log, not in
 * `reason`: that goes on the PR, and the text holds the host's paths.
 */
export async function selectTests(dir: string, base: () => Promise<string>, env: Record<string, string>, d: Pick<Deps, "sh" | "log">): Promise<TestSelection> {
  const total = (await d.sh(["git", "-C", dir, "ls-files"])).split("\n").filter(isTest).length;
  if (!existsSync(join(dir, "scripts/test-select.ts"))) return { files: null, total, reason: "scripts/test-select.ts が無い", unjudged: true };
  try {
    // --no-renames: a rename's old path is a deleted file, whose dependents the selection must see
    const changed = (await d.sh(["git", "-C", dir, "diff", "--name-only", "--no-renames", "-z", await base()])).split("\0").filter(Boolean);
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const [head = "", ...rows] = (await d.sh(["env", "-i", ...vars, process.execPath, "scripts/test-select.ts", ...changed], dir)).trimEnd().split("\n");
    const full = /^full: (.*)$/.exec(head);
    if (!full && head !== `selected: ${rows.length}`) throw new Error(`出力を読めない: ${head.slice(0, 80)}`);
    const tests = full ? { files: null, total, reason: full[1]!.replaceAll(dir, "<checkout>") } : { files: rows.map((r) => r.split("  ")[0]!), total, reason: `変更 ${changed.length} ファイルから選んだ` };
    return { ...tests, ...(await loadedOf(dir, vars, changed, d)) };
  } catch (e) {
    d.log(`テストの選択に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return { files: null, total, reason: "選択を実行できなかった（実行したホストのログを見る）", unjudged: true };
  }
}

/**
 * Whether the change reaches perf-bench's `loaded`, by the checkout's `scripts/test-select.ts --loaded` (#3635). A
 * failure or an output it cannot read (a checkout from before it) → nothing, and `loaded` runs.
 */
async function loadedOf(dir: string, vars: string[], changed: string[], d: Pick<Deps, "sh" | "log">): Promise<{ loaded?: { run: boolean; reason: string } }> {
  try {
    const out = (await d.sh(["env", "-i", ...vars, process.execPath, "scripts/test-select.ts", "--loaded", ...changed], dir)).trim();
    const m = /^loaded: (run|skip) {2}(.*)$/.exec(out);
    if (!m) throw new Error(`出力を読めない: ${out.slice(0, 80)}`);
    return { loaded: { run: m[1] === "run", reason: m[2]!.replaceAll(dir, "<checkout>") } };
  } catch (e) {
    d.log(`loaded の判定に失敗（測る）: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/**
 * Where the commits of a PR and the PRs below it start: HEAD's fork from the default branch. A stacked PR's base is the
 * branch below it, so a diff from that base would leave out the PRs below (#3297).
 */
export async function mainFork(dir: string, repo: string, sh: Deps["sh"]): Promise<string> {
  const main = (await sh(["gh", "repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
  await sh(["git", "-C", dir, "fetch", "-q", "origin", `refs/heads/${main}`]);
  return (await sh(["git", "-C", dir, "merge-base", "FETCH_HEAD", "HEAD"])).trim();
}

/** The steps with `bun test` given `files` only: `./` makes each an exact path (bun takes a bare one as a substring). None to run → an echo. */
export function narrowTestStep(steps: Step[], files: string[]): Step[] {
  if (!steps.some((s) => s.run.trim() === "bun test")) throw new Error("CI の手順に `bun test` が無い（narrowTestStep）");
  const run = files.length ? `bun test ${files.map((f) => `'./${f.replaceAll("'", `'\\''`)}'`).join(" ")}` : 'echo "no test files selected"';
  return steps.map((s) => (s.run.trim() === "bun test" ? { ...s, run } : s));
}

/** The steps with perf-bench told to skip `loaded` and why (#3635); a checkout without that step keeps its steps. */
export function narrowPerfStep(steps: Step[], reason: string): Step[] {
  const arg = `'${reason.replaceAll("'", `'\\''`)}'`;
  return steps.map((s) => (s.run.trim().startsWith("bun scripts/perf-bench.ts") ? { ...s, run: `${s.run.trim()} --skip-loaded ${arg}` } : s));
}

/** What the result's table calls the comparison of the seconds, which no step of the CI runs. */
export const DURATION_STEP = "所要時間の上限（perf-budget.json の local.durations）";

/** The seconds over the `local` ceilings of the budget in `dir`, as `over:` lines (failLines' form); none without that budget. */
export async function durationOver(dir: string, seconds: StepSeconds): Promise<string[]> {
  const path = join(dir, "scripts/perf-budget.json");
  if (!existsSync(path)) return [];
  const { local } = (await Bun.file(path).json()) as Partial<Budgets>;
  return judgeDurations(seconds, local ?? { journeys: {} }).map((i) => `over: ${i.key} = ${i.value} > ceiling ${i.ceiling}`);
}

/**
 * A local change (#2488) instead of a PR: its head and base read from the app with the checkout's own branches (no
 * fetch: there is no remote), `label` naming its worktrees and logs. Its tests are chosen against the base's tip, and
 * no bundle row is recorded (that is a GitHub records branch).
 */
export interface ChangeTarget { label: string; read: () => Promise<{ head: string; base: string }> }

/** `cache`: where the worktree and the failure logs go (~/.cache; tests give their own). TMPDIR goes under tmpdir() (#1056). */
export async function localCi(pr: number, repoRoot: string, d: Deps, repo: string, cache = join(homedir(), ".cache"), opts: { all?: boolean; change?: ChangeTarget } = {}): Promise<LocalCiResult> {
  const change = opts.change;
  // one slot for the whole run: the PR's steps and main's measure after them (measureBase) are not cut in between by
  // another heavy job, while this run's worktrees are still there. The head and base are read once it is held: a wait
  // must not leave the run on the head and base of before it
  return d.slot(change ? `local-ci ${change.label}` : `local-ci ${repo}#${pr}`, async () => {
    const { head: sha, base } = change ? await change.read() : await readTarget(pr, repoRoot, repo, d);
    // ~/.cache need not exist (a fresh GitHub runner has none, 2026-09-28)
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, change ? `switchboard.${change.label}.` : `switchboard.local-ci-${pr}.`));
    const tmp = mkdtempSync(join(tmpdir(), `switchboard.local-ci-${pr}-tmp.`));
    try {
      await d.sh(["git", "-C", repoRoot, "worktree", "add", "-q", "--detach", dir, base]);
      // what Actions' pull_request run tests, merged here (an identity and no signing of its own: the clone's settings do not decide it)
      const merge = ["git", "-C", dir, "-c", "user.name=local-ci", "-c", "user.email=local-ci@localhost", "-c", "commit.gpgSign=false", "merge", "-q", "--no-ff", "--no-edit", sha];
      const failure = await d.sh(merge).then(() => undefined, (e: unknown) => e);
      // a conflict leaves unmerged paths; any other failure of the merge is an error, not the PR's conflict
      if (failure && !(await d.sh(["git", "-C", dir, "diff", "--name-only", "--diff-filter=U"])).trim()) throw failure;
      if (failure) {
        d.log(`✗ head ${sha.slice(0, 7)} を base ${base.slice(0, 7)} にマージできない（衝突）`);
        return { sha, base, results: [], ok: false, conflict: true };
      }
      const env = stepEnv(tmp);
      const selection = opts.all ? undefined : await selectTests(dir, () => (change ? Promise.resolve(base) : mainFork(dir, repo, d.sh)), env, d);
      const narrowed = selection ? { selection } : {};
      const skipLoaded = selection?.loaded?.run === false ? selection.loaded.reason : undefined;
      const run = await runCheckout(dir, env, change ? change.label : `local-ci-${repo.replaceAll("/", "_")}-${pr}`, d, cache, selection?.files, skipLoaded);
      const { results } = run;
      const bundle = run.bundle.length ? { bundle: run.bundle } : {};
      // a checkout with scripts/ci.ts (this repository's CI) must have both steps; another repository's (--repo) need not
      if (run.ok) {
        const seconds = existsSync(join(dir, "scripts/ci.ts")) ? stepSeconds(results) : undefined;
        // a narrowed bun test's seconds say nothing against the ceiling of all of them; the ceilings are on the high side only
        const over = seconds ? await durationOver(dir, selection?.files ? { ...seconds, test: 0 } : seconds) : [];
        if (over.length === 0) return { sha, base, results, ok: true, ...(seconds ? { seconds } : {}), ...narrowed, ...bundle };
        for (const l of over) d.log(l);
        d.log(`✗ ${DURATION_STEP}`);
        // a result of its own: the comment names it, and the exit (ciExit) reads the results
        return { sha, base, results: [...results, { name: DURATION_STEP, run: "", code: 1, seconds: 0, tail: over.join("\n"), fails: over }], ok: false, ...narrowed, ...bundle };
      }
      // the first perf step that failed: a failed bench is the cause, the check after it only finds no result
      const result = results.find((x) => x.code !== 0 && isPerfStep(x));
      if (run.perf && result) {
        // over only: main measured the same way tells an environment's (or main's) excess from the PR's own
        const logDir = dirname(result.log!);
        const baseline = run.perf.over.length ? await measureBase(pr, repoRoot, base, perfSteps(run.steps), env, logDir, cache, d) : undefined;
        const summary = failureSummary({ sha, base, step: result, env, output: run.outputs[result.name]!, perf: run.perf, baseline });
        await Bun.write(join(logDir, "summary.md"), `${summary}\n`);
        d.log(summary);
        d.log(`記録: ${logDir}`);
        d.log(`✗ ${result.name}: exit ${result.code}`);
        return { sha, base, results, ok: false, perf: run.perf, baseline, ...narrowed, ...bundle };
      }
      return { sha, base, results, ok: false, ...narrowed, ...bundle };
    } finally {
      // main's bundle as this run measured it, pass or fail (docs/design/perf.md の「bundle の推移」); never the run's result
      await (async () => (change || forgeTargetOf(repoRoot, originOf(repoRoot)).service === "gitlab" ? "none" : recordBundle(repo, dir, new Date().toISOString(), d.sh)))().then(
        (r) => r === "recorded" && d.log(`bundle の記録: ${RECORDS_BRANCH}/${RECORDS_PATH} に 1 行足した`),
        (e: unknown) => d.log(`bundle の記録に失敗（結果は変えない）: ${e instanceof Error ? e.message : String(e)}`),
      );
      await d.sh(["git", "-C", repoRoot, "worktree", "remove", "--force", dir]).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/**
 * Appends one row (when, js, css, main's sha) to bundle.tsv on the records branch of `repo` (#3169), from the
 * perf-base.json the CI wrote in `dir` (main's tip measured in the same run); "none" without that file. The branch is
 * made once (a root commit with a README, never merged). A measure is a row: the same main measured twice is two rows.
 * The file goes by the contents API with its sha; a 409 or 422 (another run wrote first, or made the file first) reads
 * it again and puts once more. A file the API no longer returns in base64 (over 1 MB) is an error, not an empty file:
 * putting a row on it would replace every row.
 */
export async function recordBundle(repo: string, dir: string, measuredAt: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-base.json");
  if (!existsSync(file)) return "none";
  const row = recordRow(measuredAt, JSON.parse(readFileSync(file, "utf8")) as { sha: string; bundle: { js: number; css: number } });
  const api = (...a: string[]) => sh(["gh", "api", ...a]);
  const http = (code: number) => (e: unknown) => new RegExp(`HTTP ${code}\\b`).test(e instanceof Error ? e.message : String(e));
  const absent = <T>(e: unknown): T | undefined => {
    if (http(404)(e)) return undefined;
    throw e;
  };
  if (!(await api(`repos/${repo}/git/ref/heads/${RECORDS_BRANCH}`).then(() => true, absent<boolean>))) {
    const sha = async (...a: string[]) => (await api(...a, "-q", ".sha")).trim();
    const blob = await sha(`repos/${repo}/git/blobs`, "-f", "content=perf records; never merged", "-f", "encoding=utf-8");
    const tree = await sha(`repos/${repo}/git/trees`, "-f", "tree[][path]=README", "-f", "tree[][mode]=100644", "-f", "tree[][type]=blob", "-f", `tree[][sha]=${blob}`);
    const commit = await sha(`repos/${repo}/git/commits`, "-f", `message=${RECORDS_BRANCH}: root`, "-f", `tree=${tree}`);
    // 422: another run made the branch in between
    await api(`repos/${repo}/git/refs`, "-f", `ref=refs/heads/${RECORDS_BRANCH}`, "-f", `sha=${commit}`).catch((e: unknown) => {
      if (!http(422)(e)) throw e;
    });
  }
  const work = mkdtempSync(join(tmpdir(), "switchboard.perf-record."));
  try {
    for (let attempt = 1; ; attempt++) {
      type File = { sha: string; content: string; encoding?: string };
      const now = await api(`repos/${repo}/contents/${RECORDS_PATH}?ref=${RECORDS_BRANCH}`).then((o) => JSON.parse(o) as File, absent<File>);
      if (now && now.encoding !== "base64") throw new Error(`${RECORDS_BRANCH}/${RECORDS_PATH} を contents API で読めない（encoding ${now.encoding ?? "なし"}。1 MB を超えたら分ける）。書かない`);
      const text = now ? Buffer.from(now.content.replace(/\s/g, ""), "base64").toString("utf8") : `${RECORDS_HEADER}\n`;
      const body = { message: `${RECORDS_BRANCH}: bundle ${measuredAt}`, branch: RECORDS_BRANCH, content: Buffer.from(`${text}${text.endsWith("\n") ? "" : "\n"}${row}\n`).toString("base64"), ...(now ? { sha: now.sha } : {}) };
      // the body by a file: the whole file in base64 does not fit in the arguments for long
      const input = join(work, "put.json");
      writeFileSync(input, JSON.stringify(body));
      try {
        await api("-X", "PUT", `repos/${repo}/contents/${RECORDS_PATH}`, "--input", input);
        return "recorded";
      } catch (e) {
        if (attempt > 1 || !(http(409)(e) || http(422)(e))) throw e;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A checkout's CI in `dir` (#2953; local-ci's merge, tag-ci's tag): its steps (`checkoutSteps`) run with `env` until one
 * without `keepGoing` fails (`runCi`). Each failed step's whole output goes to one log dir `switchboard.<label>-log.*`
 * under `cache` (the latest of a label only: earlier ones go, the host's disk is small) and, for a perf step, its verdict
 * and perf-result.json there. A failure that is not a perf step is logged here; a perf step's is the caller's (local-ci
 * adds main's measure to it). `outputs`: each failed step's whole output by its name.
 * `tests`: only those test files for `bun test` (local-ci); none, or null = every test. `skipLoaded`: perf-bench skips
 * `loaded` for this reason (local-ci, #3635); none = it measures it.
 * `bundle`: the perf check's `bundle:` and `grew:` lines, whether it passed or not (none without that check).
 */
export async function runCheckout(dir: string, env: Record<string, string>, label: string, d: Omit<Deps, "slot">, cache: string, tests?: string[] | null, skipLoaded?: string): Promise<{ steps: Step[]; results: StepResult[]; ok: boolean; perf?: PerfVerdict; outputs: Record<string, string>; bundle: string[] }> {
  const listed = await checkoutSteps(dir, env);
  const narrowed = tests ? narrowTestStep(listed, tests) : listed;
  const steps = skipLoaded === undefined ? narrowed : narrowPerfStep(narrowed, skipLoaded);
  const ran = await runCi(steps, async (s) => {
    d.log(`▶ ${s.name}`);
    const started = Date.now();
    const r = await d.step(s.run, dir, env);
    return { code: r.code, output: r.output, seconds: (Date.now() - started) / 1000, tail: r.output.split("\n").slice(-30).join("\n") };
  });
  const results: StepResult[] = ran.map(({ output: _, ...r }) => r);
  const check = ran.find(isPerfCheck);
  const bundle = check ? check.output.split("\n").filter((l) => l.startsWith("bundle: ") || l.startsWith("grew: ")) : [];
  const failedAt = ran.flatMap((x, i) => (x.code === 0 ? [] : [i]));
  if (failedAt.length === 0) return { steps, results, ok: true, outputs: {}, bundle };
  // a 1,400-test run's failures do not fit in its last 30 lines
  const prefix = `switchboard.${label}-log.`;
  for (const old of readdirSync(cache)) if (old.startsWith(prefix)) rmSync(join(cache, old), { recursive: true, force: true });
  const logDir = mkdtempSync(join(cache, prefix));
  const outputs: Record<string, string> = {};
  let perf: PerfVerdict | undefined;
  for (const i of failedAt) {
    const failed = ran[i]!;
    const result = results[i]!;
    outputs[failed.name] = failed.output;
    result.fails = failLines(failed.output);
    result.log = join(logDir, `${i + 1}-${failed.name.replace(/[^\w.-]/g, "_")}.log`);
    await Bun.write(result.log, failed.output);
    if (isPerfStep(failed)) {
      // a bench that failed judged nothing; the check after it then reads no result, so the first perf failure is kept
      perf ??= isPerfCheck(failed) ? perfVerdict(failed.output) : { ...perfVerdict(""), unknown: true };
      continue;
    }
    for (const l of result.fails) d.log(l);
    d.log(result.tail);
    d.log(`全文: ${result.log}`);
    d.log(`✗ ${failed.name}: exit ${failed.code}`);
  }
  // the measured values are kept before the worktree goes
  if (perf && existsSync(join(dir, "perf-result.json"))) copyFileSync(join(dir, "perf-result.json"), join(logDir, "perf-result.json"));
  return { steps, results, ok: false, ...(perf ? { perf } : {}), outputs, bundle };
}

/** Runs `steps` on `base` in its own worktree with the PR's environment; each step's output and the result JSON go to `logDir` as base-*. */
async function measureBase(pr: number, repoRoot: string, base: string, steps: Step[], env: Record<string, string>, logDir: string, cache: string, d: Deps): Promise<Baseline> {
  const dir = mkdtempSync(join(cache, `switchboard.local-ci-${pr}-base.`));
  try {
    await d.sh(["git", "-C", repoRoot, "worktree", "add", "-q", "--detach", dir, base]);
    for (const [i, s] of steps.entries()) {
      d.log(`▶ main ${s.name}`);
      const r = await d.step(s.run, dir, env);
      await Bun.write(join(logDir, `base-${i + 1}-${s.name.replace(/[^\w.-]/g, "_")}.log`), r.output);
      if (existsSync(join(dir, "perf-result.json"))) copyFileSync(join(dir, "perf-result.json"), join(logDir, "perf-result.base.json"));
      // a check that passes judged main within every ceiling
      if (isPerfCheck(s)) return { sha: base, verdict: r.code === 0 ? { ...perfVerdict(r.output), unknown: false } : perfVerdict(r.output) };
      if (r.code !== 0) return { sha: base, verdict: null };
    }
    return { sha: base, verdict: null };
  } catch (e) {
    // the PR's failure is summarized whatever happened to main's measure
    d.log(`main の計測が止まった: ${e instanceof Error ? e.message : String(e)}`);
    return { sha: base, verdict: null };
  } finally {
    await d.sh(["git", "-C", repoRoot, "worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The whole environment of a step: PATH and HOME from here, external recordings only when supplied, CI=true as on the runner, TMPDIR its own dir. */
export function stepEnv(tmp: string, from: Record<string, string | undefined> = process.env): Record<string, string> {
  return { PATH: from.PATH ?? "", HOME: homedir(), ...(from.SWITCHBOARD_FIXTURES === undefined ? {} : { SWITCHBOARD_FIXTURES: from.SWITCHBOARD_FIXTURES }), CI: "true", TMPDIR: tmp };
}

/** Why the target cannot be run: exit 2, nothing posted. */
export class TargetError extends Error {}

/** owner/name of a GitHub remote URL (https or ssh), or undefined. */
export function remoteRepo(url: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/**
 * The URL of the PR's newest result when it is of the head as it is and merge-gate counts it (`localCiOf`, this PR as its
 * own top): a later fail runs (#1882); a base that moved under the same head does not (#3118).
 */
export async function existingPass(pr: number, repo: string, run: Deps["sh"]): Promise<string | undefined> {
  const view = JSON.parse(await run(["gh", "pr", "view", String(pr), "-R", repo, "--json", "headRefOid,comments"])) as {
    headRefOid: string;
    comments: Array<{ body: string; createdAt: string; url: string; authorAssociation?: string }>;
  };
  const marks = view.comments.filter((c) => MARK_AUTHORS.includes(c.authorAssociation ?? ""));
  const newest = newestLocalCi(marks);
  if (newest?.m[2] !== view.headRefOid) return undefined;
  // the pass is of this head: its commits are the PR's as they are (no git cherry to run)
  const counted = await localCiOf(pr, pr, marks, () => Promise.reject(new Error("unused: the PR is its own top")), repo, async () => true);
  return counted.pass ? newest.c.url : undefined;
}

/** The pass to reuse: none with `--force` or `--all` (a narrowed pass is not what it asks for), on GitLab, or when unreadable (a normal run). */
export async function reusablePass(t: { pr: number; repo: string; root: string; all?: true; force?: true }, run: Deps["sh"]): Promise<string | undefined> {
  if (t.force || t.all || forgeTargetOf(t.root, originOf(t.root)).service === "gitlab") return undefined;
  return existingPass(t.pr, t.repo, run).catch(() => undefined);
}

/** The PR, the repository and its clone from the arguments: `<PR> [--repo <owner/name>] [--all] [--force]`. */
export async function resolveTarget(argv: string[], cwd: string, scriptRoot: string, run: Deps["sh"]): Promise<{ pr: number; repo: string; root: string; all?: true; force?: true }> {
  const args = argv.filter((a) => a !== "--all" && a !== "--force");
  const flags = {
    ...(argv.includes("--all") ? { all: true as const } : {}),
    ...(argv.includes("--force") ? { force: true as const } : {}),
  };
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  if (!pr) throw new TargetError("PR 番号が無い");
  const at = args.indexOf("--repo");
  // anything else (--repo=o/r, a typo) would fall back to this repository and post on its PR of that number
  const unknown = args.filter((a, i) => a !== String(pr) && (at < 0 || (i !== at && i !== at + 1)));
  if (unknown.length > 0) throw new TargetError(`知らない引数: ${unknown.join(" ")}`);
  if (at < 0) {
    // the clone this script is in and its origin: the PR's head (refs/pull/<n>/head) and its base (refs/heads/<base>) are
    // fetched from that origin, and the result goes on its PR
    // a GitLab checkout (#892): the project its forge names, checked against the origin
    let named;
    try {
      named = forgeTargetOf(scriptRoot, originOf(scriptRoot));
    } catch (e) {
      throw new TargetError((e as Error).message);
    }
    if (named.service === "gitlab") return { pr, repo: named.repository!, root: scriptRoot, ...flags };
    // a forge naming the app (#2488): its changes have no PR, and the result would go on the change of the same number
    // (one without a forge or an origin fails below: no origin to read)
    if (named.service === LOCAL_SERVICE) throw new TargetError(`${scriptRoot} の変更はアプリにある（PR は無い）。--change <n> で回す`);
    const url = (await run(["git", "-C", scriptRoot, "remote", "get-url", "origin"]).catch(() => "")).trim();
    const repo = remoteRepo(url);
    if (!repo) throw new TargetError(`${scriptRoot} の origin（${url ? "GitHub の owner/name として読めない URL" : "無し"}）から対象が分からない（--repo <owner/name> を付ける）`);
    return { pr, repo, root: scriptRoot, ...flags };
  }
  const repo = args[at + 1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new TargetError(`--repo は owner/name の形で: ${repo || "（空）"}`);
  const root = (await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => {
    throw new TargetError(`${cwd} は git の作業ツリーでない（${repo} の作業ツリーから実行する）`);
  })).trim();
  // the same for --repo; a checkout without an origin fails below. A forge that cannot be read, or a GitLab one of
  // another origin, is the target's error (exit 2), as without --repo
  let service: string;
  try {
    service = forgeTargetOf(root, originOf(root)).service;
  } catch (e) {
    throw new TargetError((e as Error).message);
  }
  if (service === LOCAL_SERVICE) throw new TargetError(`${root} の変更はアプリにある（PR は無い）。--change <n> で回す`);
  const url = (await run(["git", "-C", root, "remote", "get-url", "origin"]).catch(() => "")).trim();
  const origin = remoteRepo(url);
  if (origin?.toLowerCase() !== repo.toLowerCase()) {
    throw new TargetError(`${root} の origin（${origin ?? (url ? "GitHub の owner/name として読めない URL" : "無し")}）が --repo ${repo} と違う（${repo} の作業ツリーから実行する）`);
  }
  return { pr, repo, root, ...flags };
}

export const sh: Deps["sh"] = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out;
};

// GitHub runs a `run:` with `bash -e {0}`. tag-ci runs its steps the same way.
export const stepWithIdle = (idleSeconds: number): Deps["step"] => async (script, cwd, env) => {
  // stdout then stderr, not as they came: a stderr line landing inside a stdout line would hide a (fail) or over: from failLines
  const out = { stdout: "", stderr: "" };
  const { code, idleKilled } = await runIdle(["bash", "-e", "-c", script], { cwd, env, idleSeconds, onData: (chunk, stream) => { out[stream] += chunk; } });
  return { code, output: `${out.stdout}${out.stderr}${idleKilled ? `\n${IDLE_KILLED_LINE(idleSeconds)}\n` : ""}` };
};
export const step = stepWithIdle(STEP_IDLE_SECONDS);

/**
 * Posts a result on the PR as a forge `verification` (#920): the service is the target repository's `ops.config.json`
 * `forge` (none = GitHub); one without a verification is said, not posted some other way. The texts go through the
 * kit's check for values usable for auth first.
 */
export async function reportResult(t: { pr: number; repo: string; root: string }, body: string, run: Deps["sh"], glab: Sh = runGlab, backlog: BacklogAccess = { env: process.env }): Promise<void> {
  // the repository is the origin's on github.com (`remoteRepo`), the one refs/heads/<base> and refs/pull/<n>/head are
  // fetched from; a GitLab project is its `forge`'s, checked against the origin (#924): the note goes on the MR `pr`.
  // A checkout whose changes the app keeps (#2488, forgeOf): the change `pr` of the workspace `repo`
  const named = forgeOf(t.root) === LOCAL_SERVICE ? { service: LOCAL_SERVICE, host: "local", repository: t.repo } : forgeTargetOf(t.root, originOf(t.root));
  const target = named.repository ? named : { ...named, host: "github.com", repository: t.repo };
  await runForgeOperation({ kind: "verification", target, texts: [body], payload: { pr: t.pr, body } }, { github: githubForge((cmd) => run(cmd)), gitlab: gitlabForge(glab), [LOCAL_SERVICE]: appForge(backlog.env, backlog.fetch) }, hostAws());
}

/**
 * Posts the run's result only if it still names the PR's head and base (#913): either moved since the run → nothing
 * posted (a pass for an old head or base would be taken for the new one), false. Which PRs of a stack the pass covers is
 * merge-gate's to work out with git (#3118), not written here.
 */
export async function notify(t: { pr: number; repo: string; root: string }, r: LocalCiResult, d: Pick<Deps, "sh" | "log">, post = reportResult, read = () => readTarget(t.pr, t.root, t.repo, d)): Promise<boolean> {
  const now = await read().catch((e: unknown) => (d.log(`head / base を読み直せない: ${e instanceof Error ? e.message : String(e)}`), undefined));
  if (!now) return false;
  if (now.head !== r.sha || now.base !== r.base) {
    d.log(`実行中に変わった（head ${r.sha.slice(0, 7)} → ${now.head.slice(0, 7)}、base ${r.base.slice(0, 7)} → ${now.base.slice(0, 7)}）。結果を投稿しない（回し直す）`);
    return false;
  }
  const body = resultComment(r);
  await post(t, body, d.sh);
  d.log(body);
  return true;
}

/** The app the kit's backlog client reads a local change from (#2488): its env (BACKLOG_URL, BACKLOG_WORKSPACE, the key's file) and, in tests, its fetch. */
export interface BacklogAccess { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }

/**
 * `--change <n>` (#2488): a local change of the checkout `cwd` is in, run as a PR is — its head merged into its base's
 * tip in a worktree of its own — and the result posted on the change (the app's verification, `reportResult`). Nothing
 * is fetched and gh is never called. A pass of the same head and base already there is not run again (`--force` /
 * `--all` run it). Exit codes as `main`'s.
 */
export async function changeMain(args: string[], at: number, cwd: string, d: Deps, backlog: BacklogAccess, cache?: string): Promise<number> {
  const value = args[at + 1] ?? "";
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (!/^\d+$/.test(value) || rest.some((a) => a !== "--all" && a !== "--force")) {
    console.error("usage: bun scripts/local-ci.ts --change <n> [--all] [--force]（PR の番号・--repo とは一緒に使えない）");
    return 2;
  }
  const n = Number(value);
  let root: string;
  let first: Awaited<ReturnType<typeof readChangeDetail>>;
  try {
    root = (await d.sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    // the result goes where the checkout's changes are: never on a PR of the same number
    if (forgeOf(root) !== LOCAL_SERVICE) throw new Error(`${root} の変更はアプリに無い（forge が ${forgeOf(root)}）。PR は番号で回す`);
    first = await readChangeDetail(n, backlog.env, { fetch: backlog.fetch, cwd });
  } catch (e) {
    console.error(`対象を読めない: ${(e as Error).message}`);
    return 2;
  }
  const read = async () => {
    const c = await readChangeDetail(n, backlog.env, { fetch: backlog.fetch, cwd });
    return { head: c.changeRefs.head!, base: c.changeRefs.base! };
  };
  const workspace = (first as { workspaceId?: string }).workspaceId ?? backlog.env.BACKLOG_WORKSPACE ?? "local";
  const label = `local-ci-change-${workspace.replace(/[^\w.-]/g, "_")}-${n}`;
  if (!args.includes("--force") && !args.includes("--all") && localCiOfChange(first.comments, first.changeRefs.head!, first.changeRefs.base!).pass) {
    d.log(`既に pass（#${n} の今の head と base）。回し直すなら --force`);
    return 0;
  }
  const r = await localCi(n, root, d, workspace, cache, { all: args.includes("--all"), change: { label, read } });
  const t = { pr: n, repo: workspace, root };
  try {
    if (!(await notify(t, r, d, (t, body, run) => reportResult(t, body, run, runGlab, backlog), read))) return 1;
  } catch (e) {
    console.error(`結果を変更 #${n} に投稿できなかった: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return r.conflict ? 1 : ciExit(r.results);
}

/**
 * The command: its exit code. 2 = the target cannot be run (nothing posted), 1 = a failure, a conflict, a result not
 * posted (moved, or the post failed), 0 = a pass posted or one already there. `scriptRoot`: the clone without --repo.
 * `cache`: where the run's worktrees and logs go (~/.cache; tests give their own).
 */
export async function main(args: string[], cwd: string, d: Deps, post = reportResult, scriptRoot = join(import.meta.dir, ".."), cache?: string, backlog: BacklogAccess = { env: process.env }): Promise<number> {
  const changeAt = args.indexOf("--change");
  if (changeAt >= 0) return changeMain(args, changeAt, cwd, d, backlog, cache);
  let t: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    t = await resolveTarget(args, cwd, scriptRoot, d.sh);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    console.error(`${e.message}\nusage: bun scripts/local-ci.ts <PR> [--repo <owner/name>] [--all] [--force]`);
    return 2;
  }
  const url = await reusablePass(t, d.sh);
  if (url) {
    d.log(`既に pass（${url}）。回し直すなら --force`);
    return 0;
  }
  const r = await localCi(t.pr, t.root, d, t.repo, cache, { all: t.all });
  try {
    if (!(await notify(t, r, d, post))) return 1;
  } catch (e) {
    // authentication or permission: said and stopped, not tried another way
    console.error(`結果を PR に投稿できなかった（認証・権限を確かめる）: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // the same exit as Actions' entry (#912); a conflict ran nothing and is a failure
  return r.conflict ? 1 : ciExit(r.results);
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.cwd(), { sh, step, log: (l) => console.log(l), slot: (name, fn) => withHeavySlot(name, fn) }));
}
