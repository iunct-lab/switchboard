import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, Workspace, WorkspaceRemoval } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

// Removing a registration and, when asked, the local copy (#2600).

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const holding: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start() {
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

async function boot() {
  root = mkdtempSync(join(tmpdir(), "switchboard.remove-api."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  mkdirSync(home);
  mkdirSync(repoRoot);
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [holding], { port: 0, selfdevChecks: false, dryRunRestart: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const checkout = async (name: string, backlog: "github" | "switchboard" = "switchboard") => {
    const path = join(root!, name);
    mkdirSync(path);
    sh(path, "init", "-q");
    sh(path, "commit", "-q", "--allow-empty", "-m", "one");
    const r = await send("POST", "/api/workspaces", { path, backlog });
    expect(r.status).toBe(201);
    return r.body as Workspace;
  };
  const list = async () => (await send("GET", "/api/workspaces")).body as Workspace[];
  return { send, checkout, list, base, home };
}

test("DELETE removes the registration and tells open screens; the same path registers again", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  const socket = new WebSocket(`${t.base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  socket.onmessage = (m) => seen.push(JSON.parse(String(m.data)).type);
  await new Promise((r) => (socket.onopen = r));
  const r = await t.send("DELETE", `/api/workspaces/${ws.id}`, { deleteCopy: false });
  expect(r.status).toBe(200);
  expect((await t.list()).some((w) => w.id === ws.id)).toBe(false);
  expect(existsSync(ws.path)).toBe(true);
  for (let i = 0; i < 100 && !seen.includes("workspaces.updated"); i++) await Bun.sleep(20);
  expect(seen).toContain("workspaces.updated");
  socket.close();
  expect((await t.send("DELETE", `/api/workspaces/${ws.id}`)).status).toBe(404);
  const again = await t.send("POST", "/api/workspaces", { path: ws.path, backlog: "switchboard" });
  expect(again.status).toBe(201);
}, 30_000);

test("deleteCopy deletes the checkout directory", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  expect((await t.send("DELETE", `/api/workspaces/${ws.id}`, { deleteCopy: true })).status).toBe(200);
  expect(existsSync(ws.path)).toBe(false);
}, 30_000);

test("deleteCopy refuses meta (the checkout itself is one), a link out and a non-Git directory; nothing is removed", async () => {
  const t = await boot();
  const meta = (await t.list()).find((w) => w.kind === "meta")!;
  expect((await t.send("DELETE", `/api/workspaces/${meta.id}`, { deleteCopy: true })).status).toBe(400);
  const outside = mkdtempSync(join(tmpdir(), "switchboard.outside."));
  try {
    mkdirSync(join(outside, "x"));
    sh(join(outside, "x"), "init", "-q");
    symlinkSync(join(outside, "x"), join(root!, "link"));
    const link = (await t.send("POST", "/api/workspaces", { path: join(root!, "link"), backlog: "switchboard" })).body as Workspace;
    expect((await t.send("DELETE", `/api/workspaces/${link.id}`, { deleteCopy: true })).status).toBe(400);
    expect(existsSync(join(outside, "x"))).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  mkdirSync(join(root!, "plain"));
  const plain = (await t.send("POST", "/api/workspaces", { path: join(root!, "plain"), backlog: "switchboard" })).body as Workspace;
  expect((await t.send("DELETE", `/api/workspaces/${plain.id}`, { deleteCopy: true })).status).toBe(409);
  expect(existsSync(join(root!, "plain"))).toBe(true);
  expect((await t.list()).filter((w) => [plain.id].includes(w.id))).toHaveLength(1);
}, 30_000);

test("a running Task refuses (409); once it is aborted the registration goes and the history stays readable", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  const task = (await t.send("POST", "/api/tasks", { workspaceId: ws.id, cwd: ws.path, title: "t", prompt: "p", runner: "claude" })).body as { id: string };
  const r = await t.send("DELETE", `/api/workspaces/${ws.id}`);
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("1 件");
  expect((await t.send("GET", `/api/workspaces/${ws.id}/removal`)).body.running).toBe(1);
  expect((await t.list()).some((w) => w.id === ws.id)).toBe(true);
  await t.send("POST", `/api/tasks/${task.id}/abort`);
  for (let i = 0; i < 100; i++) {
    if ((await t.send("GET", `/api/workspaces/${ws.id}/removal`)).body.running === 0) break;
    await Bun.sleep(20);
  }
  expect((await t.send("DELETE", `/api/workspaces/${ws.id}`)).status).toBe(200);
  expect((await t.send("GET", `/api/tasks/${task.id}`)).status).toBe(200);
}, 30_000);

test("a Task working inside the directory refuses even under another workspace id", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  mkdirSync(join(ws.path, "wt"));
  await t.send("POST", "/api/tasks", { cwd: join(ws.path, "wt"), title: "t", prompt: "p", runner: "claude" });
  expect((await t.send("DELETE", `/api/workspaces/${ws.id}`, { deleteCopy: true })).status).toBe(409);
  expect(existsSync(ws.path)).toBe(true);
}, 30_000);

test("a schedule that names the workspace refuses (409)", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  const s = await t.send("POST", "/api/schedules", { title: "毎日", cron: "0 9 * * *", workspaceId: ws.id, runner: "claude", prompt: "x" });
  expect(s.status).toBeLessThan(300);
  const r = await t.send("DELETE", `/api/workspaces/${ws.id}`);
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("毎日");
}, 30_000);

test("GET removal: clean, changed, and a commit not pushed", async () => {
  const t = await boot();
  const ws = await t.checkout("a");
  const upstream = join(root!, "up.git");
  mkdirSync(upstream);
  sh(upstream, "init", "-q", "--bare");
  sh(ws.path, "branch", "-M", "main");
  sh(ws.path, "remote", "add", "origin", upstream);
  sh(ws.path, "push", "-q", "-u", "origin", "main");
  const removal = async () => (await t.send("GET", `/api/workspaces/${ws.id}/removal`)).body as WorkspaceRemoval;
  expect(await removal()).toMatchObject({ name: "a", path: ws.path, copy: { deletable: true }, dirty: false, unpushed: false, running: 0 });
  await Bun.write(join(ws.path, "f"), "x");
  expect(await removal()).toMatchObject({ dirty: true, unpushed: false });
  sh(ws.path, "add", "f");
  sh(ws.path, "commit", "-q", "-m", "two");
  expect(await removal()).toMatchObject({ dirty: false, unpushed: true });
  expect((await t.send("GET", "/api/workspaces/nope/removal")).status).toBe(404);
}, 30_000);

test("two workspaces of one repository share the stored backlog: it stays until the last goes", async () => {
  const t = await boot();
  const a = await t.checkout("a", "github");
  const b = await t.checkout("b", "github");
  // both read the same repository's records (a stored source naming it)
  const { Db } = await import("./db.ts");
  const probe = new Db(join(t.home, "switchboard.db"));
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  for (const w of [a, b]) probe.setWorkspaceBacklogSource(w.id, source as any);
  probe.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: "I_1", remote: { number: 1 }, fetchState: "fetched" }] as any, cursor: null, syncedAt: 1 });
  expect((await t.send("DELETE", `/api/workspaces/${a.id}`)).status).toBe(200);
  expect(probe.listBacklogRecords(source)).toHaveLength(1);
  expect((await t.send("DELETE", `/api/workspaces/${b.id}`)).status).toBe(200);
  expect(probe.listBacklogRecords(source)).toHaveLength(0);
  probe.close();
}, 30_000);
