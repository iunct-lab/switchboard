import { checkOrigin, must, spawnSh, type Sh } from "./release-tag";

const lines = (out: string) => out.split("\n").filter(Boolean);

/** Checks that `tag` can be rolled back to on `repo`'s main (from that repository's clone, the cwd), and lists what goes. */
export function plan(sh: Sh, tag: string, repo: string): { commits: string[] } {
  checkOrigin(sh, repo);
  must(sh, ["git", "fetch", "origin", "--tags", "main"]);
  const ref = `refs/tags/${tag}`;
  if (!sh(["git", "rev-parse", "--verify", "-q", `${ref}^{commit}`]).ok) throw new Error(`no tag ${tag}`);
  if (!sh(["git", "merge-base", "--is-ancestor", ref, "origin/main"]).ok) throw new Error(`${tag} is not an ancestor of origin/main`);
  const commits = lines(must(sh, ["git", "log", "--format=%h%x09%s", `${ref}..origin/main`]));
  if (!commits.length) throw new Error(`origin/main is at ${tag}: nothing to roll back`);
  return { commits };
}

/**
 * Opens a PR whose one commit puts `tag`'s tree on top of main (no chain of reverts to conflict, no work tree touched).
 * It is reviewed and merged like any PR (merge-gate), never merged here.
 */
export function run(sh: Sh, tag: string, repo: string): string {
  const { commits } = plan(sh, tag, repo);
  const title = `revert: ${tag} に戻す`;
  const list = commits.map((c) => `- ${c.replace("\t", " ")}`).join("\n");
  const commit = must(sh, ["git", "commit-tree", `refs/tags/${tag}^{tree}`, "-p", "origin/main", "-m", title, "-m", `${tag}..origin/main:\n${list}`]);
  const branch = `rollback/${tag}`;
  // The branch is this script's own: a rerun (the PR creation failed, main moved on, an old PR was closed) replaces it.
  must(sh, ["git", "push", "origin", `+${commit}:refs/heads/${branch}`]);
  const body = `main の中身を ${tag} の状態に戻す（木を ${tag} のものに置き換えるコミット 1 つ）。\n\n戻す範囲（${tag}..main、${commits.length} 件）:\n${list}\n\nレビューと merge-gate を通してからマージする。\n`;
  const open = must(sh, ["gh", "pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "url", "-q", ".[0].url"]);
  if (open) {
    // The replaced commit may take back more than the open PR says (main moved on): its list is rewritten too.
    must(sh, ["gh", "pr", "edit", open, "-R", repo, "--body-file", "-"], body);
    return open;
  }
  return must(sh, ["gh", "pr", "create", "-R", repo, "--head", branch, "--base", "main", "--title", title, "--body-file", "-"], body);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tag = args[0];
  const repoAt = args.indexOf("--repo");
  const repo = repoAt >= 0 ? args[repoAt + 1] : undefined;
  if (!tag || !/^\w[\w.-]*$/.test(tag) || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error("usage: bun scripts/rollback-pr.ts <tag> --repo <owner/name>");
    process.exit(2);
  }
  try {
    console.log(run(spawnSh, tag, repo));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
