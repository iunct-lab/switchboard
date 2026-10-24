# Evals（Task の評価）

Switchboard が動かした Task について、「どう進んで、どう終わったか」を Task ごとに残し、Task 画面で見られるようにする（要望 #1217）。この doc は、規則で数える指標（ルール指標、PBI #1218）、ルーブリック判定（PBI #1219）、人手の評価（PBI #1220）、Task 横断の一覧と改善要望の起票（PBI #1221）の保存先・定義・API・画面を書く。

デーモンの停止で切られたターンの数え方（Task の失敗と分ける元のデータ）は [ops-metrics.md](ops-metrics.md)。Insights の「運用」の節もそこに書く。

## 目的

Task の会話（`events`）には、ツールの呼び出しと結果、エラー、承認、停止、利用者の文がすべて残っているが、Task 単位で数えた値はどこにも無かった。「どの Task が手戻りや無駄を生んでいるか」を会話を読み直さずに見分けるために、ターンの終わりに数えて保存し、Task 画面の Brief に並べる。

## 保存先（`task_evals`）

| 列 | 意味 |
|---|---|
| `task_id` | Task |
| `source` | 誰の評価か: `rules`（規則で数えた指標）/ `judge`（ルーブリック判定、#1219）/ `human`（利用者、#1220） |
| `by` | 書いたもの。rules は数え方の版 `rules@1`（数え方を変えたら上げる）。judge は判定したランナーとモデル `<runner>:<model>`（`judgedBy` と同じ形）。human は `user` |
| `rubric` | judge が使ったルーブリックの `id@version`（例 `switchboard-default@1`）。それ以外は null |
| `json` | 中身。rules は `RuleEval`（下）、judge は `JudgeEval`（ルーブリック判定の節）、human は `HumanEval`（人手の評価の節）|
| `ts` | 書いた時刻（ms）|

主キーは `(task_id, source)`: **Task ごと・種類ごとに最新の 1 行だけ**を持ち、新しい評価は前の行を上書きする。履歴は持たない — ターンごとの値が要るなら `events` から数え直せる。`tasks` に列は足さない（評価が 3 種あり、1 テーブルを `source` で分けた方が一覧の JOIN が 1 回で済む。PBI #1218 の決定ログ）。migration は追加のみ（`CREATE TABLE IF NOT EXISTS`、`schema-baseline.json` に登録）。

読み書きは `Db.upsertEval` / `getEval` / `deleteEval` / `evalsOf`（[db.ts](../../packages/core/src/db.ts)）。`evalsOf` は、形が読めない行（古い数え方）を null で返し、上の層が数え直す。

## ルール指標（`RuleMetrics`、`packages/core/src/evals.ts`）

`ruleMetrics(events)` は Task の全イベントから次を数える（ターンではなく Task 全体）:

| 項目 | 何を数えるか |
|---|---|
| `turns` | `session.end` の数（ランナーが終えたターン。デーモンが切ったターンには無い）|
| `toolCalls` | `tool.call` |
| `toolFailures` | `tool.result` の `ok: false` |
| `errors` | `error` |
| `asks` / `denials` | `permission.ask` / `permission.resolved` の `decision: deny` |
| `stops` / `stopReasons` | `stop.record`（#939）の数と、`reason` コードごとの内訳 |
| `userInstructions` | 利用者の発言の数 − 1（最初の依頼を除く）|
| `lastEnd` | 最後の `session.end.status`（`ok` / `error` / `aborted`。無ければ null）|
| `durationMs` | 最初のイベントから最後のイベントまで（イベントが無ければ null）|

利用者の発言の数え方: 連続する `message.delta role:user` は 1 つの発言（ストリームで分かれるため）。間に別のイベントが入れば切る（`recapOf` は role の切り替え・`tool.call`・`session.end` でしか切らないので、まとめ方は同じではない）。ただし `messageId` を持つ delta が直前と違う id なら別の発言（ランナーが黙っている間に続けて送った 2 通）。id の無い 2 通が間に何も挟まず続いた場合は 1 つに数える（既知の少なめの数え方）。**数えないもの**: デーモンが自分で送る文 — 使用上限の自動再開（`RESUME_PROMPT`）と停止の再開（`STOP_RESUME_PROMPT`）。どちらも `AUTO_RESUME_HEAD`（`[Switchboard 自動再開]`）で始まり、`isAutomaticUserText` が見分ける。並走（#99）の Task に写された利用者の文は、その Task への指示として数える（別の Task なので）。

`rulesEvalOf(task, events, cost)` が `RuleEval` を作る: `metrics` に加えて、数えた時点の `status` / `outcome` / `costUsd`（Ledger の合計）/ `by` / `ts`。

## いつ数えるか

- **ターンの終わり**: `tasks.onTurnEnd` で同期に数えて `upsertEval`（[server.ts](../../packages/core/src/server.ts) の `countRules`）。1 Task の events を 1 回読むだけで軽い。失敗は warn にして飲む — 評価の失敗でターンの終わりを止めない
- **読むとき**: 行の無い（または読めない）Task（この仕組みの前に終わった Task、最初のターンが走っている Task）は `GET /api/tasks/:id/evals`（`evalsFor`）と一覧 `GET /api/evals` のときに数えて保存する。起動時に全件は数えない。一覧の 1 回目は行の無い Task の分だけ重い（その Task の events を全部読む）が、行が残るので 2 回目からは軽い。数えられない Task は null のままで一覧は返る
- **Cloud の Task**（`executionMode: cloud`）: イベントが手元に無いので数えない（`rules: null`）

行の `status` / `outcome` / `costUsd` はターンの終わりの snapshot で、その後に動く（判定 #493 や利用者が `outcome` を決める、プロセスが `session.end` 無しに死んで `status` が変わる）。API は行の上に Task の今の値を重ねて返す（snapshot は残す）。一覧（#1221）も `tasks` と `ledger` を JOIN して今の値を読む。

## API

`GET /api/tasks/:id/evals` → `TaskEvals = { rules: RuleEval | null, judge: JudgeEval | null, human: HumanEval | null }`。無い Task は 404。`PUT` / `DELETE /api/tasks/:id/evals/human`（人手の評価の節）。`POST /api/tasks/:id/evals/judge` → 202 `{ queued: true }`（再評価。下の節）。

## ルーブリック判定（#1219）

`done` で終わった Task を、軽量モデルにルーブリックで採点させ、観点ごとの点数と理由を残す。数字（ツール回数など）では分からない仕事の質を見るため。

### ルーブリックの形と置き場

`Rubric = { id, version, criteria: RubricCriterion[] }`、`RubricCriterion = { id, title, anchors: { "1", "3", "5" } }`（`packages/protocol/src/model.ts`）。観点は 1〜10 個、id は重複不可、点は 1〜5（2 と 4 は目安の間）。既定は `packages/core/src/rubric.default.json`（`switchboard-default@1`、観点 5 つ: `goal` 依頼の達成 / `instructions` 指示の遵守 / `efficiency` 効率 / `communication` 報告 / `safety` 安全。目安は軽量モデルが比べられる具体さの日本語 1〜2 文）。
利用者は `<SWITCHBOARD_HOME>/evals/rubric.json` に自分のルーブリックを置いて差し替える（Text stays text — 画面や DB では持たない）。`loadRubric`（`packages/core/src/rubric.ts`）がデーモンの起動時に 1 回読み、壊れていれば warn を 1 行出して既定に戻る。直したら再起動で効く。重みや合計点の閾値は持たない（スコープ外）。

### 版の残し方

判定の行（`task_evals` の `source = judge`）は `rubric` に `id@version`、`by` に `<runner>:<model>` を持つ。ルーブリックを直して `version` を上げれば、古い判定と新しい判定を版で分けて読める。行は Task ごとに最新 1 行（上書き。rules と同じ）。

### プロンプトと判定（`packages/core/src/rubric-judge.ts`）

`buildRubricPrompt`: 指示（JSON だけ。形 `{"scores": {"<観点id>": {"score": 1-5, "reason": "<40 字以内>"}}, "summary": "<80 字以内>"}`、判断できない観点は省いてよい）、ルーブリック（観点ごとに id・題・5 / 3 / 1 の目安）、依頼（title 200 字、最初の prompt 1,200 字）、指標（ルール指標の 1 行）、会話（`transcriptLines`、新しい方から 12,000 字。`recapOf` と同じ行の形）。
`judgeRubric`: `judgeTurn`（#493）と同じ順 — 設定 `judge` のランナー・モデルで読み取り専用の 1 ターン、失敗したら判定の代わり（設定 `judgeAndChoice` の `judgeFallbackRunner` / `judgeFallbackModel`、既定 `JUDGE_FALLBACK` = Claude Haiku。#835）で 1 回。タイムアウト 90 秒（会話を読む分、#493 の 60 秒より長い）。応答は `parseRubricJudgement`: `scores` を持つ JSON のうち、ルーブリックに無い id と 1〜5 の整数でない score を捨てても観点が 1 つは残る最初のものを取る。reason が無ければ「（理由なし）」。どの JSON にも残らなければ失敗（未採点のまま）。`judge.ts` は触らず、同じ形の別モジュールにした（#1174 / #1036 が `judge.ts` を変えているため）。

### いつ判定するか

`tasks.onTurnEnd` で、ターンが `done` で終わり（返答が無いターンは #493 と同じく判定しない）、並走（#99）でも Cloud でもなく、設定 `evals.judge.enabled`（既定 true）が立っていれば裏で判定する（`server.ts` の `judgeEvals`。#493 の判定とは別の登録）。費用（usage）はその Task の Ledger に判定したランナーで載る。古い採点 — 新しい採点が始まった、ターンが走っている（running / waiting）、判定を頼んだ後に利用者の文が来た — は捨てる（モデルや承認モードの変更のような status のイベントでは捨てない。#493 と同じ。error / aborted で終わった Task の「再評価」は残す）。捨てたときも失敗したときも `evals.updated` を流す（画面の「判定中」を終わらせるため。行は前のまま）。判定中の列は持たない: デーモンの再起動で切れた判定は、次のターンか「再評価」で足りる。
ランナー・モデルは `Settings.judge`（#493）を共用し、`Settings.evals.judge.enabled` は on / off だけ（`PATCH /api/settings { evals: { judge: { enabled } } }`、設定画面「ルーブリック判定」）。2 つの判定のスイッチは独立で、#493 の判定を切っていてもこれが入っていれば採点する（止めたい判定だけ止める）。

### 再評価

`POST /api/tasks/:id/evals/judge` → 202 `{ queued: true }`。今の会話で採点し直す（自動判定を切っていても、並走の Task でも動く — 押したのは利用者）。ターン中（running / waiting）、会話がまだ無い Task（idle、イベント無し）、Cloud は 409、無い Task は 404。結果は WebSocket の `evals.updated { taskId }`（中身は載せない）で知らせ、画面は `GET …/evals` を読み直す。

### 画面

Brief の「評価」の節のルール指標の下に「ルーブリック」: 平均 / 判定したランナー:モデル / ルーブリックの版、観点ごとの `点 / 5`（2 以下は amber）とその下に理由の 1 行、summary、「再評価」ボタン（ターン中は無効。押すと「判定中…」、その Task の `evals.updated` で戻る。来なければ 200 秒で戻る）。観点の題は画面側の表（既定の 5 観点）で付け、知らない id はそのまま出す（`apps/web/src/evals.ts` の `judgeRows` / `judgeAverage`）。

## 人手の評価（#1220）

利用者が気になった Task にだけ付ける、1〜5 点と一言。モデルの採点（judge）と自分の見方のずれを残し、後でルーブリックや判定モデルの良し悪しを確かめるため。

- 形: `HumanEval = { rating: 1〜5 の整数, comment: 1,000 字まで, by: "user", ts }`（`packages/protocol/src/model.ts`）。`task_evals` の `source = human`、Task ごとに 1 行（PUT で上書き、DELETE で消す。履歴なし）
- **任意**: 付けていない Task があってよく、一覧・集計（#1221）はそれでも成り立つ。付けるよう促す表示や印は出さない（要対応の分類に使わない）
- API: `PUT /api/tasks/:id/evals/human`（本文 `{ rating, comment? }`、形が違えば 400、無い Task は 404）→ その Task の `TaskEvals`。`DELETE /api/tasks/:id/evals/human` → 同じく `TaskEvals`（無ければそのまま 200）。どちらも `evals.updated { taskId }` を流す
- `tasks` の行には触らない: `updatedAt`（一覧の並び）・`outcome`・`reviewedAt` は動かない（確認済み #492 とは別の軸）
- Cloud の Task にも付けられる（人の評価はイベントが手元に無くてもできる。`rules` だけ null のまま）
- 画面: Brief の「評価」の末尾「自分の評価」— 表示行（`4 / 5 · 一言`、無ければ「なし」）、1〜5 のボタン、一言の欄、「保存」（点を選んだときだけ）、付いていれば「消す」。保存は 1 回の PUT（点を押しただけでは保存しない）。応答で表示を差し替える（`apps/web/src/evals.ts` の `humanLabel`）

## 一覧と改善要望（#1221）

Task をまたいで評価を並べ、弱い Task を見つけ、その評価を材料に改善要望を起票する。評価を眺めるだけで終わらせないため。

### 一覧の API

`GET /api/evals?workspaceId=&runner=&limit=` → `EvalsListRow[]`（`updatedAt` の新しい順。`limit` は既定 100、1〜500、小数は切り捨て。`runner` が知らない値なら 400）。行は `tasks` と `task_evals` の 3 行（`source` ごとに LEFT JOIN）を 1 本の SQL で読み、`status` / `outcome` / `updatedAt` は `tasks` から、`costUsd` は `ledger` の SUM から取る（評価の行の snapshot は信じない。#1218 の決定）。各 source の要点: `rules`（ツール呼び出し・失敗・エラー・追加指示・停止・終わり方）、`judge`（観点の平均 `average`・観点ごとの点・`rubric`・`by`）、`human`（点と一言）。評価の無い Task は null の列で出る。rules の行が無い（読めない）ローカルの Task は route で数えて行を残す（上の「読むとき」）。

### 画面「Insights」

Ledger の隣のタブ（`apps/web/src/components/Evals.tsx`）。タブの名前は Insights（#1835 で Evals から改名。View の名前とファイル名は `evals` のまま）で、上部に Task 横断の「レポート」の節（`docs/design/artifacts.md` の Across Tasks）、その下にこの表がある。絞り込み（workspace / ランナー / 件数）は API の query、並べ替えは画面側（`sortEvalRows`: 見出しを押すと並べ替え、もう一度で逆順。値の無い行はどちら向きでも末尾、同値は安定。最初のクリックは点数の列（ルーブリック / 自分の評価）が昇順 = 弱い Task が先、回数・費用・更新は降順 — `firstSortDir`）。列: Task（押すと開く）/ ランナー / 状態 / ツール / 失敗 / エラー / 追加指示 / 停止 / 終わり方 / ルーブリック（平均）/ 自分の評価 / 費用 / 更新 / 改善要望にする。失敗・エラー・停止が 1 以上、平均 2.5 以下、自分の評価 2 以下は amber（`evalRowWarn`）。判定や評価が開いている間に届けば（`evals.updated`）読み直す。取得に失敗したら「読み込めませんでした」。統計・グラフ・ページングは無し（PBI のスコープ外）。

### 改善要望にする

Brief の「評価」の節と Insights の評価の表の各行のボタン。押すと `GET /api/tasks/:id/evals/draft` が下書きを返し（`evalRequestDraft`、`packages/core/src/evals.ts`: Task の題と id とランナー、ルール指標の 1 行、3 点以下の観点と理由、総評、自分の評価、「改善したいこと:」の行）、既存のフィードバックのダイアログ（`docs/design/feedback.md`）がその文で開く。利用者が書き足して送ると `POST /api/feedback` に `source: { kind: "eval", taskId }` が付き、`buildFeedbackPrompt` が要望の `## 出典` に「評価から: Task <id>」の行を足す。あとは request-to-backlog がいつもどおり要望 Issue と PBI を作る。自動の起票は、定期実行の「評価の週報」（workspace ごとの prompt スケジュール。[scheduler.md](scheduler.md)）が週 1 件にまとめて行う: 弱い Task の共通点と、ルーティング規則・モデルの既定・スキルの文のどれを変えるかを要望 Issue にし、あとは backlog-next が運ぶ。#1221 のスコープ外「定期の自動起票はしない」は Evals を実装した PBI の範囲の話で、このリポジトリの方針ではない（方針は自動化できるところは自動化する。2026-10-14 に利用者が正した）。画面のボタンはそれとは別に、気になった Task をその場で要望にする経路。観点の題は既定のルーブリックの表から引き、知らない id はそのまま。

週報は要望 Issue のほかに HTML のレポートを 1 枚作り、成果物に登録する（#1837）。登録の経路はエージェントの `switchboard-artifact` フェンス（[artifacts.md](artifacts.md) の「The agent's own registration」、#1778）で、Insights の「レポート」に `評価の週報（<workspace>）<週の月曜の日付>` として新しい順に並ぶ（同じ文書の「Across Tasks: reports」）。表は Claude / Codex / DAK の Task を同じ列で並べるので、ランナーを横断した傾向はこのレポートで見る（OSS の codex-insights / claudex は入れない。PBI #1837 のスコープ外）。形は prompt の指示で縛り、Switchboard はテンプレートで描かない: `<meta charset=utf-8>` の 1 枚、外部の script / css / フォントを読まない（レポートは `sandbox="allow-scripts"` の frame で開く）。

「評価の週報」の登録（2026-10-14。workspace ごとに 1 本、他の workspace は `<workspace>` と起票の手順（そのリポジトリの `request_issue.sh`、無ければ `gh issue create` + Status）と cron の時刻（1 時間ずつずらす — 3 本が同時に走らない）だけ違う。登録は動いているデーモンへの呼び出しなので利用者の OK を取ってから。[merge-audit.md](merge-audit.md) と同じ型）。Task のモデルは events の `session.start` から読ませる: `tasks.model` は途中でモデルを変えると最後のモデルで上書きされ、`ledger` の model にはルーティング・採点の行と Claude の裏の Haiku が混ざるので、どちらで数えても混在した Task を 1 つのモデルに寄せるか、ほとんどの Task を混在に入れてしまう（#1800）:

```
POST /api/schedules
{ "title": "評価の週報（<workspace>）", "cron": "0 19 * * 0", "workspaceId": <the workspace>, "runner": "claude", "budgetUsd": 2,
  "prompt": "先週（今日から 7 日前の 0 時以降に更新された）この workspace（<workspace>、workspace_id = <id>）の Task の評価を分析し、改善要望を 1 件だけ起票してください。リポジトリのファイルは変更しないでください。
データは sqlite3 -readonly <SWITCHBOARD_HOME>/switchboard.db を読む（書かない）: tasks（workspace_id で絞る。schedule_id・runner・status・outcome・effort）、task_evals（source = rules / judge / human、json 列）、ledger（task_id ごとの cost_usd の合計）、routing_log。Task のモデルは events の session.start の model（json_extract(json,'$.t') = 'session.start' の json_extract(json,'$.model')、空は数えない）を Task ごとに distinct で読む。1 つならそのモデル、2 つ以上は『途中でモデルを変えた Task』、1 つも無ければ『モデル不明』。観点 (a) のランナーとモデル・(b) は 1 つのモデルの Task だけで比べ、tasks.model と ledger の model はモデルの比較に使わない（tasks.model は最後に選んだモデル、ledger にはルーティング・採点の行が混ざる）。Task の中身が要るときは events を読んでよいが、会話まで読むのは弱い Task 上位 5 件まで。
観点: (a) 失敗・エラー・停止・追加指示が多い Task の共通点（題の種類、使ったスキル、ランナーとモデル、effort） (b) 難易度に対してモデルが過剰・過少な Task（軽い Task に高いモデル / 重い Task を軽いモデルで失敗） (c) 費用に対して成果が薄い Task (d) ルーブリックで低い観点の偏り (e) ターンが多い・追加指示が多い Task に共通する指示の不足。
起票先: このリポジトリの指示（CLAUDE.md / AGENTS.md / docs）や構成の改善はそのリポジトリに。ルーティング規則・モデルの既定・スキルの文・Switchboard 自体の改善は開発リポジトリに（meta workspace の scripts/setup/request_issue.sh）。どちらも 1 件まで。
題「評価の週報（<workspace>）: <週の月曜の日付 YYYY-MM-DD>」。起票は bash scripts/setup/request_issue.sh \"<題>\" <本文ファイル>（本文は ## 要望 と ## 出典 が必須）。本文: ## 要望（改善案。1 案 1 行、効果の大きい順に 3 つまで。どの文書・規則・既定をどう変えるか）、## 出典（1 行目に - 誰の言葉: エージェント、続けて定期実行「評価の週報」/ 日付 / 読んだ Task 数）、## 分析（表: 分類 / 件数 / 代表 Task の id 3 件まで、原因の仮説、見送った案。表には『途中でモデルを変えた Task』と『モデル不明』の行を 0 件でも出す）。
分析の結果は HTML 1 枚にも書く: W=$(mktemp -d /tmp/switchboard.weekly.XXXXXX) の下の weekly-<週の月曜の日付 YYYY-MM-DD>.html。<meta charset=utf-8> を付け、外部の script・css・フォントを読み込まない（css は style 要素に書く）。画像を使うなら W に置いて HTML から相対パスで参照し、W には HTML をその 1 枚だけ置く。Task の題・エラー・コマンドなど DB から写す文字は & < > " をエスケープし、タグとして書かない（題に <workspace> などが入る。写したタグは表を崩し、外部の読み込みにもなる）。中身: 期間、ランナー別（Claude / Codex / DAK）の件数・結末（完了 / 要対応 / 失敗 / 未判定）・費用の中央値の表、弱い Task 上位 5 件と共通点の表、ルーブリックで低い観点の表、起票した要望の番号（起票しなかったならその理由）。返答の最後に switchboard-artifact フェンス（形は開始の前置きのとおり。path は画像が無ければその HTML、画像を使ったなら W のフォルダ（中の HTML 1 枚が開く）。title は「評価の週報（<workspace>）<週の月曜の日付 YYYY-MM-DD>」）で成果物に登録する。
本文ファイルは mktemp -d /tmp/switchboard.req.XXXXXX の下に置く。Task の会話の生の出力、秘密、認証に使える値（トークン・鍵・アカウント ID・リンクの秘密）は書かない。同じ題の開いた要望（type:request）があれば起票せず、その Issue にコメントで足す。最後に起票した番号（または起票しなかった理由）と要約を報告する。" }
```

Verified（#1863、2026-10-18）: 動いている Switchboard（main 2ef11cb）の 3 本の prompt に上の HTML の段落を足し（`PATCH /api/schedules/:id`。題の `<workspace>` をその workspace の名前にした）、switchboard の 1 本を今すぐ実行した。起票は要望 #1950。レポート（表 5 つ、`<meta charset>` あり、外部への参照は #1950 へのリンクだけ）が `GET /api/reports` の先頭に出て、`scheduleTitle` は定期タスクの題。Insights の画面でも「レポート」の先頭に出て、frame（`sandbox="allow-scripts"`）で表が崩れずに開いた（frame の要求はその HTML の 1 本で 200、外部への要求は 0 件）。

## 画面

Task 画面の Brief（詳細）の「評価」の節（`apps/web/src/components/Brief.tsx`、Context footprint の下）。行は `metricRows`（`apps/web/src/evals.ts`）が決める（9 行）: ツール呼び出し、失敗、エラー、追加指示、「承認 / 拒否」（1 行に `asks / denials`）、停止（理由の内訳つき）、ターン、所要時間、終わり方。費用は並べない（すぐ下の「コスト」の節が今の値を出す）。別の Task を開いたときは前の Task の値を消し、遅れて届いた前の Task の応答は捨てる。失敗・エラー・拒否・停止・エラーや中断で終わった行は amber。ターンが終わるたびに読み直し、ターン中は前回の値を出す。Cloud の Task には「Cloud の Task はルール指標とルーブリックを出しません（イベントが手元に無いため）。自分の評価は付けられます。」の 1 行と「自分の評価」の行だけ、応答を待つ間は「読み込み中…」。ローカルの Task は読むときに数えるので `rules` が null で返ることは無く、「ターンが終わると集計します。」の分岐はローカルの Task では通らない（API が将来 null を返す形になったときの文）。取得に失敗したときは「読み込み中…」（読み直しなら前回の値）のまま — 隣の self-dev の checks と同じで、失敗は表示しない。

## 検証

- `packages/core/src/evals.test.ts`（`describe("ruleMetrics (#1218)")`）: 失敗は `ok:false` だけ、自動再開の除外と発言のまとめ方、停止の理由別、空、`upsertEval` の冪等と古い行
- `packages/core/src/core.test.ts`（`describe("task evals (#1218)")`）: ターンごとに 1 行、追加指示の数、消した行の復元、今の `outcome` を返す、404
- `packages/core/src/schema.test.ts`: `task_evals` が基準にある
- `apps/web/src/evals.test.ts`: 行の順と `warn`、所要時間の形、`judgeRows` の順と `warn`、`judgeAverage`、`humanLabel`
- `packages/core/src/core.test.ts`（`human eval (#1220)`）: PUT / 上書きで 1 行 / 400 / 404 / `updatedAt`・`outcome`・`reviewedAt` 不変 / DELETE
- `packages/core/src/core.test.ts`（`evals list (#1221)`）: 新しい順、null の列、行の無い Task の数え直し、judge の平均、ledger の費用、絞り込み、limit の切り捨てと上限、読めない judge の行は null、下書きの route
- `packages/core/src/evals.test.ts`（`evalRequestDraft (#1221)`）、`packages/core/src/feedback.test.ts`（出典の「評価から」の行）
- `apps/web/src/evals.test.ts`: `sortEvalRows` / `firstSortDir` / `evalCells` / `evalRowWarn`
- `packages/core/src/rubric.test.ts`（`rubric (#1219)`）: 既定の形、上書き、壊れたファイル、重複 id、無し
- `packages/core/src/rubric-judge.test.ts`（`rubric judge (#1219)`）: 採点と by / rubric、プロンプトの中身、応答の読み方、代わりの Haiku、会話の切り詰め
- `packages/core/src/core.test.ts`（`rubric judge (#1219)`）: 裏の採点と `evals.updated` と Ledger、上書き、再評価 202 / 404 / 409、設定で止まる、古い採点を捨てる
- 実構成: 偽ランナーのデーモン（`startServer` を `mktemp -d` の `boot.ts` から）+ headless Chromium で Brief の「評価」を見る（PR #1227 / #1229 の本文）
- 実構成（#1862、2026-10-18）: 偽ランナーのデーモン + headless Chromium で、週報の prompt が指示する形の HTML（`<meta charset=utf-8>`、style 要素だけ、表 3 つ）を返答の `switchboard-artifact` フェンスで登録 → Insights の「レポート」の先頭に `評価の週報（switchboard）2026-10-12`、frame（`sandbox="allow-scripts"`）からの要求はその HTML 1 本で外部への要求 0 件、表は 3 つとも崩れずに出る（4×7 / 6×5 / 3×3）
