---
name: adopt-repo
description: 既存の自分のリポジトリを Switchboard で回し始めるときに、元の決まり（CLAUDE.md・AGENTS.md・Issue テンプレート・ラベル・Project・枝とコミットの決まり）を読んで対応表を作り、元の決まりを書き換えずに、アプリが動くのに要るものだけを足す PR を出すまでの手順。利用者に既存のリポジトリの取り込みを頼まれたときに読む。新しく作るなら new-repo。次は request-to-backlog
---

# 既存のリポジトリを取り込む（診断 → 対応表 → 衝突を聞く → 足すだけの PR → 開始条件 → 報告）

何を元のまま活かし、何を足し、何を元の決まりで上書きできるかの正本は `docs/design/new-repo.md` の「Adopting an existing repository's rules」（決まりの 3 つの種類の表。同じ文書の冒頭の「The three layers」とは別の表）。ここは**それを実行する順番とコマンド**だけで、表は写さない。手順をスクリプトやデーモンのコードにしない。

前提: 自分は Switchboard の Task で、`$SWITCHBOARD_REPO_ROOT` が Switchboard のチェックアウトを指す。対象は登録済みの workspace のうち、自分のリポジトリ（`upstream` が無い）で GitHub と連携するもの。対象のディレクトリは指示文にある。以下 `<dir>` は対象の clone、`<repo>` は `<dir>` で `gh repo view --json nameWithOwner -q .nameWithOwner` の答え、`<branch>` は同じく `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` の答え。

対象外: 他者のリポジトリ（`upstream` がある。`docs/design/new-repo.md` の「Other people's repositories」）、GitHub を使わないリポジトリ（`new-repo` の 7-2）、まだ無いリポジトリ（`new-repo`）。

**元の決まりを書き換えない**（全段に効く）:
- 既存のラベルを消さない・名前を変えない・色と説明を上書きしない（`gh label delete`、`gh label edit`、`gh label create --force` は使わない）
- 既存の Project のフィールドと選択肢を消さない・名前を変えない・差し替えない（Status の選択肢を API で差し替えると、全部の項目の Status が消える。`ops-kit/src/bootstrap.ts` の注記）
- 既存の Issue の本文・ラベル・状態を変えない（既存の番号に `ops-kit backlog edit` / `set` / `triage` をしない）
- CLAUDE.md・AGENTS.md・README・CONTRIBUTING の既存の文を消さない・書き換えない。足すものは末尾の別の節か別のファイル

## 1. 診断

読むだけ。作業ツリーは触らず、既定の枝の最新を読む（`git -C <dir> fetch -q origin`、ファイルは `git -C <dir> show origin/<branch>:<path>`、一覧は `git -C <dir> ls-tree -r --name-only origin/<branch>`）。

| 読むもの | コマンド | 控えること |
|---|---|---|
| 指示のファイル | `ls-tree` で見つかった `CLAUDE.md`・`AGENTS.md`・`.github/copilot-instructions.md`・`.cursorrules` などを `show` | テスト・枝・コミット・PR・レビュー・言語・設計の思想の決まり。`issue-workflow` の「使う側のリポジトリが持つもの」のチェックリストのどれがあり、どれが無いか。AGENTS.md が CLAUDE.md を指しているか（指していなければ Codex の Task は CLAUDE.md の値を読まない）。「共通の規約はここに置かない」のような、ファイルに何を書くかの方針 |
| 貢献の決まり | `README.md`・`CONTRIBUTING.md`・`docs/` の開発の手順 | 同上 |
| GitHub の雛形 | `.github/ISSUE_TEMPLATE/`・`.github/PULL_REQUEST_TEMPLATE.md`・`.github/workflows/`・`.github/CODEOWNERS` | Issue の種類と必須の項目、PR の本文の形、CI の手順 |
| ラベル | `gh label list -R <repo> --limit 200 --json name,description` と、キットの `$SWITCHBOARD_REPO_ROOT/ops-kit/template/.github/labels.yml`（と `needs-decision`。`labels.yml` に無いがアプリが名前で読む） | キットにあって元に無い名前、同じ名前で説明（意味）が違うもの、元だけにあるもの |
| Project | `gh repo view <repo> --json projectsV2`、変数 `gh variable list -R <repo>`、`gh project field-list <n> --owner <owner> --format json` | Status の選択肢、Priority・Story Points の有無と形、元だけのフィールド |
| 既存の Issue | `gh issue list -R <repo> --state open --limit 1000 --json labels`（本文は読まない）と、最大の番号は `gh issue list -R <repo> --state all --limit 1 --json number` | 開いているものの `type:*` のラベルごとの数、`type:*` の無いものの数（Backlog 画面に出ない）、取り込みの時点の最大の番号 |
| 枝とコミット | `gh api repos/<repo>/branches/<branch>/protection`（404・403 = 読めない / 保護なし）、`git -C <dir> log --format=%s -30 origin/<branch>` | 必須のレビュー・必須のチェック、コミットの題の形 |
| Switchboard の設定 | `ops.config.json` と `scripts/setup/` を `show` | 既にあるか。`scripts/setup/` の入口がキットを呼ぶか（`src/cli.ts` を含むか。`docs/design/skill-sync.md` の「Copies of the operations tools」） |

期待: 表の 8 行すべてに「ある（何）/ 無い / 読めない」が控えてある。

## 2. 対応表

1 で控えたものを 1 行ずつ、列「項目 / 元の値 / 種類（`docs/design/new-repo.md` の 3 つの種類の番号）/ どうするか」の表にする。どうするかは次の 3 つだけ:

- **そのまま**: 元の決まりが正。種類 1 の全部と、種類 3 で元に決まりがあるもの（基準にする閉じた PBI・積む PR か 1 本ずつか・worktree の場所などは元が勝つ）
- **足す**: 種類 2 で元に無いもの。消さずに足す
- **衝突**: 種類 2 で、同じ名前で中身が違うもの、元の決まりと両立しないもの。3 で聞く

種類 2 は元の決まりで変えられない（キットとスクリプトが値や名前で読む。Story Points の尺度、Task の枝の `sb/` の接頭辞、マージ判定が読む PR のレビューの印など）。元の決まりが違えば、元の決まりは人の作業のために残し、Switchboard の Task は種類 2 に従う、と CLAUDE.md の節に書く。

種類 3 で元の決まりが勝つ行は、4 の CLAUDE.md の節にその違いを 1 行ずつ書く（スキルは CLAUDE.md の値を読むので、書けば Task は元の決まりで動く）。

表は作業ファイル（`W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.adopt.XXXXXX")`）に Markdown で書き、Task の成果物に登録する（返答の中の `switchboard-artifact` のフェンス。`docs/design/artifacts.md`）。

期待: 1 で控えた全部が表の行になり、「そのまま / 足す / 衝突」の数が数えてある。

## 3. 衝突の聞き方

4 に進む前に（GitHub とアプリに何かを書く前に）、衝突が 0 件でも、Task の会話で対応表と 4 で書くもの（ラベル・Project・リポジトリ変数・workspace の `projectVar`・PR に入れるファイルと CLAUDE.md の節の中身）を見せて OK を取り、ターンを終える（取り込みは対象のリポジトリの運用を決めるので、利用者がその場で答える。対象のリポジトリの Issue には書かない）。「衝突」の行があれば、同じ問いで行ごとに問い・選択肢・推奨を書く。よくある形:

| 衝突の形 | 選択肢 | 推奨 |
|---|---|---|
| Project の Status の選択肢が違う（Todo / In Progress / Done など） | A. Switchboard 用の Project を別に作り、元の Project は元のまま / B. 元の Project を使い、Switchboard の Status を利用者が画面で足す | A（元のボードを変えない。選択肢を API で差し替えると全部の項目の Status が消える） |
| 同じ名前のラベルで意味が違う（`type:task` が元では別の意味、など） | A. 元のラベルのまま Switchboard の Issue にも付ける / B. 取り込みを止める（GitHub と連携しない workspace にするかは利用者が設定で決める。この手順の対象外） | 意味が近ければ A、遠ければ B |
| 元の運用が Issue を使わない（PR だけで進める、Issue を閉じている） | A. Switchboard の要望・PBI・Task の Issue を GitHub に足す / B. 取り込みを止める（同上） | 元が Issue を閉じているなら B |
| Project の Priority の選択肢が P0〜P3 でない（High / Medium / Low など） | A. Switchboard 用の Project を別に作る（キットの P0〜P3。元の Project は元のまま） / B. 取り込みを止める | A（デーモンは P0〜P3 の名前で順位を付けるので、元の選択肢のままでは順に進まない） |
| 元の決まりが main の作業ツリーの更新（pull）に OK を求める（動いているサービスが見ている、など） | 4 のマージの後の `ops-kit pull-main` を、この OK に含めるか、回さずに利用者に任せるか | 含める（含めなければ回さず、6 の報告に書く） |
| AGENTS.md に独自の中身があり、CLAUDE.md を読ませるのがその方針に反する（「CLAUDE.md は Claude 用」など） | A. AGENTS.md の末尾に CLAUDE.md を読む 1 行を足す / B. 取り込みを止める（Codex の Task が CLAUDE.md の値を読めないまま動くのを避ける） | 方針が読ませないと言っていなければ A |

期待: 利用者の OK があり、全部の衝突の行に答えがある。OK が無い、または答えが「取り込みを止める」なら 4 に進まず、6 の報告に止めた理由を書いて終える。

## 4. 足すだけの PR

3 で OK を受けた範囲だけを（2 の「足す」の行と、下の CLAUDE.md の行が節に書くもの全部と、3 の答え）、`<dir>` の worktree で 1 本の PR にする。worktree の場所とコミットの題の形は、元の決まりがあればそれ、無ければ `git -C <dir> worktree add --detach ../<name>-adopt origin/<branch>`。枝はこの Task も Task なので `sb/adopt-switchboard`（種類 2。元の枝の決まりは人の作業のもの）。

| 足すもの | どう足すか |
|---|---|
| `ops.config.json`（無いとき） | `$SWITCHBOARD_REPO_ROOT/ops-kit/template/ops.config.json` を写し、`envPrefix` を決める。Priority の選択肢はキットの P0〜P3 のまま（デーモンが名前で順位を付ける。元の Priority の選択肢が違えば 3 の衝突）。あれば触らない |
| ラベル | 無い名前だけ `env -u BACKLOG_URL gh label create <name> --color <色> --description <説明> -R <repo>`（`--force` を付けない。付けなければ同じ名前があると失敗し、元のラベルは変わらない）。キットの `labels.yml` の行を使う。Task の中の `gh` の前段はラベルの定義の書き込みを止めて `ops-kit sync-labels` を勧めるが、`sync-labels` は同じ名前の元のラベルの色と説明をキットの値に書き換えるので、取り込みでは使わない。PR ではなく GitHub への書き込みなので、PR の本文に作ったラベルを書く |
| Project | 無いとき・3 で A のとき: 設定のファイルを書き換えず、存在しない番号 0 の URL を環境変数で渡して bootstrap で作る: `env -u BACKLOG_URL -u <PREFIX>_PROJECT_OWNER <PREFIX>_PROJECT_URL=https://github.com/<orgs\|users>/<owner>/projects/0 bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" bootstrap "<name> (Switchboard)" --config <worktree>/ops.config.json`。題は元の Project と違う名前にする（bootstrap は同じ題の Project を見つけるとそれを使い、元の Project にフィールドを足す）。期待: 出力に `>> Project #<n>「<題>」を作成` が出る（「既存の Project … を使う」なら止めて題を変える）。続けて `new-repo` の 2 と同じく `gh project link <n>` と変数 `<PREFIX>_PROJECT_URL`（URL は作った `<n>` の URL）。元の Project を使うとき（Status の選択肢が同じとき、または 3 の Status の行で B のとき）: まだならリポジトリにひも付け（`gh project link <n> --owner <owner> -R <repo>`）、元の Project の URL で変数を作り（`gh variable set <PREFIX>_PROJECT_URL -R <repo> --body <URL>`）、足りないフィールド（Priority・Story Points）は URL を環境変数で渡した bootstrap で足す: `env -u BACKLOG_URL -u <PREFIX>_PROJECT_OWNER <PREFIX>_PROJECT_URL=<URL> bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" bootstrap "<元の Project の題>" --config <worktree>/ops.config.json`（設定のファイルは書き換えない。既存の Project には足りないフィールドだけを作り、Status は変えない）。どちらの道でも、最後に workspace の `projectVar` を `<PREFIX>_PROJECT_URL` にする（`new-repo` の 4 の PATCH。`envPrefix` が `SWITCHBOARD` でも省かない。`projectVar` の無い workspace はデーモンの環境変数 `SWITCHBOARD_PROJECT_URL` を先に読み、別の Project を取り込む） |
| CLAUDE.md | 末尾に節 `## Switchboard で動かすとき` を 1 つ足す。中身は、チェックリストのうち元に無くて使うものの値と、2 で種類 3 の元の決まりが勝った行（「Story Points の基準にする閉じた PBI は #<n>」「PR は積まず 1 本ずつ」など）と、種類 2 と違う元の決まりを Task がどう扱うか（「人の枝は `feature/<topic>`、Task の枝は `sb/<n>-<topic>`」など）。1 で `type:*` の付いた既存の Issue があったら（扱いの正本は `docs/design/new-repo.md` の「Adopting an existing repository's rules」の既存の Issue の段落）、「取り込む前の Issue（#<1 で控えた最大の番号> 以下）は書き換えず、閉じず、そのまま Task で進めない。その `ops-kit lint` の違反は、ほかの Issue を確かめるときには数えない。取り込む前の Issue を進めるのは利用者が選んだものだけで、`request-to-backlog` で経路 `Issue #<番号>` の要望にする。アプリが自動で拾った取り込む前の Issue では何も作らずに終え、報告に書く」の 1 行も書く（`pbi-to-tasks` の Ready・`request-to-backlog` の 5 などは lint の違反 0 を求めるので、無いと古い Issue の違反で止まるか、元の Issue を書き換えることになる。後の Task が読むのは CLAUDE.md なので、進め方もここに書く）。元の節に同じ値があれば、その節の名前で指す（写さない）。元のファイルに「何を書くか」の方針があれば、それを守る（そのリポジトリの値だけを書く）。CLAUDE.md が無ければ、`$SWITCHBOARD_REPO_ROOT/ops-kit/template/CLAUDE.md.tmpl` から使う節だけで作る |
| AGENTS.md | CLAUDE.md を指していなければ、末尾に CLAUDE.md を読むことを 1 行足す（種類 2）。無ければ `$SWITCHBOARD_REPO_ROOT/ops-kit/template/AGENTS.md.tmpl` を写し、`__REPO__` をリポジトリ名に置換する（`grep -n '__[A-Z_]*__' AGENTS.md` が 0 件） |
| Issue テンプレート・`scripts/setup/` の入口 | 足さない（Task は `ops-kit backlog` と `ops-kit lint --fresh` を使う。`docs/design/new-repo.md` の種類 1） |

PR の本文に 2 の対応表を貼る。PR の中身が 3 で OK を受けた範囲から外れたら（レビューの指摘で中身が変わったときも）、マージせず、変わったところを Task の会話で見せて OK を取り直す。レビューとマージは `cross-runner-review` → `review-triage-and-merge` → `bun $SWITCHBOARD_REPO_ROOT/scripts/merge-gate.ts <PR> --repo <repo> --merge`（Switchboard のリポジトリの外の PR。`--repo` を必ず付ける）。マージしたら `<dir>` で `ops-kit pull-main` を回して workspace の作業ツリーを最新にする（元の決まりが pull に OK を求めるなら、3 でその OK を受けたときだけ。受けていなければ回さず、6 の報告に書く。アプリは `<dir>` の `ops.config.json` を読むので、古いままだと足した設定が後の Task に効かない。exit 1 / 2 なら、出力の 1 行を 6 の報告に書く）。

期待: 既存のファイルから消えた行が無い。`git -C <worktree> diff -U0 origin/<branch>... | grep -E '^-' | grep -vE '^--- (a/|/dev/null)'` に出るのは、末尾に改行の無かった元の最後の行（同じ文が `+` の側にもある）だけ（`- ` で始まる箇条書きの行も、消せばここに出る）。足した行に雛形のプレースホルダーが残っていない（`git -C <worktree> diff -U0 origin/<branch>... | grep -E '^\+.*__[A-Z_]+__'` が 0 件。元からある文は見ない）。

## 5. 開始条件

`docs/design/new-repo.md` の「Conditions to start」の表を上から回し（`new-repo` の 5 と同じ）、条件ごとに通った / 通らない / 未確認を控える。取り込んだリポジトリでは 2 つを読み替える:

- 「The backlog rules」: `scripts/setup/` の入口を足さないので、`ops.config.json` のある 4 の worktree で `(cd <worktree> && GH_REPO=<repo> ops-kit lint --fresh)` を回す（設定の無いところで `GH_REPO` を付けると exit 2）。取り込む前の Issue の違反は 4 の CLAUDE.md の行のとおり数えず直さない。その数を控え、条件は「通った（取り込む前の Issue の違反 <n> 件は数えない）」と書く。取り込みの後に Switchboard が作った Issue の違反は直す
- 「The 4 items of `CLAUDE.md`」: 見出しの名前が元の CLAUDE.md と違えば grep は当たらない。4 項目（テストの 3 コマンド・作業の場所と枝・live check・反映の OK）それぞれの値がある節の名前を控え、無いものは 4 の節に足す

スキルの印は、その workspace の Task を 1 つ起動したあとでないと出ない（未起動なら「未確認（最初の Task の後）」）。

既存の Issue はここでも書き換えない。Switchboard で進めたいものは、利用者が選んだものだけ `request-to-backlog` で、`## 出典` の経路を `Issue #<元の番号>` にした要望 Issue にする（元の Issue は開いたまま残り、要望 Issue から指す）。この手順では選ばない。

期待: 表の 6 行すべてに「通った / 通らない / 未確認」がある。

## 6. 報告

```
取り込み <repo>（<dir>、workspace <id>）
対応表: そのまま <n> / 足す <n> / 衝突 <n>（答え: …）。成果物: <題>
PR: <URL>（マージ済み / レビュー中）。main: <pull-main の出力の 1 行 / 回していない（理由）>。GitHub に足したもの: ラベル <名前…> / Project <URL>（作ったとき）
| 開始してよい条件 | 結果 |
既存の Issue: open <n> 件（type:request <n> / type:pbi <n> / type:task <n> / type なし <n>）。進めるものは request-to-backlog で要望にする（元の Issue は書き換えない）
利用者確認: Project のビュー 2 つ（新しく Project を作ったときだけ。`docs/design/new-repo.md` の「What stays manual」の 1）
```

秘密の値は報告に書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。

期待: 報告の 6 行（取り込み・対応表・PR・開始条件の表・既存の Issue・利用者確認）がどれも埋まっている（当たらない行は「なし」）。

## やらないこと

- 元のラベル・Project の選択肢・既存の Issue・文書の既存の文を消す・名前を変える・書き換える
- 種類 3 の Switchboard の既定（基準にする閉じた PBI、積む PR など）を、元の決まりより優先する
- 既存の Issue に一括で `type:*` のラベルを付ける、本文に Switchboard の節を足す
- アプリが読むラベル名・Status の名前を、CLAUDE.md の文で変えたことにする（変わらない。`issue-workflow` の「使う側のリポジトリが持つもの」）
