# Task fork: branch a Task from a past turn

A fork is a new Task that continues another Task's conversation up to a finished turn and then goes its own way. The parent is left as it is, so two lines of work can start from the same point and be compared. This page covers the relation, how a fork is made, what its first reply does, when it is not offered, and why the working tree is not split.

## Relation

The relation is three columns on `tasks`, written once when the fork is made and never changed (the same shape as `shadow_of`). No new table.

| Column / field | Meaning |
|---|---|
| `fork_of` / `Task.forkOf` | The parent Task's id; null = not a fork |
| `fork_seq` / `Task.forkSeq` | The seq of the parent's `session.end` event the branch was taken at |
| `fork_turn` / `Task.forkTurn` | That event's `turn`: the runner's own pointer to the turn (Claude's transcript uuid) |

`forksOf(parentId)` in `db.ts` lists the children. `GET /api/tasks/:id` returns the three fields like any other.

## Making a fork

`POST /api/tasks/:id/fork` with `{"seq": <n>}` answers 201 with the child Task, or 400 with the reason. 404 means the parent does not exist.

The child copies the parent's Workspace, cwd, scope, runner, model, permission mode, effort and budget. Its title is the parent's title plus `（分岐）`. It is `idle` with no `runnerSessionId`, and its first line says it continues the parent's conversation up to the turn it was forked at. Nothing is started and no empty turn is recorded: creating a fork costs nothing until the person replies.

## The first reply

`runnerSessionId` stays null until the child's first start. A start of a Task that has `forkOf` and no session of its own asks the adapter for a new session built from the parent's: `resumeSessionId` is the session the forked turn ran in (the `runnerSessionId` of the parent's last `session.start` before `forkSeq`) and `fork: { turn }` is `forkTurn`. That is not always the parent's current session: a parent that moved to another session later still has its older turns' pointers in the old one. The adapter reports the new session's id as usual, the child keeps it, and every later turn of the child resumes that session plainly. The parent's session is not touched, so the parent's next reply resumes it as before, with no `fork`.

If the parent's session is not on this machine (a Task that came from another machine without its session record), the start fails with a message on the child. It never starts a new, empty session in its place, because that would look like a continuation and not be one.

## When a fork is refused

`POST /api/tasks/:id/fork` answers 400 when:

- the runner cannot fork: `RunnerInfo.forks` is false. It is true when the adapter declares `forks` and the detected CLI version is at least its `forkMinVersion`. The screen offers no fork button for such a runner;
- the Task is a Cloud Task, which is operated on the provider's web;
- the event at `seq` is not a `session.end`, ended in `error` or `aborted`, or has no `turn` (a record from before the pointer was kept);
- the session the turn ran in is not recorded, or is not on this machine.

## Why the working tree is shared

The child works in the parent's directory. Splitting the tree (a worktree per fork) would have to decide what to do with the parent's uncommitted changes, which branch the child's commits belong to, and when to clean up, none of which the person asked for. The child's first line says the files are shared, and the person can start the child in a worktree of their own by asking in its first reply. A change the child makes in the shared tree is visible to the parent, and the other way round.

## On the screen

No new screen. The Task screen and its Brief get three small additions, all drawn from what the page already holds.

- **A button on a turn's end row.** The end row of a finished turn gets `ここから分岐`. It is offered when the turn ended `ok` and carries its `turn` pointer, the Task is not a Cloud Task, and the Task's runner reports `forks` in `RunnerInfo` (`canFork` in `apps/web/src/fork.ts`). The daemon refuses the same cases, so the button is not a guard, only a way of not offering what would fail. Pressing it sends the row's `session.end` seq to `POST /api/tasks/:id/fork` and opens the child.
- **The child's first line.** The child's conversation starts with one line saying it continues the parent's conversation up to the turn it was forked at and that the files are the parent's working tree. It is drawn from the Task's `forkOf`, so it shows before anything has been sent, and only when the oldest events are loaded (not above a later page). It names no turn number: `forkSeq` is an event seq, not a count of turns, and would not match anything the person sees on the parent.
- **Two rows in the Brief, beside the parallel-run row.** `分岐元` opens the Task at `forkOf` and says in its hint that the parent's conversation does not change. `分岐` lists the Tasks whose `forkOf` is this Task, one button each, numbered in the order the forks were made and naming the runner (the child's title is on the button's tooltip). Both read `forkOf`, which the Task list carries (`TaskSummary`), so neither fetches anything. A fork of a fork shows only its own parent and its own forks: one level, not a tree.

A runner that cannot fork (a Codex Task today, DAK, a version below the minimum) gets no button. A fork has its parent's runner, so such a runner's Tasks have no `分岐` row unless the forks were made while the runner could still fork (for example, before the CLI was downgraded below the minimum).
