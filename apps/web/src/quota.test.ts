import { expect, test } from "bun:test";
import { QUOTA_STALE_MS, quotaAsOf, quotaByRunner, quotaStale, resetLabel, windowLabel } from "./quota.ts";

test("windowLabel: the runners' windows in words; an unknown one keeps its name with spaces (#1836)", () => {
  expect(windowLabel("five_hour")).toBe("5 時間");
  expect(windowLabel("seven_day")).toBe("7 日");
  expect(windowLabel("seven_day_overage_included")).toBe("7 日・超過込み");
  expect(windowLabel("seven_day_opus")).toBe("7 日・Opus");
  expect(windowLabel("seven_day_sonnet")).toBe("7 日・Sonnet");
  expect(windowLabel("monthly_credits")).toBe("monthly credits");
  // a name that is a property of every object is still a window name, not a function
  expect(windowLabel("constructor")).toBe("constructor");
  expect(windowLabel("__proto__")).toBe("  proto  ");
});

test("quotaStale: older than 24 h is stale, exactly 24 h is not", () => {
  const now = 1_800_000_000_000;
  expect(quotaStale(now, now)).toBe(false);
  expect(quotaStale(now - QUOTA_STALE_MS, now)).toBe(false);
  expect(quotaStale(now - QUOTA_STALE_MS - 1, now)).toBe(true);
});

test("quotaAsOf and resetLabel: JST; a reset today is the clock only, another day carries the date, 0 is —", () => {
  expect(quotaAsOf(Date.parse("2026-10-18T06:05:00+09:00"))).toBe("10/18 06:05 時点");
  const now = Date.parse("2026-10-18T07:00:00+09:00");
  expect(resetLabel(Math.floor(Date.parse("2026-10-18T09:00:00+09:00") / 1000), now)).toBe("09:00 に戻る");
  expect(resetLabel(Math.floor(Date.parse("2026-10-19T11:00:00+09:00") / 1000), now)).toBe("10/19 11:00 に戻る");
  expect(resetLabel(0, now)).toBe("—");
});

test("quotaByRunner: claude, codex, dak first in that order, other runners after, rows kept in order", () => {
  const rows = [
    { runner: "codex", window: "seven_day" },
    { runner: "newrunner", window: "five_hour" },
    { runner: "claude", window: "five_hour" },
    { runner: "claude", window: "seven_day" },
  ];
  expect(quotaByRunner(rows).map((g) => [g.runner, g.rows.map((r) => r.window)])).toEqual([
    ["claude", ["five_hour", "seven_day"]],
    ["codex", ["seven_day"]],
    ["newrunner", ["five_hour"]],
  ]);
  expect(quotaByRunner([])).toEqual([]);
});
