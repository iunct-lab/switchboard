# perf（主な操作の速さを同じ条件で測る）

Switchboard の主な操作（起動・Task を始める・開く・送る）の速さを、1 コマンドで同じ条件で測る（PBI #637）。どこが遅いかを数字で決め、速くした効果を前後の比較で確かめるため。
計測はローカルで閉じる。measure はページに残し、ふだんの使用の記録として自分のデーモンにだけ送る（#639。外には送らない — README の「No keys, no telemetry」の範囲）。CI のラチェットは #638。

## 考え方（参考にしたもの）

参考: claude.ai を速くした取り組み（https://claude.dev/blog/how-we-made-claude-ai-faster）。要点:

- **ジャーニーで揃える**: 利用の 95% を占める 4 つのユーザージャーニー（起動 / 会話を始める / 既存の会話を開く / 送る）に計測を置き、どれも「利用者の操作で始まり、結果が描画されたら終わる」形にした。クライアントとサーバのどちらの仕事かを分けて見られ、画面どうしで比べられる
- **壁時計だけに頼らない**: 所要時間は揺れるので、ラボでは揺れない数（命令数、React の commit 数、スタイル再計算や DOM の変化の数、headless Chrome のフレーム制御）を併せて測り、それが壁時計の改善に効くことを確かめてから使った
- **ラチェット**: 確かめたベンチは CI の上限になり、悪くなった PR を落とす。数が良くなったら夜間のジョブが上限を下げる（上限は下がる一方）
- **ループ**: 遅い所を見つける → ラボで再現するベンチを作る → 小さい PR → デプロイ後の実測 → 効いたらラチェットで固定、効かなければやり直す → 次の遅い所。2 週間で 13 の計測の幾何平均が 3.1 倍速くなった

外部の似た仕組み: Lighthouse CI の assertion（指標ごとの上限で CI を落とす）、size-limit（組み込み結果の大きさの上限）。どちらも「上限を決めて超えたら落とす」までで、上限を自動で下げる部分は自前で持つ（#638）。

Switchboard では、命令数（Valgrind）と 120 Hz のフレーム制御はしない（PBI #637 のスコープ外。Web UI の重さはブラウザ側にあり、まずリクエスト数と Chrome の `LayoutCount` / `RecalcStyleCount` で足りるか見る）。

## 4 つのジャーニーと `open-task-huge`

`apps/web/src/perf.ts` の `journeyStart(name)` が `performance.mark("sb:<name>:start")` を置き、`journeyEnd(name)` が描画の後（`requestAnimationFrame` 2 回）に `performance.measure("sb:<name>")` を残す（開始の時刻は終了を呼んだ時点で取る。描画を待つ間に同じジャーニーが始まっても動かない）。開始していない終了と二重の終了は何もしない。操作が失敗したら `journeyCancel(name)` で捨てる（後の関係ない終了で閉じないように）。名前は `packages/protocol/src/model.ts` の `Journey`。

| ジャーニー | 始まり | 終わり |
|---|---|---|
| `launch` | ページの読み込み（`performance.timeOrigin`。mark は置かない） | `App.tsx`: `api.tasks()` と `api.health()` の両方が返った後の描画（一覧が出て、入力欄のランナーと「開始」が使える） |
| `new-task` | `App.tsx` の `createTask` の先頭（Home の「開始」。作成に失敗したら捨てる） | `TaskView.tsx`: transcript に最初の項目が描かれた後 |
| `open-task` | `App.tsx` の `openTaskFromRail`（Rail で Task を押した。いま開いている Task を押し直したとき、他の画面からの遷移は測らない） | `TaskView.tsx`: 読み込んだ transcript の最後の項目が描かれた後。transcript は末尾 200 件から描き、前は「以前の会話を読む」で足す（#1142） |
| `send` | `TaskView.tsx` の `send()` の先頭 | `TaskView.tsx`: 送信の時点より新しい `session.end` を含む events が描かれた後（送信が失敗したら捨てる） |

**`open-task-huge`** (perf-bench only, not a `Journey` of the app): after `send`, perf-bench makes a task of 20,000 events named `huge` and opens it from the Rail. It reads the same `sb:open-task` measure (the app's action is the same open; only the bench names the size) and clears that measure before the action, so the second open in the page is not read as the first. It comes last so that the four journeys' counts do not move: made before `launch`, it would add a row to the Rail. Why 20,000: real tasks on the host held 18,866 events (6.8 MB) to 33,110 events (2026-10-20). Since the task screen reads the last page only (below), its responses are about as big as the 2,000-event `open-task`'s (36,106 B against 35,597 B on 2026-11-04). Its `bytes`, compared with the tag before, catches a change that reads the whole task again: with 20,000 events that grows by an order of magnitude, far over 1%. A `--runs 5` takes about 20 s more with it (36 s → 56 s without `loaded`, 2026-11-04).

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

## Load and overlap

The four journeys run on a nearly empty home, so they show neither what grows with the data nor the delay when background work overlaps. After them `perf-bench` always measures `launch` and `send` once more on another daemon, in one run (`LOADED_RUNS`; `--runs` does not apply). local-ci skips it for a change that does not reach perf-bench (`--skip-loaded`; the result then has `loadedSkipped` and no `loaded`, and the ceiling is not judged); the tag CI and Actions always measure it ([local-ci.md](local-ci.md), "Skipping perf-bench's `loaded`").

- **Size**: `LOAD` in `scripts/perf-load.ts`: 1,500 Tasks, 30,000 backlog records, 4,000 `backlog_operations`, from the real home on 2026-10-27 (1,403 / 28,224 / 3,897). `seedLoad` makes them through `Db` and the real import; nothing is read or copied from a real home. The database is about 80 MB, the real size. It is generated once before the runs, and each run starts a daemon on a copy.
- **What overlaps** (with `launch` only): (a) one `POST /api/backlog/sync`. The fake GitHub (`loadGh`) raises its `generation`, so the import rewrites every Issue: heavier than a usual import, on the side of not missing a stall. (b) The rescue page's status check: `checkDaemon` and `tasksThatStop` from `rescue/src/promote.ts`, called as they are every 2 s.
- **Window**: from the start of the import until both the journey has gone quiet and the import has answered. The wait for quiet before the action is outside it. Only `launch` has a window: `send` runs on the same loaded daemon with no import, and opening `long` before it is not counted. A failed import fails the run. A loaded journey waits up to 5 minutes, so a daemon stuck for longer than the journeys' usual 30 s reads as a high value rather than a timeout.
- **Daemon delay**: `/api/health` every 50 ms inside the window, keeping the longest. The value is that window's longest. The daemon shares this process with the measuring code, so a stall stops the timer too: the time counts from when the call was due. Counted from the start of the call, a stall would read as the fast answer after it.
- **Why one run and one import** (2026-11-03): five runs with two imports each took about 8 minutes of every local CI run while holding the machine's one heavy-job slot, so a 3-second type check of another Task waited behind it. The measure tells a daemon stuck for minutes from a working one (a version before the fixes measured 486,958 ms against a ceiling of 5,440 ms); a stall of a few seconds stayed inside the spread of the same code even with five runs. One import under `launch` keeps the first and costs a tenth of the imports (one instead of five runs × two).
- **Duration**: perf-bench with `--runs 5` takes 69 to 82 s in all (five measures on 2026-11-03), about 30 s of it `loaded`; before this change it took 430 to 620 s in local CI runs.

`loaded` in the result JSON:

```json
{ "tasks": 1500, "backlogRecords": 30000, "operations": 4000, "overlap": ["backlog-sync", "rescue-status"],
  "journeys": { "launch": { "msMedian": 0, "msP90": 0 }, "send": { "msMedian": 0, "msP90": 0 } },
  "healthMaxMs": 0, "healthMaxMsP90": 0 }
```

With one run, `healthMaxMs` and `healthMaxMsP90` are both that run's value (the fields keep the shape of several runs). The `launch` / `send` times are for reading in the table, like every time in this document; they are no ceiling.

## 数の意味

ジャーニーの数は、操作の直前から「measure が出て、`/api/` の通信が 500ms 静かになるまで」の差（ストリームの残りとそれが呼ぶ再取得も、そのジャーニーに入れる）。操作の前にも同じだけ静かになるのを待つ（画面が自分で始める読み込み — Home の候補の問い合わせは 250ms の debounce — を前のジャーニーにも次のジャーニーにも入れない）。表と JSON の値は N 回の中央値。

| 名前 | 意味 | 揺れ |
|---|---|---|
| `msMedian` / `msP90` | `sb:<journey>` の所要時間（ms）の中央値 / p90（nearest-rank） | 揺れる。ホストの負荷にも引きずられる（別の重い処理と同時に回したら 2〜3 倍になった）。表で見るだけにし、比較と CI には使わない |
| `requests` | `/api/` へのリクエスト数（CDP の `Network.requestWillBeSent`。WebSocket と、計測の送信 `POST /api/perf` は含まない） | `new-task` だけ ±1 だった。Home が Task 一覧の変化ごとに `/api/history` を読み直し、作成の応答と WebSocket の `task.updated` が 1 回の描画にまとまるかで 1 回か 2 回になっていた（アプリ側の挙動。6 回中 5 回は 2 回）。2026-11-03 に Terminal の履歴が Settings に移り、Home はこの読み直しをしない。揺れが消えたかは次の計測で見る |
| `layoutCount` | `Performance.getMetrics` の `LayoutCount` の差 | ±1（並行する API の応答が同じフレームにまとまるか分かれるかの差。フレーム制御までは消えない） |
| `recalcStyleCount` | 同じく `RecalcStyleCount` の差 | ±1（`layoutCount` と同じ理由。reduced motion にしないと時間に比例して数十揺れる） |
| `layoutShift` | `PerformanceObserver`（`layout-shift`、入力直後を除く）の値の合計 | 小数の下の桁が揺れる。タイミングで配置が変わる画面はもっと広がる（`launch` は同じコミットで 0.17〜0.31。下の 2026-10-21 の計測） |
| `bytes` | The size of the journey's `/api/` responses: the sum of CDP's `Network.loadingFinished` `encodedDataLength` over the same requests as `requests` (not `POST /api/perf`). The daemon does not compress, so this is the responses' size | Does not wobble: three `--runs 5` on 2026-11-04 gave the same value every time, for every journey. The daemon writes the responses, whatever the Chrome. The bench's tasks run in a repository perf-bench makes, not in the checkout: a task's cwd is in its responses, and so is its footprint (the files and bytes under the cwd). With the checkout, a local-ci worktree's longer path moved `bytes`, and so did main growing from 999 to 1,002 files (one more digit, one more byte, 2026-11-04). The bench's repository has a path of fixed length (`/tmp/sb-perf-bench-repo-XXXXXX/repo`), one README in one commit, and a sparse file of 11,000,000 B left out of Git, which keeps the Task screen's context meter full, as the checkout does |
| `bundle` | `apps/web/dist/assets/*.js` / `*.css` を gzip したバイト数の合計 | 同じコードなら一致する |

`--json <file>` の形: `{ runs, journeys: { <name>: { msMedian, msP90, requests, layoutCount, recalcStyleCount, layoutShift, bytes } }, bundle: { js, css } }`。`<name>` is one of `launch`, `new-task`, `open-task`, `send` and `open-task-huge`. `open-task` and `open-task-huge` also have `responses`: `{ "<path shape>": { count, bytes } }`, the same bytes by the shape of the response's path (an id segment such as a task id becomes `:id`), from the last run.
同じコードで 2 回回したとき一致を前提にしてよいのは `bundle` だけ。`requests`・`layoutCount`・`recalcStyleCount` は ±1 の幅で比べる（#637 の決定ログ）。揺れの元はどれもアプリの描画のまとまり方で、ラボの側では消せない（フレーム制御はスコープ外）。

In late October 2026 two `launch` counts failed and passed again on the same head and base, for two different reasons. `launch.requests` failed as 14 > 13: a web change merged without a perf run had moved the median to 14, so it went back and forth across the ceiling 13. That was a median sitting on its ceiling, not a band that was too narrow; the ceiling went to 14 with the user's OK on 2026-10-27. `launch.layoutShift` was the other kind: in the 2026-10-21 measurement below it spread from about 0.17 to 0.31 on one commit (the ceiling was 0.2371 then), and the flips at the later ceiling 0.1959 fit the same kind of spread, wider than the 2 × 0.03 between over and improved. On 2026-11-02 the start screen began drawing its body after the health answer; the value fell to 0.0184 and the ceiling to 0.0467, and ceiling − 2 × band is now below 0, so it cannot be `improved` either. Five runs of local-ci's perf steps on main on 2026-11-02, one at a time with no other local-ci, `bun test` or perf-bench running, gave `launch.requests` 14 and `launch.layoutShift` 0.0184 every time, and every check passed. The bands were left as they are. When a count flips again, measure five runs on main first and tell the two kinds apart: a median on its ceiling needs the cause found (or the ceiling raised, which is the user's call); a spread wider than the band needs the cause of the spread found, and widening the band is the last resort, from the measured spread.

## ラチェット（CI の上限）

改善の回し方（遅いジャーニーを選ぶ → ラボで再現 → 1 PR 1 改善で前後の表 → 同じ PR で上限を下げる → マージ後の実測）はスキル `.claude/skills/perf-loop/SKILL.md`。

**Where this runs: the tag CI, not a PR.** A PR's local CI does not run the perf steps (no web build for the bench, no `fetch main`, no perf-bench, no perf-ratchet), so a PR never fails on the bench's `over:` / `raised:` / `improved:` / `grew:`, and the merge gate counts its `[local-ci] pass` without any perf result. The one ceiling a PR's local CI still compares is its own seconds (`local.durations`, the type check's and `bun test`'s, in the bullet on times below): over it, the PR fails with `over: durations.*`. The tag CI (`scripts/tag-ci.ts`) on the commit main reached runs every step, perf included, and the verdict is in the Release's `## CI` part. The text below says "the PR's value" and "the check" for the measure and the comparison themselves; they happen in the tag CI's run. An `over:` there fails the tag. The comparisons (`grew:` for the bundle and `bytes`, `raised:` for the ceilings) are with the tag before this one (`PERF_BASE_REF`, which `tag-ci.ts` sets; the first tag is compared with `origin/main`'s tip as the tag CI fetches it), so `grew:` / `raised:` show what the tag added. When a tag holds several merges the growth is their sum; which merge it came from is followed with `history` and `git log`. A `grew:` or `raised:` alone counts as a pass anyway, marked `(raised/grew only)` in the `[tag-ci]` line (see the tag CI in `releases-and-rescue.md`). The growth of the bundle and `bytes` over the merges is followed in the rows the tag CI writes to `perf-records` (`history`, **bundle の推移** below), and is dealt with after the merge: a request for the fix, or going back to an earlier tag.

**The rule for every count: a value that does not wobble is compared with the tag before (the compared ref), not with a ceiling.** A count that comes out the same every time for the same code has no absolute ceiling. The tag's value is compared with the value of the tag before (the first tag: `origin/main`'s tip), measured in the same run. A PR that adds 1% or more fails (`grew:`); a smaller growth passes and is printed with the difference. The compared ref's value of each run goes to the `perf-records` branch, so growth that adds up over many PRs can be looked back at with `history` (**bundle の推移** below). Today that is the bundle and `bytes`, and both share one 1% (`BUNDLE_GROWTH_LIMIT`). Nobody is asked to raise a ceiling for them, and no PR raises one: a ceiling with no room fails every PR that adds a byte, so it only hands the user a decision and prevents nothing. The user set this rule for the bundle on 2026-10-30. On 2026-11-05 it became the rule for every such count, after three PRs in a row stopped on 44 B of `open-task` (one response read twice that grew by 22 B) and each one asked the user whether to merge. The counts that keep an absolute ceiling, and why:

- `requests`, `layoutCount`, `recalcStyleCount`: the same code moves them by ±1 even as a median of five runs. Judging them against the compared ref would need it measured five times in every run and a band for the comparison; moving them is a change of its own.
- `layoutShift`: moves in its low digits, and on some screens by more than its band (below).
- `loaded.healthMaxMs` and `durations` (the type check's and `bun test`'s seconds): times, moved by the host's load. They are judged on the high side only.

A new count follows the same split: one that does not wobble is compared with the compared ref and recorded; one that wobbles gets a ceiling, with a band measured for it.

確かめた数を上限にし、上限は下がる一方にする（#638）。上限は `scripts/perf-budget.json`（ジャーニーごとの `requests` / `layoutCount` / `recalcStyleCount` / `layoutShift`、`local` の `loaded.healthMaxMs`）。The bundle and `bytes` have no ceiling: they are compared with the tag before in the same run (**Bundle** and **`bytes`** below).

`loaded.healthMaxMs` と、下の「bun test の所要秒と型検査の所要秒」のほかの所要時間は比べない。

`open-task` の `layoutShift` と `send` の `layoutCount` は両環境の上限から外し、計測の表でだけ見る（#644 の最新の回答 A）。同じコード・同じ Actions 環境の中でも、入力欄が消えて戻る描画のまとまり方で幅を超えて動いたため。残りの項目は判定を続ける。

上限は環境ごとに 1 組（#644 の回答 A）: `github`（Actions の ubuntu-latest の Chrome）と `local`（ホストの `/usr/local/bin/chromium`。ローカル CI が使う）。`GITHUB_ACTIONS=true` なら `github`、そうでなければ `local`（ローカル CI は `CI=true` を付けるが `GITHUB_ACTIONS` は付けない）。`--env github|local` で選び直せる。分ける理由: フォントをそろえても（perf-bench が Noto Sans + Noto Sans CJK だけを見せる）、マシンの速さで描画のまとまり方が変わり、同じコードで幅より大きく違う数が残る（2026-10-01: open-task の `layoutShift` CI 0.0002 / ホスト 0.047、send の `layoutCount` 5 / 3〜4。入力欄が一瞬消えて戻る描画が、遅いホストでは別のフレームになる）。この2項目は同じ環境の中でも幅に収まらないことが分かったため、上記の回答Aで判定から外した。環境ごとの上限は、ほかの項目の実測値の差に引き続き使う。

```bash
bun scripts/perf-bench.ts --runs 5 --json perf-result.json      # CI と同じ 5 回の中央値（1 回だけだと幅より大きく動く）
bun scripts/perf-ratchet.ts base origin/main perf-base.json   # 比べる相手（タグの CI は前のタグ、PERF_BASE_REF。最初のタグと PR は origin/main の先端）を隣の worktree で build して bundle を測り、その perf-bench を 1 回（--runs 1 --skip-loaded）回して bytes を測る
bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json   # 超え / 良くなった / main より上げた / bundle か bytes の 1% 以上の増加、のどれかがあれば exit 1（その環境の上限で）
bun scripts/perf-ratchet.ts update perf-result.json    # 良くなった上限だけを 値 + 幅 に下げる。上げない
bun scripts/perf-ratchet.ts update perf-result.json --env github   # github の上限を下げる。Actions の結果は、check が落ちた run の log の最後に出る JSON をファイルにして渡す
```

- **幅**: 同じコードでも動く数には固定の幅を持つ（上の「数の意味」の ±1。5 回の中央値の揺れ）。`requests` / `layoutCount` / `recalcStyleCount` は 1、`layoutShift` は 0.03（2026-10-01 の `--runs 5` 6 回で launch 0.2602〜0.2831）。設定にはしない（幅は同じコードの揺れで、どれだけ悪くしてよいかではない）。`--runs 1` は幅を超えて動く（同じ日の 14 回で launch の `layoutCount` 4〜6、`layoutShift` 0.2598〜0.3523）ので、`check` / `update` には 5 回の結果を渡す
- **`bytes`**: `open-task` and `open-task-huge` are compared with the tag before, like the bundle; `scripts/perf-budget.json` has no number for them (the other journeys' `bytes` are in the table only). `perf-ratchet.ts base` runs the compared ref's own perf-bench once in its worktree (`--runs 1 --skip-loaded`: a response's size does not wobble, so one run is enough; about a minute more per run), and `perf-base.json` holds `journeys.<name>.bytes` and, when that ref's perf-bench has them, `responses`. `check` prints `bytes: <journey> <n> B (main <m> B, +<d> B, +<p>%)` for both journeys, then each response whose size differs, by the shape of its path: `/api/tasks/:id/evals +22 B × 2` (the same count: the change per response times the count) or `<path> +<d> B（<n> 回、main <m> 回）`. 1% or more above the compared ref's is `grew: bytes.<journey> …` and exit 1, with the same limit as the bundle; under 1% passes. A `perf-base.json` without `journeys` (a ref measured before this was added) judges nothing and says so in one line. This replaced a ceiling with no room (2026-11-04 to 2026-11-05), which failed every PR that added a byte.
- **上限 = 値 + 幅**: 超え = 値 > 上限、良くなった = 値 < 上限 − 2 × 幅（測った値より幅を超えて下）。良くなったら CI が落ち、同じ PR で `update` して下げさせる（両側のゲート。`loaded.healthMaxMs` を除く — 下の箇条）。同じコードの揺れの範囲（測った値 ± 幅）はどちらにも当たらない — 「良くなった」を 上限 − 幅 にすると、同じコードで今までの最小より 1 つ下が出るたびに関係の無い PR の CI が落ちた（2026-10-02、Actions の send の `layoutShift` 0.0104 → 0.0103）。代わりに、揺れない側の 1 の悪化（例: open-task の `requests` 5 → 6）と、幅までの改善は通る
- **CI**: `scripts/ci.ts` の手順（Actions の `ci.yml` が走らせる）で、web の build の後に、`origin/main` の fetch → `perf-ratchet.ts base "${PERF_BASE_REF:-origin/main}" perf-base.json`（タグの CI は前のタグ。PR と最初のタグは `origin/main`）→ `perf-bench.ts --runs 5` → `perf-ratchet.ts check --base perf-base.json`. `scripts/local-ci.ts` does not run these for a PR; `scripts/tag-ci.ts` runs them for the tag's commit (the same `runCheckout`, with perf on).
- **上げる**: `check` は比べる相手（タグの CI は前のタグ、ほかは `origin/main`）の `scripts/perf-budget.json` より上げた項目があれば exit 1（測った環境だけでなく `github` / `local` の両方。Actions で `local` を上げた PR も落ちる）。PR のローカル CI は `check` を回さないので、上げる PR はそこでは落ちない。上げるのは利用者の判断で、マージの前に聞く。The bundle and `bytes` have no ceiling to raise: under 1% nobody is asked, and no PR raises a number for them.
- **Bundle**: the bundle (js / css, gzip) has no ceiling in `scripts/perf-budget.json`, so a PR never edits a number for it. `perf-ratchet.ts base <ref> perf-base.json` builds the compared ref (the tag before in the tag CI, otherwise `origin/main`'s tip) in a worktree next to the checkout (not under `/tmp`, which is RAM), and `check --base perf-base.json` compares the merged build with it. It always prints `bundle: js <n> B (main <m> B, +<d> B, +<p>%) / css …`. When js or css is 1% or more above the compared ref's, it prints `grew: bundle.<js|css> …` and exits 1. Under 1% the check passes and prints the growth. Only a PR's Actions run measures a PR this way; its local CI does not, and the tag CI compares with the tag before (above). Outside the tag CI the comparison is with `origin/main`'s tip, not the PR's base branch, so the top of a stack compares the whole stack. 1% is the user's rule of 2026-10-30, meant to be looked at again (raised or dropped); `bytes` shares it (2026-11-05). To change it, edit `BUNDLE_GROWTH_LIMIT` in `scripts/perf-ratchet.ts` and this paragraph. Small growths add up; **bundle の推移** below keeps the record of the compared refs' sizes to look back at.
- **`layoutShift` の揺れ**: `launch.layoutShift` の赤は利用者に聞く。ただし web に触れない PR で、ローカル CI を 2 回回して値が上限の上下に揺れる（超える回と下回る回がある）なら、マージを推奨して聞く。聞くのはスタックに 1 回で、どの PR が web に触れるかを添える（利用者の回答、2026-10-22・2026-10-23）。This was decided while a PR's local CI measured perf; it no longer does, so this red now shows only in the tag CI
- **Known exceptions**: an excess the user accepted goes in `exceptions` of `scripts/perf-budget.json` as `{ "key": "<env>.journeys.<name>.<count>", "issue": <n> }` (`key` as `raised` prints it). While that Issue is open, `check` prints `known exception:` for the count and does not exit 1. An Issue that is closed or cannot be read (`gh` missing or without a login, as in Actions) makes it `over:` again. An exception the compared ref does not have fails with `added exception:`, and is merged by hand like `raised`. The number is read in the checkout's default repository, and an exception does not cap the value.
- **`loaded.healthMaxMs`** (the daemon's delay under load and overlap): a ceiling in `local` only: no Actions run measured a `github` value, and a ceiling nobody measured is a guess. The band is 10,150 ms: twice the spread of five measures of one run each on the same head, rounded up to 50 ms, with 100 ms as its floor: 6,866 / 5,388 / 1,792 / 3,855 / 5,627 ms on one head (main with `loaded` in one run), 2026-11-03, with one or two other Tasks running. The ceiling, 11,950 ms, is the lowest plus the band (11,942), rounded up to 50 ms like the band, the rule of the first ceiling (5,440 ms = the lowest of three `--runs 5` medians plus a band of 1,750 ms, on main, 2026-11-01, when `loaded` was the median of five runs). One run moves by more than a median of five, so the ceiling rose with the change to one run (the user's call, 2026-11-03). A version before the fixes measured 444,920 ms in one run, 37 times the ceiling; a stall of a few seconds does not reach it, as it did not reliably reach the earlier ceiling either. The `launch` / `send` times under load stay out of the ratchet. It is judged on the high side only, like the seconds of `durations`: above the ceiling is `over`, but far below it is never `improved`, and `update` never lowers it. The load moves it by more than twice: with the first ceiling and band, a quiet host measured 1,700–1,924 ms, below ceiling − 2 × band (1,940 ms then) every time, and the local CI failed PRs that did not touch it (2026-11-02).
- **bun test の所要秒と型検査の所要秒（例外）**: `local` only, as `durations` in `scripts/perf-budget.json`. These are the seconds of the type check and `bun test` that a local-ci run measures (the `local-ci-seconds` line of its pass). perf-bench does not have them, so `perf-ratchet.ts check` does not compare them: `scripts/local-ci.ts` calls `judgeDurations` after every step passed, and a value above its ceiling fails the run with an `over: durations.<key>` line and no pass mark. A run that narrowed `bun test` to the affected tests compares the type check only; its `bun test` seconds stay in the `local-ci-seconds` line, and the `local-ci-tests` line of its result says it was narrowed (`ran` is not null), so leave those runs out when setting a ceiling. A value far below its ceiling never fails, because a quiet host moves it down as well; lower a ceiling by hand. Raising one fails as `raised`, like any ceiling, and is the user's call. The band is twice the spread (highest minus lowest) of five runs on the same head with other Tasks running as usual, rounded up to whole seconds. The ceiling is the highest value in recent real local-ci passes plus the band, not the lowest of the five: those five ran on one head with at most 2 running Tasks and no recordings, and real runs differ by head, load and recordings by more than the five do. The first ceilings use main on 2026-11-01, with 0 to 2 running Tasks, in local-ci's environment: the type check took 4.2 / 4.4 / 4.4 / 4.2 / 4.5 s (band 1) and `bun test` 346.3 / 352.5 / 350.4 / 377.9 / 342.8 s (band 71). The 36 passes of 2026-10-31 and 2026-11-01 ran 4.1 to 11.8 s and 216.7 to 442.7 s, so the ceilings are 12.8 s and 513.7 s. Lowest of the five plus the band would be 5.2 s and 413.8 s, which more than half of those passes exceed. So a ceiling catches a jump, about three times the usual type check and one and a half times the usual `bun test`, not a slow creep. `local.durations.test` is the time budget of the whole `bun test`: the budget has no second value or file of its own. On a red, look at the load first: if another heavy run overlapped, run it again. If the time really grew, fix the cause. If `durations.test` is still over and no single change caused it, the next step is a test audit: run `bun scripts/test-audit.ts candidates`, and open a PR for the candidates worth removing, merging or making lighter (the `task-to-pr` skill says how to check a removal; the PR's review decides). Raising a ceiling is the last resort, and the user merges that by hand.
- 初期値: `local` は 2026-10-02、main、AWS ホスト（`/usr/local/bin/chromium`）、`--runs 5` を 7 回の最小 + 幅（new-task の `layoutCount` 7〜8、`layoutShift` 0.012〜0.0198 は 7 回目で初めて下側が出た）。`github` は同じコードの Actions の `--runs 5` 5 回の最小 + 幅。2026-10-14: `local` の `new-task` / `open-task` / `send` の `requests`（14 / 6 / 6 → 16 / 8 / 8）と両環境の `bundle`（js 195128 → 206877、css 6336 → 6574）を main で測り直した（`--runs 5` 3 回の最小 + 幅、bundle は実測値。#1368）。リクエストの増えは Brief の `/evals`（#1224 / #1236 / #1253）と `/device-auth`（#676）の読み込み。2026-10-16: `local` の `launch` の `recalcStyleCount`（6 → 7）と `layoutShift`（0.1614 → 0.2371）、両環境の `bundle`（js 206877 → 211466、css 6574 → 6687）を main で測り直した（同じ測り方。main だけで超え、Web に触れない PR のローカル CI がすべて赤になっていたため、利用者の判断で上げた。#1282。`launch.layoutShift` の原因は #1056）。2026-10-20: `local` の `new-task` の `requests`（16 → 18）と `layoutCount`（8 → 9）、両環境の `bundle`（js 220782 → 225121、css 7230 → 7364）を main で測り直した（同じ測り方。#1999）。`requests` を超えさせたのは #1810（Task 画面の成果物タブの `/artifacts` の読み込み。中央値 16 → 17。#1826 より前に入った。#1826 の時点でも 17 で、#1826 は `bundle` の上限だけを直した）。#1846 も Home の最新レポートの行の `/api/reports` を 1 つ足した（中央値は 17 のまま。`/api/history` の回数が揺れる）。`layoutCount` は 3 回のうち 1 回だけ 9 で、幅の揺れ。`bundle` を超えさせたのは #1846（Insights のレポートの節）で、そのあとの #1912 / #1925 / #1926 / #1932 / #1974 / #2010 / #2018 / #2034 / #2044 も足した（#2039 は減らした）。sweep のテストの赤（#1998）で 2026-10-18 からローカル CI の性能の判定が走らず、気づかれなかった。2026-10-22: 両環境の `bundle.js`（225121 → 230322、+2.3%）を main の実測値に合わせた（#1188。#1056 の回答で「main の値に上げる」。#1182 の計測の時点では +0.44% で、その後の main の PR で増えた。#2001 以降、上限を上げずに入った増加の積み重ね）。2026-11-03: `local` `launch` `layoutCount` 5 → 6 and `recalcStyleCount` 7 → 8, measured on main the same way (min + band of three `--runs 5`). main alone went over in two of three runs (6/8, 6/8, 5/7), and the change that added the resources tab measured the same (5/8, 6/8, 5/7); every local CI of a web change was red, so the user chose to raise them. 2026-11-04: `local` `new-task` `layoutCount` and `recalcStyleCount` 9 → 7, lowered with `update`. The bench's tasks moved from the checkout to the bench's own repository (above, `bytes`), and `new-task` drew one layout less: 6–7 in three `--runs 5` on main, against 7–8 in the checkout. `github` was not measured and stays.

## bundle の推移

Each time the tag CI measures the bundle of the ref it compares with, the tag before (the first tag: `origin/main`'s tip) (the `perf-base.json` that its CI steps write for the bundle check), it appends one row to `bundle.tsv` on the branch `perf-records` of the repository, whether the run passed or not. A PR's local CI does not measure it and writes no row. The branch is never merged; the tag CI makes it the first time (a root commit with a README) and adds rows with the GitHub contents API, not in a working tree. The columns are `measured_at` (ISO, UTC), `js` and `css` (gzip bytes, as perf-bench measures them) and `main` (the sha that was measured, for reference). A row is a measure, not a commit: the same commit measured twice is two rows, and a commit nobody measured has none. Writing a row never changes the run's result; a failure prints one line. When another run wrote first, the row is put again once on top of it. Once the file is over 1 MB the contents API no longer returns it, and the tag CI writes nothing and says so (it does not replace the rows); `history` says so too. When the file nears 1 MB, splitting it is a request of its own (nothing here splits it). A GitLab repository, or a checkout whose CI writes no `perf-base.json`, writes nothing.

```bash
bun scripts/perf-ratchet.ts history                       # every row, in time order
bun scripts/perf-ratchet.ts history --since 2026-11-01    # rows measured on or after that day (UTC)
bun scripts/perf-ratchet.ts history --repo <owner/name>   # another repository; without it, this checkout's origin
```

It reads the file once and prints a table: each row's sizes and its increase from the first row of the period, in B and %, then `期間の増加:` (the last row against the first). With no rows it prints `記録なし`. Old commits are not built again to fill the table: the rows start from the first measure after this was added. The increase is a number to look back at; nothing checks it or notifies about it.

The compared ref's `bytes` are kept the same way, in `bytes.tsv` on the same branch, from the same `perf-base.json` (when it has `journeys`). A measure is one row per journey (`open-task`, `open-task-huge`) and response path shape, with the columns `measured_at`, `journey`, `path`, `count`, `bytes` and `main`. When the compared ref's perf-bench gave a journey's total alone, its row has the path `(total)`. `bundle.tsv` keeps its four columns. `history` prints the bytes table after the bundle's, with the same `--since`: per measure, each journey's sum over its paths and its increase from the first measure, then `期間の増加:`. With no rows it prints `bytes: 記録なし`. To see which response grew, read the rows of `bytes.tsv` for two measures. About ten paths per measure make about 20,000 rows before the 1 MB limit above; the same limit and the same rule apply.

## テストの揺れ

ローカル CI は約 1,400 件の `bun test` を 1 プロセスで回す（3.8 GB のホストで、レビュー用のサブエージェントも同時に動く）。#1232 では PR と関係のない 3 件が、同じ head でも回すたびに落ちたり通ったりした（単独で回すと pass）。落ちたのは `scheduler.test.ts` の「secret-scan: POST /api/schedules/:id/run answers 202 at once」、`dak/src/parse.test.ts` の「artifact: an inlineData part …」、`backlog.test.ts` の「promote: when idle — a promotion held by a running Task …」。

- **原因（コードを読んだ見立て。失敗の文は再現できていない）**: 時間の仮定。3 件とも、子プロセスの起動（scheduler の `bun ops-kit/src/cli.ts`）、HTTP の往復 3 ターン（dak）、git を伴う昇格（backlog）を、bun test の既定のテストごとの上限 5 秒に収めていた。待ちも固定の長さで区切っていた（scheduler: 25 ms × 200 回、backlog の `settle` / `started`: 10 ms × 200 回、dak の `waitFor`: 5 秒）。回数の待ちは `sleep` が延びるほど長くなるので上限そのものではなく、効いているのはテストごとの 5 秒と、dak の 5 秒の `waitFor` のほう。dak の `attachmentDir` は `mkdtempSync` の専用ディレクトリで、ファイル名の衝突ではない。2026-10-17 に修正前の main で、並行して `bun run --cwd apps/web build` を回しながら全スイートを 5 回回したが、この 3 件は 1 回も落ちなかった。だから修正後の 5 回の緑（同じ負荷）は、直ったことの証明ではない。この節の直しは、再現した失敗に対する直しでなく、時間の仮定を外す予防
- **直し方**: 期待値は変えず、待つ上限だけを変える。待ちは回数でなく締め切り（20 秒）で区切り、そのテストに `30_000` を付ける。`bunfig.toml` の全体の既定は変えない（遅いテストを全部見えなくする）。`retry` で包まない（揺れを隠す）
- **新しいテストで外部プロセス・HTTP・git を待つとき**: 待ちのループは `Date.now() - t0 < 20_000` の締め切りで区切る。そのテストの上限は 5 秒のままにせず `30_000` を付け、理由のコメントにこの節を書く（型は `transfer.test.ts` の `}, 30_000);`）

Second round, eight tests (2026-11-02). None of the eight failed in the loaded runs on main, so these causes come from how long each failure took and from the code, not from a reproduced failure:

- **Ordering**: the value waited for and the value read are written at different times. `promote: when idle` read a log line right after `promoted` grew, but the line is written after the rescue server answers (delaying that answer fails the test every time). A longer limit cannot fix this: wait for the value that is read. `tmp: sweep` needed both: it hit its 20 s limit on record, and with a slowed `/proc` walk it read the next interval's empty answer, so its interval has to stay well over one sweep
- **Idle window**: `SWITCHBOARD_RUNNER_IDLE_MS` at 60 ms closed between two HTTP requests. Widen a window that steps depend on, and wait for the release by its state, not a fixed sleep
- **Fixed sleep before a count**: 50 ms did not always hold two 20 ms ticks (`healthWatch`). Wait for the count, with a deadline
- **The 5 s default**: failures that all land just over 5 s are the limit (`runner-sync starts a new set`). Fixed sleeps count toward it
- **Read the failure's duration first**: a test that fails under its limit is not fixed by a longer one. `runner-sync uploads` fails at 4-5 s under a 20 s limit, no failing line was kept, and its cause is unknown
- **Checking**: run the load build in another worktree. In the same one, a test that reads `apps/web/dist` fails while the build rewrites it

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

2026-09-29、main、AWS ホスト（arm64 Linux、`/usr/local/bin/chromium`）、`--runs 5` を 2 回:

| journey | ms median | ms p90 | requests | LayoutCount | RecalcStyleCount | layoutShift |
|---|---:|---:|---:|---:|---:|---:|
| launch | 425.3 / 408.1 | 540 / 541 | 12 / 12 | 4 / 4 | 6 / 6 | 0.2602 / 0.2623 |
| new-task | 164.7 / 165.6 | 258.8 / 167.9 | 13 / 13 | 8 / 7 | 8 / 8 | 0.0305 / 0.0235 |
| open-task | 306.9 / 314.8 | 355.9 / 382.5 | 5 / 5 | 3 / 3 | 3 / 3 | 0.047 / 0.047 |
| send | 485.7 / 414.3 | 509.7 / 615.4 | 5 / 5 | 4 / 4 | 4 / 4 | 0.0193 / 0.0127 |

bundle (gzip): js 184,313 B、css 6,003 B（2 回とも同じ）。この 2 回では `requests` は一致し、`layoutCount` が new-task で 8 / 7。2 回の間で ±1 ほどの揺れがある。

目に付くもの（速くする PBI の候補。数字を見て起こす）: `launch` の `layoutShift` 0.26（どの要素がずれるかは未調査）、`new-task` の 12〜13 リクエスト（`/api/history` の読み直しが 3 回、Task の `checks` が 2 回、作った Task の詳細が 2 回）。

2026-10-03: 初回のCI導入前にmainのbuildを単独で測り、bundle.jsの初期上限を186859 Bへ合わせた（CSSは6031 B）。#871の予定画面が増えた分で、PR #810のコードによる増加ではない。

### 2026-10-21: ローカル CI の環境で `launch.layoutShift` が超える（#1056、#1182）

条件: AWS ホスト（arm64 Linux、`/usr/local/bin/chromium`、Noto フォント）。`env -i PATH HOME CI=true TMPDIR=<dir>`（`scripts/local-ci.ts` の `stepEnv` と同じ）で `bun scripts/perf-bench.ts --runs 5` → main の `bun scripts/perf-ratchet.ts check --env local`（上限 0.2371）。TMPDIR は RAM = `/tmp`（tmpfs）、ディスク = `~/.cache`（root ディスク。ローカル CI と同じ場所）。条件は交互に回し、ほかの性能計測とは並行していない。判定は launch.layoutShift 以外のキーも全部。main の行は `improved` / `raised` が無い。

| commit | TMPDIR | 回 | launch.layoutShift | check の判定（exit 1 の理由） |
|---|---|---:|---:|---|
| `local` の初期値の commit | RAM | 1 | 0.2152 | over なし。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| `local` の初期値の commit | RAM | 2 | 0.2060 | over なし。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| `local` の初期値の commit | ディスク | 1 | 0.3046 | launch.layoutShift。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| `local` の初期値の commit | ディスク | 2 | 0.2967 | launch.layoutShift。improved: new-task / open-task / send の requests、bundle の js / css（古いコード） |
| main | RAM | 1 | 0.1779 | bundle.js |
| main | RAM | 2 | 0.2031 | bundle.js |
| main | ディスク | 1 | 0.2938 | launch.layoutShift, bundle.js |
| main | ディスク | 2 | 0.2943 | launch.layoutShift, bundle.js |
| main | ディスク | 3 | 0.3147 | launch.layoutShift, bundle.js |
| main | ディスク | 4 | 0.2938 | launch.layoutShift, bundle.js |
| main | ディスク | 5 | 0.2943 | launch.layoutShift, bundle.js |
| 文書のみの PR #2168（pull/2168/merge） | ディスク | 1 | 0.1688 | bundle.js（launch.layoutShift は improved） |
| PR #2168 | ディスク | 2 | 0.3008 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 3 | 0.2943 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 4 | 0.2943 | launch.layoutShift, bundle.js |
| PR #2168 | ディスク | 5 | 0.2943 | launch.layoutShift, bundle.js |

結論: 同じ commit で TMPDIR だけで超える／超えない（RAM 0.18〜0.22、ディスク 0.29〜0.31。ディスクでも 1 回だけ 0.1688 が出た）。commit の差ではない。`local` の上限（0.2371 = 0.2071 + 幅）は RAM の TMPDIR の値と合う（上限の測り直しは普段のシェルで、TMPDIR は既定の `/tmp`）。ローカル CI はディスクの TMPDIR で回している。2026-10-19〜21 のローカル CI の失敗ログでも 0.316〜0.347。`bundle.js` の超え（main 226104 > 225121）は揺れではなく、main が上限より大きい（上限を上げずに入った増加）。ほかのキーは 16 回とも上限に収まった。

上限 0.1614（#1056 を起こした 2026-10-02 の値）に対しては、RAM の値も超える。同じ初期値の commit の RAM の値が 2026-10-02 の 0.13 台（上限 = 最小 + 0.03）から 0.21 前後に上がっているので、10-02 以降にホスト側（Chrome・フォントなど）でも値が動いた。#1282 の 0.2371 はその上がった RAM の値で測り直したもので、今のローカル CI の赤を分けるのは TMPDIR だけ。

2026-10-22: 利用者の回答 A（#1056）で、`scripts/local-ci.ts` の TMPDIR を `~/.cache` から OS の一時ディレクトリ（`tmpdir()`。このホストでは RAM の `/tmp`）に戻した（#1188。worktree は `~/.cache` のまま）。上限は変えず、ローカル CI の環境を上限を測った環境にそろえた。直した PR #2275 自身のローカル CI では `launch.layoutShift` 0.2289（上限 0.2371）で `over` は 0（赤は `bundle.js` の上限を上げた `raised` だけ）。
