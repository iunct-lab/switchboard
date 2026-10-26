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

Verified 2026-09-20 on codex-cli 0.155.0-alpha.2.6: `curl -I --max-time 10 https://example.com` failed sandbox DNS, was auto-reviewed as low-risk/approved, then returned HTTP 200 without a manual request. Recorded notifications (outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history): `packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl`. Existing Auto tasks receive the reviewer on their next start/resume/turn; a turn already in flight keeps its current setting.

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
