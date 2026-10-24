#!/usr/bin/env bash
# claude-wrapper.sh — the environment layer's `claude` on a cloud machine (#180, docs/design/cloud-hosting.md §4).
#
# Installed ahead of the real `claude` on PATH (e.g. as /usr/local/bin/claude). Each start reads the long-lived token
# made with `claude setup-token` from Parameter Store (SecureString, read with the instance role) and execs the real
# `claude` with it in CLAUDE_CODE_OAUTH_TOKEN. The token lives only in that process's environment: Switchboard starts
# `claude` from PATH as always and never sees it. Nothing is written to disk.
#
#   SWITCHBOARD_CLAUDE_TOKEN_PARAM  the parameter's name, e.g. /switchboard/claude-oauth-token (required)
#
# The real `claude` is the next one on PATH after this script's own directory.
set -euo pipefail

PARAM="${SWITCHBOARD_CLAUDE_TOKEN_PARAM:?set SWITCHBOARD_CLAUDE_TOKEN_PARAM to the Parameter Store name of the claude setup-token}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAL=""
IFS=: read -r -a DIRS <<<"$PATH"
for d in "${DIRS[@]}"; do
  [[ -n "$d" && -d "$d" ]] || continue
  [[ "$(cd "$d" && pwd -P)" == "$SELF_DIR" ]] && continue
  if [[ -x "$d/claude" && ! -d "$d/claude" ]]; then REAL="$d/claude"; break; fi
done
[[ -n "$REAL" ]] || { echo "claude-wrapper: no other claude on PATH" >&2; exit 127; }

if ! TOKEN="$(aws ssm get-parameter --name "$PARAM" --with-decryption --query Parameter.Value --output text)"; then
  echo "claude-wrapper: could not read $PARAM from Parameter Store" >&2
  exit 1
fi
[[ -n "$TOKEN" && "$TOKEN" != "None" ]] || { echo "claude-wrapper: $PARAM is empty" >&2; exit 1; }

CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" exec "$REAL" "$@"
