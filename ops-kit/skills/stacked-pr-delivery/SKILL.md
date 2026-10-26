---
name: stacked-pr-delivery
description: Task を Stacked PR（GitHub public preview, gh stack）として積み、サブエージェントにレビューさせ、指摘に対応してコメント返信し、下から順にマージするまでの手順とハマりどころ。PR を作る・積む・rebase する・マージするときに読む。
---

# Stacked PR delivery（gh stack）

> 流れ全体（Task の順番、レビュー、下から 1 本ずつのマージ、PBI を閉じる）は `pbi-complete`。1 Task の実装と PR 本文は `task-to-pr`。ここは gh stack の操作とハマりどころ。

前提: 1 Task = 1 branch = 1 PR（`issue-workflow` スキル）。worktree の場所と枝の名前は CLAUDE.md の規則（以下 `<枝>`）。

## 流れ

1. origin/main から worktree を作る（`git fetch -q origin && git worktree add --detach <場所> origin/main`。main の作業ツリーでは作業しない）。最初の枝: `git checkout -b <枝> && gh stack init <枝>`。
   上に積む: その枝にいる状態で `gh stack add <次の枝>`（新枝を作って積む）。
2. 実装 → テスト（CLAUDE.md のテストのコマンド）→ commit（本文に Issue 番号と検証内容。`Closes #N` は Task の PR だけ。`BACKLOG_WORKSPACE` がある（GitHub 連携の無い workspace。Task は GitHub の Issue ではなく、`#<番号>` は GitHub の同じ番号の別の Issue を閉じる・参照する）なら、閉じるキーワードも `#<番号>` も書かず `Backlog-Task: <Task>` の 1 行にする）。
3. `gh stack submit --auto --open` で push + PR 作成（`--open` で最初から ready。無いと draft）。**テンプレは未記入**なので必ず
   `gh pr edit <n> --title ... --body ...`（PULL_REQUEST_TEMPLATE.md の項目を埋める）。draft のままなら `gh pr ready <n>`。
4. レビュー: `review-with-subagent` スキルの手順で、PR ごとにサブエージェントを起動しコメントさせる。
5. 指摘対応: **指摘のある枝で**修正 → commit → `gh stack rebase`（スタック全体を下から rebase）→ `gh stack push`。
   各指摘コメントに個別返信（`gh api .../comments/<id>/replies`）し、最後に要約コメント。Issue にも結果を記録する。
6. CI 緑・返信済みを確認して `gh stack merge <PR番号> --rebase -y`（その PR と下の PR をまとめて atomic に merge）。
   スタックに属さない単発 PR は `gh pr merge <n> --rebase --delete-branch`（`gh stack merge` は「not a stacked pull request」で失敗する）。
7. マージそのものは `pbi-complete` の手順（下から 1 本ずつ、GitHub 側の retarget + rebase を待つ。ローカル rebase は CONFLICTING のときだけ）。
   `gh stack rebase` が要るのは**マージ後にローカルの上の枝で作業を続ける（commit を足す）とき**だけ: 同期せずに commit を足すと
   古いハッシュの commit が残り、後で `gh stack merge` が「rebase conflict」で失敗する（実際に起きた）。触らない枝は rebase しない。

## ハマりどころ（全部この session で踏んだ）

- **下の枝を直したら上を必ず cascade**: `gh stack rebase` は全体を面倒みる。手でやるなら
  `git rebase --onto <new-lower> <old-lower-tip>` を上の枝ごとに。
- **`gh stack rebase` が古い commit を復活させることがある**: マージ済み枝の再生で、削除したはずの調査用ファイルが
  main に戻った（追加 → 削除 → 再追加）。別の枝で消しても main には残ったままで、
  レビューで指摘されるまで気づかなかった（別の PR で再削除）。マージ後は `git ls-tree --name-only origin/main | grep -i <消したもの>` で確認。
- **作業ファイルをリポジトリに置かない**: 調査用スクリプトはスクラッチパッドに。`git add -A` の前に `git status --short` を読む。
- **中身が空になった枝**は GitHub が自動で merged 扱いにする。空の PR を残さない。
- main の作業ツリーでは利用者の開発サーバが動いていることがある（CLAUDE.md）。そこで `git checkout` で枝を変えるとそのサーバの中身も変わる。
  ファイル監視の再起動は追従するが、設定ファイル（例: `vite.config.ts`）を短時間に何度も書き換えると再起動が固まる。

## PR 説明に書くこと

テンプレの「概要 / 影響コンポーネント / テスト観点 / チェックリスト」を埋める。テスト観点には
**実際に実行したもの**（テスト数、実ランナー・実ブラウザで見た事実）だけを書く。やっていないことに [x] を付けない。
末尾に `🤖 Generated with [Claude Code](https://claude.com/claude-code)` と session URL。

## コミット・PR の帰属

commit 末尾: `Co-Authored-By:` と `Claude-Session:`（その時点の指示に従う）。
