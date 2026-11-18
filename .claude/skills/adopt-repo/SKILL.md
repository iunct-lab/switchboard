---
name: adopt-repo
description: 既存の自分のリポジトリを Switchboard で回し始めるときに、元の決まり（CLAUDE.md・AGENTS.md・Issue テンプレート・ラベル・Project・枝とコミットの決まり）を読んで対応表を作り、元の決まりを書き換えずに、アプリが動くのに要るもの（決まりの文と、CI の手順などの設定）を Switchboard の側に置く（選べばそのリポジトリへの足すだけの PR にする）までの手順。バックログを GitHub に置くか Switchboard に置くかは別に選ぶ。利用者に既存のリポジトリの取り込みを頼まれたときに読む。新しく作るなら new-repo。次は request-to-backlog
---

# 既存のリポジトリを取り込む（診断 → 対応表 → 2 つの置き場と衝突を聞く → 置く → 開始条件 → 報告）

何を元のまま活かし、何を足し、何を元の決まりで上書きできるかの正本は `docs/design/new-repo.md` の「Adopting an existing repository's rules」（決まりの 3 つの種類の表。同じ文書の冒頭の「The three layers」とは別の表）。ここは**それを実行する順番とコマンド**だけで、表は写さない。手順をスクリプトやデーモンのコードにしない。

前提: 自分は Switchboard の Task で、`$SWITCHBOARD_REPO_ROOT` が Switchboard のチェックアウトを指す。対象は登録済みの workspace のうち、自分のリポジトリ（`upstream` が無い）。GitHub と連携しない workspace（バックログを Switchboard に置くもの。指示文にある）も対象で、そのときは GitHub を読む・書く行（1 のラベル・Project・既存の Issue・枝の保護、4 のラベル・Project・変数・`projectVar`）を飛ばす。設定をどこに持つか（Switchboard の側 / リポジトリ）と、バックログをどこに置くか（GitHub / Switchboard）は別の選択で、3 で 1 つずつ聞く。対象のディレクトリと workspace の id は指示文にある。リモート `origin` の無いリポジトリでは、`fetch` をせず、下の `origin/<branch>` を `HEAD` に読み替え、`<repo>` は無い（報告には workspace の名前を書く）。以下 `<dir>` は対象の clone、`<repo>` は `<dir>` で `gh repo view --json nameWithOwner -q .nameWithOwner` の答え、`<branch>` は同じく `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` の答え。GitHub と連携しない workspace で `gh repo view` が答えない（`origin` が GitHub でない、`gh` で読めない）ときは、`<branch>` を `git -C <dir> symbolic-ref --short refs/remotes/origin/HEAD` の答えから `origin/` を除いたもの（答えが無ければ、対象の git に書かない `git -C <dir> ls-remote --symref origin HEAD` の `ref: refs/heads/<branch>` の行から）とし、`<repo>` は無い。

対象外: 他者のリポジトリ（`upstream` がある。`docs/design/new-repo.md` の「Other people's repositories」）、まだ無いリポジトリ（`new-repo`）。

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
| テストのコマンド | 上の指示のファイル・貢献の決まり・`.github/workflows/` の `run:`・`package.json` の `scripts`・`Makefile` などから、PR を出す前に回すと書いてあるコマンド（依存の導入・lint・型検査・テスト） | 回す順に 1 行ずつのコマンドと、どのファイルのどの節にあったか（3 で CI の手順として見せ、4-A で置く。元に書いていないコマンドは足さない） |
| ラベル | `gh label list -R <repo> --limit 200 --json name,description` と、キットの `$SWITCHBOARD_REPO_ROOT/ops-kit/template/.github/labels.yml`（と `needs-decision`。`labels.yml` に無いがアプリが名前で読む。色と説明の定義が無いので、元に無くても 4 では作らない） | キットにあって元に無い名前、同じ名前で説明（意味）が違うもの、元だけにあるもの |
| Project | `gh repo view <repo> --json projectsV2`、変数 `gh variable list -R <repo>`、`gh project field-list <n> --owner <owner> --format json` | Status の選択肢、Priority・Story Points の有無と形、元だけのフィールド |
| 既存の Issue | `gh issue list -R <repo> --state open --limit 1000 --json labels`（本文は読まない）と、最大の番号は `gh issue list -R <repo> --state all --limit 1 --json number` | 開いているものの `type:*` のラベルごとの数、`type:*` の無いものの数（Backlog 画面に出ない）、取り込みの時点の最大の番号 |
| 枝とコミット | `gh api repos/<repo>/branches/<branch>/protection`（404・403 = 読めない / 保護なし）、`git -C <dir> log --format=%s -30 origin/<branch>` | 必須のレビュー・必須のチェック、コミットの題の形 |
| Switchboard の設定 | `ops.config.json` と `scripts/setup/` を `show` | 既にあるか。`scripts/setup/` の入口がキットを呼ぶか（`src/cli.ts` を含むか。`docs/design/skill-sync.md` の「Copies of the operations tools」） |

期待: 表の 9 行すべてに「ある（何）/ 無い / 読めない」が控えてある。

## 2. 対応表

1 で控えたものを 1 行ずつ、列「項目 / 元の値 / 種類（`docs/design/new-repo.md` の 3 つの種類の番号）/ どうするか」の表にする。どうするかは次の 3 つだけ:

- **そのまま**: 元の決まりが正。種類 1 の全部と、種類 3 で元に決まりがあるもの（基準にする閉じた PBI・積む PR か 1 本ずつか・worktree の場所などは元が勝つ）
- **足す**: 種類 2 で元に無いもの。消さずに足す
- **衝突**: 種類 2 で、同じ名前で中身が違うもの、元の決まりと両立しないもの。3 で聞く

種類 2 は元の決まりで変えられない（キットとスクリプトが値や名前で読む。Story Points の尺度、Task の枝の `sb/` の接頭辞、マージ判定が読む PR のレビューの印など）。元の決まりが違えば、元の決まりは人の作業のために残し、Switchboard の Task は種類 2 に従う、と 4 の決まりの文（置き場 A）か CLAUDE.md の節（置き場 B）に書く。

種類 3 で元の決まりが勝つ行は、4 の決まりの文（置き場 A）か CLAUDE.md の節（置き場 B）にその違いを 1 行ずつ書く（置き場 A では Task の指示文に足され、置き場 B ではスキルが CLAUDE.md の値を読むので、書けば Task は元の決まりで動く）。

表は作業ファイル（`W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.adopt.XXXXXX")`）に Markdown で書き、Task の成果物に登録する（返答の中の `switchboard-artifact` のフェンス。`docs/design/artifacts.md`）。

期待: 1 で控えた全部が表の行になり、「そのまま / 足す / 衝突」の数が数えてある。

## 3. 衝突の聞き方

4 に進む前に（GitHub とアプリに何かを書く前に）、衝突が 0 件でも、Task の会話で対応表と、2 つの置き場の選択（設定の置き場とバックログの置き場）と、4 で書くもの（決まりの文の中身。設定を Switchboard の側に置くなら、1 のテストのコマンドから作った CI の手順を 1 行ずつ、出どころの節と一緒に。バックログを GitHub に置くならラベル・Project・リポジトリ変数・workspace の `projectVar`。設定を PR で足すなら PR に入れるファイルも）を見せて OK を取り、ターンを終える（取り込みは対象のリポジトリの運用を決めるので、利用者がその場で答える。対象のリポジトリの Issue には書かない）。「衝突」の行があれば、同じ問いで行ごとに問い・選択肢・推奨を書く。よくある形（Project・ラベル・Issue の 4 行は、バックログを GitHub に置くときだけ当たる。バックログを Switchboard に置くなら聞かない。下の表と 4 で「置き場 A / B」と書くのは設定の置き場）:

| 衝突の形 | 選択肢 | 推奨 |
|---|---|---|
| Project の Status の選択肢が違う（Todo / In Progress / Done など） | A. Switchboard 用の Project を別に作り、元の Project は元のまま / B. 元の Project を使い、Switchboard の Status を利用者が画面で足す | A（元のボードを変えない。選択肢を API で差し替えると全部の項目の Status が消える） |
| 同じ名前のラベルで意味が違う（`type:task` が元では別の意味、など） | A. 元のラベルのまま Switchboard の Issue にも付ける / B. GitHub に Switchboard の Issue を作らない（バックログの置き場を Switchboard にする） | 意味が近ければ A、遠ければ B |
| 元の運用が Issue を使わない（PR だけで進める、Issue を閉じている） | A. Switchboard の要望・PBI・Task の Issue を GitHub に足す / B. GitHub に Issue を作らない（同上） | 元が Issue を閉じているなら B |
| Project の Priority の選択肢が P0〜P3 でない（High / Medium / Low など） | A. Switchboard 用の Project を別に作る（キットの P0〜P3。元の Project は元のまま） / B. 取り込みを止める | A（デーモンは P0〜P3 の名前で順位を付けるので、元の選択肢のままでは順に進まない。元の Project の Priority に P0〜P3 を足す選択肢は置かない: 1 つのフィールドに 2 つの尺度が並び、元のボードの読み方が変わる） |
| （置き場 B のときだけ）元の決まりが main の作業ツリーの更新（pull）に OK を求める（動いているサービスが見ている、など） | 4 のマージの後の `ops-kit pull-main` を、この OK に含めるか、回さずに利用者に任せるか | 含める（含めなければ回さず、6 の報告に書く） |
| AGENTS.md に独自の中身があり、CLAUDE.md を読ませるのがその方針に反する（「CLAUDE.md は Claude 用」など） | A. CLAUDE.md を読む 1 行を足す（置き場 A では決まりの文に、置き場 B では AGENTS.md の末尾に） / B. 取り込みを止める（Codex の Task が CLAUDE.md の値を読めないまま動くのを避ける） | 方針が読ませないと言っていなければ A |

その workspace に既に決まりが置いてあれば（`curl -fsS -H "authorization: Bearer $(cat "$BACKLOG_TOKEN_FILE")" "${BACKLOG_URL%/api/backlog}/api/workspaces" | jq -r '.[] | select(.id == "<id>") | .rules // empty'` に出る。利用者が設定で直した文かもしれない）、問いに今の文と 4 で置く文の両方を見せ、置き換えてよいか、今の文のどの行を残すかを聞く（4-A は文を丸ごと置き換える）。置き場 B を選ぶなら、今の文を消してよいかを聞く（残すと Task の指示文に CLAUDE.md の節と古い文の両方が入る。消すのは 4-B のマージの後に、4-A の `PUT` に空の文 `{"rules":""}` を送る）。

置き場は独立の 2 つで、問いに必ず両方入れる。

**設定の置き場**（決まりの文と、`ops.config.json` と同じ形の設定: CI の手順・Project のフィールド・必須の節。答えが無ければ A）:

- **A. Switchboard の側に置く（既定）**: 決まりの文と設定を Switchboard に置く。決まりの文はこのリポジトリの Task の指示文に足され、設定はこの workspace の Task・ローカル CI・バックログの道具が読む。リポジトリの作業ツリー・枝・リモートには何も書かない。Switchboard の外（手元のランナーなど）では決まりの文は効かない（キットは、設定のファイルの場所を環境変数 `OPS_KIT_CONFIG` で渡せば同じ設定で動く）
- **B. リポジトリに PR で足す**: `ops.config.json`・CLAUDE.md の節・AGENTS.md の 1 行をそのリポジトリにコミットする。どこで動かしても効くが、相手の git に Switchboard の記載が入る。リポジトリに `ops.config.json` があるあいだ、Switchboard の側の設定は使われない（2 つをキーごとに混ぜない）

**バックログの置き場**（要望・PBI・Task。答えが無ければ、その workspace の今の置き場のまま）:

- **GitHub の Issue・Project**: GitHub にラベルと Project を足す（4 の「GitHub に足すもの」）。リポジトリの git には書かない
- **Switchboard**: GitHub には何も書かない。GitHub と連携している workspace なら、利用者が設定の「GitHub 同期」でその workspace の連携を切り、済んだと返事をもらってから 4 に進む（問いにそう書く。同じリポジトリを別の workspace でも登録していれば、その workspace の GitHub との同期も一緒に無効になることも問いに書く）

組み合わせごとの書く先（問いに、選べる行を見せる）:

| 設定 | バックログ | Switchboard に書く | GitHub に書く | リポジトリの git に書く |
|---|---|---|---|---|
| A. Switchboard の側 | GitHub | 決まりの文、設定（CI の手順と、キットの雛形の Project のフィールド・必須の節）、`projectVar` | ラベル（無い名前だけ）、Project、リポジトリ変数 | 何も書かない |
| A. Switchboard の側 | Switchboard | 決まりの文、設定（CI の手順。フィールドを変えるならその値も） | 何も書かない | 何も書かない |
| B. リポジトリに PR | GitHub | `projectVar` | ラベル（無い名前だけ）、Project、リポジトリ変数、PR | `ops.config.json`・CLAUDE.md の節・AGENTS.md の 1 行（PR） |
| B. リポジトリに PR | Switchboard | 何も書かない | PR | 同上（PR） |

リモート `origin` の無いリポジトリと、`origin` が GitHub に無いリポジトリ（前提の `<repo>` が無い）では、設定の置き場は A だけ（B は GitHub の PR と `gh` を前提にする）で、バックログの置き場は Switchboard だけ。問いに B と GitHub の行を見せない。

期待: 利用者の OK と 2 つの置き場の答えがあり、全部の衝突の行に答えがある。OK が無い、または答えが「取り込みを止める」なら 4 に進まず、6 の報告に止めた理由を書いて終える。

## 4. 置く（Switchboard の側か、足すだけの PR。GitHub にはバックログを置くときだけ）

置く前に、その workspace のバックログの置き場が 3 の答えと同じことを自分で確かめる（利用者の「切った」の返事だけで進まない）: `curl -fsS -H "authorization: Bearer $(cat "$BACKLOG_TOKEN_FILE")" "${BACKLOG_URL%/api/backlog}/api/workspaces" | jq -r '.[] | select(.id == "<id>") | .backlog'` が、答えが Switchboard なら `switchboard`、GitHub なら `github`。違えば置かず、3 の問いに戻る（そのまま進むと、後の Task が答えと違う場所に Issue を作る。置き場の切り替えは、どちらの向きも利用者が設定で行う。Task は切り替えない）。

### 4-A. Switchboard の側に置く

決まりの文を 1 つ作る。中身は、下の表の CLAUDE.md の行が節に書くもの全部（チェックリストのうち元に無くて使うものの値、種類 3 で元が勝った行、種類 2 と違う元の決まりの扱い、取り込む前の Issue の扱い）と、Codex の Task のための 1 行（AGENTS.md が CLAUDE.md を指していなければ「CLAUDE.md も読む」）。元の文書にある値は写さず、節の名前で指す。認証に使える値は書かない（長すぎる文と認証の値は API が断る）。

```bash
{ git -C <dir> status --porcelain; git -C <dir> log --oneline origin/<branch>..; } > "$W/before.txt"     # 置く前の控え（origin が無ければ log の行を外す）
B=${BACKLOG_URL%/api/backlog}; K=$(cat "$BACKLOG_TOKEN_FILE")
jq -n --rawfile rules "$W/rules.md" '{rules:$rules}' | curl -fsS -X PUT "$B/api/workspaces/<id>/rules" -H "authorization: Bearer $K" -H 'content-type: application/json' --data-binary @- | jq -e -r '.rules | strings | length'
jq -Rs 'gsub("^\\s+|\\s+$"; "") | length' "$W/rules.md"     # 置く前の字数（API は前後の空白を落として置く）
{ git -C <dir> status --porcelain; git -C <dir> log --oneline origin/<branch>..; } | diff - "$W/before.txt"     # 置いた後。出力なしで exit 0（origin が無ければ、控えと同じく log の行を外す）
```

続けて設定を置く。作業ファイル `$W/config.json` に、`ops.config.json` と同じ形の JSON を書く:

- `ci.steps`: 3 で OK を受けた CI の手順（1 のテストのコマンドを、回す順に `{ "name": "<短い名前>", "run": "<コマンド>" }`）。元にテストのコマンドが 1 つも書いていなければ `ci` を書かない（手順を作らず、6 の報告に「CI の手順 0 個」と書く。リポジトリに `.github/workflows/ci.yml` があれば、ローカル CI はその手順で回る）
- バックログを GitHub に置くなら、キットの雛形（`$SWITCHBOARD_REPO_ROOT/ops-kit/template/ops.config.json`）の残りのキーも（`envPrefix` を決める。Priority の選択肢はキットの P0〜P3 のまま）。バックログを Switchboard に置くなら、雛形と違う値にするキーだけ（書かなければキットの既定で検査する）
- `publicSync` と認証に使える値は書かない（API が理由の 1 行つきで断る。`publicSync` はリポジトリのファイルに置くもの）

```bash
jq -n --rawfile config "$W/config.json" '{config:$config}' | curl -sS -X PUT "$B/api/workspaces/<id>/config" -H "authorization: Bearer $K" -H 'content-type: application/json' --data-binary @- | tee "$W/config.put" | jq -e -r '.pending.keys // [] | join(",")'     # 確認待ちになったキー。断られたら exit が 0 でなく、"$W/config.put" の .error に理由の 1 行
# Task からの保存は「確認待ちの変更」になるだけで、まだ使われない。利用者が判断待ちで確認してから読み直す（下の説明）
curl -fsS "$B/api/workspaces/<id>/config" -H "authorization: Bearer $K" | tee "$W/config.out" | jq -e -r 'select(.pending == null) | .file | strings'     # 確認のあと: 置いたファイルの場所。確認待ちのあいだは exit が 0 でない
jq -r '.config | fromjson | (.ci.steps // []) | length' "$W/config.out"     # 置いた CI の手順の数（6 の報告に書く）
jq -r '.source' "$W/config.out"     # switchboard = この設定で動く。repository = リポジトリに ops.config.json があり、置いた設定は使われない
{ git -C <dir> status --porcelain; git -C <dir> log --oneline origin/<branch>..; } | diff - "$W/before.txt"     # 設定を置いた後も出力なしで exit 0
```

設定の保存は利用者の確認を待つ。Task の呼び出しは変更を記録して確認待ちにするだけで、ローカル CI・マージ判定・キットが読むファイルは利用者が確かめた版のまま（初めてならファイルはまだ無い）。アプリの判断待ちに「workspace <名前> の設定（Switchboard の側）の変更を反映してよいですか」が出るので、PUT のあとその問いを利用者に伝え（キーと前後の値は問いに出る）、止まりの記録（reason `decision`）を書いてターンを終える。確認のあと再開したら、上の GET で `.pending` が null で `.config` が置いた中身であることを確かめてから続ける。利用者が断ったら `.config` は前のままなので、理由を聞いて設定を直す。Task が自分で確認の回答を送ることはできない（403）し、データベースやファイルを直接書いて確認を飛ばさない。

1 でリポジトリに `ops.config.json` があったなら、設定は置かない（置いても使われない）。3 の問いにそう書いて、決まりの文だけを置く。このとき `$W/config.out` は無いので、下で `$(jq -r .file "$W/config.out")` と書いてある 2 か所（「GitHub に足すもの」の `--config` と、5 の lint の `OPS_KIT_CONFIG`）はリポジトリのファイル `<dir>/ops.config.json` に読み替え、下の期待のうち設定の行（ファイルのパスと `source`）は対象外。

期待: 決まりの文の 1 行目が exit 0 で、2 つの字数が同じ（`curl` が失敗か、応答に `rules` の文が無ければ exit が 0 でない。そのときは置けていないので、理由を読んで直す）。設定の 1 行目がファイルのパスを出して exit 0 で、`source` が `switchboard`。`git -C <dir> status --porcelain` と `git -C <dir> log --oneline origin/<branch>..`（`origin` が無ければ見ない）の出力が置く前に控えたもの（`$W/before.txt`）と同じで（利用者の作業中の変更や push していないコミットは元からあってよい）、`git -C <dir> branch --list 'sb/*'` に取り込みの枝が無い（リポジトリには何も書いていない）。

### GitHub に足すもの（バックログを GitHub に置くとき。設定の置き場が A でも B でも）

4-B の表の「ラベル」と「Project」の行をそのまま行う（どちらも GitHub への書き込みで、リポジトリの git には書かない）。設定の置き場が A のときは、その行の `--config <worktree>/ops.config.json` を、4-A で置いた設定のファイル（`--config "$(jq -r .file "$W/config.out")"`）に読み替える。最後に workspace の `projectVar` を `<PREFIX>_PROJECT_URL` にするのも同じ。

期待: 作ったラベルの名前と Project の URL が控えてある。設定の置き場が A なら、`git -C <dir> status --porcelain` と `git -C <dir> branch --list 'sb/*'` が置く前と同じ（リポジトリの作業ツリー・枝・リモートには何も書いていない）。

### 4-B. リポジトリに PR で足す

3 で OK を受けた範囲だけを（2 の「足す」の行と、下の CLAUDE.md の行が節に書くもの全部と、3 の答え）、`<dir>` の worktree で 1 本の PR にする。worktree の場所とコミットの題の形は、元の決まりがあればそれ、無ければ `git -C <dir> worktree add --detach ../<name>-adopt origin/<branch>`。枝はこの Task も Task なので `sb/adopt-switchboard`（種類 2。元の枝の決まりは人の作業のもの）。バックログを Switchboard に置くなら、下の表の「ラベル」と「Project」の行は飛ばす（GitHub に書くのは PR だけ。3 の表の「B / Switchboard」の行）。

| 足すもの | どう足すか |
|---|---|
| `ops.config.json`（無いとき） | `$SWITCHBOARD_REPO_ROOT/ops-kit/template/ops.config.json` を写し、`envPrefix` を決める。Priority の選択肢はキットの P0〜P3 のまま（デーモンが名前で順位を付ける。元の Priority の選択肢が違えば 3 の衝突）。あれば触らない |
| ラベル（バックログを GitHub に置くときだけ） | 無い名前だけ `env -u BACKLOG_URL gh label create <name> --color <色> --description <説明> -R <repo>`（`--force` を付けない。付けなければ同じ名前があると失敗し、元のラベルは変わらない）。キットの `labels.yml` の行を使う。Task の中の `gh` の前段はラベルの定義の書き込みを止めて `ops-kit sync-labels` を勧めるが、`sync-labels` は同じ名前の元のラベルの色と説明をキットの値に書き換えるので、取り込みでは使わない。PR ではなく GitHub への書き込みなので、PR の本文に作ったラベルを書く |
| Project（バックログを GitHub に置くときだけ） | 無いとき・3 の Status か Priority の行で A のとき: 設定のファイルを書き換えず、存在しない番号 0 の URL を環境変数で渡して bootstrap で作る: `env -u BACKLOG_URL -u <PREFIX>_PROJECT_OWNER <PREFIX>_PROJECT_URL=https://github.com/<orgs\|users>/<owner>/projects/0 bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" bootstrap "<name> (Switchboard)" --config <worktree>/ops.config.json`。題は元の Project と違う名前にする（bootstrap は同じ題の Project を見つけるとそれを使い、元の Project にフィールドを足す）。期待: 出力に `>> Project #<n>「<題>」を作成` が出る（「既存の Project … を使う」なら止めて題を変える）。続けて `new-repo` の 2 と同じく `gh project link <n>` と変数 `<PREFIX>_PROJECT_URL`（URL は作った `<n>` の URL）。元の Project を使うとき（Status と Priority の選択肢が同じとき、または 3 の Status の行で B で Priority の衝突が無いとき）: まだならリポジトリにひも付け（`gh project link <n> --owner <owner> -R <repo>`）、元の Project の URL で変数を作り（`gh variable set <PREFIX>_PROJECT_URL -R <repo> --body <URL>`）、足りないフィールド（Priority・Story Points）は URL を環境変数で渡した bootstrap で足す: `env -u BACKLOG_URL -u <PREFIX>_PROJECT_OWNER <PREFIX>_PROJECT_URL=<URL> bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" bootstrap "<元の Project の題>" --config <worktree>/ops.config.json`（設定のファイルは書き換えない。既存の Project には足りないフィールドだけを作り、Status は変えない）。どちらの道でも、最後に workspace の `projectVar` を `<PREFIX>_PROJECT_URL` にする（`new-repo` の 4 の PATCH。`envPrefix` が `SWITCHBOARD` でも省かない。`projectVar` の無い workspace はデーモンの環境変数 `SWITCHBOARD_PROJECT_URL` を先に読み、別の Project を取り込む） |
| CLAUDE.md | 末尾に節 `## Switchboard で動かすとき` を 1 つ足す。中身は、チェックリストのうち元に無くて使うものの値と、2 で種類 3 の元の決まりが勝った行（「Story Points の基準にする閉じた PBI は #<n>」「PR は積まず 1 本ずつ」など）と、種類 2 と違う元の決まりを Task がどう扱うか（「人の枝は `feature/<topic>`、Task の枝は `sb/<n>-<topic>`」など）。1 で `type:*` の付いた既存の Issue があったら（扱いの正本は `docs/design/new-repo.md` の「Adopting an existing repository's rules」の既存の Issue の段落）、「取り込む前の Issue（#<1 で控えた最大の番号> 以下）は書き換えず、閉じず、そのまま Task で進めない。その `ops-kit lint` の違反は、ほかの Issue を確かめるときには数えない。工程の入口の指示文で取り込む前の Issue（#<1 で控えた最大の番号> 以下）を渡されたら、ボタンで始まったのか自動で拾われたのかを Task は区別できないので、何も作らずに終え、報告に書く。進めるのは、利用者が会話か要望の文で番号を名指ししたものだけで、`request-to-backlog` で経路 `Issue #<番号>` の要望にする」の 1 行も書く（`pbi-to-tasks` の Ready・`request-to-backlog` の 5 などは lint の違反 0 を求めるので、無いと古い Issue の違反で止まるか、元の Issue を書き換えることになる。後の Task が読むのは CLAUDE.md なので、進め方もここに書く）。元の節に同じ値があれば、その節の名前で指す（写さない）。元のファイルに「何を書くか」の方針があれば、それを守る（そのリポジトリの値だけを書く）。CLAUDE.md が無ければ、`$SWITCHBOARD_REPO_ROOT/ops-kit/template/CLAUDE.md.tmpl` から使う節だけで作る |
| AGENTS.md | CLAUDE.md を指していなければ、末尾に CLAUDE.md を読むことを 1 行足す（種類 2）。無ければ `$SWITCHBOARD_REPO_ROOT/ops-kit/template/AGENTS.md.tmpl` を写し、`__REPO__` をリポジトリ名に置換する（`grep -n '__[A-Z_]*__' AGENTS.md` が 0 件） |
| Issue テンプレート・`scripts/setup/` の入口 | 足さない（Task は `ops-kit backlog` と `ops-kit lint --fresh` を使う。`docs/design/new-repo.md` の種類 1） |

PR の本文に 2 の対応表を貼る。PR の中身が 3 で OK を受けた範囲から外れたら（レビューの指摘で中身が変わったときも）、マージせず、変わったところを Task の会話で見せて OK を取り直す。レビューとマージは `cross-runner-review` → `review-triage-and-merge` → `bun $SWITCHBOARD_REPO_ROOT/scripts/merge-gate.ts <PR> --repo <repo> --merge`（Switchboard のリポジトリの外の PR。`--repo` を必ず付ける）。マージしたら `<dir>` で `ops-kit pull-main` を回して workspace の作業ツリーを最新にする（元の決まりが pull に OK を求めるなら、3 でその OK を受けたときだけ。受けていなければ回さず、6 の報告に書く。アプリは `<dir>` の `ops.config.json` を読むので、古いままだと足した設定が後の Task に効かない。exit 1 / 2 なら、出力の 1 行を 6 の報告に書く）。3 で今の決まり（Switchboard の側の古い文）を消すと答えていれば、pull-main が済んで作業ツリーに CLAUDE.md の節が入ってから、4-A の `PUT` に `{"rules":""}` を送って消す（pull しなかった・できなかったときは消さず、6 の報告に書く。先に消すと、pull までの Task にどちらの決まりも届かない）。

期待: 既存のファイルから消えた行が無い。`git -C <worktree> diff -U0 origin/<branch>... | grep -E '^-' | grep -vE '^--- (a/|/dev/null)'` に出るのは、末尾に改行の無かった元の最後の行（同じ文が `+` の側にもある）だけ（`- ` で始まる箇条書きの行も、消せばここに出る）。足した行に雛形のプレースホルダーが残っていない（`git -C <worktree> diff -U0 origin/<branch>... | grep -E '^\+.*__[A-Z_]+__'` が 0 件。元からある文は見ない）。

## 5. 開始条件

`docs/design/new-repo.md` の「Conditions to start」の表を上から回し（`new-repo` の 5 と同じ）、条件ごとに通った / 通らない / 未確認を控える。取り込んだリポジトリでは 3 つを読み替える:

- 「The backlog rules」: `scripts/setup/` の入口を足さないので、設定の置き場が A でバックログが GitHub なら、4-A で置いた設定のファイルを渡して `(cd <dir> && OPS_KIT_CONFIG="$(jq -r .file "$W/config.out")" GH_REPO=<repo> ops-kit lint --fresh)` を回す（設定をコミットした worktree は要らない）。設定の置き場が B なら、`ops.config.json` のある 4 の worktree で `(cd <worktree> && GH_REPO=<repo> ops-kit lint --fresh)`（設定がどこにも無いところで `GH_REPO` を付けると exit 2）。バックログを Switchboard に置く workspace では `(cd <dir> && env -u GH_REPO BACKLOG_WORKSPACE=<id> ops-kit lint --fresh)`（設定が無ければキットの既定で検査する）。「The Project URL」は対象外。取り込む前の Issue の違反は 4 の決まりの文（4-B では CLAUDE.md の行）のとおり数えず直さない。その数を控え、条件は「通った（取り込む前の Issue の違反 <n> 件は数えない）」と書く。取り込みの後に Switchboard が作った Issue の違反は直す
- 「The 4 items of `CLAUDE.md`」: 見出しの名前が元の CLAUDE.md と違えば grep は当たらない。4 項目（テストの 3 コマンド・作業の場所と枝・live check・反映の OK）それぞれの値がある節の名前を控え、無いものは 4 の節（4-A では決まりの文）に足す
- 「The merge judgement」: GitHub と連携しない workspace（PR が無い）では「対象外」と控える。設定の置き場 A で GitHub のリモートがあるリポジトリでは、最初の PR が出るまで「未確認（最初の PR の後）」。CI の手順を置いていれば、その PR のローカル CI（Task の中は `ops-kit job request local-ci <PR>`、外は `<dir>` で `bun $SWITCHBOARD_REPO_ROOT/scripts/local-ci.ts <PR> --repo <repo>`）が Switchboard の側の手順で回り、結果のコメントに workspace の名前と手順のハッシュが出る

スキルの印は、その workspace の Task を 1 つ起動したあとでないと出ない（未起動なら「未確認（最初の Task の後）」）。

既存の Issue はここでも書き換えない。Switchboard で進めたいものは、利用者が会話か要望の文で番号を挙げたものだけ `request-to-backlog` で、`## 出典` の経路を `Issue #<元の番号>` にした要望 Issue にする（元の Issue は開いたまま残り、要望 Issue から指す）。この手順では選ばない。

期待: 表の 6 行すべてに「通った / 通らない / 未確認 / 対象外」がある。

## 6. 報告

```
取り込み <repo>（<dir>、workspace <id>）
対応表: そのまま <n> / 足す <n> / 衝突 <n>（答え: …）。成果物: <題>
設定の置き場: <Switchboard の側（決まり <n> 字、CI の手順 <n> 個。リポジトリの git には何も書いていない）/ リポジトリに PR>
バックログの置き場: <GitHub の Issue・Project / Switchboard（GitHub には何も書いていない）>
PR: <URL>（マージ済み / レビュー中）/ なし。main: <pull-main の出力の 1 行 / 回していない（理由）>。GitHub に足したもの: ラベル <名前…> / Project <URL>（作ったとき）
| 開始してよい条件 | 結果 |
既存の Issue: open <n> 件（type:request <n> / type:pbi <n> / type:task <n> / type なし <n>）。進めるものは request-to-backlog で要望にする（元の Issue は書き換えない）
利用者確認: Project のビュー 2 つ（新しく Project を作ったときだけ。`docs/design/new-repo.md` の「What stays manual」の 1）
```

秘密の値は報告に書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。

期待: 報告の 8 行（取り込み・対応表・設定の置き場・バックログの置き場・PR・開始条件の表・既存の Issue・利用者確認）がどれも埋まっている（当たらない行は「なし」）。

## やらないこと

- 元のラベル・Project の選択肢・既存の Issue・文書の既存の文を消す・名前を変える・書き換える
- 種類 3 の Switchboard の既定（基準にする閉じた PBI、積む PR など）を、元の決まりより優先する
- 既存の Issue に一括で `type:*` のラベルを付ける、本文に Switchboard の節を足す
- アプリが読むラベル名・Status の名前を、CLAUDE.md の文で変えたことにする（変わらない。`issue-workflow` の「使う側のリポジトリが持つもの」）
