---
name: pbi-complete
description: PBI 1 件を一気通貫で終わらせるコマンド。/pbi-complete PBI番号 で、Ready を確かめ（でなければ pbi-to-tasks）、Task を優先順に Stacked PR（gh stack）で積み、各 PR を主レビュアー（実装とは別のセッション）にレビューさせ、指摘を処理し、許可を 1 つの問いで聞き、一番上の PR でスタックをまとめてマージし、PBI の結果節を書いて閉じるまで。PBI を丸ごと任されたとき、スタックの途中で再開するときに読む。
---

# /pbi-complete <PBI番号>

`pbi-to-tasks` → (`task-to-pr` → `cross-runner-review` → `review-triage-and-merge`) × Task 数 → マージ（全部を判定し、一番上でまとめて）→ PBI を閉じる。
各工程の中身はそれぞれのスキル。ここは**順番と、工程をまたぐ判断**だけ。

## 0. 前提

- 作業ファイルは `/tmp` 直下に固定の名前で置かない（別のリポジトリのセッションと混ざる）。作業ごとに `W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.<用途>.XXXXXX")` で作り、表示されたパスを文字で控えてそのまま使う（Bash の呼び出しをまたぐとシェル変数は消える）。消すときもそのパスだけ（glob で消さない。`task-to-pr` の 3）
<!-- when runner=codex -->
- Codex の Task は `/tmp` に書けず、アプリが渡す `$TMPDIR` の下に作る（上の形のままで通る。`TMPDIR` が無ければ `/tmp`）
<!-- end when -->
- CLAUDE.md が求めるなら、`gh` の PR の書き込み（作成・コメント・編集・マージ・クローズ）には `-R <owner/name>` を付ける。`-R` を取れない `gh stack` は、作業しているリポジトリの worktree の中でだけ実行する（`task-to-pr` の 3）

<!-- when task=in -->
- main の作業ツリーには触らない（worktree で全部やる）。例外は 6-6 の main の更新だけ
<!-- end when -->
<!-- when task=out -->
- エージェント管理アプリの Task として起動されたなら（見分け方は CLAUDE.md）、main の作業ツリーには触らない（worktree で全部やる）。例外は 6-6 の main の更新だけ
<!-- end when -->
- `gh extension list` に `gh-stack`、GitHub の既存認証で対象 Issue が読める。`gh auth status` が失敗したら、認証切れと決めず `issue-workflow` の「GitHub の接続・認証の切り分け」に従う（接続制限なら許可されたネットワーク実行で再検証し、成功したら続行）
<!-- when review=other reviewer=codex -->
- 枠: ランナーの利用上限の見方は CLAUDE.md。Codex の 5 時間枠が 0.9 以上なら、レビューは `cross-runner-review` の 0 のとおり待たずに代替する
<!-- end when -->
<!-- when review=other reviewer=claude -->
- 枠: ランナーの利用上限の見方は CLAUDE.md。主レビュアー（Claude Code）の枠が上限なら、レビューは `cross-runner-review` の 0 のとおり待たずに代替する
<!-- end when -->
<!-- when review=same -->
- 枠: ランナーの利用上限の見方は CLAUDE.md。主レビュアーは実装と同じランナーなので代替は無い。レビューが上限で止まったら `cross-runner-review` の 0 のとおり、未レビューのままマージせず報告して止まる
<!-- end when -->

## この依頼が含む範囲

`/pbi-complete`（工程ボタンの「実装する」を含む）は、PBI を閉じるまでの一気通貫の依頼。次は依頼の範囲なので、**そのたびに利用者へ聞き直さない**:

- マージ判定が merge（exit 0）を返した PR のマージ（`[再チェック <kind>]` を監督者かコマンドの再チェックの仕事の記録で外したあとの exit 0 を含む）
- リリースタグ、Task の結果コメントと Status、PBI の結果節とクローズ
- cross-runner-review のレビューの材料（fresh clone のコード、PR・Task・PBI、差分）を、主レビュアー（`cross-runner-review` の「誰がレビューするか」）に渡すこと
<!-- when extra=on -->
- 同じ材料を CLAUDE.md の追加のレビュアーに渡すこと
<!-- end when -->
- スキルの手順が作る Issue（レビュー指摘の Issue 化、要望 Issue と PBI）とコメント
- 利用者が既に認めた範囲（代替レビュー、材料の共有、同じ head の `PR #<n> をマージしてよい`）を、同じ範囲で繰り返すこと

次は範囲に含まれない（運用の確認か実装の判断として聞く。`issue-workflow` の「判断待ちの出し方」）:

- `[聞く]` の large、マージ判定が直せない stop、exit 2
- 昇格・デーモンを再起動する `git pull`
- 認証・ログイン
- お金・他 OS・破壊的操作

**実行環境の承認（ランナーの自動承認レビューを含む）に操作を拒まれたとき**: 迂回しない（権限モードの変更、API の直接呼び出しなど別の経路で同じ操作を実行しない）。承認を求めるときの理由の欄に、元の依頼の文・今の工程（例: `pbi-complete` の 5）・マージ判定の出力（`verdict` / `impact` / `reasons`）・既存の許可（上の範囲、依頼の文の範囲（レビューの材料の共有など））を添えて、**1 回だけ**申請し直す。それでも拒まれたら、運用の確認として Task の会話で止める。

## 並列で動かす（別の PBI を同時に）

/pbi-complete は PBI ごとに別のセッションで同時に走らせてよい。ただし CLAUDE.md が並列ガードのコマンドを名指ししているときだけ（以下 `<guard>` と書く）。無ければ PBI は 1 セッションずつ進める。待たずに並べるための決まり:

- **1 PBI = 1 セッション = 1 worktree**（場所と名前は CLAUDE.md の worktree の規則。PBI 番号を入れる）。`gh stack` は worktree ごとに別のスタックを持てる（追跡の目録は `<common-dir>/gh-stack` の 1 つ）。他のセッションの worktree・枝・スクラッチには触らない（`git worktree list` に出ても消さない）
- **同じ PBI は 1 セッションだけ**: 1 の最初に `<guard> claim <PBI>`。PBI に占有コメントを書き、release 後の最初の占有コメントが先着（同時に書いたら後の方が自分のコメントを消す。claim の結果の扱いは 1）
- **同じファイルは同時に触らない**: Task に着手する前に `<guard> overlap <Task>`。Task 本文に名指ししたパスを、他のセッションの Draft・`needs-decision` を除く開いている PR の変更ファイルと、判断待ちを除き、占有（`release` で終わっていない `claim` / `takeover`）がある PBI（か親の無い）の In progress の Task が名指ししたパスと突き合わせる（自分の PBI の Task と PR は除く。誰も作業しない PBI どうしが相手の再開を待ち合って止まらないため）。In progress にした後の `--claimed` は Task に着手の印コメントを書き、同じファイルの In progress の Task のうち**先に印を書いた方**だけが進む（後から印を書く側が譲る）。Draft は単独では占有しないが、その実装を進めている In progress Task は占有する。先着の印は同時編集の衝突防止だけであり、作成順・古い PR の存在を優先度の根拠にしない。保留した PR を他の作業のためにマージ・クローズする必要はない。重なったら**その Task だけ後回しにして、重ならない次の Task を進める**（3 の「重なったとき」）。`STALE_HOURS`（72 時間）更新の無い PR / Task は `stale` に出るだけで止めない
- **合流ファイルだけの重なりは止めない**: 重なったファイルが `ops.config.json` の `sharedFiles`（多くの PBI が触るファイル）だけなら verdict は `go`（出力の `shared`）。進め、rebase で衝突したら自分で解き、解いたコミットを見直しに出して（`cross-runner-review` の 4）ローカル CI を回し直す
- **重なりで譲った PBI は順番を持つ**: 最初に譲った時刻の順（同じなら番号の小さい方）で、後から来た PBI の Task は着手の印の後でも譲る（出力の `blocking` に `turn` = 先の PBI の番号。扱いは 3 の「重なったとき」）。順番は、その PBI が `--overlap-waits` の無い release をする・閉じる・そのパスを名指ししなくなると消え、判断待ち・保留（`on-hold`）・期日や使用上限の待ち・前提の未完・72 時間印の無い PBI は飛ばされる。合流ファイルの上では順番も止めない
- exit 2（判定できなかった）は重なりありとみなす。Task にパスが無いなら `pbi-to-tasks` の書き方で Task 本文を直してからやり直す

## 1. Ready を確かめる

```bash
<guard> claim <PBI>     # exit 1 = 取れなかった / 2 = 判定できなかった（扱いは下）
ops-kit backlog view <PBI> --fresh
ops-kit backlog view <PBI> --json | jq -r '.issue.subIssues[]'    # sub-issue の番号。題と状態は 1 件ずつ ops-kit backlog view <Task>
ops-kit lint --fresh
```

claim が exit 1 なら、何も触らず止まる（同じ PBI を二重に進めない）。占有コメントで止まったなら、その日時と worktree を報告して終わる。利用者が「再開」と言ったとき（前のセッションが止まった）だけ `claim <PBI> --takeover`。
出力が `PBI #<n> は <マシン> が <時刻> まで持っている` なら、ほかのマシンのリース（占有コメントは取り下げ済み。`--takeover` でも外れない）。その行を報告し、待つか利用者に聞く。exit 2（判定できなかった）も止まる。
Task が無い・受け入れ条件が覆われていない・lint 違反 → `pbi-to-tasks` を先にやる。PBI の Status が Ready でなければ Ready にしてから（`ops-kit backlog set <PBI> Status Ready`）。
PBI の `## 元要望` の原文を読み、PBI の解釈が原文からずれていないか一度確かめる。

## 2. 順番を決める

1. Task 本文の `**前提**: #N, #M（リリース）` の 1 行（`<guard> overlap` が `prereqs` に出す）で依存順。同じ PBI の Task が前提ならスタックの順番にする
2. 同順位は Project の Priority（P0 → P3）、次に PBI の `## Tasks` に書いた着手順
3. 「利用者に確認して止める」がある Task は、その工程が最後になるように後ろへ（他を止めない）
4. 使用上限のランナーを要る Task（そのランナーでの実ランナーの録画・そのランナーでしかできない確認）は、そのランナーの枠が足りない間（見方は CLAUDE.md の利用上限）は順番の最後へ回し、ほかの Task を先に積む。PBI の決定ログに「YYYY-MM-DD: #<Task> は <ランナー> の使用上限で後回し（枠が戻る <日時>）」を 1 行。その Task を 1 の `**前提**:` に書いている Task も一緒に後へ回す（「3. 積む」の「使用上限を待つとき」の「上限のランナーを要るもの」にはそれも数える）。レビューは上限のランナーを待たず、`cross-runner-review` の 0 の代替で進める

依頼の文に `重ならないと判定した Task: #a, #b` の行があれば（アプリが開始の前に重なりを見た結果）、その Task を先に `<guard> overlap` にかける（1 の前提で後に来る Task は除く）。行は判定の代わりではなく、verdict が `defer` なら 3 の「重なったとき」。

PBI の決定ログに「YYYY-MM-DD: /pbi-complete 開始。順番: #a → #b → #c。枠: …」（`ops-kit backlog edit <PBI> --body-file "$W/body.md" --rev <版>`）。PBI の Status を In progress（`ops-kit backlog set <PBI> Status "In progress"`）。

## 3. 積む（Task ごと）

1 つの worktree、1 本のスタック。**Task i の枝は Task i−1 の枝の上**。worktree の場所と枝の名前は CLAUDE.md の規則（以下 `<枝a>` は Task a の枝）:

```bash
git worktree add --detach <PBI の worktree> origin/main && cd <PBI の worktree>   # 依存の導入も CLAUDE.md が書く手順に従う
git checkout -b <枝a> && gh stack init <枝a>          # 1 本目
# … task-to-pr で実装・テスト・commit・submit …
gh stack add <枝b>                                     # 2 本目は 1 本目の上
```

Task ごとに、着手の前に重なりを確かめる:

```bash
<guard> overlap <Task>            # exit 0 = 進める / 1 = 進めない（verdict: defer = 重なった / wait = 前提が未完 / stop = 前提を人が直す）/ 2 = 判定できなかった（重なりとみなす）
ops-kit backlog set <Task> Status "In progress"
<guard> overlap <Task> --claimed  # 着手の印を書いて相手の印と比べる。後から書いた方が譲る（印の取り下げはガードがする）
<guard> release <PBI> <理由> [--waits n,n | --overlap-waits n,n] [--after <日時>]   # 占有を外す。--waits は待っている相手（PR / Issue の番号）、--after は期日（--waits と一緒なら両方済んでから再開）。待つときだけ
```

`overlap` は Task と親 PBI の本文の `**前提**:` も判定する（`prereqs: [{ ref, state, sibling }]`。`state` はデーモンの判定と同じ: met / pending / withdrawn / missing / unknown。`sibling` = 同じ PBI の Task で、スタックで積むので待たない）。自由文の「前提: #K が Done」は読まれない。

**前提が未完のとき**（verdict `wait`）: 下の「重なったとき」の 1〜2 と同じく後回しにして、独立した Task を積む。全部の Task が `wait` か、残りがそれを前提にしていれば `<guard> release <PBI> "後回し: #<Task>（前提 #N が未完）" --waits <N>`（`N` は `prereqs` の `state: pending` の番号）で止める。前提が閉じれば定期実行（backlog-next）が再開する。待つのは定期実行なので、停止の記録は `waiting` で残さず、**引き渡した印**（`reason` は `depends` のまま、`state` は `resolved`、`evidence` は「backlog-next の前提待ちに引き渡した: #N」）で書いてターンを終える（引き渡した待ちを Task の停止として積まない。#2149。下の期日・使用上限の待ちも同じ印で、`evidence` だけ変える）。
**期日を待つとき**（受け入れ条件が日数の経過を待つ。`issue-workflow` の「日数の経過を待つ行」）: 期日（ISO 8601 のタイムゾーンつき日時）を書いて `<guard> release <PBI> "期日待ち: <何を待つか>" --after <日時>` で止める。期日の後の発火で定期実行が再開する。停止の記録は引き渡した印（`evidence` は「backlog-next の期日待ちに引き渡した: <日時>」）。再開したら検証の欄の集計を回して `## 結果` を書き、受け入れ条件が全部埋まれば閉じる。手で始めた Task（PBI の工程でない）は、止まりの報告の conditions に `{"key":"after","value":"<日時>"}` を書いて `depends` で止める（期日は 7 日以内）。
**使用上限を待つとき**（残る Task が、上限のランナーを要るものと、それを `**前提**:` に書いているものだけ）: ランナーの使用上限での停止（アプリの使用上限の再開の予約）で待たない。枠が戻る時刻（ISO 8601 のタイムゾーンつき日時）を `--after` にして `<guard> release <PBI> "使用上限待ち: #<Task>（<ランナー> の枠が <日時> に戻る）" --after <日時>` で引き渡す。停止の記録は引き渡した印（`evidence` は「backlog-next の使用上限待ちに引き渡した: <日時>」）。日付の待ちで引き渡した PBI の Task は、In progress のものも期日まで重なりの相手に数えられない。再開の予約で待つと、In progress の Task がほかの PBI を重なりで止め続けるため。
**前提を人が直すとき**（verdict `stop`: 取り下げ = 未マージで閉じた PR・not planned の Issue / missing = 見つからない / unknown = Issue に `（リリース）` を付けた。`ops-kit lint` が書いた時点で出すので、PR の番号に書き直す）: その Task は始めない。`## 判断待ち` は出さず、理由を release の文に書いて（`<guard> release <PBI> "止めた: #<Task> の前提 #N が取り下げ"`。`--waits` は付けない）報告の「利用者へ」に書く。直すのは利用者（本文の前提を書き換える・前提を閉じ直す）。マージ済みの PR の `（リリース）` はガードでは成立として進む（動いている版に入ったかはデーモンが判定し、入るまで定期実行はその PBI を始めない）

**重なったとき**（verdict `defer`）: 待たない。
1. In progress にしていたら Backlog に戻し（`ops-kit backlog set <Task> Status Backlog`）、Task に「後回し: <PR #n / Task #n> と <path> が重なる」とコメントする（`ops-kit backlog comment <Task> --body-file -`）
2. その Task と、それを `**前提**:` に書いている Task を順番の最後へ回し、残りから重ならない Task を次に積む（PBI の決定ログに順番の変更を 1 行）
3. 後回しの Task は、他の Task を 5 までマージし終えてから `overlap` をやり直す。exit 0 なら `git fetch origin && git checkout --detach origin/main` から新しいスタックとして積む（相手の変更が入った main の上に作る。古いスタックの上に積まない）
4. まだ重なっていれば PBI は閉じない。`<guard> release <PBI> "後回し: #<Task>（<相手> と重なる）" --overlap-waits <相手の番号>` で占有を外し、報告の「利用者へ」に書いて終わる。`--overlap-waits` は `overlap` の出力の `blocking[].ref` の番号（`PR #778` → `778`、`Task #603` → `603`。複数ならカンマで。`turn` の付いた当たりも `ref` の Task の番号を渡す）。相手が全部閉じるか、待っている PR が Draft・`needs-decision`、または重複相手の Task が `needs-decision` になって占有対象から外れたら、定期実行（バックログを進める）が次の発火でこの PBI を再開する（#817）。停止の報告（reason `depends`）には `overlap` の出力の `conditions` をそのまま写す。手で再開するなら /pbi-complete <PBI>
5. 前提（`**前提**:` の番号）がほかの PBI のもので、未完のまま進めずに止まるときも「前提が未完のとき」と同じ（`--waits <N>` の release で止め、引き渡した印）

`--overlap-waits` はファイル重複待ち、`--waits` は未完の前提待ちとして区別する。前提 Task が判断待ちになっても、完了するまでは進めない。古い `waits=` の Task 待ちは種類が不明なので前提として扱い、手で再開して overlap を再確認する。

後回し以外で止まるとき（完了・返事待ち・判断待ち）の release には `--waits` を付けない — 待ちの無い release が前の待ちを打ち消す（新しい claim も同じ）。

重ならなければ `task-to-pr` の全部（着手コメント → 実装 → テスト / E2E → commit → `gh stack submit --auto --open` → `gh pr edit` → In review）。
**次の Task に進む前に、その PR のレビューを起動しておく**（`cross-runner-review`）。
マージ判定の JSON の `attack` が空でない PR は、攻める側のレビュー（`cross-runner-review` の 2b）も同じ時点で頼む（最後にまとめない）。
<!-- when task=in -->
`ops-kit job request review` で仕事に頼み、終わりを待たずに次の実装へ進む。次の Task も終わって待つものだけになったら、`job#<id>` を止まりの報告に書いてターンを終える。
<!-- end when -->
<!-- when task=out -->
アプリの Task の外では Bash の background で走らせ、次の実装と並行。
<!-- end when -->

Task の途中で設計が変わった（Task に書いた場所では足りない、受け入れ条件が満たせない）ら、その Task と PBI の決定ログに書いてから続ける。
公開に出すツリーを `ops-kit public-sync --dry-run` で確かめるときは、`--source` にタグでないコミット（`HEAD`・枝・SHA）を渡す。dry-run のために一時タグを作らない（消し忘れ・誤 push が残る。版を公開側で独立に付ける設定でも、タグでない source の dry-run は版を「仮」と出してツリーの検査だけをする）。
利用者の判断が要る箇所は `issue-workflow` の「判断待ちの出し方」で種類を分けて止める: 実装の判断（要件の読み・設計の選択・受け入れ条件の変更）は Issue の `## 判断待ち`（`**進め方**` の行とラベルは同じ節）、運用の確認（マージ・昇格・認証・実行のタイミング）は Issue に書かず Task の会話で聞いてターンを終える（下の 5）。実装の判断の返事が来ないとき、**要件の解釈**が絡む Task は実装せず飛ばして次の Task へ（PBI は閉じない）。お金 / 他 OS / 破壊的操作だけは安全側（既定 off / 何も消費しない）で実装して進む（`task-to-pr` 1-2）。

作業の途中で GitHub の認証が必要だと判断する前にも、`issue-workflow` の「GitHub の接続・認証の切り分け」を行う。接続制限だけで認証の運用確認に進まない。

## 4. レビューを処理する（PR ごと）

`review-triage-and-merge` の 1〜4（同じ論点に指摘が続いたら、修正を積む前に同じスキルの 3 の「同じ論点が続いたら」）。**修正は指摘のある枝で** commit → `gh stack rebase`（その枝から上を cascade）→ `gh stack push`。
下の枝を直したあと上の枝のテストも走らせる（スタックの一番上で、型検査と `<関係するテスト>`。`task-to-pr` の 4）。

全 PR の指摘が処理され、CI が緑になるまで**マージしない**（途中で下だけ入れると、上の PR の指摘対応で main を汚す）。
Actions が始まらないリポジトリのローカル CI（CLAUDE.md のコマンド。以下 `<ローカル CI>`）は、全部の PR の指摘の処理が済んでから、スタックの一番上の PR で 1 回だけ回す。差分が変わったら（修正コミット、手で解いたコンフリクト）一番上でもう 1 回。同じ head の合格が既にあれば `<ローカル CI>` は回さず終わる（そうするコマンドのとき）。いつ回し、マージ判定がどう数えるかは CLAUDE.md が名指しするマージ判定の規則（When to run local CI and how it counts）。
<!-- when task=in -->
`<ローカル CI>` は自分のシェルで回さず `ops-kit job request local-ci <PR>` で頼み、request が出す JSON（reason `depends`、conditions に `job#<id>`）を止まりの報告に書いてターンを終える。アプリが結果の要約を添えて再開するので、それを読んで次へ進む（背景の `sleep` の繰り返しで待たない。`task-to-pr` の 4 の「ローカル CI を回すとき」）。
<!-- end when -->
登録に無い失敗が base でも落ちるなら、`task-to-pr` の「ローカル CI が登録に無い失敗で落ち、base でも落ちると確かめたら」の項に従う（承認は求めない）。

## 5. マージ（全部を判定してから、一番上でまとめて）

**ローカルの変更では**（どの workspace かは `task-to-pr` の「ローカルの変更では」）: スタックは無い（1 枝ずつ）。ローカル CI は `<ローカル CI> --change <変更>`、判定は `<マージ判定> --change <変更>`、マージは `local-merge.ts <変更>`（どれも Task への指示が名指しする場所のスクリプト。`--repo` は付けない）。マージしたら次の Task の枝を main から切る。リリースタグと `ops-kit pull-main` は飛ばす。再チェックは `--change` を付けて頼み、変更に対して記録される。再チェックでマージした決定ログの「戻すなら <tag>」は「戻すなら: タグなし」。ローカル CI の合格は base の先端ごと。1 件をマージしたら、残りの変更ごとに `<ローカル CI> --change <変更>` を回し直してから判定する（前の合格は新しい base では数えられない）。

**GitHub が使えないときは**（CLAUDE.md が `<GitHub 不在の切り替え>` と `<GitHub への復帰>` を名指しするとき）: 切り替えは `task-to-pr` と `review-triage-and-merge` の同名の段落。不在の間はリリースタグを打たない。ローカルでマージする前に、main の作業ツリーがアプリを動かしているなら `ops-kit pull-main` と同じく利用者の OK を取る。PBI を閉じる前に、その PBI の Task にローカルの変更があれば `<GitHub への復帰> --pbi <PBI>` を回す: exit 0 = 揃った / exit 4 = GitHub がまだ戻っていない（`## 状況` に「GitHub の戻り待ち」と書き、停止の報告 `transient` で止まる）/ exit 1 = 止まる（競合なら PBI に `## 判断待ち`）/ exit 5 = 同期の PR ができた。`cross-runner-review` に通してから `<GitHub への復帰> --merge-sync <PR>` で入れる（Merge commit。`<マージ判定> --merge` は rebase なので使わない。`[聞く]` なら 5 の運用の確認をし、yes の後は `--allow-large` を足して同じく `--merge-sync`。入った後の失敗は出力の指示どおり: 記録だけなら `--report`、ローカルの main なら復帰をもう一度）。揃ったら `<GitHub への復帰> --report`（不在の間の変更ごとに、レビューと判定の要約を PR か Task に 1 回だけ残す。exit 4 は次の実行で続き）。履歴を書き換える push と rebase はどの段でもしない

<!-- when mergeGate=off -->
マージ判定のコマンドが無いリポジトリでは、`review-triage-and-merge` の 5 のチェックリストを自分で確かめる。
<!-- end when -->
**各 PR のマージ直前にマージ判定**（CLAUDE.md が名指しするコマンド。以下 `<マージ判定>`）。スタックは最初のマージの前に全部の PR を `<マージ判定> <n>`（マージなし）で判定し、下の分岐で片づける。`notes` の名指しの外のファイル（付いてくるファイルは除く）は、`（Task #k が名指し）` ならその Task の枝へ移し、無ければ Task の結果コメントに逸脱として 1 行書く（本文には足さない）。exit 1（stop）なら:
- large の理由が `[再チェック <kind>]` だけ（`[聞く]` が無い。マージ判定が large の理由をこの 2 つに分ける仕組みのとき。`rescue/**` と README の Design rules もここ）→ **利用者に聞かずに**、出力の `recheck` の種類ごとに再チェック（CLAUDE.md が名指しする手順。以下 `<再チェック>`）をアプリの仕事として頼む。LLM が読む種類は監督者（`cross-runner-review` の 6）、コマンドで決まる種類はコマンドの再チェック（中身は `<再チェック>` の種類ごとの行。頼み方は次の段落）。合格の印と patch-id は投稿しない（判定は仕事の記録の head と結果を読む）。仕事が終わったらマージ判定をもう一度通してマージする。再チェックでマージしたら PBI の決定ログに 1 行「YYYY-MM-DD: 自動マージ: PR #n（<種類>、再チェック合格）、戻すなら <tag>」（`<tag>` は CI を通ったタグの中の最新。見方は `<再チェック>`）。通らなければ（レビュアー側の裁定・`missing` の観点・コマンドの失敗）直して（`review-triage-and-merge` の 2〜4。同じ論点なら先に 3 の「同じ論点が続いたら」。監督者は `--follow-up` で 1 回だけ頼み直す）回し直す。監督者のランナーが使用上限なら、替えずに戻る時刻まで待つ。利用者には聞かない。直せない・待てないときだけ、下の `[聞く]` と同じく運用の確認で聞く。CI など large 以外の理由が一緒に出ていれば、それは次の「それ以外の理由」と同じく先に片づける
<!-- when task=in -->
再チェックの頼み方（`job#<id>` を止まりの理由に書いてターンを終える）: LLM が読む種類は監督者として `ops-kit job request review <PR> --as arbiter --cwd … --prompt … --out …`（`--runner` も `--kinds` も付けない。ランナーは再チェックの設定からアプリが選ぶ。材料と転記は `cross-runner-review` の 6。判定が読むのは仕事の記録だけで、転記した `[<runner>] arbiter` のコメントは数えない）、コマンドの種類（`migration`・`rescue`・`security:lockfile`）は `ops-kit job request recheck <PR> --kind <種類> [--cwd <PR の head の checkout>]`（未コミットの変更のある checkout は断られる）。`rescue` は両方が要る。`--kinds` の無い `--as recheck` はどの再チェックも満たさない。GitLab の MR も、利用者が Task の会話で `PR #<iid> をマージしてよい` と答えると、その MR の head に許可が記録され、聞く理由が外れる（`MR !<iid>` の形では記録されない）。
<!-- end when -->
<!-- when task=out -->
Task の外では再チェックを直接回す。
<!-- end when -->
- `[聞く]` の理由がある（セキュリティ。分けない仕組みなら impact が large の理由すべて）で、それ以外の理由が無い → 運用の確認として Task の会話で聞いてターンを終える（`issue-workflow` の「判断待ちの出し方」の「運用の確認」。確認「PR #n をマージしてよいか」、PR の番号と `+add/-del`、推奨。Issue に `## 判断待ち` を出さない。スタックは下の段落のとおりまとめる）。`reasons` は分類の見出しで分けてそのまま貼る: `**セキュリティ**:`（「[聞く] セキュリティ:」。認証・秘密・CI・依存）/ `**ゲートの変更**:`（`security:gates` のときだけ。差分を読み、どの判定（手順・終了コードの読み方・テストの選び方・差し引き・印・規則・マージ）がどう変わるかを「厳しくなる / 緩くなる / 変わらない」で 1〜3 行）/ `**再チェックの残り**:`（仕事の記録で合格していない `[再チェック …]`。聞く間に再チェックも回しておくと、返事の後にそれを待たない）。当たらない分類の見出しは書かない（gates の無い問いに `**ゲートの変更**:` は書かない）。選択肢の許可文と、停止の報告の `grant` は `PR #<n> をマージしてよい`（ローカルの変更では `変更 L<n> をマージしてよい`）の 1 行 1 文にする（1 行に複数の文をつなげない）。許可はその Task・その head で記録される。印は投稿しない（上の再チェックの分岐から聞くときも同じ）
- それ以外の理由（CI、未解決のスレッド、見直されていないコミット、CLEAN でない）→ 自分で直す（CI を待つ（`gh run list` で見る。`sleep` の繰り返しで待たない。ローカル CI は上のとおり仕事に頼む）/ 返信して resolve / `cross-runner-review` の 4 で見直し）。CI が**始まらない**（ジョブのステップ 0 件）か、run が無い・全部 skip（Actions を変数で止めたリポジトリ）なら待たずローカル CI（CLAUDE.md のコマンド。`review-triage-and-merge` の「CI 緑」）。主レビュアーが使用上限なら見直しも実装したランナーの新しいセッションで代替（`cross-runner-review` の 0）。直せなければ同じく運用の確認として Task の会話で聞く
- exit 2（判定できなかった）はマージしない（止めた理由を Task の会話に書いてターンを終える）

**スタックの要る許可は PR ごとに止まらず**、自分で直せる理由と再チェックを片づけてから、`[聞く]` の PR（`ask`）を **1 つの問いにまとめ**て聞く。一番下が判定の外のマージを要るなら、それを先に聞いて入れ、上はその後に聞く（rebase で上の head が変わり許可が効かない）。問いには PR ごとに番号・`+add/-del`・`reasons`（上の見出し）を並べ、`grant` に許可文を PR ごとに 1 行 1 文で全部並べる（名指しの無い文は作らない）。一部だけ認めるなら認める行だけを返信に書けばよい、と添える。返信の `PR #<n> をマージしてよい` は全部の行が決まった文のときだけ文字で読まれる（混じると記録されるとは限らず、ボタンの `grant` では記録されない。条件の行を混ぜない）。聞いた後に push したら、その PR は聞き直す。

止めるときは `<guard> release <PBI> "返事待ち: <確認の 1 文>"`（並列ガードを使うとき）。返信を受けて再開するときは `<guard> claim <PBI>` からやり直し（通らなければ 1 のとおり止まる）、**必ずマージ判定をもう一度通す**。利用者が `PR #<n> をマージしてよい` と答えた（返信が大きい変更のマージを認めた）ときだけ、`<マージ判定> <PR> --allow-large --merge`（スタックは一番上の PR を `--merge-stack`）を回す。記録の印は投稿しない（許可はアプリが答えを head つきで記録し、判定が読む）。記録が無ければ（head が変わった・答えが読まれなかった）`--allow-large` は聞く理由を外さず判定が止めるので、聞き直す。CI・未解決のスレッド・見直されていないコミット・CLEAN でないことは、返信があっても外れない。新しいコミットを積んだら（下の PR のマージ後の自動 rebase で head が変わったときも）許可は古い head のものなので、聞き直す。
コマンドの再チェックの記録は head ごとなので、下の PR のマージ後の自動 rebase で head が変わったら頼み直す（監督者の記録は同じ差分の head でも数える。`<再チェック>`）。

マージは `<マージ判定> <一番上の PR> --merge-stack`（スタック。下の PR も今の head で判定し、全部 merge のときだけまとめて）/ `--merge`（単発）で、判定が merge のときだけマージまで進む（判定とマージが 1 つのコマンドなので、Task の許可に入る）。1 本でも stop ならどれも入らないので、`stack` の stop の PR を上の分岐に戻す。認められなかった PR があれば、そのすぐ下を名指しする。
<!-- when mergeGate=off -->
マージ判定のコマンドに `--merge` / `--merge-stack` が無いリポジトリ（CLAUDE.md がマージ判定を名指ししない、またはその引数が無い）では、`<マージ判定> <PR> && gh stack merge <PR> --rebase -y`、単発は `gh pr merge <n> --rebase --delete-branch` にする。
<!-- end when -->
判定が stop の PR（CI の理由も）を、利用者が Task の会話で判定の外でマージしてよいと認めたときは、その PR だけを、単発は `gh pr merge <n> --rebase --delete-branch --match-head-commit <head>`、スタックの PR は最下段から 1 本ずつ `gh api -X PUT repos/<owner>/<name>/pulls/<n>/merge-async -f sha=<head> -f merge_method=rebase`（`--delete-branch` なし。`stacked-pr-delivery` の 6）でマージする。merge-async は受け付けで返るので、`ops-kit wait` で `MERGED` を待つ（判定は `sh -c 'test "$(gh pr view <n> --json state -q .state)" = MERGED'`。毎回読み直す）（切れたら上へ進まない）。上の PR は自動 rebase で head が変わるので、その後 `gh pr view <上> --json headRefOid` で読み、その head で許可を聞き直す。マージしたら、PBI の決定ログに「YYYY-MM-DD: 判定の外のマージ: PR #n（利用者が OK。<stop の理由>）」を書く。
判定の外のマージ（`gh pr merge --match-head-commit` か merge-async。CI やレビューを飛ばす）の同意は、聞く理由の許可 `PR #<n> をマージしてよい` とは別の、より強い `PR #<n> を判定の外でマージしてよい` で、前者では通らない。
<!-- when mergeGate=on task=in -->
`gh pr merge` などの判定の外のマージは `gh` の前段が止める（`ops.config.json` に `mergeGate` があるリポジトリのアプリの Task）。通るのは判定のコマンド自身のマージと、利用者が選んだ `PR #<n> を判定の外でマージしてよい` の許可文が記録されている PR だけ（`gh stack merge` は head を渡せず通らない）。許可文は PR ごとにその Task の会話の中だけで、選択肢に添えて聞く。昇格と Release の作成は前段が止めない。
<!-- end when -->


```bash
<マージ判定> <n>                          # スタックの全部の PR。要る許可は 1 つの問いで
<マージ判定> <一番上の PR> --merge-stack   # 返事の後（認めたなら --allow-large も）
```

- **UNSTABLE** = CI が走っている（マージ判定が「未完了」で止めるので、待ってやり直す）か、CI が始まらない・run が無い（4 のローカル CI。一番上の合格がこの PR の差分を含めばマージ判定は UNSTABLE のまま通す）
- **CONFLICTING / DIRTY** = main とぶつかった。**このときだけ**ローカルで直す: `git fetch && git checkout <一番下の枝> && git rebase origin/main` → 解消 → テスト → `ops-kit pr push-rebased`（今の枝を書き直して push。既定の枝では断る）。上の枝は 4 のとおり積み直し、一番上のローカル CI からやり直す。直したら CLEAN を待って再開
- 中身が空になった PR は GitHub が merged 扱いにする（下の PR に取り込まれたとき）。空の PR を残さない
- スタックに属さない単発は `<マージ判定> <n> --merge`（`gh stack merge` は "not a stacked pull request" で失敗する）

マージの後、入った PR ごとに `review-triage-and-merge` の 6（結果コメント、Status Done、復活ファイルの確認）。コンフリクトは全部の PR の判定（各 PR の CLEAN と一番上のローカル CI）で見る（利用者の回答 A、2026-11-20。1 本ずつだと下のマージ後の rebase で上の PR の許可を聞き直すことになった）。

## 6. PBI を閉じる

1. 受け入れ条件の各行を `- [x]` にし、行末に証跡の在りか（`issue-workflow` の記録の義務 4。満たせなかった行も、在りかを書けない行としてそこに従う）。`（利用者確認: …）` と確かめていない `（マージの後: …）` の行は除く（4 を見る）
2. `## 結果`（1 と一緒に `ops-kit backlog edit <PBI> --body-file "$W/body.md" --rev <版>`）: 受け入れ条件ごとの検証、レビュー件数、Story Points の妥当性、残したもの（Issue 番号）
3. 認証の値の後からの検査（`ops-kit scan-issues`）は PBI を閉じるたびには走らせない（エージェント管理アプリの毎日の予定が前回からの差分を読む。`issue-workflow` の「Issue・PR・コメントに書かない値」の「後からの検査」）
4. 確認中（`issue-workflow` の「マージの後の行」）なら閉じず Status を `In review` にして終える。マージの後の行は、この Task では確かめに行かない（まとめて確かめる定期の Task が確かめる。それが無い環境での確かめ方と、満たさなかったときの戻し方は `issue-workflow` の「確認中の行を確かめる者と、満たさなかったとき」）。利用者の確認待ちの項目があれば Status は In review のまま open。確認待ちは `ops-kit backlog list --label needs-decision --fresh` で PBI と その Task を探す（`## 判断待ち` に回答が無いもの。数えるのは止めて待つ実装の判断だけ — 推奨で進める問いにはラベルが無く、運用の確認は Issue に無い）と、PBI の受け入れ条件に `- [ ]` のまま残っている `（利用者確認: …）` の行（利用者の返事が無いまま自分でチェックしない。頼み方と返事の記録は `issue-workflow` の「利用者確認の項目」。同じ節の「判断待ちへの回答で確かめる行」は、名指しした判断待ちが全部回答済みならその決まりでチェックして確認待ちに数えず、未回答・`## 保留` が残る間は待つ）。どちらも無く、1 で在りかの無い行（満たせなかった行を含む）が残っておらず、Task も全部閉じていれば `ops-kit backlog edit <PBI> --state closed`、`ops-kit backlog set <PBI> Status Done`（マージした PR の Task が open のままなら、先に `review-triage-and-merge` の 6 の 1 のとおり閉じる。PR が `Refs #<Task>` の Task は閉じず、Status を `In progress` に戻して、残りの手順を終えてから PBI を閉じる。閉じ忘れた Task で止まらない）。`## 回答` に「違う」の理由があれば、それを直す Task を切る（`pbi-to-tasks`）
5. 元要望 Issue の `## 派生 PBI` の行に Done と書き、派生が全部 Done ならその Issue も閉じる（`ops-kit backlog edit <req> --body-file "$W/req.md" --rev <版> [--state closed]`）。要望の `## 出典` の経路が「公開側 Issue <URL>」なら、派生が全部 Done（か「やらない」）になったとき、公開側の Issue に結果を 3 行（何が変わったか / それを含む公開側の同期の PR か「まだ同期されていない」/ やらないならその理由）書いて閉じる（`gh issue close <URL> --reason completed`。やらないなら `--reason "not planned"`）。Private の Issue の番号・URL・内部の情報は書かない（`request-to-backlog` の「公開側の Issue から」）
6. `<guard> release <PBI> "完了"`（並列ガードを使ったとき。閉じないで終わるときも理由を書いて release する。外さないと次の /pbi-complete が止まる）。PBI の worktree を `git worktree remove`、この PBI で作ったスクラッチ（`mktemp -d` が返した実際のパス）だけを `rm -rf`（`review*` や `<リポジトリ名>.*` の glob は並行している別のセッションのものも消す）。**main の作業ツリーの更新は `ops-kit pull-main`**（CLAUDE.md の有無によらず、どのリポジトリでも同じ既定。pull できなければ何も変えずに理由を 1 行出す: exit 1 = fast-forward できない・未コミットの変更が取り込むファイルと重なる / exit 2 = fetch できない・Git でない。その 1 行を報告の `main:` に書く）。CLAUDE.md が既定を変えている（pull が動いているサービスを再起動するので利用者の OK を取る、など）ならそれに従い、OK 待ちなら走らせない。`ops-kit` が PATH に無い（`command -v ops-kit` が空）ときだけ走らせず「pull していない（キットが PATH に無い）」と書く。動いているコードの更新（昇格・再起動）は CLAUDE.md が書く手順に従い、再起動するなら利用者の OK を取ってから。閉じずに終わった Task の worktree（main の作業ツリーの隣の `<リポジトリ名>-…`）も、全部既定の枝に入って変更が無く古ければアプリが片付ける

## 報告（利用者への返事の型）

```
PBI #<n>「<題>」: Task <k> 件 → PR #a, #b, #c をマージ（main <sha>）
<!-- when reviewer=codex extra=on -->
| Task | PR | レビュー（codex/<extra>） | 修正 / Issue 化 / 対処不要 |
<!-- end when -->
<!-- when reviewer=codex extra=off -->
| Task | PR | レビュー（codex） | 修正 / Issue 化 / 対処不要 |
<!-- end when -->
<!-- when reviewer=claude extra=on -->
| Task | PR | レビュー（claude/<extra>） | 修正 / Issue 化 / 対処不要 |
<!-- end when -->
<!-- when reviewer=claude extra=off -->
| Task | PR | レビュー（claude） | 修正 / Issue 化 / 対処不要 |
<!-- end when -->
受け入れ条件: <満たした n / 全 m>。未達: <行と理由>
確認中: マージの後の行 <n> 件（<種類>）。確認中でなければこの行は書かない
残したもの: #.., #..（Issue 化した指摘）
後回し: #<Task>（<PR #n / Task #n> と <path> が重なる。相手のマージ後に再開）/ #<Task>（<ランナー> の使用上限。<日時> に再開） / なし
main: <pull 済み（pulled <old>..<new>） / up to date / pull していない（コマンドの出力の 1 行、キットが PATH に無い、OK 待ち）>。動いているコードの更新: <済み / Task の会話で確認中 / 不要>
利用者へ: <確認待ちの項目があれば、`issue-workflow` の「利用者確認の項目」の「確認を頼むとき」の形で。「判断待ちへの回答で確かめる行」でチェックした行は出さない>
```

## 途中で止まったとき（再開）

占有を取り直す（並列ガードを使うとき）: `<guard> claim <PBI>`（通らなければ 1 のとおり止まる。止まったセッションの占有が残っていて、利用者が再開を指示したときだけ `--takeover`）。
PBI の worktree が無ければ（全部既定の枝に入って止まった worktree はアプリの片付けで消える。枝は残る）、3 の `git worktree add --detach <PBI の worktree> origin/main` で作り直し、依存の導入も CLAUDE.md の手順に従って済ませてから続ける。
スタックは PBI の worktree の中で `gh stack switch` / `git branch --list`（CLAUDE.md の枝の名前）を確認し、各 PR の状態（`gh pr view --json state,mergeStateStatus`）と Task の Status（`ops-kit backlog view <Task> --fresh`）を読む。
結果コメントの無い Task は「閉じているが未完了」。そこから 4 か 5 を再開する。前の会話の記憶ではなく Issue と PR の記録を正とする。
PBI が（別のセッションで）既に閉じていても、6 の済んでいない項目（元要望、worktree の片付け、main の更新）は自分で済ませてから報告する。「やっていない」と書いて止めない。
