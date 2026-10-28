# shared-tmp-guard（/tmp 直下の固定名に書かせない）

Switchboard が起動した Claude Code の Task が（Codex の Task は hook でなくサンドボックスで。「ランナーごとの制限」）、`/tmp` 直下に固定の名前で書く・消す Bash コマンドを実行の前に止める（PBI #764）。決まりの文はスキルの「作業ファイルは `/tmp` 直下に固定の名前で置かない。`W=$(mktemp -d /tmp/<リポジトリ名>.<用途>.XXXXXX)`」（`task-to-pr` ほか）。この仕組みは、その文を読み落としたエージェントの歯止め。

理由: 別々のリポジトリの 2 つのセッションが同じホストで `/tmp/post_review.sh` を上書きし合うと、一方のレビューがもう一方の PR 番号に投稿される。hook をホームにだけ置くと、ホストの移行（#179）も作り直しの復元（#401）も `~/.claude/projects` と `~/.codex/sessions` しか運ばないので、新しいホストでは消える。この仕組みは本体と登録の元をリポジトリに置いて、作り直しでも消えないようにする。

## 部品

| 部品 | 場所 | 役割 |
|---|---|---|
| 判定 | `ops-kit/src/shared-tmp.ts` の `sharedTmpWrites` | コマンドの文から、`/tmp` 直下の固定名で書く・消すパスを返す |
| 本体 | `ops-kit/bin/deny-shared-tmp` | PreToolUse の hook。標準入力の `{tool_name, tool_input:{command}}` を読み、当たればパスごとに 1 行を標準エラーに出して exit 2（Claude Code はその Bash を実行せず、文をエージェントに返す） |
| 配線（#773） | `packages/core/src/tasks.ts` の `startSession` → `StartOptions.guards` → Claude のアダプタの `buildArgs` | meta workspace の本体を、Claude Code に `--settings`（インラインの JSON）の PreToolUse の Bash の hook として、`onFailure: "block"` を付けて渡す。meta workspace が無いときは渡さない |
| Switchboard 自身の登録 | `.claude/settings.json`（Git 管理） | `"$CLAUDE_PROJECT_DIR"/ops-kit/bin/deny-shared-tmp`（`onFailure: "block"`）。このリポジトリで手で起動したセッションにも効く |

## 置き方

- ほかのリポジトリには何も書かない。`--settings` は起動ごとの引数なので、Git 管理のファイルも `.git/info/exclude` も変わらない。`~/.claude` も読まない
- Claude Code は hook の登録を設定の出どころ（managed、`--settings`、`.claude/settings.local.json`、`.claude/settings.json`、`~/.claude/settings.json`）をまたいで足し合わせる。リポジトリが自前の hook（Git 管理の `.claude/settings.json`）を持っていても、両方が呼ばれる
- Switchboard の Task では、`--settings` と `.claude/settings.json` で同じ本体が 2 回呼ばれる（コマンドの文字列が違うので Claude Code は 1 つにまとめない）。結果は同じで、分岐は足さない
- ほかのリポジトリで手で起動したセッションには効かない。効かせたいリポジトリは、自分の `.claude/settings.json` に本体への 1 行を足せる

## 止めるもの

`/tmp`（`/private/tmp`）直下の、変数で始まらない名前とその下の深いパスに、次で書く・消すもの:

| 書き方 | 例 |
|---|---|
| リダイレクトの先（`>` `>>` `>\|` `2>` `&>` `>& file`） | `cat > /tmp/pr.md`、`echo x >> /tmp/x`、`make 2> /tmp/err.log` |
| `tee` `rm` `rmdir` `mkdir` `touch` `truncate` の引数 | `tee /tmp/x`、`rm -rf /tmp/review1`、`rm -rf /tmp/review*`、`mkdir /tmp/review1/a` |
| `cp` `mv` `ln` `install` の最後の引数 | `cp a /tmp/x` |
| `git worktree add` / `git clone` の置き先 | `git worktree add /tmp/wt origin/main` |

hook そのものが動かないとき（本体のパスが無い・`#!/usr/bin/env bun` の bun が PATH に無いなどで起動できない、時間切れ、想定外の終了コード）も、その Bash を止める。登録に `onFailure: "block"`（Claude Code 2.1.295）を付けているので、Claude Code はその Bash を実行せず、`PreToolUse:Bash hook error: [<コマンド>]: failed; blocking because onFailure is "block"` と原因の文をツールの結果（エラー）としてエージェントに返す。Task の画面では、その Bash の行が失敗（✕）になり、開くと同じ文が読める。付けないと、動かない歯止めは黙って Bash を通す

`;` `&&` `||` `|` `&`、改行、`$( )` と `( )` で区切った各コマンドを見る。先頭の `X=1` や `sudo` `env` `command` `exec` `nohup` `time`、予約語 `if` `then` `else` `elif` `while` `until` `do` `{` `!` は飛ばして、その次をコマンドとして読む。

## 止めないもの

- `mktemp -d /tmp/<名前>.XXXXXX` と、その結果の下: 変数（`"$W/pr.md"`）でも、表示されたパスを文字で書いても（`/tmp/<名前>.AuCZE8/pr.md`）。スキルは Bash の呼び出しをまたぐときに表示されたパスをそのまま使わせるので、`/tmp` 直下の名前が mktemp の形（点のあとに英数字 6 文字以上、大文字か数字を 1 つ以上含む）なら止めない。小文字だけ（`/tmp/notes.backup`）、`X` だけ（テンプレートそのもの `/tmp/sb.pr.XXXXXX`）、数字だけ（日付 `/tmp/backup.20260930`）は止める
- `/tmp` を読むだけのコマンド（`ls /tmp`、`cat /tmp/x`、`< /tmp/x`、`cp /tmp/x ./here`）、`/tmp` そのもの、`/tmp` 以外のパス（`./tmp/x`、`/var/tmp/x`）
- 引数の文字列の中（`gh pr comment 1 --body 'cat > /tmp/pr.md'`）、ヒアドキュメントの本文、`#` のコメント。PR 本文を heredoc で書くときに止まらないように。ただし、リダイレクトの先と、書き込むコマンドの引数のパスは、引用符で囲んでも止める（`echo x > "/tmp/x"`、`rm '/tmp/x'`）
- シェルが解釈して初めて分かるもの: 変数の展開先（`D=/tmp/x; echo > "$D"`）、`eval`、`cd /tmp && echo > x`、別のスクリプトの中の書き込み。シェルの完全な解釈はしない
- 表に無い書き方: 値を取るオプションの付いた前置き（`sudo -u root rm /tmp/x`）、表に無い前置き（`timeout 10 rm /tmp/x`、`xargs rm /tmp/x`）、置き先がオプションの値のもの（`cp -t /tmp/dir a b`）、`$(( ))` の中の `<<`（ヒアドキュメントの始まりと読み、続きを読まない）。見つけた書き方で事故が起きたら表に足す
- Bash 以外のツール（Write ツールで `/tmp/x` に書く）、入力の JSON が読めないとき（hook の不具合で Bash が全部止まらないように exit 0）。これは本体が動いたうえで「通す」と答えるので、`onFailure` の対象（hook が動かない）とは別で、今までどおり通る

## ランナーごとの制限

- Claude Code: 効く（Task は `--settings`（#773 で入る）、このリポジトリは `.claude/settings.json`）
- Codex（PBI #787）: hook ではなくサンドボックスで止める。デーモンが Task ごとに専用の一時ディレクトリ `<デーモンの home>/tmp/<Task ID>`（デーモンごとの領域。別のデーモンや DB のコピーで起動したデーモンとは共有しない） を作って `StartOptions.privateTmp` で渡し（Task が中断・エラーで終わると消す。完了した Task は再開で同じファイルを使えるよう残し、デーモンの起動時に、DB が手放してよい（終了済みで再開予定が無い）Task のうち、最後に起動してから 3 日より古いものを消す）、Codex のアダプタがそれを `TMPDIR` にして、各 turn のサンドボックスを「`/tmp` を閉じる（`excludeSlashTmp: true`）+ その専用ディレクトリだけ書ける」にする。`/tmp` 直下の固定名への書き込みは `Read-only file system` で失敗し、`mktemp -d`（`TMPDIR` の下）と `$TMPDIR` の下は書ける。別のセッションの `/tmp` のファイルには触れず、作りっぱなしのファイルも Task の専用ディレクトリに残って Task の終了で消える。`~/.codex` にもリポジトリにも書かない。meta workspace が無いときは渡さない（`guards` と同じ）。作るのは Codex の Task だけで、ほかの利用者のものやシンボリックリンクが先にあれば作らず、Task は始まらない（保護なしの Codex を動かさない）
  - hook にしなかった理由: Codex の PreToolUse は、利用者が信頼した定義しか動かさない。`-c` で渡したインラインの hook も同じで、信頼の記録は `~/.codex` に置くのでホストの作り直しで消える。信頼を飛ばす `--dangerously-bypass-hook-trust` は `codex` 本体の引数で、`codex exec` では効くが、Switchboard が起動する `codex app-server` は読まず hook が呼ばれない（`codex-cli 0.163.0` で実測。設定キー `bypass_hook_trust` を `-c` で渡しても同じ）
  - 代償: Codex の Task では `mktemp -d /tmp/<名前>.XXXXXX` も失敗する（`mktemp -d` か `$TMPDIR` の下を使う）。止めるのはサンドボックスの中だけで、サンドボックスを外す許可モード（Codex の `full-access`）の Task には効かない。理由が Codex に返る hook と違い、失敗は `Read-only file system` の文。承認が要る許可モード（`auto` など）では、モデルが失敗したコマンドをサンドボックスの外で動かす許可を求めることがあり、承認されるとその 1 回は止まらない（hook なら承認の有無に依らず止まる）。実測では（`auto`、既定の承認）モデルは失敗を報告するだけで昇格を求めなかった
  - 確かめた版: `codex-cli 0.163.0`（アダプタ経由の本物の `codex app-server`。hooks も信頼の記録も無い `CODEX_HOME` で、`/tmp` 直下の固定名は失敗、`$TMPDIR` と `mktemp -d` は成功、前後で `~/.codex/config.toml` と一時リポジトリの `git status` は不変）
- DAK: 渡さない（#773 の `guards` を DAK のアダプタは使わない）

## 一次資料

2026-10-27 に確かめた: Claude Code の CHANGELOG の 2.1.295 の項（command / HTTP hook の `onFailure: "block"`。起動できない・時間切れ・想定外の終了コードの hook は、その操作を通さず止める）。実際の Claude Code 2.1.311 で、存在しないパスを歯止めとして `onFailure: "block"` 付きで `--settings` に渡すと、`touch` は実行されず、ツールの結果は `is_error: true` だった（録画 `packages/adapters/claude/fixtures/guard-unavailable.jsonl`、Git の外）

2026-10-01 に確かめた（code.claude.com）:

- `docs/en/settings`: 設定の優先順位は managed → コマンドライン（`claude --settings`）→ `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`
- `docs/en/hooks`: 「Hook entries merge across settings levels rather than replacing each other」。同じ handler が複数の設定ファイルにあれば 1 回だけ走る。PreToolUse の exit 2 はツールの呼び出しを止め、標準エラーの文がエージェントに返る。`$CLAUDE_PROJECT_DIR` はセッションを始めたプロジェクトのルート

## やらないこと

- ホームの `~/.claude` に hook を置く・ホストの作り直しでホームを復元する（作り直しで消えるのが発端）
- meta workspace が無い Task（歯止めを渡さない）を止めること。`onFailure` は登録した hook が動かないときだけ効く。構成の検査として別に扱う（#1573 の判断待ちの回答）
- hook を切る設定・フラグ・環境変数。誤検知は `shared-tmp.ts` の規則を直して無くす
- 各リポジトリに `.claude/settings.local.json` を置く（Claude Code 自身がそのファイルを書き換えるので合成と持ち主の管理が要り、手で作ると Git から見え、`skill-sync.md` の管理ブロックの形も変わる）
