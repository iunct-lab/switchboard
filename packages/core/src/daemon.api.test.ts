// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@switchboard/protocol";
import { isTempDir, loadConfig } from "./config.ts";
import { abortOrphanedTasks, Db } from "./db.ts";
import { HistoryImporter } from "./history.ts";
import { RateLimitResumer } from "./ratelimit.ts";
import { Scheduler } from "./scheduler.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, core, fakeAdapter, getTask, home, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

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
    expect(db.listTasksWithResume()).toEqual([]); // the auto-resume column exists on an upgraded database too
    expect(db.listHistoryImports()).toEqual([]); // the history imports table exists on an upgraded database too
    // staging from before the diff view (no diff_text / stat): inserts must not fail on the user's real database
    const scols = (db.sqlite.query("PRAGMA table_info(staging)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(scols).toEqual(expect.arrayContaining(["diff_text", "stat"]));
    db.insertStaged({ id: "st1", taskId: "task_old", path: "/tmp/x", rel: "x", kind: "write", before: null, after: "a", status: "pending", ts: 1, decidedAt: null, diff: "+a", stat: "+1 −0" });
    expect(db.listStaged("task_old")[0]).toMatchObject({ id: "st1", diff: "+a", stat: "+1 −0" });
    expect(db.updateTask("task_old", { permissionMode: "plan" })?.permissionMode).toBe("plan");
    // an old database that has Tasks keeps what it sent until now (outbound on); the row did not exist, so only that is written
    expect(db.getSetting("settings", { none: true })).toMatchObject({ outbound: { classifierLog: true, runnerTelemetry: true } });
    expect(db.ledgerSummary().todayUsd).toBeCloseTo(0.5, 6);
    expect(db.ledgerSummary().billedTodayUsd).toBe(0); // historical rows carry no billed figure
    db.close();
  });

  test("a daemon start closes tasks a previous daemon left running / waiting, and reports a temp data directory", async () => {
    const h11 = mkdtempSync(join(tmpdir(), "switchboard-test11-"));
    try {
      // what a crashed / replaced daemon leaves behind
      const pre = new Db(join(h11, "switchboard.db"));
      const now = Date.now();
      const mk = (id: string, status: "running" | "waiting" | "done") => pre.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: h11, scope: [h11], status, runnerSessionId: "sess-" + id, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
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

  test("SWITCHBOARD_REPO_ROOT: the meta workspace is the tree agents edit; the web UI and config defaults come from the running code", () => {
    const here = loadConfig({ SWITCHBOARD_HOME: home });
    expect(here.repoRoot).toBe(here.codeRoot);
    const released = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(home, "checkout") });
    expect(released.repoRoot).toBe(join(home, "checkout"));
    expect(released.codeRoot).toBe(here.codeRoot);
    expect(released.webDist).toBe(join(here.codeRoot, "apps", "web", "dist"));
  });

  test("SWITCHBOARD_REPO_ROOT: shipped defaults are read from the running code, not from the checkout agents edit", async () => {
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

  test("candidate: a daemon started on a copy of the database starts no schedules, resumes or log imports", async () => {
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

  test("promote: a daemon under sb-rescue relays the commit and reports the release; without sb-rescue it says so", async () => {
    expect(await fetch(`${base}/api/daemon/release`).then(j)).toEqual({ managed: false, latestRelease: null });
    expect((await fetch(`${base}/api/daemon/promote`, { method: "POST", body: "{}" })).status).toBe(409);

    const seen: Array<{ path: string; auth: string | null; body: unknown }> = [];
    const history = Array.from({ length: 7 }, (_, i) => ({ ts: i, action: "rejected", from: "a", to: "b", ok: false, reason: `reason ${i}` }));
    const rescue = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : null });
        return path === "/api/status" ? Response.json({ current: "c".repeat(40), running: "d".repeat(40), previous: null, state: "running", busy: null, lastError: "promote: disk full while taking the snapshot", history }) : Response.json({ started: "promote" }, { status: 202 });
      },
    });
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-promote-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}`, SWITCHBOARD_WEB_URL: "https://d1.example.net" }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0, selfdevChecks: false, promotionAskedPollMs: 20 });
    const url = `http://127.0.0.1:${c.server.port}`;
    try {
      const rel = await fetch(`${url}/api/daemon/release`).then(j);
      expect(rel).toMatchObject({ managed: true, rescuePage: "https://d1.example.net/rescue/", current: "c".repeat(40), running: "d".repeat(40), state: "running", busy: null, lastError: "promote: disk full while taking the snapshot" }); // a failure outside the history still reaches the UI
      expect(rel.head).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof rel.dirty).toBe("boolean");
      expect(rel.history.map((x: { reason: string }) => x.reason)).toEqual(["reason 0", "reason 1", "reason 2", "reason 3", "reason 4"]);

      const ok = await fetch(`${url}/api/daemon/promote`, { method: "POST", body: "{}" });
      expect(ok.status).toBe(202);
      expect(await ok.json()).toEqual({ started: "promote", commit: rel.head });
      expect(seen.at(-1)).toMatchObject({ path: "/api/promote", body: { commit: rel.head } });
      expect(seen.at(-1)!.auth).toBe(`Bearer ${readFileSync(join(h, "token"), "utf8").trim()}`);

      // from the request on new starts are held; this sb-rescue is not busy, so the promotion ended without a restart and the hold is let go
      expect((await fetch(`${url}/api/health`).then(j)).promotionDrain).toMatchObject({ asked: expect.any(Number) });
      for (const t0 = Date.now(); (await fetch(`${url}/api/health`).then(j)).promotionDrain !== null && Date.now() - t0 < 10_000; ) await Bun.sleep(10);
      expect((await fetch(`${url}/api/health`).then(j)).promotionDrain).toBeNull();
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

  test("promote: release counts the commits between the running version and HEAD (ahead, behind) and the running tasks", async () => {
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
      expect(await rel()).toMatchObject({ head, headSubject: "second: the head", ahead: 0, behind: 0, busyTasks: 0 });
      current = first;
      expect(await rel()).toMatchObject({ ahead: 1, behind: 0 });
      git("commit", "-q", "--allow-empty", "-m", "third");
      current = git("rev-parse", "HEAD");
      git("reset", "-q", "--hard", head); // HEAD is now inside the running version
      expect(await rel()).toMatchObject({ ahead: 0, behind: 1 }); // the running version is ahead of HEAD
      current = "d".repeat(40);
      expect(await rel()).toMatchObject({ ahead: null, behind: null });
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
    // run inside a Switchboard Task it inherits SWITCHBOARD_SUPERVISED=1, so unset it for this call only
    const supervised = process.env.SWITCHBOARD_SUPERVISED;
    delete process.env.SWITCHBOARD_SUPERVISED;
    try {
      const dry = await fetch(`${base}/api/daemon/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) }).then(j);
      expect(dry.restarting).toBe(false);
      expect(dry.supervised).toBe(false);
      expect(dry.argv[0]).toBe(process.execPath);
    } finally {
      if (supervised === undefined) delete process.env.SWITCHBOARD_SUPERVISED;
      else process.env.SWITCHBOARD_SUPERVISED = supervised;
    }
  });
});
