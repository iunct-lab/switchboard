---
name: cross-runner-review
description: PR を「実装したのとは別のランナー」（と、あれば追加のレビュアー）にレビューさせる型。Claude Code が実装したら Codex、Codex が実装したら Claude Code、追加のレビュアーはどちらでも。レビュアーには会話の文脈を渡さず、fresh clone と PR 情報とレビュー指示だけを渡す。意図と設計の整合、最小性、テスト、そしてセキュリティ・ライセンス・個人情報・公開の読み手の 4 項目を必ず書かせ、PR にコメントとして転記する。PR を出した直後、レビューをやり直すときに読む。前は task-to-pr、次は review-triage-and-merge。
---

# Cross-runner review（別ランナー + 追加のレビュアー、フラットな立場で）

目的: 実装者の思い込みを共有しないレビュアーに、**差分だけでなく PR の意図**（Task / PBI / docs）を読ませて判断させる。
複数のレビューを集める（別ランナー 1 + 追加のレビュアー 1（CLAUDE.md が名指ししていれば）。必要なら Claude のサブエージェントも足す: `review-with-subagent`）。

## 誰がレビューするか

| 実装したランナー | 主レビュアー | 常に |
|---|---|---|
| Claude Code（`$CLAUDECODE` が 1） | Codex（`codex exec`） | 追加のレビュアー（あれば） |
| Codex | Claude Code（`claude -p`） | 追加のレビュアー（あれば） |

### 設定で同じランナーを選ぶ

主レビュアーは、環境変数 `OPS_KIT_REVIEW_RUNNER` で選べる（エージェント管理アプリが Task の開始時に設定の値を渡す）。値が無い・`other`・それ以外の値なら、**既定の別のランナー**（上の表）のまま。`same` のときだけ、主レビュアーを実装したランナーの新しいセッションにし、別のランナーを求めない:

```bash
[ "${OPS_KIT_REVIEW_RUNNER:-other}" = same ] && echo "主レビュアー: 同じランナーの新しいセッション（設定による選択）" || echo "主レビュアー: 別のランナー（既定）"
```

- 新しいセッションは 0 の代替の表と同じ（Claude Code は新しい Claude のサブエージェント / `claude -p`、Codex は新しい Codex のサブエージェント / `codex exec --ephemeral`）。材料・実行・転記・4 の見直しも 0 の代替と同じ手順（実装時の会話・要約・memory は渡さない）
- 要約の 1 行目は `[<runner>] review（同じランナーの別セッション。設定による選択）`（`post_review` の 4 つ目の引数 `（同じランナーの別セッション。設定による選択）`）。0 の利用上限の代替の印は付けない（上限で替えたのではない）
- 追加のレビュアーの有無・呼び方は変えない
- 値は Task の開始時のもの。動いている Task の途中で設定を変えても、その Task には次の開始・再開まで効かない（この Task が使う値は環境変数で見る）

追加のレビュアー（例: ローカルモデル）は任意。使うリポジトリは、名前（転記の接頭辞にする）・呼び方・材料の上限を CLAUDE.md に書く。以下では `<extra>` と書く。
追加のレビュアーを止めておける（例: 環境変数で有効にするローカルモデル）なら、有効の条件も CLAUDE.md に書く。条件が満たされないときは呼ばず（既定の接続先に当てて失敗を待たない）、要約に「<extra>: 無効（<条件>）」と 1 行書く。

## 0. 枠を見る

ランナーの利用上限の見方は CLAUDE.md にある。

主レビュアーが利用上限なら、**待たずに実装したランナーの新しいセッションで代替する**。代替は利用者に聞かずに行い、利用者が既に認めた代替・共有の範囲は同じ範囲で聞き直さない。両方向で同じ扱いにする:

| 実装 | 上限の主レビュアー | 代替 |
|---|---|---|
| Claude Code | Codex | 新しい Claude のサブエージェント / `claude -p` |
| Codex | Claude Code | 新しい Codex のサブエージェント / `codex exec --ephemeral` |

Codex の 5 時間枠が **0.9 以上**、またはレビュー実行の出力に利用上限が出たら代替する。Claude の週間上限なども対象。記録された枠は古いことがあるので（読み方は CLAUDE.md の「利用上限」に従う。`resets_at` が過ぎた行は 0）、実行が上限で止まったらその出力を優先する。

- 材料と指示は 1 と同じ fresh clone と `_review/` だけ。**実装時の会話・判断の要約・memory は渡さない**。同じランナーでも別セッションによる独立レビューとして扱い、実装した自分による自己レビューとは区別して報告する。同じランナーのため見落としが重なりうることも記録する。
- 実行は 2 の該当ランナーのコマンド。サブエージェントなら渡すのは「`$R` の checkout で `_review/prompt.md` に従い、出力を `_review/<runner>.md` に書く」だけ。
- 転記は 3 の `post_review` で実際のランナーを who にし、要約の 1 行目を `[<runner>] review（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）` にする（4 つ目の引数）。自己レビューだけでこの印を付けない。設定で同じランナーを選んだときは、この印ではなく「設定で同じランナーを選ぶ」の印にする。
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
ops-kit backlog view "$TASK" --fresh > "$M/task.md"
PBI=$(awk '/^## 親 PBI/{f=1;next} f && match($0,/#[0-9]+/){print substr($0,RSTART+1,RLENGTH-1); exit}' "$M/task.md")
ops-kit backlog view "$PBI" --fresh > "$M/pbi.md"
sed -n '/^## Design rules/,/^## License/p' "$R/README.md" > "$M/design-rules.md"   # 設計ルールの場所が CLAUDE.md にあればそれに合わせる
ls "$R/docs/design" > "$M/design-docs.txt"
```

**ローカルの変更では**（Task への指示が「この workspace の変更はアプリに置く」と言う workspace。リポジトリのサービスがアプリで、PR の代わりにアプリに置く「変更」を使う）: clone の代わりに `git worktree add --detach "$R" <枝>`（`R=$(mktemp -d …)` の中に。終わったら `git worktree remove`）、`REPO=$(gh repo view …)`・`/tmp` の古い clone の片付けのループ・`gh repo clone`・`gh pr view` の行は飛ばす（`gh` を呼ばない。GitHub の同じ番号の別の Issue に触らない）。`HEAD_REF` / `BASE_REF` は `ops-kit backlog view <変更>` の出力の `変更: <head> → <base>` の行から入れる（`<枝>` は `<head>`）。PR の情報は `ops-kit backlog view <変更> > "$M/pr.md"`、差分は `git diff "$BASE_REF...$HEAD_REF" > "$M/diff.patch"`、Task は本文の `Backlog-Task:` の行。転記（3）は `gh pr comment` / インラインの代わりに、1 行目を `[<runner>] review` にしたレビューの全文を `ops-kit backlog comment <変更> --body-file <ファイル>` で 1 件。修正後の見直し（4）の差分は `git diff <前回の head>..<枝>`。

レビュー指示（`$M/prompt.md`）。**4 項目（security / license / personal data / public readers）は「none」でも必ず書かせる**。

セキュリティの頼み方: 攻撃の手順（攻撃シナリオの列・ペイロード・コマンドの全文）を書かせない。「どのルートに認証・認可・宛先の検査が無いか」「どこで何を検査すべきか」「既存の防御」の形で書かせる。所見の多いリポジトリで攻撃シナリオの列を求めると、報告全体が攻撃手順の形になり、防御の目的でもランナーの安全装置が報告を途中で止める。止まったら「続きだけ、防御側の表現で」と頼み、残りは自分で埋める。セキュリティを見るほかの指示（`public-release-gate` など）も同じ:

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
   If the diff changes design documents (e.g. `docs/design/*.md`), say whether each change is within the PBI's acceptance criteria and the original request (`pbi.md`); list out-of-scope edits as `[should-fix]`.
2. Design consistency: contradictions with `design-rules.md`, the relevant `docs/design/*.md`, the PBI's スコープ外 and
   決定ログ, or the existing shape of neighbouring code. Flag compatibility layers, one-use abstractions,
   just-in-case feature or path toggles (not overrides for values that depend on the environment or usage, such as sizes, counts, periods, intervals, limits — the design check expects those to be derived or overridable),
   per-adapter branches, new tables/endpoints where an existing one would do.
   Flag any diff that copies a value the running app owns and can change (a registered schedule's cron/prompt/budget/runner,
   a settings value or default, a default model name) into docs/skills/templates/CLAUDE.md; point to its source instead.
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
### Verdict
(one line: mergeable as is / mergeable after the should-fix items / not mergeable — and why)
PROMPT
````

## 2. 走らせる

**アプリの Task の中では**、主レビュアーは自分のシェルで走らせず、アプリに仕事として頼む（仕事はアプリの子として走り、Task のセッションの子にならない。`ops-kit job request review` が `codex exec` / `claude -p` の呼び出し（読み取り専用 / plan モード、`ops-kit heavy --memory-only` と `idle-run` の内側。無進捗で切る秒数はアプリの設定）をアプリの側で組む）。`--prompt` を読み `--out` に書く（どちらも `--cwd` の中。`--cwd` は `$R`）:

```bash
# Claude Code が実装したとき（主レビュアーは Codex）。Codex が実装したときは --runner claude、出力は "$M/claude.md"
ops-kit job request review $N --runner codex --cwd "$R" --prompt "$M/prompt.md" --out "$M/codex.md"
```

request は `job#<id>` の 1 行と、止まりの報告（アプリが Task に渡す書式）に書く JSON を出す。それを reason `depends`・conditions に `job#<id>` で書いてターンを終える。レビューが終わるとアプリが結果の要約を添えて再開するので、`--out` のファイルを読んで 3 の転記に進む。

**アプリの Task の外では**従来どおり直接走らせる。読み取り専用 sandbox、会話は保存しない、出力はファイルへ:

```bash
CODEX=$(command -v codex)
( cd "$R" && ops-kit heavy --memory-only --name "review codex" -- ops-kit idle-run --idle 900 -- "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -o "$M/codex.md" - < "$M/prompt.md" ) > "$M/codex.log" 2>&1
```

Claude Code が主レビュアーのとき（plan モード、読み取り専用）:

```bash
( set -o pipefail; cd "$R" && ops-kit heavy --memory-only --name "review claude" -- ops-kit idle-run --idle 900 -- claude -p --permission-mode plan --output-format stream-json --verbose "$(cat "$M/prompt.md")" | tee "$M/claude.jsonl" | jq -r 'select(.type=="result").result' ) > "$M/claude.md" 2> "$M/claude.log"
```

**固まったとき**（仕事でも直接でも同じ。仕事の結果の要約に exit 124 が出る）: `ops-kit idle-run --idle <秒>` は、レビュアーがその秒数（直接走らせるときは 900、仕事はアプリの設定）何も出さないとプロセスごと切り、exit 124 で返す（理由の行は log に残る。総時間の上限は無い。text 出力の `claude -p` は最後まで何も出さないので、stream-json で動いていることを見る）。exit 124 なら `$M/<runner>.md` を転記せず、理由を PR コメントに残して一度だけやり直す。やり直しでも切れたら止まって報告する:

```bash
gh pr comment $N --body "[<runner>] 無進捗で打ち切り（<秒> 秒出力なし）。レビューは付いていない"
```

ローカルの変更では同じ文を `ops-kit backlog comment <変更> --body-file -` で書く。

**追加のレビュアー**（CLAUDE.md が名指しし、有効の条件を満たしていれば、どちらのランナーが実装したときも）。呼び方・材料の上限は CLAUDE.md。
この clone を読めないレビュアー（コンテナの中のローカルモデルなど）には、材料を prompt に埋める。diff のほかに **Task / PBI が名指しする `docs/design/*.md` と、diff が触るファイルの全文**（変更後）を入れる（設計との矛盾は diff だけでは見えない）。
上限を超えるぶんは「[truncated: <file> …]」と書き、切ったファイルを要約コメントに列挙する — そのレビュアーのレビューはその範囲について、と読む。全部を見るのは主レビュアー。出力は `$M/<extra>.md` に書く。

アプリの Task の中では、主レビュアーを仕事に頼んだらそこでターンを終える（背景の `sleep` や `run_in_background` の待ちのループで待たない。セッションが閉じず 150〜250 MB を開き続ける）。追加のレビュアー（`curl`）は枠を通さないので仕事にしない。主レビュアーを先に頼み、そのあと自分のシェルの前景で `curl -m` を切って走らせ、終わるか切れてからターンを終える（主レビュアーの仕事を `curl` の後ろで待たせない。背景で走らせるとセッションが閉じない）。直接走らせるとき（アプリの Task の外）はバックグラウンドで始めてよい（Bash の `run_in_background`）。レビューは重い処理の枠（席）を取らず、空きメモリが下限を割る間だけ待つ（`--memory-only`。レビューの走りは 1 分前後で、席の待ちは数分〜数時間になるため。キットの README の「重い処理の枠」）。`ops-kit heavy` は `idle-run` の外側に置く（メモリを待つ間は無進捗に数えない）。Bash の timeout はメモリの待ちとレビューが終わるまで切らない長さ（上限いっぱい）にする。切るのは `idle-run`。外から切られると理由が残らない。
**マージを止めるのは主レビュアー（別ランナー）だけ。** 追加のレビュアー（ローカルモデルなら 50KB の材料で 10 分以上かかることがある）は終わっていなくても先に進み、
後から届いたら転記して主レビュアーとの比較に使う（利用者の指示 2026-09-18）。終わったら各出力に `### Findings` があるか見る。無ければ（枠切れ、sandbox で止まった、モデルが形式を守らなかった）ログ（Claude Code は `$M/claude.jsonl` も）を読んで一度だけやり直す。

## 3. PR に転記する

レビュアーはファイルを変えず PR にも書かない。**自分が接頭辞つきで転記する**（`[codex]` / `[claude]` / `[<extra>]`）。Findings の各行はインラインに、残りは要約コメントに:

```bash
post_review() { # <pr> <who> <file> [1 行目の印の続き]   ※ /tmp にスクリプトとして保存しない（同名のファイルを別リポジトリのセッションが上書きした）。使う呼び出しの中で定義する。※ 変数名に path を使わない（zsh では $path が PATH に結ばれていて、local path で全コマンドが見えなくなる）
  local pr=$1 who=$2 f=$3 note=${4:-} sha line rel ln
  sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
  grep -E '^- \[(blocker|should-fix|nit|question)\] `[^`]+:[0-9]+`' "$f" | while IFS= read -r line; do
    rel=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\1/' <<<"$line"); ln=$(sed -E 's/^- \[[^]]+\] `([^`]+):([0-9]+)`.*/\2/' <<<"$line")
    gh api "repos/{owner}/{repo}/pulls/$pr/comments" -f path="$rel" -F line="$ln" -f side=RIGHT -f commit_id="$sha" -f body="[$who] $line" >/dev/null 2>&1 \
      || gh pr comment "$pr" --body "[$who] $line（差分外の行のため一般コメント）" >/dev/null
  done
  { printf '[%s] review%s\n\n' "$who" "$note"; sed -n '/^### Intent and design/,$p' "$f"; } | gh pr comment "$pr" --body-file - >/dev/null
}
post_review $N codex "$M/codex.md"; post_review $N <extra> "$M/<extra>.md"     # 追加のレビュアーが無ければ後ろは省く
```

転記したら Task の Issue に 1 行（「レビュー: codex n 件 / <extra> m 件、要約は PR」。`ops-kit backlog comment <Task> --body-file -`）。`$R` は**まだ消さない**（4 の見直しで clone・`prompt.md`・前回のレビューを使う）。
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
rm -f "$M/fix-review.md"                     # 切れたときに前回の出力を転記しない
# アプリの Task の中では、下の直接の実行の代わりに仕事に頼み（2 と同じ）、job#<id> を止まりの報告に書いてターンを終える。再開したら、新しいシェルで R・M・N と下の NOTE を作り直し、WHO=<頼んだランナー>、RC=<結果の要約の exit> を置いて、下の最後の行（転記）から続ける:
#   ops-kit job request review $N --runner codex --cwd "$R" --prompt "$M/prompt-fix.md" --out "$M/fix-review.md"   # Claude が主レビュアーなら --runner claude
# アプリの Task の外では直接走らせる
CODEX=$(command -v codex)
# Codex が主レビュアー（Claude Code が実装したとき）
( cd "$R" && ops-kit heavy --memory-only --name "review codex" -- ops-kit idle-run --idle 900 -- "$CODEX" exec --sandbox read-only --skip-git-repo-check --ephemeral -o "$M/fix-review.md" - < "$M/prompt-fix.md" ) > "$M/fix-review.log" 2>&1; RC=$?; WHO=codex
# Claude Code が主レビュアー（Codex が実装したとき）は上の代わりに:
# ( set -o pipefail; cd "$R" && ops-kit heavy --memory-only --name "review claude" -- ops-kit idle-run --idle 900 -- claude -p --permission-mode plan --output-format stream-json --verbose "$(cat "$M/prompt-fix.md")" | tee "$M/fix-review.jsonl" | jq -r 'select(.type=="result").result' ) > "$M/fix-review.md" 2> "$M/fix-review.log"; RC=$?; WHO=claude
NOTE=                                         # 0 の代替・設定で同じランナーのときは、主レビューと同じ 1 行目の印の続き（例 NOTE='（同じランナーの別セッション。設定による選択）'）
[ "$RC" = 0 ] && grep -q '^### Findings' "$M/fix-review.md" && post_review $N $WHO "$M/fix-review.md" "$NOTE" \
  || echo "見直しが exit $RC か、出力に ### Findings が無い（打ち切り・枠切れ・sandbox）。ログを読んで一度だけやり直す。空のまま転記しない"
```

走らせ方（Bash の timeout）と exit 124 の扱いは 2 と同じ。**`### Findings` の無い出力は転記しない**（`post_review` は中身が空でも `[codex] review` で始まる要約を書くので、マージ判定が「見直し済み」と数えてしまう）。
rebase だけ（`gh stack rebase`、下のマージ後の GitHub の自動 rebase）なら見直しは要らない（マージ判定はコミットの author date を見るので止めない）。見直しで新しい指摘が出たら `review-triage-and-merge` の 2 から。
見直しが済んで採否が終わったら `rm -rf <1 で作った $R のパス>`（`/tmp/review*` のような glob で消さない）。切れたセッションの残りは、次のレビューの 1 で同じリポジトリ名 + `gh` で MERGED / CLOSED と確かめたものだけ消える。

## 報告（利用者への返事の型）

```
PR #<n> のレビュー: codex <k> 件（blocker a / should-fix b / nit c / question d）、<extra> <k'> 件。4 項目: security <none|…> / license <…> / personal data <…> / public readers <…>
Verdict: codex「…」、<extra>「…」
次: review-triage-and-merge
```

## やらないこと

- 実装した自分（同じランナー、同じ会話）だけでレビューを済ませる
- レビュアーに会話の要約や「ここは意図的」といった弁明を渡す（採否のときに自分が返信する）
- 4 項目（security / license / personal data / public readers）の無いレビューを「レビュー済み」と数える
- 枠切れの主レビュアーを飛ばしてマージに進む（両ランナーとも 0 の代替。代替も利用できなければ未レビューとして止める。追加のレビュアーは待たなくてよい）
