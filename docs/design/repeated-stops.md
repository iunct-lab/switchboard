# 繰り返す停止（#939）

同じ理由での再停止に気づき、進展のない再試行と再指示を減らす。実装は #947〜#952。

## 系列と記録

- 停止は `stop.record` イベントで task の events に残る（新しいテーブルは作らない。再起動で回数を忘れない）。型は `packages/protocol/src/events.ts` の `StopRecord`
- 系列キー（`stopKey`）= 同じ作業（Issue があれば workspace + 番号、無ければ task）・操作・対象・理由コード。文面は数えない（`unknown` だけ根拠で分ける）。似た文面でも理由コードが違えば別の系列で、`cause` の変化として出る
- 要約（`reduceStops` → `StopSummary`）: 回数、前回の回答、前回からの変化（`cause` / `answer` / `condition-met` / `condition`）、次の対処（`none` / `resume` / `wait` / `retry` / `decide`）、実施済みの対処
- 回答に数えるのは利用者が回答したと daemon が見たもの（`seq:<n>`）だけ。ランナーが名指しした Issue コメントの URL は参照でしかなく、コメントを読んで作業のリポジトリと書き手を確かめる仕組みができるまで回答に数えない（#948 のレビュー）

## 構造化報告

ランナーは止まったとき、Workspace MCP の `task.note` の `stop`、または返答の `switchboard-stop` フェンスで報告する。起動のたびに共通の指示（`stopRecoveryPrompt`）が付き、アダプタごとの分岐はない。報告が無い停止は `unknown` として扱い、自動復旧を装わない。

同じ前置きは、依頼の範囲外の書き込み（計画モードでの commit・push・マージ、聞かずに昇格、依頼に無い Issue を閉じる）をせず、要るなら判断待ちで聞くとも言う。2026-10-19 の週報で、計画モードや「調べて」の依頼から commit・push・マージ・Issue のクローズまで進んだ Task が週に 3 件あったため。コードで書き込みを止める仕組みは作らず、まず前置きの 1 文で減るかを次の週報で見る。

## 有限再試行（#949）

- 対象: 一時障害（通信の切断・タイムアウト・HTTP 502/503/504）で、読み取り専用か「何かする前に失敗した」と確かめられる操作だけ
- 追加 2 回（5 秒後・30 秒後）。固定値で設定にはしない。使い切ったら `exhausted` を 1 つの判断項目にし、したことを一覧にする
- 再実行は**ランナー自身**が自分のツールで行う。daemon は任意のコマンドを再実行しない（Workspace MCP の `exec.run` は自分で再試行する）。再実行も元の許可・承認経路を通り、過去の回答で新しい操作を承認しない
- 認証・権限・入力のエラー、何かしたか分からない操作（`safety: unknown`）は再試行しない
- 範囲外: 認証の自動更新、権限拡大、変化のない無制限の再試行

## 再開の選択（#950）

`packages/core/src/backlog.ts` の `stopHeld`。最後の工程 Task の最新の停止系列が `waiting` / `exhausted` で、前回から原因・回答・条件成立のどれも無く、再停止（2 回目〜）・再試行切れ・未成立の条件のいずれかなら、Issue の無関係な更新（ラベル・別コメント）だけでは backlog-next が再選択しない（`unchangedIn` に載る）。

外れるもの（一度だけ選ばれる）: Issue の `## 回答`（`isAnswered`）、待ちの解除（`isUnblocked`）、別の原因（新しい系列）、利用者の回答、条件の成立（行の waits / prereqs が met）。条件が複数あれば、全部成立するまで外れない。未成立の条件の値が動くだけでは外れない。

## 判断項目と画面

- 判断項目（#935 の受信箱）は系列キーで 1 項目（`asks.ts` の `stopAsk`）。同じ条件なら問いを作り直さず、別原因は別項目。未決の承認 ID は保ち、自動で allow / deny しない
- 画面: バックログの行と Task 画面（`apps/web/src/components/Stops.tsx`）。回数・前回の回答・変化・次の対処・実施済みの再試行。待ちは「条件の変化待ち・操作不要」、判断が要るものは先に開いて出す。値が無ければ「不明」

## 他の PBI との境界

| 範囲 | 持ち主 |
|---|---|
| GitHub の API 上限の回復と再開 | #550（`rate-limit-resume.md`、`github-api-budget.md`） |
| 停止した PBI 全般の再開 | #578（`backlog.md` の定期実行） |
| 依存・前提の解除条件 | #937（`backlog.md` の前提） |
| 判断項目の置き場 | #935（`asks.md`） |
| 回答の方針（許可の自動化） | #938（ここでは作らない） |

## 検証

```bash
env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/stops.test.ts packages/core/src/backlog.test.ts packages/core/src/core.test.ts apps/web/src/stops.test.ts
bun run --cwd apps/web build && env -u SWITCHBOARD_SUPERVISED bun scripts/stops-e2e.ts   # 偽ランナーの daemon + headless Chrome（1280 / 390）。実ランナーの枠は使わない
```
