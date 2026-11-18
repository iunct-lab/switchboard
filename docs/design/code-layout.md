# Where new code goes

One feature's change should touch that feature's files. The daemon's code, the shared types and the screen's API calls are cut by feature for that reason, and a new route, type, query, migration, function or test goes to the file of its feature, not to a file that many features share. This document is the rule; `CLAUDE.md` points here.

## The limit

Under `packages/core/src`, `packages/protocol/src` and `apps/web/src`, a source file has at most 1,000 lines and a test file (`*.test.ts`, `*.test.tsx`) at most 2,000. `bun scripts/file-size.ts` checks it and is a step of the CI (`scripts/ci.ts`), so a file over its limit fails the CI. `STILL_OVER` in that script lists the files that were over the limit when the check was added, each with its line count as its ceiling. The check holds the ceilings down: a listed file has exactly its ceiling's lines (a file that shrank fails until its ceiling is lowered to the new count), and the list is compared with the base ref's (`origin/main`, or `FILE_SIZE_BASE_REF`), where an added entry or a raised ceiling fails. A run that cannot read the base's list (a checkout with no history) says so in one line and does not compare. When a file comes near its limit, move one concern of it to a new file beside it: do not grow a file that holds several features.

## Where each kind of thing goes

| What you add | Where it goes | What else changes |
|---|---|---|
| An API route | `packages/core/src/routes/<group>.ts`, where `<group>` is the path's first word after `/api/` (`/api/schedules/…` is in `routes/schedules.ts`). A group's routes are in that one file only | Nothing for a route of a group that exists. A new group is a new file that exports `<group>Routes(sc)`, and one line in the list of groups in `startServer` (`packages/core/src/server.ts`) |
| The screen's call of that route | A file of `apps/web/src/api/`. The files there are fewer than the route groups: one holds the calls of the groups the screen uses together. `artifacts.ts` holds `artifacts`, `attachments` and `reports`; `asks.ts` holds `approvals`, `asks` and `policies`; `daemon.ts` holds `daemon`, `github`, `health` and `runners`; `insights.ts` holds `balance`, `flow`, `interventions` and `sources`; `knowledge.ts` holds `knowledge` and `materialize`; `ops.ts` holds `ops` and `perf`; `settings.ts` holds `custom-runners` and `settings`; `tasks.ts` holds `queue` and `tasks`; `workspaces.ts` holds `new-repo` and `workspaces`; each other file holds the one group of its name. A call goes into the file that holds its route's group; a group that none holds gets a new file of its name | A new file: one line in `apps/web/src/api/index.ts` |
| A type or zod schema shared by the daemon and the screen | `packages/protocol/src/model/<feature>.ts`. Importers read it from the entry point `@switchboard/protocol`, never from the file | A new file: one `export * from "./model/<feature>.ts"` line in `packages/protocol/src/index.ts`. The files under `model/` do not import each other in a cycle |
| A database query | A method in `packages/core/src/db/<feature>.ts`. Callers reach it as `db.<method>()` | Nothing for a feature that has a file. A new feature file is a class that extends the last class of the chain, and `Db` in `packages/core/src/db.ts` then extends the new class |
| A migration | A new file `packages/core/src/db/migrations/NNNN-<name>.ts` with the next number. One migration per file; what a migration that already ran does is not changed | Its import and its line in `packages/core/src/db/migrations/index.ts`. A new table or column is also written in `packages/core/src/db/schema.ts` and in `packages/core/src/schema-baseline.json`. Two migrations with the same number fail `packages/core/src/db.test.ts` (`-t "migration numbers"`) |
| A function of a feature that needs nothing of the running daemon | The feature's module in `packages/core/src/`, by concern (below) | Nothing |
| A function of a feature that reads the running daemon's state (the database handle, the Task manager, the settings, other such functions) | `packages/core/src/server/<feature>.ts`, as `export const <name> = (sc: Pick<ServerContext, …>, …) => …`: it takes only the fields it reads, so a test calls it without starting a daemon | Its type in `ServerContext` (`packages/core/src/server/context.ts`). A new module is also one line in `packages/core/src/server/bind.ts`. A step that runs when the daemon starts is a `setup…(sc)` function in the same module, called from `startServer` |
| A method of the Task manager | The part of the chain of classes it belongs to, under `packages/core/src/tasks/` (below) | Nothing, unless an earlier part of the chain calls it: then an `abstract` declaration in that earlier part |
| A test | Beside the source, with the source's name: `<name>.test.ts` for a function, `<group>.api.test.ts` for a test that starts the daemon and calls its API. A function under `server/` is tested without a daemon (the form of `packages/core/src/server/without-server.test.ts`) | The shared setup of the API tests is `packages/core/src/api-test-harness.ts`: add to it only what two or more test files use |

`startServer` only puts the pieces together: it has no route and no feature's function inside it.

## The backlog's files

The backlog's functions are one file per concern, `packages/core/src/backlog-<concern>.ts`:

| File | Concern |
|---|---|
| `backlog-gh.ts` | The `gh` runner and its errors, the repository and Project of a checkout, GitHub's API budget, which backlog a workspace has |
| `backlog-item.ts` | What one Issue's body, labels and Project fields say; its stage, action and slot; the item the screens read |
| `backlog-comments.ts` | What an Issue's comments say: the question, answer, hold and report headings, and the marks the stage Tasks leave |
| `backlog-prompt.ts` | The request texts a stage Task is started with |
| `backlog-pick.ts` | Which item is started next, and why each of the others is not |
| `backlog-overlap.ts` | Two items whose Tasks name the same files: whose turn it is |
| `backlog-waits.ts` | What an item waits for: prerequisites, other Issues and pull requests, confirmations |
| `backlog-edit.ts` | The edits made here and sent later: create, edit, comment, answer, hold |
| `backlog-stored.ts` | Reading the stored backlog for the screens, the scheduler and the kit's tools |
| `backlog-fetch.ts`, `backlog-sync.ts`, `backlog-send.ts` | Reading GitHub, storing what was read and deciding when to read again, sending the edits |
| `backlog-local.ts`, `backlog-enable.ts`, `backlog-merge.ts`, `backlog-queue.ts`, `backlog-replica.ts`, `backlog-upbox.ts` | A backlog kept here only, turning the GitHub sync on, how an edit stands against GitHub's value, the queue of chosen items, the copy on a work machine and its edits |
| `promotion.ts` | Which release the daemon is promoted to before the next item starts |

A new concern is a new `backlog-<concern>.ts`. There is no file that collects them: an importer names the file that holds what it reads.

## The Task manager's files

`TaskManager` is a chain of classes, one file per part, each extending the one before it: `tasks/state.ts` (the options, the live sessions, the listeners) → `tasks/events.ts` (the runner's events, the stops, the status transitions) → `tasks/sessions.ts` (starting a runner process) → `tasks/admission.ts` (the queue and the slots) → `tasks/sending.ts` (a prompt or a reply on its way to a Task) → `tasks/settings.ts` (what the person changes on a Task) → `tasks/manager.ts` (`TaskManager`: making, forking, aborting, shutting down). A part calls the parts before it directly. A member that another part reads is `protected`, not `private`.

## What stays shared

A few files are still touched by many features, one line at a time: the list of groups in `server.ts`, `server/context.ts`, `packages/protocol/src/index.ts`, `db/migrations/index.ts`, `db/schema.ts` with `schema-baseline.json`, and `api-test-harness.ts`. Keep a change to them to the lines the feature needs. The ones that two pieces of work may change side by side without waiting for each other are `sharedFiles` in `ops.config.json` (the "Shared files" item of `docs/merge-gate.md`).
