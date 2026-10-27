/**
 * What else fills the host's disk besides /tmp (#2549): the working directories local CI leaves under ~/.cache when it is killed
 * before its `finally`, and its failure logs, one per PR. Judged like /tmp (`inspect` / `inUse` in tmp.ts) and swept on the same timer.
 * Only `node:` here: sb-rescue shares no code with Switchboard (#178).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { run } from "./releases.ts";
import { inspect, inUse, type TmpEntry, type TmpJudge, type TmpSweep } from "./tmp.ts";

/** A working directory under ~/.cache has to be left alone this long (itself and everything in it) before it goes. */
export const CACHE_WORK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The names under ~/.cache that can go, matched against the whole name: what scripts/local-ci.ts and the kit's local CI make,
 * for any repository (`<repo>.` is switchboard, capsule-host, …). On any machine: only Switchboard and its kit make these.
 */
export const CACHE_WORK: RegExp[] = [
  /^[\w.-]+\.local-ci-\d+\.[A-Za-z0-9]{6}$/, // the worktree: <repo>.local-ci-<PR>.XXXXXX
  /^[\w.-]+\.local-ci-\d+-base\.[A-Za-z0-9]{6}$/, // main's worktree a perf failure measures: <repo>.local-ci-<PR>-base.XXXXXX
  /^[\w.-]+\.local-ci-[\w.-]+-\d+-log\.[A-Za-z0-9]{6}$/, // a failure's log: <repo>.local-ci-<owner_repo>-<PR>-log.XXXXXX
];

/** The repository's git directory a worktree belongs to (`gitdir: <repo>/.git/worktrees/<name>` in its .git file), or null. */
function ownerGitDir(dir: string): string | null {
  try {
    const dotGit = join(dir, ".git");
    if (!lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const gitdir = resolve(dir, m[1]!.trim());
    return basename(dirname(gitdir)) === "worktrees" ? dirname(dirname(gitdir)) : null;
  } catch {
    return null;
  }
}

/**
 * Removes every local-CI leftover under `cacheDir` that is removable right now, then lets the repositories they were worktrees
 * of forget them (`git worktree prune`). A prune that fails is logged, not counted: the directory is gone either way.
 */
export async function sweepCacheWork(cacheDir: string, judge: TmpJudge, now = Date.now()): Promise<TmpSweep> {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!existsSync(cacheDir)) return sweep;
  const busy = inUse(cacheDir, judge.proc);
  const gitDirs = new Set<string>();
  // only the names that can go are measured: walking ~/.cache/uv and the like every sweep would hold the page up
  for (const name of readdirSync(cacheDir).filter((n) => CACHE_WORK.some((re) => re.test(n)))) {
    let entry: TmpEntry;
    try {
      entry = inspect(cacheDir, name, now, busy, CACHE_WORK, CACHE_WORK_STALE_MS);
    } catch {
      continue; // gone since readdir
    }
    if (!entry.removable) continue;
    const gitDir = ownerGitDir(join(cacheDir, name));
    try {
      rmSync(join(cacheDir, name), { recursive: true, force: true });
    } catch (e) {
      sweep.skipped++;
      console.error(`cache sweep: ${name}:`, e);
      continue;
    }
    sweep.removed++;
    sweep.freedBytes += entry.bytes;
    if (gitDir) gitDirs.add(gitDir);
  }
  for (const gitDir of gitDirs) {
    if (!existsSync(gitDir)) continue;
    await run(["git", "--git-dir", gitDir, "worktree", "prune"], cacheDir).catch((e) => console.error("cache sweep: worktree prune failed:", e));
  }
  return sweep;
}

/** A cache entry (uv's, bun's) has to be left alone this long before it goes; whatever needs it again fetches it again. */
export const CACHE_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Any name but a dot-name (bun's .tmp, uv's .lock / .gitignore stay). */
const ANY: RegExp[] = [/^[^.]/];

/**
 * Removes the uv and bun package-cache entries nothing touched within CACHE_STALE_MS: uv's `~/.cache/uv/<bucket>/<entry>`,
 * bun's `~/.bun/install/cache/<entry>` and `…/@<scope>/<entry>`. Only where the machine is Switchboard's alone
 * (`judge.owned`): elsewhere the user's other apps share these caches. Each folder's processes are read once, and the
 * folders under it again only when something under that one is in use.
 */
export function sweepCaches(home: string, judge: TmpJudge, now = Date.now()): TmpSweep {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!judge.owned) return sweep;
  const uv = join(home, ".cache", "uv");
  const bun = join(home, ".bun", "install", "cache");
  const subdirs = (root: string, keep: (n: string) => boolean) => {
    try {
      return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && keep(d.name)).map((d) => join(root, d.name));
    } catch {
      return [];
    }
  };
  /** The folders under `root` whose entries are judged, each with its in-use names (`top`: root's; null = unknown). */
  const under = (root: string, top: Set<string> | null, keep: (n: string) => boolean) =>
    subdirs(root, keep).map((dir) => ({ dir, busy: !top ? null : top.has(basename(dir)) ? inUse(dir, judge.proc) : new Set<string>() }));
  const bunTop = inUse(bun, judge.proc);
  const targets = [
    ...under(uv, inUse(uv, judge.proc), (n) => !n.startsWith(".")),
    ...(existsSync(bun) ? [{ dir: bun, busy: bunTop }] : []),
    ...under(bun, bunTop, (n) => n.startsWith("@")),
  ];
  for (const { dir, busy } of targets) {
    for (const name of readdirSync(dir)) {
      if (dir === bun && name.startsWith("@")) continue; // a scope: its entries are judged one level down
      let entry: TmpEntry;
      try {
        entry = inspect(dir, name, now, busy, ANY, CACHE_STALE_MS);
      } catch {
        continue;
      }
      if (!entry.removable) continue;
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch (e) {
        sweep.skipped++;
        console.error(`cache sweep: ${join(dir, name)}:`, e);
        continue;
      }
      sweep.removed++;
      sweep.freedBytes += entry.bytes;
    }
  }
  return sweep;
}

/** The images docker can take back: ones no container (running or stopped) uses, made over a day ago. */
export const DOCKER_PRUNE = ["docker", "image", "prune", "-a", "-f", "--filter", "until=24h"];

/** docker's sizes ("1.2GB", "512kB", "0B") are decimal (go-units' HumanSize). */
const DOCKER_UNITS: Record<string, number> = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };
const dockerBytes = (size: string) => {
  const m = /^([\d.]+)([kKMGT]?)B$/.exec(size);
  return m ? Math.round(Number(m[1]) * DOCKER_UNITS[m[2]!.toLowerCase()]!) : 0;
};

/**
 * Lets docker remove the images no container uses (`DOCKER_PRUNE`: docker itself keeps the ones a container uses). Only where
 * the machine is Switchboard's alone. No docker on the machine is 0 removed; any other failure throws.
 */
export async function sweepDocker(judge: TmpJudge, sh: (argv: string[]) => Promise<string> = (a) => run(a, homedir()), now = Date.now()): Promise<TmpSweep> {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!judge.owned) return sweep;
  let out: string;
  try {
    out = await sh(DOCKER_PRUNE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || / exited 127:/.test(String((e as Error).message))) return sweep;
    throw e;
  }
  sweep.removed = out.split("\n").filter((l) => /^deleted:/i.test(l.trim())).length;
  sweep.freedBytes = dockerBytes(/Total reclaimed space:\s*(\S+)/.exec(out)?.[1] ?? "");
  return sweep;
}
