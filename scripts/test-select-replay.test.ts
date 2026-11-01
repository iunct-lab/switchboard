// test-reads: none
import { describe, expect, test } from "bun:test";
import { distribution, failedTests, findTestFiles, groupChanges } from "./test-select-replay";

describe("groupChanges", () => {
  test("同じ課題番号のコミットをまとめ、番号の無いコミットは 1 件ずつ", () => {
    const log = "\0feat: a (#10)\n\nx.ts\n\0fix: review for #10\n\ny.ts\nx.ts\n\0chore: b\n\nz.ts\n\0chore: c\n\nw.ts\n\0empty (#11)\n\n";
    expect(groupChanges(log)).toEqual([["x.ts", "y.ts"], ["z.ts"], ["w.ts"]]);
  });
});

describe("distribution", () => {
  const of = (n: number, full?: string) => ({ tests: Array.from({ length: n }, (_, i) => `${i}`), reasons: {}, full });

  test("中央値・p90・全テストに倒した割合", () => {
    const d = distribution([of(1), of(2), of(3), of(4), of(5), of(6), of(7), of(8), of(9), of(210, "x")]);
    expect(d).toEqual({ groups: 10, median: 5, p90: 9, full: 1, fullRate: 0.1 });
  });

  test("0 件でも落ちない", () => {
    expect(distribution([])).toEqual({ groups: 0, median: 0, p90: 0, full: 0, fullRate: 0 });
  });
});

describe("failedTests", () => {
  test("(fail) の行だけを、時間を外して重ねずに取る", () => {
    const body = "    (pass) a > ok [1.00ms]\n    (fail) a > bad one [12.50ms]\n(fail) top\n    (fail) a > bad one [3.00ms]\nnot (fail) here\n";
    expect(failedTests(body)).toEqual(["a > bad one", "top"]);
  });
});

describe("findTestFiles", () => {
  const tests = [{ path: "a.test.ts", src: `test("does x", () => {});` }, { path: "b.test.ts", src: `describe("d", () => { test("does y", () => {}); });` }];

  test("名前の最後の段でファイルを探す", () => {
    expect(findTestFiles("d > does y", tests)).toEqual(["b.test.ts"]);
    expect(findTestFiles("gone", tests)).toEqual([]);
  });
});
