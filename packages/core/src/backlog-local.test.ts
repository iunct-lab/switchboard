// test-reads: ops-kit/fixtures/config-with-phase.json
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { createStoredIssue, editStoredIssue } from "./backlog-edit.ts";
import { localBacklogSource, type GhRunner } from "./backlog-gh.ts";
import { applyLocalOperations, localForgeOf } from "./backlog-local.ts";
import { Db } from "./db.ts";

// A workspace whose backlog is kept in Switchboard only: no GitHub Issue or Project, and gh never asked for it.

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
/** What the app's own call to GitHub meets: by default there is no gh at all; a test may say GitHub answers 502. */
const github = { down: false };
async function boot() {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-local-"));
  github.down = false;
  const cwds: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    cwds.push(cwd);
    if (github.down && args.includes("rate_limit")) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway (https://api.github.com/rate_limit)" };
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

test("a workspace without GitHub registers, reads as imported and never calls gh", async () => {
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
  // a body with another place is 400; the same path again with the other place is 409 (switching is PATCH /api/workspaces/:id with backlog: "switchboard"), with none it stays
  expect((await add(dir("x"), "gitlab")).status).toBe(400);
  const nulled = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir("y"), backlog: null }) });
  expect(nulled.status).toBe(400);
  expect((await add(path, "github")).status).toBe(409);
  expect(((await (await add(path)).json()) as Workspace).backlog).toBe("switchboard");
});

test("two local workspaces keep their records apart", async () => {
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

test("a local workspace refuses projectVar", async () => {
  const { base, add, dir } = await boot();
  const ws = (await (await add(dir("local"), "switchboard")).json()) as Workspace;
  const res = await fetch(`${base}/api/workspaces/${ws.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVar: "OTHER_PROJECT_URL" }) });
  expect(res.status).toBe(409);
  // the source stays: it still reads as imported
  expect(core!.db.getWorkspaceBacklogSource(ws.id)?.service).toBe("switchboard");
});

test("a local create is numbered at once; a Task under it is its sub-issue", async () => {
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

test("a local Issue's stage starts by number", async () => {
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

test("two local workspaces both have an Issue 1 and keep them apart", async () => {
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

test("on-hold: a local label is added and removed the same way, and the list reads it", async () => {
  const { base, local, create, send } = await boot();
  const ws = await local();
  await create(ws, { title: "PBI: a", labels: ["type:pbi"] });
  const onHold = async () => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === 1)!.onHold;
  expect(await onHold()).toBe(false);
  expect((await send("PATCH", "/api/backlog/1", { workspaceId: ws.id, labels: { add: ["on-hold"], remove: [] } })).status).toBe(202);
  expect(await onHold()).toBe(true);
  expect((await send("PATCH", "/api/backlog/1", { workspaceId: ws.id, labels: { add: [], remove: ["on-hold"] } })).status).toBe(202);
  expect(await onHold()).toBe(false);
});

test("a local comment, label, state and parent change are applied at once", async () => {
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
  expect(t.comments[0]!.seq!).toBeLessThan(t.comments[1]!.seq!);
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

test("a parent gone by the time it is applied drops that edit only; the old parent keeps its Task", () => {
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

test("close reason: closed with a reason is that reason, without one COMPLETED, opened again null", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-local-reason-"));
  const db = new Db(join(dir, "switchboard.db"));
  try {
    const source = localBacklogSource("ws_x");
    db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: 1 });
    for (const title of ["dup", "done"]) createStoredIssue(db, source, { title, body: "", labels: [], milestone: null, parent: null, fields: null });
    applyLocalOperations(db, source);
    const reason = (n: number) => db.listBacklogRecords(source, "issue").map((r) => r.remote as { number: number; state: string; stateReason: string | null }).find((i) => i.number === n);
    editStoredIssue(db, source, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    editStoredIssue(db, source, 2, { state: "CLOSED" });
    applyLocalOperations(db, source);
    expect(reason(1)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(reason(2)).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
    // a closed one's reason changed: the state stays
    editStoredIssue(db, source, 2, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    applyLocalOperations(db, source);
    expect(reason(2)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    editStoredIssue(db, source, 1, { state: "OPEN" });
    applyLocalOperations(db, source);
    expect(reason(1)).toMatchObject({ state: "OPEN", stateReason: null });
    expect(db.listPendingBacklogOperations(source)).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A local workspace with the kit's example config that uses Phase (Priority, Phase 0 / 1; Story Points are the kit's scale 1 2 3 5 8 13, not the fixture's list; Milestone `^Phase \\d+ — `). This repository's own config has no Phase. */
async function configured(t: Awaited<ReturnType<typeof boot>>, name = "configured") {
  const ws = await t.local(name);
  copyFileSync(join(import.meta.dir, "../../../ops-kit/fixtures/config-with-phase.json"), join(ws.path, "ops.config.json"));
  return ws;
}

test("local fields take the choices of ops.config.json", async () => {
  const t = await boot();
  const ws = await configured(t);
  const pbi = await t.create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": "5" }, milestone: "Phase 1 — first" });
  expect(pbi.status).toBe(202);
  // Story Points as a number, as GitHub's number field would read
  expect((await t.view(ws, 1)).fields).toEqual({ Status: "Ready", Priority: "P1", "Story Points": 5 });
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { "Story Points": 3, Phase: "Phase 1" } })).status).toBe(202);
  for (const bad of [{ fields: { Status: "Todo" } }, { fields: { Priority: "P9" } }, { fields: { "Story Points": 4 } }, { fields: { Size: "L" } }, { fields: { Area: "one" } }, { fields: { Kind: "feature" } }, { fields: { toString: "x" } }, { fields: { constructor: null } }, { milestone: "v1.0" }]) {
    const r = await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, ...bad });
    expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 422]);
  }
  expect((await t.create(ws, { title: "PBI: y", labels: ["type:pbi"], fields: { Status: "Todo" } })).status).toBe(422);
  // nothing of the refused ones was stored
  expect((await t.view(ws, 1)).fields).toEqual({ Status: "Ready", Priority: "P1", "Story Points": 3, Phase: "Phase 1" });
  expect((await t.view(ws, 1)).issue.milestone).toBe("Phase 1 — first");
  expect((await fetch(`${t.base}/api/backlog/2?workspaceId=${ws.id}`)).status).toBe(404);
  // a value taken off passes
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { Phase: null } })).status).toBe(202);
  // the kit owns the Story Points scale: 13 passes even when the config still lists its own `storyPoints`
  const cfgPath = join(ws.path, "ops.config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), storyPoints: [1, 2, 3, 5, 8] }));
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { "Story Points": 13 } })).status).toBe(202);
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { "Story Points": 21 } })).status).toBe(422);
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { "Story Points": 3 } })).status).toBe(202);
  // no ops.config.json: the kit's template gives the choices; what it has not, and any Milestone, is refused
  const bare = await t.local("bare");
  expect((await t.create(bare, { title: "PBI: z", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": 5 } })).status).toBe(202);
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, fields: { Status: "In progress" } })).status).toBe(202);
  for (const bad of [{ fields: { Area: "app" } }, { fields: { Kind: "feature" } }, { fields: { "Story Points": 4 } }, { fields: { Phase: "Phase 1" } }, { milestone: "Phase 1 — x" }]) {
    const r = await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, ...bad });
    expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 422]);
  }
  expect((await t.view(bare, 1)).fields).toEqual({ Status: "In progress", Priority: "P1", "Story Points": 5 });
  expect((await t.send("PATCH", "/api/backlog/1", { workspaceId: bare.id, title: "PBI: z2", labels: { add: ["needs-decision"], remove: [] } })).status).toBe(202);
  expect((await t.send("POST", "/api/backlog/1/comment", { workspaceId: bare.id, text: "c" })).status).toBe(202);
  // an ops.config.json that cannot be read is not replaced by the template
  const broken = await t.local("broken");
  writeFileSync(join(broken.path, "ops.config.json"), "{");
  expect((await t.create(broken, { title: "PBI: b", labels: ["type:pbi"], fields: { Status: "Ready" } })).status).toBe(422);
});

test("a local workspace without ops.config.json gets a PBI to ready", async () => {
  const t = await boot();
  const ws = await t.local();
  expect((await t.create(ws, { title: "要望: x", labels: ["type:request"] })).status).toBe(202);
  expect((await t.create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", "Story Points": 5 } })).status).toBe(202);
  expect((await t.create(ws, { title: "Task: x", labels: ["type:task"], parent: 2, fields: { Status: "Backlog", Priority: "P1" } })).status).toBe(202);
  const item = (((await (await fetch(`${t.base}/api/backlog`)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === 2)!);
  expect(item.stage).toBe("ready");
});

test("a local PBI's Status decides its stage", async () => {
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

test("a local workspace's Task gets BACKLOG_WORKSPACE; a GitHub one does not", async () => {
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

test("PATCH backlog switchboard turns sync off and keeps the source", async () => {
  const { base, add, dir, send } = await boot();
  const gh = (await (await add(dir("gh"))).json()) as Workspace;
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  core!.db.setWorkspaceBacklogSource(gh.id, source);
  core!.db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: Date.now() });
  const never = (await (await add(dir("never"))).json()) as Workspace;
  // on already: nothing changes (turning it on is backlog-enable.test.ts)
  expect((await send("PATCH", `/api/workspaces/${gh.id}`, { backlog: "github" })).status).toBe(200);
  expect(core!.db.getWorkspaceBacklogSource(gh.id)).toEqual(source);
  expect((await send("PATCH", `/api/workspaces/${gh.id}`, { backlog: "gitlab" })).status).toBe(400);
  for (const ws of [gh, never]) expect((await send("PATCH", `/api/workspaces/${ws.id}`, { backlog: "switchboard" })).body.backlog).toBe("switchboard");
  // again: nothing changes
  expect((await send("PATCH", `/api/workspaces/${gh.id}`, { backlog: "switchboard" })).status).toBe(200);
  expect(core!.db.getWorkspaceBacklogSource(gh.id)).toEqual({ ...source, disabled: true });
  expect(core!.db.getWorkspaceBacklogSource(never.id)).toEqual(localBacklogSource(never.id));
  const all = (await (await fetch(`${base}/api/workspaces`)).json()) as Workspace[];
  expect([gh, never].map((w) => all.find((x) => x.id === w.id)?.backlog)).toEqual(["switchboard", "switchboard"]);
  const list = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect([gh, never].map((w) => list.syncs.find((s) => s.workspaceId === w.id)?.backlog)).toEqual(["switchboard", "switchboard"]);
  expect(list.errors.map((e) => e.workspaceId)).not.toContain(gh.id);
  expect((await send("PATCH", `/api/workspaces/${gh.id}`, { projectVar: "OTHER_PROJECT_URL" })).status).toBe(409);
});

test("GET /api/backlog/syncs answers the rows of GET /api/backlog's syncs and nothing else", async () => {
  const { base, add, dir } = await boot();
  const gh = (await (await add(dir("gh"))).json()) as Workspace;
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  core!.db.setWorkspaceBacklogSource(gh.id, source);
  core!.db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: 1_700_000_000_000 });
  const light = (await (await fetch(`${base}/api/backlog/syncs`)).json()) as Record<string, unknown>;
  const full = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect(Object.keys(light)).toEqual(["syncs"]);
  expect(light.syncs).toEqual(full.syncs);
  expect(full.syncs.find((s) => s.workspaceId === gh.id)).toMatchObject({ repository: "acme/app", syncedAt: 1_700_000_000_000, sync: { state: expect.any(String), pendingCount: 0 } });
});

/** A git repository in `path` with `main` and a branch `sb/9-x` one commit ahead; the tips. */
function gitRepo(path: string): { main: string; head: string } {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...args]);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  git("checkout", "-q", "-b", "sb/9-x");
  writeFileSync(join(path, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "b");
  git("checkout", "-q", "main");
  return { main: git("rev-parse", "main"), head: git("rev-parse", "sb/9-x") };
}

test("a local change: made, numbered with the Issues, commented, read with its tips and merged", async () => {
  const { base, local, create, view, send } = await boot();
  const ws = await local();
  const tips = gitRepo(ws.path);
  await create(ws, { title: "PBI: a", labels: ["type:pbi"] });
  const made = await create(ws, { title: "Task 9 の変更", body: "Closes #9", change: { head: "sb/9-x", base: "main" } });
  expect(made).toMatchObject({ status: 202, body: { number: 2 } });
  // numbered with the Issues, as GitHub numbers PRs
  expect((await create(ws, { title: "Task: next" })).body.number).toBe(3);
  // the review's summary and the triage's replies, oldest first
  for (const text of ["[claude] review\n要約", "振り分け\n| 指摘 | 振り分け | 返信 |"]) expect((await send("POST", "/api/backlog/2/comment", { workspaceId: ws.id, text })).status).toBe(202);
  const d = await view(ws, 2);
  expect(d.issue.change).toEqual({ head: "sb/9-x", base: "main", mergeCommit: null, mergedAt: null, reviewedHead: null, pr: null, reportedAt: null });
  expect(d.changeRefs).toEqual({ head: tips.head, base: tips.main });
  expect(d.comments.map((c) => c.body.split("\n")[0])).toEqual(["[claude] review", "振り分け"]);
  // an Issue is no change
  expect((await view(ws, 1)).changeRefs).toBeNull();
  const list = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect(list.changes).toEqual([{ workspaceId: ws.id, number: 2, title: "Task 9 の変更", state: "OPEN", head: "sb/9-x", base: "main", mergeCommit: null, mergedAt: null, updatedAt: expect.any(String), pr: null, reportedAt: null }]);
  // a workspace without PRs has none to stand in for
  expect((await create(ws, { title: "x", change: { head: "sb/9-x", base: "main", pr: 3 } })).status).toBe(422);
  // a branch not there is 422, a second open change of the same branch 409, head = base 422
  expect((await create(ws, { title: "x", change: { head: "sb/none", base: "main" } })).status).toBe(422);
  expect((await create(ws, { title: "x", change: { head: "sb/9-x", base: "nope" } })).status).toBe(422);
  expect((await create(ws, { title: "x", change: { head: "sb/9-x", base: "main" } })).status).toBe(409);
  expect((await create(ws, { title: "x", change: { head: "main", base: "main" } })).status).toBe(422);
  // not a branch name
  expect((await create(ws, { title: "x", change: { head: "--upload-pack=x", base: "main" } })).status).toBe(400);
  // merged: the commit stays with its branches; the change is closed
  const at = new Date().toISOString();
  expect((await send("PATCH", "/api/backlog/2", { workspaceId: ws.id, state: "CLOSED", change: { mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } })).status).toBe(202);
  expect((await view(ws, 2)).issue).toMatchObject({ state: "CLOSED", change: { head: "sb/9-x", base: "main", mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } });
  // an Issue cannot be merged; a closed change's branch can have a new one
  expect((await send("PATCH", "/api/backlog/1", { workspaceId: ws.id, state: "CLOSED", change: { mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } })).status).toBe(422);
  // the merge goes with the close; a closed change is not opened again
  expect((await send("PATCH", "/api/backlog/2", { workspaceId: ws.id, change: { mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } })).status).toBe(400);
  expect((await send("PATCH", "/api/backlog/2", { workspaceId: ws.id, state: "OPEN" })).status).toBe(422);
  expect((await create(ws, { title: "again", change: { head: "sb/9-x", base: "main" } })).status).toBe(202);
  // a reflog or a lock name is no branch
  for (const head of ["main@{0}", "sb/9-x.lock", "sb/", "/sb"]) expect((await create(ws, { title: "x", change: { head, base: "main" } })).status).toBe(400);
});

test("changes: every open one newest first, then the newest 10 closed", async () => {
  const { base, local, create, send } = await boot();
  const ws = await local();
  gitRepo(ws.path);
  // 13 changes of the same branch, each closed before the next; the last one stays open
  for (let i = 1; i <= 13; i++) {
    const n = (await create(ws, { title: `c${i}`, change: { head: "sb/9-x", base: "main" } })).body.number as number;
    if (i < 13) expect((await send("PATCH", `/api/backlog/${n}`, { workspaceId: ws.id, state: "CLOSED" })).status).toBe(202);
  }
  const list = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect(list.changes.map((c) => c.title)).toEqual(["c13", "c12", "c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4", "c3"]);
});

test("change in a github workspace: kept apart from GitHub's Issues, numbered from 1, never sent", async () => {
  const { base, add, dir, send } = await boot();
  const gh = (await (await add(dir("gh"))).json()) as Workspace;
  const tips = gitRepo(gh.path);
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  core!.db.setWorkspaceBacklogSource(gh.id, source);
  const issue = (n: number) => ({ number: n, title: `Issue ${n}`, url: "", state: "OPEN" as const, stateReason: null, body: "", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", closedAt: null });
  core!.db.putBacklogSnapshot(source, { records: Array.from({ length: 40 }, (_, i) => ({ objectKind: "issue" as const, externalId: `I_${i + 1}`, remote: issue(i + 1), fetchState: "fetched" as const })), cursor: null, syncedAt: Date.now() });
  // a change stands in for a pull request only while the app itself sees GitHub out of use: a gh that cannot even be
  // started is no such sight (nothing says GitHub is away), and nothing is made
  const refused = await send("POST", "/api/backlog", { workspaceId: gh.id, title: "Task 9 の変更", body: "Closes #9", change: { head: "sb/9-x", base: "main", pr: 77 } });
  expect([refused.status, (refused.body as { error: string }).error]).toEqual([409, expect.stringContaining("一時的に使えないとは確かめられませんでした")]);
  expect((await fetch(`${base}/api/backlog/1?workspaceId=${gh.id}&change=1`)).status).toBe(404);
  expect(await (await fetch(`${base}/api/backlog/outage?workspaceId=${gh.id}`)).json()).toMatchObject({ apart: true, unusable: false, reason: "unknown" });
  github.down = true;
  expect(await (await fetch(`${base}/api/backlog/outage?workspaceId=${gh.id}`)).json()).toMatchObject({ apart: true, unusable: true, kind: "transient" });
  const made = await send("POST", "/api/backlog", { workspaceId: gh.id, title: "Task 9 の変更", body: "Closes #9", change: { head: "sb/9-x", base: "main", pr: 77 } });
  // not 41: GitHub's numbers are not taken
  expect(made).toMatchObject({ status: 202, body: { number: 1 } });
  const get = async (q: string) => {
    const r = await fetch(`${base}/api/backlog/1?workspaceId=${gh.id}${q}`);
    return { status: r.status, body: (await r.json()) as BacklogIssueDetail };
  };
  const change = await get("&change=1");
  expect(change.body.issue).toMatchObject({ number: 1, title: "Task 9 の変更", change: { head: "sb/9-x", base: "main", pr: 77, reportedAt: null } });
  expect(change.body.changeRefs).toEqual({ head: tips.head, base: tips.main });
  // without the mark, 1 is GitHub's Issue
  expect((await get("")).body.issue).toMatchObject({ number: 1, title: "Issue 1" });
  expect((await get("")).body.issue.change).toBeUndefined();
  // a comment on the change does not land on GitHub's Issue 1
  expect((await send("POST", "/api/backlog/1/comment?change=1", { workspaceId: gh.id, text: "[claude] review\n要約" })).status).toBe(202);
  expect((await get("&change=1")).body.comments.map((c) => c.body.split("\n")[0])).toEqual(["[claude] review"]);
  expect((await get("")).body.comments).toEqual([]);
  // merged, then its summary left: both on the change alone
  const at = new Date().toISOString();
  expect((await send("PATCH", "/api/backlog/1?change=1", { workspaceId: gh.id, state: "CLOSED", change: { mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } })).status).toBe(202);
  expect((await send("PATCH", "/api/backlog/1?change=1", { workspaceId: gh.id, change: { reportedAt: at } })).status).toBe(202);
  expect((await get("&change=1")).body.issue).toMatchObject({ state: "CLOSED", change: { mergeCommit: tips.head, pr: 77, reportedAt: at } });
  expect((await get("")).body.issue.state).toBe("OPEN");
  // the list has it, with the PR it stood in for
  const list = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  expect(list.changes.filter((c) => c.workspaceId === gh.id)).toMatchObject([{ number: 1, state: "CLOSED", pr: 77, reportedAt: at, mergeCommit: tips.head }]);
  // a change is no Issue of GitHub's: a merge record without the mark is refused, a number that is no change is 404
  expect((await send("PATCH", "/api/backlog/2", { workspaceId: gh.id, state: "CLOSED", change: { mergeCommit: tips.head, mergedAt: at, reviewedHead: tips.head } })).status).toBe(422);
  expect((await fetch(`${base}/api/backlog/2?workspaceId=${gh.id}&change=1`)).status).toBe(404);
  expect((await send("POST", "/api/backlog/2/comment?change=1", { workspaceId: gh.id, text: "x" })).status).toBe(404);
  expect((await send("PATCH", "/api/backlog/2?change=1", { workspaceId: gh.id, title: "x" })).status).toBe(404);
  // nothing of it was ever queued for GitHub: the send has nothing to send
  expect(core!.db.listBacklogOperations(source)).toEqual([]);
});

test("localForgeOf: no origin is the app's; an origin is not; a forge naming the app is, one that cannot be read is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-local-forge-"));
  try {
    Bun.spawnSync(["git", "init", "-q", dir]);
    expect(localForgeOf(dir)).toBe(true);
    Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/example/app.git"]);
    expect(localForgeOf(dir)).toBe(false);
    writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "app" } }));
    expect(localForgeOf(dir)).toBe(true);
    writeFileSync(join(dir, "ops.config.json"), "{");
    expect(localForgeOf(dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("choice: a GitHub workspace's field values are fixed to the config's spelling or refused before they are stored", async () => {
  const { add, dir, send, create, local, view } = await boot();
  const gh = (await (await add(dir("gh"))).json()) as Workspace;
  const source = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
  core!.db.setWorkspaceBacklogSource(gh.id, source);
  core!.db.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: "gh:issue:1", fetchState: "fetched", remote: { number: 1, title: "A", url: "", state: "OPEN", stateReason: null, body: "", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", closedAt: null } }], cursor: null, syncedAt: Date.now() });
  // (a) a create is stored with the choices' spelling
  const made = await create(gh, { title: "x", fields: { Status: "In Progress", Priority: "p2" } });
  expect(made.status).toBe(202);
  const op = core!.db.listPendingBacklogOperations(source).find((o) => o.kind === "create")!;
  expect((op.payload as { project: { fields: unknown } }).project.fields).toEqual({ Status: "In progress", Priority: "P2" });
  // (b) a value that is no choice (and an empty text) is 422 with the choices; nothing waits more
  const before = core!.db.listPendingBacklogOperations(source).length;
  for (const fields of [{ Status: "Doing" }, { "Story Points": "" }]) {
    const r = await send("PATCH", `/api/backlog/1`, { workspaceId: gh.id, fields });
    expect(r.status).toBe(422);
    expect(r.body.error).toContain(" / ");
  }
  expect((await create(gh, { title: "y", fields: { Priority: "P9" } })).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations(source).length).toBe(before);
  // null takes a value off and passes
  expect((await send("PATCH", `/api/backlog/1`, { workspaceId: gh.id, fields: { Priority: null } })).status).toBe(202);
  // (c) a field without choices passes as it is
  expect((await send("PATCH", `/api/backlog/1`, { workspaceId: gh.id, fields: { Notes: "x" } })).status).toBe(202);
  // (d) a workspace without GitHub fixes the case too
  const ws = await local();
  const m = await create(ws, { title: "z", fields: { Status: "in review" } });
  expect(m.status).toBe(202);
  expect((await view(ws, m.body.number)).fields?.Status).toBe("In review");
});

test("project fields: a workspace without GitHub gets the field definitions from the config's choices", async () => {
  const { local, create, view } = await boot();
  const ws = await local();
  const made = await create(ws, { title: "題", body: "本文" });
  expect(made.status).toBe(202);
  const defs = (await view(ws, made.body.number)).projectFields;
  expect(defs.map((f) => f.name)).toEqual(["Status", "Priority", "Story Points"]);
  expect(defs[0]).toMatchObject({ dataType: "SINGLE_SELECT", options: expect.arrayContaining(["Backlog", "Ready"]) });
  expect(defs[2]).toEqual({ name: "Story Points", dataType: "NUMBER", options: [] });
});

test("a repository with no ops.config.json takes the choices of the settings kept on Switchboard's side; its own file, once it has one, is used alone", async () => {
  const { add, dir, send, create, local, view, base } = await boot();
  const kept = readFileSync(join(import.meta.dir, "../../../ops-kit/fixtures/config-with-phase.json"), "utf8");
  // the backlog's form only (no key the gates read): the page's save is in force at once
  const save = async (ws: Workspace, config: string) => {
    const r = await fetch(`${base}/api/workspaces/${ws.id}/config`, { method: "PUT", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ config }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { pending: unknown }).pending).toBeNull();
  };
  // a backlog kept here: Phase and the Milestone come from the saved settings (the kit's template has neither)
  const ws = await local("kept");
  expect((await create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", Phase: "Phase 1" }, milestone: "Phase 1 — first" })).status).toBe(422);
  await save(ws, kept);
  expect((await create(ws, { title: "PBI: x", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1", Phase: "Phase 1" }, milestone: "Phase 1 — first" })).status).toBe(202);
  expect((await view(ws, 1)).projectFields.map((f) => f.name)).toEqual(["Status", "Priority", "Phase", "Story Points"]);
  const refused = await send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { Size: "L" } });
  expect(refused.status).toBe(422);
  expect(refused.body.error).toContain("Switchboard の側の設定");
  // nothing was written to the repository
  expect(existsSync(join(ws.path, "ops.config.json"))).toBe(false);
  // the repository's own file wins as a whole: a key it leaves out (Phase) is not taken from the saved settings
  const own = JSON.parse(kept) as { fields: { phase?: unknown } };
  delete own.fields.phase;
  writeFileSync(join(ws.path, "ops.config.json"), JSON.stringify(own));
  expect((await send("PATCH", "/api/backlog/1", { workspaceId: ws.id, fields: { Phase: "Phase 0" } })).status).toBe(422);
  expect((await view(ws, 1)).projectFields.map((f) => f.name)).toEqual(["Status", "Priority", "Story Points"]);
  // a backlog on GitHub: the choices' spelling is fixed from the saved settings too
  const gh = (await (await add(dir("gh-kept"))).json()) as Workspace;
  const source = { service: "github" as const, host: "github.com", repository: "acme/kept", project: { owner: "acme", number: 1 } };
  core!.db.setWorkspaceBacklogSource(gh.id, source);
  await save(gh, kept);
  expect((await create(gh, { title: "x", fields: { Phase: "phase 1" } })).status).toBe(202);
  expect((core!.db.listPendingBacklogOperations(source).find((o) => o.kind === "create")!.payload as { project: { fields: unknown } }).project.fields).toEqual({ Phase: "Phase 1" });
  expect((await create(gh, { title: "y", fields: { Phase: "Phase 9" } })).status).toBe(422);
});

