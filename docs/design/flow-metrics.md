# flow-metrics (measuring how development proceeds, stage by stage)

For each closed PBI, split the time from the request to the close into 7 stages, and print with one command which stage took the time, how much of it was waiting for the user's reply, how many rounds of review there were, and how long Switchboard's Tasks ran and what they cost. The point is to choose where development loses time by numbers instead of a hunch, and to compare before and after a fix. How the numbers are shown on a screen is in "The Backlog screen and `/api/flow`" below, and the improvement loop is in "The improvement loop" below.

## Background (what it draws on)

- **The work that made claude.ai faster** (https://claude.dev/blog/how-we-made-claude-ai-faster, the same article as [perf.md](perf.md)): it aligned the user journeys as "starts with an action, ends with a result", measured them stage by stage, picked the stage that took the most time and fixed it, and checked the effect by numbers, in a loop. Applied to how development proceeds, the journey is "request → PBI → split into Tasks → start → PR → review → merge → close the PBI"
- **DORA** (https://dora.dev/guides/dora-metrics/): five measures: lead time for changes, deployment frequency, change failure rate, time to restore service and rework rate. They are used to see the direction of improvement, not for comparison or goals (a number made a goal gets distorted)
- **Split the cycle time into stages**: splitting it like "coding / waiting for review / review / deploy" shows the stage that is stuck. Here the stages are cut by the times of Issues, PRs and comments
- Change failure rate and time to restore are not measured. Rollbacks among the merged PRs are too rare to mean anything as a number. They will be added when they are needed

## Stage definitions

Every stage runs "from the time of one mark to the time of another mark". If even one of the needed marks is missing, the stage is **unknown** (`null`) and is not filled in by guessing. The cutting is done by the pure function [`flowOfPbi`](../../packages/core/src/flow.ts) (its test uses made-up PBIs: `packages/core/src/flow.test.ts`).

| Stage | From | To |
|---|---|---|
| `request` | The creation of the original request's Issue (the first `#N` in the PBI's `## 元要望`; unknown if it says `なし`) | The creation of the PBI |
| `split` | The creation of the PBI | The creation of the last Task (sub-issue) created at or before the first start (the first PR's creation if there is no start mark). A Task created after the start does not count. With neither a start nor a PR, the last Task |
| `wait` | The end of `split` | The first start (a Task's start comment). The first PR's creation if there is no start mark |
| `build` | The first start | The creation of the first PR |
| `review-wait` | The creation of the PR | That PR's first `[codex\|claude\|dak] review` comment. Taken per PR, then the median |
| `review` | That PR's first review | The merge of that PR. Taken per PR, then the median |
| `close` | The merge of the last PR | The time the PBI was closed |

- **Where it reads from**: the `createdAt` / `closedAt` of Issues (PBIs, Tasks, requests), the Issue comments, the Story Points and the sub-issues are read from **the app's stored values** (`GET /api/backlog/records`, which `readStoredRecords` returns; it includes edits waiting to be sent, and counts PBIs that exist only in the app). Only merged PRs (their creation and merge times, and the review-mark comments) are read from GitHub. A PR is matched to a Task by the same `closesOf` rule as the parallel guard (`Closes #N` / `Backlog-Task: N` in the body, and `sb/<N>-` in the branch name). Numbers in an app-only backlog do not correspond to GitHub Issues, so GitHub's `closedByPullRequestsReferences` is not used
- **Marks**: the `createdAt` / `closedAt` / `mergedAt` of Issues and PRs, a Task's start comment (`<!-- parallel-guard:task-claim <token> -->`, or a line that begins with `着手`; a token that yielded and was withdrawn with `parallel-guard:withdraw` is not counted), a PR's `[codex|claude|dak] review` comment (the same form as `scripts/merge-gate.ts`), and the `## 判断待ち` / `## 回答` comments (`issue-workflow`, `判断待ちの出し方`). The skills always leave all of them
- A Task added after the start (a fix from a review gate, an addition after an answer) is not splitting time, so it is not used for a stage boundary
- A PR that was only closed, not merged, is not counted. When one PR closes several Tasks, it is counted once
- **Waiting for a reply** (`userWaitMs`): for the PBI and each Task, add up the span from a `## 判断待ち` to the next `## 回答`, paired per Issue. A `## 判断待ち` with no answer counts as 0 (it is still open, or no record exists). Operational confirmations (such as whether to merge) are asked in the Task's conversation, so they leave no mark on the Issue and are not included here
- **Review rounds** (`reviewRounds`): the number of `[codex|claude|dak] review` comments per PR. A re-review after a fix also counts as one

## Backlog net growth and deferrals

The speed of closing alone does not show whether the backlog is growing by itself. A third of Tasks end by putting something off, and schedules also file requests automatically, so we count, week by week, the difference between filed and closed, next to the deferred Tasks and the Issues filed from them (it only counts; no rule to stop deferring is made).

- **Week**: 7 days from 00:00 UTC on a Monday (`weekStartOf`). From the first week of the period (the week that contains `days` days ago) up to the current week, empty weeks are also printed as 0
- **Filed, closed, net growth**: for each week, count the `type:pbi` and `type:request` Issues by the `createdAt` / `closedAt` of the app's stored values (`flowOfStored`; the week is UTC). An Issue that is not in the stored values (for example one closed before it was imported) is not counted. Net growth = (PBIs filed + requests filed) − (PBIs closed + requests closed) (`backlogGrowth`)
- **`deferred` (the deferral mark)**: it is set on a Task whose last `session.end` `summary` contains any of `残した``見送り``後回し``スコープ外``別 Issue` (`DEFERRED_WORDS` / `deferredOf`, `packages/core/src/db.ts`). The week is decided by the time of that last `session.end` (`deferredTasksSince`)
- **`createdIssues` (the Issues that Task filed)**: read from the Task's events in two ways (`createdIssuesOf`). (1) The Issue URL in the successful `tool.result` that matches a `tool.call` whose input contains `gh issue create` or `request_issue.sh`. (2) A filing inside an app Task (gh-guard stops `gh issue create`, so it is saved through `ops-kit backlog create`, and only a line `作りました（送信待ち）: localId <uuid>` or `#N を作りました（localId <uuid>）` is printed; the same for a script that calls it): the localId is read back to a repo and a number from the create saved during that call (`backlog_operations`) and its record (`backlog_records`). No column is added; it is counted from the events each time. GitHub is not queried. `createdIssues` / `deferred` of `GET /api/tasks/:id`
- **Filed from them**: of the `createdIssues` of the Tasks that carry the deferral mark, the number of Issues in that repository

Limits:

- It matches words, so a negation such as `スコープ外は無し` is also counted as a deferral
- A tool result is cut at 600 characters. A URL that comes after that cannot be read
- For a Task whose `events` body has been archived to S3 (the age at which that happens is the instance's setting),  the `input` of `tool.call` and the body of `tool.result` are gone, so `createdIssues` is empty (`session.end` remains, so `deferred` remains)
- A filing whose `gh issue create` output was reduced to only a number, as in `A=$(gh issue create … | grep -oE '[0-9]+$')`, without printing the URL, cannot be read. A Task that filed this way counts as 0 in "filed from them"
- A localId filing counts only the create saved during that call. Only when another Task's create log is read within the same few seconds as that create is it wrongly attached to this Task. A filing that is not sent yet and has no number does not appear until a number is assigned

## Why the Project's Status history is not used

The change times of the Project's Status are not used for the stage boundaries. An Issue whose Status was changed through the API leaves no `ProjectV2ItemStatusChangedEvent` at all in its timeline. The Status in this repository is changed by workers through the API, so the history cannot be relied on. No mechanism to record Status ourselves is added either (the stages can be split by the times of the marks the skills leave).

## Usage

```bash
bun scripts/flow-report.ts [--days 30] [--repo <owner/name>] [--json <file>]   # 形
W=$(mktemp -d /tmp/switchboard.flow.XXXXXX); bun scripts/flow-report.ts --days 30 --json "$W/flow.json"   # そのまま回せる例
```

- It reads the PBIs (`type:pbi`) closed in the period from the app's stored values (`readRecords`, the same as `ops-kit lint`; it runs only inside an app Task and only when `BACKLOG_URL` is set; with none, unreachable, or before the import, it prints the reason and exits 2). Merged PRs are read from GitHub. The repository to read PRs from is `--repo`; if none, the backlog's repository; for an app-only backlog, the cwd's `origin` (the same `prRepoOf` as the screen; with none of these, it reads no PRs and the PR stages are unknown). The workspace whose stored values are read is chosen the same way as `ops-kit lint` (`--repo` if given, otherwise `GH_REPO`, then `BACKLOG_WORKSPACE` (an app-only backlog), then `origin`)
- There are 4 tables. The first is "median / p90 / count" per stage (unknown ones are not counted), plus the number of PBIs closed in the period, the sum of Story Points and the stage with the largest median. The second is, per PBI, "each stage / waiting for a reply / review rounds / Tasks / cost". `--json` holds `stages` (p50 / p90 / count per stage), `pbis`, `cutPbis` and others
- **Switchboard's Tasks**: from the DB (`switchboard.db` in `SWITCHBOARD_HOME`, read-only), among the Tasks of the workspace whose stored values were read, it counts those that are process Tasks (`stage_issue` is the number of a PBI or a Task) or whose title begins with `#<the number of a PBI or a Task> `. Count, running time (from creation to the last event; the same as `routingLog`) and cost (the total of the ledger). Issue numbers overlap across repositories, so it narrows by workspace. When there is no DB, the Task columns are not printed. For each PBI it also counts how many times an implementation (`stage_action` is `complete`; a resume counts once) was launched among the process Tasks with that PBI number (`pbis[].tasks.implementLaunches` in `--json`), and prints 2 lines after the table: `実装を 3 回以上起動した PBI: <n>/<number of PBIs whose Tasks could be read>（<%>）` (`不明` when no PBI could be read) and `段 wait の中央値`. These are the numbers for seeing whether the improvement to the wait (resuming implementation once the other PBI's merge is in) worked
- The 3rd table is, per week, `PBI 起票 / PBI 閉鎖 / 要望 起票 / 要望 閉鎖 / 純増 / 先送り Task / そこからの起票` ("Backlog net growth and deferrals" above). When there is no DB, the two deferral columns are `-`. `weeks` in `--json`
- The 4th table is the actuals per Story Points: `SP / 件数 / Task の数 / 費用 / 稼働時間` (`actualsByStoryPoints`; smaller SP first; PBIs without SP are not included). Task count, cost and running time are p50 (p25 to p75) (p25 and p75 are nearest-rank). Task count = the number of the PBI's Task Issues (sub-issues) (`pbis[].taskIssues`; if the list was cut it shows fewer; Tasks closed after being withdrawn also count), cost and running time = the total of Switchboard's Tasks (`tasks` above); a PBI whose DB cannot be read is not included in cost and running time. `bySp` in `--json`. It is not shown on `GET /api/flow` or on the screen
- To get the table for your own repository, run `bun scripts/flow-report.ts --days 30` inside an app Task that looks at that clone, and it comes out first
- How to read it is in "How to read the numbers" below

### GraphQL consumption and when it stops

GitHub's GraphQL allows 5,000 points per hour, shared by all of the host's Tasks. The thresholds below are the constants `MIN_REMAINING` (the least budget that lets a run start) and `MAX_COST` (the most points one run may spend), and the comments read per PR are `COMMENTS_MAX`, all in `packages/core/src/flow.ts`; the values are read there.

- At the start of a run it reads the remaining points, and **if fewer than `MIN_REMAINING` remain, it reads nothing, prints the reason and stops** (exit 1)
- Only merged PRs are read from GitHub (`fetchMergedPrs`). Of the PBIs closed in the period, it reads the PRs merged after the creation date of the oldest PBI, one search page at a time (`PR_QUERY`), up to `COMMENTS_MAX` comments. When no PBI was closed in the period, it does not read GitHub. **If one run is likely to exceed `MAX_COST` points, it stops before calling**
- Limit: for a PBI that has a PR with more than `COMMENTS_MAX` comments, the number of reviews comes out low. It is marked with `*` in the table, and the numbers are printed in `cutPbis`. Issue comments are stored values, so only what the import read
- GitHub sometimes returns HTTP 504 (it only reads, so re-running after a few seconds is fine)

## The Backlog screen and `/api/flow`

At the very bottom of the Backlog screen there is a section `流れ（直近 30 日）` (no new screen, tab or chart is added). The point is that even in an environment where commands cannot be typed, you can notice the stuck stage and decide which stage to act on.

- **What it shows**: per stage, the median, the p90, the median of the previous 30 days and the change (7 rows); the number of PBIs closed in the period and their Story Points; the stage with the largest median; and the 5 PBIs with the longest sum of stages (pressing one opens the GitHub Issue). A stage that became 20% or more slower is red, and one that became 20% or more faster is green. A stage that is unknown in either period shows "—" and no change (it is not written as 0 either)
- **`GET /api/flow`**: it `summarize`s the PBIs closed in the last 30 days and the 30 days before that, from the stored values of all registered workspaces, and returns them (`flowView`. Issues are the stored values, PRs come from GitHub. For an app-only backlog it reads the PRs of the GitHub repository of the checkout's `origin`; with none, it reads no PRs and the PR stages are unknown). It can be viewed outside a Task. It stores nothing. A workspace that has never been imported has nowhere to read from, so it is not counted and its name is put in `unread` (the section shows `取り込み前で、数に入っていません`)
- **`weeks`**: the weekly filed / closed / net growth and the deferred counts of the last 30 days (the total over all repositories). Counted the same way as flow-report's weekly table (the number of Tasks covers only the workspace whose stored values flow-report read), and not shown on the screen
- **1-hour cache**: the result is held in the daemon's memory for 1 hour, and during that time GitHub's PRs are not read. A result with a repository that could not be read (`errors` is not empty) is not kept, and is read again the next time it is opened. It is read again with `?refresh=1` (the screen's `読み直す`)
- **When it cannot read**: when the GitHub API's remaining points are few (under `MIN_REMAINING`), the run would exceed the limit, or `gh` fails, the reason goes into that workspace's `errors` and the other repositories are returned. The section shows a line with the reason, and the Backlog list is read separately from the flow, so it appears as before

## How to read the numbers

- **Do not make it a goal, do not compare with others.** As DORA warns, making numbers a goal distorts the agents' behavior. What to look at is your own before and after (the median and p90 before and after acting) and which stage is large
- The median is the typical case, and the p90 is the ones that dragged on. The size of a stage is a clue to "where it got stuck"; the cause is decided by reading the PBI's Issue
- Waiting for a reply is the total over the whole PBI, and it does not say at which stage the waiting happened (it is not a breakdown of the stages). Do not decide that a stage is large because of waiting for a reply. It is added per Issue, so time that overlapped across separate Issues is counted twice. Check what is inside the stage in the PBI's Issue comments
- Do not trust the median of a stage with a small count or many unknowns (a PBI whose marks were not left becomes unknown)
- Only PBIs closed in the period are counted. For what is stuck now, look at `止まっている` on the Backlog screen

## The improvement loop

How to run it (pick the stage that takes the most time and raise a request for improvement, then check whether the previous request worked by the medians before and after) is in the skill `.claude/skills/flow-loop/SKILL.md`.
