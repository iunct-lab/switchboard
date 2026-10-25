# ホストのディスク — 計測と保持

自分のデータ量と成長率を測って保持を決める。DB を外部化しても、ランナーの記録と配布物の保持は別に必要になる。

## 計測

```bash
df -h /
du -sh ~/.switchboard/snapshots ~/.switchboard/releases ~/.switchboard/switchboard.db*
du -sh ~/.claude/projects ~/.codex/sessions ~/.cache/*
find ~/.claude/projects ~/.codex/sessions -name '*.jsonl' -printf '%TY-%Tm-%Td %s\n' | awk '{a[$1]+=$2} END{for(k in a) printf "%s %.0f MB\n",k,a[k]/1048576}' | sort
sqlite3 -readonly ~/.switchboard/switchboard.db "select name, sum(pgsize) from dbstat group by name order by 2 desc"
sqlite3 -readonly ~/.switchboard/switchboard.db "select date(ts/1000,'unixepoch'), count(*), sum(length(json)) from events group by 1"
aws s3 ls --summarize --recursive "s3://$SB_DATA_BUCKET/archive/"
aws s3api list-object-versions --bucket "$SB_DATA_BUCKET" --prefix archive/runner/
```

`find` の行は最終更新日ごとの記録の合計で、日ごとの増え方になる（手元に残る日だけ。外へ移した日は出ない）。

実測（2026-10-25 計測、このホスト）: Claude Code 2.1.300 から記録 1 件に各リクエストの system prompt・tools・パラメータが載り、1 日の量が増えた。2.1.300 以降の 10-17〜10-24 は 157 / 318 / 448 / 441 / 146 / 190 / 202 / 93 MB（8 日で約 2.0 GB、平均 250 MB/日、最大 448 MB/日）。それ以前の 10-01〜10-16 は 1 日 3〜141 MB（2026-10-22 の概数）。Codex は 1 日 0〜11 MB。

同じコマンドを間隔を空けて実行し、差分を日数で割る。DB の JSON 量とページ量は異なる。WAL・索引・古い版も数える。S3 の版一覧を読めないロールなら、所有者の権限で確認する。

## 例示 workload

以下は費用と増加速度を比べるための入力。ランナー記録の行だけは実測（上の「計測」）で、ほかは計算用に置いた丸い仮定値。

| 入力 | 例 |
|---|---|
| DB | 0.5 GB、増加 20 MB/日 |
| スナップショット | 10 個なら 200 MB/日、3 個なら 60 MB/日増える |
| 配布物 | 初回 200 MB、差分 20 MB、1 日 2 個なら 40 MB/日 |
| ランナー記録 | Claude 250 MB/日（2.1.300 以降の実測平均）、Codex 10 MB/日（上限寄りの実測 11 MB） |
| runner-sync | 圧縮した土台 350 MB、1 時間の差分 5 MB |

保持なしでは合計約 0.52 GB/日になる。空き 3 GB なら約 6 日で尽きる。EBS の拡張は増加速度を変えず、縮小もできない。
runner-sync の同じキーを毎回上書きすると、版管理で退避全体が回数分残る。7 日ごとの土台と差分を別キーへ 1 回ずつ書けば、1 日の書込量は 350/7 + 24×5 = 170 MB。60 日分で約 10.2 GB になる。古い方式の版は、その版のライフサイクルが切れるまで別に課金される。

## 現在の保持

- スナップショットは新しい 3 個
- 配布物は `current`・`previous` と新しい 5 個
- 終了から 30 日の events は、本文を S3 に移し、行と時刻・ツール名などの骨を残す。30 日より前の集計も維持する（下の「30 日より前の履歴の分析」）
- ランナーの会話記録は、手元に新しい方からルートディスクの 10 % まで残し、それを超える古いものを外へ移す（20 GB なら 2 GB。EBS を広げれば上限も広がる。値を固定しないので、記録が 1 日に増える量が変わっても直さない。量にかかわらず 25 日より古いものも移す（Claude の掃除の 30 日より前に S3 に置くため）。ホストの env の `SB_RUNNER_KEEP_MB` で上書きできる）。S3 に残るので消えず、手元から開けなくなるだけ。2026-10-25 の実測（平均 250 MB/日）では 20 GB のディスクで約 8 日分が残る
- 長期履歴は `history/events/`・`history/runner/`。期限なしの S3 Standard で、利用者の age 鍵で暗号化する

復号と取得は [cloud-hosting.md](cloud-hosting.md) の履歴の節。本文を必要としない集計は手元の骨を読む。骨と索引も増えるため、保持後もディスクを計測する。

## 30 日より前の履歴の分析

条件: 履歴の分析は 30 日をさかのぼってできること。
手元の分析（評価の指標 `evals.ts` の `ruleMetrics`、所要時間 `db.ts` の `TASK_DURATION_SQL`、停止の記録 `listStopRecords`、確認の記録 `listPermissionEvents`、最後の返事 `lastReply`）はどれも `events` の行を読む。行ごと消すと、30 日より前の Task はこれらの集計から消える。

決め方: **行は消さず、重い本文（ツールの入力・出力、アシスタントの文）だけを S3 に移し、手元には本文の無い行（骨）を残す**。骨の中身・S3 での置き方・ほかの案と比べた理由は #1431 の決定ログと Task #1437 に書く。

- 効き目: 行と `ts` が残るので、上の集計はコードを変えずに 30 日より前の Task でも同じ値を返す。本文まで読む分析は、S3 から取り出して復号する（鍵は利用者が持つ。手順は [cloud-hosting.md](cloud-hosting.md) の履歴の節）
- 手元に残る大きさは、本文を除いた行の量で見積もる: `sqlite3 -readonly ~/.switchboard/switchboard.db "select count(*), sum(length(json_object('t','tool.call','id',json_extract(json,'$.id'),'name',json_extract(json,'$.name')))) from events where json_extract(json,'$.t')='tool.call'"`（`tool.result` は `id` と `ok`、軽い出来事は `t` が `tool.call` / `tool.result` / `message.delta` 以外の `sum(length(json))`、利用者の言葉は `message.delta` のうち `role` が `assistant` でない行の `sum(length(json))`。アシスタントの文は、続いた同じメッセージのアシスタントの行ごとに本文の無い 1 行になる。その行が Task の最後の出来事なら、最後の行ももう 1 行残る（`events-archive.ts` の `skeletonize`））。骨と主キーの索引は DB とスナップショットのそれぞれに乗る
- ランナーの会話記録（#1432）は本文の分析を手元に残さない。ツールの呼び出しの粒度の分析は、Switchboard の `events` の骨で足りる

## 費用と外部 DB の比較

単価は設計時の東京の計算例。配備前に自分のリージョンで確認する。稼働時間の例は月 175 h と 730 h。

| 案 | 計算例 | 挙動と移行 |
|---|---|---|
| 手元の DB と保持 | EBS 20 GB × $0.096 = $1.92/月。S3 は GB × $0.025 と要求料。長期履歴 0.4 GB/月なら 1 年後 4.8 GB × $0.025 = $0.12/月 | SQLite と復旧経路を保つ。日次の移送は停止中には動かず、次の起動で処理する |
| Aurora Serverless v2 | 最小 0.5 ACU × $0.15 × 稼働時間 = $13.1 / $54.8 にストレージ・I/O・EBS を加算 | 接続中は自動一時停止が効かない。非同期 API・SQL 方言・migration・救援・Litestream・export/import を作り直す |
| Aurora DSQL | 月 10 万 DPU を超える分 × $0.00001 とストレージ。75 万書込/月、1 書込 1 DPU と仮定すると $6.5 | 1 書込あたり DPU は未計測。読み取りも加算する。DB の同期 API と復旧経路の変更が必要 |

単価の出典: [EBS](https://aws.amazon.com/ebs/pricing/)、[S3](https://aws.amazon.com/s3/pricing/)、[Aurora](https://aws.amazon.com/rds/aurora/pricing/)、[DSQL](https://aws.amazon.com/rds/aurora/dsql/pricing/)。
手元の保持と S3 への本文移送を採用する。DB 外部化だけではランナー記録の増加を止められず、復旧経路の変更も大きい。
