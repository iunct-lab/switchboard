// test-reads: none
import { describe, expect, test } from "bun:test";
import { buildImportGraph, parseReads, select } from "./test-select";
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
  const changed = retarget(group, (p) => now.has(p), (commit, path) => {
    asked.push(`${commit}:${path}`);
    return path === "moved.ts" ? ["user-a.ts", "user-b.ts"] : [];
  });
  expect(changed).toEqual(["user-a.ts", "user-b.ts", "orphan.ts", "same-change.ts", "alive.ts", "doc.md"]);
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

  test("perFile は組み立ての口とまとめ口のある木でも select と同じ数を出す", () => {
    // 口 server.ts は x.ts を読み、読み手に app.ts と s1.test.ts を持つ。app.ts を 100 本のテストが読む。x.ts は w.ts からも 100 本に届く。
    // x.ts の変更は口で止まり（app.ts へ進まない）、口そのものの変更は止まらない。barrel.ts は export * が 5 行のまとめ口で、s2.test.ts は名前 a だけを読む
    const parts = ["a", "b", "c", "d", "e"];
    const names = ["packages/core/src/server.ts", "packages/core/src/api-test-harness.ts", "app.ts", "w.ts", "x.ts", "barrel.ts", ...parts.map((p) => `${p}.ts`)];
    const many = (prefix: string) => Array.from({ length: 100 }, (_, i) => `${prefix}${i}.test.ts`);
    const fs = [...names, "s1.test.ts", "s2.test.ts", "s3.test.ts", ...many("u"), ...many("v")];
    const code: Record<string, string> = {
      "packages/core/src/server.ts": 'import "../../../x";',
      "packages/core/src/api-test-harness.ts": 'import "./server";',
      "app.ts": 'import "./packages/core/src/server";',
      "w.ts": 'import "./x";',
      "x.ts": "export const x = 1;",
      "barrel.ts": parts.map((p) => `export * from "./${p}";`).join("\n"),
      "s1.test.ts": '// test-reads: none\nimport "./packages/core/src/server";',
      "s2.test.ts": '// test-reads: none\nimport { a } from "./barrel";',
      "s3.test.ts": "// test-reads: c.ts",
    };
    for (const p of parts) code[`${p}.ts`] = `export const ${p} = 1;`;
    for (const t of many("u")) code[t] = '// test-reads: none\nimport "./app";';
    for (const t of many("v")) code[t] = '// test-reads: none\nimport "./w";';
    const g = buildImportGraph(fs, (p) => code[p] ?? "");
    const ts = fs.filter((f) => f.endsWith(".test.ts"));
    const reads = new Map(ts.map((t) => [t, parseReads(code[t])]));
    const { own, rows } = perFile(names, g, ts, reads);
    for (const f of names) expect(own.get(f)).toBe(select([f], g, ts, reads).tests.length);
    // 口で止まるので x.ts は口を直に読む s1 と w.ts 越しの 100 本。口そのものの変更は app.ts 越しの 100 本まで広がる
    expect(own.get("x.ts")).toBe(101);
    expect(own.get("packages/core/src/server.ts")).toBeGreaterThanOrEqual(100);
    // 名前で読むので a.ts だけが s2 を選び、b.ts は選ばない。宣言で読む c.ts は s3 を選ぶ
    expect(own.get("a.ts")).toBe(1);
    expect(own.get("b.ts")).toBe(0);
    expect(own.get("c.ts")).toBe(1);
    // 「通る」も同じ 1 歩で辿るので、口の先の app.ts を通るのは口そのもの（server.ts）だけで、x.ts からは通らない
    expect(rows.find((r) => r.file === "app.ts")?.through).toBe(1);
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
