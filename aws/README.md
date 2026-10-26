# AWS: Switchboard that runs only while it is used

PBI #181, design `docs/design/cloud-hosting.md` §3–§6. One stack `switchboard-host` in your AWS account and chosen region: an EC2 instance (Graviton, on-demand by default; optional Spot with stop on interruption), CloudFront as the only way in, an S3 start page for when the instance is stopped, a small Starter Lambda (start / stop / 作り直す), EventBridge Scheduler to wake it, S3 for the sqlite replica and the daily archive, and two budgets.

> Estimate the cost for your region, instance type and operating hours before deploying. See `docs/design/cloud-hosting.md` §3.2.

## What goes where

| | Where | Who writes it |
|---|---|---|
| The runners' logins | the instance (`~/.claude`, `~/.codex`, `gh`) — or the setup-token below | the runners themselves, in the terminal tab (§4) |
| `/switchboard/edge-header` | SSM SecureString; the same value is passed to the stack as `EdgeHeaderValue` | you, once |
| `/switchboard/start-token` | SSM SecureString; for machines only (the GitHub workflow, sb-rescue's 作り直す). A person never types it | you, once |
| `/switchboard/session-signing-key` | SSM SecureString: an Ed25519 seed, exactly 32 random bytes in hex. **Only the Starter reads it** (#701): it signs the `sb_session` / `sb_recent` cookies and the login's challenges. Replacing it (and the public key below) logs every browser out | you, once |
| `/switchboard/session-public-key` | SSM String: the seed's public key (raw 32 bytes, base64url, 43 characters). `sb-env` hands it to the daemon and sb-rescue, which check the cookie with it and cannot make one | you, once |
| `/switchboard/register-code` | SSM SecureString `<code>.<expiresMs>`, one-time: put by the agent to hand a person a passkey registration link; the Starter deletes it once used | the agent |
| `/switchboard/github-token` | SSM SecureString (fine-grained, your resource owner and only the repositories the host works on). **Before the first deploy**: the instance clones the repository with it to get its host scripts. Repository permissions: Contents, Issues, Pull requests, Workflows (read and write); Actions, Checks, Commit statuses, Variables, Metadata (read) — without Checks and statuses `scripts/merge-gate.ts` cannot judge a PR. When you widen the repositories it can write to, or its permissions, revisit `docs/design/cloud-hosting.md` §6.5 (#852): root runs what main holds. Organization permissions: Projects (read and write) — the backlog screen and the setup scripts read and write the organization's Project with it (#415) | you |
| `/switchboard/archive-age-pubkey` | SSM String (an `age` public key; the private key stays off AWS) | you |
| `/switchboard/daemon-token` | SSM SecureString (optional). The API token of the daemon and sb-rescue: `sb-env` writes it to `~/.switchboard/token` before every start, as the host user. It counts **only on the host itself** (loopback: the runners' `/mcp`, sb-rescue's probe, a Task's own `curl`); from outside — CloudFront included — only the passkey cookie gets in (#748). Rotate by updating it and restarting | you |
| `/switchboard/claude-oauth-token` | SSM SecureString, only if you use `claude setup-token` (`scripts/host/claude-wrapper.sh`, §4.2) | you |
| `/switchboard/anthropic-api-key` | SSM SecureString (the AWS managed key `alias/aws/ssm`), only if DAK runs on this host with Anthropic's API (#1155). **No script here reads it**: DAK's `agent/ssm_exec.py` reads it inside its container at start and hands it to its own server process (DAK's `docs/getting-started/anthropic.md`, `docker-compose.anthropic.yml`). The Compose file carries the parameter name and the model name only; the value never goes to a file, a Docker setting, a log or the Switchboard daemon. A key under a customer managed KMS key would need that key's decrypt permission too: do not add it on your own — ask | you |
| `cdn-logs/` in the data bucket | CloudFront's standard access log (#1490): every request, the login's included; 90 days. The host role can neither read nor delete it | CloudFront |
| CloudWatch Logs `/switchboard/host` | the daemon's `access` / `op` lines (#1490) from `~/.switchboard/daemon.log`, one stream per instance; 90 days, so a 作り直す does not erase it. The host role can only write to it | the CloudWatch agent |

The host role (and the boundary) can call Amazon Bedrock for **any model** (`bedrock:InvokeModel*` on every inference profile and foundation model; versions are not pinned, so a new model needs no deploy); no other Bedrock action, no API key (`docs/design/bedrock.md`).

CloudFormation cannot create SecureStrings, and a `String` placeholder would hold a secret in plain text, so the stack creates none of them. The instance role can read only the parameters the host's scripts read, listed by name in the template (the table's except register-code, and the stack's `web-url`, `starter-url` and `offload-project`), and nothing else in SSM: not `/switchboard/register-code`, so an agent on the host cannot use a registration link before the person it was made for (#700). A new parameter the host reads goes into that list too (`aws/template.test.ts` checks that the list names exactly the scripts' parameters plus `anthropic-api-key`, the one read by DAK rather than by a script).

Applying such a list change to the running host (#1156): compare the change set with the merged template first — it must add only the one `ssm:GetParameter` resource and touch neither `LaunchTemplate` nor `Instance` — then run the workflow's `deploy` (below) with the person's approval, and check it with `aws cloudformation describe-stack-events` or the `host` policy on the instance role. Then on the host, read the parameter once without printing it (`aws ssm get-parameter --name /switchboard/anthropic-api-key --with-decryption --query 'Parameter.Type' --output text` → `SecureString`, no AccessDenied), and start DAK's agent with its Anthropic Compose file: `docker compose -f docker-compose.yml -f docker-compose.anthropic.yml up -d --build agent` in the DAK checkout. Nothing is registered or overwritten here: the parameter, DAK's code and the GitHub secret for DAK's maintenance are not this repository's.

Backups: the data bucket keeps versions. The instance role (which agents can reach, since they run as the same OS user) writes only `litestream/` and `archive/`, reads `releases/`, may add a delete marker but cannot remove a version or change the bucket's versioning or lifecycle. Old versions and archives expire after 30 days. `history/` is what leaves the host's database for good (finished Tasks' events, #1431; transcripts, #1432): it has no expiration, and the instance role may read it and put a new key there, but not overwrite or delete one — removing something under `history/` is a person's job, with their own credentials. A put must carry `If-None-Match: *`, which `aws s3 cp` does not send: `aws s3api put-object --bucket <DataBucket> --key history/<…> --body <file> --if-none-match '*'` (an existing key answers 412 PreconditionFailed; without the header the role is denied).

Request logs (#1490): the daemon (off loopback) writes one JSON line per request and per strong operation to its output, the CloudWatch agent ships `daemon.log` to `/switchboard/host`, the Starter writes failed logins and the rate limit as `"log":"auth"` lines to its own Lambda log group, and CloudFront's standard log goes to `cdn-logs/`. The daemon's and the Starter's lines carry metadata only: no body, cookie, token or query value. CloudFront's own log cannot leave the query out, so a search term or a Task id in a query does appear there; the registration link's code is in the URL fragment (`#register=`) for that reason, so it never reaches any log. Deploy notes: the Data bucket gets ACLs enabled (`BucketOwnerPreferred`; the public-access block stays), which CloudFront's log delivery needs; the host's CloudWatch agent config is installed by bootstrap only, so an existing host needs one 作り直す before `daemon.log` is shipped; the daemon's lines carry the viewer's address once the distribution forwards `CloudFront-Viewer-Address` (until then, the connection's peer, i.e. CloudFront). Logs exist from the deploy on; there is nothing before it.

The way in: CloudFront reaches the instance as a **VPC origin** (by instance id, inside the VPC), one per port (47831 Switchboard, 47841 sb-rescue). The private address survives stop/start, nothing goes over the internet in plain text, and a stopped instance's released public IP is never contacted. The instance keeps a public IPv4 only for its own egress (GitHub, npm, the runners' APIs); the security group lets in CloudFront's origin-facing prefix list only. AWS documents VPC origins for instances in private subnets; the migration procedure there runs with the subnet still public, which is how this stack uses it — **confirm on the first deploy (#232)**. If CloudFront refuses it, the choices cost money and are the user's: a private subnet with a NAT gateway (about USD 45 a month) or a NAT instance, or an Elastic IP with an https origin. Pick a subnet outside apne1-az3 (no VPC origins there).

Roles: `HostAssumeRoleArns` is the exception to the resource scope below: the deployer may name extra roles the host may assume (empty by default). Every role the stack makes carries the `<stack>-boundary` permissions boundary, and the rest of the boundary names this stack's own resources (its parameters `/switchboard/*`, its two buckets, its instance by the stack tag, its roles `<stack>-*`, its log groups; KMS only through SSM and EC2 for the AWS managed keys). `DeployRole`, which the workflow (#232) updates the stack through, may create or change roles only with that boundary, cannot change the boundary, a trust policy or itself, and cannot touch another stack's instance — so a template change to `DeployRole` or `Boundary` needs a person's deploy. Nothing reachable from the internet can pass `DeployRole`: the Starter has no CloudFormation permission at all.

## Deploy (after approval)

`HostAssumeRoleArns` optionally grants the host permission to assume the listed role ARNs (comma separated, for example `HostAssumeRoleArns=arn:aws:iam::<account>:role/build-role,arn:aws:iam::<account>:role/check-role`). The target roles must also trust the host. Empty (the default) adds no AssumeRole statement to either the boundary or the host policy. Existing deployments must pass their additional role ARNs on the next deploy; omitting the new parameter removes that permission. Keep the override in the deployment parameters, including `SWITCHBOARD_HOST_PARAMS` if using the workflow. Inspect the change set: this migration must change only the boundary and host policies, with no change to Instance or LaunchTemplate.

Development repository owner/name is supplied as `GitHubRepo=<owner>/<repo>` at deploy time (no default; UserData clones it, so a new value replaces the instance). Set the administrator-owned SSM parameter too:

```bash
aws ssm put-parameter --name /switchboard/github-repo --type String --value <owner>/<repo>
```

Use `--overwrite` to change an existing parameter. The host reads it at every start (bootstrap and `sb-host-update`), so it follows a rename without replacing the instance — once the instance role may read it, which a stack deployed before #1946 does not allow (adding it is a list change, above). Without a readable, valid parameter, bootstrap clones the stack's `GitHubRepo` and `sb-host-update` the root-owned clone's origin, and each says so on stderr (`journalctl -u switchboard.service` for `sb-host-update`). Host-user worktree settings are never used for this root step.

AWS CLI v2, SAM CLI and a login for the profile. From the repository root.

```sh
# once: the parameters (use the console instead if you do not want the values in your shell history)
openssl rand -hex 32   # → EDGE; another one → START; a third → SEED (the login's Ed25519 signing key, #211 / #701)
PUBLIC=$(bun -e 'import { publicKeyOf } from "./aws/auth.ts"; console.log(publicKeyOf(process.argv[1]))' "$SEED")
aws ssm put-parameter --name /switchboard/edge-header --type SecureString --value "$EDGE" --profile YOUR_PROFILE --region <region>
aws ssm put-parameter --name /switchboard/start-token --type SecureString --value "$START" --profile YOUR_PROFILE --region <region>
aws ssm put-parameter --name /switchboard/session-signing-key --type SecureString --value "$SEED" --profile YOUR_PROFILE --region <region>
aws ssm put-parameter --name /switchboard/session-public-key --type String --value "$PUBLIC" --profile YOUR_PROFILE --region <region>
IMAGE=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text --profile YOUR_PROFILE --region <region>)   # pinned: change it only in a deploy you watch
aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text --profile YOUR_PROFILE --region <region>

sam validate --lint --template aws/template.yaml
sam deploy --template-file aws/template.yaml --stack-name switchboard-host --resolve-s3 --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region <region> --profile YOUR_PROFILE --no-execute-changeset --tags Project=switchboard \
  --parameter-overrides GitHubRepo=<owner>/<repo> ImageId="$IMAGE" VpcId=vpc-… SubnetId=subnet-… CloudFrontPrefixListId=pl-… BudgetEmail=… \
    EdgeHeaderValue="$(aws ssm get-parameter --name /switchboard/edge-header --with-decryption --query Parameter.Value --output text --profile YOUR_PROFILE --region <region>)" \
    HostUser=…
```

Look at the change set, then execute it. In Billing → Cost allocation tags, activate `Project`: budgets count only resources tagged `Project=<CostTag>`. Leave `HostHome` and `ReposDir` at their defaults unless you need different paths. Importing history from another machine is optional; follow `docs/design/cloud-hosting.md` §5 and use `relocate` to map old paths. For an existing host whose paths must change, use "Moving a host to the default paths" below.

The first deploy has no real `PublicOrigin`. Take the `Origin` output and deploy again with `PublicOrigin=https://<distribution>.cloudfront.net`. If your account already has a GitHub OIDC provider, pass `GitHubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.

**Host scripts**: the instance's UserData clones the repository's `main` with `/switchboard/github-token` and runs `aws/host/bootstrap.sh` from it (#230), on every new instance. Nothing is uploaded by hand; put `/switchboard/github-token` and `/switchboard/archive-age-pubkey` before the first deploy.

What `bootstrap.sh` sets up (once per disk): the host user with `HostHome`, bun / git / gh / age / Litestream (pinned versions, SHA-256 checked) / claude / codex, the repository in `ReposDir` (with the GitHub token), `sb-rescue` (`bun rescue/install.ts`), sqlite restored from Litestream when the disk is new and a replica exists, `claude-wrapper.sh` ahead of the real `claude` when `/switchboard/claude-oauth-token` exists, and the units:

| unit | what |
|---|---|
| `switchboard.service` | sb-rescue running the daemon from its release (#178); `SWITCHBOARD_HOST=0.0.0.0`, `SWITCHBOARD_IDLE_STOP_CMD=/usr/local/bin/sb-stop`; before every start, as root, `sb-host-update` (the host scripts again from `main`, #435) and the edge header and the other values from `sb-env` |
| `litestream.service` | sqlite → `s3://<DataBucket>/litestream/` (on stop it syncs the database and the replica one last time) |
| `sb-archive.timer` | daily `export --encrypt` → `s3://<DataBucket>/archive/`. Works in `~/.switchboard/archive-out` (on the disk, not /tmp), and writes the result to `~/.switchboard/archive.status` (#1201). Then finished Tasks' events 30 days old → `s3://<DataBucket>/history/events/` (kept; the rows are cut down only for what arrived, #1431, `docs/design/cloud-hosting.md`) |

`sb-stop <ISO|->` (called by the daemon after 20 idle minutes) registers `switchboard-wake` in EventBridge Scheduler (with `-`, removes a leftover one), stops Litestream (its last sync) and shuts down. The host user may run exactly those two commands as root (`/etc/sudoers.d/switchboard`). Writes the daemon makes between Litestream's stop and the shutdown stay on the disk (a start keeps them) but are not in the replica, so a 作り直す right after can lose those last seconds.

**Starter, login and start page** (#231, #211): build the Lambda before `sam deploy` (the template's `CodeUri` is `dist/starter/`), and after the deploy put the start page in the start-page bucket (it only sends the browser to `/_auth/`):

```sh
bun run --cwd aws build                       # → dist/starter/index.mjs
aws s3 cp aws/startpage/index.html s3://<StartPageBucket>/_start/index.html --profile YOUR_PROFILE --region <region>
```

**Calling the Starter directly (#1493)**: the Function URL answers 403 to every path, `/status` included, unless the request carries `x-switchboard-edge` (the value of `/switchboard/edge-header`, which CloudFront adds). Machines (the `host.yml` workflow, sb-rescue's 作り直す) send it together with the start token. Order of a rollout: install the new sb-rescue first (`bun run rescue:install` on the host, then restart sb-rescue — on the cloud host the 再起動 button; promoting the daemon does not update it), then deploy the Lambda — deploying it first makes the rescue page's 作り直す answer 403. After a deploy, `curl -s -o /dev/null -w '%{http_code}' <StarterUrl>/status` must print 403.

**Logging in (a person)**: open the distribution's URL. There is nothing to type: `/_auth/` (the Starter, through CloudFront, answering while the machine is stopped) logs in with a **passkey** (Face ID / a fingerprint), shows the machine's state, and starts it with one button when it is stopped; after 20–30 s it goes on to the page that was asked for. The cookie it sets (`sb_session`, HttpOnly, Secure, SameSite=Lax) ends 7 days after the login, or 24 hours after the last action (the body is `<passkeyId>.<idleUntilMs>.<expiresMs>`; #498), and is accepted by the daemon and by the rescue page (#235), so the web UI and `/rescue/` accept it (the strongest operations also need a recent passkey check, below). The Starter signs it with an Ed25519 seed only it can read; the host holds the public key alone, so nothing on the host — an agent included — can make a cookie (#701). The daemon and the rescue page also ask the Starter (`/_auth/status`) whether the cookie's passkey is still registered, keeping the answer 5 minutes; when it cannot be asked, the cookie is refused (#708). Starting, stopping, 作り直す, the rescue page's buttons and the daemon's terminal tab, restart, promote, workspace registration, settings save and dangerous-mode tasks also need a passkey check within the last 5 minutes (`sb_recent`, set with every login, #497, #1491; the table is in `docs/design/cloud-hosting.md`); the page asks for it and goes on. The passkeys live in the data bucket as `auth/passkeys.json` (public keys and counters only; the instance role cannot write there).

- **The first passkey, or every device lost**: the agent makes a one-time link and gives it to the person in chat:
  ```sh
  CODE=$(openssl rand -hex 16); EXP=$(( ($(date +%s) + 3600) * 1000 ))
  aws ssm put-parameter --name /switchboard/register-code --type SecureString --overwrite --value "$CODE.$EXP" --profile YOUR_PROFILE --region <region>
  echo "https://<distribution>.cloudfront.net/_auth/#register=$CODE"   # valid for an hour, once
  ```
  Opening it on the phone and confirming with Face ID registers that device's passkey and logs it in. This link is not capped by the 5 passkeys below (it is the way back when every device is lost).
- **Another device, from a logged-in one**: open `/_auth/#devices` (or `/_auth/` while the machine is stopped) on a device that is logged in. The 登録済みのパスキー card lists each passkey (device, registered, last used, この端末). 別の端末を追加 asks for that device's passkey — a signature made for this request, so the cookies alone (`sb_session`, `sb_recent`) cannot ask — and shows a one-time link (`/_auth/#register=<code>`, 10 minutes, a new one replaces the last); open it on the new device and confirm with Face ID. The Starter keeps only the code's SHA-256, in `auth/passkeys.json` (the instance role cannot read it). A device code brings the list to 5 passkeys at most (409 beyond that: delete one first).
- **Removing a passkey / logging everyone out**: on the same card, 削除 on a row, after a confirmation and the device's passkey (a signature made for this request); the last passkey cannot be deleted (409). Without a logged-in device, delete its entry from `auth/passkeys.json`. Either way the Starter refuses it at once, and the daemon and `/rescue/` within 5 minutes (open terminal and event sockets are closed on the same period, #708). The passkey stays in the device's password manager and in its picker; choosing it makes the login page call `PublicKeyCredential.signalUnknownCredential` (the Starter answers 401 `reason: "unknown"` for an id not in the list, #1312), so a browser that supports it hides the passkey from the next picker. A device without that API shows a sentence saying the passkey was removed; delete it in the device's password manager settings. To log everyone out, make a new seed and public key (as in Deploy), update both parameters, then reboot the instance (EC2 → Instance state → Reboot): `switchboard.service` starts again and `sb-env` hands the new public key to the daemon and sb-rescue. Not the rescue page's 再起動: until sb-rescue restarts it still holds the old public key, so it refuses every new cookie and the page is out of reach. The Starter reads the seed again within a minute. Without a seed (missing, or not 64 hex characters) the login answers 503 and signs nothing.
- **Moving from the old HMAC key** (`/switchboard/session-key`, before #701), once: put `/switchboard/session-signing-key` (a **new** seed from `openssl rand -hex 32`, never the old `session-key` value: the host could read that one, and a seed it has seen lets it make cookies) and `/switchboard/session-public-key` → merge #706–#748 → `sam deploy` (the Starter signs with the seed; the instance role reads the public key) → 作り直す (sb-rescue, `sb-env` and the daemon from main) → every device logs in once more → delete `/switchboard/session-key`. Between the deploy and 作り直す the old daemon cannot read the new cookies, so do the two back to back. A person's deploy from main must not carry the Starter without the rest (#709).
- Failed logins are limited per viewer (10 in 10 minutes; the viewer is CloudFront-Viewer-Address, an IPv6 address counted by its /64). The Starter runs at most 5 at once (reserved concurrency), so the open URL cannot run up the bill; `/_auth/status` without a cookie reads only the machine's state.

sb-rescue gets the Starter's URL and the start token from `sb-env`, which runs before every daemon start (on the very first boot the stack may not have written the URL yet: the button appears after the next restart), and shows 作り直す on the rescue page.

**The GitHub workflow** (`.github/workflows/host.yml`, Actions → host → Run workflow): `status`, `start`, `rebuild`, `deploy`. Its steps are `scripts/host-ops.ts` (#917): when Actions does not run, a person runs the same `bun scripts/host-ops.ts <action> --yes` with their own AWS CLI login (`--dry-run` prints the plan and calls nothing). A repository that uses GitHub's immutable OIDC subject (`gh api repos/<owner>/<repo>/actions/oidc/customization/sub` shows `use_immutable_subject: true`) sends `repo:owner@id/name@id:…`: pass its `sub_claim_prefix` as `GitHubSubPrefix`, or the role refuses the workflow ("Not authorized to perform sts:AssumeRoleWithWebIdentity"). With the prefix set, only that subject is trusted, not the name. Put `GitHubSubPrefix=…` in `SWITCHBOARD_HOST_PARAMS` too, so a stack made from those parameters alone does not lock the workflow out. Set these repository variables (the SSM names `/switchboard/start-token` and `/switchboard/edge-header` are the stack's own and stay as they are): `SWITCHBOARD_AWS_REGION` and `SWITCHBOARD_HOST_STACK` only when they differ from `ap-northeast-1` and `switchboard-host`, and `SWITCHBOARD_HOST_ROLE_ARN` (the `OidcRoleArn` output) and `SWITCHBOARD_HOST_PARAMS` (the non-secret `--parameter-overrides`, space separated, e.g. `ImageId=ami-… VpcId=vpc-… SubnetId=subnet-… CloudFrontPrefixListId=pl-… BudgetEmail=… HostUser=… GitHubOidcProviderArn=…`). `deploy` builds a change set run by `DeployRole` and executes it only when it touches neither the launch template nor the instance; anything else is a person's deploy. The SAM transform (`aws:transform/Serverless-2016-10-31`) runs as `DeployRole` too, so `DeployRole` may create the transform's change set; `DeployRole` cannot change itself, so until a person has deployed a template with that permission once, the workflow's `deploy` fails (red) on `cloudformation:CreateChangeSet` (#759).

## Narrowing who can reach it: countries and a Web ACL (#1492)

Both are off by default (the template's parameters are empty, so the distribution is as before). They are switches for when something looks wrong, not always-on protection.

- **Countries**: `AllowedCountries=JP` (comma-separated ISO 3166-1 alpha-2 codes) makes CloudFront answer 403 to every other country, before the Starter or the host. No extra cost. Remove it by deploying with `AllowedCountries=''`.
- **Travelling (#1639)**: with `AllowedCountries` set, a trip needs a temporary extra country; there is no way in from abroad, so set it **before leaving**.
  - (a) Before the trip: open the Web UI's Settings → 海外から使う (it goes to `/_auth/#countries`), log in with the passkey, and save the countries (2-letter codes, e.g. `US`), a start and an end (at most 90 days; an end is required; one allowance at a time). Saving and cancelling need a passkey check within 5 minutes. CloudFront takes a few minutes to apply it.
  - (b) It ends by itself: the Starter runs every 5 minutes and puts the whitelist back to `AllowedCountries` once the end has passed. If a redeploy puts the whitelist back to `AllowedCountries` while the allowance is in force, the next run restores the extra countries. With `AllowedCountries` empty (no restriction) nothing is touched.
  - (c) Forgot to set it, or want it back sooner while abroad: the page is not reachable from a country that is not allowed, so change `AllowedCountries` with your AWS permissions and redeploy (a person's deploy, as in the Countries line above). Every set, cancel, expiry and restore is one JSON line with `"log":"countries"` in the Starter's CloudWatch log group.
  - If the 5-minute run keeps failing (a missing parameter or permission, an SDK fault), a temporary country could stay allowed past its end unseen. So the Starter's errors have a CloudWatch alarm (`<stack>-starter-errors`: errors in each of three 5-minute windows) that mails `BudgetEmail` through an SNS topic; confirm the subscription AWS mails after the first deploy, or no mail arrives. On a mail, read the Starter's log group for the error and the `"log":"countries"` lines; to close the gap at once, set `AllowedCountries` by a deploy.
  - The first deploy of this feature changes the Boundary (a new `Countries` statement), so it is a person's deploy, not the workflow's `deploy`. Only the Starter's role may change the geo restriction (`cloudfront:GetDistributionConfig` / `cloudfront:UpdateDistribution` on this distribution); the host cannot.
- **Web ACL** (rate limits per source IP: 100 requests in 5 minutes on `/_auth/`, 2000 in 5 minutes on everything; the numbers are constants in `aws/waf.yaml`): a Web ACL for CloudFront exists only in us-east-1, so it is its own stack. It costs money every month while it exists (2026-10 list prices: Web ACL USD 5, two rules USD 1 each, USD 0.60 per million requests).

```sh
aws cloudformation deploy --template-file aws/waf.yaml --stack-name switchboard-waf \
  --region us-east-1 --profile YOUR_PROFILE --tags Project=switchboard
WEBACL=$(aws cloudformation describe-stacks --stack-name switchboard-waf --query 'Stacks[0].Outputs[?OutputKey==`WebAclArn`].OutputValue' --output text --region us-east-1 --profile YOUR_PROFILE)
# then the host stack's deploy above with the extra overrides:  WebAclArn="$WEBACL" AllowedCountries=JP
```

Taking the Web ACL off: deploy the host stack with `WebAclArn=''`, then delete `switchboard-waf` (a Web ACL still attached cannot be deleted).

## Offload (#678): docker checks too big for the host

The rootless dockerd runs in `sb-dockerd.service` with `MemoryMax=1536M`. Checks that exceed that limit are killed. `sb-offload` runs them off the host instead, in one build of the stack's CodeBuild project `<stack>-offload`: a fresh arm machine with docker (privileged, `aws/codebuild/amazonlinux-aarch64-standard:3.0`) that goes away when the build ends. The machine's size is chosen per call (#2304): `--size small|medium|large` before the command, small when it is left out. sb-offload passes it as the build's `--compute-type-override`, so the project's own `BUILD_GENERAL1_LARGE` applies only to a build started without sb-offload. Anything else (`xlarge`, a typo) starts nothing and exits 2. The largest on the list is the project's own size, so a build through sb-offload costs no more than before.

| `--size` | compute type | vCPU / memory | ap-northeast-1, on demand (checked 2026-10-22) |
|---|---|---|---|
| `small` (default) | `BUILD_GENERAL1_SMALL` (`arm1.small`) | 2 / 4 GiB¹ | USD 0.00425 a build minute |
| `medium` | `BUILD_GENERAL1_MEDIUM` (`arm1.medium`) | 4 / 8 GiB | USD 0.009 a build minute |
| `large` | `BUILD_GENERAL1_LARGE` (`arm1.large`) | 8 / 16 GiB | USD 0.020 a build minute |

¹ The price list's build row says 3 GB; the machine has 4 GiB. vCPU and memory checked on the host with `nproc; free -m` at each size (2026-10-22).

Start with small. A type check or a test run usually fits there; a compose stack's checks (an image build plus the stack's services) can need `large`.

```sh
sb-offload docker compose up --build --abort-on-container-exit       # in the repository's work tree; small
sb-offload 'docker compose up -d --build --wait && uv run pytest tests/integration; docker compose down'
sb-offload --size large docker compose up --build --abort-on-container-exit   # a stack that needs 8 vCPU / 16 GiB
sb-offload 'nproc; free -m'                                                   # small: 2 vCPU
```

- What goes: the git work tree it is run in — tracked and untracked files with their uncommitted changes, not ignored ones (`.env`, `node_modules`), not the contents of an untracked clone inside it; a submodule's tracked files go — packed under `~/.cache` and put at `s3://<DataBucket>/offload/`. Nothing else: no runner login, no GitHub token, no host file. The build's role may only read `offload/` and write its log group
- What comes back: the log, streamed to the terminal as it arrives (every 5 s), and the exit code: the command's own, 124 when the build hit the time limit, 130 when it was stopped, 1 when it failed before the command ran (the upload could not be unpacked), its state could not be read 3 times in a row, the start was refused for any reason but the limit of 2, or no build freed up in 15 minutes; 2 without a command, with a `--size` off the list, outside a git work tree, or off the host (below). A step before the build that fails (packing the work tree, reading `/switchboard/offload-project` before the deploy, the upload) exits with that tool's own code, which can be any value (the AWS CLI's 254 / 255, tar's 2); the tool's own error is on stderr, with no `sb-offload:` line
- What does not come back: anything the command starts. A compose stack's ports, a browser on its page, files it writes — only the log and the exit code. A check that needs the host's localhost or bind mounts stays on the host (`docker` itself is never sent off: `docker build` / `docker compose up` only print a one-line hint)
- It ends: whatever the command returns, the build ends and its machine is released. Ctrl-C (or TERM, a stopped Task) stops the build; so does sb-offload giving up on it. The project caps a build at 60 minutes and runs 2 at a time; CodeBuild refuses a third instead of queueing it, so sb-offload waits for a free one for up to 15 minutes. The upload is removed at the end; `offload/` also expires after a day. To check a build from the host, `aws codebuild batch-get-builds --ids <project>:<uuid>` with the id from sb-offload's first stderr line (`sb-offload: sent the work tree … and started <project>:<uuid>`; in the cases below it is the only place the host has it); the host role cannot list builds, so `aws codebuild list-builds-for-project --project-name <stack>-offload` (anything still `IN_PROGRESS`) needs a person's credentials or the console. Two gaps leave a build that sb-offload cannot stop, which then ends at the 60-minute limit (its upload goes with `offload/`'s one-day expiry): a Ctrl-C that reaches the whole process group while the start request is in flight, and sb-offload being killed outright (SIGKILL, the OOM killer, systemd-oomd; INT, TERM and HUP do stop the build)
- Off the host: without `/etc/switchboard-host.env` it says so and exits 2; use the local docker there
- Cost (the price list for ap-northeast-1, on demand, checked 2026-10-22; the table above): billed per minute of the build, the machine's start-up included. `small` is **USD 0.00425 a build minute** (about 0.6 円 at 150 円/USD), `large` **USD 0.020** (about 3 円). A 10-minute check 30 times a month is 300 minutes: about USD 1.3 ≈ 190 円 on small, USD 6 ≈ 900 円 on large. The log group (7 days) and `offload/` add next to nothing. The project carries the `Project` tag, so builds count toward the two budgets (1,000 円 / 3,000 円 a month). For a month's ceiling: the budgets only notify; what bounds a build through sb-offload is its largest size (`large`), the 60-minute limit and 2 at a time (at most USD 2.40 an hour while both run). The host role can call `aws codebuild start-build` itself with a bigger machine (`xlarge` and up) or a longer limit (CodeBuild's overrides have no IAM condition): the budgets' mail is the check on that
- Turning it on: the `Boundary`, the instance role and `DeployRole` change, so (1) a person deploys the template (not the workflow's `deploy`), then (2) 作り直す, which installs `sb-offload` on the host. Until (2) `sb-offload` is missing; until (1) it fails reading `/switchboard/offload-project`

## 侵害の確認（#1490）

「誰かが入ろうとしたか、入ったなら何に届いたか」を後から確かめる手順。**読むコマンドだけ**で、ログの削除・設定変更は書かない。ログが残るのは配置（#1490 の template の deploy と 作り直す）の後からで、それより前は無い。

| 場所 | 見るもの | 中身 |
|---|---|---|
| CloudFront | `s3://<DataBucket>/cdn-logs/`（gzip の TSV） | 全要求。ログイン前・ホストが止まっている間・`/_auth*` も含む。`c-ip`、`cs-uri-stem`、`sc-status` |
| デーモン | CloudWatch Logs `/switchboard/host` の `"log":"access"` と `"log":"op"` | 時刻・接続元（`from`）・method・パス（クエリ無し）・status・`auth`（cookie / token / none）。強い操作は `op`（`pty.open` `task.create.danger` `daemon.restart` `daemon.promote` `settings.update` `workspace.add`） |
| Starter | CloudWatch Logs `/aws/lambda/<Starter の関数名>` の `"log":"auth"` | ログイン・登録の失敗と 429。`ip`（/64 まとめ）・`path`・`status`・`reason` |

```sh
export AWS_REGION=ap-northeast-1                       # プロファイル・リージョンは自分の環境のもの
STACK=<スタック名>
BUCKET=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Data --query 'StackResourceDetail.PhysicalResourceId' --output text)
FN=$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Starter --query 'StackResourceDetail.PhysicalResourceId' --output text)
aws logs describe-log-groups --log-group-name-prefix /switchboard/host --query 'logGroups[].[logGroupName,retentionInDays]' --output text
```

観点ごとの CloudWatch Logs Insights。`--start-time` / `--end-time` は epoch 秒（`date -d '7 days ago' +%s`）:

```sh
q() { # q <log group> <query> : 結果が出るまで待って表で返す
  ID=$(aws logs start-query --log-group-name "$1" --start-time "$(date -d '7 days ago' +%s)" --end-time "$(date +%s)" --query-string "$2" --query queryId --output text)
  while :; do # Scheduled と Running の間は待つ。Complete 以外の終わりは結果ではなく失敗
    S=$(aws logs get-query-results --query-id "$ID" --query status --output text)
    case $S in Complete) break;; Scheduled|Running) sleep 2;; *) echo "query $S" >&2; return 1;; esac
  done
  aws logs get-query-results --query-id "$ID" --query 'results[*][*].value' --output text
}
# 1. 認証失敗の連続（接続元ごと・時間ごと）
q /switchboard/host 'filter log="access" and status in [401,403] | stats count(*) by from, bin(1h)'
q "/aws/lambda/$FN" 'filter log="auth" | stats count(*) by ip, status'
# 2. 未認証の大量取得（認証を示さずに届いたパス）
q /switchboard/host 'filter log="access" and auth="none" and status < 400 | stats count(*) by from, path | sort count(*) desc'
# 3. 連番の識別子の走査（1 つの接続元が多くの Task id を叩く）
q /switchboard/host 'filter log="access" and path like /\/api\/tasks\// | stats count_distinct(path) as ids by from | sort ids desc'
# 4. 強い操作（誰が・いつ・どの Task に）
q /switchboard/host 'filter log="op" | fields @timestamp, from, op, task, detail | sort @timestamp desc | limit 50'
```

CloudFront のログは Insights に無いので、手元の一時ディレクトリに落として数える:

```sh
D=$(mktemp -d /tmp/switchboard.cdnlogs.XXXXXX)
aws s3 cp "s3://$BUCKET/cdn-logs/" "$D/" --recursive --quiet
# 列: 1 date 2 time 3 x-edge-location 4 sc-bytes 5 c-ip 6 cs-method 7 Host 8 cs-uri-stem 9 sc-status（#Fields 行で確かめる）
zcat "$D"/*.gz | grep -v '^#' | awk -F'\t' '$9==401 || $9==403 {n[$5]++} END {for (ip in n) print n[ip], ip}' | sort -rn | head
zcat "$D"/*.gz | grep -v '^#' | awk -F'\t' '$8 ~ /^\/api\/tasks\// {n[$5]++} END {for (ip in n) print n[ip], ip}' | sort -rn | head
```

NICT の観点との対応: 未認証の大量取得 = 2 / 連番の識別子 = 3 / 認証失敗の連続 = 1。`from` が CloudFront のアドレスだけのときは、配置前のログか、`CloudFront-Viewer-Address` がまだ届いていない（template の deploy が済んでいない）。

配置後に利用者が確かめる 2 点:

```sh
# (a) CloudFront のログが届いている: 24 時間以内の日付のファイルがある
aws s3 ls "s3://$BUCKET/cdn-logs/" | tail -5
# (b) 作り直しの前後で同じロググループに続きがある: 作り直した時刻 T（epoch 秒）の前と後を別々に数える
T=<作り直した時刻の epoch 秒>
for w in "$((T-86400)) $T" "$T $(date +%s)"; do set -- $w
  aws logs filter-log-events --log-group-name /switchboard/host --start-time "${1}000" --end-time "${2}000" --filter-pattern '"log":"access"' --max-items 1 --query 'events[].timestamp' --output text
done   # 2 行とも時刻が出れば、前後で続いている
# Starter のログ: 失敗したログイン・登録・429 があったときだけ行が出る（読むだけ。確かめるために失敗を作らない）
aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --start-time "$(date -d '7 days ago' +%s)000" --filter-pattern '"log":"auth"' --max-items 5 --query 'events[].message' --output text
```

## Start, stop, 作り直す

- Stopped: opening the URL shows the start page (CloudFront answers the host's 502/504 with `/_start/index.html`), which goes to `/_auth/`: log in with the passkey, press 起動する
- Running but not answering (#1394): `/_auth/` shows 停止する and 作り直す as soon as Switchboard does not answer (no 90-second wait) and says whether `/rescue/` answers. 停止する sends StopInstances through the Starter (cookie + a passkey check within 5 minutes; running / pending only); when the machine stays stopping for 2 minutes the page offers 強制停止 (`Force: true`, after a confirmation). When it is stopped the page offers 起動する. This is the way back from a stalled host, a bootstrap that stopped halfway, or memory exhaustion; no EC2 console and no agent. The Starter's `ec2:StopInstances` is in the `Boundary` and the Starter's role, so it reaches a stack only through a person's deploy (the workflow's DeployRole cannot change the `Boundary`); until then 停止する answers 403 from AWS
- No Spot capacity (`InsufficientInstanceCapacity`): the start answers 409 with `reason: "capacity"` and the page tries again every 15 seconds for 3 minutes, then says so and gives the button back. The Spot instance's type cannot be changed (EC2 refuses it for Spot); switching market or type requires replacing the instance (see Market)
- Host scripts (#435): at every start of `switchboard.service`, `sb-host-update` clones `main` again into `/opt/switchboard-host` (as UserData does, the token in a header) and puts `sb-env`, `sb-stop`, `sb-archive`, `sb-runner-sync`, `sb-offload` and itself into `/usr/local/bin`; when it cannot fetch, the installed ones stay and the start goes on. The units and sb-rescue itself still change only with 作り直す. A host built before this has no `sb-host-update`: it needs one 作り直す to get it
- The host stops itself after 20 idle minutes and registers the next wake-up with EventBridge Scheduler (`switchboard-wake`, #227 / #230)
- 作り直す: the Starter's `/rebuild` replaces the instance's **root volume** with one in its launch state (`CreateReplaceRootVolumeTask`); the instance, its id, its VPC origins and its Spot request stay. The instance must be running (EC2 requires it; a stopped one gets 409 "start it first"); EC2 reboots it, UserData runs again on the fresh disk and the bootstrap restores sqlite from Litestream. The bootstrap first applies the security updates of AL2023's latest release (the pinned AMI's own packages would bring a fixed CVE back, #2186) and, when one needs a reboot (a new kernel), enables the units without starting them and reboots once more, so a 作り直す takes a minute longer then. Nothing in CloudFormation changes, so a failed rebuild leaves the stack as it was (EC2 keeps the old root volume attached when the task fails)
- Memory: `bootstrap.sh` makes a 2 GiB swap file (`memory.sh`, `vm.swappiness=10`, in `/etc/fstab`). `switchboard.service` uses `MemoryMax=85%`, `MemorySwapMax=512M`, `OOMPolicy=continue` and systemd-oomd's `ManagedOOMMemoryPressure=kill`. `MemoryMax` counts RAM only, so swap is capped separately. `MemoryHigh` is omitted because throttling can leave the UI unresponsive. Processes started by runners remain in the unit's cgroup even after `setsid`. Docker uses its separate `sb-dockerd.service` with `MemoryMax=1536M` and `MemorySwapMax=256M`. OOM kills or memory pressure can affect sb-rescue too. Use 停止する → 起動する on `/_auth/`, or Stop then Start in EC2, if the screen does not answer. Existing hosts receive bootstrap changes through 作り直す.
- Memory alarms (#535, #539, #540): the CloudWatch agent (`aws/host/cloudwatch-agent.json`, started by the bootstrap; a failed install is logged and the host still starts) sends `mem_used_percent` and `swap_used_percent` to `CWAgent` every minute. Three alarms are there to be watched (CloudWatch → Alarms, or `aws cloudwatch describe-alarms --alarm-name-prefix <stack>`); they have no action: no mail, no stop, no reboot: `<stack>-memory` (memory at 80% or more for 5 minutes: the unit is capped at 85%, so a higher threshold may not be reached), `<stack>-swap` (swap at 20% or more for 3 minutes: the unit is at its 512M swap cap, which can precede a stall even when memory is below its alarm threshold) and `<stack>-disk-read` (EC2's own `EBSReadBytes` over 15 GB in each of 3 five-minute periods, so it still goes into ALARM when the agent has no memory left to report). Missing data is not an alarm, so a stopped instance is quiet. **When one is in ALARM and the screen does not answer: stop the instance and start it again** (open `/_auth/` and press 停止する, then 起動する; the EC2 console — Instance state → Stop, then Start — is the other way; the status checks stay green through this kind of stall, so they will not tell you). Cost: 2 metrics + 3 alarms, about 135 円 a month. Order to turn it on: (1) a person deploys the template (the `Boundary` and `DeployRole` change, so `deploy` from the workflow cannot); (2) 作り直す, which is what installs the agent and applies the swap and the limits on an existing host. Until (2) `<stack>-memory` has no data and stays quiet; `<stack>-disk-read` works from (1)
- Market: **on-demand** by default. Spot can be interrupted and may not restart for lack of capacity. An instance's market and type cannot be changed in place. Changing the launch template replaces the instance; VPC origins in use cannot point at a new instance, so give both origins new logical ids in the template for that deploy. Review the change set and cancel any persistent Spot request immediately before replacement. `sam deploy` keeps previous parameter values unless explicitly overridden.
- With `Market=spot`: the Spot request is `persistent` (needed for "stop on interruption"): while it is open, a terminated instance is launched again outside the stack. Two things terminate the instance: a deploy whose change set **replaces** `Instance` — any change to the launch template (ImageId, UserData, the instance type, the disk) — and delete-stack. Both must be done by a person: the GitHub workflow's deploy (DeployRole) must never carry a launch template change, so review its change set and stop if it lists `Instance` as Replace. The AMI is a pinned parameter for this reason. Cancel the request right before either, not earlier — a cancelled request's instance can no longer be stopped, only terminated. If such a deploy rolls back after creating the new instance, CloudFormation terminates that one without cancelling its request: look for an instance tagged with the stack that the stack does not list, and cancel its request and terminate it
- Remove: cancel the Spot request, then delete the stack. The data bucket is kept (`Retain`); empty and delete it by hand when you are sure

```sh
RID=$(aws ec2 describe-instances --instance-ids <InstanceId> --query 'Reservations[0].Instances[0].SpotInstanceRequestId' --output text --profile YOUR_PROFILE --region <region>)
aws ec2 cancel-spot-instance-requests --spot-instance-request-ids "$RID" --profile YOUR_PROFILE --region <region>
aws cloudformation delete-stack --stack-name switchboard-host --profile YOUR_PROFILE --region <region>
```

## ホストの OS・カーネルの脆弱性（CVE）（#2186）

ホストの OS ユーザーは root を持たないので、ホストの上で `dnf upgrade` はできない。修正版は起動のたびに入る: `switchboard.service` の起動ごとに `sb-host-update`（root）が AL2023 の最新のリポジトリのセキュリティ更新を `sb-security-update` の unit で当てる（起動は待たない）。新しいカーネルは次の起動から使われる。作り直しは要らない。作り直しの bootstrap も同じ更新を当てるが、bootstrap はスタックの `GitHubRepo` のリポジトリから来るので、その値が古い（改名の前の名前）と更新の無い版が走る（2026-10-21 に起きた）。AMI（`ImageId`）は上げない（インスタンスが置き換わる。上の Market の項）。

1. 当てはまりの判定（Task ができる。読むだけ）
   - 動いている版: `uname -r`、`rpm -q kernel6.18`（AL2023 のカーネルのパッケージ名は版ごと。`rpm -qa 'kernel*'`）
   - 修正版の有無: Amazon Linux のセキュリティセンターの CVE のページ（`https://explore.alas.aws.amazon.com/<CVE>.html`）で、使っているパッケージが Fixed か Pending か。Fixed なら ALAS のページに版がある
   - リポジトリに出ているか: `dnf --releasever=latest check-update --security`。`--releasever=latest` が無いと AMI の版のリポジトリしか見ず、「No security updates needed」と出る
   - 経路が届くか: CVE の記述（ネットワークから / ローカルから、要る機能）と、このホストの構成（VM は無い、rootless docker、一般ユーザーの user namespace は有効）を照らす。ローカルの経路でも、ホストで動くコード（Task が実行する依存・clone したコード）から届くなら対象にする
   - Pending なら、作り直しても直らない。Fixed になるまで待つことを利用者に伝える
2. バックアップ（Task ができる。停止→起動ではディスクは残るが、念のため）: `sb-pre-rebuild save`（作り直す前のホストに無ければ `bash aws/host/pre-rebuild.sh save`）。`s3://<DataBucket>/archive/pre-rebuild/<時刻>/` に DB のダンプ（`switchboard.sql.zst`）と、作り直しで戻らないファイル（`files.tar.zst`: `~/.switchboard/attachments`・`artifacts`・`fixtures`、`~/Knowledge`）が上がり、runner の記録を 1 回同期する。コミットしていない変更や、どのリモートにも無いコミットのある作業ツリーは `not pushed:` で並び、push せずに `worktrees.tar.zst` に入る（作業ツリーごとに `info`（パス・枝・HEAD）、`commits.bundle`、`changes.patch`、`untracked.tar`）。その作業の持ち主（Task）が作り直しの前に push できるなら push する。中の入れ子のリポジトリは入らない（`info` に `nested (not kept)` で残る。無視されたファイルまで入るため）。作り直しの後は Task が、作業ツリーを `info` の HEAD に戻してから重ねる: `git fetch <commits.bundle> HEAD`（commits.bundle があるとき）→ `git worktree add -b <branch> <path> <head>`（枝が `HEAD` なら `--detach`）→ その中で `git apply --binary changes.patch` と `tar -xf untracked.tar`。`head none`（まだコミットの無いリポジトリ）は `git init` した場所に `tar -xf untracked.tar` だけ。`archive/` は 30 日で消える
3. ほかの Task の停止の確認: 再起動・停止でデーモンも Task も止まる。動いている Task が無いこと（画面の一覧、または `sqlite3 ~/.switchboard/switchboard.db "select id, title from tasks where status = 'running'"`）を利用者が確かめる
4. 更新を当てる（利用者）: 救援画面の 再起動（`sb-host-update` が走る）。`sb-host-update` 自身が main で変わった直後の起動は、新しい版を入れるだけで古い版のまま終わるので、`journalctl -u sb-security-update` に何も無ければもう 1 回 再起動する。Task が `journalctl -u sb-security-update` で dnf の終わりを確かめ、`rpm -q kernel6.18` に修正版が入ったのを見る（最後に起動してから時間が経っていれば、もう入っていることもある）
5. 新しいカーネルで起動する（利用者）: `/_auth/` の 停止する → 起動する（パスキーの確認）。ディスクはそのままなので、バックアップの戻しは要らない。`sam deploy` も 作り直す も要らない
6. 確認（Task ができる）: `uname -r` が修正版。`dnf --releasever=latest check-update --security` に残りが無い
7. 作り直したときだけ、戻し（Task ができる）: `sb-pre-rebuild restore`（最新の save。`restore <時刻>` で指定）で、ファイルを HOME に戻す（新しいホストに既にあるファイルは残す。新しい `~/Knowledge/README.md` を元に戻したいなら、そのファイルだけ `--skip-old-files` なしで展開する）。DB は Litestream が戻すので、ダンプは戻さない（戻らなかったときだけ `aws s3 cp …/switchboard.sql.zst - | zstd -dc | sqlite3 <新しいファイル>`）。Claude の設定は devtools が書き直すので、所有者の設定は当て直す（`aws/host/claude-settings.sh`）

### Node.js の脆弱性

ホストの Node.js（`/usr/local/lib/nodejs`。Playwright と Playwright MCP の `npx` が使う）は dnf ではなく nodejs.org の tarball で、版と sha256 は `aws/host/node.sh` に固定してある。修正版が出たら（`https://nodejs.org/en/blog/vulnerability`）、`node.sh` の `NODE_VERSION` と `NODE_SHA256`（`https://nodejs.org/dist/v<版>/SHASUMS256.txt` の `linux-arm64.tar.xz` の行）を上げて main にマージする。起動のたびに `sb-host-update` がその `node.sh` を `sb-node` として入れ、`sb-node-update` の unit で走らせるので、救援画面の 再起動 で入る（上の 4. と同じく、`sb-host-update` 自身が変わった直後の起動では、もう 1 回 再起動する）。確認は `journalctl -u sb-node-update` と `node --version`。Lambda（`Starter` の `nodejs24.x`）は AWS が管理する runtime で、AWS が更新を当てる（`Runtime` の書き換えは要らない）。

## 緊急時: 不審なアクセスがあったとき（#1492）

どれから使うか: 疑わしい Cookie・端末の紛失 → (a) / どこから来たか分からない・(a) で止まらない → (b) / まず全部止める → (c)。何を見たかは「侵害の確認」の節で。手順は人が実行する（自動の遮断は無い）。コマンドは値を画面に出さない（新しい値はファイルに書き、復号した値は表示しない）。国と WAF で入口を狭めるのは「Narrowing who can reach it」の節（(c) の後に付ける）。

```sh
export AWS_REGION=ap-northeast-1 AWS_PROFILE=YOUR_PROFILE   # 自分の環境のもの
STACK=<スタック名>
res() { aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id "$1" --query 'StackResourceDetail.PhysicalResourceId' --output text; }
```

### (a) 全セッションの即時失効

```sh
printf '{"passkeys":[],"spent":[]}' | aws s3 cp - "s3://$(res Data)/auth/passkeys.json" --content-type application/json
```

- 止まるもの: 全ブラウザの `sb_session`。Starter は即座に、デーモンと `/rescue/` は 5 分以内（`SESSION_RECHECK_MS`）に拒み、開いている WebSocket とターミナルも同じ周期で閉じる。ログインも登録簿が空の間はできない
- 残るもの: ホストで動いている Task、ホストの中のトークン（loopback だけ）、起動ページと `/_auth/`（登録の入口として）
- **古い版に戻さない**: バージョニングで `passkeys.json` を前の版に戻すと、漏れたパスキーも生き返る
- 復帰: 「The first passkey, or every device lost」の手順で、端末ごとに登録リンクを作って登録し直す（作るのは AWS の権限を持つ人。ホスト上のエージェントではなく手元で。インスタンスのロールは `register-code` を読めない）

### (b) 経路の遮断

1 つ目 — edge ヘッダ値を替える（CloudFront を通らない直接の要求と、古い値を知る者を締め出す）:

```sh
D=$(mktemp -d /tmp/switchboard.edge.XXXXXX)
openssl rand -hex 32 | tr -d '\n' > "$D/edge"
aws ssm put-parameter --name /switchboard/edge-header --type SecureString --overwrite --value "file://$D/edge" >/dev/null
# Deploy の節の sam deploy を、同じ --parameter-overrides の EdgeHeaderValue="$(cat "$D/edge")" だけ替えてもう一度（変更セットを見てから実行）
rm -rf "$D"
aws ec2 reboot-instances --instance-ids "$(res Instance)"   # sb-env が新しい値を読む。sb-rescue の 再起動 ではない（古い値のままになる）
```

- 止まるもの: 値が揃うまでの全経路（CloudFront の更新と再起動の間）。揃った後は、古い値を知る者の直接の要求
- 残るもの: ログイン済みの Cookie（Starter は 60 秒以内に新しい値を読み直す）、起動ページ、Task（再起動で再開の予定のあるもの）

2 つ目 — セキュリティグループから CloudFront の prefix list を外す（ホストへの全経路を切る）:

```sh
PL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Parameters[?ParameterKey==`CloudFrontPrefixListId`].ParameterValue' --output text)
aws ec2 revoke-security-group-ingress --group-id "$(res Sg)" --ip-permissions "IpProtocol=tcp,FromPort=47831,ToPort=47831,PrefixListIds=[{PrefixListId=$PL}]"
aws ec2 revoke-security-group-ingress --group-id "$(res RescueSg)" --ip-permissions "IpProtocol=tcp,FromPort=47841,ToPort=47841,PrefixListIds=[{PrefixListId=$PL}]"
```

- 止まるもの: デーモンと `/rescue/` への新しい接続の全経路。**すでに開いている接続（WebSocket・ターミナル）は、セキュリティグループの接続追跡で切れずに残る**。(a) の登録簿を空にしてあれば 5 分以内に閉じる。それも待てなければ (c) まで進める
- 残るもの: 起動ページと `/_auth/`（Starter は別の経路）、ホストの中で動いている Task。スタックの定義とずれる（ドリフト）ので、戻すのは (d)

### (c) API の全停止

```sh
aws ec2 stop-instances --instance-ids "$(res Instance)"
```

- 止まるもの: デーモン・sb-rescue・全 Task（`sb-stop` と同じく Litestream が最後の状態を S3 に上げる）。起動ページの停止（`/_auth/stop`）もあるが、パスキーのログインが要る。(a) の後や疑わしい間は上の `stop-instances` を使う
- 残るもの: 起動ページと `/_auth/`、データ（S3）。(a) で登録簿を空にしてあれば、ログインも起動もできない。入口を狭めるのはここから

### (d) 戻し方

- (a): 登録リンクで端末ごとに登録し直す（上の復帰）
- (b) の 1 つ目: 戻すものは無い（新しい値のまま使う）。2 つ目: `aws ec2 authorize-security-group-ingress` に、外したときと同じ引数（`--group-id` と `--ip-permissions`）を渡して入れ直す（テンプレートが変わらないので、`sam deploy` では戻らない）
- (c): 起動ページの「起動する」（パスキーが要る）か `aws ec2 start-instances`
- 戻した後の確かめ: `/api/health` が `login: "passkey"` を返し、ログインして Task の一覧が出る。続けて「侵害の確認」の節の 4 を見て、遮断の間に拒否が出ていたことを確かめる

## Moving a host to the default paths (#427)

A host made with `HostHome` / `ReposDir` set to other paths (the old advice) moves to the defaults like this. `HostHome` and `ReposDir` are in UserData, so the deploy **replaces the instance**: the new one restores sqlite from Litestream and the runners' records from `sb-runner-sync`, and clones the registered workspaces into the new `ReposDir`. What is only on the old disk is lost with it — push or save any unpushed work first, and expect running Tasks to end.

1. Prepare, with the daemon still running: the template must give the VPC origins new logical ids (above, Market), and the change set must be looked at — `sam deploy … --no-execute-changeset --parameter-overrides HostHome=/home/switchboard ReposDir=/home/switchboard/repos` (with the other overrides as in Deploy). It adds the two new VPC origins and deletes the old ones, and modifies `LaunchTemplate` (a new version), `Instance` (replaced: the launch template's version changed) and the `Cdn`. If the origins it would add already exist (a workflow `deploy` after the rename created them on the current instance), give them the next logical ids first; executing it then would hit #465. If the repository variable `SWITCHBOARD_HOST_PARAMS` (the workflow) carries `HostHome=… ReposDir=…`, a person takes them out: `sam deploy` keeps the stack's values, while passing the old ones would make every later workflow `deploy` touch the launch template (and refuse). Keep a copy of the database: `sqlite3 ~/.switchboard/switchboard.db ".backup <file>"` and `aws s3 cp <file> s3://<DataBucket>/archive/pre-relocate/` (`archive/` expires after 30 days: keep a copy elsewhere for longer). Also save what the bootstrap does not bring back — `~/.switchboard/attachments` and `~/Knowledge` (the daemon makes a fresh one at its first start), whichever exist — e.g. `tar -C ~ -cf <file> $(cd ~ && ls -d .switchboard/attachments Knowledge 2>/dev/null)` to the same place, and unpack it on the new host after 6 with `tar --skip-old-files` (over the fresh Knowledge; its `README.md` is the fresh one's, so unpack that file without the flag if it was edited)
2. Stop the daemon. The host user may not run `systemctl stop switchboard`, and it would end the whole unit, including these steps; the instance is replaced right after, so pause sb-rescue and stop the daemon instead: `kill -STOP <sb-rescue pid>; kill <daemon pid>`, then wait until `curl -s localhost:47831/api/health` no longer answers. The host has no SSH and no Session Manager, so steps 2–5 and the undo below run as one script that a Task starts with `setsid nohup bash <script> >log 2>&1 &`: the daemon's end ends the Task, but not a process it detached (they stay in the unit's cgroup, which only `systemctl stop` would end). The instance role may not deploy, so right before starting it a person signs in on the host with their own AWS login (`aws configure sso` writes the profile once, then `aws sso login --use-device-code`; the narrowest profile that may run this change set) and the script uses that profile for step 5. Every agent on the host runs as the same OS user and can read that login, so sign in only then, and the script runs `aws sso logout` in an `EXIT` trap and, on the undo path, explicitly before its `shutdown` (the shutdown would end the trap with the unit; the disk is kept). It copies its log to `s3://<DataBucket>/archive/pre-relocate/` after each step, the one place a person can read it once the daemon is down
3. As the host user, the repositories folder first, then HOME (each prints the rows and folders it changed; it refuses while the daemon answers, or when a renamed Claude folder already exists):
   ```sh
   bun ~/.switchboard/releases/current/packages/core/src/main.ts relocate --from <old ReposDir> --to /home/switchboard/repos
   bun ~/.switchboard/releases/current/packages/core/src/main.ts relocate --from <old HostHome> --to /home/switchboard
   ```
   (the running release, not a working tree an agent may have on another branch; it needs #802.) The renamed folders under `~/.claude/projects` are still in the old HOME; `sb-runner-sync` packs them relative to `$HOME`, so the new host unpacks them into `/home/switchboard/.claude/projects`
4. `rm -f ~/.switchboard/runner-sync.state` (the renamed folders go into a new base; their ctime did not change, so a difference would not carry them), `sb-runner-sync`, then `sudo systemctl stop litestream` (its last sync of the relocated database)
5. Execute the change set from 1 and wait for the stack (`aws cloudformation wait stack-update-complete`). The old instance is terminated (the script ends with it); the new one bootstraps (about 10 minutes; `/var/log/cloud-init-output.log` shows the clones and the unpacked records)
6. Check: on the host `echo $HOME` is `/home/switchboard`, `ls /home/switchboard/repos` lists the registered workspaces, `sqlite3 ~/.switchboard/switchboard.db "select count(*) from tasks where cwd != '/home/switchboard' and cwd not like '/home/switchboard/%'"` counts only Tasks whose folder was elsewhere (`/private/tmp/…`), and a one-line reply to a Task from before the move answers from where it left off

If the deploy fails before the old instance goes (the change set does not execute, or the stack rolls back), the same script undoes 2–4: both relocates the other way, in the same order as step 3 (the repositories folder first: `--from /home/switchboard/repos --to <old ReposDir>`, then `--from /home/switchboard --to <old HostHome>`; HOME first would take the repositories under it along to the old HOME), `rm -f ~/.switchboard/runner-sync.state` and `sb-runner-sync` again (the saved records go back to the old folder names), then `aws sso logout` and `sudo shutdown -h now` (the host user may stop Litestream but not start it; the next start from the start page brings back Litestream, sb-rescue and the daemon on the old paths). Going back after the move is the same steps with the paths swapped.

## Must be confirmed on the first deploy (#232)

Run these checks on your own stack before relying on it. Check restoration with your own data and keep a separate backup before replacement or removal.

- The account's unreserved Lambda concurrency allows the Starter's reserved 5 (a new account may have a limit of 10 in total, and AWS keeps 10 unreserved: if the deploy refuses it, drop `ReservedConcurrentExecutions` or raise the quota)
- `CloudFront-Viewer-Address` reaches the Starter through the `/_auth*` origin request policy (the login's rate limit is per viewer; without it the first X-Forwarded-For entry is used)
- `wafv2:GetWebACL` on `global/webacl/*` in us-east-1 (the DeployRole) is enough for CloudFront's `UpdateDistribution` to attach a Web ACL (#1492; `WebAclArn` was not tried yet). `AllowedCountries=JP` from a non-JP address answers 403, and removing it restores the answer
- CloudFront accepts a VPC origin for an instance in a **public** subnet (the docs list a private subnet as a prerequisite). If not, the fallback costs money and is the user's choice (see "The way in")
- 作り直す: after `CreateReplaceRootVolumeTask` (launch state) the instance reboots on a fresh root volume and UserData runs again — cloud-init keeps its once-per-instance marker under `/var/lib/cloud` on the root volume, which the replacement discards. If it does not run, the bootstrap has to be started another way
- The boundary's KMS statement (through SSM and EC2 only) is enough for: reading the SecureStrings on the instance, the Starter's `StartInstances` on the encrypted root volume, and the root volume replacement
- The Starter's `CreateReplaceRootVolumeTask` permissions (instance, task, volume, the AMI's snapshot and image) are enough for a launch-state replacement
- The root volume a replacement creates keeps the `Project` tag (the launch template tags volumes only at launch); if not, tag it after each 作り直す or the disk drops out of both budgets
- Litestream reaches the data bucket with the region from the config and no `s3:GetBucketLocation` (restore on first boot, replicate after)
- `claude auth status` exits 0 for a `claude` that has only `CLAUDE_CODE_OAUTH_TOKEN` (the setup-token wrapper, `docs/design/cloud-hosting.md` §9)
