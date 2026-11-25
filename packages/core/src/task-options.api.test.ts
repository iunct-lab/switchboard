// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("effort of an existing task: POST /api/tasks/:id/effort applies from the next turn; session.start carries the effort it started with", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-effort-change-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts, slowMs: 150, closeMs: 120, efforts: ["low", "high"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const task = (id: string) => fetch(`${b}/api/tasks/${id}`).then(j);
    const done = (id: string) => waitFor(async () => (await task(id)).task.status === "done");
    const startEfforts = async (id: string) => (await task(id)).events.filter((e: { ev: AgentEvent }) => e.ev.t === "session.start").map((e: { ev: { effort?: string } }) => e.ev.effort);
    const said = async (id: string, text: string) => (await task(id)).events.some((e: { ev: AgentEvent }) => e.ev.t === "status" && e.ev.text === text);
    try {
      const t = await post("/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude", effort: "low" }).then(j);
      expect(starts[0]?.effort).toBe("low");
      await done(t.id);
      // idle: released now, the next turn resumes the same session with the new effort
      expect((await post(`/api/tasks/${t.id}/effort`, { effort: "high" }).then(j))).toMatchObject({ effort: "high", status: "done" });
      expect(c.tasks.isLive(t.id)).toBe(false);
      expect(await said(t.id, "effort → high (applies to the next turn)")).toBe(true);
      await post(`/api/tasks/${t.id}/send`, { text: "again" });
      expect(starts.length).toBe(2);
      expect(starts[1]).toMatchObject({ effort: "high", resumeSessionId: "sess-1" });
      await done(t.id);
      expect(await startEfforts(t.id)).toEqual(["low", "high"]);
      // a turn in flight: the process stays; the turn after it restarts with the new effort
      await post(`/api/tasks/${t.id}/send`, { text: "busy" });
      expect((await task(t.id)).task.status).toBe("running");
      expect((await post(`/api/tasks/${t.id}/effort`, { effort: "low" })).status).toBe(200);
      expect(c.tasks.isLive(t.id)).toBe(true);
      expect(starts.length).toBe(2);
      await done(t.id);
      await post(`/api/tasks/${t.id}/send`, { text: "after" });
      expect(starts.length).toBe(3);
      expect(starts[2]).toMatchObject({ effort: "low", resumeSessionId: "sess-1" });
      await done(t.id);
      // no process attached: recorded for the resume. null = back to the CLI's default
      await c.tasks.release(t.id);
      expect((await post(`/api/tasks/${t.id}/effort`, { effort: null }).then(j)).effort).toBeNull();
      expect(await said(t.id, "effort → CLI default (applies when the task resumes)")).toBe(true);
      await post(`/api/tasks/${t.id}/send`, { text: "default" });
      expect(starts.at(-1)?.effort).toBeUndefined();
      await done(t.id);
      expect((await startEfforts(t.id)).at(-1)).toBe("");
      expect((await post(`/api/tasks/${t.id}/effort`, { effort: 5 })).status).toBe(400);
      expect((await post(`/api/tasks/${t.id}/effort`, {})).status).toBe(400);
      expect((await post(`/api/tasks/${t.id}/effort`, { effort: "nope" })).status).toBe(400);
      expect((await post(`/api/tasks/nope/effort`, { effort: "high" })).status).toBe(404);
      // a Cloud task has no process of ours
      const now = Date.now();
      c.db.insertTask({ id: "cloud1", workspaceId: null, title: "cloud", runner: "claude", cwd: h, scope: [h], status: "running", runnerSessionId: null, executionMode: "cloud", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
      expect((await post(`/api/tasks/cloud1/effort`, { effort: "high" })).status).toBe(409);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("model of an existing task: POST /api/tasks/:id/model releases the idle process, the next turn resumes the session with the new model; a turn in flight keeps its process", async () => {
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

  test("permission modes: resolved at creation (explicit → saved default → adapter default), validated, switched live or on resume", async () => {
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
      expect(c8.db.getSetting("settings", {})).toEqual({ developSelf: true, defaultPermissionMode: { claude: "plan" }, subagentEffort: {}, subagentModel: {}, defaultModel: {}, defaultEffort: {}, autoResume: {}, bedrock: {}, shadowRunner: null, routing: { llm: { enabled: false, runner: "claude", model: "", effort: "", timeoutMs: 5000 } }, judge: { enabled: true, runner: "codex", model: "gpt-6-luna", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 }, autoStart: { runner: "claude", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" }, reviewRunner: "other", reviewModel: {}, reviewEffort: {}, maxRunners: 3, evals: { judge: { enabled: true } }, titles: { auto: true, runner: "codex", model: "gpt-6-luna", effort: "" }, quotaAndResume: { backlogQuotaLimit: 0.8, retryDelayMs: 900_000, retryMaxDelayMs: 14_400_000, maxLimitStops: 8, resumePrompt: "使用上限がリセットされました。中断した箇所から作業を続けてください。", maxStopResumes: 2, silentAfterMs: 600_000, waitLimitMs: 21_600_000, queueStallMs: 3_600_000, dependsLimitMs: 259_200_000, thinSample: 5, flowLimit: 1, flowShareLimit: 0.25, defaultBudgetUsd: null, fableBudgetUsd: null }, judgeAndChoice: { judgeFallbackRunner: "claude", judgeFallbackModel: "claude-haiku-4-5", judgeFallbackEffort: "", judgeTimeoutMs: 60_000, workspaceChoiceTimeoutMs: 60_000 }, newDefaults: { taskRunner: "claude", taskModel: "", taskEffort: "", scheduleCron: "0 3 * * *" }, release: { checkMinutes: 10, auto: "promote", drainMinutes: 60, tagCi: "no-fail" }, cliUpdate: { checkMinutes: 60, waitHours: 0, missingSignature: "refuse", smoke: "turn" }, prices: {}, models: {}, hiddenModels: {}, outbound: { classifierLog: false, runnerTelemetry: false } });
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
      // a task from before permission modes (permission_mode NULL) resolves its mode when resumed and records it
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

  test("usage-limit auto-resume: the stop is recorded with resumeAt, the setting is per runner and validated, resume now / cancel through the API", async () => {
    const starts: StartOptions[] = [];
    const banner = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "sess-9", cwd: "/tmp" },
      { t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.06, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } },
      { t: "message.delta", role: "assistant", text: banner },
      { t: "session.end", status: "error", summary: banner },
    ];
    const h12 = mkdtempSync(join(tmpdir(), "switchboard-test12-"));
    // the head PR 12 has when the grant in the note is recorded (the daemon reads it with gh)
    const HEAD12 = "a".repeat(40);
    const c12 = await startServer(loadConfig({ SWITCHBOARD_HOME: h12, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { lingers: true, starts })], { port: 0, gh: async (args) => (args.includes("headRefOid") ? { code: 0, stdout: JSON.stringify({ headRefOid: HEAD12 }), stderr: "" } : { code: 1, stdout: "", stderr: "no gh in this test" }) });
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
      // a body that is not { text: string } is refused before anything is sent
      expect((await call(`/api/tasks/${t.id}/resume`, "POST", { text: 5 })).status).toBe(400);
      // resume now: a follow-up turn on the same session, at once
      expect(c12.db.hasMergeGrant(t.id, "o/a", "merge", 12, HEAD12)).toBe(false);
      // as the screen sends it (this origin): a grant in a note from a bare call is not recorded as the person's
      const resumed = await fetch(`${b12}/api/tasks/${t.id}/resume`, { method: "POST", headers: { "content-type": "application/json", origin: b12, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ text: "o/a の PR #12 を判定の外でマージしてよい" }) }).then(j);
      expect(resumed.status).toBe("running");
      expect(c12.db.hasMergeGrant(t.id, "o/a", "merge", 12, HEAD12)).toBe(true); // a grant in the note is recorded, as in a reply, for the head the PR has
      await waitFor(async () => (await task(t.id)).task.status === "error"); // the fake hits the limit again
      const again = await task(t.id);
      // the fake does not echo the first prompt (the real adapters do); the resume turn is the one user message, in the daemon's words
      const userTurns = again.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "message.delta" && e.role === "user");
      expect(userTurns.length).toBe(1);
      expect(userTurns[0].text).toContain("Switchboard 自動再開");
      expect(userTurns[0].text.endsWith("\n\no/a の PR #12 を判定の外でマージしてよい")).toBe(true); // the note follows the follow-up
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
});

describe("task fork", () => {
  const turnScript = (end: Extract<AgentEvent, { t: "session.end" }>): AgentEvent[] => [
    { t: "session.start", runner: "claude", runnerSessionId: "sess-parent", cwd: "/tmp" },
    { t: "message.delta", role: "assistant", text: "done" },
    end,
  ];
  const OK_END = { t: "session.end", status: "ok", turn: "uuid-1" } as const;
  const post = (b: string, path: string, body?: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const boot = (h: string, adapters: RunnerAdapter[]) => startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), adapters, { port: 0, selfdevChecks: false, gh: NO_GH });

  test("POST /api/tasks/:id/fork: 201 with forkOf / forkSeq, nothing started; 400 for a runner that cannot fork, a version below the minimum, a turn that is not a clean finished one, Cloud, a parent without a session here; 404 / 400 for the rest", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-fork-api-"));
    const starts: StartOptions[] = [];
    let sessionHere = true;
    const c = await boot(h, [fakeAdapter(turnScript(OK_END), { forks: { min: "2.0.0" }, detect: () => ({ version: "2.1.5" }), starts, hasSession: () => sessionHere }), fakeAdapter(turnScript(OK_END), { id: "dak" }), fakeAdapter(turnScript(OK_END), { id: "codex", forks: { min: "9.0.0" }, detect: () => ({ version: "1.0.0" }) })]);
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const create = async (runner: RunnerId): Promise<Task> => {
        const t = (await post(b, "/api/tasks", { cwd: h, title: "親", prompt: "p", runner }).then(j)) as Task;
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
        return t;
      };
      const endSeq = (id: string) => c.db.listEvents(id).find((e) => e.ev.t === "session.end")!.seq;
      const get = async (id: string): Promise<Task> => (await fetch(`${b}/api/tasks/${id}`).then(j)).task;
      const parent = await create("claude");
      const seq = endSeq(parent.id);

      const info = ((await fetch(`${b}/api/health`).then(j)).runners as Array<{ id: string; forks: boolean }>);
      expect(info.map((r) => [r.id, r.forks])).toEqual([["claude", true], ["dak", false], ["codex", false]]);

      const r = await post(b, `/api/tasks/${parent.id}/fork`, { seq });
      expect(r.status).toBe(201);
      const child = (await r.json()) as Task;
      expect(child).toMatchObject({ forkOf: parent.id, forkSeq: seq, forkTurn: "uuid-1", status: "idle", runnerSessionId: null, title: "親（分岐）", cwd: parent.cwd, runner: "claude" });
      expect(await get(child.id)).toMatchObject({ forkOf: parent.id, forkSeq: seq });
      expect(c.db.forksOf(parent.id).map((t) => t.id)).toEqual([child.id]);
      expect(starts).toHaveLength(1); // the parent's own start only: forking runs nothing

      const refused = async (id: string, body: unknown) => (await post(b, `/api/tasks/${id}/fork`, body)).status;
      expect(await refused(parent.id, { seq: seq - 1 })).toBe(400); // not a session.end
      expect(await refused(parent.id, { seq: 9999 })).toBe(400);
      expect(await refused(parent.id, {})).toBe(400);
      expect(await refused("task_nope", { seq })).toBe(404);
      const dak = await create("dak");
      expect(await refused(dak.id, { seq: endSeq(dak.id) })).toBe(400); // the runner cannot fork
      const codex = await create("codex");
      expect(await refused(codex.id, { seq: endSeq(codex.id) })).toBe(400); // detected version below forkMinVersion
      sessionHere = false;
      expect(await refused(parent.id, { seq })).toBe(400); // the session is not on this machine
      sessionHere = true;
      c.db.sqlite.query("UPDATE tasks SET execution_mode = 'cloud' WHERE id = ?").run(parent.id);
      expect(await refused(parent.id, { seq })).toBe(400);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("POST /api/tasks/:id/fork: 400 for a turn without a pointer, an errored turn and an aborted one", async () => {
    for (const [name, end] of [["no turn", { t: "session.end", status: "ok" }], ["error", { t: "session.end", status: "error", turn: "u" }], ["aborted", { t: "session.end", status: "aborted", turn: "u" }]] as const) {
      const h = mkdtempSync(join(tmpdir(), "switchboard-fork-api-"));
      const c = await boot(h, [fakeAdapter(turnScript(end), { forks: { min: "2.0.0" }, detect: () => ({ version: "2.1.5" }) })]);
      const b = `http://127.0.0.1:${c.server.port}`;
      try {
        const t = (await post(b, "/api/tasks", { cwd: h, title: "親", prompt: "p", runner: "claude" }).then(j)) as Task;
        await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status !== "running");
        const seq = c.db.listEvents(t.id).find((e) => e.ev.t === "session.end")!.seq;
        const r = await post(b, `/api/tasks/${t.id}/fork`, { seq });
        expect([name, r.status]).toEqual([name, 400]);
      } finally {
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    }
  });
});
