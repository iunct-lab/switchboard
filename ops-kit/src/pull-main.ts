// pull-main: fast-forward the main worktree (the first of `git worktree list`) to its upstream.
// `pbi-complete` 6-6 calls it after a merge; every repository gets the same default (#1244, docs/design/main-pull.md).
// Anything that would not be a plain fast-forward stops with a one-line reason and changes nothing.

type Run = { ok: boolean; stdout: string; stderr: string };

function git(dir: string, ...args: string[]): Run {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().replace(/\n+$/, ""), stderr: r.stderr.toString().trim() };
}

const short = (sha: string) => sha.slice(0, 7);
const firstLine = (s: string) => s.split("\n")[0] ?? "";

// Paths named by `git status --porcelain=v1 -z` (never quoted); a rename or copy is followed by its source path
function dirtyPaths(porcelain: string): string[] {
  const fields = porcelain.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    if (f[0] === "R" || f[0] === "C" || f[1] === "R" || f[1] === "C") {
      const from = fields[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

export function pullMain(cwd: string, out: (s: string) => void, err: (s: string) => void): 0 | 1 | 2 {
  const list = git(cwd, "worktree", "list", "--porcelain");
  const main = list.ok ? /^worktree (.+)$/m.exec(list.stdout)?.[1] : undefined;
  if (!main) {
    err(`not a git repository: ${cwd}`);
    return 2;
  }
  const branch = git(main, "symbolic-ref", "--short", "-q", "HEAD");
  if (!branch.ok) {
    out("not pulled: detached HEAD");
    return 1;
  }
  const upstream = git(main, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (!upstream.ok) {
    out(`not pulled: no upstream for ${branch.stdout}`);
    return 1;
  }
  const remote = upstream.stdout.slice(0, upstream.stdout.indexOf("/"));
  const fetch = git(main, "fetch", "--quiet", remote);
  if (!fetch.ok) {
    err(`fetch failed: ${firstLine(fetch.stderr)}`);
    return 2;
  }
  const head = git(main, "rev-parse", "HEAD").stdout;
  const target = git(main, "rev-parse", "@{u}").stdout;
  if (head === target) {
    out(`up to date ${short(head)}`);
    return 0;
  }
  if (!git(main, "merge-base", "--is-ancestor", "HEAD", "@{u}").ok) {
    out(`not pulled: cannot fast-forward (${branch.stdout} is ahead of or has diverged from ${upstream.stdout})`);
    return 1;
  }
  const incoming = new Set(git(main, "diff", "--name-only", "-z", "HEAD", "@{u}").stdout.split("\0").filter(Boolean));
  const overlap = dirtyPaths(git(main, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout).filter((p) => incoming.has(p));
  if (overlap.length > 0) {
    out(`not pulled: uncommitted changes overlap: ${[...new Set(overlap)].join(" ")}`);
    return 1;
  }
  const merge = git(main, "merge", "--ff-only", "--quiet", "@{u}");
  if (!merge.ok) {
    out(`not pulled: ${firstLine(merge.stderr)}`);
    return 1;
  }
  out(`pulled ${short(head)}..${short(git(main, "rev-parse", "HEAD").stdout)} (${branch.stdout} <- ${upstream.stdout})`);
  return 0;
}
