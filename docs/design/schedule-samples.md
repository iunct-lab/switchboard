# Schedule samples: the steps

A new instance has a set of schedule samples in Schedules: prompt schedules that are disabled and carry `（サンプル）` at
the head of their title. The person turns one on, rewrites it or deletes it. The list is in
`packages/core/src/scheduleSamples.ts`; how a sample is added, once, is in the scheduler's design notes.

A sample's prompt is one short paragraph. It names a section of this document, and the steps are here, in one place. So
a prompt holds no value of an instance: no workspace id, no repository name, no port, no account. A Task that runs a
sample reads those values each time, as the first two sections say. This document carries no issue numbers; a reason is
given in words.

Rules for every sample:

- The Task changes no file of a repository and no schedule. What it produces is a report, a request, or a comment.
  The one exception is "Checking PBIs in one pass", which also writes the PBIs it checks (see its section).
- Work files go under `W=$(mktemp -d)`.
- No secret, no value that can be used to authenticate (token, key, account id, a link's secret, the name of a profile
  or a login session) and no raw output of a Task's conversation goes into a report, an Issue or a comment.
- The Task ends by reporting what it filed (the number) or why it filed nothing, and a summary.
- A precondition that does not hold (named in the sample's section) is not an error: the Task does nothing, says which
  precondition is missing, and ends.

## How a sample reads the instance

Everything comes from the environment the daemon gives a Task.

| What | How |
|---|---|
| The API | The origin is `${BACKLOG_URL%/api/backlog}`. Send `Authorization: Bearer $(cat "$BACKLOG_TOKEN_FILE")`. The token's value is never printed, reported or written |
| The database | `sqlite3 -readonly "$SWITCHBOARD_DAEMON_HOME/switchboard.db"`. Read only |
| This workspace | `GET /api/tasks/$SWITCHBOARD_TASK_ID?limit=0`, field `task.workspaceId` |
| Every workspace | `GET /api/workspaces`: `id`, `name`, `path`, `kind` |
| A workspace's repository | In the workspace's `path`: `git -C <path> remote get-url origin` gives owner and name. A workspace with no remote has no GitHub repository: steps that read GitHub skip it and say so |
| Switchboard's repository | The `path` of the workspace whose `kind` is `meta`. This document, the skills (`ops-kit/skills/`) and the scripts are there |
| The backlog | `ops-kit backlog <list, view, create, comment or edit> --workspace <id>` (`ops-kit backlog --help`). Not `gh issue`: the app keeps the backlog and sends the writes |

```bash
API="${BACKLOG_URL%/api/backlog}"
api() { curl -sf -H "Authorization: Bearer $(cat "$BACKLOG_TOKEN_FILE")" "$API$1"; }
WS=$(api "/api/tasks/$SWITCHBOARD_TASK_ID?limit=0" | jq -r .task.workspaceId)
META=$(api /api/workspaces | jq -r '.[] | select(.kind == "meta") | .id')
DB="$SWITCHBOARD_DAEMON_HOME/switchboard.db"
```

A sample "for this workspace" works on `WS` and its repository: the person points the sample at another repository by
changing the schedule's workspace in Schedules. A sample "for every workspace" reads the list from the API and names no
workspace.

Tables a sample reads: `tasks` (`workspace_id`, `schedule_id`, `runner`, `status`, `outcome`, `resume_reason`),
`task_evals` (`source` is `rules`, `judge` or `human`; the `json` column), `ledger` (the sum of `cost_usd` per
`task_id`), `routing_log`, `quota`, and `events` (one JSON document per event; `json_extract(json,'$.t')` is its kind).

## Where a sample files its request

A request is an Issue with the label `type:request`. There are two places, and a sample's section says which finding
goes where:

- **the repository**: what the workspace's own repository can change — its instructions (`CLAUDE.md`, `AGENTS.md`,
  its docs), its structure, its dependencies. `ops-kit backlog create --workspace "$WS" --label type:request --title <title> --body-file <file>`.
- **Switchboard itself**: what only Switchboard can change — routing rules, the default models, the shared skills, the
  way Switchboard works. The same command with `--workspace "$META"`.

When this workspace is the meta workspace the two are the same repository: file one request, not two.

- The body has `## 要望` (the proposals) and `## 出典` (whose words: the agent; the sample's title; the date; how much
  was read). A sample's section adds its own heading for the figures.
- Before creating, look for an open request with the same title:
  `ops-kit backlog list --workspace <id> --label type:request --search <title>`. When there is one, add a comment to it
  (`ops-kit backlog comment`) and create nothing.
- Fields of the repository's Project (Status and the rest) follow that repository's own rule (its `issue-workflow`
  skill or `CLAUDE.md`), when it has one.
- At most one request per place and per run, unless the section says otherwise.

An HTML report, where a section asks for one: one file under `W`, `<meta charset=utf-8>`, no external script, css or
font (css goes into a `style` element), and nothing else in HTML in `W`. Text copied from the database or from a
command's output has `&`, `<`, `>` and `"` escaped and is never written as a tag. The reply ends with a
`switchboard-artifact` fence (its shape is in the Task's opening instructions) whose `path` is that file.

## Samples for one workspace

### Weekly eval report

Analyses the evaluations of this workspace's Tasks of the last week and files one request per place.

- **Read**: the Tasks of `WS` updated since 00:00 seven days ago, with `task_evals`, `ledger` and `routing_log`.
  - A Task's model is read from its `session.start` events: the distinct `json_extract(json,'$.model')` values (empty
    ones not counted). One value is the Task's model; two or more make it a `途中でモデルを変えた Task`; none, a
    `モデル不明` Task. `tasks.model` (the last model chosen) and the ledger's model (routing and judging rows are mixed
    in) are not used to compare models.
  - A Task's effort is read the same way from `json_extract(json,'$.effort')`; `""` is the CLI default and counts as
    one value. Two or more make it a `途中で思考の深さを変えた Task`, a row of its own. `tasks.effort` is not used.
  - A Task's conversation is read only for the five weakest Tasks.
- **A stop of the daemon is not a weakness of a Task**: a Task whose `rules` evaluation has `metrics.lastCutByDaemon`
  true does not count as failed or stopped and is not among the weak Tasks, and `metrics.daemonStops` is not counted as
  stops. An evaluation without those fields is judged by a `status` event whose text starts with
  `デーモンの停止でターンが中断されました`. The table has a row `デーモンの停止で中断`, also when it is 0.
- **Look at**: (a) what the Tasks with many failures, errors, stops or follow-up instructions have in common (the kind
  of title, the skills used, runner and model, effort) — runner, model and effort are compared among Tasks with one
  value only; (b) Tasks whose model was too much or too little for the difficulty; (c) Tasks with little result for
  their cost; (d) which rubric items are low; (e) what instruction was missing in Tasks with many turns or follow-ups;
  (f) the gap between the person's score and the judge's (for Tasks with both: the mean of the person's score minus
  the mean of the judge's items, and how many; when the absolute gap is 1 or more, whether the judge is lenient or
  strict, with the Task ids); (g) the stages the person named when rating closed requests as a whole: `stages` of
  `GET /api/evals/summary?workspaceId=<WS>` (read from the origin of `BACKLOG_URL` with the token in
  `BACKLOG_TOKEN_FILE`), the last four weeks' count per stage (`none`, `request` = how the request was read, `pbi` =
  how the PBIs were cut, `impl`, `report`) with example request numbers. The stages are only what the person chose;
  none is guessed.
- **File**: to the repository, improvements of its instructions and structure; to Switchboard itself, routing rules,
  default models, the wording of skills. Title `評価の週報（<workspace name>）: <the Monday of the week, YYYY-MM-DD>`.
  `## 要望` has at most three proposals, one line each, largest effect first, each saying which document, rule or
  default changes and how. `## 分析` has a table (kind / count / up to three Task ids), the suspected causes and the
  proposals not taken; the rows for a changed model, a changed effort, an unknown model and the gap to the person's
  score are there also when they are 0. `## 分析` also has the five stages of (g) with their counts and example
  numbers, each row there when it is 0. When `request` or `pbi` is the largest, a proposal changes the wording of the
  `request-to-backlog` or `pbi-to-tasks` skill; when `impl`, of `task-to-pr`; when `report`, the form of the final report.
- **Report**: an HTML report `weekly-<Monday>.html`, registered with the title
  `評価の週報（<workspace name>）<Monday>`: the period; per runner the count, the outcomes and the median cost; the five
  weakest Tasks and what they share; the low rubric items; the gap to the person's score; the request's number, or why
  none was filed.

### Review comment trends

Collects the kinds of review comment that came up twice or more in this workspace's repository.

- **Precondition**: the repository is on GitHub (see the table above). Otherwise report that and end.
- **Read**: the pull requests merged or closed in the last 30 days and their comments, over REST only
  (`gh api repos/<owner>/<name>/pulls/<n>/comments` and `.../issues/<n>/comments`), whoever the reviewer was (a
  subagent, another runner, a person).
- **Sort** each recurring comment into: an instruction was missing (writing it into `CLAUDE.md`, `AGENTS.md`, a skill
  or a design note would have prevented it) / a design rule was read differently / a kind of test was missing / a habit
  of the code itself.
- **File**: to the repository, what its own documents can prevent; to Switchboard itself, what a shared skill
  (`ops-kit/skills`) or Switchboard's own behaviour can prevent. Title `レビュー指摘の傾向（<workspace name>）: <YYYY-MM>`.
  `## 要望` has at most five proposals, one line each: which section of which document gets what. `## 集計` is a table
  (kind of comment / count / up to three pull requests). Comments are summarised, not copied.

### Ideas from upstream changes

Turns the last week's changes in what this workspace's repository depends on into proposals.

- **Read** (and nothing else): the release notes of the last 7 days of the tools and runtimes the repository is built
  on. For a repository that names them in its `CLAUDE.md` or README, those; otherwise the direct dependencies in its
  manifest. For Switchboard's own repository: the Claude Code changelog, the Codex CLI releases, the Bun releases, the
  GitHub changelog (Issues, Projects, Actions, API) and the MCP specification.
- **Take** a change only when it fits the repository's stated design rules and offers something its design notes do
  not have yet.
- **File**: to the repository, when there is at least one idea. Title `動向からの案: <Monday, YYYY-MM-DD>`. `## 要望`
  has at most five ideas, largest effect first: a heading, the source URL, three lines on how the repository would use
  it, and the document it touches. Ideas already in an open request or backlog item
  (`ops-kit backlog list --workspace "$WS" --search <words>`) are left out and listed by number as already there.
  `## 出典` lists the versions read. With no idea, file nothing and report the versions read.

### Dependency updates

- Run `ops-kit deps-check --file-request` once, in the workspace's folder, and report its exit code and output as they
  are, including the last line that starts with `要望:`. Do not repeat the command.
- Exit code 2 means the check could not decide: report it with a `switchboard-stop` fence, with the first line of the
  output as the reason.
- The command files to the repository by itself; the Task files nothing else.

### Public repository sync

- **Precondition**: the workspace's `ops.config.json` has `publicSync`. Without it, do nothing, report
  `publicSync が無いリポジトリ`, and end.
- `git fetch -q --prune --prune-tags origin`, then choose the tag to publish: the rule of the repository's own
  instructions when it has one; in a repository that has `scripts/tag-ci.ts`, the newest tag whose CI passed
  (`bun scripts/tag-ci.ts --latest-pass`, which reads the marks in the Releases, not the app's job records that the promotion reads; another exit code than 0 means there is none: do not sync); otherwise the
  newest tag on the main branch (`git describe --tags --abbrev=0 origin/main`).
- Run `ops-kit public-sync --source <tag>` once. Never add `--adopted`. Report the tag, the exit code and the output
  as they are.
- When the sync ended with exit 0 and the repository has `scripts/release-smoke.ts`, run
  `bun scripts/release-smoke.ts <publicSync.target> --record <the tag synced>` once and put its last line
  (`[release-smoke] pass|fail <public tag> <sha>`) into the report as it is. It installs the public Release the sync made
  the way the README says, on a PATH without git, and writes that line into the Release of the development tag; on a fail
  it files a request (or comments on the open one). A fail (exit 1) is reported with a `switchboard-stop` fence like a
  failed sync, with its `✗` line as the reason. A repository without that script skips this.
- When no tag could be chosen or the sync ended with another exit code than 0, report the stop with a
  `switchboard-stop` fence, with the first line of the output as the reason. Files nothing.

### Weekly AWS cost report

Reads the AWS bill of the account this instance runs in and reports where the money goes.

- **Precondition**: `aws sts get-caller-identity --output json` succeeds. When it fails, write no report and file
  nothing; report `AWS の認証が無い環境` and end. The `Account` of its output is used for `--account-id` below and is
  written nowhere.
- **Allowed commands**: the read-only `aws ce get-cost-and-usage`, `aws ce get-cost-forecast`,
  `aws budgets describe-budgets` and `aws sts get-caller-identity`, each with `--region us-east-1`. No AWS write.
- **Collect**: this month (the 1st to tomorrow) and last month, `UnblendedCost`, `MONTHLY`, grouped by `SERVICE` and
  `USAGE_TYPE` (the top 15 rows and the sum of the rest); `DAILY` for the last 7 days and the 7 before, per service,
  with the difference, largest increase first; the forecast to the end of the month; each budget's limit, actual and
  forecast. A budget may be filtered by a tag while the breakdown is the whole account: the tables say which is which.
- **Why it grew**: per service and usage type that grew, compare with what changed in that period — pull requests
  merged in this workspace's repository, closed Issues, schedules and offloaded builds. A guess with no evidence is
  marked as one.
- **Ways to spend less**: at most three, largest effect first, each with an estimate per month.
- **File**: to the repository (this workspace: point the sample at the workspace whose repository holds the
  deployment), only when there is a way to spend less. Title `AWS の費用の週報: <today, YYYY-MM-DD>`, with `## 分析`.
- **Report**: an HTML report registered with the title `AWS の費用の週報 <today>`: the three main points, the
  breakdown, the 7-day difference, budgets and forecast, why it grew, ways to spend less.
- The account id, the name of a profile and the name of a login session appear neither in the report nor in the Issue.

### Checking PBIs in one pass

Checks, in one run, the lines that only a look after the merge can tick, in the PBIs of this workspace that are being
checked. It closes a PBI whose lines are all met, and sends a PBI with an unmet line back to be fixed. This is the one
sample that writes a PBI: its body (the ticks), its comments and its Status, through `ops-kit backlog` and the
steps of the `pbi-complete` skill, and a repair Task for a line that failed. It changes no file of the repository.

- **Collect**: `GET /api/backlog` (`api /api/backlog`, as above). Keep the items with `workspaceId == WS` and
  `progress.checking == true`: the PBI is built, every Task is closed, and the unchecked criteria are after-merge
  lines, besides any user-check lines (those stay the person's). Of each, `postMerge` lists those lines as `{n, text, kind, after}`: `n` is the number of the criterion (from
  1, over every checkbox line of the PBI's body), `text` the line after `- [ ] `, `kind` one of `画面`, `E2E`,
  `実ランナー`, `観測`, and `after` the time of a `観測` line's `期日 … 以降` (null for the others, or when no date
  could be read).
  ```bash
  api /api/backlog | jq --arg ws "$WS" '[.items[] | select(.workspaceId == $ws and .progress.checking)
    | {number, title, lines: [.postMerge[] | {n, kind, after, text}]}]' > "$W/checking.json"
  ```
  With no item, report that nothing is being checked and end. A line that also carries a user-check mark is not in
  `postMerge` (it is the person's to answer), and a PBI that is not `checking` is not touched.
- **Check each line by the command of its own check** (the part of the line after `検証:`), never by a script written
  for the run. Read the PBI's body (`ops-kit backlog view <n> --workspace "$WS" --fresh`) for the rest of the line.
  A line whose check names no command cannot be checked: leave it (see "A line that could not be checked").
- **Prepare once for each kind**, and only for the kinds that have a line to check. All the lines of one kind are
  checked on that one preparation, whichever PBI they belong to:
  - **`画面`**: build the web app once, then take the screens once. The screens to take are the union of the screens
    the lines name, each taken once at both widths the repository's own instructions ask for. Look at each picture
    yourself before ticking a line, and upload each as the repository's instructions say for images. A line whose
    screen cannot be taken is left.
  - **`E2E`**: start one candidate daemon (the way the repository's own instructions give for a live check, on a copy
    of the data and a free port) and run every `E2E` line against it. Stop it, and remove its work files, when the
    last line is done.
  - **`実ランナー`**: check the usage limits of the runners once before the first such line (the `quota` table, or the
    way the repository's instructions give). When the runner a line needs is near its limit, do not run it: the line
    is left. Lines of one runner are run one after another on that one check.
  - **`観測`**: only the lines whose `after` is past (`after` earlier than now, compared as instants, whatever the
    zone it is written in) are checked: for these, read what the line says to read (a table, a count, a log) and tick
    it only when the reading shows what the line asks. A line with a later `after` is not looked at and is not
    reported as left. A line with no `after` (no date, or one that could not be read) cannot be checked: it is left,
    with that reason, so the report names it on every run until its date is fixed.
- **A met line** is ticked (`- [x]`) in the PBI's body, with the proof at the end of the line: the command and its
  output, the URL of the picture. Only a line with proof is ticked. A PBI whose criteria are all ticked and which has
  no user check left is closed by step 6 of `pbi-complete`; one with a user check left is set to In review (if it
  is not already) and stays open. The PBI's
  `## 結果` is written as that step says.
- **An unmet line** is not ticked. Write a comment `## 確認の結果` on the PBI: what was done and how it differed from
  what the line asks. Cut a Task that fixes it (`pbi-to-tasks`) and set the PBI's Status back to In progress. The new
  open Task takes the PBI out of "checking", so the backlog's own run goes on with the implementation.
- **A line that could not be checked** — the preparation failed, the runner's limit was too near, the check named no
  command, a `観測` line has no readable date — is left as it is: the PBI is not changed for it, and no stop report is made. The reason goes into the result
  of this run, and the next run takes the line again. A line whose date has not come is not "left" in this sense.
- **Untouched**: a PBI that is not `checking`, a `観測` line before its date, a user check. Nothing else of a PBI is
  written but what the steps above name.
- **Report** (in the Task's final reply; no Issue and no HTML): a table with one row per line checked or left, in the
  columns PBI / line / kind / closed, sent back or left / reason, and below it how many times each kind was prepared
  (each is 0 or 1). A PBI that was closed has the place of its proof named in the row. With no row, say why.

## Samples for every workspace

### Why tasks stopped

Counts why Tasks stopped in the last 7 days, over every workspace.

- **Read**: `tasks` whose `status` is `error` or `aborted` or whose outcome asks for attention; `resume_reason`; the
  `switchboard-stop` fences in `events` (reason `usage-limit`, `github-limit`, `transient`, `auth`, `permission`,
  `input`, `decision`, `depends`, `unknown`); `quota`.
- **Stops of the daemon are separate**: `GET /api/ops/stops?days=7`. A Task in its `taskIds` that was cut is not a
  failed Task; it goes into a section of its own, by cause of the daemon's stop. A Task whose `rules` evaluation has
  `metrics.lastCutByDaemon` true is counted in the row of the daemon's stops even when its status is `error` or
  `aborted`, and is no evidence for a proposal.
- **Table**: reason / count / workspace / runner / up to three Task ids / total time stopped.
- **Propose** (at most three, one line each, largest effect first): for usage limits, the hours, the split between
  runners, the auto-resume settings; for the GitHub budget, how it is read (REST, how often); for many waits on a
  decision, how requests are written or a skill; for many waits on an approval, the default approval mode.
- **File**: to Switchboard itself. Title `止まった理由: <Monday, YYYY-MM-DD>`; `## 集計` is the table.

### Backlog inventory

Goes through the backlog of every workspace and writes each proposal as a question on the item it concerns. It files
no request, and it does not close, merge or edit an Issue or change a Status or priority: the person's answer decides.

- **Read**: per workspace of `GET /api/workspaces`, `ops-kit backlog list --workspace <id>` and
  `ops-kit backlog view <n> --workspace <id> --fresh`.
- **Candidates**: a request or backlog item not updated for 30 days; one waiting for a decision for 14 days or more;
  items with the same title or purpose; one that is Ready and has not started for 30 days. In addition, at most five
  per run: an open request whose backlog items (the ones its `## 元要望` links name) are all closed.
- **Proposals**: close / merge / lower the priority / split again (only when one item mixes two values, never by
  size) / a draft answer to the open question.
- **Write**: one comment per proposal on one Issue (for a merge, the one that stays; the other's number goes into the
  question), then the label `needs-decision`:
  `ops-kit backlog comment <n> --workspace <id> --body-file <file>` and
  `ops-kit backlog edit <n> --workspace <id> --add-label needs-decision`. The comment has the shape of the
  `issue-workflow` skill's question:

  ```markdown
  ## 判断待ち
  **問い**: <one sentence>
  **選択肢**:
  - A: <proposal> — 影響: <what happens>
  - B: 今のまま残す — 影響: <…>
  **推奨**: <A / B> — <numbers and dates only>
  **止めた場所**: 定期実行「バックログの棚卸し」 <YYYY-MM-DD>
  ```

- **Do not stack**: write nothing on an Issue that has `needs-decision` or an unanswered `## 判断待ち` (for one waiting
  14 days or more, write the draft answer only). An item whose earlier inventory question was answered with "keep" is
  not raised again unless it changed since.
- **Report** per workspace: items seen / questions written, with numbers / numbers skipped for not stacking.

### Schedule review

Reviews the schedules themselves. Proposals only: it changes no schedule.

- **Read**: `GET /api/schedules` and `GET /api/schedules/log?since=<30 days ago, epoch ms>`; each schedule's Tasks
  (`tasks.schedule_id`) with their cost and evaluations; and what each schedule produced. Requests are found per
  workspace by the title prefixes of the sections of this document
  (`ops-kit backlog list --workspace <id> --state all --label type:request --search <prefix>`): did the request become
  a backlog item, was it closed. The backlog inventory files no request: its result is the questions its Tasks
  reported, and whether they were answered.
- **Table**: schedule / workspace / firings in 30 days / skipped / failed / mean cost / total cost / mean rubric /
  requests filed / of those, became a backlog item / closed.
- **Judge**: three firings in a row with no result — lower the frequency. Cost out of proportion — a lighter model or
  effort. Requests that never become backlog items — stop it. A prompt that fails the same way — a corrected prompt,
  written out in full. Useful twice or more — make it a script that files its own request. A view nobody checks yet —
  a new schedule. Give the total cost per month and the estimate with every proposal taken.
- **File**: to Switchboard itself. Title `定期実行の見直し: <YYYY-MM>`. `## 要望` has one line per proposal (add /
  change / stop / delete, the reason, the cost estimate); `## 集計` is the table.

### Rubric calibration

Compares the person's scores with the judge's.

- **Read**: every Task that has both a `human` and a `judge` row in `task_evals`.
- **Fewer than 10** such Tasks: file nothing; report the count and how many more of the person's scores a calibration
  needs.
- **10 or more**: the gap between the person's score and the mean of the judge's items (the mean gap, and the Tasks
  where it is 2 or more), per rubric item and per judging model. Propose a corrected guide sentence for a rubric item,
  or another judging model. The rubric is `packages/core/src/rubric.default.json` in Switchboard's repository; the
  person's replacement, when there is one, is `$SWITCHBOARD_DAEMON_HOME/evals/rubric.json`.
- **File**: to Switchboard itself. Title `ルーブリックの校正: <YYYY-MM>`. `## 要望` gives, per item id, the guide now
  and the corrected guide, or the change to the judge's settings; `## 集計` is a table (item / the person's mean / the
  judge's mean / gap).
