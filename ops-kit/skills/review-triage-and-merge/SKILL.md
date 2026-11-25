---
name: review-triage-and-merge
description: PR に付いたレビュー（複数レビュアー）の指摘を 1 件ずつ「修正 / Issue 化 / 対処不要」に振り分け、修正して返信し、要約に件数表を書き、マージ可否を判断してマージし、Issue に結果を残すまでの型。レビューコメントが出そろったとき、マージするか迷ったときに読む。前は cross-runner-review、スタックの流れ全体は pbi-complete。
---

# Review triage → merge

目的: 指摘を**全部**処理してからマージする。処理は **修正** / **Issue 化** / **対処不要** の 3 種類だけで、どれにも振っていない指摘が残る PR はマージしない。

## 1. 集める

```bash
N=<PR番号>
gh api "repos/{owner}/{repo}/pulls/$N/comments" --paginate | jq -r '.[] | "\(.id)\t\(.path):\(.line // .original_line)\t\(.body | split("\n")[0] | .[0:100])"'   # 一覧。採否は全文を読む
gh api "repos/{owner}/{repo}/pulls/$N/comments/<id>" -q .body   # 全文
gh api "repos/{owner}/{repo}/pulls/$N/reviews"  --paginate | jq -r '.[] | select(.body != "") | "---- review \(.id) \(.user.login)\n\(.body)"'   # review 本文は全文（切ると 2 件目以降を見落とす）
gh pr view $N --comments --json comments -q '.comments[] | "---- \(.author.login)\n\(.body)"'   # 要約コメント（[<名前>] review）も全文
```

攻める側のレビュー（`[<runner>] attack`。`cross-runner-review` の 2b）の指摘も、1〜4 で主レビューと同じに処理する。

複数のレビュアーの同じ指摘は 1 件にまとめ、返信に「[<レビュアー A>] と [<レビュアー B>] の同じ指摘」と書く。

**ローカルの変更では**（4 の同名の段落と同じ workspace）: 上の `gh api` と `gh pr view` は呼ばない。指摘の一覧は変更へのコメント（`ops-kit backlog view <変更> --fresh` の末尾のコメント。レビュアーごとの要約（`[<名前>] review`）とサブエージェントの要約も全文）を読む。

## 2. 振り分ける

| 振り分け | いつ | やること |
|---|---|---|
| **修正** | blocker。should-fix で Task の範囲内。non-blocking（nit・question）は採るかを実装者が決める（直す nit は同じ修正コミットに入る 1 行程度だけ） | 前の回に直した論点にまた付いた blocker / should-fix（行末の `Repeat of:` か自分の読み）は、直す前に 3 の「同じ論点が続いたら」。ほかはこの枝で直す。回帰テストを先に書き、修正前に fail することを見る。指摘の行に `Test: _review/tests/<file>` があれば先にそれを、レビューの clone（`cross-runner-review` の 1 の `$R`）から worktree のテストの置き場へ写して（相対 import は直す）走らせ、修正前に落ちるのを見る（`_review/` の下に写さない。写した先が残す回帰テストになる）。書く前に `task-to-pr` の「足す前に」を通す（既存のテストに条件を足す・軽い階層を先に。回帰テストは要る） |
| **Issue 化** | 正しいが Task の範囲外（別の受け入れ条件、別の場所、リファクタ、将来の改善）。同じ PBI なら Task、別の価値なら PBI（`request-to-backlog` の粒度で。元要望は「なし（PR #N のレビュー）」） | Issue を作り（`ops-kit backlog create`。Task なら `--parent <PBI>`）、返信に番号。PBI の決定ログにも 1 行（`ops-kit backlog edit <PBI> --body-file …`）。既にある次の Task に回すなら、その Task の本文（手順か「守る条件」の行）に足してから（`ops-kit backlog edit <Task> --body-file …`。`task-to-pr` の 3 の「見つけた穴」）、返信に Task の番号と「本文に足した」を書く（PR 本文にだけ書いた穴は、受け取る Task に届かない） |
| **対処不要** | 観点がずれている: 設計原則（設計ルール。場所は CLAUDE.md）や PBI の決定ログ・スコープ外に反する提案、互換層・一度しか使わない抽象・念のための切り替えの設定の追加（環境・運用で変わる値の上書きの口は除く。`pbi-to-tasks` の設計チェック）、レビュアーの誤読、実行環境の上で検証できない懸念。採らないと決めた non-blocking | 返信に**根拠**（ファイル・Issue・doc の名指し）。「意図的です」だけは不可。non-blocking の見送りは要約の「見送った nit・question」の表に 1 行（指摘と理由）で足りる |

採る question は事実で答える（「分からない」なら調べてから）。**レビュアーが正しくて自分の修正が間違いのこともある**。自分の変更を守らず、より小さく安全な直し方があればそちらに切り替える。

優先度: blocker → should-fix → question → nit。blocker が「対処不要」になるのは誤読のときだけで、必ず根拠を書く。

### 収束しないとき（main との比較）

きっかけ（どちらかが当たれば回す。数は決めた値で設定にしない。変えるならこの文を直す）:

- 4 の修正後の見直しを 2 回回しても blocker / should-fix が残る PR
- 差分が 500 行（`task-to-pr` の Task の粒度の上限）を超える PR は、1 回目のレビューの後

`cross-runner-review` の 5 を回す（主レビュアーが残る指摘を 1 件ずつ main と読み比べて分類する。比較の転記は主レビューに数えない）。`ops-kit review-compare check` が exit 1 なら後退がある。分類で振り分ける:

- `REGRESSION`: 「修正」（3 のまま。直して返信し、見直しは `cross-runner-review` の 4。`$M/compared.md` が材料に入るので、後退が閉じたか・ほかの分類の行を挙げ直さないかは見直しが読む）
- ほかの分類（`NEW-FEATURE-GAP` / `IMPROVED-BUT-INCOMPLETE` / `SAME` / `OWNER-DECIDED`）: 後退でないので、触る場所の領域ごとに要望 Issue にして「Issue 化」で返信する

```bash
W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.triage<PR番号>.XXXXXX"); echo "$W"   # 新しいシェルなら。表示されたパスを控える
ops-kit review-compare leftovers "$M/compared.md" --source "PR #$N の [<runner>] compare" --out "$W/leftovers"   # 後退以外が無ければ何も書かない
# 領域ごとに $W/leftovers/<n>.md（本文）と titles.tsv（<n> と題）ができる。本文ごとに:
ops-kit backlog create --title "<titles.tsv の題>" --label type:request --body-file "$W/leftovers/<n>.md"   # 出る番号が要望
ops-kit backlog set <要望の番号> Status Backlog
```

各指摘のスレッドに `Issue 化: #<要望>（main と比べて後退でない: <分類>）` で返信して resolve する（4）。この返信は 4 の「Issue 化」の返信と同じ扱いで、5 の「全指摘が…返信済み」に数える。

## 3. 直す

### 同じ論点が続いたら（直す前に）

きっかけ: 修正後の見直しか再チェックで、前の回に直した指摘と**同じ論点**に blocker / should-fix がまた付いた（レビュアーの `Repeat of:` か、自分の読み）。同じ論点 = 同じ守る条件か、同じ方針（失敗時の扱い・値の意味・状態の持ち方）。場所や文が違っても、直す対象の判断が同じなら同じ論点。
例: 失敗時の扱いを「届かなかった失敗だけ分ける」と直した次の回に、分け方の漏れ（途中で切れた・タイムアウト）が付く → 同じ論点。同じファイルの別の入口に古い前提の穴が見つかる → 別の論点（1 件ずつ直す。回数では止めない）。

次の修正を積まずに、この順で方針を決め直す:

1. 似た既存の仕組みを探し、同じ形にできるならそうする（`pbi-to-tasks` の 2 の「あるなら同じ形で作る」を修正にも使う）
2. 方針を 1 文で PBI の決定ログに書く（日付つき。PBI の無い PR は PR 本文の「逸脱」）
3. 方針が要件の読みか、安全と使い勝手の優先なら、`issue-workflow` の「判断待ちの出し方」で `## 判断待ち` を出して止める
4. Task の手順を方針に合わせて直す（`ops-kit backlog edit <Task>`）。それから修正を 1 コミットで積む

### 修正する

```bash
cd <その Task の worktree>; git checkout <その Task の枝>   # 場所と名前は CLAUDE.md の worktree と枝の規則
# 回帰テスト → fail を確認 → 修正 → pass。テストのコマンド（1 件 / 型検査 / `<関係するテスト>`。`task-to-pr` の 4）は CLAUDE.md
git commit -am "fix(<area>): review follow-ups for #<PR> — <何を>"   # amend・fixup/autosquash・squash で既存のコミットに混ぜない（どれも author date を保つのでマージ判定が見直しの要否を判定できない）
gh stack rebase && gh stack push   # 下の枝を直したら上に cascade（stacked-pr-delivery）。単発なら git push
```

見直しを頼む前に、修正した指摘ごとに、指摘の `Scenario:`（入力・状態）を再現して直ったことを確かめる。テストで書ける指摘は、2 の表の「修正」の行の回帰テスト（修正前に fail を見たもの）が pass すること。テストで書けない指摘（文書・手順・PR 本文）は、Scenario の入力・状態を再現したコマンドと出力か、直した行の `path:line` を読み直した結果。再現して直っていなければ、見直しを頼まずに直し続ける。

修正が値・記録・状態の意味や鍵を変えたら（例: 履歴に残す識別子を別の形にする、値を空にしうる型にする）、変えた名前で読み手を挙げ（`ops-kit old-paths list <前回レビューした head> <語>…`）、1 つずつ新しい意味で成り立つかを確かめる。挙げた行と結果は PR 本文の「古い前提を持つ既存の箇所」に足し、返信に「読み手: <n> か所、<結果>」を書く。変えていなければ「読み手: 変わらない」。

修正が Task の手順・受け入れ条件から外れたら（別の直し方にした、範囲を広げた・削った）、見直しの前に PR 本文の「逸脱」の項（`task-to-pr` の「レビュアーへ」）と Task のコメント（`ops-kit backlog comment <Task>`）を更新し、PBI の決定ログ（`ops-kit backlog edit <PBI>`）に日付つきで 1 行書く。

修正を push するたびに（ローカルの変更ではコミットするたびに）、見直しの前に PR 本文を今の実装に合わせる（概要・レビュアーへ・テスト観点のうち修正で変わったもの。squash でマージするリポジトリではこれがマージのメッセージになる）: `gh pr view $N --json body -q .body > "$W/pr.md"` → 直す → `gh pr edit $N --body-file "$W/pr.md"`（`W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.triage<PR番号>.XXXXXX")`。4 の要約にも使う）。ローカルの変更では `ops-kit backlog view <変更> --json | jq -r .issue.body > "$W/pr.md"` → `ops-kit backlog edit <変更> --body-file "$W/pr.md"`（`gh pr view` は呼ばない）。それから `cross-runner-review` の 4（修正後の見直し）を回す。

**1 回のレビューの修正は 1 コミットにまとめてから見直しを頼む**。nit ごとにコミットすると、コミットごとに新しい見直しが次の端のケースを見つけ、収束しない。直す範囲は 2 の表のとおり（nit は 1 行程度だけ）。直し方は、端のケースを広げる推測より、限界を書いた保守的な規則を選ぶ。文書に「〜だけ」「全部」のような網羅の主張を書かない。

修正のたびに head（`gh pr view $N --json headRefOid`）が進む。インラインコメントは古い commit に紐づくが返信はできる。ローカルの変更では、今の head は `ops-kit backlog view <変更>` の `変更:` の行に出る。

## 4. 返信する

blocker / should-fix と、採った nit・question は **1 コメント 1 返信**。**見送る nit・question**（対処不要・記録）は 1 件ずつ返信せず、要約コメントの表に根拠を並べ、要約を投稿してからスレッドを resolve する（返信と要約は次の回に `handled.md` で渡る。レビュアーはコードで確かめ直す）。返信の型:

```
修正: <何をどう直したか> — <commit sha 短縮>。確かめた方法: <回帰テスト名（追加先: 既存 / 単体 / 新規）か、Scenario を再現したコマンドと結果>。読み手: <変わらない / n か所と結果>
Issue 化: #<n>（<なぜこの PR の外か>）
Issue 化: #<要望>（main と比べて後退でない: <分類>）   ← 「収束しないとき（main との比較）」の返信。上の Issue 化と同じ扱い
対処不要: <根拠>。<ファイル / Issue / doc>
回答: <事実>
```

```bash
gh api "repos/{owner}/{repo}/pulls/$N/comments/<id>/replies" -f body="..."
# 返信したスレッドは resolve する（マージ判定は未解決のスレッドがある PR を止める）。resolve は「返信した」印（片づいたかは修正後の見直しが見る）。返信の前（見送る nit・question は要約の投稿の前）に resolve しない
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ nodes{ id isResolved comments(first:1){ nodes{ databaseId } } } } } } }' -F o=<owner> -F r=<repo> -F n=$N \
  -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not) | "\(.id)\t\(.comments.nodes[0].databaseId)"'
ops-kit pr resolve-thread <thread id>...   # resolve だけをするコマンド（Task の許可に入る。素の gh api graphql の mutation は使わない）
gh pr comment $N --body-file "$W/summary.md"   # W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.triage<PR番号>.XXXXXX")。固定の /tmp/summary.md にしない
# <owner> / <repo> は gh repo view --json owner,name で見る。{owner}/{repo} は gh api が今のリポジトリで埋める
```

要約コメント（`$W/summary.md`。1 行目は必ず `## レビュー対応` — `ops-kit review-handled` がこの見出しで拾う）:

```markdown
## レビュー対応
| レビュアー | 件数 | 修正 | Issue 化 | 対処不要 | 回答 |
| <主レビュアーの名前> | .. | .. | .. | .. | .. |
<!-- when extra=on -->
| <extra> | .. | .. | .. | .. | .. |
<!-- end when -->
主な修正: <1〜3 行>  Issue 化: #.., #..  対処不要の根拠: <1〜2 行>
| 見送った nit・question（[レビュアー] `path:line` と 1 文の引用） | 根拠 |
| .. | .. |
テスト: <回したテストの件数 / 追加した回帰テスト名（追加先: 既存 / 単体 / 新規）>
## マージ判断
<可 / 不可 と理由（下のチェックリストの結果）>
```

**ローカルの変更では**（`task-to-pr` の「ローカルの変更では」の workspace）: スレッドが無いので、指摘ごとの振り分けと返信（見送る nit・question も）は、変更へのコメント 1 件に表で書く（`| 指摘（引用） | 振り分け | 返信 |`、`ops-kit backlog comment <変更> --body-file "$W/summary.md"`。上の要約も同じコメントに）。`gh api` の返信も resolve も無い。修正は枝に commit するだけ（push しない）。

## 5. マージ可否

全部 yes ならそのままマージする（聞き直さない。`pbi-complete` の「この依頼が含む範囲」）。1 つでも no なら理由を要約に書いて止める（PR は open のまま。聞くものは `issue-workflow` の「判断待ちの出し方」で分ける: マージしてよいかは運用の確認として Task の会話で聞いてターンを終え、Issue に書かない。実装の判断は Issue の `## 判断待ち`）:

- [ ] マージ判定（CLAUDE.md のコマンド。ローカルの変更では `<マージ判定> --change <変更>`、マージは Task への指示が名指しする `local-merge.ts <変更>`（判定をもう一度通してから rebase で入れ、Task も閉じる）。無ければこのチェックリストを自分で確かめる）が exit 0（stop の `reasons` は要約の「マージ判断」に貼る。large の理由の扱いは `pbi-complete` の 5: `[聞く]` は小さな差分でも、利用者が Task の会話で `PR #<n> をマージしてよい` と認めるまで（認めたら `--allow-large`）マージしない。`[再チェック <kind>]` は聞かずに再チェックを仕事として頼み、その記録で外す。頼み方も同じ節）
- [ ] 全指摘が 修正 / Issue 化 / 対処不要 / 回答 のどれかで、返信済み（見送る nit・question は要約の表で）（main との比較で要望にした指摘の `Issue 化: #<要望>（main と比べて後退でない: …）` の返信も数える）
- [ ] blocker が残っていない（修正済みか、誤読の根拠つき）
- [ ] 主レビュアーの独立レビューがある（`cross-runner-review` の「誰がレビューするか」。利用上限のときは同じスキルの 0。自己レビューだけでは満たさない。レビューできなければ未レビューとして止める）
<!-- when extra=on -->
  （追加のレビュアーは未着でもよく、届いたら転記して比較する）
<!-- end when -->
- [ ] security / license / personal data / public readers の 4 項目が主レビューにあり、finding は処理済み
- [ ] 攻める側のレビューが要る PR（マージ判定の JSON の `attack` が空でない）は、攻める側のレビューの仕事の記録が今の head にあり、指摘は処理済み
- [ ] CI 緑: `gh run list --commit "$(gh pr view $N --json headRefOid -q .headRefOid)"`（`gh pr checks` は Checks の権限が要り、fine-grained トークンでは 403 になることがある）。**Actions が始まらない**（run が数秒で failure、ジョブのステップが 0 件: `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs -q '.jobs[].steps|length'`）ときは待たず、ローカル CI（CLAUDE.md のコマンド）を回す。ローカル CI を仕事に頼み（`ops-kit job request local-ci <PR>`）、その仕事の記録（`result.ci`）をマージ判定が CI の成功と数える仕組みなら、それで進める（テストが実際に落ちた CI の代わりにはならない）。スタックでいつ回すかは `pbi-complete` の 4（自動 rebase と base の前進では回し直さない）
- [ ] PR 本文が今の差分と一致（修正で変わったなら `gh pr edit` で直す。[x] は事実だけ）
- [ ] Task の DoD が事実として満たされている（テスト / typecheck / 実構成、および Task が名指しした doc）
- [ ] `git diff --stat origin/main...HEAD` に迷いファイル（作業ファイル、fixture の絶対パス）が無い
- [ ] `gh pr view $N --json baseRefName,mergeable,mergeStateStatus` が CLEAN

**ローカルの変更では**（4 の同名の段落と同じ workspace）: 上の `gh` の行は呼ばない。CI 緑は `<ローカル CI> --change <変更>` の合格（`<マージ判定> --change <変更>` が数える）、PR 本文は変更の本文（`ops-kit backlog edit <変更> --body-file <ファイル>` で直す）、迷いファイルは `git diff --stat main...<枝>`、base と CLEAN は `<マージ判定> --change <変更>` が見る。

**GitHub が使えないときは**（CLAUDE.md が名指しする `<GitHub 不在の切り替え>` があり、マージ判定か `gh pr merge` が GitHub の一時的な障害・上限で失敗するとき。exit の読み方は `task-to-pr` の同名の段落）: `<GitHub 不在の切り替え> --task <Task> --pbi <PBI> --head <枝> --pr <PR> -- pr view <PR>` で切り替えを残す（exit 3 の `L<n>` が変更の番号）。PR の代わりをする変更（`--pr`）は、レビュースレッドを読めないのでローカルではマージされない（`<マージ判定> --change <n>` が止める）: レビューとローカル CI の記録だけ変更に進め、マージは GitHub が戻ってから PR で行う。PR をまだ作っていなかった枝の変更は「ローカルの変更では」の行でマージまで進める（判定の規則は PR と同じ）。スタックの途中なら下の PR から 1 本ずつ切り替える

## 6. マージと記録

スタックは**一番上の PR でまとめて**（`pbi-complete` の 5）。マージ判定のコマンド（CLAUDE.md）に `--merge` / `--merge-stack` があれば、判定とマージを 1 つのコマンドで（判定が merge のときだけマージする。Task の許可に入る）。単発は `<マージ判定> $N --merge`。その引数が無いリポジトリでは、単発は `gh pr merge $N --rebase --delete-branch`、スタックは `gh stack merge $N --rebase -y`。判定の外のマージは `pbi-complete` の 5。
<!-- when mergeGate=on task=in -->
`PR #<n> を判定の外でマージしてよい` の許可文が記録されているときだけ `gh` の前段を通る（`ops.config.json` に `mergeGate` があるリポジトリのアプリの Task）。
<!-- end when -->

```bash
<マージ判定> $N --merge-stack   # $N はスタックの一番上。下の PR も判定し、全部 merge ならまとめて
```

マージ直後:
1. PR が `Refs #<Task>` なら、Task に途中経過のコメント（マージした PR と残りの手順）を書き、Status を `In review` から `In progress` に戻して閉じない（残りの手順は次の PR で終える。`issue-workflow` の記録の義務 3）。`Closes #<Task>` なら、Task に結果コメント（`issue-workflow` のテンプレ。`ops-kit backlog comment <Task> --body-file "$W/result.md"`）、`ops-kit backlog set <Task> Status Done`。Task は PR が既定の枝に入ったマージで閉じる（スタックの上の PR は base が付け替わってから入るので、その場では閉じないことがある）。open のままなら続けて `ops-kit backlog edit <Task> --state closed`
2. `git fetch -q origin && git ls-tree -r --name-only origin/main | grep -i <消したもの>` で復活ファイルが無いか（fetch しないと古い origin/main を見る。`-r` が無いと直下しか出ない）
3. `cross-runner-review` で作ったレビュー用ディレクトリ（`cross-runner-review` の 1 の `$R` の実際のパス）を消す。glob で消さない（切れたセッションの残りは、次のレビューの `cross-runner-review` の 1 が MERGED / CLOSED と確かめた分だけ消す）。worktree はスタックが全部入ってから `git worktree remove`
4. PBI の全 Task が Done なら PBI の結果節（`pbi-complete`）

## 報告（利用者への返事の型）

```
PR #<n>: 指摘 <k> 件 → 修正 a / Issue 化 b（#..）/ 対処不要 c / 回答 d。回帰テスト <m> 件追加
マージ: <可 → マージ済み（sha） / 不可 → 理由と待っているもの>
次: <スタックの次の PR / PBI の結果節 / 利用者の判断>
```

## やらないこと

- 指摘を黙って無視する（返信も要約の表の行も無い指摘はマージを止める）
- 「意図的です」「後で」だけの返信
- レビュアーの指摘を避けるために PR の説明を書き換える（差分が変わったときだけ直す）
- 判定の外で `gh stack merge <top>` を呼ぶ（下の PR が判定なしで入る）
