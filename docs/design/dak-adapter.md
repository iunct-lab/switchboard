# DAK adapter — ADK REST `/run_sse` + Workspace MCP

Issue #19, proposal §3 (runner adapters) and §6 Phase 2. Decentralized-Agent-Kit's agent is a Google ADK app in a container (`agent:8000`, `adk web --a2a`). Switchboard does not run it, bundle it or speak A2A; it is an ADK REST client. Recorded fixtures (outside Git; record your own outside Git with the `runner-adapter-recording` skill; `bun scripts/fixtures.ts fetch` works only in a clone with the private history): `packages/adapters/dak/fixtures/*.sse` (DAK @ e966c05, google-adk 2.x, local llama.cpp model); a deterministic stand-in for tests: `fixtures/fake-adk.ts`.

## Wire

```
GET  /list-apps                                        → ["dak_agent"]                      (detect)
POST /apps/dak_agent/users/switchboard/sessions {state}  → {id, …}                            (session.start; runnerSessionId = id)
GET  /apps/dak_agent/users/switchboard/sessions/<id>     → 200 | 404                          (resume check; 404 → a new session, with a `status` saying the context was lost)
POST /run_sse {app_name, user_id, session_id, new_message:{role:"user", parts:[{text}, …attachments]}, streaming:true}
     → text/event-stream, one `data: <ADK Event JSON>` per event, blank-line separated
GET  /apps/dak_agent/users/switchboard/sessions/<id>/artifacts/<name>?version=<n>   → {inlineData | text}   (an `actions.artifactDelta` entry; see Files below)
```

| ADK event | AgentEvent |
|---|---|
| `content.parts[].text`, `partial: true` | `message.delta(assistant)`, `messageId = invocationId` |
| … with `thought: true` | `status: thinking` (never shown as text) |
| final event (`partial: false`) with text | text only if nothing streamed for that invocation |
| `parts[].functionCall` | `tool.call {id, name, input: args}` |
| `parts[].functionCall` named `adk_request_confirmation` (DAK's explicit confirmation tool; `args.originalFunctionCall`) | `permission.ask {id: call id, tool: original name, input: original args, toolUseId: original id}` — **not** a tool.call |
| `actions.requestedToolConfirmations[<id>]` (ADK-native `require_confirmation`) | `permission.ask` with the hint |
| `parts[].functionResponse` | `tool.result` (ok unless `response.error` / `isError`); the echo of our own confirmation answer is skipped |
| `usageMetadata` on final events (`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`) | `usage(turn)` per model call: input = prompt − cached, cacheRead = cached, output = candidates + thoughts; summed into `usage(reported)` when the stream ends (tokens only; the ledger prices `modelVersion`, DAK is `billing: api`) |
| `parts[].inlineData` on a final event | the bytes are saved as `inline.<ext>` in the task's attachment directory → `artifact(file)`; the daemon then records an `attachment` |
| `actions.artifactDelta {name: version}` | `GET …/artifacts/<name>?version=` → the bytes saved under that name → `artifact(file)`, except a name starting with `tool_output_` (see Files below) |
| `errorCode` / `errorMessage` | `error`, then `session.end(error)` |
| stream closed | `session.end(ok)`; unless a confirmation is still open — then the turn stays open and the answer (a `functionResponse` for `adk_request_confirmation` with `{confirmed}`, `invocation_id` of the ask) starts the next `/run_sse` |

`send()` during a stream is queued and runs as the next turn. `abort()` (and `close()` once its grace period runs out) cancels the HTTP stream (ADK has no cancel API) and drops open confirmations as denied. Closing the stream is itself the cancel: ADK logs `Root node dak_agent was cancelled.`, LiteLLM's request to the model server is dropped, and the model output of that turn is not saved to the session (observed with llama-server: `srv stop: cancel task`).

**No permission mode** (#58): the adapter reports `permissionModes: []`. What gets confirmed is decided on the DAK side (`require_confirmation` on its MCP toolsets, `adk_request_confirmation`) and, for `exec.run`, by Switchboard's own Workspace MCP policy (`mcp.yaml`); every confirmation still reaches the UI. This is the same behavior as DAK's own `adk web`, so there is nothing to align with a terminal default.

### Long silent turns (#121)

The `/run_sse` stream can be silent for many minutes while the turn is healthy. Thought tokens and reply text stream as `partial` events, but ADK emits **nothing** while the model writes function-call arguments. With a local model that is slow and long: Qwen3.8-27B (IQ3_XXS) on an RTX 2080 Ti generates at ~6.8 tok/s, so a 2,400-token tool call (a document passed to a write tool) is six minutes of silence.

Bun's `fetch` timeout is an **idle** timeout (it resets on every byte received, including while the body is being read), so only silent turns were cut. Measured with Bun 1.4.2 against a local server that sends one SSE event and then stays silent for 450 s: the default fetch fails at **360.166 s** with `TimeoutError: The operation timed out.`; with `timeout: false` the late event arrives at 450.007 s. A task hit exactly this: two retries each ended after 359 s with zero events, and because the cut cancels the turn and discards its output (above), every retry replayed the same prompt into the same cut — retrying could never make progress.

The `/run_sse` fetch therefore sets `timeout: streamIdleTimeoutMs`, default **2 hours**. It is not `false`: the timeout was also the only thing that ends a turn whose DAK side died without closing the connection (paused container, sleeping remote host, half-open TCP) — without it the task stays running forever and every `send()` queues behind it. 2 h is above DAK's own LiteLLM `request_timeout` (6000 s), so a model call that really stalls surfaces as DAK's error first. Bun checks the idle timeout on a coarse tick (any value up to a few seconds fires after ~8 s), which only matters for tests. `abort()` still stops a stream at once, and `close()` after its grace period. The session endpoints keep their bounded `timeoutMs`. Guarded by the tests `run_sse fetch replaces Bun's default timeout with a long idle timeout (a silent turn must not be cut)` and `a DAK side that goes silent without closing ends the turn after the idle timeout; …`.

## Workspace MCP from inside the container

DAK's agent has no file tools; `agent_config.yaml` lists MCP servers it discovers at boot (`mcp_servers:` → `McpToolset`, `require_confirmation: true`, so every tool call through it is a confirmation → `permission.ask` here). To let it touch the repository of a task:

1. Run Switchboard reachable from Docker: `SWITCHBOARD_HOST=0.0.0.0 SWITCHBOARD_PUBLIC_URL=http://host.docker.internal:47831 bun run core` — off-loopback the local API needs the token (`~/.switchboard/token`), the web UI asks for it once; `/mcp/<taskId>` always needs its per-task token. On Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the agent service.
2. Issue the task's endpoint (Brief → Workspace MCP → エンドポイントを発行) and put it in DAK's `agent/agent_config.yaml`, with the token in the URL rather than in `headers:`:
   ```yaml
   mcp_servers:
     - name: "switchboard"
       url: "http://host.docker.internal:47831/mcp/<taskId>?token=<token>"
       type: "http"
   ```
   then restart the agent container. The token dies with the task (or on 失効して再発行); the URL is scope-bound, so a stale entry is harmless (401).

   **`headers:` on this entry is a no-op with the pinned DAK version, not a supported alternative.** google-adk's own
   `StreamableHTTPConnectionParams`/`SseConnectionParams` do accept a `headers` dict and forward it — but DAK's own
   `agent/dak_agent/skill_tools.py::make_mcp_toolset()`, which is what actually turns a `mcp_servers:` entry into a
   connection for this per-skill/per-task server path, only reads `url` and `type` off the config entry; `headers` is
   parsed into `AgentConfig.mcp_servers` but silently dropped before it ever reaches `McpToolset`. Verified by reading
   `google/adk/tools/mcp_tool/mcp_session_manager.py` (headers ARE plumbed through at the ADK layer) against
   `dak_agent/skill_tools.py` (headers are NOT read back out) in the checked-out DAK repository. Switchboard's `/mcp/<taskId>`
   already accepts the token via `?token=` as well as `Authorization: Bearer` (`packages/core/src/mcp.ts`), so the query
   string is the form that actually reaches Switchboard with this DAK version — no DAK-side change required.
3. What the agent then has: `fs.list` / `fs.read` / `fs.grep` (scope-contained), `exec.run` (read-only commands run at once, everything else asks in the UI), `fs.write` / `fs.patch` (staged, applied in the UI), `task.note`, `fs.pending`.

Because DAK discovers MCP servers at boot, a per-task URL means editing the config per task. The planned DAK-side change (in DAK, not here) is a `switchboard` entry whose URL comes from the session `state` (`state.switchboard.mcp`) that the adapter sets when it creates the session; until then the config edit above is the procedure. Nothing in Switchboard depends on DAK: remove the adapter and the daemon boots the same.

## Verified

- Real DAK stack (`docker compose up`, local llama.cpp model): text reply, three tool calls (`list_skills` → `enable_skill` → `list_files` via DAK's MCP server) — both recorded as fixtures and replayed in tests.
- Docker → host: `getent hosts host.docker.internal` resolves (spike doc); the MCP endpoint answers `initialize` from a container when the daemon listens on `0.0.0.0` (manual check below).

```bash
docker run --rm curlimages/curl -s -X POST "http://host.docker.internal:47831/mcp/<taskId>" \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

## Files (#124)

**In.** A turn's attachments go out as extra `new_message.parts` after the text part, one each, because DAK runs in a container and cannot open the paths in the prompt: text files (`text/*`, JSON, YAML, SVG) as `{text: "--- <name> ---\n<content>"}`, everything else (images, PDF) as `{inline_data: {mime_type, data: <base64>}}`. A file that cannot be read fails the turn before it is sent. Checked against ADK (google-adk 2.8.0, DAK's fake LLM, 2026-10-01): the model request carries the text as `text` and an image as `image_url` (`data:<mime>;base64,…`), so a model that takes images sees it. Whether a given model understands the image was not checked (the model is the user's choice). `fs.read` of an image through Workspace MCP (`workspace-mcp.md`) is not an image path: ADK hands the tool result to the model as a JSON string, so the model does not see it as an image.

**Out.** `inlineData` parts of a final event (a partial one repeats in the final) and the `artifactDelta` entries of an event are written into the task's attachment directory under their own name (never over a file there: `name-2.ext`, …; an ADK name cannot leave the directory) and emitted as `artifact(file)`; core registers each regular file there as an attachment (a symlink is refused). One that cannot be had (a fetch refused, a fetched artifact without bytes, a write that failed) is a `status` and the others still come (an `inlineData` part without data is skipped, with no status); the turn's abort stops a fetch in flight. Without an attachment directory nothing is written.

**What DAK makes today.** Only DAK's harness saves artifacts, and only to spill a long tool output (`tool_output_*.txt`); no tool hands a file to the person. Those are DAK's own, so the adapter does not fetch a name starting with `tool_output_` (decision A, #124, 2026-10-01): today nothing arrives and nothing noisy shows. When DAK gets a tool that gives the person a file, it arrives through `artifactDelta` with no change here. Where DAK makes a file the person can use today is Workspace MCP `fs.write`, staged as a diff for the person to apply.
