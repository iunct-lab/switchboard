# Workspace MCP — the daemon as an MCP server

Issue #10 (skeleton) and #31 (tokens). Proposal §3 "Workspace MCP". Runners that have no file tools of their own (DAK in a container) — or Claude Code / Codex pointed at it with `--mcp-config` — reach the local repository **through Switchboard's guards**, and every call lands on the task transcript.

## Endpoint

```
GET  /api/tasks/:id/mcp          → { url: "http://127.0.0.1:47831/mcp/<taskId>", token: "mcp_…" }   (local API)
POST /mcp/<taskId>?token=<token>  or  Authorization: Bearer <token>                                (MCP streamable HTTP)
```

- One endpoint per task, one **disposable token** per task (constant-time compared). Issued on demand while the task is running; revoked (401) once the task is over for good — terminal status *and* its runner process gone (exited, released after the idle window, aborted) — and at daemon shutdown. A follow-up on a "done" task whose process still lingers keeps using it.
- One `McpServer` + `WebStandardStreamableHTTPServerTransport` **per MCP session** (`mcp-session-id`); the endpoint keeps a `Map<sessionId, {server, transport, lastSeen}>`. A session is only created by an `initialize` request (anything else without a session id is 400), at most `sessions.maxPerTask` (429), and expires after `sessions.idleMs` idle.
- `SWITCHBOARD_PUBLIC_URL` sets the base URL handed out (e.g. `http://host.docker.internal:47831` for DAK). The daemon still listens where `SWITCHBOARD_HOST` says; see "Local API token".

## Tools

| tool | guard | recorded as |
|---|---|---|
| `fs.list {path}` | scope | `tool.call(fs.list)` / `tool.result` |
| `fs.read {path, offset?, limit?}` | scope, `fs.maxReadBytes` | same. Text (and JSON, YAML, SVG) comes back as text; a raster image as an MCP `image` content (`data` base64 + `mimeType`); another known binary (PDF) as a `resource` with a `blob`. A non-text file over 4 × `fs.maxReadBytes` is refused whole (half an image is no image). The transcript shows `<mime>, <n> bytes`, not the bytes. A client that passes the result on as JSON text (ADK) does not show the model an image |
| `fs.grep {pattern, path?, glob?}` | scope, skips `.git` / `node_modules` / binary, `fs.maxGrepMatches` | same |
| `exec.run {command, cwd?}` | scope for `cwd`; **read-only commands run at once, everything else raises `permission.ask` and waits** | `tool.call(exec.run)`, `permission.ask` / `permission.resolved(by: user)`, `tool.result` |
| `fs.write {path, content}` | scope; **staged**, never written directly | `tool.call(fs.write)`, `artifact(diff)`; on apply `artifact(file)` |
| `fs.patch {path, find, replace}` | scope; `find` must be unique in the file; **staged** | same |
| `task.note {text}` | — | `message.delta(assistant)` |

**Scope containment**: every path is resolved against the task's scope roots after `realpath` (symlinks resolved on the deepest existing ancestor), then prefix-checked. A symlink inside the repo that points outside is rejected; so is an absolute path outside, or `..` climbing out.

**Exec policy** (`packages/core/config/mcp.yaml`, user copy at `~/.switchboard/mcp.yaml`; a user copy replaces the shipped lists key by key, so compare it after an update: a copy made before #1942 keeps the older, looser `denyFlags`). A command runs immediately only if *all* hold: it parses as one argv with no shell syntax at all (`; | & < > $ \` ( ) { }` or a newline anywhere → approval), argv[0] is a name rather than a path, resolving on the absolute `PATH` entries to a program outside the task scope (empty and relative entries are ignored; a program found inside the task scope asks instead), and its binary is in `exec.readOnly` (not `jq`: its `import … {search: "<dir>"}` reads any JSON file; not `date`: it can set the clock; #2031; git looks for a repository only inside the scope: `GIT_CEILING_DIRECTORIES` is the folder above each root, so a scope that is a subfolder of a repository, or a folder inside a home-folder dotfiles repository, has none, and its read-only git commands fail instead of reading the rest through `git show HEAD:<path>` or `git diff`; `GIT_CEILING_DIRECTORIES` splits on `:`, so when a folder above a root has one in its name, git commands in that scope ask instead; a `.git` file inside the scope (a linked worktree, a submodule) points git to a gitdir outside the scope, and read-only git reads that repository's objects and refs) (for `git`, the first argument is the subcommand, in `exec.gitReadOnly`: a global option before it could take the next word as its value; #2031), no argument is in `exec.denyFlags[<binary>]`, a single-letter one also inside bundled short options such as `sort -uo`, a long one also as an abbreviation such as `sort --outp` (`find -exec/-delete`, `rg --pre/--pre-glob`, `sort -o/--compress-program`, `tree -o`, `file -C/--compile/-m/--magic-file`, `git --output/--help/--show-signature`, the options that read a list of file names from a file: `sort`/`wc`/`du --files0-from`, `find -files0-from`, `file -f/--files-from`, the recursion that follows symlinks: `grep -R`, `rg -L`, `find -L/-follow`, `ls -L`, `du -L`, `tree -l`, `diff -r`, and the ones that run a program or write: `rg --hostname-bin`, `rg -z`, `file -z`, `tree -R`, `sort -T`, `git --help` (it opens `man`), `git --show-signature` and a `%G` format (they start `gpg`), `diff -l` (it runs `pr`), BSD `grep -S`, …; `diff` with a directory operand asks too, since it compares the files inside through their symlinks), no output operand for `uniq`, no `FOO=bar` prefix, and every path-looking argument (absolute, `~`, `..`) resolves inside the task scope, a relative one from the command's working directory (`exec.run`'s `cwd`, not the scope's first root; #2024), and one with `..` also in the order the OS opens it, a symlink before the `..` after it (`path.resolve` and Bun's realpath drop `link/..` by spelling; #2031) (so `cat ~/.switchboard/token` is not read-only) — a path riding in an option counts too (the value of `--from-file=<path>`; in a word of short options such as `-f<path>` every tail after the first letter, since which letter takes a value is not known per binary; #2021), and every argument is also resolved as a whole word: `--` is not trusted to end the options (`diff -I --` takes it as the value of `-I`), and after a real `--` an option-looking word names a file, so it must pass both ways (a denied flag after `--` still asks). It is then spawned **without a shell** (the inspected argv with argv[0] resolved on the absolute entries of the minimal environment’s PATH, no glob expansion) with a minimal environment (`PATH` with its absolute entries only, `HOME PWD TERM LANG`, `LC_ALL` when set, a `TMPDIR` that does not exist, so a tool such as `sort` cannot spill temporary files, and `GIT_OPTIONAL_LOCKS=0`, so `git status` does not rewrite the index (`git diff` and `git describe --dirty` may still refresh it, inside the repository), and `GIT_NO_LAZY_FETCH=1`, so a partial clone does not fetch; #2031. Not covered, by choice: `rg` reads ignore files above the scope to decide what to skip, git reads the user's global excludes file (`core.excludesFile`), `file` reads `~/.magic`, and `find -xtype` tells whether a link's target exists — what to skip or how to label, metadata, not content), output capped at `maxOutputBytes` per stream (the process is killed once the cap is hit) and killed after `timeoutMs`. Each run leads its own process group (`detached`); its whole group is killed on the cap, on `timeoutMs`, and when the task ends (`revoke`), so what the command left behind does not outlive it. `env`, `sed`, `awk`, `xargs` are deliberately not in the list. Everything else raises `permission.ask` with the reason (`sort -o x can write, execute or read outside the scope`) and, once the user allows it, runs through `/bin/sh -c` with the daemon's environment minus `SWITCHBOARD_*` / Claude session markers. A task without a live runner, or one that ends while an ask is open, resolves **deny**. Nothing auto-allows; rule-based auto-allow (#13) goes through the same `askPermission` seam.

`fs.grep` refuses patterns with nested quantifiers (`(a+)+`) and over 200 chars, skips files over `maxGrepFileBytes`, stops after `maxGrepFiles` / `maxGrepMatches`, and yields to the event loop between files. `fs.read` never loads more than 4× `maxReadBytes`.

## Staged writes (#11)

`fs.write` / `fs.patch` store the proposed content together with the file's content at staging time (`staging` table). The Brief lists pending changes with a unified diff; **適用** writes the file (after re-checking the task scope and that the file did not change in the meantime → 409 `file changed since it was staged`), **却下** marks it rejected. The agent gets `{staged, status: "pending"}` back and is told the file is unchanged until the user decides — so a runner that expects its write to have happened must read the file again or wait. This is what makes unattended DAK runs safe to leave overnight: the morning is a review of diffs, not an audit of what already happened.

`POST /api/tasks/:id/mcp/rotate` revokes the current token and issues a new one, for when a URL was handed to a container that should not keep it.

## Local API token (#31)

- `~/.switchboard/token` is created at first boot (0600). `/api/health` reports `authRequired`.
- On loopback (`127.0.0.1`, default) the token is **not** enforced on `/api` and `/ws` — same trust boundary as before.
- On loopback every route (health, the static UI, `/api`, `/ws`, `/ws/pty`, `/mcp`, the GitHub webhook) answers 403 `host not allowed` unless the `Host` header's name is `localhost` / `127.0.0.1` / `[::1]` or `SWITCHBOARD_PUBLIC_URL`'s host name; the port is not compared. DNS rebinding defence (#1135): a page on a name that resolves to 127.0.0.1 sends matching `Origin` and `Host`. Off loopback the token guards and the `Host` is not checked.
- Off loopback (`SWITCHBOARD_HOST=0.0.0.0`) every `/api/*` route except health, and `/ws`, require the token: `Authorization: Bearer <token>` for `/api` (the query form is refused there so the token stays out of history and logs), `?token=` accepted only on `/ws` and `/mcp`. Health then reveals only `authRequired`. The web UI asks for the token once and keeps it in `localStorage`.
- Browser cross-site defence on every interface: a request carrying an `Origin` that is not the daemon's own is refused (403) on `/api` and `/ws`. The Vite dev server proxies both, so it stays same-origin.
- `/mcp/<taskId>` always requires its per-task token, on any interface.

## Trying it

```bash
# claude code as an MCP client of its own task (Brief → Workspace MCP → エンドポイントを発行)
claude --mcp-config '{"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:47831/mcp/<taskId>","headers":{"Authorization":"Bearer <token>"}}}}'
```

Tests (`packages/core/src/mcp.test.ts`) drive the real endpoint with the SDK client: token rejection, scope escapes (incl. symlink), read-only exec, deny → error, allow → runs, revocation at task end, off-loopback API auth.

## Task に渡す MCP（#2090）

Claude の Task の `claude -p` は、いつも `--strict-mcp-config --mcp-config '{"mcpServers":{…}}'` で起動する（`packages/adapters/claude/src/index.ts` の `buildArgs`）。読むのは Switchboard が渡した MCP だけで、ユーザー全体の `~/.claude.json` の `mcpServers` も、プロジェクトの `.mcp.json` も読まない。ユーザー全体に playwright（`@playwright/mcp` + headless Chromium）を登録していると、使わない Task でも `claude -p` ごとに 1 組（200〜300 MB）立っていたため。`buildArgs` を通る判定・Workspace の自動選択の `claude -p` も同じ。

載せ方は `~/.switchboard/mcp.yaml` の `servers`（同梱の `packages/core/config/mcp.yaml` は何も渡さない。コメントに例）:

```yaml
servers:
  playwright:                 # Claude Code の mcpServers の 1 件と同じ形（stdio: command / args / env、http・sse: type / url / headers）
    command: npx
    args: ["@playwright/mcp@latest", "--headless"]
    workspaces: [switchboard] # Workspace の名前。この Workspace の Task にだけ渡す。無ければどの Task にも渡す
```

- `workspaces` は Workspace の名前で照らす。同じ名前の Workspace はどれにも渡り、名前を変えたら次の起動から渡らない。Workspace の無い Task には `workspaces` 付きの server は渡らない
- 形の違う entry（中身の無い `name:`、リストでない `workspaces`）は読まずに飛ばし、起動時にその名前をデーモンのログに出す（ほかの entry と Task の起動は止めない）
- `mcp.yaml` は起動時に 1 回読む。書き換えたらデーモンを再起動し、次に起動する `claude -p` から変わる（Brief は今の設定から求めるので、再起動前に起動した Task の Brief も新しい一覧を出す）
- `--mcp-config` は JSON の引数で渡すので、`env` / `headers` の値は同じホストの `ps` で見える。秘密は MCP 側が読む環境変数やファイルに置く
- Codex / DAK / Cloud の Task には渡さない（Codex の MCP は別の仕組み。Cloud は `buildArgs` を通らない）。Workspace MCP（上の `/mcp/<taskId>`）は自動では渡さない
- Task 画面の Brief の「Workspace MCP」の節の「渡す MCP」に、その Task に渡す名前（無ければ「なし」）が出る。中身は `GET /api/tasks/:id` の `mcpServers`

## Not yet

- Staged writes (`fs.write` / `fs.patch` into a review queue) and one-shot endpoints per DAK run: #11.
- Rule-based auto-allow from Knowledge `approval:` frontmatter: #13.

## 停止の報告（#939）

`task.note` の引数 `stop`（`StopReport`）で停止を報告できる。`exec.run` の一時失敗は自分で再試行し、その記録も `stop.record` に残る。ランナー自身の再実行の責務と対象は `repeated-stops.md`。
