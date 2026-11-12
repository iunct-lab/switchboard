// test-reads: scripts/public-docs.ts ops.config.json docs/ aws/README.md SECURITY.md
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "public-docs.ts");
const dir = mkdtempSync(join(tmpdir(), "public-docs."));

function run(...args: string[]) {
  const r = Bun.spawnSync(["bun", script, ...args], { cwd: dir, env: { ...process.env, SWITCHBOARD_SUPERVISED: "" } });
  return { code: r.exitCode, out: r.stdout.toString() };
}
function doc(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("public-docs check", () => {
  test("Japanese in code, mock-ups and styles and colour codes are not counted", () => {
    const p = doc("clean.md", [
      "Plain English.",
      "Use `日本語のコマンド` here.",
      "```",
      "日本語のコードブロック",
      "```",
      '<style>a { color: #232930; } /* 色 */</style>',
      '<div class="mock"><div>画面の文言 #45</div><p>入れ子</p></div>',
      "<code>日本語</code> <pre>日本語</pre>",
      "After the mock.",
    ].join("\n"));
    const r = run("check", p);
    expect(r.out).toContain("clean.md ja=0 refs=0");
    expect(r.code).toBe(0);
  });

  test("prose Japanese and #123 / (#1431) are counted with line numbers; &#123; and a/#12 are not", () => {
    const p = doc("dirty.md", [
      "English line.",
      "これは日本語です。",
      "See #123 and (#1431).",
      "Entity &#123; and path a/#12 are fine.",
      '<div class="mock">x</div> after: #77',
    ].join("\n"));
    const r = run("check", p);
    expect(r.out).toContain("dirty.md ja=9 refs=3");
    expect(r.out).toContain("ja lines: 2");
    expect(r.out).toContain("refs lines: 3, 5");
    expect(r.code).toBe(1);
  });

  test("text after a nested mock element is read again as prose", () => {
    const p = doc("after.html", '<div class="mock"><div>中</div></div><p>後の日本語</p>');
    expect(run("check", p).out).toContain("ja=5 refs=0");
  });

  test("a backtick-quoted `<pre>` is not an element: the prose after it is still read", () => {
    const p = doc("quoted-pre.md", "Wrap it in `<pre>` first.\n\nこの後は地の文。\n");
    expect(run("check", p).out).toContain("ja=8 refs=0");
  });

  test("an unclosed backtick ends at the blank line and does not turn the next paragraphs into code", () => {
    const p = doc("odd-ticks.md", "Chars `; | & < > $ \\` here.\n\n日本語。\n\nThen `code` and 地の文。\n");
    expect(run("check", p).out).toContain("ja=8 refs=0");
  });

  test("only the class token `mock` is left out, not `mock-title`", () => {
    const p = doc("mock-title.html", '<div class="mock-title">日本語 #123</div><div class="a mock">画面 #45</div>');
    expect(run("check", p).out).toContain("ja=3 refs=1");
  });
});

describe("public-docs check from elsewhere", () => {
  test("a stray <pre> in prose blanks only its tag: the prose after it is still read", () => {
    const p = doc("stray-pre.md", "Write <pre> in HTML.\n\nこれは地の文。\n");
    expect(run("check", p).out).toContain("ja=7 refs=0");
  });

  test("the default targets are read from the repository root even from a subdirectory", () => {
    const r = Bun.spawnSync(["bun", script, "check"], { cwd: join(import.meta.dir, "..", "docs") });
    expect(r.stdout.toString()).toContain("docs/merge-gate.md ja=");
  });

  test("outside a repository there is nothing to check: exit 2, not a pass", () => {
    const outside = mkdtempSync(join(tmpdir(), "public-docs-none."));
    expect(Bun.spawnSync(["bun", script, "check"], { cwd: outside, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } }).exitCode).toBe(2);
  });
});

describe("public-docs list", () => {
  test("the default targets are the public docs: publicSync.exclude is left out, docs/merge-gate.md is in", () => {
    const r = Bun.spawnSync(["bun", script, "list"], { cwd: join(import.meta.dir, "..") });
    const list = r.stdout.toString().trim().split("\n");
    expect(list).toContain("docs/merge-gate.md");
    expect(list).toContain("SECURITY.md");
    expect(list).toContain("aws/README.md");
    expect(list).not.toContain("docs/design/backlog.md");
    expect(list).not.toContain("README.md");
    expect(list.every((p) => p === "SECURITY.md" || p === "aws/README.md" || /^docs\/.*\.(md|html)$/.test(p))).toBe(true);
  });
});

describe("public-docs compare", () => {
  function inRepo(before: string, after: string) {
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "t.md"), before);
    git("add", "t.md");
    git("commit", "-q", "-m", "before");
    writeFileSync(join(dir, "t.md"), after);
    return run("compare", "HEAD", "t.md");
  }

  test("code that vanished exits 1; a changed number is only listed", () => {
    const r = inRepo("Run `bun test` for 3 files.\n", "Run it for 4 files.\n");
    expect(r.out).toContain("- code: bun test");
    expect(r.out).toContain("± number: 3");
    expect(r.out).toContain("± number: 4");
    expect(r.code).toBe(1);
  });

  test("a backtick inside a real <pre> stays part of its code", () => {
    const r = inRepo("<pre>echo `date`</pre>\n", "<pre>echo</pre> and `date`\n");
    expect(r.out).toContain("- code: echo `date`");
    expect(r.code).toBe(1);
  });

  test("a rev that cannot be read exits 2 instead of passing", () => {
    inRepo("Same.\n", "Same.\n");
    expect(run("compare", "no-such-rev", "t.md").code).toBe(2);
  });

  test("added code alone exits 0", () => {
    const r = inRepo("Open the screen.\n", "Open the `Settings` screen.\n");
    expect(r.out).not.toContain("- code:");
    expect(r.code).toBe(0);
  });
});
