#!/usr/bin/env bash
# Stop the runner CLIs replacing themselves on this host: their versions change only through the daemon's checked
# update. Runs as the host user; applying it again changes nothing.
# - Claude Code: `DISABLE_AUTOUPDATER` in ~/.claude/settings.json's env reaches every `claude`, one started by hand too
#   (the adapter's own copy of the variable only reaches the Tasks it starts with the runner telemetry off).
# - Codex: the CLI never replaces itself (the TUI only offers an update, run on a person's choice). Its self-updater is
#   the app-server daemon's updater loop (`codex app-server daemon start`, `codex remote-control`), on by default and
#   hourly once started; its preference is `updater.autoUpdateEnabled` in $CODEX_HOME/app-server-daemon/settings.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# the patch is a file, not <(…): claude-settings.sh reads it twice (the object check, then the merge)
PATCH="$(mktemp)"
trap 'rm -f "$PATCH"' EXIT
echo '{"env":{"DISABLE_AUTOUPDATER":"1"}}' > "$PATCH"
bash "$HERE/claude-settings.sh" "$HOME/.claude/settings.json" "$PATCH"
echo '{"updater":{"autoUpdateEnabled":false}}' > "$PATCH"
bash "$HERE/claude-settings.sh" "${CODEX_HOME:-$HOME/.codex}/app-server-daemon/settings.json" "$PATCH"
