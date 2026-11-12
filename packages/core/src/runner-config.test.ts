// test-reads: ops-kit/processes/
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { runnerConfigOf } from "./runner-config.ts";
import { Scheduler } from "./scheduler.ts";
import { syncSkills } from "./skillsync.ts";
import { startServer, type CoreServer } from "./server.ts";

// A foreign repository's runner config runs nothing until the person has seen it.

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const ending: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: opts.cwd });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited };
  },
};

const dir = () => (root = mkdtempSync(join(tmpdir(), "switchboard.runner-config.")));
const write = (base: string, rel: string, content: string) => {
  mkdirSync(join(base, rel, ".."), { recursive: true });
  writeFileSync(join(base, rel), content);
};

/** A daemon with a foreign workspace at `clone` (and an own one), the way workspace-clone registers it. */
async function boot() {
  const base = dir();
  const home = join(base, "home");
  const repoRoot = join(base, "switchboard");
  const clone = join(base, "widget");
  const own = join(base, "mine");
  for (const d of [home, repoRoot, clone, own]) mkdirSync(d);
  // the meta checkout carries the kit's process candidates: a stage start reads p0-pipeline from it
  cpSync(join(import.meta.dir, "../../../ops-kit/processes"), join(repoRoot, "ops-kit/processes"), { recursive: true });
  write(clone, ".claude/settings.json", '{"hooks":{}}');
  write(own, ".claude/settings.json", '{"hooks":{}}');
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [ending], { port: 0, selfdevChecks: false, dryRunRestart: true });
  const url = `http://127.0.0.1:${core.server.port}`;
  const send = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const r = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as T & { error?: string } };
  };
  const foreign = core.db.upsertWorkspace({ name: "widget", path: clone, kind: "repo", upstream: "someone/widget" });
  const mine = core.db.upsertWorkspace({ name: "mine", path: own, kind: "repo" });
  const start = (ws: Workspace, extra: object = {}) => send<Task>("POST", "/api/tasks", { workspaceId: ws.id, runner: "claude", prompt: "hello", title: "t", ...extra });
  const confirm = async () => {
    const seen = await send<{ hash: string }>("GET", `/api/workspaces/${foreign.id}/runner-config`);
    return send("POST", `/api/workspaces/${foreign.id}/runner-config`, { hash: seen.body.hash });
  };
  return { core, send, start, confirm, foreign, mine, clone, own };
}

test("runner config: lists the files and hashes them in order", () => {
  const base = dir();
  expect(runnerConfigOf(base).files).toEqual([]);
  write(base, "README.md", "not config");
  write(base, "CLAUDE.md", "rules");
  write(base, ".claude/skills/a/SKILL.md", "skill");
  write(base, ".codex/config.toml", "x");
  write(base, ".claude/other.json", "not listed");
  symlinkSync("/etc/passwd", join(base, ".mcp.json"));
  const { files, hash } = runnerConfigOf(base);
  expect(files).toEqual([
    { path: ".claude/skills/a/SKILL.md", content: "skill" },
    { path: ".codex/config.toml", content: "x" },
    { path: ".mcp.json", content: "/etc/passwd" },
    { path: "CLAUDE.md", content: "rules" },
  ]);
  expect(runnerConfigOf(base).hash).toBe(hash);
  write(base, "README.md", "still not config");
  expect(runnerConfigOf(base).hash).toBe(hash);
  write(base, "CLAUDE.md", "changed");
  expect(runnerConfigOf(base).hash).not.toBe(hash);
});

test("runner config: a link out of the clone is listed as the link, not read through", () => {
  const base = dir();
  const clone = join(base, "clone");
  mkdirSync(clone);
  write(base, "elsewhere/settings.json", "private");
  symlinkSync(join(base, "elsewhere"), join(clone, ".claude"));
  expect(runnerConfigOf(clone).files).toEqual([{ path: ".claude", content: join(base, "elsewhere") }]);
  rmSync(join(clone, ".claude"));
  write(base, "other/skills/o/SKILL.md", "private");
  symlinkSync(join(base, "other"), join(clone, ".agents"));
  expect(runnerConfigOf(clone).files).toEqual([{ path: ".agents", content: join(base, "other") }]);
});

test("runner config: a link out of the clone under a link inside it is listed, and a chain counts by its end", () => {
  const base = dir();
  const clone = join(base, "clone");
  write(clone, "cmds/a.md", "a");
  write(base, "one.md", "1");
  write(base, "two.md", "2");
  mkdirSync(join(clone, ".claude"));
  symlinkSync("../cmds", join(clone, ".claude/commands"));
  const first = runnerConfigOf(clone).hash;
  symlinkSync(join(base, "one.md"), join(clone, "cmds/evil.md"));
  const linked = runnerConfigOf(clone);
  expect(linked.hash).not.toBe(first);
  expect(linked.files.find((f) => f.path === ".claude/commands/evil.md")?.content).toBe(join(base, "one.md"));
  symlinkSync(join(base, "one.md"), join(clone, "via"));
  symlinkSync("via", join(clone, "CLAUDE.md"));
  const chain = runnerConfigOf(clone);
  expect(chain.files.find((f) => f.path === "CLAUDE.md")?.content).toBe(join(base, "one.md"));
  rmSync(join(clone, "via"));
  symlinkSync(join(base, "two.md"), join(clone, "via"));
  expect(runnerConfigOf(clone).hash).not.toBe(chain.hash);
});

test("runner config: a second link to a folder already listed asks again, and .git is not read", () => {
  const base = dir();
  spawnSync("git", ["init", "-q", base]);
  write(base, ".claude/agents/a.md", "agent");
  const first = runnerConfigOf(base).hash;
  symlinkSync("agents", join(base, ".claude/commands"));
  expect(runnerConfigOf(base).hash).not.toBe(first);
  rmSync(join(base, ".claude/commands"));
  symlinkSync("..", join(base, ".claude/commands"));
  expect(runnerConfigOf(base).files.some((f) => f.path.includes(".git/"))).toBe(false);
  rmSync(join(base, ".claude/commands"));
  symlinkSync("../.git", join(base, ".claude/commands"));
  expect(runnerConfigOf(base).files.map((f) => f.path)).toEqual([".claude/agents/a.md", ".claude/commands"]);
});

test("runner config: a link inside the clone counts as what it points at", () => {
  const base = dir();
  write(base, "hooks.json", "first");
  mkdirSync(join(base, ".claude"));
  symlinkSync("../hooks.json", join(base, ".claude/settings.json"));
  symlinkSync("..", join(base, ".claude/commands")); // a loop ends
  const first = runnerConfigOf(base);
  expect(first.files.find((f) => f.path === ".claude/settings.json")?.content).toBe("first");
  write(base, "hooks.json", "changed");
  expect(runnerConfigOf(base).hash).not.toBe(first.hash);
});

test("runner config: a file swapped for a link with the same text asks again", () => {
  const base = dir();
  write(base, ".mcp.json", "/nowhere");
  const file = runnerConfigOf(base).hash;
  rmSync(join(base, ".mcp.json"));
  symlinkSync("/nowhere", join(base, ".mcp.json"));
  expect(runnerConfigOf(base).hash).not.toBe(file);
});

test("runner config: skills Switchboard placed are not the repository's, a tracked one with the marker is", () => {
  const base = dir();
  spawnSync("git", ["init", "-q", base]);
  write(base, ".claude/skills/placed/SKILL.md", "ours");
  write(base, ".claude/skills/placed/.switchboard-skill", "x");
  write(base, ".agents/skills/placed/SKILL.md", "ours");
  write(base, ".agents/skills/placed/.switchboard-skill", "x");
  write(base, ".claude/skills/hidden/SKILL.md", "theirs");
  write(base, ".claude/skills/hidden/.switchboard-skill", "x");
  write(base, ".claude/skills/スキル/SKILL.md", "theirs");
  write(base, ".claude/skills/スキル/.switchboard-skill", "x");
  spawnSync("git", ["-C", base, "add", "-f", ".claude/skills/hidden", ".claude/skills/スキル"]);
  expect(runnerConfigOf(base).files.map((f) => f.path)).toEqual([".claude/skills/hidden/.switchboard-skill", ".claude/skills/hidden/SKILL.md", ".claude/skills/スキル/.switchboard-skill", ".claude/skills/スキル/SKILL.md"]);
});

test("runner config: syncSkills leaves the hash alone, also when the skills folder is a link in the clone", () => {
  const base = dir();
  const meta = join(base, "meta");
  write(meta, "ops-kit/skills/demo/SKILL.md", "---\nname: demo\n---\n");
  spawnSync("git", ["init", "-q", meta]);
  for (const links of [false, true]) {
    const clone = join(base, links ? "linked" : "plain");
    mkdirSync(join(clone, "skills"), { recursive: true });
    spawnSync("git", ["init", "-q", clone]);
    write(clone, "CLAUDE.md", "rules");
    if (links) {
      mkdirSync(join(clone, ".claude"));
      symlinkSync("../skills", join(clone, ".claude/skills"));
    }
    const before = runnerConfigOf(clone).hash;
    expect(syncSkills({ metaPath: meta, cwd: clone }).linked).toContain("demo");
    expect(runnerConfigOf(clone).hash).toBe(before);
  }
});

test("runner config: a long file is cut in the list, and a change past the cut still changes the hash", () => {
  const base = dir();
  const long = "a".repeat(300 * 1024);
  write(base, "CLAUDE.md", `${long}b`);
  const first = runnerConfigOf(base);
  expect(first.files[0]!.content.length).toBeLessThan(long.length);
  expect(first.files[0]!.content).toEndWith(`以下省略（${long.length + 1} バイト）`);
  write(base, "CLAUDE.md", `${long}c`);
  expect(runnerConfigOf(base).hash).not.toBe(first.hash);
});

test("runner config: a foreign workspace refuses tasks until confirmed", async () => {
  const b = await boot();
  const seen = await b.send<{ upstream: string; files: unknown[]; confirmed: boolean }>("GET", `/api/workspaces/${b.foreign.id}/runner-config`);
  expect(seen.body).toMatchObject({ upstream: "someone/widget", files: [{ path: ".claude/settings.json", content: '{"hooks":{}}' }], confirmed: false });
  const refused = await b.start(b.foreign);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("widget は他者のリポジトリです");
  expect(b.core.db.listTasks()).toEqual([]);
  expect((await b.confirm()).status).toBe(200);
  expect((await b.send<{ confirmed: boolean }>("GET", `/api/workspaces/${b.foreign.id}/runner-config`)).body.confirmed).toBe(true);
  expect((await b.start(b.foreign)).status).toBe(201);
});

test("runner config: a cwd inside a foreign clone is refused without naming the workspace", async () => {
  const b = await boot();
  const sub = join(b.clone, "src");
  mkdirSync(sub);
  for (const cwd of [b.clone, sub]) expect((await b.send("POST", "/api/tasks", { cwd, runner: "claude", prompt: "hello", title: "t" })).status).toBe(409);
  expect((await b.start(b.mine, { cwd: b.clone })).status).toBe(409);
  const link = join(b.clone, "..", "link");
  symlinkSync(b.clone, link);
  for (const cwd of [join(b.clone, "..", "home") + "/../widget", link]) expect((await b.send("POST", "/api/tasks", { cwd, runner: "claude", prompt: "hello", title: "t" })).status).toBe(409);
  expect(b.core.db.listTasks()).toEqual([]);
});

test("runner config: continuing a task after the config changed is refused, with the reason on the task", async () => {
  const b = await boot();
  await b.confirm();
  const { body: task } = await b.start(b.foreign);
  for (let i = 0; i < 200 && b.core.db.getTask(task.id)!.status !== "done"; i++) await Bun.sleep(10);
  write(b.clone, ".claude/settings.json", '{"hooks":{"SessionStart":[]}}');
  expect((await b.send("POST", `/api/tasks/${task.id}/send`, { text: "more" })).status).toBe(409);
  expect(b.core.db.getTask(task.id)!.status).toBe("error");
});

test("runner config: a changed file asks again", async () => {
  const b = await boot();
  await b.confirm();
  write(b.clone, ".claude/settings.json", '{"hooks":{"SessionStart":[]}}');
  expect((await b.start(b.foreign)).status).toBe(409);
  expect((await b.send<{ confirmed: boolean }>("GET", `/api/workspaces/${b.foreign.id}/runner-config`)).body.confirmed).toBe(false);
  await b.confirm();
  expect((await b.start(b.foreign)).status).toBe(201);
});

test("runner config: a schedule on an unconfirmed workspace records the reason and does not throw", async () => {
  const b = await boot();
  const scheduler = new Scheduler(b.core.db, b.core.tasks);
  const s = scheduler.create({ title: "nightly", workspaceId: b.foreign.id, prompt: "hello", runner: "claude", cron: "* * * * *" });
  b.core.db.updateSchedule(s.id, { nextRunAt: Date.now() - 1000 });
  expect(await scheduler.tick()).toEqual([]);
  expect(b.core.db.listTasks()).toEqual([]);
  expect(scheduler.recentLog().join("\n")).toContain("nightly: failed to start (widget は他者のリポジトリです");
  expect(b.core.db.getSchedule(s.id)!.nextRunAt).toBeGreaterThan(Date.now());
});

test("runner config: a stage task on an unconfirmed workspace answers with the reason", async () => {
  const b = await boot();
  expect((await b.send("PATCH", `/api/workspaces/${b.foreign.id}`, { backlog: "switchboard" })).status).toBe(200);
  expect((await b.send("POST", "/api/backlog", { workspaceId: b.foreign.id, title: "PBI: x", labels: ["type:pbi"] })).status).toBe(202);
  const r = await b.send("POST", "/api/backlog/1/start", { workspaceId: b.foreign.id, action: "to-tasks" });
  expect(r.status).toBe(409);
  expect(r.body.error).toContain("widget は他者のリポジトリです");
  expect(b.core.db.listTasks()).toEqual([]);
});

test("runner config: an ownCopy workspace is asked too", async () => {
  // what workspace-clone registers with ownCopy: origin is your private copy, upstream the original, backlog on GitHub
  const b = await boot();
  const copy = join(root!, "copy");
  mkdirSync(copy);
  write(copy, ".claude/settings.json", '{"hooks":{}}');
  spawnSync("git", ["init", "-q", copy]);
  spawnSync("git", ["-C", copy, "remote", "add", "origin", "https://github.com/me/copy.git"]);
  spawnSync("git", ["-C", copy, "remote", "add", "upstream", "https://github.com/someone/copy.git"]);
  const ws = b.core.db.upsertWorkspace({ name: "copy", path: copy, kind: "repo", upstream: "someone/copy" });
  expect(ws.backlog).toBe("github");
  const refused = await b.start(ws);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toContain("copy は他者のリポジトリです");
  const seen = await b.send<{ hash: string; files: unknown[] }>("GET", `/api/workspaces/${ws.id}/runner-config`);
  expect(seen.body.files).toMatchObject([{ path: ".claude/settings.json" }]);
  expect((await b.send("POST", `/api/workspaces/${ws.id}/runner-config`, { hash: seen.body.hash })).status).toBe(200);
  expect((await b.start(ws)).status).toBe(201);
  // the 元の更新を取り込む Task is there for it too
  const sync = await b.send<Task>("POST", `/api/workspaces/${ws.id}/upstream-sync`);
  expect(sync.status).toBe(201);
  expect(sync.body.title).toBe("元の更新を取り込む: someone/copy");
});

test("runner config: own workspaces are not asked", async () => {
  const b = await boot();
  expect((await b.send("GET", `/api/workspaces/${b.mine.id}/runner-config`)).status).toBe(404);
  expect((await b.send("POST", `/api/workspaces/${b.mine.id}/runner-config`, { hash: "x" })).status).toBe(404);
  expect((await b.start(b.mine)).status).toBe(201);
});

test("runner config: confirming a stale hash is 409", async () => {
  const b = await boot();
  const seen = await b.send<{ hash: string }>("GET", `/api/workspaces/${b.foreign.id}/runner-config`);
  write(b.clone, "CLAUDE.md", "added after the look");
  const stale = await b.send("POST", `/api/workspaces/${b.foreign.id}/runner-config`, { hash: seen.body.hash });
  expect(stale.status).toBe(409);
  expect((await b.start(b.foreign)).status).toBe(409);
});
