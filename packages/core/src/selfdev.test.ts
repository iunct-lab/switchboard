import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { CHECK_CHILD_ENV, checkEnv, checksEnabledByDefault, RESTART_EXIT_CODE, restartArgv, runCheck, SelfDev, shutdownOnce, spawnDetached, summarize } from "./selfdev.ts";

let repo: string;
let db: Db;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "sb-selfdev-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fake", scripts: { typecheck: "echo typecheck-ok" } }));
  writeFileSync(join(repo, "ok.test.ts"), 'import { test, expect } from "bun:test"; test("a", () => expect(1).toBe(1));');
  db = new Db(join(repo, "db.sqlite"));
});
afterAll(() => {
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("self-dev checks (#18)", () => {
  test("summarize reads bun test counts and typecheck outcomes", () => {
    expect(summarize("test", " 41 pass\n 0 fail\n", 0)).toBe("41 pass, 0 fail");
    expect(summarize("test", " 40 pass\n 1 fail\n", 1)).toBe("40 pass, 1 fail");
    expect(summarize("typecheck", "", 0)).toBe("typecheck ok");
    expect(summarize("typecheck", "src/a.ts(1,1): error TS2304: x\nsrc/b.ts(2,2): error TS2304: y", 2)).toBe("2 type errors");
    expect(summarize("test", "boom", 3)).toBe("exit 3");
  });

  test("checks are off by default inside bun test and inside a check child; the child marker is set for subprocesses", () => {
    expect(checksEnabledByDefault({ NODE_ENV: "test" })).toBe(false);
    expect(checksEnabledByDefault({ [CHECK_CHILD_ENV]: "1" })).toBe(false);
    expect(checksEnabledByDefault({})).toBe(true);
    const env = checkEnv({ PATH: "/bin", SWITCHBOARD_HOME: "/x", CLAUDECODE: "1", CLAUDE_CODE_X: "y" });
    expect(env).toEqual({ PATH: "/bin", FORCE_COLOR: "0", NO_COLOR: "1", [CHECK_CHILD_ENV]: "1" });
  });

  test("runCheck runs a command in the repo with a clean environment, keeps only the output tail, and can be cancelled", async () => {
    process.env.SWITCHBOARD_TEST_SECRET = "leak";
    const r = await runCheck(repo, "typecheck", ["sh", "-c", "echo typecheck-ok; test -z \"$SWITCHBOARD_TEST_SECRET\""]);
    delete process.env.SWITCHBOARD_TEST_SECRET;
    expect(r).toMatchObject({ kind: "typecheck", ok: true, exitCode: 0, summary: "typecheck ok" });
    expect(r.output).toContain("typecheck-ok");
    const t = await runCheck(repo, "test", ["bun", "test", "ok.test.ts"]);
    expect(t.ok).toBe(true);
    expect(t.summary).toBe("1 pass, 0 fail");
    const bad = await runCheck(repo, "test", ["sh", "-c", "echo ' 0 pass'; echo ' 1 fail'; exit 1"]);
    expect(bad).toMatchObject({ ok: false, summary: "0 pass, 1 fail" });
    const big = await runCheck(repo, "test", ["sh", "-c", "yes x | head -c 200000"]);
    expect(big.output.length).toBeLessThanOrEqual(20_000);
    const ac = new AbortController();
    const slow = runCheck(repo, "test", ["sleep", "30"], ac.signal);
    setTimeout(() => ac.abort(), 100);
    expect(await slow).toMatchObject({ ok: false, summary: "cancelled" });
  });

  test("SelfDev stores the last run per task, queues a rerun instead of returning a stale one, invalidates on tree change, cancels", async () => {
    const seen: string[] = [];
    const sd = new SelfDev(db, repo, (id, run) => seen.push(`${id}:${run.ok}`));
    const { CHECKS } = await import("./selfdev.ts");
    const saved = CHECKS.splice(0, CHECKS.length, { kind: "typecheck", argv: ["sh", "-c", "sleep 0.2; echo ok"] });
    try {
      const p1 = sd.run("t1");
      const p2 = sd.run("t1"); // while in flight → one more run after the first
      expect(sd.isRunning("t1")).toBe(true);
      expect(await p1).toBe(await p2);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen).toEqual(["t1:true", "t1:true"]); // both runs happened
      expect(sd.last("t1")?.results[0]?.summary).toBe("typecheck ok");
      expect(sd.isCurrent(sd.last("t1"))).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      sd.invalidate();
      expect(sd.isCurrent(sd.last("t1"))).toBe(false);
      expect(sd.last("nope")).toBeNull();
      CHECKS.splice(0, CHECKS.length, { kind: "test", argv: ["sleep", "30"] });
      const p3 = sd.run("t2");
      await new Promise((r) => setTimeout(r, 100));
      sd.cancelAll();
      expect((await p3).ok).toBe(false);
    } finally {
      CHECKS.splice(0, CHECKS.length, ...saved);
    }
  });

  test("restartArgv re-executes the same runtime with its flags and entry", () => {
    const argv = restartArgv();
    expect(argv[0]).toBe(process.execPath);
    expect(argv.slice(1, 1 + process.execArgv.length)).toEqual(process.execArgv);
    expect(argv[1 + process.execArgv.length]).toBe(process.argv[1]);
  });

  test("a real daemon exits with the restart code when supervised (dev.ts respawns it)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-restart-"));
    const port = 47000 + Math.floor(Math.random() * 500);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: { ...checkEnv(), SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: String(port), SWITCHBOARD_SUPERVISED: "1", [CHECK_CHILD_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) break;
        } catch {
          /* booting */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const r = await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) });
      expect(r.status).toBe(202);
      expect(((await r.json()) as { supervised: boolean }).supervised).toBe(true);
      const code = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), 15_000))]);
      expect(code).toBe(RESTART_EXIT_CODE);
    } finally {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("daemon shutdown (#1136)", () => {
  test("stop runs once, then exit(0); a crash exits 1; a stop that never returns is cut off; two calls stop once", async () => {
    const quiet = console.log;
    const err = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      const exits: number[] = [];
      let stops = 0;
      const down = shutdownOnce(async () => void stops++, (c) => void exits.push(c));
      await Promise.all([down(0), down(0)]);
      expect({ stops, exits }).toEqual({ stops: 1, exits: [0] });

      const crashed: number[] = [];
      await shutdownOnce(async () => undefined, (c) => void crashed.push(c))(1, new Error("boom"));
      expect(crashed).toEqual([1]);

      const stuck: number[] = [];
      const t0 = Date.now();
      await shutdownOnce(() => new Promise<void>(() => undefined), (c) => void stuck.push(c), 100)(0);
      expect(stuck).toEqual([0]);
      expect(Date.now() - t0).toBeLessThan(2000);

      const failed: number[] = [];
      await shutdownOnce(async () => Promise.reject(new Error("stop failed")), (c) => void failed.push(c))(0);
      expect(failed).toEqual([0]);
    } finally {
      console.log = quiet;
      console.error = err;
    }
  });
});

// The daemon takes the idle stop command out of its own environment (server.ts); a replacement it starts itself (not
// under sb-rescue) gets it back, or the restarted daemon would never stop the host.
test("spawnDetached puts back what the daemon kept out of its environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "sb-detached-"));
  try {
    const out = join(home, "out");
    spawnDetached(["/bin/sh", "-c", `printf %s "$SWITCHBOARD_IDLE_STOP_CMD" > '${out}.tmp' && mv '${out}.tmp' '${out}'`], home, home, { SWITCHBOARD_IDLE_STOP_CMD: "/bin/false" });
    for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(50);
    expect(readFileSync(out, "utf8")).toBe("/bin/false");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
