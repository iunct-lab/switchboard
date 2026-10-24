#!/usr/bin/env bash
# sb-host-update — before every start of switchboard.service (#435), as root: a fresh shallow clone of the repository's
# main, the same way UserData gets it (the token from Parameter Store in a header), and the host scripts from it into
# /usr/local/bin. Without this a changed sb-env reached the host only with 作り直す (#423).
# Only the scripts: the units and sb-rescue itself still come with 作り直す. Nothing the host user can write (releases,
# work trees) is run here. A failed fetch keeps the installed scripts and lets the start go on.
# SB_BIN_DIR and SB_HOST_CLONE are for the tests.
set -euo pipefail
export PATH="$PATH:/usr/sbin:/sbin"
BIN="${SB_BIN_DIR:-/usr/local/bin}"
CLONE="${SB_HOST_CLONE:-/opt/switchboard-host}"

# Security updates (#2186): 作り直す runs UserData's bootstrap, but that comes from the stack's GitHubRepo, which can lag
# behind (a renamed repository keeps its old name until an instance-replacing deploy), and the pinned AMI brings its
# own packages back. So every start also applies AL2023's latest security updates, in a unit of its own: the start does
# not wait for it (systemd gives the whole start 90 s), and a run still going is left alone. A new kernel is used from
# the next boot: /_auth/'s 停止する → 起動する (aws/README.md, the CVE section).
security_updates() {
  systemd-run --unit=sb-security-update --no-block --collect --quiet -- dnf --releasever=latest upgrade -y -q --security \
    || echo "sb-host-update: security updates not started (exit $?)" >&2
}

# Node.js from nodejs.org is not a dnf package: the pin of the installed sb-node (node.sh) replaces a different version,
# in a unit of its own like the security updates, since a download does not fit the start. After the fetch, so a new pin
# is used at once, and also when the fetch fails, so a run stopped halfway is put back (review #2513)
node_update() {
  [ -x "$BIN/sb-node" ] || return 0
  systemd-run --unit=sb-node-update --no-block --collect --quiet -- "$BIN/sb-node" \
    || echo "sb-host-update: node update not started (exit $?)" >&2
}

update_scripts() {
  local repo token sha out
  # a start cut between the two renames below left the previous clone as .old: take it back
  [ -d "$CLONE" ] || [ ! -d "$CLONE.old" ] || mv "$CLONE.old" "$CLONE"
  # CLONE is root-owned; never read the host user's worktree or configuration.
  git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1 || { echo "sb-host-update: no $CLONE; skipped" >&2; return 0; }
  repo="$(timeout 15 aws ssm get-parameter --name /switchboard/github-repo --query Parameter.Value --output text 2>/dev/null || true)"
  if [[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
    repo="https://github.com/$repo.git"
  else
    # said, so a missing read permission or a mistyped value shows in the journal instead of a quiet fallback
    echo "sb-host-update: no readable /switchboard/github-repo; following the origin of $CLONE" >&2
    repo="$(git -C "$CLONE" remote get-url origin)"
  fi
  # bounded, like the clone: the unit's whole start (this, sb-env, sb-rescue) has systemd's 90 s
  if ! token="$(timeout 15 aws ssm get-parameter --name /switchboard/github-token --with-decryption --query Parameter.Value --output text)"; then
    echo "sb-host-update: could not fetch main (no token from Parameter Store); keeping the installed scripts" >&2
    return 0
  fi
  rm -rf "$CLONE.new"
  # the header goes through git's environment, not its arguments: root's command line is readable by every user
  if ! out="$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 -w0)" \
      timeout 30 git clone --depth 1 --branch main -q "$repo" "$CLONE.new" 2>&1)"; then
    rm -rf "$CLONE.new"
    echo "sb-host-update: could not fetch main ($out); keeping the installed scripts" >&2
    return 0
  fi
  rm -rf "$CLONE.old"
  mv "$CLONE" "$CLONE.old" && mv "$CLONE.new" "$CLONE" && rm -rf "$CLONE.old"
  local h="$CLONE/aws/host" src dst
  # itself first: when main renames one of the others, the next start runs main's own list
  install -m 755 "$h/host-update.sh" "$BIN/sb-host-update"
  for src in sb-stop.sh:sb-stop sb-env.sh:sb-env archive.sh:sb-archive runner-sync.sh:sb-runner-sync offload.sh:sb-offload pre-rebuild.sh:sb-pre-rebuild node.sh:sb-node; do
    dst="${src#*:}" src="${src%%:*}"
    if [ -f "$h/$src" ]; then install -m 755 "$h/$src" "$BIN/$dst"; else echo "sb-host-update: main has no aws/host/$src; $dst left as it was" >&2; fi
  done
  sha="$(git -C "$CLONE" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "sb-host-update: $sha from main"
}

# in a function so that replacing this file while it runs does not change what bash reads next
main() {
  security_updates
  update_scripts
  node_update
}
# one line: bash has read all of it before main replaces this file, and then reads nothing more of it
main "$@"; exit
