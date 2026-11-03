// heavy: run a heavy job (a local CI, the whole test suite, a fake daemon with a headless Chrome, a review session) only when
// one of the machine's slots is free and the free memory is above the floor; otherwise wait and say why.
// The limit is the machine's, not a repository's: the configuration and the slots live under the home directory, so every
// repository, working tree and Task on the machine takes from the same slots (the kit README, 重い処理の枠).
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HeavyConfig = { max: number; minFreeMb: number };
export const HEAVY_DEFAULTS: HeavyConfig = { max: 1, minFreeMb: 1536 };

export const heavyConfigPath = (home: string) => join(home, ".config", "ops-kit", "heavy.json");
export const heavyStateDir = (home: string) => join(home, ".local", "state", "ops-kit", "heavy");

/**
 * The machine's limits from `~/.config/ops-kit/heavy.json` (`{ "max": 2, "minFreeMb": 1536 }`, both optional). No file, or
 * one that cannot be read, gives the defaults. A file that says something wrong stops with an error: falling back to the
 * defaults would quietly run another number of jobs than the one written.
 */
export function heavyConfig(home: string): HeavyConfig {
  const path = heavyConfigPath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ...HEAVY_DEFAULTS };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: JSON として読めません（${(e as Error).message}）`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: オブジェクト（{ "max": 1, "minFreeMb": 1536 }）ではありません`);
  const { max = HEAVY_DEFAULTS.max, minFreeMb = HEAVY_DEFAULTS.minFreeMb } = raw as Record<string, unknown>;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) throw new Error(`${path}: max は 1 以上の整数にしてください（${JSON.stringify(max)}）`);
  if (typeof minFreeMb !== "number" || !Number.isFinite(minFreeMb) || minFreeMb < 0) throw new Error(`${path}: minFreeMb は 0 以上の数にしてください（${JSON.stringify(minFreeMb)}）`);
  return { max, minFreeMb };
}

/** Linux's MemAvailable in MB; undefined where /proc/meminfo is not there (the number of slots alone decides). */
export function memAvailableMb(): number | undefined {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : undefined;
  } catch {
    return undefined;
  }
}

type Holder = { pid: number; name: string; cwd: string; startedAt: string; procStart?: string; token: string };

// the process's start time (field 22 of /proc/<pid>/stat): a pid reused by another process, or one from before a reboot,
// does not keep a slot. Undefined where /proc is not there (the pid alone decides)
function procStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

function alive(h: Holder): boolean {
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  return h.procStart === undefined || procStart(h.pid) === h.procStart;
}

const parseHolder = (text: string): Holder | undefined => {
  try {
    const h = JSON.parse(text) as Holder;
    return h && typeof h === "object" && typeof h.pid === "number" && typeof h.token === "string" ? h : undefined;
  } catch {
    return undefined;
  }
};

const readHolder = (path: string): Holder | undefined => {
  try {
    return parseHolder(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

// a holder whose process is gone gives its slot back. The file is moved aside first and checked again, so a waiter that
// read the dead holder cannot remove a slot another waiter has just taken in its place
function reap(dir: string, file: string, dead: { token: string | undefined; text: string }): void {
  const path = join(dir, file);
  const aside = join(dir, `.reap-${process.pid}-${crypto.randomUUID()}`);
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  let moved = "";
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    /* read as not the one we judged: put back */
  }
  if (moved !== dead.text) {
    try {
      linkSync(aside, path);
    } catch {
      // the slot was taken again meanwhile: the moved holder's file is lost and, until it ends, one more job than the
      // limit runs (the window is between this rename and the link back; nothing else is counted wrong)
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    /* already gone */
  }
}

// the live holders, the dead ones reaped on the way
function holders(dir: string): Holder[] {
  const live: Holder[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^slot-\d+\.json$/.test(file)) continue;
    const path = join(dir, file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // gone between the listing and the read
    }
    const h = parseHolder(text);
    // a slot appears whole (take links a written file), so one that does not read as a holder was cut short by a host
    // stop or edited by hand: it would keep its name, and the slot, for good
    if (!h) reap(dir, file, { token: undefined, text });
    else if (alive(h)) live.push(h);
    else reap(dir, file, { token: h.token, text });
  }
  return live;
}

// takes a slot below `max` by linking a written file to its name (the link fails if the name exists: only one taker wins,
// and the file is whole when it appears). Undefined when every slot is held
function take(dir: string, max: number, me: Holder): string | undefined {
  const draft = join(dir, `.draft-${process.pid}-${me.token}`);
  writeFileSync(draft, JSON.stringify(me));
  try {
    for (let i = 0; i < max; i++) {
      const slot = join(dir, `slot-${i}.json`);
      try {
        linkSync(draft, slot);
        return slot;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    return undefined;
  } finally {
    unlinkSync(draft);
  }
}

export type HeavyOptions = { home?: string; mem?: () => number | undefined; pollMs?: number; log?: (line: string) => void };

/**
 * Runs `fn` holding one of the machine's slots. Waits, polling every `pollMs`, while every slot is held or the free memory
 * is below the floor, and says so once each time the reason changes. The slot is given back when `fn` ends, also by an
 * exception; a holder killed outside `finally` (SIGKILL, a stopped Task) is found dead by the next waiter. Where the
 * slots' directory cannot be written, says so and runs `fn` without a slot (a guard must not stop the work).
 */
export async function withHeavySlot<T>(name: string, fn: () => Promise<T>, o: HeavyOptions = {}): Promise<T> {
  const home = o.home ?? homedir();
  const mem = o.mem ?? memAvailableMb;
  const pollMs = o.pollMs ?? 2000;
  const log = o.log ?? ((line: string) => console.error(line));
  const cfg = heavyConfig(home);
  const dir = heavyStateDir(home);
  const me: Holder = { pid: process.pid, name, cwd: process.cwd(), startedAt: "", procStart: procStart(process.pid), token: crypto.randomUUID() };
  let slot: string | undefined;
  let said = "";
  let waited = false;
  // `kind` is the reason without its numbers: free memory moves on every read, and a line per poll says nothing new
  const say = (kind: string, reason: string) => {
    if (kind !== said) log(`heavy: 待っています（${reason}）`);
    said = kind;
    waited = true;
  };
  try {
    mkdirSync(dir, { recursive: true });
    for (;;) {
      const free = mem();
      if (free !== undefined && free < cfg.minFreeMb) {
        say("memory", `空きメモリ ${free} MB < 下限 ${cfg.minFreeMb} MB`);
      } else {
        const held = holders(dir);
        if (held.length < cfg.max) {
          me.startedAt = new Date().toISOString();
          slot = take(dir, cfg.max, me);
          if (slot) break;
        }
        const now = held.length ? held : holders(dir);
        const slots = `枠 ${now.length}/${cfg.max}: ${now.map((h) => `${h.name} ${h.cwd} ${h.startedAt} から`).join("、")}`;
        say(`slots ${now.map((h) => h.token).join(" ")}`, slots);
      }
      await Bun.sleep(pollMs);
    }
  } catch (e) {
    log(`heavy: 枠の置き場に書けないので、枠を取らずに動かします（${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    return fn();
  }
  if (waited) log(`heavy: 始めます（${name}）`);
  try {
    return await fn();
  } finally {
    // only our own: a slot reaped and taken by someone else meanwhile is theirs
    if (readHolder(slot)?.token === me.token) {
      try {
        unlinkSync(slot);
      } catch {
        /* already gone */
      }
    }
  }
}
