# リポジトリのあるサービスの操作（#920）

バックログの取込み・編集の送信・ローカル CI の結果の報告を、「何をするか」（共通の操作）と「そのサービスでどうするか」（サービスの実装）に分ける。サービスは今は GitHub だけ。次に足すのは GitLab（要望 #882）で、そのときに足す場所を下の「第二のサービスを足すとき」に名指しする。汎用の provider の階層・登録型のプラグイン・ランナー（Claude / Codex / DAK）ごとの分岐は作らない。PR とレビューは各サービスの CLI のまま（PBI #891 のスコープ外）。

## 対象（`ForgeTarget`）

`{ service, host, repository }`。サービスはリポジトリの `ops.config.json` の `forge`（[`config.ts`](../../ops-kit/src/config.ts) の `ForgeConfig`、読むのは [`forge.ts`](../../ops-kit/src/forge.ts) の `forgeOf`）:

```json
"forge": { "service": "github" }
```

- host とリポジトリはサービスの実装が今までの場所から取る（GitHub: 取込みは `gh repo view` と `githubHost()`、送信は保存元のキー、ローカル CI は origin の `owner/name`）。設定に書けるのは `service` だけで、ほかのキーは不正（読まない値を書けるようにしない）。読む実装ができたら足す
- `forge` の無いリポジトリは `github`（#920 より前の全部のリポジトリ）。このリポジトリの設定には 1 回書き足した
- Workspace のランナーの設定（`projectVar` など）とは別。リポジトリがどこにあるかはリポジトリが持つ
- バックログの置き場（workspace の `backlog`: `github` / `switchboard`、#2265）とも別。GitHub 連携の無い workspace でも、PR・CI の報告は `forge` のサービスのまま
- 資格情報は持たない。各サービスの既存の CLI のログイン（GitHub は `gh`）に任せる。Project の URL は今までどおり `projectUrl` / `<envPrefix>_PROJECT_URL` / リポジトリ変数

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
2. 取込み: `backlog-sync.ts` の `BacklogSync` の取込み（`runForgeOperation({ kind: "read" … }, { github: … })`）の表に、そのサービスの `read`（保存の形は `putBacklogSnapshot` の記録。キーの `service` / `host` はそのサービスのもの）
3. 送信: `backlog-send.ts` の `sendGithubOperations` の `services` の表に `write` / `create` / `comment` / `project`。足さない種類は対応していないと言って `failed` になる
4. ローカル CI の報告: `scripts/local-ci.ts` の `reportPass` の表に `verification`（キットの側は `forge-github.ts` の隣に `forge-<service>.ts`）
5. 保存の型: `BacklogRepositoryKey.service`（[`model.ts`](../../packages/protocol/src/model.ts)）は今は `"github"` だけなので、その値を足す（DB の列は既に `service` を持つ）

## 検証

- `ops-kit/src/forge.test.ts`: 対象のサービス・ホスト・リポジトリがそのまま実装に渡ること、未対応のサービス・操作、送る直前の秘密の検査（AWS の名前も）、`forgeOf`、GitHub の `verification` が前と同じ `gh pr comment`
- `packages/core/src/backlog-send.test.ts`「forge operation」: 秘密を含む操作と別サービスの操作は `failed` で GitHub に何も書かない、`forgeKind`
- `packages/core/src/backlog-sync.test.ts`「the import is the read of the repository's forge」: `forge.service: gitlab` の workspace は取込みの失敗（理由つき）で GitHub に聞かない
- `scripts/local-ci.test.ts`「forge verification」、`ops-kit/src/config.test.ts`「forge」
