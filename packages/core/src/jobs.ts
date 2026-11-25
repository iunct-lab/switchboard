import { APP_JOB_TASK, JobCi, TaskStatus, type AgentEvent, type Job, type JobRequest, type JobResult, type LoginKind, type PricingTable, type RunnerId } from "@switchboard/protocol";
import { z } from "zod";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { childEnv } from "@switchboard/adapter-claude";
import { checkRulings } from "../../../ops-kit/src/review-arbiter.ts";
import { primaryReviewer } from "../../../ops-kit/src/conditions.ts";
import { RECHECK_KINDS } from "../../../scripts/merge-gate.ts";
import { heavyStateDir } from "../../../ops-kit/src/heavy.ts";
import { REVIEWER_ISOLATION, reviewPrompt } from "../../../ops-kit/src/review-note.ts";
import { storedEnds } from "./backlog-stored.ts";
import type { Db } from "./db.ts";
import { TASK_MARK } from "./detached.ts";
import { readBootId } from "./ops-stops.ts";
import { ledgerRowFor } from "./pricing.ts";
import { isLimitText } from "./ratelimit.ts";
import { gitlabTargetOf, workspaceConfigEnv } from "./workspace-config.ts";

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
 * output goes to `log` (next to the jobs' own logs), so a collect that wrote nothing says why. `onExit` runs when that process has ended (the daemon does not wait for it at its start).
 */
export const spawnCollectPending = (repoRoot: string, env: Record<string, string | undefined>, log: string, onExit: () => void = () => {}): void => {
  mkdirSync(dirname(log), { recursive: true });
  const out = Bun.file(log);
  const p = Bun.spawn(["bun", "scripts/local-ci.ts", "--collect"], { cwd: repoRoot, env, stdin: "ignore", stdout: out, stderr: out, detached: true });
  p.unref();
  void p.exited.then(() => {
    try {
      onExit();
    } catch (e) {
      console.error(`[jobs] after collect: ${String((e as Error)?.message ?? e)}`);
    }
  });
};

/** The merge verdict script of the code this daemon runs: `jobs.ts` already imports its rules, so a PR that changes them is judged by the version that is running, not by its own. */
export const DAEMON_ROOT = resolve(import.meta.dir, "../../..");
export const DAEMON_MERGE_GATE = join(DAEMON_ROOT, "scripts/merge-gate.ts");

/** A kind's command: argv, then shell text after it that only names the wrapper's variables (`$J`, `$JOB_PROMPT`, `$JOB_OUT`). */
export type JobCommand = { argv: string[]; tail: string };

/** A request whose reviewer is decided (`requestJob` decides it from the setting and the Task's runner when the request names none). */
export type ResolvedJobRequest =
  | (Exclude<JobRequest, { kind: "review" }> & { /** Another repository's PR: Switchboard's own `scripts/local-ci.ts` (that repository has none) and the `owner/name` it is given as `--repo`. A change in another workspace has `repo` "" and no `--repo` (`--change` takes none). */ other?: { script: string; repo: string }; /** A recheck or a tag CI run: the head the request recorded (a tag CI run judges that commit only); a recheck runs only if the checkout is still on it once the heavy slot is given. */ head?: string })
  // a review's `outFile` is where the reviewer writes: once the job is recorded, the job's own `out.md` (`$J`, which the reviewer cannot write); the daemon copies it to the place the request named when the job ends (`deliverReview`)
  | (Extract<JobRequest, { kind: "review" }> & { runner: "codex" | "claude"; /** The reviewer's TMPDIR: `tmp` in the job's own folder (`requestJob`), outside the checkout. Short whatever the checkout's path is, so the sockets Claude Code makes in it fit a socket's address (108 bytes); removed when the job ends (`finish`). */ tmpDir: string; /** Claude Code whose sandbox cannot start on this machine (`JobDeps.claudeSandbox`): it only reads and runs no tests. */ readOnly?: true });

export type JobDeps = {
  db: Db;
  /** Where each job's folder goes (`<dir>/<id>`: log, exit). */
  dir: string;
  /** The environment the jobs start from (the daemon's, with the kit's bin on PATH). */
  env: Record<string, string | undefined>;
  /** The command of a request; tests put a fake in its place. */
  command?: (req: ResolvedJobRequest) => JobCommand;
  /** Where the daemon's own records are, for a gate job (`MERGE_RECORDS_URL` and its key file in the job's environment): the daemon's loopback address and key file, never a value the request or the Task's environment gives. */
  app?: () => { url: string; tokenFile: string };
  /** The review setting (production: the saved one). The main reviewer of a Task follows from it and the Task's runner. Absent = "other". */
  reviewRunner?: () => "other" | "same";
  /** The recheck and audit setting (production: `recheckSetting` of the saved settings): who reads a recheck, relative to the main reviewer. Absent = the review setting's value. */
  recheckRunner?: () => "other" | "same";
  /** The model and thinking effort a review of this runner runs with (production: the saved review model / effort, else the runner's saved Task defaults). Empty = the CLI's own. */
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
  /** Collects the results of builds that outlived their daemon (production: `spawnCollectPending`). Called once by `recoverJobs`; `done` is to be called when the collect has ended, as it writes results into the jobs' folders (`adoptLateResults`). */
  collectPending?: (done: () => void) => void;
  /** The price table a review job's usage is priced with (production: the daemon's); without it the rows are unpriced. */
  pricing?: () => PricingTable;
  /** The login a runner is on now, for the billing kind of a review job's usage; undefined = not known. */
  loginKind?: (runner: RunnerId) => LoginKind | undefined;
  /** Whether Claude Code's sandbox can start for a review job: bubblewrap and socat on `path`, the PATH of the job's own environment (production: `Bun.which`). Without them Claude Code would run its Bash unsandboxed, so a Claude reviewer then only reads. */
  claudeSandbox?: (path: string) => boolean;
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
export function jobCommand(req: ResolvedJobRequest, idleS = 900, choice: { model?: string; effort?: string } = {}, home = homedir()): JobCommand {
  // this repository's PR runs the checkout's own script; another repository's, Switchboard's script from that repository's folder with `--repo`
  // (a change in another workspace runs it from that folder too, with `--change` and no `--repo`: `other.repo` is empty and must not be passed)
  // the tag CI of the commit the job was asked for (its recorded head), run again even when its Release already carries a mark: the record of this job is what a promotion reads. It takes its own heavy slot (or builds off the host)
  // a merge verdict: the daemon's own `scripts/merge-gate.ts` (the code this daemon runs, not the Task's checkout's copy), started in the daemon's own folder (the job's cwd, see `requestJob`) so Bun reads no `bunfig.toml` or `.env` of the checkout, with the checkout named by `--cwd` as the folder it reads the PR's commits and settings in. The verdict goes to `$J/out`, the diagnostics to the log
  if (req.kind === "gate") return { argv: ["bun", "--no-env-file", DAEMON_MERGE_GATE, ...(req.change ? ["--change", String(req.pr)] : [String(req.pr)]), ...(req.repo ? ["--repo", req.repo] : []), ...(req.allowLarge ? ["--allow-large"] : []), ...(req.merge ? [`--${req.merge}`] : []), ...(req.scope ? ["--scope"] : []), ...(req.viewpoints ? ["--viewpoints"] : []), "--cwd", req.cwd], tail: ` > "$J/out"` };
  if (req.kind === "tag-ci") return { argv: ["bun", req.other!.script, "--sha", req.head!, ...(req.other!.repo ? ["--repo", req.other!.repo] : [])], tail: "" };
  if (req.kind === "local-ci") return { argv: ["bun", req.other?.script ?? "scripts/local-ci.ts", ...(req.change ? ["--change"] : []), String(req.pr), ...(req.other && !req.change ? ["--repo", req.other.repo] : []), ...(req.local ? ["--local"] : [])], tail: "" };
  // a recheck whose pass is a command: the kind picks `scripts/recheck.ts`'s table in the PR's checkout, in a heavy slot
  if (req.kind === "recheck") return { argv: ["ops-kit", "heavy", "--", "bun", "scripts/recheck.ts", req.recheck, ...(req.head ? ["--head", req.head] : [])], tail: "" };
  // a review takes no heavy slot, only waits for the memory floor (the kit README, Heavy-process slots): local CI keeps its slot
  const head = ["ops-kit", "heavy", "--memory-only", "--name", `review ${req.runner}`, "--", "ops-kit", "idle-run", "--idle", String(idleS), "--"];
  // A reviewer may write tests in its checkout and run them, in a heavy slot (the note says where and how: review-note.ts).
  // Codex: its sandbox writes in the checkout (the job's cwd), in the job's TMPDIR, named by its path (not whatever $TMPDIR says),
  // and in the slots' folder of the job's home, which `ops-kit heavy` needs to take a slot (without it, it runs the test without
  // one); not /tmp, no network
  if (req.runner === "codex") return { argv: [...head, "codex", "exec", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--add-dir", heavyStateDir(home), "--add-dir", req.tmpDir, "--skip-git-repo-check", "--ephemeral", ...REVIEWER_ISOLATION.codex.args, "--json", ...(choice.model ? ["-m", choice.model] : []), ...(choice.effort ? ["-c", `model_reasoning_effort="${choice.effort}"`] : []), "-o", req.outFile, "-"], tail: CODEX_TAIL };
  // Claude Code: dontAsk refuses every tool use the rules do not allow (reading in its working folder still works). It may edit and write
  // under `_review/tests/` only — not elsewhere in the checkout, such as `.git/config`, which a later git call there would act on —
  // and the one command it may run is a test in a heavy slot. That test is code the reviewer wrote, so it runs in Claude Code's sandbox
  // (bubblewrap): it writes in the checkout and in the slots' folder, not its `.git`, not /tmp or home, with
  // no network, and no command may leave the sandbox. failIfUnavailable: a sandbox that cannot start ends the run instead of running
  // the test unsandboxed. Its temporary files: Claude Code gives the sandboxed command `claude-<uid>` in the job's TMPDIR as its own
  // TMPDIR and lets it write there, so `allowWrite` names no more of it. Without bubblewrap the reviewer only reads (`readOnly`, as `requestJob` decides). `--allowedTools` takes every word up to the next flag
  // real paths: a checkout reached through a link still has its `.git` denied
  const sandbox = { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, filesystem: { allowWrite: [realOr(heavyStateDir(home))], denyWrite: [join(realOr(req.cwd), ".git")] }, network: { allowedDomains: [] } } };
  const may = req.readOnly ? ["--permission-mode", "plan"] : ["--permission-mode", "dontAsk", "--settings", JSON.stringify(sandbox), "--allowedTools", "Bash(ops-kit heavy -- bun test:*)", "Edit(_review/tests/**)", "Write(_review/tests/**)"];
  // stream-json: text output says nothing until the end, and idle-run would cut it
  return { argv: [...head, "env", ...REVIEWER_ISOLATION.claude.env, "claude", "-p", ...may, ...REVIEWER_ISOLATION.claude.args, "--output-format", "stream-json", "--verbose", ...(choice.model ? ["--model", choice.model] : []), ...(choice.effort ? ["--effort", choice.effort] : [])], tail: ` < "$JOB_PROMPT" | tee "$J/claude.jsonl" | jq -r 'select(.type=="result").result' > "$JOB_OUT"` };
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p; // not made yet
  }
};

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

/** The model a Claude review's events name (the `system` line of `claude.jsonl`, the line `jobUsage` reads it from); undefined when none does. */
export function claudeJobModel(jobDir: string): string | undefined {
  return jsonLines(join(jobDir, "claude.jsonl")).find((e) => e.type === "system" && typeof e.model === "string")?.model as string | undefined;
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

/**
 * What the record's `repo` says a checkout's PRs are keyed by: `owner/name` on GitHub, else the project path its `forge` names
 * on GitLab (lower case, as the verdict asks for it); "" when neither. The verdict reads with the same key (`readPr`, `readGitlabPr`).
 */
export function repoKeyOf(cwd: string, ws?: { id: string } | null): string {
  return githubRepoOf(cwd) || gitlabTargetOf(cwd, ws?.id)?.repository.toLowerCase() || "";
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

/** How many findings and how long a first line a review's record keeps: a job's result stays a few KB however long the output is. */
const MAX_FINDINGS = 200;
const MAX_FIRST_LINE = 200;
const FINDING_LINE = /^\s*-\s*\[(blocker|should-fix|nit|question)\]/;
const FINDING_PLACE = /^\s*`([^`]+?):(\d+)(?:-\d+)?`/;

/**
 * What a review's output says, as the job's record keeps it: the severity, path and line of each finding line (`- [blocker|should-fix|nit|question] `path:line` …`)
 * of its `### Findings` section (a weighted line whose `path:line` cannot be read is kept with an empty path and line 0), and the output's first line. The words are the four the review's instructions define; their weight is not decided here. Null when there is no `### Findings` section.
 */
export function reviewResult(text: string): JobResult["review"] | null {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^###\s+Findings\s*$/.test(l.trim()));
  if (at < 0) return null;
  const findings: NonNullable<JobResult["review"]>["findings"] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    const m = FINDING_LINE.exec(l);
    if (!m || findings.length >= MAX_FINDINGS) continue;
    // a line with a weight and no place that can be read is still a finding: it is kept with no path and line 0, so it is not taken for `- none`
    const at = FINDING_PLACE.exec(l.slice(m[0].length));
    findings.push({ severity: m[1] as NonNullable<JobResult["review"]>["findings"][number]["severity"], path: at?.[1] ?? "", line: at ? Number(at[2]) : 0 });
  }
  return { findings, firstLine: (lines[0] ?? "").trim().slice(0, MAX_FIRST_LINE) };
}

/**
 * A merged PR's audit (`as: audit`) answers `pass` or `finding` on its first line and has no Findings section (scripts/post-audit.ts):
 * its record keeps that first line (the first line that is not empty), so the audit is on record without anyone's comment.
 */
export const auditResult = (text: string): JobResult["review"] | null => {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first === undefined ? null : { findings: [], firstLine: first.slice(0, MAX_FIRST_LINE) };
};

/**
 * An arbiter's output (`as: arbiter`) has no Findings section: its record keeps the rulings and viewpoints as `checkRulings` reads them
 * (`ops-kit/src/review-arbiter.ts`, the one reader of the line shapes), so an output that cannot be read is on record as unreadable, not as no record.
 */
export const arbiterResult = (text: string): NonNullable<JobResult["review"]> => {
  const r = checkRulings(text);
  const cap = (l: string[]) => l.slice(0, MAX_FINDINGS).map((x) => x.slice(0, MAX_FIRST_LINE));
  return { findings: [], firstLine: (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, MAX_FIRST_LINE), rulings: { reviewerSide: cap(r.reviewerSide), missing: cap(r.missing), unreadable: cap(r.unreadable) } };
};

/**
 * The copy of a review's output, run as a short child whose working folder is the folder of the place the request named.
 * Entering the folder pins it: a link put in place of a folder on the way afterwards changes nothing for the child. The child
 * reads where that folder really is (`process.cwd()` is the kernel's path of the pinned folder) and refuses one outside the
 * checkout; it then makes a new file by a relative name (`O_EXCL|O_NOFOLLOW`) and renames it over the output (rename replaces
 * a link or a hard link; it does not write through it). It removes only the temporary file it made itself.
 * The child runs outside any sandbox in a folder the reviewer could write to, so Bun is told not to read that folder's
 * `.env` and is given the daemon's own `bunfig.toml` (a `preload` there is code), as the gate's front of `gh` is.
 */
const COPY_CHILD = `
const fs = require("node:fs");
const { ROOT, NAME, TMP } = process.env;
const here = process.cwd();
if (here !== ROOT && !here.startsWith(ROOT + "/")) { console.error("the folder is not inside the checkout: " + here); process.exit(3); }
const fd = fs.openSync(TMP, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
try {
  try { fs.writeSync(fd, fs.readFileSync(0)); } finally { fs.closeSync(fd); }
  fs.renameSync(TMP, NAME);
} catch (e) {
  try { fs.unlinkSync(TMP); } catch {}
  throw e;
}
`;

/**
 * A review's output, written by the reviewer to the job's own folder (`$J/out.md`), goes to the place the request named (`out-path`).
 * The reviewer could write in the checkout until it ended (and a process it left may still run), so the copy is made by
 * `COPY_CHILD`, which nothing done to the path after it entered the folder can send outside the checkout.
 * A copy that cannot be made is said in the job's log; it never throws, and the job's end is not failed for it.
 */
export function deliverReview(job: Job, jobDir: string): void {
  const src = join(jobDir, "out.md");
  try {
    if (!existsSync(src)) return;
    const dest = readFileSync(join(jobDir, "out-path"), "utf8").trim();
    const name = basename(dest);
    const r = Bun.spawnSync([process.execPath, "--no-env-file", `--config=${join(DAEMON_ROOT, "bunfig.toml")}`, "-e", COPY_CHILD], {
      cwd: dirname(dest),
      env: { ROOT: realpathSync(job.cwd), NAME: name, TMP: `.${name}.job${job.id}.tmp` },
      stdin: readFileSync(src),
      stdout: "ignore",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim().split("\n").slice(-3).join(" ") || `exit ${r.exitCode}`);
  } catch (e) {
    try {
      writeFileSync(join(jobDir, "log"), `review: the output was not copied from ${src}: ${String((e as Error)?.message ?? e)}\n`, { flag: "a" });
    } catch {}
  }
}

/**
 * A review job that passed leaves its findings in its record: its output is read once, from the job's own copy (an audit job: its first line),
 * never from the checkout the reviewer could write to. An output that cannot be read leaves no result; the job's end is not failed for it.
 */
function recordReview(deps: JobDeps, job: Job, jobDir: string): void {
  try {
    const text = readFileSync(join(jobDir, "out.md"), "utf8");
    const result = job.as === "arbiter" ? arbiterResult(text) : reviewResult(text) ?? (job.as === "audit" ? auditResult(text) : null);
    if (result) deps.db.setJobResult(job.id, { result: { review: result } });
  } catch {
    // no output file, or not readable: the job has no result
  }
}

/** What a local CI run leaves in its folder (`scripts/local-ci.ts`'s `writeJobResult`): the head and base it tested and its outcome. */
const SHA = /^[0-9a-f]{40}$/;
const CiFile = z.object({ head: z.string().regex(SHA), base: z.string().regex(SHA), ci: JobCi });

/** A local-ci job's result is read once from the file its run left in the job's folder. A missing or unreadable file leaves no result; the job's end is not failed for it. */
function recordCi(deps: JobDeps, job: Job, jobDir: string): void {
  try {
    const f = CiFile.parse(JSON.parse(readFileSync(join(jobDir, "result.json"), "utf8")));
    deps.db.setJobResult(job.id, { head: f.head, base: f.base, result: { ci: f.ci } });
  } catch {
    // no file, or not what a run writes: the job has no result
  }
}

/** A result written after the job ended (`scripts/local-ci.ts --collect` for a build that outlived the daemon) goes into the job that has none yet; its status stays. */
function adoptLateResults(deps: JobDeps): void {
  // the folders of older jobs are gone (`pruneJobDirs`)
  for (const job of deps.db.listJobs((deps.now ?? Date.now)() - JOBS_KEEP_MS)) {
    if (job.kind === "local-ci" && job.status !== "running" && job.result === null) recordCi(deps, job, join(deps.dir, String(job.id)));
  }
}

/** What a tag CI run leaves in its folder (`scripts/tag-ci.ts --sha`): the commits it judged, as this run (not a mark read back from a Release). */
const TagCiFile = z.object({ judged: z.array(z.object({ sha: z.string().regex(SHA), ok: z.boolean() })) });

/** A tag-ci job's result is the outcome of the commit the job was asked for (its head), when its run judged it. A run that judged nothing (recordings missing, the build not started, cut) leaves no result. */
function recordTagCi(deps: JobDeps, job: Job, jobDir: string): void {
  try {
    const f = TagCiFile.parse(JSON.parse(readFileSync(join(jobDir, "result.json"), "utf8")));
    const mine = f.judged.find((e) => e.sha === job.head);
    if (mine) deps.db.setJobResult(job.id, { result: { tagCi: { ok: mine.ok } } });
  } catch {
    // no file, or not what a run writes: the job has no result
  }
}

/** What a gate run leaves in its folder (`scripts/merge-gate.ts`'s `writeGateResult`): the judged head and the verdict's parts. A cut or refused run (exit 2) leaves none: no judgement. */
const GateFile = z.object({
  head: z.string().regex(SHA),
  verdict: z.enum(["merge", "stop"]),
  ask: z.array(z.string()),
  recheck: z.array(z.string()),
  // a gate job started by the release before this one and finished after the promotion has none: left absent, so the audit reads its `[再チェック <kind>]` reasons
  required: z.array(z.string()).optional(),
  stack: z.array(z.object({ pr: z.number(), head: z.string().nullable(), ask: z.array(z.string()), recheck: z.array(z.string()), required: z.array(z.string()), merged: z.boolean(), reviewSkipped: z.boolean().optional() })).optional(),
  reasons: z.array(z.string()),
  allowLarge: z.boolean(),
  reviewSkipped: z.boolean(),
  merged: z.boolean(),
});
const MAX_GATE_REASONS = 50;
const MAX_GATE_REASON_CHARS = 500;

/** A gate job's result is read once from the file its run left; its `head` is the PR's head it judged (the request had no head to record). A missing or unreadable file leaves no result; the job's end is not failed for it. */
function recordGate(deps: JobDeps, job: Job, jobDir: string): void {
  try {
    const f = GateFile.parse(JSON.parse(readFileSync(join(jobDir, "result.json"), "utf8")));
    deps.db.setJobResult(job.id, { head: f.head, result: { gate: { ...f, reasons: f.reasons.slice(0, MAX_GATE_REASONS).map((r) => r.slice(0, MAX_GATE_REASON_CHARS)) } } });
  } catch {
    // no file, or not what a run writes: the job has no result
  }
}

function finish(deps: JobDeps, id: number): Job | null {
  const jobDir = join(deps.dir, String(id));
  // before the end is recorded: a Task that sees the job ended finds its output in place
  const before = deps.db.getJob(id);
  if (before?.kind === "review" && before.status === "running") deliverReview(before, jobDir);
  const code = readExit(jobDir);
  const status = code === null ? "aborted" : code === 0 ? "pass" : "fail";
  const log = join(jobDir, "log");
  const summary = [`${status}（終了コード ${code ?? "なし"}）`, tailLines(log, 20), `ログ: ${log}`].filter(Boolean).join("\n");
  const endedAt = (deps.now ?? Date.now)();
  const job = deps.db.finishJob(id, { status, exitCode: code, summary, endedAt });
  if (job?.kind === "review" && job.runner) recordUsage(deps, job, jobDir, endedAt);
  // a Claude review started on the CLI's own model: its events name the model it ran on (Codex's say none, so its record stays null)
  if (job?.kind === "review" && job.runner === "claude" && job.model === null) {
    const model = claudeJobModel(jobDir);
    if (model) deps.db.setJobModel(id, model);
  }
  if (job?.kind === "review" && status === "pass") recordReview(deps, job, jobDir);
  if (job?.kind === "local-ci") recordCi(deps, job, jobDir);
  if (job?.kind === "tag-ci") recordTagCi(deps, job, jobDir);
  if (job?.kind === "gate") recordGate(deps, job, jobDir);
  pruneQuietly(deps);
  // the reviewer's TMPDIR, which its sandbox could write in, goes with the job: after the end is recorded, so what the reviewer
  // left there (a folder it made read-only) cannot keep the review's result from being recorded
  removeTmp(join(jobDir, "tmp"));
  const ended = job ? deps.db.getJob(id) : null;
  if (ended) deps.onFinish?.(ended);
  return ended;
}

/** Removes a folder a reviewer wrote in; a folder it left without write permission is made writable first. Best effort. */
function removeTmp(dir: string): void {
  const writable = (d: string): void => {
    chmodSync(d, 0o700);
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) writable(join(d, e.name));
  };
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      writable(dir);
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[jobs] ${dir}: ${String((e as Error)?.message ?? e)}`);
    }
  }
}

/**
 * `finish` for the job's exit and the daemon's start: an error in one job's end is logged and does not stop the other jobs'
 * recovery or the daemon's start. A job whose end could not be recorded is ended as aborted, so the Task waiting on it does not wait forever.
 */
function finishQuietly(deps: JobDeps, id: number): void {
  // a step after the end was recorded can throw too: the Task is told of the end once, whether `finish` told it or not
  let told = false;
  const onFinish = deps.onFinish;
  try {
    finish({ ...deps, onFinish: onFinish && ((j) => ((told = true), onFinish(j))) }, id);
  } catch (e) {
    const why = String((e as Error)?.message ?? e);
    console.error(`[jobs] job#${id} end: ${why}`);
    try {
      const cur = deps.db.getJob(id);
      if (!cur || told) return;
      const ended = cur.status === "running" ? deps.db.finishJob(id, { status: "aborted", exitCode: null, summary: `aborted（終了を記録できませんでした: ${why}）`, endedAt: (deps.now ?? Date.now)() }) : cur;
      if (ended) onFinish?.(ended);
    } catch (e2) {
      console.error(`[jobs] job#${id} end: ${String((e2 as Error)?.message ?? e2)}`);
    }
  }
}

/**
 * The runner that does the attacking-side review of a Task's PR first: a runner other than the implementer when the setting is
 * `other`, the implementer's own (a new session) when it is `same`. The other one may stand in when that runner is at its usage limit
 * (`requestJob` accepts either and does not check the limit, as for `fallback`), so the review does not wait on one runner. Null for a runner that reviews nothing.
 */
export function attackReviewer(taskRunner: string, setting: "same" | "other"): "claude" | "codex" | null {
  return primaryReviewer(taskRunner, setting);
}

/** The runner that reads a recheck: the main reviewer's own (a new session) when the recheck setting is `same`, the other one when it is `other`. */
export function recheckReviewer(primary: "codex" | "claude", setting: "other" | "same"): "codex" | "claude" {
  if (setting === "same") return primary;
  return primary === "claude" ? "codex" : "claude";
}

/** A Task in one of these may still work in its folder: every status but the ended ones. */
const LIVE_TASK = TaskStatus.options.filter((s) => s !== "done" && s !== "error" && s !== "aborted");

/** The utilization of the main reviewer's usage-limit window at which a stand-in review is taken (the same value as the skill's guidance for a fallback). */
const LIMIT_UTILIZATION = 0.9;

/**
 * Why a review asked of a runner that is not the main reviewer is refused, or null when the record backs the reason it names
 * (`as`): a fallback needs the main reviewer's usage-limit window at its limit now, or a main review job of this PR that ended at
 * the limit; a recheck needs a main review job of this PR (one asked with no reason, or its stand-in) that has ended; an audit needs the PR stored as merged. An attack names its
 * own runner and is not checked here.
 */
export function reviewPurposeRefusal(deps: JobDeps, cwd: string, req: JobRequest, primary: "codex" | "claude"): string | null {
  if (req.kind !== "review" || !req.as || req.as === "attack") return null;
  const now = (deps.now ?? Date.now)();
  const workspaces = deps.db.listWorkspaces();
  const ws = workspaces.find((w) => sameRepository(w.path, cwd));
  const key = repoKeyOf(cwd, ws);
  // the job's own record of the repository first, so a review checkout that is gone does not hide it
  const mine = () => deps.db.reviewJobsForPr(req.pr).filter((j) => (key !== "" && j.repo === key) || sameRepository(j.cwd, cwd, workspaces.map((w) => w.path)));
  if (req.as === "fallback") {
    if (deps.db.quotaAll().some((q) => q.runner === primary && q.utilization >= LIMIT_UTILIZATION && q.resetsAt * 1000 > now)) return null;
    if (mine().some((j) => j.runner === primary && j.status !== "pass" && isLimitText(primary, j.summary ?? undefined))) return null;
    return `fallback（主レビュアー ${primary} が使用上限）は、${primary} の使用上限の枠が ${LIMIT_UTILIZATION} 以上で戻っていない記録か、この PR の ${primary} のレビューが使用上限で終わった記録があるときだけ受けます。どちらの記録もありません。主レビューは --runner ${primary} で頼んでください`;
  }
  if (req.as === "recheck" || req.as === "arbiter") {
    if (mine().some((j) => (j.as === null || j.as === "fallback") && j.endedAt !== null)) return null;
    return `${req.as} は、この PR の review の仕事が終わった後に頼みます。終わった review の記録がありません。先に主レビュー（--runner ${primary}）を頼んでください`;
  }
  if (ws && storedEnds(deps.db, ws)(req.pr)?.state === "MERGED") return null;
  return `audit は、PR がマージ済みの記録があるときだけ受けます。PR #${req.pr} のマージの記録がまだありません（保存の同期の前かもしれません）。同期の後に頼み直してください`;
}

/**
 * Starts a job for a Task: checks the request, records the job and starts it as the daemon's detached child.
 * Throws JobError (404: no such Task; 400: a folder or file outside the Task's repository, or a reviewer the setting does not name).
 *
 * A review's runner is the app's to decide: the main reviewer follows from the review setting as it is now and the Task's
 * runner (`primaryReviewer`). A request that names another runner is refused unless it says why (`as`: a usage-limit
 * fallback, an audit). A recheck (`as: "recheck"`) and an arbiter (`as: "arbiter"`, which takes no kinds) are read by the runner the recheck setting names (`recheckReviewer`): the app
 * picks it when the request names none, and refuses another one. The attacking-side review (`as: "attack"`) names its runner: `attackReviewer`'s, or the other one standing in when that one is at its usage limit (the caller's reason; the limit is not checked). It is refused for a Task whose runner reviews nothing, where `attackReviewer` names none.
 */
export function requestJob(deps: JobDeps, req: JobRequest, opts: { app?: true } = {}): Job {
  // `app`: a tag CI run the app asks for itself (the promotion check) has no Task: its checkout must be a registered workspace's.
  // Only a call inside the process can say so; the reserved `taskId` in a request body (the HTTP route) is refused, or any caller could be the app
  if (req.taskId === APP_JOB_TASK && !(opts.app && req.kind === "tag-ci")) throw new JobError(`taskId ${APP_JOB_TASK} はアプリの予約の値です`, 400);
  const app = !!opts.app;
  const task = app ? null : deps.db.getTask(req.taskId);
  if (!task && !app) throw new JobError("task not found", 404);
  const taskRunner = task?.runner ?? "";
  // relative to the daemon's own folder would be a mistake: the Task names its checkout
  if (!isAbsolute(req.cwd)) throw new JobError(`cwd must be absolute: ${req.cwd}`, 400);
  const cwd = resolve(req.cwd);
  if (task ? !sameRepository(task.cwd, cwd, deps.db.listWorkspaces().map((w) => w.path)) : !deps.db.listWorkspaces().some((w) => sameRepository(w.path, cwd))) throw new JobError(`cwd is not a checkout of the task's repository: ${req.cwd}`, 400);
  const files: Record<string, string> = {};
  let reviewer: "codex" | "claude" | null = null;
  if (req.kind === "review") {
    const setting = deps.reviewRunner?.() ?? "other";
    const primary = primaryReviewer(taskRunner, setting);
    if (!req.runner && !primary) throw new JobError(`この Task のランナー（${taskRunner}）からは主レビュアーを決められません。--runner codex|claude で名指ししてください`, 400);
    if (req.as && req.as !== "recheck" && req.as !== "arbiter" && !req.runner) throw new JobError("as（主レビューでない回の理由）は runner の名指しが要ります", 400);
    if (req.runner && primary && req.runner !== primary && !req.as) {
      throw new JobError(`設定（レビューのランナー: ${setting}）では、この Task（${taskRunner}）の主レビュアーは ${primary} です。主レビューは --runner ${primary} で頼んでください。主レビュアーでないランナーに頼むのは、理由を --as で名指ししたときだけです（fallback = 主レビュアーが使用上限、recheck = 再チェック、audit = マージ後の監査、attack = 攻める側のレビュー、arbiter = 監督者の裁定）`, 400);
    }
    if (req.as === "attack") {
      const attacker = attackReviewer(taskRunner, setting);
      // either runner: the other one stands in when attackReviewer's is at its usage limit (runner is required above)
      if (!attacker) throw new JobError(`この Task のランナー（${taskRunner}）では、攻める側のレビューを頼むランナーを決められません`, 400);
    }
    let rechecker: "codex" | "claude" | null = null;
    if ((req.as === "recheck" || req.as === "arbiter") && primary) {
      const recheck = deps.recheckRunner?.() ?? setting;
      rechecker = recheckReviewer(primary, recheck);
      if (req.runner && req.runner !== rechecker) throw new JobError(`設定（再チェック・監査のランナー: ${recheck}）では、この Task（${taskRunner}）の${req.as === "arbiter" ? "監督者" : "再チェック"}は ${rechecker} です。--runner を省けばアプリが選びます`, 400);
    }
    if (req.as === "recheck") {
      const bad = (req.kinds ?? []).filter((k) => !(RECHECK_KINDS as string[]).includes(k));
      // no kinds is recorded as none (it counts for no kind's pass); a word that is not a kind is a mistake
      if (bad.length) throw new JobError(`kinds に再チェックの種類でない語があります: 知らない種類 ${bad.join(", ")}（${RECHECK_KINDS.join(" / ")}）`, 400);
    } else if (req.kinds?.length) throw new JobError("kinds は as: recheck のときだけ渡します", 400);
    // the runner that will read it (a recheck without one is the recheck setting's): any other than the main reviewer must have its reason backed by the record
    if (req.as && primary && (req.runner ?? rechecker) !== primary) {
      const refusal = reviewPurposeRefusal(deps, cwd, req, primary);
      if (refusal) throw new JobError(refusal, 400);
    }
    // the reviewer may write in its checkout: not in the Task's own working folder, a registered workspace's checkout or the
    // working tree of any Task not ended (someone's work in progress), nor in a folder under them. Another Task counts by the
    // working tree that holds its folder (a Task in a package folder protects the whole tree); a folder in no working tree (the
    // home folder) counts for nothing, so a Task working there does not refuse every review
    const real = realpathSync(cwd);
    const live = LIVE_TASK.flatMap((s) => deps.db.listTasksByStatus(s).map((t) => t.cwd)).flatMap((d) => {
      try {
        const top = git(realpathSync(d), "rev-parse", "--show-toplevel");
        return top ? [top] : [];
      } catch {
        return [];
      }
    });
    const mine = [task!.cwd, ...deps.db.listWorkspaces().map((w) => w.path), ...live].find((d) => {
      try {
        return inside(realpathSync(d), real);
      } catch {
        return false;
      }
    });
    if (mine) throw new JobError(`レビューの checkout（cwd）が Task の作業フォルダ・登録した workspace の checkout・終わっていない Task の作業フォルダ（${mine}）か、その中です。レビュアーはそこに書けるので、別の clone か worktree を --cwd で渡してください: ${req.cwd}`, 400);
    reviewer = req.runner ?? rechecker ?? primary!;
    const prompt = resolve(cwd, req.promptFile);
    if (!existsSync(prompt)) throw new JobError(`promptFile not found: ${req.promptFile}`, 400);
    // the review reads and writes only inside the checkout (`_review/` in cross-runner-review): a path that leads out,
    // through `..` or a link, is refused, so a request cannot have the daemon truncate a file elsewhere
    const out = resolve(cwd, req.outFile);
    if (!within(cwd, prompt) || !within(cwd, out)) throw new JobError("promptFile and outFile must be inside cwd", 400);
    files.JOB_PROMPT = prompt;
    files.JOB_OUT = out;
    // the reviewer writes its tests under `_review/tests/`: a `_review` that leads out of the checkout through a link is refused, as the prompt and output are
    const review = join(cwd, "_review");
    if (lstatSync(review, { throwIfNoEntry: false }) && !within(cwd, review)) throw new JobError("_review must be inside cwd", 400);
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
  // the tag CI runs the CI steps of the tag's commit; of someone else's repository that is code nobody here reviewed
  if (req.kind === "tag-ci" && ws?.upstream) throw new JobError("他者のリポジトリ（元の更新を取り込む workspace）のタグの CI は、このホストの利用者の権限では回しません", 409);
  // someone else's repository: its script is code nobody here reviewed, and a recheck runs it here as the host's user
  if (req.kind === "recheck" && ws?.upstream) throw new JobError("他者のリポジトリ（元の更新を取り込む workspace）の再チェックは、このホストの利用者の権限では回しません（checkout の scripts/recheck.ts は誰もレビューしていないコードのため）", 409);
  // a repository without the script has no recheck decided by a command
  if (req.kind === "recheck" && !existsSync(join(cwd, "scripts/recheck.ts"))) throw new JobError(`このリポジトリには、コマンドで決まる再チェックがありません（scripts/recheck.ts が無い）: ${req.cwd}`, 400);
  // the record says which head passed, so the job must run that head's code: a checkout with uncommitted or untracked files would run something else
  if (req.kind === "recheck" && git(cwd, "status", "--porcelain") !== "") throw new JobError(`checkout に未コミットの変更（untracked を含む）があります。コミットしてから頼んでください（記録する head と走るコードを同じにするため）: ${req.cwd}`, 400);
  // a change the app holds belongs to a registered workspace; its local CI is this repository's script with --change, which
  // runs in the build the script picks and takes no --repo: a request that asks for more is refused, not run to fail
  let other: { script: string; repo: string } | undefined;
  // where the tag CI script lists the tags it judges: Switchboard's own clone, or the other repository's checkout
  let tagRoot = cwd;
  const change = req.kind !== "tag-ci" && req.change;
  if (change) {
    if (!ws) throw new JobError(`変更（change）の要求は、登録した workspace の checkout からだけ受けます: ${req.cwd}`, 400);
    if (req.kind === "local-ci" && req.local) throw new JobError("変更（change）のローカル CI は --local を取りません（scripts/local-ci.ts --change は外のビルドの選び方を自分で決めます）", 400);
    // another repository's change: it has no scripts/local-ci.ts, so Switchboard's runs from its folder in that checkout, as a person runs it from a terminal (`--change` takes no --repo)
    if (req.kind === "local-ci" && meta && !sameRepository(meta.path, cwd)) other = { script: join(meta.path, "scripts/local-ci.ts"), repo: "" };
  }
  // local CI of a repository that is not Switchboard's: it has no scripts/local-ci.ts, so Switchboard's runs from its folder
  if (req.kind === "local-ci" && !change && meta && !sameRepository(meta.path, cwd)) {
    const repo = githubRepoOf(cwd);
    if (!repo) throw new JobError(`cwd の origin から GitHub の owner/name を読めません: ${req.cwd}（アプリが持つ変更は bun ${join(meta.path, "scripts/local-ci.ts")} --change <n>）`, 400);
    other = { script: join(meta.path, "scripts/local-ci.ts"), repo };
  }
  // the tag CI of a repository that is not Switchboard's: Switchboard's script runs from its folder with `--repo`
  if (req.kind === "tag-ci") {
    if (!meta) throw new JobError("Switchboard 自身の workspace が登録されていないので、タグの CI（scripts/tag-ci.ts）を探せません", 400);
    const repo = sameRepository(meta.path, cwd) ? "" : githubRepoOf(cwd);
    if (repo === null) throw new JobError(`cwd の origin から GitHub の owner/name を読めません: ${req.cwd}`, 400);
    other = { script: join(meta.path, "scripts/tag-ci.ts"), repo };
    tagRoot = repo ? cwd : meta.path;
    if (!existsSync(other.script)) throw new JobError(`scripts/tag-ci.ts がありません: ${other.script}`, 400);
    // the recordings the tag's tests replay (the run fails a tag whose recording is missing only when it is told where they are)
    const fixtures = deps.env.SWITCHBOARD_FIXTURES || join(homedir(), ".switchboard", "fixtures");
    if (existsSync(fixtures)) files.SWITCHBOARD_FIXTURES = fixtures;
  }
  if (req.kind === "gate") {
    if (!deps.app) throw new JobError("このデーモンは自分の記録の場所を言えないので、判定の仕事を回せません", 500);
    // `--change` judges the app's change and takes no PR number's repository, nor a merge (the local merge is `scripts/local-merge.ts`)
    if (req.change && (req.repo || req.merge)) throw new JobError("変更（change）の判定は --repo と --merge / --merge-stack を取りません（変更のマージは scripts/local-merge.ts）", 400);
    if (req.scope && req.merge) throw new JobError("--scope は判定もマージもしません", 400);
    if (req.viewpoints && req.merge) throw new JobError("--viewpoints は判定もマージもしません", 400);
  }
  // what the record says the job ran on: the repository (a change the app holds is its workspace's; a gate job for another repository's PR, the one it was asked for) and, for a review or a recheck, the head it reads
  const repo = change ? `local:${ws!.id.toLowerCase()}` : req.kind === "gate" && req.repo ? req.repo.toLowerCase() : repoKeyOf(cwd, ws);
  // a tag CI run's head is the newest tag's commit (a promotion reads the record by it)
  // (`sha` given: the commit the promotion decided about, which must be a tag's; else the newest tag's)
  const newestTag = req.kind === "tag-ci" && !req.sha ? git(tagRoot, "tag", "-l", "v*", "--sort=-v:refname")?.split("\n")[0]?.trim() : undefined;
  // `sha`: the commit the promotion decided about; it must be a tag's in this clone (the promotion fetches the tags first, asynchronously: a request does not wait for the network here)
  const hasTag = (sha: string) => !!git(tagRoot, "tag", "-l", "v*", "--points-at", sha);
  // a gate job's head is the PR's head it judged: its run says it (`recordGate`), the checkout's HEAD is not that
  const head = req.kind === "local-ci" || req.kind === "gate" ? null : req.kind === "tag-ci" ? (req.sha ? (hasTag(req.sha) ? req.sha : null) : newestTag ? git(tagRoot, "rev-list", "-n", "1", newestTag) : null) : git(cwd, "rev-parse", "HEAD");
  if (req.kind === "tag-ci" && !head) throw new JobError(req.sha ? `${req.sha} は ${tagRoot} のタグ（v*）のコミットではありません` : `cwd にタグ（v*）がありません: ${req.cwd}`, 400);
  if (req.kind !== "local-ci" && req.kind !== "gate" && !head) throw new JobError(`cwd の HEAD を読めません: ${req.cwd}`, 400);
  // not the Task's: without its mark (the Task's end stops what carries it) and without SWITCHBOARD_SUPERVISED
  // (a Task's variable; local CI's tests fail with it), and without Claude Code's session markers and the OTEL_*
  // destinations, as the Task's own claude gets it (`childEnv`). OPS_KIT_TASK_ID still names the Task to `ops-kit heavy`.
  const env = childEnv(deps.env);
  delete env[TASK_MARK];
  delete env.SWITCHBOARD_SUPERVISED;
  Object.assign(env, files, workspaceConfigEnv(ws), { OPS_KIT_TASK_ID: req.taskId });
  // a Claude reviewer runs its tests in Claude Code's sandbox, which needs bubblewrap and socat on the job's own PATH; without them Claude Code would run them unsandboxed, so it only reads
  const readOnly = reviewer === "claude" && !(deps.claudeSandbox ?? ((path: string) => ["bwrap", "socat"].every((b) => Bun.which(b, { PATH: path }) !== null)))(env.PATH ?? "");
  // the model and effort a review starts with, read once: the job's record keeps what its runner was given (empty = the CLI's own = null)
  const choice = req.kind === "review" ? deps.reviewChoice?.(reviewer!) : undefined;
  const job = deps.db.insertJob({ kind: req.kind, taskId: req.taskId, pr: req.kind === "tag-ci" ? 0 : req.pr, runner: reviewer, cwd, startedAt: (deps.now ?? Date.now)(), repo, head, as: req.kind === "review" ? req.as ?? null : null, kinds: req.kind === "review" ? req.kinds ?? [] : req.kind === "recheck" ? [req.recheck] : [], model: choice?.model || null, effort: choice?.effort || null });
  const jobDir = join(deps.dir, String(job.id));
  // the reviewer writes its output in the job's own folder, not in the checkout it may write in (`deliverReview` copies it there at the end).
  // Its TMPDIR is in the job's folder too, not in the checkout: Claude Code makes sockets there, and a checkout's path can be too long
  // for a socket's address. A real path, as the sandbox's other folders are: the jobs' folder is made first, so the first job's is real too
  if (req.kind === "review") mkdirSync(deps.dir, { recursive: true });
  const resolved: ResolvedJobRequest = req.kind === "review" ? { ...req, runner: reviewer!, cwd, promptFile: files.JOB_PROMPT!, outFile: join(jobDir, "out.md"), tmpDir: join(realOr(deps.dir), String(job.id), "tmp"), ...(readOnly ? { readOnly: true as const } : {}) } : { ...req, cwd, ...(other ? { other } : {}), ...(req.kind === "recheck" || req.kind === "tag-ci" ? { head: head! } : {}) };
  if (resolved.kind === "review") Object.assign(env, { JOB_OUT: resolved.outFile, TMPDIR: resolved.tmpDir });
  // what the reviewer reads: the Task's instructions (left as written) and the note of the runner that reviews, in the job's folder
  const prompt = resolved.kind === "review" ? reviewPrompt(readFileSync(resolved.promptFile, "utf8"), resolved.runner, resolved.readOnly) : null;
  if (prompt !== null) env.JOB_PROMPT = join(jobDir, "prompt.md");
  const { argv, tail } = deps.command ? deps.command(resolved) : jobCommand(resolved, deps.reviewIdleS, choice, deps.env.HOME || homedir());
  env.J = jobDir;
  if (req.kind === "gate") {
    // the daemon's own place for its records: what `scripts/merge-gate.ts` reads them at is not the Task's to name. The Task's own
    // addresses and marks are not in this environment (the front of `gh` that stops a merge is the Task shell's, and this run merges)
    const app = deps.app!();
    for (const k of ["MERGE_RECORDS_URL", "MERGE_RECORDS_TOKEN_FILE", "BACKLOG_URL", "BACKLOG_TOKEN_FILE", "BACKLOG_WORKSPACE", "SWITCHBOARD_TASK_ID", "OPS_MERGE_GATE_PR", "GH_REPO"]) delete env[k];
    env.MERGE_RECORDS_URL = app.url;
    env.MERGE_RECORDS_TOKEN_FILE = app.tokenFile;
    // a change is read from the app as `ops-kit backlog view --change` does; it only judges and never calls gh to merge
    if (change) Object.assign(env, { BACKLOG_URL: `${app.url}/api/backlog`, BACKLOG_TOKEN_FILE: app.tokenFile, BACKLOG_WORKSPACE: ws!.id });
  }
  let proc: ReturnType<typeof Bun.spawn>;
  let log: number | null = null;
  try {
    // a folder left by a job of the same id (a database restored or made again while ~/.switchboard/jobs stayed) would
    // hand this one its exit code: the folder starts empty
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(jobDir, { recursive: true });
    if (prompt !== null) writeFileSync(join(jobDir, "prompt.md"), prompt);
    // where a review's output will be, for the job's end to read (a daemon started again has no request to ask)
    if (files.JOB_OUT) writeFileSync(join(jobDir, "out-path"), files.JOB_OUT);
    if (resolved.kind === "review") mkdirSync(resolved.tmpDir);
    log = openSync(join(jobDir, "log"), "w");
    if (readOnly) writeSync(log, "review: Claude Code's sandbox cannot start here (bwrap or socat is not on PATH): the reviewer only reads and runs no tests\n");
    proc = Bun.spawn(["bash", "-c", WRAPPER(tail), "job", ...argv], { cwd: req.kind === "gate" ? DAEMON_ROOT : cwd, env, stdin: "ignore", stdout: log, stderr: log, detached: true });
  } catch (e) {
    if (log !== null) closeSync(log);
    deps.db.finishJob(job.id, { status: "aborted", exitCode: null, summary: `aborted（起動できませんでした: ${(e as Error).message}）`, endedAt: (deps.now ?? Date.now)() });
    throw new JobError(`could not start the job: ${(e as Error).message}`, 500);
  }
  closeSync(log!);
  deps.db.setJobPid(job.id, proc.pid, (deps.bootId ?? readBootId)());
  proc.unref();
  // a daemon stopping closes its database first: the job stays running and the next start's recoverJobs ends it
  void proc.exited.then(() => finishQuietly(deps, job.id));
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
      if (readExit(join(deps.dir, String(id))) !== null || !alive(pid)) finishQuietly(deps, id);
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
      finishQuietly(deps, job.id);
      // only a local-ci that is gone left its build to collect; a live one (a restart in the same boot) writes its own result
      if (job.kind === "local-ci") ciLeft = true;
    } else watch(job.id, pid);
  }
  pruneQuietly(deps);
  // a build offloaded from local CI may have ended while the daemon was down: write its result to the PR (once per start)
  if (deps.collectPending && (ciLeft || hasPending(deps.pendingDir ?? localCiPendingDir()))) {
    try {
      deps.collectPending(() => adoptLateResults(deps));
    } catch (e) {
      console.error(`[jobs] collect pending: ${String((e as Error)?.message ?? e)}`);
    }
  }
  adoptLateResults(deps);
}

const hasPending = (dir: string): boolean => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};
