// test-reads: ops-kit/bin/ ops-kit/src/cli.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_KILLED_LINE, IDLE_SECONDS_MAX, runIdle } from "./idle-run.ts";

const scratch = async (fn: (dir: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "idle-run-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};

// a killed process stays in the table until its parent (init, for an orphan) reaps it
const goneSoon = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 100 && !gone(pid); i++) await Bun.sleep(20);
  return gone(pid);
};

test("runIdle: a command with no output is cut, and the reason is the last line of its output", async () => {
  const r = await runIdle(["sleep", "600"], { idleSeconds: 1 });
  expect(r).toMatchObject({ idleKilled: true, code: 124 });
  expect(r.output.trimEnd().split("\n").at(-1)).toBe(IDLE_KILLED_LINE(1));
  expect(IDLE_KILLED_LINE(1)).toBe("無進捗で打ち切り: 1 秒出力がなかった");
});

test("runIdle: output keeps a command alive past the threshold, on either stream", async () => {
  const r = await runIdle(["bash", "-c", 'for i in 1 2 3 4 5; do if [ $((i % 2)) = 0 ]; then echo $i >&2; else echo $i; fi; sleep 1; done'], { idleSeconds: 2 });
  expect(r).toMatchObject({ idleKilled: false, code: 0 });
  expect(r.output.trim().split("\n")).toEqual(["1", "2", "3", "4", "5"]);
}, 10_000);

test("runIdle: a cut leaves no grandchild behind", async () => {
  await scratch(async (dir) => {
    const pidfile = join(dir, "pid");
    const r = await runIdle(["bash", "-c", `sleep 600 & echo $! > ${pidfile}; wait`], { idleSeconds: 1 });
    expect(r.idleKilled).toBe(true);
    expect(await goneSoon(Number(readFileSync(pidfile, "utf8")))).toBe(true);
  });
});

test("runIdle: a grandchild holding the pipes after its parent exited does not hold the run, and does not outlive it", async () => {
  await scratch(async (dir) => {
    const pidfile = join(dir, "pid");
    const started = Date.now();
    const r = await runIdle(["bash", "-c", `sleep 600 & echo $! > ${pidfile}; exit 3`], { idleSeconds: 30 });
    expect(r).toMatchObject({ idleKilled: false, code: 3 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await goneSoon(Number(readFileSync(pidfile, "utf8")))).toBe(true);
  });
});

test("runIdle: a command that ignores SIGTERM is killed", async () => {
  const r = await runIdle(["bash", "-c", "trap '' TERM; sleep 600 & wait; sleep 600"], { idleSeconds: 1 });
  expect(r).toMatchObject({ idleKilled: true, code: 124 });
});

test("runIdle: a process that left the group and holds the pipes does not hold the run, and its later output is not delivered", async () => {
  await scratch(async (dir) => {
    const pidfile = join(dir, "pid");
    const seen: string[] = [];
    const r = await runIdle(["bash", "-c", `setsid bash -c 'echo $$ > ${pidfile}; sleep 3; echo late; sleep 600' & sleep 0.2`], { idleSeconds: 30, onData: (c) => seen.push(c) });
    try {
      expect(r).toMatchObject({ idleKilled: false, code: 0 });
      await Bun.sleep(1_500);
      expect(seen.join("")).not.toContain("late");
    } finally {
      process.kill(Number(readFileSync(pidfile, "utf8")), "SIGKILL");
    }
  });
});

test("runIdle: onData gets each chunk with its stream, and an exit code passes through", async () => {
  const seen: string[] = [];
  const r = await runIdle(["bash", "-c", "echo out; echo err >&2; exit 7"], { idleSeconds: 5, onData: (c, stream) => seen.push(`${stream}:${c.trim()}`) });
  expect(r).toMatchObject({ idleKilled: false, code: 7 });
  expect(seen.sort()).toEqual(["stderr:err", "stdout:out"]);
});

test("runIdle: cwd and env reach the command", async () => {
  await scratch(async (dir) => {
    const r = await runIdle(["bash", "-c", "pwd; echo $IDLE_RUN_TEST"], { idleSeconds: 5, cwd: dir, env: { PATH: process.env.PATH!, IDLE_RUN_TEST: "yes" } });
    expect(r.output).toContain(dir.split("/").at(-1)!);
    expect(r.output).toContain("yes");
  });
});

test("ops-kit idle-run: exit 124 with the reason on stderr; an exit passes through; stdin and the streams stay apart", async () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", CLI, "idle-run", ...args], { stdin: new TextEncoder().encode("from stdin\n"), stdout: "pipe", stderr: "pipe" });
  const cut = run("--idle", "1", "--", "sleep", "600");
  expect(cut.exitCode).toBe(124);
  expect(cut.stderr.toString()).toContain(IDLE_KILLED_LINE(1));
  expect(run("--idle", "1", "--", "true").exitCode).toBe(0);
  expect(run("--idle", "1", "--", "bash", "-c", "exit 5").exitCode).toBe(5);
  const streams = run("--idle", "5", "bash", "-c", "cat; echo err >&2");
  expect(streams.stdout.toString()).toBe("from stdin\n");
  expect(streams.stderr.toString()).toBe("err\n");
  expect(run("--idle", "0", "--", "true").exitCode).toBe(2);
  expect(run("--idle", "1", "--").exitCode).toBe(2);
  expect(run("--idle", String(IDLE_SECONDS_MAX + 1), "--", "true").exitCode).toBe(2);
  expect(run("--idle", "1", "--", "no-such-command-idle-run").exitCode).toBe(127);
});

const CLI = join(import.meta.dir, "../bin/ops-kit");

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`ops-kit idle-run: ${signal} to the wrapper takes the command and its children with it`, async () => {
    await scratch(async (dir) => {
      const pidfile = join(dir, "pid");
      const p = Bun.spawn(["bun", CLI, "idle-run", "--idle", "60", "--", "bash", "-c", `sleep 600 & echo "$$ $!" > ${pidfile}; wait`], { stdout: "ignore", stderr: "ignore" });
      while (!existsSync(pidfile) || !readFileSync(pidfile, "utf8").trim().includes(" ")) await Bun.sleep(50);
      p.kill(signal);
      await p.exited;
      for (const pid of readFileSync(pidfile, "utf8").trim().split(" ")) expect(await goneSoon(Number(pid))).toBe(true);
    });
  });
}

test("runIdle: an interrupted run ends the caller too, so it never reports the command as failed", async () => {
  await scratch(async (dir) => {
    const pidfile = join(dir, "pid");
    const script = join(dir, "caller.ts");
    await Bun.write(script, `import { runIdle } from ${JSON.stringify(join(import.meta.dir, "idle-run.ts"))};\nawait runIdle(["bash", "-c", "echo $$ > ${pidfile}; sleep 600"], { idleSeconds: 60 });\nconsole.log("returned");\n`);
    const p = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "ignore" });
    while (!existsSync(pidfile) || !readFileSync(pidfile, "utf8").trim()) await Bun.sleep(50);
    p.kill("SIGTERM");
    await p.exited;
    expect(p.signalCode).toBe("SIGTERM");
    expect(await new Response(p.stdout).text()).toBe("");
  });
});

test("ops-kit idle-run: a command that ignores the forwarded signal is killed all the same", async () => {
  await scratch(async (dir) => {
    const pidfile = join(dir, "pid");
    const p = Bun.spawn(["bun", CLI, "idle-run", "--idle", "60", "--", "bash", "-c", `trap '' TERM; echo $$ > ${pidfile}; sleep 600 & wait; sleep 600`], { stdout: "ignore", stderr: "ignore" });
    while (!existsSync(pidfile) || !readFileSync(pidfile, "utf8").trim()) await Bun.sleep(50);
    p.kill("SIGTERM");
    await p.exited;
    expect(await goneSoon(Number(readFileSync(pidfile, "utf8")))).toBe(true);
  });
});
