# Ledger（台帳と枠）

Switchboard が動かした Task の使用量（トークン・費用）と、ランナーの使用上限（枠）の消費率を、どこから取り、何を持ち、画面でどう見せるか（PBI #1836）。価格の付け方は `packages/core/src/pricing.ts`（`pricing.json`、日付つきの価格、1 時間キャッシュ）、速さの記録は [perf.md](perf.md)、評価は [evals.md](evals.md)。

## 台帳（`ledger`）

- 行 = ランナーの `usage` イベント 1 つ。イベントの `source` には `reported`（ランナー自身が報告した数。Claude は累計）/ `turn`（API 呼び出しごとの途中の数）/ `estimated` があり、台帳に入るのは `reported` だけ（`packages/core/src/tasks.ts` の `case "usage"`）。Codex はターンごとに 1 行（`turn/completed` で。`thread/tokenUsage/updated` の増分を合わせたもの）。Claude はターンごと・モデルごとに 1 行で、額はターンの増分（下）
- Claude の `result` の `total_cost_usd` と `modelUsage` は、ランナーのセッションの**累計**（同じプロセスの次のターンで増え、`--resume` の後も引き継ぐ。[claude-stream-json.md](claude-stream-json.md) の「Cost model」）。パーサは `modelUsage` のモデルごとに `usage`（`cumulative: true`）を 1 つ出し、デーモンは同じ Task・同じモデルの前の行の `reported_total` との差を行にする（`packages/core/src/pricing.ts` の `usageSince`）。前より減った、またはランナーのセッション id が変わったら新しいセッションとして累計をそのまま入れる。差が全部 0 なら行を入れない。列 `reported_total` は、その行が差を取った累計（JSON。`session` / トークン / `costUsd`）。`modelUsage` には 1 時間キャッシュの内訳が無いので、この行の `cache_write_1h` は 0（額はランナーのもの）。判定・ルーティングの単発の実行（`server.ts` の `insertLedger`）は毎回新しいセッションなので、累計がそのまま 1 回分で、差を取らない（#2353）
- 移行（#2353。`packages/core/src/db.ts` の `reported_total` を足す段で 1 回）: それより前の Claude の行は累計をターンごとに丸ごと入れていた（2026-10-23 の DB で $42,923、transcript からの計算では約 $7,400）。Task 本体の経路の行（同じ Task・同じ時刻に `usage(reported)` のイベントがある行）を Task ごとに id の順で前の行との差に直し（減っていれば新しいセッションとして額そのまま）、元の累計（そのセッションの全モデルの合計）を `reported_total` の `{"costUsd": …, "migrated": true, "session": …}` に入れた（`session` は移行の時点で Task が次のターンに再開するセッション `tasks.runner_session_id`。無ければ書かない）。`billed_usd` が `cost_usd` と同じ行は同じ値に。トークンとモデルは元のまま（`result.usage` のそのターンの数、`modelUsage` の最初のモデル）なので、移行した行のモデル別の内訳は直っていない。移行した Task の続きのターンが同じセッション（`--resume` は累計を引き継ぐ）なら、モデルごとの前の行が無いので、各モデルの最初の累計を移行した合計の残り（`Db.migratedCredit`。使った分は `reported_total.carried`）と相殺する。モデル別の合計と移行した全モデルの合計を比べると、2 モデル使った Task で前の額を二重に数えるため。別のセッション（再開できずに新しく始まった）なら相殺せず 0 から。トークンはその最初の 1 行だけ累計が入る
- 列: `task_id` / `runner` / `model`（ランナーが名乗ったまま。無ければ Task のモデル、それも無ければ価格表がランナーの別名から引いた名前、どれも無ければ null — `ledgerRowFor` の `ev.model ?? task.model ?? priced?.model ?? null`）/ 入出力とキャッシュのトークン（`cache_write_1h` は 1 時間キャッシュの分）/ `cost_usd` / `billed_usd`（実課金。定額のランナーは 0）/ `ts`。行の `source` はイベントのものとは別の 3 値（`packages/core/src/pricing.ts` の `ledgerRowFor`）: `reported` = ランナー自身が `costUsd` を報告した（Claude。価格表より優先し、価格表に無いモデルでもその費用が残る）/ `priced` = 価格表（`pricing.json`）で付けた / `unpriced` = 報告が無く価格表にも無い（費用 0）
- 保持は無期限（ディスクの考え方は [host-disk.md](host-disk.md)）

## 枠（`quota`）

- 由来 = ランナーの `quota` イベント（Claude は stream-json の `rate_limit_event` の `unifiedWindows`、Codex は app-server の通知 `account/rateLimits/updated` の `rateLimits.primary` / `secondary`。窓の長さで名前を付ける: 300 分 → `five_hour`、10080 分 → `seven_day`。[codex-app-server.md](codex-app-server.md)）。`runner × window` の**最新 1 行だけ**（`upsertQuota`）: `utilization`（使った割合。1 を超えることもある — 使用上限で止まったときの形は [rate-limit-resume.md](rate-limit-resume.md)）/ `resets_at`（epoch 秒）/ `ts`（報告の時刻、ms）。**履歴は持たない**（自動再開 #102 が戻る時刻を読む）
- 窓の名前はランナーのまま（`five_hour` / `seven_day` / `seven_day_overage_included` …）。日本語の表は `apps/web/src/quota.ts` の `windowLabel` 1 つで、Ledger / Home / Brief が共有する。知らない窓は `_` を空白にしてそのまま出す
- ランナーが長く動いていないとその行は古いまま残る（Codex を 1 週間使わなければ 1 週間前の値）。「MM/DD HH:MM 時点」はどの行にも出し、24 時間（`QUOTA_STALE_MS`、定数。設定にしない）より前の行は薄くする

## API

| Method and path | Does |
|---|---|
| `GET /api/ledger/summary` | 今日・今週の合計（API 換算と実課金）、ランナー別の今日、`quota` の全行、今週の上位 Task、GitHub の API 残量 |
| `GET /api/ledger/daily?days=` | 日 × ランナーの費用とトークン（`days` は `clampDays`: 無ければ 7、1〜90 に丸める） |
| `GET /api/ledger/tasks?days=` | Task 別の上位 50（`days` は同じ） |
| `GET /api/ledger/models?days=` | ランナー × モデル別（#1836）: `tasks` = そのモデルを使った Task の数、トークン、API 換算、実課金、`unpriced`（価格表に無い usage があった）。費用の降順。期間は `daily` と同じローカル暦（合計が一致する）。`days` は無ければ 7、あれば数字 1〜90 だけ（空・小数・91 は 400。既存の `clampDays` は変えない） |
| `GET /api/ledger/pricing` | 価格表とその出どころ、読めなかった価格表のファイル（`problems`。ファイルごとに 1 行） |

## 画面

- **Ledger**（`apps/web/src/components/Ledger.tsx`）: 「期間合計」の下に「使用量（枠）」— ランナーごとに窓の行（日本語の名前・メーター・%・「HH:MM に戻る」（今日でなければ日付も）・「MM/DD HH:MM 時点」。古い行は薄く）— と「モデル別（N 日）」の表（ランナー / モデル（null は「（不明）」）/ 件数 / トークン / API 換算 / 実課金。価格表に無いモデルは API 換算の代わりに「価格表に無い」）。期間の選択（7 / 14 / 30 日）は日別の棒・Task 別・モデル別に共通
- **Home**: 「今日のコスト」の枠の行が同じ名前（`claude · 5 時間`）。title に戻る時刻と時点、古い行は薄く
- **Brief**: その Task のランナーの枠（`5 時間の枠`）

## Not done, by decision

枠の消費率の履歴（時系列のグラフ。table が要る）、枠が戻る前の通知（自動再開 #102 の範囲）、価格表の編集（#1402）、Codex の `/usage daily / weekly / cumulative` と同じ日別のトークン量（日別の棒で見える）。

## Verified

- #2353: `packages/core/src/core.test.ts` "ledger: Claude's running totals (#2353)"（1.0 → 1.5 → 2.25 が 1.0 / 0.5 / 0.75、繰り返しは行なし、2 モデルが `/api/ledger/models` で分かれる、新しいセッションは 0 から）、`pricing.test.ts` "usageSince"、`db.test.ts` "ledger migration (#2353)"、`parse.test.ts` の `resume-cost.jsonl` の再生。本番の DB のコピー（2026-10-23）に移行をかけ、Claude の `reported` の合計 $42,930 → $7,469（9 月 $2,616、10 月 $4,853。移行 3.3 秒）、transcript がある 847 Task は $4,972（transcript の $4,901 の +1.4%）
- `apps/web/src/quota.test.ts`（窓の名前と未知の値、24 時間の境界、時点・戻る時刻、ランナーの並び）、`packages/core/src/core.test.ts` "ledger models (#1836)"（Task 数、null のモデル、unpriced、合計が daily と一致、days の 400）
- 2026-10-18、偽ランナーのデーモン + headless Chromium: Home の枠の行 `claude · 5 時間` / `claude · 7 日` / `claude · 7 日・超過込み`（薄い）/ `codex · 5 時間`（薄い）/ `codex · 7 日`（薄い）、Ledger の「使用量（枠）」5 行と「10:06 に戻る · 10/18 08:06 時点」、「モデル別（7 日）」2 行 → 30 日に変えると 10 日前の sonnet の行が増える
