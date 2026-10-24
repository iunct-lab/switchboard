#!/usr/bin/env bash
# sb-offload [--size small|medium|large] <command…> (#678) — runs a docker build, a compose stack or its tests off the host, in one build of the
# stack's offload CodeBuild project (aws/template.yaml, Offload): a fresh arm machine with docker that goes away when the
# build ends. The host has 4 GiB and its dockerd is capped at 1.5 GiB (sb-dockerd.service), which such checks exceed.
# Sends the git work tree it is run in (tracked files, a submodule's included, and untracked ones, uncommitted changes
# included; ignored files and an untracked clone's contents not) to
# s3://<data>/offload/, runs the arguments there as one shell command, streams the build's log here and exits with the
# command's exit code — the last `sb-offload: exit N` line of the log — or 124 when the build timed out, 130 when it
# was stopped, 1 when it failed before the command returned (the upload could not be unpacked). Ctrl-C (or TERM) stops the build. The upload is removed however it ends; offload/ also expires after a day.
# The machine's size is chosen per call (#2304): small (2 vCPU / 4 GiB) unless --size says medium (4 / 8) or large
# (8 / 16, which a compose stack's checks can need), passed as --compute-type-override on every call, so the project's
# own LARGE never applies. The size is on the `started` line (after the wait line when both builds are busy).
# Explicit only: `docker` itself stays on the host (bind mounts and localhost ports are there). Only the work tree goes:
# no credentials, no token, no other host file. What the command starts is not reachable from here — only the log is.
set -euo pipefail
USAGE="usage: sb-offload [--size small|medium|large] <command…>   e.g. sb-offload --size large docker compose up --build --abort-on-container-exit"
SIZE_NAME=small
case "${1:-}" in
  --size) SIZE_NAME="${2:-}"; shift $(($# < 2 ? $# : 2)) ;;
  --size=*) SIZE_NAME="${1#--size=}"; shift ;;
esac
# the list's largest is the project's own size, so a build through here costs no more than it did (#2304)
case "$SIZE_NAME" in
  small) COMPUTE=BUILD_GENERAL1_SMALL ;; medium) COMPUTE=BUILD_GENERAL1_MEDIUM ;; large) COMPUTE=BUILD_GENERAL1_LARGE ;;
  *) echo "sb-offload: --size is small, medium or large (default small), not '$SIZE_NAME'" >&2; exit 2 ;;
esac
[ $# -gt 0 ] || { echo "$USAGE" >&2; exit 2; }
ENV_FILE="${SB_HOST_ENV:-/etc/switchboard-host.env}"
[ -f "$ENV_FILE" ] || { echo "sb-offload: no $ENV_FILE — this is not the cloud host; run docker here instead" >&2; exit 2; }
# shellcheck source=/dev/null
. "$ENV_FILE"   # SB_DATA_BUCKET
CMD="$*"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "sb-offload: not in a git work tree (it sends the work tree it is run in)" >&2; exit 2; }

mkdir -p "$HOME/.cache"
TMP="$(mktemp -d "$HOME/.cache/sb-offload.XXXXXX")"   # not /tmp: it is RAM here
KEY="offload/$(date -u +%Y%m%dT%H%M%SZ)-${TMP##*.}.tar.gz"
UPLOADED=; BUILD=; ENDED=
cleanup() {
  # however this ends before the build does (Ctrl-C, a poll that keeps failing), the build is not left running
  if [ -n "$BUILD" ] && [ -z "$ENDED" ]; then
    aws codebuild stop-build --id "$BUILD" >/dev/null 2>&1 || echo "sb-offload: could not stop $BUILD; it ends at the project's time limit" >&2
    echo "sb-offload: stopped $BUILD" >&2
  fi
  rm -rf "$TMP"
  [ -z "$UPLOADED" ] || aws s3 rm "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'trap - INT TERM; exit 130' INT TERM

# tracked files (a submodule's too) and untracked ones. A tracked file deleted in the work tree is still listed:
# --ignore-failed-read skips it. --no-recursion: git lists an untracked clone inside as one folder, whose files (its
# ignored ones too) are not the work tree's
( cd "$ROOT" && { git ls-files -c --recurse-submodules -z && git ls-files -o --exclude-standard -z; } | tar --no-recursion --ignore-failed-read --warning=no-failed-read --null -czf "$TMP/tree.tar.gz" -T - )
FILES="$(tar -tzf "$TMP/tree.tar.gz" | grep -vc '/$' || true)"
SIZE="$(du -k "$TMP/tree.tar.gz" | cut -f1)"
PROJECT="$(aws ssm get-parameter --name /switchboard/offload-project --query Parameter.Value --output text)"
aws s3 cp "$TMP/tree.tar.gz" "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors
UPLOADED=1
ENVS="$(jq -cn --arg k "$KEY" --arg c "$CMD" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_OFFLOAD_CMD",value:$c,type:"PLAINTEXT"}]')"
# the project runs 2 builds at a time and refuses a third (it does not queue it): wait for a slot, up to 15 minutes
for i in $(seq 180); do
  BUILD="$(aws codebuild start-build --project-name "$PROJECT" --compute-type-override "$COMPUTE" --environment-variables-override "$ENVS" --query build.id --output text 2>"$TMP/start.err")" && break
  grep -qE 'AccountLimitExceeded|active builds' "$TMP/start.err" || { cat "$TMP/start.err" >&2; exit 1; }
  [ "$i" -lt 180 ] || { echo "sb-offload: no free build in 15 minutes (2 run at a time)" >&2; exit 1; }
  [ "$i" -gt 1 ] || echo "sb-offload: 2 builds are running; waiting for one to end" >&2
  sleep 5 & wait $!
done
echo "sb-offload: sent the work tree ($FILES files, $((SIZE / 1024)) MB) and started $BUILD ($SIZE_NAME)" >&2

# the log so far, from where the last call stopped; a stream that does not exist yet prints nothing
TOKEN=; GROUP=; STREAM=
pull_log() {
  local page next
  [ -n "$STREAM" ] || return 0
  while page="$(aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" --start-from-head ${TOKEN:+--next-token "$TOKEN"} --output json 2>/dev/null)"; do
    jq -r '.events[].message | rtrimstr("\n")' <<<"$page" | tee -a "$TMP/log"
    next="$(jq -r '.nextForwardToken' <<<"$page")"
    [ "$next" != "$TOKEN" ] || break
    TOKEN="$next"
  done
}
touch "$TMP/log"
STATUS=IN_PROGRESS
FAILS=0
while :; do
  # a blip (throttling, the network) is tried again; three in a row and the build is stopped (cleanup)
  if ! read -r STATUS GROUP STREAM < <(aws codebuild batch-get-builds --ids "$BUILD" --query 'builds[0].[buildStatus,logs.groupName,logs.streamName]' --output text); then
    FAILS=$((FAILS + 1))
    [ "$FAILS" -lt 3 ] || { echo "sb-offload: could not read the state of $BUILD" >&2; exit 1; }
    sleep 5 & wait $!
    continue
  fi
  FAILS=0
  [ "$GROUP" != None ] || GROUP=; [ "$STREAM" != None ] || STREAM=
  pull_log
  [ "$STATUS" = IN_PROGRESS ] || { ENDED=1; break; }
  sleep 5 & wait $!   # in the background so Ctrl-C is handled at once, not after the sleep
done
# the last lines can reach CloudWatch a little after the build ends
for _ in 1 2 3 4 5 6; do
  grep -qE '^sb-offload: exit [0-9]+$' "$TMP/log" || [ "$STATUS" != SUCCEEDED ] && break
  sleep 5 & wait $!
  pull_log
done
CODE="$(grep -oE '^sb-offload: exit [0-9]+$' "$TMP/log" | tail -1 | grep -oE '[0-9]+$' || true)"
if [ -z "$CODE" ]; then
  case "$STATUS" in TIMED_OUT) CODE=124 ;; STOPPED) CODE=130 ;; *) CODE=1 ;; esac
  echo "sb-offload: $BUILD ended $STATUS without the command's exit code" >&2
fi
exit "$CODE"
