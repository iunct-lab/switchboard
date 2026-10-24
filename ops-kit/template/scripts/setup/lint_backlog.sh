#!/usr/bin/env bash
# lint_backlog.sh [--no-project] — open の PBI / Task / 要望の記載規約を検査（exit 0 合格 / 1 違反 / 2 検査できなかった） — 共通キットの入口。設定は root の ops.config.json。キットは OPS_KIT、無ければ __KIT_HOME_VAR__/ops-kit
R="$(cd "$(dirname "$0")/../.." && pwd)"
K="${OPS_KIT:-${__KIT_HOME_VAR__:+$__KIT_HOME_VAR__/ops-kit}}"
[[ -n "$K" && -f "$K/src/cli.ts" ]] || { echo "共通キットが見つかりません。共通キットの ops-kit を OPS_KIT=<path> で渡してください" >&2; exit 2; }
exec bun "$K/src/cli.ts" lint --config "$R/ops.config.json" "$@"
