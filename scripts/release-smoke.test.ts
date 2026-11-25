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
import { gitlessPath, parseArgs, recordSmoke, requestTitleOf, resultLine, smokeRelease, type RecordDeps, type SmokeDeps } from "./release-smoke.ts";

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
  expect(parseArgs(["o/n", "--record", "v1.2.3"])).toEqual({ repo: "o/n", record: "v1.2.3" });
  for (const bad of [[], ["o/n", "x/y"], ["--api", "o/n"], ["o/n", "--api"], ["o/n", "--api", "ftp://x"], ["nope"], ["o/n", "--record"], ["o/n", "--record", "main"]]) expect({ bad, parsed: parseArgs(bad) }).toEqual({ bad, parsed: null });
});

/** Fake writes: the development Release bodies by tag, the open requests, and what was filed or commented. */
function recordDeps(bodies: Record<string, string>, open: Array<{ ref: string; title: string; text: string }> = []) {
  const written: Array<{ tag: string; body: string }> = [];
  const filed: Array<{ title: string; body: string }> = [];
  const commented: Array<{ ref: string; body: string }> = [];
  const logs: string[] = [];
  let locks = 0;
  const d: RecordDeps = {
    repo: "dev/repo",
    readBody: (tag) => bodies[tag] ?? null,
    writeBody: (tag, body) => {
      written.push({ tag, body });
      bodies[tag] = body;
    },
    locked: (fn) => {
      locks++;
      return fn();
    },
    file: async (req) => {
      const same = open.find((o) => o.title === req.title);
      if (same) return { open: same.ref };
      filed.push(req);
      return { filed: 77 };
    },
    comment: async (ref, body) => void commented.push({ ref, body }),
    text: async (ref) => open.find((o) => o.ref === ref)!.text,
    log: (l) => logs.push(l),
    date: "2026-11-26",
  };
  return { d, written, filed, commented, logs, locks: () => locks };
}

const passed = { ok: true, tag: "v0.4.0", sha, steps: [], reason: null };
const failed = { ok: false, tag: "v0.4.0", sha, steps: ["latest Release: v0.4.0 (aaaaaaa)"], reason: "rescue/install.ts --source o/n exited 1: boom at /home/someone/x" };

test("record, pass: the development Release gets the line under its own heading, the old body stays, no request", async () => {
  const bodies = { "v9.9.9": "notes\n\n## CI\n[tag-ci] pass " + "b".repeat(40) };
  const r = recordDeps(bodies);
  await recordSmoke(passed, "v9.9.9", r.d);
  expect(r.written).toHaveLength(1);
  expect(bodies["v9.9.9"]).toBe(`notes\n\n## CI\n[tag-ci] pass ${"b".repeat(40)}\n\n## 公開の Release の確かめ\n[release-smoke] pass v0.4.0 ${sha}\n`);
  expect([r.filed, r.commented, r.locks()]).toEqual([[], [], 1]);
});

test("record, fail: a fail line and one request whose body has the reason without host paths", async () => {
  const bodies = { "v9.9.9": "notes" };
  const r = recordDeps(bodies);
  await recordSmoke(failed, "v9.9.9", r.d);
  expect(bodies["v9.9.9"]).toContain(`[release-smoke] fail v0.4.0 ${sha}`);
  expect(r.filed).toHaveLength(1);
  expect(r.filed[0]!.title).toBe("公開の Release が入らない: v0.4.0");
  expect(r.filed[0]!.body).toContain("boom at ~/x");
  expect(r.filed[0]!.body).not.toContain("/home/someone");
  expect(r.commented).toEqual([]);
});

test("record, fail with an open request of the same title: a comment only, once per public tag", async () => {
  const open = [{ ref: "#5", title: requestTitleOf("v0.4.0"), text: "body of the request" }];
  const r = recordDeps({ "v9.9.9": "notes" }, open);
  await recordSmoke(failed, "v9.9.9", r.d);
  expect([r.filed, r.commented.map((c) => c.ref)]).toEqual([[], ["#5"]]);
  expect(r.commented[0]!.body).toContain(`v0.4.0（${sha.slice(0, 7)}）`);
  // the comment already there names the tag: a second run says nothing more
  open[0]!.text += `\n${r.commented[0]!.body}`;
  const again = recordDeps({ "v9.9.9": "notes" }, open);
  await recordSmoke(failed, "v9.9.9", again.d);
  expect(again.commented).toEqual([]);
});

test("record: a line of the same public tag is replaced, never doubled; another tag's stays; an unreadable Release writes nothing but a fail still files its request", async () => {
  const other = `[release-smoke] pass v0.3.0 ${"c".repeat(40)}`;
  const bodies = { "v9.9.9": `notes\n\n## 公開の Release の確かめ\n${other}\n[release-smoke] fail v0.4.0 ${sha}\n` };
  const r = recordDeps(bodies);
  await recordSmoke(passed, "v9.9.9", r.d);
  expect(bodies["v9.9.9"]).toBe(`notes\n\n## 公開の Release の確かめ\n${other}\n[release-smoke] pass v0.4.0 ${sha}\n`);
  const lines = bodies["v9.9.9"].split("\n").filter((l) => l.startsWith("[release-smoke]"));
  expect(lines).toHaveLength(2);
  // the same result again changes nothing
  await recordSmoke(passed, "v9.9.9", r.d);
  expect(r.written).toHaveLength(1);

  const none = recordDeps({});
  await expect(recordSmoke(failed, "v1.0.0", none.d)).rejects.toThrow("cannot be read");
  expect(none.written).toEqual([]);
  expect(none.filed).toHaveLength(1);
  // a pass with an unreadable Release files nothing
  const unread = recordDeps({});
  await expect(recordSmoke(passed, "v1.0.0", unread.d)).rejects.toThrow("cannot be read");
  expect([unread.written, unread.filed]).toEqual([[], []]);
});
