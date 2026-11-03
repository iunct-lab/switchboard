/**
 * What fills /tmp (#797), for the rescue page: the usage, the biggest entries right under it, and which of them are old
 * working directories that can go. Only `node:` here: sb-rescue shares no code with Switchboard (#178).
 * Nothing takes a path from a request: a name is one level under the root, and it is judged again right before it goes.
 */
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

/** A directory has to be left alone this long (itself and everything in it) before the automatic clean takes it. */
export const STALE_MS = 2 * 60 * 60 * 1000;

/** The ages the owner can pick on the rescue page; nothing else is taken from a request. */
export const STALE_CHOICES_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

/**
 * How an entry is judged. `auto`: the sweep with nobody there — a known kind, a directory, this user's, left alone STALE_MS,
 * not in use. `manual`: the owner's press — any name, files too, this user's, left alone `staleMs`, not in use. `force`: the
 * owner's last resort — everything of this user's, whatever its age and whether a running process uses it.
 */
export type TmpMode = { kind: "auto" } | { kind: "manual"; staleMs: number } | { kind: "force" };
const AUTO: TmpMode = { kind: "auto" };

/**
 * The names that can go, matched against the whole name. `own`: what Switchboard and its kit make, on any machine. `shared`:
 * what any program's `mktemp` / `mkdtemp` makes, and caches — only where /tmp is Switchboard's alone (`TmpJudge.owned`);
 * elsewhere the user's other apps keep their folders there too. Something still running that uses one is left by `inUse`.
 */
export const CLEANABLE: { own: RegExp[]; shared: RegExp[] } = {
  own: [
    /^[\w.-]+\.(review|recheck)\d+[A-Za-z]*\.[A-Za-z0-9]{6}$/, // cross-runner-review's clone: mktemp -d /tmp/<repo>.review<PR>.XXXXXX (also review3212r), and the recheck's
    /^sb-candidate-[A-Za-z0-9]{6}$/, // promote.ts's mkdtemp, left when its finally did not run
  ],
  shared: [
    /^node-compile-cache$/,
    /^org\.chromium\.Chromium\.[A-Za-z0-9]{6}$/, // a headless Chrome's profile
    /^[\w.@+-]+[.-](?!X+$)(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6,}$/, // mktemp's <name>.XXXXXX or mkdtemp's <name>-XXXXXX, not the template itself
    /^[\w.@+-]+[.-][a-z0-9]{6}$/, // the same when the suffix came out all small: exactly six, so a longer word does not match (a six-letter one, `x-daemon`, does; the other checks still apply)
    /^tmp[a-z0-9_]{8}$/, // Python's mkdtemp: tmpab12cd_x
    /^bunx-\d+-.+$/, // bunx's cache: bunx-<uid>-<pkg>@<version>
  ],
};

/** How the names are judged. */
export interface TmpJudge {
  /** The machine is Switchboard's alone (the cloud host: `SWITCHBOARD_RESCUE_OWNS_TMP=1`), so `CLEANABLE.shared` can go too, and uv / bun / docker's caches (cache.ts). */
  owned: boolean;
  /** Where the running processes are read; tests point it at a folder without them. Default /proc. */
  proc?: string;
  /** Whose entries are this user's; tests pass another to stand for someone else's. Default process.getuid(). */
  uid?: number;
}

/**
 * Why an entry stays: not a kind above, not a directory, someone else's, touched within STALE_MS, a running process uses it,
 * or the running processes cannot be read (no /proc: nothing goes).
 */
export type Keep = "pattern" | "not-a-directory" | "owner" | "recent" | "in-use" | "use-unknown";
export interface TmpEntry {
  name: string;
  bytes: number;
  /** The newest mtime of the entry and everything in it: a directory's own mtime does not change when a file in it is written. */
  newestMs: number;
  removable: boolean;
  keep: Keep | null;
  /** This user's: what the force clean takes. */
  mine: boolean;
}
export interface TmpReport {
  root: string;
  usage: { used: number; total: number; percent: number };
  /** The biggest LIST_LIMIT entries. */
  entries: TmpEntry[];
  /** Every removable entry, also past LIST_LIMIT. */
  cleanable: { names: string[]; bytes: number };
  /** Every entry of this user's: what the force clean takes. */
  forcible: { count: number; bytes: number };
  /** TmpJudge.owned: which kinds were judged. */
  owned: boolean;
}
export interface TmpSweep {
  at: number;
  removed: number;
  freedBytes: number;
  skipped: number;
}

/** How often sb-rescue sweeps /tmp by itself. */
export const SWEEP_MS = 30 * 60 * 1000;

const LIST_LIMIT = 30;

/**
 * The names right under `root` that a running process has as its working directory, its executable or an open file (or under one).
 * A process that does not let itself be read (another user's, or one of this user's that is not dumpable: ssh-agent,
 * rootless docker's pasta) shows only its command line, so what that names counts instead; one that uses an old directory
 * without naming it is not seen. A bound Unix socket counts by its path (`<proc>/net/unix`, this network namespace's only): in a process's fds it is only
 * `socket:[inode]`, and a daemon (tmux, ssh-agent) may hold nothing else under the directory.
 * null when the processes cannot be listed (no /proc, as on macOS, or one without this process): whether a name is in use is then unknown.
 */
export function inUse(root: string, proc = "/proc"): Set<string> | null {
  const names = new Set<string>();
  const prefix = root.endsWith("/") ? root : root + "/";
  const note = (target: string) => {
    if (!target.startsWith(prefix)) return;
    const name = target.slice(prefix.length).split("/")[0]!;
    names.add(name);
    names.add(name.split(/[:,]/)[0]!); // a command line's /tmp/<name>:/work or /tmp/<a>,…: keeping one more is safe
  };
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  if (!pids.includes(String(process.pid))) return null; // one that does not list this process (an empty mount point) is not this machine's processes
  try {
    // the last field is the bound path; an unbound or abstract one has none, or starts with @
    for (const line of readFileSync(`${proc}/net/unix`, "utf8").split("\n").slice(1)) {
      const at = line.indexOf(" " + prefix);
      if (at >= 0) note(line.slice(at + 1));
    }
  } catch {}
  const denied = (e: unknown) => ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "");
  for (const pid of pids) {
    let hidden = false;
    const read = (link: string) => {
      try {
        note(readlinkSync(`${proc}/${pid}/${link}`));
      } catch (e) {
        hidden ||= denied(e);
      }
    };
    read("cwd");
    read("exe");
    try {
      for (const fd of readdirSync(`${proc}/${pid}/fd`)) read(`fd/${fd}`);
    } catch (e) {
      hidden ||= denied(e);
    }
    if (hidden) {
      try {
        for (const arg of readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0")) {
          // every path in it: the whole argument, an option's value (--user-data-dir=/tmp/<name>) or one in a : / , list
          for (let at = arg.indexOf(prefix); at >= 0; at = arg.indexOf(prefix, at + 1)) {
            if (at === 0 || "=:,".includes(arg[at - 1]!)) note(arg.slice(at));
          }
        }
      } catch {}
    }
  }
  return names;
}

/** The kinds of names /tmp's clean takes: `own` everywhere, `shared` only where /tmp is Switchboard's alone. */
const tmpKinds = (owned: boolean) => (owned ? [...CLEANABLE.own, ...CLEANABLE.shared] : CLEANABLE.own);

/**
 * One entry right under the root, measured without following symbolic links; an unreadable child is skipped. It can go when its
 * name is one of `kinds` and it is a directory (`kinds` null: any name and any entry), it is this user's, and — unless `staleMs`
 * is null (the force clean) — nothing in it was touched within `staleMs` and no running process uses it.
 */
export function inspect(root: string, name: string, now: number, busy: Set<string> | null, kinds: RegExp[] | null, staleMs: number | null, uid = process.getuid?.()): TmpEntry {
  const path = join(root, name);
  const top = lstatSync(path);
  let bytes = top.blocks * 512;
  let newestMs = top.mtimeMs;
  if (top.isDirectory()) {
    const dirs = [path];
    while (dirs.length) {
      const dir = dirs.pop()!;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const child of names) {
        try {
          const s = lstatSync(join(dir, child));
          bytes += s.blocks * 512;
          newestMs = Math.max(newestMs, s.mtimeMs);
          if (s.isDirectory()) dirs.push(join(dir, child));
        } catch {}
      }
    }
  }
  const mine = top.uid === uid;
  const keep: Keep | null = kinds && !kinds.some((re) => re.test(name))
    ? "pattern"
    : kinds && !top.isDirectory()
      ? "not-a-directory"
      : !mine
        ? "owner"
        : staleMs === null
          ? null
          : now - newestMs < staleMs
          ? "recent"
          : !busy
            ? "use-unknown"
            : busy.has(name)
              ? "in-use"
              : null;
  return { name, bytes, newestMs, removable: keep === null, keep, mine };
}

/** How full the file system under `path` is. */
export function diskUsage(path: string): TmpReport["usage"] {
  const fs = statfsSync(path);
  const total = fs.blocks * fs.bsize;
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  return { used, total, percent: total ? Math.round((used / total) * 100) : 0 };
}

/** The kinds and the age `inspect` takes for a mode. */
const rule = (mode: TmpMode, judge: TmpJudge): [RegExp[] | null, number | null] =>
  mode.kind === "auto" ? [tmpKinds(judge.owned), STALE_MS] : mode.kind === "manual" ? [null, mode.staleMs] : [null, null];

export function scanTmp(root: string, judge: TmpJudge, now = Date.now(), mode: TmpMode = AUTO): TmpReport {
  const all: TmpEntry[] = [];
  const busy = inUse(root, judge.proc);
  const [kinds, staleMs] = rule(mode, judge);
  for (const name of readdirSync(root)) {
    try {
      all.push(inspect(root, name, now, busy, kinds, staleMs, judge.uid));
    } catch {} // gone since readdir
  }
  all.sort((a, b) => b.bytes - a.bytes);
  const removable = all.filter((e) => e.removable);
  return {
    root,
    usage: diskUsage(root),
    entries: all.slice(0, LIST_LIMIT),
    cleanable: { names: removable.map((e) => e.name), bytes: removable.reduce((n, e) => n + e.bytes, 0) },
    forcible: { count: all.filter((e) => e.mine).length, bytes: all.filter((e) => e.mine).reduce((n, e) => n + e.bytes, 0) },
    owned: judge.owned,
  };
}

/** Gives this user's folders under `path` the rights rmSync needs. Symbolic links are not followed; what cannot be changed is left for rmSync to fail on. */
function makeWritable(path: string) {
  const dirs = [path];
  while (dirs.length) {
    const dir = dirs.pop()!;
    try {
      const s = lstatSync(dir);
      if (!s.isDirectory()) continue;
      chmodSync(dir, (s.mode & 0o7777) | 0o700);
      dirs.push(...readdirSync(dir).map((child) => join(dir, child)));
    } catch {}
  }
}

/**
 * Removes the named entries that are removable right now under `mode`; any other name, and one rmSync fails on, is skipped with
 * the reason. A symbolic link goes itself; what it points to stays.
 */
export function cleanTmp(root: string, names: string[], judge: TmpJudge, now = Date.now(), mode: TmpMode = AUTO) {
  const removed: string[] = [];
  const skipped: Array<{ name: string; keep: Keep | "name" | "gone" | "failed"; error?: string }> = [];
  let freedBytes = 0;
  const busy = inUse(root, judge.proc);
  const [kinds, staleMs] = rule(mode, judge);
  for (const name of names) {
    if (!name || name.includes("/") || name === "." || name === "..") {
      skipped.push({ name, keep: "name" });
      continue;
    }
    let entry: TmpEntry;
    try {
      entry = inspect(root, name, now, busy, kinds, staleMs, judge.uid);
    } catch {
      skipped.push({ name, keep: "gone" });
      continue;
    }
    if (!entry.removable) {
      skipped.push({ name, keep: entry.keep! });
      continue;
    }
    try {
      makeWritable(join(root, name));
      entry = inspect(root, name, now, busy, kinds, staleMs, judge.uid); // what a folder without permissions held counts now
      if (!entry.removable) {
        skipped.push({ name, keep: entry.keep! });
        continue;
      }
      rmSync(join(root, name), { recursive: true, force: true });
    } catch (e) {
      // what was in it may be partly gone; the rest of the names still go, and the answer says why this one stayed
      skipped.push({ name, keep: "failed", error: String((e as Error).message ?? e) });
      continue;
    }
    removed.push(name);
    freedBytes += entry.bytes;
  }
  return { removed, freedBytes, skipped };
}

/** What the clean button does, without the button: removes every entry that is removable right now. */
export function sweepTmp(root: string, judge: TmpJudge, now = Date.now()): TmpSweep {
  const r = cleanTmp(root, scanTmp(root, judge, now).cleanable.names, judge, now);
  return { at: now, removed: r.removed.length, freedBytes: r.freedBytes, skipped: r.skipped.length };
}
