# Workspace MCP — the daemon as an MCP server

Added 2026-09-06 (skeleton) and 2026-09-05 (tokens). Proposal §3 "Workspace MCP". Runners that have no file tools of their own (DAK in a container) — or Claude Code / Codex pointed at it with `--mcp-config` — reach the local repository **through Switchboard's guards**, and every call lands on the task transcript.

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

**Exec policy** (`packages/core/config/mcp.yaml`, user copy at `~/.switchboard/mcp.yaml`; a user copy replaces the shipped lists key by key, so compare it after an update: a copy made before 2026-10-18 keeps the older, looser `denyFlags`). A command runs immediately only if *all* hold: it parses as one argv with no shell syntax at all (`` ; | & < > $ \` ( ) { } `` or a newline anywhere → approval), argv[0] is a name rather than a path, resolving on the absolute `PATH` entries to a program outside the task scope (empty and relative entries are ignored; a program found inside the task scope asks instead), and its binary is in `exec.readOnly` (not `jq`: its `import … {search: "<dir>"}` reads any JSON file; not `date`: it can set the clock; 2026-10-19; git looks for a repository only inside the scope: `GIT_CEILING_DIRECTORIES` is the folder above each root, so a scope that is a subfolder of a repository, or a folder inside a home-folder dotfiles repository, has none, and its read-only git commands fail instead of reading the rest through `git show HEAD:<path>` or `git diff`; `GIT_CEILING_DIRECTORIES` splits on `:`, so when a folder above a root has one in its name, git commands in that scope ask instead; a `.git` file inside the scope (a linked worktree, a submodule) points git to a gitdir outside the scope, and read-only git reads that repository's objects and refs) (for `git`, the first argument is the subcommand, in `exec.gitReadOnly`: a global option before it could take the next word as its value; 2026-10-19), no argument is in `exec.denyFlags[<binary>]`, a single-letter one also inside bundled short options such as `sort -uo`, a long one also as an abbreviation such as `sort --outp` (`find -exec/-delete`, `rg --pre/--pre-glob`, `sort -o/--compress-program`, `tree -o`, `file -C/--compile/-m/--magic-file`, `git --output/--help/--show-signature`, the options that read a list of file names from a file: `sort`/`wc`/`du --files0-from`, `find -files0-from`, `file -f/--files-from`, the recursion that follows symlinks: `grep -R`, `rg -L`, `find -L/-follow`, `ls -L`, `du -L`, `tree -l`, `diff -r`, and the ones that run a program or write: `rg --hostname-bin`, `rg -z`, `file -z`, `tree -R`, `sort -T`, `git --help` (it opens `man`), `git --show-signature` and a `%G` format (they start `gpg`), `diff -l` (it runs `pr`), BSD `grep -S`, …; `diff` with a directory operand asks too, since it compares the files inside through their symlinks), no output operand for `uniq`, no `FOO=bar` prefix, and every path-looking argument (absolute, `~`, `..`) resolves inside the task scope, a relative one from the command's working directory (`exec.run`'s `cwd`, not the scope's first root; 2026-10-19), and one with `..` also in the order the OS opens it, a symlink before the `..` after it (`path.resolve` and Bun's realpath drop `link/..` by spelling; 2026-10-19) (so `cat ~/.switchboard/token` is not read-only) — a path riding in an option counts too (the value of `--from-file=<path>`; in a word of short options such as `-f<path>` every tail after the first letter, since which letter takes a value is not known per binary; 2026-10-19), and every argument is also resolved as a whole word: `--` is not trusted to end the options (`diff -I --` takes it as the value of `-I`), and after a real `--` an option-looking word names a file, so it must pass both ways (a denied flag after `--` still asks). It is then spawned **without a shell** (the inspected argv with argv[0] resolved on the absolute entries of the minimal environment’s PATH, no glob expansion) with a minimal environment (`PATH` with its absolute entries only, `HOME PWD TERM LANG`, `LC_ALL` when set, a `TMPDIR` that does not exist, so a tool such as `sort` cannot spill temporary files, and `GIT_OPTIONAL_LOCKS=0`, so `git status` does not rewrite the index (`git diff` and `git describe --dirty` may still refresh it, inside the repository), and `GIT_NO_LAZY_FETCH=1`, so a partial clone does not fetch; 2026-10-19. Not covered, by choice: `rg` reads ignore files above the scope to decide what to skip, git reads the user's global excludes file (`core.excludesFile`), `file` reads `~/.magic`, and `find -xtype` tells whether a link's target exists — what to skip or how to label, metadata, not content), output capped at `maxOutputBytes` per stream (the process is killed once the cap is hit) and killed after `timeoutMs`. Each run leads its own process group (`detached`); its whole group is killed on the cap, on `timeoutMs`, and when the task ends (`revoke`), so what the command left behind does not outlive it. `env`, `sed`, `awk`, `xargs` are deliberately not in the list. Everything else raises `permission.ask` with the reason (`sort -o x can write, execute or read outside the scope`) and, once the user allows it, runs through `/bin/sh -c` with the daemon's environment minus `SWITCHBOARD_*` / Claude session markers. A task without a live runner, or one that ends while an ask is open, resolves **deny**. Nothing auto-allows; rule-based auto-allow (since 2026-09-06) goes through the same `askPermission` seam.

`fs.grep` refuses patterns with nested quantifiers (`(a+)+`) and over 200 chars, skips files over `maxGrepFileBytes`, stops after `maxGrepFiles` / `maxGrepMatches`, and yields to the event loop between files. `fs.read` never loads more than 4× `maxReadBytes`.

## Staged writes (2026-09-06)

`fs.write` / `fs.patch` store the proposed content together with the file's content at staging time (`staging` table). The Brief lists pending changes with a unified diff; **`適用`** writes the file (after re-checking the task scope and that the file did not change in the meantime → 409 `file changed since it was staged`), **`却下`** marks it rejected. The agent gets `{staged, status: "pending"}` back and is told the file is unchanged until the user decides — so a runner that expects its write to have happened must read the file again or wait. This is what makes unattended DAK runs safe to leave overnight: the morning is a review of diffs, not an audit of what already happened.

`POST /api/tasks/:id/mcp/rotate` revokes the current token and issues a new one, for when a URL was handed to a container that should not keep it.

## Local API token (2026-09-05)

- `~/.switchboard/token` is created at first boot (0600). `/api/health` reports `authRequired`.
- On loopback (`127.0.0.1`, default) the token is **not** enforced on `/api` and `/ws` — same trust boundary as before.
- On loopback every route (health, the static UI, `/api`, `/ws`, `/ws/pty`, `/mcp`, the GitHub webhook) answers 403 `host not allowed` unless the `Host` header's name is `localhost` / `127.0.0.1` / `[::1]` or `SWITCHBOARD_PUBLIC_URL`'s host name; the port is not compared. DNS rebinding defence (2026-10-12): a page on a name that resolves to 127.0.0.1 sends matching `Origin` and `Host`. Off loopback the token guards and the `Host` is not checked.
- Off loopback (`SWITCHBOARD_HOST=0.0.0.0`) every `/api/*` route except health, and `/ws`, require the token: `Authorization: Bearer <token>` for `/api` (the query form is refused there so the token stays out of history and logs), `?token=` accepted only on `/ws` and `/mcp`. Health then reveals only `authRequired`. The web UI asks for the token once and keeps it in `localStorage`.
- Browser cross-site defence on every interface: a request carrying an `Origin` that is not the daemon's own is refused (403) on `/api` and `/ws`. The Vite dev server proxies both, so it stays same-origin.
- `/mcp/<taskId>` always requires its per-task token, on any interface.

## Trying it

```bash
# claude code as an MCP client of its own task (Brief → Workspace MCP → エンドポイントを発行)
claude --mcp-config '{"mcpServers":{"switchboard":{"type":"http","url":"http://127.0.0.1:47831/mcp/<taskId>","headers":{"Authorization":"Bearer <token>"}}}}'
```

Tests (`packages/core/src/mcp.test.ts`) drive the real endpoint with the SDK client: token rejection, scope escapes (incl. symlink), read-only exec, deny → error, allow → runs, revocation at task end, off-loopback API auth.

## The MCP given to a Task (2026-10-20)

A Claude Task's `claude -p` is always started with `--strict-mcp-config --mcp-config '{"mcpServers":{…}}'` (`buildArgs` in `packages/adapters/claude/src/index.ts`). It reads only the MCP servers Switchboard passes: neither the user-wide `mcpServers` in `~/.claude.json` nor the project's `.mcp.json`. The reason: with playwright (`@playwright/mcp` + headless Chromium) registered user-wide, one set (200 to 300 MB) was started for every `claude -p`, even in Tasks that did not use it. The `claude -p` calls that go through `buildArgs` for judging and for choosing a Workspace automatically are the same.

How to add one: `servers` in `~/.switchboard/mcp.yaml` (the bundled `packages/core/config/mcp.yaml` passes nothing; an example is in its comments):

```yaml
servers:
  playwright:                 # Claude Code の mcpServers の 1 件と同じ形（stdio: command / args / env、http・sse: type / url / headers）
    command: npx
    args: ["@playwright/mcp@latest", "--headless"]
    workspaces: [switchboard] # Workspace の名前。この Workspace の Task にだけ渡す。無ければどの Task にも渡す
```

- `workspaces` is matched against Workspace names. Every Workspace with that name gets the server, and after a rename it is no longer passed from the next start. A Task with no Workspace does not get a server that has `workspaces`
- An entry of the wrong shape (a `name:` with no body, a `workspaces` that is not a list) is skipped unread and its name is written to the daemon's log at startup (the other entries and the Task's start are not stopped)
- `mcp.yaml` is read once at startup. After editing it, restart the daemon; it takes effect from the next `claude -p` that starts (the Brief is computed from the current setting, so the Brief of a Task started before the restart also shows the new list)
- `--mcp-config` is passed as a JSON argument, so the `env` / `headers` values are visible in `ps` on the same host. Put secrets in environment variables or files that the MCP server itself reads
- Not passed to Codex / DAK / Cloud Tasks (Codex's MCP is a separate mechanism; Cloud does not go through `buildArgs`). Workspace MCP (`/mcp/<taskId>` above) is not passed automatically
- The Brief on the Task screen shows the names passed to that Task (`なし` when there are none) under `渡す MCP` in its `Workspace MCP` section. The contents are `mcpServers` in `GET /api/tasks/:id`

## Not yet

- Staged writes (`fs.write` / `fs.patch` into a review queue) and one-shot endpoints per DAK run: tracked on 2026-09-06.
- Rule-based auto-allow from Knowledge `approval:` frontmatter: tracked on 2026-09-06.

## Reporting a stop (2026-10-14)

A stop can be reported with the `stop` argument (`StopReport`) of `task.note`. A transient failure of `exec.run` is retried by the agent itself, and that record also stays in `stop.record`.
