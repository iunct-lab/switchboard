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
 * `bun test`, so a run can have two, #2945); the perf steps do not run here (the tag CI's, #4076).
 * After every step passed, the type check's and bun test's seconds are compared with the `local` ceilings of the checkout's
 * scripts/perf-budget.json (#1887), bun test's only when every test ran (#3297): over one → still a pass, with the `over:`
 * lines as a warning in the comment (`warnings`). A checkout without that file or those ceilings is not compared.
 * `bun test` runs the tests of the checkout's scripts/test-select.ts for what the PR and the PRs below it changed; a
 * change it cannot judge, or a selection that cannot be read, runs all of them, and so does `--all`. Only this script
 * narrows: tag-ci's `runCheckout` runs every test, and the other steps run, except in an incremental run (below) (#3297).
 * Incremental run: when the PR's newest result is a pass of an earlier head and the commits added since (`git cherry`) hold no
 * merge commit the pass lacks, `bun test` is chosen from those commits' files only and only the install, the type check
 * and that `bun test` run; the other steps are the tag CI's (`incrementalBase`, `incrementalSteps`). A change the
 * selection cannot judge, `--all`, `--change` or a missing earlier pass run every step. The mark is the usual pass.
 * A head whose newest result merge-gate already counts as a pass is not run again (`existingPass`, #1882): `--force` runs
 * it, and `--all` does too (a narrowed pass is not what it asks for). GitHub only.
 * A checkout whose `ops.config.json` has `ci.steps` runs those instead of ci.yml's (a repository that keeps no CI on
 * GitHub, #3932); one with neither exits 2 with one line naming where they go, nothing posted.
 * `--repo <owner/name>` (#1203): another repository's PR, run from that repository's working tree (its origin must be
 * owner/name); the mark goes on that PR. Without it: the repository of the clone this script is in (that clone's
 * origin), run in that clone.
 * On the cloud host (`sb-offload` on PATH) every step of the CI runs off the host in one build, in the CI's order: here only the
 * work tree is made and the result read (docs/design/local-ci-offload.md).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgeOf, forgeTargetOf, LOCAL_SERVICE, originOf, runForgeOperation } from "../ops-kit/src/forge.ts";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { gitlabForge, runGlab, viewGitlabMr, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { githubForge } from "../ops-kit/src/forge-github.ts";
import { appForge } from "../ops-kit/src/forge-app.ts";
import { CiConfig, CONFIG_FILE } from "../ops-kit/src/config.ts";
import { IDLE_KILLED_LINE, runIdle } from "../ops-kit/src/idle-run.ts";
import { hostAws, type HostAws } from "../ops-kit/src/secrets.ts";
import { ciExit, runCi, STEP_IDLE_SECONDS, type Step } from "./ci.ts";
import { BYTES_RECORDS_HEADER, BYTES_RECORDS_PATH, bytesRows, COUNTS_RECORDS_HEADER, COUNTS_RECORDS_PATH, countsRows, type Env, envOf, judgeDurations, recordRow, RECORDS_BRANCH, RECORDS_HEADER, RECORDS_PATH, type Budget, type Budgets, type JourneyBytes } from "./perf-ratchet.ts";
import { localCiOf, localCiOfChange, MARK_AUTHORS, newestLocalCi, readChangeDetail } from "./merge-gate.ts";
import { isTest } from "./test-select.ts";
import { knownLines, readKnownFailures, subtractKnown, type Subtracted } from "./known-failures.ts";

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

/** The lines of a step's output that name what failed: bun test's `(fail)` lines, perf-ratchet's `over:` / `raised:` / `improved:` / `grew:` lines, idle-run's reason and an off-host build's end (`sb-offload: exit`), once each, in order. */
export function failLines(output: string): string[] {
  const perf = (l: string) => l.includes("over:") || l.startsWith("raised: ") || l.startsWith("improved: ") || l.startsWith("grew: ");
  return [...new Set(output.split("\n").filter((l) => l.startsWith("(fail)") || perf(l) || l.startsWith("無進捗で打ち切り") || l.startsWith("sb-offload: exit ")))];
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

/** The steps without the perf ones (the web build up to the last perf step; the install stays, bun test and the rest are not between). A CI without them is returned as it is. */
export function withoutPerf(steps: Step[]): Step[] {
  const build = steps.findIndex((s) => s.run.trim() === "bun run --cwd apps/web build");
  const last = steps.map((s) => isPerfStep(s)).lastIndexOf(true);
  if (build < 0 || last < build) return steps;
  return [...steps.slice(0, build), ...steps.slice(last + 1)];
}

/** The step of ci.yml that runs scripts/ci.ts: Actions runs those steps in one go, local-ci one by one (#912). */
export const SHARED_ENTRY = "bun scripts/ci.ts";

/** A checkout whose CI steps cannot be read: none in `ops.config.json`'s `ci.steps` nor in ci.yml, or `ci` is not in its shape (#3932). */
export class NoCiSteps extends Error {}

/** Where a checkout keeps its CI's steps, for the message of `NoCiSteps`. */
export const CI_STEPS_PLACES = "`ops.config.json` の `ci.steps`（GitHub と連携するなら `.github/workflows/ci.yml`）";

/**
 * The steps of `ops.config.json`'s `ci.steps` in `dir` (#3932), or null when the file or the key is not there. Only
 * `ci` is read (as `loadPublicSync` reads its key): another key's mistake is not the CI's to refuse.
 */
export function configSteps(dir: string): Step[] | null {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return null;
  let json: { ci?: unknown } | null;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as { ci?: unknown } | null;
  } catch (e) {
    throw new NoCiSteps(`${CONFIG_FILE} を読めない: ${(e as Error).message}`);
  }
  if (json === null || typeof json !== "object" || json.ci === undefined) return null;
  const r = CiConfig.safeParse(json.ci);
  if (!r.success) throw new NoCiSteps(`${CONFIG_FILE} の ci が不正: ${r.error.issues.map((i) => `ci.${i.path.join(".")}: ${i.message}`).join(" / ")}`);
  return r.data.steps.map((s) => ({ name: s.name ?? s.run.split("\n")[0]!, run: s.run }));
}

/**
 * What a checkout's CI runs: `ops.config.json`'s `ci.steps` when it has them (a repository that keeps no CI on GitHub,
 * #3932; ci.yml is not read then), else ci.yml's `run:` steps, with the shared entry replaced by that checkout's own
 * scripts/ci.ts steps (another repository's ci.yml has none, #1203). Those are the PR's code: read by `--list` in a
 * process of its own with `env` (the steps' environment), never imported into this one. Neither → `NoCiSteps`.
 */
export async function checkoutSteps(dir: string, env: Record<string, string>): Promise<Step[]> {
  const configured = configSteps(dir);
  if (configured) return configured;
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
/** `seconds`: a pass's type check and bun test seconds (#1886), for a checkout with scripts/ci.ts. */
/** `selection`: what chose this run's tests, none with `--all` (#3297). `bundle`: the perf check's `bundle:` and `grew:` lines, pass or fail. */
/** `incremental`: this run was only the commits since the earlier pass `pass` (`incrementalBase`). */
export interface LocalCiResult { /** The build the result is of (off the host): its record is the one to remove. */ build?: string; sha: string; base: string; results: StepResult[]; ok: boolean; seconds?: StepSeconds; conflict?: boolean; warnings?: string[]; perf?: PerfVerdict; selection?: TestSelection; bundle?: string[]; incremental?: { pass: string; commits: number; files: number }; /** bun test's failures taken off by the registry at the base (known-failures.json): `subtracted` are why a pass is a pass, `expired` were registered but past their date (still failures), `unreadable` = the registry could not be read (nothing taken off). */ known?: { subtracted: Subtracted[]; expired: Subtracted[]; unreadable?: string } }

/** What a run's bun test covered, for the comment: the seen line and the machine line; a selection's reason can list every changed file. */
function testsLines(s: TestSelection | undefined): string[] {
  if (!s) return ["テスト: 全ファイル（--all）"];
  // none counted: "every test" would read as if they all ran (#3932). Only what `total` counts is named (isTest)
  const seen = s.total === 0 ? "テスト: なし（`*.test.ts` / `*.test.tsx` のファイルが 1 つも無い）" : s.files ? `テスト: ${s.files.length} / ${s.total} ファイル（影響範囲の選択）` : `テスト: 全 ${s.total} ファイル（全テストに倒した: ${s.reason.length > 300 ? `${s.reason.slice(0, 300)}…` : s.reason}）`;
  return [seen, `<!-- local-ci-tests ${JSON.stringify({ ran: s.files?.length ?? null, total: s.total })} -->`];
}

/** The PR comment of a run, pass or not (#913): the mark (the first line only: merge-gate reads no more, #3118), a pass's seconds line, what was tested, the bundle against main's tip, every step that ran; a failure names its step and what failed in it. */
export function resultComment(r: LocalCiResult): string {
  const head = [
    `[local-ci] ${r.ok ? "pass" : "fail"} ${r.sha} base=${r.base}`,
    ...(r.ok && r.seconds ? [`<!-- local-ci-seconds ${JSON.stringify(r.seconds)} -->`] : []),
    "",
    "CI の手順（`ops.config.json` の `ci.steps`、無ければ `.github/workflows/ci.yml`。`bun scripts/ci.ts` は `scripts/ci.ts` の各手順）を、head を base にマージしたものでローカルで実行した（`bun scripts/local-ci.ts`）。",
    "",
    `対象: head \`${r.sha}\` を base \`${r.base}\` にマージ`,
  ];
  if (r.conflict) return [...head, "", "結果: head を base にマージできない（衝突）。手順は実行していない。base を取り込んでから回し直す。"].join("\n");
  // every failed step: a perf step's failure does not stop bun test (#2945)
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
}

/** The size of an off-host build, `sb-offload --size`. */
export type OffloadSize = "small" | "medium" | "large";

/** What a build is given besides its script: its size, the directory of recordings (`--fixtures`), the file of the host's AWS names (`--names`, a path only: its content is in no script, argument or log) and the tar of the tag a perf run compares with (`--base-tree`). */
export interface OffloadRun { size: OffloadSize; fixtures?: string; names?: string; baseTree?: string }

/** `start` could not start the build: sb-offload's exit code and what it printed (`runBuild` makes it the failed result of the build's first step). */
export class OffloadStartError extends Error {
  constructor(readonly code: number, readonly output: string) {
    super(`sb-offload: ビルドを始められなかった（exit ${code}）`);
  }
}

/**
 * `start`: one build of `script` with `cwd`'s work tree in the ci image (`sb-offload --ci --detach`), returning its id as soon as it has started (throws `OffloadStartError` when it did not).
 * `collect`: waits for that build (`sb-offload --collect <id>`, from any process, later too): its code is sb-offload's (the script's, or 124 timed out / 130 stopped / 1 failed before it) and its log.
 * `fixtures`: the recordings the build reads (read only there) and whether the run needs them (`required`: `SWITCHBOARD_FIXTURES` given here, so a missing recording fails a test).
 */
export interface Offload {
  fixtures?: { dir: string; required: boolean };
  start: (script: string, cwd: string, o: OffloadRun) => Promise<{ build: string }>;
  collect: (build: string) => Promise<{ code: number; output: string }>;
  /** Whether the installed `sb-offload` takes `--base-tree` (its usage names it; the host's is replaced only at boot, so an older one may not). Not given = it does. */
  knowsBaseTree?: () => Promise<boolean>;
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** `bun test` of those files (a step's script), or a line saying none were selected. */
export const testRun = (files: string[]) => (files.length ? `bun test ${files.map((f) => quote(`./${f}`)).join(" ")}` : 'echo "no test files selected"');

/** A step's marks in a build's log: `sb-step: <i> begin <epoch s>` and `sb-step: <i> exit <code> <epoch s>`. */
const MARK = /^sb-step: (\d+) (begin|exit) (?:(\d+) )?([\d.]+)$/;

/**
 * One build's script, run by `sb-offload --ci` in the ci image (git with PCRE, Bun, Codex CLI, Chromium are the image's):
 * as root, a tmpfs TMPDIR and the work tree's owner; then, in a new PID namespace, as the image's user `switchboard` (a login `su -`, so the
 * build's own environment, its credentials included, does not reach the steps; only the image's CHROME_BIN and
 * PLAYWRIGHT_BROWSERS_PATH are passed) the work tree as one commit with `origin` (a URL, no credentials), the install,
 * and every step in `bash -e -c` between its marks, stopping at the first that fails (a `keepGoing` step does not stop it).
 * `fixtures`: the build has the recordings in the user's `~/.switchboard/fixtures`; `required` exports SWITCHBOARD_FIXTURES so that a missing recording fails a test.
 * The host's AWS names reach the build as the user's `~/.aws/config`, written by the build's setup from `--names` (`runBuild`); the script holds none of them.
 * Nothing of this host's environment goes in (no token, no recordings' place). docs/design/local-ci-offload.md.
 * Why the PID namespace: the build's PID 1 does not reap orphans, so a killed child stays a zombie that `kill(pid, 0)` finds
 * alive and the child-cleanup tests fail. The namespace's init is a bash that reaps them; `exit $?` keeps bash from
 * replacing itself with su (then su would be PID 1 and reap nothing).
 */
export function ciScript(steps: Step[], o: { repo?: string; fixtures?: { required: boolean }; perf?: true }): string {
  const lastPerf = o.perf ? steps.map((s) => isPerfStep(s)).lastIndexOf(true) : -1;
  const origin = o.repo && /^[\w.-]+\/[\w.-]+$/.test(o.repo) ? ` && git remote add origin ${quote(`https://github.com/${o.repo}.git`)}` : "";
  const user = [
    "set -u",
    "cd /sb/work",
    'export CI=true TMPDIR="$(mktemp -d /sb/tmp/t.XXXXXX)"',
    ...(o.fixtures?.required ? ["export SWITCHBOARD_FIXTURES=$HOME/.switchboard/fixtures"] : []),
    ...(o.perf ? ["export PERF_ENV=offload"] : []),
    "git config --global user.name local-ci && git config --global user.email local-ci@localhost && git config --global init.defaultBranch main",
    `{ git init -q${origin} && git add -A && git commit -qm local-ci; } || { echo "sb-setup: git の作業ツリーを作れない"; exit 1; }`,
    'bun install --frozen-lockfile >/tmp/install.log 2>&1 || { cat /tmp/install.log; echo "sb-setup: bun install が失敗"; exit 1; }',
    ...steps.flatMap((s, i) => [
      `echo "sb-step: ${i} begin $(date +%s.%N)"`,
      `bash -e -c ${quote(s.run)}; c=$?; echo; echo "sb-step: ${i} exit $c $(date +%s.%N)"${s.keepGoing ? "" : '; [ "$c" -eq 0 ] || exit "$c"'}`,
      // after the last perf step: the files the host's records and judgement read, one line each (a missing file or a failure here changes no step's result)
      ...(i === lastPerf ? [`for f in ${BUILD_FILES.join(" ")}; do [ -f "$f" ] && echo "sb-file: $f $(base64 -w0 "$f")"; done; true`] : []),
    ]),
  ].join("\n");
  return [
    "set -u",
    "cat > /tmp/sb-local-ci.sh <<'SB_LOCAL_CI_EOF'",
    user,
    "SB_LOCAL_CI_EOF",
    'mkdir -p /sb/tmp && mount -t tmpfs -o size=2g,mode=1777 tmpfs /sb/tmp || { echo "sb-setup: tmpfs を作れない"; exit 1; }',
    'chown -R switchboard /sb/work && chmod 644 /tmp/sb-local-ci.sh || { echo "sb-setup: 作業ツリーの持ち主を switchboard にできない"; exit 1; }',
    'unshare --pid --fork --mount-proc true || { echo "sb-setup: PID 名前空間を作れない"; exit 1; }',
    `unshare --pid --fork --mount-proc bash -c 'su - switchboard -c "CHROME_BIN=\${CHROME_BIN:-} PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-} PERF_BASE_TREE=\${PERF_BASE_TREE:-} bash /tmp/sb-local-ci.sh"; exit $?'`,
  ].join("\n");
}

/** The files a perf build gives back in its log (`sb-file: <name> <base64>`); no other name is taken. */
const BUILD_FILES = ["perf-result.json", "perf-base.json"];

/** The files a build's log carries (`ciScript` with `perf`) by name, the last line of a name winning; a name that is not one of `BUILD_FILES` (a path included) is ignored. */
export function buildFiles(output: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const l of output.split("\n")) {
    const m = /^sb-file: (\S+) ([A-Za-z0-9+/=]*)$/.exec(l.trim());
    if (!m || !BUILD_FILES.includes(m[1]!)) continue;
    const bytes = Buffer.from(m[2]!, "base64");
    // a line the log cut or split decodes to broken JSON: leave the file out (perf then reads as not measured) instead of writing it
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      console.error(`sb-file: ${m[1]} is not JSON (the log line was cut?): left out`);
      continue;
    }
    files[m[1]!] = bytes;
  }
  return files;
}

/** What sb-offload's own exit means when a step has no exit mark. */
const offloadReason = (code: number) => `sb-offload: exit ${code}（${code === 124 ? "時間切れ" : code === 130 ? "中断" : "ビルドの失敗"}）`;

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
 * The one build of every step of a CI (`ciScript`): the host's AWS names go in a JSON of mode 600 in a directory of its own, given by path as
 * `names` and removed once the build has started (sb-offload has sent it by then); the value is in no script, argument other than that path, environment or log.
 * A host with no AWS config (or a `host` with none, as test-changed passes: its build runs no public-tree check) gives no file.
 * `started` is told the build's id before the wait, to be written down (`writePending`); a build that did not start is a failed one (sb-offload's code and output).
 */
export async function runBuild(offload: Offload, steps: Step[], cwd: string, o: { repo?: string; size?: OffloadSize; host?: HostAws; perf?: true; baseTree?: string; started?: (build: string) => void } = {}): Promise<{ code: number; output: string }> {
  const host = o.host ?? hostAws();
  const hasNames = host.names.length + host.accountIds.length > 0;
  const script = ciScript(steps, { ...(o.repo ? { repo: o.repo } : {}), ...(offload.fixtures ? { fixtures: { required: offload.fixtures.required } } : {}), ...(o.perf ? { perf: true as const } : {}) });
  const dir = hasNames ? mkdtempSync(join(tmpdir(), "switchboard.names.")) : undefined;
  let build: string;
  try {
    let names: string | undefined;
    if (dir) {
      names = join(dir, "names.json");
      writeFileSync(names, JSON.stringify({ names: host.names, accountIds: host.accountIds }), { mode: 0o600 });
    }
    build = (await offload.start(script, cwd, { size: o.size ?? "small", ...(offload.fixtures ? { fixtures: offload.fixtures.dir } : {}), ...(names ? { names } : {}), ...(o.baseTree ? { baseTree: o.baseTree } : {}) })).build;
  } catch (e) {
    if (e instanceof OffloadStartError) return { code: e.code, output: e.output };
    throw e;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  o.started?.(build);
  return offload.collect(build);
}

/**
 * The real build when `sb-offload` is on PATH (the cloud host), else none. Its environment has no GitHub token and no recordings' place.
 * The recordings go by `--fixtures`: `SWITCHBOARD_FIXTURES` here when given (the run needs them: `required`), else `~/.switchboard/fixtures` when it exists.
 */
export function hostOffload(): Offload | undefined {
  const bin = Bun.which("sb-offload", { PATH: process.env.PATH ?? "" });
  if (!bin) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !["GH_TOKEN", "GITHUB_TOKEN", "SWITCHBOARD_FIXTURES"].includes(k))) as Record<string, string>;
  const given = process.env.SWITCHBOARD_FIXTURES;
  const usual = join(process.env.HOME || homedir(), ".switchboard", "fixtures");
  const fixtures = given ? { dir: given, required: true } : existsSync(usual) ? { dir: usual, required: false } : undefined;
  let usage: Promise<boolean> | undefined;
  return {
    ...(fixtures ? { fixtures } : {}),
    // called with no arguments sb-offload prints its usage (stderr, exit 2): read once per process
    knowsBaseTree: () =>
      (usage ??= (async () => {
        try {
          const p = Bun.spawn([bin], { env, stdout: "pipe", stderr: "pipe" });
          const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
          return `${out}${err}`.includes("--base-tree");
        } catch {
          // it cannot be run: no base tree; the build's start then fails and says why
          return false;
        }
      })()),
    start: async (script, cwd, o) => {
      const p = Bun.spawn([bin, "--ci", "--detach", ...(o.fixtures ? ["--fixtures", o.fixtures] : []), ...(o.names ? ["--names", o.names] : []), ...(o.baseTree ? ["--base-tree", o.baseTree] : []), "--size", o.size, script], { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      // the image build's log may come before it: only the started line names the build
      const build = out.split("\n").map((l) => /^sb-offload: started (\S+)$/.exec(l.trim())?.[1]).find((b) => b);
      if (code !== 0 || !build) throw new OffloadStartError(code === 0 ? 1 : code, `${out}${err}`);
      return { build };
    },
    collect: async (build) => {
      const p = Bun.spawn([bin, "--collect", build], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, output: `${out}${err}` };
    },
  };
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

/**
 * What the PR gained since its newest pass (an incremental run): the pass's head `pass`, the commits `git cherry` marks
 * `+` between the PR's merge-base with the base's tip and `head` (a rebase that kept a diff adds none), and the files
 * they touch, deleted ones too. None when the newest result (of MARK_AUTHORS) is no pass, is of this head, a merge
 * commit of the PR is not in the pass's history (a conflict resolved: `inPass`'s rule), or anything cannot be read.
 */
export async function incrementalBase(pr: number, repo: string, repoRoot: string, head: string, baseTip: string, d: Pick<Deps, "sh">): Promise<{ pass: string; commits: string[]; files: string[] } | undefined> {
  try {
    const view = JSON.parse(await d.sh(["gh", "pr", "view", String(pr), "-R", repo, "--json", "comments"])) as { comments?: Array<{ body: string; createdAt: string; authorAssociation?: string }> };
    const newest = newestLocalCi((view.comments ?? []).filter((c) => MARK_AUTHORS.includes(c.authorAssociation ?? "")));
    if (newest?.m[1] !== "pass" || newest.m[2] === head) return undefined;
    const pass = newest.m[2]!;
    const at = ["git", "-C", repoRoot];
    await d.sh([...at, "fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", pass]);
    const mergeBase = (await d.sh([...at, "merge-base", baseTip, head])).trim();
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

/** The steps of an incremental run: the install, the type check and `bun test` given `files`; none when the CI lacks one of them. */
export function incrementalSteps(steps: Step[], files: string[]): Step[] | undefined {
  const keep = ["bun install --frozen-lockfile", "bun run typecheck", "bun test"];
  const kept = steps.filter((s) => keep.includes(s.run.trim()));
  return keep.every((k) => kept.some((s) => s.run.trim() === k)) ? narrowTestStep(kept, files) : undefined;
}

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

/**
 * A build started and not yet written to its PR: what writing the mark needs, no more (no token, no AWS name: the build's id is all that names the build).
 * One file per PR under `pendingDirOf`, written when the build has started and removed once its result was posted (or was not to be posted), so a local-ci
 * that is gone (the daemon restarted, the host stopped) leaves the result to `--collect`.
 */
export interface Pending {
  repo: string;
  pr: number;
  /** The clone the result is posted through (`resolveTarget`'s root). */
  root: string;
  head: string;
  base: string;
  build: string;
  /** When the build started (ms): its log is kept 7 days. */
  at: number;
  steps: Step[];
  selection?: TestSelection;
  incremental?: { pass: string; commits: number; files: number };
  /** The checkout has scripts/ci.ts: a pass carries its step seconds. */
  ciTs: boolean;
  /** The local-ci process waiting for this build and this boot's id (null when unreadable): while it is alive it writes the result itself, and `--collect` leaves the record. */
  pid: number;
  boot: string | null;
}

/** This boot's id, or null when it cannot be read. */
export const bootId = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** Is the process that wrote this record still alive, in the same boot? (a pid means nothing after a reboot) */
export const recordLive = (p: Pending, boot = bootId(), cmdline: (pid: number) => string | null = procCmdline): boolean => {
  if (p.pid === process.pid || boot === null || p.boot !== boot) return false;
  // the pid may be another process's by now: it must still be a local-ci (unreadable = gone)
  return cmdline(p.pid)?.includes("local-ci") ?? false;
};

/** The command line of a process (/proc/<pid>/cmdline, its arguments joined by spaces), or null when it cannot be read. */
const procCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return null;
  }
};

/** Does a collected build's output say anything about the build? A build that is not there (`no build`), a read that failed, and a SUCCEEDED build whose log is gone (`ended SUCCEEDED without the command's exit code`: its log is kept 7 days, the build's record longer) say nothing; one that ended before its steps (`ended FAILED / FAULT / STOPPED / TIMED_OUT without the command's exit code`) is a failed build. */
export const buildSpoke = (output: string): boolean => /^(sb-step: |sb-offload: exit \d+$)/m.test(output) || /^sb-offload: \S+ ended (FAILED|FAULT|STOPPED|TIMED_OUT) without the command's exit code$/m.test(output);

/**
 * Where the pending records are: `switchboard.local-ci-pending` under `cache` (~/.cache). The same place as `localCiPendingDir` in
 * packages/core/src/jobs.ts, which the daemon looks in at its start to run `--collect`; scripts/ do not import packages/core, so the name is written in both.
 */
export const pendingDirOf = (cache: string): string => join(cache, "switchboard.local-ci-pending");
const pendingFile = (cache: string, repo: string, pr: number): string => join(pendingDirOf(cache), `${repo.replaceAll("/", "_")}-${pr}.json`);
/** How long the build's log is kept (CodeBuild's, 7 days). */
export const BUILD_LOG_KEEP_MS = 7 * 24 * 3600 * 1000;

export function writePending(cache: string, p: Pending): void {
  mkdirSync(pendingDirOf(cache), { recursive: true });
  const file = pendingFile(cache, p.repo, p.pr);
  writeFileSync(`${file}.tmp`, JSON.stringify(p), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Removes the PR's record only when it is still of `build` (another run may have written its own build's since). */
export function clearPending(cache: string, repo: string, pr: number, build: string): void {
  const file = pendingFile(cache, repo, pr);
  if (readPendingFile(file)?.build === build) rmSync(file, { force: true });
}

const readPendingFile = (file: string): Pending | undefined => {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Partial<Pending>;
    return typeof p.repo === "string" && Number.isInteger(p.pr) && typeof p.root === "string" && typeof p.head === "string" && typeof p.base === "string" && typeof p.build === "string" && typeof p.at === "number" && Array.isArray(p.steps) ? (p as Pending) : undefined;
  } catch {
    return undefined;
  }
};

/** The PR's record when it is of this head and base (a build that already runs or ran for them). */
export function pendingFor(cache: string, repo: string, pr: number, head: string, base: string): Pending | undefined {
  const p = readPendingFile(pendingFile(cache, repo, pr));
  return p && p.head === head && p.base === base ? p : undefined;
}

/** The comment's result from a collected build: the steps read by their marks, as a run here reads them. */
async function resultOf(p: Pending, out: { code: number; output: string }, d: Pick<Deps, "log" | "sh">, cache: string, today?: string): Promise<LocalCiResult> {
  const ran = parseBuild(out.output, p.steps, out.code);
  const { results, ok, bundle, outputs } = await settle(ran, d, `local-ci-${p.repo.replaceAll("/", "_")}-${p.pr}`, cache);
  const seconds = ok && p.ciTs ? stepSeconds(results) : undefined;
  const r = { sha: p.head, base: p.base, results, ok, ...(seconds ? { seconds } : {}), ...(p.selection ? { selection: p.selection } : {}), ...(bundle.length ? { bundle } : {}), ...(p.incremental ? { incremental: p.incremental } : {}) };
  return ok ? r : withKnown(r, outputs, d.sh, p.root, today);
}

/**
 * A failed result whose only failed step is bun test with (fail) lines: what the registry at the base (known-failures.json) names, in date, is no
 * failure (subtractKnown; never the head's registry, a PR does not excuse its own failures). All taken off = a pass without seconds (a failed run's
 * seconds are not compared); some left = still a fail whose bun test lines are those left. Shared by a run here and a result collected later.
 */
async function withKnown(r: LocalCiResult, outputs: Record<string, string>, sh: Deps["sh"], repoRoot: string, today = new Date().toISOString().slice(0, 10)): Promise<LocalCiResult> {
  const failed = r.results.filter((x) => x.code !== 0);
  const step = failed.length === 1 && failed[0]!.name === SECONDS_STEPS.test ? failed[0]! : undefined;
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
 * posted when the head or base moved), then removes the record. A build whose log is gone (older than 7 days) is said and removed. Exit 0 = every record was
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
      const { posted, readFailed } = await notifyKeeping(t, r, d, post);
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

/** `cache`: where the worktree and the failure logs go (~/.cache; tests give their own). TMPDIR goes under tmpdir() (#1056). */
export async function localCi(pr: number, repoRoot: string, d: Deps, repo: string, cache = join(homedir(), ".cache"), opts: { all?: boolean; force?: boolean; change?: ChangeTarget; today?: string } = {}): Promise<LocalCiResult> {
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
      writePending(cache, { ...prior, pid: process.pid, boot: bootId() });
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
      const env = stepEnv(tmp);
      // the commits since the PR's newest pass, when there is one to build on (never for --all or a local change)
      const inc = opts.all || opts.force || change ? undefined : await incrementalBase(pr, repo, repoRoot, sha, base, d);
      const picked = opts.all ? undefined : await selectTests(dir, () => (change ? Promise.resolve(base) : mainFork(dir, repo, d.sh)), env, d, inc?.files);
      // a CI without the incremental steps ran every test, whatever the commits since the pass chose
      const selectionOf = (incremental: boolean) => (picked && inc && picked.files && !incremental ? { files: null, total: picked.total, reason: "増分に使える手順が無い", unjudged: true as const } : picked);
      const incrementalOf = (incremental: boolean) => (incremental && inc ? { pass: inc.pass, commits: inc.commits.length, files: inc.files.length } : undefined);
      // the build's id is written down as soon as it has started (a PR only): a run that is cut off then leaves its result to `--collect`
      const started = change ? undefined : (build: string, steps: Step[], incremental: boolean) => {
        const selection = selectionOf(incremental);
        const summary = incrementalOf(incremental);
        built = build;
        writePending(cache, { repo, pr, root: repoRoot, head: sha, base, build, at: Date.now(), pid: process.pid, boot: bootId(), steps, ...(selection ? { selection } : {}), ...(summary ? { incremental: summary } : {}), ciTs: existsSync(join(dir, "scripts/ci.ts")) });
      };
      const run = await runCheckout(dir, env, change ? change.label : `local-ci-${repo.replaceAll("/", "_")}-${pr}`, d, cache, picked?.files, change ? undefined : repo, false, !!inc && !!picked?.files, started);
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
        return { sha, base, results, ok: true, ...(seconds ? { seconds } : {}), ...(over.length ? { warnings: over } : {}), ...narrowed, ...bundle, ...incremental };
      }
      return withKnown({ sha, base, results, ok: false, ...narrowed, ...bundle, ...incremental }, run.outputs, d.sh, repoRoot, opts.today);
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
 * Appends one row (when, js, css, main's sha) to bundle.tsv on the records branch of `repo` (#3169), from the
 * perf-base.json the CI wrote in `dir` (main's tip measured in the same run); "none" without that file. A measure is a
 * row: the same main measured twice is two rows.
 */
export async function recordBundle(repo: string, dir: string, measuredAt: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-base.json");
  if (!existsSync(file)) return "none";
  const row = recordRow(measuredAt, JSON.parse(readFileSync(file, "utf8")) as { sha: string; bundle: { js: number; css: number } });
  await appendRecord(repo, RECORDS_PATH, RECORDS_HEADER, [row], `${RECORDS_BRANCH}: bundle ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends main's `bytes` of the same measure to bytes.tsv on the records branch (#3921), a row per response's path
 * (`bytesRows`); "none" without perf-base.json or without its `journeys` (a main measured before perf-ratchet measured them).
 */
export async function recordBytes(repo: string, dir: string, measuredAt: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-base.json");
  if (!existsSync(file)) return "none";
  const base = JSON.parse(readFileSync(file, "utf8")) as { sha: string; journeys?: Record<string, JourneyBytes> };
  if (!base.journeys) return "none";
  await appendRecord(repo, BYTES_RECORDS_PATH, BYTES_RECORDS_HEADER, bytesRows(measuredAt, { sha: base.sha, journeys: base.journeys }), `${RECORDS_BRANCH}: bytes ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends the counts of `dir`'s perf-result.json (the median of `--runs 5` this run measured) to counts.tsv on the records
 * branch, a row per count of `tag` at `sha` (`countsRows`); "none" without that file.
 */
export async function recordCounts(repo: string, dir: string, measuredAt: string, env: Env, tag: string, sha: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-result.json");
  if (!existsSync(file)) return "none";
  await appendRecord(repo, COUNTS_RECORDS_PATH, COUNTS_RECORDS_HEADER, countsRows(measuredAt, env, tag, sha, JSON.parse(readFileSync(file, "utf8")) as Budget), `${RECORDS_BRANCH}: counts ${tag} ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends `rows` to `path` on the records branch of `repo`, with `header` when the file is new. The branch is made once
 * (a root commit with a README, never merged). The file goes by the contents API with its sha; a 409 or 422 (another run
 * wrote first, or made the file first) reads it again and puts once more. A file the API no longer returns in base64
 * (over 1 MB) is an error, not an empty file: putting a row on it would replace every row.
 */
async function appendRecord(repo: string, path: string, header: string, rows: string[], message: string, sh: Deps["sh"]): Promise<void> {
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
      const now = await api(`repos/${repo}/contents/${path}?ref=${RECORDS_BRANCH}`).then((o) => JSON.parse(o) as File, absent<File>);
      if (now && now.encoding !== "base64") throw new Error(`${RECORDS_BRANCH}/${path} を contents API で読めない（encoding ${now.encoding ?? "なし"}。1 MB を超えたら分ける）。書かない`);
      const text = now ? Buffer.from(now.content.replace(/\s/g, ""), "base64").toString("utf8") : `${header}\n`;
      const body = { message, branch: RECORDS_BRANCH, content: Buffer.from(`${text}${text.endsWith("\n") ? "" : "\n"}${rows.join("\n")}\n`).toString("base64"), ...(now ? { sha: now.sha } : {}) };
      // the body by a file: the whole file in base64 does not fit in the arguments for long
      const input = join(work, "put.json");
      writeFileSync(input, JSON.stringify(body));
      try {
        await api("-X", "PUT", `repos/${repo}/contents/${path}`, "--input", input);
        return;
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
 * and perf-result.json there. A failure that is not a perf step is logged here; a perf step's is the caller's (the tag CI's). `outputs`: each failed step's whole output by its name.
 * `tests`: only those test files for `bun test` (local-ci); none, or null = every test.
 * `bundle`: the perf check's `bundle:` and `grew:` lines, whether it passed or not (none without that check).
 * `incremental`: `tests` choose the steps of `incrementalSteps` only (a PR's local CI after an earlier pass); `incremental` in the result says whether that happened.
 * `withPerf`: false = the steps without the perf ones (`withoutPerf`): a PR's local CI; the tag CI measures (#4076).
 * `baseTree`: off the host only, the tar of the tag the perf steps compare with (`sb-offload --base-tree`).
 */
export async function runCheckout(dir: string, env: Record<string, string>, label: string, d: Omit<Deps, "slot"> & { slot?: Deps["slot"] }, cache: string, tests?: string[] | null, repo?: string, withPerf = true, incremental = false, started?: (build: string, steps: Step[], incremental: boolean) => void, baseTree?: string): Promise<{ steps: Step[]; results: StepResult[]; ok: boolean; perf?: PerfVerdict; outputs: Record<string, string>; bundle: string[]; offloaded: string[]; incremental: boolean }> {
  // a perf step never stops the steps after it, whatever the repository's CI says: perf does not decide the result (docs/design/perf.md)
  const all = (await checkoutSteps(dir, env)).map((s) => (isPerfStep(s) ? { ...s, keepGoing: true } : s));
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
    const r = await runBuild(offload, steps, dir, { ...(repo ? { repo } : {}), ...(withPerf ? { perf: true as const } : {}), ...(baseTree ? { baseTree } : {}), ...(started ? { started: (build) => started(build, steps, !!inc) } : {}) });
    ran = parseBuild(r.output, steps, r.code);
    // a perf run's files come back in the log: written into `dir` as a run here would leave them, for the records and the judgement
    if (withPerf) for (const [name, bytes] of Object.entries(buildFiles(r.output))) writeFileSync(join(dir, name), bytes);
  }
  const offloaded = offload ? steps.map((s) => s.name) : [];
  const settled = await settle(ran, d, label, cache, dir);
  return { steps, ...settled, offloaded, incremental: !!inc };
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

/** `notify`, saying whether a false is from the head and base not being readable (a result that was not posted for that is not to be dropped). */
async function notifyKeeping(t: { pr: number; repo: string; root: string }, r: LocalCiResult, d: Pick<Deps, "sh" | "log">, post: typeof reportResult): Promise<{ posted: boolean; readFailed: boolean }> {
  let readFailed = false;
  const posted = await notify(t, r, d, post, () => readTarget(t.pr, t.root, t.repo, d).catch((e: unknown) => ((readFailed = true), Promise.reject(e))));
  return { posted, readFailed };
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
  let r: LocalCiResult;
  try {
    r = await localCi(n, root, d, workspace, cache, { all: args.includes("--all"), change: { label, read } });
  } catch (e) {
    // nothing to run: one line naming where the steps go, nothing posted (#3932)
    if (!(e instanceof NoCiSteps)) throw e;
    console.error(e.message);
    return 2;
  }
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
 * The command: its exit code. 2 = the target cannot be run, or its checkout has no CI steps (nothing posted), 1 = a failure, a conflict, a result not
 * posted (moved, or the post failed), 0 = a pass posted or one already there. `scriptRoot`: the clone without --repo.
 * `cache`: where the run's worktrees and logs go (~/.cache; tests give their own).
 */
export async function main(args: string[], cwd: string, d: Deps, post = reportResult, scriptRoot = join(import.meta.dir, ".."), cache?: string, backlog: BacklogAccess = { env: process.env }, live?: (p: Pending) => boolean): Promise<number> {
  const changeAt = args.indexOf("--change");
  if (changeAt >= 0) return changeMain(args, changeAt, cwd, d, backlog, cache);
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
  const url = await reusablePass(t, d.sh);
  if (url) {
    // a record of a build for this head and base is a result already there: `--collect` would post a second mark
    const now = await readTarget(t.pr, t.root, t.repo, d).catch(() => undefined);
    const left = now && pendingFor(cache ?? join(homedir(), ".cache"), t.repo, t.pr, now.head, now.base);
    if (left) clearPending(cache ?? join(homedir(), ".cache"), t.repo, t.pr, left.build);
    d.log(`既に pass（${url}）。回し直すなら --force`);
    return 0;
  }
  let r: LocalCiResult;
  try {
    r = await localCi(t.pr, t.root, d, t.repo, cache, { all: t.all, force: t.force });
  } catch (e) {
    if (!(e instanceof NoCiSteps)) throw e;
    console.error(e.message);
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
  // the same exit as Actions' entry (#912); a conflict ran nothing and is a failure
  return r.conflict ? 1 : ciExit(r.results);
}

if (import.meta.main) {
  const offload = hostOffload();
  process.exit(await main(process.argv.slice(2), process.cwd(), { sh, step, log: (l) => console.log(l), slot: (name, fn) => withHeavySlot(name, fn), ...(offload ? { offload } : {}) }));
}
