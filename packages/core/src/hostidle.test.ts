import { describe, expect, test } from "bun:test";
import { evaluateIdle, HostIdle, nextWakeFrom, type IdleInput } from "./hostidle.ts";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000;
const quiet: IdleInput = { running: 0, waiting: 0, background: 0, ws: 0, pty: 0, nextWakeAt: null };

describe("hostidle (#181)", () => {
  test("evaluateIdle: any running / waiting task, runner background job, UI socket or terminal keeps the host up; so does something due within 30 minutes", () => {
    expect(evaluateIdle(quiet, NOW)).toEqual({ idle: true, nextWakeAt: null });
    for (const key of ["running", "waiting", "background", "ws", "pty"] as const) expect(evaluateIdle({ ...quiet, [key]: 1 }, NOW).idle).toBe(false);
    expect(evaluateIdle({ ...quiet, nextWakeAt: NOW + 29 * MIN }, NOW).idle).toBe(false);
    expect(evaluateIdle({ ...quiet, nextWakeAt: NOW + 31 * MIN }, NOW)).toEqual({ idle: true, nextWakeAt: NOW + 31 * MIN });
  });

  test("HostIdle asks to stop once after 20 idle minutes, with the next wake; activity in between starts the count again", () => {
    let now = NOW;
    let input: IdleInput = { ...quiet, nextWakeAt: NOW + 5 * 60 * MIN };
    const stops: Array<number | null> = [];
    const idle = new HostIdle(() => input, (at) => stops.push(at), { now: () => now });
    const minutes = (n: number) => { for (let i = 0; i < n; i++) { idle.tick(); now += MIN; } };
    minutes(20); // ticks at 0..19 min
    expect(stops).toEqual([]);
    idle.tick(); // 20 min
    expect(stops).toEqual([NOW + 5 * 60 * MIN]);
    minutes(30);
    expect(stops).toHaveLength(1); // once

    // a UI socket opens halfway: the next stop comes 20 minutes after it closes
    const idle2 = new HostIdle(() => input, (at) => stops.push(at), { now: () => now });
    stops.length = 0;
    const t0 = now;
    for (let i = 0; i <= 10; i++) { idle2.tick(); now += MIN; }
    input = { ...input, ws: 1 };
    idle2.tick();
    input = { ...input, ws: 0 };
    now += MIN;
    for (let i = 0; i < 20; i++) { idle2.tick(); now += MIN; }
    expect(stops).toEqual([]);
    idle2.tick();
    expect(stops).toHaveLength(1);
    expect(now - t0).toBeGreaterThanOrEqual(32 * MIN);
  });

  test("touch: a socket that came and went between ticks starts the quiet spell again (review #339)", () => {
    let now = NOW;
    const stops: Array<number | null> = [];
    const idle = new HostIdle(() => quiet, (at) => stops.push(at), { now: () => now });
    for (let i = 0; i < 19; i++) { idle.tick(); now += MIN; }
    idle.touch(); // opened and closed at 19 min, never seen by a tick
    for (let i = 0; i < 19; i++) { idle.tick(); now += MIN; }
    expect(stops).toEqual([]);
    now += MIN;
    idle.tick();
    expect(stops).toHaveLength(1);
  });

  test("nextWakeFrom: a resume plan counts only when its runner resumes by itself; disabled schedules never", () => {
    expect(nextWakeFrom([{ resumeAt: NOW, auto: false }], [])).toBeNull();
    expect(nextWakeFrom([{ resumeAt: NOW, auto: true }, { resumeAt: NOW - 1, auto: false }], [{ enabled: true, nextRunAt: NOW + 1 }, { enabled: false, nextRunAt: NOW - 5 }])).toBe(NOW);
    expect(nextWakeFrom([], [{ enabled: true, nextRunAt: NOW + 7 }])).toBe(NOW + 7);
  });
});
