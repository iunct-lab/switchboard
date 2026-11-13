# Running Switchboard in the cloud — start only when used, recover when broken

A setup that puts a resident daemon on AWS and starts it only when it is used. The implementation is `aws/template.yaml`, `aws/starter.ts` and `aws/host/`; the deployment procedure is `aws/README.md`.

## 1. Deployment prerequisites

Choose your own AWS account and region. Prepare a GitHub token that can write only to the repositories you need. Estimate the cost from the running hours and the data growth rate. Keep a recovery path from the browser that is separate from the normal daemon.

## 2. Prerequisite: the runtime environment Switchboard needs

- Resident daemon: HTTP + WebSocket, PTY (`packages/core/src/pty.ts`), sqlite (WAL), git worktree
- Runners are child processes (`claude -p` with stream-json, `codex app-server`). One turn takes minutes to tens of minutes
- Background work: importing history (every 30 seconds), resuming Tasks stopped by a usage limit (`resume_at`, `packages/core/src/ratelimit.ts`), the scheduler

A function-style platform (Lambda and the like) has a 15-minute limit and does not fit a resident WebSocket / PTY / sqlite. It is close to a rewrite, so it is out of scope (proposal).
Make it a "VM that starts only when used", and control starting and stopping with the daemon itself and a small external part.

### 2.1 Development tools

Just having the daemon run does not let a runner do development (Stacked PRs, E2E, tests of a registered workspace). Bootstrap runs `aws/host/devtools.sh` once as root (running it again skips what is already there; only node is replaced when it differs from the pinned version).

| Purpose | What is installed | How |
|---|---|---|
| Stacked PRs (`pbi-complete`) | gh-stack | `gh extension install --pin` |
| Checking the usage quota in skills | sqlite3 | dnf |
| E2E (`scripts/*-e2e.ts`) | Chromium (Playwright's arm64 build; Google does not ship Chrome for Linux arm64), its runtime libraries and Noto CJK | Playwright (version pinned); libraries and fonts by dnf. The unit's `CHROME_BIN` / `CHROME_PATH` point at `/usr/local/bin/chromium` |
| Claude's screen operation | Playwright MCP (headless, the same Chromium) | `claude mcp add -s user` (version pinned) |
| Claude's settings | A JSON settings file you choose | `bash aws/host/claude-settings.sh ~/.claude/settings.json <patch.json>`. If none is given, the existing settings are left unchanged |
| Unit tests of Python repositories (DAK and others) | uv and Python 3.11 / 3.12 / 3.14, gitleaks (commit hook) | Versions and sha256 pinned; Python through uv |
| Integration tests of repositories that use compose (DAK and others) | docker and compose | **rootless** (Docker's static build + rootless extras, networking by pasta). Versions and sha256 pinned |
| IaC of a registered workspace | SAM CLI | Version and sha256 pinned |
| Running Playwright and MCP | node (LTS) | Version and sha256 pinned in `aws/host/node.sh`. `sb-host-update` also runs at every start and replaces node when it differs from the pinned version (§6.5) |
| Commits | The git author | The noreply address of the token's owner (`gh api user`) |

- **No root for the user** (sudoers stays as in §6). So docker is rootless, and neither a docker group nor a system dockerd is created. `/usr/local/bin/docker` starts it with `dockerd-up` if it does not answer, then hands the command over. dockerd runs inside the daemon unit's cgroup, and because there is no systemd user session it uses cgroupfs. When the daemon's unit restarts the containers stop too, and the next `docker` starts them again. The daemon stops `sb-dockerd` while nothing uses it (no running container and no `docker` process for 10 minutes by default, `SWITCHBOARD_DOCKERD_IDLE_MIN`), and the next `docker` starts it again
- Docker checks that do not fit on this machine (a heavy build such as `docker compose up --build` uses up the memory and freezes it, so `sb-dockerd` cuts it off at 1.5 GiB) go out to a single CodeBuild build with an explicit `sb-offload <command>`. Only the work tree is sent, the log and exit code come back, and the machine is released when the build ends. `docker` itself is never silently redirected outside (a check that assumes bind mounts or localhost would break). One line of guidance is printed on `build` / `compose up`. The machine size is chosen per call (`--size small|medium|large`), and without it the smallest runs (the largest is large, and as long as it goes through `sb-offload` the cost ceiling does not change). CodeBuild is used because the mechanism guarantees a machine is created for each run and thrown away. A temporary EC2 instance would mean handling forgotten stops and Spot availability ourselves, and making the instance larger always costs money. The mechanism and cost are in the Offload section of `aws/README.md`.
- Bootstrap does not stop even if devtools fails. It records the failure and goes on, and the daemon and sb-rescue start (only the development tools are missing; a rebuild can retry)
- A tarball extracted as root uses `--no-same-owner` (the owner uid inside a tarball can equal the OS user that runs Switchboard)
- A real LLM or a large Docker image strains RAM and disk. When `/tmp` is tmpfs, do not put large working files there.

## 3. Architecture: start EC2 only when it is used

- Create a dedicated stack in your own AWS account. Choose the region, instance type and running hours
- IaC is SAM (the transform happens on the CloudFormation side). Deployment is `aws cloudformation package` + `aws cloudformation deploy --no-execute-changeset`: look at the change set before executing it (SAM CLI cannot read `Fn::ForEach` in the template)
- The entry point is CloudFront. The origin checks the shared header
- Login is by passkey (WebAuthn)
- The login flow: open the URL → if not authorized, the UI moves to `/_auth/?next=<original path>` → on the page of the start Lambda (CloudFront's `/_auth/*`, which works even while the machine is stopped), Face ID / fingerprint → the Lambda issues the `sb_session` cookie (HttpOnly, Secure, signed; it expires 7 days after login or 24 hours after the last operation) → if the machine is stopped, `起動する` on the same page → once it is running, go to the original path. This one cookie gets you into the Switchboard screens (`/api`, `/ws`, `/ws/pty`) and the rescue page (`/rescue/`). The cookie is signed with an Ed25519 seed that only the start Lambda can read (`/switchboard/session-signing-key`), and the daemon and sb-rescue check the signature and the expiry (both the idle expiry and the cap are in the future, and the idle expiry does not exceed the cap) with the public key (`SWITCHBOARD_SESSION_PUBLIC_KEY`, which sb-env passes from `/switchboard/session-public-key`). The cap of 7 days and the idle limit of 24 hours are held with the same values in three places (`aws/auth.ts`, `packages/core/src/auth.ts`, `rescue/src/server.ts`), and `aws/session-contract.test.ts` stops any mismatch. The old two-field cookie is not read (the switch costs one re-login). The rollout order is the Lambda first (deployment; Deploy in `aws/README.md`), then the daemon, then the rescue page. How the idle expiry is extended is in the next item. The instance holds only the public key, so an agent on it cannot make a cookie. The cookie's form is `sb_session=<body>.<sig>`: body is the base64url of the UTF-8 string `<passkeyId>.<idleUntilMs>.<expiresMs>` (idle expiry, then cap; the cap goes last because older versions read the last field as the expiry), and sig is the base64url of an Ed25519 signature over that **base64url string** (only the canonical form is accepted). Even when the signature passes, the daemon and sb-rescue ask the start Lambda's `/_auth/status`, with the cookie and the shared header, whether "that passkey is still registered", and remember the answer for 5 minutes per cookie. If they cannot ask, they do not let the request through. An open WebSocket asks again every 5 minutes and closes if the passkey is gone. The UI decides which login applies from `login` in `/api/health` (`passkey` / `token`), and if it is still refused after returning from login (`?from=auth`), it does not move again but shows "a daemon restart is needed" (no loop). **There is no place where a person types or copies a token.** The daemon's token passes only inside the instance (loopback: the runner's `/mcp`, sb-rescue's liveness check, the agent's `curl`), and from outside (through CloudFront) only the cookie passes (decided 2026-10-05; the decision goes by the peer address of the connection and does not look at headers). The start token remains for machines (GitHub Actions, sb-rescue's rebuild)
- Extending the login expiry: after an operation that changes state (anything but GET / HEAD) on a screen (the chat screen and the rescue page), the screen calls the start Lambda's `POST /_auth/renew`, throttled. When a start, stop or rebuild goes through, the cookie in its response extends it too. Viewing only, automatic re-reads and WebSocket (including terminal input) do not extend it. The Lambda issues a cookie with the idle expiry 24 hours ahead (up to the cap), keeping the cookie's cap and passkeyId. Only the Lambda can sign, so the daemon and the rescue page do not issue cookies.
- Showing the login expiry: `/api/health` and `/_auth/status` return `session: { idleUntil, expiresAt }` (ms) only to requests that came in with a cookie (the cookie stays HttpOnly). The chat screen shows "`ログイン 〜まで`" (the earlier of the two) in the status bar at the bottom and re-reads `/api/health` at that time. If it was extended it shows the new time; if it has expired it moves to the passkey login through the existing flow (`/_auth/?next=…`). The start page (`/_auth/`) shows one line, "`ログイン 〜まで（最長 〜）`", in the logged-in display. It is not shown on the rescue page.
- Important operations need a recent passkey check (the daemon side too): on every `/_auth/login` and `/_auth/register` the start Lambda also issues an `sb_recent` cookie (HttpOnly, Secure, SameSite=Lax, 5 minutes). Its form is the same body as `sb_session`, with `recent:` put before the signature input (pasting an `sb_session` value into `sb_recent` or the reverse does not pass), and its passkeyId must be the same as `sb_session`'s. For the operations below, a person who came in with a cookie must also present it, and without it the answer is 401 `reason: "recent"`. Token and loopback (inside the instance) are not asked for it.

  | Operation | Receiving side | Person who came in with a cookie | token / loopback |
  |---|---|---|---|
  | Start / rebuild (`/_auth/start` `/_auth/rebuild`) | Start Lambda | A recent check is required | Not required (the machine's start token) |
  | State-changing POSTs of the rescue page (restart, roll back, promote, DB restore, rebuild, start and stop the agent) | sb-rescue | A recent check is required | Not required |
  | Seven places in the daemon: the terminal (`/ws/pty`), `POST /api/daemon/restart` and `promote`, workspace registration (`POST /api/workspaces`), saving settings (`PATCH /api/settings`), creating a Task in danger mode (`POST /api/tasks`), switching to danger mode (`POST /api/tasks/:id/permission-mode`) | Daemon | A recent check is required | Not required |

  Viewing only (the start page's status, the rescue page and its state and log), everyday operations (viewing, replying, approving) and `/mcp` (which already passes the user's approval) are not asked for it. When the Web UI receives 401 `recent` it shows a button, "`操作の前にパスキーで確かめてください`", and when it is pressed it checks the passkey at the same origin's `/_auth/login` (it is not shown automatically: Safari can call WebAuthn only inside a user action) and resends the same operation once (the terminal tab reads the reason with a GET to the same URL as `/ws/pty` and reopens once). The rescue page follows the same flow. There is no endpoint for the check and no server-side record. No mechanism is built that cuts the session at every start or rebuild (the user decided to put starting under this check instead). The browser flow is `scripts/recent-e2e.ts`
- The first passkey (and the case where every device is lost) is registered with a one-time, expiring registration link that the agent puts in the chat (`/_auth/#register=<code>`, the code is `/switchboard/register-code`; not counted against the limit on the number of passkeys). From the second device on, use "`登録済みのパスキー`" (device name, registration time, last used time, this device) in `/_auth/#devices` of an already logged-in device (it also shows in `/_auth/` when the machine is stopped). "`別の端末を追加`" receives a one-time, 10-minute code with `POST /_auth/device-code`, which carries a passkey signature made for that very request, and shows a link of the same form (a cookie alone cannot do it, even with `sb_recent`; a new code invalidates the previous one; the start Lambda puts only the SHA-256 in `auth/passkeys.json`, which the instance role cannot read; this route can add up to 5 passkeys). Each row's "`削除`" is, after a confirmation dialog, `POST /_auth/passkeys/delete`, again with an on-the-spot signature (the last remaining one gives 409). To invalidate every cookie, regenerate the seed and public key, swap the two parameters, and restart the instance (EC2 Reboot) so that sb-env re-reads them (the rescue page's "`再起動`" cannot be used: sb-rescue keeps the old public key until the restart and rejects the new cookie, so you cannot get into the page). To shut out one device, use the "`削除`" above, or, if there is no logged-in device, remove that passkey from `auth/passkeys.json` (the screens and `/rescue/` too, within 5 minutes). The passkey stays in the device's password manager and appears on the selection screen, but when it is chosen, the login page tells the device with `PublicKeyCredential.signalUnknownCredential` (the start Lambda answers an id not in the list with 401 `reason: "unknown"`, distinguished from a signature failure), and on supporting browsers it stops appearing on the selection screen from then on. On devices that do not support it, the page explains in text, and the passkey is removed in the device's settings
- CI's AWS connection is GitHub OIDC; no long-lived keys are placed in GitHub Secrets
- Cost is notified by AWS Budgets

```text
Phone / PC browser
  │ https://<distribution>.cloudfront.net (log in with a passkey → signed cookie)
  ▼
CloudFront (no caching. The daemon and sb-rescue at the origin check the cookie; without it the UI moves to the login screen)
  │ adds the shared header and goes to the origin
  ├──▶ EC2 t4g.medium (Graviton, 4 GB, the region is chosen at deployment. On-demand by default)
  │      CloudFront's VPC origin reaches the instance by its id. Inbound allows only CloudFront's prefix list, and the shared header is checked too
  │      ├ switchboard (immutable release, systemd)
  │      ├ sb-rescue (rescue service, §6)
  │      ├ EBS gp3 20 GB (/home/switchboard, repositories in /home/switchboard/repos)
  │      └ Litestream → S3 (continuous sqlite replication)
  ├──▶ /_auth*: the start Lambda (Function URL)'s login and start pages (ec2:StartInstances, and this one instance only)
  │      Hitting the Function URL directly without the shared header gets 403 on every route (/status too). Machines (Actions' host.yml, sb-rescue) send the shared header in addition to the start token. The order of rollout is: first put sb-rescue on the new version (redo `bun run rescue:install` and restart sb-rescue; a promotion replaces only the daemon), then deploy the Lambda (Lambda first would make the rescue page's rebuild return 403). SSM re-reads on a wrong start token are limited to once per 10 seconds
  │  When EC2 is stopped and does not answer (502 / 504)
  └──▶ CloudFront's error page is S3's "start page" (/_start/) → /_auth
EventBridge Scheduler (wakes it at resume_at / the scheduled run's time) ──▶ start Lambda
```

`Cdn` in `aws/template.yaml` **does not use origin failover (an origin group)**. An origin group switches only GET / HEAD, so a 502 / 504 while the machine is stopped is replaced by the start page (`aws/startpage/index.html`) with `CustomErrorResponses`. The login and the "`起動する`" and "`作り直す`" buttons are shown by the start Lambda of `/_auth*` (`aws/starter.ts`, `aws/auth-page.html`). When the API of an open screen receives the start page (an HTML 502 / 503 / 504), it asks `/api/health` again twice at 2-second intervals, and only when both answers are that page does it move to `/_auth` (`hostStopped` in `apps/web/src/login.ts`). If there is text being typed on the screen, it asks in a confirmation dialog, before moving, whether the text will be lost (if refused, it does not ask again for 1 minute). While the machine was running, a single connection failure could return the same page, and moving every time had erased the text being typed. CloudFront reaches the instance by the VPC origin, not by a public IP.

### 3.1 Start and stop

- Start: a stopped URL shows the start page. Log in with a passkey and press "`起動する`". At a scheduled time, EventBridge Scheduler wakes it
- Stop: when there has been no running or approval-waiting Task, WebSocket or PTY, and no resume or scheduled run within 30 minutes, for 20 minutes, it reserves the next start and shuts down. Only the daemon's own DB is counted, so the daemon removes the stop command (`SWITCHBOARD_IDLE_STOP_CMD`) from its own environment at startup and does not pass it to Tasks, the terminal, or the test daemons started from them (if it were passed, a test daemon that saw an empty DB would stop the instance together with the running Tasks)
- Measurement: match the start times, `hostidle` and `sb-stop` in `daemon.log` with `last -x`, and `tasks.created_at` in the DB. The time from the browser button to the response is measured separately
- Spot has interruptions and capacity shortages. Changing Market replaces the instance. Cautions and rollback are in `aws/README.md`

### 3.2 Monthly cost example

The example workloads are 175 h a month and 730 h (always on). The unit prices are Tokyo examples at design time; check the prices of the region you chose before deploying.

| Item | Calculation example |
|---|---|
| On-demand t4g.medium | $0.0432 × running hours = about $7.56 / $31.54 |
| IPv4 | $0.005 × running hours = about $0.88 / $3.65 |
| EBS gp3 20 GB | 20 × $0.096 = $1.92/month |
| S3 | stored GB × unit price + PUT / GET. Old versions under versioning are counted too |
| CloudWatch, CloudFront, Lambda, Scheduler | Add metrics, alarms and request counts. Check the free tier against your own contract |

Free-tier machines (Oracle Always Free and the like) are not adopted: the tier changes without notice and an unused machine is reclaimed after 7 days, so it cannot be the home of the source of truth.

An hourly scheduled run wakes the stopped instance every hour. If the next schedule is within 30 minutes, it does not stop. Total the running hours from the journal and compare them with the estimate.
The budget alerts are `<stack>-1000jpy` ($7) and `<stack>-3000jpy` ($20). Enable the cost allocation tag `Project`. Check the actual cost in Cost Explorer. The instance role can read only `ce:GetCostAndUsage` / `ce:GetCostForecast` and `budgets:ViewBudget` (added in 2026-10; there is no write access; the periodic task "the weekly AWS cost report" uses it).

### 3.3 Separation of permissions

- What goes on the instance is only the repositories cloned from GitHub, the migrated history, and the runners' credentials
- GitHub permission is a fine-grained token or a GitHub App limited to the registered repositories
- AWS permission is the instance role. Attach only the permissions Switchboard needs. Additional roles are named explicitly in `HostAssumeRoleArns`. No long-lived access keys are placed

## 4. Authentication — Switchboard's code holds no keys

The README's principle "No keys, no telemetry. Your own login, on your own machine." is **kept as it is at the application layer** in the cloud too.
Only the runners themselves and the environment layer (systemd and the startup scripts, the instance role) handle keys. Switchboard's code does not read, store or return credentials through the API.

| Target | Method | Where it lives | How to redo it |
|---|---|---|---|
| Claude Code | The runner's own login. Start `claude` in the terminal tab and run `/login` (open the URL on the phone and paste the code). If that does not work, get `claude setup-token` and put it in Parameter Store | The credentials the runner writes to `~/.claude/` (EBS). For setup-token, Parameter Store | Log in again in the terminal tab. For setup-token, update the value in Parameter Store from the AWS console (phone is fine) |
| Codex | The runner's own login. `codex login --device-auth` in the terminal tab | `~/.codex/auth.json`, written by the runner (EBS) | Do the same again |
| GitHub (clone / push / PR) | `gh auth login` (device flow) in the terminal tab. A fine-grained token limited to the target repositories also works (the permissions needed are in `aws/README.md`; specify your own resource owner and the Project read / write permission) | `~/.config/gh/`, written by `gh`. For a token, Parameter Store | Same as above |
| What is needed to rebuild the machine (Litestream's settings, the backup encryption key, CloudFront's shared header, the cookie signing key) | The startup script reads it with the instance role | **Parameter Store SecureString** (standard parameters, AWS-managed KMS key; no extra charge) | IaC or the AWS console |
| AWS (what uses a role named in `HostAssumeRoleArns` after assuming it) | The instance role | — | — |

- When a setup-token is put in Parameter Store: a small wrapper placed in front of `claude` (environment layer, `scripts/host/claude-wrapper.sh`) reads it from Parameter Store at every start, turns it into `CLAUDE_CODE_OAUTH_TOKEN`, and execs the real `claude`. The daemon only starts the `claude` on PATH and does not see the value (4.2)
- Secrets Manager ($0.40 per item per month) is not used, because automatic rotation is not needed
- All Switchboard adds is "knowing that the login has expired" (`/api/health` and the warning on Home). Redoing it is done in the terminal tab or the AWS console, and no dedicated input screen is built (the proposal of 2026-09-21). The current form: the warning's "`ログインする`" button can run the runner's own login command (`claude auth login`, `codex login --device-auth`) on screen: for codex a URL and a one-time code, for claude a URL and a field to paste the code. The runner writes the credentials, and the pasted code is kept in no log, DB or API response (`packages/core/src/runnerlogin.ts`, `apps/web/src/components/RunnerLogin.tsx`)
- Caution: the runner's process and its children (the shells the agent uses) can see the runner's credentials. A setup-token can be used only for model calls, so the impact of a leak is narrow
- The target is a setup where an individual uses it with their own authentication (for the usage-terms caution, see "No keys, no telemetry" in the README)

- Getting into the UI and the rescue page is by the passkey of §3. The only secret Switchboard's code holds is the daemon's token, which comes from the environment layer (Parameter Store → sb-env). The agent is the same OS user, so it can read it, but that token does not get anyone in from outside. The public key that checks the cookie is not a secret, and the signing seed is read only by the start Lambda

- Access log and operation log: only when listening on something other than loopback, the daemon writes one JSON per line to standard output (sb-rescue writes it to `~/.switchboard/daemon.log`; no new file or rotation is added). `{"log":"access"}` is one line per request, with the time, the peer, the method, the path (without the query), the status, and the kind of authentication (`cookie` / `token` / `none`; this is the kind presented, and whether it passed is seen from the status). For the peer, CloudFront's `CloudFront-Viewer-Address` is trusted only on requests where the shared header passed; otherwise it is the connection peer. `{"log":"op"}` is `pty.open` (Task id), `task.create.danger`, `daemon.restart`, `daemon.promote`, `settings.update` (only the names of the changed keys) and `workspace.add` (the path). Bodies, queries, cookies and token values are not written. Loopback is not logged, as before. To read it, filter `~/.switchboard/daemon.log` with `jq`

### 4.1 Detecting an expired login

- The runner entry of `/api/health` carries `login` (`ok` / `expired` / `unknown`) and `loginHint` (the command to type to redo it). The judgment is the exit code of the runner's own status command: `claude auth status`, `codex login status` (0 = ok, non-zero = expired, no such subcommand or no answer in 10 seconds = unknown). Of the output of `claude auth status` only `authMethod` (`claude.ai` / `api_key`) is read and shown as `loginKind` (`claude.ai` / `console`). The account, email and organization are not read. DAK has no `login`. `POST /api/runners/claude/logout` runs `claude auth logout` and then re-reads the state
- The status command runs at startup and, when `/api/health` is read, if 60 seconds have passed since the last run. The "`再確認`" on Home (`/api/health?recheck=1`) runs it without waiting
- If a turn ends with the runner's "not logged in" text (`packages/core/src/login.ts`), the state is made `expired` even when the status command says ok, and `loginHint` is shown on the Task. It goes away when the next check returns ok or a turn of that runner goes through
- Expiry (added 2026-11-05): from Claude Code 2.1.318, `claude auth status` also prints `loginExpiresAt`. Switchboard reads that key and `authMethod`, nothing else, and puts it in the runner entry as `loginExpiresAt` (epoch ms; an ISO 8601 string or a number is accepted). It is left out when the key is missing or unreadable (an older CLI, broken JSON), when `login` is not `ok`, and on Bedrock.
- When the expiry is known, the runner choice on Home shows it in its tooltip ("`Claude のログイン M/D HH:mm まで`" and the command to log in again). Only when fewer than 72 hours are left does the claude entry of the status bar at the bottom show the same time in the warning colour (long enough to be seen at least twice across a night).
- Home shows a warning for each runner whose login has expired (for codex it tells the user to run `codex login --device-auth` in the Task's "`ターミナル`" tab). The login is done by the runner itself, in the terminal tab or with the warning's "`ログインする`" button
- That Switchboard's code holds no credential file names or token variable names, and that no token from the daemon's environment appears in `/api/*` responses, is pinned by `packages/core/src/nokeys.test.ts`

### 4.2 Putting a setup-token in Parameter Store (Claude, when logging in from the terminal is not possible)

1. Run `claude setup-token` and note the token shown (the validity period follows what is shown at issue)
2. `aws ssm put-parameter --name /switchboard/claude-oauth-token --type SecureString --value '<token>' --overwrite` (AWS-managed KMS key; if you do not want it in the shell history, create it in the AWS console). Allow `ssm:GetParameter` on this parameter only for the instance role (the IaC does this)
3. Put the real `claude` at a place such as `/usr/local/lib/claude/bin/claude`, and put the wrapper early on PATH under the name `claude`: `install -m 755 scripts/host/claude-wrapper.sh /usr/local/bin/claude`. PATH is in the order `/usr/local/bin:/usr/local/lib/claude/bin:…` (the wrapper skips its own directory and execs the next `claude` found on PATH)
4. Put `SWITCHBOARD_CLAUDE_TOKEN_PARAM=/switchboard/claude-oauth-token` in the daemon's environment (the systemd unit). The value itself is placed nowhere. The wrapper reads it at every start, so it is not left in a file either
5. Expiry or revocation: a warning appears on Home (4.1). Redo `claude setup-token`, update the parameter's value in the AWS console (phone is fine), and press "`再確認`". No daemon restart is needed
- When it cannot be read (permission, a wrong name, the network) the wrapper prints `claude-wrapper: could not read …` and stops, and the Task ends in an error. Check: `scripts/host/claude-wrapper.test.ts` (a fake `aws` and a fake `claude`)

### 4.3 The daemon's failure-count limit

The same rule as the Starter's (`aws/auth.ts`) is placed at the daemon's entrance too. When entrance and authentication refusals (`guard` / `entryGuard` / `/ws` / `/ws/pty` / the 401 and 403 of `/mcp/:id`, and `notViaEdge` / `notAllowedHost` of static serving) reach 10 in 10 minutes from the same source key, every route answers 429 from then on (even with a valid cookie) until the window is left. The key is the address in CloudFront-Viewer-Address (trusted only when the shared header matches), and for IPv6 the /64. Requests that are not counted: those whose connection peer is loopback (the runner's `/mcp`, sb-rescue's probe), and those for which Viewer-Address does not arrive in a setup that goes through CloudFront (until it arrives everyone looks like CloudFront's one address, and the users would be locked out together). A 403 returned by a handler (a change to another Task, and so on) is not counted. The limit and the window are not made settings. The window slides: it is released when the refusals in the last 10 minutes fall below 10 (the moment the last 10 no longer fit within 10 minutes). A daemon restart releases it too. The screen sends no other `/api` or `/ws` until `/api/health` answers that it is logged in (so that opening it in a browser without a cookie does not make it count a refusal each time). How it is measured: `scripts/login-refusals-e2e.ts`.

## 5. Migrating history (in a form that can `--resume`)

**Create at the default paths, and match them with `relocate` after the import.** Create the instance with `HostHome=/home/switchboard` and `ReposDir=/home/switchboard/repos` (the template defaults). Do not reproduce the HOME or the repository location at export time (so that the paths of an external SSD, which mean nothing on EC2, are not carried over for good).

- After the import, with the daemon still stopped, run `bun packages/core/src/main.ts relocate --from <repository location at export time> --to /home/switchboard/repos`, then `--from <HOME at export time> --to /home/switchboard` (one prefix pair at a time; in this order also when the repository location is under HOME)
- What is rewritten (a prefix is replaced at a path boundary; `/home/dev` does not match `/home/devx`):
  - DB: `workspaces.path`, `tasks.cwd`, `tasks.scope` (the root of the JSON), `routing_log.cwd`, `staging.path`, `attachments.path`, `history_imports.path`
  - Claude's session folders: rename `~/.claude/projects/<old name>…` to `<new name>…` (memory is under the same folder). The folder-name part of `history_imports.path` follows the same mapping
- What is not rewritten: the contents of Claude's jsonl and Codex's rollout (the `cwd` inside stays the old path as history; what resuming needs is the file's location and the cwd Switchboard passes), and `knowledge_docs.path` (relative to `~/Knowledge`; if an absolute row exists, relocate stops)
- It checks before writing, and if it stops anywhere it writes nothing (the stop conditions are in `packages/core/src/relocate.ts`)
- No compatibility layer that can also read old paths and no symbolic link to the old path is made (rewriting is a single command)
- Paths that do not exist on this machine, such as a worktree under `/private/tmp/...`, are not created. Such a Task can still show its list entry, transcript and diff, and replying shows `作業フォルダ … がこの機械に無い` ("the working folder … is not on this machine") and the Task becomes error (the API returns 409). The daemon does not stop
- On the AWS stack bootstrap starts the daemon right after the import, so relocate is done by hand afterwards, and the machine is rebuilt with the GitHub workflow's `rebuild` (Actions → host; stop the daemon and also the rescue page (sb-rescue) first) (the relocated DB comes back, the Workspaces are cloned into the new `ReposDir`, and the renamed folders are extracted)

### Package

One file made by `bun packages/core/src/main.ts export <out>` (a tar compressed with zstd; encrypted with age under `--encrypt`):

```text
manifest.json      version, the name of the exporting machine (`host`), HOME, creation time, counts (tasks and the number of files in each folder; null if the source is missing), each file's sha256 and permissions, empty folders
switchboard.db     a snapshot of the DB (VACUUM INTO. A consistent state including the WAL. The same method as sb-rescue)
claude/projects/   ~/.claude/projects (including those other than registered Workspaces)
codex/sessions/    ~/.codex/sessions
attachments/       ~/.switchboard/attachments
knowledge/         ~/Knowledge (the whole folder; with git, .git is included)
```

It reads files one by one from the source and streams them into tar → zstd → (age). The only copy it makes is the DB snapshot, and it never holds the whole thing in memory (handling everything in memory would get the daily archive of gigabytes of history oom-killed on a host with a few GB of memory).
The working directory (the DB snapshot) is not the RAM-backed /tmp but `~/.switchboard/export-<pid>`. What cleanup did not remove after an oom-kill or the like is removed by the next export at its start, as an `export-*` whose owner process is gone.

The daily archive (`sb-archive`, `aws/host/archive.sh`) writes its result as one line to `~/.switchboard/archive.status`. If it failed, if it started and has not finished in 2 hours (cleanup does not run after an oom-kill or the like), or if it has not succeeded for 48 hours, the daemon's `/api/health` `archive` shows a red banner at the top of the Web UI. It goes away on the next success.

### History moved from the local disk to S3

After uploading the archive, the daily archive takes the conversation events (`events`) of each Task that has finished (`done` / `error` / `aborted`) and was last updated 30 days ago, makes one file per Task, puts it at `s3://<DataBucket>/history/events/<year>/<taskId>.<last seq>.jsonl.zst.age`, and replaces the local rows with a skeleton only for the Tasks that were put there. The encryption key is the same as the daily archive's (`/switchboard/archive-age-pubkey`; the user holds the private key). `history/` has no expiry, and the instance role can write only to new keys (it can neither overwrite nor delete; deleting is done by the user with their own credentials). A Task that failed to upload keeps its local rows and is tried again the next day, and `archive.status` becomes `failed <epoch> 3` (the banner appears). If a moved Task is resumed and finishes, 30 days later the part after `seq` becomes a separate file. The keys placed in the Task's `events_archive_key` stay, one line each, oldest first.

How to get one back (the file is one event per line, `{"seq":…,"ts":…,"json":"<the original row>"}`):

```bash
sqlite3 -readonly ~/.switchboard/switchboard.db "select events_archive_key, events_archived_count from tasks where id = '<taskId>'"
aws s3 cp s3://<DataBucket>/history/events/<年>/<taskId>.<seq>.jsonl.zst.age .
age -d -i <秘密鍵のファイル> <taskId>.<seq>.jsonl.zst.age | zstd -d > <taskId>.jsonl
wc -l < <taskId>.jsonl                                  # = events_archived_count（最後のキーの分）
jq -c '.json | fromjson' <taskId>.jsonl | head          # 出来事そのもの
```

The instance role can read `history/`, but the private key is not on the instance, so decryption is done on the user's device.

### Moving old runner transcripts to S3

The daily archive keeps on the local disk, of `~/.claude/projects` and `~/.codex/sessions`, the newer files up to 10 % of the root disk (`RUNNER_KEEP_MB` in `archive.sh`; overridden by `SB_RUNNER_KEEP_MB` in `/etc/switchboard-host.env`), packs the older files beyond that into one `runner-<UTC date-time>.tar.zst.age` per run (the same key as the daily archive), and puts it in `s3://<DataBucket>/history/runner/` (written to new keys only: `If-None-Match: *`). `history/` has no expiry. It deletes the local files only after confirming they were uploaded, and if the upload fails it deletes nothing and `archive.status` becomes `failed <epoch> 4` (it is tried again the next day; if the events failure `3` happens on the same day, `3` is shown).

What it does not delete: anything under `memory/` (it is not a conversation transcript; Claude reads it), and files whose path contains the session id of a running or waiting (`running` / `waiting` / `idle`) Task or of a Task with a scheduled resume (`resume_at`) (looked up by opening the DB read-only; if the DB is missing or unreadable, nothing is moved). Files that were updated during the upload (mtime or size differs from before the upload) are not deleted either (between checking and deleting there is a short gap per file, and the chance that an append lands in it is treated as negligible, so the file is kept).

The list is the local `~/.switchboard/runner-archive.tsv` (one file per line: `original path (from ~)<TAB>session id<TAB>S3 key<TAB>date moved`).

```bash
grep <session id> ~/.switchboard/runner-archive.tsv          # どのキーに入っているか
aws s3 cp s3://<DataBucket>/<キー> .
age -d -i <秘密鍵のファイル> runner-<日時>.tar.zst.age | zstd -d | tar -x -C <展開先> <元のパス>
```

Claude Code itself also deletes transcripts older than 30 days by default (`cleanupPeriodDays`; check the value in this version on a running machine). In addition to what exceeds the local quota, anything older than 25 days (`RUNNER_MAX_AGE_DAYS` in `archive.sh`; before Claude's 30-day cleanup) is always moved too, so while the instance is running they are left in S3 before the 30-day cleanup. Even if a moved Task is `--resume`d, the file is not local, so it continues without the earlier context (the same as `## Files needed to resume`). `runner-sync` is unchanged: when the local volume shrinks, the base and the differences get smaller too.

### Procedure

1. **Export.** **Stop the daemon first, and close the terminal's Claude / Codex.** The DB becomes a consistent copy with VACUUM INTO, but the runners' logs and attachments are copied one after another afterwards, so if things are running the DB and the files can disagree (for example, if an attachment moves to a Task after the DB was copied, the row exists but the file does not)

   ```bash
   age-keygen -o ~/switchboard-migration.key        # 鍵は利用者が持つ。公開鍵（age1…）が表示される
   bun packages/core/src/main.ts export ~/switchboard-export.tar.zst.age --encrypt age1…
   ```

   It does not write to an existing file (it stops if the same name exists). The output is 0600. If `age` is missing, install it (`scripts/setup.sh` shows whether it is there)
2. **Transfer**: `scp ~/switchboard-export.tar.zst.age <host>:`, or via S3 (put it with `aws s3 cp` and fetch it at import time). It is encrypted, so the place does not matter. Send the key file by a separate route (a password manager, for example)
3. **Import.** **After stopping the daemon**, into an empty HOME:

   ```bash
   bun packages/core/src/main.ts import ~/switchboard-export.tar.zst.age --identity ~/switchboard-migration.key
   ```

   Conditions under which the import stops (all of them stop without writing anything):
   - The importing side's DB has one or more Tasks, or any of `~/.claude/projects`, `~/.codex/sessions`, `~/.switchboard/attachments` and `~/Knowledge` is not empty (it neither merges nor overwrites; there is no `--force`)
   - It is encrypted but there is no `--identity` / the key is wrong
   - What was extracted does not match the manifest (missing or extra files, sha256, the Task count, the number of files per folder, an empty folder pointing outside the package). Symbolic links are not extracted and not placed (the package carries regular files only; file permissions and empty folders are written to the manifest and restored)
4. **Match the paths** (with the daemon still stopped): the two `relocate` runs above. Note the counts in the output (the rows per column and the number of renamed folders)
5. **Log in to the runners** (credentials are not put in the package; §4): `/login` of `claude`, `codex login --device-auth`
6. **Check**: start the daemon, and `curl -s localhost:47831/api/tasks | jq length` is the same as the manifest's `tasks`. Reply with one line to a moved Task, and check that the runner answers from where the earlier conversation left off with `--resume` (Claude) / `thread/resume` (Codex)

### Files needed to resume (findings of 2026-09-23)

| Runner | What is needed | What is not needed (recreated at first start) | How it was checked |
|---|---|---|---|
| Codex (codex-cli 0.155.0-alpha.9.2) | Only `~/.codex/sessions/**/rollout-*.jsonl` | SQLite files such as `state_5.sqlite`, `thread_history_1.sqlite` and `logs_2.sqlite`, `installation_id`, `shell_snapshots/` and the like (generated at first start) | Make `CODEX_HOME` a temporary directory, put only one rollout in `sessions/2026/09/22/`, and send `codex app-server` `initialize` → `thread/resume {threadId, cwd}` (no turn is sent). The thread comes back with its turns and `thread.path` points at the copied rollout. A `401 Unauthorized` on stderr comes from the pre-connection that lacks `auth.json`; it does not stop the resume |
| Claude Code (2.1.280) | Only `~/.claude/projects/<the cwd joined with ->/<sessionId>.jsonl` | `.claude.json`, `backups/`, `sessions/` (generated at first start) | Make `CLAUDE_CONFIG_DIR` a temporary directory, put only one session file, and run `claude -p --resume <id> </dev/null` (no prompt, no credentials). For a nonexistent id: `No conversation found with session ID`; for the placed id: `No deferred tool marker found in the resumed session … Provide a prompt to continue the conversation.` (the session was found, and it says there is no prompt to continue with) = it is found from the file alone |

Reproduction steps (`<id>` is the session / thread id, `<cwd>` is that session's working folder, and `<enc cwd>` is the name made by turning the `/` and `.` of `<cwd>` into `-`):

```bash
# Codex: rollout 1 本だけの CODEX_HOME で app-server に resume だけを送る（turn/start は送らない = 枠を使わない）
export CODEX_HOME=$(mktemp -d); mkdir -p $CODEX_HOME/sessions/2026/09/22
cp ~/.codex/sessions/2026/09/22/rollout-*-<id>.jsonl $CODEX_HOME/sessions/2026/09/22/
cd <cwd> && codex app-server --listen stdio://
> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"},"capabilities":null}}
< {"id":1,"result":{"codexHome":"<CODEX_HOME>",…}}
> {"jsonrpc":"2.0","method":"initialized"}
> {"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{"threadId":"<id>","cwd":"<cwd>","approvalPolicy":"untrusted","sandbox":"read-only"}}
< {"id":2,"result":{"thread":{"id":"<id>","path":"<CODEX_HOME>/sessions/2026/09/22/rollout-…-<id>.jsonl","turns":[…],…},…}}

# Claude Code: セッション 1 本だけの設定ディレクトリで、資格情報もプロンプトも無しに --resume
export CLAUDE_CONFIG_DIR=$(mktemp -d); mkdir -p "$CLAUDE_CONFIG_DIR/projects/<enc cwd>"
cp ~/.claude/projects/<enc cwd>/<id>.jsonl "$CLAUDE_CONFIG_DIR/projects/<enc cwd>/"
cd <cwd> && env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude -p --resume <id> --output-format json </dev/null
# → Error: No deferred tool marker found in the resumed session. … Provide a prompt to continue the conversation.
# 知らない id なら → No conversation found with session ID: <id>
```

In both, the credentials (Codex's `auth.json`, Claude's Keychain / `.credentials.json`) are separate and are made by the login of step 4. Things that can be regenerated, such as `~/.codex/plugins`, are not included (out of scope for this migration).

Checking that "a moved Task answers from where it left off when replied to" with a real runner is done only once (it costs money, so do it after the user's approval).

Storage and cost: compressed it is around 0.5 GB a year, and even ten years in S3 is in the teens of yen a month. The contents (code and secrets) matter more than the volume, so it is put there after encryption.

## 6. Recoverable when broken — recovery design

The requirement is that even when a self-update ends in an error, recovery should not require forcing a way in over SSH. It is protected in three stages.

### 6.1 Do not run the live daemon from a tree being edited

- The self-update of the development `bun run dev` (`docs/design/self-dev.md`) restarts with the work tree's code. A broken change becomes the running daemon as it is
- In production, `~/.switchboard/releases/<sha>/` (`git archive` + `bun install --frozen-lockfile` + the Web build; a single binary was closed as not planned on 2026-10-11) is placed as an immutable release and switched with the `current` / `previous` symbolic links (the current specification is `docs/design/releases-and-rescue.md`)
- What the agent edits is only the worktrees of `<repos>/switchboard`. Until it is merged and a release is made, the running daemon is not affected

### 6.2 Promote automatically with a trial, and roll back automatically if it fails

Replace "apply and restart the daemon" with "promote this version":

1. Make the release (currently: build on the machine. `rescue/src/releases.ts`. CI only tags a green merge and places no artifacts)
2. Take a DB snapshot just before the promotion (currently: `VACUUM INTO` into `snapshots/`, the newest 10. Litestream's replication runs separately and continuously)
3. Start the candidate version on another port. The DB is a copy of the snapshot. Check `/api/health`, the Task list, the WebSocket connection and runner detection
4. If it passes, switch `current` and restart on the production port. If the same check does not pass within 60 seconds (currently it must also pass 10 seconds after that), return to `previous` and restart
5. The result is recorded in the rescue service (6.3) and shown in the UI

DB migrations are additive only (no column is dropped). An old version can run on the new schema, so rolling back does not need the DB to be rolled back.
For the case where it is still broken after rolling back, a restore button to the snapshot is also provided.

### 6.3 A rescue service that runs separately from Switchboard (sb-rescue)

- A small independent process (a separate systemd unit) that shares no code with Switchboard. **It is not a target of the agent's self-update** (changes only by PRs a person reviewed, and never promoted automatically)
- Behind the same CloudFront and passkey, it shows a one-screen page, usable on a phone, at `/rescue` (a CloudFront behavior routes to sb-rescue's port):
  - The current version, the state, the last 200 lines of the log, the promotion history
  - [`再起動`] [`前の版に戻す`] [`版を選んで戻す`] [`DB をスナップショットから戻す`]
  - [`救援エージェントを起動`]: runs `claude -p` in the repository's worktree with the log of the failed version and the latest diff, and streams the output to this page. The fix is made into a PR (no direct promotion)
  - Buttons that change state ask a person who came in with a cookie for a passkey check within the last 5 minutes (`sb_recent`, §3). The page asks for the check and then continues
- In the proposal it was "with systemd's `OnFailure=`, roll back to `previous` automatically after 3 failed starts". The current form is that sb-rescue runs the daemon as a child, restarts it 1 / 2 / 4 seconds after it falls, and after the third time stops at `failed` and **does not change the version** (unless it is in the middle of a promotion, the version to return to is not necessarily right). Returning is done with a button on the rescue page (`rescue/src/supervisor.ts`, `docs/design/releases-and-rescue.md`)

### 6.4 When the whole machine is broken

- [`起動する`] [`作り直す`] are placed on the login and start page outside the machine (`/_auth`, the start Lambda). The [force restart] in the proposal does not exist (a restart inside the machine is the rescue page's [`再起動`])
- "Rebuild" creates a new instance from IaC and restores from the latest release in S3 + Litestream + the history archive (proposal). The current form does not recreate the instance but replaces the root volume with its state at launch (`/rebuild` of `aws/starter.ts`, `CreateReplaceRootVolumeTask`; because the instance id and the VPC origin do not change). EC2 restarts and UserData runs again, clones the stack's `GitHubRepo`, and runs `aws/host/bootstrap.sh`. Bootstrap first switches to the main of `/switchboard/github-repo` (the same parameter and the same way of fetching as `sb-host-update`; when it cannot be read or fetched again, it prints the reason to stderr and continues with the `GitHubRepo` clone), clones the repositories from GitHub again, installs sb-rescue, and builds the release on that machine. No release is placed in S3. sqlite comes back from Litestream and the runners' records from the save below. So a rebuild needs to reach GitHub
- The same operation is also provided as GitHub Actions `workflow_dispatch` (a second route that can be run from the GitHub app on a phone; it enters AWS by OIDC)
- **Cloning registered workspaces**: bootstrap on a rebuild clones those workspaces in the DB whose folder is missing under `ReposDir`, from the `repository` of `workspaces.backlog_source` (those whose `service` is `github`). It does not clone with a name assembled from the folder name (a public repository of the same name had been cloned that way). A workspace with no registration or not on GitHub is not cloned, and a line `bootstrap: not cloning <name>: …` is printed
  - After the clone, it checks whether the repository name that `gh repo view` inside the clone answers is the same as the registered `repository` (ignoring case), and, if the registered `private` is true, whether the clone is private too. If they differ or there is no answer, it does not delete that clone but moves it aside to `<path>.unverified-<UTC time>` and prints `bootstrap: moved <name> aside: <reason>` (so that the contents can be examined). `private` is written by the backlog import, and an import from a different checkout does not rewrite the registration (`refuseAnotherCheckout` in `backlog-sync.ts`)
  - When a workspace's folder is missing because of moving aside or a failed clone, or when the folder's origin differs from the registration, a notice "`workspace <name> を使えません`" appears in the awaiting-decision list, with the reason and how to fix it (it is built from the current state each time it is read, and is resolved once fixed; `unusableWorkspaces`). Tasks of that workspace stop before the runner is started, and the reason stays on the Task (create and resume; `originMismatch`)
- **The runners' records are restored too**: Switchboard's DB comes back from Litestream, but the runners' own records (`~/.claude/projects` = Claude's conversation files (needed by `--resume`) and memory records, `~/.codex/sessions`) and the copy of the artifacts (`~/.switchboard/artifacts`; the rows are in the DB) exist only on the disk. `sb-runner-sync` (`aws/host/runner-sync.sh`) turns them into tar + zstd and puts them as a **set** under `s3://<data>/archive/runner/<set>/`. `<set>` is the epoch seconds at which the base was uploaded, and it holds `base.tar.zst` (everything; every 7 days) and `<epoch>.tar.zst` (the differences: only the files changed since the previous run, by ctime). Every key is written only once (nothing is overwritten, so no old versions arise from versioning). Restoring is `sb-runner-sync restore` (bootstrap calls it as Switchboard's OS user), which extracts the latest set's differences newest first and the base last, with `--skip-old-files` (each file keeps its newest version, and an existing file is not overwritten. Only `~/.claude.json` is the current file laid over the saved first-run setup and trust). The old-format `latest.tar.zst` is not read. When the saved targets change (remembered in `~/.switchboard/runner-sync.dirs`), differences would not bring in files that already exist, so the base is taken again
  - When: every hour (`sb-runner-sync.timer`; a difference is uploaded only when a file has changed), just before the automatic stop (`sb-stop`), and just before the rescue page's "`作り直す`" (sb-rescue runs `SWITCHBOARD_REBUILD_SAVE_CMD`, and if it fails or does not finish in 10 seconds it does not rebuild and shows the reason. The reason is returned as 424 and also kept in the rescue page's state (`lastError`) — 502 / 504 are replaced by CloudFront with the start page and do not reach the screen). What is lost is, in a rebuild that does not go through the rescue page (a disk failure), up to the last hour
  - Protection: the same as Litestream's replication (bucket encryption; only this stack's instance role can read it). Unlike the daily archive (the user's age key), the instance can restore it by itself. Login information (`~/.claude/.credentials.json`, `~/.codex/auth.json`) is not included
  - `archive/` is deleted after 30 days, so a new set (from the base) is made every 7 days. Old sets are not re-uploaded and are removed by the expiry. The expiry counts from the last upload, so it runs out 23 to 30 days after stopping (it remains another 30 days as an old version, and a person can restore it from the S3 console). **This is a temporary save for rebuilding, not a long-term backup**: the rescue page's rebuild uploads again just before it is pressed, so the expiry does not matter, and it matters only when "the machine is rebuilt without going through the rescue page / the disk breaks after a long stop". The daily archive is in the same `archive/` and is not made while the machine is stopped, so **if that rebuild or failure happens after being stopped for about 60 days (30 days + 30 days of old versions) or more, the runners' records come back from nowhere**. Switchboard's history (the DB) comes back from Litestream's replication (`litestream/`, no expiry)
  - A session in progress is written to even while tar is reading it. GNU tar then ends with 1, but the archive is complete, so it is uploaded (only the last line of that file may be cut; on 2026-09-27 we confirmed that a cut conversation file can still be resumed with `claude --resume`). For unreadable files or folders (tar's 2) it does not upload (so that a missing save does not overwrite a correct one)
  - Restore is skipped only when "nothing exists yet" (there is no base in `archive/runner/`). For any other failure (a failure of `aws`) bootstrap stops (the same as Litestream: so that a near-empty save does not overwrite a correct one)
  - A cost example (not measured): assume the compressed base is 350 MB and one hour's difference is 5 MB. Running all the time, the amount written per day is 350 MB ÷ 7 + 24 × 5 MB = **170 MB**. Since no key is overwritten, about 60 days (30 days of `archive/` + 30 days of old versions) come to **10.2 GB**. At S3 Standard Tokyo $0.025/GB-month at design time, that is about $0.26/month. A method that overwrites the same key would keep the whole save as many times as it was written, because of versioning.

- **What a rebuild keeps.** The root volume is replaced and the old one is deleted, so a file comes back only if something outside the disk holds it. These rows sort HOME as it stood on 2026-11-01, when attachments, recordings and notes were lost because they were only in a manual save; `aws/host/host.test.ts` holds the first row to the list in `aws/host/runner-sync.sh`. Restore lays differences over the last base and records no deletions, so a file deleted within the last 7 days can come back.

| What | How it comes back |
|---|---|
| `.claude/projects`, `.codex/sessions`, `.switchboard/artifacts`, `.switchboard/attachments`, `.switchboard/fixtures`, `Knowledge`, `.claude/CLAUDE.md`, `.claude/agents`, `.claude/commands`, `.codex/AGENTS.md`, `.codex/config.toml`, `.aws/config`, `.switchboard/claude-state.json` (only the first-run setup and the folders' trust out of `.claude.json`; restore lays the file devtools wrote over it), `.switchboard/routing.yaml`, `.switchboard/pricing.json`, `.switchboard/mcp.yaml`, `.switchboard/evals`, `.switchboard/runner-archive.tsv`, `.switchboard/disk-history.tsv`, `.switchboard/releases/history.jsonl`, `.switchboard/work-keep.tar` (work trees with changes or commits no remote has, and each repository's origin; `sb-pre-rebuild keep-work`) | Saved by `sb-runner-sync` every hour, before an idle stop and before the rescue page's rebuild; `sb-runner-sync restore` in bootstrap brings them back |
| `.switchboard/switchboard.db` (with `-wal`, `-shm`) | Litestream |
| `repos/*` | bootstrap clones those with a registered GitHub repository; `sb-pre-rebuild restore-work` clones the others from the origin kept, and puts the kept work trees back at their paths and branches. A folder already there is left alone, and so is a repository bootstrap moved aside as unverified; what did not come back, such as a main checkout's uncommitted changes, stays in a dated copy of the tar next to it, on the disk only. Untracked files over 20 MB are named in the save, not kept. Dependencies (`node_modules`) are installed again |
| `.claude/.credentials.json`, `.codex/auth.json`, `.config/gh`, `.switchboard/token` | Logins, never saved: Parameter Store or a new login |
| `.aws/sso`, `.aws/cli` | Session caches, never saved: a new login |
| `.claude.json` (but for the state above), `.claude/settings.json`, `.claude/skills`, `.claude/plugins`, `.config/docker`, `.gitconfig`, `.docker`, `.bun`, `.local` (tools, docker's rootless data), `.npm`, `.cache`, `.codex/packages`, `.codex/plugins`, `.codex/skills`, `.codex/*.sqlite` and `.codex/models_cache.json` (Codex's own state; `.codex/sessions` is what resume needs) | Written or installed again by bootstrap, devtools, the daemon and the tools themselves when they first run; nothing of these is put back |
| `.switchboard/releases/<sha>`, `.switchboard/snapshots`, `.switchboard/tmp`, `.switchboard/suggest`, `.switchboard/docker`, `.switchboard/rescue`, `.switchboard/rescue-work`, `.switchboard/daemon.log`, `.switchboard/archive.status`, `.switchboard/runner-sync.*`, `.switchboard/.switchboard.db-litestream`, `.claude/backups`, `.claude/sessions`, `.claude/session-env`, `.claude/shell-snapshots`, `.claude/cache`, `.claude/downloads`, `.claude/usage-data`, `.codex/log`, `.codex/tmp`, `.codex/cache`, `.codex/shell_snapshots`, `.codex/installation_id`, the shell's dotfiles | Made again or not worth keeping: not saved |

- **Recordings have a second copy.** `.switchboard/fixtures` is in the hourly save above, and since 2026-11-05 also on the branch `recordings-vault` of the repository: a stack lost with its bucket loses the hourly save with it, and the recordings were lost twice before (the last time on 2026-11-01). The branch is never merged, and the public sync sends main's tree only. `bun scripts/fixtures.ts save` adds every file of the folder to it (a changed file replaces the branch's, one only on the branch stays), `fetch` writes the files the folder lacks (it overwrites none), and `sync` does both. The scheduled tag CI (`scripts/tag-ci.ts` with `SWITCHBOARD_FIXTURES`) runs `sync` first, so a recording reaches the branch on the next run of that schedule without anyone, and a folder emptied by a rebuild is filled again on that run, before its check for missing recordings (when it runs is the registered schedule's, `GET /api/schedules`). A clone whose origin has no such branch (a public clone, a fork) gets exit 2 with the reason; `save` makes the branch only with `--create`, so a public fork does not publish recordings.

### 6.5 The path by which root trusts main

Trust boundary: main's `aws/host/` runs as root. If a token that can write to main is handed to the instance, check main's protection and review path before deploying.

- There are two paths
  - On every rebuild: UserData clones the main of the stack's `GitHubRepo` and runs `aws/host/bootstrap.sh` as root (§6.4, `aws/README.md`). Bootstrap first re-fetches the main of `/switchboard/github-repo` into root's clone and switches to that bootstrap (the same parameter and the same way of fetching as `sb-host-update`). When it cannot be read or fetched again, it prints the reason to stderr and continues with the `GitHubRepo` clone. The switch works only when UserData's clone has this version of bootstrap (if `GitHubRepo` is the public copy, after it has been synced to that copy). How to check after a rebuild: a line appears in `journalctl --no-pager | grep 'bootstrap: running main of'`. This is the evidence of the switch, and `-b` is not added (if bootstrap restarts for a kernel update, the line stays in the previous boot). The line appears only when UserData's clone is a different repository; if `GitHubRepo` is the same as the parameter, it does not switch and the line does not appear. Check that the origin of root's clone points at the development repository with `git -c safe.directory=/opt/switchboard-host -C /opt/switchboard-host remote get-url origin` (it is root-owned, so Switchboard's OS user needs `safe.directory`). `sb-host-update` also re-fetches the same main at every start, so the origin alone does not show a switch
  - On every start: `sb-host-update` re-fetches main into a root-owned clone (with history, blobs later), checks out the sha of the promoted release (the name the `~/.switchboard/releases/current` link points to; 40 hex digits, and only when it is an ancestor of main), and, if `bash -n` of all scripts and a trial run of the new `sb-env` (written out to a temporary file, ending with 0) pass, installs the scripts in the table below into `/usr/local/bin` as root. When the sha is missing, malformed or not an ancestor, it uses main's head and prints the reason to stderr. A version whose trial run fails is not installed and the start continues with the installed version. What it reads from the host user's place is only the name the `current` link points to, and it runs nothing from there. What the host user can choose is only commits within main's history (a commit not in main cannot be chosen). `sb-host-update` itself is replaced only when it moves history forward from the origin of the installed version (the sha recorded in the root-owned `/opt/switchboard-host.updater`; the clone's head is not used because it goes back on promotion. When there is no record yet (right after bootstrap, or a host from before the record), the head of the clone in which the updater was installed is written to the record before the clone is replaced. On a promotion to an older release, the other scripts go back to that version, and the updater, which does the pinning and the trial run, stays). Fetch, checkout and trial run share a 60-second budget (within the unit's 90 seconds at start; the rest goes to sb-env and sb-rescue), and if 5 seconds do not remain for the trial run it installs nothing and starts with the current version. The host user's home is `SB_HOST_HOME` in `/etc/switchboard-host.env` (written by bootstrap; a host built before this line was added uses main's head until the next rebuild). The log is `sb-host-update: <sha> from release` / `from main`. What is replaced is defined by the list of `for src in …` in `host-update.sh`, and the "the main-trust path" test in `aws/host/host.test.ts` checks it against this table. In the same start it hands AL2023's latest repository security updates to the `sb-security-update` unit (`dnf --releasever=latest upgrade --security --refresh`; the start does not wait for it). What root runs is only the distribution's signed packages, and the range that runs as root from main does not change. Node.js is not a dnf package, so in the same start it hands `sb-node` to the `sb-node-update` unit (the start does not wait for it). It installs only the nodejs.org tarball of the version and sha256 pinned in `node.sh`, and replaces it only when the installed version differs

| Script | Name it is installed under |
|---|---|
| `aws/host/host-update.sh` | `sb-host-update` |
| `aws/host/sb-stop.sh` | `sb-stop` |
| `aws/host/sb-env.sh` | `sb-env` |
| `aws/host/archive.sh` | `sb-archive` |
| `aws/host/runner-sync.sh` | `sb-runner-sync` |
| `aws/host/offload.sh` | `sb-offload` |
| `aws/host/pre-rebuild.sh` | `sb-pre-rebuild` |
| `aws/host/node.sh` | `sb-node` |

- Why it is accepted: privileges do not increase. The agent can already write to main and trusts main. All that changes is the effort needed before main's contents run as root (one operation on the rescue page, a restart). merge-gate marks `aws/host/**` as `[聞く] セキュリティ` and does not merge without the user's confirmation. But merge-gate is advisory, and a route that rewrites main without going through it remains. If main can be protected (a ruleset or the like can be attached), protect it
- Rejected alternatives
  - B: root installs only the commit the user placed in Parameter Store. The management effort is heavy. If main cannot be protected, adding only commit pinning does not pay for the effort of placing a sha at every change
  - B': in addition to B, UserData / bootstrap also clone the same commit. The same reason as B
  - C: stop replacing the scripts. It does not meet the purpose of delivering script updates by something other than "rebuild", which is the purpose of `sb-host-update`

#### When to revisit

- Main can now be protected. How to check: `gh api repos/<owner>/<repo>/rulesets` no longer returns 403 "Upgrade to GitHub Pro …". A check looks at it: `bun scripts/host-trust-check.ts [--file-request]` (exit 0 = no trigger / 1 = trigger / 2 = cannot judge. `--file-request` files one request for a review at a trigger, and does not pile on if an open request with the same title exists). It is not scheduled by itself: if you register it, a monthly scheduled run (for example the one that runs merge-audit) is enough, and `GET /api/schedules` shows what is registered
- The repositories and permissions the instance's token can write have widened. How to check: shown on the `/switchboard/github-token` row of `aws/README.md` when the token is changed
- The range that runs as root has grown. How to check: the table above and the main-trust-path test in `host.test.ts`, and merge-gate marking `[聞く] セキュリティ` on a PR touching `aws/host/**`

At every stage, the user's operation is only a button in the browser (a phone is fine). The terminal and SSH are not used.

## 7. Relationship to DAK

DAK is an optional destination. If `SWITCHBOARD_DAK_URL` is unset, DAK is not registered (it does not appear among the runner choices). When using the DAK adapter, set `SWITCHBOARD_DAK_URL` to your own ADK REST endpoint. Deploying Switchboard's stack does not need DAK's development role.

## 8. Deployment check

Run the first-deployment check of `aws/README.md` on your own stack. Check self-update, history restore, runner re-login, and start and stop.

## 9. Unverified (needs measurement)

- Spot's price, interruption frequency and capacity in the region chosen
- The time from the button to the UI response and the time to switch to CloudFront's start page
- The number of concurrent runners against RAM
- The validity period of a setup-token, and the exit code of `claude auth status` through the wrapper
- Disconnection and reconnection of the phone terminal (PTY)
- The free tier, actual cost and budget-alert totals of your own contract
