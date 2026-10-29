---
name: flow-loop
description: 開発の流れの数字から一番時間を食う段を選び、改善の要望を起こし、前の手が効いたかを確かめるときに読む。定期実行から走る。
---

# 開発の流れの改善を回す（flow-loop）

閉じた PBI の段ごとの時間（`bun scripts/flow-report.ts`、段の定義と数の読み方は `docs/design/flow-metrics.md`）から、一番時間を食う段を選んで改善の要望を 1 件起こし、前に起こした要望が効いたかを数字で確かめる（PBI #652）。ここは**回し方**だけ。
起こすのは要望まで。PBI にして実装するかは今の Backlog の流れ（定期実行）に任せる。数字を目標にしてエージェントの動きを縛らない（段の時間の上限で止める、など）。1 回の実行で起こす要望は**最大 1 件**。

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
W=$(mktemp -d "${TMPDIR:-/tmp}/switchboard.flow-loop.XXXXXX")   # 表示されたパスを控える。Codex の Task は /tmp を閉じたサンドボックスなので $TMPDIR の下（CLAUDE.md の「作業の場所」）
```

Issue の照会と書き込みは、スケジュールから走る Task の中（`BACKLOG_URL` がある）では `ops-kit backlog view` / `ops-kit backlog comment <n> --body-file <f>`（`issue-workflow` の「操作」。アプリの保存値に書き、アプリが GitHub に送る）。`BACKLOG_URL` が無い（人が手で回す）ときは `gh issue view` / `gh issue comment -R "$REPO"`。閉じたものを含む `flow` の要望の一覧だけは、`ops-kit backlog list` にラベルと閉じた Issue の絞り込みが無いので、どちらでも `gh issue list` で読む。

## 要望の本文に書く印

次の回が読み返すので、`## 要望` の先頭にこの 3 行をこの形で書く（段の名前は `flow-report` の 7 つのどれか。中央値は `flow-report` の表と同じ書き方）:

```markdown
- 対象の段: `<段>`
- 今の中央値: <中央値>（直近 30 日に閉じた PBI のうちその段が分かった <n> 件、<YYYY-MM-DD> 時点）
- 狙い: <何がどう変われば効いたと言えるか。例: 中央値を半分に>
```

その下に原因（3 で絞ったもの、根拠の Issue / PR の番号）を書く。

## 1. 効いたかを確かめる

```bash
gh issue list -R "$REPO" -l flow --state all --limit 1000 --json number,state,title,body   # 全部読む（古い要望を見落とすと 2 で同じ段の要望が重なる）
```

前に起こした `flow` の要望ごとに、コメントと `## 派生 PBI` の番号の Issue を読む（`ops-kit backlog view <n>`。閉じた時刻は `--json` の `.issue.closedAt`）。次の要望は飛ばす:

- **判断済み**: 「まだ判断できない」以外の判断の `## 効いたか` のコメントがある。確かめるのは 1 回だけで、その後は見ない（後の窓が広がると、改善よりずっと後の変化が混ざる）
- **まだ手が打たれていない**: 派生 PBI が 1 つも無いか、まだ開いているものがある。「やらない」で閉じた派生 PBI（`stateReason` が `NOT_PLANNED`）は数えず、派生 PBI が全部それなら手が打たれていないので、判断せずに飛ばす
- 「まだ判断できない」の `## 効いたか` があり、下のコマンドの `count` がそのコメントの「後」の件数から増えていない（コメントしない）

派生 PBI が全部閉じた要望について、**最後の派生 PBI が閉じた後に閉じた PBI** の、同じ段の中央値を出す:

```bash
T=<NOT_PLANNED でない最後の派生 PBI の closedAt（ISO 8601）>; ST=<要望の「対象の段」>; D='[<派生 PBI の番号をカンマで>]'   # 閉じた時刻の書き方（ミリ秒の有無）がずれても派生 PBI 自身を「後」に数えない
DAYS=$(( ( $(date +%s) - $(date -d "$T" +%s) ) / 86400 + 1 ))
A="$W/after-<要望の番号>.json"   # 要望ごとに別のファイル（前の要望の結果を読まない）
if bun scripts/flow-report.ts --days "$DAYS" --json "$A" >/dev/null; then
  jq --arg t "$T" --arg st "$ST" --argjson d "$D" '[.pbis[] | select(.closedAt > $t and (.number as $n | $d | index($n) | not)) | .stages[$st] | select(. != null)] | sort
    | { count: length, p50: (if length == 0 then null elif length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end) }' "$A"   # p50 は ms
else
  echo "flow-report が止まった。この要望は今回は飛ばし（コメントしない）、理由を 4 の「起こさないとき」に書く"
fi
```

p50 は ms なので、前の値と同じ書き方（`scripts/flow-report.ts` の `dur`: 120 分未満は `m`、48 時間未満は小数 1 桁の `h`、それ以上は小数 1 桁の `d`）に直してから比べる。

要望に `## 前の測り直し` のコメント（段の定義を変えた PBI が、その段の終わっていない要望に付ける）があれば、前は要望の「今の中央値」ではなく、そのコメントの値と件数を使う（定義を変える前の値と比べると、数え方の差が効き目に混ざる）。

要望 Issue にコメントする（上の「Issue の照会と書き込み」）:

```markdown
## 効いたか
- 段: `<段>`
- 前: <要望の「今の中央値」>（<n> 件）
- 後: <中央値>（最後の派生 PBI #<n> が閉じた <YYYY-MM-DD> の後に閉じた PBI <n> 件、<YYYY-MM-DD> 時点）
- 判断: <効いた / 変わらない / 悪くなった / まだ判断できない>
```

後の件数が 3 未満なら判断は「まだ判断できない」（次の回でもう一度見る）。比べるのは自分の前後だけで、効いた・効かないの線引きは要望の「狙い」に照らす。中央値の上下だけで決めず、件数が少ない・不明が多いときはそう書く（`flow-metrics.md` の「数の読み方」）。効いていない・悪くなったときも新しい要望は起こさない（2 以降で同じ段が選ばれれば、そこで原因を絞り直す）。

## 2. 段を選ぶ

```bash
bun scripts/flow-report.ts --days 30 --json "$W/flow.json"
jq '{bottleneck, closed, stages}' "$W/flow.json"
```

一番時間を食った段は表の「一番時間を食った段（中央値）」（`bottleneck`）。選んだ段を `ST=<選んだ段>` にする（1 で入れた値を 3 で使わない）。ただし同じ段に**終わっていない** `flow` の要望（開いている、または派生 PBI が閉じて要望も閉じたが 1 でまだ判断済みになっていない）があれば（1 の一覧の「対象の段」）、中央値が次に大きい段にする（改善の前のデータが大半の中央値で、同じ段の要望を重ねない）。件数が 3 未満の段は選ばない。選べる段が無ければ 4 の「起こさないとき」へ。

GitHub の API の残りが少なくて `flow-report` が止まった（exit 1）ときは、何も起こさずに理由を 4 の「起こさないとき」に書いて終わる。

## 3. 原因を 1 つに絞る

その段が長かった PBI を 3 件選ぶ（`jq --arg st "$ST" '[.pbis[] | select(.stages[$st] != null)] | sort_by(-.stages[$st]) | .[:3] | map({number, title, ms: .stages[$st]})' "$W/flow.json"`）。PBI ごとに、その段の始まりと終わりの間に何があったかを Issue・PR のコメントで読む（`ops-kit backlog view <PBI>`、Task の着手・結果コメント、PR のレビューコメント）。

- 3 件で一番効いている理由を 1 つに絞る（例: `review-wait` = Codex の上限でサブエージェントへの切り替えが遅い、`wait` = 前提の PBI 待ちで後回しにされたまま）。絞れなければ要望は起こさない（4 の「起こさないとき」）
- 返事待ち（`userWaitMs`）が大きくても、それをその段の理由と決めない。段の中身はコメントで確かめる（`flow-metrics.md`）
- 原因の根拠の Issue / PR の番号を控える

## 4. 要望を起こす

`request-to-backlog` スキルで要望 Issue を 1 件起こす（その 1 まで。PBI にするのは定期実行に任せる）。

- ラベル: `type:request` と `flow`
- `## 要望`: 上の「要望の本文に書く印」の 3 行と、原因と根拠
- `## 出典`: 誰の言葉は `エージェント`、経路は「flow-loop（定期実行）」

**起こさないとき**（選べる段が無い、原因を絞れない、`flow-report` が止まった）: 理由を、最後に起こした `flow` の要望（無ければ #652）にコメントで書く（上の「Issue の照会と書き込み」。「flow-loop <YYYY-MM-DD>: 要望を起こさなかった。理由: …」）。

## 5. 片づけ

`rm -rf "$W"`（控えた実際のパスだけ）。返事には、効いたかのコメントの URL、起こした要望の番号（か、起こさなかった理由のコメントの URL）を書く。
