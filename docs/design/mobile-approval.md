# スマホから承認する（PBI #26）

机を離れているあいだに止まった承認（permission.ask）を、スマホで一覧して 1 タップで答える。Switchboard 側にあるのは 3 つ: 全 Task の未回答を返す `GET /api/approvals`（#84。開いている ask を 1 件ずつ全部。朝のキュー `GET /api/queue` の `waiting` は Task ごとの直近 1 件で、用途が違う）、スマホ幅の「承認」画面 `/approvals`（#85）、ホーム画面に置ける PWA（#86）。スマホからデーモンに届く道（Tailscale）は利用者の端末の設定で、この doc はその手順と、どこまで確かめたかを書く。

## 構成

```
スマホ（Safari / Chrome、PWA）
   │  HTTPS（A 案）または HTTP（B 案）
   ▼
Tailscale（利用者の tailnet の中だけ）
   ▼
Switchboard デーモン :47831（SWITCHBOARD_HOST=0.0.0.0 またはループバック + tailscale serve）
```

loopback 以外で listen すると、`/api` と `/ws` はすべて `~/.switchboard/token` のトークンが要る（#31）。`/api/health` だけは開いていて、画面はそれを見てトークンの入力欄を出す。入れたトークンはブラウザの localStorage に残り、次から入れ直さない。

## A 案: `tailscale serve`（推奨。PWA として入れられる）

```bash
bun run --cwd apps/web build                   # デーモンが配る画面をビルド
bun run core                                   # 127.0.0.1:47831（ループバックのまま）
tailscale serve --bg 47831                     # https://<ホスト名>.<tailnet>.ts.net/ → 127.0.0.1:47831
```

- HTTPS なので service worker が動き、スマホの「ホーム画面に追加」でアプリとして入る（開くと承認画面）
- デーモンはループバックで listen しているので**トークンは要らない**。tailscale serve は tailnet の中だけに公開する（`tailscale funnel` はインターネットに公開するので使わない）
- ループバックのデーモンは `Host` のホスト名が `localhost` / `127.0.0.1` / `[::1]` でなければ全経路 403 `host not allowed` を返す（DNS rebinding 対策、#1135）。serve が `Host` をそのまま渡すと tailnet 名の `Host` になるので、デーモンは `SWITCHBOARD_PUBLIC_URL=https://<ホスト名>.<tailnet>.ts.net` を付けて起こす。この値は Task に渡す Workspace MCP の URL にもなるので、MCP も serve 経由になる（serve を止めると Task の MCP が届かない）
- **注意: 開くのは承認画面だけではなく、デーモン全部**（Task の作成、ターミナル tab = デーモンのユーザーでシェルが動く、など）が、tailnet のすべての端末にトークン無しで開く。共有したノード、別のユーザー、乗っ取られた端末が tailnet にあれば、その端末からあなたとしてコマンドを実行できる。Tailscale の ACL（grants / acls）で `:443` をあなたの端末だけに絞るか、次の「A' 案」にする

### A' 案: `tailscale serve` + トークン必須

デーモンの認証は「どこで listen するか」で決まる（ループバック以外ならトークン必須。`packages/core/src/server.ts` の `authRequired`）。ループバック以外で listen させ、serve をそこへ向ける:

```bash
SWITCHBOARD_HOST=100.x.y.z bun run core        # Tailscale IP だけで listen（LAN には開かない）。トークン必須
tailscale serve --bg http://100.x.y.z:47831    # HTTPS のまま、画面は最初にトークンを求める
```

HTTPS なので PWA も入る。tailnet の他の端末からもページは開けるが、トークンが無ければ何もできない

## B 案: HTTP + Tailscale IP（PWA は入らない。ブラウザで開く）

```bash
SWITCHBOARD_HOST=100.x.y.z bun run core        # Tailscale IP だけで listen。トークンが必須になる（0.0.0.0 は LAN にも開く）
# スマホで http://<Tailscale IP（100.x.y.z）>:47831/approvals
```

- HTTP で loopback ではないので secure context ではなく、service worker もインストールも無い（ブラウザで開くだけ）
- 最初にトークン入力欄が出る。`~/.switchboard/token` の中身（`sb_…`）を貼る。URL の `?token=` は WebSocket と MCP クライアントのための口で、画面の URL に付けて共有しない
- `0.0.0.0` にすると LAN（カフェの Wi-Fi など）にも開き、守りはトークンだけになる。Tailscale IP に絞る

## この環境で確かめたこと

### 実行したコマンドと結果

- `bun scripts/approvals-e2e.ts`（headless Chrome、390 × 844、タッチ、偽ランナー）: 承認 2 件が新しい順、横スクロールなし、ボタン 44px 以上、1 タップの「許可」がランナーに届き一覧から消える。PWA: `sw.js` は `text/javascript`、manifest は `application/manifest+json`、Chrome の installability エラー 0、再読み込み後は service worker が画面を返し、`/api/health` は service worker を通らない
- `bun scripts/copy-e2e.ts`（headless Chrome、390 × 844、偽ランナー）: Task 画面のコピーボタン（1 行 / ターン / 会話全体 / ツールの結果、実行中は途中まで）が readText と一致、44px 以上、文の範囲選択が残る。Linux では `--headless=new` がクリップボードを読み戻せないので、`CHROME_BIN` が無ければ Playwright の headless shell（`~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell` の版の新しいもの。`playwright install chromium` が入れる）で回る。`CHROME_BIN` を渡すときも chrome-headless-shell を渡す（`/usr/local/bin/chromium` では読み戻せず exit 1）
- `bun scripts/task-scroll-e2e.ts`（headless Chrome、1280 × 800 と 390 × 844、偽ランナー、60 ターンの会話）: 長い Task の末尾でも見出し（会話 / 差分 / ターミナル・詳細）が見えて押せる、見出しの高さはスマホ幅で画面の 1/3 以下、Task Brief の 指示 で最初の指示文を全文読める、上へ scroll すると 最新へ が出て 1 回で末尾に戻る（#1311）
- `SWITCHBOARD_HOST=0.0.0.0` で起動した worktree のデーモン（一時の HOME、偽ランナー）に headless Chrome で `http://127.0.0.1:47911/approvals` を開いた:
  `{"healthAuthRequired":true,"noToken":401,"withToken":200,"tokenBanner":true,"listBeforeToken":0,"listAfterToken":1,"wsConnected":true,"answered":true,"afterReloadNoPrompt":true}`
  — トークン無しでは一覧が空でトークン入力欄が出る → 貼って保存 → 一覧と WebSocket（daemon connected）→ 画面から許可 → 再読み込みしても入力欄は出ない
- `bun test packages/core/src/mcp.test.ts`（「off loopback, /api needs the bearer token but /api/health stays open」）と `pty.test.ts` が緑

### 未検証

- **スマホ実機**、**Tailscale**（この環境に `tailscale` が無い）、**iOS Safari の PWA**: 利用者が A 案で確かめる
- **`tailscale serve` が `Host` ヘッダーをそのまま渡すか**: デーモンは `/ws` と `/api` の書き込みで `Origin` と `Host` を比べる（`packages/core/src/auth.ts` の `sameOrigin`）。serve が `Host` を `127.0.0.1:47831` に書き換えると、画面は出ても回答と WebSocket が 403「cross-origin request refused」になる。そうなったらここを疑う
- **Web Push** は無い: 端末通知（#1138、設定 → 端末通知）は PWA・タブを開いている間だけ。閉じているときは、開いたときに一覧とバッジで分かる
- **Android の PWA**: `new Notification` が使えない（Service Worker 経由だけ）ので通知は出ず、一覧とバッジで見る
