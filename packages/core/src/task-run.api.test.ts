// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, RunnerAdapter, StartOptions } from "@switchboard/protocol";
import { Database } from "bun:sqlite";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { measureFootprint } from "./footprint.ts";
import { seedNewHome } from "./server.ts";
import { makePrivateTmp, privateTmpOf, sweepPrivateTmps } from "./tasks/sessions.ts";
import { TaskManager } from "./tasks/manager.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, fakeAdapter, getTask, home, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
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

  test("GET /api/tasks/:id?after= returns only the events past the cursor, in seq order", async () => {
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

  test("events tail: GET /api/tasks/:id holds the last `limit` events (200 by default), ?before= the page before, ?limit=0 none; ?after= stays whole", async () => {
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
      expect({ createdIssues: tail.createdIssues, deferred: tail.deferred }).toEqual({ createdIssues: [], deferred: false }); // counted from the events, none here
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

      // the catch-up after a dropped WebSocket is never cut: everything past the cursor
      const past = all.slice(11).map((e) => e.seq);
      expect(seqs(await get(`?after=${all[10]!.seq}`))).toEqual(past);
      for (const with_ of ["&limit=0", "&limit=50", "&before=abc", "&before=5"]) expect(seqs(await get(`?after=${all[10]!.seq}${with_}`))).toEqual(past);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("api_requests: each guardAll route's time and size are written by the route's key, flushed on stop", async () => {
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

  test("api_requests: a failed write is dropped with one warning, not thrown out of the daemon", async () => {
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
    // the idle window (it was flaky at 60 ms): at 60 ms a loaded host left it between "done" and the next request, so the
    // window is long enough for those steps and the release is waited for by its state, not a fixed sleep
    const released = async (id: string) => { for (const t0 = Date.now(); c2.tasks.isLive(id) && Date.now() - t0 < 20_000; ) await Bun.sleep(10); };
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-test2-"));
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_RUNNER_IDLE_MS: "2000" }), [fakeAdapter(script, { lingers: true, starts })], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      const t = await fetch(`${b2}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h2, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(starts.length).toBe(1);
      // idle timer fires → process released; status must stay "done"
      await released(t.id);
      expect(c2.tasks.isLive(t.id)).toBe(false);
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
      await released(t.id);
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
  }, 30_000); // two idle windows of 2 s and HTTP turns under a loaded full suite: over the 5 s default (docs/design/perf.md "Test flakiness")

  test.skipIf(skipRecordings("packages/core/fixtures/otel-tool-decision.jsonl"))("otel: a recorded tool_decision is kept on its task; another task's token or none is refused", async () => {
    assertRecordings("packages/core/fixtures/otel-tool-decision.jsonl");
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-otel-"));
    // waits on its permission: the runner stays live, as a Claude Task's does while it sends its logs
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { starts })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outbound: { classifierLog: true } }) }); // off by default
      const make = async () => {
        const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "waiting");
        return t.id as string;
      };
      const [a, other] = [await make(), await make()];
      // the runner was handed this task's loopback endpoint and its MCP token
      const otel = starts[0]!.otel!;
      expect(otel.endpoint).toBe(`${b}/otel/${a}/v1/logs`);
      expect(otel.token).toBe((await fetch(`${b}/api/tasks/${a}/mcp`).then(j)).token);
      const decisions = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "classifier.decision").map((e: { ev: AgentEvent }) => e.ev);
      const post = (url: string, token: string | null, body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });
      const bodies = recordingText("packages/core/fixtures/otel-tool-decision.jsonl").split("\n").filter(Boolean);
      // refused: no token, another task's token, a token for a task id that is not live
      expect((await post(otel.endpoint, null, bodies[0]!)).status).toBe(401);
      expect((await post(otel.endpoint, starts[1]!.otel!.token, bodies[0]!)).status).toBe(401);
      expect((await post(`${b}/otel/task_missing/v1/logs`, otel.token, bodies[0]!)).status).toBe(401);
      expect(await decisions(a)).toEqual([]);
      for (const body of bodies) {
        const r = await post(otel.endpoint, otel.token, body);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({});
      }
      const kept = await decisions(a);
      expect(kept).toEqual([
        { t: "classifier.decision", verdict: "allow", category: null, mode: "auto", tool: "Bash", callId: "toolu_01L47zDvGwTxxnUozu6wRw3i" },
        { t: "classifier.decision", verdict: "allow", category: null, mode: "auto", tool: "Bash", callId: "toolu_017Msxt4uRZEmeMjRktb9xKf" },
        { t: "classifier.decision", verdict: "allow", category: null, mode: "auto", tool: "Bash", callId: "toolu_016MAaEHraUYzLu1i3UjHXmg" },
      ]);
      // nothing else of the body is kept (the account, the other events)
      expect(JSON.stringify((await fetch(`${b}/api/tasks/${a}`).then(j)).events)).not.toContain("dev@example.com");
      expect(await decisions(other)).toEqual([]);
      // the rules row counts them right away, not at the next turn's end
      expect((await fetch(`${b}/api/tasks/${a}/evals`).then(j)).rules.metrics.classifier).toEqual({ allowed: 3, denied: 0, byCategory: {} });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("otel: a released runner's last batch is kept while it closes; once it has closed the token is gone", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-otel-close-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts, lingers: true, closeMs: 400 })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const batch = (callId: string) => JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [{ key: "event.name", value: { stringValue: "tool_decision" } }, { key: "classifier_verdict", value: { stringValue: "allow" } }, { key: "tool_name", value: { stringValue: "Bash" } }, { key: "tool_use_id", value: { stringValue: callId } }] }] }] }] });
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ outbound: { classifierLog: true } }) }); // off by default
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const { endpoint, token } = starts[0]!.otel!;
      const post = (callId: string) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: batch(callId) });
      const closed = c.tasks.release(t.id);
      expect(c.tasks.isLive(t.id)).toBe(false);
      expect((await post("toolu_closing")).status).toBe(200);
      await closed;
      expect((await post("toolu_after")).status).toBe(401);
      const ids = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "classifier.decision").map((e: { ev: { callId: string } }) => e.ev.callId);
      expect(ids).toEqual(["toolu_closing"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("developSelf: a new HOME starts with false, PATCH saves it, an existing database is not written", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-developself-"));
    const env = { SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY };
    try {
      // no database yet: seeded with false
      seedNewHome(loadConfig(env).dbPath);
      let c = await startServer(loadConfig(env), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
      let b = `http://127.0.0.1:${c.server.port}`;
      expect((await fetch(`${b}/api/settings`).then(j)).developSelf).toBe(false);
      expect((await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ developSelf: true }) })).status).toBe(200);
      await c.stop();
      // a database that exists is left alone: the saved true stays, and so would a missing key (reads as true)
      seedNewHome(loadConfig(env).dbPath);
      c = await startServer(loadConfig(env), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
      b = `http://127.0.0.1:${c.server.port}`;
      expect((await fetch(`${b}/api/settings`).then(j)).developSelf).toBe(true);
      await c.stop();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
    // a database made without the seed (every other test, an owner's existing one): the key is absent = true
    const h2 = mkdtempSync(join(tmpdir(), "switchboard-test-developself-"));
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      expect((await fetch(`http://127.0.0.1:${c2.server.port}/api/settings`).then(j)).developSelf).toBe(true);
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });

  test("outbound: otel is passed only when classifierLog is on; runnerTelemetry follows its own value", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-outbound-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = async () => {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      return starts.at(-1)!;
    };
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).outbound).toEqual({ classifierLog: false, runnerTelemetry: false });
      const off = await run();
      expect(off.otel).toBeUndefined();
      expect(off.runnerTelemetry).toBe(false);
      expect((await patch({ outbound: { classifierLog: true } })).status).toBe(200);
      expect((await fetch(`${b}/api/settings`).then(j)).outbound).toEqual({ classifierLog: true, runnerTelemetry: false });
      const on = await run();
      expect(on.otel!.endpoint).toContain("/v1/logs");
      expect(on.runnerTelemetry).toBe(false);
      expect((await patch({ outbound: { runnerTelemetry: true } })).status).toBe(200);
      expect((await run()).runnerTelemetry).toBe(true);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("gh guard: every runner starts with the kit's bin first in its PATH, whatever the task's folder", async () => {
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

  test("private tmp: a Codex task in a registered repo gets its own temp directory, kept while done; a symlink in its place stops the start", async () => {
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

  test("heavy slots: a Codex task's sandbox can write the heavy slots' directory; a Claude task's scope is unchanged", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-heavyslots-"));
    const checkout = join(h, "checkout");
    mkdirSync(checkout);
    const slots = join(h, "user", ".local", "state", "ops-kit", "heavy"); // not made yet
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { id: "codex", starts }), fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { starts })], { port: 0, selfdevChecks: false, heavyStateDir: slots });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const ids: string[] = [];
      for (const runner of ["codex", "claude"]) {
        const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: checkout, title: "t", prompt: "p", runner }) }).then(j);
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
        ids.push(t.id);
      }
      // and the directory its `ops-kit wait` records go to, so the screen can say what a sandboxed Task waits for
      expect(starts.map((s) => s.scope)).toEqual([[checkout, slots, join(h, "waits")], [checkout]]);
      expect(existsSync(slots)).toBe(true); // made before the start, so the sandbox has a directory to open
      expect(ids.map((id) => c.db.getTask(id)?.scope)).toEqual([[checkout], [checkout]]); // only the start's scope, never the saved one
    } finally {
      await c.stop();
    }
    // cannot be made (a file in the way): not added, one line on the task, and the task still runs
    writeFileSync(join(h, "file"), "");
    const blocked = join(h, "file", "heavy");
    const more: StartOptions[] = [];
    const h2 = join(h, "second");
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_REPO_ROOT: checkout }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"), { id: "codex", starts: more })], { port: 0, selfdevChecks: false, heavyStateDir: blocked });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      const t = await fetch(`${b2}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: checkout, title: "t", prompt: "p", runner: "codex" }) }).then(j);
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(more.map((s) => s.scope)).toEqual([[checkout, join(h2, "waits")]]);
      expect(c2.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith(`重い処理の枠の置き場をサンドボックスで書ける場所に足せませんでした: ${blocked}`))).toBe(true);
    } finally {
      await c2.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("private tmp: a Codex task without the meta workspace gets none; the sweep removes only old ones the database lets go", async () => {
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

  test("shared tmp guard: every runner gets the kit's deny-shared-tmp as a guard, none without the meta workspace", async () => {
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
      // the skills' operations as allow rules: the merge gate of this checkout and of the task's own folder
      expect(starts.map((s) => s.allow?.filter((r) => r.includes("merge-gate")))).toEqual([checkout, other].map(() => ["Bash(bun scripts/merge-gate.ts:*)", `Bash(bun ${checkout}/scripts/merge-gate.ts:*)`]));
      expect(starts[1]!.allow).toContain(`Edit(/${other}/ops-kit/skills/**)`);
      expect(starts[1]!.allow).toContain(`Write(/${other}-*/.claude/skills/**)`);
      expect(starts[1]!.allow).toContain("Bash(gh stack push:*)"); // the same for a folder other than the checkout
      expect(starts[1]!.allow).toContain("Bash(ops-kit backlog:*)");
      expect(starts.flatMap((s) => s.allow ?? []).filter((r) => /gh (pr|stack) merge|gh api/.test(r))).toEqual([]);
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
      expect(bare.map((s) => s.allow)).toEqual([undefined]);
      // the fake turn writes to the Db after create returns: close only once it is over
      await waitFor(async () => db.getTask(t.id)?.status === "done");
      await tasks.shutdown();
    } finally {
      db.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("mcp servers: mcp.yaml servers reach the runner, the ones with workspaces only in those Workspaces' Tasks", async () => {
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
      // the task detail names them for the Brief
      expect(named).toEqual([["playwright", "docs"], ["docs"]]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a resume whose session record is not on this machine starts a new session with the transcript as a preamble", async () => {
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
      // the record is here: an ordinary --resume, no recap, and nothing the session was already told at its start
      await send(t.id, "again");
      expect(starts[1]).toMatchObject({ resumeSessionId: "sess-1", prompt: "again" });
      expect(starts[1]?.preamble).toBeUndefined();
      await waitFor(async () => (await fetch(`${b2}/api/tasks/${t.id}`).then(j)).task.status === "done");
      // the record is gone (the task came from another machine): a new session, told what happened so far
      here = false;
      const sent = await send(t.id, "状況は？");
      expect(sent.status).toBe("running");
      expect(starts[2]?.resumeSessionId).toBeUndefined();
      expect(starts[2]?.prompt).toBe("状況は？"); // the user's message stays as typed
      expect(starts[2]?.preamble).toContain("エージェント: done");
      expect(starts[2]?.preamble).toStartWith("[Switchboard: 止まったときの報告]"); // a new session is told how to report a stop again
      expect(starts[2]?.preamble).toEndWith("利用者の今回のメッセージ:");
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

  test("GET /api/tasks/:id/footprint measures the task's scope; an unknown task is 404", async () => {
    const dir = join(home, "footprint-cwd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.txt"), "x".repeat(400));
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "fp", prompt: "p", runner: "claude" }) }).then(j);
    const r = await fetch(`${base}/api/tasks/${t.id}/footprint`);
    expect(r.status).toBe(200);
    const fp = await j(r);
    expect(fp.files).toBeGreaterThanOrEqual(1);
    expect(fp.bytes).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/tasks/task_nope/footprint`)).status).toBe(404);
    // finish the task: a waiting task left on the shared daemon makes later restart checks see a running task
    await waitFor(async () => (await getTask(t.id)).task.status === "waiting");
    const ask = (await getTask(t.id)).events.map((e: { ev: AgentEvent }) => e.ev).find((e: AgentEvent) => e.t === "permission.ask");
    await fetch(`${base}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "allow" }) });
    await waitFor(async () => (await getTask(t.id)).task.status === "done");
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
});
