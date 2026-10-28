# Tasks in the cloud (Claude Code on the web): Local/Cloud Task usage and contract (PBI #1106)

Investigation date: 2026-10-10. Installed CLI: **2.1.293**.
This describes the implemented PBI #1106 stack. The first pipe invocation
was refused; the later authorized PTY invocation created a session. Local behaviour stays as defined
in [claude-stream-json.md](claude-stream-json.md).

## Start from Switchboard

1. Complete the installed Claude Code CLI's subscription login and initial
   setup interactively yourself. If Cloud is unavailable, follow the error
   guidance below; Switchboard does not answer setup or trust prompts. A
   folder Claude Code has not yet trusted stops Cloud creation at its trust
   dialog; see [Folder trust](#folder-trust).
2. On Home, choose Claude and the execution location. Local is the default;
   other runners use Local. For Cloud, select the Workspace explicitly.
3. Check the repository, branch, uncommitted changes, unpushed commits and
   transfer notice. Unknown values remain unknown. Cloud selection plus
   Start consents to the official CLI's automatic transfer choice.
4. Enter a new task description and press Start. Local model, approval mode,
   attachments, budget and shadow choices are not sent to Cloud. Existing
   session IDs/URLs are refused; this action creates a new session.
5. Open **公式Cloudで続ける** on the resulting Task. Use the official Web UI
   for replies, approvals, model changes and stopping the Cloud workload.
   Switchboard reports the Cloud state as unconfirmed, and does not report
   unobserved usage or costs as zero. A launcher ending is not completion.

If no validated session reference appears, check the official Web UI for a
session before deciding on another start. Switchboard never retries creation
automatically. The same official link is available at smartphone width.

## Folder trust

Local Tasks run non-interactively (`claude -p`) and never meet Claude Code's
trust dialog, so a repository that works Locally can still stop Cloud creation:
Cloud runs the interactive CLI in a PTY, which asks "Quick safety check … Yes, I
trust this folder" for a folder it has not trusted (CLI **2.1.296**; recording
`packages/adapters/claude/fixtures/cloud-trust-prompt.txt`, kept outside Git: record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history). The dialog appears
before authentication.

- **Where trust is recorded**: `projects["<absolute path>"].hasTrustDialogAccepted`
  in `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
- **Not verified**: whether a trusted parent covers a subfolder (a scripted
  approval over the PTY was not accepted by the CLI). An ancestor-only record is
  therefore treated as unknown, not as trusted.
- **Before starting** (`claudeFolderTrust`, read-only): a record on the folder →
  `trusted`; the config is readable and neither the folder nor an ancestor has a
  record → `untrusted`; anything else (no file, not JSON, no `projects`,
  ancestor-only) → `unknown`. `untrusted` does not start the CLI: the Task ends
  with the guidance as its error, and Home's preparation shows the same text in
  its warnings before Start. `trusted` and `unknown` start as before.
- **After starting**: if the dialog text appears, the CLI is stopped at once (no
  60 s wait) and the Task's error is the same guidance: run `cd <folder>` →
  `claude` in your own terminal, choose "Yes, I trust this folder", exit, and
  create the Cloud Task again.
- **What Switchboard never does**: answer the dialog, or write Claude Code's
  config. The only PTY input is the replies to the terminal's capability queries.

## Evidence and reproduction

Primary sources:

- [Cloud guide](https://code.claude.com/docs/en/claude-code-on-the-web)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)

Read-only commands used:

```sh
claude --version
claude --help
```

The installed help advertises `--cloud [description|session_id|url]`:
creation from a description and attachment from an identifier are distinct.
Help alone does not establish the new-session output, pipe support, or
lifetime. No vendor source or private API was inspected.

## Local and Cloud invocation

Local uses `-p`, input/output stream-json, initialization on stdin, the
permission host, selected model/mode, resume, scope, hooks, and the existing
`childEnv`. `ClaudeSession` handles local control messages and conversation.
None of these wire messages establish a Cloud protocol.

Cloud creation uses the documented command below in the explicitly selected
Workspace's cwd. The prompt is a single argv element, never a shell command.

```sh
claude --cloud "<user task description>"
```

Initial option allowlist: user prompt and cwd only. Do not send `-p`, local
stream-json, model, permission mode, resume, attachments, guard/MCP settings,
local daemon recap, additional directories, parallel execution, or budgets.
No public evidence found here establishes those options for new Cloud
creation. Reject explicitly supplied unsupported options before spawning;
do not silently apply saved Local defaults. Cloud-side options are managed
in the official Web UI. Keep Local arguments and environment unchanged.

Cloud child environment starts with the adapter's existing child environment
and removes `CCR_FORCE_BUNDLE`. Do not inject local task MCP credentials,
permission bridge URLs, or attachment paths. This does not mean stripping
existing CLI authentication: the CLI uses the user's own subscription login.
Do not run login or `/web-setup`, or rewrite configuration automatically.

## Observed non-interactive refusal

On 2026-10-10, the authorized creation command was run from this repository
with stdin/stdout/stderr pipes (no TTY), using CLI 2.1.293 and a prompt to
summarize the repository without modifications, commits, pushes or PRs.
The CLI exited 1, with no stdout and an explicit stderr diagnostic requiring
an interactive terminal. It names piped stdout, `--init-only` and `--sdk-url`
as unsupported non-interactive contexts for Cloud. No session ID or URL was
returned. The invocation was not retried. Authentication and Private access
were therefore not tested by this attempt.

The existing Local adapter uses pipes, so a Cloud branch that changes only
argv would fail with this installed CLI. The user approved a Cloud-specific PTY investigation. The adapter now
uses Bun's built-in terminal, with no subprocess bridge or new dependency.

## Verified PTY creation contract

After the user's authorization to finish initial setup and attempt up to 20
starts, the first invocation succeeded on 2026-10-10 (CLI 2.1.293).
The Python standard-library PTY connected all descriptors at 160x40 with
TERM=xterm-256color, from this repository, with a summary-only prompt that
prohibited modifications, commits, pushes and PRs. Initial theme default,
security notice and trust for this repository were confirmed. Production
must not automatically answer these setup/trust prompts.

Observed output, with fabricated identifiers:

```text
Created cloud session: Read this repository and briefly summarize its purpose. …
View: https://claude.ai/code/session_0123456789abcdefghijklmn?from=cli&m=0
Resume with: claude --teleport session_0123456789abcdefghijklmn
```

The launcher naturally exited 0 after creation. The URL and Teleport ID
matched. ANSI cursor/style controls were present. The follow-up JSON in
the official guide does not establish a creation JSON protocol.

Parser contract: stream-decode UTF-8, strip CSI/OSC/control sequences and
retain a bounded 64 KiB tail. Require the creation marker, View HTTPS URL
on claude.ai/code/session_…, and an identical Teleport ID; emit exactly once.
Store a canonical URL without query/fragment. Reject foreign hosts,
credentials, mismatched IDs and authorization links. Never forward raw
output. Exit 0 without a validated reference is unconfirmed, never retried.

Use Bun's built-in `Bun.spawn({terminal: {cols: 160, rows: 40, data}})`.
A local probe on Bun 1.4.2 verified all descriptors are TTY, output delivery,
and exit 0. No new dependency or change to the existing bun-pty terminal tab.
If Terminal is unavailable, refuse Cloud with an upgrade instruction and
keep Local working. Bound setup to 60 seconds. Answer terminal device/status
queries only, not setup/auth/trust prompts. A timeout closes the launcher,
gives an interactive-setup/unconfirmed instruction, and never retries.
Closing the launcher does not stop the cloud workload.

CLI auth status separately succeeded for claude.ai first-party authentication;
account details were discarded, with no credential-file inspection. Creation
proves neither successful Private clone nor Cloud completion nor Web/mobile
continuation. Remote Cloud contents were not independently inspected.

## Process exit and Task state

`executionMode` is `local | cloud`, default Local at creation. Existing DB
rows migrate once to Local. `cloudSession` is a nullable `{id, url}` value;
never copy its ID into the Local `runnerSessionId`.

The Task is running while its launcher is establishing a session. A validated
`cloud.session.created` saves the reference and moves the Task to
`status=idle`, `outcome=unknown`. The Cloud workload can continue independently.
Launcher exit 0 is not Cloud completion. A later launcher error also does
not prove the already created Cloud workload failed. Restart/orphan handling
must preserve this distinction and the reference.

No local completion judge, history fallback, automatic resume, send, mode
change, or model change applies to Cloud. Follow-up and stopping the Cloud
workload belong to the official Web UI. Closing/aborting the local launcher
must never be presented as stopping the Cloud workload. Cloud close terminates only the launcher and closes its PTY; no Local
stream-json control or Cloud stop request is sent.

## Git, transfer and consent

Cloud selection followed by Start is the user's consent to the official
CLI's automatic transfer choice. Show the transfer notice before Start,
including when the remote/App state cannot be determined. No extra consent
dialog, App-detection gate, custom transfer guard, or forced Bundle option.

The CLI can clone the current remote branch or automatically upload a local
Git bundle. `/web-setup` does not guarantee clone rather than Bundle.
Preflight reads repo/branch, dirty and unpushed state without fetch, commit,
push, stash or credential inspection; unknown values stay unknown. A remote
must be normalized to a repository name without embedded credentials.

Clone can omit local commits and changes. A full Bundle can include history
on all branches and tracked changes, with size-related reduced-history
fallbacks; untracked files are excluded. The documented upload limit is
100 MB. Linux/WSL have Git-version, layout and configuration restrictions
and omit some sensitive uncommitted files, while native Windows differs.
This is not a guarantee that committed secrets or all sensitive changes
are excluded. Users must review the contents before starting Cloud.
Switchboard neither implements those vendor filters nor stages files.

## Authentication, permissions and errors

Use the official GitHub App or the user's own `/web-setup` connection for
Private access. `/web-setup` transfers the local gh credential to the user's
Claude account and must be initiated by the user. Required repository
permissions, organization policy and subscription access remain CLI concerns.
Switchboard stores no provider credentials and performs no authentication
repair automatically.

Recognized unsupported-CLI, subscription-login, external-provider, disabled
organization-policy and repository-permission failures should yield short
reason/action messages. API-key authentication alone is insufficient.
Unknown failures get a generic creation-unconfirmed message with no raw
stderr. Recognition must use public or sanitized observed error forms;
fixtures are not proof of the installed CLI's exact messages.

## Validation and remaining work

Verified: installed version/help, official distinction between creation and
existing-session send, existing Local adapter and core exit path review,
and real CLI refusal of non-TTY creation before session startup.
`packages/core/src/tasks.ts` separates Cloud launcher exit from Local
completion and preserves idle/unknown with a validated reference.

Verified additionally: authorized setup, successful PTY creation and natural
exit 0, matching official View/Teleport reference, built-in Bun PTY probe.

Implemented validation: recorded creation fixture; adapter, migration, Git,
API and lifecycle regressions; UI rendering regressions. Browser validation:
15 fake-CLI cases at 1200/390 widths, zero console errors. Includes Local
prompt/cwd/options/environment, Cloud PTY/argv/environment, dirty/unpushed
and unknown remote, safe error guidance, a delayed stale Workspace response,
runner reset, official link and idle/unknown. Fake App-absent and web-setup
scenarios test that Switchboard adds no App gate; they do not establish any
real provider permission. Git content, index and configuration stay unchanged.

Reproduce without live Cloud usage or a real login (requires installed Chrome and the recording `cloud-trust-prompt.txt`, which you record yourself and keep outside Git with the `runner-adapter-recording` skill — `bun scripts/fixtures.ts fetch` gets it only in a clone with the private history; without the recording the script prints `skipped: …` on stderr and exits 0, or exits 2 when `SWITCHBOARD_FIXTURES` is given):

```sh
# Record cloud-trust-prompt.txt outside Git with runner-adapter-recording first.
# Only clones with the private history can use: bun scripts/fixtures.ts fetch
bun run --cwd apps/web build
env -u SWITCHBOARD_SUPERVISED CHROME_BIN=<Chrome executable> bun scripts/claude-cloud-e2e.ts
```

Expected stdout: `{"result":"pass","cases":15,"consoleErrors":0}`.
The script owns an empty temporary DB, Git fixtures and fake CLI, starts
on an unused port at or above 47911, and cleans up its daemon and browser.
Unit suite: `env -u SWITCHBOARD_SUPERVISED bun test packages apps ops-kit`;
type checks: `bun run typecheck`.

Live check (Task #1163, 2026-10-11, CLI **2.1.296**): from the running
Switchboard, Home → Claude → Cloud on a Private repository Workspace (`main`,
matching origin) created a real Cloud session. The Task got the validated
reference and stayed `idle`/`unknown`. The user saw the session in the
official app answer from the Private repository's README and continue on
follow-ups; the user accepted the app in place of a separate official Web
check. `git status --porcelain`, HEAD and the `~/.claude` settings files were
unchanged before and after. A first attempt in a Workspace whose CLI folder
trust was not yet accepted returned no creation output within 60 seconds and
ended in the creation-unconfirmed guidance; the adapter does not answer that
prompt by design. Replies do not come back to Switchboard and follow-ups
cannot be sent from it; that is the official UI's role (see above). Ask the
user for pass/fail only, never account identifiers, session URLs or QR
images. No automatic authentication repair is part of the product.

`--remote-control` exposes a locally running session to other devices; Cloud
runs on official cloud infrastructure. Teleport/local continuation is PBI
#1107 and is not an additional creation mode in this PBI.

CI の実行と、性能判定の既知不合格を区別した代替記録は
[local-ci 相当検証の手順](local-ci.md) を参照する。


## Teleport contract (Task #1127)

Investigated 2026-10-11 with CLI **2.1.296**. Sources:
[Cloud guide](https://code.claude.com/docs/en/claude-code-on-the-web#continue-a-cloud-session-in-your-terminal),
[CLI reference](https://code.claude.com/docs/en/cli-reference), public help,
and an authorized real import in a disposable repository checkout.

### Invocation and official requirements

Use argv `['--teleport', cloudId]` in the Cloud Task's repository cwd, with
an interactive PTY. Help confirms ID targeting. Never send a shell command
containing an ID, `-p`, stream-json, a model prompt or assumed local options.
`--session-id <uuid>` exists independently; its combination with Teleport
was not tested and is not needed for this contract.

The guide requires the same repository and subscription account, a clean
checkout, and the Cloud branch pushed to its remote. The CLI prompts about
stashing dirty changes and performs its own repository check, fetch and
checkout. Git/SSH fetch that needs interactive credentials can fail. The
wrapper must neither approve stash nor run reset/clean/commit/push/login.
Show reason/action guidance; do not repair authentication automatically.
API-key and external-provider configurations cannot replace the required
subscription login. Distinguish unsupported CLI, account/repository/access
problems and unavailable remote branch from an unknown import result.

Bare `--teleport` is the documented official picker fallback. Do not build
another picker. Its live interaction was not tested here; do not treat that
path as verified. Accept a fallback result only when its printed selected
Cloud ID matches the Task reference; otherwise keep the relation unconfirmed.

### Observed ID and history evidence

After repository trust was explicitly authorized, the real ID-targeted
invocation printed the target Cloud ID under the Teleport progress display,
then `Session resumed`. On normal `/exit` it printed:

```text
Resume this session with:
claude --resume 11111111-1111-4111-8111-111111111111
```

The UUID above is fabricated. The actual emitted local UUID matched both
`<local-id>.jsonl` and every session-bearing record in that file. It differed
from the targeted Cloud ID. The normal Claude projects directory received
140 records: 34 user, 36 assistant, 59 attachment, 6 system and 5 other records.
135 records carried `entrypoint: cli`; 66 user/assistant records carried
`remoteSourced: true`. The ordinary history parser therefore has a compatible
interactive log, rather than an SDK-host transcript requiring a new format.
No new model prompt was sent: only local `/status` and `/exit` commands.

A separate real `claude --resume <local-id>` invocation then opened the
ordinary interactive conversation without a model prompt, and normal `/exit`
printed the same resume UUID. HEAD, branch and status again stayed unchanged.

The log became observable at normal exit; a scan immediately after the
resumed banner had seen no changed log. Do not associate the newest file
by timing, cwd or title. The CLI's final resume UUID is the identity evidence,
not a guess based on a directory scan. Imported records did not contain the
Cloud ID, so `remoteSourced` alone cannot establish the Cloud/local relation.

The checkout HEAD, branch and status were unchanged. This session had no
new code branch to test: the observation establishes successful conversation
import, not validation of a distinct pushed Cloud change branch. That branch
scenario and dirty/permission/failure cases remain the later E2E and real
validation Tasks' work; they must not be reported as passed here.

### Minimal integration contract for subsequent Tasks

1. Start only after the Task's explicit action. Cloud launcher/session exit
   is never an import trigger. Keep the original Cloud Task and its reference.
2. Use the existing Terminal PTY for prompts, input, resize and reconnect.
   Do not resend Teleport on reconnect. Preserve the user's approval settings;
   never answer production setup/trust prompts automatically.
3. Stream-decode UTF-8 and remove terminal controls before recognizing the
   observed progress target, resumed marker and final `claude --resume <UUID>`.
   Retain bounded parser state, not raw history or terminal output in the DB.
   Recognize a single canonical UUID; ambiguous references are unconfirmed.
   The CLI draws word gaps as horizontal cursor moves: only the resumed
   marker reads those as spaces; IDs and UUIDs are read without them.
4. Require a matching printed Cloud target, resumed evidence, normal process
   exit and the emitted UUID's normal log with matching record session IDs
   and correct repository cwd before saving `sourceCloudTaskId`. A banner or
   process exit alone is insufficient. Until exit, the Terminal owns the
   session; refuse simultaneous Switchboard resume and show import pending.
5. Reuse the existing local history owner and `history_imports` offset/parser
   state, or create its usual Local Task. Cloud ID stays separate from local
   `runnerSessionId`. Repeated import scans/restarts must not duplicate events
   or ledger rows. Existing SDK-host exclusion stays in effect.
6. Cancellation, failure or missing/mismatched evidence creates no association.
   Preserve the Cloud Task and show the cause or unconfirmed result. Do not
   retry an operation that may have changed Git/history. Local continuation
   uses the usual `--resume` path; later local turns do not sync to Cloud.

This completion-at-exit contract intentionally uses the CLI's public output
and ordinary log; it needs no private API, history downloader, new dependency
or guessed metadata field. Version changes need fresh fixtures and must fail
closed when the evidence cannot be recognized.

### Observation transport and validation limits

The first observation stopped at repository trust without answering. In the
second, coalesced menu input selected Yes then returned to No and exited.
Replay of the saved cursor updates confirmed the final No selection; Git
and logs were unchanged. Those attempts did not test Teleport. The user
explicitly authorized continued work, including the needed trust setup and
additional observation, after the input problem was explained.

A scratch-only fake menu tested separate arrow/confirmation input and cursor
replay. The successful observation waited for the initialized real menu,
verified Yes, then confirmed. Scratch scripts, account details, IDs, URLs and
raw conversation output are excluded from this repository and PR.

Validation: installed version/help, authorized live import and ID/log
correlation, `bun run typecheck`, `git diff --check`. This Task changes only
this document; no runtime test was added. Subsequent Tasks add parser and
lifecycle fixtures, safety/E2E tests and branch/real-continuation validation.

## Continue an existing Cloud Task locally (#1107)

On the stopped Cloud Task, select **ローカルで続ける**. A validated Cloud reference
and PTY support are required. This is an explicit action for an existing
session, not a third execution mode on Home. The official CLI runs on the
Switchboard host in the Task's saved cwd, not the browser device. Opening a
Terminal tab, reconnecting or reloading never starts Teleport. The button
calls `POST /api/tasks/:id/teleport` (409 with the reason when refused); no
terminal socket is needed (#1306).

**What the person does (#1306).** When the CLI asks nothing, nothing more:
Switchboard waits until the CLI printed `Session resumed` for the saved Cloud
ID and its output has been quiet for a second, then writes
`/rename continued-from-cloud` and, once the CLI confirms
`Session renamed to`, `/exit` (each with Enter 300 ms later, as a separate
write: the CLI's menu mixes them up otherwise). The name is needed (#1865):
the official CLI (seen with 2.1.301 and 2.1.302) writes the resumed
conversation to its normal log only once this session records an entry, and
prints `claude --resume <UUID>` on exit only when that log exists; a bare
`/exit` right after resuming leaves neither, so the import cannot be
confirmed. `/rename` is a local command: it records the name and asks the
model nothing (checked in the CLI's debug log: no request but its start-up
quota check). The printed UUID is read under the same evidence rules as
before, and the Local Task's conversation screen opens. These two commands
are the only things Switchboard ever writes to the CLI. When the CLI asks
something (folder trust, uncommitted changes, branch) it does so before
`Session resumed`: output that stops for three seconds before that is shown
on the Cloud Task as the CLI's last lines with **ターミナルで答える**;
nothing is written. Once the person answers in the terminal and the CLI
resumes, the same `/rename` and `/exit` follow and the Local Task opens. If
the CLI does not confirm the name, or `/exit` does not end it, within ten
seconds, nothing more is sent; the screen asks for the terminal instead.

Progress is `teleporting` → (`needs-input` →) `exiting` → `importing` →
`done` (with the Local Task's id) or `unconfirmed` (with the reason). It
travels as `task.teleport` and is also in `GET /api/tasks/:id` (`teleport`);
it lives in the daemon's memory only.

Use the same claude.ai subscription account and GitHub repository as Cloud.
Check that the Cloud work branch has been pushed. The official CLI owns Git
transfer and branch selection: read and answer its prompts in Terminal.
Protect dirty and untracked files yourself; Switchboard never answers Yes,
resets, stashes, cleans, commits, pushes or changes authentication for you.
If public CLI help supports a target argument, Switchboard supplies the
saved Cloud ID; otherwise choose the session in the official picker. A
different or ambiguous printed target is not linked.

The original Cloud Task stays separate. After a normal Teleport exit,
Switchboard verifies the printed Local UUID against its normal Claude log,
imports the whole conversation through the existing history importer and
shows **Local Task: …**. When the start was pressed on that screen, the
Local Task opens by itself. Reply there to use ordinary `--resume`. The
Local Task's sticky head marks it as imported from Cloud and links back to
the original Cloud Task, so both are in view without scrolling; right after
the automatic switch, the head also names the Cloud Task it switched from,
until another screen opens. Brief links back too.
There is no automatic conversation synchronization back to Cloud.

**Where it runs (#1395).** The continuation never runs in the clone a Local
Task may be working in. Switchboard adds a Git worktree at
`<repo root>/.claude/worktrees/teleport-<Cloud Task id>` (detached at the
clone's HEAD, a clean checkout: the clone's uncommitted files are not in it),
runs the official CLI there, and imports the log with that directory as the
Local Task's cwd; replies then `--resume` in that worktree. The Cloud and Local
Task screens show **作業コピー: <path>**. Selecting the button again for the same
Cloud Task reuses the same worktree and does not touch what is in it; a
non-worktree directory at that place stops the start untouched.

A Local Task at work (running or waiting) in the clone does not block the
button and is not stopped or refused: its replies and new Tasks in the clone
carry on during Teleport. The only start refused for being busy is a Local Task
at work in this Cloud Task's own worktree (the message names it); a finished
one there that is only idling is closed first, as before (#1304), and, while
Teleport/import is active, replies to Tasks in that worktree are refused. The
only Git changes Switchboard makes are `git worktree add --detach` and one
`/.claude/worktrees/` line in the clone's `info/exclude` (so the clone's
`git status` does not list it). Branch, refs, index and working files of the
clone are untouched; the official CLI switches branch only inside the
worktree.

**Cleaning up.** Switchboard never deletes a worktree: it may hold uncommitted
changes or unpushed commits. When the work is done, check
`git -C <path> status` and push what you need (the continuation's branch becomes
a normal PR from there), then `git worktree remove <path>`. A new
dependency install (e.g. `bun install`) is not run for you; do it in the
continued conversation if needed.

Cancellation, missing proof, mismatched log/Workspace or an ownership
conflict leaves the result unconfirmed and creates no association. Read the
Terminal and saved Cloud status; **Local Taskを確認** refreshes the links. Do
not retry an operation whose Git/history effect is unknown. For an unpushed
branch, check the Cloud branch on GitHub; for a repo/account mismatch or
access error, check cwd, the account and GitHub linkage yourself.
Unsupported CLI help asks for a CLI update. API-key/external-provider
diagnostics ask for subscription authentication; Switchboard does not repair
login or provider configuration.

### Validation scope

The authorized #1127 observation (official CLI 2.1.296) verified Teleport
output/normal-log UUID correlation and ordinary CLI resume on the same
branch. It did not establish that the complete new Switchboard flow passes.
Anonymous fixtures, fake-CLI PTYs and headless Chrome cover software
behaviour without live Cloud or authentication. On 2026-10-11 the Teleport
browser E2E passed 17 cases and the existing Local/Cloud creation E2E passed
15 cases, both with zero browser console errors; the full typecheck passed.
After #1306 the Teleport E2E (`scripts/claude-teleport-e2e.ts`) passes 19
cases with zero console errors, including: no terminal input at all with the
fake CLI receiving only `/exit` and the terminal tab never opened; progress
moving from Teleport to import; a question shown with no automatic answer and
Git unchanged, answered in the terminal and followed by the same automatic
`/exit`; and the earlier failure, cancel, ownership and restart cases. The
real CLI's acceptance of `/exit` is part of the PBI's user check.
Since #1865 the fake CLI behaves like the official one: it prints the
evidence and writes the log only after `/rename`, and a bare `/exit` leaves
neither, so the E2E fails against the earlier `/exit`-only ending.
These software checks are not a live acceptance pass. The fixtures'
diagnostic strings are synthetic, not evidence of every real
account/provider error wording.

The #1133 live acceptance run (2026-10-11, CLI 2.1.296, approved by the user)
used one existing Cloud session, a fresh clone of the repository and a
separate daemon from the PBI checkout with its own data directory; no new
Cloud session was created. Results:

| Item | Result |
|---|---|
| Full target conversation | pass: 2 user prompts, 2 replies and 1 tool call/result imported as a Local Task linked to the Cloud Task |
| Work branch | **unverified**: the session had no pushed work branch; HEAD, branches, status and stash stayed unchanged |
| Ordinary CLI `--resume` | pass: opened the conversation and printed the same UUID on exit |
| Switchboard continuation | pass: a reply from the Local Task resumed the same session and answered from the imported context |

The run found that the real CLI places words with cursor moves (CSI n C /
CSI n G) instead of spaces, so the resumed marker was missed and every import
was reported unconfirmed; the resumed marker now reads those moves as
spaces (IDs and UUIDs do not). It also found that
the Teleport child inherited the daemon's `CLAUDE_CODE_*` markers when the
daemon itself was started from inside a Claude Code session; that turns the
local log off, so the import stayed unconfirmed. Teleport now starts with the
same child environment as the Claude adapter (claude-stream-json.md). bun-pty
adds the given environment to the daemon's own instead of replacing it, so
the markers are removed with `/usr/bin/env -u` in front of the CLI.
Checking the work branch needs a Cloud session that pushed one, which is a
new Cloud creation and needs separate approval. Private conversation,
identifiers, URLs, QR codes and authentication values are not recorded in
reports. Unverified items do not count as Task/PBI completion.
