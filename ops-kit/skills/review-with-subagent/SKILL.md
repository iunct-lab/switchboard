---
name: review-with-subagent
description: PR ごとにサブエージェントへ敵対的コードレビューをさせ、結果をファイルで受け取って自分が `[subagent]` の接頭辞つきで PR に転記し、指摘を採否判断して修正し、各コメントに返信するまでの型。PR を出した直後と、レビュー指摘に対応するときに読む。
---

# Review with a subagent

> レビュアーの選び方（主レビュアー、フラットな文脈）は `cross-runner-review`、指摘の採否とマージ判断は `review-triage-and-merge`、PBI 単位の流れは `pbi-complete`。
> このスキルは Claude のサブエージェントを**追加の**レビュアーとして使うときの型（Codex が実装したときの Claude 側は `cross-runner-review` の `claude -p`）。

## 起動

`Agent`（general-purpose, background）に以下を渡す。**diff を読むだけでなく、主張を再現させる**。

プロンプトの骨子:
```
Adversarially review PR #N in <owner/name> (branch <b>, base main). Read the PR ONLY via `gh pr diff N` and
`gh api repos/<owner/name>/contents/<path>?ref=<b>` — the local checkout may be on another branch while you
work (other processes may run from it). Read surrounding code the same way — don't skim.
Focus: <この PR で危ういところを 3〜6 点、具体的に>.
Find concrete bugs with a failure scenario (input/state → wrong output). Reproduce claims where possible.
Write the review to <出力のパス> in the output format of the cross-runner-review skill, section 1 (`### Findings` lines
`- [blocker|should-fix|nit|question] <path>:<line> — <finding>`, then the other sections). Write nothing else:
do not post to the PR (no comment, no review) and do not modify files of the repository.
<`ops-kit review-note rules` の出力をここに貼る（主レビューと同じ重さの定義）>
```

## 転記

レビュアーは PR に書かない。出力のファイルを自分が読み、`cross-runner-review` の 3 の `post_review <PR> subagent <出力のパス>` で転記する（接頭辞は `[subagent]`）。マージ判定が数えるのはレビューの仕事の記録だけで、`[subagent]` の転記は人が読む追加の指摘（判定には数えられない）。`### Findings` の無い出力は転記しない。

## 採否・返信・修正後

主レビューの指摘と同じく `review-triage-and-merge` の 1〜4 で処理する（一覧の読み方と review 本文、振り分け、修正と回帰テスト、1 コメント 1 返信、要約）。対応内容は **Issue の結果コメント**にも残す（`ops-kit backlog comment <Task> --body-file …`。同じスキルの 6）。
回帰テストが修正前で fail することは、`git stash push <file>` → test → `git stash pop` で一度見られる。
