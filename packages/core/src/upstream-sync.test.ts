// test-reads: none
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { runnerConfigOf } from "./runner-config.ts";
import { startServer, upstreamSyncPrompt, type CoreServer } from "./server.ts";

// 元の更新を取り込む (#2576): one Task in the workspace; the steps are in its prompt, not in the daemon.

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const started: StartOptions[] = [];
const ending: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    started.push(opts);
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

async function boot() {
  root = mkdtempSync(join(tmpdir(), "switchboard.upstream-sync."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  const clone = join(root, "widget");
  for (const d of [home, repoRoot, clone]) mkdirSync(d);
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [ending], { port: 0, selfdevChecks: false, dryRunRestart: true });
  const sync = async (id: string) => {
    const r = await fetch(`http://127.0.0.1:${core!.server.port}/api/workspaces/${id}/upstream-sync`, { method: "POST" });
    return { status: r.status, body: (await r.json()) as Task & { error?: string } };
  };
  return { core, sync, clone, foreign: core.db.upsertWorkspace({ name: "widget", path: clone, kind: "repo", upstream: "someone/widget" }) };
}

test("upstream sync: starts one task in the workspace with git fetch upstream in the prompt", async () => {
  const b = await boot();
  b.core.db.setRunnerConfigOk(b.foreign.id, runnerConfigOf(b.clone).hash);
  const r = await b.sync(b.foreign.id);
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.foreign.id, cwd: b.clone, title: "元の更新を取り込む: someone/widget" });
  expect(b.core.db.listTasks().length).toBe(1);
  const prompt = started.at(-1)!.prompt;
  expect(prompt).toContain(upstreamSyncPrompt("someone/widget"));
  expect(prompt).toContain("git fetch upstream");
  expect(prompt).toContain("someone/widget");
});

test("upstream sync: an unconfirmed runner config is refused with the reason", async () => {
  const b = await boot();
  const r = await b.sync(b.foreign.id);
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("widget は他者のリポジトリです");
});

test("upstream sync: 404 for a workspace without upstream", async () => {
  const b = await boot();
  const own = b.core.db.upsertWorkspace({ name: "mine", path: join(root!, "switchboard"), kind: "repo" });
  expect((await b.sync(own.id)).status).toBe(404);
  expect(b.core.db.listTasks()).toEqual([]);
});
