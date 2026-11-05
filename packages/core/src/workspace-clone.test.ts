// test-reads: none
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

// Adding a GitHub repository by name (#2575): cloned next to the checkout; one the owner cannot push to writes nothing back (#2576).

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

/**
 * `git: "full"` clones a real repository with branches main and dev and tag v1 from `<root>/gh/<owner>/<name>.git`;
 * the clone reads https://github.com/ as `<root>/gh/`, so the fetch and push of an own copy (#2579) stay on disk.
 * `mine` is what `gh api repos/me/<name>` answers (absent = 404).
 */
async function boot(fake: { push?: boolean | "missing"; cloneFails?: string; hold?: Promise<void>; git?: "clone" | "fork" | "full"; renamedTo?: string; mine?: "exists" | "error"; createFails?: string; createMakesNothing?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), "switchboard.clone."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  mkdirSync(home);
  mkdirSync(repoRoot);
  const calls: string[][] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return { code: 0, stdout: "me\n", stderr: "" };
    if (args[0] === "api" && args[1]!.startsWith("repos/me/") && args[3] === ".full_name") {
      if (fake.mine === "exists") return { code: 0, stdout: `${args[1]!.slice(6)}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: fake.mine === "error" ? "HTTP 502: Bad Gateway" : "gh: Not Found (HTTP 404)" };
    }
    if (args[0] === "repo" && args[1] === "create") {
      if (fake.createFails) return { code: 1, stdout: "", stderr: fake.createFails };
      if (!fake.createMakesNothing) expect(spawnSync("git", ["init", "-q", "--bare", join(root!, "gh", `${args[2]}.git`)]).status).toBe(0);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "set-default") {
      // what gh does: marks the remote whose URL is the repository
      expect(spawnSync("git", ["-C", cwd, "config", "remote.origin.gh-resolved", "base"]).status).toBe(0);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api") return fake.push === "missing" ? { code: 1, stdout: "", stderr: "HTTP 404" } : { code: 0, stdout: `${fake.push ?? true} ${fake.renamedTo ?? args[1]!.replace("repos/", "")}\n`, stderr: "" };
    if (args[0] === "repo" && args[1] === "clone") {
      await fake.hold;
      if (fake.cloneFails) return { code: 1, stdout: "", stderr: `Cloning...\n${fake.cloneFails}\n` };
      if (fake.git === "full") {
        const source = join(root!, "gh", `${args[2]}.git`);
        seed(source);
        expect(spawnSync("git", ["clone", "-q", source, args[3]!]).status).toBe(0);
        gitOk(args[3]!, "remote", "set-url", "origin", `https://github.com/${args[2]}.git`);
        gitOk(args[3]!, "config", `url.${join(root!, "gh")}/.insteadOf`, "https://github.com/");
        return { code: 0, stdout: "", stderr: "" };
      }
      mkdirSync(args[3]!);
      expect(cwd).toBe(root!);
      if (fake.git) {
        spawnSync("git", ["-C", args[3]!, "init", "-q"]);
        spawnSync("git", ["-C", args[3]!, "remote", "add", "origin", `https://github.com/${args[2]}.git`]);
        if (fake.git === "fork") spawnSync("git", ["-C", args[3]!, "remote", "add", "upstream", "https://github.com/parent/lib.git"]);
      }
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
  return { send, until, calls, cloneCalls, repoRoot, base, setPush: (push: boolean) => { fake.push = push; } };
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

const gitOut = (path: string, ...args: string[]) => spawnSync("git", ["-C", path, ...args], { encoding: "utf8" }).stdout.trim();

const gitOk = (path: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 0, r.stderr]);
};

/** A bare repository at `bare` with branches main (checked out by a clone) and dev, and the tag v1. */
function seed(bare: string): void {
  const work = `${bare}.work`;
  expect(spawnSync("git", ["init", "-q", "-b", "main", work]).status).toBe(0);
  gitOk(work, "commit", "-q", "--allow-empty", "-m", "first");
  gitOk(work, "tag", "v1");
  gitOk(work, "checkout", "-q", "-b", "dev");
  gitOk(work, "commit", "-q", "--allow-empty", "-m", "on dev");
  gitOk(work, "checkout", "-q", "main");
  expect(spawnSync("git", ["clone", "-q", "--bare", work, bare]).status).toBe(0);
}

const refsOf = (bare: string) => gitOut(bare, "for-each-ref", "--format=%(refname)").split("\n").sort();

test("workspace clone: ownCopy creates a private repository, pushes every branch and tag, and makes it origin and the default", async () => {
  const t = await boot({ push: false, git: "full" });
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib"));
  const path = join(root!, "lib");
  // asked who you are and whether the name is free before cloning, created private after the clone
  const order = t.calls.map((a) => a.slice(0, 2).join(" "));
  expect(order).toEqual(["api repos/other/lib", "api user", "api repos/me/lib", "repo clone", "repo create", "repo set-default"]);
  expect(t.calls.find((a) => a[1] === "create")).toEqual(["repo", "create", "me/lib", "--private"]);
  expect(t.calls.find((a) => a[1] === "set-default")).toEqual(["repo", "set-default", "me/lib"]);
  // as configured (git remote -v would show the test's insteadOf)
  expect(gitOut(path, "config", "--get-regexp", "^remote\\..*\\.url$").split("\n")).toEqual([
    "remote.upstream.url https://github.com/other/lib.git",
    "remote.origin.url https://github.com/me/lib.git",
  ]);
  expect(gitOut(path, "config", "--get-all", "ops-kit.noWrite")).toBe("other/lib");
  expect(gitOut(path, "config", "remote.origin.gh-resolved")).toBe("base");
  // every branch tracks the copy: a plain git push goes there, not to upstream
  expect(gitOut(path, "for-each-ref", "--format=%(refname:short) %(upstream:short)", "refs/heads").split("\n").sort()).toEqual(["dev origin/dev", "main origin/main"]);
  // the copy has what the original has: every branch and tag
  expect(refsOf(join(root!, "gh", "me/lib.git"))).toEqual(refsOf(join(root!, "gh", "other/lib.git")));
  expect(refsOf(join(root!, "gh", "me/lib.git"))).toEqual(["refs/heads/dev", "refs/heads/main", "refs/tags/v1"]);
  const ws = ((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "lib")!;
  expect([ws.backlog, ws.upstream]).toEqual(["github", "other/lib"]);
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
}, 30_000);

test("workspace clone: ownCopy with an existing repository of yours is 409 and creates nothing", async () => {
  const t = await boot({ push: false, git: "full", mine: "exists" });
  const r = await t.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true });
  expect(r.status).toBe(409);
  expect((r.body as { error: string }).error).toContain("me/lib が既にあります");
  expect(t.calls.filter((a) => a[0] === "repo")).toEqual([]);
  expect(existsSync(join(root!, "lib"))).toBe(false);
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
  // an answer that is not a 404 is not taken as free either
  const u = await boot({ push: false, git: "full", mine: "error" });
  expect((await u.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true })).status).toBe(502);
  expect(u.calls.filter((a) => a[0] === "repo")).toEqual([]);
}, 30_000);

test("workspace clone: ownCopy on a repository you can push to is 400", async () => {
  const t = await boot({ git: "full" });
  expect((await t.send("POST", "/api/workspaces", { repo: "acme/app", ownCopy: true })).status).toBe(400);
  expect(t.calls.filter((a) => a[0] === "repo" || a[1] === "user")).toEqual([]);
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
  for (const body of [{ repo: "other/lib", ownCopy: "yes" }, { path: root!, ownCopy: true }]) expect((await t.send("POST", "/api/workspaces", body)).status).toBe(400);
}, 30_000);

test("workspace clone: ownCopy keeps the backlog choice", async () => {
  const t = await boot({ push: false, git: "full" });
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true, backlog: "switchboard" })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib"));
  const ws = ((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "lib")!;
  expect([ws.backlog, ws.upstream]).toEqual(["switchboard", "other/lib"]);
  expect(gitOut(join(root!, "lib"), "config", "remote.origin.url")).toBe("https://github.com/me/lib.git");
}, 30_000);

test("workspace clone: ownCopy that fails is failed with the reason, names what it made, and registers nothing", async () => {
  const t = await boot({ push: false, git: "full", createFails: "HTTP 422: name already exists on this account" });
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[]).some((c) => c.state === "failed"));
  const failed = ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[])[0]!.error!;
  expect(failed).toContain("gh repo create: HTTP 422");
  expect(failed).not.toContain("作成済み");
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib")).toBe(false);
}, 30_000);

test("workspace clone: ownCopy whose push fails after the create names the repository left behind", async () => {
  const t = await boot({ push: false, git: "full", createMakesNothing: true });
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib", ownCopy: true })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[]).some((c) => c.state === "failed"));
  const failed = ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[])[0]!.error!;
  expect(failed).toContain("git push");
  expect(failed).toContain("me/lib は作成済みです");
  expect(t.calls.some((a) => a[1] === "set-default")).toBe(false);
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib")).toBe(false);
}, 30_000);

test("workspace clone: a repository you cannot push to is added as a foreign workspace", async () => {
  const t = await boot({ push: false, git: "clone" });
  // the backlog stays here whatever was asked
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib", backlog: "github" })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib"));
  const path = join(root!, "lib");
  expect(gitOut(path, "remote")).toBe("upstream");
  expect(gitOut(path, "remote", "get-url", "upstream")).toBe("https://github.com/other/lib.git");
  expect(gitOut(path, "config", "--get-all", "ops-kit.noWrite")).toBe("other/lib");
  const ws = ((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "lib")!;
  expect([ws.backlog, ws.upstream]).toEqual(["switchboard", "other/lib"]);
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
}, 30_000);

test("workspace clone: a renamed repository is marked with its name now, the one gh repo view answers", async () => {
  const t = await boot({ push: false, git: "clone", renamedTo: "other/new" });
  await t.send("POST", "/api/workspaces", { repo: "other/old" });
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "old"));
  expect(gitOut(join(root!, "old"), "config", "--get-all", "ops-kit.noWrite")).toBe("other/new");
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "old")?.upstream).toBe("other/new");
}, 30_000);

test("workspace clone: upstream survives registering the path again, and your own repository cannot take a foreign one's path", async () => {
  const t = await boot({ push: false, git: "clone" });
  await t.send("POST", "/api/workspaces", { repo: "other/lib" });
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib"));
  const path = join(root!, "lib");
  expect(((await t.send("POST", "/api/workspaces", { path })).body as Workspace).upstream).toBe("other/lib");
  rmSync(path, { recursive: true });
  t.setPush(true);
  expect((await t.send("POST", "/api/workspaces", { repo: "me/lib" })).status).toBe(409);
  t.setPush(false);
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib" })).status).toBe(202);
  await t.until(async () => existsSync(path) && ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[]).length === 0);
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.path === path)?.upstream).toBe("other/lib");
}, 30_000);

test("workspace clone: your own repository has no upstream", async () => {
  const t = await boot({ git: "clone" });
  await t.send("POST", "/api/workspaces", { repo: "acme/app" });
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "app"));
  expect(gitOut(join(root!, "app"), "remote")).toBe("origin");
  expect(gitOut(join(root!, "app"), "config", "--get-all", "ops-kit.noWrite")).toBe("");
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).find((w) => w.name === "app")?.upstream).toBeUndefined();
}, 30_000);

test("workspace clone: someone's fork leaves one upstream, the repository that was added", async () => {
  const t = await boot({ push: false, git: "fork" });
  await t.send("POST", "/api/workspaces", { repo: "other/lib" });
  await t.until(async () => ((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib"));
  const path = join(root!, "lib");
  expect(gitOut(path, "remote")).toBe("upstream");
  expect(gitOut(path, "remote", "get-url", "upstream")).toBe("https://github.com/other/lib.git");
}, 30_000);

test("workspace clone: a foreign clone git cannot detach is failed with the reason and not registered", async () => {
  const t = await boot({ push: false }); // the fake's clone is not a git repository
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib" })).status).toBe(202);
  await t.until(async () => ((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[]).some((c) => c.state === "failed"));
  expect(((await t.send("GET", "/api/workspaces/clones")).body as WorkspaceClone[])[0]?.error).toBeTruthy();
  expect(((await t.send("GET", "/api/workspaces")).body as Workspace[]).some((w) => w.name === "lib")).toBe(false);
}, 30_000);

test("workspace clone: a foreign repository cannot take over a workspace that syncs with GitHub", async () => {
  const t = await boot({ push: false, git: "clone" });
  mkdirSync(join(root!, "lib"));
  await t.send("POST", "/api/workspaces", { path: join(root!, "lib") });
  rmSync(join(root!, "lib"), { recursive: true });
  expect((await t.send("POST", "/api/workspaces", { repo: "other/lib" })).status).toBe(409);
  expect(t.cloneCalls()).toBe(0);
  expect((await t.send("GET", "/api/workspaces/clones")).body).toEqual([]);
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
