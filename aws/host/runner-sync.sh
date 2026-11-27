#!/usr/bin/env bash
# runner-sync — what only this disk holds, to S3, so 作り直す brings it back with no hand
# on it: ~/.claude/projects (Claude's sessions, which --resume needs, and its memory), ~/.codex/sessions,
# ~/.switchboard/artifacts (the copies; their rows are in the DB), the attachments, the recordings, Knowledge and the
# user's own settings (SAVE below). The DB comes back from Litestream; these would not. Same protection as the Litestream replica (the bucket's encryption, this stack's role): the user's
# decision (2026-09-27): the host must restore these on its own after a rebuild, which an age key kept outside AWS
# would not allow.
# Every key is written once, never over: the bucket keeps old versions of an overwritten key for 30 days, so a whole
# archive uploaded again on every run leaves one old version per run, many times its own size. A "set" is a base
# plus what changed after it:
#   s3://<data>/archive/runner/<set>/base.tar.zst   everything, every 7 days (<set> = the epoch second it was made)
#   s3://<data>/archive/runner/<set>/<epoch>.tar.zst the files whose ctime is newer than the last run's start
# `restore` (bootstrap, on a new disk) unpacks the newest set: newest copy of each file first, the base last.
# Run as the host user every hour (sb-runner-sync.timer), by sb-stop before it shuts down, and by the rescue page's
# 作り直す before it asks the Starter. A set older than 7 days is replaced, so archive/ (30 days) never lets the live
# one expire. A change in the folders saved also takes a new base: a difference would miss the files already there.
# To take a new base on purpose (HOME moved, aws/README.md): rm ~/.switchboard/runner-sync.state.
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
  # What the daily archive moved to history/runner (archive.sh) is not brought back: it is in the base this set holds,
  # and on the disk it would be over the budget until the next daily run, which would then upload it a second time.
  # runner-archive.tsv is one of the saved files, so it is read first, out of the newest archive that has it (the tars
  # fetched on the way are kept for the unpacking below). A row with 6 columns (path, session id, key, date, mtime,
  # size) leaves out every copy of that path no newer than the one moved: the copy moved (same mtime and size) and the
  # older copies an earlier difference or the base holds, which would otherwise come back in its place. A copy appended
  # to after the move is newer and comes back. Only the paths the archive moves count (runner records, not memory/).
  # A row of 4 columns (from before mtime and size were listed) leaves nothing out. A list that cannot be read leaves
  # nothing out either.
  mkdir -p "$RDIR/list"; : > "$RDIR/moved"
  fetch() { [ -e "$RDIR/$1.tar.zst" ] || aws s3 cp "s3://$SB_DATA_BUCKET/$2" "$RDIR/$1.tar.zst" --only-show-errors; }
  n=0
  while read -r key; do
    n=$((n + 1))
    fetch "$n" "$key"
    tar --zstd -xf "$RDIR/$n.tar.zst" -C "$RDIR/list" .switchboard/runner-archive.tsv 2>/dev/null && break
  done < "$RDIR/keys"
  if [ -f "$RDIR/list/.switchboard/runner-archive.tsv" ]; then
    # one line per path: the newest move (a path moved, appended to and moved again has several rows)
    awk -F'\t' 'NF == 6 && $5 ~ /^[0-9]+$/ && $6 ~ /^[0-9]+$/ && $3 ~ /^history\/runner\// && ($1 ~ /^\.claude\/projects\// || $1 ~ /^\.codex\/sessions\//) && $1 !~ /\/memory\// {
        if (!($1 in t) || $5 + 0 > t[$1] + 0 || ($5 + 0 == t[$1] + 0 && $6 + 0 > z[$1] + 0)) { t[$1] = $5; z[$1] = $6 }
      } END { for (p in t) print p "\t" t[p] "\t" z[p] }' "$RDIR/list/.switchboard/runner-archive.tsv" > "$RDIR/moved" || : > "$RDIR/moved"
  fi
  # the paths in a tar whose copy is no newer than the one moved: an older mtime (epoch seconds, from the listing in
  # UTC), or the same second and no bigger
  leftout() {
    TZ=UTC tar --zstd --full-time --quoting-style=literal -tvf "$1" | awk -v moved="$RDIR/moved" '
      BEGIN { while ((getline l < moved) > 0) { split(l, f, "\t"); t[f[1]] = f[2] + 0; z[f[1]] = f[3] + 0 } }
      substr($0, 1, 1) == "-" && match($0, /^[^ ]+ +[^ ]+ +[0-9]+ +[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9] /) {
        size = $3; split($4, D, "-"); split($5, T, ":")
        y = D[1] + 0; mo = D[2] + 0; d = D[3] + 0; if (mo <= 2) y--
        era = int(y / 400); yoe = y - era * 400; doy = int((153 * ((mo + 9) % 12) + 2) / 5) + d - 1
        days = era * 146097 + yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy - 719468
        path = substr($0, RLENGTH + 1)
        mt = days * 86400 + T[1] * 3600 + T[2] * 60 + T[3]
        if ((path in t) && (mt < t[path] || (mt == t[path] && size + 0 <= z[path]))) print path
      }'
  }
  : > "$RDIR/left"
  n=0
  while read -r key; do
    n=$((n + 1))
    fetch "$n" "$key"
    if [ -s "$RDIR/moved" ] && leftout "$RDIR/$n.tar.zst" > "$RDIR/skip"; then :; else : > "$RDIR/skip"; fi
    cat "$RDIR/skip" >> "$RDIR/left"
    tar --zstd --skip-old-files -xf "$RDIR/$n.tar.zst" -C "$HOME" --no-wildcards --anchored --exclude-from="$RDIR/skip"
    rm -f "$RDIR/$n.tar.zst"
  done < "$RDIR/keys"
  echo "runner-sync: left out $(sort -u "$RDIR/left" | wc -l) records already in history/runner"
  # devtools has already written ~/.claude.json (claude mcp add): what was saved of it goes under that file
  CLAUDE_STATE="$HOME/.switchboard/claude-state.json"
  if [ -f "$CLAUDE_STATE" ]; then
    if [ -f "$HOME/.claude.json" ]; then
      if jq -s '.[0] * .[1]' "$CLAUDE_STATE" "$HOME/.claude.json" > "$RDIR/claude.json"; then cat "$RDIR/claude.json" > "$HOME/.claude.json"
      else echo "runner-sync: could not read the saved first-run state; kept the new ~/.claude.json" >&2
      fi
    else cp "$CLAUDE_STATE" "$HOME/.claude.json"
    fi
  fi
  echo "runner-sync: brought back set $SET ($n archives) from s3://$SB_DATA_BUCKET/$PREFIX/"
  exit 0
fi

# Everything here that only this disk holds and nothing can make again; docs/design/cloud-hosting.md, 6.4, sorts HOME in
# a table, and host.test.ts holds the two together. Logins are not in it: they come from Parameter Store.
SAVE=(.claude/projects .codex/sessions .switchboard/artifacts
  .switchboard/attachments .switchboard/fixtures Knowledge
  .claude/CLAUDE.md .claude/agents .claude/commands .codex/AGENTS.md .codex/config.toml .aws/config .switchboard/claude-state.json
  .switchboard/routing.yaml .switchboard/pricing.json .switchboard/mcp.yaml .switchboard/evals
  .switchboard/runner-archive.tsv .switchboard/disk-history.tsv .switchboard/releases/history.jsonl
  .switchboard/work-keep.tar)
# Of ~/.claude.json only the first-run setup and the folders' trust: the rest is an account, a cache, or, on some hosts, a key.
# Rewritten only when it differs, or every hour would upload it
if [ -f "$HOME/.claude.json" ]; then
  mkdir -p "$HOME/.switchboard" "$HOME/.cache"
  STATE_NEW="$(mktemp "$HOME/.cache/sb-runner-sync.state.XXXXXX")"
  if jq -S '{hasCompletedOnboarding, projects: ((.projects // {}) | map_values({hasTrustDialogAccepted, hasCompletedProjectOnboarding} | with_entries(select(.value != null))))} | with_entries(select(.value != null and .value != {}))' "$HOME/.claude.json" > "$STATE_NEW" 2>/dev/null \
    && ! cmp -s "$STATE_NEW" "$HOME/.switchboard/claude-state.json"; then mv "$STATE_NEW" "$HOME/.switchboard/claude-state.json"
  else rm -f "$STATE_NEW"
  fi
fi
# Work not pushed goes up with the rest. The rescue page gives this whole run 10 s, and it sets SWITCHBOARD_REBUILD_SAVE_CMD:
# there a slow pass gives way to the last one kept. A failure here costs that hour's work trees, not the rest of the run
LIMIT=120; [ -z "${SWITCHBOARD_REBUILD_SAVE_CMD:-}" ] || LIMIT=4
timeout -k 1 "$LIMIT" "${SB_PRE_REBUILD:-/usr/local/bin/sb-pre-rebuild}" keep-work > /dev/null || echo "runner-sync: the work trees were not kept this time (exit $?)" >&2
DIRS=()
for d in "${SAVE[@]}"; do [ -e "$HOME/$d" ] && DIRS+=("$d"); done
[ "${#DIRS[@]}" -gt 0 ] || { echo "runner-sync: nothing to save"; exit 0; }

mkdir -p "$HOME/.switchboard" "$HOME/.cache"
exec 9>"$HOME/.switchboard/runner-sync.lock"
flock -w 60 9 || { echo "runner-sync: another run has held the lock for 60 s" >&2; exit 1; }   # the timer, sb-stop and 作り直す may overlap: one at a time, and a stuck one does not hold the others
# a run that 作り直す's time limit killed leaves its scratch (bash's EXIT trap does not run on TERM): clear old ones
find "$HOME/.cache" -maxdepth 1 -name 'sb-runner-sync.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
STATE="$HOME/.switchboard/runner-sync.state"   # the current <set>
SINCE="$HOME/.switchboard/runner-sync.since"   # its mtime is the start of the last run that uploaded; its text is the second that run named its key by
SAVED="$HOME/.switchboard/runner-sync.dirs"    # the folders the current set holds (apart from STATE: an sb-runner-sync not yet replaced reads that one)
TMP="$(mktemp -d "$HOME/.cache/sb-runner-sync.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT   # not /tmp: it is RAM here
# keys are named by the second and written once: a run in the same second as the last upload waits, or it would write
# over that difference and lose it. The second is the one the last run named its key by (date), kept as the marker's
# text: its mtime comes from the kernel's coarse clock, which can lag date by some ms, so a run started just after a
# second boundary got an mtime in the second before its key's, and the next run did not wait
NOW="$(date +%s)"
LAST=; [ -f "$SINCE" ] && read -r LAST < "$SINCE" || true
[ ! -f "$SINCE" ] || [[ "$LAST" =~ ^[0-9]{10}$ ]] || LAST="$NOW"   # a marker without a second (the empty one an older run left): its second is not known, so wait
if [ -n "$LAST" ] && [ "$NOW" -le "$LAST" ]; then sleep 1; NOW="$(date +%s)"; fi
echo "$NOW" > "$TMP/since.new"   # before tar reads anything: a file written while it runs is newer than this and goes next time
SET=; [ -f "$STATE" ] && [ -f "$SINCE" ] && read -r SET < "$STATE" || true
[[ "$SET" =~ ^[0-9]{10}$ ]] || SET=   # no state, or an unreadable one (the old "<sha256> <epoch>" too): a new base
[ -z "$SET" ] || [ $((NOW - SET)) -lt "$REFRESH" ] || SET=
HELD=; [ -f "$SAVED" ] && read -r HELD < "$SAVED" || true
[ "$HELD" = "${DIRS[*]}" ] || SET=
# an active session is appended to while tar reads it: GNU tar then exits 1 ("file changed as we read it") with a
# complete archive — at worst that file's last line is cut (the next run has it whole). Anything worse (2: a file or
# folder that cannot be read) stops here, so a partial snapshot is never recorded as done.
rc=0
if [ -z "$SET" ]; then
  SET="$NOW"; KEY="$PREFIX/$SET/base.tar.zst"
  tar --zstd --sort=name --warning=no-file-changed -cf "$TMP/runner.tar.zst" -C "$HOME" "${DIRS[@]}" || rc=$?
else
  KEY="$PREFIX/$SET/$NOW.tar.zst"
  (cd "$HOME" && find "${DIRS[@]}" \( -type f -o -type l \) -cnewer "$SINCE" -print0) > "$TMP/files" || exit $?
  if [ ! -s "$TMP/files" ]; then mv "$TMP/since.new" "$SINCE"; echo "runner-sync: unchanged"; exit 0; fi
  tar --zstd --null --warning=no-file-changed -C "$HOME" -T "$TMP/files" -cf "$TMP/runner.tar.zst" || rc=$?
fi
[ "$rc" -le 1 ] || exit "$rc"
aws s3 cp "$TMP/runner.tar.zst" "s3://$SB_DATA_BUCKET/$KEY" --only-show-errors
echo "$SET" > "$STATE"
echo "${DIRS[*]}" > "$SAVED"
mv "$TMP/since.new" "$SINCE"
echo "runner-sync: s3://$SB_DATA_BUCKET/$KEY (${DIRS[*]})"
