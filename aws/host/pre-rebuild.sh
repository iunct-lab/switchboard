#!/usr/bin/env bash
# pre-rebuild (#2186) — what to keep before 作り直す, which replaces the root volume (aws/README.md, the CVE section).
#   save              to s3://<data>/archive/pre-rebuild/<UTC time>/ : switchboard.sql.zst (a dump of the database; Litestream
#                     brings the database back, this copy is for when it does not), files.tar.zst (what nothing brings
#                     back: attachments, artifacts, the recordings vault, Knowledge); then sb-runner-sync once; then
#                     worktrees.tar.zst: for each work tree with uncommitted changes or commits on no remote, a bundle
#                     of those commits, the diff against HEAD and the untracked files (none is pushed; they are listed)
#   restore [<time>]  unpacks files.tar.zst of that save (the newest without one) into HOME, keeping files already there
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
  # what a rebuild loses for good: changes not committed, and commits no remote has. Listed, never pushed
  REPOS="$(dirname "$SB_REPO_DIR")"
  mkdir -p "$HOME/.cache"
  WT="$(mktemp -d "$HOME/.cache/sb-pre-rebuild.XXXXXX")"; trap 'rm -rf "$WT"' EXIT
  n=0
  for repo in "$REPOS"/*/; do
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || continue
    # a linked work tree next to its repository is listed with it: only the main checkouts are walked
    [ "$(git -C "$repo" rev-parse --git-dir)" = "$(git -C "$repo" rev-parse --git-common-dir)" ] || continue
    while read -r wt; do
      [ -d "$wt" ] || continue
      dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
      # a repository with no commit yet has only its files to keep (no bundle, no diff)
      head="$(git -C "$wt" rev-parse -q --verify HEAD || true)"
      ahead=0
      [ -z "$head" ] || ahead="$(git -C "$wt" rev-list HEAD --not --remotes | wc -l | tr -d ' ')"
      if [ "$dirty" != 0 ] || [ "$ahead" != 0 ]; then
        n=$((n + 1))
        o="$WT/worktrees/$n"; mkdir -p "$o"
        { echo "path $wt"; echo "branch $(git -C "$wt" symbolic-ref -q --short HEAD || echo HEAD)"; echo "head ${head:-none}"; } > "$o/info"
        # bringing it back: aws/README.md, the CVE section
        [ "$ahead" = 0 ] || git -C "$wt" bundle create -q "$o/commits.bundle" HEAD --not --remotes
        [ -z "$head" ] || git -C "$wt" diff --binary HEAD > "$o/changes.patch"
        # a repository nested in the tree is listed as "dir/": left out (tar would take its ignored files, .env included)
        # with no commit, the staged files are in no diff: they go into the tar with the untracked ones
        cached=; [ -n "$head" ] || cached=--cached
        git -C "$wt" ls-files -z --others --exclude-standard $cached > "$o/others"
        { grep -z '/$' "$o/others" || true; } | tr '\0' '\n' | sed 's/^/nested (not kept) /' >> "$o/info"
        git -C "$wt" ls-files -s | awk '$1 == "160000" { print "nested (not kept) " $4 }' >> "$o/info"   # staged ones
        # --no-recursion: a listed directory (a nested or staged repository) is never walked into
        { grep -zv '/$' "$o/others" || true; } | tar -C "$wt" --no-recursion --null -T - -cf "$o/untracked.tar"
        rm -f "$o/others"
        echo "pre-rebuild: not pushed: $wt ($dirty uncommitted, $ahead commits on no remote), kept as worktrees/$n"
      fi
    # every work tree but a bare repository's own entry (no work tree to lose; git diff would stop the save)
    done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{if(p!="")print p; p=substr($0,10)} /^bare$/{p=""} END{if(p!="")print p}')
  done
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
*)
  echo "usage: sb-pre-rebuild save | restore [<YYYYMMDDTHHMMSSZ>]" >&2
  exit 2
  ;;
esac
