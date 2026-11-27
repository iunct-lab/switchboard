#!/usr/bin/env bash
# archive — daily: the history (the daemon's export) encrypted to the age key in Parameter Store, to s3://<Data>/archive/.
# Nothing is deleted here: the bucket's lifecycle expires archives after 30 days (aws/template.yaml).
# Then the events of tasks finished 30 days ago go to s3://<Data>/history/events/ for good, and only those that arrived
# are cut down in the database (docs/design/cloud-hosting.md). A failed upload exits 3 and is tried again next day.
# Runners' records beyond the newest budget (a tenth of the disk) go to s3://<Data>/history/runner/ and off the disk; a failed one exits 4.
set -euo pipefail
# shellcheck source=/dev/null
. "${SB_HOST_ENV:-/etc/switchboard-host.env}"   # SB_DATA_BUCKET, SB_REPO_DIR
# On the disk, not in /tmp (RAM on this host); a run killed before its trap (oom-kill) leaves it to the next run.
OUT="$HOME/.switchboard/archive-out"
# One line the daemon reads to show a failed or stopped archive: running <epoch> / ok <epoch> <key> / failed <epoch> <code>
# (code 3: the archive went up, but some task's events did not; code 4: the old runner records did not go up, none removed)
STATUS="$HOME/.switchboard/archive.status"
# One line a day: how full the root disk is and what fills it, one column per place of the budget in
# docs/design/host-disk.md ("ルートディスクの予算"). Written by the EXIT trap, after the runner records moved (on a day that
# got that far), so the transcripts column is what stays on the disk; a later run of the same day replaces the line (a rerun
# after a failed day moves the records then). A failure here never stops the archive.
disk_record() {
  local file="$HOME/.switchboard/disk-history.tsv" today df_line
  today="$(date -u +%F)"
  mb() { du -xsm "$@" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }'; }
  df_line="$(df -Pm / | awk 'NR==2 { print $3 "\t" $4 }')" && [ -n "$df_line" ] || return 1
  local used="${df_line%%$'\t'*}" os swap docker runner db snapshots sb transcripts cache repos other
  os="$(mb /usr /var /opt)"; swap="$(mb /swapfile)"; docker="$(mb "$HOME/.local/share/docker")"
  runner="$(mb "$HOME/.codex/packages" "$HOME/.local/share/claude" "$HOME/.local/share/uv" "$HOME/.bun" "$HOME/.cache/ms-playwright")"
  db="$(mb "$HOME"/.switchboard/switchboard.db*)"; snapshots="$(mb "$HOME/.switchboard/snapshots")"
  # the top-level db and snapshots only, subtracted (du --exclude would also drop a nested folder of the same name)
  sb=$(( $(mb "$HOME/.switchboard") - db - snapshots )); [ "$sb" -ge 0 ] || sb=0
  transcripts="$(mb "$HOME/.claude/projects" "$HOME/.codex/sessions")"
  cache=$(( $(mb "$HOME/.cache" "$HOME/.npm") - $(mb "$HOME/.cache/ms-playwright") )); [ "$cache" -ge 0 ] || cache=0   # the browsers are runner's
  local parent; parent="$(cd "$(dirname "${SB_REPO_DIR:-/}")" 2>/dev/null && pwd -P)" || parent=/
  repos=0; [ "$parent" -ef / ] || repos="$(mb "$parent")"   # never the whole root, whatever its spelling
  # the rest of what df counts: the filesystem's own area, the home's settings, what cannot be read
  other=$((used - os - swap - docker - runner - db - snapshots - sb - transcripts - cache - repos)); [ "$other" -ge 0 ] || other=0
  # columns, in the order of the budget's place rows where they were already written: date, used, free (df; the place
  # "free"), db, snapshots, switchboard, transcripts, cache, then os, swap, docker, runner, repos, other (added at the end)
  local line
  line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$today" "$used" "${df_line#*$'\t'}" \
    "$db" "$snapshots" "$sb" "$transcripts" "$cache" "$os" "$swap" "$docker" "$runner" "$repos" "$other")"
  if grep -aq "^$today" "$file" 2>/dev/null; then
    # a rerun of the same day: its line is the newer one. The other days are copied as text (-a) and counted before the
    # copy replaces the file, so nothing but today's line can be lost
    local keep all mine
    all="$(grep -ac '' "$file")" && mine="$(grep -ac "^$today" "$file")" || return 1
    { grep -av "^$today" "$file" || [ $? -eq 1 ]; printf '%s\n' "$line"; } > "$file.new" || return 1
    keep="$(grep -ac '' "$file.new")" && [ "$keep" -eq $((all - mine + 1)) ] && mv "$file.new" "$file" || { rm -f "$file.new"; return 1; }
  else
    printf '%s\n' "$line" >> "$file"
  fi
}
# The day's disk line last, after the temporary files are gone (they are not what fills the disk) and on a failed day too;
# a status line that cannot be written does not stop the cleanup or the line (disk_record is defined above, before any step can fail)
trap 'code=$?; [ $code -eq 0 ] || { echo "failed $(date +%s) $code" > "$STATUS"; } 2>/dev/null || true; rm -rf "$OUT" || true; disk_record || echo "archive: disk usage not recorded" >&2' EXIT
rm -rf "$OUT"; mkdir -p "$OUT"
echo "running $(date +%s)" > "$STATUS"
KEY="$(aws ssm get-parameter --name /switchboard/archive-age-pubkey --query Parameter.Value --output text)"
NAME="switchboard-$(date -u +%Y%m%dT%H%M%SZ).tar.zst.age"
# from the release sb-rescue runs, not the working tree agents edit; the checkout only before the first release
CODE="$HOME/.switchboard/releases/current"
[ -d "$CODE" ] || CODE="$SB_REPO_DIR"
bun "$CODE/packages/core/src/main.ts" export "$OUT/$NAME" --encrypt "$KEY"
aws s3 cp "$OUT/$NAME" "s3://$SB_DATA_BUCKET/archive/$NAME" --only-show-errors
# --- runner records (Claude's ~/.claude/projects, Codex's ~/.codex/sessions) beyond the newest budget (a tenth of the disk) ---
# One encrypted file per run to history/runner/ (no lifecycle), removed from the disk only once it is uploaded, each file
# listed in runner-archive.tsv (path, session id, key, date, mtime and size at the move: runner-sync restore leaves a file
# out when it has both). Kept: memory/ (not a record, and Claude reads it) and the
# files of a running / waiting / idle task (they can still be resumed). The database is only read.
# How much stays on the disk: the newest records up to a tenth of the root filesystem (a bigger EBS keeps more, and a
# faster-growing record does not need a new number); SB_RUNNER_KEEP_MB (in the host env) overrides it.
# Whatever the budget, a record older than RUNNER_MAX_AGE_DAYS moves too: Claude deletes records after 30 days
# (cleanupPeriodDays, cloud-hosting.md), so the copy in S3 has to exist before that, also on a big disk with few records.
RUNNER_MAX_AGE_DAYS=25
RUNNER_LIST="$HOME/.switchboard/runner-archive.tsv"
DB="$HOME/.switchboard/switchboard.db"
RUNNER_FAILED=0
# In a function called as `runner_archive || ...`: a failure here marks the run (exit 4) and never skips the events below.
runner_archive() {
  mkdir -p "$OUT/runner" && : > "$OUT/runner/keep-ids" || return 1
  # Without the database nothing says which sessions are running: nothing moves (a rebuilt host before the restore)
  [ -f "$DB" ] || { echo "archive: $DB not found; runner records stay" >&2; return 0; }
  # Also a task that is stopped but has a resume planned (resume_at: a usage-limit stop) keeps its context
  bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1], { readonly: true });
    for (const r of db.query("SELECT runner_session_id AS id FROM tasks WHERE (status IN (\u0027running\u0027,\u0027waiting\u0027,\u0027idle\u0027) OR resume_at IS NOT NULL) AND runner_session_id IS NOT NULL AND runner_session_id <> \u0027\u0027").all()) console.log(r.id);
  ' "$DB" > "$OUT/runner/keep-ids" || { echo "archive: could not read the running tasks; runner records stay" >&2; return 1; }
  local ROOTS=() d KEEP_MB="${SB_RUNNER_KEEP_MB:-}"
  if [ -z "$KEEP_MB" ]; then
    local DISK_MB; DISK_MB="$(df -Pm / 2>/dev/null | awk 'NR==2 {print $2}')"
    case "$DISK_MB" in ''|*[!0-9]*) ;; *) KEEP_MB=$((DISK_MB / 10));; esac
  fi
  case "$KEEP_MB" in ''|*[!0-9]*|0) echo "archive: no usable runner budget (SB_RUNNER_KEEP_MB / df); runner records stay" >&2; return 1;; esac
  for d in .claude/projects .codex/sessions; do [ -d "$HOME/$d" ] && ROOTS+=("$d"); done
  [ "${#ROOTS[@]}" -gt 0 ] || return 0
  # newest first, running up the sizes: what falls past the budget is what moves
  (cd "$HOME" && find "${ROOTS[@]}" -type f -not -path '*/memory/*' -printf '%T@ %s %p\n' | sort -rn \
    | awk -v b="$((KEEP_MB * 1048576))" -v old="$(( $(date +%s) - RUNNER_MAX_AGE_DAYS * 86400 ))" '{ s += $2; if (s > b || $1 < old) { sub(/^[^ ]+ [^ ]+ /, ""); print } }') > "$OUT/runner/all.txt" || return 1
  if [ -s "$OUT/runner/keep-ids" ]; then grep -vFf "$OUT/runner/keep-ids" "$OUT/runner/all.txt" > "$OUT/runner/old.txt" || true; else cp "$OUT/runner/all.txt" "$OUT/runner/old.txt"; fi
  [ -s "$OUT/runner/old.txt" ] || return 0
  local RNAME RKEY F B SID ERR
  RNAME="runner-$(date -u +%Y%m%dT%H%M%SZ).tar.zst.age"; RKEY="history/runner/$RNAME"
  # mtime and size at listing: a file that differs when it is removed was appended to after it was tarred, and stays
  while IFS= read -r F; do printf '%s\t%s\n' "$(stat -c '%Y %s' "$HOME/$F")" "$F"; done < "$OUT/runner/old.txt" > "$OUT/runner/stat.tsv" || return 1
  # history/ takes a new key only (the role allows PutObject with If-None-Match: *, aws/template.yaml)
  if ! { tar --zstd -cf - -C "$HOME" -T "$OUT/runner/old.txt" | age -r "$KEY" > "$OUT/runner/$RNAME"; } \
     || ! ERR="$(aws s3api put-object --bucket "$SB_DATA_BUCKET" --key "$RKEY" --body "$OUT/runner/$RNAME" --if-none-match '*' 2>&1 >/dev/null)"; then
    echo "archive: runner records not uploaded; none removed${ERR:+: $ERR}" >&2; return 1
  fi
  mkdir -p "$(dirname "$RUNNER_LIST")" || return 1
  # The list first (a failed write stops before anything is removed: set -e is off inside a function called in ||),
  # then each file is compared and removed one right after the other, so the window for an append is that one gap.
  # A row for a file that then stayed is harmless: the next day moves it again with a second row.
  while IFS=$'\t' read -r ST F; do
    B="$F"; SID="$(basename "$F")"; SID="${SID%.*}"
    [[ $B =~ ^.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ]] && SID="${BASH_REMATCH[1]}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$F" "$SID" "$RKEY" "$(date -u +%Y-%m-%d)" "${ST% *}" "${ST#* }" >> "$RUNNER_LIST" || return 1
  done < "$OUT/runner/stat.tsv"
  local N=0 RMFAIL=0
  while IFS=$'\t' read -r ST F; do
    [ "$(stat -c '%Y %s' "$HOME/$F" 2>/dev/null)" = "$ST" ] || continue
    if rm -f -- "$HOME/$F"; then N=$((N + 1)); else echo "archive: could not remove $F" >&2; RMFAIL=1; fi
  done < "$OUT/runner/stat.tsv"
  [ "$RMFAIL" -eq 0 ] || return 1
  echo "archive: $N runner records to s3://$SB_DATA_BUCKET/$RKEY"
}
runner_archive || RUNNER_FAILED=1
runner_done() { [ "$RUNNER_FAILED" -eq 0 ] || exit 4; }

# A release from before the events-archive command reads an unknown command as "start the daemon": not a second one on the same database
if ! grep -q '"events-archive"' "$CODE/packages/core/src/main.ts"; then
  runner_done
  echo "ok $(date +%s) archive/$NAME" > "$STATUS"; echo "archive: s3://$SB_DATA_BUCKET/archive/$NAME (no events-archive in $CODE)"; exit 0
fi
# history/ takes a new key only (If-None-Match: *); PreconditionFailed is a file an earlier run uploaded but did not commit
bun "$CODE/packages/core/src/main.ts" events-archive prepare "$OUT/events" --encrypt "$KEY"
YEAR="$(date -u +%Y)"; MISSED=0
while IFS=$'\t' read -r TASK FILE; do
  K="history/events/$YEAR/$FILE"
  if ERR="$(aws s3api put-object --bucket "$SB_DATA_BUCKET" --key "$K" --body "$OUT/events/$FILE" --if-none-match '*' 2>&1 >/dev/null)" || [[ $ERR == *PreconditionFailed* ]]; then
    printf '%s\t%s\n' "$TASK" "$K" >> "$OUT/events/uploaded.tsv"
  else
    echo "archive: $K not uploaded: $ERR" >&2; MISSED=$((MISSED + 1))
  fi
done < <(jq -r '.[] | "\(.taskId)\t\(.file)"' "$OUT/events/manifest.json")
bun "$CODE/packages/core/src/main.ts" events-archive commit "$OUT/events"
[ "$MISSED" -eq 0 ] || exit 3
runner_done
echo "ok $(date +%s) archive/$NAME" > "$STATUS"
echo "archive: s3://$SB_DATA_BUCKET/archive/$NAME"
