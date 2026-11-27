// test-reads: none
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_STALE_MS, CACHE_WORK_STALE_MS, DOCKER_PRUNE, DOCKER_RECLAIM, RECLAIM_STALE_MS, reclaim, sweepCaches, sweepCacheWork, sweepDocker, sweepNpm, sweepStoppedContainers } from "./cache.ts";
import { run } from "./releases.ts";

let home: string;
let cache: string;
let repo: string;
const OLD = (Date.now() - CACHE_WORK_STALE_MS - 60 * 60 * 1000) / 1000;

/** Sets the mtime of `path` and everything in it to OLD (or `at`, in seconds). */
function age(path: string, at = OLD) {
  const walk = (p: string) => {
    try {
      for (const c of readdirSync(p)) walk(join(p, c));
    } catch {} // a file
    utimesSync(p, at, at);
  };
  walk(path);
}

/** A directory with one file; old unless `fresh`. */
function dir(name: string, o: { fresh?: boolean } = {}) {
  mkdirSync(join(cache, name));
  writeFileSync(join(cache, name, "f.log"), "x".repeat(4096));
  if (!o.fresh) age(join(cache, name));
}

const worktrees = async () => (await run(["git", "-C", repo, "worktree", "list", "--porcelain"], repo)).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "sb-cache-test-"));
  cache = join(home, ".cache");
  repo = join(home, "repo");
  mkdirSync(cache);
  mkdirSync(repo);
  await run(["git", "init", "-q", "-b", "main"], repo);
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root"], repo);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("sweepCacheWork: a check's old working directories go; a new one, an unlike name and another application's stay", async () => {
  for (const name of ["switchboard.e2e.x0QgO6", "switchboard.e2e-12.Ab12Cd", "switchboard.duration.Ab12Cd", "switchboard.duration-1887.OsTTGB", "switchboard.tag-ci.Ab12Cd", "switchboard.tag-ci-v1.73.0.5aVZBi", "switchboard.tag-ci-iunct-lab_switchboard-dev-log.NBOx7r", "capsule-host.e2e.a1b2c3"]) dir(name);
  dir("switchboard.e2e.Fresh1", { fresh: true });
  dir("switchboard.e2e.toolong1");
  dir("switchboard.e2e.Busy01");
  dir("switchboard.other.Ab12Cd");
  dir("switchboard.pbi2587-ci.1XMbla"); // made by hand, nothing says what it is
  dir("myapp.e2e.report"); // not mktemp's suffix
  dir("myapp.e2e-results.Run123"); // e2e and duration take a number only
  dir("e2e.Ab12Cd");
  dir("gh");
  const child = Bun.spawn(["sleep", "30"], { cwd: join(cache, "switchboard.e2e.Busy01") });
  try {
    const r = await sweepCacheWork(cache, { owned: false });
    expect(readdirSync(cache).sort()).toEqual(["e2e.Ab12Cd", "gh", "myapp.e2e-results.Run123", "myapp.e2e.report", "switchboard.e2e.Busy01", "switchboard.e2e.Fresh1", "switchboard.e2e.toolong1", "switchboard.other.Ab12Cd", "switchboard.pbi2587-ci.1XMbla"]);
    expect(r.removed).toBe(8);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("sweepCacheWork: an old screens-audit work directory goes on any machine; a new or in-use one stays", async () => {
  for (const name of ["switchboard.screens-audit.Ab12Cd", "capsule-host.screens-audit.x0QgO6"]) dir(name);
  dir("switchboard.screens-audit.Fresh1", { fresh: true });
  dir("switchboard.screens-audit.Busy01");
  dir("switchboard.screens-audit.toolong1");
  dir("switchboard.screens-audit.report");
  const child = Bun.spawn(["sleep", "30"], { cwd: join(cache, "switchboard.screens-audit.Busy01") });
  try {
    const r = await sweepCacheWork(cache, { owned: false });
    expect(readdirSync(cache).sort()).toEqual(["switchboard.screens-audit.Busy01", "switchboard.screens-audit.Fresh1", "switchboard.screens-audit.report", "switchboard.screens-audit.toolong1"]);
    expect(r.removed).toBe(2);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("sweepCacheWork: on a machine of Switchboard's own, an old mktemp-named directory goes; elsewhere and the caches' names stay", async () => {
  const mine = ["switchboard.t5066shot.Ab12Cd", "switchboard.pbi2587-ci.1XMbla"];
  const others = ["uv", "claude-cli-nodejs", "ms-playwright", "fontconfig", "switchboard.local-ci-pending", "ops-kit", "gh"];
  for (const name of [...mine, ...others]) dir(name);
  const elsewhere = await sweepCacheWork(cache, { owned: false });
  expect(elsewhere.removed).toBe(0);
  expect(readdirSync(cache).sort()).toEqual([...mine, ...others].sort());
  const r = await sweepCacheWork(cache, { owned: true });
  expect(r.removed).toBe(2);
  expect(readdirSync(cache).sort()).toEqual([...others].sort());
});

test("sweepCacheWork: old local-CI worktrees, base worktrees and any PR's old logs go, and the repository forgets the worktrees; new, in-use and other names stay", async () => {
  for (const name of ["switchboard.local-ci-2518.Ab12Cd", "switchboard.local-ci-2518-base.Zz98Yy"]) {
    await run(["git", "-C", repo, "worktree", "add", "-q", "--detach", join(cache, name)], repo);
    age(join(cache, name));
  }
  dir("switchboard.local-ci-iunct-lab_switchboard-dev-2717-log.q9ZkLm"); // another PR's log, not the latest one's
  dir("capsule-host.local-ci-iunct-lab_capsule-host-12-log.a1b2c3"); // another repository's kit
  dir("my.repo.local-ci-12.Ab12Cd"); // a repository name with a dot
  dir("switchboard.local-ci-2600.Qw3rTy", { fresh: true });
  dir("switchboard.local-ci-2601.Busy01");
  dir("uv"); // a cache: not a working directory
  dir("ms-playwright");
  dir("switchboard.local-ci-2602.XXXXXX.extra");
  writeFileSync(join(cache, "switchboard.local-ci-2603.Fi1e00"), "a file");
  utimesSync(join(cache, "switchboard.local-ci-2603.Fi1e00"), OLD, OLD);
  expect(await worktrees()).toHaveLength(3);

  const child = Bun.spawn(["sleep", "30"], { cwd: join(cache, "switchboard.local-ci-2601.Busy01") });
  try {
    const r = await sweepCacheWork(cache, { owned: false });
    expect(readdirSync(cache).sort()).toEqual([
      "ms-playwright",
      "switchboard.local-ci-2600.Qw3rTy",
      "switchboard.local-ci-2601.Busy01",
      "switchboard.local-ci-2602.XXXXXX.extra",
      "switchboard.local-ci-2603.Fi1e00",
      "uv",
    ]);
    expect(r.removed).toBe(5);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(r.skipped).toBe(0);
    expect(await worktrees()).toEqual([repo]);
  } finally {
    child.kill();
    await child.exited;
  }
});

/** A review clone under ops-kit/review: a git directory with `origin` (none when `origin` is null); old unless `fresh`. */
async function clone(name: string, origin: string | null, o: { fresh?: boolean } = {}) {
  const d = join(cache, "ops-kit", "review", name);
  mkdirSync(d, { recursive: true });
  await run(["git", "init", "-q", "-b", "main"], d);
  if (origin) await run(["git", "remote", "add", "origin", origin], d);
  writeFileSync(join(d, "f.txt"), "x".repeat(4096));
  if (!o.fresh) age(d);
  return d;
}
const reviews = () => readdirSync(join(cache, "ops-kit", "review")).sort();

test("sweepCacheWork: an old review clone goes once GitHub says its PR is closed; open, not told, new, in use, no or non-GitHub origin and unlike names stay", async () => {
  await clone("switchboard.review10", "https://github.com/acme/app.git");
  await clone("my.app.recheck11", "git@github.com:acme/my.app.git");
  await clone("switchboard.review12", "https://github.com/acme/app"); // open
  await clone("switchboard.review13", "https://github.com/acme/app"); // gh failed
  await clone("switchboard.review14", "https://github.com/acme/app", { fresh: true });
  await clone("switchboard.review15", "https://github.com/acme/app"); // in use
  await clone("switchboard.review16", null);
  await clone("switchboard.review17", "https://gitlab.com/acme/switchboard.git");
  await clone("switchboard.reviewx", "https://github.com/acme/app");
  await clone("switchboard.review18r", "https://github.com/acme/app"); // a letter after the number: the old /tmp type, not this one
  const odd = join(cache, "ops-kit", "review", "switchboard.review19"); // a .git file that names no worktree
  mkdirSync(odd);
  await run(["git", "init", "-q", "--separate-git-dir", join(home, "separate.git"), odd], home); // a gh clone's .git is a directory; this one is a file, and its origin answers
  await run(["git", "remote", "add", "origin", "https://github.com/acme/app"], odd);
  age(odd);
  await clone("switchboard.review23", "https://github.com/acme/app"); // starts being used while GitHub is asked
  await clone("switchboard.review24", "https://gitlab.example.com/github.com/acme/app.git"); // github.com only in the path: not GitHub
  await clone("switchboard.review22", "https://github.com/acme/app").then((d) => rmSync(join(d, ".git"), { recursive: true })); // no .git at all
  const note = join(cache, "ops-kit", "review", "x.review7-claude-1.md");
  writeFileSync(note, "notes");
  utimesSync(note, OLD, OLD);
  const asked: string[] = [];
  let late: ReturnType<typeof Bun.spawn> | undefined;
  const state = async (repo: string, n: number) => {
    asked.push(`${repo}#${n}`);
    if (n === 23) late = Bun.spawn(["sleep", "30"], { cwd: join(cache, "ops-kit", "review", "switchboard.review23") });
    return n === 12 ? "open" : n === 13 ? null : "closed";
  };
  const child = Bun.spawn(["sleep", "30"], { cwd: join(cache, "ops-kit", "review", "switchboard.review15") });
  try {
    const r = await sweepCacheWork(cache, { owned: false }, Date.now(), state);
    expect(reviews()).toEqual(["switchboard.review12", "switchboard.review13", "switchboard.review14", "switchboard.review15", "switchboard.review16", "switchboard.review17", "switchboard.review18r", "switchboard.review19", "switchboard.review22", "switchboard.review23", "switchboard.review24", "switchboard.reviewx", "x.review7-claude-1.md"]);
    expect(r.removed).toBe(2);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(asked.sort()).toEqual(["acme/app#10", "acme/app#12", "acme/app#13", "acme/app#23", "acme/my.app#11"]); // not the new, the busy, nor the ones with no GitHub origin
  } finally {
    child.kill();
    await child.exited;
    late?.kill();
    await late?.exited;
  }
});

test("sweepCacheWork: an old review worktree of a local change goes without asking GitHub and the repository forgets it; a new one stays", async () => {
  const root = join(cache, "ops-kit", "review");
  mkdirSync(root, { recursive: true });
  await run(["git", "-C", repo, "worktree", "add", "-q", "--detach", join(root, "switchboard.review20")], repo);
  await run(["git", "-C", repo, "worktree", "add", "-q", "--detach", join(root, "switchboard.review21")], repo);
  age(join(root, "switchboard.review20"));
  expect(await worktrees()).toHaveLength(3);
  const r = await sweepCacheWork(cache, { owned: false }, Date.now(), async () => {
    throw new Error("a local change's worktree is not a GitHub PR");
  });
  expect(reviews()).toEqual(["switchboard.review21"]);
  expect(r.removed).toBe(1);
  expect(await worktrees()).toEqual([repo, join(root, "switchboard.review21")]);
});

test("sweepCacheWork: no ~/.cache is nothing to do, and without the running processes nothing goes", async () => {
  expect((await sweepCacheWork(join(home, "missing"), { owned: false })).removed).toBe(0);
  dir("switchboard.local-ci-2518.Ab12Cd");
  const r = await sweepCacheWork(cache, { owned: false, proc: join(home, "no-proc") });
  expect(r.removed).toBe(0);
  expect(readdirSync(cache)).toEqual(["switchboard.local-ci-2518.Ab12Cd"]);
});

/** A cache entry with one file under `home`; `days` old (0 = new). */
function entry(rel: string, days: number) {
  mkdirSync(join(home, rel), { recursive: true });
  writeFileSync(join(home, rel, "f"), "x".repeat(4096));
  if (days) age(join(home, rel), (Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
}
const ls = (rel: string) => readdirSync(join(home, rel)).sort();
const CONTAINER_LS = ["docker", "container", "ls", "-a", "--filter", "status=exited", "--format", "{{.ID}}"];
const PRUNED = "Deleted Images:\nuntagged: alpine:3.19\ndeleted: sha256:aaa\ndeleted: sha256:bbb\n\nTotal reclaimed space: 1.5GB\n";

test("sweepCaches / sweepDocker on a machine of Switchboard's own: uv's and bun's entries untouched for CACHE_STALE_MS go, new ones and dot-names stay; docker prunes the unused images", async () => {
  expect(CACHE_STALE_MS).toBeGreaterThan(CACHE_WORK_STALE_MS);
  entry(".cache/uv/archive-v0/old1", 15);
  entry(".cache/uv/archive-v0/new1", 0);
  entry(".cache/uv/wheels-v6/pypi", 15);
  entry(".cache/uv/.tmpXyZ", 15); // uv's own temp: a dot-name
  entry(".bun/install/cache/left-pad@1.3.0@@@1", 15);
  entry(".bun/install/cache/zod@3.0.0@@@1", 1);
  entry(".bun/install/cache/@babel/core@7.0.0@@@1", 15);
  entry(".bun/install/cache/@babel/parser@7.0.0@@@1", 0);
  entry(".bun/install/cache/.tmp", 15);
  const r = sweepCaches(home, { owned: true });
  expect(ls(".cache/uv")).toEqual([".tmpXyZ", "archive-v0", "wheels-v6"]);
  expect(ls(".cache/uv/archive-v0")).toEqual(["new1"]);
  expect(ls(".cache/uv/wheels-v6")).toEqual([]);
  expect(ls(".bun/install/cache")).toEqual([".tmp", "@babel", "zod@3.0.0@@@1"]);
  expect(ls(".bun/install/cache/@babel")).toEqual(["parser@7.0.0@@@1"]);
  expect(r.removed).toBe(4);
  expect(r.freedBytes).toBeGreaterThan(0);

  const calls: string[][] = [];
  const d = await sweepDocker({ owned: true }, async (argv) => (calls.push(argv), PRUNED));
  expect(calls).toEqual([["docker", "image", "prune", "-a", "-f", "--filter", "until=24h"]]);
  expect(DOCKER_PRUNE).toEqual(calls[0]!);
  expect(d.removed).toBe(2);
  expect(d.freedBytes).toBe(1.5e9);
  const none = await sweepDocker({ owned: true }, async () => Promise.reject(Object.assign(new Error("posix_spawn 'docker'"), { code: "ENOENT" })));
  expect(none.removed).toBe(0);
  await expect(sweepDocker({ owned: true }, async () => Promise.reject(new Error("docker image prune exited 1: Cannot connect")))).rejects.toThrow("exited 1");
});

test("sweepCaches / sweepDocker elsewhere: the caches the user's other apps share stay and docker is not called", async () => {
  entry(".cache/uv/archive-v0/old1", 15);
  entry(".bun/install/cache/left-pad@1.3.0@@@1", 15);
  expect(sweepCaches(home, { owned: false }).removed).toBe(0);
  expect(ls(".cache/uv/archive-v0")).toEqual(["old1"]);
  expect(ls(".bun/install/cache")).toEqual(["left-pad@1.3.0@@@1"]);
  const calls: string[][] = [];
  expect((await sweepDocker({ owned: false }, async (argv) => (calls.push(argv), PRUNED))).removed).toBe(0);
  expect(calls).toEqual([]);
});

test("sweepCaches: an entry a running process uses stays, and without the running processes nothing goes", async () => {
  entry(".cache/uv/archive-v0/busy1", 15);
  entry(".cache/uv/archive-v0/old1", 15);
  const child = Bun.spawn(["sleep", "30"], { cwd: join(home, ".cache/uv/archive-v0/busy1") });
  try {
    expect(sweepCaches(home, { owned: true, proc: join(home, "no-proc") }).removed).toBe(0);
    expect(sweepCaches(home, { owned: true }).removed).toBe(1);
    expect(ls(".cache/uv/archive-v0")).toEqual(["busy1"]);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("reclaim: past RECLAIM_STALE_MS the uv and bun entries nothing uses go; the one in use and one just written stay; docker is asked without the age; elsewhere nothing happens", async () => {
  expect(RECLAIM_STALE_MS).toBe(60 * 60 * 1000);
  entry(".cache/uv/archive-v0/new1", 0.1);
  entry(".cache/uv/archive-v0/busy1", 0.1);
  entry(".cache/uv/archive-v0/now1", 0); // an install may be writing it
  entry(".bun/install/cache/zod@3.0.0@@@1", 1);
  const child = Bun.spawn(["sleep", "30"], { cwd: join(home, ".cache/uv/archive-v0/busy1") });
  const calls: string[][] = [];
  try {
    const sh = async (argv: string[]) => (calls.push(argv), argv[1] === "container" ? "" : PRUNED);
    expect(sweepCaches(home, { owned: true }).removed).toBe(0); // the default age is unchanged
    const r = await reclaim(home, cache, { owned: true }, sh);
    expect(ls(".cache/uv/archive-v0")).toEqual(["busy1", "now1"]);
    expect(ls(".bun/install/cache")).toEqual([]);
    expect(calls).toEqual([CONTAINER_LS, DOCKER_RECLAIM]);
    expect(DOCKER_RECLAIM).toEqual(["docker", "image", "prune", "-a", "-f"]);
    expect(r.removed).toBe(2 + 2); // two cache entries, two images
    expect(r.freedBytes).toBeGreaterThan(1.5e9);
    expect((await reclaim(home, cache, { owned: false }, sh)).removed).toBe(0);
    expect(calls.length).toBe(2);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("sweepNpm: the npm cache nothing touched within the age goes whole; a new one, one in use, and elsewhere stay; at age 0 a new one goes", async () => {
  entry(".npm/_cacache/content-v2", 15);
  age(join(home, ".npm/_cacache"), (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000); // the directory above it too: the whole tree is judged
  entry(".npm/_logs", 15); // npm's logs are not the cache
  expect(sweepNpm(home, { owned: false }).removed).toBe(0);
  const r = sweepNpm(home, { owned: true });
  expect(r.removed).toBe(1);
  expect(r.freedBytes).toBeGreaterThan(0);
  expect(ls(".npm")).toEqual(["_logs"]);
  entry(".npm/_cacache/content-v2", 1);
  age(join(home, ".npm/_cacache"), (Date.now() - 24 * 60 * 60 * 1000) / 1000);
  expect(sweepNpm(home, { owned: true }).removed).toBe(0); // a day old: under the age
  const child = Bun.spawn(["sleep", "30"], { cwd: join(home, ".npm/_cacache/content-v2") });
  try {
    expect(sweepNpm(home, { owned: true }, Date.now(), 0).removed).toBe(0); // in use stays even at age 0
  } finally {
    child.kill();
    await child.exited;
  }
  expect(sweepNpm(home, { owned: true }, Date.now(), 0).removed).toBe(1);
  expect(ls(".npm")).toEqual(["_logs"]);
  expect(sweepNpm(home, { owned: true }).removed).toBe(0); // none: nothing to do
});

/** A fake docker: `exited` maps a container id to when it stopped (hours ago; "bad" = unreadable); `rm`s are collected. */
function fakeDocker(exited: Record<string, number | "bad">) {
  const rm: string[] = [];
  const sh = async (argv: string[]) => {
    if (argv[2] === "ls") return Object.keys(exited).join("\n") + "\n";
    if (argv[2] === "inspect") {
      const h = exited[argv[5]!]!;
      return h === "bad" ? "not a time\n" : new Date(Date.now() - h * 3600 * 1000).toISOString().replace(/\.(\d{3})Z$/, ".$1123456Z") + "\n";
    }
    if (argv[2] === "rm") return rm.push(argv[3]!), argv[3]!;
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  return { sh, rm };
}

test("sweepStoppedContainers: only the containers that stopped over 24 hours ago are removed (by when they stopped, not when they were made); a recent one, an unreadable time and elsewhere stay", async () => {
  const d = fakeDocker({ old: 25, recent: 1, edge: 23, bad: "bad" });
  const r = await sweepStoppedContainers({ owned: true }, d.sh);
  expect(d.rm).toEqual(["old"]);
  expect(r.removed).toBe(1);
  const all = fakeDocker({ a: 1, b: 25 });
  await sweepStoppedContainers({ owned: true }, all.sh, Date.now(), 0);
  expect(all.rm).toEqual(["a", "b"]); // age 0
  const other = fakeDocker({ old: 25 });
  expect((await sweepStoppedContainers({ owned: false }, other.sh)).removed).toBe(0);
  expect(other.rm).toEqual([]);
  // the list never asks docker to judge by its own age, and no docker on the machine is nothing to do
  const calls: string[][] = [];
  await sweepStoppedContainers({ owned: true }, async (a) => (calls.push(a), ""));
  expect(calls).toEqual([CONTAINER_LS]);
  expect((await sweepStoppedContainers({ owned: true }, async () => { throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }); })).removed).toBe(0);
});

test("sweepStoppedContainers: one that cannot be removed (started again) is counted skipped and the rest still go", async () => {
  const d = fakeDocker({ a: 30, b: 30 });
  const sh = async (argv: string[]) => {
    if (argv[2] === "rm" && argv[3] === "a") throw new Error("container a is running");
    return d.sh(argv);
  };
  const r = await sweepStoppedContainers({ owned: true }, sh);
  expect(d.rm).toEqual(["b"]);
  expect(r).toMatchObject({ removed: 1, skipped: 1 });
});

test("reclaim: a review clone of a closed PR goes at age 0; an open PR, one GitHub does not answer for, one in use and a local-CI leftover under its age stay", async () => {
  const rootDir = join(cache, "ops-kit", "review");
  const make = async (name: string, url: string) => {
    const d = join(rootDir, name);
    mkdirSync(d, { recursive: true });
    await run(["git", "init", "-q", d], home);
    await run(["git", "remote", "add", "origin", url], d);
    writeFileSync(join(d, "f"), "x".repeat(4096));
    return d;
  };
  await make("switchboard.review30", "https://github.com/acme/app"); // closed, new
  await make("switchboard.review31", "https://github.com/acme/app"); // open
  await make("switchboard.review32", "https://github.com/acme/app"); // not told
  const busyDir = await make("switchboard.review33", "https://github.com/acme/app"); // closed, in use
  dir("switchboard.local-ci-4000.Ab12Cd", { fresh: true }); // new local-CI worktree: keeps its age
  const state = async (_repo: string, n: number) => (n === 31 ? "open" : n === 32 ? null : "closed");
  const child = Bun.spawn(["sleep", "30"], { cwd: busyDir });
  try {
    expect((await sweepCacheWork(cache, { owned: true }, Date.now(), state)).removed).toBe(0); // by age, none of them yet
    const r = await reclaim(home, cache, { owned: true }, async () => "", Date.now(), state);
    expect(readdirSync(rootDir).sort()).toEqual(["switchboard.review31", "switchboard.review32", "switchboard.review33"]);
    expect(readdirSync(cache)).toContain("switchboard.local-ci-4000.Ab12Cd");
    expect(r.removed).toBe(1);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("reclaim: an entry a running program was started from stays, though its cwd, executable and open files are elsewhere", async () => {
  const env = join(home, ".cache/uv/archive-v0/env1");
  entry(".cache/uv/archive-v0/env1", 0.1);
  writeFileSync(join(env, "late.js"), "export default 1;\n");
  writeFileSync(join(env, "main.js"), `console.log("ready"); for await (const _ of console) { try { await import(${JSON.stringify(join(env, "late.js"))}); console.log("loaded"); } catch { console.log("gone"); } break; }\n`);
  age(env, (Date.now() - 0.1 * 24 * 60 * 60 * 1000) / 1000);
  const child = Bun.spawn([process.execPath, join(env, "main.js")], { cwd: home, stdin: "pipe", stdout: "pipe" });
  const out = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await out.read()).value)).toContain("ready");
    await reclaim(home, cache, { owned: true }, async () => "");
    child.stdin.write("go\n");
    child.stdin.flush();
    expect(new TextDecoder().decode((await out.read()).value)).toContain("loaded");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("reclaim: an entry in use stays when the cache folder is reached through a symbolic link", async () => {
  const real = join(realpathSync(home), "moved/uv");
  mkdirSync(join(real, "archive-v0/busy1"), { recursive: true });
  writeFileSync(join(real, "archive-v0/busy1/f"), "x");
  age(join(real, "archive-v0/busy1"), (Date.now() - 0.1 * 24 * 60 * 60 * 1000) / 1000);
  mkdirSync(join(home, ".cache/uv"), { recursive: true });
  rmSync(join(home, ".cache/uv"), { recursive: true });
  symlinkSync(real, join(home, ".cache/uv"));
  const child = Bun.spawn(["sleep", "30"], { cwd: join(real, "archive-v0/busy1") });
  try {
    await reclaim(home, cache, { owned: true }, async () => "");
    expect(existsSync(join(real, "archive-v0/busy1"))).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("reclaim: one kind's failure does not stop the other or lose its result", async () => {
  const locked = join(home, ".cache/uv/locked-v0");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0);
  const calls: string[][] = [];
  try {
    const r = await reclaim(home, cache, { owned: true }, async (a) => (calls.push(a), ""));
    expect(calls).toEqual([CONTAINER_LS, DOCKER_RECLAIM]); // the folder that cannot be read did not stop docker
    expect(r.skipped).toBe(1);
  } finally {
    chmodSync(locked, 0o700);
  }
  entry(".cache/uv/archive-v0/old1", 0.1);
  const r = await reclaim(home, cache, { owned: true }, async () => Promise.reject(new Error("docker exited 1: x")));
  expect(existsSync(join(home, ".cache/uv/archive-v0/old1"))).toBe(false);
  expect(r.removed).toBe(1); // the cache entry, kept though docker failed
  expect(r.skipped).toBe(2); // the stopped containers and the images
});

test("reclaim: an entry whose file a running program has mapped stays, though nothing else names it", async () => {
  const env = join(home, ".cache/uv/archive-v0/lib1");
  entry(".cache/uv/archive-v0/lib1", 0.1);
  const lib = join(env, "f");
  // the path is only inside the script's text, not an argument of its own: the command line does not count it, the mapping does
  const child = Bun.spawn([process.execPath, "-e", `const m = Bun.mmap(${JSON.stringify(lib)}); console.log("ready", m.length); await Bun.sleep(30000);`], { cwd: home, stdout: "pipe" });
  try {
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("ready");
    await reclaim(home, cache, { owned: true }, async () => "");
    expect(existsSync(lib)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("reclaim: npm's cache stays while a running program has a file in it mapped, and while it was written within the hour", async () => {
  entry(".npm/_cacache/index-v5/aa", 0.1);
  age(join(home, ".npm/_cacache"), (Date.now() - 0.1 * 24 * 60 * 60 * 1000) / 1000); // the folders above it too: the cache goes as a whole
  const file = join(home, ".npm/_cacache/index-v5/aa/f");
  const child = Bun.spawn([process.execPath, "-e", `const m = Bun.mmap(${JSON.stringify(file)}); console.log("ready", m.length); await Bun.sleep(30000);`], { cwd: home, stdout: "pipe" });
  try {
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("ready");
    await reclaim(home, cache, { owned: true }, async () => "");
    expect(existsSync(file)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
  entry(".npm/_cacache/index-v5/bb", 0); // just written: an install may be at work
  await reclaim(home, cache, { owned: true }, async () => "");
  expect(existsSync(join(home, ".npm/_cacache"))).toBe(true);
});

test("reclaim: a closed PR's review clone that a running program was started from stays", async () => {
  const clone = join(cache, "ops-kit/review/app.review30");
  mkdirSync(clone, { recursive: true });
  await run(["git", "init", "-q", clone], home);
  await run(["git", "remote", "add", "origin", "https://github.com/acme/app"], clone);
  writeFileSync(join(clone, "main.js"), `console.log("ready"); await Bun.sleep(30000);\n`);
  const child = Bun.spawn([process.execPath, join(clone, "main.js")], { cwd: home, stdout: "pipe" });
  try {
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("ready");
    await reclaim(home, cache, { owned: true }, async () => "", Date.now(), async () => "closed");
    expect(existsSync(clone)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
  }
});
