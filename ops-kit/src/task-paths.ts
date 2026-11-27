/** The paths a Task's Issue body names. Shared by merge-gate, parallel-guard, the app and `ops-kit backlog edit`; it imports nothing. */

/** A span with a space whose first word, after any `VAR=value`, is a bare command name (`bun`, `grep -n`), not a path or a file. */
const isCommand = (span: string) => {
  const [head, ...rest] = span.trim().replace(/^(?:[A-Za-z_]\w*=\S*[ \t]+)+/, "").split(/[ \t]+/);
  return rest.length > 0 && !!head && /^[\w-]+$/.test(head);
};

const FILE_EXT = /\.(?:tsx?|[cm]?js|json|md|ya?ml|toml|lock|sh|css|html|sql|txt)$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The lines where a name without a directory is read as a file the Task touches: the head of a numbered or bulleted step
 * that starts with a name or an ASCII word, up to its first `:` `：` `—` outside backticks and before any `。` (so `a.md`・`b.md`:
 * and `new.json`（新規）: keep every name before it), and a line that starts with 触る (after a bullet / number mark). A name in the
 * middle of a step or a sentence is a reference.
 */
function stepHead(rest: string): string | null {
  if (!/^(?:`[^`\s]+`|[\w./-])/.test(rest)) return null;
  let tick = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "`") tick = !tick;
    else if (!tick && c === "。") return null;
    else if (!tick && (c === ":" || c === "：" || c === "—")) return rest.slice(0, i);
  }
  return null;
}

function touchLines(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const mark = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line);
    const rest = line.slice(mark?.[0].length ?? line.length - line.trimStart().length);
    if (rest.startsWith("触る")) out.push(rest);
    else if (mark) {
      const head = stepHead(rest);
      if (head) out.push(head);
    }
  }
  return out.join("\n");
}

/**
 * The body without the places that name a file only as a reference: a section headed 検証 or 完了条件 (up to the next `#`-`###`
 * heading outside a code block), a line that starts with 設計チェック, the list under 古い前提を持つ既存の箇所 (the line and the indented or bulleted lines
 * after it), a parenthesis on one line that says と同じ / を参照 / のとおり, and the backticked names right before 触らない
 * (`docs/design/` は触らない, `a.ts`・`b.ts` を触らない).
 */
export function withoutReferences(body: string): string {
  const out: string[] = [];
  let skipSection = false;
  let inList = false;
  let fence = ""; // the opening fence of the code block we are in, or ""
  for (const line of body.split("\n")) {
    // CommonMark: a fence closes on the same character at least as long with nothing after it; a backtick fence's info
    // string has no backtick, so a one-line ```a``` is inline code and opens nothing.
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      const [, run, rest] = mark as unknown as [string, string, string];
      if (!fence) { if (!(run[0] === "`" && rest.includes("`"))) fence = run; }
      else if (run[0] === fence[0] && run.length >= fence.length && rest.trim() === "") fence = "";
    }
    // A Markdown heading needs a space after its `#`s; `#123` or a `#` comment in a code block is not one, and `####` stays inside.
    if (!fence && /^#{1,3}\s/.test(line)) {
      skipSection = /^#{2,3}\s+(?:検証|完了条件)/.test(line);
      inList = false;
    }
    if (skipSection) continue;
    const rest = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, "");
    if (rest.startsWith("設計チェック")) { inList = false; continue; }
    if (rest.startsWith("古い前提を持つ既存の箇所")) { inList = true; continue; }
    if (inList) {
      if (/^(?:\s+\S|[-*]\s)/.test(line)) continue;
      inList = false;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/[（(][^（）()\n]*(?:と同じ|を参照|のとおり)[^（）()\n]*[）)]/g, " ")
    .replace(/(?:`[^`\n]*`[ \t]*[・、,]?[ \t]*)+[はをも]?[ \t]*触らない/g, " ");
}

/**
 * Repository paths named in an Issue body. `top` is the repository's root (plus what open PRs add to it): its
 * directories start a path anywhere in the body. A name without a directory (a root file such as `package.json`, or a backticked
 * word that ends in a file extension, so a file no branch has yet is still seen) counts only on `touchLines`.
 * `path:line` loses the line; a directory keeps its trailing slash. For overlaps, a glob (`docs/design/*.md`, `docs/a-*.md`) is
 * not a path, nor the directory before its wildcard, and a backticked span that starts with a command word and has a space
 * (`bun test scripts/a.test.ts`) names what is checked or searched, not touched. Nor are the places `withoutReferences` drops: the
 * 検証 and 完了条件 sections, a 設計チェック line, the 古い前提を持つ既存の箇所 list, a parenthesis that says と同じ / を参照 /
 * のとおり, and the names right before 触らない. `scope` (merge-gate's) keeps all of these, as before.
 */
export function pathsIn(body: string, top: { name: string; dir: boolean }[], { scope = false }: { scope?: boolean } = {}): string[] {
  const text = scope ? body : withoutReferences(body).replace(/`[^`\n]*`/g, (span) => (isCommand(span.slice(1, -1)) ? " " : span));
  const dirs = top.filter((t) => t.dir).map((t) => esc(t.name));
  const files = top.filter((t) => !t.dir).map((t) => esc(t.name));
  const touch = touchLines(text);
  // a match whose rest of the word reaches a wildcard is the head of a glob
  const glob = (from: string, end: number) => !scope && /^[\w.@\/-]*[*?{[]/.test(from.slice(end));
  const scan = (alt: string, from: string) =>
    [...from.matchAll(new RegExp(`(?<![\\w./-])(?:${alt})(?![\\w-])`, "g"))].filter((m) => !glob(from, m.index + m[0].length)).map((m) => m[0]);
  const found = [
    ...(dirs.length ? scan(`(?:${dirs.join("|")})\\/[\\w.@\\/-]*[\\w\\/]`, text) : []),
    ...(files.length ? scan(`(?:${files.join("|")})`, touch) : []),
  ];
  // Only a file name counts here: `turn/completed`, `origin/main` and `@scope/protocol` have a / but are not paths
  for (const [from, withDir] of [[text, true], [touch, false]] as const) {
    for (const m of from.matchAll(/`([\w.-]+(?:\/[\w.-]+)*)(?::\d+(?:-\d+)?)?`/g)) {
      if (m[1] && FILE_EXT.test(m[1]) && !m[1].startsWith(".") && m[1].includes("/") === withDir) found.push(m[1]);
    }
  }
  return [...new Set(found)];
}

/**
 * The paths for comparing with the places other PBIs yielded (their turns): `pathsIn`, and the paths of the 古い前提を持つ既存の箇所 list
 * (the line and the indented or bulleted lines after it, as `withoutReferences` drops them) that the `## 手順` or `## 検証` section
 * also names. A path only in the list stays a reference; one the steps or the checks name too is a place the Task works on or tests.
 * The list and the sections are matched by the path's text (a `path:line` loses its line).
 */
export function turnPathsIn(body: string, top: { name: string; dir: boolean }[]): string[] {
  const listed: string[] = [];
  const sections: string[] = [];
  let inSection = false;
  let skipSection = false;
  let inList = false;
  let fence = "";
  for (const line of body.split("\n")) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      const [, run, rest] = mark as unknown as [string, string, string];
      if (!fence) { if (!(run[0] === "`" && rest.includes("`"))) fence = run; }
      else if (run[0] === fence[0] && run.length >= fence.length && rest.trim() === "") fence = "";
    }
    if (!fence && /^#{1,3}\s/.test(line)) {
      inSection = /^#{2,3}\s+(?:手順|検証)/.test(line);
      skipSection = /^#{2,3}\s+(?:検証|完了条件)/.test(line);
      inList = false;
    }
    // the list's own lines are not the steps' text, wherever the list stands
    const rest = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, "");
    if (!skipSection && rest.startsWith("古い前提を持つ既存の箇所")) { inList = true; listed.push(line); continue; }
    if (!skipSection && inList) {
      if (/^(?:\s+\S|[-*]\s)/.test(line)) { listed.push(line); continue; }
      inList = false;
    }
    if (inSection) sections.push(line);
  }
  const text = sections.join("\n");
  // the whole path, not a part of a longer one (`a.ts` is not named by `a.tsx` or `a.ts.bak`)
  const named = pathsIn(listed.join("\n"), top, { scope: true }).filter((p) => new RegExp(`(?<![\\w./-])${esc(p)}(?![\\w.-]*[\\w-])`).test(text));
  return [...new Set([...pathsIn(body, top), ...named])];
}

/**
 * What a Task claims as its scope, for merge-gate: `pathsIn`, and a top directory named alone in backticks
 * (`ops-kit/`). pathsIn leaves that out so that parallel-guard's overlaps do not grow to a whole tree; a glob (`scripts/*.ts`)
 * is not a directory here either.
 */
export function scopeIn(text: string, top: { name: string; dir: boolean }[]): string[] {
  const dirs = new Set(top.filter((t) => t.dir).map((t) => `${t.name}/`));
  const alone = [...text.matchAll(/`([^`\s]+\/)`/g)].map((m) => m[1]!).filter((d) => dirs.has(d));
  return [...new Set([...pathsIn(text, top, { scope: true }), ...alone])];
}

export const overlaps = (a: string, b: string) =>
  a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
