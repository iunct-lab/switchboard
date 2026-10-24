# merge-audit（マージの判断の集計と、規則を変える案）

`bun scripts/merge-audit.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--file-request]` が、large の PR をどの種類で誰が外したか（利用者が認めた / 再チェックに合格）を種類ごとに数え、merge-gate の分け（利用者に聞く / 再チェックで外せる。[merge-gate.md](merge-gate.md) の「利用者に聞く理由と再チェックで外せる理由」）を変える案を出す（PBI #752、要望 #750: 過去の判断を受けて自動化し、改善のループを回す）。案は要望として出すだけで、規則を変えるのは今までどおり PR。

## 何を読むか

- PR コメントの記録の印（[merge-gate.md](merge-gate.md) の「記録の印」）: `[merge-ask]` / `[merge-answer]` / `[recheck] <kind> pass`。数えるのは merge-gate と同じ `MARK_AUTHORS` のコメントだけ
- 読む範囲: 期間の始まりと、期間の終わりから `LOOKBACK_DAYS`（90 日）前の早い方から（案のため。既定の実行でも 90 日分を読む。マージされた PR 1 本につき REST 1〜2 回で、1 か月分で約 3 分。90 日のマージが 1,000 件を超えると検索が exit 2 になるので、そのときは読み方を変える）
- 読む PR: 読む範囲の始まり以降に印が付いた PR（リポジトリ全体のコメント `issues/comments?since=` を 1 本で）と、読む範囲の始まり以降にマージされた PR（`search/issues` の `is:pr is:merged merged:>=`。不完全な結果・1,000 件超えは exit 2）。その PR ごとにコメントを全部読み（`issues/<n>/comments`）、`pulls/<n>` でマージ時刻と head を読む。印が期間より前でも、期間内の返事やマージの根拠になる
- main のコミット（`git log origin/main`。リポジトリの clone から実行する）: `git revert` の行（`This reverts commit <40 桁>.`）と、`scripts/rollback-pr.ts` のコミット（件名 `revert: <tag> に戻す`、本文の `- <短い sha> <件名>`）から、戻されたコミット → `commits/<sha>/pulls` で PR の番号
- REST だけ（GraphQL の枠は Project の道具と共有）。何も貯めない（印が正本で、毎回読み直す）

## 表

期間（既定は今日までの 7 日、UTC の日、`--until` を含む）の、種類（`MERGE_KINDS` の順）ごとに 1 行。数えるものが全部 0 の種類は出さない:

```
<kind> 聞いた N / 認めた N / 認めなかった N / 返事まで 中央値 Nh（合計 Nh） / 再チェックで自動マージ N / 戻された N（#a, #b）
```

- 聞いた: 期間内の `[merge-ask]` でその種類を含むものの数（head ごとに聞いた回数）。認めた / 認めなかった: 期間内にその種類の返事のあった PR の数（PR ごとに最後の返事。head が変わって 2 回認めた PR も 1。#1069）
- 返事まで: 同じ PR の、その種類を含む直前の `[merge-ask]` から `[merge-answer]` までの時間の中央値と、その合計（#1272。聞く種類が人をどれだけ待たせたか。security は案の対象外のままでも、このコストは表で見える）。返事に先立つ `[merge-ask]` が無ければ `-`
- 再チェックで自動マージ: 期間内にマージされ、マージした head と同じ sha のその種類の `[recheck] pass` があり、その種類を含む `[merge-answer] yes` が無い PR（yes はどの head へのものでも。利用者が一度認めた種類は、その後の再チェックでのマージでも自動マージに数えない）
- 戻された: そのうち、`git revert` か `rollback-pr` が戻したコミットの PR

表のあとに、印の欠けがあれば 1 行（無ければ出さない。#1069）: `印の欠け: 聞かずに返事 #a, #b / 返事なしでマージ #c`。「聞かずに返事」は期間内に `[merge-answer]` があり、その返事以前に `[merge-ask]` が 1 つも無い PR（種類は見ない）。「返事なしでマージ」は期間内にマージされ、`[merge-ask]` があり、最後の `[merge-ask]` 以後に返事の印が無い PR。欠けのある PR は表に片側しか出ない（返事だけの PR は「認めた」に数えるが「聞いた」に無く、聞いただけの PR は「聞いた」に数えるが「認めた」に無い）ので、表の数が合わないときはこの行を見る。過去の PR に印を付け直すことはしない（印の付け方は [merge-gate.md](merge-gate.md) の「記録の印」）。

## 案

表の期間の終わり（`--until`）から `LOOKBACK_DAYS`（90 日）前までを見る（聞く種類は件数が少なく、1 週では足りない。過去の `--until` ならその時点の案になる）。今の分け（`scripts/merge-gate.ts` の `ASK_KINDS` / `RECHECK_KINDS`）に対して向きの合う案だけ:

| 案 | 条件 |
|---|---|
| `<kind>` を聞くへ | 再チェックの種類（`size` / `responsibility` / `migration`）で、再チェックで自動マージした PR が戻された（1 件でも。マージも戻しも窓の中） |
| `<kind>` を再チェックへ | 聞く種類のうち `rescue` / `design-rules` で、その種類を含む `[merge-answer]` がある PR の新しい方から `STREAK`（5）本がすべて `yes`（PR ごとに最後の返事。head が変わって聞き直した PR も 1 本） |

`security` は案にしない（利用者がいつも答える。PBI #752 のスコープ外）。値は定数（`STREAK` / `LOOKBACK_DAYS`）。フラグ・設定にしない。

表のあとに案を `案: …` で 1 行ずつ、無ければ `案なし` の 1 行を出す（#1272。表だけでは案の判定まで動いたか読めなかった）。exit 0 = 案なし / 1 = 案あり / 2 = 読めなかった（`gh` / `git` の失敗、検索が不完全）。`check-models` / merge-gate と同じ意味。

## `--file-request` と週 1 回の定期実行

`--file-request` のときは結果を 1 行出す: `要望: 起票した #N` / `要望: 同じ題の開いた要望 #N があるので起票しない` / `要望: 案が無いので起票しない` / `要望: 起票できなかった（…）`（#1272。`fileRequest` の戻り値 `Filed` から）。exit 1 のとき、要望 Issue（`type:request`）を `scripts/file-request.ts`（`check-models` と共有。`scripts/setup/request_issue.sh` を呼ぶ）で 1 件出す。題は `マージ規則の見直し: <kind> を聞くへ / <kind> を再チェックへ`（`MERGE_KINDS` の順。同じ案の組は同じ題）で、同じ題の開いた要望があれば出さない（REST で読む）。題は案の組で決まるので、組が変わると（案が 1 つ減った・増えた）開いた要望と重なる案でも新しい要望になる（`check-models` と同じ）。終了コードは付けても付けなくても同じ。

既存のスケジューラ（[scheduler.md](scheduler.md)）の prompt スケジュールで回す（新しい action も GitHub Actions の schedule も作らない — Actions は請求の問題で走らないことがある）:

```
POST /api/schedules
{ "title": "merge-audit（マージ規則の見直し）", "cron": "0 7 * * 1", "workspaceId": <the switchboard workspace>, "runner": "claude",
  "prompt": "bun scripts/merge-audit.ts --file-request を 1 回実行し、終了コードと出力をそのまま報告してください。90 日分を読むので 10 分前後かかります。シェルのタイムアウトで切らないよう、バックグラウンドで実行して終わるのを待ってください。ファイルは変更しないでください。",
  "budgetUsd": <agreed with the user> }
```

登録は動いているデーモンへの呼び出しなので、利用者の OK を取ってから（運用の確認。PR ではしない）。

## 要望が来たら

- `<kind>` を聞くへ: 戻された PR と、戻した理由を読む。採るなら `scripts/merge-gate.ts` で その種類の理由を `[聞く]` にする（`ASK_KINDS` / `RECHECK_KINDS` と `judge` の分け）PR を出す
- `<kind>` を再チェックへ: その種類の再チェックの中身（[merge-gate.md](merge-gate.md) の「再チェック」に種類を足す）と一緒に、`[再チェック <kind>]` にする PR を出す
- 採らないなら要望を閉じる（同じ案は、閉じたあとの次の集計でまた出る。出し続けたくないなら規則か案の条件を PR で変える）
