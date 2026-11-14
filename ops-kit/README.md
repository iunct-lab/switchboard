# ops-kit

Tools and shared skills for a development flow driven by GitHub Issues and a Project (request → PBI → Task → PR → review → merge).
A consuming repository holds only the configuration file `ops.config.json` and the skills that describe procedures specific to that repository. It does not hold the kit's code.

The kit never contains values specific to any one repository (repository names, Project numbers or URLs, option values, paths, accounts). Specific values go in the consuming repository's `ops.config.json`, and specific procedures go in the consuming repository's skills. The list of forbidden words is kept outside the kit by whoever uses it and passed to `export-copy`. The kit's tests use a list of synthetic words.

## Contents

| Location | Contents |
|---|---|
| `src/cli.ts` | The commands. `bun ops-kit/src/cli.ts --help` prints the usage of every command and a configuration example |
| `skills/` | 10 skills that are the same in every repository: `issue-workflow` / `request-to-backlog` / `pbi-to-tasks` / `task-to-pr` / `cross-runner-review` / `review-with-subagent` / `review-triage-and-merge` / `stacked-pr-delivery` / `pbi-complete` / `public-release-gate` |
| `bin/` | 4 programs to put on `PATH`: `ops-kit` (same as `src/cli.ts`; runs `scan-text` / `scan-issues`, which need no configuration, from anywhere) / `gh` (a front for `gh`; stops writes that contain a value usable for authentication) / `deny-shared-tmp` (a Claude Code PreToolUse hook; stops commands that write to a fixed name directly under `/tmp`) / `device-auth` (runs a command that asks for approval elsewhere and keeps the URL and code out of the output the agent reads) |
| `template/` | The template for a new repository (configuration, entry points, `.github/`). See "Templates (new repositories)" below |
| `public/` | The set placed in a public repository: the policy section to put in the README (`README.section.md`), the request-only Issue template (`.github/ISSUE_TEMPLATE/request.yml` and `config.yml`), a `SECURITY.md` template, and a workflow that closes pull requests from non-members (`.github/workflows/close-pull-requests.yml`). The only value is `__PUBLIC_REPO__`, which takes the public `owner/name`. `public-sync` adds it to the tree it publishes (see "Syncing to the public repository" below). It is also part of the published tree because it is part of the kit: someone who forks uses it when running `public-sync` to their own public repository. It is not used to operate the upstream public repository |
| `fixtures/` | Fictional configuration and responses used by the tests |

Commands (same as `--help`; each accepts `--config <ops.config.json>`, and if omitted searches upward from the current directory):

| Command | What it does | Configuration |
|---|---|---|
| `set <issue> <field> <value>` | Sets one Project field of one Issue | Required |
| `triage <issue> <area> <kind> <priority> [<phase>] [<parent>] [<status>]` | Adds an Issue to the Project and sets Area / Kind / Priority / (Phase) / Status and the parent | Required |
| `reconcile-project [--dry-run]` | Adds only the open Issues / PRs that are not yet in the Project (sets no fields; replaces the Actions autoadd). Stops (exit 1) when `BACKLOG_URL` is set (inside an app Task). Instead: for one imported request, PBI, or Task use `backlog triage`; otherwise run it outside a Task | Required |
| `lint [--no-project] [--fresh]` | Checks, with a single query (paginated), that open PBIs / Tasks / requests have the required sections from the configuration and meet the kit's Story Points scale. If `BACKLOG_URL` is set it reads the app's stored values (`--fresh` imports first; if GitHub is unreachable it keeps the stored values) | Required |
| `bootstrap <title> [--dry-run]` | Creates the Project and the fields that are in the configuration but not in the Project. Stops (exit 1) when `BACKLOG_URL` is set (inside an app Task). Instead: run it outside a Task (for a new repository, follow the `new-repo` skill) | Required |
| `request <title> <body-file>` | Creates a request Issue and adds it to the Project as Backlog | Required |
| `backlog list\|view\|create\|edit\|comment\|set\|triage …` | Reads and writes the backlog stored by the app that bundles the kit, through that app's API (`BACKLOG_URL`). What it reads is the stored values and their freshness; `--fresh` waits for a refresh (if the app cannot reach GitHub, it prints the stored values and `GitHub 未同期` and exits 0). In an environment without `BACKLOG_URL` it connects to GitHub directly and prints / writes in the same form (with the `gh` login; `--fresh` does nothing). If `BACKLOG_URL` is set but the app is unreachable it exits 2 (it does not switch to GitHub) | Not required if `BACKLOG_URL` is set (only the Phase of `triage` is read). Otherwise the Project is read for Status in list / view and for set / triage / `--field` (without it Status is `-` and writes are refused) |
| `sync-labels [<file>] [--dry-run]` | Makes the labels match `.github/labels.yml` (creates and fixes only; never deletes). Stops (exit 1) when `BACKLOG_URL` is set (inside an app Task). Instead: `env -u BACKLOG_URL ops-kit sync-labels` | Not required |
| `scan-text <file\|->` | Checks a text for values usable for authentication (does not print the values) | Not required |
| `scan-issues [<owner/name>] [--since <ISO>] [--recheck <URL>]...` | Runs all Issues, PRs, and comments of a repository (with `--since`, only those updated after that time, plus the previous hits given by `--recheck`) through the same check | Not required |
| `public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>]` / `public-sync --check [--source <ref>]` | Sends only the tree of main to the public repository. `--check` sends nothing and runs only the check of the tree to be published, in CI (see "Syncing to the public repository" below) | Required (`publicSync` only) |
| `export-copy <dest> --words-file <file>` | Makes a copy to bundle in a repository that cannot read the kit (see "The public repository" below) | Not required |
| `heavy [--memory-only] [--name <name>] -- <command…>` | Takes one heavy-process slot on the machine, then runs the command. While the slots are full or free memory is below the floor, it waits and prints the reason on one line. `--memory-only` takes no slot and waits only for free memory. The limits are in `~/.config/ops-kit/heavy.json` (defaults `max` 1, `minFreeMb` 1536) | Not required |

## Configuration in the consuming repository (ops.config.json)

Placed at the repository root. The type is in `src/config.ts` (an invalid key or value makes the command stop with the reason). All values are fictional examples:

```json
{
  "projectUrl": "https://github.com/orgs/example-org/projects/1",
  "owner": "example-org",
  "envPrefix": "EXAMPLE",
  "fields": {
    "area": ["api", "web"],
    "kind": ["bug", "feature", "chore"],
    "priority": ["P0", "P1", "P2", "P3"],
    "phase": ["Phase 0", "Phase 1"]
  },
  "milestone": { "pattern": "^Phase \\d+ — " },
  "sections": {
    "pbi": ["ユーザーストーリー", "到達点 / 受け入れ条件", "スコープ外", { "name": "元要望", "hint": "要望 Issue の番号" }],
    "task": ["親 PBI", "やること", "手順", "検証", "完了条件"],
    "request": ["要望", "出典"],
    "origin": { "name": "元要望", "pattern": "^(#[0-9]+|なし[（(].+[）)])", "hint": "`#N` か `なし（理由）`" }
  }
}
```

| Key | Meaning |
|---|---|
| `projectUrl` | Optional. The Project URL (`https://github.com/(users\|orgs)/<owner>/projects/<n>`). If you do not want it in a tracked file, omit it and put it in a repository variable (below) |
| `owner` | Optional. The owner of the Project (defaults to the owner of `projectUrl`; `@me` is the logged-in user) |
| `envPrefix` | The prefix of the environment variables. If `<envPrefix>_PROJECT_URL` is set it takes precedence over `projectUrl`, and `<envPrefix>_PROJECT_OWNER` changes only the owner |
| `fields.area` / `kind` / `priority` | The options of the Project's single-select fields |
| `fields.phase` | Optional. Only when the Project uses Phase. If present, `triage` takes `<phase>` |
| `milestone.pattern` | Optional. The regular expression that the title of a Phase Milestone must satisfy |
| `sections.pbi` / `task` / `request` | The `##` headings each Issue needs. With `{ "name", "hint" }`, the violation line gets the `hint` |
| `sections.origin` | Optional. The origin-request section of a PBI. The first non-empty line must match `pattern` |
| `publicSync.target` | The public repository (`<owner>/<name>`) that `public-sync` sends to. It stops if this is the same as the private repository |
| `publicSync.include` | Optional. Names what is sent to the public side (paths; directories end with `/`). Top-level entries that are not named (including ones added later) are not sent. Files added under a named directory are sent, so list what to leave out there in `exclude`. Omitted means the whole tree |
| `publicSync.exclude` | What `include` does not send (things meaningful only in the private repository; directories end with `/`) |
| `publicSync.rewrite` | Files in which the private repository name in the text is rewritten to the public repository name (for example the vulnerability report destination) |
| `publicSync.versioning` | Optional. `"independent"` is an independent public version (below). If omitted, the development tag is used as the public version as is |
| `publicSync.serviceUsers` | Optional. Names of OS users that are not people (for example the service user of the host template, whose home appears in a document). The home-path check on the name of the user running the sync does not look at these names |
| `publicSync.allowRefs` | Optional. Paths removed by `exclude` that a published document may name (references kept on purpose; for example `private/CLAUDE.md`, which someone who forks places). Listing a path that `exclude` does not remove stops with a configuration error |

The repository is read from `GH_REPO`, or from `origin` if that is not set. The Project URL is read in this order: the environment variable `<envPrefix>_PROJECT_URL`, `projectUrl` in the configuration, the repository variable of the same name (`gh variable get <envPrefix>_PROJECT_URL`) (commands that do not use the Project do not read the variable). To put it in a repository variable: `gh variable set <envPrefix>_PROJECT_URL --body https://github.com/orgs/example/projects/7`.

## Entry points (consuming repository)

You may call the commands directly, but a thin entry point in the repository saves writing the kit's location and the configuration's location every time. The entry point is a Git-tracked file of that repository and does not hold the kit's code:

```bash
#!/usr/bin/env bash
# scripts/setup/lint_backlog.sh [--no-project]
R="$(cd "$(dirname "$0")/../.." && pwd)"
exec bun "${OPS_KIT:-$R/ops-kit}/src/cli.ts" lint --config "$R/ops.config.json" "$@"
```

`OPS_KIT` is the location of the kit (by default `ops-kit/` inside the repository; when used from outside the repository that holds the kit, the `ops-kit` of its checkout; for a public repository, the bundled copy). `set` / `triage` / `bootstrap` / `request` take the same form.

## Heavy-process slots

Start heavy processes (local CI, the full test suite and type checks, a fake-runner daemon plus headless Chrome) wrapped in `ops-kit heavy [--name <name>] -- <command…>`. It runs the command only when a slot on the machine is free and free memory is at or above the floor, and otherwise waits. While waiting it prints the reason (the command holding the slot, its working folder and start time, or the free memory and the floor) on one line to stderr (one line each time the reason changes), and when it starts after waiting it prints `始めます`. Waiting is not an error. The exit is the command's exit.

- **The limits are machine values**: `{ "max": 1, "minFreeMb": 1536 }` in `~/.config/ops-kit/heavy.json` (both can be omitted, and without the file these are the defaults). `max` is the number of heavy processes running at once, and `minFreeMb` is the free memory needed before starting (Linux MemAvailable, in MB; on an OS where it cannot be read, only the count decides). When the app that runs Tasks starts a Task, it stops on `taskMinFreeMb` in the same file (the default belongs to that app; `ops-kit heavy` does not read it), not on `minFreeMb`. Do not put them in the repository (`ops.config.json`) or in an environment variable. Written per repository, it would not be one number for the machine
- **One set of slots per machine**: `slot-<i>.json` in `~/.local/state/ops-kit/heavy/`. Whichever repository, working tree, or Task calls it, they compete for the same slots. A slot whose owner died (`kill -9`, an interrupted Task, a stopped daemon) is taken over by the next waiting process
- **Raising it on a bigger machine**: just write the configuration file (no code or repository change). Example: `{ "max": 3 }` on a 16 GB machine. On about 4 GB, keep the default 1
- **Who holds a slot and who is waiting**: a waiting process puts `wait-<pid>-<id>.json` (name, working folder, the time it started waiting, reason `slot` / `memory`) in the same directory, rewrites it only when the reason changes, and removes it when it takes a slot. Other processes can read the slots and the waits with `readHeavyState(home)` (`src/heavy.ts`) (entries of finished processes are not returned). If the environment variable `OPS_KIT_TASK_ID` is set, its value is recorded in the slot and the wait as the Task id (set by the app that runs Tasks)
- **A nested call runs inside the outer slot**: when a descendant of a process holding a slot (for example local CI inside `ops-kit heavy -- bun scripts/local-ci.ts …`) calls `ops-kit heavy` or `withHeavySlot`, it takes no new slot and runs inside the outer slot without waiting (it does not wait for the free-memory floor either). It is recognized not by an environment variable but by whether the pid of a live slot's owner is an ancestor of the calling process (following ppid in `/proc/<pid>/stat`) (local CI runs its steps with `env -i`, so environment variables vanish on the way). In that case it prints one line `枠を持つ処理の中なので、外側の枠の中で動きます` and leaves ` (入れ子)` at the end of the name in the history (`history.jsonl`). On an OS without `/proc` the ancestors are unknown and it waits for a slot as before
- **Processes that take no seat** (`--memory-only`): it takes no slot (`slot-<i>.json`) and waits only while free memory is below the floor `minFreeMb` (it appears in the list of waits with reason `memory` and `memoryOnly`). While it runs it puts `free-<pid>-<id>.json` in the same directory, which `readHeavyState` returns as `beside`, apart from the jobs holding a slot. It starts even while a process holds a slot, and after it ends it is left in the history with its name. Wrap review sessions (Codex and `claude -p` of `cross-runner-review`) in it. No review-specific value is made (it waits on the same floor)
- **When the directory cannot be written**: in a Task that cannot write in its sandbox (such as a Codex Task), it prints one line `枠を取らずに動かします` and runs without waiting (it does not stop the work). If the app that runs Tasks has added the directory to what that Task can write, it counts toward the same number as the others

**How to add it**: wrap the heavy commands you type by hand in `ops-kit heavy --name "<something>" -- …` (the command lines in skills and `CLAUDE.md`). If there are other wrappers (such as `ops-kit idle-run`), make `ops-kit heavy` the outermost (so the time spent waiting for a slot is not counted as no progress). Do not put it inside the steps run by a script that holds a slot for a whole run (local CI, tag CI) (the steps of CI, the scripts in `package.json`) (a nested call runs inside the outer slot without waiting, but wrapping twice adds no slot and is pointless). Do not wrap a script that takes its own slot in `ops-kit heavy`.

**What does not go through it**: the number of Tasks themselves (the limit of the app that runs Tasks), and processes that run outside the host (a `curl` to a reviewer in another container, a docker build outside the host).

## Installing the skills

The skills have a single source, `skills/`, and no copy is kept by hand. The app that holds the kit, just before starting a Task's runner, places a copy of `skills/` at `.claude/skills/<name>` (Claude Code) and `.agents/skills/<name>` (Codex) in each repository, and excludes it from Git tracking (`docs/design/skill-sync.md` in the kit's parent repository). Claude Code and Codex read the same content, and if you fix `skills/` it is put back at the next start. There is no install command.

How to check: after starting a Task from that app, `ls .claude/skills .agents/skills` in the working folder shows the 10 skills above.

Put procedures specific to a repository, tracked in Git, at that repository's `.claude/skills/<another name>` (it is left alone as long as the name does not overlap with a kit copy). Write the values that the shared skills call "what the consuming repository holds" in that repository's `CLAUDE.md` (`AGENTS.md` for Codex).

## Candidate definitions (processes/)

Candidate development processes are placed as data, one file per candidate (K4 of `docs/design/process-kernel.md` in the kit's parent repository). `processes/<id>.md` has frontmatter (`id` (the same as the file name), an integer `version`, `title`, and `fits` (the kinds of work it suits, one per line)) and, in `## entry <name>` sections, the entry text passed to a Task (placeholders such as `{{n}}` are filled in by the kit's parent app). What exists now is `p0-pipeline` (the flow above itself; the kit's parent app renders the first prompt of a stage's Task from this file) and `p1-direct` (the direct type; definition only, with no path that starts it yet). Fixing a candidate's text means fixing this file, and the app's code does not change (the app-side rendering lands in the same series of changes as this definition).

The line that no candidate may cross is in one place, `invariants.md` (only the owner changes it; the "manners" of candidates and skills do not go in there).

## Templates (new repositories)

`template/` is the base of a new repository that uses the kit. The specific values are placeholders of the form `__NAME__`, and there is no command to generate or apply it (the procedure for copying files and replacing values belongs to the skills of the consuming side (the kit's parent)).

| Location | Contents |
|---|---|
| `ops.config.json` | The configuration (`envPrefix`, Area, required sections. The Project URL is not placed here but in the repository variable `<PREFIX>_PROJECT_URL`: `gh variable set <PREFIX>_PROJECT_URL --body https://github.com/orgs/<owner>/projects/<n>` (for a user's Project, change `orgs` to `users`)) |
| `scripts/setup/` | 4 entry points: `lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh` (with the execute bit) |
| `.github/ISSUE_TEMPLATE/` | `bug_report.yml` / `config.yml` / `feature_request.yml` / `pbi.yml` / `task.yml` |
| `.github/PULL_REQUEST_TEMPLATE.md` | The form of a PR body |
| `.github/labels.yml` | The label scheme (one Area is placed; add as many as there are values) |
| `.github/workflows/` | `labels.yml` (label sync) / `ci.yml` (minimal for Bun / TypeScript; for other languages rewrite the run lines) / an optional `project-autoadd.yml` (settings are in the fork steps below) |
| `.gitignore` | Generic lines only |
| `CLAUDE.md.tmpl` / `AGENTS.md.tmpl` | The place for values specific to the repository (the section layout follows the items of "what the consuming repository holds" in `issue-workflow`). They are `.tmpl` so that a runner that reads under the kit does not load them as nested instructions. Remove the suffix when placing them |
| `template-local/` | A self-contained set for a repository that does not use GitHub (kept separately, not a procedure made by removing from `template/`). `ops.config.json` / `.gitignore` / `AGENTS.md.tmpl` are copies of those in `template/`. `CLAUDE.md.tmpl` writes filing as `ops-kit backlog create`, local CI, the merge decision, and merging as the three `--change` scripts, and updating main as `local-merge.ts`, and it has `README.md.tmpl` (the headings for design rules and license) and `docs/change-template.md` (the template of a change body, `Backlog-Task: <Task>`). `.github/` and `scripts/setup/` are not placed |

| Placeholder | Value to put in | Files where it appears |
|---|---|---|
| `__OWNER__` | The GitHub owner | `.github/ISSUE_TEMPLATE/config.yml`, `CLAUDE.md.tmpl` |
| `__REPO__` | The repository name | `.github/ISSUE_TEMPLATE/config.yml`, `CLAUDE.md.tmpl`, `AGENTS.md.tmpl` |
| `__PREFIX__` | `envPrefix` (the Project URL variable is `<PREFIX>_PROJECT_URL`, and the variable that runs workflows is `<PREFIX>_ACTIONS`) | `ops.config.json`, `.github/workflows/project-autoadd.yml`, `.github/workflows/ci.yml`, `.github/workflows/labels.yml` |
| `__AREA__` | The Area values. In the array, options, labels, and PR template only one is placed; increase it to the number of values | `ops.config.json`, `.github/ISSUE_TEMPLATE/*.yml`, `.github/labels.yml`, `.github/PULL_REQUEST_TEMPLATE.md` |
| `__TEST_ALL__` | The command for the whole test suite | `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/task.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CLAUDE.md.tmpl` |
| `__KIT_HOME_VAR__` | The name of the environment variable that points at the root of the repository holding the kit | `scripts/setup/*.sh` |
| `__TEST_TYPECHECK__` / `__TEST_ONE__` | The type-check command / the command for a single test | `CLAUDE.md.tmpl` |
| `__COMPAT__` | The compatibility premise (whether there are users or external clients) | `CLAUDE.md.tmpl` |
| `__LIVE_CHECK__` | How to check on the running real thing | `CLAUDE.md.tmpl` |
| `__DEPLOY_OK__` | Applying changes to the running real thing, and whose OK is needed | `CLAUDE.md.tmpl` |
| `__KIT_REPO__` | The `owner/name` of the repository that holds the kit (where requests about the shared mechanism are filed) | `CLAUDE.md.tmpl` |
| `__TASK_CHECK__` | How to tell that it was started as a Task of the agent management app | `CLAUDE.md.tmpl` |
| `__QUOTA_CHECK__` | How to see a runner's usage limit (a command or a screen) | `CLAUDE.md.tmpl` |

Phase is not in the template (if you use it, add `phase` / `milestone` of `fixtures/config-with-phase.json` and the Phase dropdown of `pbi.yml`).

## Dependency checks (deps-check)

`ops-kit deps-check [--file-request]` checks whether the repository's dependencies need updating and prints a table. It looks only under the working directory (the repository root), and which tool to use is decided by the lockfile (not configurable). If there is a `bun.lock`, it uses bun; if there is a directory with a `uv.lock` (not only the root; `node_modules` / `.venv` / `.git` are not searched), it uses uv. If both exist, it merges them into one table and separates them by the `場所` column (for bun the workspace name, for uv the directory of the `uv.lock`). It only checks and writes no files.

| | bun | uv |
|---|---|---|
| Updatable dependencies | `bun outdated --filter '*'` | `uv lock --upgrade --dry-run` (in each directory; it also runs `uv lock --check`, and if the lock does not match it writes that in `## 出典`). What goes into the table and the condition is only the direct dependencies in that directory's `pyproject.toml` (`[project].dependencies`, `[project.optional-dependencies]`, `[dependency-groups]`; names normalized per PEP 503) and the dependencies pip-audit reports a vulnerability for (matching the granularity of bun's direct dependencies; transitive dependencies are not included unless they have a vulnerability). For a directory whose `pyproject.toml` cannot be read, it does not narrow and shows everything, and prints one line saying so. The outdated count in the summary is after narrowing |
| Vulnerabilities | `bun audit --json` | Passes the output of `uv export --frozen --no-emit-project --no-emit-local --format requirements-txt` to `uvx pip-audit` (`-r /dev/stdin --no-deps --disable-pip -f json`, via standard input). For a directory where pip-audit cannot start, failed, or printed unreadable output, it prints one line saying so, also writes `未検査` in the summary line, skips the vulnerability check, and decides from outdated only (without pip-audit) |
| Release date and license | `bun info <pkg> time` / `license` | PyPI JSON (`https://pypi.org/pypi/<pkg>/json`), once per package |

- **Triggering conditions** (any one puts a dependency in the table): a vulnerability, a major lag (the candidate's major is greater than the current one; for `0.x`, the minor), or the current version was released 90 or more days ago and a newer version exists. A dependency whose current version's release date cannot be read is not counted as meeting a condition, and is named on one line in the output and in the body's `## 出典` (it is not dropped silently, and is not filed on that alone). If even one dependency meets this, it is a "hit". The table adds the candidate's release date and license (`不明` if unreadable)
- **Already reported**: a dependency named by an open PR that changes `bun.lock` / `package.json` / `uv.lock` / `pyproject.toml` is removed from the table and written as `既出` with the PR number. If open PRs cannot be read, the body says `既出の確認なし`
- **exit**: 0 = no hit, 1 = hit, 2 = a tool did not run, there is no lockfile, or the request could not be filed. If a tool's output cannot be read it is 2 (it is not misread as no hit). The exception is pip-audit, which as above decides from outdated only and names the unchecked
- **`--file-request`**: on a hit, files one request titled `依存の更新: <YYYY-MM>`. If an open request with the same title exists, it adds to that request as a comment instead of filing. The body has `## 要望` (the table), `## 出典` (the tools checked and the results), and `## 更新の条件` (a default sentence per tool used: for bun, touch nothing but the lockfile and `package.json` and add `--minimum-release-age`; for uv, touch nothing but `uv.lock` and `pyproject.toml` and paste the `uv tree` diff; and so on; candidates are only versions released 7 or more days ago, and a major is one PR per package). On no hit it prints `要望: 当たらないので起票しない` and files nothing. Finally it prints one line `要望: …`
- **`depsCheck.extraConditions`**: an array of strings in `ops.config.json`. Repository-specific conditions, added to `## 更新の条件` after the default sentence (they do not replace the default)
- **How a scheduled run calls it**: a periodic run (for example weekly) calls `ops-kit deps-check --file-request` once in that repository's working tree, and reports the last line of the output (the number filed, or that there was no hit) and the count. Filing goes through the request command (`ops-kit request`), and turning it into a PBI is left to the request flow (`request-to-backlog`). The load is the number of `uv.lock` directories × (the `uv` resolution + pip-audit), plus as many PyPI reads as there are candidate packages

## Syncing to the public repository

`public-sync` sends only the **tree** of the private main to the public repository, without history (it makes one commit with `git commit-tree <tree> -p <public main>`, so the private commits do not become ancestors). It reads only `publicSync` of `ops.config.json` (it does not look at other keys). The private repository name is `GH_REPO`, or `origin` if that is not set.

- The first time (the public `main` is empty), it pushes a root commit to `main`. From the second time, it pushes `sync/<tag>` (`sync/<short sha of the public tree>` if it is not a tag), opens a PR, and merges it right away with **Rebase and merge** (a PR on the public side is public the moment it is opened, so a human merge is not a check that stops publication; it does not wait for the public side's CI result). If the merge fails, the PR stays open, it stops with the reason, and the next run merges it again. If the title is `vX.Y.Z`, the same run puts a tag and a Release on the public side. Private information does not appear in the public side's commits, branches, PRs, and Releases: the title is only the version (the tag name) and there is no body (the titles of private commits are internal notes, so they are not listed; neither private shas nor Issue numbers appear). Which private commit it was sent from is kept in the ref `refs/public-sync/trees/<public-side tree>` of the private `origin`, and the next run finds the previous one with it (it is looked up by tree, so it does not depend on how the public side merged. If there is no record for the tree of the public `main`, it stops with "main changed after the last sync"). The configuration (`publicSync`) is read from the `ops.config.json` of the tree being sent (`--source`) (even if the working tree is old, an old exclusion does not apply to a new tag). A `--source` older than the last one sent is not sent (the public side is not rolled back)
- If the public `main` changed after the last sync, it stops so as not to overwrite. Take that change into the private repository, then run with `--adopted` (in that case it does not merge the open sync PR, and stops, asking you to close it)
- Of the tree it keeps only what `publicSync.include` names (omitted means the whole tree; if a named item is not in the tree, it appears in the output), removes `publicSync.exclude`, and in the files of `publicSync.rewrite` replaces the private repository name with the public-side name
- A directory in `include` (trailing `/`) is sent as it is, with every file later added under it, documents included: use it for code. For documents that must each be decided, leave their directory out of `include` and name the files one by one (`docs/guide.md`): a file there that `include` does not name is not sent, so a new one stays out until it is named. Name the ones kept private in `publicSync.exclude` too, to record that they were decided. `public-sync` does not check documents under a directory entry; a repository that wants every document decided can add a test that fails for a Markdown or HTML file named in neither `include` nor `exclude`
- A workflow job runs only in a repository whose repository variable is `on`: for the `ci.yml` and `labels.yml` of the development origin and the template it is `<PREFIX>_ACTIONS`, and for `close-pull-requests.yml` of the public set it is `PUBLIC_ACTIONS` (the public set has no `envPrefix`). In a copy without the variable no job runs, so even if it is placed where Actions are not allowed no failure email comes, and PRs on the copy are not closed either. On the public target, set `PUBLIC_ACTIONS` to `on` before syncing a workflow that has the condition (without it PRs are not closed). To remove the root `.github` from the Release archive, put `/.github/ export-ignore` in `.gitattributes`
- After that it adds the public set (`public/`) to the tree (there is no setting to include or not; `__PUBLIC_REPO__` is `publicSync.target`): it replaces `.github/ISSUE_TEMPLATE/` with only the request templates (`request.yml` + `config.yml`), adds the workflow that closes PRs (`.github/workflows/close-pull-requests.yml`), puts in the `SECURITY.md` template only when the repository has none (in none of the root, `.github/`, and `docs/`), and replaces the `## How this repository works` section of `README.md` (if there is none, it inserts it before the first `## ` heading, or at the end if there is no heading; a `## ` inside a code block does not count as a heading; if there is no `README.md` it stops). The `public kit:` line of the output says what it did
- Checks before sending (if even one hits, nothing is sent and it exits 1): in the lines that change on the public side (the whole tree the first time), a value that matches the kit's secret rules (the same as the `gh` front; including the host's AWS profile name, SSO session name, and account ID) (only the kind and the file name are printed); the private repository name (a whole-name match; in file contents, path names, and commit messages); a home path (the form of a macOS home directory; the names `dev` / `example` / `me` / `x` / `<you>` pass); and a personal email address (example domains and the public addresses of GitHub and Anthropic pass). The targets are the tree (binaries too), commit messages, and author / committer. The host-independent secret rules are applied to the whole tree, not only the changed lines (the same as `--check` below in an environment without host values; the file, line, and kind are printed)
- It also stops if a Markdown file (`*.md`) in the tree to be published names a path that `publicSync.exclude` removes (a reader on the public side cannot open it). What is matched is the path of an excluded file itself and paths under an excluded directory. Part of a longer path (`a/docs/x.md`, `/private/tmp`), naming only a directory (`private/`), non-`.md` files, and `ops.config.json` are not matched. Write references kept on purpose in `publicSync.allowRefs`. The file, line, and named path are printed
- It also stops if the plain prose of a Markdown file in the published tree has a value shaped like a commit hash (7 to 40 hexadecimal digits that contain both digits and a-f) (a reader on the public side cannot open private commits; say in words what it points at). Inside inline code and code fences it is not matched (put example values there). The file, line, and value are printed
- It also stops if the user name of the OS running the sync (`os.userInfo().username`, case-insensitive; not checked if it is empty, the replacement name above, or a name in `publicSync.serviceUsers`; it looks only at the name of the user running the sync, not at the name of another user who made recordings and the like) appears in a path form (`/home/<you>`, `/Users/<you>`, `pytest-of-<you>`, `C:\Users\<you>`, and also `C:\\Users\\<you>` in a JSON or JS string) in file contents, path names, or commit messages
- `--source <ref>` (default `origin/main`) can also point at a tag. When it points at a tag, the title of the sync commit and PR is only that name (`v1.2.0`; `sync` if it is not a tag). When a sync titled `vX.Y.Z` enters the public main, in the same run (the next run if the merge failed) a tag and a GitHub Release of the same name are put on that commit on the public side (`gh release create --target`, no body; no push; not put with `--target-url`). `--dry-run` prints the results of exclusion, rewriting, and checks and the sha of the tree it would make, and ends (the public side need not be reachable; nothing is pushed; when the public side is reachable it fetches into `refs/public-sync/main` for comparison). `--target-url` replaces the URL of the public target (for a bare repository in tests)
- `--check` (the default of `--source` is `HEAD`) builds the tree with the same function as the sync and, with the same functions, checks the private repository name in the tree (file and line, and path names), home paths, personal email addresses, and the secret rules (every line of every file, including files unchanged since the last publication; the file, line, and kind are printed, never the value). The values of the host's AWS profile name, SSO session name, and account ID are counted only when the environment running the check has AWS configuration (`AWS_CONFIG_FILE`, or `~/.aws/config` if unset) (Actions has none, so they are not counted; local CI run on the host counts them). It does not touch the public side (it needs neither the network nor `gh`), so put it in a PR's CI to stop before merging, ahead of the sync (for example, in the CI steps: `bun ops-kit/src/cli.ts public-sync --check`). Checks that depend on the title or author, and the OS user name of the syncing user, are looked at only at sync time (an account ID recognizable by its form, such as in an ARN, matches even without host values, and the example is `123456789012`). With the same function it also checks whether a published document names a path that is removed, and whether the prose contains a value shaped like a commit hash (the same as the checks before sending above; references in `publicSync.allowRefs` pass). In a clone whose `origin` (or `GH_REPO`) is `publicSync.target` (the CI of the public copy), it does not check and exits 0
- exit 0 = sent / nothing to send / dry-run, 1 = stopped (the reason is on stderr), 2 = misuse

## The public repository

To a repository that cannot refer to the kit directly, bundle a generated copy:

```bash
bun ops-kit/src/cli.ts export-copy <public-repository>/vendor/ops-kit --words-file <forbidden-words-file>
cat <public-repository>/vendor/ops-kit/KIT_VERSION    # commit <sha> / date <date-time> (a dirty line if made from uncommitted changes)
(cd <public-repository>/vendor/ops-kit && bun install)  # the only dependency is zod; you may also add it to the repository's workspaces
```

- What goes into the copy: `src/` (excluding `*.test.ts`), `skills/`, `bin/`, `README.md`, `package.json`, the `LICENSE` of the kit's parent repository, `tsconfig.json` (with the base configuration from outside the kit merged in), and the configuration example that `--help` prints (`fixtures/config-with-phase.json`). The tests and the remaining fixtures do not go in. A symbolic link goes in as the content of its target (and the check applies to that content)
- Attribution: the kit cannot contain the name of the parent repository or of the author (the check for specific words), so the copy has only `LICENSE` and does not include the parent's `NOTICE`. The public repository that bundles it writes the attribution in its own `NOTICE`: "`vendor/ops-kit` is a copy of the ops-kit of <parent repository> (Apache-2.0)"
- The origin and the version are in `KIT_VERSION`. Do not fix the copy (fix the kit; the copy is rebuilt)
- The check that no non-public information gets in: after making the copy, it searches the names and contents of all files of the copy for the words in the specified list, and if there is even one hit it deletes the copy and exits 1 (the previous copy is left as it was). If no list is specified, or the specified file does not exist, it stops with the reason (the check is not skipped). The list is UTF-8 with one word per line, and blank lines and lines starting with `#` are ignored. Matching of names and contents is case-insensitive
- `<dest>` is one of: missing, empty, or a previous copy (it has `KIT_VERSION`). A previous copy is replaced; it does not write into any other directory
- For the entry point, use `OPS_KIT=<repository>/vendor/ops-kit`, or make the kit location of the entry point `vendor/ops-kit`. The app places the skills as in "Installing the skills" above (the copy's `skills/` is for reading without the app)

## Starting development on a fork

The procedure for forking and developing the app that holds this kit is in that repository's [`docs/development.md`](../docs/development.md).

## When writes to the public side are refused

In a clone where the default write target (`GH_REPO`, or `gh repo view` if unset) is the same as the nearest `ops.config.json`'s `publicSync.target`, writes are stopped and the following sentence is printed: `書き込み先 <owner/name> は、この clone の ops.config.json の publicSync.target（公開側の写し）です。自分のリポジトリに向けてから実行してください: …`. The decision does not use a repository name. The upstream development origin is not stopped because its default is the development origin.

How to fix it:

1. With `git remote -v`, check that `origin` is your own repository. If you still have the upstream cloned, add your own repository as a remote (`git remote add <name> <your URL>`) or repoint `origin`.
2. Run `gh repo set-default <your owner/name>`. The answer of `gh repo view` changes, and steps that write with `-R "$(gh repo view …)"` also point at your own repository.
3. `GH_REPO=<your owner/name>` also points `gh` writes at your own, but the answer of `gh repo view` does not change. Writes that name the upstream with `-R "$(gh repo view …)"` stay stopped, so use 2.

What it protects: the kit's tools (the `ops-kit` commands and the entry points of `scripts/setup/`), `gh` going through the `gh` front (`ops-kit/bin/gh`), and the backlog import and send of the app that holds the kit. A `gh` run in a terminal that does not put the front on `PATH`, and operations in the GitHub UI, are not stopped.

## Updating

- When the kit is fixed, a consuming side that refers to the kit (its entry point points at `OPS_KIT` or at a checkout of the kit) does nothing. The new kit runs from the next execution, and the skills are placed again at the next Task start
- A bundled copy does not follow. To update, run `export-copy` again to the same `<dest>` and commit it with the diff of `KIT_VERSION`
- If the shape of the configuration changes (`src/config.ts`), fix the consuming side's `ops.config.json`. No layer that reads the old shape is made

### Independent public versions

Setting `publicSync.versioning: "independent"` on a new public target numbers public versions independently of the development tags. The behavior when it is omitted does not change. `--source` names an exact `vX.Y.Z` tag that exists in the private origin and is contained in main (fetch the development tags first). The first time, regardless of the development version number, the public side is `v0.1.0`, and that source becomes the baseline.

From the next time on, it examines the transitions of development tags from the previously published source to this source, and raises the largest level (major > minor > patch) on the public side **once**. If there were 3 patches, the public patch goes up by 1; if there were 3 patches and 2 minors, the public minor goes up by 1. A major resets minor and patch to 0, and a minor resets patch to 0. The v0 series follows the same rule, and if a major is included it can become v1.0.0. There is no threshold on the count.

If the public tree is the same, it does not increase and does not advance the previous publication's baseline. When the next public difference appears, the largest level is chosen over the whole interval, including changes that are not published. It stops without guessing on a development tag that forks or goes backward, several versions on the same commit, a recorded tag moved or deleted, or a missing baseline (for an already published target with no ledger, the stop points to the migration below).

A public target that has been published but has neither a ledger nor release tags (one published with a sync that does not use independent numbering) is moved to independent numbering without rebuilding, with `ops-kit public-sync --adopt-baseline --source <vX.Y.Z>`. First put `publicSync.versioning: "independent"` into the private main and push it to origin (the migration builds no tree to send, so the configuration is read from origin/main, not from the `--source` tag). `--source` is the development tag on the commit that the record of the origin of the public main's tree (`refs/public-sync/trees/<tree>` of the private origin) points at. First add `--dry-run` and check the source's tag and commit, the public main's commit and tree, and the public version `v0.1.0` to be put, then run it. It does not rewrite the public history and adds no commit. It puts a public tag and Release `v0.1.0` on the current head commit of the public main and makes that commit the ledger's baseline (the title of the public main stays as the previous sync's; from the next version the title becomes the version). From then on, a normal sync numbers from v0.1.0 as the baseline under the rule above. In any of the following cases it stops without writing to the public side or the private origin: a ledger already exists / there is no public main / there is no record of the origin of the public main's tree (first make it a tree with a record by a normal sync with `--adopted`) / the commit the record points at differs from the `--source` tag / a `vX.Y.Z` tag or Release already exists on the public side / there is an open sync PR. If it fails midway (for example creating the Release), running the same command again with the same `--source` supplies only the missing steps without changing the version.

`--dry-run` shows the source, the previous baseline, the level, the planned public version, and the checked tree, and writes to neither the public side nor the private origin. With independent numbering, to avoid mistaking the baseline, if reading the public target fails it stops and does not assume it is the first time. For the first time, create an empty private repository and then run it. The check before creating can be done by passing an empty local bare repository to `--target-url` (no GitHub Release is made). The title, branch, and tag on the public side are only the public version. The body of the public Release is empty, and it does not transcribe development-side subjects, Issues, or shas. It does not rewrite the version in package.json.

The correspondence of source, public tree, public version, and development tag, and the unfinished plan, are stored in `refs/public-sync/versions/<SHA-256 of the public target URL>` of the private origin. A ref with `-lock` appended to the same prefix is acquired and released on every run with a push that carries an expected value. Concurrent runs from another clone stop. If processing fails, the unfinished plan remains. A plan that has not reached the public side (the public main is still at the previous completion's commit, and there is no tag, Release, or open sync PR of the plan's version) is replaced by the next sync with the `--source` it is given (the first line of the output is `version: replaced unfinished plan …`, and `--dry-run` says `would replace`), and the version is decided from that source. A plan that has partly reached the public side is resumed with the same `--source` **after checking the public side and the ledger, without blindly re-running the failed operation**. A different `--source` stops, printing on the first line the tag to use for resuming and what has arrived (the public main's movement, the sync PR's number, the tag, and the Release). Even with the same `--source`, it stops if the target changed. If the tag and Release already exist, it confirms that they match that public commit and supplies only the missing steps.

If the process is killed, the lock is not taken over automatically. For recovery, confirm that the original run has ended and read the lock and the state with `git ls-remote origin 'refs/public-sync/versions/*'`. Cross-check the public main, the sync branch, the PR, the tag, the Release, and the unfinished plan, then release only that lock with `git push --force-with-lease=<lock-ref>:<observed-ID> origin :<lock-ref>`, using the object ID observed for the lock as the expected value, and then resume. Do not release it while a run is in progress or while the result of a write is unknown. Do not delete the ledger or a public tag to redo the numbering.
