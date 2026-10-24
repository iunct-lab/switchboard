# 公開リポジトリ（Private から main のツリーだけを送る）

開発元の main のツリーだけを、別の公開リポジトリに新しい履歴で送る。開発元のコミット・Issue・Project・認証情報は送らない。
自分の開発元と公開先を設定する。公開先は tree mirror。fork は自分の開発先として設定できる。
公開前に `ops-kit/skills/public-release-gate/SKILL.md` を通し、`public-release-gate: pass <tree sha>` を確認する。

## 仕組み

仕組みそのもの（ツリーだけを `git commit-tree -p <public の main>` で送る、初回と 2 回目、`--adopted`、ホームパスとメールアドレスの検査、`--dry-run`）は共通キットの `ops-kit/README.md`「公開リポジトリへの同期」。公開先と対象は自分の `ops.config.json` に設定する。

`ops.config.json` の `publicSync.target` に自分の公開先、`include` に公開する最上位のパスを列挙する。`private/` は含めない。設定例はキットの README。公開・除外・書き換えの契約:

| 設定 | ファイル | 理由 |
|---|---|---|
| `include` | 最上位のエントリのうち `private/` を除くすべて（`.claude/`・`.github/`・`apps/`・`aws/`・`docs/`・`ops-kit/`・`packages/`・`rescue/`・`scripts/` とルートのファイル） | fork した人が製品を動かし、開発の流れごと Switchboard 自身を改善するのに要るもの（#1962 の選り分け。所有者の値と記録は `private/` へ分けた）。新しい最上位のエントリは、ここに足すまで公開に出ない |
| `exclude` | `.github/workflows/project-autoadd.yml` | Private の Project と秘密を使う |
| 同期 | `.github/workflows/host.yml` | `workflow_dispatch` でだけ動く。リポジトリ自身の変数と OIDC ロールで配備する |
| 同期 | `.github/workflows/release-tag.yml` | `SWITCHBOARD_RELEASE_TAGS` が `on` のリポジトリだけでタグ・Release を作る |
| `exclude` | `private/` | 所有者だけの値と記録の置き場。export-copy の禁止語の一覧（ディスク名・Project の番号・別リポジトリの名前そのもの）とそれを読む所有者のテストもここ。キットのテストは合成語の一覧を使うので公開側に残る |
| `rewrite` | `SECURITY.md` | 脆弱性の報告先は公開側（「What Switchboard holds」の節があるので、キットの雛形でなくこのファイルを書き換えて送る）。`.github/ISSUE_TEMPLATE/` は公開側の 1 式（キットの `public/`。要望のテンプレと `config.yml`）に置き換わるので書き換えない |
| `serviceUsers` | `switchboard`（ファイルでなく OS の利用者の名前） | ホストの雛形の既定の利用者（`aws/template.yaml` の `HostUser`）。人の名前ではなく、そのホーム（`/home/switchboard`）を文書が書いているので、同期を回す利用者の名前のパスの検査が見ない。見るのは同期を回す利用者の名前だけなので、この利用者で同期を回すとその検査は何も見ない（自分の利用者で回すか、ゲートで見る） |

ほかの workflow（`ci.yml`・`labels.yml`・`secret-scan.yml`）は `$GITHUB_REPOSITORY` に対して動くので、`<public>` でもそのまま使う。開発先は GH_REPO、無ければ作業ツリーの origin から読む。Project は環境変数 SWITCHBOARD_PROJECT_URL、無ければ同名のリポジトリ変数から読む。名前と Project URL は追跡するファイルに置かない。公開ツリーとコミット本文に Private の owner/name が残っていれば同期は停止する。

検査で author が止めたら `user.email` を GitHub の `<id>+<login>@users.noreply.github.com` にする。名前（`user.name`）は検査しないまま公開側のコミットに載るので、GitHub の login にしておく。

## 回し方

同期は Switchboard の定期実行「公開リポジトリへの同期（switchboard）」（cron `0 4 * * *`、workspace は meta、ランナーとモデルは設定画面の「自動で始まる Task の既定」）が毎日 1 回回す。節目は、いま動いている版（sb-rescue が昇格して動かしている `~/.switchboard/releases/current`）に入っている最新のリリースタグ（`scripts/release-tag.ts` の規則で付くタグ）。昇格に失敗して保留になった版や、まだ昇格していない版は送らない。prompt の原文（登録もこの文）:

> `git fetch -q --prune --prune-tags origin` のあと、`ops-kit public-sync --source "$(git describe --tags --abbrev=0 "$(readlink ~/.switchboard/releases/current)")"` を 1 回実行し、終了コードと出力をそのまま報告してください。ファイルは変更しないでください。同じコマンドを繰り返さず、`--adopted` は付けないでください。exit 0 以外なら、出力の最初の行を根拠にして、止まったことを switchboard-stop のフェンスで報告してください

- `public-sync` は作業ツリーと index に触らない（一時の `GIT_INDEX_FILE`、書くのは object と `refs/public-sync/` の ref だけ）ので、meta workspace の作業ツリーで回してよい。設定（`ops.config.json` の `publicSync`）は送るツリーのものを読むので、作業ツリーが古くても新しいタグに古い除外は当たらない（動くコードと公開側の 1 式は作業ツリーの `ops-kit` のもの。main の作業ツリーはマージの後の `ops-kit pull-main` で進む）
- 止まったら Task が停止の報告（switchboard-stop）を出すので、画面の「止まった理由」と週 1 回の「止まった理由（全 workspace）」に載る
- タグが増えていなければツリーが同じで「nothing to sync」。新しいタグがあれば同期の PR（題はタグ名だけで本文は無い、枝は `sync/<tag>`）を開き、道具がそのまま **Rebase and merge** でマージして、同じ実行で `<public>` に同じ版のタグと GitHub Release を付ける（`released <tag> on …`。push しない）。前回の見つけ方はキットの README「公開リポジトリへの同期」
- 人はマージしない: `<public>` の PR は開いた時点で公開されるので、人のマージは公開を止める確認にならない。中身の確認は Private 側（各 PR のレビュー・ローカル CI・道具の検査）で済んでいる。`<public>` の CI の結果は待たず、赤なら Private で Issue にして直す
- マージに失敗したら PR は開いたまま止まり、理由が残る（定期タスクの画面の最後の Task で見る）。次の実行がその PR をマージしてから続ける
- 公開側だけの変更があれば「main changed after the last sync」で止まる（下の「公開側への貢献」）
- 公開側の版番号は開発側のタグと独立している（`publicSync.versioning: "independent"`）。初回は `v0.1.0`、以降は前回公開以降の開発タグの最大変更区分（patch / minor / major）を公開側で 1 回だけ上げる。公開 tree が同じなら採番せず、基準も進めない。`--source` は動いている版の最新の開発タグ（private origin にあり開発 main に含まれる `vX.Y.Z`）で、設定は送る source のコミットから読むので、独立採番の設定を含むタグ以降を送る。状態は private origin の `refs/public-sync/versions/<公開先 URL の SHA-256>`（と `-lock`）にだけ持ち、公開側に開発側の履歴・タグ・Issue・sha は出さない。途中で止まったら記録済みの同じ source と公開版で再開する（別の source へ付け替えない）。詳細と lock の解除は `ops-kit/README.md` の「独立した公開バージョン」

### 手で回すとき

1. `git fetch --prune --prune-tags origin` のあと `ops-kit public-sync --dry-run --source <タグ>` で送るツリーを確認する（`<タグ>` は上の prompt と同じ、動いている版の最新のタグ。前回より古いタグは「older than」で止まる）
2. 同じ `--source` で `ops-kit public-sync` を 1 回実行する。止まる理由は上と同じ
3. 道具が同期の PR をマージし、Release まで付ける（止まったら理由を見て直し、同じコマンドをもう一度）

## 公開側で受けるもの

公開側に置く 1 式は共通キットの `ops-kit/public/`（README の方針の節 `## How this repository works`、要望だけの Issue テンプレ `request.yml` と `config.yml`、`SECURITY.md` の雛形、PR を閉じる workflow `close-pull-requests.yml`）。`ops-kit public-sync` が公開に出すツリーに入れる（入れる / 入れないの設定は無い。キットの README「公開リポジトリへの同期」）。公開側で受けるもの:

| 受けるもの | 形 | 受けたあと |
|---|---|---|
| 要望（不具合の報告も要望の形） | Issue の「Request」テンプレだけ（`blank_issues_enabled: false`。PBI / Task のテンプレは公開側に出さない） | `request-to-backlog` の「公開側の Issue から」で Private の要望 Issue にする（経路「公開側 Issue <URL>」）。公開側には「受け取った」とだけ返信し、派生 PBI が全部 Done になったら結果を 3 行書いて閉じる（`pbi-complete` の 6-5）。Private の番号・内部の情報は公開側に書かない |
| 脆弱性 | Security Advisory（`SECURITY.md` と `config.yml` の案内。Private vulnerability reporting は「公開する日」の 7 で有効にする） | Advisory の中で答える。公開の Issue にしない |
| 質問・相談 | Discussions（`config.yml` の案内。公開先で有効にする） | Discussions で答える。要望になれば Issue へ |
| Pull Request | 受け付けない。`close-pull-requests.yml` が、メンバー・dependabot・同じリポジトリの `sync/*` 以外の PR を方針の返信つきで閉じる | 中身が要望なら Issue に書き直してもらう |

### 3 リポジトリでの確認

2026-10-20、キット（main `028593ab`）の `ops-kit public-sync --dry-run` が出すツリーで、(1) `.github/ISSUE_TEMPLATE/` が `config.yml` と `request.yml` だけ (2) `README.md` に `## How this repository works` が 1 つ (3) `close-pull-requests.yml` と `SECURITY.md` がある (4) `.github/workflows/` に Private の Project を使うもの（`add-to-project|PROJECT_TOKEN|projectsV2|PROJECT_URL`）が無い、を確かめた。

| リポジトリ | Private の main | tree | (1)〜(4) | `SECURITY.md` | 除外に足したもの |
|---|---|---|---|---|---|
| Switchboard | `028593ab` | `dccc9f0d` | 全部通る | リポジトリのもの | なし |
| capsule-host | `8a26ab6` | `cdcb43d2` | 全部通る | 雛形 | なし（workflow は `ci.yml` / `labels.yml`） |
| DAK | `673e57b` | `7e412bfe` | 全部通る | 雛形 | なし（workflow は `ci.yml` / `labels.yml`。独自の workflow は DAK 側で消してある） |

DAK は改名の前なので、DAK の `docs/maintenance/public-repo.md` の「回し方」の 2（改名後の Private の名前と空の bare の公開先を渡す）で回した。

## 公開側への貢献

PR は受け付けない（公開側は Private の写しで、変更は Private の流れ（Issue・PR・レビュー）でだけ入る。上の表）。外からの提案は公開側の要望 Issue → `request-to-backlog` の「公開側の Issue から」。

`<public>` の main に手で入った変更（設定の変更が作るコミットなど）があると、次の同期は「main changed after the last sync」で止まる（そのまま送るとその変更を消すので）。その変更を Private に入れ、それを含むリリースタグが昇格して動いてから、定期実行と同じ `--source`（動いている版の最新のタグ）で `ops-kit public-sync --adopted --source <タグ>`（「`<public>` だけにあった変更は Private に入れた」の宣言。同期のコミットが `<public>` の main を Private のツリーで置き換える）。動いている版より新しいタグで送ると、定期実行の送る版がそれより古くなり「older than」で止まり続ける（昇格すれば戻る）。道具はそのままマージするので、先に `--dry-run` で作るツリーの sha を見て、`git diff refs/public-sync/main <その sha>` で取り込んだ変更が消えないことを確かめてから回す。

## 公開する日

所有者の合図があってから。合図までは `<public>` を作らない（1 は合図の前に済ませてよい）。

1. すべての clone / worktree の origin と `GH_REPO` が開発リポジトリを指すことを確かめる（所有者のほかの端末の clone も）。`<public>` を作る前に、すべての環境で `git remote -v` を見る。開発リポジトリを改名し、その古い名前を公開先にする場合は、古い名前は公開先を作るまで開発先へ転送され、作った後に古い名前へ push すると Private の履歴が公開先に入る。
2. 合図のあとで、1 が済んでいることを確かめてから `<public>` を **Private で**作る（`gh repo create <public> --private --description …`。Issue テンプレ・labels は同期で入る）。`publicSync.target` が `<public>` であることを確認する。開発元の main で `public-release-gate` を回し直して合格（`public-release-gate: pass <tree sha>`）を取り、合格から push までのあいだ main に別の変更を入れない（入ったら下の `--source`）。`ops-kit public-sync --dry-run` → その `with tree <sha>` が合格の sha と同じことを確かめてから、`--dry-run` を外して初回を push（違えば回し直す。push した後にツリーを直すと、直す前のツリーが公開側の履歴の祖先に残って Public になる）。合格の後に main が動いたら、回し直さずに `--source <合格した commit>`（dry-run と push の両方）で合格した tree を送ってよい（初回はこの形で送った）。初回の `--source` は独立採番の設定（`versioning: "independent"`）を含む開発リリースタグにする（設定前のタグでは独立採番にならない）。dry-run が示す公開版が `v0.1.0` であることも確かめる。定期実行は初回の同期が済むまで無効にしておき、初回の後に有効に戻す。
3. `<public>` の設定: Discussions を有効化（`gh repo edit <public> --enable-discussions`）、Actions を許可。Issue テンプレが要望だけ（`.github/ISSUE_TEMPLATE/` が `config.yml` と `request.yml`）で、PR を閉じる workflow（`gh workflow list -R <public>`）があることを見る（上の「公開側で受けるもの」）。Private vulnerability reporting は Public にしてから 7 で有効にする。
4. `<public>` の main のファイルとコミットを目で見る（`git log` が 1 コミット、`SECURITY.md` の URL）。`git ls-remote https://github.com/<public>.git` に `main` と `sync/*` のほかの枝が無く、タグが初回の `v0.1.0` だけで（それが公開コミットを指し、合格の tree と一致すること。GitHub Release `v0.1.0` も 1 件）、`gh issue list -R <public> --state all` と `gh pr list -R <public> --state all` が空なことを見る。枝か PR が紛れ込んでいれば Public にしない。枝を消しても、入ったコミットは Public にした後に sha で読め、PR は消せないので、`<public>` を消して作り直し、2 からやり直す。Issue は中身を見て消す。
5. `public-release-gate` の合格をもう一度確かめる: `ops-kit public-sync --dry-run`（2 で `--source` を付けたなら同じ `--source`）が「nothing to sync」で、`git rev-parse 'refs/public-sync/main^{tree}'`（dry-run が fetch した `<public>` の main のツリー）が `public-release-gate: pass <tree sha>` と同じ。違えば（2 の後にツリーが変わった）スキルの手順で回し直し、「直す」が全部 Done になるまで切り替えない。
6. `gh repo edit <public> --visibility public --accept-visibility-change-consequences`。続けて ruleset を付ける: 作れる枝は `main` と `sync/*` だけにし、`main` への変更は PR だけにする（初回の `main` への push は 2 で済んでいる。プランによっては Private のリポジトリに ruleset を付けられないので、Public にした直後）。
7. Private vulnerability reporting を有効化（`gh api -X PUT repos/<public>/private-vulnerability-reporting`。`SECURITY.md` の報告先。Private のリポジトリでは有効にできないので 6 の後）し、`gh api repos/<public>/private-vulnerability-reporting -q .enabled` が `true` であることを見る。`gh repo view <public> --json visibility,hasDiscussionsEnabled`（`PUBLIC` / `true`）と合わせて結果を記録し、公開日と合格の tree sha を残す。

## fork して開発する

上流 mirror は PR を受けない。独自の開発は fork 自身の Issue・Project・PR・レビュー・Release で回し、上流へは要望を送る。

共通の始め方は [キットの fork 手順](../../ops-kit/README.md#fork-して開発を始める) に従う。origin と `GH_REPO` を fork に向け、Project URL をリポジトリ変数に設定し、キットの開発用 Issue フォームを置き、PR 自動クローズを削除する。Project への自動追加は `ops-kit/template/.github/workflows/project-autoadd.yml` を設定して使う。

Switchboard 固有の workflow は `.github/workflows/` のものをそのまま使う。

1. `release-tag.yml` を使うなら、リポジトリ変数 `SWITCHBOARD_RELEASE_TAGS=on` を設定する。main の CI 成功後に `scripts/release-tag.ts` でタグと Release を作る。CI の workflow 名が `CI` であることと Actions の書き込み権限を確認する。
2. AWS ホストを使うなら、[AWS の手順](../../aws/README.md) に従い自分の AWS に初回配置し、OIDC の対象を fork にする。`host.yml` 用のリポジトリ変数 `SWITCHBOARD_AWS_REGION`・`SWITCHBOARD_HOST_STACK`・`SWITCHBOARD_HOST_ROLE_ARN`（GitHubOidcRole 出力）・`SWITCHBOARD_HOST_PARAMS`（秘密を含まない parameter overrides）を設定する（地域とスタック名は既定と違うときだけ）。トークンの値は SSM から読む（名前 `/switchboard/start-token`・`/switchboard/edge-header` はスタックが決める）。

所有者だけの値や記録は `private/` に置き、公開版に同期時の書き換えを追加しない。
