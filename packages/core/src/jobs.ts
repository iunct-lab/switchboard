import type { AgentEvent, Job, JobRequest, LoginKind, PricingTable, RunnerId } from "@switchboard/protocol";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { childEnv } from "@switchboard/adapter-claude";
import { primaryReviewer } from "../../../ops-kit/src/conditions.ts";
import { REVIEWER_ISOLATION, reviewPrompt } from "../../../ops-kit/src/review-note.ts";
import type { Db } from "./db.ts";
import { TASK_MARK } from "./detached.ts";
import { readBootId } from "./ops-stops.ts";
import { ledgerRowFor } from "./pricing.ts";
import { workspaceConfigEnv } from "./workspace-config.ts";

/**
 * Jobs a Task asks the daemon to run for it: local CI and a review, the long waits a Task used to
 * keep its session open for. The daemon starts each as its own detached child — not the Task's — so the Task can end
 * its turn and let its session close; the end is recorded here and resumes the Task that waits on `job#<id>`.
 *
 * The kinds are fixed and their argv is built here: a Task names a kind, a PR and files, never a command (a command
 * taken from the request would go around the Task's permissions). The wrapper shell writes the exit code to
 * `<dir>/<id>/exit` so a daemon started again can still tell how a job it no longer waits on ended (`recoverJobs`).
 */

export class JobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** How long an ended job stays in the list and keeps its folder: GET /api/jobs, the resources screen and `ops-kit job list` show the same 7 days. */
export const JOBS_KEEP_MS = 7 * 24 * 3600 * 1000;

/**
 * Where `scripts/local-ci.ts` leaves a record for each build whose result is not yet written to its PR; `--collect` reads and removes them.
 * The contract with `--collect`: a record whose local-ci process is still alive is that process's to write, and `--collect` leaves it.
 */
export const localCiPendingDir = (home = homedir()): string => join(home, ".cache", "switchboard.local-ci-pending");

/**
 * Production `collectPending`: `bun scripts/local-ci.ts --collect` from the repository root, detached so it outlives this daemon; its
 * output goes to `log` (next to the jobs' own logs), so a collect that wrote nothing says why.
 */
export const spawnCollectPending = (repoRoot: string, env: Record<string, string | undefined>, log: string): void => {
  mkdirSync(dirname(log), { recursive: true });
  const out = Bun.file(log);
  const p = Bun.spawn(["bun", "scripts/local-ci.ts", "--collect"], { cwd: repoRoot, env, stdin: "ignore", stdout: out, stderr: out, detached: true });
  p.unref();
};

/** A kind's command: argv, then shell text after it that only names the wrapper's variables (`$J`, `$JOB_PROMPT`, `$JOB_OUT`). */
export type JobCommand = { argv: string[]; tail: string };

/** A request whose reviewer is decided (`requestJob` decides it from the setting and the Task's runner when the request names none). */
export type ResolvedJobRequest =
  | (Exclude<JobRequest, { kind: "review" }> & { /** Another repository's PR: Switchboard's own `scripts/local-ci.ts` (that repository has none) and the `owner/name` it is given as `--repo`. */ other?: { script: string; repo: string } })
  | (Extract<JobRequest, { kind: "review" }> & { runner: "codex" | "claude" });

export type JobDeps = {
  db: Db;
  /** Where each job's folder goes (`<dir>/<id>`: log, exit). */
  dir: string;
  /** The environment the jobs start from (the daemon's, with the kit's bin on PATH). */
  env: Record<string, string | undefined>;
  /** The command of a request; tests put a fake in its place. */
  command?: (req: ResolvedJobRequest) => JobCommand;
  /** The review setting (production: the saved one). The main reviewer of a Task follows from it and the Task's runner. Absent = "other". */
  reviewRunner?: () => "other" | "same";
  /** The model and thinking effort a review of this runner runs with (production: the runner's saved defaults). Empty = the CLI's own. */
  reviewChoice?: (runner: RunnerId) => { model?: string; effort?: string };
  /** How long a review may print nothing before it is cut (seconds; default 900, SWITCHBOARD_JOB_REVIEW_IDLE_S). */
  reviewIdleS?: number;
  /** Called once when a job ends (pass / fail / aborted). */
  onFinish?: (job: Job) => void;
  /** How often a job this daemon did not start is looked at (recoverJobs). */
  pollMs?: number;
  /** This boot's id (/proc/sys/kernel/random/boot_id); tests give their own. */
  bootId?: () => string | null;
  /** Where local CI's pending records are (default `localCiPendingDir()`); tests give their own. */
  pendingDir?: string;
  /** Collects the results of builds that outlived their daemon (production: `spawnCollectPending`). Called once by `recoverJobs`. */
  collectPending?: () => void;
  /** The price table a review job's usage is priced with (production: the daemon's); without it the rows are unpriced. */
  pricing?: () => PricingTable;
  /** The login a runner is on now, for the billing kind of a review job's usage; undefined = not known. */
  loginKind?: (runner: RunnerId) => LoginKind | undefined;
  /** Whether this machine runs the CI's steps in a build off the host (production: `sb-offload` is on PATH, as `scripts/local-ci.ts` decides). */
  offHost?: () => boolean;
  now?: () => number;
};

// codex's events go to codex.jsonl (the usage); its error events also go to the job log, so the summary a Task reads says why it failed.
// `fromjson?` skips a line that is not JSON, so jq does not fail the pipeline (pipefail) on it.
const CODEX_TAIL = ` < "$JOB_PROMPT" | tee "$J/codex.jsonl" | jq -rR 'fromjson? | select(.type == "error" or .type == "turn.failed") | "codex: \\(.message // .error.message // tostring)"'`;

/**
 * The argv of each kind, as `cross-runner-review` runs a review and CLAUDE.md runs local CI. A reviewer is started with
 * `REVIEWER_ISOLATION` (the kit's review-note.ts, the same values the skill's direct commands carry): it reads the review's
 * instructions and material, not the clone's CLAUDE.md / AGENTS.md nor the user's memory, MCP servers, skills and plugins.
 */
export function jobCommand(req: ResolvedJobRequest, idleS = 900, choice: { model?: string; effort?: string } = {}): JobCommand {
  // this repository's PR runs the checkout's own script; another repository's, Switchboard's script from that repository's folder with `--repo`
  if (req.kind === "local-ci") return { argv: ["bun", req.other?.script ?? "scripts/local-ci.ts", String(req.pr), ...(req.other ? ["--repo", req.other.repo] : []), ...(req.local ? ["--local"] : [])], tail: "" };
  // a review takes no heavy slot, only waits for the memory floor (the kit README, Heavy-process slots): local CI keeps its slot
  const head = ["ops-kit", "heavy", "--memory-only", "--name", `review ${req.runner}`, "--", "ops-kit", "idle-run", "--idle", String(idleS), "--"];
  if (req.runner === "codex") return { argv: [...head, "codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", ...REVIEWER_ISOLATION.codex.args, "--json", ...(choice.model ? ["-m", choice.model] : []), ...(choice.effort ? ["-c", `model_reasoning_effort="${choice.effort}"`] : []), "-o", req.outFile, "-"], tail: CODEX_TAIL };
  // stream-json: text output says nothing until the end, and idle-run would cut it
  return { argv: [...head, "env", ...REVIEWER_ISOLATION.claude.env, "claude", "-p", "--permission-mode", "plan", ...REVIEWER_ISOLATION.claude.args, "--output-format", "stream-json", "--verbose", ...(choice.model ? ["--model", choice.model] : []), ...(choice.effort ? ["--effort", choice.effort] : [])], tail: ` < "$JOB_PROMPT" | tee "$J/claude.jsonl" | jq -r 'select(.type=="result").result' > "$JOB_OUT"` };
}

type UsageEvent = Extract<AgentEvent, { t: "usage" }>;

const jsonLines = (path: string): Record<string, any>[] => {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((l) => {
      try {
        const o = JSON.parse(l);
        return o && typeof o === "object" ? [o] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * What a review job used, from the events it left (`claude.jsonl`, `codex.jsonl`), in the form the adapters give a Task's
 * usage. Claude: one usage per model of the `result` line's `modelUsage` with the runner's own cost, as the adapter reads it
 * (`usage` of the result when there is no `modelUsage`). Codex: the `turn.completed` usages added up (its `input_tokens`
 * includes the cached part). An unreadable or missing file gives none.
 */
export function jobUsage(runner: RunnerId, jobDir: string): UsageEvent[] {
  if (runner === "codex") {
    const turns = jsonLines(join(jobDir, "codex.jsonl")).filter((e) => e.type === "turn.completed" && e.usage && typeof e.usage === "object");
    if (!turns.length) return [];
    const sum = (k: string) => turns.reduce((a, e) => a + n(e.usage[k]), 0);
    const cached = sum("cached_input_tokens");
    return [{ t: "usage", source: "reported", inputTokens: Math.max(0, sum("input_tokens") - cached), outputTokens: sum("output_tokens"), cacheReadTokens: cached, cacheWriteTokens: 0 }];
  }
  const lines = jsonLines(join(jobDir, "claude.jsonl"));
  const result = lines.filter((e) => e.type === "result").at(-1);
  if (!result) return [];
  const mu = result.modelUsage && typeof result.modelUsage === "object" ? Object.entries<any>(result.modelUsage) : [];
  if (mu.length) {
    return mu.map(([model, v]) => ({ t: "usage", source: "reported", model, inputTokens: n(v?.inputTokens), outputTokens: n(v?.outputTokens), cacheReadTokens: n(v?.cacheReadInputTokens), cacheWriteTokens: n(v?.cacheCreationInputTokens), costUsd: n(v?.costUSD) }));
  }
  const u = result.usage;
  if (!u || typeof u !== "object") return [];
  const model = lines.find((e) => e.type === "system" && typeof e.model === "string")?.model as string | undefined;
  return [{ t: "usage", source: "reported", model, inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheWriteTokens: n(u.cache_creation_input_tokens) }];
}

const WRAPPER = (tail: string) => `set -o pipefail; "$@"${tail}; echo $? > "$J/exit.tmp" && mv "$J/exit.tmp" "$J/exit"`;

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null; // no git on this host
  }
};
const remoteKey = (url: string | null) => url?.replace(/\.git$/, "").replace(/\/+$/, "").replace(/^git@([^:]+):/, "https://$1/").toLowerCase() ?? null;
const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Whether `cwd` is a checkout of the Task's repository: under the Task's folder, a worktree of it (the same Git
 * common dir), or a clone of the same origin (a review's fresh clone) — the Task's, or that of a workspace registered in
 * the app (`workspaceOrigins`: the workspaces' folders, whose origin is read). Anything else is refused. This keeps a mistake
 * (another repository's folder) from running; it is no boundary against the Task itself — a Task runs as the same OS
 * user and could run that checkout's scripts directly (the loopback owner is trusted, CLAUDE.md's premises).
 */
export function sameRepository(taskCwd: string, cwd: string, workspaceOrigins: string[] = []): boolean {
  let a: string, b: string;
  try {
    a = realpathSync(taskCwd);
    b = realpathSync(cwd);
    if (!statSync(b).isDirectory()) return false;
  } catch {
    return false;
  }
  if (inside(a, b)) return true;
  const common = (d: string) => git(d, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const ca = common(a);
  if (ca && ca === common(b)) return true;
  const rb = remoteKey(git(b, "remote", "get-url", "origin"));
  if (!rb) return false;
  if (rb === remoteKey(git(a, "remote", "get-url", "origin"))) return true;
  // a clone of a repository registered in the app (an audit Task runs in one repository and reads another's PR)
  return workspaceOrigins.some((w) => remoteKey(git(w, "remote", "get-url", "origin")) === rb);
}

/** `owner/name` of a checkout's origin on GitHub, or null. */
const githubRepoOf = (cwd: string): string | null => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(remoteKey(git(cwd, "remote", "get-url", "origin"))?.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/") ?? "")?.[1] ?? null;

/** Whether `p` (it, or else its folder, as the links resolve) is inside `root`. */
const within = (root: string, p: string): boolean => {
  try {
    // a link resolves where it points (a dangling one fails and is refused); a file not made yet, by its folder
    const real = existsSync(p) || lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(p) : join(realpathSync(dirname(p)), basename(p));
    return inside(realpathSync(root), real) && real !== realpathSync(root);
  } catch {
    return false;
  }
};

const tailLines = (path: string, n: number): string => {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
};

const readExit = (jobDir: string): number | null => {
  try {
    const n = Number(readFileSync(join(jobDir, "exit"), "utf8").trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
};

/**
 * Removes the folder (`<dir>/<id>`) of each job that ended before the list's period. The rows stay; a folder
 * whose number has no row stays too (what is left of a restored database is kept to look at).
 */
export function pruneJobDirs(deps: JobDeps): number {
  if (!existsSync(deps.dir)) return 0;
  const before = (deps.now ?? Date.now)() - JOBS_KEEP_MS;
  let n = 0;
  for (const name of readdirSync(deps.dir)) {
    if (!/^\d+$/.test(name)) continue;
    const job = deps.db.getJob(Number(name));
    if (!job || job.status === "running" || job.endedAt === null || job.endedAt >= before) continue;
    rmSync(join(deps.dir, name), { recursive: true, force: true });
    n++;
  }
  return n;
}

const pruneQuietly = (deps: JobDeps) => {
  try {
    pruneJobDirs(deps);
  } catch {
    // a folder that stays is not worth stopping the record of a job's end
  }
};

/** A review's usage goes to the ledger under the Task that asked (source `job`), so what an audit cost can be told. Not readable = nothing booked; the job's end is not failed for it. */
function recordUsage(deps: JobDeps, job: Job, jobDir: string, ts: number): void {
  try {
    // the job's runner and model, not the Task's: an audit Task on one runner asks for a review by the other
    for (const u of jobUsage(job.runner!, jobDir)) deps.db.insertLedger({ ...ledgerRowFor(deps.pricing?.(), { id: job.taskId, runner: job.runner!, model: null }, u, ts, deps.loginKind?.(job.runner!)), source: "job" });
  } catch (e) {
    console.error(`[jobs] usage of job#${job.id}: ${String((e as Error)?.message ?? e)}`);
  }
}

function finish(deps: JobDeps, id: number): Job | null {
  const jobDir = join(deps.dir, String(id));
  const code = readExit(jobDir);
  const status = code === null ? "aborted" : code === 0 ? "pass" : "fail";
  const log = join(jobDir, "log");
  const summary = [`${status}（終了コード ${code ?? "なし"}）`, tailLines(log, 20), `ログ: ${log}`].filter(Boolean).join("\n");
  const endedAt = (deps.now ?? Date.now)();
  const job = deps.db.finishJob(id, { status, exitCode: code, summary, endedAt });
  if (job?.kind === "review" && job.runner) recordUsage(deps, job, jobDir, endedAt);
  pruneQuietly(deps);
  if (job) deps.onFinish?.(job);
  return job;
}

/**
 * Starts a job for a Task: checks the request, records the job and starts it as the daemon's detached child.
 * Throws JobError (404: no such Task; 400: a folder or file outside the Task's repository, or a reviewer the setting does not name).
 *
 * A review's runner is the app's to decide: the main reviewer follows from the review setting as it is now and the Task's
 * runner (`primaryReviewer`). A request that names another runner is refused unless it says why (`as`: a usage-limit
 * fallback, a recheck, an audit) — which runner does the main review is not left to what the Task read earlier.
 */
export function requestJob(deps: JobDeps, req: JobRequest): Job {
  const task = deps.db.getTask(req.taskId);
  if (!task) throw new JobError("task not found", 404);
  // relative to the daemon's own folder would be a mistake: the Task names its checkout
  if (!isAbsolute(req.cwd)) throw new JobError(`cwd must be absolute: ${req.cwd}`, 400);
  const cwd = resolve(req.cwd);
  if (!sameRepository(task.cwd, cwd, deps.db.listWorkspaces().map((w) => w.path))) throw new JobError(`cwd is not a checkout of the task's repository: ${req.cwd}`, 400);
  const files: Record<string, string> = {};
  let reviewer: "codex" | "claude" | null = null;
  if (req.kind === "review") {
    const setting = deps.reviewRunner?.() ?? "other";
    const primary = primaryReviewer(task.runner, setting);
    if (!req.runner && !primary) throw new JobError(`この Task のランナー（${task.runner}）からは主レビュアーを決められません。--runner codex|claude で名指ししてください`, 400);
    if (req.as && !req.runner) throw new JobError("as（主レビュアーでないランナーに頼む理由）は runner の名指しが要ります", 400);
    if (req.runner && primary && req.runner !== primary && !req.as) {
      throw new JobError(`設定（レビューのランナー: ${setting}）では、この Task（${task.runner}）の主レビュアーは ${primary} です。主レビューは --runner ${primary} で頼んでください。主レビュアーでないランナーに頼むのは、理由を --as で名指ししたときだけです（fallback = 主レビュアーが使用上限、recheck = 再チェック、audit = マージ後の監査）`, 400);
    }
    reviewer = req.runner ?? primary!;
    const prompt = resolve(cwd, req.promptFile);
    if (!existsSync(prompt)) throw new JobError(`promptFile not found: ${req.promptFile}`, 400);
    // the review reads and writes only inside the checkout (`_review/` in cross-runner-review): a path that leads out,
    // through `..` or a link, is refused, so a request cannot have the daemon truncate a file elsewhere
    const out = resolve(cwd, req.outFile);
    if (!within(cwd, prompt) || !within(cwd, out)) throw new JobError("promptFile and outFile must be inside cwd", 400);
    files.JOB_PROMPT = prompt;
    files.JOB_OUT = out;
  }
  if (req.kind === "local-ci" && req.fixtures) {
    if (!isAbsolute(req.fixtures)) throw new JobError(`fixtures must be absolute: ${req.fixtures}`, 400);
    files.SWITCHBOARD_FIXTURES = req.fixtures;
  }
  // the registered workspace the checkout belongs to: its saved settings go to the job as they go to its Tasks
  const workspaces = deps.db.listWorkspaces();
  const ws = workspaces.find((w) => sameRepository(w.path, cwd));
  const meta = workspaces.find((w) => w.kind === "meta");
  // someone else's repository (a workspace with an upstream): the steps of its PR's CI are code nobody here reviewed. They
  // run only in a build off the host, which has none of this user's files or logins — never here as the host's user
  if (req.kind === "local-ci" && ws?.upstream && (req.local || !(deps.offHost ?? (() => Bun.which("sb-offload", { PATH: deps.env.PATH ?? "" }) !== null))())) {
    throw new JobError("他者のリポジトリ（元の更新を取り込む workspace）のローカル CI は、外のビルド（sb-offload）があるマシンでだけ回します（PR の CI の手順がこのホストの利用者の権限で走るため。--local も不可）", 409);
  }
  let other: { script: string; repo: string } | undefined;
  // local CI of a repository that is not Switchboard's: it has no scripts/local-ci.ts, so Switchboard's runs from its folder
  if (req.kind === "local-ci" && meta && !sameRepository(meta.path, cwd)) {
    const repo = githubRepoOf(cwd);
    if (!repo) throw new JobError(`cwd の origin から GitHub の owner/name を読めません: ${req.cwd}（アプリが持つ変更は bun ${join(meta.path, "scripts/local-ci.ts")} --change <n>）`, 400);
    other = { script: join(meta.path, "scripts/local-ci.ts"), repo };
  }
  const resolved: ResolvedJobRequest = req.kind === "review" ? { ...req, runner: reviewer!, cwd, promptFile: files.JOB_PROMPT!, outFile: files.JOB_OUT! } : { ...req, cwd, ...(other ? { other } : {}) };
  const job = deps.db.insertJob({ kind: req.kind, taskId: req.taskId, pr: req.pr, runner: reviewer, cwd, startedAt: (deps.now ?? Date.now)() });
  const jobDir = join(deps.dir, String(job.id));
  // what the reviewer reads: the Task's instructions (left as written) and the note of the runner that reviews, in the job's folder
  const prompt = resolved.kind === "review" ? reviewPrompt(readFileSync(resolved.promptFile, "utf8"), resolved.runner) : null;
  if (prompt !== null) files.JOB_PROMPT = join(jobDir, "prompt.md");
  const { argv, tail } = deps.command ? deps.command(resolved) : jobCommand(resolved, deps.reviewIdleS, resolved.kind === "review" ? deps.reviewChoice?.(resolved.runner) : undefined);
  // not the Task's: without its mark (the Task's end stops what carries it) and without SWITCHBOARD_SUPERVISED
  // (a Task's variable; local CI's tests fail with it), and without Claude Code's session markers and the OTEL_*
  // destinations, as the Task's own claude gets it (`childEnv`). OPS_KIT_TASK_ID still names the Task to `ops-kit heavy`.
  const env = childEnv(deps.env);
  delete env[TASK_MARK];
  delete env.SWITCHBOARD_SUPERVISED;
  Object.assign(env, files, workspaceConfigEnv(ws), { J: jobDir, OPS_KIT_TASK_ID: req.taskId });
  let proc: ReturnType<typeof Bun.spawn>;
  let log: number | null = null;
  try {
    // a folder left by a job of the same id (a database restored or made again while ~/.switchboard/jobs stayed) would
    // hand this one its exit code: the folder starts empty
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(jobDir, { recursive: true });
    if (prompt !== null) writeFileSync(join(jobDir, "prompt.md"), prompt);
    log = openSync(join(jobDir, "log"), "w");
    proc = Bun.spawn(["bash", "-c", WRAPPER(tail), "job", ...argv], { cwd, env, stdin: "ignore", stdout: log, stderr: log, detached: true });
  } catch (e) {
    if (log !== null) closeSync(log);
    deps.db.finishJob(job.id, { status: "aborted", exitCode: null, summary: `aborted（起動できませんでした: ${(e as Error).message}）`, endedAt: (deps.now ?? Date.now)() });
    throw new JobError(`could not start the job: ${(e as Error).message}`, 500);
  }
  closeSync(log!);
  deps.db.setJobPid(job.id, proc.pid, (deps.bootId ?? readBootId)());
  proc.unref();
  // a daemon stopping closes its database first: the job stays running and the next start's recoverJobs ends it
  void proc.exited.then(() => {
    try {
      finish(deps, job.id);
    } catch {}
  });
  return { ...job };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * At the daemon's start: each job still running in the table was started by an earlier daemon. One that left
 * its exit code ends with it; one whose process still runs (in this boot) is looked at every `pollMs` until it ends;
 * one whose process is gone, or that started in another boot, without an exit code is aborted.
 */
export function recoverJobs(deps: JobDeps): void {
  const pollMs = deps.pollMs ?? 5000;
  const watch = (id: number, pid: number) => {
    const t = setTimeout(() => {
      if (readExit(join(deps.dir, String(id))) !== null || !alive(pid)) finish(deps, id);
      else watch(id, pid);
    }, pollMs);
    (t as unknown as { unref?: () => void }).unref?.();
  };
  const boot = (deps.bootId ?? readBootId)();
  let ciLeft = false;
  for (const job of deps.db.listJobs(Number.MAX_SAFE_INTEGER)) {
    if (job.status !== "running") continue;
    const { pid, bootId } = deps.db.jobPid(job.id);
    // a job of another boot is not running whatever its pid is now (a reboot hands pids out again)
    const sameBoot = bootId === null || boot === null || bootId === boot;
    if (readExit(join(deps.dir, String(job.id))) !== null || pid === null || !sameBoot || !alive(pid)) {
      finish(deps, job.id);
      // only a local-ci that is gone left its build to collect; a live one (a restart in the same boot) writes its own result
      if (job.kind === "local-ci") ciLeft = true;
    } else watch(job.id, pid);
  }
  pruneQuietly(deps);
  // a build offloaded from local CI may have ended while the daemon was down: write its result to the PR (once per start)
  if (deps.collectPending && (ciLeft || hasPending(deps.pendingDir ?? localCiPendingDir()))) {
    try {
      deps.collectPending();
    } catch (e) {
      console.error(`[jobs] collect pending: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

const hasPending = (dir: string): boolean => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};
