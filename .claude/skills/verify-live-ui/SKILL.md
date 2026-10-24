---
name: verify-live-ui
description: Switchboard の変更を「動く」と言う前に、実際に動いているデーモンと Web UI（localhost:5173 / Chrome）で確認する手順。ユーザーの bun run dev を壊さない作法、テストデータの後始末。機能追加・修正を終えたとき、PR を出す前に読む。
---

# Verify the live UI before claiming it works

背景: 単体テスト 136 件が緑のまま、dev UI からの POST と WebSocket が全部 403 だった（PR #40 以降、Vite プロキシの
`changeOrigin` が Host を書き換え、デーモンの Origin==Host 判定と食い違った）。境界（プロキシ設定）にバグがあると、
どちら側の単体テストも通る。**実構成で通す**。

## 手順

1. デーモン: `curl -s http://127.0.0.1:47831/api/health`。UI: `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/`。
2. プロキシ越しにブラウザと同じ形で叩く（Origin を付ける）:
   ```bash
   curl -s -w '\nHTTP %{http_code}\n' -X POST -H 'Origin: http://localhost:5173' -H 'content-type: application/json' \
     -d '{"cwd":"/nonexistent","title":"t","prompt":"p","runner":"claude"}' http://localhost:5173/api/tasks
   # 400 "cwd must exist" = Origin 判定は通過。403 = 拒否されている
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: http://evil.example' http://localhost:5173/api/tasks   # 403 であること
   ```
3. Chrome（claude-in-chrome。クラウドホストでは Playwright MCP の `browser_*` が同じ役、`docs/design/cloud-hosting.md` §2.1）: `navigate` → `find` で要素 ref を取り **ref でクリック**（座標クリックは textarea を外す）→ `type`
   → ⌘↵（Inbox 保存。ランナーを起動しない安全な POST）→ `read_network_requests`（`/api/` の status）、
   `read_console_messages`（`error|403|CORS|refused`）、スクリーンショット、デーモン側 `curl /api/inbox` で反映確認。
4. 後始末: 作ったメモを消す（`~/Knowledge/notes/<date>-<title>.md`）、タブを閉じる、立てたプロセスを止める。

## ユーザーの環境を壊さない

- `bun run dev`（`scripts/dev.ts`）は web を kill すると core も止める。**ユーザーのプロセスは kill しない**。
  確認用には別ポートで自分の Vite を立てる: `cd apps/web && SWITCHBOARD_CORE_URL=http://127.0.0.1:47831 bunx vite --host 127.0.0.1 --port 5174 --strictPort`。
- `vite.config.ts` を続けて書き換えると起動中の Vite の自動再起動が固まる（プロセスは残るのに listen しない）。
  直したら「`bun run dev` を再起動してください」と伝える。
- 47831 に既に何か居るとき、自分の `bun run core` は静かに失敗する。`lsof -nP -i :47831` で誰か確認。
- タスク「開始」は実ランナー（Claude/Codex）を実リポジトリで動かす。確認目的で押さない。

## 自動化するなら

実構成の E2E を残す: `packages/core/src/devproxy.test.ts` は本物の Vite dev server を本物のデーモンに繋ぎ、
ブラウザと同じ Origin で POST / WS / 外部 Origin 拒否を確認する。新しい境界（プロキシ・認証・CORS）を触ったら同型のテストを足す。

## 隔離した偽ランナーのデーモン

`packages/core/src/devproxy.test.ts` と同じく、ランナー未登録の `[]` を使う。実ランナーは起動しない。応答の合成が要る場合は `packages/core/src/core.test.ts` の偽アダプタを使う。

```bash
W=$(mktemp -d /tmp/switchboard.e2e.XXXXXX)
PORT=47911
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
export PORT
mkdir -p "$W/home"
# 既存 DB は sqlite の .backup でコピーする。元の DB には書かない。
[ ! -f "$HOME/.switchboard/switchboard.db" ] || sqlite3 "$HOME/.switchboard/switchboard.db" ".backup '$W/home/switchboard.db'"   # 無ければ空の DB で始まる
```

`$W/boot.ts` に以下を書く。`<checkout>` はチェックアウトの絶対パスに置き換える。

```ts
import { join } from "node:path";
import { loadConfig } from "<checkout>/packages/core/src/config.ts";
import { startServer } from "<checkout>/packages/core/src/server.ts";

const home = join(import.meta.dir, "home");
const port = Number(process.env.PORT);
const core = await startServer(loadConfig({
  SWITCHBOARD_HOME: home,
  SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"),
  SWITCHBOARD_PORT: String(port),
  SWITCHBOARD_CANDIDATE: "1", // コピーした DB の未送信の書き込みを本物の GitHub へ送らない（sb-rescue の候補と同じ）
  SWITCHBOARD_CLAUDE_PROJECTS: join(home, "no-history"),
  SWITCHBOARD_HISTORY_POLL_MS: "0",
}), [], { port });
console.log(`http://127.0.0.1:${core.server.port}`);
```

`bun run --cwd apps/web build` のあと、`bun "$W/boot.ts"` で起動する。出力された URL を headless Chrome（`--remote-debugging-port`、CDP）で開く。確認後は自分のプロセスと `$W` だけを片付ける。
