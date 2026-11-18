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
# The daemon's screen is published on the machine's 127.0.0.1 only (compose.yaml) and reaches the daemon over loopback:
# the daemon listens on 127.0.0.1:47832 behind a relay on 0.0.0.0:47831.
# sb-rescue listens on the container's 127.0.0.1:47841 and nothing relays to it: it lets every loopback connection
# promote, roll back and restart, and a relay on the container's address would hand that to any peer on the docker
# bridge. Its port is not published either; the daemon reaches it inside the container, and a person does with
# `docker compose exec` (docs/design/local-container.md, "What can reach the screen and the API").
# SWITCHBOARD_RESCUE_IN_CONTAINER=1 tells the daemon so (sb-rescue hands its environment on): the screen then shows those
# commands instead of a link to an address the machine's browser cannot open.
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

bun "$SRC/container/relay.ts" 47831 47832 &
SWITCHBOARD_PORT=47832 SWITCHBOARD_RESCUE_PORT=47841 SWITCHBOARD_RESCUE_IN_CONTAINER=1 SWITCHBOARD_REPOS_DIR="$HOME/repos" exec bun "$HOME/.switchboard/rescue/sb-rescue.js"
