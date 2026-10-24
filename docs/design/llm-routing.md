# LLM ルーティング（PBI #25）

ルール表ルーティング（#6, `packages/core/src/routing.ts`）は残したまま、その判断ログを教師データにして
LLM が「このタスクはどのランナー向きか」を**提案だけ**する。決めるのは利用者（設計原則: Agent DECIDES, User APPROVES）。

## 教師データ（Task #80）

`routing_log` は Task 作成時に「提案 / 理由 / 実際に選ばれたランナー」を 1 行記録する。これだけでは
「その判断が良かったか」が分からないので、読み出し（`Db.routingLog()`）で Task の結末を結合する。

| 列 | 由来 |
| --- | --- |
| `taskId` / `title` / `suggested` / `ruleId` / `reason` / `chosen` / `ts` | `routing_log`（記録時に確定） |
| `status` | `tasks.status`（読み出し時点の状態。ランナーが止まっているかだけで、うまくいったかは分からない） |
| `outcome` | `tasks.outcome`（Task の結果、#492: `done` / `needs_action` / `failed` / `unknown`）。PBI #612 |
| `costUsd` | `ledger` の当該 Task 合計（API 換算 USD）。記録が無ければ 0 |
| `durationMs` | 作成 → **その Task の最後の event**（無ければ `updated_at`）。実行中の Task では伸び続ける。`updated_at` は予算変更など「作業でない更新」でも進むので使わない。取り込み記録が逆転した時刻を持つことがあるので 0 で下限を切る |

結末は**保存せず読み出しで結合する**: Task は作成後も走り続け、費用も後から増える。写しを持つと古くなる。

### export

```
GET /api/routing/log                      # JSON 配列（UI 用）
GET /api/routing/log?format=jsonl         # 1 行 1 例（application/x-ndjson）
GET /api/routing/log?limit=1000           # 1..5000、既定 200。壊れた値は既定に落ちる
```

どちらも `ts` → `id` の降順（新しい順）。同じ Task の 2 行や同じミリ秒に作られた Task があっても順序が決まるので、
`?limit=` と `| head -n` は再現する。ただしその標本は「新しい順」であって無作為ではない。
JSONL は U+2028 / U+2029 をエスケープして出す（Python の `str.splitlines()` などが 1 レコードを複数行に割らないように）。

上限 5000 行・カーソルなしなので、それより古い判断は export では読めない。教師データは「直近 N 件」で足りる
（`suggest-llm.ts` は 20 件しか使わない）という前提で、必要になったら `?before=<ts>` を足す。

```console
$ curl -s 'http://127.0.0.1:47831/api/routing/log?format=jsonl' | head -1 | jq .
```

## Suggester（Task #81）

提案元は差し替え可能:

```ts
interface Suggester {
  readonly kind: "rule" | "llm";
  suggest(ctx: RoutingContext, signal: AbortSignal): Promise<RoutingSuggestion>;
}
```

- `RuleSuggester` — 既存のルール表（`suggestRunner`）。**既定はこれだけ**。
- `CompositeSuggester(primary, fallback, timeoutMs = 5000)` — ルール表が「何を提案したか」を決め、LLM の答えは
  `llm: { runner, reason }` として**添えるだけ**。primary が throw した / 締め切りまでに答えない / 呼び出し側が諦めた
  ときはルール表の提案だけで Task を作る。締め切りは `Promise.race` で守る（signal を無視する primary でも Task 作成を
  待たせない）。primary は「誰でも実装できるインタフェース」なので**返り値を信用しない**: `runner` が RunnerId で
  ないもの、`reason` が空のものは落とし（`reason` が無いと `routing_log` の NOT NULL に当たって Task 作成ごと 409 に
  なる）、長すぎる理由は 300 字で切る。締め切り用の promise は必ず `catch` を付ける（primary が同期 throw すると
  race が組み立てられず、未処理の rejection でデーモンが落ちる）。

`POST /api/tasks` だけがこの経路を通る。`POST /api/tasks/suggest`（入力中に毎打鍵呼ばれる）はルール表のみで、
スケジューラと Inbox 昇格も同じくルール表のみ（無人実行が定額枠を勝手に使わないように）。

`TaskManager.create()` は同期のまま（スケジューラの「1 スケジュール 1 実行」保証が `create()` の同期性に依存している）。
非同期の Suggester は `POST /api/tasks` のハンドラが await し、結果を `create(input, precomputed)` に渡す。
クライアントが送ってきた値ではなく、**同じ入力からデーモンが計算したもの**である点は変わらない。

### 記録

`routing_log` に `suggested_by`（`rule` / `llm`）列を足し、LLM の提案は**同じ Task の 2 行目**として書く
（`rule_id = "llm"`）。1 行 1 提案なので、提案元ごとに同じ `chosen` と突き合わせて一致率を出せる（Task #83）。
既存行は `rule` 扱い（ALTER の DEFAULT）。

### 設定

UI は `/api/health` の `routing.llm.available`（設定したランナーが検出済みか）を読み、提案が出せないときは
トグルの横にそう書く。

`Settings.routing.llm = { enabled, runner, model }`（既定 `{ false, "claude", "" }`）。`PATCH /api/settings` は
部分更新で、`runner` は検出済みのランナーでなければ 400。現在値は `GET /api/health` の `routing.llm`
（`available` は提案器が配線されているか）にも出る。設定画面の「LLM 提案」（トグルとランナー / モデル。工程ボタン・フィードバックの実行ランナーは `Settings.autoStart` で、これとは別）の
選択がこれを書き換え、Task Brief がルール表の理由の横に「LLM の提案: <runner> — <reason>」を出す。

## Claude アダプタ経由の LlmSuggester（Task #82）

`packages/core/src/suggest-llm.ts`。Switchboard は API キーを持たない: 提案は**設定したランナー自身のアダプタ**で
1 ターン走らせて得る。

- プロンプト（`buildPrompt`）: 「JSON だけ返せ」＋候補ランナー一覧＋対象 Task（title / prompt / cwd 数 / scope /
  kind / workspace）＋`routingLog()` の直近 20 件を表にしたもの。
- 実行: `adapter.start({ cwd: <SWITCHBOARD_HOME>/suggest, scope: [同じ], model, permissionMode: 読み取り専用 })`。
  cwd は**空の専用ディレクトリ**。`SWITCHBOARD_HOME` 直下には API トークンと sqlite があり、読み取り専用モードは
  書き込みを止めるだけで読み取りは止めないので、そこでは走らせない。リポジトリにも触らせない。
  Claude は `plan`、Codex は `read-only`。**読み取り専用モードを持つはずのランナーにそれが無いときは提案を頼まない**
  （`undefined` は「制約なしで良い」ではなく「アダプタ既定（Claude なら auto）」を意味するため）。モード自体を持たない
  DAK はランナー側の設定に従う。確認要求が来たらその時点で打ち切る（答える人がいない）。ターンが終わったら必ず
  `close({ graceMs: 0 })`。ただし**既に届いた本文は捨てない**: 後から来たエラーや確認要求で答えを無効にはしない。
- 応答（`parseSuggestion`）: 本文中の釣り合った `{...}` を外側から順に（入れ子も）試し、候補ランナーを名乗る最初の
  ものを採る。```json フェンスでも前置きがあってもよく、プロンプトの書式例（`{"runner": "<候補のいずれか>"}`）を
  オウム返ししても後ろの本物を拾う。1 つも無ければ throw（Composite がルール表に落とす）。走査は 64KB / 200 候補で
  打ち切る（`POST /api/tasks` の同期パスなので、`{` だらけの応答で二乗時間にならないように）。
- 費用: そのターンの `usage` のうち**ランナー自身が出した最終値（`source: "reported"`）だけ**を、提案について聞かれた
  Task の台帳に、**答えたランナー**の行として記録する（Task 自身のランナーとは別でありうる）。呼び出しごとの `turn`
  カウンタはモデルも費用も持たないので使わない（`TaskManager` と同じ判断。価格表の別名で高いモデルとして値付けして
  しまう）。ターンが途中で終われば記録は残らない。この費用は Task の予算（`budgetUsd`）にも数えられる。
  聞くと枠を使う、という事実が Ledger に出る。

### 待ち時間（実測）

`claude -p --model claude-haiku-4-5` の 1 ターンは CLI 起動と拡張思考込みで**実測 10〜12 秒**だった。
設計どおり既定の締め切りは 5 秒なので、既定のままだと実ランナーでは毎回ルール表に落ちる。
そのため `Settings.routing.llm.timeoutMs`（1000〜60000、既定 5000）を設ける。設定画面の「待ち時間」で 5 / 10 / 15 / 30 秒。

### 再生テスト

録画は `runner-adapter-recording` スキルで自分で作り、Git の外に置く。
`bun scripts/fixtures.ts fetch` は非公開の履歴がある clone だけで使える。

`packages/core/fixtures/suggest-claude.jsonl`（Git の外）は実際の Claude Code 2.1.269 の stream-json 出力（`--model
claude-haiku-4-5 --permission-mode plan`）。洗浄済み（`/Users/dev`）。`suggest-llm.test.ts` はこれを
`createClaudeParser` に流して AgentEvent にし、`LlmSuggester` が `{runner, reason}` を返すこと、壊れた応答・
候補外ランナー・無応答・エラーが throw することを固定する。

## Workspace の自動選択（PBI #135）

Home の Workspace select の既定は「自動（LLM が選ぶ）」。人が Workspace を選ばずに「開始」すると、デーモンが登録済みの
Workspace から 1 つ選んで Task を作る。ランナーの提案（上の節）と同じ 1 ターンの形だが、こちらは**助言ではなく決定**なので、
落とす先のルール表が無い。

- 入口: `POST /api/tasks` に `cwd` も `workspaceId` も無いとき（`server.ts` の `chooseWorkspace()`）。`workspaceId` だけなら
  その Workspace の path を使う（自動ではない）。`POST /api/tasks/suggest`（打鍵ごと）は対象外 — 「自動」のあいだは Workspace 無しで
  呼ばれるが、ルール表だけで答え、LLM は呼ばない。Inbox 昇格とスケジューラも対象外（Workspace を必ず渡す）
- プロンプトの材料（`suggest-workspace.ts` の `buildWorkspacePrompt()`）: Task の title / prompt（1200 字まで）と、候補ごとの
  `id / name / kind / path` と `workspaceBrief()` の先頭 400 字（末尾の「やってほしいこと:」は落とす）。ディレクトリが消えた
  Workspace は候補に入れない。答えは `{"workspaceId", "reason"}` の JSON で、読み取りは `parseSuggestion` と同じ走査。
  候補に無い id は使わない
- 設定の共有: `Settings.routing.llm` の `runner / model` をそのまま使う（`timeoutMs` は共有しない — 下の節）。新しい設定キーは無い。`enabled` は
  見ない — select を「自動」のままにすること自体が指示で、`enabled` はランナー提案に枠を使うかどうかのスイッチだから。
  ターンは読み取り専用モード（`readOnlyMode()`。モードを持たない DAK はそのまま、モードはあるのに読み取り専用が無い
  アダプタには聞かない）で、repository ではなく `<home>/suggest` で走る
- 選べなかったら **409 で止める**: `Workspace を選んでください（<理由>）`。理由は、登録済みの Workspace が無い / 選択に使う
  ランナーが未検出 / 読み取り専用モードが無い / 設定 `judgeAndChoice.workspaceChoiceTimeoutMs`（既定 60 秒）たっても答えが来ない / 候補外の id や JSON の無い答え。Task は作らない。
  UI は文言をそのまま出して select にフォーカスする。黙って既定の Workspace に落とさないのは、落とした先で Task が走ると
  「デーモンがここを選んだ」と読めてしまい、別のリポジトリが書き換わるから。Task のランナー自体が未検出のときは従来どおり
  `runner "…" is not installed`（Workspace を選んでも解決しないので、この文言は付けない）
- 記録: 選んだ理由は `tasks.workspace_reason`（手で選んだ Task は NULL）。`GET /api/tasks/:id` の `workspaceReason`、Task Brief の
  「Workspace: <name>（自動: <理由>）」。新しいテーブルは無い — あとでルールを考える材料は
  `select cwd, workspace_reason, title from tasks where workspace_reason is not null` で足りる
- 費用: ランナー提案と同じく `reported` の usage を、作られた Task の台帳に**答えたランナー**の行として記録する。行は Task の
  行ができた直後・ランナー開始前に入れるので、開始に失敗して error の Task が残ってもコストが付く。選択そのものが失敗したときは
  Task が無く台帳の行き先が無いので、デーモンのログ（`console.warn`）にだけ残る
- ルールを後から足すなら: `chooseWorkspace()` の前段で**候補を絞る**形にする（パス名やキーワードで候補が 1 件になれば聞かずに
  決める、など）。LLM の答えをルールで上書きする形にはしない。今は候補が 1 件でも 1 ターン聞く

### 締め切りを共有しない理由

ランナー提案の `timeoutMs`（既定 5 秒）は**助言**のための締め切りで、間に合わなければルール表で Task を始めるだけ、何も失わない。
Workspace の選択は Task を始める**前提条件**で、落とす先が無い。ここに短い締め切りを掛けると、待った時間と既に使った 1 ターンを
捨てて 409 になり、人が選び直すだけになる。実 Claude（`claude-haiku-4-5`、plan、候補 3 件）の選択ターンは **6.6 秒**
（2026-09-19、1 回）で、そのあと数分以上の Task が走る。だから選択ターンの締め切りはランナーが固まったときの保険としてだけ置く:
設定 `judgeAndChoice.workspaceChoiceTimeoutMs`（既定 60 秒。#835 で定数から設定にした。選ぶたびに読む）。当初は `timeoutMs` を共有していたが、
既定のままだと実 Claude で毎回 409 になるので改めた（PBI #135 の決定ログ 2026-09-19、Task #152）。

### 選択のあと、画面、履歴

- 選べたら、同じリクエストの中でそのまま Task が作られてランナーが起動する。人に確認は求めない。その間「開始」ボタンは
  「Workspace を選択中…」。人が出てくるのは 409 のときだけ
- 選ぶのは Task のランナーとは**別のセッション**（`routing.llm` の runner / model、`<home>/suggest`、読み取り専用、1 ターン）。
  Claude のセッションは起動時の cwd に結びつくので、cwd が決まる前に Task 本体のセッションは始められない。`model` が空だと
  ランナーの既定モデルが使われ、選ぶだけの 1 ターンに Task 本体と同じ重いモデルが走る — 安いモデル（`claude-haiku-4-5` など）を
  入れておく。このため設定画面の「LLM 提案」の節は、「LLM にも提案させる」が OFF でもランナーとモデルの欄を出す
  （「待ち時間」はランナー提案専用）
- **このモデルは Task のモデルではない**（#155）。Task を動かすのは `POST /api/tasks` の `model`（Home の「モデル: …」）で、
  `routing.llm.model`（設定画面の「提案のモデル: …」）はこの 1 ターンにしか使われない。2 つの select はラベルで
  見分ける。下の「Task のモデル」節
- 履歴は手で選んだ Task と同じ: `workspaceId` / `cwd` は選ばれた Workspace なので、Workspace ごとの一覧・件数にその Workspace の
  Task として並ぶ。違いは Brief の「（自動: <理由>）」、`tasks.workspace_reason`、台帳の選択ターンの 1 行だけ。会話ログには行を
  足さない（`status` イベントは会話に描かれない。理由は Brief に常に出ている）
- 選択ターンの Claude 側のセッションログは `~/.claude/projects` の `<home>/suggest` のプロジェクトに残る（ランナー提案と同じ）。
  Workspace ではないので履歴の取り込み（#91）の対象にならない

### 再生テスト

録画は `runner-adapter-recording` スキルで自分で作り、Git の外に置く。
`bun scripts/fixtures.ts fetch` は非公開の履歴がある clone だけで使える。

`packages/core/fixtures/suggest-workspace-claude.jsonl`（Git の外）は実 Claude Code 2.1.269 の stream-json 出力（候補 3 件、
`--model claude-haiku-4-5 --permission-mode plan`）。洗浄済み（`/Users/dev`、session / request / message の id は合成値）。
`suggest-workspace.test.ts` が再生して `{workspaceId, reason}` を固定し、候補 0 件・候補外・無応答の throw、`POST /api/tasks`
の自動選択・409・台帳・手動選択を偽アダプタで固定する。

## 一致率（Task #83）

`Db.routingStats(days)` は `routing_log` を `suggested_by` ごとに数え、`suggested = chosen` の件数を返す
（`GET /api/routing/stats?days=`、既定は Ledger のほかのエンドポイントと同じ 7 日）。

**2 つの割合は分母が違う。** ルール表は全 Task に提案を出すが、LLM の行は「設定が ON で、待ち時間内に答えられた」
Task にしか無い（`CompositeSuggester` が落とした提案は行を書かない = 外れではなく**記録なし**になる）。
スケジュールと Inbox からの Task はそもそも LLM に聞かない。さらに Home の作成フォームはルール表の推奨を
既定で選ぶので、`rule.agreed` は「利用者が既定を上書きしなかった割合」でもある。
したがってこのカードは**優劣の比較ではなく、ルール表を直す手がかり**として読む。UI は割合と一緒に
`agreed / total 件` を必ず出し、この注意書きを添える。

知らない `suggested_by`（将来の提案元）の行は捨てずに `otherTotal` として数える。捨てると「まだ記録がありません」
と嘘をつくことになるため。カードの期間ラベルは応答の `days` を使う（再取得に失敗したときに古い数字へ別の
ラベルを貼らないように）。

## ランナーごとの結末（PBI #612）

一致率は「提案と実際の選択が一致したか」しか言わないので、`routingStats()` の返り値に `byRunner` を足し、
実際に動いたランナー（`chosen`）ごとに **件数・結果（`Task.outcome`）ごとの件数・費用と所要時間の中央値** を返す。
新しいエンドポイントは作らない（`GET /api/routing/stats?days=` がそのまま返す）。

- **1 Task 1 件**: `suggested_by = 'rule'` の行だけを数える。ルール表の行は Task ごとにちょうど 1 行あり、LLM の行は
  同じ Task の 2 行目なので、両方を数えると LLM に聞いた Task だけが 2 倍になる
- **中央値は TS で取る**: SQLite に median が無い。窓内の rule の行を読んで `db.ts` の `median` で取る（偶数個は中央 2 つの平均）。
  窓は 90 日までで数百行。平均にしないのは、数時間走った 1 件が平均を引っぱるため
- 費用と所要時間の式は `routingLog()` と共有（`TASK_COST_SQL` / `TASK_DURATION_SQL`。所要時間の測り方は上の表）
- 記録の無いランナーは API に入らない。この版が知らない `outcome` の値は `unknown` に数える
- **画面**（Ledger の一致率カードの下の表、`apps/web/src/runnerStats.ts`）: Ledger の `RUNNERS` の順に 1 行ずつ出し、
  記録 0 件のランナーも 0 の行にする。窓内の件数が `THIN_SAMPLE`（5 件）未満の行は薄くし「比べるには記録が少ない（n 件）」と出す。
  閾値は画面の定数で、API は件数だけ返す。窓は Ledger の期間の選択（7 / 30 / 90 日）に従い、別に 30 日固定で取らない
- **LLM の提案**（`buildPrompt`）の過去の判断の表も、`状態`（status）の次に `結果`（outcome）の列を持つ

## Task のモデル（#155）

発端（#154）: model を空で作った Task が Haiku で走った。空 = 「CLI 既定」で、`claude` は `--model` なしで起動し、Claude Code 自身の
設定（`~/.claude/settings.json` の `model`）で動く。その値が画面のどこにも出ておらず、Workspace が「自動」のときは説明のない入力欄が
2 つ並んでいたので、自動選択がモデルを変えたように見えた。

- **一覧と既定はアダプタが言う**: `RunnerAdapter.models`（定数。API には問い合わせない — Switchboard は API キーを持たない）と
  `cliDefaultModel()`（claude: `~/.claude/settings.json` の `model`、codex: `~/.codex/config.toml` のトップレベルの `model`。
  project 側の設定や環境変数の上書きは追わない best effort）。`GET /api/health` の `runners[].models` / `cliDefaultModel` に載り、
  `cliDefaultModel` は呼ぶたびに読む（CLI 側で `/model` を変えたらすぐ出る）。DAK はモデルを agent 側で決めるので一覧は空
- **select**（`apps/web/src/components/ModelSelect.tsx`、選択肢は `modelOptions()`）: 先頭が「CLI 既定（<cliDefaultModel>）」、
  アダプタの一覧、一覧に無い現在値（手入力した名前、ランナーが `session.start` で名乗った完全な id）、末尾「手入力…」。
  Home の Task 本体・設定画面・定期実行のフォーム・Brief で同じ部品。Task ごとの保存した既定モデルは持たない — Home の既定は CLI 側の 1 箇所（自動で始まる Task の既定は `Settings.autoStart`、設定画面）
- **途中変更**: `POST /api/tasks/:id/model`（`{ model: string | null }`、null / 空 = CLI 既定）。`TaskManager.setModel` は承認モードを
  その場で切り替えられないランナーと同じ経路: 待機中のプロセスは解放し、実行中なら今のターンはそのまま（`restartNext`）、次のターン
  が `--resume` + 新しいモデルで同じセッションを再開する。今のターンを止めたいなら中断してから返信する。実 CLI で確認済み
  （2026-09-19、claude 2.1.277: `--model claude-haiku-4-5` のセッションを `--resume <id> --model claude-sonnet-5` で続けると
  Sonnet が答え、`modelUsage` に両方が出る）。Claude の `set_model` 制御メッセージは使わない（ランナーごとの分岐になる）
- 古いプロセスはターンごとに自分のモデルを `session.start` で名乗る。変更後そのプロセスが付いている間は、その値を Task に
  書き戻さない（`LiveSession.modelChanged`）。再開したプロセスの `session.start` は新しいモデルの完全な id を書く
