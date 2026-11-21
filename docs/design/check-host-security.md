# check-host-security — noticing pending host updates

The host's OS, kernel and pinned tools get fixes that nothing reports: `sb-security-update` applies AL2023's security updates at each start without saying what it did, a new kernel takes effect only after a boot, and the tools pinned in `aws/host/node.sh` and `aws/host/devtools.sh` stay where they are. `scripts/check-host-security.ts` looks once a day and turns what it finds into a request. Detection and notice only: rebooting, stopping and updating stay a person's decision.

## What it reads

- **Pending security updates** (`scripts/host-updates.ts`): `dnf --releasever=latest updateinfo list --security`, with the severity Amazon gives each advisory. A line or a severity it cannot read counts as `unknown`, which is treated as Critical / Important. dnf runs with `--refresh` and with `skip_if_unavailable` off for `amazonlinux`: a stale cache or a skipped repository would otherwise read as no updates.
- **The kernel** (same file): `uname -r` against the newest installed `kernel6.18` and the repository's newest (`dnf check-update kernel6.18`, of any advisory type). Running older than either means a reboot is pending. AL2023 names the kernel package per series, and `KERNEL_PACKAGE` names one: a move to another series needs that constant to follow. Until then the check sees only the old series ("cannot tell" once that package is gone).
- **Pinned tools** (`scripts/host-pins.ts`): the `*_VERSION=` lines of `aws/host/node.sh` and `aws/host/devtools.sh`, which stay the only place the versions are written, against nodejs.org's `dist/index.json`, the file list on download.docker.com, GitHub's `releases/latest` and the npm registry. No key. Node.js compares within the pinned major and marks a newer release flagged `security`. GitHub's anonymous rate limit reads as "cannot tell". So does a tag there that is not a plain version.

It runs as the host user: no root, no package changes, no files changed.

## Output

One line each:

```
updates: Critical <n> / Important <n> / Medium <n> / Low <n>
kernel: 再起動待ち（<why>） | kernel: 最新
pins: <name> <pinned> → <latest>（security）
```

With `--file-request`, one `要望:` line per request says it was filed, was already open, or could not be filed (the exit code stays). `<n>` counts distinct advisories (one advisory has a row per package). A nonzero count of unreadable ones adds `/ unknown <n>`. With nothing pending, the single line `異常なし（更新 0 / 再起動待ち なし / 固定版の遅れ 0）`.

Exit 0 = nothing pending / 1 = something is / 2 = cannot tell (`判定できない（<why>）`: a dnf or distributor read failed. It never says `異常なし` and files nothing). The same input gives the same exit code with or without `--file-request`.

## What it files

`--file-request` files through `scripts/file-request.ts`, so an open request with the same title is not filed again.

- **Urgent**: Critical, Important and `unknown` updates, a pending reboot, a pinned tool behind a security release. One request titled `ホストの更新待ち: <advisory ids> / 再起動待ち / <pin names>`. The same advisories, reboot and pin names have the same title (versions are not in it); a different set files a new one. The earlier request stays open: closing it is a person's step, once the new one covers it.
- **The rest**: Medium and Low updates, pinned tools behind without a security release. One request a week, titled `ホストの Medium 以下の更新（<ISO week>）`, listing what was pending on the first run of that week. The comparison is with open requests, so closing that request within its week lets the next run file it again.

## The schedule

It runs from the existing scheduler as an ordinary prompt schedule, with no new schedule action. The prompt:

1. runs `bun scripts/check-host-security.ts --file-request` once and reports the exit code and output as they are
2. on exit 0, reports `異常なし` with the counts and ends
3. on exit 2, reports `判定できない` with the reason and ends, without filing or answering anything
4. on exit 1, for an open `ホストの更新待ち:` request with no `## 判断待ち` yet: finds each advisory's CVEs on its ALAS page (`https://alas.aws.amazon.com/AL2023/<advisory id>.html`) and reads their pages on the Amazon Linux security center, compares what they say (network or local, what is required) with your host's setup (check the setup the host is built for in "2. Prerequisite: the runtime environment Switchboard needs" of [cloud-hosting.md](cloud-hosting.md): whether it is a VM, how docker runs, whether unprivileged user namespaces are on; on a different host, re-check each of these, and note that local paths count when code running on the host can reach them), and adds a `## 判断待ち` comment in the form the decisions screen reads (`**問い**:`, `**選択肢**:`, `**推奨**:`; issue-workflow's `判断待ちの出し方`), then the `needs-decision` label. Under the block, the comment gives each advisory one of `届く` / `届かない` / `判定できない` with a one-line reason, and lists a pending reboot and a pinned tool behind a security release as they stand. A request with only a reboot or a pin gets the same comment and label. `判定できない` counts as `届く`. Critical and Important go to the user's decisions this way; scoring the CVEs itself is not done, Amazon's severity stands
5. does not reboot, stop, promote, change packages, use root or change files

The schedule's time, runner, budget and exact prompt live in the app (the Schedules screen, `GET /api/schedules`), not here. Registering it is a call to the running daemon, so it is done with the user's OK, not by the PR.

## When a request arrives

`sb-host-update` installs the security updates at every start of the daemon ("Start, stop, rebuild" in `aws/README.md`), so a new kernel needs a stop and a start. A pin that has aged long enough is raised by the pull request `scripts/bump-host-pins.ts` opens ("Raising the pins" below); review and merge it like any other. Without one (a version still inside its waiting period, a tool the script does not raise, or while the script cannot run), change `NODE_VERSION` and `NODE_SHA256` in `aws/host/node.sh` or the version and checksum in `aws/host/devtools.sh` by hand and merge that; the host picks them up on a rebuild. The weekly `ホストの Medium 以下の更新` request still lists a pin that is behind, whether or not a pull request for it is open; the two come out side by side.

## Raising the pins

`bun scripts/bump-host-pins.ts [--pr] [--min-age-days N] [--security-min-age-days N]` reads the pinned versions from `origin/main` (not from the work tree), picks per tool the newest release that has been out long enough, and with `--pr` opens one pull request that raises the versions and sha256 lines of `aws/host/devtools.sh`, `aws/host/node.sh` and `container/Dockerfile` together. Without `--pr` it only prints what it would pick: it fetches `origin/main` and reads the distributors, but downloads no tool and writes no file and no branch.

- Waiting period: 7 days from publication, 2 days for a Node.js release marked as a security release. Both can be overridden by the arguments above, so a schedule's prompt can change them without a pull request. A release inside its period never enters the pull request. Which tools are raised is the table `PIN_FILES` in `scripts/host-pin-files.ts`; a pin that is not there (such as one added to the host before the table) is left alone.
- Checking: the files of each tool are downloaded as a stream (never stored) and their sha256 is compared with what the distributor publishes: Node.js `SHASUMS256.txt`, Compose and uv a `.sha256` beside each file, gitleaks its `checksums.txt`; SAM and gh-stack publish no checksum file, so GitHub's own `digest` of the release asset is used (the pull request says so: it is a value GitHub took from what was uploaded and cannot show that the distributor was tampered with); Docker publishes a `.sha256` for newer static builds, and for a file without one the sha256 is computed from the download and the pull request says `公表なし` and lists the URLs of those files. Playwright and Playwright MCP pin only a version, and `npx` checks npm's integrity. A value that disagrees stops the run with exit 1 naming the tool and the file, and no pull request is made.
- One pull request at a time: the branch `host-pins/bump` is the script's own. While a pull request is open on it, nothing is made, even for a different version (two pull requests would touch the same lines); the open pull request's number and the versions that could be picked now are printed, and the open branch is never replaced, so the diff under review does not change. A rerun after a failed pull-request creation replaces the branch.
- Nothing local changes: the commit is built from `origin/main` in a temporary index and only `host-pins/bump` is pushed, as `scripts/rollback-pr.ts` does. The host changes only after the merge, in the usual way (a rebuild). Exit 0 = nothing to raise, a dry run, or a pull request opened or already open; 1 = a checksum disagrees; 2 = it cannot tell (`判定できない`: a distributor or GitHub cannot be read, the arguments are wrong, or the commit or pull request cannot be made; the output says which), the same meaning as `scripts/check-host-security.ts`.
- After the pull request: it goes through review, local CI and the merge gate as usual; `container/versions.test.ts` checks the three files still agree.
- Schedule: an ordinary prompt schedule (no new kind) that runs `bun scripts/bump-host-pins.ts --pr`. Its time, runner and exact prompt live in the app (the Schedules screen, `GET /api/schedules`), as in "The schedule" above.
