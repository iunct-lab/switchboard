// test-reads: ops-kit/processes/p3-bundle.md
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BundleHold, Provenance, RunnerAdapter, Schedule, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { localBacklogSource } from "./backlog-gh.ts";
import type { BacklogSnapshotEntry } from "./db.ts";
import { bundleRoutes } from "./routes/bundle.ts";
import { Scheduler } from "./scheduler.ts";
import type { TaskManager } from "./tasks/manager.ts";

// 束: the hold and the Task go through the route and server/bundle.ts as they are; only the runner is fake.

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const started: StartOptions[] = [];
const issue = (number: number, labels: string[], state: "OPEN" | "CLOSED" = "OPEN"): BacklogSnapshotEntry => ({
  objectKind: "issue", externalId: `node_${number}`, fetchState: "fetched",
  remote: { number, title: `Issue ${number}`, url: "", state, stateReason: state === "CLOSED" ? "COMPLETED" : null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", closedAt: null } satisfies BacklogIssueData,
} as BacklogSnapshotEntry);

async function boot(opts: { runner?: boolean; cfg?: ReturnType<typeof loadConfig>; reuse?: { root: string } } = {}) {
  started.length = 0;
  root = opts.reuse?.root ?? mkdtempSync(join(tmpdir(), "switchboard.bundle."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  if (!opts.reuse) {
    for (const d of [home, repoRoot, join(repoRoot, "ops-kit")]) mkdirSync(d, { recursive: true });
    cpSync(join(import.meta.dir, "../../../ops-kit/processes"), join(repoRoot, "ops-kit/processes"), { recursive: true });
  }
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const adapters: RunnerAdapter[] = opts.runner === false ? [] : [{
    id: "claude", detect: async () => ({ available: true }),
    start(o, emit) {
      started.push(o);
      queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  }];
  core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const source = localBacklogSource(meta.id);
  core.db.setWorkspaceBacklogSource(meta.id, source);
  // two open PBIs, an open Task, a closed PBI
  core.db.putBacklogSnapshot(source, { records: [issue(11, ["type:pbi"]), issue(12, ["type:pbi"]), issue(13, ["type:task"]), issue(14, ["type:pbi"], "CLOSED")], cursor: null, syncedAt: Date.now() });
  const post = async (body: unknown) => {
    const r = await fetch(`${base}/api/bundle`, { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Task & { error?: string } };
  };
  const hold = async () => (await (await fetch(`${base}/api/bundle`)).json()) as BundleHold | null;
  const release = async () => (await (await fetch(`${base}/api/bundle`, { method: "DELETE" })).json()) as { released: boolean; restored: string[] };
  const schedules = async () => (await (await fetch(`${base}/api/schedules`)).json()) as Schedule[];
  const schedule = async (title: string, enabled: boolean) => (await (await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title, cron: "0 3 * * *", workspaceId: meta.id, runner: "claude", prompt: "go", enabled }) })).json()) as Schedule;
  const enable = (id: string, enabled: boolean) => fetch(`${base}/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  const remove = (id: string) => fetch(`${base}/api/schedules/${id}`, { method: "DELETE" });
  return { base, root, meta, post, hold, release, schedules, schedule, enable, remove };
}

test("starts one Task under p3-bundle", async () => {
  const b = await boot();
  const r = await b.post({ pbis: [11, 12] });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.meta.id, title: "まとめて入れる: #11, #12" });
  const prov = (await (await fetch(`${b.base}/api/tasks/${r.body.id}/provenance`)).json()) as Provenance;
  expect(prov.process?.id).toBe("p3-bundle");
  expect(prov.processReason).toBe("bundle button");
  for (let i = 0; !started.length && i < 100; i++) await Bun.sleep(10);
  expect(started[0]!.prompt).toContain("#11, #12");
  expect(core!.db.listTasks()).toHaveLength(1);
  expect((await b.hold())?.taskId).toBe(r.body.id);
});

test("provenance issues: the PBIs a bundle was started with stay on its Task, sorted; another entrance leaves null", async () => {
  const b = await boot();
  const r = await b.post({ pbis: [12, 11] });
  expect(r.status).toBe(201);
  const prov = async (id: string) => (await (await fetch(`${b.base}/api/tasks/${id}/provenance`)).json()) as Provenance;
  expect((await prov(r.body.id)).issues).toEqual([11, 12]);
  // a body that names Issues (and the bundle's process) on another entrance does not get them recorded
  const other = await fetch(`${b.base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId: b.meta.id, prompt: "x", runner: "claude", process: "p3-bundle", issues: [7] }) });
  expect(other.status).toBe(201);
  expect((await prov(((await other.json()) as Task).id)).issues).toBeNull();
});

test("refuses fewer than two PBIs", async () => {
  const b = await boot();
  const refused = [{ pbis: [11] }, { pbis: [11, 11] }, { pbis: [11, 13] }, { pbis: [11, 14] }, { pbis: [11, 99] }, { pbis: [] }, null];
  for (const body of refused) expect((await b.post(body)).status).toBe(400);
  // the number that is not an open PBI is named
  expect((await b.post({ pbis: [11, 13] })).body.error).toContain("#13");
  expect(core!.db.listTasks()).toHaveLength(0);
  expect(await b.hold()).toBeNull();
});

test("holds every enabled schedule and keeps the hold across a restart", async () => {
  const b = await boot();
  const on1 = await b.schedule("a", true);
  const on2 = await b.schedule("b", true);
  const off = await b.schedule("c", false);
  // the daemon's own default schedules are held too: whatever is enabled now
  const enabled = (await b.schedules()).filter((s) => s.enabled).map((s) => s.id).sort();
  expect(enabled).toEqual(expect.arrayContaining([on1.id, on2.id]));
  expect(enabled).not.toContain(off.id);
  const r = await b.post({ pbis: [11, 12] });
  expect(r.status).toBe(201);
  const held = await b.hold();
  expect([...held!.schedules].sort()).toEqual(enabled);
  expect((await b.schedules()).every((s) => !s.enabled)).toBe(true);
  await core!.stop();
  const b2 = await boot({ reuse: { root: b.root } });
  expect(await b2.hold()).toEqual(held!);
  expect((await b2.schedules()).find((s) => s.id === off.id)?.enabled).toBe(false);
});

test("a second bundle is refused while one holds", async () => {
  const b = await boot();
  // two at once: one starts, the other is refused
  const both = await Promise.all([b.post({ pbis: [11, 12] }), b.post({ pbis: [11, 12] })]);
  expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  expect((await b.post({ pbis: [11, 12] })).status).toBe(409);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("a start still under way refuses a second, and the hold keeps the running version", async () => {
  // the route alone, so that the first start can be held inside its wait for the running version
  const b = await boot();
  let answer!: (v: { managed: true; current: string }) => void;
  const status = new Promise<{ managed: true; current: string }>((r) => (answer = r));
  let tasks = 0;
  const route = bundleRoutes({
    json: (data, code = 200) => Response.json(data, { status: code }),
    bad: (error, code = 400) => Response.json({ error }, { status: code }),
    db: core!.db,
    scheduler: new Scheduler(core!.db, {} as TaskManager),
    metaWorkspace: () => b.meta,
    settings: () => ({ reviewRunner: "other" }) as never,
    releaseStatus: () => status as never,
    startMetaTask: async () => ({ task: { id: `tsk_${++tasks}` } }) as never,
  })["/api/bundle"] as { POST: (req: Request) => Promise<Response> };
  const post = () => route.POST(new Request("http://x/api/bundle", { method: "POST", body: JSON.stringify({ pbis: [11, 12] }) }));
  const first = post();
  const second = await post();
  expect([second.status, await second.json()]).toEqual([409, { error: "束を始めている途中です" }]);
  answer({ managed: true, current: "abc123" });
  expect((await first).status).toBe(201);
  expect(tasks).toBe(1);
  expect(await b.hold()).toMatchObject({ taskId: "tsk_1", base: "abc123" });
});

test("no hold when the Task does not start", async () => {
  const b = await boot({ runner: false });
  const s = await b.schedule("a", true);
  const r = await b.post({ pbis: [11, 12] });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(core!.db.listTasks()).toHaveLength(0);
  expect(await b.hold()).toBeNull();
  expect((await b.schedules()).find((x) => x.id === s.id)?.enabled).toBe(true);
});

test("release restores only the held schedules", async () => {
  const b = await boot();
  const a = await b.schedule("a", true);
  const gone = await b.schedule("b", true);
  const other = await b.schedule("c", false);
  const enabledBefore = (await b.schedules()).filter((s) => s.enabled).map((s) => s.id);
  await b.post({ pbis: [11, 12] });
  // meanwhile the person turns one on that the hold did not stop, and deletes one it did
  await b.enable(other.id, true);
  await b.remove(gone.id);
  const done = await b.release();
  expect(done.released).toBe(true);
  expect([...done.restored].sort()).toEqual(enabledBefore.filter((id) => id !== gone.id).sort());
  expect(done.restored).toContain(a.id);
  // the one the person turned on was not the hold's, and the deleted one is not back
  expect(done.restored).not.toContain(other.id);
  const now = await b.schedules();
  expect(now.find((s) => s.id === other.id)?.enabled).toBe(true);
  expect(now.some((s) => s.id === gone.id)).toBe(false);
  expect(await b.hold()).toBeNull();
});

test("a second release does nothing", async () => {
  const b = await boot();
  const a = await b.schedule("a", true);
  await b.post({ pbis: [11, 12] });
  expect((await b.release()).released).toBe(true);
  // the person turns it off afterwards: a release without a hold leaves it so
  await b.enable(a.id, false);
  expect(await b.release()).toEqual({ released: false, restored: [] });
  expect((await b.schedules()).find((s) => s.id === a.id)?.enabled).toBe(false);
  // and a bundle can begin again
  expect((await b.post({ pbis: [11, 12] })).status).toBe(201);
});
