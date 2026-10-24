import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `bun main.ts` listening off loopback (the cloud host, #181): /api/health tells an unauthorized caller only whether a
// token is needed, so the startup banner must ask with the token. It crashed on `health.runners` on the first deploy (#232).
test("main.ts starts off loopback and prints its runners (it reads its own health with the token)", async () => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-test-main-"));
  const p = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_SUPERVISED: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let out = "";
    const reader = p.stdout.getReader();
    const deadline = Date.now() + 20_000;
    // one read in flight at a time: a read left behind by the 500 ms tick still gets its chunk, so no output is lost (#387)
    let pending = reader.read();
    while (!/runner dak/.test(out) && Date.now() < deadline) {
      const r = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
      if (!r) continue;
      if (r.done) break;
      out += new TextDecoder().decode(r.value);
      pending = reader.read();
    }
    expect(out).toContain("switchboard core  http://0.0.0.0:");
    expect(out).toMatch(/runner (claude|codex|dak)/);
    expect(p.exitCode).toBeNull(); // still running
  } finally {
    p.kill();
    await p.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

// #1136: the runners lead their own process groups, so stopping the daemon takes what a runner left behind with it.
test("SIGTERM takes the runners' children with the daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-test-main-"));
  const bin = join(home, "bin");
  const dir = join(home, "pids");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bin);
  mkdirSync(dir);
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nif [ "$1" = "auth" ]; then exit 0; fi\necho $$ > "${dir}/self.pid"\nsleep 300 &\necho $! > "${dir}/child.pid"\ncat > /dev/null\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidOf = (f: string) => {
    try {
      return Number(readFileSync(join(dir, f), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  const p = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWITCHBOARD_HOST: "127.0.0.1", SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_SUPERVISED: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let out = "";
    const reader = p.stdout.getReader();
    const deadline = Date.now() + 20_000;
    let pending = reader.read();
    while (!/runner dak/.test(out) && Date.now() < deadline) {
      const r = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
      if (!r) continue;
      if (r.done) break;
      out += new TextDecoder().decode(r.value);
      pending = reader.read();
    }
    const port = /switchboard core  http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    expect(port).toBeDefined();
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "pg", prompt: "hi", runner: "claude" }) });
    expect(res.status).toBeLessThan(300);
    const t0 = Date.now();
    while ((!pidOf("child.pid") || !pidOf("self.pid")) && Date.now() - t0 < 10_000) await Bun.sleep(50);
    const self = pidOf("self.pid");
    const child = pidOf("child.pid");
    expect(self).toBeGreaterThan(0);
    expect(alive(child)).toBe(true);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const t1 = Date.now();
    while ((alive(self) || alive(child)) && Date.now() - t1 < 5000) await Bun.sleep(20);
    expect(alive(self)).toBe(false);
    expect(alive(child)).toBe(false);
  } finally {
    p.kill();
    await p.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);
