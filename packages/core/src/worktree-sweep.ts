/**
 * Tidies the worktrees Tasks leave beside a repository (`../<repo>-<topic>`, `../<repo>-pbi<N>`): one goes only when nothing in it can be lost
 * (no uncommitted or untracked file, every commit of its HEAD is already in the default branch) and nothing has touched it for a day and no process uses it.
 * Judged from git and the file system alone: GitHub is not asked, so a squash merge (whose commits do not appear in the default branch) stays.
 * Only siblings of the main working tree named `<repo>-…` are judged: the worktrees the daemon makes elsewhere (a continued-locally Task's under
 * `.claude/worktrees`, a release check's) are its own and stay. Ignored files go with the worktree (dependencies, build and type output, caches, logs:
 * what an install, a build or a test run makes again), except a local settings file (`.env`, `.env.*`), which keeps it.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** A worktree has to be left alone this long (everything in it but `node_modules`) before it goes. Same as the working directories under ~/.cache. */
export const WORKTREE_STALE_MS = 24 * 60 * 60 * 1000;
/** How often the daemon sweeps. */
export const WORKTREE_SWEEP_MS = 30 * 60 * 1000;

/** An ignored file that cannot be made again (a local settings file with its secrets); one keeps the worktree. Other ignored files go with it. */
const KEEP_IGNORED = /^\.env(\..+)?$/;
/** The first sweep runs this long after the daemon starts, so a day of restarts more often than WORKTREE_SWEEP_MS still sweeps. */
export const WORKTREE_FIRST_SWEEP_MS = 60 * 1000;

export interface WorktreeSweep {
  removed: string[];
  kept: { path: string; why: string }[];
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    // GIT_OPTIONAL_LOCKS=0: `git status` must not refresh the index under a Task that is committing in the same worktree
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

/** Every path a running process has as its working directory, executable or open file; null when /proc cannot be read. A process that hides itself counts by its command line. */
function procTargets(proc: string): { links: string[]; cmdlines: string[] } | null {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  if (!pids.includes(String(process.pid))) return null;
  const links: string[] = [];
  const cmdlines: string[] = [];
  for (const pid of pids) {
    let hidden = false;
    const read = (link: string) => {
      try {
        links.push(readlinkSync(`${proc}/${pid}/${link}`));
      } catch (e) {
        hidden ||= ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "");
      }
    };
    read("cwd");
    read("exe");
    try {
      for (const fd of readdirSync(`${proc}/${pid}/fd`)) read(`fd/${fd}`);
    } catch (e) {
      hidden ||= ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "");
    }
    if (hidden) {
      try {
        cmdlines.push(readFileSync(`${proc}/${pid}/cmdline`, "utf8"));
      } catch {}
    }
  }
  return { links, cmdlines };
}

/** The newest modification time under `dir`, `node_modules` and the entries inside it left out; stops as soon as one is newer than `since`. */
function touchedSince(dir: string, since: number): boolean {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true; // cannot read: not known to be old
  }
  try {
    if (lstatSync(dir).mtimeMs > since) return true;
  } catch {
    return true;
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (touchedSince(p, since)) return true;
    } else {
      try {
        if (lstatSync(p).mtimeMs > since) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Removes, in every repository of `repos`, the worktrees (not the main one, not under `cacheDir`, not locked) that `git status` shows clean (ignored files go, but a KEEP_IGNORED one anywhere in it keeps it), whose commits are all in the default branch
 * (`git cherry` shows no `+`), that nothing changed within WORKTREE_STALE_MS, that is not and does not hold one of `keep` (the daemon passes the workspaces and
 * the folders of the Tasks that can still go on (not archived, not aborted): a worktree registered as a workspace, or one a Task was started in, stays while that Task can come back;
 * a worktree a Task made itself with `git worktree add` is not its folder, and goes when the rest says so: all of it is in the default branch) and no process uses.
 * `git worktree remove` runs without `--force`, so a change that slipped in stops it too. With `dryRun` nothing is removed: `removed` is what would go.
 */
export async function sweepWorktrees(repos: string[], o: { now?: number; proc?: string; cacheDir?: string; keep?: string[]; dryRun?: boolean } = {}): Promise<WorktreeSweep> {
  const now = o.now ?? Date.now();
  const proc = o.proc ?? "/proc";
  const cacheDir = o.cacheDir ?? join(homedir(), ".cache");
  const result: WorktreeSweep = { removed: [], kept: [] };
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const cacheReal = real(cacheDir);
  const held = (o.keep ?? []).map(real);
  const seen = new Set<string>();
  for (const repo of repos) {
    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    if (list.code !== 0) continue; // not a repository (any more)
    const blocks = list.out.split("\n\n").filter((b) => b.trim());
    const mainPath = real(/^worktree (.+)$/m.exec(blocks[0] ?? "")?.[1] ?? repo);
    if (seen.has(mainPath)) continue; // two workspaces of one repository
    seen.add(mainPath);
    // the default branch: origin's if it is there, else the local one
    const head = await git(mainPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const name = head.code === 0 ? head.out.trim().replace(/^origin\//, "") : "main";
    let base: string | null = null;
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if ((await git(mainPath, ["rev-parse", "--verify", "--quiet", ref])).code === 0) {
        base = ref;
        break;
      }
    }
    const mainDir = dirname(mainPath);
    const taskPrefix = `${basename(mainPath)}-`;
    let removedHere = false;
    for (const block of blocks.slice(1)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path) continue;
      const keep = (why: string) => result.kept.push({ path, why });
      const rp = real(path);
      if (/^locked/m.test(block)) { keep("locked"); continue; }
      if (/^bare/m.test(block)) { keep("bare"); continue; }
      if (rp === cacheReal || rp.startsWith(cacheReal + "/")) { keep("cache"); continue; } // local CI's and the review clones: rescue sweeps those
      if (dirname(rp) !== mainDir || !basename(rp).startsWith(taskPrefix)) { keep("not a Task worktree"); continue; }
      if (!existsSync(path)) { removedHere = true; continue; } // only the record is left: prune below
      if (!base) { keep("no default branch"); continue; }
      if (held.some((h) => h === rp || h.startsWith(rp + "/"))) { keep("a Task's folder or a workspace"); continue; }
      const status = await git(path, ["status", "--porcelain", "--untracked-files=normal"]);
      if (status.code !== 0) { keep("status failed"); continue; }
      if (status.out.trim()) { keep("changes"); continue; }
      const cherry = await git(path, ["cherry", base, "HEAD"]);
      if (cherry.code !== 0) { keep("cherry failed"); continue; }
      if (/^\+/m.test(cherry.out)) { keep("commits not in the default branch"); continue; }
      if (touchedSince(rp, now - WORKTREE_STALE_MS)) { keep("recent"); continue; }
      // only for a candidate; into ignored directories too, and unquoted (-z): `git status` names an ignored directory as one line and quotes a non-ASCII path.
      // Not into node_modules: a dependency ships its own `.env.example`, which is no settings file of this worktree
      const ignored = await git(path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ":(glob)**/.env", ":(glob)**/.env.*", ":(exclude,glob)**/node_modules/**"]);
      if (ignored.code !== 0) { keep("ls-files failed"); continue; }
      if (ignored.out.split("\0").some((f) => KEEP_IGNORED.test(basename(f)))) { keep("ignored settings file"); continue; }
      // read the processes right before the removal, per candidate: none are read on a sweep without one, and a process that came meanwhile is seen
      const targets = procTargets(proc);
      if (!targets) { keep("use unknown"); continue; }
      const prefix = rp + "/";
      if (targets.links.some((l) => l === rp || l.startsWith(prefix)) || targets.cmdlines.some((c) => c.includes(prefix) || c.includes(rp + "\0"))) { keep("in use"); continue; }
      if (o.dryRun) { result.removed.push(path); continue; }
      const rm = await git(mainPath, ["worktree", "remove", path]); // no --force: a change that slipped in stops it
      if (rm.code === 0) { result.removed.push(path); removedHere = true; } else keep("remove refused");
    }
    if (removedHere && !o.dryRun) await git(mainPath, ["worktree", "prune"]);
  }
  return result;
}

/** What the daemon keeps: every workspace, and the folder of every Task that can still go on. `tasks` are the ones not archived; of them, all but
 * `aborted` (a `done` one takes the next message, one waiting on a limit for days has no process) come back to their folder. */
export function worktreeKeep(workspaces: { path: string }[], tasks: { cwd: string; status: string }[]): string[] {
  return [...new Set([...workspaces.map((w) => w.path), ...tasks.filter((t) => t.status !== "aborted").map((t) => t.cwd)])];
}

/**
 * Starts the daemon's sweep: WORKTREE_FIRST_SWEEP_MS after start, then every WORKTREE_SWEEP_MS, over every workspace's repository with worktreeKeep's paths kept.
 * Not on a candidate daemon (null): it runs on a copy of the DB and would sweep the real repositories. Returns the stop.
 */
export function startWorktreeSweep(o: {
  candidate: boolean;
  read: () => { workspaces: { path: string }[]; tasks: { cwd: string; status: string }[] };
  sweep?: typeof sweepWorktrees;
  firstMs?: number;
  everyMs?: number;
}): (() => void) | null {
  if (o.candidate) return null;
  const sweep = o.sweep ?? sweepWorktrees;
  const run = () => {
    try {
      const { workspaces, tasks } = o.read();
      sweep(workspaces.map((w) => w.path), { keep: worktreeKeep(workspaces, tasks) })
        .then((r) => { for (const p of r.removed) console.log(`[worktree-sweep] removed ${p}`); })
        .catch((e) => console.error(`[worktree-sweep] ${String((e as Error)?.message ?? e)}`));
    } catch (e) {
      console.error(`[worktree-sweep] ${String((e as Error)?.message ?? e)}`);
    }
  };
  const first = setTimeout(run, o.firstMs ?? WORKTREE_FIRST_SWEEP_MS);
  const every = setInterval(run, o.everyMs ?? WORKTREE_SWEEP_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
