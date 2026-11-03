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

Exit 0 = nothing pending / 1 = something is / 2 = cannot tell (`判定できない（<why>）`: a dnf or distributor read failed. It never says 異常なし and files nothing). The same input gives the same exit code with or without `--file-request`.

## What it files

`--file-request` files through `scripts/file-request.ts`, so an open request with the same title is not filed again.

- **Urgent**: Critical, Important and `unknown` updates, a pending reboot, a pinned tool behind a security release. One request titled `ホストの更新待ち: <advisory ids> / 再起動待ち / <pin names>`. The same advisories, reboot and pin names have the same title (versions are not in it); a different set files a new one. The earlier request stays open: closing it is a person's step, once the new one covers it.
- **The rest**: Medium and Low updates, pinned tools behind without a security release. One request a week, titled `ホストの Medium 以下の更新（<ISO week>）`, listing what was pending on the first run of that week. The comparison is with open requests, so closing that request within its week lets the next run file it again.

## The schedule

It runs from the existing scheduler as an ordinary prompt schedule, with no new schedule action. The prompt:

1. runs `bun scripts/check-host-security.ts --file-request` once and reports the exit code and output as they are
2. on exit 0, reports 異常なし with the counts and ends
3. on exit 2, reports 判定できない with the reason and ends, without filing or answering anything
4. on exit 1, for an open `ホストの更新待ち:` request with no `## 判断待ち` yet: finds each advisory's CVEs on its ALAS page (`https://alas.aws.amazon.com/AL2023/<advisory id>.html`) and reads their pages on the Amazon Linux security center, compares what they say (network or local, what is required) with this host's setup (`aws/README.md`, 「経路が届くか」: no VM, rootless docker, unprivileged user namespaces on, and local paths count when code running on the host can reach them), and adds a `## 判断待ち` comment in the form the decisions screen reads (`**問い**:`, `**選択肢**:`, `**推奨**:`; issue-workflow's 「判断待ちの出し方」), then the `needs-decision` label. Under the block, the comment gives each advisory one of 届く / 届かない / 判定できない with a one-line reason, and lists a pending reboot and a pinned tool behind a security release as they stand. A request with only a reboot or a pin gets the same comment and label. 判定できない counts as 届く. Critical and Important go to the user's decisions this way; scoring the CVEs itself is not done, Amazon's severity stands
5. does not reboot, stop, promote, change packages, use root or change files

The schedule's time, runner, budget and exact prompt live in the app (the Schedules screen, `GET /api/schedules`), not here. Registering it is a call to the running daemon, so it is done with the user's OK, not by the PR.

## When a request arrives

Follow the CVE section of `aws/README.md`. A new kernel needs a stop and a start; the Node.js pin is raised as that section says. For the other pins, change the version and checksum in `aws/host/devtools.sh`; the host picks them up on a rebuild.
