import { beforeEach, expect, test } from "bun:test";
import type { PerfSample, PerfSummaryRow } from "@switchboard/protocol";
import { buildId, detailBytes, deviceKind, flushSamples, journeyCancel, journeyEnd, journeyStart, perfRows } from "./perf.ts";

// the page the samples describe: the built bundle's module script, a desktop-wide window
let scriptSrc: string | null = "/assets/index-BFfgnOXB.js";
Object.assign(globalThis, { innerWidth: 1280, location: { href: "http://localhost:5173/" }, document: { querySelector: () => (scriptSrc === null ? null : { getAttribute: () => scriptSrc }) } });

// frames run when the test says so, so "after the paint" is observable
let frames: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
const paint = () => {
  for (let i = 0; i < 2; i++) {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  }
};
const measures = (name: string) => performance.getEntriesByName(name, "measure").length;

beforeEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
  frames = [];
});

test("start then end makes one measure, after the paint", () => {
  journeyStart("new-task");
  journeyEnd("new-task");
  expect(measures("sb:new-task")).toBe(0);
  paint();
  expect(measures("sb:new-task")).toBe(1);
});

test("end without start is ignored", () => {
  journeyEnd("open-task");
  paint();
  expect(measures("sb:open-task")).toBe(0);
});

test("second end is ignored", () => {
  journeyStart("send");
  journeyEnd("send");
  journeyEnd("send");
  paint();
  expect(measures("sb:send")).toBe(1);
});

test("launch counts from the navigation and ends once", () => {
  journeyEnd("launch");
  journeyEnd("launch");
  paint();
  expect(performance.getEntriesByName("sb:launch", "measure").map((e) => e.startTime)).toEqual([0]);
});

test("a new start before the paint does not move the ended journey's start", () => {
  journeyStart("new-task");
  const first = performance.getEntriesByName("sb:new-task:start", "mark")[0]!.startTime;
  journeyEnd("new-task");
  Bun.sleepSync(2);
  journeyStart("new-task");
  paint();
  expect(performance.getEntriesByName("sb:new-task", "measure").map((e) => e.startTime)).toEqual([first]);
});

test("a cancelled journey is not ended later", () => {
  journeyStart("new-task");
  journeyCancel("new-task");
  journeyEnd("new-task");
  paint();
  expect(measures("sb:new-task")).toBe(0);
});

test("build id from module script", () => {
  expect(buildId()).toBe("BFfgnOXB");
  scriptSrc = "/assets/index-a-b_c.js"; // Vite's hash may contain - and _
  expect(buildId()).toBe("a-b_c");
  scriptSrc = null; // the dev server loads /src/main.tsx
  expect(buildId()).toBe("dev");
  scriptSrc = "/assets/index-BFfgnOXB.js";
  Object.assign(globalThis, { innerWidth: 699 });
  expect(deviceKind()).toBe("mobile");
  Object.assign(globalThis, { innerWidth: 1280 });
  expect(deviceKind()).toBe("desktop");
});

test("an ended journey is sent with its device and build, at most 50 at once", async () => {
  await flushSamples(async () => undefined); // whatever earlier tests left
  journeyStart("open-task");
  journeyEnd("open-task");
  paint();
  const sent: PerfSample[][] = [];
  await flushSamples(async (rows) => void sent.push(rows));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject([{ journey: "open-task", device: "desktop", build: "BFfgnOXB", taskId: null, bytes: null, events: null }]);
  expect(sent[0]![0]!.ms).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 60; i++) {
    journeyStart("send");
    journeyEnd("send");
    paint();
  }
  await flushSamples(async (rows) => void sent.push(rows));
  expect(sent[1]).toHaveLength(50);
  await flushSamples(async (rows) => void sent.push(rows)); // nothing left: no empty send
  expect(sent).toHaveLength(2);
});

test("an ended journey carries the Task's size", async () => {
  await flushSamples(async () => undefined);
  journeyStart("open-task");
  journeyEnd("open-task", { taskId: "t-size", events: 1234 });
  paint();
  const sent: PerfSample[][] = [];
  await flushSamples(async (rows) => void sent.push(rows));
  // no resource entry for the Task in this runtime: the bytes are unknown, not 0
  expect(sent[0]).toMatchObject([{ journey: "open-task", taskId: "t-size", events: 1234, bytes: null }]);
});

test("detail bytes come from the Task's last detail response", () => {
  const entry = (name: string, decodedBodySize: number) => ({ name, decodedBodySize }) as PerformanceResourceTiming;
  const entries = [
    entry("http://localhost:5173/api/tasks/t1", 1000),
    entry("http://localhost:5173/api/tasks/t1/evals", 9),
    entry("http://localhost:5173/api/tasks/t10", 7),
    entry("http://localhost:5173/api/tasks/t1", 2048),
    entry("http://localhost:5173/api/tasks/t1/artifacts", 5),
    entry("http://localhost:5173/api/tasks/t1?after=900", 300), // a catch-up read is not the Task's size
    entry("http://localhost:5173/api/tasks/t1?limit=0", 200), // nor the read of the rest after a turn (#1142)
    entry("http://localhost:5173/api/tasks/t1?before=101&limit=200", 900), // nor an older page
  ];
  expect(detailBytes("t1", entries)).toBe(2048);
  expect(detailBytes("t2", entries)).toBeNull();
  expect(detailBytes("t1", [entry("http://localhost:5173/api/tasks/t1", 0)])).toBeNull(); // cross-origin without Timing-Allow-Origin reads 0
});

test("a full resource buffer is emptied so later detail responses are seen", () => {
  let cleared = 0;
  const clear = performance.clearResourceTimings.bind(performance);
  performance.clearResourceTimings = () => void cleared++;
  try {
    performance.dispatchEvent(new Event("resourcetimingbufferfull"));
  } finally {
    performance.clearResourceTimings = clear;
  }
  expect(cleared).toBe(1);
});

test("a sample over the API's 10 minutes is dropped, not the batch", async () => {
  await flushSamples(async () => undefined);
  const measure = performance.measure.bind(performance);
  performance.measure = ((name: string, opts?: PerformanceMeasureOptions) => ({ ...measure(name, opts), duration: 600_001 })) as typeof performance.measure;
  try {
    journeyStart("send");
    journeyEnd("send");
    paint();
  } finally {
    performance.measure = measure;
  }
  journeyStart("open-task");
  journeyEnd("open-task");
  paint();
  const sent: PerfSample[][] = [];
  await flushSamples(async (rows) => void sent.push(rows));
  expect(sent.map((rows) => rows.map((r) => r.journey))).toEqual([["open-task"]]);
});

test("send failure is silent", async () => {
  journeyStart("send");
  journeyEnd("send");
  paint();
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    await expect(flushSamples(() => Promise.reject(new Error("503 Service Unavailable")))).resolves.toBeUndefined();
    journeyStart("send");
    journeyEnd("send");
    paint();
    await expect(
      flushSamples(() => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
  } finally {
    console.error = orig;
  }
  expect(errors).toEqual([]);
  // the failed rows are not sent again
  const sent: PerfSample[][] = [];
  await flushSamples(async (rows) => void sent.push(rows));
  expect(sent).toEqual([]);
});

const row = (current: [number, number, number] | null, previous: [number, number, number] | null, journey: PerfSummaryRow["journey"] = "open-task", size: PerfSummaryRow["size"] = "small"): PerfSummaryRow => {
  const stats = (p: [number, number, number] | null) => p && { count: p[0], p50: p[1], p90: p[2] };
  return { journey, device: "desktop", size, current: stats(current), previous: stats(previous) };
};

test("a period slower by 20% is flagged", () => {
  const rows = perfRows([
    row([4, 240, 400], [9, 200, 300]), // +20%: red
    row([4, 239, 400], [9, 200, 300], "send"), // +19.5%: not red
    row([2, 1500, 2600], null, "launch", null), // nothing the 7 days before
    row([3, 90, 120], [5, 100, 150], "new-task", "large"), // faster
    row(null, [5, 100, 150], "open-task", "medium"), // nothing the last 7 days
  ]);
  expect(rows.map((r) => [r.journey, r.size, r.slower, r.change])).toEqual([
    ["open-task", "〜1,000 件", true, "+20%"],
    ["send", "〜1,000 件", false, "+19.5%"],
    ["launch", "—", false, "—"],
    ["new-task", "5,000 件超", false, "-10%"],
    ["open-task", "〜5,000 件", false, "—"],
  ]);
  expect(rows[0]).toMatchObject({ now: "240 ms / 400 ms（4 件）", before: "200 ms / 300 ms（9 件）" });
  expect(rows[2]).toMatchObject({ now: "1.5 s / 2.6 s（2 件）", before: "—" });
  expect(rows[4]).toMatchObject({ now: "—", before: "100 ms / 150 ms（5 件）" });
});
