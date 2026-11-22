// test-reads: none
import { describe, expect, test } from "bun:test";
import { pathsIn, scopeIn } from "./task-paths";

const top = [
  { name: "packages", dir: true }, { name: "apps", dir: true }, { name: "aws", dir: true }, { name: "docs", dir: true },
  { name: "package.json", dir: false }, { name: "README.md", dir: false },
];

describe("task-paths pathsIn", () => {
  test("reads paths under the root's directories and the root's files; drops the line number and a trailing period", () => {
    const body = "触る: `packages/core/src/db.ts:120`、apps/web/src/App.tsx。docs/design/ 以下、aws/template.yaml、`package.json`、README.md";
    expect(pathsIn(body, top)).toEqual([
      "packages/core/src/db.ts", "apps/web/src/App.tsx", "docs/design/", "aws/template.yaml", "package.json", "README.md",
    ]);
  });

  test("a root file name inside another path or word is not the root file", () => {
    expect(pathsIn("docs/README.md と apps/web/package.json、mypackage.json、package.json5", top)).toEqual(["docs/README.md", "apps/web/package.json"]);
  });
});

describe("task-paths pathsIn: a name without a directory", () => {
  test("a root file named in the middle of a step is a reference, not a touched file", () => {
    expect(pathsIn("1. 昇格は README.md の規則に従う。`package.json` も読む\n- 手順の途中の `new-config.json` も参照", top)).toEqual([]);
  });

  test("the same name at the head of a step, or on a line starting with 触る, is touched", () => {
    expect(pathsIn("1. README.md: 追記する\n- `new-config.json` — 足す\n2. 説明の中の package.json は参照", top)).toEqual(["README.md", "new-config.json"]);
    expect(pathsIn("- 触るファイル: package.json", top)).toEqual(["package.json"]);
    expect(pathsIn("1. `README.md`・`package.json`: 直す\n2. README.md と package.json: 直す", top)).toEqual(["README.md", "package.json"]);
    expect(pathsIn("1. `scripts/a.ts` を直す。読み方は README.md と `new-config.json` の手順: 根拠は下", top)).toEqual(["scripts/a.ts"]);
    expect(pathsIn("1. `new-config.json`（新規）: 足す\n2. `other.json:3`: 足す\n3. `x.ts` の /ws ルート: 直す", top)).toEqual(["new-config.json", "other.json", "x.ts"]);
  });

  test("a path from a root directory counts anywhere in a sentence", () => {
    expect(pathsIn("昇格は docs/design/x.md の規則で、`apps/web/a.ts` も読む", top)).toEqual(["docs/design/x.md", "apps/web/a.ts"]);
  });
});

describe("task-paths pathsIn: globs and commands are not touched paths", () => {
  test("a glob is not a path, nor the directory before its wildcard", () => {
    expect(pathsIn("`grep -n x docs/design/*.md` と packages/core/src/*.test.ts、apps/web/src/{a,b}.ts、docs/a?.md", top)).toEqual([]);
    expect(pathsIn("docs/design/x.md と packages/core/src/ 以下", top)).toEqual(["docs/design/x.md", "packages/core/src/"]);
  });

  test("a backticked span with a space is a command: what it names is checked, not touched", () => {
    const body = "1. `scripts/a.ts` `resolveTarget`: 直す\n確認: `bun test scripts/a.test.ts packages/core/src/b.test.ts` と `bun scripts/public-docs.ts check docs/x.md` が通る";
    expect(pathsIn(body, top)).toEqual(["scripts/a.ts"]);
    expect(scopeIn(body, top)).toEqual(["packages/core/src/b.test.ts", "docs/x.md", "scripts/a.ts"]); // merge-gate keeps them
  });

  test("a glob whose wildcard follows a word is not a path either; merge-gate's scope keeps the directory before a wildcard", () => {
    expect(pathsIn("docs/design/foo-*.md と packages/adapters/claude-*/src", top)).toEqual([]);
    expect(scopeIn("`packages/core/src/*.test.ts`", top)).toEqual(["packages/core/src/"]);
  });

  test("a span with a space that starts with a path is not a command", () => {
    expect(pathsIn("触る: `docs/a.md の節`、`./x.sh --y` と `bun x docs/b.md`", top)).toEqual(["docs/a.md"]);
    expect(pathsIn("`FOO=1 bun test docs/c.md` と `A=1 B=2 bun x docs/d.md`", top)).toEqual([]);
  });
});

test("scopeIn: a top directory alone in backticks counts for merge-gate, pathsIn and a glob do not make it one", () => {
  const body = "`docs/` と packages/core/ を触る。`scripts/*.ts`、`apps/<name>/x`、`docs/… の下`、`packages/{a,b}.ts`、`nothere/`";
  expect(pathsIn("`docs/` だけ", top)).toEqual([]);
  expect(scopeIn(body, top)).toEqual(["packages/core/", "docs/"]);
  expect(scopeIn("`apps/` は触らない文でも名指し。`docs/a.md`", top)).toEqual(["docs/a.md", "apps/"]);
});

test("task-paths pathsIn: a backticked path counts even when no branch has it yet", () => {
  expect(pathsIn("触る: `new-config.json:10-20`、`tools/gen.ts:3`、`gh stack add`、`readOthers`、`Bun.serve`、`.env`、`turn/completed`、`origin/main`、`@scope/protocol`", top)).toEqual(["tools/gen.ts", "new-config.json"]);
});

describe("task-paths pathsIn: a place that only names a file as a reference", () => {
  test("a path in the done criteria is not touched", () => {
    const body = [
      "## やること", "1. `packages/core/src/server/merge-consent.ts`: 足す",
      "## 手順", "1. `apps/web/src/a.ts`: 直す",
      "## 検証", "- 既存の `packages/core/src/asks-answer.test.ts`・`packages/core/src/asks.test.ts`・`packages/core/src/asks.api.test.ts` が pass",
      "## 完了条件 (DoD)", "- [ ] `docs/design/x.md` を直した",
      "### 完了条件 (DoD)", "- [ ] `aws/template.yaml` を直した",
    ].join("\n");
    expect(pathsIn(body, top)).toEqual(["packages/core/src/server/merge-consent.ts", "apps/web/src/a.ts"]);
    expect(scopeIn(body, top)).toContain("packages/core/src/asks-answer.test.ts");
  });

  test("a skipped section ends at the next heading, not at a deeper heading, an issue number or a code comment", () => {
    const body = [
      "## 検証", "#### 昇格の後", "- `packages/core/src/asks.test.ts` が pass",
      "#5814 の行", "```sh", "# run", "bun test packages/core/src/flow.test.ts", "```", "- `docs/design/x.md` を読む",
      "## 手順", "1. `apps/web/src/a.ts`: 直す",
    ].join("\n");
    expect(pathsIn(body, top)).toEqual(["apps/web/src/a.ts"]);
    const step = ["## 手順", "1. `apps/web/src/b.ts`: 直す"];
    expect(pathsIn(["## 検証", "```bun test packages/core/src/a.test.ts```", ...step].join("\n"), top)).toEqual(["apps/web/src/b.ts"]);
    expect(pathsIn(["## 検証", "```", "~~~", "```", ...step].join("\n"), top)).toEqual(["apps/web/src/b.ts"]);
  });

  test("a path named as a model in the design check is a reference", () => {
    const body = [
      "## やること",
      "設計チェック: 週報が API を読む口は Task に渡る `BACKLOG_URL` の origin と `BACKLOG_TOKEN_FILE`（`aws/promote.ts` と同じ）にし、新しい口を作らない。`docs/design/evals.md` に条件を足すだけ",
      "## 手順",
      "1. `apps/web/a.ts`: 直す（`packages/core/b.ts` を参照）。`docs/c.md`（`aws/d.ts` のとおり）も読む。`docs/e.md`(`aws/f.ts` と同じ)",
    ].join("\n");
    expect(pathsIn(body, top)).toEqual(["apps/web/a.ts", "docs/c.md", "docs/e.md"]);
    expect(scopeIn(body, top)).toEqual(expect.arrayContaining(["aws/promote.ts", "docs/design/evals.md", "packages/core/b.ts", "aws/d.ts", "aws/f.ts"]));
  });

  test("a path in the old-assumption list is not touched, and stays in the merge gate's scope", () => {
    const body = [
      "古い前提を持つ既存の箇所（`ops-kit old-paths list HEAD \"c.createdAt\"` の項目。PR で 1 行ずつ確かめる）:",
      "- `packages/core/src/backlog-waits.ts:34`（`waitsOf` の `at`）、`packages/core/src/flow.ts:53`",
      "- `apps/web/src/changes.ts:26`、`apps/web/src/components/Backlog.tsx:430`（画面に出る時刻）",
      "",
      "## 手順",
      "1. `packages/core/src/flow.ts`: 直す",
      "2. `docs/design/backlog.md` の節に書く",
    ].join("\n");
    expect(pathsIn(body, top)).toEqual(["packages/core/src/flow.ts", "docs/design/backlog.md"]);
    expect(scopeIn(body, top)).toEqual(expect.arrayContaining(["packages/core/src/backlog-waits.ts", "apps/web/src/changes.ts", "apps/web/src/components/Backlog.tsx", "packages/core/src/flow.ts"]));
  });
});
