# local-ci off the host

On the cloud host (where `sb-offload` is installed, see [aws/README.md](../../aws/README.md) "Offload"), `bun scripts/local-ci.ts <PR>` runs every step of the CI off the host, in one build of the offload CI project (`sb-offload --ci`), in an image that already holds the tools. The host runs no step itself, so the local-ci runs of several Tasks no longer compete for its memory. Without `sb-offload` (any machine that is not the cloud host), or with `--local`, every step runs where local-ci runs; see "Where it runs" in [local-ci.md](local-ci.md). How local-ci itself works is also in [local-ci.md](local-ci.md).

## What runs off the host

All of the CI's steps, in the CI's order, in one build. Steps are not sorted by name: whatever a checkout's CI lists (this repository's `scripts/ci.ts` steps, or another repository's `ops.config.json` `ci.steps` or the `run:` entries of its `ci.yml`) goes into the one build as it is. There are no groups, so nothing needs a decision about which step may leave the host.

The build runs in the CI image: the `ci` stage of `container/Dockerfile`, which has git with PCRE (`git grep -P`), Bun and the Codex CLI at the pins of the Dockerfile, Playwright's Chromium and the fonts, and the aws CLI. The image is made once per content of the Dockerfile: its tag is the first 12 hex digits of the sha256 of `container/Dockerfile`, so a changed Dockerfile or pin is a new tag. `sb-offload --ci` looks for that tag in the image repository; if it is missing it first runs the image project (one build of the `ci` stage, pushed to the repository, which keeps the newest 2 tags), and then starts the build with that tag as its image. The build's log starts with `sb-offload: image <tag>`, so the version a run used is read from the log.

The work tree arrives without `.git` and without `node_modules`. The build mounts a tmpfs as `TMPDIR` (SQLite tests are several times slower on the build's disk), gives the work tree to the image's unprivileged user `switchboard` and runs the steps as that user through a login `su -` (as root, the tests of unreadable files fail; the build's own environment does not reach the steps) in a new PID namespace whose init reaps orphaned children (the build's PID 1 does not, and a zombie looks alive to `kill(pid, 0)`, which the child-cleanup tests check), makes a one-commit `git init` with `origin` set to the repository's URL without credentials (tests read the repository through git), and runs `bun install --frozen-lockfile`. Then each step prints a begin and an exit mark with the time (`sb-step: <n> begin|exit …`); local-ci reads every step's output, exit code and seconds from the log.

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
- The build's credentials come from `AWS_CONTAINER_CREDENTIALS_FULL_URI` and the `CODEBUILD_*` variables. `env -i` drops them, as the login `su -` does on the small machine, and no step needs them, so they are not passed on.

The install, the type check, the public-tree check (the names) and the tests that read recordings behave as on the small machine. The tests are not slower on the Lambda build's `/tmp` disk than in the small machine's tmpfs.

### What does not run, and why it cannot be fixed without root

The full test run on a Lambda build failed a few dozen tests at every size tried; the small build failed none. Each cause below is the environment's, and none has a line in a root-free script that removes it:

| Cause | Tests (one example run) | Why there is no root-free fix |
|---|---|---|
| No `/dev/fd`: bash process substitution `<(...)` and `< <(...)` fail (`/dev/fd/63: No such file`), in the host scripts that use them and in the guard test that reads a pipe as a file | 22 | `/dev` belongs to the build's root; a link cannot be added |
| No pseudo-terminal (`/dev/ptmx`, `/dev/pts`): the terminal tab, the Teleport and Cloud sessions and the cookie test that opens `/ws/pty` | 22 | the device nodes cannot be created or mounted |
| No `/etc/hostname`: two tests use it as a file outside the allowed scope and expect a 403 | 2 | `/etc` is read-only |
| `HOME` has to be under `/tmp` (the only writable place), which the code treats as a temp area, so the test of a data folder outside it fails | 1 | no writable place outside `/tmp` |
| A process that made itself non-dumpable still has a readable `/proc/<pid>/cwd` | 1 | a property of the sandbox's kernel |

Changing the tests to skip or to use other files would make the same code pass on one machine and be untested on the other for exactly the places where this repository's own code meets a terminal, a pipe and the host's files, so it was not done.

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
- Billing is per started minute of the build, at the price of the machine's size in [aws/README.md](../../aws/README.md) "Offload" (local-ci asks for the small size).

The `local` ceilings in `scripts/perf-budget.json` were measured on the host; a build is another machine, so the seconds of steps run off the host are not compared with them.
