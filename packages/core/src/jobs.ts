import type { Job, JobRequest } from "@switchboard/protocol";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "./db.ts";
import { TASK_MARK } from "./detached.ts";
import { readBootId } from "./ops-stops.ts";

/**
 * Jobs a Task asks the daemon to run for it (#3992, PBI #3980): local CI and a review, the long waits a Task used to
 * keep its session open for. The daemon starts each as its own detached child — not the Task's — so the Task can end
 * its turn and let its session close; the end is recorded here and (#3993) resumes the Task that waits on `job#<id>`.
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

/** A kind's command: argv, then shell text after it that only names the wrapper's variables (`$J`, `$JOB_PROMPT`, `$JOB_OUT`). */
export type JobCommand = { argv: string[]; tail: string };

export type JobDeps = {
  db: Db;
  /** Where each job's folder goes (`<dir>/<id>`: log, exit). */
  dir: string;
  /** The environment the jobs start from (the daemon's, with the kit's bin on PATH). */
  env: Record<string, string | undefined>;
  /** The command of a request; tests put a fake in its place. */
  command?: (req: JobRequest) => JobCommand;
  /** How long a review may print nothing before it is cut (seconds; default 900, SWITCHBOARD_JOB_REVIEW_IDLE_S). */
  reviewIdleS?: number;
  /** Called once when a job ends (pass / fail / aborted). */
  onFinish?: (job: Job) => void;
  /** How often a job this daemon did not start is looked at (recoverJobs). */
  pollMs?: number;
  /** This boot's id (/proc/sys/kernel/random/boot_id); tests give their own. */
  bootId?: () => string | null;
  now?: () => number;
};

/** The argv of each kind, as `cross-runner-review` runs a review and CLAUDE.md runs local CI. */
export function jobCommand(req: JobRequest, idleS = 900): JobCommand {
  if (req.kind === "local-ci") return { argv: ["bun", "scripts/local-ci.ts", String(req.pr)], tail: "" };
  const head = ["ops-kit", "heavy", "--name", `review ${req.runner}`, "--", "ops-kit", "idle-run", "--idle", String(idleS), "--"];
  if (req.runner === "codex") return { argv: [...head, "codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-o", req.outFile, "-"], tail: ' < "$JOB_PROMPT"' };
  // stream-json: text output says nothing until the end, and idle-run would cut it
  return { argv: [...head, "claude", "-p", "--permission-mode", "plan", "--output-format", "stream-json", "--verbose"], tail: ` < "$JOB_PROMPT" | tee "$J/claude.jsonl" | jq -r 'select(.type=="result").result' > "$JOB_OUT"` };
}

const WRAPPER = (tail: string) => `set -o pipefail; "$@"${tail}; echo $? > "$J/exit.tmp" && mv "$J/exit.tmp" "$J/exit"`;

const git = (cwd: string, ...args: string[]): string | null => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const remoteKey = (url: string | null) => url?.replace(/\.git$/, "").replace(/\/+$/, "").replace(/^git@([^:]+):/, "https://$1/").toLowerCase() ?? null;
const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Whether `cwd` is a checkout of the Task's repository: under the Task's folder, a worktree of it (the same Git
 * common dir), or a clone of the same origin (a review's fresh clone). Anything else is refused. This keeps a mistake
 * (another repository's folder) from running; it is no boundary against the Task itself — a Task runs as the same OS
 * user and could run that checkout's scripts directly (the loopback owner is trusted, CLAUDE.md's premises).
 */
export function sameRepository(taskCwd: string, cwd: string): boolean {
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
  const ra = remoteKey(git(a, "remote", "get-url", "origin"));
  return !!ra && ra === remoteKey(git(b, "remote", "get-url", "origin"));
}

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

function finish(deps: JobDeps, id: number): Job | null {
  const jobDir = join(deps.dir, String(id));
  const code = readExit(jobDir);
  const status = code === null ? "aborted" : code === 0 ? "pass" : "fail";
  const log = join(jobDir, "log");
  const summary = [`${status}（終了コード ${code ?? "なし"}）`, tailLines(log, 20), `ログ: ${log}`].filter(Boolean).join("\n");
  const job = deps.db.finishJob(id, { status, exitCode: code, summary, endedAt: (deps.now ?? Date.now)() });
  if (job) deps.onFinish?.(job);
  return job;
}

/**
 * Starts a job for a Task (#3992): checks the request, records the job and starts it as the daemon's detached child.
 * Throws JobError (404: no such Task; 400: a folder or file outside the Task's repository).
 */
export function requestJob(deps: JobDeps, req: JobRequest): Job {
  const task = deps.db.getTask(req.taskId);
  if (!task) throw new JobError("task not found", 404);
  // relative to the daemon's own folder would be a mistake: the Task names its checkout
  if (!isAbsolute(req.cwd)) throw new JobError(`cwd must be absolute: ${req.cwd}`, 400);
  const cwd = resolve(req.cwd);
  if (!sameRepository(task.cwd, cwd)) throw new JobError(`cwd is not a checkout of the task's repository: ${req.cwd}`, 400);
  const files: Record<string, string> = {};
  if (req.kind === "review") {
    const prompt = resolve(cwd, req.promptFile);
    if (!existsSync(prompt)) throw new JobError(`promptFile not found: ${req.promptFile}`, 400);
    // the review reads and writes only inside the checkout (`_review/` in cross-runner-review): a path that leads out,
    // through `..` or a link, is refused, so a request cannot have the daemon truncate a file elsewhere
    const out = resolve(cwd, req.outFile);
    if (!within(cwd, prompt) || !within(cwd, out)) throw new JobError("promptFile and outFile must be inside cwd", 400);
    files.JOB_PROMPT = prompt;
    files.JOB_OUT = out;
  }
  const resolved: JobRequest = req.kind === "review" ? { ...req, cwd, promptFile: files.JOB_PROMPT!, outFile: files.JOB_OUT! } : { ...req, cwd };
  const job = deps.db.insertJob({ kind: req.kind, taskId: req.taskId, pr: req.pr, runner: req.kind === "review" ? req.runner : null, cwd, startedAt: (deps.now ?? Date.now)() });
  const jobDir = join(deps.dir, String(job.id));
  const { argv, tail } = deps.command ? deps.command(resolved) : jobCommand(resolved, deps.reviewIdleS);
  // not the Task's: without its mark (the Task's end stops what carries it, #1397) and without SWITCHBOARD_SUPERVISED
  // (a Task's variable; local CI's tests fail with it). OPS_KIT_TASK_ID still names the Task to `ops-kit heavy`.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) if (v !== undefined && k !== TASK_MARK && k !== "SWITCHBOARD_SUPERVISED") env[k] = v;
  Object.assign(env, files, { J: jobDir, OPS_KIT_TASK_ID: req.taskId });
  let proc: ReturnType<typeof Bun.spawn>;
  let log: number | null = null;
  try {
    // a folder left by a job of the same id (a database restored or made again while ~/.switchboard/jobs stayed) would
    // hand this one its exit code: the folder starts empty
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(jobDir, { recursive: true });
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
 * At the daemon's start (#3992): each job still running in the table was started by an earlier daemon. One that left
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
  for (const job of deps.db.listJobs(Number.MAX_SAFE_INTEGER)) {
    if (job.status !== "running") continue;
    const { pid, bootId } = deps.db.jobPid(job.id);
    // a job of another boot is not running whatever its pid is now (a reboot hands pids out again)
    const sameBoot = bootId === null || boot === null || bootId === boot;
    if (readExit(join(deps.dir, String(job.id))) !== null || pid === null || !sameBoot || !alive(pid)) finish(deps, job.id);
    else watch(job.id, pid);
  }
}
