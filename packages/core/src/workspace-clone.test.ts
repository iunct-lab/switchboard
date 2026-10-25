import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import type { GhRunner } from "./backlog.ts";
import type { WorkspaceClone } from "./workspace-clone.ts";

// Adding a GitHub repository by name (#2575): cloned next to the checkout, only ones the owner can push to.

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const ending: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(_opts, emit) {
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

async function boot(fake: { push?: boolean | "missing"; cloneFails?: string; hold?: Promise<void> } = {}) {
  root = mkdtempSync(join(tmpdir(), "switchboard.clone."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  mkdirSync(home);
  mkdirSync(repoRoot);
  const calls: string[][] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args);
    if (args[0] === "api") return fake.push === "missing" ? { code: 1, stdout: "", stderr: "HTTP 404" } : { code: 0, stdout: `${fake.push ?? true}\n`, stderr: "" };
    if (args[0] === "repo" && args[1] === "clone") {
      await fake.hold;
      if (fake.cloneFails) return { code: 1, stdout: "", stderr: `Cloning...\n${fake.cloneFails}\n` };
      mkdirSync(args[3]!);
      expect(cwd).toBe(root!);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [ending], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
  const base = `http://127.0.0.1:${core.server.port}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as unknown };
  };
  const until = async (f: () => Promise<boolean>) => {
    for (let i = 0; i < 1000 && !(await f()); i++) await Bun.sleep(20);
  };
  const cloneCalls = () => calls.filter((a) => a[0] === "repo").length;
  return { send, until, calls, cloneCalls, repoRoot };
}

test("workspace clone: owner/name clones next to the checkout and registers it", async () => {
  const t = await boot();
  const r = await t.send("POST", "/api/workspaces", { repo: "acme/app" });
  expect(r.status).toBe(202);
  const path = join(root!, "app");
  expect(r.body).toEqual({ repo: "acme/app", path, state: "cloning" });
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.path === path));
  expect(t.calls.find((a) => a[0] === "repo")).toEqual(["repo", "clone", "acme/app", path]);
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.path === path)?.name).toBe("app");
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
  // the URL form too
  expect((await t.send("POST", "/api/workspaces", { repo: "https://github.com/acme/web.git" })).status).toBe(202);
}, 30_000);

test("workspace clone: refuses options, other hosts, .. and extra slashes with 400", async () => {
  const t = await boot();
  for (const repo of ["-x/app", "acme/-app", "acme/..", "acme/.", "acme/.git", "acme/...", "../app", "acme/app/extra", "https://gitlab.com/acme/app", "http://github.com/acme/app", "acme", "", "acme/app;rm", 5]) {
    expect((await t.send("POST", "/api/workspaces", { repo })).status).toBe(400);
  }
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app", path: "/tmp" })).status).toBe(400);
  expect(t.calls).toEqual([]);
}, 30_000);

test("workspace clone: an existing directory is 409 and nothing runs", async () => {
  const t = await boot();
  mkdirSync(join(root!, "app"));
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app" })).status).toBe(409);
  expect(t.calls).toEqual([]);
}, 30_000);

test("workspace clone: push false is 403 and clone runs 0 times", async () => {
  const t = await boot({ push: false });
  const r = await t.send("POST", "/api/workspaces", { repo: "other/lib" });
  expect(r.status).toBe(403);
  expect((r.body as { error: string }).error).toContain("他者のリポジトリ");
  expect(t.cloneCalls()).toBe(0);
  expect(existsSync(join(root!, "lib"))).toBe(false);
}, 30_000);

test("workspace clone: a missing repository is 404", async () => {
  const t = await boot({ push: "missing" });
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/nope" })).status).toBe(404);
  expect(t.cloneCalls()).toBe(0);
}, 30_000);

test("workspace clone: a failed clone is listed with the reason", async () => {
  const t = await boot({ cloneFails: "fatal: repository not found" });
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app" })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[]).some((c) => c.state === "failed"));
  const [row] = (await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[];
  expect(row).toMatchObject({ repo: "acme/app", state: "failed", error: "fatal: repository not found" });
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "app")).toBe(false);
}, 30_000);

test("workspace clone: backlog switchboard registers a local backlog", async () => {
  const t = await boot();
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app", backlog: "switchboard" })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "app"));
  const ws = ((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "app")!;
  expect(ws.backlog).toBe("switchboard");
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
}, 30_000);

test("workspace clone: the 202 answers cloning even when the clone fails at once", async () => {
  const t = await boot({ cloneFails: "fatal: no" });
  const r = await t.send("POST", "/api/workspaces", { repo: "acme/app" });
  expect(r.status).toBe(202);
  expect((r.body as { state: string }).state).toBe("cloning");
}, 30_000);

test("workspace clone: the clone runs without holding the request", async () => {
  let release!: () => void;
  const t = await boot({ hold: new Promise<void>((r) => (release = r)) });
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app" })).status).toBe(202);
  expect(((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[])[0]?.state).toBe("cloning");
  // the same one again while it clones
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app" })).status).toBe(409);
  release();
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as unknown[]).length === 0);
}, 30_000);

test("workspace clone: two simultaneous requests for one name clone once", async () => {
  const t = await boot();
  const rs = await Promise.all([t.send("POST", "/api/workspaces", { repo: "acme/app" }), t.send("POST", "/api/workspaces", { repo: "acme/app" })]);
  expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as unknown[]).length === 0);
  expect(t.cloneCalls()).toBe(1);
}, 30_000);

test("workspace clone: a registered workspace at the path keeps its backlog (409 on the other)", async () => {
  const t = await boot();
  mkdirSync(join(root!, "app"));
  const ws = (await t.send("POST", "/api/workspaces", { path: join(root!, "app") })).body as Workspace;
  rmSync(join(root!, "app"), { recursive: true });
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app", backlog: "switchboard" })).status).toBe(409);
  expect(t.cloneCalls()).toBe(0);
  expect(ws.backlog).toBe("github");
}, 30_000);
