#!/usr/bin/env bash
# The stand-alone mode's start: sb-rescue runs the daemon from a release kept in the sb-home volume
# (~/.switchboard/releases), as on the EC2 host, so the version survives a recreated container and is updated and
# rolled back the same way. The code in the image (/opt/switchboard) only bundles sb-rescue and, for a use-only
# start, names where releases come from; the daemon never runs from it.
# The role is sb-rescue's own choice (rescue/src/main.ts), not a setting of the container:
#   - SWITCHBOARD_REPO_ROOT set (container/up.sh passes it through): a clone in the sb-repos volume; releases are built
#     from its tags, with no check of the diff (the developer's own origin)
#   - not set: the public repository named in ops.config.json (publicSync.target); the first start downloads its
#     newest Release and later ones go through the check of their diff
# The container runs on the machine's network (network_mode: host in compose.yaml), so the daemon (47831) and
# sb-rescue (47841) listen on the machine's 127.0.0.1 only, as on the EC2 host: a loopback connection is trusted
# there, and nothing on a docker bridge can reach either port. No relay, no listen address is set.
# 「GitHub から追加」clones into ~/repos (the repositories' volume), not next to the code in /opt.
set -eu
SRC=/opt/switchboard

if [ -n "${SWITCHBOARD_REPO_ROOT:-}" ]; then
  if [ ! -e "$SWITCHBOARD_REPO_ROOT/.git" ]; then
    echo "entrypoint: SWITCHBOARD_REPO_ROOT=$SWITCHBOARD_REPO_ROOT is not a clone. Put the clone in the sb-repos volume first (docs/design/local-container.md, \"Start\")." >&2
    exit 1
  fi
  bun "$SRC/rescue/install.ts"
else
  # compose passes the variable empty when the machine has none: sb-rescue must not see it at all
  unset SWITCHBOARD_REPO_ROOT
  SOURCE=$(jq -r '.publicSync.target // empty' "$SRC/ops.config.json")
  if [ -z "$SOURCE" ]; then
    echo "entrypoint: $SRC/ops.config.json names no publicSync.target, so there is no repository to take releases from." >&2
    exit 1
  fi
  # the first start downloads and builds the newest Release; a later one leaves what runs and only bundles sb-rescue again
  if ! bun "$SRC/rescue/install.ts" --source "$SOURCE"; then
    echo "entrypoint: no release to run. The first one is downloaded from GitHub ($SOURCE): once GitHub can be reached, the container's restart policy tries again." >&2
    exit 1
  fi
fi

SWITCHBOARD_PORT=47831 SWITCHBOARD_RESCUE_PORT=47841 SWITCHBOARD_REPOS_DIR="$HOME/repos" exec bun "$HOME/.switchboard/rescue/sb-rescue.js"
