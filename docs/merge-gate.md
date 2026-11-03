# merge-gate の手順（再チェック・記録の印・保護枝）

`bun scripts/merge-gate.ts <PR> [--allow-large] [--repo <owner/name>]` が stop を返したときに回す手順と、PR に付ける印。出力は `{ verdict, impact, reasons, ask, recheck, notes? }` の JSON、exit 0 = merge、1 = stop、2 = 判定できなかった（merge にしない）。判定の規則は `scripts/merge-gate.ts`。工程の Task のプロンプトと merge-gate の理由の文がこの文書の節を指す。

## ローカル CI を回す時と数え方

Actions が始まらない（ジョブのステップ 0 件）か run が無い（全部の run が skip された、も同じ）リポジトリでは、`bun scripts/local-ci.ts <PR>` を次のときだけ回す（スキルの `<ローカル CI>`。別リポジトリの Task には `otherRepoRules` がこの節を渡す）:

- **いつ**: スタックの全部の PR のレビューの指摘の処理が済んでから、再チェックの前に、スタックの一番上の PR で 1 回。単発の PR は自分が一番上。レビューの途中、PR ごと、マージの合間には回さない
- **回し直す**: どれかの PR の差分が変わったとき（修正コミット、手で rebase してコンフリクトを解いたとき）だけ、一番上でもう 1 回。下の PR のマージ後の GitHub の自動 rebase（head の sha は変わるが差分は同じ）と、base（main）の前進では回し直さない
- **数え方**（merge-gate の `localCiOf`）: PR から、その head の枝を base にする開いた PR を上へ辿って一番上を見つける（上が 0 件か 2 件以上ならそこが一番上）。一番上の PR の `[local-ci]` の結果のうち最新が pass で、この PR の今のコミット（今の base の枝の先との merge-base から head まで）がどれもその pass の head に同じ差分で入っていれば（`git cherry <pass の head> <PR の head> <merge-base>` に `+` の行が無く、その中のマージコミットは pass の head の履歴にそのままある）、この PR の CI は済み。下の PR のマージ後の自動 rebase（sha は変わり、コミットごとの差分は同じ）では数え、修正コミットや差分を変えたコンフリクトの解消では数えない。最新が fail か、入っていないコミットがあれば、CI の理由に続けて一番上で回し直す理由が出る。読むのは印の 1 行目だけなので、ほかのリポジトリの local-ci の写しが書く 1 行目だけの pass も同じに数える。merge-gate は判定に要るコミット（pass の head、PR の head、base の枝の先）を、走らせた作業ツリーに ref を書かずに fetch する（`https://github.com/<owner>/<name>.git` から）。git の作業ツリーでない・fetch できないときは判定しない（exit 2）
- **base を比べない理由**: ほかの PR との衝突は `mergeStateStatus` が止める。別々の PR を合わせて初めて出る不具合は、マージ後のタグの CI（`docs/design/releases-and-rescue.md` の「Tag CI」）が見つける
- スタックの上に PR を後から積んだら、その新しい一番上で回す（前の一番上の pass はその PR を含まない）
- **影響範囲のテスト**: 絞るのは `bun test` の手順だけで、ほかの手順は全部回す。スタックの一番上で回せば全部の PR の変更の合計で選ぶ。判定できない変更（依存の定義、CI の手順、選択の道具、分類できないファイルなど）や選択が動かないときは全テストに倒れ、`--all` でも全テスト。結果コメントの `テスト:` の行に、絞った回は回した数と全体の数、倒れた回はその理由が出る
- **pass の意味**: 絞った pass は影響範囲の安全網で、merge-gate は全テストの pass と同じに数える。全テストの安全網はタグの CI が持つ。絞り込みの限界（例: `scripts/public-include.test.ts` はルートの一覧を読むので、ルートへのファイルの追加では選ばれない）はタグの CI が拾い、見逃しの数は下の「絞り込みの見逃しの記録」に残る

## 絞り込みの見逃しの記録

タグの CI の `bun test` が赤のとき、タグの Release の `## CI` に `selection:` の行が 1 行付く。落ちたテストファイルを、PR の local-ci の選択（`scripts/test-select.ts`）で選ばれたかで分けた数。

- `selection: missed <N> / selected <M>（落ちたテストファイル <N+M> 件）`: `missed` は選ばれなかった = PR の絞り込みなら見逃した赤、`selected` は選ばれていた = PR の local-ci でも赤になったはずの赤。判定できない変更で全テストに倒れた範囲は全部 `selected`
- `selection: unclassified（理由）`: 前のタグが無い、差分や選択を読めない、出力から落ちたファイルを読めない。数えない
- 数え方: `gh release list` の各タグで `gh release view <tag> --json body -q .body | grep '^selection:'`
- 限界: 変更の範囲は PR ではなく 1 つ前のタグからそのタグまで。範囲が PR より広い分だけ選ばれやすいので、`missed` はその分少なく出る。逆に、前のタグから直っていない赤や不安定なテストの赤は、そのタグの変更と関係なくても `missed` に入るので、多く出ることもある。同じ赤が続くタグは 1 件と読み、数は見逃しの目安として使う

赤は今までどおり Release に残り、直す要望が自動で立つ。ゲートにはしない。

## 再チェック

merge-gate が stop し、large の理由が `[再チェック <kind>]` だけ（`[聞く]` が無い）なら、利用者に聞かずに `recheck` の種類ごとに次を回す（スキルは `pbi-complete` の 5、`review-triage-and-merge` の 5、別リポジトリの Task には `otherRepoRules` が手順の場所とリポジトリ固有の値を渡す）。他のリポジトリの PR（`--repo`）では、下の `-R <owner/name>` と `origin` はそのリポジトリ（Switchboard では `開発リポジトリ`）。CI・未解決のスレッド・見直されていないコミット・CLEAN でないことは再チェックとは別に今までどおり片づける。

| 種類 | 回す人 | 合格 |
|---|---|---|
| `size` | 主レビュー（`[codex] review` / `[claude] review`）とは別のランナーの全体レビュー: 主が Codex なら Claude のサブエージェント、主が Claude なら Codex。材料と指示と転記は `cross-runner-review` の 1〜3 のまま（会話の文脈を渡さない）。ただし転記の要約の 1 行目は `[<runner>] recheck size`（`post_review` は 1 行目を引数に取らないので、呼び出しの中で定義するときに `printf '[%s] review\n\n'` を `printf '[%s] recheck size\n\n'` に替えて定義する。`[<runner>] review` で転記しない — merge-gate がそれを主レビューと数え、見直しの代わりになってしまう） | `### Findings` に blocker / should-fix が 0 件 |
| `responsibility` | 同じく別のランナーのレビュアー。`cross-runner-review` の 1 の材料に元要望を足し（`ops-kit backlog view <PBI の ## 元要望 の番号> --fresh > "$M/request.md"`。レビュアーの sandbox は GitHub を読めないので）、指示に「責務のファイル（`[再チェック responsibility]` の理由のパス）の変更が、`_review/pbi.md` の受け入れ条件と `_review/request.md`（元要望）の求める範囲か。範囲外の変更を 1 行ずつ `[should-fix]` で挙げる」を足す。要約コメントの 1 行目は `[<runner>] recheck responsibility`（`size` と同じく `post_review` の 1 行目を替える）。`size` と同じ PR なら 1 回のレビューで両方を見させ、1 行目を `[<runner>] recheck size responsibility` にしてよい | 範囲外の変更が 0 件（`### Findings` に blocker / should-fix が 0 件） |
| `migration` | PR の head の checkout（worktree）で `env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/schema.test.ts packages/core/src/transfer.test.ts` | 全部 pass |
| `rescue` | PR の head の checkout（worktree）で `env -u SWITCHBOARD_SUPERVISED bun test rescue/src`（候補の版の拒否・切り替え後の自動の戻し・スナップショットからの戻しを含む `promote.test.ts` が入る）と、インストールしたバンドルの起動と戻しを確かめる `env -u SWITCHBOARD_SUPERVISED bun scripts/rescue-e2e.ts`。加えて `size` と同じ別のランナーのレビュー。要約コメントの 1 行目は `[<runner>] recheck rescue`。ほかのレビュアーの再チェックと同じ PR なら 1 回のレビューで見させ、1 行目に種類を並べてよい | テストと E2E が全部 pass し、`### Findings` に blocker / should-fix が 0 件 |
| `design-rules` | `responsibility` と同じ別のランナーのレビュアーと材料。指示に「変わった規則が README のほかの規則・既存の設計文書と矛盾しないか、`_review/request.md`（元要望）の求める範囲か。矛盾と範囲外を 1 行ずつ `[should-fix]` で挙げる」を足す。要約コメントの 1 行目は `[<runner>] recheck design-rules`。ほかのレビュアーの再チェックと同じ PR なら 1 回のレビューで見させ、1 行目に種類を並べてよい | `### Findings` に blocker / should-fix が 0 件 |

再チェックで指定したランナーが利用上限なら、`cross-runner-review` の 0 と同様、上限でない側のランナーの新しいセッションで代替する。Codex が上限なら Claude、Claude が上限なら Codex と対称に扱う。再チェックは主レビューとは別の新しいセッションで、会話の文脈も主レビューの結果も渡さず、材料と指示は上のまま。要約の 1 行目は `[<runner>] recheck <kind>（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）`。自己レビューとは区別する。同じランナーなので見落としが重なりうるが、戻すのはタグででき、`[聞く]` の範囲は変わらない。代替も利用上限なら未レビューとして Task の会話で止める。代替したときは、決定ログの種類に「、<runner> で代替」を足す（例「自動マージ: PR #n（responsibility、再チェック合格、Codex で代替）」）。

通ったら印を投稿する（1 行目が印。2 行目に再チェックした差分の patch-id、3 行目以降に根拠: レビューコメントの URL か、テストの件数）:

```bash
gh pr comment <PR> -R <owner/name> --body "[recheck] <kind> pass $(gh pr view <PR> -R <owner/name> --json headRefOid -q .headRefOid)
patch-id $(gh pr diff <PR> -R <owner/name> | git patch-id --verbatim | cut -d' ' -f1)
<レビューコメントの URL / テストの件数>"
```

印を付けたらマージ判定をもう一度通す。head が変わったら（修正コミット、下の PR のマージ後の自動 rebase）印は数えられなくなるので回し直す（`migration` はいつもテストを回し直す。`rescue` もテストと E2E はいつも回し直し、レビューは次と同じ。`size` / `responsibility` / `design-rules` は、今の `gh pr diff <PR> | git patch-id --verbatim` が前の印の 2 行目の patch-id と同じときだけ — 下の PR のマージ後の自動 rebase のように差分が変わっていないとき — 前のレビューのコメント URL を根拠に印だけ出し直してよい。違えば、手で rebase してコンフリクトを解いたときも含めて回し直す。`--verbatim` は空白の違いも別の id にするので、インデントだけを変えた解き方も見分ける）。通らなければ指摘を直して（`review-triage-and-merge`）回し直す。直せなければ運用の確認として Task の会話で聞く。

再チェックでマージしたら、PBI の決定ログに 1 行「YYYY-MM-DD: 自動マージ: PR #n（<種類>、再チェック合格）、戻すなら <tag>」。`<tag>` は CI を通ったタグの中の最新（マージの前に `bun scripts/tag-ci.ts --latest-pass`。タグはこのコマンドが取り直す。他のリポジトリの PR では、そのリポジトリの作業ツリーから Switchboard の clone の `scripts/tag-ci.ts` を `--latest-pass --repo <owner/name>` で。`--repo` が無いとスクリプトの clone、つまり Switchboard のタグを選ぶ。タグは CI を待たずに付くので、最新のタグは落ちていることがある）。コマンドが exit 1（CI を通ったタグが無い。タグの CI がまだ結果を書いていないリポジトリなど）なら、`<tag>` の代わりに「戻すなら: CI を通ったタグなし」と書く（最新のタグを代わりに書かない）。そこへ戻すのは [`docs/design/releases-and-rescue.md`](design/releases-and-rescue.md) の Going back（`scripts/rollback-pr.ts <tag>`）。

## 記録の印

large の PR で、どの種類を誰が外したかを PR コメントの印で残す（週 1 回の集計 `scripts/merge-audit.ts` が読み、規則を変える案を出す）。種類の語は `MERGE_KINDS` = `security:docs, security:words, security:lockfile, security:github, security:gates, security:host, rescue, design-rules, size, responsibility, migration`（セキュリティは経路の塊ごと。2026-11 に塊へ分ける前の `security` の印は数えない）（merge-gate の出力の `ask` と `recheck` の語）。印はどれも 1 行目に置き、head の 40 桁の sha を付ける（`[local-ci]` / `[recheck]` と同じ型。時刻はコメントの `createdAt` で、本文には書かない）:

| 印 | いつ | 読み方 |
|---|---|---|
| `[recheck] <kind> pass <head sha>`（`RECHECK_PASS`） | 再チェックに合格したとき（上の「再チェック」） | その種類は再チェックで外した |
| `[merge-ask] <kinds> <head sha>`（`MERGE_ASK`） | 利用者に「マージしてよいか」を Task の会話で聞く直前 | `<kinds>` は merge-gate の出力の `ask` と、まだ印の無い `recheck` を `,` でつないだもの（上の `MERGE_KINDS` の順） |
| `[merge-answer] <yes\|no> <kinds> <head sha>`（`MERGE_ANSWER`） | `[merge-ask]` を付けて聞いた PR への返事を受けて再開したとき（`yes` なら続けて `--allow-large` でマージ判定。CI など large 以外の理由で聞いたときはどちらの印も付けない）。`[merge-ask]` が無ければ先に `[merge-ask]` を付けてから（時刻はどちらも付けた時刻） | `yes` = 利用者が認めた。`<kinds>` は聞いたときと同じ |

投稿は `gh pr comment <PR> -R <owner/name> --body "[merge-ask] <kinds> $(gh pr view <PR> -R <owner/name> --json headRefOid -q .headRefOid)"`（`[merge-answer]` も同じ）。`--allow-large` は、head と同じ sha の最後の `[merge-answer]` が `yes` で、`<kinds>` が判定の出力の `ask` と `recheck` を全部含まなければ効かない（`yes` の後の `no` は取り消し。`[merge-ask]` を付けずに聞いていた PR は、`[merge-ask]` → `[merge-answer]` の順に付けてから）。前のマージには印を遡って付けない。

## 保護枝とローカルの結果

local-ci の結果は PR コメントで、GitHub の必須チェック（check run / commit status）にはならない。base の枝に必須のステータスチェック（や必須の承認）を設定した保護・ruleset があると、GitHub はローカルの合格があっても PR を `BLOCKED` にし、マージできない。merge-gate はこれを黙って通さず、local-ci で CI を数えたうえで `BLOCKED` なら「mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果は PR コメントで、GitHub の必須チェックにはならない」と止める。merge-gate は保護の設定を読まず（管理者の権限が要り、プランによっては API が使えない）、変えもしない。レビュー・承認・保護の要件は迂回しない。

利用者が設定を確かめる手順（変えるかどうかは利用者が決める）:

1. `gh api repos/<owner>/<repo>/branches/<base> -q .protected` — `false` なら保護は無い。BLOCKED の理由は ruleset か承認の待ち
2. `true` なら、リポジトリの Settings → Branches（または `gh api repos/<owner>/<repo>/branches/<base>/protection/required_status_checks`。管理者のみ）で必須のチェックの名前を見る。Settings → Rules → Rulesets（`gh api repos/<owner>/<repo>/rules/branches/<base>`）の「Require status checks to pass」も同じ
3. Actions が始まらない間は、必須のチェックは満たせない。マージするには、利用者がその間だけ必須を外すか、Actions を回せる状態に戻す。どちらもこのリポジトリのスクリプトはしない
