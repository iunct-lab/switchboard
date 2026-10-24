# Artifacts: reports registered on the Task screen (#1777)

A report a Task made (an HTML page, an image, a text file; often untracked by git or under a temp directory) can be
registered from the Task screen's 成果物 tab and opened later by switching tabs. The daemon keeps a copy, so the report
opens after the working copy or the temp directory is cleaned up.

## Why not attachments

Attachments (`docs/design/attachments.md`) are part of the conversation: they cannot be removed or taken again, they are
single files, and HTML / SVG / XML are downloaded, never shown. Artifacts are removed, refreshed and may be folders, so
they have their own table (`artifacts`) and folder. The header tabs are not touched (#1776): 成果物 is one more tab inside
the Task (会話 / 差分 / 成果物 / ターミナル).

## Where things live

- `~/.switchboard/artifacts/<taskId>/<artifactId>/` — the copy. A file: `<name>`; a folder: its contents as they were
  (symlinks are not copied). The row holds `kind` (`file` / `dir` / `url`), `source` (the path as registered, or the URL),
  `entry` (the page to open; a folder's is `index.html`, else its only top-level `.html`, else 400 naming the candidates),
  `mime`, `size`, `removedAt`.
- Register copies into a temp folder next to the target and renames it into place, so a refusal or a crash never leaves
  half a copy. A replacement sets the old copy aside as `<artifactId>.old`; boot puts it back if the new one never arrived
  and deletes unfinished `.tmp-*` folders.
- The same `source` registered again replaces the copy of the one artifact (not a second row).
- Nothing watches the original. 取り直す (`refresh`) copies it again; if the original is gone it answers 410 and the previous
  copy stays. A URL is never copied (the screen says links can break).
- Remove sets `removedAt` (undo for 24 h: `restore`); boot deletes the copy and the row of one removed a day ago.

## What can be registered, and the limits

Only a path that, after `realpath`, is inside the task's cwd / scope, `os.tmpdir()` or the task's private temp directory,
and is not the daemon's token file or the artifacts store itself. Outside, `..`, and a symlink that leaves the area are 403.
A relative path is read from the task's working directory. Limits (constants in `packages/core/src/artifacts.ts`): 20 MB per
file, 50 MB and 1000 files per folder; over is 413 and nothing is kept.

## API

| Method and path | Does |
|---|---|
| `GET /api/tasks/:id/artifacts` | the task's artifacts not removed |
| `POST /api/tasks/:id/artifacts` `{source, title?}` | register (201) |
| `DELETE /api/artifacts/:id` | remove (undoable) |
| `POST /api/artifacts/:id/restore` | undo a removal |
| `POST /api/artifacts/:id/refresh` | copy the original again (410 if gone, 400 for a URL) |
| `POST /api/artifacts/:id/view` | `{url: "/artifacts/<key>/<entry>"}` (400 for a URL) |
| `GET /artifacts/:key/*` | the copy's files, outside `/api` (below) |
| `GET /api/reports?limit=` | every task's HTML artifacts, newest first (Across Tasks, below) |

## How it opens (`viewOf` in `apps/web/src/artifacts.ts`)

| Type | Opens as |
|---|---|
| `text/html`, XHTML, SVG | a frame: `<iframe sandbox="allow-scripts">`, scripts run |
| `image/*` | `<img>` |
| `text/*`, JSON, YAML, XML (Markdown is not rendered) | text, fetched and shown in `<pre>` |
| a URL, PDF, anything else | a new browser tab (a URL) / a new tab and a download link |

A frame, an image or text also has 全画面 (#1826): the same content over the whole screen (`position: fixed`, same
`sandbox`), with a bar on top — ← 戻る, the title, 新しいタブ. Three ways back to the Task screen: 戻る, Esc (while the focus is not inside the report — its keys stay in its opaque frame), and the
browser's / phone's back (opening pushes a history entry; a link inside the report adds its own, so back first moves
inside the report).

## Safety: a page that runs has no rights on the UI's origin

The daemon's UI origin can call the whole local API (loopback asks no token), so a report must not run as that origin.

- A report is served from `GET /artifacts/<key>/…` with `content-security-policy: sandbox allow-scripts; frame-ancestors 'self'`
  — no `allow-same-origin`, so the document's origin is opaque: no cookie, no `localStorage`, no reading the parent. The
  `<iframe>` carries the same `sandbox`. Also `nosniff`, `referrer-policy: no-referrer`, `content-disposition: inline`, UTF-8 for text.
- The route is outside `/api` because `/api` never takes a token in a URL. Its credential is the key
  `<artifactId>.<expiresMs>.<HMAC-SHA256>`: issued by `POST /api/artifacts/:id/view` (so only a caller `/api` lets in),
  valid one hour, the secret made at each daemon start and kept in memory. A forged key is 403, an expired one 410; a key opens
  its own artifact only, and a removed artifact is 404. The Host check (DNS rebinding) and the CDN header still apply; refusals
  count toward the failure limit; the access log writes `/artifacts/<key>` for the key.
- Files are confined to the artifact's folder: the path is decoded once and then `..` (also as `%2e%2e`), a backslash, NUL, an absolute path and a symlink out are 404; an encoded `/` is just a `/` inside the folder.
- A script inside the page that calls `/api` or `/ws` sends `Origin: null`; `sameOrigin` (`auth.ts`) refuses it (403).

## Across Tasks: reports (#1835)

In this section a report is narrower than at the top of this file: an HTML artifact of any Task — `kind` file or dir,
`mime` `text/html` (or XHTML), not removed (an image or a text file stays on its Task's tab). No flag, column or table marks one. `GET /api/reports?limit=` lists them newest first by `updated_at` (a report taken again rises); `limit`
is an integer 1..100, default 20 when absent, and a blank or non-digit value is 400. Each row is the `Artifact` plus
`taskTitle` and `scheduleTitle` (the schedule's title when one started the Task, else null), so a screen can say who made it.

Where they show:

- **Insights** — the header tab that was Evals until #1835 (the view's name stays `evals`; `docs/design/evals.md`): a
  レポート section above the per-task evaluations (`apps/web/src/components/Reports.tsx`). A row is the title ·
  `MM/DD HH:MM · <the schedule's or the Task's title>` · Task を開く · ×. The newest report (or the one Home was pressed on)
  is open on arrival and a row switches to another, in place, with the same sandboxed body as the Task's 成果物 tab
  (`ArtifactBody`, exported from `Artifacts.tsx`); × removes through `DELETE /api/artifacts/:id`
  with the same 元に戻す; Task を開く opens that Task on its 成果物 tab with that report selected (`View`
  `{ name: "task", artifact }`). With no report the section is one hint line — no list, no table.
- **Home** — one row under 今日のコスト: the newest report (`GET /api/reports?limit=1`, read once per visit), opening
  Insights with it (`View` `{ name: "evals", report }`). No report, no row and no heading.

Retention is the artifact's own (removed = 24 h of undo, then swept); nothing is kept per report.

### The daemon's own copy (`addCopy`, #1838)

`ArtifactStore.addCopy(task, path, title)` registers a file the daemon itself knows the path of — the insights schedule's
`report.html` under Claude Code's `usage-data`, outside every task's scope (`docs/design/scheduler.md`, insights). It skips
the scope check only; the deny list (the token, the database), the store itself and the size limits apply as for `add`, and
the same path registered again for the same task replaces that artifact's copy. Nothing else calls it: a Task's agent and
the screen go through `add` and its scope.

## The agent's own registration (#1778)

A runner registers a report it made by writing one fence in its reply — the same for Claude, Codex and DAK, with no tool
or MCP endpoint:

````
```switchboard-artifact
{"path":"<a file or a folder: absolute, or relative to the task's working directory>","title":"<optional>"}
```
````

- Every start's preamble carries one paragraph saying so (`artifactPrompt()` in `packages/core/src/artifacts.ts`, after the
  stop report's paragraph of `stopRecoveryPrompt`); the insights Task (`docs/design/scheduler.md`) gets no preamble at all.
- The daemon reads the fence as it reads `switchboard-stop` (`FenceReader<T>` in `stops.ts`, one reader per kind on the
  live session): only a fence opened at the start of a line and outside any other fence — a quoted example in a code
  block is not a registration. A fence whose body is not JSON of `ArtifactReport` (`path` 1..4096, `title` up to 200)
  leaves one status line `成果物を登録できませんでした（フェンスが読めません: <why>）`; text that is not such a fence is not read at all. A fence
  whose closing line is the reply's last, with no newline after it, is closed by what ends the reply (a tool call, an
  ask, the session's end) and read before that is recorded, so its row still comes before the tool row or 完了 (#1936).
  The next message, the person's or the runner's, closes it too, but after that message is recorded (the person's files
  come right before their message), so there the row follows that message.
- A read fence goes through `ArtifactStore.add` like a path typed on the 成果物 tab: the same scope (the task's cwd / scope and
  temp directories), the same limits, and the same path registered again replaces that artifact's copy (same id, the newer
  content). A registration is recorded as the daemon-only event `artifact.saved {id, title}`; a refusal (outside the scope,
  too big, missing) as one status line `成果物を登録できませんでした（<reason>）` — never a stop.
- The conversation shows `artifact.saved` as a row `成果物: <title>　開く` after the reply that carried the fence (the reply
  stays one bubble when it goes on after the fence: the fold continues it past the row), and the tab's count is read again
  for each such row, so the label keeps up without a press; 開く switches to the 成果物 tab with that artifact
  selected (`TaskView`'s `openArtifact`, the same way Insights' report list opens one): the tab reads its list again first,
  so a registration made after the tab was opened is there, and every press selects it again (a sequence next to the id),
  so the row works a second time after another artifact was picked on the tab; a row whose artifact was removed since says
  `その成果物は消されています` until the next choice on the tab (a tab of the strip, 開く, 追加, ×, 元に戻す). 会話をコピー writes the row as one line `- 成果物: <title>`, like a tool row. No approval is
  asked: a copy is made and the person looks at it.

## Not done, by decision

Watching the original, embedding a URL, DAK's own `artifact(file)` events (still attachments), reading old formats, a list of
non-HTML artifacts across Tasks (reports are HTML), a Workspace MCP tool for the registration (the fence reaches every runner).

## Verified

- Tests: `packages/core/src/artifacts.test.ts` (register / copy / refresh / folder entry / scope / limits / undo / sweep /
  cut-off replacement / serving / key / confinement / `Origin: null`; `reports across tasks (#1835)`: HTML only, newest first,
  removed until restored, `limit` 0 / 101 / 1.5 / abc / blank / 1e1 → 400, the schedule's title), `apps/web/src/artifacts.test.ts`,
  `apps/web/src/reports.test.ts` (`reportMeta`),
  `packages/core/src/devproxy.test.ts` (`/artifacts` through the dev proxy).
- 2026-10-18, fake-runner daemon + headless Chrome: header tabs stay 8; the 成果物 tab registers a folder by a relative path
  and shows its page and its `img/a.png` (`naturalWidth` 1); from inside the frame `document.cookie` and `localStorage` throw
  `SecurityError` and `fetch('/api/tasks')` fails; image and text open; × then 元に戻す restores; 取り直す shows the new text and,
  once the original is deleted, says why and keeps the old text. A registered folder was then deleted from disk, the page
  reloaded, and the report and its image still opened.
- 2026-10-18 (#1835, PR #1846), fake-runner daemon + headless Chromium: 8 header tabs with Insights the fifth (after Home, Task, Knowledge, Ledger); with no report the
  one hint line; two reports newest first in a frame with `sandbox="allow-scripts"`; Task を開く → 成果物（2）with that report
  selected; Home's row → Insights with it open; × → the Task's own list drops to 0 → 元に戻す → 1.
- 2026-10-18 (#1826), the real report `evals-trend-report.html` (about 100 KB, made by another Task) at 390×844 (phone)
  and 1280×900: 全画面 fills the screen below the bar (iframe 390×788 / 1280×856; the points at the centre and the middle of
  each edge are the frame), its table of contents jumps inside the report, and 戻る / Esc / `history.back()` each return to the
  成果物 tab without leaving the app page (the URL stays `/`; the report itself loads again). The inline frame no longer runs under the reply box.
- 2026-10-18 (#1786, PR #1932), fake-runner daemon + headless Chromium: a reply streamed in three deltas (the fence closes
  in the second, the third goes on) is one bubble ending with the third's text, with the row `成果物: 週報　開く` after it; 開く → 成果物（1）with 週報 selected in a frame with `sandbox="allow-scripts"`; a follow-up whose reply
  registers a second file while the tab stays mounted adds the row `成果物: 傾向　開く` and the label reads 成果物（2）before
  anything is pressed, and the row's 開く → 傾向 selected; the first row pressed again → 週報 selected again; 傾向 removed through the API, then its row → `その成果物は消されています`
  with 週報 still selected, and the live row pressed next clears the message; the same after a page reload with the removed
  row pressed before the tab was ever opened (the message, 週報 selected, then cleared); × on 週報, its row (the message),
  元に戻す → the message goes with the restore, and so does a press on a tab of the strip; the row's button is named
  `週報 を開く`; no console errors.
- 2026-10-18 (#1936), fake-runner daemon + headless Chromium: a reply streamed in two deltas whose last line is the fence's
  closing line, with no newline after it, records `artifact.saved` before `session.end`; the conversation shows the reply,
  the row `成果物: 週報　開く`, then 完了; no console errors. `core.test.ts` pins the same order for a tool call and for a
  `switchboard-stop` fence.
- Not verified: the 利用者確認 row of #1777 (use on the running Switchboard).
