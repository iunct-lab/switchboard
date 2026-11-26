# Waits: one record, one limit, one look

A Task waits for many things: a command it loops on, its runner's next output, the person, a usage limit, a pull request
or an Issue of other work, a job it asked the daemon for, a date, a run slot, a promotion that holds new turns back.
Each of these had its own place and its own (or no) limit, and the screen said "running in the background" with an
elapsed time for all of them. A Task that waited for something that would never come looked the same as one at work,
and the person found out by asking.

Now every wait is one record with a mandatory limit, one look goes over all of them, and a wait past its limit — or a
runner that has gone silent — shows up by itself where the person already looks.

## The record

`WaitRecord` in [`packages/protocol/src/model/waits.ts`](../../packages/protocol/src/model/waits.ts):

| Field | Meaning |
|---|---|
| `kind` | `command`, `output`, `hook`, `person`, `resume`, `depends`, `job`, `date`, `queue`, `stop` |
| `key` | Tells the Task's waits apart (`pr#12`, `resume`, `command:<pid>`) |
| `label` | What is waited for, as shown |
| `since` | When the wait began |
| `until` | The limit. There is no wait without one |
| `progressAt`, `stallSec` | A command wait that watches the other side's progress |

`waitOver(w, now)` is the one check of every kind: `now >= w.until`.

A wait is not created by a new mechanism. `waitsOf` in [`packages/core/src/waits.ts`](../../packages/core/src/waits.ts)
reads it from where it already is, and gives it a limit:

| What the Task waits for | Read from | `kind` | Limit (`until`) |
|---|---|---|---|
| A command that checks until something is done | the `ops-kit wait` record file | `command` | the command's own `--timeout` |
| The runner's next event, in a turn or on its background jobs | the attached runner's last event | `output` | last event + silence limit |
| A hook the runner runs, while its heartbeats come | the attached runner's last heartbeat | `hook` | last heartbeat + silence limit |
| An approval, or a turn that ended needing the person | the Task's status and outcome | `person` | start + limit for others' work |
| A usage limit, GitHub's API limit, a full disk, a cut turn | the Task's planned resume (`resumeAt`) | `resume` | the planned time + grace |
| A run slot, memory, a promotion letting turns start again; for a queued reply refused at the start (budget, a Teleport Terminal on its folder), that refusal | the Task's place in the queue (`queuedAt`), and the refusal last written for it | `queue` | start + limit for own work |
| A pull request or an Issue | an unmet `pr#N` / `issue#N` condition of an open stop | `depends` | stop + limit for others' work |
| A job the daemon runs for the Task | an unmet `job#N` condition | `job` | stop + limit for own work |
| A date | an unmet `after` condition | `date` | the date + grace |
| Another runner's usage limit | an unmet `runner#<runner>` condition | `resume` | its time + grace |
| Any other condition, or a `depends` stop that names nothing | the open stop | `stop` | stop + limit for others' work |

The conditions of stops are read only for a Task that stopped on them: its stored outcome is `waits` or
`needs_action`, the person has not reviewed it, and no later stage Task of its Issue has taken the work over. Such a
Task enters the look while the daemon still resumes it (seven days after its last change); once a wait of it is
stored it stays in the look until that wait ends, so a wait the daemon has given up resuming stays on the screen
instead of dropping out unseen. Tasks that stopped longer ago than that, before this existed, are not dug up. A daemon
start keeps the stored waits and clears only the runners' silences (the runners went with the old daemon). Who resumes what when a condition is met is unchanged
(`resumeDepends` in `packages/core/src/depends-resume.ts`); this file only adds the limit and the view.

## The limits

How long is too long depends on the machine and the work, so the limits are settings (`quotaAndResume`, on the
settings screen) with safe defaults:

| Setting | Default | Used for |
|---|---|---|
| `silentAfterMs` | 10 minutes | the runner's silence |
| `waitLimitMs` | 6 hours | what this machine does itself: a job, a run slot |
| `dependsLimitMs` | 3 days | someone else's work: a pull request, an Issue, the person, another condition |

The grace after a planned resume or a date is derived, not set: six of the daemon's looks for due dates (30 minutes),
after which a resume that has not happened is not on its way any more.

## The look

`checkWaits` runs every 30 seconds in the daemon. One pass:

1. Each `ops-kit wait` that was cut since the last look becomes a stop of its Task (below).
2. For each Task that can have a wait (an attached runner, a wait record file, a planned resume, a place in the queue,
   an open approval, a stop it stopped on, or waits stored before), `waitsOf` works its waits out again. The list is
   stored on the Task (`Task.waits`) when it changed, and the screens are told (`task.updated`). The runner's output is
   stored only once it is over its limit: a runner that keeps talking is not a wait worth a row.

Because the list is the Task's own field, the Task list, the Task's header, and the asks screen read the same thing,
and no screen works a wait out by itself.

## What the person sees

- **The Task list and the Task's header** show one tag (`WaitTag`): `応答なし 12 分` for a silent runner, else
  `待ち超過: <what> 40 分 / 上限 30 分` for a wait over its limit, else `待ち: <what> 3 分 / 上限 30 分` for the wait whose
  limit comes first. While a hook runs and its heartbeats keep arriving, the tag is `hook 実行中 12 分` instead (not red, never
  over its limit; the tooltip names the hook, when it began and the last heartbeat); once the heartbeats stop for the
  silence limit it is `応答なし` again. The tooltip lists every wait. The list uses the
  short form (`待ち 3/30 分`). A planned resume within
  its time keeps its own tag; the person's own waits are shown where they are answered.
- **The asks screen** lists every wait over its limit that is not already the person's to end, and every silent
  runner, as a question for the person (`待ちが上限を過ぎた: …` / `応答なし: …`), with a link to the Task. Nothing is
  stopped: a silent Task may be working, and killing it is the person's call. The question goes away when the wait
  ends or the runner speaks again — the next event clears the silence at once, not at the next look.

### A wait past its limit whose other side has ended

The question carries which wait it is about (`Ask.wait`: the wait's `kind` and `key`); nothing reads it back out of
the question's id. With that, the asks screen takes the question off by itself — `resolved`, with what ended as the
reason, shown for a day — when what the Task waited for is over, the same way it does for any question whose target
is gone (`withGone` in `packages/core/src/asks.ts`). This holds for the waits of a Task that is not at work (`depends`,
`job`, `date`, `stop`, `resume`): a wait of a turn that still runs (`command`, `output`, `queue`, `person`) is that
turn's own, and a closed Issue or a later run does not end it. Four things are looked at, in this order:

1. The Issue the Task works on as a stage Task is closed.
2. The wait's key is `pr#N` or `issue#N`, and that pull request is merged or closed, or that Issue is closed.
3. The wait's key is `job#N`, and that job has ended, however it ended.
4. The Task is a run of a schedule (and not a stage Task), and a later run of the same schedule has finished. While
   the later run is still going, the question stays.

A key of any other form — a tag, a commit, a CI run, whatever a Task wrote as its own condition — is not read: there
is no rule for when it is over, and the question stays for the person. Only the question changes. The stored waits
(`Task.waits`) and the tag on the Task list are left as they are.

### Answering a wait past its limit

A wait that comes from a stop of a Task whose turn is over — a pull request or an Issue, a job, a date, another
runner's limit, any other condition of the stop — is answered on the asks screen with one of two choices, through the
same `POST /api/asks/answer` as every other question:

- `止める` resolves the Task's open stops that make that wait, and leaves `利用者が止めた: <key>` in their actions.
  With no open stop the wait is gone, and so is the automatic resume: `resumeDepends` reads open stops only, so the
  Task does not start again when the pull request, Issue or job ends later. Marking the Task reviewed would not do
  this — the resume does not look at that mark.
  When that was the Task's last open stop, its `outcome` goes from `waits` to `finished`. A stop that makes several
  waits ends for all of them at once, so the question of each other wait of that stop is answered too: `止める` on it
  returns 200 with `already: true` and no question, not 409, and a wait's answer never carries a `resume` of the Task.
- `待ち続ける` leaves the stops open and adds `利用者が待ち続けると答えた: <key>` to their actions — written to the
  record only, not as the stop reported again, so nothing that follows a report (a resume planned for another
  runner's limit) runs. `waitsOf` takes
  the later of the time the stop came and the last such action as the wait's `since`, so the limit — the same
  setting, not a new one — counts again from the answer. A wait whose limit is a fixed time (a date, a runner's limit) gets one more limit
  from the answer when that is later than its time, so it is not over again at once. If the wait is still there
  past the new limit, it is asked about again. The Task is resumed as before when the other side ends.

No reply is sent to the Task, and the answer is never saved as a policy: it is a judgement for that one time. Right
after the answer the Task's waits are worked out again (`refreshTaskWaits`, the same step the look runs for each
Task), so the question leaves the open ones at once instead of at the next look.

Which stops make a wait is decided where the wait's key is made: one function in `packages/core/src/waits.ts` turns an
open stop into its waits, and both `waitsOf` (the record) and `stopsOfWait` (the stops an answer moves) read it, so a
key always leads back to the stops it came from.

A wait of a Task that is at work — a command, the runner's output, a run slot — and a planned resume take no answer
there. Ending one means cutting the turn, which stays the person's call in the Task itself.

A Task that keeps giving events through a long turn is never silent. A Task that is quiet because it runs an
`ops-kit wait` is not silent either while that wait is within its limit: the wait says what the quiet is for.

## `ops-kit wait`

The shared kit's command is the one way a Task waits on a check:

```
ops-kit wait --for <what> --timeout <seconds> --on-timeout <fail|proceed> [--interval <seconds>] [--progress <command> --stall <seconds>] -- <check command…>
```

What is waited for, the limit, and what a cut does are required; without them the command does not run. A wait for a
person's answer or for someone's leave — `--for` names an answer, an approval, a confirmation, a review, a merge or a
promotion (`waitsOnPerson` in `ops-kit/src/wait.ts`) — takes `--on-timeout fail` only: `proceed` is refused as a usage
error, so a wait that runs out never stands in for the answer. The check is by the words of `--for`; a wait described in
other words is not caught by it. The check
is run every `--interval` seconds (5 by default) until it exits 0. A check that hangs is cut at the limit too. With
`--progress`, the wait is cut before its limit once that command's output has not changed for `--stall` seconds: when
the other side is stuck, waiting to the limit only lines more waits up behind it. `fail` exits 124, `proceed` exits 0;
both write the reason to stderr.

The app that starts a Task gives it `OPS_KIT_WAITS_DIR` and `OPS_KIT_TASK_ID`. With both, the command keeps a record
file there while it waits (`<task>-<pid>.json`), which is how the wait reaches the screens. The kit names no app, and
outside a Task nothing is written. A record whose command is gone is removed at the next look.

### A cut wait

A wait cut with `fail` leaves its record behind with the reason. The look turns it into a `stop.record` of the Task
(`op: wait`, the label as the target, reason `decision`), so the Task is listed on the asks screen with the reason, and
the Task itself goes on. The record is read from the file, not from the command's output: a wait started in the
background ends long after the tool call that started it returned.

If the same wait (same work, same label) is cut again and the person has not answered since the last cut, the stop is
recorded as `exhausted`, the turn is stopped, and the Task's conversation says so. A Task does not go back into a wait
it was just cut from without being told to; after the person's reply it may wait once more.

A wait cut with `proceed` is no stop: the caller chose to go on.

## The cap on automatic resumes

A turn cut by the daemon stopping is resumed by the next daemon, up to a number of stops in a row. At the cap the Task
used to be left with a note in its own conversation only. It now also gets a `stop.record` (`op: auto-resume`, reason
`unknown`), so it is asked about on the asks screen like any other stop that needs the person. A stop that asks for a
decision is the person's while its Task's outcome is `needs_action` or `failed`: a turn that was cut with the stop
still asking goes on by nothing but the person.

## What is not done here

- A silent Task is not stopped or killed.
- A wait of a Task at work, or a planned resume, has no answer on the asks screen (above).
- There is no answer that moves the other side on (merging the pull request, closing the Issue): that differs for
  each thing waited for and is decided in the Task's conversation.
- The limit's length is not changed by an answer, and there is no limit per wait: `待ち続ける` starts the same limit again.
- A wait whose key has no fixed form is not taken off by itself when its other side ends.
- Nothing forbids a Task from writing a bare loop; the skills and prompts tell it to use `ops-kit wait`.
- The person's own waits have a limit in the record but are not asked about again when it passes: they are already
  where the person answers.
