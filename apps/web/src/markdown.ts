// Markdown → a small tree the UI renders as React elements (Markdown.tsx). No HTML string is ever built: raw HTML in the
// source stays text, the image syntax becomes a link (nothing is fetched), and a link's URL goes through `safeHref` before
// it becomes an href. Covers what runner replies and reports use — headings, paragraphs, lists (nested, ordered), tables,
// fenced code, inline code, strong, em, links, quotes, rules — not the whole of GFM (no footnotes, math, HTML, task boxes).

export type MdInline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: MdInline[] }
  | { t: "em"; children: MdInline[] }
  | { t: "link"; url: string; children: MdInline[] }
  | { t: "br" };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { t: "heading"; level: number; inline: MdInline[] }
  | { t: "paragraph"; inline: MdInline[] }
  | { t: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: "table"; head: MdInline[][]; rows: MdInline[][][]; align: MdAlign[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: MdBlock[] }
  | { t: "hr" };

/** The href a link may carry: http(s) or mailto only. Anything else is null and the link renders as plain text —
 *  `javascript:`, `data:`, `vbscript:` …, and also a relative path or `#…`, which would resolve against the Web UI's own page
 *  (a runner's `[db.ts](packages/core/src/db.ts)` is a file of its checkout, not a page). Control characters are refused
 *  outright because browsers drop them while parsing (`java\tscript:` runs as `javascript:`). */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (!u || /[\u0000-\u001f\u007f]/.test(u)) return null;
  return /^(https?:|mailto:)/i.test(u) ? u : null;
}

// ---------------------------------------------------------------------------------------------------------------- blocks

// A backtick fence has no backtick after it on its line (```npm test``` is inline code); a tilde fence may.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|(\d{1,9})[.)])(?:( +)(.*))?$/;
const DELIM_CELL = /^:?-+:?$/;

/** The line that closes a fence opened by `mark`: the same character, at least as many. */
const fenceClose = (mark: string) => new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);

const blank = (l: string) => l.trim() === "";
const lead = (l: string) => l.length - l.trimStart().length;

function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function delimiterRow(line: string | undefined, cells: number): MdAlign[] | null {
  if (line === undefined || !line.includes("|")) return null;   // `x |` over `---` is a paragraph and a rule
  const parts = splitCells(line);
  if (parts.length !== cells || !parts.every((p) => DELIM_CELL.test(p))) return null;
  return parts.map((p) => (p.startsWith(":") && p.endsWith(":") ? "center" : p.endsWith(":") ? "right" : p.startsWith(":") ? "left" : null));
}

function tableStart(lines: string[], i: number): MdAlign[] | null {
  const line = lines[i]!;
  if (!line.includes("|")) return null;
  return delimiterRow(lines[i + 1], splitCells(line).length);
}

function blockStart(lines: string[], i: number): boolean {
  const l = lines[i]!;
  const m = marker(l);
  // only a bullet or `1.` cuts a paragraph: `2026. 年の…` on the next line is the same paragraph
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || (!!m && (!m.ordered || m.start === 1)) || tableStart(lines, i) !== null;
}

/** A list marker: what it is and where its content starts. */
function marker(line: string) {
  const m = LIST.exec(line);
  if (!m) return null;
  const indent = m[1]!.length;
  const spaces = m[4]?.length ?? 0;
  const width = m[2]!.length + (spaces === 0 || spaces > 4 ? 1 : spaces);
  return {
    indent,
    content: indent + width,
    ordered: m[3] !== undefined,
    kind: m[3] !== undefined ? m[2]!.slice(-1) : m[2]!,
    start: m[3] !== undefined ? Number(m[3]) : 1,
    rest: spaces > 4 ? " ".repeat(spaces - 1) + (m[5] ?? "") : (m[5] ?? ""),
  };
}

const dedent = (l: string, n: number) => l.slice(Math.min(lead(l), n));

function parseList(lines: string[], i: number, depth: number): [MdBlock, number] {
  const first = marker(lines[i]!)!;
  const items: MdBlock[][] = [];
  while (i < lines.length) {
    const m = marker(lines[i]!);
    if (!m || m.ordered !== first.ordered || m.kind !== first.kind || m.indent >= first.indent + 2) break;
    const body = [m.rest];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (blank(l)) {
        let k = j;
        while (k < lines.length && blank(lines[k]!)) k++;
        if (k < lines.length && lead(lines[k]!) > m.indent && !(marker(lines[k]!) && lead(lines[k]!) < m.indent + 2)) {
          for (; j < k; j++) body.push("");
          j--;
          continue;
        }
        break;
      }
      const sub = marker(l);
      if (sub && lead(l) < m.indent + 2) break;
      if (lead(l) > m.indent) { body.push(dedent(l, m.content)); continue; }
      // A lazy continuation line of the item's last paragraph.
      if (!blank(lines[j - 1]!) && !blockStart(lines, j)) { body.push(l.trimStart()); continue; }
      break;
    }
    items.push(parseBlocks(body, depth + 1));
    // Blank lines between items keep the list going when the next item has the same marker.
    let k = j;
    while (k < lines.length && blank(lines[k]!)) k++;
    const next = k < lines.length ? marker(lines[k]!) : null;
    if (!next || next.ordered !== first.ordered || next.kind !== first.kind || next.indent >= first.indent + 2) { i = j; break; }
    i = k;
  }
  return [{ t: "list", ordered: first.ordered, start: first.start, items }, i];
}

/** How deep lists and quotes nest. Past it the rest is one paragraph: a reply that echoes a generated file can nest
 *  thousands deep, and parsing (and drawing) one level per call would run out of stack and blank the Task screen. */
export const MAX_DEPTH = 32;

function parseBlocks(lines: string[], depth = 0): MdBlock[] {
  if (depth >= MAX_DEPTH) {
    const text = lines.map((l) => l.trim()).join("\n").trim();
    return text ? [{ t: "paragraph", inline: parseInline(text) }] : [];
  }
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fenceClose(fence[1]!);
      const indent = lead(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i]!)) body.push(dedent(lines[i++]!, indent));
      i++;
      out.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      out.push({ t: "heading", level: heading[1]!.length, inline: parseInline(text) });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ t: "quote", blocks: parseBlocks(body, depth + 1) });
      continue;
    }

    if (marker(line)) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }

    const align = tableStart(lines, i);
    if (align) {
      const cells = (l: string) => {
        const c = splitCells(l).slice(0, align.length);
        while (c.length < align.length) c.push("");
        return c.map((cell) => parseInline(cell));
      };
      const head = cells(line);
      const rows: MdInline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|")) rows.push(cells(lines[i++]!));
      out.push({ t: "table", head, rows, align });
      continue;
    }

    const body = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]!) && !blockStart(lines, i)) body.push(lines[i++]!.trim());
    out.push({ t: "paragraph", inline: parseInline(body.join("\n")) });
  }
  return out;
}

export function parseMarkdown(src: string): MdBlock[] {
  // Leading tabs count as indentation (4 columns) — except inside a fence, where they are the code's own text.
  let close: RegExp | null = null;
  const lines = src.replace(/\r\n?/g, "\n").split("\n").map((l) => {
    if (close) {
      if (close.test(l)) close = null;
      return l;
    }
    const fence = FENCE.exec(l);
    if (fence) close = fenceClose(fence[1]!);
    return l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    "));
  });
  return parseBlocks(lines);
}

// ---------------------------------------------------------------------------------------------------------------- inline

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const AUTOLINK = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/iy;

/** Code spans: start → end (just past the closing run). A run of backticks closes only with a run exactly as long; a run
 *  with no partner is literal, and so is a backslash-escaped backtick (it does not open). Built in one pass (a run length that found no partner is not searched for again). */
function codeSpans(s: string): Map<number, number> {
  const out = new Map<number, number>();
  const none = new Map<number, number>();   // run length → no partner at or after this index
  for (let i = s.indexOf("`"); i >= 0; ) {
    let slashes = 0;
    while (s[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) { i = s.indexOf("`", i + 1); continue; }   // an escaped backtick is text; the rest of its run may open
    const len = runAt(s, "`", i);
    let j = i + len;
    if (j >= (none.get(len) ?? Infinity)) j = -1;
    while (j >= 0 && (j = s.indexOf("`", j)) >= 0) {
      const r = runAt(s, "`", j);
      if (r === len) break;
      j += r;
    }
    if (j < 0) { none.set(len, i); i = s.indexOf("`", i + len); continue; }
    out.set(i, j + len);
    i = s.indexOf("`", j + len);
  }
  return out;
}

/** Matching pairs of `open`/`close` in one pass (a stack, escapes skipped; parentheses do not cross a line): position of
 *  the opener → position of its closer. One pass per string keeps a reply full of unmatched `[` or `(` linear. */
function pairs(s: string, code: Map<number, number>, open: string, close: string, lineBound: boolean): Map<number, number> {
  const out = new Map<number, number>();
  let stack: number[] = [];
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    const span = code.get(k);
    if (span !== undefined) { k = span - 1; continue; }
    if (c === open) stack.push(k);
    else if (c === close && stack.length) out.set(stack.pop()!, k);
    else if (c === "\n" && lineBound) stack = [];
  }
  return out;
}

/** Positions where an emphasis delimiter `d` may close: a run of exactly `d` (so `*` skips a `**` pair) right after a
 *  non-space, not escaped, not inside a code span, and for `_` not followed by a letter. Sorted; built once per string and
 *  delimiter. */
function closers(s: string, code: Map<number, number>, d: string): number[] {
  const ch = d[0]!;
  const out: number[] = [];
  const spans = [...code].sort((a, b) => a[0] - b[0]);
  let next = 0;
  for (let j = s.indexOf(ch); j >= 0; j = s.indexOf(ch, j + 1)) {
    while (next < spans.length && spans[next]![1] <= j) next++;
    if (next < spans.length && spans[next]![0] <= j) { j = spans[next]![1] - 1; continue; }   // inside a code span
    let end = j;
    while (s[end] === ch) end++;
    const ok = end - j === d.length && s[j - 1] !== "\\" && !/\s/.test(s[j - 1] ?? " ") && !(ch === "_" && WORD.test(s[end] ?? ""));
    if (ok) out.push(j);
    j = end - 1;
  }
  return out;
}

/** A sticky regex matched at `k` (no copy of the rest of the string). */
function matchAt(re: RegExp, s: string, k: number): RegExpExecArray | null {
  re.lastIndex = k;
  return re.exec(s);
}

/** Length of the run of `ch` starting at `k`. */
function runAt(s: string, ch: string, k: number): number {
  let e = k;
  while (s[e] === ch) e++;
  return e - k;
}

function firstAtOrAfter(list: number[], from: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]! < from) lo = mid + 1; else hi = mid; }
  return lo < list.length ? list[lo]! : -1;
}

/** `links: false` parses a link's own text: no link inside a link (an anchor in an anchor would send the click elsewhere). */
export function parseInline(s: string, links = true): MdInline[] {
  const out: MdInline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", text: buf }); buf = ""; } };
  const push = (n: MdInline) => { flush(); out.push(n); };
  const code = codeSpans(s);
  let brackets: Map<number, number> | undefined;
  let parens: Map<number, number> | undefined;
  const runs = new Map<string, number[]>();
  /** `[text](url)` / `![alt](url)` with `[` at `at`: [label, url, end] or null. */
  const linkAt = (at: number): [string, string, number] | null => {
    const close = (brackets ??= pairs(s, code, "[", "]", false)).get(at);
    if (close === undefined || s[close + 1] !== "(") return null;
    const end = (parens ??= pairs(s, code, "(", ")", true)).get(close + 1);
    if (end === undefined) return null;
    const target = s.slice(close + 2, end).trim().replace(/\s+("[^"]*"|'[^']*')$/, "");
    return [s.slice(at + 1, close), target.replace(/^<(.*)>$/, "$1"), end + 1];
  };
  const closeEmphasis = (d: string, from: number): number => {
    let list = runs.get(d);
    if (!list) runs.set(d, (list = closers(s, code, d)));
    return firstAtOrAfter(list, from);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && PUNCT.test(s[i + 1] ?? "")) { buf += s[i + 1]; i += 2; continue; }
    if (c === "\n") { buf = buf.replace(/[ \t]+$/, ""); push({ t: "br" }); i++; while (s[i] === " ") i++; continue; }
    if (c === "`") {
      const end = code.get(i);
      if (end === undefined) { const run = runAt(s, "`", i); buf += "`".repeat(run); i += run; continue; }
      const run = runAt(s, "`", i);
      let text = s.slice(i + run, end - run).replace(/\n/g, " ");
      if (text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && text.trim()) text = text.slice(1, -1);
      push({ t: "code", text });
      i = end;
      continue;
    }
    if (links && c === "!" && s[i + 1] === "[") {
      const l = linkAt(i + 1);
      if (l) {
        push({ t: "link", url: l[1], children: l[0] ? parseInline(l[0], false) : [{ t: "text", text: l[1] }] });
        i = l[2];
        continue;
      }
    }
    if (links && c === "[") {
      const l = linkAt(i);
      if (l) { push({ t: "link", url: l[1], children: parseInline(l[0], false) }); i = l[2]; continue; }
    }
    if (links && c === "<") {
      const m = matchAt(AUTOLINK, s, i);
      if (m) { push({ t: "link", url: m[1]!, children: [{ t: "text", text: m[1]! }] }); i += m[0].length; continue; }
    }
    if (c === "*" || c === "_") {
      const run = s.startsWith(c.repeat(3), i) ? 3 : s.startsWith(c.repeat(2), i) ? 2 : 1;
      const d = c.repeat(run);
      const opens = !/\s/.test(s[i + run] ?? " ") && (c === "*" || !WORD.test(s[i - 1] ?? ""));
      const j = opens ? closeEmphasis(d, i + run + 1) : -1;
      if (j > 0) {
        const inner = parseInline(s.slice(i + run, j), links);
        push(run === 1 ? { t: "em", children: inner } : run === 2 ? { t: "strong", children: inner } : { t: "strong", children: [{ t: "em", children: inner }] });
        i = j + run;
        continue;
      }
      buf += d;
      i += run;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
