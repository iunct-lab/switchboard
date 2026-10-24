# perf（主な操作の速さを同じ条件で測る）

Switchboard の主な操作（起動・Task を始める・開く・送る）の速さを、1 コマンドで同じ条件で測る（PBI #637）。どこが遅いかを数字で決め、速くした効果を前後の比較で確かめるため。
計測はローカルで閉じる。measure はページに残し、ふだんの使用の記録として自分のデーモンにだけ送る（#639。外には送らない — README の「No keys, no telemetry」の範囲）。CI のラチェットは #638。

デーモンの停止の回数と原因（Insights の「運用」）は [ops-metrics.md](ops-metrics.md)。サーバ側の API の所要時間（route ごと）は [ops-metrics.md の「API の所要時間」](ops-metrics.md#api-の所要時間2087)。

## 考え方（参考にしたもの）

参考: claude.ai を速くした取り組み（https://claude.dev/blog/how-we-made-claude-ai-faster）。要点:

- **ジャーニーで揃える**: 利用の 95% を占める 4 つのユーザージャーニー（起動 / 会話を始める / 既存の会話を開く / 送る）に計測を置き、どれも「利用者の操作で始まり、結果が描画されたら終わる」形にした。クライアントとサーバのどちらの仕事かを分けて見られ、画面どうしで比べられる
- **壁時計だけに頼らない**: 所要時間は揺れるので、ラボでは揺れない数（命令数、React の commit 数、スタイル再計算や DOM の変化の数、headless Chrome のフレーム制御）を併せて測り、それが壁時計の改善に効くことを確かめてから使った
- **ラチェット**: 確かめたベンチは CI の上限になり、悪くなった PR を落とす。数が良くなったら夜間のジョブが上限を下げる（上限は下がる一方）
- **ループ**: 遅い所を見つける → ラボで再現するベンチを作る → 小さい PR → デプロイ後の実測 → 効いたらラチェットで固定、効かなければやり直す → 次の遅い所。2 週間で 13 の計測の幾何平均が 3.1 倍速くなった

外部の似た仕組み: Lighthouse CI の assertion（指標ごとの上限で CI を落とす）、size-limit（組み込み結果の大きさの上限）。どちらも「上限を決めて超えたら落とす」までで、上限を自動で下げる部分は自前で持つ（#638）。

Switchboard では、命令数（Valgrind）と 120 Hz のフレーム制御はしない（PBI #637 のスコープ外。Web UI の重さはブラウザ側にあり、まずリクエスト数と Chrome の `LayoutCount` / `RecalcStyleCount` で足りるか見る）。

## 4 つのジャーニー

`apps/web/src/perf.ts` の `journeyStart(name)` が `performance.mark("sb:<name>:start")` を置き、`journeyEnd(name)` が描画の後（`requestAnimationFrame` 2 回）に `performance.measure("sb:<name>")` を残す（開始の時刻は終了を呼んだ時点で取る。描画を待つ間に同じジャーニーが始まっても動かない）。開始していない終了と二重の終了は何もしない。操作が失敗したら `journeyCancel(name)` で捨てる（後の関係ない終了で閉じないように）。名前は `packages/protocol/src/model.ts` の `Journey`。

| ジャーニー | 始まり | 終わり |
|---|---|---|
| `launch` | ページの読み込み（`performance.timeOrigin`。mark は置かない） | `App.tsx`: `api.tasks()` と `api.health()` の両方が返った後の描画（一覧が出て、入力欄のランナーと「開始」が使える） |
| `new-task` | `App.tsx` の `createTask` の先頭（Home の「開始」。作成に失敗したら捨てる） | `TaskView.tsx`: transcript に最初の項目が描かれた後 |
| `open-task` | `App.tsx` の `openTaskFromRail`（Rail で Task を押した。いま開いている Task を押し直したとき、他の画面からの遷移は測らない） | `TaskView.tsx`: 読み込んだ transcript の最後の項目が描かれた後。transcript は末尾 200 件から描き、前は「以前の会話を読む」で足す（#1142） |
| `send` | `TaskView.tsx` の `send()` の先頭 | `TaskView.tsx`: 送信の時点より新しい `session.end` を含む events が描かれた後（送信が失敗したら捨てる） |

Task 詳細 `GET /api/tasks/:id` のイベントは末尾 200 件（`limit`、上限 5000。`limit=0` はイベント無しでほかの項目だけ）。前のページは同じ経路の `?before=<seq>&limit=`（#1142）。切れ目が返答の途中（同じ `messageId` の `message.delta` が続くところ。長い返答は数百件）なら、その返答の最初の delta まで含めて返す（画面が返答の途中から始まらない。実データの一番長い Claude の Task は最後の返答だけで 441 件）。1 回の答えは 5000 件（`limit` の上限と同じ）までで、それより長い返答はそこで切る。このため下の「Task の大きさ」（#2100）の `bytes` は末尾の答えの大きさになる。`events` は最後の seq で数える（PBI #1142 の決定ログ 2026-10-24）。再接続の追いつき読みの `?after=`（#1137）は切らずに全部返す。新しい経路は作らず、引数を足す。

## ふだんの使用の記録（#639）

ラボに出ない遅さ（実データの量・実際のネットワーク・スマートフォン）に気づき、改善が実際の使用で効いたかを期間の前後で確かめるため、ふだんの操作で終わったジャーニーも残す。利用者は 1 人なので統計ではなく、同じ人の同じ操作を期間ごと・Task の大きさごとに比べる。

- **何を**: `journeyEnd` が measure を残すたびに `{ journey, device, build, ms, taskId, bytes, events }`。`build` は読み込んだモジュールの JS のファイル名のハッシュ（`/assets/index-<hash>.js` の `<hash>`。開発サーバーでは `dev`）で、記録はするが集計には使わない。`device` は画面幅 700px 未満なら `mobile`、それ以外 `desktop`
- **Task の大きさ**（#2100。`open-task` / `send` だけ、`launch` / `new-task` は null）: `taskId` = 描いた Task の id、`events` = その Task の最後のイベントの seq（#1142 から。画面は末尾しか持たないので、持っている件数ではなく Task の大きさを seq で数える。S3 に移した分の抜けも数に入る）、`bytes` = その Task の最後の、問い合わせの無い `GET /api/tasks/:id` の応答（展開後）のバイト数（#1142 から末尾。返答の頭までさかのぼって最大 5000 件）。`bytes` はブラウザの Resource Timing の `decodedBodySize` から取り、`api.ts` の `req` は変えない。再接続の追いつき読み（`?after=`、#1137）・ターンの後の取り直し（`?limit=0`）・前のページ（`?before=`）は Task の大きさではないので除く。Resource Timing の記録（ブラウザの既定で 250 件）が満杯になったら空にして、後の応答も記録させる（空にしたときに落ちた分は null = 不明）。列は `perf_samples` の `task_id` / `bytes` / `events`。この列より前の行は null のまま（埋めない）。新しい項目は省略を許さないので、昇格の前から開いているタブの古い形の POST は 400 で捨てる（互換層は作らない）
- **どこに**: Web UI（`apps/web/src/perf.ts`）が 5 秒まとめて（1 回 50 件まで、超えた分は捨てる）`POST /api/perf` で自分のデーモンに送り、デーモンの DB の `perf_samples` に入る。送信は既存の `req()`（認証ヘッダつき）。失敗しても再送せず、エラーも出さない（操作を止めない）。ただし `req()` の共通の扱いは残る（クラウドのホストが止まっている、パスキーの cookie が切れたときはログインの画面へ移る。次の操作の API でも同じになるので分けない）。API の上限（1 件 10 分）を超えた所要時間（10 分を超えるターン、終わるまで背面にあったタブ）は送らない。5 秒の待ちの間にタブを閉じた・背面のページをブラウザが破棄したときは、待っていた分を失う（背面に回っただけなら、戻ったときに送る。`sendBeacon` は認証ヘッダを付けられないので使わない。短い利用の最後の 1〜2 件が抜けることがある）。外部の計測サービスには送らない。perf-bench はこの POST を `requests` に数えない（ジャーニーの仕事ではない）
- **いつ消すか**: 保存のたびに 30 日より古い行を消す。定期ジョブは無い
- **見る場所**: Insights の「運用」の節の小見出し「速さ」（#2104。`GET /api/perf/summary`）。台帳の画面にはそこへのリンクだけを置く。行 = ジャーニー × 端末 × 大きさの階級、列 = 直近 7 日の中央値 / p90 / 件数、その前の 7 日の同じ数、変化。直近 7 日の中央値がその前の 7 日より 20% 以上遅い行は赤（変化は 0.1% に丸めた値で判定し、表の数字と赤が食い違わない）。片方の期間に記録が無い行も出し、その行は赤にならない。遅くなったときの通知は無い。Insights の「直近 7 日 / 30 日」の切り替えには従わない（比較が 7 日固定のため）
- **大きさの階級**（#2103）: `events`（#1142 から最後の seq。S3 に移した分も数に入る）で `small` 〜1,000 件 / `medium` 〜5,000 件 / `large` 5,000 件超、件数の無い行（`launch` / `new-task`、列を足す前の行）は「—」。境は定数。遅くなったのが大きい Task だけか、どの大きさでもかを分けて見るため
- **期間の比較**（#2103）: 直近 7 日（今から 7 日前まで）とその前の 7 日（14 日前から 7 日前まで）。件数・中央値・p90（nearest-rank）は各期間の行すべてから出す。期間は 7 日固定で設定にしない（`?days=` は無い）
- **版の比較をやめた理由**（#2087）: 以前は「今の版 vs 前の版」（版 = `build`）で比べていたが、版が数時間で入れ替わり、core だけの昇格では web のハッシュが変わらないので、比べる 2 つの版がどちらも細切れか、変更を挟んでいないことが多かった。期間で比べると昇格の回数に左右されない。代わりに、1 つの変更の効果は、その変更が入った日をまたぐ期間で見る（変更の前後を 7 日ずつ待つ）

## 回し方

```bash
bun run --cwd apps/web build
bun scripts/perf-bench.ts [--runs N] [--json <file>]      # N の既定は 5。Chrome は CHROME_BIN、無ければ /usr/bin/google-chrome → /usr/local/bin/chromium
```

1 回ごとに、新しいデーモン（`SWITCHBOARD_HOME` は一時ディレクトリ）と新しいタブで 4 つのジャーニーを順に動かす: `/` を開く（`launch`）→ Home で Workspace を選んで送る（`new-task`）→ Home に戻り Rail の `long` を押す（`open-task`）→ 返信を送る（`send`）。

- 偽ランナー: プロンプト `long` は 2,000 イベント（`tool.call` / `tool.result` / assistant の `message.delta` を決まった順で）、それ以外は `message.delta` 200 個を出して `session.end`。`long` の Task は起動の前に API で作って終わらせておく
- ブラウザ: headless Chrome、1280×800、`prefers-reduced-motion: reduce`（実行中の点の pulse がフレームごとにスタイルを再計算し、時間に比例して `RecalcStyleCount` が揺れるため）。フォント（`fonts.googleapis.com` / `fonts.gstatic.com`）は `Network.setBlockedURLs` で止める
- Home の Workspace は「自動」にしない（ランナーに選ばせる 1 ターンが挟まる）

## 数の意味

ジャーニーの数は、操作の直前から「measure が出て、`/api/` の通信が 500ms 静かになるまで」の差（ストリームの残りとそれが呼ぶ再取得も、そのジャーニーに入れる）。操作の前にも同じだけ静かになるのを待つ（画面が自分で始める読み込み — Home の候補の問い合わせは 250ms の debounce — を前のジャーニーにも次のジャーニーにも入れない）。表と JSON の値は N 回の中央値。

| 名前 | 意味 | 揺れ |
|---|---|---|
| `msMedian` / `msP90` | `sb:<journey>` の所要時間（ms）の中央値 / p90（nearest-rank） | 揺れる。ホストの負荷にも引きずられる（別の重い処理と同時に回したら 2〜3 倍になった）。表で見るだけにし、比較と CI には使わない |
| `requests` | `/api/` へのリクエスト数（CDP の `Network.requestWillBeSent`。WebSocket と、計測の送信 `POST /api/perf` は含まない） | `new-task` だけ ±1。Home が Task 一覧の変化ごとに `/api/history` を読み直し、作成の応答と WebSocket の `task.updated` が 1 回の描画にまとまるかで 1 回か 2 回になる（アプリ側の挙動。6 回中 5 回は 2 回） |
| `layoutCount` | `Performance.getMetrics` の `LayoutCount` の差 | ±1（並行する API の応答が同じフレームにまとまるか分かれるかの差。フレーム制御までは消えない） |
| `recalcStyleCount` | 同じく `RecalcStyleCount` の差 | ±1（`layoutCount` と同じ理由。reduced motion にしないと時間に比例して数十揺れる） |
| `layoutShift` | `PerformanceObserver`（`layout-shift`、入力直後を除く）の値の合計 | 小数の下の桁が揺れる |
| `bundle` | `apps/web/dist/assets/*.js` / `*.css` を gzip したバイト数の合計 | 同じコードなら一致する |

`--json <file>` の形: `{ runs, journeys: { <name>: { msMedian, msP90, requests, layoutCount, recalcStyleCount, layoutShift } }, bundle: { js, css } }`。
同じコードで 2 回回したとき一致を前提にしてよいのは `bundle` だけ。`requests`・`layoutCount`・`recalcStyleCount` は ±1 の幅で比べる（#637 の決定ログ）。揺れの元はどれもアプリの描画のまとまり方で、ラボの側では消せない（フレーム制御はスコープ外）。

## ラチェット（CI の上限）

改善の回し方（遅いジャーニーを選ぶ → ラボで再現 → 1 PR 1 改善で前後の表 → 同じ PR で上限を下げる → マージ後の実測）はスキル `.claude/skills/perf-loop/SKILL.md`。

確かめた数を上限にし、上限は下がる一方にする（#638）。上限は `scripts/perf-budget.json`（ジャーニーごとの `requests` / `layoutCount` / `recalcStyleCount` / `layoutShift` と `bundle` の `js` / `css`）。所要時間は比べない。

`open-task` の `layoutShift` と `send` の `layoutCount` は両環境の上限から外し、計測の表でだけ見る（#644 の最新の回答 A）。同じコード・同じ Actions 環境の中でも、入力欄が消えて戻る描画のまとまり方で幅を超えて動いたため。残りの項目と bundle は判定を続ける。

上限は環境ごとに 1 組（#644 の回答 A）: `github`（Actions の ubuntu-latest の Chrome）と `local`（ホストの `/usr/local/bin/chromium`。ローカル CI が使う）。`GITHUB_ACTIONS=true` なら `github`、そうでなければ `local`（ローカル CI は `CI=true` を付けるが `GITHUB_ACTIONS` は付けない）。`--env github|local` で選び直せる。分ける理由: フォントをそろえても（perf-bench が Noto Sans + Noto Sans CJK だけを見せる）、マシンの速さで描画のまとまり方が変わり、同じコードで幅より大きく違う数が残る（2026-10-01: open-task の `layoutShift` CI 0.0002 / ホスト 0.047、send の `layoutCount` 5 / 3〜4。入力欄が一瞬消えて戻る描画が、遅いホストでは別のフレームになる）。この2項目は同じ環境の中でも幅に収まらないことが分かったため、上記の回答Aで判定から外した。環境ごとの上限は、ほかの項目の実測値の差に引き続き使う。

```bash
bun scripts/perf-bench.ts --runs 5 --json perf-result.json      # CI と同じ 5 回の中央値（1 回だけだと幅より大きく動く）
bun scripts/perf-ratchet.ts check perf-result.json     # 超え / 良くなった / main より上げた、のどれかがあれば exit 1（その環境の上限で）
bun scripts/perf-ratchet.ts update perf-result.json    # 良くなった上限だけを 値 + 幅 に下げる。上げない
bun scripts/perf-ratchet.ts update perf-result.json --env github   # github の上限を下げる。Actions の結果は、check が落ちた run の log の最後に出る JSON をファイルにして渡す
```

- **幅**: 同じコードでも動く数には固定の幅を持つ（上の「数の意味」の ±1。5 回の中央値の揺れ）。`requests` / `layoutCount` / `recalcStyleCount` は 1、`layoutShift` は 0.03（2026-10-01 の `--runs 5` 6 回で launch 0.2602〜0.2831）、`bundle` は 0。設定にはしない（幅は同じコードの揺れで、どれだけ悪くしてよいかではない）。`--runs 1` は幅を超えて動く（同じ日の 14 回で launch の `layoutCount` 4〜6、`layoutShift` 0.2598〜0.3523）ので、`check` / `update` には 5 回の結果を渡す
- **上限 = 値 + 幅**: 超え = 値 > 上限、良くなった = 値 < 上限 − 2 × 幅（測った値より幅を超えて下）。良くなったら CI が落ち、同じ PR で `update` して下げさせる（両側のゲート）。同じコードの揺れの範囲（測った値 ± 幅）はどちらにも当たらない — 「良くなった」を 上限 − 幅 にすると、同じコードで今までの最小より 1 つ下が出るたびに関係の無い PR の CI が落ちた（2026-10-02、Actions の send の `layoutShift` 0.0104 → 0.0103）。代わりに、揺れない側の 1 の悪化（例: open-task の `requests` 5 → 6）と、幅までの改善は通る
- **CI**: `scripts/ci.ts` の手順（Actions の `ci.yml` が走らせる）で、web の build の後に、`origin/main` の fetch → `perf-bench.ts --runs 5` → `perf-ratchet.ts check`（Actions が始まらないときは `scripts/local-ci.ts` が同じ手順を回す）
- **上げる**: `check` は `origin/main` の `scripts/perf-budget.json` より上げた項目があれば exit 1（測った環境だけでなく `github` / `local` の両方。Actions で `local` を上げた PR も落ちる）。上げるのは利用者が CI の赤を見て手でマージする判断。ただし 1 PR での bundle（js / css）の gzip の増加が 1% 未満なら、理由と増分を PR 本文に書いて同じ PR で上限を上げてよい（`check` は `raised` で赤のまま。利用者に聞かずにマージしてよい。利用者の決まり、2026-10-07、#1056）。1% 以上の増加と、ほかの項目を上げるのは利用者に聞く
- 初期値: `local` は 2026-10-02、main（462c6d4）、AWS ホスト（`/usr/local/bin/chromium`）、`--runs 5` を 7 回の最小 + 幅（new-task の `layoutCount` 7〜8、`layoutShift` 0.012〜0.0198 は 7 回目で初めて下側が出た）。`github` は同じコードの Actions の `--runs 5` 5 回の最小 + 幅。2026-10-14: `local` の `new-task` / `open-task` / `send` の `requests`（14 / 6 / 6 → 16 / 8 / 8）と両環境の `bundle`（js 195128 → 206877、css 6336 → 6574）を main（ad4f9cc）で測り直した（`--runs 5` 3 回の最小 + 幅、bundle は実測値。#1368）。リクエストの増えは Brief の `/evals`（#1224 / #1236 / #1253）と `/device-auth`（#676）の読み込み。2026-10-16: `local` の `launch` の `recalcStyleCount`（6 → 7）と `layoutShift`（0.1614 → 0.2371）、両環境の `bundle`（js 206877 → 211466、css 6574 → 6687）を main（792b146）で測り直した（同じ測り方。main だけで超え、Web に触れない PR のローカル CI がすべて赤になっていたため、利用者の判断で上げた。#1282。`launch.layoutShift` の原因は #1056）。2026-10-20: `local` の `new-task` の `requests`（16 → 18）と `layoutCount`（8 → 9）、両環境の `bundle`（js 220782 → 225121、css 7230 → 7364）を main（bfa143fa）で測り直した（同じ測り方。#1999）。`requests` を超えさせたのは #1810（Task 画面の成果物タブの `/artifacts` の読み込み。中央値 16 → 17。7eaf49ce より前に入った。7eaf49ce でも 17 で、#1826 は `bundle` の上限だけを直した）。#1846 も Home の最新レポートの行の `/api/reports` を 1 つ足した（中央値は 17 のまま。`/api/history` の回数が揺れる）。`layoutCount` は 3 回のうち 1 回だけ 9 で、幅の揺れ。`bundle` を超えさせたのは #1846（Insights のレポートの節）で、そのあとの #1912 / #1925 / #1926 / #1932 / #1974 / #2010 / #2018 / #2034 / #2044 も足した（#2039 は減らした）。sweep のテストの赤（#1998）で 2026-10-18 からローカル CI の性能の判定が走らず、気づかれなかった。2026-10-22: 両環境の `bundle.js`（225121 → 230322、+2.3%）を main（d97fa952）の実測値に合わせた（#1188。#1056 の回答で「main の値に上げる」。#1182 の計測の時点では +0.44% で、その後の main の PR で増えた。#2001 以降、上限を上げずに入った増加の積み重ね）

## テストの揺れ

ローカル CI は約 1,400 件の `bun test` を 1 プロセスで回す（3.8 GB のホストで、レビュー用のサブエージェントも同時に動く）。#1232 では PR と関係のない 3 件が、同じ head でも回すたびに落ちたり通ったりした（単独で回すと pass）。落ちたのは `scheduler.test.ts` の「secret-scan: POST /api/schedules/:id/run answers 202 at once」、`dak/src/parse.test.ts` の「artifact: an inlineData part …」、`backlog.test.ts` の「promote: when idle — a promotion held by a running Task …」。

- **原因（コードを読んだ見立て。失敗の文は再現できていない）**: 時間の仮定。3 件とも、子プロセスの起動（scheduler の `bun ops-kit/src/cli.ts`）、HTTP の往復 3 ターン（dak）、git を伴う昇格（backlog）を、bun test の既定のテストごとの上限 5 秒に収めていた。待ちも固定の長さで区切っていた（scheduler: 25 ms × 200 回、backlog の `settle` / `started`: 10 ms × 200 回、dak の `waitFor`: 5 秒）。回数の待ちは `sleep` が延びるほど長くなるので上限そのものではなく、効いているのはテストごとの 5 秒と、dak の 5 秒の `waitFor` のほう。dak の `attachmentDir` は `mkdtempSync` の専用ディレクトリで、ファイル名の衝突ではない。2026-10-17 に修正前の main で、並行して `bun run --cwd apps/web build` を回しながら全スイートを 5 回回したが、この 3 件は 1 回も落ちなかった。だから修正後の 5 回の緑（同じ負荷）は、直ったことの証明ではない。この節の直しは、再現した失敗に対する直しでなく、時間の仮定を外す予防
- **直し方**: 期待値は変えず、待つ上限だけを変える。待ちは回数でなく締め切り（20 秒）で区切り、そのテストに `30_000` を付ける。`bunfig.toml` の全体の既定は変えない（遅いテストを全部見えなくする）。`retry` で包まない（揺れを隠す）
- **新しいテストで外部プロセス・HTTP・git を待つとき**: 待ちのループは `Date.now() - t0 < 20_000` の締め切りで区切る。そのテストの上限は 5 秒のままにせず `30_000` を付け、理由のコメントにこの節を書く（型は `transfer.test.ts` の `}, 30_000);`）

## 2026-10-17: Bun 1.4.2 → 1.4.3（#1571）

ホストの bun は 2026-10-14 に 1.4.3 へ上がっている。同じホスト（arm64 Linux、2 コア）・同じ main（45129849）の build で、1.4.2（`bunx bun@1.4.2 scripts/perf-bench.ts --runs 5`）と 1.4.3（`bun scripts/perf-bench.ts --runs 5`）を続けて測った:

| journey | ms median 1.4.2 / 1.4.3 | requests | LayoutCount | RecalcStyleCount |
|---|---:|---:|---:|---:|
| launch | 460.6 / 453.7 | 12 / 12 | 5 / 4 | 6 / 6 |
| new-task | 277 / 305.5 | 16 / 16 | 8 / 8 | 8 / 8 |
| open-task | 353.6 / 383.9 | 7 / 7 | 4 / 4 | 4 / 4 |
| send | 553.1 / 602.7 | 7 / 7 | 5 / 5 | 4 / 4 |

数える 3 列は 1.4.2 を超えない（`launch` の LayoutCount だけ 5 → 4）。ms は 2 コアの共有ホストで揺れる（new-task / open-task / send は 1.4.3 のほうが 8〜10% 遅く出たが、1 回ずつで、順番も 1.4.2 が先）ので退行とは読まない。ms は上限の対象外（`requests` などの上限は変えない）。

待機中のデーモン（Task 0 件の偽ランナー、`startServer` を `port: 0`、起動後 20 秒置いてから 300 秒）の CPU 時間（`/proc/<pid>/stat` の utime + stime、100 ticks/s）:

| Bun | 300 秒の CPU 時間 |
|---|---:|
| 1.4.2 | 9 ticks（90 ms） |
| 1.4.3 | 5 ticks（50 ms） |

1.4.3 のほうが 44% 少ない。1 回ずつの測定で、tick が 10 ms 単位なので、見るのは「減った向き」まで。

## 今の値

2026-09-29、main（ed7c110）+ #640 / #641 のレビュー修正まで（f1fe08d / d003684）、AWS ホスト（arm64 Linux、`/usr/local/bin/chromium`）、`--runs 5` を 2 回:

| journey | ms median | ms p90 | requests | LayoutCount | RecalcStyleCount | layoutShift |
|---|---:|---:|---:|---:|---:|---:|
| launch | 425.3 / 408.1 | 540 / 541 | 12 / 12 | 4 / 4 | 6 / 6 | 0.2602 / 0.2623 |
| new-task | 164.7 / 165.6 | 258.8 / 167.9 | 13 / 13 | 8 / 7 | 8 / 8 | 0.0305 / 0.0235 |
| open-task | 306.9 / 314.8 | 355.9 / 382.5 | 5 / 5 | 3 / 3 | 3 / 3 | 0.047 / 0.047 |
| send | 485.7 / 414.3 | 509.7 / 615.4 | 5 / 5 | 4 / 4 | 4 / 4 | 0.0193 / 0.0127 |

bundle (gzip): js 184,313 B、css 6,003 B（2 回とも同じ）。この 2 回では `requests` は一致し、`layoutCount` が new-task で 8 / 7。その前の 2 回（d003684 の前）では new-task の `requests` が 13 / 12、launch の `layoutCount` と `recalcStyleCount` も ±1 だった。

目に付くもの（速くする PBI の候補。数字を見て起こす）: `launch` の `layoutShift` 0.26（どの要素がずれるかは未調査）、`new-task` の 12〜13 リクエスト（`/api/history` の読み直しが 3 回、Task の `checks` が 2 回、作った Task の詳細が 2 回）。

2026-10-03: 初回のCI導入前にmain（aa4e839）のbuildを単独で測り、bundle.jsの初期上限を186859 Bへ合わせた（CSSは6031 B）。#871の予定画面が増えた分で、PR #810のコードによる増加ではない。

### 2026-10-21: ローカル CI の環境で `launch.layoutShift` が超える（#1056、#1182）

条件: AWS ホスト（arm64 Linux、`/usr/local/bin/chromium`、Noto フォント）。`env -i PATH HOME CI=true TMPDIR=<dir>`（`scripts/local-ci.ts` の `stepEnv` と同じ）で `bun scripts/perf-bench.ts --runs 5` → main（eb82f835）の `bun scripts/perf-ratchet.ts check --env local`（上限 0.2371）。TMPDIR は RAM = `/tmp`（tmpfs）、ディスク = `~/.cache`（root ディスク。ローカル CI と同じ場所）。条件は交互に回し、ほかの性能計測とは並行していない。判定は launch.layoutShift 以外のキーも全部。main の行は `improved` / `raised` が無い。

| commit | TMPDIR | 回 | launch.layoutShift | check の判定（exit 1 の理由） |
|---|---|---:|---:|---|
| 462c6d4（`local` の初期値の commit） | RAM | 1 | 0.2152 | over なし。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| 462c6d4 | RAM | 2 | 0.2060 | over なし。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| 462c6d4 | ディスク | 1 | 0.3046 | launch.layoutShift。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| 462c6d4 | ディスク | 2 | 0.2967 | launch.layoutShift。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| main eb82f835 | RAM | 1 | 0.1779 | bundle.js |
| main eb82f835 | RAM | 2 | 0.2031 | bundle.js |
| main eb82f835 | ディスク | 1 | 0.2938 | launch.layoutShift, bundle.js |
| main eb82f835 | ディスク | 2 | 0.2943 | launch.layoutShift, bundle.js |
| main eb82f835 | ディスク | 3 | 0.3147 | launch.layoutShift, bundle.js |
| main eb82f835 | ディスク | 4 | 0.2938 | launch.layoutShift, bundle.js |
| main eb82f835 | ディスク | 5 | 0.2943 | launch.layoutShift, bundle.js |
| 文書のみの PR #2168（pull/2168/merge） | ディスク | 1 | 0.1688 | bundle.js（launch.layoutShift は improved） |
| PR #2168 | ディスク | 2 | 0.3008 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 3 | 0.2943 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 4 | 0.2943 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 5 | 0.2943 | launch.layoutShift, bundle.js |

結論: 同じ commit で TMPDIR だけで超える／超えない（RAM 0.18〜0.22、ディスク 0.29〜0.31。ディスクでも 1 回だけ 0.1688 が出た）。commit の差ではない。`local` の上限（0.2371 = 0.2071 + 幅）は RAM の TMPDIR の値と合う（上限の測り直しは普段のシェルで、TMPDIR は既定の `/tmp`）。ローカル CI はディスクの TMPDIR で回している。2026-10-19〜21 のローカル CI の失敗ログでも 0.316〜0.347。`bundle.js` の超え（main 226104 > 225121）は揺れではなく、main が上限より大きい（上限を上げずに入った増加）。ほかのキーは 16 回とも上限に収まった。

上限 0.1614（#1056 を起こした 2026-10-02 の値）に対しては、RAM の値も超える。同じ 462c6d4 の RAM の値が 2026-10-02 の 0.13 台（上限 = 最小 + 0.03）から 0.21 前後に上がっているので、10-02 以降にホスト側（Chrome・フォントなど）でも値が動いた。#1282 の 0.2371 はその上がった RAM の値で測り直したもので、今のローカル CI の赤を分けるのは TMPDIR だけ。

2026-10-22: 利用者の回答 A（#1056）で、`scripts/local-ci.ts` の TMPDIR を `~/.cache` から OS の一時ディレクトリ（`tmpdir()`。このホストでは RAM の `/tmp`）に戻した（#1188。worktree は `~/.cache` のまま）。上限は変えず、ローカル CI の環境を上限を測った環境にそろえた。直した PR #2275 自身のローカル CI では `launch.layoutShift` 0.2289（上限 0.2371）で `over` は 0（赤は `bundle.js` の上限を上げた `raised` だけ）。
