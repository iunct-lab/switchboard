# Daemon jobs: local CI and reviews run outside the Task's session

A Task asks the daemon to run local CI or a review for it, writes `job#<id>` as what it waits on, and ends its turn.
The daemon runs the job as its own child and, when it ends, resumes the Task with a short result.

## Why

A Task used to start local CI or a review from its own shell and wait for it with a loop (`sleep 30` repeated, in the
background). A background job that is still alive keeps the runner process from closing at the idle timeout
(`SWITCHBOARD_RUNNER_IDLE_MS`), which is correct. So every waiting Task held a session open: 150 to 250 MB each. On
2026-11-06 sessions of finished Tasks were found waiting this way for 4 hours 20 minutes, 3 hours 56 minutes and 19
minutes. Free memory was about 1.1 GB on a 3.8 GB host, below the floor of the heavy-work slot (1536 MB), so the local CI
that those sessions waited for could not start. The wait was the cause of the stall it was waiting out.

The idle timeout was not the bug. The fix moves the wait out of the session: nothing of the Task is left running while
the job runs, so the session closes at the timeout like any other finished turn.

## What a Task does

```bash
ops-kit job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>] [--local] [--change]
ops-kit job request review <PR> [--runner codex|claude [--as fallback|recheck|audit|attack]] [--kinds <k,k>] [--change] --prompt <file> --out <file> [--cwd <dir>]
ops-kit job request recheck <PR> --kind migration|rescue|security:lockfile [--cwd <dir>] [--change]
ops-kit job list [--json]
```

`request` prints `job#<id>` and an example of the stop report. The Task writes that report in its `switchboard-stop`
fence (reason `depends`, one condition with key `job#<id>`) and ends its turn. It does not poll.

A review's runner is the daemon's to decide. The main reviewer follows from the review setting as it is when the job is
asked for and from the Task's runner (`primaryReviewer` in `ops-kit/src/conditions.ts`): the Task's own runner for `same`,
the other one for `other`. Without `--runner` the job runs with that reviewer. A `--runner` that names another one is
refused with a message that names the right one, unless `--as` says why another runner reads the PR: `fallback` (it
stands in for a main reviewer at its usage limit), `recheck` (the second reader of a recheck) or `audit` (the
post-merge audit, whose reader is decided from who implemented the merged PR). `attack` (the attacking-side review, its instruction printed by `ops-kit review-attack prompt`) is the one reason that does not free the choice: the runner must be the one `attackReviewer` names, the main reviewer's runner (another runner than the implementer under `other`, the implementer's own new session under `same`), and any other is refused with a message that names it. A Task once asked Codex for a review while the setting said "same", because the text it had read
described the other side; the choice is no longer left to what the Task read. A Task whose runner reviews nothing (not
Claude Code or Codex) must name the runner, and cannot ask for `attack` at all (no runner can be named for it).

With `--fixtures <dir>` (an absolute path, local CI only) the folder becomes the job's `SWITCHBOARD_FIXTURES`, so missing
recordings fail as when the owner runs local CI by hand; the daemon's own environment does not carry it.

## Why kinds, and why the daemon builds the argv

There are four kinds that a Task starts, `local-ci`, `review`, `recheck` and `gate` (the app starts `tag-ci` itself). A request names a kind, a PR and (for a review) two files and optionally a runner;
a `recheck` names one of the rechecks whose pass is a command's exit code (`migration`, `rescue`, `security:lockfile`), and the daemon
runs the checkout's `scripts/recheck.ts` with that kind (a checkout without the script is refused). It never carries a command. The daemon builds the argv itself (`jobCommand` in `packages/core/src/jobs.ts`). For local CI
that is the checkout's own `scripts/local-ci.ts` when the checkout is Switchboard's; a checkout of another registered
repository has no such script, so the daemon runs Switchboard's (the meta workspace's) from that checkout's folder with
`--repo <owner/name>` read from its origin. A job also gets the place of the settings Switchboard keeps for the
checkout's workspace (`OPS_KIT_CONFIG`), as that workspace's Tasks do, so it reads the same CI steps. A command
taken from the request would let a Task run anything the daemon can run, going around the permissions the Task runs
under. The `cwd` is accepted only if it is a checkout of the Task's repository (under the Task's folder, a worktree of
it, a clone of the same origin, which is what a review's fresh clone is, or a clone of the origin of any workspace
registered in the app, which is what an audit Task needs to read another repository's PR); the prompt and output files must be inside
that `cwd`. When a review ends, the usage it left (`claude.jsonl`, `codex.jsonl`) goes to the ledger under the Task that
asked, with source `job`, so what a review cost can be told; a review that left nothing readable books nothing and still
ends normally. This guards against mistakes. It is not a boundary against the Task itself, which runs as the same OS user.

A job is a detached child of the daemon, started through a small wrapper that writes the exit code to
`<jobs dir>/<id>/exit`. Local CI and a `recheck` take a heavy-work slot like any other heavy run. A `recheck` records the head of its checkout, is refused when the checkout has uncommitted or untracked files, and does not run if the head moved while it waited for the slot. A review waits only for the
memory floor (`ops-kit heavy --memory-only`) and is cut after a period without output (`idle-run`). A job that is
waiting for the slot is "waiting" in the resource view; the job's own status does not gain a waiting state.

## The gate: a Task's merge verdict and merge are the app's

In a Task, `bun scripts/merge-gate.ts <PR> [--allow-large] [--merge | --merge-stack | --merge-sync] [--repo <owner/name>]` (and `--change <n>`, `--scope`) does not judge in the Task's shell. It posts a `gate` job (the PR's number and the flags; no command, no environment) and reads `GET /api/jobs/<id>` every 2 seconds until the job ends, prints what the job printed and ends with the job's exit code (0 merge, 1 stop or a failed merge). The wait is `SWITCHBOARD_GATE_WAIT_MS` (default 10 minutes), and the Task's turn is not ended: a verdict takes 10 to 60 seconds and the Task needs it at once. A daemon that does not answer, a request it refuses (an older daemon that does not know the kind), a wait that runs out, or a job that ended without its exit code is not a verdict: exit 2, and the merge is not made by the Task.

The job runs the daemon's own `scripts/merge-gate.ts`, the code of the version that is running. It is started in the daemon's own folder with Bun's `.env` loading off (`bun --no-env-file`), so a `bunfig.toml` (a `preload` is code) or a `.env` in the Task's checkout is not read by it; the checkout is named by `--cwd` and is only the folder the script reads the PR's commits and settings in (git and `gh` run in the checkout: the front of `gh` reads its refusals to write, `ops-kit.noWrite` and the like, from the working tree it runs in, and `gh stack merge` acts on it; the front is started with Bun told not to read that folder's `.env` and `bunfig.toml`). A PR that changes the rules of the gate is therefore judged by the rules that are running, not by its own copy. The job's environment is the daemon's: the records are read at the daemon's own address (`cfg.host`, the loopback address by default) with its own key (`MERGE_RECORDS_URL`, `MERGE_RECORDS_TOKEN_FILE`), and the Task's own addresses and variables are not in it. The consent to an ask reason is read for the Task that asked (`OPS_KIT_TASK_ID`), so the person's grant held for that Task and that head is what `--allow-large` needs, as before. The front of `gh` that stops a Task's merge is on only where `BACKLOG_URL` is set, and the job has none (a `--change` job has the daemon's backlog address, to read the change; it only judges), so the merge the job makes needs no grant of the person outside the gate: it is made only at a `merge` verdict of the app's copy, and a sync PR of the local main (`--merge-sync`, a Merge commit, only for a branch `sb/sync-main-<7>`) the same way. No variable of the Task's shell stands for it. This is the one merge a Task can ask for without the person's grant outside the gate; the other jobs (`local-ci`, `recheck`) run a script of the Task's checkout as the host's user, as before. A Task's local merge of a change (`scripts/local-merge.ts`, a git operation of the Task's shell) takes its judgement from a `--change` gate job in the same way.

A gate job records the verdict in `result.gate`: `verdict`, `head` (the PR's head it judged, also the job's `head`), `ask` and `recheck` (the kinds that stopped it), `reasons`, `allowLarge`, `reviewSkipped` and `merged`. A run that judged nothing (exit 2) leaves no result. The verdict is also printed to the job's `out` file, which `GET /api/jobs/<id>` returns.

Until a daemon that knows the kind is the one running, a newer `scripts/merge-gate.ts` in a Task's checkout asks an older daemon, which refuses the kind: exit 2, nothing is merged. The way through is to promote the daemon first.

## What a reviewer reads

A reviewer is meant to judge a PR with no prior context: the instructions (`prompt.md`), the material under `_review/`
(the PR, the Task, the PBI, the design rules, the diff) and the code of the fresh clone. Started plainly in that clone,
a runner also loads what is there for an implementer: the clone's `CLAUDE.md` / `AGENTS.md` (where to work, how to merge
and promote, how a Task stops), the user's memory, and the user's MCP servers, skills and plugins. Those contradict
"review with no prior context" and are not the reviewer's to act on.

`jobCommand` therefore starts a reviewer with `REVIEWER_ISOLATION` (`ops-kit/src/review-note.ts`; the commands in the
`cross-runner-review` skill that run a reviewer directly carry the same values, and a test compares them):

| Reviewer | Added to the start | Leaves out |
|---|---|---|
| Claude Code | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in front of the command; `--strict-mcp-config`, `--disable-slash-commands` | the clone's and the user's CLAUDE.md, auto memory, MCP servers, skills and slash commands |
| Codex | `-c project_doc_max_bytes=0`, `-c mcp_servers={}`, `--disable plugins`, `--disable apps` | `AGENTS.md`, MCP servers, plugins and apps |

Not used: Claude Code's `--bare` (it signs in with an API key only), Codex's `--ignore-user-config` (it would also drop
the user's model choice), and removing files from the clone (a tracked file changed in the clone changes what the
reviewer sees of the diff). The repository's design rules still reach the reviewer, as material (`_review/design-rules.md`).
There is no setting to turn this off: a reviewer never needs the implementer's rules.

Whether a reviewer may run anything depends on how its runner is started (Codex in a read-only sandbox, Claude Code in
plan mode), so the instructions do not say it. The daemon writes `<jobs dir>/<id>/prompt.md` — the Task's instructions
followed by the note of the runner that actually reviews (`REVIEWER_NOTE`) — and the job reads that file; the Task's own
file is not changed. The note is added at the start, not written into the instructions or chosen by the skill's
condition blocks, because a usage-limit fallback changes the reviewer after the instructions were written. A person who
runs a review directly gets the same text from `ops-kit review-note <codex|claude>`.

The same note carries the rules that hold for every review, whatever its kind (`REVIEW_RULES`): the one definition of a
finding's weight (blocker / should-fix / nit / question, decided by what breaks and not by an earlier round's mark; a blocking
finding — blocker or should-fix — carries `Evidence:`, a test that shows the break or the written rule it rests on, and one
without it is a nit; the implementer decides whether to take a non-blocking one — nit or question), checking
in the code each earlier finding `_review/handled.md` lists, whatever its reply says (a reply never settles a finding by
itself; a finding is left out only when the reviewer verified in the code that it is resolved), marking a point raised again
after its fix (`Repeat of:`), keeping a follow-up round to the fix, what the description now says about it and the readers of what it changed, checking the places `_review/old-paths.md` lists, and using a comparison with main
(`_review/compared.md`, the output of a comparison round asked for with `ops-kit review-compare prompt`): a `REGRESSION` row is raised again until the code closes it, and the
other rows are not raised again unless the change makes them worse than main. A branch that carries anything under `_review` does not
get its classes used; that is a blocker. These rules are here and not in each
kind's instructions so that the main review, the follow-up and a recheck cannot drift apart; `handled.md` and `old-paths.md` are made by
`ops-kit review-handled` and `ops-kit old-paths check` when the review's material is prepared (the kit's README, "Review material").

Status of the measurement (2026-11-17): the variables, flags and feature names above exist in the installed CLIs
(Claude Code 2.1.325, Codex CLI 0.169.0), and the argv is covered by tests. What each of them removes from a real
reviewer's input (the `tools` / `mcp_servers` / `skills` lists of Claude Code's `init` event, the instructions Codex
records for a session) has not been measured yet; when it is, the per-runner table of what a reviewer reads goes here.

## How the Task is resumed

A stop whose conditions are all `pr#N`, `issue#N` or `job#<id>` is resumed by the daemon without a person
(`packages/core/src/depends-resume.ts`, `WAIT_KEY`). `pr#N` and `issue#N` close when GitHub says so, at the
backlog import. A `job#<id>` closes when the job ends (pass, fail or aborted), and the end of a job runs the same
resume. The resume message carries each job's kind, runner, PR, status, exit code and a summary, so the Task reads the
result and continues. A Task whose job has not ended is not resumed.
A `job#<id>` on a stop whose reason is other than depends (a decision, for one) is met when the job ends too, also when the Task reports it open again afterwards; that stop keeps waiting for the person's answer, and no resume message is sent for it.
A job's result reaches the Task without waiting for its PR or Issue waits, which are resumed on their own when they close.
Results are batched only while the same Task still waits on a running job: the last job's end sends one message with every result.

## After the daemon restarts

The daemon can stop while a job runs. At start, `recoverJobs` goes through the jobs still marked running. A job that
left an exit code ends with it. A job whose process is still alive in this boot is looked at every few seconds until it
ends. A job whose process is gone, or that started in another boot (after a reboot the pid may belong to another
process), without an exit code is aborted. In every case the end runs the resume, so a Task waiting on a job is not
left waiting after a restart.

## Out of scope

Type checks, `test-changed` and E2E runs are not jobs of their own (the `rescue` recheck runs its E2E inside the `recheck` job). They finish in minutes and the Task needs the result at once, so
the Task runs them itself under `ops-kit heavy`. Other waits (an Actions run, a PR to merge) are not jobs either.
The kinds are fixed here; the memory floor is the kit's per-machine setting (see the kit README). This document does not copy the values the app owns (the number of jobs,
timeouts), which are in the app and the resource view.
