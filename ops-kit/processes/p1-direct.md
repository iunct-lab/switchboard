---
id: p1-direct
version: 1
title: 直行型（信号から変更まで 1 エージェント、計画の成果物なし）
fits:
  - 課題も解も明確で、作用が可逆な小さな修正
  - 計画の成果物（PBI・Task の本文）を書く手間が、変更そのものより大きい仕事
  - 記録はデーモンの由来の記録（provenance）とイベントで足りる仕事
auto: { maxBodyChars: 600, excludeLabels: [needs-decision, on-hold, flow-improvement] }
---

# p1-direct — 直行型

1 つのエージェントが、信号（要望・不具合の報告・観察）を読み、worktree で最小の変更と等級に応じたテストを作り、PR を出すところまでを通す。計画の成果物（PBI・Task の本文、決定ログ）は書かない。何を読んで何を変えたかは、キットの親のアプリが Task に付ける由来の記録とイベントが持つ。

アプリでは、Backlog 画面の要望の行（派生 PBI の無い要望）の「直行で直す」でこの入口の Task が始まる（信号は要望の番号）。選ぶのは利用者のボタンと、バックログの自動処理（上の frontmatter の `auto` の基準）。ボタンが優先で、自動処理はボタンで始めた要望には動かない。どちらで始めたかは Task の由来の `processReason`（`direct button` / `auto direct: …`）に残る。2026-11-03 はボタンだけだったのを、2026-11-08 に自動処理も選ぶ形に変えた。直行は小さくない・明確でないと分かれば変更を作らず戻す（下の入口。戻った要望は `direct-returned` が付き、自動処理は p0-pipeline で始める）。

穴: `{{signal}}` = 読む信号（Issue の番号か、信号の文そのもの）。

## entry direct

次の信号を読み、それが求める最小の変更を 1 本の PR にしてください: {{signal}}

- main の作業ツリーでは作業しない。`git worktree add --detach ../<リポジトリ名>-<topic> origin/main` で worktree を作り、枝は `sb/direct-<topic>`
- 触る前に、その信号が不変条件（`ops-kit/invariants.md`）に触れるか確かめる。触れるなら次の行のとおり戻す（止まるだけにしない。`direct-returned` が無いと要望は自動処理から外れたまま残る）
- 読んだ結果、小さくない・明確でない・不変条件に触れる、のどれかだと分かったら、変更を作らず戻す: `ops-kit backlog edit <要望> --add-label direct-returned` を付け、要望に `直行から戻す: <理由>` をコメントして（`ops-kit backlog comment <要望> --body-file -`）止まる。PBI にするのは p0-pipeline の役で、ここでは作らない
- 変更は、信号が求めることだけ。ついでの整形・改名・リファクタをしない
- テストは変更の等級に応じて: 関数なら単体テスト、API なら偽の依存で起動して `fetch`。テストの無い PR は出さない。型検査と関係するテストのコマンドはリポジトリの CLAUDE.md
- PBI・Task Issue は作らない。PR の本文に、読んだ信号・変えたこと・走らせたテスト・変えなかったことを書く。Issue・決定ログ・Project のフィールドは書かない（この型では作らない）。例外は要望 Issue への書き込みだけ（戻す印とコメントは上、閉じるのは下）: 信号が要望 Issue なら、PR を出したらその要望に `直行: PR #<番号>` の 1 行をコメントする（`ops-kit backlog comment <要望> --body-file -`）
- PR を出したあとも、終わるまで通す: `.claude/skills/cross-runner-review/SKILL.md` で別のランナーにレビューさせ、`.claude/skills/review-triage-and-merge/SKILL.md` で指摘を処理し、`bun scripts/merge-gate.ts <PR> --merge` でマージ判定とマージをする。判定が merge でなければマージせず、止まって理由を返答に書く。マージしたら、信号が要望 Issue なら `ops-kit backlog edit <要望> --state closed` で閉じる
- 返答に、PR の番号と、信号のうち扱わなかった部分があればそれを書く
