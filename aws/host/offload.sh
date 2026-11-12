#!/usr/bin/env bash
# sb-offload [--size small|medium|large] [--ci] <command…> (#678) — runs a docker build, a compose stack or its tests off the host, in one build of the
# stack's offload CodeBuild project (aws/template.yaml, Offload): a fresh arm machine with docker that goes away when the
# build ends. The host has 4 GiB and its dockerd is capped at 1.5 GiB (sb-dockerd.service), which such checks exceed.
# Sends the git work tree it is run in (tracked files, a submodule's included, and untracked ones, uncommitted changes
# included; ignored files and an untracked clone's contents not) to
# s3://<data>/offload/, runs the arguments there as one shell command, streams the build's log here and exits with the
# command's exit code — the last `sb-offload: exit N` line of the log — or 124 when the build timed out, 130 when it
# was stopped, 1 when it failed before the command returned (the upload could not be unpacked). Ctrl-C (or TERM) stops the build. The upload is removed however it ends; offload/ also expires after a day (both but for
# --detach and --collect, below).
# The machine's size is chosen per call (#2304): small (2 vCPU / 4 GiB) unless --size says medium (4 / 8) or large
# (8 / 16, which a compose stack's checks can need), passed as --compute-type-override on every call, so the project's
# own LARGE never applies. The size is on the `started` line (after the wait line when both builds are busy).
# --ci (#4707) runs the command in the ci image instead (the offload CI project): the image's tag is the first 12 hex digits of the
# sha256 of container/Dockerfile, so a changed Dockerfile or pin is a new tag; if the image repository has no such tag the image project
# builds it first (its log is read the same way), and the build then starts with that tag as its image. The log has `sb-offload: image <tag>`.
# --fixtures <dir> and --names <file> (#4711, only with --ci) put two more one-time objects next to the work tree, offload/<key>.fixtures.tar.gz (the
# directory's content, the recordings the tests read) and offload/<key>.names.json (the host's AWS names and account ids for the public-tree check):
# the build reads them with the s3:GetObject it already has and gets SB_OFFLOAD_FIXTURES=1 / SB_OFFLOAD_NAMES=1. The names file is passed by path
# only: its content is in no argument, no environment variable and no log. Both are removed with the work tree.
# --detach (#4712) returns once the build has started: `sb-offload: started <build-id>` on the output, exit 0, nothing stopped and no upload removed (the
# build reads them later; offload/ expires after a day). --collect <build-id> waits for such a build, prints its log and exits as a call without
# --detach would (the exit line, 124, 130, the 137 hint for the size the build ran on); it takes no --size, sends nothing, needs no git work tree, and Ctrl-C (or TERM) ends only the wait.
# Explicit only: `docker` itself stays on the host (bind mounts and localhost ports are there). Only the work tree goes:
# no credentials, no token, no other host file. What the command starts is not reachable from here — only the log is.
set -euo pipefail
USAGE="usage: sb-offload [--size small|medium|large] [--ci [--fixtures <dir>] [--names <file>]] [--detach] <command…> | sb-offload --collect <build-id>   e.g. sb-offload docker compose up --build --abort-on-container-exit (small; --size medium or large only when small runs out of memory)"
SIZE_NAME=small; SIZE_GIVEN=
CI=; FIXTURES=; NAMES=; DETACH=; COLLECT=
# --size, --ci, --fixtures, --names, --detach and --collect in any order, before the command
while :; do
  case "${1:-}" in
    --size) SIZE_GIVEN=1; SIZE_NAME="${2:-}"; shift $(($# < 2 ? $# : 2)) ;;
    --size=*) SIZE_GIVEN=1; SIZE_NAME="${1#--size=}"; shift ;;
    --ci) CI=1; shift ;;
    --fixtures) FIXTURES="${2:-}"; [ -n "$FIXTURES" ] || { echo "sb-offload: --fixtures needs a directory" >&2; exit 2; }; shift 2 ;;
    --names) NAMES="${2:-}"; [ -n "$NAMES" ] || { echo "sb-offload: --names needs a file" >&2; exit 2; }; shift 2 ;;
    --detach) DETACH=1; shift ;;
    --collect) COLLECT="${2:-}"; [ -n "$COLLECT" ] || { echo "sb-offload: --collect needs a build id" >&2; exit 2; }; shift 2 ;;
    *) break ;;
  esac
done
# the list's largest is the project's own size, so a build through here costs no more than it did (#2304)
case "$SIZE_NAME" in
  small) COMPUTE=BUILD_GENERAL1_SMALL ;; medium) COMPUTE=BUILD_GENERAL1_MEDIUM ;; large) COMPUTE=BUILD_GENERAL1_LARGE ;;
  *) echo "sb-offload: --size is small, medium or large (default small), not '$SIZE_NAME'" >&2; exit 2 ;;
esac
if [ -n "$COLLECT" ]; then
  { [ $# -eq 0 ] && [ -z "$DETACH$CI$FIXTURES$NAMES$SIZE_GIVEN" ]; } || { echo "sb-offload: --collect takes a build id only (the size is the build's own)" >&2; exit 2; }
else
  [ $# -gt 0 ] || { echo "$USAGE" >&2; exit 2; }
fi
{ [ -z "$FIXTURES$NAMES" ] || [ -n "$CI" ]; } || { echo "sb-offload: --fixtures and --names go with --ci" >&2; exit 2; }
[ -z "$FIXTURES" ] || [ -d "$FIXTURES" ] || { echo "sb-offload: --fixtures: $FIXTURES is not a directory" >&2; exit 2; }
[ -z "$NAMES" ] || [ -f "$NAMES" ] || { echo "sb-offload: --names: $NAMES is not a file" >&2; exit 2; }
ENV_FILE="${SB_HOST_ENV:-/etc/switchboard-host.env}"
[ -f "$ENV_FILE" ] || { echo "sb-offload: no $ENV_FILE — this is not the cloud host; run docker here instead" >&2; exit 2; }
# shellcheck source=/dev/null
. "$ENV_FILE"   # SB_DATA_BUCKET
CMD="$*"
ROOT=
[ -n "$COLLECT" ] || ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "sb-offload: not in a git work tree (it sends the work tree it is run in)" >&2; exit 2; }

mkdir -p "$HOME/.cache"
TMP="$(mktemp -d "$HOME/.cache/sb-offload.XXXXXX")"   # not /tmp: it is RAM here
KEY="offload/$(date -u +%Y%m%dT%H%M%SZ)-${TMP##*.}.tar.gz"
KEY_BASE="${KEY%.tar.gz}"
UPLOADED=; BUILD=; ENDED=; UP_FIXTURES=; UP_NAMES=
cleanup() {
  # however this ends before the build does (Ctrl-C, a poll that keeps failing), the build is not left running
  # --collect only waits for a build that is not its own: Ctrl-C ends the wait, not the build
  if [ -n "$BUILD" ] && [ -z "$ENDED" ] && [ -z "$COLLECT" ]; then
    aws codebuild stop-build --id "$BUILD" >/dev/null 2>&1 || echo "sb-offload: could not stop $BUILD; it ends at the project's time limit" >&2
    echo "sb-offload: stopped $BUILD" >&2
  fi
  rm -rf "$TMP"
  [ -z "$UPLOADED" ] || aws s3 rm "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors >/dev/null 2>&1 || true
  [ -z "$UP_FIXTURES" ] || aws s3 rm "s3://$SB_DATA_BUCKET/$KEY_BASE.fixtures.tar.gz" --only-show-errors >/dev/null 2>&1 || true
  [ -z "$UP_NAMES" ] || aws s3 rm "s3://$SB_DATA_BUCKET/$KEY_BASE.names.json" --only-show-errors >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'trap - INT TERM; exit 130' INT TERM

if [ -z "$COLLECT" ]; then
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
  if [ -n "$FIXTURES" ]; then
    tar -czf "$TMP/fixtures.tar.gz" -C "$FIXTURES" .
    UP_FIXTURES=1   # set before the upload: a half-done upload is removed too
    aws s3 cp "$TMP/fixtures.tar.gz" "s3://$SB_DATA_BUCKET/$KEY_BASE.fixtures.tar.gz" --only-show-errors
  fi
  if [ -n "$NAMES" ]; then
    UP_NAMES=1
    aws s3 cp "$NAMES" "s3://$SB_DATA_BUCKET/$KEY_BASE.names.json" --only-show-errors
  fi
  ENVS="$(jq -cn --arg k "$KEY" --arg c "$CMD" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_OFFLOAD_CMD",value:$c,type:"PLAINTEXT"}]')"
fi
# Starts a build of project $1 with the start-build arguments in START_ARGS and says $2 (and $3 after the build's id)
start_build() {
BUILD=; ENDED=
# the project runs 2 builds at a time and refuses a third (it does not queue it): wait for a slot, up to 15 minutes
for i in $(seq 180); do
  BUILD="$(aws codebuild start-build --project-name "$1" "${START_ARGS[@]}" --query build.id --output text 2>"$TMP/start.err")" && break
  grep -qE 'AccountLimitExceeded|active builds' "$TMP/start.err" || { cat "$TMP/start.err" >&2; exit 1; }
  [ "$i" -lt 180 ] || { echo "sb-offload: no free build in 15 minutes (2 run at a time)" >&2; exit 1; }
  [ "$i" -gt 1 ] || echo "sb-offload: 2 builds are running; waiting for one to end" >&2
  sleep 5 & wait $!
done
echo "sb-offload: $2 $BUILD${3:+ $3}" >&2
}

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
# Follows build $BUILD to its end: the log goes to the output and $TMP/log, STATUS is how it ended. $1 is the regex of the log's
# last line that matters (default the command's exit); when the build succeeded it is waited for. Used for the image build (--ci),
# the command's build and --collect's build
follow_build() {
TOKEN=; GROUP=; STREAM=
DONE_RE="${1:-^sb-offload: exit [0-9]+\$}"
: >"$TMP/log"
STATUS=IN_PROGRESS
FAILS=0
while :; do
  # a blip (throttling, the network) is tried again; three in a row and the build is stopped (cleanup; not for --collect, which only stops waiting)
  if ! read -r STATUS GROUP STREAM CTYPE < <(aws codebuild batch-get-builds --ids "$BUILD" --query 'builds[0].[buildStatus,logs.groupName,logs.streamName,environment.computeType]' --output text); then
    FAILS=$((FAILS + 1))
    [ "$FAILS" -lt 3 ] || { echo "sb-offload: could not read the state of $BUILD" >&2; exit 1; }
    sleep 5 & wait $!
    continue
  fi
  FAILS=0
  # no build of that id (a mistyped --collect): not the command's failure
  [ "$STATUS" != None ] || { ENDED=1; echo "sb-offload: no build $BUILD" >&2; exit 2; }
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
# the image build and the command's build, one after the other (the image one is waited for: the command's starts from it)
run_build() { start_build "$1" "$2" "${3:-}"; follow_build "${4:-}"; }
# the command's exit code from the log's last `sb-offload: exit N` line, or from how the build ended; 137 gets the size hint
finish() {
  local code next
  code="$(grep -oE '^sb-offload: exit [0-9]+$' "$TMP/log" | tail -1 | grep -oE '[0-9]+$' || true)"
  if [ -z "$code" ]; then
    case "$STATUS" in TIMED_OUT) code=124 ;; STOPPED) code=130 ;; *) code=1 ;; esac
    echo "sb-offload: $BUILD ended $STATUS without the command's exit code" >&2
  fi
  # 137 is a SIGKILL, on these machines almost always the kernel's OOM killer: point at the next size, not at large (#3245)
  # the size the build ran on (--collect is not told it)
  case "${CTYPE:-}" in BUILD_GENERAL1_SMALL) SIZE_NAME=small ;; BUILD_GENERAL1_MEDIUM) SIZE_NAME=medium ;; BUILD_GENERAL1_LARGE) SIZE_NAME=large ;; esac
  if [ "$code" = 137 ]; then
    case "$SIZE_NAME" in small) next=medium ;; medium) next=large ;; *) next= ;; esac
    [ -z "$next" ] || echo "sb-offload: exit 137 usually means out of memory on $SIZE_NAME; retry with --size $next" >&2
  fi
  exit "$code"
}
if [ -n "$COLLECT" ]; then
  BUILD="$COLLECT"
  follow_build
  finish
fi
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
  ENVS="$(jq -cn --arg k "$KEY" --arg c "$CMD" --arg t "$TAG" --arg f "$UP_FIXTURES" --arg n "$UP_NAMES" '[{name:"SB_OFFLOAD_KEY",value:$k,type:"PLAINTEXT"},{name:"SB_OFFLOAD_CMD",value:$c,type:"PLAINTEXT"},{name:"SB_IMAGE_TAG",value:$t,type:"PLAINTEXT"}]
    + (if $f != "" then [{name:"SB_OFFLOAD_FIXTURES",value:"1",type:"PLAINTEXT"}] else [] end)
    + (if $n != "" then [{name:"SB_OFFLOAD_NAMES",value:"1",type:"PLAINTEXT"}] else [] end)')"
  START_ARGS=(--compute-type-override "$COMPUTE" --image-override "$IMAGE_URI:$TAG" --environment-variables-override "$ENVS")
fi
start_build "$PROJECT" "sent the work tree ($FILES files, $((SIZE / 1024)) MB) and started" "($SIZE_NAME)"
if [ -n "$DETACH" ]; then
  # the build reads the uploads after this returns: nothing is stopped or removed, offload/ expires after a day
  ENDED=1; UPLOADED=; UP_FIXTURES=; UP_NAMES=
  echo "sb-offload: started $BUILD"
  exit 0
fi
follow_build
finish
