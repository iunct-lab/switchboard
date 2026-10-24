#!/usr/bin/env bash
# bootstrap — first boot of a Switchboard host (#230), run by the instance's UserData with the stack's parameters:
#   SB_HOST_USER SB_HOST_HOME SB_REPOS_DIR SB_GITHUB_REPO SB_DATA_BUCKET SB_SCHEDULER_ROLE_ARN
# Installs the tools, clones the repository, restores sqlite from Litestream when the disk is new, and enables the
# units. Idempotent: a second run on the same disk does nothing. The runners log in themselves (terminal tab, §4).
set -euo pipefail
: "${SB_HOST_USER:?}" "${SB_HOST_HOME:?}" "${SB_REPOS_DIR:?}" "${SB_GITHUB_REPO:?}" "${SB_DATA_BUCKET:?}" "${SB_SCHEDULER_ROLE_ARN:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DONE=/var/lib/switchboard-host/bootstrapped
[ -f "$DONE" ] && { echo "bootstrap: already done"; exit 0; }

LITESTREAM_VERSION=0.3.13
# neither project publishes checksums for these assets: pinned here from the downloads (2026-09-25)
LITESTREAM_SHA256=9585f5a508516bd66af2b2376bab4de256a5ef8e2b73ec760559e679628f2d59
AGE_VERSION=1.2.1
AGE_SHA256=57fd79a7ece5fe501f351b9dd51a82fbee1ea8db65a8839db17f5c080245e99f
REPO_DIR="$SB_REPOS_DIR/switchboard"
as_user() { sudo -u "$SB_HOST_USER" -H env HOME="$SB_HOST_HOME" PATH="$SB_HOST_HOME/.local/bin:$SB_HOST_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# --- the user, with HostHome (the default; moved history is matched to it by relocate, cloud-hosting.md §5) ---
mkdir -p "$(dirname "$SB_HOST_HOME")"
id "$SB_HOST_USER" >/dev/null 2>&1 || useradd --create-home --home-dir "$SB_HOST_HOME" --shell /bin/bash "$SB_HOST_USER"
# the whole journal (the kernel's OOM kills, other units), for looking into a stall from a Task
usermod -aG systemd-journal "$SB_HOST_USER"
mkdir -p "$SB_REPOS_DIR" && chown "$SB_HOST_USER:" "$SB_REPOS_DIR"

# --- security updates (#2186): 作り直す puts back the AMI's packages, and the AMI is pinned (aws/template.yaml) ---
# AL2023's dnf is locked to the AMI's release, where no newer kernel is ever seen; take every later dnf from the latest
# release. A failure is logged and skipped, as devtools: the host still serves, and 作り直す can try again
echo latest > /etc/dnf/vars/releasever
dnf upgrade -y -q --security || echo "bootstrap: security updates failed (exit $?); the host starts on the packages it has" >&2

# --- tools ---
dnf install -y -q git jq tar gzip unzip 'dnf-command(config-manager)'
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && dnf install -y -q gh
# fetch <url> <sha256> <file>: download and refuse anything whose checksum differs
fetch() { curl -fsSL -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet -; }
DL="$(mktemp -d)"
[ -x /usr/local/bin/litestream ] || {
  fetch "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/litestream-v$LITESTREAM_VERSION-linux-arm64.tar.gz" "$LITESTREAM_SHA256" "$DL/litestream.tar.gz"
  tar --no-same-owner -xzf "$DL/litestream.tar.gz" -C /usr/local/bin litestream
}
[ -x /usr/local/bin/age ] || {
  fetch "https://github.com/FiloSottile/age/releases/download/v$AGE_VERSION/age-v$AGE_VERSION-linux-arm64.tar.gz" "$AGE_SHA256" "$DL/age.tar.gz"
  tar --no-same-owner -xzf "$DL/age.tar.gz" -C /usr/local/bin --strip-components=1 age/age age/age-keygen
}
rm -rf "$DL"
as_user bash -c 'command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
as_user bash -c 'command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash'
as_user bash -c 'command -v codex >/dev/null || curl -fsSL https://chatgpt.com/codex/install.sh | sh'

# --- swap (#537): somewhere for a short peak under the unit's limits; a failure is logged and skipped, as devtools ---
# (a failing mkswap would stop the bootstrap and the host would never serve: a host without swap is still better)
bash "$HERE/memory.sh" || echo "bootstrap: swap failed (exit $?); the host starts without it" >&2

# --- memory metrics (#539): mem_used_percent and swap_used_percent to CWAgent, for the alarm (#540) ---
# a failure is logged and skipped, as with devtools: without the agent the host still serves Switchboard, and 作り直す can try again
# (&& not set -e: inside { } || the shell ignores set -e, so a failed install would not stop the ctl call)
CWA=/opt/aws/amazon-cloudwatch-agent
{ dnf install -y -q amazon-cloudwatch-agent \
  && sed -e "s|@HOME@|$SB_HOST_HOME|g" "$HERE/cloudwatch-agent.json" > "$CWA/etc/amazon-cloudwatch-agent.json" \
  && "$CWA/bin/amazon-cloudwatch-agent-ctl" -a fetch-config -m ec2 -s -c "file:$CWA/etc/amazon-cloudwatch-agent.json"; } \
  || echo "bootstrap: the CloudWatch agent failed (exit $?); the host starts without memory metrics" >&2

# --- host scripts and settings for them ---
install -m 755 "$HERE/sb-stop.sh" /usr/local/bin/sb-stop
install -m 755 "$HERE/sb-env.sh" /usr/local/bin/sb-env
install -m 755 "$HERE/archive.sh" /usr/local/bin/sb-archive
install -m 755 "$HERE/runner-sync.sh" /usr/local/bin/sb-runner-sync
install -m 755 "$HERE/offload.sh" /usr/local/bin/sb-offload
# the kit's gh first in the host user's interactive shells (#824): a runner started by hand posts through the same check
sed -e "s|@REPO@|$REPO_DIR|g" -e "s|@HOME@|$SB_HOST_HOME|g" -e "s|@USER@|$SB_HOST_USER|g" "$HERE/sb-gh-guard.sh" > /etc/profile.d/sb-gh-guard.sh
chmod 644 /etc/profile.d/sb-gh-guard.sh
install -m 755 "$HERE/host-update.sh" /usr/local/bin/sb-host-update
IMDS=http://169.254.169.254
TOKEN="$(curl -fsS -X PUT "$IMDS/latest/api/token" -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
INSTANCE_ID="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/latest/meta-data/instance-id")"
REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/latest/meta-data/placement/region")"
cat > /etc/switchboard-host.env <<ENV
AWS_DEFAULT_REGION=$REGION
SB_INSTANCE_ID=$INSTANCE_ID
SB_SCHEDULER_ROLE_ARN=$SB_SCHEDULER_ROLE_ARN
SB_DATA_BUCKET=$SB_DATA_BUCKET
SB_REPO_DIR=$REPO_DIR
ENV
chmod 644 /etc/switchboard-host.env
# the daemon user may stop the machine (sb-stop) and start its dockerd (dockerd-up), nothing else as root
cat > /etc/sudoers.d/switchboard <<SUDO
$SB_HOST_USER ALL=(root) NOPASSWD: /usr/bin/systemctl stop litestream, /usr/sbin/shutdown -h now, /usr/bin/systemctl start sb-dockerd
SUDO
chmod 440 /etc/sudoers.d/switchboard

# --- the repository (fine-grained token from Parameter Store, only the listed repositories) ---
GH_TOKEN_VALUE="$(timeout 15 aws ssm get-parameter --name /switchboard/github-token --with-decryption --query Parameter.Value --output text --region "$REGION")"
printf '%s' "$GH_TOKEN_VALUE" | as_user gh auth login --with-token && as_user gh auth setup-git
# Administrators may redirect future starts without replacing the instance.
GITHUB_REPO="$(timeout 15 aws ssm get-parameter --name /switchboard/github-repo --query Parameter.Value --output text --region "$REGION" 2>/dev/null || true)"
[[ "$GITHUB_REPO" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || { echo "bootstrap: no readable /switchboard/github-repo; cloning the stack's GitHubRepo" >&2; GITHUB_REPO="$SB_GITHUB_REPO"; }
[ -d "$REPO_DIR/.git" ] || as_user git clone "https://github.com/$GITHUB_REPO.git" "$REPO_DIR"
as_user bash -c "cd '$REPO_DIR' && bun install --frozen-lockfile && bun rescue/install.ts"

# --- development tools (#371): what a runner needs to develop here as on the Mac; gh is logged in by now ---
# a failure here is logged and skipped (#389): without the tools the host still serves Switchboard, and 作り直す can try again
bash "$HERE/devtools.sh" || echo "bootstrap: devtools failed (exit $?); the daemon starts without some development tools" >&2

# --- setup-token for claude only if one was put in Parameter Store (§4.2): the wrapper goes ahead of the real claude ---
if aws ssm get-parameter --name /switchboard/claude-oauth-token --region "$REGION" >/dev/null 2>&1; then
  ln -sf "$REPO_DIR/scripts/host/claude-wrapper.sh" /usr/local/bin/claude
fi

# --- sqlite: restore from the replica when this disk has none (a rebuilt instance), then replicate ---
sed -e "s|@HOME@|$SB_HOST_HOME|g" -e "s|@BUCKET@|$SB_DATA_BUCKET|g" -e "s|@REGION@|$REGION|g" "$HERE/litestream.yml" > /etc/litestream.yml
as_user mkdir -p "$SB_HOST_HOME/.switchboard"
# -if-replica-exists covers a first machine (nothing to restore); any other failure stops the bootstrap here instead of
# letting the daemon start an empty database and Litestream a new generation over the old history
if [ ! -f "$SB_HOST_HOME/.switchboard/switchboard.db" ]; then
  /usr/local/bin/litestream restore -if-replica-exists -config /etc/litestream.yml "$SB_HOST_HOME/.switchboard/switchboard.db"
  if [ -f "$SB_HOST_HOME/.switchboard/switchboard.db" ]; then chown "$SB_HOST_USER:" "$SB_HOST_HOME/.switchboard/switchboard.db"*; fi
fi

# --- the one-time move from the Mac (#179, #232): only onto a machine with no history of its own ---
# The person puts a `main.ts export` package at s3://<data>/releases/migration/import.tar.zst. It is imported only when
# nothing came back from Litestream (a machine that already has history never takes it again).
IMPORT="s3://$SB_DATA_BUCKET/releases/migration/import.tar.zst"
if [ ! -f "$SB_HOST_HOME/.switchboard/switchboard.db" ] && aws s3api head-object --bucket "$SB_DATA_BUCKET" --key releases/migration/import.tar.zst --region "$REGION" >/dev/null 2>&1; then
  IMP_DIR="$(mktemp -d)"
  aws s3 cp "$IMPORT" "$IMP_DIR/import.tar.zst" --only-show-errors --region "$REGION"
  chown -R "$SB_HOST_USER:" "$IMP_DIR"
  as_user bash -c "cd '$REPO_DIR' && bun packages/core/src/main.ts import '$IMP_DIR/import.tar.zst'"
  rm -rf "$IMP_DIR"
  echo "bootstrap: imported the history from $IMPORT"
fi

# --- the registered workspaces: cloned to their paths in the database (those under ReposDir), so their tasks' folders exist ---
# On every bootstrap, not only after the import: a rebuilt machine gets its history back from Litestream but a new
# disk, and without this the other repositories' tasks cannot start (作業フォルダ … がこの機械に無い).
if [ -f "$SB_HOST_HOME/.switchboard/switchboard.db" ]; then
  as_user bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    for (const { path } of db.query("SELECT path FROM workspaces").all()) console.log(path);
  ' "$SB_HOST_HOME/.switchboard/switchboard.db" | while read -r ws; do
    case "$ws" in "$SB_REPOS_DIR"/*) ;; *) continue ;; esac
    [ -d "$ws" ] && continue
    as_user gh repo clone "${SB_GITHUB_REPO%%/*}/$(basename "$ws")" "$ws" -- -q || echo "bootstrap: could not clone $(basename "$ws") (not in the token's repositories?)"
  done || echo "bootstrap: could not list the workspaces; clone them by hand (the daemon starts anyway)"
fi

# --- the runners' records (#401): Claude's sessions and memory, Codex's sessions, as sb-runner-sync last saved them ---
# (every hour, before an idle stop, before the rescue page's 作り直す). `sb-runner-sync restore` unpacks the newest set
# as the host user; files already here (the one-time import above) are kept.
# Only "nothing saved" (a first machine) skips it; any other failure stops the bootstrap, as the Litestream restore
# does — otherwise the first sync would put a near-empty base over the good one.
as_user env SB_HOST_ENV=/etc/switchboard-host.env /usr/local/bin/sb-runner-sync restore || { echo "bootstrap: could not bring back the runners' records" >&2; exit 1; }

# --- units ---
for u in switchboard.service sb-dockerd.service litestream.service sb-archive.service sb-archive.timer sb-runner-sync.service sb-runner-sync.timer; do
  sed -e "s|@USER@|$SB_HOST_USER|g" -e "s|@HOME@|$SB_HOST_HOME|g" -e "s|@REPO@|$REPO_DIR|g" "$HERE/$u" > "/etc/systemd/system/$u"
done
AWS_DEFAULT_REGION="$REGION" /usr/local/bin/sb-env /etc/switchboard.env "$SB_HOST_HOME/.switchboard/token" "$SB_HOST_USER"
systemctl daemon-reload
# systemd-oomd acts on the units' ManagedOOMMemoryPressure (a stall under MemoryMax); without it the host still serves
{ command -v /usr/lib/systemd/systemd-oomd >/dev/null || dnf install -y -q systemd-oomd-defaults; } && systemctl enable --now systemd-oomd \
  || echo "bootstrap: systemd-oomd could not start (exit $?); only the kernel's OOM killer guards the units" >&2
# a new kernel (the security updates above) runs only after a reboot: then enable without starting, so the daemon and
# its Tasks do not start only to be stopped by the reboot. needs-restarting exits 1 when a reboot is needed
REBOOT=0
dnf needs-restarting -r >/dev/null 2>&1 || REBOOT=1
if [ "$REBOOT" = 1 ]; then NOW=; else NOW=--now; fi
systemctl enable $NOW litestream.service sb-archive.timer sb-runner-sync.timer switchboard.service

mkdir -p "$(dirname "$DONE")" && date -u +%FT%TZ > "$DONE"
echo "bootstrap: done ($SB_HOST_USER, $REPO_DIR)"
# after DONE: the next boot finds it and does nothing (UserData too runs once per instance), and the units start then
if [ "$REBOOT" = 1 ]; then echo "bootstrap: rebooting into the updated kernel ($(uname -r) now)"; systemctl reboot; fi
