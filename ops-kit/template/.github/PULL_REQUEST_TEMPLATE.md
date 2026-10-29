<!-- タイトルは Conventional Commits 風に: feat:/fix:/test:/docs:/chore: など -->

## 概要 / Summary

<!-- 1 PR = 1 Task。`Closes #<Task番号>` を書く（PBI を直接 Closes しない）。Task の Issue に結果コメントを残す（.claude/skills/issue-workflow） -->

<!-- 何を、なぜ変えたか。関連Issueがあれば `Closes #123` -->

## 影響コンポーネント / Affected components

- [ ] __AREA__
- [ ] 文書 (docs/)
- [ ] 文書 / infra (.github, scripts)

## テスト観点 / Testing

- [ ] CI（`__TEST_ALL__`）が green
- [ ] 画面や動いている実物を変えたら実物で確認した。やった事実だけ書く

## チェックリスト / Checklist

- [ ] 秘密（認証に使える値・Cookie・鍵）をログ・レスポンス・リポジトリに出していない
- [ ] 個人情報・実名をコミットしていない
- [ ] 既存データの読取互換性（保存形式）を壊していない

<!-- 文書更新の確認欄は Task が doc のファイルと書く中身を名指ししたときだけ加える。運用だけの Task には加えない。アプリが持つ可変の値は写さない。 -->
