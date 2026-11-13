# local-ci off the host

On the cloud host (where `sb-offload` is installed, see [aws/README.md](../../aws/README.md) "Offload"), `bun scripts/local-ci.ts <PR>` runs every step of the CI off the host, in one build of the offload CI project (`sb-offload --ci`), in an image that already holds the tools. The host runs no step itself, so the local-ci runs of several Tasks no longer compete for its memory. Without `sb-offload` (any machine that is not the cloud host), or with `--local`, every step runs where local-ci runs; see "Where it runs" in [local-ci.md](local-ci.md). How local-ci itself works is also in [local-ci.md](local-ci.md).

## What runs off the host

All of the CI's steps, in the CI's order, in one build. Steps are not sorted by name: whatever a checkout's CI lists (this repository's `scripts/ci.ts` steps, or another repository's `ops.config.json` `ci.steps` or the `run:` entries of its `ci.yml`) goes into the one build as it is. There are no groups, so nothing needs a decision about which step may leave the host.

The build runs in the CI image: the `ci` stage of `container/Dockerfile`, which has git with PCRE (`git grep -P`), Bun and the Codex CLI at the pins of the Dockerfile, Playwright's Chromium and the fonts, and the aws CLI. The image is made once per content of the Dockerfile: its tag is the first 12 hex digits of the sha256 of `container/Dockerfile`, so a changed Dockerfile or pin is a new tag. `sb-offload --ci` looks for that tag in the image repository; if it is missing it first runs the image project (one build of the `ci` stage, pushed to the repository, which keeps the newest 2 tags), and then starts the build with that tag as its image. The build's log starts with `sb-offload: image <tag>`, so the version a run used is read from the log.

The work tree arrives without `.git` and without `node_modules`. The build mounts a tmpfs as `TMPDIR` (SQLite tests are several times slower on the build's disk), gives the work tree to the image's unprivileged user `switchboard` and runs the steps as that user through a login `su -` (as root, the tests of unreadable files fail; the build's own environment does not reach the steps), makes a one-commit `git init` with `origin` set to the repository's URL without credentials (tests read the repository through git), and runs `bun install --frozen-lockfile`. Then each step prints a begin and an exit mark with the time (`sb-step: <n> begin|exit …`); local-ci reads every step's output, exit code and seconds from the log.

A pull request's run does not include the perf steps (the web build for them, the fetch of main, the perf base, the bench and the check): the tag CI measures them (see [perf.md](perf.md)).

## What the host keeps

The host decides, prepares, asks and writes; it runs no step.

- Deciding what to run: reading the PR's head and base, merging the head into the base's tip, choosing the tests (see "Target and environment" in [local-ci.md](local-ci.md)), and deciding whether an earlier pass lets the run be incremental.
- Making the work tree under `~/.cache` and asking for the build.
- Writing the result on the PR (`[local-ci] pass|fail …`) once the build's log is read, after checking that the head and base have not moved.

The reason is credentials. The GitHub write credentials are only on the host: the build has none, and local-ci removes `GH_TOKEN` and `GITHUB_TOKEN` from the environment it starts `sb-offload` with. The build's `origin` has no credentials either, so a step that reads the repository over the network reads only what is public. What the host writes to GitHub is only the result, and it writes it after the build has ended.

## How the recordings and the names reach the build

The build needs two things that the host has and the work tree does not. Neither goes in the script, in an argument, in the environment or in a log.

- Recordings: with `SWITCHBOARD_FIXTURES` set, or else when `~/.switchboard/fixtures` exists, local-ci passes that directory by `--fixtures`. `sb-offload` packs it as a one-time object next to the work tree's, and the build unpacks it to `~/.switchboard/fixtures` in the steps' user's home, reading it with the read access the build already has to that place. When the directory was named by `SWITCHBOARD_FIXTURES`, the run needs the recordings: the build exports `SWITCHBOARD_FIXTURES`, so a missing recording fails a test. With the usual directory only, a missing recording is not a failure.
- The AWS names and account ids that the public-tree check looks for: local-ci writes them into a file of mode 600 in a directory of its own and gives `sb-offload` its path (`--names`). `sb-offload` puts the file next to the work tree as another one-time object; the build reads it, writes the names into the steps' user's AWS config and deletes the file. local-ci removes its own file once the build has started. The value is in no script, no argument other than that path, no environment variable and no log. A host with no AWS config sends none.

local-ci starts its build with `--detach`, which returns before the build has read its objects, so nothing removes them then: the work tree, the recordings and the names file stay in `offload/` until the bucket's one-day expiry (a call without `--detach` removes its uploads when it ends). The build's role only reads from S3 and ECR and writes its log group, and the build has no GitHub credentials.

## When the host goes away

local-ci asks for the build with `--detach`: `sb-offload` returns as soon as the build has started (`sb-offload: started <build-id>`), and local-ci then waits for it with `sb-offload --collect <build-id>`. As soon as the build has started, local-ci writes a record under `~/.cache/switchboard.local-ci-pending/`: the PR, the repository, the head, the base, the build id, the steps, how the tests were chosen, and the process that waits. It holds no token and no AWS name; the build's id is all that names the build. The record is removed once the result has been written to the PR, or found not to be written (the head or base moved).

So a local-ci process that is gone does not lose the result: the build runs on, and its result is written later.

- Ctrl-C of local-ci (or a stopped Task) does not stop the build. It ends the wait only; the build finishes and its result is posted by a later collect.
- `bun scripts/local-ci.ts --collect` waits for every build whose record is left, reads the steps from its log as a run would, and posts the result. It leaves a record whose local-ci process is still alive in this boot: that process writes the result itself.
- The daemon runs `--collect` at its start (its output goes to `collect-pending.log` next to the jobs' logs), so a restart or a host stop does not leave a result unwritten.
- Running local-ci again for the same head and base (without `--force` or `--all`) finds the record and waits for that build instead of starting another. A head or base that has moved starts a new build. If the build is gone (its log is kept 7 days) or cannot be read, nothing is posted from it, and the run builds anew.

## Running on the host: `--local`

`--local` runs every step on the machine where local-ci runs, inside the heavy-work slot. The place is chosen once per run, in one of three cases:

| Case | Where the steps run |
|---|---|
| `--local` | on this machine, in the slot |
| no `--local`, `sb-offload` on `PATH` | in one build off the host; the host holds no slot while it makes the work tree and waits, so another heavy job may run meanwhile |
| no `--local`, no `sb-offload` (a fork, a local container) | on this machine, in the slot |

No environment variable or setting switches this, and the host's free resources are not looked at to choose. `--local` changes neither the form of the result nor how it is posted. A `--local` run removes a record of an off-host build for the same head and base once its own result is posted, so `--collect` does not post a second mark.

## When a build fails

A step that failed in the build is listed on the PR like one that failed on a host: its name, its `(fail)` lines, and its whole output in the log dir under `~/.cache`. When the build ends without the step's exit mark, the step fails with `sb-offload`'s own code and one line naming it: `sb-offload: exit 124（時間切れ）` (the build's time limit), `exit 130（中断）` (stopped), any other code `（ビルドの失敗）` (1: the build failed before the command ran, its state could not be read, or no build freed up in 15 minutes). The steps after it did not run and are not listed.

Nothing is run again on the host after a failure off the host: quietly falling back would put the load back on the host at the moment several runs are waiting, and would hide a failure that is the build's own (a time-out, a stop). Run local-ci again (`--force` for the same head), or with `--local` when the steps are meant to run on the host.

## Why nothing needs the host

An earlier design kept some steps on the host: the public-tree check (it reads the host's own AWS names), the tests that read recordings, and the web build, the fetch of main and the perf steps (measured with Chrome on the host, with the host's credentials). None of them needs the host any more. The names and the recordings reach the build as one-time objects (above); the perf steps are the tag CI's, not a pull request's; the CI image has the Chromium and fonts for any step that needs a browser. What is left is writing to GitHub, which is not a step: the host does it after the build, from its own credentials.

## test-changed

`bun scripts/test-changed.ts` (the tests a Task runs for its change) uses the same parts. With `sb-offload`, every selected test file (the ones that read recordings too) goes to one build through the same `runBuild`, `ciScript` and `parseBuild`, and the host takes no heavy slot. Without `sb-offload`, the files run on the host inside the slot. A build that fails, times out or is stopped fails the run with its reason line; the host does not rerun it. The type check is not part of it.

Unlike local-ci, which sends a fresh checkout, test-changed sends the Task's work tree as it is: `sb-offload` ships the tracked files and the untracked files that are not ignored. Do not leave a file with a secret in the work tree (keep scratch files in a `mktemp -d` directory outside it). It sends no AWS names: its build runs no public-tree check.

## Measuring

Seconds, sizes and costs are not written here: they change with the image, the machine and the price list. To measure them, read the log of a run.

- The `sb-step: <n> begin <time>` and `sb-step: <n> exit <code> <time>` lines give each step's seconds in the build.
- `sb-offload: image <tag>` names the image a run used. `sb-offload: started <build-id> …` gives when the build started; the time from there to the first `sb-step: 0 begin` is the provisioning, the image pull and the setup.
- Billing is per started minute of the build, at the price of the machine's size in [aws/README.md](../../aws/README.md) "Offload" (local-ci asks for the small size).

The `local` ceilings in `scripts/perf-budget.json` were measured on the host; a build is another machine, so the seconds of steps run off the host are not compared with them.
