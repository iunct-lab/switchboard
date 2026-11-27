/**
 * What else fills the host's disk besides /tmp: the working directories local CI and hand-run checks leave under ~/.cache when they are killed
 * before its `finally`, and its failure logs, one per PR; and the review clones the kit leaves under ~/.cache/ops-kit/review (a clone goes only
 * once `gh` says its PR is closed); and the screens audit's work directory, and on a machine of Switchboard's own any `mktemp`-named directory
 * a Task named by hand (`CACHE_WORK_OWNED`). Judged like /tmp (`inspect` / `inUse` in tmp.ts) and swept on the same timer.
 * Only `node:` here: sb-rescue shares no code with Switchboard.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { run } from "./releases.ts";
import { inspect, inUse, type TmpEntry, type TmpJudge, type TmpSweep } from "./tmp.ts";

/** A working directory under ~/.cache has to be left alone this long (itself and everything in it) before it goes. */
export const CACHE_WORK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The names under ~/.cache that can go, matched against the whole name: what scripts/local-ci.ts and the kit's local CI make, a check run by hand or by tag-ci, and scripts/screens-audit.ts,
 * for any repository (`<repo>.` is switchboard, capsule-host, …). On any machine: only Switchboard and its kit make these.
 */
export const CACHE_WORK: RegExp[] = [
  /^[\w.-]+\.local-ci-\d+\.[A-Za-z0-9]{6}$/, // the worktree: <repo>.local-ci-<PR>.XXXXXX
  /^[\w.-]+\.local-ci-\d+-base\.[A-Za-z0-9]{6}$/, // main's worktree a perf failure measures: <repo>.local-ci-<PR>-base.XXXXXX
  /^[\w.-]+\.local-ci-[\w.-]+-\d+-log\.[A-Za-z0-9]{6}$/, // a failure's log: <repo>.local-ci-<owner_repo>-<PR>-log.XXXXXX
  /^[\w.-]+\.(?:e2e(?:-\d+)?|duration(?:-\d+)?|tag-ci(?:-[\w.-]+)?)\.(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}$/, // a check's copy of the database or the tree, tag-ci's log too: <repo>.e2e.XXXXXX, <repo>.duration-<n>.XXXXXX; mktemp's suffix, so not myapp.e2e.report
  /^[\w.-]+\.screens-audit\.(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}$/, // the screens audit's work directory: <repo>.screens-audit.XXXXXX
];

/**
 * A name made by hand with `mktemp` (`<name>.XXXXXX`, a capital or a digit in the suffix). Nothing in the name says what made it, so these go only
 * where the machine is Switchboard's alone (`judge.owned`), like `/tmp`'s shared kind; elsewhere another application's directory could look the same.
 */
export const CACHE_WORK_OWNED: RegExp[] = [/^[\w-]+(?:\.[\w-]+)*\.(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6}$/];

/** The review clones cross-runner-review leaves under `<cacheDir>/ops-kit/review`: <repo>.review<PR> / <repo>.recheck<PR>, matched against the whole name. */
export const REVIEW_CLONE = /^[\w.-]+\.(?:review|recheck)(\d+)$/;

/** The state of a pull request ("open" / "closed", merged included) from GitHub's REST API (not GraphQL: its quota is spent elsewhere), or null when it cannot be told. */
async function ghPrState(repo: string, n: number, cwd: string): Promise<string | null> {
  try {
    // bounded: a connection that hangs would hold this sweep (and the ones after it) forever
    return (await run(["timeout", "60", "gh", "api", `repos/${repo}/pulls/${n}`, "--jq", ".state"], cwd)) || null;
  } catch {
    return null;
  }
}

/** `<owner>/<name>` of a clone's origin when that is on GitHub, or null. */
async function originRepo(dir: string): Promise<string | null> {
  try {
    const url = await run(["git", "-C", dir, "remote", "get-url", "origin"], dir);
    return /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

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
 * Removes every local-CI leftover under `cacheDir` that is removable right now, and the old review clones under `<cacheDir>/ops-kit/review`
 * (a local change's worktree by age alone; a clone only when `prState` says its PR is closed, left alone `reviewStaleMs`), then lets the repositories they were worktrees
 * of forget them (`git worktree prune`). A prune that fails is logged, not counted: the directory is gone either way.
 */
export async function sweepCacheWork(
  cacheDir: string,
  judge: TmpJudge,
  now = Date.now(),
  prState: (repo: string, n: number) => Promise<string | null> = (repo, n) => ghPrState(repo, n, cacheDir),
  reviewStaleMs = CACHE_WORK_STALE_MS,
): Promise<TmpSweep> {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!existsSync(cacheDir)) return sweep;
  const busy = inUse(cacheDir, judge.proc);
  const gitDirs = new Set<string>();
  const kinds = judge.owned ? [...CACHE_WORK, ...CACHE_WORK_OWNED] : CACHE_WORK;
  // only the names that can go are measured: walking ~/.cache/uv and the like every sweep would hold the page up
  for (const name of readdirSync(cacheDir).filter((n) => kinds.some((re) => re.test(n)))) {
    let entry: TmpEntry;
    try {
      entry = inspect(cacheDir, name, now, busy, kinds, CACHE_WORK_STALE_MS);
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
  // the review clones: a worktree of a local change goes by age alone; a clone only once GitHub says its PR is closed (not told: it stays), and
  // that after `reviewStaleMs` (0 when the disk is short: the closed PR is the reason, not the age)
  const reviewRoot = join(cacheDir, "ops-kit", "review");
  if (existsSync(reviewRoot)) {
    const deep = reviewStaleMs < CACHE_WORK_STALE_MS; // a clone that does not wait for its age (the reclaim): command lines and mapped files count too
    const reviewBusy = inUse(reviewRoot, judge.proc, deep);
    for (const name of readdirSync(reviewRoot).filter((n) => REVIEW_CLONE.test(n))) {
      const path = join(reviewRoot, name);
      let entry: TmpEntry;
      try {
        const gitDir = ownerGitDir(path);
        entry = inspect(reviewRoot, name, now, reviewBusy, [REVIEW_CLONE], gitDir ? CACHE_WORK_STALE_MS : reviewStaleMs); // a local change's worktree keeps its age
        if (!entry.removable) continue;
        if (!gitDir) {
          if (!lstatSync(join(path, ".git"), { throwIfNoEntry: false })?.isDirectory()) continue; // a .git file that names no worktree, or none at all: not a gh clone
          const repo = await originRepo(path);
          if (!repo || (await prState(repo, Number(REVIEW_CLONE.exec(name)![1]))) !== "closed") continue;
          entry = inspect(reviewRoot, name, now, inUse(reviewRoot, judge.proc, deep), [REVIEW_CLONE], reviewStaleMs); // judged again after the wait
          if (!entry.removable) continue;
        }
        rmSync(path, { recursive: true, force: true });
        if (gitDir) gitDirs.add(gitDir);
      } catch (e) {
        if (existsSync(path)) {
          sweep.skipped++;
          console.error(`cache sweep: ${name}:`, e);
        }
        continue;
      }
      sweep.removed++;
      sweep.freedBytes += entry.bytes;
    }
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
export function sweepCaches(home: string, judge: TmpJudge, now = Date.now(), staleMs = CACHE_STALE_MS, deep = false): TmpSweep {
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
    subdirs(root, keep).map((dir) => ({ dir, busy: !top ? null : top.has(basename(dir)) ? inUse(dir, judge.proc, deep) : new Set<string>() }));
  const bunTop = inUse(bun, judge.proc, deep);
  const targets = [
    ...under(uv, inUse(uv, judge.proc, deep), (n) => !n.startsWith(".")),
    ...(existsSync(bun) ? [{ dir: bun, busy: bunTop }] : []),
    ...under(bun, bunTop, (n) => n.startsWith("@")),
  ];
  for (const { dir, busy } of targets) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      sweep.skipped++; // one folder that cannot be read does not stop the others
      console.error(`cache sweep: ${dir}:`, e);
      continue;
    }
    for (const name of names) {
      if (dir === bun && name.startsWith("@")) continue; // a scope: its entries are judged one level down
      let entry: TmpEntry;
      try {
        entry = inspect(dir, name, now, busy, ANY, staleMs);
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

/** The npm cache (`~/.npm/_cacache`): a download cache, fetched again when needed. */
const NPM_CACHE = [/^_cacache$/];

/**
 * Removes `~/.npm/_cacache` whole when nothing in it was touched within `staleMs` and no running process uses it (npm's own
 * `cache clean` needs --force and is no better at telling what is in use). Only where the machine is Switchboard's alone.
 */
export function sweepNpm(home: string, judge: TmpJudge, now = Date.now(), staleMs = CACHE_STALE_MS, deep = false): TmpSweep {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!judge.owned) return sweep;
  const root = join(home, ".npm");
  if (!existsSync(join(root, "_cacache"))) return sweep;
  let entry: TmpEntry;
  try {
    entry = inspect(root, "_cacache", now, inUse(root, judge.proc, deep), NPM_CACHE, staleMs);
  } catch {
    return sweep;
  }
  if (!entry.removable) return sweep;
  try {
    rmSync(join(root, "_cacache"), { recursive: true, force: true });
  } catch (e) {
    sweep.skipped++;
    console.error("cache sweep: npm:", e);
    return sweep;
  }
  sweep.removed++;
  sweep.freedBytes += entry.bytes;
  return sweep;
}

/** A stopped container has to have been stopped this long before it goes. */
export const CONTAINER_STOPPED_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the containers that stopped at least `stoppedMs` ago, chosen by `State.FinishedAt` (the time it stopped; `docker container prune
 * --filter until` reads the time it was made, which would take one a Task stopped a moment ago). `rm` without `-f`, so one that started again
 * since the list is refused and counted as skipped. Only where the machine is Switchboard's alone; no docker is 0 removed.
 */
export async function sweepStoppedContainers(judge: TmpJudge, sh: (argv: string[]) => Promise<string> = (a) => run(a, homedir()), now = Date.now(), stoppedMs = CONTAINER_STOPPED_MS): Promise<TmpSweep> {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!judge.owned) return sweep;
  let ids: string[];
  try {
    ids = (await sh(["docker", "container", "ls", "-a", "--filter", "status=exited", "--format", "{{.ID}}"])).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || / exited 127:/.test(String((e as Error).message))) return sweep;
    throw e;
  }
  for (const id of ids) {
    try {
      const finished = Date.parse((await sh(["docker", "container", "inspect", "--format", "{{.State.FinishedAt}}", id])).trim().replace(/(\.\d{3})\d*/, "$1"));
      if (!Number.isFinite(finished) || finished < Date.UTC(2000, 0, 1) || now - finished < stoppedMs) continue; // not told, never run, or stopped too lately: it stays
      await sh(["docker", "container", "rm", id]);
      sweep.removed++;
    } catch (e) {
      sweep.skipped++;
      console.error(`container sweep: ${id}:`, e);
    }
  }
  return sweep;
}

/** The images docker can take back: ones no container (running or stopped) uses, made over a day ago. */
export const DOCKER_PRUNE = ["docker", "image", "prune", "-a", "-f", "--filter", "until=24h"];
/** The same without the age: what `reclaim` asks when the disk is short. Docker still keeps the images a container uses. */
export const DOCKER_RECLAIM = DOCKER_PRUNE.slice(0, -2);

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
export async function sweepDocker(judge: TmpJudge, sh: (argv: string[]) => Promise<string> = (a) => run(a, homedir()), now = Date.now(), argv: string[] = DOCKER_PRUNE): Promise<TmpSweep> {
  const sweep: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  if (!judge.owned) return sweep;
  let out: string;
  try {
    out = await sh(argv);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || / exited 127:/.test(String((e as Error).message))) return sweep;
    throw e;
  }
  sweep.removed = out.split("\n").filter((l) => /^deleted:/i.test(l.trim())).length;
  sweep.freedBytes = dockerBytes(/Total reclaimed space:\s*(\S+)/.exec(out)?.[1] ?? "");
  return sweep;
}

/**
 * How long `reclaim` still leaves a cache entry alone: one being written by an install that does not hold it open yet (bun and
 * uv write an entry, then link it) is not seen as in use, and an hour is far past any install.
 */
export const RECLAIM_STALE_MS = 60 * 60 * 1000;

/**
 * What the disk being short asks for: what the caches and docker can make again, without waiting for their ages (cache
 * entries only RECLAIM_STALE_MS; the review clones of a closed PR and the containers stopped over a day ago keep their
 * condition: the PR closed, the stop a day old). What is in use stays (`inUse` with the command lines and mapped files too
 * for the caches and the review clones, docker itself for the images). Only where the machine is Switchboard's alone, like the sweeps. One kind's
 * failure does not stop the others or lose their results: it is logged and counted as skipped.
 */
export async function reclaim(
  home: string,
  cacheDir: string,
  judge: TmpJudge,
  sh?: (argv: string[]) => Promise<string>,
  now = Date.now(),
  prState?: (repo: string, n: number) => Promise<string | null>,
): Promise<TmpSweep> {
  const total: TmpSweep = { at: now, removed: 0, freedBytes: 0, skipped: 0 };
  const add = (s: TmpSweep) => ((total.removed += s.removed), (total.freedBytes += s.freedBytes), (total.skipped += s.skipped));
  const kinds: Array<[string, () => TmpSweep | Promise<TmpSweep>]> = [
    ["caches", () => sweepCaches(home, judge, now, RECLAIM_STALE_MS, true)],
    ["npm", () => sweepNpm(home, judge, now, RECLAIM_STALE_MS, true)],
    ["review clones", () => (judge.owned ? sweepCacheWork(cacheDir, judge, now, prState, 0) : { at: now, removed: 0, freedBytes: 0, skipped: 0 })],
    ["stopped containers", () => sweepStoppedContainers(judge, sh, now)], // before the images: the images they held go in the same prune
    ["docker", () => sweepDocker(judge, sh, now, DOCKER_RECLAIM)],
  ];
  for (const [kind, sweep] of kinds) {
    try {
      add(await sweep());
    } catch (e) {
      total.skipped++;
      console.error(`disk reclaim: ${kind} failed:`, e);
    }
  }
  return total;
}
