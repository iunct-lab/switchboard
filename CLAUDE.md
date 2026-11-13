# Switchboard — このリポジトリ固有の値

開発の流れ（要望 → PBI → Task → PR → レビュー → マージ）はスキル（`ops-kit/skills/` の `issue-workflow` ほか）に従う。スキルに書かれていない、このリポジトリだけの値はここに置く（`issue-workflow` の「使う側のリポジトリが持つもの」の各項目）。スキルとこのファイルが食い違えば、このファイルに従う。

## リポジトリと Project

- リポジトリ: このリポジトリ（`gh repo view --json nameWithOwner -q .nameWithOwner`）。`gh` の PR の書き込み（作成・コメント・編集・マージ・クローズ）には `-R "$(gh repo view --json nameWithOwner -q .nameWithOwner)"` を付ける。Issue・コメント・ラベル・Project・Milestone は `ops-kit backlog`（Task の中でも外でも同じ）
- Project の URL: リポジトリ変数 `SWITCHBOARD_PROJECT_URL`（同名の環境変数を優先）。選択肢（Area / Kind / Priority / Phase）・必須の節: root の `ops.config.json`。Milestone は Phase ごと（`Phase N — …`）。自分の Project URL を登録する。新しい Issue は `ops-kit backlog create` で作ると Task の中ではアプリが Project に入れる。フィールドは `ops-kit backlog triage` / `set`（Status は自分で付ける）
- バックログの道具: `ops-kit backlog`（`--help`）と `ops-kit lint --fresh`。ほかのリポジトリのバックログは、Task の中では `--workspace <id>`、Task の外では `GH_REPO=<owner/name> SWITCHBOARD_PROJECT_URL=<URL>`。`scripts/setup/` の入口はブートストラップと検査（`bootstrap_project.sh` / `request_issue.sh` / `scan_issues.sh`）の用で、中身は `ops-kit/`（`bun ops-kit/src/cli.ts --help`）
- 公開リポジトリへの同期: 開発元の手順は `private/CLAUDE.md` に移した。公開の写しを作るなら、公開先・外すファイル・書き換えるファイルは root の `ops.config.json` の `publicSync`（仕組みはキットの README の「Syncing to the public repository」）
- 認証に使える値（ホストの AWS のプロファイル名・SSO のセッション名も）を Issue・PR に書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。Switchboard が起動したランナーでは `gh` の前段（`ops-kit/bin/gh`、`docs/design/secret-guard.md`）が投稿の前に止める。既に書かれたものは `bash scripts/setup/scan_issues.sh`（`SWITCHBOARD_ACTIONS` が `on` のリポジトリでは週に 1 回 `.github/workflows/secret-scan.yml` も走る）
- Story Points の目安: 尺度と目安は `issue-workflow` の「### Story Points」。このリポジトリで基準にする閉じた PBI は `private/CLAUDE.md`
- 設計ルール: README の `## Design rules`（`## License` の手前まで）。ライセンスは Apache-2.0（依存を足すなら `bun pm licenses`）
- 互換層の前提: 利用者は 1 人、外部クライアントは無い。旧形式を読む層は作らず、データは `packages/core/src/db.ts` の migration で 1 回移す
- 並列ガード: `bun scripts/parallel-guard.ts`（`claim` / `overlap` / `release`。スキルの `<guard>`）。アプリが同期しているリポジトリでは `--repo` を付けなくてよい（付けてもアプリの保存に書く）。Task の外でほかのリポジトリの PBI を扱うときだけ `--repo` で名指しする
- 言語: 公開に出る文書（README・公開する `docs/design/`・`aws/README.md`・`SECURITY.md`）は英語で、本文に Issue 番号 `#N` を書かない（公開側では開けない。根拠は日付と中身の文で書く）。確かめ方は `bun scripts/public-docs.ts check [file…]`（既定は `publicSync.exclude` を除いた `docs/` 以下・`aws/README.md`・`SECURITY.md`。README は含まないので `check README.md` と渡す）。画面の文言・コマンド・工程の prompt は原文のまま backtick かコードブロックに入れる。開発に入る入力（このファイル・スキル・Issue テンプレート・工程のプロンプト）と画面は日本語。ただしヘッダーのタブの名前（Home・Backlog・Schedules など）は英語で、タブを足すときもほかのタブに合わせる（2026-11-03 の利用者の指摘）。共通キットの `ops-kit/public/`（英語）は変えない。言語や体裁を揃える提案は、見た目でない実益の理由があるときだけ、その理由で Issue にする
- 決まりの置き場所: 利用者の指摘からできた決まりはメモリではなく記載に書く。どのリポジトリでも同じなら共通キットのスキル、このリポジトリだけならこのファイルか `docs/design/`。ランナーのメモリ（Claude の `~/.claude/projects/*/memory/`）にはホスト・アカウント・経緯の事実だけを置く（`issue-workflow` の「記録の義務」の 6）。`AGENTS.md` はこのファイルを指すので、ここに書けば Codex にも届く

## 前提（要望を PBI にする前に照らすもの）

`request-to-backlog` の「前提と照らす」と `pbi-to-tasks` の設計チェックが、PBI のユーザーストーリーをこの各行と照らす。矛盾すれば PBI にしない（PBI が既にあれば Task にせず Ready にしない）で `## 判断待ち` で聞く。

- インスタンスは 1 つ。開発と本番を兼ね、別の開発用・検証用のインスタンスは無い（利用者は 1 人。上の「互換層の前提」）。記録の正本と GitHub への書き込み口を持つ。乗るマシンはどこでもよく、今は EC2（言葉: インスタンス = Switchboard 1 つ（デーモン・DB・画面）、マシン = それが乗る計算機（1 つ以上）、実行環境 = Task が動く道具・版・パスの一式（1 つに揃える）、作業場 = 実行環境の上でランナーと worktree が動く場所（インスタンスの一部。1 つ以上））
- 別のマシンの作業場は外向きの通信だけで、記録・GitHub への書き込み・自動の判断を自分では持たない
- Task がここで全部できる。Task が昇格・再起動・マージを叩く（昇格は、自分以外の Task が動いても待ってもいなければ聞かずに叩き、動いていれば待つ。下の「Switchboard の Task と動いているコード」）。Task から操作を取り上げる要望は運用を止める
- loopback で待ち受けるデーモンは、localhost に届く人を持ち主として信頼する。同じ OS ユーザーの Task は DB もシェルも触れるので、localhost の 1 つの口に認証を足しても Task は回避できる（#31、`docs/design/workspace-mcp.md` の「Local API token」、#1755 の結果）
- パスキーのログインはインターネット越しの構成（CloudFront 経由）だけ。ホストの中（loopback）では求めない（`docs/design/cloud-hosting.md` の「3. Architecture: start EC2 only when it is used」のログインの流れ、#748）
- 頼まれていない OS や環境（Mac・launchd など）の対応・手順・検証を PBI・Task・文書に足さない（実行環境は 1 つで、OS ごとの対応や分岐を足さない。別のマシンでは同じ実行環境をコンテナで動かす）
- 画面の見た目・操作を変える PBI は `**置き場所**: 床|天井|壁 — 理由` を書く。毎回は触らない値を床（Home など最初の画面）に並べる案は、天井（Settings・畳んだ節）へ置くか、床に置く理由を書く。安全に関わる確認は畳まず、機能は消さない（原則は `docs/design/ui-layers.md`）

## テスト

```bash
ops-kit heavy -- bun run typecheck
bun scripts/test-changed.ts     # <関係するテスト>。Task の中はこれ（枠はスクリプトが取る。SWITCHBOARD_SUPERVISED はスクリプトが抜く）
env -u SWITCHBOARD_SUPERVISED bun test <file> -t "<name>"     # 変数を継承すると selfdev の dry-run テストが落ちる
```

型検査は、マシンの重い処理の枠を取ってから始める（`ops-kit heavy`。上限・置き場・足し方はキットの README の「Heavy-process slots」）。`test-changed`（一式に広がることがある）は枠を自分で取る（`ops-kit heavy` で包まない）。`sb-offload` があるホストでは録画を読まないテストを外のビルドで回し、外を待つ間は枠を持たない。1 ファイルの `bun test` は包まない。ローカル CI（`bun scripts/local-ci.ts`）は自分で枠を取るので `ops-kit heavy` で包まない。一式（`ops-kit heavy -- env -u SWITCHBOARD_SUPERVISED bun test`）は Task の中で手では回さない（`bun scripts/test-changed.ts` が判定できない変更は、スクリプトが自分で一式に広げる）。PR の CI は差分の決まった head で 1 回回り（Actions は全テスト、`bun scripts/local-ci.ts` は影響範囲に絞る）、全テストの安全網はタグの CI。足したテストは実装を 1 か所壊して赤を見る。壊し方は PR 本文に（`task-to-pr` の「足す前に」）。

変更ごとのテストの型（軽い順。上の行で足りるなら下の行へ行かない。足す前の検討は `task-to-pr` の「足す前に」）:

| 変更 | テスト |
|---|---|
| core の関数 | `packages/core/src/<name>.test.ts`。起動なしの関数の単体。これで足りるなら次へ行かない |
| web の描画ロジック | `apps/web/src/*.test.ts`（DOM の型は `transcript.test.ts`。`bun:test` ファイルは web の typecheck から除外）。描画だけならここで止める |
| アダプタ | Git の外の録画 fixture の再生（`runner-adapter-recording` スキル）。自分のランナーで録画して Git の外に保存し、`bun scripts/fixtures.ts list` で配置を確認する。変換はここで止める |
| API | `startServer` を偽アダプタで起動して `fetch`（`core.test.ts` の型）。起動を要るのは HTTP の経路そのものを見るときだけ。関数で書けるものは関数で |
| 単体で書けない UI / 経路 | 上のどれでも確かめられないときだけ。偽ランナーのデーモン（`startServer` を `mktemp -d /tmp/switchboard.e2e.XXXXXX` の `boot.ts` から、`SWITCHBOARD_HOME` は DB のコピー（このとき `SWITCHBOARD_CANDIDATE=1` を必ず渡す。無いとコピーの中の Task が使用上限の自動再開で本物のセッション id のまま動き、GitHub への未送信の書き込みも送る）、ポートは `lsof` で空きを見て 47911 以上。`ops-kit heavy -- bun "$W/boot.ts"` で起動（キットの README の「Heavy-process slots」））+ `bun run --cwd apps/web build` + headless Chrome（`--remote-debugging-port`、CDP）。boot.ts は自分で書かず `.claude/skills/verify-live-ui/SKILL.md` の boot.ts を写して使う。偽ランナーは `packages/core/src/devproxy.test.ts` の型 |
| 境界（プロキシ・認証・CORS） | 実構成の E2E（`devproxy.test.ts` の型）。境界そのものを見るときだけ |

動いている Switchboard での確認（live check）は `verify-live-ui` スキル（デーモンと Web UI `localhost:5173`）。

画面に関わる変更（`apps/web` の描画・CSS）の PR は、`ops-kit heavy -- bun scripts/screens-audit.ts --screens <触った画面>`（`bun run --cwd apps/web build` の後。実データの写しの候補のデーモンで、スマホ縦 390×844 と PC 1280×900 を中のスクロールごとに撮る）で撮った画面を自分の目で見てから出し、本文に貼る（置き場は下の「画像」の `feedback-assets`）。スマホ縦は必ず見る。題が読めない・横にはみ出す・1 字幅で縦に並ぶ・ボタンが崩れる・ヘッダーなどの帯が要る段数より多い（1 つの項目だけで 1 段を取る、詰めれば収まるのに段が増える。スクリプトの「帯の余分な段」。2026-11-07 の利用者の指摘）なら直してから出す。PBI に `**画面イメージ**` があれば、撮った画面と並べて見比べ、違いを本文に書く。動き・文言の E2E だけで画面を確かめたことにしない（2026-11-06 の利用者の指摘。#4020）

`task-to-pr` の「足す前に」が言う開発の流れの道具は `scripts/`・`ops-kit/`・`aws/`・`rescue/`。

## 作業の場所

- main の作業ツリーでは作業しない（利用者の `bun run dev` か release のデーモンがそこを見ている。`packages/core` を触るとセッションごと再起動する）。`git worktree add --detach ../switchboard-<topic> origin/main` → `bun install`。PBI を丸ごとなら `../switchboard-pbi<PBI>`
- 枝: `sb/<Task番号>-<topic>`。Task を積むときは `gh stack`（`stacked-pr-delivery`）
- 作業ファイル: `W=$(mktemp -d /tmp/switchboard.<用途>.XXXXXX)`。`/tmp` 直下に固定の名前で置かない（別のリポジトリのセッションとぶつかる）。`ops-kit/bin/deny-shared-tmp`（Claude Code の PreToolUse。Task にはデーモンが `--settings` で渡し（#773）、このリポジトリでは `.claude/settings.json` でも登録。Codex の Task は hook ではなく、`/tmp` を閉じたサンドボックスで止める（#787。Codex の Task は `W=$(mktemp -d)` で `$TMPDIR` の下に作る。`/tmp/…` は失敗する）。`docs/design/shared-tmp-guard.md`）が反するコマンドを止める。`/tmp` は RAM で、ホストの停止・作り直しと満杯の片付け（#1720）で消える。再開してから読むもの（Issue・PR 本文の下書き、レビューの材料）はすぐ投稿するか、消える前提で作り直せる形にする（#1988）

## Switchboard の Task と動いているコード

- `SWITCHBOARD_SUPERVISED=1` なら自分は Switchboard の Task（スキルの「エージェント管理アプリの Task」）
- 成果物の登録は返答の中の `switchboard-artifact` のフェンス（`docs/design/artifacts.md`）。画面イメージの問いに書く Task の id は環境変数 `SWITCHBOARD_TASK_ID`（`issue-workflow` の「画面イメージ」）
- マージ後の main の作業ツリーの更新は共通の `ops-kit pull-main`（`pbi-complete` の 6-6、`docs/design/main-pull.md`）。ただしデーモンが main の作業ツリーから `bun run dev` で動いている（`ps -eo args | grep -q '[s]cripts/dev.ts'`）なら、pull は `--watch` でデーモンを再起動するので、走らせる前に利用者の OK を取る（Task の会話で聞く。`issue-workflow` の「判断待ちの出し方」の運用の確認。Issue に書かない）。release（sb-rescue の `~/.switchboard/releases/<sha>`）で動いているなら pull では再起動しない
- 動いている Switchboard への反映（昇格）: マージの後、自分以外の Task が動いても待ってもいなければ、聞かずに昇格する（利用者の常時の OK、2026-10-08）。昇格は `bun scripts/promote.ts <マージした main の sha>` で頼む（呼んだ Task を除いて、ほかに動いている・待っている Task があれば頼まずに exit 1 で、そのときは待つ。exit 2（判定できない・頼めない。release から動いていない 409、デーモンに届かない）のときは昇格せず、理由を報告に書いて続ける。待つのはデーモンの `promoteWhenIdle`。`POST /api/daemon/promote` を直接（`curl` などで）叩かない）。動いている・待っている Task があれば昇格しない（昇格はデーモンを再起動し、動いている Task を切る）。待つのは自分で続けなくてよい — アプリの「バックログを進める」が発火のたびに最新のリリースタグを昇格し、Task が動いていれば Task が空いたときに昇格する（`packages/core/src/backlog.ts` の `PromotionStep`、`packages/core/src/server.ts` の `promoteWhenIdle`）。始めた PBI の Task が全部止まったら、次の PBI を始める前に、main が動いている版より進んでいれば先に昇格する（2026-10-17）

## 画像（要望・PBI に貼るもの）

GitHub の API では Issue に画像を添付できないので、`feedback-assets` ブランチに contents API で置き（作業ツリーは触らない）、`https://github.com/${REPO}/raw/feedback-assets/<path>` を本文に埋める（REPO は `gh repo view --json nameWithOwner -q .nameWithOwner`）。フィードバックボタン経由の要望は、prompt 末尾の「添付ファイル」ブロックに画像のパスがある。

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# 1 回だけ: orphan ブランチが無ければ API で作る
gh api repos/${REPO}/git/ref/heads/feedback-assets >/dev/null 2>&1 || {
  BLOB=$(gh api repos/${REPO}/git/blobs -f content="feedback screenshots; never merged" -f encoding=utf-8 -q .sha)
  TREE=$(gh api repos/${REPO}/git/trees -f "tree[][path]=README" -f "tree[][mode]=100644" -f "tree[][type]=blob" -f "tree[][sha]=$BLOB" -q .sha)
  COMMIT=$(gh api repos/${REPO}/git/commits -f message="feedback-assets: root" -f tree="$TREE" -q .sha)
  gh api repos/${REPO}/git/refs -f ref=refs/heads/feedback-assets -f sha="$COMMIT" >/dev/null
}
# 画像ごと: feedback/<要望Issue番号>-<n>.png。base64 は引数に載せない（1 MiB の PNG で "Argument list too long"）
jq -n --arg branch feedback-assets --arg message "feedback #<num>: screenshot" --rawfile content <(base64 < /path/to/shot.png | tr -d '\n') \
  '{branch:$branch, message:$message, content:$content}' > "$W/upload.json"
gh api -X PUT repos/${REPO}/contents/feedback/<num>-1.png --input "$W/upload.json" >/dev/null
curl -sI -H "Authorization: token $(gh auth token)" https://github.com/${REPO}/raw/feedback-assets/feedback/<num>-1.png | head -1   # 200 or 302
```

## 利用上限

```bash
sqlite3 -header ~/.switchboard/switchboard.db "select runner, window, case when resets_at < strftime('%s','now') then 0 else utilization end as utilization, resets_at, ts from quota"     # runner | window | utilization | resets_at(epoch s) | ts(ms, 記録した時刻)
date -d @<resets_at>
```

`resets_at` が過ぎた行は枠が戻っているので、`utilization` は 0 で返る（記録は枠が戻ったあと更新されないことがある）。

工程ボタンの API（`/api/backlog/<n>/start`）が積んだ Task（応答の `resumeReason` が `"start"`）を返したら、その Task は別の Task を始めず、`resumeAt` の時刻を報告して止まる（上限の直前で代わりが無いとき、起動せずにリセット時刻まで積まれる）。

Codex の `five_hour` が 0.9 以上、または `codex exec` が使用上限で止まったら、レビューは Claude のサブエージェントで代替する（`cross-runner-review` の 0）。

## マージ判定とローカル CI

- マージ判定: `bun scripts/merge-gate.ts <PR> [--allow-large] [--merge|--merge-stack]`（exit 0 = merge / 1 = stop / 2 = 判定不能。`--merge`（単発）/ `--merge-stack`（スタックの最下段）は判定が merge のときだけマージまで進む。Task の許可に入る既定のマージはこれ。利用者が Task の会話で判定の外のマージを認めたときは `gh pr merge` / `gh stack merge`（`pbi-complete` の 5）。規則は `scripts/merge-gate.ts`、手順と印は `docs/merge-gate.md`）。スキルの `<マージ判定>`。large の理由のうち `[再チェック <kind>]` は、`docs/merge-gate.md` の「Recheck」（スキルの `<再チェック>`）を回して付ける印 `[recheck] <kind> pass <head sha>` で外れる。`[聞く]` は利用者が認めたとき（`--allow-large`）だけ
- ローカル CI: Actions が始まらない（ジョブのステップ 0 件）か run が無い（全部の run が skip された、も同じ）ときは `bun scripts/local-ci.ts <PR>` で Actions と同じ手順（`scripts/ci.ts`）を、最新の head を最新の base にマージして回す。結果は PR に付き（`[local-ci] pass|fail <head sha> base=<base sha>`）、スタックでは全部の PR の指摘の処理が済んでから一番上で 1 回回し、merge-gate は一番上の最新の結果が pass で、その PR の今のコミットがその pass の head に同じ差分で入っていれば（`git cherry`）CI の成功と数える（いつ回し、どう数えるかは `docs/merge-gate.md` の「When to run local CI and how it counts」。自動 rebase と base の前進では回し直さない）。base の枝の保護が必須チェックを求めると BLOCKED で止まる（ローカルの結果では満たせない。確かめ方は `docs/merge-gate.md` の「Branch protection and local results」）。スキルの `<ローカル CI>`。`bun test` は影響範囲だけを回す（`--all` で全部、全テストの安全網はタグの CI）。同じ head の最新の結果が merge-gate の数える pass なら回さず exit 0（`--force` か `--all` で回す）。クラウドのホストでは重い手順（型検査・`bun test`）を外で回す（`docs/design/local-ci-offload.md`）。詳細は `docs/merge-gate.md`
- Task の中のローカル CI とレビューは、自分のシェルで回して待たず `ops-kit job request local-ci <PR>` / `ops-kit job request review <PR> --runner … --prompt … --out …` でアプリに頼み、`job#<id>` を止まりの理由（reason `depends`）に書いてターンを終える（背景の `sleep` の待ちのループで待たない。仕組みは `docs/design/daemon-jobs.md`）。Task の外は従来どおり直接回す

## 追加のレビュアー

`cross-runner-review` の `<extra>` は自分の環境で設定する。未設定なら追加レビュアーなしと報告する。

@private/CLAUDE.md

fork した人は所有者の値を `private/CLAUDE.md` に書くか、`private/CLAUDE.md` を省略する。
