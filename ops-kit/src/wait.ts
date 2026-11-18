import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * `ops-kit wait`: the one way a Task waits for something. A check command is run again and again until it succeeds,
 * and the caller has to say what it waits for, for how long at most, and what a cut wait does — a wait with no limit
 * cannot be written. While it waits, a record file says so to the app that started the Task (it shows the wait and
 * its limit); a wait cut with `fail` leaves its record behind with the reason, and the app tells the person.
 */

/**
 * The record of one wait: `<OPS_KIT_WAITS_DIR>/<taskId>-<pid>.json`, written only when the app that started the Task
 * gave both that directory and OPS_KIT_TASK_ID. The app reads it; nothing else is sent to the app.
 */
export const WaitFile = z.object({
  taskId: z.string().min(1),
  pid: z.number().int().positive(),
  /** What is waited for, in the caller's words (`--for`). */
  label: z.string().min(1).max(200),
  startedAt: z.number(),
  /** The limit (`--timeout`): the wait is cut at this time at the latest. */
  timeoutAt: z.number(),
  /** `--stall`: cut earlier once the progress command's output has not changed for this long; null = no progress command. */
  stallSec: z.number().nullable(),
  /** When the progress command's output last changed (the start, without one). */
  progressAt: z.number(),
  /** Set when the wait was cut with `fail` and left for the app to read; null while it waits. */
  cut: z.object({ reason: z.enum(["timeout", "stalled"]), at: z.number() }).nullable().default(null),
});
export type WaitFile = z.infer<typeof WaitFile>;

/** The record's file name in the waits directory. */
export const waitFileName = (taskId: string, pid: number): string => `${taskId.replace(/[^\w.-]/g, "_")}-${pid}.json`;

export type WaitReason = "ok" | "timeout" | "stalled";
/** The one line a cut wait writes to stderr. */
export const WAIT_CUT_LINE = (reason: Exclude<WaitReason, "ok">, label: string, waitedSec: number) => `待ちが切れた（${reason === "stalled" ? "無進捗" : "上限"}）: ${label} を ${waitedSec} 秒待った`;
/** The exit code of a wait cut with `--on-timeout fail` (as `timeout(1)` and `ops-kit idle-run`). */
export const WAIT_CUT_EXIT = 124;
export const WAIT_INTERVAL_SEC = 5;
/**
 * Whether what is waited for (`--for`) is a person's answer or someone's leave (an approval, a confirmation, a review,
 * a merge, a promotion). Such a wait takes `--on-timeout fail` only: when it runs out the work stops and the person is
 * told, it does not go on as if the answer had come.
 */
export const waitsOnPerson = (label: string): boolean => /利用者|所有者|本人|人の|承認|許可|回答|返事|返信|確認|判断|レビュー|マージ|昇格|approv|answer|repl(y|ies)|confirm|decision|review|merge|promot|owner|user|person|human/i.test(label);

export const WAIT_USAGE = "wait --for <何を待つか> --timeout <秒> --on-timeout <fail|proceed> [--interval <秒>] [--progress <進みを出すコマンド> --stall <秒>] -- <判定コマンド…>\n秒は 1 から 604800（7 日）まで\n人の回答・承認・確認・レビュー・マージ・昇格を待つ待ち（--for にその語がある）は --on-timeout fail だけ（切れたら止まって利用者に伝わる。proceed は不可）";

export interface WaitOpts {
  label: string;
  timeoutSec: number;
  onTimeout: "fail" | "proceed";
  intervalSec: number;
  /** A command (run by `sh -c`) whose stdout changes while the other side moves on; with `stallSec`. */
  progress?: string;
  stallSec?: number;
  check: string[];
  cwd?: string;
}

export interface WaitDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Runs a command for at most `limitMs`; a command cut at the limit has not succeeded. */
  run: (cmd: string[], o: { cwd?: string; limitMs: number; capture: boolean }) => Promise<{ code: number; stdout: string }>;
  env: Record<string, string | undefined>;
  pid: number;
  err: (line: string) => void;
}

const realRun: WaitDeps["run"] = async (cmd, o) => {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, stdin: "ignore", stdout: o.capture ? "pipe" : "inherit", stderr: o.capture ? "ignore" : "inherit", timeout: Math.max(1, o.limitMs), killSignal: "SIGKILL" });
  const stdout = o.capture ? await new Response(proc.stdout as ReadableStream<Uint8Array>).text() : "";
  return { code: (await proc.exited) ?? 1, stdout };
};

export const realWaitDeps = (): WaitDeps => ({ now: Date.now, sleep: Bun.sleep, run: realRun, env: process.env, pid: process.pid, err: console.error });

/** The longest a wait may be asked to last, and the largest value of any of its seconds: 7 days. Every wait has a limit that is a time. */
export const WAIT_MAX_SEC = 7 * 24 * 60 * 60;

/** Parses the arguments after `wait`; null = a usage error (one of the three required ones is missing, or a value is no positive number of seconds up to `WAIT_MAX_SEC`). */
export function parseWaitArgs(args: string[]): WaitOpts | null {
  const at = args.indexOf("--");
  if (at < 0) return null;
  const check = args.slice(at + 1);
  const flags = args.slice(0, at);
  const given: Record<string, string> = {};
  for (let i = 0; i < flags.length; i += 2) {
    const [name, value] = [flags[i]!, flags[i + 1]];
    if (!["--for", "--timeout", "--on-timeout", "--interval", "--progress", "--stall"].includes(name) || value === undefined || name in given) return null;
    given[name] = value;
  }
  // digits alone are not a limit: a number of 400 digits is Infinity, and the record's `timeoutAt` would then be no time at all
  const seconds = (v: string | undefined) => (v !== undefined && /^[1-9]\d*$/.test(v) && Number(v) <= WAIT_MAX_SEC ? Number(v) : null);
  const label = given["--for"]?.trim();
  const timeoutSec = seconds(given["--timeout"]);
  const onTimeout = given["--on-timeout"];
  const intervalSec = given["--interval"] === undefined ? WAIT_INTERVAL_SEC : seconds(given["--interval"]);
  if (!label || label.length > 200 || timeoutSec === null || (onTimeout !== "fail" && onTimeout !== "proceed") || intervalSec === null || !check.length) return null;
  // a wait for a person or for someone's leave is never gone on from when it runs out: only `fail` (the app then tells the person)
  if (onTimeout === "proceed" && waitsOnPerson(label)) return null;
  const progress = given["--progress"]?.trim();
  const stallSec = seconds(given["--stall"]);
  // the two go together: a progress command with no limit cuts nothing, a limit with nothing to watch cannot be told
  if ((given["--progress"] === undefined) !== (given["--stall"] === undefined) || (given["--progress"] !== undefined && (!progress || stallSec === null))) return null;
  return { label, timeoutSec, onTimeout, intervalSec, check, ...(progress ? { progress, stallSec: stallSec! } : {}) };
}

/**
 * Waits until `check` exits 0. Cut at `timeoutSec`, or earlier once the progress command's output has stood still for
 * `stallSec` (the other side is stuck: waiting to the limit would only line more waits up behind it). A check or progress
 * command that hangs is cut at the limit too. `fail` exits WAIT_CUT_EXIT, `proceed` 0; both write the reason to stderr.
 */
export async function runWait(o: WaitOpts, deps: WaitDeps = realWaitDeps()): Promise<{ code: number; reason: WaitReason; waitedSec: number }> {
  const startedAt = deps.now();
  const timeoutAt = startedAt + o.timeoutSec * 1000;
  const taskId = deps.env.OPS_KIT_TASK_ID;
  const dir = deps.env.OPS_KIT_WAITS_DIR;
  const path = taskId && dir ? join(dir, waitFileName(taskId, deps.pid)) : null;
  let progressAt = startedAt;
  const write = (cut: WaitFile["cut"]) => {
    if (!path) return;
    try {
      mkdirSync(dir!, { recursive: true });
      const record: WaitFile = { taskId: taskId!, pid: deps.pid, label: o.label, startedAt, timeoutAt, stallSec: o.stallSec ?? null, progressAt, cut };
      writeFileSync(`${path}.tmp`, JSON.stringify(record));
      renameSync(`${path}.tmp`, path);
    } catch {
      // the record is for showing the wait; the wait itself goes on without it
    }
  };
  const remove = () => {
    if (path) rmSync(path, { force: true });
  };
  const onSignal = () => {
    remove();
    process.exit(143);
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const s of signals) process.on(s, onSignal);
  write(null);
  let reason: WaitReason;
  let seen: string | undefined;
  try {
    for (;;) {
      const left = timeoutAt - deps.now();
      if (left <= 0) {
        reason = "timeout";
        break;
      }
      if ((await deps.run(o.check, { cwd: o.cwd, limitMs: left, capture: false })).code === 0) {
        reason = "ok";
        break;
      }
      if (o.progress) {
        const out = (await deps.run(["sh", "-c", o.progress], { cwd: o.cwd, limitMs: Math.max(1, timeoutAt - deps.now()), capture: true })).stdout;
        if (out !== seen) {
          // the first reading is the start, not a move
          if (seen !== undefined) {
            progressAt = deps.now();
            write(null);
          }
          seen = out;
        } else if (deps.now() - progressAt >= o.stallSec! * 1000) {
          reason = "stalled";
          break;
        }
      }
      const rest = timeoutAt - deps.now();
      if (rest <= 0) {
        reason = "timeout";
        break;
      }
      await deps.sleep(Math.min(o.intervalSec * 1000, rest));
    }
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
  const waitedSec = Math.round((deps.now() - startedAt) / 1000);
  if (reason === "ok") {
    remove();
    return { code: 0, reason, waitedSec };
  }
  deps.err(WAIT_CUT_LINE(reason, o.label, waitedSec));
  // a cut the caller goes on from is no stop; one it fails on is left for the app, which tells the person and removes it
  if (o.onTimeout === "fail") write({ reason, at: deps.now() });
  else remove();
  return { code: o.onTimeout === "fail" ? WAIT_CUT_EXIT : 0, reason, waitedSec };
}
