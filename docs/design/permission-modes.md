# Permission modes — align with the terminal, change from the UI

Issue #58. Before this, every Claude task from Switchboard asked for every tool: the adapter passed `--permission-mode default`, and `claude -p` (unlike an interactive `claude`) neither starts in `auto` nor reads `permissions.defaultMode`. Now the runner's own mode is a first-class task property.

## Principle

Switchboard delegates risk decisions to the runner (Knowledge `approval:` rules excepted, #13): Claude Code's `auto` classifier and Codex's sandbox + approval policy + reviewer. Switchboard selects Auto as its default; on Codex, its Auto uses automatic risk review rather than human review at sandbox boundaries. Human approval requests emitted by the runner reach the UI as `permission.ask`. Defaults retain risk review, but can execute approved actions without a human prompt. Unconditional full-access modes are flagged `danger` and must be picked explicitly.

## Modes per runner

| runner | modes (`permissionMode`) | default | live switch |
|---|---|---|---|
| Claude | `auto` · `acceptEdits` · `default` · `plan` · `dontAsk` · `bypassPermissions` (danger) | `auto` (what an interactive `claude` starts in on Pro / Max / Team) | yes — `set_permission_mode` control request, takes effect immediately (`claude-stream-json.md`) |
| Codex | `auto` · `on-request` (manual boundary review) · `read-only` · `untrusted` · `full-access` (danger) | `auto` = workspace-write + on-request + auto_review | from the next turn — `turn/start` overrides approvalPolicy / sandboxPolicy / approvalsReviewer (`codex-app-server.md`) |
| DAK | none (`permissionModes: []`) | — | — (DAK's `require_confirmation` and `mcp.yaml` decide; same as `adk web`) |

Saved answer policies (回答の方針, #938) are checked after the Knowledge `confirm` rules and before `allow`; the runner's approval mode and the runner's own refusals are not changed by them.

Saved instructions (定型の指示, #940) only build the text to send: they carry no mode and change neither the approval mode nor the approval rules.

Workspace MCP `exec.run` approvals (`mcp.yaml`) are Switchboard's own and independent of the runner mode.

On Codex, Auto delegates boundary approvals to the runner's risk-based reviewer, comparable in purpose to Claude's classifier. The sandbox and network restrictions remain active. Start, resume and each turn explicitly set `approvalsReviewer`; manual modes reset it to `user`. Rejection can stop an action or lead to a safer alternative, without necessarily opening a human approval dialog. Review notifications and rationale are retained as transcript status events. Manual approval remains a one-time accept, not a persisted command rule.

Auto's workspace-write sandbox also blocks loopback connections to the daemon on this host (`BACKLOG_URL`, `DEVICE_AUTH_URL`, and an extra reviewer listening on localhost). The sandbox network stays closed: when `ops-kit backlog` is refused (`EPERM` / `EACCES`), it says the sandbox blocked the connection and to rerun the same command once as an approved run, and the reviewer decides that run. So that the reviewer finds the permission in the conversation, the implementation prompts (`/pbi-complete` start, resume and another repository, and すぐ直す) name as part of the request handing the review material (fresh clone code, PR / Task / PBI bodies, diff) to the other runner and the extra reviewer, and the Issues the skills file (review findings, request Issues and PBIs).

Verified 2026-09-20 on codex-cli 0.155.0-alpha.2.6: `curl -I --max-time 10 https://example.com` failed sandbox DNS, was auto-reviewed as low-risk/approved, then returned HTTP 200 without a manual request. Recorded notifications (outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history): `packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl`. Existing Auto tasks receive the reviewer on their next start/resume/turn; a turn already in flight keeps its current setting.

## Allow rules a task gets (#2150)

Auto mode's classifier refused operations the skills ask for — in the 7 days to 2026-10-20, 30 permission stops (merges after the merge gate said merge, posting the gate's marks, resolving review threads, editing skill files), and the user's OK in the conversation did not lift a second refusal. So the daemon passes Claude Code `permissions.allow` rules to a task, in the same `--settings` JSON as the guard hooks (`taskAllowRules` in `packages/core/src/tasks.ts`; only when the meta workspace exists, like the hooks):

| rule | why |
|---|---|
| `Bash(bun scripts/merge-gate.ts:*)`, `Bash(bun <meta>/scripts/merge-gate.ts:*)` | the merge: `--merge` / `--merge-stack` merge only on a merge verdict (the usage line of `scripts/merge-gate.ts`). The second form is another repository's task |
| `Bash(ops-kit pr resolve-thread:*)` | resolving a review thread: one mutation, not a general `gh api graphql` |
| `Bash(gh pr comment:*)` | the gate's marks (`[merge-ask]` / `[merge-answer]` / `[recheck]` / `[local-ci]`). The check in front of `gh` (`docs/design/secret-guard.md`) still reads every post |
| `Edit` / `Write` of `//<cwd>/ops-kit/skills/**`, `//<cwd>/.claude/skills/**` and the same under `//<cwd>-*/` | editing the skills in the task's folder and its worktrees (CLAUDE.md names them `<folder>-<topic>`; a worktree is made after the task starts, so it cannot be listed then). A worktree named otherwise is left to auto mode. `~/.claude/skills` is not included |

Not allowed (left to auto mode): a bare `gh pr merge` / `gh stack merge` (it would merge past the gate), `gh api graphql`, deploys (`sam deploy`, CloudFormation, IAM — #2046), writing or deleting secrets, destructive host operations. Codex tasks get none (`StartOptions.allow` is read by the Claude adapter only). The permission mode itself stays `auto`.

What this protects and what it does not: only the operations the skills name are allowed, the merge only through the gate, and only in tasks Switchboard starts (a terminal `claude` does not get them). A task runs as the same OS user, so it can do the same by another way (another command, the API directly) — the loopback trust model; the rules are a default so that the skills' steps do not stop, not a fence. Skill edits still reach main only through a PR, the other runner's review and the gate's responsibility recheck. A sibling folder that happens to match `<cwd>-*` gets the skill-edit rule too. Whether an allow rule takes effect before auto mode's classifier is checked on a real Claude task after the rules are running (#2160).

## Grants: the person's own words for one refused operation

Auto mode's classifier counts some operations (registering a schedule, changing settings — the soft-deny rules that say the user must name the operation) as allowed only when the person's own message names that operation. Text a task reads with a tool (an Issue comment, an API response) does not count. Answering a choice by its letter (「B」) does not name the operation either.

A grant (許可文 on screen) is one sentence that names the operation, its target and what it does — "allow only registering schedule X with enabled: false by POST /api/schedules". It reaches the task as the person's reply, once, by three paths:

- **A choice**: an operational check or a decision may end a choice's line with ` — 許可: <grant>` (the issue-workflow skill's 「判断待ちの出し方」). `Ask.grants` carries it per choice. Choosing that choice on the 判断待ち screen or the task's screen sends the choice's line as it is, grant included.
- **A refused stop**: a stop report with reason `permission` may carry `grant`, allowing only the refused operation (`stopRecoveryPrompt` in `packages/core/src/stops.ts` says how). Such a stop is not shown as the runner's refusal: its card has 「この操作だけ許可して続ける」, which sends the grant (`answer.kind: "grant"`). A stop without a grant stays the runner's refusal, as before.
- **A stage task's next prompt**: an answer given on the app's screen to a backlog question is written as a `## 回答` whose operation keeps a `screen` mark. The next stage task's first prompt carries the newest such answer as the person's words (`screenAnswer` in `packages/core/src/backlog.ts`) — only if the comment is still what the screen sent. A `## 回答` written on GitHub, an edited one, or one a saved policy gave is not carried; the task still reads those with `ops-kit backlog view`.

A grant does not spread: it is never saved as an answer policy (`POST /api/asks/answer` refuses a grant with a policy, and a question with a grant offers no scope), never becomes a `--settings` allow rule, and applies to no other task and to no later operation of the same task. Whether a grant lets the operation through is the runner's classifier's decision; Switchboard does not change it.

What this does not protect: a task runs as the same OS user, so it can call the answer API itself and send a grant to a task (the loopback trust model). The runner's classifier then judges that call as what it is.

## Where the value comes from

`TaskManager.resolvePermissionMode`: explicit `CreateTaskInput.permissionMode` → saved runner default (`settings.defaultPermissionMode[runner]`) → adapter default. The resolved value is stored on the task (`tasks.permission_mode`) so the record says what the task actually ran with; a runner without modes stores `null`. Unknown values are rejected with 400 (`RunnerAdapter.permissionModes` is the authority); a stale saved default falls back to the adapter default instead of failing the task.

## API

- `GET /api/health` — `runners[].permissionModes` (value / label / description / danger) and `runners[].defaultPermissionMode` (effective: saved setting, else adapter default).
- `GET /api/settings` / `PATCH /api/settings {defaultPermissionMode: {claude: "plan", codex: null}}` — save / clear a runner default (sqlite `settings` table). Validated against the runner's list.
- `POST /api/tasks {…, permissionMode}` — per task.
- `POST /api/tasks/:id/permission-mode {mode}` — change an existing task. Live session with `setPermissionMode` → the runner is asked first and the record changes only once it confirmed (Claude answers the control request; a refusal is a 409 and a `permission mode not changed` note; Codex applies from its next turn); otherwise the idle process is released and the next turn resumes with the new mode (a turn in flight keeps taking follow-ups on the old process and the restart happens at the next idle turn — never two processes). A `status` line records the change in the transcript.

A mode flagged `danger` cannot be saved as a default (400) — it is a per-task choice, because schedules run unattended on the default. `null` clears a saved default even for a runner that is no longer detected.

Tasks created before #58 have `permission_mode` NULL; when such a task is resumed the mode is resolved the same way (saved default → adapter default) and recorded on the row.

Schedules carry no mode of their own: a fired task uses the saved runner default.
