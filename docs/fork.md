# fork して開発する

上流 mirror は PR を受けない。独自の開発は fork 自身の Issue・Project・PR・レビュー・Release で回し、上流へは要望を送る。

共通の始め方は [キットの fork 手順](../ops-kit/README.md#fork-して開発を始める) に従う。origin と `GH_REPO` を fork に向け、Project URL をリポジトリ変数に設定し、キットの開発用 Issue フォームを置き、PR 自動クローズを削除する。Project への自動追加は `ops-kit/template/.github/workflows/project-autoadd.yml` を設定して使う。

Switchboard 固有の workflow は `.github/workflows/` のものをそのまま使う。

1. `release-tag.yml` を使うなら、リポジトリ変数 `SWITCHBOARD_RELEASE_TAGS=on` を設定する。main の CI 成功後に `scripts/release-tag.ts` でタグと Release を作る。CI の workflow 名が `CI` であることと Actions の書き込み権限を確認する。
2. AWS ホストを使うなら、[AWS の手順](../aws/README.md) に従い自分の AWS に初回配置し、OIDC の対象を fork にする。`host.yml` 用のリポジトリ変数 `SWITCHBOARD_AWS_REGION`・`SWITCHBOARD_HOST_STACK`・`SWITCHBOARD_HOST_ROLE_ARN`（GitHubOidcRole 出力）・`SWITCHBOARD_HOST_PARAMS`（秘密を含まない parameter overrides）を設定する（地域とスタック名は既定と違うときだけ）。トークンの値は SSM から読む（名前 `/switchboard/start-token`・`/switchboard/edge-header` はスタックが決める）。

所有者だけの値や記録は `private/` に置き、公開版に同期時の書き換えを追加しない。
