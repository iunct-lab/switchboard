#!/usr/bin/env bash
# The E2E of the container's two roles under sb-rescue (container/entrypoint.sh). No real runner, no GitHub.
#   Use only: the container is started against a fake Releases API (container/fake-releases.ts) holding three releases
#     of this tree. It must build v0.1.0 into the sb-home volume with no .git anywhere, answer on the machine's
#     127.0.0.1 for the daemon and inside the container only for the rescue page, leave v0.2.0 alone when the check of its diff says `concern`,
#     go up to v0.3.0 when the check says `ok`, and still run v0.3.0 after the container is recreated and rebuilt.
#   Develop: with SWITCHBOARD_REPO_ROOT on a clone in the sb-repos volume it must build the clone's HEAD, go up to a
#     new tag with no check of the diff, and still run it after a recreate.
# The releases run the real core (the newest release, the check's Task, the promotion and sb-rescue's candidate are the
# real code); only the runner is a fake and the check for a new release comes every 2 seconds
# (container/release-boot-fake.ts). The fake runner's verdict is read from ~/.switchboard/e2e-verdict.
# Not in CI (the image and five release builds are heavy); run it by hand: sb-offload --size medium 'bash container/e2e-release.sh'
# It takes a while: the daemon keeps the answer about the newest release for 10 minutes, so each new release may wait that long.
# The project names sb-e2e-release and sb-e2e-clone keep the volumes apart from a real start's (the project
# switchboard), so down -v here cannot touch them. Needs git, jq, curl and tar on the machine.
set -eu
cd "$(dirname "$0")/.."
W=$(mktemp -d /tmp/switchboard.e2e-release.XXXXXX)
REPO=$(jq -r '.publicSync.target // empty' ops.config.json)
[ -n "$REPO" ] || { echo "FAIL: ops.config.json names no publicSync.target" >&2; exit 1; }
BASE=http://127.0.0.1:47831
RESCUE=http://127.0.0.1:47841 # inside the container only: sb-rescue's port is neither relayed nor published
API_PORT=8080
SHA1=$(printf '1%.0s' $(seq 40))
SHA2=$(printf '2%.0s' $(seq 40))
SHA3=$(printf '3%.0s' $(seq 40))
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)
export DOCKER_GID

cat > "$W/release.yaml" <<YAML
services:
  switchboard:
    image: sb-e2e-release
    environment:
      SWITCHBOARD_GITHUB_API: http://releases:$API_PORT
  releases:
    image: sb-e2e-release
    pull_policy: never
    entrypoint: ["bun", "/opt/switchboard/container/fake-releases.ts", "$API_PORT", "$REPO", "/releases"]
    volumes:
      - $W/releases:/releases:ro
YAML
cat > "$W/clone.yaml" <<YAML
services:
  switchboard:
    image: sb-e2e-release
    environment:
      SWITCHBOARD_REPO_ROOT: /home/switchboard/repos/switchboard
YAML
PROJECT=sb-e2e-release
OVERRIDE=$W/release.yaml
dc() { docker compose -p "$PROJECT" -f container/compose.yaml -f "$OVERRIDE" "$@"; }
down_all() {
  for p in sb-e2e-release:release sb-e2e-clone:clone; do
    docker compose -p "${p%%:*}" -f container/compose.yaml -f "$W/${p##*:}.yaml" down -v --remove-orphans >/dev/null 2>&1 || true
  done
}
fail() {
  echo "FAIL: $*" >&2
  dc logs --no-color --tail 150 >&2 || true
  echo "--- sb-rescue status and history" >&2
  dc exec -T switchboard curl -fsS "$RESCUE/api/status" >&2 || true
  echo >&2
  echo "--- the daemon's log" >&2
  dc exec -T switchboard sh -c 'tail -n 80 "$HOME/.switchboard/daemon.log"' >&2 || true
  exit 1
}
cleanup() {
  down_all
  rm -rf "$W"
}
trap cleanup EXIT

if (exec 3<>"/dev/tcp/127.0.0.1/47831") 2>/dev/null; then
  echo "FAIL: 127.0.0.1:47831 is already in use (a real stand-alone start?)" >&2
  exit 1
fi

wait_for() { # <seconds> <description> <command...>
  local n=$1 what=$2
  shift 2
  for _ in $(seq "$n"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "timed out: $what"
}
healthy() { curl -fsS "$BASE/api/health" | jq -e '.ok == true'; }
rescue_page() { [ "$(dc exec -T switchboard curl -s -o /dev/null -w '%{http_code}' "$RESCUE/" | tr -d '\r\n')" = 200 ]; }
# sb-rescue answers neither on the machine's 127.0.0.1 nor on the container's own address (where a peer on the bridge arrives)
rescue_closed() {
  local addr
  ! curl -s -o /dev/null --max-time 3 "$RESCUE/" || return 1
  addr=$(dc exec -T switchboard sh -c 'getent hosts "$(cat /etc/hostname)" | cut -d" " -f1 | head -n 1' | tr -d '\r\n')
  [ -n "$addr" ] && ! dc exec -T switchboard curl -s -o /dev/null --max-time 3 "http://$addr:47841/"
}
current() { dc exec -T switchboard sh -c 'basename "$(readlink "$HOME/.switchboard/releases/current")"' | tr -d '\r\n'; }
current_is() { [ "$(current)" = "$1" ]; }
serves() { [ "$(curl -fsS "$BASE/api/health" | jq -r .webRelease)" = "$1" ]; }
review_is() { curl -fsS "$BASE/api/daemon/release" | jq -e --arg tag "$1" --arg state "$2" '.latestRelease.tag == $tag and .review.state == $state'; }
verdict() { dc exec -T switchboard sh -c "echo $1 > \"\$HOME/.switchboard/e2e-verdict\"" || fail "write the verdict $1"; }
publish() { dc exec -T switchboard curl -fsS -X POST -d "{\"tag\":\"$1\"}" "http://releases:$API_PORT/e2e/latest" >/dev/null || fail "publish $1 on the fake Releases API"; }
recreated() { # <release> <description>: the version comes from the volume, not from the image
  wait_for 300 "daemon health after $2" healthy
  current_is "$1" || fail "after $2 current is $(current), not $1"
  serves "$1" || fail "after $2 /api/health serves another release than $1"
  echo "after $2: still $1"
}

# --- the releases: this tree at HEAD, started by release-boot-fake.ts, one marker file apart
mkdir -p "$W/releases" "$W/tree"
git archive --format=tar HEAD | tar -x -C "$W/tree"
[ -f "$W/tree/container/release-boot-fake.ts" ] || { echo "FAIL: container/release-boot-fake.ts is not in HEAD (commit it first: the releases are made from HEAD)" >&2; exit 1; }
echo 'import "../../../container/release-boot-fake.ts";' > "$W/tree/packages/core/src/main.ts"
make_release() { # <tag> <sha>
  local top
  top="$(echo "$REPO" | tr / -)-$(echo "$2" | cut -c1-7)"
  echo "$1" > "$W/tree/e2e-version"
  tar -czf "$W/releases/$1.tar.gz" -C "$W" --transform "s,^tree,$top," tree
  echo "$2" > "$W/releases/$1.sha"
}
make_release v0.1.0 "$SHA1"
make_release v0.2.0 "$SHA2"
make_release v0.3.0 "$SHA3"

down_all

# --- use only: from the Releases, with the check of the diff
dc build switchboard || fail "image build"
dc up -d || fail "compose up"
wait_for 900 "the first release built and the daemon healthy through the relay" healthy
wait_for 30 "the rescue page inside the container" rescue_page
rescue_closed || fail "sb-rescue answers outside the container's loopback"
current_is "$SHA1" || fail "current is $(current), not v0.1.0 ($SHA1)"
[ -z "$(dc exec -T switchboard sh -c 'find "$HOME/.switchboard" -name .git')" ] || fail "a .git under ~/.switchboard"
echo "use only: v0.1.0 runs under sb-rescue, no .git"

verdict concern
publish v0.2.0
wait_for 900 "the check of v0.2.0 ends with a concern" review_is v0.2.0 concern
sleep 10 # several checks for a new release (every 2 seconds) pass with the concern standing
current_is "$SHA1" || fail "v0.2.0 was promoted with a concern: current is $(current)"
echo "use only: v0.2.0 (concern) is not promoted"

verdict ok
publish v0.3.0
wait_for 1500 "v0.3.0 (ok) is promoted" current_is "$SHA3"
wait_for 120 "daemon health on v0.3.0" serves "$SHA3"
echo "use only: v0.3.0 (ok) is promoted"

dc down || fail "compose down"
dc up -d || fail "compose up after down"
recreated "$SHA3" "down and up"
dc up -d --build --force-recreate || fail "compose up --build"
recreated "$SHA3" "a rebuild of the image"
dc down -v --remove-orphans >/dev/null 2>&1 || true

# --- develop: from a clone's tags, no check of the diff
PROJECT=sb-e2e-clone
OVERRIDE=$W/clone.yaml
CLONE=/home/switchboard/repos/switchboard
g() { git -C "$W/tree" -c user.name=e2e -c user.email=e2e@example.com "$@"; }
echo v0.1.0 > "$W/tree/e2e-version"
g init -q -b main
g add -A
g commit -q -m v0.1.0
g tag v0.1.0
C1=$(g rev-parse HEAD)
dc run --rm --no-deps -T --entrypoint bash -v "$W/tree:/src:ro" switchboard -c "cp -r /src $CLONE" || fail "copy the clone into the sb-repos volume"
dc up -d || fail "compose up (clone)"
wait_for 900 "the clone's HEAD built and the daemon healthy" healthy
wait_for 30 "the rescue page inside the container (clone)" rescue_page
rescue_closed || fail "sb-rescue answers outside the container's loopback (clone)"
current_is "$C1" || fail "current is $(current), not the clone's HEAD ($C1)"
echo "develop: the clone's HEAD runs under sb-rescue"
C2=$(dc exec -T switchboard sh -c "cd $CLONE && echo v0.2.0 > e2e-version && git -c user.name=e2e -c user.email=e2e@example.com commit -q -am v0.2.0 && git tag v0.2.0 && git rev-parse HEAD" | tr -d '\r\n') || fail "tag v0.2.0 in the clone"
wait_for 900 "the clone's tag v0.2.0 is promoted" current_is "$C2"
wait_for 120 "daemon health on the clone's v0.2.0" serves "$C2"
[ "$(curl -fsS "$BASE/api/daemon/release" | jq -r '.review // "none"')" = none ] || fail "a check of the diff ran for the clone's own tag"
echo "develop: the tag v0.2.0 is promoted with no check of the diff"
dc down || fail "compose down (clone)"
dc up -d || fail "compose up after down (clone)"
recreated "$C2" "down and up (clone)"
echo "PASS"
