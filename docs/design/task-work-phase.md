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

| Phase | dedupe | slot | gate | display |
|---|---|---|---|---|
| `turn` | yes | yes | yes | yes |
| `approval` | yes | yes | yes | yes |
| `background` | yes | yes | yes | yes |
| `resume` | yes | no | no | no |
| `stopped` | no | no | no | no |

- dedupe: do not start a second Task for the same item.
- slot: the queue and the backlog sweep's capacity.
- gate: promotion and restart wait for no one.
- display: lists and badges that show what is moving.

## The `background` status

A turn that ends on background jobs moves to `background` instead of `done`. It is not terminal: it can go back to `running` (a new turn), and moves to `done` when the jobs are all over, or to `error` / `aborted`. `running` and `waiting` can move to it, and so can a `done` Task whose background mark arrives after its turn ended. A turn that ended in `error` or `aborted` stays so even if jobs remain. The outcome is left as it is on this status.

## Migration

Once, rows with status `done` and a background mark become `background`. There is no layer that reads the old form.
