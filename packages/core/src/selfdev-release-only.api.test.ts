// test-reads: none
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, StartOptions, Task, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_GH, NO_HISTORY, j, startServer, waitFor } from "./api-test-harness.ts";
import type { CoreServer } from "./server.ts";

// a clean finished turn with a session, so a Task on it can be forked
const text = (t: string): AgentEvent[] => [{ t: "session.start", runner: "claude", runnerSessionId: "sess", cwd: "/" }, { t: "message.delta", role: "assistant", text: t }, { t: "session.end", status: "ok", turn: "turn-1" }];

/** Answers the Workspace question with the first candidate it is shown; any other turn is a plain task turn. */
function chooser(asked: string[]): RunnerAdapter {
  return {
    id: "claude",
    forks: true,
    forkMinVersion: "1.0.0",
    hasSession: () => true,
    permissionModes: [{ value: "plan", label: "plan", description: "plan" }],
    async detect() {
      return { available: true, version: "2.0.0" };
    },
    start(opts: StartOptions, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const events = opts.prompt.includes("## 候補の Workspace")
        ? (asked.push(opts.prompt), text(JSON.stringify({ workspaceId: opts.prompt.match(/- id: (\S+) \//)![1], reason: "最初の候補" })))
        : text("done");
      queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      return { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
    },
  };
}

type Booted = { c: CoreServer; b: string; h: string; asked: string[]; meta: Workspace; repo: Workspace; post: (path: string, body: unknown) => Promise<Response> };
const booted: Record<string, Booted> = {};

/** A daemon whose own tree is `<home>/tree`; `releaseOnly` is what the config would say for a Release install. */
async function boot(releaseOnly: boolean): Promise<Booted> {
  const h = mkdtempSync(join(tmpdir(), "switchboard-test-release-only-"));
  // a Release install runs from sb-rescue's link <home>/releases/current; a clone from its checkout
  const release = join(h, "releases", "a".repeat(40));
  const tree = releaseOnly ? join(h, "releases", "current") : join(h, "tree");
  mkdirSync(join(releaseOnly ? release : tree, "inner"), { recursive: true });
  if (releaseOnly) symlinkSync(release, tree);
  mkdirSync(join(h, "other"), { recursive: true });
  const asked: string[] = [];
  const cfg = { ...loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), repoRoot: tree, releaseOnly };
  const c = await startServer(cfg, [chooser(asked)], { port: 0, selfdevChecks: true, gh: NO_GH });
  const b = `http://127.0.0.1:${c.server.port}`;
  const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const repo = (await post("/api/workspaces", { path: join(h, "other"), name: "other" }).then(j)) as Workspace;
  const meta = c.db.listWorkspaces().find((w) => w.kind === "meta")!;
  return { c, b, h, asked, meta, repo, post };
}

beforeAll(async () => {
  booted.release = await boot(true);
  booted.clone = await boot(false);
});
afterAll(async () => {
  for (const x of Object.values(booted)) {
    await x.c.stop();
    rmSync(x.h, { recursive: true, force: true });
  }
});

const checkRuns = (c: CoreServer) => (c.db.sqlite.query("SELECT COUNT(*) AS n FROM check_runs").get() as { n: number }).n;
const metaTask = (x: Booted) => x.c.tasks.create({ title: "on meta", prompt: "p", runner: "claude", workspaceId: x.meta.id, cwd: x.meta.path });

test("release-only: a turn on the meta row runs no checks", async () => {
  const x = booted.release!;
  const run = spyOn(x.c.selfdev, "run").mockResolvedValue(undefined as never);
  try {
    const t = metaTask(x);
    await waitFor(async () => x.c.db.getTask(t.id)!.status === "done");
    await Bun.sleep(50);
    expect(run).not.toHaveBeenCalled();
    expect(checkRuns(x.c)).toBe(0);
    expect(await fetch(`${x.b}/api/tasks/${t.id}/checks`).then(j)).toEqual({ run: null, running: false, meta: false, current: false });
    expect((await fetch(`${x.b}/api/tasks/${t.id}/checks`, { method: "POST" })).status).toBe(400);
  } finally {
    run.mockRestore();
  }
});

test("a clone keeps its checks: the same turn on the meta row runs them", async () => {
  const x = booted.clone!;
  const run = spyOn(x.c.selfdev, "run").mockResolvedValue(undefined as never);
  try {
    const t = metaTask(x);
    await waitFor(async () => x.c.db.getTask(t.id)!.status === "done");
    await waitFor(async () => run.mock.calls.length > 0);
    expect(run).toHaveBeenCalledWith(t.id);
    expect((await fetch(`${x.b}/api/tasks/${t.id}/checks`).then(j)).meta).toBe(true);
    expect((await x.post("/api/tasks", { workspaceId: x.meta.id, title: "t", prompt: "p", runner: "claude" })).status).toBe(201);
    expect((await fetch(`${x.b}/api/health`).then(j)).releaseOnly).toBe(false);
  } finally {
    run.mockRestore();
  }
});

test("release-only: POST /api/tasks on the meta row is 409", async () => {
  const x = booted.release!;
  const before = x.c.db.listTasks().length;
  const named = await x.post("/api/tasks", { workspaceId: x.meta.id, title: "t", prompt: "p", runner: "claude" });
  expect(named.status).toBe(409);
  expect(((await named.json()) as { error: string }).error).toContain("Switchboard 自身のフォルダに Task を始められません");
  expect((await x.post("/api/tasks", { cwd: x.meta.path, title: "t", prompt: "p", runner: "claude" })).status).toBe(409);
  expect((await x.post("/api/tasks", { cwd: join(x.meta.path, "inner"), title: "t", prompt: "p", runner: "claude" })).status).toBe(409);
  // the release directory the link points at, and any other release, are the same folder
  expect((await x.post("/api/tasks", { cwd: join(x.h, "releases", "a".repeat(40)), title: "t", prompt: "p", runner: "claude" })).status).toBe(409);
  // the folder the Task would run in decides, whatever else is named
  expect((await x.post("/api/tasks", { workspaceId: x.repo.id, cwd: x.meta.path, title: "t", prompt: "p", runner: "claude" })).status).toBe(409);
  // a schedule id over HTTP is no way around it: schedules start their Tasks inside the daemon
  const s = (await x.post("/api/schedules", { title: "any", cron: "* * * * *", workspaceId: x.meta.id, runner: "claude", prompt: "p", enabled: false }).then(j)) as { id: string };
  expect((await x.post("/api/tasks", { workspaceId: x.meta.id, scheduleId: s.id, title: "t", prompt: "p", runner: "claude" })).status).toBe(409);
  expect(x.c.db.listTasks().length).toBe(before);
  // nor is a fork of a Task that sits on the meta row
  const onMeta = metaTask(x);
  await waitFor(async () => x.c.db.getTask(onMeta.id)!.status === "done");
  const seq = x.c.db.listEvents(onMeta.id).find((e) => e.ev.t === "session.end")!.seq;
  expect((await x.post(`/api/tasks/${onMeta.id}/fork`, { seq })).status).toBe(409);
  expect(x.c.db.listTasks().length).toBe(before + 1);
  // another folder is not closed
  expect((await x.post("/api/tasks", { workspaceId: x.repo.id, title: "t", prompt: "p", runner: "claude" })).status).toBe(201);
});

test("release-only: a schedule still starts its Task on the meta row", async () => {
  const x = booted.release!;
  const s = (await x.post("/api/schedules", { title: "firing", cron: "* * * * *", workspaceId: x.meta.id, runner: "claude", prompt: "p", enabled: true }).then(j)) as { id: string };
  const ran = await x.post(`/api/schedules/${s.id}/run`, {});
  expect(ran.status).toBe(201);
  const task = (await ran.json()) as Task;
  expect(task).toMatchObject({ workspaceId: x.meta.id, cwd: x.meta.path, scheduleId: s.id });
  expect(x.c.db.getTask(task.id)).not.toBeNull();
});

test("release-only: 自動 does not choose the meta row", async () => {
  const x = booted.release!;
  x.asked.length = 0;
  const r = await x.post("/api/tasks", { title: "t", prompt: "p", runner: "claude" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).workspaceId).toBe(x.repo.id);
  expect(x.asked[0]).not.toContain(x.meta.id);
  // the clone offers it
  const y = booted.clone!;
  y.asked.length = 0;
  await y.post("/api/tasks", { title: "t", prompt: "p", runner: "claude" });
  expect(y.asked[0]).toContain(y.meta.id);
});

test("release-only: GET /api/health says so", async () => {
  expect((await fetch(`${booted.release!.b}/api/health`).then(j)).releaseOnly).toBe(true);
});
