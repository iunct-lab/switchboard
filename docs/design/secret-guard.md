# secret-guard（認証に使える値を Issue や PR に書かせない）

Switchboard が起動したランナーの `gh` の前段に検査を置く（PBI #661）。認証に使える値を含む文を Issue・PR・コメントに書こうとすると、GitHub に送る前に止まる。決まりの文は共通スキル `issue-workflow` の「Issue・PR・コメントに書かない値」。

発端: 無人の実行のエージェントは、クラウドの管理者権限の一時セッション用の device code と承認 URL を Issue コメントに書くことがある。この仕組みの前は、決まりにも仕組みにも止めるものが無かった。エージェントはホストの AWS の SSO のプロファイル名も Issue のコメントに書くことがある。値の形をしていない名前は規則に無かった（#1093、#1243）。

## 部品

| 部品 | 場所 | 役割 |
|---|---|---|
| 検査 | `ops-kit/src/secrets.ts` の `findSecrets` | 文の中の値を見つけ、種類と行番号を返す。値は返さない。ホストの AWS の設定（`AWS_CONFIG_FILE`、無ければ `~/.aws/config`）の名前とアカウント ID は `hostAws` が読み、呼ぶ側の入口（前段、`scan-text`、`scan-issues`、`ops-kit backlog` の送信前、ローカル CI の投稿）が 1 回ずつ渡す |
| 前段 | `ops-kit/bin/gh`（`ops-kit/src/gh-guard.ts`） | 書き込みの本文を検査し、当たれば exit 1。続けて公開側の写しへの書き込みを検査し（下の「公開側の写しへの書き込み」）、当たれば exit 1。どちらにも当たらなければ本物の `gh` にそのまま渡す |
| 配線 | `packages/core/src/tasks.ts` の `startSession` | ランナーに渡す `PATH` の先頭に meta workspace の `ops-kit/bin`、末尾にデーモンの `bun` のフォルダを置く（`StartOptions.env`） |
| ホストの対話シェル | `/etc/profile.d/sb-gh-guard.sh`（`aws/host/sb-gh-guard.sh` を `bootstrap.sh` が置く） | クラウドのホストの、ホストのユーザーの端末タブ（`bash -i`）とログインシェルの `PATH` の先頭に meta のチェックアウトの `ops-kit/bin`、末尾に `bun` のフォルダを置く。Switchboard を通さずに手で動かす `claude` / `codex` の投稿も、どのリポジトリでも前段を通る（#824）。チェックアウトが無ければ `PATH` を変えない。root やほかのユーザーのシェルは変えない（チェックアウトはエージェントが書けるので、root の `PATH` の先に置かない） |
| 定期の検査 | デーモンの予定「認証の値の検査」（`action: "secret-scan"`、`packages/core/src/secretscan.ts`） | 登録済みの全リポジトリに `scan-issues` を発火ごとに、前回からの差分で走らせ、当たりか検査できなかったリポジトリがあれば判断待ちにお知らせを出す（#2866） |
| 後からの検査 | `ops-kit scan-issues [<owner/name>]`（キットの `bin` の `ops-kit`。中身は `bun ops-kit/src/cli.ts scan-issues`。入口の無いリポジトリでも同じ） | 既に書かれた Issue・コメント・PR のレビューコメントとレビュー本文を検査する。引数なしは全部、`--since <ISO 8601>` はその時刻より後に更新されたもの（PR のレビュー本文はその間に更新された PR のものだけ）、`--recheck <URL>` は前回の当たりを差分の外でも読み直す（消えていれば当たりなし）。1 ページの取得は 3 回までやり直し、読めなければ「当たりなし」と言わず exit 2。最後に `hits: N / scanned: M`（読んだ文の数） |

## 止める場所

ランナーの hook ではなく `PATH` にした。ランナーの hook はランナーごとに渡し方と信頼の扱いが違い（Codex の hook は利用者が信頼した定義しか動かさず、その記録は `~/.codex` に置くのでホストの作り直しで消える。`shared-tmp-guard.md`）、ホームに置くと作り直しで消える。`PATH` は Task の作業フォルダがどのリポジトリでも、ランナーが Claude Code でも Codex でも同じ 1 か所で効く。

`/tmp` の固定名の歯止めは、Claude Code には hook（ホームではなく共通キットに置き `--settings` で渡す）、Codex にはサンドボックスで効かせる（`shared-tmp-guard.md`）。`gh` の前段は Codex にも効かせるため `PATH` のまま。

- どの経路で始めた Task（工程ボタン、手で作った Task、スケジュール、並走、再開）にも効く。`startSession` はスキルを置く場所（`docs/design/skill-sync.md`）と同じ
- meta workspace が無いときは `PATH` を変えない
- 前段は `PATH` から前段を除いた最初の `gh` を本物として呼ぶ。無ければ exit 127。別のチェックアウトの前段（ファイルの 2 行目が `// gh-guard`）も飛ばすので、`PATH` に前段が 2 つあっても呼び合わない
- `ops-kit/bin/docker`（#1417）も同じ探し方（`realCommand`）で本物の `docker` を呼ぶ。ファイルの 2 行目は `// docker-mark`。呼び出し側が `DOCKER_MARK_LABEL`（`key=value`）を渡したときだけ `run` / `create` にその label を足し、`DOCKER_MARK_LOG` があれば compose のプロジェクト名を記録する（共通キットに固有語を置かないので、Task の印は core が渡す）。片付けは #1419
- 前段は `bun` で動く。デーモンはフルパスの `bun` で起動されることがあるので（`scripts/setup.sh`、再起動の `process.execPath`）、配線がデーモンの `bun` のフォルダ（`dirname(process.execPath)`）も `PATH` の末尾に足す（末尾なので、利用者の `PATH` にある道具より前に来ない）

## 検査する書き込み

| コマンド | 読む文 |
|---|---|
| `gh issue create（new）/ comment / edit` | `--title`、`--body`、`--body-file`（`-` は標準入力） |
| `gh pr create（new）/ comment / edit / review` | 同じ |
| `gh issue close` / `gh pr close` | `--comment` |
| `gh pr merge` | `--body`、`--body-file`（`-` は標準入力）、`--subject`（マージのコミットの本文と題） |
| `gh release create（new）/ edit` | `--title`、`--notes`、`--notes-file`（`-` は標準入力）。添付ファイルは読まない |
| `gh gist create（new）/ edit` | ファイルの引数の中身（`create` は全部、`edit` は id の次。`-` とファイルの無い `create` はパイプの標準入力）、`--add` のファイル、`--desc`。`gh` が広げるパターン（`'*.md'`）は前段も広げて読む |
| `gh api` | `-f key=value` の value、`-F key=@file` のファイル（`@-` は標準入力）、`--input`（JSON なら中の文字列を 1 つずつ） |

- フラグの書き方は `gh` が受ける形を全部読む: `--body x`、`--body=x`、`-b x`、`-b=x`、`-bx`、短いフラグをまとめた `-cb x`（まとめて読むのはサブコマンドごとの既知のスイッチの文字だけ。知らない文字があれば、表に無いフラグの値（`-Hfeat`）として読まない）。サブコマンドの前にフラグがあっても読む
- 1 文字のフラグはサブコマンドごとに読む（`-c` は `pr close` では文、`pr review` ではスイッチ。`-t` は `pr merge` では題、`gh api` では読まないテンプレート）。前段のフラグとスイッチの表は「グループ → サブコマンド」の 1 つ
- `gh api` はメソッドに関係なく読む。フィールドは GitHub に送る文なので、検索の `-f q=…` に値があっても止まる
- 標準入力はバイトのまま読み、同じバイトを本物の `gh` に渡す。パイプやファイル記述子（`<(…)`）の本文は 1 回しか読めないので、読んだ内容を一時ファイル（権限 600）に置き、引数をそのパスに差し替えて渡す。`gh` が戻ったら消す
- それ以外の引数・終了コード・出力は変えない
- 読めないファイルは、そのファイルだけ検査せずに渡す（`gh` が自分の言葉で失敗を伝える）。同じコマンドのほかの文は検査する

検査する種類: `approval-url`（`user_code=` 付きの URL）、`device-code`、`aws-key`、`github-token`、`private-key`、`bearer-token`、`account-id`、`sso-start-url`、`invite-secret`（`#k=` の値）、`aws-profile`（下）。伏せた書き方（`XXXX-XXXX`、`#k=…`、`<profile>`）は当たらない。

`account-id` は 12 桁の数字を、値と文脈で見る（#2345）。12 桁は UUID・ハッシュ・id の中にも偶然に現れるので、形の例外を足していくのではなく、当たる理由のあるものだけを当てる。
- 値: 検査が動くホストの AWS の設定（`AWS_CONFIG_FILE`、無ければ `~/.aws/config`。`aws-profile` と同じファイル 1 つ）に書かれた 12 桁（`sso_account_id`、`role_arn` などの ARN の中）は、前後が数字でなければ語が無くても、どこに書かれても当たる（裸、`dev<12 桁>-admin` のようにプロファイル名に埋まったもの、UUID の最後の区切りの位置）。設定の値は比べるのに使うだけで、ファイルに書かず、ハッシュにもしない
- 文脈: 設定に無い 12 桁は、ARN の中（`arn:aws:iam::<12 桁>:`。`:` が `%3A` でも）、プロファイルとして名指しされた語の中（`--profile dev<12 桁>-admin`、`AWS_PROFILE=`）、または前後が英数字でない（`-` と `_` は可。`Admin-<12 桁>`、`<12 桁>_Admin`）12 桁で、同じ行か直前のラベルにアカウントの語（`account` / `アカウント` / `プロファイル`）か AWS の語（`aws` / `iam` / `sso` / `arn` / `role` / `profile`）があるときに当たる。英字に接する 12 桁（16 進の hash や DER の接頭辞の中）は、AWS の語が同じ行にあっても文脈では当てない。文脈のある行の偶然の 12 桁（AWS の request id の UUID など）は当たる
- 当たらないもの: 設定に無いアカウントの、文脈の無い 12 桁（裸で書かれた別のアカウントの ID も外れる。セキュリティの範囲を狭める判断として #2345 で受け入れた）。伏せた書き方と、クラウドの文書の例の 2 つの番号（`123456789012` / `000000000000`）
- 設定の無い場所（Actions の `secret-scan.yml`、利用者の手元）では、文脈のある 12 桁だけが当たる

例外の一覧や設定は持たない。誤検知で投稿が止まったら、規則を直して無くす（#661 の方針）。

`aws-profile` は、検査が動くホストの AWS の設定（`AWS_CONFIG_FILE`、無ければ `~/.aws/config`）の `[profile <名前>]` と `[sso-session <名前>]` の名前を、単語として含む行に当たる（SSO のセッション名も）。名前の形からは見分けられないので、規則は名前を設定から読む。`default` は名前として読まない。名前の前後が英数字・`_`・`-` のとき（`<名前>-host`）は別の語なので当たらず、大文字小文字は区別しない。英字だけの名前は普通の語（名詞）と区別できないので、`--profile <名前>`、`AWS_PROFILE=<名前>`、`[profile <名前>]`、`sso_session = <名前>` のようにプロファイル・セッションとして名指しされた位置だけで当たる（2026-10-14、実際の設定の名前が 1 つのリポジトリの散文に 245 行出て、規則を狭めた。誤検知は一覧や設定で除かず、規則を直す）。設定が読めないホスト（Actions の `secret-scan.yml`）では何にも当たらない。当たりは種類と行番号だけで、名前は出さない。切る設定は無い。

## 公開側の写しへの書き込み

2 つ目の検査。公開に出す木を clone して自分のリポジトリで開発する人の工程が、公開側に書かないようにする。判定はキットの `publicCopyRefusal`（`ops-kit/src/config.ts`）1 つで、リポジトリの名前を持たない: 最寄りの `ops.config.json` の `publicSync.target`（文字列だけを読む。`parseConfig` は通さない）と書き込み先が同じなら止める。

- 書き込み（`writeTargetOf`）: `issue` / `pr` / `label` / `release` の読み取り以外のサブコマンド、`gh api` の GET / HEAD 以外（メソッドが無くフィールドがあれば POST）、`graphql` の mutation。先は `-R` / `--repo`（グループの前後どこでも）、Issue・PR の URL、`GH_REPO` の順。`{owner}/{repo}` と `graphql` は `GH_REPO`
- 先がほかのリポジトリなら通す。先が公開側か未指定なら、`GH_REPO` が公開側、または本物の `gh repo view` が公開側のとき止める。`gh repo view` は `GH_REPO` を見ずに remote から答えるので、`GH_REPO` だけ直した clone の `-R "$(gh repo view …)"` も止まる。読み取りとほかを名指しした書き込みでは `gh repo view` を呼ばない
- 開発元の clone は `gh repo view` が開発元なので、公開側を `-R` で名指しする操作（同期の PR、要望 Issue への返信とクローズ）は通る
- キットの道具の `repoOf`（`ops-kit/src/gh.ts`）と、デーモンのバックログの `backlogRepoOf`（`packages/core/src/backlog.ts`。取込み・昇格の失敗の報告・指示のプリセットの対象）も同じ判定で止める。デーモンでは取込みの失敗としてバックログ画面に文が出て、送信元が保存されないので送信も起きない。読み取りだけの定期の秘密の検査は止めない

## アプリの Task の中の Issue への直接の書き込み（#2694）

- `BACKLOG_URL` がある（アプリの Task の中）とき、その workspace のリポジトリ（`GH_REPO`、無ければ origin。`ops-kit backlog` と同じ決め方）の Issue に `gh issue create（new）/ comment / edit / close / reopen` で書くと、秘密の検査の前に書かずに exit 1 で止め、`ops-kit backlog` の同じ操作を案内する（`backlogWrite`。直接書くと、アプリの次の編集の元が古くなり送るときに競合する。`backlog-sync.md` の「アプリの Task の中の書く経路」）
- 通すもの: `-R` / `--repo` か Issue の URL がほかのリポジトリ（公開側の Issue への返信など）、PR、読み取り、`gh api`（mutation は解析しない）。強制ではなく歯止め（同じ OS ユーザーの Task は本物の `gh` を呼べる）

## 止めないもの

- 本文を対話のエディタで書く `gh`（コマンドに文が無い）
- `gh` を使わない投稿（`curl` で API を直接叩く、MCP の GitHub ツール）
- ホストの外（ブラウザなど）で書くもの
- 上の表に無いコマンド

これらは `scan-issues` が後から見つける（`gh pr review --body` で書いたレビュー本文も読む）。下の定期の検査が走らせる。

## 定期の検査

既に書かれたものの検査は共通の仕組みで 1 つ: デーモンの予定（#775）。登録済みの全リポジトリを、発火ごとに同じ規則で見る。

- Actions の `secret-scan.yml` はホストの AWS の設定を持たないので `aws-profile` は当てない（ホストの定期の検査が見る）
- 予定は利用者が定期タスクの画面で作る（種類「認証の値の検査」。いつ回すかは定期タスクの画面の値）。`backlog-next` と同じく meta workspace に置き、ランナーも Task も使わない（LLM の分を使わない）。起動時に勝手には作らない
- 1 回の発火で、登録済みのワークスペースごとに `gh repo view` でリポジトリを求め、同じリポジトリ（複数の作業フォルダ）は 1 回にまとめ、meta のチェックアウトの `ops-kit/src/cli.ts scan-issues <owner/name>` を順に走らせる。読むのはホストの `gh` のログイン（バックログ画面と同じ）。新しいトークンも Actions の分も使わない
- リポジトリごとに、前回読み始めた時刻と当たりの URL を予定の結果（`schedules.last_result` の `cursors`）に残し、次の発火は `--since <その時刻> --recheck <URL>...` で差分だけを読む。時刻は起動の直前に取るので、検査の間に書かれたものは次に読み直す。記録の無いリポジトリは全件、検査できなかったリポジトリは前回の記録のまま
- 結果はリポジトリごとに 1 行、定期タスクの画面のログに残る: `0 件（scanned M）` / `当たり N 件` と場所 / `検査できなかった`（exit 2、起動の失敗、リポジトリを特定できないワークスペース。書くのは exit の番号だけで、失敗の出力は写さない — 何を引用しているか分からないため）
- 当たりか検査できなかったリポジトリがあれば、Home のお知らせ欄に 1 件。同じ予定の前のお知らせは新しいものが来たら閉じる。読んだら閉じる。題は「認証の値の検査: 当たり N 件 / 検査できなかった K リポジトリ」、本文は利用者のすること（URL を開いて本物か見る / 本物なら値を無効にしてからコメントを削除 / 誤検知なら閉じる）+ URL と種類とリポジトリ名だけ（`scan-issues` の出力のうち当たりの行の形のものだけを写すので、値は入らない）。0 件の日はメモを作らない
- ホストが止まっていた日は、起きたときの最初の確認で 1 回走る（期限を過ぎた予定は 1 回だけ発火し、次はその cron の次の時刻。予定はホストを起こす時刻にも入る）
- `.github/workflows/secret-scan.yml`（このリポジトリを週に 1 回）はホストの外の予備として残る

個別のリポジトリに同じ仕組み（自前の検査・hook・定期のワークフロー）を作らない。規則・止め方・定期の検査が 2 つずつになり、片方だけ直す・片方だけ抜けることになる。リポジトリごとのワークフローは、他のリポジトリを読むトークンか、リポジトリごとの写しが要る。足りない規則や読む範囲は共通の側に足す（#775 で capsule-host の分を共通に寄せた）。

## やらないこと

- 検査を切る設定・フラグ・環境変数。誤検知は `findSecrets` の規則を直して無くす
- 当たった値の自動の削除や伏せ字への書き換え。削除は利用者の判断（編集では履歴に元の文が残る）
- 無人の実行で承認を受ける経路。別の PBI（#662）
