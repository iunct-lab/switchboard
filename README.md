# Switchboard

**A local control plane for coding agents.** One screen, one knowledge base, one ledger — for the Claude Code and Codex you are already logged into, and for your own agents.

## How this repository works

This repository is a read-only copy of a private development repository: its `main` is that repository's `main` tree, sent here by a sync as one commit at a time, without the private history. Nothing is developed here.

- **Issue and pull request numbers** (`#N`) in files and commit messages refer to the private tracker and cannot be opened here.
- **Pull requests are not accepted.** A pull request opened here is answered with this policy and closed automatically.
- **Requests and bug reports** go to an Issue of the kind *Request* (the only Issue form here). A request is read and taken into the private backlog; the Issue is answered there and closed with the outcome.
- **Vulnerabilities** are reported privately through a GitHub Security Advisory: https://github.com/iunct-lab/switchboard/security/advisories/new (see `SECURITY.md`). Not in a public Issue or Discussion.
- **Questions and discussion** go to Discussions: https://github.com/iunct-lab/switchboard/discussions

## What it is

**Who it is for.** A solo developer who works in Japanese: the UI is Japanese only, one person runs it on their own machine, and at least one of Claude Code or Codex is installed and logged in. Sharing it within a team, an English UI, and running it without any runner are out of scope.

Switchboard does not bundle any vendor CLI, does not hold API keys, and adds no approval of its own: what runs without asking is decided by the runner's permission mode (default Auto, [docs/design/permission-modes.md](docs/design/permission-modes.md)) and your answer policies. It spawns the runners you have installed, normalizes what they emit into one event vocabulary (`AgentEvent`), and gives you a task-centric UI over the top: transcript, permissions, scope, cost.

The public repository is a read-only mirror with a fresh history that accepts requests, not PRs; you can [try it on one repository](#try-it-on-one-repository) without GitHub, and a fork can run the whole development process for itself ([the Project and PR flow](#use-the-project-and-pr-flow)).

### Why

Terminal-based agents are flexible, but the person ends up doing the routing (Claude or Codex?), the directory hopping, the CLAUDE.md / AGENTS.md bookkeeping, and the cost guessing. Switchboard moves those to a daemon and a thin UI, while leaving the agents themselves untouched.

## Features

**Choosing a runner and a workspace**

- Rule-table runner routing ([`packages/core/src/routing.ts`](packages/core/src/routing.ts), `routing.yaml`) with the reason shown on the Task Brief.
- `Workspace の自動選択`: leave the Workspace select on `自動` and one read-only LLM turn picks a registered Workspace, or you are asked to pick.
- A model select per task and `思考の深さ` per task, both changeable on a running task (`POST /api/tasks/:id/model`, `POST /api/tasks/:id/effort`).
- Shadow runs (when DAK is enabled): the same request mirrored to DAK as a linked task.

**Knowledge and the inbox**

- Knowledge, a Markdown folder ([`packages/core/src/knowledge.ts`](packages/core/src/knowledge.ts)).
- The Materializer writes user-level `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.claude/commands/`, never a repository ([`packages/core/src/materializer.ts`](packages/core/src/materializer.ts)).
- Inbox → Task ([`packages/core/src/inbox.ts`](packages/core/src/inbox.ts)).

**Watching and steering agents**

- The Task screen: transcript, `差分` tab, `ターミナル` tab (`bun-pty` in the daemon), approvals and permission modes ([`docs/design/permission-modes.md`](docs/design/permission-modes.md)), attachments, the Web UI's CSP, and a `成果物` tab for registered reports ([`docs/design/artifacts.md`](docs/design/artifacts.md)).
- Workspace MCP with staged writes ([`packages/core/src/mcp.ts`](packages/core/src/mcp.ts), [`docs/design/workspace-mcp.md`](docs/design/workspace-mcp.md)).
- `要対応` and a background turn judge; per-task Evals and the Insights screen (evaluations and the reports across Tasks).
- Terminal Claude Code sessions imported as tasks.
- `承認` as a PWA ([`docs/design/mobile-approval.md`](docs/design/mobile-approval.md)).
- The rail's Task list: searched by title or directory, filtered by state, drawn 50 rows at a time, with stopped Tasks archived out of it and brought back.

**Cost**

- Ledger: reported usage into sqlite, priced from a data table (`pricing.json`, dated prices, 1-hour cache writes).
- Task budgets that hold a task over its budget.
- The subscriptions' usage windows (`quota` table, [`packages/core/src/db.ts`](packages/core/src/db.ts)) and per-runner auto-resume after a usage-limit stop.

**Changing the tool from inside it**

- The meta workspace and its `改善` buttons; Self-dev checks and apply-and-restart ([`packages/core/src/selfdev.ts`](packages/core/src/selfdev.ts), [`docs/design/self-dev.md`](docs/design/self-dev.md)).
- Immutable releases, promotion with automatic rollback, and the rescue page ([`rescue/`](rescue/), [`docs/design/releases-and-rescue.md`](docs/design/releases-and-rescue.md)).
- The feedback button → request Issue, PBI, Task.
- The backlog screen: the open requests and PBIs of every registered workspace by stage, read from the daemon's SQLite store, which is the source of the backlog; GitHub's Issues and Project are kept in sync with it (edits are saved there first and sent to GitHub afterwards, and a GitHub limit or outage does not stop a stage). `判断待ち` is answered in place, and `バックログを進める` runs on a schedule.
- The scheduler and the `設定` tab (see Run).

**Runners**

- Runner adapters as optional plugins: Claude Code (`stream-json`), Codex (`app-server`), an ADK REST adapter for DAK (off by default; set `SWITCHBOARD_DAK_URL` to enable it, [`docs/design/dak-adapter.md`](docs/design/dak-adapter.md)) and an AG-UI adapter, over one `AgentEvent` / `RunnerAdapter` contract ([`packages/protocol/src/adapter.ts`](packages/protocol/src/adapter.ts)).
- The daemon boots with any subset; it holds no keys (see Limits and data).
- License checks: every dependency's license against an allow list (`bun run licenses:check`).

**Outside those**

- An AWS instance that starts on demand and stops when idle ([`docs/design/cloud-hosting.md`](docs/design/cloud-hosting.md)).
- Tasks that run in the cloud (Claude Code on the web, [`docs/design/claude-cloud.md`](docs/design/claude-cloud.md)).

## Architecture

```
apps/web            React + Vite UI, served by the daemon; a browser tab or a home-screen app (PWA). No desktop shell
packages/core       Bun daemon: HTTP + WebSocket API, sqlite store, task lifecycle, ledger
                    + a Task's approval wait (an SSO device code) relayed to its screen, memory only (docs/design/device-auth.md)
packages/protocol   AgentEvent / Task / RPC schemas (zod) — the one contract everything shares
packages/adapters/  Runner plugins. Any subset may be installed.
  claude/           Claude Code via `claude -p --input-format stream-json --output-format stream-json`
  codex/            Codex via `codex app-server` JSON-RPC (stdio)
  adk/              optional, off unless SWITCHBOARD_DAK_URL is set: Decentralized-Agent-Kit via ADK REST /run_sse (SSE) + Workspace MCP for files; no A2A
  agui/             optional, off unless a custom runner is configured: an AG-UI server as a runner (SSE), for agents of your own
```

Components, extension points and data are described in [docs/architecture.md](docs/architecture.md).

The daemon registers its own repository as the **meta workspace**, so you can point an agent at Switchboard from inside Switchboard ("`このアプリを改善`"). A second button on any other workspace ("<name> `を改善`") does the same for that repository with a prefix the daemon reads off its tree (layout, CLAUDE.md / AGENTS.md, test and run commands; `GET /api/workspaces/:id/brief`); while the prompt still starts with an inserted prefix, switching the Workspace select swaps just that prefix. It is also an MCP server (`/mcp/<taskId>`, per-task token): runners without file tools touch the repository through scope-contained `fs.*` / `exec.run` tools, with approvals surfacing in the UI (`docs/design/workspace-mcp.md`).

**No desktop shell.** The browser UI covers what a desktop shell would be for: it installs as a PWA on a desktop or a phone, the daemon runs from an immutable release promoted only after it boots, and the rescue page (`sb-rescue`) undoes a bad update from any browser (`docs/design/releases-and-rescue.md`); terminal notifications are a separate feature (`設定 → 端末通知`). You send a request about Switchboard from its own browser UI and the change reaches the running daemon.

## Run

```bash
./scripts/setup.sh        # installs Bun if needed, then `bun install`
bun run dev               # core on :47831, web on :5173
open http://localhost:5173
```

The built UI the daemon serves (`bun run --cwd apps/web build`, then `http://localhost:47831/`) can be added to a phone's or desktop's home screen as an app (PWA; needs HTTPS or localhost) and opens on `承認` (`/approvals`), the unanswered permission asks of every task. From a phone over Tailscale: `docs/design/mobile-approval.md`. While it is open, tool approvals and `要対応` also show as OS notifications (`設定 → 端末通知`).

Releases with a rescue page: run the daemon from an immutable release under `sb-rescue`, promote a commit only after it booted on a spare port, go back automatically or with one button from a phone-sized page that works while Switchboard is down, opened from `救援画面` at the top right of every screen (`docs/design/releases-and-rescue.md`; every green merge on `main` gets a `vX.Y.Z` tag and Release, and under sb-rescue the daemon follows the newest tag by itself, no schedule needed, and holds when it did not start — Tags and unattended updates; to keep sb-rescue running on a local Linux machine, a systemd user unit template is in the same document under "Keep it running").

`設定画面`: the `設定` tab keeps the saved defaults in one place (approval mode, auto-resume, shadow, LLM suggestions, the turn judge, the backlog sweep), `モデルの選択肢` (the models each runner offers on Home, the Brief and the defaults: add, remove and reorder them without a PR or a restart; a runner never saved offers the bundled list, and a runner on Amazon Bedrock its Bedrock list) and `自動で始まる` `Task の既定`: the runner and model the backlog stage buttons and the feedback button start their Tasks on, and `上限のときの代わり`: an order of other runners (and the usage at which to switch, `fallbackAt`) that those Tasks and scheduled ones start on, on their CLI default model, while the decided runner is at its usage limit — the Task's transcript says so; empty switches nothing; `種類ごと` (per kind: `すぐ直す`, `要望として登録`, `PBI にする`, `Task に分解`, `実装`, `状況確認`, `閉じる`) a line reads `共通` until you open it with `変える` and change its runner, model or effort (opening alone saves nothing); that kind's own choice then wins, and a kind left on `共通` starts on the common one (`バックログを進める`: on the schedule's); a schedule has its own model, and a new schedule's runner / model start from that default; three more cards hold values you may want to tune while running, each with its default shown and `既定に戻す` per card — `使用量と自動再開`: the usage (of the runner a stage Task starts on) at which `バックログを進める` holds back to one stage Task overall, the automatic resume's first wait when no reset time is known and how long that wait may grow, how many usage-limit stops in a row it resumes after, the text it sends (after the fixed `[Switchboard 自動再開]` head), how many daemon stops in a row a Task is continued after, and the record count under which the Ledger's runner comparison calls a row too thin; `判定と自動選択`: the runner / model asked when the judge's runner cannot answer (both the turn judge and the rubric judge), the turn judge's timeout, and how long `Workspace の自動選択` may take before it asks you to pick; `新規作成の既定`: the runner Home's creation form starts on and the cron a new schedule starts with, and `思考の深さ` (thinking effort) — chosen per task on Home, per schedule, and in `自動で始まる` `Task の既定`, from the runner's own list (`efforts` on `/api/health`): Claude Code gets `--effort <value>`, Codex the `effort` of every `turn/start`; empty is the CLI's own default, DAK decides it itself; it is shown on the Brief and changeable there on a running task like the model — from the next turn (`POST /api/tasks/:id/effort`).

Running it on your own machine as a container, the same tools and paths as the cloud host (`bash container/up.sh`; what is kept, what the Docker socket means): [Running Switchboard as a container on your own machine](docs/design/local-container.md).

Moving the history to another machine (`docs/design/cloud-hosting.md` §5): `bun packages/core/src/main.ts export <out> [--encrypt <age recipient>]` on the old one, then `bun packages/core/src/main.ts import <file> [--identity <age key file>]` into an empty HOME on the new one (same absolute paths; nothing is rewritten).

For a new Claude task, Home's execution location defaults to **Local**. Choose **Cloud**, explicitly select its Workspace, review the repository/branch and automatic Bundle transfer notice, then Start. Continue through the Task's **`公式Cloudで続ける`** link; launcher exit does not mean Cloud completion. Local options, attachments and shadow runs are not forwarded. See [Cloud usage and transfer contract (Claude Code on the web)](docs/design/claude-cloud.md) for setup, Private access, transfer scope and validation limits.

Cloud runs on the official cloud infrastructure. `--remote-control` lets another device operate a locally running session. To continue an existing Cloud Task locally, select **`ローカルで続ける`** in its detail, then answer the official CLI prompts in Switchboard's Terminal and saved cwd. Use the same subscription account/repository and a pushed Cloud work branch; protect dirty/untracked files yourself. After Terminal ends and the Local history is confirmed, open the linked **Local Task** and reply to use ordinary `--resume`. The original Cloud Task remains available, and later Local conversation is not automatically synced to Cloud. Opening/reloading Terminal does not start Teleport. To check the flow with your own account, follow "How to verify with a real account" in the [Validation scope](docs/design/claude-cloud.md#validation-scope) section of the Cloud document.

Runners are detected on `PATH`. Install them with the vendors' official installers:

- Claude Code — https://claude.com/claude-code
- Codex CLI — `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (https://developers.openai.com/codex/cli). Required for development (typecheck, CI): the Codex protocol types are generated from the installed Codex; no login is needed.
- Optional: DAK — off by default; see `docs/design/dak-adapter.md` → Enabling.

## Try it on one repository

The shortest path from a clone to a Ready PBI, on one repository of your own, without a GitHub Project:

1. Clone the public repository and `cd` into it.
2. `./scripts/setup.sh`.
3. `bun run dev`, then open `http://localhost:5173`.
4. Open Settings. In the Workspace card under `追加`, choose `ホストにあるディレクトリを追加`, enter the path of your repository, tick `GitHub と連携しない` and press `追加`. Issues and the Project are kept inside Switchboard, so you need no GitHub Project and no repository variables.
5. Open Backlog and pick your repository's tab, press `要望を登録` (its `登録先` must name your repository; on the `すべて` tab it starts on Switchboard itself), write the request and press `登録`. A Task on your runner files the request, writes the PBI and its Tasks, and the PBI shows up under Ready.
6. If that Task stops on the way, the row waits in its stage and its button starts the stage again: `PBI にする` on a request under `要望のまま`, `Task に分解` on a PBI under `分解待ち`. Each one also runs on to Ready.

Your repository needs no `ops.config.json`; without one the choices come from the kit's template `ops-kit/template/ops.config.json`. Install a runner and log in to it first (the list below). A runner that is not logged in gets a banner at the top of every screen with its login button (`Claude アカウントでログイン`, `ログインする`).

## Use the Project and PR flow

The next step after the one above: to run the same flow on GitHub's Issues, Project, PRs, reviews and Releases, follow [the fork setup](docs/development.md). Before `bun ops-kit/src/cli.ts bootstrap`, set `fields.area` in `ops.config.json` to your own values: the values in this repository are Switchboard's own packages, and `bootstrap` would copy them into your Project.

Optional, instead of or beside GitHub: a self-managed GitLab Community Edition. Compare installing it, running it beside GitHub, moving to it and recovering it in [`docs/design/gitlab-adoption.md`](docs/design/gitlab-adoption.md) before starting anything; each step that starts, costs, exposes, logs in or moves waits for your OK.

## Develop

To change Switchboard, fork it and develop on your fork: [Fork and develop](docs/development.md).

```bash
bun test                  # recorded-replay tests for adapters + daemon lifecycle tests
bun run typecheck
bun run licenses:check    # every dependency's license against scripts/licenses.allow.json
bun run codex:types       # typecheck runs it: generate the Codex protocol types from the installed Codex
bun run core              # daemon only, with --watch
bun run web               # UI only
```

The replay tests read recordings kept outside Git (`~/.switchboard/fixtures` or `SWITCHBOARD_FIXTURES`; record your own with `.claude/skills/runner-adapter-recording/SKILL.md`); without them those tests skip with a reason, so a green CI on the public copy does not show that replaying real runner output was tested.

Development follows a PBI → Task flow without sprints; the steps are the shared skills under `ops-kit/skills/` (copied into each repository, this one included, when a task's runner starts — `docs/design/skill-sync.md`; this repository's own three stay in `.claude/skills/`) (`request-to-backlog` → `pbi-to-tasks` → `task-to-pr` → `cross-runner-review` → `review-triage-and-merge`, or `/pbi-complete <PBI>` for the whole run; rules in `issue-workflow`). This repository's own values (tests, worktrees, the Project) are in `CLAUDE.md`. The backlog tools are `ops-kit/` (`bun ops-kit/src/cli.ts --help`), shared with other repositories; `scripts/setup/*.sh` are thin entries that run it with this repository's `ops.config.json`. To start a new repository, see `docs/design/new-repo.md` (what it needs and when it is ready to start).

Data lives in `~/.switchboard/` (override with `SWITCHBOARD_HOME` — the UI footer shows the directory actually in use, and the daemon warns at boot and in the UI when it is under a temp folder, because a later start without the same `SWITCHBOARD_HOME` shows none of what was recorded there; tasks a previous daemon left running or waiting are closed as aborted at boot, with a note, and can be resumed by replying): the sqlite index/ledger, `token` (local API token, only enforced off-loopback), optional `routing.yaml` / `mcp.yaml` / `pricing.json` overrides (runner routing is a rule table; which Workspace a request goes to, when none is picked, is one LLM turn recorded in `tasks.workspace_reason`) (the price table is data; Codex usage is priced from it, subscription runners show `実課金` 0; price rows entered on the settings screen sit over it and take effect without a restart), and `attachments/` — files attached to turns, one folder per task, never inside a repository, and `artifacts/` — copies of the reports registered on the Task screen (`docs/design/artifacts.md`). Knowledge (rules, commands, notes) is a Markdown folder at `~/Knowledge` (`SWITCHBOARD_KNOWLEDGE`). Runner sessions stay where the runner keeps them (`~/.claude/projects/...`), so `--resume` works. The daemon also reads that folder (`SWITCHBOARD_CLAUDE_PROJECTS`; every `SWITCHBOARD_HISTORY_POLL_MS`, default 30 s, and on `今すぐ取り込む`) and imports Claude Code sessions run in a terminal under a registered workspace as tasks with `origin: terminal`, so terminal history shows in the same list, transcript and ledger.

## Limits and data

What you decide, and what stays with you:

- **Approval modes.** You select the permission mode per task, and can change it while the task runs. Auto delegates risk decisions to the runner (Claude's classifier, Codex's auto-review), so approved operations can run without a human prompt; manual modes surface approval requests in the UI. Unconditional full access is never the default ([`docs/design/permission-modes.md`](docs/design/permission-modes.md)).
- **No keys, no telemetry.** Switchboard holds no provider keys or runner credentials and sends no telemetry.
- **Amazon Bedrock.** When you choose Amazon Bedrock for Claude, Switchboard still holds no keys: the `claude` CLI reads AWS credentials the usual AWS way ([`docs/design/bedrock.md`](docs/design/bedrock.md)).
- **Your own login, used only by you.** Claude Code runs as the unmodified `claude` you installed and signed in to yourself, as a child process on your own machine, for you alone. If you provide it to other people, use an API key instead of your subscription login. Read the vendor's terms for your case, for Claude see Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page.
- **What is sent to external providers.** Some features send text from a task to a runner that can be a different provider than the task's own (the end-of-turn judgement, the rubric evaluation, the Workspace choice, the runner suggestion). What is sent and how to keep it with one provider are listed in [`SECURITY.md`](SECURITY.md).

## Design rules

- **System ENABLES, Agent DECIDES, User APPROVES.** Users select the permission mode. Auto delegates risk decisions to the runner (Claude's classifier, Codex's auto-review); approved operations can run without a human prompt. Manual modes surface approval requests in the UI. Unconditional full access is never the default. Modes are selectable per task and changeable while it runs (`docs/design/permission-modes.md`).
- **Runners are optional plugins.** The daemon boots with any subset. No runner code or protocol types are vendored.
- **Text stays text.** Knowledge is Markdown in a git repo you own; sqlite is its index, the ledger, and the source of truth for the backlog (Issues and Projects; GitHub is kept in sync with it) — never committed to a source repository. Materialized to user-level files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.claude/commands/`), never into a repository.
- **No keys, no telemetry. Your own login, on your own machine.** Switchboard holds no provider keys or runner credentials; when you choose Amazon Bedrock for Claude, it still holds none: the `claude` CLI reads AWS credentials the usual AWS way (`docs/design/bedrock.md`). Claude Code runs as the unmodified `claude` you installed and signed in to yourself, as a child process on your own machine, for you alone. Do not use Switchboard to serve other people through your Claude subscription; for that, use an API key (Anthropic's Legal and compliance page: https://code.claude.com/docs/en/legal-and-compliance). What leaves the machine, and how to keep it closed: [`docs/design/network-egress.md`](docs/design/network-egress.md).
- **Low floor, high ceiling, wide walls.** Every backlog item that changes how the web UI looks or is operated names where the change goes: the floor (asking for work in the fewest steps), the ceiling (tuning how it runs, in Settings or folded sections) or the walls (other screens and routes). Values not touched on every request stay off the floor; safety confirmations are never folded; features are moved, not removed (`docs/design/ui-layers.md`).
- **Values that depend on the environment adapt to it.** A value whose right setting depends on the host or on how it is used (sizes, counts, periods, intervals, limits) is derived from the environment (for example, a share of the disk) or has a default that can be overridden without a code change. Values that only need deciding once (formats, policies, which path to take) are decided, not made settings. Overridable values keep a safe default; the rules above still hold.

## License

Apache-2.0 (see `LICENSE`); third-party material and its notices are in [`NOTICE`](NOTICE). Security reports: [`SECURITY.md`](SECURITY.md).
