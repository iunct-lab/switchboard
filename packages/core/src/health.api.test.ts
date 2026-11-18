// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerDetection, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { isAuthText } from "./login.ts";
import { loadProcess } from "./process-defs.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("health lists runners and registers this repo as the meta workspace", async () => {
    const h = await fetch(`${base}/api/health`).then(j);
    expect(h.ok).toBe(true);
    expect(h.runners[0]).toMatchObject({ id: "claude", available: true });
    const ws = await fetch(`${base}/api/workspaces`).then(j);
    expect(ws.some((w: { kind: string }) => w.kind === "meta")).toBe(true);
  });

  test("provenance: a task created with a process records it with the bundle hashes, GET /api/processes lists the candidates", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-prov-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const post = (body: object) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "p", prompt: "explain", cwd: h, ...body }) });
      expect((await post({ process: "nope" })).status).toBe(400);
      const r = await post({ process: "p0-pipeline", processReason: "test" });
      expect(r.status).toBe(201);
      const t = await j(r);
      const prov = await fetch(`${b}/api/tasks/${t.id}/provenance`).then(j);
      expect(prov).toMatchObject({ v: 1, process: { id: "p0-pipeline", version: 1 }, processReason: "test", runner: "claude", repo: { head: null } });
      expect(prov.bundle.skills).toMatch(/^[0-9a-f]{64}$/); // the meta workspace's ops-kit/skills
      expect(prov.bundle.processes).toMatch(/^[0-9a-f]{64}$/);
      expect(prov.bundle.claudeMd).toBeNull(); // cwd is an empty folder
      expect(prov.instructionBytes).toBe(0);
      // without a process: still recorded, process null
      const t2 = await j(await post({}));
      expect(await fetch(`${b}/api/tasks/${t2.id}/provenance`).then(j)).toMatchObject({ process: null, processReason: null, runner: "claude" });
      expect((await fetch(`${b}/api/tasks/task_missing/provenance`)).status).toBe(404);
      const procs = await fetch(`${b}/api/processes`).then(j);
      expect(procs.map((p: { id: string }) => p.id)).toContain("p0-pipeline");
      const p0 = loadProcess("p0-pipeline");
      expect(procs.find((p: { id: string }) => p.id === "p0-pipeline")).toMatchObject({ version: p0.version, title: p0.title, fits: p0.fits });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health lists the running and waiting tasks as busyTasks, and not the done ones", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-busy-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-test-busy-off-"));
    const off = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_HOST: "0.0.0.0" }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      const now = Date.now();
      const mk = (id: string, status: "running" | "waiting" | "done" | "background") => c.db.insertTask({ id, workspaceId: null, title: `title ${id}`, runner: "claude", cwd: h, scope: [h], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      mk("task_busy_run", "running");
      mk("task_busy_wait", "waiting");
      mk("task_busy_done", "done");
      mk("task_busy_bg", "background");
      c.db.setTaskBackground("task_busy_bg", { jobs: ["Recheck"], since: now });
      const busy = (await fetch(`http://127.0.0.1:${c.server.port}/api/health`).then(j)).busyTasks;
      expect(busy.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id))).toEqual([
        { id: "task_busy_bg", title: "title task_busy_bg", status: "background" },
        { id: "task_busy_run", title: "title task_busy_run", status: "running" },
        { id: "task_busy_wait", title: "title task_busy_wait", status: "waiting" },
      ]);
      // without the token, off loopback: not listed
      const b2 = `http://127.0.0.1:${off.server.port}`;
      expect((await fetch(`${b2}/api/health`).then(j)).busyTasks).toBeUndefined();
      expect((await fetch(`${b2}/api/health`, { headers: { authorization: `Bearer ${off.token}` } }).then(j)).busyTasks).toEqual([]);
    } finally {
      await c.stop();
      await off.stop();
      rmSync(h, { recursive: true, force: true });
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("effort: health lists each runner's efforts; a task keeps the chosen one and hands it to the adapter; unknown is 400", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-effort-"));
    // a database from before the effort column: its tasks table has no effort column
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

  test("the inbox endpoints are gone: every /api/inbox path is 404, and so is any API path no route takes", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-inbox-gone-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      expect((await fetch(`${b}/api/inbox`)).status).toBe(404);
      for (const path of ["/api/inbox", "/api/inbox/close", "/api/inbox/edit", "/api/inbox/promote"]) {
        const r = await fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", path: "notes/x.md" }) });
        expect([path, r.status]).toEqual([path, 404]);
      }
      expect((await fetch(`${b}/api/no-such-route`)).status).toBe(404);
      // what is not an API path still gets the web UI (or the note that it is not built)
      expect((await fetch(`${b}/settings`)).status).toBe(200);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health lists each runner's models and what the CLI runs on when the model is left empty", async () => {
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

  test("promote and restart wait for a Task whose turn ended on background jobs, and go once it is done", async () => {
    const seen: string[] = [];
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(new URL(req.url).pathname); return Response.json({ started: "promote" }, { status: 202 }); } });
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-bgpromote-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH, dryRunRestart: true });
    const url = `http://127.0.0.1:${c.server.port}`;
    try {
      const now = Date.now();
      c.db.insertTask({ id: "task_bg_gate", workspaceId: null, title: "bg", runner: "claude", cwd: h, scope: [h], status: "background", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      expect((await fetch(`${url}/api/daemon/promote`, { method: "POST", body: "{}" })).status).toBe(409);
      expect((await fetch(`${url}/api/daemon/restart`, { method: "POST", body: "{}" })).status).toBe(409);
      expect(seen).toEqual([]);
      c.db.updateTask("task_bg_gate", { status: "done" });
      expect((await fetch(`${url}/api/daemon/promote`, { method: "POST", body: "{}" })).status).toBe(202);
    } finally {
      await c.stop();
      await rescue.stop(true);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health follows the runner's note on the login recheck: a Codex updated while the daemon runs is warned about without a restart", async () => {
    let note: string | undefined;
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-note-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { detect: () => ({ login: "ok" as const, note }) })], { port: 0 });
    const runners = () => fetch(`http://127.0.0.1:${c.server.port}/api/health`).then(j).then((x) => x.runners);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      expect((await runners())[0].note).toBeUndefined();
      note = "warned";
      offset += 61_000; await runners(); // over the minute this answer starts the check behind it; the next carries it
      expect((await runners())[0].note).toBe("warned");
      note = undefined;
      offset += 61_000; await runners();
      expect((await runners())[0].note).toBeUndefined();
    } finally {
      clock.mockRestore();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("health shows each runner's login: the status command's answer, rechecked when over a minute old; a turn's auth error marks it expired", async () => {
    let login: RunnerDetection["login"] = "expired";
    let detects = 0;
    let loginExpiresAt: number | undefined = 1_800_000_000_000;
    const detect = () => (detects++, { login, loginHint: "fake login", loginExpiresAt });
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
      offset += 61_000; await runners(); // over the minute this answer starts the check behind it; the next carries it
      expect((await runners())[0]).toMatchObject({ login: "ok", loginExpiresAt: 1_800_000_000_000 });
      expect(detects).toBe(2);
      // the status command still says ok, but a turn ended on the runner's auth error: expired, with what to type
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "error");
      expect((await runners())[0].login).toBe("expired");
      expect((await runners())[0].loginExpiresAt).toBeUndefined(); // no expiry beside "expired"
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text.includes("`fake login`"))).toBe(true);
      // the next check that says ok clears it, with the expiry it reads now
      loginExpiresAt = 1_900_000_000_000;
      offset += 61_000; await runners();
      expect((await runners())[0]).toMatchObject({ login: "ok", loginExpiresAt: 1_900_000_000_000 });
      loginExpiresAt = undefined;
      offset += 61_000; await runners();
      expect((await runners())[0].loginExpiresAt).toBeUndefined();
      // a turn that goes through clears expired, even when the last status-command answer (within the minute) said so
      login = "expired";
      offset += 61_000; await runners();
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

  test("isAuthText matches the runners' not-logged-in errors, not their usage limits or other failures", () => {
    expect(isAuthText("claude", "Invalid API key · Please run /login")).toBe(true);
    expect(isAuthText("claude", "OAuth token has expired. Please obtain a new token or refresh your existing token.")).toBe(true);
    expect(isAuthText("codex", "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.")).toBe(true);
    expect(isAuthText("claude", "You've hit your session limit · resets 4:10am (Asia/Tokyo)")).toBe(false);
    expect(isAuthText("codex", "stream error: 429 Too Many Requests")).toBe(false);
    expect(isAuthText("codex", "stream error: unexpected status 401 Unauthorized")).toBe(true);
    expect(isAuthText("codex", "Failed to refresh token: connection timed out")).toBe(false); // the network, not the login
    expect(isAuthText("dak", "Not logged in")).toBe(false); // DAK has no login of its own
  });
});
