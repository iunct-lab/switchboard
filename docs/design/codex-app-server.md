# Codex app-server — wire notes

Verified 2026-09-05 against **codex-cli 0.148.0-alpha.9** (driven from Bun). Recorded fixtures are kept outside Git under the same relative path `packages/adapters/codex/fixtures/` (record your own outside Git with the `runner-adapter-recording` skill); lines prefixed `> ` are what Switchboard sent.

## Invocation

```
codex app-server --listen stdio:// -c features.memories=false -c features.default_mode_request_user_input=true        # cwd = task cwd
```

One JSON-RPC 2.0 message per line on stdin/stdout. Protocol types come from `codex app-server generate-ts`; the subset the adapter uses is generated into `packages/adapters/codex/src/generated/` from the installed Codex on every typecheck (`bun run codex:types`) and is not kept in Git.

Detection order: `codex` on `PATH` → unavailable with the official installer hint `curl -fsSL https://chatgpt.com/codex/install.sh | sh`. Nothing is bundled; login (`~/.codex/auth.json`) is the user's own.

## Memory is off

The daemon starts app-server with `-c features.memories=false` (see Invocation), before any `CodexAdapterOptions.config` entry. It does so regardless of `~/.codex/config.toml`, which it never writes, and of the default of a fresh profile (memory v2 is on by default for fresh profiles since 0.165.0).

Why: README's "Text stays text" keeps knowledge as Markdown in a git repo you own. Codex memory is an sqlite under `~/.codex` that a Claude task cannot read, so rules collected there would diverge from the written ones. Rules go into the written docs on both runners. There is no setting for this, and a Codex started outside Switchboard is not touched.

Verified 2026-10-29 on codex-cli 0.165.0: `codex -c features.memories=false features list` shows `memories` as false. Verified 2026-10-30 on 0.166.0 with `[features] memories = true` in a temporary `CODEX_HOME`: the same command shows false and true without the override, and `config/read` from an app-server started with the daemon's arguments returns `memories: false` (true without them).

If a later version stops honouring the override, the runner's option on Home says so in its tooltip, which is where the web UI shows `note` (while the login is expired, that tooltip shows the login hint instead): `detect()`, at daemon start and on each login recheck, runs `codex -c features.memories=false features list` and, when the command fails, the `memories` row is missing or not false, or there is no answer in 5 seconds, adds a `note` naming `features.memories`. When memory is off it adds nothing.

## Handshake

1. `initialize {clientInfo}` → result `{userAgent, codexHome, …}`
2. notification `initialized`
3. `thread/start {cwd, approvalPolicy, sandbox, model, ephemeral:false}` → result `{thread}` — or `thread/resume {threadId, …}` for a later turn; the rollout under `~/.codex/sessions/` is reused.
4. `turn/start {threadId, input:[{type:"text", text}], sandboxPolicy, cwd}` → result `{turn}` (status `inProgress`). While a turn is active, further input goes through `turn/steer {threadId, expectedTurnId, input}`.

`approvalPolicy`, `sandbox`, and `approvalsReviewer` come from the presets in `docs/design/permission-modes.md`:

| preset (`permissionMode`) | approvalPolicy | sandbox |
|---|---|---|
| `auto` (default; `approvalsReviewer: auto_review`) | `on-request` | `workspace-write` |
| `on-request` (manual; `approvalsReviewer: user`) | `on-request` | `workspace-write` |
| `read-only` | `on-request` | `read-only` |
| `untrusted` | `untrusted` | `workspace-write` |
| `full-access` (flagged as dangerous in the UI) | `never` | `danger-full-access` |

`never` is reachable only through `full-access`, an explicit choice per task — never a default. Auto uses Codex's risk-based reviewer; all other presets explicitly use `user`. Scope directories other than cwd become `writableRoots`. Start, resume and `turn/start` carry the reviewer; turn-level policy and reviewer changes apply on the next turn, while steering an active turn retains its current policy. Auto-review notifications become persistent transcript notes with their outcome and rationale.

## The question tool

The daemon also passes `-c features.default_mode_request_user_input=true` (a feature flag under development, fixed in the adapter, no setting). Recorded 2026-10-29 on codex-cli 0.165.0: without it the model in the default mode does not get `request_user_input`; it writes its questions into an `agentMessage` (`questions` with `delivery: "async"`), sleeps 60 seconds and ends the turn. With it the questions arrive as the server request `item/tool/requestUserInput` (`questions[] = {id, header, question, isOther, isSecret, options[{label, description}] | null}`). Recorded again 2026-11-05 on 0.166.0 (`question-tool.jsonl`): the flag is enough, the `experimentalApi` capability of `initialize` is not needed.

The adapter maps the request to `question.ask` (`multiSelect: false`; `isOther` and `isSecret` are not read — a question with options takes only its options on the card) and answers at once, for every question id, `{"answers":{"<id>":{"answers":["<QUESTION_DEFERRED_REPLY>"]}}}`. The model ends the turn with one line ("I'll wait for your answers.") and `turn/completed` is `completed`; the daemon marks the Task as needing action, and the person's answers come back as the next turn. The asynchronous questions of the default mode without the flag are not read.

## Server → client

| message | kind | AgentEvent |
|---|---|---|
| `thread/started {thread}` | notification | `session.start` (once; also derived from the thread/start result) |
| `turn/started {turn}` | notification | `status` — remembers the active turn id for steer/interrupt |
| `item/started` / `item/completed` `commandExecution {command, cwd, commandActions, aggregatedOutput, exitCode, status}` | notification | `tool.call(exec)` / `tool.result` (`status: declined` → ok=false) |
| `item/started` / `item/completed` `fileChange {changes:[{path,kind,diff}], status}` | notification | `tool.call(fileChange)` / `tool.result` + `artifact(diff)` per path |
| `item/started` / `item/completed` `mcpToolCall {server, tool, arguments, result, error}` | notification | `tool.call(server.tool)` / `tool.result` |
| `item/agentMessage/delta {itemId, delta}` | notification | `message.delta(assistant)`; `item/completed agentMessage` fills text only if nothing streamed |
| `item/commandExecution/requestApproval {itemId, command, commandActions, reason}` | **request** (has `id`) | `permission.ask(kind=exec, id=<nonce>:<rpc id>, toolUseId=itemId)` — server ids restart at 0 per process, so the public id carries a per-process nonce; the reply uses the raw id and type |
| `item/fileChange/requestApproval {itemId, reason, grantRoot}` | **request** | `permission.ask(kind=write)` |
| `item/tool/requestUserInput {itemId, questions}` | **request** | `question.ask(id=<nonce>:<rpc id>)`; answered at once with the deferred reply (The question tool) |
| `thread/tokenUsage/updated {turnId, tokenUsage:{last,total}}` | notification | `usage(turn)` from `last`, only when `turnId` is the active turn (after `thread/resume` Codex replays the previous turn's usage before `turn/started`; it is ignored) |
| `turn/completed {turn:{status, error, durationMs}}` | notification | `usage(reported)` = sum of the active turn's `last` breakdowns (tokens only, no cost) + `session.end` (`completed`→ok, `interrupted`→aborted, `failed`→error) |
| `account/rateLimits/updated {rateLimits:{primary,secondary}}` | notification | `quota` — 300-minute window → `five_hour`, 10080 → `seven_day` |
| `error {error:{message}, willRetry}` | notification | `error` (or `status` while retrying) |
| `serverRequest/resolved`, `thread/status/changed`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed` | notification | `status` / ignored |

Reasoning items (`reasoning`) carry no text in these recordings and map to `status: thinking`.

## Subagent threads

Codex runs a subagent as its own thread (`Thread.parentThreadId` is the main thread) and sends that thread's `turn/started`, `turn/completed`, `thread/status/changed`, `item/*`, `thread/tokenUsage/updated` and approval requests on the same stdio. Every one of them carries its `threadId`. Recorded 2026-11-05 on codex-cli 0.166.0 (`subagent-0.166.0.jsonl`): the subagent's thread sends no `thread/started`, and its `turn/completed` arrives while the main turn is still running. The main thread shows the spawn and the wait as `subAgentActivity` and `collabAgentToolCall` items, which the adapter ignores.

Only the main thread (the one without `parentThreadId`) decides the turn state and `session.end`:

- The main thread is the one from the `thread/start` / `thread/resume` result. A `thread/started` with `parentThreadId` (if a version sends one) does not change it, and `turn/started`, `turn/completed` and `thread/status/changed` from a subagent do not touch the active turn. Steering and `turn/interrupt` therefore always name the main turn, and `session.end` comes only from the main turn.
- The agent text of a subagent is shown as before but is never the `session.end` summary.
- Usage is kept per thread: a subagent's `thread/tokenUsage/updated` is `usage(turn)`, and its `turn/completed` gives one `usage(reported)` for that thread's sum. A subagent with usage not yet reported when the main turn completes (an interrupt cuts it off without its own `turn/completed`) is reported at that point.
- Approval requests from a subagent are `permission.ask` like any other; the answer goes back by the JSON-RPC id, so it reaches the subagent.

## Client → server answers

- Approve: `{"jsonrpc":"2.0","id":<request id>,"result":{"decision":"accept"}}`; deny: `"decline"` (turn continues; the agent sees a declined exec) or `"cancel"` (turn interrupted). Switchboard uses accept / decline.
- Interrupt: `turn/interrupt {threadId, turnId}` → `turn/completed` with `status: "interrupted"`.
- Question tool: `{"jsonrpc":"2.0","id":<request id>,"result":{"answers":{"<question id>":{"answers":["<QUESTION_DEFERRED_REPLY>"]}}}}` (The question tool).
- Other server requests (`item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/call`, …) are answered with a JSON-RPC error `-32601`; the transcript gets a `status` note. They get mapped once a recording shows their shape.
- Turns are serialized: the next `turn/start` / `turn/steer` is decided after the previous request was answered, and the turn id is taken from the `turn/start` **response** (which precedes `turn/started`). A `turn/steer` rejected because the turn just completed falls back to `turn/start`.

## Cost model

The model is not on the wire in these recordings; the adapter uses the task's model, else `model = "…"` from `~/.codex/config.toml`, else leaves it unset. Codex reports **tokens only** (`inputTokens` incl. `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`). The adapter emits `usage(reported)` with `costUsd` unset; the ledger prices it from `pricing.json` (#14). The subscription's real constraint is `account/rateLimits/updated` (`usedPercent`, `resetsAt`, `planType`).

## Process lifecycle

`app-server` keeps running after `turn/completed`. The daemon releases idle processes after `SWITCHBOARD_RUNNER_IDLE_MS` (`RunnerSession.close()`: end stdin, kill after 3 s, immediately at daemon shutdown). `app-server` is spawned as the leader of its own process group (`detached`); the kill goes to the whole group (SIGTERM, then one SIGKILL after it exits) so MCP servers and tool shells do not outlive it. The next turn starts a new process with `thread/resume`. `abort()` waits at most 3 s for a stalled handshake and 8 s for `turn/completed(interrupted)`, then kills. Pipe draining after exit is bounded (1.5 s) so MCP servers spawned by codex cannot hold a session open. Session tests run against `fixtures/fake-app-server.ts`, a deterministic stand-in speaking the same lines. Verified end to end through the daemon (approve → done → follow-up → release → resumed follow-up → interrupt).
