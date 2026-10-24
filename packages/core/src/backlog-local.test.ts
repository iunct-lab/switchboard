import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { createStoredIssue, editStoredIssue, localBacklogSource, type GhRunner } from "./backlog.ts";
import { applyLocalOperations } from "./backlog-local.ts";
import { Db } from "./db.ts";

// A workspace whose backlog is kept in Switchboard only (#2265): no GitHub Issue or Project, and gh never asked for it.

let core: CoreServer | undefined;
let home: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (home) rmSync(home, { recursive: true, force: true });
  core = home = undefined;
});

/** A claude adapter whose turn ends at once; the prompts it was started with. */
const prompts: string[] = [];
const envs: Array<Record<string, string> | undefined> = [];
const endingClaude: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    prompts.push(opts.prompt);
    envs.push(opts.env);
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

/** The daemon with a gh that throws, recording the directory of every call (the meta workspace's import asks it, and fails). */
async function boot() {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-local-"));
  const cwds: string[] = [];
  const gh: GhRunner = async (_args, cwd) => {
    cwds.push(cwd);
    throw new Error("spawn gh ENOENT");
  };
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [endingClaude], { port: 0, selfdevChecks: false, dryRunRestart: true, gh, backlogAutoImport: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  const dir = (name: string) => {
    const p = join(home!, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const add = async (path: string, backlog?: string) => fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, ...(backlog ? { backlog } : {}) }) });
  const send = async (method: string, path: string, body: object) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** A local workspace and a create in it. */
  const local = async (name = "local") => (await (await add(dir(name), "switchboard")).json()) as Workspace;
  const create = (ws: Workspace, input: object) => send("POST", "/api/backlog", { workspaceId: ws.id, ...input });
  const view = async (ws: Workspace, ref: number | string) => (await (await fetch(`${base}/api/backlog/${ref}?workspaceId=${ws.id}`)).json()) as BacklogIssueDetail;
  return { base, cwds, dir, add, send, local, create, view } as const;
}

test("a workspace without GitHub registers, reads as imported and never calls gh (#2265)", async () => {
  const { base, cwds, dir, add } = await boot();
  const path = dir("local");
  const res = await add(path, "switchboard");
  expect(res.status).toBe(201);
  const ws = (await res.json()) as Workspace;
  expect(ws.backlog).toBe("switchboard");
  expect(core!.db.getWorkspaceBacklogSource(ws.id)).toEqual({ service: "switchboard", host: "local", repository: ws.id, project: { owner: "switchboard", number: 0 } });
  const list = (await (await fetch(`${base}/api/backlog?refresh=1`)).json()) as Backlog;
  expect(list.errors.map((e) => e.workspaceId)).not.toContain(ws.id);
  expect(list.syncs.find((s) => s.workspaceId === ws.id)).toMatchObject({ repository: ws.id, syncedAt: expect.any(Number) });
  const sync = await fetch(`${base}/api/backlog/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: ws.id }) });
  expect(sync.status).toBe(200);
  // the records route reads it as current too (the kit's lint and parallel guard)
  expect((await fetch(`${base}/api/backlog/records?workspaceId=${ws.id}`)).status).toBe(200);
  expect(cwds.filter((c) => c === path)).toEqual([]);
  // listed with the place its backlog is kept; a GitHub one says github
  const all = (await (await fetch(`${base}/api/workspaces`)).json()) as Workspace[];
  expect(all.find((w) => w.id === ws.id)?.backlog).toBe("switchboard");
  expect(all.find((w) => w.kind === "meta")?.backlog).toBe("github");
  // a body with another place is 400; the same path again with the other place is 409 (switching is #2266), with none it stays
  expect((await add(dir("x"), "gitlab")).status).toBe(400);
  const nulled = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir("y"), backlog: null }) });
  expect(nulled.status).toBe(400);
  expect((await add(path, "github")).status).toBe(409);
  expect(((await (await add(path)).json()) as Workspace).backlog).toBe("switchboard");
});

test("two local workspaces keep their records apart (#2265)", async () => {
  const { add, dir } = await boot();
  const a = (await (await add(dir("a"), "switchboard")).json()) as Workspace;
  const b = (await (await add(dir("b"), "switchboard")).json()) as Workspace;
  const sa = core!.db.getWorkspaceBacklogSource(a.id)!;
  const sb = core!.db.getWorkspaceBacklogSource(b.id)!;
  expect(sa.repository).not.toBe(sb.repository);
  core!.db.putBacklogSnapshot(sa, { records: [{ objectKind: "issue", externalId: "sb:a1", fetchState: "fetched", remote: { number: 1, title: "A", url: "", state: "OPEN", stateReason: null, body: "", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", closedAt: null } }], cursor: null, syncedAt: Date.now() });
  expect(core!.db.listBacklogRecords(sa).map((r) => r.externalId)).toEqual(["sb:a1"]);
  expect(core!.db.listBacklogRecords(sb)).toEqual([]);
});

test("a local workspace refuses projectVar (#2265)", async () => {
  const { base, add, dir } = await boot();
  const ws = (await (await add(dir("local"), "switchboard")).json()) as Workspace;
  const res = await fetch(`${base}/api/workspaces/${ws.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVar: "OTHER_PROJECT_URL" }) });
  expect(res.status).toBe(409);
  // the source stays: it still reads as imported
  expect(core!.db.getWorkspaceBacklogSource(ws.id)?.service).toBe("switchboard");
});

test("a local create is numbered at once; a Task under it is its sub-issue (#2265)", async () => {
  const { base, cwds, local, create, view } = await boot();
  const ws = await local();
  const pbi = await create(ws, { title: "PBI: x", labels: ["type:pbi"] });
  const localId = pbi.body.localId as string;
  expect([pbi.status, typeof localId, pbi.body.number]).toEqual([202, "string", 1]);
  const task = await create(ws, { title: "Task: y", labels: ["type:task"], parent: 1 });
  expect(task.body.number).toBe(2);
  const list = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect(list.items.filter((i) => i.workspaceId === ws.id).map((i) => [i.number, i.tasks?.total])).toEqual([[1, 1]]);
  expect((await view(ws, 2)).issue.parent).toBe(1);
  expect((await view(ws, 1)).issue.subIssues).toEqual([2]);
  // read by its local id too, numbered; nothing waits to be sent
  expect(await view(ws, localId)).toMatchObject({ issue: { number: 1 }, pending: 0, sync: { state: "synced" } });
  expect(cwds.filter((c) => c === ws.path)).toEqual([]);
});

test("a local Issue's stage starts by number (#2265)", async () => {
  const { local, create, send } = await boot();
  const ws = await local();
  await create(ws, { title: "PBI: x", labels: ["type:pbi"] });
  const started = await send("POST", "/api/backlog/1/start", { workspaceId: ws.id, action: "to-tasks" });
  expect(started.status).toBe(201);
  const t = started.body as Task;
  expect(t.stage).toEqual({ issue: 1, action: "to-tasks" });
  for (let i = 0; !prompts.length && i < 200; i++) await Bun.sleep(10);
  expect(prompts.at(-1)).toContain("#1");
});

test("two local workspaces both have a #1 and keep them apart (#2265)", async () => {
  const { local, create, view, base } = await boot();
  const a = await local("a");
  const b = await local("b");
  expect((await create(a, { title: "A の PBI", labels: ["type:pbi"] })).body.number).toBe(1);
  expect((await create(b, { title: "B の PBI", labels: ["type:pbi"] })).body.number).toBe(1);
  expect((await view(a, 1)).issue.title).toBe("A の PBI");
  expect((await view(b, 1)).issue.title).toBe("B の PBI");
  const items = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items;
  expect(items.filter((i) => i.number === 1 && (i.workspaceId === a.id || i.workspaceId === b.id)).map((i) => i.title).sort()).toEqual(["A の PBI", "B の PBI"]);
});

test("a local comment, label, state and parent change are applied at once (#2265)", async () => {
  const { local, create, view, send } = await boot();
  const ws = await local();
  await create(ws, { title: "PBI: a", labels: ["type:pbi"] });
  await create(ws, { title: "PBI: b", labels: ["type:pbi"] });
  const own = (await create(ws, { title: "Task: t", labels: ["type:task"], parent: 1 })).body.localId as string;
  expect((await send("POST", "/api/backlog/3/comment", { workspaceId: ws.id, text: "first" })).status).toBe(202);
  expect((await send("POST", "/api/backlog/3/comment", { workspaceId: ws.id, text: "second" })).status).toBe(202);
  expect((await send("PATCH", "/api/backlog/3", { workspaceId: ws.id, labels: { add: ["needs-decision"], remove: [] }, parent: 2 })).status).toBe(202);
  const t = await view(ws, 3);
  expect(t).toMatchObject({ pending: 0, sync: { state: "synced" }, issue: { labels: ["type:task", "needs-decision"], parent: 2 } });
  // the comments in the order they were made, each with the id the parallel guard orders by
  expect(t.comments.map((c) => c.body)).toEqual(["first", "second"]);
  const ids = core!.db.listBacklogRecords(core!.db.getWorkspaceBacklogSource(ws.id)!, "comment").map((r) => r.externalId);
  expect(ids).toHaveLength(2);
  expect(ids.every((id) => /^sb:\d{12}$/.test(id))).toBe(true);
  expect((await view(ws, 1)).issue.subIssues).toEqual([]);
  expect((await view(ws, 2)).issue.subIssues).toEqual([3]);
  // a parent not there, or itself, is refused before anything is stored: the relationship stays as it was
  expect((await send("PATCH", "/api/backlog/3", { workspaceId: ws.id, parent: 99 })).status).toBe(422);
  expect((await send("PATCH", "/api/backlog/3", { workspaceId: ws.id, parent: 3 })).status).toBe(422);
  // by its local id too
  expect((await send("PATCH", `/api/backlog/${own}`, { workspaceId: ws.id, parent: 3, title: "Task: t2" })).status).toBe(422);
  expect((await view(ws, 3)).issue.title).toBe("Task: t");
  expect((await create(ws, { title: "Task: u", labels: ["type:task"], parent: 99 })).status).toBe(422);
  expect((await view(ws, 2)).issue.subIssues).toEqual([3]);
  expect((await view(ws, 3)).issue.parent).toBe(2);
  expect((await send("PATCH", "/api/backlog/3", { workspaceId: ws.id, state: "CLOSED" })).status).toBe(202);
  expect((await view(ws, 3)).issue).toMatchObject({ state: "CLOSED", closedAt: expect.any(String) });
});

test("a parent gone by the time it is applied drops that edit only; the old parent keeps its Task (#2265)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-local-apply-"));
  const db = new Db(join(dir, "switchboard.db"));
  try {
    const source = localBacklogSource("ws_x");
    db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: 1 });
    const make = (title: string, parent: number | null) => createStoredIssue(db, source, { title, body: "", labels: [], milestone: null, parent, fields: null });
    make("PBI", null);
    make("Task", null);
    expect(applyLocalOperations(db, source)).toBe(2);
    editStoredIssue(db, source, 2, { parent: 1 });
    editStoredIssue(db, source, 2, { title: "Task again" });
    applyLocalOperations(db, source);
    // not through the API (which refuses it first): a parent that is not there
    editStoredIssue(db, source, 2, { parent: 99 });
    editStoredIssue(db, source, 2, { title: "Task once more" });
    expect(applyLocalOperations(db, source)).toBe(2);
    const issues = Object.fromEntries(db.listBacklogRecords(source, "issue").map((r) => [(r.remote as { number: number }).number, r.remote as { parent: number | null; subIssues: number[]; title: string }]));
    expect(issues[2]).toMatchObject({ parent: 1, title: "Task once more" });
    expect(issues[1]!.subIssues).toEqual([2]);
    // dropped with its reason: not shown, not tried again
    expect(db.listPendingBacklogOperations(source)).toEqual([]);
    expect(applyLocalOperations(db, source)).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A local workspace with this repository's ops.config.json (its choices: Area / Kind / Priority / Phase, Story Points 1 2 3 5 8, Milestone `^Phase \\d+ — `). */
async function configured(t: Awaited<ReturnType<typeof boot>>, name = "configured") {
  const ws = await t.local(name);
  copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(ws.path, "ops.config.json"));
  return ws;
}

test("local fields take the choices of ops.config.json (#2265)", async () => {
  const t = await boot();
  const ws = await configured(t);
  const pbi = await t.create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": "5" }, milestone: "Phase 2 — デスクトップ化と自己更新" });
  expect(pbi.status).toBe(202);
  // Story Points as a number, as GitHub's number field would read
  expect((await t.view(ws, 1)).fields).toEqual({ Status: "Ready", Priority: "P1", "Story Points": 5 });
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { "Story Points": 3, Area: "core", Kind: "feature", Phase: "Phase 2" } })).status).toBe(202);
  for (const bad of [{ fields: { Status: "Todo" } }, { fields: { Priority: "P9" } }, { fields: { "Story Points": 4 } }, { fields: { Size: "L" } }, { fields: { toString: "x" } }, { fields: { constructor: null } }, { milestone: "v1.0" }]) {
    const r = await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, ...bad });
    expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 422]);
  }
  expect((await t.create(ws, { title: "PBI: y", labels: ["type:pbi"], fields: { Status: "Todo" } })).status).toBe(422);
  // nothing of the refused ones was stored
  expect((await t.view(ws, 1)).fields).toEqual({ Status: "Ready", Priority: "P1", "Story Points": 3, Area: "core", Kind: "feature", Phase: "Phase 2" });
  expect((await t.view(ws, 1)).issue.milestone).toBe("Phase 2 — デスクトップ化と自己更新");
  expect((await fetch(`${t.base}/api/backlog/2?workspaceId=${ws.id}`)).status).toBe(404);
  // a value taken off passes
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { Phase: null } })).status).toBe(202);
  // no ops.config.json: the kit's template gives the choices (#2361); what it has not, and any Milestone, is refused
  const bare = await t.local("bare");
  expect((await t.create(bare, { title: "PBI: z", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": 5 } })).status).toBe(202);
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, fields: { Area: "app", Kind: "feature", Status: "In progress" } })).status).toBe(202);
  for (const bad of [{ fields: { Area: "core" } }, { fields: { "Story Points": 4 } }, { fields: { Phase: "Phase 1" } }, { milestone: "Phase 1 — x" }]) {
    const r = await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, ...bad });
    expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 422]);
  }
  expect((await t.view(bare, 1)).fields).toEqual({ Status: "In progress", Priority: "P1", "Story Points": 5, Area: "app", Kind: "feature" });
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, title: "PBI: z2", labels: { add: ["needs-decision"], remove: [] } })).status).toBe(202);
  expect((await t.send("POST", "/api/backlog/1/comment", { workspaceId: bare.id, text: "c" })).status).toBe(202);
  // an ops.config.json that cannot be read is not replaced by the template
  const broken = await t.local("broken");
  writeFileSync(join(broken.path, "ops.config.json"), "{");
  expect((await t.create(broken, { title: "PBI: b", labels: ["type:pbi"], fields: { Status: "Ready" } })).status).toBe(422);
});

test("a local workspace without ops.config.json gets a PBI to ready (#2361)", async () => {
  const t = await boot();
  const ws = await t.local();
  expect((await t.create(ws, { title: "要望: x", labels: ["type:request"] })).status).toBe(202);
  expect((await t.create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": 5, Area: "app", Kind: "feature" } })).status).toBe(202);
  expect((await t.create(ws, { title: "Task: x", labels: ["type:task"], parent: 2, fields: { Status: "Backlog", Area: "app", Kind: "feature", Priority: "P1" } })).status).toBe(202);
  const item = (((await (await fetch(`${t.base}/api/backlog`)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === 2)!);
  expect(item.stage).toBe("ready");
});

test("a local PBI's Status decides its stage (#2265)", async () => {
  const t = await boot();
  const ws = await configured(t);
  await t.create(ws, { title: "PBI: x", labels: ["type:pbi"] });
  const stage = async () => (((await (await fetch(`${t.base}/api/backlog`)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === 1)!).stage;
  expect(await stage()).toBe("needs-tasks");
  await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, project: true, fields: { Status: "Ready" } });
  expect(await stage()).toBe("ready");
  await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { Status: "In progress" } });
  expect(await stage()).toBe("in-progress");
});

test("a local workspace's Task gets BACKLOG_WORKSPACE; a GitHub one does not (#2265)", async () => {
  const t = await boot();
  const ws = await t.local();
  await t.create(ws, { title: "PBI: x", labels: ["type:pbi"] });
  const before = envs.length;
  expect((await t.send("POST", "/api/backlog/1/start", { workspaceId: ws.id, action: "to-tasks" })).status).toBe(201);
  for (let i = 0; envs.length === before && i < 200; i++) await Bun.sleep(10);
  expect(envs.at(-1)).toMatchObject({ BACKLOG_WORKSPACE: ws.id, BACKLOG_URL: `${t.base}/api/backlog` });
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const n = envs.length;
  expect((await t.send("POST", "/api/tasks", { workspaceId: meta.id, cwd: meta.path, title: "x", prompt: "x", runner: "claude" })).status).toBe(201);
  for (let i = 0; envs.length === n && i < 200; i++) await Bun.sleep(10);
  expect(envs.at(-1)?.BACKLOG_URL).toBe(`${t.base}/api/backlog`);
  expect(envs.at(-1)).not.toHaveProperty("BACKLOG_WORKSPACE");
});
