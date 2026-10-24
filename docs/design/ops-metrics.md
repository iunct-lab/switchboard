# ops-metrics（デーモンの停止を原因別に数える・ホストの負荷・API の所要時間）

デーモンの停止が「いつ・何回・何が原因で」起き、どの Task の何ターンが中断されたかを、Switchboard の中に残して画面と週の検査で見る（要望 #2084、PBI #2085）。停止が増えたと感じたときに勘ではなく数で確かめ、手を打った後に減ったかを前後で比べるため。数は目標にしない（[flow-metrics.md](flow-metrics.md) と同じ。比べるのは手を打つ前後と、どの原因が大きいか）。

それまで停止の原因は systemd の journal（ホストを作り直すと消える）にしか無く、中断されたターンは events の status 行（[`STOP_NOTE`](../../packages/core/src/interrupted.ts)）にあっても集計する場所が無かった。

## 保存先（`daemon_runs`）

デーモンの起動ごとに 1 行（[`packages/core/src/ops-stops.ts`](../../packages/core/src/ops-stops.ts)、表は `db.ts` の SCHEMA）。DB にあるので、ホストを作り直しても DB が残る限り消えない。

| 列 | 中身 | 書く側 |
|---|---|---|
| `started_at` | 起動の時刻（ms） | 起動（`startDaemonRun`） |
| `version` | 動いている版: sb-rescue の管理下なら release のディレクトリ名（sha）、それ以外は `git rev-parse --short HEAD` | 起動 |
| `boot_id` | `/proc/sys/kernel/random/boot_id`（無い OS は NULL） | 起動 |
| `clean_exit` | 自分の停止処理が書く: `restart`（`/api/daemon/restart` の再起動）/ `shutdown`（SIGTERM などの通常の停止）/ NULL（殺された） | 停止（`endDaemonRun`） |
| `ended_at` | 終わった時刻。停止処理が書き、次の起動が根拠の時刻で書き直す | 停止 / 次の起動 |
| `end_reason` | `oomd` / `restart` / `host-stop` / `promote` / `crash` / `unknown`。実行中と、停止の後で次の起動の前は NULL | 次の起動 |
| `end_detail` | 判定の根拠を 1 行（journal の行そのものは入れない） | 次の起動 |
| `interrupted_task_ids` | 中断されたターンの Task id（JSON の配列、重複なし） | 停止（`tasks.shutdown` が中断したもの）+ 次の起動（`abortOrphanedTasks` が見つけたもの。cloud を除く） |

- 中断ターンは events を走査して数えない（events は ts の索引が無く、アーカイブで消える）。止めた側が知っている Task id をその場で行に書く。1 回の停止で 1 つの Task は 1 ターン
- sb-rescue が昇格の前に立てる候補のデーモン（`SWITCHBOARD_CANDIDATE=1`、DB の写し）は書かない

## 原因の判定

次の起動が、前の行を手元の記録だけで判定する（外へは何も送らない。README の「No keys, no telemetry」）。上から最初に当たったもの（`classifyStop`）:

1. 前の行の `clean_exit` が `restart` → `restart`（`/api/daemon/restart` で止まった。sb-rescue の下では exit 75）
2. sb-rescue の `releases/history.jsonl` に、前の行の起動から 90 秒より後の `promote` / `rollback` / `auto-rollback` / `restore-db` → `promote`
3. 版（`version`）が前の行と違う → `promote`
4. 2 と同じ範囲の history.jsonl に `restart`（救援画面の再起動）→ `restart`
5. 前の行の `clean_exit` が NULL で、journal（`journalctl -u switchboard.service --since <前の起動>`）に `systemd-oomd killed` → `oomd`（`ended_at` はその行の時刻）
6. `boot_id` が前の行と違う → `host-stop`
7. journal に `status=75` → `restart`（その行の時刻）
8. journal が読めない（`journalctl` が無い・exit が 0 でない）→ `unknown`
9. `clean_exit` が `shutdown` → `restart`、それ以外 → `crash`

`ended_at` は根拠の時刻、無ければ停止処理が書いた時刻、それも無ければ次の起動の時刻。

- **昇格は版で見る（3）**: sb-rescue は history.jsonl の `promote` を、新しいデーモンの確認（confirm 最大 60 秒 + settle 10 秒）と古い release の掃除の**後**に書く（`rescue/src/promote.ts`）。次の起動の時点ではまだ行が無いので、版の比較で判定する
- **起動から 90 秒の history.jsonl は数えない（2・4）**: 上の理由で、昇格の行は新しい run の始まりに落ちる。それを run の終わりの根拠にすると、昇格で始まった run の終わり（oomd など）が `promote` になる。90 秒は 70 秒に余裕を足した目安で、厳密な上限ではない（確認が遅く掃除が長ければ越えうる）
- **oomd は自分で終わっていない run だけ（5）**: oomd がランナーだけを kill してデーモンが生き残ったとき、その journal の行が後の通常の停止を oomd にしないため
- **ホストの停止は boot_id で見る（6）**: journal が無くても判定でき、ホストの停止で SIGTERM を受けた（`clean_exit` = `shutdown`）停止も `restart` にしない
- 起動の時点で閉じていない行が 2 つ以上あれば、古い方は `unknown`（`left open by an older start`）で閉じる

## API と画面

- `GET /api/ops/stops?days=`（`days` は整数 1..90、無指定は 7。それ以外は 400）: 終わった行を、終わった日（JST。`/api/ledger/daily` と同じ日の切り方）× `end_reason` でまとめる。`{ days, rows: [{ day, reason, stops, turns, taskIds }], running: { startedAt, version } | null }`。`turns` は各行の Task id の数の合計、`taskIds` は重複を除いた id（Task 数 = その長さ）。型は `packages/protocol/src/model.ts` の `OpsStops`（`StopReason` はデーモンの停止の原因。Task が止まった理由の `StopReasonCode` とは別）
- Insights の「運用」の節（[`apps/web/src/components/Ops.tsx`](../../apps/web/src/components/Ops.tsx)）: 小見出し「デーモンの停止」、直近 7 日 / 30 日、表（行 = 日、新しい日が上、列 = 起きた原因ごとの回数、中断ターン、Task 数、合計の行）。Task 数のセルを開くと Task の id が並び、押すとその Task が開く。負荷の内訳（#2086）・速さと API の所要時間（#2087、下の「API の所要時間」）も同じ節にある
- 週の検査「止まった理由（全 workspace）」の prompt が `GET /api/ops/stops?days=7` を読み、`taskIds` の Task の中断を Task の失敗に数えず、原因別の「デーモン起因の中断」に分けて書く（prompt は利用者のデータなので、リポジトリの seed や migration ではなく、動いているデーモンへの PATCH で 1 回足す）

## 限界

- **この仕組みより前の停止は無い**。journal はホストを作り直すと消えるので、遡って入れない
- **journal が読めない環境**（macOS など `journalctl` が無い・失敗する）: `/api/daemon/restart` の再起動（1）、版の変化（3）、boot id の変化（6。`/proc` がある OS だけ）のほかは、SIGTERM の通常の停止も殺された停止も `unknown`
- **journal を読む権限が無い**（`systemd-journal` / `adm` の外の利用者）と `journalctl` はユニットの行を出さずに 0 で終わることがある。そのときは殺された停止が `oomd` ではなく `crash` になる
- **開発の `bun run dev`**（sb-rescue の外）: 版が `git` の HEAD なので、pull で HEAD が動くと `promote`。`--watch` の読み直しは停止処理を通らず、journal にもユニットの行が無いので `crash`
- **起動から 90 秒以内の `restore-db` と救援画面の再起動**は history.jsonl の行を数えないので、`restart` になる（版が変わらないため 3 でも拾えない）
- **sb-rescue ごと殺されたとき**（oomd のユニットごとの kill）の `ended_at` は journal の行の時刻。journal が無ければ次の起動の時刻
- 停止処理が終わってから次の起動が判定するまでの間は、その停止は `rows` にも `running` にも出ない（動いているデーモンからは見えない。DB の写しを取ったときだけ見える）
- 停止の瞬間にどのプロセスが重かったかはこの表では測らない（下の「ホストの負荷」の `top`）

## 検証

- `packages/core/src/ops-stops.test.ts`: 判定の各分岐、`startDaemonRun` が前の行を閉じて Task id を足す、fetch を呼ばない
- `packages/core/src/core.test.ts` の `ops stops (#2092)`: `GET /api/ops/stops` の形と `days` の検査
- `apps/web/src/ops.test.ts`: 表の並び・列の省略・合計

## ホストの負荷

ホストのメモリと CPU の負荷が時間帯ごとにどれだけで、どの Task のどの操作（ランナー本体・サブエージェント・テスト / ローカル CI・headless Chrome・docker）とデーモン自身のどの仕事（昇格のビルド・採点・アーカイブ・バックログの取得）が上げているかを、Switchboard の中に残して見る（要望 #2084、PBI #2086）。oomd にユニットごと殺される前に何が重いかを知り、減らす手を数で選ぶため。数は目標にしない（上の停止と同じ）。ホストの外の CloudWatch はホスト全体の割合しか持たず、どのプロセス・どの Task かは分からない。

採取は [`packages/core/src/ops-load.ts`](../../packages/core/src/ops-load.ts)。外へは何も送らない（テストが `fetch` を呼ばないことを見る）。

### 保存先（`ops_load` / `ops_load_groups`）

デーモンが起動直後と 60 秒ごとに 1 回採取し（`OpsLoadSampler`）、2 つの表に 1 トランザクションで書く。同じ書き込みで 7 日より古い行を両方の表から消す。候補のデーモン（`SWITCHBOARD_CANDIDATE=1`）は採取しない（同じユニットを動いているデーモンが採る）。

`ops_load`（1 分に 1 行）:

| 列 | 中身 |
|---|---|
| `ts` | 採取の時刻（ms） |
| `mem_current` / `mem_max` / `swap_current` | デーモンのユニット（`/proc/self/cgroup` の `0::` の行）の `memory.current` / `memory.max`（`max` なら NULL）/ `memory.swap.current` |
| `events_max` | `memory.events` の `max`。ユニットができてからの**累積**の上限到達回数（集計で隣の行との差を取る） |
| `cpu_pct` | `cpu.stat` の `usage_usec` の前回からの差 ÷ 経過時間。1 CPU を 100 とする（2 コアが忙しければ 200）。起動直後の 1 回目と、値が戻ったとき（ユニットの作り直し）は NULL |
| `pressure_some` / `pressure_full` | `/proc/pressure/memory` の `avg10`（%）。PSI の無いカーネルは NULL |
| `docker_mem` | 隣のユニット `sb-dockerd.service`（DAK の docker）の `memory.current`。無ければ NULL |
| `top` | RSS の大きい順に 10 プロセス（`pid` / `taskId` / `owner` / `kind` / `comm` / `rssBytes`）の JSON。90% を越えた行だけでなく毎分の行に持つ（oomd は 90% 未満の圧迫でも kill するので、kill の直前の行に必ず残すため） |

`ops_load_groups`（1 分に、Task × 持ち主 × 種類ごとに 1 行）: `ts`・`task_id`（Task でなければ NULL）・`owner`（`task` / `daemon` / `other`）・`kind`・`rss`（そのグループのプロセスの RSS の和）・`cpu_ms`（前回からの CPU 時間）・`procs`（プロセス数）。

- CPU 時間は各プロセスの `/proc/<pid>/stat` の utime + stime の前回からの差。前回に無かった pid は全量（その 1 分に生まれたとみなす）、前回より減った pid（pid の使い回し）も全量、起動直後の 1 回目は 0（それまでの累積はこの 1 分のものではない）
- `cmdline` と環境変数は保存しない（Task の prompt が引数に載ることがある）。環境変数は下の 2 つの印だけ読む

### 持ち主と種類の規則（`attribute`）

ユニットとその下の cgroup の `cgroup.procs` の pid だけを見る。持ち主（上から）:

1. デーモン（`process.pid`）とその祖先（sb-rescue、`scripts/dev.ts`）→ `daemon`。Task のシェルから起動したデーモンは Task の印を持つが、それでも `daemon`
2. 環境変数の印 `SWITCHBOARD_TASK_ID`（[`detached.ts`](../../packages/core/src/detached.ts) の `taskIdsInProcesses` と同じ読み方。`SWITCHBOARD_DAEMON_HOME` が自分の home と違えば別のデーモンの Task なので印を見ない）→ その Task。setsid で木を抜けた子孫も印で拾う
3. 印の無いプロセスは最も近い祖先の持ち主と Task を継ぐ（Chrome の zygote / renderer は環境を落とすが、その Task の browser）。祖先がユニットの外なら `other`

種類（上から最初に当たったもの）。`claude` / `codex`（comm か argv0）は引数に prompt が載るので名前だけで判定し、ほかは comm と cmdline 全体で見る:

| 種類 | 当たる条件 |
|---|---|
| `browser` | `chrome` / `chromium` / `headless_shell` / `playwright` |
| `docker` | `docker` / `containerd` / `buildkit` |
| `test` | `bun test` / `local-ci.ts` / `vitest` / `tsc` / `perf-bench` |
| `subagent` | Task の中の `claude` / `codex` で、Task の木の頂点でないもの |
| `judge` | 印 `SWITCHBOARD_DAEMON_JOB=judge`（`runSuggestionTurn` が付ける。採点・ルーブリック・提案の副ターン） |
| `archive` | comm が `age`（events のアーカイブの暗号化） |
| `backlog` | デーモンの子の `gh` |
| `build` | sb-rescue 側（デーモンの子孫でない）で、昇格そのもののコマンド（`git -C … archive` / `tar -x` / `bun install --frozen-lockfile` / `bun run --cwd apps/web build` / `releases/<sha>/packages/core/src/main.ts` の候補デーモン）。`scripts/dev.ts` の vite や救援の agent は当たらない |

どれにも当たらなければ、同じ持ち主・同じ Task の最も近い祖先の種類を継ぐ（`bun test` の子の `bun` は `test`）。それも無ければ、Task の木の頂点（親が同じ Task でない）は `runner`、ほかは `other`。

### 使い方

- `GET /api/ops/load?days=&task=`（`days` は整数 1..90、無指定は 7、それ以外は 400）: `{ available, days, hours, groups }`。型は `packages/protocol/src/model.ts` の `OpsLoad`
  - `hours`: JST の 1 時間ごとの `maxMem` / `memMax` / `maxSwap` / `limitHits` / `maxCpuPct` / `maxPressureFull` / `maxDockerMem`。`limitHits` は `events_max` の隣の行との差の合計（期間の最初の行は期間の前の 1 行と比べる。差が負ならユニットが作り直されたので後ろの値を全部足す）
  - `groups`: `task_id` × `owner` × `kind` ごとの `maxRss`（1 分の行の最大）と `cpuMs`（合計）。`maxRss` の大きい順
  - `task=` を付けるとその Task の `groups` だけで、`hours` は空
  - `available`: このホストで cgroup が読めるか。`false` なら記録も無い
- Insights の「運用」の節の小見出し「ホストの負荷」（[`Ops.tsx`](../../apps/web/src/components/Ops.tsx)）: 停止の表と同じ 7 日 / 30 日で、日ごとの最大メモリ（上限との比）・上限到達回数・最大スワップの表と、負荷を上げた上位 10 の Task × 操作（「Task <id> の headless Chrome 1.2 GB」。押すとその Task が開く）。測れない環境では「この環境では測れません」
- Task 画面の Brief の「負荷」の行: 同じ API の `task=` で、「最大 1.6 GB（headless Chrome 1.2 / ランナー本体 0.4）」
- oomd の kill の直前の行（`daemon_runs` は上の停止の節）:

  ```sql
  select * from ops_load
  where ts < (select ended_at from daemon_runs where end_reason = 'oomd' order by ended_at desc limit 1)
  order by ts desc limit 1;
  ```

### 限界

- **DAK の docker は別 cgroup**（`sb-dockerd.service`）なので合計（`docker_mem`）だけ。Task には分けない。Codex のサンドボックスの中は同じユニットのプロセスとして数える
- **1 分の間の山は見えない**。90% を越えた瞬間も 1 分の粒度で、その間に生まれて消えたプロセスの CPU 時間は数えない
- **プロセスの中の内訳**（どのテストファイルが重いか）は無い
- **RSS は共有ページを重ねて数える**。グループや Task の和はユニットの `memory.current` を越えうる。Brief の「最大」は操作ごとの最大の和で、操作が別の分に山を迎えると実際の同時の最大より大きく出る（上限の目安）
- **Bash ツールの短いプロセス**（`bash -c "grep docker …"`）は cmdline の語で `docker` / `browser` などに分類される。短く小さいので `top` の雑音に留まる
- **ユニットの作り直しの直後**: 作り直した後の `events_max` が前の行の値以上なら差を作り直しと見分けられず、少なく数える
- **macOS と cgroup v1**（`/proc/self/cgroup` に `0::` の行が無い、`memory.current` などが読めない）では何も記録しない。開発の `bun run dev`（systemd の外）ではログインのセッションのスコープを数える

### 検証

- `packages/core/src/ops-load.test.ts`: 偽の cgroup と `/proc` の木で持ち主と種類、CPU の差分、上位 10、90%、読めない分岐、毎分の書き込み・7 日の削除、`fetch` を呼ばない
- `packages/core/src/core.test.ts` の `ops load (#2086)`: `GET /api/ops/load` の時間帯・上限到達回数（作り直しを含む）・並び・`task=`・`days` の検査
- `apps/web/src/ops.test.ts`: 日ごとの並びと上限との比、上位の表示名、Brief の行

## API の所要時間（#2087）

Task を開く操作の遅さのうち、サーバ側の時間がどれだけかを後から分けるため、API の要求ごとの所要時間とバイト数を残す（PBI #2087）。転送と描画を含んだ時間は [perf.md の「ふだんの使用の記録」](perf.md#ふだんの使用の記録639) の `perf_samples` にあり、2 つを比べて差を転送・描画とみなす。

### 保存先（`api_requests`）

要求ごとに 1 行（`packages/core/src/server.ts` の `logged`、表は `db.ts` の SCHEMA）。

| 列 | 意味 |
|---|---|
| `ts` | 応答を返した時刻（ms） |
| `method` / `route` | HTTP の method と、`guardAll` の route のキー（`/api/tasks/:id` のように id を伏せた形。自分では正規化しない） |
| `status` | 応答の status。ハンドラが投げたら 500 |
| `ms` | 要求を受けてからハンドラが Response を返すまで（`performance.now()` の差。CDN の header・Host・認証の検査を含み、転送は含まない） |
| `bytes` | 応答の `content-length`。`json()` が付ける。付かない応答（ファイル・エラーの一部）と `0` は null。本文を読み直して数えない |

- **記録の範囲**: `guardAll` の route だけ。route の無い fallback（静的ファイル・未知の path）と、WebSocket の upgrade（101。所要時間が要求の速さではない）は記録しない。ループバックでもクラウドでも記録する
- **書き込み**: デーモンの中のバッファに積み、10 秒ごと（`setInterval`、`unref`）とデーモンの停止のときに 1 トランザクションで書く。書き込みが失敗したらその回を捨てて 1 回だけ警告する（デーモンは止めない）。直近 10 秒の要求はまだ表に無い
- **いつ消すか**: 書き込みのたびに 7 日より古い行を消す。保持日数と書き込みの間隔は定数（設定にしない）
- **access log**（クラウドのホストの `accessLine`、#1490）の行にも同じ `ms`（小数第 1 位に丸め）を付ける。access log は従来どおり認証が要る構成（ループバックでない）だけ

### API と画面

- `GET /api/ops/latency?days=`（`days` は既存の `clampDays`: 1..90、無指定・不正値は 7）: `api_requests` を JST の日 × method × route（`byDay`、新しい日が先）と、期間全体の method × route（`total`、p90 の大きい順、同じなら件数の多い順）で集計する。`{ days, total: [{ method, route, count, p50, p90, bytesP50 }], byDay: [{ day, method, route, count, p50, p90, bytesP50 }] }`。p50 / p90 は nearest-rank（`db.ts` の `nearestRank`、`perfSummary` と共用）、`bytesP50` は bytes が null でない行の p50（無ければ null）。型は `packages/protocol/src/model.ts` の `OpsLatency`。集計の表は作らず、読むときに集計する
- Insights の「運用」の節の小見出し「API の所要時間」（[`Ops.tsx`](../../apps/web/src/components/Ops.tsx)）: `total` の上位 10（method / route / 件数 / 中央値 / p90 / バイトの中央値）。route のセルを開くと日ごとの p50 / p90 / 件数。期間は節の「直近 7 日 / 30 日」の切り替えに従う（表は 7 日分しか無い）
- 同じ節の小見出し「速さ」は `perf_samples` の期間の比較（[perf.md](perf.md#ふだんの使用の記録639)）

### 限界

- **期間の p90 は日ごとの p90 から出さない**: 日ごとの分位を合わせても期間の分位にならないので、`total` は期間の行から別に出す
- **`days` が 8 以上でも 7 日分**: 表が 7 日しか持たない
- **転送の時間は無い**: `ms` はサーバの中だけ。転送と描画は `perf_samples` の `ms` との差で見る
- **WebSocket で届くもの**（イベントの配信）は数えない

### 検証

- `packages/core/src/accesslog.test.ts`: access log の行の `ms`
- `packages/core/src/db.test.ts`: `insertApiRequests` の保存と 7 日の削除
- `packages/core/src/core.test.ts` の `api_requests (#2101)`（route のキー・`content-length`・fallback を記録しない・停止の flush・書き込みの失敗）と `ops latency (#2102)`（集計・並び・bytes の null・期間）
- `apps/web/src/ops.test.ts` の `API latency rows (#2104)`

