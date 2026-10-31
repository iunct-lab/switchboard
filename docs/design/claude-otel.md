# Claude Code OpenTelemetry logs — what the classifier counts come from

Switchboard counts, per Task, the operations Claude Code's auto-mode classifier let through and the ones it stopped
(#2236). Only allowed operations are invisible on stream-json (`docs/design/claude-stream-json.md`), so the counts come
from Claude Code's OpenTelemetry log event `tool_decision`, sent to the daemon's loopback port and nowhere else.

Verified 2026-10-29 against Claude Code **2.1.312** (`claude -p --permission-mode auto`, stream-json, a throwaway
loopback OTLP receiver). Recording: `packages/core/fixtures/otel-tool-decision.jsonl`, outside Git (one OTLP/HTTP JSON
request body per line; identifiers replaced; record your own with the `runner-adapter-recording` skill). The recording
holds three `tool_decision` events, all `allow`: in three runs the classifier stopped nothing (a force-push to a scratch
remote and `rm -rf` of a missing path were allowed; an exfiltration attempt was refused by the model before any tool
call).

A stop was recorded on 2026-10-30, also on **2.1.312** (Auto, `--model sonnet`, `--permission-prompts host`, a scratch
repository, a fake `ops-kit` on `PATH`): `packages/adapters/claude/fixtures/classifier-stop.jsonl` (stream-json) and
`packages/core/fixtures/otel-classifier-stop.jsonl` (OTLP), outside Git, identifiers replaced. The stopped call was
`ops-kit pull-main 2>&1 | tail -2`, in a repository whose `CLAUDE.md` said a pull restarts a daemon running other Tasks,
with the user saying they could not answer. An earlier check in the same run had printed `no-dev`. The call gave a
`block` `tool_decision` with `classifier_category: "interfere_with_workloads"`. It was the tenth try. The nine before it
stopped nothing: every call the classifier judged was allowed, among them `curl | bash` and `git push --force` to names
that do not resolve and a `kill` of a missing PID, and on four tries the model refused or asked before the risky call.
The recording shows the category only, not why the classifier decided.

## Environment

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<port>/v1/logs
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
OTEL_METRICS_EXPORTER=none
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORT_INTERVAL=1000
```

- The endpoint is the full URL: Claude Code posts to it as is (`POST <path>`, `content-type: application/json`), with
  `OTEL_EXPORTER_OTLP_HEADERS` as request headers (`authorization: Bearer <token>` arrived). The receiver answered
  `{}` and every batch was accepted.
- To send nothing out: logs only to the loopback receiver, metrics and traces `none`, and the parent's own `OTEL_*`
  (a collector the user's shell points at) removed before these are set.
- `OTEL_LOG_USER_PROMPTS` was not set: prompts and responses arrived as `<REDACTED>`. `classifier_category` is sent
  only with `OTEL_LOG_TOOL_DETAILS=1` (read from the CLI), which also adds the tool's parameters to the events: a
  receiver must not keep those.

## The request body

OTLP/HTTP JSON: `resourceLogs[].scopeLogs[].logRecords[]`, scope `com.anthropic.claude_code.events`. Each record's
`body` is `claude_code.<event>` and its `attributes[]` are `{ key, value: { stringValue | intValue | … } }`. Besides
`tool_decision` a batch carries `user_prompt`, `api_request`, `tool_result`, `assistant_response`, `plugin_loaded`,
`mcp_server_connection`, `managed_settings_resolved`; every record also carries the account (`user.email`,
`user.account_uuid`, `user.account_id`, `organization.id`, `user.id`) and `session.id`.

## `tool_decision`

| Attribute | Values | Use |
|---|---|---|
| `event.name` | `tool_decision` | the event that carries the classifier's decision |
| `decision` | `accept` / `reject` | |
| `source` | `config` (decided without asking: rule, mode or classifier), `user_temporary`, `user_permanent`, `user_reject`, `user_abort`, `hook` | |
| `classifier_verdict` | `allow` / `block` (also `no_verdict`, `unavailable`) | present only when `source` is `config` and the auto-mode classifier decided |
| `classifier_category` | the built-in rule a `block` matched | only on `block`, only with `OTEL_LOG_TOOL_DETAILS=1` |
| `permission_mode` | `auto`, … | |
| `tool_name` | `Bash`, … | |
| `tool_use_id` | `toolu_…` | the same id as stream-json's `tool_use.id` and `can_use_tool.tool_use_id` |

Allowed by the classifier = `classifier_verdict: "allow"` (with `decision: "accept"`, `source: "config"`). Stopped
outright = `classifier_verdict: "block"` (`decision: "reject"`). Everything else (no `classifier_verdict`) is not a
classifier decision. The record's other attributes are the account ones above and, with `OTEL_LOG_TOOL_DETAILS=1`,
`tool_parameters`.

## Stopped outright, on stream-json

In the recording, with `--permission-prompts host`, the classifier's stop did not reach the host as a question. No
`can_use_tool` came. Stream-json carried `system` / `permission_denied` with `decision_reason_type: "classifier"`,
`decision_reason: "[Interfere With Workloads]"`, `tool_name` and `tool_use_id`, then the tool's `tool_result` with
`is_error` and the message `Permission for this action was denied by the Claude Code auto mode classifier.`, and the
turn went on. The `tool_decision` had `decision: "reject"`, `source: "config"`, `classifier_verdict: "block"`. The
`tool_use_id` is the same on all of these.

## Stopped, then asked

Recorded on 2026-10-30 on **2.1.314** (the same setup as the stop, a scratch repository, a fake `ops-kit` on `PATH`):
`packages/adapters/claude/fixtures/classifier-ask.jsonl` (stream-json) and
`packages/core/fixtures/otel-classifier-ask.jsonl` (OTLP), outside Git, identifiers replaced. It was the fourth try: one
call allowed, one run where the model never made the call, one run where the model gave up after a single stop.

A `block` does not ask. In the recording the denial limit did: the first two blocks in a row were `permission_denied`; the third,
fourth and fifth reached the host as `can_use_tool` with `decision_reason_type: "classifier"`, `tool_use_id`, and a
`decision_reason` such as `3 consecutive actions were blocked. Please review the transcript before continuing.` The
CLI sets the limits at three in a row and twenty in a session, and aborts instead of asking when the session must not
prompt (`shouldAvoidPermissionPrompts`; a host that answers, as here, is not that case); it also asks on a Chrome floor
block. The limit of twenty, the abort and the Chrome ask are read from the CLI, not observed.

Answered deny, the `tool_decision` had `decision: "reject"`, `source: "user_reject"` and no `classifier_verdict`, so the
stop shows on stream-json only. The key between a decision and the person's answer is `tool_use_id`, as in the recorded
stop; no turn-and-tool-name guess is needed. An allow to such an ask has not been observed.

## In Switchboard

- The daemon hands each local Task `StartOptions.otel`: the endpoint `<the daemon's loopback URL>/otel/<taskId>/v1/logs`
  and the Task's Workspace MCP token (revoked when the Task ends). The Claude adapter's `otelEnv` turns it into the
  variables above, the token as the `Authorization` header and `OTEL_LOG_TOOL_DETAILS` on (for `classifier_category`),
  after `childEnv` has dropped the parent's `OTEL_*`; the values are in `packages/adapters/claude/src/index.ts`. Cloud
  Tasks and other runners get none of it.
- The adapter copies `decision_reason_type: "classifier"` of a `can_use_tool` to the `permission.ask` it emits
  (`reason: "classifier"`).
- The daemon's receiver `POST /otel/:id/v1/logs` takes the Task's token (401 otherwise; on the cloud host, where the
  passkey login is on, only from loopback, as for `/mcp/`) while the Task's runner process is attached or still closing
  (404 for a valid token with no such process), and answers `{}`. Once the Task has closed, its token is revoked and a
  send is 401. Of a body it keeps only the
  `tool_decision` records with `classifier_verdict` `allow` / `block`, as the Task's `classifier.decision` events with
  `verdict`, `category`, `mode`, `tool` and `callId` (`tool_use_id`); the account attributes, the tool's parameters
  and every other event are dropped.
- The Task's evaluation counts them (`RuleMetrics.classifier`): allowed = `allow`; stopped = `block` + the
  classifier-reasoned asks (kind `asked`); null when nothing was recorded.
