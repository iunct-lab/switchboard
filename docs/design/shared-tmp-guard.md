# shared-tmp-guard (keeping fixed names directly under /tmp from being written)

Before it runs, it stops a Bash command that writes or deletes a fixed name directly under `/tmp` in a Claude Code Task started by Switchboard (a Codex Task is stopped by the sandbox, not a hook; see "Limits per runner") (2026-10-07). The rule itself is the skills' rule (do not put working files under fixed names directly under `/tmp`; use `W=$(mktemp -d /tmp/<リポジトリ名>.<用途>.XXXXXX)`; `task-to-pr` and others). This mechanism is a brake for an agent that missed that sentence.

Reason: if two sessions of different repositories on the same host overwrite each other's `/tmp/post_review.sh`, one session's review is posted to the other's PR number. If a hook were placed only in the home directory, it would vanish on a new host whenever a move to a new host or a restore after a rebuild does not carry the whole home directory over (for example, when only the session records are copied). This mechanism puts the body and the source of the registration in the repository, so that a rebuild does not erase it.

## Parts

| Part | Where | Role |
|---|---|---|
| Judgement | `sharedTmpWrites` in `ops-kit/src/shared-tmp.ts` | From the text of a command, returns the paths under fixed names directly under `/tmp` that it writes or deletes |
| Body | `ops-kit/bin/deny-shared-tmp` | A PreToolUse hook. Reads `{tool_name, tool_input:{command}}` from standard input; on a hit it writes one line per path to standard error and exits 2 (Claude Code does not run that Bash and returns the text to the agent) |
| Wiring (2026-10-07) | `startSession` in `packages/core/src/tasks.ts` → `StartOptions.guards` → `buildArgs` of the Claude adapter | Hands the meta workspace's body to Claude Code as a PreToolUse Bash hook in `--settings` (inline JSON), with `onFailure: "block"`. If there is no meta workspace, it is not handed over |
| Switchboard's own registration | `.claude/settings.json` (managed in Git) | `"$CLAUDE_PROJECT_DIR"/ops-kit/bin/deny-shared-tmp` (`onFailure: "block"`). It also works for a session started by hand in this repository |

## How it is placed

- Nothing is written to other repositories. `--settings` is an argument per start, so neither a Git-managed file nor `.git/info/exclude` changes. `~/.claude` is not read either
- Claude Code adds up hook registrations across the sources of settings (managed, `--settings`, `.claude/settings.local.json`, `.claude/settings.json`, `~/.claude/settings.json`). Even if a repository has its own hook (a Git-managed `.claude/settings.json`), both are called
- In a Switchboard Task, the same body is called twice, through `--settings` and through `.claude/settings.json` (the command strings differ, so Claude Code does not merge them into one). The result is the same, and no branch is added
- It does not work for a session started by hand in another repository. A repository that wants it can add one line pointing at the body to its own `.claude/settings.json`

## What it stops

Writes and deletes with the following to a name directly under `/tmp` (`/private/tmp`) that does not start with a variable, and to deep paths below it:

| How it is written | Example |
|---|---|
| The target of a redirect (`>` `>>` `>\|` `2>` `&>` `>& file`) | `cat > /tmp/pr.md`, `echo x >> /tmp/x`, `make 2> /tmp/err.log` |
| The arguments of `tee` `rm` `rmdir` `mkdir` `touch` `truncate` | `tee /tmp/x`, `rm -rf /tmp/review1`, `rm -rf /tmp/review*`, `mkdir /tmp/review1/a` |
| The last argument of `cp` `mv` `ln` `install` | `cp a /tmp/x` |
| The destination of `git worktree add` / `git clone` | `git worktree add /tmp/wt origin/main` |

It also stops that Bash when the hook itself does not work (it cannot start because the path of the body is missing or the `bun` of `#!/usr/bin/env bun` is not on PATH, it times out, or it ends with an unexpected exit code). The registration carries `onFailure: "block"` (Claude Code 2.1.295), so Claude Code does not run that Bash and returns `PreToolUse:Bash hook error: [<コマンド>]: failed; blocking because onFailure is "block"` and the text of the cause to the agent as the tool's result (an error). On the Task's screen, the line of that Bash fails (✕), and opening it shows the same text. Without it, a brake that does not work silently lets Bash through

It looks at each command separated by `;` `&&` `||` `|` `&`, a newline, `$( )` and `( )`. It skips a leading `X=1` and `sudo` `env` `command` `exec` `nohup` `time`, and the reserved words `if` `then` `else` `elif` `while` `until` `do` `{` `!`, and reads what follows as the command.

## What it does not stop

- `mktemp -d /tmp/<name>.XXXXXX` and what is under its result: whether through a variable (`"$W/pr.md"`) or by writing the printed path out as characters (`/tmp/<name>.AuCZE8/pr.md`). The skills make you reuse the printed path when you cross Bash calls, so a name directly under `/tmp` in the shape of mktemp's (6 or more alphanumeric characters after a dot, with at least one uppercase letter or digit) is not stopped. Lowercase only (`/tmp/notes.backup`), `X` only (the template itself `/tmp/sb.pr.XXXXXX`) and digits only (a date `/tmp/backup.20260930`) are stopped
- Commands that only read `/tmp` (`ls /tmp`, `cat /tmp/x`, `< /tmp/x`, `cp /tmp/x ./here`), `/tmp` itself, and paths other than `/tmp` (`./tmp/x`, `/var/tmp/x`)
- Inside a string argument (`gh pr comment 1 --body 'cat > /tmp/pr.md'`), the body of a heredoc, and `#` comments, so that it does not stop when a PR body is written with a heredoc. However, the target of a redirect and the path argument of a writing command are stopped even when quoted (`echo x > "/tmp/x"`, `rm '/tmp/x'`)
- What is known only after the shell interprets it: the expansion of a variable (`D=/tmp/x; echo > "$D"`), `eval`, `cd /tmp && echo > x`, and a write inside another script. It does not do a full interpretation of the shell
- Ways of writing not in the table: a prefix with an option that takes a value (`sudo -u root rm /tmp/x`), a prefix not in the table (`timeout 10 rm /tmp/x`, `xargs rm /tmp/x`), a destination that is the value of an option (`cp -t /tmp/dir a b`), and a `<<` inside `$(( ))` (read as the start of a heredoc, and what follows is not read). When an accident happens with a way of writing that was found, it is added to the table
- Tools other than Bash (writing to `/tmp/x` with the Write tool), and an input JSON that cannot be read (exit 0, so that a bug in the hook does not stop every Bash). This is the body running and answering "pass", so it is separate from the target of `onFailure` (the hook does not run), and passes as before

## Limits per runner

- Claude Code: it works (a Task through `--settings` (entered on 2026-10-07), this repository through `.claude/settings.json`)
- Codex (decided 2026-10-16): stopped by the sandbox, not a hook. The daemon creates a dedicated temporary directory per Task, `<the daemon's home>/tmp/<Task ID>` (an area per daemon; it is not shared with another daemon or a daemon started on a copy of the DB), and hands it over as `StartOptions.privateTmp` (it is deleted when the Task ends in an interruption or an error. A completed Task keeps it so that a resume uses the same files, and at daemon startup, among the Tasks the DB is willing to let go (finished, with no resume planned), those last started more than 3 days ago are deleted). The Codex adapter makes it `TMPDIR` and makes the sandbox of each turn "close `/tmp` (`excludeSlashTmp: true`) + only that dedicated directory is writable". A write to a fixed name directly under `/tmp` fails with `Read-only file system`, while `mktemp -d` (under `TMPDIR`) and under `$TMPDIR` are writable. It does not touch another session's files in `/tmp`, and files left behind stay in the Task's dedicated directory and are deleted when the Task ends. Nothing is written to `~/.codex` or to the repository. If there is no meta workspace, it is not handed over (the same as `guards`). Only a Codex Task gets one created, and if another user's directory or a symbolic link is already there, it is not created and the Task does not start (a Codex without protection is not run)
  - Why not a hook: Codex's PreToolUse runs only the definitions the user has trusted. An inline hook passed with `-c` is the same, and the record of trust is under `~/.codex`, which a new host does not have unless you carry it over. `--dangerously-bypass-hook-trust`, which skips the trust, is an argument of the `codex` itself; it works with `codex exec`, but the `codex app-server` that Switchboard starts does not read it and the hook is not called (passing the setting key `bypass_hook_trust` with `-c` is the same; check it with your `codex` version)
  - The heavy-work slot (`ops-kit heavy`, `Heavy-process slots` in the kit's README): the daemon also adds the slot's home `~/.local/state/ops-kit/heavy/` to the writable places (scope) of that start, each time it starts a Codex Task (creating it if absent. If it cannot be created, it prints one line to the Task and starts without adding it. The scope of the Task it saves is not changed). `ops-kit heavy` inside the sandbox also takes a slot at the same count as the other Tasks. A Claude Task has no sandbox and can write there as it is
  - The price: in a Codex Task, `mktemp -d /tmp/<name>.XXXXXX` also fails (use `mktemp -d` or under `$TMPDIR`). It stops only inside the sandbox, and does not work for a Task in a permission mode that removes the sandbox (Codex's `full-access`). Unlike a hook, which returns its reason to Codex, the failure is the text `Read-only file system`. In a permission mode that needs approval (such as `auto`), the model may ask for permission to run the failed command outside the sandbox, and when it is approved, that one time is not stopped (a hook stops it whether or not it is approved).
  - To check it yourself: start a Codex Task with a `CODEX_HOME` that has neither hooks nor a record of trust, and run `touch /tmp/x` (it fails with `Read-only file system`) and `mktemp -d` (it succeeds)
- DAK: not handed over (the DAK adapter does not use the `guards` entered on 2026-10-07)

## Primary sources

Checked on 2026-10-27: the 2.1.295 entry of Claude Code's CHANGELOG (`onFailure: "block"` of command / HTTP hooks. A hook that cannot start, times out or ends with an unexpected exit code stops the operation instead of letting it through). To check it yourself: pass `--settings` a settings JSON with a `PreToolUse` command hook (matcher `Bash`, `onFailure: "block"`) whose `command` points to an executable that does not exist, and ask Claude Code to run `touch /tmp/x`. It is not run, and the tool's result is an error

Checked on 2026-10-01 (code.claude.com):

- `docs/en/settings`: the order of precedence of settings is managed → command line (`claude --settings`) → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`
- `docs/en/hooks`: "Hook entries merge across settings levels rather than replacing each other". If the same handler is in several settings files, it runs only once. PreToolUse's exit 2 stops the tool call, and the text on standard error is returned to the agent. `$CLAUDE_PROJECT_DIR` is the root of the project where the session started

## Out of scope

- Putting a hook in `~/.claude` in the home directory, or restoring the home directory when the host is rebuilt
- Stopping a Task with no meta workspace (no brake is handed over). `onFailure` works only when a registered hook does not run. It is handled separately as a check of the configuration (decided 2026-10-27)
- A setting, flag or environment variable that turns the hook off. A false positive is fixed by correcting the rules of `shared-tmp.ts` so that it goes away
- Placing `.claude/settings.local.json` in each repository (Claude Code itself rewrites that file, so composing it and managing who owns it would be needed, creating it by hand makes it visible to Git, and the shape of the managed block in `skill-sync.md` would also change)
