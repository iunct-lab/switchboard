# fork して開発する

上流 mirror は PR を受けない。独自の開発は fork 自身の Issue・Project・PR・レビュー・Release で回し、上流へは要望を送る。

共通の始め方は [キットの fork 手順](../ops-kit/README.md#fork-して開発を始める) に従う。origin と `GH_REPO` を fork に向け、`gh repo set-default` で `gh` の既定を fork にし、Project URL をリポジトリ変数に設定し、キットの開発用 Issue フォームを置き、PR 自動クローズを削除する。Project への自動追加は `ops-kit/template/.github/workflows/project-autoadd.yml` を設定して使う。

キットの手順 2 の `bootstrap` の前に、`ops.config.json` の `fields.area`・`fields.phase`・`milestone.pattern` を自分のリポジトリの値にする（このリポジトリの値は Switchboard 自身のパッケージと Phase で、そのまま `bootstrap` すると自分の Project に入る）。

`ops.config.json` の `publicSync` は残す。`target` は上流の公開リポジトリで、`gh` の前段・キットの道具・アプリのバックログは、既定の書き込み先がそこを向く clone の書き込みを止める。止まったときの直し方は [キットの手順](../ops-kit/README.md#公開側への書き込みが止まったとき)。上流の要望の受け口（Issue）はそのまま使える。

Switchboard 固有の workflow は `.github/workflows/` のものをそのまま使う。

1. `release-tag.yml` を使うなら、リポジトリ変数 `SWITCHBOARD_RELEASE_TAGS=on` を設定する。main への push で（CI を待たずに）`scripts/release-tag.ts` でタグと Release を作る。Actions の書き込み権限を確認する。
2. AWS ホストを使うなら、[AWS の手順](../aws/README.md) に従い自分の AWS に初回配置し、OIDC の対象を fork にする。`host.yml` 用のリポジトリ変数 `SWITCHBOARD_AWS_REGION`・`SWITCHBOARD_HOST_STACK`・`SWITCHBOARD_HOST_ROLE_ARN`（GitHubOidcRole 出力）・`SWITCHBOARD_HOST_PARAMS`（秘密を含まない parameter overrides）を設定する（地域とスタック名は既定と違うときだけ）。トークンの値は SSM から読む（名前 `/switchboard/start-token`・`/switchboard/edge-header` はスタックが決める）。

所有者だけの値や記録は `private/` に置き、公開版に同期時の書き換えを追加しない。
