---
name: review-with-subagent
description: PR ごとにサブエージェントへ敵対的コードレビューをさせ、PR にインラインコメントを投稿させ、指摘を採否判断して修正し、各コメントに返信するまでの型。PR を出した直後と、レビュー指摘に対応するときに読む。
---

# Review with a subagent

> レビュアーの選び方（別ランナー + 追加のレビュアー、フラットな文脈）は `cross-runner-review`、指摘の採否とマージ判断は `review-triage-and-merge`、PBI 単位の流れは `pbi-complete`。
> このスキルは Claude のサブエージェントを**追加の**レビュアーとして使うときの型（Codex が実装したときの Claude 側は `cross-runner-review` の `claude -p`）。

## 起動

`Agent`（general-purpose, background）に以下を渡す。**diff を読むだけでなく、主張を再現させる**のが効く
（レビュアーがランタイムの挙動をローカルで再現して裏取りしたことも、「修正の層が違う」と正しく指摘したこともある）。

プロンプトの骨子:
```
Adversarially review PR #N in <owner/name> (branch <b>, base main). Read the PR ONLY via `gh pr diff N` and
`gh api repos/<owner/name>/contents/<path>?ref=<b>` — the local checkout may be on another branch while you
work (other processes may run from it). Read surrounding code the same way — don't skim.
Focus: <この PR で危ういところを 3〜6 点、具体的に>.
Find concrete bugs with a failure scenario (input/state → wrong output). Reproduce claims where possible.
Post each finding as an inline comment via `gh api repos/<owner/name>/pulls/N/comments`
(-f path -F line -f side=RIGHT -f commit_id=$(gh pr view N --json headRefOid -q .headRefOid) -f body),
tagged [blocker]/[should-fix]/[nit]/[question]. Then one summary via `gh pr comment -R <owner/name> N`. Do not modify files.
```

## 採否

- blocker / should-fix: 直す。直さないなら理由を返信に書く。
- nit: 同じ修正コミットに入る 1 行程度だけ直す。ほかは対処不要か記録（`review-triage-and-merge` の 3）。
- question: 事実で答える。「分からない」なら調べてから答える（相手側のソースを読んで答えたこともある）。
- **レビュアーが正しくて自分の修正が間違いのこともある**（サーバー側を緩めた最初の修正は、却下するのが正解だったことがある）。
  自分の変更を守らず、より小さく安全な修正があればそちらに切り替える。

## 返信

```bash
gh api repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies -f body="..."
gh pr comment <N> --body "..."   # 要約: 何件を何にどう対応したか、テスト数
```
コメント ID 一覧: `gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate | jq '.[] | {id, path, body: .body[0:80]}'`。
review 本文（インラインでない指摘）も `gh api .../pulls/<N>/reviews` で読む。見落としやすい。

対応内容は PR 返信だけでなく **Issue の結果コメント**にも要約を残す（`issue-workflow`）。

## 修正後

修正は指摘のある枝に commit → `gh stack rebase` → `gh stack push`（`stacked-pr-delivery`）。
新しい回帰テストは「修正前で fail することを一度確認」する（`git stash push <file>` → test → `git stash pop`）。
