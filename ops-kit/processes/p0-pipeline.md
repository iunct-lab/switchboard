---
id: p0-pipeline
version: 1
title: 工程型（要望 → PBI → Task → PR → 独立レビュー → ゲート → マージ）
fits:
  - 課題も解も明確で、確実さが要る修正
  - 公開前の検査、他リポジトリに作用する変更
  - 受け入れ条件を 1 行ずつ検証した記録を残したい仕事
---

# p0-pipeline — 現行の工程

キットの親のアプリがこれまで回してきた工程を、候補の 1 つとして定義したもの。工程の中身はスキル（`ops-kit/skills/`）が持ち、ここにあるのは工程の Task に渡す**入口の文**だけ。キットの親のアプリは `## entry <name>` の節を読み、`{{n}}` などの穴を埋めて Task の最初のプロンプトにする（`packages/core/src/process-defs.ts` の `renderEntry`）。

穴: `{{n}}` = Issue の番号、`{{subIssues}}` = sub-issue の数、`{{reportFormat}}` = `## 状況` コメントの形、`{{tasksDoneMark}}` = 閉じた Task の数の印。

## entry to-pbi

.claude/skills/request-to-backlog/SKILL.md に従い、既存の要望 Issue #{{n}} から PBI を作ってください（要望 Issue は新しく作らない。#{{n}} の原文を正本にする）。続けて .claude/skills/pbi-to-tasks/SKILL.md で、作った PBI を Ready にしてください。

## entry to-tasks

.claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #{{n}} を Task に分解して Ready にしてください。

## entry to-tasks-ready

PBI #{{n}} は Task（sub-issue {{subIssues}} 件）に分解済みですが、Project の Status が Ready になっていません。.claude/skills/pbi-to-tasks/SKILL.md に従い、既にある Task を作り直さずに、最新の `## 回答` を PBI と Task に反映し、受け入れ条件の被覆と Task の粒度を確かめ、足りなければ Task を足して、PBI #{{n}} を Ready にしてください。

## entry complete

/pbi-complete {{n}}

## entry complete-other

.claude/skills/pbi-complete/SKILL.md に従い、PBI #{{n}} を完了させてください。

## entry complete-resume

PBI #{{n}} は実装中のまま止まっています。sub-issue の Task（状態・PR）、関連する PR、受け入れ条件を確かめ、Issue #{{n}} に {{reportFormat}}その末尾に `{{tasksDoneMark}}` を 1 行そのまま入れてください（この PBI を選んだ時点の閉じた Task の数。数え直さない。次に Task が閉じるか `## 回答` が付くまで、定期実行がこの PBI を再開しないための印です）。利用者の判断が要るもの（要件の読み・設計の選択・受け入れ条件の利用者確認など）があれば、.claude/skills/issue-workflow/SKILL.md の「判断待ちの出し方」で `## 判断待ち` を出して止めてください。無ければ続けて .claude/skills/pbi-complete/SKILL.md に従い、PBI #{{n}} を完了させてください。

## entry check

PBI #{{n}} の今の状況を確認してください。sub-issue の Task（状態・PR）、関連する PR（`gh pr list -R <このリポジトリの owner/name> --state all --search "#{{n}}"` と各 Task の PR。状態・レビュー・CI）、PBI の受け入れ条件（それぞれ満たされているか、検証の結果）、決定ログ・コメントを読み、Issue #{{n}} に {{reportFormat}}利用者の判断が要るもの（受け入れ条件の利用者確認など）があれば、.claude/skills/issue-workflow/SKILL.md の「判断待ちの出し方」で `## 判断待ち` を出してください。コードの変更・PR の作成やマージ・Issue のクローズ・Project の Status の変更はしないでください。これまでの `## 回答` は状況の材料として読むだけにし、その続きの作業はしないでください。

## entry close

.claude/skills/pbi-complete/SKILL.md の「6. PBI を閉じる」に従い、PBI #{{n}} の受け入れ条件を検証結果つきで埋め、## 結果 を書いて閉じてください（Task は全部閉じています。利用者確認の項目や判断待ちが残っていれば、同じ節の 4 のとおり閉じずに In review のまま残し、残った項目を報告してください）。
