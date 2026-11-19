/**
 * The common setup of the test files that start the daemon or send the stored backlog: the fake runners and fake
 * GitHubs, the helpers that boot `startServer`, the fixtures, and the hooks that stop what a test started (the daemon,
 * the queue timers `stopArmedQueues` clears, the syncs). A test file imports what it uses and calls its family's
 * `use…` once at its top, so no file depends on another having run. Three families, in the order below.
 */
import { beforeAll, afterAll, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, readdirSync, symlinkSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.ts";
import { startServer as startDaemon } from "./server.ts";
import type { AgentEvent, RunnerId, StartOptions, RunnerDetection, RunnerAdapter, RunnerSession, BacklogAction, Task, Backlog, BacklogItem, BacklogIssueDetail, BacklogQueue, BacklogSource, BacklogIssueData } from "@switchboard/protocol";
import type { CoreServer, StartServerOptions } from "./server.ts";
import { stopArmedQueues } from "./tasks/state.ts";
import type { GhRunner } from "./backlog-gh.ts";
import type { RawBacklogIssue } from "./backlog-item.ts";
import type { ReleaseState } from "./promotion.ts";
import type { Suggester } from "./routing.ts";
import { importing } from "../fixtures/github-import.ts";
import { pbiProgress } from "./pbi-progress.ts";
import { Db, SEND_DELAY_MS } from "./db.ts";
import { fakeGithub as makeFakeGithub } from "./backlog-fake-github.ts";
import type { Issue } from "./backlog-fake-github.ts";
import { answerStoredDecision as answerWindowed, commentStoredIssue as commentWindowed } from "./backlog-edit.ts";
import { BacklogSync } from "./backlog-sync.ts";
import { sendGithubOperations } from "./backlog-send.ts";

/* ---------- The daemon's API with a scripted runner: the tests of `*.api.test.ts` that start `startServer` on a fake adapter. ---------- */

/**
 * The judge is on by default and would ask these daemons' fake runners to judge every finished turn, adding
 * sessions the tests count. Here it never answers, unless a test passes its own.
 */
export const startServer: typeof startDaemon = (cfg, adapters, opts = {}) => startDaemon(cfg, adapters, { judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), titleSuggester: () => new Promise(() => undefined), ...opts });

/** A gh that answers nothing: the ledger summary reads GitHub's budget, which a test must not ask the real GitHub for. */
export const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });

// Test daemons must not read the developer's real ~/.claude/projects: point the importer at a folder that does not exist.
export const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/** A scripted fake runner: replays the recorded Claude fixture events, pauses on permission.ask until answered. */
export function fakeAdapter(script: AgentEvent[], opts: { id?: RunnerId; lingers?: boolean; starts?: StartOptions[]; sends?: string[]; modes?: string[]; dangerModes?: string[]; defaultMode?: string; liveSwitch?: boolean; refuseMode?: string; modeChanges?: string[]; slowMs?: number; gate?: Promise<unknown>; closeMs?: number; models?: string[]; bedrockModels?: string[]; efforts?: string[]; cliDefaultModel?: () => string | undefined; detect?: () => Partial<RunnerDetection>; forks?: { min: string }; hasSession?: (id: string) => boolean } = {}): RunnerAdapter {
  return {
    id: opts.id ?? "claude",
    ...(opts.forks ? { forks: true, forkMinVersion: opts.forks.min } : {}),
    hasSession: opts.hasSession,
    models: opts.models?.map((value) => ({ value, label: value })),
    bedrockModels: opts.bedrockModels?.map((value) => ({ value, label: value })),
    efforts: opts.efforts?.map((value) => ({ value, label: value })),
    cliDefaultModel: opts.cliDefaultModel,
    permissionModes: opts.modes?.map((value) => ({ value, label: value, description: value, danger: opts.dangerModes?.includes(value) || undefined })),
    defaultPermissionMode: opts.defaultMode,
    async detect() {
      return { available: true, version: "fake", ...opts.detect?.() };
    },
    start(startOpts: StartOptions, emit) {
      opts.starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      let i = 0;
      let waitingFor: string | null = null;
      let gone = false; // closed/aborted: a pump scheduled with slowMs must not emit into a stopped daemon
      const pump = () => {
        if (gone) return;
        while (i < script.length) {
          const ev = script[i++]!;
          // like the real adapters: the pending id is registered before the ask is emitted (a rule may answer synchronously)
          if (ev.t === "permission.ask") waitingFor = ev.id;
          emit(ev);
          if (ev.t === "permission.ask" && waitingFor === ev.id) return;
        }
        // Like `claude -p --input-format stream-json`, a lingering runner stays alive after the turn until closed.
        if (!opts.lingers) resolveExit(0);
      };
      // slowMs keeps a turn in flight long enough for a test to observe "running"; gate holds a pump until the test releases it (an order, not a duration)
      const schedule = (fn: () => void) => (opts.gate ? void opts.gate.then(fn) : opts.slowMs ? void setTimeout(fn, opts.slowMs) : queueMicrotask(fn));
      schedule(pump);
      const session: RunnerSession = {
        send: (text) => {
          opts.sends?.push(text);
          emit({ t: "message.delta", role: "user", text });
          i = 0;
          schedule(pump);
        },
        respondPermission: (id, decision, _reason, by = "user") => {
          if (waitingFor !== id) throw new Error("unexpected permission id");
          waitingFor = null;
          emit({ t: "permission.resolved", id, decision, by });
          queueMicrotask(pump);
        },
        abort: async () => {
          // like the real adapters: only an in-flight turn is reported as aborted
          if (i < script.length) emit({ t: "session.end", status: "aborted", summary: "aborted" });
          gone = true;
          resolveExit(null);
        },
        setPermissionMode: opts.liveSwitch
          ? async (mode) => {
              if (mode === opts.refuseMode) throw new Error("refused by runner");
              opts.modeChanges?.push(mode);
            }
          : undefined,
        close: async () => {
          gone = true;
          if (opts.closeMs) await new Promise((r) => setTimeout(r, opts.closeMs)); // a real runner takes a moment to exit
          resolveExit(0);
        },
        exited,
      };
      return session;
    },
  };
}

export const SCRIPT: AgentEvent[] = [
  { t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp", model: "claude-haiku-4-5-20251001" },
  { t: "quota", runner: "claude", windows: { five_hour: { utilization: 0.16, resetsAt: 1 }, seven_day: { utilization: 0.02, resetsAt: 2 } } },
  { t: "tool.call", id: "tu1", name: "Write", input: { file_path: "/tmp/x" }, summary: "/tmp/x" },
  { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "x" },
  { t: "tool.result", id: "tu1", ok: true, summary: "ok" },
  { t: "message.delta", role: "assistant", text: "done" },
  { t: "usage", source: "reported", model: "claude-haiku-4-5-20251001", inputTokens: 18, outputTokens: 385, cacheReadTokens: 23760, cacheWriteTokens: 8064, costUsd: 0.021436 },
  { t: "session.end", status: "ok", summary: "done" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const j = (r: Response) => r.json() as Promise<any>;

export let home: string;
export let core: Awaited<ReturnType<typeof startServer>>;
export let base: string;
const savedPath = process.env.PATH;
let noDockerPath = "";

/**
 * The daemon the tests of one file share (`home`, `core`, `base`), started before the file's first test and stopped after
 * its last. A test file of the daemon's API calls this once at its top; each file gets its own daemon.
 */
export function useCoreDaemon(): void {
  beforeAll(async () => {
    // The end of a task also runs the container cleanup, which records a status line a moment after `done` when `docker` is on PATH
    // (the CI image has the CLI and no dockerd). Tests that read a task's events or times right after `done` would see that line
    // arrive in the middle of their reads, so the file runs without docker on PATH; none of it uses docker (containers.test.ts does).
    // A directory that holds `docker` stands in as a copy of itself without it, so what else lives there (bun, gh, node) is still found.
    const shim = mkdtempSync(join(tmpdir(), "switchboard-test-nodocker-"));
    noDockerPath = shim;
    process.env.PATH = (savedPath ?? "").split(delimiter).map((d, i) => {
      if (d === "" || !existsSync(join(d, "docker"))) return d;
      const copy = join(shim, String(i));
      mkdirSync(copy);
      for (const name of readdirSync(d)) if (name !== "docker") try { symlinkSync(join(d, name), join(copy, name)); } catch { /* a name that cannot be linked is left out */ }
      return copy;
    }).join(delimiter);
    home = mkdtempSync(join(tmpdir(), "switchboard-test-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    core = await startServer(cfg, [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: NO_GH });
    base = `http://127.0.0.1:${core.server.port}`;
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    rmSync(noDockerPath, { recursive: true, force: true });
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });
}

export async function getTask(id: string) {
  return fetch(`${base}/api/tasks/${id}`).then(j);
}

export async function waitFor(pred: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

/* ---------- The backlog over a fake GitHub: the tests of `backlog-*.api.test.ts`, `promotion.api.test.ts`, `release-review.api.test.ts` and `github-budget.api.test.ts`. ---------- */

// the writer of the waits, read at run time: scripts/ is not type-checked under core's settings
const guard = "../../../scripts/parallel-guard.ts";

/** The meta workspace is this checkout, whose origin is not the fake gh's acme/app: no origin to check (tasks.test.ts checks it). */
export const FAKE_ORIGIN = () => null;

export const { releaseBody } = (await import(guard)) as { releaseBody: (reason: string, waits?: number[], overlap?: boolean, after?: string) => string };

const FIXTURE_STAGE_NAMES: Record<string, BacklogAction> = { "PBI にする": "to-pbi", "Task に分解": "to-tasks", "実装": "complete", "状況確認": "check", "閉じる": "close" };

/** The `stage` a fixture Task gets from its title, as the button's Task would have it. */
export const fixtureStage = (title: string): Task["stage"] => {
  const m = /^#(\d+) (PBI にする|Task に分解|実装|状況確認|閉じる): /.exec(title);
  return m ? { issue: Number(m[1]), action: FIXTURE_STAGE_NAMES[m[2]!]! } : null;
};

export const pages = await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json() as unknown[];

export const decisions = await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json() as unknown;

/** A fake `gh` answering from the fixtures: two GraphQL pages (the second after CURSOR1), the needs-decision comments, issue writes. */
export function fakeGh(fail?: { code: number; stderr: string }, failIssueWrite = false) {
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
export function decomposedGh() {
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
export function openTaskAndConfirmationGh() {
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

/** The prompt a decomposed PBI in 分解待ち is started with: make it Ready, do not decompose it again. */
export const DECOMPOSED_READY = (n: number, total: number) => `PBI #${n} は Task（sub-issue ${total} 件）に分解済みですが、Project の Status が Ready になっていません。`;

/** fakeGh, answering GitHub's GraphQL budget with `remaining` of 5,000 points, back at `resetAt`. */
export function budgetGh(remaining: number, resetAt = new Date(Date.now() + 40 * 60_000).toISOString()) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    if (args.some((a) => a.includes("rateLimit"))) return { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining, resetAt } } }), stderr: "" };
    return fake.gh(args, cwd);
  };
  const hhmm = `${String(new Date(resetAt).getHours()).padStart(2, "0")}:${String(new Date(resetAt).getMinutes()).padStart(2, "0")}`;
  return { ...fake, gh, resetAt, hhmm };
}

/** GitHub at its primary limit while `limited.on` (every API read refused with RATE_LIMITED); the fake answers before that. */
export function limitedGh() {
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
export async function refreshed(base: string, refresh = true): Promise<Backlog> {
  let body = (await (await fetch(`${base}/api/backlog${refresh ? "?refresh=1" : ""}`)).json()) as Backlog;
  while (body.syncs.some((x) => x.syncing)) {
    await Bun.sleep(5);
    body = (await (await fetch(`${base}/api/backlog`)).json()) as Backlog;
  }
  return body;
}

/** The variables of a backlog test file that its tests assign: the daemon `boot` started, its home, and the fake GitHub's open PRs. */
export interface BacklogDaemonState { core: CoreServer | undefined; home: string | undefined; openPulls: Array<Record<string, unknown>> }
/** Those of the test file that runs now: the helpers below read and set them. */
let backlogState: BacklogDaemonState;
const savedProjectUrl = process.env.SWITCHBOARD_PROJECT_URL;
/** A backlog test file calls this once at its top with accessors of its own `core`, `home` and `openPulls`: each test starts without the Project URL and ends with its daemon stopped and its home removed. */
export function useBacklogDaemon(state: BacklogDaemonState): void {
  backlogState = state;
  beforeEach(() => { backlogState = state; delete process.env.SWITCHBOARD_PROJECT_URL; });
  afterEach(async () => {
    if (state.core) await state.core.stop();
    // a test that boots twice leaves its first server's manager: its queue timer would tick on the removed home
    stopArmedQueues();
    if (state.home) rmSync(state.home, { recursive: true, force: true });
    state.core = state.home = undefined;
    state.openPulls = [];
    if (savedProjectUrl !== undefined) process.env.SWITCHBOARD_PROJECT_URL = savedProjectUrl;
  });
}

export async function boot(gh: GhRunner, adapter: RunnerAdapter | RunnerAdapter[] = { id: "claude", detect: async () => ({ available: false }), start() { throw new Error("no runs"); } }, env: Record<string, string> = {}, llmSuggester?: () => Suggester, outer: (gh: GhRunner) => GhRunner = (g) => g, extra: Partial<StartServerOptions> = {}) {
  backlogState.home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: backlogState.home, SWITCHBOARD_KNOWLEDGE: join(backlogState.home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(backlogState.home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...env });
  // as the daemon starts: every workspace is imported at boot; the tests begin once it is stored
  backlogState.core = await startDaemon(cfg, [adapter].flat(), { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: outer(importing(gh, () => backlogState.openPulls)), llmSuggester, backlogAutoImport: true, tagCi: async () => "pass" as const, ...extra }); // tagCi: the tag's CI passed, unless a test says otherwise
  const base = `http://127.0.0.1:${backlogState.core.server.port}`;
  await refreshed(base, false);
  return base;
}

/** A claude adapter that records its prompts and stays running (never ends the session). */
export function holdingClaude() {
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

export const metaId = () => backlogState.core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id;

/** What waits to be sent to GitHub: per operation, its Issue's number, kind, field and what is sent. */
export const queued = () =>
  backlogState.core!.db.listPendingBacklogOperations().map((o) => {
    const issue = backlogState.core!.db.getBacklogRecord({ ...o, objectKind: "issue", externalId: o.issue });
    return [((issue?.local ?? issue?.remote) as { number: number } | null)?.number, o.kind, o.field, o.payload];
  });

export const metaName = () => backlogState.core!.db.listWorkspaces().find((w) => w.kind === "meta")!.name;

/** POST .../start; the body names the meta workspace unless it names another. */
export const start = (base: string, n: number | string, body: object) =>
  fetch(`${base}/api/backlog/${n}/start`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

/** The fixtures' gh with comments of its own on Issue 304 (Ready) and Issue 307 (in progress), and `states` answering the waits' query. */
export function waitsGh(own: { i304?: Array<[string, string]>; i307?: Array<[string, string]> }, states: Record<string, unknown> = {}, tasks307?: unknown[], errors?: unknown[]) {
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

export const waitsOfItem = async (base: string, n: number) => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === n)!;

export const STOPPED = "2026-09-30T00:00:00Z";

/** One wait of an item as the daemon gives it: a prerequisite with no PBI found unless said. */
export function wait(number: number, kind: "issue" | "pr", open: boolean | null, more: { reason?: "overlap" | "prerequisite"; pbi?: BacklogItem["waits"][number]["pbi"] } = {}): BacklogItem["waits"][number] {
  return { number, kind, open, state: open === null ? "missing" : open ? "pending" : "met", reason: more.reason ?? "prerequisite", pbi: more.pbi ?? null };
}

/** The fixtures' comments answer with Tasks under the in-progress PBIs 305 and 307. */
export function taskDecisionGh(tasks: { i305: unknown[]; i307: unknown[] }, own: { i305?: unknown[]; i307?: unknown[] } = {}) {
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

export const subTask = (number: number, state: string, labels: string[], comments: Array<[string, string]>, updatedAt?: string) =>
  ({ number, state, updatedAt, labels: { nodes: labels.map((name) => ({ name })) }, comments: { nodes: comments.map(([body, createdAt]) => ({ body, createdAt })) } });

/* ---------- edits and new Issues kept here, sent later ---------- */

export const patch = (base: string, ref: number | string, body: object) => fetch(`${base}/api/backlog/${ref}`, { method: "PATCH", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

export const detailOf = async (base: string, ref: number | string) => (await (await fetch(`${base}/api/backlog/${ref}?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;

/* ---------- a choice on a held conflict ---------- */

/** An import that read GitHub's Issue n with `over` (as the next import would store it). */
export function importedAs(n: number, over: Record<string, unknown>, fetchState: "fetched" | "forbidden" = "fetched") {
  const db = backlogState.core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const rec = db.listBacklogRecords(source, "issue").find((r) => (r.remote as { number: number } | null)?.number === n)!;
  db.putBacklogSnapshot(source, { records: [fetchState === "fetched" ? { objectKind: "issue", externalId: rec.externalId, remote: { ...(rec.remote as object), ...over } as never, fetchState } : { objectKind: "issue", externalId: rec.externalId, remote: null, fetchState }], cursor: db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
}

const bareItem = (over: Partial<BacklogItem>): Omit<BacklogItem, "progress"> => ({
  number: 1, title: "t", url: "u", type: "pbi", stage: "ready", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, answeredAt: null, heldAt: null, confirmations: [], postMerge: [], closable: false, onHold: false, flow: false, bodyChars: 0, requestChars: null, kind: null, requestFrom: null, origin: null, labels: [], waits: [], waitsAt: null, waitsUntil: null, overlap: null, prereqs: [], stopSummary: [], mockupTask: null, mockups: [], sync: { state: "synced", reason: null, lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" }, workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});

/** A hand-built item with the answers `pbiProgress` gives for its stage and Tasks (what the daemon's read puts on it). */
export const item = (over: Partial<BacklogItem>): BacklogItem => {
  const i = bareItem(over);
  const p = pbiProgress({ pbi: i.type === "pbi", decision: i.stage === "needs-decision", status: i.stage === "in-progress" ? "In progress" : null, tasks: i.tasks ?? { total: 0, done: 0 }, others: 0, confirms: i.confirmations.map((c) => c.n), postMerge: i.postMerge.map((c) => c.n), decided: [], held: false });
  return { ...i, progress: over.progress ?? { closableByApi: p.closableByApi, closesOnAnswer: p.closesOnAnswer, checking: p.checking } };
};

/** A fake meta checkout carries the kit's process candidates, as the real one does: a stage start reads `ops-kit/processes/p0-pipeline.md` from the meta workspace. */
export function withProcesses(repo: string): void {
  cpSync(join(import.meta.dir, "../../../ops-kit/processes"), join(repo, "ops-kit/processes"), { recursive: true });
}

/** moreReadyGh(309, 310) whose Ready PBIs 304 / Issue 309 / Issue 310 each have one open Task naming the file given. */
export function overlapReadyGh(files: { 304: string; 309: string; 310: string }, bodies: Partial<Record<304 | 309 | 310, string>> = {}): GhRunner {
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

export async function backlogNextSchedule(base: string, budgetUsd?: number, model?: string, effort?: string) {
  const meta = backlogState.core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next", budgetUsd, model, effort }) });
  expect(r.status).toBe(201);
  return (await r.json() as { id: string }).id;
}

/**
 * A 閉じる of the fixtures' closable Issue 307 that finished with no update since, on each workspace: backlog-next leaves
 * it, so a test of the implement slot starts Ready Issue 304 there.
 */
export function closeTried(...workspaceIds: string[]) {
  const now = Date.now();
  for (const workspaceId of workspaceIds.length ? workspaceIds : [metaId()]) backlogState.core!.db.insertTask({ id: `tsk_close307_${workspaceId}`, workspaceId, title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", runner: "claude", cwd: backlogState.home!, scope: [backlogState.home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 閉じる: PBI: Task が全部閉じた実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
}

/** The Tasks but closeTried's. */
export const startedTasks = () => backlogState.core!.db.listTasks().filter((t) => !t.id.startsWith("tsk_close307_"));

export const runSchedule = (base: string, id: string) => fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });

export const scheduleLogAll = async (base: string) => await (await fetch(`${base}/api/schedules/log`)).json() as string[];

export const scheduleLog = async (base: string) => (await scheduleLogAll(base)).at(-1) ?? "";

/** The backlog queue's API on a test daemon, and a wait for what it starts. */
export const putQueue = (base: string, body: object) => fetch(`${base}/api/backlog/queue`, { method: "PUT", body: JSON.stringify(body) });

export const getQueue = async (base: string) => (await (await fetch(`${base}/api/backlog/queue`)).json()) as BacklogQueue;

export async function until(f: () => boolean | Promise<boolean>, ms = 5000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
    if (await f()) return;
    await Bun.sleep(20);
  }
}

/** Stops the daemon a test booted and removes its home, for a second boot in the same test. */
export async function shutdown() {
  await backlogState.core!.stop();
  rmSync(backlogState.home!, { recursive: true, force: true });
  backlogState.core = backlogState.home = undefined;
}

/** A fake gh for the meta workspace and two more (lib, app), each its own repository; `broken` answers 404 for every call. */
/** backlog-next's slots of every registered workspace, through the API; the last response. */
export async function sweepAll(base: string, sweep: { implement?: number; plan?: number }): Promise<Response> {
  let r: Response | undefined;
  for (const w of backlogState.core!.db.listWorkspaces()) r = await fetch(`${base}/api/workspaces/${w.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep }) });
  return r!;
}

export async function threeWorkspaces(adapter: RunnerAdapter, broken?: "lib", inner: GhRunner = fakeGh().gh) {
  const dirs: Record<string, string> = {};
  const gh: GhRunner = async (args, cwd) => {
    const name = Object.keys(dirs).find((k) => dirs[k] === cwd);
    if (name && name === broken) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (name && args[0] === "repo") return { code: 0, stdout: `acme/${name} true\n`, stderr: "" };
    return inner(args, cwd);
  };
  const base = await boot(gh, adapter);
  backlogState.core!.db.setSetting("settings", { maxRunners: 8 }); // this test counts the Tasks a firing starts, not the run slots
  const ids: Record<string, string> = { switchboard: backlogState.core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id };
  for (const name of ["lib", "app"]) {
    dirs[name] = mkdtempSync(join(backlogState.home!, `${name}-`));
    ids[name] = ((await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dirs[name], name }) })).json()) as { id: string }).id;
  }
  return { base, ids, dirs };
}

/** The fixtures' gh with more Ready PBIs on the first page: copies of Issue 304 numbered `numbers`, with no comments. */
export function moreReadyGh(...numbers: number[]): GhRunner {
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

/** A checkout with one commit tagged v0.2.0, and a fake sb-rescue whose current release is another commit. */
export async function releasedDaemon(history: ReleaseState["history"] = [], runningNewer = false, { busy = null, promoteDelayMs = 0, refuse = false, statusDelayMs = 0, origin, source, newer = true, treeFails = false, withoutRestart = false, oldWithoutRestart = false, restartNeeded = false, building = false }: { oldWithoutRestart?: boolean; building?: boolean; busy?: string | null; promoteDelayMs?: number; refuse?: boolean; statusDelayMs?: number; origin?: string; source?: boolean; newer?: boolean; treeFails?: boolean; withoutRestart?: boolean; restartNeeded?: boolean } = {}) {
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
  // withoutRestart: a sb-rescue whose `ifNoRestart` never restarts (its status says so); oldWithoutRestart: one that knows
  // `ifNoRestart` but goes back with a restart when the reload fails; restartNeeded: it answers such a request with 409 `restart: true`
  const asks: Array<{ commit: string; ifNoRestart?: boolean }> = [];
  const statusAsked = { pending: 0 };
  // building: a promotion that was taken stays in flight (`busy: "promote"`, `current` unchanged) until the test sets `state.busy` to null
  const state = { busy, refuse };
  // source: a sb-rescue that builds from an update source (no git). Its newest release is not the tag in the checkout, so a
  // decision made from git would show; release-tree answers with a folder of its own, as the real one does under <home>/release-review.
  const fromSource = source ? { tag: "v0.3.0", sha: "a".repeat(40), asked: [] as Array<{ commit: string; expectSha?: string }>, trees: [] as string[] } : null;
  const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status" && statusDelayMs) { statusAsked.pending++; await Bun.sleep(statusDelayMs); statusAsked.pending--; }
    if (fromSource && url.pathname === "/api/latest-release") return Response.json({ tag: fromSource.tag, sha: fromSource.sha, newer });
    if (fromSource && url.pathname === "/api/release-tree") {
      const { tag } = (await req.json()) as { tag: string };
      fromSource.trees.push(tag);
      if (treeFails) return Response.json({ error: "GitHub returned 503" }, { status: 502 });
      const dir = join(backlogState.home!, "release-review", tag); // the daemon's own home (a module variable set by boot)
      mkdirSync(join(dir, "tree"), { recursive: true });
      writeFileSync(join(dir, "diff.patch"), "diff -ru a/x b/x\n");
      return Response.json({ tag, sha: fromSource.sha, tree: join(dir, "tree"), diffFile: join(dir, "diff.patch"), stat: ["Files a/x and b/x differ"] });
    }
    if (url.pathname === "/api/status") return Response.json({ current, previous: null, ...(fromSource ? { source: "o/n" } : {}), state: "running", busy: state.busy, lastError: null, ...(withoutRestart ? { promoteWithoutRestart: true, promoteKeepsTasks: true } : {}), ...(oldWithoutRestart ? { promoteWithoutRestart: true } : {}), history: history.map((h) => ({ ...h, to: h.to === "SHA" ? sha : h.to, from: h.from === "SHA" ? sha : h.from })) });
    if (url.pathname === "/api/promote") { if (state.refuse) return Response.json({ error: "refused" }, { status: 409 }); if (promoteDelayMs) await Bun.sleep(promoteDelayMs); const asked = (await req.json()) as { commit: string; expectSha?: string; ifNoRestart?: boolean }; asks.push(asked); if (asked.ifNoRestart && restartNeeded) return Response.json({ error: "this release needs a restart", restart: true }, { status: 409 }); fromSource?.asked.push(asked); const commit = asked.expectSha ?? asked.commit; promoted.push(commit); if (building) state.busy = "promote"; else current = commit; return Response.json({ started: "promote" }, { status: 202 }); }
    return new Response("no", { status: 404 });
  } });
  return { repo, sha, promoted, asks, statusAsked, state, rescue, fromSource, env: { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` } };
}

/** A claude adapter whose turns stay running until the test ends them (`end(i)` = the i-th started Task's turn ends ok). */
export function endableClaude(permissionModes: RunnerAdapter["permissionModes"] = []) {
  const emits: Array<(ev: AgentEvent) => void> = [];
  const prompts: string[] = [];
  const adapter: RunnerAdapter = {
    id: "claude", detect: async () => ({ available: true }), permissionModes,
    start(opts, emit) {
      prompts.push(opts.prompt);
      emits.push(emit);
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  };
  const started = async (n: number) => { for (const t0 = Date.now(); emits.length < n && Date.now() - t0 < 20_000; ) await Bun.sleep(10); expect(emits).toHaveLength(n); };
  return { adapter, started, prompts, count: () => emits.length, end: (i: number) => emits[i]!({ t: "session.end", status: "ok" }), emit: (i: number, ev: AgentEvent) => emits[i]!(ev) };
}

export const releaseHold = async (base: string) => ((await (await fetch(`${base}/api/daemon/release`)).json()) as { hold: unknown }).hold;

export const settle = async (until: () => boolean) => { for (const t0 = Date.now(); !until() && Date.now() - t0 < 20_000; ) await Bun.sleep(10); };

export const CHECK = { promotionCheckMs: 50 };

export const raw = (labels: string[], body: string, status?: string): RawBacklogIssue => ({
  number: 1, title: "t", url: "u", createdAt: "c", updatedAt: "u", body, labels: { nodes: labels.map((name) => ({ name })) }, subIssuesSummary: { total: 0, completed: 0, doneAt: null },
  projectItems: { nodes: status ? [{ project: { number: 11 }, fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] } }] : [] },
});

/* ---------- Sending the edits kept here to a fake GitHub: the tests of `backlog-send*.test.ts`. ---------- */

// Sending the edits kept here to a fake GitHub: what it ends up with, and what was asked of it.

export const S: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

export const fakeGithub = () => makeFakeGithub(() => sendState.t);

/** The fake GitHub answering an import's reads too (backlog-sync.ts), from the same Issues. */
export function importsToo(g: ReturnType<typeof fakeGithub>): GhRunner {
  const raw = (i: Issue) => ({ id: i.node_id, number: i.number, title: i.title, url: "", state: i.state, body: i.body, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", milestone: null, parent: null,
    labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) }, subIssues: { totalCount: 0, nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, projectItems: { totalCount: 0, nodes: [] } });
  const page = (nodes: unknown[]) => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" });
  return async (args, cwd) => {
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/orgs/acme/projects/1\n", stderr: "" };
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes("states:[OPEN,CLOSED]")) return page([raw(g.issues.get(12)!)]);
    if (q.includes("states:OPEN")) return page([]);
    if (q.includes("issueOrPullRequest")) return { code: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries([...q.matchAll(/w(\d+): /g)].map((m) => [`w${m[1]}`, { __typename: "Issue", ...raw(g.issues.get(Number(m[1]))!) }])) } }), stderr: "" };
    return g.gh(args, cwd);
  };
}

// A comment waits SEND_DELAY_MS before it is sent (it can be taken back meanwhile); these write it as if the window had passed, so the tests that are not about the window need not move the clock. The window's own tests use `…Windowed`.
export const answerStoredDecision: typeof answerWindowed = (db, source, n, text, now = sendState.t, opts) => answerWindowed(db, source, n, text, now - SEND_DELAY_MS, opts);

export const commentStoredIssue: typeof commentWindowed = (db, source, n, text, now = sendState.t) => commentWindowed(db, source, n, text, now - SEND_DELAY_MS);

const syncs: BacklogSync[] = [];

export function makeSync(...args: ConstructorParameters<typeof BacklogSync>): BacklogSync {
  const sync = new BacklogSync(...args);
  syncs.push(sync);
  return sync;
}

/** The variables of a test file of the send that its tests read and move: the home, its database, and the clock. */
export interface SendState { dir: string; db: Db; t: number }
/** Those of the test file that runs now: the helpers below read them. */
let sendState: SendState;
/** A test file of the send calls this once at its top with accessors of its own `dir`, `db` and `t`: each test gets a new seeded database, closed and removed at its end. */
export function useSendDb(state: SendState): void {
  sendState = state;
  beforeEach(() => {
    sendState = state;
    state.dir = mkdtempSync(join(tmpdir(), "switchboard-send-"));
    state.db = new Db(join(state.dir, "switchboard.db"));
    seed(state.db);
  });
  afterEach(() => {
    for (const sync of syncs.splice(0)) sync.stop();
    state.db.close();
    rmSync(state.dir, { recursive: true, force: true });
  });
}

export const clock = () => sendState.t;

export function seed(db: Db) {
  const issue: BacklogIssueData = { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "needs-decision"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null };
  db.putBacklogSnapshot(S, { records: [
    { objectKind: "issue", externalId: "I_12", remote: issue, fetchState: "fetched" },
    { objectKind: "issue", externalId: "I_3", remote: { ...issue, number: 3, title: "親", labels: ["type:pbi"] }, fetchState: "fetched" },
    { objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Backlog" } }, fetchState: "fetched" },
  ], cursor: null, syncedAt: 1 });
}

export const send = (gh: GhRunner) => sendGithubOperations(gh, sendState.db, sendState.dir, S, clock);

// The read after a write carries the history: what another login wrote in the window is held, not lost.

export const later = () => new Date(sendState.t + 1000).toISOString();
