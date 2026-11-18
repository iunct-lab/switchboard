// test-reads: packages/core/src/config.ts packages/core/src/server.ts packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, StartOptions, Task } from "@switchboard/protocol";
import { TaskSummary } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { abortOrphanedTasks, Db } from "./db.ts";
import { NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("task outcome", () => {
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

      // (d) a turn that ends ok → unknown (the judge reads the reply)
      const d = await create("dak", "ok");
      await waitFor(async () => (await get(d.id)).status === "done");
      expect(await get(d.id)).toMatchObject({ outcome: "unknown", reviewedAt: null });

      // (e) reviewed, then a reply starts a new turn → not reviewed, unknown again
      c.db.updateTask(d.id, { reviewedAt: 1234, outcome: "finished" });
      expect(await get(d.id)).toMatchObject({ outcome: "finished", reviewedAt: 1234 });
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
      const mk = (id: string, status: Task["status"]) => db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: h, scope: [h], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      mk("t1", "running");
      expect(db.updateTask("t1", { status: "waiting" })?.outcome).toBe("needs_action");
      expect(db.updateTask("t1", { status: "done", outcome: "finished" })?.outcome).toBe("finished");
      mk("t3", "running");
      db.updateTask("t3", { status: "done", outcome: "finished" });
      expect(db.updateTask("t3", { status: "done", title: "same status" })?.outcome).toBe("finished");
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
      const done = (await set({ outcome: "finished" }).then(j)).task as Task;
      expect(done.outcome).toBe("finished");
      expect(done.reviewedAt).not.toBeNull();
      expect((await set({ outcome: "needs_action" }).then(j)).task).toMatchObject({ outcome: "needs_action", reviewedAt: null });
      await set({ reviewed: true });
      // failed is not set by hand (it comes from the status): 400
      expect((await set({ outcome: "failed" })).status).toBe(400);
      await set({ reviewed: false });
      const both = (await set({ outcome: "needs_action", reviewed: true }).then(j)).task as Task;
      expect(both.outcome).toBe("needs_action");
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

  test("GET /api/tasks returns only the list fields", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-list-fields-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await post(`${b}/api/tasks`, { cwd: h, title: "ok", prompt: "p", runner: "dak" });
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const keys = Object.keys(TaskSummary.shape).sort();
      const listed = (await fetch(`${b}/api/tasks`).then(j)) as Array<Record<string, unknown>>;
      expect(listed.map((x) => x.id)).toEqual([t.id]);
      expect(Object.keys(listed[0]!).sort()).toEqual(keys);
      expect(listed[0]).not.toHaveProperty("routing");
      expect(listed[0]).not.toHaveProperty("scope");
      expect(listed[0]).not.toHaveProperty("permissionMode");
      // the detail still carries them
      expect((await fetch(`${b}/api/tasks/${t.id}`).then(j)).task).toHaveProperty("scope");
      await fetch(`${b}/api/tasks/${t.id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
      const archived = (await fetch(`${b}/api/tasks?archived=1`).then(j)) as Array<Record<string, unknown>>;
      expect(archived.map((x) => x.id)).toEqual([t.id]);
      expect(Object.keys(archived[0]!).sort()).toEqual(keys);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("POST /api/tasks/:id/archive: a stopped Task leaves GET /api/tasks and shows under ?archived=1, comes back on false; a reply brings it back; 409 / 400 / 404", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-archive-api-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const ids = async (q = "") => ((await fetch(`${b}/api/tasks${q}`).then(j)) as TaskSummary[]).map((t) => t.id);
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

  test("POST /api/tasks/:id/outcome: a failed or waiting Task's outcome comes from its status and an idle one stores none, so setting one is 409 and the Task is unchanged; reviewed alone still works", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-outcome-409-"));
    const c = await daemon(h);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const set = (id: string, body: unknown) => fetch(`${b}/api/tasks/${id}/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const e = await post(`${b}/api/tasks`, { cwd: h, title: "err", prompt: "p", runner: "codex" });
      await waitFor(async () => (await get(e.id)).status === "error");
      const a = await post(`${b}/api/tasks`, { cwd: h, title: "ask", prompt: "p", runner: "claude" });
      await waitFor(async () => (await get(a.id)).status === "waiting");
      for (const [id, shown] of [[e.id, "failed"], [a.id, "needs_action"]] as const) {
        for (const outcome of ["finished", "needs_action", "unknown"]) expect((await set(id, { outcome })).status).toBe(409);
        expect(await get(id)).toMatchObject({ outcome: shown });
      }
      expect((await set(e.id, { reviewed: true })).status).toBe(200);
      expect(await get(e.id)).toMatchObject({ outcome: "failed" });
      const d = await post(`${b}/api/tasks`, { cwd: h, title: "ok", prompt: "p", runner: "dak" });
      await waitFor(async () => (await get(d.id)).status === "done");
      expect((await set(d.id, { outcome: "finished" })).status).toBe(200);
      // a status that stores only unknown (idle: a reply waits for a run slot) refuses a person's outcome too
      c.db.insertTask({ ...c.db.getTask(d.id)!, id: "task_idle_outcome", status: "idle", outcome: "unknown" });
      expect((await set("task_idle_outcome", { outcome: "finished" })).status).toBe(409);
      expect(await get("task_idle_outcome")).toMatchObject({ outcome: "unknown" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("migrate(): tasks that stopped before reviewedAt existed are reviewed (reviewedAt = updatedAt), running / waiting / idle ones are not", () => {
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
      expect(db.getTask("t_err")).toMatchObject({ outcome: "failed", reviewedAt: 200 }); // shown from the status; the column stays unknown
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

describe("task status transitions", () => {
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
      c.db.updateTask(t.id, { outcome: "finished" });
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
      const row = (id: string, extra: Partial<Task>): Task => ({ ...base, id, title: id, status: "running", outcome: "unknown", runnerSessionId: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), ...extra });
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

describe("a runner that cannot start for lack of file descriptors", () => {
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
