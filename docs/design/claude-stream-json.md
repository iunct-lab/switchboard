# Claude Code stream-json — wire notes

Switchboard starts the user's own, unmodified `claude` and never touches its credentials. As we read Anthropic's terms, using a Claude Pro / Max login this way is allowed only for the user's own, individual use (our reading, not legal advice).

Verified 2026-09-05 against Claude Code **2.1.261** by driving `claude` from Bun (`scripts` in the Phase 0 spike; recorded fixture at `packages/adapters/claude/fixtures/write-with-permission.jsonl`, outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history).

## Invocation

```
claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages \
  --permission-prompt-tool stdio --permission-prompts host \
  --permission-mode <mode> [--model X] [--resume <session_id>] [--add-dir <dir>]...
```

`--permission-mode` is always passed (#58, `docs/design/permission-modes.md`). Without it `claude -p` starts in `default`
(Manual: every tool asks) and — unlike the interactive terminal — ignores `permissions.defaultMode`; an interactive
`claude` on Pro / Max / Team starts in `auto`. So the adapter's default is `auto`: Claude Code's own classifier
approves safe actions and only the uncertain ones reach the host as `can_use_tool`. Accepted values (2.1.263):
`auto | acceptEdits | default | plan | dontAsk | bypassPermissions` (`manual` is a CLI alias for `default`).

- `-p` with `--input-format stream-json` keeps the process alive for multiple user turns until stdin closes.
- The child must **not** inherit the parent's `CLAUDECODE` / `CLAUDE_CODE_*` variables when launched from inside another Claude Code session.
- Do **not** pass `--no-session-persistence` for a Task — its session must persist for `--resume`. The one exception is the daemon's one-off judge and suggestion turns (`runSuggestionTurn` in `packages/core/src/suggest-llm.ts` passes `StartOptions.persistSession: false`): they are never resumed, and saving them would fill `~/.claude/projects` and the recent sessions Claude Code's `/insights` reads.

## Handshake

1. Host writes `{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","hooks":{}}}`.
   Claude replies with a `control_response` carrying commands, agents, models, account, permission mode.
2. Host writes user turns: `{"type":"user","message":{"role":"user","content":"..."}}`.

Without step 1 (or without `--permission-prompt-tool stdio`) any tool that needs permission is **auto-denied** with `system/permission_denied`.

## Inbound messages (stdout, one JSON per line)

| type | notes | AgentEvent |
|---|---|---|
| `rate_limit_event` | `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` — subscription quota | `quota` |
| `system` / `init` | `session_id`, `cwd`, `model`, `permissionMode`, `claude_code_version`, tools, plugins | `session.start` |
| `system` / `status` | `status: "requesting"` etc. | `status` |
| `stream_event` | Anthropic streaming events. `content_block_delta.text_delta` carries text; `message_delta.usage` per API call | `message.delta`, `usage(turn)` |
| `assistant` | Full content blocks as they complete. `tool_use` blocks carry the final input | `tool.call` |
| `user` | `tool_result` blocks (`tool_use_id`, `content`, `is_error`) | `tool.result` |
| `control_request` / `can_use_tool` | `request_id`, `tool_name`, `input`, `description`, `permission_suggestions`, `tool_use_id` | `permission.ask` |
| `result` | `total_cost_usd`, `usage`, `modelUsage{model:{costUSD,contextWindow,...}}`, `is_error`, `subtype`, `permission_denials`, `duration_ms` | `usage(reported)`, `session.end` |

## Outbound messages (stdin)

- Allow: `{"type":"control_response","response":{"subtype":"success","request_id":R,"response":{"behavior":"allow","updatedInput":<input>}}}`
- Deny: `... "response":{"behavior":"deny","message":"..."}`
- Answer an `AskUserQuestion` (verified 2026-09-19 on 2.1.277, `fixtures/ask-user-question.jsonl`, outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history): it arrives as a
  `can_use_tool` like any other tool (`requires_user_interaction: true`, in every permission mode) with
  `input.questions[] = {question, header, options[{label, description}], multiSelect}`. The answer rides on the allow:
  `"updatedInput": {...input, "answers": {"<question text>": "<label>"}}` — several labels of a multiSelect joined with
  `", "`, free text as is. Claude turns it into the tool result `The user answered: "<question>"="<answer>", …`. A bare
  allow gives the tool nothing to report, so the UI shows a question card (選択肢 + 自由記述, 回答する / 答えない)
  instead of 許可 / 拒否, and `POST /api/tasks/:id/permission` takes an optional `answers`.
- Interrupt: `{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}`
- Switch mode (verified 2026-09-06 on 2.1.263, no model call involved): `{"type":"control_request","request_id":"mode-1","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}`
  → `{"type":"control_response","response":{"subtype":"success","request_id":"mode-1","response":{"mode":"acceptEdits"}}}` followed by
  `{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits",…}` (mapped to `status: permission mode: acceptEdits`).
  An unknown mode answers `{"subtype":"error","error":"Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan"}` (a `status` note in the transcript).

## Cost model

- `result.total_cost_usd` is computed at API list price even on a subscription. Switchboard shows it as **API-equivalent** cost.
- `total_cost_usd` and `modelUsage` (per model: `costUSD`, `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`; no 1-hour cache split) are the **session's running totals**, not the turn's: they grow over the turns of one process and carry on after `--resume` (recorded with Claude Code 2.1.311, `fixtures/resume-cost.jsonl`: two Haiku processes of one session, the second `--resume`d — its `total_cost_usd` includes the first's). `modelUsage` includes subagents' models. `result.usage` counts this process only and leaves subagents out. The parser emits one `usage(reported, cumulative: true)` per model of `modelUsage` (none when it is empty, as on a missing session); the Ledger books the difference from the previous total (#2353).
- `rate_limit_event` gives the subscription's real constraint: 5-hour and 7-day window utilization.

## Resume (verified 2026-09-05, issue #2)

Recorded fixtures (outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history): `fixtures/resume-turn.jsonl` (same session id re-announced by `system/init`, answer drawn from the earlier process) and `fixtures/resume-missing.jsonl` (`--resume` of an unknown id).

- The process does **not** exit after `result`; it waits for more user turns on stdin. Ending stdin does not make it exit promptly either — the daemon ends stdin and kills after a 5 s grace period (`RunnerSession.close()`). The runner is spawned as the leader of its own process group (`detached`) and every kill goes to the whole group (SIGTERM, then one SIGKILL once the runner has exited), so its tool shells and MCP servers do not outlive it.
- The daemon therefore keeps a finished process for `SWITCHBOARD_RUNNER_IDLE_MS` (default 10 min; a negative value keeps processes until shutdown; non-numeric values fall back to the default) for quick follow-ups, then releases it. Not while the process still has background jobs: `system/background_tasks_changed` (verified on 2.1.311, `tasks` = the jobs left, sent when a `run_in_background` shell or a Monitor starts or ends) maps to `background {count}`; a count above 0 holds the release (and counts as activity for the host's idle stop), 0 starts the clock. A job's `task_notification` makes the process start a turn on its own (a new `system/init` with no user message); the daemon treats that turn as in flight (`running`) like a sent one, so the release never kills it mid-command. A follow-up that arrives while a release is in progress waits for it, so one session id never has two processes. At daemon shutdown idle processes are killed immediately (no grace). A crash (`uncaughtException` / `unhandledRejection`) goes through the same stop, capped at 20 s (a running Codex turn waits up to 8 s for the interrupt and 3 s for close before its group is killed), before exit 1. Later turns spawn `claude --resume <session_id>`; the conversation context comes from `~/.claude/projects/...`, so this survives a daemon restart.
- A missing session: exit code 1, stderr `No conversation found with session ID: …`, and one `result` line with `subtype: "error_during_execution"`, `is_error: true`, zero usage. The parser turns the `result` line into `session.end(error)`. If the process dies with a non-zero code and **no** `result` line, the adapter drains both pipes (bounded) and emits `error` with the stderr text; the daemon then appends `session.end(error, "runner exited (n)")`. Either way the transcript shows why.
- `error` events never change the task status by themselves; `session.end` (or the exit handler) does. A recoverable mid-turn error therefore cannot stick over a later `session.end(ok)`.
- `system/init` is emitted again for every turn (also inside a live process), always with the same `session_id`.

Eval log (real Claude Code 2.1.261, model `claude-haiku-4-5-20251001`): task "Remember the secret word: pelican" → daemon stopped → new daemon, `POST /api/tasks/:id/send` "What was the secret word?" → `--resume` process answered `pelican`; ledger recorded both turns under the same task.

## Session log (`~/.claude/projects`) — reading terminal sessions (issue #91)

Verified 2026-09-09 against logs written by Claude Code **2.1.263** (interactive terminal and `claude -p` alike). Mapping in
`packages/adapters/claude/src/history.ts`; recorded shape in `fixtures/terminal-session.jsonl` (values sanitized; outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history).

Claude Code appends every session to `~/.claude/projects/<dir>/<sessionId>.jsonl`, where `<dir>` is the cwd with every
character outside `[A-Za-z0-9]` replaced by `-` (`/home/user/my_repo` → `-home-user-my-repo`). Subagent transcripts live in
`<sessionId>/subagents/` and are not read. This is the folder `--resume` reads from, so it is also where a session that was
run in a terminal can be picked up from after the fact.

| record | notes | AgentEvent |
|---|---|---|
| `entrypoint` (on `user` / `assistant` / `attachment` / `system`) | `cli` = the terminal, `sdk-cli` = a host driving `claude -p` (Switchboard). Only `cli` records are terminal history; a host records its own session live | — |
| `user`, string content, `promptSource: typed \| queued \| suggestion_accepted` or `origin.kind: human` | what the person typed. `promptSource: system` (task notifications), `isMeta` (`<local-command-caveat>`), `isCompactSummary` are Claude Code's own text | `message.delta(user)`; the first one also `session.start` |
| `user` with neither field | older versions and local-command bookkeeping: plain text (a slash command) is the person's; `<bash-input>` / `<bash-stdout>` / `<command-name>` / `<local-command-stdout>` are not | `message.delta(user)` or nothing |
| `assistant` with `message.model: "<synthetic>"` | text Claude Code wrote itself (a session-limit banner); zero usage | `error`, and `session.end(error)` when it stops the turn |
| `assistant` | one record **per content block**, all with the same `message.id`, `stop_reason` and `usage`. `text` → text, `tool_use` → tool row, `thinking` → dropped | `message.delta(assistant, messageId)`, `tool.call`, one `usage(turn)` per message id |
| `user` with `tool_result` blocks | `tool_use_id`, `content`, `is_error`; a successful Write / Edit result also yields `artifact(diff)` | `tool.result` |
| `user` text block `[Request interrupted by user…]` | Esc in the terminal | `session.end(aborted)` |
| `stop_reason: end_turn` / `stop_sequence` / `refusal` | the turn is over once a record of **another** message follows (blocks of one message arrive together), or at end of file; a message whose end was emitted cannot end the turn again when a late block of it arrives. `max_tokens` does not end the turn | `session.end(ok)` (`error` for refusal), stamped with the stopping record's time |
| `ai-title` | Claude Code's generated session title (repeated; the last one wins) | task title |
| `permission-mode` | mode changes; a typed prompt also carries `permissionMode` | task permission mode / `session.start.permissionMode` |
| `cost-state` | cumulative `totalCostUSD` and per-model tokens, written when the session ends. Not used: cumulative, not incremental; and priced with Claude Code's internal rates, which differ from `pricing.json` | — |
| `attachment`, `system/turn_duration`, `queue-operation`, `file-history-*`, `mode`, `atis-latch`, `bridge-session`, `last-prompt`, `pr-link` | UI state and bookkeeping | — |

There is no `result` line and no `rate_limit_event` in the session log; cost is computed per assistant message from the price
table (`usage(source: turn)` → ledger `priced`). `cost-state` is Claude Code's own figure for the whole session and is
kept only as a reference in the docs.

The parser state (`ClaudeHistoryState`) can be serialized (`serializeHistoryState`) and restored, so a log that is still
being written can be read in slices — across daemon restarts too — without re-announcing the session or counting a
message's usage twice when its blocks straddle a slice.
