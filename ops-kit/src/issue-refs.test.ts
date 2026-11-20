// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIssueRefs, publicFiles } from "./issue-refs.ts";

const lines = (path: string, text: string) => findIssueRefs(path, text).map((r) => `${r.kind}:${r.line}`);

describe("findIssueRefs: picks up", () => {
  test("a // comment, full-width parens included", () => {
    expect(lines("a.ts", "// why (#12)\nconst x = 1;\n// 理由（#123）")).toEqual(["comment:1", "comment:3"]);
  });
  test("a trailing // comment, not the string before it", () => {
    expect(lines("a.ts", 'const a = "x // #1"; // see #2\nconst b = "#3"; // none')).toEqual(["comment:1"]);
  });
  test("a multi-line /* */ comment and JSX {/* */}", () => {
    expect(lines("a.tsx", "/**\n * about #5\n */\nconst x = <a>{/* #6 */}</a>;")).toEqual(["comment:2", "comment:4"]);
  });
  test("a comment after a regular expression or a template that is divided, and after a line-leading division", () => {
    const src = ["const n = /x/ / 2; // see #12", "const m = `${8}` / 2; // see #13", "const k = 8 /* a", "   b */ / 2; // see #14"].join("\n");
    expect(lines("a.ts", src)).toEqual(["comment:1", "comment:2", "comment:4"]);
  });
  test("a comment after a regular expression at the start of a line after `if (…)`, and inside a template's `${`", () => {
    const src = ["if (ok)", "  /^'/.test(s) && f(); // see #12", "const s = `${/'/.test(x)}`; // see #13"].join("\n");
    expect(lines("a.ts", src)).toEqual(["comment:2", "comment:3"]);
  });
  test("SQL -- in a .ts", () => {
    expect(lines("db.ts", "const q = `\n-- added by #7\nselect 1`;")).toEqual(["comment:2"]);
  });
  test("a # comment in YAML and shell, not the shebang", () => {
    expect(lines("a.yml", "a: 1 # per #8")).toEqual(["comment:1"]);
    expect(lines("a.sh", "#!/bin/sh\n# for #9\necho ok")).toEqual(["comment:2"]);
  });
  test("an HTML <!-- --> comment", () => {
    expect(lines("a.html", "<p>x</p> <!-- #10 -->")).toEqual(["comment:1"]);
  });
  test("a test name", () => {
    expect(findIssueRefs("a.test.ts", 'test("does it (#12)", () => {});\nit.skip(`x #13`, f);')).toEqual([
      { line: 1, text: 'test("does it (#12)", () => {});', kind: "test-title" },
      { line: 2, text: "it.skip(`x #13`, f);", kind: "test-title" },
    ]);
  });
  test("a test name on the line after the call, after a blank line, and after a comment", () => {
    expect(lines("a.test.ts", 'test(\n  "works (#12)",\n  () => {},\n);\ntest(\n\n  "b #2", f);\ntest(/* c */ "c #3", f);')).toEqual(["test-title:2", "test-title:7", "test-title:8"]);
  });
  test("a test name passed to the call after a modifier", () => {
    const src = [
      'test.skipIf(x)("a (#1)", f);',
      'test.if(!y(z))("b #2", f);',
      "describe.skipIf(x)(`c #3`, f);",
      'test.each([[1, ")"]])("d %s #4", f);',
      "test.each([",
      "  [1],",
      '])("e #5", f);',
    ].join("\n");
    expect(lines("a.test.ts", src)).toEqual(["test-title:1", "test-title:2", "test-title:3", "test-title:4", "test-title:7"]);
  });
  test("a test call past a regular expression or a comment that holds a quote or a parenthesis", () => {
    const src = [
      "const re = /'/; test(",
      '  "a #1", f);',
      'test.skipIf(/\\)/.test(x))("b #2", f);',
      "test.each([",
      "  [1], // don't (",
      '])("c #3", f);',
    ].join("\n");
    expect(lines("a.test.ts", src)).toEqual(["test-title:2", "test-title:3", "test-title:6"]);
  });
  test("a test after a line-leading division, and a modifier whose condition holds a comment with no space before it", () => {
    const src = ["const n = 8", '/ 2; test("a #1", f);', "test.skipIf(x// )", ')("b #2", f);'].join("\n");
    expect(lines("a.test.ts", src)).toEqual(["test-title:2", "test-title:4"]);
  });
  test("a modifier whose condition starts with a string or a block comment, and a test after a line that only looks like SQL", () => {
    const src = [
      'test.skipIf("ci" === mode)("a #1", f);',
      'test.skipIf(/* gate */ /\\)/.test(x))("b #2", f);',
      '-- i; test("c #3", f);',
      "const q = `select 1",
      "-- note`;",
      'test("d #4", f);',
    ].join("\n");
    expect(lines("a.test.ts", src)).toEqual(["test-title:1", "test-title:2", "test-title:3", "test-title:6"]);
  });
});

describe("findIssueRefs: leaves alone", () => {
  test("a name without a number after a modifier, and a chained call that is not a name", () => {
    const src = [
      'test.skipIf(x)("a", f);',
      'test.if(!y(z))("b", f);',
      "describe.skipIf(x)(`c`, f);",
      'test.each([[1, ")"]])("d %s", f);',
      "test.each([",
      "  [1],",
      '])("e", f);',
      "test.each(rows).map((r) => r);",
      'test.each(rows).map("label #12");',
      'test.skipIf("#12" === mode)(name, f);',
    ].join("\n");
    expect(lines("a.test.ts", src)).toEqual([]);
  });
  test("a test call written inside a template literal that spans lines", () => {
    const src = ["const fixture = `import { test } from 'bun:test';", 'test.skipIf(a)("x #1", f);', 'test("y #2", f);`;'].join("\n");
    expect(lines("a.test.ts", src)).toEqual([]);
  });
  test("a string, a color, a URL fragment, an entity, a repo reference", () => {
    const src = 'const a = "#12";\nconst c = "#fff", d = "#0006";\nconst u = "https://x/#1"; const e = "&#123;";\nconst r = "owner/name#12";';
    expect(lines("a.ts", src)).toEqual([]);
  });
  test("a JSX closing tag is not a regular expression", () => {
    expect(lines("a.tsx", "const a = <p>x</p>; {/* why #12 */}\nconst b = <b>it</b>; // #5")).toEqual(["comment:1", "comment:2"]);
  });
  test("a quote or a backtick inside a regular expression does not open a string", () => {
    expect(lines("a.ts", "const R = /[;|&`(){}]/;\n// after (#1)\nconst q = s.split(/['\"]/); // why #2\nconst d = a / b; // #3")).toEqual(["comment:2", "comment:3", "comment:4"]);
  });
  test("a template inside a template's ${} closes where it ends", () => {
    expect(lines("a.ts", "const t = `a ${xs.map((p) => `\\`${p}\\``).join(\"、\")} b // #1`;\n// after (#2)")).toEqual(["comment:2"]);
  });
  test("a // inside a string or after https:", () => {
    expect(lines("a.ts", 'const u = "a // #1";\nfetch("https://x.test/#1");\nconst t = `\nx // #4\n`;')).toEqual([]);
  });
  test("a # in CSS, a number longer than 5 digits, and a non-test string", () => {
    expect(lines("a.css", "a { color: #123; } /* #fff */")).toEqual([]);
    expect(lines("a.ts", "// #123456")).toEqual([]);
    expect(lines("a.ts", 'run("test #12");\nconst re = /x/.test("#12");')).toEqual([]);
    expect(lines("a.test.ts", 'expect(f("#12")).toBe(1);')).toEqual([]);
  });
  test("a # inside quotes in YAML and shell", () => {
    expect(lines("a.sh", 'echo "see # #12"\necho \'x # #13\' # ok')).toEqual([]);
    expect(lines("a.yml", 'value: "see # #12"')).toEqual([]);
  });
  test("an example in a comment's inline code", () => {
    expect(lines("a.ts", "// the line `**前提**: #12, #34` names two\n/** e.g. ``#1 の後`` */")).toEqual([]);
  });
  test("a test call written inside a string", () => {
    expect(lines("a.test.ts", 'const fixture = `test("data #12", f)`;\nconst g = \'it("x #3")\';')).toEqual([]);
  });
  test("a file type without comments", () => {
    expect(lines("a.json", '{"a": "# #12"}')).toEqual([]);
  });
});

describe("publicFiles", () => {
  test("include and exclude by entry, Markdown and binary files dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-refs-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
    git("init", "-q");
    mkdirSync(`${dir}/src`);
    mkdirSync(`${dir}/skip`);
    for (const [f, c] of [["src/a.ts", "x"], ["src/b.md", "x"], ["src/c.png", "\0"], ["skip/d.ts", "x"], ["e.ts", "x"]] as const) writeFileSync(`${dir}/${f}`, c);
    git("add", "-A");
    expect(publicFiles(["src/", "skip/"], ["skip/"], dir)).toEqual(["src/a.ts"]);
    expect(publicFiles(undefined, [], dir).sort()).toEqual(["e.ts", "skip/d.ts", "src/a.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
