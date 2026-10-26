# 新しいリポジトリを始める（何が要り、どこまで揃えば開始してよいか）

PBI #1445、要望 #1444。新しいリポジトリを Switchboard の開発資産（共通スキル・`ops-kit`・バックログ画面・マージ判定）で回し始めるとき、何を自分で持ち、何を Switchboard が置き、何が GitHub 側の設定かを 1 か所に集める。**規則そのものは正本に書かれている**。ここは正本へのリンクと 1 行の要約だけを持ち、同じ規則を 2 か所に書かない。


## 3 つの層

| 層 | もの | 置き場所 | 正本 |
|---|---|---|---|
| A | 設定 `ops.config.json`（Project の URL・`envPrefix`・Area などの選択肢・必須の節・Story Points） | リポジトリの root | [使う側の設定](../../ops-kit/README.md#使う側の設定opsconfigjson) |
| A | `scripts/setup/` の入口（`lint_backlog.sh` / `set_project_field.sh` / `triage_issue.sh` / `request_issue.sh`。`bootstrap_project.sh` は Project を作る側だけ） | リポジトリの `scripts/setup/` | [入口（使う側のリポジトリ）](../../ops-kit/README.md#入口使う側のリポジトリ) |
| A | `CLAUDE.md` / `AGENTS.md`（そのリポジトリ固有の値。テスト・作業の場所と枝・live check・反映の OK ほか） | リポジトリの root | [使う側のリポジトリが持つもの](../../ops-kit/skills/issue-workflow/SKILL.md#使う側のリポジトリが持つもの) |
| A | Issue テンプレ・PR テンプレ・`labels.yml`・workflows（`labels.yml` / `ci.yml`）・`.gitignore` | リポジトリの `.github/` と root | [雛形（新しいリポジトリ）](../../ops-kit/README.md#雛形新しいリポジトリ) |
| B | 共通スキル 10 本（`.claude/skills/<name>` と `.agents/skills/<name>` へ、Task のランナーを起動する直前にコピーし、`info/exclude` で Git の管理対象から外す） | Switchboard が Task の起動時に置く | [skill-sync.md 置き方](skill-sync.md#置き方) |
| B | `gh` の前段（認証に使える値を Issue・PR に書かせない）と定期の検査 | Task の `PATH` の先頭（`ops-kit/bin`） | [secret-guard.md 部品](secret-guard.md#部品) |
| B | 他リポジトリの読み替え（`--repo` つきのマージ判定・並列ガード・タグ付け、`otherRepoRules`） | Switchboard のスクリプトとステージの指示 | [releases-and-rescue.md Other repositories](releases-and-rescue.md#other-repositories) |
| B | バックログ画面（Issue・Project の値の取込み。workspace ごとの `projectVar`） | Switchboard のデーモン | |
| C | Issue・sub-issue・Milestone（要望 → PBI → Task の階層） | GitHub | [issue-workflow](../../ops-kit/skills/issue-workflow/SKILL.md) |
| C | Project とそのフィールド（Area / Kind / Priority / Story Points、Status）。ビューは作れない | GitHub（`bootstrap_project.sh` が作る） | [bootstrap.ts](../../ops-kit/src/bootstrap.ts) の `bootstrap` |
| C | リポジトリ変数 `<PREFIX>_PROJECT_URL`（Project の URL。バックログ画面とスクリプトが読む。`<PREFIX>` は `envPrefix`） | GitHub のリポジトリ変数（`gh variable set`） | [使う側の設定](../../ops-kit/README.md#使う側の設定opsconfigjson) |
| C | Actions: `labels.yml`（ラベル同期）・`ci.yml`。`project-autoadd`（Project 自動追加）は任意（「手作業で残るもの」の 3）。認証の値の検査は、デーモンの予定（種類「認証の値の検査」。利用者が定期タスクの画面で作る。起動時に勝手には作られない）が登録済みの全リポジトリに回し、Actions の `secret-scan.yml` はホストの外の予備（週に 1 回。[secret-guard.md](secret-guard.md#定期の検査)） | GitHub Actions | [雛形](../../ops-kit/README.md#雛形新しいリポジトリ)、[secret-guard.md 定期の検査](secret-guard.md#定期の検査) |

層 A は Switchboard が無くても要る（リポジトリが自分で持つ）。層 B は Switchboard から Task を起動して初めて効く。層 C は GitHub の側で、Actions が始まらない間は動かないものがある（`labels.yml` / `ci.yml`。Actions 無しで回す仕組みは #890 / #891 の範囲で、ここでは現状だけを書く）。

## 用途による違い

リポジトリの用途で違うのは、`CLAUDE.md` の次の 2 項目に書く内容。ほかの項目（テスト・作業の場所と枝・live check の書き方・マージ判定）は用途によらず同じ型。

| 用途 | 互換の前提（`CLAUDE.md` の互換層の項目） | 動いている実物と反映の OK（`CLAUDE.md` の「Task と動いているコード」の項目） |
|---|---|---|
| 期限なしのアプリ（利用者が使い続ける） | 利用者の有無と、旧形式を読む層を置くか。データは migration で 1 回移すのか | 実物は利用者の環境。反映（再起動・配置）は利用者の OK を取ってから |
| バックエンドの置き換え・新規追加 | 旧バックエンドとの併存期間と、外部クライアントの有無。切り戻しの手段 | 動いている旧バックエンドは触らない。新しい側の dev で確かめ、本番への切り替えは利用者の OK |
| 独自のモニタリング | 観測対象に影響を与えないこと（読み取りだけか）。保存するデータの形の互換 | 監視が動いている間の変更は、監視の欠測が出ない反映の手順と、その OK |

この 2 列に収まらない違いが出たら、表に足さず PBI #1445 の決定ログに書く。

## 手作業で残るもの

Switchboard の道具では置けず、人が 1 回やるもの。

1. **Project のビュー 2 つ**。GitHub の API では Project のビューを作れない（`ops-kit/src/bootstrap.ts` の注記「Views cannot be made through the API」）。Project の画面で、ビュー `Backlog`（フィルタ `no:parent-issue`。要望と PBI）と `Task Board`（フィルタ `has:parent-issue`。Task）を作る。フィールドは `bootstrap_project.sh` が作る
2. **Actions が始まらない間のラベル作成**。`labels.yml` の workflow はラベルを main への push で同期するが、Actions が動かない間（請求の問題など）は同期されない。そのときは `.github/labels.yml` の項目を `gh label create <name> --color <hex> --description <text> -R <owner/name>` で 1 件ずつ作る（作り済みなら `gh label edit`）。Actions 無しで同期する仕組みは #890
3. **Project 自動追加（`project-autoadd`）を置かない判断**。Project に Issue を自動で入れる workflow は、Project への書き込み権限を持つ PAT の登録と更新が要る。それが要らない構成にするなら置かない。置かない場合は、新しい Issue を `scripts/setup/triage_issue.sh` で Project に入れる（Web 画面から直接作った Issue は、それを実行するまで Project に入らない）。置くなら PAT をリポジトリのシークレットに登録する

## 開始してよい条件

リポジトリの Definition of Ready。次の 6 つが全部通れば、そのリポジトリで `/pbi-complete` などを始めてよい。条件を検査するスクリプトは置かない（この表が正本。手順を Runner が実行する形は #1446）。`<PREFIX>` は `ops.config.json` の `envPrefix`。

| 条件 | コマンド | 期待結果 | 層 |
|---|---|---|---|
| バックログの規則 | `bash scripts/setup/lint_backlog.sh` | 最後の行が `violations: 0`、exit 0 | A |
| Project の URL | `gh variable get <PREFIX>_PROJECT_URL -R <owner/name>` | `https://github.com/<orgs\|users>/<owner>/projects/<n>` | C |
| バックログ画面 | `curl -s -H "Authorization: Bearer $(cat ~/.switchboard/token)" localhost:47831/api/backlog \| jq '{ws:[.items[].workspaceName]\|unique, errors}'`（トークンの置き場は README の「Data lives in」。値は書かない） | `ws` にそのリポジトリの workspace 名があり、`errors`（`{ workspaceId, workspaceName, message }` の配列）にその workspace の項目が 1 件も無い（`message` の文によらない。失敗した取込みは保存値を返すので、`ws` だけでは足りない） | B |
| スキル | そのリポジトリから Task を 1 つ起動したあと `ls .claude/skills/*/.switchboard-skill .agents/skills/*/.switchboard-skill \| wc -l` | 20（共通スキル 10 本 × 2 か所。印は [skill-sync.md](skill-sync.md#見分け方switchboard-が置いたもの)） | B |
| マージ判定 | 最初の PR で `bun <switchboard>/scripts/merge-gate.ts <PR> --repo <owner/name>; echo $?` | 0（merge）か 1（stop）。2（判定不能）は未達 | B |
| `CLAUDE.md` の 4 項目 | `grep -nE '^## (テスト\|作業の場所\|.*live check\|.*動いているコード)' CLAUDE.md` | 4 項目が各 1 件以上: テストの 3 コマンド（型検査・全体・1 件）、作業の場所と枝、live check、反映に要る OK | A |

この表と「手作業で残るもの」を実行する手順（決めること → GitHub 側 → 初期コミット → 登録 → 開始条件 → 報告）は、Switchboard 専用のスキル `.claude/skills/new-repo`（#1446）。

## 既存のリポジトリを追加する

GitHub にある**自分のリポジトリ**を、名前だけで Workspace に追加する入口（PBI #2575）。ホストのシェルに入れない利用者のための経路で、パスは打たない。

- 入口: 設定の先頭の「Workspace」カードの「GitHub から」。`owner/name` か `https://github.com/owner/name`（末尾の `.git` と `/` は可）を入れて「追加」。API は `POST /api/workspaces` の `repo`（`path` とはどちらか一方）
- 置き場所: Switchboard のチェックアウトの隣（`<repoRoot の親>/<name>`）。置き場所の設定は無い（新しく作る場合と同じ）
- 断る入力（400）: `-` で始まる名前、`.` / `..`、github.com 以外の URL、余分な `/`。clone の引数は配列で渡り、シェルを通らない。同じ名前のディレクトリが既にあれば 409（上書きしない）
- 他者のリポジトリは追加しない: clone の前に `gh api repos/<owner>/<name>` の `permissions.push` を確かめ、読めなければ 404、push できなければ 403（「他者のリポジトリはこの欄では追加しません」）で、clone も登録もしない。工程の Task が他者のリポジトリに Issue・PR を書かないため。他者のリポジトリを自分の側で開発できる形で追加する経路は別の PBI（#2576）
- 進み具合: 要求は 202 ですぐ返り、clone は裏で進む。進行中と失敗（gh の最後の行）は `GET /api/workspaces/clones` に出て、状態が変わるたびに `workspaces.updated` で画面が読み直す。成功すると Workspace の一覧に出る。進み具合は保存しないので、デーモンの再起動で消える
- 途中で落ちたとき: clone の途中のディレクトリは残る。次の追加は 409 になるので、人が消す（登録を外すときに「ローカルのコピーも消す」を選べば消せる。下の「登録を外す」）
- 「GitHub と連携しない」の印は「GitHub から」にも効き、その workspace のバックログは Switchboard に置かれる
- ホストにあるディレクトリを追加する欄（`path`）は今までどおり

## 登録を外す（ローカルのコピーも消す）

設定の「Workspace」カードの各 repo の行の「登録を外す」（PBI #2600）。#2575 の「登録を外してもディレクトリは消さない」は、外す機能が無かった間の文で、今は外すときに選ぶ。

- 確認は行の下に開く: workspace の名前を入力（一致するまで実行できない）、「ローカルのコピーも消す」（消せないときは出ない）、警告 1 行（コピーを消す選択で変更あり / push 前のコミットあり。動いている Task があるときはその件数）。API は `GET /api/workspaces/:id/removal`（確認の内容）と `DELETE /api/workspaces/:id`（`{ deleteCopy }`）。消えると `workspaces.updated` で開いている画面の行が消える
- コピーを消せるのは、Switchboard のチェックアウトの親ディレクトリの直下にある Git のチェックアウトだけ。meta workspace・Switchboard 自身・シンボリックリンクで外へ出るパス・入れ子は 400、Git でないディレクトリは 409（登録だけなら外せる）
- 断る（409）: その workspace か配下のディレクトリで動いている Task（running・waiting。shadow を含む）、その workspace を使うスケジュール。終わった Task の履歴は残る
- バックログの保存データは、同じリポジトリを指す workspace が他に残らないときだけ消える（Switchboard にだけ置いたバックログは、外すと消える）。外した後、同じパスは登録し直せる
- GitHub 側（リポジトリ・Project・変数）は消さない。人が GitHub で行う
