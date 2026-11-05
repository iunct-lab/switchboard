# local-ci off the host

On the cloud host (where `sb-offload` is installed, see [aws/README.md](../../aws/README.md) "Offload"), `bun scripts/local-ci.ts <PR>` runs its heavy steps off the host, in small builds of the offload CodeBuild project, so that local-ci runs of several Tasks no longer fill the host's memory. What stays on the host, how the steps are grouped and how large each build is are below; the grouping is measured first (2026-11-04) and local-ci follows it once it runs the groups off the host. Until then every step runs on the host. How local-ci itself works is [local-ci.md](local-ci.md).

## Groups and sizes

Measured on 2026-11-04 in eight builds (`/usr/bin/time -v` around each step, the work tree of main at that date), then once more on 2026-11-05 with the two groups exactly as local-ci builds them (its own build script, `bun test` without the files that read recordings, and the build's whole memory from `/sys/fs/cgroup/memory.peak` after the steps). The host's local-ci runs every other step as before.

| Group | Steps | Size | Max memory: largest process (`Maximum resident set size`, 2026-11-04) / whole build (`memory.peak`, 2026-11-05) | Time (2026-11-05, start to end of the build) |
|---|---|---|---|---|
| typecheck | `bun install --frozen-lockfile` → `bun run licenses:check` → `bun run typecheck` | small (2 vCPU / 4 GiB) | 140 MB (typecheck), 84 MB (install) / 2.1 GB | 52 s, of which the steps take 2 s and the rest is the setup below |
| test | `bun install --frozen-lockfile` → `bun test` without the files that read recordings | small (2 vCPU / 4 GiB) | 410 MB (`bun test`, every file) / 2.3 GB | 524 s, of which `bun test` takes 460 s: 3300 pass, 0 fail |

- Both fit in small: the largest process stays under 0.5 GB, and the whole build (the setup, the page cache and the tmpfs below included) under 2.4 GB of 4 GiB. medium (4 vCPU / 8 GiB) gave `bun test` no time back (604 s on both sizes, same run otherwise), so small is the size of both groups.
- Two groups, run at the same time: the project runs two builds at a time (`ConcurrentBuildLimit: 2`), and a third waits for a slot.
- The web build (`bun run --cwd apps/web build`) stays on the host: the perf steps after it measure that build (`apps/web/dist`) in the same checkout, and they stay on the host until they move off as well. It took 3 s and 470 MB off the host; built off the host it would be built twice.

## What the build does before the steps

The work tree arrives without `.git` and without `node_modules`, on an image whose user is root. Each build first sets up, in about 41 s on small:

- `dnf reinstall git-core`: the image's own `git` has no PCRE, so `git grep -P` (the home-path check of the CI and public-sync's checks) exits 128. The distribution's package has it.
- a tmpfs (`mount -t tmpfs`, the project's builds are privileged) as `TMPDIR`: with `TMPDIR` on the build's disk, SQLite tests ran several times slower (a test that takes under 300 ms on the host went over its 5 s limit).
- a user other than root runs the steps: as root, the tests of unreadable files read them anyway and fail.
- `git init`, `git add -A`, one commit, and `origin` set to the repository's URL (no credentials): tests read this repository's own files through git and resolve the repository from `origin`.
- Bun of the host's version, and for the typecheck group the Codex CLI of the host's version (`bun run typecheck` generates the Codex types from it first).

Nothing else is sent: no token, no credentials, no host file, no recordings.

## What stays on the host

| Step | Why |
|---|---|
| `no personal home paths` | `git grep` over the merged checkout; cheap |
| `bun install --frozen-lockfile` | the host's later steps need `node_modules` |
| `public tree check` | reads the checkout's git objects and the host's own names and accounts |
| `bun run --cwd apps/web build` and every step after it up to the perf check (`fetch main`, fonts, perf base, perf-bench, perf check) | the perf steps measure this build with Chrome on the host; `fetch main` needs the host's GitHub credentials |
| `bun test` of the files that read recordings | the recordings (`SWITCHBOARD_FIXTURES`) are not sent. These files also hold the two tests that failed off the host and pass on it (in `packages/core/src/core.test.ts`: the daemon tests "events tail" and "late LLM suggestion preserves task outcome and rule log", both timing-dependent). 14 files, 77 s and 360 MB on the host without recordings |
| posting the result on the PR | needs the host's GitHub credentials |

Without `sb-offload` (any machine that is not the cloud host) every step runs where local-ci runs, as before.

## Seconds and the `local` ceilings

The `local` ceilings were measured on the host; a build is another machine (`bun test` of every file took 537 s there against the `local` ceiling of 513.7 s). Seconds measured off the host are not compared with the host's `local` ceilings.

## Cost

A run is two builds of small at USD 0.00425 a build minute: 1 minute (typecheck) and 9 minutes (test), as billed by the started minute, about USD 0.04 a local-ci run.
