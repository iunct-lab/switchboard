#!/usr/bin/env bash
# The E2E of the stand-alone mode (#4191): in the image of container/Dockerfile a fake runner's Task finishes, and after
# the container is recreated the Task list and the session file are still there. No real runner is run. Not in CI (the
# image build is heavy); run it by hand: sb-offload --size medium 'bash container/e2e.sh'
# The same compose.yaml as container/up.sh, with an override file that (a) starts container/boot-fake.ts, the fake
# daemon, in place of the entrypoint and (b) names the image sb-e2e. The project name sb-e2e keeps the volumes
# (sb-e2e_sb-home ...) apart from the ones of a real start (the project switchboard), so down -v here cannot touch them.
set -eu
cd "$(dirname "$0")/.."
W=$(mktemp -d /tmp/switchboard.4191.XXXXXX)
cat > "$W/override.yaml" <<'YAML'
services:
  switchboard:
    image: sb-e2e
    entrypoint: ["bun", "/opt/switchboard/container/boot-fake.ts"]
YAML
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0)
export DOCKER_GID
dc() { docker compose -p sb-e2e -f container/compose.yaml -f "$W/override.yaml" "$@"; }
BASE=http://127.0.0.1:47831
CWD=/home/switchboard
fail() {
  echo "FAIL: $*" >&2
  dc logs --no-color --tail 100 >&2 || true
  exit 1
}
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT

# port 47831 is the published one: a real start on the machine would have it already
if (exec 3<>/dev/tcp/127.0.0.1/47831) 2>/dev/null; then
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
healthy() { curl -fsS "$BASE/api/health"; }
task_status() { curl -fsS "$BASE/api/tasks/$1" | jq -r .task.status; }
task_done() { [ "$(task_status "$1")" = done ]; }
marked() { dc exec -T switchboard sh -c 'grep -l e2e-mark "$HOME"/.claude/projects/*/e2e-session-1.jsonl'; }

dc down -v --remove-orphans >/dev/null 2>&1 || true
dc up -d --build || fail "compose up"
wait_for 90 "daemon health through the relay" healthy

ID=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d "{\"cwd\":\"$CWD\",\"title\":\"e2e\",\"prompt\":\"p\",\"runner\":\"claude\"}" "$BASE/api/tasks" | jq -r .id) ||
  fail "POST /api/tasks"
[ -n "$ID" ] && [ "$ID" != null ] || fail "no task id from POST /api/tasks"
wait_for 60 "task $ID done" task_done "$ID"
echo "task done: $ID"

dc down || fail "compose down"
dc up -d || fail "compose up after recreate"
wait_for 90 "daemon health after recreate" healthy
curl -fsS "$BASE/api/tasks" | jq -e --arg id "$ID" 'map(.id) | index($id) != null' >/dev/null || fail "task $ID not in GET /api/tasks after recreate"
echo "same id after recreate: $ID"
marked >/dev/null || fail "session file gone after recreate"
echo "session file kept: ~/.claude/projects/*/e2e-session-1.jsonl"
