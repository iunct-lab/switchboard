// test-reads: packages/core/src/main.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, needsMigration } from "./db.ts";

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
    while (!/runner codex/.test(out) && Date.now() < deadline) {
      const r = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
      if (!r) continue;
      if (r.done) break;
      out += new TextDecoder().decode(r.value);
      pending = reader.read();
    }
    expect(out).toContain("switchboard core  http://0.0.0.0:");
    expect(out).toMatch(/runner (claude|codex)/);
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
    while (!/runner codex/.test(out) && Date.now() < deadline) {
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

// #2558: DAK is opt-in. The URL that points at it is also the switch that registers it.
type HealthRunner = { id: string; label?: string; available: boolean; note?: string };
async function bootAndRead(extraEnv: Record<string, string>, seed?: (home: string) => void, check?: (home: string) => void): Promise<{ out: string; runners: string[]; info: HealthRunner[] }> {
  const home = mkdtempSync(join(tmpdir(), "switchboard-test-main-"));
  seed?.(home);
  const env: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "127.0.0.1", SWITCHBOARD_PORT: "0", SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_SUPERVISED: "" };
  delete env.SWITCHBOARD_DAK_URL;
  const p = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], { env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  try {
    let out = "";
    const reader = p.stdout.getReader();
    const deadline = Date.now() + 20_000;
    let pending = reader.read();
    let seenCodexAt = 0;
    // the banner lists the runners in order (claude, codex, dak); give a dak line a moment to follow the codex one
    while ((!seenCodexAt || Date.now() - seenCodexAt < 1500) && Date.now() < deadline) {
      const r = await Promise.race([pending, Bun.sleep(300).then(() => null)]);
      if (!r) continue;
      if (r.done) break;
      out += new TextDecoder().decode(r.value);
      pending = reader.read();
      if (!seenCodexAt && /runner codex/.test(out)) seenCodexAt = Date.now();
    }
    const port = /switchboard core  http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    expect(port).toBeDefined();
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { runners: HealthRunner[] };
    check?.(home);
    return { out, runners: health.runners.map((r) => r.id), info: health.runners };
  } finally {
    p.kill();
    await p.exited;
    rmSync(home, { recursive: true, force: true });
  }
}

test("main.ts lists no DAK runner unless SWITCHBOARD_DAK_URL is set", async () => {
  const { out, runners } = await bootAndRead({});
  expect(out).toMatch(/runner claude/);
  expect(out).not.toMatch(/runner dak/);
  expect(runners).not.toContain("dak");
  expect(runners.every((r) => r === "claude" || r === "codex")).toBe(true);
}, 40_000);

// A promotion candidate runs on a throwaway copy in a tmpfs home: the migration runs, the copy before it is not taken.
test("main.ts as a candidate migrates an older database without taking the snapshot before it", async () => {
  const dbPath = (home: string) => join(home, "switchboard.db");
  await bootAndRead({}, (home) => {
    new Db(dbPath(home)).close();
    const raw = new Database(dbPath(home));
    raw.exec("ALTER TABLE tasks DROP COLUMN background");
    raw.close();
    expect(needsMigration(dbPath(home))).toBe(true); // the precondition: this DB needs a migration (else the test proves nothing)
  }, (home) => {
    expect(existsSync(join(home, "snapshots"))).toBe(false);
    expect(needsMigration(dbPath(home))).toBe(false);
  });
}, 40_000);

test("main.ts lists DAK when SWITCHBOARD_DAK_URL is set", async () => {
  const { out, runners } = await bootAndRead({ SWITCHBOARD_DAK_URL: "http://127.0.0.1:1" });
  expect(out).toMatch(/runner dak\s+unavailable/);
  expect(runners).toContain("dak");
}, 40_000);

// #3386: the ADK servers saved in Settings are read at start and run as `custom:<name>` with their label, next to the
// DAK of SWITCHBOARD_DAK_URL; a server that does not answer is listed as unavailable with the reason.
test("main.ts registers the saved ADK servers as custom:<name> and DAK from SWITCHBOARD_DAK_URL", async () => {
  const adk = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/list-apps" ? Response.json(["x_app", "dak_agent"]) : new Response("no", { status: 404 })) });
  try {
    const base = `http://127.0.0.1:${adk.port}`;
    const { info } = await bootAndRead({ SWITCHBOARD_DAK_URL: base }, (home) => {
      const db = new Db(join(home, "switchboard.db"));
      db.setCustomRunners([
        { port: "adk", name: "x", label: "Agent X", url: base, app: "x_app" },
        { port: "adk", name: "gone", label: "Gone", url: "http://127.0.0.1:1", app: "y" },
        { port: "agui", name: "ag", label: "AG agent", url: `${base}/agui`, sendWorkspaceMcp: false },
        { port: "adk", name: "dak", label: "Saved DAK", url: base, app: "dak_agent" },
      ]);
      db.close();
    });
    const by = (id: string) => info.find((r) => r.id === id);
    expect(by("custom:x")).toMatchObject({ label: "Agent X", available: true });
    expect(by("custom:ag")).toMatchObject({ label: "AG agent", available: true }); // AG-UI: any HTTP answer is reachable
    expect(by("custom:gone")).toMatchObject({ label: "Gone", available: false });
    expect(by("custom:gone")?.note).toContain("not reachable");
    expect(by("dak")).toMatchObject({ label: "DAK", available: true });
    expect(by("custom:dak")).toBeUndefined(); // the variable is DAK's only record
  } finally {
    await adk.stop(true);
  }
}, 40_000);
