# Attachments — files on a turn, handed to the runner as paths

Issue #125 (PBI), #126 core, #127 web, #128 docs. A person can attach screenshots, PDFs, logs — anything up to 20 MB, ten per turn — to the first instruction of a task and to every reply. The runner gets **the absolute path of a file on this machine**, not the bytes; DAK, which cannot see host paths, is #124.

## Why paths and not bytes

Claude Code and Codex are spawned on this machine with the task's `cwd` and their own file tools (Claude's `Read` shows images and PDFs; Codex has `view_image` and shell access). Anything the daemon writes to disk is therefore readable by them once the directory is inside the task's scope. Passing bytes instead — Claude's stream-json `image` content block, Codex's `localImage` / `mention` input items — would mean three adapter-specific paths for the same feature and a second wire format to keep fixtures for. The path route needs **no adapter change**, works the same for every local runner, and is what a person does by hand in a terminal today (drop the file somewhere, tell the agent where). Decided 2026-09-17 (#125 決定ログ).

## Where the files live

```
~/.switchboard/attachments/
  inbox/<attachmentId>/<name>   uploaded, not sent yet (swept after 24 h at boot)
  <taskId>/<name>               sent with a turn of that task (stays with the transcript)
```

Never inside a repository: a checkout must not show attachments in `git status`, and the same file may be sent to a task on any workspace. `<name>` is the browser's file name reduced to its base name (no separators, no control characters, no leading dot, ≤ 200 chars, `file` if nothing is left); a second file of the same name in one task gets `-<last 4 of the id>` before the extension. The mime is the browser's `File.type`, or the extension when that is empty / `application/octet-stream` (a dropped file often has no type), with parameters stripped.

sqlite: `attachments (id, task_id, name, mime, size, path, created_at)`. `task_id` is NULL until a turn sends it. The row is what `GET /api/attachments/:id` serves and what the transcript row refers to; `path` is what the runner was told.

## API

| Route | What |
|---|---|
| `POST /api/attachments` — multipart, one or more `file` fields | Stores each in `inbox/`. `201 Attachment[]`. `413` when a file is over 20 MB or there are more than 10; `400` without a `file` field. The UI checks both limits before uploading so a 25 MB drop never leaves the browser |
| `GET /api/attachments/:id` | The bytes, `content-type` from the row, `content-disposition: inline; filename*=…`, `x-content-type-options: nosniff`, private cache. `410` if the file went missing on disk |
| `DELETE /api/attachments/:id` | Only an upload nobody sent (`409` once it belongs to a task: it is part of a transcript) |
| `POST /api/tasks` with `attachmentIds` | Sends them with the first turn |
| `POST /api/tasks/:id/send` `{ text, attachmentIds }` | With a reply. Text may be empty when there are attachments (the turn then says 「添付ファイルを確認してください。」) |
| `GET /api/tasks/:id` → `attachments` | The task's files in the order they were sent |

Ids are checked as a whole before anything moves (`AttachmentStore.check`): unknown → 404, listed twice → 400, already sent with a task → 409, file gone → 410. A refused creation or reply leaves the uploads in `inbox/`.

## What the runner sees

The turn's text gets this block appended (`attachmentNote`):

```
この画像を見て

添付ファイル（このマシン上のパス。必要なら読んでください）:
- /home/me/.switchboard/attachments/<taskId>/shot.png (image/png, 70.2 KB)
- /home/me/.switchboard/attachments/<taskId>/error.log (text/plain, 12.0 KB)
```

and the task's `scope` gains `~/.switchboard/attachments/<taskId>`:

- Claude: every scope entry other than `cwd` becomes `--add-dir`, so `Read` on the path needs no permission prompt.
- Codex: scope entries are the sandbox's writable roots; reads are not sandboxed anyway.
- Workspace MCP (`fs.read` etc.): `Scope` resolves real paths against the scope list, so a DAK-style runner could read a text attachment through it — binary content is #124.

The transcript shows what the runner was given: the YOU row carries the text with the block, and one `attachment` event per file (recorded by the daemon just before the turn, never by an adapter) is folded into that row by the UI as a thumbnail (images, click for full size) or a download link.

### Scope after the fact

A task created with attachments has the directory in its scope from the start. A task created without gets it on the first reply that carries one (`TaskManager.widenScope`, persisted with `updateTask({ scope })`). A **live** runner only learns its roots when it starts (`--add-dir`), so that reply restarts the process with `--resume` instead of writing into it (`LiveSession.restartNext`, the same flag a permission-mode change that cannot be applied live uses). If the runner is mid-turn the restart cannot happen (`release()` refuses); the text still goes to the old process and the runner will ask for permission to read outside its roots — that ask reaches the UI like any other, and the next turn restarts.

A shadow run (#99) reads the primary's files: the same composed text, the same paths, its scope widened to the primary's directory, the same `attachment` rows in its own transcript. The files are moved once (by the primary); a shadow's `GET /api/tasks/:id` lists no attachments of its own.

## Limits and what is not done

- 20 MB per file, 10 per turn (`MAX_ATTACHMENT_BYTES`, `MAX_ATTACHMENTS_PER_REQUEST` in `packages/core/src/attachments.ts`; the UI mirrors the values). `Bun.serve` takes bodies up to 10 × 20 MB + 1 MB.
- Unsent uploads older than 24 h are removed at boot (`sweep`). Sent files are never removed by the daemon; deleting a task's directory by hand leaves `410` on the row.
- The `attachment` event is not produced by adapters and not imported from terminal sessions (#91); Claude Code's own `attachment` records stay ignored there.
- Not done, by decision: Claude `image` blocks, Codex `localImage` — the path route is enough until a runner says it cannot read a format. DAK (inline bytes in `/run_sse` `parts`, artifacts back) is #124. The WebSocket `task.send` message carries text only; the UI replies over HTTP.
- Reports (HTML pages and the like) that a Task made are not attachments: they are registered from the 成果物 tab and shown in a sandbox, see `docs/design/artifacts.md`.
- Serving: the bytes come back with the row's mime and `nosniff`, `inline`. The UI never renders an attachment as a document — images through `<img>` (via fetch + object URL so the API token goes along off-loopback), everything else as a download — so an uploaded SVG/HTML is not executed on the UI's origin.

## Verified

- `bun test packages/core/src/attachments.test.ts` (10 cases): upload / serve, mime fallback and name sanitising, creation (move, scope, prompt, event order), replies (a second file, name collision, attachment-only text), a live runner restarted with `--resume` so the new root reaches it, the shadow run, limits and refusals, DELETE, reopening the database and the sweep, the prompt block.
- Headless Chrome (CDP) against a worktree daemon with a fake claude that echoes its prompt: paste → chip → 開始 → thumbnail in the YOU row and the echoed path, attachment-only reply, a 21 MB paste refused in the browser, console errors 0 (#130).
- Real runners: see the #125 決定ログ (Task #128).
