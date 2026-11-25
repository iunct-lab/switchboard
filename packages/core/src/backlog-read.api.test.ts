// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, BacklogSource, RunnerAdapter, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { IDLE_TIMEOUT_SECONDS, startServer, type CoreServer } from "./server.ts";
import { Db } from "./db.ts";
import { readRecords, runBacklog } from "../../../ops-kit/src/backlog-client.ts";
import { main as opsKit } from "../../../ops-kit/src/cli.ts";
import { fakeGh as fakeKitGh } from "../../../ops-kit/src/gh.ts";
import { ghBoard, overlap, storedMaterial } from "../../../scripts/parallel-guard.ts";
import { mockupTaskOf, stageOf } from "./backlog-item.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { storedIssueHeads, readStoredIssue } from "./backlog-stored.ts";
import { answerStoredDecision, editStoredIssue } from "./backlog-edit.ts";
import { FAKE_ORIGIN, backlogNextSchedule, boot, closeTried, detailOf, fakeGh, fixtureStage, holdingClaude, metaId, overlapReadyGh, pages, patch, raw, refreshed, runSchedule, start, startedTasks, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("GET /api/backlog: stage per request / PBI, Project fields, Task counts, both pages", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const r = await fetch(`${base}/api/backlog`);
  expect(r.status).toBe(200);
  const body = await r.json() as Backlog;
  // the first look waits for the first import: nothing was stored before it
  expect(body.syncs).toEqual([{ workspaceId: expect.any(String), backlog: "github", enabling: null, repository: "acme/app", syncing: false, syncedAt: body.fetchedAt, creates: [], issues: [], sync: expect.objectContaining({ state: "synced", reason: null, lastSuccessfulSync: body.fetchedAt, guarantee: "A" }) }]);
  expect(body.items.map((i) => [i.number, i.type, i.stage])).toEqual([
    [306, "pbi", "needs-decision"], // label wins over Status In progress
    [305, "pbi", "in-progress"], // In review
    [304, "pbi", "ready"],
    [303, "pbi", "needs-tasks"], // Backlog
    [302, "request", "request"], // an Issue reference in the original body does not count; only the 派生 PBI section does
    // 301 names 303 under 派生 PBI → not returned
    [307, "pbi", "in-progress"], // In progress
    [308, "pbi", "in-progress"], // In review, with confirmations; the newest created first
  ]);
  expect(body.items[1]).toMatchObject({ priority: "P0", storyPoints: 5, tasks: { total: 3, done: 1, doneAt: expect.any(String) }, decision: null, url: "https://github.com/acme/app/issues/305", createdAt: "2026-09-20T05:00:00Z" });
  // Project 11's fields only (the item also sits in project 7 with Status Done)
  expect(body.items[2]).toMatchObject({ priority: "P2", storyPoints: 2, tasks: { total: 2, done: 0, doneAt: null } });
  expect(body.items[4]).toMatchObject({ priority: null, storyPoints: null, tasks: null });
  expect(typeof body.fetchedAt).toBe("number");
  // the meta workspace's directory is where gh runs, and the second page asks for the cursor
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(new Set(fake.cwds)).toEqual(new Set([meta.path]));
  expect(fake.calls.find((a) => a.includes("after=CURSOR1"))).toBeDefined();
});

test("GET /api/backlog: reads what is stored, without a gh call; ?refresh=1 imports again first", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const first = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  const n = fake.calls.length;
  expect((await fetch(`${base}/api/backlog`)).status).toBe(200);
  expect(fake.calls.length).toBe(n);
  const again = await (await fetch(`${base}/api/backlog?refresh=1`)).json() as Backlog;
  expect(fake.calls.length).toBeGreaterThan(n);
  // what a second import moves is each Issue's last successful read, nothing else
  const read = (b: Backlog) => b.items.map((i) => ({ ...i, sync: { ...i.sync, lastSuccessfulSync: null } }));
  expect(read(again)).toEqual(read(first));
  expect(again.items[0]!.sync.lastSuccessfulSync).toBeGreaterThanOrEqual(first.items[0]!.sync.lastSuccessfulSync!);
  expect(again.syncs.map((x) => x.syncing)).toEqual([false]);
});

test("developSelf off: the meta workspace is not read, others are", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const lib = mkdtempSync(join(home!, "lib-"));
  const other = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) })).json()) as { id: string };
  const patch = (developSelf: boolean) => fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf }) });
  const callsAt = (path: string) => fake.cwds.filter((c) => c === path).length;
  expect(((await (await fetch(`${base}/api/settings`)).json()) as { developSelf: boolean }).developSelf).toBe(true);
  // on: both are read
  const on = await refreshed(base);
  expect(new Set(on.items.map((i) => i.workspaceId))).toEqual(new Set([meta.id, other.id]));
  // off: no gh call in the meta workspace's directory, and no row, error or sync of it; the other one is still read
  expect((await patch(false)).status).toBe(200);
  const metaCalls = callsAt(meta.path);
  const libCalls = callsAt(lib);
  const off = await refreshed(base);
  expect(callsAt(meta.path)).toBe(metaCalls);
  expect(callsAt(lib)).toBeGreaterThan(libCalls);
  expect(new Set(off.items.map((i) => i.workspaceId))).toEqual(new Set([other.id]));
  expect(off.syncs.map((x) => x.workspaceId)).toEqual([other.id]);
  expect(off.errors.filter((e) => e.workspaceId === meta.id)).toEqual([]);
  const light = (await (await fetch(`${base}/api/backlog/syncs`)).json()) as { syncs: Array<{ workspaceId: string }> };
  expect(light.syncs.map((x) => x.workspaceId)).toEqual([other.id]);
  // back on: the next import reads it again, without a restart
  expect((await patch(true)).status).toBe(200);
  const back = await refreshed(base);
  expect(callsAt(meta.path)).toBeGreaterThan(metaCalls);
  expect(new Set(back.items.map((i) => i.workspaceId))).toEqual(new Set([meta.id, other.id]));
});

test("GET /api/backlog after a restart with GitHub failing, and from a restored backup: the stored list and questions, with the reason", async () => {
  const base = await boot(fakeGh().gh);
  const before = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(before.items.find((i) => i.number === 306)!.decision).not.toBeNull();
  const saved = home!;
  await core!.stop();
  core = undefined;
  const throwing: GhRunner = async () => { throw new Error("spawn gh ENOENT"); };
  const backup = mkdtempSync(join(tmpdir(), "sb-backlog-restored-"));
  try {
    for (const dir of [saved, backup]) {
      if (dir === backup) {
        const db = new Db(join(saved, "switchboard.db"));
        db.snapshotTo(join(backup, "switchboard.db"));
        db.close();
      }
      const cfg = loadConfig({ SWITCHBOARD_HOME: dir, SWITCHBOARD_KNOWLEDGE: join(dir, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(dir, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
      core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: throwing, backlogAutoImport: true }); // as the daemon starts
      const again = await refreshed(`http://127.0.0.1:${core.server.port}`, false);
      expect(again.items.map((i) => [i.number, i.stage, i.decision])).toEqual(before.items.map((i) => [i.number, i.stage, i.decision]));
      expect(again.fetchedAt).toBe(before.fetchedAt);
      expect(again.errors.map((e) => e.message)).toEqual([expect.stringContaining("ENOENT")]);
      await core.stop();
      core = undefined;
    }
  } finally {
    home = saved;
    rmSync(backup, { recursive: true, force: true });
  }
});

test("GET /api/backlog/:number: the stored body, comments and Project fields; 404 when not stored", async () => {
  const base = await boot(fakeGh().gh);
  await fetch(`${base}/api/backlog`);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const d = await (await fetch(`${base}/api/backlog/306?workspaceId=${meta.id}`)).json() as BacklogIssueDetail;
  expect(d).toMatchObject({ workspaceId: meta.id, fetchState: "fetched", issue: { number: 306, state: "OPEN", labels: ["type:pbi", "needs-decision"] }, fields: { Status: "In progress", Priority: "P1", "Story Points": 3 } });
  expect(d.comments.some((c) => c.body.startsWith("## 判断待ち"))).toBe(true);
  expect(d.comments.map((c) => c.createdAt)).toEqual(d.comments.map((c) => c.createdAt).sort());
  expect(typeof d.fetchedAt).toBe("number");
  expect((await fetch(`${base}/api/backlog/99999?workspaceId=${meta.id}`)).status).toBe(404);
  expect((await fetch(`${base}/api/backlog/306?workspaceId=nope`)).status).toBe(404);
});

test("GET /api/backlog: gh failing → the workspace and the reason in errors, never an empty list as if read (kind gh-login)", async () => {
  const base = await boot(fakeGh({ code: 1, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" + "x".repeat(400) }).gh);
  const r = await fetch(`${base}/api/backlog`);
  expect(r.status).toBe(200);
  const body = await r.json() as Backlog;
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(body.items).toEqual([]);
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0]).toMatchObject({ workspaceId: meta.id, workspaceName: meta.name });
  expect(body.errors[0]!.message).toContain("gh auth login");
  expect(body.errors[0]!.message.length).toBeLessThan(260);
  expect(body.errors[0]!.kind).toBe("gh-login");
});

test("GET /api/backlog: a Project the token cannot read is an error of that workspace, and what was stored stays, not every PBI as 分解待ち", async () => {
  let project: { code: number; stdout: string; stderr: string } | null = null;
  let broken = "";
  const base = await boot(fakeGh().gh, undefined, {}, undefined, (gh) => async (args, cwd) => (project && cwd === broken && args.some((a) => a.includes("ProjectV2FieldCommon{ name dataType }")) ? project : gh(args, cwd)));
  const stored = await refreshed(base);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const lib = mkdtempSync(join(home!, "lib-"));
  const other = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) })).json()) as { id: string };
  broken = meta.path;
  const message = "Project acme/11 を読めない（トークンの権限）";
  // the ways GitHub says so: a null Project and no error, a NOT_FOUND and exit 1 (both measured 2026-09-28), a FORBIDDEN
  for (const answer of [
    { code: 0, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: null } } }), stderr: "" },
    { code: 1, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: "FORBIDDEN", path: ["repositoryOwner", "projectV2"], message: "Resource not accessible by integration" }] }), stderr: "gh: Resource not accessible by integration" },
    { code: 1, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: null } }, errors: [{ type: "NOT_FOUND", path: ["repositoryOwner", "projectV2"], message: "Could not resolve to a ProjectV2 with the number 11." }] }), stderr: "gh: Could not resolve to a ProjectV2 with the number 11." },
  ]) {
    project = answer;
    const body = await refreshed(base);
    expect(body.errors).toEqual([{ workspaceId: meta.id, workspaceName: meta.name, message, kind: "other" }]);
    expect(body.items.filter((i) => i.workspaceId === meta.id).map((i) => [i.number, i.stage])).toEqual(stored.items.map((i) => [i.number, i.stage]));
    expect(body.items.filter((i) => i.workspaceId === other.id).length).toBeGreaterThan(0);
  }
  // a limit is not "the token cannot read it": it stays the limit it is
  project = { code: 1, stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), stderr: "" };
  expect((await refreshed(base)).errors[0]!.message).toContain("API rate limit exceeded");
});

test("GET /api/backlog: fetchedAt is the GitHub workspaces' import, not a workspace kept only here", async () => {
  const base = await boot(fakeGh().gh);
  const dir = mkdtempSync(join(home!, "local-"));
  copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(dir, "ops.config.json"));
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "local", backlog: "switchboard" }) })).json()) as { id: string };
  expect((await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "PBI: ローカル", labels: ["type:pbi"] }) })).status).toBe(202);
  const local = (await refreshed(base, false)).syncs.find((s) => s.workspaceId === ws.id)!.syncedAt!;
  await Bun.sleep(5);
  const body = await refreshed(base);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const imported = body.syncs.find((s) => s.workspaceId === meta.id)!.syncedAt!;
  expect(imported).toBeGreaterThan(local);
  expect(body.fetchedAt).toBe(imported);
});

test("GET /api/backlog: a malformed GraphQL answer is an error of that workspace, not zero items", async () => {
  const gh: GhRunner = async (args) =>
    args[0] === "repo" ? { code: 0, stdout: "acme/app true", stderr: "" }
    : args[0] === "variable" ? { code: 0, stdout: "https://github.com/users/acme/projects/11", stderr: "" }
    : { code: 0, stdout: '{"errors":[{"message":"rate limited"}]}', stderr: "" };
  const base = await boot(gh);
  const body = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(body.items).toEqual([]);
  expect(body.errors[0]!.message).toContain("rate limited");
});

test("GET /api/backlog: an answer without pageInfo, or a node of an unexpected shape, is an error of that workspace only", async () => {
  const ok = fakeGh();
  const dirs = { noPage: "", badNode: "" };
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "repo" && (cwd === dirs.noPage || cwd === dirs.badNode)) return { code: 0, stdout: `acme/${cwd === dirs.noPage ? "nopage" : "badnode"} true\n`, stderr: "" };
    if (args[0] === "api" && cwd === dirs.noPage) return { code: 0, stdout: '{"data":{"repository":{"issues":{"nodes":[]}}}}', stderr: "" };
    if (args[0] === "api" && cwd === dirs.badNode) return { code: 0, stdout: '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"number":1}]}}}}', stderr: "" };
    return ok.gh(args, cwd);
  };
  const base = await boot(gh);
  dirs.noPage = mkdtempSync(join(home!, "nopage-"));
  dirs.badNode = mkdtempSync(join(home!, "badnode-"));
  for (const [path, name] of [[dirs.noPage, "nopage"], [dirs.badNode, "badnode"]]) await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path, name }) });
  const body = await refreshed(base);
  expect(body.items).toHaveLength(7); // the meta workspace's
  expect(body.errors.map((e) => e.workspaceName).sort()).toEqual(["badnode", "nopage"]);
  expect(body.errors.find((e) => e.workspaceName === "nopage")!.message).toContain("形が想定と違います");
});

test("GET /api/backlog: a registered directory that is gone is an error of that workspace; the others still come", async () => {
  const base = await boot(fakeGh().gh);
  const gone = mkdtempSync(join(home!, "gone-"));
  await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: gone, name: "gone" }) });
  rmSync(gone, { recursive: true });
  const body = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(body.items).toHaveLength(7);
  expect(body.errors).toEqual([{ workspaceId: expect.any(String), workspaceName: "gone", message: "workspace directory does not exist", kind: "other" }]);
});

test("GET /api/backlog: every registered workspace; one that fails does not hide the others; each item names its workspace; cached per workspace", async () => {
  const ok = fakeGh();
  const dirs = { lib: "", broken: "" };
  const gh: GhRunner = async (args, cwd) => {
    if (cwd === dirs.broken) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (cwd === dirs.lib && args[0] === "repo") return { code: 0, stdout: "acme/lib true\n", stderr: "" };
    return ok.gh(args, cwd);
  };
  const base = await boot(gh);
  dirs.lib = mkdtempSync(join(home!, "lib-"));
  dirs.broken = mkdtempSync(join(home!, "broken-"));
  const add = async (path: string, name: string) => (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path, name }) })).json()) as { id: string };
  const lib = await add(dirs.lib, "lib");
  const broken = await add(dirs.broken, "broken");
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;

  const body = await refreshed(base);
  expect(body.items).toHaveLength(14);
  expect(body.items.filter((i) => i.workspaceId === meta.id && i.workspaceName === meta.name)).toHaveLength(7);
  expect(body.items.filter((i) => i.workspaceId === lib.id && i.workspaceName === "lib")).toHaveLength(7);
  expect(body.errors).toEqual([{ workspaceId: broken.id, workspaceName: "broken", message: expect.stringContaining("HTTP 404"), kind: "other" }]);

  // a plain read asks GitHub for none, the failed workspace neither (its import is asked again by 再読込)
  const calls = ok.cwds.length;
  const again = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(ok.cwds.length).toBe(calls);
  expect(again.errors).toEqual(body.errors);
});

test("startServer: passes Bun.serve an idleTimeout longer than Bun's default (10 s), so a response waiting on GitHub is not cut", async () => {
  const serve = spyOn(Bun, "serve");
  try {
    await boot(fakeGh().gh);
    const opts = serve.mock.calls[0]![0] as { idleTimeout?: number };
    expect(opts.idleTimeout).toBe(IDLE_TIMEOUT_SECONDS);
    expect(opts.idleTimeout!).toBeGreaterThan(12);
  } finally {
    serve.mockRestore();
  }
});

test("GET /api/backlog?refresh=1: workspaces are imported in parallel; the refresh waits about the slowest one", async () => {
  const ok = fakeGh();
  const dirs = { lib: "" };
  // an import reads the first page twice (the changed Issues, then the open ones): 1 s per workspace
  const gh: GhRunner = async (args, cwd) => {
    if (cwd === dirs.lib && args[0] === "repo") return { code: 0, stdout: "acme/lib true\n", stderr: "" };
    if (args[0] === "api" && !args.includes("after=CURSOR1") && !args.some((a) => a.includes("comments(last:"))) await Bun.sleep(500);
    return ok.gh(args, cwd);
  };
  const base = await boot(gh);
  dirs.lib = mkdtempSync(join(home!, "lib-"));
  await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dirs.lib, name: "lib" }) });

  const t0 = performance.now();
  const body = await (await fetch(`${base}/api/backlog?refresh=1`)).json() as Backlog;
  expect(performance.now() - t0).toBeLessThan(1_800);
  expect(body.items).toHaveLength(14);
  // still in the order of db.listWorkspaces(), as when read one after another
  expect(body.items.map((i) => i.workspaceId)).toEqual(core!.db.listWorkspaces().flatMap((w) => Array(7).fill(w.id)));
});

test("GET /api/backlog: a stage Task on the meta workspace marks the meta's #n only, not another repository's #n", async () => {
  const fake = fakeGh();
  const { adapter } = holdingClaude();
  const base = await boot(fake.gh, adapter);
  const lib = mkdtempSync(join(home!, "lib-"));
  await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) });
  await refreshed(base);
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
  const body = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const n304 = body.items.filter((i) => i.number === 304);
  expect(n304).toHaveLength(2);
  expect(n304.find((i) => i.workspaceId === meta.id)!.activeTaskId).toBeString();
  expect(n304.find((i) => i.workspaceId !== meta.id)!.activeTaskId).toBeNull();
});

/** A claude adapter whose turn ends at once: in error when the prompt says "fail", else ok (→ done). */
const endingClaude: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    queueMicrotask(() => emit({ t: "session.end", status: opts.prompt.includes("fail") ? "error" : "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};

test("GET /api/backlog: an in-progress item carries its Project Status, the Issue's updatedAt, and its last stage Task — a finished one and a failed one", async () => {
  const base = await boot(fakeGh().gh, endingClaude);
  const lib = mkdtempSync(join(home!, "lib-"));
  const libId = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) })).json()) as { id: string }).id;
  await refreshed(base);
  /** A Task created now and left finished; the newest one of an Issue is its last. */
  const run = async (workspaceId: string, title: string, prompt: string) => {
    const t = core!.tasks.create({ workspaceId, cwd: core!.db.getWorkspace(workspaceId)!.path, title, prompt, runner: "claude", stage: fixtureStage(title) });
    for (let i = 0; !["done", "error"].includes(core!.db.getTask(t.id)?.status ?? "") && i < 200; i++) await Bun.sleep(10);
    await Bun.sleep(5); // the next one is created later
    return core!.db.getTask(t.id)!;
  };
  const first = await run(metaId(), "#305 実装: PBI: 実装中の PBI", "fail");
  const done = await run(metaId(), "#305 実装: PBI: 実装中の PBI", "ok");
  const failed = await run(metaId(), "#307 実装: PBI: Task が全部閉じた実装中の PBI", "fail");
  const lib304 = await run(libId, "#304 実装: PBI: lib の Ready の PBI", "ok");
  const meta3040 = await run(metaId(), "#3040 実装: 別の番号", "ok"); // another number that shares a digit prefix
  expect([done.status, failed.status]).toEqual(["done", "error"]);
  // the same stop from both of Issue 305's Tasks is one series of 2; lib's Issue 304 and the meta's Issue 3040 are other work
  const merge = { id: "m", op: "gh pr merge", target: "PR #9", reason: "depends" as const, evidence: "CI", safety: "unknown" as const, conditions: [{ key: "pr#9", value: "open", met: false }], actions: [], state: "waiting" as const };
  for (const t of [first, done, lib304, meta3040]) expect(core!.tasks.recordStop(t.id, merge).ok).toBe(true);

  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const mine = (n: number) => items.find((i) => i.number === n && i.workspaceId === metaId())!;
  expect(mine(305)).toMatchObject({ projectStatus: "In review", updatedAt: "2026-09-27T05:00:00Z", lastTask: { id: done.id, status: "done", statusAt: done.statusAt, createdAt: done.createdAt, updatedAt: done.updatedAt }, activeTaskId: null });
  expect(typeof mine(305).lastTask!.statusAt).toBe("number"); // when it came to done, not when it was made
  expect(done.statusAt).toBeGreaterThanOrEqual(done.createdAt);
  expect(mine(307)).toMatchObject({ projectStatus: "In progress", updatedAt: "2026-09-12T07:00:00Z", lastTask: { id: failed.id, status: "error", statusAt: failed.statusAt, updatedAt: failed.updatedAt } });
  // no stage Task of its own: the other workspace's Issue 304 and the meta's Issue 3040 are not it
  expect(mine(304)).toMatchObject({ projectStatus: "Ready", lastTask: null });
  expect(items.find((i) => i.number === 304 && i.workspaceId === libId)!.lastTask).toMatchObject({ status: "done" });
  expect(mine(302)).toMatchObject({ projectStatus: null, lastTask: null, report: null });
  expect(mine(305).stopSummary).toMatchObject([{ op: "gh pr merge", count: 2, unchanged: true, work: { workspaceId: metaId(), issue: 305 } }]);
  expect(mine(304).stopSummary).toEqual([]);
  expect(items.find((i) => i.number === 304 && i.workspaceId === libId)!.stopSummary).toMatchObject([{ count: 1, work: { workspaceId: libId, issue: 304 } }]);
  expect(mine(307).stopSummary).toEqual([]);
  // the row reads replyWaiting from the daemon — Issue 305's last Task ended asking the person (needs_action, not reviewed)
  expect(mine(305).replyWaiting).toBe(false);
  core!.db.updateTask(done.id, { outcome: "needs_action" });
  const askedOf = async () => (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 305 && i.workspaceId === metaId())!;
  // the outcome alone decides: needs_action waits for the person whatever the newest stop (depends, waiting on CI) is
  expect((await askedOf()).replyWaiting).toBe(true);
  core!.db.updateTask(done.id, { outcome: "waits" });
  expect((await askedOf()).replyWaiting).toBe(false);
  core!.db.updateTask(done.id, { outcome: "needs_action" });
  expect(core!.tasks.recordStop(done.id, { ...merge, id: "d", op: "ask", reason: "decision", conditions: [] }).ok).toBe(true);
  expect((await askedOf()).replyWaiting).toBe(true);
  expect(mine(307).replyWaiting).toBe(false);
});

test("stageOf: a 派生 PBI heading inside the fenced original does not count", () => {
  const body = "## 原文\n\n````text\n## 派生 PBI\n- #999\n````\n\n## 派生 PBI\n（まだ無い）\n";
  expect(stageOf(raw(["type:request"], body), 11)).toBe("request");
  expect(stageOf(raw(["type:request"], "## 原文\n~~~\n## x\n~~~\n\n## 派生 PBI\n- #5\n"), 11)).toBeNull();
});

test("stageOf: PBI by Project Status of this Project only", () => {
  expect(stageOf(raw(["type:pbi"], "", "In progress"), 11)).toBe("in-progress");
  expect(stageOf(raw(["type:pbi"], "", "Ready"), 12)).toBe("needs-tasks");
  expect(stageOf(raw(["type:pbi"], ""), 11)).toBe("needs-tasks");
});

test("stage Tasks are found by their stage column: a renamed one still counts, a plain Task titled like one does not, another workspace's #n is not mixed in", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const item = async (n: number, workspaceId = metaId()) => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === n && i.workspaceId === workspaceId)!;
  // (a) a button's Task renamed by hand is still Issue 303's active and last Task
  const manual = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  expect(manual.stage).toEqual({ issue: 303, action: "to-tasks" });
  core!.db.updateTask(manual.id, { title: "名前を変えた" });
  expect(await item(303)).toMatchObject({ activeTaskId: manual.id, lastTask: { id: manual.id, action: "to-tasks" } });
  // (b) a plain Task whose title looks like a stage Task's counts for nothing: not active and not last
  core!.db.insertTask({ ...core!.db.getTask(manual.id)!, id: "tsk_plain306", title: "#306 実装: 普通の Task", status: "running", stage: null, createdAt: Date.now() + 1, updatedAt: Date.now() + 1 });
  expect(await item(306)).toMatchObject({ activeTaskId: null, lastTask: null });
  // (c) the same number in another workspace is another Issue
  const lib = mkdtempSync(join(home!, "lib-"));
  const libId = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) })).json()) as { id: string }).id;
  core!.db.insertTask({ ...core!.db.getTask(manual.id)!, id: "tsk_lib303", workspaceId: libId, cwd: lib, title: "lib の Task", stage: { issue: 304, action: "complete" }, status: "running", createdAt: Date.now() + 2, updatedAt: Date.now() + 2 });
  expect(await item(304)).toMatchObject({ activeTaskId: null, lastTask: null });
  expect(await item(304, libId)).toMatchObject({ activeTaskId: "tsk_lib303", lastTask: { id: "tsk_lib303" } });
  // and the plain Task titled like an 実装 holds no implement slot: backlog-next still starts Issue 304's
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toContain("#304 実装"); // the plain Task holds no implement slot
});

/* ---------- the kit's common commands on the stored backlog ---------- */

test("ops-kit backlog: reads answer what is stored with GitHub out of reach and no runner; an edit stores what the screen's does; --fresh with GitHub out of reach answers what is stored; no app is exit 2", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? (fake.calls.push(args), { code: 1, stdout: "", stderr: "HTTP 503" }) : fake.gh(args, cwd)));
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await runBacklog(argv, { BACKLOG_URL: `${base}/api/backlog`, GH_REPO: "acme/app" }, { out: (s) => out.push(s), err: (s) => out.push(s) });
    return { code, out: out.join("\n") };
  };
  const sync = (body: unknown) => fetch(`${base}/api/backlog/sync`, { method: "POST", body: JSON.stringify(body) });
  expect((await sync({ workspaceId: "nope" })).status).toBe(404);
  expect((await sync({})).status).toBe(400);
  // --fresh waits for the send and the import
  const before = fake.calls.length;
  expect((await cli("view", "304", "--fresh")).code).toBe(0);
  expect(fake.calls.length).toBeGreaterThan(before);
  down.on = true;
  const asked = fake.calls.length;
  const list = await cli("list");
  expect(list.code).toBe(0);
  expect(list.out).toContain("# acme/app  最終取得 ");
  expect(list.out).toContain("#304\tpbi\tOPEN\tReady\tPBI: Ready の PBI");
  const view = await cli("view", "305", "--json");
  expect(view.code).toBe(0);
  expect(JSON.parse(view.out)).toMatchObject({ issue: { number: 305, title: "PBI: 実装中の PBI" }, fields: { Status: "In review" } });
  expect(fake.calls.length).toBe(asked);
  // the same edit from the screen (303) and from the kit (305): the same values stored, as many operations waiting
  expect((await patch(base, 303, { title: "同じ題", fields: { Status: "Ready" } })).status).toBe(202);
  expect((await cli("edit", "305", "--title", "同じ題")).code).toBe(0);
  expect((await cli("set", "305", "Status", "Ready")).code).toBe(0);
  const [screen, kit] = [await detailOf(base, 303), await detailOf(base, 305)];
  expect(kit.issue.title).toBe(screen.issue.title);
  expect(kit.fields!.Status).toBe(screen.fields!.Status!);
  expect([kit.pending, kit.sync.state]).toEqual([screen.pending, screen.sync.state]);
  // a value that signs in is refused by the kit before the app sees it, and by the app (422) for a caller that skips the kit
  expect((await cli("edit", "305", "--title", "ghp_" + "a".repeat(36))).code).toBe(1);
  expect((await patch(base, 305, { title: "ghp_" + "a".repeat(36) })).status).toBe(422);
  expect((await detailOf(base, 305)).issue.title).toBe("同じ題");
  // --fresh asks for a send and an import; GitHub out of reach: the stored copy, said to be not synced
  const unsynced = await cli("list", "--fresh");
  expect([unsynced.code, unsynced.out.includes("GitHub 未同期"), unsynced.out.includes("#304")]).toEqual([0, true, true]);
  await core!.stop();
  core = undefined;
  expect((await cli("list")).code).toBe(2);
});

test("ops-kit backlog: a gate PBI is not made Ready without the key table, nor on a Task's answer to its question, nor after the table changed; the screen's answer to the question lets it", async () => {
  // PBI 304 has one Task, 3041, that names a file the merge gate covers; the kit asks the real script which paths those are
  const base = await boot(overlapReadyGh({ 304: "scripts/merge-gate.ts", 309: "src/b.ts", 310: "src/c.ts" }));
  const cli = async (argv: string[], stdin = "") => {
    const out: string[] = [];
    const code = await runBacklog(argv, { BACKLOG_URL: `${base}/api/backlog`, GH_REPO: "acme/app" }, { out: (s) => out.push(s), err: (s) => out.push(s), stdin: async () => stdin });
    return { code, out: out.join("\n") };
  };
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const readied = async () => (await cli(["set", "304", "Status", "Ready"])).code;
  const table = (key: string) => `## ゲートの鍵\n**鍵の変更**: あり\n| 鍵 | 誰が書けるか | どこで読むか | 利用者の操作（1 件あたり） |\n|---|---|---|---|\n| ${key} | a | b | c |\n`;
  const body = async () => ((await detailOf(base, 304)).issue.body).replace(/\n## ゲートの鍵[\s\S]*$/, "");
  const written = async (key: string) => (await cli(["edit", "304", "--body-file", "-", "--rev", (await detailOf(base, 304)).bodyRevision], `${await body()}\n${table(key)}`)).code;
  const screenAnswer = async () => {
    const at = (await detailOf(base, 304)).comments.filter((c) => c.body.startsWith("## 判断待ち")).at(-1)!.createdAt;
    answerStoredDecision(core!.db, core!.db.getWorkspaceBacklogSource(meta.id)!, 304, "はい", Date.now() + 5000, { question: { at }, screen: true, heads: {} });
  };
  // (1) no table
  expect(await readied()).toBe(1);
  expect((await cli(["set", "304", "Status", "Ready"])).out).toContain("ゲートの鍵");
  expect(await written("k1")).toBe(0);
  // (2) the table says あり: no question yet, then a question a Task answers with `backlog comment`, then the screen's answer
  expect(await readied()).toBe(1);
  expect((await cli(["comment", "304", "--body-file", "-"], `## 判断待ち\n${table("k1")}`)).code).toBe(0);
  expect(await readied()).toBe(1);
  expect((await cli(["comment", "304", "--body-file", "-"], "## 回答\nTask が書いた")).code).toBe(0);
  expect(await readied()).toBe(1);
  expect((await cli(["comment", "304", "--body-file", "-"], `## 判断待ち\n${table("k1")}`)).code).toBe(0);
  await screenAnswer();
  expect(await readied()).toBe(0);
  // (3) the table is changed after the answer
  expect(await written("k2")).toBe(0);
  expect(await readied()).toBe(1);
});

test("GET /api/backlog/records: lint and the parallel guard read the stored records with GitHub out of reach, --fresh too", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? (fake.calls.push(args), { code: 1, stdout: "", stderr: "HTTP 503" }) : fake.gh(args, cwd)));
  const env = { BACKLOG_URL: `${base}/api/backlog`, GH_REPO: "acme/app" };
  const fresh = await readRecords(env, { fresh: true });
  expect(fresh).toMatchObject({ repository: "acme/app", project: { number: expect.any(Number) }, unread: [] });
  const pbi = fresh.issues.find((i) => i.number === 304)!;
  expect([pbi.state, pbi.labels.includes("type:pbi"), pbi.fields?.Status]).toEqual(["OPEN", true, "Ready"]);
  down.on = true;
  const asked = fake.calls.length;
  expect(await readRecords(env, { fresh: false })).toEqual(fresh);
  // what the guard in a Task judges with besides the records: the checkout's shared files (the meta workspace is this checkout) and the places the app's own judgement counts
  expect(fresh).toMatchObject({ shared: expect.arrayContaining(["packages/core/src/server/context.ts"]), turns: [], unheld: [] });
  // the kit's lint: no GitHub call at all (the kit's gh throws on any), a finished check (0 or 1), never "could not check"
  const kitGh = fakeKitGh([]);
  const lines: string[] = [];
  const code = await opsKit(["lint", "--config", join(import.meta.dir, "../../../ops.config.json")], kitGh, (l) => lines.push(l), (l) => lines.push(l), async () => {}, env);
  expect([0, 1]).toContain(code);
  expect(lines.join("\n")).toContain("アプリの保存値を検査（acme/app");
  expect(kitGh.calls).toHaveLength(0);
  // the guard on a stored Task (the fixture's Issue 30400 names no path): judged from the records, so it gets to the paths, never to gh
  const noGh = async (): Promise<string> => { throw new Error("no gh"); };
  await expect(overlap({ ...ghBoard("acme/app", noGh), material: async () => storedMaterial(await readRecords(env, { fresh: false }), 30400) }, 30400, false)).rejects.toThrow("パスが無い");
  expect(fake.calls.length).toBe(asked);
  // --fresh with GitHub out of reach: the stored records, said to be not synced; lint checks them (0 or 1) and says so
  expect(await readRecords(env, { fresh: true })).toMatchObject({ ...fresh, unsynced: expect.stringContaining("GitHub 未同期") });
  const freshLines: string[] = [];
  expect([0, 1]).toContain(await opsKit(["lint", "--fresh", "--config", join(import.meta.dir, "../../../ops.config.json")], kitGh, () => {}, (l) => freshLines.push(l), async () => {}, env));
  expect(freshLines.join("\n")).toContain("GitHub 未同期");
  // an open PBI the last import could not read (403) is listed as last read and named unread: lint cannot check (exit 2)
  const source = core!.db.getWorkspaceBacklogSource(fresh.workspaceId)!;
  const rec = core!.db.listBacklogRecords(source, "issue").find((r) => (r.remote as { number: number } | null)?.number === 304)!;
  core!.db.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: null, fetchState: "forbidden" }], cursor: null, syncedAt: fresh.fetchedAt });
  const unread = await readRecords(env, { fresh: false });
  expect([unread.unread, unread.issues.some((i) => i.number === 304)]).toEqual([[304], true]);
  expect(await opsKit(["lint", "--config", join(import.meta.dir, "../../../ops.config.json")], kitGh, () => {}, () => {}, async () => {}, env)).toBe(2);
  // the unread one stays not checkable with --fresh too: GitHub out of reach does not make it read
  expect(await opsKit(["lint", "--fresh", "--config", join(import.meta.dir, "../../../ops.config.json")], kitGh, () => {}, () => {}, async () => {}, env)).toBe(2);
  // a workspace never imported answers 409, never an empty set of records
  const lib = mkdtempSync(join(home!, "lib-"));
  const libId = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: lib, name: "lib" }) })).json()) as { id: string }).id;
  expect((await fetch(`${base}/api/backlog/records?workspaceId=${libId}`)).status).toBe(409);
  expect((await fetch(`${base}/api/backlog/records?workspaceId=nope`)).status).toBe(404);
});

describe("GET /api/backlog — mockups", () => {
  test("mockupTaskOf: the first **画面イメージ** line outside fences, its first id; a full-width colon too", () => {
    expect(mockupTaskOf("## 元要望\n#1\n\n**Story Points**: 5\n**前提**: なし\n**画面イメージ**: task_1105031b45fa（Backlog の行）\n")).toBe("task_1105031b45fa");
    expect(mockupTaskOf("**画面イメージ**：tsk-a\n**画面イメージ**: tsk_b")).toBe("tsk-a");
    expect(mockupTaskOf("```\n**画面イメージ**: tsk_in_fence\n```\n")).toBeNull();
    expect(mockupTaskOf("```\n**画面イメージ**: tsk_in_fence\n```\n**画面イメージ**: tsk_out")).toBe("tsk_out");
    expect(mockupTaskOf("**画面イメージ**: \n")).toBeNull();
    expect(mockupTaskOf("本文だけ")).toBeNull();
  });

  test("a PBI naming a Task gives its HTML artifacts, not a removed one nor a text one; none for no line, an unknown Task, a request", async () => {
    const nodes = (pages as Array<{ data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } }>).flatMap((p) => p.data.repository.issues.nodes);
    const saved = new Map(nodes.map((n) => [n.number, n.body]));
    const line = (n: number, id: string) => (nodes.find((x) => x.number === n)!.body += `\n**画面イメージ**: ${id}\n`);
    line(304, "tsk_mock");
    line(305, "tsk_nowhere");
    line(302, "tsk_mock");
    try {
      const base = await boot(fakeGh().gh);
      const at = Date.now() - 60_000;
      core!.db.insertTask({ id: "tsk_mock", workspaceId: metaId(), title: "mockups", stage: null, runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });
      const add = async (name: string, body: string, title: string) => {
        writeFileSync(join(home!, name), body);
        const r = await fetch(`${base}/api/tasks/tsk_mock/artifacts`, { method: "POST", body: JSON.stringify({ source: join(home!, name), title }) });
        expect(r.status).toBe(201);
        return (await r.json()) as { id: string };
      };
      const a = await add("a.html", "<p>A</p>", "画面イメージ: 行の下");
      const b = await add("b.html", "<p>B</p>", "画面イメージ: 消した案");
      await add("notes.txt", "text", "メモ");
      expect((await fetch(`${base}/api/artifacts/${b.id}`, { method: "DELETE" })).status).toBe(200);
      const items = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items;
      const of = (n: number) => items.find((i) => i.number === n)!;
      expect(of(304).mockupTask).toBe("tsk_mock");
      expect(of(304).mockups.map((m) => [m.id, m.title, m.mime])).toEqual([[a.id, "画面イメージ: 行の下", "text/html"]]);
      expect(of(305)).toMatchObject({ mockupTask: "tsk_nowhere", mockups: [] });
      expect(of(302)).toMatchObject({ type: "request", mockupTask: null, mockups: [] });
      expect(of(303)).toMatchObject({ mockupTask: null, mockups: [] });
    } finally {
      for (const n of nodes) n.body = saved.get(n.number)!;
    }
  });
});

test("storedIssueHeads reads each stored Issue's state and title as readStoredIssue does", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-heads-"));
  const db = new Db(join(dir, "switchboard.db"));
  try {
    const source: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
    const data = (n: number, title: string, state: "OPEN" | "CLOSED") => ({ number: n, title, url: `https://github.com/acme/app/issues/${n}`, state, stateReason: null, body: "", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null });
    const rec = (externalId: string, v: ReturnType<typeof data>) => ({ objectKind: "issue" as const, externalId, fetchState: "fetched" as const, remote: v });
    const ws = db.upsertWorkspace({ name: "app", path: "/Users/dev/app", kind: "repo" });
    // Issue 5: an `sb:` record with the number of one of GitHub's, stored first
    db.putBacklogSnapshot(source, { records: [rec("sb:5", data(5, "ここで作った 5", "OPEN")), rec("I_5", data(5, "GitHub の 5", "CLOSED")), rec("I_1", data(1, "GitHub の 1", "OPEN")), rec("I_2", data(2, "GitHub の 2", "OPEN"))], cursor: null, syncedAt: 5000 });
    db.setWorkspaceBacklogSource(ws.id, source);
    editStoredIssue(db, source, 2, { state: "CLOSED", stateReason: "COMPLETED" }); // not sent yet
    const heads = storedIssueHeads(db, ws);
    expect([...heads.keys()].sort()).toEqual([1, 2, 5]);
    for (const [n, head] of heads) {
      const issue = readStoredIssue(db, ws, n)!.issue;
      expect(head).toEqual({ state: issue.state, title: issue.title });
    }
    expect(heads.get(2)!.state).toBe("CLOSED");
    expect(heads.get(5)).toEqual({ state: "CLOSED", title: "GitHub の 5" });
    expect(storedIssueHeads(db, { id: "ws_none" }).size).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
