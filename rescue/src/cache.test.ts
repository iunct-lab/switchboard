import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_STALE_MS, CACHE_WORK_STALE_MS, DOCKER_PRUNE, sweepCaches, sweepCacheWork, sweepDocker } from "./cache.ts";
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

test("sweepCacheWork: old local-CI worktrees, base worktrees and any PR's old logs go, and the repository forgets the worktrees; new, in-use and other names stay (#2549)", async () => {
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
const PRUNED = "Deleted Images:\nuntagged: alpine:3.19\ndeleted: sha256:aaa\ndeleted: sha256:bbb\n\nTotal reclaimed space: 1.5GB\n";

test("sweepCaches / sweepDocker on a machine of Switchboard's own: uv's and bun's entries untouched for CACHE_STALE_MS go, new ones and dot-names stay; docker prunes the unused images (#2711)", async () => {
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

test("sweepCaches / sweepDocker elsewhere: the caches the user's other apps share stay and docker is not called (#2711)", async () => {
  entry(".cache/uv/archive-v0/old1", 15);
  entry(".bun/install/cache/left-pad@1.3.0@@@1", 15);
  expect(sweepCaches(home, { owned: false }).removed).toBe(0);
  expect(ls(".cache/uv/archive-v0")).toEqual(["old1"]);
  expect(ls(".bun/install/cache")).toEqual(["left-pad@1.3.0@@@1"]);
  const calls: string[][] = [];
  expect((await sweepDocker({ owned: false }, async (argv) => (calls.push(argv), PRUNED))).removed).toBe(0);
  expect(calls).toEqual([]);
});

test("sweepCaches: an entry a running process uses stays, and without the running processes nothing goes (#2711)", async () => {
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
