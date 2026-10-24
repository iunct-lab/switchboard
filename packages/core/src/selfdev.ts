import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, CheckRun } from "@switchboard/protocol";
import type { Db } from "./db.ts";

/**
 * Self-dev (proposal §5 "Self-dev を成立させる構造", issue #18). When a task on the meta workspace (Switchboard's own
 * repository) finishes a turn, the daemon runs the repository's checks and shows them in the Brief next to the diff.
 * "適用してデーモン再起動" restarts the daemon on the new code; the UI survives on WebSocket reconnect.
 */
export const CHECKS: Array<{ kind: CheckResult["kind"]; argv: string[] }> = [
  { kind: "typecheck", argv: ["bun", "run", "typecheck"] },
  { kind: "test", argv: ["bun", "test"] },
];
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 10 * 60_000;
/** Exit code that tells a supervisor (scripts/dev.ts) "respawn me on the current code". */
export const RESTART_EXIT_CODE = 75;
/**
 * The daemon's one way out (#1136): SIGINT / SIGTERM and a crash all run `stop` (runners, shells, MCP) under a time limit
 * before `exit`. A second call while stopping is ignored. No respawn here; a supervisor decides that from the exit code.
 */
export function shutdownOnce(stop: () => Promise<void>, exit: (code: number) => void, timeoutMs = 20_000): (code: number, err?: unknown) => Promise<void> {
  let started = false;
  return async (code, err) => {
    if (started) return;
    started = true;
    if (err !== undefined) console.error("fatal:", err);
    console.log("\nshutting down…");
    await Promise.race([stop().catch(console.error), Bun.sleep(timeoutMs)]);
    exit(code);
  };
}

/** Set in the environment of check subprocesses so a daemon started by them never runs checks itself. */
export const CHECK_CHILD_ENV = "SWITCHBOARD_CHECKS_CHILD";

/** Checks are off by default inside `bun test` and inside a check subprocess: no recursion. */
export function checksEnabledByDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CHECK_CHILD_ENV] === undefined && env.NODE_ENV !== "test";
}

export function checkEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("SWITCHBOARD_") && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env[CHECK_CHILD_ENV] = "1";
  return env;
}

/** Read a stream keeping only the last `max` characters (chatty test output must not grow the heap). */
async function readTail(stream: ReadableStream<Uint8Array> | number | null | undefined, max: number): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (text.length > max * 2) text = text.slice(-max);
  }
  return text.length > max ? text.slice(-max) : text;
}

export async function runCheck(repoRoot: string, kind: CheckResult["kind"], argv: string[], signal?: AbortSignal): Promise<CheckResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: checkEnv() });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, TIMEOUT_MS);
  const onAbort = () => proc.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  const [out, err] = await Promise.all([readTail(proc.stdout, MAX_OUTPUT), readTail(proc.stderr, MAX_OUTPUT)]);
  const code = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  const output = (out + (err ? "\n" + err : "")).trim();
  const summary = timedOut ? `timed out after ${TIMEOUT_MS / 60_000} min` : signal?.aborted ? "cancelled" : summarize(kind, output, code);
  return { kind, ok: code === 0 && !timedOut && !signal?.aborted, exitCode: code, summary, output: output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) : output, durationMs: Date.now() - t0 };
}

/** One line for the Brief: "41 pass, 0 fail" / "typecheck ok" / "exit 1". */
export function summarize(kind: CheckResult["kind"], output: string, code: number | null): string {
  if (kind === "test") {
    const pass = output.match(/^\s*(\d+) pass/m)?.[1];
    const fail = output.match(/^\s*(\d+) fail/m)?.[1];
    if (pass !== undefined || fail !== undefined) return `${pass ?? 0} pass, ${fail ?? 0} fail`;
  }
  if (kind === "typecheck" && code === 0) return "typecheck ok";
  const errors = output.match(/error TS\d+/g)?.length;
  return code === 0 ? "ok" : errors ? `${errors} type errors` : `exit ${code}`;
}

export class SelfDev {
  private running = new Map<string, { promise: Promise<CheckRun>; controller: AbortController; rerun: boolean }>();
  /** Any turn on the meta workspace after this instant changes the tree: older runs no longer vouch for it. */
  private invalidatedAt = 0;

  constructor(
    private db: Db,
    private repoRoot: string,
    private notify: (taskId: string, run: CheckRun) => void,
  ) {}

  /** Run the checks for a task. A request while one is in flight queues one more run afterwards (never returns a stale result as current). */
  run(taskId: string): Promise<CheckRun> {
    const inflight = this.running.get(taskId);
    if (inflight) {
      inflight.rerun = true;
      return inflight.promise;
    }
    const controller = new AbortController();
    const entry = { controller, rerun: false, promise: Promise.resolve() as unknown as Promise<CheckRun> };
    entry.promise = (async () => {
      let run: CheckRun;
      do {
        entry.rerun = false;
        const results: CheckResult[] = [];
        for (const c of CHECKS) results.push(await runCheck(this.repoRoot, c.kind, c.argv, controller.signal));
        run = { taskId, ok: results.every((r) => r.ok), results, ts: Date.now() };
        this.db.saveCheckRun(run);
        this.notify(taskId, run);
      } while (entry.rerun && !controller.signal.aborted);
      return run;
    })().finally(() => this.running.delete(taskId));
    this.running.set(taskId, entry);
    return entry.promise;
  }

  last(taskId: string): CheckRun | null {
    return this.db.getCheckRun(taskId);
  }

  isRunning(taskId?: string): boolean {
    return taskId ? this.running.has(taskId) : this.running.size > 0;
  }

  /** The tree changed (a meta-workspace turn ended): runs recorded before now are stale. */
  invalidate() {
    this.invalidatedAt = Date.now();
  }

  /** Is this run still a valid statement about the tree? */
  isCurrent(run: CheckRun | null): run is CheckRun {
    return !!run && run.ts >= this.invalidatedAt;
  }

  cancelAll() {
    for (const e of this.running.values()) e.controller.abort();
  }
}

/** The command line that restarts this daemon on the current code: same runtime, runtime flags (--watch …), entry, args. */
export function restartArgv(): string[] {
  const entry = process.argv[1];
  if (!entry || !existsSync(entry)) throw new Error("cannot determine the daemon entry point to restart");
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
}

/**
 * Start a replacement daemon that survives our exit: through `sh -c 'nohup … &'` (Bun.spawn cannot setsid) with its
 * output in ~/.switchboard/daemon.log, since our stdio may be a closed pipe once we are gone. `keep` puts back what the
 * daemon took out of its own environment (the idle stop command, server.ts).
 */
export function spawnDetached(argv: string[], home: string, cwd: string, keep: Record<string, string> = {}): void {
  mkdirSync(home, { recursive: true });
  const log = join(home, "daemon.log");
  const fd = openSync(log, "a");
  const cmd = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "SWITCHBOARD_SUPERVISED") env[k] = v;
  Object.assign(env, keep);
  const p = Bun.spawn(["/bin/sh", "-c", `nohup ${cmd} >> '${log}' 2>&1 < /dev/null &`], { cwd, env, stdout: fd, stderr: fd, stdin: "ignore" });
  p.unref();
}

export function isSupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHBOARD_SUPERVISED === "1";
}
