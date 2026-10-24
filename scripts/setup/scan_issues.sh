#!/usr/bin/env bash
# scan_issues.sh [<owner/name>] — Issue・コメント・PR のレビューコメントとレビュー本文に認証に使える値が無いか検査（exit 0 無い / 1 ある / 2 検査できなかった。出力は場所と種類で、値は出ない） — ops-kit（bun ops-kit/src/cli.ts --help）の入口。設定は読まない。<owner/name> を省くと GH_REPO、無ければ今のディレクトリの origin
R="$(cd "$(dirname "$0")/../.." && pwd)"
exec bun "${OPS_KIT:-$R/ops-kit}/src/cli.ts" scan-issues "$@"
