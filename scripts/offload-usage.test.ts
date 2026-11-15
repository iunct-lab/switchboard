// test-reads: none
import { describe, expect, test } from "bun:test";
import type { OffloadRecord } from "./offload-record.ts";
import { readBuilds, table, usage, type BuildTime } from "./offload-usage.ts";

const T0 = Date.parse("2026-11-10T00:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const rec = (min: number, build: string, o: Partial<OffloadRecord> = {}): OffloadRecord => ({ at: iso(min), caller: "local-ci", kind: "ci", build, size: "small", key: "k", tree: "/w/a", ...o });
const bt = (min: number, sec: number, size: BuildTime["size"] = "small"): BuildTime => ({ start: T0 + min * 60_000, end: T0 + min * 60_000 + sec * 1000, size });
const o = { windowHours: 24, gapMinutes: 10 };
const row = (rows: ReturnType<typeof usage>, c: string) => rows.find((r) => r.caller === c)!;

describe("usage", () => {
  test("minutes round up per started minute and split by size", () => {
    const rows = usage([rec(0, "a", { key: "1" }), rec(100, "b", { key: "2", size: "large" })], new Map([["a", bt(0, 61)], ["b", bt(100, 60, "large")]]), o);
    expect(row(rows, "local-ci").minutes).toEqual({ small: 2, medium: 0, large: 1 });
  });
  test("a build without an end is running and adds no minutes", () => {
    const rows = usage([rec(0, "a")], new Map([["a", { start: T0, size: "small" }]]), o);
    expect(row(rows, "local-ci")).toMatchObject({ builds: 1, running: 1, minutes: { small: 0, medium: 0, large: 0 } });
  });
  test("same key inside the window is a duplicate, outside it is not", () => {
    const b = new Map([["a", bt(0, 60)], ["b", bt(60, 120)], ["c", bt(60 * 30, 60)]]);
    const rows = usage([rec(0, "a"), rec(60, "b"), rec(60 * 30, "c")], b, o);
    expect(row(rows, "local-ci")).toMatchObject({ builds: 3, dupBuilds: 1, dupMinutes: 2 });
  });
  test("soon counts a different key on the same caller and tree within the gap only", () => {
    const b = new Map([["a", bt(0, 60)], ["b", bt(5, 60)], ["c", bt(6, 60)], ["d", bt(60, 60)]]);
    const same = usage([rec(0, "a", { key: "1" }), rec(5, "b", { key: "2" }), rec(60, "d", { key: "3" })], b, o);
    expect(row(same, "local-ci").soon).toBe(1);
    const other = usage([rec(0, "a", { key: "1" }), rec(6, "c", { key: "2", tree: "/w/b" })], b, o);
    expect(row(other, "local-ci").soon).toBe(0);
    const rerun = usage([rec(0, "a", { key: "1" }), rec(5, "b", { key: "1" })], b, o);
    expect(row(rerun, "local-ci")).toMatchObject({ soon: 0, dupBuilds: 1 });
  });
  test("image builds count under their own caller and never as duplicates", () => {
    const img = (min: number, build: string) => rec(min, build, { kind: "image", key: undefined });
    const rows = usage([img(0, "a"), img(1, "b")], new Map([["a", bt(0, 60)], ["b", bt(1, 60)]]), o);
    expect(row(rows, "イメージ作り")).toMatchObject({ builds: 2, dupBuilds: 0, soon: 0 });
    expect(rows.find((r) => r.caller === "local-ci")).toBeUndefined();
  });
  test("records before since are not counted but are compared with", () => {
    const b = new Map([["b", bt(60, 60)], ["c", bt(65, 60)]]);
    const rows = usage([rec(0, "a"), rec(60, "b"), rec(65, "c", { key: undefined })], b, { ...o, since: T0 + 30 * 60_000 });
    // a is outside the range: b repeats its key, c (no key) follows b within the gap
    expect(row(rows, "local-ci")).toMatchObject({ builds: 2, dupBuilds: 1, soon: 1 });
    // two builds whose key could not be read: not duplicates, but the second followed the first
    const none = usage([rec(0, "a", { key: undefined }), rec(5, "b", { key: undefined })], new Map(), o);
    expect(row(none, "local-ci")).toMatchObject({ dupBuilds: 0, soon: 1 });
  });
});

describe("readBuilds", () => {
  test("reads ISO and epoch-second times, leaves out a build with no start, and takes the size from computeType or the record", () => {
    const text = JSON.stringify([
      ["a", "2026-11-10T00:00:00.000Z", "2026-11-10T00:01:30.000Z", "BUILD_GENERAL1_MEDIUM"],
      ["b", T0 / 1000, T0 / 1000 + 30, null],
      ["c", null, null, "BUILD_GENERAL1_SMALL"],
      ["d", "2026-11-10T00:00:00.000Z", null, "BUILD_GENERAL1_LARGE"],
    ]);
    const got = readBuilds(text, new Map([["b", "large" as const]]));
    expect([...got.keys()]).toEqual(["a", "b", "d"]);
    expect(got.get("a")).toEqual({ start: T0, end: T0 + 90_000, size: "medium" });
    expect(got.get("b")).toEqual({ start: T0, end: T0 + 30_000, size: "large" });
    expect(got.get("d")).toEqual({ start: T0, end: undefined, size: "large" });
  });
});

describe("table", () => {
  test("a total row, and the unreadable line only when there are some", () => {
    const rows = usage([rec(0, "a", { key: "1" }), rec(100, "b", { key: "2", caller: "typecheck" })], new Map([["a", bt(0, 61)], ["b", bt(100, 60)]]), o);
    const t = table(rows, 0);
    expect(t.split("\n").at(-1)).toBe("| total | 2 | 3 / 0 / 0 | 0 / 0 | 0 | 0 |");
    expect(t).not.toContain("unreadable");
    expect(table(rows, 2)).toContain("unreadable builds: 2");
  });
});
