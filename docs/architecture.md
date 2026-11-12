# Architecture

Switchboard is one daemon that starts the coding-agent CLIs you already have, turns what they emit into one event vocabulary, and serves a browser UI over the top. This page lists the parts, where you can extend it, and where its data lives.

## Components

- **Daemon** (`packages/core/`). A Bun process that serves the HTTP and WebSocket API and the built Web UI. It holds the sqlite store, the task lifecycle, the ledger (usage and cost), runner routing, knowledge and the scheduler. It also serves the Workspace MCP endpoint that gives a runner guarded access to a repository.
- **Runner adapters** (`packages/adapters/`). Each adapter starts one kind of runner and maps its output to `AgentEvent`. `claude/` drives Claude Code (`stream-json`), `codex/` drives Codex (`app-server`), `adk/` talks to an ADK REST server such as DAK, and `agui/` talks to an AG-UI server. The daemon boots with any subset, and the ADK and AG-UI adapters are off unless configured ([`docs/design/dak-adapter.md`](design/dak-adapter.md), [`docs/design/custom-adapter.md`](design/custom-adapter.md)).
- **Protocol** (`packages/protocol/`). The zod schemas everything shares: `AgentEvent`, the task model, the RPC messages and the `RunnerAdapter` interface. It has no runner-specific code.
- **Web UI** (`apps/web/`). A React and Vite app that the daemon serves. It is used in a browser tab or as a home-screen app, and it talks to the daemon only through the API and WebSocket.
- **Rescue** (`rescue/`). A small separate process (`sb-rescue`) that runs the daemon from immutable releases, promotes a new release with automatic rollback, and serves a rescue page when the daemon does not start ([`docs/design/releases-and-rescue.md`](design/releases-and-rescue.md)).
- **Backlog tools and skills** (`ops-kit/`). A kit shared across repositories: the `ops-kit` command for Issues, the Project and lint, and the skills that describe the development flow. `scripts/setup/` has thin entries that run it with this repository's `ops.config.json` ([`ops-kit/README.md`](../ops-kit/README.md)).

## Extension points

- **A runner adapter.** Implement `RunnerAdapter` and emit `AgentEvent`, both defined in [`packages/protocol/src/adapter.ts`](../packages/protocol/src/adapter.ts) and [`packages/protocol/src/events.ts`](../packages/protocol/src/events.ts). An adapter detects the runner, starts a session, and reports permission requests, tool calls and usage as events. For an ADK or AG-UI server you only add configuration ([`docs/design/custom-adapter.md`](design/custom-adapter.md)).
- **Override files in `~/.switchboard/`.** `routing.yaml` replaces the runner routing rule table, `mcp.yaml` replaces the Workspace MCP policy (which commands run without asking), and `pricing.json` replaces the model price table. Each is optional and read once at boot; without one, the daemon uses the shipped default in `packages/core/config/`.
- **Workspace MCP** ([`packages/core/src/mcp.ts`](../packages/core/src/mcp.ts), [`docs/design/workspace-mcp.md`](design/workspace-mcp.md)). Each task gets its own MCP endpoint, so a runner without file tools of its own, or one started with `--mcp-config`, can list, read and search files within the task's scope and run commands. Read-only commands run at once, and anything else waits for an approval on the task.
- **Skills** ([`ops-kit/skills/`](../ops-kit/skills/)). The steps of the development flow are Markdown skills. Edit one or add one, and it is copied into each repository when a task's runner starts ([`docs/design/skill-sync.md`](design/skill-sync.md)).

## Data

Data lives in `~/.switchboard/` (override with `SWITCHBOARD_HOME`):

- the sqlite database, which is the index, the ledger and the source of the backlog;
- `token`, the local API token, which is enforced only off loopback;
- the optional `routing.yaml`, `mcp.yaml` and `pricing.json` overrides;
- `attachments/`, the files attached to turns, one folder per task and never inside a repository;
- `artifacts/`, copies of the reports registered on the Task screen ([`docs/design/artifacts.md`](design/artifacts.md)).

Knowledge (rules, commands, notes) is a Markdown folder at `~/Knowledge` (`SWITCHBOARD_KNOWLEDGE`). Runner sessions stay where the runner keeps them (for Claude Code, `~/.claude/projects/`), so `--resume` works.

What is sent outside the machine is described in [`SECURITY.md`](../SECURITY.md).
