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
/** A test call's head up to its first `(`; group 1 is the modifier (`.skipIf`, `.each`) when there is one. */
const TEST_CALL = /(?<![\w.$])(?:test|it|describe)(\.\w+)?\(/g;

/** The end of the string that starts at `from` (just past the opening quote) on this line, or -1. */
function stringEnd(s: string, from: number, quote: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === quote) return i;
  }
  return -1;
}

type At = { line: number; col: number };

/** The first non-space character at or after a point, looking on the following lines too, or null. */
function skipSpace(lines: string[], at: At): At | null {
  let { line, col } = at;
  for (; line < lines.length; line++, col = 0) {
    const rest = lines[line]!.slice(col);
    const k = rest.length - rest.trimStart().length;
    if (k < rest.length) return { line, col: col + k };
  }
  return null;
}

const isQuote = (c: string | undefined) => c === '"' || c === "'" || c === "`";

/** For `test.skipIf(x)("name")`, given the point just past the first `(`: null when no second call follows the first, else the second call and where its name's string starts (null when its first argument is not a string). `code` is the file's lines with strings, regular expressions and comments masked (`scanSlash`), so only the parentheses of code count; lines may be crossed. */
function chainedName(code: string[], from: At): { name: At | null } | null {
  let depth = 1;
  let { line, col } = from;
  for (; line < code.length; line++, col = 0) {
    const s = code[line]!;
    for (; col < s.length; col++) {
      const c = s[col]!;
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        const open = skipSpace(code, { line, col: col + 1 });
        if (!open || code[open.line]![open.col] !== "(") return null;
        const name = skipSpace(code, { line: open.line, col: open.col + 1 });
        return { name: name && isQuote(code[name.line]![name.col]) ? name : null };
      }
    }
  }
  return null;
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

/**
 * Comment texts per line (1-based line to texts): `//`, block comments, `<!-- -->` in HTML. A line-leading `-- ` is SQL inside a `.ts`.
 * `code` is each line with what is not code masked — string bodies, template literal text and comments to spaces, regular expressions and the backtick that closes a template to `0` (a value, so a `/` after it divides) — keeping the quote that opens a string, so a test call can be found and its parentheses counted across lines.
 * This is an approximation of the lexer, and test names are read with its limits: outside a `.ts` file `//` starts a comment only at the line's start or after a space (so that `http://` in JSX text is not one), a line-leading `-- ` inside a template literal is all SQL comment, and whether a `/` opens a regular expression is judged from the code before it, on the last line with code when the line has none before it (a line-leading `/` after a line that ends in `)`, `else` or `do` opens one).
 */
function scanSlash(lines: string[], ext: string): { comments: Map<number, string[]>; code: string[] } {
  const found = new Map<number, string[]>();
  const code: string[] = [];
  const js = ext !== ".css" && ext !== ".html";
  let blockEnd: string | null = null;
  // open template literals and the `${` expressions inside them, innermost last (an expression counts its own braces)
  const nest: number[] = [];
  const inTemplate = () => nest.length > 0 && nest[nest.length - 1] === -1;
  let lastCode = ""; // the last masked line that has code: what comes before a line-leading `/`
  lines.forEach((s, n) => {
    const masked = s.split("");
    const blank = (from: number, to: number, fill = " ") => masked.fill(fill, from, Math.min(to, s.length));
    scanLine(s, n, blank, (pos) => {
      const before = masked.slice(0, pos).join("");
      if (before.trim()) return before;
      // a line-leading `/` continues the last line with code; after the `)` of `if (…)` or after `else` / `do` it opens a regular expression, as at the start of a file
      return /(\)|\b(?:else|do))\s*$/.test(lastCode) ? before : `${lastCode}\n${before}`;
    });
    const line = masked.join("");
    code.push(line);
    if (line.trim()) lastCode = line;
  });
  return { comments: found, code };

  function scanLine(s: string, n: number, blank: (from: number, to: number, fill?: string) => void, codeBefore: (pos: number) => string): void {
    const texts: string[] = [];
    let pos = 0;
    if (blockEnd) {
      const end = s.indexOf(blockEnd);
      if (end < 0) {
        found.set(n + 1, [s]);
        blank(0, s.length);
        return;
      }
      texts.push(s.slice(0, end));
      pos = end + blockEnd.length;
      blank(0, pos);
      blockEnd = null;
    } else if (js && inTemplate() && /^\s*-- /.test(s)) {
      texts.push(s); // SQL in a template literal; the rest of the line is still read, as it may close the template
    }
    while (pos < s.length) {
      const c = s[pos]!;
      if (inTemplate()) {
        const at = pos;
        if (c === "\\") pos++;
        else if (c === "`") nest.pop();
        else if (c === "$" && s[pos + 1] === "{") {
          nest.push(0);
          pos++;
        }
        pos++;
        blank(at, c === "$" && pos - at === 2 ? at + 1 : pos, c === "`" ? "0" : " "); // the `{` of `${` stays: a `/` after it opens a regular expression
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
        blank(pos + 1, end < 0 ? s.length : end + 1);
        pos = end < 0 ? s.length : end + 1;
      } else if (js && c === "/" && s[pos + 1] !== "/" && s[pos + 1] !== "*" && REGEX_BEFORE.test(codeBefore(pos))) {
        const end = regexEnd(s, pos + 1);
        blank(pos, end, "0"); // a value, not space: a `/` after it divides (`/x/ / 2`)
        pos = end;
      } else if (c === "/" && s[pos + 1] === "/" && (pos === 0 || /\s/.test(s[pos - 1]!) || ext === ".ts")) {
        texts.push(s.slice(pos + 2));
        blank(pos, s.length);
        break;
      } else if ((c === "/" && s[pos + 1] === "*") || (ext === ".html" && s.startsWith("<!--", pos))) {
        const open = c === "/" ? 2 : 4;
        const close = c === "/" ? "*/" : "-->";
        const end = s.indexOf(close, pos + open);
        if (end < 0) {
          texts.push(s.slice(pos + open));
          blank(pos, s.length);
          blockEnd = close;
          break;
        }
        texts.push(s.slice(pos + open, end));
        blank(pos, end + close.length);
        pos = end + close.length;
      } else pos++;
    }
    if (texts.length) found.set(n + 1, texts);
  }
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

/** Issue numbers in the comments and in the test names of one file. Numbers inside other strings are data, not references. */
export function findIssueRefs(path: string, text: string): IssueRef[] {
  const lines = text.split("\n");
  const ext = extname(path);
  const refs: IssueRef[] = [];
  const add = (n: number, kind: IssueRef["kind"]) => refs.push({ line: n, text: lines[n - 1]!, kind });
  const scan = SLASH.has(ext) ? scanSlash(lines, ext) : null;
  if (scan) {
    for (const [n, texts] of scan.comments) if (texts.some((t) => NUMBER.test(t.replace(CODE_SPAN, "")))) add(n, "comment");
  } else if (HASH.has(ext)) {
    lines.forEach((s, i) => {
      if (i === 0 && s.startsWith("#!")) return;
      const at = hashComment(s);
      if (at >= 0 && NUMBER.test(s.slice(at + 1))) add(i + 1, "comment");
    });
  }
  if (scan && TEST_FILE.test(path)) {
    // found on the masked lines: a `test("…")` written inside a string, a regular expression or a comment is not a call
    const { code } = scan;
    code.forEach((s, i) => {
      for (const m of s.matchAll(TEST_CALL)) {
        const after = { line: i, col: m.index! + m[0].length };
        const first = skipSpace(code, after);
        if (!first) continue;
        // after a modifier the first call may take a condition that starts with a string (`test.skipIf("ci" === mode)("…")`): when a second call follows, the name is its argument
        const chained = m[1] ? chainedName(code, after) : null;
        const name = chained ? chained.name : isQuote(code[first.line]![first.col]) ? first : null;
        if (!name) continue;
        const row = lines[name.line]!;
        const quote = row[name.col]!;
        const end = stringEnd(row, name.col + 1, quote);
        if (end >= 0 && NUMBER.test(row.slice(name.col + 1, end))) add(name.line + 1, "test-title");
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
