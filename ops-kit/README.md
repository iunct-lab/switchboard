# ops-kit

GitHub の Issue と Project で回す開発の流れ（要望 → PBI → Task → PR → レビュー → マージ）の道具と共通のスキル。
使う側のリポジトリは、設定ファイル `ops.config.json` と、そのリポジトリだけの手順を書いたスキルだけを持つ。キットのコードは持たない。

キットには、どのリポジトリにも固有の値（リポジトリ名、Project の番号や URL、選択肢の値、パス、アカウント）を書かない。固有の値は使う側の `ops.config.json` に、固有の手順は使う側のスキルに置く。禁止語の一覧は使う人がキットの外に置き、`export-copy` に指定する。キットのテストは合成語の一覧を使う。

## 中身

| 場所 | 中身 |
|---|---|
| `src/cli.ts` | コマンド。`bun ops-kit/src/cli.ts --help` で全部の使い方と設定の例が出る |
| `skills/` | どのリポジトリでも同じスキル 10 本: `issue-workflow` / `request-to-backlog` / `pbi-to-tasks` / `task-to-pr` / `cross-runner-review` / `review-with-subagent` / `review-triage-and-merge` / `stacked-pr-delivery` / `pbi-complete` / `public-release-gate` |
| `bin/` | `PATH` に置いて使う 4 本: `ops-kit`（`src/cli.ts` と同じ。設定の要らない `scan-text` / `scan-issues` をどこからでも）/ `gh`（`gh` の前段。認証に使える値を含む書き込みを止める）/ `deny-shared-tmp`（Claude Code の PreToolUse の hook。`/tmp` 直下に固定の名前で書くコマンドを止める）/ `device-auth`（別の場所での承認を求めるコマンドを動かし、URL とコードをエージェントの読む出力から外す） |
| `template/` | 新しいリポジトリの雛形（設定・入口・`.github/`）。下の「雛形（新しいリポジトリ）」 |
| `public/` | 公開リポジトリに置く 1 式: README に入れる方針の節（`README.section.md`）、要望だけの Issue テンプレ（`.github/ISSUE_TEMPLATE/request.yml` と `config.yml`）、`SECURITY.md` の雛形、メンバー以外の PR を閉じる workflow（`.github/workflows/close-pull-requests.yml`）。値は公開先の `owner/name` を入れる `__PUBLIC_REPO__` だけ。`public-sync` が公開に出すツリーに入れる（下の「公開リポジトリへの同期」）。公開に出すツリーにも入るのはキットの一部だから: fork した人が自分の公開先へ `public-sync` するときに使う。上流の公開リポジトリの運用には使わない |
| `fixtures/` | テストが使う架空の設定と応答 |

コマンド（`--help` と同じ。どれも `--config <ops.config.json>` を取れる。省くと今のディレクトリから上へ探す）:

| コマンド | すること | 設定 |
|---|---|---|
| `set <issue> <field> <value>` | Issue 1 件の Project のフィールドを 1 つ設定する | 要る |
| `triage <issue> <area> <kind> <priority> [<phase>] [<parent>] [<status>]` | Issue を Project に入れ、Area / Kind / Priority /（Phase）/ Status と親を設定する | 要る |
| `reconcile-project [--dry-run]` | open の Issue / PR のうち Project に無いものだけを入れる（フィールドは付けない。Actions の autoadd の代わり） | 要る |
| `lint [--no-project] [--fresh]` | open の PBI / Task / 要望が設定の必須の節と Story Points を満たすか、1 つのクエリ（ページ送り）で検査する。`BACKLOG_URL` があればアプリの保存値を読む（`--fresh` で先に取込み。GitHub に届かなければ保存値のまま） | 要る |
| `bootstrap <title> [--dry-run]` | Project と、設定にあって Project に無いフィールドを作る | 要る |
| `request <title> <body-file>` | 要望 Issue を作り、Project に Backlog で入れる | 要る |
| `backlog list\|view\|create\|edit\|comment\|set\|triage …` | キットを同梱するアプリが保存したバックログを、そのアプリの API（`BACKLOG_URL`）で読み書きする。読むのは保存値と鮮度、`--fresh` で最新化を待つ（アプリが GitHub に届かなければ保存値と「GitHub 未同期」で exit 0）。アプリに届かなければ exit 2 | 要らない（`triage` の Phase だけ読む） |
| `sync-labels [<file>] [--dry-run]` | ラベルを `.github/labels.yml` に合わせる（作る・直すだけで、消さない） | 要らない |
| `scan-text <file\|->` | 文に認証に使える値が無いか検査する（値は出さない） | 要らない |
| `scan-issues [<owner/name>] [--since <ISO>] [--recheck <URL>]...` | リポジトリの Issue・PR・コメントを全部（`--since` ならその時刻より後の更新だけと、`--recheck` の前回の当たり）、同じ検査に通す | 要らない |
| `public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>]` / `public-sync --check [--source <ref>]` | main のツリーだけを公開リポジトリへ送る。`--check` は送らずに、公開に出すツリーの検査だけを CI で走らせる（下の「公開リポジトリへの同期」） | 要る（`publicSync` だけ） |
| `export-copy <dest> --words-file <file>` | キットを読めないリポジトリが同梱するコピーを作る（下の「公開リポジトリ」） | 要らない |

## 使う側の設定（`ops.config.json`）

リポジトリの root に置く。型は `src/config.ts`（不正なキーや値はコマンドが理由を出して止まる）。値はすべて架空の例:

```json
{
  "projectUrl": "https://github.com/orgs/example-org/projects/1",
  "owner": "example-org",
  "envPrefix": "EXAMPLE",
  "fields": {
    "area": ["api", "web"],
    "kind": ["bug", "feature", "chore"],
    "priority": ["P0", "P1", "P2", "P3"],
    "phase": ["Phase 0", "Phase 1"]
  },
  "milestone": { "pattern": "^Phase \\d+ — " },
  "sections": {
    "pbi": ["ユーザーストーリー", "到達点 / 受け入れ条件", "スコープ外", { "name": "元要望", "hint": "要望 Issue の番号" }],
    "task": ["親 PBI", "やること", "手順", "検証", "完了条件"],
    "request": ["要望", "出典"],
    "origin": { "name": "元要望", "pattern": "^(#[0-9]+|なし[（(].+[）)])", "hint": "`#N` か `なし（理由）`" }
  },
  "storyPoints": [1, 2, 3, 5, 8]
}
```

| キー | 意味 |
|---|---|
| `projectUrl` | 省略可。Project の URL（`https://github.com/(users\|orgs)/<owner>/projects/<n>`）。追跡するファイルに置かないなら省き、リポジトリ変数に置く（下） |
| `owner` | 省略可。Project の持ち主（既定は `projectUrl` の持ち主。`@me` はログイン中のユーザー） |
| `envPrefix` | 環境変数の接頭辞。`<envPrefix>_PROJECT_URL` があれば `projectUrl` より優先し、`<envPrefix>_PROJECT_OWNER` は持ち主だけを変える |
| `fields.area` / `kind` / `priority` | Project の単一選択フィールドの選択肢 |
| `fields.phase` | 省略可。Project が Phase を使うときだけ。あると `triage` が `<phase>` を取る |
| `milestone.pattern` | 省略可。Phase の Milestone の題が満たす正規表現 |
| `sections.pbi` / `task` / `request` | 各 Issue に要る `##` の見出し。`{ "name", "hint" }` にすると違反の行に `hint` が付く |
| `sections.origin` | 省略可。PBI の元要望の節。最初の空でない行が `pattern` に合うこと |
| `storyPoints` | 許す Story Points（既定 `[1, 2, 3, 5, 8]`） |
| `publicSync.target` | `public-sync` の送り先の公開リポジトリ（`<owner>/<name>`）。Private のリポジトリと同じなら止まる |
| `publicSync.include` | 省略可。公開側に送るものを名指しする（パス。ディレクトリは末尾 `/`）。名指ししていない最上位のエントリ（あとから足したものも）は送らない。名指ししたディレクトリの下に足したファイルは送るので、そこで外すものは `exclude` に書く。省略はツリー全部 |
| `publicSync.exclude` | `include` の中で送らないもの（Private だけで意味を持つもの。ディレクトリは末尾 `/`） |
| `publicSync.rewrite` | 本文中の Private のリポジトリ名を公開リポジトリ名に書き換えるファイル（脆弱性の報告先など） |
| `publicSync.versioning` | 省略可。`"independent"` は独立した公開版（下記）。省略時は開発タグをそのまま公開版に使う |
| `publicSync.serviceUsers` | 省略可。人ではない OS の利用者の名前（ホストの雛形のサービスの利用者など、そのホームを文書に書いているもの）。同期を回す利用者の名前のパスの検査がこの名前を見ない |

リポジトリは `GH_REPO`、無ければ `origin` から読む。Project の URL は環境変数 `<envPrefix>_PROJECT_URL`、設定の `projectUrl`、同名のリポジトリ変数（`gh variable get <envPrefix>_PROJECT_URL`）の順で読む（Project を使わないコマンドは変数を読まない）。リポジトリ変数に置くなら `gh variable set <envPrefix>_PROJECT_URL --body https://github.com/orgs/example/projects/7`。

## 入口（使う側のリポジトリ）

コマンドを直接呼んでもよいが、リポジトリに薄い入口を置くと、キットの場所と設定の場所を毎回書かずに済む。入口はそのリポジトリの Git 管理のファイルで、キットのコードは持たない:

```bash
#!/usr/bin/env bash
# scripts/setup/lint_backlog.sh [--no-project]
R="$(cd "$(dirname "$0")/../.." && pwd)"
exec bun "${OPS_KIT:-$R/ops-kit}/src/cli.ts" lint --config "$R/ops.config.json" "$@"
```

`OPS_KIT` はキットの場所（既定はリポジトリの中の `ops-kit/`。キットを持つリポジトリの外から使うならそのチェックアウトの `ops-kit`、公開リポジトリなら同梱したコピー）。`set` / `triage` / `bootstrap` / `request` も同じ形。

## スキルの導入

スキルの実体は `skills/` の 1 つだけで、写しを手で持たない。キットを持つアプリが、Task のランナーを起動する直前に、各リポジトリの `.claude/skills/<name>`（Claude Code）と `.agents/skills/<name>`（Codex）へ `skills/` のコピーを置き、Git の管理対象から外す（キットの親のリポジトリの `docs/design/skill-sync.md`）。Claude Code と Codex は同じ中身を読み、`skills/` を直すと次の起動で置き直される。導入のコマンドは無い。

確かめ方: そのアプリから Task を起動したあと、作業フォルダで `ls .claude/skills .agents/skills` に上の 10 本が出る。

リポジトリだけの手順は、そのリポジトリの `.claude/skills/<別の名前>` に Git 管理で置く（キットのコピーと名前が重ならなければ触られない）。共通のスキルが「使う側のリポジトリが持つもの」と書いた値は、そのリポジトリの `CLAUDE.md`（Codex なら `AGENTS.md`）に書く。

## 雛形（新しいリポジトリ）

`template/` は、キットを使う新しいリポジトリの土台。固有の値は `__NAME__` 形のプレースホルダで、生成・適用のコマンドは無い（ファイルを写して値を置き換える手順は、使う側（キットの親）のスキルが持つ）。

| 場所 | 中身 |
|---|---|
| `ops.config.json` | 設定（`envPrefix`・Area・必須の節・Story Points。Project の URL は置かず、リポジトリ変数 `<PREFIX>_PROJECT_URL` に置く: `gh variable set <PREFIX>_PROJECT_URL --body https://github.com/orgs/<owner>/projects/<n>`（ユーザーの Project なら `orgs` を `users` に）） |
| `scripts/setup/` | 入口 4 本: `lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh`（実行ビット付き） |
| `.github/ISSUE_TEMPLATE/` | `bug_report.yml` / `config.yml` / `feature_request.yml` / `pbi.yml` / `task.yml` |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 本文の型 |
| `.github/labels.yml` | ラベル体系（Area は 1 件だけ置いてある。値の数だけ足す） |
| `.github/workflows/` | `labels.yml`（ラベルの同期）/ `ci.yml`（Bun / TypeScript の最小。ほかの言語は run の行を書き換える）/ 任意の `project-autoadd.yml`（設定は下の fork の手順） |
| `.gitignore` | 汎用の行だけ |
| `CLAUDE.md.tmpl` / `AGENTS.md.tmpl` | このリポジトリ固有の値の置き場（`issue-workflow` の「使う側のリポジトリが持つもの」の項目の節立て）。`.tmpl` なのは、キットの下を読んだランナーが入れ子の指示として読み込まないため。置くときに外す |

| プレースホルダ | 入れる値 | 出てくるファイル |
|---|---|---|
| `__OWNER__` | GitHub の owner | `.github/ISSUE_TEMPLATE/config.yml`、`CLAUDE.md.tmpl` |
| `__REPO__` | リポジトリ名 | `.github/ISSUE_TEMPLATE/config.yml`、`CLAUDE.md.tmpl`、`AGENTS.md.tmpl` |
| `__PREFIX__` | `envPrefix`（Project の URL の変数は `<PREFIX>_PROJECT_URL`） | `ops.config.json`、`.github/workflows/project-autoadd.yml` |
| `__AREA__` | Area の値。配列・options・ラベル・PR テンプレでは 1 件だけ置いてあり、値の数だけ増やす | `ops.config.json`、`.github/ISSUE_TEMPLATE/*.yml`、`.github/labels.yml`、`.github/PULL_REQUEST_TEMPLATE.md` |
| `__TEST_ALL__` | 全体のテストのコマンド | `.github/workflows/ci.yml`、`.github/ISSUE_TEMPLATE/task.yml`、`.github/PULL_REQUEST_TEMPLATE.md`、`CLAUDE.md.tmpl` |
| `__KIT_HOME_VAR__` | キットを持つリポジトリの root を指す環境変数の名前 | `scripts/setup/*.sh` |
| `__TEST_TYPECHECK__` / `__TEST_ONE__` | 型検査のコマンド / 1 件だけのテストのコマンド | `CLAUDE.md.tmpl` |
| `__COMPAT__` | 互換の前提（利用者・外部クライアントの有無） | `CLAUDE.md.tmpl` |
| `__LIVE_CHECK__` | 動いている実物で確かめる方法 | `CLAUDE.md.tmpl` |
| `__DEPLOY_OK__` | 動いている実物への反映と、誰の OK が要るか | `CLAUDE.md.tmpl` |
| `__KIT_REPO__` | キットを持つリポジトリの `owner/name`（共通の仕組みの要望の起票先） | `CLAUDE.md.tmpl` |
| `__TASK_CHECK__` | エージェント管理アプリの Task として起動されたことの見分け方 | `CLAUDE.md.tmpl` |
| `__QUOTA_CHECK__` | ランナーの利用上限の見方（コマンドか画面） | `CLAUDE.md.tmpl` |

Phase は雛形に入れない（使うなら `fixtures/config-with-phase.json` の `phase` / `milestone` と `pbi.yml` の Phase の dropdown を足す）。

## 公開リポジトリへの同期

`public-sync` は Private の main の**ツリーだけ**を、履歴なしで公開リポジトリへ送る（`git commit-tree <ツリー> -p <公開側の main>` で 1 コミット作るので、Private のコミットは祖先にならない）。設定は `ops.config.json` の `publicSync` だけを読む（ほかのキーは見ない）。Private のリポジトリ名は `GH_REPO`、無ければ `origin`。

- 初回（公開側の `main` が空）は `main` へ根のコミットを push する。2 回目からは `sync/<タグ>`（タグでなければ `sync/<公開ツリーの短い sha>`）を push して PR を開き、そのまま **Rebase and merge** でマージする（公開側の PR は開いた時点で公開されるので、人のマージは公開を止める確認にならない。公開側の CI の結果は待たない）。マージに失敗したら PR は開いたまま理由を出して止まり、次の実行がもう一度マージする。題が `vX.Y.Z` なら同じ実行で公開側にタグと Release を付ける。公開側のコミット・枝・PR・Release には Private の情報を出さない: 題は版（タグ名）だけで本文は無い（Private のコミットの題は内部のメモなので一覧にしない。Private の sha も Issue 番号も出ない）。どの Private のコミットから送ったかは Private の `origin` の ref `refs/public-sync/trees/<公開側のツリー>` に残し、次回はこれで前回を見つける（ツリーで引くので公開側のマージの仕方によらない。公開側の `main` のツリーに記録が無ければ「main changed after the last sync」で止まる）。設定（`publicSync`）は送るツリー（`--source`）の `ops.config.json` を読む（作業ツリーが古くても、新しいタグに古い除外は当たらない）。前回送ったものより古い `--source` は送らない（公開側を戻さない）
- 公開側の `main` が最後の同期のあとに変わっていたら、上書きしないよう止まる。その変更を Private に取り込んでから `--adopted` を付けて回す（このときは開いた同期の PR をマージせず、閉じるよう求めて止まる）
- ツリーのうち `publicSync.include` が名指しするものだけを残し（省略はツリー全部。名指しした項目がツリーに無ければ出力に出す）、`publicSync.exclude` を外し、`publicSync.rewrite` のファイルは Private のリポジトリ名を公開側の名前に置き換える
- そのあと公開側の 1 式（`public/`）をツリーに入れる（入れる / 入れないの設定は無い。`__PUBLIC_REPO__` は `publicSync.target`）: `.github/ISSUE_TEMPLATE/` を要望のテンプレ（`request.yml` + `config.yml`）だけに置き換える、PR を閉じる workflow（`.github/workflows/close-pull-requests.yml`）を足す、`SECURITY.md` はリポジトリに無いとき（root・`.github/`・`docs/` のどこにも）だけ雛形を入れる、`README.md` の `## How this repository works` の節を置き換える（無ければ最初の `## ` 見出しの前、見出しが無ければ末尾に差し込む。コードブロックの中の `## ` は見出しに数えない。`README.md` が無ければ止まる）。出力の `public kit:` の行がしたことを言う
- 送る前の検査（1 件でも当たれば何も送らず exit 1）: 公開側で変わる行（初回はツリー全部）に、キットの秘密の規則（gh の前段と同じ。ホストの AWS のプロファイル名・SSO のセッション名・アカウント ID も）に当たる値（出すのは種類とファイル名だけ）。Private のリポジトリ名（名前全体の一致。ファイルの中・パス名・コミット本文）、ホームパス（macOS のホームディレクトリの形。`dev` / `example` / `me` / `x` / `<you>` の名前は通す）、個人のメールアドレス（例示用ドメイン・GitHub・Anthropic の公開アドレスは通す）。対象はツリー（バイナリも）、コミット本文、author / committer。ホストに依らない秘密の規則は、変わる行だけでなくツリー全部にも当てる（ホストの値の無い環境の下の `--check` と同じ。出すのはファイルと行と種類）
- 同期を回している OS の利用者名（`os.userInfo().username`、大文字と小文字は区別しない。空か、上の置き換え名か、`publicSync.serviceUsers` の名前なら見ない。見るのは同期を回す利用者の名前だけで、録画などを作った別の利用者の名前は見ない）がパスの形（`/home/<you>`・`/Users/<you>`・`pytest-of-<you>`・`C:\Users\<you>`。JSON や JS の文字列の `C:\\Users\\<you>` も）でファイルの中・パス名・コミット本文にあっても止まる
- `--source <ref>`（既定 `origin/main`）はタグでも指せる。タグを指すと同期のコミットと PR の題がその名前だけになる（`v1.2.0`。タグでなければ `sync`）。題が `vX.Y.Z` の同期が公開側の main に入ると、同じ実行（マージに失敗したときは次の実行）で公開側のそのコミットに同じ名前のタグと GitHub Release が付く（`gh release create --target`、本文は無い。push しない。`--target-url` のときは付けない）。`--dry-run` は除外・書き換え・検査の結果と作るツリーの sha を出して終わる（公開側に届かなくてもよい。何も push しない。公開側に届くときは比較のために `refs/public-sync/main` へ fetch する）。`--target-url` は公開先の URL を差し替える（テストの bare リポジトリ用）
- `--check`（`--source` の既定は `HEAD`）は、同期と同じ関数でツリーを組み立て、同じ関数でツリーの中の Private のリポジトリ名（ファイルと行、パス名）・ホームパス・個人のメールアドレスと、秘密の規則（全ファイルの全行。前回の公開から変わっていないファイルも。出すのはファイルと行と種類で、値は出さない）を検査する。ホストの AWS のプロファイル名・SSO のセッション名・アカウント ID の値は、検査を回す環境に AWS の設定（`AWS_CONFIG_FILE`、なければ `~/.aws/config`）があるときだけ数える（Actions には無いので数えない。ホストで回すローカルの CI では数える）。公開側には触らない（ネットワークも `gh` も要らない）ので、PR の CI に入れて、同期より前のマージの前に止める（例: CI の手順に `bun ops-kit/src/cli.ts public-sync --check`）。題・author に依る検査と、同期する OS の利用者名は同期のときだけ見る（ARN などの形で分かるアカウント ID はホストの値が無くても当たり、例示は `123456789012`）。`origin`（か `GH_REPO`）が `publicSync.target` の clone（公開側の写しの CI）では検査せずに exit 0
- exit 0 = 送った / 送るものが無い / dry-run、1 = 止まった（理由は stderr）、2 = 使い方の誤り

## 公開リポジトリ

キットを直接参照できないリポジトリには、生成したコピーを同梱する:

```bash
bun ops-kit/src/cli.ts export-copy <公開リポジトリ>/vendor/ops-kit --words-file <禁止語の一覧ファイル>
cat <公開リポジトリ>/vendor/ops-kit/KIT_VERSION    # commit <sha> / date <日時>（未コミットの変更から作ったら dirty の行）
(cd <公開リポジトリ>/vendor/ops-kit && bun install)  # 依存は zod だけ。リポジトリの workspaces に足してもよい
```

- コピーに入るもの: `src/`（`*.test.ts` を除く）、`skills/`、`bin/`、`README.md`、`package.json`、キットの親のリポジトリの `LICENSE`、`tsconfig.json`（キットの外の基本設定を取り込んだもの）、`--help` が出す設定の例（`fixtures/config-with-phase.json`）。テストと残りの fixtures は入らない。リンクはリンク先の中身として入る（検査もその中身にかかる）
- 著作者の表示: キットには親のリポジトリの名前も著作者の名前も書けない（固有語の検査）ので、コピーは `LICENSE` だけを持ち、親の `NOTICE` は入れない。同梱する公開リポジトリが、自分の `NOTICE` に「`vendor/ops-kit` は <親のリポジトリ> の ops-kit のコピー（Apache-2.0）」と著作者の表示を書く
- 出所と版は `KIT_VERSION`。コピーを直さない（直すのはキット。コピーは作り直す）
- 非公開の情報が入らない検査: コピーを作ったあと、指定した一覧の語でコピーの全ファイルの名前と中身を検索し、1 件でもあればコピーを消して exit 1（前のコピーはそのまま残る）。一覧の指定が無い場合や、指定したファイルが無い場合は理由を出して停止する（検査は省略しない）。一覧は UTF-8 で 1 行に 1 語を書き、空行と `#` で始まる行は無視する。名前と中身の照合では大文字・小文字を区別しない
- `<dest>` は無い・空・前のコピー（`KIT_VERSION` がある）のどれか。前のコピーは置き換え、それ以外のディレクトリには書かない
- 入口は `OPS_KIT=<リポジトリ>/vendor/ops-kit` か、入口のキットの場所を `vendor/ops-kit` にする。スキルは上の「スキルの導入」と同じくアプリが置く（コピーの `skills/` は、アプリを使わずに読むときのため）

## fork して開発を始める

上流の公開リポジトリは読み取り専用の写しで、要望を受け取り、PR は自動で閉じる。fork は自分の開発先にして、キットを持つアプリと工程（要望 → PBI → Task → PR → レビュー → マージ）を使える。上流の非公開の履歴・Project・認証情報は要らない。

1. 公開リポジトリを fork して clone する。`origin` が自分の fork を指すことを `git remote -v` で確認する。`GH_REPO` を使う環境では自分の `owner/name` に設定し、上流を指す値を残さない（未設定なら origin を使う）。`gh repo fork --clone` の clone や、上流を `upstream` に足した clone では `gh` の既定（`gh repo view` の答え）が上流になるので、`gh repo set-default <自分の owner/name>` を実行する。`bun install --frozen-lockfile` のあと、キットを持つアプリの起動は、そのリポジトリの README に従う。
2. 自分の Project を用意し、`ops.config.json` の `envPrefix` に合わせて `gh variable set <PREFIX>_PROJECT_URL --repo <owner/name> --body <ProjectのURL>` を設定する。同名の環境変数があればそちらが優先されるので更新する。フィールド・必須の節を `ops.config.json` で確認し、`bun ops-kit/src/cli.ts bootstrap <Projectの題>` でフィールドを揃える。所有者だけの値・記録は `private/` に置き、公開に含めない。
3. `.github/ISSUE_TEMPLATE/` の公開用フォームを `ops-kit/template/.github/ISSUE_TEMPLATE/` の開発用フォームで置き換える。`__OWNER__`・`__REPO__`・`__AREA__`・`__TEST_ALL__` を自分の値にして、Area と必須の節を設定に合わせる。PR 本文の型も `template/.github/PULL_REQUEST_TEMPLATE.md` から置く。ラベルは `.github/labels.yml` を確認して同期する。
4. fork の `.github/workflows/close-pull-requests.yml` を削除して PR の自動クローズを止める。fork の README の `How this repository works` と `SECURITY.md`・Issue フォームのリンクを自分の方針・報告先に直す。fork の Actions と Issues を有効にし、CI を動かす。`ops.config.json` の `publicSync` は残す。`target` は上流の公開リポジトリで、キットの道具・`gh` の前段・アプリのバックログは、既定の書き込み先がそこを向くときに書き込みを止める目印にする。消すとこの歯止めが無くなる。上流への `public-sync` は権限が無いので送れない（独自の公開先へ同期するときは `target` を自分の公開先に書き換える）。
5. Project への自動追加が必要なら `ops-kit/template/.github/workflows/project-autoadd.yml` を `.github/workflows/` へ写す。`__PREFIX__` は `envPrefix` に置き換える。`<PREFIX>_PROJECT_URL` と、Project を書けるリポジトリ secret `<PREFIX>_PROJECT_TOKEN` を設定する（PR のコードは実行しない）。
6. キットを持つアプリ固有のリリースやホストの設定は、そのリポジトリの開発・配置のドキュメントに従う。

共通のスキルは同梱の `ops-kit/skills/`、入口は `scripts/setup/`。スキルの導入は上の節に従い、リポジトリ固有の手順は自分の `CLAUDE.md` / `AGENTS.md` に書く。fork の Issue と PR で工程を回し、上流への提案は上流の Request として送る。

### 公開側への書き込みが止まったとき

既定の書き込み先（`GH_REPO`、無ければ `gh repo view`）が最寄りの `ops.config.json` の `publicSync.target` と同じ clone では、書き込みが止まり、次の文が出る: 「書き込み先 <owner/name> は、この clone の ops.config.json の publicSync.target（公開側の写し）です。自分のリポジトリに向けてから実行してください: …」。判定にリポジトリの名前は使わない。上流の開発元は既定が開発元なので止まらない。

直し方:

1. `git remote -v` で、`origin` が自分のリポジトリか確かめる。上流を clone したままなら、自分のリポジトリを remote に足す（`git remote add <名前> <自分の URL>`）か `origin` を付け替える。
2. `gh repo set-default <自分の owner/name>` を実行する。`gh repo view` の答えが変わり、`-R "$(gh repo view …)"` で書く工程も自分のリポジトリに向く。
3. `GH_REPO=<自分の owner/name>` でも `gh` の書き込みは自分に向くが、`gh repo view` の答えは変わらない。`-R "$(gh repo view …)"` で上流を名指しした書き込みは止まったままなので、2 を使う。

守れる範囲: キットの道具（`ops-kit` のコマンドと `scripts/setup/` の入口）、`gh` の前段（`ops-kit/bin/gh`）を通る `gh`、キットを持つアプリのバックログの取込みと送信。前段を `PATH` に置かない端末で叩く `gh` と GitHub の画面での操作は止まらない。

## 更新

- キットを直したら、キットを参照する使う側（入口が `OPS_KIT` かキットのチェックアウトを指す）は何もしない。次の実行から新しいキットが動き、スキルは次の Task の起動で置き直される
- 同梱したコピーは追随しない。更新するときは `export-copy` を同じ `<dest>` にもう一度実行し、`KIT_VERSION` の差分ごとコミットする
- 設定の形を変えたら（`src/config.ts`）、使う側の `ops.config.json` を直す。古い形を読む層は作らない

### 独立した公開バージョン

新しい公開先で `publicSync.versioning: "independent"` を設定すると、開発側のタグとは独立して公開版を採番する。省略時の動作は変わらない。`--source` は private origin に存在し、main に含まれる厳密な `vX.Y.Z` タグを指定する（開発側のタグを先に fetch する）。初回は開発版の番号に関係なく公開側を `v0.1.0` とし、その source を基準にする。

次回からは前回公開の source から今回の source までの開発タグの遷移を調べ、最大の区分（major > minor > patch）を公開側で **1 回だけ**上げる。patch が 3 回なら公開 patch を 1、patch が 3 回と minor が 2 回なら公開 minor を 1 上げる。major は minor と patch を、minor は patch を 0 に戻す。v0 系も同じ規則で、major を含めば v1.0.0 になりうる。回数の閾値は無い。

公開ツリーが同じなら増やさず、前回公開の基準も進めない。次に公開差分ができたとき、公開に出ない変更も含めた全区間で最大区分を選ぶ。開発タグの分岐・逆行・同一コミットへの複数版・記録済みタグの移動や削除・基準欠落は推測せず停止する。既存の公開履歴を独立採番へ自動移行する機能は無い。新しい空の公開先を使う。

`--dry-run` は source、前回の基準、区分、予定公開版、検査済み tree を示し、公開側・private origin へ書かない。独立採番では基準の取り違えを避けるため、公開先の読み取りに失敗した場合は初回と推測せず停止する。初回は空のPrivateリポジトリを作成してから実行する。作成前の検査は空のローカルbareを `--target-url` に渡して行える（GitHub Releaseは作らない）。公開側の題・枝・タグは公開版のみ。公開 Release の本文は空で、開発側の件名・Issue・sha を転記しない。package.json の版は書き換えない。

source・公開 tree・公開版・開発タグの対応と未完了計画は、private origin の `refs/public-sync/versions/<公開先URLのSHA-256>` に保存する。同じ prefix に `-lock` を付けた ref を、期待値付き push で実行ごとに取得・解放する。別 clone の同時実行は停止する。処理が失敗しても未完了計画は残り、**失敗した操作をむやみに再実行せず、公開側と台帳を確認してから**同じ `--source` で再開する。対象が変わると停止する。タグ・Release が既にあれば、その公開コミットとの一致を確認して不足した処理だけを補う。

プロセスが強制終了した場合、lock は自動で奪わない。復旧では元の実行が終了したことを確認し、`git ls-remote origin 'refs/public-sync/versions/*'` で該当の lock と状態を読む。公開 main・sync 枝・PR・タグ・Release と未完了計画を照合し、lock の観測した object ID を期待値にした `git push --force-with-lease=<lock-ref>:<観測したID> origin :<lock-ref>` でその lock だけを解除してから再開する。途中の実行が残る間や、書き込み結果が不明なまま解除しない。台帳や公開タグを消して採番をやり直さない。
