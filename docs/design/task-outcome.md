# task-outcome（止まった Task の「結果」と「確認済み」）

止まった Task のうち、自分の判断や返信が要るものと、見て終わりでよいものを一覧で見分け、見終わったものを一覧から片づける（PBI #492、元要望 #490）。結果が完了のものは要対応の一覧に入れず、Home の「最近」に置く（すぐ直す、PR #836）。
ランナーの状態（`status`: `idle / running / waiting / done / error / aborted`）はそのまま残し、利用者のための「結果」と「確認済み」を別に持つ。`done` はターンが正常に終わったことしか表さず、作業を終えた場合も、文章で判断を求めて止まった場合も同じ `done` になるため。

## 結果（`Task.outcome`）

| 値 | 表示 | 意味 |
|---|---|---|
| `needs_action` | 要対応 | 利用者を待っている（承認・質問、または利用者が要対応に直した） |
| `failed` | 失敗 | error / aborted で止まった |
| `done` | 完了 | 終わっていて、することは無い |
| `unknown` | 未判定 | まだ判定していない（新しいターンの始まり、既存の Task） |

保存は tasks の列 `outcome`（既定 `unknown`）。値は既存の `task.updated` にそのまま乗る。

## 状態遷移（#1140）

status が動ける順を 1 つの表に置く（`packages/core/src/task-status.ts` の `TASK_TRANSITIONS`）。同じ status への更新は常に可。

| 今の status | 動ける先 | 理由 |
|---|---|---|
| `idle` | `running` / `error` / `aborted` | 開始 / 起動失敗 / 中断 |
| `running` | `waiting` / `done` / `error` / `aborted` / `idle` | `idle` は Cloud の着地 |
| `waiting` | `running` / `done` / `error` / `aborted` / `idle` | `done` は承認を保留したままターンが終わった場合、`idle` は Cloud の orphan 回復 |
| `done` | `running` / `error` | 新しいターン・再開・ランナーが自分で始めたターン / 再開の起動失敗 |
| `error` | `running` | 再開・ランナーが自分で始めたターン |
| `aborted` | `running` / `error` | 再開 / 再開の起動失敗 |

上に無い動き（`done → waiting`、`error → aborted`、`idle → done` など）は保存しない。

- 置き場: TaskManager の `transition` が書く前に表を見て、`Db.updateTask` が最後の歯止めとして表に無い遷移を `InvalidTaskTransitionError` で止める（行は変わらない）
- ランナーのイベント（`session.start` / `permission.ask` / `permission.resolved` / `session.end`）は in flight（`running` / `waiting`）のときだけ status を動かす。終わった Task に遅れて届いても戻さない（イベントは transcript に残り、session id と model は記録する）。例外は、つながったままのランナーが `done` / `error` の後に自分で始めたターン（Claude Code が背景の作業の通知で続ける）の `session.start` で、`running` に戻し、ターンの間は idle の解放（`idleMs`）で閉じない。閉じると実行中のコマンドごと kill され（Exit code 137）、終わりも記録されずに Task が `done` のまま黙って止まっていた。解放済み・中断済みのプロセスはつながっていないので戻さない。ターンが終わっても背景の作業が残っている間（`background` の件数が 1 以上）は idle の解放をしない（`docs/design/claude-stream-json.md`）
- 終端から動かせるのは、利用者の操作（返信・再開・中断）と上のランナーが自分で始めたターンだけ。表に無い遷移を求める操作は `InvalidTaskTransitionError` で API のエラーになる。終わった Task が持っていた承認への答えはランナーに渡るが、status は動かさない
- Cloud: `running → idle | error`（セッションがあれば `idle`）、outcome は常に `unknown`
- orphan recovery（デーモンの起動時）: local の `running | waiting` は `aborted`、Cloud は `idle | error`
- `Task.statusAt`（#2029）: 今の status になった時刻。`Db.updateTask` が status の変わるときだけ `updatedAt` と同じ値で打ち、題・結果・確認済み・判定・同じ status への更新では動かさない（`updatedAt` とは別。`updatedAt` は結果・確認済みの API のように動かさない操作もある）。作成時は `createdAt`、terminal から取り込んだ Task はログの最後の記録の時刻（done になった時刻）、#2029 より前の行は migration で `updated_at` を写した

## 規則（状態 → 結果）

`Db.updateTask` で status が変わり、patch に `outcome` が無いときだけ付ける（規則は `task-status.ts` の `outcomeOnStatus(status, executionMode)` の 1 か所。TaskManager の経路ごとには書かない）。

| 変わった先の status | 結果 | 確認済み |
|---|---|---|
| `waiting`（承認・質問待ち） | `needs_action` | そのまま |
| `error` / `aborted` | `failed` | そのまま |
| `running`（新しいターン） | `unknown` | 外す |
| `done` / `idle` | 変えない | そのまま |

Cloud Task は judge しないので、status が変わると結果は常に `unknown`。

`done` が結果を変えないのは、ターンの始まり（`running`）で `unknown` に戻っているため。最後の返答を読んで完了 / 要対応に分けるのは #493 で、ターンが `done` で終わり結果が `unknown` のままの Task（並走は除く）を裏で 1 回判定する（`packages/core/src/judge.ts`、既定は Codex `gpt-6-luna`、動かなければ Claude Haiku。設定 `judge`。代わりのランナー・モデルと 1 ターンのタイムアウト（既定 60 秒）は設定 `judgeAndChoice`。#835）。判定は `judgedResult` / `judgedReason` / `judgedBy` に必ず残し、`outcome` には書く直前にまだ `unknown` のときだけ入れる（利用者が先に直した結果を上書きしない。両方残るので後で判定の正しさを測れる）。新しいターンで判定の 3 列も消える。判定中は `judgingAt`（判定を始めた時刻）に残し、判定が終わるか新しいターンが始まると消える。デーモンの再起動で切れた判定は、起動時に `judgingAt` が残っている Task（done・`unknown`・判定が有効）だけ 1 回やり直す（再起動が無ければ使っていた費用と同じ。#1139）。判定の費用はその Task の Ledger に、判定したランナーで載る。

## 確認済み（`Task.reviewedAt`）

利用者が確認済みにした時刻（ms）。null = 未確認。tasks の列 `reviewed_at`。

- 確認済みにしても Task は消さず、並び（`updatedAt`）も動かさない。Home の「最近」に残る
- 返信して新しいターンが始まると外れる（規則の `running`）
- 移行: この列を足した migration で、止まっていた既存の Task は `reviewed_at = updated_at`（確認済み）。導入直後の要対応は空で、以後に止まった Task だけが入る
- Terminal から取り込んだ Task（`origin: terminal`）は確認済みで入る（ターミナルでその場で見ていた）。続きのターンの取り込みは status を変えないので確認済みのまま

## 要対応のまとまり（Web）

`apps/web/src/attention.ts`。要対応 = 確認済みでなく、結果が `done`（完了）でなく、status が `running` でも `idle` でもない Task（完了した Task は利用者を待っていないので入れない。入れると待っている Task が埋もれる）。並びは結果の順（要対応 → 失敗 → 未判定）、同じ結果の中は `updatedAt` の新しい順。

- Home: 左のカードの先頭に「実行中 · 待ち」、その下に「要対応 · 件数」。「最近」からは要対応に入っている Task を除く（完了した未確認の Task は「最近」に出る）
- Rail: 先頭に `Running · Waiting`、その下に「要対応 · 件数」、その下に Workspaces
- 「実行中 · 待ち」はランナーの状態の欄として別に残す。承認待ちの Task は両方に出る
- Task 画面の見出し: 結果の select（4 択）と「確認済みにする / 確認済みを取り消す」。ターン中は無効

## API

`POST /api/tasks/:id/outcome`、本文 `{ outcome?: TaskOutcome, reviewed?: boolean }`（少なくとも 1 つ）→ `{ task }`。無い Task は 404、形が違えば 400。

- `reviewed: true` → `reviewedAt = 今`、`false` → null
- `outcome` を `needs_action` / `failed` にして `reviewed` が無ければ確認済みを外す（確認済みの Task を要対応に直したら、要対応に戻す）
- `updatedAt` は変えない。`task.updated` を流す

結果と別に、Task の指標（ツール呼び出し・失敗・追加指示・終わり方）は `docs/design/evals.md`（#1218）。

## アーカイブ（#1142）

一覧から隠す印は `tasks.archived_at`（ms、null = 隠していない）の 1 列。`POST /api/tasks/:id/archive {archived}` で付け外しし、止まった Task（done / error / aborted）だけに付く（running / waiting / idle は 409）。`updatedAt` は変えず `task.updated` を流す。`GET /api/tasks` の既定はアーカイブ済みを外し、`?archived=1` はアーカイブ済みだけを返す。返信で新しいターンが始まると印は外れる（動いている Task は隠さない）。

## 検証

- `packages/core/src/core.test.ts` の `describe("task outcome (#492)")`（規則・API・再起動・migration）と history import のテスト
- `packages/core/src/task-status.test.ts`（表の全ペア、不可の遷移が保存されないこと、outcome の規則、orphan recovery）と `core.test.ts` の `describe("task status transitions (#1140)")`（遅延イベント・中断・返信での再開・起動失敗、4 経路を 1 つの表で検証する回帰）
- `apps/web/src/attention.test.ts`（判定・並び・ラベル）
- `bun run --cwd apps/web build && bun scripts/attention-e2e.ts`（偽ランナー + headless Chrome で要対応の出入りを一続きで。`SCREENSHOT=<file.png>` で Home、`SCREENSHOT_TASK=<file.png>` で Task 画面）
