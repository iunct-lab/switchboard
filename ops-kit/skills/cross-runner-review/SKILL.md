---
name: cross-runner-review
description: PR を「実装したのとは別のランナー」（と、あれば追加のレビュアー）にレビューさせる型。Claude Code が実装したら Codex、Codex が実装したら Claude Code、追加のレビュアーはどちらでも。レビュアーには会話の文脈を渡さず、fresh clone と PR 情報とレビュー指示だけを渡す。意図と設計の整合、最小性、テスト、そしてセキュリティ・ライセンス・個人情報の 3 節を必ず書かせ、PR にコメントとして転記する。PR を出した直後、レビューをやり直すときに読む。前は task-to-pr、次は review-triage-and-merge。
---

# Cross-runner review（別ランナー + 追加のレビュアー、フラットな立場で）

目的: 実装者の思い込みを共有しないレビュアーに、**差分だけでなく PR の意図**（Task / PBI / docs）を読ませて判断させる。
複数のレビューを集める（別ランナー 1 + 追加のレビュアー 1（CLAUDE.md が名指ししていれば）。必要なら Claude のサブエージェントも足す: `review-with-subagent`）。

## 誰がレビューするか

| 実装したランナー | 主レビュアー | 常に |
|---|---|---|
| Claude Code（`$CLAUDECODE` が 1） | Codex（`codex exec`） | 追加のレビュアー（あれば） |
| Codex | Claude Code（`claude -p`） | 追加のレビュアー（あれば） |

追加のレビュアー（例: ローカルモデル）は任意。使うリポジトリは、名前（転記の接頭辞にする）・呼び方・材料の上限を CLAUDE.md に書く。以下では `<extra>` と書く。

## 0. 枠を見る

ランナーの利用上限の見方は CLAUDE.md にある。

主レビュアーが利用上限なら、**待たずに実装したランナーの新しいセッションで代替する**。代替は利用者に聞かずに行い、利用者が既に認めた代替・共有の範囲は同じ範囲で聞き直さない。両方向で同じ扱いにする:

| 実装 | 上限の主レビュアー | 代替 |
|---|---|---|
| Claude Code | Codex | 新しい Claude のサブエージェント / `claude -p` |
| Codex | Claude Code | 新しい Codex のサブエージェント / `codex exec --ephemeral` |

Codex の 5 時間枠が **0.9 以上**、またはレビュー実行の出力に利用上限が出たら代替する。Claude の週間上限なども対象。記録された枠は古いことがあるので、実行が上限で止まったらその出力を優先する。

- 材料と指示は 1 と同じ fresh clone と `_review/` だけ。**実装時の会話・判断の要約・memory は渡さない**。同じランナーでも別セッションによる独立レビューとして扱い、実装した自分による自己レビューとは区別して報告する。同じランナーのため見落としが重なりうることも記録する。
- 実行は 2 の該当ランナーのコマンド。サブエージェントなら渡すのは「`$R` の checkout で `_review/prompt.md` に従い、出力を `_review/<runner>.md` に書く」だけ。
- 転記は 3 の `post_review` で実際のランナーを who にし、要約の 1 行目を `[<runner>] review（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）` にする。自己レビューだけでこの印を付けない。
- 4 の修正後の見直しも同じ代替を使い、`WHO` は今回のレビュアー、`PREV` は前回のレビューが実際に書かれたファイルにする（ランナーを替えても `PREV` を今回の名前に替えない）。責務などの再チェックで指定ランナーが上限なら、上限でない側の新しいセッションに、その手順が定める材料を渡す。主レビューとは別のセッションで行う。
- 代替も利用上限なら、未レビューのままマージせず、運用の確認として Task の会話で止める。追加認証が要るレビューを自動で選ばない。

## 1. 材料を用意する（会話の文脈は渡さない）

レビュアーには**この clone とこのファイルだけ**を見せる。自分の会話・Task 実装時の判断・memory は渡さない。

clone の前に、切れたセッションが残した clone のうち終わった PR の分を消し、`/tmp` の空きを見る。消すのは**同じリポジトリ名**の `review<PR番号>` / `recheck<PR番号>` のうち `gh` で MERGED / CLOSED と確かめたものだけ（open の PR、`gh` で確かめられなかった番号、別のリポジトリ名の clone は残す。別のセッションが使っているかもしれない）。
`STOP:` が出たら clone せず、`du` の上位をそのまま利用者に報告して止まる（溜まっている分を消すのは利用者。別のリポジトリの分・動いているセッションの分を自分で消さない）。

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)            # 作業しているリポジトリの owner/name
NAME=${REPO#*/}; MIN_KB=512000                                     # 同じリポジトリ名の分だけ。閾値 500 MB
for d in /tmp/"$NAME".review[0-9]*.* /tmp/"$NAME".recheck[0-9]*.*; do  # 切れたセッションの残り。終わった PR の分だけ消す
  [ -d "$d" ] || continue
  n=${d##*/}; n=${n#"$NAME".}; n=${n#review}; n=${n#recheck}; n=${n%%.*}
  case $n in ''|*[!0-9]*) continue;; esac
  s=$(gh pr view "$n" -R "$REPO" --json state -q .state) || continue   # 確かめられなければ残す
  case $s in MERGED|CLOSED) echo "rm $d ($s)"; rm -rf "$d";; esac
done
AVAIL=$(df -Pk /tmp | awk 'NR==2{print $4}')
[ "$AVAIL" -ge "$MIN_KB" ] || { echo "STOP: /tmp の空きが ${AVAIL} KB（${MIN_KB} KB 未満）。clone しない"; du -sk /tmp/* 2>/dev/null | sort -rn | head -10; }
```

```bash
N=<PR番号>; R=$(mktemp -d /tmp/<リポジトリ名>.review<PR番号>.XXXXXX); echo "$R"    # 自分だけのディレクトリ。表示されたパスを以後そのまま使う（固定の /tmp/review$N は別リポジトリの同じ番号の PR とぶつかる）
# /tmp はホストの停止や片付けで消えうる。レビューの材料は再開したら作り直す前提で、作る手順（この節）をそのまま流せる形にしておく
HEAD_REF=$(gh pr view $N --json headRefName -q .headRefName); BASE_REF=$(gh pr view $N --json baseRefName -q .baseRefName)
gh repo clone "$REPO" "$R" -- -q --branch "$HEAD_REF"
M="$R/_review"; mkdir -p "$M"                                     # untracked。レビュアーはここを読む
gh pr view $N --json number,title,body,url -q '"# PR #\(.number) \(.title)\n\(.url)\n\n\(.body)"' > "$M/pr.md"
gh pr diff $N > "$M/diff.patch"
TASK=$(tr -d '\r' < "$M/pr.md" | grep -oE 'Closes #[0-9]+|^Backlog-Task: [0-9]+$' | sed -n '/^Closes/{p;q}')   # Closes #N（GitHub の workspace）→
[ -n "$TASK" ] || TASK=$(tr -d '\r' < "$M/pr.md" | grep -oE '^Backlog-Task: [0-9]+$' | head -1)   # 単独行の Backlog-Task: N（ローカルのバックログ。task-to-pr のひな形が必ず置く）
TASK=$(echo "$TASK" | grep -oE '[0-9]+' | head -1)
if [ -n "$BACKLOG_WORKSPACE" ]; then ops-kit backlog view "$TASK" --fresh > "$M/task.md"   # GitHub に無いので gh issue view では読めない。PBI も同じく ops-kit backlog view
else gh issue view "$TASK" --json title,body -q '"# Task #'"$TASK"' \(.title)\n\n\(.body)"' > "$M/task.md"; fi
PBI=$(awk '/^## 親 PBI/{f=1;next} f && match($0,/#[0-9]+/){print substr($0,RSTART+1,RLENGTH-1); exit}' "$M/task.md")
if [ -n "$BACKLOG_WORKSPACE" ]; then ops-kit backlog view "$PBI" --fresh > "$M/pbi.md"
else gh issue view "$PBI" --json title,body -q '"# PBI #'"$PBI"' \(.title)\n\n\(.body)"' > "$M/pbi.md"; fi
sed -n '/^## Design rules/,/^## License/p' "$R/README.md" > "$M/design-rules.md"   # 設計ルールの場所が CLAUDE.md にあればそれに合わせる
ls "$R/docs/design" > "$M/design-docs.txt"
```

レビュー指示（`$M/prompt.md`）。**3 節（security / license / personal data）は「none」でも必ず書かせる**:

````bash
cat > "$M/prompt.md" <<'PROMPT'
You are reviewing a pull request in this repository with no prior context. Do not assume anything about the author's intent
beyond what the files below say. Read, in this order, under `_review/`: `pr.md` (the PR description), `task.md` (the Task
issue it closes), `pbi.md` (the parent PBI: user story, acceptance criteria, out of scope, decision log), `design-rules.md`
(the repository's design rules), then `diff.patch`. Then read the surrounding code in the working tree (this checkout is the
PR's head branch) and any `docs/design/*.md` that covers the touched area (`_review/design-docs.txt` lists them). Do not skim.

Judge the PR on these, in this order:
1. Intent: does the diff do what the Task's 手順 and the PBI's acceptance criteria ask — no less, and nothing beyond it?
   Name anything the PR does that no criterion asks for, and any criterion the PR claims but does not meet.
2. Design consistency: contradictions with `design-rules.md`, the relevant `docs/design/*.md`, the PBI's スコープ外 and
   決定ログ, or the existing shape of neighbouring code. Flag compatibility layers, one-use abstractions, just-in-case
   settings, per-adapter branches, new tables/endpoints where an existing one would do.
3. Correctness: concrete bugs with a failure scenario (input/state → wrong output). Reproduce claims when you can
   (running the tests may be blocked by the sandbox — say so if it is; reason from the code then).
4. Tests: does a test cover each changed behaviour? Would it fail without the change?
5. MANDATORY, even when the answer is "none":
   - security: secrets or tokens in the diff; path traversal; anything that weakens Origin/auth checks; command or
     SQL injection; defaults that skip a user's approval; active content served without sandboxing; unsafe file writes.
   - license: vendored or copied third-party code; new dependencies and their licenses (must be compatible with this repository's license);
     generated protocol files from vendors.
   - personal data: absolute paths with a username, e-mails, real names, session ids, hostnames, tokens — in code,
     fixtures, docs, screenshots.

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
### Verdict
(one line: mergeable as is / mergeable after the should-fix items / not mergeable — and why)
PROMPT
````

## 2. 走らせる

**Codex**（Claude Code が実装したとき）。読み取り専用 sandbox、会話は保存しない、出力はファイルへ:

```bash
CODEX=$(command -v codex)
( cd "$R" && "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -o "$M/codex.md" - < "$M/prompt.md" ) > "$M/codex.log" 2>&1
```

**Claude Code**（Codex が実装したとき）。plan モード（読み取り専用）:

```bash
( cd "$R" && claude -p --permission-mode plan --output-format text "$(cat "$M/prompt.md")" ) > "$M/claude.md" 2> "$M/claude.log"
```

**追加のレビュアー**（CLAUDE.md が名指ししていれば、どちらのランナーが実装したときも）。呼び方・材料の上限は CLAUDE.md。
この clone を読めないレビュアー（コンテナの中のローカルモデルなど）には、材料を prompt に埋める。diff のほかに **Task / PBI が名指しする `docs/design/*.md` と、diff が触るファイルの全文**（変更後）を入れる（設計との矛盾は diff だけでは見えない）。
上限を超えるぶんは「[truncated: <file> …]」と書き、切ったファイルを要約コメントに列挙する — そのレビュアーのレビューはその範囲について、と読む。全部を見るのは主レビュアー。出力は `$M/<extra>.md` に書く。

全部同時に走らせてよい（Bash の `run_in_background`。`curl -m` と Bash の timeout で切る）。
**マージを止めるのは主レビュアー（別ランナー）だけ。** 追加のレビュアー（ローカルモデルなら 50KB の材料で 10 分以上かかることがある）は終わっていなくても先に進み、
後から届いたら転記して主レビュアーとの比較に使う（利用者の指示 2026-09-18）。終わったら各出力に `### Findings` があるか見る。無ければ（枠切れ、sandbox で止まった、モデルが形式を守らなかった）ログを読んで一度だけやり直す。

## 3. PR に転記する

レビュアーはファイルを変えず PR にも書かない。**自分が接頭辞つきで転記する**（`[codex]` / `[claude]` / `[<extra>]`）。Findings の各行はインラインに、残りは要約コメントに:

```bash
post_review() { # <pr> <who> <file>   ※ /tmp にスクリプトとして保存しない（同名のファイルを別リポジトリのセッションが上書きした）。使う呼び出しの中で定義する。※ 変数名に path を使わない（zsh では $path が PATH に結ばれていて、local path で全コマンドが見えなくなる）
  local pr=$1 who=$2 f=$3 sha line rel ln
  sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
  grep -E '^- \[(blocker|should-fix|nit|question)\] `[^`]+:[0-9]+`' "$f" | while IFS= read -r line; do
    rel=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\1/' <<<"$line"); ln=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\2/' <<<"$line")
    gh api "repos/{owner}/{repo}/pulls/$pr/comments" -f path="$rel" -F line="$ln" -f side=RIGHT -f commit_id="$sha" -f body="[$who] $line" >/dev/null 2>&1 \
      || gh pr comment "$pr" --body "[$who] $line（差分外の行のため一般コメント）" >/dev/null
  done
  { printf '[%s] review\n\n' "$who"; sed -n '/^### Intent and design/,$p' "$f"; } | gh pr comment "$pr" --body-file - >/dev/null
}
post_review $N codex "$M/codex.md"; post_review $N <extra> "$M/<extra>.md"     # 追加のレビュアーが無ければ後ろは省く
```

転記したら Task の Issue に 1 行（「レビュー: codex n 件 / <extra> m 件、要約は PR」）。`$R` は**まだ消さない**（4 の見直しで clone・`prompt.md`・前回のレビューを使う）。
転記した時点の head を `OLD` として控える: `git -C "$R" rev-parse HEAD`（表示された値を文字で控える。Bash の呼び出しをまたぐと変数は消える）。

## 4. 修正後の見直し

レビューのあとに修正コミットを積んだら、**マージ前に主レビュアーに見直させる**。マージ判定（CLAUDE.md のコマンド）は「最後のコミットより新しい `[codex] review` / `[claude] review` のコメント」が無い PR を止める。
材料は**この PR の修正コミットだけ**の差分と、前回のレビュー（何を指摘したか）。出力形式は 1 と同じ:

```bash
# R・M・HEAD_REF・BASE_REF は 1 で作ったもの。OLD = 3 で控えた、前回レビューした head（fetch の前に控えておく）
git -C "$R" fetch -q origin "$HEAD_REF" "$BASE_REF"
NEW=$(git -C "$R" rev-parse "origin/$HEAD_REF")
# 下の枝の修正を cascade した後でも、この PR のコミットだけを比べる（それぞれの base からの差分どうし）
git -C "$R" range-diff "$(git -C "$R" merge-base "$OLD" "origin/$BASE_REF")..$OLD" "$(git -C "$R" merge-base "$NEW" "origin/$BASE_REF")..$NEW" > "$M/fix.range-diff"
git -C "$R" checkout -q "$NEW"
PREV=_review/codex.md                        # Claude が主レビュアーなら _review/claude.md
{ cat "$M/prompt.md"; echo; echo "This is a follow-up review. The PR was already reviewed at $OLD; your previous review is $PREV."; \
  echo "Review only _review/fix.range-diff (this PR's commits since then): do the fixes address the findings, and do they introduce new problems?"; \
  echo "Use the same output format."; } > "$M/prompt-fix.md"
# Codex が主レビュアー（Claude Code が実装したとき）
( cd "$R" && "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -o "$M/fix-review.md" - < "$M/prompt-fix.md" ) > "$M/fix-review.log" 2>&1; WHO=codex
# Claude Code が主レビュアー（Codex が実装したとき）は上の代わりに:
# ( cd "$R" && claude -p --permission-mode plan --output-format text "$(cat "$M/prompt-fix.md")" ) > "$M/fix-review.md" 2> "$M/fix-review.log"; WHO=claude
grep -q '^### Findings' "$M/fix-review.md" && post_review $N $WHO "$M/fix-review.md" \
  || echo "見直しの出力に ### Findings が無い（枠切れ・sandbox）。ログを読んで一度だけやり直す。空のまま転記しない"
```

**`### Findings` の無い出力は転記しない**（`post_review` は中身が空でも `[codex] review` で始まる要約を書くので、マージ判定が「見直し済み」と数えてしまう）。
rebase だけ（`gh stack rebase`、下のマージ後の GitHub の自動 rebase）なら見直しは要らない（マージ判定はコミットの author date を見るので止めない）。見直しで新しい指摘が出たら `review-triage-and-merge` の 2 から。
見直しが済んで採否が終わったら `rm -rf <1 で作った $R のパス>`（`/tmp/review*` のような glob で消さない）。切れたセッションの残りは、次のレビューの 1 で同じリポジトリ名 + `gh` で MERGED / CLOSED と確かめたものだけ消える。

## 報告（利用者への返事の型）

```
PR #<n> のレビュー: codex <k> 件（blocker a / should-fix b / nit c / question d）、<extra> <k'> 件。3 節: security <none|…> / license <…> / personal data <…>
Verdict: codex「…」、<extra>「…」
次: review-triage-and-merge
```

## やらないこと

- 実装した自分（同じランナー、同じ会話）だけでレビューを済ませる
- レビュアーに会話の要約や「ここは意図的」といった弁明を渡す（採否のときに自分が返信する）
- 3 節（security / license / personal data）の無いレビューを「レビュー済み」と数える
- 枠切れの主レビュアーを飛ばしてマージに進む（両ランナーとも 0 の代替。代替も利用できなければ未レビューとして止める。追加のレビュアーは待たなくてよい）
