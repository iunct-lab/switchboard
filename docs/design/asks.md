# 判断待ち（PBI #935）

利用者の判断が要る停止を、種類をまたいで 1 画面で見る。ツール承認・Issue の判断待ち・Task 会話の運用確認・受け入れ条件の利用者確認を集め、自動で条件を待っているもの（使用上限・依存）は「操作不要」と分けて出す。回答ボタンと回答後の再開は #936、方針の再利用は #938。

## 正本と組み立て

判断待ちの表（DB）は作らない。正本は今の記録のままで、`GET /api/asks` が読むたびに組み立てる（#266・#523 と同じく正本を写さない）。

| 記録 | 読む場所 |
|---|---|
| Issue のラベル `needs-decision` と `## 判断待ち` / `## 回答`、PBI 本文の利用者確認、`/pbi-complete` の release の待ち | 保存したバックログ（`GET /api/backlog` と同じ読み方。GitHub は呼ばない。`docs/design/backlog.md`） |
| ツール承認 | ライブの `permission.ask`（`tasks.pendingApprovals()`）と、Task の `permission.ask` / `permission.resolved` の events |
| 運用確認 | `outcome` が `needs_action`・未確認（`reviewedAt` が null）・running / idle でない Task の最後の返答（最新の `session.end` の summary） |
| 停止 | `stop.record`（#939 の停止記録。`packages/core/src/stops.ts` の `reduceStops` の series） |
| 使用上限の再開待ち | Task の `resumeAt` |
| 画面イメージ（#2221） | 問いの `**画面イメージ**:` の行の最初の id の Task の `artifacts`（消していない HTML。ファイルかフォルダ）。行が無い・Task が無いなら空の配列。`Ask.mockups` |

型は `packages/protocol/src/model.ts` の `Ask` / `AskList`。組み立ては `packages/core/src/asks.ts`（`asksFromBacklog` / `asksFromTasks` / `dedupeAsks`）。値の無い項目は null で、画面は「不明」と出す。

## 種類と id

`id` は #936 が回答の宛先に使う。

| 種類（`kind`） | 画面の名前 | 出どころ | id |
|---|---|---|---|
| `approval` | ツール承認 | 未回答の `permission.ask`、24 時間以内に人が答えたもの | `approval:<taskId>:<askId>` |
| `decision` | 実装の判断 | stage が `needs-decision` の項目（問いは `## 判断待ち` の `**問い**` / `**選択肢**` / `**推奨**`）。回答済みの実装中 PBI | `decision:<workspaceId>#<問いのある Issue>@<## 判断待ち の at>`（`## 判断待ち` が読めなければ `@` の後ろは空）。回答済みは `decision:<workspaceId>#<PBI>@<answeredAt>` |
| `check` | 運用の確認 | 上の運用確認の Task。問いは最後の返答の `**確認**` / `**選択肢**` / `**推奨**`（形が無ければ「不明」）。自由文から承認は作らない | `check:<taskId>:<最後の session.end の seq>` |
| `confirmation` | 利用者確認 | In progress / In review の PBI の未チェックの `（利用者確認: …）` の行 | `confirm:<workspaceId>#<PBI>:<n>` |
| `stop` | 停止 | 停止記録の series（Issue の無い Task の分は Task 側、工程 Task の分はその Issue の項目から）。使用上限の再開待ち | `stop:<StopSummary.key の \0 を \| にしたもの>`、`resume:<taskId>@<resumeAt>` |
| `wait` | 依存待ち | Ready / 実装中の PBI の release の待ち（開いた PR / Issue） | `wait:<workspaceId>#<PBI>@<waitsAt>` |

問いの形は `.claude/skills/issue-workflow` の「判断待ちの出し方」（`parseAskBlock`）。形に合わない行は読まない。`**画面イメージ**:` の行（成果物を登録した Task の id）も読む。

## 人 / 自動（`needs`）

- **人（person）**: 承認・判断・運用確認・利用者確認。停止は `next` が `decide`（#939: 人の要る理由か、再試行を使い切った）のもの
- **自動（auto）**: 停止の `next` が `wait` / `retry`、回答の無い `resume`。依存待ち。使用上限の再開待ち（`resumeAt` が未来なら `usage-limit`、過去なら中断からの自動再開待ち `transient`）。条件（`conditions`、`key: value`）が満たされると自分で進むので、画面は「操作は要りません。条件が満たされると自動で進みます」と出す
- 解消済みの停止は、理由が人の要るもの（`stops.ts` の `NEEDS_PERSON`）か回答があれば人、それ以外は自動

## 状態（`state`）と 24 時間の窓

| 状態 | 画面 | 意味 |
|---|---|---|
| `open` | 未回答 | まだ答えていない（自動のものは、条件を待っている） |
| `held` | 保留 | 人が `## 保留` を書いた判断待ち（#936）。まだ人の判断待ちで、答えられる。ラベルは付いたまま |
| `answered` | 回答済み | 回答が記録され、作業はまだ先へ進んでいない: 承認は人が答えて Task がまだ終わっていない、判断は `## 回答` が最後の工程 Task より新しい（#562 の `isAnswered`）、停止は回答のある `resume` |
| `resolved` | 解消済み | 作業が先へ進んだ: 承認は答えた後に Task が終わった、判断は回答の後に工程 Task が動いた、停止は `resolved` |

回答済み・解消済みは、状態が変わってから 24 時間（`ASK_HISTORY_MS`、定数）だけ出す。未回答と保留はいつまでも出す。

記録がその状態を持たないものは出せない:

- ラベルが外れた判断待ちは、実装中の PBI（`answeredAt` がある）以外では一覧から消える（要望・分解待ち・Ready の項目は回答の記録をバックログが持たない）
- 依存待ちに解消済みは無い。待ちの相手が全部閉じても再開前は自動 / 未回答（条件はすべて met）のまま。実装が始まるとサーバーが `waits` を空にするので、先へ進んだ待ちは記録に残らない
- 運用確認は Task の会話の中にしか答えが無いので、Task が確認済みになる（`reviewedAt`）まで未回答

## 同じ問いを 1 件にする（`dedupeAsks`）

1. 同じ `id` は 1 件（状態が新しく変わった方）
2. 同じ Task の未回答の問いのうち、人が答えるもの（承認・運用確認・人の要る理由の停止）は 1 件。承認は 1 件ずつ答えるので承認どうしは畳まず、運用確認・停止はその Task の一番新しい承認に畳む。承認が無ければ運用確認 > 停止。自動のもの（使用上限の再開待ちと usage-limit の停止）も 1 件（再開待ちを残す）。残した方に条件を写す（`reason` は残した方のもの）
3. 工程 Task（`stage` が #n）の運用確認と `decision` の停止は、その Issue（#n か、問いのある子 Task）の判断待ちに畳む（回答は保存データにあり、GitHub の Issue のコメントと同期する）。判断待ちが未回答・保留なら全部、回答済みなら回答より前に聞いたものだけ（回答の後の運用確認は新しい問い）。同じ Issue の工程 Task が、前の工程 Task が止まった後に始まったら、前の工程 Task の運用確認は出さない（作業が先へ進んだ）。Task 側は 24 時間以内に変わった Task（と、待ち・再開待ち・実行中）だけを読むので、終わって（done / error / aborted）1 日たった工程 Task の運用確認は、回答済みの判断待ちと同じころに一覧から外れる（待ちの Task は日数に関わらず読む）

並びは「あなたの判断待ち → 自動で待っている → 回答済み → 解消済み」、各群は聞いた時刻の新しい順。

## 画面

承認画面（`/approvals`）を置き換える（新しい画面は作らない。URL と PWA の開始画面はそのまま）。名前は「判断待ち」（Home のメモの Inbox と secret-scan の「受信箱にメモ」が既に「受信箱」）。`apps/web/src/components/Approvals.tsx` と `apps/web/src/asks.ts`。

- 群ごとに見出しと件数。カードに種類と状態のバッジ、対象リポジトリ・PBI・Task・停止理由・問い・選択肢・推奨と根拠・回答後・条件・元の記録（Issue へのリンク）。PC は 2 列、スマホ（767px 以下）は 1 列で、長い問いは折り返す
- 回答経路: 答えられる問い（`answers` が空でない）はカードのボタンと自由文で答える（下の「回答と続行」）。判断は「Backlog で答える」、Task のものは「Task を開く」も残す。一覧に載る前のライブの承認は承認だけのカードの 許可 / 拒否
- 開いたときと、ライブの承認（WebSocket）が変わったときに読み直す。一覧に無いライブの承認（読み込み中・失敗）も承認だけのカードで答えられる。Rail のバッジは承認の件数のまま
- Workspace ごと（#1673）: 群の中のカードは Workspace の見出し「<Workspace 名> <件数>」の下にまとまる。見出しは件数の多い順、同数は名前順、Workspace の分からない問いは「Workspace 不明」で最後。見出しの中のカードの順は一覧の順のまま。画面の上の見出しの下に「すべて」と、Workspace ごとの「あなたの判断待ち」の件数のボタン（`workspaceChips`。答えた問いしかない Workspace は 0）が並び、押すと全群とその件数・上の見出しの件数がその Workspace の分になる。絞り込みは画面を開いている間だけ（URL・設定に残さない）。一覧に無いライブの承認（Workspace を持たない）は絞り込みに関わらず出す
- 画面イメージ（#2221）: `mockups` のある問いは、回答のボタンの上に「画面イメージ」と題ごとのボタン（`Mockups`）を出し、押したものを Task の成果物と同じ表示（`ArtifactBody`）でカードの中に開く。もう一度押すと閉じる。Backlog の回答欄（`## 判断待ち` の本文の下）も同じ問いの `mockups` を `/api/asks` から読んで同じボタンを出す（読めなければ出さず、回答はいつもどおり）

## 回答と続行（#936）

判断待ちの画面で答え、答えた作業が続くところまでを 1 回の操作にする。宛先は問いの `id` で、エンドポイントは 1 本（`POST /api/asks/answer`、[`server.ts`](../../packages/core/src/server.ts) の `answerAsk` / `answerTask`）。Backlog 画面の判断待ちの自由文（`/api/backlog/:n/answer`）と Task 画面の承認（`/api/tasks/:id/permission`）はそのまま。一括で答える操作は無い。

**入力と応答**: `{ id, answer }`。`answer.kind` は `choice`（選択肢の 1 つ + 補足）/ `text` / `hold`（保留）/ `allow` / `deny` / `confirm`（利用者確認の ok と、違うときの理由）。問いが受け付ける種類は `Ask.answers`（[`asks.ts`](../../packages/core/src/asks.ts) の `answersOf`）: 承認は allow / deny（AskUserQuestion は質問への答えが要るので無し。Task 画面で答える）、判断は choice（選択肢があれば）/ text / hold、運用確認は choice / text、利用者確認は confirm、人の要る停止は text、自動のものは無し。答えられない問いは 409。200 は `{ ask, already, changes }`（`ask` は答えた後の問い、`already` は前に答えた問いへの再送、`changes` は回答の時点で動いていた PR）。409 は `{ error, changes, current }`（何が変わったか、今の問い）。

**記録の先**:

| 問い | 書く先 | 続き |
|---|---|---|
| 実装の判断（choice / text） | 問いのある Issue に `## 回答`（選択肢の文 + 補足）、ラベル `needs-decision` を外す。保存して後で送る（#886） | 工程 Task |
| 実装の判断（hold） | 同じ Issue に `## 保留`（ラベルは残す） | しない（`held`、まだ人の判断待ち） |
| 利用者確認（confirm） | PBI の本文の行をチェック、`## 回答`（違うときは理由）（#523 と同じ） | PBI が閉じられるようになれば「閉じる」 |
| ツール承認 | Task の待っている承認に allow / deny | Task がそのまま続く |
| 運用確認・Issue の無い Task の停止 | Task への返信（返信が記録で、そのまま続行） | Task の続き |

工程 Task（Issue のある Task）の停止は Issue 側の問いで、ここからは書かない（422）。

**続行**: 書けた後にだけ求める。工程 Task の開始はボタン・定期実行・回答の続行で 1 つの `startStage`（同じ Issue の工程 Task が 2 つ始まらない。下の冪等）で、開始ボタンと同じ扱い（枠や使用量では待たない。使用上限はランナーの再開待ちとして見える）。工程は実装中なら「実装」、ほかはその stage の工程。回答だけでは外れない妨げ（下）があれば始めない。

**続行の状態**（`Ask.resume`。DB に写さず記録から読むたび導く。`resumeOfIssue` / `resumeOfTask`）:

| 状態 | 画面 | Issue の問い | Task の問い |
|---|---|---|---|
| `queued` | 再開待ち: 理由 | 回答の後の工程 Task がまだ無い（妨げがあればその理由、無ければ「次の定期実行で再開」） | 使用上限の解除待ち（`resumeAt`） |
| `running` | 実行中 | 回答の後に作られた工程 Task が running / waiting | Task が running / waiting |
| `failed` | 再開失敗: 理由 | 開始に失敗した（`ask_answers` 表、1 日）、または回答の後の工程 Task が error / aborted | 返信を Task が断った（予算超過など。送っていないので問いは未回答のまま）、または Task が error |
| （null） | 回答済み / 解消済み | 回答の後の工程 Task が done（解消済み） | Task が止まった（idle / done） |

**冪等**: 同じ id の回答はメモリで直列化し（1 本目が書いている間の 2 本目はその結果を待って `already: true`。書いている途中の Promise は再起動でその要求ごと無くなる）、答えた結果と開始の失敗は `ask_answers` 表（id・時刻・結果・失敗）に 1 日残す（#1139。再起動をまたいでも、応答を失った再送は書かずに同じ結果を返し、失敗は `failed` のまま。古い行は回答を受けるときに消す。Task の問いは resume を今の Task の状態で読み直す）。覚えるのは回答だけで、保留は覚えない（保留した問いは同じ id で後から答えられる。保留中の問いへの保留の再送は書かない）。表を失っても、問いはもう開いていないので 409 になるだけで、二重には書かない・始めない（保存データの Issue のラベルと `## 回答`（GitHub と同期）と、工程 Task の DB を読む）。

**対象の変化**: 問いの id が変わっていれば（新しい `## 判断待ち`、Task の新しい返答）409「問いが新しくなりました」と今の問い。もう開いていなければ 409「回答済みです」など。選択肢が今の問いに無ければ 409。止めた場所（`**止めた場所**:`）に PR があれば、回答の時に `gh pr view` を 1 回読み（`prChanges`）、問いより前の最新の `[merge-ask] <kinds> <sha>`（merge-gate の記録の印）の sha と head が違う・印が無く問いの後のコミットがある・PR が閉じた、を変化とする。変化があれば選択肢（PR の承認になりうる）は 409 で何も書かない。自由文は「この回答は問いの時点の PR へのものです。回答の時点で: …」を付けて書く（確かめ直しを頼める）。PR を読めなければ何も書かない（424）。

**妨げ**（`Ask.blockers`。`blockersOf`）: 開いている待ち（PR / Issue。未取得も）、解決していない停止の条件で満たされていないもの（`ci: failure` など。CI はデーモンが評価せず、停止記録の条件とマージ前のマージ判定のやり直しに任せる）、ランナー側の拒否（permission / auth の停止で、同じ Task に未回答のツール承認が無いもの）。Issue の問いは書いて、続行だけしない（resume は queued で理由つき）。Task の運用確認・停止は妨げがあれば答えられない（返信すると Task が続きを始めるので。`answers` が空）。画面はボタンの上に「回答だけでは解除されません: …」を出す。

**画面**: カードの事実の前に、妨げ → ボタン（承認して続行 / 拒否、推奨案で進める（A）・ほかの選択肢、確認した、保留。各ボタンの下に「送る: <文> → <書く先>、続き: <回答後>」）→ 自由文。送信中はカードのボタンを全部止める。答えたらカードを返った問いにし、続行の状態のバッジ（実行中なら「Task を開く」）。そのあと一覧を読み直し、一覧にある問いは一覧の方を出す（一覧から消えた問い、返信で動き出した運用確認などは答えの応答のまま残す）。409 は変わったことを箇条で出し「問いが変わったので、もう一度確かめてから答えてください」と今の問いに差し替える。

## 回答の方針（#938）

一度の回答を、範囲と条件を決めて次回も使う。**過去の「はい」や類似の文面から恒久許可を学習しない**。利用者が回答のときに保存したものだけ。

- **形**（`AnswerPolicy`）: 範囲 `once`（今回のみ。問いの id に縛った 1 回きり。履歴を残すため）/ `pbi`（その PBI が開いている間）/ `repo`（その workspace）。操作 `op`・対象 `target`（`approval.ts` の `globMatch` と同じ glob。保存元の問いに当たること）・条件 `when`（今回の条件がこの値を全部持つときだけ）・回答 `answer`・期限。`pbi` / `repo` は期限必須（既定 30 日、最長 90 日）。無期限は作らない。`*` `**` `cmd:*` など全部に当たる対象と、秘密を含む値（`findSecrets`）は保存しない。
- **置き場所**: `settings` の `answerPolicies`（JSON の配列。利用者 1 人で件数は小さい）。Knowledge 文書にしない — 使った履歴（`uses` の新しい 20 件）を毎回書き換え、期限・失効を持つため。Knowledge の `approval:` ルールは読むだけで変えない。削除は無く、無効化（`revokedAt`）で履歴を残す。
- **照合**は構造化した値だけ: 承認はツールの種類（exec / write）と `subjectsOf` の値、運用確認・判断は仕事の最新の `stop.record`（op / target / conditions）。問いの文面の類似は使わない。外す理由は順に 失効 / 期限切れ / 別のリポジトリ / 別の PBI・PBI が閉じた / 別の問い / 対象が違う / 条件が違う / 回答が今回の選択肢に無い。複数当たれば範囲の狭い順（once > pbi > repo）。
- **当てないもの**: ランナー側の拒否（blockers の runner）、Knowledge の `confirm`（都度確認）、`[merge-ask]` に security を含む PR、秘密。ランナー側の拒否と Knowledge の `confirm` は保存の口も出さない（`Ask.policy.scopes` が空で、理由は `note`）。`[merge-ask]` の security は一覧が PR を読まないので口は出るが、保存のときに PR を読んで 409（何も書かない・送らない）、適用のときも当てない。
- **保存**: `POST /api/asks/answer` の `policy`。回答を書けた後にだけ保存する（失敗なら保存しない）。PR の head と `[merge-ask]` は保存・適用のときだけ 1 回読み（`prFacts`）、`GET /api/asks` では読まない。`GET /api/policies`・`PATCH /api/policies/:id`（編集は保存と同じ検査。`revoked` で無効化・復活）。
- **誰が作れるか**: 方針は回答より長く残るので人のもの。作成（`policy` つきの回答）と編集（`PATCH /api/policies/:id`、無効化・復活を含む）は `/api/settings` の PATCH と同じ直近のパスキー確認（`strong` の `sb_recent`）を求め、Task には作らせない。クラウドのホスト（パスキーのログインが有効）ではクッキーだけを受け、トークンは拒む。パスキーの無い構成（ローカル）では、トークンはこの画面のページから来た要求（`Origin` が自分で、ブラウザが付ける `Sec-Fetch-Site: same-origin`）だけを受ける。**これは要求の見た目の検査で、証明ではない**: 同じユーザーで動く Task はトークンを読めて、この 2 つのヘッダーを偽って送れる。どの構成でも、Task はデーモンと同じ OS のユーザーで動くので、API の外（`settings` の DB を直接書く、`/ws/pty` のシェル）からは変えられる。この検査が守るのは API の口までで、Task の権限そのものは変えない。保存と編集は `policy.save` / `policy.edit` としてログに残り、設定の一覧で見て無効にできる。Task が自分の承認に API で答えること（#936）は 1 回きりで、方針にはならない。
- **適用の時機**: 承認は `ApprovalRules.evaluate` の順番 Knowledge の confirm → 方針 → Knowledge の allow（`ApprovalRuleMatch` の `source` = `policy:<id>`。アダプタは触らない）。運用確認・判断は Task のターン終わり・要対応の印・backlog-next の発火だけ（`applyPolicies`。方針のための定期実行は無い）で、画面の回答と同じ `submitAnswer` を通す。
- **根拠**: 承認の `permission.ask` の `rule.source`、Issue の `## 回答` と Task への返信に `（方針 <id> を適用: <範囲> / <op> <target> / 条件 … / 期限 …）` の 1 行、方針の `uses`。画面は答え済みのカードに「方針で回答」。
- **相違**: 当たる方針が無く、同じ op の方針が外れた問いは `Ask.policy.previous`（前回の回答・外れた理由・`subjectChanges` の相違）を出し、人の判断待ちのまま。PR の head は保存・適用のときだけ読む。方針が別の head で保存されていて当てなかったときは、その相違（「PR の差分が変わりました（a → b）」）を、答えるか問いが消えるまで `previous` に出す（デーモンの再起動までの記憶。次の適用の時機に読み直す）。

画面: 判断待ちのカードの折りたたみ「次回も使う」（範囲・対象・条件・期限を確かめて保存）と、設定の「回答の方針」（一覧・履歴・編集・無効化）。検証は `scripts/asks-e2e.ts`（1280 / 390）。

## 検証

- `env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/asks.test.ts`（組み立て・重複・状態・`GET /api/asks`）と `apps/web/src/asks.test.ts`（群・カードの事実）
- `bun run --cwd apps/web build && bun scripts/asks-e2e.ts`: 偽ランナーと偽 `gh`（`backlog-graphql.json` / `backlog-decisions.json` に、`## 判断待ち` の無い判断待ち #303 と、PR #779 を待つ Ready の #304 を足す）で、1280 × 800 の「あなたの判断待ち」がツール承認 2（1 つは 2 つ目の Workspace）・実装の判断 2・運用の確認 1・利用者確認 2（承認と同じ Task の permission の停止、#306 の工程 Task の運用確認は畳まれる）、#306 のカードに問い・推奨と根拠・リンク、#303 は問い・推奨が「不明」、「自動で待っている」に依存待ち・使用上限待ちと「操作は要りません」、解消済みの停止。許可 → 回答済み、#306 に回答 → 回答済み、「Backlog で答える」「Task を開く」で移れる。2 つ目の Workspace（`second`、GitHub の無いディレクトリ）の Task のツール承認が加わり、Workspace のボタンに 2 つの Workspace と件数、`second` を押すとその承認 1 件だけ（全群、見出しの件数 1）、「すべて」で元の件数に戻る（#1673）。390 × 844 で同じ群、Workspace のボタンもあって横にスクロールしない、ボタンが 44px 以上。`SCREENSHOT_DIR=<dir>` で両方の幅の画面を保存
- 同じ `asks-e2e.ts` の回答と続行（#936）: 承認を「承認して続行」で 2 回同時に押してもランナーへの allow は 1 回で「実行中」、#306 の「推奨案で進める（B）」の下に送る文と Issue、押すと `## 回答` とラベル外しが GitHub に届き `#306 実装` が 1 件で「実行中」、`[merge-ask]` の sha と head が同じ PR のマージ確認は Task に返信して「実行中」・head が動いた PR は変化と再確認の文で送らない、予算超過の返信は「再開失敗」、返信のターンが使用上限で止まると自動で待っている群に使用上限の解除待ち、#303 の「保留」は `## 保留` だけでラベルが残り人の判断待ちに「保留」、停止の条件（`ci: failure`）のある #304 の判断は書いて「再開待ち: ci: failure」で実装は始まらない、ランナー側の拒否だけの Task は回答の欄が無く理由。390 × 844 で承認と #303 に答えて横にスクロールしない
- `env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/asks-answer.test.ts`（API: 記録の後に続行、開始の失敗、同時・再送、定期実行との同時、問いと PR の変化、保留、妨げ、Task 側の承認・返信・使用上限・送信失敗・ランナー側の拒否）
- `bun scripts/approvals-e2e.ts`（承認の 1 タップ、`/api/asks` を止めても承認に答えられる）と `bun scripts/mobile-e2e.ts`

## スコープ外

- 方針の再利用（#938）。工程 Task の停止への回答（Issue 側の停止。今は 422）
- 新しいメール・プッシュ通知、会話の自由文を根拠なく承認へ変換すること
