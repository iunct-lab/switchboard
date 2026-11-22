# Operations on the service that hosts the repository

Importing the backlog, sending edits, and reporting local CI results are split into "what to do" (the common operations) and "how to do it on that service" (the service implementations). The services are GitHub and GitLab (see "GitLab" below). The place to add one is named in "Adding a second service" below. We build no generic provider hierarchy, no registration-type plugins, and no per-runner (Claude / Codex / DAK) branching. PRs and reviews use each service's standard tools (GitHub uses gh; GitLab uses the kit's `mr`, see "MRs and reviews" below).

## Target (`ForgeTarget`)

`{ service, host, repository }`. The service is read from `forge` in the repository's `ops.config.json` (`ForgeConfig` in [`config.ts`](../../ops-kit/src/config.ts); it is read by `forgeOf` in [`forge.ts`](../../ops-kit/src/forge.ts)):

```json
"forge": { "service": "github" }
"forge": { "service": "gitlab", "host": "gitlab.example.com", "project": "group/sub/app" }
```

- For GitHub, the service implementation takes the host and repository from where it always did (the import uses `gh repo view` and `githubHost()`, sending uses the key of the stored source, and local CI uses the origin's `owner/name`). The only key allowed in a GitHub setting is `service`; any other key is invalid (we do not allow writing values that are never read)
- GitLab requires `host` (a name only; `https://`, a port, or a path is invalid) and `project` (the full path, subgroups included). `forgeTargetOf(dir, origin)` checks them against the host and path of the checkout's `origin` (case-insensitive), and if they differ it raises `ForgeUnsupported` and sends nothing. It does not change the remote
- A repository without `forge` is `github` (every repository before the forge split).
- A checkout with neither a `forge` nor an `origin` is `app` (`LOCAL_SERVICE`) for `forgeOf`: its changes are kept in the agent management app instead of PRs, and are reviewed, run, judged and merged there ([local-changes.md](local-changes.md)). A checkout with an origin is the same with `"forge": { "service": "app" }`. `forgeTargetOf` still reads a checkout without a `forge` as `github` (the backlog import reads it)
- This is separate from the workspace's runner settings (`projectVar` and so on). Where the repository lives is held by the repository
- It is also separate from where the backlog is kept (the workspace's `backlog`: `github` / `switchboard`). Even a workspace without the GitHub integration keeps its PR and CI reports on the `forge` service
- It holds no credentials. It relies on the login of each service's existing CLI (`gh` for GitHub, `glab` for GitLab). The Project URL is as before: `projectUrl` / `<envPrefix>_PROJECT_URL` / the repository variable

## Operations (`ForgeOperation`) and running them (`runForgeOperation`)

| Kind | What it does | GitHub implementation |
|---|---|---|
| `read` | Imports the service's Issues, comments, Project and PRs | `importGithubSnapshot` ([`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)) |
| `write` | Writes the fields of an Issue (title, body, state, labels, Milestone, parent) | `Sender.send` ([`backlog-send.ts`](../../packages/core/src/backlog-send.ts)) |
| `create` | Creates an Issue | Same as above |
| `comment` | Writes a comment (including an answer) | Same as above |
| `project` | Moves items in and out of the Project, and its fields | Same as above |
| `verification` | Reports the result of a check to the PR (local CI passing) | `githubForge` ([`forge-github.ts`](../../ops-kit/src/forge-github.ts), `gh pr comment`) |

`app` has `verification` only: the result becomes a comment on the change in the app (`appForge`, [`forge-app.ts`](../../ops-kit/src/forge-app.ts), one row of `reportResult`'s services). It goes the way `ops-kit backlog comment` goes and needs `BACKLOG_URL` and `BACKLOG_WORKSPACE`; without them it fails with the reason and is not sent any other way.

The kind of a pending send operation is decided by `forgeKind` (`backlog-send.ts`): `create` / `comment` stay as they are, Project items, `field:*` and `member` are `project`, and every other `set` is `write`.

`runForgeOperation(op, services)` calls the `op.kind` of the implementation for `op.target.service`. Before calling (`checkForgeOperation`):

- A service that is not supported, or a service without that operation, raises `ForgeUnsupported` (`サービス gitlab には対応していません（対応: github）`). It is never done another way instead. For an import this becomes the workspace's import failure (errors on the screen), for a pending send operation the operation is marked `failed` (with the reason, nothing is sent), and for local CI a failure of the report
- If the text to be sent (`op.texts`; for a pending send operation, `textsOf(payload)`) contains a value usable for authentication, it raises `ForgeRefused` (`findSecrets`; the kit also looks for the host's AWS names). Besides when an edit is saved (422), it checks again just before sending out (so operations that entered without passing the save check, such as ones restored from an old DB, are not sent either)

The service branching lives in this one place (the per-call `services` table), and we do not add `service === "github"` branches on the core or runner side.

## Adding a second service

1. Write its name (for example `gitlab`) in `forge.service` of `ops.config.json` (if the host or repository is read from the config, add it to `ForgeConfig` then and have the implementation read it)
2. Import: in the table of `BacklogSync`'s import in `backlog-sync.ts` (`runForgeOperation({ kind: "read" … }, { github: …, gitlab: … })`), add that service's `read` (the stored form is the record of `putBacklogSnapshot`; the `service` / `host` of the key are that service's)
3. Sending: in the `services` table of `sendGithubOperations` in `backlog-send.ts`, add `write` / `create` / `comment` / `project`. A kind that is not added is reported as unsupported and becomes `failed` (GitLab has not added `project`)
4. Local CI report: in the `reportResult` table of `scripts/local-ci.ts`, add `verification` (on the kit side, `forge-<service>.ts` next to `forge-github.ts`)
5. Stored type: add its value to `BacklogRepositoryKey.service` ([`model/backlog-records.ts`](../../packages/protocol/src/model/backlog-records.ts)) (the DB column already has `service`; `gitlab` has been added)

## GitLab

[`forge-gitlab.ts`](../../ops-kit/src/forge-gitlab.ts). The only channel is the `glab` the user has logged in to (`glab api --hostname <host> projects/<encoded full path>/…`, REST API v4). The kit neither bundles nor installs glab.

- Checking the login: `gitlabAuth` (`glab auth status --hostname <host>`). When not logged in or when glab is missing, it returns only `<host> の glab にログインしていません` and does not return glab's output (which may contain a token). The user does the login
- `gh` is never pointed at a GitLab host. The only thing a GitLab operation runs is `glab`
- The key of the stored data is `{ service: "gitlab", host, repository: <full path of the project> }`. The number is the `iid`, and the external id is the full id with its kind (`gitlab:issue:<id>` / `gitlab:note:<id>`). GitHub issue 12 and GitLab issue 12 are different records

### Import (`read`)

The `gitlab` entry of the `BacklogSync` import table (`importGitlabSnapshot` / `fetchGitlabSnapshot`, [`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)). The data stored in Switchboard is the source of truth, and GitLab is one of the sync targets (the enable / disable switch applies as it is; `syncsGithub` is wider than its name, covering every sync target that is neither `switchboard` nor disabled).

- Every time: all open Issues, and the closed ones updated at or after the cursor (the latest `updated_at` of the previous run; everything on the first run). Those with a `type:*` label (and those already stored) are stored
- Comments are the GitLab notes that are not `system`. They are re-read only when the Issue's `updated_at` has moved, and the ones that are gone become `unavailable`
- A stored open Issue that appears in neither list is read by its number: 404 → `unavailable`, 403 → `forbidden`
- The state is `opened` / `closed`. There is one way to close, so closed is `COMPLETED` (withdrawal (NOT_PLANNED) cannot be read from GitLab)
- Parent: GitLab CE has no sub-issues, so it is the `#N` on the first line of the `## 親 PBI` section of the body (if the section exists but has no number, there is no parent; if there is no section, the stored parent stays). The parent's `subIssues` are the Issues that have it as their parent
- No Project items are made. A GitLab board's columns are labels, so they show up as labels. Project fields such as Status, Priority and Story Points do not exist in GitLab (sending treats them as described in "Sending" below)
- The workspace's source is `{ …key, project: { owner: <path of the project>, number: 0 } }` (the GitHub Project is not read)
- A glab failure is `BacklogError` `GitLab（<host>）: glab api が失敗しました（HTTP <status>）`, shown on the screen as an import failure. glab's output is not shown as it is
- Rate-limit waits are per host. A GitHub wait does not stop a GitLab import (a GitLab 429 wait is held only by sending)
- An Issue that could be read from the list is saved again as readable, even if its values are the same, when it was 403 / 404 before

### Sending (`write` / `create` / `comment`)

The `gitlab` entry of the `services` table of `sendGithubOperations` (`GitlabSender`, [`backlog-send.ts`](../../packages/core/src/backlog-send.ts)). The shared pending-send table (`backlog_operations`) and the rules for order and holding stay as they are.

- set: title, body, state (`state_event` close / reopen), labels (`add_labels` / `remove_labels`), and Milestone (id from the title; none is `0`). It reads before sending and compares with the original values (if they differ, `conflict` and nothing is written), and reads again right after writing (if they differ, `conflict`). The check against GitHub's edit history is not read on GitLab, so another person's edit just before the write is detected only when the value differs from the one sent
- A parent set is `failed` (`GitLab には無いフィールドです（parent）。親は本文の ## 親 PBI で書きます`), and Project items and fields are `project` operations, which GitLab does not have, so they are `failed` (`サービス gitlab の project には対応していません`). Neither sends anything. The Project fields of a creation are not sent (the creation itself goes through)
- create / comment put the marker `<!-- switchboard-op:<id> -->` in the body. When the answer is lost (a 5xx after sending, or no connection), it becomes `unknown`, and the next send looks for the marker in the list (Issues by `created_after`, notes newest first). If it is not found after reading every page, it sends again with the same marker; if two or more marked ones exist, whether at the check or right after resending, the earlier-created one is kept and the later Issue is closed (the later note is deleted) (the same as GitHub's sender in [`backlog-send.ts`](../../packages/core/src/backlog-send.ts)). When the created Issue's id (`remoteId`) exists but is not in the list, it does not resend
- 401 is a wait for login (`Limit auth`), 429 is a 1-minute wait (`Limit`), failing to connect before sending (no HTTP status) is a 1-minute wait, 409 / 412 is `conflict`, other 4xx is `failed`, and 5xx is `pending` (up to the same number of times as GitHub). A creation or comment whose answer was lost stays `unknown` even if the read that looks for the marker fails
- Waits are per host (`source.host`). A GitHub wait does not stop a GitLab send

### MRs and reviews (`ops-kit mr`)

PRs and reviews use each service's standard tools (we build no MR or review screen or storage of our own). On GitLab, the branch uses the standard `git push`, and MRs and discussions go through `glab api`, used from the functions in [`forge-gitlab.ts`](../../ops-kit/src/forge-gitlab.ts) and the kit's `mr` entry point.

| Operation | GitLab API | GitHub equivalent |
|---|---|---|
| `mr create --source --target --title --body-file` | `POST merge_requests` | `gh pr create` |
| `mr view <iid>` (JSON: head / base sha, state, `detailed_merge_status`) | `GET merge_requests/:iid` | `gh pr view` |
| `mr discussions <iid>` (JSON: id, resolvable, resolved, position of the note (new and old path and line; for a removed line, the old one only)) | `GET merge_requests/:iid/discussions` (GitLab's own notes are excluded) | review threads |
| `mr note <iid> --body-file [--path --line]` | `POST merge_requests/:iid/discussions` (with `--path` / `--line`, the position at that line of the new file in the current diff. old_path is the original path of that file in the diff (different for a renamed file). A file not in the diff is not sent) | inline comment |
| `mr resolve <iid> <discussion id>…` | `PUT merge_requests/:iid/discussions/:id?resolved=true` | `ops-kit pr resolve-thread` |

- An MR's number is the `iid`, and a discussion's id is GitLab's 40-digit hexadecimal. They are not mixed with GitHub's PR numbers or `PRRT_` thread ids
- resolved means "every resolvable note is resolved". A discussion with no resolvable note (a summary comment) does not count as unresolved
- The title and body to be posted go through `findSecrets`, and on a hit nothing is sent (`ForgeRefused`)
- In a repository whose `forge` is not gitlab, `mr` does nothing and exits 2 (PRs use gh)
- The Approvals API, which CE does not have, is not assumed. The evidence of review is the discussions and notes

### Merge decision and reporting local CI

When `scripts/merge-gate.ts` has no `--repo` and the checkout's `forge` is gitlab, it reads that MR (the number is the `iid`) with `readGitlabPr` and decides with the same `judge` as GitHub (impact, `[聞く]`, `[再チェック]`, `[merge-answer]`). It reads only GitLab's standard API (it does not read approvals, which are paid).

| PrFacts | What is read on GitLab |
|---|---|
| `files` | The `+` / `-` line counts of the diffs in `merge_requests/:iid/diffs`. For a renamed file the original path is included too (a change that moves a file out of a protected path is counted as well). If GitLab omitted a diff (`too_large`), no decision is made (exit 2) |
| `headCommittedAt` | The latest `authored_date` in `commits` |
| `checks` | The head pipeline (the MR's `head_pipeline`). Only when its sha is the head. When there is none or it is stale, the `[local-ci] pass` at the current tips of the head and target branches |
| `unresolvedThreads` | Discussions that are resolvable and not resolved |
| `mergeState` | `detailed_merge_status`. `mergeable` = CLEAN; `ci_must_pass` / `ci_still_running` when counted by local CI = UNSTABLE; while it is computing (`checking` and so on), no decision is made (exit 2) |
| Markers (`[codex] review`, `[local-ci]`, `[recheck]`, `[merge-ask]` / `[merge-answer]`) | The MR's notes whose author's access level in the project is Developer (30) or higher |
| `designRulesTouched` | An MR that touched README.md counts as having touched them (GitLab does not read the sections; `[再チェック design-rules]`) |

- `--merge` has GitLab merge with `PUT merge_requests/:iid/merge`, adding the `sha` of the head that was judged (if the head has moved, GitLab refuses with 409). There is no `--merge-stack` (exit 2)
- Local CI (`bun scripts/local-ci.ts <iid>`) runs the MR in a GitLab checkout: the head is `refs/merge-requests/<iid>/head` (it stops if it differs from the MR's sha), and the base is the tip of the target branch. The result report (`verification`) is a note on the MR (the `gitlab` entry of the `reportResult` table)
- The secret check (`findSecrets`) also looks for GitLab tokens (the `gl…-` prefixes such as `glpat-`)

### Differences from GitHub, and what does not exist yet

| | GitHub | GitLab (CE / Free) |
|---|---|---|
| Project fields (Status, Priority, Story Points, and so on) | Project v2 | None. Kept only in the stored data (Switchboard), and sending is `failed` (visible as a difference) |
| Board | Project views | The standard board's columns are labels. They are read and written as labels |
| Parent / sub-issue | sub-issue | None. Read from the `## 親 PBI` section of the body. A parent set is not sent |
| Way of closing | COMPLETED / NOT_PLANNED / DUPLICATE | closed only (read as COMPLETED) |
| Check | Reads before and after, plus the edit history | Reads before and after only. Another person's edit just before the write is detected only when the value differs from the one sent |
| Approval | review approval | The paid Approvals are not assumed. Discussions and notes are the evidence |
| Merge | `gh pr merge --match-head-commit` / `gh stack merge` | `PUT …/merge` with the sha. There is no stack merge |
| Authentication | `gh` login | `glab` login (`gitlabAuth`; when it is missing, it says only `ログインしていません`) |

What is needed to start using a real GitLab (installing glab and logging in, starting an OSS GitLab, switching the Git remote) is compared in [`gitlab-adoption.md`](gitlab-adoption.md). The safety survey on whether it is acceptable to use (recent vulnerabilities, glab, least privilege for the token) is [`gitlab-security.md`](gitlab-security.md). Nothing is done here. Each of them happens only after the user confirms.

Current limits:

- The sync wording in the settings screen is still `GitHub 同期` (the enable / disable operation also applies to a GitLab source)
- The GitLab import is only the periodic re-read (webhook notifications are not read)

## While GitHub cannot be used, and coming back

A workspace whose Issues and PRs are GitHub's keeps working while GitHub cannot be used **for now**, and comes back without rewriting history. "For now" is the whole condition: the local path exists for failures that waiting mends, and for nothing else.

**What counts as "cannot be used for now"** (`outageOf` in `ops-kit/src/gh.ts`, one function):

| Observed | Counts | Why |
|---|---|---|
| The network did not answer, or the call timed out | Yes | Waiting mends it |
| GitHub answered 5xx | Yes | Waiting mends it |
| A rate limit GitHub gave an end for (a reset time, `Retry-After`, or a budget at 0 with its reset) | Yes | It ends at a known time |
| A rate limit with no end to read | No | Nothing to wait for |
| 401, 403, 404, a missing permission, an expired login | **No** | The token's or the configuration's: stop and report to the person. A token that may never read an endpoint (a 403 on every call) would otherwise switch work off GitHub while GitHub works |
| A refused input (422), a wrong argument | No | The request's own fault |

**Who decides.** The daemon, from what it observes itself — never a task's word, and never the output of a command a task chose. A local change that stands in for a pull request is made by `POST /api/backlog` with `change`, and for a GitHub workspace that route asks `githubOutage` (`packages/core/src/forge-outage.ts`): while the daemon's own sync stands in a wait for a limit or an outage, that is the observation; else the daemon makes one call of its own that costs no budget (`gh api rate_limit`) and classifies the answer with the table above. GitHub answering means 409 and no change, whatever the caller saw. `GET /api/backlog/outage?workspaceId=` answers the same question. A workspace that keeps its changes itself by design (no service behind its Issues) is not asked: its changes are made as before.

**Switching** (`scripts/forge-fallback.ts`). A task runs the `gh` command of its PR flow through it. When that command fails in a way that may be an outage, the script asks the app for a local change of the branch; the app makes it only on its own observation (above), and the script's reading of the one failed command decides nothing. A login or permission failure, a refused input and a wrong argument are gh's failure: nothing is asked, nothing is made. On a switch one line is written on the Task and on the PBI (kept by the app and sent when GitHub is back, like every backlog edit). It never goes back by itself. `ops-kit backlog create --head … --base …` reaches the same route and is held to the same condition.

**Where the change is kept.** Not among GitHub's Issues: in the workspace's records that have no service (`changeSourceOf` in `packages/core/src/backlog-gh.ts`), numbered from 1 there. Among GitHub's numbers it would take the number an Issue still waiting to be created gets when GitHub is back, and their comments would mix. The API and `ops-kit backlog` therefore name a change with a mark (`?change=1`, `--change`): the same number without it is GitHub's Issue or PR. Nothing of a change is ever queued for GitHub. A change carries the PR it stands in for (`pr`) and when its summary was left on GitHub (`reportedAt`).

**The gate is the same, and what it cannot read stops.** `merge-gate.ts --change`, `local-ci.ts --change` and `local-merge.ts` judge the change by the rules of a PR (the same `judge`), reading git and the app's stored records instead of GitHub. Every reason `judge` can give, and how the local path evaluates it:

| Reason of the gate | On the local path |
|---|---|
| Size over the limit; a protected path, a migration | The same, from git's diff of the branch against the base |
| The security groups (`[聞く]`, `[再チェック]`), `rescue`, the instruction files (asked as `instructions`), the responsibility file, the design rules of the README | The same kinds from the same file lists (git's diff, no rename guessing: both paths of a rename are judged) |
| `[再チェック <kind>]` lifted by a `[recheck] <kind> pass <head>` | The same, from the change's comments |
| `--allow-large` without the person's `[merge-answer] yes` of the head | Evaluated, and never lifted here: the yes is not kept on such a change — the kit's command refuses it and so does the app's route, both reading the text in the one form the gate reads (`markText`), so a leading space or a full-width bracket changes nothing. A change with an ask reason waits for GitHub |
| Files the Task's body does not name | The same, from the Task as last imported; the stop is recorded for the Task as a PR's is. A linked Issue that is not stored, or records that cannot be read, is no judgement (exit 2) |
| No CI check, or one not passed | A `[local-ci] pass` of the head and of the base's tip now (stricter than a PR: a base that moved runs it again) |
| Unresolved review threads | **Cannot be read, and nothing stored has them.** So the gate does not count them as none: it stops whenever a pull request of the branch exists or may exist — the PR the change was made with (`pr`), an open PR the stored records have for an Issue the change closes, or a branch that was pushed to origin (it has a remote-tracking ref). None of the three rests on the task having said so. Only a branch that never left the machine is merged locally |
| No main review newer than the last commit | The same, from the change's comments. A direct branch does not skip it here |
| The merge state (a conflict, a closed change) | `git merge-tree` against the base's tip; the change's own state |
| The base branch's protection on GitHub (`BLOCKED`) | Not visible to the gate. It does not need to be: `forge-resync.ts` never pushes to main, protected or not, so every commit that reaches GitHub's main goes in through a sync PR that the gate judges as a PR (and `BLOCKED` is read there, as for any PR) |
| Whose comments count as marks (`MARK_AUTHORS` on GitHub) | No author to tell apart: a change's comments are written through the app's API by the person and their tasks. This is the loopback trust the whole app rests on, not a check |

A reason whose data is not there is never a pass: it is a stop, or no judgement.

`local-merge.ts` judges again itself, and merges a GitHub workspace's change only while the app still sees GitHub out of use; once GitHub answers, the work goes on as a pull request.

**Where a local merge lands.** Not on `main`, and never in a work tree: on the landing ref `refs/switchboard/landed/main` (`packages/core/src/landing.ts`). The main work tree may be the checkout a running daemon reads; moving its files restarts a dev daemon and cuts the tasks it runs. So the fallback moves no work tree at all — updating the main work tree stays `ops-kit pull-main`, after the commits are on GitHub, the step that is the person's to allow where a dev daemon runs. Local work is based on the landing ref while it has commits `main` lacks (the app answers a change's base with it), and on `main` again once `main` has them. A workspace that keeps its changes itself by design is different on purpose: its checkout is where its code lives, and a merge fast-forwards its branch as before.

**A Task is closed when its code is on GitHub.** In a GitHub workspace the local merge closes the change, not the Tasks it closes: a close kept by the app would be sent as soon as GitHub is back, before the commits. `forge-resync.ts --report` closes them once GitHub's main has the merge commit.

**Coming back** (`scripts/forge-resync.ts`). First the local main is checked (`verifyLocal`): it must be GitHub's main plus only

- the commits a local merge that passed the gate recorded on its change (`[local-merge] merged <tip> base=<base>`, written by `local-merge.ts`), each range a straight line with no merge in it, and
- this script's own merges of GitHub's main: two parents, the second in GitHub's history, and exactly the tree git's own clean merge of the two gives.

A commit made on main by hand, a merge resolved or edited by hand, a record that cannot be read from the app: nothing is merged, nothing is pushed, the ref the local main is on and the commits are listed, and how they go in is the person's decision (through a PR, the gate judges them). The stop is not a dead end — a local merge whose `[local-merge]` record could not be written after it landed would otherwise stop every later run. The output names two commands the person runs in a terminal, each with the full sha of the tip it saw (a tip that moved since is refused): `bun scripts/forge-resync.ts --adopt-landing <tip>` accepts the unrecorded commits of that tip for this run and goes on as usual (the sync PR still applies), and `bun scripts/forge-resync.ts --drop-landing <tip>` deletes the landing ref `refs/switchboard/landed/main` (the branch `main` and GitHub's main are untouched; the output says how to put the ref back, and the app's changes stay recorded as merged, so what should still go in is made again). The script never runs either by itself, and both refuse to run without a terminal or inside a Task (`SWITCHBOARD_TASK_ID`). That is a check against a slip, not a boundary: a Task runs as the same user. Then:

| GitHub's main vs the local main | What happens |
|---|---|
| The same, or the local one behind | Nothing is sent |
| Only the local one moved | The same commit on the sync branch `sb/sync-main-<7>` and a PR to main (exit 5), merged with a Merge commit by `--merge-sync` only when the gate says merge |
| Both moved | GitHub's main is merged into the local main with a merge commit (made in a throwaway worktree), then that commit goes the same way: the sync branch and a PR. That combination was reviewed and tested by nobody as a whole, as after any two PRs merged one after the other; the gate judges the sync PR and the tag CI runs on the result |
| That merge conflicts | Nothing is pushed; a question on the PBI. A resolution made by hand goes in through a PR, not through this script |
| GitHub's main is protected or not | No difference: this script never reads the protection and never pushes to main. A direct push would be a change to main that no gate judged, so the sync PR is the only way in, with or without protection |
| GitHub is not reachable yet (the network, a 5xx, a limit) | Nothing changes (exit 4) |
| A login or permission failure | Nothing changes (exit 2): stop and report, it is not waited for |

- **No force push** (`--force`, `--force-with-lease`, a `+` refspec): it would drop the commits only GitHub's main has.
- **No rebase of the local main**: the release tags already cut and the version already promoted name commits by sha; a rebase would change them.
- **No release tag while away**: cutting one writes to GitHub.
- **No work tree moved**: a main that is checked out is left to `ops-kit pull-main`.

**The record** (`forge-resync.ts --report`), once per change after GitHub's main has its commit: one line saying what happened and the first lines of the change's marks (review, local CI, recheck, the local merge), as list items so that none of them counts as a mark of the PR. It goes on the PR the change stood in for — which is closed when GitHub did not take it as merged — or, when there never was a PR, on the Task the change closed (no PR is made after the fact). The Tasks the change closes are closed then. A change that stood in for a PR and was not merged locally is closed and summed up on that PR. `reportedAt` keeps it from being written twice; an answer lost between the comment and the mark is found by the summary's first line.

**What this does not guarantee.** All of it runs as the person's OS user on loopback: a task can call the same routes, write the same refs and the same database. The conditions above keep a mistaken or misled task from leaving GitHub's flow, from merging what the gate could not judge, and from sending what no gate judged; they are not a fence against a task that sets out to get around them.

How GitHub treats the PRs: a PR whose head sha reaches the base unchanged (a fast-forward) is marked MERGED by GitHub; one whose content reaches the base under a different sha (as after a rebase) stays OPEN; and a merge commit that contains the head (the sync PR's Merge commit) is MERGED. `--report` closes only the PRs that are still OPEN, with the summary, so every case is handled.

## Verification

- `ops-kit/src/forge.test.ts`: the target's service, host and repository are passed to the implementation as they are; unsupported services and operations; the secret check just before sending (AWS names too); `forgeOf`; `forgeTargetOf` (matching a GitLab origin); and GitHub's `verification` being the same `gh pr comment` as before
- `ops-kit/src/forge-gitlab.test.ts`: only glab is called, on the target's host; glab's output is not returned when not logged in
- `packages/core/src/backlog-stored.test.ts`, the test that a GitHub issue 12 and a GitLab issue 12 are two records
- `ops-kit/src/forge-gitlab.test.ts` "forge-gitlab read" (replay of [`gitlab-issues.json`](../../ops-kit/fixtures/gitlab-issues.json)), `packages/core/src/backlog-sync.test.ts` "a GitLab project is imported through glab"
- `packages/core/src/backlog-send-forge.test.ts` "forge operation": an operation containing a secret and an operation for another service are `failed` and write nothing to GitHub; `forgeKind`. The 4 "GitLab:" tests: the check against the original values and the read after writing, `failed` for a missing field, preventing a resend by the marker, and 401 / 429 / 4xx / 5xx
- `packages/core/src/backlog-sync.test.ts` "the import is the read of the repository's forge": a workspace with an unsupported `forge.service` is an import failure (with the reason) and does not ask GitHub
- `scripts/local-ci.test.ts` "forge verification", `ops-kit/src/config.test.ts` "forge" and "GitLab's forge"
- `scripts/forge-e2e.ts` (`env -u SWITCHBOARD_SUPERVISED bun scripts/forge-e2e.ts`): with a temporary DB, a local bare repo, a fake GitHub and a fake glab, it checks in sequence the separation of identical numbers, the import, edits on both sides and conflicts (GitLab and GitHub), the marker when the answer to a comment or creation is lost (GitLab and GitHub), from a git push through the MR, discussions and resolve, the merge stop on a stale-head pass and on an unresolved discussion, the note for the local CI result, the merge at the head that was judged, that after switching back to the GitHub setting the import reads GitHub and that checkout reads GitHub's records and does not delete GitLab's stored data, and that outbound connections are 0
- `ops-kit/src/gh.test.ts` "outageOf" and `packages/core/src/forge-outage.test.ts` (what counts as an outage, and the daemon's own observation); `packages/core/src/landing.test.ts` (the landing ref)
- `scripts/forge-fallback.test.ts` (the real daemon, a GitHub workspace, a gh that fails): the switch for an outage and for a limit with its end; no switch for an expired login, a missing permission, a refused input, or while the app sees GitHub answering; the local merge on the landing ref with the main work tree unmoved and the Task left open; no merge once GitHub is back; a `[merge-answer] yes` refused on the change in every spelling; and a known or possible PR stopping the merge. `scripts/merge-gate.test.ts` "github workspace" (each gate check on a change), `scripts/forge-resync.test.ts` (the checks before a push: an unrecorded commit, a hand-made merge, protection making no difference, a login failure; the landing ref; "report"), `packages/core/src/backlog-local.test.ts` "change in a github workspace"
