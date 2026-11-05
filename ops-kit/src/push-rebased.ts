// pr push-rebased: push the current branch after a rebase the forge could not do (pbi-complete 5, CONFLICTING / DIRTY).
// One command with no arguments, so a task's allow rule can name it whole: a bare `git push --force-with-lease` rule
// matches by prefix and would let a push to main through too. The default branch and a detached HEAD are refused, and
// nothing but the branch goes (`--no-follow-tags`: a `push.followTags` setting would publish tags with it).

export type GitRun = (...args: string[]) => { ok: boolean; stdout: string; stderr: string };

export function gitIn(cwd: string): GitRun {
  return (...args) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
  };
}

// Full ref names, not --short: a tag named like the branch makes the short name ambiguous (`heads/main`)
const strip = (ref: string, prefix: string) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : "");

// origin/HEAD names the default branch; a clone without it falls back to both usual names
function defaultBranches(git: GitRun): string[] {
  const head = git("symbolic-ref", "refs/remotes/origin/HEAD");
  const name = head.ok ? strip(head.stdout, "refs/remotes/origin/") : "";
  return name ? [name] : ["main", "master"];
}

export function pushRebased(git: GitRun): { ok: boolean; message: string } {
  const current = git("symbolic-ref", "-q", "HEAD");
  const branch = current.ok ? strip(current.stdout, "refs/heads/") : "";
  if (!branch) return { ok: false, message: "枝の無い HEAD は push しません（書き直す枝に checkout してから）" };
  if (defaultBranches(git).includes(branch)) return { ok: false, message: `既定の枝 ${branch} は書き直しません` };
  const push = git("push", "--force-with-lease", "--no-follow-tags", "origin", `HEAD:refs/heads/${branch}`);
  if (!push.ok) return { ok: false, message: push.stderr || `git push が失敗しました（${branch}）` };
  return { ok: true, message: `${branch} を push しました（--force-with-lease）` };
}
