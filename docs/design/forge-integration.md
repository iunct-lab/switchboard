# リポジトリのあるサービスの操作（#920）

バックログの取込み・編集の送信・ローカル CI の結果の報告を、「何をするか」（共通の操作）と「そのサービスでどうするか」（サービスの実装）に分ける。サービスは GitHub と、足している途中の GitLab（PBI #892。下の「GitLab」）。足す場所は下の「第二のサービスを足すとき」に名指しする。汎用の provider の階層・登録型のプラグイン・ランナー（Claude / Codex / DAK）ごとの分岐は作らない。PR とレビューは各サービスの標準のもの（GitHub は gh、GitLab はキットの `mr`。下の「MR・レビュー」）。

## 対象（`ForgeTarget`）

`{ service, host, repository }`。サービスはリポジトリの `ops.config.json` の `forge`（[`config.ts`](../../ops-kit/src/config.ts) の `ForgeConfig`、読むのは [`forge.ts`](../../ops-kit/src/forge.ts) の `forgeOf`）:

```json
"forge": { "service": "github" }
"forge": { "service": "gitlab", "host": "gitlab.example.com", "project": "group/sub/app" }
```

- GitHub の host とリポジトリはサービスの実装が今までの場所から取る（取込みは `gh repo view` と `githubHost()`、送信は保存元のキー、ローカル CI は origin の `owner/name`）。GitHub の設定に書けるのは `service` だけで、ほかのキーは不正（読まない値を書けるようにしない）
- GitLab は `host`（名前だけ。`https://`・ポート・パスは不正）と `project`（全体のパス。サブグループも）が必須。`forgeTargetOf(dir, origin)` が checkout の `origin` の host・パス（大文字小文字は区別しない）と照合し、違えば `ForgeUnsupported` で何も送らない。remote は変えない
- `forge` の無いリポジトリは `github`（#920 より前の全部のリポジトリ）。このリポジトリの設定には 1 回書き足した
- Workspace のランナーの設定（`projectVar` など）とは別。リポジトリがどこにあるかはリポジトリが持つ
- バックログの置き場（workspace の `backlog`: `github` / `switchboard`、#2265）とも別。GitHub 連携の無い workspace でも、PR・CI の報告は `forge` のサービスのまま
- 資格情報は持たない。各サービスの既存の CLI のログイン（GitHub は `gh`、GitLab は `glab`）に任せる。Project の URL は今までどおり `projectUrl` / `<envPrefix>_PROJECT_URL` / リポジトリ変数

## 操作（`ForgeOperation`）と実行（`runForgeOperation`）

| 種類 | 何をするか | GitHub の実装 |
|---|---|---|
| `read` | サービスの Issue・コメント・Project・PR を取り込む | `importGithubSnapshot`（[`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)） |
| `write` | Issue のフィールド（題・本文・状態・ラベル・Milestone・親）を書く | `Sender.send`（[`backlog-send.ts`](../../packages/core/src/backlog-send.ts)） |
| `create` | Issue を作る | 同上 |
| `comment` | コメントを書く（回答を含む） | 同上 |
| `project` | Project への出し入れとフィールド | 同上 |
| `verification` | 検査の結果を PR に報告する（ローカル CI の合格） | `githubForge`（[`forge-github.ts`](../../ops-kit/src/forge-github.ts)、`gh pr comment`） |

送信待ちの操作の種類は `forgeKind`（`backlog-send.ts`）で決まる: `create` / `comment` はそのまま、Project 項目と `field:*`・`member` は `project`、ほかの `set` は `write`。

`runForgeOperation(op, services)` は `op.target.service` の実装の `op.kind` を呼ぶ。呼ぶ前に（`checkForgeOperation`）:

- 対応していないサービス・その操作の無いサービスは `ForgeUnsupported`（「サービス gitlab には対応していません（対応: github）」）。別の方法で代わりに行わない。取込みなら workspace の取込みの失敗（画面の errors）、送信待ちの操作ならその操作を `failed`（理由つき、何も送らない）、ローカル CI なら報告の失敗
- 送る文（`op.texts`。送信待ちの操作は `textsOf(payload)`）に認証に使える値があれば `ForgeRefused`（`findSecrets`。キットはホストの AWS の名前も見る）。編集の保存のとき（422）に加えて、外へ送る直前にもう一度見る（古い DB から戻した操作など、保存の検査を通らずに入ったものも送らない）

サービスの分岐はこの 1 か所（呼び出しごとの `services` の表）だけで、core・ランナーの側に `service === "github"` の分岐を増やさない。

## 第二のサービスを足すとき

1. `ops.config.json` の `forge.service` にその名前（例 `gitlab`）を書く（host やリポジトリを設定から読むなら、そのとき `ForgeConfig` に足して実装が読む）
2. 取込み: `backlog-sync.ts` の `BacklogSync` の取込み（`runForgeOperation({ kind: "read" … }, { github: …, gitlab: … })`）の表に、そのサービスの `read`（保存の形は `putBacklogSnapshot` の記録。キーの `service` / `host` はそのサービスのもの）
3. 送信: `backlog-send.ts` の `sendGithubOperations` の `services` の表に `write` / `create` / `comment` / `project`。足さない種類は対応していないと言って `failed` になる（GitLab は `project` を足していない）
4. ローカル CI の報告: `scripts/local-ci.ts` の `reportPass` の表に `verification`（キットの側は `forge-github.ts` の隣に `forge-<service>.ts`）
5. 保存の型: `BacklogRepositoryKey.service`（[`model.ts`](../../packages/protocol/src/model.ts)）にその値を足す（DB の列は既に `service` を持つ。`gitlab` は足した）

## GitLab（#892）

[`forge-gitlab.ts`](../../ops-kit/src/forge-gitlab.ts)。通信は利用者がログインした `glab` だけ（`glab api --hostname <host> projects/<全体のパスを encode>/…`、REST API v4）。キットは glab を同梱・導入しない。

- ログインの確かめ: `gitlabAuth`（`glab auth status --hostname <host>`）。ログインしていない・glab が無いときは「<host> の glab にログインしていません」とだけ返し、glab の出力（トークンを含みうる）は返さない。ログインは利用者が行う
- `gh` を GitLab の host に向けない。GitLab の操作が走らせるのは `glab` だけ
- 保存のキーは `{ service: "gitlab", host, repository: <project の全体のパス> }`。番号は `iid`、外部 id は種類つきの全体の id（`gitlab:issue:<id>` / `gitlab:note:<id>`）。GitHub の #12 と GitLab の #12 は別の記録

### 取込み（`read`）

`BacklogSync` の取込みの表の `gitlab`（`importGitlabSnapshot` / `fetchGitlabSnapshot`、[`backlog-sync.ts`](../../packages/core/src/backlog-sync.ts)）。Switchboard の保存データが正本で、GitLab は同期先の 1 つ（#2266 の有効・無効はそのまま効く。`syncsGithub` は名前より広く、`switchboard` でも無効でもない同期先すべて）。

- 毎回: open の Issue を全部と、closed のうちカーソル（前回の最新の `updated_at`）以降に更新されたもの（初回は全部）。`type:*` ラベルのもの（と、既に保存したもの）を保存する
- コメントは GitLab の notes のうち `system` でないもの。Issue の `updated_at` が動いたときだけ読み直し、無くなったものは `unavailable`
- どちらの一覧にも出ない保存済みの open の Issue は番号で読む: 404 → `unavailable`、403 → `forbidden`
- 状態は `opened` / `closed`。閉じ方は 1 つなので closed は `COMPLETED`（取り下げ（NOT_PLANNED）は GitLab から読めない）
- 親: GitLab CE に sub-issue は無いので、本文の `## 親 PBI` の節の最初の行の `#N`（節があって番号が無ければ親なし、節が無ければ保存してある親のまま）。親の `subIssues` は、それを親とする Issue
- Project の項目は作らない。GitLab のボードの列はラベルなので、ラベルとして見える。Status・Priority・Story Points などの Project のフィールドは GitLab には無い（送りの扱いは #2910）
- workspace の source は `{ …キー, project: { owner: <project のパス>, number: 0 } }`（GitHub の Project は読まない）
- glab の失敗は `BacklogError`「GitLab（<host>）: glab api が失敗しました（HTTP <status>）」で、取込みの失敗として画面に出る。glab の出力はそのまま出さない
- 利用制限の待ちは host ごと。GitHub の待ちは GitLab の取込みを止めない（GitLab の 429 の待ちは送り（#2910）だけが持つ）
- 一覧で読めた Issue は、値が同じでも前に 403 / 404 だったなら読めたとして保存し直す

### 送り（`write` / `create` / `comment`）

`sendGithubOperations` の `services` の表の `gitlab`（`GitlabSender`、[`backlog-send.ts`](../../packages/core/src/backlog-send.ts)）。共通の送信待ち（`backlog_operations`）と順番・保留の決まりはそのまま。

- set: 題・本文・状態（`state_event` close / reopen）・ラベル（`add_labels` / `remove_labels`）・Milestone（題から id、無しは `0`）。送る前に読んで元の値と比べ（違えば `conflict`、何も書かない）、書いた直後にもう一度読む（違えば `conflict`）。初期方式 A のうち、GitHub の編集履歴の照合（#1329）は GitLab では読まないので、書く直前の他人の編集は、値が送った値と違うときだけ分かる
- 親の set は `failed`（「GitLab には無いフィールドです（parent）。親は本文の ## 親 PBI で書きます」）、Project の項目とフィールドは `project` の操作で GitLab に無いので `failed`（「サービス gitlab の project には対応していません」）。どちらも何も送らない。作成の Project のフィールドは送らない（作成は通る）
- create / comment は本文に印 `<!-- switchboard-op:<id> -->`。答えを失ったら（送った後の 5xx・接続できない）`unknown` にし、次の送りで一覧（Issue は `created_after`、note は新しい順）から印を探す。見つからなければ `unknown` のまま、自分では送り直さない
- 401 はログインの待ち（`Limit auth`）、429 は 1 分の待ち（`Limit`）、送る前に接続できない（HTTP の状態が無い）は 1 分の待ち、409 / 412 は `conflict`、ほかの 4xx は `failed`、5xx は `pending`（GitHub と同じ回数まで）。答えを失った作成・コメントは、印を探す読みが失敗しても `unknown` のまま
- 待ちは host ごと（`source.host`）。GitHub の待ちは GitLab の送りを止めない

### MR・レビュー（`ops-kit mr`、#923）

PR とレビューは各サービスの標準のものを使う（自前の MR・レビューの画面や保存は作らない）。GitLab では、ブランチは標準の `git push`、MR と discussion は `glab api` で [`forge-gitlab.ts`](../../ops-kit/src/forge-gitlab.ts) の関数とキットの `mr` の入口から使う。

| 操作 | GitLab の API | GitHub での対応 |
|---|---|---|
| `mr create --source --target --title --body-file` | `POST merge_requests` | `gh pr create` |
| `mr view <iid>`（JSON: head / base の sha・状態・`detailed_merge_status`） | `GET merge_requests/:iid` | `gh pr view` |
| `mr discussions <iid>`（JSON: id・resolvable・resolved・note の位置（新旧の path と行。消した行は旧だけ）） | `GET merge_requests/:iid/discussions`（GitLab 自身の note は除く） | review threads |
| `mr note <iid> --body-file [--path --line]` | `POST merge_requests/:iid/discussions`（`--path` / `--line` があれば今の差分の新しいファイルのその行の position。old_path は差分のそのファイルの元のパス（名前を変えたファイルは違う）。差分に無いファイルは送らない） | インラインコメント |
| `mr resolve <iid> <discussion id>…` | `PUT merge_requests/:iid/discussions/:id?resolved=true` | `ops-kit pr resolve-thread` |

- MR の番号は `iid`、discussion の id は GitLab の 40 桁の 16 進。GitHub の PR 番号・`PRRT_` のスレッド id とは混ぜない
- resolved は「resolvable な note がすべて resolved」。resolvable な note の無い discussion（要約のコメント）は未解決に数えない
- 投稿する題・本文は `findSecrets` を通し、当たれば何も送らない（`ForgeRefused`）
- `forge` が gitlab でないリポジトリでは `mr` は何もせず exit 2（PR は gh を使う）
- CE に無い承認（Approvals）の API は前提にしない。レビューの証跡は discussion と note

### マージ判定とローカル CI の報告（#924）

`scripts/merge-gate.ts` は `--repo` が無く checkout の `forge` が gitlab なら、その MR（番号は `iid`）を `readGitlabPr` で読み、GitHub と同じ `judge`（impact・`[聞く]`・`[再チェック]`・`[merge-answer]`）で判定する。読むのは GitLab の標準の API だけ（承認（有料）は読まない）。

| PrFacts | GitLab で読むもの |
|---|---|
| `files` | `merge_requests/:iid/diffs` の差分の `+` / `-` の行数。名前を変えたファイルは元のパスも入れる（保護するパスから外す変更も数える）。GitLab が省いた差分（`too_large`）があれば判定しない（exit 2） |
| `headCommittedAt` | `commits` の `authored_date` の最新 |
| `checks` | head の pipeline（MR の `head_pipeline`）。sha が head のときだけ。無い・古いときは、head と target の枝の今の先端の `[local-ci] pass` |
| `unresolvedThreads` | resolvable で resolved でない discussion |
| `mergeState` | `detailed_merge_status`。`mergeable` = CLEAN、ローカル CI で数えたときの `ci_must_pass` / `ci_still_running` = UNSTABLE、計算中（`checking` など）は判定しない（exit 2） |
| 印（`[codex] review`・`[local-ci]`・`[recheck]`・`[merge-ask]` / `[merge-answer]`） | MR の notes のうち、書いた人の project の access level が Developer（30）以上のもの |
| `designRulesTouched` | README.md を触った MR は触ったとみなす（GitLab では節を読まない。`[聞く]`） |

- `--merge` は `PUT merge_requests/:iid/merge` に判定した head の `sha` を付けて GitLab にマージさせる（head が動いていれば GitLab が 409 で断る）。`--merge-stack` は無い（exit 2）
- ローカル CI（`bun scripts/local-ci.ts <iid>`）は GitLab の checkout では MR を回す: head は `refs/merge-requests/<iid>/head`（MR の sha と違えば止まる）、base は target の枝の先端。結果の報告（`verification`）は MR の note（`reportResult` の表の `gitlab`）
- 秘密の検査（`findSecrets`）は GitLab のトークン（`glpat-` など `gl…-` の接頭辞）も見る

### GitHub との差異と、まだ無いもの

| | GitHub | GitLab（CE / Free） |
|---|---|---|
| Project のフィールド（Status・Priority・Story Points など） | Project v2 | 無い。保存データ（Switchboard）だけで持ち、送りは `failed`（差異として見える） |
| ボード | Project のビュー | 標準のボードの列はラベル。ラベルとして読み書きする |
| 親・sub-issue | sub-issue | 無い。本文の `## 親 PBI` から読む。親の set は送らない |
| 閉じ方 | COMPLETED / NOT_PLANNED / DUPLICATE | closed だけ（COMPLETED として読む） |
| 照合（初期方式 A） | 前後の読み + 編集履歴（#1329） | 前後の読みだけ。書く直前の他人の編集は、値が送った値と違うときだけ分かる |
| 承認 | review の承認 | 有料の Approvals は前提にしない。discussion と note が証跡 |
| マージ | `gh pr merge --match-head-commit` / `gh stack merge` | `PUT …/merge` に sha。スタックのマージは無い |
| 認証 | `gh` のログイン | `glab` のログイン（`gitlabAuth`。足りなければ「ログインしていません」とだけ言う） |

実 GitLab を使い始めるときに要るもの（glab の導入とログイン、OSS GitLab の起動、Git の remote の切り替え）は [`gitlab-adoption.md`](gitlab-adoption.md) で比べる。ここでは何もしない。どれも利用者の確認の後だけ。

今の形のまま残っていること（どの PBI にも渡していない事実）:

- 設定画面の同期の文言は「GitHub 同期」のまま（#2266 の有効・無効の操作は GitLab の source にも効く）
- GitLab の取込みは定期の読み直しだけ（Webhook の通知は読まない）

## 検証

- `ops-kit/src/forge.test.ts`: 対象のサービス・ホスト・リポジトリがそのまま実装に渡ること、未対応のサービス・操作、送る直前の秘密の検査（AWS の名前も）、`forgeOf`、`forgeTargetOf`（GitLab の origin の照合）、GitHub の `verification` が前と同じ `gh pr comment`
- `ops-kit/src/forge-gitlab.test.ts`: glab だけを target の host で呼ぶ、ログインしていないときに glab の出力を返さない
- `packages/core/src/backlog-stored.test.ts`「a GitHub #12 and a GitLab #12 are two records」
- `ops-kit/src/forge-gitlab.test.ts`「forge-gitlab read」（[`gitlab-issues.json`](../../ops-kit/fixtures/gitlab-issues.json) の再生）、`packages/core/src/backlog-sync.test.ts`「a GitLab project is imported through glab」
- `packages/core/src/backlog-send.test.ts`「forge operation」: 秘密を含む操作と別サービスの操作は `failed` で GitHub に何も書かない、`forgeKind`。「GitLab:」の 4 件: 元の値との照合と書いた後の読み、無いフィールドの `failed`、印による再送の防止、401 / 429 / 4xx / 5xx
- `packages/core/src/backlog-sync.test.ts`「the import is the read of the repository's forge」: 対応していない `forge.service` の workspace は取込みの失敗（理由つき）で GitHub に聞かない
- `scripts/local-ci.test.ts`「forge verification」、`ops-kit/src/config.test.ts`「forge」「GitLab's forge」
- `scripts/forge-e2e.ts`（`env -u SWITCHBOARD_SUPERVISED bun scripts/forge-e2e.ts`）: 一時 DB・ローカルの bare repo・偽 GitHub・偽 glab で、同じ番号の分離、取込み、両側の編集と conflict（GitLab と GitHub）、コメントと作成の答えを失ったときの印（GitLab と GitHub）、git の push から MR・discussion・resolve、古い head の合格と未解決の discussion でのマージの stop、ローカル CI の結果の note、判定した head でのマージ、GitHub の設定に戻した後の取込みが GitHub を読んでその checkout が GitHub の記録を読み、GitLab の保存データを消さないこと、外への接続 0 を続けて確かめる
