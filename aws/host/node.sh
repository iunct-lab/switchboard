#!/usr/bin/env bash
# sb-node — the host's Node.js (npx for Playwright and the Playwright MCP) from nodejs.org, pinned by version and sha256.
# Run as root by devtools.sh (作り直す) and, in a unit of its own, by sb-host-update on every start: devtools skips what is
# there, so without this a Node security release reached a running host only with 作り直す. A different version in place
# is replaced; the same one is left alone. SB_NODE_DIR and SB_NODE_BIN are for the tests.
set -euo pipefail
# pinned from https://nodejs.org/dist/v<version>/SHASUMS256.txt (2026-10-24: the 2026-10-21 security release)
NODE_VERSION=24.22.1
NODE_SHA256=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e
DIR="${SB_NODE_DIR:-/usr/local/lib/nodejs}"
BIN="${SB_NODE_BIN:-/usr/local/bin}"
DL=""

# in a function so that replacing this file while it runs does not change what bash reads next
main() {
  # devtools (bootstrap) and sb-node-update (a start) may run at once
  exec 9>"$DIR.lock"
  flock 9
  # a stop between the two renames below left the previous one as .old: take it back
  [ -d "$DIR" ] || [ ! -d "$DIR.old" ] || mv "$DIR.old" "$DIR"
  if [ "$("$DIR/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    DL="$(mktemp -d)"
    trap 'rm -rf "$DL"' EXIT
    curl -fsSL -o "$DL/node.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"
    echo "$NODE_SHA256  $DL/node.tar.xz" | sha256sum -c --quiet -
    # unpacked into .new and renamed into place last: the directory exists only when complete
    rm -rf "$DIR.new" "$DIR.old" && mkdir -p "$DIR.new"
    tar --no-same-owner -xJf "$DL/node.tar.xz" -C "$DIR.new" --strip-components=1
    [ ! -d "$DIR" ] || mv "$DIR" "$DIR.old"
    mv "$DIR.new" "$DIR"
    rm -rf "$DIR.old"
    echo "sb-node: v$NODE_VERSION"
  fi
  # made on every run (a stop between the rename and the links would leave none)
  for b in node npm npx; do ln -sf "$DIR/bin/$b" "$BIN/$b"; done
}
# one line: bash has read all of it before sb-host-update replaces this file, and then reads nothing more of it
main "$@"; exit
