// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Backlog, BacklogIssueData, BacklogAction, BacklogIssueDetail, BacklogQueue, BacklogSource, BacklogItem, RunnerAdapter, StartOptions, Task, TaskStatus } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { listProcesses, loadProcess, parseProcessDef } from "./process-defs.ts";
import type { Suggester } from "./routing.ts";
import { startServer, type CoreServer, type StartServerOptions } from "./server.ts";
import { taskAllowRules } from "./tasks.ts";
import { Db } from "./db.ts";
import { saveQueue } from "./backlog-queue.ts";
import { importing } from "../fixtures/github-import.ts";
import { readRecords, runBacklog } from "../../../ops-kit/src/backlog-client.ts";
import { main as opsKit } from "../../../ops-kit/src/cli.ts";
import { fakeGh as fakeKitGh } from "../../../ops-kit/src/gh.ts";
import { ghBoard, overlap, storedMaterial } from "../../../scripts/parallel-guard.ts";
import { fmtTime, RESUME_MARGIN_MS } from "./ratelimit.ts";
import { delegatedNote } from "./evals.ts";
import { answerStoredDecision, BacklogEditError, checkFieldTypes, buildDirectPrompt, buildStartPrompt, subagentModelAlias, localBacklogSource, canStartStoredBacklog, screenAnswer, confirmationsOf, confirmAfterOf, confirmDecisionsOf, mockupTaskOf, prereqsOf, prereqState, type WaitTarget, GithubBudgetCache, holdStoredDecision, otherRepoRules, pickNext, promotionStep, reportPromoteFailure, stageOf, toItem, requestTextChars, spinningIn, tasksDoneMark, TASKS_DONE_MARK, unchangedIn, heldIn, onHoldIn, chooseProcess, flowHeldIn, flowHeldLine, flowRunning, flowStopped, type GhRunner, type RawBacklogIssue, type ReleaseState, awaitingReply, failedIn, failedSince, isReplyWaiting, replyWaitingIn, stopHeld, storedIssueHeads, readStoredIssue, editStoredIssue, waitsOf, isUnblocked, withOverlap } from "./backlog.ts";

// the writer of the waits, read at run time: scripts/ is not type-checked under core's settings
const guard = "../../../scripts/parallel-guard.ts";
/** The meta workspace is this checkout, whose origin is not the fake gh's acme/app: no origin to check (tasks.test.ts checks it). */
const FAKE_ORIGIN = () => null;
const { releaseBody } = (await import(guard)) as { releaseBody: (reason: string, waits?: number[], overlap?: boolean, after?: string) => string };
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
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
    if (args[0] === "issue") return failIssueWrite ? { code: 1, stdout: "", stderr: "HTTP 403" } : { code: 0, stdout: "", stderr: "" };
    if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
    const page = args.includes("after=CURSOR1") ? pages[1] : pages[0];
    return { code: 0, stdout: JSON.stringify(page), stderr: "" };
  };
  // GitHub's budget is not a read of the backlog
  return { gh, calls, cwds, graphql: () => calls.filter((a) => a[0] === "api" && !a.some((x) => x.includes("rateLimit"))).length };
}

/** fakeGh with the 分解待ち Issue 303 already decomposed into 2 open sub-issues, its Status still Backlog. */
function decomposedGh() {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; subIssuesSummary: unknown }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 303) node.subIssuesSummary = { total: 2, completed: 0 };
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}
/** fakeGh with Issue 308 (confirmations left, Tasks all closed) holding one more open Task. */
function openTaskAndConfirmationGh() {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; subIssuesSummary: { total: number; completed: number } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 308) node.subIssuesSummary = { total: node.subIssuesSummary.total, completed: node.subIssuesSummary.total - 1 };
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}
/** fakeGh with `numbers` labelled on-hold. */
function onHoldGh(...numbers: number[]) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (numbers.includes(node.number)) node.labels.nodes.push({ name: "on-hold" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}
/** The prompt a decomposed PBI in 分解待ち is started with: make it Ready, do not decompose it again. */
const DECOMPOSED_READY = (n: number, total: number) => `PBI #${n} は Task（sub-issue ${total} 件）に分解済みですが、Project の Status が Ready になっていません。`;

/** fakeGh, answering GitHub's GraphQL budget with `remaining` of 5,000 points, back at `resetAt`. */
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

/** The list once the imports under way are stored (`refresh`: asks for them first; a plain read answers what is stored meanwhile). */
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
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
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
async function boot(gh: GhRunner, adapter: RunnerAdapter | RunnerAdapter[] = { id: "claude", detect: async () => ({ available: false }), start() { throw new Error("no runs"); } }, env: Record<string, string> = {}, llmSuggester?: () => Suggester, outer: (gh: GhRunner) => GhRunner = (g) => g, extra: Partial<StartServerOptions> = {}) {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...env });
  // as the daemon starts: every workspace is imported at boot; the tests begin once it is stored
  core = await startServer(cfg, [adapter].flat(), { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: outer(importing(gh, () => openPulls)), llmSuggester, backlogAutoImport: true, ...extra });
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
  const merge = { id: "m", op: "gh pr merge", target: "PR #9", reason: "depends" as const, evidence: "CI", safety: "unknown" as const, conditions: [], actions: [], state: "waiting" as const };
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
  const asked = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 305 && i.workspaceId === metaId())!;
  expect(asked.replyWaiting).toBe(true);
  expect(mine(307).replyWaiting).toBe(false);
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
/** What waits to be sent to GitHub: per operation, its Issue's number, kind, field and what is sent. */
const queued = () =>
  core!.db.listPendingBacklogOperations().map((o) => {
    const issue = core!.db.getBacklogRecord({ ...o, objectKind: "issue", externalId: o.issue });
    return [((issue?.local ?? issue?.remote) as { number: number } | null)?.number, o.kind, o.field, o.payload];
  });
const metaName = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!.name;
/** POST .../start; the body names the meta workspace unless it names another. */
const start = (base: string, n: number | string, body: object) =>
  fetch(`${base}/api/backlog/${n}/start`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

test("defers an automatic start at the limit: a stage button at the limit with no fallback answers with the Task made without starting, held to the reset", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  core!.db.upsertQuota("claude", "seven_day", 0.99, resetSec);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task).toMatchObject({ runner: "claude", status: "idle", resumeReason: "start", resumeAt: resetSec * 1000 + RESUME_MARGIN_MS, stage: { issue: 304, action: "complete" } });
  expect(core!.db.listEvents(task.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("claude が上限（0.99、") && e.ev.text.endsWith("のため戻る時刻に開始"))).toBe(true);
  await Bun.sleep(50);
  expect(claude.starts).toHaveLength(0);
});

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
  // the stage Task records the pipeline candidate and the stage as its reason (docs/design/process-kernel.md, K1)
  expect(await fetch(`${base}/api/tasks/${task.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline", version: 1 }, processReason: "backlog stage complete" });
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
  // the running Task marks lib's Issue 303, not the meta's; the meta's Issue 303 can still start
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

test("start: a local backlog's stage prompt says ops-kit backlog only, no gh issue / scripts/setup", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: ["lint_backlog.sh"] } };
  for (const action of ["to-pbi", "to-tasks", "complete", "check", "close"] as const) {
    for (const p of [buildStartPrompt({ number: 1 }, action, { other, local: true }), buildStartPrompt({ number: 1 }, action, { local: true })]) {
      expect(p).toContain("#1 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）");
      expect(p).toContain("`ops-kit backlog`");
      expect(p).toContain("`ops-kit lint --fresh`");
      expect(p).toContain("`--repo` を付けずに実行する");
      // the PR names the Task without a closing keyword or #N (it is no GitHub Issue), and the Task is closed by hand after the merge
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
  for (const kept of ["scripts/merge-gate.ts", "scripts/local-ci.ts", "scripts/release-tag.ts", "scripts/rollback-pr.ts", "docs/merge-gate.md"]) expect(complete).toContain(kept);
  // a GitHub one is as before
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("`gh repo view` が答えるもの");
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("APP_PROJECT_URL");
});

test("start: a local workspace without a remote (localForge) gets local changes, not PRs", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: ["lint_backlog.sh"] } };
  for (const [p, scripts] of [[buildStartPrompt({ number: 1 }, "complete", { other, local: true, localForge: true }), "/work/switchboard/"], [buildStartPrompt({ number: 1 }, "complete", { local: true, localForge: true }), ""]] as const) {
    // the backlog half stays
    expect(p).toContain("`ops-kit lint --fresh`");
    expect(p).toContain("`--repo` を付けずに実行する");
    // changes, not PRs
    expect(p).toContain("この workspace の変更はアプリに置く（リモートは使わない）");
    // the marks that lift a recheck or answer a merge ask go on the change
    expect(p).toContain(`${scripts}docs/merge-gate.md` + "\` の「Recheck」");
    expect(p).toContain("\`ops-kit backlog comment <変更>\` で変更に付ける");
    expect(p).toContain("--head <枝> --base main");
    expect(p).toContain("Backlog-Task: <Task>");
    for (const cmd of [`bun ${scripts}scripts/local-ci.ts --change <変更>`, `bun ${scripts}scripts/merge-gate.ts --change <変更>`, `bun ${scripts}scripts/local-merge.ts <変更>`]) expect(p).toContain(cmd);
    expect(p).not.toContain("PR・レビュー・CI・マージはリポジトリの PR で行う");
    expect(p).not.toContain("release-tag.ts");
    expect(p).not.toContain("rollback-pr.ts");
    expect(p).not.toContain("--repo <このリポジトリの owner/name>");
    expect(p).not.toMatch(/gh pr (?:create|merge|comment)/);
  }
  // without it, as before
  expect(buildStartPrompt({ number: 1 }, "complete", { local: true })).toContain("PR・レビュー・CI・マージはリポジトリの PR で行う");
});

test("start: check on a stage other than in-progress is 409", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  for (const n of [306, 304, 303, 302]) expect((await start(base, n, { action: "check" })).status).toBe(409);
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: complete on an in-progress item resumes it", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 305, { action: "complete" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title.startsWith("#305 実装: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  // the same Task backlog-next starts for a stalled in-progress PBI: the closed Tasks when it was chosen
  expect(claude.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 1 } }));
  expect(claude.starts[0]!.prompt).toContain("PBI #305 は実装中のまま止まっています");
});

test("complete task model: with the trial's model the 実装 Task's prompt hands each Task to a sonnet subagent and the transcript says so; another kind gets neither (同じ: the existing complete tests' prompts)", async () => {
  const c2 = holdingClaude();
  const base2 = await boot(fakeGh().gh, { ...c2.adapter, models: [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5" }] });
  const notes = (id: string) => core!.db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect((await fetch(`${base2}/api/settings`, { method: "PATCH", body: JSON.stringify({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } }) })).status).toBe(200);
  const r = await start(base2, 305, { action: "complete" });
  expect(r.status).toBe(201);
  const t = (await r.json()) as Task;
  for (let i = 0; !c2.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(c2.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 1 }, taskModel: "claude-sonnet-5-5" }));
  expect(c2.starts[0]!.prompt).toContain("Agent ツールの model に `sonnet` を指定したサブエージェントに前景で任せてください");
  expect(notes(t.id)).toEqual([delegatedNote("claude-sonnet-5-5")]);
  // the mark reads back through the Task's evals
  expect(((await (await fetch(`${base2}/api/tasks/${t.id}/evals`)).json()) as { rules: { metrics: { delegatedModel: string | null } } }).rules.metrics.delegatedModel).toBe("claude-sonnet-5-5");
  // another kind: no paragraph, no note
  const check = await start(base2, 303, { action: "to-tasks" });
  expect(check.status).toBe(201);
  const ct = (await check.json()) as Task;
  for (let i = 0; c2.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(c2.starts[1]!.prompt).not.toContain("試験:");
  expect(notes(ct.id)).toEqual([]);
});

test("complete task model: an 実装 Task that starts on codex (its kind's runner changed after the model was saved) gets neither the paragraph nor the note", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [{ ...claude.adapter, models: [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5" }] }, { ...codex.adapter, id: "codex" }]);
  const patch = (body: unknown) => fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify(body) });
  expect((await patch({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } })).status).toBe(200);
  expect((await patch({ autoStart: { byKind: { complete: { runner: "codex" } } } })).status).toBe(200); // the saved model stays
  const r = await start(base, 305, { action: "complete" });
  expect(r.status).toBe(201);
  const t = (await r.json()) as Task;
  for (let i = 0; !codex.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(t.runner).toBe("codex");
  expect(codex.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 1 } }));
  expect(core!.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text === delegatedNote("claude-sonnet-5-5"))).toBe(false);
});

test("buildStartPrompt task model: every complete entry carries the alias's paragraph; another action, an unaliased model or none leaves the prompt as before", () => {
  const para = (a: string) => `Agent ツールの model に \`${a}\` を指定したサブエージェントに前景で任せてください`;
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-sonnet-5-5" })).toContain(para("sonnet"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-opus-5-5", resume: { tasksDone: 2 } })).toContain(para("opus"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-haiku-4-5", other: { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: [], copies: [] } } })).toContain(para("haiku"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-fable-5-1" })).toContain(para("fable"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "gpt-6" })).toBe(buildStartPrompt({ number: 1 }, "complete"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "" })).toBe(buildStartPrompt({ number: 1 }, "complete"));
  expect(buildStartPrompt({ number: 1 }, "to-tasks", { taskModel: "claude-sonnet-5-5" })).toBe(buildStartPrompt({ number: 1 }, "to-tasks"));
  expect(subagentModelAlias("claude-sonnet-5-5")).toBe("sonnet");
  expect(subagentModelAlias("us.anthropic.claude-sonnet-5-5")).toBeNull();
});

test("start: complete while the in-progress item's check is running is 409 with its id", async () => {
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
  const gh: GhRunner = async (args, cwd) => (cwd === dir.lib && args[0] === "repo" ? { code: 0, stdout: "acme/lib true\n", stderr: "" } : fake.gh(args, cwd));
  const base = await boot(gh);
  dir.lib = mkdtempSync(join(home!, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir.lib, name: "lib" }) })).json()) as { id: string };
  await refreshed(base);
  const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: lib.id, text: "A で" }) });
  expect(r.status).toBe(202);
  expect(core!.db.listPendingBacklogOperations().map((o) => o.repository)).toEqual(["acme/lib", "acme/lib"]);
  expect(queued()).toEqual([[306, "comment", null, { body: "## 回答\n\nA で", screen: true }], [306, "set", "label:needs-decision", false]]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("start: to-tasks on a decomposed PBI asks to make it Ready", async () => {
  const claude = holdingClaude();
  const base = await boot(decomposedGh().gh, claude.adapter);
  const item = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 303)!;
  expect(item).toMatchObject({ stage: "needs-tasks", tasks: { total: 2, done: 0 } });
  const task = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  // the action and the title stay to-tasks' (no new action)
  expect(task.title.startsWith("#303 Task に分解: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toBe(buildStartPrompt(item, "to-tasks"));
  expect(claude.starts[0]!.prompt).toContain(DECOMPOSED_READY(303, 2));
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

test("start: direct on a request starts a p1-direct Task recorded as the direct button; p0 and p1 never run together on it", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 302, { action: "direct" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.title.startsWith("#302 直行で直す: ")).toBe(true);
  expect(task.stage).toEqual({ issue: 302, action: "direct" });
  expect(await fetch(`${base}/api/tasks/${task.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p1-direct" }, processReason: "direct button" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toBe(buildDirectPrompt({ number: 302 }, { local: false, localForge: false, answer: null }));
  expect(claude.starts[0]!.prompt).toContain("次の信号を読み、それが求める最小の変更を 1 本の PR にしてください: #302");
  // while it runs, neither PBI にする nor a second 直行 starts on the same request
  expect((await start(base, 302, { action: "to-pbi" })).status).toBe(409);
  expect((await start(base, 302, { action: "direct" })).status).toBe(409);
});

test("buildDirectPrompt: carries the screen answer as the person's words, and a local backlog's rules", () => {
  const answer = { issue: 302, text: "B: 直す — 許可: X だけ許可します" };
  const said = buildDirectPrompt({ number: 302 }, { answer });
  expect(said).toContain("利用者が画面で答えた Issue #302 の最新の回答（利用者の言葉）:\n\n````text\nB: 直す — 許可: X だけ許可します\n````");
  expect(buildDirectPrompt({ number: 302 }, { answer: { issue: 302, text: "a ```` b" } })).toContain("`````text\na ```` b\n`````");
  expect(buildDirectPrompt({ number: 302 })).not.toContain("利用者が画面で答えた");
  // a meta workspace whose backlog is kept in Switchboard: the same rules as a stage Task there (no #<n> or closing keywords in the PR)
  const local = buildDirectPrompt({ number: 302 }, { local: true });
  expect(local).toContain("#302 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。");
  expect(local).toContain(buildStartPrompt({ number: 302 }, "to-pbi", { local: true }).split("（GitHub には無い）。")[1]!);
  expect(buildDirectPrompt({ number: 302 }, { local: true, localForge: true })).toContain(buildStartPrompt({ number: 302 }, "to-pbi", { local: true, localForge: true }).split("（GitHub には無い）。")[1]!);
  expect(buildDirectPrompt({ number: 302 })).not.toContain("GitHub には無い");
});

test("start: direct while PBI にする runs is 409; direct on anything but a request is 409", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  expect((await start(base, 302, { action: "to-pbi" })).status).toBe(201);
  expect((await start(base, 302, { action: "direct" })).status).toBe(409);
  for (const n of [303, 304, 306]) expect((await start(base, n, { action: "direct" })).status).toBe(409); // needs-tasks, ready, needs-decision
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

test("start: an imported workspace starts on its stored data while GitHub is at its limit with an edit not sent — 201", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.status !== "done")).toHaveLength(1);
});

test("start: a conflict held in the stored data is 409 even while GitHub is at its limit", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  // the conflict a send found against GitHub's newer title, held in the stored data
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

test("autoStart effort: a stage button starts with the saved effort", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", effort: "high" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.effort).toBe("high");
});

test("autoStart by kind: to-tasks on codex starts Task に分解 on codex and 実装する on the common claude", async () => {
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

test("start runner: a runner in the body starts that one Task on it over the kind's default, and the saved autoStart does not change; an undetected one is 409", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { complete: { runner: "claude", model: "m-impl" } } } });
  const settings = async () => (await (await fetch(`${base}/api/settings`)).json() as { autoStart: unknown }).autoStart;
  const before = await settings();
  const task = await (await start(base, 304, { action: "complete", runner: "codex", model: "gpt-x" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", model: "gpt-x" });
  expect(await settings()).toEqual(before);
  expect((await start(base, 303, { action: "to-tasks", runner: "dak" })).status).toBe(409);
});

test("autoStart by kind: a kind whose runner is not detected starts on the common values", async () => {
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
  const slow: Suggester = { suggest: async () => (await Bun.sleep(50), { runner: "claude", reason: "slow", ruleId: "llm", model: null, available: true, alternatives: [], llm: null }) };
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

/** The fixtures' gh with comments of its own on Issue 304 (Ready) and Issue 307 (in progress), and `states` answering the waits' query. */
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
/** One wait of an item as the daemon gives it: a prerequisite with no PBI found unless said. */
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

  test("waiting: each wait says why it waits; a number GitHub did not find stays as not read and holds the PBI (the parent PBI: backlog-stored.test.ts)", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "MERGED" }, w999: null };
    const fake = waitsGh({ i304: [[releaseBody("重複", [778, 603], true), STOPPED]], i307: [[releaseBody("前提", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
    const base = await boot(fake.gh);
    const ready = await waitsOfItem(base, 304);
    expect(ready.waits).toEqual([wait(603, "issue", true, { reason: "overlap" }), wait(778, "pr", false, { reason: "overlap" })]);
    const building = await waitsOfItem(base, 307);
    expect(building.waits).toEqual([wait(603, "issue", true), wait(999, "issue", null)]);
    // not read is not closed: still held once Issue 603 closed
    expect(pickNext([{ ...building, waits: [wait(603, "issue", false), wait(999, "issue", null)] }], "implement")).toBeNull();
  });

  test("waits owner: a PR's PBI is the parent of the Task it closes; that PBI's stage Task is read from its own item", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778, 30501]), STOPPED]] }, {
      w778: { __typename: "PullRequest", state: "OPEN", body: "## 何を\n\nCloses #30501", headRefName: "sb/30501-x" },
      w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } },
    });
    const base = await boot(fake.gh);
    const now = Date.now();
    core!.db.insertTask({ id: "tsk_owner305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "error", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
    const owner = { number: 305, title: "PBI: 実装中の PBI" };
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(778, "pr", true, { pbi: owner }), wait(30501, "issue", true, { pbi: owner })]);
    expect(await waitsOfItem(base, 305)).toMatchObject({ lastTask: { id: "tsk_owner305", status: "error" }, activeTaskId: null });
  });

  test("waits owner: a branch alone names the Task, a PBI waited for is its own, and a PR that names nothing is not found", async () => {
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
  const want = [{ n: 2, text: "2. 実機（検証: ホスト）（利用者確認: ホストで動く）", after: null }, { n: 5, text: "5. スマホ（利用者確認: スマホで読める）", after: null }];
  expect(confirmationsOf(body)).toEqual(want);
  // a body edited on GitHub's web form comes back with CRLF: no \r in the text
  expect(confirmationsOf(body.replaceAll("\n", "\r\n"))).toEqual(want);
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. ふつう（検証: テスト）\n")).toEqual([]);
  // a line that names the form in inline code (a criterion about the form itself) is not one
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 行に `（利用者確認: <何を>）` を付ける（検証: grep）\n- [ ] 2. 画面（利用者確認: `/backlog` で見る）\n"))
    .toEqual([{ n: 2, text: "2. 画面（利用者確認: `/backlog` で見る）", after: null }]);
  // a code span of two backticks holds a single one; the mark after it is outside
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）\n")).toEqual([{ n: 1, text: "1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）", after: null }]);
  // only the first ## 到達点 / 受け入れ条件 section counts, as section() reads it
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 実機（利用者確認: 見る）\n## メモ\n## 到達点 / 受け入れ条件\n- [ ] 見本（利用者確認: 数えない）\n")).toEqual([{ n: 1, text: "1. 実機（利用者確認: 見る）", after: null }]);
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
      confirmations: [{ n: 2, text: "2. ホストで動く（検証: 実機）（利用者確認: クラウドホストの画面で一覧が出る）", after: null }, { n: 4, text: "4. スマホで読める（利用者確認: スマホで開いて文字が切れない）", after: null }],
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

test("confirmAfterOf: the 期日 right after 利用者確認: with a zone; none without it, with no zone, or in inline code", () => {
  expect(confirmAfterOf("1. 出ない（利用者確認: 期日 2026-11-20T00:00:00+09:00 以降 — 1 週間で出ないか）")).toBe("2026-11-20T00:00:00+09:00");
  expect(confirmAfterOf("1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）")).toBe("2026-11-20T00:00:00Z");
  expect(confirmAfterOf("1. 見る（利用者確認: 画面を見る）")).toBeNull();
  expect(confirmAfterOf("1. 見る（利用者確認: 回答で確かめる #12 — 方針）")).toBeNull();
  // no zone, or not a time: not read
  expect(confirmAfterOf("1. 見る（利用者確認: 期日 2026-11-20T00:00:00 以降 — 確認）")).toBeNull();
  expect(confirmAfterOf("1. 見る（利用者確認: 期日 来週 以降 — 確認）")).toBeNull();
  // the form named in inline code is not one
  expect(confirmAfterOf("1. 行に `（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — x）` を書く（利用者確認: 画面）")).toBeNull();
  // confirmationsOf carries it, and the line stays a confirmation
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）\n"))
    .toEqual([{ n: 1, text: "1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）", after: "2026-11-20T00:00:00Z" }]);
});

test("confirmDecisionsOf: the numbers right after 回答で確かめる in the 利用者確認 parentheses; none in inline code or without the form", () => {
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12 — 方針）")).toEqual([12]);
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12, #34 — 方針）")).toEqual([12, 34]);
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12、#34、#12 — 方針）")).toEqual([12, 34]);
  expect(confirmDecisionsOf("1. 形だけ `（利用者確認: 回答で確かめる #12 — 方針）` を書く（利用者確認: 画面で見る）")).toEqual([]);
  expect(confirmDecisionsOf("1. 画面（利用者確認: 画面で見る #12）")).toEqual([]);
  expect(confirmDecisionsOf("1. 画面（利用者確認: 回答で確かめる — 番号なし）")).toEqual([]);
});

test("GET /api/backlog: confirmations naming decisions are not the user's; closable follows their needs-decision labels", async () => {
  const pbi = pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } };
  const node = pbi.data.repository.issues.nodes.find((n) => n.number === 308)!;
  const saved = node.body;
  const named = (ns: string) => saved.replace(/^- \[ \] 2\..*$/m, `- [ ] 2. 方針（利用者確認: 回答で確かめる ${ns} — 方針）`).replace(/^- \[ \] 4\..*$/m, "- [x] 4. 済み");
  try {
    const base = await boot(fakeGh().gh);
    // (a) every named decision is stored and none is needs-decision
    node.body = named("#304, #305");
    const a = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(a).toMatchObject({ confirmations: [], closable: true });
    // (b) one is still labelled needs-decision
    node.body = named("#304, #306");
    const b = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(b).toMatchObject({ confirmations: [], closable: false });
    // (c) a number that is not stored keeps its line
    node.body = named("#9999");
    const c = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(c).toMatchObject({ confirmations: [{ n: 2, text: "2. 方針（利用者確認: 回答で確かめる #9999 — 方針）", after: null }], closable: false });
    // backlog-next closes (a) and starts nothing for (b)
    expect(pickNext([a], "implement")).toMatchObject({ item: { number: 308 }, action: "close" });
    expect(pickNext([b], "implement")).toBeNull();
  } finally {
    node.body = saved;
  }
});

/** The fixtures' comments answer with Tasks under the in-progress PBIs 305 and 307. */
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
  expect(queued()).toEqual([[321, "comment", null, { body: "## 回答\n\nB で", screen: true }], [321, "set", "label:needs-decision", false]]);
});

test("task decision: an answer sent for the question on screen is refused when the item now asks on another Issue", async () => {
  const fake = taskDecisionGh({ i305: [subTask(322, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: 新しい問い", "2026-09-28T05:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  const post = (issue: number) => fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "A で", issue }) });
  // the screen showed Task 321's question; GitHub now has Issue 322's
  const r = await post(321);
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("#322");
  expect(queued()).toEqual([]);
  expect((await post(322)).status).toBe(202);
  expect(queued().map((o) => o[0])).toEqual([322, 322]);
});

test("stage prompt carries grant: the newest ## 回答 given on the screen goes into the next stage Task's prompt; one from GitHub, from a policy or for a check does not", async () => {
  const GRANT = "B: 登録する — 許可: 定期実行 sch_x を POST /api/schedules に登録することだけ許可します";
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 登録するか", "2026-09-28T03:00:00Z"], ["## 回答\n\nGitHub で書いた回答", "2026-09-28T04:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  await refreshed(base);
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const rulesBefore = taskAllowRules("/meta", "/repo");
  // only on GitHub (imported): not the person's words to the Task
  expect(db.listBacklogRecords(source, "comment").some((r) => (r.remote as { body?: string } | null)?.body?.includes("GitHub で書いた回答"))).toBe(true);
  expect(screenAnswer(db, source, 305)).toBeNull();
  // answered on the screen (POST /api/backlog/:n/answer): its text, as written, on the Task it was asked on
  expect((await fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: GRANT, issue: 321 }) })).status).toBe(202);
  const answer = screenAnswer(db, source, 305);
  expect(answer).toEqual({ issue: 321, text: GRANT });
  const prompt = buildStartPrompt({ number: 305 }, "complete", { answer });
  expect(prompt).toContain(`利用者が画面で答えた Issue #321 の最新の回答（利用者の言葉）:\n\n\`\`\`\`text\n${GRANT}\n\`\`\`\``);
  expect(buildStartPrompt({ number: 305 }, "check", { answer })).not.toContain(GRANT);
  // an answer cannot close its fence
  expect(buildStartPrompt({ number: 305 }, "complete", { answer: { issue: 321, text: "a ```` b" } })).toContain("`````text\na ```` b\n`````");
  // the same comment edited on GitHub after it was sent: no longer what the person gave
  const sent = db.listBacklogOperations(source).find((o) => o.kind === "comment" && (o.payload as { screen?: boolean }).screen)!;
  const rec = db.getBacklogRecord({ ...source, objectKind: "comment", externalId: sent.target })!;
  db.sqlite.run("UPDATE backlog_records SET remote = ?, local = NULL, fetch_state = 'fetched' WHERE external_id = ?", [JSON.stringify({ ...(rec.local ?? rec.remote) as object, body: "## 回答\n\nB: 登録する — 許可: 何でも許可します" }), sent.target]);
  expect(screenAnswer(db, source, 305)).toBeNull();
  db.sqlite.run("UPDATE backlog_records SET remote = ?, local = NULL, fetch_state = 'fetched' WHERE external_id = ?", [JSON.stringify({ ...(rec.local ?? rec.remote) as object, body: `## 回答\n\n${GRANT}\n\n<!-- switchboard-op:${sent.id} -->` }), sent.target]);
  // as sent (with its marker): still the screen's answer
  expect(screenAnswer(db, source, 305)).toEqual({ issue: 321, text: GRANT });
  // a saved policy's answer (no screen mark) after it is the newest: nothing goes in
  answerStoredDecision(db, source, 321, "A: 登録しない\n\n方針で回答", Date.now() + 1000);
  expect(screenAnswer(db, source, 305)).toBeNull();
  // nothing saved as a policy, no allow rule added
  expect(((await (await fetch(`${base}/api/policies`)).json()) as { policies: unknown[] }).policies).toEqual([]);
  expect(taskAllowRules("/meta", "/repo")).toEqual(rulesBefore);
});

test("hold: a Task's ## 保留 after its ## 判断待ち gives the PBI heldAt; a ## 判断待ち asked after the hold opens it again", async () => {
  const fake = taskDecisionGh({
    i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"], ["## 保留\n\nCI を見てから", "2026-09-28T04:00:00Z"]])],
    i307: [subTask(330, "OPEN", ["needs-decision"], [["## 保留", "2026-09-28T01:00:00Z"], ["## 判断待ち\n**問い**: y", "2026-09-28T02:00:00Z"]])],
  });
  const items = (await (await fetch(`${await boot(fake.gh)}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 305)).toMatchObject({ stage: "needs-decision", heldAt: "2026-09-28T04:00:00Z", decision: { issue: 321 } });
  expect(items.find((i) => i.number === 307)).toMatchObject({ stage: "needs-decision", heldAt: null });
  expect(items.filter((i) => i.stage !== "needs-decision").every((i) => i.heldAt === null)).toBe(true);
});

test("hold: holding keeps a ## 保留 comment only — the label stays — and the stored read shows the item still asking, held", async () => {
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
  // the needs-decision PBI 306 has a ## 回答 among its comments, but it is not in progress
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
  // refused from the stored copy: nothing written, so nothing is imported either
  await Bun.sleep(50);
  expect(fake.calls.length).toBe(before);
  // GitHub out of reach: the answer is kept all the same
  await core!.stop(); core = undefined;
  rmSync(home!, { recursive: true, force: true });
  const down = { on: false };
  const failing = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await fetch(`${failing}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "x" }) })).status).toBe(202);
  expect(queued()).toHaveLength(2);
});

/** The fixtures' gh, and PBI 308's body on GitHub for `issue view --json body`; `--body-file` is read when it is called. */
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

/* ---------- edits and new Issues kept here, sent later ---------- */

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

/** The Project's field definitions as GitHub answers the send's read of them. */
const PROJECT_DEFS = [
  { id: "F_s", name: "Status", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "Backlog" }, { id: "o2", name: "Ready" }] },
  { id: "F_sp", name: "Story Points", dataType: "NUMBER" },
  { id: "F_d", name: "Due", dataType: "DATE" },
];

test("checkFieldTypes: a value that does not fit its field is a 422; a fitting one and null pass", () => {
  for (const [fields, msg] of [
    [{ "Story Points": "abc" }, /整数だけ/],
    [{ Status: "Done" }, /選択肢 'Done'/],
    [{ Due: "2026/11/04" }, /YYYY-MM-DD/],
    [{ Nope: "x" }, /フィールド 'Nope' が Project にありません/],
  ] as const) {
    let err: unknown;
    try {
      checkFieldTypes(PROJECT_DEFS, fields);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BacklogEditError);
    expect((err as BacklogEditError).status).toBe(422);
    expect((err as Error).message).toMatch(msg);
  }
  expect(() => checkFieldTypes(PROJECT_DEFS, { Status: "Ready", "Story Points": 3, Due: "2026-11-04", Nope: null })).not.toThrow();
  expect(() => checkFieldTypes(PROJECT_DEFS, { "Story Points": "5" })).not.toThrow();
});

test("edit: a field value that does not fit the Project's field is refused before it is stored; GitHub out of reach stores it", async () => {
  const fake = fakeGh();
  const down = { on: false, reads: 0 };
  const base = await boot(async (args, cwd) => {
    if (!args.some((a) => a.includes("ProjectV2FieldCommon{ id name dataType }"))) return fake.gh(args, cwd);
    down.reads++;
    if (down.on) return { code: 1, stdout: "", stderr: "HTTP 503" };
    return { code: 0, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: PROJECT_DEFS } } } } }), stderr: "" };
  });
  const r = await patch(base, 304, { fields: { "Story Points": "abc" } });
  expect(r.status).toBe(422);
  expect(((await r.json()) as { error: string }).error).toMatch(/選択肢 'abc'/)  // the config's choices first; the Project's type is read for what has none;
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
  // an empty passes (Due has no value, so nothing to send for it); a fitting value is stored
  expect((await patch(base, 304, { fields: { "Story Points": 5, Due: null } })).status).toBe(202);
  expect(core!.db.listPendingBacklogOperations().map((o) => o.field)).toEqual(["field:Story Points"]);
  // GitHub not reached: stored, the send checks it last
  down.on = true;
  expect((await patch(base, 304, { fields: { Due: "2026/11/04" } })).status).toBe(202);
  // another repository waited for (a GitLab one): this one's values are still checked
  down.on = false;
  const db = core!.db;
  const lab = { service: "gitlab" as const, host: "gitlab.com", repository: "acme/other", project: { owner: "acme", number: 1 } };
  db.setWorkspaceBacklogSource(db.upsertWorkspace({ id: "ws_lab", name: "lab", path: join(home!, "lab"), kind: "repo" }).id, lab);
  db.sqlite.query("INSERT INTO backlog_repositories (service, host, repository, retry_at) VALUES ('gitlab', 'gitlab.com', 'acme/other', ?)").run(Date.now() + 3_600_000);
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(422);
  // this repository waited for: the definitions are not read at all, the value is stored
  core!.db.sqlite.query("UPDATE backlog_repositories SET retry_at = ? WHERE service = 'github'").run(Date.now() + 3_600_000);
  const before = down.reads;
  expect((await patch(base, 304, { fields: { Status: "Done" } })).status).toBe(202);
  expect(down.reads).toBe(before);
});

test("project fields: the import keeps the Project's writable fields in its order, GET returns them, and an edit is checked against them", async () => {
  const fake = fakeGh();
  const base = await boot(async (args, cwd) => {
    if (!args.some((a) => a.includes("ProjectV2FieldCommon{ id name dataType }"))) return fake.gh(args, cwd);
    return { code: 0, stdout: JSON.stringify({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: PROJECT_DEFS } } } } }), stderr: "" };
  });
  // Title (TITLE) and Sprint (ITERATION) are no field a value is sent to; the order is the Project's
  expect((await detailOf(base, 304)).projectFields).toEqual([
    { name: "Status", dataType: "SINGLE_SELECT", options: ["Backlog", "Ready", "Done"] },
    { name: "Priority", dataType: "SINGLE_SELECT", options: ["P1", "P2"] },
    { name: "Story Points", dataType: "NUMBER", options: [] },
    { name: "Due", dataType: "DATE", options: [] },
  ]);
  for (const fields of [{ "Story Points": "abc" }, { "Story Points": 5.5 }, { Priority: "P9" }, { Nope: "x" }]) expect((await patch(base, 304, { fields })).status).toBe(422);
  expect((await patch(base, 304, { fields: { "Story Points": 5 } })).status).toBe(202);
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
  // an account id of the host's AWS config, written bare
  const bare = await withHostAccount(async (id) => {
    const r = await patch(base, 304, { body: `メモ\n${id}` });
    return { status: r.status, leaks: (await r.text()).includes(id) };
  });
  expect(bare).toEqual({ status: 422, leaks: false });
  // the values that go to GitHub as they are: a Project field, a label, a milestone
  for (const edit of [{ fields: { Note: token } }, { fields: { [token]: "x" } }, { labels: { add: [token] } }, { milestone: token }]) expect((await patch(base, 304, edit)).status).toBe(422);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
});

/* ---------- a choice on a held conflict ---------- */

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
  // it is held, not sent, and what the check keeps is told as it is, with what stays open (the history read after the write)
  expect(d.pending).toBe(2);
  expect(d.limits).toContain("上書きしうる");
  expect(d.limits).toContain("同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません");
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

test("overwritten: a conflict the write found afterwards shows the other's value from the history as remote, not GitHub's; remote sends it back, a gone revision is not readable", async () => {
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

test("limits: what the send cannot keep is named per field — the Project fields without a history, the evicted revision, the same login — and nothing is promised", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const d = await detailOf(base, 304);
  expect(d.limits).toContain("Status 以外の Project フィールド");
  expect(d.limits).toContain("100 版");
  expect(d.limits).toContain("同じ GitHub アカウント");
  expect(d.limits).toContain("消されていれば");
  expect(d.limits).toContain("同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません");
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
  // another workspace whose repository has its own Issue 304, nothing held
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

/* ---------- a failed operation sent again ---------- */

test("retry: a failed set / comment / create goes back to pending; one not failed, of another Issue or another repository is 409 and nothing changes; with an edit 400", async () => {
  const base = await boot(fakeGh().gh);
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  // during a limit: nothing is sent, the operations stay as this test sets them
  db.setBacklogRetryAt(source, Date.now() + 3_600_000);
  expect((await patch(base, 304, { title: "送れなかった題", body: "まだ送る本文", fields: { Priority: "P1" } })).status).toBe(202);
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "送れなかったコメント" }) })).status).toBe(202);
  expect((await patch(base, 305, { title: "別の Issue の題" })).status).toBe(202);
  const created = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: "作れなかった Issue", body: "", labels: [], fields: { Status: "Backlog" } }) });
  const { localId } = (await created.json()) as { localId: string };
  const ops = db.listPendingBacklogOperations(source);
  const of = (pred: (o: (typeof ops)[number]) => boolean) => ops.find(pred)!;
  const title = of((o) => o.field === "title" && o.payload === "送れなかった題");
  const comment = of((o) => o.kind === "comment");
  const other = of((o) => o.field === "title" && o.payload === "別の Issue の題");
  const body = of((o) => o.field === "body");
  const priority = of((o) => o.field?.includes("Priority") ?? false);
  for (const o of [title, comment, other]) db.setBacklogOperationResult(o.id, { status: "failed", attempt: 3, retryAt: 1, error: "HTTP 403: Resource not accessible" });
  db.setBacklogOperationResult(localId, { status: "failed", attempt: 1, error: "HTTP 403: read:project" });
  db.setBacklogOperationResult(priority.id, { status: "unknown", error: "送ったかどうか分からない" });
  const retry = (ref: number | string, operation: string, extra = {}) => patch(base, ref, { retry: { operation }, ...extra });
  const snapshot = () => JSON.stringify(db.listBacklogOperations(source));

  // refused, nothing changed: with an edit, not failed (pending, unknown, sending, conflict, done), another Issue's, no such one
  const before = snapshot();
  expect((await retry(304, title.id, { title: "ついで" })).status).toBe(400);
  expect((await retry(304, body.id)).status).toBe(409);
  expect((await retry(304, priority.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "sending" });
  expect((await retry(304, body.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "conflict", error: "重なった" });
  expect((await retry(304, body.id)).status).toBe(409);
  expect((await retry(304, other.id)).status).toBe(409);
  expect((await retry(304, "no-such-operation")).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "done" });
  expect((await retry(304, body.id)).status).toBe(409);
  db.setBacklogOperationResult(body.id, { status: "pending", error: null });
  expect(JSON.parse(snapshot()).map((o: { id: string; status: string }) => [o.id, o.status])).toEqual(JSON.parse(before).map((o: { id: string; status: string }) => [o.id, o.id === body.id ? "pending" : o.status]));
  // the same number in another repository: another Issue, its failed edit is not this one's
  const ws = db.upsertWorkspace({ id: "ws_tool", name: "tool", path: join(home!, "tool"), kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, { ...source, repository: "acme/tool" });
  const rec = db.listBacklogRecords(source, "issue").find((r) => (r.remote as { number: number } | null)?.number === 304)!;
  db.putBacklogSnapshot({ ...source, repository: "acme/tool" }, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: rec.remote as never, fetchState: "fetched" }], cursor: null, syncedAt: Date.now() });
  expect((await fetch(`${base}/api/backlog/304`, { method: "PATCH", body: JSON.stringify({ workspaceId: ws.id, retry: { operation: title.id } }) })).status).toBe(409);
  expect(db.getBacklogOperation(title.id)).toMatchObject({ status: "failed", attempt: 3 });

  // the failed ones of the Issue go back to pending as at first; the held list no longer has them
  for (const [ref, id] of [[304, title.id], [304, comment.id], [localId, localId]] as const) {
    const r = await retry(ref, id);
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ operation: id });
    expect(db.getBacklogOperation(id)).toMatchObject({ status: "pending", attempt: 0, retryAt: null, error: null });
  }
  expect((await detailOf(base, 304)).held.map((h) => [h.operation, h.status])).toEqual([[priority.id, "unknown"]]);
  expect((await detailOf(base, localId)).held).toEqual([]);
  // sent again already: nothing to retry
  expect((await retry(304, title.id)).status).toBe(409);
  expect(db.getBacklogOperation(other.id)).toMatchObject({ status: "failed", attempt: 3 });
});

test("cancel: a comment inside its send window is taken back (202); again, past the window, or not a comment is 409; with an edit 400", async () => {
  const base = await boot(fakeGh().gh);
  const db = core!.db;
  expect((await fetch(`${base}/api/backlog/304/comment`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "取り消すコメント" }) })).status).toBe(202);
  expect((await patch(base, 304, { title: "コメントでない操作" })).status).toBe(202);
  const ops = db.listPendingBacklogOperations();
  const comment = ops.find((o) => o.kind === "comment")!;
  const title = ops.find((o) => o.field === "title")!;
  const cancel = (operation: string, extra = {}) => patch(base, 304, { cancel: { operation }, ...extra });
  expect((await cancel(comment.id, { title: "ついで" })).status).toBe(400);
  expect((await cancel(title.id)).status).toBe(409);
  const r = await cancel(comment.id);
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ operation: comment.id });
  expect(db.getBacklogOperation(comment.id)).toMatchObject({ status: "done", error: "送る前に取り消しました" });
  expect((await cancel(comment.id)).status).toBe(409);
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

test("send: an answer kept is sent to GitHub once its window has passed; after a restart one that was out is looked for, not posted again", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const posts = () => fake.calls.filter((a) => a[1] === "repos/acme/app/issues/306/comments" && a.includes("POST")).length;
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "すぐ送る" }) })).status).toBe(202);
  // inside its 60 s window nothing is posted; the window over, the next send run posts it
  await Bun.sleep(50);
  expect(posts()).toBe(0);
  core!.db.sqlite.exec("UPDATE backlog_operations SET retry_at = NULL");
  expect((await patch(base, 306, { title: "送りを促す" })).status).toBe(202);
  for (let i = 0; i < 100 && posts() === 0; i++) await Bun.sleep(10);
  expect(posts()).toBe(1);

  // the daemon stops while a post is out; at its start it looks for it and posts nothing
  const h = home!;
  const db = core!.db;
  db.sqlite.exec("DELETE FROM backlog_operations; DELETE FROM backlog_records WHERE remote IS NULL; UPDATE backlog_records SET local = NULL");
  db.setBacklogRetryAt(db.getWorkspaceBacklogSource(metaId())!, Date.now() + 3_600_000);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "送信中に止まった" }) })).status).toBe(202);
  db.sqlite.exec("UPDATE backlog_operations SET retry_at = NULL"); // its window over
  db.setBacklogOperationResult(db.listPendingBacklogOperations()[0]!.id, { status: "sending" });
  db.sqlite.exec("UPDATE backlog_repositories SET retry_at = NULL");
  await core!.stop();
  fake.calls.length = 0;
  const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fake.gh), backlogAutoImport: true });
  const looked = () => fake.calls.some((a) => a[1]?.startsWith("repos/acme/app/issues/306/comments?"));
  for (let i = 0; i < 100 && !looked(); i++) await Bun.sleep(10);
  expect(looked()).toBe(true);
  // the look runs with it `sending` (not taken back meanwhile); this fake cannot answer the list, so it waits unknown
  for (let i = 0; i < 100 && core.db.listPendingBacklogOperations()[0]?.status === "sending"; i++) await Bun.sleep(10);
  expect(posts()).toBe(0);
  expect(core.db.listPendingBacklogOperations()[0]).toMatchObject({ kind: "comment", status: "unknown" });
});

test("an answer during a limit is stored, read by the next start, and sent after the limit", async () => {
  const fake = limitedGh();
  // GitHub's REST answers for Issue 306's comments and labels, as backlog-send.test.ts's fake GitHub gives them
  // and its reads before and after a write (graphql) with no one else's edits
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
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh), backlogAutoImport: true });
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
  // Issue 305 has open Tasks, Issue 304 is Ready: neither can be closed
  for (const n of [305, 304]) expect((await start(base, n, { action: "close" })).status).toBe(409);
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

test("start: close through the API also takes an in-progress PBI whose Tasks are all closed with 利用者確認 left; open Tasks and 利用者確認 together stay 409", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  // the screen's button still needs none left
  const i308 = items.find((i) => i.number === 308)!;
  expect(i308.closable).toBe(false);
  expect(i308.tasks!.done).toBe(i308.tasks!.total);
  const r = await start(base, 308, { action: "close" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title.startsWith("#308 閉じる: ")).toBe(true);
  const mixed = await boot(openTaskAndConfirmationGh().gh, holdingClaude().adapter);
  expect((await start(mixed, 308, { action: "close" })).status).toBe(409);
});

test("start: the resume of a stalled PBI writes a ## 状況 in the 状況確認's form with the tasks-done mark, asks with ## 判断待ち, else goes on with pbi-complete", () => {
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

test("start: a complete prompt says the request covers merges the merge gate passes and closing the PBI", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  const scope = "この依頼は、マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ、リリースタグ、PBI を閉じるところまでを含みます。";
  for (const opts of [{}, { resume: { tasksDone: 1 } }, { other }, { other, resume: { tasksDone: 1 } }]) {
    const p = buildStartPrompt({ number: 305 }, "complete", opts);
    expect(p).toContain(scope);
    expect(p).toContain("マージ判定が `[聞く]` で止めたとき、デーモンを再起動する pull、認証は、これまでどおり Task の会話で聞いてください（.claude/skills/pbi-complete/SKILL.md の「この依頼が含む範囲」）。昇格は");
    expect(p).toContain("昇格はリポジトリの CLAUDE.md の決まりに従い、CLAUDE.md が聞かずに昇格してよいと書いていなければ Task の会話で聞いてください");
    expect(p).not.toContain("昇格・デーモンの再起動");
    expect(p).toContain("「この依頼が含む範囲」");
    expect(p).toContain("レビューの材料");
    expect(p).toContain("要望 Issue と PBI");
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
  number: 1, title: "t", url: "u", type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, answeredAt: null, heldAt: null, confirmations: [], closable: false, onHold: false, flow: false, bodyChars: 0, requestChars: null, labels: [], waits: [], waitsAt: null, waitsUntil: null, overlap: null, prereqs: [], stopSummary: [], mockupTask: null, mockups: [], sync: { state: "synced", reason: null, lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" }, workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});

test("pickNext: Priority (none last), then Ready before 分解待ち before 要望, then the oldest; skips decisions and running items", () => {
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
  // the plan slot: 分解待ち before 要望, never a Ready PBI
  expect(pickNext(items, "plan")).toMatchObject({ item: { number: 2 }, action: "to-tasks" });
  expect(pickNext([items[0]!], "plan")).toMatchObject({ item: { number: 1 }, action: "to-pbi" });
  expect(pickNext([items[0]!], "implement")).toBeNull();
  expect(pickNext(items.slice(5), "implement")).toBeNull();
  expect(pickNext(items.slice(5), "plan")).toBeNull();
});

test("pickNext queue: the queue's order over Priority, only the queued items, a held head gives the next, no order is as before", () => {
  const items = [
    item({ number: 1, stage: "ready", priority: "P0" }),
    item({ number: 2, stage: "ready", priority: "P3" }),
    item({ number: 3, stage: "ready", priority: "P1", waits: [wait(778, "pr", true)] }),
    item({ number: 4, stage: "needs-tasks", priority: "P0" }),
  ];
  expect(pickNext(items, "implement", [2, 1])).toEqual({ item: items[1]!, action: "complete" });
  // a Ready PBI not in the queue is never picked from it
  expect(pickNext(items, "implement", [4])).toBeNull();
  expect(pickNext(items, "implement", [])).toBeNull();
  // the head waits for a PR still open: the second goes
  expect(pickNext(items, "implement", [3, 2, 1])).toMatchObject({ item: { number: 2 } });
  // the plan slot does not follow the queue
  expect(pickNext(items, "plan", [2])).toMatchObject({ item: { number: 4 }, action: "to-tasks" });
  expect(pickNext(items, "implement")).toMatchObject({ item: { number: 1 } });
});

test("pickNext: a request goes to 直行で直す or PBI にする by chooseProcess; one a direct Task ran on is left unless it came back", () => {
  const at = "2026-09-28T00:00:00Z";
  const direct = (status: TaskStatus) => ({ id: "tsk_direct", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "direct" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null });
  const defs = listProcesses();
  const items = [
    item({ number: 1, stage: "request", type: "request", priority: "P0", lastTask: direct("done"), updatedAt: "2026-09-28T01:00:00Z" }),
    item({ number: 2, stage: "request", type: "request", priority: "P0", lastTask: direct("error") }),
    item({ number: 3, stage: "request", type: "request", priority: "P3", bodyChars: 5000 }),
  ];
  // the one a direct Task ran on (done or failed) is not made a PBI; the large one is
  expect(pickNext(items, "plan", undefined, undefined, defs)).toMatchObject({ item: { number: 3 }, action: "to-pbi", reason: expect.stringContaining("auto pipeline") });
  expect(pickNext(items.slice(0, 2), "plan", undefined, undefined, defs)).toBeNull();
  // a small one starts directly, with the reason; without the definitions every request is a PBI にする
  const small = item({ number: 4, stage: "request", type: "request", bodyChars: 100 });
  expect(pickNext([small], "plan", undefined, undefined, defs)).toMatchObject({ action: "direct", reason: expect.stringContaining("auto direct") });
  expect(pickNext([small], "plan")?.action).toBe("to-pbi");
  // brought back by the direct Task: the pipeline takes it, whatever its size
  const back = item({ number: 1, stage: "request", type: "request", bodyChars: 100, labels: ["direct-returned"], lastTask: direct("done") });
  expect(pickNext([back], "plan", undefined, undefined, defs)).toMatchObject({ action: "to-pbi", reason: "direct returned" });
  expect(pickNext([item({ number: 5, stage: "ready" })], "implement", undefined, undefined, defs)?.reason).toBeUndefined();
});

test("buildStartPrompt: to-tasks on a PBI that already has Tasks asks to make it Ready without decomposing again", () => {
  const decomposed = buildStartPrompt({ number: 7, tasks: { total: 2, done: 0, doneAt: null } }, "to-tasks");
  for (const s of ["分解済み", "作り直さず", "最新の `## 回答` を PBI と Task に反映", "受け入れ条件の被覆", "PBI #7 を Ready にしてください"]) expect(decomposed).toContain(s);
  expect(decomposed).not.toContain("Task に分解して Ready にしてください");
  for (const item of [{ number: 7, tasks: { total: 0, done: 0, doneAt: null } }, { number: 7, tasks: null }, { number: 7 }]) {
    const p = buildStartPrompt(item, "to-tasks");
    expect(p).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #7 を Task に分解して Ready にしてください。");
    expect(p).not.toContain("分解済み");
  }
});

/** A fake meta checkout carries the kit's process candidates, as the real one does: a stage start reads `ops-kit/processes/p0-pipeline.md` from the meta workspace. */
function withProcesses(repo: string): void {
  cpSync(join(import.meta.dir, "../../../ops-kit/processes"), join(repo, "ops-kit/processes"), { recursive: true });
}

test("buildStartPrompt: the stage text comes from the p0-pipeline definition — a swapped entry changes the prompt, a missing entry refuses to start", () => {
  const def = loadProcess("p0-pipeline");
  const swapped = { ...def, entries: { ...def.entries, complete: "TEST {{n}} swapped" } };
  expect(buildStartPrompt({ number: 305 }, "complete", {}, swapped).startsWith("TEST 305 swapped\n\n対象: #305。")).toBe(true);
  // the parts the daemon adds around the entry (the answer to read, the scope of the request) stay
  expect(buildStartPrompt({ number: 305 }, "complete", {}, swapped)).toContain("この依頼は、マージ判定");
  expect(buildStartPrompt({ number: 305 }, "check", {}, swapped)).toBe(buildStartPrompt({ number: 305 }, "check"));
  const { complete: _dropped, ...rest } = def.entries;
  expect(() => buildStartPrompt({ number: 305 }, "check", {}, { ...def, entries: rest })).toThrow("lacks entries complete");
  // the tasks-done mark is given only on a resume: an entry that asks for it otherwise does not render a 0
  expect(() => buildStartPrompt({ number: 305 }, "complete", {}, { ...def, entries: { ...def.entries, complete: "X {{tasksDoneMark}}" } })).toThrow("uses {{tasksDoneMark}}, which was not given");
  const bare = parseProcessDef("---\nid: x\nversion: 1\ntitle: X\n---\n## entry complete\nonly\n", "x.md");
  expect(() => buildStartPrompt({ number: 1 }, "complete", {}, bare)).toThrow("lacks entries to-pbi, to-tasks, to-tasks-ready, complete-other, complete-resume, check, close");
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
  // only answered ones: without Issue 4 and Issue 5, Ready is next; the plan slot never takes them
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
  // Issue 305's last stage Task stopped on the question before it was answered
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const titles = core!.db.listTasks().map((t) => t.title);
  expect(titles).toContainEqual(expect.stringMatching(/^#305 実装: /));
  expect(titles.some((t) => t.startsWith("#304 "))).toBe(false); // the implement slot went to Issue 305, before Ready Issue 304
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
  // a wait not read holds it as an open one does: neither taken as unblocked nor started
  const unread = { ...unblocked, number: 7, waits: [...closed, wait(999, "issue", null)] };
  expect(pickNext([unread, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(heldIn([unread], "implement").map((h) => h.item).map((i) => i.number)).toEqual([7]);
});

test("pickNext waiting: a Ready PBI whose waits closed goes before untried Ready, reviewed or not", () => {
  const at = Date.parse("2026-09-28T00:00:00Z");
  const finished = { id: "tsk_last", status: "done" as const, statusAt: at, createdAt: at, updatedAt: at, action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null };
  const closed = [wait(778, "pr", false)];
  const untried = item({ number: 1, stage: "ready", priority: "P0" });
  const lastUpdated = "2026-09-28T01:00:00Z";
  const unreviewed = item({ number: 2, stage: "ready", priority: "P3", waits: closed, waitsAt: STOPPED, lastTask: finished, updatedAt: lastUpdated });
  const reviewed = { ...unreviewed, number: 3, lastTask: { ...finished, reviewedAt: at + 1 } };
  const answered = item({ number: 4, stage: "in-progress", priority: "P3", answeredAt: lastUpdated, lastTask: finished });
  const closable = item({ number: 5, stage: "in-progress", priority: "P3", tasks: { total: 1, done: 1, doneAt: null }, closable: true });
  // no update since the stopped Task: it awaits a reply, and is taken all the same
  const quiet = { ...unreviewed, number: 6, updatedAt: "2026-09-01T00:00:00Z" };
  for (const unblocked of [unreviewed, reviewed, quiet]) {
    expect(pickNext([untried, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
    expect(pickNext([closable, untried, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
    expect(pickNext([unblocked, answered], "implement")).toMatchObject({ item: { number: 4 }, action: "complete" });
  }
});

test("pickNext stalled: an in-progress PBI with every Task closed is closed; one with Tasks left is resumed unless it did not move since its last resume", () => {
  const report = (n: number | null, at = "2026-09-29T00:00:00Z") => ({ body: `## 状況\n### 残り\n- #12${n === null ? "" : `\n${TASKS_DONE_MARK(n)}`}`, at });
  const closable = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true });
  const stalled = item({ number: 2, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } });
  expect(pickNext([closable], "implement")).toEqual({ item: closable, action: "close" });
  expect(pickNext([stalled], "implement")).toEqual({ item: stalled, action: "complete", resume: true });
  expect(pickNext([closable, stalled], "plan")).toBeNull();
  // a confirmation left (not closable) with every Task closed: neither closed nor resumed
  expect(pickNext([{ ...closable, closable: false, confirmations: [{ n: 1, text: "見た目（利用者確認: 画面）", after: null }] }], "implement")).toBeNull();
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
  // a resume that ended (done: a failed one is held by 前回の Task が失敗したまま更新が無い) before writing its mark is left until the Issue, a Task or an answer moves past its start
  const died = { ...stalled, lastTask: { id: "tsk_resume", status: "done" as const, statusAt: Date.parse("2026-09-30T00:00:00Z"), createdAt: Date.parse("2026-09-30T00:00:00Z"), updatedAt: Date.parse("2026-09-30T00:10:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null } };
  expect(pickNext([died], "implement")).toBeNull();
  expect(spinningIn([died], "implement").map((i) => i.number)).toEqual([2]);
  expect(pickNext([{ ...died, updatedAt: "2026-09-30T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true }); // a comment (also: a Ready 実装 that logged its start, then stopped)
  expect(pickNext([{ ...died, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true }); // a Task closed since
  expect(pickNext([{ ...died, answeredAt: "2026-09-30T01:00:00Z" }], "implement")?.item.number).toBe(2); // an answer
  expect(pickNext([{ ...died, tasks: { total: 3, done: 1, doneAt: "2026-09-29T00:00:00Z" } }], "implement")).toBeNull(); // a Task closed before the resume
  expect(pickNext([{ ...died, lastTask: { ...died.lastTask, action: "check" as const } }], "implement")).toMatchObject({ action: "complete", resume: true }); // the last Task was a 状況確認
  // a resume that failed (error) before writing its mark is held by 前回の Task が失敗したまま更新が無い: held until the Issue, an answer or a closed Task is newer than its end
  const failed = { ...died, lastTask: { ...died.lastTask, status: "error" as const } };
  expect(pickNext([failed], "implement")).toBeNull();
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T00:05:00Z" } }], "implement")).toBeNull(); // closed before it ended
  // a Task closing does not answer a question the resume asked the person
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
  // an open wait holds a stalled PBI too
  expect(pickNext([{ ...stalled, waits: [wait(778, "pr", true)] }, ready], "implement")).toMatchObject({ item: { number: 1 } });
});

/** fakeGh with two more requests: Issue 320 large, and Issue 302 (small) brought back by its direct Task when `returned` is set. */
function requestsGh(returned: { on: boolean }) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: Array<{ number: number; body: string; updatedAt: string; labels: { nodes: { name: string }[] } }> } } } };
    const nodes = page.data?.repository?.issues?.nodes;
    if (!nodes) return r;
    const small = nodes.find((n) => n.number === 302);
    if (!small) return r;
    nodes.push({ ...structuredClone(small), number: 320, body: `${small.body}\n${"長い要望。".repeat(300)}`, createdAt: "2026-09-20T03:00:00Z" } as (typeof nodes)[number]);
    if (returned.on) { small.labels.nodes.push({ name: "direct-returned" }); small.updatedAt = "2026-09-30T00:00:00Z"; }
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}

test("backlog-next: each request starts in the candidate its own criteria choose, with the reason; a returned one goes to PBI にする, once; the buttons keep their reasons", async () => {
  const claude = holdingClaude();
  const returned = { on: false };
  const base = await boot(requestsGh(returned).gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  const provenance = async (n: number) => {
    const t = startedTasks().find((x) => x.stage?.issue === n)!;
    return { title: t.title.split(":")[0], ...((await fetch(`${base}/api/tasks/${t.id}/provenance`).then((r) => r.json())) as { process: { id: string }; processReason: string }) };
  };
  const small = await provenance(302);
  const big = await provenance(320);
  expect(small).toMatchObject({ title: "#302 直行で直す", process: { id: "p1-direct" }, processReason: expect.stringMatching(/^auto direct: 本文 \d+ 字 ≤ 600$/) });
  expect(big).toMatchObject({ title: "#320 PBI にする", process: { id: "p0-pipeline" }, processReason: expect.stringMatching(/^auto pipeline: p1-direct: 本文 \d+ 字 > 600$/) });
  expect(small.processReason).not.toBe(big.processReason);
  // the direct Task ends and the request comes back: PBI にする starts with `direct returned`; no second 直行 on it
  core!.db.updateTask(startedTasks().find((x) => x.stage?.issue === 302)!.id, { status: "done" });
  returned.on = true;
  await refreshed(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().filter((x) => x.stage?.issue === 302).map((x) => x.stage!.action).sort()).toEqual(["direct", "to-pbi"]);
  const t2 = startedTasks().find((x) => x.stage?.issue === 302 && x.stage.action === "to-pbi")!;
  expect(await fetch(`${base}/api/tasks/${t2.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline" }, processReason: "direct returned" });
  core!.db.updateTask(t2.id, { status: "done" });
  expect((await runSchedule(base, id)).status).toBe(409); // nothing left to start
  expect(startedTasks().filter((x) => x.stage?.issue === 302 && x.stage.action === "direct")).toHaveLength(1);
});

test("backlog-next: 直行で直す is the meta workspace's only — another repository's small request goes to PBI にする", async () => {
  const claude = holdingClaude();
  const { base, ids } = await threeWorkspaces(claude.adapter, undefined, requestsGh({ on: false }).gh);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  const of = (ws: string) => startedTasks().find((t) => t.workspaceId === ws && t.stage?.issue === 302)!;
  expect(of(ids.switchboard!).stage!.action).toBe("direct");
  for (const ws of [ids.lib!, ids.app!]) {
    const t = of(ws);
    expect(t.stage!.action).toBe("to-pbi");
    expect(await fetch(`${base}/api/tasks/${t.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline" }, processReason: "auto pipeline: 自動の基準を持つ候補なし" });
  }
});

test("backlog-next: unreadable candidate definitions start no request, and say why; other stages go on", async () => {
  const claude = holdingClaude();
  const base = await boot(requestsGh({ on: false }).gh, claude.adapter);
  // the meta checkout with a broken p1-direct.md (the real p0-pipeline.md beside it)
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const root = mkdtempSync(join(home!, "meta-"));
  mkdirSync(join(root, "ops-kit/processes"), { recursive: true });
  copyFileSync(join(meta.path, "ops-kit/processes/p0-pipeline.md"), join(root, "ops-kit/processes/p0-pipeline.md"));
  writeFileSync(join(root, "ops-kit/processes/p1-direct.md"), "---\nid: p1-direct\nauto: 600\n---\n");
  core!.db.sqlite.query("UPDATE workspaces SET path = ? WHERE id = ?").run(root, meta.id);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 302 || t.stage?.issue === 320)).toEqual([]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#302 を始めない: 候補の定義を読めません"));
});

test("start: the buttons record their own reason, not the criteria's", async () => {
  const base = await boot(requestsGh({ on: false }).gh, holdingClaude().adapter);
  const d = (await (await start(base, 302, { action: "direct" })).json()) as Task;
  const p = (await (await start(base, 320, { action: "to-pbi" })).json()) as Task;
  expect(await fetch(`${base}/api/tasks/${d.id}/provenance`).then((r) => r.json())).toMatchObject({ processReason: "direct button" });
  expect(await fetch(`${base}/api/tasks/${p.id}/provenance`).then((r) => r.json())).toMatchObject({ processReason: "backlog stage to-pbi" });
});

test("backlog-next stalled: the closable Issue 307 is closed and Issue 305, unmoved since its last resume, is left and logged", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "OPEN", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  // implement 2: one firing would take both if both could go
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#307 閉じる"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前回の再開から進んでいない: #305`));
  expect(log).toContainEqual(expect.stringContaining("#307 を close で開始"));
});

test("backlog-next stalled: Issue 305 with a Task closed since its last resume is resumed with 実装 before Ready", async () => {
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

test("backlog-next stalled: Issue 305 whose last resume ended before writing a mark is left and logged until a Task closes", async () => {
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

test("backlog-next stalled: Issue 305 with a Task closed after its unmarked resume began is resumed", async () => {
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
  // both closed: Issue 307 (in progress) goes before Ready Issue 304
  states.w603.state = "CLOSED";
  states.w778.state = "MERGED";
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#307 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#307 を complete で開始"));
});

describe("resume when waits clear", () => {
  /** Issue 307 (in progress) waits on PR 778, open; a backlog-next schedule is saved (enabled). */
  async function waitingOn778() {
    const claude = holdingClaude();
    const states: Record<string, Record<string, unknown>> = { w778: { __typename: "PullRequest", state: "OPEN" } };
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states);
    const base = await boot(fake.gh, claude.adapter);
    const id = await backlogNextSchedule(base);
    return { claude, states, base, id, waitsCalls: fake.waitsCalls };
  }
  const implementing307 = () => core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "));
  /** Until `f` holds or `ms` passed: what an import sets off runs after the import's answer. */
  const until = async (f: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !f() && Date.now() < end; ) await Bun.sleep(10);
  };
  /** An import that reads the PR merged, and time for what it sets off. */
  const merge778 = async (base: string, states: Record<string, Record<string, unknown>>) => {
    states.w778 = { ...states.w778, state: "MERGED" };
    await refreshed(base);
    await Bun.sleep(300);
  };

  test("resume when waits clear: an import that reads the waited PR merged starts 実装 on the PBI, before the next firing", async () => {
    const { claude, states, base, id, waitsCalls } = await waitingOn778();
    const before = core!.db.getSchedule(id)!;
    states.w778 = { ...states.w778, state: "MERGED" };
    const reads = waitsCalls.length;
    await refreshed(base);
    await until(() => claude.starts.length > 0);
    expect(claude.starts).toHaveLength(1);
    // the import that cleared the waits and the read right before the start: the narrow firing does not read once more first
    expect(waitsCalls.length - reads).toBe(2);
    // that PBI only, in the implement slot: Ready Issue 304 and Issue 303 (the plan slot) wait for the firing
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#307 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/#307 を complete で開始 \S+ \(待ちが解けた\)$/));
    // the schedule's times stay: the next firing comes when it was due
    expect(core!.db.getSchedule(id)).toMatchObject({ lastRunAt: before.lastRunAt, nextRunAt: before.nextRunAt, lastTaskId: implementing307()[0]!.id });
  });

  test("resume when waits clear respects slots: a full implement slot, a high usage, a disabled schedule start nothing; two imports start one", async () => {
    // the implement slot is full: the firing started Ready Issue 304 (and Issue 303 in the plan slot) while Issue 778 was open
    {
      const { claude, states, base, id } = await waitingOn778();
      expect((await runSchedule(base, id)).status).toBe(201);
      const firing = claude.starts.length;
      await merge778(base, states);
      expect(claude.starts).toHaveLength(firing);
      expect(implementing307()).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // usage at backlogQuotaLimit or more and a stage Task running: one at a time, though the slot has room
    {
      const { claude, states, base, id } = await waitingOn778();
      core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600); // over the backlog limit, under fallbackAt (at it the start is held)
      await sweepAll(base, { implement: 2, plan: 0 });
      expect((await runSchedule(base, id)).status).toBe(201);
      expect(claude.starts).toHaveLength(1);
      await merge778(base, states);
      expect(claude.starts).toHaveLength(1);
      expect(implementing307()).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // backlog-next disabled
    {
      const { claude, states, base, id } = await waitingOn778();
      expect((await fetch(`${base}/api/schedules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
      await merge778(base, states);
      expect(claude.starts).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // two imports that each store a change: the second sees the stage Task running and starts no other
    {
      const { claude, states, base } = await waitingOn778();
      await merge778(base, states);
      // the second import stores a change too (a PR opened: what calls the resume)
      openPulls = [{ number: 900, files: [] }];
      await refreshed(base);
      await Bun.sleep(300);
      expect(core!.db.listBacklogRecords(core!.db.getWorkspaceBacklogSource(metaId())!, "pull-request").some((r) => (r.remote as { number?: number }).number === 900)).toBe(true);
      expect(claude.starts).toHaveLength(1);
      expect(implementing307()).toHaveLength(1);
    }
  });
});

test("backlog-next waiting: a wait GitHub did not find is not taken as closed, and the log says it was not read", async () => {
  const claude = holdingClaude();
  const states = { w603: { __typename: "Issue", state: "CLOSED" }, w999: null };
  const fake = waitsGh({ i307: [[releaseBody("後回し", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#307 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められない: #307（#999 見つからない）`));
});

test("backlog-next waiting: resumes a Ready PBI with a free Task", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const task = (number: number, file: string) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: `触る場所: \`${file}\``, comments: { nodes: [] } });
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [task(3041, "src/a.ts"), task(3042, "src/b.ts")] } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(gh, claude.adapter);
  expect(await waitsOfItem(base, 304)).toMatchObject({ stage: "ready", overlap: null, waits: [{ number: 778, state: "met" }] });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#304 を complete で開始"));
});

test("backlog-next waiting: a 状況確認 started after the waits were written leaves them; once they closed the next firing starts 実装", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  // the row's 状況を確認 only reads and reports: it does not claim, and the waits stand
  core!.db.insertTask({ id: "tsk_check", workspaceId: metaId(), title: "#307 状況確認: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 状況確認: PBI: 実装中の PBI"), statusAt: Date.parse(LATER), createdAt: Date.parse(LATER), updatedAt: Date.now() });
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [{ number: 778, open: false }], waitsAt: STOPPED });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#307 実装");
});

test("backlog-next waiting: a 状況確認 after an 実装 that made the waits old does not bring them back", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const task = (id: string, title: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title, runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: at, createdAt: at, updatedAt: Date.now() });
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
  const task = (id: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title: "#307 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 実装: PBI: 実装中の PBI"), statusAt: at, createdAt: at, updatedAt: Date.now() });
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

describe("backlog-next prerequisite", () => {
  type Pbi = { status?: string; priority: string; body?: string; comments?: Array<[string, string]>; tasks?: Array<{ number: number; state: string; body?: string }> };
  /**
   * A GitHub of Ready PBIs (`pbis`, by number) and what they name (`others`: the answers to the import's recheck, by
   * `w<n>`; a number not there is NOT_FOUND), in the shape the fixtures' gh answers (`importing` reads it).
   */
  function prereqGh(pbis: Record<number, Pbi>, others: Record<string, unknown> = {}) {
    const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    const gh: GhRunner = async (args) => {
      if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
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
  const slots = (base: string, implement: number) => sweepAll(base, { implement, plan: 0 });
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
    await fetch(`${base}/api/backlog?refresh=1`); // this GitHub lists open Issues only: a light import would not see it close
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
    core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh), backlogAutoImport: true });
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
    withProcesses(repo);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "running");
    const running = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "the prerequisite (#450)");
    const merged = git("rev-parse", "HEAD");
    let current = running;
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/status" ? Response.json({ current, previous: null, state: "running", busy: null, lastError: null, history: [] }) : new Response("no", { status: 404 })) });
    // Issue 451's merge commit is not in this checkout: git cannot tell, which is not "not released"
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

  test("GET /api/backlog reads each workspace's stored records once when the release's answers are known", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
    withProcesses(repo);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "running");
    git("commit", "-q", "--allow-empty", "-m", "the prerequisite (#450)");
    const merged = git("rev-parse", "HEAD");
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/status" ? Response.json({ current: merged, previous: null, state: "running", busy: null, lastError: null, history: [] }) : new Response("no", { status: 404 })) });
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #450（リリース）" } }, { w450: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: merged } } });
    try {
      const base = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
      const source = core!.db.getWorkspaceBacklogSource(metaId())!;
      const issueReads = () => spy.mock.calls.filter(([s, kind]) => kind === "issue" && s.repository === source.repository).length;
      const get = async () => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === 401)!;
      const original = core!.db.listBacklogRecords.bind(core!.db);
      const spy = spyOn(core!.db, "listBacklogRecords").mockImplementation(original);
      const first = await get(); // the merge commit's answer is asked of git and kept
      expect(first.prereqs).toEqual([{ number: 450, kind: "pr", need: "release", state: "met", via: null }]);
      const reads = issueReads();
      await get();
      // the answer is known now: no read to find what to ask. 3 = the one full read + the two the stage Tasks' rows (withActive) make; a read to find what to ask made it 4
      expect(issueReads() - reads).toBe(3);
      spy.mockRestore();
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

  test("a PBI waiting only on a Draft PR's overlap goes on, while one with a prerequisite not done does not", async () => {
    const pbis: Record<number, Pbi> = {
      407: { priority: "P1", comments: [[releaseBody("後回し", [460], true), STOPPED]] },
      408: { priority: "P0", body: "**前提**: #409" }, 409: { status: "Backlog", priority: "P3" },
    };
    const base = await boot(prereqGh(pbis, { w460: { __typename: "PullRequest", state: "OPEN", isDraft: true } }), holdingClaude().adapter);
    await slots(base, 1); // Issue 409 is not Ready: the plan slot would take it
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#407 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #408（#409 未完）`));
  });
});

test("pickNext unchanged: an item whose last stage Task of the same stage finished with no update since is left; one updated since goes after the untried of its Priority", () => {
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
  // 3: updated since → picked, before the untried of a lower Priority and after the untried of its own; alone it goes on
  const updatedReady = { ...unchangedReady, updatedAt: updated };
  expect(pickNext([updatedReady, freshReady], "implement")).toMatchObject({ item: { number: 1 } });
  expect(pickNext([updatedReady, { ...freshReady, priority: "P0" }], "implement")).toMatchObject({ item: { number: 2 } });
  expect(pickNext([updatedReady], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  expect(pickNext([{ ...unchangedTasks, updatedAt: updated }, freshRequest], "plan")).toMatchObject({ item: { number: 3 } });
  expect(pickNext([{ ...unchangedTasks, updatedAt: updated }, { ...freshRequest, priority: "P0" }], "plan")).toMatchObject({ item: { number: 5 } });
  // an answered in-progress PBI stays first
  const answered = item({ number: 7, stage: "in-progress", priority: "P3", answeredAt: updated, updatedAt: updated, lastTask: last("complete") });
  expect(pickNext([updatedReady, freshReady, answered], "implement")).toMatchObject({ item: { number: 7 }, action: "complete" });
});

test("pickNext priority: a Ready P0 worked on before goes before an untried Ready P3; a resume or a close of an in-progress PBI still goes first", () => {
  const at = "2026-09-28T00:00:00Z";
  const done = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null };
  const triedP0 = item({ number: 1, stage: "ready", priority: "P0", lastTask: done, updatedAt: "2026-09-28T01:00:00Z" });
  const freshP3 = item({ number: 2, stage: "ready", priority: "P3" });
  expect(pickNext([freshP3, triedP0], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  // a stalled in-progress PBI (resumed) and a closable one go before the P0 Ready, whatever their Priority
  const stalled = item({ number: 3, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at });
  const closable = item({ number: 4, stage: "in-progress", priority: "P3", tasks: { total: 2, done: 2, doneAt: null }, closable: true, updatedAt: at });
  expect(pickNext([freshP3, triedP0, stalled], "implement")).toMatchObject({ item: { number: 3 }, action: "complete", resume: true });
  expect(pickNext([freshP3, triedP0, stalled, closable], "implement")).toMatchObject({ item: { number: 4 }, action: "close" });
  // within one Priority: not yet worked on first, then the oldest
  const triedP2 = { ...triedP0, number: 5, priority: "P2", createdAt: "2026-01-01T00:00:00Z" };
  const freshP2New = item({ number: 6, stage: "ready", priority: "P2", createdAt: "2026-09-02T00:00:00Z" });
  const freshP2Old = item({ number: 7, stage: "ready", priority: "P2", createdAt: "2026-09-01T00:00:00Z" });
  expect(pickNext([triedP2, freshP2New], "implement")).toMatchObject({ item: { number: 6 } });
  expect(pickNext([triedP2, freshP2New, freshP2Old], "implement")).toMatchObject({ item: { number: 7 } });
});

test("pickNext priority: the plan slot takes a 分解待ち PBI by Priority, before a request with none", () => {
  const at = "2026-09-28T00:00:00Z";
  const done = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "to-tasks" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null };
  const triedP1 = item({ number: 1, stage: "needs-tasks", priority: "P1", lastTask: done, updatedAt: "2026-09-28T01:00:00Z", createdAt: "2026-09-02T00:00:00Z" });
  const freshRequest = item({ number: 2, stage: "request", type: "request", priority: null, createdAt: "2026-09-01T00:00:00Z" });
  expect(pickNext([freshRequest, triedP1], "plan")).toMatchObject({ item: { number: 1 }, action: "to-tasks" });
  // the same Priority (none): 分解待ち before 要望
  expect(pickNext([freshRequest, { ...triedP1, lastTask: null, priority: null }], "plan")).toMatchObject({ item: { number: 1 } });
});

test("pickNext failed: an item whose last stage Task failed with no update to the Issue since is left in any stage; an update, a reply's resume or a closed wait brings it back", () => {
  const at = "2026-09-28T00:00:00Z";
  const failed = (status: TaskStatus = "error", resumeAt: number | null = null) => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "failed" as const, reviewedAt: null, resumeAt });
  // an in-progress PBI with Tasks left: resumed unless its last Task failed and the Issue was not updated since — the usage-limit case (resumeAt set) and an aborted one alike
  const stalled = item({ number: 1, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at });
  expect(pickNext([stalled], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed("error", Date.parse("2026-09-30T11:01:00Z")) }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, lastTask: failed("aborted") }], "implement")).toBeNull();
  // the Issue updated after it (a comment, a ## 回答) → resumed; an Issue updated at the very time is not newer
  expect(pickNext([{ ...stalled, lastTask: failed(), updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z", updatedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  // a closable one is held the same way; its waits closing still goes on
  const closable = item({ number: 2, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, updatedAt: at, lastTask: failed() });
  expect(pickNext([closable], "implement")).toBeNull();
  expect(pickNext([{ ...closable, waits: [wait(778, "pr", false)], waitsAt: at }], "implement")).toMatchObject({ item: { number: 2 } });
  // a Ready item too (as 前回から更新が無い already does), and the plan slot's stages
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

test("pickNext awaiting reply: an item whose last stage Task ended asking the person (needs_action, not reviewed) is left until the Issue is updated or the Task reviewed", () => {
  const at = "2026-09-28T00:00:00Z";
  const asked = (over: Partial<NonNullable<BacklogItem["lastTask"]>> = {}) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, ...over });
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
  // listed for the log by slot, apart from the failed ones (前回から更新が無い still lists the Ready one; the firing filters it)
  expect(replyWaitingIn([stalled, ready, request], "implement").map((i) => i.number)).toEqual([1, 2]);
  expect(replyWaitingIn([stalled, ready, request], "plan").map((i) => i.number)).toEqual([3]);
  expect(failedIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement")).toEqual([]);
  expect(replyWaitingIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement").map((i) => i.number)).toEqual([1]);
  expect(replyWaitingIn([{ ...stalled, activeTaskId: "tsk_run" }, { ...ready, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  // a ## 回答 on a child Task (answeredAt newer, the parent's updatedAt not): answered, so resumed first — not listed as awaiting
  const childAnswered = { ...stalled, answeredAt: "2026-09-28T01:00:00Z" };
  expect(pickNext([childAnswered], "implement")).toMatchObject({ action: "complete" });
  expect(replyWaitingIn([childAnswered], "implement")).toEqual([]);
  // reviewed releases a Ready item and a closable one too, which 前回から更新が無い / 前回の再開から進んでいない would otherwise hold until the Issue changes
  const reviewed = asked({ reviewedAt: Date.parse("2026-09-28T02:00:00Z") });
  expect(pickNext([{ ...ready, lastTask: reviewed }], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  expect(unchangedIn([{ ...ready, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([item({ number: 4, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, updatedAt: at, lastTask: { ...reviewed, action: "close" } })], "implement")).toMatchObject({ action: "close" });
  // a stalled PBI held by 前回の再開から進んでいない (its last resume's tasks-done mark matches): reviewed releases it as well; a done resume reviewed does not
  const spun = { ...stalled, report: { body: `## 状況\n### 残り\n- #12\n${TASKS_DONE_MARK(1)}`, at: "2026-09-27T23:00:00Z" } };
  expect(pickNext([spun], "implement")).toBeNull();
  expect(pickNext([{ ...spun, lastTask: reviewed }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(spinningIn([{ ...spun, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([{ ...spun, lastTask: asked({ outcome: "done", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toBeNull();
  // one that ended done (nothing asked) and was marked reviewed is still 前回から更新が無い
  expect(pickNext([{ ...ready, lastTask: asked({ outcome: "done", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toBeNull();
});

describe("on-hold", () => {
  const at = "2026-09-20T00:00:00Z";
  const answered = { answeredAt: at, tasks: { total: 3, done: 1, doneAt: null } };
  const held: Array<[string, "implement" | "plan", Partial<BacklogItem>]> = [
    ["Ready", "implement", { stage: "ready" }],
    ["閉じられる実装中", "implement", { stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true }],
    ["止まった実装中", "implement", { stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } }],
    ["回答済みの実装中", "implement", { stage: "in-progress", ...answered }],
    ["分解待ち", "plan", { stage: "needs-tasks" }],
    ["要望", "plan", { stage: "request", type: "request" }],
  ];

  test.each(held)("%s: pickNext takes the one without the label; on-hold alone is null; off the label it is taken again", (_, slot, over) => {
    const onHold = item({ number: 1, priority: "P0", onHold: true, ...over });
    const plain = item({ number: 2, priority: "P3", stage: slot === "implement" ? "ready" : "needs-tasks" });
    expect(pickNext([onHold, plain], slot)).toMatchObject({ item: { number: 2 } });
    expect(pickNext([onHold], slot)).toBeNull();
    expect(onHoldIn([onHold, plain], slot).map((i) => i.number)).toEqual([1]);
    expect(pickNext([{ ...onHold, onHold: false }, plain], slot)).toMatchObject({ item: { number: 1 } });
  });

  test("a firing logs 保留: #N on that line only, starts the next item, and the row's button still starts it", async () => {
    // Issue 304 (Ready) also had an 実装 finish with no update since, which alone would log it as 前回から更新が無い
    const base = await boot(onHoldGh(304, 303).gh, holdingClaude().adapter);
    const now = Date.now();
    core!.db.insertTask({ id: "tsk_last304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#304 実装: PBI: Ready の PBI"), statusAt: now, createdAt: now, updatedAt: now });
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    const titles = startedTasks().map((t) => t.title);
    expect(titles.filter((t) => t.startsWith("#304 ") || t.startsWith("#303 "))).toEqual(["#304 実装: PBI: Ready の PBI"]); // only the inserted one
    const log = await scheduleLogAll(base);
    expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 保留: #304`));
    expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 計画の枠: 保留: #303`));
    expect(log.filter((l) => l.includes("#304"))).toHaveLength(1);
    const r = await start(base, 304, { action: "complete" });
    expect(r.status).toBe(201);
    expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
  });
});

test("backlog-next failed / awaiting reply: a firing leaves a PBI whose last Task failed on the usage limit or stopped asking, and the log names each with the resume time", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  const now = Date.now();
  const resumeAt = now + 3_600_000;
  const row = { workspaceId: metaId(), runner: "claude" as const, cwd: home!, scope: [home!], runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto" as const, effort: null, origin: "switchboard" as const, shadowOf: null, shadowStopped: false, workspaceReason: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now };
  // Issue 307 (closable, in progress): its 閉じる hit the weekly limit at once, auto-resume planned; Issue 304 (Ready): its 実装 ended asking the person in its conversation
  core!.db.insertTask({ ...row, id: "tsk_limit307", title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", stage: { issue: 307, action: "close" }, status: "error", resumeAt, resumeReason: "limit", resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, outcome: "failed", reviewedAt: null, archivedAt: null });
  core!.db.insertTask({ ...row, id: "tsk_ask304", title: "#304 実装: PBI: Ready の PBI", stage: { issue: 304, action: "complete" }, status: "done", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, outcome: "needs_action", reviewedAt: null, archivedAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#307 閉じる"]); // only the two inserted ones
  // a stopped Task with its resume planned takes no slot (slot does not count a resume): the firing names it as failed
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
  // Issue 304 (updated 2026-09-20) had an 実装 that finished after that
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#304 実装: PBI: Ready の PBI"), statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]); // only the old Issue 304 実装
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 前回から更新が無い: #304 #307`)); // Issue 307: closeTried's 閉じる
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // the row's button is not held by it
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
});

describe("backlog waitsUntil", () => {
  const AT = "2026-11-20T09:00:00+09:00";
  const T = Date.parse(AT);
  /** The item Issue 307 (in progress) as the daemon builds it at `now`; time is set only while the backlog is built. */
  const at = async (base: string, now: number) => {
    setSystemTime(new Date(now));
    try { return await waitsOfItem(base, 307); } finally { setSystemTime(); }
  };

  test("a release with only after= waits: before the date it is a wait, at the date and after it is a resumption target", async () => {
    const fake = waitsGh({ i307: [[releaseBody("期日待ち", [], false, AT), STOPPED]] });
    const base = await boot(fake.gh);
    const before = await at(base, T - 1);
    expect(before).toMatchObject({ waits: [], waitsAt: STOPPED, waitsUntil: { at: AT, met: false } });
    expect(pickNext([before], "implement")).toBeNull();
    expect(isUnblocked(before)).toBe(false);
    expect(heldIn([before], "implement")).toHaveLength(1);
    for (const now of [T, T + 1]) {
      const due = await at(base, now);
      expect(due.waitsUntil).toEqual({ at: AT, met: true });
      expect(isUnblocked(due)).toBe(true);
      expect(heldIn([due], "implement")).toHaveLength(0);
    }
  });

  test("waits= with after=: it resumes only once both are done", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN" } };
    const fake = waitsGh({ i307: [[releaseBody("両方待ち", [603], false, AT), STOPPED]] }, states);
    const base = await boot(fake.gh);
    expect(isUnblocked(await at(base, T - 1))).toBe(false);
    const after = await at(base, T + 1);
    expect(after.waitsUntil!.met).toBe(true);
    expect(after.waits).toEqual([wait(603, "issue", true)]);
    expect(isUnblocked(after)).toBe(false);
    states.w603.state = "CLOSED";
    const both = (await (async () => { setSystemTime(new Date(T + 1)); try { return await refreshed(base); } finally { setSystemTime(); } })()).items.find((i) => i.number === 307)!;
    expect(isUnblocked(both)).toBe(true);
  });

  test("a date that is no time with a zone is no wait; a later release without it clears it", () => {
    const c = (body: string) => [{ body, createdAt: STOPPED }];
    expect(waitsOf(c("<!-- pbi-complete:release after=2026-11-20T09:00:00 -->"))).toBeNull();
    expect(waitsOf(c("<!-- pbi-complete:release after=あした -->"))).toBeNull();
    expect(waitsOf(c(releaseBody("x", [], false, AT)))).toEqual({ numbers: [], at: STOPPED, overlap: false, after: AT });
    expect(waitsOf(c(releaseBody("x", [5], true, AT)))).toEqual({ numbers: [5], at: STOPPED, overlap: true, after: AT });
    expect(waitsOf([...c(releaseBody("x", [], false, AT)), { body: releaseBody("完了"), createdAt: LATER }])).toBeNull();
  });

  test("withOverlap: an In progress Task of a PBI that waits for a date is not the other work; once the date has passed it is", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.t4618."));
    mkdirSync(join(root, "src"));
    try {
      const now = new Date().toISOString();
      const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
      const issues = new Map([
        [1, issue(1, ["type:pbi"], null, [11], "")],
        [11, issue(11, ["type:task"], 1, [], "触る場所: `src/a.ts`")],
        [2, issue(2, ["type:pbi"], null, [22], "")],
        [22, issue(22, ["type:task"], 2, [], "触る場所: `src/a.ts`")],
      ]);
      const statuses = new Map<number, string | number | null>([[22, "In progress"]]);
      const run = (until: BacklogItem["waitsUntil"]) => {
        const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress", waitsAt: STOPPED, waitsUntil: until })];
        withOverlap(items, issues, new Map(), [], statuses, root);
        return items[0]!.overlap;
      };
      expect(run({ at: AT, met: true })).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts" }], unknown: null });
      expect(run(null)).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts" }], unknown: null });
      expect(run({ at: AT, met: false })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("withOverlap: another PBI's Task with a ready PR is judged by the PR's files; a glob or a command in its body is not a path", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.overlap-pr."));
    mkdirSync(join(root, "src"));
    try {
      const now = new Date().toISOString();
      const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
      const issues = new Map([
        [1, issue(1, ["type:pbi"], null, [11], "")],
        [11, issue(11, ["type:task"], 1, [], "触る場所: `src/a.ts`、`src/b.ts`")],
        [2, issue(2, ["type:pbi"], null, [22, 23], "")],
        [22, issue(22, ["type:task"], 2, [], "触る場所: `src/a.ts`、`src/c.ts`")],
        [23, issue(23, ["type:task"], 2, [], "触る場所: `src/d.ts`。探し方: `grep -n x src/*.ts`、確認: `bun test src/b.ts`")],
      ]);
      const statuses = new Map<number, string | number | null>([[22, "In progress"], [23, "In progress"]]);
      const pr = (isDraft: boolean) => ({ number: 90, isDraft, labels: [], closes: [22], updatedAt: now, files: ["src/c.ts"], state: "OPEN" });
      const run = (isDraft: boolean) => {
        const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
        withOverlap(items, issues, new Map(), [pr(isDraft)], statuses, root);
        return items[0]!.overlap;
      };
      expect(run(false)).toBeNull();
      expect(run(true)).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts" }], unknown: null });
      // a ready PR and a stacked Draft: the body still holds what the Draft carries
      const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(items, issues, new Map(), [pr(false), { ...pr(true), number: 91 }], statuses, root);
      expect(items[0]!.overlap).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts" }], unknown: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("backlog-next overlap: a Ready PBI whose Task names a file an open PR changes is not started and the log names the PR; once it closes the next firing starts it; nothing is written to GitHub", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({}, {}, undefined);
  const withTask: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    const q = args.find((a) => a.startsWith("query="));
    if (!q?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [3041, 3042].map((number) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: "触る場所: `src/a.ts`", comments: { nodes: [] } })) } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  const writes: string[][] = [];
  const calls: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args.find((a) => a.startsWith("query=")) ?? args.join(" "));
    if (args[0] === "issue" || args.includes("POST") || args.includes("PATCH")) writes.push(args);
    return withTask(args, cwd);
  };
  // Issue 901's files are cut (120 of 100 read): it cannot be judged, and the log says so next to the PR that overlaps
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
  // the PR closes: the next import reads it and Issue 304 is picked again (the implement slot is Issue 307's 閉じる meanwhile)
  openPulls = [];
  await fetch(`${base}/api/backlog?refresh=1`);
  const ready = (await refreshed(base)).items.find((i) => i.number === 304)!;
  expect(ready.overlap).toBeNull();
  expect(pickNext([ready], "implement")).toMatchObject({ item: { number: 304 }, action: "complete" });
});

/** waitsGh whose Ready PBI 304 has one open Task per file given. */
function tasksOf304Gh(...files: string[]): GhRunner {
  const fake = waitsGh({}, {});
  return async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: files.map((f, n) => ({ number: 3041 + n, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: `触る場所: \`${f}\``, comments: { nodes: [] } })) } };
    return { ...r, stdout: JSON.stringify(body) };
  };
}

test("start overlap: the row's 実装 of a Ready PBI whose Task names a file an open PR changes is 409 with the log's reason and starts no Task; to-tasks and a PBI with no overlap start", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/a.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap).toEqual({ hits: [{ ref: "PR #900", path: "src/a.ts" }], unknown: null });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  const { error } = (await r.json()) as { error: string };
  expect(error.startsWith("重なり: #304（")).toBe(true);
  expect(error).toContain("PR #900: src/a.ts");
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  // the other stages are not the overlap's: to-tasks starts
  expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
  // no overlap: another PBI's 実装 starts
  openPulls = [];
  await fetch(`${base}/api/backlog?refresh=1`);
  expect((await refreshed(base)).items.find((i) => i.number === 304)!.overlap).toBeNull();
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
});

test("start overlap: a PBI with one Task that can start (a file no open PR changes) starts from the row even while another Task's file overlaps", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/b.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap).toBeNull();
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
});

test("start overlap: a PBI whose 実装 already runs answers 409 with that Task's id (the row opens it), not the overlap refusal", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/a.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap?.hits).toEqual([{ ref: "PR #900", path: "src/a.ts" }]);
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_run304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 304, action: "complete" }, statusAt: now, createdAt: now, updatedAt: now });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({ taskId: "tsk_run304" });
});

/** moreReadyGh(309, 310) whose Ready PBIs 304 / Issue 309 / Issue 310 each have one open Task naming the file given. */
function overlapReadyGh(files: { 304: string; 309: string; 310: string }, bodies: Partial<Record<304 | 309 | 310, string>> = {}): GhRunner {
  const inner = moreReadyGh(309, 310);
  const task = (number: number, file: string) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: bodies[Math.floor(number / 10) as 304 | 309 | 310] ?? `触る場所: \`${file}\``, comments: { nodes: [] } });
  return async (args, cwd) => {
    const r = await inner(args, cwd);
    if (r.stdout.includes('"subIssuesSummary"')) {
      // each PBI has just the one Task named below (no made-up free Task beside it)
      const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; subIssuesSummary: { total: number; completed: number } }[] } } } };
      for (const node of page.data?.repository?.issues?.nodes ?? []) if ([304, 309, 310].includes(node.number)) node.subIssuesSummary = { total: 1, completed: 0 };
      return { ...r, stdout: JSON.stringify(page) };
    }
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    for (const [pbi, file] of [[304, files[304]], [309, files[309]], [310, files[310]]] as const) body.data.repository[`i${pbi}`] = { ...body.data.repository[`i${pbi}`], subIssues: { nodes: [task(pbi * 10 + 1, file)] } };
    return { ...r, stdout: JSON.stringify(body) };
  };
}

test("backlog-next overlap: in one firing of implement 2, a Ready PBI whose Task names the path of the PBI started before it is not started, and the log names that Task and the path; the one with another path is", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#310 実装"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なり: #309（Task #3041: src/a.ts）`));
  expect(log.filter((l) => l.includes("実装の枠: 重なり: "))).toHaveLength(1);
});

test("backlog-next overlap: Ready PBIs whose Tasks name different paths all start in one firing", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]); // implement 2: two places
  expect((await scheduleLogAll(base)).some((l) => l.includes("重なり"))).toBe(false);
});

test("backlog-next overlap: a Task that only refers to a root file in the middle of a step does not hold back the PBI that touches it", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }, { 304: "1. 昇格は CLAUDE.md の規則に従う。`CLAUDE.md` も読む", 309: "触る場所: CLAUDE.md" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect((await scheduleLogAll(base)).some((l) => l.includes("重なり"))).toBe(false);
});

test("backlog-next overlap: a Task that names a root file at the head of a step holds back the PBI that touches it, and the log names the file", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }, { 304: "1. CLAUDE.md: 追記する", 309: "触る場所: CLAUDE.md" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#310 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("実装の枠: 重なり: #309（Task #3041: CLAUDE.md）"));
});

async function backlogNextSchedule(base: string, budgetUsd?: number, model?: string, effort?: string) {
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next", budgetUsd, model, effort }) });
  expect(r.status).toBe(201);
  return (await r.json() as { id: string }).id;
}
/**
 * A 閉じる of the fixtures' closable Issue 307 that finished with no update since, on each workspace: backlog-next leaves
 * it, so a test of the implement slot starts Ready Issue 304 there.
 */
function closeTried(...workspaceIds: string[]) {
  const now = Date.now();
  for (const workspaceId of workspaceIds.length ? workspaceIds : [metaId()]) core!.db.insertTask({ id: `tsk_close307_${workspaceId}`, workspaceId, title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 閉じる: PBI: Task が全部閉じた実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
}
/** The Tasks but closeTried's. */
const startedTasks = () => core!.db.listTasks().filter((t) => !t.id.startsWith("tsk_close307_"));
const runSchedule = (base: string, id: string) => fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });
const scheduleLogAll = async (base: string) => await (await fetch(`${base}/api/schedules/log`)).json() as string[];
const scheduleLog = async (base: string) => (await scheduleLogAll(base)).at(-1) ?? "";

test("backlog-next queue: with the queue enabled a firing starts no Ready PBI, logs 実装の枠: キューに任せる, and still moves the 計画 slot", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  saveQueue(core!.db, { enabled: true, items: [{ workspaceId: metaId(), number: 304 }] });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: キューに任せる`));
  // disabled: the firing picks as before
  saveQueue(core!.db, { enabled: false });
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
});

test("backlog-next queue: the queue enabled while a firing reads GitHub takes the 実装 slot from that firing", async () => {
  const claude = holdingClaude();
  const fake = fakeGh();
  let enableOnRead = false;
  const gh: GhRunner = async (args, cwd) => {
    if (enableOnRead) {
      enableOnRead = false;
      saveQueue(core!.db, { enabled: true });
    }
    return fake.gh(args, cwd);
  };
  const base = await boot(gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  enableOnRead = true;
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: キューに任せる`));
});

/** The backlog queue's API on a test daemon, and a wait for what it starts. */
const putQueue = (base: string, body: object) => fetch(`${base}/api/backlog/queue`, { method: "PUT", body: JSON.stringify(body) });
const getQueue = async (base: string) => (await (await fetch(`${base}/api/backlog/queue`)).json()) as BacklogQueue;
const queueOf = (...numbers: number[]) => numbers.map((number) => ({ workspaceId: metaId(), number }));
const startedTitles = () => startedTasks().map((t) => t.title.split(":")[0]);
async function until(f: () => boolean | Promise<boolean>, ms = 5000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await f()) return;
    await Bun.sleep(20);
  }
}

test("startFromQueue: enabling starts the head with no schedule; its Task's end starts the next; nothing starts while disabled", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect(core!.db.listSchedules().filter((s) => s.action === "backlog-next")).toEqual([]);
  // Issue 307 can be closed, Issue 304 is Ready: the queue's order, not Priority, says which goes first
  expect((await putQueue(base, { items: queueOf(307, 304) })).status).toBe(200);
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  await putQueue(base, { enabled: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#307 閉じる"]);
  await until(async () => (await getQueue(base)).lastNote?.includes("#307 を close で開始") ?? false);
  // its Task ends (aborted: Issue 307 is then left until the Issue moves): the second starts
  const first = startedTasks()[0]!;
  await fetch(`${base}/api/tasks/${first.id}/abort`, { method: "POST" });
  await until(() => startedTitles().length > 1);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  // disabled: a Task's end starts nothing
  await putQueue(base, { enabled: false, items: queueOf(304, 305) });
  await fetch(`${base}/api/tasks/${startedTasks().find((t) => t.title.startsWith("#304"))!.id}/abort`, { method: "POST" });
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
});

test("startFromQueue: concurrency 2 starts two, and no third", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { items: queueOf(307, 304, 305), concurrency: 2, enabled: true });
  await until(() => startedTitles().length >= 2);
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  await putQueue(base, { concurrency: 2 });
  await until(async () => (await getQueue(base)).lastNote === "同時に動かす数 2 に達している");
  expect((await getQueue(base)).lastNote).toBe("同時に動かす数 2 に達している");
});

test("startFromQueue: a head waiting for a PR still open is left and named as backlog-next names it; the second starts", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "OPEN" } });
  const base = await boot(fake.gh, claude.adapter);
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#307 閉じる"]);
  await until(async () => (await getQueue(base)).lastNote?.includes("#307 を close で開始") ?? false);
  const note = (await getQueue(base)).lastNote!;
  expect(note).toContain(`${metaName()}: 前提: #304（PR #778 マージ待ち）`);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`キュー: ${metaName()}: 前提: #304（PR #778 マージ待ち） (enabled)`));
});

test("startFromQueue: an empty queue says so and starts nothing", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { enabled: true });
  await until(async () => (await getQueue(base)).lastNote !== null);
  expect((await getQueue(base)).lastNote).toBe("キューが空");
  expect(startedTasks()).toEqual([]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: キューが空 (enabled)"));
});

test("startFromQueue: a queued PBI not yet split is named; a 計画 Task's end runs the queue again", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { items: queueOf(303), enabled: true });
  await until(async () => (await getQueue(base)).lastNote !== null);
  expect((await getQueue(base)).lastNote).toContain(`${metaName()}: まだ Ready でない: #303（Task 分解前）`);
  expect(startedTasks()).toEqual([]);
  // its Task に分解 (the button) ends: the queue looks again
  const r = await start(base, 303, { action: "to-tasks" });
  expect(r.status).toBe(201);
  await fetch(`${base}/api/tasks/${((await r.json()) as Task).id}/abort`, { method: "POST" });
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`キュー: ${metaName()}: まだ Ready でない: #303（Task 分解前） (task-end)`));
});

test("startFromQueue: the queue's start and a backlog-next firing at once start one Task per PBI", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  await putQueue(base, { items: queueOf(304) });
  const id = await backlogNextSchedule(base);
  await Promise.all([runSchedule(base, id), putQueue(base, { enabled: true })]);
  await until(() => startedTitles().includes("#304 実装"));
  await Bun.sleep(300);
  expect(startedTitles().filter((t) => t === "#304 実装")).toHaveLength(1);
});

test("startFromQueue: with concurrency 2, a queued PBI whose Task names the path of the PBI started before it is not started in the same run; the one with another path is", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  await putQueue(base, { items: queueOf(304, 309, 310), concurrency: 2, enabled: true });
  await until(() => startedTitles().length >= 2);
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#310 実装"]);
  expect((await getQueue(base)).lastNote ?? "").toContain("重なり: #309（Task #3041: src/a.ts）");
});

test("startFromQueue, developSelf off: a queued PBI of the meta workspace is not started, and the note says why", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf: false }) })).status).toBe(200);
  await putQueue(base, { items: queueOf(304), enabled: true });
  await until(async () => (await getQueue(base)).lastNote?.includes("開発しない設定") ?? false);
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  expect((await getQueue(base)).lastNote ?? "").toContain("開発しない設定なので読まない: #304");
});

test("startFromQueue: at boot an enabled queue goes on", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  // stored as a PUT stores it, without the PUT's start: only the boot starts it
  saveQueue(core!.db, { items: queueOf(304), enabled: true });
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  void base;
  await core!.stop();
  const cfg = loadConfig({ SWITCHBOARD_HOME: home!, SWITCHBOARD_KNOWLEDGE: join(home!, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home!, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh, () => openPulls), backlogAutoImport: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#304 実装"]);
});

/** boot, with daemon options the default boot leaves out (a judge, a job command). */
async function bootWith(adapter: RunnerAdapter, opts: Partial<Parameters<typeof startServer>[2]>) {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh, () => openPulls), backlogAutoImport: true, ...opts });
  const base = `http://127.0.0.1:${core.server.port}`;
  await refreshed(base, false);
  return base;
}

test("startFromQueue: a stage Task whose turn ended on a job it asked the daemon for keeps its place until the job ends, and the job's end runs the queue", async () => {
  const claude = endableClaude();
  const gate = join(tmpdir(), `sb-job-gate-${process.pid}-${Date.now()}`);
  const base = await bootWith(claude.adapter, { jobCommand: () => ({ argv: ["sh", "-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done`], tail: "" }) });
  core!.db.setSetting("settings", { judge: { enabled: false } });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  expect(task.title.startsWith("#304 実装")).toBe(true);
  // the Task asks the daemon for local CI (ops-kit job request) and ends its turn on it: its work is not over
  const r = await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "local-ci", taskId: task.id, pr: 900, cwd: task.cwd }) });
  expect(r.status).toBe(202);
  const job = (await r.json()) as { id: number };
  claude.end(0);
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(core!.db.getTask(task.id)!.status).toBe("done");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (task-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
  // the job ends: its end runs the queue; Issue 304 is not started again on top of it, the next goes
  writeFileSync(gate, "");
  try {
    await until(() => startedTitles().length > 1, 10_000);
  } finally {
    rmSync(gate, { force: true });
  }
  expect(core!.db.getJob(job.id)!.status).toBe("pass");
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("(job-end)"));
}, 30_000);

test("startFromQueue: a stage Task that stopped on its job# is resumed by the job's end before the queue looks, and keeps its place", async () => {
  const claude = endableClaude();
  const gate = join(tmpdir(), `sb-job-gate-${process.pid}-${Date.now()}`);
  const base = await bootWith(claude.adapter, { jobCommand: () => ({ argv: ["sh", "-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done`], tail: "" }) });
  core!.db.setSetting("settings", { judge: { enabled: false } });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  claude.emit(0, { t: "session.start", runnerSessionId: "sess-304" } as AgentEvent);
  const job = (await (await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "local-ci", taskId: task.id, pr: 900, cwd: task.cwd }) })).json()) as { id: number };
  // as `ops-kit job request` asks: a depends stop on job#<id>, then the turn ends
  expect(core!.tasks.recordStop(task.id, { id: `job-${job.id}`, op: "ops-kit job request local-ci", target: "PR #900", reason: "depends", safety: "read-only", evidence: `job#${job.id}`, state: "waiting", conditions: [{ key: `job#${job.id}`, value: "done", met: false }], actions: [] }).ok).toBe(true);
  claude.end(0);
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  writeFileSync(gate, "");
  try {
    await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(job-end)")), 10_000);
  } finally {
    rmSync(gate, { force: true });
  }
  // the job's end resumed the Task first: the queue found its place taken, and Issue 304 runs once
  expect(core!.db.getTask(task.id)!.status).toBe("running");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (job-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
}, 30_000);

test("startFromQueue: a stage Task's place stays taken while its last reply is judged, and the judgement runs the queue again", async () => {
  const claude = endableClaude();
  let judged: (r: { result: "needs_action"; reason: string; runner: "claude"; model: string }) => void = () => {};
  const base = await bootWith(claude.adapter, { judge: () => new Promise((r) => (judged = r)), rubricJudge: () => new Promise(() => undefined), titleSuggester: () => new Promise(() => undefined) });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  // the turn ends asking the person; its outcome is known only once the judge answers
  claude.emit(0, { t: "session.end", status: "ok", summary: "確認: PR をマージしてよいですか" });
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(core!.db.getTask(task.id)).toMatchObject({ status: "done", outcome: "unknown", judgingAt: expect.any(Number) });
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (task-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
  judged({ result: "needs_action", reason: "マージの確認", runner: "claude", model: "m" });
  await until(() => startedTitles().length > 1);
  expect(core!.db.getTask(task.id)).toMatchObject({ outcome: "needs_action", judgingAt: null });
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("(judged)"));
}, 30_000);

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

test("backlog-next: a firing starts with the schedule's effort, not autoStart's (schedule effort)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const id = await backlogNextSchedule(base, undefined, undefined, "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.map((s) => s.effort)).toEqual(claude.starts.map(() => "low"));
});

test("backlog-next: a schedule without an effort starts on the CLI default, not on autoStart's (schedule effort)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.effort).toBeUndefined();
});

test("backlog-next by kind: the schedule's runner and model win over a kind's own runner", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto", byKind: { complete: { runner: "codex", model: "m-impl" } } } });
  const id = await backlogNextSchedule(base, undefined, "m-sched", "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = core!.db.listTasks().filter((t) => t.scheduleId === id);
  expect(started.map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect(started.find((t) => t.title.startsWith("#304 実装"))).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
  expect(started.find((t) => t.title.startsWith("#303 Task に分解"))).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
});

test("backlog-next: the prompt of a button start names the merge gate only as the request's scope", async () => {
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

test("backlog-next slots: 実行枠待ちの工程 Task は枠を埋め、その Issue のボタンは 409 で taskId を返す", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRunners: 1 }) });
  const manual = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const queued = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(core!.db.getTask(queued.id)!.queuedAt).not.toBeNull();
  const again = await start(base, 304, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(queued.id);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(409); // nothing started: both slots are held
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠が埋まっている: 工程 Task ${queued.id}`));
  expect((await scheduleLogAll(base)).join("\n")).toContain("が 実行枠待ち");
  expect(startedTasks()).toHaveLength(2);
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
/** backlog quota: a backlog-next schedule on `runner`, with Claude and Codex both detected and holding. */
async function bootTwo(runner: "claude" | "codex") {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: metaId(), runner, prompt: "", action: "backlog-next" }) });
  expect(r.status).toBe(201);
  return { base, id: (await r.json() as { id: string }).id, claude: claude.starts, codex: codex.starts };
}

test("backlog quota: a codex schedule is not held back by Claude's usage; Codex's own at 0.85 holds it to one", async () => {
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

test("backlog quota: a claude schedule at Claude's limit with the fallback codex starts on codex and is judged by Codex's usage", async () => {
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

test("backlog quota: the schedule's runner is judged, not the kind's own — claude at its limit does not hold 実装 of a codex schedule whose kind default is claude", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("codex");
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  core!.db.setSetting("settings", { autoStart: { byKind: { complete: { runner: "claude", model: "", effort: "" } } } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => [t.title.split(":")[0], t.runner, !!t.scheduleId]).sort()).toEqual([["#303 Task に分解", "codex", true], ["#304 実装", "codex", true]]);
  expect(a.claude).toHaveLength(0);
});

/** backlog-next login: a Claude and a Codex that say `login` / `loginExpiresAt` from detect() (read again after a minute); the schedule runs on `runner`. */
type LoginState = { login?: "ok" | "expired" | "unknown"; loginExpiresAt?: number };
async function bootLogin(runner: "claude" | "codex", login: { claude?: LoginState; codex?: LoginState }, bedrock = false) {
  const state: { claude: LoginState; codex: LoginState } = { claude: { login: "ok", ...login.claude }, codex: { login: "ok", ...login.codex } };
  const claude = holdingClaude();
  const codex = holdingClaude();
  const withBedrock = bedrock ? { bedrockModels: [{ value: "global.anthropic.claude-haiku-5-5", label: "haiku" }] } : {};
  const base = await boot(fakeGh().gh, [{ ...claude.adapter, ...withBedrock, detect: async () => ({ available: true, ...state.claude }) }, { ...codex.adapter, id: "codex", detect: async () => ({ available: true, ...state.codex }) }]);
  closeTried();
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: metaId(), runner, prompt: "", action: "backlog-next" }) });
  expect(r.status).toBe(201);
  return { base, id: (await r.json() as { id: string }).id, state };
}
const HOUR = 3600_000;
const titles = () => startedTasks().map((t) => t.title.split(":")[0]).sort();

test("backlog-next login: a runner whose login lapsed (claude) starts no stage Task in any slot and the log says so", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(a.base)).toContain("飛ばした (manual): claude のログインが切れている: 始めない");
});

test("backlog-next login: codex expired holds a codex schedule the same way, and a claude schedule is not held by it", async () => {
  const a = await bootLogin("codex", { codex: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(a.base)).toContain("飛ばした (manual): codex のログインが切れている: 始めない");
  await shutdown();
  const b = await bootLogin("claude", { codex: { login: "expired" } });
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: claude's login lapsing in 23 hours holds the implement slot only, naming the time", async () => {
  const at = Date.now() + 23 * HOUR;
  const a = await bootLogin("claude", { claude: { loginExpiresAt: at } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(a.base)).toContainEqual(expect.stringContaining(`claude のログインが ${fmtTime(at, Date.now())} に切れる: 実装の枠を始めない`));
});

test("backlog-next login: with 25 hours left both slots start", async () => {
  const a = await bootLogin("claude", { claude: { loginExpiresAt: Date.now() + 25 * HOUR } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect((await scheduleLogAll(a.base)).some((l) => l.includes("のログインが"))).toBe(false);
});

test("backlog-next login: the expiry hold does not apply to a codex schedule, whatever Claude's expiry", async () => {
  const a = await bootLogin("codex", { claude: { loginExpiresAt: Date.now() + HOUR }, codex: { loginExpiresAt: Date.now() + HOUR } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]);
});

test("backlog-next login: Claude on Bedrock (login reads ok, no expiry) is not held, even if its own login lapsed", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired", loginExpiresAt: Date.now() + HOUR } }, true);
  core!.db.setSetting("settings", { bedrock: { claude: { region: "ap-northeast-1" } } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: an unknown expiry does not hold", async () => {
  const a = await bootLogin("claude", {});
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: the row's button still starts a stage Task while the login is expired", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect((await start(a.base, 304, { action: "complete" })).status).toBe(201);
});

test("backlog-next login: after logging in again (ok, expiry in 30 days) the next firing starts as before", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  a.state.claude = { login: "ok", loginExpiresAt: Date.now() + 30 * 24 * HOUR };
  const realNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 61_000); // the health check reads the status again after a minute
  try {
    await fetch(`${a.base}/api/health`);
    expect((await runSchedule(a.base, a.id)).status).toBe(201);
    expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
  } finally {
    clock.mockRestore();
  }
});

test("backlog-next slots: settings tunables — backlogQuotaLimit 0.5 holds back at Claude usage 0.6, read at each firing", async () => {
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

test("backlog-next slots: settings tunables — with the default threshold, Claude usage 0.6 starts per slot", async () => {
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
    // a read of the backlog, not of GitHub's budget, which comes before the quota check
    if (args[0] === "api" && !args.some((a) => a.includes("rateLimit")) && during) { during(); during = null; }
    return ok.gh(args, cwd);
  };
  const base = await boot(gh, holdingClaude().adapter);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  // Issue 303's plan Task (a button's) is running by the time GitHub answers: after the firing's quota check, before its start
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  during = () => { core!.db.insertTask({ id: "task_button303", workspaceId: meta.id, title: "#303 Task に分解: x", runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#303 Task に分解: x"), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }); };
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

test("backlog-next slots: a button's Task holds that slot while its routing turn is still thinking; the other slot starts", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const slow: Suggester = { suggest: async () => (await held, { runner: "claude", reason: "slow", ruleId: "llm", model: null, available: true, alternatives: [], llm: null }) };
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter, {}, () => slow);
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  const id = await backlogNextSchedule(base);
  const button = await start(base, 304, { action: "complete" }); // answered with the suggester still held
  expect(button.status).toBe(201);
  expect(core!.db.listTasks().map((t) => [t.title.split(":")[0], t.status, t.routing?.llm])).toEqual([["#304 実装", "running", null]]);
  // the button holds the implement slot; the plan slot still starts Issue 303
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  release();
});

test("backlog-next slots: Claude usage at 100% — the firing starts nothing and names the window and when it is back; a reset row does not count", async () => {
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

test("backlog-next picks a local Ready PBI with gh throwing", async () => {
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

describe("backlog-next auth (#3135)", () => {
  // the import's `gh api` is refused for the login; every other call goes to the fake
  const refused = (stderr: string): GhRunner => {
    const ok = budgetGh(5000);
    let on = false;
    const gh: GhRunner = async (args, cwd) => (on && args[0] === "api" && !args.some((a) => a.includes("rateLimit")) ? { code: 1, stdout: "", stderr } : ok.gh(args, cwd));
    return Object.assign(gh, { refuse: () => { on = true; }, allow: () => { on = false; } });
  };
  const run = async (stderr: string) => {
    const gh = refused(stderr);
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    return { base, status: (await runSchedule(base, id)).status };
  };

  test("backlog-next auth: an import refused with HTTP 401 holds the implement slot and logs it", async () => {
    const { base } = await run("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/実装の枠: GitHub の認証切れ: 始めない（.*HTTP 401: Bad credentials.*）/));
  });

  test("backlog-next auth: gh auth login wording holds it too", async () => {
    const { base } = await run("To get started with GitHub CLI, please run:  gh auth login");
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/実装の枠: GitHub の認証切れ: 始めない（.*gh auth login.*）/));
  });

  test("backlog-next auth: the read right before a start refused with HTTP 401 holds the implement slot too", async () => {
    // one settle is 4 `gh api` calls here: the firing's first read gets through, the read right before the start is refused
    const ok = budgetGh(5000);
    let calls = -1;
    const gh: GhRunner = async (args, cwd) => (calls >= 0 && args[0] === "api" && ++calls > 4 ? { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" } : ok.gh(args, cwd));
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    calls = 0;
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    const log = await scheduleLogAll(base);
    const held = log.findIndex((l) => /実装の枠: GitHub の認証切れ: 始めない（.*HTTP 401.*）/.test(l));
    expect(held).toBeGreaterThanOrEqual(0);
    // held by the read right before the start: the firing's first read got through, so no "照合できない" line comes before it
    expect(log.slice(0, held).filter((l) => l.includes("GitHub と照合できない"))).toEqual([]);
  });

  // an ended implement-slot stage Task of an Issue that is not in the fake backlog, with one stop.record
  const endedOnStop = async (state: "waiting" | "resolved") => {
    await Bun.sleep(50); // the import the boot started has finished: the stop is after the last successful one
    const now = Date.now();
    const id = "tsk_authstop399";
    core!.db.insertTask({ id, workspaceId: metaId(), title: "#399 実装: PBI: 認証で止まった", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 399, action: "complete" }, statusAt: now, createdAt: now, updatedAt: now });
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s399", work: { workspaceId: metaId(), issue: 399, taskId: id }, op: "gh", target: "", reason: "auth", evidence: "HTTP 401", safety: "before-effect", conditions: [], answer: null, actions: [], state, at: now } });
  };
  const implementStarts = () => startedTasks().filter((t) => t.title.includes("実装") && t.id !== "tsk_authstop399");

  test("backlog-next auth: a last implement Task stopped on auth holds the slot while the import fails for another reason", async () => {
    const gh = refused("dial tcp: i/o timeout");
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("waiting");
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("実装の枠: GitHub の認証切れ: 始めない（直前の工程 Task tsk_authstop399 が認証で止まり"));
  });

  test("backlog-next auth: an import that succeeds after the auth stop lets the next firing start", async () => {
    // a failure that is neither the login nor a transient one: no wait before the next firing's import
    const gh = refused("gh: unexpected error") as GhRunner & { refuse(): void; allow(): void };
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("waiting");
    gh.refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(0);
    // the fake gh is back: the next firing's import succeeds and lifts the hold
    gh.allow();
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(1);
  });

  test("backlog-next auth: a resolved auth stop does not hold", async () => {
    const gh = refused("dial tcp: i/o timeout");
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("resolved");
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(1);
    expect((await scheduleLogAll(base)).filter((l) => l.includes("認証切れ"))).toEqual([]);
  });

  test("backlog-next auth: the plan slot still starts while login is refused", async () => {
    const { status } = await run("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(status).toBe(201);
    expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#303 Task に分解");
  });

  test("backlog-next auth: a workspace kept here (backlog: switchboard) still starts its implement slot", async () => {
    const gh = refused("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    const claude = holdingClaude();
    const base = await boot(gh, claude.adapter);
    (gh as unknown as { refuse(): void }).refuse();
    const dir = mkdtempSync(join(home!, "local-"));
    copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(dir, "ops.config.json"));
    const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "local", backlog: "switchboard" }) })).json()) as { id: string };
    await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "PBI: ローカル", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1" } }) });
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().find((x) => x.workspaceId === ws.id)?.stage).toEqual({ issue: 1, action: "complete" });
    expect((await scheduleLogAll(base)).filter((l) => l.includes("local: ") && l.includes("認証切れ"))).toEqual([]);
  });

  test("backlog-next auth: the start button still answers 201 while login is refused", async () => {
    const gh = refused("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    const base = await boot(gh, holdingClaude().adapter);
    (gh as unknown as { refuse(): void }).refuse();
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  });
});

describe("GitHub budget", () => {
  test("GitHub budget: backlog-next starts on the stored data at 500 points left with the import refused for the limit, and logs no budget line", async () => {
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

  test("GitHub budget: a stage button starts its Task below 1,000 points left — the budget holds no start", async () => {
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

  test("GitHub budget: at 0 left GitHub refuses the read itself — that refusal is 0 left until its reset; the budget does not hold a stage button (the import before it is the settled-state wait's, and passes here)", async () => {
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

  test("GitHub budget: a limited read GitHub answers with 200 and no rateLimit in the body is read from the answer's headers", async () => {
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
    // a start goes on the stored data during the wait, without asking GitHub
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
  core = await startServer(cfg, [holdingClaude().adapter, dak], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh) });
  const base = `http://127.0.0.1:${core.server.port}`;
  // a default shadow is saved: the button path would mirror to it, the unattended sweep must not
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ shadowRunner: "dak" }) })).status).toBe(200);
  const id = await backlogNextSchedule(base, 5);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(2);
  for (const t of core!.db.listTasks()) expect(t).toMatchObject({ budgetUsd: 5, shadowOf: null });
});

/** A fake gh for the meta workspace and two more (lib, app), each its own repository; `broken` answers 404 for every call. */
/** backlog-next's slots of every registered workspace, through the API; the last response. */
async function sweepAll(base: string, sweep: { implement?: number; plan?: number }): Promise<Response> {
  let r: Response | undefined;
  for (const w of core!.db.listWorkspaces()) r = await fetch(`${base}/api/workspaces/${w.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep }) });
  return r!;
}

async function threeWorkspaces(adapter: RunnerAdapter, broken?: "lib", inner: GhRunner = fakeGh().gh) {
  const dirs: Record<string, string> = {};
  const gh: GhRunner = async (args, cwd) => {
    const name = Object.keys(dirs).find((k) => dirs[k] === cwd);
    if (name && name === broken) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (name && args[0] === "repo") return { code: 0, stdout: `acme/${name} true\n`, stderr: "" };
    return inner(args, cwd);
  };
  const base = await boot(gh, adapter);
  core!.db.setSetting("settings", { maxRunners: 8 }); // this test counts the Tasks a firing starts, not the run slots
  const ids: Record<string, string> = { switchboard: core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id };
  for (const name of ["lib", "app"]) {
    dirs[name] = mkdtempSync(join(home!, `${name}-`));
    ids[name] = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dirs[name], name }) })).json()) as { id: string }).id;
  }
  return { base, ids, dirs };
}

test("backlog-next: a decomposed PBI in 分解待ち starts with the make-Ready prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(decomposedGh().gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#303 を to-tasks で開始"));
  for (let i = 0; !claude.starts.some((x) => x.prompt.includes("PBI #303")) && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("PBI #303"))!.prompt;
  expect(prompt).toContain(DECOMPOSED_READY(303, 2));
  expect(prompt).toContain("既にある Task を作り直さずに");
  expect(prompt).not.toContain("Task に分解して Ready にしてください");
});

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
  expect(lib.prompt).toContain(`${meta.path}/docs/merge-gate.md`);
  expect(lib.prompt).not.toContain("定期実行が始めた無人の実装");
  // every slot is taken: the same firing again starts nothing and says why per workspace
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(6);
  const again = (await scheduleLogAll(base)).slice(log.length);
  expect(again.filter((l) => l.includes("の枠が埋まっている"))).toHaveLength(6);
});

test("backlog-next slots: the workspace's sweep applies from the next firing — implement 2 starts two implementations on one workspace, plan 0 none", async () => {
  // a second Ready PBI (Issue 309, a copy of Issue 304) on the first page
  const page = structuredClone(pages[0]) as { data: { repository: { issues: { nodes: RawBacklogIssue[] } } } };
  const nodes = page.data.repository.issues.nodes;
  nodes.push({ ...structuredClone(nodes.find((n) => n.number === 304)!), number: 309, title: "もう 1 件の Ready" });
  const ok = fakeGh();
  // its comments too: a Ready PBI's are read for its waits
  const comments = structuredClone(decisions) as { data: { repository: Record<string, unknown> } };
  comments.data.repository.i309 = { comments: { nodes: [] } };
  const gh: GhRunner = async (args, cwd) =>
    args.some((a) => a.includes("comments(last:")) ? { code: 0, stdout: JSON.stringify(comments), stderr: "" }
    : args[0] === "api" && !args.includes("after=CURSOR1") ? { code: 0, stdout: JSON.stringify(page), stderr: "" } : ok.gh(args, cwd);
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  const settings = (body: { implement?: number; plan?: number }) => sweepAll(base, body);
  const id = await backlogNextSchedule(base);
  // plan 0 with no plan Task running: Issue 303 waits to be split, yet no plan Task starts, and the log says nothing of that slot
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
  // back to plan 1: the next firing starts Issue 303
  expect((await settings({ plan: 1 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#309 実装"]);
});

test("backlog-next flow limit: with implement 2, a firing starts one flow PBI, logs the other as waiting, and starts the one without the label", async () => {
  // Issue 304 and its copies Issue 309 / Issue 310 are Ready; Issue 304 and Issue 309 carry flow-improvement
  const inner = moreReadyGh(309, 310);
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304 || node.number === 309) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = startedTasks().map((t) => t.title.split(":")[0]);
  // one flow PBI from Ready, then not the second in the same firing: the one without the label instead
  expect(started.filter((t) => t === "#304 実装" || t === "#309 実装")).toHaveLength(1);
  expect(started).toContain("#310 実装");
  const waiting = started.includes("#304 実装") ? 309 : 304;
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 開発の流れの PBI は同時 1 件まで（実装中 1 件）: 待ち #${waiting}`));
});

test("backlog-next slots per workspace: lib implement 2 starts two, app and meta at implement 0 start none and log no slot line", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, undefined, moreReadyGh(309));
  closeTried(...Object.values(ids));
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const patch = (ws: string, sweep: unknown) => fetch(`${base}/api/workspaces/${ws}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep }) });
  expect((await patch(ids.lib!, { implement: 2, plan: 0 })).status).toBe(200);
  for (const ws of [ids.app!, meta.id]) expect((await patch(ws, { implement: 0, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = startedTasks();
  expect(tasks.filter((t) => t.workspaceId === ids.lib).map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect(tasks.filter((t) => t.workspaceId !== ids.lib)).toHaveLength(0);
  const log = await scheduleLogAll(base);
  expect(log.some((l) => l.includes("app:") || l.includes(`${meta.name}:`))).toBe(false);
  // lib's slot is full now: the next firing names it there only
  expect((await runSchedule(base, id)).status).toBe(409);
  const again = await scheduleLog(base);
  expect(again).toContain("lib: 実装の枠が埋まっている");
  expect(again.includes("app:") || again.includes(`${meta.name}:`)).toBe(false);
});

/** The fixtures' gh with more Ready PBIs on the first page: copies of Issue 304 numbered `numbers`, with no comments. */
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
  core!.db.insertTask({ id: `task_${title.split(" ")[0]!.slice(1)}`, workspaceId: meta.id, title, runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
};

test("start race: a button start and a backlog-next firing on the same item make one Task", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  await sweepAll(base, { implement: 2, plan: 1 });
  const id = await backlogNextSchedule(base);
  const button = start(base, 304, { action: "complete" });
  // implement 2: the slot has room, the firing picks Issue 304 too — and leaves it to the button
  expect((await runSchedule(base, id)).status).toBe(201);
  expect((await button).status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 ")).length).toBe(1);
});

test("start race: a firing skips an item whose stage Task started after GitHub was read, and starts the next one", async () => {
  let first = true;
  // while the firing starts Issue 304, a stage Task of Issue 309 starts elsewhere (a button, an answer's resume): GitHub was read before it
  const routing: Suggester = { suggest: async () => {
    if (first) { first = false; runningStage("#309 実装: Ready の写し 309"); }
    return { runner: "claude", reason: "r", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
  } };
  const base = await boot(moreReadyGh(309, 310), holdingClaude().adapter, {}, () => routing);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  await sweepAll(base, { implement: 3, plan: 0 });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装", "#310 実装"]);
  // Issue 309 is not picked at all now: the read after Issue 304's start already shows its stage Task, so there is no "工程 Task が動いている" skip line
  expect(startedTasks().filter((t) => t.title.startsWith("#309 実装"))).toHaveLength(1); // the one started elsewhere only
});

test("backlog-next slots: a workspace whose GitHub cannot be read goes on with what is stored (nothing, never imported); the others start", async () => {
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
    expect(p).toContain("`/work/switchboard/docs/merge-gate.md` の「Recheck」");
    expect(p).toContain("その中の `-R <owner/name>` と `origin` はこのリポジトリ。印は必ずこのリポジトリの PR に付ける");
  }
});

test("start: stage endings read answers once and delegate decision procedure to the skills", () => {
  for (const action of ["to-pbi", "to-tasks", "complete", "close"] as const) {
    const p = buildStartPrompt({ number: 7 }, action);
    expect(p).toContain("始める前に Issue #7 の最新の `## 回答`");
    expect(p).toContain("`ops-kit backlog view 7 --fresh`"); // the latest answer from the app, imported first
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
  // sb-rescue is promoting: the next check does not ask for the same tag again
  expect(promotionStep({ status: released({ busy: "promote" }), latest: v2, busyTasks: 0 })).toEqual({ action: "wait", reason: "sb-rescue が promote の最中なので v0.2.0 の昇格を待つ" });
  // a failure of another commit does not hold this one
  expect(promotionStep({ status: released({ history: [{ action: "rejected", from: "aaa", to: "ccc", ok: false, reason: "x" }] }), latest: v2, busyTasks: 0 }).action).toBe("promote");
});

/**
 * The failure report's stored backlog: PBI 499, its Task 500 and (when `pr`) PR 501 closing Issue 500, in a Db under `source`.
 * Its gh answers `gh pr view` only (`prView`: the PR's body and branch, else "not a PR") and counts every call.
 */
function reportStore(source: BacklogSource, opts: { pr?: boolean; prView?: { body: string; headRefName: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-promote-"));
  const db = new Db(join(dir, "x.db"));
  const at = "2030-01-01T00:00:00Z";
  const issue = (number: number, labels: string[], parent: number | null, body: string) =>
    ({ objectKind: "issue" as const, externalId: `I${number}`, fetchState: "fetched" as const, remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues: number === 499 ? [500] : [], createdAt: at, updatedAt: at, closedAt: null } });
  const pr = { objectKind: "pull-request" as const, externalId: "PR501", fetchState: "fetched" as const, remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: "bbbbbbbbbb", updatedAt: at, files: [], closedAt: at, mergedAt: at } };
  db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null, "## ユーザーストーリー"), issue(500, ["type:task"], 499, "## 親 PBI\n#499"), ...(opts.pr ? [pr] : [])] as never, cursor: null, syncedAt: Date.now() });
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && opts.prView) return { code: 0, stdout: JSON.stringify(opts.prView), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
  const comments = () => db.listBacklogRecords(source, "comment").map((r) => (r.local ?? r.remote) as { issue: number; body: string });
  const labelOps = () => db.listPendingBacklogOperations(source).filter((o) => o.kind === "set" && o.field === "label:needs-decision").map((o) => [o.target, o.payload]);
  return { db, gh, calls, comments, labelOps, done: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}
const failure = { tag: "v0.2.0", sha: "bbbbbbbbbb", subject: "feat(core): x (#501)", reason: "went back by itself: health", rescueUrl: "https://d1.example.net/rescue/" };
const githubSource: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

test("promote: a failed version is reported once on the stored PBI behind its PR, as ## 判断待ち with the reason and the rescue page, kept to be sent", async () => {
  const f = reportStore(githubSource, { pr: true });
  try {
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", failure)).toBe(499);
    // nothing written to GitHub here, and no Issue read from it: the stored PR names its Task
    expect(f.calls).toEqual([]);
    const [c] = f.comments();
    expect(c!.issue).toBe(499);
    expect(c!.body.startsWith("## 判断待ち\n**問い**: 動いているアプリに入らなかった版 v0.2.0（bbbbbbb feat(core): x (#501)）")).toBe(true);
    expect(c!.body).toContain("went back by itself: health");
    expect(c!.body).toContain("救援画面: https://d1.example.net/rescue/");
    expect(f.labelOps()).toEqual([["I499", true]]);
    // the same commit again: one comment
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", failure)).toBe(499);
    expect(f.comments()).toHaveLength(1);
    expect(f.labelOps()).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("promote: a backlog kept in the app only gets the report on its own PBI; a PR not stored is read with gh pr view (closesOf)", async () => {
  const source = localBacklogSource("ws_local");
  const f = reportStore(source, { prView: { body: "## 概要\nBacklog-Task: 500", headRefName: "sb/500-x" } });
  try {
    expect(await reportPromoteFailure(f.db, source, f.gh, "/repo", failure)).toBe(499);
    expect(f.calls.map((a) => a.slice(0, 3))).toEqual([["pr", "view", "501"]]);
    expect(f.comments().map((c) => [c.issue, c.body.split("\n")[0]])).toEqual([[499, "## 判断待ち"]]);
    expect(f.labelOps()).toEqual([["I499", true]]);
  } finally {
    f.done();
  }
});

test("promote: a subject without (#n), or a number that is no stored Issue, reports nothing", async () => {
  const f = reportStore(githubSource);
  try {
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: no number" })).toBeNull();
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: y (#777)" })).toBeNull();
    // a Task's own number (not a PR: gh pr view fails) reaches its PBI
    expect(await reportPromoteFailure(f.db, githubSource, f.gh, "/repo", { ...failure, subject: "fix: z (#500)" })).toBe(499);
    expect(f.comments()).toHaveLength(1);
  } finally {
    f.done();
  }
});

/** A checkout with one commit tagged v0.2.0, and a fake sb-rescue whose current release is another commit. */
async function releasedDaemon(history: ReleaseState["history"] = [], runningNewer = false, { busy = null, promoteDelayMs = 0, refuse = false, statusDelayMs = 0, origin }: { busy?: string | null; promoteDelayMs?: number; refuse?: boolean; statusDelayMs?: number; origin?: string } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
  withProcesses(repo);
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
  git("init", "-q");
  // origin: a clone of the public copy (its ops.config.json names it) or of a repository that is not; the running version is then a real commit before the tag
  let before = "";
  if (origin) {
    writeFileSync(join(repo, "ops.config.json"), JSON.stringify({ publicSync: { target: "o/pub" } }));
    git("remote", "add", "origin", origin);
    git("add", "."); git("commit", "-q", "-m", "base"); before = git("rev-parse", "HEAD");
  }
  git("commit", "-q", "--allow-empty", "-m", "feat(core): x (#501)"); git("tag", "v0.2.0");
  const sha = git("rev-parse", "HEAD");
  // runningNewer: what sb-rescue runs is a later, untagged commit on top of the tag (promoted by hand)
  if (runningNewer) git("commit", "-q", "--allow-empty", "-m", "fix: later");
  let current = runningNewer ? git("rev-parse", "HEAD") : before || "old";
  const promoted: string[] = [];
  const statusAsked = { pending: 0 };
  const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status" && statusDelayMs) { statusAsked.pending++; await Bun.sleep(statusDelayMs); statusAsked.pending--; }
    if (url.pathname === "/api/status") return Response.json({ current, previous: null, state: "running", busy, lastError: null, history: history.map((h) => ({ ...h, to: h.to === "SHA" ? sha : h.to, from: h.from === "SHA" ? sha : h.from })) });
    if (url.pathname === "/api/promote") { if (refuse) return Response.json({ error: "refused" }, { status: 409 }); if (promoteDelayMs) await Bun.sleep(promoteDelayMs); const commit = ((await req.json()) as { commit: string }).commit; promoted.push(commit); current = commit; return Response.json({ started: "promote" }, { status: 202 }); }
    return new Response("no", { status: 404 });
  } });
  return { repo, sha, promoted, statusAsked, rescue, env: { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` } };
}

test("promote: a firing of the items whose waits cleared asks for the newer tag first, logs it, and starts nothing", async () => {
  const r = await releasedDaemon();
  try {
    const claude = holdingClaude();
    const states: Record<string, Record<string, unknown>> = { w778: { __typename: "PullRequest", state: "OPEN" } };
    const base = await boot(waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states).gh, claude.adapter, r.env);
    await backlogNextSchedule(base);
    states.w778 = { ...states.w778, state: "MERGED" };
    await refreshed(base);
    for (const end = Date.now() + 3000; r.promoted.length === 0 && Date.now() < end; ) await Bun.sleep(10);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("v0.2.0 の昇格を依頼 (待ちが解けた)"));
    expect(claude.starts).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: under sb-rescue a newer tag is promoted first, and that firing starts nothing", async () => {
  const r = await releasedDaemon();
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: "v0.2.0 の昇格を依頼" }]);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLog(base)).toContain("v0.2.0 の昇格を依頼 (manual)");
    // what was asked is shown on 動いている版: the tag, the sha, who asked
    const asked = ((await (await fetch(`${base}/api/daemon/release`)).json()) as { asked: { tag: string; sha: string; by: string; error?: string } | null }).asked;
    expect(asked).toMatchObject({ tag: "v0.2.0", sha: r.sha, by: "backlog-next" });
    expect(asked!.error).toBeUndefined();
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

test("promote: while the newest tag is one that failed, nothing is promoted or started, and its stored PBI gets one ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const fake = fakeGh();
  try {
    // the PBI is read on a phone: the rescue page it names is the host's outside URL, not sb-rescue's own address
    const base = await boot(fake.gh, holdingClaude().adapter, { ...r.env, SWITCHBOARD_WEB_URL: "https://d1.example.net" });
    await refreshed(base);
    const source = core!.db.getWorkspaceBacklogSource(metaId())!;
    const at = "2030-01-01T00:00:00Z";
    const issue = (number: number, labels: string[], parent: number | null) =>
      ({ objectKind: "issue", externalId: `I${number}`, fetchState: "fetched", remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null } });
    const pr = { objectKind: "pull-request", externalId: "PR501", fetchState: "fetched", remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: r.sha, updatedAt: at, files: [], closedAt: at, mergedAt: at } };
    core!.db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null), issue(500, ["type:task"], 499), pr] as never, cursor: core!.db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: "昇格に失敗した版のまま: v0.2.0（判断待ち: #499）" }]);
    expect(await scheduleLog(base)).toContain("昇格に失敗した版のまま: v0.2.0（判断待ち: #499） (manual)");
    expect(r.promoted).toEqual([]);
    expect(core!.db.listTasks()).toHaveLength(0);
    // kept in the app and sent from there: comment then label, on Issue 499
    const ops = core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment" || o.field === "label:needs-decision");
    expect(ops.map((o) => [o.kind, o.field ?? null])).toEqual([["comment", null], ["set", "label:needs-decision"]]);
    expect((ops[0]!.payload as { body: string }).body).toContain("救援画面: https://d1.example.net/rescue/");
    expect(fake.calls.filter((a) => a[0] === "issue" && (a[1] === "comment" || a[1] === "edit"))).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

/** A claude adapter whose turns stay running until the test ends them (`end(i)` = the i-th started Task's turn ends ok). */
function endableClaude(permissionModes: RunnerAdapter["permissionModes"] = []) {
  const emits: Array<(ev: AgentEvent) => void> = [];
  const adapter: RunnerAdapter = {
    id: "claude", detect: async () => ({ available: true }), permissionModes,
    start(_opts, emit) {
      emits.push(emit);
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  };
  const started = async (n: number) => { for (const t0 = Date.now(); emits.length < n && Date.now() - t0 < 20_000; ) await Bun.sleep(10); expect(emits).toHaveLength(n); };
  return { adapter, started, count: () => emits.length, end: (i: number) => emits[i]!({ t: "session.end", status: "ok" }), emit: (i: number, ev: AgentEvent) => emits[i]!(ev) };
}
const releaseHold = async (base: string) => ((await (await fetch(`${base}/api/daemon/release`)).json()) as { hold: unknown }).hold;
const settle = async (until: () => boolean) => { for (const t0 = Date.now(); !until() && Date.now() - t0 < 20_000; ) await Bun.sleep(10); };

const CHECK = { promotionCheckMs: 50 };

test("promote: check — with no schedule, the newest tag is asked for on the interval", async () => {
  const r = await releasedDaemon();
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    expect(core!.db.listSchedules().filter((s) => s.action === "backlog-next")).toEqual([]); // no firing: only the interval can ask
    await settle(() => r.promoted.length > 0);
    await Bun.sleep(150);
    expect(r.promoted).toEqual([r.sha]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("最新のタグの確認: v0.2.0 の昇格を依頼"));
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check — a running Task holds it, and the request comes when the Task ends", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    for (const t0 = Date.now(); (await releaseHold(base)) === null && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    await Bun.sleep(200);
    expect(r.promoted).toEqual([]);
    claude.end(0);
    await settle(() => r.promoted.length > 0);
    await Bun.sleep(150);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: check — a failed tag is not asked again and gets no ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }]);
  const fake = fakeGh();
  try {
    const base = await boot(fake.gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    await Bun.sleep(300);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: true });
    expect(await scheduleLogAll(base)).toEqual([expect.stringContaining("最新のタグの確認: 昇格に失敗した版のまま: v0.2.0")]);
    expect(fake.calls.filter((a) => a[0] === "issue" && a[1] === "comment")).toHaveLength(0);
    expect(core!.db.listBacklogOperations(core!.db.getWorkspaceBacklogSource(metaId())!).filter((o) => o.kind === "comment")).toHaveLength(0);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check — backlog-next that joins a check of a failed tag still writes its ## 判断待ち", async () => {
  const r = await releasedDaemon([{ action: "auto-rollback", from: "SHA", to: "old", ok: false, reason: "went back by itself: health" }], false, { statusDelayMs: 300 });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, { promotionCheckMs: 1_000 });
    const source = core!.db.getWorkspaceBacklogSource(metaId())!;
    const at = "2030-01-01T00:00:00Z";
    const issue = (number: number, labels: string[], parent: number | null) =>
      ({ objectKind: "issue", externalId: `I${number}`, fetchState: "fetched", remote: { number, title: `#${number}`, url: "", state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null } });
    const pr = { objectKind: "pull-request", externalId: "PR501", fetchState: "fetched", remote: { number: 501, state: "MERGED", isDraft: false, labels: [], closes: [500], mergeCommit: r.sha, updatedAt: at, files: [], closedAt: at, mergedAt: at } };
    core!.db.putBacklogSnapshot(source, { records: [issue(499, ["type:pbi"], null), issue(500, ["type:task"], 499), pr] as never, cursor: core!.db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
    const id = await backlogNextSchedule(base);
    // the check is asking sb-rescue when backlog-next comes, so backlog-next joins it
    await settle(() => r.statusAsked.pending > 0);
    await runSchedule(base, id);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("昇格に失敗した版のまま: v0.2.0（判断待ち: #499）"));
    expect(core!.db.listBacklogOperations(source).filter((o) => o.kind === "comment")).toHaveLength(1);
    expect(r.promoted).toEqual([]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: a request sb-rescue refuses is answered with 202 and shown as asked.error", async () => {
  const r = await releasedDaemon([], false, { refuse: true });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env);
    const id = await backlogNextSchedule(base);
    const res = await runSchedule(base, id);
    expect([res.status, await res.json()]).toEqual([202, { promotion: `v0.2.0 の昇格を依頼できない: {"error":"refused"}` }]);
    const asked = ((await (await fetch(`${base}/api/daemon/release`)).json()) as { asked: { tag: string; error?: string } }).asked;
    expect(asked).toMatchObject({ tag: "v0.2.0", error: `{"error":"refused"}` });
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
});

test("promote: check and backlog-next at once ask /api/promote once", async () => {
  const r = await releasedDaemon([], false, { promoteDelayMs: 200 });
  try {
    const base = await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    await Bun.sleep(500);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: when idle — a promotion held by a running Task is asked for as soon as that Task's turn ends", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(r.promoted).toEqual([]);
    expect(await scheduleLog(base)).toContain("1 件の Task が動いているので v0.2.0 の昇格を待つ");
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    // the same tag held again keeps when it began
    const since = ((await releaseHold(base)) as { since: number }).since;
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(((await releaseHold(base)) as { since: number }).since).toBe(since);
    // the daily approval-window firing tells the hold in 判断待ち, with the Task count
    const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
    const w = (await (await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "承認待ち", cron: "0 0 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "approval-window" }) })).json()) as { id: string };
    const notices = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; state: string; question: string }> }).asks.filter((a) => a.id.startsWith("notice:promotion:"));
    expect(await notices()).toEqual([]);
    expect((await runSchedule(base, w.id)).status).toBe(202);
    await settle(() => core!.db.getSchedule(w.id)!.lastRunAt !== null);
    expect((await notices()).map((a) => [a.id, a.state, a.question])).toEqual([[`notice:promotion:${w.id}@${since}`, "open", "昇格待ち: v0.2.0（0 時間、動いている Task 1 件）— ヘッダーの「新しい版 →」から昇格できる"]]);
    claude.end(0);
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
    // promoted: the notice is resolved
    expect((await notices()).map((a) => a.state)).toEqual(["resolved"]);
    // ordering (a flake): the line is written after sb-rescue answers, later than `promoted` grows
    const text = "バックログを進める: Task が空いたので v0.2.0 の昇格を依頼";
    for (const t0 = Date.now(); !(await scheduleLog(base)).includes(text) && Date.now() - t0 < 20_000; ) await Bun.sleep(10);
    expect(await scheduleLog(base)).toContain(text);
    expect(await releaseHold(base)).toBeNull();
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000); // a git promotion and HTTP turns under a loaded full suite: over the 5 s default (docs/design/perf.md "Test flakiness")

test("promote: when idle — a Task whose turn ended with background jobs holds the promotion until they end", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    await claude.started(1);
    const id = await backlogNextSchedule(base);
    claude.emit(0, { t: "background", count: 1, jobs: ["Recheck"] });
    claude.end(0);
    // the turn is over: only the background job holds the promotion from here
    await settle(() => core!.db.listTasksByStatus("running").length === 0 && core!.db.listTasksByStatus("background").length === 1);
    expect(core!.db.listTasksByStatus("running")).toEqual([]);
    expect((await runSchedule(base, id)).status).toBe(202);
    expect(r.promoted).toEqual([]);
    expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, busyTasks: 1 });
    claude.emit(0, { t: "background", count: 0 });
    await settle(() => r.promoted.length > 0);
    expect(r.promoted).toEqual([r.sha]);
  } finally {
    r.rescue.stop(true);
    rmSync(r.repo, { recursive: true, force: true });
  }
}, 30_000);

test("promote: when idle — not while another Task still runs, and asked for once only", async () => {
  const r = await releasedDaemon();
  const claude = endableClaude();
  try {
    const base = await boot(fakeGh().gh, claude.adapter, r.env);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
    await claude.started(2);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(202);
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
    expect((await firing).status).toBe(202);
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
    expect((await runSchedule(base, id)).status).toBe(202);
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

test("a workspace names the repository variable its Project URL is under (PATCH /api/workspaces/:id); unset = SWITCHBOARD_PROJECT_URL (kind project-var)", async () => {
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

describe("otherRepoRules: the scripts/setup of the repository", () => {
  const rules = (setup: { config: boolean; kit: string[]; copies: string[] }) => otherRepoRules({ meta: "/work/switchboard", projectVar: "LIB_URL", setup });
  // local-ci once on the top of a stack: the rule's place in the meta's docs
  const kept = ["--repo <このリポジトリの owner/name>", "`bun /work/switchboard/scripts/local-ci.ts <PR> --repo", "回すのはスタックの一番上で 1 回", "`/work/switchboard/docs/merge-gate.md` の「When to run local CI and how it counts」"];

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

test("PATCH /api/workspaces/:id: the same projectVar keeps the stored backlog; another one forgets it and imports again", async () => {
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

test("a workspace registered over the API and given its projectVar is in GET /api/backlog with no errors, even with 0 Issues", async () => {
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

test("GET /api/backlog before the first import: no items, the workspace in errors and its import under way — never an empty list as if read", async () => {
  const ok = fakeGh();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api") await held; // GitHub has not answered yet
    return ok.gh(args, cwd);
  };
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh) });
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

test("prereqState: Issues, pull requests and releases by how they closed; not stored is missing", () => {
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

test("replyWaiting: the row's waiting for a reply is backlog-next's awaitingReply, or the last stage Task's newest stop waiting for a decision", () => {
  const at = "2026-09-28T00:00:00Z";
  const later = "2026-09-28T01:00:00Z";
  const last = (over: Partial<NonNullable<BacklogItem["lastTask"]>> = {}) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, ...over });
  const stopOf = (over: Partial<BacklogItem["stopSummary"][number]> = {}): BacklogItem["stopSummary"][number] => ({
    key: "k", work: { workspaceId: "ws_meta", issue: 1, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "マージしてよいか", safety: "before-effect",
    count: 1, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide", ...over,
  });
  const asked = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, updatedAt: at, lastTask: last() });
  const stopped = { ...asked, lastTask: last({ outcome: "unknown" }), stopSummary: [stopOf()] };
  // [name, item, replyWaiting, awaitingReply (backlog-next's skip as 返事待ち); null = not that rule — the stop is stopHeld's side]
  const rows: [string, BacklogItem, boolean, boolean | null][] = [
    ["(a) done, needs_action, not reviewed, the Issue older", asked, true, true],
    ["(b) unknown with the newest stop next = decide", stopped, true, null],
    ["(c) (a) reviewed", { ...asked, lastTask: last({ reviewedAt: Date.parse(later) }) }, false, false],
    ["(d) (a) with the Issue newer than the Task", { ...asked, updatedAt: later }, false, false],
    ["(e) (a) with a newer ## 回答", { ...asked, answeredAt: later }, false, false],
    ["(f) (b) answered (next = resume)", { ...stopped, stopSummary: [stopOf({ next: "resume", changes: [{ kind: "answer", detail: "はい" }] })] }, false, null],
  ];
  for (const [name, i, want, skip] of rows) {
    expect([name, isReplyWaiting(i)]).toEqual([name, want]);
    if (skip !== null) expect([name, awaitingReply(i)]).toEqual([name, skip]);
  }
  // (b) is left by stopHeld, not awaitingReply; only the newest series of the last Task counts, and a running Task is not waiting
  expect(awaitingReply(stopped)).toBe(false);
  expect(isReplyWaiting({ ...stopped, stopSummary: [stopOf({ lastAt: 1 }), stopOf({ key: "k2", lastAt: 5, next: "wait" })] })).toBe(false);
  expect(isReplyWaiting({ ...stopped, stopSummary: [stopOf({ work: { workspaceId: "ws_meta", issue: 1, taskId: "tsk_old" } })] })).toBe(false);
  expect(isReplyWaiting({ ...stopped, lastTask: last({ status: "running", outcome: "unknown" }) })).toBe(false);
});

test("a stop that came again with nothing changed holds the item through an unrelated Issue update; an answer, a met condition or a new cause lets it go once", () => {
  const last = { id: "tsk_last", status: "done" as const, statusAt: 1, createdAt: 1, updatedAt: Date.parse("2026-09-10T00:00:00Z"), action: "complete" as const, outcome: "done" as const, reviewedAt: null, resumeAt: null };
  const stopOf = (over: Partial<BacklogItem["stopSummary"][number]> = {}): BacklogItem["stopSummary"][number] => ({
    key: "k", work: { workspaceId: "ws_meta", issue: 3, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI", safety: "unknown",
    count: 2, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, grant: null, conditions: [], actions: [], changes: [], unchanged: true, next: "wait", ...over,
  });
  const touched = "2026-09-12T00:00:00Z"; // the Issue was updated after the Task ended
  const base = item({ number: 3, stage: "ready", lastTask: last, updatedAt: touched, stopSummary: [stopOf()] });
  // an in-progress PBI moved since its last resume (its ## 状況 written): resumed unless a stop holds it
  const progressOf = (i: BacklogItem): BacklogItem => ({ ...i, stage: "in-progress", tasks: { done: 1, total: 3, doneAt: null } });
  expect(pickNext([{ ...progressOf(base), stopSummary: [] }], "implement")?.item.number).toBe(3);
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
  // a first stop waiting for the person's decision (asked to merge): held — starting again asks the same on top of it;
  // the person's reply in that Task lets it go
  const ask = stopOf({ count: 1, unchanged: false, reason: "decision", next: "decide" });
  expect(stopHeld({ ...base, stopSummary: [ask] })).toBe(true);
  expect(pickNext([{ ...progressOf(base), stopSummary: [ask] }], "implement")).toBeNull();
  expect(stopHeld({ ...base, stopSummary: [{ ...ask, lastAnswer: { ref: "seq:9", at: 3 } }] })).toBe(false);
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
  const newCause = stopOf({ key: "k2", reason: "input", count: 1, lastAt: 9, unchanged: false, changes: [{ kind: "cause", detail: "depends → input" }], next: "wait", conditions: [] });
  expect(stopHeld({ ...base, stopSummary: [stopOf(), newCause] })).toBe(false);
  // ...but a new cause that waits for the person's decision (CI waited on, then asked to merge, at the same place) holds:
  // the cause moving is not the person answering
  const nowAsks = stopOf({ key: "k2", reason: "decision", count: 1, lastAt: 9, unchanged: false, changes: [{ kind: "cause", detail: "depends → decision" }], next: "decide" });
  expect(stopHeld({ ...base, stopSummary: [stopOf(), nowAsks] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [stopOf(), { ...nowAsks, lastAnswer: { ref: "seq:9", at: 10 } }] })).toBe(false);
  // an unmet condition's value moving is not a condition met; and an Issue 12 met is not PR 12 met
  const moved = stopOf({ unchanged: false, changes: [{ kind: "condition", detail: "pr#12: open → draft" }], conditions: [{ key: "pr#12", value: "draft", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [moved] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [moved], prereqs: [{ number: 12, kind: "issue", need: "done", state: "met", via: null }] })).toBe(true);
});

/* ---------- a start goes on the stored data; only a conflict holds it ---------- */

describe("start gate: only a conflict in the stored data holds a start", () => {
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

  /** Runs backlog-next once with Issue 307 (picked to 閉じる) changed by `change` on GitHub between the sweep's read and the read right before its start. */
  const sweepWith307Changed = async (change: (i: Record<string, any>) => Record<string, unknown>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const fake = fakeGh();
    const changed = { from: Infinity };
    let reads = 0;
    const gh: GhRunner = async (args, cwd) => {
      const r = await fake.gh(args, cwd);
      if (!args.includes("query=issues(states:OPEN)")) return r;
      // each read of the Issues starts on the first page; Issue 307 is on the second
      if (!args.includes("after=CURSOR1")) reads++;
      if (reads < changed.from) return r;
      const body = JSON.parse(r.stdout);
      body.data.repository.issues.nodes = body.data.repository.issues.nodes.map((i: { number: number }) => (i.number === 307 ? change(i) : i));
      return { ...r, stdout: JSON.stringify(body) };
    };
    const base = await boot(gh, holdingClaude().adapter);
    await refreshed(base);
    // the sweep's first read still sees Issue 307 as it was and picks it to close; the read right before its start sees the change (a read asks the three lists at once, so the change starts at the next read's first ask, not in the middle of the first read's pages)
    changed.from = reads + 3;
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

describe("canStartStoredBacklog", () => {
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

test("comment: a plain comment is kept here at once (202) as a comment operation — no heading, no label change — and refused for a secret or an unknown Issue", async () => {
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
      core!.db.insertTask({ id: "tsk_mock", workspaceId: metaId(), title: "mockups", stage: null, runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });
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

describe("flow-improvement limit", () => {
  const flowItem = (over: Partial<BacklogItem>) => item({ flow: true, ...over });
  const working = flowItem({ number: 1, stage: "in-progress", projectStatus: "In progress", activeTaskId: "t1", tasks: { total: 3, done: 1, doneAt: null } });
  const limit = (n: number, items: BacklogItem[]) => ({ limit: n, running: flowRunning(items), stopped: flowStopped(items) });

  test("flow: with one flow PBI in progress, the next flow Ready is left and the one without the label is taken", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const plain = item({ number: 3, priority: "P3" });
    const all = [working, next, plain];
    expect(flowRunning(all)).toBe(1);
    expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 3 } });
    expect(pickNext([working, next], "implement", undefined, limit(1, all))).toBeNull();
    expect(flowHeldIn(all, "implement", limit(1, all)).map((i) => i.number)).toEqual([2]);
    expect(pickNext(all, "implement")).toMatchObject({ item: { number: 2 } });
  });

  test("flow: the running count comes from the caller, not from the candidates passed (a queue's few, the picked taken out)", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const plain = item({ number: 3, priority: "P3" });
    // the in-progress one is outside the candidates (not queued, or already picked to resume), yet it counts
    expect(pickNext([next, plain], "implement", undefined, { limit: 1, running: 1 })).toMatchObject({ item: { number: 3 } });
    expect(pickNext([next, plain], "implement", undefined, { limit: 1, running: 0 })).toMatchObject({ item: { number: 2 } });
  });

  test("flow: a P0 flow PBI is taken whatever the count", () => {
    const urgent = flowItem({ number: 2, priority: "P0" });
    expect(pickNext([working, urgent], "implement", undefined, limit(1, [working]))).toMatchObject({ item: { number: 2 } });
    expect(flowHeldIn([working, urgent], "implement", limit(1, [working]))).toEqual([]);
  });

  test("flow: the resume or close of an in-progress flow PBI is not held", () => {
    const stalled = flowItem({ number: 1, stage: "in-progress", projectStatus: "In progress", tasks: { total: 3, done: 3, doneAt: null }, closable: true });
    expect(pickNext([stalled], "implement", undefined, { limit: 1, running: 1 })).toMatchObject({ item: { number: 1 }, action: "close" });
    const resumed = flowItem({ number: 4, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } });
    expect(pickNext([resumed], "implement", undefined, { limit: 1, running: 2 })).toEqual({ item: resumed, action: "complete", resume: true });
    expect(flowHeldIn([stalled, resumed], "implement", { limit: 1, running: 2 })).toEqual([]);
  });

  test("flow: with limit 2 the second flow PBI starts", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    expect(pickNext([working, next], "implement", undefined, limit(2, [working]))).toMatchObject({ item: { number: 2 } });
    expect(flowHeldIn([working, next], "implement", limit(2, [working]))).toEqual([]);
  });

  // an in-progress flow PBI backlog-next leaves (a reply, decision or wait it is stuck on) does not use the limit
  const at = "2026-09-28T00:00:00Z";
  const asked = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null };
  const progress = { stage: "in-progress" as const, projectStatus: "In progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at };

  test("flow: a flow PBI in progress that waits for a reply, a decision or a dependency is not counted, so a Ready flow PBI is taken", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const reply = flowItem({ number: 10, ...progress, lastTask: asked });
    // a decision stop on a Task that ended done (no reply waited for): only the stop holds it
    const decided = { ...asked, outcome: "done" as const };
    const ask: BacklogItem["stopSummary"][number] = {
      key: "k", work: { workspaceId: "ws_meta", issue: 11, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "large", safety: "before-effect",
      count: 1, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide",
    };
    const free = flowItem({ number: 11, ...progress, lastTask: decided, updatedAt: "2026-09-29T00:00:00Z" }); // moved since the Task
    expect(flowRunning([free])).toBe(1);
    const decide = { ...free, stopSummary: [ask] };
    const waiting = flowItem({ number: 12, ...progress, waits: [wait(778, "pr", true)] });
    for (const stuck of [reply, decide, waiting]) {
      const all = [stuck, next];
      expect(flowRunning(all)).toBe(0);
      expect(flowStopped(all)).toBe(1);
      expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 2 } });
    }
  });

  test("flow: one with a stage Task running, and one that backlog-next resumes next, are still counted", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    expect(flowRunning([working])).toBe(1);
    expect(flowStopped([working])).toBe(0);
    expect(pickNext([working, next], "implement", undefined, limit(1, [working, next]))).toBeNull();
    // no stop holds it, so it is the next resume: counted
    const stalled = flowItem({ number: 13, ...progress });
    expect(pickNext([stalled], "implement")).toMatchObject({ action: "complete", resume: true });
    expect(flowRunning([stalled])).toBe(1);
    expect(flowStopped([stalled])).toBe(0);
    expect(pickNext([stalled, next], "implement", undefined, limit(1, [stalled, next]))).toMatchObject({ item: { number: 13 } });
    // a closable one is closed next: counted
    expect(flowRunning([flowItem({ number: 14, ...progress, tasks: { total: 3, done: 3, doneAt: null }, closable: true })])).toBe(1);
    // on hold is stopped
    expect(flowStopped([flowItem({ number: 15, ...progress, onHold: true })])).toBe(1);
  });

  test("flowHeldLine: says how many in-progress flow PBIs were left out of the count", () => {
    const a = flowItem({ number: 4077, priority: "P1" });
    const stuck = flowItem({ number: 10, ...progress, lastTask: asked });
    const all = [working, stuck, a];
    expect(flowRunning(all)).toBe(1);
    expect(flowHeldLine(flowHeldIn(all, "implement", limit(1, all)), limit(1, all))).toBe("開発の流れの PBI は同時 1 件まで（実装中 1 件、止まっていて数に入れない 1 件）: 待ち #4077");
  });

  test("flowHeldLine: names the held PBIs with the limit and the running count; null when none", () => {
    const a = flowItem({ number: 4077, priority: "P1" });
    const b = flowItem({ number: 4078, priority: "P2" });
    expect(flowHeldLine(flowHeldIn([working, a, b], "implement", limit(1, [working])), limit(1, [working]))).toBe("開発の流れの PBI は同時 1 件まで（実装中 1 件）: 待ち #4077 #4078");
    expect(flowHeldLine(flowHeldIn([a], "implement", limit(1, [a])), limit(1, [a]))).toBeNull();
    const second = flowItem({ number: 5, stage: "in-progress", projectStatus: "In progress", activeTaskId: "t2" });
    const all = [working, second, a];
    expect(flowHeldLine(flowHeldIn(all, "implement", limit(2, all)), limit(2, all))).toBe("開発の流れの PBI は同時 2 件まで（実装中 2 件）: 待ち #4077");
  });
});


describe("chooseProcess: the candidate a request starts in", () => {
  const defs = (max: number) => [
    parseProcessDef("---\nid: p0-pipeline\nversion: 1\ntitle: p0\n---\n", "p0.md"),
    parseProcessDef(`---\nid: p1-direct\nversion: 1\ntitle: p1\nauto: { maxBodyChars: ${max}, excludeLabels: [needs-decision, flow-improvement] }\n---\n`, "p1.md"),
  ];
  const small = item({ type: "request", stage: "request", bodyChars: 120, labels: ["type:request"] });
  const big = item({ type: "request", stage: "request", bodyChars: 2000, labels: ["type:request"] });

  test("a small request goes direct and a large one to the pipeline, each with its reason", () => {
    expect(chooseProcess(small, defs(600))).toEqual({ process: "p1-direct", reason: "auto direct: 本文 120 字 ≤ 600" });
    const c = chooseProcess(big, defs(600));
    expect(c.process).toBe("p0-pipeline");
    expect(c.reason).toBe("auto pipeline: p1-direct: 本文 2000 字 > 600");
  });

  test("changing only the definition's maxBodyChars changes the choice of the same request", () => {
    expect(chooseProcess(big, defs(600)).process).toBe("p0-pipeline");
    expect(chooseProcess(big, defs(5000)).process).toBe("p1-direct");
    expect(chooseProcess(small, defs(100)).process).toBe("p0-pipeline");
  });

  test("an excluded label keeps it out of the candidate; direct-returned goes to the pipeline", () => {
    const flagged = item({ ...small, labels: ["type:request", "needs-decision"] });
    expect(chooseProcess(flagged, defs(600))).toEqual({ process: "p0-pipeline", reason: "auto pipeline: p1-direct: ラベル needs-decision" });
    expect(chooseProcess(item({ ...small, labels: ["direct-returned"] }), defs(600))).toEqual({ process: "p0-pipeline", reason: "direct returned" });
  });

  const ws = { id: "ws_meta", name: "switchboard" };
  const asItem = (body: string) => toItem(raw(["type:request"], body), 11, ws)!;
  const req = (text: string, extra = "") => `## 要望\n\n${text}\n\n## 原文\n\n\`\`\`text\n元の文\n\`\`\`\n${extra}`;

  test("two requests with the same 要望 and a different 解釈メモ length start in the same candidate", () => {
    const short = asItem(req("ボタンの色を直す"));
    const long = asItem(req("ボタンの色を直す", `\n## 解釈メモ\n\n${"あ".repeat(2000)}\n`));
    expect(long.bodyChars).toBeGreaterThan(600);
    expect(long.requestChars).toBe(short.requestChars);
    expect(chooseProcess(long, defs(600))).toEqual(chooseProcess(short, defs(600)));
    expect(chooseProcess(long, defs(600)).process).toBe("p1-direct");
  });

  test("a request's own words are counted without the fence lines; a body with no 要望 section is counted whole", () => {
    expect(requestTextChars("## 要望\n\n```text\nabc\n```\n")).toBe(3);
    expect(requestTextChars("## 原文\nabc")).toBeNull();
    // a `## 要望` line quoted inside a fence is not the section, and an empty section has no words: both fall back to the body
    const quoted = asItem("## 原文\n\n```text\n## 要望\nabc\n```\n" + "x".repeat(900));
    expect(quoted.requestChars).toBeNull();
    expect(chooseProcess(quoted, defs(600)).process).toBe("p0-pipeline");
    expect(requestTextChars("## 要望\n\n```text\n```\n## 解釈メモ\nabc")).toBeNull();
    const plain = asItem("x".repeat(700));
    expect(plain.requestChars).toBeNull();
    expect(chooseProcess(plain, defs(600))).toEqual({ process: "p0-pipeline", reason: "auto pipeline: p1-direct: 本文 700 字 > 600" });
  });

  test("the reason names the request's own words and their length", () => {
    expect(chooseProcess(asItem("## 要望\n\nabcde\n"), defs(600)).reason).toBe("auto direct: 要望の文 5 字 ≤ 600");
    expect(chooseProcess(asItem(`## 要望\n\n${"a".repeat(700)}\n`), defs(600)).reason).toBe("auto pipeline: p1-direct: 要望の文 700 字 > 600");
  });

  test("the kit's own definitions: p1-direct has the criteria and p0-pipeline has none", () => {
    const kit = listProcesses();
    expect(chooseProcess(small, kit).process).toBe("p1-direct");
    expect(chooseProcess(item({ ...small, labels: ["flow-improvement"] }), kit).process).toBe("p0-pipeline");
  });
});

describe("release review", () => {
  // local bare repositories named like the public copy and a development repository (a remote on the network would make the tag fetch slow)
  const remote = (name: string) => { const d = join(mkdtempSync(join(tmpdir(), "sb-origin-")), name); mkdirSync(d, { recursive: true }); Bun.spawnSync(["git", "init", "-q", "--bare", d]); return d; };
  const PUBLIC = remote("o/pub");
  const PLAN = [{ value: "plan", label: "plan", description: "" }];
  const reviews = () => core!.db.listTasks().filter((t) => t.origin === "release-review");
  const reply = (sha: string, text: string) => text.replace("SHA", sha);
  const fence = (j: object) => "確認した。\n```switchboard-release-review\n" + JSON.stringify(j) + "\n```";

  test("a public copy's clone: a tag with no check is not promoted, one read-only Task is made, and three entrances at once make one", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC, promoteDelayMs: 100 });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      const id = await backlogNextSchedule(base);
      await Promise.all([runSchedule(base, id), runSchedule(base, id)]);
      await settle(() => reviews().length > 0);
      await Bun.sleep(300);
      expect(r.promoted).toEqual([]);
      expect(reviews()).toHaveLength(1);
      const t = reviews()[0]!;
      expect(t).toMatchObject({ permissionMode: "plan", origin: "release-review", title: "リリースの差分確認 v0.2.0" });
      // the cwd is the folder that holds the tag's tree, not the tree: the tag's own runner settings (hooks) are not read
      expect(t.cwd.endsWith("/release-review/v0.2.0")).toBe(true);
      expect(existsSync(join(t.cwd, "tree", ".git"))).toBe(true);
      expect(existsSync(join(t.cwd, "diff.patch"))).toBe(true);
      expect(await releaseHold(base)).toMatchObject({ tag: "v0.2.0", failed: false, reason: "v0.2.0 の差分を確認中" });
      // the check ends ok: the tree and the diff go and the tag is asked for
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      // the stage Tasks backlog-next started meanwhile hold the promotion like any running Task until they end
      for (let i = 1; i < claude.count(); i++) claude.end(i);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      await settle(() => !existsSync(t.cwd));
      expect(existsSync(t.cwd)).toBe(false);
      expect(reviews()).toHaveLength(1);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  for (const [name, summary, hold] of [
    ["concern", fence({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch" }] }), "v0.2.0 の差分の確認で懸念 1 件"],
    ["unreadable", "問題ありません", "v0.2.0 の差分を確かめられなかった: 最後の返答が結果の書式"],
  ] as const) {
    test(`a public copy's clone: a ${name} result is not promoted and shows in hold.reason`, async () => {
      const r = await releasedDaemon([], false, { origin: PUBLIC });
      const claude = endableClaude(PLAN);
      try {
        const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
        await claude.started(1);
        claude.emit(0, { t: "session.end", status: "ok", summary });
        await settle(() => ((db) => db.lastReply(reviews()[0]!.id) !== null)(core!.db));
        await Bun.sleep(300);
        expect(r.promoted).toEqual([]);
        expect(reviews()).toHaveLength(1);
        expect(((await releaseHold(base)) as { reason: string; failed: boolean }).reason).toContain(hold);
        expect(((await releaseHold(base)) as { failed: boolean }).failed).toBe(false);
        // the hold is not a failure of the version: backlog-next goes on picking (no promotion answer)
        const res = await runSchedule(base, await backlogNextSchedule(base));
        expect(await res.json()).not.toHaveProperty("promotion");
      } finally {
        r.rescue.stop(true);
        rmSync(r.repo, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test("a public copy's clone: a check stopped by the usage limit keeps its folder for the resume and is not promoted", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const t = reviews()[0]!;
      claude.emit(0, { t: "session.end", status: "error", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" });
      await settle(() => core!.db.getTask(t.id)?.resumeAt != null);
      await Bun.sleep(300);
      expect(existsSync(join(t.cwd, "tree"))).toBe(true);
      expect(r.promoted).toEqual([]);
      expect(((await releaseHold(base)) as { reason: string }).reason).toContain("v0.2.0 の差分を確かめられなかった: ランナーの使用上限");
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  const releaseOf = async (base: string) => (await (await fetch(`${base}/api/daemon/release`)).json()) as { latestRelease: { tag: string; sha: string; ahead: number | null } | null; review: { state: string; tag: string; findings: unknown[]; taskId: string } | null; hold: { reason: string } | null };
  const recheck = (base: string) => fetch(`${base}/api/daemon/release/review`, { method: "POST" });

  test("GET /api/daemon/release shows latestRelease, review and hold, and the re-check starts a new check only from failed or concern (202 / 409)", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const running = await releaseOf(base);
      expect(running.latestRelease).toEqual({ tag: "v0.2.0", sha: r.sha, ahead: 1 });
      expect(running.review).toMatchObject({ state: "running", tag: "v0.2.0", findings: [] });
      expect(running.hold?.reason).toContain("差分を確認中");
      expect((await recheck(base)).status).toBe(409); // running
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "concern", findings: [{ path: "a.ts", why: "fetch" }] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      await Bun.sleep(300);
      const concern = await releaseOf(base);
      expect(concern.review).toMatchObject({ state: "concern", findings: [{ path: "a.ts", why: "fetch" }], taskId: reviews()[0]!.id });
      expect(concern.hold?.reason).toContain("懸念 1 件");
      const again = await recheck(base);
      expect([again.status, await again.json()]).toEqual([202, { started: "review", tag: "v0.2.0" }]);
      await settle(() => reviews().length === 2);
      expect(reviews()).toHaveLength(2);
      expect((await releaseOf(base)).review?.state).toBe("running");
      expect((await recheck(base)).status).toBe(409);
      expect(r.promoted).toEqual([]);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("the re-check of a check stopped by the usage limit cancels its resume, so the old one cannot run again in the shared folder", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, r.env, undefined, undefined, CHECK);
      await claude.started(1);
      const old = reviews()[0]!;
      claude.emit(0, { t: "session.end", status: "error", summary: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" });
      await settle(() => core!.db.getTask(old.id)?.resumeAt != null);
      expect((await releaseOf(base)).review?.state).toBe("failed");
      expect((await recheck(base)).status).toBe(202);
      await settle(() => reviews().length === 2);
      expect(core!.db.getTask(old.id)?.resumeAt).toBeNull();
      expect((await releaseOf(base)).review?.state).toBe("running");
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("the re-check is refused (409) when the check found no concern", async () => {
    const ok = await releasedDaemon([], false, { origin: PUBLIC });
    const claude = endableClaude(PLAN);
    try {
      const base = await boot(fakeGh().gh, claude.adapter, ok.env, undefined, undefined, CHECK);
      await claude.started(1);
      claude.emit(0, { t: "session.end", status: "ok", summary: fence({ verdict: "ok", findings: [] }) });
      await settle(() => core!.db.lastReply(reviews()[0]!.id) !== null);
      expect((await recheck(base)).status).toBe(409);
    } finally {
      ok.rescue.stop(true);
      rmSync(ok.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a development origin has latestRelease and review null and refuses the re-check", async () => {
    const dev = await releasedDaemon([], false, { origin: remote("o/dev") });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, dev.env, undefined, undefined, CHECK);
      expect(await releaseOf(base)).toMatchObject({ latestRelease: null, review: null });
      expect((await recheck(base)).status).toBe(409);
    } finally {
      dev.rescue.stop(true);
      rmSync(dev.repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("outside sb-rescue (managed: false) a public copy's clone still shows latestRelease from HEAD, and starts no check", async () => {
    const r = await releasedDaemon([], false, { origin: PUBLIC });
    try {
      const base = await boot(fakeGh().gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: r.repo }, undefined, undefined, CHECK);
      const rel = await releaseOf(base);
      expect(rel).toMatchObject({ managed: false, latestRelease: { tag: "v0.2.0", sha: r.sha, ahead: 0 } });
      expect(rel.review).toBeUndefined();
      expect((await recheck(base)).status).toBe(409);
      expect(reviews()).toHaveLength(0);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  });

  test("a clone of a repository that is not the public copy starts no check and keeps promoting", async () => {
    const r = await releasedDaemon([], false, { origin: remote("o/dev") });
    try {
      await boot(fakeGh().gh, holdingClaude().adapter, r.env, undefined, undefined, CHECK);
      await settle(() => r.promoted.length > 0);
      expect(r.promoted).toEqual([r.sha]);
      expect(reviews()).toHaveLength(0);
    } finally {
      r.rescue.stop(true);
      rmSync(r.repo, { recursive: true, force: true });
    }
  });
});

test("developSelf off: a stage on the meta workspace is refused", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf: false }) })).status).toBe(200);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("Switchboard 自体を開発しない設定です");
  expect(core!.db.listTasks()).toHaveLength(0);
});
