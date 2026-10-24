# Web UI の Content-Security-Policy

## 方針

デーモンが配信する Web UI に固定の CSP を付け、エージェント出力由来の XSS に対する防御を重ねる。設定や環境変数で切り替えず、`packages/core/src/server.ts` の `WEB_HEADERS` を正本とする。#1517 で緩めた directive は無い（2026-10-18 の E2E で違反 0 件）。

```text
Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
```

`nosniff` で MIME 推測を止め、リファラは同一オリジンへのリクエストに限定する。

## directive ごとの許可

| directive と値 | 許可・禁止 |
| --- | --- |
| `default-src 'self'` | 個別指定のないリソースは同一オリジンだけ。script、worker、frame もこの値にフォールバックし、外部 script、inline script、eval、blob: / data: の worker・frame は許可しない。 |
| `connect-src 'self'` | API と WebSocket（`/ws`・`/ws/pty`）は同一ホストへの接続だけ。 |
| `img-src 'self' data: blob:` | 同一オリジンの画像、data: の画像、添付プレビューの blob: 画像を許可する。 |
| `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` | 同一オリジンの CSS、inline style、Google Fonts の CSS を許可する。 |
| `font-src https://fonts.gstatic.com` | Google Fonts のフォント配信オリジンだけを許可する。 |
| `frame-ancestors 'none'` | Web UI 自身を他のページの frame に埋め込むことを禁止する。 |
| `base-uri 'none'` | base 要素による相対 URL の基準変更を禁止する。 |
| `object-src 'none'` | object / embed による読み込みを禁止する。 |

Google Fonts の 2 オリジンは CSS 用の `https://fonts.googleapis.com` とフォント用の `https://fonts.gstatic.com`。その他の外部リソース配信元は追加しない。

## inline script を許さない理由

HttpOnly Cookie は JavaScript から読めなくても、同一オリジンの `/api` や `/ws/pty` へのリクエストには自動送信される。エージェントの出力に由来する XSS が 1 件入っただけでスクリプトが実行され、API やシェルに届く経路を減らすため、inline script と eval を許可しない。ビルド済み index.html は同一オリジンの外部 script を使うので nonce は不要。

CSP は防御の一層であり、任意の XSS の封じ込めを保証するものではない。許可された script 自体が悪用された場合には同一オリジンの API に接続できるため、描画時にテキストを安全に扱うことも引き続き必要。

## style-src の 'unsafe-inline'

React の `style={{}}` と xterm の inline style を維持するため残す。MUI は依存にない。style の許可は script の inline 実行の許可にはならない。

## 付ける場所・付けない場所

`server.ts` の `cfg.webDist` による全静的配信（index.html、JS / CSS、sw.js、画像など）と index.html への SPA フォールバックに 3 ヘッダを付ける。未ビルド時の text/plain 応答は変更しない。

添付の `/api/attachments/:id` は既存の `Content-Security-Policy: sandbox` と nosniff のまま。API や成果物配信のポリシーは変更しない。Vite の開発サーバ（5173）にはこれらのヘッダを付けない。検証はデーモンがビルド済み UI を配信する構成で行う。

## 検証（E2E が違反を数える）

`core.test.ts` は `GET /`、`GET /assets/app.js`、`GET /no/such/route` の 3 ヘッダと HTML / JavaScript の content-type を検査する。

`Runtime.enable` を呼ぶ全 `scripts/*-e2e.ts` は各自の CDP 接続で `Log.enable` も呼び、`Log.entryAdded` の `entry.source === "security"` を errors（Cloud / teleport は consoleErrors）に数える。既存のゼロ件の assert で CSP 違反も検知する。schedules は既存の 40x の除外を通さないよう security entry を別の配列（`cspErrors`）に入れて 0 件を検査する。backlog-sync は security entry を受けたその場で stderr にも出し、errors の配列を持ち、最後にゼロ件を検査する。report-uri / report-to の受信エンドポイントや共通 CDP ヘルパは作らない。

2026-10-18 の確かめ（PR #1955）: ビルド済みの UI を偽ランナーのデーモンが配信する構成で、headless Chromium で `scripts/*-e2e.ts` を全部回し、CSP の違反（security の項目）はどの script でも 0 件だった。PBI の 5 画面のうち、ターミナル（claude-teleport）・PWA（approvals）・差分タブ（task-scroll）・Cloud notice（claude-cloud）は pass。添付のプレビュー（feedback）は、撮影の場面でサムネイルの画像の表示（`naturalWidth > 0`）まで通り、違反は 0 件。その後の場面の送信の待ちで落ちるが、CSP の無い main でも同じ理由で落ちる。ほかに main でも同じく落ちるもの: asks・backlog・copy・rescue・stops、backlog-sync の `--api`。故意の inline script を document.head に 1 度だけ足した写し（コミットしていない）は、`default-src 'self'` の違反の security の項目で落ちた。

## 今回しないこと

- `'unsafe-inline'` の撤去: React と xterm の描画に必要なため今回行わない。撤去するなら inline style を置き換え、表示を再検証する。
- Google Fonts の同梱: フォント配布方針の変更は今回の範囲外。同梱するなら外部 CSS オリジンを外し、`font-src` を `'self'` に縮められる。
- Trusted Types: 今回は導入しない。導入するなら DOM の注入先と依存ライブラリの対応を調べ、ポリシーと検証を追加する。
