import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Backlog, BacklogAction, BacklogIssueDetail, BacklogItem, RunnerAdapter, StartOptions, Task, TaskStatus } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import type { Suggester } from "./routing.ts";
import { startServer, type CoreServer } from "./server.ts";
import { Db } from "./db.ts";
import { importing } from "../fixtures/github-import.ts";
import { readRecords, runBacklog } from "../../../ops-kit/src/backlog-client.ts";
import { main as opsKit } from "../../../ops-kit/src/cli.ts";
import { fakeGh as fakeKitGh } from "../../../ops-kit/src/gh.ts";
import { ghBoard, overlap, storedMaterial } from "../../../scripts/parallel-guard.ts";
import { fmtTime } from "./ratelimit.ts";
import { buildStartPrompt, canStartStoredBacklog, confirmationsOf, prereqsOf, prereqState, type WaitTarget, GithubBudgetCache, holdStoredDecision, otherRepoRules, pickNext, promotionStep, reportPromoteFailure, stageOf, spinningIn, tasksDoneMark, TASKS_DONE_MARK, unchangedIn, heldIn, type GhRunner, type RawBacklogIssue, type ReleaseState, awaitingReply, failedIn, failedSince, replyWaitingIn, stopHeld } from "./backlog.ts";

// the writer of the waits (#817), read at run time: scripts/ is not type-checked under core's settings
const guard = "../../../scripts/parallel-guard.ts";
const { releaseBody } = (await import(guard)) as { releaseBody: (reason: string, waits?: number[], overlap?: boolean) => string };
const FIXTURE_STAGE_NAMES: Record<string, BacklogAction> = { "PBI にする": "to-pbi", "Task に分解": "to-tasks", "実装": "complete", "状況確認": "check", "閉じる": "close" };
/** The `stage` a fixture Task gets from its title, as the button's Task would have it. */
const fixtureStage = (title: string): Task["stage"] => {
  const m = /^#(\d+) (PBI にする|Task に分解|実装|状況確認|閉じる): /.exec(title);
  return m ? { issue: Number(m[1]), action: FIXTURE_STAGE_NAMES[m[2]!]! } : null;
};

const pages = await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json() as unknown[];
const decisions = await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json() as unknown;

/** A fake `gh` answering from the fixtures: two GraphQL pages (the second after CURSOR1), the needs-decision comments, issue writes. */
function fakeGh(fail?: { code: number; stderr: string }, failIssueWrite = false) {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args);
    cwds.push(cwd);
    if (fail) return { code: fail.code, stdout: "", stderr: fail.stderr };
    if (args[0] === "repo") return { code: 0, stdout: "acme/app\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
    if (args[0] === "issue") return failIssueWrite ? { code: 1, stdout: "", stderr: "HTTP 403" } : { code: 0, stdout: "", stderr: "" };
    if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
    const page = args.includes("after=CURSOR1") ? pages[1] : pages[0];
    return { code: 0, stdout: JSON.stringify(page), stderr: "" };
  };
  // GitHub's budget (#549) is not a read of the backlog
  return { gh, calls, cwds, graphql: () => calls.filter((a) => a[0] === "api" && !a.some((x) => x.includes("rateLimit"))).length };
}

/** fakeGh, answering GitHub's GraphQL budget with `remaining` of 5,000 points, back at `resetAt` (#549). */
function budgetGh(remaining: number, resetAt = new Date(Date.now() + 40 * 60_000).toISOString()) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    if (args.some((a) => a.includes("rateLimit"))) return { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining, resetAt } } }), stderr: "" };
    return fake.gh(args, cwd);
  };
  const hhmm = `${String(new Date(resetAt).getHours()).padStart(2, "0")}:${String(new Date(resetAt).getMinutes()).padStart(2, "0")}`;
  return { ...fake, gh, resetAt, hhmm };
}

/** GitHub at its primary limit while `limited.on` (every API read refused with RATE_LIMITED); the fake answers before that. */
function limitedGh() {
  const fake = fakeGh();
  const limited = { on: false };
  const reset = Math.floor(Date.now() / 1000) + 1800;
  const gh: GhRunner = async (args, cwd) =>
    limited.on && args[0] === "api"
      ? { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" }
      : fake.gh(args, cwd);
  return { ...fake, gh, limited };
}

/** The list once the imports under way are stored (`refresh`: asks for them first; #885 answers what is stored meanwhile). */
async function refreshed(base: string, refresh = true): Promise<Backlog> {
  let body = (await (await fetch(`${base}/api/backlog${refresh ? "?refresh=1" : ""}`)).json()) as Backlog;
  while (body.syncs.some((x) => x.syncing)) {
    await Bun.sleep(5);
    body = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  }
  return body;
}

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub (#1044): `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
const savedProjectUrl = process.env.SWITCHBOARD_PROJECT_URL;
beforeEach(() => { delete process.env.SWITCHBOARD_PROJECT_URL; });
afterEach(async () => {
  if (core) await core.stop();
  if (home) rmSync(home, { recursive: true, force: true });
  core = home = undefined;
  openPulls = [];
  if (savedProjectUrl !== undefined) process.env.SWITCHBOARD_PROJECT_URL = savedProjectUrl;
});
async function boot(gh: GhRunner, adapter: RunnerAdapter | RunnerAdapter[] = { id: "claude", detect: async () => ({ available: false }), start() { throw new Error("no runs"); } }, env: Record<string, string> = {}, llmSuggester?: () => Suggester) {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...env });
  // as the daemon starts: every workspace is imported at boot (#885); the tests begin once it is stored
  core = await startServer(cfg, [adapter].flat(), { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(gh, () => openPulls), llmSuggester, backlogAutoImport: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  await refreshed(base, false);
  return base;
}

test("GET /api/backlog: stage per request / PBI, Project fields, Task counts, both pages", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const r = await fetch(`${base}/api/backlog`);
  expect(r.status).toBe(200);
  const body = await r.json() as Backlog;
  // the first look waits for the first import (#885): nothing was stored before it
  expect(body.syncs).toEqual([{ workspaceId: expect.any(String), backlog: "github", enabling: null, repository: "acme/app", syncing: false, syncedAt: body.fetchedAt, creates: [], issues: [], sync: expect.objectContaining({ state: "synced", reason: null, lastSuccessfulSync: body.fetchedAt, guarantee: "A" }) }]);
  expect(body.items.map((i) => [i.number, i.type, i.stage])).toEqual([
    [306, "pbi", "needs-decision"], // label wins over Status In progress
    [305, "pbi", "in-progress"], // In review
    [304, "pbi", "ready"],
    [303, "pbi", "needs-tasks"], // Backlog
    [302, "request", "request"], // "#12" in the original does not count; only the 派生 PBI section does
    // 301 has "#303" under 派生 PBI → not returned
    [307, "pbi", "in-progress"], // In progress
    [308, "pbi", "in-progress"], // In review, with confirmations (#523); the newest created first
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

test("GET /api/backlog after a restart with GitHub failing, and from a restored backup: the stored list and questions, with the reason (#885)", async () => {
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
      core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: throwing, backlogAutoImport: true }); // as the daemon starts
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

test("GET /api/backlog/:number: the stored body, comments and Project fields; 404 when not stored (#885)", async () => {
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

test("GET /api/backlog: gh failing → the workspace and the reason in errors, never an empty list as if read (kind gh-login, #2362)", async () => {
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

test("GET /api/backlog: fetchedAt is the GitHub workspaces' import, not a workspace kept only here (#2362)", async () => {
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
    args[0] === "repo" ? { code: 0, stdout: "acme/app", stderr: "" }
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
    if (args[0] === "repo" && (cwd === dirs.noPage || cwd === dirs.badNode)) return { code: 0, stdout: `acme/${cwd === dirs.noPage ? "nopage" : "badnode"}\n`, stderr: "" };
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
    if (cwd === dirs.lib && args[0] === "repo") return { code: 0, stdout: "acme/lib\n", stderr: "" };
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

  // a plain read asks GitHub for none, the failed workspace neither (its import is asked again by 再読込, #885)
  const calls = ok.cwds.length;
  const again = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(ok.cwds.length).toBe(calls);
  expect(again.errors).toEqual(body.errors);
});

test("GET /api/backlog?refresh=1: a gh slower than Bun's default idle timeout (12 s) still answers JSON", async () => {
  const ok = fakeGh();
  let slow = false; // armed after boot, for one call: the refresh's connection must stay open while GitHub is read
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api" && slow) { slow = false; await Bun.sleep(12_000); }
    return ok.gh(args, cwd);
  };
  const base = await boot(gh);
  slow = true;
  const r = await fetch(`${base}/api/backlog?refresh=1`);
  expect(r.status).toBe(200);
  expect(((await r.json()) as Backlog).items).toHaveLength(7);
}, { timeout: 30_000 });

test("GET /api/backlog?refresh=1: workspaces are imported in parallel; the refresh waits about the slowest one", async () => {
  const ok = fakeGh();
  const dirs = { lib: "" };
  // an import reads the first page twice (the changed Issues, then the open ones): 1 s per workspace
  const gh: GhRunner = async (args, cwd) => {
    if (cwd === dirs.lib && args[0] === "repo") return { code: 0, stdout: "acme/lib\n", stderr: "" };
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
  // the same stop from both of #305's Tasks is one series of 2 (#948); lib's #304 and the meta's #3040 are other work
  const merge = { id: "m", op: "gh pr merge", target: "PR #9", reason: "depends" as const, evidence: "CI", safety: "unknown" as const, conditions: [], actions: [], state: "waiting" as const };
  for (const t of [first, done, lib304, meta3040]) expect(core!.tasks.recordStop(t.id, merge).ok).toBe(true);

  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const mine = (n: number) => items.find((i) => i.number === n && i.workspaceId === metaId())!;
  expect(mine(305)).toMatchObject({ projectStatus: "In review", updatedAt: "2026-09-27T05:00:00Z", lastTask: { id: done.id, status: "done", statusAt: done.statusAt, createdAt: done.createdAt, updatedAt: done.updatedAt }, activeTaskId: null });
  expect(typeof mine(305).lastTask!.statusAt).toBe("number"); // when it came to done (#2029), not when it was made
  expect(done.statusAt).toBeGreaterThanOrEqual(done.createdAt);
  expect(mine(307)).toMatchObject({ projectStatus: "In progress", updatedAt: "2026-09-12T07:00:00Z", lastTask: { id: failed.id, status: "error", statusAt: failed.statusAt, updatedAt: failed.updatedAt } });
  // no stage Task of its own: the other workspace's #304 and the meta's #3040 are not it
  expect(mine(304)).toMatchObject({ projectStatus: "Ready", lastTask: null });
  expect(items.find((i) => i.number === 304 && i.workspaceId === libId)!.lastTask).toMatchObject({ status: "done" });
  expect(mine(302)).toMatchObject({ projectStatus: null, lastTask: null, report: null });
  expect(mine(305).stopSummary).toMatchObject([{ op: "gh pr merge", count: 2, unchanged: true, work: { workspaceId: metaId(), issue: 305 } }]);
  expect(mine(304).stopSummary).toEqual([]);
  expect(items.find((i) => i.number === 304 && i.workspaceId === libId)!.stopSummary).toMatchObject([{ count: 1, work: { workspaceId: libId, issue: 304 } }]);
  expect(mine(307).stopSummary).toEqual([]);
});

/** A claude adapter that records its prompts and stays running (never ends the session). */
function holdingClaude() {
  const starts: StartOptions[] = [];
  const adapter: RunnerAdapter = {
    id: "claude", detect: async () => ({ available: true }), efforts: [{ value: "high", label: "high" }, { value: "low", label: "low" }],
    start(opts) {
      starts.push(opts);
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  };
  return { adapter, starts };
}
const metaId = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
/** What waits to be sent to GitHub (#886): per operation, its Issue's number, kind, field and what is sent. */
const queued = () =>
  core!.db.listPendingBacklogOperations().map((o) => {
    const issue = core!.db.getBacklogRecord({ ...o, objectKind: "issue", externalId: o.issue });
    return [((issue?.local ?? issue?.remote) as { number: number } | null)?.number, o.kind, o.field, o.payload];
  });
const metaName = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!.name;
/** POST .../start; the body names the meta workspace unless it names another. */
const start = (base: string, n: number | string, body: object) =>
  fetch(`${base}/api/backlog/${n}/start`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

test("start: complete on a Ready PBI creates a meta Task with the fixed /pbi-complete prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(task.workspaceId).toBe(meta.id);
  expect(task.title.startsWith("#304 実装: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("/pbi-complete 304");
  expect(claude.starts[0]!.prompt).toContain("#304");
  expect(claude.starts[0]!.cwd).toBe(meta.path);
});

test("start: another workspace's Issue runs there, uses the skills synced into it, and names its Project variable", async () => {
  const claude = holdingClaude();
  const fake = fakeGh();
  const base = await boot(fake.gh, claude.adapter);
  const dir = mkdtempSync(join(home!, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "lib" }) })).json()) as { id: string };
  await fetch(`${base}/api/workspaces/${lib.id}`, { method: "PATCH", body: JSON.stringify({ projectVar: "LIB_PROJECT_URL" }) });
  await refreshed(base);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await start(base, 303, { workspaceId: lib.id, action: "to-tasks" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.workspaceId).toBe(lib.id);
  expect(task.title.startsWith("#303 Task に分解: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const s = claude.starts[0]!;
  expect(s.cwd).toBe(dir);
  expect(s.prompt).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #303");
  expect(s.prompt).toContain("スキル（`.claude/skills/…`）は Switchboard がこのリポジトリに置いたもの");
  // the skills are no longer read from the meta workspace's path; only the scripts are
  expect(s.prompt).not.toContain("スキルとスクリプト");
  expect(s.prompt).not.toContain(`${meta.path}/.claude/skills`);
  expect(s.prompt).toContain(`スクリプト（\`scripts/…\`）はこのリポジトリには無く、Switchboard のリポジトリ ${meta.path} からの相対パス`);
  expect(s.prompt).toContain("gh variable get LIB_PROJECT_URL");
  expect(s.prompt).toContain("スキル中の「このリポジトリ」「開発リポジトリ」はこのリポジトリ"); // no repository name: the skills name none
  // without --repo the scripts' target depends on where they run (local-ci: the clone it is in, Switchboard's)
  expect(s.prompt).toContain("`scripts/merge-gate.ts`・`scripts/parallel-guard.ts`・`scripts/local-ci.ts` の既定の対象は実行する場所");
  expect(s.prompt).toContain("必ず `--repo <このリポジトリの owner/name>` を付けて実行し、その判定に従う");
  expect(s.prompt).toContain(`このリポジトリの作業ツリーから \`bun ${meta.path}/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>\` で CI を回す`);
  // the running Task marks lib's #303, not the meta's; the meta's #303 can still start
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.filter((i) => i.number === 303);
  expect(items.find((i) => i.workspaceId === lib.id)!.activeTaskId).toBe(task.id);
  expect(items.find((i) => i.workspaceId === meta.id)!.activeTaskId).toBeNull();
  expect((await start(base, 303, { workspaceId: lib.id, action: "to-tasks" })).status).toBe(409);
  expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
  // complete on another repository is the skill file, not the slash command (which only this repository has)
  await start(base, 304, { workspaceId: lib.id, action: "complete" });
  for (let i = 0; claude.starts.length < 3 && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.map((x) => x.prompt).find((p) => p.includes("PBI #304"))).toContain(".claude/skills/pbi-complete/SKILL.md に従い、PBI #304");
});

test("start: check on an in-progress PBI creates a Task titled #N 状況確認 whose prompt asks for a ## 状況 comment and ## 判断待ち", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 307, { action: "check" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title).toBe("#307 状況確認: PBI: Task が全部閉じた実装中の PBI");
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const p = claude.starts[0]!.prompt;
  expect(p).toContain("PBI #307 の今の状況を確認してください");
  expect(p).toContain("Issue #307 に `## 状況` で始まるコメントを 1 件");
  for (const h of ["### 済んだこと", "### 残り", "### 止まっている理由", "### 次にやること", "## 判断待ち", "## 回答"]) expect(p).toContain(h);
  expect(p).toContain("Issue のクローズ・Project の Status の変更はしないでください");
  // the shared ending says to follow the newest ## 回答; for a check that answer is material, not work to resume
  expect(p).toContain("これまでの `## 回答` は状況の材料として読むだけにし、その続きの作業はしないでください");
  // the running check marks the row like any stage Task
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 307)!.activeTaskId).toBeString();
});

test("start: a local backlog's stage prompt says ops-kit backlog only, no gh issue / scripts/setup (#2265)", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: ["lint_backlog.sh"] } };
  for (const action of ["to-pbi", "to-tasks", "complete", "check", "close"] as const) {
    for (const p of [buildStartPrompt({ number: 1 }, action, { other, local: true }), buildStartPrompt({ number: 1 }, action, { local: true })]) {
      expect(p).toContain("#1 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）");
      expect(p).toContain("`ops-kit backlog`");
      expect(p).toContain("`ops-kit lint --fresh`");
      expect(p).toContain("`--repo` を付けずに実行する");
      // the PR names the Task without a closing keyword or #N (it is no GitHub Issue), and the Task is closed by hand after the merge (#2344)
      expect(p).toContain("Backlog-Task: <番号>");
      expect(p).toContain("`ops-kit backlog edit <Task> --state closed`");
      // nothing that sends it to GitHub's Issues or Project
      expect(p).not.toContain("gh repo view");
      expect(p).not.toContain("gh variable get");
      expect(p).not.toContain("APP_PROJECT_URL");
      expect(p).not.toMatch(/(?<!`)scripts\/setup\/(?!\*)/);
    }
  }
  // the PR side stays: merge gate, local CI, the release tag and the rollback, with the repository named
  const complete = buildStartPrompt({ number: 1 }, "complete", { other, local: true });
  for (const kept of ["scripts/merge-gate.ts", "scripts/local-ci.ts", "scripts/release-tag.ts", "scripts/rollback-pr.ts", "docs/design/merge-gate.md"]) expect(complete).toContain(kept);
  // a GitHub one is as before
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("`gh repo view` が答えるもの");
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("APP_PROJECT_URL");
});

test("start: check on a stage other than in-progress is 409", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  for (const n of [306, 304, 303, 302]) expect((await start(base, n, { action: "check" })).status).toBe(409);
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: complete on an in-progress item resumes it (#1045)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 305, { action: "complete" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title.startsWith("#305 実装: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  // the same Task backlog-next starts for a stalled in-progress PBI (#578): the closed Tasks when it was chosen
  expect(claude.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 1 } }));
  expect(claude.starts[0]!.prompt).toContain("PBI #305 は実装中のまま止まっています");
});

test("start: complete while the in-progress item's check is running is 409 with its id (#1045)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 305, { action: "check" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 305, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start: a second check while the first is running is 409 with its id", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 305, { action: "check" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 305, { action: "check" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start / answer: an unknown workspace is 404; a missing one 400", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  expect((await start(base, 304, { workspaceId: "ws_nope", action: "complete" })).status).toBe(404);
  expect((await fetch(`${base}/api/backlog/304/start`, { method: "POST", body: JSON.stringify({ action: "complete" }) })).status).toBe(400);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: "ws_nope", text: "x" }) })).status).toBe(404);
  expect(core!.db.listTasks()).toHaveLength(0);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("decision: answering another workspace's Issue is kept for that repository", async () => {
  const fake = fakeGh();
  const dir = { lib: "" };
  const gh: GhRunner = async (args, cwd) => (cwd === dir.lib && args[0] === "repo" ? { code: 0, stdout: "acme/lib\n", stderr: "" } : fake.gh(args, cwd));
  const base = await boot(gh);
  dir.lib = mkdtempSync(join(home!, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir.lib, name: "lib" }) })).json()) as { id: string };
  await refreshed(base);
  const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: lib.id, text: "A で" }) });
  expect(r.status).toBe(202);
  expect(core!.db.listPendingBacklogOperations().map((o) => o.repository)).toEqual(["acme/lib", "acme/lib"]);
  expect(queued()).toEqual([[306, "comment", null, { body: "## 回答\n\nA で" }], [306, "set", "label:needs-decision", false]]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("start: the title and the skill follow the action", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect(((await (await start(base, 303, { action: "to-tasks" })).json()) as Task).title.startsWith("#303 Task に分解: ")).toBe(true);
  expect(((await (await start(base, 302, { action: "to-pbi" })).json()) as Task).title.startsWith("#302 PBI にする: ")).toBe(true);
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompts = claude.starts.map((s) => s.prompt).join("\n----\n");
  expect(prompts).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #303");
  expect(prompts).toContain(".claude/skills/request-to-backlog/SKILL.md に従い、既存の要望 Issue #302");
});

test("start: an action that does not match the stage is 409; unknown Issue 404; bad action 400", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  expect((await start(base, 303, { action: "complete" })).status).toBe(409);
  expect((await start(base, 306, { action: "to-tasks" })).status).toBe(409); // needs-decision
  expect((await start(base, 306, { action: "complete" })).status).toBe(409); // needs-decision: not a resume
  expect((await start(base, 999, { action: "complete" })).status).toBe(404);
  expect((await start(base, 304, { action: "merge" })).status).toBe(400);
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: gh failing is 424 with the reason (not 502, which CloudFront swaps for its stopped page) and starts nothing", async () => {
  const base = await boot(fakeGh({ code: 1, stderr: "gh auth login" }).gh, holdingClaude().adapter);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(424);
  expect((await r.json() as { error: string }).error).toContain("gh auth login");
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: an imported workspace starts on its stored data while GitHub is at its limit with an edit not sent — 201 (#2264)", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.status !== "done")).toHaveLength(1);
});

test("start: a conflict held in the stored data is 409 even while GitHub is at its limit (#2264)", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  // the conflict a send found against GitHub's newer title (#887), held in the stored data
  const op = core!.db.listPendingBacklogOperations()[0]!;
  core!.db.setBacklogOperationResult(op.id, { status: "conflict" });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("競合");
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#304 "))).toHaveLength(0);
});

test("autoStart: a stage button starts on the saved runner and model; routing.llm.runner is not consulted", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  core!.db.setSetting("settings", { autoStart: { runner: "codex", model: "m-auto" }, routing: { llm: { runner: "claude" } } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", model: "m-auto" });
  for (let i = 0; !codex.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(codex.starts[0]!.model).toBe("m-auto");
  expect(claude.starts).toHaveLength(0);
});

test("autoStart effort (#833): a stage button starts with the saved effort", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", effort: "high" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.effort).toBe("high");
});

test("autoStart by kind (#1337): to-tasks on codex starts Task に分解 on codex and 実装する on the common claude", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex", efforts: [{ value: "medium", label: "medium" }] }]);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", effort: "high", byKind: { "to-tasks": { runner: "codex", model: "m-plan", effort: "medium" } } } });
  const plan = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  const impl = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(plan).toMatchObject({ runner: "codex", model: "m-plan", effort: "medium" });
  expect(impl).toMatchObject({ runner: "claude", model: "m-common", effort: "high" });
  for (let i = 0; (!codex.starts.length || !claude.starts.length) && i < 100; i++) await Bun.sleep(10);
  expect(codex.starts.map((x) => [x.model, x.effort])).toEqual([["m-plan", "medium"]]);
  expect(claude.starts.map((x) => [x.model, x.effort])).toEqual([["m-common", "high"]]);
});

test("autoStart by kind (#1337): a kind whose runner is not detected starts on the common values", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { complete: { runner: "codex", model: "m-gone" } } } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", model: "m-common" });
});

test("start: a second start while the first is running is 409 with its id; GET /api/backlog shows it as active", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 304, { action: "complete" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 304, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 304)!.activeTaskId).toBe(first.id);
  expect(items.find((i) => i.number === 303)!.activeTaskId).toBeNull();
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start: two starts while the routing turn is still thinking make one Task; the other is 409", async () => {
  const claude = holdingClaude();
  // an LLM routing suggestion takes a moment: both starts would pass the running/waiting check before either creates
  const slow: Suggester = { suggest: async () => (await Bun.sleep(50), { runner: "claude", reason: "slow", ruleId: "llm", available: true, alternatives: [], llm: null }) };
  const base = await boot(fakeGh().gh, claude.adapter, {}, () => slow);
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  const [a, b] = await Promise.all([start(base, 304, { action: "complete" }), start(base, 304, { action: "complete" })]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("decision: a needs-decision item carries its newest ## 判断待ち comment; the others carry none", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const d = items.find((i) => i.number === 306)!.decision!;
  expect(d.body.startsWith("## 判断待ち\n**問い**: 保存先をどちらにするか")).toBe(true);
  expect(d.at).toBe("2026-09-22T03:00:00Z");
  expect(items.filter((i) => i.number !== 306).every((i) => i.decision === null)).toBe(true);
});

test("report: an in-progress item carries its newest ## 状況 comment; the other stages carry none", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const r = items.find((i) => i.number === 305)!.report!;
  expect(r.body.startsWith("## 状況\n### 済んだこと\n- #310 をマージ")).toBe(true);
  expect(r.at).toBe("2026-09-27T05:00:00Z");
  expect(items.find((i) => i.number === 307)!.report).toBeNull();
  // a ## 状況 is read for in-progress items only, a ## 判断待ち for needs-decision items only
  expect(items.find((i) => i.number === 306)!.report).toBeNull();
  expect(items.find((i) => i.number === 305)!.decision).toBeNull();
});

/** The fixtures' gh with comments of its own on #304 (Ready) and #307 (in progress), and `states` answering the waits' query (#817). */
function waitsGh(own: { i304?: Array<[string, string]>; i307?: Array<[string, string]> }, states: Record<string, unknown> = {}, tasks307?: unknown[], errors?: unknown[]) {
  const fake = fakeGh();
  const repo = (decisions as { data: { repository: Record<string, { comments: { nodes: unknown[] } }> } }).data.repository;
  const nodes = (c: Array<[string, string]> = []) => c.map(([body, createdAt]) => ({ body, createdAt }));
  const repository = { ...repo, i304: { comments: { nodes: nodes(own.i304) } }, i307: { ...repo.i307, comments: { nodes: nodes(own.i307) }, ...(tasks307 ? { subIssues: { nodes: tasks307 } } : {}) } };
  const waitsCalls: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query="));
    if (q?.includes("issueOrPullRequest")) return (waitsCalls.push(q), { code: 0, stdout: JSON.stringify({ data: { repository: states }, ...(errors ? { errors } : {}) }), stderr: "" });
    if (q?.includes("comments(last:")) return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    return fake.gh(args, cwd);
  };
  return { gh, waitsCalls };
}
const waitsOfItem = async (base: string, n: number) => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === n)!;
const STOPPED = "2026-09-30T00:00:00Z";
const LATER = "2026-09-30T01:00:00Z";
/** One wait of an item as the daemon gives it (#1046): a prerequisite with no PBI found unless said (#1183). */
function wait(number: number, kind: "issue" | "pr", open: boolean | null, more: { reason?: "overlap" | "prerequisite"; pbi?: BacklogItem["waits"][number]["pbi"] } = {}): BacklogItem["waits"][number] {
  return { number, kind, open, state: open === null ? "missing" : open ? "pending" : "met", reason: more.reason ?? "prerequisite", pbi: more.pbi ?? null };
}
const openPrMerged = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "MERGED" } };

describe("backlog waiting", () => {
  test("waiting: a decision Task releases an explicit overlap wait but not a prerequisite wait", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN", labels: { nodes: [{ name: "needs-decision" }] } } };
    const fake = waitsGh({ i304: [[releaseBody("重複", [603], true), STOPPED]], i307: [[releaseBody("前提", [603]), STOPPED]] }, states);
    const base = await boot(fake.gh);
    const ready = await waitsOfItem(base, 304);
    expect(ready).toMatchObject({ waits: [], waitsAt: STOPPED });
    expect(pickNext([ready], "implement")).toMatchObject({ item: { number: 304 } });
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(603, "issue", true)]);
  });

  test("waiting: a Draft or decision PR releases the old overlap wait without closing it, while Issue prerequisites remain", async () => {
    for (const deferred of [{ isDraft: true }, { isDraft: false, labels: { nodes: [{ name: "needs-decision" }] } }]) {
      const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]], i307: [[releaseBody("後回し", [778, 603]), STOPPED]] }, {
        w778: { __typename: "PullRequest", state: "OPEN", ...deferred }, w603: { __typename: "Issue", state: "OPEN" },
      });
      const base = await boot(fake.gh);
      const ready = await waitsOfItem(base, 304);
      expect(ready).toMatchObject({ waits: [], waitsAt: STOPPED });
      expect(pickNext([{ ...ready, lastTask: { id: "tsk_old", status: "done", statusAt: Date.parse(LATER), createdAt: Date.parse(LATER), updatedAt: Date.parse(LATER), action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null } }], "implement")).toMatchObject({ item: { number: 304 }, action: "complete" });
      const building = await waitsOfItem(base, 307);
      expect(building.waits).toEqual([wait(603, "issue", true)]);
      expect(pickNext([building], "implement")).toBeNull();
      expect(fake.waitsCalls[0]).toContain("isDraft");
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
  });

  test("waiting: a Draft made ready blocks again on the next read", async () => {
    const states = { w778: { __typename: "PullRequest", state: "OPEN", isDraft: true } };
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states);
    const base = await boot(fake.gh);
    expect((await waitsOfItem(base, 307)).waits).toEqual([]);
    states.w778.isDraft = false;
    const again = (await refreshed(base)).items.find((i) => i.number === 307)!;
    expect(again.waits).toEqual([wait(778, "pr", true)]);
  });

  test("waiting: an in-progress PBI whose newest pbi-complete mark is a release with waits carries them with their states", async () => {
    const fake = waitsGh({ i307: [["着手", "2026-09-29T00:00:00Z"], [releaseBody("後回し: #330（PR #778 と重なる）", [778, 603]), STOPPED], ["ふつうのコメント", LATER]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [wait(603, "issue", true), wait(778, "pr", false)], waitsAt: STOPPED });
    expect(fake.waitsCalls).toHaveLength(1);
    expect(fake.waitsCalls[0]).toContain("w603: issueOrPullRequest(number:603)");
    expect(fake.waitsCalls[0]).toContain("w778: issueOrPullRequest(number:778)");
    expect((await waitsOfItem(base, 305)).waits).toEqual([]);
  });

  test("waiting: a later release without waits, or a later claim, clears the wait", async () => {
    for (const later of [releaseBody("完了"), "<!-- pbi-complete:claim t1 -->\n/pbi-complete 開始。"]) {
      const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED], [later, LATER]] }, openPrMerged);
      const base = await boot(fake.gh);
      expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
      expect(fake.waitsCalls).toHaveLength(0);
      await core!.stop(); core = undefined;
      rmSync(home!, { recursive: true, force: true });
    }
  });

  test("waiting: a later ## 回答 clears the wait", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED], ["## 回答\n\nA で", LATER]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect((await waitsOfItem(base, 307)).waits).toEqual([]);
  });

  test("waiting: a Ready PBI carries its waits too, and nothing else from its comments", async () => {
    const fake = waitsGh({ i304: [["## 状況\n### 済んだこと", "2026-09-29T00:00:00Z"], ["## 回答\n\nA", "2026-09-29T01:00:00Z"], [releaseBody("後回し", [778]), STOPPED]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 304)).toMatchObject({ stage: "ready", waits: [wait(778, "pr", false)], report: null, decision: null, answeredAt: null });
  });

  test("waiting: an in-progress PBI held by a Task's question is needs-decision and carries no waits", async () => {
    const question = subTask(330, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: x", LATER]]);
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, openPrMerged, [question]);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 307)).toMatchObject({ stage: "needs-decision", waits: [] });
  });

  test("waiting: each wait says why it waits; a number GitHub did not find stays as not read and holds the PBI (#1046; the parent PBI: backlog-stored.test.ts)", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "MERGED" }, w999: null };
    const fake = waitsGh({ i304: [[releaseBody("重複", [778, 603], true), STOPPED]], i307: [[releaseBody("前提", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
    const base = await boot(fake.gh);
    const ready = await waitsOfItem(base, 304);
    expect(ready.waits).toEqual([wait(603, "issue", true, { reason: "overlap" }), wait(778, "pr", false, { reason: "overlap" })]);
    const building = await waitsOfItem(base, 307);
    expect(building.waits).toEqual([wait(603, "issue", true), wait(999, "issue", null)]);
    // not read is not closed: still held once #603 closed
    expect(pickNext([{ ...building, waits: [wait(603, "issue", false), wait(999, "issue", null)] }], "implement")).toBeNull();
  });

  test("waits owner: a PR's PBI is the parent of the Task it closes; that PBI's stage Task is read from its own item (#1183)", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778, 30501]), STOPPED]] }, {
      w778: { __typename: "PullRequest", state: "OPEN", body: "## 何を\n\nCloses #30501", headRefName: "sb/30501-x" },
      w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } },
    });
    const base = await boot(fake.gh);
    const now = Date.now();
    core!.db.insertTask({ id: "tsk_owner305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "error", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
    const owner = { number: 305, title: "PBI: 実装中の PBI" };
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(778, "pr", true, { pbi: owner }), wait(30501, "issue", true, { pbi: owner })]);
    expect(await waitsOfItem(base, 305)).toMatchObject({ lastTask: { id: "tsk_owner305", status: "error" }, activeTaskId: null });
  });

  test("waits owner: a branch alone names the Task, a PBI waited for is its own, and a PR that names nothing is not found (#1183)", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [305, 778, 779, 30501]), STOPPED]] }, {
      w778: { __typename: "PullRequest", state: "OPEN", body: "Task は無い", headRefName: "fix-something" },
      w779: { __typename: "PullRequest", state: "OPEN", body: null, headRefName: "sb/30501-only-branch" },
      w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } },
    });
    const base = await boot(fake.gh);
    const owner = { number: 305, title: "PBI: 実装中の PBI" };
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(305, "issue", true, { pbi: owner }), wait(778, "pr", true), wait(779, "pr", true, { pbi: owner }), wait(30501, "issue", true, { pbi: owner })]);
  });

  test("waiting: with no waits anywhere the states are not asked for", async () => {
    const fake = waitsGh({});
    const base = await boot(fake.gh);
    const items = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items;
    expect(items.every((i) => i.waits.length === 0)).toBe(true);
    expect(fake.waitsCalls).toHaveLength(0);
  });
});

test("confirmations: only unchecked 利用者確認 lines outside fences, numbered among all checkboxes", () => {
  const body = [
    "## ユーザーストーリー",
    "- [ ] 節の外（利用者確認: 数えない）",
    "## 到達点 / 受け入れ条件",
    "- [x] 1. 済み（利用者確認: 見た）",
    "- [ ] 2. 実機（検証: ホスト）（利用者確認: ホストで動く）  ",
    "- [ ] 3. エージェントが検証する（検証: テスト）",
    "~~~",
    "- [ ] 見本（利用者確認: フェンスの中）",
    "## 到達点 / 受け入れ条件",
    "~~~",
    "- [X] 4. 大文字の X も済み（利用者確認: 見た）",
    "- [ ] 5. スマホ（利用者確認: スマホで読める）",
    "## スコープ外",
    "- [ ] 後ろの節（利用者確認: 数えない）",
  ].join("\n");
  const want = [{ n: 2, text: "2. 実機（検証: ホスト）（利用者確認: ホストで動く）" }, { n: 5, text: "5. スマホ（利用者確認: スマホで読める）" }];
  expect(confirmationsOf(body)).toEqual(want);
  // a body edited on GitHub's web form comes back with CRLF: no \r in the text
  expect(confirmationsOf(body.replaceAll("\n", "\r\n"))).toEqual(want);
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. ふつう（検証: テスト）\n")).toEqual([]);
  // a line that names the form in inline code (PBI #523's own criterion 1) is not one
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 行に `（利用者確認: <何を>）` を付ける（検証: grep）\n- [ ] 2. 画面（利用者確認: `/backlog` で見る）\n"))
    .toEqual([{ n: 2, text: "2. 画面（利用者確認: `/backlog` で見る）" }]);
  // a code span of two backticks holds a single one; the mark after it is outside (#715 review)
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）\n")).toEqual([{ n: 1, text: "1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）" }]);
  // only the first ## 到達点 / 受け入れ条件 section counts, as section() reads it (#715 review)
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 実機（利用者確認: 見る）\n## メモ\n## 到達点 / 受け入れ条件\n- [ ] 見本（利用者確認: 数えない）\n")).toEqual([{ n: 1, text: "1. 実機（利用者確認: 見る）" }]);
});

test("GET /api/backlog: an in-progress PBI carries its confirmations; closable only when every Task is done and none is left", async () => {
  const pbi308 = pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } };
  const node = pbi308.data.repository.issues.nodes.find((n) => n.number === 308)!;
  const saved = node.body;
  try {
    const base = await boot(fakeGh().gh);
    const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
    const of = (n: number) => items.find((i) => i.number === n)!;
    expect(of(308)).toMatchObject({
      stage: "in-progress", tasks: { total: 2, done: 2, doneAt: expect.any(String) }, closable: false,
      confirmations: [{ n: 2, text: "2. ホストで動く（検証: 実機）（利用者確認: クラウドホストの画面で一覧が出る）" }, { n: 4, text: "4. スマホで読める（利用者確認: スマホで開いて文字が切れない）" }],
    });
    expect(of(305)).toMatchObject({ tasks: { total: 3, done: 1, doneAt: expect.any(String) }, confirmations: [], closable: false });
    expect(of(307)).toMatchObject({ tasks: { total: 2, done: 2, doneAt: expect.any(String) }, confirmations: [], closable: true });
    // only in-progress PBIs are read for them, and only they can be closable
    for (const n of [306, 304, 303, 302]) expect(of(n)).toMatchObject({ confirmations: [], closable: false });

    // every confirmation checked on GitHub → closable
    node.body = saved.replaceAll("- [ ] 2.", "- [x] 2.").replaceAll("- [ ] 4.", "- [x] 4.");
    const again = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(again).toMatchObject({ confirmations: [], closable: true });
  } finally {
    node.body = saved;
  }
});

/** The fixtures' comments answer with Tasks under the in-progress PBIs #305 and #307 (#562). */
function taskDecisionGh(tasks: { i305: unknown[]; i307: unknown[] }, own: { i305?: unknown[]; i307?: unknown[] } = {}) {
  const fake = fakeGh();
  const repo = (decisions as { data: { repository: Record<string, { comments: { nodes: unknown[] } }> } }).data.repository;
  const repository = {
    i306: repo.i306,
    i305: { comments: { nodes: [...repo.i305!.comments.nodes, ...(own.i305 ?? [])] }, subIssues: { nodes: tasks.i305 } },
    i307: { comments: { nodes: own.i307 ?? [] }, subIssues: { nodes: tasks.i307 } },
    i308: repo.i308,
    i304: repo.i304,
  };
  const gh: GhRunner = async (args, cwd) =>
    args.some((a) => a.includes("comments(last:")) ? (fake.calls.push(args), { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" }) : fake.gh(args, cwd);
  return { ...fake, gh };
}
const subTask = (number: number, state: string, labels: string[], comments: Array<[string, string]>, updatedAt?: string) =>
  ({ number, state, updatedAt, labels: { nodes: labels.map((name) => ({ name })) }, comments: { nodes: comments.map(([body, createdAt]) => ({ body, createdAt })) } });

test("task decision: an open Task's needs-decision holds its in-progress PBI with that Task's newest question", async () => {
  const fake = taskDecisionGh({
    i305: [
      subTask(320, "CLOSED", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 閉じた Task の問い", "2026-09-28T09:00:00Z"]]),
      subTask(321, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 古い問い", "2026-09-28T01:00:00Z"], ["## 回答\n\nA", "2026-09-28T02:00:00Z"], ["## 判断待ち\n**問い**: 表示をどちらにするか", "2026-09-28T03:00:00Z"]]),
      subTask(322, "OPEN", ["type:task"], [["## 判断待ち\n**問い**: ラベルの無い Task の問い", "2026-09-28T08:00:00Z"]]),
    ],
    i307: [subTask(330, "OPEN", ["type:task"], [])],
  });
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const i305 = items.find((i) => i.number === 305)!;
  expect(i305.stage).toBe("needs-decision");
  expect(i305.decision).toEqual({ body: "## 判断待ち\n**問い**: 表示をどちらにするか", at: "2026-09-28T03:00:00Z", issue: 321 });
  expect(i305.report).toBeNull();
  expect(items.find((i) => i.number === 307)).toMatchObject({ stage: "in-progress", decision: null });
  // the PBI's own question names the PBI
  expect(items.find((i) => i.number === 306)!.decision!.issue).toBe(306);
});

test("task decision: a labelled Task without a ## 判断待ち still holds the PBI and says so", async () => {
  const base = await boot(taskDecisionGh({ i305: [subTask(323, "OPEN", ["needs-decision"], [["ふつうのコメント", "2026-09-28T00:00:00Z"]])], i307: [] }).gh);
  const d = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 305)!.decision!;
  expect(d.issue).toBe(323);
  expect(d.body).toContain("Task #323 に「## 判断待ち」のコメントがありません");
  expect(d.at).toBe("2026-09-27T05:00:00Z"); // the PBI's updatedAt
});

test("task decision: the answer is kept for the Task that asked, and its label comes off after it", async () => {
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  const r = await fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "B で" }) });
  expect(r.status).toBe(202);
  expect(queued()).toEqual([[321, "comment", null, { body: "## 回答\n\nB で" }], [321, "set", "label:needs-decision", false]]);
});

test("task decision: an answer sent for the question on screen is refused when the item now asks on another Issue", async () => {
  const fake = taskDecisionGh({ i305: [subTask(322, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: 新しい問い", "2026-09-28T05:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  const post = (issue: number) => fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "A で", issue }) });
  // the screen showed Task #321's question; GitHub now has #322's
  const r = await post(321);
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("#322");
  expect(queued()).toEqual([]);
  expect((await post(322)).status).toBe(202);
  expect(queued().map((o) => o[0])).toEqual([322, 322]);
});

test("hold: a Task's ## 保留 after its ## 判断待ち gives the PBI heldAt; a ## 判断待ち asked after the hold opens it again (#936)", async () => {
  const fake = taskDecisionGh({
    i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"], ["## 保留\n\nCI を見てから", "2026-09-28T04:00:00Z"]])],
    i307: [subTask(330, "OPEN", ["needs-decision"], [["## 保留", "2026-09-28T01:00:00Z"], ["## 判断待ち\n**問い**: y", "2026-09-28T02:00:00Z"]])],
  });
  const items = (await (await fetch(`${await boot(fake.gh)}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 305)).toMatchObject({ stage: "needs-decision", heldAt: "2026-09-28T04:00:00Z", decision: { issue: 321 } });
  expect(items.find((i) => i.number === 307)).toMatchObject({ stage: "needs-decision", heldAt: null });
  expect(items.filter((i) => i.stage !== "needs-decision").every((i) => i.heldAt === null)).toBe(true);
});

test("hold: holding keeps a ## 保留 comment only — the label stays — and the stored read shows the item still asking, held (#936)", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const source = core!.db.getWorkspaceBacklogSource(metaId())!;
  holdStoredDecision(core!.db, source, 306, "来週まで待つ", Date.parse("2030-01-01T00:00:00Z"));
  expect(queued()).toEqual([[306, "comment", null, { body: "## 保留\n\n来週まで待つ" }]]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  const item = (await refreshed(base, false)).items.find((i) => i.number === 306)!;
  expect(item).toMatchObject({ stage: "needs-decision", heldAt: "2030-01-01T00:00:00.000Z" });
  expect(() => holdStoredDecision(core!.db, source, 306, "ghp_" + "a".repeat(36))).toThrow("認証に使える値");
});

test("task decision: answeredAt is the newest ## 回答 on an in-progress PBI or its Tasks; null for the other stages", async () => {
  const fake = taskDecisionGh(
    { i305: [subTask(321, "CLOSED", [], [["## 回答\n\nA", "2026-09-28T06:00:00Z"]])], i307: [subTask(330, "OPEN", [], [["## 回答\n\nA", "2026-09-26T00:00:00Z"], ["ふつうのコメント", "2026-09-29T00:00:00Z"]])] },
    { i305: [{ body: "## 回答\n\nB", createdAt: "2026-09-27T07:00:00Z" }], i307: [{ body: "## 回答\n\nC", createdAt: "2026-09-27T00:00:00Z" }] },
  );
  const items = (await (await fetch(`${await boot(fake.gh)}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 305)!.answeredAt).toBe("2026-09-28T06:00:00Z"); // a closed Task's answer counts
  expect(items.find((i) => i.number === 307)!.answeredAt).toBe("2026-09-27T00:00:00Z"); // the PBI's, newer than the Task's
  // the needs-decision PBI #306 has a ## 回答 among its comments, but it is not in progress
  expect(items.filter((i) => i.stage !== "in-progress").every((i) => i.answeredAt === null)).toBe(true);
});

test("decision: an answer is stored at once and shows: its comment, the label off, the item no longer 判断待ち; GitHub is not written yet", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "B で。移行は不要" }) });
  expect(r.status).toBe(202);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  const item = (await refreshed(base, false)).items.find((i) => i.number === 306)!;
  expect(item.stage).toBe("in-progress");
  const detail = (await (await fetch(`${base}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;
  expect(detail.issue.labels).not.toContain("needs-decision");
  expect(detail.comments.at(-1)!.body).toBe("## 回答\n\nB で。移行は不要");
  expect(detail.pending).toBe(2);
});

test("decision: answering an item that is not waiting is 409; empty text 400; GitHub out of reach still keeps it (202)", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const post = (n: number, text: unknown) => fetch(`${base}/api/backlog/${n}/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text }) });
  const before = fake.calls.length;
  expect((await post(304, "x")).status).toBe(409);
  expect((await post(306, "  ")).status).toBe(400);
  expect((await post(999, "x")).status).toBe(404);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  // refused from the stored copy: nothing written, so nothing is imported either (#885)
  await Bun.sleep(50);
  expect(fake.calls.length).toBe(before);
  // GitHub out of reach: the answer is kept all the same (#886)
  await core!.stop(); core = undefined;
  rmSync(home!, { recursive: true, force: true });
  const down = { on: false };
  const failing = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await fetch(`${failing}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "x" }) })).status).toBe(202);
  expect(queued()).toHaveLength(2);
});

/** The fixtures' gh, and PBI #308's body on GitHub for `issue view --json body`; `--body-file` is read when it is called. */
function confirmGh(body = (pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } }).data.repository.issues.nodes.find((n) => n.number === 308)!.body) {
  const fake = fakeGh();
  const written: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "issue" && args[1] === "view") return (fake.calls.push(args), { code: 0, stdout: JSON.stringify({ body: state.body }), stderr: "" });
    if (args[0] === "issue" && args.includes("--body-file")) written.push(await Bun.file(args[args.indexOf("--body-file") + 1]!).text());
    return fake.gh(args, cwd);
  };
  const state = { body };
  return { ...fake, gh, written, state };
}
const confirmPost = (base: string, body: object) => fetch(`${base}/api/backlog/308/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

test("confirm: 確認した checks that line only, on the body it was made on, then ## 回答; 違う keeps the reason and leaves the body", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  expect((await confirmPost(base, { confirm: { n: 2, ok: true } })).status).toBe(202);
  const [body, answer] = core!.db.listPendingBacklogOperations();
  expect(body).toMatchObject({ kind: "set", field: "body", payload: fake.state.body.replace("- [ ] 2. ホストで動く", "- [x] 2. ホストで動く"), base: fake.state.body });
  const text = "2. ホストで動く（検証: 実機）（利用者確認: クラウドホストの画面で一覧が出る）";
  expect(answer).toMatchObject({ kind: "comment", payload: { body: `## 回答\n\n受け入れ条件 2「${text}」を確認しました。`, confirm: { n: 2, text } } });

  expect((await confirmPost(base, { confirm: { n: 4, ok: false }, text: "  スマホだと右端が切れる  " })).status).toBe(202);
  expect(queued().slice(2)).toEqual([[308, "comment", null, { body: "## 回答\n\n受け入れ条件 4「4. スマホで読める（利用者確認: スマホで開いて文字が切れない）」は違います: スマホだと右端が切れる", confirm: { n: 4, text: "4. スマホで読める（利用者確認: スマホで開いて文字が切れない）" } }]]);
  // 違う leaves the body, and no label is touched either way
  expect(queued().filter((o) => o[2] !== null).map((o) => o[2])).toEqual(["body"]);

  // 違う without a reason is refused before anything is stored; 確認した may carry a note
  expect((await confirmPost(base, { confirm: { n: 4, ok: false }, text: "  " })).status).toBe(400);
  expect(queued()).toHaveLength(3);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("confirm: two confirmations of one PBI at once, from two checkouts of its repository, both stay checked", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  // a second checkout of the same repository registered as another workspace answers the other one
  const other = mkdtempSync(join(home!, "checkout-"));
  const { id } = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: other, name: "app2" }) })).json()) as { id: string };
  await refreshed(base);
  const [a, b] = await Promise.all([
    confirmPost(base, { confirm: { n: 2, ok: true } }),
    fetch(`${base}/api/backlog/308/answer`, { method: "POST", body: JSON.stringify({ workspaceId: id, confirm: { n: 4, ok: true } }) }),
  ]);
  expect([a.status, b.status]).toEqual([202, 202]);
  // the second is made on the body the first left: sent last, it keeps both
  const last = core!.db.listPendingBacklogOperations().filter((o) => o.field === "body").at(-1)!.payload as string;
  expect(last).toContain("- [x] 2. ホストで動く");
  expect(last).toContain("- [x] 4. スマホで読める");
});

test("confirm: a CRLF body keeps its CRLF when the line is checked", async () => {
  const saved = (pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } }).data.repository.issues.nodes.find((n) => n.number === 308)!;
  const crlf = saved.body.replaceAll("\n", "\r\n");
  const fake = confirmGh(crlf);
  const base = await boot(async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    // the import reads the PBI with its CRLF body
    return args[0] === "api" ? { ...r, stdout: r.stdout.replaceAll(JSON.stringify(saved.body).slice(1, -1), JSON.stringify(crlf).slice(1, -1)) } : r;
  });
  expect((await confirmPost(base, { confirm: { n: 4, ok: true }, text: "見た" })).status).toBe(202);
  const [body, answer] = core!.db.listPendingBacklogOperations();
  expect(body!.payload).toBe(crlf.replace("- [ ] 4. スマホ", "- [x] 4. スマホ"));
  expect((answer!.payload as { body: string }).body).toBe("## 回答\n\n受け入れ条件 4「4. スマホで読める（利用者確認: スマホで開いて文字が切れない）」を確認しました。\n\n見た");
});

test("confirm: an unknown n, or a line changed since the list was read, is 409 and stores nothing", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  // 1 is checked, 3 has no 利用者確認, 9 does not exist; 305 has no confirmations
  for (const n of [1, 3, 9]) expect((await confirmPost(base, { confirm: { n, ok: true } })).status).toBe(409);
  expect((await fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), confirm: { n: 1, ok: true } }) })).status).toBe(409);
  expect(queued()).toEqual([]);
  // the stored body changed after the list was read: the line's text differs
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const { answerStoredConfirmation } = await import("./backlog.ts");
  const c = { n: 2, text: "2. ホストで動く（検証: 実機）（利用者確認: ホストの画面で一覧が出る）", ok: true, reason: "" };
  expect(answerStoredConfirmation(db, source, 308, c)).toBe(false);
  expect(queued()).toEqual([]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

/* ---------- edits and new Issues kept here, sent later (#886) ---------- */

const patch = (base: string, ref: number | string, body: object) => fetch(`${base}/api/backlog/${ref}`, { method: "PATCH", body: JSON.stringify({ workspaceId: metaId(), ...body }) });
const detailOf = async (base: string, ref: number | string) => (await (await fetch(`${base}/api/backlog/${ref}?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;

test("edit: every attribute is kept while GitHub is out of reach and shows at once; one field edited again is one operation", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  const before = await detailOf(base, 304);
  const r = await patch(base, 304, { title: "新しい題", body: "一回目", labels: { add: ["P1"], remove: ["type:pbi"] }, state: "CLOSED", milestone: "Phase 3", parent: 12, fields: { Status: "In progress", "Story Points": 3 } });
  expect(r.status).toBe(202);
  expect((await patch(base, 304, { body: "二回目" })).status).toBe(202);
  expect((await patch(base, 304, { body: "三回目" })).status).toBe(202);
  const after = await detailOf(base, 304);
  expect(after.issue).toMatchObject({ number: 304, title: "新しい題", body: "三回目", state: "CLOSED", milestone: "Phase 3", parent: 12 });
  expect(after.issue.labels).toContain("P1");
  expect(after.issue.labels).not.toContain("type:pbi");
  expect(after.fields).toMatchObject({ Status: "In progress", "Story Points": 3 });
  expect(after.pending).toBe(9);
  expect(queued().filter((o) => o[2] === "body")).toEqual([[304, "set", "body", "三回目"]]);
  // each operation keeps the value it was made on, for the check before sending
  expect(core!.db.listPendingBacklogOperations().find((o) => o.field === "title")!.base).toBe(before.issue.title);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  // taken out of the Project: its fields are no longer shown
  expect((await patch(base, 304, { project: false })).status).toBe(202);
  expect((await detailOf(base, 304)).fields).toBeNull();
  // and in it again: the removal not sent yet is undone
  expect((await patch(base, 304, { project: true })).status).toBe(202);
  expect((await detailOf(base, 304)).fields).toMatchObject({ Status: "In progress" });
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.field === "member").map((o) => o.payload)).toEqual([true]);
});

test("edit: an Issue put in the Project here shows each later field edit before GitHub has its item", async () => {
  const base = await boot(fakeGh().gh);
  core!.db.sqlite.query("DELETE FROM backlog_records WHERE object_kind = 'project-item' AND json_extract(remote, '$.issue') = 302").run();
  // an empty map of fields does not put it in the Project
  expect((await patch(base, 302, { fields: {} })).status).toBe(202);
  expect(queued()).toEqual([]);
  expect((await patch(base, 302, { fields: { Status: "Backlog" } })).status).toBe(202);
  expect((await patch(base, 302, { fields: { Priority: "P2" } })).status).toBe(202);
  expect((await detailOf(base, 302)).fields).toEqual({ Status: "Backlog", Priority: "P2" });
  expect(queued().map((o) => o[2])).toEqual(["member", "field:Status", "field:Priority"]);
});

/** Runs `fn` with AWS_CONFIG_FILE on a made-up config holding one account id, which it is given bare. */
async function withHostAccount<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "backlog.aws."));
  writeFileSync(join(dir, "config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const saved = process.env.AWS_CONFIG_FILE;
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  try {
    return await fn(id);
  } finally {
    if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved;
    rmSync(dir, { recursive: true });
  }
}

test("edit: an unknown key is 400, an Issue not stored 404, one not read in full 409, a value that signs in 422 — none stored", async () => {
  const base = await boot(fakeGh().gh);
  expect((await patch(base, 304, { assignee: "me" })).status).toBe(400);
  expect((await patch(base, 999, { title: "x" })).status).toBe(404);
  core!.db.sqlite.query("UPDATE backlog_records SET fetch_state = 'unavailable' WHERE object_kind = 'issue' AND json_extract(remote, '$.number') = 303").run();
  const gone = await patch(base, 303, { title: "x" });
  expect(gone.status).toBe(409);
  expect(await gone.text()).toContain("unavailable");
  // still read as stored, with how its last read went
  expect(await detailOf(base, 303)).toMatchObject({ issue: { number: 303 }, fetchState: "unavailable" });
  // a label both added and removed is removed
  expect((await patch(base, 304, { labels: { add: ["P2"], remove: ["P2"] } })).status).toBe(202);
  expect((await detailOf(base, 304)).issue.labels).not.toContain("P2");
  // an edit waiting does not make one GitHub no longer shows editable, or listed
  expect((await patch(base, 304, { title: "待っている編集" })).status).toBe(202);
  core!.db.sqlite.query("UPDATE backlog_records SET fetch_state = 'unavailable' WHERE object_kind = 'issue' AND json_extract(remote, '$.number') = 304").run();
  expect((await patch(base, 304, { title: "y" })).status).toBe(409);
  expect((await refreshed(base, false)).items.some((i) => i.number === 304)).toBe(false);
  core!.db.sqlite.query("DELETE FROM backlog_operations").run();
  const token = `ghp_${"a".repeat(36)}`;
  const leaked = await patch(base, 304, { body: `メモ\n${token}` });
  expect(leaked.status).toBe(422);
  expect(await leaked.text()).not.toContain(token);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: token }) })).status).toBe(422);
  // an account id of the host's AWS config, written bare (#2351)
  const bare = await withHostAccount(async (id) => {
    const r = await patch(base, 304, { body: `メモ\n${id}` });
    return { status: r.status, leaks: (await r.text()).includes(id) };
  });
  expect(bare).toEqual({ status: 422, leaks: false });
  // the values that go to GitHub as they are: a Project field, a label, a milestone
  for (const edit of [{ fields: { Note: token } }, { fields: { [token]: "x" } }, { labels: { add: [token] } }, { milestone: token }]) expect((await patch(base, 304, edit)).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
});

/* ---------- a choice on a held conflict (#887) ---------- */

/** An import that read GitHub's Issue n with `over` (as the next import would store it). */
function importedAs(n: number, over: Record<string, unknown>, fetchState: "fetched" | "forbidden" = "fetched") {
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const rec = db.listBacklogRecords(source, "issue").find((r) => (r.remote as { number: number } | null)?.number === n)!;
  db.putBacklogSnapshot(source, { records: [fetchState === "fetched" ? { objectKind: "issue", externalId: rec.externalId, remote: { ...(rec.remote as object), ...over } as never, fetchState } : { objectKind: "issue", externalId: rec.externalId, remote: null, fetchState }], cursor: db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
}

test("resolve: a held conflict shows its three values and what A cannot keep; a choice names its revision — old 409, with an edit 400, none there 409", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true; // nothing is sent: the edits wait
  const was = (await detailOf(base, 304)).issue;
  expect((await patch(base, 304, { title: "手元の題", body: "手元の本文" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題", body: "GitHub の本文" });
  const d = await detailOf(base, 304);
  const title = d.held.find((h) => h.field === "title")!;
  expect(title).toMatchObject({ status: "conflict", kind: "set", reason: expect.stringContaining("GitHub の題"), conflict: { base: was.title, local: "手元の題", remote: "GitHub の題", remoteRead: true } });
  // it is held, not sent, and what the check keeps is told as it is, with what stays open (B is #1329)
  expect(d.pending).toBe(2);
  expect(d.limits).toContain("上書きしうる");
  expect(d.limits).toContain("#1329");
  expect(d.limits).toContain("100 版");
  const resolve = (field: string, choice: string, expectedRevision: string, extra = {}) => patch(base, 304, { resolve: { field, choice, expectedRevision }, ...extra });

  expect((await resolve("title", "local", title.conflict!.revision, { title: "ついで" })).status).toBe(400);
  expect((await resolve("milestone", "local", title.conflict!.revision)).status).toBe(409);
  // GitHub moved again after the screen read it
  importedAs(304, { title: "GitHub の題 2", body: "GitHub の本文" });
  const old = await resolve("title", "local", title.conflict!.revision);
  expect(old.status).toBe(409);
  expect((await detailOf(base, 304)).held.map((h) => h.status)).toEqual(["conflict", "conflict"]);

  // the local value: sent again on GitHub's; GitHub's value: the edit is dropped and GitHub's shows
  const now = await detailOf(base, 304);
  const r = await resolve("title", "local", now.held.find((h) => h.field === "title")!.conflict!.revision);
  expect(r.status).toBe(202);
  expect(core!.db.getBacklogOperation(((await r.json()) as { operation: string }).operation)).toMatchObject({ status: "pending", base: "GitHub の題 2", payload: "手元の題" });
  expect((await resolve("body", "remote", now.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(202);
  const after = await detailOf(base, 304);
  expect(after.held).toEqual([]);
  expect(after.issue).toMatchObject({ title: "手元の題", body: "GitHub の本文" });
});

test("overwritten (#1329): a conflict the write found afterwards shows the other's value from the history as remote, not GitHub's; remote sends it back, a gone revision is not readable", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "v3", body: "b3" })).status).toBe(202);
  // the send wrote both (GitHub now has them) and found another login's edits in the history
  const ops = core!.db.listPendingBacklogOperations();
  core!.db.setBacklogOperationResult(ops.find((o) => o.field === "title")!.id, { status: "conflict", error: "書く直前に them が 2026-10-12T10:00:00Z に title を v2 にしていました", overwritten: { value: "v2", editor: "them", at: "2026-10-12T10:00:00Z" } });
  core!.db.setBacklogOperationResult(ops.find((o) => o.field === "body")!.id, { status: "conflict", error: "版の内容は履歴から消されています", overwritten: { editor: "them", at: "2026-10-12T10:00:00Z" } });
  importedAs(304, { title: "v3", body: "b3" });
  const d = await detailOf(base, 304);
  const title = d.held.find((h) => h.field === "title")!;
  expect(title).toMatchObject({ status: "conflict", reason: expect.stringContaining("them"), conflict: { base: expect.anything(), local: "v3", remote: "v2", remoteRead: true } });
  expect(d.held.find((h) => h.field === "body")!.conflict).toMatchObject({ local: "b3", remote: null, remoteRead: false });
  const resolve = (field: string, choice: string, expectedRevision: string) => patch(base, 304, { resolve: { field, choice, expectedRevision } });
  // the gone revision cannot be chosen as remote; local goes on
  expect((await resolve("body", "remote", d.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(409);
  expect((await resolve("body", "local", d.held.find((h) => h.field === "body")!.conflict!.revision)).status).toBe(202);
  // remote: the found value is queued as a new set on GitHub's current value
  const r = await resolve("title", "remote", title.conflict!.revision);
  expect(r.status).toBe(202);
  expect(core!.db.getBacklogOperation(((await r.json()) as { operation: string }).operation)).toMatchObject({ status: "pending", payload: "v2", base: "v3", overwritten: null });
  expect((await detailOf(base, 304)).issue).toMatchObject({ title: "v2", body: "b3" });
});

test("limits: what the send cannot keep is named per field — the Project fields without a history, the evicted revision, the same login — and nothing is promised (#1329)", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const d = await detailOf(base, 304);
  expect(d.limits).toContain("Status 以外の Project フィールド");
  expect(d.limits).toContain("100 版");
  expect(d.limits).toContain("同じ GitHub アカウント");
  expect(d.limits).toContain("消されていれば");
  expect(d.limits).toContain("#1329");
  expect(d.limits).not.toMatch(/保証します|防ぎます/);
});

test("resolve: the same number in another repository is another Issue — a choice there does not touch this one's conflict", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  const held = (await detailOf(base, 304)).held[0]!;
  // another workspace whose repository has its own #304, nothing held
  const db = core!.db;
  const mine = db.getWorkspaceBacklogSource(metaId())!;
  const other = db.upsertWorkspace({ id: "ws_tool", name: "tool", path: join(home!, "tool"), kind: "repo" });
  const source = { ...mine, repository: "acme/tool" };
  db.setWorkspaceBacklogSource(other.id, source);
  const rec = db.listBacklogRecords(mine, "issue").find((r) => (r.remote as { number: number }).number === 304)!;
  // the same external id too: only the repository tells them apart
  db.putBacklogSnapshot(source, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: rec.remote as never, fetchState: "fetched" }], cursor: null, syncedAt: Date.now() });
  const r = await fetch(`${base}/api/backlog/304`, { method: "PATCH", body: JSON.stringify({ workspaceId: other.id, resolve: { field: "title", choice: "remote", expectedRevision: held.conflict!.revision } }) });
  expect(r.status).toBe(409);
  expect(((await (await fetch(`${base}/api/backlog/304?workspaceId=${other.id}`)).json()) as BacklogIssueDetail).held).toEqual([]);
  expect((await detailOf(base, 304)).held).toEqual([held]);
});

test("resolve: a conflict GitHub cannot be read on keeps GitHub's only; a refused send is shown as held with its reason, not as sent", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  importedAs(304, {}, "forbidden");
  const held = (await detailOf(base, 304)).held[0]!;
  expect(held.conflict).toMatchObject({ remote: null, remoteRead: false });
  expect((await patch(base, 304, { resolve: { field: "title", choice: "local", expectedRevision: held.conflict!.revision } })).status).toBe(409);
  expect((await patch(base, 304, { resolve: { field: "title", choice: "remote", expectedRevision: held.conflict!.revision } })).status).toBe(202);

  // a permission refused on the send: failed, with why
  core!.db.sqlite.exec("DELETE FROM backlog_operations");
  importedAs(304, { title: "GitHub の題" });
  expect((await patch(base, 304, { title: "書けない題" })).status).toBe(202);
  const op = core!.db.listPendingBacklogOperations()[0]!;
  core!.db.setBacklogOperationResult(op.id, { status: "failed", error: "gh api repos/acme/app/issues/304: HTTP 403" });
  expect((await detailOf(base, 304)).held).toEqual([expect.objectContaining({ operation: op.id, status: "failed", reason: expect.stringContaining("403"), conflict: null })]);
});

test("create: a new Issue is kept with a local id, read and edited by it before it has a number; it is not in the list yet", async () => {
  const base = await boot(fakeGh().gh);
  // during a limit: nothing is sent, so the create can still be changed
  core!.db.setBacklogRetryAt(core!.db.getWorkspaceBacklogSource(metaId())!, Date.now() + 3_600_000);
  const r = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: "要望: 新しい", body: "本文", labels: ["type:request"], fields: { Status: "Backlog" } }) });
  expect(r.status).toBe(202);
  const { localId } = (await r.json()) as { localId: string };
  const d = await detailOf(base, localId);
  expect(d).toMatchObject({ localId, pending: 1, fields: { Status: "Backlog" }, issue: { number: 0, title: "要望: 新しい", labels: ["type:request"] } });
  // not sent yet: the edit changes what is created
  expect((await patch(base, localId, { title: "要望: 直した", fields: { Priority: "P2" } })).status).toBe(202);
  expect(core!.db.listPendingBacklogOperations()).toMatchObject([{ id: localId, kind: "create", payload: { title: "要望: 直した", project: { owner: "acme", number: 11, fields: { Status: "Backlog", Priority: "P2" } } } }]);
  expect((await detailOf(base, localId)).issue.title).toBe("要望: 直した");
  expect((await refreshed(base, false)).items.some((i) => i.number === 0)).toBe(false);
  expect((await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: " " }) })).status).toBe(400);
});

test("send: an answer kept is sent to GitHub at once; after a restart one that was out is looked for, not posted again", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const posts = () => fake.calls.filter((a) => a[1] === "repos/acme/app/issues/306/comments" && a.includes("POST")).length;
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "すぐ送る" }) })).status).toBe(202);
  for (let i = 0; i < 100 && posts() === 0; i++) await Bun.sleep(10);
  expect(posts()).toBe(1);

  // the daemon stops while a post is out; at its start it looks for it and posts nothing
  const h = home!;
  const db = core!.db;
  db.sqlite.exec("DELETE FROM backlog_operations; DELETE FROM backlog_records WHERE remote IS NULL; UPDATE backlog_records SET local = NULL");
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(metaId())!, Date.now() + 3_600_000);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "送信中に止まった" }) })).status).toBe(202);
  db.setBacklogOperationResult(db.listPendingBacklogOperations()[0]!.id, { status: "sending" });
  db.sqlite.exec("UPDATE backlog_repositories SET retry_at = NULL");
  await core!.stop();
  fake.calls.length = 0;
  const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(fake.gh), backlogAutoImport: true });
  const looked = () => fake.calls.some((a) => a[1]?.startsWith("repos/acme/app/issues/306/comments?"));
  for (let i = 0; i < 100 && !looked(); i++) await Bun.sleep(10);
  expect(looked()).toBe(true);
  expect(posts()).toBe(0);
  expect(core.db.listPendingBacklogOperations()[0]).toMatchObject({ kind: "comment", status: "unknown" });
});

test("an answer during a limit is stored, read by the next start, and sent after the limit (#2264)", async () => {
  const fake = limitedGh();
  // GitHub's REST answers for #306's comments and labels, as backlog-send.test.ts's fake GitHub gives them
  // and its reads before and after a write (graphql, #887 / #1329) with no one else's edits
  const comments: Array<{ node_id: string; body: string; created_at: string }> = [];
  let labels = ["type:pbi", "needs-decision"];
  const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\ndate: ${new Date().toUTCString()}\n\n${JSON.stringify(body)}`, stderr: "" });
  const gh: GhRunner = async (args, cwd) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const of306 = args[1]?.startsWith("repos/acme/app/issues/306/") || (query.includes("issue(number:$n)") && args.includes("n=306"));
    if (fake.limited.on || args[0] !== "api" || !of306) return fake.gh(args, cwd);
    fake.calls.push(args);
    if (args[1] === "graphql") {
      const r = core!.db.listBacklogRecords(core!.db.getWorkspaceBacklogSource(metaId())!, "issue").find((x) => (x.remote as { number: number } | null)?.number === 306)!.remote as unknown as { id: string; title: string; body: string };
      const issue = { id: r.id, title: r.title, body: r.body, state: "OPEN", milestone: null, parent: null, labels: { nodes: labels.map((name) => ({ name })) }, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] }, userContentEdits: { pageInfo: { hasNextPage: false }, nodes: [] } };
      return ok({ data: { viewer: { login: "me" }, repository: { issue } } });
    }
    if (args[1] === "repos/acme/app/issues/306/comments" && args.includes("POST")) {
      const c = { node_id: `IC_306_${comments.length}`, body: args[args.indexOf("-f") + 1]!.slice("body=".length), created_at: new Date().toISOString() };
      comments.push(c);
      return ok(c);
    }
    if (args.includes("DELETE")) labels = labels.filter((l) => !args[1]!.endsWith(`/labels/${l}`));
    return ok(args[1]!.includes("/comments") ? comments : []);
  };
  const claude = holdingClaude();
  const base = await boot(gh, claude.adapter);
  fake.limited.on = true;
  // 1. answered while GitHub refuses every read and write for its limit: kept here at once
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "上限中の回答" }) })).status).toBe(202);
  const detail = (await (await fetch(`${base}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;
  expect(detail.comments.at(-1)!.body).toBe("## 回答\n\n上限中の回答");
  expect(detail.sync.pendingCount).toBeGreaterThanOrEqual(1);
  expect((await refreshed(base, false)).items.find((i) => i.number === 306)!.stage).not.toBe("needs-decision");
  // 2. the next stage starts on the stored data, and its Task is told to read the answer with --fresh
  expect((await start(base, 306, { action: "complete" })).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("`ops-kit backlog view 306 --fresh`");
  // 3. the limit ends (its time passed: the daemon starts again without the wait): the answer is sent once, comment then label
  const h = home!;
  core!.db.sqlite.exec("UPDATE backlog_repositories SET retry_at = NULL; UPDATE backlog_operations SET retry_at = NULL");
  await core!.stop();
  fake.limited.on = false;
  fake.calls.length = 0;
  const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(gh), backlogAutoImport: true });
  const after = `http://127.0.0.1:${core.server.port}`;
  const writes = () => fake.calls.filter((a) => a.includes("POST") || a.includes("DELETE")).map((a) => `${a.includes("POST") ? "POST" : "DELETE"} ${a[1]}`);
  for (let i = 0; i < 200 && core.db.listPendingBacklogOperations().length > 0; i++) await Bun.sleep(10);
  expect(writes()).toEqual(["POST repos/acme/app/issues/306/comments", "DELETE repos/acme/app/issues/306/labels/needs-decision"]);
  expect(comments.map((c) => c.body.split("\n\n<!--")[0])).toEqual(["## 回答\n\n上限中の回答"]);
  await fetch(`${after}/api/backlog/sync`, { method: "POST", body: JSON.stringify({ workspaceId: metaId() }) });
  expect(((await (await fetch(`${after}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail).sync.pendingCount).toBe(0);
});

test("start: close on a closable PBI makes #N 閉じる: with the pbi-complete step 6 prompt; not closable is 409", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  // #308 has confirmations left, #305 open Tasks, #304 is Ready: none is closable
  for (const n of [308, 305, 304]) expect((await start(base, n, { action: "close" })).status).toBe(409);
  const r = await start(base, 307, { action: "close" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title).toBe("#307 閉じる: PBI: Task が全部閉じた実装中の PBI");
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const p = claude.starts[0]!.prompt;
  expect(p).toContain(".claude/skills/pbi-complete/SKILL.md の「6. PBI を閉じる」に従い、PBI #307 の受け入れ条件を検証結果つきで埋め、## 結果 を書いて閉じてください");
  expect(p).not.toContain("merge-gate");
  // the in-progress row's button is still 状況確認; a close Task is a stage Task like the others
  expect(buildStartPrompt({ number: 307 }, "check")).toContain("PBI #307 の今の状況を確認してください");
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 307)!.activeTaskId).toBeString();
  expect((await start(base, 307, { action: "close" })).status).toBe(409);
});

test("start: the resume of a stalled PBI writes a ## 状況 in the 状況確認's form with the tasks-done mark, asks with ## 判断待ち, else goes on with pbi-complete (#578)", () => {
  const p = buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 3 } });
  expect(p).toContain("PBI #305 は実装中のまま止まっています");
  expect(p).toContain("Issue #305 に `## 状況` で始まるコメントを 1 件書いてください。中身は `### 済んだこと` / `### 残り` / `### 止まっている理由`");
  expect(p).toContain("`<!-- tasks-done: 3 -->` を 1 行そのまま入れて");
  expect(p).toContain("`## 判断待ち` を出して止めてください");
  // a slash command is expanded only at the start of a prompt: the resume names the skill's file
  expect(p).toContain("無ければ続けて .claude/skills/pbi-complete/SKILL.md に従い、PBI #305 を完了させてください");
  expect(p).not.toContain("/pbi-complete 305");
  expect(p).toContain("（sub-issue の Task のものも）を読み");
  // the 状況確認's form is the same text
  const report = /`## 状況` で始まるコメントを 1 件書いてください。[^。]*。/.exec(p)![0];
  expect(buildStartPrompt({ number: 305 }, "check")).toContain(report);
  // another repository: the skill file, not the slash command; without resume, the plain 実装
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  expect(buildStartPrompt({ number: 7 }, "complete", { other, resume: { tasksDone: 0 } })).toContain("`<!-- tasks-done: 0 -->`");
  expect(buildStartPrompt({ number: 7 }, "complete", { other, resume: { tasksDone: 0 } })).toContain(".claude/skills/pbi-complete/SKILL.md に従い、PBI #7 を完了させてください。");
  expect(buildStartPrompt({ number: 7 }, "complete")).not.toContain("tasks-done");
});

test("start: a complete prompt says the request covers merges the merge gate passes and closing the PBI (#1357)", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  const scope = "この依頼は、マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ、リリースタグ、PBI を閉じるところまでを含みます。";
  for (const opts of [{}, { resume: { tasksDone: 1 } }, { other }, { other, resume: { tasksDone: 1 } }]) {
    const p = buildStartPrompt({ number: 305 }, "complete", opts);
    expect(p).toContain(scope);
    expect(p).toContain("マージ判定が `[聞く]` で止めたとき、昇格・デーモンの再起動、認証は、これまでどおり Task の会話で聞いてください");
    expect(p).toContain("「この依頼が含む範囲」");
    expect(p.startsWith(opts.resume ? "PBI #305 は実装中のまま" : opts.other ? ".claude/skills/pbi-complete/SKILL.md" : "/pbi-complete 305\n")).toBe(true);
  }
  // the first line stays: a slash command is expanded only at the start of a prompt
  expect(buildStartPrompt({ number: 305 }, "complete").startsWith("/pbi-complete 305\n")).toBe(true);
  // the stages that do not merge do not carry it
  for (const action of ["check", "close", "to-pbi", "to-tasks"] as const) expect(buildStartPrompt({ number: 305 }, action)).not.toContain("この依頼は、マージ判定");
});

test("start: the prompt says to read the newest ## 回答 first", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await start(base, 304, { action: "complete" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("Issue #304 の最新の `## 回答` コメント（sub-issue の Task のものも）を読み");
});

const item = (over: Partial<BacklogItem>): BacklogItem => ({
  number: 1, title: "t", url: "u", type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, report: null, answeredAt: null, heldAt: null, confirmations: [], closable: false, waits: [], waitsAt: null, overlap: null, prereqs: [], stopSummary: [], sync: { state: "synced", reason: null, lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" }, workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});

test("pickNext: Ready before 分解待ち before 要望, then Priority (none last), then the oldest; skips decisions and running items", () => {
  const items = [
    item({ number: 1, stage: "request", priority: "P0" }),
    item({ number: 2, stage: "needs-tasks", priority: "P0" }),
    item({ number: 3, stage: "ready", priority: null }),
    item({ number: 4, stage: "ready", priority: "P1", createdAt: "2026-09-03T00:00:00Z" }),
    item({ number: 5, stage: "ready", priority: "P1", createdAt: "2026-09-02T00:00:00Z" }),
    item({ number: 6, stage: "ready", priority: "P0", activeTaskId: "tsk" }),
    item({ number: 7, stage: "needs-decision", priority: "P0" }),
    item({ number: 8, stage: "in-progress", priority: "P0" }),
  ];
  expect(pickNext(items, "implement")).toEqual({ item: items[4]!, action: "complete" });
  // the plan slot (#561): 分解待ち before 要望, never a Ready PBI
  expect(pickNext(items, "plan")).toMatchObject({ item: { number: 2 }, action: "to-tasks" });
  expect(pickNext([items[0]!], "plan")).toMatchObject({ item: { number: 1 }, action: "to-pbi" });
  expect(pickNext([items[0]!], "implement")).toBeNull();
  expect(pickNext(items.slice(5), "implement")).toBeNull();
  expect(pickNext(items.slice(5), "plan")).toBeNull();
});

test("pickNext answered: an in-progress PBI answered after its last stage Task goes on with complete, before Ready", () => {
  const finished = (at: string) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null });
  const items = [
    item({ number: 1, stage: "ready", priority: "P0" }),
    item({ number: 2, stage: "in-progress", priority: "P3", answeredAt: null, lastTask: finished("2026-09-28T00:00:00Z") }), // no answer
    item({ number: 3, stage: "in-progress", priority: "P3", answeredAt: "2026-09-27T00:00:00Z", lastTask: finished("2026-09-28T00:00:00Z") }), // older than its last Task
    item({ number: 4, stage: "in-progress", priority: "P3", answeredAt: "2026-09-28T01:00:00Z", lastTask: finished("2026-09-28T00:00:00Z"), createdAt: "2026-09-02T00:00:00Z" }),
    // never started from the backlog: whoever runs it (a session outside the backlog) reads the answer itself
    item({ number: 5, stage: "in-progress", priority: "P0", answeredAt: "2026-09-28T01:00:00Z", lastTask: null }),
  ];
  expect(pickNext(items, "implement")).toEqual({ item: items[3]!, action: "complete" });
  expect(pickNext([items[0]!, items[4]!], "implement")).toMatchObject({ item: { number: 1 } });
  // only answered ones: without #4 and #5, Ready is next; the plan slot never takes them
  expect(pickNext(items.slice(0, 3), "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  expect(pickNext(items.slice(1), "plan")).toBeNull();
  // a status check that finished after the answer has taken it up; a running stage Task holds it
  expect(pickNext([items[0]!, { ...items[3]!, lastTask: { id: "tsk_check", status: "done", statusAt: Date.parse("2026-09-28T02:00:00Z"), createdAt: Date.parse("2026-09-28T02:00:00Z"), updatedAt: Date.parse("2026-09-28T02:00:00Z"), action: "check", outcome: "unknown" as const, reviewedAt: null, resumeAt: null } }], "implement")).toMatchObject({ item: { number: 1 } });
  expect(pickNext([items[0]!, { ...items[3]!, activeTaskId: "tsk_run" }], "implement")).toMatchObject({ item: { number: 1 } });
});

test("pickNext answered: a PBI still waiting on a decision, its own or a Task's, is left and Ready goes on", () => {
  const answered = { answeredAt: "2026-09-28T01:00:00Z", lastTask: null };
  const waiting = item({ number: 2, stage: "needs-decision", priority: "P0", ...answered, decision: { body: "## 判断待ち", at: "2026-09-28T02:00:00Z", issue: 20 } });
  const ready = item({ number: 1, stage: "ready", priority: "P3" });
  expect(pickNext([waiting, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(pickNext([waiting], "implement")).toBeNull();
});

test("pickNext answered: backlog-next starts 実装 on an in-progress PBI whose Task was answered after its last stage Task", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", [], [["## 回答\n\nB で", new Date(Date.now() + 60_000).toISOString()]])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  // #305's last stage Task stopped on the question before it was answered
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const titles = core!.db.listTasks().map((t) => t.title);
  expect(titles).toContainEqual(expect.stringMatching(/^#305 実装: /));
  expect(titles.some((t) => t.startsWith("#304 "))).toBe(false); // the implement slot went to #305, before Ready #304
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#305 を complete で開始"));
  // the answer may be on a Task: the prompt points there too
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.find((x) => x.prompt.includes("/pbi-complete 305"))!.prompt).toContain("`## 回答` コメント（sub-issue の Task のものも）を読み");
});

test("pickNext waiting: an in-progress PBI whose waits all closed goes on with complete, after an answered one and before Ready; an open wait holds Ready and in-progress alike", () => {
  const finished = { id: "tsk_last", status: "done" as const, statusAt: Date.parse("2026-09-28T00:00:00Z"), createdAt: Date.parse("2026-09-28T00:00:00Z"), updatedAt: Date.parse("2026-09-28T00:00:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null };
  const closed = [wait(778, "pr", false), wait(603, "issue", false)];
  const open = [wait(778, "pr", true), wait(603, "issue", false)];
  const ready = item({ number: 1, stage: "ready", priority: "P0" });
  // the release came before its 実装 finished, so the Issue looks unchanged since: an unblocked PBI is taken all the same
  const unblocked = item({ number: 2, stage: "in-progress", priority: "P3", waits: closed, waitsAt: STOPPED, lastTask: finished });
  const answered = item({ number: 3, stage: "in-progress", priority: "P3", answeredAt: "2026-09-28T01:00:00Z", lastTask: finished });
  expect(pickNext([ready, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
  expect(pickNext([ready, unblocked, answered], "implement")).toMatchObject({ item: { number: 3 }, action: "complete" });
  expect(pickNext([unblocked], "plan")).toBeNull();
  // a Ready PBI stopped the same way, unchanged since its last 実装, goes on once its waits closed
  const unblockedReady = item({ number: 4, stage: "ready", waits: closed, waitsAt: STOPPED, lastTask: finished });
  expect(pickNext([unblockedReady], "implement")).toEqual({ item: unblockedReady, action: "complete" });
  // one open wait: neither a Ready nor an in-progress PBI is taken, and the slot lists them
  const waitingReady = item({ number: 5, stage: "ready", priority: "P0", waits: open });
  const waitingBuilding = { ...unblocked, number: 6, waits: open };
  expect(pickNext([waitingReady, waitingBuilding], "implement")).toBeNull();
  expect(pickNext([waitingReady, waitingBuilding, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(heldIn([waitingReady, waitingBuilding, ready, unblocked], "implement").map((h) => h.item).map((i) => i.number)).toEqual([5, 6]);
  expect(heldIn([waitingReady, waitingBuilding], "plan").map((h) => h.item)).toEqual([]);
  // a running one is busy, not held by its wait
  expect(heldIn([{ ...waitingReady, activeTaskId: "tsk_run" }], "implement").map((h) => h.item)).toEqual([]);
  // a wait not read (#1046) holds it as an open one does: neither taken as unblocked nor started
  const unread = { ...unblocked, number: 7, waits: [...closed, wait(999, "issue", null)] };
  expect(pickNext([unread, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(heldIn([unread], "implement").map((h) => h.item).map((i) => i.number)).toEqual([7]);
});

test("pickNext stalled: an in-progress PBI with every Task closed is closed; one with Tasks left is resumed unless it did not move since its last resume", () => {
  const report = (n: number | null, at = "2026-09-29T00:00:00Z") => ({ body: `## 状況\n### 残り\n- #12${n === null ? "" : `\n${TASKS_DONE_MARK(n)}`}`, at });
  const closable = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true });
  const stalled = item({ number: 2, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } });
  expect(pickNext([closable], "implement")).toEqual({ item: closable, action: "close" });
  expect(pickNext([stalled], "implement")).toEqual({ item: stalled, action: "complete", resume: true });
  expect(pickNext([closable, stalled], "plan")).toBeNull();
  // a confirmation left (not closable) with every Task closed: neither closed nor resumed
  expect(pickNext([{ ...closable, closable: false, confirmations: [{ n: 1, text: "見た目（利用者確認: 画面）" }] }], "implement")).toBeNull();
  // a running stage Task or a question holds it
  expect(pickNext([{ ...closable, activeTaskId: "tsk_run" }, { ...stalled, activeTaskId: "tsk_run" }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, stage: "needs-decision", decision: { body: "## 判断待ち", at: "2026-09-29T00:00:00Z", issue: 2 } }], "implement")).toBeNull();
  // a 閉じる that finished with no update since is not started again; an update brings it back
  const triedClose = { ...closable, lastTask: { id: "tsk_close", status: "error" as const, statusAt: Date.parse("2026-09-29T00:00:00Z"), createdAt: Date.parse("2026-09-29T00:00:00Z"), updatedAt: Date.parse("2026-09-29T00:00:00Z"), action: "close" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null } };
  expect(pickNext([triedClose], "implement")).toBeNull();
  expect(pickNext([{ ...triedClose, updatedAt: "2026-09-29T01:00:00Z" }], "implement")).toMatchObject({ action: "close" });
  expect(unchangedIn([triedClose, closable], "implement").map((i) => i.number)).toEqual([1]);
  expect(unchangedIn([{ ...triedClose, updatedAt: "2026-09-29T01:00:00Z" }], "implement")).toEqual([]);
  expect(unchangedIn([triedClose], "plan")).toEqual([]);
  // started for another reason or listed under 待ち: not named as unchanged
  expect(unchangedIn([{ ...triedClose, answeredAt: "2026-09-29T01:00:00Z" }, { ...triedClose, number: 9, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  // the mark of the last resume: the same count → left (and listed); a Task closed since → resumed; an answer after it → resumed
  const spun = { ...stalled, report: report(1) };
  expect(pickNext([spun], "implement")).toBeNull();
  expect(spinningIn([spun, stalled, closable], "implement").map((i) => i.number)).toEqual([2]);
  expect(spinningIn([spun], "plan")).toEqual([]);
  expect(pickNext([{ ...spun, tasks: { total: 3, done: 2, doneAt: null } }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...spun, answeredAt: "2026-09-29T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...spun, answeredAt: "2026-09-28T23:00:00Z" }], "implement")).toBeNull();
  // a ## 状況 without the mark (a 状況確認's) does not hold it
  expect(pickNext([{ ...stalled, report: report(null) }], "implement")).toMatchObject({ action: "complete", resume: true });
  // #1051: a resume that ended (done: a failed one is #1275's) before writing its mark is left until the Issue, a Task or an answer moves past its start
  const died = { ...stalled, lastTask: { id: "tsk_resume", status: "done" as const, statusAt: Date.parse("2026-09-30T00:00:00Z"), createdAt: Date.parse("2026-09-30T00:00:00Z"), updatedAt: Date.parse("2026-09-30T00:10:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null } };
  expect(pickNext([died], "implement")).toBeNull();
  expect(spinningIn([died], "implement").map((i) => i.number)).toEqual([2]);
  expect(pickNext([{ ...died, updatedAt: "2026-09-30T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true }); // a comment (also: a Ready 実装 that logged its start, then stopped)
  expect(pickNext([{ ...died, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true }); // a Task closed since
  expect(pickNext([{ ...died, answeredAt: "2026-09-30T01:00:00Z" }], "implement")?.item.number).toBe(2); // an answer
  expect(pickNext([{ ...died, tasks: { total: 3, done: 1, doneAt: "2026-09-29T00:00:00Z" } }], "implement")).toBeNull(); // a Task closed before the resume
  expect(pickNext([{ ...died, lastTask: { ...died.lastTask, action: "check" as const } }], "implement")).toMatchObject({ action: "complete", resume: true }); // the last Task was a 状況確認
  // a resume that failed (error) before writing its mark is #1275's: held until the Issue, an answer or a closed Task is newer than its end
  const failed = { ...died, lastTask: { ...died.lastTask, status: "error" as const } };
  expect(pickNext([failed], "implement")).toBeNull();
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T00:05:00Z" } }], "implement")).toBeNull(); // closed before it ended
  // a Task closing does not answer a question the resume asked the person (#1275)
  const asking = { ...died, lastTask: { ...died.lastTask, outcome: "needs_action" as const } };
  expect(pickNext([{ ...asking, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toBeNull();
  expect(tasksDoneMark(report(4))).toBe(4);
  expect(tasksDoneMark(report(null))).toBeNull();
  expect(tasksDoneMark(null)).toBeNull();
});

test("pickNext stalled: the implement slot's order is 回答済みの実装中 → 閉じられる実装中 → 止まった実装中 → Ready", () => {
  const finished = { id: "tsk_last", status: "done" as const, statusAt: Date.parse("2026-09-28T00:00:00Z"), createdAt: Date.parse("2026-09-28T00:00:00Z"), updatedAt: Date.parse("2026-09-28T00:00:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null };
  const ready = item({ number: 1, stage: "ready", priority: "P0" });
  const stalled = item({ number: 2, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null } });
  const closable = item({ number: 3, stage: "in-progress", priority: "P3", tasks: { total: 2, done: 2, doneAt: null }, closable: true });
  const answered = item({ number: 4, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null }, answeredAt: "2026-09-28T01:00:00Z", lastTask: finished });
  const all = [ready, stalled, closable, answered];
  expect(pickNext(all, "implement")).toEqual({ item: answered, action: "complete" });
  expect(pickNext(all.slice(0, 3), "implement")).toEqual({ item: closable, action: "close" });
  expect(pickNext(all.slice(0, 2), "implement")).toEqual({ item: stalled, action: "complete", resume: true });
  expect(pickNext(all.slice(0, 1), "implement")).toEqual({ item: ready, action: "complete" });
  // an open wait holds a stalled PBI too (#817)
  expect(pickNext([{ ...stalled, waits: [wait(778, "pr", true)] }, ready], "implement")).toMatchObject({ item: { number: 1 } });
});

test("backlog-next stalled: the closable #307 is closed and #305, unmoved since its last resume, is left and logged", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "OPEN", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  // implement 2: one firing would take both if both could go
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ backlogSweep: { implement: 2, plan: 0 } }) })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#307 閉じる"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前回の再開から進んでいない: #305`));
  expect(log).toContainEqual(expect.stringContaining("#307 を close で開始"));
});

test("backlog-next stalled: #305 with a Task closed since its last resume is resumed with 実装 before Ready", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "CLOSED", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#305 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#305 を complete で開始"));
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("#305"))!.prompt;
  expect(prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 2 } }));
  expect(prompt).toContain("`<!-- tasks-done: 2 -->` を 1 行そのまま入れて");
});

test("backlog-next stalled: #305 whose last resume ended before writing a mark is left and logged until a Task closes", async () => {
  const claude = holdingClaude();
  const open = [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "CLOSED", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])];
  const base = await boot(taskDecisionGh({ i305: open, i307: [] }).gh, claude.adapter);
  closeTried();
  const now = Date.now();
  core!.db.insertTask({ ...core!.db.getTask(`tsk_close307_${metaId()}`)!, id: `tsk_close307_resume305`, title: "#305 実装: PBI: 実装中の PBI", stage: { issue: 305, action: "complete" }, status: "done", createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).not.toContain("#305 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前回の再開から進んでいない: #305`));
});

test("backlog-next stalled: #305 with a Task closed after its unmarked resume began is resumed", async () => {
  const claude = holdingClaude();
  const now = Date.now();
  const later = new Date(now + 3_600_000).toISOString();
  const subs = [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "CLOSED", ["type:task"], [], later), subTask(312, "OPEN", ["type:task"], [])];
  const base = await boot(taskDecisionGh({ i305: subs, i307: [] }).gh, claude.adapter);
  closeTried();
  core!.db.insertTask({ ...core!.db.getTask(`tsk_close307_${metaId()}`)!, id: "tsk_close307_resume305", title: "#305 実装: PBI: 実装中の PBI", stage: { issue: 305, action: "complete" }, status: "done", createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#305 を complete で開始"));
});

test("backlog-next waiting: an open wait is not started and the log names it; once it closed the next firing starts 実装 on the in-progress PBI first", async () => {
  const claude = holdingClaude();
  const states = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "OPEN" } };
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]], i307: [[releaseBody("後回し", [778, 603]), STOPPED]] }, states);
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #304（PR #778 マージ待ち） #307（#603 未完・PR #778 マージ待ち）`));
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // both closed: #307 (in progress) goes before Ready #304
  states.w603.state = "CLOSED";
  states.w778.state = "MERGED";
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#307 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#307 を complete で開始"));
});

test("backlog-next waiting: a wait GitHub did not find is not taken as closed, and the log says it was not read (#1046)", async () => {
  const claude = holdingClaude();
  const states = { w603: { __typename: "Issue", state: "CLOSED" }, w999: null };
  const fake = waitsGh({ i307: [[releaseBody("後回し", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#307 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められない: #307（#999 見つからない）`));
});

test("backlog-next waiting: a 状況確認 started after the waits were written leaves them; once they closed the next firing starts 実装", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  // the row's 状況を確認 only reads and reports (#853): it does not claim, and the waits stand
  core!.db.insertTask({ id: "tsk_check", workspaceId: metaId(), title: "#307 状況確認: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 状況確認: PBI: 実装中の PBI"), statusAt: Date.parse(LATER), createdAt: Date.parse(LATER), updatedAt: Date.now() });
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [{ number: 778, open: false }], waitsAt: STOPPED });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#307 実装");
});

test("backlog-next waiting: a 状況確認 after an 実装 that made the waits old does not bring them back", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const task = (id: string, title: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title, runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: at, createdAt: at, updatedAt: Date.now() });
  // the resumed 実装 failed before it claimed, then the row's 状況を確認 ran: the newest stage Task is the check
  task("tsk_impl", "#307 実装: PBI: 実装中の PBI", Date.parse(LATER), "error");
  task("tsk_check", "#307 状況確認: PBI: 実装中の PBI", Date.parse(LATER) + 60_000, "done");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "))).toHaveLength(1);
});

test("backlog-next waiting: a stage Task started after the waits were written makes them old — a resumed 実装 that failed before claiming is not started again", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const task = (id: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title: "#307 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 実装: PBI: 実装中の PBI"), statusAt: at, createdAt: at, updatedAt: Date.now() });
  // the 実装 that wrote the release started before it: the waits stand
  task("tsk_before", Date.parse(STOPPED) - 3_600_000, "done");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [{ number: 778, open: false }], waitsAt: STOPPED });
  // the resumed one started after it and failed before it claimed: the waits are old, shown nowhere, and nothing restarts it
  task("tsk_after", Date.parse(LATER), "error");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "))).toHaveLength(2);
});

describe("backlog-next prerequisite (#937)", () => {
  type Pbi = { status?: string; priority: string; body?: string; comments?: Array<[string, string]>; tasks?: Array<{ number: number; state: string; body?: string }> };
  /**
   * A GitHub of Ready PBIs (`pbis`, by number) and what they name (`others`: the answers to the import's recheck, by
   * `w<n>`; a number not there is NOT_FOUND), in the shape the fixtures' gh answers (`importing` reads it).
   */
  function prereqGh(pbis: Record<number, Pbi>, others: Record<string, unknown> = {}) {
    const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    const gh: GhRunner = async (args) => {
      if (args[0] === "repo") return { code: 0, stdout: "acme/app\n", stderr: "" };
      if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
      if (args[0] === "issue") return { code: 0, stdout: "", stderr: "" };
      const q = args.find((a) => a.startsWith("query=")) ?? "";
      const open = Object.entries(pbis).map(([n, p]) => [Number(n), p] as const);
      if (q.includes("comments(last:"))
        return answer({ repository: Object.fromEntries(open.map(([n, p]) => [`i${n}`, { comments: { nodes: (p.comments ?? []).map(([body, createdAt]) => ({ body, createdAt })) }, subIssues: { nodes: (p.tasks ?? []).map((t) => ({ ...t, labels: { nodes: [{ name: "type:task" }] }, comments: { nodes: [] } })) } }])) });
      if (q.includes("issueOrPullRequest")) return answer({ repository: others });
      return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(([n, p]) => ({
        number: n, title: `PBI ${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", body: p.body ?? "", createdAt: `2026-09-01T00:00:${String(n % 60).padStart(2, "0")}Z`, updatedAt: "2026-09-10T00:00:00Z",
        labels: { nodes: [{ name: "type:pbi" }] }, subIssuesSummary: { total: p.tasks?.length ?? 0, completed: (p.tasks ?? []).filter((t) => t.state === "CLOSED").length, doneAt: null },
        projectItems: { nodes: [{ project: { number: 11 }, fieldValues: { nodes: [{ name: p.status ?? "Ready", field: { name: "Status" } }, { name: p.priority, field: { name: "Priority" } }] } }] },
      })) } } });
    };
    return gh;
  }
  const closedIssue = (stateReason: string) => ({ __typename: "Issue", state: "CLOSED", stateReason, labels: { nodes: [{ name: "type:pbi" }] } });
  const slots = (base: string, implement: number) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ backlogSweep: { implement, plan: 0 } }) });
  const implementing = (n: number) => core!.db.listTasks().filter((t) => t.title.startsWith(`#${n} 実装: `));

  test("A→B and independent C: B and C start, A is logged as waiting on B; once B is done the next firing starts A once", async () => {
    const pbis: Record<number, Pbi> = { 401: { priority: "P0", body: "**前提**: #402" }, 402: { priority: "P1" }, 403: { priority: "P2" } };
    const others: Record<string, unknown> = {};
    const base = await boot(prereqGh(pbis, others), holdingClaude().adapter);
    expect((await slots(base, 2)).status).toBe(200);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#402 実装", "#403 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #401（#402 未完）`));
    // B is closed as completed: the next import reads it again, and A goes
    delete pbis[402];
    others.w402 = closedIssue("COMPLETED");
    await slots(base, 3);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(implementing(401)).toHaveLength(1);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#401 を complete で開始"));
  });

  test("fires twice, restart: A is started once — not again while it runs, after it ended, or after the daemon restarted", async () => {
    const claude = holdingClaude();
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #402" } }, { w402: closedIssue("COMPLETED") });
    const base = await boot(gh, claude.adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    await runSchedule(base, id);
    expect(implementing(401)).toHaveLength(1);
    for (const t of core!.db.listTasksByStatus("running")) core!.db.updateTask(t.id, { status: "done" });
    await runSchedule(base, id);
    expect(implementing(401)).toHaveLength(1);
    // the same home again: what ran is read from the database
    for (const t of core!.db.listTasks()) core!.db.updateTask(t.id, { status: "running" });
    await core!.stop();
    const cfg = loadConfig({ SWITCHBOARD_HOME: home!, SWITCHBOARD_KNOWLEDGE: join(home!, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home!, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(gh), backlogAutoImport: true });
    const again = `http://127.0.0.1:${core.server.port}`;
    await refreshed(again, false);
    await runSchedule(again, id);
    expect(implementing(401)).toHaveLength(1);
  });

  test("button and firing: while the row's button starts A, a firing does not start it too", async () => {
    const base = await boot(prereqGh({ 401: { priority: "P0", body: "**前提**: #402" } }, { w402: closedIssue("COMPLETED") }), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    const [button] = await Promise.all([start(base, 401, { action: "complete" }), runSchedule(base, id)]);
    expect([201, 409]).toContain(button.status);
    expect(implementing(401)).toHaveLength(1);
  });

  test("release: a merged prerequisite not in the running release waits, starts once it is; without sb-rescue it cannot be told", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "running");
    const running = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "the prerequisite (#450)");
    const merged = git("rev-parse", "HEAD");
    let current = running;
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/status" ? Response.json({ current, previous: null, state: "running", busy: null, lastError: null, history: [] }) : new Response("no", { status: 404 })) });
    // #451's merge commit is not in this checkout: git cannot tell, which is not "not released"
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #450（リリース）" }, 402: { priority: "P1", body: "**前提**: #451（リリース）" } }, {
      w450: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: merged } },
      w451: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: "0".repeat(40) } },
    });
    try {
      const base = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
      const id = await backlogNextSchedule(base);
      await runSchedule(base, id);
      expect(implementing(401)).toHaveLength(0);
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #401（PR #450 リリース待ち）`));
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められない: #402（PR #451 の反映を確かめられない）`));
      expect((await refreshed(base, false)).items.find((i) => i.number === 401)!.prereqs).toEqual([{ number: 450, kind: "pr", need: "release", state: "pending", via: null }]);
      // what runs is not in this checkout: git cannot tell, which is not "not released"
      current = "f".repeat(40);
      await runSchedule(base, id);
      expect((await scheduleLogAll(base)).some((l) => l.includes("進められない: ") && l.includes("#401（PR #450 の反映を確かめられない）"))).toBe(true);
      current = merged;
      await runSchedule(base, id);
      expect(implementing(401)).toHaveLength(1);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
      // not under sb-rescue: nothing tells what runs
      const alone = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo });
      await runSchedule(alone, await backlogNextSchedule(alone));
      expect(implementing(401)).toHaveLength(0);
      expect((await scheduleLogAll(alone)).find((l) => l.includes("進められない:"))).toContain("#401（PR #450 の反映を確かめられない）");
    } finally {
      rescue.stop(true);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("withdrawn / missing / cycle: each is logged as 進められない, and the independent Ready starts", async () => {
    const pbis: Record<number, Pbi> = {
      401: { priority: "P0", body: "**前提**: #402" }, 404: { priority: "P0", body: "**前提**: #499" },
      405: { priority: "P0", body: "**前提**: #406" }, 406: { priority: "P0", body: "**前提**: #405" }, 403: { priority: "P3" },
    };
    const base = await boot(prereqGh(pbis, { w402: closedIssue("NOT_PLANNED") }), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#403 実装"]);
    const line = (await scheduleLogAll(base)).find((l) => l.includes("進められない:"))!;
    for (const part of ["#401（#402 取り下げ）", "#404（#499 見つからない）", "#405（#406 と循環）", "#406（#405 と循環）"]) expect(line).toContain(part);
  });

  test("with #930: a PBI waiting only on a Draft PR's overlap goes on, while one with a prerequisite not done does not", async () => {
    const pbis: Record<number, Pbi> = {
      407: { priority: "P1", comments: [[releaseBody("後回し", [460], true), STOPPED]] },
      408: { priority: "P0", body: "**前提**: #409" }, 409: { status: "Backlog", priority: "P3" },
    };
    const base = await boot(prereqGh(pbis, { w460: { __typename: "PullRequest", state: "OPEN", isDraft: true } }), holdingClaude().adapter);
    await slots(base, 1); // #409 is not Ready: the plan slot would take it
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#407 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #408（#409 未完）`));
  });
});

test("pickNext unchanged: an item whose last stage Task of the same stage finished with no update since is left; one updated since goes after the untried", () => {
  const last = (action: BacklogAction, at = "2026-09-28T00:00:00Z", status: TaskStatus = "done") => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action, outcome: "unknown" as const, reviewedAt: null, resumeAt: null });
  const updated = "2026-09-28T01:00:00Z"; // after the last Task finished
  const unchangedReady = item({ number: 1, stage: "ready", priority: "P0", lastTask: last("complete") });
  const freshReady = item({ number: 2, stage: "ready", priority: "P3" });
  // 1: unchanged (done, failed or aborted alike) is left; the untried one goes on; unchanged alone → null
  expect(pickNext([unchangedReady, freshReady], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  expect(pickNext([unchangedReady], "implement")).toBeNull();
  expect(pickNext([{ ...unchangedReady, lastTask: last("complete", undefined, "error") }], "implement")).toBeNull();
  expect(pickNext([{ ...unchangedReady, lastTask: last("complete", undefined, "aborted") }], "implement")).toBeNull();
  // the same for 分解待ち and 要望 in the plan slot
  const unchangedTasks = item({ number: 3, stage: "needs-tasks", priority: "P0", lastTask: last("to-tasks") });
  const unchangedRequest = item({ number: 4, stage: "request", type: "request", priority: "P0", lastTask: last("to-pbi") });
  const freshRequest = item({ number: 5, stage: "request", type: "request", priority: "P3" });
  expect(pickNext([unchangedTasks, unchangedRequest, freshRequest], "plan")).toMatchObject({ item: { number: 5 }, action: "to-pbi" });
  expect(pickNext([unchangedTasks, unchangedRequest], "plan")).toBeNull();
  expect(unchangedIn([unchangedReady, freshReady, unchangedTasks, unchangedRequest, freshRequest], "plan").map((i) => i.number)).toEqual([3, 4]);
  // an Issue updated at the very time its Task finished is not newer
  expect(pickNext([{ ...unchangedReady, updatedAt: "2026-09-28T00:00:00Z" }], "implement")).toBeNull();
  // 2: a last Task of another stage (split into Tasks, now Ready) is not worked on at this stage yet
  expect(pickNext([item({ number: 6, stage: "ready", lastTask: last("to-tasks") })], "implement")).toMatchObject({ item: { number: 6 } });
  // a running one is not finished: activeTaskId holds it, and it is not listed as unchanged
  expect(unchangedIn([{ ...unchangedReady, lastTask: last("complete", undefined, "running") }], "implement")).toEqual([]);
  // 3: updated since → picked, but after the untried of its slot even at a higher Priority; alone it goes on
  const updatedReady = { ...unchangedReady, updatedAt: updated };
  expect(pickNext([updatedReady, freshReady], "implement")).toMatchObject({ item: { number: 2 } });
  expect(pickNext([updatedReady], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  expect(pickNext([{ ...unchangedTasks, updatedAt: updated }, freshRequest], "plan")).toMatchObject({ item: { number: 5 } });
  // an answered in-progress PBI stays first
  const answered = item({ number: 7, stage: "in-progress", priority: "P3", answeredAt: updated, updatedAt: updated, lastTask: last("complete") });
  expect(pickNext([updatedReady, freshReady, answered], "implement")).toMatchObject({ item: { number: 7 }, action: "complete" });
});

test("pickNext failed: an item whose last stage Task failed with no update to the Issue since is left in any stage; an update, a reply's resume or a closed wait brings it back (#1275)", () => {
  const at = "2026-09-28T00:00:00Z";
  const failed = (status: TaskStatus = "error", resumeAt: number | null = null) => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "failed" as const, reviewedAt: null, resumeAt });
  // an in-progress PBI with Tasks left: resumed (#578) unless its last Task failed and the Issue was not updated since — the usage-limit case (resumeAt set) and an aborted one alike
  const stalled = item({ number: 1, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at });
  expect(pickNext([stalled], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed("error", Date.parse("2026-09-30T11:01:00Z")) }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, lastTask: failed("aborted") }], "implement")).toBeNull();
  // the Issue updated after it (a comment, a ## 回答) → resumed; an Issue updated at the very time is not newer
  expect(pickNext([{ ...stalled, lastTask: failed(), updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  // a closable one is held the same way; its waits closing still goes on (#817)
  const closable = item({ number: 2, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, updatedAt: at, lastTask: failed() });
  expect(pickNext([closable], "implement")).toBeNull();
  expect(pickNext([{ ...closable, waits: [wait(778, "pr", false)], waitsAt: at }], "implement")).toMatchObject({ item: { number: 2 } });
  // a Ready item too (as #624 already does), and the plan slot's stages
  expect(pickNext([item({ number: 3, stage: "ready", updatedAt: at, lastTask: failed() })], "implement")).toBeNull();
  expect(pickNext([item({ number: 4, stage: "needs-tasks", updatedAt: at, lastTask: { ...failed(), action: "to-tasks" } })], "plan")).toBeNull();
  // listed for the log by slot; a running one or one waiting for a PR is not
  const items = [{ ...stalled, lastTask: failed() }, closable, item({ number: 3, stage: "ready", updatedAt: at, lastTask: failed() }), item({ number: 4, stage: "needs-tasks", updatedAt: at, lastTask: { ...failed(), action: "to-tasks" as const } })];
  expect(failedIn(items, "implement").map((i) => i.number)).toEqual([1, 2, 3]);
  expect(failedIn(items, "plan").map((i) => i.number)).toEqual([4]);
  expect(failedIn([{ ...stalled, lastTask: failed(), activeTaskId: "tsk_run" }, { ...closable, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  expect(failedSince(stalled)).toBe(false);
  expect(failedSince({ ...stalled, lastTask: failed("done") })).toBe(false);
  // a ## 回答 on a child Task sets answeredAt without touching the parent's updatedAt: that counts as an update too
  expect(pickNext([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  expect(failedIn([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z" }], "implement")).toEqual([]);
});

test("pickNext awaiting reply: an item whose last stage Task ended asking the person (needs_action, not reviewed) is left until the Issue is updated or the Task reviewed (#1275)", () => {
  const at = "2026-09-28T00:00:00Z";
  const asked = (over: Partial<NonNullable<BacklogItem["lastTask"]>> = {}) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, ...over });
  const stalled = item({ number: 1, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at, lastTask: asked() });
  expect(pickNext([stalled], "implement")).toBeNull();
  // reviewed (the person read it) → resumed; an outcome set by hand to done → resumed; a Task that ended without asking → resumed
  expect(pickNext([{ ...stalled, lastTask: asked({ reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, updatedAt: "2026-09-28T00:30:00Z", lastTask: asked({ outcome: "done" }) }], "implement")).toMatchObject({ action: "complete", resume: true });
  // the Issue updated since (a ## 回答 on it or a Task, any comment) → resumed, an answered one first
  expect(pickNext([{ ...stalled, updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, answeredAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  // a Task still waiting (status waiting) is not finished: activeTaskId holds the item, not this rule
  expect(awaitingReply({ ...stalled, lastTask: asked({ status: "waiting" }) })).toBe(false);
  // a Ready item whose 実装 stopped asking, and the plan slot's stages
  const ready = item({ number: 2, stage: "ready", updatedAt: at, lastTask: asked() });
  expect(pickNext([ready], "implement")).toBeNull();
  expect(pickNext([{ ...ready, updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  const request = item({ number: 3, stage: "request", type: "request", updatedAt: at, lastTask: asked({ action: "to-pbi" }) });
  expect(pickNext([request], "plan")).toBeNull();
  // listed for the log by slot, apart from the failed ones (#624's unchanged still lists the Ready one; the firing filters it)
  expect(replyWaitingIn([stalled, ready, request], "implement").map((i) => i.number)).toEqual([1, 2]);
  expect(replyWaitingIn([stalled, ready, request], "plan").map((i) => i.number)).toEqual([3]);
  expect(failedIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement")).toEqual([]);
  expect(replyWaitingIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement").map((i) => i.number)).toEqual([1]);
  expect(replyWaitingIn([{ ...stalled, activeTaskId: "tsk_run" }, { ...ready, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  // a ## 回答 on a child Task (answeredAt newer, the parent's updatedAt not): answered, so resumed first — not listed as awaiting
  const childAnswered = { ...stalled, answeredAt: "2026-09-28T01:00:00Z" };
  expect(pickNext([childAnswered], "implement")).toMatchObject({ action: "complete" });
  expect(replyWaitingIn([childAnswered], "implement")).toEqual([]);
  // reviewed releases a Ready item and a closable one too, which #624 / #578 would otherwise hold until the Issue changes
  const reviewed = asked({ reviewedAt: Date.parse("2026-09-28T02:00:00Z") });
  expect(pickNext([{ ...ready, lastTask: reviewed }], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  expect(unchangedIn([{ ...ready, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([item({ number: 4, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, updatedAt: at, lastTask: { ...reviewed, action: "close" } })], "implement")).toMatchObject({ action: "close" });
  // a stalled PBI held by #578 (its last resume's tasks-done mark matches): reviewed releases it as well; a done resume reviewed does not
  const spun = { ...stalled, report: { body: `## 状況\n### 残り\n- #12\n${TASKS_DONE_MARK(1)}`, at: "2026-09-27T23:00:00Z" } };
  expect(pickNext([spun], "implement")).toBeNull();
  expect(pickNext([{ ...spun, lastTask: reviewed }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(spinningIn([{ ...spun, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([{ ...spun, lastTask: asked({ outcome: "done", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toBeNull();
  // one that ended done (nothing asked) and was marked reviewed is still #624's unchanged
  expect(pickNext([{ ...ready, lastTask: asked({ outcome: "done", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toBeNull();
});

test("backlog-next failed / awaiting reply: a firing leaves a PBI whose last Task failed on the usage limit or stopped asking, and the log names each with the resume time (#1275)", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  const now = Date.now();
  const resumeAt = now + 3_600_000;
  const row = { workspaceId: metaId(), runner: "claude" as const, cwd: home!, scope: [home!], runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto" as const, effort: null, origin: "switchboard" as const, shadowOf: null, shadowStopped: false, workspaceReason: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now };
  // #307 (closable, in progress): its 閉じる hit the weekly limit at once, auto-resume planned; #304 (Ready): its 実装 ended asking the person in its conversation
  core!.db.insertTask({ ...row, id: "tsk_limit307", title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", stage: { issue: 307, action: "close" }, status: "error", resumeAt, resumeReason: "limit", outcome: "failed", reviewedAt: null, archivedAt: null });
  core!.db.insertTask({ ...row, id: "tsk_ask304", title: "#304 実装: PBI: Ready の PBI", stage: { issue: 304, action: "complete" }, status: "done", resumeAt: null, resumeReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#307 閉じる"]); // only the two inserted ones
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 返事待ち: #304`));
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 前回の Task が失敗したまま更新が無い: #307（使用上限、${fmtTime(resumeAt, now)} に戻る）`));
  expect(log).not.toContainEqual(expect.stringContaining("前回から更新が無い: #304"));
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // reviewed (the person read the question): the 実装 is started again next firing, with no update to the Issue
  core!.db.updateTask("tsk_ask304", { reviewedAt: now + 1 });
  expect((await runSchedule(base, id)).status).toBe(201);
  const again = (await scheduleLogAll(base)).slice(log.length);
  expect(again).not.toContainEqual(expect.stringContaining("返事待ち"));
  expect(again).not.toContainEqual(expect.stringContaining("前回から更新が無い: #304"));
  expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
});

test("backlog-next unchanged: a Ready PBI whose 実装 finished with no update since is not started and the log names it; its button still starts it", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  // #304 (updated 2026-09-20) had an 実装 that finished after that
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#304 実装: PBI: Ready の PBI"), statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]); // only the old #304 実装
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 前回から更新が無い: #304 #307`)); // #307: closeTried's 閉じる (#578)
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // the row's button is not held by it
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
});

test("backlog-next overlap: a Ready PBI whose Task names a file an open PR changes is not started and the log names the PR; once it closes the next firing starts it; nothing is written to GitHub", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({}, {}, undefined);
  const withTask: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    const q = args.find((a) => a.startsWith("query="));
    if (!q?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [{ number: 3041, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: "触る場所: `src/a.ts`", comments: { nodes: [] } }] } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  const writes: string[][] = [];
  const calls: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args.find((a) => a.startsWith("query=")) ?? args.join(" "));
    if (args[0] === "issue" || args.includes("POST") || args.includes("PATCH")) writes.push(args);
    return withTask(args, cwd);
  };
  // #901's files are cut (120 of 100 read): it cannot be judged, and the log says so next to the PR that overlaps
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }, { number: 901, files: [], filesTotal: 120, headRefName: "sb/998-x" }];
  const base = await boot(gh, claude.adapter);
  expect((await waitsOfItem(base, 304)).overlap).toEqual({ hits: [{ ref: "PR #900", path: "src/a.ts" }], unknown: "PR #901 の変更ファイルが記録に無い" });
  const id = await backlogNextSchedule(base);
  const before = calls.length;
  expect((await runSchedule(base, id)).status).toBe(201);
  // deciding reads no PR / Issue list from GitHub
  expect(calls.slice(before).filter((q) => q.includes("pullRequests(") || q.includes("issues(first"))).toEqual([]);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なり: #304（PR #900: src/a.ts）`));
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なりを判定できない: #304（PR #901 の変更ファイルが記録に無い）`));
  expect(writes).toEqual([]);
  // the PR closes: the next import reads it and #304 is picked again (the implement slot is #307's 閉じる meanwhile)
  openPulls = [];
  await fetch(`${base}/api/backlog?refresh=1`);
  const ready = (await refreshed(base)).items.find((i) => i.number === 304)!;
  expect(ready.overlap).toBeNull();
  expect(pickNext([ready], "implement")).toMatchObject({ item: { number: 304 }, action: "complete" });
});

async function backlogNextSchedule(base: string, budgetUsd?: number, model?: string, effort?: string) {
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next", budgetUsd, model, effort }) });
  expect(r.status).toBe(201);
  return (await r.json() as { id: string }).id;
}
/**
 * A 閉じる of the fixtures' closable #307 that finished with no update since (#578), on each workspace: backlog-next leaves
 * it, so a test of the implement slot starts Ready #304 there.
 */
function closeTried(...workspaceIds: string[]) {
  const now = Date.now();
  for (const workspaceId of workspaceIds.length ? workspaceIds : [metaId()]) core!.db.insertTask({ id: `tsk_close307_${workspaceId}`, workspaceId, title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 閉じる: PBI: Task が全部閉じた実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
}
/** The Tasks but closeTried's. */
const startedTasks = () => core!.db.listTasks().filter((t) => !t.id.startsWith("tsk_close307_"));
const runSchedule = (base: string, id: string) => fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });
const scheduleLogAll = async (base: string) => await (await fetch(`${base}/api/schedules/log`)).json() as string[];
const scheduleLog = async (base: string) => (await scheduleLogAll(base)).at(-1) ?? "";

test("backlog-next: a firing starts the picked item's stage Task, and the scheduled complete uses the button prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  const r = await runSchedule(base, id);
  expect(r.status).toBe(201);
  const task = core!.db.listTasks().find((t) => t.title.startsWith("#304 実装: "))!;
  expect(task.scheduleId).toBe(id);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#304 を complete で開始"));
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("/pbi-complete 304"))!.prompt;
  expect(prompt).toBe(buildStartPrompt({ number: 304 }, "complete"));
});

test("backlog-next: a firing starts on the schedule's model, and not on autoStart's (schedule model)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto" } });
  const id = await backlogNextSchedule(base, undefined, "m-sched");
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(core!.db.listTasks().find((t) => t.scheduleId === id)).toMatchObject({ runner: "claude", model: "m-sched" });
  expect(claude.starts[0]!.model).toBe("m-sched");
});

test("backlog-next: a schedule without a model starts on the CLI default, not on autoStart's (schedule model)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto" } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.model).toBeUndefined();
});

test("backlog-next: a firing starts with the schedule's effort, not autoStart's (schedule effort, #833)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const id = await backlogNextSchedule(base, undefined, undefined, "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.map((s) => s.effort)).toEqual(claude.starts.map(() => "low"));
});

test("backlog-next: a schedule without an effort starts on the CLI default, not on autoStart's (schedule effort, #833)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.effort).toBeUndefined();
});

test("backlog-next by kind (#1337): a kind's own runner wins over the schedule's; a kind without one starts on the schedule's runner and model", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto", byKind: { complete: { runner: "codex", model: "m-impl" } } } });
  const id = await backlogNextSchedule(base, undefined, "m-sched", "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = core!.db.listTasks().filter((t) => t.scheduleId === id);
  expect(started.map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect(started.find((t) => t.title.startsWith("#304 実装"))).toMatchObject({ runner: "codex", model: "m-impl", effort: null });
  expect(started.find((t) => t.title.startsWith("#303 Task に分解"))).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
});

test("backlog-next: the prompt of a button start names the merge gate only as the request's scope (#1357)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await start(base, 304, { action: "complete" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ");
  expect(claude.starts[0]!.prompt).not.toContain("--allow-large");
});

test("backlog-next slots: a running plan Task (from a button too) holds that workspace's plan slot only; its implement slot still starts", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const manual = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 計画の枠が埋まっている: 工程 Task ${manual.id}`));
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next slots: a running implement Task leaves the plan slot open", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  const manual = await (await start(base, 304, { action: "complete" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠が埋まっている: 工程 Task ${manual.id}`));
});

test("backlog-next slots: Claude usage at 0.8 or more — one stage Task only while none runs anywhere; none while one runs", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  const later = Math.floor(Date.now() / 1000) + 3600; // resetsAt is in seconds, as Claude reports it
  core!.db.upsertQuota("claude", "seven_day", 0.5, later);
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(startedTasks()[0]!.title.startsWith("#304 実装: ")).toBe(true);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: claude の使用量 five_hour が 85%`));
  // the one it started runs: the next firing starts nothing, and says which window
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain("飛ばした (manual): claude の使用量 five_hour が 85%（80% 以上）: 工程 Task が動いているので始めない");
  expect(startedTasks()).toHaveLength(1);
});

/** Stops the daemon a test booted and removes its home, for a second boot in the same test. */
async function shutdown() {
  await core!.stop();
  rmSync(home!, { recursive: true, force: true });
  core = home = undefined;
}
/** backlog quota (#834): a backlog-next schedule on `runner`, with Claude and Codex both detected and holding. */
async function bootTwo(runner: "claude" | "codex") {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: metaId(), runner, prompt: "", action: "backlog-next" }) });
  expect(r.status).toBe(201);
  return { base, id: (await r.json() as { id: string }).id, claude: claude.starts, codex: codex.starts };
}

test("backlog quota (#834): a codex schedule is not held back by Claude's usage; Codex's own at 0.85 holds it to one", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("codex");
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  core!.db.upsertQuota("claude", "seven_day", 1, later); // even at its limit
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]); // both slots, as with no usage
  expect((await scheduleLogAll(a.base)).some((l) => l.includes("の使用量"))).toBe(false);
  await shutdown();
  const b = await bootTwo("codex");
  core!.db.upsertQuota("codex", "five_hour", 0.85, later);
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(b.base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: codex の使用量 five_hour が 85%`));
});

test("backlog quota (#834): a claude schedule at Claude's limit with the fallback codex starts on codex and is judged by Codex's usage", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("claude");
  core!.db.upsertQuota("claude", "five_hour", 0.95, later);
  core!.db.setSetting("settings", { autoStart: { fallback: ["codex"] } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]); // Codex has no usage: as the slots allow
  expect(a.claude).toHaveLength(0);
  expect(core!.db.listEvents(startedTasks()[0]!.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("claude が上限（0.95、"))).toBe(true);
  await shutdown();
  const b = await bootTwo("claude");
  core!.db.upsertQuota("claude", "seven_day", 1, later); // at its limit: no longer "start nothing" while codex can take it
  core!.db.upsertQuota("codex", "five_hour", 0.85, later);
  core!.db.setSetting("settings", { autoStart: { fallback: ["codex"] } });
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex"]);
  expect(await scheduleLogAll(b.base)).toContainEqual(expect.stringContaining("codex の使用量 five_hour が 85%（80% 以上）: 全体で 1 件まで"));
});

test("backlog quota (#834): a kind's own runner (#1337) is judged by its own usage — 実装 on claude at its limit is left while the plan slot starts on codex", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const now = Date.now();
  const a = await bootTwo("codex");
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  core!.db.setSetting("settings", { autoStart: { byKind: { complete: { runner: "claude", model: "", effort: "" } } } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => [t.title.split(":")[0], t.runner])).toEqual([["#303 Task に分解", "codex"]]);
  expect(a.claude).toHaveLength(0);
  expect(await scheduleLogAll(a.base)).toContainEqual(expect.stringContaining(`${metaName()}: #304 を始めない: claude の使用量 seven_day が 100%: ${fmtTime(later * 1000, now)} に戻るまで始めない`));
  await shutdown();
  // with the fallback codex, 実装 gives way to codex too and both slots start
  const b = await bootTwo("codex");
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  core!.db.setSetting("settings", { autoStart: { byKind: { complete: { runner: "claude", model: "", effort: "" } }, fallback: ["codex"] } });
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]);
});

test("backlog-next slots: settings tunables (#835) — backlogQuotaLimit 0.5 holds back at Claude usage 0.6, read at each firing", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  core!.db.upsertQuota("claude", "five_hour", 0.6, Math.floor(Date.now() / 1000) + 3600);
  core!.db.setSetting("settings", { quotaAndResume: { backlogQuotaLimit: 0.5 } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: claude の使用量 five_hour が 60%`));
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain("飛ばした (manual): claude の使用量 five_hour が 60%（50% 以上）: 工程 Task が動いているので始めない");
});

test("backlog-next slots: settings tunables (#835) — with the default threshold, Claude usage 0.6 starts per slot", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  core!.db.upsertQuota("claude", "five_hour", 0.6, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next slots: Claude usage at 0.8 or more — a stage Task that starts while GitHub is read counts; the firing starts nothing", async () => {
  const ok = fakeGh();
  let during: (() => void) | null = null;
  const gh: GhRunner = async (args, cwd) => {
    // a read of the backlog, not of GitHub's budget (#549), which comes before the quota check
    if (args[0] === "api" && !args.some((a) => a.includes("rateLimit")) && during) { during(); during = null; }
    return ok.gh(args, cwd);
  };
  const base = await boot(gh, holdingClaude().adapter);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  // #303's plan Task (a button's) is running by the time GitHub answers: after the firing's quota check, before its start
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  during = () => { core!.db.insertTask({ id: "task_button303", workspaceId: meta.id, title: "#303 Task に分解: x", runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#303 Task に分解: x"), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }); };
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: claude の使用量 five_hour が 85%`));
});

test("backlog-next slots: Claude usage at 0.8 or more — one start per firing, even when the one it started has already ended", async () => {
  // a runner whose turn is over right after it starts: the Task started first is no longer running when the next is picked
  const quick: RunnerAdapter = { ...holdingClaude().adapter, start(opts, emit) {
    queueMicrotask(() => { for (const t of core!.db.listTasksByStatus("running")) core!.db.updateTask(t.id, { status: "done" }); });
    return holdingClaude().adapter.start(opts, emit);
  } };
  const base = await boot(fakeGh().gh, quick);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("backlog-next slots: a button still creating its stage Task holds that slot; the other slot starts", async () => {
  const slow: Suggester = { suggest: async () => (await Bun.sleep(50), { runner: "claude", reason: "slow", ruleId: "llm", available: true, alternatives: [], llm: null }) };
  const base = await boot(fakeGh().gh, holdingClaude().adapter, {}, () => slow);
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  const id = await backlogNextSchedule(base);
  const button = start(base, 304, { action: "complete" });
  await Bun.sleep(20); // the button's routing turn is still thinking: no Task row yet
  expect(core!.db.listTasks()).toHaveLength(0);
  // the button holds the implement slot; the plan slot still starts #303
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠が埋まっている: #304 の工程 Task を開始しているところ`));
  expect((await button).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next slots: Claude usage at 100% — the firing starts nothing and names the window and when it is back; a reset row does not count (#1275)", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  const now = Date.now();
  const later = Math.floor(now / 1000) + 3600;
  core!.db.upsertQuota("claude", "five_hour", 0.2, later);
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(base)).toContain(`飛ばした (manual): claude の使用量 seven_day が 100%: ${fmtTime(later * 1000, now)} に戻るまで始めない`);
  // the window reset: the 0.8 rule applies again (one start while none runs)
  core!.db.upsertQuota("claude", "seven_day", 1, Math.floor(now / 1000) - 60);
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("claude の使用量 five_hour が 85%（80% 以上）: 全体で 1 件まで"));
});

test("backlog-next: a high usage row whose window has already reset does not hold the sweep", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) - 60);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(2);
});

test("backlog-next picks a local Ready PBI with gh throwing (#2265)", async () => {
  const throwing: GhRunner = async () => { throw new Error("spawn gh ENOENT"); };
  const claude = holdingClaude();
  const base = await boot(throwing, claude.adapter);
  const dir = mkdtempSync(join(home!, "local-"));
  copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(dir, "ops.config.json"));
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "local", backlog: "switchboard" }) })).json()) as { id: string };
  const made = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "PBI: ローカル", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1" } }) });
  expect(made.status).toBe(202);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const t = startedTasks().find((x) => x.workspaceId === ws.id);
  expect(t?.stage).toEqual({ issue: 1, action: "complete" });
  for (let i = 0; !claude.starts.length && i < 200; i++) await Bun.sleep(10);
  expect(claude.starts.map((s) => s.prompt).join("\n")).toContain("PBI #1 を完了させてください");
  expect((await scheduleLogAll(base)).filter((l) => l.includes("local: GitHub"))).toEqual([]);
});

describe("GitHub budget", () => {
  test("GitHub budget: backlog-next starts on the stored data at 500 points left with the import refused for the limit, and logs no budget line (#2264)", async () => {
    const low = budgetGh(500);
    const limited = { on: false };
    const gh: GhRunner = async (args, cwd) =>
      limited.on && args[0] === "api" && !args.some((a) => a.includes("rateLimit"))
        ? { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${Math.floor(Date.now() / 1000) + 1800}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" }
        : low.gh(args, cwd);
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    limited.on = true;
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
    const log = await scheduleLog(base);
    expect(log).not.toContain("GitHub の API 残量");
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("GitHub と照合できない（保存データで進める）"));
  });

  test("GitHub budget: a stage button starts its Task below 1,000 points left — the budget holds no start (#2264)", async () => {
    const base = await boot(budgetGh(500).gh, holdingClaude().adapter);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  });

  test("GitHub budget: read once a minute at most — a second read within 60 s does not call gh, a failed one neither; after 60 s it does", async () => {
    let now = 1_000_000;
    let calls = 0;
    let fail = false;
    const gh: GhRunner = async () => {
      calls++;
      return fail ? { code: 1, stdout: "", stderr: "HTTP 502" } : { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4321, resetAt: "2026-10-01T10:00:00Z" } } }), stderr: "" };
    };
    const cache = new GithubBudgetCache(gh, 60_000, () => now);
    const [a, b] = await Promise.all([cache.get("/x"), cache.get("/x")]);
    expect(a).toEqual({ remaining: 4321, limit: 5000, resetsAt: Date.parse("2026-10-01T10:00:00Z") / 1000 });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
    now += 59_000;
    await cache.get("/x");
    expect(calls).toBe(1);
    now += 2_000;
    fail = true;
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(2);
    now += 59_000;
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(2);
    now += 2_000;
    await cache.get("/x");
    expect(calls).toBe(3);
  });

  test("GitHub budget: at 0 left GitHub refuses the read itself — that refusal is 0 left until its reset; the budget does not hold a stage button (the import before it is #909's, and passes here)", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const fake = fakeGh();
    const gh: GhRunner = async (args, cwd) => {
      if (args.some((a) => a.includes("rateLimit"))) return { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" };
      return fake.gh(args, cwd);
    };
    const base = await boot(gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
  });

  test("GitHub budget: a limited read GitHub answers with 200 and no rateLimit in the body is read from the answer's headers (#550)", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const fake = fakeGh();
    const gh: GhRunner = async (args, cwd) => {
      if (args.some((a) => a.includes("rateLimit"))) return { code: 0, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "" };
      return fake.gh(args, cwd);
    };
    const base = await boot(gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
  });

  test("GitHub budget: while the host is waited for nothing is asked — a primary limit is 0 left until its end, another wait is not known", async () => {
    let calls = 0;
    let wait: { until: number; reason: "primary" | "secondary" | null } | null = { until: Date.parse("2026-10-01T10:15:00Z"), reason: "primary" };
    const cache = new GithubBudgetCache(async () => (calls++, { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 15000, remaining: 4000, resetAt: "2026-10-01T11:00:00Z" } } }), stderr: "" }), 60_000, () => Date.now(), 10_000, () => wait);
    expect(await cache.get("/x")).toEqual({ remaining: 0, limit: 5000, resetsAt: Date.parse("2026-10-01T10:15:00Z") / 1000 });
    wait = { until: Date.now() + 60_000, reason: "secondary" };
    expect(await cache.get("/x")).toBeNull();
    wait = { until: Date.now() + 60_000, reason: null };
    expect(await cache.get("/x")).toBeNull();
    expect(calls).toBe(0);
    wait = null;
    expect((await cache.get("/x"))?.remaining).toBe(4000);
    expect(calls).toBe(1);
    // the limit GitHub said is kept for the next wait
    wait = { until: Date.parse("2026-10-01T10:15:00Z"), reason: "primary" };
    expect((await cache.get("/x"))?.limit).toBe(15000);
  });

  test("GitHub budget: after a restart the wait a repository stored is kept too — nothing is asked, and the budget is not known (its kind was not stored)", async () => {
    const fake = budgetGh(4000);
    const asked: string[][] = [];
    const base = await boot(async (args, cwd) => (asked.push(args), fake.gh(args, cwd)), holdingClaude().adapter);
    core!.db.setBacklogRetryAt(core!.db.getWorkspaceBacklogSource(metaId())!, Date.now() + 10 * 60_000);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toBeNull();
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
    // a start goes on the stored data during the wait (#2264), without asking GitHub
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
  });

  test("GitHub budget: the limit a refusal names is kept for the next budget made in a wait", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    let wait: { until: number; reason: "primary" } | null = null;
    const cache = new GithubBudgetCache(async () => ({ code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 15000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n{}`, stderr: "gh: API rate limit exceeded" }), 60_000, () => Date.now(), 10_000, () => wait);
    expect((await cache.get("/x"))?.limit).toBe(15000);
    wait = { until: reset * 1000, reason: "primary" };
    expect((await cache.get("/x"))?.limit).toBe(15000);
  });

  test("GitHub budget: the daemon's read keeps the import's wait — after an import GitHub refused for its limit, the budget is 0 left and rateLimit is not asked", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const asked: string[][] = [];
    const limited: GhRunner = async (args) => {
      asked.push(args);
      return { code: 1, stdout: `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${reset}\n\n${JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })}`, stderr: "gh: API rate limit exceeded" };
    };
    const base = await boot(limited, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toEqual({ remaining: 0, limit: 5000, resetsAt: reset });
    expect(asked.filter((a) => a.some((x) => x.includes("rateLimit")))).toHaveLength(0);
  });

  test("GitHub budget: a failure that is not the limit, or a gh that does not answer in time, is not known and holds nothing", async () => {
    const auth = new GithubBudgetCache(async () => ({ code: 1, stdout: "", stderr: "gh auth login" }));
    expect(await auth.get("/x")).toBeNull();
    let now = 0;
    let calls = 0;
    const hung = new GithubBudgetCache(() => (calls++, new Promise(() => {})), 60_000, () => now, 20);
    expect(await hung.get("/x")).toBeNull();
    // a minute later the stuck gh is still waited on: no second process
    now += 61_000;
    expect(await hung.get("/x")).toBeNull();
    expect(calls).toBe(1);
  });

  test("GitHub budget: GET /api/ledger/summary carries it; a gh that does not answer rateLimit gives null and backlog-next starts as before", async () => {
    const low = budgetGh(500);
    let base = await boot(low.gh, holdingClaude().adapter);
    const s = (await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown };
    expect(s.github).toEqual({ remaining: 500, limit: 5000, resetsAt: Date.parse(low.resetAt) / 1000 });
    await core!.stop();
    rmSync(home!, { recursive: true, force: true });
    base = await boot(fakeGh().gh, holdingClaude().adapter);
    expect(((await (await fetch(`${base}/api/ledger/summary`)).json()) as { github: unknown }).github).toBeNull();
    closeTried();
    expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  });
});

test("backlog-next: the unattended stage Task gets no shadow and carries the schedule's budget", async () => {
  const dakStarts: StartOptions[] = [];
  const dak: RunnerAdapter = { id: "dak", detect: async () => ({ available: true }), start(opts) { dakStarts.push(opts); return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }; } };
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [holdingClaude().adapter, dak], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(fakeGh().gh) });
  const base = `http://127.0.0.1:${core.server.port}`;
  // a default shadow is saved: the button path would mirror to it, the unattended sweep must not
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ shadowRunner: "dak" }) })).status).toBe(200);
  const id = await backlogNextSchedule(base, 5);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(2);
  for (const t of core!.db.listTasks()) expect(t).toMatchObject({ budgetUsd: 5, shadowOf: null });
});

/** A fake gh for the meta workspace and two more (lib, app), each its own repository; `broken` answers 404 for every call. */
async function threeWorkspaces(adapter: RunnerAdapter, broken?: "lib") {
  const ok = fakeGh();
  const dirs: Record<string, string> = {};
  const gh: GhRunner = async (args, cwd) => {
    const name = Object.keys(dirs).find((k) => dirs[k] === cwd);
    if (name && name === broken) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (name && args[0] === "repo") return { code: 0, stdout: `acme/${name}\n`, stderr: "" };
    return ok.gh(args, cwd);
  };
  const base = await boot(gh, adapter);
  const ids: Record<string, string> = { switchboard: core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id };
  for (const name of ["lib", "app"]) {
    dirs[name] = mkdtempSync(join(home!, `${name}-`));
    ids[name] = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dirs[name], name }) })).json()) as { id: string }).id;
  }
  return { base, ids, dirs };
}

test("backlog-next slots: one firing starts an implement and a plan stage Task on every workspace; a second firing starts nothing more", async () => {
  const claude = holdingClaude();
  const { base, ids, dirs } = await threeWorkspaces(claude.adapter);
  closeTried(...Object.values(ids));
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = startedTasks();
  expect(tasks).toHaveLength(6);
  for (const ws of Object.values(ids)) expect(tasks.filter((t) => t.workspaceId === ws).map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  const log = await scheduleLogAll(base);
  for (const name of [meta.name, "lib", "app"]) {
    expect(log).toContainEqual(expect.stringContaining(`${name} #304 を complete で開始`));
    expect(log).toContainEqual(expect.stringContaining(`${name} #303 を to-tasks で開始`));
  }
  // another repository's Task runs there, and its unattended merge goes through merge-gate for that repository
  for (let i = 0; claude.starts.length < 6 && i < 100; i++) await Bun.sleep(10);
  const lib = claude.starts.find((x) => x.cwd === dirs.lib && x.prompt.includes("PBI #304"))!;
  expect(lib.prompt).toContain("`--repo <このリポジトリの owner/name>`");
  expect(lib.prompt).toContain(`${meta.path}/docs/design/merge-gate.md`);
  expect(lib.prompt).not.toContain("定期実行が始めた無人の実装");
  // every slot is taken: the same firing again starts nothing and says why per workspace
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(6);
  const again = (await scheduleLogAll(base)).slice(log.length);
  expect(again.filter((l) => l.includes("の枠が埋まっている"))).toHaveLength(6);
});

test("backlog-next slots: the setting backlogSweep applies from the next firing — implement 2 starts two implementations on one workspace, plan 0 none", async () => {
  // a second Ready PBI (#309, a copy of #304) on the first page
  const page = structuredClone(pages[0]) as { data: { repository: { issues: { nodes: RawBacklogIssue[] } } } };
  const nodes = page.data.repository.issues.nodes;
  nodes.push({ ...structuredClone(nodes.find((n) => n.number === 304)!), number: 309, title: "もう 1 件の Ready" });
  const ok = fakeGh();
  // its comments too: a Ready PBI's are read for its waits (#817)
  const comments = structuredClone(decisions) as { data: { repository: Record<string, unknown> } };
  comments.data.repository.i309 = { comments: { nodes: [] } };
  const gh: GhRunner = async (args, cwd) =>
    args.some((a) => a.includes("comments(last:")) ? { code: 0, stdout: JSON.stringify(comments), stderr: "" }
    : args[0] === "api" && !args.includes("after=CURSOR1") ? { code: 0, stdout: JSON.stringify(page), stderr: "" } : ok.gh(args, cwd);
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  const settings = (body: unknown) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ backlogSweep: body }) });
  const id = await backlogNextSchedule(base);
  // plan 0 with no plan Task running: #303 waits to be split, yet no plan Task starts, and the log says nothing of that slot
  expect((await settings({ implement: 1, plan: 0 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toEqual(["#304 実装"]);
  expect((await scheduleLogAll(base)).some((l) => l.includes("計画の枠"))).toBe(false);
  // implement 2 from the next firing: the second Ready PBI starts on the same workspace
  expect((await settings({ implement: 2 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain(`${metaName()}: 実装の枠が埋まっている`);
  // back to plan 1: the next firing starts #303
  expect((await settings({ plan: 1 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#309 実装"]);
});

/** The fixtures' gh with more Ready PBIs on the first page: copies of #304 numbered `numbers`, with no comments. */
function moreReadyGh(...numbers: number[]): GhRunner {
  const page = structuredClone(pages[0]) as { data: { repository: { issues: { nodes: RawBacklogIssue[] } } } };
  const nodes = page.data.repository.issues.nodes;
  const comments = structuredClone(decisions) as { data: { repository: Record<string, unknown> } };
  for (const n of numbers) {
    nodes.push({ ...structuredClone(nodes.find((x) => x.number === 304)!), number: n, title: `Ready の写し ${n}` });
    comments.data.repository[`i${n}`] = { comments: { nodes: [] } };
  }
  const ok = fakeGh();
  return async (args, cwd) =>
    args.some((a) => a.includes("comments(last:")) ? { code: 0, stdout: JSON.stringify(comments), stderr: "" }
    : args[0] === "api" && !args.includes("after=CURSOR1") ? { code: 0, stdout: JSON.stringify(page), stderr: "" } : ok.gh(args, cwd);
}
const runningStage = (title: string) => {
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  core!.db.insertTask({ id: `task_${title.split(" ")[0]!.slice(1)}`, workspaceId: meta.id, title, runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
};

test("start race: a button start in progress and a backlog-next firing on the same item make one Task (#936)", async () => {
  const slow: Suggester = { suggest: async () => (await Bun.sleep(50), { runner: "claude", reason: "slow", ruleId: "llm", available: true, alternatives: [], llm: null }) };
  const base = await boot(fakeGh().gh, holdingClaude().adapter, {}, () => slow);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } }, backlogSweep: { implement: 2, plan: 1 } }) });
  const id = await backlogNextSchedule(base);
  const button = start(base, 304, { action: "complete" });
  await Bun.sleep(20); // the button's routing turn is still thinking: no Task row yet
  // implement 2: the slot has room, the firing picks #304 too — and leaves it to the button
  expect((await runSchedule(base, id)).status).toBe(201);
  expect((await button).status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 ")).length).toBe(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: #304 は工程 Task が開始中`));
});

test("start race: a firing skips an item whose stage Task started after GitHub was read, and starts the next one (#936)", async () => {
  let first = true;
  // while the firing starts #304, a stage Task of #309 starts elsewhere (a button, an answer's resume): GitHub was read before it
  const routing: Suggester = { suggest: async () => {
    if (first) { first = false; runningStage("#309 実装: Ready の写し 309"); }
    return { runner: "claude", reason: "r", ruleId: "llm", available: true, alternatives: [], llm: null };
  } };
  const base = await boot(moreReadyGh(309, 310), holdingClaude().adapter, {}, () => routing);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } }, backlogSweep: { implement: 3, plan: 0 } }) });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装", "#310 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: #309 は工程 Task が動いている`));
});

test("backlog-next slots: a workspace whose GitHub cannot be read goes on with what is stored (nothing, never imported); the others start (#2264)", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, "lib");
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = core!.db.listTasks();
  expect(tasks).toHaveLength(4);
  expect(tasks.filter((t) => t.workspaceId === ids.lib)).toHaveLength(0);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("飛ばした (manual): lib: GitHub と照合できない（保存データで進める）: gh repo view: HTTP 404"));
});

test("start: complete delegates merge procedure to the skill", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  for (const opts of [{}, { other }]) {
    const p = buildStartPrompt({ number: 7 }, "complete", opts);
    for (const text of ["定期実行が始めた無人の実装", "exit 0 ならマージ", "自動マージ: PR #n"]) expect(p).not.toContain(text);
  }
});

test("start: another repository gets its recheck location and merge-gate repository from either start path", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  for (const p of [otherRepoRules(other), buildStartPrompt({ number: 7 }, "complete", { other })]) {
    expect(p).toContain("`scripts/merge-gate.ts`");
    expect(p).toContain("`--repo <このリポジトリの owner/name>`");
    expect(p).toContain("`/work/switchboard/docs/design/merge-gate.md` の「再チェック」");
    expect(p).toContain("その中の `-R <owner/name>` と `origin` はこのリポジトリ。印は必ずこのリポジトリの PR に付ける");
  }
});

test("start: stage endings read answers once and delegate decision procedure to the skills", () => {
  for (const action of ["to-pbi", "to-tasks", "complete", "close"] as const) {
    const p = buildStartPrompt({ number: 7 }, action);
    expect(p).toContain("始める前に Issue #7 の最新の `## 回答`");
    expect(p).toContain("`ops-kit backlog view 7 --fresh`"); // the latest answer from the app, imported first (#919)
    expect(p.match(/続きから進めてください/g)).toHaveLength(1);
    expect(p).not.toContain("`## 判断待ち` を出して止め");
    expect(p).not.toContain("Task に付いた `## 回答` も読み");
    expect(p.match(/sub-issue の Task のものも/g)?.length ?? 0).toBe(action === "complete" ? 1 : 0);
  }
});

test("start: check reads answers only as status material without resuming", () => {
  const p = buildStartPrompt({ number: 7 }, "check");
  expect(p).not.toContain("続きから進めて");
  expect(p).toContain("その続きの作業はしないでください");
  expect(p).toEndWith("対象: #7。");
});

const released = (over: Partial<ReleaseState> = {}): ReleaseState => ({ managed: true, current: "aaa", history: [], ...over });
const v2 = { tag: "v0.2.0", sha: "bbb" };

test("promote: promotionStep — only under sb-rescue, only a newer tag, never while tasks run, never a tag that failed", () => {
  expect(promotionStep({ status: released({ managed: false }), latest: v2, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: null, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released({ current: "bbb" }), latest: v2, busyTasks: 0 })).toEqual({ action: "pick" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0 })).toEqual({ action: "promote", tag: "v0.2.0", sha: "bbb" });
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 2 })).toEqual({ action: "wait", reason: "2 件の Task が動いているので v0.2.0 の昇格を待つ" });
  for (const h of [
    { action: "rejected", from: "aaa", to: "bbb", ok: false, reason: "the candidate did not answer" },
    { action: "auto-rollback", from: "bbb", to: "aaa", ok: false, reason: "went back by itself: health" },
  ]) {
    expect(promotionStep({ status: released({ history: [h] }), latest: v2, busyTasks: 0 })).toEqual({ action: "wait", reason: "昇格に失敗した版のまま: v0.2.0", failed: { tag: "v0.2.0", sha: "bbb", reason: h.reason } });
  }
  // a rollback chosen by hand, or a promote refused before it started, is not a failure of the version
  for (const h of [
    { action: "rollback", from: "bbb", to: "aaa", ok: true, reason: "chosen on the rescue page" },
    { action: "promote", from: "aaa", to: "bbb", ok: false, reason: "no earlier release" },
  ]) {
    expect(promotionStep({ status: released({ history: [h] }), latest: v2, busyTasks: 0 }).action).toBe("promote");
  }
  // what runs already contains the tag's commit (a newer commit promoted by hand): never go back to the tag
  expect(promotionStep({ status: released(), latest: v2, busyTasks: 0, latestInCurrent: true })).toEqual({ action: "pick" });
  // a failure of another commit does not hold this one
  expect(promotionStep({ status: released({ history: [{ action: "rejected", from: "aaa", to: "ccc", ok: false, reason: "x" }] }), latest: v2, busyTasks: 0 }).action).toBe("promote");
});

/** A fake gh for the failure report: #501 is a PR closing Task #500 whose parent is PBI #499. */
function reportGh(existing: string[] = []) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "repo") return { code: 0, stdout: "acme/app\n", stderr: "" };
    const path = args[1] ?? "";
    if (path === "repos/acme/app/issues/501") return { code: 0, stdout: JSON.stringify({ body: "## 概要\nCloses #500。", labels: [], pull_request: {} }), stderr: "" };
    if (path === "repos/acme/app/issues/500") return { code: 0, stdout: JSON.stringify({ body: "## 親 PBI\n#499\n\n## やること", labels: [{ name: "type:task" }] }), stderr: "" };
    if (path === "repos/acme/app/issues/499/comments") return { code: 0, stdout: existing.join("\n"), stderr: "" };
    if (args[0] === "issue") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  return { gh, calls };
}
const failure = { tag: "v0.2.0", sha: "bbbbbbbbbb", subject: "feat(core): x (#501)", reason: "went back by itself: health", rescueUrl: "https://d1.example.net/rescue/" };

test("promote: a failed version is reported once on the PBI behind its PR, as ## 判断待ち with the reason and the rescue page", async () => {
  const f = reportGh();
  expect(await reportPromoteFailure(f.gh, "/repo", failure)).toBe(499);
  const comment = f.calls.find((a) => a[0] === "issue" && a[1] === "comment")!;
  expect(comment.slice(0, 5)).toEqual(["issue", "comment", "499", "-R", "acme/app"]);
  const body = comment[6]!;
  expect(body.startsWith("## 判断待ち\n**問い**: 動いているアプリに入らなかった版 v0.2.0（bbbbbbb feat(core): x (#501)）")).toBe(true);
  expect(body).toContain("went back by itself: health");
  expect(body).toContain("救援画面: https://d1.example.net/rescue/");
  expect(f.calls.find((a) => a[0] === "issue" && a[1] === "edit")).toEqual(["issue", "edit", "499", "-R", "acme/app", "--add-label", "needs-decision"]);
  const again = reportGh([body]);
  expect(await reportPromoteFailure(again.gh, "/repo", failure)).toBe(499);
  expect(again.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("promote: a subject without (#n) reports nothing", async () => {
  const f = reportGh();
  expect(await reportPromoteFailure(f.gh, "/repo", { ...failure, subject: "fix: no number" })).toBeNull();
  expect(f.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

/** A checkout with one commit tagged v0.2.0, and a fake sb-rescue whose current release is another commit. */
async function releasedDaemon(history: ReleaseState["history"] = [], runningNewer = false) {
  const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
  git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "feat(core): x (#501)"); git("tag", "v0.2.0");
  const sha = git("rev-parse", "HEAD");
  // runningNewer: what sb-rescue runs is a later, untagged commit on top of the tag (promoted by hand)
  if (runningNewer) git("commit", "-q", "--allow-empty", "-m", "fix: later");
  const current = runningNewer ? git("rev-parse", "HEAD") : "old";
  const promoted: string[] = [];
  const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status") return Response.json({ current, previous: null, state: "running", busy: null, lastError: null, history: history.map((h) => ({ ...h, to: h.to === "SHA" ? sha : h.to, from: h.from === "SHA" ? sha : h.from })) });
    if (url.pathname === "/api/promote") { promoted.push(((await req.json()) as { commit: string }).commit); return Response.json({ started: "promote" }, { status: 202 }); }
    return new Response("no", { status: 404 });
  } });
  return { repo, sha, promoted, rescue, env: { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` } };
}

test("promote: under sb-rescue a newer tag is promoted first, and that firing starts nothing", async () => {
  const r = await releasedDaemon();
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(409);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLog(base)).toContain("飛ばした (manual): v0.2.0 の昇格を依頼");
    expect(core!.db.listTasks()).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: a release newer than the tag, promoted by hand, is not taken back to the tag", async () => {
  const r = await releasedDaemon([], true);
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(r.promoted).toEqual([]);
    expect(core!.db.listTasks()).toHaveLength(2);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: while the newest tag is one that failed, nothing is promoted or started, and its PBI gets one ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const f = reportGh();
  const gh: GhRunner = (args, cwd) => (args[0] === "api" && args[1]?.startsWith("repos/") ? f.gh(args, cwd) : args[0] === "issue" ? f.gh(args, cwd) : fakeGh().gh(args, cwd));
  try {
    // the PBI is read on a phone: the rescue page it names is the host's outside URL, not sb-rescue's own address (#399)
    const base = await boot(gh, holdingClaude().adapter, { ...r.env, SWITCHBOARD_WEB_URL: "https://d1.example.net" });
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(409);
    expect(await scheduleLog(base)).toContain("昇格に失敗した版のまま: v0.2.0（判断待ち: #499）");
    expect(r.promoted).toEqual([]);
    expect(core!.db.listTasks()).toHaveLength(0);
    expect(f.calls.filter((a) => a[0] === "issue" && a[1] === "comment")).toHaveLength(1);
    expect(f.calls.find((a) => a[0] === "issue" && a[1] === "comment")![6]).toContain("救援画面: https://d1.example.net/rescue/");
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

/** A claude adapter whose turns stay running until the test ends them (`end(i)` = the i-th started Task's turn ends ok). */
function endableClaude() {
  const emits: Array<(ev: AgentEvent) => void> = [];
  const adapter: RunnerAdapter = {
    id: "claude", detect: async () => ({ available: true }),
    start(_opts, emit) {
      emits.push(emit);
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  };
  const started = async (n: number) => { for (const t0 = Date.now(); emits.length < n && Date.now() - t0 < 20_000; ) await Bun.sleep(10); expect(emits).toHaveLength(n); };
  return { adapter, started, end: (i: number) => emits[i]!({ t: "session.end", status: "ok" }) };
}
const releaseHold = async (base: string) => ((await (await fetch(`${base}/api/daemon/release`)).json()) as { hold: unknown }).hold;
const settle = async (until: () => boolean) => { for (const t0 = Date.now(); !until() && Date.now() - t0 < 20_000; ) await Bun.sleep(10); };

test("promote: when idle — a promotion held by a running Task is asked for as soon as that Task's turn ends", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(409);
    expect(r.promoted).toEqual([]);
    expect(await scheduleLog(base)).toContain("1 件の Task が動いているので v0.2.0 の昇格を待つ");
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    claude.end(0);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLog(base)).toContain("バックログを進める: Task が空いたので v0.2.0 の昇格を依頼");
    expect(await releaseHold(base)).toBeNull();
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000); // a git promotion and HTTP turns under a loaded full suite: over the 5 s default (docs/design/perf.md "テストの揺れ")

test("promote: when idle — not while another Task still runs, and asked for once only", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
    await claude.started(2);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(409);
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    claude.end(1);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    // another Task that starts and ends after the request does not ask again
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(3);
    claude.end(2);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — a Task that ends while a firing runs git is not lost, and the tag is asked for once", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  // the firing's `git fetch --tags origin` hangs in this "ssh" (it marks `entered`) until the gate file exists, then
  // fails (a fetch that fails is ignored)
  const gate = join(r.repo, "gate");
  const entered = join(r.repo, "entered");
  Bun.spawnSync(["git", "-C", r.repo, "remote", "add", "origin", "ssh://gate.invalid/repo"]);
  process.env.GIT_SSH_COMMAND = `sh -c 'touch "${entered}"; until [ -e "${gate}" ]; do sleep 0.02; done; exit 1' ssh`;
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    const firing = runSchedule(base, id);
    await settle(() => existsSync(entered)); // the firing has read sb-rescue and waits on git
    expect(existsSync(entered)).toBe(true);
    claude.end(0);
    await Bun.sleep(50);
    await Bun.write(gate, "");
    expect((await firing).status).toBe(409);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    expect(await releaseHold(base)).toBeNull();
  } finally {
    delete process.env.GIT_SSH_COMMAND;
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — a tag that failed is not asked for when the Tasks end", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(409);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true, busyTasks: 1 });
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true, busyTasks: 0 });
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: when idle — outside sb-rescue a Task's turn ending asks for nothing", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, { SWITCHBOARD_REPO_ROOT: r.repo });
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    claude.end(0);
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    expect(await scheduleLogAll(base)).not.toContainEqual(expect.stringContaining("Task が空いたので"));
    expect(await releaseHold(base)).toBeUndefined();
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

const raw = (labels: string[], body: string, status?: string): RawBacklogIssue => ({
  number: 1, title: "t", url: "u", createdAt: "c", updatedAt: "u", body, labels: { nodes: labels.map((name) => ({ name })) }, subIssuesSummary: { total: 0, completed: 0, doneAt: null },
  projectItems: { nodes: status ? [{ project: { number: 11 }, fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] } }] : [] },
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

test("a workspace names the repository variable its Project URL is under (PATCH /api/workspaces/:id); unset = SWITCHBOARD_PROJECT_URL (kind project-var, #2362)", async () => {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "variable" && args[2] !== "CAPSULE_PROJECT_URL") return { code: 1, stdout: "", stderr: `variable ${args[2]} was not found` };
    return fake.gh(args, cwd);
  };
  const base = await boot(gh);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const before = await fetch(`${base}/api/backlog`).then((r) => r.json()) as Backlog;
  expect(before.items).toEqual([]);
  expect(before.errors[0]?.message).toContain("SWITCHBOARD_PROJECT_URL was not found");
  expect(before.errors[0]?.kind).toBe("project-var");

  const patch = (body: unknown) => fetch(`${base}/api/workspaces/${meta.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch({ projectVar: "not a name" })).status).toBe(400);
  expect((await patch({ projectVar: 7 })).status).toBe(400);
  expect((await fetch(`${base}/api/workspaces/ws_nope`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  const saved = await patch({ projectVar: " CAPSULE_PROJECT_URL " });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { projectVar?: string }).projectVar).toBe("CAPSULE_PROJECT_URL");
  expect(core!.db.getWorkspace(meta.id)?.projectVar).toBe("CAPSULE_PROJECT_URL");

  // the environment's SWITCHBOARD_PROJECT_URL applies to every workspace; a workspace that names its variable keeps it
  process.env.SWITCHBOARD_PROJECT_URL = "https://github.com/users/acme/projects/99";
  const after = await fetch(`${base}/api/backlog`).then((r) => r.json()) as Backlog;
  expect(after.errors).toEqual([]);
  expect(after.items.map((i) => i.number)).toContain(305); // Project 11's fields, from CAPSULE_PROJECT_URL
  expect(after.items.find((i) => i.number === 305)).toMatchObject({ priority: "P0" });
  expect(fake.calls.filter((a) => a[0] === "variable").map((a) => a[2])).toEqual(["CAPSULE_PROJECT_URL"]);

  // null or empty goes back to SWITCHBOARD_PROJECT_URL
  expect(((await (await patch({ projectVar: null })).json()) as { projectVar?: string }).projectVar).toBeUndefined();
  expect(core!.db.getWorkspace(meta.id)?.projectVar).toBeUndefined();
  await patch({ projectVar: "CAPSULE_PROJECT_URL" });
  expect(((await (await patch({ projectVar: "  " })).json()) as { projectVar?: string }).projectVar).toBeUndefined();
});

describe("otherRepoRules: the scripts/setup of the repository (#557)", () => {
  const rules = (setup: { config: boolean; kit: string[]; copies: string[] }) => otherRepoRules({ meta: "/work/switchboard", projectVar: "LIB_URL", setup });
  const kept = ["--repo <このリポジトリの owner/name>", "`bun /work/switchboard/scripts/local-ci.ts <PR> --repo"];

  test("otherRepoRules: its own entries and ops.config.json are used, with OPS_KIT; no Project URL variable is handed over", () => {
    const r = rules({ config: true, kit: ["lint_backlog.sh"], copies: [] });
    expect(r).toContain("運用ツール（`scripts/setup/` の lint_backlog.sh）はこのリポジトリの入口を使ってください");
    expect(r).toContain("`OPS_KIT=/work/switchboard/ops-kit`");
    expect(r).not.toContain("SWITCHBOARD_PROJECT_URL=$(gh variable get");
    for (const k of kept) expect(r).toContain(k);
  });

  test("otherRepoRules: without its own kit entries the scripts are the meta's, with the Project URL", () => {
    const r = rules({ config: false, kit: [], copies: [] });
    expect(r).toContain("はこのリポジトリには無く");
    expect(r).toContain("SWITCHBOARD_PROJECT_URL=$(gh variable get LIB_URL)");
    expect(r).not.toContain("写し");
    for (const k of kept) expect(r).toContain(k);
  });

  test("otherRepoRules: a copy is not used; the meta's entry of the same name is, with the Project URL", () => {
    const r = rules({ config: false, kit: [], copies: ["lint_backlog.sh"] });
    expect(r).toContain("`scripts/setup/` の lint_backlog.sh は共通キットを呼ばない写しなので使わない");
    expect(r).toContain("/work/switchboard の `scripts/setup/` の同じ名前の入口に `SWITCHBOARD_PROJECT_URL=$(gh variable get LIB_URL)` を付けて使う");
    for (const k of kept) expect(r).toContain(k);
  });
});

test("otherRepoRules: after a merge the Task tags it with release-tag.ts --repo; local-ci.ts runs with --repo", () => {
  const rules = otherRepoRules({ meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } });
  expect(rules).toContain("`bun /work/switchboard/scripts/release-tag.ts $(git rev-parse origin/main) --repo <このリポジトリの owner/name>`");
  expect(rules).toContain("`bun /work/switchboard/scripts/rollback-pr.ts <tag> --repo <このリポジトリの owner/name>`");
  expect(rules).toContain("`bun /work/switchboard/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>`");
  expect(rules.match(/[^。]*実行しない/g)).toBeNull();
});

test("PATCH /api/workspaces/:id: the same projectVar keeps the stored backlog; another one forgets it and imports again (#885)", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const patch = (projectVar: string | null) => fetch(`${base}/api/workspaces/${meta.id}`, { method: "PATCH", body: JSON.stringify({ projectVar }) });
  const source = core!.db.getWorkspaceBacklogSource(meta.id);
  expect(source).not.toBeNull();
  await patch(null); // unset, as it was
  expect(core!.db.getWorkspaceBacklogSource(meta.id)).toEqual(source);
  const before = fake.calls.length;
  await patch("OTHER_PROJECT_URL");
  // the PATCH itself asks for the import (before any look at the backlog)
  for (let i = 0; fake.calls.length === before && i < 100; i++) await Bun.sleep(10);
  expect(fake.calls.length).toBeGreaterThan(before);
  const after = await refreshed(base, false);
  expect(core!.db.getWorkspaceBacklogSource(meta.id)).toEqual(source); // imported again: the fake answers the same Project
  expect(after.items.length).toBeGreaterThan(0);
});

test("a workspace registered over the API and given its projectVar is in GET /api/backlog with no errors, even with 0 Issues (#1447)", async () => {
  const fake = fakeGh();
  // a Project with no Issue yet: the same answers, an empty page for the GraphQL reads
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api" && args.some((a) => a.includes("issues("))) return { code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" };
    return fake.gh(args, cwd);
  };
  const base = await boot(gh);
  const seen: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${core!.server.port}/ws`);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as { type: string }; if (m.type === "workspaces.updated") seen.push(m.type); };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const dir = mkdtempSync(join(home!, "new-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  const created = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "fresh" }) })).json()) as { id: string };
  for (let i = 0; seen.length < 1 && i < 100; i++) await Bun.sleep(10);
  expect(seen).toHaveLength(1);
  expect((await fetch(`${base}/api/workspaces/${created.id}`, { method: "PATCH", body: JSON.stringify({ projectVar: "FRESH_PROJECT_URL" }) })).status).toBe(200);
  for (let i = 0; seen.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(seen).toHaveLength(2);
  const after = await refreshed(base, false);
  ws.close();
  expect(after.errors.filter((e) => e.workspaceId === created.id)).toEqual([]);
  expect(after.syncs.find((s) => s.workspaceId === created.id)).toMatchObject({ syncing: false, syncedAt: expect.any(Number), sync: expect.objectContaining({ state: expect.not.stringMatching(/^error$/) }) });
  expect(after.items.filter((i) => i.workspaceId === created.id)).toEqual([]);
});

test("GET /api/backlog before the first import: no items, the workspace in errors and its import under way — never an empty list as if read (#885)", async () => {
  const ok = fakeGh();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api") await held; // GitHub has not answered yet
    return ok.gh(args, cwd);
  };
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(gh) });
  const base = `http://127.0.0.1:${core.server.port}`;
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const first = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(first.items).toEqual([]);
  expect(first.errors).toEqual([{ workspaceId: meta.id, workspaceName: meta.name, message: "まだ GitHub から取り込んでいません", kind: "other" }]);
  expect(first.syncs).toEqual([{ workspaceId: meta.id, backlog: "github", enabling: null, repository: null, syncing: true, syncedAt: null, creates: [], issues: [], sync: expect.objectContaining({ state: "error", reason: "unfetched", lastSuccessfulSync: null }) }]);
  // an answer or a start has nothing stored to check against: 424, nothing written
  const answer = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: meta.id, text: "A" }) });
  expect(answer.status).toBe(424);
  release();
  const after = await refreshed(base, false);
  expect(after.errors).toEqual([]);
  expect(after.items.length).toBeGreaterThan(0);
});

test("prereqsOf: the first **前提** line outside fences, its numbers once each and （リリース） after one", () => {
  expect(prereqsOf("## 背景\nx\n\n**前提**: #12, #34（リリース）\n**Story Points**: 3")).toEqual([{ number: 12, release: false }, { number: 34, release: true }]);
  expect(prereqsOf("**前提**: なし")).toEqual([]);
  expect(prereqsOf("**前提**: #7, #7（リリース）, #7\r\n")).toEqual([{ number: 7, release: true }]);
  // inside a fence, a second line, free text and the 依存関係 section are not read
  expect(prereqsOf("```\n**前提**: #1\n```\n**前提**: #2\n**前提**: #3")).toEqual([{ number: 2, release: false }]);
  expect(prereqsOf("前提: #9 が Done\n## 依存関係\n#10 の後")).toEqual([]);
  expect(prereqsOf("")).toEqual([]);
});

test("prereqState: Issues, pull requests and releases by how they closed; not stored is missing (#937)", () => {
  const issue = (state: string, stateReason: string | null = null): WaitTarget => ({ kind: "issue", state, isDraft: false, labels: [], closes: [], stateReason, mergeCommit: null });
  const pr = (state: string, more: Partial<WaitTarget> = {}): WaitTarget => ({ kind: "pr", state, isDraft: false, labels: [], closes: [], stateReason: null, mergeCommit: state === "MERGED" ? "m1" : null, ...more });
  const none = () => null;
  expect(prereqState(issue("OPEN"), "done", none)).toBe("pending");
  expect(prereqState(issue("CLOSED", "COMPLETED"), "done", none)).toBe("met");
  expect(prereqState(issue("CLOSED"), "done", none)).toBe("met"); // closed before the reason was read
  expect(prereqState(issue("CLOSED", "NOT_PLANNED"), "done", none)).toBe("withdrawn");
  expect(prereqState(issue("CLOSED", "DUPLICATE"), "done", none)).toBe("withdrawn");
  expect(prereqState(issue("CLOSED", "COMPLETED"), "release", () => true)).toBe("unknown"); // an Issue has no merge commit
  expect(prereqState(pr("OPEN"), "merged", none)).toBe("pending");
  expect(prereqState(pr("OPEN", { isDraft: true }), "merged", none)).toBe("pending");
  expect(prereqState(pr("MERGED"), "merged", none)).toBe("met");
  expect(prereqState(pr("CLOSED"), "merged", none)).toBe("withdrawn");
  expect(prereqState(pr("MERGED"), "release", (oid) => oid === "m1")).toBe("met");
  expect(prereqState(pr("MERGED"), "release", () => false)).toBe("pending");
  expect(prereqState(pr("MERGED"), "release", none)).toBe("unknown");
  expect(prereqState(pr("MERGED", { mergeCommit: null }), "release", () => true)).toBe("unknown");
  expect(prereqState(undefined, "done", none)).toBe("missing");
});

test("#950: a stop that came again with nothing changed holds the item through an unrelated Issue update; an answer, a met condition or a new cause lets it go once", () => {
  const last = { id: "tsk_last", status: "done" as const, statusAt: 1, createdAt: 1, updatedAt: Date.parse("2026-09-10T00:00:00Z"), action: "complete" as const, outcome: "done" as const, reviewedAt: null, resumeAt: null };
  const stopOf = (over: Partial<BacklogItem["stopSummary"][number]> = {}): BacklogItem["stopSummary"][number] => ({
    key: "k", work: { workspaceId: "ws_meta", issue: 3, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI", safety: "unknown",
    count: 2, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, conditions: [], actions: [], changes: [], unchanged: true, next: "wait", ...over,
  });
  const touched = "2026-09-12T00:00:00Z"; // the Issue was updated after the Task ended
  const base = item({ number: 3, stage: "ready", lastTask: last, updatedAt: touched, stopSummary: [stopOf()] });
  // same condition, restopped: an update to the Issue alone starts nothing, and the item is listed as left alone
  expect(stopHeld(base)).toBe(true);
  expect(pickNext([base], "implement")).toBeNull();
  expect(unchangedIn([base], "implement").map((i) => i.number)).toEqual([3]);
  // without the stop the same update does start it again (the earlier behaviour)
  expect(pickNext([{ ...base, stopSummary: [] }], "implement")?.item.number).toBe(3);
  // a first stop with nothing waited on is not held — an unrelated update still lets it start once
  expect(stopHeld({ ...base, stopSummary: [stopOf({ count: 1, unchanged: false })] })).toBe(false);
  // a first stop with a condition still unmet is held; once the item's own prerequisite is met it goes
  const waitingOn = stopOf({ count: 1, unchanged: false, conditions: [{ key: "pr#12", value: "open", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [waitingOn] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [waitingOn], prereqs: [{ number: 12, kind: "pr", need: "merged", state: "met", via: null }] })).toBe(false);
  expect(stopHeld({ ...base, stopSummary: [waitingOn], prereqs: [{ number: 12, kind: "pr", need: "merged", state: "pending", via: null }] })).toBe(true);
  // retries used up: held until something changes
  expect(stopHeld({ ...base, stopSummary: [stopOf({ count: 1, state: "exhausted", next: "decide" })] })).toBe(true);
  // one of two conditions met: the other still holds it
  const two = stopOf({ count: 1, unchanged: false, changes: [{ kind: "condition-met", detail: "pr#12: merged" }], conditions: [{ key: "pr#12", value: "merged", met: true }, { key: "review", value: "pending", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [two] })).toBe(true);
  // a new answer, a condition met, another cause: not held
  for (const kind of ["answer", "condition-met", "cause"] as const)
    expect(stopHeld({ ...base, stopSummary: [stopOf({ unchanged: false, changes: [{ kind, detail: "x" }], next: "resume" })] })).toBe(false);
  // resolved or of an older Task: not held; a ## 回答 on the PBI releases it too
  expect(stopHeld({ ...base, stopSummary: [stopOf({ state: "resolved" })] })).toBe(false);
  expect(stopHeld({ ...base, stopSummary: [stopOf({ work: { workspaceId: "ws_meta", issue: 3, taskId: "tsk_old" } })] })).toBe(false);
  const progress = item({ number: 4, stage: "in-progress", tasks: { done: 1, total: 3, doneAt: null }, lastTask: last, updatedAt: touched, stopSummary: [stopOf()] });
  expect(pickNext([progress], "implement")).toBeNull();
  expect(pickNext([{ ...progress, answeredAt: "2026-09-13T00:00:00Z" }], "implement")?.item.number).toBe(4);
  // a different item still goes first
  expect(pickNext([base, item({ number: 5, stage: "ready" })], "implement")?.item.number).toBe(5);
  // the newest series decides: an older one that stayed the same does not hold back a new cause
  const newCause = stopOf({ key: "k2", reason: "auth", count: 1, lastAt: 9, unchanged: false, changes: [{ kind: "cause", detail: "depends → auth" }], next: "decide" });
  expect(stopHeld({ ...base, stopSummary: [stopOf(), newCause] })).toBe(false);
  // an unmet condition's value moving is not a condition met; and an Issue #12 met is not PR #12 met
  const moved = stopOf({ unchanged: false, changes: [{ kind: "condition", detail: "pr#12: open → draft" }], conditions: [{ key: "pr#12", value: "draft", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [moved] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [moved], prereqs: [{ number: 12, kind: "issue", need: "done", state: "met", via: null }] })).toBe(true);
});

/* ---------- a start goes on the stored data; only a conflict holds it (#909, #2264) ---------- */

describe("start gate: only a conflict in the stored data holds a start (#909, #2264)", () => {
  const tasksOf304 = () => core!.db.listTasks().filter((t) => t.title.startsWith("#304 "));
  /** GitHub unreachable while `down.on`; the same fake answers once it is up. */
  const bootDown = async (claude = holdingClaude()) => {
    const fake = fakeGh();
    const down = { on: false };
    const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)), claude.adapter);
    return { base, down };
  };

  test("an edit kept while GitHub is out of reach: the start makes the Task on the stored data", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(tasksOf304()).toHaveLength(1);
  });

  test("a held conflict: the manual start is 409 naming the field, and backlog-next leaves it and logs why", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
    importedAs(304, { title: "GitHub の題" });
    down.on = false;
    const refused = await start(base, 304, { action: "complete" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("競合");
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(tasksOf304()).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/競合があるので自動では始めない.*#304（競合/));
  });

  test("a refused edit (failed) is shown, not a reason: the start by hand makes the Task", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    const r = await patch(base, 304, { title: "手元の題" });
    expect(r.status).toBe(202);
    const op = core!.db.listPendingBacklogOperations()[0]!;
    core!.db.setBacklogOperationResult(op.id, { status: "failed", error: "permission" });
    down.on = false;
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(tasksOf304()).toHaveLength(1);
  });

  /** Runs backlog-next once with #307 (picked to 閉じる) changed by `change` on GitHub between the sweep's read and the read right before its start. */
  const sweepWith307Changed = async (change: (i: Record<string, any>) => Record<string, unknown>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const fake = fakeGh();
    const changed = { from: Infinity };
    let reads = 0;
    const gh: GhRunner = async (args, cwd) => {
      const r = await fake.gh(args, cwd);
      if (!args.includes("query=issues(states:OPEN)")) return r;
      // each read of the Issues starts on the first page; #307 is on the second
      if (!args.includes("after=CURSOR1")) reads++;
      if (reads < changed.from) return r;
      const body = JSON.parse(r.stdout);
      body.data.repository.issues.nodes = body.data.repository.issues.nodes.map((i: { number: number }) => (i.number === 307 ? change(i) : i));
      return { ...r, stdout: JSON.stringify(body) };
    };
    const base = await boot(gh, holdingClaude().adapter);
    await refreshed(base);
    // the sweep's first read still sees #307 as it was and picks it to close; the read right before its start sees the change
    changed.from = reads + 2;
    await runSchedule(base, await backlogNextSchedule(base));
    expect(reads).toBeGreaterThanOrEqual(changed.from);
    expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 "))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#307 を始めない"));
  };

  test("backlog-next asks again right before each start: a PBI GitHub closed after the sweep picked it to 閉じる is not started on the older copy", async () => {
    await sweepWith307Changed((i) => ({ ...i, state: "CLOSED", updatedAt: new Date().toISOString() }));
  });

  test("backlog-next picks the action again on the fresh copy: a Task reopened meanwhile (the PBI itself unchanged) is no 閉じる", async () => {
    await sweepWith307Changed((i) => ({ ...i, subIssuesSummary: { ...i.subIssuesSummary, completed: i.subIssuesSummary.completed - 1 } }));
  });

  test("a start is not judged on the stored copy: GitHub is imported again first", async () => {
    const asked: string[][] = [];
    const fake = fakeGh();
    const base = await boot(async (args, cwd) => (asked.push(args), fake.gh(args, cwd)), holdingClaude().adapter);
    await fetch(`${base}/api/backlog`);
    const n = asked.length;
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(asked.length).toBeGreaterThan(n);
  });
});

describe("canStartStoredBacklog (#2264)", () => {
  const NOW = 1_000_000;
  const sync = (over: Partial<BacklogItem["sync"]>): Pick<BacklogItem, "sync"> => ({ sync: { state: "synced", reason: null, lastSuccessfulSync: NOW - 1000, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A", ...over } });
  test("only a conflict held in the stored data is refused, with the field", () => {
    expect(canStartStoredBacklog(sync({ state: "conflict", pendingCount: 1, conflicts: [{ field: "body", base: "a", local: "b", remote: "c", remoteRead: true, revision: "r" }] }))).toMatchObject({ ok: false, why: expect.stringContaining("body") });
  });
  test("edits waiting, a failed or old import, a refused edit or an unread Issue are GitHub's side: they pass", () => {
    for (const over of [{}, { lastSuccessfulSync: NOW - 3_600_000 }, { lastSuccessfulSync: null }, { state: "pending", pendingCount: 2 }, { state: "pending", reason: "unknown", pendingCount: 1 }, { state: "error", reason: "import" }, { state: "error", reason: "failed", pendingCount: 1 }, { state: "error", reason: "unfetched" }, { state: "error", reason: "forbidden" }] as Partial<BacklogItem["sync"]>[])
      expect(canStartStoredBacklog(sync(over))).toEqual({ ok: true });
  });
});

test("comment: a plain comment is kept here at once (202) as a comment operation — no heading, no label change — and refused for a secret or an unknown Issue (#910)", async () => {
  const fake = fakeGh();
  const down = { on: false };
  const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  const post = (n: number, text: string) => fetch(`${base}/api/backlog/${n}/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text }) });
  const r = await post(304, "確認しました");
  expect(r.status).toBe(202);
  const ops = core!.db.listPendingBacklogOperations().filter((o) => o.kind === "comment");
  expect(ops).toHaveLength(1);
  expect(ops[0]!.payload).toEqual({ body: "確認しました" });
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.kind === "set")).toEqual([]);
  expect((await detailOf(base, 304)).comments.map((c) => c.body)).toContain("確認しました");
  expect((await post(999, "x")).status).toBe(404);
  expect((await post(304, "ghp_" + "a".repeat(36))).status).toBe(422);
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "  " }) })).status).toBe(400);
});

test("stage Tasks are found by their stage column: a renamed one still counts, a plain Task titled like one does not, another workspace's #n is not mixed in (#1139)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const item = async (n: number, workspaceId = metaId()) => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === n && i.workspaceId === workspaceId)!;
  // (a) a button's Task renamed by hand is still #303's active and last Task
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
  // and the plain Task titled like an 実装 holds no implement slot: backlog-next still starts #304's
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toContain("#304 実装"); // the plain Task holds no implement slot
});

/* ---------- the kit's common commands on the stored backlog (#918) ---------- */

test("ops-kit backlog: reads answer what is stored with GitHub out of reach and no runner; an edit stores what the screen's does; --fresh with GitHub out of reach answers what is stored (#2264); no app is exit 2", async () => {
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
  expect(list.out).toContain("#304\tpbi\tready\tReady\tPBI: Ready の PBI");
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
  // --fresh asks for a send and an import; GitHub out of reach: the stored copy, said to be not synced (#2264)
  const unsynced = await cli("list", "--fresh");
  expect([unsynced.code, unsynced.out.includes("GitHub 未同期"), unsynced.out.includes("#304")]).toEqual([0, true, true]);
  await core!.stop();
  core = undefined;
  expect((await cli("list")).code).toBe(2);
});

test("GET /api/backlog/records (#919): lint and the parallel guard read the stored records with GitHub out of reach, --fresh too (#2264)", async () => {
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
  // the kit's lint: no GitHub call at all (the kit's gh throws on any), a finished check (0 or 1), never "could not check"
  const kitGh = fakeKitGh([]);
  const lines: string[] = [];
  const code = await opsKit(["lint", "--config", join(import.meta.dir, "../../../ops.config.json")], kitGh, (l) => lines.push(l), (l) => lines.push(l), async () => {}, env);
  expect([0, 1]).toContain(code);
  expect(lines.join("\n")).toContain("アプリの保存値を検査（acme/app");
  expect(kitGh.calls).toHaveLength(0);
  // the guard on a stored Task (the fixture's #30400 names no path): judged from the records, so it gets to the paths, never to gh
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
