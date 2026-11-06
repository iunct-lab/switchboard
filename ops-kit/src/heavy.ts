// heavy: run a heavy job (a local CI, the whole test suite, a fake daemon with a headless Chrome, a review session) only when
// one of the machine's slots is free and the free memory is above the floor; otherwise wait and say why.
// The limit is the machine's, not a repository's: the configuration and the slots live under the home directory, so every
// repository, working tree and Task on the machine takes from the same slots (the kit README, 重い処理の枠).
import { appendFileSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HeavyConfig = { max: number; minFreeMb: number };
export const HEAVY_DEFAULTS: HeavyConfig = { max: 1, minFreeMb: 1536 };

export const heavyConfigPath = (home: string) => join(home, ".config", "ops-kit", "heavy.json");
export const heavyStateDir = (home: string) => join(home, ".local", "state", "ops-kit", "heavy");
export const heavyHistoryPath = (home: string) => join(heavyStateDir(home), "history.jsonl");

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

type Holder = { pid: number; name: string; cwd: string; taskId: string | null; queuedAt: string; startedAt: string; procStart?: string; token: string };

/** A job holding a slot, as `readHeavyState` gives it. `taskId` is the Task that started it (`OPS_KIT_TASK_ID`, which the app running the Task sets; null outside a Task). */
export type HeavyRun = { pid: number; name: string; cwd: string; taskId: string | null; queuedAt: string; startedAt: string };
/** A job waiting for a slot (`slot`) or for the free memory to rise above the floor (`memory`). */
export type HeavyWait = { pid: number; name: string; cwd: string; taskId: string | null; queuedAt: string; reason: "slot" | "memory" };
type Waiter = HeavyWait & { procStart?: string };
// a waiter's file: wait-<pid>-<token>.json (the token is its holder's token once it takes a slot)
const WAIT_FILE = /^wait-\d+-([\w-]+)\.json$/;

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

// the process's ancestors, its parent first, up to (not including) pid 1, read from the ppid in /proc/<pid>/stat (the
// second field after the name, read as procStart reads). The process itself is not one: two jobs of one process are
// two jobs. None where /proc is not there (the slots are waited for as before)
function ancestorPids(pid: number): number[] {
  const out: number[] = [];
  for (let p = pid; out.length < 1000; ) {
    let ppid: number;
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    out.push(ppid);
    p = ppid;
  }
  return out;
}

function alive(h: { pid: number; procStart?: string }): boolean {
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

// the live holders, the dead ones reaped on the way (and the files of waiters killed while waiting: the name is theirs
// alone, so removing it races no one)
function holders(dir: string): Holder[] {
  const live: Holder[] = [];
  for (const file of readdirSync(dir)) {
    if (WAIT_FILE.test(file)) {
      let w: Waiter | undefined;
      try {
        w = JSON.parse(readFileSync(join(dir, file), "utf8")) as Waiter;
      } catch {
        continue; // gone meanwhile; a file is written whole, so one that does not read is not left half
      }
      if (w && typeof w.pid === "number" && !alive(w)) removeFile(join(dir, file));
      continue;
    }
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

// the waiter's file, written whole (a rename) so a reader never sees half of it. The name carries the token as well as the
// pid: one process may wait for two slots at once
const waitPath = (dir: string, me: Holder) => join(dir, `wait-${me.pid}-${me.token}.json`);
function writeWait(dir: string, w: Waiter, token: string): void {
  const draft = join(dir, `.draft-wait-${process.pid}-${token}`);
  writeFileSync(draft, JSON.stringify(w));
  renameSync(draft, join(dir, `wait-${w.pid}-${token}.json`));
}
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * The machine's slots as another process sees them: the limits, the jobs holding a slot and the jobs waiting, oldest first.
 * Files of processes that are gone are left out but not removed (the next waiter reaps a slot; a reader changes nothing).
 * No directory gives none.
 */
export function readHeavyState(home: string): { config: HeavyConfig; running: HeavyRun[]; waiting: HeavyWait[] } {
  const config = heavyConfig(home);
  const dir = heavyStateDir(home);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return { config, running: [], waiting: [] };
  }
  const running: HeavyRun[] = [];
  const waiting: HeavyWait[] = [];
  const tokens = new Set<string>();
  const read = (file: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return v && typeof v === "object" && typeof v.pid === "number" ? v : undefined;
    } catch {
      return undefined; // gone between the listing and the read, or cut short
    }
  };
  for (const file of [...files].sort((a, b) => Number(b.startsWith("slot-")) - Number(a.startsWith("slot-")))) {
    if (/^slot-\d+\.json$/.test(file)) {
      const h = read(file) as Holder | undefined;
      if (h && alive(h)) {
        tokens.add(h.token);
        running.push({ pid: h.pid, name: h.name, cwd: h.cwd, taskId: h.taskId ?? null, queuedAt: h.queuedAt ?? h.startedAt, startedAt: h.startedAt });
      }
    } else if (WAIT_FILE.test(file)) {
      const w = read(file) as Waiter | undefined;
      // one that has just taken its slot is running: its file goes right after the take
      if (w && alive(w) && !tokens.has(WAIT_FILE.exec(file)![1]!)) waiting.push({ pid: w.pid, name: w.name, cwd: w.cwd, taskId: w.taskId ?? null, queuedAt: w.queuedAt, reason: w.reason });
    }
  }
  running.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  waiting.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  return { config, running, waiting };
}

/**
 * A finished job, one line of `history.jsonl`. `exitCode` is the command's exit (null when the job threw, or its result
 * does not say). The screen
 * compares a running job with the finished ones of its kind (the design doc ops-metrics.md, リソース画面).
 */
export type HeavyHistoryEntry = { name: string; taskId: string | null; queuedAt: string; startedAt: string; endedAt: string; exitCode: number | null };
export const HEAVY_HISTORY_KEEP = 500;
// the file is cut back to the newest KEEP lines once it has twice as many: one rewrite per KEEP runs, not one per run
const HISTORY_TRIM_AT = HEAVY_HISTORY_KEEP * 2;

// the exit a job's result stands for: the command's exit (`ops-kit heavy`), `{ exitCode }`, or local-ci's `{ ok }`; a job
// that gives nothing (undefined) ended well. Any other result (tag-ci's list of tags) says nothing of success: null, so it
// is not counted among the successful runs of its kind
function exitOf(result: unknown): number | null {
  if (result === undefined) return 0;
  if (typeof result === "number") return result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as { exitCode?: unknown; ok?: unknown };
    if (typeof r.exitCode === "number") return r.exitCode;
    if (typeof r.ok === "boolean") return r.ok ? 0 : 1;
  }
  return null;
}

const parseEntry = (line: string): HeavyHistoryEntry | undefined => {
  try {
    const e = JSON.parse(line) as HeavyHistoryEntry;
    const str = (v: unknown) => typeof v === "string";
    return e && typeof e === "object" && str(e.name) && (e.taskId === null || str(e.taskId)) && str(e.queuedAt) && str(e.startedAt) && str(e.endedAt) && (e.exitCode === null || typeof e.exitCode === "number")
      ? { name: e.name, taskId: e.taskId, queuedAt: e.queuedAt, startedAt: e.startedAt, endedAt: e.endedAt, exitCode: e.exitCode }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Adds a finished job to the history and cuts the file back to the newest entries when it has grown past twice their
 * number (a draft renamed over it, so a reader never sees half). Two jobs ending at once may lose one line to the other's
 * rewrite; a history is a guide, not a record. A place that cannot be written says so and leaves the job's result alone.
 */
export function appendHeavyHistory(home: string, entry: HeavyHistoryEntry, log: (line: string) => void = () => {}): void {
  const path = heavyHistoryPath(home);
  const draft = join(heavyStateDir(home), `.draft-history-${process.pid}-${crypto.randomUUID()}`);
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= HISTORY_TRIM_AT) return;
    const kept = lines.filter((l) => parseEntry(l)); // a broken line does not take a kept one's place
    writeFileSync(draft, `${kept.slice(-HEAVY_HISTORY_KEEP).join("\n")}\n`);
    renameSync(draft, path);
  } catch (e) {
    removeFile(draft); // one cut short (a full disk) or not renamed is not left behind
    log(`heavy: 履歴に書けません（${path}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
  }
}

/** The newest entries of the history, oldest first. Lines that do not read are skipped; no file gives none. */
export function readHeavyHistory(home: string): HeavyHistoryEntry[] {
  let text: string;
  try {
    text = readFileSync(heavyHistoryPath(home), "utf8");
  } catch {
    return [];
  }
  const out: HeavyHistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const e = line ? parseEntry(line) : undefined;
    if (e) out.push(e);
  }
  return out.slice(-HEAVY_HISTORY_KEEP);
}

export type HeavyOptions = { home?: string; mem?: () => number | undefined; pollMs?: number; log?: (line: string) => void; taskId?: string | null };

/**
 * Runs `fn` holding one of the machine's slots. Waits, polling every `pollMs`, while every slot is held or the free memory
 * is below the floor, and says so once each time the reason changes. The slot is given back when `fn` ends, also by an
 * exception; a holder killed outside `finally` (SIGKILL, a stopped Task) is found dead by the next waiter. A job that ends
 * (also by an exception) is added to the history (`appendHeavyHistory`); one killed is not. Where the
 * slots' directory cannot be written, says so and runs `fn` without a slot (a guard must not stop the work).
 * Called by a descendant of a live holder (an `ops-kit heavy -- bun scripts/local-ci.ts …`), it neither waits nor takes a
 * slot: the job runs in the outer one, says so in one line and is added to the history as `<name> (入れ子)`. The holder is
 * found by its pid among the caller's ancestors, not by the environment (local-ci runs its steps under `env -i`).
 */
export async function withHeavySlot<T>(name: string, fn: () => Promise<T>, o: HeavyOptions = {}): Promise<T> {
  const home = o.home ?? homedir();
  const mem = o.mem ?? memAvailableMb;
  const pollMs = o.pollMs ?? 2000;
  const log = o.log ?? ((line: string) => console.error(line));
  const cfg = heavyConfig(home);
  const dir = heavyStateDir(home);
  const taskId = o.taskId !== undefined ? o.taskId : (process.env.OPS_KIT_TASK_ID || null);
  const me: Holder = { pid: process.pid, name, cwd: process.cwd(), taskId, queuedAt: new Date().toISOString(), startedAt: "", procStart: procStart(process.pid), token: crypto.randomUUID() };
  let slot: string | undefined;
  let said = "";
  let waited = false;
  let wrote: HeavyWait["reason"] | undefined;
  // `kind` is the reason without its numbers: free memory moves on every read, and a line per poll says nothing new.
  // The waiter's file is written again only when the reason itself (slot / memory) changes: no writes per poll
  const say = (kind: string, reason: string, why: HeavyWait["reason"]) => {
    if (kind !== said) log(`heavy: 待っています（${reason}）`);
    said = kind;
    waited = true;
    if (why !== wrote) {
      // a place that cannot be written (a sandboxed Task) only leaves this waiter out of the list: it still waits
      try {
        writeWait(dir, { pid: me.pid, name, cwd: me.cwd, taskId, queuedAt: me.queuedAt, reason: why, procStart: me.procStart }, me.token);
      } catch {
        /* not listed */
      }
      wrote = why;
    }
  };
  let outer: Holder | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    const up = new Set(ancestorPids(process.pid));
    outer = up.size ? holders(dir).find((h) => up.has(h.pid)) : undefined;
    for (; !outer; ) {
      const free = mem();
      if (free !== undefined && free < cfg.minFreeMb) {
        say("memory", `空きメモリ ${free} MB < 下限 ${cfg.minFreeMb} MB`, "memory");
      } else {
        const held = holders(dir);
        if (held.length < cfg.max) {
          me.startedAt = new Date().toISOString();
          if (!waited) me.queuedAt = me.startedAt;
          slot = take(dir, cfg.max, me);
          if (slot) break;
        }
        const now = held.length ? held : holders(dir);
        const slots = `枠 ${now.length}/${cfg.max}: ${now.map((h) => `${h.name} ${h.cwd} ${h.startedAt} から`).join("、")}`;
        say(`slots ${now.map((h) => h.token).join(" ")}`, slots, "slot");
      }
      await Bun.sleep(pollMs);
    }
  } catch (e) {
    if (wrote) removeFile(waitPath(dir, me));
    log(`heavy: 枠の置き場に書けないので、枠を取らずに動かします（${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    return fn();
  }
  if (outer) {
    log(`heavy: 枠を持つ処理の中なので、外側の枠の中で動きます（${name}。外側: ${outer.name}）`);
    const at = new Date().toISOString();
    let exitCode: number | null = null;
    try {
      const result = await fn();
      exitCode = exitOf(result);
      return result;
    } finally {
      appendHeavyHistory(home, { name: `${name} (入れ子)`, taskId, queuedAt: at, startedAt: at, endedAt: new Date().toISOString(), exitCode }, log);
    }
  }
  if (wrote) removeFile(waitPath(dir, me));
  if (waited) log(`heavy: 始めます（${name}）`);
  let exitCode: number | null = null;
  try {
    const result = await fn();
    exitCode = exitOf(result);
    return result;
  } finally {
    appendHeavyHistory(home, { name, taskId, queuedAt: me.queuedAt, startedAt: me.startedAt, endedAt: new Date().toISOString(), exitCode }, log);
    // only our own: a slot reaped and taken by someone else meanwhile is theirs
    if (slot && readHolder(slot)?.token === me.token) {
      try {
        unlinkSync(slot);
      } catch {
        /* already gone */
      }
    }
  }
}
