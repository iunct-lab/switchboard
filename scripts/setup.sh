#!/usr/bin/env bash
# One-time developer setup. Installs Bun if missing and the workspace dependencies.
# Runners (Claude Code, Codex) are installed with their own official installers and only need to be on PATH.
set -euo pipefail

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

cd "$(dirname "$0")/.."
bun install

echo
echo "Runners on PATH:"
for r in claude codex; do
  if command -v "$r" >/dev/null 2>&1; then
    printf "  %-7s %s\n" "$r" "$($r --version 2>/dev/null | head -1)"
  else
    printf "  %-7s (not found — install with the vendor's official installer)\n" "$r"
  fi
done
if command -v age >/dev/null 2>&1; then
  printf "  %-7s %s\n" age "$(age --version 2>/dev/null | head -1)"
else
  printf "  %-7s (not found — only needed for export --encrypt / import of an encrypted history: brew install age)\n" age
fi
echo
echo "Start:  bun run dev   →  http://localhost:5173"
