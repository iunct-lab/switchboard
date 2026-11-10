#!/usr/bin/env bash
# sb-host-update — before every start of switchboard.service (#435), as root: a fresh shallow clone of the repository's
# main, the same way UserData gets it (the token from Parameter Store in a header), and the host scripts from it into
# /usr/local/bin. Without this a changed sb-env reached the host only with 作り直す (#423).
# Which version: the sha of the promoted release (the name `releases/current` links to) when it is an ancestor of main,
# checked out in this root-owned clone; otherwise main's head, said on stderr. The host user's directories supply that
# name and nothing else: it must be 40 hex digits, and nothing in them is run here. A tree whose scripts do not parse, or
# whose sb-env fails a trial run into a temporary file, is not installed: the installed scripts stay.
# Only the scripts: the units and sb-rescue itself still come with 作り直す. A failed fetch keeps the installed scripts
# and lets the start go on.
# SB_BIN_DIR, SB_HOST_CLONE, SB_RELEASES_DIR, SB_HOST_ENV and SB_HOST_UPDATE_BUDGET are for the tests.
set -euo pipefail
export PATH="$PATH:/usr/sbin:/sbin"
BIN="${SB_BIN_DIR:-/usr/local/bin}"
CLONE="${SB_HOST_CLONE:-/opt/switchboard-host}"
HOST_ENV="${SB_HOST_ENV:-/etc/switchboard-host.env}"
# the commit the installed sb-host-update came from (root's, next to the clone)
UPDATER_FROM="$CLONE.updater"
# src:dst pairs; host-update.sh itself is installed first, outside this list
# systemd gives the unit's whole start 90 s (this, sb-env, sb-rescue): the steps below share this many seconds, each cut to
# what is left, and the sb-env trial is not started without enough of it (the installed scripts stay)
BUDGET="${SB_HOST_UPDATE_BUDGET:-60}"
TRIAL_MIN=5
# a step's own limit, or what is left of the budget when that is less (at least 1: `timeout 0` would not limit at all)
cap() { local l=$((BUDGET - SECONDS)); if [ "$l" -lt "$1" ]; then echo $((l > 1 ? l : 1)); else echo "$1"; fi; }
SCRIPTS="sb-stop.sh:sb-stop sb-env.sh:sb-env archive.sh:sb-archive runner-sync.sh:sb-runner-sync offload.sh:sb-offload pre-rebuild.sh:sb-pre-rebuild node.sh:sb-node"

# Security updates (#2186): 作り直す runs UserData's bootstrap, but that comes from the stack's GitHubRepo, which can lag
# behind (a renamed repository keeps its old name until an instance-replacing deploy), and the pinned AMI brings its
# own packages back. So every start also applies AL2023's latest security updates, in a unit of its own: the start does
# not wait for it (systemd gives the whole start 90 s), and a run still going is left alone. A new kernel is used from
# the next boot: /_auth/'s 停止する → 起動する (aws/README.md, Start, stop, rebuild).
# --refresh: fetch the metadata again even inside the cache's expiry, or a stale cache reads as no updates (#3344).
# skip_if_unavailable off for the AL2023 repository only: dnf's default skips it and exits 0 when its metadata cannot be
# fetched, the same silent pass; another repository being down does not hold the security updates back.
security_updates() {
  systemd-run --unit=sb-security-update --no-block --collect --quiet -- \
    dnf --releasever=latest upgrade -y -q --security --refresh --setopt=amazonlinux.skip_if_unavailable=False \
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

# The promoted release's sha, or nothing. Only a link's name is read from the host user's directory, and only a 40-digit
# hex name is used: a value a person could shape into anything else is dropped here. The path comes from root's
# /etc/switchboard-host.env (root's file, written by bootstrap) unless a test names the directory.
release_sha() {
  local home dir link name
  dir="${SB_RELEASES_DIR:-}"
  if [ -z "$dir" ]; then
    home="$(sed -n 's/^SB_HOST_HOME=//p' "$HOST_ENV" 2>/dev/null | tail -n 1 || true)"
    [[ "$home" =~ ^/[A-Za-z0-9_./-]+$ ]] || return 0
    dir="$home/.switchboard/releases"
  fi
  link="$(readlink "$dir/current" 2>/dev/null || true)"
  name="${link##*/}"
  [[ "$name" =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$name"
  return 0
}

# before anything is installed: every script of the list parses, and the new sb-env runs to the end into a temporary file
# (it is what runs next, as root, in the same start)
verify_tree() {
  local h="$1/aws/host" src tmp rc=0
  for src in host-update.sh:x $SCRIPTS; do
    src="${src%%:*}"
    [ -f "$h/$src" ] || continue
    bash -n "$h/$src" 2>/dev/null || { echo "$src does not parse"; return 1; }
  done
  [ -f "$h/sb-env.sh" ] || return 0
  [ $((BUDGET - SECONDS)) -ge "$TRIAL_MIN" ] || { echo "no time left for the sb-env.sh trial run"; return 1; }
  tmp="$(mktemp)" || { echo "no temporary file"; return 1; }
  timeout "$(cap 60)" bash "$h/sb-env.sh" "$tmp" >/dev/null 2>&1 || rc=$?
  rm -f "$tmp"
  [ "$rc" -eq 0 ] || { echo "sb-env.sh trial run exited $rc"; return 1; }
}

update_scripts() {
  local repo token sha out want from=main why old
  # a start cut between the two renames below left the previous clone as .old: take it back
  [ -d "$CLONE" ] || [ ! -d "$CLONE.old" ] || mv "$CLONE.old" "$CLONE"
  # CLONE is root-owned; never read the host user's worktree or configuration.
  git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1 || { echo "sb-host-update: no $CLONE; skipped" >&2; return 0; }
  repo="$(timeout "$(cap 15)" aws ssm get-parameter --name /switchboard/github-repo --query Parameter.Value --output text 2>/dev/null || true)"
  if [[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]]; then
    repo="https://github.com/$repo.git"
  else
    # said, so a missing read permission or a mistyped value shows in the journal instead of a quiet fallback
    echo "sb-host-update: no readable /switchboard/github-repo; following the origin of $CLONE" >&2
    repo="$(git -C "$CLONE" remote get-url origin)"
  fi
  # bounded, like the clone: the unit's whole start (this, sb-env, sb-rescue) has systemd's 90 s
  if ! token="$(timeout "$(cap 15)" aws ssm get-parameter --name /switchboard/github-token --with-decryption --query Parameter.Value --output text)"; then
    echo "sb-host-update: could not fetch main (no token from Parameter Store); keeping the installed scripts" >&2
    return 0
  fi
  rm -rf "$CLONE.new"
  # the header goes through git's environment, not its arguments: root's command line is readable by every user.
  # Blobs are fetched lazily (--filter=blob:none), so the checkout of another commit needs it too.
  authgit() {
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$token" | base64 -w0)" \
      timeout "$(cap 30)" git "$@"
  }
  if ! out="$(authgit clone --filter=blob:none --branch main -q "$repo" "$CLONE.new" 2>&1)"; then
    rm -rf "$CLONE.new"
    echo "sb-host-update: could not fetch main ($out); keeping the installed scripts" >&2
    return 0
  fi
  want="$(release_sha)"
  if [ -z "$want" ]; then
    echo "sb-host-update: no promoted release sha; using main" >&2
  elif ! git -C "$CLONE.new" merge-base --is-ancestor "$want" HEAD >/dev/null 2>&1; then
    echo "sb-host-update: release ${want:0:7} is not in main's history; using main" >&2
  elif ! out="$(authgit -C "$CLONE.new" checkout -q --detach "$want" 2>&1)"; then
    rm -rf "$CLONE.new"
    echo "sb-host-update: could not check out release ${want:0:7} ($out); keeping the installed scripts" >&2
    return 0
  else
    from=release
  fi
  if ! why="$(verify_tree "$CLONE.new")"; then
    rm -rf "$CLONE.new"
    echo "sb-host-update: $why; keeping the installed scripts" >&2
    return 0
  fi
  # this updater is replaced only going forward in main's history: a promotion back to a release from before the pinning
  # would otherwise install an updater without it, and the next start would take main's head unchecked. Where the
  # installed one came from is kept in root's $UPDATER_FROM (the clone's head moves back with a rollback, so it cannot
  # say). The other scripts follow the release either way (a rollback of them is what the promotion asked for)
  old="$(sed -n '1{/^[0-9a-f]\{40\}$/p}' "$UPDATER_FROM" 2>/dev/null || true)"
  # no record yet (bootstrap, or a host from before it): the installed one came from this clone's head, as it always
  # did until the record — bootstrap installs it from this clone, and an updater without pinning only ever took main's head
  # — and that is written down now, before the clone moves (a promotion back would move its head with it)
  if [ -z "$old" ]; then
    old="$(git -C "$CLONE" rev-parse HEAD 2>/dev/null || true)"
    [[ "$old" =~ ^[0-9a-f]{40}$ ]] && printf '%s\n' "$old" > "$UPDATER_FROM.tmp" && mv "$UPDATER_FROM.tmp" "$UPDATER_FROM"
  fi
  local self=yes
  if [ -n "$old" ] && ! git -C "$CLONE.new" merge-base --is-ancestor "$old" HEAD >/dev/null 2>&1; then
    self=
    echo "sb-host-update: the tree is behind the installed sb-host-update (${old:0:7}); keeping it as it is" >&2
  fi
  rm -rf "$CLONE.old"
  mv "$CLONE" "$CLONE.old" && mv "$CLONE.new" "$CLONE" && rm -rf "$CLONE.old"
  local h="$CLONE/aws/host" src dst
  # itself first: when main renames one of the others, the next start runs main's own list
  if [ -n "$self" ]; then
    install -m 755 "$h/host-update.sh" "$BIN/sb-host-update"
    git -C "$CLONE" rev-parse HEAD > "$UPDATER_FROM.tmp" 2>/dev/null && mv "$UPDATER_FROM.tmp" "$UPDATER_FROM" || rm -f "$UPDATER_FROM.tmp"
  fi
  for src in $SCRIPTS; do
    dst="${src#*:}" src="${src%%:*}"
    if [ -f "$h/$src" ]; then install -m 755 "$h/$src" "$BIN/$dst"; else echo "sb-host-update: main has no aws/host/$src; $dst left as it was" >&2; fi
  done
  sha="$(git -C "$CLONE" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "sb-host-update: $sha from $from"
}

# in a function so that replacing this file while it runs does not change what bash reads next
main() {
  security_updates
  update_scripts
  node_update
}
# one line: bash has read all of it before main replaces this file, and then reads nothing more of it
main "$@"; exit
