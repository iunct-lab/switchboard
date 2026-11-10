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
ops-kit job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>]
ops-kit job request review <PR> --runner codex|claude --prompt <file> --out <file> [--cwd <dir>]
ops-kit job list [--json]
```

`request` prints `job#<id>` and an example of the stop report. The Task writes that report in its `switchboard-stop`
fence (reason `depends`, one condition with key `job#<id>`) and ends its turn. It does not poll.

With `--fixtures <dir>` (an absolute path, local CI only) the folder becomes the job's `SWITCHBOARD_FIXTURES`, so missing
recordings fail as when the owner runs local CI by hand; the daemon's own environment does not carry it.

## Why kinds, and why the daemon builds the argv

There are two kinds, `local-ci` and `review`. A request names a kind, a PR and (for a review) a runner and two files;
it never carries a command. The daemon builds the argv itself (`jobCommand` in `packages/core/src/jobs.ts`). A command
taken from the request would let a Task run anything the daemon can run, going around the permissions the Task runs
under. The `cwd` is accepted only if it is a checkout of the Task's repository (under the Task's folder, a worktree of
it, or a clone of the same origin, which is what a review's fresh clone is); the prompt and output files must be inside
that `cwd`. This guards against mistakes. It is not a boundary against the Task itself, which runs as the same OS user.

A job is a detached child of the daemon, started through a small wrapper that writes the exit code to
`<jobs dir>/<id>/exit`. Local CI takes a heavy-work slot like any other heavy run. A review waits only for the
memory floor (`ops-kit heavy --memory-only`) and is cut after a period without output (`idle-run`). A job that is
waiting for the slot is "waiting" in the resource view; the job's own status does not gain a waiting state.

## How the Task is resumed

A stop whose conditions are all `pr#N`, `issue#N` or `job#<id>` is resumed by the daemon without a person
(`packages/core/src/depends-resume.ts`, `WAIT_KEY`). `pr#N` and `issue#N` close when GitHub says so, at the
backlog import. A `job#<id>` closes when the job ends (pass, fail or aborted), and the end of a job runs the same
resume. The resume message carries each job's kind, runner, PR, status, exit code and a summary, so the Task reads the
result and continues. A Task whose job has not ended is not resumed.

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
