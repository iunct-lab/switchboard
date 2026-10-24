#!/usr/bin/env bash
# Apply an optional JSON settings patch; leave unselected keys and an unconfigured host alone.
set -euo pipefail
FILE="${1:?usage: claude-settings.sh <settings.json> [patch.json]}"
PATCH="${2:-}"
[ -n "$PATCH" ] || exit 0
jq -e 'type == "object"' "$PATCH" >/dev/null
mkdir -p "$(dirname "$FILE")"
[ -s "$FILE" ] || echo '{}' > "$FILE"
jq -s '.[0] * .[1]' "$FILE" "$PATCH" > "$FILE.new"
mv "$FILE.new" "$FILE"
