/**
 * Where a local merge lands while GitHub cannot be used (scripts/local-merge.ts, scripts/forge-resync.ts): a ref no work
 * tree has checked out, so that a merge never moves the files of a checkout — the main work tree may be the one a
 * running daemon reads, and updating it stays its own step (`ops-kit pull-main`). The branch itself is not moved.
 * docs/design/forge-integration.md, "While GitHub cannot be used, and coming back".
 */
import { spawnSync } from "node:child_process";

/** The landing ref of a branch: outside `refs/heads/`, so no checkout can be on it and no push sends it by itself. */
export const landingRef = (branch: string): string => `refs/switchboard/landed/${branch}`;

const sha = (dir: string, ref: string): string | null => {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "-q", `${ref}^{commit}`], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
};

/**
 * The tip local work is based on for `branch` in the checkout `dir`: the landing ref while it has commits the branch does
 * not (merges made here that the branch's work tree has not been given yet), else the branch. Once the branch has them —
 * they went to GitHub and the work tree was pulled — the landing ref counts for nothing. `landing`: the landing ref's
 * value now, null when there is none. Null = no such branch and no landing.
 */
export function landedTip(dir: string, branch: string): { ref: string; sha: string; landing: string | null } | null {
  const own = sha(dir, `refs/heads/${branch}`);
  const landing = sha(dir, landingRef(branch));
  if (landing && (!own || spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", landing, own]).status !== 0)) return { ref: landingRef(branch), sha: landing, landing };
  return own ? { ref: `refs/heads/${branch}`, sha: own, landing } : null;
}
