# Usage-limit auto-resume — continuing a task once the runner's window lifts

Issue #102 (Tasks #103 core, #104 web). A subscription runner stops a turn when its usage window is used up; Claude Code's
5-hour window is the one that bites during long unattended runs. Left alone, the task sits as `error` until someone
notices, and the hours between the reset and that moment are lost. The daemon has everything it needs to go on by
itself — the session id for `--resume`, and the reset time — so it records when the limit lifts and, if the runner's
auto-resume setting is on, sends a follow-up turn then. The setting is per runner and off by default; the person
decides, and can cancel per task.

## What the stop looks like

Recorded with Claude Code 2.1.265 (`claude -p --output-format stream-json`), the sequence in the transcript was:

```
quota        claude  five_hour {utilization: > 1, resetsAt: <epoch s>}  seven_day {…}
message.delta assistant "You've hit your session limit · resets 4:10am (Asia/Tokyo)"      (model "<synthetic>")
usage        reported  (0 tokens)
session.end  error     summary "You've hit your session limit · resets 4:10am (Asia/Tokyo)"
```

`resetsAt` is epoch seconds and equals the banner's time. The `result` line carries the banner as `result` with
`is_error: true`, which the adapter maps to `session.end(error, summary: banner)` (`docs/design/claude-stream-json.md`).
A reply after the reset continues the same session (`--resume`).

A runner refusing to start on an API rate limit is different: a non-zero exit with the 429 body on stderr becomes
`error(message)` + `session.end(error, "runner exited (N)")`. Both shapes are covered below.

## Recognising it (`packages/core/src/ratelimit.ts`)

`TaskManager.onTurnEnd` listeners receive, with the task, the turn's `session.end` and the `error` messages raised
during it (`TurnEnd`). A turn ended on the limit when its status is `error` and any of those texts matches the runner's
limit wording:

| runner | matched on | status |
|---|---|---|
| claude | `hit your (session\|usage\|weekly\|daily) limit`, `\busage limit`, `\brate[ _-]?limit` (the API's `rate_limit_error` too), `too many requests` | verified against the recording above |
| codex | `\brate[ _-]?limit`, `\busage limit`, `too many requests`, `credits depleted / exhausted` | **unverified** — no recording of a Codex limit stop yet; the app-server reports `turn/completed` with `turn.error.message`, and `account/rateLimits/updated` carries `rateLimitReachedType` (`packages/adapters/codex/src/generated/v2/RateLimitSnapshot.ts`) which the adapter does not yet surface |
| dak | never | no subscription window |

The patterns are anchored on purpose: a bare `429` or `limit reached` would also match a stack trace line (`cli.js:429:17`),
`Reached max turns (429)`, `Context limit reached`, `Bash tool output limit reached` — and the stderr tail of every
non-zero exit is among the texts. An ordinary error ("Cannot read properties…", a crash) is not a stop and leaves the
task alone.

## When it lifts

In order, the first that gives a time:

1. **The quota report** — the turn's own last `quota` event (the runner's view at the moment it stopped); the `quota`
   table (last report per runner and window, from any task) only when the turn had none. A window at ≥ 100 % is used
   up. The window the runner names as binding (`quota.limitType`, from Claude's `rate_limit_info.rateLimitType`) wins
   when it is used up; otherwise the **earliest** used-up window — waiting for a later one would idle through the
   earlier reset, and a second stop simply plans again for free. Seconds or milliseconds are both accepted.
2. **The banner** — `resets 4:10am (Asia/Tokyo)` (verified), and read best-effort: `resets at 16:10`, `resets 4pm
   (America/New_York)`, `resets in 3 hours`, `resets Sep 15 at 4am`, `resets Tue 4am`. A wall clock is the next time
   it comes round in the named zone (DST-aware through `Intl`); no zone, or an unknown one, means the daemon's own.
3. **Neither** — a fallback delay: 15 minutes for the first stop, doubling with each consecutive stop up to 4 hours
   (settings `retryDelayMs` / `retryMaxDelayMs`, below; defaults `FALLBACK_DELAY_MS`, `MAX_FALLBACK_DELAY_MS`). A refused turn costs nothing (the banner turn reports zero usage),
   so guessing is cheap.

**Lifted late.** A reset that passed less than 6 hours ago (`PAST_GRACE_MS`) — the runner still refused at 04:11
although it said 04:10 — is not read as tomorrow's 04:10: the plan is `now + 5 min` (`LATE_RETRY_MS`) and the note says
so. Otherwise `resumeAt = reset + 60 s` (the banner has minute resolution). The plan is stored on the task
(`tasks.resume_at`, `Task.resumeAt`) and noted in the transcript as a `status` line saying what stopped it, when it goes
on, and where the time came from.

## Resuming (`RateLimitResumer`)

A 30 s ticker (same shape as the scheduler's), not a timer per task: `resume_at` is a column, so a daemon restart or a
setting switched on later picks the waiting tasks up on the next tick with nothing to rebuild. Each tick sends, to
every task whose `resumeAt` has passed and whose runner has `autoResume` on, a follow-up (the text after the head is
the setting `resumePrompt`, below; this is its default):

```
[Switchboard 自動再開] 使用上限がリセットされました。中断した箇所から作業を続けてください。
```

through `TaskManager.send()` — the same path as a reply from the person: the idle process takes it if it is still
alive, otherwise the runner restarts with `--resume`. The transcript therefore shows a user turn in the daemon's
words, so it is clear who resumed and why.

- **Any turn clears the plan** — a reply from the person, the resumer's own, `resumeNow`. 中断 clears it too. A
  person's reply clears it *before* waiting for a release in progress; the resumer's own send (`asResume`) re-checks
  after that wait and sends nothing (`ResumeSupersededError`) when the plan is gone or the task is running — so a reply
  that lands while the ticker is mid-flight wins, and one session never gets both.
- **Stopped again**: the new stop is recorded and planned afresh (the 7-day window after the 5-hour one, or a reset
  that lifted late). The daemon counts stops of turns *it* resumed; after 8 in a row (setting `maxLimitStops`, default
  `MAX_CONSECUTIVE_STOPS`; the 9th stop, in memory) it gives up with a note, so a misread time cannot loop. Any turn the person sends starts the count
  over — their reply is a decision to go on, so a reply that stops again is planned again as the note promises.
- **Cannot resume**: no `runnerSessionId` (nothing to `--resume`) or budget exceeded — noted, plan dropped; the
  person's reply still works as before. A passing failure (`send()` throwing: the process exited under us, a spawn
  error) keeps the plan and retries in 5 minutes, bounded by the same cap.
- **Setting off**: the plan is recorded and shown (the tag, the Brief), nothing is sent. Switching it on later resumes
  the already-waiting tasks on the next tick; switching it off leaves their plans in place.
- Only tasks the daemon itself ran a turn for go through this: terminal sessions imported from `~/.claude/projects`
  (#91) that were never continued from Switchboard have no turn end here, so a person's own terminal session is never
  advanced behind their back.

## A turn the daemon's own stop cut (`packages/core/src/interrupted.ts`)

The same plan column continues a turn that ended because the daemon went away, not the runner's window. On the
cloud host, when the OS shut down mid-turn (not the idle stop), systemd signalled the whole
unit at once, the runner died first (`session.end(error, "error_during_execution")`), and after the start the task sat
as `error` until a person wrote to it.

- **Where it is planned.** `TaskManager.shutdown()` (SIGTERM / SIGINT, a promotion, a forced restart) notes each task
  whose turn is in flight (`status` beginning 「デーモンの停止でターンが中断されました」) and sets `resumeAt = now`
  before aborting it. A finished task (`done` / `error`) whose runner still has background jobs (`background` count above
  0, `docs/design/claude-stream-json.md`) is planned the same way: closing the process ends the jobs and the turn their
  notification would have started. A task that already waits for a limit's reset keeps that plan. A daemon that never ran its shutdown (killed, the machine lost) leaves the task running;
  `abortOrphanedTasks()` at the next start closes it as before and plans it the same way.
- **The unit.** `switchboard.service` has an `ExecStop` that signals sb-rescue alone and waits for it to exit: it
  stops the daemon, which aborts its runners — so the daemon sees the turn in flight. Only then does systemd signal
  the rest of the cgroup (SIGTERM, as before: `KillMode=mixed` would SIGKILL the rootless dockerd that `docker`
  starts from inside the unit).
- **Sending.** The resumer's tick is unchanged (auto-resume on, `resumeAt` passed, not running); nothing is due so the
  first tick after the start sends it. The prompt says what happened: when the latest stop note since the person last
  wrote is a daemon stop, `[Switchboard 自動再開] デーモン（ホスト）の停止でターンが中断されました。…` (commands that were
  running are gone; check the state first), otherwise the usage-limit prompt above.
- **Bounds.** No runner session → no plan. After `maxStopResumes` (setting, default 2 = `MAX_STOP_RESUMES`) cuts in a row — counted back through the
  transcript, so it survives the restarts it is about; a turn that ended ok or the person's own message starts it over
  — the note says 自動再開しません: a task whose own work takes the host down must not loop. A shutdown that planned
  the turn and was then SIGKILLed mid-abort (sb-rescue waits 10 s) leaves it running; the next start sees the plan
  already there and does not count the stop again.
- **「今すぐ再開」** on such a task sends the stop's prompt too.
- **Open.** With auto-resume off the plan only waits, and the UI (再開待ち tag, the Brief's 「使用上限」 block) still
  words it as a usage limit. Ctrl-C on a local daemon (SIGINT) plans like any stop. A 中断 whose abort is still in
  flight when the daemon is killed leaves the task running, and the next start plans it.

## Settings and API

```
PATCH  /api/settings   { autoResume: { claude: true } }      per runner; false / null clears; must be installed
GET    /api/settings   → { …, autoResume: { claude: true }, runners: [{ id, autoResume, … }] }
GET    /api/health     → runners[].autoResume (effective value)
POST   /api/tasks/:id/resume    send the follow-up now (regardless of the time, the setting, or whether a plan exists);
                                409 when it cannot: the task is running / waiting, has no session to resume, or a
                                resume is already in flight
DELETE /api/tasks/:id/resume    forget the plan and the consecutive-stop count (idempotent; 404 unknown task)
```

`Task.resumeAt` (ms or null) comes with every task (`GET /api/tasks`, `task.updated` over the socket).

## Settings（#835）

`PATCH /api/settings { quotaAndResume: { … } }` (partial; `null` puts the group back to the defaults). Read on every
use — the next stop, the next tick, the next shutdown or start — so a change needs no restart.

| Setting | Default | What it changes |
|---|---|---|
| `retryDelayMs` | 15 min | the first wait when no reset time is known (doubles per consecutive stop) |
| `retryMaxDelayMs` | 4 h | the most that wait grows to (not shorter than `retryDelayMs`: 400) |
| `maxLimitStops` | 8 | usage-limit stops in a row of turns the daemon resumed before it gives up; also the cap on resume sends that failed in a row |
| `resumePrompt` | 使用上限がリセットされました。… | the text of the usage-limit follow-up |
| `maxStopResumes` | 2 | daemon stops in a row a turn is continued after (shutdown and the orphan pass at start) |

The head `[Switchboard 自動再開]` is not part of `resumePrompt`: the daemon puts it in front of whatever the setting
says, because the stop counter (`consecutiveStops`) and the evals (`isAutomaticUserText`) tell the daemon's own
messages from the person's by it. The daemon-stop follow-up (`STOP_RESUME_PROMPT`) is not a setting.

## 上限のときの代わり（#834）

The automatic resume waits for the same runner. A Task that starts by itself can instead start on another runner while
the decided one is at its limit.

- **Setting**: `settings.autoStart.fallback` (the order of runners, e.g. `["codex", "dak"]`; empty = no switch, the
  default) and `settings.autoStart.fallbackAt` (0.5–1, default 0.9). `PATCH /api/settings { autoStart: { fallback,
  fallbackAt } }`: `fallback` replaces the whole order; a runner it adds that is not detected is 400 (one already in the saved order may
  stay while it is not detected, so the order can still be edited around it). Set on the 設定 screen
  (「自動で始まる Task の既定」 → 「上限のときの代わり」).
- **Judgement** (`fallbackRunner` in `packages/core/src/ratelimit.ts`): a runner is at its limit while one of its
  `quota` windows is at `fallbackAt` or more and has not reset yet. A runner with no `quota` rows (DAK) never is. When
  the decided runner is at its limit, the candidates are the order after it, then before it (from the head when it is
  not in the order); the first detected one not at its limit wins. None = the decided runner as it is (a stop on the
  limit is then the automatic resume's).
- **Where it applies**: the backlog stage buttons, the feedback button (both modes), backlog-next's stage Tasks
  (`startMetaTask`; the runner is decided first as before — the kind's own, the schedule's, the saved one), and a
  prompt schedule's firing (`Scheduler.runNow`). Not: a Task made by hand (the person picked the runner), a Task that
  is already running (a conversation does not move between runners), the insights schedule (Claude only).
- **Model and effort**: the switched-to runner starts on its CLI default model and effort (a model belongs to one runner).
- **Record**: the Task's transcript gets one `status` before the first turn: 「claude が上限（0.95、04:10 に戻る）のため
  codex で開始」 (`fallbackNote`); a schedule's log gets the same line.
- **backlog-next's usage**: the 0.8 hold (`backlogQuotaLimit`) and the 100% stop are judged by the usage of the runner
  each stage Task starts on, after this switch ([backlog.md](backlog.md)).

## UI

- Home: a checkbox next to the runner choice, 「使用上限で止まったら自動再開」, per runner (hidden for DAK).
- Rail / Home「最近」/ Task header: a tag 「再開待ち 04:11」(date when not today) on tasks with a plan; the Rail's
  narrow rows show 「再開待ち」with the time in the tooltip, so a dated time next to a Terminal tag cannot squeeze the
  title out.
- Task Brief: a 「使用上限」block saying when it goes on and whether by itself (the runner's setting when known; "shown
  once connected" when the runner list is not there yet, off-loopback before the token), with 「今すぐ再開」and
  「取り消す」. A task with no session to resume says so and disables 今すぐ再開. Times in the UI are the browser's
  clock; the transcript's status line is the daemon's — the same machine unless the UI is used from elsewhere.
- GitHub の API 上限（#550, `resumeReason: "github"`）: the tag reads 「GitHub の上限待ち（04:11 に再開）」(the Rail:
  「GitHub 待ち」with the time in the tooltip) and the Brief block is headed 「GitHub の API 上限」and opens with
  「GitHub の API 上限で待っています。」; the time, the auto-resume sentence and the two buttons do the same (今すぐ再開's tooltip says the command meets the limit again).

## GitHub の API 上限（#550）

ランナーの使用上限とは別に、ターンの中のコマンドが GitHub の GraphQL / REST の上限に当たることがある（1 ユーザー 1 時間 5,000 点、ホストの全 Task で共有。#547）。このときランナーは止まらず、「枠が戻るまで待つ」と言ってターンを**正常に**終える（`session.end` は `ok`）ので、#102 の検出（エラーで終わったターン）には掛からない。#550 は、終わったターンのコマンドの結果からこれを見つけ、GitHub の時刻で再開を計画する。

- **見分け方**（`packages/core/src/ratelimit.ts` の `githubLimitHit` / `GITHUB_LIMIT_LINE`）: `tool.result` の summary の**行頭**にある `API rate limit (already) exceeded for …`（`gh: ` / `GraphQL: ` の接頭辞は可）だけを数える。`ok` は見ない（リトライのループや `; date` で終わるコマンドは exit 0 でもこの行を出す）。`Read` / `Grep` / `Glob` の結果は数えない（行頭にパスや行番号が付くので、行頭で見れば「読んだだけ」は元から数えないが、念のため除く）。`tool.result` の summary は 600 文字で切られるので、それより後ろの行は見えない
- **後半で同じコマンドが成功したら付けない**: `TaskManager` が `tool.call` の `name` と `input` を鍵にして（`LiveSession.turnCalls` / `turnGithub`）、上限の行を返したコマンドと同じ鍵の `tool.result` が `ok:true` で上限の行なしに返れば取り消す。残った最後の行が `TurnEnd.githubLimit`
- **時刻**（`RateLimitResumer.planGithub`）: ランナーの上限で止まったターン以外（`ok` で終わっても、別のエラーで終わっても。中断は除く）で `githubLimit` があれば、`ResumerOptions.githubBudget`（デーモンでは `GithubBudgetCache.get(cwd)`。`gh api -i graphql { rateLimit }`、本文に無ければ応答の `X-Ratelimit-Remaining` / `-Limit` / `-Reset` ヘッダ）を読む。残りが `GITHUB_REMAINING_MIN`（1,000）未満なら `resetAt` + 1 分、戻っていれば 5 分後（`LATE_RETRY_MS`）、読めなければ使用上限と同じ 15 分から倍々。読むあいだに返信・中断・取り消し・次のターンがあれば何もしない（取り消しは保留中の計画も捨てる）。連続回数の上限（`maxLimitStops`）は使用上限と共通
- **記録**: `Task.resumeAt` と `resumeReason: "github"`（列 `resume_reason`。null は計画なし、または #550 より前の計画 = ランナーの上限として扱う）。transcript の `status` は `GitHub の API 上限で待機: <行>。HH:MM に自動再開します（OFF なら 再開できます…）。<時刻の出どころ>`
- **再開の文言**: `GITHUB_RESUME_PROMPT`（`[Switchboard 自動再開] GitHub の API 上限が戻りました。中断した箇所から作業を続けてください。`）。`resumeReason` が `github` のときは tick も「今すぐ再開」もこれを送る。デーモン停止の判定（`interrupted.ts` の `lastStopWasDaemon`）はこの `status` で false を返して止まる
- 検証: `packages/core/src/ratelimit.test.ts` の「GitHub」の組（録画どおりのイベント列を偽ランナーに流す）、`backlog.test.ts` の GitHub budget（ヘッダだけの `-i` の答え）

## Not done / open

- Codex wording is a guess until a Codex limit stop is recorded (`runner-adapter-recording` skill); `rateLimitReachedType`
  could make the Codex detection exact once surfaced through `quota`.
- The follow-up wording is one setting for every task and runner (`resumePrompt`, #835). A per-task or per-runner prompt
  can be added if one wording turns out to steer some agent badly.
- The consecutive-stop count does not survive a restart (a restart starts it over); acceptable because every stop is
  visible in the transcript and each attempt is free.
- GitHub の上限（#550）: 上限中に `gh api -i` の応答が実際にヘッダを返すかは未確認（読めなければ fallback の時刻）。`gh: ` の行は REST の上限でも出る（時刻は GraphQL のもの）。前のターンで上限を知ったまま、そのターンでは gh を呼ばずに終えた場合は拾えない（前のターンで付いた計画が残る場合だけ再開される）

## 停止の系列との関係（#939）

再開の送信失敗は固定の id の `resume.send` の停止として `stop.record` に残り、更新として扱う（試行は `actions` に積まれ、系列の回数は増えない）。再試行の回数・間隔（5 秒・30 秒）と、使い切ったあとの判断項目は `repeated-stops.md`。API 上限の回復は #550 のままこの文書の責務。
