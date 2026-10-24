import { describe, expect, test } from "bun:test";
import { jstClock, jstDateTime, jstDay, jstStamp, jstTime } from "./time.ts";

// Run with TZ=UTC or TZ=America/New_York: the output must not move with the process's time zone.
describe("JST formatting", () => {
  const at = Date.parse("2026-10-19T08:03:07Z"); // 17:03 JST
  const pastMidnight = Date.parse("2026-10-19T15:30:00Z"); // 00:30 JST on 10/20

  test("the clock is JST on the same JST day", () => {
    expect(jstClock(at, at + 60_000)).toBe("17:03");
    expect(jstTime(at)).toBe("17:03:07");
  });

  test("another JST day gets the date — the day turns at JST midnight, not the browser's", () => {
    expect(jstStamp(at)).toBe("10/19 17:03");
    expect(jstClock(pastMidnight, at)).toBe("10/20 00:30");
    expect(jstClock(at, pastMidnight)).toBe("10/19 17:03");
    expect(jstDay(at)).toBe("2026-10-19");
    expect(jstDay(pastMidnight)).toBe("2026-10-20");
  });

  test("date and time", () => {
    expect(jstDateTime(pastMidnight)).toBe("2026/10/20 00:30:00");
  });
});
