// test-reads: none
import { describe, expect, test } from "bun:test";
import { buildImportGraph, select } from "./test-select";
import { distribution, failedTests, findTestFiles, groupChanges, perFile, retarget } from "./test-select-replay";

describe("groupChanges", () => {
  test("同じ課題番号のコミットをまとめ、番号の無いコミットは 1 件ずつ", () => {
    const log = "\0aaa feat: a (#10)\n\nM\tx.ts\n\0bbb fix: review for #10\n\nM\ty.ts\nM\tx.ts\n\0ccc chore: b\n\nM\tz.ts\n\0ddd chore: c\n\nA\tw.ts\n\0eee empty (#11)\n\n";
    expect(groupChanges(log).map((g) => g.changed)).toEqual([["x.ts", "y.ts"], ["z.ts"], ["w.ts"]]);
  });

  test("--name-status から消したファイルを分け、いちばん新しいコミットを持つ", () => {
    const log = "\0new fix (#10)\n\nM\ta.ts\nD\tgone.ts\n\0old feat (#10)\n\nD\ta.ts\nA\tgone.ts\nM\tb.ts\n";
    expect(groupChanges(log)).toEqual([{ changed: ["a.ts", "gone.ts", "b.ts"], deleted: ["gone.ts"], commit: "new" }]);
  });
});

test("retarget: 後で消えたファイルは当時の読み込み元に置き換え、消したテストは外す", () => {
  const group = { changed: ["moved.ts", "orphan.ts", "old.test.ts", "same-change.ts", "alive.ts", "doc.md"], deleted: ["same-change.ts"], commit: "abc" };
  const now = new Set(["alive.ts", "user-a.ts", "user-b.ts", "doc.md"]);
  const asked: string[] = [];
  const { changed, vanished } = retarget(group, (p) => now.has(p), (commit, path) => {
    asked.push(`${commit}:${path}`);
    return path === "moved.ts" ? ["user-a.ts", "user-b.ts"] : [];
  });
  expect(changed).toEqual(["user-a.ts", "user-b.ts", "orphan.ts", "same-change.ts", "alive.ts", "doc.md"]);
  expect(vanished).toEqual(["orphan.ts"]);
  expect(asked).toEqual(["abc:moved.ts", "abc:orphan.ts", "abc:old.test.ts"]);
});

describe("perFile", () => {
  // lib.ts ← hub.ts ← mid.ts と読み、mid.ts を 100 本のテストが、hub.ts を 1 本のテストが直に読む（しきい値 100 を件数で越えるため 100 本並べる）。
  const files = ["lib.ts", "hub.ts", "mid.ts", "leaf.ts", "hub.test.ts", ...Array.from({ length: 100 }, (_, i) => `t${i}.test.ts`)];
  const src: Record<string, string> = {
    "lib.ts": "export const a = 1;",
    "hub.ts": 'import "./lib";',
    "mid.ts": 'import "./hub";',
    "leaf.ts": "export const b = 1;",
    "hub.test.ts": '// test-reads: none\nimport "./hub";',
  };
  for (let i = 0; i < 100; i++) src[`t${i}.test.ts`] = `// test-reads: none\nimport "./mid";`;
  const read = (p: string) => src[p] ?? "";
  const graph = buildImportGraph(files, read);
  const tests = files.filter((f) => f.endsWith(".test.ts"));

  test("100 件以上になるソースと、そこで止めると 100 件未満になる本数を数える。止めたファイルを直に読むテストは残す", () => {
    const { own, wide, rows } = perFile(["lib.ts", "hub.ts", "mid.ts", "leaf.ts"], graph, tests, new Map(), 20);
    for (const [f, n] of own) expect(n).toBe(select([f], graph, tests).tests.length);
    expect(wide).toEqual(["lib.ts", "hub.ts", "mid.ts"]);
    expect(rows).toEqual([
      { file: "hub.ts", through: 1, stopping: 1, own: 101, direct: 1 },
      { file: "mid.ts", through: 2, stopping: 0, own: 100, direct: 100 },
    ]);
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
