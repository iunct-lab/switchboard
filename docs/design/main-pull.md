# main-pull (updating the main worktree after a merge)

Step 6-6 of `pbi-complete` updates the main worktree after the PBI is closed. It used to be left to "follow the procedure in CLAUDE.md", so in a repository with no such procedure the pull never happened and the work stopped there (found 2026-10-14).
As the default that is the same in every repository, the kit's CLI `ops-kit pull-main` does it.

## Parts

| Part | Role |
|---|---|
| `ops-kit pull-main` (`ops-kit/src/pull-main.ts`) | Fast-forwards the main worktree (the first in `git worktree list`) to its upstream. It reads no configuration. It can be called from inside any worktree |
| `pbi-complete` 6-6 | Calls this command after the merge. Writes the one output line in the report's `main:` |
| The consuming repository's `CLAUDE.md` | Only the points that change the default (for example: pull restarts the running service, so ask the user for an OK) |

## Outcomes

| State | Output | exit | What it changes |
|---|---|---|---|
| Can fast-forward | `pulled <old>..<new> (<branch> <- <upstream>)` | 0 | The worktree and the branch |
| Already the same | `up to date <sha>` | 0 | Nothing |
| Local commits are ahead or diverged | `not pulled: cannot fast-forward (…)` | 1 | Nothing |
| Uncommitted changes (including untracked) overlap the files to be brought in | `not pulled: uncommitted changes overlap: <パス>` | 1 | Nothing |
| Detached HEAD | `not pulled: detached HEAD` | 1 | Nothing |
| No upstream | `not pulled: no upstream for <branch>` | 1 | Nothing |
| Cannot fetch | `fetch failed: …` (standard error) | 2 | Nothing |
| Not a Git repository | `not a git repository: <dir>` (standard error) | 2 | Nothing |

## Non-goals

- rebase / merge / stash (it does not break another session's work; it stops and gives the reason)
- Configuration, environment variables, options (a repository that wants a different default writes it in CLAUDE.md)
- An entry point under `scripts/setup/` (the policy decided 2026-10-06)
- Automating dependency updates, builds, or updates of the running code (promotion, restart)
