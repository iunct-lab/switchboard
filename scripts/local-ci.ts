/**
 * CI on this machine when GitHub Actions does not start: `bun scripts/local-ci.ts <PR>` runs the `run:` steps of
 * .github/workflows/ci.yml — its `bun scripts/ci.ts` step as that checkout's scripts/ci.ts steps, the ones Actions runs
 * — on what Actions' pull_request run tests: the PR's latest head merged into its base branch's latest tip, merged
 * here (GitHub's pull/<n>/merge is not needed) — in a throwaway worktree under ~/.cache (not /tmp: a small RAM
 * tmpfs on the cloud host) with TMPDIR under the OS's temp dir (the one the `local` perf ceilings were measured with:
 * on the disk, launch.layoutShift goes over), with only PATH and HOME from this environment, plus the external
 * recordings directory only when supplied (a daemon's SWITCHBOARD_* would change what the tests see).
 * The result goes on the PR whether or not Actions ran: all green → `[local-ci] pass <head sha> base=<base sha>`, which
 * merge-gate takes in place of an Actions CI that never started; a failure or a conflict → `[local-ci] fail <head sha>
 * base=<base sha>` and exit 1. Before posting, head and base are read again: a head that moved → nothing posted, exit 1
 * (run again); a base that alone moved → posted with the base it ran on (merge-gate reads that `base=`). Each failed
 * step's whole output stays in a log dir under ~/.cache (a perf step's failure does not stop `bun test`, so a run can have two); the perf steps do not run here (the tag CI's).
 * After every step passed, the type check's and bun test's seconds are compared with the `local` ceilings of the checkout's
 * scripts/perf-budget.json, bun test's only when every test ran: over one → still a pass, with the `over:`
 * lines as a warning in the comment (`warnings`). A checkout without that file or those ceilings is not compared.
 * `bun test` runs the tests of the checkout's scripts/test-select.ts for what the PR and the PRs below it changed; a
 * change it cannot judge, or a selection that cannot be read, runs all of them, and so does `--all`. Only this script
 * narrows: tag-ci's `runCheckout` runs every test, and the other steps run, except in an incremental run (below).
 * Incremental run: when the PR's newest result is a pass of an earlier head and the commits added since (`git cherry`) hold no
 * merge commit the pass lacks, `bun test` is chosen from those commits' files only and only the install, the type check,
 * the quick tree checks (`INCREMENTAL_ALSO`) and that `bun test` run; the other steps are the tag CI's (`incrementalBase`, `incrementalSteps`). A change the
 * selection cannot judge, `--all`, `--change` or a missing earlier pass run every step. The mark is the usual pass.
 * A head whose newest result merge-gate already counts as a pass is not run again (`existingPass`): `--force` runs
 * it, and `--all` does too (a narrowed pass is not what it asks for). GitHub only.
 * A checkout whose `ops.config.json` has `ci.steps` runs those instead of ci.yml's (a repository that keeps no CI on
 * GitHub); a checkout without that file runs the `ci.steps` of the settings Switchboard keeps for its workspace (nothing
 * is committed to the repository; the comment then names the workspace and the steps' hash), else ci.yml's; one with
 * none of them exits 2 with one line naming where they go, nothing posted.
 * A build off the host that could not be started (sb-offload's own failure, before any step) is no result: nothing is
 * posted and the exit is 2.
 * `--repo <owner/name>`: another repository's PR, run from that repository's working tree (its origin must be
 * owner/name); the mark goes on that PR. Without it: the repository of the clone this script is in (that clone's
 * origin), run in that clone.
 * On the cloud host (`sb-offload` on PATH) every step of the CI runs off the host in one build, in the CI's order: here only the
 * work tree is made and the result read (docs/design/local-ci-offload.md).
 * What does not decide the result goes in support files (merge-gate's `security:gate-support`): the tag CI's records in
 * scripts/local-ci-records.ts, the lines added to a comment in scripts/local-ci-notes.ts, the tools that run the build off
 * the host in scripts/local-ci-offload.ts.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { forgeOf, forgeTargetOf, LOCAL_SERVICE, originOf, runForgeOperation } from "../ops-kit/src/forge.ts";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { gitlabForge, runGlab, viewGitlabMr, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { githubForge } from "../ops-kit/src/forge-github.ts";
import { appForge } from "../ops-kit/src/forge-app.ts";
import { CiConfig, CONFIG_FILE, ciStepsHash } from "../ops-kit/src/config.ts";
import { type WorkspaceSettings, workspaceSettingsOf } from "./workspace-settings.ts";
import { IDLE_KILLED_LINE, runIdle } from "../ops-kit/src/idle-run.ts";
import { hostAws } from "../ops-kit/src/secrets.ts";
import { ciExit, runCi, STEP_IDLE_SECONDS, type Step } from "./ci.ts";
import { durationOver, notStartedLines, perfVerdict, type PerfVerdict, SECONDS_STEPS, type StepSeconds, stepSeconds } from "./local-ci-notes.ts";
import { readChangeDetail, sharedMoved } from "./merge-gate.ts";
import { sharedFilesOf } from "../ops-kit/src/config.ts";
import { mergeRecords, type MergeRecordJob } from "../ops-kit/src/merge-records.ts";
import { homeOf } from "../packages/core/src/config.ts";
import { mergeRecordsEnv } from "./merge-records-env.ts";
import { isTest } from "./test-select.ts";
import { BUILD_LOG_KEEP_MS, bootId, buildFiles, buildSpoke, clearPending, hostOffload, offloadReason, type Offload, type Pending, pendingDirOf, pendingFor, readPendingFile, recordLive, runBuild, writePending } from "./local-ci-offload.ts";
import { listedIn } from "./file-size.ts";
import { knownLines, readKnownFailures, subtractKnown, type Subtracted } from "./known-failures.ts";

export type { Step };

/** A result's first line: pass or fail, the head, then the base it was merged into. A mark without the base is none. */
export const LOCAL_CI_RESULT = /^\[local-ci\] (pass|fail) ([0-9a-f]{40}) base=([0-9a-f]{40})(?=\s|$)/;

/** `log` = where the whole output of a step that failed was kept, `fails` = its failLines; passing steps keep nothing. */
export interface StepResult extends Step { code: number; seconds: number; tail: string; log?: string; fails?: string[] }

/** The lines of a step's output that name what failed: bun test's `(fail)` lines, perf-ratchet's `over:` / `raised:` / `improved:` / `grew:` lines, idle-run's reason and an off-host build's end (`sb-offload: exit`), once each, in order. */
export function failLines(output: string): string[] {
  const perf = (l: string) => l.includes("over:") || l.startsWith("raised: ") || l.startsWith("improved: ") || l.startsWith("grew: ");
  return [...new Set(output.split("\n").filter((l) => l.startsWith("(fail)") || perf(l) || l.startsWith("無進捗で打ち切り") || l.startsWith("sb-offload: exit ")))];
}

/** The perf bench, main's measure (`perf-ratchet.ts base`) or the ratchet's check: their failure gets a verdict (a bench or base failure is one with no judgement). */
export const isPerfStep = (s: Step) => /scripts\/perf-(bench|ratchet)\.ts/.test(s.run);
/** The ratchet's check alone: the step whose output has the verdict and the bundle lines. */
export const isPerfCheck = (s: Step) => s.run.includes("perf-ratchet") && s.run.includes(" check ");

/**
 * The steps without the perf ones (the web build up to the last perf step; the install stays, bun test and the rest are
 * not between) and without `fetch main`, which comes before file sizes: a PR's run compares file sizes with the default
 * branch's tip that localCi fetched (FILE_SIZE_BASE_REF), and off the host with its list, so it fetches nothing. A CI without them is returned as it is.
 */
export function withoutPerf(steps: Step[]): Step[] {
  const build = steps.findIndex((s) => s.run.trim() === "bun run --cwd apps/web build");
  const last = steps.map((s) => isPerfStep(s)).lastIndexOf(true);
  if (build < 0 || last < build) return steps;
  return [...steps.slice(0, build), ...steps.slice(last + 1)].filter((s) => s.name !== "fetch main");
}

/** The base's list of over-limit files (`STILL_OVER` of scripts/file-size.ts at `ref` in `dir`), or undefined with a line of the log saying why there is none. */
export async function fileSizeBaseOf(dir: string, ref: string, d: Pick<Deps, "sh" | "log">): Promise<Record<string, number> | undefined> {
  const text = await d.sh(["git", "-C", dir, "show", `${ref}:scripts/file-size.ts`]).catch((e: unknown) => {
    d.log(`file sizes: ${ref}:scripts/file-size.ts を読めない: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    return undefined;
  });
  if (text === undefined) return undefined;
  const list = listedIn(text);
  if (!list) d.log(`file sizes: ${ref}:scripts/file-size.ts に STILL_OVER が無い`);
  return list ?? undefined;
}

/** The step of ci.yml that runs scripts/ci.ts: Actions runs those steps in one go, local-ci one by one. */
export const SHARED_ENTRY = "bun scripts/ci.ts";

/** A checkout whose CI steps cannot be read: none in `ops.config.json`'s `ci.steps` nor in ci.yml, or `ci` is not in its shape. */
export class NoCiSteps extends Error {}

/** Where a checkout keeps its CI's steps, for the message of `NoCiSteps`. */
export const CI_STEPS_PLACES = "リポジトリの `ops.config.json` の `ci.steps`、リポジトリに何も置かないなら Switchboard の側の workspace の設定（設定の Workspace の行の「設定（Switchboard の側）」）の `ci.steps`（GitHub と連携するなら `.github/workflows/ci.yml`）";

/**
 * The steps of `ops.config.json`'s `ci.steps` in `dir`, or null when the file or the key is not there. Only
 * `ci` is read (as `loadPublicSync` reads its key): another key's mistake is not the CI's to refuse.
 */
export function configSteps(dir: string): Step[] | null {
  return fileSteps(join(dir, CONFIG_FILE), CONFIG_FILE);
}

/** `ci.steps` of the settings file `file` (`named` in the messages), or null when the file or the key is not there. */
function fileSteps(file: string, named: string): Step[] | null {
  if (!existsSync(file)) return null;
  let json: { ci?: unknown } | null;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as { ci?: unknown } | null;
  } catch (e) {
    throw new NoCiSteps(`${named} を読めない: ${(e as Error).message}`);
  }
  if (json === null || typeof json !== "object" || json.ci === undefined) return null;
  const r = CiConfig.safeParse(json.ci);
  if (!r.success) throw new NoCiSteps(`${named} の ci が不正: ${r.error.issues.map((i) => `ci.${i.path.join(".")}: ${i.message}`).join(" / ")}`);
  return r.data.steps.map((s) => ({ name: s.name ?? s.run.split("\n")[0]!, run: s.run }));
}

/** Where a run's steps came from when it was not the checkout: the workspace whose settings Switchboard keeps, and a hash of the steps (their scripts, in order). */
export interface StepsSource { workspace: string; hash: string }

/** The hash a result names its steps by: the first 12 hex digits of the sha256 of the steps' scripts. */
export const stepsHash = (steps: Step[]): string => ciStepsHash(steps);

/**
 * What a checkout's CI runs: `ops.config.json`'s `ci.steps` when it has them (a repository that keeps no CI on GitHub;
 * ci.yml is not read then), else ci.yml's `run:` steps, with the shared entry replaced by that checkout's own
 * scripts/ci.ts steps (another repository's ci.yml has none). Those are the PR's code: read by `--list` in a
 * process of its own with `env` (the steps' environment), never imported into this one. Neither → `NoCiSteps`.
 */
export async function checkoutSteps(dir: string, env: Record<string, string>, workspace?: WorkspaceSettings): Promise<Step[]> {
  return (await checkoutCi(dir, env, workspace)).steps;
}

/**
 * `checkoutSteps` with where the steps came from. Which settings apply is one rule, a file as a whole: the checkout's own
 * `ops.config.json` when it has one (then `workspace` is not read, even for a key that file leaves out), else the
 * settings Switchboard keeps for the workspace. So the order is: the repository's `ci.steps`, the workspace's `ci.steps`, ci.yml.
 */
export async function checkoutCi(dir: string, env: Record<string, string>, workspace?: WorkspaceSettings): Promise<{ steps: Step[]; source?: StepsSource }> {
  const own = existsSync(join(dir, CONFIG_FILE));
  const configured = own ? configSteps(dir) : workspace ? fileSteps(workspace.file, `workspace ${workspace.name} の設定（Switchboard の側）`) : null;
  if (configured) return own ? { steps: configured } : { steps: configured, source: { workspace: workspace!.name, hash: stepsHash(configured) } };
  return { steps: await workflowCi(dir, env) };
}

async function workflowCi(dir: string, env: Record<string, string>): Promise<Step[]> {
  const yml = join(dir, ".github/workflows/ci.yml");
  if (!existsSync(yml)) throw new NoCiSteps(`CI の手順が無い。${CI_STEPS_PLACES}に置く`);
  const steps: Step[] = [];
  for (const s of workflowSteps(await Bun.file(yml).text())) {
    if (s.run.trim() !== SHARED_ENTRY) { steps.push(s); continue; }
    const p = Bun.spawn([process.execPath, "scripts/ci.ts", "--list"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`scripts/ci.ts --list が exit ${code}: ${err.trim()}`);
    steps.push(...(JSON.parse(out) as Step[]));
  }
  return steps;
}

/** The `run:` steps of every job in ci.yml, in order (`uses:` steps are the checkout and Bun, which this machine has). */
export function workflowSteps(yaml: string): Step[] {
  const doc = Bun.YAML.parse(yaml) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  return Object.values(doc.jobs).flatMap((j) => j.steps.filter((s) => s.run).map((s) => ({ name: s.name ?? s.run!.split("\n")[0]!, run: s.run! })));
}

/** What one run tested and how it went; `conflict` = the head did not merge into the base, nothing ran. */
/** `seconds`: a pass's type check and bun test seconds, for a checkout with scripts/ci.ts. */
/** `selection`: what chose this run's tests, none with `--all`. `bundle`: the perf check's `bundle:` and `grew:` lines, pass or fail. */
/** `incremental`: this run was only the commits since the earlier pass `pass` (`incrementalBase`). */
export interface LocalCiResult { /** The build off the host could not be started (sb-offload's code and what it printed): no step ran, nothing is to be posted. */ notStarted?: { code: number; output: string }; /** The steps came from the workspace's settings kept by Switchboard, not from the checkout. */ source?: StepsSource; /** The build the result is of (off the host): its record is the one to remove. */ build?: string; sha: string; base: string; results: StepResult[]; ok: boolean; seconds?: StepSeconds; conflict?: boolean; warnings?: string[]; perf?: PerfVerdict; selection?: TestSelection; bundle?: string[]; incremental?: { pass: string; commits: number; files: number }; /** bun test's failures taken off by the registry at the base (known-failures.json): `subtracted` are why a pass is a pass, `expired` were registered but past their date (still failures), `unreadable` = the registry could not be read (nothing taken off). */ known?: { subtracted: Subtracted[]; expired: Subtracted[]; unreadable?: string } }

/** What a run's bun test covered, for the comment: the seen line and the machine line; a selection's reason can list every changed file. */
function testsLines(s: TestSelection | undefined): string[] {
  if (!s) return ["テスト: 全ファイル（--all）"];
  // none counted: "every test" would read as if they all ran. Only what `total` counts is named (isTest)
  const seen = s.total === 0 ? "テスト: なし（`*.test.ts` / `*.test.tsx` のファイルが 1 つも無い）" : s.files ? `テスト: ${s.files.length} / ${s.total} ファイル（影響範囲の選択）` : `テスト: 全 ${s.total} ファイル（全テストに倒した: ${s.reason.length > 300 ? `${s.reason.slice(0, 300)}…` : s.reason}）`;
  return [seen, `<!-- local-ci-tests ${JSON.stringify({ ran: s.files?.length ?? null, total: s.total })} -->`];
}

/** The PR comment of a run, pass or not: the mark (the first line only: merge-gate reads no more), a pass's seconds line, what was tested, the bundle against main's tip, every step that ran; a failure names its step and what failed in it. */
export function resultComment(r: LocalCiResult): string {
  const head = [
    `[local-ci] ${r.ok ? "pass" : "fail"} ${r.sha} base=${r.base}`,
    ...(r.ok && r.seconds ? [`<!-- local-ci-seconds ${JSON.stringify(r.seconds)} -->`] : []),
    "",
    "CI の手順（`ops.config.json` の `ci.steps`、無ければ `.github/workflows/ci.yml`。`bun scripts/ci.ts` は `scripts/ci.ts` の各手順）を、head を base にマージしたものでローカルで実行した（`bun scripts/local-ci.ts`）。",
    // the steps are not in the PR's tree: who kept them and which ones ran
    ...(r.source ? [`手順の出どころ: Switchboard の側の設定（workspace \`${r.source.workspace}\`、手順のハッシュ \`${r.source.hash}\`）。リポジトリには置いていない`] : []),
    "",
    `対象: head \`${r.sha}\` を base \`${r.base}\` にマージ`,
  ];
  if (r.conflict) return [...head, "", "結果: head を base にマージできない（衝突）。手順は実行していない。base を取り込んでから回し直す。"].join("\n");
  // every failed step: a perf step's failure does not stop bun test
  const failed = r.results.filter((x) => x.code !== 0);
  return [
    ...head,
    ...(r.incremental ? [`増分: ${r.incremental.pass.slice(0, 7)} の pass の後の ${r.incremental.commits} コミット（変更 ${r.incremental.files} ファイル）で、型検査と選んだテストだけ`] : []),
    ...testsLines(r.selection),
    ...(r.warnings?.length ? ["", "所要時間の警告（合否には数えない。`perf-budget.json` の `local.durations`）:", "```", ...r.warnings, "```"] : []),
    ...(r.bundle?.length ? ["", "bundle（gzip、マージ後と main の先端の差）:", ...r.bundle.map((l) => `    ${l}`)] : []),
    // a fenced block: 4 spaces right after a paragraph line are no code block in CommonMark (they join the paragraph)
    ...failed.flatMap((f) => {
      const fails = (f.fails ?? []).slice(0, 20);
      // one backtick longer than the longest run in the lines: a line holding ``` does not close it
      const fence = "`".repeat(Math.max(3, ...fails.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((x) => x.length)) + 1)));
      return ["", `結果: \`${f.name}\` が exit ${f.code}。${f.log ? "全文は実行したホストの記録（~/.cache の下）。" : ""}`, ...(fails.length ? [fence, ...fails, fence] : [])];
    }),
    ...knownLines("既知の失敗を差し引いた（known-failures.json、base の登録）:", r.known?.subtracted),
    ...knownLines("期限切れで差し引かなかった:", r.known?.expired),
    ...(r.known?.unreadable ? ["", `known-failures.json（base の登録）を読めなかったので差し引いていない: ${r.known.unreadable}`] : []),
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
  /** The builds off the host (`sb-offload`, docs/design/local-ci-offload.md); none = every step runs here. */
  offload?: Offload;
  /** The settings Switchboard keeps for the workspace of the clone `root` (`workspaceSettingsOf`); none = only the checkout is read. */
  workspace?: (root: string) => WorkspaceSettings | undefined;
  /** The jobs the app recorded for a PR (a change's `repo` is `local:<workspaceId>`, the id in lower case); none = nothing is reused and every step runs (the app is out of reach). */
  records?: Records;
}

/** `repo`: as the records name it (`owner/name`, lower case; a local change `local:<workspaceId>` with the id in lower case). Throws when the app cannot answer. */
export type Records = (repo: string, pr: number) => Promise<MergeRecordJob[]>;

/** The records from the app at the address and key `env` names (`mergeRecordsEnv` fills the usual place when it names none). */
export const recordsFrom = (env: Record<string, string | undefined>): Records => async (repo, pr) => (await mergeRecords(mergeRecordsEnv(env), { repo, prs: [pr] })).jobs;

/** The outcome of an earlier local CI run, as the app recorded it: the newest job of the PR whose run left a result (a run that is still going, or posted nothing, has none). */
export interface CiRecord { id: number; head: string; base: string; outcome: "pass" | "fail" }

export function newestCiRecord(jobs: MergeRecordJob[]): CiRecord | undefined {
  let best: CiRecord | undefined;
  for (const j of jobs) {
    const ci = (j.result as { ci?: { outcome?: unknown } } | null)?.ci;
    if (j.kind !== "local-ci" || !j.head || !j.base || (ci?.outcome !== "pass" && ci?.outcome !== "fail")) continue;
    if (!best || j.id > best.id) best = { id: j.id, head: j.head, base: j.base, outcome: ci.outcome };
  }
  return best;
}

/** The newest recorded run of `pr` of `repo`; none when `d` has no records. A failure to read throws. */
async function ciRecordOf(records: Records | undefined, repo: string, pr: number): Promise<CiRecord | undefined> {
  return records ? newestCiRecord(await records(repo.toLowerCase(), pr)) : undefined;
}

/**
 * What a run that posted its result leaves for the job that ran it: `$J/result.json` (head, base and the outcome), which the daemon reads
 * when the job ends. Only a job has `J`; a run from a terminal leaves nothing. A write that fails is said and does not fail the run.
 */
export function writeJobResult(dir: string | undefined, r: { ok: boolean; sha: string; base: string; source?: StepsSource }, log: (l: string) => void = console.error): void {
  if (!dir) return;
  try {
    const ci = { outcome: r.ok ? "pass" : "fail", ...(r.source ? { stepsHash: r.source.hash } : {}) };
    writeFileSync(join(dir, "result.json"), JSON.stringify({ head: r.sha, base: r.base, ci }));
  } catch (e) {
    log(`仕事の記録に結果を残せない: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The id of the job a run is (`$J`'s last part), when it is one. */
const jobIdOf = (dir: string | undefined): string | undefined => (dir && /^\d+$/.test(basename(dir)) ? basename(dir) : undefined);

/** `--collect`'s `record` for a build that outlived its job: the result goes to that job's own folder (still there, 7 days), for the daemon to take in when this collect has ended. */
function lateRecord(job: string | undefined, env: Record<string, string | undefined> = process.env): (r: LocalCiResult) => void {
  return (r) => {
    const dir = job ? join(homeOf(env as NodeJS.ProcessEnv), "jobs", job) : undefined;
    if (dir && existsSync(dir)) writeJobResult(dir, r);
  };
}

export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** `bun test` of those files (a step's script), or a line saying none were selected. */
export const testRun = (files: string[]) => (files.length ? `bun test ${files.map((f) => quote(`./${f}`)).join(" ")}` : 'echo "no test files selected"');

/** A step's marks in a build's log: `sb-step: <i> begin <epoch s>` and `sb-step: <i> exit <code> <epoch s>`. */
const MARK = /^sb-step: (\d+) (begin|exit) (?:(\d+) )?([\d.]+)$/;

/**
 * The steps of the build from its log, by their marks: each one's output, code and seconds. A step that began without
 * an exit mark, or the first step when none began (the setup failed), gets sb-offload's code (1 when that is 0) and
 * its reason; the steps after it did not run and are left out. A build that ends non-zero after every step passed
 * fails its last step with that code and reason. A begin mark may be missing (a lossy log): an exit mark is enough to
 * read the step, its output starting after the previous step's exit mark and its seconds 0.
 */
export function parseBuild(output: string, steps: Step[], code: number): Array<Step & { code: number; output: string; seconds: number; tail: string }> {
  const lines = output.split("\n");
  const marks = new Map<string, { line: number; at: number; code?: number }>();
  lines.forEach((l, line) => {
    const m = MARK.exec(l.trim());
    if (m) marks.set(`${m[1]} ${m[2]}`, { line, at: Number(m[4]), ...(m[3] === undefined ? {} : { code: Number(m[3]) }) });
  });
  const out: Array<Step & { code: number; output: string; seconds: number; tail: string }> = [];
  let from = 0;
  for (const [i, s] of steps.entries()) {
    const begin = marks.get(`${i} begin`);
    const exit = marks.get(`${i} exit`);
    if (exit) {
      const text = lines.slice(begin ? begin.line + 1 : from, exit.line).join("\n");
      from = exit.line + 1;
      out.push({ ...s, code: exit.code!, output: text, seconds: begin ? exit.at - begin.at : 0, tail: text.split("\n").slice(-30).join("\n") });
      if (exit.code !== 0 && !s.keepGoing) break;
      continue;
    }
    // cut off in this step, or before any step (the setup's lines are its output)
    const text = `${(begin ? lines.slice(begin.line + 1) : lines).join("\n").trimEnd()}\n${offloadReason(code)}`;
    out.push({ ...s, code: code === 0 ? 1 : code, output: text, seconds: 0, tail: text.split("\n").slice(-30).join("\n") });
    return out;
  }
  // every step passed but the build did not (stopped or timed out after the last mark): the last step carries it
  const last = out.at(-1);
  if (code !== 0 && last && last.code === 0) {
    const text = `${last.output.trimEnd()}\n${offloadReason(code)}`;
    out[out.length - 1] = { ...last, code, output: text, tail: text.split("\n").slice(-30).join("\n") };
  }
  return out;
}

/**
 * The PR's head and its base branch's tip as they are now, both fetched into `repoRoot`. The head comes by
 * refs/pull/<n>/head, which GitHub keeps for every PR (a fork's too); it must be the head the PR names.
 * Each is fetched into a ref of its own, refs/local-ci/<n>/base and refs/local-ci/<n>/head, and read from there: another
 * fetch in the same clone (a local-ci of another PR alongside) rewrites FETCH_HEAD in between.
 */
export async function readTarget(pr: number, repoRoot: string, repo: string, d: Pick<Deps, "sh">, glab: Sh = runGlab): Promise<{ head: string; base: string }> {
  // a GitLab checkout: the MR `pr` of the project its forge names; GitLab keeps refs/merge-requests/<iid>/head
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

/** The tip of the default branch of `repo`, fetched into the clone `repoRoot` (under the PR's refs/local-ci/<pr>/). */
export async function defaultTip(pr: number, repoRoot: string, repo: string, d: Pick<Deps, "sh">): Promise<string> {
  const name = (await d.sh(["gh", "repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
  const into = `refs/local-ci/${pr}/default`;
  await d.sh(["git", "-C", repoRoot, "fetch", "-q", "origin", `+refs/heads/${name}:${into}`]);
  return (await d.sh(["git", "-C", repoRoot, "rev-parse", into])).trim();
}

/** `files: null` = every test; `total` = the checkout's test files; `reason` = why these tests, or why all of them; `unjudged`: the selection itself did not run or could not be read. */
export interface TestSelection { files: string[] | null; total: number; reason: string; unjudged?: true }

/**
 * The tests for what changed since the commit `base` gives (or for `changed`, when given: no diff is run), by the checkout's scripts/test-select.ts: its code, run in
 * a process of its own with `env` (as checkoutSteps runs the checkout's scripts/ci.ts), never imported into this one.
 * A checkout without it, a failure or an output it cannot read → every test. A failure's text goes to the log, not in
 * `reason`: that goes on the PR, and the text holds the host's paths.
 */
export async function selectTests(dir: string, base: () => Promise<string>, env: Record<string, string>, d: Pick<Deps, "sh" | "log">, changed?: string[]): Promise<TestSelection> {
  const total = (await d.sh(["git", "-C", dir, "ls-files"])).split("\n").filter(isTest).length;
  if (!existsSync(join(dir, "scripts/test-select.ts"))) return { files: null, total, reason: "scripts/test-select.ts が無い", unjudged: true };
  try {
    // --no-renames: a rename's old path is a deleted file, whose dependents the selection must see
    changed ??= (await d.sh(["git", "-C", dir, "diff", "--name-only", "--no-renames", "-z", await base()])).split("\0").filter(Boolean);
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const [head = "", ...rows] = (await d.sh(["env", "-i", ...vars, process.execPath, "scripts/test-select.ts", ...changed], dir)).trimEnd().split("\n");
    const full = /^full: (.*)$/.exec(head);
    if (!full && head !== `selected: ${rows.length}`) throw new Error(`出力を読めない: ${head.slice(0, 80)}`);
    const tests = full ? { files: null, total, reason: full[1]!.replaceAll(dir, "<checkout>") } : { files: rows.map((r) => r.split("  ")[0]!), total, reason: `変更 ${changed.length} ファイルから選んだ` };
    return tests;
  } catch (e) {
    d.log(`テストの選択に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return { files: null, total, reason: "選択を実行できなかった（実行したホストのログを見る）", unjudged: true };
  }
}

/**
 * Where the commits of a PR and the PRs below it start: HEAD's fork from the default branch. A stacked PR's base is the
 * branch below it, so a diff from that base would leave out the PRs below.
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

/**
 * What the PR gained since its newest pass (an incremental run): the pass's head `pass`, the commits `git cherry` marks
 * `+` between the PR's fork from `tip` (the caller gives the default branch's tip) and `head` (a rebase that kept a diff adds none), and the files
 * they touch, deleted ones too. None when the newest recorded run (the app's job records) is no pass, is of this head, a merge
 * commit of the PR is not in the pass's history (a conflict resolved: `inPass`'s rule), or anything cannot be read.
 */
export async function incrementalBase(pr: number, repo: string, repoRoot: string, head: string, tip: string, d: Pick<Deps, "sh" | "records">): Promise<{ pass: string; commits: string[]; files: string[] } | undefined> {
  try {
    const newest = await ciRecordOf(d.records, repo, pr);
    if (newest?.outcome !== "pass" || newest.head === head) return undefined;
    const pass = newest.head;
    const at = ["git", "-C", repoRoot];
    await d.sh([...at, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", pass]);
    const mergeBase = (await d.sh([...at, "merge-base", tip, head])).trim();
    const commits = (await d.sh([...at, "cherry", pass, head, mergeBase])).split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim());
    for (const m of (await d.sh([...at, "rev-list", "--merges", `${mergeBase}..${head}`])).split("\n").filter(Boolean)) {
      if (!await d.sh([...at, "merge-base", "--is-ancestor", m, pass]).then(() => true, () => false)) return undefined;
    }
    const files = new Set<string>();
    for (const c of commits) for (const f of (await d.sh([...at, "show", "--name-only", "--no-renames", "--format=", "-z", c])).split("\0").filter(Boolean)) files.add(f);
    return { pass, commits, files: [...files] };
  } catch {
    return undefined;
  }
}

/** The checks of the whole tree that cost seconds and that the added commits can break as easily as the first ones: an incremental run keeps each one the CI has. */
export const INCREMENTAL_ALSO = ["bun ops-kit/src/cli.ts issue-refs", "bun scripts/file-size.ts", "bun scripts/public-docs.ts check"];

/**
 * The steps of an incremental run: the install, the type check and `bun test` given `files` (none when the CI lacks one
 * of them), and, where the CI has them, the tree checks of `INCREMENTAL_ALSO` in the CI's order — a pass on the added
 * commits is not given without them.
 */
export function incrementalSteps(steps: Step[], files: string[]): Step[] | undefined {
  const keep = ["bun install --frozen-lockfile", "bun run typecheck", "bun test"];
  const kept = steps.filter((s) => keep.includes(s.run.trim()) || INCREMENTAL_ALSO.includes(s.run.trim()));
  return keep.every((k) => kept.some((s) => s.run.trim() === k)) ? narrowTestStep(kept, files) : undefined;
}

/**
 * A local change instead of a PR: its head and base read from the app with the checkout's own branches (no
 * fetch: there is no remote), `label` naming its worktrees and logs. Its tests are chosen against the base's tip, and
 * no bundle row is recorded (that is a GitHub records branch).
 */
export interface ChangeTarget { label: string; read: () => Promise<{ head: string; base: string }> }

/** The comment's result from a collected build: the steps read by their marks, as a run here reads them. */
async function resultOf(p: Pending, out: { code: number; output: string }, d: Pick<Deps, "log" | "sh">, cache: string, today?: string): Promise<LocalCiResult> {
  const ran = parseBuild(out.output, p.steps, out.code);
  const { results, ok, bundle, outputs } = await settle(ran, d, `local-ci-${p.repo.replaceAll("/", "_")}-${p.pr}`, cache);
  const seconds = ok && p.ciTs ? stepSeconds(results) : undefined;
  const r = { sha: p.head, base: p.base, results, ok, ...(seconds ? { seconds } : {}), ...(p.selection ? { selection: p.selection } : {}), ...(bundle.length ? { bundle } : {}), ...(p.incremental ? { incremental: p.incremental } : {}), ...(p.source ? { source: p.source } : {}) };
  return ok ? r : withKnown(r, outputs, d.sh, p.root, today);
}

/** The only step whose registered failures are subtracted (withKnown). Kept here, not in the notes, because it decides a result. */
const KNOWN_FAILURES_STEP = "bun test";

/**
 * A failed result whose only failed step is bun test with (fail) lines: what the registry at the base (known-failures.json) names, in date, is no
 * failure (subtractKnown; never the head's registry, a PR does not excuse its own failures). All taken off = a pass without seconds (a failed run's
 * seconds are not compared); some left = still a fail whose bun test lines are those left. Shared by a run here and a result collected later.
 */
async function withKnown(r: LocalCiResult, outputs: Record<string, string>, sh: Deps["sh"], repoRoot: string, today = new Date().toISOString().slice(0, 10)): Promise<LocalCiResult> {
  const failed = r.results.filter((x) => x.code !== 0);
  const step = failed.length === 1 && failed[0]!.name === KNOWN_FAILURES_STEP ? failed[0]! : undefined;
  const output = step ? outputs[step.name] : undefined;
  if (!step || output === undefined || !(step.fails ?? []).some((l) => l.startsWith("(fail) "))) return r;
  let known;
  try {
    known = await readKnownFailures(sh, repoRoot, r.base);
  } catch (e) {
    return { ...r, known: { subtracted: [], expired: [], unreadable: (e as Error).message.split("\n")[0]! } };
  }
  const s = subtractKnown(output, step.fails!, known, today);
  if (!s) return r;
  const k = s.subtracted.length || s.expired.length ? { known: { subtracted: s.subtracted, expired: s.expired } } : {};
  return { ...r, ok: s.rest.length === 0, results: r.results.map((x) => (x === step ? { ...x, fails: s.rest } : x)), ...k };
}

/**
 * `--collect`: for each pending record, waits for its build (`offload.collect`), reads the steps and posts the result as the run would have (`notify`: nothing
 * posted when the head moved; a base that alone moved is posted with the base it ran on), then removes the record. A build whose log is gone (older than 7 days) is said and removed. Exit 0 = every record was
 * written or not needed, 1 = a record is left (the post failed, head and base could not be read, or the build has no log yet).
 */
export async function collectPending(d: Deps, cache: string, post = reportResult, live: (p: Pending) => boolean = recordLive): Promise<number> {
  let names: string[];
  try {
    names = readdirSync(pendingDirOf(cache)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  if (!d.offload) {
    console.error("pending の結果を拾えない: sb-offload が無い");
    return 1;
  }
  let left = 0;
  for (const name of names) {
    const file = join(pendingDirOf(cache), name);
    const p = readPendingFile(file);
    if (!p) {
      d.log(`${name}: 読めない記録なので消す`);
      rmSync(file, { force: true });
      continue;
    }
    // the local-ci that started it is alive: it writes its own result
    if (live(p)) {
      d.log(`${p.repo}#${p.pr}: local-ci（pid ${p.pid}）が待っているので飛ばす`);
      continue;
    }
    const out = await d.offload.collect(p.build);
    // no build and no log to read: one older than its log's keep cannot be written; a younger one may be a blip, left for the next collect
    if (!buildSpoke(out.output)) {
      if (Date.now() - p.at > BUILD_LOG_KEEP_MS) {
        d.log(`${p.repo}#${p.pr}: ビルド ${p.build} のログが無い（7 日より古い）ので書けない。記録を消す`);
        clearPending(cache, p.repo, p.pr, p.build);
      } else {
        d.log(`${p.repo}#${p.pr}: ビルド ${p.build} の結果を読めない（exit ${out.code}）。記録を残す`);
        left++;
      }
      continue;
    }
    const t = { pr: p.pr, repo: p.repo, root: p.root };
    try {
      const r = await resultOf(p, out, d, cache);
      const { posted, readFailed } = await notifyKeeping(t, r, d, post, lateRecord(p.job));
      if (!posted && readFailed) {
        left++;
        continue;
      }
    } catch (e) {
      d.log(`${p.repo}#${p.pr}: 結果を PR に投稿できなかった: ${e instanceof Error ? e.message : String(e)}。記録を残す`);
      left++;
      continue;
    }
    clearPending(cache, p.repo, p.pr, p.build);
  }
  return left === 0 ? 0 : 1;
}

/** `cache`: where the worktree and the failure logs go (~/.cache; tests give their own). TMPDIR goes under tmpdir(). */
/** `imageRoot`: the tree whose container/Dockerfile is the ci image's when the target is another repository (Switchboard's own clone); none = the checkout that is built (this repository's PR is tried on its own Dockerfile). */
export async function localCi(pr: number, repoRoot: string, d: Deps, repo: string, cache = join(homedir(), ".cache"), opts: { all?: boolean; force?: boolean; change?: ChangeTarget; today?: string; imageRoot?: string } = {}): Promise<LocalCiResult> {
  const change = opts.change;
  const label = change ? `local-ci ${change.label}` : `local-ci ${repo}#${pr}`;
  let built: string | undefined;
  // The head and base are read once the slot is held: a wait must not leave the run on the head and base of before it
  const body = async (): Promise<LocalCiResult> => {
    const { head: sha, base } = change ? await change.read() : await readTarget(pr, repoRoot, repo, d);
    // a build already started for this head and base (a local-ci of before that was cut off): its result is awaited, not built again
    const prior = d.offload && !change && !opts.all && !opts.force ? pendingFor(cache, repo, pr, sha, base) : undefined;
    if (prior) {
      d.log(`▶ 外: 始まっているビルド ${prior.build} の結果を待つ`);
      // this process is the one to write it now
      const job = jobIdOf(process.env.J);
      writePending(cache, { ...prior, pid: process.pid, boot: bootId(), ...(job ? { job } : {}) });
      const out = await d.offload!.collect(prior.build);
      if (buildSpoke(out.output)) return (built = prior.build), resultOf(prior, out, d, cache, opts.today);
      // the build is gone (its log kept 7 days) or could not be read: not a result of this head; a build of its own
      d.log(`ビルド ${prior.build} の結果が無い。新しくビルドする`);
      clearPending(cache, repo, pr, prior.build);
    }
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
      // the default branch's tip as it is now (a PR only): file sizes compares the ceilings with its list, not with the clone's
      // origin/main, which nothing here fetches and which may be behind a main that has lowered a ceiling since
      const fresh = change ? undefined : await defaultTip(pr, repoRoot, repo, d).catch(() => undefined);
      const env = { ...stepEnv(tmp), ...(fresh ? { FILE_SIZE_BASE_REF: fresh } : {}) };
      // the commits since the PR's newest pass, when there is one to build on (never for --all or a local change)
      // a stack's base is the PR below, so the commits are counted from the default branch's tip (a fix added below is one the top's pass must hold)
      const tip = opts.all || opts.force ? undefined : fresh;
      const since = tip ? await incrementalBase(pr, repo, repoRoot, sha, tip, d) : undefined;
      // no commit added (a rebase only) has no files to choose tests from: every step, as without a pass
      const inc = since && since.commits.length > 0 ? since : undefined;
      const picked = opts.all ? undefined : await selectTests(dir, () => (change ? Promise.resolve(base) : mainFork(dir, repo, d.sh)), env, d, inc?.files);
      // a CI without the incremental steps ran every test, whatever the commits since the pass chose
      const selectionOf = (incremental: boolean) => (picked && inc && picked.files && !incremental ? { files: null, total: picked.total, reason: "増分に使える手順が無い", unjudged: true as const } : picked);
      const incrementalOf = (incremental: boolean) => (incremental && inc ? { pass: inc.pass, commits: inc.commits.length, files: inc.files.length } : undefined);
      // the build's id is written down as soon as it has started (a PR only): a run that is cut off then leaves its result to `--collect`
      const started = change ? undefined : (build: string, steps: Step[], incremental: boolean, source?: StepsSource) => {
        const selection = selectionOf(incremental);
        const summary = incrementalOf(incremental);
        built = build;
        const job = jobIdOf(process.env.J);
        writePending(cache, { repo, pr, root: repoRoot, head: sha, base, build, at: Date.now(), pid: process.pid, boot: bootId(), ...(job ? { job } : {}), steps, ...(selection ? { selection } : {}), ...(summary ? { incremental: summary } : {}), ciTs: existsSync(join(dir, "scripts/ci.ts")), ...(source ? { source } : {}) });
      };
      const workspace = d.workspace?.(repoRoot);
      const run = await runCheckout(dir, env, change ? change.label : `local-ci-${repo.replaceAll("/", "_")}-${pr}`, d, cache, picked?.files, change ? undefined : repo, false, !!inc && !!picked?.files, started, undefined, { ...(opts.imageRoot ? { imageRoot: opts.imageRoot } : {}), ...(workspace ? { workspace } : {}) });
      // the build never started: no step ran and there is nothing to say about the head
      if (run.notStarted) return { sha, base, results: [], ok: false, notStarted: run.notStarted };
      const from = run.source ? { source: run.source } : {};
      const selection = selectionOf(run.incremental);
      const narrowed = selection ? { selection } : {};
      const summary = incrementalOf(run.incremental);
      const incremental = summary ? { incremental: summary } : {};
      const { results } = run;
      const bundle = run.bundle.length ? { bundle: run.bundle } : {};
      // a checkout with scripts/ci.ts (this repository's CI) must have both steps; another repository's (--repo) need not
      if (run.ok) {
        const seconds = existsSync(join(dir, "scripts/ci.ts")) ? stepSeconds(results) : undefined;
        // a narrowed bun test's seconds say nothing against the ceiling of all of them, nor a step's off the host against
        // the host's `local` ceilings (docs/design/local-ci-offload.md); the ceilings are on the high side only
        const off = (s: string) => run.offloaded.includes(s);
        const over = seconds ? await durationOver(dir, { typecheck: off(SECONDS_STEPS.typecheck) ? 0 : seconds.typecheck, test: selection?.files || off(SECONDS_STEPS.test) ? 0 : seconds.test }) : [];
        // a pass whatever the seconds: the comment carries the lines as a warning (the ceilings do not decide the merge)
        for (const l of over) d.log(`警告: ${l}`);
        return { sha, base, results, ok: true, ...(seconds ? { seconds } : {}), ...(over.length ? { warnings: over } : {}), ...narrowed, ...bundle, ...incremental, ...from };
      }
      return withKnown({ sha, base, results, ok: false, ...narrowed, ...bundle, ...incremental, ...from }, run.outputs, d.sh, repoRoot, opts.today);
    } finally {
      await d.sh(["git", "-C", repoRoot, "worktree", "remove", "--force", dir]).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  };
  // one slot for the whole run, so another heavy job does not cut in while this run's worktree is still there. With
  // `offload` every step runs in the one build off the host and no slot is taken here: the host only makes the work tree and writes the result
  const r = await (d.offload ? body() : d.slot(label, body));
  return built ? { ...r, build: built } : r;
}

/**
 * A checkout's CI in `dir` (local-ci's merge, tag-ci's tag): its steps (`checkoutSteps`) run with `env` until one
 * without `keepGoing` fails (`runCi`). Each failed step's whole output goes to one log dir `switchboard.<label>-log.*`
 * under `cache` (the latest of a label only: earlier ones go, the host's disk is small) and, for a perf step, its verdict
 * and perf-result.json there. A failure that is not a perf step is logged here; a perf step's is the caller's (the tag CI's). `outputs`: each failed step's whole output by its name.
 * `tests`: only those test files for `bun test` (local-ci); none, or null = every test.
 * `bundle`: the perf check's `bundle:` and `grew:` lines, whether it passed or not (none without that check).
 * `incremental`: `tests` choose the steps of `incrementalSteps` only (a PR's local CI after an earlier pass); `incremental` in the result says whether that happened.
 * `withPerf`: false = the steps without the perf ones (`withoutPerf`): a PR's local CI; the tag CI measures.
 * `baseTree`: off the host only, the tar of the tag the perf steps compare with (`sb-offload --base-tree`).
 * `x.imageRoot`: off the host only, the tree whose container/Dockerfile is the ci image's (`sb-offload --image-root`); none = `dir`.
 * `x.workspace`: the settings Switchboard keeps for the workspace, read when `dir` has no `ops.config.json` (`checkoutCi`); `source` in the result says the steps came from there.
 * `notStarted`: the build off the host could not be started (no step ran: `results` is empty and `ok` false, and the caller writes no result).
 */
export async function runCheckout(dir: string, env: Record<string, string>, label: string, d: Omit<Deps, "slot"> & { slot?: Deps["slot"] }, cache: string, tests?: string[] | null, repo?: string, withPerf = true, incremental = false, started?: (build: string, steps: Step[], incremental: boolean, source?: StepsSource) => void, baseTree?: string, x: { imageRoot?: string; workspace?: WorkspaceSettings } = {}): Promise<{ steps: Step[]; results: StepResult[]; ok: boolean; perf?: PerfVerdict; outputs: Record<string, string>; bundle: string[]; offloaded: string[]; incremental: boolean; source?: StepsSource; notStarted?: { code: number; output: string } }> {
  const ci = await checkoutCi(dir, env, x.workspace);
  const from = ci.source ? { source: ci.source } : {};
  // a perf step never stops the steps after it, whatever the repository's CI says: perf does not decide the result (docs/design/perf.md)
  const all = ci.steps.map((s) => (isPerfStep(s) ? { ...s, keepGoing: true } : s));
  const listed = withPerf ? all : withoutPerf(all);
  // incremental: `tests` came from the commits since an earlier pass, so they narrow only the install, type check and test steps; a CI without those runs every test
  const inc = incremental && tests ? incrementalSteps(listed, tests) : undefined;
  if (incremental && !inc) tests = null;
  const steps = inc ?? (tests ? narrowTestStep(listed, tests) : listed);
  const runHere = async (s: Step) => {
    d.log(`▶ ${s.name}`);
    const started = Date.now();
    const r = await d.step(s.run, dir, env);
    return { code: r.code, output: r.output, seconds: (Date.now() - started) / 1000, tail: r.output.split("\n").slice(-30).join("\n") };
  };
  const offload = d.offload;
  let ran: Array<Step & { code: number; output: string; seconds: number; tail: string }>;
  if (!offload) ran = await runCi(steps, runHere);
  // sb-offload: every step in one build, whatever the CI's step names are; here only the work tree is made and the result read (no step, no slot)
  else {
    d.log(`▶ 外: ${steps.map((s) => s.name).join(" → ")}`);
    // the build has no base ref: the base's list of scripts/file-size.ts goes with it (none when it cannot be read here: the step
    // then fails off the host, and why it could not be read here is this line of the host's log)
    const base = steps.some((s) => s.run.includes("scripts/file-size.ts")) ? await fileSizeBaseOf(dir, env.FILE_SIZE_BASE_REF || "origin/main", d) : undefined;
    const r = await runBuild(offload, steps, dir, { caller: withPerf ? "tag-ci" : "local-ci", ...(repo ? { repo } : {}), ...(withPerf ? { perf: true as const } : {}), ...(baseTree ? { baseTree } : {}), ...(x.imageRoot ? { imageRoot: x.imageRoot } : {}), ...(base ? { fileSizeBase: base } : {}), ...(started ? { started: (build) => started(build, steps, !!inc, ci.source) } : {}) });
    // not a step's failure: the first step would otherwise carry sb-offload's own exit as if the code had failed
    if (r.notStarted) return { steps, results: [], ok: false, outputs: {}, bundle: [], offloaded: [], incremental: !!inc, ...from, notStarted: { code: r.code, output: r.output } };
    ran = parseBuild(r.output, steps, r.code);
    // a perf run's files come back in the log: written into `dir` as a run here would leave them, for the records and the judgement
    if (withPerf) for (const [name, bytes] of Object.entries(buildFiles(r.output))) writeFileSync(join(dir, name), bytes);
  }
  const offloaded = offload ? steps.map((s) => s.name) : [];
  const settled = await settle(ran, d, label, cache, dir);
  return { steps, ...settled, offloaded, incremental: !!inc, ...from };
}

/**
 * What the steps that ran say: their results, whether all passed, the perf verdict, the bundle lines, and each failed step's whole output by its name (its
 * log kept under `cache` for the failure lines; `dir`'s perf-result.json copied beside it when there is a work tree). Shared by a run here and a result collected later.
 */
async function settle(ran: Array<Step & { code: number; output: string; seconds: number; tail: string }>, d: Pick<Deps, "log">, label: string, cache: string, dir?: string): Promise<{ results: StepResult[]; ok: boolean; perf?: PerfVerdict; outputs: Record<string, string>; bundle: string[] }> {
  const results: StepResult[] = ran.map(({ output: _, ...r }) => r);
  const check = ran.find(isPerfCheck);
  const bundle = check ? check.output.split("\n").filter((l) => l.startsWith("bundle: ") || l.startsWith("grew: ")) : [];
  const failedAt = ran.flatMap((x, i) => (x.code === 0 ? [] : [i]));
  if (failedAt.length === 0) return { results, ok: true, outputs: {}, bundle };
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
  if (dir && perf && existsSync(join(dir, "perf-result.json"))) copyFileSync(join(dir, "perf-result.json"), join(logDir, "perf-result.json"));
  return { results, ok: false, ...(perf ? { perf } : {}), outputs, bundle };
}

/** The whole environment of a step here: PATH and HOME from here, external recordings only when supplied, CI=true as on the runner, TMPDIR its own dir. A build off the host gets none of it (`ciScript`): its recordings come by `--fixtures`. */
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
 * What names the PR's newest recorded run (`job#<id>`) when it is a pass of the head as it is: a later fail runs; a base that moved under the
 * same head does not — unless it moved on a shared file the PR touches (`sharedMoved`, read in the checkout `git`): merge-gate does not count
 * that pass, so it runs. A `[local-ci]` comment is not read: a pass the app has no record of (a run from a terminal) runs again.
 */
export async function existingPass(pr: number, repo: string, run: Deps["sh"], git: { root: string; url: string } | undefined, records: Records | undefined): Promise<string | undefined> {
  const view = JSON.parse(await run(["gh", "pr", "view", String(pr), "-R", repo, "--json", "headRefOid,baseRefOid"])) as { headRefOid: string; baseRefOid: string };
  const newest = await ciRecordOf(records, repo, pr);
  if (newest?.outcome !== "pass" || newest.head !== view.headRefOid) return undefined;
  const moved = git ? await sharedMoved(git, sharedFilesOf(git.root), newest.head, newest.base, view.baseRefOid) : [];
  return moved.length ? undefined : `job#${newest.id}`;
}

/** The pass to reuse: none with `--force` or `--all` (a narrowed pass is not what it asks for), on GitLab, or when unreadable (a normal run). */
export async function reusablePass(t: { pr: number; repo: string; root: string; all?: true; force?: true }, run: Deps["sh"], records?: Records): Promise<string | undefined> {
  if (t.force || t.all || forgeTargetOf(t.root, originOf(t.root)).service === "gitlab") return undefined;
  return existingPass(t.pr, t.repo, run, { root: t.root, url: `https://github.com/${t.repo}.git` }, records).catch(() => undefined);
}

/** The PR, the repository and its clone from the arguments: `<PR> [--repo <owner/name>] [--all] [--force] [--local]`. `--local`: every step here, not in the off-host build. */
export async function resolveTarget(argv: string[], cwd: string, scriptRoot: string, run: Deps["sh"]): Promise<{ pr: number; repo: string; root: string; all?: true; force?: true; local?: true }> {
  const args = argv.filter((a) => a !== "--all" && a !== "--force" && a !== "--local");
  const flags = {
    ...(argv.includes("--all") ? { all: true as const } : {}),
    ...(argv.includes("--force") ? { force: true as const } : {}),
    ...(argv.includes("--local") ? { local: true as const } : {}),
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
    // a GitLab checkout: the project its forge names, checked against the origin
    let named;
    try {
      named = forgeTargetOf(scriptRoot, originOf(scriptRoot));
    } catch (e) {
      throw new TargetError((e as Error).message);
    }
    if (named.service === "gitlab") return { pr, repo: named.repository!, root: scriptRoot, ...flags };
    // a forge naming the app: its changes have no PR, and the result would go on the change of the same number
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
 * Posts a result on the PR as a forge `verification`: the service is the target repository's `ops.config.json`
 * `forge` (none = GitHub); one without a verification is said, not posted some other way. The texts go through the
 * kit's check for values usable for auth first.
 */
export async function reportResult(t: { pr: number; repo: string; root: string; change?: true }, body: string, run: Deps["sh"], glab: Sh = runGlab, backlog: BacklogAccess = { env: process.env }): Promise<void> {
  // the repository is the origin's on github.com (`remoteRepo`), the one refs/heads/<base> and refs/pull/<n>/head are
  // fetched from; a GitLab project is its `forge`'s, checked against the origin: the note goes on the MR `pr`.
  // A checkout whose changes the app keeps (forgeOf): the change `pr` of the workspace `repo`
  // `change`: a local change's result goes on the change whatever the checkout's forge is (a GitHub checkout has them
  // while GitHub cannot be used): never on the PR of the same number
  const named = t.change || forgeOf(t.root) === LOCAL_SERVICE ? { service: LOCAL_SERVICE, host: "local", repository: t.repo } : forgeTargetOf(t.root, originOf(t.root));
  const target = named.repository ? named : { ...named, host: "github.com", repository: t.repo };
  await runForgeOperation({ kind: "verification", target, texts: [body], payload: { pr: t.pr, body } }, { github: githubForge((cmd) => run(cmd)), gitlab: gitlabForge(glab), [LOCAL_SERVICE]: appForge(backlog.env, backlog.fetch) }, hostAws());
}

/**
 * Posts the run's result only if it still names the PR's head: a head that moved since the run → nothing posted (a
 * pass for an old head would be taken for the new one), false. A base that alone moved does not drop it: the mark keeps
 * the base it ran on (`base=`), and each counting side reads that base (GitHub's does not compare it; a local change's
 * and GitLab's ask it to be the base's tip, so they ask for a new run). Which PRs of a stack the pass covers is
 * merge-gate's to work out with git, not written here.
 */
export async function notify(t: { pr: number; repo: string; root: string }, r: LocalCiResult, d: Pick<Deps, "sh" | "log">, post = reportResult, read = () => readTarget(t.pr, t.root, t.repo, d), record: (r: LocalCiResult) => void = (r) => writeJobResult(process.env.J, r, d.log)): Promise<boolean> {
  const now = await read().catch((e: unknown) => (d.log(`head / base を読み直せない: ${e instanceof Error ? e.message : String(e)}`), undefined));
  if (!now) return false;
  if (now.head !== r.sha) {
    d.log(`実行中に変わった（head ${r.sha.slice(0, 7)} → ${now.head.slice(0, 7)}、base ${r.base.slice(0, 7)} → ${now.base.slice(0, 7)}）。結果を投稿しない（回し直す）`);
    return false;
  }
  if (now.base !== r.base) d.log(`base が実行中に進んだ（${r.base.slice(0, 7)} → ${now.base.slice(0, 7)}）。実行した base ${r.base.slice(0, 7)} の結果として投稿する`);
  const body = resultComment(r);
  await post(t, body, d.sh);
  // after the post: a record of a pass with no comment would be reused, and the comment never written
  record(r);
  d.log(body);
  return true;
}

/** `notify`, saying whether a false is from the head and base not being readable (a result that was not posted for that is not to be dropped). */
async function notifyKeeping(t: { pr: number; repo: string; root: string }, r: LocalCiResult, d: Pick<Deps, "sh" | "log">, post: typeof reportResult, record?: (r: LocalCiResult) => void): Promise<{ posted: boolean; readFailed: boolean }> {
  let readFailed = false;
  const posted = await notify(t, r, d, post, () => readTarget(t.pr, t.root, t.repo, d).catch((e: unknown) => ((readFailed = true), Promise.reject(e))), record);
  return { posted, readFailed };
}

/** The app the kit's backlog client reads a local change from: its env (BACKLOG_URL, BACKLOG_WORKSPACE, the key's file) and, in tests, its fetch. */
export interface BacklogAccess { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }

/**
 * `--change <n>`: a local change of the checkout `cwd` is in, run as a PR is — its head merged into its base's
 * tip in a worktree of its own — and the result posted on the change (the app's verification, `reportResult`). Nothing
 * is fetched and gh is never called. A pass of the same head and base already there is not run again (`--force` /
 * `--all` run it). Exit codes as `main`'s.
 */
export async function changeMain(args: string[], at: number, cwd: string, d: Deps, backlog: BacklogAccess, cache?: string, scriptRoot?: string): Promise<number> {
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
    // read as a change (the app answers 404 for a number that is none): the result goes on it, never on a PR of the same number
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
  if (!args.includes("--force") && !args.includes("--all")) {
    // the run the app recorded for this change, of this head and this base's tip; the app out of reach = no reuse
    const last = await ciRecordOf(d.records, `local:${workspace}`, n).catch(() => undefined);
    if (last?.outcome === "pass" && last.head === first.changeRefs.head && last.base === first.changeRefs.base) {
      d.log(`既に pass（#${n} の今の head と base、job#${last.id}）。回し直すなら --force`);
      return 0;
    }
  }
  let r: LocalCiResult;
  try {
    r = await localCi(n, root, d, workspace, cache, { all: args.includes("--all"), change: { label, read }, ...imageRootFor(root, scriptRoot) });
  } catch (e) {
    // nothing to run: one line naming where the steps go, nothing posted
    if (!(e instanceof NoCiSteps)) throw e;
    console.error(e.message);
    return 2;
  }
  if (r.notStarted) {
    console.error(`${notStartedLines(r.notStarted)}\n結果は付けない`);
    return 2;
  }
  const t = { pr: n, repo: workspace, root, change: true as const };
  try {
    if (!(await notify(t, r, d, (t, body, run) => reportResult({ ...t, change: true }, body, run, runGlab, backlog), read))) return 1;
  } catch (e) {
    console.error(`結果を変更 #${n} に投稿できなかった: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return r.conflict ? 1 : ciExit(r.results);
}

/**
 * The ci image's source for a run on the clone `root`: Switchboard's own clone (`scriptRoot`, where this script and container/Dockerfile are)
 * when the target is another repository; none for Switchboard itself (the checkout that is built: a PR that changes the Dockerfile is
 * tried on its own image). Never decided by whether the target has such a file.
 */
export const imageRootFor = (root: string, scriptRoot: string | undefined): { imageRoot?: string } => (scriptRoot && !sameClone(root, scriptRoot) ? { imageRoot: scriptRoot } : {});

/** Are the two paths work trees of one clone (the same git common dir)? A path that is no work tree is its own. */
function sameClone(a: string, b: string): boolean {
  if (a === b) return true;
  const common = (dir: string) => {
    const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  };
  const [x, y] = [common(a), common(b)];
  return x !== null && x === y;
}

/**
 * The command: its exit code. 2 = the target cannot be run, its checkout has no CI steps, or the build off the host could not be started (nothing posted), 1 = a failure, a conflict, a result not
 * posted (the head moved during the run, or the post failed; a base that alone moved is still posted), 0 = a pass posted or one already there. `scriptRoot`: the clone without --repo.
 * `cache`: where the run's worktrees and logs go (~/.cache; tests give their own).
 */
export async function main(args: string[], cwd: string, d: Deps, post = reportResult, scriptRoot = join(import.meta.dir, ".."), cache?: string, backlog: BacklogAccess = { env: process.env }, live?: (p: Pending) => boolean): Promise<number> {
  const changeAt = args.indexOf("--change");
  if (changeAt >= 0) return changeMain(args, changeAt, cwd, d, backlog, cache, scriptRoot);
  // `--collect` alone: the builds still pending (the daemon runs it at its start)
  if (args.length === 1 && args[0] === "--collect") return collectPending(d, cache ?? join(homedir(), ".cache"), post, live);
  let t: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    t = await resolveTarget(args, cwd, scriptRoot, d.sh);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    console.error(`${e.message}\nusage: bun scripts/local-ci.ts <PR> [--repo <owner/name>] [--all] [--force] [--local]`);
    return 2;
  }
  // `--local`: the host's own steps even where a build off the host could be used (the slot is taken as without sb-offload)
  if (t.local) {
    const { offload: _off, ...here } = d;
    d = here;
  }
  const url = await reusablePass(t, d.sh, d.records);
  if (url) {
    // a record of a build for this head and base is a result already there: `--collect` would post a second mark
    const now = await readTarget(t.pr, t.root, t.repo, d).catch(() => undefined);
    const left = now && pendingFor(cache ?? join(homedir(), ".cache"), t.repo, t.pr, now.head, now.base);
    if (left) clearPending(cache ?? join(homedir(), ".cache"), t.repo, t.pr, left.build);
    d.log(`既に pass（${url}）。回し直すなら --force`);
    return 0;
  }
  // a rebase that kept every diff since the newest pass: that pass is the one merge-gate counts, nothing is built or posted.
  // The commits are counted from the default branch's tip, not the base's: a stacked PR's base is the branch below it, and
  // a fix added there is one merge-gate asks the top's pass to hold (a count from the base would not see it)
  if (!t.all && !t.force) {
    const now = await readTarget(t.pr, t.root, t.repo, d).catch(() => undefined);
    const tip = now && await defaultTip(t.pr, t.root, t.repo, d).catch(() => undefined);
    const inc = now && tip && await incrementalBase(t.pr, t.repo, t.root, now.head, tip, d);
    if (now && inc && inc.commits.length === 0) {
      const left = pendingFor(cache ?? join(homedir(), ".cache"), t.repo, t.pr, now.head, now.base);
      if (left) clearPending(cache ?? join(homedir(), ".cache"), t.repo, t.pr, left.build);
      d.log(`前の pass（${inc.pass.slice(0, 7)}）の後に足されたコミットが無い（rebase だけ）。merge-gate はその pass を数える。回し直すなら --force`);
      return 0;
    }
  }
  let r: LocalCiResult;
  try {
    r = await localCi(t.pr, t.root, d, t.repo, cache, { all: t.all, force: t.force, ...imageRootFor(t.root, scriptRoot) });
  } catch (e) {
    if (!(e instanceof NoCiSteps)) throw e;
    console.error(e.message);
    return 2;
  }
  // sb-offload's own failure says nothing about the PR: no mark (a fail would name the first step), no pending record
  if (r.notStarted) {
    console.error(`${notStartedLines(r.notStarted)}\n結果は付けない`);
    return 2;
  }
  try {
    const { posted, readFailed } = await notifyKeeping(t, r, d, post);
    // written, or not to be (moved): the record has done its work. A post that failed or a head and base that could not be read leaves it: the next run of the same head and base takes this build's result
    if (!readFailed) {
      // a --local run has no build of its own; an off-host build's record of this head and base would make `--collect` post a second mark
      const gone = r.build ?? (t.local ? pendingFor(cache ?? join(homedir(), ".cache"), t.repo, t.pr, r.sha, r.base)?.build : undefined);
      if (gone) clearPending(cache ?? join(homedir(), ".cache"), t.repo, t.pr, gone);
    }
    if (!posted) return 1;
  } catch (e) {
    // authentication or permission: said and stopped, not tried another way
    console.error(`結果を PR に投稿できなかった（認証・権限を確かめる）: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // the same exit as Actions' entry; a conflict ran nothing and is a failure
  return r.conflict ? 1 : ciExit(r.results);
}

if (import.meta.main) {
  const offload = hostOffload();
  process.exit(await main(process.argv.slice(2), process.cwd(), { sh, step, log: (l) => console.log(l), slot: (name, fn) => withHeavySlot(name, fn), workspace: (root) => workspaceSettingsOf(root), records: recordsFrom(process.env), ...(offload ? { offload } : {}) }));
}
