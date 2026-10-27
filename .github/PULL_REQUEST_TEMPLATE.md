<!-- タイトルは Conventional Commits 風に: feat:/fix:/test:/docs:/chore: など -->

## 概要 / Summary

<!-- 1 PR = 1 Task。`Closes #<Task番号>` を書く（PBI/Epic を直接 Closes しない）。Task の Issue に結果コメントを残す（.claude/skills/issue-workflow） -->

<!-- 何を、なぜ変えたか。関連Issueがあれば `Closes #123` -->

## 影響コンポーネント / Affected components

- [ ] packages/protocol（AgentEvent / RPC — 変更は互換性に注意）
- [ ] packages/core
- [ ] packages/adapters/claude · codex · dak
- [ ] apps/web
- [ ] docs / infra (.github, scripts)

## テスト観点 / Testing

- [ ] `bun test` が green（アダプタ変更は録画 fixture を更新・追加した）
- [ ] `bun run typecheck` が green
- [ ] 実ランナーで手動確認した（該当時。使ったランナーとモデルを書く）

## チェックリスト / Checklist

- [ ] 承認を迂回する既定値を足していない（System ENABLES, Agent DECIDES, User APPROVES）
- [ ] ベンダ CLI のコード・プロトコル定義・バイナリを取り込んでいない（ライセンス境界）
- [ ] どのランナーが無くても core が起動する
- [ ] docs（README, docs/design）を必要に応じ更新した
