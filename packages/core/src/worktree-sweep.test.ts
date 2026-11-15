// test-reads: none
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorktreeSweep, sweepWorktrees, WORKTREE_STALE_MS, worktreeKeep } from "./worktree-sweep.ts";

const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

let root: string, repo: string, cache: string;
const NOW = Date.now() + 3 * WORKTREE_STALE_MS; // every file just written reads as old at NOW
let n = 0;
/** A worktree on a new branch from main beside the main tree (`repo-wt<N>`, like a Task's), with `setup` run in it; `at` / `name` put it elsewhere. */
function worktree(setup: (dir: string) => void = () => {}, o: { at?: string; name?: string } = {}): string {
  const dir = join(o.at ?? root, o.name ?? `repo-wt${n}`);
  n++;
  sh(repo, "worktree", "add", "-q", "-b", `b${n}`, dir, "main");
  setup(dir);
  return dir;
}
const commit = (dir: string, file = "f.txt") => {
  writeFileSync(join(dir, file), `${Math.random()}`);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "c");
};
const whyOf = (r: Awaited<ReturnType<typeof sweepWorktrees>>, dir: string) => r.kept.find((k) => k.path === dir)?.why;
const sweep = (o: Parameters<typeof sweepWorktrees>[1] = {}) => sweepWorktrees([repo], { now: NOW, cacheDir: cache, ...o });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "switchboard.wtsweep."));
  cache = join(root, "cache");
  mkdirSync(cache);
  const origin = join(root, "origin.git");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  repo = join(root, "repo");
  sh(root, "clone", "-q", origin, repo);
  sh(repo, "checkout", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  commit(repo, "base.txt");
  sh(repo, "push", "-q", "-u", "origin", "main");
  sh(repo, "remote", "set-head", "origin", "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("sweepWorktrees", () => {
  test("removes a clean old worktree whose commits are all in the default branch, also when the merge changed their sha", async () => {
    const merged = worktree((d) => commit(d, "m.txt"));
    // the same change lands on main as a new commit (a rebase merge): same patch, other sha
    writeFileSync(join(repo, "m.txt"), readPatchFile(merged));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "rebased");
    sh(repo, "push", "-q", "origin", "main");
    const untouched = worktree();
    const r = await sweepWorktrees([repo], { now: NOW, cacheDir: cache });
    expect(r.removed).toContain(merged);
    expect(r.removed).toContain(untouched);
    expect(existsSync(merged)).toBe(false);
    expect(sh(repo, "worktree", "list")).not.toContain(merged);
  });

  test("keeps a worktree with a commit the default branch does not have", async () => {
    const d = worktree((x) => commit(x, "own.txt"));
    const r = await sweep();
    expect(whyOf(r, d)).toBe("commits not in the default branch");
    expect(existsSync(d)).toBe(true);
  });

  test("reads a new untracked file as a change also where the repository hides untracked files from git status", async () => {
    const d = worktree((x) => writeFileSync(join(x, "new.txt"), "x"));
    sh(repo, "config", "status.showUntrackedFiles", "no");
    try {
      expect(whyOf(await sweep(), d)).toBe("changes");
    } finally {
      sh(repo, "config", "--unset", "status.showUntrackedFiles");
    }
  });

  test("keeps a worktree with an uncommitted change or a new untracked file", async () => {
    const edited = worktree((x) => writeFileSync(join(x, "base.txt"), "edited"));
    const untracked = worktree((x) => writeFileSync(join(x, "new.txt"), "x"));
    const r = await sweep();
    expect(whyOf(r, edited)).toBe("changes");
    expect(whyOf(r, untracked)).toBe("changes");
  });

  test("keeps a worktree with an ignored .env, and removes one whose ignored files are generated output", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules\ndist\n.env\n.env.*\ngenerated/\n*.tsbuildinfo\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "ignore");
    sh(repo, "push", "-q", "origin", "main");
    const env = worktree((x) => writeFileSync(join(x, ".env"), "K=v"));
    // a dependency's own `.env.example` is not this worktree's settings file
    const dep = worktree((x) => {
      mkdirSync(join(x, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(x, "node_modules", "pkg", ".env.example"), "K=");
    });
    const envLocal = worktree((x) => writeFileSync(join(x, ".env.local"), "K=v"));
    // inside a directory ignored as a whole, and under a non-ASCII name: `git status` would show neither
    const envDeep = worktree((x) => {
      mkdirSync(join(x, "generated", "設定"), { recursive: true });
      writeFileSync(join(x, "generated", "設定", ".env"), "K=v");
    });
    const built = worktree((x) => {
      mkdirSync(join(x, "apps", "web", "dist"), { recursive: true });
      writeFileSync(join(x, "apps", "web", "dist", "a.js"), "x");
      mkdirSync(join(x, "src", "generated"), { recursive: true });
      writeFileSync(join(x, "src", "generated", "t.ts"), "x");
      writeFileSync(join(x, "tsconfig.tsbuildinfo"), "x");
    });
    const r = await sweep();
    expect(whyOf(r, env)).toBe("ignored settings file");
    expect(whyOf(r, envLocal)).toBe("ignored settings file");
    expect(whyOf(r, envDeep)).toBe("ignored settings file");
    expect(whyOf(r, built)).toBeUndefined();
    expect(r.removed).toContain(built);
    expect(r.removed).toContain(dep);
  });

  test("keeps a worktree something changed within a day, but reads node_modules as old", async () => {
    const fresh = worktree();
    const nm = worktree((x) => {
      mkdirSync(join(x, "node_modules"));
      writeFileSync(join(x, "node_modules", "a.js"), "x");
    });
    // `now` sits a day and a bit after the old ones; only `fresh` has a file newer than that
    const t = new Date(NOW - 1000);
    utimesSync(join(fresh, "base.txt"), t, t); // touched, not changed: git status stays clean
    utimesSync(join(nm, "node_modules", "a.js"), t, t);
    utimesSync(join(nm, "node_modules"), t, t);
    const r = await sweep();
    expect(whyOf(r, fresh)).toBe("recent");
    expect(r.removed).toContain(nm);
  });

  test("keeps a recent clean worktree (the files are younger than a day)", async () => {
    const d = worktree();
    const r = await sweep({ now: Date.now() });
    expect(whyOf(r, d)).toBe("recent");
  });

  test("keeps a locked worktree, one under the cache directory, and the main working tree", async () => {
    const locked = worktree();
    sh(repo, "worktree", "lock", locked);
    const cached = worktree(() => {}, { at: cache });
    const r = await sweep();
    expect(whyOf(r, locked)).toBe("locked");
    expect(whyOf(r, cached)).toBe("cache");
    expect(r.removed).not.toContain(repo);
    expect(r.kept.some((k) => k.path === repo)).toBe(false);
    expect(existsSync(repo)).toBe(true);
  });

  test("keeps a worktree a process uses, and everything when the processes cannot be listed", async () => {
    const d = worktree();
    const proc = mkdtempSync(join(root, "proc."));
    for (const pid of [String(process.pid), "999999"]) mkdirSync(join(proc, pid));
    Bun.spawnSync(["ln", "-s", d, join(proc, "999999", "cwd")]);
    expect(whyOf(await sweep({ proc }), d)).toBe("in use");
    const other = worktree();
    expect(whyOf(await sweep({ proc: join(root, "no-such-proc") }), other)).toBe("use unknown");
  });

  test("keeps the worktrees that are not a Task's: under the main tree, or beside it under another name", async () => {
    const inside = worktree(() => {}, { at: join(repo, ".claude", "worktrees"), name: "teleport-x" });
    const other = worktree(() => {}, { name: `other-${n}` });
    const r = await sweep();
    expect(whyOf(r, inside)).toBe("not a Task worktree");
    expect(whyOf(r, other)).toBe("not a Task worktree");
    expect(existsSync(inside)).toBe(true);
  });

  test("keeps everything when its own process is not listed (/proc mounted with hidepid)", async () => {
    const d = worktree();
    const proc = mkdtempSync(join(root, "proc."));
    mkdirSync(join(proc, "999999"));
    expect(whyOf(await sweep({ proc }), d)).toBe("use unknown");
  });

  test("keeps a worktree named on the command line of a process whose links cannot be read", async () => {
    const d = worktree();
    const proc = mkdtempSync(join(root, "proc."));
    mkdirSync(join(proc, String(process.pid)));
    const hid = join(proc, "999999");
    mkdirSync(join(hid, "fd"), { recursive: true });
    writeFileSync(join(hid, "cmdline"), `bun\0test\0${d}\0`);
    chmodSync(join(hid, "fd"), 0o000);
    try {
      expect(whyOf(await sweep({ proc }), d)).toBe("in use");
    } finally {
      chmodSync(join(hid, "fd"), 0o755);
    }
  });

  test("prunes the record of a worktree whose directory is already gone", async () => {
    const d = worktree();
    rmSync(d, { recursive: true, force: true });
    expect(sh(repo, "worktree", "list")).toContain(d);
    await sweep();
    expect(sh(repo, "worktree", "list")).not.toContain(d);
  });

  test("keeps a worktree that is, or holds, the folder of a Task not finished or a workspace", async () => {
    const own = worktree();
    const inner = worktree((x) => mkdirSync(join(x, "packages")));
    const r = await sweep({ keep: [own, join(inner, "packages")] });
    expect(whyOf(r, own)).toBe("a Task's folder or a workspace");
    expect(whyOf(r, inner)).toBe("a Task's folder or a workspace");
    expect(existsSync(own)).toBe(true);
  });

  test("dryRun names what would go and removes nothing", async () => {
    const d = worktree();
    const r = await sweep({ dryRun: true });
    expect(r.removed).toContain(d);
    expect(existsSync(d)).toBe(true);
  });
});

function readPatchFile(dir: string): string {
  return readFileSync(join(dir, "m.txt"), "utf8");
}

describe("worktreeKeep", () => {
  test("keeps every workspace and the folder of every Task but an aborted one, done included", () => {
    const keep = worktreeKeep([{ path: "/r/a" }], [
      { cwd: "/r/a-done", status: "done" },
      { cwd: "/r/a-wait", status: "waiting" },
      { cwd: "/r/a-err", status: "error" },
      { cwd: "/r/a-gone", status: "aborted" },
      { cwd: "/r/a-done", status: "idle" },
    ]);
    expect(keep.sort()).toEqual(["/r/a", "/r/a-done", "/r/a-err", "/r/a-wait"]);
  });
});

describe("startWorktreeSweep", () => {
  test("does not start on a candidate daemon", () => {
    let calls = 0;
    const stop = startWorktreeSweep({ candidate: true, read: () => ({ workspaces: [], tasks: [] }), sweep: async () => { calls++; return { removed: [], kept: [] }; }, firstMs: 1, everyMs: 1 });
    expect(stop).toBeNull();
    return new Promise<void>((done) => setTimeout(() => { expect(calls).toBe(0); done(); }, 30));
  });

  test("sweeps the workspaces' repositories with worktreeKeep's paths kept, and stops", async () => {
    const seen: { repos: string[]; keep?: string[] }[] = [];
    const stop = startWorktreeSweep({
      candidate: false,
      read: () => ({ workspaces: [{ path: "/r/a" }], tasks: [{ cwd: "/r/a-x", status: "done" }] }),
      sweep: async (repos, o) => { seen.push({ repos, keep: o?.keep }); return { removed: [], kept: [] }; },
      firstMs: 1,
      everyMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 30));
    stop?.();
    expect(seen).toEqual([{ repos: ["/r/a"], keep: ["/r/a", "/r/a-x"] }]);
  });
});
