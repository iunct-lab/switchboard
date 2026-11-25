---
name: stacked-pr-delivery
description: Task を Stacked PR（GitHub public preview, gh stack）として積み、レビューを頼み（`cross-runner-review`）、指摘に対応してコメント返信し、一番上の PR でスタックをまとめてマージするまでの手順とハマりどころ。PR を作る・積む・rebase する・マージするときに読む。
---

# Stacked PR delivery（gh stack）

> 流れ全体（Task の順番、レビュー、一番上でまとめてマージ、PBI を閉じる）は `pbi-complete`。1 Task の実装と PR 本文は `task-to-pr`。ここは gh stack の操作とハマりどころ。

前提: 1 Task = 1 branch = 1 PR（`issue-workflow` スキル）。worktree の場所と枝の名前は CLAUDE.md の規則（以下 `<枝>`）。

## 流れ

1. origin/main から worktree を作る（`git fetch -q origin && git worktree add --detach <場所> origin/main`。main の作業ツリーでは作業しない）。最初の枝: `git checkout -b <枝> && gh stack init <枝>`。
   上に積む: その枝にいる状態で `gh stack add <次の枝>`（新枝を作って積む）。
   **ローカルの変更では**（どの workspace かは `task-to-pr` の「ローカルの変更では」）: 積まない。1 枝ずつ `local-merge.ts` でマージしてから、次の枝を main から切る（`task-to-pr`）。
2. 実装 → テスト（1 件 / 型検査 / `<関係するテスト>`。`task-to-pr` の 4）→ commit（本文に Issue 番号と検証内容。`task-to-pr` の 5）。
<!-- when backlog=github -->
   `Closes #N` は Task の PR だけで、手順が残る PR は `Refs #N`。
<!-- end when -->
<!-- when backlog=app -->
   Task は GitHub の Issue ではなく、`#<番号>` は GitHub の同じ番号の別の Issue を閉じる・参照するので（GitHub 連携の無い workspace）、閉じるキーワードも `#<番号>` も書かず `Backlog-Task: <Task>` の 1 行にする。
<!-- end when -->
3. `gh stack submit --auto --open` で push + PR 作成（`--open` で最初から ready。無いと draft）。**テンプレは未記入**なので必ず
   `gh pr edit <n> --title ... --body ...`（PULL_REQUEST_TEMPLATE.md の項目を埋める）。draft のままなら `gh pr ready <n>`。
4. レビュー: PR ごとに `cross-runner-review`（主レビュアー）と、使うなら `review-with-subagent`（追加）。どちらもレビュアーは PR に書かず、自分が接頭辞つきで転記する。
   マージ判定の JSON の `attack` が空でない PR は、攻める側のレビュー（`cross-runner-review` の 2b）も、最後にまとめず、その PR を出した直後（主レビューを起動する同じ時点）に頼む。
5. 指摘対応: **指摘のある枝で**修正 → commit → `gh stack rebase`（スタック全体を下から rebase）→ `gh stack push`（`submit` と同じく全部の枝を atomic に push する。1 本でも断られたらどの枝も更新されない）。
   `review-triage-and-merge` の 4 の形で返信し（`gh api .../comments/<id>/replies`。見送る nit は要約の表）、最後に要約コメント。Issue にも結果を記録する（`ops-kit backlog comment <Task> --body-file …`）。
6. CI 緑・返信済みを確認して `<マージ判定> <一番上の PR番号> --merge-stack`（下の PR も今の head で判定し、全部 merge のときだけ `gh stack merge <PR番号> --rebase -y` を呼ぶ。`gh stack merge` はその PR と下の PR をまとめて atomic に merge する）。
   スタックに属さない単発 PR は `<マージ判定> <n> --merge`（`gh stack merge` は「not a stacked pull request」で失敗する）。
   判定の外で許可されたスタックの PR は `pbi-complete` の 5 の形で入れ、上の PR の付け替わりを `gh pr view <上> --json state,baseRefName` で見る（既定の枝でなければ下の「1 本だけ残ったスタック」）。
<!-- when mergeGate=off -->
   マージ判定のコマンド（CLAUDE.md）にその引数が無いリポジトリでは、`gh stack merge <PR番号> --rebase -y` / 単発は `gh pr merge <n> --rebase --delete-branch`。
<!-- end when -->
7. マージそのものは `pbi-complete` の 5 の手順（ローカル rebase は CONFLICTING のときだけ）。
   `gh stack rebase` が要るのは**マージ後にローカルの上の枝で作業を続ける（commit を足す）とき**だけ: 同期せずに commit を足すと
   古いハッシュの commit が残り、後で `gh stack merge` が「rebase conflict」で失敗する（実際に起きた）。触らない枝は rebase しない。

## ハマりどころ（全部この session で踏んだ）

- **下の枝を直したら上を必ず cascade**: `gh stack rebase` は全体を面倒みる。手でやるなら
  `git rebase --onto <new-lower> <old-lower-tip>` を上の枝ごとに。
- **base の PR がマージされずに閉じたスタックの rebase は確認を聞く**: base の枝が消えると GitHub はスタックを main に付け替え、`gh stack rebase` / `gh stack sync` はその上に rebase する。元の base がマージされていれば聞かずに進むが、マージされずに閉じていればその commit を落とすかを聞き、Task（対話の無い端末）では止まる。閉じた PR の中身を捨ててよいと確かめてから `--accept-base-change` を付ける（中身が要るなら先にその commit を上の枝へ移す）。
- **作業ファイルをリポジトリに置かない**: 調査用スクリプトはスクラッチパッドに。
- **コミットはパスを指定する**（`git add -A` を使わない）。コミットの前に `git diff --cached --name-only` を Task の触る場所と比べる。
- **枝を移る前に未コミットの変更を無くす**: `git checkout` / `gh stack switch` / `gh stack add` の前に `git status --porcelain` が空であること（途中の変更はその枝にコミットしてから移る）。1 つの worktree にスタック全体があるので、未コミットの変更は黙って次の枝に持ち越され、別の Task の PR に混ざる（`-q` だと持ち越しの表示も出ない）。
- **1 本だけ残ったスタック**: `gh stack merge` が「not a stacked pull request」になる。手で作った上の PR（`gh stack submit` を通していない）がその枝を base にしているなら、`--delete-branch` でマージしない — base の枝が消えた PR を GitHub は付け替えずに閉じる。先に上の枝を main に rebase して force push し、上の PR の base を main に替え（`gh api -X PATCH repos/<owner>/<repo>/pulls/<上> -f base=main`）、枝はその後で消す。上の PR はなるべく `gh stack submit` で作る。
- **中身が空になった枝**は GitHub が自動で merged 扱いにする。空の PR を残さない。
- main の作業ツリーでは利用者の開発サーバが動いていることがある（CLAUDE.md）。そこで `git checkout` で枝を変えるとそのサーバの中身も変わる。
  ファイル監視の再起動は追従するが、設定ファイル（例: `vite.config.ts`）を短時間に何度も書き換えると再起動が固まる。

## PR 説明に書くこと

テンプレの「概要 / 影響コンポーネント / テスト観点 / チェックリスト」を埋める。テスト観点には
**実際に実行したもの**（テスト数、実ランナー・実ブラウザで見た事実）だけを書く。やっていないことに [x] を付けない。

## コミット・PR の帰属

commit の末尾と PR 本文の末尾の帰属の行は、そのときランナーが受けている指示（帰属の行の指定）に従う。無ければ書かない（ランナーごとの行をここに並べない）。
