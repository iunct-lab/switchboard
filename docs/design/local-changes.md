# Local changes: review and merge without a forge

A workspace whose backlog is kept in Switchboard only, and whose repository has no remote, can still go from a request
to a merge into `main`: a Task's branch becomes a *change* kept in Switchboard instead of a pull request, another runner
reviews it, the local CI and the merge gate judge it by the same rules as a PR, and a script merges it the way GitHub's
Rebase and merge does. Nothing calls GitHub, fetches or pushes.

## Which workspaces

- The backlog is kept here (the workspace's `backlog` is `switchboard`), and
- the kit's `forgeOf` (`ops-kit/src/forge.ts`) names the app's own service, `app` (`LOCAL_SERVICE`): the checkout has
  neither a `forge` in `ops.config.json` nor an `origin`, or its `forge` says `{ "service": "app" }`.

The stage prompts of such a workspace (`buildStartPrompt`'s `localForge`, `packages/core/src/backlog.ts`) tell the Task
to use changes instead of PRs, and each delivery skill has a 「ローカルの変更では」 paragraph next to the step it replaces.
A workspace with a remote keeps its PRs.

## The change

A change is a stored backlog Issue with a `change` field: `{ head, base, mergeCommit, mergedAt }`, `head` and `base`
being branch names. It is numbered with the Issues, as GitHub numbers pull requests. There is no new table or
endpoint:

| What | How |
|---|---|
| Make one | `POST /api/backlog` with `change: { head, base }` (`ops-kit backlog create --head <branch> --base main`). Refused on a workspace that syncs with GitHub (422), when a branch is not in the checkout (422), when `head` is `base` (422), or when the same `head` already has an open change (409) |
| Read one | `GET /api/backlog/:number`: the Issue, its comments oldest first, and `changeRefs` — the branches' tips read by `git rev-parse` at each read (they are never stored: they move with every commit) |
| List them | `GET /api/backlog`'s `changes`: every open one, and each workspace's newest 10 closed |
| Comment | `POST /api/backlog/:number/comment` (`ops-kit backlog comment`): the review summary, the triage table, and the marks |
| Merge | `PATCH /api/backlog/:number` with `state: "CLOSED"` and `change: { mergeCommit, mergedAt }` (only together). A closed change is not opened again: make a new one |

The Backlog screen shows a 変更 section when a change is open (the closed ones are folded). A row opens in place with
the tips, the marks (the newest main review, the newest local CI result, the rechecks of the head; whether they count
is the merge gate's), the body and every comment (`apps/web/src/changes.ts`).

## Review

As for a PR, another runner reviews (`cross-runner-review`), with a worktree of the branch instead of a clone,
`git diff main...<branch>` as the diff and `ops-kit backlog view <change>` as the description. The summary is one
comment whose first line is `[<runner>] review`. There are no review threads: the triage of each finding and its reply go
in one comment as a table.

## Local CI

`bun scripts/local-ci.ts --change <n>` runs the same steps as for a PR: the head merged into the base's tip in a
throwaway worktree. The result's first line is the same `[local-ci] pass|fail <head> base=<base>`, posted as a comment
on the change through the `app` row of `reportResult`'s services (`ops-kit/src/forge-app.ts`). It re-reads the change
before posting and posts nothing if a branch moved. A pass of the same head and base is not run again (`--force`).

## Merge gate

`bun scripts/merge-gate.ts --change <n>` judges with the same `judge` as a PR. Only the facts are read differently
(`readChange`): files and lines from `git diff --numstat`, the newest author date from `git log`, conflicts from
`git merge-tree`, the marks from the change's comments, no threads. A local CI pass counts only for the current head
**and** the base's current tip: there is no tag CI after a local merge to catch two changes that break together. Large
changes stop as for a PR: `[再チェック <kind>]` is lifted by a `[recheck] <kind> pass <head>` comment on the change,
and `[聞く]` (the gate scripts themselves) waits for the person.

## Merge

`bun scripts/local-merge.ts <n>` judges again, then rebases the branch onto the base's tip in a throwaway worktree (no
merge commit, author dates kept), fast-forwards the base (only from the tip it judged; a dirty worktree of the base
stops it), deletes the branch (only at the head it judged), closes the change with its merge commit and closes the
Tasks it names (`Backlog-Task: n`, `Closes #n`, the branch `sb/<n>-`). Anything that stops before the base moves
changes nothing. After that, what is left is reported and the base stays.

## End to end

`bun scripts/local-change-e2e.ts` runs all of the above on a fake-runner daemon in a temporary directory: a request, a
PBI and its Task, the stage prompt, a branch with two commits, the change and its review, then `local-ci.ts`,
`merge-gate.ts` and `local-merge.ts` as child processes with a `gh` on PATH that fails if called. It prints each stage
and `ok`. `SCREENSHOT=<file.png>` (after `bun run --cwd apps/web build`, with Chrome) also saves the Backlog screen with
the change opened. The check with a real runner is the person's.

## Out of scope

- Stacked branches: one branch at a time, merged before the next is cut from `main`.
- Moving a workspace's changes to GitHub when its sync is turned on.
- Several people and permissions: one user.
