import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerfSample, PerfSummaryRow, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const DAY = 24 * 3600 * 1000;
const fakeAdapter: RunnerAdapter = {
  id: "claude",
  async detect() {
    return { available: true, version: "fake" };
  },
  start() {
    throw new Error("no runs");
  },
};

describe("everyday journey timings (#639)", () => {
  let home: string;
  let core: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "switchboard-test-perf-"));
    core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [fakeAdapter], { port: 0, selfdevChecks: false });
    base = `http://127.0.0.1:${core.server.port}`;
  });
  afterAll(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const post = (body: unknown) => fetch(`${base}/api/perf`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const count = () => (core.db.sqlite.query("SELECT COUNT(*) AS n FROM perf_samples").get() as { n: number }).n;
  const sample = (over: Partial<PerfSample> = {}): PerfSample => ({ journey: "open-task", device: "desktop", build: "abc123", ms: 120, taskId: null, bytes: null, events: null, ...over });

  test("records samples", async () => {
    core.db.sqlite.exec("DELETE FROM perf_samples");
    const r = await post([sample({ taskId: "t1", bytes: 3_300_000, events: 33_110 }), sample({ journey: "launch", device: "mobile", ms: 900 })]);
    expect(r.status).toBe(200);
    expect(core.db.sqlite.query("SELECT journey, device, build, ms, task_id, bytes, events FROM perf_samples ORDER BY journey").all()).toEqual([
      { journey: "launch", device: "mobile", build: "abc123", ms: 900, task_id: null, bytes: null, events: null },
      { journey: "open-task", device: "desktop", build: "abc123", ms: 120, task_id: "t1", bytes: 3_300_000, events: 33_110 },
    ]);
    // the shape before #2100 (a tab not reloaded since the update) is refused, not saved without the Task's size
    const { taskId: _t, bytes: _b, events: _e, ...old } = sample();
    expect((await post([old])).status).toBe(400);
    // an unknown journey, more than 50 at once, nothing, or not a list: 400 and nothing saved
    expect((await post([sample({ journey: "scroll" as PerfSample["journey"] })])).status).toBe(400);
    expect((await post(Array.from({ length: 51 }, () => sample()))).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(sample())).status).toBe(400);
    expect(count()).toBe(2);
    expect((await post(Array.from({ length: 50 }, () => sample()))).status).toBe(200);
    expect(count()).toBe(52);
  });

  test("summary by period and size", async () => {
    core.db.sqlite.exec("DELETE FROM perf_samples");
    const now = Date.now();
    const open = (events: number | null, ms: number) => sample({ taskId: events === null ? null : "t", events, bytes: null, ms });
    core.db.insertPerfSamples([open(500, 1)], now - 15 * DAY); // before both periods
    core.db.insertPerfSamples([open(500, 100), open(500, 200), open(3000, 900), open(20_000, 4000)], now - 8 * DAY);
    core.db.insertPerfSamples([open(500, 240), open(500, 300), open(20_000, 9000), open(null, 70)], now - 1 * DAY);
    core.db.insertPerfSamples([sample({ journey: "launch", device: "mobile", ms: 50 })], now - 1 * DAY);
    const rows = (await (await fetch(`${base}/api/perf/summary`)).json()) as PerfSummaryRow[];
    expect(rows).toEqual([
      { journey: "launch", device: "mobile", size: null, current: { count: 1, p50: 50, p90: 50 }, previous: null },
      { journey: "open-task", device: "desktop", size: null, current: { count: 1, p50: 70, p90: 70 }, previous: null },
      { journey: "open-task", device: "desktop", size: "small", current: { count: 2, p50: 240, p90: 300 }, previous: { count: 2, p50: 100, p90: 200 } },
      { journey: "open-task", device: "desktop", size: "medium", current: null, previous: { count: 1, p50: 900, p90: 900 } },
      { journey: "open-task", device: "desktop", size: "large", current: { count: 1, p50: 9000, p90: 9000 }, previous: { count: 1, p50: 4000, p90: 4000 } },
    ]);
  });

  test("prunes old samples", async () => {
    core.db.sqlite.exec("DELETE FROM perf_samples");
    const now = Date.now();
    core.db.insertPerfSamples([sample({ ms: 1 })], now - 31 * DAY);
    core.db.insertPerfSamples([sample({ ms: 2 })], now - 29 * DAY);
    expect(count()).toBe(2); // the 31-day-old row was saved relative to its own "now"
    expect((await post([sample({ ms: 3 })])).status).toBe(200);
    expect((core.db.sqlite.query("SELECT ms FROM perf_samples ORDER BY ts").all() as Array<{ ms: number }>).map((r) => r.ms)).toEqual([2, 3]);
  });
});
