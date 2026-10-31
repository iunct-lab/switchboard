/** What a Task's Issue body names and which Issues a PR is linked to; shared by parallel-guard and merge-gate, which reads GitHub only (#909), so this file imports nothing. */

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)|^Backlog-Task: (\d+)\s*$/gim;

/** The Issues a PR is linked to (#1059): its body's `Closes #n` (close / fix / resolve and their -s / -d forms) or the line `Backlog-Task: n` of a backlog kept in Switchboard (#2344: no `#n`, it would be a GitHub Issue), and its branch `sb/<n>-`. */
export function linkedIssues(pr: { body: string | null; headRefName: string | null }): number[] {
  const linked = [...(pr.body ?? "").matchAll(CLOSES)].map((m) => Number(m[1] ?? m[2]));
  const branch = /^sb\/(\d+)-/.exec(pr.headRefName ?? "");
  if (branch) linked.push(Number(branch[1]));
  return linked;
}

const FILE_EXT = /\.(?:tsx?|[cm]?js|json|md|ya?ml|toml|lock|sh|css|html|sql|txt)$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Repository paths named in an Issue body. `top` is the repository's root (plus what open PRs add to it): its
 * directories start a path, its files are paths by themselves (`package.json`). A backticked word that looks like a
 * file (it ends in a file extension) counts too, so a file no branch has yet (`new-config.json`) is still seen.
 * `path:line` loses the line; a directory keeps its trailing slash.
 */
export function pathsIn(text: string, top: { name: string; dir: boolean }[]): string[] {
  const dirs = top.filter((t) => t.dir).map((t) => esc(t.name));
  const files = top.filter((t) => !t.dir).map((t) => esc(t.name));
  const alts = [...(dirs.length ? [`(?:${dirs.join("|")})\\/[\\w.@\\/-]*[\\w\\/]`] : []), ...(files.length ? [`(?:${files.join("|")})`] : [])];
  const found = alts.length
    ? [...text.matchAll(new RegExp(`(?<![\\w./-])(?:${alts.join("|")})(?![\\w-])`, "g"))].map((m) => m[0])
    : [];
  // Only a file name counts here: `turn/completed`, `origin/main` and `@switchboard/protocol` have a / but are not paths
  for (const m of text.matchAll(/`([\w.-]+(?:\/[\w.-]+)*)(?::\d+(?:-\d+)?)?`/g)) {
    if (m[1] && FILE_EXT.test(m[1]) && !m[1].startsWith(".")) found.push(m[1]);
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
  return [...new Set([...pathsIn(text, top), ...alone])];
}

export const overlaps = (a: string, b: string) =>
  a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
