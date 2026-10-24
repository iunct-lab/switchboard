/**
 * What fills /tmp (#797), for the rescue page: the usage, the biggest entries right under it, and which of them are old
 * working directories that can go. Only `node:` here: sb-rescue shares no code with Switchboard (#178).
 * Nothing takes a path from a request: a name is one level under the root, and it is judged again right before it goes.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

/** A directory has to be left alone this long (itself and everything in it) before it can go. */
export const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * The names that can go, matched against the whole name. `own`: what Switchboard and its kit make, on any machine. `shared`:
 * what any program's `mktemp` / `mkdtemp` makes, and caches — only where /tmp is Switchboard's alone (`TmpJudge.owned`);
 * elsewhere the user's other apps keep their folders there too. Something still running that uses one is left by `inUse`.
 */
export const CLEANABLE: { own: RegExp[]; shared: RegExp[] } = {
  own: [
    /^[\w.-]+\.(review|recheck)\d+\.[A-Za-z0-9]{6}$/, // cross-runner-review's clone: mktemp -d /tmp/<repo>.review<PR>.XXXXXX, and the recheck's
    /^sb-candidate-[A-Za-z0-9]{6}$/, // promote.ts's mkdtemp, left when its finally did not run
  ],
  shared: [
    /^node-compile-cache$/,
    /^org\.chromium\.Chromium\.[A-Za-z0-9]{6}$/, // a headless Chrome's profile
    /^[\w.@+-]+[.-](?!X+$)(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6,}$/, // mktemp's <name>.XXXXXX or mkdtemp's <name>-XXXXXX, not the template itself
    /^bunx-\d+-.+$/, // bunx's cache: bunx-<uid>-<pkg>@<version>
  ],
};

/** How the names are judged. */
export interface TmpJudge {
  /** /tmp is Switchboard's alone (the cloud host, a machine of its own: `SWITCHBOARD_RESCUE_OWNS_TMP=1`), so `CLEANABLE.shared` can go too. */
  owned: boolean;
  /** Where the running processes are read; tests point it at a folder without them. Default /proc. */
  proc?: string;
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
}
export interface TmpReport {
  root: string;
  usage: { used: number; total: number; percent: number };
  /** The biggest LIST_LIMIT entries. */
  entries: TmpEntry[];
  /** Every removable entry, also past LIST_LIMIT. */
  cleanable: { names: string[]; bytes: number };
  /** The last automatic sweep; scanTmp leaves it null, the server fills it in. */
  sweep: TmpSweep | null;
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
 * without naming it is not seen.
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

/** One entry right under the root, measured without following symbolic links; an unreadable child is skipped. */
function inspect(root: string, name: string, now: number, busy: Set<string> | null, owned: boolean): TmpEntry {
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
  const kinds = owned ? [...CLEANABLE.own, ...CLEANABLE.shared] : CLEANABLE.own;
  const keep: Keep | null = !kinds.some((re) => re.test(name))
    ? "pattern"
    : !top.isDirectory()
      ? "not-a-directory"
      : top.uid !== process.getuid?.()
        ? "owner"
        : now - newestMs < STALE_MS
          ? "recent"
          : !busy
            ? "use-unknown"
            : busy.has(name)
              ? "in-use"
              : null;
  return { name, bytes, newestMs, removable: keep === null, keep };
}

export function scanTmp(root: string, judge: TmpJudge, now = Date.now()): TmpReport {
  const fs = statfsSync(root);
  const total = fs.blocks * fs.bsize;
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  const all: TmpEntry[] = [];
  const busy = inUse(root, judge.proc);
  for (const name of readdirSync(root)) {
    try {
      all.push(inspect(root, name, now, busy, judge.owned));
    } catch {} // gone since readdir
  }
  all.sort((a, b) => b.bytes - a.bytes);
  const removable = all.filter((e) => e.removable);
  return {
    root,
    usage: { used, total, percent: total ? Math.round((used / total) * 100) : 0 },
    entries: all.slice(0, LIST_LIMIT),
    cleanable: { names: removable.map((e) => e.name), bytes: removable.reduce((n, e) => n + e.bytes, 0) },
    sweep: null,
    owned: judge.owned,
  };
}

/** Removes the named entries that are removable right now; any other name, and one rmSync fails on, is skipped with the reason. */
export function cleanTmp(root: string, names: string[], judge: TmpJudge, now = Date.now()) {
  const removed: string[] = [];
  const skipped: Array<{ name: string; keep: Keep | "name" | "gone" | "failed"; error?: string }> = [];
  let freedBytes = 0;
  const busy = inUse(root, judge.proc);
  for (const name of names) {
    if (!name || name.includes("/") || name === "." || name === "..") {
      skipped.push({ name, keep: "name" });
      continue;
    }
    let entry: TmpEntry;
    try {
      entry = inspect(root, name, now, busy, judge.owned);
    } catch {
      skipped.push({ name, keep: "gone" });
      continue;
    }
    if (!entry.removable) {
      skipped.push({ name, keep: entry.keep! });
      continue;
    }
    try {
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
