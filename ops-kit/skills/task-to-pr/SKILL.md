---
name: task-to-pr
description: Task Issue 1 件を最小の実装で 1 本の PR にする型。着手の記録、worktree と枝、Task に書いた場所だけを触る規律、テスト（単体で書けなければ偽の依存 + headless ブラウザの E2E）、レビュアーの負荷を下げる PR 本文。Task に着手するとき、PR を出す直前、「ついでに」直したくなったときに読む。前は pbi-to-tasks、次は cross-runner-review。
---

# Task → PR（1 Task = 1 PR、最小の差分）

目的: レビュアーが**PR 本文を読めば差分を読む前に判断できる**PR を出す。差分は Task の手順に書いた場所だけ。テストの無い PR は出さない。

## 手順

### 1. 読む・記録する

1. `gh issue view <Task>` と親 PBI（`## 親 PBI`）、PBI の `## 元要望`、Task が指す `docs/design/*.md`。「満たす受け入れ条件」を控える
2. Task の手順に「利用者に確認して止める」があるか。あるなら、その工程の直前で `issue-workflow` の「判断待ちの出し方」で問いの種類を分けて**止める**: 実装の判断（要件の読み・設計の選択）は `## 判断待ち`（ラベル `needs-decision`）、運用の確認（マージ・昇格・デプロイ・認証など利用者がその場でする操作、実行のタイミング）は Issue に書かず、Task の会話に問い・選択肢・推奨を書いてターンを終える（返事は同じ会話で来る）。実装の判断に headless（エージェント管理アプリの Task など）で返事が来ないときの扱いは種類で分ける:
   - **要件の解釈**（どちらの読みで作るか）: 実装しない。その Task を In progress のまま止め、他の Task に進む。勝手に一方の解釈で作らない
   - **お金 / 他 OS / 破壊的操作**: 安全側（何も消費しない、既定 off、消さない）だけ実装して進む。問いの `## 判断待ち`（ラベル `needs-decision`）は出したまま残す（利用者が判断待ちの一覧で見つけられるように）
3. 着手コメント（3 行: ブランチ / 進め方 / 想定する検証）→ `bash scripts/setup/set_project_field.sh <Task> Status "In progress"`
4. 他のセッションと同じファイルを触らないか（並列ガードのコマンドが CLAUDE.md にあるとき。以下 `<guard>`）: 着手コメントの前に `<guard> overlap <Task>`、In progress にした後に `--claimed` を付けてもう一度。exit 1 / 2 なら着手せず（In progress にしていたら Backlog に戻し）、重なった相手とパスを Task にコメントして別の Task に進む（`pbi-complete` の「並列で動かす」）

### 2. 場所を作る

**main の作業ツリーでは作業しない**（利用者の開発サーバやエージェント管理アプリがそこから動いていることがあり、触ると自分のセッションごと再起動しうる。自分がそのアプリの Task かどうかの見分け方は CLAUDE.md）。
worktree の場所・枝の名前・依存の導入は CLAUDE.md の worktree と枝の規則（以下 `<場所>` / `<枝>`。枝は Task ごとに 1 本）。

```bash
git fetch -q origin
git worktree add --detach <場所> origin/main && cd <場所>          # 依存の導入も CLAUDE.md の手順で
git checkout -b <枝> && gh stack init <枝>     # 最初の枝（単発でも init する）
# 既にスタックがあり、その上に積むなら: 下の枝にいる状態で  gh stack add <枝>
```

### 3. 実装の規律

- **Task の手順に書いたファイルと名前で作る。** 増やす必要が出たら、まず Issue にコメント（なぜ）してから増やす
- **ついでの整形・改名・リファクタをしない。** 気づいたことは Issue コメントか新しい Task に
- **互換層・フラグ・一度しか使わない抽象を足さない**（`pbi-to-tasks` の設計チェック。実装中に必要に見えたら、たいてい設計に戻る印）
- **既存の型を守る**: 部品のあいだで共有する型を変えるなら、それを読む全員を同じ PR で直す。互換のための optional は足さない
- 差分の目安 500 行（テスト込み）。超えるなら Task を割って Issue に書く
- 秘密・絶対パス・ユーザー名を fixture / docs に入れない（`/Users/dev` に洗う）。Issue・PR・コメントにも認証に使える値を書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。作業ファイルはスクラッチに置き、`git status --short` を読んでから `git add`。作業ファイルは `/tmp` 直下に固定の名前で置かない（別セッションと固定名を共有すると、作業ファイルが上書き・削除される）。作業ごとに `W=$(mktemp -d /tmp/<リポジトリ名>.<用途>.XXXXXX)` で自分だけのディレクトリを作り、表示されたパスをそのまま使う（Bash の呼び出しをまたぐとシェル変数は消えるので、パスは文字で控える）。消すときもそのパスだけ（glob で消さない）。`/tmp` はホストの停止や片付けで消えうる。再開してから読むもの（PR 本文の下書きなど）はすぐ投稿するか、消える前提で作り直せる形にする。CLAUDE.md が求めるなら、`gh` の書き込み（issue / pr の作成・コメント・編集・マージ・クローズ）には `-R <owner/name>` を付ける。`-R` を取れない `gh stack` は、作業しているリポジトリの worktree の中でだけ実行する（レビュー用の clone や別リポジトリのディレクトリから実行しない）

### 4. テスト（必ず）

順番: **失敗するテストを先に書く**（`git stash push <impl>` → test → fail を見る → `git stash pop`）→ 実装 → pass。

テストのコマンド（型検査 / 全体 / 追加した 1 件）は CLAUDE.md。全部通ることを見る。

何をどう試すか（変更の種類ごとのテストの型は CLAUDE.md。無ければ既存の同型のテストに合わせる）:

| 変更 | テスト |
|---|---|
| 関数 / API | 単体テスト。API は偽の依存でサーバーを起動して `fetch` する型 |
| 外部のランナーや CLI をつなぐ部分 | 録画した出力（fixture）の再生。実物は fixture を録るときだけ |
| 画面の描画ロジック | 描画ロジックの単体テスト |
| **単体で書けない UI / 経路** | **E2E**: 偽の依存でサーバーを起動し（作業ディレクトリは `mktemp -d`、データはコピー、ポートは空きを確かめる）、headless ブラウザで操作する。**操作と期待結果と実際の出力**を PR 本文と結果コメントに貼る |
| 境界（プロキシ・認証・CORS） | 実構成の E2E を足す |

「テストを書けない」は PR を出さない理由であって、テスト無しで出す理由ではない。E2E も無理なら Task を止めて Issue に書く。
動いている実物での確認（DoD の「実構成で確認」）は CLAUDE.md の live check の方法で行い、見た事実を PR 本文に書く。

### 5. commit と PR

```bash
git add <files> && git commit      # 題: feat(core): … (#Task) / fix(web): … / docs: … / test: …  本文: 何を・なぜ・検証したこと。Task の PR だけ Closes #N
gh stack submit --auto --open      # push + PR。draft なら gh pr ready <n>
W=$(mktemp -d /tmp/<リポジトリ名>.pr<Task>.XXXXXX); echo "$W"     # 本文は "$W/pr.md" に書く（固定の /tmp/pr.md は別リポジトリの PR 本文と入れ替わりうる）
gh pr edit <n> --title "<題>" --body-file "$W/pr.md"
bash scripts/setup/set_project_field.sh <Task> Status "In review"
gh issue comment <Task> --body "PR: #<n>（<1 行>）"
```

PR 本文は `.github/PULL_REQUEST_TEMPLATE.md` の 4 節を埋め、**その上に「レビュアーへ」を置く**:

```markdown
## レビュアーへ
- 読む順番: 1. `path`（何が変わったか） 2. `path` 3. テスト
- 判断点: <レビュアーに見てほしい設計上の判断 1〜3 点。なぜそうしたか>
- 変えなかったこと: <触りたくなるが Task の外、または意図して残したもの>
- 検証: <実行したコマンドと結果。E2E なら操作と出力>

## 概要 / Summary
Closes #<Task>。<何を・なぜ。親 PBI #N の受け入れ条件 n, m>
## 影響コンポーネント / Affected components   （該当に [x]）
## テスト観点 / Testing                        （**実際に走らせたものだけ** [x]。テスト数、E2E の事実）
## チェックリスト / Checklist
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

commit 末尾に `Co-Authored-By:`（その時点の指示に従う）。

### 6. 次

`cross-runner-review`（別ランナー + 追加のレビュアーのレビュー）→ `review-triage-and-merge`。スタックの上に次の Task を積むなら、この枝から `gh stack add`。

## 報告（利用者への返事の型）

```
#<Task> → PR #<n>（<枝>、+<add>/-<del>、テスト <k> 件追加）
検証: <走らせたもの / E2E の要点>
Task の外に出た点: <無ければ「なし」>
次: cross-runner-review
```

## やらないこと

- テストなしの PR。「あとでテストを足す」PR
- 1 PR で 2 Task を閉じる（分解が粗かったなら PBI の決定ログに書き、PR は分ける）
- main の作業ツリーで `git checkout` / 編集
- PR 本文の [x] を、やっていないのに付ける
