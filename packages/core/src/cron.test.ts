import { describe, expect, test } from "bun:test";
import { matches, nextRun, parseCron } from "./cron.ts";

const at = (s: string) => new Date(s); // local time

describe("cron (#20)", () => {
  test("parses fields, lists, ranges, steps, names and aliases; rejects nonsense", () => {
    const s = parseCron("0,30 9-17/2 * * mon-fri");
    expect([...s.minute]).toEqual([0, 30]);
    expect([...s.hour]).toEqual([9, 11, 13, 15, 17]);
    expect([...s.dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("@nightly").hour]).toEqual([3]);
    expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
    for (const bad of ["* * * *", "60 * * * *", "0 25 * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8", "a b c d e", "*/0 * * * *"]) expect(() => parseCron(bad)).toThrow();
  });

  test("matches and nextRun in local time; day-of-month OR day-of-week when both restricted", () => {
    expect(matches(parseCron("30 3 * * *"), at("2026-09-06T03:30:00"))).toBe(true);
    expect(matches(parseCron("30 3 * * *"), at("2026-09-06T03:31:00"))).toBe(false);
    expect(nextRun("30 3 * * *", at("2026-09-06T03:29:10"))?.toISOString()).toBe(at("2026-09-06T03:30:00").toISOString());
    expect(nextRun("30 3 * * *", at("2026-09-06T03:30:00"))?.toISOString()).toBe(at("2026-09-07T03:30:00").toISOString());
    // 2026-09-06 is a Sunday: next weekday run is Monday
    expect(nextRun("0 9 * * mon-fri", at("2026-09-06T10:00:00"))?.toISOString()).toBe(at("2026-09-07T09:00:00").toISOString());
    // dom 15 OR Sunday: the Sunday the 6th comes before the 15th
    expect(nextRun("0 0 15 * 0", at("2026-09-01T00:00:00"))?.toISOString()).toBe(at("2026-09-06T00:00:00").toISOString());
    expect(nextRun("0 0 31 2 *", at("2026-09-01T00:00:00"))).toBeNull(); // never
    expect(nextRun("* * * * *", at("2026-09-06T03:29:10"))?.toISOString()).toBe(at("2026-09-06T03:30:00").toISOString());
  });

  test("DST spring-forward: a wall-clock time that doesn't exist that day is skipped (not an infinite loop or a wrong day)", () => {
    // 2026-03-08 is the US spring-forward day in America/New_York: 02:00 → 03:00, so 02:30 never happens. `nextRun`
    // walks hour-by-hour and never finds `hour === 2` that day (setHours(2, ...) itself gets normalized forward by
    // the JS Date engine, same as the target time would), so the day is silently skipped — documented, current
    // behavior (docs/design/scheduler.md), pinned here so a future change can't turn it into a hang or a mismatch.
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const next = nextRun("30 2 * * *", new Date("2026-03-08T01:00:00"));
      expect(next?.toISOString()).toBe(new Date("2026-03-09T02:30:00").toISOString());
    } finally {
      process.env.TZ = prevTz;
    }
  });
});
