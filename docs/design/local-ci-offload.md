# local-ci off the host

On the cloud host (where `sb-offload` is installed, see [aws/README.md](../../aws/README.md) "Offload"), `bun scripts/local-ci.ts <PR>` runs its heavy steps off the host, in small builds of the offload CI project (`sb-offload --ci`), in an image that already holds the tools, so that local-ci runs of several Tasks no longer fill the host's memory. There is no setting or flag: with `sb-offload` on `PATH` the groups below go off the host, without it (any machine that is not the cloud host) every step runs where local-ci runs. The groups are `OFFLOAD_GROUPS` in `scripts/local-ci.ts`. How local-ci itself works is [local-ci.md](local-ci.md).

## What runs off the host

Two builds, started at the same time (the project runs two builds at a time; a third waits for a slot):

| Group | Steps | Size | Why this size |
|---|---|---|---|
| typecheck | `bun install --frozen-lockfile` → `bun run licenses:check` → `bun run typecheck` | small (2 vCPU / 4 GiB) | the whole build peaks at about 2.1 GB |
| test | `bun install --frozen-lockfile` → `bun test` without the files that read recordings | small (2 vCPU / 4 GiB) | the whole build peaks at about 2.3 GB; medium gives `bun test` no time back |

The builds run in the CI image: the `ci` stage of `container/Dockerfile`, which has git with PCRE (`git grep -P`), Bun and the Codex CLI at the pins of the Dockerfile, Playwright's Chromium and the fonts, and the aws CLI. Nothing is installed at the start of a build any more. The image is made once per content of the Dockerfile: its tag is the first 12 hex digits of the sha256 of `container/Dockerfile`, so a changed Dockerfile or pin is a new tag. `sb-offload --ci` looks for that tag in the image repository; if it is missing it first runs the image project (one build of the `ci` stage, pushed to the repository, which keeps the newest 2 tags), and then starts the build with that tag as its image. The build's log starts with `sb-offload: image <tag>`, so the version a run used is read from the log.

The work tree arrives without `.git` and without `node_modules`. Each build then, in a few seconds: mounts a tmpfs as `TMPDIR` (SQLite tests are several times slower on the build's disk), gives the work tree to the image's unprivileged user `switchboard` and runs the steps as that user through a login `su -` (as root, the tests of unreadable files fail; the build's own environment, its credentials included, does not reach the steps), makes a one-commit `git init` with `origin` set to the repository's URL without credentials (tests read the repository through git), and runs `bun install --frozen-lockfile`. The cost of pulling the image when the build is provisioned is part of the seconds from `started` to the first step; see "Cost" for what is known.

Nothing else is sent: no token, no credentials, no host file, no recordings.

## What stays on the host

| Step | Why |
|---|---|
| `no personal home paths` | `git grep` over the merged checkout; cheap |
| `bun install --frozen-lockfile` | the host's later steps need `node_modules` |
| `public tree check` | reads the checkout's git objects and the host's own names and accounts |
| `bun run --cwd apps/web build` and every step after it up to the perf check (`fetch main`, fonts, perf base, perf-bench, perf check) | the perf steps measure this build with Chrome on the host; `fetch main` needs the host's GitHub credentials |
| `bun test` of the files that read recordings | the recordings (`SWITCHBOARD_FIXTURES`) are not sent; these files also hold timing-dependent daemon tests that pass on the host but not off it |
| posting the result on the PR | needs the host's GitHub credentials |

The result is the same as running every step on the host, and the host's memory peak is lower by what the type check and `bun test` held.

## The host's heavy slot

Without `sb-offload`, a local-ci run holds one heavy slot (`ops-kit heavy`) for its whole run. With it, the run holds no slot while it makes the work tree, merges and chooses the tests, nor while it waits for the builds: it holds one only for the steps that stay on the host. When none of the CI's steps goes to a build (another repository's CI with none of those steps), every step stays on the host, inside the slot. The builds start before the slot is asked for, so a wait for the slot does not hold them back. The builds use none of the host's memory, so another heavy job may run while a run waits for them.

## test-changed

`bun scripts/test-changed.ts` (the tests a Task runs for its change) uses the same parts. With `sb-offload`, the selected test files that read no recording go to one `small` build (`placeSteps`, `groupScript`, `parseGroup`) and the files that read recordings run on the host; a full run sends everything but the recording files. The script takes the heavy slot itself, only around the host's files, and holds none while it waits for the build; when no file stays on the host it takes none. Without `sb-offload` every file runs on the host inside the slot, as before. A build that fails, times out or is stopped fails the run with its reason line; the host does not rerun it. The type check stays on the host.

Unlike local-ci, which sends a fresh checkout, test-changed sends the Task's work tree as it is: `sb-offload` ships the tracked files and the untracked files that are not ignored. Do not leave a file with a secret in the work tree (keep scratch files in a `mktemp -d` directory outside it). When the build passes, the script logs one line with the number of files that ran off the host and the pass count, so a pass can be told from a skip.

## When a build fails

A build's steps print a begin and an exit mark each, and local-ci reads every step's output, exit code and seconds from the build's log, so a step that failed off the host is listed on the PR like one that failed on the host: its name, its `(fail)` lines, and its whole output in the log dir under `~/.cache`. When the build itself ends without the step's exit mark, the step fails with `sb-offload`'s own code and one line naming it: `sb-offload: exit 124（時間切れ）` (the build's time limit), `exit 130（中断）` (stopped), any other code `（ビルドの失敗）` (1: the build failed before the command ran, its state could not be read, or no build freed up in 15 minutes). The steps after it in that build did not run and are not listed.

Nothing is run again on the host after a failure off the host: the builds exist to keep the host's memory free, and quietly falling back to the host would fill it at the moment several runs are waiting. Run local-ci again (`--force` for the same head).

## Seconds and the `local` ceilings

The `local` ceilings in `scripts/perf-budget.json` were measured on the host; a build is another machine, so seconds measured off the host are not compared with them.

## Cost

A run is two builds of small at USD 0.00425 a build minute, billed by the started minute: about 1 minute (typecheck) and 9 minutes (test), about USD 0.04 a local-ci run. Each build now pulls the CI image before its first step instead of installing tools; whether that is shorter depends on the pull time, so the minutes above are an estimate, not a bound.

What the image adds:

- The image repository holds the newest 2 tags. The image is about 3 GB uncompressed (the pushed, compressed size is shown by `aws ecr describe-images`, field `imageSizeInBytes`); at USD 0.10 a GB-month in ap-northeast-1 that is about USD 0.3 a month if it compresses to half, USD 0.6 at most.
- The image is built (one small build, about 5 to 10 minutes, about USD 0.04) only when the Dockerfile changes, a few times a month, and by the first `sb-offload --ci` after the change, which waits for it.
- The CI project runs 2 builds at a time and the docker-check project 2 (`sb-offload` without `--ci`), so up to 4 builds can run together. At the largest size (USD 0.020 a build minute, USD 1.2 an hour a build) the four are USD 4.8 an hour at most, and `sb-offload` starts the CI builds at the size local-ci asks for (small), so the real bound is lower; the image project runs one build at a time and adds at most USD 0.26 an hour.
