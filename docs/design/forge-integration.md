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
5. Stored type: add its value to `BacklogRepositoryKey.service` ([`model.ts`](../../packages/protocol/src/model.ts)) (the DB column already has `service`; `gitlab` has been added)

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

## Verification

- `ops-kit/src/forge.test.ts`: the target's service, host and repository are passed to the implementation as they are; unsupported services and operations; the secret check just before sending (AWS names too); `forgeOf`; `forgeTargetOf` (matching a GitLab origin); and GitHub's `verification` being the same `gh pr comment` as before
- `ops-kit/src/forge-gitlab.test.ts`: only glab is called, on the target's host; glab's output is not returned when not logged in
- `packages/core/src/backlog-stored.test.ts`, the test that a GitHub issue 12 and a GitLab issue 12 are two records
- `ops-kit/src/forge-gitlab.test.ts` "forge-gitlab read" (replay of [`gitlab-issues.json`](../../ops-kit/fixtures/gitlab-issues.json)), `packages/core/src/backlog-sync.test.ts` "a GitLab project is imported through glab"
- `packages/core/src/backlog-send.test.ts` "forge operation": an operation containing a secret and an operation for another service are `failed` and write nothing to GitHub; `forgeKind`. The 4 "GitLab:" tests: the check against the original values and the read after writing, `failed` for a missing field, preventing a resend by the marker, and 401 / 429 / 4xx / 5xx
- `packages/core/src/backlog-sync.test.ts` "the import is the read of the repository's forge": a workspace with an unsupported `forge.service` is an import failure (with the reason) and does not ask GitHub
- `scripts/local-ci.test.ts` "forge verification", `ops-kit/src/config.test.ts` "forge" and "GitLab's forge"
- `scripts/forge-e2e.ts` (`env -u SWITCHBOARD_SUPERVISED bun scripts/forge-e2e.ts`): with a temporary DB, a local bare repo, a fake GitHub and a fake glab, it checks in sequence the separation of identical numbers, the import, edits on both sides and conflicts (GitLab and GitHub), the marker when the answer to a comment or creation is lost (GitLab and GitHub), from a git push through the MR, discussions and resolve, the merge stop on a stale-head pass and on an unresolved discussion, the note for the local CI result, the merge at the head that was judged, that after switching back to the GitHub setting the import reads GitHub and that checkout reads GitHub's records and does not delete GitLab's stored data, and that outbound connections are 0
