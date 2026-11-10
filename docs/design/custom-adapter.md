# Custom adapters — which contract an arbitrary agent API should plug in through

A design note. The ADK port is built and was checked against an ADK server that is not DAK on 2026-11-04 (below); the AG-UI port is built too (an AG-UI server is added in Settings and runs as `custom:<name>`) and was checked against a real-model server on 2026-11-08 (below). It compares the contracts an agent API could use to reach Switchboard, answers whether Switchboard should collect them (ADK, AG-UI, …), and names what a build would change. The comparison reads the published specifications and released packages, checked on 2026-10-30. No server was run or recorded for the comparison itself; the recordings belong to the build, with the `runner-adapter-recording` skill: the earlier ones of DAK, those of the ADK check below, and those of the AG-UI checks below (a scripted server on 2026-11-07, a real-model server on 2026-11-08).

A runner today is a `RunnerAdapter` that turns one agent's wire into `AgentEvent`. `RunnerId` is a closed list, so each new agent needs code in Switchboard, and DAK's adapter is tied to ADK's REST API.

## What a contract has to carry

| Capability | Switchboard contract (declarations in `packages/protocol/src/adapter.ts`) | |
|---|---|---|
| Turn and stream | `RunnerAdapter.start`, `RunnerSession.send` | `message.delta` `packages/protocol/src/events.ts:94`, `tool.call` `packages/protocol/src/events.ts:100`, `tool.result` `packages/protocol/src/events.ts:107` |
| Confirmation | `RunnerSession.respondPermission` | `permission.ask` `packages/protocol/src/events.ts:113` |
| Interrupt | `RunnerSession.abort` | `session.end(aborted)` `packages/protocol/src/events.ts:204` |
| Session resume | `StartOptions.resumeSessionId`, `RunnerAdapter.hasSession` | `session.start.runnerSessionId` `packages/protocol/src/events.ts:86` |
| Attachments | `StartOptions.attachments` | |
| Artifacts | `StartOptions.attachmentDir` | `artifact(file)` `packages/protocol/src/events.ts:162` |
| Usage | | `usage` `packages/protocol/src/events.ts:134` |
| Model choice | `RunnerAdapter.models`, `StartOptions.model` | |
| Availability | `RunnerAdapter.detect`, `RunnerDetection` | |

## Summary

Yes = in the contract. Extension = the channel exists, the meaning would be ours. No = not there. Sources and details are in each section below.

| Capability | ADK REST | AG-UI 1.0 | A2A 1.0 | ACP v1 |
|---|---|---|---|---|
| Turn and stream, tool calls visible | Yes | Yes | Text only; tool calls are hidden | Yes |
| Confirmation | Yes (experimental) | Yes | Extension | Yes |
| Interrupt | Close the stream | Close the stream | Yes (`CancelTask`) | Yes (`session/cancel`) |
| Session resume | Yes | Thread id; the client resends history | Yes | Yes, if declared |
| Attachments | Yes | Yes | Yes | Yes, if declared |
| Artifacts | Yes | Extension | Yes | No |
| Usage | Yes | Yes | Extension | Context and cost only |
| Model choice | No | Extension | Extension | Yes |
| Availability | Yes | Reachability only | Yes (Agent Card) | Yes (`initialize`) |
| Works with a remote HTTP API | Yes | Yes | Yes | No (stdio only) |

## ADK REST

Version: `google-adk` 2.13.0 on PyPI (2026-10-23), API server documentation at https://adk.dev/runtime/api-server/. Switchboard's recorded wire is google-adk 2.x (`docs/design/dak-adapter.md`).

| Capability | Carried | How | Source |
|---|---|---|---|
| Turn and stream | Yes | `POST /run_sse` with `newMessage`; `streaming: true` gives token-level events. Function calls and responses are in the event parts | https://adk.dev/runtime/api-server/ (2.13.0 docs) |
| Confirmation | Yes, experimental | `adk_request_confirmation` function call; the client answers with a `FunctionResponse` carrying `confirmed`. Not supported on `DatabaseSessionService` or `VertexAiSessionService` | https://adk.dev/tools-custom/confirmation/ (Python 1.14.0 and later) |
| Interrupt | Close the stream | No cancel route on the server. Closing the stream cancels the run, as recorded in `docs/design/dak-adapter.md`. The documented abort signal is a TypeScript runner API, not REST | https://adk.dev/runtime/cancel/ (2.13.0 docs) |
| Session resume | Yes | Sessions live on the server: `GET /apps/{app}/users/{user}/sessions/{id}` | https://adk.dev/runtime/api-server/ (2.13.0 docs) |
| Attachments | Yes | `inlineData` parts in `newMessage` | https://adk.dev/runtime/api-server/ (2.13.0 docs) |
| Artifacts | Yes | `/apps/{app}/users/{user}/sessions/{id}/artifacts/{name}` routes in `google/adk/cli/api_server.py`; events name them in `actions.artifactDelta` | https://pypi.org/project/google-adk/2.13.0/ (source of 2.13.0) |
| Usage | Yes | `usageMetadata` on events (`usage_metadata` in `google/adk/models/llm_response.py`); Switchboard already prices it | https://pypi.org/project/google-adk/2.13.0/ (source of 2.13.0) |
| Model choice | No | `RunAgentRequest` has no model field; the agent decides | https://pypi.org/project/google-adk/2.13.0/ (source of 2.13.0) |
| Availability | Yes | `GET /list-apps`, also `/health` and `/version` in `google/adk/cli/api_server.py` | https://pypi.org/project/google-adk/2.13.0/ (source of 2.13.0) |

**Checked on a server that is not DAK (2026-11-04).** `adk api_server` of `google-adk` 2.13.0 served a sample agent whose model is a scripted `BaseLlm` (no model key, no bill), with three tools: one wrapped in `FunctionTool(require_confirmation=True)` (ADK's native confirmation), one that calls `tool_context.request_confirmation()` itself, and one that saves a file with `save_artifact`. Switchboard's ADK adapter, registered as a `custom:` runner, ran a turn, allowed one confirmation and denied the other, fetched the artifact, aborted a turn and resumed the session. The turn, the confirmations and the artifact are recorded outside Git as `packages/adapters/adk/fixtures/adk-2.13.0-*.sse` and replayed by `packages/adapters/adk/src/adk-replay.test.ts`; the abort and the resume were checked on the running server only. What the recording showed:

- Both confirmation forms arrive together. ADK sends an `adk_request_confirmation` function call whose `originalFunctionCall` is the tool's call, then the tool's response (an error saying it waits for a confirmation, or the tool's own return) on an event whose `actions.requestedToolConfirmations` is keyed on the tool's call id, with `{ hint, confirmed, payload }` and no tool name. The two are one question: the adapter asks once, on the `adk_request_confirmation` call (which carries the tool's name), and answers there with `{ confirmed }`. Allowed, the tool runs; denied, the tool's own error comes back. Before this check the adapter also asked on the second form, an ask nothing could answer, which left the turn waiting.
- The hint a tool passes to `request_confirmation()` is not shown; the ask's detail is the tool's name and arguments.
- `save_artifact` numbers versions from 0: the event says `artifactDelta { "report.txt": 0 }`, and the artifact route with `?version=0` returns its `inlineData`.

**Recording it again.** Install `google-adk` in a throwaway virtual environment (Python 3.10 or later) and write one agent package for `adk api_server <dir>`, outside Git. Its model is a `BaseLlm` subclass whose `generate_content_async` reads the last content of the request. After a `function_response`, it replies `done: <the response as JSON>`. Otherwise it looks at the first word of the user's text. `native` calls `delete_file(path)`, a `FunctionTool(require_confirmation=True)`. `ask` calls `deploy(target)`, which calls `tool_context.request_confirmation(hint=…, payload=…)` while `tool_context.tool_confirmation` is unset and returns an error once it is denied. `artifact` calls `write_report(title)`, which awaits `tool_context.save_artifact("report.txt", Part.from_bytes(…, mime_type="text/plain"))`. Any other text streams `echo:<text>` in partial chunks, then sends it whole with `usage_metadata`. Create a session, then `POST /run_sse` with `streaming: true`, saving the raw body as it comes. Record `hello there` for `text`, `native please` for `native` and `ask now` for `ask`. Answer those two on the id of their `adk_request_confirmation` call (`functionResponse { name: "adk_request_confirmation", response: { confirmed } }`, with the turn's `invocation_id`): `true` for `native-allow`, `false` for `ask-deny`. Record `artifact now` for `artifact`. Save them as `packages/adapters/adk/fixtures/adk-<version>-<name>.sse` in the recordings folder, and add each to `RECORDINGS` in `scripts/fixtures.ts`.

It carries nearly everything, but it is one framework's server API rather than a contract other frameworks implement. It is still a standard one: any ADK agent served by the API server speaks it, and Switchboard's DAK adapter already uses it with little that is DAK's own.

## AG-UI

Version: protocol 1.0, the normative specification at https://docs.ag-ui.com/spec/1.0/index.md; `ag-ui-protocol` 1.0.0 on PyPI (2026-09-17), `@ag-ui/core` 1.0.3 on npm. Some pages outside `spec/1.0` differ from it: the concept pages do not show `usage` on `RUN_FINISHED` and the drafts overview still lists interrupts as a draft. This document follows the 1.0 specification and the released schema.

| Capability | Carried | How | Source |
|---|---|---|---|
| Turn and stream | Yes | `POST` of `RunAgentInput`, answered with Server-Sent Events: `TEXT_MESSAGE_*`, `TOOL_CALL_START` / `ARGS` / `END`, `TOOL_CALL_RESULT`, `REASONING_*`, then `RUN_FINISHED` or `RUN_ERROR`. `TOOL_CALL_RESULT` has no failure flag, so `tool.result.ok` would be `true` unless a profile says otherwise | https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse.md (1.0) |
| Confirmation | Yes | The run ends with `RUN_FINISHED` outcome `interrupt`; each `Interrupt` has `id`, `reason` (an open string), `toolCallId` when it is a tool approval, and `responseSchema`. The next run on the thread answers every open interrupt in `resume`, as answered or abandoned. What an abandoned interrupt means for the agent's work is the producer's business | https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume.md (1.0) |
| Interrupt | Close the stream | No cancel message. A client that closes the connection has a truncated run and must not invent a `RUN_FINISHED`; whether the server stops is the server's choice. A server that stops by itself reports outcome `cancelled` | https://docs.ag-ui.com/spec/1.0/events/lifecycle.md (1.0) |
| Session resume | Partly | `threadId` names the conversation, but `messages` must be the complete history the agent is shown, so the client holds it. A broken stream cannot be re-entered | https://docs.ag-ui.com/spec/1.0/basic/run-input.md (1.0) |
| Attachments | Yes | `ContentPart` image, audio, video and document on a user message, by inline data, URL or provider handle | https://docs.ag-ui.com/spec/1.0/basic/run-input.md (1.0) |
| Artifacts | Extension | No artifact event; a `CUSTOM` event would carry it | https://docs.ag-ui.com/spec/1.0/events/passthrough.md (1.0) |
| Usage | Yes | `RUN_FINISHED.usage` and `RUN_ERROR.usage`: one `TokenUsage` per provider and model, with input, output, cached and cache-write counts | https://docs.ag-ui.com/spec/1.0/schema.md (1.0) |
| Model choice | Extension | No model field and no list of models; `forwardedProps` is the application's own channel | https://docs.ag-ui.com/spec/1.0/basic/run-input.md (1.0) |
| Availability | Reachability only | `AgentCapabilities` exists, but no binding says how to obtain it: "configured statically" is one of the named options | https://docs.ag-ui.com/spec/1.0/basic/capabilities.md (1.0) |

## A2A

Version: protocol 1.0.0, https://a2a-protocol.org/v1.0.0/specification/; tag `v1.0.1` (2026-05-28) at https://github.com/a2aproject/A2A/releases.

A2A's premise is that an agent is opaque to its peer. The client sees a task and its results, not the work inside.

| Capability | Carried | How | Source |
|---|---|---|---|
| Turn and stream | Text only | `SendStreamingMessage` streams task status and artifact updates. Tool calls are not part of the model, so `tool.call` and `tool.result` would stay empty | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Confirmation | Extension | `TASK_STATE_INPUT_REQUIRED` pauses the task with a message; the client answers with the same `taskId` and `contextId`. Nothing says which tool, with which input, is being approved | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Interrupt | Yes | `CancelTask` | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Session resume | Yes | `contextId` groups tasks; `SubscribeToTask` reconnects to a task that has not ended; `GetTask` returns its state | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Attachments | Yes | `Part` with `raw` or `url`, plus `mediaType` and `filename` | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Artifacts | Yes | `Artifact` and `TaskArtifactUpdateEvent` are the normal way to deliver results | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Usage | Extension | No field; `metadata` keyed by an extension URI | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Model choice | Extension | No field; `metadata` keyed by an extension URI | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |
| Availability | Yes | Agent Card at `/.well-known/agent-card.json`, with declared capabilities | https://a2a-protocol.org/v1.0.0/specification/ (1.0.0) |

Whether a stream closes on `INPUT_REQUIRED` is stated both ways: one section closes it at a terminal state only, another at a terminal or interrupted state. An adapter would have to handle both.

## ACP (Agent Client Protocol)

Version: protocol version `1`, schema tag `schema-v1.27.0` (2026-10-27), https://agentclientprotocol.com/protocol/overview. Added during this comparison: it is the closest match to how Switchboard drives Claude Code and Codex. Not to be confused with the Agent Communication Protocol, a different project.

| Capability | Carried | How | Source |
|---|---|---|---|
| Turn and stream | Yes | `session/prompt`, with `session/update` notifications for message chunks and tool calls | https://agentclientprotocol.com/protocol/prompt-turn (v1) |
| Confirmation | Yes | `session/request_permission` from agent to client | https://agentclientprotocol.com/protocol/overview (v1) |
| Interrupt | Yes | `session/cancel`; the turn ends with stop reason `cancelled` | https://agentclientprotocol.com/protocol/prompt-turn (v1) |
| Session resume | If declared | `session/load` when the agent declares `loadSession` | https://agentclientprotocol.com/protocol/initialization (v1) |
| Attachments | If declared | `image`, `audio` and `resource` blocks behind `promptCapabilities`; `text` and `resource_link` always | https://agentclientprotocol.com/protocol/content (v1) |
| Artifacts | No | No event for a file handed to the person | https://agentclientprotocol.com/protocol/overview (v1) |
| Usage | Partly | `usage_update`: context `used` and `size`, optional `cost`. No input and output token counts on that page | https://agentclientprotocol.com/protocol/prompt-turn (v1) |
| Model choice | Yes | `configOptions` with category `model`, set by `session/set_config_option` | https://agentclientprotocol.com/protocol/session-config-options (v1) |
| Availability | Yes | `initialize` | https://agentclientprotocol.com/protocol/initialization (v1) |

The transport decides against it for this purpose: only stdio is defined, and the Streamable HTTP binding is still being specified (https://agentclientprotocol.com/protocol/transports). It suits a local agent program, not an API at a URL.

## Conclusion

**Offer two ports: AG-UI for any agent, ADK for agents built on ADK. Do not collect more.** The question behind the request, adding any API flexibly, is answered by AG-UI, which other frameworks can implement. ADK is kept because most of the work is done: the adapter exists, its text, tool calls, usage and attachments are recorded against a real DAK stack, and its confirmations and artifacts are recorded against an ADK server that is not DAK (the ADK section). What it lacks is generality, not a contract. Each further contract costs a full adapter, recordings and a place in every runner list, so A2A and ACP stay out.

**Why AG-UI.** Switchboard's screen shows the work: the transcript, the tool calls, the approvals, the ledger. AG-UI is the only one of the four that is both a published contract across frameworks and reaches a remote URL while showing that work. ADK REST is one framework's API. A2A hides tool calls and has no structured approval, so the reasons the app exists would stop at its boundary. ACP has no remote transport.

**Filling its gaps.** Six things need a small Switchboard profile, written with the build. Each is a choice for the build to confirm, not a tested design:

- Interrupt: close the stream and emit `session.end(aborted)` from the adapter, as DAK does. The agent may keep running if the server ignores the disconnect. Only a server that honors it stops, and the screen must not claim more. If it keeps running, a next turn sent at once overlaps it on the same thread, and the adapter's history no longer matches the server's.
- Confirmation: a `permission.ask` comes from an interrupt with `toolCallId`, not from a value of `reason`, which is open. An interrupt without it becomes a question to the person. An allow and a denial are both sent as `resolved`, with a `payload` that follows `responseSchema`. `cancelled` is only for a denial the schema cannot express, because its effect is up to the server and a `payload` states the denial outright. An interrupt whose schema the screen cannot fill stays a question to the person. Neither answer stops the tool by protocol: the tool runs on the agent's side and the specification leaves an abandoned interrupt to the producer. An approval is only as strong as the server honoring it, so the setting has to say a custom runner's confirmations depend on that server.
- Tool results: `TOOL_CALL_RESULT` has no failure flag, so `ok` needs a convention, such as a key in the event's `metadata`. Without one a failed tool shows as successful.
- History: the adapter keeps the thread's messages in memory. After a restart `hasSession` answers false, which already makes the daemon start a new session with its recap (`packages/core/src/tasks.ts:865`). The context is summarized, not preserved.
- Model and availability: models are listed in the settings and the choice is sent in `forwardedProps`. `detect` reports whether the URL answers and nothing more, and the daemon reads it at boot (`packages/core/src/server.ts:167`), so a server that comes back needs a daemon restart; `runnerVersion` stays unset, since the protocol version on `RUN_STARTED` does not tell servers apart.
- Artifacts: a `CUSTOM` event named by Switchboard. An agent that does not send it delivers files through Workspace MCP, as DAK does today.

**Remote reach has limits.** Either port reaches a remote agent, but that agent reaches the Task's files only through Workspace MCP, which listens on loopback by default. DAK gets to it by running the daemon with `SWITCHBOARD_HOST=0.0.0.0` and `SWITCHBOARD_PUBLIC_URL`. The first AG-UI version takes that as it is: an agent on the same machine can work on files, and so can one on a network the person has opened the daemon to, unless passkey login is on. With passkey login, as on the cloud host, a Task's token counts only from loopback (`packages/core/src/server.ts:497`), so an agent on another host gets 401. Any other agent can only converse.

That agent also has to learn the Task's endpoint, and nothing carries it today: DAK's is edited into its config by hand, and AG-UI has no field for MCP. On the AG-UI port the daemon reuses `StartOptions.mcpServers` in `packages/protocol/src/adapter.ts` rather than add a second field: for an AG-UI runner with the setting on it holds one `workspace` entry (the Task's endpoint and token and nothing from `mcp.yaml`), and the adapter sends it in `forwardedProps`; an ADK runner is never given it. That sends a credential to the agent, so it is a per-runner setting that is off by default. The token lasts for the Task, and while it does, it opens the Task's scope to the agent and also passes the Task's telemetry route (`packages/core/src/server.ts:2330`). With the setting off, for an agent that does not read the key, or where the token does not count, the agent can only converse. On a host with passkey login the setting refuses a non-local URL (a 400 when the list is saved), and an entry saved before passkey login was turned on is not sent the credential either, since it would leave and open nothing. What is sent and where follow the list as it was when the daemon started, the same list the adapters were built from, and a `custom:` runner never falls back to the servers Claude gets from `mcp.yaml`.

**DAK becomes one ADK endpoint, not a special runner.** The DAK adapter's wire is ADK's own: `/run_sse`, `/list-apps`, the session routes and `adk_request_confirmation`. What is DAK's is small: a default app name, a filter on artifact names, the `dak` id, `SWITCHBOARD_DAK_URL`, and names in code and on the screen. Generalizing it into an ADK adapter lets any ADK agent connect and makes DAK a configured entry. Moving DAK to AG-UI instead would need the `ag-ui-adk` middleware (0.11.0 on PyPI) in its container and give up what the adapter already does, so it is not done. Both confirmation forms and an artifact were later checked on a real ADK server that is not DAK (the ADK section above): the native form comes with an `adk_request_confirmation` call that names the tool, so the tool's name reaches the screen. This port has no model choice, so an ADK entry has no model list. It has no field for the Workspace MCP endpoint either; today DAK gets it in its own configuration, and how other ADK agents get it is for the build.

**`RunnerId` opens, narrowly.** A configured runner of either port is `custom:<name>`. A removed runner stays readable as a label on past Tasks. What becomes of the `dak` id is for the build.

**The Design rules still hold.** The AG-UI port is written from the specification with no SDK dependency, like DAK's adapter ("No runner code or protocol types are vendored"). The settings keep the name of an environment variable, never a token ("No keys"). A custom runner sends prompts, attachments and, when turned on, the Task's Workspace MCP token to its URL, which leaves the machine unless that URL is local; the setting has to say so.

**Limits of this conclusion.** The comparison itself rests on specifications. AG-UI 1.0 was released in September 2026. Two servers have since been run and recorded: a scripted one built on the reference SDK (2026-11-07) and one built on an independent framework with a real model (2026-11-08), both below. Whether other frameworks implement `outcome`, `usage` and the disconnect the same way is still unknown; usage and the stop on disconnect depend on the server.

**What the AG-UI recordings showed (2026-11-07).** The server was a scripted fake model (no keys, no billing) built on `ag-ui-protocol` 1.0.0 with aiohttp, in a throwaway directory; it is the reference SDK's own encoder, not an independent framework's server, so it shows what a conforming server sends, not how well other frameworks conform. Four scenes were recorded raw outside Git (`packages/adapters/agui/fixtures/agui-1.0.0-*.sse`, recorder `packages/adapters/agui/fixtures/record.ts`): text, a tool call with its result, a run that ends in an interrupt followed by the next run with `resume`, and a connection closed by the client mid-run.

As specified: `RUN_FINISHED.outcome` is an object, `{"type":"success"}` or `{"type":"interrupt","interrupts":[...]}`, not a bare string. `usage` is an array of `TokenUsage` (`provider`, `model`, `inputTokens`, `outputTokens`, `totalTokens`, `cachedInputTokens`), on the interrupt run as well as the success run, and absent fields are omitted. An `Interrupt` carries `id`, `reason` (`tool_approval` in the script; an open string), `message`, `toolCallId` (the id of the preceding `TOOL_CALL_START`) and `responseSchema` as a JSON Schema object. The next run answers it with `resume: [{"interruptId","status":"resolved","payload"}]` on the same `threadId`, with the history in `messages`, and the server finished normally. `TOOL_CALL_RESULT` has `messageId`, `toolCallId`, `content` (a string) and `role: "tool"`, and no failure field of its own.

Differs from what a reader might assume: the interrupt run has no `TOOL_CALL_RESULT` for the call it names (`TOOL_CALL_START` / `ARGS` / `END` and then `RUN_FINISHED`), so the adapter must treat an interrupt's `toolCallId` as the call that is waiting, not as a finished one. The only place a failure can be marked is the base event's free `metadata` object; the script put `{"isError": true}` there, which is this script's choice, not a convention the specification names. A real server may mark an error in `content` only. The rule the adapter takes: `metadata.isError === true` reads as a failed result (the one mark recorded, and nothing when absent); any other result reads as `ok: true`, so a server that marks errors elsewhere shows them as successful results whose content says what went wrong. On disconnect this server stopped. The client-side recording alone shows only that the stream ended; the evidence is the server's own log, kept with the recordings (`agui-1.0.0-server.log`, one line per request with its time): the disconnect run's handler stopped with a connection-reset error at its next write, about 1.5 seconds after the request (it writes every 0.5 seconds), and logged no normal finish, while every other run logged one. That is the behavior of this framework and this script; the specification leaves it to the server, so the adapter still must not assume it.

Verdict: the recordings fit the conclusion, so AG-UI 1.0 stays; what the build adds is a rule for marking a failed tool result and for an interrupt whose tool call has no result yet.

**What a real-model AG-UI server showed (2026-11-08).** The server was `AGUIAdapter` of pydantic-ai 2.66.0 (`pydantic-ai-slim[ag-ui,anthropic]`, `ag-ui-protocol` 1.0.0), served with Starlette and uvicorn (`from_request(..., include_usage=True)`, then `run_stream()` and `streaming_response()`), in a throwaway virtual environment that is not a dependency of Switchboard. The model was Claude Haiku 4.5 (`anthropic:claude-haiku-4-5`; the model in the usage was `claude-haiku-4-5-20251001`). It had two tools: `read_file(path)`, and `delete_file(path)` with `requires_approval=True` (`output_type=[str, DeferredToolRequests]`). This is an independent framework's server, not the reference SDK's encoder, so it is one answer to the question the scripted server left open: how well other frameworks conform. The raw streams were recorded outside Git (`packages/adapters/agui/fixtures/agui-pydantic-ai-2.66.0-*`): text (with and without `protocolVersion`, `"1.0"`), a tool call, an interrupt (with `"1.0"`), the server's log (one line per request and how its stream ended, with times), the JSON of what the adapter made of the runs, and the output of the abort run.

As specified: `RUN_FINISHED.outcome` was `{"type":"success"}`, or `{"type":"interrupt","interrupts":[...]}` when approval was pending. An `Interrupt` carried `id` (`int-<toolCallId>`), `reason` (`tool_call`; the scripted server used `tool_approval`, and the field is an open string, so both occur), `message` (`Approve delete_file({"path":"a.txt"})?`), `toolCallId` and `responseSchema` (`properties` `approved` boolean, `editedArgs` object and `reason` string, with `approved` required). `usage` was `[{provider:"anthropic", model:"claude-haiku-4-5-20251001", inputTokens, outputTokens, totalTokens}]` on `RUN_FINISHED`, on the success run and the interrupt run alike. `TOOL_CALL_RESULT` had `messageId`, `toolCallId`, a string `content` and `role: "tool"`.

Differs from what a reader might assume: pydantic-ai leaves `include_usage` off by default, so a server whose author does not turn it on sends no `usage`, and the ledger then has no usage for its runs. Sending `protocolVersion` as `"1.0"` or not at all gave the same success outcome and the same usage in the raw recordings; the interrupt was recorded raw only with `"1.0"`, and the adapter's own runs, which send no `protocolVersion`, also ended in an interrupt outcome. By pydantic-ai's code, only the `cancelled` outcome and `pendingToolCallIds` (client-run tools left over) appear when the client announces 1.0. Switchboard's adapter sends no `protocolVersion` and no client-side tools (`tools: []`), so it does not receive them today; the gain from sending it would be receiving `cancelled`, which was not checked.

Switchboard's own adapter (`createAguiAdapter`) was run against this server unchanged. Text gave `message.delta` and `usage` (source reported), then `session.end` ok. The tool call gave `tool.call` (`read_file(path=a.txt)`), `tool.result` ok, usage, then ok. An approval: the interrupt became `permission.ask` (kind write, tool `delete_file`, `toolUseId` the call's id). On allow, the next run's `resume` held `{"approved": true}`, the tool ran (`deleted a.txt`); on deny it held `{"approved": false}` and `tool.result` was `ok: true` with "The tool call was denied.", which carries no failure mark and so reads as a successful result under the rule above; the model then answered with a sentence asking for approval. Aborting after seven pieces of the assistant's text made the adapter emit `session.end` aborted; the server's log (kept with the recordings, with the abort run's output for the time of the abort) shows that run's stream ending with `CancelledError` about 3 ms after the disconnect and no normal finish, while every other run logged a normal finish. An aborted run has no `RUN_FINISHED`, so its usage never arrives and the ledger does not record it.

Verdict: the conclusion does not change, and AG-UI 1.0 stays. What depends on the server: whether `usage` is sent at all is the server's setting, and whether a disconnect stops the run is the server's behavior (this one stopped).

## What changes

Line numbers are as of 2026-10-31. These are the known places, not a complete list; the build will find more.

**Open the id**

- `packages/protocol/src/events.ts:4`: `RunnerId` accepts `custom:<name>`.
- `packages/core/src/login.ts:8` and `packages/core/src/ratelimit.ts:68`: `Record<RunnerId, …>` tables. Their readers already fall back with `?? []` (`packages/core/src/login.ts:26`, `packages/core/src/ratelimit.ts:81`); keep that.
- `packages/core/src/db.ts:93`: `runner` columns are `TEXT` with no constraint, so the columns do not change.

**Generalize the ADK adapter** (done, 2026-11-04)

- `packages/adapters/adk/` is the ADK adapter: `createAdkAdapter` takes the id, label, URL, app name, the token's environment variable name and the artifact filter.
- DAK keeps the id `dak` and is not stored: when `SWITCHBOARD_DAK_URL` is set, the daemon builds it at start as one entry (its values are in `packages/core/src/main.ts`, described in `docs/design/dak-adapter.md`). Past Tasks and the ledger keep their `dak` rows, and an older daemon after a rollback meets no id it cannot parse.
- The list of ADK servers added in Settings is its own row of the `settings` table, not a field of `Settings`, so an older daemon that writes `Settings` back does not drop it. A saved entry named `dak` is not registered.
- Shadow runs stay DAK's: the toggle is not offered when the primary is an ADK runner, and the daemon gives a `custom:` Task no saved default shadow.

**Register configured runners**

- `packages/protocol/src/model.ts:765`: `Settings` gains the list of custom runners: port (`agui` or `adk`), name, label, URL and environment variable name for the token. An `adk` entry adds the app name and artifact filter; an `agui` entry adds whether to send the Workspace MCP endpoint. `SettingsPatch` (`packages/protocol/src/model.ts:806`) gains the same for writing it. `agui` entries' models use the existing per-runner `Settings.models`, which the health route already prefers over the adapter's list (`packages/core/src/server.ts:261`).
- `packages/core/src/server.ts:1962`: saving models is refused for an adapter with no model list, so `agui` entries need an exception. A runner undetected at boot is refused one line earlier, which holds until it is detected.
- `packages/core/src/tasks.ts:1095`: the call that passes `StartOptions` to the adapter adds the Workspace MCP endpoint when an `agui` entry's setting is on.
- `packages/core/src/main.ts`: for ADK, done: the daemon opens the database once before `startServer`, reads the list and adds one adapter per entry. The list is read at start, and a change takes a daemon restart, as `SWITCHBOARD_DAK_URL` does. An `agui` entry is added the same way.
- `packages/core/src/suggest-title.ts:9`: a fixed list that stays; a custom runner does not name Tasks.
- `packages/core/src/pricing.ts:87`: a runner missing from `billing` already counts as pay-as-you-go; prices come from the `model` of each usage entry.
- New package `packages/adapters/agui/`, the wire and its mapping to `AgentEvent`.

**Show them on the screen**

- `apps/web/src/runners.ts:6`: the list already comes from the daemon's `runners`, which `RunnerInfo` (`packages/protocol/src/model.ts:1506`) feeds. Only the fallback literal stays fixed.
- `apps/web/src/components/ui.tsx:8`: done: `RunnerInfo` carries the label, and every runner pill shows it.
- `apps/web/src/quota.ts:21`: the fixed order already appends other runners; no change unless custom runners report quota, which AG-UI does not.
- `apps/web/src/components/Home.tsx:476`: without a `note`, the picker's unavailable hint treats every other runner as DAK, so the adapter's `detect` must always set one. The list itself (`apps/web/src/components/Home.tsx:472`) already works, and `apps/web/src/components/Schedules.tsx:251` and `apps/web/src/components/Ledger.tsx:61` likewise.
- `apps/web/src/components/Settings.tsx:207`: done: auto-resume is not offered for `dak` or `custom:` ids.
- `apps/web/src/components/Home.tsx:521`: done: a custom primary offers no shadow toggle, and the daemon skips the saved shadow default for it.
- `apps/web/src/components/Home.tsx:516`: done: the hint for a runner without permission modes names the runner's label.
- `apps/web/src/components/Settings.tsx:175`: the model editor lists only runners with models, and `apps/web/src/components/ModelSelect.tsx:15` says an empty list is DAK's. Both need to admit an `agui` entry.
- `apps/web/src/components/Settings.tsx`: done for ADK: a section to add and remove an ADK server (name, label, URL, app name, token variable name); no edit, remove and add again. An `agui` entry needs its own fields there.
