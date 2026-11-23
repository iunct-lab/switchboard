---
name: cross-runner-review
<!-- when review=other reviewer=codex -->
description: PR を「実装したのとは別のランナー」（Claude Code が実装したので Codex）にレビューさせる型。レビュアーには会話の文脈を渡さず、fresh clone と PR 情報とレビュー指示だけを渡す。意図と設計の整合、最小性、テスト、そしてセキュリティ・ライセンス・個人情報・公開の読み手の 4 項目を必ず書かせ、PR にコメントとして転記する。PR を出した直後、レビューをやり直すときに読む。前は task-to-pr、次は review-triage-and-merge。
<!-- end when -->
<!-- when review=other reviewer=claude -->
description: PR を「実装したのとは別のランナー」（Codex が実装したので Claude Code）にレビューさせる型。レビュアーには会話の文脈を渡さず、fresh clone と PR 情報とレビュー指示だけを渡す。意図と設計の整合、最小性、テスト、そしてセキュリティ・ライセンス・個人情報・公開の読み手の 4 項目を必ず書かせ、PR にコメントとして転記する。PR を出した直後、レビューをやり直すときに読む。前は task-to-pr、次は review-triage-and-merge。
<!-- end when -->
<!-- when review=same -->
description: PR を「実装したのと同じランナーの新しいセッション」にレビューさせる型（アプリの設定による選択）。レビュアーには会話の文脈を渡さず、fresh clone と PR 情報とレビュー指示だけを渡す。意図と設計の整合、最小性、テスト、そしてセキュリティ・ライセンス・個人情報・公開の読み手の 4 項目を必ず書かせ、PR にコメントとして転記する。PR を出した直後、レビューをやり直すときに読む。前は task-to-pr、次は review-triage-and-merge。
<!-- end when -->
---

# Cross-runner review（実装とは別のセッションに、フラットな立場で）

目的: 実装者の思い込みを共有しないレビュアーに、**差分だけでなく PR の意図**（Task / PBI / docs）を読ませて判断させる。
<!-- when extra=on -->
複数のレビューを集める（主レビュアー 1 + 追加のレビュアー 1。必要なら Claude のサブエージェントも足す: `review-with-subagent`）。
<!-- end when -->
<!-- when extra=off -->
レビューは主レビュアーの 1 つ（必要なら Claude のサブエージェントも足す: `review-with-subagent`）。
<!-- end when -->

## 誰がレビューするか

<!-- when task=out -->
主レビュアーは、アプリのレビューの設定（別のランナー / 同じランナー）と実装したランナーで決まる。アプリの Task が読む写しには、その Task に合う側だけが入る。
アプリの Task の外では設定が届かないので、`review=other`（実装したのとは別のランナー）の側を読む。`reviewer` は主レビュアー（Claude Code が実装したら `codex`、Codex が実装したら `claude`）、`runner` は実装したランナー。
<!-- end when -->
<!-- when review=other reviewer=codex -->
主レビュアーは **Codex**（実装したのは Claude Code。実装したのとは別のランナー）。
<!-- end when -->
<!-- when review=other reviewer=claude -->
主レビュアーは **Claude Code**（実装したのは Codex。実装したのとは別のランナー）。
<!-- end when -->
<!-- when review=same reviewer=claude -->
主レビュアーは **Claude Code の新しいセッション**（実装したのと同じランナー。設定による選択で、別のランナーを求めない）。
<!-- end when -->
<!-- when review=same reviewer=codex -->
主レビュアーは **Codex の新しいセッション**（実装したのと同じランナー。設定による選択で、別のランナーを求めない）。
<!-- end when -->
<!-- when review=same -->

- 材料・実行・転記・4 の見直しは下の手順のまま。**実装時の会話・判断の要約・memory は渡さない**。同じランナーでも別セッションによる独立レビューとして扱い、実装した自分による自己レビューとは区別して報告する。同じランナーのため見落としが重なりうることも記録する
- 要約の 1 行目は `[<runner>] review（同じランナーの別セッション。設定による選択）`（`post_review` の 4 つ目の引数 `（同じランナーの別セッション。設定による選択）`）。利用上限の代替の印（`（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）`）は付けない（上限で替えたのではない）
<!-- end when -->
<!-- when extra=on -->

追加のレビュアー（例: ローカルモデル）は、どちらのランナーが実装したときも呼ぶ。名前（転記の接頭辞にする）は `ops.config.json` の `extraReviewer`、呼び方・材料の上限は CLAUDE.md にある。以下では `<extra>` と書く。
追加のレビュアーを止めておける（例: 環境変数で有効にするローカルモデル）なら、有効の条件も CLAUDE.md に書く。条件が満たされないときは呼ばず（既定の接続先に当てて失敗を待たない）、要約に「<extra>: 無効（<条件>）」と 1 行書く。
<!-- end when -->

## 0. 枠を見る

ランナーの利用上限の見方は CLAUDE.md にある。

<!-- when review=other -->
主レビュアーが利用上限なら、**待たずに実装したランナーの新しいセッションで代替する**。代替は利用者に聞かずに行い、利用者が既に認めた代替・共有の範囲は同じ範囲で聞き直さない。
<!-- end when -->
<!-- when review=other reviewer=codex -->
Codex の 5 時間枠が **0.9 以上**、またはレビュー実行の出力に利用上限が出たら、新しい Claude のセッション（2 の頼み方）で代替する（サブエージェントのレビューはアプリに記録が残らず、判定に数えられない）。記録された枠は古いことがあるので（`resets_at` が過ぎた行は 0）、実行が上限で止まったらその出力を優先する。
<!-- end when -->
<!-- when review=other reviewer=claude -->
Claude の枠（週間上限なども）が上限、またはレビュー実行の出力に利用上限が出たら、新しい Codex のセッション（2 の頼み方）で代替する（サブエージェントのレビューはアプリに記録が残らず、判定に数えられない）。記録された枠は古いことがあるので（`resets_at` が過ぎた行は 0）、実行が上限で止まったらその出力を優先する。
<!-- end when -->
<!-- when review=other -->
main との比較（5）は代替しない。主レビュアーが上限なら停止の報告 `usage-limit` で戻る時刻まで待ってから回す。
<!-- end when -->
<!-- when review=same -->
main との比較（5）も設定どおり実装したランナーの別セッションが回し、上限なら同じく `usage-limit` で止まって待つ。
<!-- end when -->
<!-- when review=other -->

- 材料と指示は 1 と同じ fresh clone と `_review/` だけ（**実装時の会話・判断の要約・memory は渡さない**）。別セッションによる独立レビューとして扱い、実装した自分による自己レビューとは区別して報告する。同じランナーのため見落としが重なりうることも記録する。
<!-- end when -->
<!-- when review=other reviewer=codex task=in -->
- 仕事で代替するなら、代替のランナーを名指しして `--as fallback` を付ける（付けないと、設定と違うランナーとしてアプリが断る）: `ops-kit job request review $N --runner claude --as fallback --cwd "$R" --prompt "$M/prompt.md" --out "$M/claude.md"`
<!-- end when -->
<!-- when review=other reviewer=claude task=in -->
- 仕事で代替するなら、代替のランナーを名指しして `--as fallback` を付ける（付けないと、設定と違うランナーとしてアプリが断る）: `ops-kit job request review $N --runner codex --as fallback --cwd "$R" --prompt "$M/prompt.md" --out "$M/codex.md"`
<!-- end when -->
<!-- when review=other task=out -->
- 直接走らせて代替するなら、2 の代替のランナーの側のコマンド。
<!-- end when -->
<!-- when review=other -->
- 転記は 3 の `post_review` で実際のランナーを who にし、要約の 1 行目を `[<runner>] review（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）` にする（4 つ目の引数）。自己レビューだけでこの印を付けない。
- 4 の修正後の見直しも同じ代替を使い、`WHO` は今回のレビュアー、`PREV` は前回のレビューが実際に書かれたファイルにする（ランナーを替えても `PREV` を今回の名前に替えない）。責務などの再チェックで指定ランナーが上限なら、上限でない側の新しいセッションに、その手順が定める材料を渡す。主レビューとは別のセッションで行う。
- 代替も利用上限なら、未レビューのままマージせず、運用の確認として Task の会話で止める。追加認証が要るレビューを自動で選ばない。
<!-- end when -->
<!-- when review=same -->
主レビュアーは実装したランナーと同じ枠を使うので、上限の代替は無い（別のランナーへ替えない。設定が同じランナーを選んでいる）。記録された枠は古いことがあるので（`resets_at` が過ぎた行は 0）、レビューの実行が上限で止まったらその出力を優先する。上限なら、未レビューのままマージせず、利用上限で止まったと報告して止まる。追加認証が要るレビューを自動で選ばない。
<!-- end when -->

## 1. 材料を用意する（会話の文脈は渡さない）

レビュアーには**この clone とこのファイルだけ**を見せる。自分の会話・Task 実装時の判断・memory は渡さない。
レビュアーの起動（2）は、clone の `CLAUDE.md`・`AGENTS.md`（実装者向けの決まり）と、利用者のメモリ・MCP・スキル・プラグインを読ませない。設計ルールは `_review/design-rules.md` で渡す。

clone の前に、切れたセッションが残した clone のうち終わった PR の分を消し、置き場（下の `REVIEW_ROOT`。ディスク上で、RAM の `/tmp` ではない）の空きを見る。消すのは**同じリポジトリ名**の `review<PR番号>` / `recheck<PR番号>` のうち `gh` で MERGED / CLOSED と確かめたものだけ（open の PR、`gh` で確かめられなかった番号、別のリポジトリ名の clone は残す。別のセッションが使っているかもしれない）。
置き場の分は、マシンの作り直しと、sb-rescue が動くマシンの定期の片付け（`rescue/src/cache.ts` の `sweepCacheWork`。長く使われていない分。clone は PR が closed と確かめられた分だけ、下の「ローカルの変更では」の worktree は PR に聞かずに）でも消える。消えていたらこの節を流し直す。
`STOP:` が出たら clone せず、`du` の上位をそのまま利用者に報告して止まる（消すのは利用者。別のリポジトリの分・動いているセッションの分を自分で消さない）。

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
NAME=${REPO#*/}; MIN_KB=512000   # 同じリポジトリ名の分だけ。閾値 500 MB
REVIEW_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/ops-kit/review"; mkdir -p "$REVIEW_ROOT"
for d in "$REVIEW_ROOT/$NAME".review[0-9]* "$REVIEW_ROOT/$NAME".recheck[0-9]*; do  # 終わった PR の分だけ消す
  [ -d "$d" ] || continue
  n=${d##*/}; n=${n#"$NAME".}; n=${n#review}; n=${n#recheck}
  case $n in ''|*[!0-9]*) continue;; esac
  s=$(gh pr view "$n" -R "$REPO" --json state -q .state) || continue   # 確かめられなければ残す
  case $s in MERGED|CLOSED) echo "rm $d ($s)"; rm -rf "$d";; esac
done
AVAIL=$(df -Pk "$REVIEW_ROOT" | awk 'NR==2{print $4}')
[ "$AVAIL" -ge "$MIN_KB" ] || { echo "STOP: $REVIEW_ROOT の空きが ${AVAIL} KB（${MIN_KB} KB 未満）。clone しない"; du -sk "$REVIEW_ROOT"/* 2>/dev/null | sort -rn | head -10; }
```

```bash
N=<PR番号>; KIND=review   # 再チェック（マージ判定の Recheck）で 1〜3 を流すときは KIND=recheck（主レビューの clone は 4 の見直しまで残すので消さない）
R="${REVIEW_ROOT:?}/${NAME:?}.${KIND:?}${N:?}"; echo "$R"   # 再開して新しいシェルで R を作り直すときは、上のブロックの REVIEW_ROOT・NAME とこの行の代入まで（次の行は流さない）
rm -rf "$R"   # 初回だけ: 同じ PR のやり直しは前のものを消して 1 つのまま。clone が作るので mkdir しない
HEAD_REF=$(gh pr view $N --json headRefName -q .headRefName); BASE_REF=$(gh pr view $N --json baseRefName -q .baseRefName)
gh repo clone "$REPO" "$R" -- -q --branch "$HEAD_REF"
M="$R/_review"; mkdir -p "$M"   # untracked。レビュアーはここを読む
gh pr view $N --json number,title,body,url -q '"# PR #\(.number) \(.title)\n\(.url)\n\n\(.body)"' > "$M/pr.md"
gh pr diff $N > "$M/diff.patch"
TASK=$(tr -d '\r' < "$M/pr.md" | grep -oE 'Closes #[0-9]+' | head -1)   # Closes #N（GitHub の workspace）→
[ -n "$TASK" ] || TASK=$(tr -d '\r' < "$M/pr.md" | grep -oE 'Refs #[0-9]+' | head -1)   # Refs #N（Task の手順が残る PR）→
[ -n "$TASK" ] || TASK=$(tr -d '\r' < "$M/pr.md" | grep -oE '^Backlog-Task: [0-9]+$' | head -1)   # 単独行の Backlog-Task: N（ローカルのバックログ）
TASK=$(echo "$TASK" | grep -oE '[0-9]+' | head -1)
ops-kit backlog view "$TASK" --fresh > "$M/task.md"
PBI=$(awk '/^## 親 PBI/{f=1;next} f && match($0,/#[0-9]+/){print substr($0,RSTART+1,RLENGTH-1); exit}' "$M/task.md")
ops-kit backlog view "$PBI" --fresh > "$M/pbi.md"
sed -n '/^## Design rules/,/^## License/p' "$R/README.md" > "$M/design-rules.md"   # 設計ルールの場所が CLAUDE.md にあればそれに合わせる
ls "$R/docs/design" > "$M/design-docs.txt"
# 道具が作る材料（4 の見直しでも作り直す）
ops-kit review-handled $N --kind "$KIND" > "$M/handled.md"; [ -s "$M/handled.md" ] || rm -f "$M/handled.md"   # 前の回までの指摘と処理。無ければ作らない
( cd "$R" && ops-kit old-paths check "origin/$BASE_REF" "$M/pr.md" ) > "$M/old-paths.md"   # PR 本文の「古い前提を持つ既存の箇所」の語で探し直した箇所（exit 1 でも続ける）
```

<!-- when mergeGate=on -->
マージ判定が名指しの外のファイルを数えるリポジトリでは、その一覧も材料にする（`<マージ判定>` は CLAUDE.md のコマンド。空なら作らない。ローカルの変更では `--change <変更> --scope`）:

```bash
<マージ判定> $N --scope > "$M/scope.md"; grep -q . "$M/scope.md" || rm -f "$M/scope.md"
```
<!-- end when -->

**ローカルの変更では**（`task-to-pr` の「ローカルの変更では」の workspace）: clone の代わりに `git worktree add --detach "$R" <枝>`（`NAME=$(basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")`（どの worktree から流しても main の作業ツリーのディレクトリの名前）、`REVIEW_ROOT`・`KIND`・`R=` の行は上のまま。`rm -rf "$R"` の代わりに `git worktree remove --force "$R" 2>/dev/null; git worktree prune; [ "$(git -C "$R" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$R" 2>/dev/null && pwd -P)" ] || rm -rf "$R"` で前のものを外してから（`rm -rf` は git に登録されていない残骸だけ。名前が同じほかのリポジトリの生きた worktree は消さず、`git worktree add` が止まる）。終わったら `git worktree remove`）、`REPO=$(gh repo view …)`・古い clone の片付けのループ・`gh repo clone`・`gh pr view` の行は飛ばす（`gh` を呼ばない。GitHub の同じ番号の別の Issue に触らない）。`HEAD_REF` / `BASE_REF` は `ops-kit backlog view <変更>` の出力の `変更: <head> → <base>` の行から入れる（`<枝>` は `<head>`）。PR の情報は `ops-kit backlog view <変更> > "$M/pr.md"`（4 の見直しの前にも同じ行で取り直す）、差分は `git diff "$BASE_REF...$HEAD_REF" > "$M/diff.patch"`。転記（3）は `gh pr comment` / インラインの代わりに、1 行目を `[<runner>] review` にしたレビューの全文を `ops-kit backlog comment <変更> --body-file <ファイル>` で 1 件。修正後の見直し（4）の差分は `git diff <前回の head>..<枝>`。main との比較（5）の材料の `handled.md` は同じく `ops-kit backlog view <変更> --fresh`、`DEFAULT=` と `git fetch` の行は飛ばし、`main.txt` は `git -C "$R" rev-parse "$BASE_REF" > "$M/main.txt"`（`origin/` を付けない）、転記は `ops-kit backlog comment <変更> --body-file <ファイル>` で、1 行目を `[<runner>] compare` にして全文を 1 件。`handled.md` は見直しの前に `ops-kit backlog view <変更> --fresh > "$M/handled.md"`（変更へのコメントに振り分けの表がある。`ops-kit review-handled` は呼ばない）、`old-paths.md` は上の行の `origin/$BASE_REF` を `$BASE_REF` にして作る。

レビュー指示（`$M/prompt.md`）。**4 項目（security / license / personal data / public readers）は「none」でも必ず書かせる**。

セキュリティの頼み方: 攻撃の手順（攻撃シナリオの列・ペイロード・コマンドの全文）を書かせない。「どのルートに認証・認可・宛先の検査が無いか」「どこで何を検査すべきか」「既存の防御」の形で書かせる（攻撃シナリオの列を求めると報告全体が攻撃手順の形になり、ランナーの安全装置が報告を途中で止める）。止まったら「続きだけ、防御側の表現で」と頼み、残りは自分で埋める。セキュリティを見るほかの指示（`public-release-gate` など）も同じ:

````bash
cat > "$M/prompt.md" <<'PROMPT'
You are reviewing a pull request in this repository with no prior context. Do not assume anything about the author's intent
beyond what the files below say. Read, in this order, under `_review/`: `pr.md` (the PR description), `task.md` (the Task
issue it closes), `pbi.md` (the parent PBI: user story, acceptance criteria, out of scope, decision log), `design-rules.md`
(the repository's design rules), `handled.md`, `old-paths.md` and `scope.md` when they exist, then `diff.patch`. Then read the surrounding code in the working tree (this checkout is the
PR's head branch) and any `docs/design/*.md` that covers the touched area (`_review/design-docs.txt` lists them). Do not skim.
Do not install dependencies (no `bun install` / `npm install`): review without `node_modules`.

Judge the PR on these, in this order:
1. Intent: does the diff do what the Task's 手順 and the PBI's acceptance criteria ask — no less, and nothing beyond it?
   Name anything the PR does that no criterion asks for, and any criterion the PR claims but does not meet.
   Check that every point where the PR departs from the Task's 手順 or the acceptance criteria is written in the PR body's 逸脱 item and in a comment on the Task, and that every change the Task does not list is named in the PR body; report one that is not written as a finding.
   For each file `_review/scope.md` lists (outside the Task's named paths), say whether the Task's purpose needs it or it is a mix-in from another Task; a mix-in or incidental change is `[should-fix]`.
   If the diff changes design documents (e.g. `docs/design/*.md`), say whether each change is within the PBI's acceptance criteria and the original request (`pbi.md`); list out-of-scope edits as `[should-fix]`.
2. Design consistency: contradictions with `design-rules.md`, the relevant `docs/design/*.md`, the PBI's スコープ外 and
   決定ログ, or the existing shape of neighbouring code. Flag compatibility layers, one-use abstractions,
   just-in-case feature or path toggles (not overrides for values that depend on the environment or usage, such as sizes, counts, periods, intervals, limits — the design check expects those to be derived or overridable),
   per-adapter branches, new tables/endpoints where an existing one would do.
   Conditions to keep: when the PBI's 決定ログ lists 守る条件 with their entry points, and the Task has a `守る条件:` line, check
   that the diff keeps each of the Task's conditions at every listed entry point and that the test the Task names for it
   joins the real implementations of both sides (only an outside service faked). Report as `[should-fix]` a listed entry
   point the diff leaves open, and an entry point you find by searching that the list lacks.
   Flag any diff that copies a value the running app owns and can change (a registered schedule's cron/prompt/budget/runner,
   a settings value or default, a default model name) into docs/skills/templates/CLAUDE.md; point to its source instead.
3. Correctness: concrete bugs with a failure scenario (input/state → wrong output). Reproduce claims by reading the code.
4. Tests: does a test cover each changed behaviour? Would it fail without the change?
5. MANDATORY, even when the answer is "none":
   - security: secrets or tokens in the diff; path traversal; anything that weakens Origin/auth checks; command or
     SQL injection; defaults that skip a user's approval; active content served without sandboxing; unsafe file writes.
   - license: vendored or copied third-party code; new dependencies and their licenses (must be compatible with this repository's license);
     generated protocol files from vendors.
   - personal data: absolute paths with a username, e-mails, real names, session ids, hostnames, tokens — in code,
     fixtures, docs, screenshots.
   - public readers: read `publicSync` in the root `ops.config.json`. For the changed lines of documents (`*.md`) under an `include` entry and not under an `exclude` entry
     — leaving out the files read as instructions for development (`CLAUDE.md`, `AGENTS.md`,
     skills, issue and PR templates) — read them as a stranger who does not know this repository's development. List, one line each as
     `[should-fix]`, anything such a reader cannot use: the maintainer's hosts, measurement or review history, per-commit differences,
     commit hashes, issue numbers the reader cannot open, internal operating practice. Write none when there is no `publicSync` or
     no such line.

Output exactly this Markdown, nothing else:

### Findings
- [blocker|should-fix|nit|question] `path/from/repo/root.ts:LINE` — one sentence. Scenario: what input/state leads to what wrong result.
(one line per finding; LINE is a line in the new file; write `- none` if there are no findings)
### Intent and design
(3–8 sentences: what the PR is for, whether it stays inside the Task, contradictions found or "none")
### Security / License / Personal data
- security: none | finding
- license: none | finding
- personal data: none | finding
- public readers: none | finding
### Read outside the diff
- `path:function` (or `- none`)
### Verdict
(one line: mergeable as is / mergeable after the should-fix items / not mergeable — and why)
PROMPT
````

指示（`prompt.md`・再チェックの追加の文）には書かず、起動のときに指示の後ろへ足される文（`ops-kit review-note <runner>`）が持つもの: 何かを走らせてよいか（実際にレビューするランナーの側だけ。0 の代替でも合う側が入る）、指摘の重さの定義、`handled.md`・`old-paths.md` の使い方、同じ論点の繰り返しに付ける `Repeat of:`。主レビュー・4 の見直し・再チェックのどれにも同じ文が足される。

## 2. 走らせる

<!-- when task=in -->
主レビュアーは自分のシェルで走らせず、アプリに仕事として頼む（`ops-kit job request review`。レビュアーの呼び出しと指示の後ろの文は、アプリの側が組む）。`--prompt` を読み `--out` に書く（どちらも `--cwd` の中。`--cwd` は `$R`）:

<!-- end when -->
<!-- when task=in reviewer=codex -->
```bash
ops-kit job request review $N --runner codex --cwd "$R" --prompt "$M/prompt.md" --out "$M/codex.md"
```
<!-- end when -->
<!-- when task=in reviewer=claude -->
```bash
ops-kit job request review $N --runner claude --cwd "$R" --prompt "$M/prompt.md" --out "$M/claude.md"
```
<!-- end when -->
<!-- when task=in -->

request が出す `job#<id>` と JSON を止まりの報告に書き（reason `depends`・conditions に `job#<id>`）、ターンを終える。レビューが終わるとアプリが結果の要約を添えて再開するので、`--out` のファイルを読んで 3 の転記に進む。
主レビュアーは、頼んだ時点のレビューの設定と Task のランナーからアプリが決める。違うランナーを名指しすると断られ、断りの文が正しいランナーを言う（その文のランナーで頼み直し、出力のファイル名と転記の名前もそのランナーにする）。主レビュアーでないランナーに頼むのは、理由を `--as` で言うときだけ（再チェックは `--as recheck --kinds <kind>`（`--kinds` の無い依頼は受けられるが種類なしで記録され、判定でどの再チェックも満たさない）、マージ後の監査は `--as audit`。0 の代替があるときはそこに書いた形）。

マージ判定が数えるのは、レビューの仕事の記録（head と、出力の `### Findings` の節の指摘）。PR への投稿（`post_review`）は人が読むため。主レビュー・攻める側・再チェックを仕事で頼まず自分のシェルで回した結果は判定に数えられない。アプリが持つ変更（ローカルの変更）のレビューと `local-ci` は `--change` を付けて頼む。
<!-- end when -->
<!-- when task=out -->
アプリの Task の外では直接走らせる。読み取り専用 sandbox、会話は保存しない、出力はファイルへ。1 のとおり clone の決まりと利用者の MCP・スキルを読ませない引数を付け、指示の後ろに `ops-kit review-note <runner>` の文を足す（アプリに仕事として頼むレビューには、アプリが同じ引数と文を付ける）。Codex がレビュアーのとき:

```bash
CODEX=$(command -v codex)
( cd "$R" && { cat "$M/prompt.md"; echo; ops-kit review-note codex; } | ops-kit heavy --memory-only --name "review codex" -- ops-kit idle-run --idle 900 -- "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -c project_doc_max_bytes=0 -c 'mcp_servers={}' --disable plugins --disable apps -o "$M/codex.md" - ) > "$M/codex.log" 2>&1
```

Claude Code がレビュアーのとき（plan モード、読み取り専用）:

```bash
( set -o pipefail; cd "$R" && ops-kit heavy --memory-only --name "review claude" -- ops-kit idle-run --idle 900 -- env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p --permission-mode plan --strict-mcp-config --disable-slash-commands --output-format stream-json --verbose "$(cat "$M/prompt.md"; echo; ops-kit review-note claude)" | tee "$M/claude.jsonl" | jq -r 'select(.type=="result").result' ) > "$M/claude.md" 2> "$M/claude.log"
```
<!-- end when -->

**固まったとき**（仕事の結果の要約に exit 124 が出る）: `ops-kit idle-run` は、レビュアーが決まった秒数（仕事はアプリの設定）何も出さないとプロセスごと切り、exit 124 で返す（総時間の上限は無い）。exit 124 なら `$M/<runner>.md` を転記せず、理由を PR コメントに残して一度だけやり直す。やり直しでも切れたら止まって報告する:
<!-- when task=out -->
直接走らせるときは `--idle 900`。切った理由の行は log に残る。text 出力の `claude -p` は最後まで何も出さないので、stream-json で動いていることを見る。
<!-- end when -->

```bash
gh pr comment $N --body "[<runner>] 無進捗で打ち切り（<秒> 秒出力なし）。レビューは付いていない"
```

ローカルの変更では同じ文を `ops-kit backlog comment <変更> --body-file -` で書く。

<!-- when extra=on -->
**追加のレビュアー**（`ops.config.json` の `extraReviewer` が名指しし、有効の条件を満たしていれば、どちらのランナーが実装したときも）。呼び方・材料の上限は CLAUDE.md。
この clone を読めないレビュアー（コンテナの中のローカルモデルなど）には、材料を prompt に埋める。diff のほかに **Task / PBI が名指しする `docs/design/*.md` と、diff が触るファイルの全文**（変更後）を入れる（設計との矛盾は diff だけでは見えない）。
上限を超えるぶんは「[truncated: <file> …]」と書き、切ったファイルを要約コメントに列挙する — そのレビュアーのレビューはその範囲について、と読む。全部を見るのは主レビュアー。出力は `$M/<extra>.md` に書く。

<!-- end when -->
<!-- when task=in -->
主レビュアーを仕事に頼んだらそこでターンを終える（背景の `sleep` や `run_in_background` の待ちのループで待たない。セッションが閉じずメモリを開き続ける）。
<!-- end when -->
<!-- when task=in extra=on -->
追加のレビュアー（`curl`）は枠を通さないので仕事にしない。主レビュアーを先に頼み、そのあと自分のシェルの前景で `curl -m` を切って走らせ、終わるか切れてからターンを終える（主レビュアーの仕事を `curl` の後ろで待たせない。背景で走らせるとセッションが閉じない）。
<!-- end when -->
<!-- when task=out -->
直接走らせるとき（アプリの Task の外）はバックグラウンドで始めてよい（Bash の `run_in_background`）。Bash の timeout はメモリの待ちとレビューが終わるまで切らない長さ（上限いっぱい）にする。切るのは `idle-run`。外から切られると理由が残らない。
<!-- end when -->
<!-- when task=out -->
レビューは重い処理の枠（席）を取らず、空きメモリが下限を割る間だけ待つ（`--memory-only`。レビューの走りは 1 分前後で、席の待ちは数分〜数時間になるため。キットの README の「Heavy-process slots」）。`ops-kit heavy` は `idle-run` の外側に置く（メモリを待つ間は無進捗に数えない）。
<!-- end when -->
**マージを止めるのは主レビュアーだけ。**
<!-- when extra=on -->
追加のレビュアー（ローカルモデルなら 50KB の材料で 10 分以上かかることがある）は終わっていなくても先に進み、後から届いたら転記して主レビュアーとの比較に使う（2026-09-18 の利用者の指示）。
<!-- end when -->
終わったら各出力に `### Findings` があるか見る。無ければ（枠切れ、sandbox で止まった、モデルが形式を守らなかった）ログ（Claude Code は `$M/claude.jsonl` も）を読んで一度だけやり直す。

## 2b. 攻める側のレビュー（安全に関わる PR だけ）

PR を出した直後、主レビューを頼むのと同じ時点で `bun scripts/merge-gate.ts <PR>`（`--merge` なし。ローカルの変更では `--change <変更>`）を流し、出力の JSON の `attack`（当たったパスの一覧）が空でなく、reasons に攻める側のレビューが無いという行があれば、主レビューと同時にもう 1 回、攻める側のレビューを頼む。`attack` が無い PR では頼まない。スタックではその PR を出した直後に頼み、最後にまとめない。主レビューの `prompt.md` に混ぜない（5 項目の 1 行に戻り、主レビューと同じ材料で薄まる）。

- 材料は 1 の同じ clone と `_review/`。指示だけを `ops-kit review-attack prompt` で作る（指示の文をここに写さない）: `ops-kit review-attack prompt > "$M/attack-prompt.md" && [ -s "$M/attack-prompt.md" ]`。失敗か空なら頼まず止まって報告する
<!-- when review=other -->
- レビュアーは主レビュアーと同じ（実装したのとは別のランナー）。別ランナーが上限なら同じランナーに替えず、戻る時刻まで停止の報告 `usage-limit` で待つ
<!-- end when -->
<!-- when review=same -->
- レビュアーは主レビュアーと同じ（設定どおり、同じランナーの新しいセッション）
<!-- end when -->
<!-- when task=in -->
- 仕事として頼む（理由は `--as attack`。2 と同じ止まり方）: `ops-kit job request review $N --runner <主レビュアーのランナー> --as attack --cwd "$R" --prompt "$M/attack-prompt.md" --out "$M/attack.md"`
<!-- end when -->
<!-- when task=out -->
- 直接走らせる（2 のコマンドの `prompt.md` を `attack-prompt.md` に、出力を `attack.md` に替える）
<!-- end when -->
- 出力に `### Findings` が無ければ転記しない（空でも要約が付く。判定が数えるのは仕事の記録で、Findings の節の無い出力は満たさない）。2 と同じく一度だけやり直す
- 転記は 3 の `post_review` を、1 行目だけ `[<runner>] attack` にして（`printf '[%s] review%s\n\n'` を `printf '[%s] attack%s\n\n'` に替えた関数を、使う呼び出しの中で定義する）: `post_review_attack $N <runner> "$M/attack.md"`。`[<runner>] review` では転記しない（マージ判定は主レビューと攻める側を別に数える）。ローカルの変更では、転記先は変更へのコメント（`ops-kit backlog comment <変更> --body-file -`）で、1 行目は同じ `[<runner>] attack`
- 4 の修正後の見直しと同じく、修正を積んだら修正の差分（`fix.range-diff`）で攻める側の見直しを頼み直す（判定は、PR の今の head かそのコミットが同じ差分で入った head で合格した攻める側の仕事の記録を求める）。4 のブロックで `prompt.md`→`attack-prompt.md`、`prompt-fix.md`→`attack-prompt-fix.md`、`PREV=_review/attack.md`、出力 `attack-fix.md`、`--as attack`、`post_review_attack` に替える

## 3. PR に転記する

レビュアーはファイルを変えず PR にも書かない。**自分がレビュアーの名前の接頭辞つきで転記する**（`[<runner>]`。下の `post_review` の 2 つ目の引数）。Findings の各行はインラインに、残りは要約コメントに:

```bash
post_review() { # <pr> <who> <file> [1 行目の印の続き]   ※ スクリプトとして保存せず、使う呼び出しの中で定義する（別のセッションに上書きされる）。※ 変数名に path を使わない（zsh では $path が PATH に結ばれ、local path で全コマンドが見えなくなる）
  local pr=$1 who=$2 f=$3 note=${4:-} sha line rel ln
  sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
  grep -E '^- \[(blocker|should-fix|nit|question)\] `[^`]+:[0-9]+`' "$f" | while IFS= read -r line; do
    rel=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\1/' <<<"$line"); ln=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\2/' <<<"$line")
    gh api "repos/{owner}/{repo}/pulls/$pr/comments" -f path="$rel" -F line="$ln" -f side=RIGHT -f commit_id="$sha" -f body="[$who] $line" >/dev/null 2>&1 \
      || gh pr comment "$pr" --body "[$who] $line（差分外の行のため一般コメント）" >/dev/null
  done
  { printf '[%s] review%s\n\n' "$who" "$note"; sed -n '/^### Intent and design/,$p' "$f"; } | gh pr comment "$pr" --body-file - >/dev/null
}
<!-- when review=other reviewer=codex -->
post_review $N codex "$M/codex.md"   # 0 の代替で頼んだときは、実際のランナーとそのファイル、4 つ目の引数に代替の印
<!-- end when -->
<!-- when review=other reviewer=claude -->
post_review $N claude "$M/claude.md"   # 0 の代替で頼んだときは、実際のランナーとそのファイル、4 つ目の引数に代替の印
<!-- end when -->
<!-- when review=same reviewer=codex -->
post_review $N codex "$M/codex.md" '（同じランナーの別セッション。設定による選択）'
<!-- end when -->
<!-- when review=same reviewer=claude -->
post_review $N claude "$M/claude.md" '（同じランナーの別セッション。設定による選択）'
<!-- end when -->
<!-- when extra=on -->
post_review $N <extra> "$M/<extra>.md"
<!-- end when -->
```

転記したら Task の Issue に 1 行（「レビュー: <レビュアーごとの件数>、要約は PR」。`ops-kit backlog comment <Task> --body-file -`）。`$R` は**まだ消さない**（4 の見直しで使う）。
転記した時点の head を `OLD` として控える: `git -C "$R" rev-parse HEAD`（値を文字で控える。Bash の呼び出しをまたぐと変数は消える）。

## 4. 修正後の見直し

レビューのあとに修正コミットを積んだら、**マージ前に主レビュアーに見直させる**。マージ判定（CLAUDE.md のコマンド）は「今の head（かそのコミットが同じ差分で入った head）で合格した主レビュアーの仕事の記録」が無い PR を止める。
材料は**この PR の修正コミットだけ**の差分、前回のレビュー、作り直した `handled.md` と `old-paths.md`（5 の `$M/compared.md` があれば残す。レビューの文（`REVIEW_RULES`）が読む）。出力形式は 1 と同じ:

```bash
# R・M・HEAD_REF・BASE_REF は 1 で作ったもの。OLD = 3 で控えた、前回レビューした head（fetch の前に控えておく）
git -C "$R" fetch -q origin "$HEAD_REF" "$BASE_REF"
gh pr view $N --json number,title,body,url -q '"# PR #\(.number) \(.title)\n\(.url)\n\n\(.body)"' > "$M/pr.md"   # 修正の後の PR 本文を取り直す
NEW=$(git -C "$R" rev-parse "origin/$HEAD_REF")
# cascade の後でも、この PR のコミットだけを比べる（それぞれの base からの差分どうし）
git -C "$R" range-diff "$(git -C "$R" merge-base "$OLD" "origin/$BASE_REF")..$OLD" "$(git -C "$R" merge-base "$NEW" "origin/$BASE_REF")..$NEW" > "$M/fix.range-diff"
# range-diff は足しただけのコミットを 1 行でしか出さないので、修正の中身も同じファイルに足す
{ printf '\n# git diff %s %s (after a rebase this also carries base changes; the range-diff above has only this PR commits)\n' "$OLD" "$NEW"; git -C "$R" diff "$OLD" "$NEW"; } >> "$M/fix.range-diff"
git -C "$R" checkout -q "$NEW"
# 1 と同じ 2 行
ops-kit review-handled $N --kind review > "$M/handled.md"; [ -s "$M/handled.md" ] || rm -f "$M/handled.md"
( cd "$R" && ops-kit old-paths check "origin/$BASE_REF" "$M/pr.md" ) > "$M/old-paths.md"
<!-- when reviewer=codex -->
PREV=_review/codex.md   # 前回のレビューが実際に書かれたファイル（0 の代替で書かれたならそのファイル）
<!-- end when -->
<!-- when reviewer=claude -->
PREV=_review/claude.md   # 前回のレビューが実際に書かれたファイル（0 の代替で書かれたならそのファイル）
<!-- end when -->
{ cat "$M/prompt.md"; echo; echo "This is a follow-up review. The PR was already reviewed at $OLD; your previous review is $PREV."; \
  echo "Review only _review/fix.range-diff (this PR's commits since then): do the fixes address the findings, and do they introduce new problems?"; \
  echo "Use the same output format."; } > "$M/prompt-fix.md"
rm -f "$M/fix-review.md"   # 切れたときに前回の出力を転記しない
<!-- when task=in reviewer=codex -->
# ここで仕事に頼み（2 と同じ）、job#<id> を止まりの報告に書いてターンを終える（この下の行はまだ流さない）。再開したら、新しいシェルで R・M・N と下の NOTE を作り直し（R は 1 の代入の行まで。`rm -rf "$R"` の行は流さない）、WHO=codex、RC=<結果の要約の exit> を置いて、下の最後の行（転記）から続ける:
#   ops-kit job request review $N --runner codex --cwd "$R" --prompt "$M/prompt-fix.md" --out "$M/fix-review.md"
<!-- end when -->
<!-- when task=in reviewer=claude -->
# ここで仕事に頼み（2 と同じ）、job#<id> を止まりの報告に書いてターンを終える（この下の行はまだ流さない）。再開したら、新しいシェルで R・M・N と下の NOTE を作り直し（R は 1 の代入の行まで。`rm -rf "$R"` の行は流さない）、WHO=claude、RC=<結果の要約の exit> を置いて、下の最後の行（転記）から続ける:
#   ops-kit job request review $N --runner claude --cwd "$R" --prompt "$M/prompt-fix.md" --out "$M/fix-review.md"
<!-- end when -->
<!-- when task=out -->
# アプリの Task の外では直接走らせる（引数と指示の後ろの文は 2 と同じ）
CODEX=$(command -v codex)
# Codex がレビュアーのとき
( cd "$R" && { cat "$M/prompt-fix.md"; echo; ops-kit review-note codex; } | ops-kit heavy --memory-only --name "review codex" -- ops-kit idle-run --idle 900 -- "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -c project_doc_max_bytes=0 -c 'mcp_servers={}' --disable plugins --disable apps -o "$M/fix-review.md" - ) > "$M/fix-review.log" 2>&1; RC=$?; WHO=codex
# Claude Code がレビュアーのときは上の代わりに:
# ( set -o pipefail; cd "$R" && ops-kit heavy --memory-only --name "review claude" -- ops-kit idle-run --idle 900 -- env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p --permission-mode plan --strict-mcp-config --disable-slash-commands --output-format stream-json --verbose "$(cat "$M/prompt-fix.md"; echo; ops-kit review-note claude)" | tee "$M/fix-review.jsonl" | jq -r 'select(.type=="result").result' ) > "$M/fix-review.md" 2> "$M/fix-review.log"; RC=$?; WHO=claude
<!-- end when -->
<!-- when review=other -->
NOTE=   # 0 の代替で頼んだ見直しは、0 の転記と同じ 1 行目の印の続きを入れる
<!-- end when -->
<!-- when review=same -->
NOTE='（同じランナーの別セッション。設定による選択）'
<!-- end when -->
[ "$RC" = 0 ] && grep -q '^### Findings' "$M/fix-review.md" && post_review $N $WHO "$M/fix-review.md" "$NOTE" \
  || echo "見直しが exit $RC か、出力に ### Findings が無い（打ち切り・枠切れ・sandbox）。ログを読んで一度だけやり直す。空のまま転記しない"
```

exit 124 の扱いは 2 と同じ。**`### Findings` の無い出力は転記しない**（`post_review` は中身が空でも要約を書き、人には見直し済みに見える）。
rebase だけ（`gh stack rebase`、下のマージ後の GitHub の自動 rebase）なら見直しは要らない（判定は同じ差分で入った head も数える）。見直しで新しい指摘が出たら `review-triage-and-merge` の 2 から。
見直しが済んで採否が終わったら `rm -rf <1 で作った $R のパス>`（`review*` のような glob で消さない。切れたセッションの残りは次のレビューの 1 が消す）。

## 5. main との比較（指摘が収束しないとき）

使いどころは `review-triage-and-merge` の「収束しないとき（main との比較）」。残る blocker / should-fix を主レビュアーが 1 件ずつ既定の枝と読み比べて分類する回で、PR 全体は読み直さない（主レビューの代わりにならない）。スタックは一番上の PR で 1 回。

上限のときは 0 のとおり。

1 と同じ clone（`KIND=review`）に材料を足す:

```bash
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)   # 既定の枝
git -C "$R" fetch -q origin "$DEFAULT"
ops-kit review-compare prompt > "$M/prompt-compare.md"
cp "$M/<runner>.md" "$M/latest-review.md"   # 直近の回の出力（4 の見直しがあれば fix-review.md）
ops-kit review-handled $N --kind review > "$M/handled.md"; [ -s "$M/handled.md" ] || rm -f "$M/handled.md"   # 作り直す
git -C "$R" rev-parse "origin/$DEFAULT" > "$M/main.txt"
rm -f "$M/compared.md"   # 切れたときに前回の出力を使わない
```

<!-- when task=in reviewer=codex -->
主レビュアーに頼む（2 と同じ。`job#<id>` で止まる）:

```bash
ops-kit job request review $N --runner codex --cwd "$R" --prompt "$M/prompt-compare.md" --out "$M/compared.md"
```
<!-- end when -->
<!-- when task=in reviewer=claude -->
主レビュアーに頼む（2 と同じ。`job#<id>` で止まる）:

```bash
ops-kit job request review $N --runner claude --cwd "$R" --prompt "$M/prompt-compare.md" --out "$M/compared.md"
```
<!-- end when -->
<!-- when task=out -->
アプリの Task の外では 2 と同じ直接の実行で、`$M/prompt.md` を `$M/prompt-compare.md` に、出力を `$M/compared.md` に替える。
<!-- end when -->

出力を道具で読む。`check` の exit は 0 = 後退なし / 1 = 後退あり（後退の行を出す）/ 2 = 分類の節が無い・読めない行がある:

```bash
ops-kit review-compare check "$M/compared.md"; echo $?   # 2 なら一度だけやり直す（2 の「固まったとき」と同じ）。2 のままなら転記せず止まって報告する
```

転記は PR への 1 件のコメントで、**1 行目を `[<runner>] compare`**、続けて出力の全文。インラインにしない（`post_review` を使わない）。`[<runner>] review` で始めない（主レビューの要約と取り違える。比較は全体を読んでいない）:

```bash
{ printf '[<runner>] compare\n\n'; cat "$M/compared.md"; } | gh pr comment $N --body-file -
```

`$M/compared.md` は 4 の見直しの材料として残す。後退の直しと要望への回し方は `review-triage-and-merge` の同じ節。

## 報告（利用者への返事の型）

```
<!-- when extra=off -->
PR #<n> のレビュー: <runner> <k> 件（blocker a / should-fix b / nit c / question d）。4 項目: security <none|…> / license <…> / personal data <…> / public readers <…>
Verdict: <runner>「…」
<!-- end when -->
<!-- when extra=on -->
PR #<n> のレビュー: <runner> <k> 件（blocker a / should-fix b / nit c / question d）、<extra> <k'> 件。4 項目: security <none|…> / license <…> / personal data <…> / public readers <…>
Verdict: <runner>「…」、<extra>「…」
<!-- end when -->
次: review-triage-and-merge
```

## やらないこと

- 実装した自分（同じ会話）だけでレビューを済ませる
- レビュアーに会話の要約や「ここは意図的」といった弁明を渡す（採否のときに自分が返信する）
- 4 項目（security / license / personal data / public readers）の無いレビューを「レビュー済み」と数える
- `handled.md`・`old-paths.md` を作らずに見直し・再チェックを頼む
- 枠切れの主レビュアーを飛ばしてマージに進む（0 のとおり。レビューできなければ未レビューとして止める）
<!-- when extra=on -->
- 追加のレビュアーを待ってマージを止める（待たなくてよい。止めるのは主レビュアーだけ）
<!-- end when -->
