#!/usr/bin/env bash
# runner-sync (#401, #402, #1443) — the runners' own records to S3, so 作り直す brings them back: ~/.claude/projects
# (Claude's sessions, which --resume needs, and its memory) and ~/.codex/sessions. The DB comes back from Litestream;
# these would not. Same protection as the Litestream replica (the bucket's encryption, this stack's role): the user's
# decision on #401.
# Every key is written once, never over: the bucket keeps old versions of an overwritten key for 30 days, so a whole
# archive uploaded again on every run leaves one old version per run, many times its own size (#1443). A "set" is a base
# plus what changed after it:
#   s3://<data>/archive/runner/<set>/base.tar.zst   everything, every 7 days (<set> = the epoch second it was made)
#   s3://<data>/archive/runner/<set>/<epoch>.tar.zst the files whose ctime is newer than the last run's start
# `restore` (bootstrap, on a new disk) unpacks the newest set: newest copy of each file first, the base last.
# Run as the host user every hour (sb-runner-sync.timer), by sb-stop before it shuts down, and by the rescue page's
# 作り直す before it asks the Starter. A set older than 7 days is replaced, so archive/ (30 days) never lets the live
# one expire. To take a new base on purpose (HOME moved, aws/README.md): rm ~/.switchboard/runner-sync.state.
set -euo pipefail
set -a
# shellcheck source=/dev/null
. "${SB_HOST_ENV:-/etc/switchboard-host.env}"   # SB_DATA_BUCKET, AWS_DEFAULT_REGION
set +a
PREFIX=archive/runner
REFRESH=$((7 * 24 * 3600))

if [ "${1:-}" = restore ]; then
  # "not there" is exit 0 (a first machine); a failing aws is exit 1, so bootstrap stops instead of the next sync
  # putting a near-empty base over the good one
  KEYS="$(aws s3api list-objects-v2 --bucket "$SB_DATA_BUCKET" --prefix "$PREFIX/" --query 'Contents[].Key' --output text)" || { echo "runner-sync: could not list s3://$SB_DATA_BUCKET/$PREFIX/" >&2; exit 1; }
  KEYS="$(printf '%s\n' "$KEYS" | tr '\t' '\n')"
  SET="$(printf '%s\n' "$KEYS" | sed -nE "s#^$PREFIX/([0-9]{10})/base\.tar\.zst\$#\1#p" | sort | tail -n 1)"
  [ -n "$SET" ] || { echo "runner-sync: nothing saved yet"; exit 0; }
  mkdir -p "$HOME/.cache"
  RDIR="$(mktemp -d "$HOME/.cache/sb-runner-restore.XXXXXX")"; trap 'rm -rf "$RDIR"' EXIT   # not /tmp: RAM here
  # newest first, the base last, with --skip-old-files: each file is the newest copy, and one that is already here (the
  # one-time import from the Mac) is kept
  { printf '%s\n' "$KEYS" | grep -E "^$PREFIX/$SET/[0-9]{10}\.tar\.zst\$" | sort -r || true; echo "$PREFIX/$SET/base.tar.zst"; } > "$RDIR/keys"
  n=0
  while read -r key; do
    n=$((n + 1))
    aws s3 cp "s3://$SB_DATA_BUCKET/$key" "$RDIR/$n.tar.zst" --only-show-errors
    tar --zstd --skip-old-files -xf "$RDIR/$n.tar.zst" -C "$HOME"
    rm -f "$RDIR/$n.tar.zst"
  done < "$RDIR/keys"
  echo "runner-sync: brought back set $SET ($n archives) from s3://$SB_DATA_BUCKET/$PREFIX/"
  exit 0
fi

DIRS=()
for d in .claude/projects .codex/sessions; do [ -d "$HOME/$d" ] && DIRS+=("$d"); done
[ "${#DIRS[@]}" -gt 0 ] || { echo "runner-sync: nothing to save"; exit 0; }

mkdir -p "$HOME/.switchboard" "$HOME/.cache"
exec 9>"$HOME/.switchboard/runner-sync.lock"
flock -w 60 9 || { echo "runner-sync: another run has held the lock for 60 s" >&2; exit 1; }   # the timer, sb-stop and 作り直す may overlap: one at a time, and a stuck one does not hold the others
# a run that 作り直す's time limit killed leaves its scratch (bash's EXIT trap does not run on TERM): clear old ones
find "$HOME/.cache" -maxdepth 1 -name 'sb-runner-sync.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
STATE="$HOME/.switchboard/runner-sync.state"   # the current <set>
SINCE="$HOME/.switchboard/runner-sync.since"   # empty; its mtime is the start of the last run that uploaded
TMP="$(mktemp -d "$HOME/.cache/sb-runner-sync.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT   # not /tmp: it is RAM here
# keys are named by the second and written once: a run in the same second as the last upload (its NOW <= the marker's
# mtime, which was set right after it) waits, or it would write over that difference and lose it
NOW="$(date +%s)"
if [ -f "$SINCE" ] && [ "$NOW" -le "$(stat -c %Y "$SINCE")" ]; then sleep 1; NOW="$(date +%s)"; fi
touch "$TMP/since.new"   # before tar reads anything: a file written while it runs is newer than this and goes next time
SET=; [ -f "$STATE" ] && [ -f "$SINCE" ] && read -r SET < "$STATE" || true
[[ "$SET" =~ ^[0-9]{10}$ ]] || SET=   # no state, or an unreadable one (the old "<sha256> <epoch>" too): a new base
[ -z "$SET" ] || [ $((NOW - SET)) -lt "$REFRESH" ] || SET=
# an active session is appended to while tar reads it: GNU tar then exits 1 ("file changed as we read it") with a
# complete archive — at worst that file's last line is cut (the next run has it whole). Anything worse (2: a file or
# folder that cannot be read) stops here, so a partial snapshot is never recorded as done.
rc=0
if [ -z "$SET" ]; then
  SET="$NOW"; KEY="$PREFIX/$SET/base.tar.zst"
  tar --zstd --sort=name --warning=no-file-changed -cf "$TMP/runner.tar.zst" -C "$HOME" "${DIRS[@]}" || rc=$?
else
  KEY="$PREFIX/$SET/$NOW.tar.zst"
  (cd "$HOME" && find "${DIRS[@]}" -type f -cnewer "$SINCE" -print0) > "$TMP/files" || exit $?
  if [ ! -s "$TMP/files" ]; then mv "$TMP/since.new" "$SINCE"; echo "runner-sync: unchanged"; exit 0; fi
  tar --zstd --null --warning=no-file-changed -C "$HOME" -T "$TMP/files" -cf "$TMP/runner.tar.zst" || rc=$?
fi
[ "$rc" -le 1 ] || exit "$rc"
aws s3 cp "$TMP/runner.tar.zst" "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors
echo "$SET" > "$STATE"
mv "$TMP/since.new" "$SINCE"
echo "runner-sync: s3://$SB_DATA_BUCKET/$KEY (${DIRS[*]})"
