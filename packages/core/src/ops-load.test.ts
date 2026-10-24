import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { attribute, OpsLoadSampler, overLimit, readCgroup, readProcs, summarize, type Attributed, type CgroupReading, type ProcInfo } from "./ops-load.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const HOME = "/home/u/.switchboard";
const DAEMON = 20;

type FakeProc = { pid: number; ppid: number; comm: string; argv: string[]; rssKb: number; ticks?: number; env?: Record<string, string>; sub?: string };

/**
 * sb-rescue (10) → daemon (20) → claude t1 (30) → bash → bun test → bun; claude → node playwright → chrome;
 * chrome → a renderer without the environment; claude → claude -p (a subagent); daemon → gh, claude (judge), age; sb-rescue → bun install (promotion);
 * a vite of t2 started with setsid (its parent is 1, outside the unit); a claude of another daemon's task.
 */
const TREE: FakeProc[] = [
  { pid: 10, ppid: 1, comm: "bun", argv: ["/u/.bun/bin/bun", "/u/.switchboard/rescue/sb-rescue.js"], rssKb: 40_000 },
  { pid: DAEMON, ppid: 10, comm: "bun", argv: ["/u/.bun/bin/bun", "/u/.switchboard/releases/abc/packages/core/src/main.ts"], rssKb: 90_000 },
  { pid: 30, ppid: DAEMON, comm: "claude", argv: ["claude", "--output-format", "stream-json"], rssKb: 300_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 31, ppid: 30, comm: "bash", argv: ["/bin/bash", "-c", "bun test packages"], rssKb: 4_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 32, ppid: 31, comm: "bun", argv: ["bun", "test", "packages"], rssKb: 200_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 33, ppid: 32, comm: "bun", argv: ["bun", "worker.ts"], rssKb: 100_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 34, ppid: 30, comm: "node", argv: ["node", "/x/node_modules/playwright/cli.js", "test"], rssKb: 80_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 35, ppid: 34, comm: "chrome", argv: ["/x/chrome-linux/chrome", "--headless"], rssKb: 500_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 37, ppid: 35, comm: "chrome", argv: ["/x/chrome-linux/chrome", "--type=renderer"], rssKb: 50_000, env: {} }, // the zygote drops the environment
  { pid: 36, ppid: 30, comm: "claude", argv: ["claude", "-p", "check the playwright run"], rssKb: 250_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
  { pid: 40, ppid: DAEMON, comm: "gh", argv: ["gh", "api", "graphql"], rssKb: 30_000 },
  { pid: 41, ppid: DAEMON, comm: "claude", argv: ["claude", "--permission-mode", "plan"], rssKb: 200_000, env: { SWITCHBOARD_DAEMON_JOB: "judge" } },
  { pid: 42, ppid: DAEMON, comm: "age", argv: ["age", "-r", "age1xyz"], rssKb: 6_000 },
  { pid: 50, ppid: 10, comm: "bun", argv: ["/u/.bun/bin/bun", "install", "--frozen-lockfile"], rssKb: 150_000 },
  { pid: 51, ppid: 10, comm: "bun", argv: ["/u/.bun/bin/bun", `/u/.switchboard/releases/${"d".repeat(40)}/packages/core/src/main.ts`], rssKb: 90_000 },
  { pid: 52, ppid: 10, comm: "claude", argv: ["claude", "-p"], rssKb: 20_000 }, // the rescue agent: not a promotion
  { pid: 60, ppid: 1, comm: "node", argv: ["node", "/w/node_modules/.bin/vite"], rssKb: 120_000, env: { SWITCHBOARD_TASK_ID: "t2" }, sub: "scope" },
  { pid: 70, ppid: DAEMON, comm: "claude", argv: ["claude"], rssKb: 10_000, env: { SWITCHBOARD_TASK_ID: "t9", SWITCHBOARD_DAEMON_HOME: "/elsewhere" } },
];

function fakeHost(tree: FakeProc[], cg: Partial<Record<string, string>> = {}): { cgRoot: string; procRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "switchboard-ops-load-"));
  roots.push(root);
  const cgRoot = join(root, "cg");
  const procRoot = join(root, "proc");
  const unit = join(cgRoot, "system.slice", "switchboard.service");
  mkdirSync(join(unit, "scope"), { recursive: true });
  mkdirSync(join(cgRoot, "system.slice", "sb-dockerd.service"), { recursive: true });
  const files: Record<string, string> = {
    "memory.current": "3000000000\n",
    "memory.max": "3400000000\n",
    "memory.swap.current": "80000000\n",
    "memory.events": "low 0\nhigh 0\nmax 12\noom 0\noom_kill 0\n",
    "cpu.stat": "usage_usec 5000000\nuser_usec 4000000\nsystem_usec 1000000\n",
    ...cg,
  };
  for (const [name, text] of Object.entries(files)) if (text !== undefined) writeFileSync(join(unit, name), text);
  writeFileSync(join(cgRoot, "system.slice", "sb-dockerd.service", "memory.current"), "700000000\n");
  writeFileSync(join(unit, "cgroup.procs"), tree.filter((p) => !p.sub).map((p) => `${p.pid}\n`).join("") + "999\n"); // 999 is gone
  writeFileSync(join(unit, "scope", "cgroup.procs"), tree.filter((p) => p.sub).map((p) => `${p.pid}\n`).join(""));
  mkdirSync(join(procRoot, "self"), { recursive: true });
  writeFileSync(join(procRoot, "self", "cgroup"), "0::/system.slice/switchboard.service\n");
  mkdirSync(join(procRoot, "pressure"));
  writeFileSync(join(procRoot, "pressure", "memory"), "some avg10=1.50 avg60=0.20 avg300=0.10 total=1\nfull avg10=0.75 avg60=0.10 avg300=0.01 total=1\n");
  for (const p of tree) {
    const dir = join(procRoot, String(p.pid));
    mkdirSync(dir);
    const ticks = p.ticks ?? 100;
    // comm with a space and a parenthesis: the reader cuts after the last ")"
    writeFileSync(join(dir, "stat"), `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194304 1 0 0 0 ${ticks - 40} 40 0 0 20 0 1 0 1 1 1\n`);
    writeFileSync(join(dir, "status"), `Name:\t${p.comm}\nVmPeak:\t1 kB\nVmRSS:\t   ${p.rssKb} kB\n`);
    writeFileSync(join(dir, "cmdline"), p.argv.join("\0") + "\0");
    const env = { PATH: "/usr/bin", ...(p.env?.SWITCHBOARD_TASK_ID ? { SWITCHBOARD_DAEMON_HOME: HOME } : {}), ...p.env };
    writeFileSync(join(dir, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(""));
  }
  return { cgRoot, procRoot };
}

const sample = (tree = TREE) => {
  const host = fakeHost(tree);
  const cg = readCgroup(host.cgRoot, host.procRoot)!;
  return { host, cg, procs: readProcs(cg.dir, host.procRoot, HOME) };
};
const byPid = (a: Attributed[]) => new Map(a.map((p) => [p.pid, p]));

describe("ops-load (#2086)", () => {
  test("readCgroup reads the unit, PSI and docker's unit", () => {
    const { cg, host } = sample();
    expect(cg.dir).toBe(join(host.cgRoot, "system.slice", "switchboard.service"));
    expect(cg.reading).toEqual({
      memCurrent: 3_000_000_000,
      memMax: 3_400_000_000,
      swapCurrent: 80_000_000,
      eventsMax: 12,
      cpuUsageUsec: 5_000_000,
      pressureSomeAvg10: 1.5,
      pressureFullAvg10: 0.75,
      dockerMem: 700_000_000,
    });
  });

  test("memory.max of `max` is no limit", () => {
    const host = fakeHost(TREE, { "memory.max": "max\n" });
    expect(readCgroup(host.cgRoot, host.procRoot)!.reading.memMax).toBeNull();
  });

  test("readProcs: the unit and the cgroups under it, rss, ticks, marks; a gone pid is skipped", () => {
    const { procs } = sample();
    expect(procs.map((p) => p.pid).sort((a, b) => a - b)).toEqual(TREE.map((p) => p.pid).sort((a, b) => a - b));
    const p = new Map(procs.map((q) => [q.pid, q]));
    expect(p.get(35)).toMatchObject({ ppid: 34, comm: "chrome", rssBytes: 500_000 * 1024, cpuTicks: 100, taskId: "t1", job: null, cmdline: "/x/chrome-linux/chrome --headless" });
    expect(p.get(41)).toMatchObject({ taskId: null, job: "judge" });
    expect(p.get(60)?.taskId).toBe("t2");
    expect(p.get(70)?.taskId).toBeNull(); // another daemon's task
  });

  test("attribute: owner and kind of each process", () => {
    const { procs } = sample();
    const a = byPid(attribute(procs, DAEMON));
    const got = Object.fromEntries([...a.values()].map((p) => [p.pid, `${p.owner}/${p.kind}${p.taskId ? `/${p.taskId}` : ""}`]));
    expect(got).toEqual({
      10: "daemon/other",
      20: "daemon/other",
      30: "task/runner/t1",
      31: "task/test/t1", // `bash -c "bun test …"`
      32: "task/test/t1",
      33: "task/test/t1", // inherits from bun test
      34: "task/browser/t1",
      35: "task/browser/t1",
      37: "task/browser/t1",
      36: "task/subagent/t1", // the prompt names playwright, but a runner counts by its name
      40: "daemon/backlog",
      41: "daemon/judge",
      42: "daemon/archive",
      50: "daemon/build",
      51: "daemon/build",
      52: "daemon/other",
      60: "task/runner/t2", // setsid: the top of t2's tree in the unit
      70: "daemon/other",
    });
  });

  test("attribute: a process outside the daemon's tree without a mark is other", () => {
    const tree: FakeProc[] = [...TREE, { pid: 80, ppid: 1, comm: "sleep", argv: ["sleep", "9"], rssKb: 1 }];
    expect(byPid(attribute(sample(tree).procs, DAEMON)).get(80)).toMatchObject({ owner: "other", kind: "other" });
  });

  test("attribute: under scripts/dev.ts the daemon's siblings (vite) are not a build; a daemon carrying a task's mark is the daemon's", () => {
    const tree: FakeProc[] = [
      { pid: 5, ppid: 1, comm: "bun", argv: ["bun", "scripts/dev.ts"], rssKb: 30_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
      { pid: 6, ppid: 5, comm: "bun", argv: ["bun", "--watch", "src/main.ts"], rssKb: 90_000, env: { SWITCHBOARD_TASK_ID: "t1" } },
      { pid: 7, ppid: 5, comm: "node", argv: ["node", "/w/node_modules/.bin/vite"], rssKb: 120_000 },
      { pid: 8, ppid: 7, comm: "esbuild", argv: ["/w/esbuild", "--service=0.25.0"], rssKb: 20_000 },
    ];
    const a = byPid(attribute(sample(tree).procs, 6));
    expect([5, 6, 7, 8].map((pid) => `${a.get(pid)!.owner}/${a.get(pid)!.kind}`)).toEqual(["daemon/other", "daemon/other", "daemon/other", "daemon/other"]);
  });

  test("summarize cpu delta", () => {
    const tree = TREE.map((p) => ({ ...p, ticks: p.pid === 32 ? 500 : 100 }));
    const a = attribute(sample(tree).procs, DAEMON);
    const first = summarize(a, null);
    expect(first.groups.every((g) => g.cpuMs === 0)).toBe(true);
    // 32 used 300 ticks since; 33 is new to the previous sample (all its 100 ticks); 31 restarted (fewer ticks than before)
    const prev = new Map(first.ticks);
    prev.set(32, 200);
    prev.delete(33);
    prev.set(31, 1000);
    const test = summarize(a, prev).groups.find((g) => g.taskId === "t1" && g.kind === "test")!;
    expect(test).toEqual({ taskId: "t1", owner: "task", kind: "test", rssBytes: (4_000 + 200_000 + 100_000) * 1024, cpuMs: 3000 + 1000 + 1000, procs: 3 });
    expect(summarize(a, prev).ticks.get(32)).toBe(500);
  });

  test("summarize groups by task, owner and kind, largest first", () => {
    const { groups } = summarize(attribute(sample().procs, DAEMON), null);
    expect(groups[0]).toMatchObject({ taskId: "t1", kind: "browser", rssBytes: 630_000 * 1024, procs: 3 });
    expect(groups.map((g) => g.rssBytes)).toEqual([...groups.map((g) => g.rssBytes)].sort((a, b) => b - a));
    expect(groups.filter((g) => g.owner === "daemon").map((g) => g.kind).sort()).toEqual(["archive", "backlog", "build", "judge", "other"]);
  });

  test("top 10", () => {
    const { top } = summarize(attribute(sample().procs, DAEMON), null);
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ pid: 35, taskId: "t1", owner: "task", kind: "browser", comm: "chrome", rssBytes: 500_000 * 1024 });
    expect(top.map((t) => t.rssBytes)).toEqual([...top.map((t) => t.rssBytes)].sort((a, b) => b - a));
  });

  test("overLimit at 90% of memory.max", () => {
    const r: CgroupReading = { memCurrent: 0, memMax: 1000, swapCurrent: 0, eventsMax: 0, cpuUsageUsec: 0, pressureSomeAvg10: null, pressureFullAvg10: null, dockerMem: null };
    expect(overLimit({ ...r, memCurrent: 899 })).toBe(false);
    expect(overLimit({ ...r, memCurrent: 900 })).toBe(true);
    expect(overLimit({ ...r, memCurrent: 5000, memMax: null })).toBe(false);
  });

  test("unreadable cgroup", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard-ops-load-none-"));
    roots.push(root);
    expect(readCgroup(join(root, "cg"), join(root, "proc"))).toBeNull(); // no /proc/self/cgroup (macOS)
    expect(readProcs(join(root, "cg"), join(root, "proc"))).toEqual([]);
    const host = fakeHost(TREE, { "memory.current": undefined }); // cgroup v1 / no memory controller
    expect(readCgroup(host.cgRoot, host.procRoot)).toBeNull();
  });

  test("never calls fetch", () => {
    const saved = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("ops-load must not send anything");
    }) as unknown as typeof fetch;
    try {
      const { cg, host } = sample();
      summarize(attribute(readProcs(cg.dir, host.procRoot, HOME), DAEMON), null);
    } finally {
      globalThis.fetch = saved;
    }
    expect(calls).toBe(0);
  });

  test("ProcInfo has only what the sample needs (no environment beyond the two marks)", () => {
    const keys: (keyof ProcInfo)[] = ["pid", "ppid", "comm", "cmdline", "rssBytes", "cpuTicks", "taskId", "job"];
    expect(Object.keys(sample().procs[0]!).sort()).toEqual([...keys].sort());
  });
});

describe("ops-load sampler (#2086)", () => {
  const db = () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-ops-load-db-"));
    roots.push(dir);
    return new Db(join(dir, "x.db"));
  };
  const rows = (d: Db) => d.sqlite.query("SELECT * FROM ops_load ORDER BY ts").all() as Array<Record<string, number | string | null>>;
  const groups = (d: Db, ts: number) => d.sqlite.query("SELECT task_id, owner, kind, rss, cpu_ms, procs FROM ops_load_groups WHERE ts = ? ORDER BY rss DESC").all(ts) as Array<Record<string, number | string | null>>;

  test("tick writes a row", () => {
    const d = db();
    const host = fakeHost(TREE);
    let now = 1_000_000_000_000;
    const s = new OpsLoadSampler(d, { home: HOME, ...host, daemonPid: DAEMON, now: () => now });
    expect(s.tick()).toBe(true);
    now += 60_000;
    writeFileSync(join(host.cgRoot, "system.slice", "switchboard.service", "cpu.stat"), "usage_usec 35000000\n"); // 30 s of CPU in 60 s
    expect(s.tick()).toBe(true);
    const [first, second] = rows(d);
    expect(first).toMatchObject({ mem_current: 3_000_000_000, mem_max: 3_400_000_000, swap_current: 80_000_000, events_max: 12, cpu_pct: null, pressure_some: 1.5, pressure_full: 0.75, docker_mem: 700_000_000 });
    expect(second!.cpu_pct).toBeCloseTo(50, 5);
    expect(groups(d, now)[0]).toEqual({ task_id: "t1", owner: "task", kind: "browser", rss: 630_000 * 1024, cpu_ms: 0, procs: 3 }); // no tick moved
    expect(groups(d, now).map((g) => g.kind)).toContain("judge");
    d.close();
  });

  test("top at 90%", () => {
    const d = db();
    const host = fakeHost(TREE, { "memory.current": "3100000000\n" }); // over 90% of 3.4 GB
    new OpsLoadSampler(d, { home: HOME, ...host, daemonPid: DAEMON, now: () => 5 }).tick();
    const top = JSON.parse(String(rows(d)[0]!.top)) as Array<{ pid: number; kind: string; comm: string; taskId: string | null }>;
    expect(top).toHaveLength(10);
    expect(top[0]).toMatchObject({ pid: 35, kind: "browser", comm: "chrome", taskId: "t1" });
    d.close();
  });

  test("prunes after 7 days", () => {
    const d = db();
    const host = fakeHost(TREE);
    let now = 1_000_000_000_000;
    const s = new OpsLoadSampler(d, { home: HOME, ...host, daemonPid: DAEMON, now: () => now });
    s.tick();
    now += 6 * 86_400_000;
    s.tick();
    now += 2 * 86_400_000; // the first is 8 days old now, the second 2
    s.tick();
    expect(rows(d).map((r) => r.ts)).toEqual([1_000_000_000_000 + 6 * 86_400_000, now]);
    expect((d.sqlite.query("SELECT DISTINCT ts FROM ops_load_groups ORDER BY ts").all() as Array<{ ts: number }>).map((r) => r.ts)).toEqual([1_000_000_000_000 + 6 * 86_400_000, now]);
    d.close();
  });

  test("unreadable writes nothing", () => {
    const d = db();
    const root = mkdtempSync(join(tmpdir(), "switchboard-ops-load-none-"));
    roots.push(root);
    expect(new OpsLoadSampler(d, { home: HOME, cgRoot: join(root, "cg"), procRoot: join(root, "proc") }).tick()).toBe(false);
    expect(rows(d)).toEqual([]);
    expect(d.sqlite.query("SELECT COUNT(*) AS n FROM ops_load_groups").get()).toEqual({ n: 0 });
    d.close();
  });
});
