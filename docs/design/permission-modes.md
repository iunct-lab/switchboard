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

On Codex, Auto delegates boundary approvals to the runner's risk-based reviewer, comparable in purpose to Claude's classifier. The sandbox and network restrictions remain active. Start, resume and each turn explicitly set `approvalsReviewer`; manual modes reset it to `user`. Rejection can stop an action or lead to a safer alternative, without necessarily opening a human approval dialog. Review notifications and rationale are retained as transcript status events. Manual approval remains a one-time accept, not a persisted command rule.

Auto's workspace-write sandbox also blocks loopback connections to the daemon on this host (`BACKLOG_URL`, `DEVICE_AUTH_URL`, and an extra reviewer listening on localhost). The sandbox network stays closed: when `ops-kit backlog` is refused (`EPERM` / `EACCES`), it says the sandbox blocked the connection and to rerun the same command once as an approved run, and the reviewer decides that run. So that the reviewer finds the permission in the conversation, the implementation prompts (`/pbi-complete` start, resume and another repository, and `すぐ直す`) name as part of the request handing the review material (fresh clone code, PR / Task / PBI bodies, diff) to the other runner and the extra reviewer, and the Issues the skills file (review findings, request Issues and PBIs).

Verified 2026-09-20 on codex-cli 0.155.0-alpha.2.6: `curl -I --max-time 10 https://example.com` failed sandbox DNS, was auto-reviewed as low-risk/approved, then returned HTTP 200 without a manual request. Recorded notifications (outside Git; record your own outside Git with the `runner-adapter-recording` skill): `packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl`. Existing Auto tasks receive the reviewer on their next start/resume/turn; a turn already in flight keeps its current setting.

## Allow rules a task gets (2026-11-03)

Auto mode's classifier refused operations the skills ask for — in the 7 days to 2026-10-20, 30 permission stops (merges after the merge gate said merge, posting the gate's marks, resolving review threads, editing skill files), and the user's OK in the conversation did not lift a second refusal. Pushes of rebased branches and Issue / Project Status writes were refused the same way. So the daemon passes Claude Code `permissions.allow` rules to a task, in the same `--settings` JSON as the guard hooks (`taskAllowRules` in `packages/core/src/tasks.ts`; only when the meta workspace exists, like the hooks):

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

Not allowed (left to auto mode): a bare `gh pr merge` / `gh stack merge` (it would merge past the gate), a bare `git push --force` / `--force-with-lease` (a prefix match cannot exclude main as the destination), `parallel-guard claim` and `--takeover`, a direct `POST /api/daemon/promote` (for example with `curl`; it could send `force`), `gh api graphql`, deploys (`sam deploy`, CloudFormation, IAM — decided 2026-10-29), writing or deleting secrets, destructive host operations. Codex tasks get none (`StartOptions.allow` is read by the Claude adapter only). The permission mode itself stays `auto`.

What this protects and what it does not: only the operations the skills name are allowed, the merge only through the gate, and only in tasks Switchboard starts (a terminal `claude` does not get them). A task runs as the same OS user, so it can do the same by another way (another command, the API directly) — the loopback trust model; the rules are a default so that the skills' steps do not stop, not a fence. A task that starts between the promotion script's check and its request can still be cut by the restart. Stopping a rewrite of main is the job of GitHub's branch protection, not of these rules. Skill edits still reach main only through a PR, the other runner's review and the gate's responsibility recheck. A sibling folder that happens to match `<cwd>-*` gets the skill-edit rule too. Whether an allow rule takes effect before auto mode's classifier is checked on a real Claude task after the rules are running (checked 2026-11-03).

## Grants: the person's own words for one refused operation

Auto mode's classifier counts some operations (registering a schedule, changing settings — the soft-deny rules that say the user must name the operation) as allowed only when the person's own message names that operation. Text a task reads with a tool (an Issue comment, an API response) does not count. Answering a choice by its letter (`B`) does not name the operation either.

A grant (`許可文` on screen) is one sentence that names the operation, its target and what it does — "allow only registering schedule X with enabled: false by POST /api/schedules". It reaches the task as the person's reply, once, by three paths:

- **A choice**: an operational check or a decision may end a choice's line with ` — 許可: <grant>` (the issue-workflow skill's `判断待ちの出し方`). `Ask.grants` carries it per choice. Choosing that choice on the `判断待ち` screen or the task's screen sends the choice's line as it is, grant included.
- **A refused stop**: a stop report with reason `permission` may carry `grant`, allowing only the refused operation (`stopRecoveryPrompt` in `packages/core/src/stops.ts` says how). Such a stop is not shown as the runner's refusal: its card has `この操作だけ許可して続ける`, which sends the grant (`answer.kind: "grant"`). A stop without a grant stays the runner's refusal, as before.
- **A stage task's next prompt**: an answer given on the app's screen to a backlog question is written as a `## 回答` whose operation keeps a `screen` mark. The next stage task's first prompt carries the newest such answer as the person's words (`screenAnswer` in `packages/core/src/backlog.ts`) — only if the comment is still what the screen sent. A `## 回答` written on GitHub, an edited one, or one a saved policy gave is not carried; the task still reads those with `ops-kit backlog view`.

A grant does not spread: it is never saved as an answer policy (`POST /api/asks/answer` refuses a grant with a policy, and a question with a grant offers no scope), never becomes a `--settings` allow rule, and applies to no other task and to no later operation of the same task. Whether a grant lets the operation through is the runner's classifier's decision; Switchboard does not change it.

What this does not protect: a task runs as the same OS user, so it can call the answer API itself and send a grant to a task (the loopback trust model). The runner's classifier then judges that call as what it is.

### Merge grants: three fixed sentences the app records

Some operations a task must not take without the person: merging a pull request the merge gate did not approve, posting the gate's `[merge-answer] yes` mark, and adding a path to the task's body after the gate stopped for a file the body does not name. The person lets one of them through by sending one of these sentences, at the end of a line of a message to the task, or at the end of a part of a line that ` — 許可: ` separates (a closing full stop is fine; a longer clause after it, or a different verb, is not a grant; what comes before it in that part is not read):

- `PR #<n> を判定の外でマージしてよい` — kind `merge`
- `PR #<n> に [merge-answer] yes を投稿してよい` — kind `answer`
- `Task #<k> の本文に名指しのパスを足してよい` — kind `scope`

The daemon reads every such line in what the person sends to a task (a message — `POST /api/tasks/:id/send` or the socket's `task.send` —, a choice or question answer, whose chosen line carries the grant at its end as `— 許可: <sentence>`, and a refused stop's grant answered with `answer.kind: "grant"`; not an answer a saved answer policy made) and stores the task, kind, target and time in `merge_grants`. A stage task with an Issue gets the person's answer as its Issue's `## 回答`, which starts the next stage task; the grant sentences in that answer (the screen's, as `screenAnswer` reads it) are stored for the first stage task other than a `check` stage task started on that Issue after that answer, whatever started it (the answer, a button or a schedule), not for later ones while it stays the newest (the answer is known by its comment operation's id, which sending it does not change). Unlike a grant above, it is not used up: it holds for that task's conversation, so a retry of the same merge is not stopped a second time. Each record holds for one task — the one the person answered, or that first stage task — and for one kind and one number. Known gaps: the record does not name a repository, so in a task that works on several repositories a grant for a number also answers for the same number in the others; and only the newest 200 answer ids are kept, so an answer pushed out of them that is still its Issue's newest grants again on the next stage task.

The record only answers; what stops a step is its caller. `GET /api/merge-grants?taskId=&kind=&target=` (`{ granted }`) is for a check in front of `gh` that refuses a merge without a grant; where no such check runs, these records stop nothing. `POST /api/merge-grants/scope-stop {taskId, issue, pr}` is for the merge gate, to record that it stopped PR `pr` for a file the task `issue` does not name; `GET /api/merge-grants/scope-stop?taskId=&issue=` answers `{ stopped, granted }`, where `granted` is true only when a `scope` grant for that issue was sent after the stop. Both use the same login as the rest of the API. As above, a task runs as the same OS user and can send these sentences to itself through the API; the record keeps a slip from passing, it does not fence a task.

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
