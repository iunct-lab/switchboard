# Permission modes — align with the terminal, change from the UI

Since 2026-09-07. Before this, every Claude task from Switchboard asked for every tool: the adapter passed `--permission-mode default`, and `claude -p` (unlike an interactive `claude`) neither starts in `auto` nor reads `permissions.defaultMode`. Now the runner's own mode is a first-class task property.

## Principle

Switchboard delegates risk decisions to the runner (Knowledge `approval:` rules excepted, since 2026-09-06): Claude Code's `auto` classifier and Codex's sandbox + approval policy + reviewer. Switchboard selects Auto as its default; on Codex, its Auto uses automatic risk review rather than human review at sandbox boundaries. Human approval requests emitted by the runner reach the UI as `permission.ask`. Defaults retain risk review, but can execute approved actions without a human prompt. Unconditional full-access modes are flagged `danger` and must be picked explicitly.

### Counting what the classifier decided

The classifier's decisions are counted per Task, not reported anywhere else. A local Claude Task sends its OpenTelemetry
logs to the daemon's loopback receiver only (metrics and traces off, the parent's `OTEL_*` dropped); the daemon keeps
the `tool_decision` records with an `allow` / `block` verdict as the Task's `classifier.decision` events (verdict, mode,
category, tool and call id — no tool input, no reason text) and shows "allowed M / stopped N" on the Task's Brief. A
`block` does not ask the person: it is `permission_denied` and a failed `tool.result` (Claude Code 2.1.312 and 2.1.314,
recorded). What was recorded asking is the denial limit: the third block in a row and each one after it (2.1.314). The
CLI also asks at the twentieth in a session and on a Chrome floor block (read, not observed). The recorded ask carries
no verdict in OpenTelemetry; it is the `permission.ask` with `reason: "classifier"`, and an allow to it counts as the intervention
kind "after the classifier" rather than as an approval. No such allow has been observed (the recording answers deny, and
no Task has recorded such an ask as of 2026-10-30), so that count is 0 so far. Codex's automatic review and cloud Tasks
are not counted (shown as unknown, not 0). The values are in [claude-otel.md](claude-otel.md).

## Modes per runner

| runner | modes (`permissionMode`) | default | live switch |
|---|---|---|---|
| Claude | `auto` · `acceptEdits` · `default` · `plan` · `dontAsk` · `bypassPermissions` (danger) | `auto` (what an interactive `claude` starts in on Pro / Max / Team) | yes — `set_permission_mode` control request, takes effect immediately (`claude-stream-json.md`) |
| Codex | `auto` · `on-request` (manual boundary review) · `read-only` · `untrusted` · `full-access` (danger) | `auto` = workspace-write + on-request + auto_review | from the next turn — `turn/start` overrides approvalPolicy / sandboxPolicy / approvalsReviewer (`codex-app-server.md`) |
| DAK | none (`permissionModes: []`) | — | — (DAK's `require_confirmation` and `mcp.yaml` decide; same as `adk web`) |

Saved answer policies (`回答の方針`, since 2026-10-17) are checked after the Knowledge `confirm` rules and before `allow`; the runner's approval mode and the runner's own refusals are not changed by them.

Saved instructions (`定型の指示`, since 2026-10-21) only build the text to send: they carry no mode and change neither the approval mode nor the approval rules.

Workspace MCP `exec.run` approvals (`mcp.yaml`) are Switchboard's own and independent of the runner mode.

On Codex, Auto delegates boundary approvals to the runner's risk-based reviewer, comparable in purpose to Claude's classifier. The sandbox and network restrictions remain active. Start, resume and each turn explicitly set `approvalsReviewer`; manual modes reset it to `user`. Rejection can stop an action or lead to a safer alternative, without necessarily opening a human approval dialog. Review notifications and rationale are retained as transcript status events. Manual approval remains a one-time accept, not a persisted command rule. In the manual modes an MCP tool call that Codex asks about becomes a `permission.ask` named `MCP <server>.<tool>`, shown on the approval card like any other; the event also carries the server's own declaration (`mcpHint`: read-only, destructive, write, or unknown). The declaration is the server's claim, so it never lets Switchboard skip the approval or answer for the person.

Auto's workspace-write sandbox also blocks loopback connections to the daemon on this host (`BACKLOG_URL`, `DEVICE_AUTH_URL`, and an extra reviewer listening on localhost). The sandbox network stays closed: when `ops-kit backlog` is refused (`EPERM` / `EACCES`), it says the sandbox blocked the connection and to rerun the same command once as an approved run, and the reviewer decides that run. So that the reviewer finds the permission in the conversation, the implementation prompts (`/pbi-complete` start, resume and another repository, and `すぐ直す`) name as part of the request handing the review material (fresh clone code, PR / Task / PBI bodies, diff) to the other runner and the extra reviewer, and the Issues the skills file (review findings, request Issues and PBIs).

Verified 2026-09-20 on codex-cli 0.155.0-alpha.2.6: `curl -I --max-time 10 https://example.com` failed sandbox DNS, was auto-reviewed as low-risk/approved, then returned HTTP 200 without a manual request. Recorded notifications (outside Git; record your own outside Git with the `runner-adapter-recording` skill): `packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl`. Existing Auto tasks receive the reviewer on their next start/resume/turn; a turn already in flight keeps its current setting.

## Allow rules a task gets (2026-11-03)

Auto mode's classifier refused operations the skills ask for — in the 7 days to 2026-10-20, 30 permission stops (merges after the merge gate said merge, posting the gate's marks, resolving review threads, editing skill files), and the user's OK in the conversation did not lift a second refusal. Pushes of rebased branches and Issue / Project Status writes were refused the same way. So the daemon passes Claude Code `permissions.allow` rules to a task, in the same `--settings` JSON as the guard hooks (`taskAllowRules` in `packages/core/src/tasks/sessions.ts`; only when the meta workspace exists, like the hooks):

| rule | why |
|---|---|
| `Bash(bun scripts/merge-gate.ts:*)`, `Bash(bun <meta>/scripts/merge-gate.ts:*)` | the merge: `--merge` / `--merge-stack` merge only on a merge verdict (the usage line of `scripts/merge-gate.ts`). The second form is another repository's task |
| `Bash(bun scripts/promote.ts:*)`, `Bash(bun <meta>/scripts/promote.ts:*)` | the promotion after a merge: it counts the busy tasks without the calling one and asks only when none is left, then with `force` (`force` skips the daemon's busy check as a whole; leaving out only the calling task is the script's own count) (exit 1 when others run or wait, 2 when it cannot judge or cannot ask). The second form is another repository's task |
| `Bash(bun scripts/parallel-guard.ts release:*)`, `Bash(bun <meta>/scripts/parallel-guard.ts release:*)` | releasing the task's claim at the end. `claim` and `--takeover` are not included |
| `Bash(ops-kit pr resolve-thread:*)` | resolving a review thread: one mutation, not a general `gh api graphql` |
| `Bash(gh pr comment:*)` | the gate's marks (`[merge-ask]` / `[merge-answer]` / `[recheck]` / `[local-ci]`). The check in front of `gh` (`docs/design/secret-guard.md`) still reads every post |
| `Bash(gh stack submit:*)`, `Bash(gh stack push:*)` | pushing the stack: these write only the stack's branches |
| `Bash(ops-kit pr push-rebased)` | pushing a rebased branch: no arguments, `--force-with-lease` of the current branch only; it refuses the default branch and a detached HEAD |
| `Bash(ops-kit backlog:*)` | Issue and Project writes go through the app, and the app and the check in front of `gh` read the values |
| `Edit` / `Write` of `//<cwd>/ops-kit/skills/**`, `//<cwd>/.claude/skills/**` and the same under `//<cwd>-*/` | editing the skills in the task's folder and its worktrees (CLAUDE.md names them `<folder>-<topic>`; a worktree is made after the task starts, so it cannot be listed then). A worktree named otherwise is left to auto mode. `~/.claude/skills` is not included |

Not allowed (left to auto mode): a bare `gh pr merge` / `gh stack merge` (it would merge past the gate), a bare `git push --force` / `--force-with-lease` (a prefix match cannot exclude main as the destination), `parallel-guard claim` and `--takeover`, `ops-kit task send` (a hijacked task could send instructions to any other task without approval), a direct `POST /api/daemon/promote` (for example with `curl`; it could send `force`), `gh api graphql`, deploys (`sam deploy`, CloudFormation, IAM — decided 2026-10-29), writing or deleting secrets, destructive host operations. Codex tasks get none (`StartOptions.allow` is read by the Claude adapter only). The permission mode itself stays `auto`.

What this protects and what it does not: only the operations the skills name are allowed, the merge only through the gate, and only in tasks Switchboard starts (a terminal `claude` does not get them). A task runs as the same OS user, so it can do the same by another way (another command, the API directly) — the loopback trust model; the rules are a default so that the skills' steps do not stop, not a fence. A task that starts between the promotion script's check and its request can still be cut by the restart. Stopping a rewrite of main is the job of GitHub's branch protection, not of these rules. Skill edits still reach main only through a PR, the other runner's review and the gate's responsibility recheck. A sibling folder that happens to match `<cwd>-*` gets the skill-edit rule too. Whether an allow rule takes effect before auto mode's classifier is checked on a real Claude task after the rules are running (checked 2026-11-03).

## Grants: the person's own words for one refused operation

Auto mode's classifier counts some operations (registering a schedule, changing settings — the soft-deny rules that say the user must name the operation) as allowed only when the person's own message names that operation. Text a task reads with a tool (an Issue comment, an API response) does not count. Answering a choice by its letter (`B`) does not name the operation either.

A grant (`許可文` on screen) is one sentence that names the operation, its target and what it does — "allow only registering schedule X with enabled: false by POST /api/schedules". It reaches the task as the person's reply, once, by three paths:

- **A choice**: an operational check or a decision may end a choice's line with ` — 許可: <grant>` (the issue-workflow skill's `判断待ちの出し方`). `Ask.grants` carries it per choice. Choosing that choice on the `判断待ち` screen or the task's screen sends the choice's line as it is, grant included.
- **A refused stop**: a stop report with reason `permission` may carry `grant`, allowing only the refused operation (`stopRecoveryPrompt` in `packages/core/src/stops.ts` says how). Such a stop is not shown as the runner's refusal: its card has `この操作だけ許可して続ける`, which sends the grant (`answer.kind: "grant"`). A stop without a grant stays the runner's refusal, as before.
- **A refused reply to another task**: when `ops-kit task send` is refused, the stop report's `grant` names it: "allow only replying to Task <id> with <gist>" (on screen, `Task <id> に <要旨> を返信することだけ許可します`). Like any grant, it covers that one reply only.
- **A stage task's next prompt**: an answer given on the app's screen to a backlog question is written as a `## 回答` whose operation keeps a `screen` mark. The next stage task's first prompt carries the newest such answer as the person's words (`screenAnswer` in `packages/core/src/backlog-edit.ts`) — only if the comment is still what the screen sent. A `## 回答` written on GitHub, an edited one, or one a saved policy gave is not carried; the task still reads those with `ops-kit backlog view`.

A grant does not spread: it is never saved as an answer policy (`POST /api/asks/answer` refuses a grant with a policy, and a question with a grant offers no scope), never becomes a `--settings` allow rule, and applies to no other task and to no later operation of the same task. Whether a grant lets the operation through is the runner's classifier's decision; Switchboard does not change it.

What this does not protect: a task runs as the same OS user, so it can call the answer API itself and send a grant to a task (the loopback trust model). The runner's classifier then judges that call as what it is.

### Merge grants: three fixed sentences the app records

Some operations a task must not take without the person: merging a pull request the merge gate did not approve, posting the gate's `[merge-answer] yes` mark, and adding a path to the task's body after the gate stopped for a file the body does not name. The person lets one of them through by sending one of these sentences, at the end of a line of a message to the task, or at the end of a part of a line that ` — 許可: ` separates (a closing full stop is fine; a longer clause after it, or a different verb, is not a grant; what comes before it in that part is not read):

- `PR #<n> を判定の外でマージしてよい` — kind `merge`
- `PR #<n> に [merge-answer] yes を投稿してよい` — kind `answer`
- `Task #<k> の本文に名指しのパスを足してよい` — kind `scope`

A sentence may start with `<owner/name> の ` to name the repository it is for (`acme/lib の PR #<n> を判定の外でマージしてよい`); without it the sentence is for the task's own repository: the name the backlog of its workspace goes by (the GitHub repository it syncs with; a backlog kept only in the app has a name of its own, and the grant is then also recorded for the GitHub repository the task's directory's `origin` names), else that `origin` alone. A sentence that names none in a task that has none is not recorded: no grant is made for "any repository". A quoted line (one that starts with `>`) is not read — a quote repeats someone's words, it does not give a grant.

The daemon reads every such line in a text sent to a task (a message — `POST /api/tasks/:id/send` or the socket's `task.send` —, a note sent with resume now (`POST /api/tasks/:id/resume`'s `text`, recorded once the resume is sent), a choice or question answer, whose chosen line carries the grant at its end as `— 許可: <sentence>`, and a refused stop's grant answered with `answer.kind: "grant"`; not an answer a saved answer policy made) and stores one record per grant in `task_grants`:

| Field | What it says |
|---|---|
| `task_id` | the task the grant is for; it holds for that task's conversation and is not used up, so a retry of the same merge of the same head is not stopped a second time |
| `repo` | the repository (lower case) the number belongs to |
| `kind`, `target` | which of the three steps, and the PR or Task number |
| `head` | for `merge` and `answer`: the head the pull request had when the grant was recorded (read from GitHub then; for a backlog kept in the app, the tip of the change's branch). Empty when it could not be read. A `scope` grant has none |
| `by` | how the text came in: `owner`, `api` or `task:<id>` (below) |
| `source` | the screen answer the sentence was read from (its comment operation's id); empty for a sentence said to the task directly |
| `at` | when it was last given |

**A grant is for the head recorded with it.** A `merge` or `answer` grant answers only for the head recorded with it, and that head is read when the grant is recorded, not when the person wrote the sentence. For a sentence said to a task the two are the same moment. For a grant in a screen answer of an Issue they are not: the answer is recorded as a grant when the next stage task starts, with the head the pull request has at that start. If the head moves between the answer and that start, the grant is for the moved head — one the person did not see when answering. So what holds is "the head at the time of recording", and "what the person saw" only where nothing was pushed in between; the answer does not carry the head it was given for. A commit pushed after the grant is recorded is a different head: the check asks again. That includes the rebase GitHub makes after a pull request below it in a stack is merged — the same rule a `[merge-answer] yes` already follows (the gate counts one only for the head it names), so there is one notion and not two. A grant whose head could not be read, and every grant recorded before grants carried a head, answers for no head. The check in front of `gh` asks with the head the command names (`--match-head-commit`), else with the pull request's head now, and adds `--match-head-commit <that head>` to a `gh pr merge` it lets through, so GitHub merges only the head that was checked; `gh stack merge` and a merge through `gh api` cannot carry it and are checked against the head read just before. A `[merge-answer] yes` is checked against the head its own line names; one that names none is not posted.

**What `by` means, and what it does not.** On loopback the daemon cannot tell the person from a task: both reach the same routes as the same OS user, and a task can also write the database. So `by` records how the text came in, not who typed it:

- `owner` — nothing said it was someone else: the request named no sending task and looked like the web UI's (this origin with `Sec-Fetch-Site: same-origin`; on the cloud host, the login cookie). A screen answer of the Issue is the same rule one step earlier: an answer route (`POST /api/backlog/:n/answer`, `POST /api/asks/answer`) marks an answer as the screen's only when its own request looked like the web UI's and named no sending task; an answer a bare call or a task posted still answers the question, is kept with `by: api` / `by: task:<id>` on its stored operation, and is never the person's words or permission to the next stage task.
- `api` — the request named no sending task and did not look like the web UI's: a bare call of the API, also over the socket (`task.send`; the web UI does not send replies there).
- `task:<id>` — the request said it came from that task. `POST /api/tasks/:id/send` takes `from` (`ops-kit task send` always sends it): the text then reaches the runner under the line `（Task <id> からの返信）`, which the daemon writes. `POST /api/backlog/:n/answer` takes the same `from`.

Every route that can record a grant decides this through one function (`grantSource` in `packages/core/src/server/task-hooks.ts`): `POST /api/tasks/:id/send`, `POST /api/tasks/:id/resume`, `POST /api/asks/answer` (a reply to a task's question, and an answer to an Issue's), `POST /api/backlog/:n/answer`, and the start of a stage task, which records the grants of an answer those routes marked. The socket's `task.send` is always `api`. A caller of the recording function that does not say how the text came in is recorded as `api`.

Only `owner` answers a check. This is advice against mistakes — a forgotten `from`, a text relayed from another task, a bare `curl` — and **not a boundary**: a task that sets the two headers, or leaves `from` out of a request made to look like the screen's, is recorded as `owner`. The same holds for which task a check speaks for: the check in front of `gh` reads the task from `OPS_KIT_TASK_ID` and finds the app through `BACKLOG_URL`, both of which the task's own shell can change. The record keeps a slip from passing; it does not fence a task.

A question tool's option may carry a grant sentence in its description (`… — 許可: <sentence>`); choosing that option sends the sentence as part of the answer. The screen shows the description beside the option's label, so the sentence is visible where the choice is made.

A stage task with an Issue gets the person's answer as its Issue's `## 回答`, which starts the next stage task; the grant sentences in that answer (the screen's, as `screenAnswer` reads it — the newest answer of the Issue or of one of its Tasks) are stored for the first stage task other than a `check` stage task started after that answer, whatever started it (the answer, a button or a schedule), and not for later ones. That an answer gave its grants is read from the records themselves: an answer whose id stands in a record's `source` is spent, however long ago and however many answers came since. An answer without a grant sentence leaves no record.

The record only answers; what stops a step is its caller. `GET /api/merge-grants?taskId=&repo=&kind=&target=&head=` (`{ granted }`) is for a check in front of `gh` that refuses a merge without a grant; where no such check runs, these records stop nothing. `head` is the head about to be merged, or the head the `[merge-answer] yes` names; a `merge` or `answer` check without it is answered `false`. The caller asks with the repository it is about to write to: the one the command names (`-R`, `GH_REPO`, the path of a `gh api` call, a pull request URL), else the clone's own; when it cannot tell which, it does not ask and refuses. `POST /api/merge-grants/scope-stop {taskId, repo, issue, pr}` is for the merge gate, to record that it stopped PR `pr` of `repo` for a file the task `issue` does not name; `GET /api/merge-grants/scope-stop?taskId=&repo=&issue=` answers `{ stopped, granted }`, where `granted` is true only when a `scope` grant for that issue was given after the stop. All of them need `repo` (400 without it) and use the same login as the rest of the API. As above, a task runs as the same OS user and can send these sentences to itself through the API without `from`; the record keeps a slip from passing, it does not fence a task. `ops-kit backlog edit` asks `GET /api/merge-grants/scope-stop` before it saves a Task's body that names more paths than before, and refuses to save while the gate's stop stands and no `scope` grant came after it. It counts as a path every path the merge gate counts as named (the `scopeIn` reading in `ops-kit/src/task-paths.ts`: paths in plain text and inside a command span such as `bun test <path>`, not only paths in backticks), against the names at the top of the clone's `HEAD`.

The tables `merge_grants` and `merge_scope_stops` held these records before they named a repository and a giver. Their rows were moved once (under the repository of each task's workspace, as the person's; the answers remembered as used became spent sources) and the tables stay, unread, because migrations only add. The moved rows did not say how their text had come in (a text another task sent used to be recorded like the person's) and carry no head, so none of them answers a `merge` or `answer` check: the person is asked again. A release rolled back to writes its list of used answers into the settings again; it is folded into the records at every start, not once.

## Where the value comes from

`TaskManager.resolvePermissionMode`: explicit `CreateTaskInput.permissionMode` → saved runner default (`settings.defaultPermissionMode[runner]`) → adapter default. The resolved value is stored on the task (`tasks.permission_mode`) so the record says what the task actually ran with; a runner without modes stores `null`. Unknown values are rejected with 400 (`RunnerAdapter.permissionModes` is the authority); a stale saved default falls back to the adapter default instead of failing the task.

## API

- `GET /api/health` — `runners[].permissionModes` (value / label / description / danger) and `runners[].defaultPermissionMode` (effective: saved setting, else adapter default).
- `GET /api/settings` / `PATCH /api/settings {defaultPermissionMode: {claude: "plan", codex: null}}` — save / clear a runner default (sqlite `settings` table). Validated against the runner's list.
- `POST /api/tasks {…, permissionMode}` — per task.
- `POST /api/tasks/:id/permission-mode {mode}` — change an existing task. Live session with `setPermissionMode` → the runner is asked first and the record changes only once it confirmed (Claude answers the control request; a refusal is a 409 and a `permission mode not changed` note; Codex applies from its next turn); otherwise the idle process is released and the next turn resumes with the new mode (a turn in flight keeps taking follow-ups on the old process and the restart happens at the next idle turn — never two processes). A `status` line records the change in the transcript.

A mode flagged `danger` cannot be saved as a default (400) — it is a per-task choice, because schedules run unattended on the default. `null` clears a saved default even for a runner that is no longer detected.

Tasks created before 2026-09-07 have `permission_mode` NULL; when such a task is resumed the mode is resolved the same way (saved default → adapter default) and recorded on the row.

Schedules carry no mode of their own: a fired task uses the saved runner default.
