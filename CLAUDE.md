# Switchboard — このリポジトリ固有の値

開発の流れ（要望 → PBI → Task → PR → レビュー → マージ）はスキル（`ops-kit/skills/` の `issue-workflow` ほか）に従う。スキルに書かれていない、このリポジトリだけの値はここに置く（`issue-workflow` の「使う側のリポジトリが持つもの」の各項目）。スキルとこのファイルが食い違えば、このファイルに従う。

## リポジトリと Project

- リポジトリ: このリポジトリ（`gh repo view --json nameWithOwner -q .nameWithOwner`）。`gh` の書き込み（issue / pr の作成・コメント・編集・マージ・クローズ）には `-R "$(gh repo view --json nameWithOwner -q .nameWithOwner)"` を付ける
- Project の URL: リポジトリ変数 `SWITCHBOARD_PROJECT_URL`（同名の環境変数を優先）。選択肢（Area / Kind / Priority / Phase）・必須の節・Story Points: root の `ops.config.json`。Milestone は Phase ごと（`Phase N — …`）。自分の Project URL を登録する。Project 自動追加は `ops-kit/template/.github/workflows/project-autoadd.yml` の任意導入。未導入なら `scripts/setup/triage_issue.sh` で登録する（Status は自分で付ける）
- バックログの道具: `scripts/setup/` の入口（`lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `bootstrap_project.sh` / `request_issue.sh` / `scan_issues.sh`）。中身は `ops-kit/`（`bun ops-kit/src/cli.ts --help`）。ほかのリポジトリの Project を触るときは `SWITCHBOARD_PROJECT_URL=<URL>` を付ける
- 公開リポジトリへの同期: `ops-kit public-sync`（共通キットの `bin/ops-kit`。`--dry-run` は送らずに結果だけ出す）。公開先・外すファイル・書き換えるファイルは root の `ops.config.json` の `publicSync`。仕組みはキットの README の「公開リポジトリへの同期」、このリポジトリの手順は `docs/design/public-repo.md`
- 認証に使える値（ホストの AWS のプロファイル名・SSO のセッション名も）を Issue・PR に書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。Switchboard が起動したランナーでは `gh` の前段（`ops-kit/bin/gh`、`docs/design/secret-guard.md`）が投稿の前に止める。既に書かれたものは `bash scripts/setup/scan_issues.sh`（週に 1 回 `.github/workflows/secret-scan.yml` も走る）
- Story Points の目安: 2 = 文書や局所的な修正、3 = 単一 API の変更、5 = 複数モジュールの変更、8 = API・UI・保存をまたぐ変更。自分の完了した PBI と比べて調整する
- 設計ルール: README の `## Design rules`（`## License` の手前まで）。ライセンスは Apache-2.0（依存を足すなら `bun pm licenses`）
- 互換層の前提: 利用者は 1 人、外部クライアントは無い。旧形式を読む層は作らず、データは `packages/core/src/db.ts` の migration で 1 回移す
- 並列ガード: `bun scripts/parallel-guard.ts`（`claim` / `overlap` / `release`。スキルの `<guard>`）。ほかのリポジトリの PBI では `--repo <owner/name>` と `SWITCHBOARD_PROJECT_URL`

## 前提（要望を PBI にする前に照らすもの）

`request-to-backlog` の「前提と照らす」と `pbi-to-tasks` の設計チェックが、PBI のユーザーストーリーをこの各行と照らす。矛盾すれば PBI にしない（PBI が既にあれば Task にせず Ready にしない）で `## 判断待ち` で聞く。

- この環境 1 つで開発と本番を兼ねる。別の開発環境・検証環境は無い（利用者は 1 人。上の「互換層の前提」）
- Task がここで全部できる。利用者の OK の後に、Task が昇格・再起動・マージを叩く（下の「Switchboard の Task と動いているコード」）。Task から操作を取り上げる要望は運用を止める
- loopback で待ち受けるデーモンは、localhost に届く人を持ち主として信頼する。同じ OS ユーザーの Task は DB もシェルも触れるので、localhost の 1 つの口に認証を足しても Task は回避できる（#31、`docs/design/workspace-mcp.md` の「Local API token」、#1755 の結果）
- パスキーのログインはインターネット越しの構成（CloudFront 経由）だけ。ホストの中（loopback）では求めない（`docs/design/cloud-hosting.md` の「3. 構成」のログインの流れ、#748）

## テスト

```bash
bun run typecheck
env -u SWITCHBOARD_SUPERVISED bun test packages apps ops-kit     # 変数を継承すると selfdev の dry-run テストが落ちる
env -u SWITCHBOARD_SUPERVISED bun test <file> -t "<name>"
```

変更ごとのテストの型:

| 変更 | テスト |
|---|---|
| core の関数 / API | `packages/core/src/<name>.test.ts`。API は `startServer` を偽アダプタで起動して `fetch`（`core.test.ts` の型） |
| アダプタ | Git の外の録画 fixture の再生（`runner-adapter-recording` スキル）。自分のランナーで録画して Git の外に保存し、`bun scripts/fixtures.ts list` で配置を確認する |
| web の描画ロジック | `apps/web/src/*.test.ts`（DOM の型は `transcript.test.ts`。`bun:test` ファイルは web の typecheck から除外） |
| 単体で書けない UI / 経路 | 偽ランナーのデーモン（`startServer` を `mktemp -d /tmp/switchboard.e2e.XXXXXX` の `boot.ts` から、`SWITCHBOARD_HOME` は DB のコピー、ポートは `lsof` で空きを見て 47911 以上）+ `bun run --cwd apps/web build` + headless Chrome（`--remote-debugging-port`、CDP）。起動例は `.claude/skills/verify-live-ui/SKILL.md`。偽ランナーは `packages/core/src/devproxy.test.ts` の型 |
| 境界（プロキシ・認証・CORS） | 実構成の E2E（`devproxy.test.ts` の型） |

動いている Switchboard での確認（live check）は `verify-live-ui` スキル（デーモンと Web UI `localhost:5173`）。

## 作業の場所

- main の作業ツリーでは作業しない（利用者の `bun run dev` か release のデーモンがそこを見ている。`packages/core` を触るとセッションごと再起動する）。`git worktree add --detach ../switchboard-<topic> origin/main` → `bun install`。PBI を丸ごとなら `../switchboard-pbi<PBI>`
- 枝: `sb/<Task番号>-<topic>`。Task を積むときは `gh stack`（`stacked-pr-delivery`）
- 作業ファイル: `W=$(mktemp -d /tmp/switchboard.<用途>.XXXXXX)`。`/tmp` 直下に固定の名前で置かない（別のリポジトリのセッションとぶつかる）。`ops-kit/bin/deny-shared-tmp`（Claude Code の PreToolUse。Task にはデーモンが `--settings` で渡し（#773）、このリポジトリでは `.claude/settings.json` でも登録。Codex の Task は hook ではなく、`/tmp` を閉じたサンドボックスで止める（#787。Codex の Task は `W=$(mktemp -d)` で `$TMPDIR` の下に作る。`/tmp/…` は失敗する）。`docs/design/shared-tmp-guard.md`）が反するコマンドを止める。`/tmp` は RAM で、ホストの停止・作り直しと満杯の片付け（#1720）で消える。再開してから読むもの（Issue・PR 本文の下書き、レビューの材料）はすぐ投稿するか、消える前提で作り直せる形にする（#1988）

## Switchboard の Task と動いているコード

- `SWITCHBOARD_SUPERVISED=1` なら自分は Switchboard の Task（スキルの「エージェント管理アプリの Task」）
- 成果物の登録は返答の中の `switchboard-artifact` のフェンス（`docs/design/artifacts.md`）。画面イメージの問いに書く Task の id は環境変数 `SWITCHBOARD_TASK_ID`（`issue-workflow` の「画面イメージ」）
- マージ後の main の作業ツリーの更新は共通の `ops-kit pull-main`（`pbi-complete` の 6-6、`docs/design/main-pull.md`）。ただしデーモンが main の作業ツリーから `bun run dev` で動いている（`ps -eo args | grep -q '[s]cripts/dev.ts'`）なら、pull は `--watch` でデーモンを再起動するので、走らせる前に利用者の OK を取る（Task の会話で聞く。`issue-workflow` の「判断待ちの出し方」の運用の確認。Issue に書かない）。release（sb-rescue の `~/.switchboard/releases/<sha>`）で動いているなら pull では再起動しない
- 動いている Switchboard への反映（昇格）はデーモンを再起動するので、利用者の OK を取ってから（同じく Task の会話で聞く。Issue に書かない）

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
sqlite3 ~/.switchboard/switchboard.db "select * from quota"     # runner | window | utilization | resets_at(epoch s) | updated_at(ms)
date -r <resets_at>
```

Codex の `five_hour` が 0.9 以上、または `codex exec` が使用上限で止まったら、レビューは Claude のサブエージェントで代替する（`cross-runner-review` の 0）。

## マージ判定とローカル CI

- マージ判定: `bun scripts/merge-gate.ts <PR> [--allow-large]`（exit 0 = merge / 1 = stop / 2 = 判定不能。規則は `docs/design/merge-gate.md`）。スキルの `<マージ判定>`。large の理由のうち `[再チェック <kind>]` は、`docs/design/merge-gate.md` の「## 再チェック」（スキルの `<再チェック>`）を回して付ける印 `[recheck] <kind> pass <head sha>` で外れる。`[聞く]` は利用者が認めたとき（`--allow-large`）だけ
- ローカル CI: Actions が始まらない（ジョブのステップ 0 件）か run が無いときは `bun scripts/local-ci.ts <PR>` で Actions と同じ手順（`scripts/ci.ts`）を、最新の head を最新の base にマージして回す。結果は PR に付き（`[local-ci] pass|fail <head sha> base=<base sha>`）、merge-gate は今の head と base の組の最新が pass のときだけその CI の成功と数える（head か base が変わったら回し直す）。base の枝の保護が必須チェックを求めると BLOCKED で止まる（ローカルの結果では満たせない。確かめ方は `docs/design/merge-gate.md` の「保護枝とローカルの結果」）。スキルの `<ローカル CI>`
- `gh pr checks` が権限不足で 403 になるときは、`gh run list -R "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --commit <sha>` で見る

## 追加のレビュアー

`cross-runner-review` の `<extra>` は自分の環境で設定する。未設定なら追加レビュアーなしと報告する。

@private/CLAUDE.md

fork した人は所有者の値を `private/CLAUDE.md` に書くか、`private/CLAUDE.md` を省略する。
