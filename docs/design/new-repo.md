# Starting a new repository (what is needed, and how much must be in place to start)

Written on 2026-10-17, from a request of 2026-10-13. When you start running a new repository with Switchboard's development assets (the common skills, `ops-kit`, the backlog screen, the merge judgement), this gathers in one place what you keep yourself, what Switchboard places, and what is a setting on the GitHub side. **The rules themselves are written in their sources of truth.** This document holds only links to the sources of truth and a one-line summary, and does not write the same rule in two places.


## The three layers

| Layer | What | Where it lives | Source of truth |
|---|---|---|---|
| A | The configuration `ops.config.json` (the Project URL, `envPrefix`, choices such as Area, required sections. The kit holds the Story Points scale) | The root of the repository | [ops-kit/README.md, Configuration in the consuming repository](../../ops-kit/README.md#configuration-in-the-consuming-repository-opsconfigjson) |
| A | The entry points of `scripts/setup/` (`lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh`. `bootstrap_project.sh` is only for the side that creates the Project) | `scripts/setup/` of the repository | [ops-kit/README.md, Entry points](../../ops-kit/README.md#entry-points-consuming-repository) |
| A | `CLAUDE.md` / `AGENTS.md` (values specific to that repository. Tests, working place and branch, live check, the OK for rollout, and so on) | The root of the repository | [issue-workflow](../../ops-kit/skills/issue-workflow/SKILL.md), `使う側のリポジトリが持つもの` (what the consumer repository holds) |
| A | Issue templates, PR templates, `labels.yml`, workflows (`labels.yml` / `ci.yml`), `.gitignore` | `.github/` of the repository and the root | [ops-kit/README.md, Templates](../../ops-kit/README.md#templates-new-repositories) |
| B | The 10 common skills (copied to `.claude/skills/<name>` and `.agents/skills/<name>` just before a Task's runner starts, and excluded from Git management with `info/exclude`) | Switchboard places them when a Task starts | [skill-sync.md How skills are placed](skill-sync.md#how-skills-are-placed) |
| B | The front of `gh` (keeping values that can authenticate out of Issues and PRs) and the scheduled scan | The head of the Task's `PATH` (`ops-kit/bin`) | [secret-guard.md Parts](secret-guard.md#parts) |
| B | Rereading for other repositories (the merge judgement, the parallel guard and the tagging with `--repo`, `otherRepoRules`) | Switchboard's scripts and the instructions of the stages | [releases-and-rescue.md Other repositories](releases-and-rescue.md#other-repositories) |
| B | The backlog screen (importing the values of Issues and the Project. `projectVar` per workspace) | Switchboard's daemon | |
| C | Issues, sub-issues, Milestones (the hierarchy request → PBI → Task) | GitHub | [issue-workflow](../../ops-kit/skills/issue-workflow/SKILL.md) |
| C | The Project and its fields (Area / Kind / Priority / Story Points, Status). Views cannot be made | GitHub (`bootstrap_project.sh` creates it) | `bootstrap` in [bootstrap.ts](../../ops-kit/src/bootstrap.ts) |
| C | The repository variable `<PREFIX>_PROJECT_URL` (the Project URL. The backlog screen and the scripts read it. `<PREFIX>` is `envPrefix`) | A GitHub repository variable (`gh variable set`) | [ops-kit/README.md, Configuration in the consuming repository](../../ops-kit/README.md#configuration-in-the-consuming-repository-opsconfigjson) |
| C | Actions: `labels.yml` (label sync) and `ci.yml`. `project-autoadd` (automatic addition to the Project) is optional (3 of "What stays manual"). The scan for authentication values is run over all registered repositories by the daemon's schedule (the kind `認証の値の検査`. The user creates it on the scheduled-tasks screen; it is not created on its own at startup), and `secret-scan.yml` in Actions is a backup outside the host (once a week; [secret-guard.md](secret-guard.md#scheduled-scan)) | GitHub Actions | [ops-kit/README.md, Templates](../../ops-kit/README.md#templates-new-repositories), [secret-guard.md Scheduled scan](secret-guard.md#scheduled-scan) |

Layer A is needed even without Switchboard (the repository holds it itself). Layer B takes effect only once a Task is started from Switchboard. Layer C is on the GitHub side, and some of it does not run while Actions does not start (`labels.yml` / `ci.yml`. The mechanisms for running without Actions are described in their own documents ([local-ci.md](local-ci.md) for running CI without Actions), and this writes only the state as of 2026-10-23).

## Differences by purpose

What differs by the purpose of the repository is what is written in these two items of `CLAUDE.md`. The other items (tests, working place and branch, how to write the live check, the merge judgement) are the same shape whatever the purpose.

| Purpose | Compatibility premise (the compatibility-layer item of `CLAUDE.md`) | The running real thing and the OK for rollout (the item `Task と動いているコード` of `CLAUDE.md`) |
|---|---|---|
| An app with no deadline (the user keeps using it) | Whether there is a user, and whether to put in a layer that reads the old format. Whether the data is moved once by a migration | The real thing is the user's environment. Rollout (restart, deployment) is done after getting the user's OK |
| Replacing or newly adding a backend | The period during which the old backend coexists, and whether there are external clients. The means of switching back | Do not touch the running old backend. Check on the new side's dev, and the switch to production needs the user's OK |
| A monitoring of its own | Not affecting the observed target (read-only or not). Compatibility of the shape of the stored data | A change while the monitoring runs needs a rollout procedure that causes no gap in the observations, and the OK for it |

A repository that does not use GitHub (no remote) is made not with `ops-kit/template/` but with the standalone `ops-kit/template-local/` (it has no `.github/` and no `scripts/setup/`, and writes filing, local CI, the merge judgement, merging and updating main in the same procedure as the Task's instruction text). The source of truth is this template and item 7 of the skill `.claude/skills/new-repo` (the procedure for making a new one, and how to copy to an existing repository made with the earlier template). The procedure is not copied here.

When a difference appears that does not fit these two columns, it is not added to the table; decide it for that repository and write it in that repository's own `CLAUDE.md`.

## What stays manual

What Switchboard's tools cannot place and a person does once.

1. **The two Project views**. The GitHub API cannot create a Project view (the note "Views cannot be made through the API" in `ops-kit/src/bootstrap.ts`). On the Project screen, create the view `Backlog` (filter `no:parent-issue`; requests and PBIs) and `Task Board` (filter `has:parent-issue`; Tasks). The fields are created by `bootstrap_project.sh`
2. **Creating labels while Actions does not start**. The `labels.yml` workflow syncs labels on a push to main, but while Actions does not run (a billing problem and the like) they are not synced. Then run `ops-kit sync-labels` (it reads `.github/labels.yml`, creates what is missing and fixes colors and descriptions; `--dry-run` shows the changes first). Inside a Switchboard Task, run it as `env -u BACKLOG_URL ops-kit sync-labels`
3. **The decision not to place the Project auto-add (`project-autoadd`)**. A workflow that automatically puts Issues into the Project needs a PAT with write permission to the Project to be registered and renewed. If you choose a setup that does not need that, do not place it. If you do not place it, put new Issues into the Project with `scripts/setup/triage_issue.sh` (an Issue created directly on the web screen does not go into the Project until you run it). If you place it, register the PAT in the repository secrets

## Conditions to start

The repository's Definition of Ready. When all of the following 6 pass, you may start `/pbi-complete` and the like in that repository. No script that checks the conditions is placed (this table is the source of truth. The form in which a runner runs the procedure is the skill named below, added 2026-10-21). `<PREFIX>` is the `envPrefix` of `ops.config.json`.

| Condition | Command | Expected result | Layer |
|---|---|---|---|
| The backlog rules | `bash scripts/setup/lint_backlog.sh` | The last line is `violations: 0`, exit 0 | A |
| The Project URL | `gh variable get <PREFIX>_PROJECT_URL -R <owner/name>` | `https://github.com/<orgs\|users>/<owner>/projects/<n>` | C |
| The backlog screen | `curl -s -H "Authorization: Bearer $(cat ~/.switchboard/token)" localhost:47831/api/backlog \| jq '{ws:[.items[].workspaceName]\|unique, errors}'` (the place of the token is in "Data lives in" of the README. Do not write the value) | `ws` holds the repository's workspace name, and `errors` (an array of `{ workspaceId, workspaceName, message }`) has no entry for that workspace (whatever the sentence in `message`. A failed import returns the saved values, so `ws` alone is not enough) | B |
| The skills | After starting one Task from that repository, `ls .claude/skills/*/.switchboard-skill .agents/skills/*/.switchboard-skill \| wc -l` | 20 (10 common skills × 2 places. For the marker, see [skill-sync.md](skill-sync.md#how-to-tell-the-copies-switchboard-placed)) | B |
| The merge judgement | In the first PR, `bun <switchboard>/scripts/merge-gate.ts <PR> --repo <owner/name>; echo $?` | 0 (merge) or 1 (stop). 2 (cannot judge) is not met | B |
| The 4 items of `CLAUDE.md` | `grep -nE '^## (テスト\|作業の場所\|.*live check\|.*動いているコード)' CLAUDE.md` | Each of the 4 items at least once: the 3 test commands (typecheck, all, one), the working place and branch, the live check, and the OK needed for rollout | A |

The procedure that carries out this table and "What stays manual" (what to decide → the GitHub side → the initial commit → registration → the start conditions → report) is Switchboard's own skill `.claude/skills/new-repo` (2026-10-21).

## Adding an existing repository

An entry for adding a repository that exists on GitHub to the Workspace by name alone (added 2026-10-25). A repository you cannot push to becomes "Other people's repositories" below. It is a route for users who cannot get into the host's shell, and you do not type a path.

- Entry: the `GitHub から` button of the `Workspace` card at the top of Settings. Enter `owner/name` or `https://github.com/owner/name` (a trailing `.git` and `/` are allowed) and press `追加`. The API is the `repo` of `POST /api/workspaces` (either this or `path`)
- Place: next to Switchboard's checkout (`<parent of repoRoot>/<name>`). There is no setting for the place (the same as when creating a new one)
- Inputs it refuses (400): a name starting with `-`, `.` / `..`, a URL other than github.com, and an extra `/`. The clone's arguments are passed as an array and do not go through the shell. If a directory of the same name already exists, 409 (it does not overwrite)
- Before the clone, it checks `permissions.push` of `gh api repos/<owner>/<name>`. If it cannot be read, 404, with no clone and no registration. If it cannot push, it is added as "Other people's repositories"
- Progress: the request returns 202 at once, and the clone proceeds in the background. What is in progress and failures (the last line of gh) appear in `GET /api/workspaces/clones`, and the screen rereads through `workspaces.updated` each time the state changes. On success it appears in the Workspace list. Progress is not saved, so a daemon restart erases it
- When it fails midway: the directory of a clone that stopped midway remains. The next add gives 409, so a person deletes it (when removing the registration, choosing `ローカルのコピーも消す` can delete it. See "Removing a registration" below)
- The mark `GitHub と連携しない` also works for `GitHub から`, and that workspace's backlog is kept in Switchboard
- The field for adding a directory on the host (`path`) is as before

### Other people's repositories

A repository you cannot push to is added as a workspace that creates nothing on GitHub and does not write (the source of truth is `packages/core/src/workspace-clone.ts` and `packages/core/src/runner-config.ts`).

- Shape: the clone's `origin` is renamed `upstream` (there is no `origin`), and the backlog is kept in Switchboard. The original `owner/name` is held in the workspace's `upstream`. PR to merge is the local `変更` (change) of a workspace with no `origin`
- Stopping writes: the clone gets the mark `git config ops-kit.noWrite <owner/name>`. The kit's tools and the front of gh stop Issues, PRs, comments, labels and edits to that target before they are posted. What it does not stop: operations the user does in the host's terminal or on GitHub's screen, and anything running as the same OS user changing git's configuration or the DB directly. `git push upstream` is refused by GitHub
- Confirming the runner's configuration: the targets are `RUNNER_CONFIG_PATHS`. The `Workspace` row of Settings shows the list and the content, and until `確認した` is pressed, no Task of that workspace starts by any route, whether manual, scheduled or by a stage. If the content changes, it is confirmed again (the confirmation is kept by the content's hash). The target of confirmation is the root of the clone; configuration in subdirectories and other worktrees are out of scope. What the repository's code after confirmation (build and test scripts) does is for the user to read and judge
- Taking in the original's updates: `元の更新を取り込む`, which appears on the row after confirmation, starts one Task that fetches `upstream` and takes it in. The procedure is only in the Task's instruction text, and the daemon does not touch git. If the take-in changes the configuration, the Task stops there and reports, and it is confirmed again before the next Task
- A copy to your own private repository is made separately after this shape

## Removing a registration (and deleting the local copy)

The `登録を外す` button on each repo's row of the `Workspace` card in Settings (added 2026-10-25). Whether the local copy is deleted too is chosen in the confirmation.

- The confirmation opens below the row: type the workspace's name (you cannot run it until it matches), `ローカルのコピーも消す` (not shown when it cannot be deleted), and one line of warning (when the copy is deleted: there are changes / there are commits not yet pushed. When there are running Tasks, their number). The API is `GET /api/workspaces/:id/removal` (the content of the confirmation) and `DELETE /api/workspaces/:id` (`{ deleteCopy }`). When it is gone, the row disappears on an open screen through `workspaces.updated`
- The copy can be deleted only if it is a Git checkout directly under the parent directory of Switchboard's checkout. The meta workspace, Switchboard itself, a path that goes outside by a symbolic link, and a nested one are 400, and a directory that is not Git is 409 (only the registration can be removed)
- Refused (409): a Task running or waiting in that workspace or a directory under it (running, waiting; shadow included), and a schedule that uses that workspace. The history of finished Tasks remains
- The backlog's saved data is deleted only when no other workspace points to the same repository (a backlog kept only in Switchboard disappears when you remove it). After removing it, the same path can be registered again
- The GitHub side (the repository, the Project, the variables) is not deleted. A person does that on GitHub
