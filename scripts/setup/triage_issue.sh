#!/usr/bin/env bash
# triage_issue.sh <issue> <area> <kind> <priority> <phase> [parent] [status] — Project に入れてフィールドと親を設定 — ops-kit（bun ops-kit/src/cli.ts --help）の入口。設定は root の ops.config.json。ほかのリポジトリ（GH_REPO を含む）では SWITCHBOARD_PROJECT_URL を付ける
R="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -n "${SWITCHBOARD_PROJECT_URL:-}" || "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" == "$(git -C "$R" rev-parse --path-format=absolute --git-common-dir)" ]] || { echo "ここは Switchboard のリポジトリではないので、SWITCHBOARD_PROJECT_URL=<この Project の URL> を付けて実行してください" >&2; exit 1; }
exec bun "${OPS_KIT:-$R/ops-kit}/src/cli.ts" triage --config "$R/ops.config.json" "$@"
