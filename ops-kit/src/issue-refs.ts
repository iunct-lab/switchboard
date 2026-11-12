import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { underEntry } from "./public-sync.ts";

export type IssueRef = { line: number; text: string; kind: "comment" | "test-title" };

/** `#12` as a reference: not `#fff`, not `https://x/#1`, not `&#123;`, not `owner/name#12`. */
const NUMBER = /(^|[^A-Za-z0-9&/#])#[0-9]{1,5}\b/;
/** An inline code span in a comment: a number in it is an example of a format (`#12, #34`), not a reference. */
const CODE_SPAN = /(`+)[^`]*?\1/g;
const SLASH = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".html"]);
const HASH = new Set([".sh", ".yml", ".yaml", ".toml", ".service", ".py", ""]);
const TEST_FILE = /\.test\.ts$|^scripts\/[^/]*-e2e\.ts$/;
const TEST_CALL = /(?<![\w.$])(?:test|it|describe)(?:\.\w+)?\(\s*(["'`])/g;
/** A test call whose name starts on the next line: `test(` ending the line. */
const TEST_OPEN = /(?<![\w.$])(?:test|it|describe)(?:\.\w+)?\(\s*$/;

/** The end of the string that starts at `from` (just past the opening quote) on this line, or -1. */
function stringEnd(s: string, from: number, quote: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === quote) return i;
  }
  return -1;
}

/** What comes before a `/` that opens a regular expression rather than dividing: nothing, an operator or bracket, or `return`-like words. Not `<`: `</p>` closes a JSX tag. */
const REGEX_BEFORE = /(^|[=(,:;!&|?{}[+\-*%>~^]|\b(?:return|typeof|case|in|of|void|delete|throw|new|yield|await))\s*$/;

/** Just past the end of the regular expression whose body starts at `from`: escapes and `[...]` classes may hold a `/`. */
function regexEnd(s: string, from: number): number {
  let cls = false;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "[") cls = true;
    else if (s[i] === "]") cls = false;
    else if (s[i] === "/" && !cls) return i + 1;
  }
  return s.length;
}

/** Comment texts per line (1-based line to texts): `//`, block comments, `<!-- -->` in HTML. A line-leading `-- ` is SQL inside a `.ts`. */
function slashComments(lines: string[], ext: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  const js = ext !== ".css" && ext !== ".html";
  let blockEnd: string | null = null;
  // open template literals and the `${` expressions inside them, innermost last (an expression counts its own braces)
  const nest: number[] = [];
  const inTemplate = () => nest.length > 0 && nest[nest.length - 1] === -1;
  lines.forEach((s, n) => {
    const texts: string[] = [];
    let pos = 0;
    if (blockEnd) {
      const end = s.indexOf(blockEnd);
      if (end < 0) found.set(n + 1, [s]);
      else {
        texts.push(s.slice(0, end));
        pos = end + blockEnd.length;
        blockEnd = null;
      }
      if (end < 0) return;
    } else if (js && /^\s*-- /.test(s)) {
      found.set(n + 1, [s]);
      return;
    }
    while (pos < s.length) {
      const c = s[pos]!;
      if (inTemplate()) {
        if (c === "\\") pos++;
        else if (c === "`") nest.pop();
        else if (c === "$" && s[pos + 1] === "{") {
          nest.push(0);
          pos++;
        }
        pos++;
      } else if (nest.length > 0 && (c === "{" || c === "}")) {
        const depth = nest.pop()!;
        if (c === "{") nest.push(depth + 1);
        else if (depth > 0) nest.push(depth - 1);
        pos++;
      } else if (js && c === "`") {
        nest.push(-1);
        pos++;
      } else if (c === '"' || c === "'") {
        const end = stringEnd(s, pos + 1, c);
        pos = end < 0 ? s.length : end + 1;
      } else if (js && c === "/" && s[pos + 1] !== "/" && s[pos + 1] !== "*" && REGEX_BEFORE.test(s.slice(0, pos))) {
        pos = regexEnd(s, pos + 1);
      } else if (c === "/" && s[pos + 1] === "/" && (pos === 0 || /\s/.test(s[pos - 1]!))) {
        texts.push(s.slice(pos + 2));
        break;
      } else if ((c === "/" && s[pos + 1] === "*") || (ext === ".html" && s.startsWith("<!--", pos))) {
        const open = c === "/" ? 2 : 4;
        const close = c === "/" ? "*/" : "-->";
        const end = s.indexOf(close, pos + open);
        if (end < 0) {
          texts.push(s.slice(pos + open));
          blockEnd = close;
          break;
        }
        texts.push(s.slice(pos + open, end));
        pos = end + close.length;
      } else pos++;
    }
    if (texts.length) found.set(n + 1, texts);
  });
  return found;
}

/** Where a `#` comment starts on the line (at the line's start or after a space, outside quotes), or -1. */
function hashComment(s: string): number {
  let quote: string | null = null;
  for (let j = 0; j < s.length; j++) {
    const c = s[j]!;
    if (quote) {
      if (c === "\\" && quote === '"') j++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (j === 0 || /\s/.test(s[j - 1]!))) return j;
  }
  return -1;
}

/** Whether the text before a point on a line leaves a string open there. */
function insideQuotes(before: string): boolean {
  let quote: string | null = null;
  for (let j = 0; j < before.length; j++) {
    const c = before[j]!;
    if (c === "\\") j++;
    else if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== null;
}

/** Issue numbers in the comments and in the test names of one file. Numbers inside other strings are data, not references. */
export function findIssueRefs(path: string, text: string): IssueRef[] {
  const lines = text.split("\n");
  const ext = extname(path);
  const refs: IssueRef[] = [];
  const add = (n: number, kind: IssueRef["kind"]) => refs.push({ line: n, text: lines[n - 1]!, kind });
  if (SLASH.has(ext)) {
    for (const [n, texts] of slashComments(lines, ext)) if (texts.some((t) => NUMBER.test(t.replace(CODE_SPAN, "")))) add(n, "comment");
  } else if (HASH.has(ext)) {
    lines.forEach((s, i) => {
      if (i === 0 && s.startsWith("#!")) return;
      const at = hashComment(s);
      if (at >= 0 && NUMBER.test(s.slice(at + 1))) add(i + 1, "comment");
    });
  }
  if (TEST_FILE.test(path)) {
    lines.forEach((s, i) => {
      for (const m of s.matchAll(TEST_CALL)) {
        if (insideQuotes(s.slice(0, m.index!))) continue; // `test("…")` written inside a string is data
        const from = m.index! + m[0].length;
        const end = stringEnd(s, from, m[1]!);
        if (end >= 0 && NUMBER.test(s.slice(from, end))) add(i + 1, "test-title");
      }
      const next = lines[i + 1];
      const quote = next?.trimStart()[0];
      if (TEST_OPEN.test(s) && next !== undefined && (quote === '"' || quote === "'" || quote === "`")) {
        const from = next.length - next.trimStart().length + 1;
        const end = stringEnd(next, from, quote);
        if (end >= 0 && NUMBER.test(next.slice(from, end))) add(i + 2, "test-title");
      }
    });
  }
  return refs;
}

/** The files `include` names (all when undefined) and `exclude` leaves out, among the files git tracks at `cwd`; Markdown and binary files are dropped. */
export function publicFiles(include: string[] | undefined, exclude: string[], cwd: string): string[] {
  const p = Bun.spawnSync(["git", "-C", cwd, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ls-files: ${p.stderr.toString().trim()}`);
  return p.stdout
    .toString()
    .split("\0")
    .filter((f) => f && !f.endsWith(".md") && (!include || include.some((e) => underEntry(f, e))) && !exclude.some((e) => underEntry(f, e)))
    .filter((f) => {
      try {
        return !readFileSync(join(cwd, f)).includes(0);
      } catch (e) {
        // listed but not in the working tree (deleted, or a directory such as a submodule); other failures reach the caller
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EISDIR") return false;
        throw e;
      }
    });
}
