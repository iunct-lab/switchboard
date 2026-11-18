// test-reads: scripts/release-smoke.ts container/fake-releases.ts
/**
 * The check of a real Release's install, against a fake Releases API and with no process started: `run` and `spawn`
 * are recorded fakes, and the daemon's and the rescue page's answers come from the test.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeReleases } from "../container/fake-releases.ts";
import { gitlessPath, parseArgs, resultLine, smokeRelease, type SmokeDeps } from "./release-smoke.ts";

const root = mkdtempSync(join(tmpdir(), "sb-release-smoke-"));
const sha = "a".repeat(40);
let fake: ReturnType<typeof startFakeReleases>;

beforeAll(() => {
  writeFileSync(join(root, "v0.4.0.tar.gz"), "the fake run does not unpack it");
  fake = startFakeReleases({ repo: "o/n", releases: [{ tag: "v0.4.0", sha, tarball: join(root, "v0.4.0.tar.gz") }] });
});
afterAll(() => {
  fake.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Fake deps: the Releases API is the real fake server; the installed daemon's two addresses answer what `up` says. */
function deps(over: { install?: number; health?: () => Response; page?: () => Response; git?: string | null; exits?: number } = {}) {
  const ran: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
  const spawned: Array<{ argv: string[]; env: Record<string, string>; killed: boolean }> = [];
  const homes: string[] = [];
  const d: SmokeDeps = {
    fetch: async (url, init) => {
      if (url.startsWith(fake.url)) return fetch(url, init);
      if (url === "http://127.0.0.1:5001/api/health") return (over.health ?? (() => Response.json({ ok: true })))();
      if (url === "http://127.0.0.1:5002/") return (over.page ?? (() => new Response("<html>")))();
      throw new Error(`unexpected fetch: ${url}`);
    },
    run: async (argv, o) => {
      ran.push({ argv, ...o });
      return argv[1] === "rescue/install.ts" ? { code: over.install ?? 0, output: over.install ? "install failed: boom" : "installed" } : { code: 0, output: "" };
    },
    spawn: (argv, o) => {
      const p = { argv, env: o.env, killed: false };
      spawned.push(p);
      return { kill: async () => void (p.killed = true), exited: over.exits === undefined ? new Promise<number | null>(() => undefined) : Promise.resolve(over.exits) };
    },
    tmp: () => {
      const dir = mkdtempSync(join(root, "home-"));
      homes.push(dir);
      return dir;
    },
    remove: (dir) => rmSync(dir, { recursive: true, force: true }),
    gitlessPath: (dir) => dir,
    which: () => (over.git === undefined ? null : over.git),
    freePort: (() => {
      let next = 5001;
      return async () => next++;
    })(),
    sleep: async () => undefined,
    bun: "/bin/bun",
  };
  return { d, ran, spawned, homes };
}

test("pass: the newest Release is unpacked, installed with HOME and PATH of its own, started under sb-rescue and both answers are seen", async () => {
  const { d, ran, spawned, homes } = deps();
  const r = await smokeRelease({ repo: "o/n", api: fake.url }, d);
  expect(r).toEqual({ ok: true, tag: "v0.4.0", sha, steps: [`latest Release: v0.4.0 (${sha.slice(0, 7)})`, "tarball unpacked", "installed without git", "/api/health ok", "rescue page 200"], reason: null });
  const home = homes[0]!;
  expect(ran.map((x) => x.argv)).toEqual([
    ["tar", "-xzf", join(home, "src.tar.gz"), "-C", join(home, "switchboard-src"), "--strip-components=1"],
    ["/bin/bun", "rescue/install.ts", "--source", "o/n"],
  ]);
  // nothing of this machine's Switchboard reaches the install: the environment is these three and no more
  expect(ran[1]!.env).toEqual({ HOME: home, PATH: join(home, "bin"), SWITCHBOARD_GITHUB_API: fake.url });
  expect(ran[1]!.cwd).toBe(join(home, "switchboard-src"));
  expect(spawned.map((s) => [s.argv, s.env.SWITCHBOARD_PORT, s.env.SWITCHBOARD_RESCUE_PORT, s.env.HOME, s.killed])).toEqual([[["/bin/bun", join(home, ".switchboard", "rescue", "sb-rescue.js")], "5001", "5002", home, true]]);
  expect(existsSync(home)).toBe(false);
  expect(resultLine(r)).toBe(`[release-smoke] pass v0.4.0 ${sha}`);
});

test("fail: an install that exits non-zero starts nothing, and the mark names the release", async () => {
  const { d, spawned, homes } = deps({ install: 1 });
  const r = await smokeRelease({ repo: "o/n", api: fake.url }, d);
  expect([r.ok, r.reason]).toEqual([false, "rescue/install.ts --source o/n exited 1: install failed: boom"]);
  expect(spawned).toEqual([]);
  expect(existsSync(homes[0]!)).toBe(false);
  expect(resultLine(r)).toBe(`[release-smoke] fail v0.4.0 ${sha}`);
});

test("fail: a daemon that never says ok, a rescue page that is not 200, and an sb-rescue that ends by itself; sb-rescue is stopped each time", async () => {
  const down = deps({ health: () => new Response("starting", { status: 503 }) });
  const r1 = await smokeRelease({ repo: "o/n", api: fake.url, waitMs: 0 }, down.d);
  expect([r1.ok, r1.reason]).toEqual([false, "not up in time: /api/health status 503, the rescue page 200"]);
  expect(down.spawned[0]!.killed).toBe(true);

  const notOk = deps({ health: () => Response.json({ ok: false }) });
  expect((await smokeRelease({ repo: "o/n", api: fake.url, waitMs: 0 }, notOk.d)).ok).toBe(false);

  const page = deps({ page: () => new Response("boom", { status: 500 }) });
  const r2 = await smokeRelease({ repo: "o/n", api: fake.url, waitMs: 0 }, page.d);
  expect([r2.ok, r2.reason]).toEqual([false, "not up in time: /api/health ok, the rescue page status 500"]);
  expect(page.spawned[0]!.killed).toBe(true);

  const gone = deps({ health: () => { throw new Error("refused"); }, exits: 2 });
  const r3 = await smokeRelease({ repo: "o/n", api: fake.url, waitMs: 60_000 }, gone.d);
  expect([r3.ok, r3.reason]).toEqual([false, "sb-rescue exited (2) before the daemon answered"]);
});

test("fail before anything runs: git still on the PATH, a repository with no Release, a name that is not owner/name", async () => {
  const withGit = deps({ git: "/usr/bin/git" });
  const r = await smokeRelease({ repo: "o/n", api: fake.url }, withGit.d);
  expect([r.ok, r.reason, withGit.ran]).toEqual([false, "the PATH for the install still has git (/usr/bin/git): the check would not see a missing git", []]);

  const none = deps();
  const r2 = await smokeRelease({ repo: "o/none", api: fake.url }, none.d);
  expect([r2.ok, r2.tag, none.ran]).toEqual([false, null, []]);
  expect(r2.reason).toContain("/repos/o/none/releases/latest returned 404");
  expect(resultLine(r2)).toBe("[release-smoke] fail - -");

  expect((await smokeRelease({ repo: "not a repo" }, deps().d)).reason).toBe("not an owner/name: not a repo");
});

test("gitlessPath links every command but git and its helpers, the first PATH directory winning", () => {
  const a = join(root, "path-a");
  const b = join(root, "path-b");
  for (const [dir, names] of [[a, ["git", "git-upload-pack", "tar", "bun"]], [b, ["git", "tar", "gzip"]]] as const) {
    mkdirSync(dir, { recursive: true });
    for (const n of names) {
      writeFileSync(join(dir, n), `#!/bin/sh\necho ${dir}\n`);
      chmodSync(join(dir, n), 0o755);
    }
  }
  const out = gitlessPath(join(root, "gitless"), `${a}:${join(root, "missing")}:${b}`);
  expect(readdirSync(out).sort()).toEqual(["bun", "gzip", "tar"]);
  expect(Bun.which("git", { PATH: out })).toBeNull();
  expect(Bun.spawnSync([join(out, "tar")]).stdout.toString().trim()).toBe(a);
});

test("the command line: one owner/name, and --api only with an http(s) URL", () => {
  expect(parseArgs(["o/n"])).toEqual({ repo: "o/n" });
  expect(parseArgs(["--api", "http://localhost:1", "o/n"])).toEqual({ repo: "o/n", api: "http://localhost:1" });
  for (const bad of [[], ["o/n", "x/y"], ["--api", "o/n"], ["o/n", "--api"], ["o/n", "--api", "ftp://x"], ["nope"]]) expect({ bad, parsed: parseArgs(bad) }).toEqual({ bad, parsed: null });
});
