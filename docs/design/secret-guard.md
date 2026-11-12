# secret-guard (keeping values that can authenticate out of Issues and PRs)

A check sits in front of `gh` for the runners Switchboard starts (2026-09-30). When a runner tries to write text that holds a value that can authenticate into an Issue, a PR or a comment, it is stopped before anything is sent to GitHub. The rule itself is in the common skill `issue-workflow`, under `Issue・PR・コメントに書かない値`.

Origin: an unattended agent can write the device code and approval URL of a cloud administrator's temporary session into an Issue comment. Before this mechanism, neither a rule nor a mechanism stopped it. Agents also sometimes write the host's AWS SSO profile name in an Issue comment. A name that does not look like a value was not covered by any rule (added 2026-10-14).

## Parts

| Part | Where | Role |
|---|---|---|
| Check | `findSecrets` in `ops-kit/src/secrets.ts` | Finds values in a text and returns the kind and the line number. It does not return the value. The names and account IDs in the host's AWS config (`AWS_CONFIG_FILE`, otherwise `~/.aws/config`) are read by `hostAws`, and each entry point of the caller (the front, `scan-text`, `scan-issues`, before sending in `ops-kit backlog`, the posting of local CI) passes them once |
| Front | `ops-kit/bin/gh` (`ops-kit/src/gh-guard.ts`) | Checks the body of a write and exits 1 on a hit. Then checks writes to the public copy and to the target of `ops-kit.noWrite` (see "Writes to the public copy" below) and exits 1 on a hit. If neither hits, it hands the command to the real `gh` unchanged |
| Wiring | `startSession` in `packages/core/src/tasks.ts` | Puts the meta workspace's `ops-kit/bin` at the head of the `PATH` handed to the runner and the daemon's `bun` folder at the end (`StartOptions.env`) |
| The host's interactive shell | `/etc/profile.d/sb-gh-guard.sh` (`bootstrap.sh` places `aws/host/sb-gh-guard.sh`) | On a cloud host, puts the meta checkout's `ops-kit/bin` at the head of the `PATH` of the host user's terminal tab (`bash -i`) and of login shells, and the `bun` folder at the end. A post made by a `claude` / `codex` that is started by hand without going through Switchboard also passes the front, in any repository (decided 2026-10-03). If the checkout is missing, `PATH` is not changed. The shells of root and of other users are not changed (an agent can write to the checkout, so it is not put ahead of root's `PATH`) |
| Scheduled scan | The daemon's schedule `認証の値の検査` (secret scan) (`action: "secret-scan"`, `packages/core/src/secretscan.ts`) | On every firing, runs `scan-issues` over all registered repositories, on the difference since the last run, and raises a notice in the pending-decisions list if any repository has a hit or could not be scanned (2026-10-29) |
| Later scan | `ops-kit scan-issues [<owner/name>]` (`ops-kit` in the kit's `bin`; it runs `bun ops-kit/src/cli.ts scan-issues`. The same for a repository without an entry point) | Scans Issues, comments, and the review comments and review bodies of PRs that were already written. With no argument it reads everything; `--since <ISO 8601>` reads what was updated after that time (the review bodies of PRs only for the PRs updated in that period); `--recheck <URL>` rereads the previous hits even outside the difference (if one is gone, no hit). The fetch of one page is retried up to 3 times, and if it still cannot be read it exits 2 rather than saying "no hits". The last line is `hits: N / scanned: M` (the number of texts read) |

## Where it stops writes

It is on `PATH`, not in a runner's hook. A runner's hook is handed over and trusted differently per runner (Codex runs only hook definitions the user has trusted, and records that trust under `~/.codex`; see `shared-tmp-guard.md`), and anything placed only in the home directory is lost when a host is rebuilt or replaced without carrying the home directory over. `PATH` works in one place no matter which repository the Task's working folder is in and no matter whether the runner is Claude Code or Codex.

The guard against fixed names under `/tmp` works through a hook for Claude Code (placed in the common kit rather than the home directory and passed with `--settings`) and through the sandbox for Codex (`shared-tmp-guard.md`). The front of `gh` stays on `PATH` so that it also works for Codex.

- It works for a Task started by any route (a stage button, a hand-made Task, a schedule, a parallel run, a resume). `startSession` is the same place that places the skills (`docs/design/skill-sync.md`)
- If there is no meta workspace, `PATH` is not changed
- The front calls the first `gh` on `PATH`, after removing the front itself, as the real one. If there is none, it exits 127. It also skips the front of another checkout (a file whose second line is `// gh-guard`), so even with two fronts on `PATH` they do not call each other
- `ops-kit/bin/docker` (added 2026-10-15) finds the real `docker` the same way (`realCommand`). The second line of the file is `// docker-mark`. Only when the caller passes `DOCKER_MARK_LABEL` (`key=value`) does it add that label to `run` / `create`, and if `DOCKER_MARK_LOG` is set it records the compose project name (the common kit holds no product-specific words, so core passes the Task's mark). The cleanup was added on 2026-10-15
- The front runs on `bun`. The daemon may be started with a full-path `bun` (`scripts/setup.sh`, `process.execPath` on restart), so the wiring also adds the daemon's `bun` folder (`dirname(process.execPath)`) at the end of `PATH` (at the end, so it does not come ahead of the tools on the user's `PATH`)

## Merges

The guard does not judge `gh pr merge` or `gh stack merge`: they reach the real `gh` like any other command, and only their body and subject are checked (below). Running the repository's merge judgement before a merge is the default procedure the skills describe, not a gate in front of `gh`. When the user allows a merge outside that judgement in the Task's conversation, the Task merges with `gh pr merge` / `gh stack merge`.

There is no gate in front of `gh` that stops every merge the judgement did not pass: a rule fixed in code would leave no room for a merge the user has allowed.

## Writes it checks

| Command | Text it reads |
|---|---|
| `gh issue create (new) / comment / edit` | `--title`, `--body`, `--body-file` (`-` is standard input) |
| `gh pr create (new) / comment / edit / review` | The same |
| `gh issue close` / `gh pr close` | `--comment` |
| `gh pr merge` | `--body`, `--body-file` (`-` is standard input), `--subject` (the body and subject of the merge commit) |
| `gh release create (new) / edit` | `--title`, `--notes`, `--notes-file` (`-` is standard input). Attached files are not read |
| `gh gist create (new) / edit` | The contents of the file arguments (all of them for `create`, after the id for `edit`; `-` and a `create` with no file read the piped standard input), the files of `--add`, `--desc`. A pattern `gh` expands (`'*.md'`) is also expanded and read by the front |
| `gh api` | The value of `-f key=value`, the file of `-F key=@file` (`@-` is standard input), `--input` (for JSON, each string inside) |

- It reads every way of writing a flag that `gh` accepts: `--body x`, `--body=x`, `-b x`, `-b=x`, `-bx`, and short flags bundled together such as `-cb x` (only the known switch letters of each subcommand are read as a bundle; if there is an unknown letter, it is not read as the value of a flag not in the table (`-Hfeat`)). It reads flags that come before the subcommand too
- One-letter flags are read per subcommand (`-c` is a text in `pr close` and a switch in `pr review`; `-t` is the subject in `pr merge` and an unread template in `gh api`). The front's table of flags and switches is a single "group → subcommand" table
- `gh api` is read whatever the method. A field is text sent to GitHub, so it is stopped even when a value appears in a search `-f q=…`
- Standard input is read as bytes, and the same bytes are handed to the real `gh`. The body of a pipe or file descriptor (`<(…)`) can be read only once, so what was read is put in a temporary file (permission 600), the argument is replaced with its path, and it is handed over. It is deleted when `gh` returns
- Everything else (the other arguments, the exit code, the output) is unchanged
- An unreadable file is passed on unchecked, only that file (`gh` reports the failure in its own words). The other texts of the same command are checked

Kinds it checks: `approval-url` (a URL with `user_code=`), `device-code`, `aws-key`, `github-token`, `private-key`, `bearer-token`, `account-id`, `sso-start-url`, `invite-secret` (the value after `#k=`), `aws-profile` (below). Masked writings (`XXXX-XXXX`, `#k=…`, `<profile>`) do not hit.

`account-id` looks at 12-digit numbers by value and by context (decided 2026-10-23). A 12-digit number also appears by accident inside UUIDs, hashes and ids, so rather than adding exceptions by shape, it hits only what has a reason to hit.
- Value: a 12-digit number written in the AWS config of the host where the check runs (`AWS_CONFIG_FILE`, otherwise `~/.aws/config`; the same one file as `aws-profile`) (`sso_account_id`, inside an ARN such as `role_arn`) hits wherever it is written, with no word needed, as long as it is not adjacent to other digits (bare, embedded in a profile name such as `dev<12 digits>-admin`, at the position of the last group of a UUID). The config's values are used only for comparison; they are not written to a file and not hashed
- Context: a 12-digit number not in the config hits when it is inside an ARN (`arn:aws:iam::<12 digits>:`, also when `:` is `%3A`), inside a word named as a profile (`--profile dev<12 digits>-admin`, `AWS_PROFILE=`), or is a 12-digit number not adjacent to alphanumerics (`-` and `_` are fine: `Admin-<12 digits>`, `<12 digits>_Admin`) and the same line or the preceding label has an account word (`account` / `アカウント` / `プロファイル`) or an AWS word (`aws` / `iam` / `sso` / `arn` / `role` / `profile`). A 12-digit number adjacent to letters (inside a hex hash or a DER prefix) is not hit by context even when an AWS word is on the same line. An accidental 12-digit number on a line with context (such as the UUID of an AWS request id) hits
- Does not hit: a 12-digit number of an account not in the config with no context (a bare ID of another account also passes; this was accepted on 2026-10-23 as a decision that narrows the scope of the security check). Masked writings, and the two numbers used as examples in the cloud document (`123456789012` / `000000000000`)
- Where there is no config (`secret-scan.yml` in Actions, the user's own machine), only 12-digit numbers with context hit

It keeps no list of exceptions and no configuration. When a false positive stops a post, the rule is fixed so that it goes away (the policy decided 2026-09-30).

`aws-profile` hits a line that contains, as a word, a name of a `[profile <name>]` or `[sso-session <name>]` in the AWS config of the host where the check runs (`AWS_CONFIG_FILE`, otherwise `~/.aws/config`) (SSO session names too). The shape of a name cannot tell it apart, so the rule reads the names from the config. `default` is not read as a name. When the characters before or after the name are alphanumerics, `_` or `-` (`<name>-host`), it is a different word and does not hit, and case is not distinguished. A name made only of letters cannot be told from an ordinary word (a noun), so it hits only in a position where it is named as a profile or session: `--profile <name>`, `AWS_PROFILE=<name>`, `[profile <name>]`, `sso_session = <name>` (a name that is an ordinary word floods prose with false positives, so the rule was narrowed on 2026-10-14. False positives are not removed by a list or configuration; the rule is fixed). On a host where the config cannot be read (`secret-scan.yml` in Actions), it hits nothing. A hit gives only the kind and the line number, never the name. There is no setting to turn it off.

## Writes to the public copy

The second check. It keeps the process of someone who clones the tree that is published and develops in their own repository from writing to the public side. The judgement for the public side is the kit's `publicCopyRefusal` (`ops-kit/src/config.ts`), which holds no repository name: it stops when the write target equals the `publicSync.target` of the nearest `ops.config.json` (only the string is read; `parseConfig` is not run).

- Writes (`writeTargetOf`): the non-read subcommands of `issue` / `pr` / `label` / `release`, `gh api` other than GET / HEAD (with no method but with fields, POST), and a `graphql` mutation. The target is, in order, `-R` / `--repo` (anywhere before or after the group), the URL of an Issue or PR, then `GH_REPO`. `{owner}/{repo}` and `graphql` use `GH_REPO`
- If the target is another repository, it passes. If the target is the public side or unspecified, it stops when `GH_REPO` is the public side or when the real `gh repo view` says the public side. `gh repo view` answers from the remote without looking at `GH_REPO`, so a `-R "$(gh repo view …)"` in a clone where only `GH_REPO` was fixed also stops. For reads and for writes that name another repository, `gh repo view` is not called
- In the development origin's clone, `gh repo view` says the development origin, so operations that name the public side with `-R` (the sync PR, replying to and closing the request Issues) pass
- The targets of the clone's git config `ops-kit.noWrite` (`owner/name`, several allowed; the mark of a workspace added from someone else's repository) are stopped by `noWriteMarkRefusal` both when named and by default. Unlike the public side, no clone may write there, so it does not wait for the answer of `gh repo view`, and a write that does not specify a target is also stopped when `gh repo view` does not answer. The judgement of the mark is `noWriteMarkRefusal` and that of the public side is `publicCopyRefusal`; `repoOf` and `backlogRepoOf` go through `noWriteRefusal`, which combines the two. A clone without the mark is as before
- The kit's tool `repoOf` (`ops-kit/src/gh.ts`) and the daemon's backlog `backlogRepoOf` (`packages/core/src/backlog.ts`; the targets of import, the report of a failed promotion, and the instruction presets) stop by the same judgement. In the daemon, a sentence appears on the backlog screen as an import failure and the sender is not saved, so no sending happens either. The scheduled secret scan, which only reads, is not stopped

## Direct writes to Issues from inside an app Task

- When `BACKLOG_URL` is present (inside an app Task), a write to the backlog (Issues, comments, labels, Project items) of that workspace's repository (`GH_REPO`, otherwise origin; decided the same way as `ops-kit backlog`) and of the other GitHub repositories the app syncs (`syncs` of `GET /api/backlog`; it is asked only for a write to a backlog that names something other than the workspace; if the app is unreachable or does not answer within 5 seconds, it decides with the workspace alone and prints one line to stderr) is stopped with exit 1 without being written, before the secret check, however it is written, and the front points to the equivalent `ops-kit backlog` command (`backlogWrite`. A direct write makes the source of the app's next edit stale and conflicts when it is sent). What it stops: `gh issue create (new) / comment / edit / close / reopen / delete / transfer`, `gh label create / edit / delete / clone` (label definitions; the guidance is `ops-kit sync-labels`), the non-GET / HEAD writes of `gh api` to `repos/<o>/<r>/issues…` and `repos/<o>/<r>/labels…` (with no method but with fields, POST. `labels` is the label definition, and the guidance is `ops-kit sync-labels`. `issues/<n>/lock` passes), the mutations of `gh api graphql` on Issues, comments, labels (also the definitions `createLabel` / `updateLabel` / `deleteLabel`), sub-issues and Project items, and `deleteIssue` / `transferIssue` (the list of names is `BACKLOG_MUTATIONS`; read from the fields and from the content of `--input`), and `gh project item-add / item-edit / item-delete / item-archive`. graphql and `gh project` do not look up a node id or a Project on GitHub, and are treated as a write to the workspace, the same as an unnamed `gh issue`
- What it passes: a `-R` / `--repo`, an Issue URL or a `gh api` path that is a repository the app does not know (such as a reply to an Issue on the public side), PRs (`gh pr comment` and `pulls/…`; in REST a PR is also an Issue, so `issues/<PR number>/comments` is stopped, and graphql's `addComment` is also stopped because it does not look up the node id), Actions, git refs, contents, Releases, reads, graphql queries and the creation of Projects and fields (`createProjectV2*`), and locking and pinning of Issues (`gh issue lock / unlock / pin / unpin`, REST `issues/<n>/lock`, graphql `lockLockable` / `unlockLockable` / `pinIssue` / `unpinIssue`; these are not values the app syncs and do not conflict with its storage. The criterion for stopping is "does it conflict with the app's storage" (decided 2026-11-06)). It is a brake, not enforcement (a Task of the same OS user can call the real `gh`)
- A temporary way around: only when `ops-kit backlog` is broken or cannot reach the app, write that one time with `env -u BACKLOG_URL gh …` (the second line of the guidance when it stops). The secret check and the public-side check remain. A directly written value enters at the app's next import, and if that Issue has a pending send, it conflicts
- For an operation that has no equivalent in `ops-kit backlog` (Issue delete / transfer; the CLI, REST `issues/<n>/transfer`, graphql), the guidance when it stops is one line saying "that operation may be written with `env -u BACKLOG_URL gh …`", and the second line above (only when broken) is not shown (`NO_EQUIVALENT`. This one line decides how to write the operation when a Task wants to do it)

## What it does not stop

- A `gh` that writes the body in an interactive editor (the command has no text)
- Posts that do not use `gh` (calling the API directly with `curl`, the GitHub tool of MCP)
- What is written outside the host (a browser and the like)
- Commands not in the table above

`scan-issues` finds these afterwards (it also reads review bodies written with `gh pr review --body`). The scheduled scan below runs it.

## Scheduled scan

The scan of what is already written is one common mechanism: the daemon's schedule (2026-10-17). It looks at all registered repositories with the same rules on every firing.

- `secret-scan.yml` in Actions has no host AWS config, so it does not hit `aws-profile` (the host's scheduled scan looks at it)
- The user creates the schedule on the scheduled-tasks screen (the kind `認証の値の検査`. When it runs is a value on the scheduled-tasks screen). Like `backlog-next`, it is placed in the meta workspace, and uses neither a runner nor a Task (it uses none of the LLM allowance). It is not created on its own at startup
- On one firing, for each registered workspace it finds the repository with `gh repo view`, merges the same repository (several working folders) into one, and runs the meta checkout's `ops-kit/src/cli.ts scan-issues <owner/name>` in turn. What it reads is the host's `gh` login (the same as the backlog screen). It uses neither a new token nor Actions' share
- Per repository, it keeps in the schedule's result (`cursors` of `schedules.last_result`) the time it last started reading and the URLs of the hits, and the next firing reads only the difference with `--since <that time> --recheck <URL>...`. The time is taken just before the run, so what is written during the scan is read again next time. A repository with no record is read in full, and a repository that could not be scanned keeps the previous record
- The result goes to the log of the scheduled-tasks screen, one line per repository: `0 件（scanned M）` / `当たり N 件` and the places / `検査できなかった` (exit 2, a failure to start, a workspace whose repository cannot be identified. Only the exit number is written, and the output of the failure is not copied, because it is not known what it quotes)
- If any repository has a hit or could not be scanned, one notice goes into the notices section of Home. When a new one comes, the previous notice of the same schedule is closed. It is closed when read. The title is `認証の値の検査: 当たり N 件 / 検査できなかった K リポジトリ`; the body is what the user should do (open the URL and check that it is real / if real, revoke the value and then delete the comment / if a false positive, close it) plus only the URL, the kind and the repository name (only the lines of `scan-issues` output in the shape of a hit are copied, so no value gets in). On a day with 0 hits, no note is made
- On a day the host was stopped, it runs once at the first check after waking (a schedule past its time fires only once, and the next is the next time of that cron. Schedules also go into the time that wakes the host)
- `.github/workflows/secret-scan.yml` (this repository, once a week) remains as a backup outside the host

Do not build the same mechanism (your own scan, hook or periodic workflow) in an individual repository. The rules, the way of stopping and the scheduled scan would each exist twice, and one would be fixed or omitted without the other. A per-repository workflow needs a token that reads other repositories or a copy per repository. A missing rule or reading range is added on the common side (on 2026-10-17 the per-repository scan was moved to the common mechanism).

## Out of scope

- A setting, flag or environment variable that turns the check off. A false positive is fixed by correcting the rules of `findSecrets` so that it goes away
- Automatic deletion of a hit value or rewriting it with masking characters. Deletion is the user's decision (an edit leaves the original text in the history)
- A route for an unattended run to receive approval. It is handled separately
