/** What a Task's Issue body names and which Issues a PR is linked to; shared by parallel-guard and merge-gate, which reads GitHub only (#909), so this file imports nothing. */

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)|^Backlog-Task: (\d+)\s*$/gim;

/** The Issues a PR is linked to (#1059): its body's `Closes #n` (close / fix / resolve and their -s / -d forms) or the line `Backlog-Task: n` of a backlog kept in Switchboard (#2344: no `#n`, it would be a GitHub Issue), and its branch `sb/<n>-`. */
export function linkedIssues(pr: { body: string | null; headRefName: string | null }): number[] {
  const linked = [...(pr.body ?? "").matchAll(CLOSES)].map((m) => Number(m[1] ?? m[2]));
  const branch = /^sb\/(\d+)-/.exec(pr.headRefName ?? "");
  if (branch) linked.push(Number(branch[1]));
  return linked;
}

/** A span with a space whose first word, after any `VAR=value`, is a bare command name (`bun`, `grep -n`), not a path or a file. */
const isCommand = (span: string) => {
  const [head, ...rest] = span.trim().replace(/^(?:[A-Za-z_]\w*=\S*[ \t]+)+/, "").split(/[ \t]+/);
  return rest.length > 0 && !!head && /^[\w-]+$/.test(head);
};

const FILE_EXT = /\.(?:tsx?|[cm]?js|json|md|ya?ml|toml|lock|sh|css|html|sql|txt)$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The lines where a name without a directory is read as a file the Task touches (#4382): the head of a numbered or bulleted step
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
 * Repository paths named in an Issue body. `top` is the repository's root (plus what open PRs add to it): its
 * directories start a path anywhere in the body. A name without a directory (a root file such as `package.json`, or a backticked
 * word that ends in a file extension, so a file no branch has yet is still seen) counts only on `touchLines`.
 * `path:line` loses the line; a directory keeps its trailing slash. For overlaps, a glob (`docs/design/*.md`, `docs/a-*.md`) is
 * not a path, nor the directory before its wildcard, and a backticked span that starts with a command word and has a space
 * (`bun test scripts/a.test.ts`) names what is checked or searched, not touched. `scope` (merge-gate's) keeps both, as before.
 */
export function pathsIn(body: string, top: { name: string; dir: boolean }[], { scope = false }: { scope?: boolean } = {}): string[] {
  const text = scope ? body : body.replace(/`[^`\n]*`/g, (span) => (isCommand(span.slice(1, -1)) ? " " : span));
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
  // Only a file name counts here: `turn/completed`, `origin/main` and `@switchboard/protocol` have a / but are not paths
  for (const [from, withDir] of [[text, true], [touch, false]] as const) {
    for (const m of from.matchAll(/`([\w.-]+(?:\/[\w.-]+)*)(?::\d+(?:-\d+)?)?`/g)) {
      if (m[1] && FILE_EXT.test(m[1]) && !m[1].startsWith(".") && m[1].includes("/") === withDir) found.push(m[1]);
    }
  }
  return [...new Set(found)];
}

/**
 * What a Task claims as its scope, for merge-gate (#2498): `pathsIn`, and a top directory named alone in backticks
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
