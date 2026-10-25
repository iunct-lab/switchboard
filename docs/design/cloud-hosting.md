# Switchboard をクラウドで動かす — 使うときだけ起動し、壊れても戻せる

AWS に常駐デーモンを置き、使うときだけ起動する構成。実装は `aws/template.yaml`・`aws/starter.ts`・`aws/host/`、配備手順は `aws/README.md`。

## 1. 配備の前提

自分の AWS アカウントとリージョンを選ぶ。必要なリポジトリだけに書ける GitHub トークンを用意する。稼働時間とデータ成長率から費用を見積もる。ブラウザからの復旧経路を、通常のデーモンとは別に持つ。

## 2. 前提: Switchboard に要る実行環境

- 常駐デーモン: HTTP + WebSocket、PTY（`packages/core/src/pty.ts`）、sqlite（WAL）、git worktree
- ランナーは子プロセス（`claude -p` の stream-json、`codex app-server`）。1 ターンで数分〜数十分
- 背景処理: 履歴の取り込み（30 秒ごと）、利用上限で止まった Task の再開（`resume_at`、`packages/core/src/ratelimit.ts`）、スケジューラ

関数型の実行基盤（Lambda など）は 15 分の上限があり、常駐する WebSocket / PTY / sqlite と合わない。作り直しに近いので対象外にする（案）。
「使うときだけ起動する VM」にして、起動と停止をデーモン自身と小さな外部部品で制御する。

### 2.1 開発ツール（#371）

デーモンが動くだけでは、ランナーが開発（Stacked PR、E2E、登録した workspace のテスト）をできない。`aws/host/devtools.sh` を bootstrap が root で 1 回走らせる（もう一度走らせても、あるものは飛ばす。node だけは固定した版と違えば入れ替える）。

| 何のため | 入れるもの | 入れ方 |
|---|---|---|
| Stacked PR（`pbi-complete`） | gh-stack | `gh extension install --pin` |
| skills の枠の確認 | sqlite3 | dnf |
| E2E（`scripts/*-e2e.ts`） | Chromium（Playwright の arm64 版。Google は Linux arm64 の Chrome を出していない）、その実行ライブラリと Noto CJK | Playwright（版固定）、ライブラリとフォントは dnf。`/usr/local/bin/chromium` を unit の `CHROME_BIN` / `CHROME_PATH` が指す |
| Claude の画面操作 | Playwright MCP（headless、同じ Chromium） | `claude mcp add -s user`（版固定） |
| Claude の設定 | 自分で選んだ JSON 設定 | `bash aws/host/claude-settings.sh ~/.claude/settings.json <patch.json>`。未指定なら既存設定を変えない |
| Python のリポジトリ（DAK など）の単体テスト | uv と Python 3.11 / 3.12 / 3.14、gitleaks（コミットのフック） | 版と sha256 を固定、Python は uv |
| compose を使うリポジトリ（DAK など）の結合テスト | docker と compose | **rootless**（Docker の static 版 + rootless extras、ネットワークは pasta）。版と sha256 を固定 |
| 登録した workspace の IaC | SAM CLI | 版と sha256 を固定 |
| Playwright と MCP を動かす | node（LTS） | 版と sha256 を `aws/host/node.sh` に固定。起動のたびに `sb-host-update` も走らせ、固定した版と違えば入れ替える（§6.5） |
| コミット | git の author | トークンの持ち主（`gh api user`）の noreply アドレス |

- **利用者に root を渡さない**（sudoers は §6 のまま）。そのため docker は rootless で、docker グループも system の dockerd も作らない。`/usr/local/bin/docker` が、応答しなければ `dockerd-up` で起動してからコマンドを渡す。dockerd はデーモンの unit の cgroup の中で動き、systemd のユーザーセッションが無いので cgroupfs を使う。デーモンの unit が再起動するとコンテナも止まり、次の `docker` でまた起動する
- ホストに収まらない docker の検証（`docker compose up --build` のような重いビルドはホストのメモリを使い切って固めるので、`sb-dockerd` は 1.5 GiB で打ち切る）は、明示の `sb-offload <command>` で CodeBuild の 1 回のビルドに出す（#678）。作業ツリーだけを送り、ログと終了コードが返り、ビルドが終われば機械は手放される。`docker` 自体は黙って外に向けない（bind mount や localhost が前提の検証が壊れる）。`build` / `compose up` のときに 1 行だけ案内を出す。機械の大きさは呼び出しごとに選び（`--size small|medium|large`）、指定しなければ最小で走る（#2304。最大は large で、`sb-offload` を通す限り費用の上限は変わらない）。CodeBuild にするのは、実行ごとに作って捨てることが仕組みで保証されるから。一時 EC2 は止め忘れと Spot の空きを自分で扱うことになり、ホストを大きくするのは常に費用がかかる。仕組みと費用は `aws/README.md` の Offload。
- devtools が失敗しても bootstrap は止めない（#389）。記録して先へ進み、デーモンと sb-rescue は起動する（開発ツールが欠けるだけ。作り直すでやり直せる）
- root で展開する tar は `--no-same-owner`（tarball の中の所有者 uid がホストの利用者と同じになりうる。#375）
- 実 LLM や大型 Docker イメージはホストの RAM・ディスクを圧迫する。`/tmp` が tmpfs の場合、大きな作業ファイルを置かない。

## 3. 構成: EC2 を使うときだけ起動する

- 自分の AWS アカウントに専用スタックを作る。リージョン・インスタンスタイプ・稼働時間を選ぶ
- IaC は SAM。`sam deploy --no-execute-changeset` で変更セットを見てから実行する
- 入口は CloudFront。共有ヘッダーをオリジン側で確かめる
- ログインはパスキー（WebAuthn）
- ログインの流れ（#211）: URL を開く → 認可されていなければ UI が `/_auth/?next=<元のパス>` へ移る → 起動用 Lambda（CloudFront の `/_auth/*`、機械が止まっていても動く）のページで Face ID / 指紋 → Lambda が `sb_session` Cookie（HttpOnly・Secure・署名つき、30 日）を出す → 止まっていれば同じ画面の「起動する」→ 動いたら元のパスへ。この Cookie 1 つで Switchboard の画面（`/api`・`/ws`・`/ws/pty`）と救援画面（`/rescue/`）に入れる。Cookie は起動用 Lambda だけが読める Ed25519 の seed（`/switchboard/session-signing-key`）で署名し、デーモンと sb-rescue は公開鍵（`SWITCHBOARD_SESSION_PUBLIC_KEY`、sb-env が `/switchboard/session-public-key` から渡す）で署名と期限を確かめる。ホストには公開鍵しか無いので、ホスト上のエージェントは Cookie を作れない（#701）。Cookie の形は `sb_session=<body>.<sig>`: body は UTF-8 の `<passkeyId>.<expiresMs>` を base64url にした文字列、sig はその **base64url の文字列** への Ed25519 の署名を base64url にしたもの（正準な表記だけを通す）。署名が通っても、デーモンと sb-rescue は起動用 Lambda の `/_auth/status` に「そのパスキーがまだ登録されているか」を Cookie と共有ヘッダを付けて問い、答えを Cookie ごとに 5 分覚える。問えなければ通さない。開いている WebSocket は 5 分ごとに問い直し、消えていれば閉じる（#708）。UI は `/api/health` の `login`（`passkey` / `token`）でどちらのログインかを決め、ログイン後に戻っても拒まれたら（`?from=auth`）もう一度移らずに「デーモンの再起動が要る」と出す（ループしない）。**人がトークンを入力・コピーする場面は無い**。デーモンのトークンはホストの中（ループバック: ランナーの `/mcp`、sb-rescue の死活確認、エージェントの `curl`）でだけ通り、外（CloudFront 経由）からは Cookie だけが通る（#748。判定は接続の相手のアドレスで、ヘッダは見ない）。起動トークンは機械（GitHub Actions、sb-rescue の作り直す）のために残る
- 重要な操作は直近のパスキー確認（#497、デーモンは #1491）: 起動用 Lambda は `/_auth/login`・`/_auth/register` のたびに `sb_recent` Cookie（HttpOnly・Secure・SameSite=Lax、5 分）も出す。形は `sb_session` と同じ body に、署名の入力の前に `recent:` を付けたもの（`sb_session` の値を `sb_recent` に貼っても、その逆も通らない）で、passkeyId が `sb_session` と同じであること。次の操作は、Cookie で入った人にはこれも求め、無ければ 401 `reason: "recent"`。トークン・ループバック（ホストの中）は求めない。

  | 操作 | 受ける側 | Cookie で入った人 | token・loopback |
  |---|---|---|---|
  | 起動・作り直す（`/_auth/start` `/_auth/rebuild`、#497） | 起動用 Lambda | 直近の確認が要る | 求めない（機械の起動トークン） |
  | 救援画面の状態を変える POST（再起動・戻す・プロモート・DB 復元・作り直す・エージェントの起動と停止、#497） | sb-rescue | 直近の確認が要る | 求めない |
  | デーモンの 7 か所（#1491）: ターミナル（`/ws/pty`）、`POST /api/daemon/restart`・`promote`、ワークスペース登録（`POST /api/workspaces`）、設定の保存（`PATCH /api/settings`）、危険モードの Task 作成（`POST /api/tasks`）、危険モードへの切り替え（`POST /api/tasks/:id/permission-mode`） | デーモン | 直近の確認が要る | 求めない |

  見るだけ（起動画面の状態、救援画面とその状態・ログ）、日常の操作（閲覧・返信・承認）、`/mcp`（既に利用者の承認を通る）は求めない。Web UI は 401 `recent` を受けたら「操作の前にパスキーで確かめてください」とボタンを出し、押されたら同じオリジンの `/_auth/login` でパスキーを確かめて（自動では出さない。Safari は利用者の操作の中でしか WebAuthn を呼べない）同じ操作を 1 回だけ送り直す（ターミナルタブは `/ws/pty` と同じ URL への GET で理由を読み、1 回だけ開き直す）。救援画面も同じ流れ。確認用のエンドポイントやサーバー側の記録は持たない。起動・作り直しのたびにセッションを切る仕組みは作らない（#494 の利用者判断: 起動をこの確認の対象に入れて代える）。ブラウザでの流れは `scripts/recent-e2e.ts`
- 最初のパスキー（と全部の端末を失ったとき）は、エージェントがチャットに出す 1 回限り・期限つきの登録リンク（`/_auth/#register=<code>`、コードは `/switchboard/register-code`。本数の上限の対象外）で登録する。2 台目からは、ログイン済みの端末の `/_auth/#devices`（機械が止まっていれば `/_auth/` にも出る）の「登録済みのパスキー」（端末名・登録日時・最後に使った日時・この端末）から: 「別の端末を追加」は、その要求のためのパスキーの署名を付けた `POST /_auth/device-code` で 1 回限り・10 分のコードを受け取り、同じ形のリンクを出す（Cookie だけでは、`sb_recent` があっても出せない。新しいコードは前のコードを無効にする。起動用 Lambda は SHA-256 だけを `auth/passkeys.json` に置き、インスタンスのロールは読めない。この経路で増やせるのは 5 本まで）。各行の「削除」は確認ダイアログの後に同じくその場の署名を付けた `POST /_auth/passkeys/delete`（最後の 1 本は 409）。#414。全部の Cookie を無効にするときは seed と公開鍵を作り直して 2 つのパラメータを入れ替え、インスタンスを再起動（EC2 の Reboot）して sb-env に読み直させる（救援画面の「再起動」は使えない: sb-rescue は再起動まで古い公開鍵を持ち、新しい Cookie を拒むので画面に入れない）。1 台の端末を締め出すときは上の「削除」か、ログイン済みの端末が無ければ `auth/passkeys.json` からそのパスキーを消す（画面と `/rescue/` も 5 分以内）。端末のパスワードマネージャーにはそのパスキーが残り選ぶ画面に出るが、選ぶとログインのページが `PublicKeyCredential.signalUnknownCredential` で端末に知らせ（起動用 Lambda は一覧に無い id を 401 `reason: "unknown"` で返す。署名の失敗とは区別する）、対応するブラウザでは次から選ぶ画面に出ない。対応しない端末では文で案内し、端末の設定から消す（#1312）
- CI の AWS 接続は GitHub OIDC で、長期キーを GitHub Secrets に置かない
- 費用は AWS Budgets で通知する

```text
スマホ / PC のブラウザ
  │ https://<distribution>.cloudfront.net（パスキーでログイン → 署名つき Cookie）
  ▼
CloudFront（キャッシュしない。Cookie はオリジンのデーモンと sb-rescue が確かめ、無ければ UI がログイン画面へ移す）
  │ 共有ヘッダーを付けてオリジンへ
  ├──▶ EC2 t4g.medium（Graviton, 4 GB, リージョンは配備時に選ぶ。既定はオンデマンド）
  │      CloudFront の VPC origin でインスタンスの id に届く。受信は CloudFront のプレフィックスリストだけ許可し、共有ヘッダーも確かめる
  │      ├ switchboard（不変リリース, systemd）
  │      ├ sb-rescue（救援サービス, §6）
  │      ├ EBS gp3 20 GB（/home/switchboard、リポジトリは /home/switchboard/repos）
  │      └ Litestream → S3（sqlite を常時複製）
  ├──▶ /_auth*: 起動用 Lambda（Function URL）のログインと起動の画面（ec2:StartInstances と、この 1 台だけ）
  │      Function URL を直接叩いても共有ヘッダーが無ければ全ルート（/status も）403（#1493）。機械（Actions の host.yml・sb-rescue）は start token に加えて共有ヘッダーを送る。反映の順は、sb-rescue を新しい版にしてから（`bun run rescue:install` をやり直して sb-rescue を再起動。昇格ではデーモンしか替わらない）Lambda を deploy する（先に Lambda だと救援画面の作り直すが 403）。start token の誤りでの SSM の読み直しは 10 秒に 1 回まで
  │  EC2 が止まっていて応答しない（502 / 504）
  └──▶ CloudFront のエラーページとして S3 の「起動ページ」（/_start/）→ /_auth へ
EventBridge Scheduler（resume_at / 定期実行の時刻に起こす）──▶ 起動用 Lambda
```

`aws/template.yaml` の `Cdn` は**オリジンのフェイルオーバー（origin group）は使っていない**。origin group は GET / HEAD しか切り替えないため、止まっている間の 502 / 504 を `CustomErrorResponses` で起動ページ（`aws/startpage/index.html`）に差し替える。ログインと「起動する」「作り直す」のボタンは `/_auth*` の起動用 Lambda（`aws/starter.ts`、`aws/auth-page.html`）が出す。開いている画面の API が起動ページ（HTML の 502 / 503 / 504）を受けたときは、`/api/health` を 2 秒おいて 2 回聞き直し、2 回ともそのページのときだけ `/_auth` へ移る（`apps/web/src/login.ts` の `hostStopped`）。画面に入力中の文があれば、移ると消えることを確認ダイアログで聞いてから移る（断られたら 1 分は聞き直さない）。動いているのに 1 回の接続の失敗で同じページが返ることがあり、そのたびに移ると入力中の文が消えていた。CloudFront からインスタンスへは公開 IP ではなく VPC origin で届く。

### 3.1 起動と停止

- 起動: 停止中の URL は起動ページを表示する。パスキーでログインし「起動する」を押す。予定時刻には EventBridge Scheduler が起こす
- 停止: 実行中・承認待ちの Task、WebSocket、PTY が無く、30 分以内の再開・定期実行も無い状態が 20 分続いたら、次の起動を予約して shutdown する。数えるのはデーモン自身の DB だけなので、停止コマンド（`SWITCHBOARD_IDLE_STOP_CMD`）はデーモンが起動時に自分の環境から消し、Task・ターミナルとそこから起動した試験用のデーモンには渡さない（渡すと、空の DB を見た試験用のデーモンが、動いている Task ごとホストを止める）
- 計測: `daemon.log` の起動時刻・`hostidle`・`sb-stop` と `last -x`、DB の `tasks.created_at` を照合する。ブラウザのボタンから応答までの時間は別に測る
- Spot は中断と容量不足がある。Market の変更はインスタンスの置換になる。注意と切戻しは `aws/README.md`

### 3.2 月額の計算例

例示 workload は月 175 h と常時 730 h。単価は設計時の東京の例であり、配備前に選んだリージョンの単価を確認する。

| 項目 | 計算例 |
|---|---|
| オンデマンド t4g.medium | $0.0432 × 稼働時間 = 約 $7.56 / $31.54 |
| IPv4 | $0.005 × 稼働時間 = 約 $0.88 / $3.65 |
| EBS gp3 20 GB | 20 × $0.096 = $1.92/月 |
| S3 | 保存 GB × 単価 + PUT・GET。版管理の古い版も数える（`host-disk.md`） |
| CloudWatch・CloudFront・Lambda・Scheduler | メトリクス・アラーム・要求数を加える。無料枠は自分の契約で確認する |

無料枠の機械（Oracle Always Free など）は採らない: 枠が予告なく変わり、使われていない機械は 7 日で回収されるので、正本の置き場所にならない。

毎時の定期実行は、停止したホストを毎時起こす。次の予定が 30 分以内なら止まらない。稼働時間を journal から集計し、見積もりと比べる。
予算アラートは `<stack>-1000jpy`（$7）と `<stack>-3000jpy`（$20）。`Project` の cost allocation tag を有効にする。実費は Cost Explorer で確認する。インスタンスロールにはその読み取り権限を付けない。

### 3.3 権限の分離

- クラウドの機械に置くのは、GitHub から clone したリポジトリ、移行した履歴、ランナーの認証情報だけ
- GitHub の権限は登録するリポジトリだけの fine-grained token か GitHub App
- AWS の権限はインスタンスロール。Switchboard のホストに必要な権限だけを付ける。追加ロールは `HostAssumeRoleArns` で明示する。長期のアクセスキーは置かない

## 4. 認証 — Switchboard のコードは鍵を持たない

README の原則「No keys, no telemetry. Your own login, on your own machine.」は、クラウドでも**アプリの層ではそのまま守る**。
鍵を扱うのはランナー自身と、環境の層（systemd と起動スクリプト、インスタンスロール）だけにする。Switchboard のコードは資格情報を読まず、保存せず、API で返さない。

| 対象 | 方法 | 置き場所 | やり直し |
|---|---|---|---|
| Claude Code | ランナー自身のログイン。ターミナル tab で `claude` を起動して `/login`（URL をスマホで開き、コードを貼る）。うまくいかなければ `claude setup-token` を取り、Parameter Store に置く | ランナーが書く `~/.claude/` の資格情報（EBS）。setup-token の場合は Parameter Store | ターミナル tab でもう一度ログイン。setup-token の場合は、AWS コンソール（スマホ可）で Parameter Store の値を更新 |
| Codex | ランナー自身のログイン。ターミナル tab で `codex login --device-auth` | ランナーが書く `~/.codex/auth.json`（EBS） | 同じ操作をもう一度 |
| GitHub（clone / push / PR） | `gh auth login`（device flow）をターミナル tab で。対象リポジトリだけの fine-grained token でもよい（要る権限は `aws/README.md`。自分の resource owner と Project の読み書き権限を指定する） | `gh` が書く `~/.config/gh/`。token の場合は Parameter Store | 同上 |
| 機械を作り直すときに要るもの（Litestream の設定、バックアップの暗号鍵、CloudFront の共有ヘッダー、Cookie の署名鍵） | 起動スクリプトがインスタンスロールで読む | **Parameter Store の SecureString**（標準パラメータ、AWS 管理の KMS 鍵。追加料金なし） | IaC か AWS コンソール |
| AWS（`HostAssumeRoleArns` で名指ししたロールを引き受けて使うもの） | インスタンスロール | — | — |

- setup-token を Parameter Store に置く場合: `claude` の前に置いた小さなラッパー（環境の層、`scripts/host/claude-wrapper.sh`）が、起動のたびに Parameter Store から読み、`CLAUDE_CODE_OAUTH_TOKEN` にして本物の `claude` を exec する。デーモンは PATH の `claude` を起動するだけで、値を見ない（4.2）
- Secrets Manager（1 件 $0.40/月）は、自動ローテーションが要らないので使わない
- Switchboard に足すのは「ログインが切れていると分かる」ことだけ（`/api/health` と Home の警告）。やり直しはターミナル tab か AWS コンソールで行い、専用の入力画面は作らない（2026-09-21 の案）。現行は #354 で、警告の「ログインする」ボタンからランナー自身のログインのコマンド（`claude auth login`、`codex login --device-auth`）を画面で回せる: codex は URL と一度限りのコード、claude は URL とコードを貼る欄。資格情報を書くのはランナーで、貼ったコードはログ・DB・API の応答に残らない（`packages/core/src/runnerlogin.ts`、`apps/web/src/components/RunnerLogin.tsx`）
- 注意: ランナーのプロセスとその子（エージェントが使うシェル）からは、ランナーの資格情報が見える。setup-token はモデルの呼び出しにしか使えないので、漏れたときの影響は狭い
- 規約上の扱いは `docs/design/license-review.md`。個人が自分の認証で使う構成を対象とする

- UI と救援画面への入り方は §3 のパスキー（#211）。Switchboard のコードが持つ秘密はデーモンのトークンだけで、環境の層（Parameter Store → sb-env）から来る。エージェントは同じ OS ユーザーなので読めるが、外からはそのトークンでは入れない（#748）。Cookie を確かめる公開鍵は秘密ではなく、署名の seed は起動用 Lambda だけが読む（#701）

- アクセスログ・操作ログ（#1490）: loopback 以外で待ち受けるとき（クラウドホスト・LAN）だけ、デーモンが標準出力に 1 行 1 JSON を出す（sb-rescue が `~/.switchboard/daemon.log` に書く。ファイルもローテーションも増やさない）。`{"log":"access"}` は 1 要求 1 行で、時刻・接続元・method・パス（クエリを除く）・status・認証の種類（`cookie` / `token` / `none`。示した種類で、通ったかは status で分かる）。接続元は CloudFront の `CloudFront-Viewer-Address` を、共有ヘッダが通った要求でだけ信じ、無ければ接続相手。`{"log":"op"}` は `pty.open`（Task id）・`task.create.danger`・`daemon.restart`・`daemon.promote`・`settings.update`（変えたキーの名前だけ）・`workspace.add`（パス）。本文・クエリ・Cookie・トークンの値は出さない。loopback は今のまま出さない。見方（侵害の確認）は `aws/README.md` の「侵害の確認」

### 4.1 切れていると分かる（#180）

- `/api/health` のランナー欄に `login`（`ok` / `expired` / `unknown`）と `loginHint`（やり直しに打つコマンド）が出る。判定はランナー自身の状態コマンドの終了コード: `claude auth status`、`codex login status`（0 = ok、非 0 = expired、サブコマンドが無いか 10 秒で答えない = unknown）。`claude auth status` の出力は `authMethod`（`claude.ai` / `api_key`）だけ読み、`loginKind`（`claude.ai` / `console`）として出す。アカウント・メール・組織は読まない（#2528）。DAK には `login` が無い。`POST /api/runners/claude/logout` が `claude auth logout` を走らせ、続けて状態を読み直す（#2528）
- 状態コマンドは起動時と、`/api/health` を読んだときに前回から 60 秒過ぎていれば走る。Home の「再確認」（`/api/health?recheck=1`）は待たずに走らせる
- ターンがランナーの「未ログイン」の文（`packages/core/src/login.ts`）で終わったら、状態コマンドが ok と言っていても `expired` にし、Task に `loginHint` を出す。次の確認が ok を返すか、そのランナーのターンが通ると消える
- Home は切れているランナーごとに警告を出す（「Task の「ターミナル」tab で `codex login --device-auth` を実行してください」）。ログインはターミナル tab か、警告の「ログインする」ボタン（#354）で、ランナー自身が行う
- Switchboard のコードが資格情報のファイル名・トークンの変数名を持たないこと、`/api/*` の応答にデーモンの環境のトークンが出ないことは `packages/core/src/nokeys.test.ts` が固定している

### 4.2 setup-token を Parameter Store に置く（Claude、ターミナルでのログインが使えないとき）

1. `claude setup-token` を実行し、表示された token を控える（有効期限は発行時の表示に従う）
2. `aws ssm put-parameter --name /switchboard/claude-oauth-token --type SecureString --value '<token>' --overwrite`（AWS 管理の KMS 鍵。シェルの履歴に残したくなければ AWS コンソールで作る）。インスタンスロールに `ssm:GetParameter` をこのパラメータだけ許す（IaC は #181）
3. クラウドの機械で、本物の `claude` を `/usr/local/lib/claude/bin/claude` などに置き、ラッパーを PATH の前の方に `claude` の名前で置く: `install -m 755 scripts/host/claude-wrapper.sh /usr/local/bin/claude`。PATH は `/usr/local/bin:/usr/local/lib/claude/bin:…` の順（ラッパーは自分のディレクトリを飛ばして、PATH で次に見つかる `claude` を exec する）
4. デーモンの環境（systemd の unit）に `SWITCHBOARD_CLAUDE_TOKEN_PARAM=/switchboard/claude-oauth-token` を置く。値そのものはどこにも置かない。ラッパーは起動のたびに読むので、ファイルにも残らない
5. 期限切れ・失効: Home に警告が出る（4.1）。`claude setup-token` をやり直し、AWS コンソール（スマホ可）でパラメータの値を更新して「再確認」。デーモンの再起動は要らない
- 読めないとき（権限、名前の誤り、ネットワーク）はラッパーが `claude-wrapper: could not read …` を出して止まり、Task はエラーになる。確認: `scripts/host/claude-wrapper.test.ts`（偽の `aws` と偽の `claude`）

### 4.3 デーモンの失敗回数制限（#1492）

Starter（`aws/auth.ts`）と同じ規則を、デーモンの入口にも置く。入口と認証の拒否（`guard` / `entryGuard` / `/ws` / `/ws/pty` / `/mcp/:id` の 401・403、静的配信の `notViaEdge` / `notAllowedHost`）が、同じ接続元キーから 10 分で 10 回に達すると、以後その窓を抜けるまで全ルートに 429（有効な Cookie があっても）。キーは CloudFront-Viewer-Address（共有ヘッダが合うときだけ信じる）のアドレス、IPv6 は /64。数えない要求: 接続相手が loopback のもの（ランナーの `/mcp`、sb-rescue の probe）と、クラウドホストで Viewer-Address が届かないもの（届くまでは全員が CloudFront の 1 アドレスに見え、利用者ごと締め出すため）。ハンドラが返す 403（他の Task の変更など）は数えない。上限・窓は設定にしない。窓は滑る: 直近 10 分の拒否が 10 回未満になれば解ける（最後の 10 回が 10 分の中に収まらなくなった時点）。デーモンの再起動でも解ける。

## 5. 履歴の移行（`--resume` できる形で）

**既定のパスで作り、import のあと `relocate` で合わせる**（#427）。クラウドの機械は `HostHome=/home/switchboard`、`ReposDir=/home/switchboard/repos`（template の既定値）のまま作る。移行元の HOME やリポジトリ置き場を再現しない（EC2 の上で意味のない外付け SSD のパスを持ち込み続けないため）。

- import のあと、デーモンを止めたまま `bun packages/core/src/main.ts relocate --from <移行元のリポジトリ置き場> --to /home/switchboard/repos`、続けて `--from <移行元の HOME> --to /home/switchboard`（接頭辞 1 組ずつ。HOME の下にリポジトリ置き場があるときもこの順）
- 書き換えるもの（パス境界で接頭辞を置換。`/home/dev` は `/home/devx` に当たらない）:
  - DB: `workspaces.path`、`tasks.cwd`、`tasks.scope`（JSON の根）、`routing_log.cwd`、`staging.path`、`attachments.path`、`history_imports.path`
  - Claude のセッションフォルダ: `~/.claude/projects/<旧の名前>…` を `<新の名前>…` に改名（memory も同じフォルダの下）。`history_imports.path` のフォルダ名の部分も同じ対応で
- 書き換えないもの: Claude の jsonl・Codex の rollout の中身（中の `cwd` は履歴として旧パスのまま。再開に要るのはファイルの場所と Switchboard が渡す cwd）、`knowledge_docs.path`（`~/Knowledge` からの相対。絶対の行があれば relocate は止まる）
- 確かめてから書き、どこかで止まれば何も書かない（止まる条件は `packages/core/src/relocate.ts`）
- 旧パスも読める互換層・旧パスへのシンボリックリンクは作らない（書き換えは 1 回のコマンド）
- `/private/tmp/...` の worktree など、移行先に無いパスは作らない。そういう Task も一覧・トランスクリプト・diff は表示でき、返信すると「作業フォルダ … がこの機械に無い」と出て Task が error になる（API は 409）。デーモンは止まらない（#220）
- AWS のスタックでは bootstrap が import してすぐデーモンを起動するので、relocate はその後に `aws/README.md` の「Moving a host to the default paths」の 2〜4 で行い、GitHub の workflow の `rebuild`（Actions → host。救援画面は 2 で止めている）で作り直す（relocate 済みの DB が戻り、Workspace が新しい `ReposDir` に clone され、改名したフォルダが展開される）。既に移行元のパスで動いているホストを既定のパスへ移す手順も同じ節

### パッケージ

`bun packages/core/src/main.ts export <out>`（#218, #219）が作る 1 ファイル（tar を zstd で圧縮。`--encrypt` なら age で暗号化）:

```text
manifest.json      版、元ホスト、HOME、作成日時、件数（tasks と各フォルダのファイル数。元が無ければ null）、各ファイルの sha256 と権限、空のフォルダ
switchboard.db     DB のスナップショット（VACUUM INTO。WAL を含む一貫した状態。sb-rescue と同じ方式）
claude/projects/   ~/.claude/projects（登録 Workspace 以外も含める）
codex/sessions/    ~/.codex/sessions
attachments/       ~/.switchboard/attachments
knowledge/         ~/Knowledge（フォルダごと。git なら .git も入る）
```

ファイルを 1 つずつソースから読んで tar → zstd →（age）へ流す。写しを作るのは DB のスナップショットだけで、メモリに全体を載せない（#1201。全部をメモリで扱うと、3.8 GB のホストでは GB 単位の履歴の日次アーカイブが oom-kill されるため。500 MB の偽の履歴でピーク 2.1 GB → 92 MB）。
作業ディレクトリ（DB のスナップショット）は RAM 上の /tmp ではなく `~/.switchboard/export-<pid>`。oom-kill などで後片づけが動かなかった分は、次の export が開始時に持ち主のプロセスが居ない `export-*` として消す（#1201）。

クラウドのホストの日次アーカイブ（`sb-archive`、`aws/host/archive.sh`）は結果を `~/.switchboard/archive.status` に 1 行で書く。失敗した・始まったまま 2 時間終わらない（oom-kill などで後片づけが動かない）・48 時間成功していない、のどれかなら、デーモンの `/api/health` の `archive` が Web UI の上部に赤いバナーを出す。次の成功で消える（#1201）。

### 手元から S3 に移した履歴（#1431）

日次アーカイブは、アーカイブを上げたあとに、終わって（`done` / `error` / `aborted`）最後の更新から 30 日たった Task の会話の出来事（`events`）を Task ごとに 1 ファイルにして `s3://<DataBucket>/history/events/<年>/<taskId>.<最後の seq>.jsonl.zst.age` に置き、置けた Task だけ手元の行を骨（`docs/design/host-disk.md` の「30 日より前の履歴の分析」）に置き換える。暗号化の鍵は日次アーカイブと同じ（`/switchboard/archive-age-pubkey`。秘密鍵は利用者が持つ）。`history/` には期限が無く、ホストのロールは新しいキーにしか書けない（上書きも削除もできない。消すのは利用者が自分の認証で）。上げ損ねた Task は手元の行を残して次の日にまた試し、`archive.status` は `failed <epoch> 3` になる（バナーが出る）。移した Task を再開して終わると、30 日後に `seq` の続きの分が別のファイルになる。Task の `events_archive_key` に置いたキーが古い順に 1 行ずつ残る。

取り出し方（1 件。ファイルは 1 行 1 出来事の `{"seq":…,"ts":…,"json":"<元の行>"}`）:

```bash
sqlite3 -readonly ~/.switchboard/switchboard.db "select events_archive_key, events_archived_count from tasks where id = '<taskId>'"
aws s3 cp s3://<DataBucket>/history/events/<年>/<taskId>.<seq>.jsonl.zst.age .
age -d -i <秘密鍵のファイル> <taskId>.<seq>.jsonl.zst.age | zstd -d > <taskId>.jsonl
wc -l < <taskId>.jsonl                                  # = events_archived_count（最後のキーの分）
jq -c '.json | fromjson' <taskId>.jsonl | head          # 出来事そのもの
```

ホストのロールは `history/` を読めるが、秘密鍵はホストに無いので復号は利用者の手元で行う。

### 古い会話記録を S3 に移す（#1432）

日次アーカイブは、`~/.claude/projects` と `~/.codex/sessions` のうち新しい方からルートディスクの 10 %（`archive.sh` の `RUNNER_KEEP_MB`。ホストの env の `SB_RUNNER_KEEP_MB` で上書き）まで手元に残し、それを超える古いファイルを、1 回の実行ごとに 1 つの `runner-<UTC 日時>.tar.zst.age`（日次アーカイブと同じ鍵）にして `s3://<DataBucket>/history/runner/` に置く（新しいキーにだけ書ける: `If-None-Match: *`）。`history/` に期限は無い。置けたことを確かめてから手元のファイルを消し、上げ損ねたら何も消さず `archive.status` は `failed <epoch> 4` になる（次の日にまた試す。events の上げ損ね `3` が同じ日にあれば `3` が出る）。

消さないもの: `memory/` の下（会話記録ではなく Claude が読む）、動いている・待っている（`running` / `waiting` / `idle`）Task と、再開の予定（`resume_at`）がある Task の session id をパスに含むファイル（DB を読み取りで開いて引く。DB が無い・読めなければ何も移さない）。上げている間に更新された（mtime か大きさが上げる前と違う）ファイルも消さない（確かめてから消すまでの間は 1 ファイルずつの短い隙で、そこに追記が入る確率は無視できるとして残す）。

一覧は手元の `~/.switchboard/runner-archive.tsv`（1 行 1 ファイル: `元のパス（~ から）<TAB>session id<TAB>S3 のキー<TAB>移した日`）。

```bash
grep <session id> ~/.switchboard/runner-archive.tsv          # どのキーに入っているか
aws s3 cp s3://<DataBucket>/<キー> .
age -d -i <秘密鍵のファイル> runner-<日時>.tar.zst.age | zstd -d | tar -x -C <展開先> <元のパス>
```

Claude Code は自分でも、既定では 30 日より古い会話記録を消す（`cleanupPeriodDays`。この版での値はホストで確かめる: #1441）。手元の量を超えたものに加え、25 日より古いもの（`archive.sh` の `RUNNER_MAX_AGE_DAYS`。Claude の掃除の 30 日より前）も必ず移すので、ホストが動いていれば 30 日の掃除より前に S3 に残る。移した Task を `--resume` しても、手元にファイルが無いので前の文脈なしで続く（`## 再開に要るファイル`と同じ）。`runner-sync` は変えない: 手元が減れば土台と差分も小さくなる。

### 手順

1. **移行元で書き出す**。**先にデーモンを止め、ターミナルの Claude / Codex も閉じる**。DB は VACUUM INTO で一貫したコピーになるが、ランナーのログと添付はそのあとに順にコピーするので、動いていると DB とファイルが食い違うことがある（例: DB を写したあとで添付が Task に移ると、行はあるのにファイルが無い）

   ```bash
   age-keygen -o ~/switchboard-migration.key        # 鍵は利用者が持つ。公開鍵（age1…）が表示される
   bun packages/core/src/main.ts export ~/switchboard-export.tar.zst.age --encrypt age1…
   ```

   既存のファイルには書かない（同じ名前があれば止まる）。出力は 0600。`age` が無ければ入れる（`scripts/setup.sh` が有無を表示する）
2. **転送**: `scp ~/switchboard-export.tar.zst.age <host>:` か、S3 経由（`aws s3 cp` で置いて移行先で取る）。暗号化してあるので置き場所は選ばない。鍵ファイルは別の経路で（パスワードマネージャなど）
3. **移行先で取り込む**。**デーモンを止めてから**、空の HOME に:

   ```bash
   bun packages/core/src/main.ts import ~/switchboard-export.tar.zst.age --identity ~/switchboard-migration.key
   ```

   import が止まる条件（どれも何も書かずに止まる）:
   - 移行先の DB に Task が 1 件以上ある、または `~/.claude/projects`・`~/.codex/sessions`・`~/.switchboard/attachments`・`~/Knowledge` のどれかが空でない（マージも上書きもしない。`--force` は無い）
   - 暗号化されているのに `--identity` が無い / 鍵が違う
   - 展開したものが manifest と合わない（ファイルの過不足、sha256、Task 件数、フォルダごとのファイル数、パッケージの外を指す空フォルダ）。シンボリックリンクは展開されず、置かれない（パッケージは通常ファイルだけを運ぶ。ファイルの権限と空のフォルダは manifest に書いて戻す）
4. **パスを合わせる**（デーモンを止めたまま）: 上の 2 回の `relocate`。出力の件数（列ごとの行数と改名したフォルダ数）を控える
5. **ランナーにログインする**（資格情報はパッケージに入れない。§4）: `claude` の `/login`、`codex login --device-auth`
6. **確かめる**: デーモンを起動して `curl -s localhost:47831/api/tasks | jq length` が manifest の `tasks` と同じ。移した Task に 1 行返信して、ランナーが `--resume`（Claude）/ `thread/resume`（Codex）で前の会話の続きから答えること

移行は 1 回だけ。以後はクラウドが正本で、移行元の Switchboard は止める（案）。移行元のターミナルで作った新しいセッションまでは同期しない。

### 再開に要るファイル（2026-09-23 に調べた結果）

| ランナー | 要るもの | 要らない（移行先で作り直される） | 確かめ方 |
|---|---|---|---|
| Codex（codex-cli 0.155.0-alpha.9.2） | `~/.codex/sessions/**/rollout-*.jsonl` だけ | `state_5.sqlite`・`thread_history_1.sqlite`・`logs_2.sqlite` などの SQLite、`installation_id`、`shell_snapshots/` など（初回起動で生成された） | `CODEX_HOME` を一時ディレクトリにして rollout 1 本だけを `sessions/2026/09/22/` に置き、`codex app-server` に `initialize` → `thread/resume {threadId, cwd}`（ターンは送らない）。結果は `ok: turns 5`、`thread.path` はコピーした rollout を指した。stderr の `401 Unauthorized`（`wss://api.openai.com/v1/responses`）は `auth.json` が無いことによる事前接続の失敗で、resume 自体は通った |
| Claude Code（2.1.280） | `~/.claude/projects/<cwd を - でつないだ名前>/<sessionId>.jsonl` だけ | `.claude.json`、`backups/`、`sessions/`（初回起動で生成された） | `CLAUDE_CONFIG_DIR` を一時ディレクトリにしてセッションファイル 1 本だけを置き、`claude -p --resume <id> </dev/null`（プロンプトなし、資格情報なし）。存在しない id では `No conversation found with session ID`、置いた id では `No deferred tool marker found in the resumed session … Provide a prompt to continue the conversation.`（セッションは見つかり、続けるプロンプトが無いと言っている）= ファイルだけで見つかる |

再現手順（`<id>` はセッション / スレッドの id、`<cwd>` はそのセッションの作業フォルダ、`<enc cwd>` は `<cwd>` の `/` と `.` を `-` にした名前）:

```bash
# Codex: rollout 1 本だけの CODEX_HOME で app-server に resume だけを送る（turn/start は送らない = 枠を使わない）
export CODEX_HOME=$(mktemp -d); mkdir -p $CODEX_HOME/sessions/2026/09/22
cp ~/.codex/sessions/2026/09/22/rollout-*-<id>.jsonl $CODEX_HOME/sessions/2026/09/22/
cd <cwd> && codex app-server --listen stdio://
> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"0"},"capabilities":null}}
< {"id":1,"result":{"codexHome":"<CODEX_HOME>",…}}
> {"jsonrpc":"2.0","method":"initialized"}
> {"jsonrpc":"2.0","id":2,"method":"thread/resume","params":{"threadId":"<id>","cwd":"<cwd>","approvalPolicy":"untrusted","sandbox":"read-only"}}
< {"id":2,"result":{"thread":{"id":"<id>","path":"<CODEX_HOME>/sessions/2026/09/22/rollout-…-<id>.jsonl","turns":[…5 件…],…},…}}

# Claude Code: セッション 1 本だけの設定ディレクトリで、資格情報もプロンプトも無しに --resume
export CLAUDE_CONFIG_DIR=$(mktemp -d); mkdir -p "$CLAUDE_CONFIG_DIR/projects/<enc cwd>"
cp ~/.claude/projects/<enc cwd>/<id>.jsonl "$CLAUDE_CONFIG_DIR/projects/<enc cwd>/"
cd <cwd> && env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude -p --resume <id> --output-format json </dev/null
# → Error: No deferred tool marker found in the resumed session. … Provide a prompt to continue the conversation.
# 知らない id なら → No conversation found with session ID: <id>
```

どちらも資格情報（Codex の `auth.json`、Claude の Keychain / `.credentials.json`）は別で、手順 4 のログインで作る。`~/.codex/plugins` など再生成できるものは入れない（#179 のスコープ外）。

実ランナーで「移した Task に返信して続きから答える」ことは 1 回だけ確かめる（お金がかかるので利用者の承認後。結果は #179 の決定ログ）。

保管と費用: 圧縮後は年 0.5 GB 前後で、S3 に 10 年分置いても月 10 円台。容量より中身（コードや秘密）が問題なので、暗号化してから置く。

## 6. 壊れても戻せる — 復旧の設計

要求は、自己更新でエラーになっても SSH で無理やり入るような手順にしないこと。3 段で守る。

### 6.1 動いているデーモンは、編集中のツリーから動かさない

- 開発用の `bun run dev` の自己更新（`docs/design/self-dev.md`）は、作業ツリーのコードで再起動する。壊れた変更がそのまま動いているデーモンになる
- 実運用（クラウドのホストも）は `~/.switchboard/releases/<sha>/`（`git archive` + `bun install --frozen-lockfile` + Web のビルド。単一バイナリ #21 は not planned で閉じた）を不変のリリースとして置き、`current` / `previous` のシンボリックリンクで切り替える（現行の仕様は `docs/design/releases-and-rescue.md`）
- エージェントが編集するのは `<repos>/switchboard` の worktree だけ。マージしてリリースを作るまで、動いているデーモンには影響しない

### 6.2 昇格は自動で試し、ダメなら自動で戻す

「適用してデーモン再起動」を「この版を昇格」に置き換える:

1. リリースを作る（現行: 機械の上で build する。`rescue/src/releases.ts`。CI は緑のマージにタグを付けるだけで、成果物は置かない）
2. 昇格の直前に DB のスナップショットを取る（現行: `VACUUM INTO` の `snapshots/`、新しい 10 個。Litestream の複製は別に常時）
3. 候補の版を別ポートで起動する。DB はスナップショットの複製を使う。`/api/health`、Task 一覧、WebSocket の接続、ランナーの検出を確かめる
4. 通ったら `current` を切り替えて本番のポートで再起動する。60 秒以内に同じ確認が通らなければ（現行は、その 10 秒後にも通ること）、`previous` に戻して再起動する
5. 結果は救援サービス（6.3）に記録し、UI に出す

DB のマイグレーションは追加だけにする（列を消さない）。古い版が新しいスキーマで動けるので、戻すときに DB を戻さずに済む。
戻しても壊れているときのために、スナップショットへの復元ボタンも用意する。

### 6.3 Switchboard とは別に動く救援サービス（sb-rescue）

- Switchboard とコードを共有しない、小さな独立プロセス（systemd の別 unit）。**エージェントの自己更新の対象にしない**（変更は人がレビューした PR だけで、自動では昇格させない）
- 同じ CloudFront とパスキーの後ろの `/rescue` に、スマホで使える 1 画面を出す（CloudFront のビヘイビアで sb-rescue のポートへ振り分ける）:
  - 今の版、状態、直近のログ 200 行、昇格の履歴
  - [再起動] [前の版に戻す] [版を選んで戻す] [DB をスナップショットから戻す]
  - [救援エージェントを起動]: `claude -p` を、落ちた版のログと直近の差分つきで、リポジトリの worktree で走らせる。出力をこの画面に流す。修正は PR にさせる（直接昇格はしない）
  - 状態を変えるボタンは、Cookie で入った人には直近 5 分のパスキー確認（`sb_recent`、§3）を求める。画面が確認を求めてから続ける（#497）
- 案では「systemd の `OnFailure=` で、起動に 3 回失敗したら自動で `previous` に戻す」だった。現行は sb-rescue がデーモンを子として動かし、落ちたら 1 / 2 / 4 秒後に再起動、3 回目の後は `failed` で止まって**版は変えない**（昇格の途中でなければ戻す先が正しいとは限らないため）。戻すのは救援画面のボタン（`rescue/src/supervisor.ts`、`docs/design/releases-and-rescue.md`）

### 6.4 機械ごとダメなとき

- 機械の外にあるログインと起動の画面（`/_auth`、起動用 Lambda）に [起動する] [作り直す] を置く。案にあった [強制再起動] は無い（機械の中の再起動は救援画面の [再起動]）
- 「作り直す」は、IaC から新しいインスタンスを作り、S3 の最新リリース + Litestream + 履歴アーカイブから復元する（案）。現行はインスタンスを作り直さず、ルートボリュームを起動時の状態に交換する（`aws/starter.ts` の `/rebuild`、`CreateReplaceRootVolumeTask`。インスタンスの id と VPC origin が変わらないため）。EC2 が再起動して UserData（`aws/host/bootstrap.sh`）がもう一度走り、リポジトリを GitHub から clone し直して sb-rescue を入れ、リリースはその機械で build する。S3 にリリースは置かない。sqlite は Litestream から、ランナーの記録は下の退避から戻す。そのため作り直しには GitHub に届くことが要る
- 同じ操作を GitHub Actions の `workflow_dispatch` にも用意する（GitHub アプリからスマホで実行できる、第 2 の経路。AWS には OIDC で入る）
- **ランナーの記録も戻す（#401）**: Switchboard の DB は Litestream から戻るが、ランナー自身の記録（`~/.claude/projects` = Claude の会話ファイル（`--resume` に要る）とメモリの記録、`~/.codex/sessions`）はディスクにしか無い。`sb-runner-sync`（`aws/host/runner-sync.sh`）がこれを tar + zstd にして、**組**として `s3://<data>/archive/runner/<set>/` に置く（#1443）。`<set>` は土台を上げた epoch 秒で、`base.tar.zst`（全部。7 日ごと）と、前回の実行から変わったファイル（ctime）だけの `<epoch>.tar.zst`（差分）が入る。どのキーも 1 回しか書かない（上書きしないので、版管理の古い版ができない）。戻すのは `sb-runner-sync restore`（bootstrap がホストの利用者として呼ぶ）で、最新の組の差分を新しい順に、最後に土台を `--skip-old-files` で展開する（各ファイルは最新の版が残り、既にあるファイルは上書きしない）。旧形式の `latest.tar.zst`（#1443 まで）は読まない
  - いつ: 1 時間ごと（`sb-runner-sync.timer`、変わったファイルがあるときだけ差分を上げる）、自動停止の直前（`sb-stop`）、救援画面の「作り直す」の直前（#403: sb-rescue が `SWITCHBOARD_REBUILD_SAVE_CMD` を実行し、失敗したら・10 秒で終わらなければ作り直さずに理由を出す。理由は 424 で返し、救援画面の状態（`lastError`）にも残す — 502 / 504 は CloudFront が起動ページに差し替え、画面に届かない）。失うのは、救援画面を通らない作り直し（ディスクの故障）で最後の 1 時間まで
  - 保護: Litestream の複製と同じ（バケットの暗号化、このスタックのインスタンスロールだけが読める）。日次アーカイブ（利用者の age 鍵）とは違い、ホストが自分で戻せる。ログイン情報（`~/.claude/.credentials.json`、`~/.codex/auth.json`）は含めない
  - `archive/` は 30 日で消えるので、7 日ごとに新しい組（土台から）を作る。古い組は上げ直さずに期限で消える。期限は最後に上げたときから数えるので、止めてから 23〜30 日で切れる（古い版として更に 30 日残り、人が S3 のコンソールから戻せる）。**これは作り直すための一時的な退避で、長期のバックアップではない**: 救援画面の作り直すは押した直前に上げ直すので期限は関係なく、効くのは「長く止めた後に救援画面を通らずに作り直す / ディスクが壊れる」ときだけ。なお日次アーカイブも同じ `archive/` にあり、止めている間は作られないので、**約 60 日（30 日 + 古い版の 30 日）以上止めた後にその作り直し・故障が起きると、ランナーの記録はどこからも戻らない**。Switchboard の履歴（DB）は Litestream の複製（`litestream/`、期限なし）から戻る
  - 作業中のセッションは tar が読んでいる間にも書かれる。GNU tar はそのとき 1 で終わるが、アーカイブは完全なので上げる（そのファイルの最後の行が切れうるだけ。切れた会話ファイルからも `claude --resume` で続きを再開できることを 2026-09-27 に確認）。読めないファイル・フォルダ（tar の 2）のときは上げない（欠けた退避で正しいものを上書きしないため）
  - 戻すのは「まだ何も無い」（`archive/runner/` に土台が無い）ときだけ飛ばす。それ以外の失敗（`aws` の失敗）では bootstrap を止める（Litestream と同じ。空に近い退避で正しいものを上書きしないため）
  - 費用の計算例（実測ではない）: 圧縮した土台を 350 MB、1 時間の差分を 5 MB と仮定する。常時稼働なら 1 日に書く量は 350 MB ÷ 7 + 24 × 5 MB = **170 MB**。どのキーも上書きしないので、約 60 日分（`archive/` の 30 日 + 古い版の 30 日）は **10.2 GB**。設計時の S3 Standard 東京 $0.025/GB 月では約 $0.26/月。同じキーを上書きする方式は、版管理により退避全体が回数分残る。

### 6.5 root が main を信頼する経路（#852）

信頼境界: main の `aws/host/` は root で走る。main に書けるトークンをホストに渡すなら、main の保護とレビュー経路を配備前に確認する。

- 経路は 2 つある
  - 作り直すたび: UserData が main を clone し、`aws/host/bootstrap.sh` を root で走らせる（§6.4、`aws/README.md`）
  - 起動のたび: `sb-host-update`（#435 / PR #803）が main を clone し直し、下の表のスクリプトを root で `/usr/local/bin` に入れる。入れ替えは `host-update.sh` の `for src in …` の一覧が正本で、`aws/host/host.test.ts` の "#852" のテストがこの表と突き合わせる。同じ起動で、AL2023 の最新のリポジトリのセキュリティ更新を `sb-security-update` の unit（`dnf --releasever=latest upgrade --security`、起動は待たない）に渡す（#2186）。root が走らせるのは distribution の署名つきのパッケージだけで、main から root で走る範囲は変わらない。Node.js は dnf のパッケージではないので、同じ起動で `sb-node` を `sb-node-update` の unit に渡す（起動は待たない）。`node.sh` に固定した版と sha256 の nodejs.org の tarball だけを入れ、入っている版が違うときだけ入れ替える

| スクリプト | 入れ先の名前 |
|---|---|
| `aws/host/host-update.sh` | `sb-host-update` |
| `aws/host/sb-stop.sh` | `sb-stop` |
| `aws/host/sb-env.sh` | `sb-env` |
| `aws/host/archive.sh` | `sb-archive` |
| `aws/host/runner-sync.sh` | `sb-runner-sync` |
| `aws/host/offload.sh` | `sb-offload` |
| `aws/host/pre-rebuild.sh` | `sb-pre-rebuild` |
| `aws/host/node.sh` | `sb-node` |

- 受け入れる理由: 権限は増えない。ホストのエージェントはもともと main に書け、main を信頼している。変わるのは main の中身が root で動くまでの手間（救援画面の再起動 1 操作）だけ。merge-gate が `aws/host/**` を `[聞く] セキュリティ` にし、利用者の確認なしにはマージしない。ただし merge-gate は助言で、通さずに main を書き換える経路は残る。main を保護できる（ruleset などを付けられる）なら保護する
- 却下した案
  - B: root が入れるのは、利用者が Parameter Store に置いた commit だけにする。管理の手間が重い。main を保護できないなら、commit の固定だけを足しても、変えるたびに sha を置く手間に見合わない
  - B': B に加え、UserData / bootstrap も同じ commit を clone する。B と同じ理由
  - C: スクリプトの入れ替えをやめる。スクリプトの更新を「作り直す」以外で届けるという #435 の目的を満たさない

#### 見直す契機

- main を保護できるようになった。確かめ方: `gh api repos/<owner>/<repo>/rulesets` が 403「Upgrade to GitHub Pro …」でなくなる。月 1 回の検査が見る: `bun scripts/host-trust-check.ts [--file-request]`（exit 0 = 契機なし / 1 = 契機 / 2 = 判定できない。`--file-request` は契機のとき見直しの要望を 1 件起票し、同じ題の開いた要望があれば重ねない）。merge-audit と同じ月 1 回の定期実行で走る（#1367）
- ホストのトークンで書けるリポジトリ・権限が広がった。確かめ方: トークンを変えるときに `aws/README.md` の `/switchboard/github-token` の行で示す
- root で走る範囲が増えた。確かめ方: 上の表と `host.test.ts` の "#852" のテスト、`aws/host/**` の PR で merge-gate が `[聞く] セキュリティ` にする

どの段でも、利用者の操作はブラウザ（スマホ可）のボタンだけ。ターミナルと SSH は使わない。

## 7. DAK との関係

DAK は任意の接続先。`SWITCHBOARD_DAK_URL` が未設定なら DAK は登録されない（ランナーの選択肢にも出ない）。DAK アダプタを使う場合は `SWITCHBOARD_DAK_URL` を自分の ADK REST の接続先にする。Switchboard のホスト配備に DAK の開発ロールは要らない。

## 8. 配備の確認

`aws/README.md` の初回配備チェックを自分のスタックで実行する。自己更新・履歴の復元・ランナーの再ログイン・起動と停止を確認する。

## 9. 未検証（実測が要るもの）

- 選んだリージョンでの Spot の価格・中断頻度・容量
- ボタンから UI 応答までの時間と CloudFront の起動ページへの切り替え時間
- RAM に対するランナーの同時実行数
- setup-token の有効期限と、ラッパー経由での `claude auth status` の終了コード
- スマホのターミナル（PTY）の切断と再接続
- 自分の契約の無料枠・実費・予算アラートの集計
