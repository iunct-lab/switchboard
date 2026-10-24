# Actions が動かないときの GitHub の運用（#890）

Actions の workflow がしていた運用を、Actions が始まらない間（請求の問題でジョブのステップが 0 件、など）も同じコマンドで回す。workflow もそのコマンドを呼ぶだけにして、中身は 1 か所（`ops-kit` / `scripts/`）に置く。Actions を無効にはしない。

| 運用 | Actions | Actions の外（同じコマンド） |
|---|---|---|
| Issue / PR を Project に入れる | `project-autoadd.yml`（open / reopen のたび） | `bun ops-kit/src/cli.ts reconcile-project` |
| ラベルを `.github/labels.yml` に合わせる | `labels.yml`（main への push） | `bun ops-kit/src/cli.ts sync-labels` |
| Issue・PR に書かれた認証の値を探す | `secret-scan.yml`（週に 1 回、予備） | デーモンの予定「認証の値の検査」（毎日、#775）。手では `bash scripts/setup/scan_issues.sh` |
| main の検証済みのコミットにタグと Release | `release-tag.yml`（CI の成功後） | `bun scripts/release-tag.ts $(git rev-parse origin/main)`（マージの後に手で。検証済みでなければ断る。`docs/design/releases-and-rescue.md` の Tags） |
| クラウドホストの status / start / rebuild / deploy | `host.yml`（Run workflow、OIDC） | `bun scripts/host-ops.ts <action>`（自分の AWS のログインで） |
| 救援（再起動・前の版に戻す・DB を戻す） | なし（Actions を通らない） | sb-rescue の救援ページ（`/rescue/`） |

## Project に入れる: `reconcile-project`

open の Issue と PR を全部読み、設定の Project（`SWITCHBOARD_PROJECT_URL`、無ければリポジトリ変数）に無いものだけを `addProjectV2ItemById` で入れる。フィールドは付けない（Status は今までどおり自分で付ける）。既に入っている item は触らないので、Status などが Backlog に戻ることは無く、もう一度回すと何もしない。閉じたものは入れない（autoadd も open / reopen だけ）。

```bash
bun ops-kit/src/cli.ts reconcile-project --dry-run   # 入れるものの番号だけ出す
bun ops-kit/src/cli.ts reconcile-project
```

読むのは `gh` のログイン（Project の書き込みと、リポジトリの Issues / PR の読み取り）。Actions の `project-autoadd.yml` も同じコマンドを `SWITCHBOARD_PROJECT_TOKEN` で呼ぶ（checkout は base の枝で、PR のコードは動かさない）。

## ラベル: `sync-labels`

`.github/labels.yml`（引数で別のファイル）の各ラベルについて、無ければ作り、色・説明・名前の大文字小文字が違えば直す。ファイルに無いリポジトリのラベルは消さない（前の labeler の `skip-delete` と同じ）。合っていれば何もしない。

```bash
bun ops-kit/src/cli.ts sync-labels --dry-run   # create <name> / update <name> を出すだけ
bun ops-kit/src/cli.ts sync-labels
```

色は 6 桁の 16 進を文字列で書く。YAML が数に読む色（`5319e7` は 5319×10⁷、`000000` は 0）は元の桁が分からないので、読み込みで断る（`"5319e7"` と囲む）。

## 秘密検査

既に書かれた Issue・PR の検査は、デーモンの予定（`docs/design/secret-guard.md` の「定期の検査」、#775）が登録済みの全リポジトリを毎日回す。Actions が動かなくても止まらないので、その予定がある（スケジュール画面に「認証の値の検査」がある）なら、OS の cron などに同じ検査を別に登録しない（規則と通知が 2 つになる）。デーモンが止まっている間は、手で `bash scripts/setup/scan_issues.sh [<owner/name>]`（`ops-kit scan-issues` と同じ。exit 0 = 無い / 1 = ある / 2 = 検査できなかった）。

その予定が無い環境（デーモンを使わない、予定を消した）で Actions も動かないときだけ、OS 標準の cron から同じコマンドを回す。値は出ないが、当たりは exit 1 なので、出力を自分が読む場所に残す:

```cron
# crontab -e（このリポジトリの clone、gh にログインしたユーザーで）。cron の PATH は /usr/bin:/bin だけなので、bun と gh の場所を足す。月曜 06:17
PATH=/home/<user>/.bun/bin:/usr/local/bin:/usr/bin:/bin
17 6 * * 1  cd <clone> && bash scripts/setup/scan_issues.sh >> ~/.cache/scan-issues.log 2>&1 || echo "scan-issues exit $? $(date -Is)" >> ~/.cache/scan-issues.log
```

予定を後から足したら、この cron の行は消す。

## ホスト: `scripts/host-ops.ts`

`host.yml` の手順を移したもの。workflow は OIDC でロールを受けたあと `bun scripts/host-ops.ts "$ACTION" --yes` を呼ぶだけ。Actions が動かないときは、同じコマンドを**自分の AWS CLI のログイン**（`aws sso login`、`AWS_PROFILE`）で手元から回す。ホストの instance role ではスタックを読めないので、ホストの中からは回らない（`cloudformation:DescribeStacks` の AccessDenied）。AWS の認証情報をこのスクリプト・Switchboard・リポジトリに置かない。

```bash
bun scripts/host-ops.ts status                         # 承認なしで読むだけ
bun scripts/host-ops.ts start --dry-run                # 何をするかだけ出す。AWS にも SSM にも触らない
bun scripts/host-ops.ts start --yes                    # start / rebuild / deploy は --yes が要る（付けなければ exit 2 で何もしない）
SWITCHBOARD_HOST_PARAMS="$(gh variable get SWITCHBOARD_HOST_PARAMS)" bun scripts/host-ops.ts deploy --yes
```

- スタック・リージョンは `SWITCHBOARD_HOST_STACK` / `SWITCHBOARD_AWS_REGION`（既定 `switchboard-host` / `ap-northeast-1`。workflow と同じリポジトリ変数の名前）
- 最初に `aws sts get-caller-identity` で認証を確かめ、無ければ「AWS に認証できない」で止まる（やり直さない。ログインは自分で）
- start / rebuild は SSM の start token と edge header を読み、Starter にヘッダで送る。値はコマンドの引数にも出力にも出さない
- deploy は DeployRole で change set を作り、LaunchTemplate か Instance に触れるなら実行しない（Spot の要求を先に取り消す人の deploy。`aws/README.md` の Deploy）。sam の失敗は「no changes」にしない（#759）。sam が出す parameter overrides の edge header は `***` に置き換えて出す
- 失敗したら: 何もしていない段階（認証・読み取り・sam の change set まで）は同じコマンドをもう一度。`execute-change-set` の後で止まったら `aws cloudformation describe-stack-events --stack-name <stack>` で状態を見てから決める（自動ではやり直さない）

## 救援

再起動・前の版に戻す・この版に戻す・DB をスナップショットから戻す・作り直すは、sb-rescue の救援ページ（`docs/design/releases-and-rescue.md` の The rescue page）でする。Actions を通らないので、Actions の停止で変わらない。外からはパスキーのログイン（5 分以内の確認つき）、ホストの中からは loopback でトークン（`rescue/src/server.test.ts` の認証の境界のテスト）。これ用の管理 API は新しく作らない。ページに届かないときは `/_auth/` の 停止する / 起動する / 作り直す（`aws/README.md` の Start, stop, 作り直す）か、上の `host-ops.ts start|rebuild`。

## 失敗したとき

- `reconcile-project` / `sync-labels` / `scan-issues` は何度回してもよい（足りないものだけを足す・直す）。途中で落ちたら、同じコマンドをもう一度回す
- `gh` の認証・権限が足りない（401 / 403、Project が見つからない）なら、`gh auth status` と Project の権限を確かめてから回す。勝手に別のトークンに切り替えない
- GitHub の利用制限（`docs/design/github-api-budget.md`）なら、表示された時刻の後に回し直す
