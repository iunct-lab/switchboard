/**
 * bun scripts/public-docs.ts check|compare|list — the docs that go to the public repo are English and carry no issue numbers.
 *
 *   check [files…]            per doc `<path> ja=<n> refs=<n>`; exit 1 when any is not 0
 *   compare <rev> <files…>    code / numbers that vanished or changed between `git show <rev>:<path>` and the working tree;
 *                             exit 1 when code vanished, 2 when `<rev>:<path>` cannot be read
 *   list                      the default targets, one path per line
 *
 * Japanese may stay only in code (fenced blocks, `inline code`, <code>/<pre>) and in screen mock-ups (class="mock").
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const JA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}「」、。]/gu;
const REF = /(^|[^A-Za-z0-9&/])#[0-9]{2,5}\b/g;
const MAX_LINES = 5;

/** Replaces every character but newlines with a space, so line numbers survive the stripping. */
const blank = (s: string): string => s.replace(/[^\n]/g, " ");

function cut(text: string, re: RegExp): string {
  return text.replace(re, blank);
}

/** Blanks elements whose open tag matches `open`, counting nested same-name tags until the matching close; `take` gets each one's offsets. */
function elements(text: string, open: RegExp, take?: (innerStart: number, innerEnd: number, start: number, end: number) => void): string {
  const re = new RegExp(open.source, open.flags.includes("g") ? open.flags : `${open.flags}g`);
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = /^<([A-Za-z][A-Za-z0-9]*)/.exec(m[0])?.[1];
    if (!name || m.index < last) continue;
    const tag = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, "gi");
    tag.lastIndex = m.index + m[0].length;
    let depth = 1;
    // An element that never closes is a stray tag in prose: blank only the open tag, not the rest of the doc.
    let end = m.index + m[0].length;
    let innerEnd = end;
    for (let t = tag.exec(text); t; t = tag.exec(text)) {
      if (t[2]) continue; // self-closing
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index + t[0].length; innerEnd = t.index; break; }
    }
    take?.(m.index + m[0].length, innerEnd, m.index, end);
    out += text.slice(last, m.index) + blank(text.slice(m.index, end));
    last = end;
    re.lastIndex = end;
  }
  return out + text.slice(last);
}

const STYLE = /<style\b[^>]*>/i;
const SCRIPT = /<script\b[^>]*>/i;
const PRE = /<pre\b[^>]*>/i;
const CODE = /<code\b[^>]*>/i;
/** An element whose class list has the token `mock` (not `mock-title`). */
const MOCK = /<[A-Za-z][A-Za-z0-9]*\b[^>]*\bclass\s*=\s*(["'])(?:[^"']*\s)?mock(?:\s[^"']*)?\1[^>]*>/i;

/** Splits markdown into fenced blocks (their inner text) and the rest, with the fences blanked in the rest. */
function fences(text: string): { rest: string; blocks: string[] } {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let open: { ch: string; len: number; at: number } | undefined;
  const rest = lines.map((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!open) {
      if (f) { open = { ch: f[1][0], len: f[1].length, at: i }; return blank(line); }
      return line;
    }
    if (f && f[1][0] === open.ch && f[1].length >= open.len && line.trim() === f[1]) {
      blocks.push(lines.slice(open.at + 1, i).join("\n").trim());
      open = undefined;
    }
    return blank(line);
  });
  if (open) blocks.push(lines.slice(open.at + 1).join("\n").trim());
  return { rest: rest.join("\n"), blocks };
}

/** Inline code: a backtick run closed by the same run within the paragraph (a blank line ends an unclosed one, as in CommonMark). */
const INLINE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

/** Text without code, mock-ups, styles and scripts: what a reader of the English doc reads as prose. */
export function prose(text: string): string {
  // Inline code first: a backtick-quoted `<pre>` is text about a tag, not a tag.
  let t = cut(fences(text).rest, INLINE);
  for (const re of [STYLE, SCRIPT, MOCK, PRE, CODE]) t = elements(t, re);
  return t;
}

/** Text a `#N` is counted in: only <style> (colour codes) and mock-ups are left out. */
function refText(text: string): string {
  let t = text;
  for (const re of [STYLE, MOCK]) t = elements(t, re);
  return t;
}

export interface Count {
  ja: number;
  refs: number;
  jaLines: number[];
  refLines: number[];
}

export function count(text: string): Count {
  const scan = (t: string, re: RegExp) => {
    let n = 0;
    const lines: number[] = [];
    t.split("\n").forEach((line, i) => {
      const k = line.match(re)?.length ?? 0;
      n += k;
      if (k) lines.push(i + 1);
    });
    return { n, lines };
  };
  const ja = scan(prose(text), JA);
  const refs = scan(refText(text), REF);
  return { ja: ja.n, refs: refs.n, jaLines: ja.lines, refLines: refs.lines };
}

const entities = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

/** Multiset (as a list) of code in a doc: fenced blocks, inline code, <pre> and <code> bodies. */
export function codeOf(text: string): string[] {
  const out: string[] = [];
  const f = fences(text);
  out.push(...f.blocks);
  // Find <pre>/<code> with inline code blanked (a quoted `<pre>` is not a tag), but take their bodies from the original
  // (blanking keeps offsets): a backtick inside a real <pre> is part of the command.
  let rest = f.rest;
  let t = cut(f.rest, INLINE);
  for (const re of [PRE, CODE]) {
    t = elements(t, re, (innerStart, innerEnd, start, end) => {
      out.push(entities(f.rest.slice(innerStart, innerEnd)));
      rest = rest.slice(0, start) + blank(rest.slice(start, end)) + rest.slice(end);
    });
  }
  for (const m of rest.matchAll(INLINE)) {
    const ticks = m[1].length;
    out.push(m[0].slice(ticks, m[0].length - ticks).trim());
  }
  return out.filter((s) => s !== "");
}

/** Numbers outside code, styles and scripts (`#N` and colour codes left out). */
export function numbersOf(text: string): string[] {
  let t = cut(fences(text).rest, INLINE);
  for (const re of [STYLE, SCRIPT, PRE, CODE]) t = elements(t, re);
  t = t.replace(/#[0-9a-fA-F]+\b/g, " ");
  return t.match(/\b\d+(\.\d+)?\b/g) ?? [];
}

/** Items of `a` that `b` has fewer of (multiset difference a - b). */
export function minus(a: string[], b: string[]): string[] {
  const have = new Map<string, number>();
  for (const x of b) have.set(x, (have.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = have.get(x) ?? 0;
    if (n > 0) have.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

function git(args: string[]): { code: number; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
}

/** Public docs: docs/**.md|html, aws/README.md, SECURITY.md, minus ops.config.json publicSync.exclude (a path or a leading directory). */
export function defaultTargets(): string[] {
  const root = repoRoot();
  if (!root) return [];
  const exclude: string[] = JSON.parse(readFileSync(`${root}/ops.config.json`, "utf8")).publicSync?.exclude ?? [];
  const excluded = (p: string) => exclude.some((e) => p === e || p.startsWith(e.endsWith("/") ? e : `${e}/`));
  return git(["-C", root, "ls-files", "docs", "aws/README.md", "SECURITY.md"]).out.split("\n")
    .filter((p) => p && (p === "aws/README.md" || p === "SECURITY.md" || (p.startsWith("docs/") && /\.(md|html)$/.test(p))))
    .filter((p) => !excluded(p))
    .sort();
}

const repoRoot = () => git(["rev-parse", "--show-toplevel"]).out.trim();

function runCheck(files: string[]): number {
  let bad = false;
  // The default targets are paths from the repository root, so they read from there whatever the working directory is.
  const targets = files.length ? files.map((f) => ({ f, path: f })) : defaultTargets().map((f) => ({ f, path: `${repoRoot()}/${f}` }));
  if (targets.length === 0) {
    console.error("no documents to check (run inside the repository)");
    return 2;
  }
  for (const { f, path } of targets) {
    const c = count(readFileSync(path, "utf8"));
    console.log(`${f} ja=${c.ja} refs=${c.refs}`);
    if (c.ja) console.log(`  ja lines: ${c.jaLines.slice(0, MAX_LINES).join(", ")}`);
    if (c.refs) console.log(`  refs lines: ${c.refLines.slice(0, MAX_LINES).join(", ")}`);
    if (c.ja || c.refs) bad = true;
  }
  return bad ? 1 : 0;
}

function runCompare(rev: string, files: string[]): number {
  let lost = false;
  for (const f of files) {
    const before = git(["show", `${rev}:${f}`]);
    if (before.code !== 0) {
      // A mistyped rev or a path the rev lacks compares nothing: fail rather than look verified.
      console.error(`${f}: cannot read ${rev}:${f}`);
      return 2;
    }
    const after = readFileSync(f, "utf8");
    console.log(f);
    const gone = minus(codeOf(before.out), codeOf(after));
    for (const c of gone) console.log(`- code: ${c}`);
    if (gone.length) lost = true;
    const nb = numbersOf(before.out);
    const na = numbersOf(after);
    for (const n of minus(nb, na)) console.log(`± number: ${n} (only in ${rev})`);
    for (const n of minus(na, nb)) console.log(`± number: ${n} (only in the working tree)`);
  }
  return lost ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "check") process.exit(runCheck(args));
  else if (cmd === "compare" && args.length >= 2) process.exit(runCompare(args[0], args.slice(1)));
  else if (cmd === "list") console.log(defaultTargets().join("\n"));
  else {
    console.error("usage: bun scripts/public-docs.ts check [files…] | compare <rev> <files…> | list");
    process.exit(2);
  }
}
