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

## 画面を撮って見る（画面の変更は必ず）

動きと文言の確認だけでは見た目の崩れは分からない（#3953 のキューの表示は E2E が全部通ったまま、スマホでは題が「#40…」まで潰れていた）。画面に関わる変更は、PR を出す前に全画面か触った画面を撮って見る:

```bash
bun run --cwd apps/web build
ops-kit heavy --name "screens-audit" -- bun scripts/screens-audit.ts --screens backlog-queue,schedules --out "$HOME/.cache/switchboard.shots-<PR>"
```

- 実データを `~/.cache` の下に写した候補のデーモン（`SWITCHBOARD_CANDIDATE=1`、ランナーなし、gh は答えない）で、スマホ縦 390×844 と PC 1280×900 を、中でスクロールする要素を 1 画面ずつ送って `<width>-<screen>-<n>.png` に撮る。画面の名前は `scripts/screens-audit.ts` の `screens()`
- 画面ごとの 1 行（はみ出しの数・1 字幅の縦書きの数）は目安。0 でも崩れはありうるので、画像を全部開いて見る。スマホ縦を先に見る
- PBI に画面イメージがあれば、画面イメージを同じ幅で開いて並べる
- 見た画像は PR の本文に貼る（`feedback-assets` の枝。CLAUDE.md の「画像」）

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

`bun run --cwd apps/web build` のあと、`ops-kit heavy --name "fake daemon" -- bun "$W/boot.ts"` で起動する（マシンの重い処理の枠を取ってから始まる。枠が埋まっていれば空くまで待つ。キットの README の「重い処理の枠」）。出力された URL を headless Chrome（`--remote-debugging-port`、CDP）で開く。確認後は自分のプロセスと `$W` だけを片付ける。デーモンが動いている間は枠を持ち、片付けで止めると枠が空く。

- 偽アダプタで応答を合成するときは、`start()` も `send()` もイベントを `queueMicrotask` で出す。`send()` の中で同期に出すと、Task が running になる前に届き、ターンが終わらない
- Task は `/task/<id>` で直接開ける（ヘッダーのタブも `/backlog` などの URL を持つ。対応は `apps/web/src/route.ts`）。rail から押すなら `.t` の文字が Task の題の行（CDP で押す型は `scripts/attention-e2e.ts`）
