import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LoadKind, OpsLoad, OpsLoadGroup, OpsLoadHour } from "@switchboard/protocol";
import { type Db, jstDayStart } from "./db.ts";
import { DAEMON_JOB_MARK, HOME_MARK, read, statFields, TASK_MARK } from "./detached.ts";

/**
 * The host's load (#2086, docs/design/ops-metrics.md): one sample of the daemon's systemd unit — the cgroup's memory,
 * swap, limit hits and CPU — and of the processes in it, each attributed to a task (the TASK_MARK in its environment,
 * the same reading as detached.ts) or to the daemon's own work, and to the kind of operation it is. Linux with
 * cgroup v2 only: anywhere else readCgroup is null and nothing is sampled. Nothing leaves the host.
 */
export type { LoadKind };
export type LoadOwner = "task" | "daemon" | "other";

export type ProcInfo = { pid: number; ppid: number; comm: string; cmdline: string; rssBytes: number; cpuTicks: number; taskId: string | null; job: string | null };

export type CgroupReading = {
  memCurrent: number;
  memMax: number | null;
  swapCurrent: number;
  /** memory.events `max`: how many times the unit reached memory.max since it was created (cumulative). */
  eventsMax: number;
  cpuUsageUsec: number;
  /** /proc/pressure/memory avg10 (percent). null when the kernel has no PSI. */
  pressureSomeAvg10: number | null;
  pressureFullAvg10: number | null;
  /** DAK's docker runs in its own unit (sb-dockerd.service), next to ours: only its total. */
  dockerMem: number | null;
};

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : undefined;
};

/** `key value` lines (memory.events, cpu.stat) -> the value of `key`. */
const keyed = (text: string | undefined, key: string): number | undefined => {
  for (const line of text?.split("\n") ?? []) {
    const [k, v] = line.split(" ");
    if (k === key) return num(v);
  }
  return undefined;
};

const pressure = (text: string | undefined, line: "some" | "full"): number | null => {
  const m = text?.split("\n").find((l) => l.startsWith(`${line} `))?.match(/avg10=([\d.]+)/);
  return m ? Number(m[1]) : null;
};

/** The daemon's own unit (`0::<path>` in /proc/self/cgroup) and its values; null when any of them cannot be read. */
export function readCgroup(cgRoot = "/sys/fs/cgroup", procRoot = "/proc"): { dir: string; reading: CgroupReading } | null {
  const line = read(join(procRoot, "self", "cgroup"))?.split("\n").find((l) => l.startsWith("0::"));
  if (!line) return null;
  const dir = join(cgRoot, line.slice(3).trim());
  const memCurrent = num(read(join(dir, "memory.current")));
  const max = read(join(dir, "memory.max"))?.trim();
  const swapCurrent = num(read(join(dir, "memory.swap.current")));
  const eventsMax = keyed(read(join(dir, "memory.events")), "max");
  const cpuUsageUsec = keyed(read(join(dir, "cpu.stat")), "usage_usec");
  if (memCurrent === undefined || max === undefined || swapCurrent === undefined || eventsMax === undefined || cpuUsageUsec === undefined) return null;
  const psi = read(join(procRoot, "pressure", "memory"));
  return {
    dir,
    reading: {
      memCurrent,
      memMax: max === "max" ? null : (num(max) ?? null),
      swapCurrent,
      eventsMax,
      cpuUsageUsec,
      pressureSomeAvg10: pressure(psi, "some"),
      pressureFullAvg10: pressure(psi, "full"),
      dockerMem: num(read(join(dirname(dir), "sb-dockerd.service", "memory.current"))) ?? null,
    },
  };
}

function cgroupPids(dir: string): number[] {
  const pids = (read(join(dir, "cgroup.procs")) ?? "").split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // gone, or not a directory: only its own pids
  }
  return [...pids, ...entries.flatMap((name) => cgroupPids(join(dir, name)))];
}

/** The processes of the unit `cgDir` and the cgroups under it. A pid gone between the list and its files is skipped. */
export function readProcs(cgDir: string, procRoot = "/proc", home?: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const pid of cgroupPids(cgDir)) {
    const raw = read(join(procRoot, String(pid), "stat"));
    const f = statFields(procRoot, pid);
    if (!raw || !f) continue;
    const comm = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
    const rssKb = read(join(procRoot, String(pid), "status"))?.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1];
    const environ = (read(join(procRoot, String(pid), "environ")) ?? "").split("\0");
    const mark = (name: string) => environ.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1) || null;
    const ours = home === undefined || environ.includes(`${HOME_MARK}=${home}`); // another daemon's task is not ours
    out.push({
      pid,
      ppid: Number(f[1]),
      comm,
      cmdline: (read(join(procRoot, String(pid), "cmdline")) ?? "").split("\0").filter(Boolean).join(" "),
      rssBytes: rssKb ? Number(rssKb) * 1024 : 0,
      // stat fields 14 and 15 (utime, stime); f starts at field 3
      cpuTicks: (Number(f[11]) || 0) + (Number(f[12]) || 0),
      taskId: ours ? mark(TASK_MARK) : null,
      job: mark(DAEMON_JOB_MARK),
    });
  }
  return out;
}

export type Attributed = ProcInfo & { owner: LoadOwner; kind: LoadKind };

const PROMOTION = /^\S*git -C \S+ archive |^\S*tar -x |^\S*bun install --frozen-lockfile|^\S*bun run --cwd apps\/web build|\/releases\/[0-9a-f]{40}\/packages\/core\/src\/main\.ts$/;
const argv0 = (p: ProcInfo) => (p.cmdline.split(" ")[0] ?? "").split("/").pop() ?? "";

/**
 * Owner and kind of each process. Owner: the daemon and its ancestors (sb-rescue, scripts/dev.ts); else the task
 * whose mark it carries; else its nearest ancestor's owner (and task); else other. Kind: the first rule that matches, else the nearest ancestor's
 * kind (same owner, same task), else `runner` for the top of a task's tree and `other` for the rest.
 */
export function attribute(procs: ProcInfo[], daemonPid: number): Attributed[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const parent = (p: ProcInfo) => (p.ppid !== p.pid ? byPid.get(p.ppid) : undefined);
  const ancestors = new Set<number>();
  for (let p = byPid.get(daemonPid); p && !ancestors.has(p.pid); p = parent(p)) ancestors.add(p.pid);
  const under = (p: ProcInfo, top: (q: ProcInfo) => boolean): boolean => {
    const seen = new Set<number>();
    for (let q = parent(p); q && !seen.has(q.pid); q = parent(q)) {
      if (top(q)) return true;
      seen.add(q.pid);
    }
    return false;
  };
  // The daemon and its ancestors are the daemon's even with a task's mark (a daemon started from a task's shell carries
  // it). A process without a mark belongs to its nearest marked ancestor: Chrome's zygote and renderers drop the
  // environment, but they are still the task's browser
  const whose = new Map<number, { owner: LoadOwner; taskId: string | null }>();
  const who = (p: ProcInfo, seen = new Set<number>()): { owner: LoadOwner; taskId: string | null } => {
    const known = whose.get(p.pid);
    if (known) return known;
    seen.add(p.pid);
    const q = parent(p);
    const w: { owner: LoadOwner; taskId: string | null } = ancestors.has(p.pid)
      ? { owner: "daemon", taskId: null }
      : p.taskId
        ? { owner: "task", taskId: p.taskId }
        : q && !seen.has(q.pid)
          ? who(q, seen)
          : { owner: "other", taskId: null };
    whose.set(p.pid, w);
    return w;
  };
  for (const p of procs) who(p);
  const owners = new Map(procs.map((p) => [p.pid, whose.get(p.pid)!.owner]));
  const sameTree = (p: ProcInfo, q: ProcInfo) => owners.get(p.pid) === owners.get(q.pid) && whose.get(p.pid)!.taskId === whose.get(q.pid)!.taskId;

  const rule = (p: ProcInfo): LoadKind | null => {
    // a runner's arguments may hold a prompt (`claude -p "… playwright …"`): for a runner only its name counts
    const agent = /^(claude|codex)$/.test(p.comm) || /^(claude|codex)$/.test(argv0(p));
    const text = agent ? p.comm : `${p.comm} ${p.cmdline}`;
    const o = owners.get(p.pid);
    const top = (() => {
      const q = parent(p);
      return !q || !sameTree(p, q);
    })();
    if (/chrome|chromium|headless_shell|playwright/i.test(text)) return "browser";
    if (/docker|containerd|buildkit/i.test(text)) return "docker";
    if (/\bbun test\b|local-ci\.ts|vitest|\btsc\b|perf-bench/.test(text)) return "test";
    if (o === "task" && !top && agent) return "subagent";
    if (p.job === "judge") return "judge";
    if (p.comm === "age") return "archive";
    if (p.comm === "gh" && p.ppid === daemonPid) return "backlog";
    // what sb-rescue runs beside the daemon to promote (rescue/src/releases.ts, promote.ts): git archive | tar, bun install,
    // the web build and the candidate daemon on a spare port. Not scripts/dev.ts's vite, not the rescue agent
    if (o === "daemon" && !ancestors.has(p.pid) && !under(p, (q) => q.pid === daemonPid) && PROMOTION.test(p.cmdline)) return "build";
    return null;
  };

  const kinds = new Map<number, LoadKind>();
  const kindOf = (p: ProcInfo, seen = new Set<number>()): LoadKind => {
    const known = kinds.get(p.pid);
    if (known) return known;
    seen.add(p.pid);
    let k = rule(p);
    if (!k) {
      const q = parent(p);
      if (q && sameTree(p, q) && !seen.has(q.pid)) k = kindOf(q, seen);
      else k = owners.get(p.pid) === "task" ? "runner" : "other";
    }
    kinds.set(p.pid, k);
    return k;
  };
  return procs.map((p) => ({ ...p, taskId: whose.get(p.pid)!.taskId, owner: owners.get(p.pid)!, kind: kindOf(p) }));
}

export type LoadGroup = { taskId: string | null; owner: LoadOwner; kind: LoadKind; rssBytes: number; cpuMs: number; procs: number };
export type LoadTop = { pid: number; taskId: string | null; owner: LoadOwner; kind: LoadKind; comm: string; rssBytes: number };

/**
 * Task × owner × kind totals and the 10 largest processes. CPU is the ticks since the previous sample: all of them
 * for a pid not seen then, none on the first sample (`prevTicks` null — the ticks since each process began are not
 * this minute's). `ticks` is the next call's `prevTicks`.
 */
export function summarize(attributed: Attributed[], prevTicks: Map<number, number> | null, ticksPerSec = 100): { groups: LoadGroup[]; top: LoadTop[]; ticks: Map<number, number> } {
  const groups = new Map<string, LoadGroup>();
  const ticks = new Map<number, number>();
  for (const p of attributed) {
    ticks.set(p.pid, p.cpuTicks);
    const before = prevTicks?.get(p.pid);
    const delta = prevTicks === null ? 0 : before === undefined || before > p.cpuTicks ? p.cpuTicks : p.cpuTicks - before;
    const key = `${p.taskId ?? ""}\0${p.owner}\0${p.kind}`;
    const g = groups.get(key) ?? { taskId: p.taskId, owner: p.owner, kind: p.kind, rssBytes: 0, cpuMs: 0, procs: 0 };
    g.rssBytes += p.rssBytes;
    g.cpuMs += Math.round((delta * 1000) / ticksPerSec);
    g.procs += 1;
    groups.set(key, g);
  }
  const top = [...attributed]
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, 10)
    .map(({ pid, taskId, owner, kind, comm, rssBytes }) => ({ pid, taskId, owner, kind, comm, rssBytes }));
  return { groups: [...groups.values()].sort((a, b) => b.rssBytes - a.rssBytes), top, ticks };
}

/** At or over 90% of memory.max. A unit without a limit is never over. */
export const overLimit = (r: CgroupReading) => r.memMax !== null && r.memCurrent >= r.memMax * 0.9;

const SAMPLE_MS = 60_000;

/**
 * Once a minute (#2086): one sample of the unit into ops_load / ops_load_groups. Where the cgroup cannot be read
 * (macOS, cgroup v1) nothing is written. `daemonPid` is the daemon's own pid; a test passes its fake tree's.
 */
export class OpsLoadSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevTicks: Map<number, number> | null = null;
  private prevCpu: { at: number; usec: number } | null = null;
  private failed = false;

  constructor(
    private db: Db,
    private opts: { home: string; cgRoot?: string; procRoot?: string; daemonPid?: number; now?: () => number },
  ) {}

  tick(): boolean {
    const cg = readCgroup(this.opts.cgRoot, this.opts.procRoot);
    if (!cg) return false;
    const now = this.opts.now?.() ?? Date.now();
    const r = cg.reading;
    const { groups, top, ticks } = summarize(attribute(readProcs(cg.dir, this.opts.procRoot, this.opts.home), this.opts.daemonPid ?? process.pid), this.prevTicks);
    // percent of one CPU (two busy cores = 200): the unit's usage_usec since the last sample over the time between
    const cpuPct = this.prevCpu && now > this.prevCpu.at && r.cpuUsageUsec >= this.prevCpu.usec ? ((r.cpuUsageUsec - this.prevCpu.usec) / ((now - this.prevCpu.at) * 1000)) * 100 : null;
    this.db.insertOpsLoad(
      { memCurrent: r.memCurrent, memMax: r.memMax, swapCurrent: r.swapCurrent, eventsMax: r.eventsMax, cpuPct, pressureSome: r.pressureSomeAvg10, pressureFull: r.pressureFullAvg10, dockerMem: r.dockerMem, top: JSON.stringify(top) },
      groups,
      now,
    );
    this.prevTicks = ticks;
    this.prevCpu = { at: now, usec: r.cpuUsageUsec };
    return true;
  }

  start() {
    const run = () => {
      try {
        this.tick();
      } catch (e) {
        // a sample is not worth the daemon: say it once, keep trying
        if (!this.failed) console.warn(`ops-load: sampling failed (${String((e as Error).message ?? e)})`);
        this.failed = true;
      }
    };
    run();
    this.timer = setInterval(run, SAMPLE_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** `YYYY-MM-DD HH` of the JST hour: JST has no daylight saving, so +9 h of UTC (as db.ts's jstDay). */
const jstHour = (ts: number) => new Date(ts + 9 * 3_600_000).toISOString().slice(0, 13).replace("T", " ");

/**
 * `GET /api/ops/load` (#2086): the last `days` JST days (as opsStops) per JST hour — the peaks and the times the unit
 * reached memory.max (events_max is cumulative: the difference from the row before; a drop means the unit was created
 * again, and then the later value is all new) — and task × owner × kind, largest RSS first. With `taskId` only that
 * task's groups, and no hours.
 */
export function opsLoad(db: Db, days: number, opts: { now?: number; taskId?: string; available: boolean }): OpsLoad {
  const from = jstDayStart(opts.now ?? Date.now(), days - 1);
  const groups = (
    db.sqlite
      .query(
        `SELECT task_id, owner, kind, MAX(rss) AS max_rss, SUM(cpu_ms) AS cpu_ms FROM ops_load_groups WHERE ts >= ?${opts.taskId !== undefined ? " AND task_id = ?" : ""}
         GROUP BY task_id, owner, kind ORDER BY max_rss DESC, cpu_ms DESC`,
      )
      .all(...(opts.taskId !== undefined ? [from, opts.taskId] : [from])) as Array<{ task_id: string | null; owner: OpsLoadGroup["owner"]; kind: LoadKind; max_rss: number; cpu_ms: number }>
  ).map((g) => ({ taskId: g.task_id, owner: g.owner, kind: g.kind, maxRss: g.max_rss, cpuMs: g.cpu_ms }));
  if (opts.taskId !== undefined) return { available: opts.available, days, hours: [], groups };
  type Row = { ts: number; mem_current: number; mem_max: number | null; swap_current: number; events_max: number; cpu_pct: number | null; pressure_full: number | null; docker_mem: number | null };
  const before = db.sqlite.query("SELECT events_max FROM ops_load WHERE ts < ? ORDER BY ts DESC LIMIT 1").get(from) as { events_max: number } | null;
  const rows = db.sqlite.query("SELECT ts, mem_current, mem_max, swap_current, events_max, cpu_pct, pressure_full, docker_mem FROM ops_load WHERE ts >= ? ORDER BY ts").all(from) as Row[];
  const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
  const hours = new Map<string, OpsLoadHour>();
  let prev = before?.events_max ?? null;
  for (const r of rows) {
    const hour = jstHour(r.ts);
    const h = hours.get(hour) ?? { hour, maxMem: 0, memMax: null, maxSwap: 0, limitHits: 0, maxCpuPct: null, maxPressureFull: null, maxDockerMem: null };
    h.maxMem = Math.max(h.maxMem, r.mem_current);
    h.memMax = max(h.memMax, r.mem_max);
    h.maxSwap = Math.max(h.maxSwap, r.swap_current);
    if (prev !== null) h.limitHits += r.events_max >= prev ? r.events_max - prev : r.events_max;
    h.maxCpuPct = max(h.maxCpuPct, r.cpu_pct);
    h.maxPressureFull = max(h.maxPressureFull, r.pressure_full);
    h.maxDockerMem = max(h.maxDockerMem, r.docker_mem);
    hours.set(hour, h);
    prev = r.events_max;
  }
  return { available: opts.available, days, hours: [...hours.values()], groups };
}
