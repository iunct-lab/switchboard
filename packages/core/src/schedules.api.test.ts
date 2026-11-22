// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Schedule, ScheduleSampleInfo, StartOptions, Task, Workspace } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { PROVISIONED_KEY, SAMPLES_KEY, SCHEDULE_SAMPLES, SECRET_SCAN, UI_LAYERS_CHECK_PROMPT } from "./scheduleSamples.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, core, fakeAdapter, getTask, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("schedules API: create, validate, run manually, and list; queue reflects the result", async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // a repo workspace is registered too, and it sorts before the meta one (kind DESC), so the meta one is picked by its kind
    const repoDir = mkdtempSync(join(tmpdir(), "switchboard-sched-repo-"));
    core.db.upsertWorkspace({ id: "ws_sched_repo", name: "sched-repo", path: repoDir, kind: "repo" });
    try {
      const ws = await fetch(`${base}/api/workspaces`).then(j);
      expect(ws[0].kind).toBe("repo");
      const meta = ws.find((w: { kind: string }) => w.kind === "meta");
      const wsId = meta.id;
      const bad = await post("/api/schedules", { title: "x", cron: "nonsense", workspaceId: wsId, runner: "claude", prompt: "p" });
      expect(bad.status).toBe(400);
      const s = await post("/api/schedules", { title: "nightly", cron: "@nightly", workspaceId: wsId, runner: "claude", prompt: "run the nightly check" }).then(j);
      expect(s.enabled).toBe(true);
      expect(s.nextRunAt).toBeGreaterThan(Date.now());
      const list = await fetch(`${base}/api/schedules`).then(j);
      expect(list.some((x: { id: string }) => x.id === s.id)).toBe(true);
      const ran = await post(`/api/schedules/${s.id}/run`, {}).then(j);
      expect(ran.scheduleId).toBe(s.id);
      expect(ran.workspaceId).toBe(meta.id); // the run is on the meta workspace, not the repo one that sorts first
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
    } finally {
      core.db.deleteWorkspace("ws_sched_repo");
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("schedules API: stuck is set when the newest Tasks of a schedule stopped the same way, null otherwise", async () => {
    const wsId = (await fetch(`${base}/api/workspaces`).then(j)).find((w: { kind: string }) => w.kind === "meta").id;
    const mkSchedule = (title: string) => fetch(`${base}/api/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, cron: "@nightly", workspaceId: wsId, runner: "claude", prompt: "p" }) }).then(j);
    const stuck = await mkSchedule("stuck-sch");
    const fine = await mkSchedule("fine-sch");
    for (const [i, id] of ["k1", "k2"].entries()) {
      core.db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: stuck.id, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1000 + i, createdAt: 1000 + i, updatedAt: 1000 + i } as Task);
      core.db.appendEvent(id, { t: "stop.record", stop: { id: `${id}/s`, work: { workspaceId: null, issue: null, taskId: id, scheduleId: stuck.id }, op: "schedule run", target: "", reason: "input", evidence: "need input", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: 1000 + i } });
    }
    core.db.sqlite.query("UPDATE schedules SET last_task_id = 'k2' WHERE id = ?").run(stuck.id);
    const list = await fetch(`${base}/api/schedules`).then(j);
    expect(list.find((x: { id: string }) => x.id === stuck.id).stuck).toEqual({ count: 2, reason: "input", evidence: "need input", firstAt: 1000, taskId: "k2" });
    expect(list.find((x: { id: string }) => x.id === fine.id).stuck).toBeNull();
    for (const id of [stuck.id, fine.id]) await fetch(`${base}/api/schedules/${id}`, { method: "DELETE" });
  });
});

describe("schedule samples", () => {
  const samples = async (c: { server: { port?: number } }) =>
    ((await fetch(`http://127.0.0.1:${c.server.port}/api/schedules`).then(j)) as Schedule[]).filter((s) => s.title.startsWith("（サンプル）"));

  test("schedule samples: a new instance gets every sample on meta, disabled — a second start adds none, and one the person deleted is not put back", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-samples-"));
    const boot = () => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      let c = await boot();
      const first = await samples(c);
      const meta = ((await fetch(`http://127.0.0.1:${c.server.port}/api/workspaces`).then(j)) as Workspace[]).find((w) => w.kind === "meta")!;
      expect(first.map((s) => s.title).sort()).toEqual(SCHEDULE_SAMPLES.map((s) => `（サンプル）${s.title}`).sort());
      expect(first).toHaveLength(12);
      for (const s of first) expect(s).toMatchObject({ action: "prompt", workspaceId: meta.id, enabled: false });
      const check = first.find((s) => s.title === "（サンプル）床・天井・壁の点検")!;
      expect(check).toMatchObject({ cron: "0 9 1 * *", prompt: UI_LAYERS_CHECK_PROMPT, runner: "claude" });
      expect(c.db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual(SCHEDULE_SAMPLES.map((s) => s.id));
      await c.stop();
      c = await boot();
      expect((await samples(c)).map((s) => s.id).sort()).toEqual(first.map((s) => s.id).sort());
      expect((await fetch(`http://127.0.0.1:${c.server.port}/api/schedules/${check.id}`, { method: "DELETE" })).ok).toBe(true);
      await c.stop();
      c = await boot();
      expect((await samples(c)).map((s) => s.id).sort()).toEqual(first.filter((s) => s.id !== check.id).map((s) => s.id).sort());
      await c.stop();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("schedule samples API: every sample is listed on an instance that recorded them all and holds no row, and picking one to add twice makes two enabled rows without touching the record", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-samples-api-"));
    try {
      // an instance from before the samples: the migration recorded every id and no sample row exists
      const before = new Db(join(h, "switchboard.db"));
      before.setSetting(SAMPLES_KEY, SCHEDULE_SAMPLES.map((s) => s.id));
      before.close();
      const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
      try {
        const url = `http://127.0.0.1:${c.server.port}/api/schedules`;
        expect(await samples(c)).toHaveLength(0);
        const list = (await fetch(`${url}/samples`).then(j)) as ScheduleSampleInfo[];
        expect(list.map((s) => s.id)).toEqual(SCHEDULE_SAMPLES.map((s) => s.id));
        const pick = list.find((s) => s.id === "ui-layers-check")!;
        expect(pick).toEqual({ id: "ui-layers-check", title: "床・天井・壁の点検", cron: "0 9 1 * *", runner: "claude", prompt: UI_LAYERS_CHECK_PROMPT });
        const meta = ((await fetch(`http://127.0.0.1:${c.server.port}/api/workspaces`).then(j)) as Workspace[]).find((w) => w.kind === "meta")!;
        const recorded = c.db.getSetting<string[]>(SAMPLES_KEY, []);
        const add = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: pick.title, cron: pick.cron, runner: pick.runner, prompt: pick.prompt, action: "prompt", workspaceId: meta.id }) });
        expect((await add()).status).toBe(201);
        expect((await add()).status).toBe(201);
        const rows = ((await fetch(url).then(j)) as Schedule[]).filter((s) => s.title === pick.title);
        expect(rows).toHaveLength(2);
        for (const r of rows) expect(r).toMatchObject({ enabled: true, prompt: pick.prompt, cron: pick.cron });
        expect(c.db.getSetting<string[]>(SAMPLES_KEY, [])).toEqual(recorded);
      } finally {
        await c.stop();
      }
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("the credential scan: an instance with no scan that fires gets one enabled, once — an upgraded instance and a new one alike; one that fires already is left alone, and one the person deleted or turned off afterwards is not put back", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-scan-"));
    const boot = () => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const url = (c: { server: { port?: number } }) => `http://127.0.0.1:${c.server.port}/api/schedules`;
    const scans = async (c: { server: { port?: number } }) => ((await fetch(url(c)).then(j)) as Schedule[]).filter((s) => s.action === "secret-scan").map((s) => ({ id: s.id, enabled: s.enabled }));
    try {
      // an instance from the release before (its database, as the old flag marks it): no scan schedule, nothing recorded
      const before = new Db(join(h, "switchboard.db"));
      before.setSetting("uiLayers.seeded", true);
      before.close();
      let c = await boot();
      const meta = ((await fetch(`http://127.0.0.1:${c.server.port}/api/workspaces`).then(j)) as Workspace[]).find((w) => w.kind === "meta")!;
      const all = ((await fetch(url(c)).then(j)) as Schedule[]).filter((s) => s.action === "secret-scan");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ title: SECRET_SCAN.title, cron: SECRET_SCAN.cron, workspaceId: meta.id, enabled: true, nextRunAt: expect.any(Number) });
      expect(c.db.getSetting<string[]>(PROVISIONED_KEY, [])).toEqual(["secret-scan"]);
      const first = all[0]!.id;
      // a second start adds none; turned off by the person, it stays the only one and stays off
      await c.stop();
      c = await boot();
      expect(await scans(c)).toEqual([{ id: first, enabled: true }]);
      expect((await fetch(`${url(c)}/${first}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).ok).toBe(true);
      await c.stop();
      c = await boot();
      expect(await scans(c)).toEqual([{ id: first, enabled: false }]);
      // an instance not yet recorded whose only scan is off (it had the weekly workflow beside it): one that fires is
      // added, and the row that was there is left as it is
      c.db.setSetting(PROVISIONED_KEY, []);
      await c.stop();
      c = await boot();
      const two = await scans(c);
      expect(two).toHaveLength(2);
      expect(two).toContainEqual({ id: first, enabled: false });
      const second = two.find((s) => s.id !== first)!;
      expect(second.enabled).toBe(true);
      // an instance not yet recorded with a scan that fires: nothing is added, and it is recorded
      c.db.setSetting(PROVISIONED_KEY, []);
      await c.stop();
      c = await boot();
      expect((await scans(c)).map((s) => s.id).sort()).toEqual([first, second.id].sort());
      expect(c.db.getSetting<string[]>(PROVISIONED_KEY, [])).toEqual(["secret-scan"]);
      // deleted by the person: not put back
      for (const id of [first, second.id]) expect((await fetch(`${url(c)}/${id}`, { method: "DELETE" })).ok).toBe(true);
      await c.stop();
      c = await boot();
      expect(await scans(c)).toEqual([]);
      await c.stop();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("schedule samples: an instance that had the monthly check's old flag gets no sample, and the flag stays for a release rolled back to", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-samples-"));
    try {
      const before = new Db(join(h, "switchboard.db"));
      before.setSetting("uiLayers.seeded", true);
      before.close();
      const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
      // only a sample the list got after that time goes in, disabled, as on any instance
      expect((await samples(c)).map((s) => [s.title, s.enabled])).toEqual([["（サンプル）確認中の PBI をまとめて確かめる", false]]);
      expect(c.db.getSetting<unknown>("uiLayers.seeded", null)).toBe(true);
      await c.stop();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("schedule samples: a start that cannot add them (the meta folder is missing) records none, and the next start adds them", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-samples-"));
    const repo = join(h, "repo");
    const boot = () =>
      startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_REPO_ROOT: repo, ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      let c = await boot(); // repo does not exist yet: Scheduler.create refuses the meta workspace
      expect(await samples(c)).toHaveLength(0);
      await c.stop();
      mkdirSync(repo);
      c = await boot();
      expect(await samples(c)).toHaveLength(SCHEDULE_SAMPLES.length);
      await c.stop();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("insights schedule", () => {
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("a report /insights writes before the runner reports its session is still this run's: the daemon compares with the Task's creation", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-insights-"));
    const usage = join(h, "usage-data");
    mkdirSync(usage);
    const report = join(usage, "report.html");
    // like Claude Code's /insights: the command analyses and writes the report first; session.start comes after (it is held until gate resolves, i.e. until the report is written)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-insights", cwd: h },
      { t: "message.delta", role: "assistant", text: "Your shareable insights report is ready" },
      { t: "session.end", status: "ok" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_USAGE_DATA: usage, ...NO_HISTORY }), [fakeAdapter(script, { gate })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ seq: number; ts: number; ev: AgentEvent }> };
    try {
      const ws = await fetch(`${b}/api/workspaces`).then(j);
      const meta = ws.find((w: { kind: string }) => w.kind === "meta").id;
      const s = await send(`${b}/api/schedules`, "POST", { title: "Claude Code Insights", cron: "30 18 * * 0,3", workspaceId: meta, runner: "claude", action: "insights" }).then(j);
      const t = await send(`${b}/api/schedules/${s.id}/run`, "POST").then(j);
      // the daemon copies the report only when its mtime is after the Task's creation; a file mtime comes from a coarse clock that can lag Date.now(), so write until it is
      const html = "<!doctype html><title>Claude Code Insights</title><h1>Insights</h1>";
      writeFileSync(report, html);
      while (statSync(report).mtimeMs <= t.createdAt) {
        await Bun.sleep(1);
        writeFileSync(report, html);
      }
      // session.start's ts is Date.now() (whole ms), mtimeMs has a fraction: release only once the clock is past the write, so the two cannot share a millisecond
      const written = statSync(report).mtimeMs;
      while (Date.now() <= written) await Bun.sleep(1);
      release();
      await waitFor(async () => (await get(t.id)).task.status === "done", 20_000);
      const d = await get(t.id);
      const started = d.events.find((e) => e.ev.t === "session.start")!.ts;
      expect(statSync(report).mtimeMs).toBeLessThan(started); // written before the runner reported its session
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j)).length === 1, 20_000);
      const lines = (await get(t.id)).events.map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
      expect(lines.some((l) => l.startsWith("レポートを成果物に写しました: Claude Code Insights "))).toBe(true);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 30_000); // the runner's start and the report as an artifact: over the 5 s default on a loaded host (docs/design/perf.md "Test flakiness")

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
      await waitFor(async () => (await get(id)).task.status === "waiting", 20_000);
      const ask = (await get(id)).events.map((e) => e.ev).find((e) => e.t === "permission.ask") as Extract<AgentEvent, { t: "permission.ask" }>;
      await send(`${b}/api/tasks/${id}/permission`, "POST", { id: ask.id, decision: "allow" });
      await waitFor(async () => (await get(id)).task.status === "done", 20_000);
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
      await waitFor(async () => (await get(t1.id)).task.status === "waiting", 20_000);
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
      await waitFor(async () => (await get(t4.id)).task.status === "waiting", 20_000);
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
  }, 30_000); // several runner starts and the reports as artifacts: over the 5 s default on a loaded host (docs/design/perf.md "Test flakiness")
});
