# skill-sync (placing the development-standard skills in each repository)

Just before a Task's runner is started (`startSession` in `packages/core/src/tasks.ts`, before `adapter.start`), `syncSkills()` in `packages/core/src/skillsync.ts` places the development-standard skills of the meta workspace in the repository of the Task's working folder (2026-09-28).
It works in the same single place for a Task started by any route (a stage button, a hand-made Task, a schedule, a parallel run, a resume).

## How skills are placed

- Source of truth: of the meta workspace's `ops-kit/skills/<name>` (`SKILL_SOURCE`, the 10 of the common operations kit), those that have a `SKILL.md`. The 5 specific to Switchboard (bun-compile-notes / flow-loop / perf-loop / runner-adapter-recording / verify-live-ui) stay in `.claude/skills` under Git management, and since they are not in the source of truth they are not placed (decided 2026-09-28)
- Destinations: `.claude/skills/<name>` (Claude Code) and `.agents/skills/<name>` (Codex) at the root of the repository (`SKILL_TARGETS`). It does not split by runner kind; every Task gets both
- Content: a **copy** of the source directory (real files. Links inside the source are copied as the real files, for both files and folders), and the marker file `.switchboard-skill` inside it (`SKILL_MARKER`; the hash of the source's content at the time of copying). It is not a link because Claude Code's permission check looks at a link by its real path. With a link, in other repositories the real path is "outside the workspace", and reading the skill body with Bash (`sed` / `cat`) raises an approval prompt (decided 2026-10-05. Check it with `claude -p`). When the source is fixed, it is copied again at the next start
- Not made a Git-managed target: in the managed block of the file at `git rev-parse --git-path info/exclude` (`# >>> switchboard skills (managed)` to `# <<< switchboard skills`), the placed copies are written as lines of `/<destination>/<name>`. Outside the block and `.gitignore` are not touched. `info/exclude` is one file for all worktrees of the repository, so the block looks at all worktrees of `git worktree list` and makes lines for the places where some worktree has a Switchboard copy (including one of a skill that has disappeared from the source, until that worktree's next start removes it) or an old link (here a place can be `skipped` and yet be a copy in another worktree). Lines that are in no worktree are removed (if the user replaced a copy with their own folder, it is visible to Git). With 0 lines, the block is removed. Lines the user wrote inside the block are left outside the block. If the end marker has been erased, the block is taken to end at the first line that is not a managed one
- The meta repository (and its worktrees) also gets copies in the same way (the 4 specific ones are real Git-managed files with no marker and no same name in the source of truth, so they are not touched). When syncing another repository, the meta checkout is synced first. If the destination is the source directory itself (a link to it), that destination is skipped
- Does nothing: when the working folder is not Git

## How to tell the copies Switchboard placed

A real directory that has the marker file `.switchboard-skill` is taken to be a copy Switchboard placed. A real directory with no marker is the repository's own (including a Git-managed one) and is not touched.
A symbolic link placed before the copies (an old link) is replaced by a copy once, at the next start. There are three kinds of old link: "a link that points inside the source", "a link that reaches inside the source through another link", and "a link that points at the meta `.claude/skills/<name>` (now meta's own copy)" (the third is what was placed before 2026-09-28, when the source of truth was meta's `.claude/skills`). A layer that keeps reading old links is not built.

| What is at the destination | Handling |
|---|---|
| Nothing | Place a copy (`linked`. The name of the result stays as it was in the days of links) |
| A marked copy whose marker hash and content equal the source | Not rewritten (`unchanged`) |
| A marked copy that differs from the source (a change or deletion in the source, a hand edit of the copy) | Delete and place again (`linked`). Files that disappeared from the source also disappear from the copy |
| An old link | Delete it and place a copy (`linked`). The link target (the source) is not changed |
| A real directory with no marker, a file, a link to somewhere else | Not touched (`skipped`). The Task's log says `スキル <name> はリポジトリにあるもの（<path>）を使います。Switchboard の正本は置いていません` |
| A marked copy or an old link whose name is not among the names to place (removed from the source) | Delete (`removed`) |

Even if `syncSkills` fails, the Task is not stopped: `スキルを置けませんでした: <理由>` is left in the log and the runner is started.

## Copies of the operations tools (scripts/setup)

Unlike skills, the entry points of `scripts/setup/` are **not distributed; only the existence of a copy is reported** (2026-10-02). The entry points are Git-managed files of each repository, part of that repository's configuration together with `ops.config.json`. Replacing them with links or rewriting them would change tracked files, which goes against the policy above of "not changing tracked files". Replacing the entry points with ones that call the kit is done in each repository.

- Definition of a copy: a file in the repository's `scripts/setup/` that has the same name (without the extension) as an entry point of meta's `scripts/setup/` but whose content does not contain `src/cli.ts` (`copies` of `setupScripts()`). Both the kit itself (`$K/src/cli.ts`) and the copy a public repository bundles (`<bundle destination>/src/cli.ts`) fall on the "calls the kit" side (`kit`) by this one rule. A name not in meta (such as DAK's `install_hooks.sh`) is a script specific to that repository and is not counted
- Detection: right after the skill sync in `startSession`. For each copy, the Task's status gets `scripts/setup/<名前> は共通キットを呼ばない写しです。検査の結果が共通スキルとずれることがあります` ("`scripts/setup/<name>` is a copy that does not call the common kit. The result of a check can drift from the common skills")
- It does not stop: the runner is started even if there is a copy, and even when `scripts/setup` could not be read (`scripts/setup を調べられませんでした: <理由>` is left)

## Primary sources (checked 2026-09-28)

- Claude Code — https://code.claude.com/docs/en/skills
  - "Claude Code loads project skills from `.claude/skills/` in the directory where you start it and in every parent directory up to the repository root"
  - "**Symlinked folders**: a `<skill-name>` entry in the enterprise, personal, or project location can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target."
- Codex — https://learn.chatgpt.com/docs/build-skills (the destination of the redirect from the old https://developers.openai.com/codex/skills)
  - A repository's skills are the `.agents/skills` of each directory from the working folder up to the repository root (and `$REPO_ROOT/.agents/skills`). A user's skills are `$HOME/.agents/skills`
  - "Codex supports symlinked skill folders and follows the symlink target when scanning these locations."

## Out of scope

- Placing at the user level (`~/.claude/skills`, `~/.agents/skills`) (replaced by syncing to each repository, in the answer of 2026-09-28)
- Rewriting the skill bodies (making them generic is separate work)
- Switching by a setting, flag or environment variable, and branching per runner
- Letting the source through with an approval setting (`additionalDirectories`) — it would write a Switchboard path into another repository's settings, which goes against the repository boundary (decided 2026-10-05)
- The daemon writing hook registrations into each repository (`shared-tmp-guard.md`. The daemon passes them with `--settings`; it is a separate matter when a repository registers one in its own settings)
