---
name: runner-adapter-recording
description: ランナーアダプタ（Claude / Codex / DAK）を書く・直すときの型。実ランナーの録画 fixture を取り、再生テストで AgentEvent への変換を固定し、偽サーバでセッション制御（確認・中断・再接続）を検証する。packages/adapters/* を触るときに読む。
---

# Runner adapter: record, replay, fake server

設計上の唯一の契約は `packages/protocol` の `AgentEvent`（`session.start / message.delta / tool.call / tool.result /
permission.ask / permission.resolved / usage / quota / artifact / session.end / error`）と `RunnerSession`
（`send / respondPermission / abort / close({graceMs}) / exited`）。ベンダの CLI コードやプロトコル定義は取り込まない。

既存の録画は配布しない。自分の実ランナーで下記の手順に従って録画し、Git の外に保存する。`bun scripts/fixtures.ts list` で有無を確認する。録画が無いテストは理由と録画手順を出して skip する。`SWITCHBOARD_FIXTURES` を明示した場合だけ不足を fail にする（local-ci も同じ）。

録画の 2 つ目の写しは、origin のリポジトリの枝 `recordings-vault`（main にマージしない。公開の同期は main のツリーだけを送る）。`bun scripts/fixtures.ts save` が保管庫の全ファイルを枝に足し（変わったファイルは置き換え、枝にしか無いファイルは残す）、`fetch` が枝にあって保管庫に無いファイルを書き（既にあるファイルは上書きしない）、`sync` が両方をする。タグの CI（`scripts/tag-ci.ts`、`SWITCHBOARD_FIXTURES` を付けた定期実行）が最初に `sync` するので、録った録画はその定期実行の次の回に人の手なしで枝に届き（いつ走るかは登録された定期実行、`GET /api/schedules`）、作り直しで保管庫が空になっても次の実行で戻る。すぐ戻すなら `bun scripts/fixtures.ts fetch`。枝が無い clone（公開の clone、fork）では `save` / `fetch` は理由を出して exit 2 で、`save` は `--create` を付けたときだけ枝を作る（公開の fork に録画を出さないため）。

## 手順

1. **録画**: 実ランナーを 1 回動かし、ワイヤをそのまま `SWITCHBOARD_FIXTURES`（既定 `~/.switchboard/fixtures`）の下に、リポジトリ相対の `packages/adapters/<r>/fixtures/*.{jsonl,sse}` として保存。録画は main のツリーに入れない。新しい録画は `scripts/fixtures.ts` の `RECORDINGS` に名前を足し、`bun scripts/fixtures.ts save` で枝に送る（省いても次のタグの CI の `sync` が送る）。
   どの版で録ったか（CLI バージョン、commit）を fixture 名かテスト冒頭に書く。
   - Claude: `claude -p --input-format stream-json --output-format stream-json`（`docs/design/claude-stream-json.md`）
   - Codex: `codex app-server` stdio JSON-RPC（`docs/design/codex-app-server.md`）
   - DAK: ADK REST `POST /run_sse`（`docs/design/dak-adapter.md`。`docker compose up` で 127.0.0.1:8000）。DAK の録画は `packages/adapters/dak/fixtures/` のまま
2. **再生テスト**: fixture を parse 関数に流し `AgentEvent` の列を assert。`AgentEvent.parse(ev)` で schema 準拠も見る。
3. **偽サーバ / 偽プロセス**でセッション制御を検証（`packages/adapters/adk/fixtures/fake-adk.ts` の型）: 確認要求 → 応答、途中エラー、
   中断、ストリーム終了後の追加ターン。プロンプト接頭辞で挙動を切り替える。
4. 実ランナーでのスモークを 1 回はやり、PR の「テスト観点」に**やった事実だけ**書く。

## 踏んだ落とし穴

- `{ ...DEFAULTS, ...options }` は `options.baseUrl === undefined` でも上書きする → undefined を落としてから merge。
- 「1 invocation で 1 度 stream 済み」のフラグは、ツール呼び出しを挟んだ 2 つ目の返答を潰す → セグメント単位でリセット。
- 確認要求（permission.ask）が emit された直後に同期的に `respondPermission` されると、ストリーム終端の
  「まだ待ち」判定が外れて `session.end` が二重に出る → ターン内でフラグを立てて判定する。
- ストリームがエラー終了したら開いている確認要求を deny で閉じる。`close()` は `graceMs` を尊重する。
- DAK の `mcp_servers[].headers` はピン留めされた DAK 版では `make_mcp_toolset()` で捨てられる。Switchboard の
  `/mcp/<taskId>` は `?token=` も受けるので URL に入れる。主張はソースを読んで裏取りしてから書く。
- テストが既定ポートの実サービスに当たると結果が変わる（DAK が 8000 で動いていた）。存在しない app 名や port 0 で隔離する。
