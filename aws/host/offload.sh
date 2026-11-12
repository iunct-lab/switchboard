#!/usr/bin/env bash
# sb-offload [--size small|medium|large] [--ci] <command…> (#678) — runs a docker build, a compose stack or its tests off the host, in one build of the
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
# --ci (#4707) runs the command in the ci image instead (the offload CI project): the image's tag is the first 12 hex digits of the
# sha256 of container/Dockerfile, so a changed Dockerfile or pin is a new tag; if the image repository has no such tag the image project
# builds it first (its log is read the same way), and the build then starts with that tag as its image. The log has `sb-offload: image <tag>`.
# Explicit only: `docker` itself stays on the host (bind mounts and localhost ports are there). Only the work tree goes:
# no credentials, no token, no other host file. What the command starts is not reachable from here — only the log is.
set -euo pipefail
USAGE="usage: sb-offload [--size small|medium|large] [--ci] <command…>   e.g. sb-offload docker compose up --build --abort-on-container-exit (small; --size medium or large only when small runs out of memory)"
SIZE_NAME=small
CI=
# --size and --ci in either order, before the command
while :; do
  case "${1:-}" in
    --size) SIZE_NAME="${2:-}"; shift $(($# < 2 ? $# : 2)) ;;
    --size=*) SIZE_NAME="${1#--size=}"; shift ;;
    --ci) CI=1; shift ;;
    *) break ;;
  esac
done
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
# the full names are written out: the host role's read permission is checked against the names in the scripts (aws/template.test.ts)
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
if [ -n "$CI" ]; then PROJECT="$(param /switchboard/offload-ci-project)"; else PROJECT="$(param /switchboard/offload-project)"; fi
aws s3 cp "$TMP/tree.tar.gz" "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors
UPLOADED=1
ENVS="$(jq -cn --arg k "$KEY" --arg c "$CMD" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_OFFLOAD_CMD",value:$c,type:"PLAINTEXT"}]')"
# Starts a build of project $1 with the start-build arguments in START_ARGS, says $2 (and $3 after the build's id; $4 is the
# regex of the log's last line, see DONE_RE), then
# follows it to its end: the log goes to the output and $TMP/log, STATUS is how it ended. The image build (--ci) and the command's
# build are both run here, one after the other.
run_build() {
BUILD=; ENDED=; TOKEN=; GROUP=; STREAM=
# the project runs 2 builds at a time and refuses a third (it does not queue it): wait for a slot, up to 15 minutes
for i in $(seq 180); do
  BUILD="$(aws codebuild start-build --project-name "$1" "${START_ARGS[@]}" --query build.id --output text 2>"$TMP/start.err")" && break
  grep -qE 'AccountLimitExceeded|active builds' "$TMP/start.err" || { cat "$TMP/start.err" >&2; exit 1; }
  [ "$i" -lt 180 ] || { echo "sb-offload: no free build in 15 minutes (2 run at a time)" >&2; exit 1; }
  [ "$i" -gt 1 ] || echo "sb-offload: 2 builds are running; waiting for one to end" >&2
  sleep 5 & wait $!
done
echo "sb-offload: $2 $BUILD${3:+ $3}" >&2

# the log so far, from where the last call stopped; a stream that does not exist yet prints nothing. With FULL set the lines go
# to that file instead of the output and $TMP/log
pull_log() {
  local page next
  [ -n "$STREAM" ] || return 0
  while page="$(aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$STREAM" --start-from-head ${TOKEN:+--next-token "$TOKEN"} --output json 2>/dev/null)"; do
    if [ -n "${FULL:-}" ]; then jq -r '.events[].message | rtrimstr("\n")' <<<"$page" >>"$FULL"; else jq -r '.events[].message | rtrimstr("\n")' <<<"$page" | tee -a "$TMP/log"; fi
    next="$(jq -r '.nextForwardToken' <<<"$page")"
    [ "$next" != "$TOKEN" ] || break
    TOKEN="$next"
  done
}
# the line that is the log's last that matters: $4 (default the command's exit); when the build succeeded it is waited for
DONE_RE="${4:-^sb-offload: exit [0-9]+\$}"
: >"$TMP/log"
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
  grep -qE "$DONE_RE" "$TMP/log" || [ "$STATUS" != SUCCEEDED ] && break
  sleep 5 & wait $!
  pull_log
done
# events that reach CloudWatch late can sit before the point the token has moved to and never come back: read the whole stream
# again from its head, and if it has more lines than were printed, print all of it (#4494)
if [ -n "$STREAM" ]; then
  TOKEN=; FULL="$TMP/full"; : >"$FULL"
  pull_log || true
  FULL=
  MISSING=$(( $(wc -l <"$TMP/full") - $(wc -l <"$TMP/log") ))
  if [ "$MISSING" -gt 0 ]; then
    echo "sb-offload: read the log again from the head ($MISSING lines were missing)" >&2
    cat "$TMP/full"
    mv "$TMP/full" "$TMP/log"
  fi
fi
}
START_ARGS=(--compute-type-override "$COMPUTE" --environment-variables-override "$ENVS")
if [ -n "$CI" ]; then
  # the tag is the Dockerfile's content: a new Dockerfile (a pin too) is a new tag, and only a tag that is not in the repository is built
  TAG="$(sha256sum "$ROOT/container/Dockerfile" | cut -c1-12)"
  IMAGE_URI="$(param /switchboard/offload-image-repo)"
  if ! aws ecr describe-images --repository-name "${IMAGE_URI#*/}" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
    ENVS_IMAGE="$(jq -cn --arg k "$KEY" --arg t "$TAG" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_IMAGE_TAG",value:$t,type:"PLAINTEXT"}]')"
    START_ARGS=(--environment-variables-override "$ENVS_IMAGE")
    run_build "$(param /switchboard/offload-image-project)" "no ci image $TAG yet; building it, started" "" "^sb-offload: image $TAG\$"
    [ "$STATUS" = SUCCEEDED ] || { echo "sb-offload: the ci image $TAG could not be built ($STATUS)" >&2; exit 1; }
  fi
  ENVS="$(jq -cn --arg k "$KEY" --arg c "$CMD" --arg t "$TAG" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_OFFLOAD_CMD",value:$c,type:"PLAINTEXT"},{name:"SB_IMAGE_TAG",value:$t,type:"PLAINTEXT"}]')"
  START_ARGS=(--compute-type-override "$COMPUTE" --image-override "$IMAGE_URI:$TAG" --environment-variables-override "$ENVS")
fi
run_build "$PROJECT" "sent the work tree ($FILES files, $((SIZE / 1024)) MB) and started" "($SIZE_NAME)"
CODE="$(grep -oE '^sb-offload: exit [0-9]+$' "$TMP/log" | tail -1 | grep -oE '[0-9]+$' || true)"
if [ -z "$CODE" ]; then
  case "$STATUS" in TIMED_OUT) CODE=124 ;; STOPPED) CODE=130 ;; *) CODE=1 ;; esac
  echo "sb-offload: $BUILD ended $STATUS without the command's exit code" >&2
fi
# 137 is a SIGKILL, on these machines almost always the kernel's OOM killer: point at the next size, not at large (#3245)
if [ "$CODE" = 137 ]; then
  case "$SIZE_NAME" in small) NEXT=medium ;; medium) NEXT=large ;; *) NEXT= ;; esac
  [ -z "$NEXT" ] || echo "sb-offload: exit 137 usually means out of memory on $SIZE_NAME; retry with --size $NEXT" >&2
fi
exit "$CODE"
