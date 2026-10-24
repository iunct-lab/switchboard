import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerDetection, RunnerId, RoutingStats, RunnerSession, StartOptions, Task } from "@switchboard/protocol";
import { OpsLatency, OpsLoad, OpsStops } from "@switchboard/protocol";
import { Database } from "bun:sqlite";
import { isTempDir, loadConfig, teleportWorktreePath } from "./config.ts";
import { abortOrphanedTasks, Db } from "./db.ts";
import { measureFootprint } from "./footprint.ts";
import { startServer as startDaemon } from "./server.ts";

/**
 * The judge (#493) is on by default and would ask these daemons' fake runners to judge every finished turn, adding
 * sessions the tests count. Here it never answers, unless a test passes its own.
 */
const startServer: typeof startDaemon = (cfg, adapters, opts = {}) => startDaemon(cfg, adapters, { judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), ...opts });
import type { Suggester } from "./routing.ts";
import { claudeProjectDirName } from "@switchboard/adapter-claude";
import { HistoryImporter } from "./history.ts";
import { isAuthText } from "./login.ts";
import { JUDGE_FALLBACK, JUDGE_TIMEOUT_MS, type judgeTurn } from "./judge.ts";
import type { judgeRubric } from "./rubric-judge.ts";
import { FALLBACK_DELAY_MS, fmtTime, MAX_CONSECUTIVE_STOPS, MAX_FALLBACK_DELAY_MS, RateLimitResumer, RESUME_PROMPT } from "./ratelimit.ts";
import { QUOTA_LIMIT } from "./backlog.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { MAX_STOP_RESUMES } from "./interrupted.ts";
import { StopReport } from "./stops.ts";
import { makePrivateTmp, privateTmpOf, sweepPrivateTmps, TaskManager } from "./tasks.ts";
import { Scheduler } from "./scheduler.ts";

/** A gh that answers nothing: the ledger summary reads GitHub's budget (#549), which a test must not ask the real GitHub for. */
const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });
// Test daemons must not read the developer's real ~/.claude/projects (#91): point the importer at a folder that does not exist.
const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/** A scripted fake runner: replays the recorded Claude fixture events, pauses on permission.ask until answered. */
function fakeAdapter(script: AgentEvent[], opts: { id?: RunnerId; lingers?: boolean; starts?: StartOptions[]; sends?: string[]; modes?: string[]; dangerModes?: string[]; defaultMode?: string; liveSwitch?: boolean; refuseMode?: string; modeChanges?: string[]; slowMs?: number; closeMs?: number; models?: string[]; efforts?: string[]; cliDefaultModel?: () => string | undefined; answers?: unknown[]; detect?: () => Partial<RunnerDetection> } = {}): RunnerAdapter {
  return {
    id: opts.id ?? "claude",
    models: opts.models?.map((value) => ({ value, label: value })),
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
      // slowMs keeps a turn in flight long enough for a test to observe "running"
      const schedule = (fn: () => void) => (opts.slowMs ? void setTimeout(fn, opts.slowMs) : queueMicrotask(fn));
      schedule(pump);
      const session: RunnerSession = {
        send: (text) => {
          opts.sends?.push(text);
          emit({ t: "message.delta", role: "user", text });
          i = 0;
          schedule(pump);
        },
        respondPermission: (id, decision, _reason, by = "user", answers) => {
          if (waitingFor !== id) throw new Error("unexpected permission id");
          opts.answers?.push(answers);
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

const SCRIPT: AgentEvent[] = [
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
const j = (r: Response) => r.json() as Promise<any>;

let home: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;
/** `answers` of every permission answered through the shared daemon, in order (undefined for a bare allow / deny). */
const ANSWERS: unknown[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "switchboard-test-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
  core = await startServer(cfg, [fakeAdapter(SCRIPT, { answers: ANSWERS })], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: NO_GH });
  base = `http://127.0.0.1:${core.server.port}`;
});

afterAll(async () => {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("core daemon", () => {
  test("the static web UI is served with CSP, nosniff and Referrer-Policy (index, assets, SPA fallback)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-web-csp-"));
    const webDist = join(h, "web");
    mkdirSync(join(webDist, "assets"), { recursive: true });
    const html = "<!doctype html><title>Switchboard</title>";
    const js = "console.log('app');";
    writeFileSync(join(webDist, "index.html"), html);
    writeFileSync(join(webDist, "assets/app.js"), js);
    const c = await startServer({ ...loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), webDist }, [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      for (const [path, mime, body] of [["/", "text/html", html], ["/assets/app.js", "javascript", js], ["/no/such/route", "text/html", html]]) {
        const r = await fetch(`http://127.0.0.1:${c.server.port}${path}`);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-security-policy")).toBe("default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        expect(r.headers.get("referrer-policy")).toBe("same-origin");
        expect(r.headers.get("content-type")).toContain(mime!);
        expect(await r.text()).toBe(body!);
      }
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("Cloud preparation: explicit directory adds notice; Local unchanged; missing Workspace is 404", async () => {
    const send = (body: object) => fetch(`${base}/api/tasks/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const local = await send({ cwd: home, title: "task", prompt: "explain" }).then(j);
    expect(local.cloudPreparation).toBeUndefined();
    const cloud = await send({ cwd: home, executionMode: "cloud", title: "task", prompt: "explain" }).then(j);
    expect(cloud.cloudPreparation.warnings.join(" ")).toContain("Bundle");
    const missing = await send({ executionMode: "cloud" }).then(j);
    expect(missing.cloudPreparation.warnings.join(" ")).toContain("Workspace");
    expect((await send({ workspaceId: "missing", executionMode: "cloud" })).status).toBe(404);
  });

  test("Cloud API rejects unsupported inputs before starting and refuses Local follow-ups", async () => {
    const post = (body: object) => fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cloud", prompt: "explain", executionMode: "cloud", ...body }) });
    for (const body of [{}, { cwd: home, runner: "codex" }, { cwd: home, model: "model" }, { cwd: home, budgetUsd: 1 }, { cwd: home, permissionMode: "default" }, { cwd: home, effort: "high" }, { cwd: home, shadowRunner: "codex" }, { cwd: home, attachmentIds: ["missing"] }, { cwd: home, scheduleId: "missing" }]) expect((await post(body)).status).toBe(400);
    expect((await post({ cwd: home, workspaceId: "missing" })).status).toBe(404);
    const workspaces = await fetch(`${base}/api/workspaces`).then(j);
    const meta = workspaces.find((w: { kind: string }) => w.kind === "meta");
    expect((await post({ cwd: home, workspaceId: meta.id })).status).toBe(400);
    const r = await post({ cwd: home }); expect(r.status).toBe(201); const t = await j(r); await Bun.sleep(20);
    const detail = await fetch(`${base}/api/tasks/${t.id}`).then(j);
    expect(detail.task).toMatchObject({ executionMode: "cloud", status: "running", outcome: "unknown", runnerSessionId: null, resumeAt: null });
    expect(detail.history).toBeNull();
    const send = await fetch(`${base}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "continue" }) });
    expect(send.status).toBe(409);
    await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
  });

  test("Cloud API stores official reference and never invokes automatic completion judge", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-cloud-api-"));
    const ref = { id: "session_0123456789abcdefghijklmn", url: "https://claude.ai/code/session_0123456789abcdefghijklmn" };
    let judges = 0;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "cloud.session.created", ...ref }])], { port: 0, selfdevChecks: false, gh: NO_GH, judge: async () => { judges++; throw new Error("unexpected judge"); } });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const r = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Cloud", prompt: "explain", cwd: h, executionMode: "cloud" }) });
      expect(r.status).toBe(201); const t = await j(r); await Bun.sleep(30);
      const detail = await fetch(`${b}/api/tasks/${t.id}`).then(j);
      expect(detail.task).toMatchObject({ cloudSession: ref, status: "idle", outcome: "unknown", runnerSessionId: null, resumeAt: null });
      expect(detail.history).toBeNull(); expect(judges).toBe(0);
    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });

  test("health lists runners and registers this repo as the meta workspace", async () => {
    const h = await fetch(`${base}/api/health`).then(j);
    expect(h.ok).toBe(true);
    expect(h.runners[0]).toMatchObject({ id: "claude", available: true });
    const ws = await fetch(`${base}/api/workspaces`).then(j);
    expect(ws.some((w: { kind: string }) => w.kind === "meta")).toBe(true);
  });

  test("effort (#833): health lists each runner's efforts; a task keeps the chosen one and hands it to the adapter; unknown is 400", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-effort-"));
    // a database from before #833: its tasks table has no effort column
    const raw = new (require("bun:sqlite").Database)(join(h, "switchboard.db"), { create: true });
    raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO tasks VALUES ('task_old', NULL, 'old', 'claude', '/tmp', '[]', 'done', NULL, NULL, 1, 1);`);
    raw.close();
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { efforts: ["low", "high"], starts }), fakeAdapter(SCRIPT, { id: "dak" })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const create = (body: object) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "go", ...body }) });
    try {
      const [claude, dak] = (await fetch(`${b}/api/health`).then(j)).runners;
      expect(claude.efforts).toEqual([{ value: "low", label: "low" }, { value: "high", label: "high" }]);
      expect(dak.efforts).toEqual([]); // declares none: the runner decides itself
      expect((await fetch(`${b}/api/tasks/task_old`).then(j)).task.effort).toBeNull(); // the old row reads as the CLI default

      const high = await create({ effort: "high" }).then(j);
      expect(high.effort).toBe("high");
      expect((await fetch(`${b}/api/tasks/${high.id}`).then(j)).task.effort).toBe("high");
      await waitFor(async () => starts.length === 1);
      expect(starts[0]!.effort).toBe("high");

      const plain = await create({}).then(j);
      expect(plain.effort).toBeNull();
      await waitFor(async () => starts.length === 2);
      expect(starts[1]!.effort).toBeUndefined();

      const bad = await create({ effort: "ultra" });
      expect(bad.status).toBe(400);
      expect((await j(bad)).error).toContain('unknown effort "ultra"');
      expect((await create({ runner: "dak", effort: "high" })).status).toBe(400); // DAK has no list at all
      expect(starts).toHaveLength(2); // nothing started for the refused ones
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("the idle stop command stays with the daemon: what it starts does not inherit it", async () => {
    // 2026-10-19 17:49: a scratch daemon a Task booted with `loadConfig({ ...process.env, … })` saw nothing running in
    // its own database and stopped the host while the real daemon's Tasks were mid-turn
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-idlecmd-"));
    const before = process.env.SWITCHBOARD_IDLE_STOP_CMD;
    process.env.SWITCHBOARD_IDLE_STOP_CMD = "/bin/false";
    const cfg = loadConfig({ ...process.env, SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    const c = await startServer(cfg, [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      expect(cfg.idleStopCmd).toBe("/bin/false");
      expect(process.env.SWITCHBOARD_IDLE_STOP_CMD).toBeUndefined();
      expect(loadConfig({ ...process.env, SWITCHBOARD_HOME: h }).idleStopCmd).toBeUndefined();
    } finally {
      await c.stop();
      if (before === undefined) delete process.env.SWITCHBOARD_IDLE_STOP_CMD;
      else process.env.SWITCHBOARD_IDLE_STOP_CMD = before;
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health reports a failed daily archive from archive.status, and null without one (#1201)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-archive-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const archive = () => fetch(`http://127.0.0.1:${c.server.port}/api/health`).then(j).then((x) => x.archive);
    try {
      expect(await archive()).toBeNull();
      writeFileSync(join(h, "archive.status"), `failed ${Math.floor(Date.now() / 1000)} 137\n`);
      expect(await archive()).toMatchObject({ kind: "failed", detail: "137" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health lists each runner's models and what the CLI runs on when the model is left empty (#155)", async () => {
    let cliDefault: string | undefined = "haiku";
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-models-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { models: ["big", "small"], cliDefaultModel: () => cliDefault }), fakeAdapter(SCRIPT, { id: "dak" })], { port: 0 });
    const runners = () => fetch(`http://127.0.0.1:${c.server.port}/api/health`).then(j).then((x) => x.runners);
    try {
      const [claude, dak] = await runners();
      expect(claude.models).toEqual([{ value: "big", label: "big" }, { value: "small", label: "small" }]);
      expect(claude.cliDefaultModel).toBe("haiku");
      expect(dak.models).toEqual([]); // an adapter that declares none: the runner decides itself
      expect(dak.cliDefaultModel).toBeUndefined();
      cliDefault = "big"; // changed in the CLI while the daemon runs: read again, not cached at boot
      expect((await runners())[0].cliDefaultModel).toBe("big");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health shows each runner's login (#180): the status command's answer, rechecked when over a minute old; a turn's auth error marks it expired", async () => {
    let login: RunnerDetection["login"] = "expired";
    let detects = 0;
    const detect = () => (detects++, { login, loginHint: "fake login" });
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "sess-auth", cwd: "/tmp" },
      { t: "error", message: "Not logged in · Please run /login" },
      { t: "session.end", status: "error", summary: "Not logged in · Please run /login" },
    ];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-login-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { detect }), fakeAdapter(SCRIPT, { id: "dak" })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const runners = () => fetch(`${b}/api/health`).then(j).then((x) => x.runners);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      const [claude, dak] = await runners();
      expect(claude).toMatchObject({ login: "expired", loginHint: "fake login" });
      expect(dak.login).toBeUndefined(); // a runner without a login of its own
      // logged in again in the terminal tab: within the minute the boot answer stands, after it the command runs again
      login = "ok";
      expect((await runners())[0].login).toBe("expired");
      expect(detects).toBe(1);
      offset += 61_000;
      expect((await runners())[0].login).toBe("ok");
      expect(detects).toBe(2);
      // the status command still says ok, but a turn ended on the runner's auth error: expired, with what to type
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "error");
      expect((await runners())[0].login).toBe("expired");
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.includes("`fake login`"))).toBe(true);
      // the next check that says ok clears it
      offset += 61_000;
      expect((await runners())[0].login).toBe("ok");
      // a turn that goes through clears expired, even when the last status-command answer (within the minute) said so
      login = "expired";
      offset += 61_000;
      expect((await runners())[0].login).toBe("expired");
      script.splice(0, script.length, ...SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result"));
      const ok = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t2", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${ok.id}`).then(j)).task.status === "done");
      expect((await runners())[0].login).toBe("ok");
      login = "ok";
      // the banner's 再確認 asks again at once, without waiting out the minute
      const before = detects;
      offset += 6_000;
      expect((await fetch(`${b}/api/health?recheck=1`).then(j)).runners[0].login).toBe("ok");
      expect(detects).toBe(before + 1);
      // …but not again within a few seconds, and never for another origin
      await fetch(`${b}/api/health?recheck=1`);
      offset += 6_000;
      await fetch(`${b}/api/health?recheck=1`, { headers: { origin: "https://evil.example" } });
      expect(detects).toBe(before + 1);
      await fetch(`${b}/api/health?recheck=1`);
      expect(detects).toBe(before + 2);
    } finally {
      clock.mockRestore();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("isAuthText (#180) matches the runners' not-logged-in errors, not their usage limits or other failures", () => {
    expect(isAuthText("claude", "Invalid API key · Please run /login")).toBe(true);
    expect(isAuthText("claude", "OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe(true);
    expect(isAuthText("codex", "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.")).toBe(true);
    expect(isAuthText("claude", "You've hit your session limit · resets 4:10am (Asia/Tokyo)")).toBe(false);
    expect(isAuthText("codex", "stream error: 429 Too Many Requests")).toBe(false);
    expect(isAuthText("codex", "stream error: unexpected status 401 Unauthorized")).toBe(true);
    expect(isAuthText("codex", "Failed to refresh token: connection timed out")).toBe(false); // the network, not the login
    expect(isAuthText("dak", "Not logged in")).toBe(false); // DAK has no login of its own
  });

  test("GET /api/workspaces/:id/brief writes the improvement prefix per workspace: Switchboard's map for meta, the repository itself otherwise", async () => {
    const list = (await fetch(`${base}/api/workspaces`).then(j)) as Array<{ id: string; kind: string; name: string; path: string }>;
    const meta = list.find((w) => w.kind === "meta")!;
    const metaBrief = await fetch(`${base}/api/workspaces/${meta.id}/brief`).then(j);
    expect(metaBrief.workspaceId).toBe(meta.id);
    expect(metaBrief.text.startsWith("あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。")).toBe(true);
    expect(metaBrief.text.endsWith("やってほしいこと:\n")).toBe(true);

    // under `home` (removed in afterAll): later tests list workspaces and expect every path to exist
    const other = join(home, "Decentralized-Agent-Kit");
    mkdirSync(other);
    {
      writeFileSync(join(other, "docker-compose.yml"), "services: {}\n");
      const r = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other, name: "Decentralized-Agent-Kit" }) });
      expect(r.status).toBe(201);
      const added = (await r.json()) as { id: string };
      const brief = await fetch(`${base}/api/workspaces/${added.id}/brief`).then(j);
      expect(brief.text.startsWith(`あなたは Decentralized-Agent-Kit（${other}）のリポジトリで作業しています。`)).toBe(true);
      expect(brief.text).not.toContain("Switchboard");
      expect(brief.text).toContain("起動: `docker compose up`。");
    }
    expect((await fetch(`${base}/api/workspaces/ws_nope/brief`)).status).toBe(404);
  });

  test("task lifecycle: create → waiting on permission → allow → done, with ledger and quota recorded", async () => {
    const wsMsgs: unknown[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.onmessage = (m) => wsMsgs.push(JSON.parse(String(m.data)));

    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: home, title: "t1", prompt: "write x", runner: "claude" }),
    }).then(j);
    expect(created.id).toMatch(/^task_/);

    await waitFor(async () => (await getTask(created.id)).task.status === "waiting");
    const detail = await getTask(created.id);
    const ask = detail.events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    expect(ask).toBeDefined();
    expect(detail.task.runnerSessionId).toBe("sess-1");

    const after = await fetch(`${base}/api/tasks/${created.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ask.id, decision: "allow" }),
    }).then(j);
    expect(["running", "done"]).toContain(after.status);

    await waitFor(async () => (await getTask(created.id)).task.status === "done");
    const done = await getTask(created.id);
    expect(done.cost.costUsd).toBeCloseTo(0.021436, 6);
    const kinds = done.events.map((e: { ev: AgentEvent }) => e.ev.t);
    expect(kinds).toEqual(expect.arrayContaining(["message.delta", "session.start", "permission.ask", "permission.resolved", "tool.result", "usage", "session.end"]));

    const summary = await fetch(`${base}/api/ledger/summary`).then(j);
    expect(summary.todayUsd).toBeCloseTo(0.021436, 6);
    expect(summary.byRunnerToday.claude).toBeCloseTo(0.021436, 6);
    expect(summary.quota.find((q: { window: string }) => q.window === "five_hour").utilization).toBeCloseTo(0.16);
    expect(summary.topTasks[0].taskId).toBe(created.id);

    await waitFor(async () => wsMsgs.some((m) => (m as { type: string }).type === "event"));
    expect(wsMsgs.some((m) => (m as { type: string }).type === "task.updated")).toBe(true);
    ws.close();
  });

  test("GET /api/tasks/:id?after= returns only the events past the cursor, in seq order (#1137)", async () => {
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: home, title: "after", prompt: "write x", runner: "claude" }),
    }).then(j);
    await waitFor(async () => (await getTask(created.id)).task.status === "waiting");
    const ask = (await getTask(created.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await fetch(`${base}/api/tasks/${created.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "allow" }) });
    await waitFor(async () => (await getTask(created.id)).task.status === "done");

    const full = await getTask(created.id);
    expect(full.events.length).toBeGreaterThan(3);
    const cursor = full.events[2].seq;
    const tail = await fetch(`${base}/api/tasks/${created.id}?after=${cursor}`).then(j);
    expect(tail.events).toEqual(full.events.slice(3));
    const seqs = tail.events.map((e: { seq: number }) => e.seq);
    expect(seqs.every((s: number, i: number) => i === 0 || s > seqs[i - 1])).toBe(true);

    const last = full.events[full.events.length - 1].seq;
    const none = await fetch(`${base}/api/tasks/${created.id}?after=${last}`).then(j);
    expect(none.events).toEqual([]);
    expect(none.task.id).toBe(created.id);
    expect(none.cost).toEqual(full.cost);
    expect(none.attachments).toEqual(full.attachments);

    for (const bad of ["abc", "-5", "", "1.5e400"]) expect((await fetch(`${base}/api/tasks/${created.id}?after=${bad}`).then(j)).events).toEqual(full.events);
  });

  test("events tail (#1165): GET /api/tasks/:id holds the last `limit` events (200 by default), ?before= the page before, ?limit=0 none; ?after= stays whole", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-events-tail-"));
    const long: AgentEvent[] = [];
    for (let i = 0; long.length < 500; i++) long.push({ t: "tool.call", id: `c${i}`, name: "Read", input: { file_path: `src/file${i}.ts` }, summary: `Read src/file${i}.ts` }, { t: "tool.result", id: `c${i}`, ok: true, summary: "40 lines" }, { t: "message.delta", role: "assistant", text: `Step ${i}. `, messageId: `m${i}` });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([...long.slice(0, 500), { t: "session.end", status: "ok" }])], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "long", prompt: "long", runner: "claude" }) }).then(j);
      const get = (q = "") => fetch(`${b}/api/tasks/${t.id}${q}`).then(j);
      await waitFor(async () => (await get()).task.status === "done");
      const all = c.db.listEvents(t.id);
      expect(all.length).toBeGreaterThan(500);
      const seqs = (d: { events: Array<{ seq: number }> }) => d.events.map((e) => e.seq);

      const tail = await get();
      expect(seqs(tail)).toEqual(all.slice(-200).map((e) => e.seq));
      expect((await get("?limit=50")).events).toHaveLength(50);
      const meta = await get("?limit=0");
      expect(meta.events).toEqual([]);
      expect(meta.cost).toEqual(tail.cost);
      expect(meta.task.id).toBe(t.id);

      const first = tail.events[0].seq;
      const page = await get(`?before=${first}&limit=200`);
      expect(seqs(page)).toEqual(all.filter((e) => e.seq < first).slice(-200).map((e) => e.seq));
      expect(seqs(await get("?before=1"))).toEqual([]);
      for (const bad of ["abc", "-5", "0", "1.5"]) expect((await fetch(`${b}/api/tasks/${t.id}?before=${bad}`)).status).toBe(400);

      // the catch-up after a dropped WebSocket (#1137) is never cut: everything past the cursor
      const past = all.slice(11).map((e) => e.seq);
      expect(seqs(await get(`?after=${all[10]!.seq}`))).toEqual(past);
      for (const with_ of ["&limit=0", "&limit=50", "&before=abc", "&before=5"]) expect(seqs(await get(`?after=${all[10]!.seq}${with_}`))).toEqual(past);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("api_requests (#2101): each guardAll route's time and size are written by the route's key, flushed on stop", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-api-requests-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const created = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "sized", prompt: "write x", runner: "claude" }) }).then(j);
      const r = await fetch(`${b}/api/tasks/${created.id}`);
      expect(Number(r.headers.get("content-length"))).toBe((await r.arrayBuffer()).byteLength);
      expect((await fetch(`${b}/api/tasks/nope`)).status).toBe(404);
      await fetch(`${b}/no/such/page`); // the fallback: not a route, not recorded
    } finally {
      await c.stop();
    }
    const raw = new Database(join(h, "switchboard.db"), { readonly: true });
    const rows = raw.query("SELECT method, route, status, ms, bytes FROM api_requests ORDER BY rowid").all() as Array<{ method: string; route: string; status: number; ms: number; bytes: number | null }>;
    raw.close();
    rmSync(h, { recursive: true, force: true });
    expect(rows.map((x) => `${x.method} ${x.route} ${x.status}`)).toEqual(["POST /api/tasks 201", "GET /api/tasks/:id 200", "GET /api/tasks/:id 404"]);
    expect(rows[1]!.bytes).toBeGreaterThan(0);
    expect(rows.every((x) => x.ms >= 0)).toBe(true);
  });

  test("api_requests (#2101): a failed write is dropped with one warning, not thrown out of the daemon", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-api-requests-fail-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const insert = spyOn(c.db, "insertApiRequests").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fetch(`http://127.0.0.1:${c.server.port}/api/tasks`);
      await expect(c.stop()).resolves.toBeUndefined();
      expect(insert).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.filter((a) => String(a[0]).startsWith("api_requests:"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a finished task keeps its runner alive briefly, then releases it and resumes with --resume on the next turn", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-test2-"));
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RUNNER_IDLE_MS: "60" }), [fakeAdapter(script, { lingers: true, starts })], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      const t = await fetch(`${b2}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h2, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(starts.length).toBe(1);
      // idle timer fires → process released; status must stay "done"
      await new Promise((r) => setTimeout(r, 150));
      expect((await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status).toBe("done");
      const sent = await fetch(`${b2}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) }).then(j);
      expect(sent.status).toBe("running");
      expect(starts.length).toBe(2);
      expect(starts[1]?.resumeSessionId).toBe("sess-1");
      expect(starts[1]?.prompt).toBe("again");
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // a follow-up inside the idle window reuses the live process (no new start) and re-arms the timer
      await fetch(`${b2}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "quick" }) });
      expect(starts.length).toBe(2);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      await new Promise((r) => setTimeout(r, 150));
      expect(c2.tasks.isLive(t.id)).toBe(false); // released again after the idle window
      // abort on a finished task whose process is still alive keeps "done"
      const t2 = await fetch(`${b2}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h2, title: "t2", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t2.id}`).then(j)).task.status === "done");
      expect(c2.tasks.isLive(t2.id)).toBe(true);
      const aborted = await fetch(`${b2}/api/tasks/${t2.id}/abort`, { method: "POST" }).then(j);
      expect(aborted.status).toBe("done");
      expect(c2.tasks.isLive(t2.id)).toBe(false);
      // shutting the daemon down while a task is idle must not mark it aborted
      await c2.tasks.shutdown();
      expect(c2.db.getTask(t.id)?.status).toBe("done");
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("gh guard: every runner starts with the kit's bin first in its PATH, whatever the task's folder (#661)", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-ghguard-"));
    const checkout = join(h, "checkout");
    const other = join(h, "other");
    mkdirSync(checkout);
    mkdirSync(other);
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0, selfdevChecks: false });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      for (const cwd of [checkout, other]) {
        const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "t", prompt: "p", runner: "claude" }) }).then(j);
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      }
      const path = `${join(checkout, "ops-kit/bin")}:${process.env.PATH}:${dirname(process.execPath)}`;
      expect(starts.map((s) => s.env?.PATH)).toEqual([path, path]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("private tmp: a Codex task in a registered repo gets its own temp directory, kept while done; a symlink in its place stops the start (#787)", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-privtmp-"));
    const checkout = join(h, "checkout");
    mkdirSync(checkout);
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { id: "codex", starts })], { port: 0, selfdevChecks: false });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: checkout, title: "t", prompt: "p", runner: "codex" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(starts.map((s) => s.privateTmp)).toEqual([join(h, "tmp", t.id)]);
      // a done task may be resumed with its files: kept (the sweep removes it once old)
      expect(existsSync(join(h, "tmp", t.id))).toBe(true);
      // somebody put a symlink where the next one goes: refused, not followed
      expect(() => {
        const evil = `evil-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const victim = join(h, "victim");
        mkdirSync(victim);
        mkdirSync(join(h, "tmp2"));
        symlinkSync(victim, privateTmpOf(join(h, "tmp2"), evil));
        makePrivateTmp(join(h, "tmp2"), evil);
      }).toThrow();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("private tmp: a Codex task without the meta workspace gets none; the sweep removes only old ones the database lets go (#787)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-privtmp2-"));
    const bare: StartOptions[] = [];
    const db = new Db(join(h, "bare.sqlite"));
    try {
      const tasks = new TaskManager(db, new Map([["codex", fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { id: "codex", starts: bare })]]), () => undefined, { idleMs: 0 });
      const t = tasks.create({ cwd: h, title: "t", prompt: "p", runner: "codex" });
      expect(bare.map((s) => s.privateTmp)).toEqual([undefined]);
      await waitFor(async () => db.getTask(t.id)?.status === "done");
      await tasks.shutdown();
    } finally {
      db.close();
    }
    const root = join(h, "sweep");
    const old = makePrivateTmp(root, "old");
    const fresh = makePrivateTmp(root, "fresh");
    try {
      utimesSync(fresh, new Date(), new Date());
      utimesSync(old, new Date(Date.now() - 4 * 3600_000), new Date(Date.now() - 4 * 3600_000));
      expect(sweepPrivateTmps(root, 3600_000, () => false)).toBe(0);
      expect(existsSync(old)).toBe(true); // not a task this database may release
      sweepPrivateTmps(root, 3600_000, () => true);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("shared tmp guard: every runner gets the kit's deny-shared-tmp as a guard, none without the meta workspace (#764)", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-tmpguard-"));
    const checkout = join(h, "it's checkout");
    const other = join(h, "other");
    mkdirSync(checkout);
    mkdirSync(other);
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0, selfdevChecks: false });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      for (const cwd of [checkout, other]) {
        const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "t", prompt: "p", runner: "claude" }) }).then(j);
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      }
      // an absolute path, quoted for the shell (the folder's name holds a quote)
      const guard = `'${join(h, "it'\\''s checkout")}/ops-kit/bin/deny-shared-tmp'`;
      expect(starts.map((s) => s.guards)).toEqual([[guard], [guard]]);
      expect(starts.map((s) => s.privateTmp)).toEqual([undefined, undefined]); // Claude runs the guard instead
    } finally {
      await c.stop();
    }
    // no meta workspace: nothing to point at
    const bare: StartOptions[] = [];
    const db = new Db(join(h, "bare.sqlite"));
    try {
      const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts: bare })]]), () => undefined, { idleMs: 0 });
      const t = tasks.create({ cwd: other, title: "t", prompt: "p", runner: "claude" });
      expect(bare.map((s) => s.guards)).toEqual([undefined]);
      // the fake turn writes to the Db after create returns: close only once it is over
      await waitFor(async () => db.getTask(t.id)?.status === "done");
      await tasks.shutdown();
    } finally {
      db.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("mcp servers: mcp.yaml servers reach the runner, the ones with workspaces only in those Workspaces' Tasks (#2090)", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-mcpservers-"));
    for (const name of ["alpha", "beta"]) mkdirSync(join(h, name));
    writeFileSync(join(h, "mcp.yaml"), "version: 1\nservers:\n  playwright:\n    command: npx\n    workspaces: [alpha]\n  docs:\n    type: http\n    url: http://127.0.0.1:9000/mcp\n");
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0, selfdevChecks: false });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    try {
      const named: string[][] = [];
      for (const name of ["alpha", "beta"]) {
        const ws = await post("/api/workspaces", { path: join(h, name), name });
        const t = await post("/api/tasks", { workspaceId: ws.id, cwd: join(h, name), title: "t", prompt: "p", runner: "claude" });
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
        named.push((await fetch(`${b}/api/tasks/${t.id}`).then(j)).mcpServers);
      }
      const docs = { type: "http" as const, url: "http://127.0.0.1:9000/mcp" };
      expect(starts.map((s) => s.mcpServers)).toEqual([{ playwright: { command: "npx" }, docs }, { docs }]);
      // the task detail names them for the Brief (#2109)
      expect(named).toEqual([["playwright", "docs"], ["docs"]]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a resume whose session record is not on this machine starts a new session with the transcript as a preamble (#179)", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-test-moved-"));
    let here = true;
    const adapter: RunnerAdapter = { ...fakeAdapter(script, { starts }), hasSession: () => here };
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [adapter], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    const send = (id: string, text: string) => fetch(`${b2}/api/tasks/${id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).then(j);
    try {
      const t = await fetch(`${b2}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h2, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // the record is here: an ordinary --resume, no recap (only the stop-report rule every start gets, #949)
      await send(t.id, "again");
      expect(starts[1]).toMatchObject({ resumeSessionId: "sess-1", prompt: "again" });
      expect(starts[1]?.preamble).toStartWith("[Switchboard: 止まったときの報告]");
      expect(starts[1]?.preamble).not.toContain("エージェント: done");
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // the record is gone (the task came from another machine): a new session, told what happened so far
      here = false;
      const sent = await send(t.id, "状況は？");
      expect(sent.status).toBe("running");
      expect(starts[2]?.resumeSessionId).toBeUndefined();
      expect(starts[2]?.prompt).toBe("状況は？"); // the user's message stays as typed
      expect(starts[2]?.preamble).toContain("エージェント: done");
      const events = (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).events as Array<{ ev: AgentEvent }>;
      expect(events.some((e) => e.ev.t === "status" && e.ev.text.includes("sess-1") && e.ev.text.includes("新しいセッション"))).toBe(true);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("shutdown while a turn is in flight (waiting on a permission) marks that task aborted, never auto-answers", async () => {
    const h3 = mkdtempSync(join(tmpdir(), "switchboard-test3-"));
    const c3 = await startServer(loadConfig({ SWITCHBOARD_HOME: h3, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0 });
    const b3 = `http://127.0.0.1:${c3.server.port}`;
    try {
      const t = await fetch(`${b3}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h3, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b3}/api/tasks/${t.id}`).then(j)).task.status === "waiting");
      await c3.tasks.shutdown();
      const d = await fetch(`${b3}/api/tasks/${t.id}`).then(j);
      expect(d.task.status).toBe("aborted");
      expect(d.events.some((e: { ev: AgentEvent }) => e.ev.t === "permission.resolved")).toBe(false);
    } finally {
      await c3.stop();
      rmSync(h3, { recursive: true, force: true });
    }
  });

  test("POST /api/tasks/suggest applies the rule table and the previous runner; the suggestion is recomputed and recorded at creation", async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    const dir = join(home, "routing-cwd");
    mkdirSync(dir, { recursive: true });
    const multi = await post("/api/tasks/suggest", { cwd: dir, title: "x", prompt: "y", scope: [dir, join(home, "other")] });
    expect(multi).toMatchObject({ runner: "claude", ruleId: "multi-repo", available: true });
    const review = await post("/api/tasks/suggest", { cwd: dir, title: "PR review", prompt: "" });
    expect(review).toMatchObject({ runner: "codex", ruleId: "single-repo-long", available: false }); // only the fake claude adapter is installed
    expect((await fetch(`${base}/api/tasks/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "nope", title: "", prompt: "" }) })).status).toBe(404);
    // nothing ran in this directory yet → fallback; after a task, "previous" wins for a neutral prompt
    expect((await post("/api/tasks/suggest", { cwd: dir, title: "typo", prompt: "fix the typo" })).ruleId).toBe("fallback");
    // the client cannot dictate the recorded suggestion: it is recomputed from the prompt ("PR review" → codex) and
    // compared with the chosen runner (claude) → overridden
    const t = await post("/api/tasks", { cwd: dir, title: "PR review", prompt: "p", runner: "claude", routing: { suggested: "dak", ruleId: "forged", reason: "x" } });
    expect(t.routing).toEqual({ suggested: "codex", ruleId: "single-repo-long", reason: expect.any(String), overridden: true, llm: null });
    expect((await post("/api/tasks/suggest", { cwd: dir, title: "typo", prompt: "fix the typo" })).ruleId).toBe("previous");
    await waitFor(async () => (await getTask(t.id)).task.status === "waiting");
    const ask = (await getTask(t.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await post(`/api/tasks/${t.id}/permission`, { id: ask.id, decision: "allow" });
    await waitFor(async () => (await getTask(t.id)).task.status === "done");
    const log = await fetch(`${base}/api/routing/log`).then(j);
    expect(log[0]).toMatchObject({ taskId: t.id, suggested: "codex", chosen: "claude", status: "done" });
  });

  test("POST /permission hands `answers` (AskUserQuestion) to the runner session; a malformed one is a 400 and the ask stays open", async () => {
    const dir = join(home, "answers-cwd");
    mkdirSync(dir, { recursive: true });
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "question", prompt: "p", runner: "claude" }) }).then(j);
    await waitFor(async () => (await getTask(t.id)).task.status === "waiting");
    const ask = (await getTask(t.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    const send = (answers: unknown) => fetch(`${base}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "allow", answers }) });
    expect((await send({ "Which color?": ["Blue"] })).status).toBe(400);
    expect((await getTask(t.id)).task.status).toBe("waiting");
    const before = ANSWERS.length;
    expect((await send({ "Which color?": "Blue" })).status).toBe(200);
    expect(ANSWERS.slice(before)).toEqual([{ "Which color?": "Blue" }]);
    await waitFor(async () => (await getTask(t.id)).task.status === "done");

    // the question text is the agent's: a key that is an Object.prototype name reaches the session like any other
    const t2 = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "question 2", prompt: "p", runner: "claude" }) }).then(j);
    await waitFor(async () => (await getTask(t2.id)).task.status === "waiting");
    const ask2 = (await getTask(t2.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    const raw = `{"id":${JSON.stringify(ask2.id)},"decision":"allow","answers":{"__proto__":"x","constructor":"A"}}`;
    expect((await fetch(`${base}/api/tasks/${t2.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: raw })).status).toBe(200);
    expect(JSON.stringify(ANSWERS.at(-1))).toBe('{"__proto__":"x","constructor":"A"}');
    await waitFor(async () => (await getTask(t2.id)).task.status === "done");
  });

  test("the routing log carries the task's outcome (status / costUsd / durationMs) and exports as JSONL (#25)", async () => {
    const dir = join(home, "routing-export-cwd");
    mkdirSync(dir, { recursive: true });
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "PR review", prompt: "p", runner: "claude" }) }).then(j);
    await waitFor(async () => (await getTask(t.id)).task.status === "waiting");
    const ask = (await getTask(t.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await fetch(`${base}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "allow" }) });
    await waitFor(async () => (await getTask(t.id)).task.status === "done");
    // a ledger row the task did not produce itself: the join must sum the whole task, whatever wrote the rows
    core.db.insertLedger({ taskId: t.id, runner: "claude", model: "m", inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0.25, billedUsd: 0, source: "reported", ts: Date.now() });
    const logRows = async (query = "") => (await fetch(`${base}/api/routing/log${query}`).then(j)) as Array<Record<string, unknown>>;
    const row = (await logRows()).find((r) => r.taskId === t.id)!;
    expect(row).toMatchObject({ suggested: "codex", chosen: "claude", status: "done" });
    // the whole ledger of the task, not just what the turn reported (the fake runner also emits usage)
    expect(row.costUsd).toBeCloseTo(core.db.taskCost(t.id).costUsd, 10);
    expect(row.costUsd as number).toBeGreaterThanOrEqual(0.25);
    // the duration is measured against this task's own events, not the clock: a later patch must not inflate it
    const events = core.db.listEvents(t.id);
    expect(row.durationMs).toBe(Math.max(events.at(-1)!.ts - core.db.getTask(t.id)!.createdAt, 0));
    core.tasks.setBudget(t.id, 100); // stamps updated_at days-later-style without the task doing any work
    expect((await logRows()).find((r) => r.taskId === t.id)!.durationMs).toBe(row.durationMs);
    // …and a record whose timestamps run backwards (an import) reports 0 rather than a negative duration
    const past = { id: "task_backwards", workspaceId: null, title: "backwards", runner: "claude" as const, cwd: home, scope: [home], status: "done" as const, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: { suggested: "claude" as const, ruleId: "r", reason: "why", overridden: false, llm: null }, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard" as const, resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown" as const, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 5_000, createdAt: 5_000, updatedAt: 1_000 };
    core.db.insertTask(past);
    expect((await logRows()).find((r) => r.taskId === past.id)!.durationMs).toBe(0);
    // each row carries its task's outcome (#612): the status alone says "done" for a task that stopped to ask
    expect(row.outcome).toBe(core.db.getTask(t.id)!.outcome);
    for (const outcome of ["done", "needs_action", "failed"] as const) {
      const id = `task_outcome_${outcome}`;
      core.db.insertTask({ ...past, id, title: id, createdAt: 6_000, updatedAt: 6_000 });
      core.db.updateTask(id, { outcome });
      expect((await logRows()).find((r) => r.taskId === id)).toMatchObject({ status: "done", outcome });
    }

    const res = await fetch(`${base}/api/routing/log?format=jsonl&limit=5`);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const body = await res.text();
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2); // this test alone wrote two decisions
    expect(lines.length).toBeLessThanOrEqual(5);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((r) => r.taskId)).toContain(t.id);
    for (const r of parsed) expect(Object.keys(r).sort()).toEqual(["chosen", "costUsd", "durationMs", "outcome", "reason", "ruleId", "status", "suggested", "suggestedBy", "taskId", "title", "ts"]);
    // newest first, and reproducible: the same request twice returns the same rows in the same order
    expect(parsed.map((r) => r.ts)).toEqual([...(parsed.map((r) => r.ts) as number[])].sort((a, b) => b - a));
    expect(await fetch(`${base}/api/routing/log?format=jsonl&limit=5`).then((r) => r.text())).toBe(body);
    // ?limit= counts rows, and anything that is not a usable count falls back to the default (not to one row)
    expect(await logRows("?limit=1")).toHaveLength(1);
    const all = await logRows();
    for (const q of ["?limit=nonsense", "?limit=", "?limit=0", "?limit=-5"]) expect(await logRows(q)).toHaveLength(all.length);
  });

  test("suggester: the LLM proposal rides along, and a slow, broken or disabled one leaves the rule table in charge (#25)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-suggester-"));
    const dir = join(h, "repo");
    mkdirSync(dir, { recursive: true });
    // One fake per case; `which` picks the one the next creation gets, so all four run against one daemon.
    let which: "ok" | "slow" | "throws" = "ok";
    const calls: Array<{ title: string; kind: string }> = [];
    const fake: Suggester = {
      async suggest(ctx, signal) {
        calls.push({ title: ctx.title, kind: "llm" });
        if (which === "throws") throw new Error("runner said no");
        if (which === "slow") await new Promise((r) => setTimeout(r, 60_000));
        return { runner: "dak", reason: "LLM がそう言った", ruleId: "llm", available: ctx.available.has("dak"), alternatives: [], llm: null };
      },
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0, llmSuggester: () => fake });
    const b = `http://${"127.0.0.1"}:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // (d) off by default: nothing is asked and nothing is recorded
      const off = await post("/api/tasks", { cwd: dir, title: "t-off", prompt: "p", runner: "claude" });
      expect(off.routing.llm).toBeNull();
      expect(calls).toHaveLength(0);
      expect((await fetch(`${b}/api/health`).then(j)).routing.llm).toMatchObject({ enabled: false, runner: "claude", available: true });

      expect((await patch({ routing: { llm: { enabled: true } } })).status).toBe(200);
      // a partial patch keeps the saved runner / model
      expect((await fetch(`${b}/api/settings`).then(j)).routing.llm).toEqual({ enabled: true, runner: "claude", model: "", timeoutMs: 5000 });

      // (a) on: the LLM proposal is attached to the task and logged as its own row, without changing the runner
      const on = await post("/api/tasks", { cwd: dir, title: "t-on", prompt: "p", runner: "claude" });
      expect(on.routing).toMatchObject({ suggested: "claude", overridden: false, llm: { runner: "dak", reason: "LLM がそう言った" } });
      expect(on.runner).toBe("claude");
      const rows = c.db.routingLog().filter((r) => r.taskId === on.id);
      expect(rows.map((r) => r.suggestedBy).sort()).toEqual(["llm", "rule"]);
      expect(rows.find((r) => r.suggestedBy === "llm")).toMatchObject({ suggested: "dak", chosen: "claude", ruleId: "llm" });

      // (b) a suggester that takes far longer than the deadline: the task is created with the rule table alone, and
      // the route comes back on the deadline rather than on the suggester (the exact timing is pinned in
      // routing.test.ts at 30 ms; here the slack is wide so a loaded machine cannot make it flaky)
      which = "slow";
      const started = Date.now();
      const slow = await post("/api/tasks", { cwd: dir, title: "t-slow", prompt: "p", runner: "claude" });
      expect(slow.routing.llm).toBeNull();
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(c.db.routingLog().filter((r) => r.taskId === slow.id).map((r) => r.suggestedBy)).toEqual(["rule"]);

      // (c) a suggester that throws: still 201, still the rule table
      which = "throws";
      const res = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "t-throws", prompt: "p", runner: "claude" }) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { routing: { llm: unknown } }).routing.llm).toBeNull();
      expect(calls.map((x) => x.title)).toEqual(["t-on", "t-slow", "t-throws"]);

      // a runner that is not installed cannot be the suggester (its adapter would have to produce the answer)
      expect((await patch({ routing: { llm: { runner: "codex" } } })).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).routing.llm.runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 20000);

  test("what the LLM suggestion turn spent is billed to the task under the runner that answered (#25)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-llmcost-"));
    const dir = join(h, "repo");
    mkdirSync(dir, { recursive: true });
    // The fake reports usage the way a real adapter would, through the callback the factory is handed.
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], {
      port: 0,
      llmSuggester: (cfg, onUsage) => ({
        kind: "llm",
        async suggest(ctx) {
          onUsage({ t: "usage", source: "reported", model: "cheap-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 });
          // a second model of the same turn (Claude's `modelUsage`, #2353): billed too, not overwritten
          onUsage({ t: "usage", source: "reported", model: "cheaper-model", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
          return { runner: "dak", reason: `${cfg.runner} が答えた`, ruleId: "llm", available: ctx.available.has("dak"), alternatives: [], llm: null };
        },
      }),
    });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      expect(t.routing.llm).toMatchObject({ runner: "dak", reason: "claude が答えた" });
      const row = c.db.ledgerTasks(1, Date.now()).find((r) => r.taskId === t.id);
      expect(row).toBeDefined();
      const suggestionRow = c.db.sqlite.query("SELECT runner, model, cost_usd AS costUsd FROM ledger WHERE task_id = ? AND model = 'cheap-model'").all(t.id) as Array<{ runner: string; costUsd: number }>;
      expect(suggestionRow).toHaveLength(1);
      expect(suggestionRow[0]).toMatchObject({ runner: "claude", costUsd: 0.02 });
      expect(c.db.sqlite.query("SELECT cost_usd AS costUsd FROM ledger WHERE task_id = ? AND model = 'cheaper-model'").all(t.id)).toEqual([{ costUsd: 0.001 }]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("routing stats: agreement per suggester over the window (#25)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-routingstats-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const now = Date.now();
    // A task row per decision, like `insertTask` writes: the query does not join tasks today, and this is what keeps
    // that true — a future join would start dropping these rows if they were not here.
    const log = (id: string, suggestedBy: "rule" | "llm", suggested: RunnerId, chosen: RunnerId, ts: number) => {
      c.db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, origin, shadow_stopped, created_at, updated_at, status_at) VALUES (?, NULL, ?, ?, ?, '[]', 'done', 'switchboard', 0, ?, ?, ?)").run(id, id, chosen, h, ts, ts, ts);
      c.db.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, NULL, ?, ?, 'r', 'why', ?, ?, ?)").run(id, h, suggested, chosen, ts, suggestedBy);
    };
    try {
      // the endpoint follows the Ledger's convention: no ?days= means 7, and the card always sends its own selector
      expect(await fetch(`${b}/api/routing/stats`).then(j)).toEqual({ rule: { total: 0, agreed: 0 }, llm: { total: 0, agreed: 0 }, otherTotal: 0, days: 7, byRunner: [] });
      log("task_a", "rule", "claude", "claude", now); // rule agreed
      log("task_b", "rule", "codex", "claude", now); // rule missed
      log("task_c", "llm", "dak", "dak", now); // llm agreed
      log("task_old", "rule", "claude", "claude", now - 40 * 24 * 3600 * 1000); // outside the 30-day window
      expect(await fetch(`${b}/api/routing/stats?days=30`).then(j)).toEqual({
        rule: { total: 2, agreed: 1 },
        llm: { total: 1, agreed: 1 },
        otherTotal: 0,
        days: 30,
        // the rule rows only: task_c has an LLM row and no rule row, so it is not a task of any runner here
        byRunner: [{ runner: "claude", total: 2, outcomes: { done: 0, needs_action: 0, failed: 0, unknown: 2 }, medianCostUsd: 0, medianDurationMs: 0 }],
      });
      // a source that never agreed reports 0, not a missing group
      log("task_d", "llm", "codex", "claude", now);
      log("task_e", "llm", "codex", "claude", now);
      expect(await fetch(`${b}/api/routing/stats?days=30`).then(j)).toMatchObject({ llm: { total: 3, agreed: 1 } });
      // the window is the caller's, clamped like the ledger's; an unusable value falls back instead of meaning "1 day"
      expect(await fetch(`${b}/api/routing/stats?days=90`).then(j)).toMatchObject({ rule: { total: 3, agreed: 2 }, days: 90 });
      expect(await fetch(`${b}/api/routing/stats?days=365`).then(j)).toMatchObject({ days: 90 });
      for (const q of ["?days=nonsense", "?days=", "?days=0", "?days=-3"]) expect(await fetch(`${b}/api/routing/stats${q}`).then(j)).toMatchObject({ days: 7 });
      // a row from a source this version does not know is counted, not dropped: the card must not claim "no records"
      c.db.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES ('task_f', NULL, ?, 'dak', 'x', 'y', 'dak', ?, 'oracle')").run(h, now);
      expect(await fetch(`${b}/api/routing/stats?days=30`).then(j)).toMatchObject({ otherTotal: 1, llm: { total: 3 } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("routing stats: per-runner outcomes, cost and duration medians (#612)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-runnerstats-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    // A task with no events lasts created_at → updated_at; what it cost is its ledger total.
    const task = (id: string, chosen: RunnerId, outcome: string, costUsd: number, durationMs: number, ts = now, llm = false) => {
      c.db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES (?, NULL, ?, ?, ?, '[]', 'done', 'switchboard', 0, ?, ?, ?, ?)").run(id, id, chosen, h, outcome, ts, ts + durationMs, ts + durationMs);
      const row = c.db.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, NULL, ?, ?, 'r', 'why', ?, ?, ?)");
      row.run(id, h, chosen, chosen, ts, "rule");
      if (llm) row.run(id, h, "dak", chosen, ts, "llm");
      if (costUsd) c.db.insertLedger({ taskId: id, runner: chosen, model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: 0, source: "reported", ts });
    };
    try {
      task("task_x1", "codex", "done", 0.1, 1000);
      task("task_x2", "codex", "done", 0.5, 3000);
      task("task_x3", "codex", "failed", 0.3, 2000);
      task("task_c1", "claude", "needs_action", 0, 1000, now, true); // (a) rule + llm rows: one task
      task("task_c2", "claude", "done", 1, 4000);
      task("task_d1", "dak", "done", 9, 9000, now - 40 * day); // (b) outside the 30-day window
      task("task_c3", "claude", "judged_later", 0, 0, now - 40 * day); // outside too, and a value this version does not know
      task("task_c4", "claude", "toString", 0, 0, now - 40 * day); // not an own key of the counts either
      const stats = (await fetch(`${b}/api/routing/stats?days=30`).then(j)) as RoutingStats;
      expect(stats.byRunner).toEqual([
        // (c) an odd count takes the middle value
        { runner: "codex", total: 3, outcomes: { done: 2, needs_action: 0, failed: 1, unknown: 0 }, medianCostUsd: 0.3, medianDurationMs: 2000 },
        // an even count the mean of the middle two
        { runner: "claude", total: 2, outcomes: { done: 1, needs_action: 1, failed: 0, unknown: 0 }, medianCostUsd: 0.5, medianDurationMs: 2500 },
      ]); // (d) dak has no record in the window, so no entry; most tasks first
      expect(stats.llm.total).toBe(1); // the LLM row still counts for agreement
      const wide = (await fetch(`${b}/api/routing/stats?days=90`).then(j)) as RoutingStats;
      expect(wide.byRunner.map((r) => [r.runner, r.total])).toEqual([["claude", 4], ["codex", 3], ["dak", 1]]); // ties by name
      expect(wide.byRunner[0]!.outcomes).toEqual({ done: 1, needs_action: 1, failed: 0, unknown: 2 });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a Knowledge approval rule auto-allows a matching write (recorded by: rule) and a confirm rule still asks with the reason", async () => {
    const h4 = mkdtempSync(join(tmpdir(), "switchboard-test4-"));
    const kdir = join(h4, "K");
    mkdirSync(join(kdir, "rules"), { recursive: true });
    writeFileSync(join(kdir, "rules", "global.md"), "---\napproval: { allow: ['x'], confirm: ['y'] }\n---\nrules\n");
    // the ask names a file inside the task's cwd (h4); an outside path would never be auto-allowed
    const script = SCRIPT.map((e) => (e.t === "permission.ask" ? { ...e, input: { file_path: join(h4, "x") } } : e));
    const c4 = await startServer(loadConfig({ SWITCHBOARD_HOME: h4, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_KNOWLEDGE: kdir }), [fakeAdapter(script)], { port: 0 });
    const b4 = `http://127.0.0.1:${c4.server.port}`;
    try {
      const t = await fetch(`${b4}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h4, title: "auto", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b4}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const d = await fetch(`${b4}/api/tasks/${t.id}`).then(j);
      const evs = d.events.map((e: { ev: AgentEvent }) => e.ev);
      const ask = evs.find((e: AgentEvent) => e.t === "permission.ask");
      expect(ask.rule).toMatchObject({ source: "rules/global.md", pattern: "x", mode: "allow", subject: "x" });
      const resolved = evs.find((e: AgentEvent) => e.t === "permission.resolved");
      expect(resolved).toMatchObject({ id: ask.id, decision: "allow", by: "rule", rule: { pattern: "x" } });
      expect(evs.map((e: AgentEvent) => e.t)).not.toContain("error");
      // the task never waited: no task.updated with status waiting was needed; the runner continued straight to done
      expect(d.task.status).toBe("done");
    } finally {
      await c4.stop();
      rmSync(h4, { recursive: true, force: true });
    }
    // confirm rule: still asks, but the ask carries the reason
    const h5 = mkdtempSync(join(tmpdir(), "switchboard-test5-"));
    const kdir5 = join(h5, "K");
    mkdirSync(join(kdir5, "rules"), { recursive: true });
    writeFileSync(join(kdir5, "rules", "global.md"), "---\napproval: { allow: ['**'], confirm: ['x'] }\n---\nrules\n");
    const script5 = SCRIPT.map((e) => (e.t === "permission.ask" ? { ...e, input: { file_path: join(h5, "x") } } : e));
    const c5 = await startServer(loadConfig({ SWITCHBOARD_HOME: h5, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_KNOWLEDGE: kdir5 }), [fakeAdapter(script5)], { port: 0 });
    const b5 = `http://127.0.0.1:${c5.server.port}`;
    try {
      const t = await fetch(`${b5}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h5, title: "confirm", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b5}/api/tasks/${t.id}`).then(j)).task.status === "waiting");
      const d = await fetch(`${b5}/api/tasks/${t.id}`).then(j);
      const ask = d.events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
      expect(ask.rule).toMatchObject({ mode: "confirm", pattern: "x" });
    } finally {
      await c5.stop();
      rmSync(h5, { recursive: true, force: true });
    }
  });

  test("usage without a reported cost is priced from pricing.json and billed per runner; the ledger splits API-equivalent from billed", async () => {
    const h6 = mkdtempSync(join(tmpdir(), "switchboard-test6-"));
    // a codex-like runner: tokens only, no costUsd
    const script: AgentEvent[] = [
      { t: "session.start", runner: "codex", runnerSessionId: "c1", cwd: "/tmp" },
      { t: "usage", source: "reported", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { t: "session.end", status: "ok" },
    ];
    const codexFake = { ...fakeAdapter(script), id: "codex" as const };
    const c6 = await startServer(loadConfig({ SWITCHBOARD_HOME: h6, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [codexFake], { port: 0, gh: NO_GH });
    const b6 = `http://127.0.0.1:${c6.server.port}`;
    try {
      const t = await fetch(`${b6}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h6, title: "priced", prompt: "p", runner: "codex" }) }).then(j);
      await waitFor(async () => (await fetch(`${b6}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const d = await fetch(`${b6}/api/tasks/${t.id}`).then(j);
      expect(d.cost.costUsd).toBeCloseTo(0.1, 6); // gpt-6-luna alias for codex: $0.1 / 1M input
      const s = await fetch(`${b6}/api/ledger/summary`).then(j);
      expect(s.todayUsd).toBeCloseTo(0.1, 6);
      expect(s.billedTodayUsd).toBe(0); // codex is a subscription in the shipped table
      const daily = await fetch(`${b6}/api/ledger/daily?days=2`).then(j);
      expect(daily).toHaveLength(1);
      expect(daily[0]).toMatchObject({ runner: "codex", billedUsd: 0 });
      const rows = await fetch(`${b6}/api/ledger/tasks`).then(j);
      expect(rows[0]).toMatchObject({ taskId: t.id, model: "gpt-6-luna", unpriced: false });
      const pricing = await fetch(`${b6}/api/ledger/pricing`).then(j);
      expect(pricing.models["gpt-6-luna"].input).toBe(0.1);
    } finally {
      await c6.stop();
      rmSync(h6, { recursive: true, force: true });
    }
  });

  test("settings prices (#1402): a price entered in the settings prices the next usage without a restart, wins over pricing.json's row, and null brings the row back", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-prices-"));
    const script: AgentEvent[] = [
      { t: "session.start", runner: "codex", runnerSessionId: "c1", cwd: "/tmp" },
      { t: "usage", source: "reported", model: "zz-new-model", inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { t: "session.end", status: "ok" },
    ];
    const codexFake = { ...fakeAdapter(script), id: "codex" as const };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [codexFake], { port: 0, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = async () => {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "priced", prompt: "p", runner: "codex" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      return fetch(`${b}/api/tasks/${t.id}`).then(j);
    };
    try {
      expect((await run()).cost.costUsd).toBe(0); // not in the shipped table → unpriced
      expect((await fetch(`${b}/api/ledger/tasks`).then(j))[0]).toMatchObject({ model: "zz-new-model", unpriced: true });
      expect((await patch({ prices: { " zz-new-model ": { input: 2, output: 4 } } })).status).toBe(200);
      const d = await run();
      expect(d.cost.costUsd).toBeCloseTo(2 + 0.5 * 4, 6); // 1M input × $2 + 0.5M output × $4
      let pricing = await fetch(`${b}/api/ledger/pricing`).then(j);
      expect(pricing.models["zz-new-model"]).toMatchObject({ input: 2, output: 4, cacheRead: 0, cacheWrite: 0 });
      expect(pricing.fromSettings).toEqual(["zz-new-model"]);
      // over the shipped row of the same model, and back to it on null
      const shipped = pricing.models["gpt-6-luna"].input;
      expect((await patch({ prices: { "gpt-6-luna": { input: 9, output: 9, cacheWrite1h: 18 } } })).status).toBe(200);
      pricing = await fetch(`${b}/api/ledger/pricing`).then(j);
      expect(pricing.models["gpt-6-luna"]).toMatchObject({ input: 9, cacheWrite1h: 18 });
      expect((await patch({ prices: { "gpt-6-luna": null } })).status).toBe(200);
      pricing = await fetch(`${b}/api/ledger/pricing`).then(j);
      expect(pricing.models["gpt-6-luna"].input).toBe(shipped);
      expect(pricing.fromSettings).toEqual(["zz-new-model"]);
      // a negative or non-number value, or an empty model name → 400, nothing saved
      const before = (await fetch(`${b}/api/settings`).then(j)).prices;
      for (const bad of [{ "zz-other": { input: -1, output: 1 } }, { "zz-other": { input: "abc", output: 1 } }, { "  ": { input: 1, output: 1 } }, { "zz-other": { input: 1, output: 1 }, "": { input: 1, output: 1 } }]) {
        expect((await patch({ prices: bad })).status).toBe(400);
      }
      expect((await fetch(`${b}/api/settings`).then(j)).prices).toEqual(before);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a task budget: exceeding it notes the crossing, blocks further turns (409) until raised; the hold is derived from spend vs budget", async () => {
    const h7 = mkdtempSync(join(tmpdir(), "switchboard-test7-"));
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/tmp" },
      { t: "usage", source: "reported", model: "claude-haiku-4-5-20251001", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
      { t: "session.end", status: "ok" },
    ];
    const c7 = await startServer(loadConfig({ SWITCHBOARD_HOME: h7, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0 });
    const b7 = `http://127.0.0.1:${c7.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b7}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const t = await post("/api/tasks", { cwd: h7, title: "budget", prompt: "p", runner: "claude", budgetUsd: 0.3 }).then(j);
      expect(t.budgetUsd).toBe(0.3);
      await waitFor(async () => (await fetch(`${b7}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const d = await fetch(`${b7}/api/tasks/${t.id}`).then(j);
      expect(d.task.status).toBe("done"); // the turn finished normally; no synthetic ask, no waiting
      expect(d.events.some((e: { ev: AgentEvent }) => e.ev.t === "permission.ask")).toBe(false);
      expect(d.events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.includes("予算"))).toBe(true);
      // new turns are refused while over budget
      const refused = await post(`/api/tasks/${t.id}/send`, { text: "more" });
      expect(refused.status).toBe(409);
      // raising to still below the spend keeps the hold; raising past it lifts it
      expect((await post(`/api/tasks/${t.id}/budget`, { budgetUsd: 0.4 }).then(j)).overBudget).toBe(true);
      expect((await post(`/api/tasks/${t.id}/budget`, { budgetUsd: 0.6 }).then(j)).overBudget).toBe(false);
      expect((await post(`/api/tasks/${t.id}/send`, { text: "more" })).status).toBe(200);
      // the second turn spends another $0.5 → over again ($1.0 > $0.6); removing the budget lifts it for good
      await waitFor(async () => (await fetch(`${b7}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect((await post(`/api/tasks/${t.id}/send`, { text: "more" })).status).toBe(409);
      expect((await post(`/api/tasks/${t.id}/budget`, { budgetUsd: null }).then(j)).overBudget).toBe(false);
      expect((await post(`/api/tasks/${t.id}/budget`, { budgetUsd: -1 })).status).toBe(400);
      expect((await post(`/api/tasks/${t.id}/budget`, { budgetUsd: "x" })).status).toBe(400);
    } finally {
      await c7.stop();
      rmSync(h7, { recursive: true, force: true });
    }
  });

  test("model of an existing task (#155): POST /api/tasks/:id/model releases the idle process, the next turn resumes the session with the new model; a turn in flight keeps its process", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-model-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts, slowMs: 150, closeMs: 120 })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const task = (id: string) => fetch(`${b}/api/tasks/${id}`).then(j);
    const done = (id: string) => waitFor(async () => (await task(id)).task.status === "done");
    try {
      const t = await post("/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude" }).then(j);
      expect(starts[0]?.model).toBeUndefined(); // left empty: the CLI's default
      await done(t.id);
      expect((await task(t.id)).task.model).toBe("claude-haiku-4-5-20251001"); // what the runner said it runs on
      // idle: released now (not an abort), the next turn resumes the same session with the new model
      expect(c.tasks.isLive(t.id)).toBe(true);
      const r = await post(`/api/tasks/${t.id}/model`, { model: " big " }).then(j);
      expect(r).toMatchObject({ model: "big", status: "done" });
      expect(c.tasks.isLive(t.id)).toBe(false);
      expect((await task(t.id)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text === "model → big (applies to the next turn)")).toBe(true);
      await post(`/api/tasks/${t.id}/send`, { text: "again" });
      expect(starts.length).toBe(2);
      expect(starts[1]).toMatchObject({ model: "big", resumeSessionId: "sess-1" });
      // a turn in flight: the process stays and still takes follow-ups; what it reports about itself (the old model,
      // once per turn) does not undo the choice; the first turn after it ended restarts with the new model
      expect((await task(t.id)).task.status).toBe("running");
      expect((await post(`/api/tasks/${t.id}/model`, { model: "small" })).status).toBe(200);
      expect(c.tasks.isLive(t.id)).toBe(true);
      await post(`/api/tasks/${t.id}/send`, { text: "still busy" });
      expect(starts.length).toBe(2);
      await done(t.id);
      expect((await task(t.id)).task.model).toBe("small");
      await post(`/api/tasks/${t.id}/send`, { text: "after" });
      expect(starts.length).toBe(3);
      expect(starts[2]).toMatchObject({ model: "small", resumeSessionId: "sess-1" });
      await done(t.id);
      // no process attached: recorded for the resume. null (or "") = back to the CLI's default
      await c.tasks.release(t.id);
      expect((await post(`/api/tasks/${t.id}/model`, { model: null }).then(j)).model).toBeNull();
      expect((await task(t.id)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text === "model → CLI default (applies when the task resumes)")).toBe(true);
      await post(`/api/tasks/${t.id}/send`, { text: "default again" });
      expect(starts[3]?.model).toBeUndefined();
      expect(starts[3]?.resumeSessionId).toBe("sess-1");
      await done(t.id);
      // a change that lands while the old process is still being released for a turn is the one that turn starts with
      await post(`/api/tasks/${t.id}/send`, { text: "busy again" });
      await c.tasks.setModel(t.id, "big"); // in flight: the process stays, flagged for a restart
      await done(t.id);
      const sending = c.tasks.send(t.id, "racing");
      await new Promise((r) => setTimeout(r, 30)); // dispatch() is now awaiting the release (closeMs)
      await c.tasks.setModel(t.id, "late");
      await sending;
      expect(starts.at(-1)).toMatchObject({ model: "late", resumeSessionId: "sess-1" });
      await done(t.id);
      expect((await post(`/api/tasks/${t.id}/model`, { model: 5 })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks/${t.id}/model`, { method: "POST", headers: { "content-type": "application/json" }, body: "null" })).status).toBe(400);
      expect((await post(`/api/tasks/${t.id}/model`, {})).status).toBe(400);
      expect((await post(`/api/tasks/nope/model`, { model: "big" })).status).toBe(404);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("permission modes (#58): resolved at creation (explicit → saved default → adapter default), validated, switched live or on resume", async () => {
    const starts: StartOptions[] = [];
    const modeChanges: string[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h8 = mkdtempSync(join(tmpdir(), "switchboard-test8-"));
    const c8 = await startServer(loadConfig({ SWITCHBOARD_HOME: h8, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts, modes: ["auto", "plan", "acceptEdits", "bypass"], dangerModes: ["bypass"], defaultMode: "auto", liveSwitch: true, refuseMode: "acceptEdits", modeChanges })], { port: 0 });
    const b8 = `http://127.0.0.1:${c8.server.port}`;
    const post = (path: string, body: unknown, method = "POST") => fetch(`${b8}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const task = (id: string) => fetch(`${b8}/api/tasks/${id}`).then(j);
    try {
      // /api/health lists the modes and the effective default
      const h = await fetch(`${b8}/api/health`).then(j);
      expect(h.runners[0].permissionModes.map((m: { value: string }) => m.value)).toEqual(["auto", "plan", "acceptEdits", "bypass"]);
      expect(h.runners[0].defaultPermissionMode).toBe("auto");
      // explicit mode is stored and reaches the adapter
      const t1 = await post("/api/tasks", { cwd: h8, title: "t1", prompt: "p", runner: "claude", permissionMode: "plan" }).then(j);
      expect(t1.permissionMode).toBe("plan");
      expect(starts[0]?.permissionMode).toBe("plan");
      // omitted → adapter default
      const t2 = await post("/api/tasks", { cwd: h8, title: "t2", prompt: "p", runner: "claude" }).then(j);
      expect(t2.permissionMode).toBe("auto");
      expect(starts[1]?.permissionMode).toBe("auto");
      // unknown → 400 before anything is created
      const bad = await post("/api/tasks", { cwd: h8, title: "t3", prompt: "p", runner: "claude", permissionMode: "bogus" });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain("bogus");
      expect(starts.length).toBe(2);
      // saved runner default: validated, reflected in health, used for the next task, persisted in sqlite
      expect((await post("/api/settings", { defaultPermissionMode: { claude: "bogus" } }, "PATCH")).status).toBe(400);
      expect((await post("/api/settings", { defaultPermissionMode: { codex: "auto" } }, "PATCH")).status).toBe(400); // not installed here
      expect((await post("/api/settings", { defaultPermissionMode: { codex: null } }, "PATCH")).status).toBe(200); // clearing needs no runner
      const danger = await post("/api/settings", { defaultPermissionMode: { claude: "bypass" } }, "PATCH");
      expect(danger.status).toBe(400); // a mode that skips approvals is a per-task choice, never a default
      expect(((await danger.json()) as { error: string }).error).toContain("cannot be a default");
      const saved = await post("/api/settings", { defaultPermissionMode: { claude: "plan" } }, "PATCH").then(j);
      expect(saved.defaultPermissionMode).toEqual({ claude: "plan" });
      expect(saved.runners[0].defaultPermissionMode).toBe("plan");
      expect((await fetch(`${b8}/api/health`).then(j)).runners[0].defaultPermissionMode).toBe("plan");
      expect(c8.db.getSetting("settings", {})).toEqual({ defaultPermissionMode: { claude: "plan" }, autoResume: {}, shadowRunner: null, routing: { llm: { enabled: false, runner: "claude", model: "", timeoutMs: 5000 } }, backlogSweep: { implement: 1, plan: 1 }, judge: { enabled: true, runner: "codex", model: "gpt-6-luna" }, autoStart: { runner: "claude", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 }, evals: { judge: { enabled: true } }, quotaAndResume: { backlogQuotaLimit: 0.8, retryDelayMs: 900_000, retryMaxDelayMs: 14_400_000, maxLimitStops: 8, resumePrompt: "使用上限がリセットされました。中断した箇所から作業を続けてください。", maxStopResumes: 2, thinSample: 5 }, judgeAndChoice: { judgeFallbackRunner: "claude", judgeFallbackModel: "claude-haiku-4-5", judgeTimeoutMs: 60_000, workspaceChoiceTimeoutMs: 60_000 }, newDefaults: { taskRunner: "claude", scheduleCron: "0 3 * * *" }, prices: {} });
      const t4 = await post("/api/tasks", { cwd: h8, title: "t4", prompt: "p", runner: "claude" }).then(j);
      expect(t4.permissionMode).toBe("plan");
      expect(starts[2]?.permissionMode).toBe("plan");
      // null clears the override
      const cleared = await post("/api/settings", { defaultPermissionMode: { claude: null } }, "PATCH").then(j);
      expect(cleared.defaultPermissionMode).toEqual({});
      expect(cleared.runners[0].defaultPermissionMode).toBe("auto");
      // live switch: the adapter is asked first; the task record and transcript change once it agreed, the process stays
      await waitFor(async () => (await task(t1.id)).task.status === "done");
      expect(c8.tasks.isLive(t1.id)).toBe(true);
      const refused = await post(`/api/tasks/${t1.id}/permission-mode`, { mode: "acceptEdits" }); // the fake runner refuses this one
      expect(refused.status).toBe(409);
      expect((await task(t1.id)).task.permissionMode).toBe("plan"); // unchanged: the runner is not in that mode
      expect((await task(t1.id)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.startsWith("permission mode not changed"))).toBe(true);
      const switched = await post(`/api/tasks/${t1.id}/permission-mode`, { mode: "bypass" }).then(j); // danger is fine per task
      expect(switched.permissionMode).toBe("bypass");
      expect(modeChanges).toEqual(["bypass"]);
      expect(c8.tasks.isLive(t1.id)).toBe(true);
      const d1 = await task(t1.id);
      expect(d1.events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text === "permission mode → bypass")).toBe(true);
      expect((await post(`/api/tasks/${t1.id}/permission-mode`, { mode: "bogus" })).status).toBe(400);
      expect((await post(`/api/tasks/${t1.id}/permission-mode`, {})).status).toBe(400);
      expect((await post(`/api/tasks/nope/permission-mode`, { mode: "plan" })).status).toBe(404);
      // a follow-up on the switched task reuses the live process (no restart needed)
      await post(`/api/tasks/${t1.id}/send`, { text: "more" });
      expect(starts.length).toBe(3);
    } finally {
      await c8.stop();
      rmSync(h8, { recursive: true, force: true });
    }

    // An adapter that cannot switch a live process: the idle process is released and the next turn resumes with the new mode.
    const starts2: StartOptions[] = [];
    const h9 = mkdtempSync(join(tmpdir(), "switchboard-test9-"));
    const c9 = await startServer(loadConfig({ SWITCHBOARD_HOME: h9, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts: starts2, modes: ["auto", "plan"], defaultMode: "auto", slowMs: 150 })], { port: 0 });
    const b9 = `http://127.0.0.1:${c9.server.port}`;
    try {
      const t = await fetch(`${b9}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h9, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(c9.tasks.isLive(t.id)).toBe(true);
      const r = await fetch(`${b9}/api/tasks/${t.id}/permission-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "plan" }) }).then(j);
      expect(r.permissionMode).toBe("plan");
      expect(r.status).toBe("done"); // releasing the idle process is not an abort
      expect(c9.tasks.isLive(t.id)).toBe(false);
      const sent = await fetch(`${b9}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) }).then(j);
      expect(sent.status).toBe("running");
      expect(starts2.length).toBe(2);
      expect(starts2[1]).toMatchObject({ permissionMode: "plan", resumeSessionId: "sess-1" });
      // a mode change while a turn is in flight (no live switch): the running process keeps taking follow-ups, never a second process
      await waitFor(async () => (await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status === "done");
      await fetch(`${b9}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "busy" }) });
      expect((await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status).toBe("running");
      expect((await fetch(`${b9}/api/tasks/${t.id}/permission-mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "auto" }) })).status).toBe(200);
      expect(c9.tasks.isLive(t.id)).toBe(true);
      await fetch(`${b9}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "still busy" }) });
      expect(starts2.length).toBe(2); // reused the in-flight process
      await waitFor(async () => (await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(c9.tasks.isLive(t.id)).toBe(true);
      await fetch(`${b9}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "after" }) });
      expect(starts2.length).toBe(3); // idle now → restarted with the new mode
      expect(starts2[2]).toMatchObject({ permissionMode: "auto", resumeSessionId: "sess-1" });
      await waitFor(async () => (await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // a task from before #58 (permission_mode NULL) resolves its mode when resumed and records it
      await c9.tasks.release(t.id);
      expect(c9.tasks.isLive(t.id)).toBe(false);
      c9.db.updateTask(t.id, { permissionMode: null });
      await fetch(`${b9}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "legacy" }) });
      expect(starts2.length).toBe(4);
      expect(starts2[3]?.permissionMode).toBe("auto");
      expect((await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.permissionMode).toBe("auto");
      await waitFor(async () => (await fetch(`${b9}/api/tasks/${t.id}`).then(j)).task.status === "done"); // let the slow turn finish before the daemon stops
    } finally {
      await c9.stop();
      rmSync(h9, { recursive: true, force: true });
    }

    // A runner without modes (DAK) rejects any mode and records null.
    const h10 = mkdtempSync(join(tmpdir(), "switchboard-test10-"));
    const c10 = await startServer(loadConfig({ SWITCHBOARD_HOME: h10, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script)], { port: 0 });
    const b10 = `http://127.0.0.1:${c10.server.port}`;
    try {
      expect((await fetch(`${b10}/api/health`).then(j)).runners[0]).toMatchObject({ permissionModes: [] });
      const t = await fetch(`${b10}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h10, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      expect(t.permissionMode).toBeNull();
      expect((await fetch(`${b10}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h10, title: "t", prompt: "p", runner: "claude", permissionMode: "auto" }) })).status).toBe(400);
      expect((await fetch(`${b10}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultPermissionMode: { claude: "auto" } }) })).status).toBe(400);
    } finally {
      await c10.stop();
      rmSync(h10, { recursive: true, force: true });
    }
  });

  test("usage-limit auto-resume (#102): the stop is recorded with resumeAt, the setting is per runner and validated, resume now / cancel through the API", async () => {
    const starts: StartOptions[] = [];
    const banner = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "sess-9", cwd: "/tmp" },
      { t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.06, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } },
      { t: "message.delta", role: "assistant", text: banner },
      { t: "session.end", status: "error", summary: banner },
    ];
    const h12 = mkdtempSync(join(tmpdir(), "switchboard-test12-"));
    const c12 = await startServer(loadConfig({ SWITCHBOARD_HOME: h12, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts })], { port: 0 });
    const b12 = `http://127.0.0.1:${c12.server.port}`;
    const call = (path: string, method = "POST", body?: unknown) => fetch(`${b12}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const task = (id: string) => fetch(`${b12}/api/tasks/${id}`).then(j);
    try {
      // off by default, reported per runner
      expect((await fetch(`${b12}/api/health`).then(j)).runners[0].autoResume).toBe(false);
      expect((await fetch(`${b12}/api/settings`).then(j)).autoResume).toEqual({});
      // validated: only an installed runner can be switched on; off / null needs nothing
      expect((await call("/api/settings", "PATCH", { autoResume: { codex: true } })).status).toBe(400);
      expect((await call("/api/settings", "PATCH", { autoResume: { codex: null } })).status).toBe(200);
      const on = await call("/api/settings", "PATCH", { autoResume: { claude: true } }).then(j);
      expect(on.autoResume).toEqual({ claude: true });
      expect(on.runners[0].autoResume).toBe(true);
      // a task stopping on the limit: status error, resumeAt an hour+ away, a note in the transcript
      const t = await call("/api/tasks", "POST", { cwd: h12, title: "t", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => (await task(t.id)).task.status === "error");
      await waitFor(async () => (await task(t.id)).task.resumeAt !== null);
      const stopped = await task(t.id);
      expect(stopped.task.resumeAt).toBeGreaterThan(Date.now() + 3500 * 1000);
      expect(stopped.events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.includes("自動再開します"))).toBe(true);
      // cancel forgets the plan; a second cancel is a no-op; unknown task 404
      const cancelled = await call(`/api/tasks/${t.id}/resume`, "DELETE").then(j);
      expect(cancelled.resumeAt).toBeNull();
      expect((await call(`/api/tasks/${t.id}/resume`, "DELETE")).status).toBe(200);
      expect((await call("/api/tasks/nope/resume", "DELETE")).status).toBe(404);
      // resume now: a follow-up turn on the same session, at once
      const resumed = await call(`/api/tasks/${t.id}/resume`, "POST").then(j);
      expect(resumed.status).toBe("running");
      await waitFor(async () => (await task(t.id)).task.status === "error"); // the fake hits the limit again
      const again = await task(t.id);
      // the fake does not echo the first prompt (the real adapters do); the resume turn is the one user message, in the daemon's words
      const userTurns = again.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "message.delta" && e.role === "user");
      expect(userTurns.length).toBe(1);
      expect(userTurns[0].text).toContain("Switchboard 自動再開");
      expect(again.task.resumeAt).not.toBeNull(); // planned once more
      // switching the setting off keeps the plan (shown, not acted on) and is reflected in health
      const off = await call("/api/settings", "PATCH", { autoResume: { claude: false } }).then(j);
      expect(off.autoResume).toEqual({});
      expect((await fetch(`${b12}/api/health`).then(j)).runners[0].autoResume).toBe(false);
      expect((await task(t.id)).task.resumeAt).not.toBeNull();
      // a reply from the person supersedes the plan (ratelimit.test.ts pins the clearing itself; here the fake stops
      // again at once, so what is observable is the new plan of the new stop)
      const notes = (d: { events: Array<{ ev: AgentEvent }> }) => d.events.filter((e) => e.ev.t === "status" && e.ev.text.includes("使用上限で停止")).length;
      const before = notes(await task(t.id));
      await call(`/api/tasks/${t.id}/send`, "POST", { text: "続けて" });
      await waitFor(async () => (await task(t.id)).task.status === "error");
      expect(notes(await task(t.id))).toBe(before + 1); // the new stop was recorded (and planned) afresh
      // 中断 clears it as well
      expect((await task(t.id)).task.resumeAt).not.toBeNull();
      const aborted = await call(`/api/tasks/${t.id}/abort`, "POST").then(j);
      expect(aborted.resumeAt).toBeNull();
      expect(starts.length).toBe(1); // every turn reused the lingering process
    } finally {
      await c12.stop();
      rmSync(h12, { recursive: true, force: true });
    }
  });

  test("migrate(): a database created before budgets/billing gains the columns without losing rows", () => {
    const p = join(home, "old.db");
    const raw = new (require("bun:sqlite").Database)(p, { create: true });
    raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, runner TEXT NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE staging (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, rel TEXT NOT NULL, kind TEXT NOT NULL, before_text TEXT, after_text TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, decided_at INTEGER);
      INSERT INTO tasks VALUES ('task_old', NULL, 'old', 'claude', '/tmp', '[]', 'done', NULL, NULL, 1, 1);
      INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, source, ts) VALUES ('task_old', 'claude', 'm', 1, 1, 0, 0, 0.5, 'reported', ${Date.now()});`);
    raw.close();
    const db = new Db(p);
    expect(db.getTask("task_old")).toMatchObject({ budgetUsd: null, routing: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null });
    expect(db.listTasksWithResume()).toEqual([]); // the #102 column exists on an upgraded database too
    expect(db.listHistoryImports()).toEqual([]); // the #91 table exists on an upgraded database too
    // staging from before #12 (no diff_text / stat): inserts must not fail on the user's real database (#66)
    const scols = (db.sqlite.query("PRAGMA table_info(staging)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(scols).toEqual(expect.arrayContaining(["diff_text", "stat"]));
    db.insertStaged({ id: "st1", taskId: "task_old", path: "/tmp/x", rel: "x", kind: "write", before: null, after: "a", status: "pending", ts: 1, decidedAt: null, diff: "+a", stat: "+1 −0" });
    expect(db.listStaged("task_old")[0]).toMatchObject({ id: "st1", diff: "+a", stat: "+1 −0" });
    expect(db.updateTask("task_old", { permissionMode: "plan" })?.permissionMode).toBe("plan");
    expect(db.getSetting("settings", { none: true })).toEqual({ none: true });
    expect(db.ledgerSummary().todayUsd).toBeCloseTo(0.5, 6);
    expect(db.ledgerSummary().billedTodayUsd).toBe(0); // historical rows carry no billed figure
    db.close();
  });

  test("autoStart (#832): the default is claude with the CLI's model; PATCH is partial, refuses an undetected runner and resets the model with the runner", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { runner: "dak" } })).status).toBe(400); // not detected here
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart.runner).toBe("claude");
      expect((await patch({ autoStart: { model: "m1" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m1", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      // a runner change on its own goes back to that runner's CLI default; with a model it takes the model
      expect((await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { runner: "claude", model: "m2" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m2", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { runner: "claude" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m2", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 }); // same runner: the model stays
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart effort (#833): empty by default; PATCH keeps one the runner lists, refuses another, and empties it with a runner change; a settings row from before reads as empty", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-effort-"));
    const pre = new Db(join(h, "switchboard.db"));
    pre.setSetting("settings", { autoStart: { runner: "claude", model: "m" } }); // saved by #832, before the effort
    pre.close();
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, efforts: ["low", "high"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, efforts: ["medium"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { effort: "high" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart.effort).toBe("high");
      const bad = await patch({ autoStart: { effort: "max" } });
      expect(bad.status).toBe(400);
      expect((await j(bad)).error).toContain('unknown effort "max"');
      expect((await patch({ autoStart: { runner: "codex", effort: "high" } })).status).toBe(400); // high is claude's, not codex's
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9 }); // a refused PATCH saves nothing
      expect((await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { runner: "codex", effort: "medium" } }).then(j)).autoStart.effort).toBe("medium");
      expect((await patch({ autoStart: { effort: "" } }).then(j)).autoStart.effort).toBe(""); // back to the CLI default
      const saved = c.db.getSetting("settings", {}) as Record<string, unknown>;
      c.db.setSetting("settings", { ...saved, autoStart: { runner: "codex", model: "", effort: "ultra" } }); // kept from a version whose list had it
      expect((await patch({ autoStart: { model: "m3" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "m3", effort: "ultra", byKind: {}, fallback: [], fallbackAt: 0.9 }); // not checked again
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart by kind (#1337): PATCH saves one kind and leaves the others to 共通; null removes it; an undetected runner and an unknown effort are 400; a runner change resets that kind's model and effort; a row without byKind reads as {}", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-kind-"));
    const pre = new Db(join(h, "switchboard.db"));
    pre.setSetting("settings", { autoStart: { runner: "claude", model: "m", effort: "high" } }); // saved before #1337
    pre.close();
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, efforts: ["low", "high"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, efforts: ["medium"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await get()).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9 }); // every kind follows 共通
      // a runner change on one kind: that kind's model and effort go back to the CLI default; the others stay on 共通
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex" } } } }).then(j)).autoStart.byKind).toEqual({ check: { runner: "codex", model: "", effort: "" } });
      // without a runner, the base is the common values
      expect((await patch({ autoStart: { byKind: { complete: { model: "m-big" } } } }).then(j)).autoStart.byKind).toEqual({ check: { runner: "codex", model: "", effort: "" }, complete: { runner: "claude", model: "m-big", effort: "high" } });
      // over a kind's saved choice
      expect((await patch({ autoStart: { byKind: { check: { model: "gpt-mini", effort: "medium" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "gpt-mini", effort: "medium" });
      expect((await patch({ autoStart: { byKind: { fix: { runner: "dak" } } } })).status).toBe(400); // not detected here
      const bad = await patch({ autoStart: { byKind: { check: { effort: "high" } } } }); // high is claude's, not codex's
      expect(bad.status).toBe(400);
      expect((await j(bad)).error).toContain('unknown effort "high"');
      expect((await patch({ autoStart: { byKind: { request: { runner: "codex", effort: "high" } } } })).status).toBe(400);
      expect((await get()).autoStart.byKind).toEqual({ check: { runner: "codex", model: "gpt-mini", effort: "medium" }, complete: { runner: "claude", model: "m-big", effort: "high" } }); // a refused PATCH saves nothing
      // a runner change on a kind with its own model and effort: compared with that kind's runner, not the common one (claude here)
      expect((await patch({ autoStart: { byKind: { check: { runner: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "claude", model: "", effort: "" });
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", model: "gpt-mini", effort: "medium" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "gpt-mini", effort: "medium" });
      // the common runner's change leaves the kinds alone
      const common = (await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart;
      expect(common).toEqual({ runner: "codex", model: "", effort: "", byKind: { check: { runner: "codex", model: "gpt-mini", effort: "medium" }, complete: { runner: "claude", model: "m-big", effort: "high" } }, fallback: [], fallbackAt: 0.9 });
      // null: back to 共通
      expect((await patch({ autoStart: { byKind: { check: null } } }).then(j)).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
      expect((await get()).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
      expect((await patch({ autoStart: { byKind: { nope: { runner: "codex" } } } })).status).toBe(200); // unknown keys are dropped, like the rest of SettingsPatch
      expect((await get()).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart fallback (#834): the order is empty and the threshold 0.9 by default; PATCH replaces the order whole and refuses an undetected runner or a threshold out of range", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-fallback-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toMatchObject({ fallback: [], fallbackAt: 0.9 });
      expect((await patch({ autoStart: { fallback: ["codex", "claude"], fallbackAt: 0.85 } }).then(j)).autoStart).toMatchObject({ runner: "claude", fallback: ["codex", "claude"], fallbackAt: 0.85 });
      expect((await patch({ autoStart: { fallback: ["codex"] } }).then(j)).autoStart).toMatchObject({ fallback: ["codex"], fallbackAt: 0.85 });
      for (const body of [{ autoStart: { fallback: ["codex", "dak"] } }, { autoStart: { fallbackAt: 0.4 } }, { autoStart: { fallbackAt: 1.1 } }]) expect((await patch(body)).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toMatchObject({ fallback: ["codex"], fallbackAt: 0.85 }); // a refused PATCH saves nothing
      expect((await patch({ autoStart: { fallback: [] } }).then(j)).autoStart.fallback).toEqual([]);
      // a runner saved in the order that is no longer detected does not lock it: the order can be edited around it
      const saved = c.db.getSetting("settings", {}) as Record<string, any>;
      c.db.setSetting("settings", { ...saved, autoStart: { ...saved.autoStart, fallback: ["codex", "dak"] } });
      expect((await patch({ autoStart: { fallback: ["dak"] } }).then(j)).autoStart.fallback).toEqual(["dak"]);
      expect((await patch({ autoStart: { fallback: ["dak", "codex"] } }).then(j)).autoStart.fallback).toEqual(["dak", "codex"]);
      expect((await patch({ autoStart: { fallback: ["codex"] } }).then(j)).autoStart.fallback).toEqual(["codex"]);
      expect((await patch({ autoStart: { fallback: ["codex", "dak"] } })).status).toBe(400); // once out of the order, dak is new again
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart fallback (#834): feedback and a prompt schedule start on the order's next runner while the decided one is at its limit, on the CLI default model, with a status line; not when every runner is, nor with an empty order", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-fallback-start-"));
    const claudeStarts: StartOptions[] = [];
    const codexStarts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "quota"), { starts: claudeStarts }), fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "quota"), { id: "codex", starts: codexStarts })], { port: 0, selfdevChecks: false, dryRunRestart: true });
    const b = `http://127.0.0.1:${c.server.port}`;
    const feedback = (text: string, mode?: "fix") => fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text, ...(mode ? { mode } : {}) }) }).then(async (r) => [r.status, await r.json()] as [number, Task]);
    const statuses = (id: string) => c.db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
    const until = async (ok: () => boolean) => { for (let i = 0; !ok() && i < 200; i++) await Bun.sleep(10); };
    try {
      const inHour = Math.floor(Date.now() / 1000) + 3600;
      c.db.upsertQuota("claude", "five_hour", 0.95, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-claude", effort: "high", fallback: ["codex"] } });
      // (b, c) the feedback button: codex starts it, without claude's model / effort, and the transcript says why
      const [status, task] = await feedback("上限の間の要望");
      expect(status).toBe(201);
      expect(task.runner).toBe("codex");
      await until(() => codexStarts.length > 0);
      expect(claudeStarts).toHaveLength(0);
      expect(codexStarts[0]!.model).toBeUndefined();
      expect(codexStarts[0]!.effort).toBeUndefined();
      expect(statuses(task.id)).toEqual([`claude が上限（0.95、${fmtTime(inHour * 1000, Date.now())} に戻る）のため codex で開始`]);
      // a kind's own runner (#1337) at its limit gives way the same
      c.db.setSetting("settings", { autoStart: { runner: "codex", byKind: { fix: { runner: "claude", model: "m-fix", effort: "" } }, fallback: ["claude", "codex"] } });
      const [, fixed] = await feedback("直して", "fix");
      expect(fixed.runner).toBe("codex");
      await until(() => codexStarts.length > 1);
      expect(codexStarts[1]!.model).toBeUndefined();
      // (f) a prompt schedule
      const wsId = c.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
      const sch = await fetch(`${b}/api/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "nightly", cron: "@nightly", workspaceId: wsId, runner: "claude", model: "m-sch", prompt: "run" }) }).then(j);
      const ran = (await fetch(`${b}/api/schedules/${sch.id}/run`, { method: "POST" }).then(j)) as Task;
      expect(ran.runner).toBe("codex");
      await until(() => codexStarts.length > 2);
      expect(codexStarts[2]!.model).toBeUndefined();
      expect(statuses(ran.id)).toEqual([`claude が上限（0.95、${fmtTime(inHour * 1000, Date.now())} に戻る）のため codex で開始`]);
      expect(JSON.stringify(await fetch(`${b}/api/schedules/log`).then(j))).toContain("nightly: claude が上限");
      // (d) codex at its limit too: the decided runner, no status
      c.db.upsertQuota("codex", "seven_day", 0.97, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude", fallback: ["codex"] } });
      const [, both] = await feedback("どちらも上限");
      expect(both.runner).toBe("claude");
      await until(() => claudeStarts.length > 0);
      expect(statuses(both.id)).toEqual([]);
      // (e) an empty order: claude as before
      c.db.upsertQuota("codex", "seven_day", 0.1, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude" } });
      const [, none] = await feedback("順が空");
      expect(none.runner).toBe("claude");
      // a window that has reset is not at its limit
      c.db.upsertQuota("claude", "five_hour", 0.99, Math.floor(Date.now() / 1000) - 60);
      c.db.setSetting("settings", { autoStart: { runner: "claude", fallback: ["codex"] } });
      const [, reset] = await feedback("戻った後");
      expect(reset.runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("settings tunables (#835): the defaults are the constants core used; PATCH is partial per group, null puts a group back, out of range is 400 and saves nothing", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-tunables-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // (a) the defaults are today's constants, and GET says what they are
      const first = await get();
      const constants = {
        quotaAndResume: { backlogQuotaLimit: QUOTA_LIMIT, retryDelayMs: FALLBACK_DELAY_MS, retryMaxDelayMs: MAX_FALLBACK_DELAY_MS, maxLimitStops: MAX_CONSECUTIVE_STOPS, resumePrompt: first.quotaAndResume.resumePrompt, maxStopResumes: MAX_STOP_RESUMES, thinSample: 5 },
        judgeAndChoice: { judgeFallbackRunner: JUDGE_FALLBACK.runner, judgeFallbackModel: JUDGE_FALLBACK.model, judgeTimeoutMs: JUDGE_TIMEOUT_MS, workspaceChoiceTimeoutMs: 60_000 },
        newDefaults: { taskRunner: "claude", scheduleCron: "0 3 * * *" },
      };
      expect(`${AUTO_RESUME_HEAD} ${first.quotaAndResume.resumePrompt}`).toBe(RESUME_PROMPT);
      for (const k of ["quotaAndResume", "judgeAndChoice", "newDefaults"] as const) {
        expect(first[k]).toEqual(constants[k]);
        expect(first.defaults[k]).toEqual(constants[k]);
      }
      // (b) a partial patch keeps the other items; null puts the group back
      const changed = await patch({ quotaAndResume: { backlogQuotaLimit: 0.5, maxLimitStops: 3 }, judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "m" }, newDefaults: { scheduleCron: "0 4 * * *" } }).then(j);
      expect(changed.quotaAndResume).toEqual({ ...constants.quotaAndResume, backlogQuotaLimit: 0.5, maxLimitStops: 3 });
      expect(changed.judgeAndChoice).toEqual({ ...constants.judgeAndChoice, judgeFallbackRunner: "codex", judgeFallbackModel: "m" });
      expect(changed.newDefaults).toEqual({ taskRunner: "claude", scheduleCron: "0 4 * * *" });
      expect(changed.defaults.quotaAndResume).toEqual(constants.quotaAndResume);
      expect((await patch({ quotaAndResume: { retryDelayMs: 60_000 } }).then(j)).quotaAndResume).toMatchObject({ backlogQuotaLimit: 0.5, maxLimitStops: 3, retryDelayMs: 60_000 });
      expect((await patch({ quotaAndResume: null }).then(j)).quotaAndResume).toEqual(constants.quotaAndResume);
      const reset = await get();
      expect(reset.quotaAndResume).toEqual(constants.quotaAndResume);
      expect(reset.judgeAndChoice.judgeFallbackRunner).toBe("codex"); // the other groups stay
      const back = await patch({ judgeAndChoice: null, newDefaults: null }).then(j);
      expect(back.judgeAndChoice).toEqual(constants.judgeAndChoice);
      expect(back.newDefaults).toEqual(constants.newDefaults);
      // (c, d) out of range is 400, and nothing of that patch is saved
      await patch({ quotaAndResume: { maxLimitStops: 4 }, newDefaults: { taskRunner: "codex" } });
      const saved = await get();
      for (const body of [
        { quotaAndResume: { backlogQuotaLimit: 0 } },
        { quotaAndResume: { backlogQuotaLimit: 1.1 } },
        { quotaAndResume: { backlogQuotaLimit: -0.1 } },
        { quotaAndResume: { maxLimitStops: 0 } },
        { quotaAndResume: { maxStopResumes: 0 } },
        { quotaAndResume: { thinSample: 0 } },
        { quotaAndResume: { retryDelayMs: -1 } },
        { quotaAndResume: { retryDelayMs: 7_200_000, retryMaxDelayMs: 3_600_000 } },
        { quotaAndResume: { retryDelayMs: 20_000_000 } }, // past the saved maximum of 4 h
        { quotaAndResume: { resumePrompt: "  " } },
        { judgeAndChoice: { judgeTimeoutMs: -5 } },
        { judgeAndChoice: { judgeFallbackRunner: "dak" } }, // not detected here
        { newDefaults: { taskRunner: "dak" } },
        { newDefaults: { scheduleCron: "bogus" } },
        { quotaAndResume: { maxLimitStops: 9 }, newDefaults: { scheduleCron: "bogus" } }, // the valid half is not saved either
      ]) {
        const r = await patch(body);
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect(await get()).toEqual(saved);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart (#832): a database saved before it starts at the runner of routing.llm; one that has it is left alone", () => {
    const p = join(mkdtempSync(join(tmpdir(), "switchboard-test-autostart-mig-")), "sb.db");
    const first = new Db(p);
    first.setSetting("settings", { routing: { llm: { enabled: true, runner: "codex" } } });
    first.close();
    const migrated = new Db(p);
    expect(migrated.getSetting("settings", {})).toEqual({ routing: { llm: { enabled: true, runner: "codex" } }, autoStart: { runner: "codex", model: "" } });
    migrated.setSetting("settings", { routing: { llm: { runner: "codex" } }, autoStart: { runner: "claude", model: "m" } });
    migrated.close();
    const again = new Db(p);
    expect((again.getSetting("settings", {}) as { autoStart: unknown }).autoStart).toEqual({ runner: "claude", model: "m" });
    again.close();
    const empty = new Db(join(mkdtempSync(join(tmpdir(), "switchboard-test-autostart-mig-")), "sb.db"));
    expect(empty.getSetting("settings", { none: true })).toEqual({ none: true }); // no row: nothing to move
    empty.close();
  });

  test("a daemon start closes tasks a previous daemon left running / waiting, and reports a temp data directory (#64)", async () => {
    const h11 = mkdtempSync(join(tmpdir(), "switchboard-test11-"));
    try {
      // what a crashed / replaced daemon leaves behind
      const pre = new Db(join(h11, "switchboard.db"));
      const now = Date.now();
      const mk = (id: string, status: "running" | "waiting" | "done") => pre.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: h11, scope: [h11], status, runnerSessionId: "sess-" + id, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      mk("task_run", "running");
      mk("task_wait", "waiting");
      mk("task_done", "done");
      pre.appendEvent("task_wait", { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: {}, detail: "rm -rf" });
      pre.close();
      const c11 = await startServer(loadConfig({ SWITCHBOARD_HOME: h11, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
      const b11 = `http://127.0.0.1:${c11.server.port}`;
      try {
        for (const id of ["task_run", "task_wait"]) {
          const d = await fetch(`${b11}/api/tasks/${id}`).then(j);
          expect(d.task.status).toBe("aborted");
          const last = d.events.map((e: { ev: AgentEvent }) => e.ev).findLast((e: AgentEvent) => e.t === "session.end");
          expect(last).toMatchObject({ t: "session.end", status: "aborted" });
          // and the cut turn is planned to continue (interrupted.ts): the note comes after the close
          expect(d.events.at(-1)!.ev.text).toStartWith("デーモンの停止でターンが中断されました");
          expect(d.task.resumeAt).not.toBeNull();
          // (asserted separately: bun's toMatchObject leaves its asymmetric matcher in the received object)
          expect(last.summary).toContain("前回のデーモン");
          expect(last.summary).toContain("同じセッション"); // both have a runner session id
        }
        // the orphaned ask is resolved (denied by timeout) so its tool row does not stay 承認待ち
        const w = await fetch(`${b11}/api/tasks/task_wait`).then(j);
        expect(w.events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.resolved")).toMatchObject({ id: "p1", decision: "deny", by: "timeout" });
        expect(w.events.filter((e: { ev: AgentEvent }) => e.ev.t === "session.end")).toHaveLength(1);
        expect((await fetch(`${b11}/api/tasks/task_done`).then(j)).task.status).toBe("done");
        expect((await fetch(`${b11}/api/queue`).then(j)).waiting).toEqual([]); // the orphaned ask is no longer "needs a person"
        // a resume still works: the session id survived, only the status changed
        const sent = await fetch(`${b11}/api/tasks/task_run/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "go on" }) }).then(j);
        expect(sent.status).toBe("running");
        // the test home is under os.tmpdir(): health says so, the way the UI banner needs it
        const h = await fetch(`${b11}/api/health`).then(j);
        expect(h.homeIsTemp).toBe(true);
        expect(h.home).toBe(h11);
        expect(typeof h.homeDisplay).toBe("string");
      } finally {
        await c11.stop();
      }
      // abortOrphanedTasks() on a database with nothing to do is a no-op
      const again = new Db(join(h11, "switchboard.db"));
      expect(abortOrphanedTasks(again)).toEqual([]);
      again.close();
    } finally {
      rmSync(h11, { recursive: true, force: true });
    }
    expect(isTempDir(join(tmpdir(), "x"))).toBe(true);
    expect(isTempDir("/var/folders/s8/abc/T/tmp.MJ2Lr7uOE5")).toBe(true);
    expect(isTempDir("/tmp")).toBe(true);
    expect(isTempDir("/var/tmp/x")).toBe(true);
    expect(isTempDir("/Users/x/.switchboard")).toBe(false);
    expect(loadConfig({ SWITCHBOARD_HOME: homedir(), SWITCHBOARD_DB: join(tmpdir(), "db") }).homeIsTemp).toBe(true); // the database is what must not vanish (loadConfig mkdirs the home, so it must exist)
    expect(isTempDir("/tmpfoo/bar")).toBe(false);
  });

  test("SWITCHBOARD_REPO_ROOT: the meta workspace is the tree agents edit; the web UI and config defaults come from the running code (#178)", () => {
    const here = loadConfig({ SWITCHBOARD_HOME: home });
    expect(here.repoRoot).toBe(here.codeRoot);
    const released = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(home, "checkout") });
    expect(released.repoRoot).toBe(join(home, "checkout"));
    expect(released.codeRoot).toBe(here.codeRoot);
    expect(released.webDist).toBe(join(here.codeRoot, "apps", "web", "dist"));
  });

  test("SWITCHBOARD_REPO_ROOT: shipped defaults are read from the running code, not from the checkout agents edit (#178)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-coderoot-"));
    const checkout = join(h, "checkout");
    mkdirSync(join(checkout, "packages", "core", "config"), { recursive: true });
    writeFileSync(join(checkout, "packages", "core", "config", "pricing.json"), JSON.stringify({ edited: "by an agent" }));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false });
    try {
      const pricing = await fetch(`http://127.0.0.1:${c.server.port}/api/ledger/pricing`).then(j);
      expect(pricing.source).toBe("<repo>/packages/core/config/pricing.json"); // <repo> stands for codeRoot
      expect(pricing.edited).toBeUndefined();
      expect((await fetch(`http://127.0.0.1:${c.server.port}/api/workspaces`).then(j)).find((w: { kind: string }) => w.kind === "meta").path).toBe(checkout);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("candidate: a daemon started on a copy of the database starts no schedules, resumes or log imports (#178)", async () => {
    const spies = [spyOn(Scheduler.prototype, "start"), spyOn(RateLimitResumer.prototype, "start"), spyOn(HistoryImporter.prototype, "start")];
    try {
      for (const [candidate, calls] of [["1", 0], [undefined, 1]] as const) {
        const h = mkdtempSync(join(tmpdir(), "switchboard-test-candidate-"));
        const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_CANDIDATE: candidate }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false });
        try {
          expect((await fetch(`http://127.0.0.1:${c.server.port}/api/health`).then(j)).ok).toBe(true); // it still serves what sb-rescue checks
          expect(spies.map((s) => s.mock.calls.length)).toEqual([calls, calls, calls]);
        } finally {
          await c.stop();
          rmSync(h, { recursive: true, force: true });
        }
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("promote: a daemon under sb-rescue relays the commit and reports the release; without sb-rescue it says so (#178)", async () => {
    expect(await fetch(`${base}/api/daemon/release`).then(j)).toEqual({ managed: false });
    expect((await fetch(`${base}/api/daemon/promote`, { method: "POST", body: "{}" })).status).toBe(409);

    const seen: Array<{ path: string; auth: string | null; body: unknown }> = [];
    const history = Array.from({ length: 7 }, (_, i) => ({ ts: i, action: "rejected", from: "a", to: "b", ok: false, reason: `reason ${i}` }));
    const rescue = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : null });
        return path === "/api/status" ? Response.json({ current: "c".repeat(40), previous: null, state: "running", busy: null, lastError: "promote: disk full while taking the snapshot", history }) : Response.json({ started: "promote" }, { status: 202 });
      },
    });
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-promote-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}`, SWITCHBOARD_WEB_URL: "https://d1.example.net" }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0, selfdevChecks: false });
    const url = `http://127.0.0.1:${c.server.port}`;
    try {
      const rel = await fetch(`${url}/api/daemon/release`).then(j);
      expect(rel).toMatchObject({ managed: true, rescuePage: "https://d1.example.net/rescue/", current: "c".repeat(40), state: "running", busy: null, lastError: "promote: disk full while taking the snapshot" }); // a failure outside the history still reaches the UI
      expect(rel.head).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof rel.dirty).toBe("boolean");
      expect(rel.history.map((x: { reason: string }) => x.reason)).toEqual(["reason 0", "reason 1", "reason 2", "reason 3", "reason 4"]);

      const ok = await fetch(`${url}/api/daemon/promote`, { method: "POST", body: "{}" });
      expect(ok.status).toBe(202);
      expect(await ok.json()).toEqual({ started: "promote", commit: rel.head });
      expect(seen.at(-1)).toMatchObject({ path: "/api/promote", body: { commit: rel.head } });
      expect(seen.at(-1)!.auth).toBe(`Bearer ${readFileSync(join(h, "token"), "utf8").trim()}`);

      // a waiting task would be cut off by the restart a promotion ends with
      await fetch(`${url}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "busy", prompt: "p", runner: "claude" }) });
      const before = seen.length;
      const refused = await fetch(`${url}/api/daemon/promote`, { method: "POST", body: "{}" });
      expect(refused.status).toBe(409);
      expect(seen.length).toBe(before);
      expect((await fetch(`${url}/api/daemon/promote`, { method: "POST", body: JSON.stringify({ force: true, commit: "abc1234" }) })).status).toBe(202);
      expect(seen.at(-1)!.body).toEqual({ commit: "abc1234" });

      await rescue.stop(true);
      expect(await fetch(`${url}/api/daemon/release`).then(j)).toMatchObject({ managed: false, error: expect.stringContaining("sb-rescue did not answer") });
      expect((await fetch(`${url}/api/daemon/promote`, { method: "POST", body: JSON.stringify({ force: true }) })).status).toBe(424);
    } finally {
      await c.stop();
      await rescue.stop(true);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("promote: release counts the commits from the running version to HEAD and the running tasks (#1660)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "switchboard-test-ahead-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "first"); git("commit", "-q", "--allow-empty", "-m", "second: the head");
    const head = git("rev-parse", "HEAD");
    const first = git("rev-parse", "HEAD~1");
    let current = head;
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ current, previous: null, state: "running", busy: null, lastError: null, history: [] }) });
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-ahead-home-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0, selfdevChecks: false });
    const url = `http://127.0.0.1:${c.server.port}`;
    try {
      const rel = () => fetch(`${url}/api/daemon/release`).then(j);
      expect(await rel()).toMatchObject({ head, headSubject: "second: the head", ahead: 0, busyTasks: 0 });
      current = first;
      expect((await rel()).ahead).toBe(1);
      git("commit", "-q", "--allow-empty", "-m", "third");
      current = git("rev-parse", "HEAD");
      git("reset", "-q", "--hard", head); // HEAD is now inside the running version
      expect((await rel()).ahead).toBe(0);
      current = "d".repeat(40);
      expect((await rel()).ahead).toBeNull();
      await fetch(`${url}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "busy", prompt: "p", runner: "claude" }) });
      expect((await rel()).busyTasks).toBe(1);
    } finally {
      await c.stop();
      await rescue.stop(true);
      rmSync(h, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("self-dev: checks are only offered for meta-workspace tasks; restart refuses while tasks run or checks are missing", async () => {
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "not meta", prompt: "p", runner: "claude" }) }).then(j);
    const c = await fetch(`${base}/api/tasks/${t.id}/checks`).then(j);
    expect(c).toEqual({ run: null, running: false, meta: false, current: false });
    expect((await fetch(`${base}/api/tasks/${t.id}/checks`, { method: "POST" })).status).toBe(400);
    // this task is waiting on a permission → restart refused; and a task without checks cannot restart either
    const busy = await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }) });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("running");
    const ask = (await getTask(t.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await fetch(`${base}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "deny" }) });
    await waitFor(async () => (await getTask(t.id)).task.status === "done");
    await waitFor(async () => !core.tasks.isLive(t.id) || core.db.listTasks().every((x) => x.status !== "running" && x.status !== "waiting"));
    // no taskId and no force → the checks gate cannot be evaluated → 400 (never a silent bypass)
    expect((await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    const noChecks = await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: t.id }) });
    expect(noChecks.status).toBe(409);
    expect(((await noChecks.json()) as { error: string }).error).toContain("checks");
    // dry run: the argv is the running daemon's own command line
    const dry = await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) }).then(j);
    expect(dry.restarting).toBe(false);
    expect(dry.supervised).toBe(false);
    expect(dry.argv[0]).toBe(process.execPath);
  });

  test("schedules API: create, validate, run manually, and list; queue reflects the result", async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ws = await fetch(`${base}/api/workspaces`).then(j);
    const wsId = ws.find((w: { kind: string }) => w.kind === "meta").id; // the brief test above registers a repo workspace, which sorts first
    const bad = await post("/api/schedules", { title: "x", cron: "nonsense", workspaceId: wsId, runner: "claude", prompt: "p" });
    expect(bad.status).toBe(400);
    const s = await post("/api/schedules", { title: "nightly", cron: "@nightly", workspaceId: wsId, runner: "claude", prompt: "run the nightly check" }).then(j);
    expect(s.enabled).toBe(true);
    expect(s.nextRunAt).toBeGreaterThan(Date.now());
    const list = await fetch(`${base}/api/schedules`).then(j);
    expect(list.some((x: { id: string }) => x.id === s.id)).toBe(true);
    const ran = await post(`/api/schedules/${s.id}/run`, {}).then(j);
    expect(ran.scheduleId).toBe(s.id);
    await waitFor(async () => (await getTask(ran.id)).task.status === "waiting");
    const ask = (await getTask(ran.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await post(`/api/tasks/${ran.id}/permission`, { id: ask.id, decision: "allow" });
    await waitFor(async () => (await getTask(ran.id)).task.status === "done");
    const q = await fetch(`${base}/api/queue`).then(j);
    expect(q.scheduled.some((x: { taskId: string }) => x.taskId === ran.id)).toBe(true);
    const patched = await fetch(`${base}/api/schedules/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }).then(j);
    expect(patched.enabled).toBe(false);
    const del = await fetch(`${base}/api/schedules/${s.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/api/schedules/${s.id}`)).status).toBe(404);
  });

  test("backlogSweep (#561): backlog-next's slots default to 1 / 1, a PATCH of one keeps the other, 0〜3 only, kept in sqlite", async () => {
    const patch = (body: unknown) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await fetch(`${base}/api/settings`).then(j)).backlogSweep).toEqual({ implement: 1, plan: 1 });
    expect((await patch({ backlogSweep: { implement: 2 } }).then(j)).backlogSweep).toEqual({ implement: 2, plan: 1 });
    expect((await patch({ backlogSweep: { plan: 0 } })).status).toBe(200);
    expect((await fetch(`${base}/api/settings`).then(j)).backlogSweep).toEqual({ implement: 2, plan: 0 });
    for (const bad of [{ implement: 4 }, { plan: -1 }, { implement: 1.5 }, { implement: "2" }]) expect((await patch({ backlogSweep: bad })).status).toBe(400);
    expect((core.db.getSetting("settings", {}) as { backlogSweep: unknown }).backlogSweep).toEqual({ implement: 2, plan: 0 });
    await patch({ backlogSweep: { implement: 1, plan: 1 } });
  });

  test("footprint counts files and estimates tokens, skipping node_modules", async () => {
    const dir = join(home, "fp");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "x".repeat(400));
    writeFileSync(join(dir, "node_modules", "x", "big.js"), "y".repeat(100000));
    const fp = await measureFootprint([dir]);
    expect(fp.files).toBe(1);
    expect(fp.bytes).toBe(400);
    expect(fp.estTokens).toBe(100);
  });

  test("db ledger summary is empty on a fresh database", () => {
    const db = new Db(join(home, "fresh.db"));
    const s = db.ledgerSummary();
    expect(s.todayUsd).toBe(0);
    expect(s.topTasks).toEqual([]);
    db.close();
  });
});

async function getTask(id: string) {
  return fetch(`${base}/api/tasks/${id}`).then(j);
}

async function waitFor(pred: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

describe("automatic judgement (#493)", () => {
  // the real adapters echo the prompt as a user message first; the judge reads the task's first one as the request
  const ok: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result")];
  const post = (url: string, body?: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  type Call = { input: Parameters<typeof judgeTurn>[0]; opts: Parameters<typeof judgeTurn>[1]; answer: (r: "done" | "needs_action") => void; fail: (e: Error) => void };
  /** A judge the test answers by hand: each call waits until the test resolves it. */
  const handJudge = () => {
    const calls: Call[] = [];
    const judge: typeof judgeTurn = (input, opts) =>
      new Promise((resolve, reject) => {
        calls.push({ input, opts, fail: reject, answer: (result) => {
          opts.onUsage?.(opts.settings.runner, { t: "usage", source: "reported", model: opts.settings.model, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0012 });
          resolve({ result, reason: result === "done" ? "報告して終わっている" : "選択を求めている", runner: opts.settings.runner, model: opts.settings.model });
        } });
      });
    return { calls, judge };
  };
  const daemon = (h: string, judge: typeof judgeTurn) =>
    // codex is slow, so its follow-up turn is still running when a test answers the previous judgement
    startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { lingers: true }), fakeAdapter(ok, { id: "codex", lingers: true, slowMs: 300 })], { port: 0, selfdevChecks: false, judge });

  test("settings tunables (#835): the daemon gives both judges judgeAndChoice's fallback, and the two-way judge its timeout, read per turn", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-tunables-"));
    const { calls, judge } = handJudge();
    const rubricOpts: Array<Parameters<typeof judgeRubric>[1]> = [];
    const rubricJudge: typeof judgeRubric = (_input, opts) => (rubricOpts.push(opts), new Promise(() => undefined));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { lingers: true }), fakeAdapter(ok, { id: "codex", lingers: true })], { port: 0, selfdevChecks: false, judge, rubricJudge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const create = async (title: string) => (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "依頼文", runner: "claude" }).then(j)) as Task;
      await create("default");
      await waitFor(async () => calls.length === 1 && rubricOpts.length === 1);
      expect(calls[0]!.opts).toMatchObject({ fallback: { runner: JUDGE_FALLBACK.runner, model: JUDGE_FALLBACK.model }, timeoutMs: JUDGE_TIMEOUT_MS });
      expect(rubricOpts[0]).toMatchObject({ fallback: { runner: JUDGE_FALLBACK.runner, model: JUDGE_FALLBACK.model } });
      expect((await post(`${b}/api/settings`, { judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "m", judgeTimeoutMs: 5000 } }, "PATCH")).status).toBe(200);
      await create("changed");
      await waitFor(async () => calls.length === 2 && rubricOpts.length === 2);
      expect(calls[1]!.opts).toMatchObject({ fallback: { runner: "codex", model: "m" }, timeoutMs: 5000 });
      expect(rubricOpts[1]).toMatchObject({ fallback: { runner: "codex", model: "m" } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a done turn is judged in the background — the outcome, the reason and the ledger row; a hand-set outcome is kept next to the judgement; a failing judge leaves it unjudged", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updates: Task[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "task.updated") updates.push(msg.task);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const create = async (title: string, runner: RunnerId = "claude") => (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "依頼文", runner }).then(j)) as Task;
      const turnDone = async (id: string, n: number) => {
        await waitFor(async () => (await get(id)).status === "done");
        await waitFor(async () => calls.length === n);
      };

      // (a) done → the judge sees the title, the first request and the last reply; its answer reaches the outcome, GET and task.updated
      const a = await create("judged");
      await turnDone(a.id, 1);
      expect(calls[0]!.input).toEqual({ title: "judged", prompt: "依頼文", lastReply: "done" });
      expect(calls[0]!.opts).toMatchObject({ settings: { enabled: true, runner: "codex", model: "gpt-6-luna" }, cwd: join(h, "suggest") });
      calls[0]!.answer("needs_action");
      await waitFor(async () => updates.some((t) => t.id === a.id && t.outcome === "needs_action" && t.judgedResult === "needs_action"));
      expect(await get(a.id)).toMatchObject({ outcome: "needs_action", judgedResult: "needs_action", judgedReason: "選択を求めている", judgedBy: "codex:gpt-6-luna", status: "done" });

      // (e) the judge's usage is a ledger row of the task, under the runner that judged
      const raw = new Database(join(h, "switchboard.db"), { readonly: true });
      const rows = raw.query("SELECT runner, model, cost_usd FROM ledger WHERE task_id = ? AND runner = 'codex'").all(a.id);
      raw.close();
      expect(rows).toEqual([{ runner: "codex", model: "gpt-6-luna", cost_usd: 0.0012 }]);

      // a new turn clears the judgement of the previous reply
      const sent = await post(`${b}/api/tasks/${a.id}/send`, { text: "again" }).then(j);
      expect(sent).toMatchObject({ status: "running", outcome: "unknown", judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
      await turnDone(a.id, 2);
      calls[1]!.answer("done");
      await waitFor(async () => (await get(a.id)).judgedResult === "done");

      // (b) the judge throws → unjudged, and the task is still done
      const x = await create("fails");
      await turnDone(x.id, 3);
      calls[2]!.fail(new Error("both runners failed"));
      await Bun.sleep(50);
      expect(await get(x.id)).toMatchObject({ status: "done", outcome: "unknown", judgedResult: null });

      // (c) + (f) the person sets the outcome while the judge is still thinking → the judgement is kept, the outcome is theirs
      const m = await create("by hand");
      await turnDone(m.id, 4);
      expect((await post(`${b}/api/tasks/${m.id}/outcome`, { outcome: "done" })).status).toBe(200);
      calls[3]!.answer("needs_action");
      await waitFor(async () => (await get(m.id)).judgedResult === "needs_action");
      expect(await get(m.id)).toMatchObject({ outcome: "done", judgedResult: "needs_action", judgedBy: "codex:gpt-6-luna" });

      // a judgement that arrives after the next turn started is of an older reply and is dropped
      const s = await create("stale");
      await turnDone(s.id, 5);
      await post(`${b}/api/tasks/${s.id}/send`, { text: "more" });
      await turnDone(s.id, 6);
      calls[4]!.answer("needs_action");
      await Bun.sleep(50);
      expect(await get(s.id)).toMatchObject({ outcome: "unknown", judgedResult: null });
      calls[5]!.answer("done");
      await waitFor(async () => (await get(s.id)).judgedResult === "done");

      // … and so is one that arrives while the next turn is still running
      const r = await create("running", "codex");
      await turnDone(r.id, 7);
      await post(`${b}/api/tasks/${r.id}/send`, { text: "more" });
      expect((await get(r.id)).status).toBe("running");
      calls[6]!.answer("needs_action");
      await Bun.sleep(50);
      expect(await get(r.id)).toMatchObject({ status: "running", outcome: "unknown", judgedResult: null });
      await turnDone(r.id, 8);
      calls[7]!.answer("done");
      await waitFor(async () => (await get(r.id)).judgedResult === "done");
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: judge.enabled off → never asked; judge.runner changed → asked with that runner; an uninstalled runner is refused", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-settings-"));
    const { calls, judge } = handJudge();
    const c = await daemon(h, judge);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const run = async (title: string) => {
        const t = (await post(`${b}/api/tasks`, { cwd: h, title, prompt: "p", runner: "claude" }).then(j)) as Task;
        await waitFor(async () => (await get(t.id)).status === "done");
        await Bun.sleep(50);
        return t;
      };
      const off = await post(`${b}/api/settings`, { judge: { enabled: false } }, "PATCH").then(j);
      expect(off.judge).toEqual({ enabled: false, runner: "codex", model: "gpt-6-luna" });
      await run("off");
      expect(calls).toHaveLength(0);

      const on = await post(`${b}/api/settings`, { judge: { enabled: true, runner: "claude", model: "claude-haiku-4-5" } }, "PATCH").then(j);
      expect(on.judge).toEqual({ enabled: true, runner: "claude", model: "claude-haiku-4-5" });
      await run("on");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.opts.settings).toEqual({ enabled: true, runner: "claude", model: "claude-haiku-4-5" });

      const missing = await post(`${b}/api/settings`, { judge: { runner: "dak" } }, "PATCH");
      expect(missing.status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).judge.runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("judge: a shadow task, a turn that ends with a permission still pending (outcome needs_action), and an empty last reply are not judged", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-judge-skip-"));
    const { calls, judge } = handJudge();
    const silent: AgentEvent[] = [...ok.filter((e) => e.t !== "session.end"), { t: "session.end", status: "ok", summary: "  " }];
    // asks, then ends the turn without waiting for the answer: done, but the rule already made it needs_action
    const endsAsking: RunnerAdapter = {
      ...fakeAdapter([]),
      start(_opts, emit) {
        let exit!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (exit = r));
        queueMicrotask(() => {
          emit({ t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: {}, detail: "write" });
          emit({ t: "session.end", status: "ok", summary: "書いてよいですか" });
          exit(0);
        });
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => exit(0), close: async () => exit(0), exited };
      },
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [endsAsking, fakeAdapter(ok, { id: "codex", lingers: true }), fakeAdapter(silent, { id: "dak" })], { port: 0, selfdevChecks: false, judge });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const asks = (await post(`${b}/api/tasks`, { cwd: h, title: "asks", prompt: "p", runner: "claude" }).then(j)) as Task;
      await waitFor(async () => (await get(asks.id)).status === "done");
      expect((await get(asks.id)).outcome).toBe("needs_action");
      const quiet = (await post(`${b}/api/tasks`, { cwd: h, title: "quiet", prompt: "p", runner: "dak" }).then(j)) as Task;
      await waitFor(async () => (await get(quiet.id)).status === "done");
      // the shadow (codex) ends with a reply that would be judged; only the primary (dak, empty reply) counts, and it does not qualify
      const primary = (await post(`${b}/api/tasks`, { cwd: h, title: "mirrored", prompt: "p", runner: "dak", shadowRunner: "codex" }).then(j)) as Task;
      await waitFor(async () => (await get(primary.id)).status === "done");
      const shadow = c.db.shadowTaskOf(primary.id)!;
      await waitFor(async () => (await get(shadow.id)).status === "done");
      const control = (await post(`${b}/api/tasks`, { cwd: h, title: "control", prompt: "p", runner: "codex" }).then(j)) as Task;
      await waitFor(async () => (await get(control.id)).status === "done");
      await Bun.sleep(100);
      expect(calls.map((x) => x.input.title)).toEqual(["control"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("shadow run (#99): the same prompt on a second runner, as a task linked by shadowOf", () => {
  const post = (b: string, path: string, body?: unknown, method = "POST") => fetch(`${b}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const turn = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result" && e.t !== "quota");
  const dakTurn: AgentEvent[] = [{ t: "session.start", runner: "dak", runnerSessionId: "dak-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "done (dak)" }, { t: "session.end", status: "ok", summary: "done" }];

  test("creation copies cwd / scope / title / prompt, follow-ups to the primary are mirrored, the shadow's own turns are not; the saved default and its escape hatch", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow-"));
    const starts: StartOptions[] = [];
    const sends: string[] = [];
    const dakStarts: StartOptions[] = [];
    const dakSends: string[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn, { lingers: true, starts, sends, modes: ["auto", "plan"], defaultMode: "auto", efforts: ["high"] }), { ...fakeAdapter(dakTurn, { id: "dak", lingers: true, starts: dakStarts, sends: dakSends }), permissionModes: [] }], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak", budgetUsd: 1, effort: "high" }).then(j);
      expect(t).toMatchObject({ runner: "claude", shadowOf: null, shadowStopped: false, budgetUsd: 1, permissionMode: "auto", effort: "high" });
      const all = (await fetch(`${b}/api/tasks`).then(j)) as Task[];
      expect(all.length).toBe(2);
      const s = all.find((x) => x.shadowOf === t.id)!;
      // a normal task on the other runner, carrying the primary's request and budget but none of its bookkeeping
      expect(s).toMatchObject({ runner: "dak", title: "t", cwd: h, scope: [h], workspaceId: t.workspaceId, routing: null, budgetUsd: 1, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", shadowStopped: false });
      // the primary's transcript says the shadow started and with which mode (modes are runner-native, not inherited)
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走（dak）を開始") && e.ev.text.includes("主の auto は引き継がれない"))).toBe(true);
      expect(starts[0]).toMatchObject({ prompt: "p", cwd: h, permissionMode: "auto" });
      expect(dakStarts[0]).toMatchObject({ prompt: "p", cwd: h, scope: [h] });
      expect(dakStarts[0]!.effort).toBeUndefined(); // the primary's effort is claude's; the shadow keeps its CLI default (#833)
      expect(c.db.routingLog().map((r) => r.taskId)).not.toContain(s.id);
      expect(c.db.shadowTaskOf(t.id)?.id).toBe(s.id);
      // the router's "previous runner for this repo" is the primary's, not the shadow's (the shadow was created last)
      expect(c.db.lastRunnerFor(undefined, h)).toBe("claude");
      expect(await post(b, "/api/tasks/suggest", { cwd: h, title: "", prompt: "" }).then(j)).toMatchObject({ runner: "claude", ruleId: "previous" });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      // a follow-up to the primary reaches both live processes with the same text
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "again" })).status).toBe(200);
      await waitFor(async () => dakSends.includes("again"));
      expect(sends).toEqual(["again"]);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "message.delta" && e.ev.role === "user" && e.ev.text === "again")).toBe(true);
      // a turn sent to the shadow stays there
      expect((await post(b, `/api/tasks/${s.id}/send`, { text: "only here" })).status).toBe(200);
      await waitFor(async () => dakSends.includes("only here"));
      expect(sends).toEqual(["again"]);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      // stopping the shadow (even one whose turn is over, which stays "done") means: no more copies — and both sides say so
      const stopped = await post(b, `/api/tasks/${s.id}/abort`).then(j);
      expect(stopped).toMatchObject({ status: "done", shadowStopped: true });
      await waitFor(async () => !c.tasks.isLive(s.id));
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走を停止"))).toBe(true);
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("並走（dak）を停止"))).toBe(true);
      await post(b, `/api/tasks/${t.id}/send`, { text: "after stop" });
      await waitFor(async () => sends.includes("after stop"));
      await new Promise((r) => setTimeout(r, 30));
      expect(dakSends).toEqual(["again", "only here"]);
      expect((await fetch(`${b}/api/tasks`).then(j)).length).toBe(2);
      // validation: the shadow must be another, detected runner
      expect((await post(b, "/api/tasks", { cwd: h, title: "x", prompt: "p", runner: "claude", shadowRunner: "claude" })).status).toBe(400);
      expect((await post(b, "/api/tasks", { cwd: h, title: "x", prompt: "p", runner: "claude", shadowRunner: "codex" })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks`).then(j)).length).toBe(2);
      // the saved default: refused for an undetected runner, otherwise applied to creations that do not say
      expect((await post(b, "/api/settings", { shadowRunner: "codex" }, "PATCH")).status).toBe(400);
      expect((await post(b, "/api/settings", { shadowRunner: "dak" }, "PATCH").then(j)).shadowRunner).toBe("dak");
      expect((await fetch(`${b}/api/settings`).then(j)).shadowRunner).toBe("dak");
      const t2 = await post(b, "/api/tasks", { cwd: h, title: "t2", prompt: "q", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t2.id)).toMatchObject({ runner: "dak", title: "t2" });
      expect(dakStarts.at(-1)?.prompt).toBe("q");
      const s2 = c.db.shadowTaskOf(t2.id)!;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t2.id}`).then(j)).task.status === "done");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s2.id}`).then(j)).task.status === "done");
      // mirror: false (the resumer's 今すぐ再開) reaches the primary only
      const dakSendsBefore = dakSends.length;
      await c.tasks.send(t2.id, "resume now", { mirror: false });
      await waitFor(async () => sends.includes("resume now"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t2.id}`).then(j)).task.status === "done");
      expect(dakSends.length).toBe(dakSendsBefore);
      // stopping the primary cancels a resume the shadow had planned (#102), and nothing else about it
      c.db.updateTask(s2.id, { resumeAt: Date.now() + 60_000 });
      await post(b, `/api/tasks/${t2.id}/abort`);
      expect(c.db.getTask(s2.id)).toMatchObject({ resumeAt: null, resumeReason: null, shadowStopped: false, status: "done" });
      expect(c.db.listEvents(s2.id).some((e) => e.ev.t === "status" && e.ev.text.includes("自動再開を取り消しました"))).toBe(true);
      // a schedule never shadows, default or not (unattended: nobody answers the shadow's asks; the run guard knows only the primary)
      const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
      const sched = await post(b, "/api/schedules", { title: "nightly", cron: "@nightly", workspaceId: meta.id, runner: "claude", prompt: "night" }).then(j);
      const ran = await post(b, `/api/schedules/${sched.id}/run`).then(j);
      expect(ran.scheduleId).toBe(sched.id);
      expect(c.db.shadowTaskOf(ran.id)).toBeNull();
      expect(starts.at(-1)?.prompt).toBe("night");
      // an explicit null opts out of the default
      const t3 = await post(b, "/api/tasks", { cwd: h, title: "t3", prompt: "q", runner: "claude", shadowRunner: null }).then(j);
      expect(c.db.shadowTaskOf(t3.id)).toBeNull();
      // a task on the default runner itself gets no shadow, and says so
      const t4 = await post(b, "/api/tasks", { cwd: h, title: "t4", prompt: "r", runner: "dak" }).then(j);
      expect(c.db.shadowTaskOf(t4.id)).toBeNull();
      expect(c.db.listEvents(t4.id).some((e) => e.ev.t === "status" && e.ev.text.includes("主ランナーと同じ"))).toBe(true);
      // a saved default whose runner is gone (stale row) skips the shadow with a note rather than failing the task
      c.db.setSetting("settings", { defaultPermissionMode: {}, shadowRunner: "codex" });
      const t5 = await post(b, "/api/tasks", { cwd: h, title: "t5", prompt: "r", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t5.id)).toBeNull();
      expect(c.db.listEvents(t5.id).some((e) => e.ev.t === "status" && e.ev.text.includes("未検出"))).toBe(true);
      expect((await post(b, "/api/settings", { shadowRunner: null }, "PATCH").then(j)).shadowRunner).toBeNull();
      const t6 = await post(b, "/api/tasks", { cwd: h, title: "t6", prompt: "r", runner: "claude" }).then(j);
      expect(c.db.shadowTaskOf(t6.id)).toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a shadow waiting on an approval gets no copy (noted on both); a shadow turn that ends in error is noted on the primary", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow3-"));
    const dakAsk: AgentEvent[] = [
      { t: "session.start", runner: "dak", runnerSessionId: "dak-1", cwd: "/tmp" },
      { t: "tool.call", id: "d1", name: "exec.run", input: { cmd: "make" }, summary: "make" },
      { t: "permission.ask", id: "dperm", kind: "exec", tool: "exec.run", input: { cmd: "make" }, detail: "make" },
      { t: "tool.result", id: "d1", ok: true, summary: "ok" },
      { t: "session.end", status: "ok", summary: "done" },
    ];
    const sends: string[] = [];
    const dakSends: string[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn, { lingers: true, sends }), { ...fakeAdapter(dakAsk, { id: "dak", lingers: true, sends: dakSends }), permissionModes: [] }], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" }).then(j);
      const s = c.db.shadowTaskOf(t.id)!;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "waiting");
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "while waiting" })).status).toBe(200);
      await waitFor(async () => sends.includes("while waiting"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(dakSends).toEqual([]);
      expect((await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status).toBe("waiting"); // the ask is still open, not denied
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("承認待ちのため返信を写しませんでした"))).toBe(true);
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.includes("承認待ちです"))).toBe(true);
      // answering lets the shadow finish; later copies flow again
      await post(b, `/api/tasks/${s.id}/permission`, { id: "dperm", decision: "allow" });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${s.id}`).then(j)).task.status === "done");
      await post(b, `/api/tasks/${t.id}/send`, { text: "after answer" });
      await waitFor(async () => dakSends.includes("after answer"));
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
    // a shadow whose turn ends in error: the primary says so
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-shadow4-"));
    const dakFail: AgentEvent[] = [{ t: "session.start", runner: "dak", runnerSessionId: "dak-2", cwd: "/tmp" }, { t: "error", message: "session dak-2 not found (HTTP 404)" }, { t: "session.end", status: "error", summary: "session dak-2 not found (HTTP 404)" }];
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn), { ...fakeAdapter(dakFail, { id: "dak" }), permissionModes: [] }], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      const t = await post(b2, "/api/tasks", { cwd: h2, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" }).then(j);
      const s = c2.db.shadowTaskOf(t.id)!;
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${s.id}`).then(j)).task.status === "error");
      await waitFor(async () => c2.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("ターンがエラーで終わりました") && e.ev.text.includes("HTTP 404")));
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("a shadow runner that will not start leaves the primary running and notes the failure on both", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-shadow2-"));
    const broken: RunnerAdapter = { ...fakeAdapter(dakTurn, { id: "dak" }), permissionModes: [], start: () => { throw new Error("boom"); } };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(turn), broken], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const r = await post(b, "/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", shadowRunner: "dak" });
      expect(r.status).toBe(201);
      const t = (await r.json()) as Task;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const s = c.db.shadowTaskOf(t.id)!;
      expect(s).toMatchObject({ runner: "dak", status: "error" });
      expect(c.tasks.isLive(s.id)).toBe(false);
      expect(c.db.listEvents(s.id).some((e) => e.ev.t === "error" && e.ev.message === "boom")).toBe(true);
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("起動できませんでした") && e.ev.text.includes("boom"))).toBe(true);
      // the primary still takes follow-ups; the copy to the broken shadow fails quietly, noted on both transcripts
      expect((await post(b, `/api/tasks/${t.id}/send`, { text: "again" })).status).toBe(200);
      await waitFor(async () => c.db.listEvents(s.id).some((e) => e.ev.t === "status" && e.ev.text.includes("並走の返信を送れませんでした")));
      expect(c.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.includes("並走（dak）に返信を写せませんでした") && e.ev.text.includes("boom"))).toBe(true);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // the same runner as the primary: the task is created, says why it never ran, and the route reports it
      const r2 = await post(b, "/api/tasks", { cwd: h, title: "direct", prompt: "p", runner: "dak", shadowRunner: null });
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { error: string }).error).toContain("boom");
      const failed = c.db.listTasks().find((x) => x.title === "direct")!;
      expect(failed.status).toBe("error");
      expect(c.db.listEvents(failed.id).some((e) => e.ev.t === "error" && e.ev.message === "boom")).toBe(true);
      expect(c.tasks.isLive(failed.id)).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("history import (#91): Claude Code sessions run in a terminal, from ~/.claude/projects", () => {
  const FIXTURE = recordingText("packages/adapters/claude/fixtures/terminal-session.jsonl");
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);
  const cliUser = (cwd: string, sessionId: string, text: string, ts: string) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid: crypto.randomUUID(), timestamp: ts, permissionMode: "auto", effort: null, origin: { kind: "human" }, promptSource: "typed", userType: "external", entrypoint: "cli", cwd, sessionId, version: "2.1.263", gitBranch: "main" });
  const cliAssistant = (cwd: string, sessionId: string, id: string, text: string, ts: string) =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }, uuid: crypto.randomUUID(), timestamp: ts, userType: "external", entrypoint: "cli", cwd, sessionId, version: "2.1.263", gitBranch: "main" });
  /** A workspace directory and the Claude projects folder Claude Code would use for it. */
  const setup = (tag: string) => {
    const h = mkdtempSync(join(tmpdir(), `switchboard-${tag}-`));
    const repo = join(h, "repo");
    mkdirSync(repo);
    const projects = join(h, "projects");
    const pdir = join(projects, claudeProjectDirName(repo));
    mkdirSync(pdir, { recursive: true });
    return { h, repo, projects, pdir };
  };
  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl"))("history Teleport links exact normal log, reuses owner, rejects mismatches and resumes Local after exit", async () => {
    assertRecordings("packages/adapters/claude/fixtures/teleport-session.jsonl");
    const { h, repo, projects, pdir } = setup("teleport-history");
    for (const a of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", ...a], { cwd: repo });
    const starts: StartOptions[] = [];
    const cloudId = "session_0123456789abcdefghijklmn";
    const bin = join(h, "fake-teleport"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume"\n', { mode: 0o755 });
    const cloudAdapter = fakeAdapter([{ t: "cloud.session.created", id: cloudId, url: `https://claude.ai/code/${cloudId}` }], { starts, detect: () => ({ path: bin }) });
    const localStarts: StartOptions[] = [];
    const localAdapter = fakeAdapter([{ t: "session.end", status: "ok" }], { starts: localStarts });
    const adapter = { ...cloudAdapter, start: (o: StartOptions, emit: Parameters<RunnerAdapter["start"]>[1]) => o.executionMode === "cloud" ? cloudAdapter.start(o, emit) : localAdapter.start(o, emit) };
    let data!: (s: string) => void, exit!: (e: { exitCode: number }) => void, spawns = 0;
    const fakePty = { pid: 99999999, onData: (f: typeof data) => { data = f; }, onExit: (f: typeof exit) => { exit = f; }, write: () => {}, resize: () => {}, kill: () => {} };
    const { PtyManager } = await import("./pty.ts");
    const pty = (await PtyManager.load(async () => ({ spawn: (() => { spawns++; return fakePty; }) as any })))!; spawns = 0;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter], { port: 0, loadPty: async () => pty });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const ws = c.db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
      // Register through an alias, as on macOS /var → /private/var.
      const alias = join(h, "alias"); symlinkSync(repo, alias);
      const cloud = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: alias, title: "Cloud", prompt: "Cloud", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(cloud.id));
      const file = join(pdir, `${SESSION}.jsonl`);
      const fixture = recordingText("packages/adapters/claude/fixtures/teleport-session.jsonl").replaceAll("/work/repo", realpathSync(repo));
      writeFileSync(file, fixture);
      c.history.scan(); // normal importer wins the race; the same owner must be reused
      const owner = c.db.listTasksBySession("claude", SESSION)[0]!;
      const before = c.db.listEvents(owner.id).length, tokens = c.db.taskCost(owner.id).tokens;
      const local = await c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(local.id).toBe(owner.id); expect(local.sourceCloudTaskId).toBe(cloud.id);
      c.history.scan(); await c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(c.db.listTasksBySession("claude", SESSION)).toHaveLength(1);
      expect(c.db.listEvents(local.id).length).toBe(before + 1); // normal exit flushes exactly one pending end
      const after = c.db.listEvents(local.id).length;
      expect(c.db.taskCost(local.id).tokens).toBe(tokens);
      const again = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 }); again.scan(); await again.importTeleportedSession(cloud.id, SESSION, cloud.cwd);
      expect(c.db.listEvents(local.id)).toHaveLength(after);
      const detail = await fetch(`${b}/api/tasks/${cloud.id}`).then(j);
      expect(detail.localContinuations.map((t: Task) => t.id)).toEqual([local.id]);
      expect((await fetch(`${b}/api/tasks/${local.id}`).then(j)).sourceCloudTask.cloudSession.id).toBe(cloudId);
      const freshId = "33333333-3333-4333-8333-333333333333";
      writeFileSync(join(pdir, `${freshId}.jsonl`), fixture.replaceAll(SESSION, freshId));
      const fresh = await c.history.importTeleportedSession(cloud.id, freshId, cloud.cwd);
      expect(fresh.sourceCloudTaskId).toBe(cloud.id); expect(fresh.runnerSessionId).toBe(freshId);
      expect(c.db.listEvents(fresh.id).filter(e => e.ev.t === "message.delta").map(e => e.ev)).toEqual(c.db.listEvents(local.id).filter(e => e.ev.t === "message.delta").map(e => e.ev));
      const other = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: repo, title: "other", prompt: "other", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(other.id));
      await expect(c.history.importTeleportedSession(other.id, SESSION, other.cwd)).rejects.toThrow("所有者");
      await expect(c.history.importTeleportedSession(cloud.id, "../wrong", cloud.cwd)).rejects.toThrow();
      writeFileSync(file, fixture.replaceAll(SESSION, "22222222-2222-4222-8222-222222222222"));
      await expect(c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd)).rejects.toThrow("セッションID");
      writeFileSync(file, fixture.replaceAll(realpathSync(repo), "/other/repo"));
      await expect(c.history.importTeleportedSession(cloud.id, SESSION, cloud.cwd)).rejects.toThrow("cwd/Workspace"); writeFileSync(file, fixture);
      // A continuation in a worktree under the same Workspace: the log's cwd is the worktree, and the caller names it.
      const wt = teleportWorktreePath(realpathSync(repo), cloud.id); Bun.spawnSync(["git", "worktree", "add", "--detach", wt, "HEAD"], { cwd: repo });
      const wtId = "55555555-5555-4555-8555-555555555555";
      writeFileSync(join(pdir, `${wtId}.jsonl`), fixture.replaceAll(SESSION, wtId).replaceAll(realpathSync(repo), realpathSync(wt)));
      await expect(c.history.importTeleportedSession(cloud.id, wtId, cloud.cwd)).rejects.toThrow("cwd/Workspace");
      await expect(c.history.importTeleportedSession(cloud.id, wtId, "/other/repo")).rejects.toThrow("cwd/Workspace");
      const inWt = await c.history.importTeleportedSession(cloud.id, wtId, wt);
      expect(realpathSync(inWt.cwd)).toBe(realpathSync(wt)); expect(inWt.workspaceId).toBe(ws.id); expect(inWt.sourceCloudTaskId).toBe(cloud.id);
      const post = () => fetch(`${b}/api/tasks/${cloud.id}/teleport`, { method: "POST" });
      const progress = async () => (await fetch(`${b}/api/tasks/${cloud.id}`).then(j)).teleport as { phase: string; message?: string; localTaskId?: string } | null;
      // The screen's socket: what task.teleport tells it, in order.
      const phases: string[] = [];
      const feed = new WebSocket(`ws://127.0.0.1:${c.server.port}/ws`);
      feed.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === "task.teleport" && m.taskId === cloud.id) phases.push(m.progress.phase); };
      await new Promise<void>((res, rej) => { feed.onopen = () => res(); feed.onerror = () => rej(new Error("socket")); });
      expect(await progress()).toBeNull();
      const actualId = "44444444-4444-4444-8444-444444444444";
      writeFileSync(join(pdir, `${actualId}.jsonl`), fixture.replaceAll(SESSION, actualId).replaceAll(realpathSync(repo), realpathSync(wt))); // the continuation runs in the worktree
      expect((await post()).status).toBe(202); // no terminal socket is opened
      await waitFor(async () => spawns === 1);
      expect((await post()).status).toBe(409); expect(spawns).toBe(1);
      const blocked = await fetch(`${b}/api/tasks/${inWt.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "next" }) }); // a Task in the continuation worktree is held; one in the clone is not
      expect(blocked.status).toBe(409); expect((await blocked.json() as any).error).toContain("Teleport"); expect(localStarts).toHaveLength(0);
      data(`${cloudId}\nSession resumed\n`); // quiet after resumed: the daemon ends the CLI itself
      await waitFor(async () => (await progress())?.phase === "exiting");
      data(`claude --resume ${actualId}\n`); exit({ exitCode: 0 });
      await waitFor(async () => c.db.listLocalTasksForCloud(cloud.id).some(t => t.runnerSessionId === actualId));
      const actual = c.db.listTasksBySession("claude", actualId)[0]!;
      await waitFor(async () => (await progress())?.phase === "done");
      expect(await progress()).toMatchObject({ phase: "done", localTaskId: actual.id });
      expect(phases).toEqual(["teleporting", "exiting", "importing", "done"]);
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("Local Taskへの取込みを確認") });
      await c.tasks.send(actual.id, "next"); expect(localStarts[0]).toMatchObject({ resumeSessionId: actualId }); expect(localStarts[0]!.executionMode).not.toBe("cloud");
      await waitFor(async () => !c.tasks.isLive(actual.id));
      expect((await post()).status).toBe(202); await waitFor(async () => spawns === 2);
      const links = c.db.listLocalTasksForCloud(cloud.id).length;
      data("Cancelled\n"); exit({ exitCode: 1 });
      expect(c.db.listLocalTasksForCloud(cloud.id)).toHaveLength(links);
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("取り消されました") });
      await waitFor(async () => (await progress())?.phase === "unconfirmed");
      await c.tasks.send(actual.id, "after cancel"); expect(localStarts).toHaveLength(2);
      await waitFor(async () => !c.tasks.isLive(actual.id));
      expect((await post()).status).toBe(202); await waitFor(async () => spawns === 3);
      data(`${cloudId}\nSession resumed\nclaude --resume 77777777-7777-4777-8777-777777777777\n`); exit({ exitCode: 0 });
      await waitFor(async () => (await progress())?.message?.includes("Local履歴は未確認") === true);
      expect(await progress()).toMatchObject({ phase: "unconfirmed" });
      expect(c.db.listEvents(cloud.id).at(-1)!.ev).toMatchObject({ t: "status", text: expect.stringContaining("Local履歴は未確認") });
      expect(c.db.listLocalTasksForCloud(cloud.id)).toHaveLength(links);
      await c.tasks.send(actual.id, "after missing log"); expect(localStarts).toHaveLength(3);
      expect(c.db.getTask(cloud.id)).toMatchObject({ cloudSession: { id: cloudId }, runnerSessionId: null, executionMode: "cloud" });

    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("history Teleport large logs yield and refuse mutation during validation", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("teleport-large");
    const cloudId = "session_0123456789abcdefghijklmn";
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [fakeAdapter([{ t: "cloud.session.created", id: cloudId, url: `https://claude.ai/code/${cloudId}` }])], { port: 0 });
    try {
      const ws = c.db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
      const cloud = c.tasks.create({ runner: "claude", workspaceId: ws.id, cwd: repo, title: "Cloud", prompt: "Cloud", executionMode: "cloud" });
      await waitFor(async () => !c.tasks.isLive(cloud.id));
      const id = "88888888-8888-4888-8888-888888888888", changedId = "99999999-9999-4999-8999-999999999999";
      const padding = JSON.stringify({ type: "file-history-snapshot", sessionId: id, pad: "x".repeat(1024 * 1024) }) + "\n";
      const contents = FIXTURE.replaceAll("/work/repo", realpathSync(repo)).replaceAll(SESSION, id) + padding.repeat(18);
      const file = join(pdir, `${id}.jsonl`); writeFileSync(file, contents);
      let yielded = false; setTimeout(() => { yielded = true; }, 0);
      const local = await c.history.importTeleportedSession(cloud.id, id, cloud.cwd);
      expect(yielded).toBe(true); expect(local.sourceCloudTaskId).toBe(cloud.id);
      expect(c.history.forTask(local.id)!.offset).toBe(Bun.file(file).size);
      const changed = join(pdir, `${changedId}.jsonl`); writeFileSync(changed, contents.replaceAll(id, changedId));
      setTimeout(() => appendFileSync(changed, JSON.stringify({ type: "file-history-snapshot", sessionId: changedId }) + "\n"), 0);
      await expect(c.history.importTeleportedSession(cloud.id, changedId, cloud.cwd)).rejects.toThrow("変更");
      expect(c.db.listLocalTasksForCloud(cloud.id).map(t => t.id)).toEqual([local.id]);
    } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
  });

  /** Make the file look untouched for a minute: a trailing end_turn is only taken as the end of the turn once the file is quiet. */
  const age = (file: string) => {
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
  };
  const daemon = (h: string, projects: string, adapter = fakeAdapter(SCRIPT)) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter], { port: 0, selfdevChecks: false });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("a terminal session under a workspace becomes a done task (origin terminal) with the log's own timestamps and priced ledger rows; passes are incremental and idempotent", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist");
    const text = FIXTURE.replaceAll("/work/repo", repo);
    const file = join(pdir, `${SESSION}.jsonl`);
    writeFileSync(file, text);
    age(file);
    const c = await daemon(h, projects);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the repo is not a workspace yet: seen, not imported
      expect(c.history.scan()).toMatchObject({ files: 1, created: 0, appended: 0, skippedForeign: 1, skippedOtherHost: 0, errors: [] });
      expect(await fetch(`${b}/api/tasks`).then(j)).toEqual([]);
      const ws = await post(`${b}/api/workspaces`, { path: repo });
      const r = await post(`${b}/api/history/import`);
      expect(r).toMatchObject({ files: 1, created: 1, appended: 0, skippedForeign: 0, errors: [] });
      const tasks = await fetch(`${b}/api/tasks`).then(j);
      expect(tasks).toHaveLength(1);
      const t = tasks[0];
      expect(t).toMatchObject({ origin: "terminal", runner: "claude", status: "done", runnerSessionId: SESSION, title: "リポジトリ構成の説明", model: "claude-fable-5-1", permissionMode: "acceptEdits", workspaceId: ws.id, cwd: repo, scope: [repo], routing: null, budgetUsd: null });
      expect(t.createdAt).toBe(Date.parse("2026-09-06T12:52:26.186Z")); // first record of the log, not the import time
      expect(t.updatedAt).toBe(Date.parse("2026-09-06T13:10:05.000Z"));
      expect(t.statusAt).toBe(t.updatedAt); // imported as done: done since the log's last record, not since it began (#2029)
      expect(t).toMatchObject({ outcome: "unknown", reviewedAt: t.updatedAt }); // watched in the terminal: reviewed (#492)
      const d = await fetch(`${b}/api/tasks/${t.id}`).then(j);
      expect(d.events).toHaveLength(22);
      expect(d.events[0].ev.t).toBe("session.start");
      expect(d.events[0].ts).toBe(Date.parse("2026-09-06T12:52:26.200Z"));
      expect(d.events.at(-1).ev).toMatchObject({ t: "session.end", status: "ok" }); // the file was quiet: the trailing end_turn closed the turn
      expect(d.history).toMatchObject({ sessionId: SESSION, taskId: t.id, origin: "terminal", path: file, offset: Buffer.byteLength(text) });
      // usage per assistant message → priced from pricing.json; Claude is a subscription runner → billed 0
      expect(d.cost.costUsd).toBeGreaterThan(0);
      const rows = c.db.sqlite.query("SELECT source, billed_usd AS billed, model FROM ledger WHERE task_id = ? ORDER BY ts").all(t.id) as Array<{ source: string; billed: number; model: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.every((x) => x.source === "priced" && x.billed === 0 && x.model === "claude-fable-5-1")).toBe(true);
      expect(c.db.ledgerTasks(36500)[0]).toMatchObject({ taskId: t.id, origin: "terminal", runner: "claude" });
      // nothing new → nothing happens
      expect(c.history.scan()).toMatchObject({ files: 1, created: 0, appended: 0 });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(22);
      // the terminal keeps going: a typed prompt and an end_turn answer land in the file
      appendFileSync(file, `${cliUser(repo, SESSION, "続きを", "2026-09-06T13:20:00.000Z")}\n${cliAssistant(repo, SESSION, "msg_F", "はい", "2026-09-06T13:20:05.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1 });
      let ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events;
      expect(ev).toHaveLength(25); // user, assistant, usage — the end waits until the file is quiet (more blocks may follow)
      expect(ev.at(-3).ev).toMatchObject({ t: "message.delta", role: "user", text: "続きを" });
      expect(ev.at(-3).ts).toBe(Date.parse("2026-09-06T13:20:00.000Z"));
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.updatedAt).toBe(Date.parse("2026-09-06T13:20:05.000Z"));
      age(file);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1 });
      ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events;
      expect(ev).toHaveLength(26);
      expect(ev.at(-1).ev).toMatchObject({ t: "session.end", status: "ok" });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.reviewedAt).toBe(t.reviewedAt); // a continued terminal turn stays reviewed
      expect(c.history.scan()).toMatchObject({ appended: 0 }); // …and only once
      const st = await fetch(`${b}/api/history`).then(j);
      expect(st).toMatchObject({ dir: projects, enabled: true, pollMs: 0 });
      expect(st.sessions).toHaveLength(1);
      expect(st.sessions[0]).toMatchObject({ sessionId: SESSION, taskId: t.id, origin: "terminal" });
      expect(st.lastScanAt).toBeGreaterThan(0);
      expect(st.lastResult.files).toBe(1);
      expect(st.sessions[0].pathDisplay).toBe(file.startsWith(homedir()) ? `~${file.slice(homedir().length)}` : file);
      // a daemon restart: a second importer on the same database re-reads nothing (offset + parser state persisted)
      const again = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 });
      expect(again.scan()).toMatchObject({ files: 1, created: 0, appended: 0, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(26);
      // …in the middle of a message: the thinking record of an end_turn message lands, the daemon restarts (a fresh
      // importer restores offset + parser state), then the text record lands → one usage, one end, in order
      const half = (block: unknown) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { model: "claude-fable-5-1", id: "msg_G", type: "message", role: "assistant", content: [block], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }, uuid: crypto.randomUUID(), timestamp: "2026-09-06T13:25:00.000Z", userType: "external", entrypoint: "cli", cwd: repo, sessionId: SESSION, version: "2.1.263", gitBranch: "main" });
      appendFileSync(file, `${half({ type: "thinking", thinking: "" })}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1 }); // usage only; the end waits (file not quiet)
      appendFileSync(file, `${half({ type: "text", text: "split" })}\n`);
      const third = new HistoryImporter(c.db, { projectsDir: projects, pollMs: 0 });
      expect(third.scan()).toMatchObject({ appended: 1, errors: [] });
      age(file);
      expect(third.scan()).toMatchObject({ appended: 1, errors: [] });
      const evG = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.slice(26).map((e: { ev: AgentEvent }) => e.ev);
      expect(evG.map((e: AgentEvent) => e.t)).toEqual(["usage", "message.delta", "session.end"]); // not usage twice, not end twice
      // a state this build cannot read: reported, the file goes on from its offset (no second session.start), the row is rewritten readable
      c.db.upsertHistoryImport({ ...c.db.getHistoryImport(SESSION)!, state: "{corrupt" });
      appendFileSync(file, `${cliUser(repo, SESSION, "after corrupt state", "2026-09-06T13:26:00.000Z")}\n`);
      const corrupt = c.history.scan();
      expect(corrupt.errors[0]).toMatch(/unreadable/);
      expect(corrupt.appended).toBe(1);
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.slice(29).map((e: { ev: AgentEvent }) => e.ev.t)).toEqual(["message.delta"]);
      expect(c.history.scan()).toMatchObject({ appended: 0, errors: [] });
      // a partial last line (still being written) waits; the newline completes it
      appendFileSync(file, cliUser(repo, SESSION, "途中", "2026-09-06T13:30:00.000Z").slice(0, 40));
      expect(c.history.scan()).toMatchObject({ appended: 0, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(30);
      const size = Buffer.byteLength(readFileSync(file, "utf8"));
      truncateSync(file, size - 40);
      appendFileSync(file, `${cliUser(repo, SESSION, "途中", "2026-09-06T13:30:00.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(31);
      // a file that shrank is reported and continued from its new end, never re-read (that would duplicate events)
      truncateSync(file, 100);
      const shrunk = c.history.scan();
      expect(shrunk.errors[0]).toMatch(/shrank/);
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events).toHaveLength(31);
      appendFileSync(file, `\n${cliUser(repo, SESSION, "また", "2026-09-06T13:40:00.000Z")}\n`);
      expect(c.history.scan()).toMatchObject({ appended: 1, errors: [] });
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.at(-1).ev).toMatchObject({ t: "message.delta", text: "また" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("no task for a session written only by an SDK host, for a cwd outside every workspace, or for a task whose process is live; a Switchboard task gets its later terminal turns appended", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist2");
    const script: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-live", cwd: repo }, { t: "message.delta", role: "assistant", text: "hi" }, { t: "session.end", status: "ok" }];
    const c = await daemon(h, projects, fakeAdapter(script, { lingers: true }));
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await post(`${b}/api/workspaces`, { path: repo });
      await new Promise((r) => setTimeout(r, 20)); // let the boot pass (next tick) run over the still-empty folder first
      // (a) only sdk-cli records (+ the title): another host's session, or ours before its task recorded the session id
      const sdkOnly = FIXTURE.split("\n").filter((l) => l && (JSON.parse(l).entrypoint === "sdk-cli" || JSON.parse(l).type === "ai-title")).join("\n") + "\n";
      writeFileSync(join(pdir, "22222222-2222-4222-8222-222222222222.jsonl"), sdkOnly.replaceAll("/work/repo", repo).replaceAll(SESSION, "22222222-2222-4222-8222-222222222222"));
      // (b) a terminal session in a directory that is no workspace
      const other = join(h, "elsewhere");
      mkdirSync(other);
      mkdirSync(join(projects, claudeProjectDirName(other)), { recursive: true });
      writeFileSync(join(projects, claudeProjectDirName(other), "44444444-4444-4444-8444-444444444444.jsonl"), FIXTURE.replaceAll("/work/repo", other).replaceAll(SESSION, "44444444-4444-4444-8444-444444444444"));
      // (c) a task Switchboard ran (origin switchboard) whose session the person later continued in a terminal
      const mine = c.db.insertTask({ id: "task_mine", workspaceId: null, title: "mine", runner: "claude", cwd: repo, scope: [repo], status: "done", runnerSessionId: "33333333-3333-4333-8333-333333333333", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
      const fileC = join(pdir, "33333333-3333-4333-8333-333333333333.jsonl");
      writeFileSync(fileC, FIXTURE.replaceAll("/work/repo", repo).replaceAll(SESSION, "33333333-3333-4333-8333-333333333333"));
      age(fileC);
      // (d) a task whose runner process is alive right now (lingering after its turn): its file is not touched
      const live = await post(`${b}/api/tasks`, { cwd: repo, title: "live", prompt: "p", runner: "claude" });
      for (let i = 0; i < 50 && (await fetch(`${b}/api/tasks/${live.id}`).then(j)).task.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      expect(c.tasks.isLive(live.id)).toBe(true);
      writeFileSync(join(pdir, "sess-live.jsonl"), FIXTURE.replaceAll("/work/repo", repo).replaceAll(SESSION, "sess-live"));

      const r = c.history.scan();
      expect(r).toMatchObject({ files: 4, created: 0, appended: 1, skippedForeign: 1, skippedOtherHost: 1, errors: [] });
      expect(c.history.scan()).toMatchObject({ skippedOtherHost: 0, skippedForeign: 1 }); // the sdk-only file is not re-read until it grows
      const tasks = (await fetch(`${b}/api/tasks`).then(j)) as Task[];
      expect(tasks.map((t) => t.id).sort()).toEqual([live.id, mine.id].sort()); // no new task
      const m = await fetch(`${b}/api/tasks/${mine.id}`).then(j);
      expect(m.task).toMatchObject({ origin: "switchboard", title: "mine", permissionMode: "auto" }); // the log does not rename or re-mode a Switchboard task
      expect(m.task.updatedAt).toBe(Date.parse("2026-09-06T13:10:05.000Z")); // …but its clock follows the appended turns
      expect(m.events).toHaveLength(22);
      expect(m.history).toMatchObject({ sessionId: "33333333-3333-4333-8333-333333333333", origin: "switchboard", path: fileC });
      const l = await fetch(`${b}/api/tasks/${live.id}`).then(j);
      expect(l.events).toHaveLength(script.length); // untouched
      expect(l.history).toBeNull();
      expect((await fetch(`${b}/api/history`).then(j)).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["33333333-3333-4333-8333-333333333333"]);
      // once the process is released, the same pass picks the file up
      await c.tasks.release(live.id);
      expect(c.history.scan()).toMatchObject({ created: 0, appended: 1, skippedOtherHost: 0, skippedForeign: 1 });
      expect((await fetch(`${b}/api/tasks/${live.id}`).then(j)).events.length).toBeGreaterThan(script.length);
      // the workspace arrives later: the foreign session comes in on the next pass
      await post(`${b}/api/workspaces`, { path: other });
      expect(c.history.scan()).toMatchObject({ created: 1, skippedForeign: 0 });
      expect(((await fetch(`${b}/api/tasks`).then(j)) as Task[]).find((t) => t.origin === "terminal")).toMatchObject({ cwd: other, runnerSessionId: "44444444-4444-4444-8444-444444444444" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test.skipIf(skipRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl"))("cwd is matched resolved (Claude Code logs the physical path); a danger mode is not carried over; a terminal turn that just finished goes in before a reply from here", async () => {
    assertRecordings("packages/adapters/claude/fixtures/terminal-session.jsonl");
    const { h, repo, projects, pdir } = setup("hist3");
    const real = realpathSync(repo); // on macOS the temp dir is /var/… → /private/var/…
    const script: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: SESSION, cwd: repo }, { t: "message.delta", role: "assistant", text: "resumed" }, { t: "session.end", status: "ok" }];
    const starts: StartOptions[] = [];
    const c = await daemon(h, projects, fakeAdapter(script, { starts, modes: ["auto", "bypass"], dangerModes: ["bypass"], defaultMode: "auto" }));
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await post(`${b}/api/workspaces`, { path: repo }); // registered as typed (the symlinked form)
      const file = join(pdir, `${SESSION}.jsonl`);
      writeFileSync(file, FIXTURE.replaceAll("/work/repo", real).replaceAll('"permissionMode":"acceptEdits"', '"permissionMode":"bypass"'));
      age(file);
      expect(c.history.scan()).toMatchObject({ created: 1, skippedForeign: 0, errors: [] });
      const t = ((await fetch(`${b}/api/tasks`).then(j)) as Task[])[0]!;
      expect(t).toMatchObject({ origin: "terminal", cwd: real, permissionMode: null }); // bypass is not inherited; the last `permission-mode` was acceptEdits → also replaced
      // the person types one more turn in the terminal and gets an answer (end_turn, file still "hot"), then replies
      // from Switchboard before the next pass: the terminal turn — and its end — go in before the reply
      appendFileSync(file, `${cliUser(real, SESSION, "terminal の最後の一言", "2026-09-06T14:00:00.000Z")}\n${cliAssistant(real, SESSION, "msg_H", "了解", "2026-09-06T14:00:05.000Z")}\n`);
      const sent = await post(`${b}/api/tasks/${t.id}/send`, { text: "from switchboard" });
      expect(sent.status).toBe("running");
      for (let i = 0; i < 50 && (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      const ev = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.map((e: { ev: AgentEvent }) => e.ev);
      const iTerminal = ev.findIndex((e: AgentEvent) => e.t === "message.delta" && e.text === "terminal の最後の一言");
      const iReply = ev.findIndex((e: AgentEvent) => e.t === "message.delta" && e.text === "resumed"); // the resumed turn's answer (the fake runner echoes no prompt)
      expect(iTerminal).toBeGreaterThan(0);
      expect(iReply).toBeGreaterThan(iTerminal);
      expect(ev.slice(iTerminal, iReply).map((e: AgentEvent) => e.t)).toEqual(["message.delta", "message.delta", "usage", "session.end", "session.start"]); // the terminal turn closed before the reply's turn
      expect(starts[0]).toMatchObject({ resumeSessionId: SESSION, permissionMode: "auto" }); // resumed with the resolved default, not bypass
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("approvals (#26)", () => {
  test("GET /api/approvals lists every unanswered ask across tasks, newest first; an answered one leaves", async () => {
    const create = (title: string) => fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title, prompt: "write x", runner: "claude" }) }).then(j);
    const first = await create("approvals-a");
    await waitFor(async () => (await getTask(first.id)).task.status === "waiting");
    await Bun.sleep(5); // distinct askedAt
    // the second in the meta workspace: the list names its workspace
    const meta = ((await fetch(`${base}/api/workspaces`).then(j)) as Array<{ id: string; kind: string; name: string }>).find((w) => w.kind === "meta")!;
    const second = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: meta.id, title: "approvals-b", prompt: "write x", runner: "claude" }) }).then(j);
    await waitFor(async () => (await getTask(second.id)).task.status === "waiting");
    const mine = async () => ((await fetch(`${base}/api/approvals`).then(j)) as Array<{ taskId: string; taskTitle: string; workspace: string | null; id: string; tool: string; input: unknown; detail: string; askedAt: number }>).filter((a) => a.taskId === first.id || a.taskId === second.id);
    const both = await mine();
    expect(both.map((a) => a.taskTitle)).toEqual(["approvals-b", "approvals-a"]);
    expect(both[0]).toMatchObject({ id: "perm1", tool: "Write", detail: "x", kind: "write", workspace: meta.name });
    expect(both[0]!.input).toEqual((SCRIPT.find((e) => e.t === "permission.ask") as { input: unknown }).input);
    expect(both[1]!.workspace).toBeNull();
    expect(both[0]!.askedAt).toBeGreaterThan(both[1]!.askedAt);
    // askedAt is the recorded event's time
    const askEvent = (await getTask(second.id)).events.find((e: { ev: AgentEvent }) => e.ev.t === "permission.ask");
    expect(both[0]!.askedAt).toBe(askEvent.ts);
    await fetch(`${base}/api/tasks/${first.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "perm1", decision: "allow" }) });
    expect((await mine()).map((a) => a.taskTitle)).toEqual(["approvals-b"]);
    await fetch(`${base}/api/tasks/${second.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "perm1", decision: "deny" }) });
    expect(await mine()).toEqual([]);
  });
});

describe("task outcome (#492)", () => {
  const ok = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
  const failing: AgentEvent[] = [...ok.filter((e) => e.t !== "session.end"), { t: "session.end", status: "error", summary: "boom" }];
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);
  /** claude asks for a permission, codex ends in error, dak ends ok (lingering, so a reply reuses the process). */
  const daemon = (h: string) =>
    startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(failing, { id: "codex" }), fakeAdapter(ok, { id: "dak", lingers: true })], { port: 0, selfdevChecks: false });

  test("the rule sets the outcome on a status change; it reaches GET /api/tasks/:id and task.updated; a new turn clears 確認済み", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-outcome-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updates: Task[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "task.updated") updates.push(msg.task);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const create = (runner: RunnerId, title: string) => post(`${b}/api/tasks`, { cwd: h, title, prompt: "p", runner });

      // (a) a turn that ends in error → failed, over HTTP and the WebSocket
      const e = await create("codex", "err");
      await waitFor(async () => (await get(e.id)).status === "error");
      expect(await get(e.id)).toMatchObject({ outcome: "failed", reviewedAt: null });
      await waitFor(async () => updates.some((t) => t.id === e.id && t.outcome === "failed"));

      // (b) waiting on a permission → needs_action; answered and running on → unknown
      const a = await create("claude", "ask");
      await waitFor(async () => (await get(a.id)).status === "waiting");
      expect((await get(a.id)).outcome).toBe("needs_action");
      await waitFor(async () => updates.some((t) => t.id === a.id && t.outcome === "needs_action"));
      await post(`${b}/api/tasks/${a.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(a.id)).status === "done");
      expect((await get(a.id)).outcome).toBe("unknown");

      // (c) 中断 while waiting → failed
      const x = await create("claude", "abort");
      await waitFor(async () => (await get(x.id)).status === "waiting");
      await post(`${b}/api/tasks/${x.id}/abort`);
      await waitFor(async () => (await get(x.id)).status === "aborted");
      expect((await get(x.id)).outcome).toBe("failed");

      // (d) a turn that ends ok → unknown (#493 judges the reply)
      const d = await create("dak", "ok");
      await waitFor(async () => (await get(d.id)).status === "done");
      expect(await get(d.id)).toMatchObject({ outcome: "unknown", reviewedAt: null });

      // (e) reviewed, then a reply starts a new turn → not reviewed, unknown again
      c.db.updateTask(d.id, { reviewedAt: 1234, outcome: "done" });
      expect(await get(d.id)).toMatchObject({ outcome: "done", reviewedAt: 1234 });
      const sent = await post(`${b}/api/tasks/${d.id}/send`, { text: "again" });
      expect(sent).toMatchObject({ status: "running", outcome: "unknown", reviewedAt: null });
      await waitFor(async () => (await get(d.id)).status === "done");
      expect(await get(d.id)).toMatchObject({ outcome: "unknown", reviewedAt: null });
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an explicit outcome wins over the rule; done / idle keep the outcome; both survive reopening the database; an orphaned task is failed", () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-outcome-db-"));
    try {
      const p = join(h, "switchboard.db");
      const db = new Db(p);
      const now = Date.now();
      const mk = (id: string, status: Task["status"]) => db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: h, scope: [h], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      mk("t1", "running");
      expect(db.updateTask("t1", { status: "waiting" })?.outcome).toBe("needs_action");
      expect(db.updateTask("t1", { status: "running", outcome: "done" })?.outcome).toBe("done");
      expect(db.updateTask("t1", { status: "done" })?.outcome).toBe("done");
      mk("t3", "running");
      db.updateTask("t3", { outcome: "done" });
      expect(db.updateTask("t3", { status: "idle" })?.outcome).toBe("done");
      expect(db.updateTask("t3", { status: "idle", title: "same status" })?.outcome).toBe("done");
      db.updateTask("t1", { outcome: "needs_action", reviewedAt: 42 });
      mk("t2", "running");
      db.close();
      const again = new Db(p);
      expect(again.getTask("t1")).toMatchObject({ outcome: "needs_action", reviewedAt: 42 });
      expect(abortOrphanedTasks(again)).toEqual(["t2"]);
      expect(again.getTask("t2")).toMatchObject({ status: "aborted", outcome: "failed" });
      again.close();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("POST /api/tasks/:id/outcome: 確認済み on / off and the outcome by hand, without moving the list order; a reply clears 確認済み; 400 / 404", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-outcome-api-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updates: Task[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "task.updated") updates.push(msg.task);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "ok", prompt: "p", runner: "dak" });
      await waitFor(async () => (await get(t.id)).status === "done");
      const before = await get(t.id);
      const set = (body: unknown) => fetch(`${b}/api/tasks/${t.id}/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      // (a) 確認済み: reviewedAt set, updatedAt unchanged, task.updated sent; and taken off again
      const reviewed = (await set({ reviewed: true }).then(j)).task as Task;
      expect(reviewed.reviewedAt).toBeGreaterThanOrEqual(before.updatedAt);
      expect(reviewed).toMatchObject({ updatedAt: before.updatedAt, outcome: "unknown" });
      expect(await get(t.id)).toMatchObject({ reviewedAt: reviewed.reviewedAt, updatedAt: before.updatedAt });
      await waitFor(async () => updates.some((u) => u.id === t.id && u.reviewedAt === reviewed.reviewedAt));
      expect((await set({ reviewed: false }).then(j)).task).toMatchObject({ reviewedAt: null, updatedAt: before.updatedAt });

      // (b) done keeps 確認済み; needs_action (or failed) on a reviewed task puts it back under 要対応; both at once is taken as given
      await set({ reviewed: true });
      const done = (await set({ outcome: "done" }).then(j)).task as Task;
      expect(done.outcome).toBe("done");
      expect(done.reviewedAt).not.toBeNull();
      expect((await set({ outcome: "needs_action" }).then(j)).task).toMatchObject({ outcome: "needs_action", reviewedAt: null });
      await set({ reviewed: true });
      expect((await set({ outcome: "failed" }).then(j)).task).toMatchObject({ outcome: "failed", reviewedAt: null });
      const both = (await set({ outcome: "failed", reviewed: true }).then(j)).task as Task;
      expect(both.outcome).toBe("failed");
      expect(both.reviewedAt).not.toBeNull();
      expect((await get(t.id)).updatedAt).toBe(before.updatedAt);

      // (c) a reply to a reviewed task starts a new turn: not reviewed, unknown (acceptance criterion 5)
      const sent = await post(`${b}/api/tasks/${t.id}/send`, { text: "again" });
      expect(sent).toMatchObject({ status: "running", outcome: "unknown", reviewedAt: null });
      await waitFor(async () => (await get(t.id)).status === "done");
      expect(await get(t.id)).toMatchObject({ outcome: "unknown", reviewedAt: null });

      // (d) 400 / 404
      expect((await set({})).status).toBe(400);
      expect((await set({ outcome: "maybe" })).status).toBe(400);
      expect((await set({ reviewed: "yes" })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks/${t.id}/outcome`, { method: "POST", body: "not json" })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks/task_nope/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewed: true }) })).status).toBe(404);
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("POST /api/tasks/:id/archive (#1164): a stopped Task leaves GET /api/tasks and shows under ?archived=1, comes back on false; a reply brings it back; 409 / 400 / 404", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-archive-api-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const ids = async (q = "") => ((await fetch(`${b}/api/tasks${q}`).then(j)) as Task[]).map((t) => t.id);
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "ok", prompt: "p", runner: "dak" });
      await waitFor(async () => (await get(t.id)).status === "done");
      const before = await get(t.id);
      expect(before.archivedAt).toBeNull();
      const set = (body: unknown, id = t.id) => fetch(`${b}/api/tasks/${id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

      const archived = (await set({ archived: true }).then(j)) as Task;
      expect(archived.archivedAt).toBeGreaterThanOrEqual(before.updatedAt);
      expect(archived.updatedAt).toBe(before.updatedAt);
      expect(await ids()).not.toContain(t.id);
      expect(await ids("?archived=1")).toEqual([t.id]);

      expect(((await set({ archived: false }).then(j)) as Task).archivedAt).toBeNull();
      expect(await ids()).toContain(t.id);
      expect(await ids("?archived=1")).toEqual([]);

      // a reply starts a new turn: the Task is not hidden while it runs
      await set({ archived: true });
      expect(await post(`${b}/api/tasks/${t.id}/send`, { text: "again" })).toMatchObject({ status: "running", archivedAt: null });
      await waitFor(async () => (await get(t.id)).status === "done");
      expect(await ids()).toContain(t.id);

      for (const status of ["running", "waiting", "idle"]) {
        c.db.sqlite.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, t.id);
        expect((await set({ archived: true })).status).toBe(409);
      }
      expect((await set({})).status).toBe(400);
      expect((await set({ archived: "yes" })).status).toBe(400);
      expect((await fetch(`${b}/api/tasks/${t.id}/archive`, { method: "POST", body: "not json" })).status).toBe(400);
      expect((await set({ archived: true }, "task_nope")).status).toBe(404);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("migrate(): tasks that stopped before #492 are reviewed (reviewedAt = updatedAt), running / waiting / idle ones are not", () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-outcome-mig-"));
    try {
      const p = join(h, "old.db");
      const raw = new (require("bun:sqlite").Database)(p, { create: true });
      raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO tasks VALUES ('t_done', NULL, 'd', 'claude', '/tmp', '[]', 'done', NULL, NULL, 1, 100), ('t_err', NULL, 'e', 'claude', '/tmp', '[]', 'error', NULL, NULL, 1, 200),
          ('t_run', NULL, 'r', 'claude', '/tmp', '[]', 'running', NULL, NULL, 1, 300), ('t_wait', NULL, 'w', 'claude', '/tmp', '[]', 'waiting', NULL, NULL, 1, 400), ('t_idle', NULL, 'i', 'claude', '/tmp', '[]', 'idle', NULL, NULL, 1, 500);`);
      raw.close();
      const db = new Db(p);
      expect(db.getTask("t_done")).toMatchObject({ outcome: "unknown", reviewedAt: 100 });
      expect(db.getTask("t_err")).toMatchObject({ outcome: "unknown", reviewedAt: 200 });
      for (const id of ["t_run", "t_wait", "t_idle"]) expect(db.getTask(id)!.reviewedAt).toBeNull();
      db.close();
      const reopened = new Db(p); // the backfill runs once, with the column
      expect(reopened.getTask("t_done")!.reviewedAt).toBe(100);
      reopened.close();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("repeated stops (#948)", () => {
  const R = { id: "ci", op: "gh pr merge", target: "PR #12", reason: "permission", evidence: "マージの承認待ち" };
  const other = (id: string) => "```switchboard-stop\n" + JSON.stringify({ ...R, id }) + "\n```";
  // the report split across deltas and closed by the next message; a quoted one, a tool's output and the person's message are not reports
  const script: AgentEvent[] = [
    { t: "session.start", runner: "claude", runnerSessionId: "sess-s", cwd: "/tmp" },
    { t: "message.delta", role: "assistant", text: "CI を待ちます。\n```switchboard-st", messageId: "m1" },
    { t: "message.delta", role: "assistant", text: "op\n" + JSON.stringify(R) + "\n```", messageId: "m1" },
    { t: "message.delta", role: "assistant", text: "例:\n````md\n" + other("quoted") + "\n````\n", messageId: "m2" },
    { t: "tool.call", id: "tu", name: "Bash", input: {}, summary: "cat" },
    { t: "tool.result", id: "tu", ok: true, summary: other("tool") },
    { t: "permission.ask", id: "perm1", kind: "exec", tool: "Bash", input: {}, detail: "gh pr merge" },
    { t: "session.end", status: "ok" },
  ];
  const post = (b: string, path: string, body?: object) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  test("#950: the same permission stop reported again is one series, and the ask stays the person's — nothing is allowed or denied by it", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-stops-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    const c = await startServer(cfg, [fakeAdapter(script, { lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
      const a = c.tasks.create({ workspaceId: meta.id, cwd: c.db.getWorkspace(meta.id)!.path, title: "#939 実装: PBI: 再停止", prompt: "p", runner: "claude", stage: { issue: 939, action: "complete" } });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${a.id}`).then(j)).task.status === "waiting");
      for (const evidence of ["承認待ち", "承認待ちです（もう一度）"])
        c.tasks.recordStop(a.id, StopReport.parse({ id: `again-${evidence.length}`, op: "gh pr merge", target: "PR #12", reason: "permission", evidence }));
      // the pending ask is still there, with its id, undecided
      expect(c.tasks.pendingApprovals().map((p) => p.id)).toEqual(["perm1"]);
      const d = await fetch(`${b}/api/tasks/${a.id}`).then(j);
      expect(d.stopSummary.filter((s: { op: string }) => s.op === "gh pr merge")).toMatchObject([{ count: 3, lastAnswer: null, next: "decide" }]);
      expect(c.db.listEvents(a.id).some((e) => e.ev.t === "permission.resolved")).toBe(false);
    } finally {
      await c.stop();
    }
  });

  test("task detail returns eventsArchive for an archived task and null otherwise (#1439)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-evarch-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    const c = await startServer(cfg, [fakeAdapter(script, { lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
      const a = await post(b, "/api/tasks", { workspaceId: meta.id, title: "移す Task", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${a.id}`).then(j)).task.status === "waiting");
      expect((await fetch(`${b}/api/tasks/${a.id}`).then(j)).eventsArchive).toBeNull();
      c.db.sqlite.run("UPDATE tasks SET events_archive_key = ?, events_archived_at = ?, events_archived_count = ?, events_archived_max_seq = ? WHERE id = ?", ["history/events/2026/x.jsonl.zst.age", 1760400000000, 7, 7, a.id]);
      const d = await fetch(`${b}/api/tasks/${a.id}`).then(j);
      expect(d.eventsArchive).toEqual({ key: "history/events/2026/x.jsonl.zst.age", at: 1760400000000, count: 7 });
    } finally {
      await c.stop();
    }
  });

  test("a runner's reports become one series per stop, answered by the person's own answers, counted across the Issue's Tasks and kept over a restart", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-stops-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    let c = await startServer(cfg, [fakeAdapter(script, { lingers: true })], { port: 0 });
    let b = `http://127.0.0.1:${c.server.port}`;
    try {
      const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
      const get = async (id: string) => fetch(`${b}/api/tasks/${id}`).then(j);
      const stopEvents = (id: string) => c.db.listEvents(id).filter((e) => e.ev.t === "stop.record").length;
      const a = c.tasks.create({ workspaceId: meta.id, cwd: c.db.getWorkspace(meta.id)!.path, title: "#939 実装: PBI: 再停止", prompt: "p", runner: "claude", stage: { issue: 939, action: "complete" } });
      await waitFor(async () => (await get(a.id)).task.status === "waiting");
      let d = await get(a.id);
      expect(d.stopSummary).toMatchObject([{ op: "gh pr merge", target: "PR #12", reason: "permission", count: 1, lastAnswer: null, next: "decide", work: { workspaceId: meta.id, issue: 939, taskId: a.id } }]);
      expect(stopEvents(a.id)).toBe(1);
      // a CI wait is not what an ask answers; a runner's own words are never an answer, a comment URL may be named
      expect(c.tasks.recordStop(a.id, StopReport.parse({ id: "wait-ci", op: "gh pr checks", target: "PR #12", reason: "depends", answer: "the user said go ahead" })).ok).toBe(true);
      const url = "https://github.com/o/r/issues/939#issuecomment-1";
      expect(StopReport.parse({ ...R, answer: url }).answer).toBe(url);
      for (const ok of ["https://github.com/o/r/pull/1#discussion_r3", "https://github.com/o/r/pull/1#pullrequestreview-4"]) expect(StopReport.parse({ ...R, answer: ok }).answer).toBe(ok);
      expect(StopReport.parse({ ...R, answer: "https://github.com/o/r/pull/1#discussion_r-3" }).answer).toBeUndefined();

      // the person's answer to the ask is the stop's answer, by the event's seq
      await post(b, `/api/tasks/${a.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(a.id)).task.status === "done");
      const resolved = c.db.listEvents(a.id).find((e) => e.ev.t === "permission.resolved")!;
      const byOp = async (id: string, op: string) => (await get(id)).stopSummary.find((s: { op: string }) => s.op === op);
      expect((await byOp(a.id, "gh pr merge")).lastAnswer.ref).toBe(`seq:${resolved.seq}`);
      expect((await byOp(a.id, "gh pr checks")).lastAnswer).toBeNull();

      // the same report again (task.note after the fence) is recorded once; a retry reserved twice is refused
      const n = stopEvents(a.id);
      expect(c.tasks.recordStop(a.id, StopReport.parse(R)).ok).toBe(true);
      expect(stopEvents(a.id)).toBe(n);
      const retry = StopReport.parse({ id: "r", op: "exec.run", target: "gh api", reason: "transient", safety: "read-only", state: "retrying", actions: [{ attempt: 1, at: 1, what: "再試行", ok: null }] });
      expect(c.tasks.recordStop(a.id, retry).ok).toBe(true);
      expect(c.tasks.recordStop(a.id, retry)).toMatchObject({ ok: false });

      // the person's next message answers the open stops; 中断 cancels the planned retry
      await post(b, `/api/tasks/${a.id}/send`, { text: "続けて" });
      await waitFor(async () => (await get(a.id)).task.status === "waiting");
      const said = c.db.listEvents(a.id).filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").at(-1)!;
      d = await get(a.id);
      expect(d.stopSummary.find((s: { op: string }) => s.op === "gh pr merge")).toMatchObject({ count: 1, lastAnswer: { ref: `seq:${said.seq}` } });
      await post(b, `/api/tasks/${a.id}/abort`);
      expect((await get(a.id)).stopSummary.find((s: { op: string }) => s.op === "exec.run")).toMatchObject({ state: "waiting", actions: [{ attempt: 1 }, { what: "中断で再試行を取り消し" }] });

      // another Task on the same Issue stopping the same way is the same series, seen from either Task
      const t2 = c.tasks.create({ workspaceId: meta.id, cwd: c.db.getWorkspace(meta.id)!.path, title: "#939 実装: PBI: 再停止", prompt: "p", runner: "claude", stage: { issue: 939, action: "complete" } });
      await waitFor(async () => (await get(t2.id)).task.status === "waiting");
      const series = (await get(t2.id)).stopSummary.find((s: { op: string }) => s.op === "gh pr merge");
      expect(series).toMatchObject({ count: 2, unchanged: true, next: "wait", lastAnswer: { ref: `seq:${said.seq}` } });
      expect((await get(a.id)).stopSummary.find((s: { op: string }) => s.op === "gh pr merge").count).toBe(2);
      // a task with no Issue keeps its stops to itself
      const lone = await post(b, "/api/tasks", { cwd: h, title: "lone", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => (await get(lone.id)).task.status === "waiting");
      expect((await get(lone.id)).stopSummary).toMatchObject([{ count: 1, work: { issue: null, taskId: lone.id } }]);

      // a restart forgets nothing: the events are the record
      await c.stop();
      c = await startServer(cfg, [fakeAdapter(script, { lingers: true })], { port: 0 });
      b = `http://127.0.0.1:${c.server.port}`;
      expect((await get(t2.id)).stopSummary.find((s: { op: string }) => s.op === "gh pr merge")).toMatchObject({ count: 2, lastAnswer: { ref: `seq:${said.seq}` } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a runner's own retries (#949): reserved one attempt at a time up to 2, refused past that or when unsafe; the next start is told the open stops and the retries left", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-retry-"));
    const starts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(b, "/api/tasks", { cwd: h, title: "retry", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => c.db.getTask(t.id)?.status === "done");
      expect(starts[0]?.preamble).toStartWith("[Switchboard: 止まったときの報告]");
      const net = (attempt: number, over: object = {}) => StopReport.parse({ id: "net", op: "gh api", target: "repos/o/r", reason: "transient", safety: "read-only", evidence: "HTTP 503", state: "retrying", actions: Array.from({ length: attempt }, (_, i) => ({ attempt: i + 1, what: "再実行", ok: null })), ...over });
      expect(c.tasks.recordStop(t.id, net(2))).toMatchObject({ ok: false, why: expect.stringContaining("次は 1 回目") }); // skipping an attempt
      expect(c.tasks.recordStop(t.id, net(1)).ok).toBe(true);
      expect(c.tasks.recordStop(t.id, net(2)).ok).toBe(true);
      expect(c.tasks.recordStop(t.id, net(3))).toMatchObject({ ok: false, why: expect.stringContaining("使い切りました") });
      expect(c.tasks.stopOf(t.id, "net")).toMatchObject({ state: "exhausted", actions: [{ attempt: 1 }, { attempt: 2 }, { attempt: 2, what: expect.stringContaining("再試行しない"), ok: false }] });
      // an operation that may have done something is never reserved; an auth error neither
      expect(c.tasks.recordStop(t.id, net(1, { id: "post", op: "gh pr comment", safety: "unknown" }))).toMatchObject({ ok: false });
      expect(c.tasks.stopOf(t.id, "post")).toMatchObject({ state: "waiting" });
      expect(c.tasks.recordStop(t.id, net(1, { id: "auth", reason: "auth" }))).toMatchObject({ ok: false });
      // the next start hears what is still open
      await post(b, `/api/tasks/${t.id}/send`, { text: "続けて" });
      expect(starts[1]?.preamble).toContain("- gh api repos/o/r: transient（止まったのは 1 回、exhausted、再試行の残り 0 回）");
      expect(starts[1]?.preamble).toContain("- gh pr comment repos/o/r: transient（止まったのは 1 回、waiting）");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("task evals (#1218)", () => {
  // the real adapters echo the prompt as a user message first; the counter reads the first one as the request
  const script: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT];
  const daemon = (h: string) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH });
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(j);

  test("GET /api/tasks/:id/evals: the rules row is counted at each turn's end (one row, replaced), filled in on read when missing, 404 for no task", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-evals-api-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const evals = (id: string) => fetch(`${b}/api/tasks/${id}/evals`).then(j);
      const rows = (id: string) => (c.db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = ? AND source = 'rules'").get(id) as { n: number }).n;
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "evals", prompt: "依頼文", runner: "claude" });
      await waitFor(async () => (await get(t.id)).status === "waiting");
      await post(`${b}/api/tasks/${t.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(t.id)).status === "done");
      // (a) counted when the turn ended
      await waitFor(async () => rows(t.id) === 1);
      const first = await evals(t.id);
      expect(first.judge).toBeNull();
      expect(first.human).toBeNull();
      expect(first.rules).toMatchObject({ status: "done", by: "rules@1", metrics: { turns: 1, toolCalls: 1, toolFailures: 0, asks: 1, denials: 0, userInstructions: 0, lastEnd: "ok" } });
      expect(first.rules.costUsd).toBeGreaterThan(0);
      // a second turn: the person's follow-up counts as one instruction; still one row
      await post(`${b}/api/tasks/${t.id}/send`, { text: "続けて" });
      await waitFor(async () => (await get(t.id)).status === "waiting");
      await post(`${b}/api/tasks/${t.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(t.id)).status === "done");
      await waitFor(async () => ((await evals(t.id)).rules?.metrics.turns ?? 0) === 2);
      expect((await evals(t.id)).rules.metrics).toMatchObject({ turns: 2, toolCalls: 2, asks: 2, userInstructions: 1 });
      expect(rows(t.id)).toBe(1);
      // (b) a task without a row (one from before #1218) is counted when read, and the row is kept
      c.db.deleteEval(t.id, "rules");
      expect(rows(t.id)).toBe(0);
      expect((await evals(t.id)).rules.metrics.turns).toBe(2);
      expect(rows(t.id)).toBe(1);
      // (c) the task's status / outcome / cost of the moment, not the snapshot the turn's end stored (the person or the judge sets the outcome afterwards)
      await post(`${b}/api/tasks/${t.id}/outcome`, { outcome: "done" });
      expect((await evals(t.id)).rules).toMatchObject({ status: "done", outcome: "done" });
      expect((c.db.getEval(t.id, "rules")?.json as { outcome: string }).outcome).toBe("unknown");
      // (d) no such task
      expect((await fetch(`${b}/api/tasks/nope/evals`)).status).toBe(404);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("rubric judge (#1219)", () => {
  const script: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT.filter((e) => e.t !== "permission.ask")];
  type RubricCall = { input: Parameters<typeof judgeRubric>[0]; opts: Parameters<typeof judgeRubric>[1]; answer: (score: number) => void; fail: (e: Error) => void };
  /** A rubric judge the test answers by hand: each call waits until the test resolves it. */
  const handRubricJudge = () => {
    const calls: RubricCall[] = [];
    const rubricJudge: typeof judgeRubric = (input, opts) =>
      new Promise((resolve, reject) => {
        calls.push({ input, opts, fail: reject, answer: (score) => {
          opts.onUsage?.(opts.settings.runner, { t: "usage", source: "reported", model: opts.settings.model, inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 });
          resolve({ scores: Object.fromEntries(input.rubric.criteria.map((c) => [c.id, { score, reason: `${c.id} ${score}` }])), summary: `総評 ${score}`, rubric: `${input.rubric.id}@${input.rubric.version}`, by: `${opts.settings.runner}:${opts.settings.model}`, ts: Date.now() });
        } });
      });
    return { calls, rubricJudge };
  };
  const post = (url: string, body?: unknown, method = "POST") => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const daemon = (h: string, rubricJudge: typeof judgeRubric) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH, rubricJudge });

  test("a done turn is scored in the background: the judge row, evals.updated and the ledger; off by setting; 再評価 on demand (202 / 409 / 404); one row per task", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-rubric-"));
    const { calls, rubricJudge } = handRubricJudge();
    const c = await daemon(h, rubricJudge);
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updated: string[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "evals.updated") updated.push(msg.taskId);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const evals = (id: string) => fetch(`${b}/api/tasks/${id}/evals`).then(j);
      const rows = (id: string) => (c.db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = ? AND source = 'judge'").get(id) as { n: number }).n;
      const ledgerRows = (id: string) => (c.db.sqlite.query("SELECT count(*) AS n FROM ledger WHERE task_id = ?").get(id) as { n: number }).n;
      // (a) the turn ends done → the judge is asked with the default rubric and the rule counts; the answer lands as the judge row
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "rubric", prompt: "依頼文", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "done");
      await waitFor(async () => calls.length === 1);
      expect(calls[0]!.input).toMatchObject({ title: "rubric", prompt: "依頼文", rubric: { id: "switchboard-default", version: 1 } });
      expect(calls[0]!.input.metrics.toolCalls).toBe(1);
      expect(calls[0]!.opts.settings).toMatchObject({ runner: "codex", model: "gpt-6-luna" });
      expect((await evals(t.id)).judge).toBeNull();
      const before = ledgerRows(t.id);
      calls[0]!.answer(4);
      await waitFor(async () => rows(t.id) === 1);
      const e = await evals(t.id);
      expect(e.judge).toMatchObject({ scores: { goal: { score: 4, reason: "goal 4" }, safety: { score: 4 } }, summary: "総評 4", rubric: "switchboard-default@1", by: "codex:gpt-6-luna" });
      expect(Object.keys(e.judge.scores)).toHaveLength(5);
      expect(c.db.getEval(t.id, "judge")).toMatchObject({ by: "codex:gpt-6-luna", rubric: "switchboard-default@1" });
      await waitFor(async () => updated.includes(t.id));
      expect(ledgerRows(t.id)).toBe(before + 1);
      // (b) a second turn: judged again, the row is replaced, still one
      await post(`${b}/api/tasks/${t.id}/send`, { text: "続けて" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "done");
      await waitFor(async () => calls.length === 2);
      calls[1]!.answer(2);
      await waitFor(async () => (await evals(t.id)).judge?.scores.goal.score === 2);
      expect(rows(t.id)).toBe(1);
      // (c) 再評価: 202 and a new call; 409 while a turn runs; 404 for no task
      const r = await post(`${b}/api/tasks/${t.id}/evals/judge`);
      expect(r.status).toBe(202);
      expect(await j(r)).toEqual({ queued: true });
      await waitFor(async () => calls.length === 3);
      calls[2]!.answer(5);
      await waitFor(async () => (await evals(t.id)).judge?.scores.goal.score === 5);
      expect((await post(`${b}/api/tasks/nope/evals/judge`)).status).toBe(404);
      // nothing to score yet: a task with no request in its transcript
      const now = Date.now();
      c.db.insertTask({ id: "empty", workspaceId: null, title: "empty", runner: "claude", cwd: h, scope: [h], status: "idle", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      expect((await post(`${b}/api/tasks/empty/evals/judge`)).status).toBe(409);
      // (d) switched off: the next done turn is not judged; 再評価 still works
      expect(await post(`${b}/api/settings`, { evals: { judge: { enabled: false } } }, "PATCH").then(j)).toMatchObject({ evals: { judge: { enabled: false } } });
      await post(`${b}/api/tasks/${t.id}/send`, { text: "もう一度" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "done");
      await Bun.sleep(100);
      expect(calls).toHaveLength(3);
      expect((await post(`${b}/api/tasks/${t.id}/evals/judge`)).status).toBe(202);
      await waitFor(async () => calls.length === 4);
      const seen = updated.length;
      calls[3]!.fail(new Error("limit"));
      await waitFor(async () => updated.length > seen); // the screen is told even then, so 再評価 does not wait forever
      expect((await evals(t.id)).judge?.scores.goal.score).toBe(5); // a failed scoring leaves the previous row
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("409 while a turn runs; a stale score (a turn started since) is dropped", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-rubric-stale-"));
    const { calls, rubricJudge } = handRubricJudge();
    const slow: AgentEvent[] = [{ t: "message.delta", role: "user", text: "p" }, { t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: {}, detail: "x" }, { t: "message.delta", role: "assistant", text: "done" }, { t: "session.end", status: "ok", summary: "done" }];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(slow, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH, rubricJudge });
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updated: string[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "evals.updated") updated.push(msg.taskId);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "stale", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "waiting");
      expect((await post(`${b}/api/tasks/${t.id}/evals/judge`)).status).toBe(409);
      await post(`${b}/api/tasks/${t.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(t.id)).status === "done");
      await waitFor(async () => calls.length === 1);
      // a status event meanwhile (a model change) is not a new transcript: the score is kept
      await post(`${b}/api/tasks/${t.id}/model`, { model: "claude-haiku-4-5" }).then(j);
      calls[0]!.answer(3);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}/evals`).then(j)).judge?.scores.goal.score === 3);
      // a new turn starts before a score arrives: that score is of an older reply and is dropped
      await post(`${b}/api/tasks/${t.id}/evals/judge`);
      await waitFor(async () => calls.length === 2);
      await post(`${b}/api/tasks/${t.id}/send`, { text: "again" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "waiting");
      const seen = updated.length;
      calls[1]!.answer(1);
      await waitFor(async () => updated.length > seen); // the drop is announced too, so the screen's 再評価 stops waiting
      expect((await fetch(`${b}/api/tasks/${t.id}/evals`).then(j)).judge?.scores.goal.score).toBe(3);
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("human eval (#1220)", () => {
  const script: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT.filter((e) => e.t !== "permission.ask")];
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("PUT puts the person's rating and note on the task (one row, replaced), GET returns it, DELETE clears it; the task row itself never moves; 400 / 404", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-human-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const updated: string[] = [];
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type === "evals.updated") updated.push(msg.taskId);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const evals = (id: string) => fetch(`${b}/api/tasks/${id}/evals`).then(j);
      const rows = (id: string) => (c.db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = ? AND source = 'human'").get(id) as { n: number }).n;
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "rate me", prompt: "依頼文", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).status === "done");
      c.db.updateTask(t.id, { outcome: "done", reviewedAt: 777 });
      const before = await get(t.id);
      expect((await evals(t.id)).human).toBeNull();
      // (a) put, read back, announced; one row
      const r1 = await send(`${b}/api/tasks/${t.id}/evals/human`, "PUT", { rating: 4, comment: "良い" });
      expect(r1.status).toBe(200);
      expect((await j(r1)).human).toMatchObject({ rating: 4, comment: "良い", by: "user" });
      expect((await evals(t.id)).human).toMatchObject({ rating: 4, comment: "良い", by: "user" });
      await waitFor(async () => updated.includes(t.id));
      expect(rows(t.id)).toBe(1);
      const r2 = await send(`${b}/api/tasks/${t.id}/evals/human`, "PUT", { rating: 2 }).then(j);
      expect(r2.human).toMatchObject({ rating: 2, comment: "" });
      expect(rows(t.id)).toBe(1);
      expect(c.db.getEval(t.id, "human")).toMatchObject({ by: "user", rubric: null });
      // (b) the task row did not move: no activity, no outcome change, still reviewed
      const after = await get(t.id);
      expect(after).toMatchObject({ updatedAt: before.updatedAt, outcome: "done", reviewedAt: 777 });
      // (c) refused shapes, unknown task
      for (const body of [{ rating: 6 }, { rating: 2.5 }, { rating: 3, comment: "x".repeat(1001) }, {}]) expect((await send(`${b}/api/tasks/${t.id}/evals/human`, "PUT", body)).status, JSON.stringify(body).slice(0, 30)).toBe(400);
      expect((await send(`${b}/api/tasks/nope/evals/human`, "PUT", { rating: 3 })).status).toBe(404);
      expect((await send(`${b}/api/tasks/nope/evals/human`, "DELETE")).status).toBe(404);
      // (d) cleared (announced too), twice is fine
      const seen = updated.length;
      expect((await send(`${b}/api/tasks/${t.id}/evals/human`, "DELETE").then(j)).human).toBeNull();
      expect(rows(t.id)).toBe(0);
      await waitFor(async () => updated.length > seen);
      expect((await send(`${b}/api/tasks/${t.id}/evals/human`, "DELETE")).status).toBe(200);
      expect((await evals(t.id)).human).toBeNull();
      // (e) a Cloud task has no events here to count, but the person may rate it: rules stays null, human comes back
      const now = Date.now();
      c.db.insertTask({ id: "cloudy", workspaceId: null, title: "cloud", runner: "claude", cwd: h, scope: [h], status: "done", runnerSessionId: null, executionMode: "cloud", cloudSession: { id: "session_cloudy", url: "https://claude.ai/code/session_cloudy" }, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      expect(await send(`${b}/api/tasks/cloudy/evals/human`, "PUT", { rating: 5, comment: "cloud" }).then(j)).toMatchObject({ rules: null, judge: null, human: { rating: 5, comment: "cloud" } });
      expect(await evals("cloudy")).toMatchObject({ rules: null, human: { rating: 5 } });
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("evals list (#1221)", () => {
  const script: AgentEvent[] = [{ t: "message.delta", role: "user", text: "依頼文" }, ...SCRIPT.filter((e) => e.t !== "permission.ask")];
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("GET /api/evals: every task newest first with the gist of its rules / judge / human rows (null where none), the ledger's cost, filtered by runner, cut by limit", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-evals-list-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const list = (qs = "") => fetch(`${b}/api/evals${qs}`).then(j) as Promise<Array<Record<string, any>>>;
      const a = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "first", prompt: "依頼文", runner: "claude" }).then(j);
      await waitFor(async () => (await get(a.id)).status === "done");
      await Bun.sleep(5);
      const z = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "second", prompt: "依頼文", runner: "claude" }).then(j);
      await waitFor(async () => (await get(z.id)).status === "done");
      await waitFor(async () => (c.db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE source = 'rules'").get() as { n: number }).n === 2);
      expect((await send(`${b}/api/tasks/${a.id}/evals/human`, "PUT", { rating: 3, comment: "まあまあ" })).status).toBe(200);
      c.db.upsertEval({ taskId: a.id, source: "judge", by: "codex:gpt-6-luna", rubric: "switchboard-default@1", json: { scores: { goal: { score: 4, reason: "" }, safety: { score: 5, reason: "" }, efficiency: { score: 2, reason: "" } }, summary: "総評", rubric: "switchboard-default@1", by: "codex:gpt-6-luna", ts: 1 }, ts: 1 });
      // a task that never ran: no eval rows, still listed
      const now = Date.now() + 10_000;
      c.db.insertTask({ id: "idle1", workspaceId: null, title: "idle", runner: "codex", cwd: h, scope: [h], status: "idle", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      const rows = await list();
      expect(rows.map((r) => r.taskId)).toEqual(["idle1", z.id, a.id]); // newest first
      const idle = rows[0]!;
      // a local task without a rules row is counted on read (zeros here: no events), as the Brief does; a row then exists
      expect(idle).toMatchObject({ runner: "codex", status: "idle", rules: { toolCalls: 0, toolFailures: 0, userInstructions: 0, lastEnd: null }, judge: null, human: null, costUsd: 0 });
      expect((c.db.sqlite.query("SELECT count(*) AS n FROM task_evals WHERE task_id = 'idle1' AND source = 'rules'").get() as { n: number }).n).toBe(1);
      const first = rows[2]!;
      expect(first).toMatchObject({ title: "first", status: "done", rules: { toolCalls: 1, toolFailures: 0, errors: 0, userInstructions: 0, stops: 0, lastEnd: "ok" }, judge: { average: 3.7, scores: { goal: 4, safety: 5, efficiency: 2 }, rubric: "switchboard-default@1", by: "codex:gpt-6-luna" }, human: { rating: 3, comment: "まあまあ" } });
      expect(first.costUsd).toBeCloseTo(c.db.taskCost(a.id).costUsd, 6);
      expect(first.costUsd).toBeGreaterThan(0);
      expect(rows[1]).toMatchObject({ title: "second", judge: null, human: null });
      expect(rows[1]!.rules.toolCalls).toBe(1);
      // filters and limit
      expect((await list("?runner=codex")).map((r) => r.taskId)).toEqual(["idle1"]);
      expect((await list("?runner=dak")).length).toBe(0);
      expect((await fetch(`${b}/api/evals?runner=bogus`)).status).toBe(400);
      expect((await list("?limit=1")).map((r) => r.taskId)).toEqual(["idle1"]);
      expect((await list("?limit=2.5")).length).toBe(2); // a fraction is floored, not handed to SQLite
      expect((await list("?limit=9999")).length).toBe(3); // the cap (500) is not an error
      expect((await list("?workspaceId=nope")).length).toBe(0);
      // the draft of an improvement request (#1221): the task, its counts, the low criterion, the rating; 404 for no task
      const draft = (await fetch(`${b}/api/tasks/${a.id}/evals/draft`).then(j)).text as string;
      expect(draft).toContain("Task「first」");
      expect(draft).toContain("- 指標: ツール呼び出し 1 / 失敗 0");
      expect(draft).toContain("- 効率: 2 / 5");
      expect(draft).not.toContain("- 依頼の達成");
      expect(draft).toContain("- 自分の評価: 3 / 5 — まあまあ");
      expect(draft).toEndWith("改善したいこと:\n");
      expect((await fetch(`${b}/api/tasks/nope/evals/draft`)).status).toBe(404);
      // a row whose json no longer reads is null, like evalsOf
      c.db.sqlite.query("UPDATE task_evals SET json = '{\"old\": true}' WHERE task_id = ? AND source = 'judge'").run(a.id);
      expect((await list()).find((r) => r.taskId === a.id)!.judge).toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("task status transitions (#1140)", () => {
  const ok = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
  const post = (url: string, body?: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const boot = (h: string, adapters: RunnerAdapter[]) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), adapters, { port: 0, selfdevChecks: false });

  test("a runner event that arrives after the turn ended does not take a done task back to waiting", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-late-"));
    // after session.end: an ask with no turn started, which the fake runner holds until it is answered
    const late: AgentEvent[] = [
      ...ok,
      { t: "permission.ask", id: "late1", kind: "write", tool: "Write", input: { file_path: "/tmp/y" }, detail: "late" },
    ];
    const c = await boot(h, [fakeAdapter(late, { lingers: true })]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "late", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => c.db.listEvents(t.id).some((e) => e.ev.t === "permission.ask"));
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "unknown" });
      // answering the ask the finished task was holding reaches the runner and does not move the status
      const answered = await post(`${b}/api/tasks/${t.id}/permission`, { id: "late1", decision: "allow" });
      expect(answered.status).toBe(200);
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "unknown" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a turn the attached runner starts on its own after the turn ended is in flight: its ask makes the task waiting", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-own-"));
    // after session.end: the runner starts a turn by itself (a background job's notification) and asks
    const own: AgentEvent[] = [
      ...ok,
      { t: "session.start", runner: "claude", runnerSessionId: "sess-own", cwd: "/tmp", model: "claude-haiku-4-5-20251001" },
      { t: "permission.ask", id: "own1", kind: "write", tool: "Write", input: { file_path: "/tmp/y" }, detail: "own" },
    ];
    const c = await boot(h, [fakeAdapter(own, { lingers: true })]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "own", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => c.db.listEvents(t.id).some((e) => e.ev.t === "permission.ask"));
      expect(c.db.getTask(t.id)).toMatchObject({ status: "waiting", outcome: "needs_action", runnerSessionId: "sess-own" });
      const answered = await post(`${b}/api/tasks/${t.id}/permission`, { id: "own1", decision: "allow" });
      expect(answered.status).toBe(200);
      expect(c.db.getTask(t.id)).toMatchObject({ status: "running" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("abort: a waiting task becomes aborted / failed; a done task stays done", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-abort-"));
    const c = await boot(h, [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(ok, { id: "dak", lingers: true })]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const w = await post(`${b}/api/tasks`, { cwd: h, title: "w", prompt: "p", runner: "claude" }).then(j);
      await waitFor(async () => c.db.getTask(w.id)?.status === "waiting");
      await post(`${b}/api/tasks/${w.id}/abort`);
      expect(c.db.getTask(w.id)).toMatchObject({ status: "aborted", outcome: "failed" });
      const d = await post(`${b}/api/tasks`, { cwd: h, title: "d", prompt: "p", runner: "dak" }).then(j);
      await waitFor(async () => c.db.getTask(d.id)?.status === "done");
      await post(`${b}/api/tasks/${d.id}/abort`);
      expect(c.db.getTask(d.id)).toMatchObject({ status: "done", outcome: "unknown" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a reply to a done task starts a new turn: running / unknown, then done", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-reply-"));
    const c = await boot(h, [fakeAdapter(ok, { id: "dak", lingers: true })]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "t", prompt: "p", runner: "dak" }).then(j);
      await waitFor(async () => c.db.getTask(t.id)?.status === "done");
      c.db.updateTask(t.id, { outcome: "done" });
      const sent = await post(`${b}/api/tasks/${t.id}/send`, { text: "again" });
      expect(sent.status).toBe(200);
      await waitFor(async () => c.db.listEvents(t.id).filter((e) => e.ev.t === "session.end").length === 2);
      expect(c.db.getTask(t.id)).toMatchObject({ status: "done", outcome: "unknown" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("every write path lands on the table: runner events, abort, cloud, a daemon restart", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-paths-"));
    const ref = { id: "session_0123456789abcdefghijklmn", url: "https://claude.ai/code/session_0123456789abcdefghijklmn" };
    const failing: AgentEvent[] = [...ok.filter((e) => e.t !== "session.end"), { t: "session.end", status: "error", summary: "boom" }];
    // claude serves both: a Cloud start (executionMode) replays only the session reference
    const adapters = () => {
      const local = fakeAdapter(SCRIPT, { lingers: true });
      const cloudRun = fakeAdapter([{ t: "cloud.session.created", ...ref }]);
      return [{ ...local, start: (o: StartOptions, emit: (ev: AgentEvent) => void) => (o.executionMode === "cloud" ? cloudRun : local).start(o, emit) }, fakeAdapter(failing, { id: "codex" })];
    };
    let c = await boot(h, adapters());
    let b = `http://127.0.0.1:${c.server.port}`;
    const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
    const seen = new Map<string, string[]>();
    try {
      await new Promise<void>((r) => (ws.onopen = () => r()));
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.type !== "task.updated") return;
        const list = seen.get(msg.task.id) ?? [];
        const now = `${msg.task.status}/${msg.task.outcome}`;
        if (list.at(-1) !== now) list.push(now);
        seen.set(msg.task.id, list);
      };
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const create = (runner: RunnerId, extra: object = {}) => post(`${b}/api/tasks`, { cwd: h, title: runner, prompt: "p", runner, ...extra }).then(j);

      // runner events: running → waiting (needs_action) → running → done
      const a = await create("claude");
      await waitFor(async () => (await get(a.id)).status === "waiting");
      expect(await get(a.id)).toMatchObject({ status: "waiting", outcome: "needs_action" });
      await post(`${b}/api/tasks/${a.id}/permission`, { id: "perm1", decision: "allow" });
      await waitFor(async () => (await get(a.id)).status === "done");
      // the WebSocket is a separate channel from GET: wait for its last update before reading the sequence
      await waitFor(async () => seen.get(a.id)?.at(-1) === "done/unknown");
      expect(await get(a.id)).toMatchObject({ status: "done", outcome: "unknown" });
      expect(seen.get(a.id)).toEqual(["running/unknown", "waiting/needs_action", "running/unknown", "done/unknown"]);

      // abort while waiting
      const x = await create("claude");
      await waitFor(async () => (await get(x.id)).status === "waiting");
      await post(`${b}/api/tasks/${x.id}/abort`);
      expect(await get(x.id)).toMatchObject({ status: "aborted", outcome: "failed" });

      // a turn that ends in error
      const e = await create("codex");
      await waitFor(async () => (await get(e.id)).status === "error");
      await waitFor(async () => seen.get(e.id)?.at(-1) === "error/failed");
      expect(await get(e.id)).toMatchObject({ status: "error", outcome: "failed" });
      expect(seen.get(e.id)).toEqual(["running/unknown", "error/failed"]);

      // cloud: running → idle, always unknown
      const cl = await create("claude", { executionMode: "cloud" });
      await waitFor(async () => (await get(cl.id)).status === "idle");
      await waitFor(async () => seen.get(cl.id)?.at(-1) === "idle/unknown");
      expect(await get(cl.id)).toMatchObject({ status: "idle", outcome: "unknown" });
      expect(seen.get(cl.id)).toEqual(["running/unknown", "idle/unknown"]);

      // daemon restart: rows a dead daemon left in flight (no shutdown ran for them)
      const base = c.db.getTask(a.id)!;
      const row = (id: string, extra: Partial<Task>): Task => ({ ...base, id, title: id, status: "running", outcome: "unknown", runnerSessionId: null, resumeAt: null, resumeReason: null, statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), ...extra });
      c.db.insertTask(row("orphan-local", {}));
      c.db.insertTask(row("orphan-cloud", { executionMode: "cloud", cloudSession: ref }));
      ws.close();
      await c.stop();
      c = await boot(h, adapters());
      b = `http://127.0.0.1:${c.server.port}`;
      const local = await fetch(`${b}/api/tasks/orphan-local`).then(j);
      expect(local.task).toMatchObject({ status: "aborted", outcome: "failed" });
      const cloud = await fetch(`${b}/api/tasks/orphan-cloud`).then(j);
      expect(cloud.task).toMatchObject({ status: "idle", outcome: "unknown" });
      expect(c.db.listEvents("orphan-local").at(-1)?.ev).toMatchObject({ t: "session.end", status: "aborted" });
      expect(c.db.listEvents("orphan-cloud").at(-1)?.ev.t).toBe("status");
    } finally {
      ws.close();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an adapter whose start() throws leaves error / failed, for a new task and for a reply to a done one", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-start-fail-"));
    const inner = fakeAdapter(ok, { id: "dak" });
    let fail = false;
    const flaky: RunnerAdapter = { ...inner, start: (o, emit) => { if (fail) throw new Error("boom"); return inner.start(o, emit); } };
    const c = await boot(h, [flaky]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "t", prompt: "p", runner: "dak" }).then(j);
      await waitFor(async () => c.db.getTask(t.id)?.status === "done");
      fail = true;
      const sent = await post(`${b}/api/tasks/${t.id}/send`, { text: "again" });
      expect(sent.status).toBeGreaterThanOrEqual(400);
      expect(c.db.getTask(t.id)).toMatchObject({ status: "error", outcome: "failed" });
      const n = await post(`${b}/api/tasks`, { cwd: h, title: "n", prompt: "p", runner: "dak" });
      expect(n.status).toBeGreaterThanOrEqual(400);
      const rows = c.db.listTasks().filter((x) => x.title === "n");
      expect(rows.map((x) => [x.status, x.outcome])).toEqual([["error", "failed"]]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("a runner that cannot start for lack of file descriptors (#1571)", () => {
  const emfile = () => Object.assign(new Error("EMFILE: too many open files, posix_spawn"), { code: "EMFILE" });
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** A daemon whose runner starts the first `okStarts` times and throws EMFILE after that. */
  const boot = async (okStarts: number) => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-emfile-"));
    const real = fakeAdapter([{ t: "message.delta", role: "assistant", text: "hi", messageId: "m1" }, { t: "session.end", status: "ok" }]);
    let starts = 0;
    const adapter: RunnerAdapter = { ...real, start: (o, emit) => { if (starts++ >= okStarts) throw emfile(); return real.start(o, emit); } };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [adapter], { port: 0 });
    return { h, c, b: `http://127.0.0.1:${c.server.port}` };
  };
  const reasonOf = (c: Awaited<ReturnType<typeof boot>>["c"], id: string) => c.db.listEvents(id).filter((e) => e.ev.t === "error").map((e) => (e.ev as { message: string }).message).pop();

  test("start throws EMFILE on a new task → status error with the reason", async () => {
    const { h, c, b } = await boot(0);
    try {
      const r = await post(`${b}/api/tasks`, { cwd: h, title: "t", prompt: "p", runner: "claude" });
      expect(r.status).toBe(409);
      const t = c.db.listTasks().find((x) => x.title === "t")!;
      expect(t.status).toBe("error");
      expect(reasonOf(c, t.id)).toContain("EMFILE");
      expect(c.tasks.isLive(t.id)).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("start throws EMFILE on a reply → status error with the reason", async () => {
    const { h, c, b } = await boot(1);
    try {
      const t = (await (await post(`${b}/api/tasks`, { cwd: h, title: "t", prompt: "p", runner: "claude" })).json()) as Task;
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const r = await post(`${b}/api/tasks/${t.id}/send`, { text: "again" });
      expect(r.status).toBe(409);
      expect(c.db.getTask(t.id)!.status).toBe("error");
      expect(reasonOf(c, t.id)).toContain("EMFILE");
      expect(c.tasks.isLive(t.id)).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a daemon out of file descriptors: the runner's real Bun.spawn fails and the task ends in error with EMFILE", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-emfile-"));
    const script = `
      import { openSync } from "node:fs";
      import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
      import { startServer } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
      const adapter = {
        id: "claude", detect: async () => ({ available: true }),
        start() { try { for (;;) openSync("/dev/null", "r"); } catch {} Bun.spawn(["true"]); throw new Error("spawned"); },
      };
      const c = await startServer(loadConfig({ SWITCHBOARD_HOME: ${JSON.stringify(h)}, SWITCHBOARD_PORT: "0", ...${JSON.stringify(NO_HISTORY)} }), [adapter], { port: 0, selfdevChecks: false, judge: () => new Promise(() => {}) });
      const base = "http://127.0.0.1:" + c.server.port;
      const r = await fetch(base + "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: ${JSON.stringify(h)}, title: "t", prompt: "p", runner: "claude" }) });
      const t = c.db.listTasks()[0];
      console.log(JSON.stringify({ http: r.status, status: t.status, errors: c.db.listEvents(t.id).filter((e) => e.ev.t === "error").map((e) => e.ev.message), live: c.tasks.isLive(t.id) }));
      await c.stop(); process.exit(0);`;
    const p = Bun.spawn(["bash", "-c", 'ulimit -n 256; exec "$0" -e "$1"', process.execPath, script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, SWITCHBOARD_SUPERVISED: "" } });
    const timer = setTimeout(() => p.kill(), 20_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(timer);
    try {
      const got = JSON.parse(out.trim().split("\n").pop()!) as { http: number; status: string; errors: string[]; live: boolean };
      expect(got).toMatchObject({ http: 409, status: "error", live: false });
      expect(got.errors.join("\n")).toContain("EMFILE");
    } catch (e) {
      throw new Error(`${(e as Error).message}\nstdout: ${out}\nstderr: ${err}`);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  }, 30_000);

  // The adapters rely on Bun.spawn throwing (startOrFail above) rather than hanging when the descriptors run out.
  // This script threw EMFILE on 1.4.2 as well; the hang the 1.4.3 notes describe was not reproduced with it.
  test("Bun.spawn under a low fd limit throws EMFILE instead of hanging", async () => {
    const script = `
      const fds = []; const fs = require("node:fs");
      try { for (let i = 0; i < 64; i++) fds.push(fs.openSync("/dev/null", "r")); } catch {}
      try { Bun.spawn(["true"]); console.log("spawned"); } catch (e) { console.log(e.code); }`;
    const p = Bun.spawn(["bash", "-c", 'ulimit -n 32; exec "$0" -e "$1"', process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 10_000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(timer);
    expect(out.trim()).toBe("EMFILE");
  }, 15_000);
});

describe("ledger: Claude's running totals (#2353)", () => {
  test("each turn books what the session's total grew by, per model; a repeat adds nothing; a new session starts from 0", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ledger-total-"));
    const opus = { t: "usage", source: "reported", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.0, cumulative: true } satisfies AgentEvent;
    const haiku = { t: "usage", source: "reported", model: "claude-haiku-5-5", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, cumulative: true } satisfies AgentEvent;
    const start = { t: "session.start", runner: "claude", runnerSessionId: "s1", cwd: "/tmp" } satisfies AgentEvent;
    // the same array is replayed on every turn: each turn below changes its totals first
    const script: AgentEvent[] = [start, opus, haiku, { t: "session.end", status: "ok" }];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const turns = async (id: string, n: number) => waitFor(async () => (await fetch(`${b}/api/tasks/${id}`).then(j)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "session.end").length === n);
    const rows = (id: string) => c.db.sqlite.query("SELECT model, cost_usd AS c, input_tokens AS i FROM ledger WHERE task_id = ? ORDER BY id").all(id) as Array<{ model: string; c: number; i: number }>;
    try {
      const t = await post("/api/tasks", { cwd: h, title: "totals", prompt: "p", runner: "claude" }).then(j);
      await turns(t.id, 1);
      // turns 2 and 3: Opus grows 1.0 → 1.5 → 2.25; Haiku (a subagent, say) stays at 0.1
      script[1] = { ...opus, costUsd: 1.5, inputTokens: 25 };
      expect((await post(`/api/tasks/${t.id}/send`, { text: "2" })).status).toBe(200);
      await turns(t.id, 2);
      script[1] = { ...opus, costUsd: 2.25, inputTokens: 30 };
      expect((await post(`/api/tasks/${t.id}/send`, { text: "3" })).status).toBe(200);
      await turns(t.id, 3);
      // a result that repeats the totals (nothing was spent) books nothing
      expect((await post(`/api/tasks/${t.id}/send`, { text: "4" })).status).toBe(200);
      await turns(t.id, 4);
      expect(rows(t.id).map((r) => [r.model, r.c, r.i])).toEqual([
        ["claude-opus-5-5", 1.0, 10],
        ["claude-haiku-5-5", 0.1, 5],
        ["claude-opus-5-5", 0.5, 15],
        ["claude-opus-5-5", 0.75, 5],
      ]);
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).cost.costUsd).toBeCloseTo(2.35, 10);
      const models = (await fetch(`${b}/api/ledger/models?days=7`).then(j)) as Array<{ model: string; costUsd: number }>;
      expect(models.map((r) => [r.model, r.costUsd])).toEqual([["claude-opus-5-5", 2.25], ["claude-haiku-5-5", 0.1]]);
      // a new runner session (a resume that could not find the old one) does not carry the old total: 3.0 is all new
      script[0] = { ...start, runnerSessionId: "s2" };
      script[1] = { ...opus, costUsd: 3.0, inputTokens: 40 };
      script.splice(2, 1);
      expect((await post(`/api/tasks/${t.id}/send`, { text: "5" })).status).toBe(200);
      await turns(t.id, 5);
      expect(rows(t.id).at(-1)).toEqual({ model: "claude-opus-5-5", c: 3.0, i: 40 });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a Task whose rows were migrated goes on without counting them again, also when it used two models", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ledger-migrated-"));
    // after the restart the resumed session reports Opus $1.10 and Haiku $0.30; the migrated row was $1.25 of both together
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s1", cwd: "/tmp" },
      { t: "usage", source: "reported", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.1, cumulative: true },
      { t: "usage", source: "reported", model: "claude-haiku-5-5", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3, cumulative: true },
      { t: "session.end", status: "ok" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "migrated", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // stand in for the migration: the rows of the first turn become one migrated row of the session's whole total
      c.db.sqlite.query("DELETE FROM ledger WHERE task_id = ?").run(t.id);
      c.db.sqlite.query(`INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, billed_usd, source, ts, reported_total) VALUES (?, 'claude', 'claude-opus-5-5', 1, 1, 0, 0, 0.25, 0, 'reported', 1, '{"costUsd":1.25,"migrated":true,"session":"s1"}')`).run(t.id);
      expect((await fetch(`${b}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "go on" }) })).status).toBe(200);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "session.end").length === 2);
      // $1.40 now − $1.25 booked = $0.15 new: Opus's $1.10 is all inside the old total, Haiku's $0.30 half of it
      const rows = c.db.sqlite.query("SELECT model, cost_usd AS c FROM ledger WHERE task_id = ? ORDER BY id").all(t.id) as Array<{ model: string; c: number }>;
      expect(rows.map((r) => [r.model, Math.round(r.c * 1e6) / 1e6])).toEqual([["claude-opus-5-5", 0.25], ["claude-opus-5-5", 0], ["claude-haiku-5-5", 0.15]]);
      expect(c.db.taskCost(t.id).costUsd).toBeCloseTo(0.4, 10);
      // the same migrated total under another session (a resume that started over): nothing is counted against it
      expect(c.db.migratedCredit(t.id, "s2")).toBe(0);
      c.db.sqlite.query("UPDATE ledger SET reported_total = json_set(reported_total, '$.session', 's0') WHERE task_id = ? AND json_extract(reported_total, '$.migrated') = 1").run(t.id);
      c.db.sqlite.query("DELETE FROM ledger WHERE task_id = ? AND json_extract(reported_total, '$.migrated') IS NULL").run(t.id);
      expect((await fetch(`${b}/api/tasks/${t.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) })).status).toBe(200);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "session.end").length === 3);
      expect(c.db.taskCost(t.id).costUsd).toBeCloseTo(0.25 + 1.1 + 0.3, 10);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ledger models (#1836)", () => {
  test("GET /api/ledger/models: one row per runner × model in the period, costliest first, Tasks counted (not usage rows), unpriced flagged, totals equal to the daily rows; days is an integer 1..90", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ledger-models-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const now = Date.now();
      const row = (over: Partial<Parameters<typeof c.db.insertLedger>[0]>) => c.db.insertLedger({ taskId: "t1", runner: "claude", model: "claude-opus-5-5", inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "priced", ts: now, ...over });
      row({});
      row({ costUsd: 2, taskId: "t2" }); // the same model from another Task: one row, the sum, 2 Tasks
      row({ costUsd: 0.5 }); // a second usage of the same Task: still 2 Tasks
      row({ model: "claude-haiku-5-5", costUsd: 0.1, inputTokens: 5000 });
      row({ runner: "codex", model: "gpt-6-luna", costUsd: 0.5, billedUsd: 0.5 });
      row({ runner: "codex", model: "gpt-unknown", costUsd: 0, source: "unpriced" });
      row({ model: null, costUsd: 0.2 }); // a usage the runner reported without a model
      row({ costUsd: 9, ts: now - 10 * 24 * 3600 * 1000 }); // outside 7 days, inside 30
      const rows = (await fetch(`${b}/api/ledger/models?days=7`).then(j)) as Array<{ runner: string; model: string | null; tasks: number; tokens: number; costUsd: number; billedUsd: number; unpriced: boolean }>;
      expect(rows.map((r) => [r.runner, r.model, r.tasks, r.costUsd, r.billedUsd, r.unpriced])).toEqual([
        ["claude", "claude-opus-5-5", 2, 3.5, 0, false],
        ["codex", "gpt-6-luna", 1, 0.5, 0.5, false],
        ["claude", null, 1, 0.2, 0, false],
        ["claude", "claude-haiku-5-5", 1, 0.1, 0, false],
        ["codex", "gpt-unknown", 1, 0, 0, true],
      ]);
      const daily = (await fetch(`${b}/api/ledger/daily?days=7`).then(j)) as Array<{ costUsd: number; tokens: number }>;
      expect(rows.reduce((a, r) => a + r.costUsd, 0)).toBeCloseTo(daily.reduce((a, d) => a + d.costUsd, 0), 10);
      expect(rows.reduce((a, r) => a + r.tokens, 0)).toBe(daily.reduce((a, d) => a + d.tokens, 0));
      for (const q of ["?days=0", "?days=91", "?days=abc", "?days=", "?days=1.5"]) expect((await fetch(`${b}/api/ledger/models${q}`)).status).toBe(400);
      expect((await fetch(`${b}/api/ledger/models`)).status).toBe(200); // absent = 7
      const month = (await fetch(`${b}/api/ledger/models?days=30`).then(j)) as Array<{ model: string | null; costUsd: number }>;
      expect(month.find((r) => r.model === "claude-opus-5-5")!.costUsd).toBe(12.5);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops stops (#2092)", () => {
  test("GET /api/ops/stops: closed runs per JST day × cause, cut turns and distinct tasks, the run in progress; days is an integer 1..90", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-stops-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const day = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(ts));
      const today = Date.parse(`${day(Date.now())}T12:00:00+09:00`);
      const yesterday = today - 86_400_000;
      const add = (endedAt: number, reason: string, ids: string[]) => c.db.sqlite.query("INSERT INTO daemon_runs (started_at, ended_at, end_reason, interrupted_task_ids) VALUES (?, ?, ?, ?)").run(endedAt - 1000, endedAt, reason, JSON.stringify(ids));
      add(yesterday, "oomd", ["t1", "t2"]);
      add(today, "oomd", ["t1"]);
      add(today + 60_000, "oomd", ["t1", "t3"]); // the same task cut again: 2 turns, 1 task
      add(today, "promote", []);
      add(today - 40 * 86_400_000, "crash", ["t9"]); // outside 7 days
      const body = OpsStops.parse(await fetch(`${b}/api/ops/stops?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.rows).toEqual([
        { day: day(yesterday), reason: "oomd", stops: 1, turns: 2, taskIds: ["t1", "t2"] },
        { day: day(today), reason: "oomd", stops: 2, turns: 3, taskIds: ["t1", "t3"] },
        { day: day(today), reason: "promote", stops: 1, turns: 0, taskIds: [] },
      ]);
      expect(body.running?.startedAt).toBeGreaterThan(0); // this daemon's own row
      expect(OpsStops.parse(await fetch(`${b}/api/ops/stops?days=90`).then(j)).rows.map((r) => r.reason)).toContain("crash");
      for (const q of ["?days=0", "?days=91", "?days=abc", "?days=", "?days=1.5"]) expect((await fetch(`${b}/api/ops/stops${q}`)).status).toBe(400);
      expect((await fetch(`${b}/api/ops/stops`)).status).toBe(200); // absent = 7
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops latency (#2102)", () => {
  test("GET /api/ops/latency: method × route over the period (largest p90 first) and per JST day (newest first), p50 / p90 / count / bytes p50", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-latency-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const day = (ts: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(ts));
      const today = Date.parse(`${day(Date.now())}T00:30:00+09:00`);
      const yesterday = today - 86_400_000;
      const row = (ts: number, route: string, ms: number, bytes: number | null, method = "GET") => ({ ts, method, route, status: 200, ms, bytes });
      c.db.insertApiRequests([
        // yesterday: the detail is slow
        ...[100, 200, 300, 400, 5000].map((ms, i) => row(yesterday + i, "/api/tasks/:id", ms, 1000 * (i + 1))),
        row(yesterday, "/api/tasks", 5, null),
        // today: faster detail; the list twice, one without bytes
        ...[50, 60].map((ms) => row(today, "/api/tasks/:id", ms, 9000)),
        row(today, "/api/tasks", 7, 300),
        row(today, "/api/tasks", 9, null),
        row(today - 10 * 86_400_000, "/api/old", 99_999, 1), // before the period
      ]);
      const body = OpsLatency.parse(await fetch(`${b}/api/ops/latency?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.total).toEqual([
        { method: "GET", route: "/api/tasks/:id", count: 7, p50: 200, p90: 5000, bytesP50: 4000 },
        { method: "GET", route: "/api/tasks", count: 3, p50: 7, p90: 9, bytesP50: 300 },
      ]);
      expect(body.byDay).toEqual([
        { day: day(today), method: "GET", route: "/api/tasks/:id", count: 2, p50: 50, p90: 60, bytesP50: 9000 },
        { day: day(today), method: "GET", route: "/api/tasks", count: 2, p50: 7, p90: 9, bytesP50: 300 },
        { day: day(yesterday), method: "GET", route: "/api/tasks/:id", count: 5, p50: 300, p90: 5000, bytesP50: 3000 },
        { day: day(yesterday), method: "GET", route: "/api/tasks", count: 1, p50: 5, p90: 5, bytesP50: null },
      ]);
      // one day: only today's
      expect(OpsLatency.parse(await fetch(`${b}/api/ops/latency?days=1`).then(j)).byDay.map((r) => r.day)).toEqual([day(today), day(today)]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("ops load (#2086)", () => {
  test("GET /api/ops/load: JST hours with peaks and limit hits (a unit created again restarts the count), task × kind largest first, ?task= narrows; days is an integer 1..90", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ops-load-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the daemon's own first sample (on a Linux host) is not part of this test
      c.db.sqlite.run("DELETE FROM ops_load");
      c.db.sqlite.run("DELETE FROM ops_load_groups");
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
      const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00+09:00`);
      const row = (ts: number, mem: number, ev: number) =>
        c.db.sqlite.query("INSERT INTO ops_load (ts, mem_current, mem_max, swap_current, events_max, cpu_pct, pressure_some, pressure_full, docker_mem, top) VALUES (?, ?, 3000, 10, ?, 20, 1, 0.5, 700, '[]')").run(ts, mem, ev);
      row(at("10:00"), 2000, 100);
      row(at("10:01"), 2900, 105);
      row(at("10:59"), 2500, 110);
      row(at("11:00"), 1000, 3); // the unit was created again: its count starts over
      row(at("11:01"), 1100, 4);
      const group = (ts: number, task: string | null, owner: string, kind: string, rss: number, cpu: number) =>
        c.db.sqlite.query("INSERT INTO ops_load_groups (ts, task_id, owner, kind, rss, cpu_ms, procs) VALUES (?, ?, ?, ?, ?, ?, 1)").run(ts, task, owner, kind, rss, cpu);
      group(at("10:00"), "t1", "task", "browser", 500, 100);
      group(at("10:01"), "t1", "task", "browser", 700, 200);
      group(at("10:01"), "t1", "task", "runner", 300, 50);
      group(at("10:01"), null, "daemon", "judge", 100, 10);
      group(at("11:00"), "t2", "task", "runner", 900, 5);
      const body = OpsLoad.parse(await fetch(`${b}/api/ops/load?days=7`).then(j));
      expect(body.days).toBe(7);
      expect(body.hours).toEqual([
        { hour: `${day} 10`, maxMem: 2900, memMax: 3000, maxSwap: 10, limitHits: 10, maxCpuPct: 20, maxPressureFull: 0.5, maxDockerMem: 700 },
        { hour: `${day} 11`, maxMem: 1100, memMax: 3000, maxSwap: 10, limitHits: 4, maxCpuPct: 20, maxPressureFull: 0.5, maxDockerMem: 700 },
      ]);
      expect(body.groups).toEqual([
        { taskId: "t2", owner: "task", kind: "runner", maxRss: 900, cpuMs: 5 },
        { taskId: "t1", owner: "task", kind: "browser", maxRss: 700, cpuMs: 300 },
        { taskId: "t1", owner: "task", kind: "runner", maxRss: 300, cpuMs: 50 },
        { taskId: null, owner: "daemon", kind: "judge", maxRss: 100, cpuMs: 10 },
      ]);
      const one = OpsLoad.parse(await fetch(`${b}/api/ops/load?days=7&task=t1`).then(j));
      expect(one.hours).toEqual([]);
      expect(one.groups.map((g) => `${g.taskId}/${g.kind}`)).toEqual(["t1/browser", "t1/runner"]);
      for (const q of ["?days=0", "?days=91", "?days=abc", "?days=1.5"]) expect((await fetch(`${b}/api/ops/load${q}`)).status).toBe(400);
      expect((await fetch(`${b}/api/ops/load`)).status).toBe(200); // absent = 7
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("insights schedule (#1838)", () => {
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("a report /insights writes before the runner reports its session is still this run's: the daemon compares with the Task's creation (#1958)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-insights-"));
    const usage = join(h, "usage-data");
    mkdirSync(usage);
    const report = join(usage, "report.html");
    // like Claude Code's /insights: the command analyses and writes the report first; session.start comes after (slowMs)
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-insights", cwd: h },
      { t: "message.delta", role: "assistant", text: "Your shareable insights report is ready" },
      { t: "session.end", status: "ok" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_USAGE_DATA: usage, ...NO_HISTORY }), [fakeAdapter(script, { slowMs: 300 })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ seq: number; ts: number; ev: AgentEvent }> };
    try {
      const ws = await fetch(`${b}/api/workspaces`).then(j);
      const meta = ws.find((w: { kind: string }) => w.kind === "meta").id;
      const s = await send(`${b}/api/schedules`, "POST", { title: "Claude Code Insights", cron: "30 18 * * 0,3", workspaceId: meta, runner: "claude", action: "insights" }).then(j);
      const t = await send(`${b}/api/schedules/${s.id}/run`, "POST").then(j);
      await Bun.sleep(20);
      writeFileSync(report, "<!doctype html><title>Claude Code Insights</title><h1>Insights</h1>");
      await waitFor(async () => (await get(t.id)).task.status === "done");
      const d = await get(t.id);
      const started = d.events.find((e) => e.ev.t === "session.start")!.ts;
      expect(statSync(report).mtimeMs).toBeLessThan(started); // written before the runner reported its session
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j)).length === 1);
      const lines = (await get(t.id)).events.map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
      expect(lines.some((l) => l.startsWith("レポートを成果物に写しました: Claude Code Insights "))).toBe(true);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("action insights: claude only and no prompt; a firing's Task sends /insights alone, no preamble; the report newer than the Task is its artifact, an old or missing one is a line on the Task; a hot 7-day window skips; no overlap; the usage is in the ledger", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-insights-"));
    const usage = join(h, "usage-data");
    mkdirSync(usage);
    const report = join(usage, "report.html");
    const starts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_USAGE_DATA: usage, ...NO_HISTORY }), [fakeAdapter(SCRIPT, { starts })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    const finish = async (id: string) => {
      // the fixture pauses on its permission.ask; allow it and the turn ends
      await waitFor(async () => (await get(id)).task.status === "waiting");
      const ask = (await get(id)).events.map((e) => e.ev).find((e) => e.t === "permission.ask") as Extract<AgentEvent, { t: "permission.ask" }>;
      await send(`${b}/api/tasks/${id}/permission`, "POST", { id: ask.id, decision: "allow" });
      await waitFor(async () => (await get(id)).task.status === "done");
    };
    const statusLines = async (id: string) => (await get(id)).events.map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
    try {
      const ws = await fetch(`${b}/api/workspaces`).then(j);
      const meta = ws.find((w: { kind: string }) => w.kind === "meta").id;
      expect((await send(`${b}/api/schedules`, "POST", { title: "Claude Code Insights", cron: "30 18 * * 0,3", workspaceId: meta, runner: "codex", prompt: "", action: "insights" })).status).toBe(400);
      const s = await send(`${b}/api/schedules`, "POST", { title: "Claude Code Insights", cron: "30 18 * * 0,3", workspaceId: meta, runner: "claude", action: "insights" }).then(j);
      expect(s).toMatchObject({ action: "insights", runner: "claude", prompt: "" });
      // a prompt schedule still needs its prompt
      expect((await send(`${b}/api/schedules`, "POST", { title: "p", cron: "@nightly", workspaceId: meta, runner: "claude" })).status).toBe(400);
      // a report written "after" the Task starts: its mtime a minute ahead
      writeFileSync(report, "<!doctype html><title>Claude Code Insights</title><h1>Insights</h1>");
      const ahead = Math.floor(Date.now() / 1000) + 60;
      utimesSync(report, ahead, ahead);
      const t1 = await send(`${b}/api/schedules/${s.id}/run`, "POST").then(j);
      expect(t1.title).toMatch(/^Claude Code Insights \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
      expect(t1).toMatchObject({ runner: "claude", scheduleId: s.id });
      const st = starts.at(-1)!;
      expect(st.prompt).toBe("/insights");
      expect(st.preamble).toBeUndefined();
      // while it runs (waiting on the fixture's ask) a second firing is refused
      await waitFor(async () => (await get(t1.id)).task.status === "waiting");
      expect((await send(`${b}/api/schedules/${s.id}/run`, "POST")).status).toBe(409);
      await finish(t1.id);
      const arts = await fetch(`${b}/api/tasks/${t1.id}/artifacts`).then(j);
      expect(arts).toHaveLength(1);
      expect(arts[0]).toMatchObject({ mime: "text/html", kind: "file", entry: "report.html" });
      expect(arts[0].title).toMatch(/^Claude Code Insights \d{4}-\d{2}-\d{2}$/);
      expect((await fetch(`${b}/api/reports`).then(j))[0]).toMatchObject({ id: arts[0].id, scheduleTitle: "Claude Code Insights" });
      expect(await statusLines(t1.id)).toContain(`レポートを成果物に写しました: ${arts[0].title}`);
      // the usage of the turn is in the ledger, and the morning queue lists the run
      expect((await fetch(`${b}/api/ledger/tasks?days=1`).then(j)).some((r: { taskId: string }) => r.taskId === t1.id)).toBe(true);
      expect((await fetch(`${b}/api/queue`).then(j)).scheduled.some((r: { taskId: string; scheduleTitle: string }) => r.taskId === t1.id && r.scheduleTitle === "Claude Code Insights")).toBe(true);
      // an ordinary prompt schedule's Task keeps its preamble
      const p = await send(`${b}/api/schedules`, "POST", { title: "nightly", cron: "@nightly", workspaceId: meta, runner: "claude", prompt: "run the nightly check" }).then(j);
      const t2 = await send(`${b}/api/schedules/${p.id}/run`, "POST").then(j);
      expect(starts.at(-1)!.prompt).toBe("run the nightly check");
      expect(starts.at(-1)!.preamble).toContain("[Switchboard: 止まったときの報告]");
      await finish(t2.id);
      // a report older than the Task is left alone, with the reason on the Task
      const past = Math.floor(Date.now() / 1000) - 3600;
      utimesSync(report, past, past);
      const t3 = await send(`${b}/api/schedules/${s.id}/run`, "POST").then(j);
      await finish(t3.id);
      expect(await fetch(`${b}/api/tasks/${t3.id}/artifacts`).then(j)).toHaveLength(0);
      expect((await statusLines(t3.id)).some((l) => l.includes("この実行の開始より古い"))).toBe(true);
      // no report at all
      rmSync(report);
      const t4 = await send(`${b}/api/schedules/${s.id}/run`, "POST").then(j);
      await finish(t4.id);
      expect(await fetch(`${b}/api/tasks/${t4.id}/artifacts`).then(j)).toHaveLength(0);
      expect((await statusLines(t4.id)).some((l) => l.includes("report.html が無い"))).toBe(true);
      // a follow-up sent to the Task later is an ordinary turn: a report another run makes meanwhile (a terminal's
      // /insights, say — here one newer than anything) is not swept in
      await send(`${b}/api/tasks/${t4.id}/send`, "POST", { text: "続けて" });
      await waitFor(async () => (await get(t4.id)).task.status === "waiting");
      writeFileSync(report, "<h1>another run</h1>");
      utimesSync(report, ahead + 600, ahead + 600);
      await finish(t4.id);
      expect(await fetch(`${b}/api/tasks/${t4.id}/artifacts`).then(j)).toHaveLength(0);
      expect((await statusLines(t4.id)).filter((l) => l.includes("成果物に写しました"))).toHaveLength(0);
      // Claude's 7-day window at the threshold: the firing is skipped and said so in the log; the schedule moved on
      c.db.upsertQuota("claude", "seven_day", 0.95, Math.floor(Date.now() / 1000) + 3600);
      const before = starts.length;
      expect((await send(`${b}/api/schedules/${s.id}/run`, "POST")).status).toBe(409);
      expect(starts.length).toBe(before);
      expect((await fetch(`${b}/api/schedules/log`).then(j)).some((l: string) => l.includes("飛ばした") && l.includes("7 日枠"))).toBe(true);
      // PATCH cannot move it off claude (the route answers every update error as 404)
      expect((await fetch(`${b}/api/schedules/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner: "codex" }) })).status).toBe(404);
      expect((await fetch(`${b}/api/schedules/${s.id}`).then(j)).runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("artifact fence (#1778)", () => {
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const fence = (o: object) => "できました。\n```switchboard-artifact\n" + JSON.stringify(o) + "\n```\n";
  const script = (h: string, reply: string): AgentEvent[] => [
    { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
    { t: "message.delta", role: "assistant", text: reply },
    { t: "session.end", status: "ok", summary: "done" },
  ];

  test("the agent's fence registers the file as the Task's artifact, the preamble says how, the same path again replaces the copy", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "report.html"), "<h1>v1</h1>");
    const starts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, fence({ path: "report.html", title: "週報" })), { starts })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      expect(starts[0]!.preamble).toContain("```switchboard-artifact");
      const arts = await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j);
      expect(arts).toHaveLength(1);
      expect(arts[0]).toMatchObject({ title: "週報", kind: "file", entry: "report.html", mime: "text/html" });
      expect((await get(t.id)).events.map((e) => e.ev).filter((e) => e.t === "artifact.saved")).toEqual([{ t: "artifact.saved", id: arts[0].id, title: "週報" }]);
      expect(readFileSync(join(h, "artifacts", t.id, arts[0].id, "report.html"), "utf8")).toBe("<h1>v1</h1>");
      // a follow-up whose reply names the same path: one artifact, its copy the new content
      writeFileSync(join(h, "report.html"), "<h1>v2</h1>");
      await send(`${b}/api/tasks/${t.id}/send`, "POST", { text: "もう一度" });
      await waitFor(async () => (await get(t.id)).events.filter((e) => e.ev.t === "artifact.saved").length === 2);
      const again = await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j);
      expect(again).toHaveLength(1);
      expect(again[0].id).toBe(arts[0].id);
      expect(readFileSync(join(h, "artifacts", t.id, arts[0].id, "report.html"), "utf8")).toBe("<h1>v2</h1>");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a fence that ends the reply without a newline is read before what ends the reply: its row before the tool row, the stop before 完了 (#1936)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "a.html"), "<h1>a</h1>");
    writeFileSync(join(h, "b.html"), "<h1>b</h1>");
    const stop = { id: "wait-ci", op: "CI を待つ", target: "PR #1", reason: "depends", safety: "read-only", evidence: "CI が走っている", state: "waiting", actions: [{ attempt: 1, what: "待った", ok: null }] };
    const events: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
      { t: "message.delta", role: "assistant", text: "1 つ目。\n```switchboard-artifact\n" + JSON.stringify({ path: "a.html", title: "A" }) + "\n```" },
      { t: "tool.call", id: "c1", name: "Bash", summary: "ls", input: { command: "ls" } },
      { t: "tool.result", id: "c1", ok: true, summary: "" },
      { t: "message.delta", role: "assistant", text: "2 つ目。\n```switchboard-artifact\n" + JSON.stringify({ path: "b.html", title: "B" }) + "\n```\n```switchboard-stop\n" + JSON.stringify(stop) + "\n```" },
      { t: "session.end", status: "ok", summary: "done" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(events)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      const kinds = (await get(t.id)).events.map((e) => e.ev).filter((e) => e.t !== "status" && e.t !== "usage" && e.t !== "quota").map((e) => (e.t === "artifact.saved" ? `artifact:${e.title}` : e.t === "message.delta" ? `delta:${e.role}` : e.t));
      expect(kinds.slice(kinds.indexOf("session.start"))).toEqual(["session.start", "delta:assistant", "artifact:A", "tool.call", "tool.result", "delta:assistant", "artifact:B", "stop.record", "session.end"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an artifact fence that is the reply's last line, right before an ask, is registered before the ask row (#1936)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "d.html"), "<h1>d</h1>");
    const events: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
      { t: "message.delta", role: "assistant", text: "書きます。\n```switchboard-artifact\n" + JSON.stringify({ path: "d.html", title: "D" }) + "\n```" },
      { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: { command: "rm x" }, detail: "rm x" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(events)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "waiting");
      const kinds = (await get(t.id)).events.map((e) => e.ev.t).filter((k) => k === "message.delta" || k === "artifact.saved" || k === "permission.ask");
      expect(kinds).toEqual(["message.delta", "artifact.saved", "permission.ask"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an artifact fence that is the reply's last line, right before session.end, is registered before 完了 (#1936)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "c.html"), "<h1>c</h1>");
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, "できました。\n```switchboard-artifact\n" + JSON.stringify({ path: "c.html", title: "C" }) + "\n```"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      const kinds = (await get(t.id)).events.map((e) => e.ev.t).filter((k) => k === "artifact.saved" || k === "session.end");
      expect(kinds).toEqual(["artifact.saved", "session.end"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("broken JSON and a path outside the scope register nothing and each leave one status line; a quoted example is not read at all", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    const reply = "```switchboard-artifact\n{not json\n```\n" + "例:\n~~~text\n```switchboard-artifact\n" + JSON.stringify({ path: "quoted.html" }) + "\n```\n~~~\n" + fence({ path: "/etc/hostname", title: "外" });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, reply))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      expect(await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j)).toHaveLength(0);
      const refused = (await get(t.id)).events.map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status" && e.text.startsWith("成果物を登録できませんでした"));
      expect(refused.map((r) => r.text)).toEqual([expect.stringContaining("フェンスが読めません: JSON として読めません"), expect.stringContaining("outside this task's scope")]);
      expect((await get(t.id)).events.some((e) => e.ev.t === "artifact.saved")).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
