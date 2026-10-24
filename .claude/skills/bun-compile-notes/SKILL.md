---
name: bun-compile-notes
description: bun build --compile で作った単一バイナリの実測挙動（仮想 FS のパス、--asset の埋め込み先、process.argv/execPath、サイドカーの孤児化）。単一バイナリでの配布をもう一度考えるときに読む（採らなかった。#49。名指しする関数とスクリプトは main に無い）。Linux のみ検証済み。
---

# bun build --compile の実測（Bun 1.4.2 で測定, Linux CI。1.4.3 では測り直していない）

> 前提: 単一バイナリの配布は採らなかった（#49 は閉じた）。ここで名指しする `isCompiled` / `configDefaultsDir` / `restartArgv = [execPath]` /
> `SWITCHBOARD_WATCH_PARENT_PID` / `scripts/build-binary.ts` / `binary.test.ts` / `build:binary` はその PR にだけあり、main には無い
> （main の `restartArgv` は `[execPath, ...execArgv, ...argv.slice(1)]`）。ここは `bun build --compile` の実測の記録として残す。

- 全モジュールの `import.meta.dir` は `/$bunfs/root` に潰れる（エントリだけでなく全部）。元のファイル位置は失われる。
  → `isCompiled(dir) = dir.startsWith("/$bunfs/")`（`config.ts`）。**Windows は未検証で、実際に一致しなかった**
  （CI で `repoRoot` が `B:\` になった）。Windows は対象外。
- `--asset=<dir>` は **dir の basename 直下**に埋め込む。`--asset=apps/web/dist` → `/$bunfs/root/dist`、
  `--asset=packages/core/config` → `/$bunfs/root/config`。与えた相対パス全体は保存されない。
  → `config.ts` の `webDist` / `configDefaultsDir` はこの名前に依存。ディレクトリ名を変えたら両方直す。
- `process.argv` は `["bun", "/$bunfs/root/<name>"]`（仮想パス、再実行に使えない）。`process.execArgv` は `[]`。
  `process.execPath` が実ファイルの絶対パス。再起動コマンドは `[process.execPath]` だけ（`selfdev.ts restartArgv`）。
- `existsSync` / `readFileSync` / `readdirSync` は `/$bunfs/...` に対して動く（node:fs がパッチされている）。
- `findRepoRoot` の「3 つ上」フォールバックはコンパイル済みだと `/` を返し、**meta workspace = ルート FS** になる
  （Workspace MCP のスコープがファイルシステム全体になる）。コンパイル時は `repoRoot = null` にして meta を登録しない。
- サイドカーとして親プロセスから起動した場合、親が SIGKILL されると子は孤児として残りポートを掴み続ける。
  `SWITCHBOARD_WATCH_PARENT_PID` を渡すと 2 秒ごとに `process.kill(pid, 0)` で親を確認して自終了する（opt-in。単独起動では付けない）。

## 確認コマンド

```bash
B=$(mktemp -d /tmp/switchboard.binary.XXXXXX); echo "$B"     # 固定の /tmp/sb にしない
bun run build:binary "$B/sb"            # vite build → bun build --compile（scripts/build-binary.ts）
SWITCHBOARD_HOME=$(mktemp -d) SWITCHBOARD_PORT=48123 "$B/sb" &   # /api/health の repoRoot が null、/ が 200
SWITCHBOARD_TEST_BINARY=1 bun test packages/core/src/binary.test.ts   # opt-in の E2E（既定ではスキップ）
```
