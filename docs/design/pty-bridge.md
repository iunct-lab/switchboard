# Spike: PTY ブリッジの方式（ターミナルタブ #16）

Issue #71。時間制限 2h。実施日 2026-09-19、Bun 1.4.2 / Node 22.17.0。試したコードは `/tmp/pty-spike`（捨てる）。
結論だけ先に:

| 候補 | 判定 | 根拠 |
|---|---|---|
| Bun + `node-pty` 1.1.0（デーモン内） | **動かない**（#3 から変化なし） | `posix_spawnp failed`。`spawn-helper` に `chmod +x` しても `onData` / `onExit` が 5 秒間一度も来ない |
| Node 22 + `node-pty` 1.1.0 を `Bun.spawn`（stdio JSON 行のブリッジ） | 動く | echo 往復 75 ms（Node の起動込み）。Node が実行時の必須依存になる |
| Bun + `bun-pty` 0.4.10（デーモン内、`bun:ffi` + Rust の portable-pty） | **動く → 採用** | echo 往復 58〜266 ms（zsh -i の起動込み）、resize、kill、親の SIGKILL 後に孤児なし、`bun build --compile` の単一バイナリでも動く |

**採用: `bun-pty` をデーモンのプロセス内で使う。** 別プロセスのブリッジは置かない。Node は実行時の依存にならないので、#16 の決定ログにあった「Node を必須依存にするか」の利用者確認は不要になった。

## 1. node-pty を Bun で（再確認）

```bash
mkdir /tmp/pty-spike && cd /tmp/pty-spike && bun init -y && bun add node-pty bun-pty
bun pty2.ts                                             # pty.spawn("/bin/zsh", ["-lc", "echo pty-ok"]) + onData / onExit、5 秒で timeout
```

```
error: posix_spawnp failed.                # そのまま
timeout; got= ""                           # spawn-helper に chmod +x した後
```

同じ `node_modules` を Node で:

```
$ node pty2.mjs
onData "pty-ok\r\n"
onExit { exitCode: 0, signal: 0 }
```

`docs/design/spike-bun-compat.md` §2 と同じ結果。Bun は 1.4.2 のままなので、変わる理由も無かった。

2026-10-17: Bun は 1.4.3 に上がったが、Linux arm64 のホストでは `node-pty` が読めず（prebuild 無し）、この確認は 1.4.3 では取れていない（`spike-bun-compat.md` §2 の同日の追記）。

## 2. Node ブリッジ（比較のため）

`bridge.mjs`（Node）: `node-pty` で `zsh -i` を開き、stdout に `{"t":"o","d":…}` を 1 行ずつ、stdin から `{"t":"i","d":…}` / `{"t":"r","c":…,"r":…}` を読む。Bun 側は `Bun.spawn(["/usr/local/bin/node", "bridge.mjs"], { stdin: "pipe", stdout: "pipe" })`。

```
$ bun bridge-host.ts
node bridge echo roundtrip ms 75
```

動くが、(a) 利用者のマシンに Node が要る、(b) `node-pty` の `spawn-helper` の実行ビットを install 後に直す必要がある、(c) 単一バイナリでは Node も `node_modules` も無いので使えない、(d) ブリッジの死活と孤児の管理が 1 段増える。`bun-pty` が動く以上、選ぶ理由が無い。

## 3. bun-pty

```ts
import { spawn } from "bun-pty";
const t = spawn("/bin/zsh", ["-i"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp" });
t.onData((d) => { out += d; });
t.write("echo pty-$((1+1))-ok; pwd\n");     // 入力のエコーと区別するため、出力にしか現れない文字列を待つ
t.resize(132, 40); t.write("stty size\n");
t.write("sleep 300 &\necho bg=$!\n");
t.kill();
```

```
$ bun bunpty.ts
echo roundtrip ms 266 cwd ok               # 2 回目以降は 58〜73 ms
resize ok: 40 132
onExit { exitCode: 0, signal: "SIGTERM" }
after kill: shell alive? false bg child alive? false
```

**親が SIGKILL されたとき**（`closeAll()` を呼ぶ暇が無い場合）: `zsh -i` の中で `sleep 300` を前景で走らせ、親の bun を `kill -9`。

```
daemon=15542 shell=15543 child=15559
after SIGKILL of parent:
(none alive)
```

PTY の master fd が親の死で閉じ、カーネルがセッションに SIGHUP を送る。サイドカー方式（`bun-compile-notes` の孤児化）と違い、間に生き残るプロセスが無い。ただし `nohup` / `disown` / `setsid` した子は利用者の意図どおり残る。

**アイドル時の負荷**: `bun-pty` の読み取りはノンブロッキング read を 8 ms 間隔でポーリングする。1 セッションを開いたままの親プロセスは `ps` で 0.3〜0.5 % CPU（5 秒で CPU 時間 0.05 s）。Task ごと 1 セッションで、利用者が開いたものだけなので許容する。

**単一バイナリ**: `bun-pty` は `require("../rust-pty/target/release/librust_pty_arm64.dylib")` を静的に解析できる形で書いており、`bun build --compile` がその 1 ファイルを埋め込む。

```
$ bun build --compile bunpty.ts --outfile bunpty-bin && cp bunpty-bin /tmp/pty-spike-elsewhere/ && cd /tmp/pty-spike-elsewhere && ./bunpty-bin
echo roundtrip ms 73 cwd ok
resize ok: 40 132
after kill: shell alive? false bg child alive? false
```

`node_modules` の無い場所に置いたバイナリで動いた。

## 4. 採用案

- **プロセス構成**: デーモン（Bun）→ `bun-pty`（FFI、同一プロセス）→ `$SHELL -i`（Task の cwd）。ブリッジのプロセスは無い。`packages/core/src/pty.ts` の `PtyManager` が Task id → セッションの Map を持つ（#72）
- **認証**: PTY はデーモンの外に口を持たない。入口は `/ws/pty?task=<id>` だけで、`/ws` と同じ `tokenFromRequest(req, true)` + `isLoopback` の規則を通す。任意コマンド実行と同じ力を持つ口なので、`/ws` より緩めない
- **デーモン終了時**: `stop()` で `closeAll()`。各セッションについて、**シェルの tty に付いている全プロセスに SIGHUP を送ってから** `kill()` する。シェルを kill するだけでは足りない環境がある: bash / zsh は背景ジョブに SIGHUP を回すが、dash（Linux の `/bin/sh`）は回さず、`sleep 300 &` がデーモンより長生きした（CI の ubuntu で `pty.test.ts` が検出、Docker で再現）。tty は `ps -o tty= -p <pid>`、対象は `ps -ax -o pid=,tty=` から拾う。`nohup` / `setsid` した子は残る。デーモンが SIGKILL されたときはカーネルの SIGHUP（前景のプロセスグループとシェル）だけになるので、dash の背景ジョブは残りうる
- **`features.pty`**: 起動時に `import("bun-pty")` し、**`/bin/sh -c "exit 0"` を 1 回 spawn できたら** true。import の成否だけでは判定できない: `bun-pty` 0.4.10 は `dlopen` の失敗を `console.error("Failed to load lib", …)` で握りつぶすので import は成功し、最初の `spawn` が `TypeError: undefined is not an object (evaluating 'lib.symbols')` で落ちる（`BUN_PTY_LIB=/dev/null bun probe.ts` で確認。ライブラリが見つからない場合は import が throw する）。どちらの失敗でも false。**単一バイナリでは true が期待値**（#16 の受け入れ条件 5 は「見つからないとき false」で、これは probe 失敗の経路として残る）
- **Windows**: `bun-pty` は `rust_pty.dll` を同梱するが未検証。#16 のスコープ外のまま

## 5. 依存を足すことについて

- ライセンス: `bun-pty` MIT、中の `portable-pty`（wezterm）MIT
- **ビルド済みネイティブを npm から受け取る**（`rust-pty/target/release/*.dylib|so|dll`、各 500 KB 前後、計 3.7 MB）。自分でビルドしたものではなく、デーモンと同じ権限で動く。`package.json` は `^` を付けず `0.4.10` に固定し、`bun.lock` の integrity で固定する。上げるときは CHANGELOG とバイナリの差分を見る
- 読み取りが 8 ms ポーリングなのは上流の実装。問題になれば上流に issue を出す（自前で fork しない）

## 6. 確認していないこと

- musl での実動作。Linux glibc（x64 の CI、arm64 の `oven/bun:1` コンテナ）では `pty.test.ts` が通る
- 埋め込まれた dylib を Bun がどこに展開して `dlopen` するか（一時ファイルが残るかどうか）
- 大量出力（`yes` など）のときのスループットとバックプレッシャ。#72 のリングバッファ 64 KB は再送用で、流量制御ではない

## 7. 実装した口（#72）

- `GET /ws/pty?task=<id>`（WebSocket）。`/ws` と同じ順に Host（ループバックのみ、#1135）→ Origin → トークン（off-loopback のみ、`?token=` 可）を見てから、`features.pty` が false なら 404、Task が無ければ 404。最初の接続が（**upgrade が成立してから**。socket にならなかったリクエストはシェルを残さない）`$SHELL -i`（無ければ `/bin/sh`）を Task の `cwd` で起動し、以後の接続は同じシェルに付く（複数の接続は同じ出力を受け取る）
- クライアント → サーバ: `{"type":"input","data":"…"}` / `{"type":"resize","cols":n,"rows":n}`（1〜1000）。それ以外は黙って捨てる。サーバ → クライアント: 最初の 1 フレームだけ `{"type":"attached","shell":"<id>"}`（そのセッションの id。メモリにだけあり、デーモンと共に消える。#1137）、以後はシェルの出力そのまま（JSON に包まない）。attached の直後に直近 64K 文字（UTF-16 単位。チャンクの大きさに関係なく末尾からちょうどその長さ）を再送する
- シェルが終わる（`exit`）と接続は 1000 "shell exited" で閉じ、次の接続が新しいシェルを起動する。Task が終わる（`onTaskEnd`: status が終端でランナーのプロセスも無い）とシェルを閉じる。同時に開けるシェルは `MAX_PTY_SESSIONS`（8）までで、超えると 429
- `GET /ws/pty?task=<id>&shell=<id>`（#1137）: その id のセッションにだけ付く。無い・別の id（シェルが終わった、Task が終わった、デーモンが再起動した）なら何も起動せず 4404 "shell gone" で閉じる。`shell` の無い接続はこれまでどおり「あれば付く、無ければ起動」
- Web の Terminal tab は、1000 と 4404 以外の切断（ネットワーク断）を `shell` 付きで自動で再接続する（500 ms から倍にして 8 s まで。`apps/web/src/terminalReconnect.ts`）。1000 と 4404 は自動では開き直さず、「開き直す」で `shell` 無しの接続（新しいシェル）を始める
- `/api/health` の `features: { pty: boolean }`（認可された呼び出しにだけ返る）

## 付録: 再現スクリプト

`/tmp/pty-spike` に置いて `bun <file>`（`pty2.mjs` は `import pty from "node-pty"` に変えて `node pty2.mjs`）。

`pty2.ts`（§1）:

```ts
import * as pty from "node-pty";
const p = pty.spawn("/bin/zsh", ["-lc", "echo pty-ok"], { cols: 80, rows: 24, cwd: process.cwd() });
let got = "";
p.onData((d) => { got += d; console.log("onData", JSON.stringify(d)); });
p.onExit((e) => { console.log("onExit", e); process.exit(0); });
setTimeout(() => { console.log("timeout; got=", JSON.stringify(got)); process.exit(1); }, 5000);
```

`bridge.mjs` / `bridge-host.ts`（§2）:

```js
import pty from "node-pty";
import { createInterface } from "node:readline";
const p = pty.spawn("/bin/zsh", ["-i"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp" });
p.onData((d) => process.stdout.write(JSON.stringify({ t: "o", d }) + "\n"));
p.onExit(() => process.exit(0));
createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); if (m.t === "i") p.write(m.d); if (m.t === "r") p.resize(m.c, m.r); });
process.stdin.on("end", () => { p.kill(); process.exit(0); });
```

```ts
const t0 = performance.now();
const c = Bun.spawn(["node", "bridge.mjs"], { stdin: "pipe", stdout: "pipe" });
c.stdin.write(JSON.stringify({ t: "i", d: "echo pty-$((1+1))-ok\n" }) + "\n");
let out = ""; const dec = new TextDecoder();
for await (const chunk of c.stdout) { out += dec.decode(chunk); if (/pty-2-ok/.test(out)) break; }
console.log("node bridge echo roundtrip ms", (performance.now() - t0).toFixed(0));
c.kill();
```

`bunpty.ts`（§3。`bun build --compile` したのもこれ）:

```ts
import { spawn } from "bun-pty";
const t0 = performance.now();
const t = spawn("/bin/zsh", ["-i"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/tmp" });
let out = "";
t.onData((d) => { out += d; });
t.onExit((e) => { console.log("onExit", e); });
const wait = (re: RegExp, ms = 4000) => new Promise<number>((res, rej) => { const s = performance.now(); const i = setInterval(() => { if (re.test(out)) { clearInterval(i); res(performance.now() - t0); } else if (performance.now() - s > ms) { clearInterval(i); rej(new Error("timeout " + re)); } }, 5); });
t.write("echo pty-$((1+1))-ok; pwd\n");
console.log("echo roundtrip ms", (await wait(/pty-2-ok/)).toFixed(0), /\/tmp/.test(out) ? "cwd ok" : "cwd ??");
t.resize(132, 40); t.write("stty size\n");
await wait(/40 132/); console.log("resize ok: 40 132");
t.write("sleep 300 &\necho bg=$!\n");
await wait(/bg=\d+/); const bg = Number(/bg=(\d+)/.exec(out)![1]);
const pid = t.pid; t.kill(); await Bun.sleep(500);
const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
console.log("after kill: shell alive?", alive(pid), "bg child alive?", alive(bg));
process.exit(0);
```

`orphan.ts`（§3 の SIGKILL）: 同じ `spawn` のあと `t.write("sleep 300\n")`、`console.log("SHELL " + t.pid + " SELF " + process.pid)`、`await Bun.sleep(600000)`。別シェルから `kill -9 <SELF>` → `ps -p <SHELL>,$(pgrep -P <SHELL> sleep)` が空。

`probe.ts`（§4 の `features.pty`）:

```ts
const m = await import("bun-pty"); console.log("import ok");
try { const t = m.spawn("/bin/sh", ["-c", "exit 0"], { name: "xterm" }); console.log("spawn ok", t.pid); t.kill(); } catch (e) { console.log("spawn threw:", String(e).split("\n")[0]); }
```

```
$ BUN_PTY_LIB=/dev/null bun probe.ts
Failed to load lib …
import ok
spawn threw: TypeError: undefined is not an object (evaluating 'lib.symbols')
```

## 8. Explicit Claude Code Teleport (#1107)

`/ws/pty?task=<id>&teleport=1` reserves a Cloud Terminal without starting a
shell or CLI. Existing Origin/auth checks are unchanged. The client sends
`{"type":"teleport.start"}` only for the explicit continuation button, once
after connection; resize/input use the existing protocol. The server uses
the saved Task's Cloud reference and cwd, never client-supplied targets.
Public `--help` determines target argv or the official picker. No private
API, interactive setup answers, authentication repair or automatic retry is
added.

A Teleport survives socket disconnects and replays a bounded 64K-character
tail. Output evidence is bounded and control-stripped; raw PTY output is not
saved in the database. After process exit the PTY is released immediately,
so later writes, resizes and shutdown cannot signal a reused PID. The
Terminal stays counted as active while the asynchronous history import
finishes, then sends its result to all connected clients before closing.
Throw/rejection produces an unconfirmed result, and one failed client cannot
prevent the others from closing.

`close`/`closeAll` release an import-waiting Terminal without touching a
dead process. No timer releases the cwd guard while history may still be
imported: that would allow a concurrent resume. The production callback
awaits bounded local slices and event-loop yields, not network I/O. A daemon
shutdown during import is unconfirmed; inspect saved history and Git before
any new explicit action. The core guard forbids follow-up/resume of Local
Claude Tasks in the continuation's worktree (#1395) until the result
callback's `finally` releases it; Tasks in the clone itself carry on. New
Task creation and unrelated external terminals are not locked.
