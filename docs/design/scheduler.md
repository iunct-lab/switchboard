# Scheduler — recurring tasks and the morning queue

Issue #20, proposal §6 Phase 2 ("スケジューラ: 定期実行・通知・承認キュー"). Nightly/periodic tasks (DAK's `nightly-eval` and similar) start from Switchboard on a cron schedule; the results and anything waiting for a person land in one queue view, meant to be triaged in the morning rather than watched live.

## Model

A **schedule** (`packages/protocol` `Schedule`) is: a cron expression, a workspace, a runner, a prompt, and an optional budget. Firing a schedule does nothing special — it calls the same `TaskManager.create()` a manual task uses, so the fired task gets the same approvals, ledger rows, routing log entry (`kind: "maintenance"`), and budget behavior as anything typed into Home. The task carries `scheduleId` so it can be traced back.

## Cron (`packages/core/src/cron.ts`)

Standard 5-field cron (`minute hour day-of-month month day-of-week`), evaluated in the **daemon's local time**. Supports `*`, lists (`1,15`), ranges (`9-17`), steps (`*/15`, `9-17/2`), month/weekday names (`mon`, `jan`), and the `@hourly @daily @midnight @weekly @monthly @nightly` aliases. When both day-of-month and day-of-week are restricted they combine with OR, matching Vixie cron (`0 0 15 * 0` fires on the 15th of the month **and** every Sunday). No external cron library or system crontab is used — this is intentionally small and dependency-free.

**DST spring-forward**: a schedule whose hour/minute falls inside a local spring-forward gap (e.g. `30 2 * * *` on the day clocks jump 02:00 → 03:00) does not fire that day — `nextRun` walks forward hour by hour, never finds the missing wall-clock hour, and moves on to the next day that matches, with no error or log entry for the skipped day. This is considered acceptable (a once-a-year, one-day miss for schedules landing in the gap) rather than a bug to fix; `cron.test.ts` pins the exact behavior (bounded, correct next day — not a hang or a wrong match) so it can't regress silently. Autumn fall-back (a repeated hour) is not specially handled either; the walk simply matches the first occurrence of that wall-clock time, same as any other day.

## Firing (`packages/core/src/scheduler.ts`)

- A 30 s ticker (`Scheduler.start()`) calls `tick()`, which starts every enabled schedule whose `nextRunAt` has passed.
- **No overlap**: if a schedule's previous task (`lastTaskId`) is still `running` or `waiting`, a due firing is skipped and logged (`recentLog()`); `nextRunAt` still advances so a stuck task cannot wedge the schedule forever, but it also does not silently pile up work.
- A firing failure (bad workspace, adapter missing) is logged and `nextRunAt` still advances, rather than retrying forever.
- `runNow(id, "manual")` bypasses nothing about the overlap check — a manual "今すぐ実行" click while a run is active also refuses (409), so the guarantee (one active task per schedule) holds regardless of who triggers it.

## API

```
GET    /api/schedules            list
POST   /api/schedules            create ({title, cron, workspaceId, runner, prompt, budgetUsd?, action?}); action "backlog-next" (#267) ignores prompt, needs the meta workspace, and starts the next backlog item's stage Task (docs/design/backlog.md 定期実行); action "insights" (#1838) ignores prompt, needs the meta workspace and runner claude (else 400), and starts the /insights Task below
GET    /api/schedules/:id       a secret-scan schedule carries `lastResult` (#1274): `{ at, repos, hits, failed, lines }` of its last firing (`repos` = repositories identified, `failed` = scans that failed plus workspaces not identified), kept in the database (a restart does not lose it); null on the other actions and before the first firing
PATCH  /api/schedules/:id        partial update (recomputes nextRunAt if cron changes)
DELETE /api/schedules/:id
POST   /api/schedules/:id/run    fire now (409 if the previous run is still active); a "secret-scan" schedule (#775) answers 202 {scanning: true} at once — it reads every repository for minutes and starts no Task, its lines go to the log
GET    /api/schedules/log        last ~50 scheduler log lines
GET    /api/queue                the morning view (see below)
```

### secret-scan's last result (#1274)

A secret-scan firing starts no Task, so until #1274 its only traces were the in-memory log (gone with a restart) and the inbox note, which only comes with hits or an unreadable repository — a clean day left nothing to tell "0 hits" from "did not run". `runSecretScan` now writes the firing's result to the schedule row (`schedules.last_result`, JSON of `ScheduleResult`): when it ended, `repos` = the repositories it identified from the registered workspaces (several checkouts of one repository are one; a repository whose scan then failed is still counted here), `hits`, `failed` = the repositories whose scan failed plus the workspaces whose repository could not be identified, and the log lines (places and kinds only, never a value). `scanAllRepos` itself never throws for those cases — gh logged out or the kit missing show up as `検査できなかった（…）` lines with their counts. Only something outside it (the inbox write, a programming error) reaches the throw path; that firing is kept as `repos: 0, failed: 1` with one line carrying the error's name only (`検査が失敗した（Error。理由は scan_issues.sh を手で走らせて見る）` — a message could quote a value, docs/design/secret-guard.md), and the schedule moves to its next time as any firing does. Only the last firing is kept — no history. The Schedules screen row for it is #1286.

### insights (#1838)

A schedule with `action: "insights"` starts one ordinary Task on claude in the meta workspace whose prompt is Claude Code's
built-in `/insights` and nothing else (`INSIGHTS_PROMPT` in `scheduler.ts`). The usual preamble — the stop report of
`stopRecoveryPrompt`, a resume's recap — is left off this Task (`startSession` reads the schedule's action through
`task.scheduleId`): Claude Code expands a built-in slash command only when it is the whole user message, so `/insights`
written behind any text would just be read as text. Verified 2026-10-18 by hand through print mode with stream-json input,
the way the adapter sends it: the command ran as one turn, wrote the report and answered with its path.

- **runner** is claude (create and PATCH refuse anything else); **prompt** is ignored; the Task's title is
  `Claude Code Insights (YYYY-MM-DD HH:MM)` whatever the schedule's title. The one-active-run rule applies as to a prompt
  schedule (a firing while the last Task runs or waits is skipped / 409).
- **the 7-day window**: a firing is skipped, with a line in the log, while Claude's `seven_day` utilization in `quota`
  is at or above the backlog's `backlogQuotaLimit` (設定「使用量と自動再開」, default 0.8) and its reset is still ahead.
  The report's session summaries are model calls on the subscription, so a hot week is not made hotter. To run it while
  the window is over the threshold, `backlogQuotaLimit` is raised only with the user's approval, for that one request,
  and put back at once. The setting is not to be raised to get past the guard otherwise: it also loosens the backlog's
  hold on starting stage Tasks. A window moves only when a Claude turn reports it, so the first report after such a run
  also counts the work of the session that ran the check.
- **the report**: when the Task's first turn (the one that sent `/insights`) ends `ok`, the daemon copies
  `<claude home>/usage-data/report.html` (`cfg.claudeUsageDataDir`: `CLAUDE_CONFIG_DIR` or `~/.claude`,
  `SWITCHBOARD_CLAUDE_USAGE_DATA` for tests) into the Task's artifacts as `Claude Code Insights <date>` through
  `ArtifactStore.addCopy` — a report written since that turn started only (the Task's creation; not the runner's
  `session.start`, because `/insights` analyses and writes the report before Claude Code reports its session, #1958); an
  older one (another run's) or a missing one is left alone and the reason is a status line on the Task. A follow-up sent
  to the Task later is an ordinary turn and never copies anything. The copied report comes first in `GET /api/reports`
  with the schedule's title, opens in Insights' レポート in the sandboxed frame, and shows on Home
  (`docs/design/artifacts.md`, Across Tasks).
- **what is not in the ledger**: the Task's own turn is (usage as reported), but the per-session summaries `/insights` makes
  are separate calls that stream-json does not report, so they show only in the windows' utilization. One run looks at up to
  200 new sessions, so on a host that makes a few hundred sessions a week, twice a week is the cadence that keeps up.
- the generated page links one Google Fonts stylesheet (Claude Code writes it; the daemon copies the file as is).

## The queue (`GET /api/queue`)

Three lists, meant to be read together over coffee:

- **waiting** — every task currently on `permission.ask`, with the question and how long it has been waiting.
- **staged** — tasks with pending `fs.write` / `fs.patch` changes (issue #11) not yet applied or rejected.
- **scheduled** — tasks started by a schedule in the last 36 hours, with status and cost, so a scheduled run that finished clean needs no attention and one that errored or is still waiting stands out next to it.

The Schedules screen in the web UI shows this queue on top, the list of schedules (enable/disable, 今すぐ実行, 編集, delete) below, and the scheduler log at the bottom. Every schedule row deep-links its `waiting`/`staged`/`scheduled` entries to the task, same as everywhere else in the UI — this screen adds no task-viewing code of its own. 編集 (#1480) opens a form on the row with its current values and sends only the changed fields through `PATCH /api/schedules/:id`, so the id, the nightly-result rows' schedule name and the last secret-scan result survive an edit (delete + create loses them). The kind cannot be changed (it decides the Workspace constraint and whether there is a prompt — recreate instead); backlog-next, secret-scan and insights keep their Workspace on meta, and insights its runner (the form locks the select; PATCH with another runner is refused). An edit takes effect from the next firing; a running Task is not touched.

### Notices in the inbox (#2401)

Every note the daemon leaves in the inbox goes through `Inbox.addNotice` (the user's own "Inbox に保存" drafts go through `add`). It records the schedule that put the note there (`source: { schedule, title }` in the frontmatter), and the previous open notice of the same schedule is closed with `superseded_by`, so a daily check leaves one notice, not one per day. Home shows notices in their own "お知らせ" section, apart from drafts, with no promotion; both can be closed. Closing is `status: closed` + `closed` in the frontmatter (`POST /api/inbox/close`): the file stays in `notes/`, like a promoted note. Later scheduled notes (#2054, #2155) use the same entry point.

## Not covered here

- **Notifications** (proposal's "通知"): the queue is pull, not push. OS notifications land with the Tauri shell (#17); until then, checking `/api/queue` (or the Schedules tab) is the notification.
- Retry/backoff policies beyond "skip if overlapping, log, move on" — a schedule that keeps failing is visible in the log, not auto-disabled.
