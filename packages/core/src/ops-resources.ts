// The resources screen's one read (docs/design/ops-metrics.md): the host's free memory now, the machine's heavy-process
// slots and who waits for them (`ops-kit heavy`'s files), and the latest minute of the load sampler's task × kind RSS.
// Read when asked, nothing on a timer, and no walk of /proc's processes: the sampler already did that this minute.
// Each run is compared with the finished runs of its kind in `ops-kit heavy`'s history: the median time, whether
// this one is past twice of it, and when everything running and waiting would be done.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LoadKind, OpsResources, RunVerdict } from "@switchboard/protocol";
import { type HeavyHistoryEntry, heavyHistoryPath, readHeavyHistory, readHeavyState } from "../../../ops-kit/src/heavy.ts";
import type { Db } from "./db.ts";
import { JOBS_KEEP_MS } from "./jobs.ts";

/** /proc/meminfo in bytes; null where it cannot be read. */
export function readMemInfo(procRoot = "/proc"): { availableBytes: number; totalBytes: number; swapUsedBytes: number } | null {
  let text: string;
  try {
    text = readFileSync(join(procRoot, "meminfo"), "utf8");
  } catch {
    return null;
  }
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const available = kb("MemAvailable");
  const total = kb("MemTotal");
  if (available === undefined || total === undefined) return null;
  return { availableBytes: available, totalBytes: total, swapUsedBytes: (kb("SwapTotal") ?? 0) - (kb("SwapFree") ?? 0) };
}

const MB = 1024 * 1024;

/** A run is long past this many times its kind's median. Not a setting (the PBI's 決定ログ). */
export const LONG_RATIO = 2;
/** Fewer finished runs of a kind than this give no median: too few to call a run long. */
export const MIN_SAMPLES = 3;

/** The kind a run is compared within: its name with every number made `#` (`local-ci 3314` and `local-ci 3320` are one kind). */
export const runKind = (name: string) => name.replace(/\d+/g, "#");

/** A kind's finished runs: `samples` is how many ended with exit 0, `typicalMs` their median time (null below MIN_SAMPLES). */
export type Typical = { typicalMs: number | null; samples: number };

/** The median time of each kind's runs that ended with exit 0 (a failed run stops early or late, and says nothing of a usual one). */
export function typicalByKind(history: Pick<HeavyHistoryEntry, "name" | "startedAt" | "endedAt" | "exitCode">[]): Map<string, Typical> {
  const times = new Map<string, number[]>();
  for (const e of history) {
    if (e.exitCode !== 0) continue;
    const ms = Date.parse(e.endedAt) - Date.parse(e.startedAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    const kind = runKind(e.name);
    times.set(kind, [...(times.get(kind) ?? []), ms]);
  }
  const out = new Map<string, Typical>();
  for (const [kind, ms] of times) {
    ms.sort((a, b) => a - b);
    const mid = Math.floor(ms.length / 2);
    const median = ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
    out.set(kind, { typicalMs: ms.length >= MIN_SAMPLES ? median : null, samples: ms.length });
  }
  return out;
}

/** `none`: too few finished runs to say; `long`: past LONG_RATIO times the median; else `normal`. */
export function verdict(elapsedMs: number, typical: Typical | undefined): RunVerdict {
  if (!typical || typical.typicalMs === null) return "none";
  return elapsedMs > typical.typicalMs * LONG_RATIO ? "long" : "normal";
}

/**
 * When everything running and waiting would be done, in ms from `now`: each slot is free when its running run has had its
 * median (0 once past it), and the waiting runs, oldest first, each take the slot free earliest for their kind's median.
 * Runs with no median are counted in `unknown` and left out. Nothing running or waiting gives `etaMs` null. The free
 * memory's return is not in it: when it rises depends on other Tasks.
 */
export function estimateDone(
  running: Array<{ name: string; startedAt: string }>,
  waiting: Array<{ name: string; queuedAt: string }>,
  max: number,
  typical: Map<string, Typical>,
  now: number,
): { etaMs: number | null; unknown: number } {
  if (!running.length && !waiting.length) return { etaMs: null, unknown: 0 };
  let unknown = 0;
  const median = (name: string) => {
    const t = typical.get(runKind(name))?.typicalMs ?? null;
    if (t === null) unknown++;
    return t;
  };
  const free = running.map((r) => Math.max((median(r.name) ?? 0) - (now - Date.parse(r.startedAt)), 0));
  while (free.length < max) free.push(0);
  for (const w of [...waiting].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))) {
    const t = median(w.name);
    if (t === null) continue;
    const i = free.indexOf(Math.min(...free));
    free[i] = free[i]! + t;
  }
  return { etaMs: Math.max(...free), unknown };
}

// the history's medians, read again only when the file changes (it changes once per finished run; the screen asks every 5 s)
let cached: { path: string; mtimeMs: number; size: number; typical: Map<string, Typical> } | undefined;
function typicalFromHistory(home: string): Map<string, Typical> {
  const path = heavyHistoryPath(home);
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    return new Map();
  }
  if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.typical;
  const typical = typicalByKind(readHeavyHistory(home));
  cached = { path, mtimeMs: st.mtimeMs, size: st.size, typical };
  return typical;
}

export function opsResources(db: Db, opts: { home: string; procRoot?: string; now?: number }): OpsResources {
  const heavy = readHeavyState(opts.home);
  const typical = typicalFromHistory(opts.home);
  const now = opts.now ?? Date.now();
  const of = (name: string) => typical.get(runKind(name)) ?? { typicalMs: null, samples: 0 };
  const mem = readMemInfo(opts.procRoot);
  const latest = db.sqlite.query("SELECT MAX(ts) AS ts FROM ops_load_groups").get() as { ts: number | null } | null;
  const rows = latest?.ts
    ? (db.sqlite.query("SELECT task_id, owner, kind, rss, procs FROM ops_load_groups WHERE ts = ? ORDER BY rss DESC").all(latest.ts) as Array<{
        task_id: string | null;
        owner: "task" | "daemon" | "other";
        kind: LoadKind;
        rss: number;
        procs: number;
      }>)
    : [];
  // the names of the Tasks that appear, each looked up once
  const titles = new Map<string, string | null>();
  const title = (id: string | null) => {
    if (id === null) return null;
    if (!titles.has(id)) titles.set(id, db.getTask(id)?.title ?? null);
    return titles.get(id)!;
  };
  return {
    memory: mem && { ...mem, floorBytes: heavy.config.minFreeMb * MB },
    slots: {
      max: heavy.config.max,
      running: heavy.running.map((r) => ({ ...r, taskTitle: title(r.taskId), ...of(r.name), verdict: verdict(now - Date.parse(r.startedAt), of(r.name)) })),
      waiting: heavy.waiting.map((w) => ({ ...w, taskTitle: title(w.taskId), ...of(w.name) })),
    },
    eta: estimateDone(heavy.running, heavy.waiting, heavy.config.max, typical, now),
    consumers: latest?.ts
      ? { at: latest.ts, groups: rows.map((g) => ({ taskId: g.task_id, taskTitle: title(g.task_id), owner: g.owner, kind: g.kind, rssBytes: g.rss, procs: g.procs })) }
      : null,
    jobs: db.listJobs(now - JOBS_KEEP_MS).map(({ summary: _s, cwd: _c, ...j }) => ({ ...j, taskTitle: title(j.taskId) })),
  };
}
