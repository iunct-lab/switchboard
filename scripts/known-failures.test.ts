import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedTests, knownLines, parseKnownFailures, readKnownFailures, subtractKnown, type KnownFailure } from "./known-failures";
import { sh } from "./local-ci";

describe("parseKnownFailures", () => {
  const row = `{"test":"a.test.ts > t","issue":12,"until":"2026-11-20"}`;
  test("空の配列と空の文字列は []", () => {
    expect(parseKnownFailures("[]")).toEqual([]);
    expect(parseKnownFailures("")).toEqual([]);
  });
  test("正しい行を読む", () => {
    expect(parseKnownFailures(`[\n${row}\n]`)).toEqual([{ test: "a.test.ts > t", issue: 12, until: "2026-11-20" }]);
  });
  test("番号なしは行番号つきの Error", () => {
    expect(() => parseKnownFailures(`[\n${row},\n{"test":"b","until":"2026-11-20"}\n]`)).toThrow(/line 3.*issue/);
  });
  test("期限なしは行番号つきの Error", () => {
    expect(() => parseKnownFailures(`[\n{"test":"b","issue":1}\n]`)).toThrow(/line 2.*until/);
  });
  test("実在しない日付・形式違い・正でない番号は Error", () => {
    expect(() => parseKnownFailures(`[{"test":"b","issue":1,"until":"2026-02-30"}]`)).toThrow(/until/);
    expect(() => parseKnownFailures(`[{"test":"b","issue":1,"until":"2026-1-5"}]`)).toThrow(/until/);
    expect(() => parseKnownFailures(`[{"test":"b","issue":0,"until":"2026-11-20"}]`)).toThrow(/issue/);
    expect(() => parseKnownFailures(`[{"test":"b","issue":1.5,"until":"2026-11-20"}]`)).toThrow(/issue/);
  });
  test("配列でない・JSON でないは Error", () => {
    expect(() => parseKnownFailures(`{}`)).toThrow(/array/);
    expect(() => parseKnownFailures(`[`)).toThrow(/known-failures\.json/);
  });
});

// bun 1.4 の実際の出力の形: ファイルの見出しの行のあとに、ファイルを書かない `(fail)` 行が出て、最後に集計
const bunOut = (files: Record<string, string[]>, extra: string[] = []) =>
  [
    "bun test v1.4.4 (38afee6c8)",
    ...Object.entries(files).flatMap(([f, ls]) => ["", `${f}:`, ...ls.flatMap((l) => ["error: expect(received).toBe(expected)", "", l])]),
    "",
    " 3 pass",
    ` ${Object.values(files).flat().length} fail`,
    ...extra,
    "Ran 9 tests across 2 files. [1.00s]",
  ].join("\n");
const fails = (out: string) => [...new Set(out.split("\n").filter((l) => l.startsWith("(fail)")))];

describe("failedTests", () => {
  test("(fail) 行に直前の見出しのファイルを付ける", () => {
    const out = bunOut({ "scripts/a.test.ts": ["(fail) grp > x [0.04ms]", "(fail) top [5000.80ms]"], "packages/core/src/b.test.ts": ["(fail) y [0.18ms]"] });
    expect(failedTests(out)).toEqual([
      { line: "(fail) grp > x [0.04ms]", test: "scripts/a.test.ts > grp > x" },
      { line: "(fail) top [5000.80ms]", test: "scripts/a.test.ts > top" },
      { line: "(fail) y [0.18ms]", test: "packages/core/src/b.test.ts > y" },
    ]);
  });
  test("最後の `N tests failed:` の一覧（見出しなしの繰り返し）は数えず、集計と合えば差し引く", () => {
    const out = `${bunOut({ "scripts/a.test.ts": ["(fail) grp > x [0.04ms]"] }).replace(/\nRan .*$/, "")}\n\n1 tests failed:\n(fail) grp > x [0.04ms]\nRan 9 tests across 2 files. [1.00s]`;
    expect(failedTests(out)).toEqual([{ line: "(fail) grp > x [0.04ms]", test: "scripts/a.test.ts > grp > x" }]);
    expect(subtractKnown(out, fails(out), [{ test: "scripts/a.test.ts > grp > x", issue: 1, until: "2026-12-01" }], "2026-11-13")?.rest).toEqual([]);
  });
});

describe("subtractKnown", () => {
  const known: KnownFailure[] = [{ test: "scripts/a.test.ts > grp > flaky one", issue: 7, until: "2026-11-20" }];
  const line = "(fail) grp > flaky one [12.50ms]";
  const out = bunOut({ "scripts/a.test.ts": [line] });
  test("期限の前日と当日は subtracted", () => {
    for (const today of ["2026-11-19", "2026-11-20"]) {
      expect(subtractKnown(out, fails(out), known, today)).toEqual({ rest: [], subtracted: [{ test: "scripts/a.test.ts > grp > flaky one", issue: 7, until: "2026-11-20" }], expired: [] });
    }
  });
  test("期限の翌日は rest と expired", () => {
    expect(subtractKnown(out, fails(out), known, "2026-11-21")).toEqual({ rest: [line], subtracted: [], expired: [{ test: "scripts/a.test.ts > grp > flaky one", issue: 7, until: "2026-11-20" }] });
  });
  test("同じ題でもファイルの違う行、題の違う行は rest", () => {
    const o = bunOut({ "scripts/a.test.ts": [line, "(fail) grp > other [1ms]"], "scripts/b.test.ts": ["(fail) grp > flaky one [3ms]"] });
    const r = subtractKnown(o, fails(o), known, "2026-11-13")!;
    expect(r.subtracted.length).toBe(1);
    expect(r.rest).toEqual(["(fail) grp > other [1ms]", "(fail) grp > flaky one [3ms]"]);
  });
  test("同じテストの登録が 2 つなら期限の遅い方", () => {
    const r = subtractKnown(out, fails(out), [{ ...known[0]!, until: "2026-11-01" }, ...known], "2026-11-13")!;
    expect(r.subtracted.map((x) => x.until)).toEqual(["2026-11-20"]);
  });
  test("(fail) でない行は常に rest", () => {
    const over = "over: scripts/a.test.ts > grp > flaky one took 9s";
    expect(subtractKnown(out, [line, over], known, "2026-11-13")!.rest).toEqual([over]);
  });
  test("差し引かない: (fail) 行が無い、集計の fail が (fail) 行より多い（読み込みの失敗）、error がある", () => {
    expect(subtractKnown("error: boom\n 0 pass\n 1 fail", [], known, "2026-11-13")).toBeNull();
    const more = out.replace(" 1 fail", " 2 fail");
    expect(subtractKnown(more, fails(more), known, "2026-11-13")).toBeNull();
    const err = bunOut({ "scripts/a.test.ts": [line] }, [" 1 error"]);
    expect(subtractKnown(err, fails(err), known, "2026-11-13")).toBeNull();
  });
});

describe("knownLines", () => {
  test("見出しと行。空なら何も出さない", () => {
    expect(knownLines("差し引いた:", [{ test: "a.test.ts > t", issue: 7, until: "2026-11-20" }])).toEqual(["", "差し引いた:", "- `a.test.ts > t`（#7、期限 2026-11-20）"]);
    expect(knownLines("差し引いた:", [])).toEqual([]);
  });
});

describe("readKnownFailures", () => {
  test("ref にだけある登録を読み、ファイルの無い ref は []", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.kf."));
    try {
    const git = (...a: string[]) => sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a]);
    await git("init", "-q");
    writeFileSync(join(dir, "x"), "1");
    await git("add", "x");
    await git("commit", "-q", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).trim();
    writeFileSync(join(dir, "known-failures.json"), `[{"test":"a > b","issue":3,"until":"2026-12-01"}]`);
    await git("add", "known-failures.json");
    await git("commit", "-q", "-m", "register");
    const withFile = (await git("rev-parse", "HEAD")).trim();
    writeFileSync(join(dir, "known-failures.json"), "[]"); // 作業ツリーは読まない
    expect(await readKnownFailures(sh, dir, withFile)).toEqual([{ test: "a > b", issue: 3, until: "2026-12-01" }]);
    expect(await readKnownFailures(sh, dir, base)).toEqual([]);
    await expect(readKnownFailures(sh, dir, "no-such-ref")).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
