# Approving from a phone

When you are away from your desk, approvals (`permission.ask`) pile up. From a phone you list them and answer with one tap. Switchboard has three parts for this: `GET /api/approvals`, which returns the unanswered asks of all Tasks (every open ask, one entry each; `waiting` in the morning queue `GET /api/queue` is only the latest one per Task, so it serves a different purpose), the phone-width `承認` screen `/approvals`, and a PWA that can be placed on the home screen. The path from the phone to the daemon (Tailscale) is configured on the user's own devices; this doc gives those steps and how far they have been verified.

## Architecture

```
Phone (Safari / Chrome, PWA)
   │  HTTPS (option A) or HTTP (option B)
   ▼
Tailscale (inside the user's tailnet only)
   ▼
Switchboard daemon :47831 (SWITCHBOARD_HOST=0.0.0.0, or loopback + tailscale serve)
```


When the daemon listens on anything other than loopback, every `/api` and `/ws` request needs the token in `~/.switchboard/token`. Only `/api/health` stays open, and the screen uses it to decide whether to show the token field. The token you enter stays in the browser's localStorage, so you do not enter it again.

## Option A: `tailscale serve` (recommended; installable as a PWA)

```bash
bun run --cwd apps/web build                   # デーモンが配る画面をビルド
bun run core                                   # 127.0.0.1:47831（ループバックのまま）
tailscale serve --bg 47831                     # https://<ホスト名>.<tailnet>.ts.net/ → 127.0.0.1:47831
```


- Because it is HTTPS, the service worker runs, and "Add to Home Screen" on the phone installs it as an app (opening it shows the approvals screen).
- The daemon listens on loopback, so **no token is required**. `tailscale serve` exposes it only inside the tailnet (do not use `tailscale funnel`, which exposes it to the internet).
- A loopback daemon returns 403 `host not allowed` on every route unless the `Host` hostname is `localhost`, `127.0.0.1` or `[::1]` (a DNS rebinding defense, decided 2026-10-12). If serve passes `Host` through unchanged, the `Host` carries the tailnet name, so start the daemon with `SWITCHBOARD_PUBLIC_URL=https://<ホスト名>.<tailnet>.ts.net`. This value also becomes the Workspace MCP URL handed to Tasks, so MCP goes through serve as well (if you stop serve, the Tasks' MCP cannot connect).
- **Caution: what opens is not only the approvals screen but the whole daemon** (creating Tasks, the terminal tab, where a shell runs as the daemon's user, and so on). It opens to every device on the tailnet without a token. If a shared node, another user or a compromised device is on the tailnet, that device can run commands as you. Either restrict `:443` to your own devices with Tailscale ACLs (grants / acls), or use option A' below.

### Option A': `tailscale serve` + a required token

The daemon's authentication is decided by where it listens (anything other than loopback requires the token; `authRequired` in `packages/core/src/server.ts`). Make it listen off loopback and point serve at it:

```bash
SWITCHBOARD_HOST=100.x.y.z bun run core        # Tailscale IP だけで listen（LAN には開かない）。トークン必須
tailscale serve --bg http://100.x.y.z:47831    # HTTPS のまま、画面は最初にトークンを求める
```


Because it is HTTPS, the PWA installs too. Other devices on the tailnet can open the page, but they can do nothing without the token.

## Option B: HTTP + Tailscale IP (no PWA; open in the browser)

```bash
SWITCHBOARD_HOST=100.x.y.z bun run core        # Tailscale IP だけで listen。トークンが必須になる（0.0.0.0 は LAN にも開く）
# スマホで http://<Tailscale IP（100.x.y.z）>:47831/approvals
```


- Over HTTP, and not loopback, the page is not a secure context, so there is no service worker and no installation (you just open it in the browser).
- A token field appears first. Paste the contents of `~/.switchboard/token` (`sb_…`). The `?token=` in the URL is an entry point for WebSocket and MCP clients; do not add it to the screen's URL or share it.
- With `0.0.0.0` the daemon also opens to the LAN (a café Wi-Fi, for example) and the token is the only protection. Restrict it to the Tailscale IP.

## How to verify

### Commands to run and what to see

- `bun scripts/approvals-e2e.ts` (headless Chrome, 390 × 844, touch, fake runner): 2 approvals newest first, no horizontal scroll, buttons at least 44px, one tap on `許可` reaches the runner and removes the ask from the list. PWA: `sw.js` is `text/javascript`, the manifest is `application/manifest+json`, 0 Chrome installability errors, after a reload the service worker returns the screen, and `/api/health` does not go through the service worker.
- `bun scripts/copy-e2e.ts` (headless Chrome, 390 × 844, fake runner): the copy buttons on the Task screen (one line / a turn / the whole conversation / a tool result, and partway while running) match readText, are at least 44px, and sentence range selection still works. On Linux `--headless=new` cannot read the clipboard back, so without `CHROME_BIN` it runs on Playwright's headless shell (the newest version of `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell`, which `playwright install chromium` installs). When you pass `CHROME_BIN`, pass chrome-headless-shell too (`/usr/local/bin/chromium` cannot read it back and exits 1).
- `bun scripts/task-scroll-e2e.ts` (headless Chrome, 1280 × 800 and 390 × 844, fake runner, a 60-turn conversation): even at the end of a long Task the headings (`会話` / `差分` / `ターミナル`・`詳細`) are visible and tappable, the heading height on a phone width is at most 1/3 of the screen, the first instruction can be read in full in `指示` of the Task Brief, and scrolling up shows `最新へ`, which returns to the end in one tap.
- Off loopback, with the token: start a daemon with `SWITCHBOARD_HOST=0.0.0.0` (temporary HOME, fake runner) and open `http://127.0.0.1:<port>/approvals` in headless Chrome. Without the token `/api/health` answers 200 with `authRequired: true` while a protected route such as `/api/tasks` answers 401, the list is empty and the token field appears; paste and save, then the list and the WebSocket (daemon connected) work; allow from the screen; after a reload the field does not appear again.
- `bun test packages/core/src/mcp.test.ts` (the case "off loopback, /api needs the bearer token but /api/health stays open") and `pty.test.ts` should pass.

### Not covered by those checks

- **A real phone**, **Tailscale** and **the iOS Safari PWA**: verify these on your own devices with option A.
- **Whether `tailscale serve` passes the `Host` header through unchanged**: for writes to `/ws` and `/api` the daemon compares `Origin` with `Host` (`sameOrigin` in `packages/core/src/auth.ts`). If serve rewrites `Host` to `127.0.0.1:47831`, the screen appears but answers and the WebSocket get 403 "cross-origin request refused". If that happens, suspect this first.
- **There is no Web Push**: device notifications (`設定` → `端末通知`) work only while the PWA or a tab is open. When it is closed, you see the list and the badge when you open it.
- **The Android PWA**: `new Notification` is unavailable there (only through a Service Worker), so no notification appears; use the list and the badge.
