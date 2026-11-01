export const IDLE_KILLED_LINE = (sec: number) => `無進捗で打ち切り: ${sec} 秒出力がなかった`;

const SIGKILL_AFTER_MS = 2_000;
const DRAIN_AFTER_EXIT_MS = 2_000;
/** The largest delay a timer takes: above it `setTimeout` fires at once. */
export const IDLE_SECONDS_MAX = Math.floor((2 ** 31 - 1) / 1000);
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Runs a command in its own process group, cut when neither stdout nor stderr has given anything for `idleSeconds`.
 * There is no limit on the total time: a long run that keeps talking is not stuck. The group is killed at the end
 * in every case, so nothing the command started outlives it (a grandchild holding the pipes would otherwise hold the run too).
 * A signal to this process stops the command and then this process, as it would have without the handlers: an interrupted
 * run is not a result, and a caller must not go on to report it as a failed command.
 */
export async function runIdle(
  cmd: string[],
  o: { idleSeconds: number; cwd?: string; env?: Record<string, string>; stdin?: "inherit" | "ignore"; onData?: (chunk: string, stream: "stdout" | "stderr") => void },
): Promise<{ code: number; output: string; idleKilled: boolean }> {
  const proc = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, detached: true, stdin: o.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  };
  let output = "";
  let idleKilled = false;
  let finished = false;
  let interrupted: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    killGroup(signal);
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), SIGKILL_AFTER_MS);
  };
  const forward = (signal: NodeJS.Signals) => {
    interrupted = signal;
    stop(signal);
  };
  const idleTimer = setTimeout(() => {
    idleKilled = true;
    stop("SIGTERM");
  }, o.idleSeconds * 1000);
  const read = async (from: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    for await (const bytes of from) {
      if (finished) return;
      if (!idleKilled) idleTimer.refresh();
      const chunk = decoder.decode(bytes, { stream: true });
      output += chunk;
      o.onData?.(chunk, stream);
    }
  };
  const reading = Promise.all([read(proc.stdout, "stdout"), read(proc.stderr, "stderr")]);
  // the group is outside this process's: a signal to the wrapper (a Bash timeout, a stopped Task) has to be passed on
  for (const signal of FORWARDED) process.on(signal, forward);
  const exitCode = await proc.exited;
  clearTimeout(idleTimer);
  clearTimeout(killTimer);
  for (const signal of FORWARDED) process.off(signal, forward);
  killGroup("SIGKILL");
  if (interrupted) {
    process.kill(process.pid, interrupted);
    await new Promise(() => {}); // the signal's default action ends this process
  }
  // a process that left the group with setsid can still hold the pipes
  await Promise.race([reading, Bun.sleep(DRAIN_AFTER_EXIT_MS)]);
  finished = true;
  if (!idleKilled) return { code: exitCode, output, idleKilled };
  const line = IDLE_KILLED_LINE(o.idleSeconds);
  return { code: 124, output: `${output}${output && !output.endsWith("\n") ? "\n" : ""}${line}\n`, idleKilled };
}
