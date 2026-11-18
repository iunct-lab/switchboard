/** Which Issues a PR is linked to; shared by parallel-guard, merge-gate, local-merge and the app's backlog sync. merge-gate reads GitHub only, so this file imports nothing. */

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)|^Backlog-Task: (\d+)\s*$/gim;

/** The Issues a PR is linked to: its body's `Closes #n` (close / fix / resolve and their -s / -d forms) or the line `Backlog-Task: n` of a backlog kept in Switchboard (no `#n`, it would be a GitHub Issue), and its branch `sb/<n>-`. */
export function linkedIssues(pr: { body: string | null; headRefName: string | null }): number[] {
  const linked = [...(pr.body ?? "").matchAll(CLOSES)].map((m) => Number(m[1] ?? m[2]));
  const branch = /^sb\/(\d+)-/.exec(pr.headRefName ?? "");
  if (branch) linked.push(Number(branch[1]));
  return linked;
}
