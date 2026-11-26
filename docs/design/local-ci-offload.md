# local-ci off the machine

Where `sb-offload` is installed (the EC2 setup; see [aws/README.md](../../aws/README.md) "Offload"), `bun scripts/local-ci.ts <PR>` runs every step of the CI off the machine, in one build of the offload CI project (`sb-offload --ci`), in an image that already holds the tools. The machine runs no step itself, so the local-ci runs of several Tasks no longer compete for its memory. Without `sb-offload` (a machine that has none), or with `--local`, every step runs where local-ci runs; see "Where it runs" in [local-ci.md](local-ci.md). How local-ci itself works is also in [local-ci.md](local-ci.md).

## What runs off the machine

All of the CI's steps, in the CI's order, in one build. Steps are not sorted by name: whatever a checkout's CI lists (this repository's `scripts/ci.ts` steps, or another repository's `ops.config.json` `ci.steps` or the `run:` entries of its `ci.yml`) goes into the one build as it is. There are no groups, so nothing needs a decision about which step may leave the machine.

The build runs in the CI image: the `ci` stage of `container/Dockerfile`, which has git with PCRE (`git grep -P`), Bun and the Codex CLI at the pins of the Dockerfile, Playwright's Chromium and the fonts, and the aws CLI. The image is made once per content of the Dockerfile: its tag is the first 12 hex digits of the sha256 of `container/Dockerfile`, so a changed Dockerfile or pin is a new tag. `sb-offload --ci` looks for that tag in the image repository; if it is missing it first runs the image project (one build of the `ci` stage, pushed to the repository, which keeps the newest 2 tags), and then starts the build with that tag as its image. The build's log starts with `sb-offload: image <tag>`, so the version a run used is read from the log.

The image's source is named by the caller, not found in whatever work tree is sent. `sb-offload --ci` takes `--image-root <dir>`: the tag is the hash of that tree's `container/Dockerfile`, and a missing image is built from a one-time upload that holds that file alone (the `ci` stage copies nothing from the tree, so the image project builds it as it builds a work tree's). Without `--image-root` the source is the work tree that is sent. local-ci and the tag CI choose between exactly two sources: for Switchboard's own repository, the checkout that is built (so a pull request or a tag that changes the Dockerfile or a pin is tried on its own image), and for another repository (`--repo`), Switchboard's own clone, the one the script runs from. Another repository's work tree has no such file — and if it has a `container/Dockerfile` of its own, that file is not used: it must not become Switchboard's CI image under Switchboard's tag. test-changed sends only Switchboard's work tree and names nothing. A work tree without the file and no `--image-root` is refused before anything is sent (exit 2).

The work tree arrives without `.git` and without `node_modules`. The build mounts a tmpfs as `TMPDIR` (SQLite tests are several times slower on the build's disk), gives the work tree to the image's unprivileged user `switchboard` and runs the steps as that user through a login `su -` (as root, the tests of unreadable files fail; the build's own environment does not reach the steps; and the steps start inside a private mount namespace where `/codebuild/output/tmp` is an empty tmpfs, so the `env.sh` CodeBuild writes there with the build role's credential path and token is not readable either, see "The mask on `/codebuild/output/tmp`" below) in a new PID namespace whose init reaps orphaned children (the build's PID 1 does not, and a zombie looks alive to `kill(pid, 0)`, which the child-cleanup tests check), makes a one-commit `git init` with `origin` set to the repository's URL without credentials (tests read the repository through git), and, only when the tree has a `package.json`, runs `bun install --frozen-lockfile` (a repository that is not a Bun project, such as a Python one, goes straight to its steps: installing what its steps need is the CI's own step). Then each step prints a begin and an exit mark with the time (`sb-step: <n> begin|exit …`); local-ci reads every step's output, exit code and seconds from the log. The one-commit tree has no base ref, so the machine reads the base's list of over-limit files from its own clone (`STILL_OVER` of `scripts/file-size.ts` at `FILE_SIZE_BASE_REF`, else `origin/main`; the tag CI sets the tag before) and the script exports it as `FILE_SIZE_BASE_LIST`, which `bun scripts/file-size.ts` compares the ceilings with.

A pull request's run does not include the perf steps (the web build for them, the fetch of main, the perf base, the bench and the check): the tag CI measures them (see [perf.md](perf.md)).

## What the machine keeps

The machine decides, prepares, asks and writes; it runs no step.

- Deciding what to run: reading the PR's head and base, merging the head into the base's tip, choosing the tests (see "Target and environment" in [local-ci.md](local-ci.md)), and deciding whether an earlier pass lets the run be incremental.
- Making the work tree under `~/.cache` and asking for the build.
- Writing the result on the PR (`[local-ci] pass|fail …`) once the build's log is read, after checking that the head and base have not moved.

The reason is credentials. The GitHub write credentials are only on the machine: the build has none, and local-ci removes `GH_TOKEN` and `GITHUB_TOKEN` from the environment it starts `sb-offload` with. The build's `origin` has no credentials either, so a step that reads the repository over the network reads only what is public. What the machine writes to GitHub is only the result, and it writes it after the build has ended.

## How the recordings and the names reach the build

The build needs two things that the machine has and the work tree does not. Neither goes in the script, in an argument, in the environment or in a log.

- Recordings: with `SWITCHBOARD_FIXTURES` set, or else when `~/.switchboard/fixtures` exists, local-ci passes that directory by `--fixtures`. `sb-offload` packs it as a one-time object next to the work tree's, and the build unpacks it to `~/.switchboard/fixtures` in the steps' user's home, reading it with the read access the build already has to that place. When the directory was named by `SWITCHBOARD_FIXTURES`, the run needs the recordings: the build exports `SWITCHBOARD_FIXTURES`, so a missing recording fails a test. With the usual directory only, a missing recording is not a failure.
- The AWS names and account ids that the public-tree check looks for: local-ci writes them into a file of mode 600 in a directory of its own and gives `sb-offload` its path (`--names`). `sb-offload` puts the file next to the work tree as another one-time object; the build reads it, writes the names into the steps' user's AWS config and deletes the file. local-ci removes its own file once the build has started. The value is in no script, no argument other than that path, no environment variable and no log. A machine with no AWS config sends none.

local-ci starts its build with `--detach`, which returns before the build has read its objects, so nothing removes them then: the work tree, the recordings and the names file stay in `offload/` until the bucket's one-day expiry (a call without `--detach` removes its uploads when it ends). The build's role only reads from S3 and ECR and writes its log group, and the build has no GitHub credentials.

## When the machine goes away

local-ci asks for the build with `--detach`: `sb-offload` returns as soon as the build has started (`sb-offload: started <build-id>`), and local-ci then waits for it with `sb-offload --collect <build-id>`. As soon as the build has started, local-ci writes a record under `~/.cache/switchboard.local-ci-pending/`: the PR, the repository, the head, the base, the build id, the steps, how the tests were chosen, and the process that waits. It holds no token and no AWS name; the build's id is all that names the build. The record is removed once the result has been written to the PR, or found not to be written (the head moved; a base that alone moved is still written, with the base the build ran on).

So a local-ci process that is gone does not lose the result: the build runs on, and its result is written later.

- Ctrl-C of local-ci (or a stopped Task) does not stop the build. It ends the wait only; the build finishes and its result is posted by a later collect.
- `bun scripts/local-ci.ts --collect` waits for every build whose record is left, reads the steps from its log as a run would, and posts the result. It leaves a record whose local-ci process is still alive in this boot: that process writes the result itself.
- The daemon runs `--collect` at its start (its output goes to `collect-pending.log` next to the jobs' logs), so a restart or a machine stop does not leave a result unwritten.
- Running local-ci again for the same head and base (without `--force` or `--all`) finds the record and waits for that build instead of starting another. A head or base that has moved starts a new build. If the build is gone (its log is kept 7 days) or cannot be read, nothing is posted from it, and the run builds anew.

## Running on the machine: `--local`

`--local` runs every step on the machine where local-ci runs, inside the heavy-work slot. The place is chosen once per run, in one of three cases:

| Case | Where the steps run |
|---|---|
| `--local` | on this machine, in the slot |
| no `--local`, `sb-offload` on `PATH` | in one build off the machine; the machine holds no slot while it makes the work tree and waits, so another heavy job may run meanwhile |
| no `--local`, no `sb-offload` (a fork, a local container) | on this machine, in the slot |

No environment variable or setting switches this, and the machine's free resources are not looked at to choose. `--local` changes neither the form of the result nor how it is posted. A `--local` run removes a record of an off-machine build for the same head and base once its own result is posted, so `--collect` does not post a second mark.

## When a build fails

A step that failed in the build is listed on the PR like one that failed on a machine: its name, its `(fail)` lines, and its whole output in the log dir under `~/.cache`. When the build ends without the step's exit mark, the step fails with `sb-offload`'s own code and one line naming it: `sb-offload: exit 124（時間切れ）` (the build's time limit), `exit 130（中断）` (stopped), any other code `（ビルドの失敗）` (the build failed before the command ran, or its state could not be read). The steps after it did not run and are not listed.

A build that could not be started is not a failed step. When `sb-offload` itself fails before a build exists (the image's source is missing, no build freed up in 15 minutes, a parameter cannot be read, an installed `sb-offload` from before a flag the run needs — the machine's copy is replaced only at its next start), no step ran, so nothing is known about the code. local-ci then posts nothing on the pull request and writes no pending record, prints `外のビルドを始められなかった（exit N）` with what `sb-offload` printed, and exits 2 (could not judge). The tag CI writes no mark to the tag's Release, files no request and proposes no tag to roll back to; it logs the same line and stops its walk at that tag (as it does for recordings the machine lacks), so a run that judged no tag exits 2. Before this, such a failure was attached to the first step as if the code had failed.

The build's own setup failing is the same: when the log has a line starting `sb-setup:` (the work tree could not be made, `bun install --frozen-lockfile` failed) and no step began, no step ran, so it is no failed step either. local-ci (a run here, a resumed one and `--collect`) posts nothing, removes the pending record and exits 2 with `外のビルドの準備に失敗した（exit N）` and the setup's output; the tag CI writes no mark, removes its pending record and stops its walk. A step that began and was cut off stays that step's failure.

Nothing is run again on the machine after a failure off the machine: quietly falling back would put the load back on the machine at the moment several runs are waiting, and would hide a failure that is the build's own (a time-out, a stop). Run local-ci again (`--force` for the same head), or with `--local` when the steps are meant to run on the machine.

## Why nothing needs the machine

An earlier design kept some steps on the machine: the public-tree check (it reads the machine's own AWS names), the tests that read recordings, and the web build, the fetch of main and the perf steps (measured with Chrome on the machine, with the machine's credentials). None of them needs the machine any more. The names and the recordings reach the build as one-time objects (above); the perf steps are the tag CI's, not a pull request's; the CI image has the Chromium and fonts for any step that needs a browser. What is left is writing to GitHub, which is not a step: the machine does it after the build, from its own credentials.

## test-changed

`bun scripts/test-changed.ts` (the tests a Task runs for its change) uses the same parts. With `sb-offload`, every selected test file (the ones that read recordings too) goes to one build through the same `runBuild`, `ciScript` and `parseBuild`, and the machine takes no heavy slot. Without `sb-offload`, or with `--local` (the same choice as local-ci's `--local`), the files run on the machine inside the slot, with the environment of a local-ci step (`PATH`, `HOME`, `CI`, `TMPDIR` and an explicit recordings path); no token or key from the caller's environment reaches them. A build that fails, times out or is stopped fails the run with its reason line; the machine does not rerun it.

The same input is not built twice. Before starting a build, test-changed looks in the record of off-machine builds (`~/.cache/switchboard.offload-builds.jsonl`) for a build with exactly the same input key — the script (so the same selected test files), the build's size, every tracked and untracked file of the work tree by content, and the recordings — started within the last 24 hours. When there is one, no build starts: its result is read with `sb-offload --collect <build-id>` (a build still running is waited for, so two calls in a row become one build), the exit code is that build's, and one line says so: `外: 前のビルド <id>（<started at> に開始）の結果を使った。回し直すなら --force`. Only a build whose command ran to its end is reused (its log has the `sb-offload: exit <n>` line; a pass and a fail both count, since the same input gives the same result); a build that was stopped, timed out, failed before its command or whose log can no longer be read is passed over, and a new build starts. `--force` starts a new build for that one call. The width is the environment variable `SWITCHBOARD_OFFLOAD_REUSE_HOURS` (default 24; 0 reuses nothing). Any change to a file of the work tree is another key, so an edit is never answered with an old result; a test that fails by chance is answered with the same failure until the tree changes or `--force` is given. How much build time this saves has not been measured yet: compare `bun scripts/offload-usage.ts --days 7` before and after.

## typecheck

`bun scripts/typecheck.ts` (the type check a Task runs, the same as the root `bun run typecheck`, `codex:types` included) runs on the machine and starts no build, with or without `sb-offload` (`--local` is accepted and does the same). One run takes a few seconds and under 200 MB at its peak, so it takes no heavy slot: it waits only while the free memory is below its own floor, 512 MB by default (not the `minFreeMb` of `~/.config/ops-kit/heavy.json`, which is 1536 MB by default and sized for a CI run; a run here peaks under 200 MB), and starts beside the jobs that hold the slots. A machine sets its own value with `"floors": { "typecheck": <MB> }` in the same file. There is no cap on how many run at once, and the floor is checked only when each run starts: several that start together near the floor can use more than the free memory (five take about 900 MB) and lean on swap. Raise `floors.typecheck` on a machine where that matters. The Codex types are made from the pinned Codex version (`scripts/codex_types.ts`), the one a pull request's CI uses, not the machine's own Codex. It builds nothing off the machine, so there is no build to fail or time out; a failing check returns the exit code of `bun run typecheck` with its tsc lines.

Unlike local-ci, which sends a fresh checkout, test-changed sends the Task's work tree as it is: `sb-offload` ships the tracked files and the untracked files that are not ignored. Do not leave a file with a secret in the work tree (keep scratch files in a `mktemp -d` directory outside it). It sends no AWS names: its build runs no public-tree check.

## Lambda builds

The CI build runs on the small ARM machine of the offload CI project, as a container with privileges (the build mounts a tmpfs, changes the work tree's owner and enters a new PID namespace as root). CodeBuild also has a Lambda environment (an ARM Lambda container). The question was whether the same CI image and the same steps can run there, so that the build moves to it. It cannot, and the build stays on the small machine. This section keeps what was tried, so the question is not asked again from the start.

### What was tried

The existing offload CI project was started by hand with start-build overrides, with no change to the template and no new project: environment type `ARM_LAMBDA_CONTAINER`, a Lambda compute type, privileged mode off, the CI image of the same tag, and a buildspec given with `--buildspec-override`. The buildspec is the project's own, with the root-only parts replaced: the work tree, the recordings and the names go under `/tmp/sb` (the one place a Lambda build can write), and the steps run through `env -i`. The CI's steps were the ones local-ci sends for a pull request (the perf steps left out), run in one build as `ciScript` writes them, except for these lines, which replace the root part and the `su -`:

```bash
mkdir -p /tmp/sb/work /tmp/sb/home /tmp/sb/tmp
# in the steps' script: cd /tmp/sb/work; TMPDIR="$(mktemp -d /tmp/sb/tmp/t.XXXXXX)"; the install log under $TMPDIR
env -i HOME=/tmp/sb/home PATH="$PATH" TMPDIR=/tmp/sb/tmp CI=true \
  CHROME_BIN="${CHROME_BIN:-}" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-}" bash /tmp/sb/ci.sh
```

The recordings were unpacked to `$HOME/.switchboard/fixtures` and the names written to `$HOME/.aws/config` as the project's buildspec does. The same steps were also run in the small build, from the same commit, to tell what is the machine's and what is the code's: the small build passed every test each time.

### What a Lambda build is

Measured from inside the build, not read from documentation:

- It runs as an unprivileged user with no capabilities, with no-new-privileges and a seccomp filter. `unshare` and `su` are refused and nothing can be mounted.
- The root file system is read-only; only `/tmp` is writable, and it is a disk, not a tmpfs.
- `/dev` is a small tmpfs holding only `null`, `zero`, `full`, `random`, `urandom`, `stdin`, `stdout` and `stderr`: no `/dev/fd`, no `/dev/ptmx`, no `/dev/pts`. There is no `/etc/hostname`.
- Process 1 is an `init` that reaps orphans, so the child-cleanup tests pass without the PID namespace and no `tini` or similar is needed in the image.
- The build's credentials come from `AWS_CONTAINER_CREDENTIALS_FULL_URI` and the `CODEBUILD_*` variables. `env -i` drops them from the environment, as the login `su -` does on the small machine, and no step needs them, so they are not passed on. Whether CodeBuild also writes them to a file there (as `/codebuild/output/tmp/env.sh` on the standard image, see "Docker in the build's steps") was not measured on a Lambda build.

The install, the type check, the public-tree check (the names) and the tests that read recordings behave as on the small machine. The tests are not slower on the Lambda build's `/tmp` disk than in the small machine's tmpfs.

### What does not run, and why it cannot be fixed without root

The full test run on a Lambda build failed a few dozen tests at every size tried; the small build failed none. Each cause below is the environment's, and none has a line in a root-free script that removes it:

| Cause | Tests (one example run) | Why there is no root-free fix |
|---|---|---|
| No `/dev/fd`: bash process substitution `<(...)` and `< <(...)` fail (`/dev/fd/63: No such file`), in the `aws/host/` scripts that use them and in the guard test that reads a pipe as a file | 22 | `/dev` belongs to the build's root; a link cannot be added |
| No pseudo-terminal (`/dev/ptmx`, `/dev/pts`): the terminal tab, the Teleport and Cloud sessions and the cookie test that opens `/ws/pty` | 22 | the device nodes cannot be created or mounted |
| No `/etc/hostname`: two tests use it as a file outside the allowed scope and expect a 403 | 2 | `/etc` is read-only |
| `HOME` has to be under `/tmp` (the only writable place), which the code treats as a temp area, so the test of a data folder outside it fails | 1 | no writable place outside `/tmp` |
| A process that made itself non-dumpable still has a readable `/proc/<pid>/cwd` | 1 | a property of the sandbox's kernel |

Changing the tests to skip or to use other files would make the same code pass on one machine and be untested on the other for exactly the places where this repository's own code meets a terminal, a pipe and the machine's files, so it was not done.

### Sizes

With the failures above held equal, three sizes were run on the full steps.

- The largest size tried (4 GB) and 2 GB took about the same time, and 2 GB used about a third of its memory at the peak.
- 1 GB took about a third longer than 2 GB, used a little over half of its memory at the peak, failed one test more and ended past 80% of the 15-minute limit of a Lambda build, so it is not a size to choose.
- No size was killed by the memory limit, so the failures are not a matter of size.

A Lambda build at the two larger sizes was also somewhat faster than the small machine for the same steps, but speed was not what decided it.

### Decision

The build stays on the small machine. The rule was: move only if every test that fails only on Lambda can be fixed without root, the time is within a fifth of the small machine's, and the build ends within 80% of the 15-minute limit. The first condition is not met (the table), so nothing else decides it. If a later change needs the build to be cheaper, the place to start is the tests in the table: each would need to run without a terminal, a `/dev/fd`, `/etc/hostname`, a `HOME` outside `/tmp` and an unreadable `/proc/<pid>/cwd` of a non-dumpable process, and a size of 2 GB is the smallest that held.

## Measuring

Seconds, sizes and costs are not written here: they change with the image, the machine and the price list. To measure them, read the log of a run.

- The `sb-step: <n> begin <time>` and `sb-step: <n> exit <code> <time>` lines give each step's seconds in the build.
- `sb-offload: image <tag>` names the image a run used. `sb-offload: started <build-id> …` gives when the build started; the time from there to the first `sb-step: 0 begin` is the provisioning, the image pull and the setup.
- `sb-file: <name> <base64>` is a file the build hands back through its log, one line per file, after the last perf step: `perf-result.json` (the bench's result) and `perf-base.json` (the compared tag's bundle and ceilings). The machine reads the lines to record the counts and judge the ceilings; any other name, or a line that is not JSON, is left out, and a missing file changes no step's result.
- Billing is per started minute of the build, at the price of the machine's size in [aws/README.md](../../aws/README.md) "Offload" (local-ci asks for the small size).

### The record of builds

Every build the machine starts appends one line to `~/.cache/switchboard.offload-builds.jsonl` (JSON Lines, written by `scripts/offload-record.ts`): the time, the caller (`local-ci`, `tag-ci`, `test-changed` or `typecheck`), the kind (`ci`, or `image` for a CI image build), the build's id, the size, the input key and the worktree. Lines older than 30 days are dropped when a line is appended; `SWITCHBOARD_OFFLOAD_RECORD_DAYS` changes the number of days. The input key is a hash of the script, the size, every tracked file and every untracked file that is not ignored in the worktree (path and content) and, when recordings are passed, each recording's relative path, size and mtime; two builds with the same key had the same input. An image build has no key. Nothing in the daemon reads the record.

`bun scripts/offload-usage.ts --days <N>` (default 7) reads the record and asks CodeBuild for each build's start and end time (100 ids per call), then prints one table. `--window-hours` (default 24) and `--gap-minutes` (default 10) set the two values below; the records of the window before the range are read too, only to compare the range's first builds with. The rows are callers; image builds are one row of their own.

- `builds`: the number of records.
- `minutes (small / medium / large)`: billed minutes, each build rounded up to a started minute, by size. A build that has not ended adds no minutes.
- `duplicates (builds / minutes)`: `ci` builds whose key was already built within the window; the minutes are the repeated builds' own.
- `followed within the gap`: `ci` builds on the same caller and worktree that started within the gap after the previous one, with a different key or no key (a change made right after a run).
- `running`: builds with no end time yet. A line `unreadable builds` counts records CodeBuild did not return. The price of a minute is in "Offload" of the AWS README, not here.

The `local` ceilings in `scripts/perf-budget.json` were measured on the machine; a build is another machine, so the seconds of steps run off the machine are not compared with them. This holds for the tag CI too: a tag's run in a build lists no `所要時間が上限を超えた` lines, and `offload` in the budget has counts and `loaded` but no `durations`.

## The tag CI uses the same runner

`bun scripts/tag-ci.ts` chooses the place the way local-ci does: where `sb-offload` is on `PATH` every step of the CI, perf included, runs in one build, and the machine holds no heavy-work slot while it waits; `--local`, or no `sb-offload`, runs the steps on the machine inside the slot. Unlike a pull request's run, the tag's build includes the perf steps and the whole `bun test`. Because the build has no `.git` and no GitHub credentials, the machine packs the tag the counts are compared with (`git archive`, with its commit in `.sb-sha`) and passes it by `--base-tree`; the build gets `PERF_BASE_TREE` and `PERF_ENV=offload`, so the counts are judged against the `offload` ceilings (see [perf.md](perf.md)). The machine writes the Release's mark and the records after reading the log, as for a pull request. The build's id is written to a record under `~/.cache/switchboard.tag-ci-pending/` once the build has started, so a run that is gone does not lose the result (see "Tag CI" in [releases-and-rescue.md](releases-and-rescue.md)).


## Docker in the build's steps

The steps of a repository's CI may use docker (`docker run` for a check, `docker compose` for an integration stage). A user who can start containers is root on the build in effect, so the rule that the steps cannot reach the build's credentials (the `env -i` and the login `su -` above) does not hold once docker is allowed. This section records what a root-equivalent step can reach, the methods measured against that, and the method chosen: rootless dockerd, together with a mask over `/codebuild/output/tmp`, both in one private mount namespace that the build's root script opens once, before the steps, for every repository. The mask is needed with or without docker: the build writes the credentials to a file in that directory, which the steps' own login can read (probe (viii)); see "The mask on `/codebuild/output/tmp`", below. The daemon and `DOCKER_HOST` are the method's later part: the script applies the mask now and starts no daemon, so a step has no docker until the daemon is built in.

### What the build gives a root-equivalent step

Measured in one build of the offload project (the standard image, ARM, kernel 4.14, small size), with the build's own dockerd, as a user who may run any container. Nothing prints a value: each probe reports only whether it read or wrote something, not the value.

- The build's role credentials are served by the container credentials endpoint (`169.254.170.2`, reached through the build's default route) at a path in `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`; `CODEBUILD_AUTH_TOKEN` and the agent's port on loopback (7831) are the build agent's. The instance metadata address (`169.254.169.254`) does not answer from the build. The credentials are in the environment of the build's processes and behind the endpoint — and, measured on the standard image, in a file too: `/codebuild/output/tmp/env.sh`, mode 666 (world-readable), which CodeBuild itself writes to carry environment variables from one buildspec command to the next within the build phase. When no mask is applied, the steps' own unprivileged login reads the credential variables from it, with no docker; the mask closes that route (probe (viii) and "The mask on `/codebuild/output/tmp`", below).
- The build's processes (the agent, the executor, the shell that runs the command, the build's own dockerd) carry those variables. The image's dockerd is started by the build's entrypoint with them and listens on `/var/run/docker.sock`.

### Probes

Seven probes (and a short IPv6 check, `six`), each a `docker run` the step itself could issue (no flag beyond what `docker run` already accepts), run against whatever dockerd a root-equivalent step can reach. `inside.sh` is mounted into the container; it prints only counts, exit codes and HTTP status codes. An eighth, (viii), is not a `docker run` at all: it is `/codebuild/output/tmp/env.sh`, read directly by the steps' own unprivileged login, no docker and no privilege needed. (ii) uses `find` to choose the files and `grep -a` to read them (the options `sbtest`'s BusyBox `grep` takes: it has no `--exclude` or `--exclude-dir`), which also searches files that grep's own heuristic calls binary, leaves out files of 1 MiB or more and the directories named `.rbenv`, `.pyenv`, `.goenv` and `.dotnet` wherever they appear under the searched directories (large toolchain trees, excluded to keep the search within the build's time), so it does not count the build agent's own binaries, which carry the variable names as strings (probe (v)'s count, below, does), and leaves out the probe's own script (`! -name inside.sh`, which lies under the searched `/host/home`).

```sh
# inside.sh: $1 names the probe
t=$1
case $t in
i) n=0; tok=0; for p in /proc/[0-9]*; do tr '\0' '\n' < $p/environ 2>/dev/null | grep -q '^AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=' && n=$((n+1)); tok=$((tok+$(tr '\0' '\n' < $p/environ 2>/dev/null | grep -cE '^(CODEBUILD_AUTH_TOKEN|AWS_CONTAINER_AUTHORIZATION_TOKEN)='))); done; echo "i: procs_visible=$(ls -d /proc/[0-9]* | wc -l) with_uri=$n with_token=$tok" ;;
ii) h=/host; echo "ii: cred_marker_files=$(find $h/codebuild $h/root $h/etc $h/tmp $h/home $h/run -type f -size -1024k ! -path '*/.rbenv/*' ! -path '*/.pyenv/*' ! -path '*/.goenv/*' ! -path '*/.dotnet/*' ! -name inside.sh ! -path '*/proc/*' ! -path '*/sys/*' -exec grep -laE 'AWS_CONTAINER_CREDENTIALS|CODEBUILD_AUTH_TOKEN|AccessKeyId|SecretAccessKey' {} + 2>/dev/null | wc -l)" ;;
iii) echo "iii: ifaces=$(ls /sys/class/net | tr '\n' ' ') default=$(ip route | head -1)"
  echo "iii: endpoint_nopath=$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 5 http://169.254.170.2/)"
  echo "iii: imds=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://169.254.169.254/latest/meta-data/)"
  echo "iii: agent_loopback_7831=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:7831/)"
  echo "iii: agent_via_10.0.2.2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://10.0.2.2:7831/)"
  echo "iii: public=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://example.com/)" ;;
iiib) echo "iiib: endpoint_nopath=$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 5 http://169.254.170.2/) agent_loopback_7831=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:7831/) agent_via_10.0.2.2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://10.0.2.2:7831/) public=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://example.com/)" ;;
iv) d=$(ip route show default | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1); echo "iv: default_dev=${d:-none}"
  iptables -F >/dev/null 2>&1; echo "iv: iptables_flush_exit=$?"
  ip route replace 169.254.170.2/32 dev "$d" >/dev/null 2>&1; echo "iv: route_replace_exit=$?"
  echo "iv: default_route_after=$(ip route show default | wc -l)"
  echo "iv: endpoint=$(curl -s -o /dev/null -w '%{http_code} %{size_download}' --max-time 4 http://169.254.170.2/)" ;;
v) echo "v: codebuild_entries=$(ls /host/codebuild 2>/dev/null | wc -l) run_socks=$(find /host/run -maxdepth 2 -name '*.sock' 2>/dev/null | wc -l)"
  umount -l /host/codebuild >/dev/null 2>&1; echo "v: umount_codebuild_exit=$?"; umount -l /host/run >/dev/null 2>&1; echo "v: umount_run_exit=$?"
  umount -l /host/codebuild/output/tmp >/dev/null 2>&1; echo "v: umount_masked_exit=$?"
  echo "v: after_unmount codebuild_entries=$(ls /host/codebuild 2>/dev/null | wc -l) run_socks=$(find /host/run -maxdepth 2 -name '*.sock' 2>/dev/null | wc -l)"
  echo "v: after_unmount marker_files=$(find /host/codebuild /host/run -type f 2>/dev/null | timeout 30 xargs -r grep -laE 'AWS_CONTAINER_CREDENTIALS|CODEBUILD_AUTH_TOKEN|AccessKeyId|SecretAccessKey' 2>/dev/null | wc -l) dockerd_sock=$(test -S /host/run/docker.sock && echo present || echo absent) dockerd_sock_ping=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 --unix-socket /host/run/docker.sock http://localhost/_ping)" ;;
vi) echo x > /host/usr/local/bin/sbprobe 2>/dev/null; echo "vi: write=$?"; chmod 4755 /host/usr/local/bin/sbprobe 2>/dev/null; echo "vi: chmod=$?" ;;
vii) echo core > /host/proc/sys/kernel/core_pattern 2>/dev/null; echo "vii: core_pattern_write=$?"; dd if=/dev/nvme0n1 of=/dev/null bs=512 count=1 2>/dev/null; echo "vii: block_read=$?" ;;
six) echo "six: global6=$(ip -6 -o addr show scope global | wc -l) linklocal6=$(ip -6 -o addr show scope link | wc -l) default6=$(ip -6 route show default | wc -l)"
  echo "six: public_v6=$(curl -g -6 -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com/) loopback_v6_7831=$(curl -g -6 -s -o /dev/null -w '%{http_code}' --max-time 3 'http://[::1]:7831/') build_via_10.0.2.2_v6mapped=$(curl -g -s -o /dev/null -w '%{http_code}' --max-time 3 'http://[::ffff:10.0.2.2]:7831/')" ;;
esac
```

```sh
r() { t=$1; shift; docker run --rm -v /home/switchboard/inside.sh:/inside.sh:ro "$@" sbtest sh /inside.sh $t; }
r i --privileged --pid=host                    # (i)   /proc/<pid>/environ of every visible process
r ii -v /:/host                                # (ii)  credential marker under the build's root
r iii --network host                           # (iii) endpoint, metadata, the agent's loopback port
r iiib                                         # (iii) again from a container on the default network
r iv --privileged --network host               # (iv)  iptables -F and a host route, then the endpoint request again
r v --privileged -v /:/host                    # (v)   umount -l the masked paths, read what is under them
r vi -v /:/host                                # (vi)  write and setuid under a build-owned root path
r vii --privileged --pid=host -v /:/host       # (vii) core_pattern, a raw block device
r six                                          # IPv6 on the default network
r six --network host                           # IPv6 in the build's own network namespace
F=/codebuild/output/tmp/env.sh; echo "viii: readable=$(test -r "$F" && echo y || echo n) matches=$(grep -acE '^(export )?(AWS_CONTAINER_CREDENTIALS_RELATIVE_URI|AWS_CONTAINER_AUTHORIZATION_TOKEN|CODEBUILD_AUTH_TOKEN)=' "$F" 2>/dev/null)"   # (viii) env.sh, the steps' own login, no docker
```

`sbtest` is an image with `curl`, `iproute2` and `iptables` (`FROM public.ecr.aws/docker/library/alpine:3.20` and `RUN apk add --no-cache curl iproute2 iptables`). The baseline and method (a) columns also passed `-e AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` to the container (a step with root-equivalent docker could read it from `/proc`) and requested the endpoint with that path; the chosen method's run passes no variable, because none is readable to it.

All seven were run on a real build of the offload project, first against the build's own dockerd (the baseline above, with no method applied), then against each candidate method, except (ii) for method (a), which was not measured. In the table, "read" or "written" means the probe got the value, the file, or a matching answer carrying credentials; "no credentials" means the request was answered but the answer holds none (the endpoint without the path); "blocked" means a permission error, no answer, or no change.

| Probe | Baseline (the build's own dockerd) | (a) dockerd in its own namespaces | (b) rootless dockerd, chosen |
|---|---|---|---|
| (i) `/proc/<pid>/environ` | read | blocked (only the method's own few processes are visible, and none of those carries either variable) | blocked (the build's root processes are unreadable to the unprivileged user; none visible carries either variable) |
| (ii) credential marker under `/` | found (`env.sh`) | not measured | none found, with the mask applied (without it, `-a` finds `env.sh` under `/host/codebuild`, as in the baseline's count) |
| (iii) endpoint / metadata / agent | endpoint read | blocked | `--network host`: the endpoint answers and no credentials without the path, metadata gets no answer, the agent's loopback port answers (401, the same as to the step's own user without docker); default network: the endpoint answers and no credentials, the agent's port and metadata get no answer |
| (iv) (iii) again, after `iptables -F` and a host route | endpoint still read | blocked (the flush and the route reach the method's own namespace, not the build's) | blocked (the container has the build's network namespace and its default route over `eth0`; `iptables -F` exits 4 and `ip route replace 169.254.170.2/32 dev eth0` exits 2, both refused to the unprivileged user; the endpoint then answers as before, `404` with 19 bytes, no credentials) |
| (v) unmount the masks | not applicable (the build's own dockerd masks nothing) | **read** — the real build's files and its own dockerd's socket reappear once the mask is unmounted | blocked (the method's masked path is `/codebuild/output/tmp`; `umount -l` on `/host/codebuild/output/tmp` fails, locked, and the directory stays empty; the unmounts of `/host/codebuild` and `/host/run` exit 1 and the counts do not change) |
| (vi) write + setuid under `/`-mounted root | written | **written** (after (v)'s unmount) | blocked |
| (vii) `core_pattern` / raw block device | both succeed | both succeed | both blocked |
| (viii) `/codebuild/output/tmp/env.sh`, the steps' own login, no docker | read (mode 666; not a docker route, so this does not depend on the build's own dockerd) | read (unaffected; not a docker route) | read without the mask (rootless dockerd by itself does not change it); no matches with the mask |

(ii) reads with `-a`, so in a column where no mask is applied it finds `/codebuild/output/tmp/env.sh` through a `-v /:/host` container, which needs no privilege; the rootless column's "none found" holds only together with the mask, which the method applies in the same mount namespace as the daemon. (viii) goes straight to the file, needs no docker, and reads it whichever dockerd is running, or none, as long as no mask is applied.

Method (a) is a privileged container without a user namespace: its root is the kernel's root, with `CAP_SYS_ADMIN` and no mapping holding it back. (v) shows what that buys a step: `-v /:/host` sees the dockerd's masked `/codebuild` and `/run` as empty, but `umount -l` on the mount inside the container's own (cloned) mount table un-stacks the tmpfs and uncovers the mount still underneath it — the real build's files, including its own dockerd's socket. From there the step is root in the build's own namespaces, so (vi) and (vii) hold too: a step can leave a setuid-root file or a rewritten entry under `/usr/local/bin` for root to run later, flip `core_pattern`, or read the build's own disk. Method (a) does not meet the guard condition.

A container of the chosen method, and a plain container of the baseline, both reach the public internet; a container built through either pulls and installs packages. Reading the build's own block device directly (not through a container) and a container image that holds a credential of its own are not covered by the probes above; see "What stays open".

### Chosen: rootless dockerd

A rootless dockerd (`dockerd-rootless.sh`, from Docker's own `docker-rootless-extras` tarball at the same version as the image's `DOCKER_VERSION`) runs as the step's own unprivileged user, inside a user namespace it creates for itself (`rootlesskit`, through `newuidmap`/`newgidmap` and that user's `/etc/subuid`/`/etc/subgid` range). Every container that dockerd starts — including one that asks for `--privileged`, `--userns=host`, `--pid=host`, `--network host` or `-v /:/host` — is confined to that same user namespace: its "root" is the mapped, unprivileged uid on the build, not the kernel's root, so none of the seven probes above read or write anything of the build's (the table's "(b)" column), given the mask below. Rootless dockerd alone does not close (viii), and does not close (ii) either: a container with `-v /:/host` reads the world-readable `env.sh` without privilege, and (viii) is not a `docker run` at all, so a user namespace that confines containers does not confine it. The method is rootless dockerd and the mask, in one private mount namespace shared by the daemon and the steps.

With this method, the build's root script creates a private mount namespace once (`unshare --mount --propagation private`), after the steps' work tree and tmpfs are in place and before either the daemon or the `unshare --pid` line that starts the steps: both run inside it, so a container the daemon starts and the steps' own login see the same masked view (the script opens that namespace now, for the mask; the daemon start below is the later part). Inside that namespace the script mounts an empty tmpfs over `/codebuild/output/tmp`, then starts the daemon with the build's whole environment cleared (`env -i`) and only the variables it needs, as the unprivileged user (`setpriv`). The login `su -` also clears the environment, but what matters is that the daemon, a long-lived process, is not started from the root shell's environment by any route: the build's root shell holds `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` and `CODEBUILD_AUTH_TOKEN`, and a daemon or `rootlesskit` that inherited them would keep them in a process the steps' own uid owns, readable through `/proc/<pid>/environ` from any container that shares the daemon's PID namespace or from a step that can see the process. The wait ends after 120 seconds with a stop in the script's own `sb-setup:` form. The commands as run:

```sh
unshare --mount --propagation private bash -c '
  mount -t tmpfs -o mode=755 tmpfs /codebuild/output/tmp     # empty afterward, in this namespace only
  U=$(id -u switchboard); install -d -o switchboard -m 700 /run/user/$U
  setpriv --reuid=switchboard --regid=switchboard --init-groups env -i \
    PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/switchboard XDG_RUNTIME_DIR=/run/user/$U \
    dockerd-rootless.sh --storage-driver vfs --data-root /home/switchboard/docker \
    > /home/switchboard/dockerd.log 2>&1 &
  ok=; for i in $(seq 240); do DOCKER_HOST=unix:///run/user/$U/docker.sock docker info >/dev/null 2>&1 && { ok=1; break; }; sleep 0.5; done
  [ -n "$ok" ] || { echo "sb-setup: dockerd が起動しない"; tail -n 5 /home/switchboard/dockerd.log; exit 1; }
  # the steps: unshare --pid --fork --mount-proc, then su - switchboard (above), in this same mount namespace
'
```

The steps then run with `DOCKER_HOST=unix:///run/user/<uid of switchboard>/docker.sock` (the login `su -` clears the environment, so the variable is set in the steps' command line, not inherited). The check that the daemon holds none of the credential variables, run from the root shell after the start:

```sh
for p in $(pgrep -u switchboard 'dockerd|rootlesskit|containerd'); do echo "pid $p $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-30) creds=$(tr '\0' '\n' < /proc/$p/environ | grep -cE '^(AWS_CONTAINER_|CODEBUILD_)')"; done
```

It printed `creds=0` for the daemon, `rootlesskit` and `containerd`. The probes above were then run the way a step runs them: from the steps' own PID namespace and login (`unshare --pid --fork --mount-proc bash -c 'su - switchboard -c "bash step.sh"'`, where `step.sh` sets `DOCKER_HOST` and holds the `r` lines).

The data root is on the build's root disk (`/home/switchboard/docker`), not under the build's `/sb/tmp`, which is a memory-backed tmpfs of a fixed size. The network driver is left unset: with no `slirp4netns` installed (it is not in the standard image's package repositories), `rootlesskit` chooses its built-in `gvisor-tap-vsock`; with `slirp4netns` installed and `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns` set the same probes gave the same results, so neither is needed for the guard and the image need not carry `slirp4netns`. IPv6 is off in both places: a container on the default network under `gvisor-tap-vsock` has only `::1` (no global or link-local address, no IPv6 default route), the build itself has no IPv6 address or route, and an IPv6 request to a public address, to `[::1]:7831` or to the build through its IPv4 gateway address gets no answer (the `six` probe, on the default network and with `--network host`).

The overlay2 storage driver does not mount inside a rootless user namespace on this kernel (ARM CodeBuild, 4.14: the mount is refused as not permitted); `vfs` mounts and was used throughout. `docker compose` of a small stack, and a pull of a small image, both complete unprivileged under `vfs`. `unshare`, `newuidmap`/`newgidmap` (shadow-utils) and `ip` are on the standard image used for this measurement. The CI image, which carries only the static docker client and compose plugin today (`docker/docker` from the static tarball), needs these added when the method is built into the build's script: everything else the daemon takes from Docker's static tarball (`dockerd`, `containerd`, `containerd-shim-runc-v2`, `ctr`, `runc`, `docker-init`, `docker-proxy`; the host unpacks that tarball whole) and the `docker-rootless-extras` tarball (`dockerd-rootless.sh`, `rootlesskit` and its helpers), both at the image's `DOCKER_VERSION`; `iptables` (the nft variant) and `iproute` (the daemon's network setup calls them; the steps do not); `shadow-utils`, for `newuidmap`/`newgidmap` (check they are present and setuid); and an `/etc/subuid` and `/etc/subgid` range for `switchboard`. The commands above ran against both tarballs unpacked whole into `/usr/local/bin` on the standard image.

Where a container is, and what it reaches, depends on its network mode:

- A container on the default network is in RootlessKit's own network namespace, whose only outbound is the network driver's translation (no interface of the build's). It reaches the public internet and the credentials endpoint (which answers without credentials when asked without the path); the agent's loopback port and the instance metadata address get no answer.
- A container started with `--network host` shares the build's own network namespace (the daemon runs in the build's, and RootlessKit's separate namespace is used for the default network only): the same interfaces and default route as the build, so the same reach as the steps' own unprivileged user without docker: the endpoint answers without credentials, the agent's loopback port answers `401`, metadata gets no answer. It cannot change any of that: `iptables -F` and a route change were both refused to a `--privileged --network host` container in probe (iv), since they need root of that namespace, which the container's mapped root is not.

The credentials themselves are in the build's root processes' environment, which no container can read (probe (i)), in `env.sh` (closed by the mask below), and behind the endpoint at a path that the environment and that file carry: a request without the path gets a small, no-match answer, the same answer the steps' own user gets without docker.

### The mask on `/codebuild/output/tmp`

(viii) is not closed by rootless dockerd: the file is read directly by whoever can log in as the steps' user, with no container and so nothing for a user namespace to confine. Measured on the standard image with no mask applied, the steps' own unprivileged login reads `/codebuild/output/tmp/env.sh`, mode 666, with the credential variables of the build among its lines, and a `-v /:/host` container reads it too. The mask is what closes this route.

The guard is a step of its own, alongside the daemon: before either the daemon or the steps start, the build's root script opens one private mount namespace (`unshare --mount --propagation private`) and, inside it, mounts an empty tmpfs over `/codebuild/output/tmp`. The daemon and the steps' own login both start as children of that same namespace, so a container the daemon runs, given `-v /:/host`, and the steps' own login see the same masked, empty directory.

Measured in this namespace: the steps' own login then reads no matches under the masked path, and a container started with `--privileged -v /:/host` (probe (v)'s own flags) cannot undo it — `umount -l` on the masked path fails (the mount is locked), and the directory stays empty afterward, where probe (v) against method (a) read the real build's files underneath once it unmounted the same kind of mask. The difference is the user namespace: method (a)'s container was the kernel's root with no user namespace of its own, and a mount namespace with no user namespace can unmount what an ancestor's mount namespace only covers. The rootless method's containers run inside RootlessKit's user namespace instead, and a user namespace cannot unmount a mount it does not own — closing, for this one mask, exactly the hole that defeated method (a). The mask is a lock, not a hiding place, for that reason, as measured here.

The build itself still finishes: the mask is private to the one mount namespace the root script opens, not the build's own top-level one. The buildspec runs `export PERF_BASE_TREE=...` as one of its own commands before the build's own script (the last of those commands) starts; by the time the script opens its mount namespace, that hand-off through `/codebuild/output/tmp/env.sh` has already happened — the variable is already in the script's inherited process environment — and no command of this project's buildspec runs after the script, so masking the path inside the script's own namespace takes nothing the build still needs.

Where each was measured: the probe table, (viii) and the run in the masked namespace were done on the offload project's standard image (ARM, kernel 4.14, small). On the CI project's image (`sb-offload --ci`), the steps' own login, started the way the build's script starts the steps, read `env.sh` when no mask was applied and did not when the mask was applied, and the steps that followed ran.

The mask covers only the one path measured; a future CodeBuild change that writes a credential into another file would need that path added too.

### Not chosen

- (a) dockerd in its own network, PID and mount namespaces, with the build's own `iptables` cutting a veth off from the rest of the build: defeated by probe (v) above — a privileged container is the kernel's root without a user namespace, and can unmount what the method's mount namespace only masks, uncovering the real build underneath. Closing that would need a user namespace for the steps' containers too, which is most of what the rootless method already does, without the veth and `iptables` bookkeeping this method would otherwise need.
- `--userns-remap`: the remap turns off for a container that asks for `--userns=host`, which a step is free to pass; measured, such a container reads the credentials endpoint and the `environ` variables the same as the baseline. Blocking `--userns=host` needs a Docker authorization plugin — a second mechanism that has to stay correct for every option docker adds — where the rootless method's own user namespace needs none.
- Clearing the variables only (`env -i`, the login `su -`): the baseline column above is exactly what a root-equivalent step reads once docker is allowed, so it does not hold. The method above uses `env -i` for the daemon's own start as well, which is a different thing: it keeps the credentials out of the daemon's process, while the guard against containers is the user namespace.

### What stays open

- The steps' containers are root of the steps' own rootless dockerd, which sees the work tree, the recordings and the names file the build wrote for the steps' user — the same reach the steps already have as that user, not more.
- What a container runs is chosen by the repository under test. The method protects the build's credentials from the steps and from an image's commands; it does not make an image's own contents safe, and a step that logs in to a registry or pulls a private image puts a credential of its own into the daemon.
- A container with `--network host` has the same network reach as the steps' own user, including the agent's loopback port. Nothing here changes that; a later need to cut it would add a network filter for the steps' uid, not change this method.
- Reading the build's own block device directly (a raw read from a root process, not through a container) and a container image that holds a credential of its own were not measured. The raw block-device read from a container was refused (probe (vii)); no other route to the device was tried.
- The `small` size's root disk is far larger than its memory, so `vfs` (which stores every layer as a full copy rather than sharing layers) is not limited by it at the size of the measured images; a real multi-service compose build was not run under `vfs`. If one does not fit or is too slow to start, the levers are `--size large` and, where the kernel allows it, `fuse-overlayfs` as the storage driver in place of `vfs`.

### Cost

The method starts the daemon once per build, in the build's script before the steps run, for every repository: there is no per-step detection and no lazy start, so Switchboard's own CI pays it too. A cold start (every CI build's own, since the state under it is new each time) is short, and a pull under `vfs` of a small image takes longer than a pull would with a layer-sharing driver but stays under a minute for the images measured. The daemon and its containerd hold a modest amount of memory while idle. `BUILD_GENERAL1_LARGE`, and the size `sb-offload` and local-ci already pass per call (`small` by default), cover what the daemon adds. The size a repository's own docker stage needs (a compose stack of several services) is the repository's own, and `--size large` is the largest the project allows: the daemon does not raise it. The exact start-up seconds and memory are not written here (see "Measuring" above for why).
