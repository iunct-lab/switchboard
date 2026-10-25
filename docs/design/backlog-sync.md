# バックログの編集を GitHub に送る（#886）

GitHub に届かない間（API の制限中、通信の障害、デーモンの再起動の前後）も、Issue・Project の編集と回答を失わず、届くようになってから送る。保存の方式は [backlog.md](backlog.md) の「保存（#885）」と同じ SQLite（利用者の承認は要望 #882）。PR・レビューは扱わない。

## 何をローカルに確定するか

API はどれも DB に確定してすぐ 202 を返し、GitHub を待たない（[`server.ts`](../../packages/core/src/server.ts)、組み立ては [`backlog.ts`](../../packages/core/src/backlog.ts) の「edits kept here」）。

| 操作 | API | 送信待ち（`backlog_operations`） |
|---|---|---|
| 新しい Issue | `POST /api/backlog { workspaceId, title, body, labels, milestone, parent, fields }` | `create` 1 件。id が `localId` で、番号が付く前も後も `GET/PATCH /api/backlog/<localId>` で読める |
| 編集 | `PATCH /api/backlog/:number { title?, body?, labels?: { add, remove }, state?, milestone?, parent?, project?, fields? }` | 変わるフィールドごとに `set` 1 件（ラベルは `label:<name>`、Project は `member` と `field:<名前>`）。まだ送っていない `create` は操作を増やさずその中身を変える |
| コメント（#910） | `POST /api/backlog/:number/comment { workspaceId, text }` | `comment`（見出しなし、ラベルは触らない）1 件 |
| 判断待ちの回答 | `POST /api/backlog/:number/answer` | `comment`（`## 回答`）→ `set label:needs-decision = false` |
| 利用者確認の回答 | 同上（`confirm`） | 確認した: `set body`（その行だけ `- [x]`）→ `comment`。違う: `comment` だけ |

- 編集と送信待ちは 1 トランザクションで両方入るか両方入らない（`Db.applyBacklogEdit`）。バックアップ（`snapshotTo` / Litestream）にもそのまま入り、復元した DB から続きを送る
- 同じ記録の同じフィールドのまだ送っていない `set` は、最後の値の 1 件にまとめる。ただしその後ろに同じ Issue の `comment` / `create` があればまとめない（回答の後のラベル解除が回答の前に動かない）。コメントと作成はまとめない
- 画面と API が見せるのは「GitHub が最後に答えた値（`remote`）にまだ送っていない `set` を重ねた値（`local`）」。取込みのたびに重ね直すので、触っていないフィールドは GitHub に追従する
- 拒否（何も残さない）: 知らないキー 400、保存していない Issue 404、一度も取り込んでいない workspace 409（回答は 424。[backlog.md](backlog.md)）、最後の取込みで読めなかった（404 / 403）Issue 409、作成を送っている間の Project の変更 409、認証に使える値（`findSecrets`。題・本文・回答・コメント・ラベル名・Milestone・Project の値）422

## 送り方

`BacklogSync.send`（[`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)）が [`backlog-send.ts`](../../packages/core/src/backlog-send.ts) の `sendGithubOperations` を回す。

GitHub 連携の無い workspace（#2265、保存元の `service` が `switchboard`。[backlog.md](backlog.md) の「GitHub 連携の無い workspace」）は送り先が無いので、`send` が同じ呼び出しの中で送信待ちの操作をその場で記録に確定する（[`backlog-local.ts`](../../packages/core/src/backlog-local.ts) の `applyLocalOperations`。1 トランザクション）。編集の関数は分けない（同じ操作を作り、送り先だけが違う）。作成はその workspace の次の番号と記録の id `sb:<id>`、Project 項目と親の `subIssues` も書く。`set` は記録に重ね、親の変更は旧親・新親の `subIssues` も直す（確定の時点で親が無ければその編集だけを理由つきで落とす。API が先に 422 で断る）。コメントの id は `sb:<操作の seq を 12 桁に 0 埋め>`（並列ガードの先着の順）。競合・保留・再送は無い。sb-rescue の候補の DB の写しでも外へは何も送らないので確定する

- **いつ**: 編集・作成・回答・コメントの直後、デーモンの起動時、GitHub に届いた取込みの後（再読込・起動時の取込み・定期実行）、待っている操作とリポジトリの待ちの時刻（タイマー。デーモンを起こし続けない）。同じリポジトリの送信は同時に 1 本
- **順番**: 古い順。1 つの Issue の操作は前のものが終わるまで送らない（作成 → その Issue への編集、回答 → ラベル解除）。止まった Issue があっても他の Issue は進む
- **照合（方式 A、要望 #887 の回答）**: `set` は送る直前に GitHub の今の値を読む。もう目的の値なら done、編集の元（`base`）から変わっていれば `conflict` で保留し何も書かない。書くのはそのフィールドだけ。書いた直後にもう一度読み（Project への出し入れ `member` を除く）、送った値でなければ `conflict`（読んでから書くまでに誰かが書いた。その値は上書きされたかもしれない）。送った後は取込みを頼み（送る直前の照合で新しく `conflict` になり何も書かなかった実行でも頼む: `BacklogSync.sendNow`。保留の `held` に GitHub の値を出すため）、GitHub の値で `remote` / `base` を置き換えて未送信の分を重ね直す（基準 = `base`、手元 = `local`、取得済みの外部 = `remote`、送信の記録 = `backlog_operations`）。**読んでから書くまでの間の GitHub 側の編集**は、書いた直後の読みが同じ 1 回の GraphQL で編集履歴（`timelineItems(since: 照合の読みの時刻)`、本文なら `userContentEdits`、`viewer`）も読んで見つける（#1329、方式 1′。[backlog-strict-sync.md](backlog-strict-sync.md)）。ほかのログインの編集があれば `conflict` にし、その値・編集者・時刻を操作の `overwritten` に添える（GitHub は既に手元の値。本文の相手の値は版の全文）。履歴を読めない・読み切れない（403・ページ欠け）ときも `overwritten.unreadable` 付きの `conflict`（pending にすると送り直しの照合が自分の値を読んで done にし、相手の値を黙って失うため）。直後の読みが制限（429 など）に当たったときは、その結果を保存してから `Limit` を投げ、ほかの送信はホストの待ちに従う。GitHub が 409 / 412 で書き込みを拒んだときも照合し直して `conflict`（`failed` にしない）。**残る窓**: Status 以外の Project フィールド（履歴が無い）、本文・コメントで 100 版を超えて押し出された版、同じログインで GitHub の画面から書いた編集（相手と区別しない）
- **二重投稿を避ける**: 作成とコメントの本文の末尾に `<!-- switchboard-op:<操作の id> -->` を付ける（GitHub の画面には出ない。認証には使わない。Switchboard の表示と比較では外す）。投稿を出した後に答えが失われた（5xx・タイムアウト・応答が読めない）、送信中にデーモンが止まった（起動時の `recoverBacklogOperations` が `sending` → `unknown`）ものは `unknown` にし、送り直す前に作成以降の Issue / コメントを読んで印を探す（100 件ずつ最大 10 ページ）。見つかれば done（GitHub の id を記録に付ける）。見つからない・読みきれないなら `unknown` のまま保留し、自動では送り直さない
- **失敗の区別**（ops-kit の `retryAtFromResponse`）:

| 失敗 | 扱い |
|---|---|
| 制限（429、二次制限、`x-ratelimit-remaining: 0`） | その実行を止め、GitHub の時刻をリポジトリの `retryAt` とホストの待ち（`GithubRetryState`。同じホストのほかのリポジトリの取込み・送信も待つ）に残す。試行に数えない |
| 接続できない（応答なし） | 何も出ていないので同じく止めて 1 分待つ。投稿も `unknown` にしない |
| ログインの拒否（401） | その実行を止める。操作はそのまま待ち（試行に数えない。理由は操作とバックログの errors に）、次の送信（編集・取込み）で確かめ直す（トークンを直せば進む） |
| 1 つの対象への権限の拒否（403。ロックされた Issue、書けない Project） | その操作を `failed`（その Issue の後ろの操作も保留。ほかの Issue は進む） |
| Project への追加が「Content already exists in this project」（Project の自動追加が先に入れた・答えを失った追加） | 失敗にしない。Issue の `projectItems` からその Project の項目を取り、フィールドの設定へ進む（この理由で `failed` になっていた操作は DB を開くときに `pending` へ戻す。作成は作った Issue があるものだけ） |
| そのほかの 4xx、想定外の答え | `failed`。自動では送り直さない。その Issue の後ろの操作も保留 |
| 障害（5xx、GraphQL の「Something went wrong while executing your query」など）、`set` と投稿の前 | 1 分から倍々で待ち、5 回で `failed`（「Something went wrong」で直ちに `failed` になっていた操作は DB を開くときに `pending` へ戻す。作成は作った Issue があるものだけ） |
| 障害、投稿の後 | `unknown`（上の照合） |

- **作成の続き**: Issue を作った時点で GitHub の id（`remoteId`）を残して記録をその id に付け替え（続きが失敗しても Issue と記録が離れない）、閉じる・親を付ける・Project に入れてフィールドを付けるは同じ操作の続きとして送る（何度送っても同じ結果になる操作だけ。途中で失敗しても作り直さない）


## 無効の間と有効化

workspace の GitHub 同期を無効にした間と、有効にする段（API と画面は [backlog.md](backlog.md) の「GitHub 同期の有効・無効」）。

- **無効の間に確定する操作**（`applyLocalOperations` の `appliesHere`）: 作成（番号は保存データの Issue と PR の最大 + 1）・コメント（記録は `sb:<seq>`）・Switchboard で作った Issue（`sb:` / `local:`）への `set`。GitHub の Issue への `set` と、送っている途中・答えを失った操作（`sending` / `unknown` など）は送信待ちに残り、画面と API はそれを重ねた値を見せる。有効化の作成は無効の間も確定しない（GitHub に作るもの）
- **止まる送信**: 無効にする前に列に並んでいた送信は走る時点の保存元で止まる。走っている送信は次の操作の前（`sendGithubOperations` の `on`）と、操作の途中の書き込みの前（`-X POST/PATCH/DELETE` と mutation。`Limit` の `off`）で止まり、残りは送信待ちのまま。GitHub に出してしまった 1 件の要求は止められない（その結果は保存する）
- **有効化の段**（`enableGithubSync` → 送信の後の `advanceEnabling`。[`backlog-enable.ts`](../../packages/core/src/backlog-enable.ts)）:
  1. GitHub 連携の無い workspace は GitHub から GitHub のキーに取り込み、1 トランザクションで記録と送信待ちを GitHub のキーへ移し（`moveBacklogRecords`。`sb:` の id は GitHub の id と重ならない）、保存元を GitHub のものに `enabling` を付けて書く。無効にしていた workspace は、同じリポジトリの workspace ごと `disabled` を外して `enabling` を付ける（途中で止めていたら前の `since` のまま）
  2. Switchboard で作った Issue（`sb:` の記録）ごとに、番号の順に `create` を積む。本文は空、親は無し（`#N` がまだ Switchboard の番号なので、先に送ると GitHub の別の Issue を指す）で、元の番号・本文・親は payload の `former` に残す。今の送信が送り、作った時点で記録は GitHub の id に付け替わる（`setBacklogOperationResult`）。この段の間、作成以外の操作は送らない（`enablingWaits`）
  3. 作成が全部 done になったら、1 トランザクションで番号の対応を保存元の `numbers` に足し、始める前に作った工程 Task とここで作ったコメント（操作が指す Issue で決める）を新しい番号に付け替え、Switchboard の Project 項目の記録を消し（GitHub が項目を持つ）、作った Issue の本文・親と、ここで作ったコメント（作った順）を `#N` を書き換えて積む。無効の間に送信待ちに残った本文とコメントの `#N` も書き換える（`enabling.queued`）
  4. それらが全部送れたら（`sb:` のコメントが残らず、作った Issue の本文・親の `set` が送信待ちに無い）`enabling` を外し、取り込み直す
- **続きから**: 各段は保存データ（保存元の `enabling` と、`sb:` の記録と、操作の状態）から決まるので、途中で失敗しても何も消えず、もう一度押せば続きから進む。押すと時刻待ち（502 などの後）の操作はすぐ送り、GitHub が断った（`failed`）有効化の作成はもう一度送る。二度押しで GitHub を読んでいる間に先に移ったら、その有効化で続ける
- **二度作らない**: 答えを失った作成（`unknown`）は、送り直す前に印（`switchboard-op`）で GitHub を探し、見つかれば done（今の送信の照合のまま）。見つからなければ二度は作らない（画面に保留として出る）
- **取込み**: 有効化の途中、GitHub にまだ無い `sb:` の Issue は、一覧に出ない Open の Issue や前提・待ちの番号として GitHub に番号で問い合わせない（ローカルの番号を GitHub の別の Issue と取り違え、読めない印を付けないため）

## GitHub だけを見る人から

送った結果はふつうの Issue・コメント・ラベル・Project の値として GitHub に残る（gh や画面で書いたものと区別がつかない。末尾の印は HTML コメントで表示されない）。

## 保留が残ったとき

`conflict` / `failed` / `unknown` の操作は、その Issue の後ろの操作と一緒に残る（`GET /api/backlog/:number` の `pending` が 0 にならず、`held` に理由と出る）。`conflict` は下の「取込みと競合」の選択で片づく。`failed` / `unknown` の扱いと画面は #888 で決める。

## いつ取り込むか（#887）

[`BacklogSync`](../../packages/core/src/backlog-sync.ts) が取込みのたびに次の時刻を決める（デーモンの起動時の `startPolling` から。sb-rescue の候補は取り込まない）:

- 前の取込みが何か変わったものを読んだ → 60 秒後。変わらなかった・失敗した → 前の間隔の 2 倍（最大 15 分）。送った後の取込みは自分の書き込みを読むので 60 秒に戻る
- GitHub の制限・障害の待ち（ホストの `GithubRetryState`、リポジトリの `retryAt`）の間は聞かず、その時刻に読む
- 画面の再読込・編集の後・backlog-next の取込みも同じ 1 本を共有し、次の時刻を決め直す。通知（下の「Webhook」）は取込みを早めるだけで、値は取込みが GitHub から読む

1 回の取込みは「cursor 以降に更新された Issue」「開いた Issue の Project 項目」「保存した開いた Issue のうち両方に出なかったもの」の 3 種類の読み（[backlog.md](backlog.md) の「保存（#885）」）。全ページ読めたときだけ保存して cursor を進めるので、途中で失敗したページは次の取込みで読み直す。同じ答えを何度読んでも、保存した値から変わらなければ何も変わらない（送信待ちも増えない）。通知の重複・順序の入れ替わりは、取込みが今の値を読むので結果に影響しない。

GraphQL の予算（ユーザーごと、ほかのセッションと共有）: 開いた Issue の Project 項目の読みが 100 件ごとに数十点。変わらない間は 15 分ごとに落ち着く。間隔は workspace ごと（同じリポジトリの checkout が 2 つなら 2 本）。一度も取り込めていない workspace（GitHub の checkout でない meta、初回が一時的に失敗したもの）は 15 分ごとにだけ試し、checkout が消えた workspace は読み直さない。

## Webhook（#887）

`POST /api/backlog/webhooks/github`（[`server.ts`](../../packages/core/src/server.ts)）は GitHub の Webhook を受ける。**通知は取込みのきっかけでしかない**:

- 利用者が開けたとき（デーモンの環境に `SWITCHBOARD_GITHUB_WEBHOOK=1` と `SWITCHBOARD_GITHUB_WEBHOOK_SECRET`）だけ token を求めない（GitHub は Switchboard の token を持てない）。`=1` だけで secret が無いと開けず、起動ログに理由が 1 行出る（#1493）。開けていなければほかの API と同じく token（cloud ホストではログイン）が要る。token の検査を外すのはこの 1 本だけで、ほかの API の認証・Origin の検査はそのまま。cloud ホストの配信元ヘッダの検査（`SWITCHBOARD_EDGE_HEADER_VALUE`）も外さない。Origin が付いていれば同じ origin だけ
- body は 64 KiB まで（超えたら読まずに 413）。読むのは JSON の `repository.full_name`（Issue・コメント・sub-issue の通知）か、それが無ければ `organization.login`（Organization の Webhook の Project 項目の通知）だけ。値・URL・cursor・送り先は何も使わず保存もしない。保存するのは、取込みが既存の gh のログインで GitHub から読んだ値だけ（`BacklogSync.hint` → `sync`）。配信は `X-Hub-Signature-256`（body の HMAC-SHA256 を secret で。`timingSafeEqual` で比べる）を検査し、無署名・不一致は 401 で何も起こさない（body を読んだ後・JSON を読む前）。secret は環境の値で、保存しない。署名が合っても通知にできるのは取込みを早めることだけ
- 答えはいつも同じ `202 { accepted: true }`（どのリポジトリが登録されているかを答えない）
- まとめ方: 同じ workspace の通知が取込みを始めるのは窓に 1 回、全体で 60 秒に 10 回まで（`HINT_BUDGET`）。窓は 60 秒（`HINT_WINDOW_MS`）から始め、通知を読んだ取込みが何も新しいものを読まない（または失敗する）と 2 倍（最大 15 分）、変化を読めば 60 秒に戻す。だから中身の無い通知（偽物、繰り返し、Issue を変えない通知 — 例えば `issue_comment` は pull request のコメントでも届く）を毎分送られても、通知で GitHub を読むのは workspace ごとに 1 時間に数回で、GraphQL の予算を使い切らせられない。こだま（デーモン自身の書き込みから 1 分以内に届いた通知。どの checkout からの書き込みでも、そのリポジトリの全部の workspace について）は、何も新しくなくても窓を伸ばさない。窓を超えた通知・取込み中の通知・待ちの間の通知はまとめ、定期取込みの次の時刻を窓の長さ以内に早める（`HINT_BUDGET` は数えないが、workspace ごとに窓に 1 回を超えない。Organization の通知が同じ owner の workspace を N 個名指しすれば、窓ごとに N 回読む）。待ちの間は何も聞かず予算も使わず、待ちの終わりに読む。定期取込みをしないデーモン（sb-rescue の候補）は通知を受けても何もしない
- Webhook が届かない環境（公開の経路が無い、Projects の通知を受けられない権限）では、定期取込みだけで同じ最終状態になる（通知は早めるだけ）

設定の手順（Switchboard は自動では開設しない。公開の経路と GitHub 側の設定は利用者が行う）:

1. デーモンの `/api/backlog/webhooks/github` に GitHub から届く経路を用意し、デーモンの環境に `SWITCHBOARD_GITHUB_WEBHOOK=1` と `SWITCHBOARD_GITHUB_WEBHOOK_SECRET=<GitHub の Webhook の Secret と同じ値>`（推測されにくい長い乱数）を置いて再起動する。cloud ホストでは配信元（CloudFront）の既定の振り分けがこのパスもデーモンへ届けるが、署名が合わない配信は 401。開けるかどうかは利用者が決める
2. リポジトリの Settings → Webhooks: Payload URL に 1 の URL、Content type は `application/json`、Secret に 1 と同じ値（空にしない。空だと GitHub が署名を付けず、全部 401 になる）。イベントは Issues・Issue comments・Sub issues
3. Project の通知も受けるなら、Organization の Settings → Webhooks で同じ URL に Projects v2 items を選ぶ（Organization の管理者の権限が要る。リポジトリの Webhook には Project の通知が無い）。**個人のアカウントの Project には Project 項目の Webhook が無い**ので、そのフィールドの変更は定期取込みだけで読む

## 何がどう読めて書けるか（#887）

| 対象 | 読む（取込み） | 書く（送信） | 取込みが気づく条件 | Webhook のイベント | 必要な権限 |
|---|---|---|---|---|---|
| 題・本文・開閉・ラベル・Milestone | GraphQL `issues` / `issue` | REST `PATCH /issues/:n`、ラベルは `POST`/`DELETE …/labels` | Issue の `updatedAt` が動く | `issues` | Issues の読み取り / 書き込み |
| 親（sub-issue） | GraphQL `parent` | GraphQL `addSubIssue` / `removeSubIssue` | Issue の `updatedAt` が動いたとき（親の付け替えで動くかは確かめていない。動かなければ次にその Issue が更新されたときに読む） | `sub_issues` | Issues |
| コメント | GraphQL `comments`（100 件ずつ全ページ） | REST `POST …/comments`（末尾に印） | Issue の `updatedAt` が動く（コメントの編集・削除だけでは動かないことがあり、その Issue の次の更新で読む） | `issue_comment` | Issues |
| Project への出し入れ・フィールド | GraphQL `projectItems`（開いた Issue は毎回） | GraphQL `addProjectV2ItemById` / `deleteProjectV2Item` / `updateProjectV2ItemFieldValue` / `clearProjectV2ItemFieldValue` | 毎回（Project の変更は Issue の `updatedAt` を動かさない）。閉じた Issue の Project 項目は読み直さない | `projects_v2_item`（Organization の Webhook か GitHub App だけ。リポジトリの Webhook には無い） | Projects の読み取り / 書き込み（classic トークンなら `read:project` / `project`） |

- 読めない（404 / 403）ものは `unavailable` / `forbidden` と記録し、前の値を消さない。その記録の編集は 409、送信は `failed`（権限）として残し、成功とは数えない
- **条件付き更新は無い**: GitHub の REST は書き込み（POST / PATCH / DELETE）の条件付きリクエストを受けない（[公式](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)）。GraphQL の `UpdateIssueInput` / `UpdateProjectV2ItemFieldValueInput` にも期待する版を渡す入力が無い（2026-10-03 に schema で確認）。だから方式 A は「書く直前に読む → 書く → 直後に読む」で、**読んでから書くまでの間に GitHub で書かれた値は上書きしうる**。直後の読みで別の値なら `conflict` にする。その間に一瞬だけあった値（v1 → 誰かの v2 → 自分の v3 の v2）は、#1329 からは同じ直後の読みが編集履歴から拾って `conflict` に添える（本文・題・状態・ラベル・Milestone・親・Project の Status。「送り方」の照合）。Status 以外の Project フィールドと、押し出された版は拾えない。Switchboard はこれを「防いだ」とは表示しない（`limits`）

## 取込みと競合（#887）

比較は送信の照合と同じ関数（[`backlog-merge.ts`](../../packages/core/src/backlog-merge.ts)）。フィールドごとに 基準（操作の `base`）・手元（操作の値）・外部（取り込んだ `remote`）を比べる:

| 基準 → 手元 / 外部 | 結果 |
|---|---|
| どちらも変えていない、または両側が同じ値にした | 同期済み（操作は done） |
| 手元だけが変えた | 送る（送る直前にもう一度照合） |
| 外部だけが変えた | 外部の値を取る（触っていないフィールドは取込みのたびに外部に追従する） |
| 両側が別の値にした | `conflict`。3 つとも残し、GitHub には何も書かない。本文も自動ではマージしない |

- 取込み（`Db.putBacklogSnapshot`）は、送信待ちの `set` のうちフィールドごとに最初の 1 件だけを判定する（2 件目はその前の 1 件が送る値の上で作られている）。最後まで読めなかった記録（404 / 403）は判定しない（読めていない値は空の値ではない）。`conflict` のうち、GitHub がその値になったものは done
- 競合の選択（`Db.resolveBacklogConflict`）: 手元 = 今の GitHub の値を新しい基準にして送り直す（送る直前の照合はそのまま）、外部 = 手元の編集を捨てる。選択には見た時点の revision（操作と GitHub の値から計算。読めていない値と null は別）を付け、その後どちらかが動いていれば 409 で何も変えない。GitHub の値を読めていない（404 / 403）ときは手元を選べない（409）
- API: `GET /api/backlog/:number` の `held` に保留中の編集（`conflict` / `failed` / `unknown`、理由、時刻）。`conflict` には `base`・`local`・`remote`（`remoteRead`）・`revision`。`limits` に方式 A が守れること・守れないこと（#1329 への参照）を毎回付け、「上書きを防いだ」とは言わない。選択は `PATCH /api/backlog/:number { workspaceId, resolve: { field, choice: "local" | "remote", expectedRevision } }`（202 と操作の id。通常の編集と一緒は 400、その field に競合が無い・revision が古いは 409）。選んだ後は送信を頼む
- 競合のまま GitHub が基準の値に戻っても、選ばれるまで競合のまま（理由は今の値で書き直す）。GitHub が手元の値になったら done
- **書いた後に見つけた競合**（`overwritten` のある `conflict`、#1329）は GitHub が手元の値のままなので、取込みでは閉じない（理由も書き換えない）。`held[].conflict` の `remote` は履歴の値（版の内容が消えていれば null で `remoteRead` false）、`revision` は GitHub の今の値と `overwritten` から計算する。選択: 手元 = 今の GitHub の値を base にした pending（照合で同じ値なら done）、外部 = 相手の値を今の GitHub の値の上の新しい `set` として送る（値が無ければ 409）

## 同期状態（#908）

一覧の各項目（`BacklogItem.sync`）と個別（`GET /api/backlog/:number` の `sync`）、workspace ごと（`GET /api/backlog` の `syncs[].sync`）が同じ形 `BacklogSyncInfo` で、保存した値だけから組み立てる（GitHub を呼ばない。新しい status の API は無い）。

| `state` | 意味 | `reason` |
|---|---|---|
| `synced` | 送る物が無く、最後の取込みが完全 | — |
| `pending` | 保存した編集がまだ送られていない | `unknown`（送った答えが消えた。送り直す前に探す） / `import`（GitHub に届かない・制限の待ち。`retryAt` に再び試す時刻） / なし |
| `conflict` | 競合で保留中。`conflicts` に `field`・`base`・`local`・`remote`・`revision` | — |
| `error` | 送れない・確かめられない | `failed`（GitHub が拒んだ編集） / `unavailable`・`forbidden`（404・403） / `unfetched`（未取得） / `import`（待つ編集が無いまま、取込みが失敗または制限の待ち） |

- `lastSuccessfulSync` = 最後に完全な取込みが済んだ時刻（ms）。差分の取込みは変わった物だけ返すので、返らなかった Issue もその取込みが現在だと保証する。404 / 403 / 未取得の Issue だけは、その Issue を最後に読んだ時刻。失敗した取込みでは動かない。`retryAt` = GitHub に聞かない時刻（過ぎていれば null）。リポジトリに待ちが無ければ、送信待ちの編集のうち一番早い再送の時刻
- `guarantee` は今は `"A"` のみ（上の「照合（方式 A）」）
- 番号の付く前の新規 Issue は `syncs[].creates`（`localId`・題・`state`）に出し、一覧の項目にしない（番号の無いものから工程を始めない）
- 送れていない操作（競合・失敗・結果不明・送信待ち）を持つ番号つきの Issue は `syncs[].issues`（番号・題・URL・`closed`・`state`・件数）に Open / Closed を問わず出す（#1872）。一覧の項目にはしない。題は表示の値（送っていない編集を含む）
- 取込みが一度も無い workspace は `unfetched`。workspace の状態は項目と同じ順（競合 → 拒否された編集 → 読めない Issue → 送信待ち）で決まり、読めない Issue は Issue の最悪値: 404 / 403 / 未取得の Issue が 1 つあれば、競合・拒否が無い限り `error`（その理由）。別の workspace の失敗はその workspace の項目だけを `error` にする
- 404 / 403 の Issue は一覧に出さない（既存）。個別の `sync` が `unavailable` / `forbidden` を返す

## 開始の判定（#2264）

正本は保存データ（DB）、GitHub は同期先。`canStartStoredBacklog`（[`backlog.ts`](../../packages/core/src/backlog.ts)）が、API の境界で工程の開始を決める。

- 断るのは、保存データに解消されていない競合（#887）があるときだけ。理由（日本語の 1 文）を返す。送信待ち・拒否された編集（`failed`）・結果不明（`unknown`）・古い照合・GitHub が返さない Issue（404 / 403）は GitHub 側の同期の状態で、表示だけにして開始は止めない
- backlog-next と手動の工程 start は、判定の前に `BacklogSync.settle`（溜まった編集を送り、取り込む）を試す。GitHub に届けば最新を取り込んだ保存データで、届かない・制限中なら今の保存データで判定する（手動の start は 424 にしない。backlog-next は workspace を飛ばさず、`skipped` に「<ws>: GitHub と照合できない（保存データで進める）: <理由>」を 1 行）。競合があれば手動の start は 409（理由つき）、backlog-next はその項目を候補から外して `skipped` に「競合があるので自動では始めない」と書き（他の項目は進む）、各開始の直前にもう一度 settle を試して、その時の項目で選び直す（行うことが変わっていれば始めない）
- 二重起動の防止は保存データの `startingStage`（作成中）と実行中の工程 Task（`activeTaskId`）。#909 の「古い写しで同じ工程を二重に始める」はこれで防ぐ（PBI #2264 の決定ログ）
- 番号の付く前の新規 Issue（`syncs[].creates`）からは始めない。一度も取り込んでいない workspace の手動の start は今どおり 424（#2265 の範囲）
- 一般の Task 作成（利用者が手で始める）は止めない。回答の直後の再開（`/api/asks` の answer）は、回答そのものが送信待ちなのでここでは止めない（PBI #888 の決定ログ 2026-10-14）
- PR のマージ判定（`scripts/merge-gate.ts`）は保存した値を読まず、毎回 `gh` で head・レビュー・CI・保護を取る（`scripts/merge-gate.test.ts` が DB・保存バックログを import しないことを確かめる）

## 画面（#910、#911）

Backlog 画面（[`Backlog.tsx`](../../apps/web/src/components/Backlog.tsx)、判定は [`backlogSync.ts`](../../apps/web/src/backlogSync.ts)）。独立した画面は無く、既存の行に足す。

- **同期の表示**: 各行の下に `BacklogSyncInfo` を 1 行（同期済み / 送信待ち / 競合 / 同期失敗、最終成功の時刻、未送信の件数、待機の時刻、理由。Aの保証の説明は hover）。画面の上部に workspace ごとの同じ行と、番号の付く前の新規 Issue（`番号なし（作成は送信待ち）`）。送れていない操作を持つ Issue（Closed も）を `#番号 題（競合 n 件 · 未送信 m 件 · Closed）` で並べ、押すとその Issue の編集フォームがその場に開き、競合をそこで選べる（`syncs[].issues`、#1872）。解消すると次の読み直しで並びから消える
- **編集**: 行の「編集」を開くとその Issue だけ読む。題・本文・ラベル・状態・Milestone・親・Project フィールドは**変えた分だけ**を `PATCH`。コメントは `POST …/comment`、判断待ちの回答は既存の回答欄。保存は「手元に保存した」ことと「GitHub への反映は送信待ち」を別に伝える。新しい Issue は画面上部の「新しい Issue」から（localId で追う）
- **入力を失わない**: 保存が失敗（通信停止・拒否）しても入力は残る。保存していない入力は `localStorage` に下書きとして残り（編集フォームは `switchboard.backlog.draft.<workspaceId>:<number>`、コメントは `switchboard.backlog.text.<workspaceId>:<number>:comment`、新しい Issue は `switchboard.backlog.text.new:<workspaceId>`）、再読込の後に編集を開くと戻る。保存に成功したら消す
- **競合**: 保留中の `set` ごとに手元（local）と GitHub（remote）を並べ、「手元の値を送る」/「GitHub の値を使う」を明示して選ぶ（`resolve` + `expectedRevision`）。選んだ後に GitHub か編集が動いていれば 409 で、最新を読み直して選び直しを求める
- **制約**: GitHub から読めていない Issue（404 / 403）は一覧に出ず、個別に開いても編集できない。Project に入っていない Issue に Project のフィールドは無い。デーモンが止まっている間は保存できない（下書きだけが残る）
- **復旧**: 同期失敗（`import`）は GitHub に届けば次の取込みで戻る（`retryAt` まで待つ）。拒否された編集（`failed`）と送信の結果が分からない編集（`unknown`）は `held` に残る — 内容を直して保存し直すか、GitHub で確かめる。競合は上のとおり選ぶ

画面と同じ経路は `scripts/backlog-sync-e2e.ts --browser`（偽 GitHub・偽ランナー・一時 DB・headless Chrome）で確かめる: 外部停止中の編集・コメント・回答・新規作成、再読込後の保持、競合の両側と古い選択の 409、古い写しは手動の開始が先に取り込んで無くなった Issue を 404 にし、古い判断待ち（GitHub に届けば先に取り込む）と競合の間 backlog-next が Task 0 件、送信待ち・同期失敗（拒否された編集）でも手動の開始が Task を作り（#2264）、揃えば 1 件、新しい Issue の下書きのワークスペースごとの切り替え（2 つ目のワークスペースを置く）と保存中のロック、編集の保存失敗（409・通信失敗）後の読み直しと差分の再試行、画面上部のワークスペースに追従する作成先、編集の最初の読みの失敗からの読み直し、保存中の入力の停止、390px の新しい Issue のフォーム（ブラウザの要求は CDP の Fetch で止め、デーモンに試験用の口は足さない）。結果 JSON とスクリーンショットは実行の最後に出る一時ディレクトリに残る。

## エージェントの共通コマンド（#918）

エージェントは画面と同じ API を `ops-kit backlog …`（[`backlog-client.ts`](../../ops-kit/src/backlog-client.ts)、使い方は `--help`）で使う。照会のたびに GitHub へは行かない。ランナーごとの実装は無い。

| コマンド | API |
|---|---|
| `list [--fresh] [--json]` | `GET /api/backlog`（その repository の workspace の行と同期の 1 行） |
| `view <issue> [--fresh] [--json]` | `GET /api/backlog/:number` |
| `create` / `edit` / `comment` / `set` / `triage` | `POST /api/backlog` / `PATCH /api/backlog/:number` / `POST …/comment`（`set` は `fields`、`triage` は `project: true` + Area・Kind・Priority・（Phase）・Status + 親） |
| `--fresh` | 先に `POST /api/backlog/sync { workspaceId }`（`BacklogSync.settle`: 送信 → 取込み。取り込めなければ 424） |

- 経路: デーモンが Task に `BACKLOG_URL`（`<デーモン>/api/backlog`）と `BACKLOG_TOKEN_FILE`（`device-auth` と同じ鍵のファイル）を渡す。GitHub 連携の無い workspace の Task には `BACKLOG_WORKSPACE`（workspace id。#2265）も。workspace は `--workspace <id>`、無ければ `GH_REPO`、無ければ `BACKLOG_WORKSPACE`、無ければ origin の repository を `syncs[].repository` と突き合わせる。作成の応答に番号があれば（GitHub 連携の無い workspace）「#N を作りました」と出す
- DB を別のプロセスから読み書きしない。デーモンに届かない・まだ取り込んでいない・5xx・401・読みの 409 は exit 2（判定できない）。`--fresh` の取込みが GitHub に届かない（424）ときは保存値で答え、最終同期の時刻と「GitHub 未同期」を stderr に出して exit 0（正本は保存データ。#2264）。編集で断られた（400 / 404 / 409 / 422）は exit 1
- 文に認証に使える値があれば、キットがデーモンへ送る前に止める（`findSecrets` + ホストの AWS の名前）。デーモンも `findSecrets` で 422 を返す（キットを通らない呼び出し。ホストの AWS の名前はデーモンでは見ない）
- 読むのは保存値と、その時刻と同期の状態（`最終取得 … 同期 …`）。着手・マージの判断と最新の回答を読むときは `--fresh`。PR・レビュー・マージ判定はサービス標準の CLI のまま（`merge-gate` は保存値を読まない、上の「開始の判定（#2264）」）

### lint・並列ガード・工程の指示（#919）

- `GET /api/backlog/records?workspaceId=`（`readStoredRecords`）: その workspace の保存した Issue 全部（開いた・閉じた、まだ送っていない編集を重ねた値）と、workspace の Project のフィールド、PR（状態・Draft・ラベル・`closes`・変更ファイル）、checkout の最上位の名前（Task の本文のパスを読む語彙）、最後の取込みで読めなかった Issue の番号（`unread`。その Issue も最後に読めた値で `issues` に入れる。存在しない Issue と区別するため）。一度も取り込んでいなければ 409。キットの読み口は `readRecords`（[`backlog-client.ts`](../../ops-kit/src/backlog-client.ts)、`fresh` なら先に `POST /sync`）
- `ops-kit lint`（`lint_backlog.sh`）: `BACKLOG_URL` があればこれを読み（`storedRows`、[`lint.ts`](../../ops-kit/src/lint.ts)）、規則は GitHub の答えと同じ関数で検査する。Project はアプリがその workspace に読むもの。開いた要望・PBI・Task に `unread` があれば exit 2。`--fresh` で先に取込み（GitHub に届かなければ保存値を検査し「GitHub 未同期」を出す。#2264）。`BACKLOG_URL` が無い環境（アプリの Task の外、キットを使うほかのリポジトリ）は今までどおり gh の 1 クエリ。アプリに届かない・未取得は exit 2 で、gh には切り替えない
- `scripts/parallel-guard.ts overlap`: `BACKLOG_URL` があれば、いつも先に取込み（`fresh`）をさせてから、候補（Task と親 PBI の本文・開いた PR・ほかの In progress の Task・前提の状態）を保存値から読む（`storedMaterial`。取込みが GitHub に届かなければ保存値のまま判定し「GitHub 未同期」を stderr に出す。#2264）。判定は GitHub から読んだとき（`ghMaterial`）と同じ `readOthers` / `judge`。アプリに届かない・変更ファイルの無い PR・保存に無い（か最後の取込みで読めなかった）Task と親 PBI は判定できない（exit 2）で、`--claimed` の着手の印は消す（変更ファイルの無い PR は、それが自分の Task の PR か相手として数えるときだけ。関係のない Draft では止めない）。占有（claim / release）と着手の印の先着はコメントの id で決める: GitHub の workspace は GitHub に書いて読む。GitHub 連携の無い workspace（`BACKLOG_URL` があり records の `service` が `switchboard`、#2265）は同じ API でアプリの保存データのコメント（`GET /api/backlog/:n` の `comments[].id` = `sb:<seq>`、`POST …/comment`）に書いて読み、gh を呼ばない（`appBoard`。`--repo` は要らない）。保存データのコメントは消せないので、譲るときは取り下げの印 `<!-- parallel-guard:withdraw <token> -->` を書き、`holder` / `lastClaim` はその token の印を数えない。アプリに届かなければ gh に戻らず exit 2
- 工程の指示（`buildStartPrompt`）は最新の `## 回答` を `ops-kit backlog view <n> --fresh` で読ませる。共通スキル（`ops-kit/skills/` の `issue-workflow` の「操作」、`request-to-backlog`、`pbi-to-tasks`）は、アプリの Task の中では照会・編集を `ops-kit backlog` で、回答・着手・マージの前は `--fresh` で、と書く。任意の `gh` は置き換えない

## 検証

- 単体: `packages/core/src/db.test.ts`（原子性・まとめ方・順番・再起動・バックアップ）、`backlog.test.ts`（API の 202 / 拒否 / 表示）、`backlog-send.test.ts`（偽 GitHub: 照合、印による確定、制限・認証・接続不可）
- 書いた後の履歴（#1329）: `backlog-send.test.ts` の `history (#1329)` 6 件（フィールドごとの相手の編集、消された版、同じログイン、403・ページ欠け・412・429、同じ秒の 2 版、別 Project の Status、題の書き込みでは本文の edits を聞かない、本文の edits のページが照合の読みより前まで届けば読み切れている）と `chosen (#1329)`（外部を選ぶと相手の値が戻る）、`db.test.ts` / `backlog.test.ts` の `overwritten`、`scripts/backlog-race-bench.test.ts`（`github` の `between-check-and-write` が `held`）
- 取込みと競合（#887）: `backlog-merge.test.ts`（3-way の比較表、値の形、revision）、`db.test.ts`（取込みでの判定、フィールドごとに最初の 1 件、読めない記録、選択の revision）、`backlog-sync.test.ts`（定期取込みの間隔、制限、欠けたページの回復、Webhook: 宛先、まとめ方、偽の通知の窓、待ち、受け口の境界、Webhook あり/なしで同じ保存結果）、`backlog-send.test.ts`（取込みが保留した競合は書かない、実行中に選ばれた競合は送らない、方式 A の窓の再生: 照合と書き込みの間の編集は気づけず上書きされる・書いた直後の編集は競合で残る、自分の送信の通知）、`backlog.test.ts`（`held` と `limits`、`resolve` の 202 / 400 / 409、同じ番号の別リポジトリ）
- 共通コマンド（#918）: `ops-kit/src/backlog-client.test.ts`（偽のアプリ: 送る形、`--fresh`、鍵、exit 2 の各場合、秘密を送らない）、`backlog.test.ts` の `ops-kit backlog`（偽 gh を止めた `startServer`: 照会で GitHub 0 回、画面と同じ保存値、`--fresh` の失敗とデーモン停止で exit 2）
- API 経路: `env -u SWITCHBOARD_SUPERVISED bun scripts/backlog-sync-e2e.ts --api` — 偽 GitHub を止めて作成・編集・回答 → バックアップ → デーモンを止めて復元から起動 → 回復で全部が 1 回ずつ届く、応答を失った回答は印で見つかり 1 件、結果不明の作成は送り直さない。結果は pass / fail と件数だけの JSON
