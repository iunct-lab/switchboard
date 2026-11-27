// test-reads: scripts/release-check.ts scripts/release-smoke.ts container/fake-releases.ts packages/core/src/main.ts
/**
 * The check of a public Release's install, promotions and rollback, with no process started: `run` and `spawn` are
 * recorded fakes, and sb-rescue and the daemon answer from a small model of the real behavior (a promotion makes a
 * release directory current; the cleaning removes the oldest ones once `keep` releases are newer than the first).
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeReleases } from "../container/fake-releases.ts";
import { bashOnce, checkRelease, checkResult, failureRequest, fakeSha, latestFromApi, notOlderThan, outcomeOf, outputLines, parseArgs, patchAfter, realRecordDeps, recordResult, resultLine, type CheckDeps, type CheckResult, type Ctx, type RecordDeps } from "./release-check.ts";
import { findSecrets, NO_HOST } from "../ops-kit/src/secrets.ts";
import { sync, type Run } from "../ops-kit/src/public-sync.ts";
import { gitlessPath } from "./release-smoke.ts";
import { placesOf } from "../packages/core/src/cli-update-install.ts";
import { CLAUDE_RELEASE_KEY_FINGERPRINT, realCliSourceDeps, type CliSourceDeps } from "../packages/core/src/cli-update-source.ts";
import { isTempDir, loadConfig } from "../packages/core/src/config.ts";
import { decidesNothing } from "../packages/core/src/machine.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, startServer } from "../packages/core/src/api-test-harness.ts";
import { appendHistory, currentOf, pruneReleases, run as rescueRun, switchTo } from "../rescue/src/releases.ts";

const root = mkdtempSync(join(tmpdir(), "sb-release-check-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = "a".repeat(40);

/** A PATH directory that has a gh in it: what a check that forgot to leave gh out would run with. */
function withGh(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), "#!/bin/sh\n");
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

/** The PATH the check is started from: it has a git and a gh, so that leaving them out of the daemon's PATH is the check's own doing. */
const sourcePath = (() => {
  const dir = join(root, "source-bin");
  mkdirSync(dir, { recursive: true });
  for (const name of ["git", "gh"]) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:${process.env.PATH}`;
})();

/** `cleansAfter`: the promotion after which the first release is removed (null = the cleaning never runs). */
function deps(over: { cleansAfter?: number | null; gitless?: boolean; promoteStatus?: number; login?: string; models?: string[]; refuseAfterPrune?: boolean; silent?: boolean; limit?: boolean } = {}) {
  const cleansAfter = over.cleansAfter === undefined ? 2 : over.cleansAfter;
  const ran: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const spawned: Array<{ env: Record<string, string>; killed: boolean }> = [];
  const events: string[] = [];
  const homes: string[] = [];
  let current = "";
  let previous: string | null = null;
  let promotions = 0;
  let home = "";
  // the daemon's Tasks: id -> events (seq, ev). A turn is a Bash call, its result and the end of the turn.
  const tasks = new Map<string, Array<{ seq: number; ev: Record<string, unknown> }>>();
  const taskCalls: string[] = [];
  const turn = (id: string) => {
    const evs = tasks.get(id)!;
    if (over.silent) return;
    const prunedNow = over.refuseAfterPrune === true && !existsSync(join(home, "releases", sha)) && current !== previous;
    const n = evs.length;
    evs.push({ seq: n + 1, ev: { t: "tool.call", id: `c${n}`, name: "Bash", summary: "pwd" } });
    evs.push({ seq: n + 2, ev: { t: "tool.result", id: `c${n}`, ok: !prunedNow, summary: prunedNow ? "hook blocked: PreToolUse" : "/tmp" } });
    evs.push({ seq: n + 3, ev: { t: "session.end", status: "ok", turn: `u${n}` } });
  };
  const bodyOf = async (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}")) as { commit?: string; expectSha?: string; model?: string; seq?: number };
  const d: CheckDeps = {
    fetch: async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (url.startsWith("https://api.github.com/")) {
        if (path.includes("/commits/")) return Response.json({ sha });
        return new Response("tarball");
      }
      if (path === "/api/health") return Response.json({ ok: true, runners: [{ id: "claude", available: true, login: over.login ?? "ok", models: (over.models ?? ["claude-sonnet-x", "claude-haiku-x", "claude-haiku-y"]).map((value) => ({ value })) }] });
      const t = /^\/api\/tasks\/([^/?]+)(\/[a-z]+)?(?:\?after=(\d+))?$/.exec(path);
      if (path === "/api/tasks" && init?.method === "POST") {
        const b = await bodyOf(init) as { model?: string; cwd?: string };
        taskCalls.push(`start ${b.model}`);
        tasks.set("t1", []);
        turn("t1");
        return Response.json({ id: "t1", resumeReason: over.limit ? "start" : null }, { status: 201 });
      }
      if (t && !t[2]) {
        const evs = (tasks.get(t[1]!) ?? []).filter((e) => e.seq > Number(t[3] ?? 0));
        return Response.json({ task: { status: over.silent ? "running" : "idle", resumeAt: null }, events: evs });
      }
      if (t && t[2] === "/resume") {
        taskCalls.push("resume");
        turn(t[1]!);
        return Response.json({ id: t[1] });
      }
      if (t && t[2] === "/fork") {
        const b = await bodyOf(init) as { seq?: number };
        taskCalls.push(`fork ${b.seq}`);
        tasks.set("t2", []);
        return Response.json({ id: "t2" }, { status: 201 });
      }
      if (t && t[2] === "/send") {
        taskCalls.push(`send ${t[1]}`);
        turn(t[1]!);
        return Response.json({ id: t[1] });
      }
      if (path === "/api/status") return Response.json({ current, previous, busy: null, lastError: null, unhealthy: null, history: [] });
      if (path === "/api/promote") {
        if (over.promoteStatus) return new Response("no", { status: over.promoteStatus });
        const b = await bodyOf(init);
        events.push(`promote ${b.commit} ${b.expectSha}`);
        promotions++;
        previous = current;
        current = b.expectSha!;
        mkdirSync(join(home, "releases", current), { recursive: true });
        if (cleansAfter !== null && promotions >= cleansAfter) rmSync(join(home, "releases", sha), { recursive: true, force: true });
        return Response.json({ started: "promote" }, { status: 202 });
      }
      if (path === "/api/rollback") {
        events.push("rollback");
        [current, previous] = [previous!, current];
        return Response.json({ started: "rollback" }, { status: 202 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    run: async (argv, o) => {
      ran.push({ argv, env: o.env });
      if (argv[1] === "rescue/install.ts") {
        home = o.env.SWITCHBOARD_HOME!;
        mkdirSync(join(home, "releases", sha), { recursive: true });
        current = sha;
        events.push("install");
      }
      return { code: 0, output: "" };
    },
    spawn: (_argv, o) => {
      const p = { env: o.env, killed: false };
      spawned.push(p);
      return { kill: async () => void (p.killed = true), exited: new Promise<number | null>(() => undefined) };
    },
    tmp: () => {
      const dir = mkdtempSync(join(root, "run-"));
      homes.push(dir);
      return dir;
    },
    remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    gitlessPath: (dir, without) => (over.gitless === false ? withGh(dir) : gitlessPath(dir, sourcePath, without)),
    which: (command, path) => Bun.which(command, { PATH: path }),
    freePort: (() => {
      let next = 6001;
      return async () => next++;
    })(),
    sleep: async () => undefined,
    bun: "/bin/bun",
    startReleases: (o) => {
      const f = startFakeReleases(o);
      return { url: f.url, setLatest: f.setLatest, stop: () => void f.stop() };
    },
    userHome: "/home/the-user",
  };
  return { d, ran, spawned, events, homes, taskCalls };
}

test("the steps run in order and the last line is the result", async () => {
  const { d, events, spawned, homes, taskCalls } = deps({ cleansAfter: 2 });
  const log: string[] = [];
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n", log: (l) => log.push(l) }, d);
  expect(r.reason).toBeNull();
  expect(events).toEqual(["install", `promote v1.2.4 ${fakeSha(1)}`, `promote v1.2.5 ${fakeSha(2)}`, "rollback"]);
  expect(r.steps.map((s) => s.split(":")[0])).toEqual(["fetched o/n v1.2.3 (aaaaaaa)", "serving it as Latest from a fake Releases API", "tarball unpacked", "install", "a Claude Task is started and gets a Bash through", "promote the same tarball under the next tag until the first release is cleaned away", "cleaning", "the Task is resumed after the cleaning and gets a Bash through", "the Task is forked after the cleaning and the fork gets a Bash through", "rollback to the previous release", "the Task is resumed after the rollback and gets a Bash through"]);
  // the cheap model is the first with haiku in its value; the fork is made from the turn that ended ok (the resume's: seq 6) and then sent to
  expect(taskCalls).toEqual(["start claude-haiku-x", "resume", "fork 6", "send t2", "resume"]);
  expect(log.every((l) => l.startsWith("✓ "))).toBe(true);
  expect(resultLine(r)).toBe(`[release-check] pass v1.2.3 ${sha}`);
  expect(spawned.map((s) => s.killed)).toEqual([true]);
  expect(existsSync(homes[0]!)).toBe(false);
});

test("a release left after the cap of promotions is a fail", async () => {
  const { d, events, spawned } = deps({ cleansAfter: null });
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n", maxPromotions: 3 }, d);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("片付けが走らなかった");
  expect(r.reason).toContain("3 promotions later");
  expect(events.filter((e) => e.startsWith("promote"))).toHaveLength(3);
  expect(events).not.toContain("rollback");
  expect(resultLine(r)).toBe(`[release-check] fail v1.2.3 ${sha}`);
  expect(spawned.map((s) => s.killed)).toEqual([true]);
});

test("a promotion that sb-rescue refuses is a fail naming the answer", async () => {
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, deps({ promoteStatus: 409 }).d);
  expect([r.ok, r.reason, r.detail]).toEqual([false, "promotion 1 to v1.2.4: /api/promote answered 409", "no"]);
});

test("the daemon of the check gets no git, no gh, no GitHub token and its own home", async () => {
  const saved = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  process.env.GH_TOKEN = "x";
  process.env.GITHUB_TOKEN = "y";
  try {
    const { d, ran, spawned, homes } = deps();
    await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
    const envs = [...ran.map((x) => x.env), ...spawned.map((s) => s.env)];
    expect(envs.length).toBeGreaterThan(3);
    for (const env of envs) {
      expect(Bun.which("git", { PATH: env.PATH })).toBeNull();
      expect(Bun.which("gh", { PATH: env.PATH })).toBeNull();
      expect(Object.keys(env).filter((k) => /TOKEN/.test(k))).toEqual([]);
      expect(env.HOME).toBe("/home/the-user");
      expect(env.SWITCHBOARD_CANDIDATE).toBe("1");
      expect(env.SWITCHBOARD_HOME!.startsWith(homes[0]!)).toBe(true);
    }
    expect(spawned[0]!.env.SWITCHBOARD_PORT).toBe("6001");
  } finally {
    for (const [k, v] of [["GH_TOKEN", saved[0]], ["GITHUB_TOKEN", saved[1]]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("a PATH that still has gh stops the check before anything is installed", async () => {
  const { d, ran } = deps({ gitless: false });
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/^the PATH of the check still has gh /);
  expect(ran).toEqual([]);
});

test("the tags after the public one, the made-up commits, and the command line", () => {
  expect(patchAfter("v0.59.0", 2)).toBe("v0.59.2");
  expect(fakeSha(1)).toMatch(/^[0-9a-f]{40}$/);
  expect(fakeSha(1)).not.toBe(fakeSha(2));
  expect(parseArgs(["v1.2.3"])).toEqual({ tag: "v1.2.3" });
  expect(parseArgs(["v1.2.3", "--wait-ms", "5000"])).toEqual({ tag: "v1.2.3", waitMs: 5000 });
  for (const bad of [[], ["main"], ["v1.2.3", "x"], ["1.2.3"], ["v1.2.3", "--wait-ms"], ["v1.2.3", "--wait-ms", "0"], ["v1.2.3", "--wait-ms", "x"]]) expect(parseArgs(bad)).toBeNull();
});

/** The environment checkRelease hands to sb-rescue (the install is a fake that fails right after it is recorded). */
async function envOfCheck(userHome: string): Promise<Record<string, string>> {
  let seen: Record<string, string> = {};
  const d: CheckDeps = {
    fetch: async (url) => (url.includes("/commits/") ? Response.json({ sha: "a".repeat(40) }) : new Response("tarball")),
    run: async (argv, o) => {
      if (argv[1] === "rescue/install.ts") {
        seen = o.env;
        return { code: 1, output: "stop here" };
      }
      return { code: 0, output: "" };
    },
    spawn: () => ({ kill: async () => undefined, exited: new Promise(() => undefined) }),
    tmp: () => mkdtempSync(join(root, "run-")),
    remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    gitlessPath: (dir) => dir,
    which: () => null,
    freePort: async () => 1,
    sleep: async () => undefined,
    bun: "bun",
    startReleases: () => ({ url: "http://127.0.0.1:1", setLatest: () => true, stop: () => undefined }),
    userHome,
  };
  await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
  return seen;
}

test("the daemon the check starts leaves the user's installed CLI as it is", async () => {
  const userHome = join(root, "user-home");
  const target = "aarch64-unknown-linux-musl";
  const p = placesOf("claude", userHome, target);
  const content = (v: string) => `#!/bin/sh\necho "${v} (Claude Code)"\n`;
  mkdirSync(p.versions, { recursive: true });
  mkdirSync(join(p.link, ".."), { recursive: true });
  // 2.0.0 = what the user's own instance can roll back to, 2.1.0 = in use
  for (const v of ["2.0.0", "2.1.0"]) {
    writeFileSync(p.bin(v), content(v));
    chmodSync(p.bin(v), 0o755);
  }
  symlinkSync(p.dir("2.1.0"), p.link);

  const env = await envOfCheck(userHome);
  const cfg = loadConfig({
    ...env,
    SWITCHBOARD_HOME: join(root, "daemon-home"),
    SWITCHBOARD_PORT: "0",
    SWITCHBOARD_SUPERVISED: "1",
    SWITCHBOARD_RESCUE_URL: "http://127.0.0.1:1",
    ...NO_HISTORY,
  });

  const real = await realCliSourceDeps();
  const manifest = { version: "2.2.0", buildDate: new Date(Date.now() - 3_600_000).toISOString(), platforms: { "linux-arm64": { checksum: createHash("sha256").update(content("2.2.0")).digest("hex") } } };
  const source: CliSourceDeps = {
    ...real,
    target: () => ({ arch: "arm64", musl: false }),
    gpg: async (args) => ({
      code: 0,
      stderr: "",
      stdout: args.includes("--show-keys") ? `pub:\nfpr:::::::::${CLAUDE_RELEASE_KEY_FINGERPRINT}:\n` : `[GNUPG:] VALIDSIG x ${CLAUDE_RELEASE_KEY_FINGERPRINT}\n`,
    }),
    fetch: async (url) => {
      const u = new URL(url);
      if (u.hostname !== "downloads.claude.ai") return new Response("no", { status: 404 });
      if (u.pathname.endsWith("/latest")) return new Response("2.2.0");
      if (u.pathname.endsWith("/manifest.json")) return Response.json(manifest);
      if (u.pathname.endsWith("/linux-arm64/claude")) return new Response(content("2.2.0"));
      return new Response("signature or key");
    },
  };
  const core = await startServer(cfg, [fakeAdapter(SCRIPT)], {
    port: 0,
    selfdevChecks: false,
    dryRunRestart: true,
    gh: NO_GH,
    // `home` is what hostInstallDeps takes from homedir(), i.e. the HOME of the daemon's environment
    cliUpdate: { source, install: { home: env.HOME!, codexTarget: target, turn: async () => undefined }, checkMs: 40 },
  });
  try {
    await Bun.sleep(2000);
  } finally {
    await core.stop();
  }
  expect({ linked: readlinkSync(p.link).split("/").at(-1), rollbackFile: existsSync(p.bin("2.0.0")) }).toEqual({ linked: "2.1.0", rollbackFile: true });
}, 30_000);

const pruneHome = mkdtempSync(join(tmpdir(), "sb-release-check-prune-"));
afterAll(() => rmSync(pruneHome, { recursive: true, force: true }));
test("the first release is cleaned away by the 6th promotion (the install's history line counts until the 6th prune)", () => {
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const build = (s: string) => mkdirSync(join(pruneHome, "releases", s), { recursive: true });
  const first = sha(100);
  build(first);
  switchTo(pruneHome, first);
  appendHistory(pruneHome, { action: "install", from: null, to: first, ok: true, reason: "first release" });
  let removedAt: number | null = null;
  for (let n = 1; n <= 8 && removedAt === null; n++) {
    const from = currentOf(pruneHome);
    build(sha(n));
    switchTo(pruneHome, sha(n));
    // the order of rescue/src/promote.ts: prune, then the history line
    pruneReleases(pruneHome, [sha(n)]);
    appendHistory(pruneHome, { action: "promote", from, to: sha(n), ok: true, reason: "ok" });
    if (!existsSync(join(pruneHome, "releases", first))) removedAt = n;
  }
  expect(removedAt).toBe(6);
});

// not under an OS temp root (the daemon's own `isTempDir`): stands for `TMPDIR=<somewhere else>` of whoever runs the check. It lives in a git-ignored
// cache folder of the checkout (node_modules/), so the run leaves nothing untracked in the source tree.
const cacheRoot = join(import.meta.dir, "..", "node_modules", ".cache");
const canRunOutside = !isTempDir(resolve(cacheRoot));
if (!canRunOutside) console.warn(`skipped: the checkout is under an OS temp root (${resolve(cacheRoot)}), so no folder outside the OS temp roots can be made`);
const outside = canRunOutside ? (mkdirSync(cacheRoot, { recursive: true }), mkdtempSync(join(cacheRoot, "sb-release-check-"))) : "";
afterAll(() => outside && rmSync(outside, { recursive: true, force: true }));

const outsideTest = canRunOutside ? test : test.skip;

outsideTest("the check's daemon writes nothing of its own under the user's HOME when TMPDIR is not under /tmp", async () => {
  const userHome = join(outside, "user-home");
  const bin = join(outside, "empty-bin");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  let env: Record<string, string> = {};
  const d: CheckDeps = {
    fetch: async (url) => (url.includes("/commits/") ? Response.json({ sha: "a".repeat(40) }) : new Response("tarball")),
    run: async (argv, o) => {
      if (argv[1] === "rescue/install.ts") {
        env = o.env;
        return { code: 1, output: "stop here" };
      }
      return { code: 0, output: "" };
    },
    spawn: () => ({ kill: async () => undefined, exited: new Promise(() => undefined) }),
    tmp: () => mkdtempSync(join(outside, "run-")),
    remove: () => undefined,
    gitlessPath: () => bin,
    which: () => null,
    freePort: async () => 1,
    sleep: async () => undefined,
    bun: process.execPath,
    startReleases: () => ({ url: "http://127.0.0.1:1", setLatest: () => true, stop: () => undefined }),
    userHome,
  };
  await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
  expect(env.SWITCHBOARD_CANDIDATE).toBe("1");

  const main = resolve(import.meta.dir, "../packages/core/src/main.ts");
  const p = Bun.spawn([process.execPath, main], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...env, SWITCHBOARD_PORT: "0", SWITCHBOARD_SUPERVISED: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reader = p.stdout.getReader();
  const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
  try {
    while (!out.includes("meta workspace")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(timer);
    p.kill("SIGTERM");
    await p.exited;
  }
  expect(out).toContain("meta workspace");
  expect(existsSync(join(userHome, "Knowledge"))).toBe(false);
}, 90_000);

test("a Bash the hook refused after the prune is a fail", async () => {
  const { d, events, spawned } = deps({ refuseAfterPrune: true });
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
  expect(r.ok).toBe(false);
  expect(r.undecided ?? null).toBeNull();
  expect(r.reason).toBe("Bash after resume: a Bash was refused or failed");
  expect(r.detail).toContain("hook blocked");
  expect(events).not.toContain("rollback");
  expect(resultLine(r)).toBe(`[release-check] fail v1.2.3 ${sha}`);
  expect(spawned.map((s) => s.killed)).toEqual([true]);
});

test("a Task with no Bash result in time is a fail", async () => {
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n", taskMs: 30 }, deps({ silent: true }).d);
  expect([r.ok, r.undecided ?? null]).toEqual([false, null]);
  expect(r.reason).toContain("Bash after start: no Bash result within");
});

test("no runner login is no result", async () => {
  const { d, ran, taskCalls } = deps({ login: "expired" });
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, d);
  expect(r.ok).toBe(false);
  expect(r.undecided).toBe("Claude is not logged in");
  expect(taskCalls).toEqual([]);
  expect(ran.length).toBeGreaterThan(0);
});

test("a Task queued at a usage limit is no result", async () => {
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, deps({ limit: true }).d);
  expect(r.undecided).toContain("usage limit");
});

test("the model is --model, else the first haiku, else nothing is judged", async () => {
  const a = deps();
  await checkRelease({ tag: "v1.2.3", repo: "o/n", model: "m-given" }, a.d);
  expect(a.taskCalls[0]).toBe("start m-given");
  const none = await checkRelease({ tag: "v1.2.3", repo: "o/n" }, deps({ models: ["claude-sonnet-x"] }).d);
  expect(none.undecided).toContain("--model");
  expect(parseArgs(["v1.2.3", "--model", "m"])).toEqual({ tag: "v1.2.3", model: "m" });
  expect(parseArgs(["v1.2.3", "--model"])).toBeNull();
});

// A Claude turn that fails on the login ends with a `result` line: the adapter turns it into
// session.end(status: error, summary: <text>) and no `error` event.
for (const summary of ["Invalid API key · Please run /login", "OAuth token has expired. Please obtain a new token or refresh your existing token."]) {
  test(`a login failure in the turn's end is judged nothing: ${summary.slice(0, 20)}`, async () => {
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/health")) return Response.json({ ok: true, runners: [{ id: "claude", available: true, login: "ok", models: [{ value: "claude-haiku-x" }] }] });
      if (init?.method === "POST") return Response.json({ id: "t1", resumeReason: null }, { status: 201 });
      return Response.json({ task: { status: "error", resumeAt: null }, events: [{ seq: 1, ev: { t: "message.delta", role: "user", text: "x" } }, { seq: 2, ev: { t: "session.end", status: "error", summary } }] });
    };
    const c = { o: { taskMs: 100, pollMs: 1 }, deps: { fetch, sleep: async () => {} }, port: 1, taskId: null, model: null, taskCwd: join(root, "login-cwd") } as unknown as Ctx;
    const e = await bashOnce(c, "start").then(() => null, (x: Error) => x);
    expect(`${e?.constructor.name}: ${e?.message}`).toStartWith("Undecided:");
  });
}

test("the Task's events that cannot be read stop the check, they are not an empty Task", async () => {
  const posts: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/health")) return Response.json({ ok: true, runners: [{ id: "claude", available: true, login: "ok", models: [{ value: "claude-haiku-x" }] }] });
    if (init?.method === "POST") posts.push(url);
    return new Response("boom", { status: 500 });
  };
  const c = { o: { taskMs: 100, pollMs: 1 }, deps: { fetch, sleep: async () => {} }, port: 1, taskId: "t1", model: null } as unknown as Ctx;
  const e = await bashOnce(c, "resume").then(() => null, (x: Error) => x);
  expect(e?.message).toContain("answered 500");
  expect(posts).toEqual([]);
});

test("an undecided check exits 2 and prints no result line; a decided one prints it", () => {
  const base: CheckResult = { ok: false, tag: "v1.2.3", sha, steps: [], reason: null };
  const undecided = outcomeOf({ ...base, reason: "Claude is not logged in", undecided: "Claude is not logged in" });
  expect(undecided).toEqual({ lines: ["? could not judge: Claude is not logged in"], code: 2 });
  expect(undecided.lines.some((l) => l.startsWith("[release-check]"))).toBe(false);
  expect(outcomeOf({ ...base, reason: "x" })).toEqual({ lines: ["✗ x", `[release-check] fail v1.2.3 ${sha}`], code: 1 });
  expect(outcomeOf({ ...base, ok: true })).toEqual({ lines: [`[release-check] pass v1.2.3 ${sha}`], code: 0 });
});

test("a usage limit hit in the turn, on the check's candidate daemon, is judged nothing", async () => {
  const limit = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(root, "limit-home"), SWITCHBOARD_PORT: "0", SWITCHBOARD_CANDIDATE: "1", ...NO_HISTORY });
  const adapter = fakeAdapter(
    [
      { t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp", model: "claude-haiku-x" },
      { t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.01, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } },
      { t: "session.end", status: "error", summary: limit },
    ],
    { models: ["claude-haiku-x"] },
  );
  const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: NO_GH });
  try {
    const c = { o: { taskMs: 5000, pollMs: 20 }, deps: { fetch, sleep: (ms: number) => Bun.sleep(ms) }, port: core.server.port, taskId: null, model: null, taskCwd: join(root, "limit-cwd") } as unknown as Ctx;
    const e = await bashOnce(c, "start").then(() => null, (x: Error) => x);
    expect(`${e?.constructor.name}: ${e?.message}`).toStartWith("Undecided:");
  } finally {
    await core.stop();
  }
}, 30_000);

test("an ok turn with no Bash call whose reply quotes a login message is a fail", async () => {
  const summary = "I did not run the command. (If you see \"Invalid API key\", please run /login.)";
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/health")) return Response.json({ ok: true, runners: [{ id: "claude", available: true, login: "ok", models: [{ value: "claude-haiku-x" }] }] });
    if (init?.method === "POST") return Response.json({ id: "t1", resumeReason: null }, { status: 201 });
    return Response.json({ task: { status: "done", resumeAt: null }, events: [{ seq: 1, ev: { t: "session.end", status: "ok", summary } }] });
  };
  const c = { o: { taskMs: 100, pollMs: 1 }, deps: { fetch, sleep: async () => {} }, port: 1, taskId: null, model: null, taskCwd: join(root, "ok-cwd") } as unknown as Ctx;
  const e = await bashOnce(c, "start").then(() => null, (x: Error) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e?.constructor.name).not.toBe("Undecided");
});

const pass = { ok: true, tag: "v1.2.3", sha, steps: ["a"], reason: null };
// made-up key in two pieces: the published tree is read for values like it (public-sync checkTree)
const FAKE_KEY = `${"AKIA"}${"IOSFODNN7EXAMPLE"}`;
const failed = { ok: false, tag: "v1.2.3", sha, steps: ["a"], reason: `x\nhidden: ${FAKE_KEY}\ny`, failedStep: "rollback to the previous release" };

test("record: checkResult reads the last line of the sha", () => {
  expect(checkResult(`notes\n[release-check] fail ${sha}\n[release-check] pass ${sha}\n`, sha)).toBe("pass");
  expect(checkResult(`[release-check] pass ${sha}\n[release-check] fail ${sha}`, sha)).toBe("fail");
  expect(checkResult(`[release-check] pass ${"b".repeat(40)}`, sha)).toBeNull();
  expect(checkResult("", sha)).toBeNull();
});

function recorder(over: { body?: string | null; open?: string | null; text?: string; latest?: string } = {}) {
  const calls: string[] = [];
  const d: RecordDeps = {
    devRepo: "o/dev",
    publicRepo: "o/pub",
    readBody: () => (over.body === undefined ? "notes" : over.body),
    latestTag: () => over.latest ?? null,
    edit: (tag, body, release) => void calls.push(`edit ${tag} latest=${release === "latest" ? "true" : release === "none" ? "none" : "no"} body=${JSON.stringify(body)}`),
    file: async (req) => {
      calls.push(`file ${req.title}`);
      calls.push(`filed-body ${req.body}`);
      return over.open ? { open: over.open } : { filed: 7 };
    },
    comment: async (ref, body) => void calls.push(`comment ${ref} ${body.includes("rollback") ? "with-step" : ""}`),
    text: async () => over.text ?? "",
    log: () => {},
  };
  return { calls, d };
}

test("record: a pass writes its line and makes the Release Latest", async () => {
  const { calls, d } = recorder();
  await recordResult(pass, d);
  expect(calls).toEqual([`edit v1.2.3 latest=true body=${JSON.stringify(`notes\n[release-check] pass ${sha}\n`)}`]);
});

test("record: a fail writes one line on the public side, never Latest, and the steps are in the request", async () => {
  const { calls, d } = recorder();
  await recordResult(failed, d);
  expect(calls[0]).toBe(`edit v1.2.3 latest=none body=${JSON.stringify(`notes\n[release-check] fail ${sha}\n`)}`);
  expect(calls[1]).toBe("file 要望: 公開前の確認が落ちた: rollback to the previous release");
  expect(calls[2]).toContain("落ちた段: rollback to the previous release");
  expect(calls[2]).toContain("出典");
  expect(calls[2]).toContain("誰の言葉: 定期の検査");
  expect(calls[2]).not.toContain(FAKE_KEY);
  expect(calls[0]).not.toContain("rollback");
  expect(calls.join("\n")).not.toContain("latest=true");
});

test("record: an open request with the same title gets a comment, once per tag", async () => {
  const a = recorder({ open: "#5" });
  await recordResult(failed, a.d);
  expect(a.calls.filter((c) => c.startsWith("comment"))).toEqual(["comment #5 with-step"]);
  const b = recorder({ open: "#5", text: failureRequest(failed, "o/dev", "o/pub").body });
  await recordResult(failed, b.d);
  expect(b.calls.filter((c) => c.startsWith("comment"))).toEqual([]);
});

test("record: a check that could not judge writes nothing anywhere", async () => {
  const { calls, d } = recorder();
  await recordResult({ ok: false, tag: "v1.2.3", sha, steps: [], reason: "no runner", undecided: "no runner" }, d);
  expect(calls).toEqual([]);
});

test("record: a body that cannot be read is an error and a pass does not make Latest", async () => {
  const { calls, d } = recorder({ body: null });
  await expect(recordResult(pass, d)).rejects.toThrow("cannot be read");
  expect(calls).toEqual([]);
});

test("record: a line already in the body is not written twice", async () => {
  const { calls, d } = recorder({ body: `notes\n[release-check] pass ${sha}\n` });
  await recordResult(pass, d);
  expect(calls).toEqual([`edit v1.2.3 latest=true body=${JSON.stringify(`notes\n[release-check] pass ${sha}\n`)}`]);
});

test("record: the real writes are gh release edit of the public repository, --prerelease=false --latest only for a pass", () => {
  const seen: string[] = [];
  const d = realRecordDeps("o/dev", "o/pub", (cmd, input) => (seen.push(`${cmd.join(" ")} <${input}>`), { ok: true, out: "notes" }));
  expect(d.readBody("v1.2.3")).toBe("notes");
  d.edit("v1.2.3", "b", "none");
  d.edit("v1.2.3", "b", "latest");
  d.edit("v1.2.3", "b", "not-latest");
  expect(seen).toEqual([
    "gh release view v1.2.3 -R o/pub --json body -q .body <undefined>",
    "gh release edit v1.2.3 -R o/pub --notes-file - <b>",
    "gh release edit v1.2.3 -R o/pub --notes-file - --prerelease=false --latest <b>",
    "gh release edit v1.2.3 -R o/pub --notes-file - --prerelease=false --latest=false <b>",
  ]);
});

test("record: --record is read from the command line", () => {
  expect(parseArgs(["v1.2.3", "--record"])).toEqual({ tag: "v1.2.3", record: true });
  expect(parseArgs(["v1.2.3", "--model", "m", "--record"])).toEqual({ tag: "v1.2.3", model: "m", record: true });
  expect(parseArgs(["v1.2.3", "--record", "--record"])).toBeNull();
});

test("record: a pass older than the current Latest is not made Latest", async () => {
  const { calls, d } = recorder({ latest: "v1.3.0" });
  await recordResult(pass, d);
  expect(calls[0]).toContain("latest=no");
  const newer = recorder({ latest: "v1.2.0" });
  await recordResult(pass, newer.d);
  expect(newer.calls[0]).toContain("latest=true");
  expect([notOlderThan("v1.10.0", "v1.9.9"), notOlderThan("v1.2.3", "v1.2.3"), notOlderThan("v1.2.2", "v1.2.3"), notOlderThan("v2.0.0", null)]).toEqual([true, true, false, true]);
});

test("record: a code above the last 20 lines, and the body of a key, are withheld whole", () => {
  const code = ["Device code:", ["ABCD", "EFGH"].join("-"), ...Array.from({ length: 19 }, (_, i) => `line ${i}`)].join("\n");
  expect(outputLines(code).join("\n")).not.toContain("EFGH");
  const pem = ["-----BEGIN PRIVATE", "KEY-----"].join(" "); // a key's header, made in two pieces
  const key = [pem, "FAKEKEYBODYFAKEKEYBODYFAKEKEYBODY", "-----END PRIVATE KEY-----"].join("\n");
  expect(outputLines(key).join("\n")).not.toContain("FAKEKEYBODY");
  expect(outputLines("a\nb")).toEqual(["a", "b"]);
});

test("a rate limit or a network failure before any step judges nothing: no record, no request", async () => {
  for (const f of [async (url: string) => (url.includes("/commits/") ? Response.json({ sha }) : new Response("rate limit exceeded", { status: 403 })), async () => { throw new Error("getaddrinfo ENOTFOUND"); }]) {
    const d = { fetch: f, tmp: () => mkdtempSync(join(tmpdir(), "rc-transient-")), remove: (dir: string) => rmSync(dir, { recursive: true, force: true }) } as unknown as CheckDeps;
    const r = await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, d);
    expect(r.undecided).toBeTruthy();
    expect(outcomeOf(r).code).toBe(2);
    const { calls, d: rec } = recorder();
    await recordResult(r, rec);
    expect(calls).toEqual([]);
  }
  const missing = { fetch: async () => new Response("", { status: 404 }), tmp: () => mkdtempSync(join(tmpdir(), "rc-transient-")), remove: (dir: string) => rmSync(dir, { recursive: true, force: true }) } as unknown as CheckDeps;
  expect((await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, missing)).undecided).toBeUndefined();
});

test("the published test file holds no secret-shaped value (public-sync reads every line of it)", () => {
  expect(findSecrets(readFileSync(import.meta.path, "utf8"), NO_HOST)).toEqual([]);
});

test("a prerelease the sync made is made Latest only by a pass, and never by a fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-prerelease-"));
  try {
    const priv = join(dir, "private");
    const pub = join(dir, "public.git");
    const git = (cwd: string, ...a: string[]) => {
      const p = Bun.spawnSync(["git", ...a], { cwd, stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
      return p.stdout.toString().trim();
    };
    mkdirSync(priv);
    git(priv, "init", "-q", "-b", "main");
    git(priv, "config", "user.email", "dev@example.com");
    git(priv, "config", "user.name", "dev");
    git(dir, "init", "-q", "--bare", "-b", "main", pub);
    git(dir, "init", "-q", "--bare", "-b", "main", join(dir, "private-origin.git"));
    git(priv, "remote", "add", "origin", join(dir, "private-origin.git"));
    const commit = (text: string, msg: string) => (writeFileSync(join(priv, "README.md"), "hello\n"), writeFileSync(join(priv, "NOTES.md"), text), git(priv, "add", "-A"), git(priv, "commit", "-qm", msg));
    const target = "example-org/app-public";
    const url = `https://github.com/${target}.git`;
    const calls: string[][] = [];
    const created = new Set<string>();
    // one gh for the sync and the record: it records every call, and git goes to the local bare repository
    const gh = (cmd: string[], o?: { input?: string; env?: Record<string, string> }) => {
      if (cmd[0] === "git") {
        const p = Bun.spawnSync(cmd.map((a) => (a === url ? pub : a)), { cwd: priv, stdin: o?.input === undefined ? "ignore" : new TextEncoder().encode(o.input), env: { ...process.env, ...o?.env }, stderr: "pipe" });
        return { code: p.exitCode ?? 1, out: p.stdout.toString().replace(/\n$/, "") };
      }
      calls.push(cmd);
      if (cmd[1] === "pr" && cmd[2] === "create") return { code: 0, out: `https://github.com/${target}/pull/1` };
      if (cmd[1] === "pr" && cmd[2] === "merge") {
        // what `gh pr merge --rebase` does on the bare public repository: the head commit again on main
        const branch = git(pub, "for-each-ref", "--format=%(refname:short)", "refs/heads/sync/").split("\n")[0]!;
        const merged = Bun.spawnSync(["sh", "-c", `git log -1 --format=%B ${branch} | git -c user.name=dev -c user.email=dev@example.com commit-tree ${branch}^{tree} -p main -F -`], { cwd: pub }).stdout.toString().trim();
        git(pub, "update-ref", "refs/heads/main", merged);
        git(pub, "update-ref", "-d", `refs/heads/${branch}`);
        return { code: 0, out: "" };
      }
      if (cmd[1] === "release" && cmd[2] === "create") created.add(cmd[3]!);
      if (cmd[1] === "release" && cmd[2] === "view") return { code: created.has(cmd[3]!) ? 0 : 1, out: cmd.includes("body") ? "notes" : "" };
      return { code: 0, out: cmd[1] === "api" ? 'HTTP/2.0 200 OK\n\n{"tag_name":"v0.9.0"}' : "" };
    };
    const opts = { privateRepo: "example-org/app", target, source: "main", user: "", prerelease: true } as const;
    commit("v1\n", "feat: one (#1)");
    expect(sync({ ...opts }, gh as Run)).toContain("pushed the first sync");
    commit("v2\n", "feat: two (#2)");
    git(priv, "tag", "v1.0.0");
    sync({ ...opts, source: "v1.0.0" }, gh as Run);
    const create = calls.find((c) => c[1] === "release" && c[2] === "create")!;
    expect(create).toContain("--prerelease");
    const tag = create[3]!;
    // the record sees the same gh: only a pass edits the Release to Latest
    const rec = (ok: boolean) => {
      const before = calls.length;
      return recordResult({ ok, tag, sha, steps: [], reason: ok ? null : "x", failedStep: "s" }, { ...realRecordDeps("o/dev", target, (cmd, input) => { const r = gh(cmd, input === undefined ? undefined : { input }); return { ok: r.code === 0, out: r.out }; }), file: async () => ({ filed: 1 }), log: () => {} }).then(() => calls.slice(before).filter((c) => c[2] === "edit"));
    };
    return rec(false).then(async (edits) => {
      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual(["gh", "release", "edit", tag, "-R", target, "--notes-file", "-"]);
      const pass = await rec(true);
      expect(pass).toHaveLength(1);
      expect(pass[0]).toEqual(["gh", "release", "edit", tag, "-R", target, "--notes-file", "-", "--prerelease=false", "--latest"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The real record deps on a fake gh; `latest` is the answer of `gh api -i .../releases/latest` (null: the read fails, as on a 403). */
function ghLatest(latest: string | null | "none") {
  const edits: string[] = [];
  const d = realRecordDeps("o/dev", "o/pub", (cmd) => {
    if (cmd[1] === "api") return latest === null ? { ok: false, out: "HTTP/2.0 403 Forbidden\n\n{}" } : latest === "none" ? { ok: false, out: "HTTP/2.0 404 Not Found\n\n{}" } : { ok: true, out: `HTTP/2.0 200 OK\nContent-Type: application/json\n\n${JSON.stringify({ tag_name: latest })}` };
    if (cmd[2] === "edit") edits.push(cmd.join(" "));
    return { ok: true, out: "notes" };
  });
  return { edits, d: { ...d, log: () => {} } };
}

test("record: an older passing tag is not made Latest, and nothing is written, when releases/latest cannot be read", async () => {
  const { edits, d } = ghLatest(null);
  await expect(recordResult(pass, d)).rejects.toThrow("cannot be read");
  expect(edits).toEqual([]);
});

test("record: no Latest at all (404) is a Latest to make, and a pass of the tag that is Latest keeps --latest", async () => {
  const none = ghLatest("none");
  await recordResult(pass, none.d);
  expect(none.edits).toHaveLength(1);
  expect(none.edits[0]).toEndWith("--prerelease=false --latest");
  const same = ghLatest("v1.2.3");
  await recordResult(pass, same.d);
  expect(same.edits[0]).toEndWith("--prerelease=false --latest");
  expect(same.edits.join("\n")).not.toContain("--latest=false");
  const newer = ghLatest("v1.3.0");
  await recordResult(pass, newer.d);
  expect(newer.edits[0]).toEndWith("--prerelease=false --latest=false");
});

test("record: a Latest that is not a 200 or a 404 throws", () => {
  expect(() => latestFromApi({ ok: false, out: "" })).toThrow("cannot be read");
  expect(() => latestFromApi({ ok: true, out: "HTTP/2.0 200 OK\n\n{}" })).toThrow("no tag_name");
  expect(latestFromApi({ ok: false, out: "HTTP/2.0 404 Not Found\n\n{}" })).toBeNull();
});

test("record: a key whose header is above the install output's cut does not reach the request", async () => {
  const marker = "MADEUPKEYBODY";
  // an RSA-sized PEM: the body alone is longer than the lines any cut of the output keeps
  const pem = [["-----BEGIN PRIVATE", "KEY-----"].join(" "), ...Array.from({ length: 28 }, () => marker.repeat(5).slice(0, 64)), ["-----END PRIVATE", "KEY-----"].join(" ")].join("\n");
  const deps = {
    fetch: async (url: string) => (url.includes("/commits/") ? Response.json({ sha }) : new Response("tarball")),
    run: async (argv: string[]) => (argv[1] === "rescue/install.ts" ? { code: 1, output: `installing\n${pem}\n` } : { code: 0, output: "" }),
    tmp: () => mkdtempSync(join(tmpdir(), "rc-redact-")),
    remove: (dir: string) => rmSync(dir, { recursive: true, force: true }),
    gitlessPath: (dir: string) => dir,
    which: () => null,
    freePort: async () => 1,
    sleep: async () => {},
    bun: "bun",
    startReleases: () => ({ url: "http://127.0.0.1:1", setLatest: () => true, stop: () => {} }),
    userHome: tmpdir(),
  } as unknown as CheckDeps;
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, deps);
  const { calls, d } = recorder();
  await recordResult(r, d);
  const filed = calls.find((c) => c.startsWith("filed-body"))!;
  expect(filed).toContain("落ちた段: install");
  expect(filed).not.toContain(marker);
});

test("record: the request does not claim the version is a prerelease", () => {
  const body = failureRequest(failed, "o/dev", "o/pub").body;
  expect(body).not.toContain("プレリリースのまま");
  expect(body).toContain("プレリリースなら");
});

/** A CheckDeps whose installer fails with `output` and whose other processes do nothing. */
const failingInstall = (output: string): CheckDeps =>
  ({
    fetch: async (url: string) => (url.includes("/commits/") ? Response.json({ sha }) : new Response("tarball")),
    run: async (argv: string[]) => (argv[1] === "rescue/install.ts" ? { code: 1, output } : { code: 0, output: "" }),
    tmp: () => mkdtempSync(join(root, "run-")),
    remove: (dir: string) => rmSync(dir, { recursive: true, force: true }),
    gitlessPath: (dir: string) => dir,
    which: () => null,
    freePort: async () => 1,
    sleep: async () => {},
    bun: "bun",
    startReleases: () => ({ url: "http://127.0.0.1:1", setLatest: () => true, stop: () => {} }),
    userHome: root,
  }) as unknown as CheckDeps;

test("record: a key cut by sb-rescue's own run() does not reach the request (the external text is never written)", async () => {
  const marker = "MADEUPKEYBODY";
  const pem = [["-----BEGIN PRIVATE", "KEY-----"].join(" "), ...Array.from({ length: 40 }, () => marker.repeat(5).slice(0, 64)), ["-----END PRIVATE", "KEY-----"].join(" ")].join("\n");
  const file = join(root, "round3-out.txt");
  writeFileSync(file, `${pem}\n`);
  const thrown = await rescueRun(["sh", "-c", `cat '${file}' >&2; exit 1`], root).then(() => "", (e: Error) => e.message);
  expect(thrown).toContain(marker);
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, failingInstall(`install failed: ${thrown}\n`));
  const filed = failureRequest(r, "o/dev", "o/pub").body;
  expect(filed).toContain("落ちた段: install");
  expect(filed).not.toContain(marker);
});

test("record: the text an outside process returned is printed by the command but never written to the request or the comment", async () => {
  const external = "outside-process-says-this-text-1234";
  const r = await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, failingInstall(`${external}\nmore ${external}\n`));
  expect(r.ok).toBe(false);
  expect(outcomeOf(r).lines.join("\n")).toContain(external);
  const { calls, d } = recorder({ open: "#5", text: "" });
  await recordResult(r, d);
  const written = calls.join("\n");
  expect(written).toContain("落ちた段: install");
  expect(written).toContain("exited 1");
  expect(written).not.toContain(external);
  expect(failureRequest(r, "o/dev", "o/pub").body).not.toContain(external);
});

// An error the check did not write itself (a JSON parse error quoting what sb-rescue answered) is a fixed sentence in the
// reason, so it never reaches a request; its message is the detail, printed by the command only.
for (const [name, text] of [["bare word", "MADEUPOUTSIDETEXT"], ["html", "<html>MADEUPOUTSIDETEXT</html>"], ["cut json", '{"current": MADEUPOUTSIDETEXT']] as const) {
  test(`a non-JSON /api/status answer does not reach the request: ${name}`, async () => {
    const sha = "a".repeat(40);
    const d = {
      fetch: async (url: string) => {
        if (url.includes("/commits/")) return Response.json({ sha });
        if (url.endsWith("/api/status")) return new Response(text);
        if (url.endsWith("/api/health")) return Response.json({ ok: true });
        return new Response("tarball");
      },
      run: async (_argv: string[], o: { env: Record<string, string> }) => (mkdirSync(join(o.env.SWITCHBOARD_HOME!, "releases", sha), { recursive: true }), { code: 0, output: "" }),
      spawn: () => ({ kill: async () => {}, exited: new Promise<number | null>(() => undefined) }),
      tmp: () => mkdtempSync(join(root, "run-")),
      remove: (dir: string) => rmSync(dir, { recursive: true, force: true }),
      gitlessPath: (dir: string) => dir,
      which: () => null,
      freePort: async () => 1,
      sleep: async () => {},
      bun: "bun",
      startReleases: () => ({ url: "http://127.0.0.1:1", setLatest: () => true, stop: () => {} }),
      userHome: tmpdir(),
    } as unknown as CheckDeps;
    const r = await checkRelease({ tag: "v1.2.3", repo: "o/pub" }, d);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("予期しないエラー（詳細は確認の標準出力）");
    expect(r.detail).toContain("JSON Parse error");
    expect(failureRequest(r, "o/dev", "o/pub").body).not.toContain("MADEUPOUTSIDETEXT");
  });
}
