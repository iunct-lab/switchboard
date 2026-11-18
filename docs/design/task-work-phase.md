# Task work phase

Whether a Task is still at work is decided in one place: `packages/core/src/task-status.ts`. Every count of "working" Tasks (the function `isWorking` and the SQL fragment `workingSql`) reads the same table, so no caller compares status values itself.

## Phases

`workPhase(task)` puts a Task in one of five phases, from its `status` and `resumeAt`.

| Phase | Status | Meaning |
|---|---|---|
| `turn` | `running` | A turn is in progress |
| `approval` | `waiting` | The turn waits for a person's approval |
| `background` | `background` | The turn ended, but the runner still has background jobs (shells, monitors) |
| `resume` | `done` / `error` / `aborted` / `idle` with `resumeAt` set | Stopped with a resume planned, or made without starting (`idle`) with its start planned at the runner's reset |
| `stopped` | everything else, including `idle` without `resumeAt` | Nothing is happening |

`resume` is derived from `resumeAt` and is not a status: `resumeAt` is only ever set on a stopped Task or on one made without starting, and a separate status would add a migration and transitions for no gain.

A Task made without starting is started by the automatic resume at its runner's reset. With the automatic resume of that runner off, it stays held after the reset until a person starts it now or cancels the planned start. Until then its Issue takes no second stage Task, as with any stopped Task whose resume is planned, and its schedule makes no second run (a schedule is held only by a run made without starting, not by a stopped run whose resume is planned).

## What counts as working

`COUNTS` says which phases count for each purpose. The purposes are fixed; they are not a setting.

| Phase | dedupe | slot | gate | display | output |
|---|---|---|---|---|---|
| `turn` | yes | yes | yes | yes | yes |
| `approval` | yes | yes | yes | yes | no |
| `background` | yes | yes | yes | yes | yes |
| `resume` | yes | no | no | no | no |
| `stopped` | no | no | no | no | no |

- dedupe: do not start a second Task for the same item.
- slot: the queue and the backlog sweep's capacity.
- gate: what a promotion or a restart would cut, so both wait for none of these to be left: a turn in progress, a turn stopped on an approval or a question (it is the middle of a turn, and the open approval is lost with it) and a background process. The promotion's hold on new starts (the drain) waits for the same set.
- display: lists and badges that show what is moving.
- output: a runner that is expected to say something (the silence wait of `waits.ts`): a turn in progress and a background process, not an open approval (the person is the one to speak).

## The `background` status

A turn that ends on background jobs moves to `background` instead of `done`. It is not terminal: it can go back to `running` (a new turn), and moves to `done` when the jobs are all over, or to `error` / `aborted`. `running` and `waiting` can move to it, and so can a `done` Task whose background mark arrives after its turn ended. A turn that ended in `error` or `aborted` stays so even if jobs remain. The outcome is left as it is on this status.

Under the admission hold (a promotion waiting), a reply to a `background` Task is not sent: the process keeps its jobs, and the text waits in memory with its status line in the log. When the Task is off its jobs and turns (including a turn the runner starts itself on a job notification), the text is handled as a reply sent at that moment: under the hold the process is closed and the reply goes to the queue (`idle` with `queued_at`) to start after the hold, and a planned automatic resume is dropped. If the hold ends first, the process takes the reply as before. An aborted Task drops the held text (an abort means it does not come back on its own), and so does a daemon stop; a runner that exits by itself passes it on the same way; the daemon is not replaced while the jobs run, because drain waits for them.

## Migration

Once, rows with status `done` and a background mark become `background`. There is no layer that reads the old form.
