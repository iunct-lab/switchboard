// test-reads: none
import { expect, test } from "bun:test";
import { checkConditions, combinations, primaryReviewer, renderConditions, unmarkedConditions } from "./conditions.ts";

const lines = (...l: string[]) => l.join("\n");

test("conditions: a matching block keeps its lines without the marks, any other block goes with its marks", () => {
  const text = lines("top", "<!-- when review=same -->", "same side", "<!-- end when -->", "<!-- when review=other -->", "other side", "<!-- end when -->", "bottom");
  expect(renderConditions(text, { review: "same" }, "f.md")).toBe(lines("top", "same side", "bottom"));
  expect(renderConditions(text, { review: "other" }, "f.md")).toBe(lines("top", "other side", "bottom"));
  // text without marks is returned as it is
  expect(renderConditions("a\n\n\nb\n", {}, "f.md")).toBe("a\n\n\nb\n");
});

test("conditions: several pairs in one mark are all required", () => {
  const text = lines("<!-- when review=other runner=claude -->", "ask codex", "<!-- end when -->", "end");
  expect(renderConditions(text, { review: "other", runner: "claude" }, "f.md")).toBe(lines("ask codex", "end"));
  expect(renderConditions(text, { review: "other", runner: "codex" }, "f.md")).toBe("end");
  expect(renderConditions(text, { review: "same", runner: "claude" }, "f.md")).toBe("end");
});

test("conditions: a frontmatter put whole inside a block is an error for the values that lose it", () => {
  const text = lines("<!-- when review=same -->", "---", "name: demo", "description: d", "---", "<!-- end when -->", "body");
  expect(renderConditions(text, { review: "other" }, "f.md")).toBe("body");
  expect(checkConditions(text, "f.md", ["name", "description"])).toEqual(["f.md: frontmatter が無い（review=other）"]);
  // a text with no frontmatter on any side (a process's text) has nothing to lose
  expect(checkConditions(lines("a", "<!-- when review=same -->", "b", "<!-- end when -->"), "f.md")).toEqual([]);
});

test("conditions: a removed block leaves one blank line, not two", () => {
  const text = lines("a", "", "<!-- when task=out -->", "outside", "<!-- end when -->", "", "b");
  expect(renderConditions(text, { task: "in" }, "f.md")).toBe(lines("a", "", "b"));
  expect(renderConditions(text, { task: "out" }, "f.md")).toBe(lines("a", "", "outside", "", "b"));
});

test("conditions: a description split inside the frontmatter renders one description per combination", () => {
  const text = lines("---", "name: demo", "<!-- when review=same -->", "description: same", "<!-- end when -->", "<!-- when review=other -->", "description: other", "<!-- end when -->", "---", "body");
  expect(renderConditions(text, { review: "same" }, "f.md")).toBe(lines("---", "name: demo", "description: same", "---", "body"));
  expect(checkConditions(text, "f.md", ["name", "description"])).toEqual([]);
  // one side missing: that combination has no description
  const broken = text.replace(lines("<!-- when review=other -->", "description: other", "<!-- end when -->", ""), "");
  expect(checkConditions(broken, "f.md", ["name", "description"])).toEqual(["f.md: frontmatter の description: が 0 行（review=other。条件ごとに 1 行）"]);
});

test("conditions: broken marks are refused with the file and the line", () => {
  const bad = (text: string, conds = {}) => {
    try {
      renderConditions(text, conds, "f.md");
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  expect(bad(lines("a", "<!-- when review=same -->", "b"), { review: "same" })).toBe("f.md:2: 閉じの無い印");
  expect(bad(lines("a", "<!-- end when -->"))).toBe("f.md:2: 開きの無い閉じの印");
  expect(bad(lines("<!-- when review=same -->", "<!-- when runner=claude -->", "<!-- end when -->", "<!-- end when -->"))).toStartWith("f.md:2: 入れ子の印");
  expect(bad("<!-- when colour=red -->\n<!-- end when -->")).toStartWith("f.md:1: 知らない条件: colour=red");
  expect(bad("<!-- when review=maybe -->\n<!-- end when -->")).toStartWith("f.md:1: 知らない値: review=maybe");
  expect(bad("text <!-- when review=same --> text")).toStartWith("f.md:1: 印の書式が違う");
  expect(bad("<!--when review=same-->")).toStartWith("f.md:1: 印の書式が違う");
  // the caller must give every condition its text uses
  expect(bad(lines("<!-- when runner=claude -->", "x", "<!-- end when -->"), { review: "same" })).toBe("f.md:1: 条件 runner の値が渡されていない");
  expect(checkConditions(lines("a", "<!-- when review=same -->"), "f.md")).toEqual(["f.md:2: 閉じの無い印"]);
});

test("conditions: combinations are every value of the keys a text uses", () => {
  const text = lines("<!-- when review=same -->", "x", "<!-- end when -->", "<!-- when task=in review=other -->", "y", "<!-- end when -->");
  expect(combinations(text)).toEqual([{ review: "same", task: "in" }, { review: "same", task: "out" }, { review: "other", task: "in" }, { review: "other", task: "out" }]);
  expect(combinations("no marks")).toEqual([{}]);
});

test("conditions: a conditional phrase outside a block is found, one inside is not", () => {
  const text = lines("アプリの Task の外では直接走らせる", "<!-- when task=out -->", "アプリの Task の外では直接走らせる", "<!-- end when -->", "<extra> を呼ぶ");
  expect(unmarkedConditions(text, "f.md").map((h) => [h.key, h.line])).toEqual([["task", 1], ["extra", 5]]);
});

test("conditions: the main reviewer follows from the Task's runner and the review setting", () => {
  expect(primaryReviewer("claude", "other")).toBe("codex");
  expect(primaryReviewer("codex", "other")).toBe("claude");
  expect(primaryReviewer("claude", "same")).toBe("claude");
  expect(primaryReviewer("codex", "same")).toBe("codex");
  expect(primaryReviewer("adk", "other")).toBeNull();
});
