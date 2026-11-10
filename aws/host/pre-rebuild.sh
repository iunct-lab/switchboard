#!/usr/bin/env bash
# pre-rebuild (#2186) — what to keep before 作り直す, which replaces the root volume.
#   save              to s3://<data>/archive/pre-rebuild/<UTC time>/ : switchboard.sql.zst (a dump of the database; Litestream
#                     brings the database back, this copy is for when it does not), files.tar.zst (attachments, the
#                     recordings vault, Knowledge and artifacts: a point-in-time copy, sb-runner-sync brings them back
#                     on its own); then sb-runner-sync once; then
#                     worktrees.tar.zst: for each work tree with uncommitted changes or commits on no remote, a bundle
#                     of those commits, the diff against HEAD and the untracked files (none is pushed; they are listed)
#   restore [<time>]  unpacks files.tar.zst of that save (the newest without one) into HOME, keeping files already there
#   keep-work         the same work trees into ~/.switchboard/work-keep.tar, with the origin of each repository; sb-runner-sync
#                     runs this before it saves, so none of it waits for a manual save
#   restore-work      bootstrap, on a new disk: clones each repository whose folder is gone from the origin kept, and puts the
#                     work trees back. A folder already there is left alone (a main checkout's changes stay in a copy of the tar)
# The database and the files stream through aws s3 cp: nothing that size is written to the disk (near full) or /tmp
# (RAM here); the work trees' few files are put together under ~/.cache first.
# archive/ expires after 30 days (aws/template.yaml). Run as the host user, with the daemon running.
set -euo pipefail
set -a
# shellcheck source=/dev/null
. "${SB_HOST_ENV:-/etc/switchboard-host.env}"   # SB_DATA_BUCKET, SB_REPO_DIR, AWS_DEFAULT_REGION
set +a
PREFIX=archive/pre-rebuild
DB="$HOME/.switchboard/switchboard.db"
FILES=(.switchboard/attachments .switchboard/artifacts .switchboard/fixtures Knowledge)
KEEP="$HOME/.switchboard/work-keep.tar"

# What a rebuild loses for good: changes not committed, and commits no remote has. Listed, never pushed. Into <dir>/worktrees/<n>/,
# with <dir>/repos.tsv (path, origin) of the main checkouts. A second argument leaves out untracked files over that many bytes.
collect_worktrees() {
  local out="$1" max="${2:-}" repo wt dirty head ahead base o cached origin
  REPOS="$(dirname "$SB_REPO_DIR")"
  n=0
  : > "$out/repos.tsv"
  for repo in "$REPOS"/*/; do
    repo="${repo%/}"
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || continue
    # a linked work tree next to its repository is listed with it: only the main checkouts are walked
    [ "$(git -C "$repo" rev-parse --git-dir)" = "$(git -C "$repo" rev-parse --git-common-dir)" ] || continue
    # the host name and path only: a URL with a credential in it never leaves the disk
    origin="$(git -C "$repo" remote get-url origin 2>/dev/null | sed -E 's#^(https?://)[^/]*@#\1#' || true)"
    [ -z "$origin" ] || printf '%s\t%s\n' "$repo" "$origin" >> "$out/repos.tsv"
    while read -r wt; do
      [ -d "$wt" ] || continue
      dirty="$(git -C "$wt" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      # a repository with no commit yet has only its files to keep (no bundle, no diff)
      head="$(git -C "$wt" rev-parse -q --verify HEAD || true)"
      ahead=0
      [ -z "$head" ] || ahead="$(git -C "$wt" rev-list HEAD --not --remotes | wc -l | tr -d ' ')"
      # keep-work (max set) counts against the default branch too: a clean tree on a branch GitHub has dropped, with its local
      # tracking ref still here, has commits only this disk holds. A tree on a pushed branch is kept with it, at small cost
      if [ -n "$max" ] && [ -n "$head" ] && [ "$ahead" = 0 ]; then
        base="$(git -C "$wt" rev-parse -q --verify refs/remotes/origin/HEAD || git -C "$wt" rev-parse -q --verify refs/remotes/origin/main || true)"
        [ -z "$base" ] || ahead="$(git -C "$wt" rev-list HEAD --not "$base" | wc -l | tr -d ' ')"
      fi
      if [ "$dirty" != 0 ] || [ "$ahead" != 0 ]; then
        n=$((n + 1))
        o="$out/worktrees/$n"; mkdir -p "$o"
        { echo "path $wt"; echo "repo $repo"; echo "branch $(git -C "$wt" symbolic-ref -q --short HEAD || echo HEAD)"; echo "head ${head:-none}"; } > "$o/info"
        # bringing it back: restore-work below
        # against the default branch, not --remotes: a local tracking ref can hold a branch GitHub has dropped, which a new
        # clone will not have. One pack thread: with more, the same commits make different bytes and an upload each hour
        base="$(git -C "$wt" rev-parse -q --verify refs/remotes/origin/HEAD || git -C "$wt" rev-parse -q --verify refs/remotes/origin/main || true)"
        if [ -n "$head" ] && [ "$(git -C "$wt" rev-list HEAD ${base:+--not "$base"} | wc -l | tr -d ' ')" != 0 ]; then
          git -C "$wt" -c pack.threads=1 bundle create -q "$o/commits.bundle" HEAD ${base:+--not "$base"}
        fi
        [ -z "$head" ] || git -C "$wt" -c diff.autoRefreshIndex=false diff --binary HEAD > "$o/changes.patch" || { echo "unreadable (changes not kept)" >> "$o/info"; : > "$o/changes.patch"; }
        # a repository nested in the tree is listed as "dir/": left out (tar would take its ignored files, .env included)
        # with no commit, the staged files are in no diff: they go into the tar with the untracked ones
        cached=; [ -n "$head" ] || cached=--cached
        git -C "$wt" ls-files -z --others --exclude-standard $cached > "$o/others"
        { grep -z '/$' "$o/others" || true; } | tr '\0' '\n' | sed 's/^/nested (not kept) /' >> "$o/info"
        git -C "$wt" ls-files -s | awk '$1 == "160000" { print "nested (not kept) " $4 }' >> "$o/info"   # staged ones
        # --no-recursion: a listed directory (a nested or staged repository) is never walked into
        { grep -zv '/$' "$o/others" || true; } | while IFS= read -r -d '' f; do
          if [ -n "$max" ] && [ "$(stat -c %s "$wt/$f" 2>/dev/null || echo 0)" -gt "$max" ]; then echo "large (not kept) $f" >> "$o/info"; else printf '%s\0' "$f"; fi
        # a file a running Task removes, or one that cannot be read, costs that file and not every work tree's save
        done | tar -C "$wt" --no-recursion --null -T - -cf "$o/untracked.tar" 2>/dev/null || echo "unreadable (some untracked files not kept)" >> "$o/info"
        rm -f "$o/others"
        echo "pre-rebuild: not pushed: $wt ($dirty uncommitted, $ahead commits on no remote), kept as worktrees/$n"
      fi
    # every work tree but a bare repository's own entry (no work tree to lose; git diff would stop the save)
    done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{if(p!="")print p; p=substr($0,10)} /^bare$/{p=""} END{if(p!="")print p}')
  done
}

# One saved work tree back where it was. Returns non-zero on a failure; a folder that is already there is left alone.
restore_worktree() {
  local o="$1" wt repo branch head
  wt="$(sed -n 's/^path //p' "$o/info")"; repo="$(sed -n 's/^repo //p' "$o/info")"
  branch="$(sed -n 's/^branch //p' "$o/info")"; head="$(sed -n 's/^head //p' "$o/info")"
  if [ -e "$wt" ]; then echo "pre-rebuild: $wt is already there; left as it was"; left=$((left + 1)); return 0; fi
  # One with an origin that is not here was refused or failed to clone: an empty repository in its place would hide that
  if [ "$wt" = "$repo" ] && awk -F'\t' -v p="$repo" '$1 == p { found = 1 } END { exit !found }' "$WT/repos.tsv"; then return 1; fi
  if [ "$head" = none ]; then
    git init -q "$wt" && tar -xf "$o/untracked.tar" -C "$wt" && return 0
    return 1
  fi
  if [ "$wt" = "$repo" ]; then
    # a repository no remote has: all of it is in the bundle
    git init -q "$wt" && git -C "$wt" fetch -q "$o/commits.bundle" HEAD || return 1
    if [ "$branch" = HEAD ]; then git -C "$wt" checkout -q --detach "$head" || return 1
    else git -C "$wt" checkout -q -b "$branch" "$head" 2>/dev/null || git -C "$wt" checkout -q -B "$branch" "$head" || return 1
    fi
  else
    [ ! -f "$o/commits.bundle" ] || git -C "$repo" fetch -q "$o/commits.bundle" HEAD || return 1
    if [ "$branch" = HEAD ]; then git -C "$repo" worktree add -q --detach "$wt" "$head" || return 1
    else git -C "$repo" worktree add -q -b "$branch" "$wt" "$head" || git -C "$repo" worktree add -q --detach "$wt" "$head" || return 1
    fi
  fi
  # the patch first: a file removed from the index is in its diff and in the tar. A patch that fails still leaves the files
  local rc=0
  [ ! -s "$o/changes.patch" ] || git -C "$wt" apply --binary "$o/changes.patch" || rc=1
  tar -xf "$o/untracked.tar" -C "$wt" || rc=1
  return "$rc"
}

case "${1:-}" in
save)
  AT="$(date -u +%Y%m%dT%H%M%SZ)"
  DEST="s3://$SB_DATA_BUCKET/$PREFIX/$AT"
  if [ -f "$DB" ]; then
    # .dump reads in one transaction, so the copy is consistent while the daemon writes
    sqlite3 -readonly "$DB" .dump | zstd -q -c | aws s3 cp - "$DEST/switchboard.sql.zst" --only-show-errors
    echo "pre-rebuild: $DEST/switchboard.sql.zst"
  else
    echo "pre-rebuild: no database at $DB" >&2
  fi
  have=()
  for f in "${FILES[@]}"; do [ -e "$HOME/$f" ] && have+=("$f"); done
  if [ ${#have[@]} -gt 0 ]; then
    tar --zstd -C "$HOME" -cf - "${have[@]}" | aws s3 cp - "$DEST/files.tar.zst" --only-show-errors
    echo "pre-rebuild: $DEST/files.tar.zst (${have[*]})"
  else
    echo "pre-rebuild: none of ${FILES[*]} is here; no files.tar.zst"
  fi
  sb-runner-sync
  mkdir -p "$HOME/.cache"
  WT="$(mktemp -d "$HOME/.cache/sb-pre-rebuild.XXXXXX")"; trap 'rm -rf "$WT"' EXIT
  collect_worktrees "$WT"
  if [ "$n" != 0 ]; then
    tar --zstd -C "$WT" -cf - worktrees | aws s3 cp - "$DEST/worktrees.tar.zst" --only-show-errors
    echo "pre-rebuild: $DEST/worktrees.tar.zst"
  fi
  echo "pre-rebuild: saved $AT; $n work trees not pushed"
  ;;
restore)
  AT="${2:-}"
  if [ -z "$AT" ]; then
    KEYS="$(aws s3api list-objects-v2 --bucket "$SB_DATA_BUCKET" --prefix "$PREFIX/" --query 'Contents[].Key' --output text)"
    AT="$(printf '%s\n' "$KEYS" | tr '\t' '\n' | sed -nE "s#^$PREFIX/([0-9]{8}T[0-9]{6}Z)/files\.tar\.zst\$#\1#p" | sort | tail -n 1)"
    [ -n "$AT" ] || { echo "pre-rebuild: no files.tar.zst under s3://$SB_DATA_BUCKET/$PREFIX/" >&2; exit 1; }
  fi
  # --skip-old-files: what the new host already made (a fresh Knowledge) is kept
  aws s3 cp "s3://$SB_DATA_BUCKET/$PREFIX/$AT/files.tar.zst" - --only-show-errors | tar --zstd --skip-old-files -xf - -C "$HOME"
  echo "pre-rebuild: restored $AT into $HOME"
  ;;
keep-work)
  # One tar, not a folder: sb-runner-sync sends only what changed and restore lays that over its base, so a folder would
  # mix old files with new ones (and bring back work trees that are gone). Written only when it differs: no upload then.
  mkdir -p "$HOME/.cache" "$(dirname "$KEEP")"
  # one its time limit killed leaves its scratch (bash's EXIT trap does not run on TERM)
  find "$HOME/.cache" -maxdepth 1 -name 'sb-pre-rebuild.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  WT="$(mktemp -d "$HOME/.cache/sb-pre-rebuild.XXXXXX")"; trap 'rm -rf "$WT"' EXIT
  collect_worktrees "$WT" $((20 * 1024 * 1024)) > /dev/null
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$WT" -cf "$WT.tar" . ; mv "$WT.tar" "$WT/keep.tar"
  if [ -f "$KEEP" ] && cmp -s "$WT/keep.tar" "$KEEP"; then echo "pre-rebuild: work unchanged"; exit 0; fi
  mv "$WT/keep.tar" "$KEEP"
  echo "pre-rebuild: kept $n work trees in $KEEP"
  ;;
restore-work)
  [ -f "$KEEP" ] || { echo "pre-rebuild: no $KEEP; no work to bring back"; exit 0; }
  mkdir -p "$HOME/.cache"
  WT="$(mktemp -d "$HOME/.cache/sb-pre-rebuild.XXXXXX")"; trap 'rm -rf "$WT"' EXIT
  tar -xf "$KEEP" -C "$WT"
  cloned=0 restored=0 left=0 failed=0
  while IFS=$'\t' read -r path url; do
    [ ! -e "$path" ] || continue
    # bootstrap moved it aside: GitHub did not answer for it as the registered repository (#2799). Not cloned again here
    if compgen -G "$path.unverified-*" > /dev/null; then echo "pre-rebuild: $path was moved aside by bootstrap; not cloned"; left=$((left + 1)); continue; fi
    if git clone -q "$url" "$path"; then cloned=$((cloned + 1)); else echo "pre-rebuild: could not clone $path" >&2; failed=$((failed + 1)); fi
  done < "$WT/repos.tsv"
  # in numeric order: a repository's main checkout comes before its linked trees
  for o in $(find "$WT/worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V); do
    before=$left
    if restore_worktree "$o"; then [ "$left" != "$before" ] || restored=$((restored + 1))
    else echo "pre-rebuild: could not bring back $(sed -n 's/^path //p' "$o/info")" >&2; failed=$((failed + 1)); fi
  done
  # the next keep-work rewrites the tar from what is here, so what did not come back is copied out first
  if [ "$left" != 0 ] || [ "$failed" != 0 ]; then
    cp "$KEEP" "$KEEP.$(date -u +%Y%m%dT%H%M%SZ)"
    echo "pre-rebuild: what did not come back is in $KEEP.<time>"
  fi
  echo "pre-rebuild: cloned $cloned, restored $restored work trees, left $left, failed $failed"
  ;;
*)
  echo "usage: sb-pre-rebuild save | restore [<YYYYMMDDTHHMMSSZ>] | keep-work | restore-work" >&2
  exit 2
  ;;
esac
