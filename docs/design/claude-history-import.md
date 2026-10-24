# Terminal history — importing Claude Code sessions from `~/.claude/projects` (#91)

Verified 2026-09-09 against Claude Code **2.1.263 / 2.1.265** logs. Code: `packages/adapters/claude/src/history.ts`
(record → AgentEvent), `packages/core/src/history.ts` (`HistoryImporter`), UI in `apps/web` (Home card, `Terminal` tag,
Brief の「実行導線」).

## Why

Switchboard records the runners it spawns itself. A `claude` run in a terminal never went through the daemon, so its
transcript, its files and its cost were invisible here — although Claude Code keeps a complete log of every session,
and Switchboard already depends on that log for `--resume`. Reading the same folder puts terminal sessions in the same
task list, transcript, 差分 tab and ledger, with a tag that says where they were started.

## Where the log is

```
~/.claude/projects/<dir>/<sessionId>.jsonl          one JSON record per line, appended while the session runs
~/.claude/projects/<dir>/<sessionId>/subagents/…    subagent transcripts (not read)
```

`<dir>` is the session's cwd with every character outside `[A-Za-z0-9]` replaced by `-`
(`/Volumes/disk_1/x` → `-Volumes-disk-1-x`; `claudeProjectDirName()`). A session started in a subdirectory gets its
own `<dir>`; the importer matches on the `cwd` **inside** the records, not on the folder name, so any session whose cwd
is a registered workspace or under one is picked up (both sides resolved: Claude Code logs the physical path, e.g.
`/private/var/…` for `/var/…`). Override the root with `SWITCHBOARD_CLAUDE_PROJECTS`.

## What a record looks like, and what it becomes

The full table is in `docs/design/claude-stream-json.md` (§ Session log). The short version:

| record | AgentEvent |
|---|---|
| `user` with string content, `promptSource: typed / queued / suggestion_accepted` or `origin.kind: human` | `message.delta(user)` (the first one also `session.start`) |
| `assistant` content blocks (one record per block, same `message.id`) | `message.delta(assistant, messageId)`, `tool.call`; one `usage(turn)` per message id |
| `user` with `tool_result` blocks | `tool.result`; a successful Write / Edit also `artifact(diff)` |
| `[Request interrupted by user…]` | `session.end(aborted)` |
| `stop_reason: end_turn` / `stop_sequence` | `session.end(ok)` once a record of another message follows, or once the file has been quiet 5 s |
| `stop_reason: refusal` | `session.end(error)`; `max_tokens` ends nothing (Claude Code continues the message) |
| `message.model: "<synthetic>"` (a session-limit banner) | `error`, and `session.end(error)` when it stops the turn |
| `ai-title`, `permission-mode`, `message.model`, timestamps | task title, permission mode, model, `createdAt` / `updatedAt`, event `ts` |
| `entrypoint: sdk-cli`, `isMeta`, `isCompactSummary`, `promptSource: system`, thinking, attachments, `cost-state` | nothing |

`entrypoint` is the one field that says who was typing: `cli` is the interactive terminal, `sdk-cli` is a program
driving `claude -p` — Switchboard itself, or another host. Only `cli` records are imported; a host records its own
session live.

## Which files become tasks

For every `<dir>/*.jsonl`, each pass:

1. **Already tied to a task?** `history_imports` remembers session id → task. Otherwise a task with that
   `runnerSessionId` (Switchboard ran the session) claims the file.
2. **A live task's file is left alone.** Our own process is writing it; it is read once the process is released.
3. **Not tied yet:** the first record with a `cwd` decides. No registered workspace at or above that cwd →
   `skippedForeign` (add the workspace and the next pass imports it). Only `sdk-cli` records → `skippedOtherHost`, no task.
4. **Terminal records present and no task:** a new task — `origin: terminal`, `runner: claude`, `status: done`,
   `runnerSessionId` = the file name, title from `ai-title` (else the first prompt's first line), cwd / scope from the
   log, model and permission mode from the log (a mode that skips approvals, `bypassPermissions`, is **not** carried
   over: a reply from here resolves the mode like a new task), `createdAt` / `updatedAt` = first / last record time.
5. Events are appended with the record's own timestamp; each `usage` becomes a ledger row.

A Switchboard task whose session the person later continued in a terminal (`claude --resume <id>`) gets those
terminal turns appended to its transcript; its title, mode and origin do not change, only `updatedAt` moves. The
reverse — replying from Switchboard to a terminal task — goes through the ordinary `--resume` path and is recorded live;
the log's copies of those turns are `sdk-cli` and are not imported again.

## Following a file that is still being written

`history_imports` stores the byte offset read so far and the adapter's serialized parser state (`serializeHistoryState`).
A pass reads only complete lines past the offset (a partial last line waits), feeds them to a parser restored from
that state, and stores the new offset and state. That is what keeps a message whose content blocks straddle two passes
from counting its usage twice, and keeps `session.start` from being announced again after a daemon restart.

A trailing `end_turn` is turned into `session.end(ok)` only after the file has been quiet for 5 s: the blocks of one
message are written together but not atomically, and there is no `result` record in the session log. A pass reads at
most 16 MiB of one file (the rest follows on the next pass); an unchanged file costs a `stat`.

Before a reply is sent to a task from Switchboard (`POST /api/tasks/:id/send`, ws `task.send`), the task's log is read
once more, so a terminal turn that finished inside the poll window lands in the transcript before the reply.

Passes run at boot (deferred to the next tick, so the port answers first) and every `SWITCHBOARD_HISTORY_POLL_MS`
(default 30 s; `0` = boot and `POST /api/history/import` only). A pass is synchronous and cheap: two sessions
of a few thousand records each (about 15 MB) parse in about 50 ms; unchanged files cost a `stat`.

## Cost

Usage is priced per assistant message from `pricing.json` (ledger `source: priced`); Claude is a subscription runner,
so 実課金 is 0 and the figure is API-equivalent. Claude Code's own `cost-state` record (the number `/cost` shows) is
written once at the end of the session, is cumulative, and uses Claude Code's internal rates — it will not match the
table's figure and is not used. Treat the ledger's number for terminal sessions the way the Codex figure is treated: an
estimate from the data price table.

## What the UI shows

- **Rail / Home「最近」/ Ledger「タスク別」**: a `Terminal` tag on the task row.
- **Task view**: the tag next to the status; the reply box explains that replying resumes the session on the
  Switchboard side.
- **Brief**: 「実行導線」 — `Switchboard` or `Terminal で開始（Claude Code のログから取り込み）`, with the log file's
  path and when it was last read.
- **Home「Terminal の履歴」**: how many terminal sessions are imported, the last pass, the interval, how many logs were
  outside every workspace, and 「今すぐ取り込む」.

## API

- `GET /api/history` → `HistoryStatus`: `dir`, `enabled` (the folder exists), `pollMs`, `lastScanAt`, `lastResult`
  (`files / created / appended / skippedForeign / skippedOtherHost / errors`), `sessions[]` (session id, task id,
  origin, path, pathDisplay with `~`, offset, importedAt).
- `POST /api/history/import` → runs a pass now, returns `HistoryScanResult`.
- `GET /api/tasks/:id` → `history: HistorySession | null`.

## Known limits

- **External terminals are not locked.** Switchboard-owned Teleport refuses follow-up/resume of a Local Claude Task in the continuation's worktree (`<repo>/.claude/worktrees/teleport-<Cloud Task id>`, #1395) until Terminal/import ends; Tasks in the clone itself are not refused; new Task creation is not locked. Replying to a session still open in an unrelated external terminal can start a
  second `claude` on the same session id; what Claude Code does then has not been verified. The Brief and the reply
  box say to close the terminal first.
- **Subagents** (`<sessionId>/subagents/*.jsonl`) are not read; their tool calls appear only as the parent's tool rows.
- **Codex** keeps its own sessions under `~/.codex/sessions`; a similar importer is a separate PBI.
- **A file that shrinks** (Claude Code rewrote it) is not re-read from the start — that would duplicate what was
  imported; the pass reports it under `errors` and continues from the new end. The same session id under a second
  project folder is reported and ignored.
- **Large sessions** load their whole transcript into the browser when opened (the same as a long Switchboard task).

## Proven Teleport continuation (#1107)

`sourceCloudTaskId` links a Local Task to the original Cloud Task. The Cloud
reference never becomes `runnerSessionId`. Linkage requires one printed target,
the resumed marker, one canonical Local resume UUID, normal CLI exit and its
exactly named normal log. Every log record must agree with the session and
with the cwd the caller names (the continuation's worktree, #1395), and that
physical cwd must belong to the Cloud Workspace. A Local Task links only from
the Cloud Task's own cwd or that one worktree. Stored paths stay as
written, including symlink aliases. Missing or ambiguous evidence fails closed.

`importTeleportedSession` validates the complete log, yielding between 16 MiB
slices. It rejects a file whose size, modification time or inode changes during
validation/import. It reuses the existing owner and persisted offset/parser
state, or creates the usual Terminal-origin Local Task. Conflicting owners,
other Workspace/cwd and live Local owners are refused. Repeated import and
restart do not duplicate messages or usage. The anonymous `remoteSourced`
fixture uses normal message shapes; SDK-host records remain excluded.

`GET /api/tasks/:id` additionally returns `localContinuations` on Cloud and
`sourceCloudTask` on the imported Local Task. Success, cancellation and
unconfirmed import outcomes are saved as Cloud status events. The Terminal
waits for the asynchronous import result before closing, so reconnecting
clients receive the final confirmation or warning. Normal Local `--resume`
is enabled only after the Teleport/import window ends. This exclusivity covers
Switchboard-owned Teleport, not arbitrary external terminals. No Cloud sync
is performed. Live acceptance of the integrated flow remains pending #1133.
