import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import type { GhRunner } from "./backlog.ts";
import { originMismatch, parseGithubRepo, type WorkspaceClone, unusableWorkspaces } from "./workspace-clone.ts";
import { Db } from "./db.ts";

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
  return { send, until, calls, cloneCalls, repoRoot, base };
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

test("originMismatch: a checkout whose origin is not the registered GitHub repository, in any URL form (#2799)", () => {
  root = mkdtempSync(join(tmpdir(), "switchboard.origin."));
  const dir = root;
  const origin = (url: string | null) => {
    spawnSync("git", ["-C", dir, "remote", "remove", "origin"]);
    if (url) expect(spawnSync("git", ["-C", dir, "remote", "add", "origin", url]).status).toBe(0);
  };
  expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
  const github = { service: "github" as const, host: "github.com", repository: "Acme/App-Dev", project: { owner: "acme", number: 1 } };
  const same = ["https://github.com/acme/app-dev.git", "https://github.com/acme/app-dev", "git@github.com:acme/app-dev.git", "ssh://git@github.com/acme/app-dev", "https://x-access-token:secret-value@github.com/acme/app-dev.git"];
  for (const url of same) {
    origin(url);
    expect([url, originMismatch(dir, github)]).toEqual([url, null]);
  }
  origin("https://x-access-token:secret-value@github.com/acme/app.git");
  const why = originMismatch(dir, github)!;
  expect(why).toContain("origin は acme/app、登録は Acme/App-Dev");
  expect(why).toContain("git remote set-url origin https://github.com/Acme/App-Dev.git");
  expect(why).not.toContain("secret-value");
  // a relative path that reads like the name is another repository on this machine
  origin("acme/app-dev");
  expect(originMismatch(dir, github)).toContain("origin は acme/app-dev、登録は Acme/App-Dev");
  // an origin that is not on GitHub is not the registration either
  origin("https://gitlab.com/acme/app-dev.git");
  expect(originMismatch(dir, github)).toContain("origin は https://gitlab.com/acme/app-dev.git、登録は Acme/App-Dev");
  // no origin, or not a git checkout: nothing to push to, nothing to check
  origin(null);
  expect(originMismatch(dir, github)).toBeNull();
  expect(originMismatch(join(dir, "missing"), github)).toBeNull();
  // no registration, or one kept here: nothing to check
  expect(originMismatch(dir, null)).toBeNull();
  expect(originMismatch(dir, { service: "switchboard", host: "local", repository: "ws_1", project: { owner: "switchboard", number: 0 } })).toBeNull();
  expect(parseGithubRepo("git@github.com:acme/app.git")).toEqual({ owner: "acme", name: "app" });
  expect(parseGithubRepo("ssh://git@github.com/acme/app")).toEqual({ owner: "acme", name: "app" });
});

test("unusableWorkspaces lists a missing folder and a wrong origin of a GitHub registration", () => {
  root = mkdtempSync(join(tmpdir(), "switchboard.unusable."));
  const db = new Db(join(root, "switchboard.db"));
  try {
    const github = (repository: string) => ({ service: "github" as const, host: "github.com", repository, project: { owner: "acme", number: 1 } });
    const at = (name: string) => {
      const path = join(root!, name);
      mkdirSync(path);
      expect(spawnSync("git", ["init", "-q", path]).status).toBe(0);
      return path;
    };
    // gone: registered, its folder is not there
    const gone = db.upsertWorkspace({ name: "gone", path: join(root, "gone"), kind: "repo" });
    db.setWorkspaceBacklogSource(gone.id, github("acme/gone-dev"));
    // elsewhere: a clone of the public acme/app where acme/app-dev is registered
    const elsewhere = db.upsertWorkspace({ name: "elsewhere", path: at("elsewhere"), kind: "repo" });
    spawnSync("git", ["-C", elsewhere.path, "remote", "add", "origin", "https://github.com/acme/app.git"]);
    db.setWorkspaceBacklogSource(elsewhere.id, github("acme/app-dev"));
    // fine: its own clone; plain: no registration (a folder that is not there either); local: kept here
    const fine = db.upsertWorkspace({ name: "fine", path: at("fine"), kind: "repo" });
    spawnSync("git", ["-C", fine.path, "remote", "add", "origin", "git@github.com:acme/fine.git"]);
    db.setWorkspaceBacklogSource(fine.id, github("acme/fine"));
    db.upsertWorkspace({ name: "plain", path: join(root, "plain"), kind: "repo" });
    const local = db.upsertWorkspace({ name: "local", path: join(root, "local"), kind: "repo" });
    db.setWorkspaceBacklogSource(local.id, { service: "switchboard", host: "local", repository: local.id, project: { owner: "switchboard", number: 0 } });

    const list = unusableWorkspaces(db);
    expect(list.map((u) => u.workspace).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { id: elsewhere.id, name: "elsewhere" },
      { id: gone.id, name: "gone" },
    ]);
    const why = (name: string) => list.find((u) => u.workspace.name === name)!.why;
    expect(why("gone")).toContain("gh repo clone acme/gone-dev");
    expect(why("gone")).toContain(".unverified-*");
    expect(why("elsewhere")).toContain("origin は acme/app、登録は acme/app-dev");
    expect(why("elsewhere")).toContain("git remote set-url origin");
    // fixed: the folder put back as its own clone is not listed the next time
    mkdirSync(gone.path);
    spawnSync("git", ["init", "-q", gone.path]);
    spawnSync("git", ["-C", gone.path, "remote", "add", "origin", "https://github.com/acme/gone-dev.git"]);
    expect(unusableWorkspaces(db).map((u) => u.workspace.name)).toEqual(["elsewhere"]);
  } finally {
    db.close();
  }
});

test("GET /api/asks: a workspace that cannot be used is a notice until it is fixed, never an Inbox note (#2866)", async () => {
  const { base } = await boot();
  const gone = core!.db.upsertWorkspace({ name: "gone", path: join(root!, "gone"), kind: "repo" });
  core!.db.setWorkspaceBacklogSource(gone.id, { service: "github", host: "github.com", repository: "acme/gone", project: { owner: "acme", number: 1 } });
  type Notice = { id: string; kind: string; state: string; question: string };
  const notices = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Notice[] }).asks.filter((a) => a.kind === "notice");
  expect(await notices()).toMatchObject([{ id: `notice:workspace:${gone.id}`, state: "open", question: "workspace gone を使えません" }]);
  // read again: still one, the same first sight kept in the setting
  expect(await notices()).toHaveLength(1);
  expect(await (await fetch(`${base}/api/inbox`)).json()).toEqual([]);
  // put back as its own clone: resolved on the next read, no restart
  mkdirSync(gone.path);
  spawnSync("git", ["init", "-q", gone.path]);
  spawnSync("git", ["-C", gone.path, "remote", "add", "origin", "https://github.com/acme/gone.git"]);
  expect(await notices()).toMatchObject([{ id: `notice:workspace:${gone.id}`, state: "resolved" }]);
});
