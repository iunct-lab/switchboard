import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_DEPTH, parseInline, parseMarkdown, safeHref, type MdBlock } from "./markdown.ts";
import { Markdown } from "./components/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const txt = (text: string) => ({ t: "text", text });
const para = (text: string): MdBlock => ({ t: "paragraph", inline: [txt(text)] });

describe("parseMarkdown", () => {
  test("headings", () => {
    expect(parseMarkdown("# One\n## Two ##\n###### Six\n####### seven")).toEqual([
      { t: "heading", level: 1, inline: [txt("One")] },
      { t: "heading", level: 2, inline: [txt("Two")] },
      { t: "heading", level: 6, inline: [txt("Six")] },
      para("####### seven"),
    ]);
    expect(parseMarkdown("#nospace")).toEqual([para("#nospace")]);
    expect(html("### 段の表")).toBe('<div class="md"><h3>段の表</h3></div>');
  });

  test("paragraphs split on blank lines and keep line breaks", () => {
    expect(parseMarkdown("a\nb\n\nc")).toEqual([
      { t: "paragraph", inline: [txt("a"), { t: "br" }, txt("b")] },
      para("c"),
    ]);
  });

  test("nested and ordered lists", () => {
    const blocks = parseMarkdown("- a\n- b\n  - b1\n  - b2\n- c\n\n3. x\n4. y");
    expect(blocks).toEqual([
      {
        t: "list", ordered: false, start: 1, items: [
          [para("a")],
          [para("b"), { t: "list", ordered: false, start: 1, items: [[para("b1")], [para("b2")]] }],
          [para("c")],
        ],
      },
      { t: "list", ordered: true, start: 3, items: [[para("x")], [para("y")]] },
    ]);
    expect(html("1. a\n   1. a1\n2. b")).toBe('<div class="md"><ol><li>a<ol><li>a1</li></ol></li><li>b</li></ol></div>');
    expect(html("3. x")).toBe('<div class="md"><ol start="3"><li>x</li></ol></div>');
  });

  test("a number other than 1. does not cut a paragraph", () => {
    expect(parseMarkdown("結果は次のとおり:\n2026. 年の分")).toEqual([{ t: "paragraph", inline: [txt("結果は次のとおり:"), { t: "br" }, txt("2026. 年の分")] }]);
    expect(parseMarkdown("手順:\n1. a")).toEqual([para("手順:"), { t: "list", ordered: true, start: 1, items: [[para("a")]] }]);
  });

  test("a list right after a paragraph line starts a list", () => {
    expect(parseMarkdown("手順:\n- a\n- b")).toEqual([
      para("手順:"),
      { t: "list", ordered: false, start: 1, items: [[para("a")], [para("b")]] },
    ]);
  });

  test("tables with alignment", () => {
    const blocks = parseMarkdown("| 段 | 時間 | 備考 |\n|:---|---:|:-:|\n| a | 1 | `x\\|y` |\n| b |");
    expect(blocks).toEqual([{
      t: "table",
      align: ["left", "right", "center"],
      head: [[txt("段")], [txt("時間")], [txt("備考")]],
      rows: [
        [[txt("a")], [txt("1")], [{ t: "code", text: "x|y" }]],
        [[txt("b")], [], []],
      ],
    }]);
    // Every column's cells parse links (the first one too).
    expect(parseMarkdown("| [a](https://a.test) | [b](https://b.test) |\n|---|---|")).toEqual([{
      t: "table", align: [null, null], rows: [],
      head: [[{ t: "link", url: "https://a.test", children: [txt("a")] }], [{ t: "link", url: "https://b.test", children: [txt("b")] }]],
    }]);
    const out = html("a | b\n--|--\n1 | 2");
    expect(out).toContain("<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
    expect(html("| a |\n|:-:|\n| 1 |")).toContain('<th style="text-align:center">a</th>');
  });

  test("a pipe line over a rule without a pipe is a paragraph and a rule", () => {
    expect(parseMarkdown("Note: x |\n---")).toEqual([para("Note: x |"), { t: "hr" }]);
  });

  test("a pipe line without a delimiter row is a paragraph", () => {
    expect(parseMarkdown("a | b\nc | d")).toEqual([{ t: "paragraph", inline: [txt("a | b"), { t: "br" }, txt("c | d")] }]);
  });

  test("fenced code keeps its text", () => {
    const src = "```ts\nconst a = 1;\n\n  **not bold** <b>\n```\nafter";
    expect(parseMarkdown(src)).toEqual([
      { t: "code", lang: "ts", text: "const a = 1;\n\n  **not bold** <b>" },
      para("after"),
    ]);
    // Tabs inside a fence are the code's own (a Makefile recipe), not indentation to expand.
    expect(parseMarkdown("```make\nall:\n\tcc -o a a.c\n```")).toEqual([{ t: "code", lang: "make", text: "all:\n\tcc -o a a.c" }]);
    // ``` with a backtick after it on the same line is inline code, not a fence: nothing after it is swallowed.
    expect(parseMarkdown("```npm test``` を回した\n\n## 結果")).toEqual([
      { t: "paragraph", inline: [{ t: "code", text: "npm test" }, txt(" を回した")] },
      { t: "heading", level: 2, inline: [txt("結果")] },
    ]);
    expect(parseMarkdown("~~~\nopen to the end")).toEqual([{ t: "code", lang: "", text: "open to the end" }]);
    expect(html("```\n<i>x</i>\n```")).toBe('<div class="md"><pre><code>&lt;i&gt;x&lt;/i&gt;</code></pre></div>');
  });

  test("quote and hr", () => {
    expect(parseMarkdown("> q1\n> - li\n\n---\n***")).toEqual([
      { t: "quote", blocks: [para("q1"), { t: "list", ordered: false, start: 1, items: [[para("li")]] }] },
      { t: "hr" },
      { t: "hr" },
    ]);
    expect(html("> q\n\n___")).toBe('<div class="md"><blockquote><p>q</p></blockquote><hr/></div>');
  });
});

describe("parseInline", () => {
  test("inline code, strong, em, links", () => {
    expect(parseInline("a `b **c**` d")).toEqual([txt("a "), { t: "code", text: "b **c**" }, txt(" d")]);
    expect(parseInline("``a ` b``")).toEqual([{ t: "code", text: "a ` b" }]);
    expect(parseInline("**強い** と *斜め* と _下線_")).toEqual([
      { t: "strong", children: [txt("強い")] }, txt(" と "),
      { t: "em", children: [txt("斜め")] }, txt(" と "),
      { t: "em", children: [txt("下線")] },
    ]);
    expect(parseInline("***both***")).toEqual([{ t: "strong", children: [{ t: "em", children: [txt("both")] }] }]);
    expect(parseInline("snake_case_name and 2 * 3 * 4")).toEqual([txt("snake_case_name and 2 * 3 * 4")]);
    expect(parseInline("[the **doc**](https://example.com/a_(b)) <https://x.test/y>")).toEqual([
      { t: "link", url: "https://example.com/a_(b)", children: [txt("the "), { t: "strong", children: [txt("doc")] }] },
      txt(" "),
      { t: "link", url: "https://x.test/y", children: [txt("https://x.test/y")] },
    ]);
    // A bare URL is not a link (only [text](url) and <url> are): text around it, Japanese too, stays text.
    expect(parseInline("see https://x.test/p, then")).toEqual([txt("see https://x.test/p, then")]);
    expect(parseInline("PR（https://x.test/pull/1）を見て")).toEqual([txt("PR（https://x.test/pull/1）を見て")]);
    // Delimiters inside a code span belong to the code.
    expect(parseInline("**a `**` b**")).toEqual([{ t: "strong", children: [txt("a "), { t: "code", text: "**" }, txt(" b")] }]);
    expect(parseInline("[a `]` b](https://x.test)")).toEqual([{ t: "link", url: "https://x.test", children: [txt("a "), { t: "code", text: "]" }, txt(" b")] }]);
    // An escaped backtick is a literal one and does not open a span.
    expect(parseInline("\\`literal **bold** `code`")).toEqual([txt("`literal "), { t: "strong", children: [txt("bold")] }, txt(" "), { t: "code", text: "code" }]);
    // A link's text holds no link of its own (no anchor inside an anchor).
    expect(parseInline("[https://old.test](https://new.test)")).toEqual([{ t: "link", url: "https://new.test", children: [txt("https://old.test")] }]);
    expect(parseInline("[see <https://a.test> and [b](https://b.test)](https://c.test)")).toEqual([
      { t: "link", url: "https://c.test", children: [txt("see <https://a.test> and [b](https://b.test)")] },
    ]);
    expect(parseInline("\\*not em\\* and **open")).toEqual([txt("*not em* and **open")]);
    expect(html("[a](https://x.test)")).toBe('<div class="md"><p><a href="https://x.test" target="_blank" rel="noopener noreferrer">a</a></p></div>');
  });
});

describe("safety", () => {
  test("raw html stays text", () => {
    const src = "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>";
    expect(parseMarkdown(src)).toEqual([para("<script>alert(1)</script>"), para("<img src=x onerror=alert(1)>")]);
    const out = html(src + "\n\n| <b>x</b> |\n|---|\n| <i>y</i> |");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("unsafe links are not links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JavaScript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("https://x.test/a")).toBe("https://x.test/a");
    expect(safeHref("HTTP://x.test")).toBe("HTTP://x.test");
    expect(safeHref("mailto:dev@example.com")).toBe("mailto:dev@example.com");
    // Only http(s) and mailto: a relative path or #… would resolve against the Web UI's own page, a page that is not there.
    expect(safeHref("#section")).toBeNull();
    expect(safeHref("docs/design/a.md")).toBeNull();
    expect(safeHref("db.ts:12")).toBeNull();
    // The image syntax is a link to the image (alt as the text), never an image.
    expect(parseInline("![shot](https://x.test/a.png) ![](https://x.test/b.png)")).toEqual([
      { t: "link", url: "https://x.test/a.png", children: [txt("shot")] },
      txt(" "),
      { t: "link", url: "https://x.test/b.png", children: [txt("https://x.test/b.png")] },
    ]);
    const out = html("[x](javascript:alert(1)) ![i](https://x.test/a.png)");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<img");
    expect(out).toBe('<div class="md"><p><span>x</span> <a href="https://x.test/a.png" target="_blank" rel="noopener noreferrer">i</a></p></div>');
  });
});

test("unmatched delimiters stay linear on a long reply", () => {
  const started = performance.now();
  for (const s of ["*a ", "_a ", "[a ", "`a ", "`a ``", "[a](("]) parseMarkdown(s.repeat(30000));
  expect(performance.now() - started).toBeLessThan(1000);
});

test("deep nesting stops at a cap instead of running out of stack", () => {
  // a reply that echoes a generated file can nest lists or quotes thousands deep; past the cap the rest is a paragraph
  for (const src of ["- ".repeat(20000) + "x", "> ".repeat(20000) + "x"]) {
    const blocks = parseMarkdown(src);
    let depth = 0;
    for (let b: MdBlock | undefined = blocks[0]; b && (b.t === "list" || b.t === "quote"); depth++) b = b.t === "list" ? b.items[0]![0] : b.blocks[0];
    expect(depth).toBe(MAX_DEPTH);
  }
});
