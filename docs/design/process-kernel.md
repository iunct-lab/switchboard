# Process kernel — what every development process needs, so that the process itself can change

Switchboard ran one development process for its first two months: request → PBI → Task → PR → review by another runner → merge gate → promotion. It worked as a machine for shipping small, well-specified changes unattended, and it also showed the limits of having exactly one process compiled into the daemon: the shape of the pipeline (five stages, five actions, label names) lives in the protocol, the core, the web UI, the lint, the parallel guard and the skills' prose; a Task records which model it ran on but not which skills, prompts or rules it read; a learning from the owner becomes one more sentence in a skill, and no sentence is ever retired.

The owner's direction for the next major version (2026-11-03) is not a better process but the ability to keep looking for one: several processes may exist at once, a piece of work picks one, the record shows what each produced, a weak one retires, a new one can be written. This document names the **kernel**: the minimum that any process needs and that therefore does not belong to any one of them. The process candidates themselves are data (`ops-kit/processes/`), and the first candidate is the current pipeline, written down without changing a word of what it says to a Task.

The two Japanese concept papers this grew from (the analysis of the first two months and the critique that moved the centre from "the next process" to "the kernel") are kept with the owner's private records, outside the public tree.

## Why a kernel, not a process

Choosing a process is a bet on the kind of work ahead. The pipeline was a good bet for building the daemon; it is a poor fit for reframing a problem or for a one-line fix, and it cannot say so itself. Rather than replace it with the next bet, the kernel makes bets cheap to place and cheap to compare:

- a candidate is a file, not a change to core;
- every Task carries the fingerprint of what ran it, so candidates can be compared on the record;
- outcome signals are collected whatever the candidate;
- what an action does to the world decides whether it may run unattended, not which process asked for it;
- the lines no candidate may cross are written in one place and are not part of any experiment.

Each element below says what it is for, what exists today, and how it is itself revised — the kernel must not become the next fixed thing. The elements change at different speeds (see *Pace layers*).

## K1 Provenance

**For.** Nothing can be compared without knowing what produced it. A Task's record has to say which process definition it was started under and why, which bundle of instructions it could read, and which model and settings ran it.

**Today.** `tasks.model`, `tasks.effort`, `tasks.permission_mode`, the routing log and the per-task rule metrics exist. The skill sync computes a hash of the shared skills every time it places them and keeps it only in the placed copy's marker. Nothing records the process, the reason, the instructions file's version or the amount of instruction text a Task starts with.

**Shape.** One JSON column on `tasks`, written once right after the Task is created; the first implementation reads it at its own route, `GET /api/tasks/:id/provenance` (a choice the kernel's first PBI records in its decision log):

```json
{
  "v": 1,
  "process": { "id": "p0-pipeline", "version": 1 },
  "processReason": "backlog stage complete",
  "bundle": { "skills": "<sha256 of ops-kit/skills>", "repoSkills": "<sha256 of <cwd>/.claude/skills or null>", "claudeMd": "<sha256 of <cwd>/CLAUDE.md or null>", "processes": "<sha256 of ops-kit/processes>" },
  "repo": { "head": "<git HEAD of cwd or null>" },
  "runner": "claude", "model": "…", "effort": null, "permissionMode": "auto",
  "instructionBytes": 123456,
  "recordedAt": 1762200000000
}
```

`process` is null for a Task the owner typed on Home; `processReason` is free text (a stage start writes `backlog stage <action>`). `instructionBytes` is the size of the instruction files in the working directory when the Task is created (the repository's instructions file, its agents file and the skills under `.claude/skills`), a cost line that the ledger does not have. The hashes of the working directory's copies are taken at creation too, before the skill sync refreshes them; the meta source's hash (`skills`) is what the report groups by.

**Revised by.** Dropping any field that no report or query has read; adding one when a comparison needs it. The record is per Task and is not back-filled.

## K2 Outcome

**For.** Whether a change helped cannot be read from the change. It is read from what happened afterwards: cost, time, the owner's interventions, rework, use, the request going quiet.

**Today.** Raw signals are dense: ledger rows, `stop.record` events, the owner's overrides of the turn judge, re-instructions, approvals, the web UI's journey samples, the feedback button, flow stages derived from Issue marks. They are read per Task or per screen; nothing joins them to the process or bundle that produced the work, and the human rating exists per Task, where it is too fine to be given (six ratings against more than a thousand judge rows).

**Shape, first step.** A report (`scripts/kernel-report.ts`) that groups Tasks by their provenance (process id and skills hash) and shows, per group, count, median duration, median cost, median interventions and median instruction size, with the Tasks that have no provenance as their own group, and those recorded without a candidate as another. Each row also splits its Tasks by who chose the process, read from `processReason`: the button (`direct button`, `backlog stage …`), the automatic choice (`auto …`) or a direct Task sent back to the pipeline (`direct returned`), so `p0-pipeline` and `p1-direct` show how they were reached. Observational, with n shown; not a verdict. The human rating moves to the level of a problem, is not scheduled, and is asked only when the system cannot decide and the decision is large.

**Revised by.** Dropping a signal no decision has used; weighting signals by how they track the owner's own judgement where that exists.

## K3 Reversibility

**For.** Replacing approval with rollback is only safe where rollback actually restores the world. Today's gate judges by *file kind* (`PROTECTED`, security words); the kernel judges by *what the operation does* and to whom.

**Shape.** Four kinds of effect — on the repository, on the daemon's own state, on an external system, on a person — and three answers: reversible (undo restores everything), compensable (an undo operation exists but traces, cost or time remain), irreversible. The question that decides most cases is whether the effect can be stopped *before anyone observes it*: a delayed send is reversible, a sent comment is compensable, a notification read is irreversible. A compensable operation runs unattended only when its compensation is prepared; an irreversible one is an invariant (K6) or the owner's call beforehand.

**Today, and what is missing.** Releases are immutable, a promotion checks the candidate boots and rolls back by itself, the rescue page undoes it from a phone, the schema only grows. Since the second implementation: a comment to GitHub waits 60 s and can be taken back meanwhile; a schema migration first takes a snapshot the rescue page can restore; the promotion check also reads the task list and one task; the host scripts root installs follow the promoted release when it is an ancestor of `main` (else `main`'s head, said in the journal), the updater itself only moves forward, and the installed scripts are kept when the new ones fail a trial run (`docs/design/cloud-hosting.md` §6.5). Missing: compensation for systems other than GitHub, and approvals taken off per operation as the table and its compensations allow.

**The table.** `ops-kit/reversibility.json` holds one row per operation (effect, whether it can be stopped before it is observed, the answer, one sentence of why), including the merge gate's kinds and the operations named above that have no gate kind. The merge gate reads it: a kind whose answer is `irreversible` is asked of the owner, any other kind is lifted by a recheck; the path globs stay in the gate.

**Revised by.** The record of every rollback: what was undone, what stayed. The decision table is data and is corrected from that record.

## K4 Process as plug-in

**For.** If adding, removing or combining a process costs a change to core, no exploration happens. Candidates must be definitions the daemon reads, able to coexist, with the choice recorded.

**Shape.** `ops-kit/processes/<id>.md`: YAML frontmatter with `id` (equal to the file name), integer `version`, `title`, `fits` (free-text lines naming the work it is meant for), then the text a Task is given at each entry as `## entry <name>` sections with `{{key}}` holes. `packages/core/src/process-defs.ts` reads them (`listProcesses`, `loadProcess`) and fills an entry (`renderEntry`); a hole the caller does not fill, or an entry the definition lacks, is an error, so a Task never starts on a literal `{{…}}`. The daemon passes the meta workspace's checkout as the place to read them from, where the shared skills are read from too — not the running release — so editing a candidate reaches the next Task without a promotion. The first implementation of the kernel (one stack of changes, of which this document is the first) exposes the list at `GET /api/processes`, lets a Task be created with `process` and `processReason`, and puts both into the provenance.

**The test that K4 is real.** The current pipeline is `p0-pipeline`. Its eight entries are the exact texts the daemon built into the stage prompts; the same stack of changes makes the daemon render the stage prompt from the file, removes the strings from core, and checks that the rendered prompts are byte-identical to the former ones. A second candidate, `p1-direct` (one agent from signal to PR, no planning artefacts), starts from a request's row on the Backlog screen ("`直行で直す`", the action `direct` of the same start as the stage buttons), recorded as `p1-direct` with the reason `direct button`; the sweep never picks it.

**Revised by.** Counting how often changing a candidate still needed a change to core; the aim is zero.

## K5 Exploration budget

**For.** Exploration spends tokens and the owner's attention; neither spending it all nor hoarding it is right, and the share is the owner's to set. An experiment pays for itself only if it can change a decision.

**Shape (not yet built).** A share of work or cost reserved for candidates whose record is thin or uncertain; before an experiment, the decision it would change written down ("if X then A, if Y then B" — if both branches are A, do not run it); afterwards, whether the decision changed. Kinds of experiment whose results never change decisions lose budget.

**Revised by.** The share of experiments that changed a decision.

The cost ceilings sit in one settings group, `quotaAndResume`: `backlogQuotaLimit` (the usage at which the backlog holds back) and `defaultBudgetUsd` (the budget of a Task made without one; null = none). Changing the group's value changes the default for every path that makes a local Task (a Cloud Task takes no budget); `autoStart.fallbackAt` switches runner by usage and is not a cost ceiling.

## K6 Invariants

**For.** Some lines hold whatever process runs, and they must not be mixed into the prose that processes may rewrite or retire. They are not measured, dated or experimented on, and only the owner changes them.

**Shape.** `ops-kit/invariants.md`: each line states what holds and where it is enforced today. The file opens with the test that separates an invariant from a rule of care: if dropping the sentence would expose a secret, a credential, someone's data, money or a permission boundary, it is an invariant; otherwise it is a rule of care and belongs to a candidate or a skill.

## Pace layers

| Layer | Changes | Who changes it | Examples |
|---|---|---|---|
| Invariants (K6) | almost never | the owner | no keys held, nothing that authenticates in an Issue, no approval-bypassing default |
| Kernel (K1–K5) | slowly, months | owner and agents together, from the record | what provenance records, the reversibility table, the budget share |
| Candidates | weeks to months | agents, from their record | a candidate's entries and fit, its retirement, a new one |
| Per-Task configuration | every Task | the agent | which candidate, model, and rules to read |

A candidate that is retired keeps its file and its record and can be chosen again; retirement is shelving, not deletion.

## Major

A major step of the process is the point where all three of these hold:

1. Two or more candidates run, and there is a period in which the choice between them was recorded for each piece of work.
2. A reversible change has a path to ship that does not go through the fixed review stages.
3. At least one of P0's rules of care has been dropped, with the record as the reason.

One or two of them is progress inside the current step, not a new one.

Those three conditions are the premise: the mechanism exists. Whether the step is a success is judged on outcomes, over a window of 4 weeks, against the baseline of 2026-11-03:

- In the window, some of the owner's requests were run outside `p0-pipeline`, and their rework is no worse than the rework on `p0-pipeline` in the same window (the baseline window is shown beside it).
- The size of the instructions a Task starts reading (`provenance.instructionBytes`) is smaller than at the baseline.
- The days until a request is closed are fewer than in the 4 weeks before the baseline date (2026-11-03).
- (a) The share of quota consumption (ledger `cost_usd`) that goes to workspaces whose `workspaces.kind` is not `meta` is larger than in the baseline week.
- (b) Quota consumption per delivered PBI, and the owner's interventions per delivered PBI, are no worse than in the baseline week.
- (c) The rework on work that started from an agent's proposal or a scheduled check is no worse than the rework on work that started from an owner's request.
- (d) The finding rate of the sampled audit of changes that shipped without waiting for review is no worse than the rate for changes that went through review.

All seven outcome conditions are read together, over the same 4-week window. They are not split into gates in order: there is no rule that one must be met before the next is looked at. For (a) and (b), the share and the ratios are taken over the whole window and compared with the same share and ratios in the baseline week.

Where each number is read:

- The first three: the `成果の条件` section of `scripts/kernel-report.ts`.
- (a): today, by a query over `ledger`, `tasks.workspace_id` and `workspaces.kind`. The per-workspace table of quota, interventions and delivered PBIs is `not yet built`.
- (b): the same per-workspace table, `not yet built`.
- (c): a table of results by origin of the work, `not yet built`.
- (d): the sampled-audit marker (`[post-audit]`) and the finding rate split by changes with and without review are `not yet built`. `bun scripts/merge-audit.ts` today counts how large PRs were let through, per kind, but does not make this split.

Baseline for (a): the week is Monday 2026-11-02 00:00 to Monday 2026-11-09 00:00 (JST), the week that contains 2026-11-03. On the owner's instance, `meta` workspaces took 90.0% of `cost_usd` in that week and all other workspaces 10.0%. This is that instance's starting point, not a target. The query joins `ledger` to `tasks` to `workspaces`, and rows that reach no workspace count as other (under 0.1% of the cost that week, too little to split out).

The levels are decided by the owner from the record; only the direction is written here. The baseline date 2026-11-03 is the day the owner set this direction (the first paragraph).

**First rule of care retired (2026-11-12).** This is the first case of condition 3. The practice retired is the optional second reviewer backed by a local model, which the review step was told to call next to the cross-runner reviewer when its endpoint was configured. The record behind it: in the month to 2026-11-12 the step was reported as off or not run on almost every review, and no review job in that month's last week ran it; in the month to 2026-11-02 it produced 2 of about 1,400 should-fix or blocker findings. The cross-runner reviewer was unchanged, and it, not the optional one, is what stops a merge. The condition to bring it back: the local-model reviewer is configured and used regularly again, or a defect it could have caught reaches main. Retirement is shelving: the removed text has no file of its own and is restored from the version history of the repository that held it. The check is two weeks later, on 2026-11-26: whether such a defect reached main.

## Decided

- **The chooser is the owner's button, and the backlog's automatic processing on the candidates' own criteria.** A request with no PBI yet offers both "`PBI にする`" (`p0-pipeline`) and "`直行で直す`" (`p1-direct`) on its row; the owner picks one, and the Task records which (`processReason` `direct button` for the direct one). The sweep also starts a request in the candidate whose `auto` criteria (in the candidate's frontmatter) it meets, or in `p0-pipeline` when none does, and records why (`auto direct: …`, `auto pipeline: …`); the button comes first, and a request a direct Task has run on is not started again. There is a way back: when the direct Task finds the work is not small, not clear, or touches an invariant, it makes no change, labels the request `direct-returned` and comments why, and the sweep then starts that request in `p0-pipeline` (decided 2026-11-03 for the button alone; changed 2026-11-08 to add the automatic choice). `maxBodyChars` counts the characters of the request's own words, the `## 要望` section (fence lines left out), or the whole body when the request has no such section or the section holds no words; notes added under other sections do not count. The criteria (what is measured and against which value) are a provisional starting point; they are reviewed from the `選び方の成績` table of `scripts/kernel-report.ts`, and a kind of criterion someone wants to add is counted under "Revised by" in K4.

## Not decided

- **The chooser beyond the criteria rows.** Whether an agent, not a fixed row (`auto` in the frontmatter), picks a candidate, from what signals, and how a weak candidate still gets chosen often enough to learn from. Today the choice is recorded (`process`, `processReason`) and made by the owner's button or by the sweep's criteria; a Task typed on Home names nothing.
- **The candidate list and each candidate's inside** — stages, artefacts, number of agents, cadence. `p1-direct` is a sketch, not a commitment.
- **Which experiment forms** (replay on recorded inputs, parallel runs on a database copy, canary with rollback) are built; each waits for a decision that needs it.
- **Thresholds** for continuing, improving or retiring a candidate: recorded when first used, then changed from the record; a new candidate gets a learning allowance and is judged on its trend, not its first level.
- **Cadence.** Time-based schedules remain only as a heartbeat; the triggers to reconsider are accumulated signals, a metric crossing, a budget spent.
- **How much of K2 becomes derived records** (decision logs and results written from daemon events instead of by hand), and whether GitHub Issues stay the mirror of every candidate's work or only of the pipeline's.
