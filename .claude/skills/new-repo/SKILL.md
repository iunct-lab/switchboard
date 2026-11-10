---
name: new-repo
description: 新しいリポジトリを雛形から作り、GitHub 側（リポジトリ・Project・変数・ラベル）と Switchboard への登録まで済ませる手順。設定タブの「新しいリポジトリ」から始まった Task、利用者に新しいリポジトリを頼まれたときに読む。GitHub を使わないリポジトリの作成（7-1）と、前の雛形で作った既存リポジトリへの写し方（7-2）も扱う。次は request-to-backlog
---

# 新しいリポジトリを作る（雛形 → GitHub 側 → 初期コミット → 登録 → 開始条件 → 報告）

何が要り、どこまで揃えば開始してよいかの正本は `docs/design/new-repo.md`（3 つの層・用途による違い・手作業で残るもの・開始してよい条件）。ここは**それを実行する順番とコマンド**だけで、条件は写さない。雛形は `ops-kit/template/`（`ops-kit/README.md` の「雛形（新しいリポジトリ）」にファイルとプレースホルダの表）。手順をスクリプトやデーモンのコードにしない。失敗しても作ったものを消さず、作ったものを報告して止まる（削除は人が行う）。

前提: 自分は Switchboard の Task で、`$SWITCHBOARD_REPO_ROOT` が Switchboard のチェックアウトを指す。

**GitHub を使わないリポジトリ（リモートなし）なら**、2（GitHub 側）と、3 の `.github/`・`project-autoadd` の手順を飛ばし、雛形は `ops-kit/template/` でなく `ops-kit/template-local/` を使う。手順は末尾の 7 にまとめてある（新しく作る手順と、前の雛形で作った既存のリポジトリへの写し方）。

## 1. 決めること

次を全部決めてから作る。決まっていないものは Task の会話で聞いてターンを終える（`issue-workflow` の「判断待ちの出し方」の運用の確認。Issue に書かない）。

| 項目 | 内容 |
|---|---|
| 名前・owner | `<owner>/<name>`。owner が組織かユーザーか（Project の URL の `orgs` / `users`） |
| 可視性 | **private 固定**。public が要るなら作らず止めて聞く（`issue-workflow` の Task 粒度チェック 6 の Public 切替） |
| `envPrefix` | 変数 `<PREFIX>_PROJECT_URL` の接頭辞（`ops.config.json` の `envPrefix`）。大文字・英数字と `_` |
| Area | 値の一覧（`__AREA__` を数だけ増やす）。ラベル `area:<値>` も同じ数 |
| Phase | 使うか。使うなら `ops-kit/fixtures/config-with-phase.json` の `phase` / `milestone` を `ops.config.json` に、`pbi.yml` に Phase の dropdown を足す。使わないなら何もしない |
| テストの 3 コマンド | 型検査 `__TEST_TYPECHECK__` / 全体 `__TEST_ALL__`（`ci.yml` の `run:` にも入る。別の言語ならその step に書き換える）/ 1 件 `__TEST_ONE__` |
| 互換の前提・動いている実物と反映の OK | `__COMPAT__` / `__LIVE_CHECK__` / `__DEPLOY_OK__`。用途ごとの違いは `docs/design/new-repo.md` の「用途による違い」の表から選ぶ |
| 置き場所 | `<dir>` = `$(dirname "$SWITCHBOARD_REPO_ROOT")/<name>`（Switchboard のチェックアウトの隣） |
| project-autoadd | `docs/design/new-repo.md` の「手作業で残るもの」の 3 に従う。既定は置かない（PAT の登録と更新が要る。雛形に入っていて Project の変数があると動き、PAT が無いと失敗する）。置かないなら 3 で `.github/workflows/project-autoadd.yml` を消す。置くなら PAT をリポジトリのシークレットに登録する旨を 6 で報告する |
| そのほか | `__KIT_REPO__`（Switchboard のリポジトリの `owner/name`）、`__TASK_CHECK__`、`__QUOTA_CHECK__`（この環境の値） |

期待: 上の全部に値がある。足りないものは聞く（推測で埋めない）。

## 2. GitHub 側

```bash
gh repo create <owner>/<name> --private
gh repo view <owner>/<name> --json visibility -q .visibility          # 期待: PRIVATE
```

Project は `bootstrap` が作る（番号が無ければ題で探し、無ければ作る）。まだ URL が無いので、`<dir>/ops.config.json` に存在しない番号 `0` の `projectUrl` を**一時的に**足す（環境変数 `<PREFIX>_PROJECT_URL` で渡すと、作った Project の URL が出力されない）。ビューは API で作れない（手作業。6 で報告）。

```bash
# bootstrap とラベルは <dir> の ops.config.json と labels.yml を読むので、先に 3 の「写して値を置換する」までを済ませておく
jq '. + {projectUrl: "https://github.com/<orgs|users>/<owner>/projects/0"}' <dir>/ops.config.json > <dir>/ops.config.tmp && mv <dir>/ops.config.tmp <dir>/ops.config.json
# BACKLOG_URL も外す: アプリの Task の中では bootstrap は止まる（まだ workspace の無い新しいリポジトリの Project はここで GitHub に作る）
env -u <PREFIX>_PROJECT_URL -u <PREFIX>_PROJECT_OWNER -u BACKLOG_URL \
  bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" bootstrap "<name>" --config <dir>/ops.config.json
jq 'del(.projectUrl)' <dir>/ops.config.json > <dir>/ops.config.tmp && mv <dir>/ops.config.tmp <dir>/ops.config.json     # Project は変数で指す。設定に URL を残さない
```

期待: bootstrap の出力に `Project の URL: https://github.com/<orgs|users>/<owner>/projects/<n>` が出る（`<n>` は 0 でない）。`projectUrl` を消したあと `grep -c projectUrl <dir>/ops.config.json` が 0。bootstrap は Project を作るだけで、リポジトリにはひも付けない（リポジトリの Projects タブに出ない）。その `<n>` をリポジトリにひも付ける:

```bash
gh project link <n> --owner <owner> -R <owner>/<name>
gh repo view <owner>/<name> --json projectsV2 -q '.projectsV2.Nodes[].number'   # 期待: 一覧に <n> が出る
```

その URL で変数を作る:

```bash
gh variable set <PREFIX>_PROJECT_URL -R <owner>/<name> --body <URL>
gh variable set <PREFIX>_ACTIONS -R <owner>/<name> --body on            # ci.yml と labels.yml はこの変数が on のリポジトリでだけ動く
gh variable get <PREFIX>_PROJECT_URL -R <owner>/<name>                  # 期待: <URL>
```

ラベルは Actions を待たず `labels.yml`（3 で値を入れたもの）から作り、足りない名前が無いことを確かめる。期待: 最後の出力が `missing: []`:

```bash
bun -e 'const l=Bun.YAML.parse(await Bun.file(process.argv[1]).text()) as {name:string;color:string;description?:string}[];
for(const x of l){const p=Bun.spawnSync(["gh","label","create",x.name,"--color",String(x.color),"--description",x.description??"","-R",process.argv[2],"--force"]);if(p.exitCode)console.error(x.name,p.stderr.toString())}
console.log(l.length)' <dir>/.github/labels.yml <owner>/<name>
bun -e 'const want=(Bun.YAML.parse(await Bun.file(process.argv[1]).text()) as {name:string}[]).map(x=>x.name);
const have=new Set(JSON.parse(Bun.spawnSync(["gh","label","list","-R",process.argv[2],"--limit","200","--json","name"]).stdout.toString()).map((x:{name:string})=>x.name));
console.log("missing:",want.filter(n=>!have.has(n)))' <dir>/.github/labels.yml <owner>/<name>
```

## 3. 雛形から初期コミット

順番: 2 の bootstrap とラベルが読む設定を先に置くので、次の「写して値を置換する」までは 2 の前にやる。コミットと push は 2 の後。

```bash
mkdir -p <dir> && cp -R "$SWITCHBOARD_REPO_ROOT/ops-kit/template/." <dir>        # 2 の前に済ませる
mv <dir>/CLAUDE.md.tmpl <dir>/CLAUDE.md; mv <dir>/AGENTS.md.tmpl <dir>/AGENTS.md
rm <dir>/.github/workflows/project-autoadd.yml     # 1 で「置かない」としたとき。置くなら残して `__PREFIX__` を置換する
```

`ops-kit/README.md` の「雛形」の表の `__NAME__` を、1 で決めた値で全ファイルに置換する（`__KIT_HOME_VAR__` は `SWITCHBOARD_REPO_ROOT`。`__AREA__` は 1 行 / 1 要素のところを Area の数だけ増やす）。仕組みは `sed` で足りる。置換のコマンドは作らない。

```bash
grep -rnE '__[A-Z_]+__' <dir> --exclude-dir=.git                                  # 期待: 0 件
for f in $(find <dir> -type f -not -path '*/.git/*'); do bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" scan-text "$f" || echo "HIT $f"; done   # 期待: HIT が 0 件
(cd <dir> && env -u BACKLOG_URL OPS_KIT="$SWITCHBOARD_REPO_ROOT/ops-kit" GH_REPO=<owner>/<name> bash scripts/setup/lint_backlog.sh; echo exit $?)   # 期待: 最後の行 violations: 0、exit 0
```

```bash
cd <dir> && git init -b main && git add -A && git commit -m "chore: 雛形から土台を置く" \
  && git remote add origin https://github.com/<owner>/<name>.git && git push -u origin main
git rev-parse HEAD                                                       # 期待: 初期コミットの sha
```

期待: `git ls-remote origin main` がその sha。

## 4. Switchboard への登録

デーモンは API に鍵を求める。Task にはデーモンが `BACKLOG_URL`（`<デーモン>/api/backlog`）と鍵のファイル `BACKLOG_TOKEN_FILE` を渡しているので、その鍵を Bearer で付ける。鍵の値は出力に出さない。

```bash
B=${BACKLOG_URL%/api/backlog}
K=$(cat "$BACKLOG_TOKEN_FILE")
ID=$(curl -s -X POST $B/api/workspaces -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{"path":"<dir>"}' | jq -r .id)
echo "$ID"                                                                # 期待: workspace の id（null や空でない）
curl -s -X PATCH $B/api/workspaces/$ID -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{"projectVar":"<PREFIX>_PROJECT_URL"}' | jq -r .projectVar
```

期待: 2 行目が `<PREFIX>_PROJECT_URL`。Issue がまだ無いので項目からは探せない。`curl -s -H "authorization: Bearer $K" "$B/api/backlog?refresh=1" | jq --arg id "$ID" '{sync: [.syncs[]|select(.workspaceId==$id)], errors: [.errors[]|select(.workspaceId==$id)]}'` で、`sync` に 1 件あり `syncing` が false、`errors` が `[]`（取込みを待つので数十秒かかることがある。デーモンの再起動は要らない）。

## 5. 開始してよい条件

`docs/design/new-repo.md` の「開始してよい条件」の表を上から実行し、条件ごとに通った / 通らないを控える。3 の `lint_backlog.sh`、2 の変数、4 のバックログ画面は済んでいる。スキルの印は、その workspace から Task を 1 つ起動したあとでないと出ない（未起動なら「未確認（最初の Task の後）」）。マージ判定は最初の PR で確かめる。通らない条件は直せるものを直し、直せなければ表に残して報告する。

期待: 表の 6 行すべてに「通った / 通らない / 未確認」がある。

## 6. 報告

```
新しいリポジトリ <owner>/<name>（private）
作ったもの: リポジトリ <URL> / Project <URL> / 変数 <PREFIX>_PROJECT_URL / ラベル <n> 件 / 初期コミット <sha> / workspace <id>（<dir>）
| 開始してよい条件 | 結果 |
利用者確認: Project のビュー 2 つを手で作る（Backlog = `no:parent-issue`、Task Board = `has:parent-issue`。`docs/design/new-repo.md` の「手作業で残るもの」の 1）。project-autoadd を置いたときだけ PAT の登録（同 3）
```

Project のリポジトリへのひも付けとラベルは 2 で済ませているので、利用者確認に入れない。秘密の値は報告に書かない（`issue-workflow` の「Issue・PR・コメントに書かない値」）。期待: 作ったもの・条件の表・利用者確認の 3 つが埋まっている。

## 7. GitHub を使わないリポジトリ

雛形は `ops-kit/template-local/`（`.github/` と `scripts/setup/` を持たない単体の 1 式。ファイルは `ops-kit/README.md` の「雛形（新しいリポジトリ）」）。1 のうち、owner・可視性・`<PREFIX>_PROJECT_URL` の変数・project-autoadd・`__KIT_REPO__`・`__QUOTA_CHECK__` は要らない（`envPrefix` そのものは `ops.config.json` の `__PREFIX__` に置くので決める）。Phase を使うなら `ops.config.json` に `phase` / `milestone` を足すだけ（`pbi.yml` は無い）。リモートが無いので、`gh` も `git push` も使わない。

### 7-1. 新しく作る

```bash
mkdir -p <dir> && cp -R "$SWITCHBOARD_REPO_ROOT/ops-kit/template-local/." <dir>
mv <dir>/CLAUDE.md.tmpl <dir>/CLAUDE.md; mv <dir>/AGENTS.md.tmpl <dir>/AGENTS.md; mv <dir>/README.md.tmpl <dir>/README.md
```

`__REPO__`（リポジトリ名）・`__PREFIX__`（`envPrefix`）・`__AREA__`（`ops.config.json` の 1 要素。Area の数だけ増やす）・`__COMPAT__`・`__TEST_TYPECHECK__` / `__TEST_ALL__` / `__TEST_ONE__`（テストのコマンドが 1 で決まっていなければ、3 つとも次のシェルのコメント 1 行に置換する。コードブロックの中で実行しても何も起きず、下の `grep` の 0 件も保てる。空・「なし」・存在しないコマンドは置かない: `# テストなし。最初のテストを足す変更で、この行を実際のコマンドに置き換える`）・`__LIVE_CHECK__`・`__DEPLOY_OK__`・`__TASK_CHECK__` を 1 で決めた値で `sed` などで置換する。置換のコマンドは作らない。置換してからコミットする:

```bash
grep -rnE '__[A-Z_]+__' <dir> --exclude-dir=.git                                  # 期待: 0 件（出たら置換し直す。コミットしない）
for f in $(find <dir> -type f -not -path '*/.git/*'); do bun "$SWITCHBOARD_REPO_ROOT/ops-kit/src/cli.ts" scan-text "$f" || echo "HIT $f"; done   # 期待: HIT が 0 件
cd <dir> && git init -b main && git add -A && git commit -m "chore: 雛形から土台を置く"     # remote は足さない
```

CI の手順は `ops.config.json` の `ci.steps`（`{"ci":{"steps":[{"name":"test","run":"<テストのコマンド>"}]}}`。`.github/workflows/ci.yml` は読まれない）。雛形には無く、無い間は `local-ci.ts --change` が「CI の手順が無い」で止まり、マージ判定が merge を返さない。テストのコマンドが 1 で決まっていれば初期コミットに足す。テストが無い間は、テストを足す最初の変更で、上の 3 行の置き換えと `ci.steps` の追加を一緒にする（ローカル CI はその変更の `ops.config.json` を読む）。

登録は 4 のとおり。ただし `POST /api/workspaces` の本文に `"backlog":"switchboard"` を足す（`-d '{"path":"<dir>","backlog":"switchboard"}'`。無いと既定の `github` で登録され、バックログが GitHub に向く）。`projectVar` の PATCH は**しない**（Project が無い）。バックログは Switchboard に置かれ、取込みの確認（`/api/backlog?refresh=1`）は要らない。返りが workspace の id なら済み。

5 は GitHub 由来を飛ばす。「Project の URL」（変数）と「バックログ画面」の Project 由来の取込みは対象外、「マージ判定」は最初の変更で `--change` で確かめる（`merge-gate.ts --change <変更>`）。残るのは `lint_backlog.sh` の代わりの `ops-kit lint --fresh`（新しい workspace を名指しして `<dir>` で走らせる: `cd <dir> && env -u GH_REPO BACKLOG_WORKSPACE=$ID ops-kit lint --fresh`。自分の Task の `GH_REPO` / `BACKLOG_WORKSPACE` を継ぐと元のバックログを検査する。最後の行 `violations: 0`）、スキル、CLAUDE.md の 4 項目（雛形の節名は `docs/design/new-repo.md` の表と同じ）。

6 の報告からは、リポジトリ・Project・変数・ラベル・Project のビューの利用者確認・PAT を外す。

### 7-2. 前の雛形で作った既存のリポジトリへ写す

対象は `ops-kit/template/` で作った、GitHub を使わないリポジトリ。自動で書き換えない。`template-local/` とそのリポジトリを見比べて、次の順に手で直す。

1. `.github/workflows/ci.yml` があれば、その `run:` の手順を `ops.config.json` の `ci.steps` に写す（7-1 の形。消すとローカル CI が読む手順が無くなる）。そのあと `.github/` と `scripts/setup/` を消す: `git rm -r .github scripts/setup`（残っていれば `docs/` などから指す文も外す）
2. `CLAUDE.md` の次の節を、`$SWITCHBOARD_REPO_ROOT/ops-kit/template-local/CLAUDE.md.tmpl` の同じ節で置き換える: 「リポジトリとバックログ」（前の雛形では「リポジトリと Project」。`-R` と `__KIT_REPO__` の行も消える。起票の入口は `ops-kit backlog create`）・「テスト」（テストが無い間の扱い）・「作業の場所」（`origin/main` と `gh stack` を使わず、`main` から切って積まない）・「マージ判定とローカル CI」（`--change` の 3 スクリプトと、main の更新は `local-merge.ts`）。冒頭の「このリポジトリは GitHub を使わない」の段落と、「エージェント管理アプリの Task と動いているコード」の節も合わせ、「Issue・PR に書かない値」は「Issue・変更に書かない値」で置き換える。`template-local/` に無い節（「画像」「利用上限」）は GitHub に依らないので残す。このリポジトリ固有の値（テストの 3 コマンド・互換の前提・live check・反映の OK・Story Points の基準）は残す
3. `README.md` に `## Design rules` と `## License` の見出しを足す（中身はそのリポジトリの値）。README が無ければ `$SWITCHBOARD_REPO_ROOT/ops-kit/template-local/README.md.tmpl` を `README.md` として写し、`__REPO__` を置換する
4. `docs/change-template.md` を `$SWITCHBOARD_REPO_ROOT/ops-kit/template-local/docs/change-template.md` から足す
5. 確かめる: `grep -rn 'request_issue\|pull-main' CLAUDE.md` が「使わない」と書く文脈だけ、`grep -n 'origin/main\|gh stack' CLAUDE.md` が 0 件。そのリポジトリで `env -u GH_REPO BACKLOG_WORKSPACE=<その workspace の id> ops-kit lint --fresh` が `violations: 0`

写すのはファイルの内容だけ。登録（workspace）と、すでにある Issue・変更は触らない。
