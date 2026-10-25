# バックログ画面

ナビの「Backlog」タブは、登録した全 workspace（meta と repo。#294）の GitHub にある open な要望（`type:request`）と PBI（`type:pbi`）を、今どの工程で止まっているかごとに並べる。正本は Switchboard の保存データ（DB）。GitHub の Issue と Project は同期先で、取り込み（#885）と送信（#886）で揃える（#2264）。画面はその保存データを読み（下の「取得」「保存（#885）」）、回答・編集・新しい Issue は DB に確定してから GitHub に送る（[backlog-sync.md](backlog-sync.md)）。要望の起こし方と PBI・Task の書き方は `ops-kit/skills/issue-workflow/SKILL.md` と `ops-kit/skills/request-to-backlog/SKILL.md` にある。

## 取得

`GET /api/backlog`（[`packages/core/src/server.ts`](../../packages/core/src/server.ts)）は、`db.listWorkspaces()` の workspace ごとに、最後の取込みが保存したものを返す（下の「保存」の `readStoredBacklog`。gh を呼ばない。#885）。項目は `db.listWorkspaces()` の順に連結し、各項目には元の workspace の `workspaceId` / `workspaceName` が付く。`fetchedAt` は表示した workspace のうち GitHub と連携する workspace（`backlog: "github"`）の一番古い取込みの時刻（連携なしの workspace の保存データの時刻は登録の時刻で、GitHub から取り込んだ時刻ではないので数えない。#2362）、`syncs` は workspace ごとの取込み中かどうかと最後に成功した時刻。

- GET は取込みを待たない。一度も取り込んでいない workspace は項目なしで `errors` に「まだ GitHub から取り込んでいません」を返し、まだ試していなければ取込みを 1 回頼む（失敗した workspace は GET のたびには頼まない。再読込・起動時・定期実行で頼み直す）
- `?refresh=1`（画面の「再読込」）は全 workspace を並行に取り込んでから返す（#441。待ち時間は最も遅い 1 つ分）。取込みが失敗しても保存値を返し、理由は `errors` に
- 取込み（`BacklogSync`、[`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)）を頼むのは、デーモンの起動時（全 workspace。GET はその完了を待たない）、一度も取り込んでいない workspace を最初に見たとき、`projectVar` の変更、再読込、送信待ちを GitHub に送った後（書く前に始まった取込みはその回答の読み戻しに使わず、その次の取込みを共有する。#441 の 2 つ同時の回答。同じリポジトリの別の checkout の取込みも、書く前に始まったものは読んだものを保存しない — 保存先はリポジトリごと。書き込みは通し番号で数え、リポジトリと workspace の両方の最後の書き込みと照らす。`projectVar` の変更も書き込みと同じに数える）、定期実行の発火（取り込んでから選ぶ）。同じ workspace の取込みは同時に 1 本で、重なった依頼はそれを共有する
- GitHub 連携の無い workspace（#2265、下の「GitHub 連携の無い workspace」）は取込みで gh を呼ばず、登録したときから取り込み済みとして読む（`errors` に出ない）
- `GET /api/backlog/:number?workspaceId=` は保存した 1 件の本文・全コメント（古い順）・その workspace の Project の値・`fetchedAt`・取得状態を、まだ送っていない編集を重ねて返す（保存されていなければ 404）。`:number` はここで作った Issue の `localId` でもよい（#886）。`localId` と送信待ちの数 `pending` も返す

取込みが読むもの:

1. `gh repo view --json nameWithOwner` でリポジトリ
2. Project 番号は Project の URL の末尾。URL は workspace ごとの設定 `projectVar`（そのリポジトリで Project の URL を入れている変数の名前。リポジトリごとに自分の命名がある — example-app なら `EXAMPLE_PROJECT_URL`）の `gh variable get <projectVar>`。設定が無い workspace は `SWITCHBOARD_PROJECT_URL`（環境変数、無ければ `gh variable get SWITCHBOARD_PROJECT_URL`、`scripts/setup/lint_backlog.sh` と同じ）。環境変数は全 workspace に効くので、`projectVar` のある workspace には使わない。設定はバックログ画面の「読めませんでした」の行から（`PATCH /api/workspaces/:id { projectVar }`、null で既定に戻す。同じ値なら何もしない）。URL そのものは持たず、正本はリポジトリの変数のまま
3. `gh api graphql` で Issue をページ送り（下の「保存」の ①〜③）。Issue ごとには呼ばない（件数ぶん遅くなり、secondary rate limit に当たる。#201）。Project のフィールドは上の owner と番号の Project のものだけを読む

- API で登録された workspace（`POST /api/workspaces`、Task が新しいリポジトリを登録するとき。#1447）に取込みの口は足さない。`projectVar` を付ける `PATCH` が取込みを頼み（`backlog.wrote`）、付ける前は上の「一度も取り込んでいない workspace」の経路で読まれた時に頼む。Issue が 0 件の Project でも `errors` は空で、`syncs` に取込み済みで出る。登録・設定の変更は WebSocket の `workspaces.updated` で開いている画面に知らせ、画面は `GET /api/workspaces` を読み直す（差分は送らない）

## 保存（#885）

API の制限中や再起動の後も Issue・Project・判断待ちを見られるように、取り込んだものを `SWITCHBOARD_HOME` の既存の DB（`switchboard.db`）に保存する。保存の方式は利用者が承認した SQLite 案（要望 #882 の 2026-10-03 の `## 回答`）: Knowledge は Markdown と Git のまま、Issue・Project の同期情報は SQLite。ソースのリポジトリや作業ツリーに Issue を書かない（commit しない）。ファイルと DB の二重の正本も作らない。

- **表**（[`db.ts`](../../packages/core/src/db.ts)）: `backlog_records` は 1 行 1 オブジェクト（Issue / コメント / Project 項目 / 開いている PR と待ちの相手の PR。PR は状態・Draft・ラベル・更新日時 `updatedAt`・変更ファイル `files`（#1044。開いている PR は取込みの 2 の最初のページに相乗りして読み、101 件以上は null = 全部は読めていない。#1044 より前に保存した PR は migration で消え、次の取込みで読み直す）と、本文の `Closes #n`（close / fix / resolve とその -s / -d 形）と枝名 `sb/<n>-` から読んだ閉じる Issue の番号 `closes`（#1183。本文と枝名そのものは保存しない。#1183 より前に保存した PR は migration で `closes: []` になり、次の取込みで本物の値に替わる））。キーは service・host・リポジトリ・種類・GitHub の node id で、Issue 番号はキーにしない（別リポジトリの #12 と混ざらない）。値は JSON で、`remote`（GitHub が最後に答えた値）・`base`（最後に同期した値）・`local`（まだ送っていない編集を `remote` に重ねた値。#886）と取得状態（`fetched` / `unfetched` / `unavailable` = 404 か一覧から外れた / `forbidden` = 403）。`backlog_repositories` はリポジトリごとの cursor・最後に成功した取込みの時刻・`retryAt`。workspace の `backlog_source` は、その workspace がどのリポジトリのどの Project（owner と番号）を読むか（取込みのたびに書く。読むときに `gh repo view` を呼ばないため。`projectVar` を変えると消え、次の取込みまで未取得になる）。取込みは Project の URL も読む（環境変数が無ければ `gh variable get` 1 回。上の「取得」の 2）ので、Project が読めない workspace は Issue も取り込まない（その workspace の取り込めない理由になる）
- **取込み**（[`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts) の `importGithubSnapshot`）: ① cursor（前回の最新 `updatedAt`）以降に更新された要望・PBI・Task を閉じたものも含め丸ごと（コメントは全ページ）② 開いた Issue の Project 項目（Project のフィールドの変更は Issue の `updatedAt` を変えない）③ 番号で再確認: 保存済みの開いた Issue で ①② のどちらにも無いものと、PBI の待ちの相手と、開いた PBI・Task の前提（#937。Issue は閉じ方 `stateReason`、PR はマージコミット `mergeCommit` も保存）。全部読めたときだけ 1 トランザクションで保存し、途中の失敗では何も変えない（cursor も進めない）。404 / 403 は記録に印を付けるだけで、保存していた値は消さない。見えないもの（Issue の `updatedAt` が動かないコメントの編集・削除、閉じたあとにラベルを外した Issue）は同じファイルの冒頭に書いた
- **読み取り**（`readStoredBacklog(db, ws)`）: 保存レコードのうち `fetched` のもの（まだ送っていない編集があれば `local`）と、ここで作って GitHub にまだ無いものから（番号の付いていない新しい Issue は一覧に出さない。#886）、下の工程の判定・判断待ち・状況・回答・待ちを組み立てる（判断待ち・状況・回答・待ちは `withComments` / `withWaits`）。gh を呼ばない。コメントは最新 20 件ではなく保存した全部を読む。PBI の Task 数の完了と子 Task の問いは、保存した Issue（`type:task` などのラベルのあるもの。Task は必ず `type:task`、`issue-workflow`）から数える。一度も取り込んでいない workspace は `fetchedAt: null` で項目なし（空一覧の成功に見せない）
- **バックアップ**: 既存の DB と同じ（`snapshotTo` / Litestream）。復元した DB から同じ一覧と判断待ちが読める

## GitHub 連携の無い workspace（#2265）

Issue・Project を GitHub に持たない workspace のバックログは、Switchboard の保存データだけに置く。PR・レビュー・CI はリポジトリのある場所（`ops.config.json` の `forge`）のまま（[forge-integration.md](forge-integration.md)）。

- **登録**: `POST /api/workspaces { path, backlog: "switchboard" }`（画面は設定の「Workspace」カードの「ホストのパス」のチェック）。そのとき保存元 `backlog_source` を `{ service: "switchboard", host: "local", repository: <workspace id>, project: { owner: "switchboard", number: 0 } }` に決め、空の取込みとして保存する（`localBacklogSource`）。新しい列・表は無い: workspace の `backlog`（`github` / `switchboard`）は保存元の `service` から読む。登録済みの path に違う `backlog` を渡すと 409、`projectVar` は 409（後からの切り替えは下の「GitHub 同期の有効・無効」）
- **キー**: 保存データのキーの repository が workspace id なので、2 つの GitHub 連携の無い workspace の #1 は混ざらない
- **取込み**: `BacklogSync.sync` は gh を呼ばず、今の保存データを最新として `lastSuccessfulSync` を進めるだけ。定期の読み直しも予約しない
- **番号**: 作成のたびに Switchboard が付ける（その workspace の Issue の最大 + 1。workspace ごとに 1 から）。記録の id は `sb:<作成の操作の id>`。編集はその場で確定する（[backlog-sync.md](backlog-sync.md) の「送り方」の `applyLocalOperations`）。`POST /api/backlog` は `{ localId, number }` を返す
- **フィールド**: Project のフィールド（Status / Priority / Area / Kind / Phase / Story Points）と Milestone は、保存の前にその workspace の `ops.config.json` の選択肢で検査する（`checkLocalFields`。Status はキットの `STATUS_OPTIONS`。合わなければ 422 で何も保存しない。`ops.config.json` があって読めなければフィールドと Milestone だけ 422）。親は同じ workspace の Issue で自分以外（`checkLocalParent`。422）。工程の判定と backlog-next は GitHub の workspace と同じ経路で保存データを読む
- **既定の選択肢**（#2361）: `ops.config.json` が無ければ、キットの雛形 `ops-kit/template/ops.config.json` の値で検査する（`defaultConfig`。`__AREA__` は `app` で埋めるので Area は `app` だけ、Kind / Priority / Story Points は雛形のまま、Phase と Milestone は無いので付けると 422）。その workspace の Task の `ops-kit lint`（`BACKLOG_WORKSPACE` があり `GH_REPO` が無い）も、設定ファイルが無ければ同じ既定で検査する。workspace にファイルは書き出さない。自分の値にするには、雛形をリポジトリの直下に `ops.config.json` として写し、`__AREA__` / `__PREFIX__` を自分の値にする（`ops-kit/README.md` の「雛形（新しいリポジトリ）」）。置いた後はその選択肢で検査する
- **Task**: デーモンはこの workspace の Task にだけ `BACKLOG_WORKSPACE=<workspace id>` を渡し、`ops-kit backlog` / `ops-kit lint` / 並列ガードはそれでこの workspace を選ぶ（`GH_REPO` の次、origin の前）。工程の指示（`buildStartPrompt` の `local`）は「Issue・Project は `ops-kit backlog` だけ、`gh issue` / `gh project` / `scripts/setup/*` は使わない、並列ガードは `--repo` を付けない」と伝える


## GitHub 同期の有効・無効

GitHub と同期する workspace は後から同期を止められ、止めた workspace と GitHub 連携の無い workspace は後から GitHub に載せられる。どちらも記録を失わない。切り替えは利用者の操作だけで起きる（自動では切り替えない）。PR・レビュー・マージ判定は切り替えによらずリポジトリの forge のまま。

- **API**: `PATCH /api/workspaces/:id { backlog, projectVar? }`
  - `backlog: "switchboard"`（無効にする）: 保存元に `disabled: true` を付けるだけで、キー・記録（GitHub の番号・コメント・Project のフィールド）は動かさない。同じリポジトリの別のチェックアウトの workspace も一緒に止める（記録と送信待ちをリポジトリのキーで共有するため）。未取込みの workspace は GitHub 連携の無い保存元にする。もう無効なら何もしない。200 で workspace（`backlog: "switchboard"`）。`projectVar` と一緒なら 409
  - `backlog: "github"`（有効にする）: `enableGithubSync`（[`backlog-enable.ts`](../../packages/core/src/backlog-enable.ts)）。202 で `{ ...workspace, enabling: { total, done } }`。もう有効で途中でもなければ 200 で何もしない。GitHub 連携の無い workspace は `projectVar`（その Project の URL を持つリポジトリ変数。無ければ `SWITCHBOARD_PROJECT_URL`）を一緒に渡せる。無効にしていた workspace に `projectVar` を渡すと 409（有効にした後に変える）。GitHub を読めなければ 424（理由つき、何も変えない）。それ以外の値は 400
- **判定**: `syncsGithub(source)`（[`backlog.ts`](../../packages/core/src/backlog.ts)）が「GitHub の Issue・Project を読み書きするか」の 1 つの判定。保存元が無い（未取込みの GitHub の workspace）か、`service: "github"` で `disabled` が無ければ true。GitHub 連携の無い workspace の分岐（取込み・送信・定期の読み直し・Webhook の対象・`checkLocalFields` / `checkLocalParent`・`BACKLOG_WORKSPACE`・工程の指示の `local`・`readStoredRecords` の `service`）は全部これで分ける。`Workspace.backlog` と `syncs[].backlog` も同じ判定で、無効の workspace は `switchboard`
- **無効の間**: 取込みは gh を呼ばず、定期の読み直しも消す。無効にする前に始まった取込みは保存しない（保存元を GitHub に戻さない）。列に並んでいた送信と走っている送信は、次の操作・次の書き込みの前に止まる（[backlog-sync.md](backlog-sync.md) の「無効の間と有効化」）。番号は保存データの Issue と PR の番号の最大 + 1（GitHub は Issue と PR で番号を共有するので、知っている PR と重ねない）
- **有効にした後の番号**: GitHub の番号。Switchboard の番号 → GitHub の番号の対応は保存元の `numbers` に残り、工程 Task の `stage_issue`（有効化を始める前に作ったもの）と、ここで作ったコメントの記録もその番号に付け替わる。有効化の途中で同じ番号の Switchboard の Issue と GitHub の Issue があれば、番号で引くのは GitHub の Issue（`issueRecord`）
- **書き換える `#N` と書き換えない `#N`**: ここで作った Issue の本文・親・コメント、無効の間に GitHub の Issue へ書いて送信待ちの本文とコメントの `#N` は、対応で書き換えてから送る（`renumberRefs`。対応に無い番号はそのまま）。PR の本文・コミット・枝の名前の `#N`、`owner/repo#N`、URL の番号は書き換えない（Remote と Git の履歴、他のリポジトリ）
- **保存元の JSON**（新しい表・列は無い）: `disabled`（無効）、`enabling: { since, queued? }`（有効化の途中。`queued` = 番号が揃い、本文・親・コメントを送っている）、`numbers: [{ from, to }]`。取込みは保存元を書くとき `enabling` / `numbers` を残す
- **画面**: 設定の「GitHub 同期」の節に workspace ごとに 1 行（名前・状態・「無効にする」/「有効にする」/ 途中なら「続ける」、GitHub 連携の無い workspace は Project の変数名の欄）と、「無効の間の編集は、有効にしたときに GitHub へ送ります。」の 1 行（[`Settings.tsx`](../../apps/web/src/components/Settings.tsx) の `GithubSync`）。押している間はボタンを止め、失敗は理由を出してもう一度押せる。途中は 3 秒ごとに読み直す。バックログ画面の同期の行は `githubSyncText`（[`backlogSync.ts`](../../apps/web/src/backlogSync.ts)）: 無効は「GitHub 同期: 無効」（未送信があれば「未送信 N 件（有効にすると送ります）」）、途中は「GitHub に移しています n / m」、有効は今の「最終成功 · 未送信 · 競合」

## 工程（stage）の判定

上から順に最初に当てはまったもの。

| 条件 | stage | 画面の列 |
|---|---|---|
| ラベル `needs-decision` | `needs-decision` | 判断待ち |
| 要望で、本文の `## 派生 PBI` 節に `#N` がある | （返さない） | — |
| 要望で、それ以外 | `request` | 要望のまま |
| PBI で、Project の Status が Ready | `ready` | Ready |
| PBI で、Status が In progress / In review | `in-progress` | 実装中 |
| PBI で、それ以外（Backlog、未設定、Project に無い） | `needs-tasks` | 分解待ち |

`## 派生 PBI` 節は見出しから次の `## ` 見出しまで。フェンス（```` ``` ```` / `~~~`）の中の見出しは数えない（要望の `## 原文` はフェンスで原文を保つので、原文の中の `## 派生 PBI` や `#12` を拾わない）。

各項目: `number` `title` `url` `type`（`request` / `pbi`）`stage` `priority` `storyPoints`（Project のフィールド、無ければ null）`createdAt` `updatedAt`（Issue の最終更新）`tasks`（PBI の sub-issue の `{ total, done, doneAt }`、要望は null。`doneAt` は閉じた sub-issue のうち一番新しい `updatedAt`、閉じたものが無ければ null。#1051）`decision`（`needs-decision` の項目だけ、最新の `## 判断待ち` コメントの `{ body, at, issue }`。`issue` は問いのある Issue（その項目自身か、実装中の PBI の子 Task。#562）。下の「判断待ち」）`activeTaskId`（上の「工程の開始」。その項目の workspace の Task）`projectStatus`（Project の Status の名前、無ければ null）`lastTask`（その項目の workspace で `stage` が #N の Task のうち作成が一番新しいもの。状態は問わない `{ id, status, updatedAt }`。終わった Task の `updatedAt` が終わった時刻。無ければ null。#522）`report`（`in-progress` の項目だけ、最新の `## 状況` コメントの `{ body, at }`。下の「状況」）`answeredAt`（実装中の PBI だけ、PBI と子 Task の `## 回答` のうち一番新しい日時。無ければ null。#562。下の「定期実行」）`confirmations`（Status が In progress / In review の PBI だけ、未チェックの利用者確認の項目 `[{ n, text }]`。それ以外は空。下の「利用者確認」）`closable`（stage が `in-progress` で sub-issue が 1 件以上・全部完了、`confirmations` が空の PBI）`waits` `waitsAt`（Ready / 実装中の PBI が待っている相手と、その記録の日時。下の「待ち」）`workspaceId` `workspaceName`。型は `packages/protocol/src/model.ts` の `Backlog`。

## 工程の開始（#265）

`POST /api/backlog/:number/start { workspaceId, action }` が、その工程のスキルを番号つきで呼ぶ定型 prompt で、Issue のある workspace（`workspaceId`。#N はリポジトリごとなので必須）に Task を作る（201 で Task）。スキルは Task の起動時にその workspace のリポジトリへ置かれる（`docs/design/skill-sync.md`）。prompt には「`scripts/…` は meta workspace のパスからの相対」「`開発リポジトリ` はこのリポジトリ」「Project はその workspace の `projectVar` の変数」「`merge-gate.ts`・`parallel-guard.ts`・`local-ci.ts` は `--repo <owner/name>` を付けて実行しその判定に従う（`local-ci.ts` は Actions が始まらないときに、そのリポジトリの作業ツリーから。`docs/design/local-ci.md`）、PR をマージするたびに `release-tag.ts --repo` でタグを付け、戻すときは `rollback-pr.ts --repo` で PR を作る（`docs/design/releases-and-rescue.md` の Other repositories）」「リポジトリ自身の CLAUDE.md / AGENTS.md が食い違えばそちら」を足し、`complete` はスラッシュコマンドでなく `pbi-complete/SKILL.md` を指す。ランナーとモデルは `/api/feedback` と同じ選び方（`Settings.autoStart` のランナーが検出済みならそれとそのモデル、無ければ claude。共通の `startMetaTask`。定期実行「バックログを進める」はスケジュール自身のランナー・モデル）。工程の種類ごとの既定（`autoStart.byKind` の `to-pbi` / `to-tasks` / `complete` / `check` / `close`、#1337）があり、そのランナーが検出済みなら、ボタン・回答後の再開・バックログを進めるのどれでもそれが先に効く。無ければ共通（バックログを進めるはスケジュール）。GitHub の API 残量・上限・障害では止めない: 始める前の取り込み（#909）は試すが、GitHub に届かなければ保存データで始める。断るのは保存データの競合（#887）だけ（409。[backlog-sync.md](backlog-sync.md) の「開始の判定（#2264）」）。

| stage | action | Task の題名 | prompt |
|---|---|---|---|
| `request` | `to-pbi` | `#N PBI にする: <題名>` | `request-to-backlog` で既存の要望 #N から PBI（要望 Issue は作らない）→ `pbi-to-tasks` で Ready |
| `needs-tasks` | `to-tasks` | `#N Task に分解: <題名>` | `pbi-to-tasks` で #N を Ready |
| `ready` | `complete` | `#N 実装: <題名>` | `/pbi-complete N` |
| `in-progress` | `check` | `#N 状況確認: <題名>` | #N の sub-issue・関連 PR・受け入れ条件・決定ログを読み、Issue に `## 状況`（済んだこと / 残り / 止まっている理由 / 次にやること）のコメントを 1 件書く。利用者の判断が要るものは `## 判断待ち`。コード・PR・Issue のクローズ・Status は触らない。前の `## 回答` は材料として読むだけ（#522。下の「状況」） |
| `in-progress`（#1045） | `complete` | `#N 実装: <題名>` | 定期実行の「止まった実装中」（#578）と同じ再開の文（`resume`。末尾の印 `<!-- tasks-done: N -->` の N はその時点の閉じた Task の数）。行のボタンは出さない（実装中の行は `check` のまま）。待ちの行の相手の「続きを始める」（#1045）が呼ぶ |
| `in-progress` で `closable`（#523） | `close` | `#N 閉じる: <題名>` | `pbi-complete` の「6. PBI を閉じる」で #N の受け入れ条件を検証結果つきで埋め、`## 結果` を書いて閉じる（Task は全部閉じ、利用者確認の項目も確認済み）。stage の照合ではなく `closable` で判定する（実装中の行のボタンは `check` のまま）。backlog-next も実装の枠で選ぶ（#578。下の「定期実行」の「閉じられる実装中」） |

判断待ちの出し方は各工程のスキルが `issue-workflow` を参照する（#719、#783。下の「判断待ち」）。prompt に同じ手順は繰り返さない。

- action が項目の stage と合わない（`needs-decision` を含む。`close` は `closable` でない）→ 409。実装中の `complete` は合うものとして扱う（再開。上の表）。バックログに無い番号 → 404
- 未知の `workspaceId` は 404。`stage` が #N のその workspace の Task が running / waiting なら 2 つ目を作らず 409 `{ error, taskId }`。工程 Task の Issue と工程は `tasks.stage_issue` / `stage_action`（`Task.stage`。作成時に決まり変えない。#1139）で探し、題名は読まない（題名を変えても、`#N ` で始まる普通の Task でも結果は変わらない）。`GET /api/backlog` の各項目の `activeTaskId` も同じ探し方

## 判断待ち（#266）

Issue の判断待ちは実装の判断（要件の読み・設計の選択・受け入れ条件の変更）だけ。運用の確認（マージ・昇格・認証・実行のタイミング）は工程 Task の会話で聞き、Issue にもこの画面の判断待ちにも出ない（#719。`ops-kit/skills/issue-workflow/SKILL.md` の「判断待ちの出し方」。返事待ちの Task の見分けは #720）。

判断待ちは保存データ（GitHub の Issue のコメントと同期）にある: ラベル `needs-decision` + `## 判断待ち` で始まるコメント。形は `ops-kit/skills/issue-workflow/SKILL.md` の「判断待ちの出し方」。GitHub で付いたものは取り込みで、ここで付けたものは送信で揃う。

`## 判断待ち` の後の `## 保留` は回答ではない（#936）: ラベルは残り、待ちを消さず、続行しない（項目の `heldAt`。`## 判断待ち` の無いラベルだけの Issue は `## 保留` があれば保留）。判断待ちの画面では「保留」（`docs/design/asks.md` の「回答と続行」）。

ツール承認・運用確認・停止と合わせて種類をまたいで見る画面（判断待ち、`GET /api/asks`）は `docs/design/asks.md`（#935）。

- `GET /api/backlog`: 保存したその Issue のコメント（全部）のうち、`needs-decision` の項目は `## 判断待ち`、`in-progress` の項目は `## 状況` で始まる一番新しいものを `decision` / `report` に入れる。無ければ null
- **子 Task の判断待ち**（#562）: 実装中の PBI（Status が In progress / In review の `type:pbi`）は、保存した子 Task（sub-issue）のラベルとコメントも読む。開いた子 Task に `needs-decision` があれば、その PBI の stage を `needs-decision` にし、`decision` は子 Task の `## 判断待ち` のうち一番新しいもの（`issue` = その Task）。ラベルはあるのに `## 判断待ち` のコメントが無い Task も PBI を止め、問いの本文に「Task #n に「## 判断待ち」のコメントがありません」と出す（ラベルが正本）
- `POST /api/backlog/:number/answer { workspaceId, text, issue? }`（その workspace のリポジトリへ）: 問いのある Issue（`decision.issue`、無ければ N）への `## 回答\n\n<text>` のコメントと、その後の `needs-decision` の取り外しを DB に確定して 202（#886）。GitHub にはこの順で送る（[backlog-sync.md](backlog-sync.md)。届かない間も回答は失われない）。`issue` は画面に出ていた問いの Issue で、今の問いが別の Issue に移っていれば 409 で何も残さない（読み直してから答える）。項目が `needs-decision` でなければ 409、空の text は 400、認証に使える値を含めば 422
- 状況確認（`check`）以外の工程 Task の定型 prompt（上の表）は、始める前に Issue #N の最新の `## 回答` を読み、あれば続きから進める 1 文を含む。「実装」（`complete`）では同じ文で sub-issue の Task の回答も読む（子 Task に答えた PBI を定期実行が再開するため。#562、#783）。`check` は回答を状況の材料として読むだけで続きの作業はしない。

## 状況（#522）

実装中の PBI の状況は保存データ（GitHub の Issue のコメントと同期）の `## 状況` で始まるコメント（済んだこと / 残り / 止まっている理由 / 次にやること）。書くのは状況確認の工程 Task と、backlog-next が止まった実装中の PBI を再開する「実装」（#578。末尾に `<!-- tasks-done: N -->`。下の「定期実行」）で、書式は両方の定型 prompt で同じ文（`REPORT_FORMAT`）。デーモンは保存したコメントから最新の 1 件を `report` に読むだけ。動いている / 止まっているの判定は保存せず、項目の値（`activeTaskId` / `tasks` / `lastTask`）から画面が決める。

## 利用者確認（#523）

利用者が自分の目・実機・お金で確かめる受け入れ条件は、PBI 本文の行末に `（利用者確認: <何を見て何を確かめるか>）` を付けて書く（形は `issue-workflow` の「利用者確認の項目」）。正本は PBI 本文のチェックボックスで、DB には写さない。

- **拾う行**（`confirmationsOf`）: `## 到達点 / 受け入れ条件` 節（見出しから次の `## ` まで）の、フェンス（```` ``` ```` / `~~~`）の外の `- [ ] ` / `- [x] ` / `- [X] ` 行を上から数え（`n` は 1 始まりの通し番号。チェック済みの行も数えるので、1 つ確認しても他の番号は変わらない）、未チェックで `（利用者確認:` を含む行（インラインコード `` `…` `` の中は数えない。形を説明する行、例えば #523 の条件 1 を拾わない）だけを `{ n, text }`（`text` は `- [ ] ` の後ろ、行末の空白と CRLF の `\r` を除く）で返す。フェンスの中・ほかの節の行は数えない。自由文から推測して拾うことはしない
- 読むのは Status が In progress / In review の PBI だけ（`needs-decision` のラベルがあっても）。本文は 1 つ目のクエリで読んでいるのでクエリは増えない。stage は変えない（確認項目のある PBI も `in-progress`。どの節に並べるかは画面が決める）
- `closable`: stage が `in-progress`、sub-issue が 1 件以上で全部完了、`confirmations` が空。確認項目の無い PBI（書く前の PBI も）も Task が全部閉じていれば `closable`
- **回答**: `POST /api/backlog/:number/answer { workspaceId, confirm: { n, ok }, text }`（判断待ちの回答と同じエンドポイント。`confirm` があるときは stage を問わない）。項目の `confirmations` に `n` が無ければ 409。あれば `answerStoredConfirmation` が保存した本文（まだ送っていない編集を重ねたもの）で、`n` 番の行が今も未チェックの確認項目で文が画面のもの（`confirmations` の `text`）と同じか確かめ、違えば何も残さずに 409（「本文が変わりました。再読込してください」）。回答は DB に確定して 202 で、GitHub に送る（#886）
  - `ok: true`（確認した）: その行の `- [ ]` だけを `- [x]` にした本文（ほかの行・改行コード（CRLF も）はそのまま）の更新（元の本文を `base` に持つので、GitHub で本文が変わっていれば送らずに保留）→ `## 回答\n\n受け入れ条件 <n>「<text>」を確認しました。`（`text` があれば空行の後に足す）のコメント
  - `ok: false`（違う）: 本文は触らず `## 回答\n\n受け入れ条件 <n>「<text>」は違います: <理由>` のコメント。理由（`text`）が空なら 400
  - 同じ PBI への 2 つ目の確認回答は、1 つ目を重ねた本文から作る（同じリポジトリの別の checkout から答えても同じ記録を読む）ので、後から送る本文も両方のチェックを持つ
  - ラベルには触らない（`needs-decision` の問いは別に答える）。GitHub の失敗では止まらず（202）、送ったあとに取込みを頼む（[backlog-sync.md](backlog-sync.md)）
- **閉じる**: `closable` の項目は工程 `close`（上の「工程の開始」の表）で、pbi-complete の 6 を頼む Task を始められる。画面から直接 Issue を閉じない（結果の記入が要るので工程 Task に任せる）

## 定期実行（#267、#561）

スケジュールの種類 `backlog-next`（定期タスク画面の「+ 追加」→ 種類「バックログを進める」。スケジュール自体は meta に 1 つで、Workspace は meta、ランナーとモデルは作成時に選ぶ（初期値は設定画面の「自動で始まる Task の既定」の共通の値。種類ごとの既定を決めた工程は、スケジュールの値でなくそちらで始まる。#1337）、プロンプトは無い）。発火ごとに、登録した workspace ごとに 2 つの枠を埋める。新しい常駐処理は無く、既存のスケジューラ（`packages/core/src/scheduler.ts`）の発火の中で決める。

- **枠**: 実装の枠（工程「実装」「閉じる」。stage `ready` と `in-progress`）と計画の枠（「PBI にする」「Task に分解」「状況確認」。stage `needs-tasks` → `request`）。工程 Task（`stage` を持つ Task。ボタンで始めたものも、ボタンが作成中のものも含む）の枠は `stage.action` で決める（`SLOT_OF_ACTION`。「閉じる」は実装の枠。#523）。その workspace で同じ枠の工程 Task が running / waiting / 作成中の数が枠の数より少なければ、その枠の項目を選んで始め、枠の数に達するまで続ける
- **枠の数**: 設定 `backlogSweep: { implement, plan }`（それぞれ 0〜3、既定 1・1。0 はその枠を自動で進めない）。`GET / PATCH /api/settings` と、設定画面の「バックログを進める」の「リポジトリごとの枠: 実装 [n] 計画 [n]」で変える。発火ごとに読むので次の発火から効く。全体で同時に動くのは最大 workspace の数 × (実装 + 計画)。同じリポジトリの実装を 2 件以上にしたときのファイルの衝突は、工程のスキルが使う並列ガード（`scripts/parallel-guard.ts`）の判定に任せ、上限 3 で抑える
- **使用量**: 工程 Task を始めるランナー（工程の種類ごとに `startMetaTask` と同じ決め方: 種類の既定 → スケジュールのランナー → 保存値。そのあと上限のときの代わり（#834、[rate-limit-resume.md](rate-limit-resume.md)）を通したもの）の使用量（`quota` 表。窓がまだ切り替わっていないもの）のどれかが設定 `quotaAndResume.backlogQuotaLimit`（既定 0.8 = `QUOTA_LIMIT`。#835。発火のたびに読む）以上のときは、全体（全 workspace・全枠）で工程 Task が 1 件も動いていなければ 1 件だけ始める（同時に 1 件まで。止めきらない）。始める直前に毎回数え直す（GitHub を読む間にボタンで始まったものも数える）。閾値未満に戻れば枠どおり。どれかが 1.0 以上（`QUOTA_FULL`、定数。上限に達していて Task は始めた途端に止まる）のときは、GitHub を読まずに何も始めない（ログに「飛ばした: <ランナー> の使用量 <窓> が 100%: <HH:MM> に戻るまで始めない」。要望 #1271、PBI #1275）。どちらも工程ごとに判断し、全部の工程が止まるときだけ GitHub を読まずに返す。一部の工程だけが止まるときは、その工程の項目を「飛ばした: <workspace>: #N を始めない: <理由>」で飛ばし、ほかの工程は始める
- **GitHub の残量**（#549、#2264）: backlog-next は GitHub GraphQL の残量（`rateLimit { limit remaining resetAt }`、1 回 1 ポイント。予算は同じユーザーの全 Task・デーモン・端末で共有）では止めない。工程の開始は保存データで決まり（上の「工程の開始」）、GitHub は同期先なので、残量・上限・障害は同期とレビュー・マージ判定を待たせるだけ。workspace の取り込み（`settle`）が失敗した発火は、ログに「飛ばした: <ws>: GitHub と照合できない（保存データで進める）: <理由>」を 1 行残して保存データで選ぶ。残量を使うのは、GitHub の制限で止まった Task の再開の時刻（`ratelimit.ts`。1,000 未満 = `GITHUB_REMAINING_MIN` なら戻る時刻まで待つ）と表示だけ。読み取りは `GithubBudgetCache`（メモリ、1 分に 1 回まで。失敗も 1 分覚え、同時の読み取りは 1 回にまとめる。戻る時刻を過ぎても 1 分は前の値のまま（受け入れ条件 4）。取り込みが GitHub の制限・障害を待っている間は読まない: 主の制限ならその終わりまで残量 0、それ以外は読めない扱い。[github-api-budget.md](github-api-budget.md)）で、DB（`quota` 表）には書かない。残量が 0 になると GitHub は `rateLimit` の問い合わせ自体を断るので、主の制限（primary limit）で断られたら、GitHub が示した戻る時刻まで残量 0 とみなす。それ以外で読めない（gh の失敗・形の違う応答・10 秒で答えない。答えない gh が残っている間は次の読み取りもそれを待ち、gh を増やさない）ときは再開の時刻を残量から決めない（gh 自体が壊れていても backlog-next は止めず、取り込みの失敗を「GitHub と照合できない（保存データで進める）」の 1 行にして保存データで選ぶ）。REST の `gh api rate_limit` は GraphQL の実際の残量と合わないので使わない（#547）。読んだ値は `GET /api/ledger/summary` の `github`（`{ remaining, limit, resetsAt }`、`resetsAt` は epoch 秒。読めなければ null）。Task の Brief の使用量の行の後ろに「GitHub API 残量 <残り> / <上限> · <HH:MM> に戻る」を出し、残りが上限の 2 割未満なら強調する（`apps/web/src/components/ui.tsx` の `githubBudgetLabel` / `githubBudgetLow`。null なら行を出さない。#604）
- **昇格待ち**（#282）: 最新タグの昇格待ち・昇格に失敗した版のままのときは、どの workspace でも新しく始めない（全体に 1 回の判定）。Task が動いているための昇格待ちは次の発火まで待たない: Task のターンが終わる・Task が終わるたびに running / waiting を数え、0 件になったら同じ判定をもう 1 回して昇格を依頼する（ログに「バックログを進める: Task が空いたので <タグ> の昇格を依頼」。#626）。依頼は 1 回だけで、失敗した版には出さない。昇格のあと次の項目を始めるのは次の発火（今と同じ）。待っている理由はバックログ画面の上に 1 行（「<タグ> の昇格待ち: 動いている Task N 件が終わると入る」／「昇格に失敗した版のまま: <タグ>」と「救援画面 →」。`GET /api/daemon/release` の `hold`。[releases-and-rescue.md](releases-and-rescue.md) の Unattended updates）

工程 Task の開始は、ボタン・定期実行・判断待ちの回答の続行で 1 つの `startStage`（#936）: その Issue の工程 Task が running / waiting か作成中なら始めない。定期実行は GitHub を読んだ後に選ぶので、その間に始まった項目は「飛ばした: <ws>: #n は工程 Task が動いている / 開始中」とログに出して同じ枠の次の項目を選ぶ。

空きのある workspace だけ並列に取り込み（取り込み終わるのを待ってから保存値で選ぶ）、取り込めない workspace（`gh` の失敗・制限中・ディレクトリが無い）はその workspace だけ飛ばす。

選ぶ順（`pickNext(items, slot)`）: 判断待ち・工程 Task が動いている項目を除き、実装の枠は **回答済みの実装中 → 待ちが解けた実装中（#817）→ 閉じられる実装中 → 止まった実装中の再開 → Ready**（#578）、計画の枠は **分解待ち → 要望**（全体では「実装中 → Ready → 分解待ち → 要望」。終わりに近いものから。仕掛かりを増やさない）、同じ順位では Priority（P0 → P3、無しは最後）→ 作成の古い順（実装の枠は、選んだ項目の実装が「起動前の重なり判定」で重なるときは、その項目を飛ばして次を選ぶ）。ただし枠の中では、この順より先に **実装中（上の順）→ まだ取り組んでいない → 取り組んだが更新あり** で並べる（#624。計画の枠では、更新のあった分解待ちより未着手の要望が先になる）。

- **前回から更新が無い項目**（#624）: 要望・分解待ち・Ready の項目で、`lastTask` の工程（`lastTask.action`）が今の工程と同じ（要望 → 「PBI にする」、分解待ち → 「Task に分解」、Ready → 「実装」。ボタンで始めたものも）、その Task が終わっていて（done / error / aborted。終わり方は問わない）、Issue の `updatedAt` がその終わった時刻より新しくないもの（`isUnchanged`）は選ばない。同じ工程で取り組んだが、そのあと Issue が更新された（コメント・`## 回答`・本文やラベルの変更）ものは選ぶが、同じ枠のまだ取り組んでいない項目の後ろ。更新の書き手は分けない（利用者もエージェントも同じアカウントで書く。工程 Task が終わったあとの更新を利用者のものとみなす）。待ちの記録のある PBI は下の「待ち（#817）」の規則で相手を追う。それ以外の依存は追わない（その項目に 1 行コメントすれば候補に戻る。ボタンからはいつでも始められる）。比べるのは既にある `lastTask` と `updatedAt` だけで、選んだ履歴は持たない。最後の工程 Task が別の工程（例: 「Task に分解」が終わって Ready になった PBI）なら、まだ取り組んでいない項目として扱う。実装中（In progress / In review）の PBI の空回りは #578 の規則（下の「前回の再開から進んでいない」）で、この規則は要望・分解待ち・Ready と、実装中の「閉じる」だけ
- **回答済みの実装中**（#562）: stage `in-progress` の PBI で、`answeredAt`（PBI か子 Task の最新の `## 回答`）が `lastTask`（その PBI の最後の工程 Task）の `updatedAt` より新しいもの。終わった工程 Task の `updatedAt` は終わった時刻なので、「前回の工程 Task が止まったあとに答えた」PBI だけが選ばれ、答えていない実装中の PBI は選ばれない。回答のあとに状況確認（`check`）の Task が終わっていれば、それが最後の工程 Task になるので再開しない（状況確認が新しい `## 判断待ち` か `## 状況` を出している）。バックログから工程 Task を始めたことの無い PBI（`lastTask` が null）は選ばない（それを動かしている人・セッションが回答を読む）。action は「実装」（`complete`）。実装中の行のボタン（状況確認）とは別。判断待ちが PBI にも子 Task にも残っていれば stage が `needs-decision` なので選ばれず、同じ枠のほかの項目が進む。回答の中身は読まない（工程 Task の定型 prompt が読む）
- **待ちが解けた実装中**（#817）: 待ちの記録があり（`waitsAt` がある）、相手が全部 `state: "met"`（重なりはクローズ済み、前提は完了。#937）で前提（下の「前提」）も全部成立した Ready / 実装中の PBI。action は「実装」（`complete`）。release の後に実装が終わっているので「前回から更新が無い」でも止めない。始めた実装は待ちより後の工程 Task なので待ちを古くし、次の発火で選び直さない
- **待ちが開いている項目**（#817、#1046、#937）: 待ちか前提の 1 つでも `met` でない（開いている・未取得・取り下げ・循環・判定できない）Ready / 実装中の PBI は選ばない（未取得・取り下げは解けたとみなさない）
- **閉じられる実装中**（#578）: `closable`（sub-issue が全部完了、利用者確認の項目も無い）の実装中の PBI。action は「閉じる」（`close`、#523）。最後の工程 Task が「閉じる」で、終わっていて、Issue の `updatedAt` がその終わった時刻より新しくなければ選ばない（閉じるが失敗した PBI を発火ごとに始め直さない。#624 と同じ比べ方）。そのときは「前回から更新が無い」の行に出る
- **止まった実装中**（#578）: 上のどれにも当たらない実装中の PBI で、sub-issue に開いたものが残るもの（工程 Task を一度も始めていない PBI も含む）。action は「実装」（`complete`）で、定型 prompt は再開の文: sub-issue・関連 PR・受け入れ条件を確かめ、Issue に `## 状況`（状況確認と同じ書式）を書き、末尾に `<!-- tasks-done: N -->`（選んだ時点の閉じた Task の数。prompt に数を書く）を 1 行入れる。利用者の判断が要れば `## 判断待ち` を出して止め、要らなければ `pbi-complete` で続きを進める。止まっているかの中身の判断は再開の Task がし、デーモンは項目の値（Task の数・判断待ち・工程 Task・`## 状況` の印）だけで選ぶ。印を書く前に終わった再開は次の「前回の再開から進んでいない」のもう 1 つの形で止める
- **前回の再開から進んでいない**（#578）: 止まった実装中の PBI のうち、最新の `## 状況` の `tasks-done` の印が今の閉じた Task の数と同じで、その `## 状況` より新しい `## 回答`（PBI か子 Task）も無いものは選ばない。Task が 1 つ閉じるか、回答が付けば選ばれる。印の無い `## 状況`（状況確認のもの）は止めない。再開の回数・間隔の設定は持たず、記録も別に持たない（読むのは保存データの `## 状況`。GitHub の Issue のコメントと同期）。もう 1 つの形（#1051）: 最後の工程 Task が終わった「実装」で、Issue の `updatedAt`・閉じた Task の `doneAt`・最新の `## 回答` のどれもその Task の開始（`lastTask.createdAt`）より新しくない PBI も選ばない（再開が印を書く前に終わった: ランナーの異常終了・予算切れ・中断・GitHub に書けない）。再開の定型 prompt は最初に印つきの `## 状況` を書くので、書けていれば Issue が Task より新しい。Ready から始めた「実装」は `pbi-complete` が着手の決定ログを先に書くので、同じく Issue が Task より新しく、止まっても 1 回は再開される（#578 の受け入れ条件 2）。1 行のコメント・Task を閉じる・回答で候補に戻る。ログは同じ「前回の再開から進んでいない」の行。再開と Ready の実装は工程 Task の `stage` で分けない。閉じた Task の時刻は `closedAt` ではなく保存済みの sub-issue の `updatedAt` を使う（閉じた後の更新で余分な再開が 1 回増えるだけ）
- **前回の Task が失敗したまま更新が無い**（#1275）: stage を問わず、`lastTask` が `error` / `aborted` で終わっていて、Issue の `updatedAt` がその終わった時刻より新しくない項目（`failedSince`）は選ばない。使用上限や組織の設定でランナーが起動できない Task は数秒で終わり、`## 状況` の印も何も書けないので、#578 の規則では止まらず、毎時の発火のたびに再開されていた。Issue が更新されれば（コメント・`## 回答`。子 Task の `## 回答` も）、または Task が閉じれば（`tasks.doneAt`、#1051）選ばれる。使用上限で自動再開が予定されている Task（`lastTask.resumeAt`）は、再開で running になれば `activeTaskId` が止め、ログに戻る時刻を出す
- **返事待ち**（#1275）: `lastTask` が終わっていて、その判定が要対応（`outcome = needs_action`、#492）で未確認（`reviewedAt` が無い）、Issue の `updatedAt` がその終わった時刻より新しくない項目（`awaitingReply`）は選ばない。運用の確認は Task の会話で聞いて Issue に書かない（CLAUDE.md）ので、Issue からは止まっている理由が見えず、始め直しても同じ問いで止まるため。Task に返信すれば Task が再開し（`activeTaskId`）、Issue が更新されるか（`## 回答` もただのコメントも。子 Task の `## 回答` は親の `updatedAt` を動かさないので `answeredAt` でも見る）Task を画面で確認済みにすれば選ばれる（確認済みは stage を問わず効く。Ready の項目と実装中の「閉じる」を止める #624 / #578 の「終わって以後 Issue の更新が無い」も、要対応を確認済みにした Task では効かない）。`## 判断待ち` を Issue に書くことはしない（要望 #1271 の解釈メモ）

選んだ項目は上の「工程の開始」のボタンと同じ Task になり（その workspace で動き、meta 以外なら `otherRepoRules` の読み替えつき）、スケジュールの Task としてキューの「夜間の実行結果」に出る。

定期タスク画面のログに、発火ごとに始めた Task ごとに「<workspace> #N を <action> で開始 <Task id>」、始めなかった workspace・枠ごとに「飛ばした: <workspace>: <枠>: <理由>」（枠が埋まっている・進められる項目が無い・使用量。枠の数が 0 の枠は出さない）。GitHub と照合できなかった workspace は「飛ばした: <workspace>: GitHub と照合できない（保存データで進める）: <理由>」を 1 行出して、保存データで選び続ける（#2264）。枠の中に前回から更新が無い項目があれば、その枠で選ぶとき（枠が埋まっていない・使用量で止めていない）に「飛ばした: <workspace>: <枠>: 前回から更新が無い: #N #M」を 1 行（選んで始めた項目があっても出す。#624）。実装の枠では同じく「飛ばした: <workspace>: 実装の枠: 前回の再開から進んでいない: #N #M」を 1 行（#578）と、待ちと前提で選ばなかった項目を最大 3 行（#817、#937。`heldIn`）:「飛ばした: <workspace>: 実装の枠: 待ち: #N（PR #n）」（重なりの相手でまだ開いているもの）、「…: 前提: #N（#m 未完・PR #n マージ待ち・PR #k リリース待ち）」（`waits=` と本文の前提のうち未完のもの。閉じれば次の発火で始まる）、「…: 進められない: #N（#m 取り下げ・#99 見つからない・#9 と循環・PR #k の反映を確かめられない）」（人が本文か相手を直すもの）。実装の枠で重なりのために飛ばした項目は「飛ばした: <workspace>: 実装の枠: 重なり: #N（PR #n: <path>・Task #m: <path>）」と「…: 重なりを判定できない: #N（<理由>）」（#1044。下の「起動前の重なり判定」）。どの枠でも「飛ばした: <workspace>: <枠>: 返事待ち: #N #M」と「飛ばした: <workspace>: <枠>: 前回の Task が失敗したまま更新が無い: #N（使用上限、MM/DD HH:MM に戻る） #M」を 1 行ずつ（#1275。この 2 行に出した項目は「前回から更新が無い」の行には出さない）。使用量・昇格待ちで全体を止めたときは「飛ばした: <理由>」を 1 行（GitHub の残量では止めない。#2264）。「前回の Task が動いていれば飛ばす」はプロンプトのスケジュールだけの決まりで、backlog-next は上の枠の判定がその代わり。

無人で始めた「実装」（`complete`）のマージ判定（merge-gate、再チェック）は `pbi-complete` の 5 に従う（[merge-gate.md](merge-gate.md)）。指示文はボタンでも定期実行でも同じで、別リポジトリでは `otherRepoRules` が `--repo` と再チェックの手順の場所を渡す（#783）。無人でマージしてよいが影響を判定し戻れる仕組みを持つ、という条件は要望 #261 への利用者の回答と #267 のコメント（2026-09-23 UTC）による。運用の確認は Task の会話で聞く（#719）。再チェックだけの stop は聞かずに再チェックを回す（#751、要望 #750）。戻す仕組みは #282、確認の記録の印は #761。

既定の cron は `0 */3 * * *`（3 時間ごと。エージェントが決めた値）。

## 起動前の重なり判定（#1044）

定期実行の実装の枠は、セッションを起動してから `/pbi-complete` の `overlap` が重なりを見つけて何もせず終わる run を減らすため、起動の前に同じ判定を保存した記録だけでする。

- **規則**: `scripts/parallel-guard.ts` の `pathsIn`（Task の本文に名指しされたパス。ディレクトリは前方一致）と `judge`（`STALE_HOURS` = 72 時間触られていない相手は止めない）をそのまま import して使う。自分のパス = Ready / 実装中の PBI の開いている子 Task の本文のパスの和（0 件なら判定しない）。相手 = Draft でも `needs-decision` でもない開いた PR（その PBI と子 Task を閉じる PR = 自分のものは除く）と、ほかの PBI の Project の Status が In progress で `needs-decision` の無い Task。Draft・判断待ちは相手にしない（「保留中の PR と並列占有」と同じ）
- **材料**: 保存した `pull-request` の記録（`files` `updatedAt` `closes` `isDraft` `labels`）と Issue の本文・Project の Status、ワークツリーのルートの `readdirSync`（Task の本文のパスを読む最上位の名前。PR のファイルの先頭の段も足す）。発火ごとの GitHub の読み取りは増えない（取込みの最初のページに相乗り）。PR の `files` が null（記録に無い・101 件以上）なら判定できない
- **項目の値と画面**: `overlap: { hits: [{ ref, path }], unknown }`（ref は `PR #n` / `Task #m`、path は相手の側のパス。判定しない・重ならないときは null）。Ready と実装中の行の下に「重なり: PR #n（<path>）・Task #m（<path>）」、判定できないときは「重なりを判定できない: <理由>」（警告色、番号は GitHub へのリンク）
- **選び方**: `pickNext` は、選ぶ行動が実装（`complete`）の項目が重なる（`hits` か `unknown` がある）ときは飛ばして次の候補を同じ順序で選ぶ。全部重なれば何も始めない。閉じる（`close`）と計画の枠は対象にしない（ファイルを触らない）。飛ばした履歴は持たず、発火ごとに保存値から判定し直すので、相手が閉じる・Draft・`needs-decision` になれば次の発火で元の順位に戻る
- **ログ**: 「飛ばした: <workspace>: 実装の枠: 重なり: #N（PR #n: <path>・Task #m: <path>）」「…: 重なりを判定できない: #N（<理由>）」
- **セッション内の `overlap` との役割分担**: デーモンは起動しないだけで、占有・着手・解放のコメントを Issue に書かない。画面のボタン「実装する」と手で始めた `/pbi-complete` は重なりがあっても今までどおり始められ、二重編集はセッション内の `overlap`（`scripts/parallel-guard.ts`）が止める。起動前の判定は保存値の鮮度のぶん古いことがあるので、セッション内の判定が正本のまま

## 待ち（#817）

`/pbi-complete` がファイルの重なり・前提の未完で Task を後回しにして止まるとき、待っている相手を PBI のコメントに残す。待ちは保存データ（GitHub の Issue のコメントと同期）にある（「保存」）。

- **記録の形**: `scripts/parallel-guard.ts` の `release <PBI> <理由> --overlap-waits n,n`（重なり）/ `--waits n,n`（前提）が書く占有の印 `<!-- pbi-complete:release overlap=603,778 -->` / `<!-- pbi-complete:release waits=603,778 -->`。相手は同じリポジトリの PR / Issue の番号。待ちの無い release（完了・判断待ち・返事待ち）と新しい claim は印に番号を載せず、前の待ちを打ち消す
- **読み方**（`waitsOf`）: PBI の `pbi-complete:` の印のうち一番新しいものが番号つきの release で、それより新しい `## 回答` が無いときだけ待ち。`waitsAt` はその release の日時。それより後に作られた実装（`complete`）の工程 Task があれば、デーモンが待ちを古いものとして空にする（server.ts `withActive`。状況確認では外れない）
- **項目の値**（`withWaits`）: `waits[]` の各相手に `number` `kind`（`issue` / `pr`）`open`（`true` 開いている / `false` マージ・クローズ済み / `null` 状態を取れなかった — 保存に無い・GitHub が NOT_FOUND / FORBIDDEN。`kind` は `issue` 扱い）`reason`（`overlap` / `prerequisite`。`--overlap-waits` より前に書かれた `waits=` は重なりだったかもしれないが、どちらでも閉じるまで待つ）`pbi`（#1183。相手の PBI = その相手を進めている PBI の `{ number, title }`。相手が Issue なら、それが PBI ならそれ自身、Task なら保存した記録の親。PR なら `closes` の Issue を順に同じ規則で引いて最初に引けたもの。保存した Issue に題が無ければ `title` は null、引けなければ全体が null = 不明。相手の PBI の工程 Task（id・状態）は待ちに写さず、同じ応答の相手の PBI の項目の `activeTaskId` / `lastTask` を読む）。Draft・`needs-decision` の PR は保留なので待ちから外し、重なりの待ちの `needs-decision` の Task も外す（前提の Task は外さない）
- **状態の読み方**: 取込みの ③（番号で再確認）が、待ちの相手のうち閉じた要望・PBI・Task でないものを `issueOrPullRequest` で読み直す（最大 20 件ずつ）。相手の中身・題名は見ない
- **画面**: Ready と実装中の行（`report` があればその下）に 1 行。「待ち: PR #778（開いている）・#603（完了）」（番号は GitHub の `/pull/<n>` / `/issues/<n>` へのリンク、別タブ）、全部閉じれば「待ちが解けた: …」（記録はあるが相手が全部外れた — Draft・判断待ちの PR — ものは相手を挙げず「待ちが解けた」。backlog-next・受信箱と同じ読み方）。次の行に解ける条件（重なり: 相手が閉じてファイルの重なりが解けたら / 前提: 前提が完了したら / 未取得を含めば「未取得の相手は状態が分からない」）と、次に動かすもの: 定期実行「バックログを進める」が有効で実装の枠が 1 以上（画面が既に読む `/api/schedules` と `/api/settings` の `backlogSweep.implement`。新しい API は作らない）なら「次の定期実行で再開」、そうでなければ「定期実行が無効: 」に人の操作（Ready は「「実装する」で再開」、実装中は「/pbi-complete N を手で始める」— 行の「状況を確認」は再開しない）。未取得の相手があれば定期実行は再開しないので「定期実行は再開しない: 未取得の相手を確かめて…」。相手の Issue の親の PBI（`pbi`。相手が PBI 自身のときは親が無いとみなし、たどらない）がバックログにあって待ちを持てば `<details>`「待ちの先（n）」でその PBI の待ちを 1 段ずつたどる（`waitChain`。開いている Issue だけたどり、循環は止める。`pbi` が無い・バックログに無い相手は「#n の先: 未取得」と出し、推測で埋めない。状態が未取得の相手は行に「（未取得）」と出るのでたどらない）。定期実行が有効かは開いたときと「再読込」で読み直す。行の待ちの相手ごとに、後ろに相手の PBI と工程 Task（#1045）:「待ち: PR #778（開いている） ← #305 <題> の Task <id>（止まっている: 完了） 続きを始める」。相手の PBI は待ちの `pbi`（上の「項目の値」）、その題と工程 Task は同じ応答の相手の PBI の項目（同じ `workspaceId` と番号）の `title` / `activeTaskId` / `lastTask` から引き、別に取りに行かない。`pbi` が null なら「← 不明」、相手の PBI が一覧に無い（閉じた・バックログの項目でない）なら「Task 不明」、工程 Task が無ければ「工程 Task なし」。Task は動いている（`activeTaskId`、または最後の工程 Task が実行中・承認待ち）なら「動いている」、それ以外は「止まっている: <最後の工程 Task の状態>」で、押すとその Task 画面（`onOpenTask`）。#305 は相手の PBI へのリンク（別タブ）。「続きを始める」は閉じていない相手の、止まっている Ready / 実装中の相手の PBI にだけ出し、`/api/backlog/<p>/start` に `complete`（Ready なら実装、実装中なら再開の Task。#1185）を送ってその Task 画面に移る。動いている相手にはボタンを出さず開くだけなので二重に始まらない（サーバも動いている工程 Task があれば 409 + `taskId` で開く）。待ちの先（`waitChain`）の相手にはこれを出さない（1 段だけ。#937）。行の自分のボタンは変わらない（実装中は「状況を確認」）。計算は `apps/web/src/inProgress.ts` の `waitText` / `waitRef` / `waitUrl` / `waitChain` / `waitOwner`
- **受信箱**（`asks.ts`）: 待ちのある PBI は `kind: "wait"` の項目。相手が開いている・解けて再開待ちなら `needs: "auto"`、未取得を含めば何も自動で読み直さないので `needs: "person"`（`route: "backlog"`）
- **ボタン**: 待ちがあっても「実装する」「状況を確認」はいつもどおり始められる
- **やらないこと**: Task の要約の文から待ちを推すこと、別リポジトリの相手、webhook・常時の見張り（次の発火で読む）、自動で再開するかの新しい設定

## 前提（#937）

着手の前に、PBI と Task が本文に明示した前提を判定し、成立していない作業を起動せず、独立した作業を今までの順で進める。待ち（上）が「止まった後に release が記録した相手」なのに対し、前提は「本文に書いた、先に要るもの」。

- **記録の形**: PBI / Task の本文の行頭の 1 行 `**前提**: #12, #34（リリース）`（`**Story Points**:` と同じ形。無ければ `**前提**: なし`）。コードフェンスの中・2 行目以降・自由文の「前提: #9 が Done」や `## 依存関係` の文は読まない（推測しない）。同じリポジトリの番号だけ。`（リリース）` は直後の番号の PR のマージが動いている版に入るまで待つ。読むのは `prereqsOf`（[`backlog.ts`](../../packages/core/src/backlog.ts)）
- **判定**（`prereqState`。保存値から読むたびに組み立て、DB に写さない）:

| 相手 | 状態 | 判定 |
|---|---|---|
| 保存に無い（404・未取得） | — | `missing`（見つからない） |
| Issue | 開いている | `pending`（未完） |
| Issue | 閉じた（`COMPLETED`、または閉じ方を読む前の記録） | `met`。`（リリース）` 付きなら `unknown` |
| Issue | 閉じた（`NOT_PLANNED` / `DUPLICATE`） | `withdrawn`（取り下げ） |
| PR | 開いている（Draft も） | `pending`（マージ待ち） |
| PR | マージ済み | `met`。`（リリース）` 付きならマージコミットが動いている版の祖先で `met`・でなければ `pending`（リリース待ち）・確かめられなければ `unknown` |
| PR | 未マージで閉じた | `withdrawn` |

  開いた Issue の前提をたどって自分に戻るもの（PBI からはその開いた Task の前提も。閉じた Issue からはたどらない）は `cycle`（循環）。`met` 以外の前提がある PBI は定期実行が選ばない（行のボタンは止めない）
- **子 Task の前提**: Ready / 実装中の PBI の項目 `prereqs` には、PBI 自身の前提（`via: null`）と、開いた子 Task の前提（`via: <Task>`）のうち同じ PBI の開いた Task 以外（内部の順番。スタックで積む）を入れる。子 Task の前提は、開いた子 Task の全部が成立していない前提を持つときだけ入れる（1 件でも進められる Task があれば PBI は進められる）
- **待ちの判定も同じ表**: release の `waits=`（前提待ち）の相手は `prereqState` で判定し、未マージで閉じた PR・not planned の Issue を完了とみなさない（#817 の「閉じた = 片づいた」を改めた）。`overlap=`（占有待ち）は今どおり閉じれば成立。Draft・判断待ちの PR を外す扱い（#930）は変えない。`waits[].state` が判定、`open` はそれから作る（met → false、pending → true、ほか → null）
- **リリースの反映**: Switchboard 自身（meta workspace）で sb-rescue の下だけ、`git merge-base --is-ancestor <マージコミット> <current>`（`releasedIn`、[`server.ts`](../../packages/core/src/server.ts)）。終了コード 1 だけを「含まない」として `current` が変わるまで覚え、ほかの失敗（checkout に無い commit・タイムアウト）は覚えずに判定できない（`unknown`）にする。それ以外の workspace は常に `unknown`。定期実行と `GET /api/backlog` に同じ判定を渡す
- **一度だけ始める**: 前提が全部成立した Ready は今までどおり選ばれ、始めた工程 Task（`activeTaskId`・`startingStage`、終わった後は同じ工程の `isUnchanged`、再起動後は aborted の `failedSince`）で二重に始まらない。選んだ履歴は持たない
- **並列ガード**: `scripts/parallel-guard.ts overlap <Task>` が Task と親 PBI の前提を同じ関数で判定して `prereqs: [{ ref, state, sibling }]` を出す（`sibling` = 同じ PBI の Task）。ほかの PBI の未完 → `verdict: "wait"`（`/pbi-complete` は後回しにして独立した Task へ、全部止まれば `release --waits`）、取り下げ・見つからない・Issue に付けた `（リリース）` → `"stop"`（人が直す）。マージ済みの PR の `（リリース）` はガードでは成立（動いている版に入ったかはデーモンが判定し、入るまで定期実行はその PBI を始めない。ガードで止めると、デーモンが始めた PBI を発火ごとに止めてしまう）。相手の状態は番号ごとに REST で読む（404 / 410 は見つからない）
- **画面**: Ready と実装中の行の待ちの下に、前提の 2 行（`prereqLine`、[`inProgress.ts`](../../apps/web/src/inProgress.ts)）:「前提: #12（未完）・PR #34（マージ待ち）・Task #70 の前提 PR #56（リリース待ち）」と、注意の色で「進められない: #13 取り下げ・#99 見つからない・#9 と循環・PR #57 の反映を確かめられない」。番号は GitHub へのリンク。待ちの行（上）は相手の状態を「取り下げ」とも出し、取り下げを含めば「定期実行は再開しない」

## 取込みと失敗

- 画面は開いたときと「再読込」でだけ読み、自動更新はしない。前に読んだ一覧は Web のメモリ（モジュール変数 1 つ）に残し、タブを開いた直後にそれを取得時刻つきで出して、読めたら差し替える（#441）
- 取り込めない workspace（`gh` が無い・未ログイン・GraphQL のエラー・応答の形が違う・Project が読めない・制限中）は、保存した項目をそのまま返し、`errors: [{ workspaceId, workspaceName, message, kind }]` に最後の失敗の理由（`gh` の stderr の先頭 200 字、制限中なら理由と時刻）を入れる。`kind`（#2362）は利用者がすることの種類で、gh を呼んだ場所で決める（画面は stderr の英文を読み直さない）: `gh-login` = gh が未ログイン・ログインを断られた（`call` が stderr の `gh auth login` / `not logged in` / `authentication required` で、送信の `Limit` の `auth` も）、`project-var` = Project の URL のリポジトリ変数が無い（`projectOf` の `variable get` が `was not found`）、`other` = それ以外（制限中・ディレクトリが無い・まだ取り込んでいない・応答の形など。理由の文で足りる）。一度も取り込んでいない workspace は項目なしで「まだ GitHub から取り込んでいません」か失敗の理由（「0 件」として見せない）。ディレクトリが無い workspace もその理由。他の workspace の項目はそのまま返り、全体は 200
- 制限・障害の待ち（`GithubRetryState`。docs/design/github-api-budget.md）の間は取り込まない。待ちの終わりの時刻はリポジトリの `retryAt` にも保存し、再起動したデーモンも守る
- デーモンの `Bun.serve` は `idleTimeout: 120`（秒）。Bun の既定 10 秒だと GitHub を待つ応答（一覧・回答・工程の開始）の接続が切られ、CloudFront の 502 → 停止中のページ → Web がログインページを経て Home に戻っていた（#441）。打ち切りは CloudFront の OriginReadTimeout（60 秒）に任せる
- 工程の開始・判断待ちへの回答は `workspaceId` の workspace の保存した項目を番号で引く（meta が無い・ディレクトリが無いときは 409、一度も取り込めていないときは 424（回答は GitHub に書かずに DB に確定するので、書き込みの失敗では 424 にならない。#886）。502 / 504 にしない: クラウドホストの CloudFront がオリジンの 502 / 504 を停止中のページに差し替え、Web がログインページへ移ってしまう。#364）

## 画面

[`apps/web/src/components/Backlog.tsx`](../../apps/web/src/components/Backlog.tsx)。上の表の順に `card` を並べ、行は `#番号`（GitHub の Issue を別タブで開く）・題名・PBI なら `Task 完了数/件数`・`SP n · Priority`。「要望を登録」は既存のフィードバックダイアログ（[feedback.md](feedback.md)）を開く。行の右端に stage に合うボタンが 1 つ（要望のまま → 「PBI にする」/ 分解待ち → 「Task に分解」/ Ready → 「実装する」/ 実装中 → 「状況を確認」、確認ダイアログなし）。実装中の行で `closable` なら「閉じられる」と、「状況を確認」の隣に「閉じる」（工程 `close`、確認ダイアログなし。#531）。押すと上の「工程の開始」で Task を作ってその画面に移る。`activeTaskId` がある行はボタン（と「閉じられる」）の代わりに「実行中」（押すとその Task）。409 で `taskId` が返ったらその Task を開く。判断待ちの項目は行の下に、問いが子 Task のもの（`decision.issue` が項目の番号と違う）なら「Task #n の判断待ち」（#n は GitHub の Issue へのリンク。#562）、問いの日時・`## 判断待ち` のコメント（Markdown を描画せず文字のまま、改行を保つ）・回答欄・「回答する」。送るとその項目を消して読み直す（GitHub 側でラベルが外れているので判断待ちに戻らない）。実装中の行（#522）には、Project の Status・動いている / 止まっている（`apps/web/src/inProgress.ts` の `inProgressState`。上から最初に当たるもの: 工程 Task が実行中 →「動いている」/ sub-issue が 1 件以上で全部完了 →「止まっている: Task は全部完了、PBI は開いたまま」/ 最後の工程 Task が失敗 / 工程 Task なし / それ以外は最後の工程 Task の終わり方）・「更新 N 日前」（Issue の `updatedAt`。分 / 時間 / 日）・「最後の Task: <状態> <経過>」（押すとその Task。実行中ならそれは「実行中」なので出さない。Ready の行にも同じものを出す — 止まった工程 Task をその PBI の行から開ける。#1045）。`report` があれば行の下に「<日時> の状況」と本文の見出し `## 状況` の次から 3 行（残りは「…」。Markdown は描画しない）。判定は保存せず、しきい値の設定も無い。承認待ちの Task（`GET /api/queue` の `waiting`）があれば、上に「承認待ち N 件 →」（定期タスク画面へ）。各行に workspace 名。工程のボタンと回答欄はどの workspace の行にも出し、その行の `workspaceId` を送る。workspace が 2 つ以上なら上に「すべて N / <workspace> N …」の切り替え（選択は localStorage。登録から消えた workspace なら「すべて」）。選んだ workspace の行と `errors` だけを出す。`errors` があれば上に workspace ごとに、`kind`（#2362。上の「取込みと失敗」）で次にすることを出す（`workspaceErrorGuide`、[`backlogSync.ts`](../../apps/web/src/backlogSync.ts)）: `gh-login` は「<workspace> を読むには gh のログインが要ります」と手順（ターミナルで `gh auth login`、終わったら「再読込」）、`project-var` は変数の名前と 2 つの道（Project を用意する: 公開側の `ops-kit/README.md` の「fork して開発を始める」へのリンク / GitHub と連携しないで使う: 設定の「Workspace」の「ホストのパス」で「GitHub と連携しない」で自分のリポジトリを追加するか、設定の「GitHub 同期」でこの workspace の同期を無効にする）、`other` は今どおり「<workspace> を読めませんでした: <理由>」。`gh-login` / `project-var` では gh の元の文を小さい「詳細: …」に下げ、リポジトリ変数の入力欄は `project-var` と `other` だけに出す。画面に開発側の Issue 番号は出さない。要求自体が失敗したら「GitHub を読めませんでした: <理由>」を出す。見出しは `backlogHeading`: 見ている workspace に GitHub と連携するものが 1 つでもあれば（workspace の一覧が未着のときも）「HH:MM に GitHub から取得」、連携なしの workspace だけなら「Switchboard に保存（GitHub と連携しない）」。並び替え・折りたたみはしない。

## スコープ外

PBI #264 を切ったとき（エージェントが要望 #260 / #261 から PBI にしたときの判断）に外したもの:

- ~~meta workspace 以外のリポジトリ~~ — #294 で全 workspace を読むようにし、#438 で工程のボタン・回答も全 workspace に（スキルは meta のものを読み替えて使う）、#561 で backlog-next も全 workspace に（運用スキルの共通化は #205 / #206）
- 画面から Issue を編集すること — #886 / #910 で入った（保存データに確定して GitHub に送る）。工程の開始は #265、判断待ちへの回答は #266
- Webhook での即時反映 — この PBI の範囲外。GitHub 側の変更の取込み（通知を受けられる環境の Webhook と差分照合）は要望 #882 の段階 2 の #887
- Done の一覧、Task 単体の行

## 検証

- `bun test packages/core/src/backlog.test.ts`: 偽 `gh`（固定応答 `packages/core/fixtures/backlog-graphql.json`、2 ページ。`packages/core/fixtures/github-import.ts` が取込みのクエリに訳す）から各 stage・Project のフィールド・Task 数、保存値を読む GET と `refresh=1` の取込み、再起動と復元した DB で gh が throw しても保存値と判断待ちが返る、`gh` の失敗・形の違う応答・ディレクトリが無い → その workspace の `errors`（他は返る）、複数 workspace の集約、他リポジトリの同じ番号に `activeTaskId` が付かない、backlog-next の枠（`-t "backlog-next slots"`: 3 workspace で 6 件・枠が埋まっていればその枠だけ飛ばす・使用量 0.8 以上は全体で 1 件まで・1 workspace の `gh` の失敗・設定 `backlogSweep`）、始めるランナーの使用量（`-t "backlog quota"`: codex のスケジュールは claude の使用量で止めない・codex 0.85 なら 1 件まで・上限のときの代わりで codex に移ると codex の使用量で判断・種類の既定で実装だけ claude なら claude の使用量で実装だけ止める。#834）、GitHub の残量（`-t "GitHub budget"`: 残量 500 で取り込みが制限で断られても発火は保存データで始まり、残量の行も出さない（#2264）、工程のボタンは残量 500 でも始まる、1 分以内の 2 回目と失敗の後は gh を呼ばない、制限で断られた読み取りは残量 0（ボタンは取り込みが通らなくても保存データで始まる。#2264）、制限以外の失敗・答えない gh は止めない、`/api/ledger/summary` の `github`、`rateLimit` を答えない gh では null で今までどおり始まる。#549）、前回から更新の無い項目（`-t "pickNext unchanged"`: 飛ばす・更新ありは未着手の後ろ・別の工程なら選ぶ・回答済みの実装中は先頭のまま。`-t "backlog-next unchanged"`: 発火で始まらずログに「前回から更新が無い: #304」、ボタンからは 201。#624）、止まった実装中（`-t "stalled"`: 閉じられる → `close`・確認項目が残る → 選ばない・Task が残る → 再開・印が同じ → 選ばずログに「前回の再開から進んでいない: #305」・Task が閉じた / 新しい回答 → 選ぶ・実装の枠の順・再開の prompt。#578。印を書かずに終わった再開 → 選ばず、Issue の更新 / Task が閉じた / 回答 / 状況確認が最後なら選ぶ。#1051）
- 待ち（#817、#1046）: `bun test packages/core/src/backlog.test.ts -t "waiting"`（release の印から相手・状態・理由、未取得は `open: null` で残る、Draft・判断待ちの PR、新しい release・claim・`## 回答` で消える）、`-t "pickNext waiting"`（解けた実装中は回答済みの次・Ready より前、開いている・未取得の相手は Ready も実装中も選ばない）、`-t "backlog-next waiting"`（ログの「待ち: #307（#603・PR #778）」「（未取得）」、解ければ次の発火で実装、状況確認では外れない）、`bun test packages/core/src/backlog-stored.test.ts -t "waiting"`（親 PBI）、`bun test apps/web/src/inProgress.test.ts`（`waitText` / `waitRef` / `waitChain`）。E2E の場面は下
- 起動前の重なり判定（#1044）: `bun test packages/core/src/backlog-stored.test.ts -t "pickNext overlap"`（重なる PBI を飛ばし重ならない次を選ぶ・全部重なれば選ばない・Draft / 判断待ち / 自分の PR / 古い相手は相手にならない・`files` が null は判定できない）、`bun test packages/core/src/backlog.test.ts -t "backlog-next overlap"`（発火で始まらずログに PR と path、`issue` / POST が無い、PR が閉じれば選ばれる）、`bun test packages/core/src/backlog-sync.test.ts -t "open pull requests"`（取込みが開いた PR をファイルつきで保存し、呼び出し回数は増えない）、`bun test apps/web/src/inProgress.test.ts -t overlapLine`
- 前提（#937）: `bun test packages/core/src/backlog.test.ts -t "prereqsOf"` / `-t "prereqState"`（判定の表）/ `-t "backlog-next prerequisite"`（A→B と独立 C、連続発火・再起動・ボタンと発火、リリース、取り下げ・見つからない・循環、#930 の Draft と前提）、`bun test packages/core/src/backlog-stored.test.ts -t "pickNext prerequisite"`（子 Task の前提・循環・フェンス）、`bun test packages/core/src/backlog-sync.test.ts -t "prerequisites"`（取込み）、`bun test scripts/parallel-guard.test.ts -t "prereqs"`、`bun test apps/web/src/inProgress.test.ts -t "prereqLine"`
- `env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/backlog.test.ts -t "promote: when idle"`: 偽 sb-rescue・タグ付きの一時 git・ターンを外から終える偽ランナーで、Task が動いていて見送った昇格が、その Task のターン終了で 1 回だけ依頼される／もう 1 件残っていれば依頼しない／依頼のあとに別の Task が終わっても 2 回目は無い／発火が git を読んでいる途中に終わった Task も取りこぼさない／失敗した版には依頼しない／sb-rescue の外では何もしない（#626）。`bun test apps/web/src/release.test.ts -t promotion`: 画面の 1 行の文言
- `bun run --cwd apps/web build && bun scripts/backlog-e2e.ts`: 同じ固定応答のデーモン（+ 2 つ目の workspace `acme/lib`、`backlog-graphql-2.json`。meta と同じ #304 を持つ）+ headless Chrome で、各列の行・リンク・行の workspace 名と、どの workspace の行にもボタン・回答欄があること・workspace の切り替え（件数・絞り込み・画面を移っても保持）・lib の「実装する」で lib の cwd の Task・「再読込」・「要望を登録」・行のボタン（Ready →「実装する」→ Task 画面 → 戻ると「実行中」）・判断待ち（問いの本文 → 回答 → 項目が消え、偽 `gh` に `issue comment` と `--remove-label needs-decision`）・子 Task の判断待ち（#562: 実装中の #307 の子 Task #330 に判断待ち → #307 が判断待ちに「Task #330 の判断待ち」（#330 へのリンク）と問いつきで出る → 回答 → 消え、偽 `gh` に `issue comment 330` と `issue edit 330 --remove-label needs-decision`）・実装中の行（#522: #305 に「In review」と `## 状況` の日時・見出しの次から 3 行 +「…」、#307 に「止まっている: Task は全部完了」と「更新 N 日前」、DB に #305 の終わった工程 Task を作ると「最後の Task: 完了 3 時間前」で押すとその Task、#307 の「状況を確認」→ `#307 状況確認: ` の Task 画面 → 戻ると #307 は「実行中」だけ）・閉じられる（#531: Task 2/2・確認項目なしの #307 にだけ「閉じられる」と「閉じる」、状況確認の Task を止めて再読込 →「閉じる」→ `#307 閉じる: ` の Task 画面で prompt が pbi-complete の 6 を頼む → 戻ると #307 は「実行中」だけで「閉じられる」も出ない。出力の JSON の `closable`）・待ち（#817: #307 に重なりの release（PR #778 と #305 の Task #30501）、#305 に PR #779 待ち → #307 の下に「待ち: PR #778（開いている） ← 不明・#30501（開いている） ← #305 …」とリンク・解ける条件・「次の定期実行で再開」、「待ちの先」に「#30501 の先: #305 が待つ PR #779（開いている）」→ 定期実行を無効にすると「定期実行が無効: /pbi-complete 307 を手で始める」→ 記録の無い #999 で「#999（未取得）」「定期実行は再開しない」→ PR #778 を MERGED にして「待ちが解けた」→ 待ちのある #307 の「状況を確認」から Task が始まる）・相手の PBI（#1045: PR #778 の本文に `Closes #30501`、枝 `sb/30501-link` → #307 の下に「← #305 <題> の Task task_e2e305（止まっている: 完了） 続きを始める」→ Task を押すと `#305 実装: ` の Task 画面 →「続きを始める」で新しい `#305 実装: ` の Task（prompt は「実装中のまま止まっています」）→ 戻ると「Task <新 id>（動いている）」で「続きを始める」は無く、押すと開くだけで Task は増えない → 390px で横スクロール無し・待ちの行のリンクとボタンが画面内・Task が開く → 止めた後、Ready の #304 の行の「最後の Task: 中断」で `#304 実装: ` の Task 画面。出力の JSON の `waitOwner`）・定期タスク「バックログを進める」（追加 → 今すぐ実行 → 工程 Task ができ、ログに meta と lib それぞれの「<workspace> #N を <action> で開始」。枠の入力で実装を 2 にして保存 → 再読込で 2 のまま。#561）・失敗時の workspace ごとの表示・GitHub が遅いとき（偽 `gh` を 1 回 2.5 秒待たせ、取込み 6 回ぶんで 15 秒の「再読込」）に前回の一覧が 1 秒以内に「読み込み中…」と前回の取得時刻つきで出て、15 秒以上バックログ画面のまま（`/_auth/` にも Home にも移らない）、読めたら取得時刻が変わる（#441）・昇格待ちの 1 行（#626: meta の checkout を v0.1.0 のタグ付きの一時リポジトリ、偽 sb-rescue がそれを動かしている間は行が出ない → v0.2.0 を付け、Task が動いたまま発火 → 再読込で「v0.2.0 の昇格待ち: 動いている Task N 件が終わると入る」→ 偽 sb-rescue の履歴を `auto-rollback` にしてもう一度 → 「昇格に失敗した版のまま: v0.2.0」と救援画面へのリンク（別タブ）。偽 sb-rescue に昇格の依頼は届かない）、console error 0 開いた PR と重なる Ready の行の「重なり: PR #n（<path>）」（PR へのリンク）、その行のボタンからは今までどおり Task が始まり、定期実行の発火はその PBI を始めずログに「重なり: #N（PR #n: <path>）」（#1044）。
- GitHub 連携の無い workspace（#2265）: `bun run --cwd apps/web build && bun scripts/backlog-local-e2e.ts`（gh は throw して記録、偽ランナー、headless Chrome）で、設定の「Workspace」の「ホストのパス」で「GitHub と連携しない」を入れて登録 → `ops-kit backlog create` の要望 #1 が「要望のまま」→「PBI にする」の to-pbi Task（prompt に `ops-kit backlog`、`gh repo view` 無し、env に `BACKLOG_WORKSPACE`）→ PBI #2 と #1 の `## 派生 PBI` で #2 が「分解待ち」→「Task に分解」→ Task #3 と `backlog set 2 Status Ready` で #2 が「Ready」→「実装する」の complete Task。390px でチェックが欄の下に収まり、その workspace への gh の呼び出しは 0。単体は `packages/core/src/backlog-local.test.ts`、`scripts/parallel-guard.test.ts` の #2265、`ops-kit/src/backlog-client.test.ts` の #2265

### 保留中の PR と並列占有

Draft または `needs-decision` の PR は、存在するだけではファイルを占有しない。判断待ちの Task も占有しない。通常の open PR と判断待ちでない In progress Task は並列ガードで保護するため、Draft を実装中の Task と同時に同じファイルを編集することは防ぐ。先着 claim は同時編集を防ぐための順序であり、保留 PR を先に完成させる優先順位ではない。

過去の release に保留 PR の `waits` が残っていても、バックログは取り込むたびに PR の Draft・判断待ち状態を確かめ、現在の待ち対象から外す。`waitsAt` は残るので、Issue が最終実装後に変更されていなくても再開候補になる。PR が ready に戻れば再び待ち対象となる。画面は保存値を読み、再読込・回答・定期実行は取り込み直す。Issue の未完の前提は保留 PR と区別し、完了するまで待つ。保留した PR を閉じたりマージしたりする必要はない。

ファイル重複による停止は `release --overlap-waits`（`overlap=`）、未完の前提は `release --waits`（`waits=`）で記録する。重複相手の Task が判断待ちへ移った場合だけ占有待ちを外す。古い `waits=` の Task 待ちは理由を区別できないので前提として保持し、必要なら手で再開して overlap を確かめ直す。

## 閉じた PBI の流れの計測（#650）

閉じた PBI が要望から閉じるまでの段ごとの時間は `bun scripts/flow-report.ts` で出す（[flow-metrics.md](flow-metrics.md)）。

## 繰り返す停止（#939、#950）

最後の工程 Task が同じ条件で再停止し、変化（原因・回答・条件成立）が無いとき、Issue の無関係な更新だけでは再選択しない（`stopHeld`）。`## 回答`・待ちの解除・条件の成立で外れる。詳細は `repeated-stops.md`。
