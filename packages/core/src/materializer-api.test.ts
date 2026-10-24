import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Isolate the mocked homedir in a child test process: user-level writes must never touch the developer's home.
test("materializer API rejects broken JSON, supports global export and reserves workspace export for cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-materializer-api-"));
  const fixture = join(root, "api.test.ts");
  writeFileSync(fixture, String.raw`
import { expect, mock, test } from "bun:test";
import * as os from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = process.env.MATERIALIZER_TEST_ROOT!;
const user = join(root, "user");
mkdirSync(user, { recursive: true });
mock.module("node:os", () => ({ ...os, homedir: () => user }));
const code = process.env.MATERIALIZER_CODE_ROOT!;
const { loadConfig } = await import(join(code, "packages/core/src/config.ts"));
const { startServer } = await import(join(code, "packages/core/src/server.ts"));
test("API materialization", async () => {
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(root, "data"), SWITCHBOARD_KNOWLEDGE: join(root, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(root, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true });
  const base = "http://127.0.0.1:" + core.server.port;
  try {
    core.knowledge.write("rules/common.md", "---\ntargets: [claude, codex]\n---\ncommon\n");
    core.knowledge.write("rules/scoped.md", "---\nrepo: /example/repo\ntargets: [claude]\n---\nscoped\n");
    const post = (body: string) => fetch(base + "/api/materialize/apply", { method: "POST", headers: { "content-type": "application/json" }, body });
    for (const body of ["", "{", "{\"paths\":"]) expect((await post(body)).status).toBe(400);
    expect(existsSync(join(user, ".claude", "CLAUDE.md"))).toBe(false);
    expect((await post('{"workspaceId":""}')).status).toBe(400);
    expect((await post('{"workspaceId":"missing"}')).status).toBe(404);
    const preview = await (await fetch(base + "/api/materialize/preview")).json();
    expect(preview.warnings.some((w: any) => w.path === "rules/scoped.md")).toBe(true);
    expect(preview.files.map((f: any) => f.abs)).toEqual([join(user, ".claude", "CLAUDE.md"), join(user, ".codex", "AGENTS.md")]);
    expect((await post('{}')).status).toBe(200);
    expect(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8")).toContain("common");
    expect(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8")).not.toContain("scoped");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const handwritten = "# handwritten\n";
    writeFileSync(join(repo, "CLAUDE.md"), handwritten + readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8"));
    const ws = await (await fetch(base + "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: repo }) })).json();
    const cleanup = await (await fetch(base + "/api/materialize/preview?workspaceId=" + ws.id)).json();
    expect(cleanup.files[0].next).toBe(handwritten);
    expect(cleanup.files[0].sources).toEqual([]);
    expect((await post(JSON.stringify({ workspaceId: ws.id }))).status).toBe(200);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(handwritten);
    expect((await fetch(base + "/api/materialize/preview?workspaceId=missing")).status).toBe(404);
  } finally { await core.stop(); }
});
`);
  try {
    const child = Bun.spawn(["bun", "test", fixture], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, MATERIALIZER_TEST_ROOT: root, MATERIALIZER_CODE_ROOT: resolve(import.meta.dir, "../../..") },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, failure: exit === 0 ? "" : out + err }).toEqual({ exit: 0, failure: "" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
