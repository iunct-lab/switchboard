// test-reads: none
import { describe, expect, test } from "bun:test";
import { failureLines, formatCandidates, formatGrowth, growthAlert, parseJunit, quietCandidates, similarCandidates, slowCandidates, type GrowthCounts, type GrowthWeek, type TestCase } from "./test-audit";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2">
  <testsuite name="a.test.ts" file="a.test.ts">
    <testsuite name="outer" file="a.test.ts">
      <testcase name="reads a &gt; b &amp; &apos;c&apos;" classname="outer" time="0.25" file="a.test.ts" line="3" assertions="1" />
      <testcase name="fails" classname="outer" time="0.01" file="a.test.ts" line="4" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;
const tc = (name: string, seconds = 0, file = "a.test.ts", describe = "outer"): TestCase => ({ file, describe, name, seconds });

describe("parseJunit", () => {
  test("reads each testcase, with its entities decoded", () => {
    expect(parseJunit(xml)).toEqual([tc("reads a > b & 'c'", 0.25), tc("fails", 0.01)]);
  });

  test("broken XML is empty, not an exception", () => {
    expect(parseJunit("")).toEqual([]);
    expect(parseJunit("not xml")).toEqual([]);
    expect(parseJunit(xml.slice(0, xml.length / 2))).toEqual([]);
    expect(parseJunit(`<testsuites><testcase classname="x" /></testsuites>`)).toEqual([]);
  });
});

test("slow candidates", () => {
  const slow = slowCandidates([tc("fast", 0.09), tc("edge", 0.1), tc("slowest", 0.8)]);
  expect(slow.map((s) => s.name)).toEqual(["slowest", "edge"]);
  expect(slow[0]!.share).toBeCloseTo(0.8 / 0.99);
});

test("similar candidates", () => {
  const near = "the daemon resumes a task after a restart when the session is alive and the runner answers";
  const cases = [tc(near), tc(`${near} again`), tc("something else entirely"), tc(near, 0, "b.test.ts"), tc(`${near} again`, 0, "a.test.ts", "other")];
  const similar = similarCandidates(cases);
  expect(similar).toHaveLength(1);
  expect(similar[0]).toMatchObject({ file: "a.test.ts", a: near, b: `${near} again` });
  expect(similar[0]!.jaccard).toBeGreaterThanOrEqual(0.8);
  expect(similarCandidates([tc("!!"), tc("??")])).toEqual([]);
});

test("quiet candidates", () => {
  const commits = (n: number, at: number, subject: string, ...paths: string[]) => `\0${at} ${subject}\n\n${paths.join("\n")}\n`.repeat(n);
  const log =
    commits(12, 100, "feat: a", "src/quiet.ts") +
    commits(5, 99, "feat: old", "src/few.ts") + commits(9, 100, "feat: b", "src/few.ts") +
    commits(10, 100, "feat: c", "src/busy.ts") + commits(1, 100, "feat: c", "src/busy.test.ts") +
    commits(10, 100, "feat: d", "src/fixed.tsx") + commits(1, 1, "fix: d", "src/fixed.test.tsx") +
    commits(10, 100, "feat: e", "src/old.ts") + commits(1, 1, "feat: e", "src/old.test.ts") +
    commits(100, 100, "feat: g", "src/rare.ts") + commits(2, 100, "feat: g", "src/rare.test.ts") +
    commits(10, 100, "feat: f", "src/bulk.ts") + commits(1, 100, "test: all", "src/bulk.test.ts", ...Array.from({ length: 49 }, (_, i) => `src/t${i}.test.ts`));
  const files = ["src/quiet.test.ts", "src/few.test.ts", "src/busy.test.ts", "src/fixed.test.tsx", "src/old.test.ts", "src/bulk.test.ts", "src/rare.test.ts"];
  expect(quietCandidates(files, log, 100).map((q) => [q.test, q.bodyChanges, q.testChanges, q.fixTouches])).toEqual([
    ["src/rare.test.ts", 100, 2, 0],
    ["src/quiet.test.ts", 12, 0, 0],
    ["src/old.test.ts", 10, 0, 0],
    ["src/bulk.test.ts", 10, 0, 0],
  ]);
});

test("failure lines keep the failed tests and the counts", () => {
  expect(failureLines("a.test.ts:\n(pass) ok\n(fail) outer > breaks [1.00ms]\nerror: x\n\n 3 pass\n 1 fail\nRan 4 tests")).toEqual(["(fail) outer > breaks [1.00ms]", " 3 pass", " 1 fail"]);
});

test("the tables carry the numbers and stop at the top 20", () => {
  const slow = slowCandidates(Array.from({ length: 25 }, (_, i) => tc(`t${i}`, 1)));
  const out = formatCandidates(slow, [], []);
  expect(out).toContain("## 遅い（25 件）");
  expect(out).toContain("| 1.000 | 4.00% | a.test.ts | t0 |");
  expect(out).not.toContain("t24");
  expect(out).toContain("## 赤にならない（0 件）");
});

const counts = (testLines: number, bodyLines: number): GrowthCounts => ({ testCases: testLines / 10, testLines, bodyLines });
const week = (weekEnd: string, tools: GrowthCounts, product = counts(100, 100)): GrowthWeek => ({ weekEnd, product, tools });

describe("growthAlert", () => {
  test("the tools' test lines growing faster than the body is an alert", () => {
    const weeks = [week("2026-11-01", counts(100, 100)), week("2026-11-08", counts(300, 150), counts(120, 150))];
    expect(growthAlert(weeks)).toEqual({ alert: true, toolTestLinesDelta: 200, bodyLinesDelta: 100 });
  });

  test("the body growing faster, or the tests not growing, is no alert", () => {
    expect(growthAlert([week("a", counts(100, 100)), week("b", counts(150, 300))])).toMatchObject({ alert: false, toolTestLinesDelta: 50, bodyLinesDelta: 200 });
    expect(growthAlert([week("a", counts(100, 100)), week("b", counts(80, 90), counts(100, 90))])).toMatchObject({ alert: false, toolTestLinesDelta: -20 });
  });

  test("fewer than two weeks cannot be judged", () => {
    expect(growthAlert([week("a", counts(100, 100))])).toBeNull();
    expect(growthAlert([])).toBeNull();
  });
});

test("formatGrowth has one row per week and the verdict line", () => {
  const weeks = [week("2026-10-25", counts(100, 100)), week("2026-11-01", counts(200, 120)), week("2026-11-08", counts(500, 140))];
  const out = formatGrowth(weeks);
  expect(out.split("\n").filter((l) => /^\| 2026-/.test(l))).toHaveLength(3);
  expect(out).toContain("| 2026-11-08 | 10 | 100 | 100 | 50 | 500 | 140 |");
  expect(out).toContain("棚卸しを早める");
  expect(formatGrowth(weeks.slice(0, 1))).toContain("判定できません");
  expect(formatGrowth([weeks[0]!, { ...weeks[1]!, tools: counts(100, 500) }])).toContain("早めません");
});
