# Claude Code の定額認証を Switchboard から使う構成の規約確認（PBI #22）

この doc は一次資料の原文の引用と、その読み取りまでを書く。法的助言ではない。判定案はエージェントが書き、**採否は利用者が決める**（このリポジトリで採った範囲は末尾「対象とする利用」）。

## Switchboard の構成

- 利用者の端末で、利用者が起動するデーモン。1 人が自分のために使う
- Claude Code は利用者が自分でインストールし、自分で `claude` の `/login`（Anthropic 自身のログイン手順）でログインしたもの。Switchboard はその**改変していない** `claude` を子プロセスとして起動する（`claude -p --output-format stream-json …`、`docs/design/claude-stream-json.md`）
- Switchboard は鍵もトークンも持たない。Claude.ai のログイン画面を出さず、`~/.claude` の認証情報を読まない・写さない・送らない（README「Design rules」の「No keys, no telemetry. Your own login, on your own machine.」。#24 で下の「注記の文案」に差し替えた）
- 他人の使用を 1 つの定額プランで肩代わりしない（複数利用者向けのホスティングはしない）
- 同じ Switchboard を**利用者自身の AWS アカウントの機械**でも動かせる（`docs/design/cloud-hosting.md`）。その場合の扱いは下の「利用者自身のクラウドの機械で動かす場合」

## 一次資料（取得日は断りの無い限り 2026-09-24）

### 1. Claude Code — Legal and compliance

https://code.claude.com/docs/en/legal-and-compliance （ページに日付の表示なし。取得日 2026-09-24）

> Your use of Claude Code is subject to: … [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) - for Free, Pro, and Max users

> Claude Code usage is subject to the [Anthropic Usage Policy](https://www.anthropic.com/legal/aup). Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below: … **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential …

> This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials — for example, configuring an API key in a development environment, secrets manager, or machine image for use by the customer's own authorized users — provided the resulting usage is billed to the key owner under their agreement with Anthropic (or the applicable provider) and is not resold or intermediated as described above.（取得日 2026-09-25。上の「Nor does it prevent …」の直前の文）

> **Using the Claude Code name and logo.** You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name, in your own logo, or in a way that suggests Anthropic built, endorses, or is partnered with your product.（取得日 2026-09-25）

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

### 2. Consumer Terms of Service（Pro / Max に適用）

https://www.anthropic.com/legal/consumer-terms （Effective October 8, 2025。取得日 2026-09-24）

> You may access and use our Services only in compliance with our Terms, including our Acceptable Use Policy, … You are responsible for all activity under the account through which you access the Services. You may not access or use, or help another person to access or use, our Services in the following ways:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

### 3. Usage Policy

https://www.anthropic.com/legal/aup （Effective September 15, 2025。取得日 2026-09-24）

> Agentic use cases must still comply with the Usage Policy.

（定額プランの認証を第三者のツールから使うことには触れていない。）

### 4. Claude Code — Agent SDK overview

https://code.claude.com/docs/en/agent-sdk/overview （日付の表示なし。取得日 2026-09-24）

> To drive the same agent loop from a language other than Python or TypeScript, run the CLI as a subprocess with the `-p` flag and `--output-format json`.

「Branding guidelines」節（取得日 2026-09-25）:

> For partners integrating the Claude Agent SDK, use of Claude branding is optional. … **Not permitted:** "Claude Code" or "Claude Code Agent"; Claude Code-branded ASCII art or visual elements that mimic Claude Code. Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product.

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

### 5. Claude Code — Run Claude Code programmatically（headless / `-p`）

https://code.claude.com/docs/en/headless （日付の表示なし。取得日 2026-09-24）

> `--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release.

`claude --version` は `2.1.282 (Claude Code)`（2026-09-25）。`claude --help`（2.1.281、2026-09-24）の `--bare` の説明: 「Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read).」

### 6. Claude Code — Authentication

https://code.claude.com/docs/en/authentication （日付の表示なし。取得日 2026-09-24）

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token` … This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan.

### 7. Help Center — Use the Claude Agent SDK with your Claude plan

https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan （記事の日付 2026-06-16。取得日 2026-09-24）

> Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, claude -p , and third-party app usage still draw from your subscription's usage limits.

### 8. Help Center — What is the Max plan?

https://support.claude.com/en/articles/11049741-what-is-the-max-plan （取得日 2026-09-25。ページ要約ツール経由で読んだので、引用は原文と照合していない）

> Your session-based usage limit will reset every five hours. Max plans also have a weekly usage limit that applies across all models.

定額プランの説明に、Claude Code を第三者のツールから起動することの可否は書かれていない（Pro の説明ページは読んでいない）。

### 参考（二次資料。判定の根拠にはしない）

- The Register（2026-02-20）: 第三者ツールでの消費者向け OAuth の扱いを明確にした docs 更新の報道 — https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- VentureBeat: 第三者エージェントの定額プラン利用の停止と再開の報道 — https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch

## 判定案（エージェントの読み取り。法的助言ではない）

**条件付き**。

- 許される側の根拠: 資料 1 の「Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription」。Switchboard は改変していない `claude` を起動し、ログインは Anthropic 自身の手順で利用者が行い、Switchboard は認証情報を集めない・保存しない・中継しない（資料 1 の「developers may not collect, store, or intermediate …」に当たらない）。`claude -p` を子プロセスで起動すること自体は資料 4 が他言語からの使い方として書いている。資料 7 は「claude -p , and third-party app usage still draw from your subscription's usage limits」と、スクリプトや第三者アプリからの定額プラン利用が続いていることを示す（資料 2 の自動化禁止の「where we otherwise explicitly permit it」に当たると読める）
- 禁止される側の線: 資料 1・4 の「third-party developers to offer Claude.ai login into their own applications」「route requests through Free, Pro, or Max plan credentials on behalf of their users」、資料 1 の「Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf」、資料 2 の「You may not share your Account login information … make your Account available to anyone else」
- よって、次の条件をすべて守るなら許される側と読む:
  1. 利用者は自分の端末で、自分のログインで使う。1 つの定額プランで他人の依頼を処理しない（複数利用者向けのホスティングをしない）
  2. Switchboard は Claude のログイン画面を出さず、`~/.claude` の認証情報・トークンを読まない・写さない・送らない
  3. 改変していない `claude` を起動する
  4. 「Claude のログイン / 定額プランのレート上限を提供する」とうたわない。製品名や見た目に「Claude Code」を使わない（資料 4 の Branding guidelines「not appear to be Claude Code or any Anthropic product」と、資料 1 の「Using the Claude Code name and logo」）
  5. 使用量は個人の通常の範囲（資料 1 の「ordinary, individual usage」）
- 残るリスク: (a) 資料 4 の「Unless previously approved …」は、SDK / CLI の上に作った第三者の製品全般に広く読むこともできる（資料 7 がそれを和らげているが取り消してはいない）。(b) 資料 5 のとおり `--bare` が `-p` の既定になると OAuth を読まなくなる。そのときはアダプタが bare でない起動を明示する必要がある（別 Issue）。(c) 2026 年に扱いが何度か変わった。公開前と、その後も定期的に原文を見直す

### 利用者自身のクラウドの機械で動かす場合（`docs/design/cloud-hosting.md` §4）

構成: 利用者が自分の AWS アカウントに作った 1 台の機械で、利用者 1 人のために Switchboard を動かす。`claude` のログインは、その機械のターミナルで利用者が `/login` するか、利用者が取った `claude setup-token` を Parameter Store に置き、環境の層のラッパー（`scripts/host/claude-wrapper.sh`）が起動のたびに `CLAUDE_CODE_OAUTH_TOKEN` として `claude` に渡す。Switchboard のコードはトークンを読まない（`packages/core/src/nokeys.test.ts`）。

読み取り（エージェントの読み取り。法的助言ではない）:

- 資料 1 の「preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes …)」は、**他者に製品・サービスとして提供する**場合の条件と読める。利用者が自分の機械で自分のために動かすだけなら、「your products or services」には当たらないと読む。ただし Switchboard を配布し、第三者がそれを使ってホスティングを提供する場合は、その第三者にこの条件がかかる
- 資料 6 は setup-token を「CI pipelines, scripts, or other environments where interactive browser login isn't available」向けに、定額プランで認証するものとして案内している。自分の機械の起動スクリプト（ラッパー）から渡すのは、この用途の範囲と読める
- 条件 1〜5 はそのまま当てはまる。条件 1 の「自分の端末」は「自分が管理する機械（自分の AWS アカウント）」と読み替える。条件 2 は、トークンを置いて渡すのが Switchboard のコードではなく利用者の環境の層（Parameter Store とラッパー）であることで保たれる。これは資料 1 の「developers may not collect, store, or intermediate Claude.ai credentials」の対象を Switchboard の開発者と読む前提に立つ。「利用者自身の環境に置くこと」まで禁じているとは読まない
- 残るリスク: (d) トークンを置く場所が Switchboard のリポジトリにあるラッパーと IaC なので、「Switchboard が保存を仲介している」と読まれる余地がある。(e) 機械がインターネットに面する（CloudFront）ので、他人がそのログインを使えないこと（#181 の入口の認証）が条件 1 の前提になる

### 注記の文案（README と Claude アダプタ）

README「Design rules」（#24 の暫定文言をこれに差し替え済み。Task #1193、PR #1351）:

> **Your own login, on your own machine.** Switchboard holds no provider keys or runner credentials. Claude Code runs as the unmodified `claude` you installed and signed in to yourself, as a child process on your own machine, for you alone. Do not use Switchboard to serve other people through your Claude subscription; for that, use an API key (Anthropic's Legal and compliance page: https://code.claude.com/docs/en/legal-and-compliance).

`docs/design/claude-stream-json.md`（Claude アダプタの doc）の冒頭（差し替え済み。Task #1193、PR #1351）:

> Switchboard starts the user's own, unmodified `claude` and never touches its credentials. As we read Anthropic's terms, using a Claude Pro / Max login this way is allowed only for the user's own, individual use (our reading, not legal advice) — see `docs/design/license-review.md`.

### 利用者がいないときに動く機能（定期実行・自動再開・判定と評価）

構成: 利用者が登録した予定（`docs/design/scheduler.md`）、使用上限の後の自動再開（`docs/design/rate-limit-resume.md`）、Task の終わりの判定とルーブリックの評価は、利用者が画面の前にいなくても、利用者のログインのまま改変していない `claude` を起動する。中身は利用者自身の Task と利用者自身のリポジトリの作業。

読み取り（エージェントの読み取り。法的助言ではない）:

- 資料 2 の自動化の禁止は「where we otherwise explicitly permit it」を除く。資料 5・7 は `claude -p` とスクリプトからの定額プランの利用を案内しているので、利用者が自分で決めた予定で自分の作業のために起動するのは、対話の起動と同じ条件 1〜5 で読む
- 条件 5（個人の通常の範囲）が一番効く。無人の起動は回数が利用者の操作に縛られないので、使用量の窓が `backlogQuotaLimit` 以上のとき、定期実行は工程の Task をほかに動いているものが無いときだけ始め、Insights の予定は飛ばす。使用上限の後の自動再開は続けて止まった回数の上限（`maxLimitStops`）で、デーモンの中断の後の再開は `maxStopResumes` で止まる。上限を外して回し続ける設定は持たない
- 残るリスク: (f) 無人の起動の量が「ordinary, individual usage」をどこで超えるかは原文に線が無い。使用量の窓（`quota`）を見て、利用者が予定の数と頻度を決める

## Codex / DAK

未確認。#24 のスコープ外の但し書きのとおり、確かめたらここに 1 行ずつ足す。

## 対象とする利用

個人が自分で取得した認証情報を使う構成を対象とする。SaaS や他者向け提供では、認証方式と提供条件を別途検討する。
