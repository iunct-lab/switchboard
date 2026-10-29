---
name: review-triage-and-merge
description: PR に付いたレビュー（複数レビュアー）の指摘を 1 件ずつ「修正 / Issue 化 / 対処不要」に振り分け、修正して返信し、要約に件数表を書き、マージ可否を判断してマージし、Issue に結果を残すまでの型。レビューコメントが出そろったとき、マージするか迷ったときに読む。前は cross-runner-review、スタックの流れ全体は pbi-complete。
---

# Review triage → merge

目的: 指摘を**全部**処理してからマージする。処理は 3 種類だけ: **修正** / **Issue 化** / **対処不要**。どれにも振っていない指摘が残る PR はマージしない。

## 1. 集める

```bash
N=<PR番号>
gh api "repos/{owner}/{repo}/pulls/$N/comments" --paginate | jq -r '.[] | "\(.id)\t\(.path):\(.line // .original_line)\t\(.body | split("\n")[0] | .[0:100])"'   # 一覧。採否は id ごとに全文を読む
gh api "repos/{owner}/{repo}/pulls/$N/comments/<id>" -q .body                                                 # 全文
gh api "repos/{owner}/{repo}/pulls/$N/reviews"  --paginate | jq -r '.[] | select(.body != "") | "---- review \(.id) \(.user.login)\n\(.body)"'   # review 本文は全文（切ると 2 件目以降を見落とす）
gh pr view $N --comments --json comments -q '.comments[] | "---- \(.author.login)\n\(.body)"'                    # 要約コメント（[codex] / [<extra>] / サブエージェント）も全文
```

同じ指摘が複数のレビュアーから来たら 1 件にまとめ、返信で「[codex] と [<extra>] の同じ指摘」と書く。

## 2. 振り分ける

| 振り分け | いつ | やること |
|---|---|---|
| **修正** | blocker。should-fix で Task の範囲内。nit は同じ修正コミットに入る 1 行程度のものだけ（ほかの nit は対処不要か Issue 化） | この枝で直す。回帰テストを先に書き、修正前に fail することを見る |
| **Issue 化** | 正しいが Task の範囲外（別の受け入れ条件、別の場所、リファクタ、将来の改善）。同じ PBI なら Task、別の価値なら PBI（`request-to-backlog` の粒度で。元要望は「なし（PR #N のレビュー）」） | Issue を作り、返信に番号。PBI の決定ログにも 1 行 |
| **対処不要** | 観点がずれている: 設計原則（設計ルール。場所は CLAUDE.md）や PBI の決定ログ・スコープ外に反する提案、互換層・一度しか使わない抽象・念のための設定の追加、レビュアーの誤読、この環境で検証できない懸念 | 返信に**根拠**（ファイル・Issue・doc の名指し）。「意図的です」だけは不可 |

question は事実で答える（「分からない」なら調べてから）。**レビュアーが正しくて自分の修正が間違いのこともある**（最初の修正を却下するのが正解だったことがある）。自分の変更を守らず、より小さく安全な直し方があればそちらに切り替える。

優先度: blocker → should-fix → question → nit。blocker が「対処不要」になるのは誤読のときだけで、必ず根拠を書く。

## 3. 直す

```bash
cd <その Task の worktree>; git checkout <その Task の枝>        # 場所と名前は CLAUDE.md の worktree と枝の規則
# 回帰テスト → fail を確認 → 修正 → pass。テストのコマンド（1 件 / 型検査 / 全体）は CLAUDE.md
git commit -am "fix(<area>): review follow-ups for #<PR> — <何を>"     # amend・fixup/autosquash・squash で既存のコミットに混ぜない（どれも author date を保つのでマージ判定が見直しの要否を判定できない）
gh stack rebase && gh stack push        # 下の枝を直したら上に cascade（stacked-pr-delivery）。単発なら git push
```

修正を push したら `cross-runner-review` の 4（修正後の見直し）を回す。

**1 回のレビューの修正は 1 コミットにまとめてから見直しを頼む**。nit ごとにコミットすると、コミットごとに新しい見直しが次の端のケースを見つけ、収束しない（nit は直さなくてよいもの）。直すのは blocker / should-fix と、同じコミットに入る 1 行程度の nit だけ。ほかの nit は対処不要か記録（Issue）にする。直し方は、端のケースを広げる推測より、限界を書いた保守的な規則を選ぶ。文書に「〜だけ」「全部」のような網羅の主張を書かない。

修正のたびに `gh pr view $N --json headRefOid` が進む。インラインコメントは古い commit に紐づくが返信はできる。

## 4. 返信する

**1 コメント 1 返信**。返信の型:

```
修正: <何をどう直したか> — <commit sha 短縮>、テスト <name>
Issue 化: #<n>（<なぜこの PR の外か>）
対処不要: <根拠>。<ファイル / Issue / doc>
回答: <事実>
```

```bash
gh api "repos/{owner}/{repo}/pulls/$N/comments/<id>/replies" -f body="..."
# 返信したスレッドは resolve する（マージ判定は未解決のスレッドがある PR を止める）。resolve は「返信した」印で、
# 指摘が片づいたことの確認は修正後の見直し（cross-runner-review の 4）が担う — 返信の前に resolve しない
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ nodes{ id isResolved comments(first:1){ nodes{ databaseId } } } } } } }' -F o=<owner> -F r=<repo> -F n=$N \
  -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not) | "\(.id)\t\(.comments.nodes[0].databaseId)"'
ops-kit pr resolve-thread <thread id>...                # resolve だけをするコマンド（Task の許可に入る。素の gh api graphql の mutation は使わない）
gh pr comment $N --body-file "$W/summary.md"      # W=$(mktemp -d /tmp/<リポジトリ名>.triage<PR番号>.XXXXXX)。固定の /tmp/summary.md にしない
# <owner> / <repo> は gh repo view --json owner,name で見る。{owner}/{repo} は gh api が今のリポジトリで埋める
```

要約コメント（`$W/summary.md`）:

```markdown
## レビュー対応
| レビュアー | 件数 | 修正 | Issue 化 | 対処不要 | 回答 |
| codex | .. | .. | .. | .. | .. |
| <extra> | .. | .. | .. | .. | .. |
主な修正: <1〜3 行>  Issue 化: #.., #..  対処不要の根拠: <1〜2 行>
テスト: <全体の件数 / 追加した回帰テスト名>
## マージ判断
<可 / 不可 と理由（下のチェックリストの結果）>
```

## 5. マージ可否

全部 yes ならそのままマージする（`/pbi-complete` などの依頼の範囲。聞き直さない。`pbi-complete` の「この依頼が含む範囲」）。1 つでも no なら理由を要約に書いて止める（利用者に聞くものは `issue-workflow` の「判断待ちの出し方」で種類を分ける: チェックリストが no で止めたときだけ、マージしてよいかを運用の確認として Task の会話で聞いてターンを終え、Issue に書かない。実装の判断は Issue の `## 判断待ち`。PR は open のまま）:

- [ ] マージ判定（CLAUDE.md のコマンド。無ければこのチェックリストを自分で確かめる）が exit 0（stop の `reasons` は要約の「マージ判断」に貼る。impact が large のとき、`[聞く]` の理由（セキュリティ・`rescue/**`・README の Design rules）は利用者が Task の会話でマージを認めるまで（`--allow-large`）マージしない。`[再チェック <kind>]` の理由は利用者に聞かず、再チェック（CLAUDE.md が名指しする手順）を回して印で外す — どちらも `pbi-complete` の 5。小さな差分でも `[聞く]` の stop は、利用者が認めたときでしか外さない。聞く前と返事の後に記録の印 `[merge-ask]` / `[merge-answer]` を PR に投稿する。`[merge-ask]` の無い PR への返事は先に `[merge-ask]` を付ける。`--allow-large` は `[merge-answer] yes` の後 — `pbi-complete` の 5）
- [ ] 全指摘が 修正 / Issue 化 / 対処不要 / 回答 のどれかで、返信済み
- [ ] blocker が残っていない（修正済みか、誤読の根拠つき）
- [ ] 主レビュアーの独立レビューがある（通常は別ランナー。利用上限なら `cross-runner-review` の 0 に従い、同じランナーの新しいセッションで代替する。自己レビューだけでは満たさない。代替も利用できなければ未レビューとして止める。追加のレビュアーは未着でもよく、届いたら転記して比較する）
- [ ] security / license / personal data の 3 節が主レビューにあり、finding は処理済み
- [ ] CI 緑: `gh run list --commit "$(gh pr view $N --json headRefOid -q .headRefOid)"`（`gh pr checks` は Checks の権限が要り、fine-grained トークンでは 403 になることがある）。**Actions が始まらない**（請求の問題。run が数秒で failure、ジョブのステップが 0 件: `gh api repos/{owner}/{repo}/actions/runs/<id>/jobs -q '.jobs[].steps|length'`）ときは待たず、ローカル CI（CLAUDE.md のコマンド）で CI の手順をローカルで回す。通ったときの印をマージ判定がその CI の成功と数える仕組みなら、それで進める（テストが実際に落ちた CI の代わりにはならない）。スタックなら一番上の PR で、全部の PR の指摘の処理が済んでから 1 回回す。修正で差分が変わったら一番上でもう 1 回（下の PR のマージ後の自動 rebase と base の前進では回し直さない。CLAUDE.md が名指しするマージ判定の規則の「ローカル CI を回す時と数え方」）
- [ ] PR 本文が今の差分と一致（修正で変わったなら `gh pr edit` で直す。[x] は事実だけ）
- [ ] Task の DoD が事実として満たされている（テスト / typecheck / 実構成、および Task が名指しした doc）
- [ ] `git diff --stat origin/main...HEAD` に迷いファイル（作業ファイル、fixture の絶対パス）が無い
- [ ] `gh pr view $N --json baseRefName,mergeable,mergeStateStatus` が base=main（スタックの一番下）で CLEAN

## 6. マージと記録

スタックは **main に近い方から 1 本ずつ**（`pbi-complete`）。マージ判定のコマンド（CLAUDE.md）に `--merge` / `--merge-stack` があれば、判定とマージを 1 つのコマンドで（判定が merge のときだけマージする。Task の許可に入る）。単発は `<マージ判定> $N --merge`。その引数が無いリポジトリでは、単発は `gh pr merge $N --rebase --delete-branch`、スタックは `gh stack merge $N --rebase -y`。

```bash
<マージ判定> $N --merge-stack                      # スタックの最下段だけ。上は GitHub が retarget + rebase する
gh pr view <next> --json baseRefName,mergeable,mergeStateStatus   # base=main かつ CLEAN になってから次へ（UNSTABLE = CI 中）
```

マージ直後:
1. Task に結果コメント（`issue-workflow` のテンプレ: PR / 変更 / 検証 / レビュー指摘と対応 / 残したもの）、`set_project_field.sh <Task> Status Done`。GitHub 連携の無い workspace（`BACKLOG_WORKSPACE` がある）の Task は自動で閉じないので、続けて `ops-kit backlog edit <Task> --state closed`
2. `git fetch -q origin && git ls-tree -r --name-only origin/main | grep -i <消したもの>` で復活ファイルが無いか（fetch しないと古い origin/main を見る。`-r` が無いと直下しか出ない）
3. `cross-runner-review` で作ったレビュー用ディレクトリ（`/tmp/<リポジトリ名>.review<PR番号>.XXXXXX` の実際のパス）を消す。glob で消さない。切れたセッションの残りは、次のレビューの前（`cross-runner-review` の 1）に同じリポジトリ名 + `gh` で MERGED / CLOSED と確かめたものだけ消える。worktree はスタックが全部入ってから `git worktree remove`
4. PBI の全 Task が Done なら PBI の結果節（`pbi-complete`）

## 報告（利用者への返事の型）

```
PR #<n>: 指摘 <k> 件 → 修正 a / Issue 化 b（#..）/ 対処不要 c / 回答 d。回帰テスト <m> 件追加
マージ: <可 → マージ済み（sha） / 不可 → 理由と待っているもの>
次: <スタックの次の PR / PBI の結果節 / 利用者の判断>
```

## やらないこと

- 指摘を黙って無視する（返信の無い指摘はマージを止める）
- 「意図的です」「後で」だけの返信
- レビュアーの指摘を避けるために PR の説明を書き換える（差分が変わったときだけ直す）
- スタックをまとめて `gh stack merge <top>` する（コンフリクトが隠れる）
