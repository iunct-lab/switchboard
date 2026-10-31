# Custom adapters — which contract an arbitrary agent API should plug in through

A design note, not an implementation: nothing here is built yet. It compares the contracts an agent API could use to reach Switchboard, answers whether Switchboard should collect them (ADK, AG-UI, …), and names what a build would change. The comparison reads the published specifications and released packages, checked on 2026-10-30. No server of these protocols was run or recorded; that belongs to the build, with the `runner-adapter-recording` skill.

A runner today is a `RunnerAdapter` that turns one agent's wire into `AgentEvent`. `RunnerId` is a closed list, so each new agent needs code in Switchboard, and DAK's adapter is tied to ADK's REST API.

## What a contract has to carry

| Capability | Switchboard contract | |
|---|---|---|
| Turn and stream | `RunnerAdapter.start` `packages/protocol/src/adapter.ts:153`, `RunnerSession.send` `packages/protocol/src/adapter.ts:89` | `message.delta` `packages/protocol/src/events.ts:94`, `tool.call` `packages/protocol/src/events.ts:100`, `tool.result` `packages/protocol/src/events.ts:107` |
| Confirmation | `respondPermission` `packages/protocol/src/adapter.ts:95` | `permission.ask` `packages/protocol/src/events.ts:113` |
| Interrupt | `abort` `packages/protocol/src/adapter.ts:104` | `session.end(aborted)` `packages/protocol/src/events.ts:204` |
| Session resume | `resumeSessionId` `packages/protocol/src/adapter.ts:33`, `hasSession` `packages/protocol/src/adapter.ts:159` | `session.start.runnerSessionId` `packages/protocol/src/events.ts:86` |
| Attachments | `StartOptions.attachments` `packages/protocol/src/adapter.ts:72` | |
| Artifacts | `StartOptions.attachmentDir` `packages/protocol/src/adapter.ts:78` | `artifact(file)` `packages/protocol/src/events.ts:162` |
| Usage | | `usage` `packages/protocol/src/events.ts:134` |
| Model choice | `RunnerAdapter.models` `packages/protocol/src/adapter.ts:142`, `StartOptions.model` `packages/protocol/src/adapter.ts:20` | |
| Availability | `detect` `packages/protocol/src/adapter.ts:152`, `RunnerDetection` `packages/protocol/src/adapter.ts:115` | |

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

It carries nearly everything, but it is one framework's server API rather than a contract other frameworks implement. App name, user path and event shape are ADK's.

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

**Do not collect contracts. Open one port, and make it AG-UI.** ADK stays what it is now: the wire of one specific adapter, not a second port. Each extra contract costs a full adapter, recordings and a place in every runner list, and the question behind the request, adding any API flexibly, is answered by one port that other agents can implement.

**Why AG-UI.** Switchboard's screen shows the work: the transcript, the tool calls, the approvals, the ledger. AG-UI is the only one of the four that is both a published contract across frameworks and reaches a remote URL while showing that work. ADK REST is one framework's API. A2A hides tool calls and has no structured approval, so the reasons the app exists would stop at its boundary. ACP has no remote transport.

**Filling its gaps.** Six things need a small Switchboard profile, written with the build. Each is a choice for the build to confirm, not a tested design:

- Interrupt: close the stream and emit `session.end(aborted)` from the adapter, as DAK does. The agent may keep running if the server ignores the disconnect. Only a server that honors it stops, and the screen must not claim more. If it keeps running, a next turn sent at once overlaps it on the same thread, and the adapter's history no longer matches the server's.
- Confirmation: a `permission.ask` comes from an interrupt with `toolCallId`, not from a value of `reason`, which is open. An interrupt without it becomes a question to the person. An allow and a denial are both sent as `resolved`, with a `payload` that follows `responseSchema`. `cancelled` is only for a denial the schema cannot express, because its effect is up to the server and a `payload` states the denial outright. An interrupt whose schema the screen cannot fill stays a question to the person. Neither answer stops the tool by protocol: the tool runs on the agent's side and the specification leaves an abandoned interrupt to the producer. An approval is only as strong as the server honoring it, so the setting has to say a custom runner's confirmations depend on that server.
- Tool results: `TOOL_CALL_RESULT` has no failure flag, so `ok` needs a convention, such as a key in the event's `metadata`. Without one a failed tool shows as successful.
- History: the adapter keeps the thread's messages in memory. After a restart `hasSession` answers false, which already makes the daemon start a new session with its recap (`packages/core/src/tasks.ts:845`). The context is summarized, not preserved.
- Model and availability: models are listed in the settings and the choice is sent in `forwardedProps`. `detect` reports whether the URL answers and nothing more, and the daemon reads it at boot (`packages/core/src/server.ts:169`), so a server that comes back needs a daemon restart; `runnerVersion` stays unset, since the protocol version on `RUN_STARTED` does not tell servers apart.
- Artifacts: a `CUSTOM` event named by Switchboard. An agent that does not send it delivers files through Workspace MCP, as DAK does today.

**Remote reach has limits.** The port reaches a remote agent, but that agent reaches the Task's files only through Workspace MCP, which listens on loopback by default. DAK gets to it by running the daemon with `SWITCHBOARD_HOST=0.0.0.0` and `SWITCHBOARD_PUBLIC_URL`. The first version takes that as it is: an agent on the same machine can work on files, and so can one on a network the person has opened the daemon to, unless passkey login is on. With passkey login, as on the cloud host, a Task's token counts only from loopback (`packages/core/src/server.ts:497`), so an agent on another host gets 401. Any other agent can only converse.

That agent also has to learn the Task's endpoint, and nothing carries it today: DAK's is edited into its config by hand, and AG-UI has no field for MCP. The build passes it through `StartOptions` (`packages/protocol/src/adapter.ts:14`), deciding whether to reuse `mcpServers` (`packages/protocol/src/adapter.ts:84`, today a list for Claude only) rather than add a second field, and the adapter sends the URL and the Task's token in `forwardedProps`. That sends a credential to the agent, so it is a per-runner setting that is off by default. The token lasts for the Task, and while it does, it opens the Task's scope to the agent and also passes the Task's telemetry route (`packages/core/src/server.ts:2331`). With the setting off, for an agent that does not read the key, or where the token does not count, the agent can only converse. On a host with passkey login the setting should refuse a non-local URL, since the credential would leave and open nothing.

**DAK is not moved onto it now.** DAK serves ADK REST. Moving it would need the `ag-ui-adk` middleware (0.11.0 on PyPI) in DAK's container, would give up the recorded behavior for confirmations and artifacts, and gains nothing for a runner that works. When a custom runner has proved the port, DAK can be reconsidered by comparing recordings.

**`RunnerId` opens, narrowly.** Built-in ids stay; a configured runner is `custom:<name>`. Past Tasks keep their ids, and a removed runner stays readable as a label, as past DAK Tasks do.

**The Design rules still hold.** The port is written from the specification with no SDK dependency, like DAK's adapter ("No runner code or protocol types are vendored"). The settings keep the name of an environment variable, never a token ("No keys"). A custom runner sends prompts, attachments and, when turned on, the Task's Workspace MCP token to its URL, which leaves the machine unless that URL is local; the setting has to say so.

**Limits of this conclusion.** It rests on specifications, not on a running server. AG-UI 1.0 was released in September 2026, and whether real servers implement `outcome`, `usage` and the disconnect well is unknown. The first step of a build is to record one real AG-UI server; if interrupts or usage do not hold up there, this conclusion should be revisited before the rest is built.

## What changes

Line numbers are as of 2026-10-30. These are the known places, not a complete list; the build will find more.

**Open the id**

- `packages/protocol/src/events.ts:4`: `RunnerId` accepts `custom:<name>` beside the built-in ids.
- `packages/core/src/login.ts:8` and `packages/core/src/ratelimit.ts:65`: `Record<RunnerId, …>` tables. Their readers already fall back with `?? []` (`packages/core/src/login.ts:26`, `packages/core/src/ratelimit.ts:78`); keep that.
- `packages/core/src/db.ts:93`: `runner` columns are `TEXT` with no constraint, so no migration is needed.

**Register configured runners**

- `packages/protocol/src/model.ts:760`: `Settings` gains the list of custom runners: name, label, URL, environment variable name for the token, and whether to send the Workspace MCP endpoint. `SettingsPatch` (`packages/protocol/src/model.ts:801`) gains the same for writing it. Their models use the existing per-runner `Settings.models`, which the health route already prefers over the adapter's list (`packages/core/src/server.ts:261`).
- `packages/core/src/server.ts:1960`: saving models is refused for an adapter with no model list, so custom runners need an exception. A runner undetected at boot is refused one line earlier, which holds until it is detected.
- `packages/core/src/tasks.ts:1076`: the call that passes `StartOptions` to the adapter adds the Workspace MCP endpoint when the setting is on.
- `packages/core/src/main.ts:87`: `adapters` adds one AG-UI adapter per entry. It is built before `startServer` opens the settings store (`packages/core/src/server.ts:149`), so the build has to read the list earlier or register these adapters inside `startServer`. Either way the list is read at boot, and a change takes a daemon restart, as `SWITCHBOARD_DAK_URL` does today.
- `packages/core/src/suggest-title.ts:9`: a fixed list that stays; a custom runner does not name Tasks.
- `packages/core/src/pricing.ts:87`: a runner missing from `billing` already counts as pay-as-you-go; prices come from the `model` of each usage entry.
- New package `packages/adapters/agui/`, the wire and its mapping to `AgentEvent`.

**Show them on the screen**

- `apps/web/src/runners.ts:6`: the list already comes from the daemon's `runners`, which `RunnerInfo` (`packages/protocol/src/model.ts:1501`) feeds. Only the fallback literal stays fixed.
- `apps/web/src/components/ui.tsx:8`: the label map gives way to the configured label, which `RunnerInfo` has to carry.
- `apps/web/src/quota.ts:21`: the fixed order already appends other runners; no change unless custom runners report quota, which AG-UI does not.
- `apps/web/src/components/Home.tsx:476`: without a `note`, the picker's unavailable hint treats every other runner as DAK, so the adapter's `detect` must always set one. The list itself (`apps/web/src/components/Home.tsx:472`) already works, and `apps/web/src/components/Schedules.tsx:251` and `apps/web/src/components/Ledger.tsx:61` likewise.
- `apps/web/src/components/Settings.tsx:207`: auto-resume excludes DAK by name, so a custom runner would get a toggle that never fires. Exclude the `custom:` ids as well; `RunnerInfo` has no field for limit detection.
- `apps/web/src/components/Home.tsx:521`: the shadow toggle tests `runner !== "dak"`, so a custom Task would offer a DAK shadow and send the same prompt to DAK. Limit it to the built-in runners. That alone only hides the toggle: an untouched form still gets the saved shadow default from the daemon (`packages/core/src/tasks.ts:681`), so the daemon has to skip shadows when the primary is custom too.
- `apps/web/src/components/Home.tsx:516`: the hint for a runner without permission modes names DAK; it needs a wording that fits a custom runner.
- `apps/web/src/components/Settings.tsx:175`: the model editor lists only runners with models, and `apps/web/src/components/ModelSelect.tsx:15` says an empty list is DAK's. Both need to admit a custom runner.
- `apps/web/src/components/Settings.tsx:63`: a new section beside the DAK settings to add and remove a custom runner.
