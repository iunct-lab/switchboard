# CLI update

The daemon keeps the machine's `claude` and `codex` CLIs current: it takes a new version only from the distributor the installers use, checks what it fetched, places it beside the version in use, tries it, and moves the link only when no Task is running. Every decision is a row of `cli_updates`, read with `GET /api/runners/updates`, and the version before can be put back (`POST /api/runners/:id/rollback`).

## Where versions come from

- Claude Code: `https://downloads.claude.ai/claude-code-releases/latest` names the newest version; that version's `manifest.json` lists a sha256 per platform and is signed (`manifest.json.sig`, GPG). The signing key's fingerprint is the one Anthropic's setup page prints (`CLAUDE_RELEASE_KEY_FINGERPRINT` in `packages/core/src/cli-update-source.ts`).
- Codex: the redirect of `https://github.com/openai/codex/releases/latest` names the newest release; its JSON gives the package's digest, and the release carries `codex-package_SHA256SUMS` and a sigstore bundle per package. The bundle is checked with `cosign verify-blob`, holding the certificate to the release workflow at that version's tag. `cosign` is pinned in `aws/host/devtools.sh`.
- Every download, and every redirect on the way, must stay on those hosts (`OFFICIAL_HOSTS`). A version the distributor no longer offers, or one older than its newest, is withdrawn.

The distributors are fixed, not a setting: a setting that moved them would move the line this guards.

## When, and what is checked

`checkCliUpdates` (`packages/core/src/server/cli-update.ts`) runs every `Settings.cliUpdate.checkMinutes`, and once shortly after the daemon starts. It first reads only the newest version's name; only when that is newer than the version in use does it read the release, wait until it has been out `waitHours`, download it, and check it:

1. Distributor: every hop on an official host, else `not-official`.
2. Checksum: the file's sha256 is the published one, else `mismatch`. A published checksum that is not a sha256 is `mismatch`, not "none".
3. Signature: GPG for Claude, cosign for Codex, else `mismatch`. No checksum or no signature published: `unsigned`, unless `Settings.cliUpdate.missingSignature` is `allow`.
4. Placing: the file goes where the installer puts versions (`~/.local/share/claude/versions/<v>`, `~/.codex/packages/standalone/releases/<v>-<target>`). Files already there under that name are run only when they are the checked bytes; the version kept to go back to is never replaced.
5. Trying: `--version` must name the version, and with `Settings.cliUpdate.smoke` at `turn` one read-only turn must come back with no error. A turn stopped by the usage limit records `untested` and is tried again later.

A version that fails is recorded as `refused` with the reason, once per version and settings, and is not fetched again until a setting changes. A version that passes waits for no Task to run (the same count and signals as promotion), and is checked again right before the link moves: the settings, the wait and the distributor must still say yes.

## Moving the link, and going back

The link (`~/.local/bin/claude`, `~/.codex/packages/standalone/current`) is moved by a temporary link and a rename, so the path never disappears. Through the moved link `--version` is read again; when it does not answer as the version, the link goes back at once. Running Tasks keep the files they started with; only Tasks started later use the new CLI.

Two versions are kept: the one in use and the one a rollback goes to. The rollback target is the version installed here before the one in use, leaving out any version a person went back from. A rollback (`POST /api/runners/:id/rollback`) waits, like an install, until no Task runs. A version a person went back from is not brought in again by itself; a newer one is.

A machine without the installers' link, a candidate daemon and a work machine change nothing.

## What this does not guard

A version the distributor itself publishes and signs with bad intent passes; `waitHours` only gives time to notice. A Task runs as the same OS user and can run an installer itself, outside these checks.

## Known limits

The one read-only turn starts the placed file directly, through an adapter with no runner settings: it does not go through anything that stands in front of `claude` on PATH, and it does not use the Bedrock switch of Settings. Two kinds of machine therefore cannot pass it, and with `smoke` at `turn` a new version of that runner is refused there (it fails closed: the version in use stays, nothing new goes in):

- A machine whose `claude` gets its sign-in from `scripts/host/claude-wrapper.sh` (installed ahead of the real `claude` on PATH, reading a `claude setup-token` token from Parameter Store): the placed file starts without that token.
- A machine where Claude or Codex runs only on Amazon Bedrock (switched in Settings, `docs/design/bedrock.md`): the turn does not get the Bedrock settings.

On such a machine, set `Settings.cliUpdate.smoke` to `version`: the distributor, checksum and signature checks still apply, and a version refused under the other setting is checked again. Nothing tries a turn in its place.
