# How far a PBI is: one function, one table

Several places need to know how far a PBI is: the asks screen (is this user check asked now, does answering it let
other work go on), the Backlog screen (can the row be closed), the scheduled run that moves the backlog on (close it,
leave it to the person, or count it as a met prerequisite) and the parallel guard that a Task runs before it starts
(is the prerequisite met). They used to each write the rule out, and a rule added in one place disagreed with the
others: a PBI with open Tasks showed its user check with "answering lets 2 more go on", although answering changed nothing.

`pbiProgress` in [`packages/core/src/pbi-progress.ts`](../../packages/core/src/pbi-progress.ts) is the one place that
decides. It is a pure function: the same facts give the same answers. Callers read facts (`pbiFactsOf` in
[`backlog-item.ts`](../../packages/core/src/backlog-item.ts) reads them from a PBI's labels, body, Status and Tasks) and use the
answers; none of them compares Task counts or counts confirmation lines itself. A test keeps it so: outside
`pbi-progress.ts` and a short allow list, no source file may compare a PBI's closed Tasks with its total.

## Facts (input)

| Column | Meaning |
|---|---|
| `pbi` | The Issue is a PBI (`type:pbi`). A request has no progress. |
| `decision` | An open question holds it: the `needs-decision` label, or a question of one of its Tasks. |
| `status` | The Project's Status. `-` = not read: the parallel guard does not read the Project. |
| `tasks` | Closed Tasks / all Tasks. A Task that was not read counts as open. |
| `others` | Unchecked acceptance criteria that are not user checks. |
| `confirms` | The numbers of the unchecked user-check lines (`（利用者確認: …）`), including dated ones and ones checked by a decision's answer. |
| `decided` | The lines among `confirms` that name decisions which are all stored: the decisions' own cards ask, not the user check. |
| `held` | One of those decisions is still open. |

## Answers (output)

| Column | Meaning | Read by |
|---|---|---|
| `asked` | The user-check lines asked now. None while a Task is open: what is not built cannot be checked, and pressing "confirmed" would tick a criterion nobody verified. | `BacklogItem.confirmations`: the asks screen, the Backlog row, the answer route |
| `closableByApi` | Built (In progress / In review, no open question) and every Task closed. The API accepts `close`, user checks left or not. | `BacklogItem.progress.closableByApi`: the start route, the "user checks only" line of the log |
| `closable` | `closableByApi`, nothing left to ask, and no named decision open. | `BacklogItem.closable`: the row's close button, the scheduled run's close, what an answer starts |
| `prereqMet` | Every Task closed (at least one), no open question, and the only unchecked criteria are user checks (at least one). The PBI waits for the person, not for more work, so a PBI that names it as a prerequisite goes on. Status is not looked at. | prerequisites in the app (`prereqOf`) and in the parallel guard |
| `closesOnAnswer` | The one line whose answer closes the PBI: `closableByApi`, no named decision open, and exactly one line asked. `-` = no answer closes it. | `rankAsks`: "answering lets N more go on" is shown only on that line's question; every other question lists the PBIs as waiting for this PBI to be done |

A date a line waits for (`期日 … 以降`) is not in the table: it changes with the clock, so the asks screen reads it when it
builds the questions. A dated line still counts in `asked`.

## The table

Each row is a combination of facts and the answers it must give. `packages/core/src/pbi-progress.test.ts` reads this
table and checks every row against `pbiProgress`; `scripts/parallel-guard.test.ts` reads the same rows for the guard.
**To add or change a rule, add or change a row here first** — the test fails until the function agrees — and do not
write the rule at a caller.

Notation: `yes` / `no`; `tasks` is closed/total; a list of line numbers is comma-separated; `-` is an empty list, a
Status that was not read, or no line.

| Row | pbi | decision | status | tasks | others | confirms | decided | held | asked | closableByApi | closable | prereqMet | closesOnAnswer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a request | no | no | - | 0/0 | 0 | - | - | no | - | no | no | no | - |
| not a PBI, though it looks done | no | no | - | 2/2 | 0 | 5 | - | no | - | no | no | no | - |
| Ready, nothing built | yes | no | Ready | 0/3 | 2 | 5 | - | no | - | no | no | no | - |
| Ready, yet only user checks left | yes | no | Ready | 2/2 | 0 | 5 | - | no | - | no | no | yes | - |
| In progress, a Task open | yes | no | In progress | 1/3 | 0 | 5 | - | no | - | no | no | no | - |
| In review, a Task open | yes | no | In review | 2/3 | 0 | 5 | - | no | - | no | no | no | - |
| In progress, no Tasks at all | yes | no | In progress | 0/0 | 0 | 5 | - | no | 5 | no | no | no | - |
| all closed, two user checks | yes | no | In progress | 3/3 | 0 | 5, 6 | - | no | 5, 6 | yes | no | yes | - |
| all closed, the last user check | yes | no | In progress | 3/3 | 0 | 5 | - | no | 5 | yes | no | yes | 5 |
| In review, the last user check | yes | no | In review | 3/3 | 0 | 5 | - | no | 5 | yes | no | yes | 5 |
| all closed, nothing unchecked | yes | no | In progress | 3/3 | 0 | - | - | no | - | yes | yes | no | - |
| all closed, only other criteria unchecked | yes | no | In progress | 3/3 | 1 | - | - | no | - | yes | yes | no | - |
| a user check and another criterion | yes | no | In progress | 3/3 | 1 | 5 | - | no | 5 | yes | no | no | 5 |
| an open question, only user checks left | yes | yes | In progress | 3/3 | 0 | 5 | - | no | 5 | no | no | no | - |
| one of two lines decided, its decision open | yes | no | In progress | 3/3 | 0 | 5, 6 | 6 | yes | 5 | yes | no | yes | - |
| one of two lines decided, its decision answered | yes | no | In progress | 3/3 | 0 | 5, 6 | 6 | no | 5 | yes | no | yes | 5 |
| every line decided, a decision open | yes | no | In progress | 3/3 | 0 | 5 | 5 | yes | - | yes | no | yes | - |
| every line decided and answered | yes | no | In progress | 3/3 | 0 | 5 | 5 | no | - | yes | yes | yes | - |
| guard: only user checks left | yes | no | - | 3/3 | 0 | 5, 6 | - | no | - | no | no | yes | - |
| guard: a Task open | yes | no | - | 2/3 | 0 | 5 | - | no | - | no | no | no | - |
| guard: no Tasks | yes | no | - | 0/0 | 0 | 5 | - | no | - | no | no | no | - |
| guard: another criterion unchecked | yes | no | - | 3/3 | 1 | 5 | - | no | - | no | no | no | - |
| guard: nothing unchecked | yes | no | - | 3/3 | 0 | - | - | no | - | no | no | no | - |
| guard: an open question | yes | yes | - | 3/3 | 0 | 5 | - | no | - | no | no | no | - |

## What is not decided here

- Whether a prerequisite that is an Issue or a pull request is closed, merged, withdrawn or released: `prereqState` in
  `backlog-waits.ts`. `prereqOf` puts the two together (a prerequisite still open counts as met when `prereqMet`), and both
  the app and the parallel guard call it.
- A Task's own status and outcome: [`task-work-phase.md`](task-work-phase.md).
- Whether the scheduled run starts something on the PBI (replies awaited, stops, overlaps, shares): `pickNext` in `backlog-pick.ts`.
