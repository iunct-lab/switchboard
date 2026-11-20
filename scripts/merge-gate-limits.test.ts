// test-reads: scripts/merge-gate-limits.ts
import { describe, expect, test } from "bun:test";
import { limitsRaised, limitsRaisedOf } from "./merge-gate-limits";

const j = (v: unknown) => JSON.stringify(v);
const PERF = "scripts/perf-budget.json";
const LICENSES = "scripts/licenses.allow.json";
const KNOWN = "known-failures.json";
const SIZE = "scripts/file-size.ts";
const sizeFile = (source: number, test: number) => `export const ROOTS = ["a"];\nexport const SOURCE_LIMIT = ${source};\nexport const TEST_LIMIT = ${test};\nexport const STILL_OVER = { "x.ts": 1 };\n`;
const budget = (layoutCount: number, extra: Record<string, unknown> = {}) => j({ local: { journeys: { launch: { requests: 13, layoutCount } } }, exceptions: [], ...extra });

describe("limitsRaised raises", () => {
  test("perf-budget: a number raised, a key added, an exception added", () => {
    expect(limitsRaised(PERF, budget(5), budget(8))).toEqual([`${PERF} local.journeys.launch.layoutCount: 5 → 8`]);
    expect(limitsRaised(PERF, budget(5), j({ local: { journeys: { launch: { requests: 13, layoutCount: 5, recalcStyleCount: 7 } } }, exceptions: [] }))).toEqual([`${PERF} local.journeys.launch.recalcStyleCount: (なし) → 7`]);
    const exception = { key: "local.journeys.launch.layoutCount", issue: 12 };
    expect(limitsRaised(PERF, budget(5), budget(5, { exceptions: [exception] }))).toEqual([`${PERF} exceptions: (なし) → ${j(exception)}`]);
  });

  test("perf-budget: a removed ceiling is no longer checked, so it is asked", () => {
    expect(limitsRaised(PERF, budget(8), j({ local: { journeys: { launch: { requests: 13 } } }, exceptions: [] }))).toEqual([`${PERF} local.journeys.launch.layoutCount: 8 → (なし)`]);
  });

  test("licenses.allow: a word allowed, an exception added, an until extended", () => {
    const ex = (until: string) => ({ name: "lightningcss", license: "MPL-2.0", reason: "r", until });
    const file = (allowed: string[], exceptions: unknown[]) => j({ allowed, exceptions });
    expect(limitsRaised(LICENSES, file(["MIT"], []), file(["MIT", "GPL-3.0"], []))).toEqual([`${LICENSES} allowed: (なし) → "GPL-3.0"`]);
    expect(limitsRaised(LICENSES, file(["MIT"], []), file(["MIT"], [ex("2027-01-01")]))).toEqual([`${LICENSES} exceptions: (なし) → ${j(ex("2027-01-01"))}`]);
    expect(limitsRaised(LICENSES, file(["MIT"], [ex("2027-01-01")]), file(["MIT"], [ex("2028-01-01")]))).toEqual([`${LICENSES} exceptions lightningcss MPL-2.0 until: 2027-01-01 → 2028-01-01`]);
  });

  test("known-failures: an entry added, an until extended", () => {
    const e = (until: string) => ({ test: "a.test.ts > t", issue: 3, until });
    expect(limitsRaised(KNOWN, "[]", j([e("2026-12-01")]))).toEqual([`${KNOWN}: (なし) → ${j(e("2026-12-01"))}`]);
    expect(limitsRaised(KNOWN, j([e("2026-12-01")]), j([e("2027-01-01")]))).toEqual([`${KNOWN} a.test.ts > t until: 2026-12-01 → 2027-01-01`]);
  });

  test("file-size: SOURCE_LIMIT and TEST_LIMIT raised, STILL_OVER ignored", () => {
    expect(limitsRaised(SIZE, sizeFile(1000, 2000), sizeFile(1200, 2500))).toEqual([`${SIZE} SOURCE_LIMIT: 1000 → 1200`, `${SIZE} TEST_LIMIT: 2000 → 2500`]);
    expect(limitsRaised(SIZE, sizeFile(1000, 2000), sizeFile(1000, 2000).replace('"x.ts": 1', '"x.ts": 9, "y.ts": 5'))).toEqual([]);
  });

  test("a new file adds everything it holds", () => {
    expect(limitsRaised(KNOWN, null, j([{ test: "a", issue: 1, until: "2026-12-01" }]))).toHaveLength(1);
    expect(limitsRaised(PERF, null, budget(5))).toEqual([`${PERF} local.journeys.launch.requests: (なし) → 13`, `${PERF} local.journeys.launch.layoutCount: (なし) → 5`]);
  });
});

describe("limitsRaised lowering only", () => {
  test("a lowered number, a removed entry, a shortened until, a removed file", () => {
    expect(limitsRaised(PERF, budget(8), budget(5))).toEqual([]);
    expect(limitsRaised(PERF, budget(5, { exceptions: [{ key: "k", issue: 1 }] }), budget(5))).toEqual([]);
    expect(limitsRaised(LICENSES, j({ allowed: ["MIT", "ISC"], exceptions: [] }), j({ allowed: ["MIT"], exceptions: [] }))).toEqual([]);
    const e = (until: string) => ({ test: "t", issue: 3, until });
    expect(limitsRaised(KNOWN, j([e("2027-01-01")]), j([e("2026-12-01")]))).toEqual([]);
    expect(limitsRaised(KNOWN, j([e("2027-01-01")]), "[]")).toEqual([]);
    expect(limitsRaised(SIZE, sizeFile(1000, 2000), sizeFile(800, 1500))).toEqual([]);
    expect(limitsRaised(PERF, budget(5), null)).toEqual([]);
  });
});

describe("limitsRaised unreadable asks", () => {
  test("a file that is not the expected form counts as raised", () => {
    const line = (p: string) => [`${p}: 読めない（上げたとして聞く）`];
    expect(limitsRaised(PERF, budget(5), "{ not json")).toEqual(line(PERF));
    expect(limitsRaised(PERF, "{ not json", budget(5))).toEqual(line(PERF));
    expect(limitsRaised(PERF, budget(5), "[1]")).toEqual(line(PERF));
    expect(limitsRaised(PERF, budget(5), budget(5).replace('"layoutCount":5', '"layoutCount":"1000"'))).toEqual(line(PERF));
    expect(limitsRaised(LICENSES, j({ allowed: [], exceptions: [] }), j({ allowed: "MIT", exceptions: [] }))).toEqual(line(LICENSES));
    expect(limitsRaised(KNOWN, "[]", "{}")).toEqual(line(KNOWN));
    expect(limitsRaised(SIZE, sizeFile(1000, 2000), "export const SOURCE_LIMIT = Infinity;\n")).toEqual(line(SIZE));
  });

  test("a side that cannot be read counts as raised; an added file has no base and a removed one no head", async () => {
    const files = [{ path: PERF }, { path: KNOWN, status: "added" as const }, { path: LICENSES, status: "removed" as const }, { path: "other.ts" }];
    const asked: string[] = [];
    const out = await limitsRaisedOf(files, async (side, path) => {
      asked.push(`${side} ${path}`);
      if (path === PERF) throw new Error("not found");
      return "[]";
    });
    expect(out).toEqual([`${PERF}: 読めない（上げたとして聞く）`]);
    expect(asked).toEqual([`base ${PERF}`, `head ${KNOWN}`, `base ${LICENSES}`]);
  });
});
