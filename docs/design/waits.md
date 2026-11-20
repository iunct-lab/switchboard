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
| `kind` | `command`, `output`, `person`, `resume`, `depends`, `job`, `date`, `queue`, `stop` |
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
  limit comes first. The tooltip lists every wait. The list uses the short form (`待ち 3/30 分`). A planned resume within
  its time keeps its own tag; the person's own waits are shown where they are answered.
- **The asks screen** lists every wait over its limit that is not already the person's to end, and every silent
  runner, as a question for the person (`待ちが上限を過ぎた: …` / `応答なし: …`), with a link to the Task. Nothing is
  stopped: a silent Task may be working, and killing it is the person's call. The question goes away when the wait
  ends or the runner speaks again — the next event clears the silence at once, not at the next look.

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
- Nothing forbids a Task from writing a bare loop; the skills and prompts tell it to use `ops-kit wait`.
- The person's own waits have a limit in the record but are not asked about again when it passes: they are already
  where the person answers.
