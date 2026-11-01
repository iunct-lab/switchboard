// test-reads: apps/ aws/ ops-kit/ packages/ private/ rescue/ scripts/
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildImportGraph, classify, findStaleReads, findUndeclared, formatSelection, parseReads, select, selectFrom } from "./test-select";

/** 偽のツリー。パス → 中身。 */
function tree(src: Record<string, string>) {
  const files = Object.keys(src);
  const read = (p: string) => {
    const s = src[p];
    if (s === undefined) throw new Error(`no ${p}`);
    return s;
  };
  return { files, read, graph: buildImportGraph(files, read), tests: files.filter((f) => f.endsWith(".test.ts")) };
}

describe("buildImportGraph", () => {
  test("相対 import を、拡張子の省略・index・.js の書き方ごと逆辺にする", () => {
    const { graph } = tree({
      "a/x.ts": `import "./y"; import "./dir"; import "./z.js"; export * from "../b/w";`,
      "a/y.ts": "",
      "a/dir/index.ts": "",
      "a/z.ts": "",
      "b/w.tsx": "",
    });
    for (const f of ["a/y.ts", "a/dir/index.ts", "a/z.ts", "b/w.tsx"]) expect(graph.get(f)).toEqual(["a/x.ts"]);
  });

  test("workspace パッケージ名を package.json の入口へ解決し、外部パッケージは辿らない", () => {
    const { graph } = tree({
      "packages/p/package.json": `{"name":"@s/p","exports":{".":"./src/index.ts"}}`,
      "packages/q/package.json": `{"name":"@s/q","main":"lib.ts"}`,
      "packages/p/src/index.ts": "",
      "packages/p/src/deep.ts": "",
      "packages/q/lib.ts": "",
      "x.ts": `import "@s/p"; import "@s/p/src/deep"; import "@s/q"; import "react"; import "node:fs";`,
    });
    expect(graph.get("packages/p/src/index.ts")).toEqual(["x.ts"]);
    expect(graph.get("packages/p/src/deep.ts")).toEqual(["x.ts"]);
    expect(graph.get("packages/q/lib.ts")).toEqual(["x.ts"]);
    expect(graph.has("react")).toBe(false);
  });

  test("動的 import、require、shebang のあるファイル、.ts でない import も辿る", () => {
    const { graph } = tree({
      "x.ts": `#!/usr/bin/env bun\nawait import("./y"); require("./z"); import p from "./p.html" with { type: "text" };`,
      "y.ts": "",
      "z.ts": "",
      "p.html": "",
    });
    expect(graph.get("y.ts")).toEqual(["x.ts"]);
    expect(graph.get("z.ts")).toEqual(["x.ts"]);
    expect(graph.get("p.html")).toEqual(["x.ts"]);
  });
});

describe("select", () => {
  const chain = () =>
    tree({
      "lib/a.ts": "",
      "lib/b.ts": `import "./a";`,
      "lib/c.ts": `import "./b";`,
      "lib/other.ts": "",
      "lib/c.test.ts": `import "./c";`,
      "lib/a.test.ts": `import "./a";`,
      "lib/other.test.ts": `import "./other";`,
    });

  test("直接と間接の依存のテストを選び、理由に道筋を書く", () => {
    const { graph, tests } = chain();
    const s = select(["lib/a.ts"], graph, tests);
    expect(s.full).toBeUndefined();
    expect(s.tests.sort()).toEqual(["lib/a.test.ts", "lib/c.test.ts"]);
    expect(s.reasons["lib/c.test.ts"]).toBe("lib/a.ts → lib/b.ts → lib/c.ts → lib/c.test.ts");
    expect(s.reasons["lib/a.test.ts"]).toBe("lib/a.ts → lib/a.test.ts");
  });

  test("変更したテスト自身を選ぶ", () => {
    const { graph, tests } = chain();
    const s = select(["lib/other.test.ts"], graph, tests);
    expect(s.tests).toEqual(["lib/other.test.ts"]);
    expect(s.reasons["lib/other.test.ts"]).toContain("変更したテスト");
  });

  test("循環があっても止まり、循環の先のテストを選ぶ", () => {
    const { graph, tests } = tree({
      "a.ts": `import "./b";`,
      "b.ts": `import "./a";`,
      "b.test.ts": `import "./b";`,
    });
    expect(select(["a.ts"], graph, tests).tests).toEqual(["b.test.ts"]);
  });

  test("どのテストにも届かない変更は 0 件で、全テストに倒さない", () => {
    const { graph, tests } = tree({ "lone.ts": "", "x.test.ts": "" });
    const s = select(["lone.ts"], graph, tests);
    expect(s).toEqual({ tests: [], reasons: {} });
  });

  test("判定できない変更が 1 つでも混ざれば全テストに倒し、理由に名指しする", () => {
    const { graph, tests } = chain();
    const s = select(["lib/a.ts", "bun.lock"], graph, tests);
    expect(s.full).toBe("bun.lock: 依存の定義や設定");
    expect(s.tests).toEqual(tests);
  });

  test("今のツリーに無い .ts（消したファイル）と空の一覧は全テストに倒す", () => {
    const { graph, tests } = chain();
    expect(select(["lib/gone.ts"], graph, tests).full).toContain("今のツリーに無い");
    expect(select([], graph, tests).full).toBe("変更の一覧が空");
  });
});

describe("classify", () => {
  test.each([
    ["package.json", "依存の定義や設定"],
    ["packages/core/package.json", "依存の定義や設定"],
    ["bun.lock", "依存の定義や設定"],
    ["bunfig.toml", "依存の定義や設定"],
    ["packages/core/tsconfig.json", "依存の定義や設定"],
    [".github/workflows/ci.yml", "CI の手順"],
    ["scripts/ci.ts", "CI の手順"],
    ["scripts/test-select.ts", "判定の道具自体"],
    ["scripts/test-select.test.ts", "判定の道具自体"],
    ["rescue/src/fixture.ts", "テストの共通部品"],
    ["packages/core/fixtures/github-import.ts", "テストの共通部品"],
    ["packages/adapters/dak/fixtures/fake-adk.ts", "テストの共通部品"],
    ["packages/core/src/backlog-fake-github.ts", "テストの共通部品"],
    ["packages/core/src/policies-harness.ts", "テストの共通部品"],
    ["LICENSE", "分類できないファイル"],
    ["apps/web/public/icon.png", "分類できないファイル"],
  ])("%s → %s", (path, why) => {
    expect(classify(path)).toBe(why);
  });

  test("文書・スキル・シェル・設定の値は宣言で判定するので倒さない", () => {
    for (const p of ["README.md", ".claude/skills/new-repo/SKILL.md", "apps/web/public/sw.js", "aws/host/bootstrap.sh", "compose.yaml", "ops.config.json", "aws/host/switchboard.service"]) expect(classify(p)).toBeUndefined();
  });

  test("普通のコードとテストは倒さない", () => {
    expect(classify("packages/core/src/db.ts")).toBeUndefined();
    expect(classify("apps/web/src/App.tsx")).toBeUndefined();
    expect(classify("packages/core/src/db.test.ts")).toBeUndefined();
  });
});

describe("test-reads", () => {
  test("先頭のコメントを複数行読み、本文の中の文字列は読まない", () => {
    expect(parseReads(`#!/usr/bin/env bun\n// test-reads: docs/a.md aws/host/\n// test-reads: b.sh\nimport "x";\n// note\nconst s = 1;\n// test-reads: late.md\n`)).toEqual(["docs/a.md", "aws/host/", "b.sh"]);
    expect(parseReads(`const s = "// test-reads: x";\n`)).toEqual([]);
  });

  test("ファイルの一致とディレクトリの配下で選び、ディレクトリの名前の前方一致では選ばない", () => {
    const reads = new Map([["t.test.ts", ["docs/a.md", "aws/host/"]]]);
    const graph = new Map();
    expect(select(["docs/a.md"], graph, ["t.test.ts"], reads).reasons["t.test.ts"]).toBe("docs/a.md ← t.test.ts（test-reads）");
    expect(select(["aws/host/x.sh"], graph, ["t.test.ts"], reads).tests).toEqual(["t.test.ts"]);
    expect(select(["aws/hostile.sh"], graph, ["t.test.ts"], reads).tests).toEqual([]);
    expect(select(["docs/b.md"], graph, ["t.test.ts"], reads).tests).toEqual([]);
  });

  test("宣言したコードが import するファイルの変更でも選ぶ（パスで起動するテスト）", () => {
    const { graph } = tree({ "s/run.ts": `import "./lib";`, "s/lib.ts": "" });
    const s = select(["s/lib.ts"], graph, ["t.test.ts"], new Map([["t.test.ts", ["s/run.ts"]]]));
    expect(s.reasons["t.test.ts"]).toBe("s/lib.ts → s/run.ts ← t.test.ts（test-reads）");
  });

  test("消した文書は宣言で判定し、全テストに倒さない", () => {
    const s = select(["docs/gone.md"], new Map(), ["t.test.ts"], new Map([["t.test.ts", ["docs/"]]]));
    expect(s.full).toBeUndefined();
    expect(s.tests).toEqual(["t.test.ts"]);
  });

  test("findUndeclared: 宣言の無いパスの読み取りを返す", () => {
    const of = (src: string) => findUndeclared([{ path: "x.test.ts", src }]);
    expect(of(`import { existsSync, readFileSync } from "node:fs";\nreadFileSync(join(import.meta.dir, "a.md"));`)).toEqual(["x.test.ts"]);
    for (const src of ['await Bun.file("a.md").text();', "readdirSync(dir);", "process.cwd();", 'Bun.spawnSync(["bash", "a.sh"]);', "await import(join(code, \"a.ts\"));", "await Bun.$`ls docs`;", "await $`ls docs`;", 'await readFile("docs/a.md");', 'new Bun.Glob("*.md");', 'cpSync("a", "b");']) expect(of(src)).toEqual(["x.test.ts"]);
  });

  test("findUndeclared: 宣言があるか、読まないテストは返さない", () => {
    const of = (src: string) => findUndeclared([{ path: "x.test.ts", src }]);
    expect(of(`// test-reads: a.md\nreadFileSync(join(import.meta.dir, "a.md"));`)).toEqual([]);
    expect(of(`// test-reads: none\nreadFileSync(join(tmp, "a"));`)).toEqual([]);
    expect(of(`import { x } from "./x";\nawait import("./y");\nexpect(x).toBe(1);`)).toEqual([]);
  });

  test("findUndeclared: none と宣言してリポジトリの場所を取るテストは返す", () => {
    expect(findUndeclared([{ path: "x.test.ts", src: `// test-reads: none\nreadFileSync(join(import.meta.dir, "a.md"));` }])).toEqual(["x.test.ts"]);
  });

  test("findStaleReads: ツリーに無いパスと、末尾 / の無いディレクトリを返す", () => {
    const files = ["aws/host/x.sh", "docs/a.md"];
    const of = (reads: string) => findStaleReads([{ path: "x.test.ts", src: `// test-reads: ${reads}\n` }], files);
    expect(of("docs/a.md aws/host/ none")).toEqual([]);
    expect(of("docs/gone.md aws/host")).toEqual(["x.test.ts: docs/gone.md", "x.test.ts: aws/host"]);
  });

  const declared = (test: string) => parseReads(readFileSync(join(import.meta.dir, "..", test), "utf8"));
  const picks = (test: string, changed: string) => select([changed], new Map(), [test], new Map([[test, declared(test)]])).tests;

  // private/ は公開側の写しに無い
  test.skipIf(!existsSync(join(import.meta.dir, "../private")))("private-words: 語の一覧とキットのファイルの変更で選ばれる", () => {
    expect(picks("private/private-words.test.ts", "private/ops-kit.private-words.txt")).toHaveLength(1);
    expect(picks("private/private-words.test.ts", "ops-kit/skills/issue-workflow/SKILL.md")).toHaveLength(1);
  });

  test("workflow-vars: 公開キットのワークフローの変更で選ばれる", () => {
    expect(picks("ops-kit/src/workflow-vars.test.ts", "ops-kit/public/.github/workflows/close-pull-requests.yml")).toHaveLength(1);
  });

  test("new-repo skill: スキルとテンプレートの変更で選ばれる", () => {
    expect(picks("scripts/new-repo-template.test.ts", ".claude/skills/new-repo/SKILL.md")).toHaveLength(1);
    expect(picks("scripts/new-repo-template.test.ts", "ops-kit/template/ops.config.json")).toHaveLength(1);
    expect(picks("scripts/new-repo-template.test.ts", "scripts/setup/lint_backlog.sh")).toHaveLength(1);
  });

  test("host: シェル・ユニット・読んでいる設計の文書の変更で選ばれる", () => {
    for (const f of ["aws/host/bootstrap.sh", "aws/host/switchboard.service", "docs/design/cloud-hosting.md"]) expect(picks("aws/host/host.test.ts", f)).toHaveLength(1);
  });
});

describe("このリポジトリの全テスト", () => {
  const root = join(import.meta.dir, "..");
  const ls = Bun.spawnSync(["git", "ls-files"], { cwd: root, stderr: "pipe" });
  const files = ls.stdout.toString().split("\n").filter(Boolean);
  const tests = files.filter((f) => /\.test\.tsx?$/.test(f) && existsSync(join(root, f))).map((path) => ({ path, src: readFileSync(join(root, path), "utf8") }));

  // Git の checkout でないツリー（ZIP）には一覧が無い
  test.skipIf(!ls.success)("パスを読むテストに宣言がある", () => {
    expect(tests.length).toBeGreaterThan(100);
    expect(findUndeclared(tests)).toEqual([]);
  });

  // 公開側の写しは外したファイルがあるので、宣言の先がそろうのは所有者のツリーだけ
  test.skipIf(!ls.success || !existsSync(join(root, "private")))("宣言の先がツリーにある", () => {
    expect(findStaleReads(tests, files)).toEqual([]);
  });
});

describe("selectFrom / formatSelection", () => {
  test("テストの宣言を読んで選ぶ", () => {
    const src: Record<string, string> = { "x.test.ts": "// test-reads: a.md\n", "y.test.ts": "" };
    expect(selectFrom(["a.md"], Object.keys(src), (p) => src[p]!).tests).toEqual(["x.test.ts"]);
  });

  test("読めないファイルがあれば全テストに倒す", () => {
    const files = ["bad.ts", "x.test.ts"];
    const s = selectFrom(["x.test.ts"], files, (p) => (p === "bad.ts" ? "import {" : ""));
    expect(s.full).toContain("依存を読めない: bad.ts");
    expect(s.tests).toEqual(["x.test.ts"]);
  });

  test.each([
    ["相対 import", { "x.ts": `import "./missing";`, "x.test.ts": "" }],
    ["workspace の入口", { "p/package.json": `{"name":"@s/p"}`, "p/index.ts": "", "x.ts": `import "@s/p";`, "x.test.ts": "" }],
  ])("解決できない %s は全テストに倒す", (_, src: Record<string, string>) => {
    expect(selectFrom(["x.test.ts"], Object.keys(src), (p) => src[p]!).full).toContain("x.ts:");
  });

  test("1 行目が件数か full で、続けてテストと理由", () => {
    expect(formatSelection({ tests: ["a.test.ts"], reasons: { "a.test.ts": "a.ts → a.test.ts" } })).toBe("selected: 1\na.test.ts  a.ts → a.test.ts");
    expect(formatSelection({ tests: ["a.test.ts"], reasons: { "a.test.ts": "全テスト" }, full: "bun.lock: 依存の定義や設定" })).toBe("full: bun.lock: 依存の定義や設定\na.test.ts  全テスト");
  });
});

describe("実行例（このリポジトリの実物）", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", "scripts/test-select.ts", ...args], { cwd: `${import.meta.dir}/..` }).stdout.toString();

  test("引数が無ければ stdin から読み、./ と空行を除く", () => {
    const p = Bun.spawnSync(["bun", "scripts/test-select.ts"], { cwd: `${import.meta.dir}/..`, stdin: new TextEncoder().encode("./scripts/ci.ts\n\n") });
    expect(p.stdout.toString().split("\n")[0]).toBe("full: scripts/ci.ts: CI の手順");
  });

  test("空の stdin は全テストに倒す", () => {
    const p = Bun.spawnSync(["bun", "scripts/test-select.ts"], { cwd: `${import.meta.dir}/..`, stdin: new TextEncoder().encode("\n") });
    expect(p.stdout.toString().split("\n")[0]).toBe("full: 変更の一覧が空");
  });

  test("CI の手順は全テストに倒す", () => {
    expect(run("scripts/ci.ts").split("\n")[0]).toBe("full: scripts/ci.ts: CI の手順");
  });

  test("シェルは宣言したテストを理由つきで選ぶ", () => {
    expect(run("aws/host/bootstrap.sh")).toContain("aws/host/host.test.ts  aws/host/bootstrap.sh ← aws/host/host.test.ts（test-reads）");
  });

  test("db.ts は依存するテストを選ぶ", () => {
    const out = run("packages/core/src/db.ts");
    expect(out.split("\n")[0]).toMatch(/^selected: \d+$/);
    expect(out).toContain("packages/core/src/db.test.ts  packages/core/src/db.ts → packages/core/src/db.test.ts");
  });
});
