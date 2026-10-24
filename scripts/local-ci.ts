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
 * (run again). The failed step's whole output stays in a log dir under ~/.cache; a perf step's
 * failure also leaves perf-result.json and summary.md there (head / base, environment, over / improved / raised, #1056).
 * A perf check that is `over` also measures the base (main's tip) the same way in a second worktree,
 * so the summary says per key whether main goes over too or the PR does (#1191); the run stays a failure either way.
 * `--repo <owner/name>` (#1203): another repository's PR, run from that repository's working tree (its origin must be
 * owner/name); the mark goes on that PR. Without it: the repository of the clone this script is in (that clone's
 * origin), run in that clone.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgeOf, runForgeOperation } from "../ops-kit/src/forge.ts";
import { githubForge } from "../ops-kit/src/forge-github.ts";
import { hostAws } from "../ops-kit/src/secrets.ts";
import { ciExit, runCi, type Step } from "./ci.ts";

export type { Step };

/** A result's first line: pass or fail, the head, then the base it was merged into (#913). A mark without the base is none. */
export const LOCAL_CI_RESULT = /^\[local-ci\] (pass|fail) ([0-9a-f]{40}) base=([0-9a-f]{40})(?=\s|$)/;

/** `log` = where the whole output of a step that failed was kept (#1232), `fails` = its failLines; passing steps keep nothing. */
export interface StepResult extends Step { code: number; seconds: number; tail: string; log?: string; fails?: string[] }

/** The lines of a step's output that name what failed: bun test's `(fail)` lines and perf-ratchet's `over:` lines, once each, in order. */
export function failLines(output: string): string[] {
  return [...new Set(output.split("\n").filter((l) => l.startsWith("(fail)") || l.includes("over:")))];
}

/** What perf-ratchet's check said: its `ceilings:` environment and its over / improved / raised lines as printed. `unknown` = none of the three (the bench failed, or the check stopped before judging). */
export interface PerfVerdict { env: string | null; over: string[]; improved: string[]; raised: string[]; unknown: boolean }

export function perfVerdict(output: string): PerfVerdict {
  const lines = output.split("\n");
  const of = (kind: string) => lines.filter((l) => l.startsWith(`${kind}: `));
  const [over, improved, raised] = [of("over"), of("improved"), of("raised")];
  const env = lines.map((l) => /^ceilings: (\S+)$/.exec(l)?.[1]).find(Boolean) ?? null;
  return { env, over, improved, raised, unknown: over.length + improved.length + raised.length === 0 };
}

/** The perf bench or the ratchet's check: their failure gets a verdict (a bench failure is one with no judgement). */
export const isPerfStep = (s: Step) => /scripts\/perf-(bench|ratchet)\.ts/.test(s.run);

/** What the base (main) measured the same way: its check's verdict, or null when a step before it failed. */
export interface Baseline { sha: string; verdict: PerfVerdict | null }

/** The steps that measure a checkout: the install, then the web build and everything after it (main's fetch, fonts, bench, check). */
export function perfSteps(steps: Step[]): Step[] {
  const install = steps.find((s) => s.run.trim() === "bun install --frozen-lockfile");
  const build = steps.findIndex((s) => s.run.trim() === "bun run --cwd apps/web build");
  if (!install || build < 0) throw new Error("CI の手順に `bun install --frozen-lockfile` か `bun run --cwd apps/web build` が無い（perfSteps）");
  return [install, ...steps.slice(build)];
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
  const kinds: Array<[string, string[]]> = [["超過（over）", p.over], ["改善による予算更新要求（improved）", p.improved], ["main より予算引上げ（raised）", p.raised]];
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
export interface LocalCiResult { sha: string; base: string; results: StepResult[]; ok: boolean; conflict?: boolean; perf?: PerfVerdict; baseline?: Baseline }

/** The PR comment of a run, pass or not (#913): the mark, what was tested, every step that ran; a failure names its step and what failed in it. */
export function resultComment(r: LocalCiResult): string {
  const head = [
    `[local-ci] ${r.ok ? "pass" : "fail"} ${r.sha} base=${r.base}`,
    "",
    "`.github/workflows/ci.yml` の手順（`bun scripts/ci.ts` は `scripts/ci.ts` の各手順）を、PR の head を base にマージしたものでローカルで実行した（`bun scripts/local-ci.ts`）。",
    "",
    `対象: head \`${r.sha}\` を base \`${r.base}\` にマージ`,
  ];
  if (r.conflict) return [...head, "", "結果: head を base にマージできない（衝突）。手順は実行していない。base を取り込んでから回し直す。"].join("\n");
  const failed = r.results.find((x) => x.code !== 0);
  return [
    ...head,
    ...(failed ? ["", `結果: \`${failed.name}\` が exit ${failed.code}。全文は実行したホストの記録（~/.cache の下）。`, ...(failed.fails ?? []).slice(0, 20).map((l) => `    ${l}`)] : []),
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
}

/**
 * The PR's head and its base branch's tip as they are now, both fetched into `repoRoot` (#913). The head comes by
 * refs/pull/<n>/head, which GitHub keeps for every PR (a fork's too); it must be the head the PR names.
 */
export async function readTarget(pr: number, repoRoot: string, repo: string, d: Pick<Deps, "sh">): Promise<{ head: string; base: string }> {
  const view = JSON.parse(await d.sh(["gh", "pr", "view", String(pr), "-R", repo, "--json", "headRefOid,baseRefName"])) as { headRefOid: string; baseRefName: string };
  const fetched = async (ref: string) => {
    await d.sh(["git", "-C", repoRoot, "fetch", "-q", "origin", ref]);
    return (await d.sh(["git", "-C", repoRoot, "rev-parse", "FETCH_HEAD"])).trim();
  };
  const base = await fetched(`refs/heads/${view.baseRefName}`);
  const head = await fetched(`refs/pull/${pr}/head`);
  if (head !== view.headRefOid) throw new Error(`refs/pull/${pr}/head は ${head.slice(0, 7)} で、PR の head ${view.headRefOid.slice(0, 7)} ではない（push の直後なら少し待ってやり直す）`);
  return { head, base };
}

/** `cache`: where the worktree and the failure logs go (~/.cache; tests give their own). TMPDIR goes under tmpdir() (#1056). */
export async function localCi(pr: number, repoRoot: string, d: Deps, repo: string, cache = join(homedir(), ".cache")): Promise<LocalCiResult> {
  const { head: sha, base } = await readTarget(pr, repoRoot, repo, d);
  // ~/.cache need not exist (a fresh GitHub runner has none, 2026-09-28)
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, `switchboard.local-ci-${pr}.`));
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
    const steps = await checkoutSteps(dir, env);
    const ran = await runCi(steps, async (s) => {
      d.log(`▶ ${s.name}`);
      const started = Date.now();
      const r = await d.step(s.run, dir, env);
      return { code: r.code, output: r.output, seconds: (Date.now() - started) / 1000, tail: r.output.split("\n").slice(-30).join("\n") };
    });
    const results: StepResult[] = ran.map(({ output: _, ...r }) => r);
    const failed = ran.at(-1);
    if (!failed || failed.code === 0) return { sha, base, results, ok: true };
    const result = results.at(-1)!;
    result.fails = failLines(failed.output);
    // the worktree and TMPDIR go in `finally`; a 1,400-test run's failures do not fit in its last 30 lines
    // the latest failure of a PR is the one read: earlier ones of the same PR of the same repository go (the host's disk is small)
    const prefix = `switchboard.local-ci-${repo.replace("/", "_")}-${pr}-log.`;
    for (const old of readdirSync(cache)) if (old.startsWith(prefix)) rmSync(join(cache, old), { recursive: true, force: true });
    const logDir = mkdtempSync(join(cache, prefix));
    result.log = join(logDir, `${results.length}-${failed.name.replace(/[^\w.-]/g, "_")}.log`);
    await Bun.write(result.log, failed.output);
    if (isPerfStep(failed)) {
      // a bench that failed judged nothing; the measured values go with the summary before the worktree goes
      const perf = failed.run.includes("perf-ratchet") ? perfVerdict(failed.output) : { ...perfVerdict(""), unknown: true };
      if (existsSync(join(dir, "perf-result.json"))) copyFileSync(join(dir, "perf-result.json"), join(logDir, "perf-result.json"));
      // over only: main measured the same way tells an environment's (or main's) excess from the PR's own
      const baseline = perf.over.length ? await measureBase(pr, repoRoot, base, perfSteps(steps), env, logDir, cache, d) : undefined;
      const summary = failureSummary({ sha, base, step: result, env, output: failed.output, perf, baseline });
      await Bun.write(join(logDir, "summary.md"), `${summary}\n`);
      d.log(summary);
      d.log(`記録: ${logDir}`);
      d.log(`✗ ${failed.name}: exit ${failed.code}`);
      return { sha, base, results, ok: false, perf, baseline };
    }
    for (const l of result.fails) d.log(l);
    d.log(result.tail);
    d.log(`全文: ${result.log}`);
    d.log(`✗ ${failed.name}: exit ${failed.code}`);
    return { sha, base, results, ok: false };
  } finally {
    await d.sh(["git", "-C", repoRoot, "worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
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
      if (s.run.includes("perf-ratchet")) return { sha: base, verdict: r.code === 0 ? { ...perfVerdict(r.output), unknown: false } : perfVerdict(r.output) };
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

/** The PR, the repository and its clone from the arguments: `<PR> [--repo <owner/name>]`. */
export async function resolveTarget(args: string[], cwd: string, scriptRoot: string, run: Deps["sh"]): Promise<{ pr: number; repo: string; root: string }> {
  const pr = Number(args.find((a) => /^\d+$/.test(a)));
  if (!pr) throw new TargetError("PR 番号が無い");
  const at = args.indexOf("--repo");
  // anything else (--repo=o/r, a typo) would fall back to this repository and post on its PR of that number
  const unknown = args.filter((a, i) => a !== String(pr) && (at < 0 || (i !== at && i !== at + 1)));
  if (unknown.length > 0) throw new TargetError(`知らない引数: ${unknown.join(" ")}`);
  if (at < 0) {
    // the clone this script is in and its origin: the head is read from the same repository the merge ref is fetched from
    const url = (await run(["git", "-C", scriptRoot, "remote", "get-url", "origin"]).catch(() => "")).trim();
    const repo = remoteRepo(url);
    if (!repo) throw new TargetError(`${scriptRoot} の origin（${url ? "GitHub の owner/name として読めない URL" : "無し"}）から対象が分からない（--repo <owner/name> を付ける）`);
    return { pr, repo, root: scriptRoot };
  }
  const repo = args[at + 1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new TargetError(`--repo は owner/name の形で: ${repo || "（空）"}`);
  const root = (await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => {
    throw new TargetError(`${cwd} は git の作業ツリーでない（${repo} の作業ツリーから実行する）`);
  })).trim();
  const url = (await run(["git", "-C", root, "remote", "get-url", "origin"]).catch(() => "")).trim();
  const origin = remoteRepo(url);
  if (origin?.toLowerCase() !== repo.toLowerCase()) {
    throw new TargetError(`${root} の origin（${origin ?? (url ? "GitHub の owner/name として読めない URL" : "無し")}）が --repo ${repo} と違う（${repo} の作業ツリーから実行する）`);
  }
  return { pr, repo, root };
}

const sh: Deps["sh"] = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out;
};

// GitHub runs a `run:` with `bash -e {0}`.
const step: Deps["step"] = async (script, cwd, env) => {
  const p = Bun.spawn(["bash", "-e", "-c", script], { cwd, stdout: "pipe", stderr: "pipe", env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, output: out + err };
};

/**
 * Posts a result on the PR as a forge `verification` (#920): the service is the target repository's `ops.config.json`
 * `forge` (none = GitHub); one without a verification is said, not posted some other way. The texts go through the
 * kit's check for values usable for auth first.
 */
export async function reportResult(t: { pr: number; repo: string; root: string }, body: string, run: Deps["sh"]): Promise<void> {
  // the repository is the origin's on github.com (`remoteRepo`), as the merge ref is fetched from
  const target = { service: forgeOf(t.root), host: "github.com", repository: t.repo };
  await runForgeOperation({ kind: "verification", target, texts: [body], payload: { pr: t.pr, body } }, { github: githubForge((cmd) => run(cmd)) }, hostAws());
}

/**
 * Posts the run's result only if it still names the PR's head and base (#913): either moved since the run → nothing
 * posted (a pass for an old head or base would be taken for the new one), false.
 */
export async function notify(t: { pr: number; repo: string; root: string }, r: LocalCiResult, d: Pick<Deps, "sh" | "log">, post = reportResult): Promise<boolean> {
  const now = await readTarget(t.pr, t.root, t.repo, d).catch((e: unknown) => (d.log(`head / base を読み直せない: ${e instanceof Error ? e.message : String(e)}`), undefined));
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

if (import.meta.main) {
  let t: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    t = await resolveTarget(process.argv.slice(2), process.cwd(), join(import.meta.dir, ".."), sh);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    console.error(`${e.message}\nusage: bun scripts/local-ci.ts <PR> [--repo <owner/name>]`);
    process.exit(2);
  }
  const log = (l: string) => console.log(l);
  const r = await localCi(t.pr, t.root, { sh, step, log }, t.repo);
  try {
    if (!(await notify(t, r, { sh, log }))) process.exit(1);
  } catch (e) {
    // authentication or permission: said and stopped, not tried another way
    console.error(`結果を PR に投稿できなかった（認証・権限を確かめる）: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // the same exit as Actions' entry (#912); a conflict ran nothing and is a failure
  process.exit(r.conflict ? 1 : ciExit(r.results));
}
