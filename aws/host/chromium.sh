#!/bin/sh
# chromium (#371) — Playwright's arm64 Chromium for the host user: Google publishes no Linux arm64 Chrome. devtools.sh
# downloads it into ~/.cache/ms-playwright and installs this as /usr/local/bin/chromium, which CHROME_BIN / CHROME_PATH
# name. Runs the newest one there.
B="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)"
[ -n "$B" ] || { echo "chromium: no Playwright Chromium under $HOME/.cache/ms-playwright (npx playwright install chromium)" >&2; exit 127; }
exec "$B" "$@"
