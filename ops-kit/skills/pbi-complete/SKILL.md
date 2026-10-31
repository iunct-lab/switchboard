---
name: pbi-complete
description: PBI 1 件を一気通貫で終わらせるコマンド。/pbi-complete PBI番号 で、Ready を確かめ（でなければ pbi-to-tasks）、Task を優先順に Stacked PR（gh stack）で積み、各 PR を別ランナー（+ 追加のレビュアー）にレビューさせ、指摘を処理し、main に近い方から 1 本ずつマージして GitHub 側の自動 rebase を確認し、PBI の結果節を書いて閉じるまで。PBI を丸ごと任されたとき、スタックの途中で再開するときに読む。
---

# /pbi-complete <PBI番号>

`pbi-to-tasks` → (`task-to-pr` → `cross-runner-review` → `review-triage-and-merge`) × Task 数 → マージ（下から）→ PBI を閉じる。
各工程の中身はそれぞれのスキル。ここは**順番と、工程をまたぐ判断**だけ。

## 0. 前提

- 作業ファイルは `/tmp` 直下に固定の名前で置かない（別のリポジトリのセッションも `/tmp` を使うので、上書き・削除され、別リポジトリの PR 本文やスクリプトが混ざる）。作業ごとに `W=$(mktemp -d /tmp/<リポジトリ名>.<用途>.XXXXXX)` で自分だけのディレクトリを作り、表示されたパスをそのまま使う（Bash の呼び出しをまたぐとシェル変数は消えるので、パスは文字で控える）。消すときもそのパスだけ（glob で消さない）。CLAUDE.md が求めるなら、`gh` の書き込み（issue / pr の作成・コメント・編集・マージ・クローズ）には `-R <owner/name>` を付ける。`-R` を取れない `gh stack` は、作業しているリポジトリの worktree の中でだけ実行する（レビュー用の clone や別リポジトリのディレクトリから実行しない）

- エージェント管理アプリの Task として起動されたなら（見分け方は CLAUDE.md）、main の作業ツリーには触らない（worktree で全部やる）。例外は 6-6 の main の更新だけ
- `gh extension list` に `gh-stack`、GitHub の既存認証で対象 Issue が読める。`gh auth status` が失敗したら、認証切れと決めず `issue-workflow` の「GitHub の接続・認証の切り分け」に従う（接続制限なら許可されたネットワーク実行で再検証し、成功したら続行）
- 枠: ランナーの利用上限の見方は CLAUDE.md。Codex の 5 時間枠が 0.9 以上ならレビューの時刻を計画に入れる

## この依頼が含む範囲

`/pbi-complete`（工程ボタンの「実装する」を含む）は、PBI を閉じるまでの一気通貫の依頼。次は依頼の範囲なので、**そのたびに利用者へ聞き直さない**:

- マージ判定が merge（exit 0）を返した PR のマージ（`[再チェック <kind>]` を印で外したあとの exit 0 を含む）
- リリースタグ、Task の結果コメントと Status、PBI の結果節とクローズ
- cross-runner-review のレビューの材料（fresh clone のコード、PR・Task・PBI、差分）を、別のランナーと CLAUDE.md の追加のレビュアーに渡すこと
- スキルの手順が作る Issue（レビュー指摘の Issue 化、要望 Issue と PBI）とコメント
- 利用者が既に認めた範囲（代替レビュー、材料の共有、`[merge-answer] yes`）を、同じ範囲で繰り返すこと

次は範囲に含まれない（運用の確認か実装の判断として聞く。`issue-workflow` の「判断待ちの出し方」）:

- `[聞く]` の large、マージ判定が直せない stop、exit 2
- 昇格・デーモンを再起動する `git pull`
- 認証・ログイン
- お金・他 OS・破壊的操作

**実行環境の承認（ランナーの自動承認レビューを含む）に操作を拒まれたとき**: 迂回しない（権限モードの変更、API の直接呼び出しなど別の経路で同じ操作を実行しない）。承認を求めるときの理由の欄に、元の依頼の文・今の工程（例: `pbi-complete` の 5）・マージ判定の出力（`verdict` / `impact` / `reasons`）・既存の許可（上の範囲、依頼の文の範囲（レビューの材料の共有など）、`[merge-answer] yes` など）を添えて、**1 回だけ**申請し直す。それでも拒まれたら、運用の確認として Task の会話で止める。

## 並列で動かす（別の PBI を同時に）

/pbi-complete は PBI ごとに別のセッションで同時に走らせてよい。ただし CLAUDE.md が並列ガードのコマンドを名指ししているときだけ（以下 `<guard>` と書く）。無ければ PBI は 1 セッションずつ進める。待たずに並べるための決まり:

- **1 PBI = 1 セッション = 1 worktree**（場所と名前は CLAUDE.md の worktree の規則。PBI 番号を入れる）。`gh stack` の状態は worktree ごと（`.git/worktrees/<名前>/gh-stack`）なので、スタック同士は干渉しない。他のセッションの worktree・枝・スクラッチには触らない（`git worktree list` に出ても消さない）
- **同じ PBI は 1 セッションだけ**: 1 の最初に `<guard> claim <PBI>`。PBI に占有コメントを書き、release 後の最初の占有が勝つ（同時に書いたら後の方が自分のコメントを消して exit 1）
- **同じファイルは同時に触らない**: Task に着手する前に `<guard> overlap <Task>`。Task 本文に名指ししたパスを、他のセッションの Draft・`needs-decision` を除く開いている PR の変更ファイルと、判断待ちを除く In progress の Task が名指ししたパスと突き合わせる（自分の PBI の Task と PR は除く）。In progress にした後の `--claimed` は Task に着手の印コメントを書き、同じファイルの In progress の Task のうち**先に印を書いた方**だけが進む（印を書く前に見落とした相手も、後から印を書く側が譲るので二重にならない）。Draft は単独では占有しないが、その実装を進めている In progress Task は占有する。先着の印は同時編集の衝突防止だけであり、作成順・古い PR の存在を優先度の根拠にしない。保留した PR を他の作業のためにマージ・クローズする必要はない。重なったら**その Task だけ後回しにして、重ならない次の Task を進める**（3 の「重なったとき」）。`STALE_HOURS`（72 時間）更新の無い PR / Task は `stale` に出るだけで止めない
- exit 2（判定できなかった）は重なりありとみなす。Task にパスが無いなら `pbi-to-tasks` の書き方で Task 本文を直してからやり直す

## 1. Ready を確かめる

```bash
<guard> claim <PBI>     # exit 1 = 別のセッションが実行中。何も触らずに止め、報告する
gh issue view <PBI> --json title,body,labels
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ subIssues(first:50){ nodes{ number title state } } } } }' -F o=<owner> -F r=<repo> -F n=<PBI> \
  -q '.data.repository.issue.subIssues.nodes[] | "\(.number)\t\(.state)\t\(.title)"'
bash scripts/setup/lint_backlog.sh
# BACKLOG_URL があれば（issue-workflow の「操作」）: gh と scripts/setup/ の代わりに
#   ops-kit backlog view <PBI> --fresh    # 本文。sub-issue は --json の .issue.subIssues
#   ops-kit lint --fresh
```

`<owner>` / `<repo>` は `gh repo view --json owner,name -q '"\(.owner.login) \(.name)"'` で見る。claim が exit 1 なら、占有コメントの日時と worktree を報告して終わる（同じ PBI を二重に進めない）。利用者が「再開」と言ったとき（前のセッションが止まった）だけ `claim <PBI> --takeover`。
Task が無い・受け入れ条件が覆われていない・lint 違反 → `pbi-to-tasks` を先にやる。PBI の Status が Ready でなければ Ready にしてから。
PBI の `## 元要望` の原文を読み、PBI の解釈が原文からずれていないか一度確かめる。

## 2. 順番を決める

1. Task 本文の `**前提**: #N, #M（リリース）` の 1 行（`<guard> overlap` が `prereqs` に出す）で依存順。同じ PBI の Task が前提ならスタックの順番にする
2. 同順位は Project の Priority（P0 → P3）、次に PBI の `## Tasks` に書いた着手順
3. 「利用者に確認して止める」がある Task は、その工程が最後になるように後ろへ（他を止めない）

PBI の決定ログに「YYYY-MM-DD: /pbi-complete 開始。順番: #a → #b → #c。枠: …」。PBI の Status を In progress。

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
bash scripts/setup/set_project_field.sh <Task> Status "In progress"     # BACKLOG_URL があれば ops-kit backlog set <Task> Status "In progress"
<guard> overlap <Task> --claimed  # 着手の印を書いて相手の印と比べる。後から書いた方が譲る（譲るときは印を消す。GitHub 連携の無い workspace では取り下げの印を書く）
<guard> release <PBI> <理由> [--waits n,n | --overlap-waits n,n]   # 占有を外す。--waits は待っている相手（PR / Issue の番号）。後回しで止まるときだけ
```

`overlap` は Task と親 PBI の本文の `**前提**:` も判定する（`prereqs: [{ ref, state, sibling }]`。`state` はデーモンの判定と同じ: met / pending / withdrawn / missing / unknown。ただしマージ済みの PR の `（リリース）` は met。`sibling` = 同じ PBI の Task で、スタックで積むので待たない）。自由文の「前提: #K が Done」は読まれない。

**前提が未完のとき**（verdict `wait`）: 下の「重なったとき」の 1〜2 と同じく後回しにして、独立した Task を積む。全部の Task が `wait` か、残りがそれを前提にしていれば `<guard> release <PBI> "後回し: #<Task>（前提 #N が未完）" --waits <N>`（`N` は `prereqs` の `state: pending` の番号）で止める。前提が閉じれば定期実行が再開する。待つのは定期実行（backlog-next）なので、止まるときの停止の記録は `waiting` で残さず、引き渡した印（`reason` は `depends` のまま、`state` は `resolved`、`evidence` は「backlog-next の前提待ちに引き渡した: #N」）で書いてターンを終える（引き渡した待ちを Task の停止として積まない。#2149）。
**前提を人が直すとき**（verdict `stop`: 取り下げ = 未マージで閉じた PR・not planned の Issue / missing = 見つからない / unknown = Issue に `（リリース）` を付けた）: その Task は始めない。`## 判断待ち` は出さず、理由を release の文に書いて（`<guard> release <PBI> "止めた: #<Task> の前提 #N が取り下げ"`。`--waits` は付けない）報告の「利用者へ」に書く。直すのは利用者（本文の前提を書き換える・前提を閉じ直す）。マージ済みの PR の `（リリース）` はガードでは成立として進む（動いている版に入ったかはデーモンが判定し、入るまで定期実行はその PBI を始めない）

**重なったとき**（verdict `defer`）: 待たない。
1. In progress にしていたら Backlog に戻し、Task に「後回し: <PR #n / Task #n> と <path> が重なる」とコメントする
2. その Task と、それを `**前提**:` に書いている Task を順番の最後へ回し、残りから重ならない Task を次に積む（PBI の決定ログに順番の変更を 1 行）
3. 後回しの Task は、他の Task を 5 までマージし終えてから `overlap` をやり直す。exit 0 なら `git fetch origin && git checkout --detach origin/main` から新しいスタックとして積む（相手の変更が入った main の上に作る。古いスタックの上に積まない）
4. まだ重なっていれば PBI は閉じない。`<guard> release <PBI> "後回し: #<Task>（<相手> と重なる）" --overlap-waits <相手の番号>` で占有を外し、報告の「利用者へ」に書いて終わる。`--overlap-waits` は `overlap` の出力の `blocking[].ref` の番号（`PR #778` → `778`、`Task #603` → `603`。複数ならカンマで）。相手が全部閉じるか、待っている PR が Draft・`needs-decision`、または重複相手の Task が `needs-decision` になって占有対象から外れたら、定期実行（バックログを進める）が次の発火でこの PBI を再開する（#817）。手で再開するなら /pbi-complete <PBI>
5. 前提（`**前提**:` の番号）がほかの PBI のもので、未完のまま進めずに止まるときも同じく `<guard> release <PBI> "後回し: #<Task>（前提 #N が未完）" --waits <N>` で止め、停止の記録は引き渡した印（「前提が未完のとき」）

`--overlap-waits` はファイル重複待ち、`--waits` は未完の前提待ちとして区別する。前提 Task が判断待ちになっても、完了するまでは進めない。古い `waits=` の Task 待ちは種類が不明なので前提として扱い、手で再開して overlap を再確認する。

後回し以外で止まるとき（完了・返事待ち・判断待ち）の release には `--waits` を付けない — 待ちの無い release が前の待ちを打ち消す（新しい claim も同じ）。

重ならなければ `task-to-pr` の全部（着手コメント → 実装 → テスト / E2E → commit → `gh stack submit --auto --open` → `gh pr edit` → In review）。
**次の Task に進む前に、その PR のレビューを起動しておく**（`cross-runner-review`。Bash の background で走らせ、次の実装と並行）。

Task の途中で設計が変わった（Task に書いた場所では足りない、受け入れ条件が満たせない）ら、その Task と PBI の決定ログに書いてから続ける。
利用者の判断が要る箇所は `issue-workflow` の「判断待ちの出し方」で種類を分けて止める: 実装の判断（要件の読み・設計の選択・受け入れ条件の変更）は Issue に `## 判断待ち`（ラベル `needs-decision`）、運用の確認（マージ・昇格・認証・実行のタイミング）は Issue に書かず Task の会話で聞いてターンを終える（下の 5）。実装の判断の返事が来ないとき、**要件の解釈**が絡む Task は実装せず飛ばして次の Task へ（PBI は閉じない）。お金 / 他 OS / 破壊的操作だけは安全側（既定 off / 何も消費しない）で実装して進む（`task-to-pr` 1-2）。

作業の途中で GitHub の認証が必要だと判断する前にも、`issue-workflow` の「GitHub の接続・認証の切り分け」を行う。接続制限だけで認証の運用確認に進まない。

## 4. レビューを処理する（PR ごと）

`review-triage-and-merge` の 1〜4。**修正は指摘のある枝で** commit → `gh stack rebase`（その枝から上を cascade）→ `gh stack push`。
下の枝を直したあと上の枝のテストも走らせる（スタックの一番上で、CLAUDE.md のテストのコマンド）。

全 PR の指摘が処理され、CI が緑になるまで**マージしない**（途中で下だけ入れると、上の PR の指摘対応で main を汚す）。
Actions が始まらないリポジトリのローカル CI（CLAUDE.md のコマンド。以下 `<ローカル CI>`）は、全部の PR の指摘の処理が済んでから、スタックの一番上の PR で 1 回だけ回す。差分が変わったら（修正コミット、手で解いたコンフリクト）一番上でもう 1 回。いつ回し、マージ判定がどう数えるかは CLAUDE.md が名指しするマージ判定の規則（ローカル CI を回す時と数え方）。

## 5. マージ（main に近い方から 1 本ずつ）

**各 PR のマージ直前にマージ判定**（CLAUDE.md が名指しするコマンド。以下 `<マージ判定>`。無ければ `review-triage-and-merge` の 5 のチェックリストを自分で確かめる）。exit 1（stop）なら:
- large の理由が `[再チェック <kind>]` だけ（`[聞く]` が無い。マージ判定が large の理由をこの 2 つに分ける仕組みのとき）→ **利用者に聞かずに**、出力の `recheck` の種類ごとに再チェック（CLAUDE.md が名指しする手順。以下 `<再チェック>`）を回す。通れば印を投稿し、マージ判定をもう一度通してマージする。再チェックでマージしたら PBI の決定ログに 1 行「YYYY-MM-DD: 自動マージ: PR #n（<種類>、再チェック合格）、戻すなら <tag>」（`<tag>` は CI を通ったタグの中の最新。見方は `<再チェック>`）。通らなければ指摘を直して（`review-triage-and-merge` の 2〜4）回し直す。別のランナーが使用上限なら `<再チェック>` の代わりの回し方（CLAUDE.md が名指しする手順にあれば）で回す。直せない・代わりの回し方も無く待てないときだけ、下の `[聞く]` と同じく運用の確認で聞く。CI など large 以外の理由が一緒に出ていれば、それは次の「それ以外の理由」と同じく先に片づける
- `[聞く]` の理由がある（セキュリティ・`rescue/**`・README の Design rules。分けない仕組みなら impact が large の理由すべて）で、それ以外の理由が無い → 運用の確認として Task の会話で聞いてターンを終える（`issue-workflow` の「判断待ちの出し方」の「運用の確認」。確認「PR #n をマージしてよいか」、PR の番号と `+add/-del`、推奨。Issue に `## 判断待ち` を出さない）。`reasons` は分類の見出しで分けてそのまま貼る: `**セキュリティ**:`（「[聞く] セキュリティ:」。認証・秘密・CI・依存）/ `**rescue**:`（「[聞く] rescue:」。戻す仕組みそのもの）/ `**Design rules**:`（「[聞く] 責務: README.md の ## Design rules」）/ `**再チェックの残り**:`（まだ印の無い `[再チェック …]`。聞く間に再チェックも回しておくと、返事の後にそれを待たない）。当たらない分類の見出しは書かない。聞く直前に記録の印 `[merge-ask] <kinds> <head sha>` を PR に投稿する（`<kinds>` はマージ判定の出力の `ask` と残った `recheck` を `,` でつなぐ。投稿の形は CLAUDE.md が名指しするマージ判定の規則の「記録の印」。上の再チェックの分岐から聞くときも同じ）
- それ以外の理由（CI、未解決のスレッド、見直されていないコミット、CLEAN でない、Task の名指しの外のファイル）→ 自分で直す（CI を待つ / 返信して resolve / `cross-runner-review` の 4 で見直し）。「Task の本文に名指しの無いファイル」は、`（Task #k が名指し）` が付いていればその Task の枝へ移し、付いていなければ Task の本文に逸脱として名指しを足す（`issue-workflow` の「記録の義務」。本文を直したら `ops-kit backlog view <Task> --fresh` で GitHub に送ってから判定し直す）。CI が**始まらずに**失敗している（請求の問題。ジョブのステップ 0 件）なら待たずローカル CI（CLAUDE.md のコマンド。`review-triage-and-merge` の「CI 緑」）。主レビュアーが使用上限なら見直しも実装したランナーの新しいセッションで代替（`cross-runner-review` の 0）。直せなければ同じく運用の確認として Task の会話で聞く
- exit 2（判定できなかった）はマージしない（止めた理由を Task の会話に書いてターンを終える）

止めるときは `<guard> release <PBI> "返事待ち: <確認の 1 文>"`（並列ガードを使うとき）。返信を受けて再開するときは `<guard> claim <PBI>` からやり直し、**必ずマージ判定をもう一度通す**。`[merge-ask]` を付けて聞いた PR への返信なら、マージ判定の前に `[merge-answer] <yes|no> <聞いたときと同じ kinds> <head sha>` を PR に投稿する（記録の印。CI など large 以外の理由で聞いたときは `[merge-ask]` も `[merge-answer]` も付けない）。`[merge-ask]` を付けずに聞いていた（印の手順より前に始めた会話、Task の会話以外の経路で認められた、付け忘れ）なら、`[merge-answer]` の前に `[merge-ask] <kinds> <head sha>` を投稿してから付ける（`<kinds>` はマージ判定の出力の `ask` と印の無い `recheck`。印の時刻はどちらも付けた時刻で、聞いた時刻には遡れない — その PR の「返事まで」は短く出る。それでよい。#1069）。返信が大きい変更のマージを認めた（`yes`）ときだけ、`[merge-answer] yes` を投稿した**後で** `--allow-large` を付ける（印を付けずに `--allow-large` でマージしない。`[聞く]` も `[再チェック]` も外れる。CI・未解決のスレッド・見直されていないコミット・CLEAN でないこと・Task の名指しの外のファイルは、返信があっても外れない）。再チェックの印は head ごとなので、下の PR のマージ後の自動 rebase で head が変わったら出し直す（`<再チェック>`）。

マージは `<マージ判定> <PR> --merge-stack`（スタックの最下段）/ `--merge`（単発）で、判定が merge のときだけマージまで進む（判定とマージが 1 つのコマンドなので、Task の許可に入る。`--allow-large` と一緒なら head の `[merge-answer] yes` が無ければマージしない）。マージ判定のコマンドに `--merge` / `--merge-stack` が無いリポジトリ（CLAUDE.md がマージ判定を名指ししない、またはその引数が無い）では、`<マージ判定> <PR> && gh stack merge <PR> --rebase -y`、単発は `gh pr merge <n> --rebase --delete-branch` にする。

```bash
<マージ判定> <一番下の PR> --merge-stack
# GitHub の Stacked PR が次の PR を main に retarget して rebase する。これを待つ:
until gh pr view <次> --json baseRefName,mergeStateStatus -q '"\(.baseRefName) \(.mergeStateStatus)"' | grep -qE '^main (CLEAN|UNSTABLE)$'; do
  gh pr view <次> --json baseRefName,mergeable,mergeStateStatus -q '"\(.baseRefName) \(.mergeable) \(.mergeStateStatus)"'; sleep 30; done
# 自動 rebase で head の sha が変わっても、差分が同じなら一番上のローカル CI の合格のまま数える（回し直さない）
<マージ判定> <次> --merge-stack
```

- **UNSTABLE** = CI が走っている（マージ判定が「未完了」で止めるので、待ってやり直す）か、CI が始まらずに失敗している（4 のローカル CI。一番上の合格がこの PR の差分を含めばマージ判定は UNSTABLE のまま通す）
- **CONFLICTING / DIRTY** = 自動 rebase が解けなかった。**このときだけ**ローカルで直す: `git fetch && git checkout <次の枝> && git rebase origin/main` → 解消 → テスト → `git push --force-with-lease`。直したら CLEAN を待って再開
- 中身が空になった PR は GitHub が merged 扱いにする（下の PR に取り込まれたとき）。空の PR を残さない
- スタックに属さない単発は `<マージ判定> <n> --merge`（`gh stack merge` は "not a stacked pull request" で失敗する）

マージのたびに `review-triage-and-merge` の 6（結果コメント、Status Done、復活ファイルの確認）。**全 PR を一度に `gh stack merge <top>` しない**（コンフリクトが隠れる。利用者の指示）。

## 6. PBI を閉じる

1. 受け入れ条件の各行を `- [x]` にし、行末に検証結果（テスト名 / コマンドと出力 / 画面で見た事実）。満たせなかった行は `- [ ]` のまま理由。`（利用者確認: …）` の行は除く（自分でチェックしない。4 を見る）
2. `## 結果`: 受け入れ条件ごとの検証、レビュー件数、Story Points の妥当性、残したもの（Issue 番号）
3. 認証の値の後からの検査（`ops-kit scan-issues`）は PBI を閉じるたびには走らせない（エージェント管理アプリの毎日の予定が前回からの差分を読む。`issue-workflow` の「Issue・PR・コメントに書かない値」の「後からの検査」）
4. 利用者の確認待ちの項目があれば Status は In review のまま open。確認待ちは `gh issue list --label needs-decision --state open` で PBI と その Task を探す（`## 判断待ち` を出したのに回答が無いもの。数えるのは実装の判断だけ。運用の確認は Issue に無く、Task の会話で聞いて返事を受けてから進んでいる）と、PBI の受け入れ条件に `- [ ]` のまま残っている `（利用者確認: …）` の行（`issue-workflow` の「利用者確認の項目」。この行は自分でチェックしない。利用者が「確認した」と答えると付く）。どちらも無く Task も全部閉じていれば `gh issue close <PBI>`、Status Done（`BACKLOG_URL` がある（アプリの Task の中）なら `ops-kit backlog edit <PBI> --state closed`。GitHub 連携の無い workspace（`BACKLOG_WORKSPACE` がある）では `ops-kit backlog edit <PBI> --state closed`。Task は PR の `Closes` で自動では閉じないので、マージした PR の Task が open のままなら先に `ops-kit backlog edit <Task> --state closed` で閉じる（`review-triage-and-merge` の 6）。閉じ忘れた Task で止まらない）。`## 回答` に「違う」の理由があれば、それを直す Task を切る（`pbi-to-tasks`）
5. Milestone の説明を更新（残り / やらない）。元要望 Issue の `## 派生 PBI` の行に Done と書き、派生が全部 Done ならその Issue も閉じる。要望の `## 出典` の経路が「公開側 Issue <URL>」なら、派生が全部 Done（か「やらない」）になったとき、公開側の Issue に結果を 3 行（何が変わったか / それを含む公開側の同期の PR か「まだ同期されていない」/ やらないならその理由）書いて閉じる（`gh issue close <URL> --reason completed`。やらないなら `--reason "not planned"`）。Private の Issue の番号・URL・内部の情報は書かない（`request-to-backlog` の「公開側の Issue から」）
6. `<guard> release <PBI> "完了"`（並列ガードを使ったとき。閉じないで終わるときも理由を書いて release する。外さないと次の /pbi-complete が止まる）。PBI の worktree を `git worktree remove`、この PBI で作ったスクラッチ（`mktemp -d` が返した実際のパス）だけを `rm -rf`（`/tmp/review*` や `/tmp/<リポジトリ名>.*` の glob は並行している別のセッションのものも消す）。**main の作業ツリーの更新は `ops-kit pull-main`**（CLAUDE.md の有無によらず、どのリポジトリでも同じ既定。fast-forward でき、未コミットの変更が取り込むファイルと重ならなければ pull し、でなければ何も変えずに理由を 1 行出して exit 1。fetch できない・Git でないは exit 2）。CLAUDE.md が既定を変えている（pull が動いているサービスを再起動するので利用者の OK を取る、など）ならそれに従い、OK 待ちなら走らせない。exit 1 / 2 なら出力の 1 行を報告の `main:` に書く。`ops-kit` が PATH に無い（`command -v ops-kit` が空）ときだけ走らせず「pull していない（キットが PATH に無い）」と書く。動いているコードの更新（昇格・再起動）は CLAUDE.md が書く手順に従い、再起動するなら利用者の OK を取ってから

## 報告（利用者への返事の型）

```
PBI #<n>「<題>」: Task <k> 件 → PR #a, #b, #c を下から順にマージ（main <sha>）
| Task | PR | レビュー（codex/<extra>） | 修正 / Issue 化 / 対処不要 |
受け入れ条件: <満たした n / 全 m>。未達: <行と理由>
残したもの: #.., #..（Issue 化した指摘）
後回し: #<Task>（<PR #n / Task #n> と <path> が重なる。相手のマージ後に再開） / なし
main: <pull 済み（pulled <old>..<new>） / up to date / pull していない（コマンドの出力の 1 行、キットが PATH に無い、OK 待ち）>。動いているコードの更新: <済み / Task の会話で確認中 / 不要>
利用者へ: <確認待ちの項目があれば>
```

## 途中で止まったとき（再開）

占有を取り直す（並列ガードを使うとき）: `<guard> claim <PBI>`（前のセッションが release していれば通る。止まったセッションの占有が残っていて、利用者が再開を指示したときだけ `--takeover`）。
スタックは PBI の worktree の中で `gh stack switch` / `git branch --list`（CLAUDE.md の枝の名前）を確認し、各 PR の状態（`gh pr view --json state,mergeStateStatus`）と Task の Status（Project）を読む。
結果コメントの無い Task は「閉じているが未完了」。そこから 4 か 5 を再開する。前の会話の記憶ではなく Issue と PR の記録を正とする。
PBI が（別のセッションで）既に閉じていても、6 の済んでいない項目（Milestone・元要望、worktree の片付け、main の更新）は自分で済ませてから報告する。「やっていない」と書いて止めない。
