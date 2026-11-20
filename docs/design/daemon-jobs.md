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
ops-kit job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>] [--local]
ops-kit job request review <PR> [--runner codex|claude [--as fallback|recheck|audit]] --prompt <file> --out <file> [--cwd <dir>]
ops-kit job list [--json]
```

`request` prints `job#<id>` and an example of the stop report. The Task writes that report in its `switchboard-stop`
fence (reason `depends`, one condition with key `job#<id>`) and ends its turn. It does not poll.

A review's runner is the daemon's to decide. The main reviewer follows from the review setting as it is when the job is
asked for and from the Task's runner (`primaryReviewer` in `ops-kit/src/conditions.ts`): the Task's own runner for `same`,
the other one for `other`. Without `--runner` the job runs with that reviewer. A `--runner` that names another one is
refused with a message that names the right one, unless `--as` says why another runner reads the PR: `fallback` (it
stands in for a main reviewer at its usage limit), `recheck` (the second reader of a recheck) or `audit` (the
post-merge audit, whose reader is decided from who implemented the merged PR). A Task once asked Codex for a review while the setting said "same", because the text it had read
described the other side; the choice is no longer left to what the Task read. A Task whose runner reviews nothing (not
Claude Code or Codex) must name the runner.

With `--fixtures <dir>` (an absolute path, local CI only) the folder becomes the job's `SWITCHBOARD_FIXTURES`, so missing
recordings fail as when the owner runs local CI by hand; the daemon's own environment does not carry it.

## Why kinds, and why the daemon builds the argv

There are two kinds, `local-ci` and `review`. A request names a kind, a PR and (for a review) two files and optionally a runner;
it never carries a command. The daemon builds the argv itself (`jobCommand` in `packages/core/src/jobs.ts`). For local CI
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
`<jobs dir>/<id>/exit`. Local CI takes a heavy-work slot like any other heavy run. A review waits only for the
memory floor (`ops-kit heavy --memory-only`) and is cut after a period without output (`idle-run`). A job that is
waiting for the slot is "waiting" in the resource view; the job's own status does not gain a waiting state.

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
finding's weight (blocker / should-fix / nit / question, decided by what breaks and not by an earlier round's mark), checking
in the code each earlier finding `_review/handled.md` lists, whatever its reply says (a reply never settles a finding by
itself; a finding is left out only when the reviewer verified in the code that it is resolved), marking a point raised again
after its fix (`Repeat of:`), checking the places `_review/old-paths.md` lists, and using a comparison with main
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

Type checks, `test-changed` and E2E runs are not jobs. They finish in minutes and the Task needs the result at once, so
the Task runs them itself under `ops-kit heavy`. Other waits (an Actions run, a PR to merge) are not jobs either.
The kinds are fixed here; the memory floor is the kit's per-machine setting (see the kit README). This document does not copy the values the app owns (the number of jobs,
timeouts), which are in the app and the resource view.
