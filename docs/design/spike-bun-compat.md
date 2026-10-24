# Spike: Bun 1.4 と node-pty / @modelcontextprotocol/sdk / codex app-server の互換確認

Issue #3。時間制限 2h。実施日 2026-09-05、Bun 1.4.2 / Node 22.17.0 / codex は `codex-cli 0.148.0-alpha.9`。
結論だけ先に:

| 対象 | 判定 | 根拠 |
|---|---|---|
| `@modelcontextprotocol/sdk` 1.30.0 の streamable HTTP サーバ | **動く** | `WebStandardStreamableHTTPServerTransport` を `Bun.serve` の `fetch` に直結し、同 SDK のクライアントから `listTools` / `callTool` が往復した |
| `node-pty` 1.1.0 | **Bun では動かない** | `pty.spawn` が `posix_spawnp failed`、修正後も onData が一度も来ない。同じ node_modules を Node 22 で動かすと `pty-ok` が返る |
| `codex app-server` の stdio JSON-RPC | **動く** | Bun.spawn で 4 セッション（workspace-write 実行・承認 + 2 ターン目・decline + 中断・再開）を録画できた。Claude の stream-json と同じ行分割リーダーで読める |
| Docker 内から `host.docker.internal` | **解決する** | `alpine` コンテナから `getent hosts host.docker.internal` がホストのアドレスを返す。Linux ホストは `extra_hosts: host.docker.internal:host-gateway` が要る |

## 1. @modelcontextprotocol/sdk（Workspace MCP の前提）

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const server = new McpServer({ name: "spike", version: "0.0.1" });
server.registerTool("echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
await server.connect(transport);
Bun.serve({ fetch: (req) => new URL(req.url).pathname === "/mcp" ? transport.handleRequest(req) : new Response("", { status: 404 }) });
```

- Node 専用の `StreamableHTTPServerTransport`（`http.IncomingMessage` 依存）ではなく **WebStandard** 版を使う。`Bun.serve` の `Request` / `Response` にそのまま乗る。
- `sessionIdGenerator: undefined`（ステートレス）にすると 2 リクエスト目で `Stateless transport cannot be reused across requests` になる。ステートレス運用はリクエストごとに transport を作るか、上のようにセッション付きにする。**1 transport = 1 MCP セッション** なので、複数クライアントを受けるには `Map<sessionId, transport>` を持ち、`mcp-session-id` ヘッダで振り分ける（2 本目の initialize を同じ transport に流すと `Server already initialized`）。Workspace MCP はタスクごとに使い捨てのエンドポイントを出す設計（#11）なので、**タスク = セッション = transport** で収まる。
- SDK 1.30.0 の peerDependency は `zod ^3.25 || ^4.0`。protocol / core が使う `zod@^3.25` のままで動く（zod 4 を別途入れる必要はない。入れると zod インスタンスが二重になる）。

## 2. node-pty（ターミナルタブ #16 の前提）

- node-pty は Bun 1.4.2 では `onData` / `onExit` が一度も発火しない。原因は特定していない（ネイティブアドオンが Node の `uv_pipe` / `process.binding` 相当に依存している可能性）。Bun のバージョンが上がったら`pty.spawn("/bin/zsh", ["-lc", "echo pty-ok"])` で再確認する。
- 2026-10-17 追記: Bun 1.4.3 での再確認は、この環境（Linux arm64、コンパイラ無し）では取れなかった。`node-pty` 1.1.0 の tarball に `linux-arm64` の prebuild が無く（`win32-*` を含む他の platform はある）、ビルドにも `make` / `g++` が要る。`pty.node` が読めずに 1.4.2・1.4.3 のどちらも `Failed to load native module` で止まる（Bun の差ではない）。
- 判断: **PTY は Bun プロセスに載せない。** 選択肢は (a) Phase 2 の Tauri サイドカーとして Node か Rust の小さな PTY ブリッジを置く、(b) `bun-pty` 等の Bun ネイティブ実装を追う。ターミナルタブ #16 は Project 上 P3 なので、この Phase 1 の作業では着手せず (a) を Phase 2 の desktop 作業で扱う。
- 2026-09-19 追記: (b) を #71 で試し、`bun-pty` 0.4.10 が Bun 1.4.2 のプロセス内で動いた。ターミナルタブは `docs/design/pty-bridge.md` の方式（ブリッジのプロセス無し）で作る。`node-pty` が Bun で動かない事実は変わっていない。

## 3. codex app-server（Codex アダプタ #4 の前提）

- 起動: `codex app-server --listen stdio://`。1 行 1 JSON の JSON-RPC 2.0。`initialize` → `initialized` 通知 → `thread/start` → `turn/start`。
- サーバ→クライアントの **要求**（`id` 付き）が承認: `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`。応答は `{"decision": …}`。decision は `accept` / `acceptForSession` / `decline` / `cancel`、コマンド実行にはさらに `{acceptWithExecpolicyAmendment:{execpolicy_amendment:[…]}}` / `{applyNetworkPolicyAmendment:…}` がある。Switchboard は `accept` / `decline` だけを使う（セッション単位の自動許可は使わない）。
- 中断は `turn/interrupt {threadId, turnId}`、`turn/completed` の `turn.status` が `interrupted` になる。
- 再開は別プロセスから `thread/resume {threadId}`。`~/.codex/sessions/...` の rollout がそのまま使われる。
- 使用量は `thread/tokenUsage/updated`（累計 `total` と直近 `last`）、枠は `account/rateLimits/updated`（`primary` 5h / `secondary` 7d、`usedPercent`）。
- 録画は #4（PR #34）で `packages/adapters/codex/fixtures/` に入る。

## 4. Docker → host（DAK アダプタ #19 の前提）

```
$ docker run --rm alpine:3.20 getent hosts host.docker.internal
<ホストのアドレス>  host.docker.internal
```

Linux ホストでは compose に `extra_hosts: ["host.docker.internal:host-gateway"]` を足す。Switchboard は `127.0.0.1` だけで listen している。コンテナからホストのループバックに届くかはランタイム次第（Docker Desktop はプロキシ経由で届く、素の Linux は届かない）なので、DAK アダプタ（#19）では **Workspace MCP のトークン認証（#31 の内容。Issue は Done だが実装は #10 で入れる）を先に入れ、その上で bind を広げるかを決める**。トークン無しで `0.0.0.0` にはしない。
