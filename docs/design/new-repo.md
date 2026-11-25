# Starting a new repository (what is needed, and how much must be in place to start)

Written on 2026-10-17, from a request of 2026-10-13. When you start running a new repository with Switchboard's development assets (the common skills, `ops-kit`, the backlog screen, the merge judgement), this gathers in one place what you keep yourself, what Switchboard places, and what is a setting on the GitHub side. **The rules themselves are written in their sources of truth.** This document holds only links to the sources of truth and a one-line summary, and does not write the same rule in two places.


## The three layers

| Layer | What | Where it lives | Source of truth |
|---|---|---|---|
| A | The configuration `ops.config.json` (the Project URL, `envPrefix`, the Priority choices, required sections. The kit holds the Story Points scale) | The root of the repository | [ops-kit/README.md, Configuration in the consuming repository](../../ops-kit/README.md#configuration-in-the-consuming-repository-opsconfigjson) |
| A | The entry points of `scripts/setup/` (`lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh`. `bootstrap_project.sh` is only for the side that creates the Project) | `scripts/setup/` of the repository | [ops-kit/README.md, Entry points](../../ops-kit/README.md#entry-points-consuming-repository) |
| A | `CLAUDE.md` / `AGENTS.md` (values specific to that repository. Tests, working place and branch, live check, the OK for rollout, and so on) | The root of the repository | [issue-workflow](../../ops-kit/skills/issue-workflow/SKILL.md), `使う側のリポジトリが持つもの` (what the consumer repository holds) |
| A | Issue templates, PR templates, `labels.yml`, workflows (`labels.yml` / `ci.yml`), `.gitignore` | `.github/` of the repository and the root | [ops-kit/README.md, Templates](../../ops-kit/README.md#templates-new-repositories) |
| B | The 11 common skills (copied to `.claude/skills/<name>` and `.agents/skills/<name>` just before a Task's runner starts, and excluded from Git management with `info/exclude`) | Switchboard places them when a Task starts | [skill-sync.md How skills are placed](skill-sync.md#how-skills-are-placed) |
| B | The front of `gh` (keeping values that can authenticate out of Issues and PRs) and the scheduled scan | The head of the Task's `PATH` (`ops-kit/bin`) | [secret-guard.md Parts](secret-guard.md#parts) |
| B | Rereading for other repositories (the merge judgement, the parallel guard and the tagging with `--repo`, `otherRepoRules`) | Switchboard's scripts and the instructions of the stages | [releases-and-rescue.md Other repositories](releases-and-rescue.md#other-repositories) |
| B | The backlog screen (importing the values of Issues and the Project. `projectVar` per workspace) | Switchboard's daemon | |
| C | Issues, sub-issues, Milestones (the hierarchy request → PBI → Task) | GitHub | [issue-workflow](../../ops-kit/skills/issue-workflow/SKILL.md) |
| C | The Project and its fields (Priority / Story Points, Status). Views cannot be made | GitHub (`bootstrap_project.sh` creates it) | `bootstrap` in [bootstrap.ts](../../ops-kit/src/bootstrap.ts) |
| C | The repository variable `<PREFIX>_PROJECT_URL` (the Project URL. The backlog screen and the scripts read it. `<PREFIX>` is `envPrefix`) | A GitHub repository variable (`gh variable set`) | [ops-kit/README.md, Configuration in the consuming repository](../../ops-kit/README.md#configuration-in-the-consuming-repository-opsconfigjson) |
| C | Actions: `labels.yml` (label sync) and `ci.yml`. `project-autoadd` (automatic addition to the Project) is optional (3 of "What stays manual"). The scan for authentication values is run over all registered repositories by the daemon's schedule (the kind `認証の値の検査`. The daemon adds it once, enabled, at the first start of an instance with no enabled one — `docs/design/secret-guard.md`, "Scheduled scan"; it also reads the public copy named by `publicSync.target`), and `secret-scan.yml` in Actions is a backup outside the machine (once a week; [secret-guard.md](secret-guard.md#scheduled-scan)) | GitHub Actions | [ops-kit/README.md, Templates](../../ops-kit/README.md#templates-new-repositories), [secret-guard.md Scheduled scan](secret-guard.md#scheduled-scan) |

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
| The backlog rules | `bash scripts/setup/lint_backlog.sh` | The last line is `violations: 0`, exit 0. The adoption adds no `scripts/setup/`: in an adopted repository, run `ops-kit lint --fresh` with `GH_REPO=<owner/name>` — in a checkout that has its `ops.config.json`, or, when its settings are kept on Switchboard's side, in its folder with `OPS_KIT_CONFIG=<the workspace's settings file>` (no checkout with committed settings is needed) — and do not count the Issues from before the adoption (the adoption section below) | A |
| The Project URL | `gh variable get <PREFIX>_PROJECT_URL -R <owner/name>` | `https://github.com/<orgs\|users>/<owner>/projects/<n>` | C |
| The backlog screen | `curl -s -H "Authorization: Bearer $(cat ~/.switchboard/token)" localhost:47831/api/backlog \| jq '{ws:[.items[].workspaceName]\|unique, errors}'` (the place of the token is in "Data lives in" of the README. Do not write the value) | `ws` holds the repository's workspace name, and `errors` (an array of `{ workspaceId, workspaceName, message }`) has no entry for that workspace (whatever the sentence in `message`. A failed import returns the saved values, so `ws` alone is not enough) | B |
| The skills | After starting one Task from that repository, `ls .claude/skills/*/.switchboard-skill .agents/skills/*/.switchboard-skill \| wc -l` | 22 (11 common skills × 2 places. For the marker, see [skill-sync.md](skill-sync.md#how-to-tell-the-copies-switchboard-placed)) | B |
| The merge judgement | In the first PR, `bun <switchboard>/scripts/merge-gate.ts <PR> --repo <owner/name>; echo $?` | 0 (merge) or 1 (stop). 2 (cannot judge) is not met | B |
| The 4 items of `CLAUDE.md` | `grep -nE '^## (テスト\|作業の場所\|.*live check\|.*動いているコード)' CLAUDE.md` | Each of the 4 items at least once: the 3 test commands (typecheck, all, one), the working place and branch, the live check, and the OK needed for rollout | A |

In a repository that uses no GitHub (`template-local`), the table is read this way: The Project URL and the Project-derived import of The backlog screen do not apply; The merge judgement is checked on the first change with `merge-gate.ts --change <change>`; The backlog rules run as `env -u GH_REPO BACKLOG_WORKSPACE=<workspace id> ops-kit lint --fresh` from the repository's folder and end with `violations: 0`. The graduation of `p2-baseline` follows this paragraph in such a repository.

The procedure that carries out this table and "What stays manual" (what to decide → the GitHub side → the initial commit → registration → the start conditions → report) is Switchboard's own skill `.claude/skills/new-repo` (2026-10-21).

## After the repository is made: the baseline

The conditions to start say when a repository is ready to run on requests. A new repository usually has nothing to run on yet: before the loop of requests, PBIs and Tasks is worth its cost, there is a first baseline to build from an idea. That is the process candidate `p2-baseline` (`ops-kit/processes/p2-baseline.md`, and [process-kernel.md](process-kernel.md) for what it relaxes and what it keeps). One Task takes a concept text, writes `docs/concept.md` in the repository with a roadmap, asks the decisions at once, builds the roadmap one pull request per item and, on graduation, runs the conditions to start above, files what is left as requests and hands the repository to the usual flow. It starts from Settings: the `立ち上げ` button on the repository's row of the `Workspace` card takes the concept text and starts that Task in the repository's workspace (the Task's provenance records `p2-baseline` and the reason `baseline button`). Pressed again after the graduation, the Task builds nothing: it answers that the repository has graduated and that a new idea goes in as a request. Without a concept, the next step after creating the repository is `request-to-backlog`.

## Adding an existing repository

An entry for adding a repository that exists on GitHub to the Workspace by name alone (added 2026-10-25). A repository you cannot push to becomes "Other people's repositories" below. It is a route for users who cannot get into the machine's shell, and you do not type a path.

- Entry: the `GitHub から` button of the `Workspace` card at the top of Settings. Enter `owner/name` or `https://github.com/owner/name` (a trailing `.git` and `/` are allowed) and press `追加`. The API is the `repo` of `POST /api/workspaces` (either this or `path`)
- Place: next to Switchboard's checkout (`<parent of repoRoot>/<name>`). There is no setting for the place (the same as when creating a new one)
- Inputs it refuses (400): a name starting with `-`, `.` / `..`, a URL other than github.com, and an extra `/`. The clone's arguments are passed as an array and do not go through the shell. If a directory of the same name already exists, 409 (it does not overwrite)
- Before the clone, it checks `permissions.push` of `gh api repos/<owner>/<name>`. If it cannot be read, 404, with no clone and no registration. If it cannot push, it is added as "Other people's repositories"
- Progress: the request returns 202 at once, and the clone proceeds in the background. What is in progress and failures (the last line of gh) appear in `GET /api/workspaces/clones`, and the screen rereads through `workspaces.updated` each time the state changes. On success it appears in the Workspace list. Progress is not saved, so a daemon restart erases it
- When it fails midway: the directory of a clone that stopped midway remains. The next add gives 409, so a person deletes it (when removing the registration, choosing `ローカルのコピーも消す` can delete it. See "Removing a registration" below)
- The mark `GitHub と連携しない` also works for `GitHub から`, and that workspace's backlog is kept in Switchboard
- The field for adding a directory on the machine (`path`) is as before

### Other people's repositories

A repository you cannot push to is added as a workspace that creates nothing on GitHub and does not write (the source of truth is `packages/core/src/workspace-clone.ts` and `packages/core/src/runner-config.ts`).

- Shape: the clone's `origin` is renamed `upstream` (there is no `origin`), and the backlog is kept in Switchboard. The original `owner/name` is held in the workspace's `upstream`. PR to merge is the local `変更` (change) of a workspace with no `origin`
- Stopping writes: the clone gets the mark `git config ops-kit.noWrite <owner/name>`. The kit's tools and the front of gh stop Issues, PRs, comments, labels and edits to that target before they are posted. What it does not stop: operations the user does in the machine's terminal or on GitHub's screen, and anything running as the same OS user changing git's configuration or the DB directly. `git push upstream` is refused by GitHub
- Confirming the runner's configuration: the targets are `RUNNER_CONFIG_PATHS`. The `Workspace` row of Settings shows the list and the content, and until `確認した` is pressed, no Task of that workspace starts by any route, whether manual, scheduled or by a stage. If the content changes, it is confirmed again (the confirmation is kept by the content's hash). The target of confirmation is the root of the clone; configuration in subdirectories and other worktrees are out of scope. What the repository's code after confirmation (build and test scripts) does is for the user to read and judge
- Taking in the original's updates: `元の更新を取り込む`, which appears on the row after confirmation, starts one Task that fetches `upstream` and takes it in. The procedure is only in the Task's instruction text, and the daemon does not touch git. If the take-in changes the configuration, the Task stops there and reports, and it is confirmed again before the next Task
- Copy under your name: the mark `自分の GitHub に非公開のリポジトリを作る` under the `GitHub から` field (the API is `ownCopy: true` next to `repo`). It is always shown, because whether the repository is yours is not known before it is added; on a repository you can push to, the API refuses it with its reason (400) and the screen shows that reason. The mark is put back after an add. When the mark is on, a destination field appears (the API is `ownCopyOwner`): empty means your own account, and an org name creates the copy there. For an org, the daemon first checks that you are an active member and may create private repositories there (an admin, or the org allows members to; GitHub shows that setting to owners only, so when a member cannot read it the daemon goes on and a create that fails is reported as for your own account), and when you cannot, or `<owner>/<name>` already exists, it refuses with the reason and creates, clones and pushes nothing

Two shapes, chosen by the mark:

| | Without the mark (shape above) | With the mark |
|---|---|---|
| Created on GitHub | nothing | a private `<owner>/<name>` (`<owner>` is you, or the org typed in the destination field), with every branch and tag pushed to it |
| Backlog | kept in Switchboard | on GitHub, in the copy (as for your own repository); kept in Switchboard when `GitHub と連携しない` is also checked |
| From pull request to merge | the local `変更` (change); no `origin` | a pull request in the copy, merged there |
| Writes to the original | none (stopped by `ops-kit.noWrite`) | none (the same mark stays; the original is `upstream`) |

Choose the mark when the work in progress should also be on your own GitHub (Issues, pull requests, a place to push); type an org in the destination field when the copy belongs to that org. Without it, nothing leaves the machine and nothing is created on GitHub. `bun scripts/foreign-repo-e2e.ts` and `bun scripts/foreign-repo-e2e.ts --own-copy` run both shapes against a fake `gh`; each ends with `upstream writes: 0`.

## Adopting an existing repository's rules

An existing repository of your own comes with its own rules: its `CLAUDE.md` / `AGENTS.md`, its Issue templates and labels, its Project, its branch, commit and review habits, and the thinking behind them. Adding it as a workspace (above) only clones and registers it. Taking it into Switchboard's development flow is a separate step, and that step does not replace the repository's rules with Switchboard's. It sorts them into three kinds of rule (a table of its own, not the three layers at the top of this document):

| Kind | What is in it | What the adoption does |
|---|---|---|
| 1. The repository's own | The code and its design ideas; its test layers and commands; its branch, commit and pull-request habits; its review rules (CODEOWNERS, required reviews); its Issue and pull-request templates; the existing text of `CLAUDE.md`, `AGENTS.md`, `README.md` and `CONTRIBUTING.md`, including what the repository says belongs in them; its existing labels and Project fields (areas, epics, phases and the like); its existing Issues | Leaves them as they are. Tasks follow them (the skills already say that the repository's `CLAUDE.md` wins over a skill). The kit's own Issue templates are not added: Tasks file Issues through `ops-kit backlog` |
| 2. Switchboard's contract, added and never replacing | What the daemon, the kit and the scripts read by name or value: the labels `type:request` / `type:pbi` / `type:task` and the kit's other labels (`needs-decision`, `on-hold`, …), the Project's Status choices (Backlog / Ready / In progress / In review / Done), Priority and Story Points with the kit's scale, `ops.config.json` and the Project variable, the `sb/` prefix of a Task's branch, the marks the merge gate reads on a pull request (a main review, local CI results), and an `AGENTS.md` that points to `CLAUDE.md` (a Codex Task reads only `AGENTS.md`) | Adds what is missing. A name that exists with a different meaning is a conflict and is asked about, not overwritten. Where the repository's people work differently (another branch form, no Story Points), their rule stays for their own work and Switchboard's Tasks follow this kind; the adopted rules (below) say so in one line. An existing Project's Status choices are never replaced (replacing them through the API clears every item's Status); when they differ, a separate Project for Switchboard is the default |
| 3. Switchboard's defaults, which the repository may override | Rules of care in the skills whose value the repository's `CLAUDE.md` or its adopted rules (below) give: the closed PBIs used as the Story Points reference, stacked pull requests or one at a time, the worktree place, the live check and who approves a rollout (the test commands are the repository's own, the first kind) | Where the repository has its own rule, its rule wins, and the difference is written as one line in the adopted rules (below) |

The text of `CLAUDE.md` cannot change the second kind: the daemon reads those names whatever a sentence says. The values `ops.config.json` holds (the required sections, for one) are changed there; the Priority choices stay the kit's P0 to P3, which the daemon ranks by name, and an original Project with other Priority choices is a conflict.

Existing Issues are not rewritten, relabelled or closed, and a Task does not carry one forward as it is. Those without a `type:*` label do not appear on the backlog screen. One you choose for Switchboard to carry is filed as a new request with `request-to-backlog`, its source pointing at the original Issue, which stays open. Choosing means naming the Issue's number in the Task's conversation or in a request's text: a stage Task gets the same instruction from a button and from the backlog's automatic processing and cannot tell which one started it, so a Task that is handed an Issue from before the adoption makes nothing and says so in its report. Because the existing Issues are not rewritten, `ops-kit lint` violations on Issues from before the adoption are not counted, in the conditions to start or in any later check; the adoption writes this, with the highest Issue number at that time, as one line in the adopted rules (below), where later Tasks read it.

The adopted rules are what the adoption worked out: the values the repository's `CLAUDE.md` lacks, where its own rule wins, and how a Task treats a rule that differs from the contract. They do not have to go into the repository's Git, and neither do the settings the tools read (the next section).

The adoption asks two things, and they are separate choices, made in the adoption Task's conversation:

- **Where the settings are kept** (the adopted rules, and the settings in the shape of `ops.config.json`). The default is Switchboard's side: the rules are kept in Switchboard's database as that workspace's rules and added to the first prompt of every Task started in that workspace, and the settings are kept the same way (the next section); nothing is written to the repository's work tree, branches or remote, and the rules' text has no effect outside Switchboard. The kept text and settings can be read and corrected in Settings, in folded parts under that workspace's row (saving one empty removes it). The other place is the repository itself, by a pull request that only adds (`ops.config.json`, one section of `CLAUDE.md`, one line of `AGENTS.md`).
- **Where the backlog is kept** (requests, PBIs, Tasks): GitHub's Issues and Project, or Switchboard. With GitHub, the adoption adds the missing labels and the Project on GitHub, whichever place the settings have; with Switchboard, nothing is written to GitHub.

So "nothing committed to the repository" does not mean giving up a backlog on GitHub. What each of the four combinations writes:

| Settings | Backlog | Written to Switchboard | Written to GitHub | Written to the repository's Git |
|---|---|---|---|---|
| Switchboard's side | GitHub | the rules, the settings, the workspace's Project variable name | labels (missing names only), the Project, the repository variable | nothing |
| Switchboard's side | Switchboard | the rules, the settings | nothing | nothing |
| the repository (a pull request) | GitHub | the workspace's Project variable name | labels (missing names only), the Project, the repository variable, the pull request | `ops.config.json`, one section of `CLAUDE.md`, one line of `AGENTS.md` |
| the repository (a pull request) | Switchboard | nothing | the pull request | the same |

A checkout without a remote has no pull request, so its settings are kept on Switchboard's side; a repository that is not on GitHub keeps its backlog in Switchboard. Where the conditions to start read `ops.config.json` or the sections of `CLAUDE.md`, a repository whose settings are on Switchboard's side is checked against those settings (the kit's default configuration when none are kept) and its adopted rules instead, and the conditions that read GitHub do not apply to a backlog kept in Switchboard: "The Project URL", and "The merge judgement" where the workspace has no pull requests.

The procedure (the diagnosis, the table of the three kinds, asking about conflicts and the two places, placing the rules and the settings on Switchboard's side or by the pull request that only adds, the conditions to start, the report) is Switchboard's own skill `.claude/skills/adopt-repo`. It is not copied here.

## Settings kept on Switchboard's side

A repository does not have to hold a file for Switchboard's sake. Each workspace of your own can have settings kept by Switchboard, in the same shape as `ops.config.json`: the local CI's steps (`ci.steps`), the backlog's fields and required sections, the Project's URL, the merge gate, the forge, the shared files. They are saved in Switchboard's database (Settings, the folded part `設定（Switchboard の側）` under the workspace's row, or `PUT /api/workspaces/:id/config`), and the daemon writes them to a file under its home (`workspace-config/<workspace id>/ops.config.json`, with an index of the workspaces beside it) so that the tools read them as they read a repository's file.

Which settings a checkout is run with is one rule for every reader — the kit's commands, the local CI and the tag CI, the daemon's backlog edits and the skills' conditions:

1. the checkout's own `ops.config.json`, when it has one;
2. else the settings kept for its workspace;
3. else none (the kit's template where a reader has a default).

It is a file as a whole, never mixed key by key: a repository whose file leaves a key out does not take that key from the kept settings. For the local CI's steps this gives the order "the repository's `ci.steps`, the workspace's `ci.steps`, `.github/workflows/ci.yml`". Nothing existing changes: a repository that already commits its `ops.config.json` is run with it as before, and removing that file is the owner's choice per repository.

The kit knows nothing of workspaces. It is handed the place of a settings file and nothing else: the environment variable `OPS_KIT_CONFIG`, read only when no `ops.config.json` is found from the working folder up. The app sets it for the workspace's Tasks and for the jobs it runs for them; outside a Task, pass the file's path (Settings shows it) the same way, or `--config`. Switchboard's own scripts (`scripts/local-ci.ts`, `scripts/tag-ci.ts`) also find the file by the clone's folder in the daemon's index, so `bun scripts/local-ci.ts <PR> --repo <owner/name>` run by hand reads the same steps as the job a Task asks for.

### Who changes the settings, and when a change is in force

The settings hold what the local CI runs (`ci.steps`, shell that runs as the Switchboard OS user) and what the merge gate is (`mergeGate`). In a repository a change of those is a pull request, and the merge gate asks the owner about it. The copy kept by Switchboard is held to the same rule:

- **Every change is recorded.** The table `workspace_config_changes` keeps, per request: when, how it came in (`person` = the login cookie with a fresh passkey check; `screen` = a request that looks like the web page's; `call` = any other call, a Task's or a script's), the settings before, the settings asked for, the top-level keys that differ, and what became of it (`pending`, `confirmed`, `rejected`, `superseded`). `GET /api/workspaces/:id/config/changes` reads it.
- **A change of a key the gates read waits for the owner.** Every key except the backlog's form (`projectUrl`, `owner`, `envPrefix`, `fields`, `milestone`, `sections`, `storyPoints`) counts as read by the local CI, the merge gate or a check in front of a write — a key added later too, until it is put on that list. Such a change is saved as *pending*: the database column, the file and `OPS_KIT_CONFIG` keep the last confirmed settings, so the local CI, the merge gate and the Tasks go on reading those. The pending change appears among the questions (the `判断待ち` screen) with the keys, the value in force and the value asked for; `確認` puts it in force, a refusal (with the reason) drops it. One change waits per workspace: a later save replaces the earlier pending one, and saving the confirmed text again withdraws it.
- **Where the owner is known, their save is the confirmation.** In the cloud setup a request with the login cookie and a fresh passkey check is the owner's, so it is in force at once (and recorded). A request that only looks like the page's puts a form-only change in force and leaves anything else pending. Any other call — a Task's `curl` with the daemon's token, a script — can only ever leave a pending change, whatever keys it touches, and cannot answer the question (403).
- **While a change waits, the merge gate stops.** `scripts/merge-gate.ts` reads, by the clone's folder, what the daemon wrote as confirmed. It prints the version it judged with (`設定: Switchboard の側（workspace …、利用者が確かめた版 <12 hex>…）`, the same version Settings shows), adds a `[聞く]` reason while a change is pending (not lifted by `--allow-large`), and counts a local CI pass only when the steps hash in the result is the hash of the confirmed steps — so a pass run with other steps (for example with `OPS_KIT_CONFIG` pointed at another file) is not the CI's success.

What this does not guarantee, stated plainly:

- On loopback without the passkey login, the daemon cannot tell the owner's page from a Task: both reach it without authentication, and a Task can send the headers a page sends. That is why no save from there puts a gate-read key in force directly and why the confirmation is a separate step; the confirmation itself only checks that the request looks like the page's.
- A Task runs as the daemon's OS user. It can write the database, the settings files and the index directly, and it can run a script with its own environment. The record and the confirmation make an honest run ask and leave a trace; they are not a boundary between the Task and the settings.
- The check in front of `gh pr merge` (`ops-kit/bin/gh`) learns from the environment (`BACKLOG_URL`, `OPS_KIT_CONFIG`) whether a merge gate is set. A Task that unsets those variables is not stopped by it. Removing `mergeGate` from the kept settings no longer turns the check off by itself (the change waits), but the check stays a guard against slips.

### Where the configured commands run

The steps of `ci.steps` are run by `scripts/local-ci.ts` exactly as the steps committed in a repository are: the same code path, the same environment.

- **On a machine with off-host builds** (`sb-offload` on `PATH`, the cloud setup): every step runs in one build outside the machine, in the CI image. Nothing of this machine's environment goes in: no token, no home directory, no AWS credentials.
- **On a machine without them, or with `--local`:** the steps run on this machine, as the user that runs the script (the daemon's user for a job), with an environment of exactly `PATH`, `HOME`, `CI=true`, a `TMPDIR` of the run and, when the caller supplied it, `SWITCHBOARD_FIXTURES`. No variable carrying a token, a key, the daemon's address or the settings file's place is passed. `HOME` is the real one, so a step can read what that user can read under it (the daemon's token file, the `gh` login, AWS configuration). That is the same for steps committed in the repository; the difference is that committed steps pass a review, and kept steps pass the owner's confirmation above.
- **Someone else's repository** (a workspace with an upstream): its pull requests' CI steps are code nobody here reviewed, so the daemon runs its local CI only on a machine with off-host builds, and refuses `--local` (409).

What is refused on saving, with the reason in one line: text that is not JSON or has a key not in its shape (keys may be left out), `publicSync` (it is read at the commit that is sent, so it stays in the repository's file), and a value that can authenticate. Someone else's repository and the meta workspace have no such settings.

Safety. The CI's steps are shell that runs as the Switchboard OS user, and kept on Switchboard's side they do not pass a pull request's review. In exchange they are outside the pull request's diff: a pull request cannot weaken its own CI, which a repository's own steps (read from the pull request's tree) allow. A change is recorded in the operation log where the daemon requires authentication, and every local CI result whose steps came from the kept settings names the workspace and a hash of the steps. A Task of the same OS user can rewrite a checkout's `ops.config.json` today, so what is protected is the same as before.

## Removing a registration (and deleting the local copy)

The `登録を外す` button on each repo's row of the `Workspace` card in Settings (added 2026-10-25). Whether the local copy is deleted too is chosen in the confirmation.

- The confirmation opens below the row: type the workspace's name (you cannot run it until it matches), `ローカルのコピーも消す` (not shown when it cannot be deleted), and one line of warning (when the copy is deleted: there are changes / there are commits not yet pushed. When there are running Tasks, their number). The API is `GET /api/workspaces/:id/removal` (the content of the confirmation) and `DELETE /api/workspaces/:id` (`{ deleteCopy }`). When it is gone, the row disappears on an open screen through `workspaces.updated`
- The copy can be deleted only if it is a Git checkout directly under the parent directory of Switchboard's checkout. The meta workspace, Switchboard itself, a path that goes outside by a symbolic link, and a nested one are 400, and a directory that is not Git is 409 (only the registration can be removed)
- Refused (409): a Task running or waiting in that workspace or a directory under it (running, waiting; shadow included), and a schedule that uses that workspace. The history of finished Tasks remains
- The backlog's saved data is deleted only when no other workspace points to the same repository (a backlog kept only in Switchboard disappears when you remove it). After removing it, the same path can be registered again
- The GitHub side (the repository, the Project, the variables) is not deleted. A person does that on GitHub
