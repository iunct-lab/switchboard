# merge-gate（無人マージの前の判定）

`bun scripts/merge-gate.ts <PR> [--allow-large] [--repo <owner/name>]`（`--repo` の既定は `GH_REPO`、無ければ作業ツリーの origin。他の workspace の工程 Task が自分のリポジトリを渡す。規則は同じ）が PR 1 本を規則で判定し、`{ verdict, impact, reasons, ask, recheck }` を JSON で出す。
exit 0 = merge、1 = stop、2 = `gh` が失敗して判定できなかった（merge にしない）。LLM は使わない（同じ PR にいつも同じ結果、理由が文で出る。PBI #281 の決定ログ）。

## impact

| 規則 | large になる条件 |
|---|---|
| 行数 | テストと docs を除いた追加 + 削除が `LARGE_LINES`（300）を超える。テスト = `**/*.test.ts`、`scripts/*-e2e.ts`。docs = `docs/**`、`**/*.md`（ただし `.claude/skills/**` と `ops-kit/skills/**` は数える） |
| セキュリティ | 理由の文は「セキュリティ: <パス, …>」。認証・承認・秘密: パスを `/` `.` `_` `-` で区切った語（小文字）のどれかが `SECURITY_WORDS`（`auth` / `approval` / `permission(s)` / `secret(s)` / `credential(s)` / `token(s)` / `crypto` / `sandbox`。`tokenizer` のような語の一部は当たらない）。`SECURITY_FILES`: CI とリポジトリ設定（`.github/**`）、`**/.env*`、`**/.gitleaks.toml`、どの階層のロックファイル（`bun.lock` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `uv.lock` / `poetry.lock` / `go.sum` / `Cargo.lock`、`**/requirements*.txt`。依存を足すとロックが変わるので、宣言の `package.json` ではなくロックを見る）、マージを決めるスクリプト（`scripts/merge-gate.ts`、`scripts/local-ci.ts`。CI と同じくマージの可否を決めるので、行数に関係なく利用者が認める。#751）、クラウドホストのスクリプトと unit（`aws/host/**`。起動のたびに root が main から入れ直して走らせる。#435。これに当たるときだけ理由の文の末尾に、root が main から走らせることと `docs/design/cloud-hosting.md` §6.5 の見直しの契機を指す注記が付く。#852） |
| 責務 | 理由の文は「責務: <パス, …>」。`RESPONSIBILITY`: `docs/design/**`、`**/CLAUDE.md`、`**/AGENTS.md`、`ops.config.json`、`.claude/skills/**`、`ops-kit/skills/**`。README.md の `## Design rules` の節の中の行（「責務: README.md の ## Design rules」）: PR の `README.md` の patch（`pulls/<n>/files`）を、マージベース（`compare/<base>...<head>`）の README に当て、削除・変更した行が見出しから次の `## ` の手前までにかかるか、追加した行がその中に入るかを見る。見出しの無い README は見ない。新規の README は見ない。見出しがあるのに GitHub が patch を省いた（差分が大きすぎる）ときは判定できないので触れたとみなす |
| 保護するパス | `PROTECTED` のどれかに触れ、上の 2 つに当たらない: `rescue/**`、`packages/core/src/{db.ts,schema-baseline.json,selfdev.ts}`、`packages/core/config/**`、`scripts/setup/**`、直下の `package.json`（`PROTECTED` の `.github/**`、`auth.ts`、`approval.ts`、`bun.lock` はセキュリティ、スキルは責務の理由で出る）。理由の文は `rescue/**` が「[聞く] rescue: …」（責務のファイルでも）、`db.ts` / `schema-baseline.json` が「[再チェック migration] 保護するパスに触れている: …」、ほかが「[再チェック size] 保護するパスに触れている: …」（次の節） |

セキュリティと責務は、どのリポジトリの PR（`--repo`）にも同じに効く（#563。無人で進む他のリポジトリでは行数の規則しか効かなかった）。保護するパスは Switchboard のファイル名。どれも大きさに関係なく large。large の理由は「利用者に聞く」と「再チェックで外せる」に分かれる（次の節）。
値は `scripts/merge-gate.ts` の定数 `LARGE_LINES` / `SECURITY_WORDS` / `SECURITY_FILES` / `RESPONSIBILITY` / `PROTECTED`（エージェントが決めた値。リポジトリごとの設定ファイルは無い。変えるときは PR で。規則から漏れた例が出たら定数を足す）。LLM やレビュアーの判断で「セキュリティに関わる」を決めない（同じ PR にいつも同じ判定）。

## 利用者に聞く理由と再チェックで外せる理由

large の理由は 2 つに分かれる（#751。要望 #750: 「マージしてよいか」はセキュリティ以外すべて「よい」で、戻すのはリリースタグでできる）。理由の文の頭で分かる。

| 扱い | 理由（文の頭） | 外れるもの |
|---|---|---|
| 利用者に聞く | `[聞く] セキュリティ: …`（上のセキュリティ）、`[聞く] rescue: …`（`ASK_PROTECTED` = `rescue/**`。壊れるとタグで戻すことそのものができない。`rescue/CLAUDE.md` のような責務のファイルも rescue。認証の語のファイルはセキュリティで出る）、`[聞く] 責務: README.md の ## Design rules` | `--allow-large` だけ |
| 再チェックで外せる | `[再チェック size] テストと docs を除いた変更が …`（行数）、`[再チェック size] 保護するパスに触れている: …`（`rescue/**` と `MIGRATION` 以外の保護するパス: `selfdev.ts`、`packages/core/config/**`、`scripts/setup/**`、`package.json`）、`[再チェック responsibility] 責務: …`（Design rules 以外の責務）、`[再チェック migration] 保護するパスに触れている: …`（`MIGRATION` = `packages/core/src/{db.ts,schema-baseline.json}`） | その種類の再チェックの印、または `--allow-large` |

出力の `recheck` は、large の理由にある再チェックの種類のうち head の印がまだ無いもの（重複なし、`size`・`responsibility`・`migration` の順）。`ask` は、large の理由にある聞く種類（`security`・`rescue`・`design-rules` の順。`--allow-large` でも残る — 利用者の返事が何を外したかが出力に出る）。`impact` は印があっても `large` のまま（PR の性質なので）。

**再チェックの印**: PR コメントの 1 行目が `[recheck] <size|responsibility|migration> pass <head sha>`（`RECHECK_PASS`。local-ci の `[local-ci] pass <head sha> base=<base sha>` と同じ型）。merge-gate は種類ごとに、PR の head と同じ 40 桁の sha の印だけを数え、その種類の `[再チェック <kind>]` の理由を reasons から外す。別の sha の印、コメントの途中の文字列、知らない種類は数えない。修正コミットや下の PR のマージ後の自動 rebase で head が変わると印は数えられなくなるので、再チェックを回し直して出し直す。`[聞く]` の理由は印では外れない。印も主レビューも local-ci も、コメントの `authorAssociation` が `OWNER` / `MEMBER` / `COLLABORATOR`（`MARK_AUTHORS`）のものだけを数える（公開リポジトリ（`--repo`）では誰でもコメントできるので）。再チェックそのもの（誰が何を回し、何で合格か）は次の「再チェック」。

`--allow-large` は利用者が Task の会話でマージを認めたときだけ付け、`[聞く]` も `[再チェック]` も含めて large の理由を全部外す。

## 再チェック

merge-gate が stop し、large の理由が `[再チェック <kind>]` だけ（`[聞く]` が無い）なら、利用者に聞かずに `recheck` の種類ごとに次を回す（#751。スキルは `pbi-complete` の 5、`review-triage-and-merge` の 5、別リポジトリの Task には `otherRepoRules` が手順の場所とリポジトリ固有の値を渡す（#783））。他のリポジトリの PR（`--repo`）では、下の `-R <owner/name>` と `origin` はそのリポジトリ（Switchboard では `開発リポジトリ`）。CI・未解決のスレッド・見直されていないコミット・CLEAN でないことは再チェックとは別に今までどおり片づける。

| 種類 | 回す人 | 合格 |
|---|---|---|
| `size` | 主レビュー（`[codex] review` / `[claude] review`）とは別のランナーの全体レビュー: 主が Codex なら Claude のサブエージェント、主が Claude なら Codex。材料と指示と転記は `cross-runner-review` の 1〜3 のまま（会話の文脈を渡さない）。ただし転記の要約の 1 行目は `[<runner>] recheck size`（`post_review` は 1 行目を引数に取らないので、呼び出しの中で定義するときに `printf '[%s] review\n\n'` を `printf '[%s] recheck size\n\n'` に替えて定義する。`[<runner>] review` で転記しない — merge-gate がそれを主レビューと数え、見直しの代わりになってしまう） | `### Findings` に blocker / should-fix が 0 件 |
| `responsibility` | 同じく別のランナーのレビュアー。`cross-runner-review` の 1 の材料に元要望を足し（`gh issue view <PBI の ## 元要望 の番号> -R <owner/name> --json title,body -q '"# 要望 #<番号> \(.title)\n\n\(.body)"' > "$M/request.md"`。レビュアーの sandbox は GitHub を読めないので）、指示に「責務のファイル（`[再チェック responsibility]` の理由のパス）の変更が、`_review/pbi.md` の受け入れ条件と `_review/request.md`（元要望）の求める範囲か。範囲外の変更を 1 行ずつ `[should-fix]` で挙げる」を足す。要約コメントの 1 行目は `[<runner>] recheck responsibility`（`size` と同じく `post_review` の 1 行目を替える）。`size` と同じ PR なら 1 回のレビューで両方を見させ、1 行目を `[<runner>] recheck size responsibility` にしてよい | 範囲外の変更が 0 件（`### Findings` に blocker / should-fix が 0 件） |
| `migration` | PR の head の checkout（worktree）で `env -u SWITCHBOARD_SUPERVISED bun test packages/core/src/schema.test.ts packages/core/src/transfer.test.ts` | 全部 pass |

再チェックで指定したランナーが利用上限なら、`cross-runner-review` の 0 と同様、上限でない側のランナーの新しいセッションで代替する。Codex が上限なら Claude、Claude が上限なら Codex と対称に扱う。再チェックは主レビューとは別の新しいセッションで、会話の文脈も主レビューの結果も渡さず、材料と指示は上のまま。要約の 1 行目は `[<runner>] recheck <kind>（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）`。自己レビューとは区別する。同じランナーなので見落としが重なりうるが、戻すのはタグででき、`[聞く]` の範囲は変わらない。代替も利用上限なら未レビューとして Task の会話で止める。代替したときは、決定ログの種類に「、<runner> で代替」を足す（例「自動マージ: PR #n（responsibility、再チェック合格、Codex で代替）」）。

通ったら印を投稿する（1 行目が印。2 行目に再チェックした差分の patch-id、3 行目以降に根拠: レビューコメントの URL か、テストの件数）:

```bash
gh pr comment <PR> -R <owner/name> --body "[recheck] <kind> pass $(gh pr view <PR> -R <owner/name> --json headRefOid -q .headRefOid)
patch-id $(gh pr diff <PR> -R <owner/name> | git patch-id --verbatim | cut -d' ' -f1)
<レビューコメントの URL / テストの件数>"
```

印を付けたらマージ判定をもう一度通す。head が変わったら（修正コミット、下の PR のマージ後の自動 rebase）印は数えられなくなるので回し直す（`migration` はいつもテストを回し直す。`size` / `responsibility` は、今の `gh pr diff <PR> | git patch-id --verbatim` が前の印の 2 行目の patch-id と同じときだけ — 下の PR のマージ後の自動 rebase のように差分が変わっていないとき — 前のレビューのコメント URL を根拠に印だけ出し直してよい。違えば、手で rebase してコンフリクトを解いたときも含めて回し直す。`--verbatim` は空白の違いも別の id にするので、インデントだけを変えた解き方も見分ける）。通らなければ指摘を直して（`review-triage-and-merge`）回し直す。直せなければ運用の確認として Task の会話で聞く。

再チェックでマージしたら、PBI の決定ログに 1 行「YYYY-MM-DD: 自動マージ: PR #n（<種類>、再チェック合格）、戻すなら <tag>」。`<tag>` はマージの直前の main に入っている最新のリリースタグ（`vX.Y.Z` だけ。`release-tag.ts` の `latestSemver` と同じ。マージの前に `git fetch -q --tags origin && git tag -l 'v*' --merged origin/main --sort=-v:refname | grep -m1 -E '^v[0-9]+\.[0-9]+\.[0-9]+$'`）。そこへ戻すのは `releases-and-rescue.md` の Going back（`scripts/rollback-pr.ts <tag>`）。

## 記録の印

large の PR で、どの種類を誰が外したかを PR コメントの印で残す（#752。週 1 回の集計 `merge-audit` が読み、規則を変える案を出す）。種類の語は `MERGE_KINDS` = `security, rescue, design-rules, size, responsibility, migration`（merge-gate の出力の `ask` と `recheck` の語）。印はどれも 1 行目に置き、head の 40 桁の sha を付ける（`[local-ci]` / `[recheck]` と同じ型。時刻はコメントの `createdAt` で、本文には書かない）:

| 印 | いつ | 読み方 |
|---|---|---|
| `[recheck] <kind> pass <head sha>`（`RECHECK_PASS`） | 再チェックに合格したとき（上の「再チェック」） | その種類は再チェックで外した |
| `[merge-ask] <kinds> <head sha>`（`MERGE_ASK`） | 利用者に「マージしてよいか」を Task の会話で聞く直前 | `<kinds>` は merge-gate の出力の `ask` と、まだ印の無い `recheck` を `,` でつないだもの（上の `MERGE_KINDS` の順） |
| `[merge-answer] <yes\|no> <kinds> <head sha>`（`MERGE_ANSWER`） | `[merge-ask]` を付けて聞いた PR への返事を受けて再開したとき（`yes` なら続けて `--allow-large` でマージ判定。CI など large 以外の理由で聞いたときはどちらの印も付けない）。`[merge-ask]` が無ければ先に `[merge-ask]` を付けてから（時刻はどちらも付けた時刻。#1069） | `yes` = 利用者が認めた。`<kinds>` は聞いたときと同じ |

投稿は `gh pr comment <PR> -R <owner/name> --body "[merge-ask] <kinds> $(gh pr view <PR> -R <owner/name> --json headRefOid -q .headRefOid)"`（`[merge-answer]` も同じ）。`--allow-large` は `[merge-answer] yes` を投稿した後（印を付けずに `--allow-large` でマージしない。`[merge-ask]` を付けずに聞いていた PR は、`[merge-ask]` → `[merge-answer]` の順に付けてから）。merge-gate の判定はこの 2 つを読まない（判定を外すのは `--allow-large` のまま）。この PBI より前のマージには印を遡って付けない。週 1 回の集計と規則を変える案は [merge-audit.md](merge-audit.md)。

## verdict

stop の理由（impact に関係なく。`--allow-large` でも外れない）:

| 条件 | 理由の文 |
|---|---|
| CI のチェックが無い、または SUCCESS / SKIPPED 以外がある | 「CI のチェック X が FAILURE」など |
| 解決していないレビュースレッドがある | 「解決していないレビュースレッドが n 件ある」 |
| 最後のコミットより新しい `[codex] review` / `[claude] review` で始まる PR コメント（`MARK_AUTHORS` のもの）が無い | 「最後のコミット（…）より新しい主レビューが無い」 |
| `mergeStateStatus` が CLEAN でない（下の local-ci で CI を数えたときの UNSTABLE は除く） | 「mergeStateStatus が CLEAN でない: …」。local-ci で CI を数えて BLOCKED なら「mergeStateStatus が BLOCKED: base の枝の保護…」（下の「保護枝とローカルの結果」） |
| `mergeStateStatus` が UNKNOWN（push や base の変更の直後で GitHub が計算中） | 判定しない（exit 2。少し待ってやり直す） |

CI のチェックは、PR の head コミットの GitHub Actions の workflow run（`GET /repos/<owner>/<repo>/actions/runs?head_sha=<head>`）を workflow の名前ごとに一番新しい 1 件にしたもの（同じコミットに同じ workflow の run が複数あるとき — PR を閉じて開き直したときなど — は新しい方。「Re-run」は同じ run の status / conclusion を書き換えるので、その run の最新の結果になる）。完了していない run は「未完了」、conclusion は大文字にして上の表で見る。`statusCheckRollup`（`gh pr view` / `gh pr checks`）は使わない。check runs を含むので Checks の権限が要り、fine-grained PAT にはその権限が無い（クラウドホストのトークン。#381）。CI は Actions だけなので読む範囲は変わらない。Actions 以外の CI を足すときはここに読み方を足す。

**Actions が始まらないとき・run が無いとき（#386、#914）**: 請求の問題などで GitHub Actions のジョブが始まらないと、run は数秒で failure になる（ジョブのステップ 0 件、runner なし）。run がそもそも無いこともある。このときは `bun scripts/local-ci.ts <PR>` が Actions と同じ手順（`scripts/ci.ts`、#912）を、PR の最新の head を base の枝の最新の先端にマージしたもので、`~/.cache` 下の使い捨ての worktree と PATH / HOME / `CI=true` / `TMPDIR`（OS の一時ディレクトリの下。`local` の性能の上限を測った場所と同じ、#1056）だけの環境（デーモンの `SWITCHBOARD_*` を持ち込まない）で回し、結果を PR に投稿する: 全部通れば `[local-ci] pass <head sha> base=<base sha>`、落ちたか衝突なら `[local-ci] fail <head sha> base=<base sha>`（[local-ci.md](local-ci.md) の「結果の通知」。実行中に head か base が変われば何も投稿しない）。

merge-gate が local-ci の結果を採るのは次をすべて満たすときだけ（`localCiOf`）:

- `MARK_AUTHORS`（`OWNER` / `MEMBER` / `COLLABORATOR`）のコメントで、1 行目が `LOCAL_CI_RESULT`（`[local-ci] pass|fail <40 桁> base=<40 桁>`）。`base=` の無い前の形の印、コメントの途中の文字列は読まない
- head が PR の今の head、base が base の枝の今の先端（`GET /repos/<owner>/<repo>/git/ref/heads/<base>`。判定のたびに読む。読めなければ判定しない、exit 2）
- その組の結果のうち一番新しいもの（`createdAt`）が `pass`。後から `fail` が付いたら採らない

採れたとき、failure の run のジョブ（`actions/runs/<id>/jobs`）がすべてステップ 0 件ならその run を「<名前>（Actions が始まらず、ローカルで pass）」の SUCCESS と数え、run が 1 つも無ければ「local-ci（Actions の run が無く、ローカルで pass）」の SUCCESS を 1 つ足す。ステップが走って落ちた CI は local-ci があっても FAILURE のまま。failure の run があるとき GitHub は PR を `UNSTABLE` と言うので、そのときは `UNSTABLE` も止める理由にしない（それ以外の状態は今までどおり）。head の結果はあるが採れなかったときは、CI の理由の後に「local-ci の結果が今の base（…）のものでない（base が進んだ。回し直す）」か「local-ci の最新の結果が fail（…）」が続く。下の PR がマージされて自動 rebase が走ると head が変わり、main が進むと base が変わるので、local-ci は回し直す（`pbi-complete` の 5）。別のリポジトリの PR は、そのリポジトリの作業ツリーから `bun <Switchboard の clone>/scripts/local-ci.ts <PR> --repo <owner/name>` で回し（印はそのリポジトリの PR に付く。作業ツリーの `origin` が `--repo` と違えば exit 2。[local-ci.md](local-ci.md)）、`bun scripts/merge-gate.ts <PR> --repo <owner/name>` が同じ規則で数える（#1203）。

### 保護枝とローカルの結果

local-ci の結果は PR コメントで、GitHub の必須チェック（check run / commit status）にはならない。base の枝に必須のステータスチェック（や必須の承認）を設定した保護・ruleset があると、GitHub はローカルの合格があっても PR を `BLOCKED` にし、マージできない。merge-gate はこれを黙って通さず、local-ci で CI を数えたうえで `BLOCKED` なら「mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果は PR コメントで、GitHub の必須チェックにはならない」と止める。merge-gate は保護の設定を読まず（管理者の権限が要り、プランによっては API が使えない）、変えもしない。レビュー・承認・保護の要件は迂回しない。

利用者が設定を確かめる手順（変えるかどうかは利用者が決める）:

1. `gh api repos/<owner>/<repo>/branches/<base> -q .protected` — `false` なら保護は無い。BLOCKED の理由は ruleset か承認の待ち
2. `true` なら、リポジトリの Settings → Branches（または `gh api repos/<owner>/<repo>/branches/<base>/protection/required_status_checks`。管理者のみ）で必須のチェックの名前を見る。Settings → Rules → Rulesets（`gh api repos/<owner>/<repo>/rules/branches/<base>`）の「Require status checks to pass」も同じ
3. Actions が始まらない間は、必須のチェックは満たせない。マージするには、利用者がその間だけ必須を外すか、Actions を回せる状態に戻す。どちらもこのリポジトリのスクリプトはしない

2026-10-21 の開発元: `branches/main` の `protected` は `false`。protection と rules の API は 403（「Upgrade to GitHub Pro …」）。

「最後のコミット」はコミットの author date の最大値。スタックの rebase（`gh stack rebase`、下がマージされたあとの GitHub の自動 rebase）は committer date を変えるが author date は変えないので、rebase だけでは見直しを求めない。修正コミットを足すと author date が進み、見直し（`cross-runner-review`）が要る。
限界: `git commit --amend` は author date を保つので、レビュー後に amend で中身を変えると見直しを求められない。レビュー後の修正は amend せず新しいコミットで積む（`review-triage-and-merge` の 3）。

レビュースレッドは 1 ページ（100 件）だけ読む。それを超える PR は判定できない（exit 2）。

impact が large のときの stop は、`[再チェック <kind>]` の理由ならその種類の再チェックの印で、`[聞く]` の理由は `--allow-large` だけで外れる（上の「利用者に聞く理由と再チェックで外せる理由」）。`--allow-large` を付けるのは利用者が Task の会話でマージを認めたときだけ（`pbi-complete` の 5。マージしてよいかは運用の確認なので Issue の `## 判断待ち` には出さない。`issue-workflow` の「判断待ちの出し方」）。
