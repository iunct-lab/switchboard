// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, RoutingStats, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import type { Suggester } from "./routing.ts";
import { NO_GH, NO_HISTORY, SCRIPT, base, core, fakeAdapter, getTask, home, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("POST /api/tasks/suggest applies the rule table and the previous runner; the suggestion is recomputed and recorded at creation", async () => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    const dir = join(home, "routing-cwd");
    mkdirSync(dir, { recursive: true });
    const multi = await post("/api/tasks/suggest", { cwd: dir, title: "x", prompt: "y", scope: [dir, join(home, "other")] });
    expect(multi).toMatchObject({ runner: "claude", ruleId: "multi-repo", available: true });
    const review = await post("/api/tasks/suggest", { cwd: dir, title: "PR review", prompt: "" });
    expect(review).toMatchObject({ runner: "codex", ruleId: "single-repo-long", available: false }); // only the fake claude adapter is installed
    expect(await post("/api/tasks/suggest", { cwd: dir, title: "", prompt: "状況を教えて" })).toMatchObject({ runner: "claude", ruleId: "status-question", model: "claude-haiku-5-5" });
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

  test("the routing log carries the task's outcome (status / costUsd / durationMs) and exports as JSONL", async () => {
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
    const past = { id: "task_backwards", workspaceId: null, title: "backwards", runner: "claude" as const, cwd: home, scope: [home], status: "done" as const, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: { suggested: "claude" as const, ruleId: "r", reason: "why", overridden: false, llm: null }, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard" as const, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown" as const, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 5_000, createdAt: 5_000, updatedAt: 1_000 };
    core.db.insertTask(past);
    expect((await logRows()).find((r) => r.taskId === past.id)!.durationMs).toBe(0);
    // each row carries its task's outcome: the status alone says "done" for a task that stopped to ask
    expect(row.outcome).toBe(core.db.getTask(t.id)!.outcome);
    for (const outcome of ["finished", "needs_action"] as const) {
      const id = `task_outcome_${outcome}`;
      core.db.insertTask({ ...past, id, title: id, createdAt: 6_000, updatedAt: 6_000 });
      core.db.updateTask(id, { outcome });
      expect((await logRows()).find((r) => r.taskId === id)).toMatchObject({ status: "done", outcome });
    }
    // a failed task's outcome comes from its status, in the same log
    core.db.insertTask({ ...past, id: "task_outcome_failed", title: "failed", createdAt: 6_000, updatedAt: 6_000 });
    core.db.updateTask("task_outcome_failed", { status: "error" });
    expect((await logRows()).find((r) => r.taskId === "task_outcome_failed")).toMatchObject({ status: "error", outcome: "failed" });

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

  test("suggester: the LLM proposal rides along, and a disabled one leaves the rule table in charge", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-suggester-"));
    const dir = join(h, "repo");
    mkdirSync(dir, { recursive: true });
    const calls: Array<{ title: string; kind: string }> = [];
    const fake: Suggester = {
      async suggest(ctx, signal) {
        calls.push({ title: ctx.title, kind: "llm" });
        return { runner: "dak", reason: "LLM がそう言った", ruleId: "llm", model: null, available: ctx.available.has("dak"), alternatives: [], llm: null };
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
      expect((await fetch(`${b}/api/settings`).then(j)).routing.llm).toEqual({ enabled: true, runner: "claude", model: "", effort: "", timeoutMs: 5000 });

      // (a) on: the LLM proposal arrives on the task and is logged as its own row, without changing the runner
      const on = await post("/api/tasks", { cwd: dir, title: "t-on", prompt: "p", runner: "claude" });
      expect(on.routing).toMatchObject({ suggested: "claude", overridden: false, llm: null });
      await waitFor(async () => c.db.getTask(on.id)?.routing?.llm != null);
      expect(c.db.getTask(on.id)).toMatchObject({ runner: "claude", routing: { llm: { runner: "dak", reason: "LLM がそう言った" } } });
      const rows = c.db.routingLog().filter((r) => r.taskId === on.id);
      expect(rows.map((r) => r.suggestedBy).sort()).toEqual(["llm", "rule"]);
      expect(rows.find((r) => r.suggestedBy === "llm")).toMatchObject({ suggested: "dak", chosen: "claude", ruleId: "llm" });

      // a runner that is not installed cannot be the suggester (its adapter would have to produce the answer)
      expect((await patch({ routing: { llm: { runner: "codex" } } })).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).routing.llm.runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 20000);

  describe("routing advice", () => {
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const ANSWER = { runner: "dak" as const, reason: "後から届いた", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
    const deferred = () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      return { held, release };
    };
    const usage = (model: string): Extract<AgentEvent, { t: "usage" }> => ({ t: "usage", source: "reported", model, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    const boot = async (llmSuggester: NonNullable<Parameters<typeof startServer>[2]>["llmSuggester"], timeoutMs = 5000, adapter = fakeAdapter(script)) => {
      const h = mkdtempSync(join(tmpdir(), "switchboard-test-advice-"));
      const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [adapter], { port: 0, selfdevChecks: false, gh: NO_GH, llmSuggester });
      const b = `http://127.0.0.1:${c.server.port}`;
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true, timeoutMs } } }) });
      const post = (title: string) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title, prompt: "p", runner: "claude" }) });
      return { c, h, b, post };
    };

    test("routing advice never blocks creation", async () => {
      const gate = deferred();
      const starts: StartOptions[] = [];
      const { c, h, post } = await boot(() => ({ kind: "llm", suggest: async () => (await gate.held, ANSWER) }), 60_000, fakeAdapter(script, { starts }));
      try {
        const res = await post("held");
        expect(res.status).toBe(201);
        const t = (await res.json()) as { id: string; routing: { llm: unknown } };
        expect(t.routing.llm).toBeNull(); // the suggester is still held
        expect(starts).toHaveLength(1); // and the real runner started
        gate.release();
        await waitFor(async () => c.db.getTask(t.id)?.routing?.llm != null);
      } finally {
        gate.release();
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice arrives after task completion", async () => {
      const gate = deferred();
      const { c, h, b, post } = await boot(() => ({ kind: "llm", suggest: async () => (await gate.held, ANSWER) }), 60_000);
      try {
        const t = (await (await post("late")).json()) as { id: string };
        const get = async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task;
        await waitFor(async () => (await get()).status === "done");
        const finished = await get();
        expect(finished.routing.llm).toBeNull();
        gate.release();
        await waitFor(async () => (await get()).routing.llm !== null);
        const after = await get();
        expect(after).toEqual({ ...finished, routing: { ...finished.routing, llm: { runner: "dak", reason: "後から届いた" } } });
        expect(c.db.routingLog().filter((r) => r.taskId === t.id).map((r) => [r.suggestedBy, r.chosen, r.status])).toEqual([["llm", "claude", "done"], ["rule", "claude", "done"]]);
      } finally {
        gate.release();
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice timeout and failure preserve task", async () => {
      let which: "throws" | "throws-at-once" | "never" = "throws";
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const { c, h, b, post } = await boot((_, onUsage) => {
        if (which === "throws-at-once") throw new Error("no suggester today");
        return { kind: "llm", suggest: async (_ctx, signal) => {
          onUsage(usage(`spent-${which}`));
          if (which === "throws") throw new Error("runner said no");
          await new Promise((r) => signal.addEventListener("abort", r));
          return ANSWER; // past the deadline: dropped
        } };
      }, 1000);
      try {
        for (const w of ["throws", "throws-at-once", "never"] as const) {
          which = w;
          const res = await post(w);
          expect(res.status).toBe(201);
          const t = (await res.json()) as { id: string };
          await waitFor(async () => c.db.getTask(t.id)?.status === "done");
          await waitFor(async () => warn.mock.calls.some((a) => String(a[0]).includes("routing:") && (w !== "never" || String(a[0]).includes("no answer in"))));
          await Bun.sleep(20);
          expect(c.db.getTask(t.id)?.routing?.llm).toBeNull();
          expect(c.db.getTask(t.id)?.runner).toBe("claude");
          expect(c.db.routingLog().filter((r) => r.taskId === t.id).map((r) => r.suggestedBy)).toEqual(["rule"]);
          warn.mockClear();
        }
        // what a turn reported before it failed or missed the deadline is billed
        expect(c.db.sqlite.query("SELECT model FROM ledger WHERE model LIKE 'spent-%' ORDER BY model").all()).toEqual([{ model: "spent-never" }, { model: "spent-throws" }]);
        expect((await fetch(`${b}/api/routing/stats`).then(j)).llm.total).toBe(0);
      } finally {
        warn.mockRestore();
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    }, 20000);

    test("routing advice shutdown cancels pending work", async () => {
      let saw: AbortSignal | null = null;
      let turnEnded = false;
      const { c, h, post } = await boot((_, onUsage) => ({ kind: "llm", suggest: async (_ctx, signal) => {
        saw = signal;
        await new Promise((r) => signal.addEventListener("abort", r));
        turnEnded = true; // where the real suggester closes its session
        onUsage(usage("after-stop"));
        return ANSWER;
      } }), 60_000);
      const attach = spyOn(c.tasks, "attachLlmSuggestion");
      const insert = spyOn(c.db, "insertLedger");
      try {
        expect((await post("stopping")).status).toBe(201);
        await waitFor(async () => saw !== null);
        await c.stop(); // a held turn does not hold the stop, and nothing is written past the close
        expect(saw!.aborted).toBe(true);
        expect(turnEnded).toBe(true);
        expect(attach).not.toHaveBeenCalled();
        expect(insert.mock.calls.filter((a) => a[0].model === "after-stop")).toHaveLength(0);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice shutdown closes the suggestion turn's session", async () => {
      const real = fakeAdapter(script);
      let closed = false;
      let asked = false;
      const adapter: RunnerAdapter = {
        ...real,
        start(o, emit) {
          if (!o.prompt.startsWith("あなたはタスクをどのエージェント")) return real.start(o, emit); // the Task's own turn, the judges'
          asked = true;
          let exit!: (code: number | null) => void;
          const exited = new Promise<number | null>((r) => (exit = r));
          return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { closed = true; exit(0); }, exited };
        },
      };
      const { c, h, post } = await boot(undefined, 60_000, adapter);
      try {
        expect((await post("stopping")).status).toBe(201);
        await waitFor(async () => asked);
        await c.stop();
        expect(closed).toBe(true);
      } finally {
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice is not asked for a Cloud task", async () => {
      let asked = 0;
      const cloudId = "session_0123456789abcdef";
      const cloudAdapter = fakeAdapter([{ t: "cloud.session.created", id: cloudId, url: `https://claude.ai/code/${cloudId}` }], { detect: () => ({ path: process.execPath }) });
      const { c, h, post } = await boot(() => ({ kind: "llm", suggest: async () => (asked++, ANSWER) }), 5000, cloudAdapter);
      try {
        const res = await fetch(`http://127.0.0.1:${c.server.port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "cloud", prompt: "p", runner: "claude", executionMode: "cloud" }) });
        expect(res.status).toBe(201);
        expect((await post("local")).status).toBe(201);
        await waitFor(async () => asked >= 1); // the local one is
        await Bun.sleep(20);
        expect(asked).toBe(1);
      } finally {
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice usage is billed once", async () => {
      const { c, h, post } = await boot((cfg, onUsage) => ({ kind: "llm", suggest: async () => {
        onUsage(usage("advice-model"));
        return { ...ANSWER, reason: cfg.runner };
      } }));
      try {
        const t = (await (await post("billed")).json()) as { id: string };
        await waitFor(async () => c.db.getTask(t.id)?.routing?.llm != null);
        const rows = c.db.sqlite.query("SELECT runner FROM ledger WHERE task_id = ? AND model = 'advice-model'").all(t.id);
        expect(rows).toEqual([{ runner: "claude" }]);
      } finally {
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice: the suggestion turn gets no example of the task itself", async () => {
      const starts: StartOptions[] = [];
      const answer = [{ t: "message.delta", role: "assistant", text: '{"runner":"claude","reason":"r"}', messageId: "m" }, { t: "session.end", status: "ok" }] as AgentEvent[];
      const { c, h, post } = await boot(undefined, 5000, fakeAdapter(answer, { starts }));
      try {
        const t = (await (await post("task-title-once")).json()) as { id: string };
        await waitFor(async () => c.db.getTask(t.id)?.routing?.llm != null);
        expect(starts).toHaveLength(2);
        const asked = starts[1]!.prompt;
        expect(asked).toContain("title: task-title-once");
        expect(asked).toContain("（まだ記録がありません）");
      } finally {
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });

    test("routing advice follows a task whose runner failed to start", async () => {
      const failing = { ...fakeAdapter(script), start() { throw new Error("cannot start"); } };
      const { c, h, post } = await boot(() => ({ kind: "llm", suggest: async () => ANSWER }), 5000, failing);
      try {
        expect((await post("broken")).status).toBe(409);
        const t = c.db.listTasks()[0]!;
        expect(t.status).toBe("error");
        await waitFor(async () => c.db.getTask(t.id)?.routing?.llm != null);
        expect(c.db.getTask(t.id)).toMatchObject({ status: "error", runner: "claude" });
      } finally {
        await c.stop();
        rmSync(h, { recursive: true, force: true });
      }
    });
  });

  test("what the LLM suggestion turn spent is billed to the task under the runner that answered", async () => {
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
          // a second model of the same turn (Claude's `modelUsage`): billed too, not overwritten
          onUsage({ t: "usage", source: "reported", model: "cheaper-model", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
          return { runner: "dak", reason: `${cfg.runner} が答えた`, ruleId: "llm", model: null, available: ctx.available.has("dak"), alternatives: [], llm: null };
        },
      }),
    });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      await fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => c.db.getTask(t.id)?.routing?.llm != null);
      expect(c.db.getTask(t.id)?.routing?.llm).toMatchObject({ runner: "dak", reason: "claude が答えた" });
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

  test("late LLM suggestion preserves task outcome and rule log", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-late-llm-"));
    const env = { SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY };
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    let c = await startServer(loadConfig(env), [fakeAdapter(script)], { port: 0, selfdevChecks: false, gh: NO_GH });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "late", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const before = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task;
      const statsBefore = c.db.routingStats();
      const wsMsgs: Array<{ type: string; task?: { id: string; routing: { llm: unknown } | null } }> = [];
      const ws = new WebSocket(`ws://127.0.0.1:${c.server.port}/ws`);
      ws.onmessage = (e) => wsMsgs.push(JSON.parse(String(e.data)));
      await new Promise((r) => (ws.onopen = r));

      const updated = c.tasks.attachLlmSuggestion(t.id, { runner: "codex", reason: "長い調査に向く" });
      expect(updated?.routing?.llm).toEqual({ runner: "codex", reason: "長い調査に向く" });
      await waitFor(async () => wsMsgs.some((m) => m.type === "task.updated" && m.task?.id === t.id && m.task?.routing?.llm != null));
      ws.close();

      const after = (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task;
      expect(after).toEqual({ ...before, routing: { ...before.routing, llm: { runner: "codex", reason: "長い調査に向く" } } });

      const rows = c.db.routingLog().filter((r) => r.taskId === t.id);
      expect(rows.map((r) => [r.suggestedBy, r.suggested, r.chosen])).toEqual([["llm", "codex", "claude"], ["rule", before.routing.suggested, "claude"]]);
      expect(rows[1]!.ts).toBe(before.createdAt);
      expect(rows[0]!.ts).toBeGreaterThanOrEqual(rows[1]!.ts);
      expect(rows[0]!.status).toBe("done");
      const jsonl = (await fetch(`${b}/api/routing/log?format=jsonl`).then((r) => r.text())).trim().split("\n").map((l) => JSON.parse(l));
      expect(jsonl.filter((r) => r.taskId === t.id).map((r) => [r.suggestedBy, r.status])).toEqual([["llm", "done"], ["rule", "done"]]);

      const stats = c.db.routingStats();
      expect(stats.rule).toEqual(statsBefore.rule);
      expect(stats.byRunner).toEqual(statsBefore.byRunner); // a runner's population is the rule rows
      expect(stats.llm).toEqual({ total: statsBefore.llm.total + 1, agreed: statsBefore.llm.agreed });

      await c.stop();
      c = await startServer(loadConfig(env), [fakeAdapter(script)], { port: 0, selfdevChecks: false, gh: NO_GH });
      expect(c.db.getTask(t.id)?.routing?.llm).toEqual({ runner: "codex", reason: "長い調査に向く" });
      expect(c.db.routingLog().filter((r) => r.taskId === t.id)).toHaveLength(2);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("late LLM suggestion is idempotent and ignores missing task", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-late-llm-once-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const broadcasts = spyOn(c.tasks as unknown as { broadcast: (m: unknown) => void }, "broadcast");
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "once", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");

      expect(c.tasks.attachLlmSuggestion(t.id, { runner: "codex", reason: "1 回目" })).not.toBeNull();
      broadcasts.mockClear();
      expect(c.tasks.attachLlmSuggestion(t.id, { runner: "dak", reason: "2 回目" })).toBeNull();
      expect(c.db.getTask(t.id)?.routing?.llm).toEqual({ runner: "codex", reason: "1 回目" });
      expect(c.db.routingLog().filter((r) => r.taskId === t.id).map((r) => r.suggestedBy).sort()).toEqual(["llm", "rule"]);

      // a log row already there is not added to, whatever the task's own field says
      const seen = c.db.getTask(t.id)!;
      c.db.sqlite.query("UPDATE tasks SET routing = ? WHERE id = ?").run(JSON.stringify({ ...seen.routing, llm: null }), t.id);
      expect(c.tasks.attachLlmSuggestion(t.id, { runner: "dak", reason: "3 回目" })).toBeNull();
      expect(c.db.routingLog().filter((r) => r.taskId === t.id)).toHaveLength(2);

      expect(c.tasks.attachLlmSuggestion("task_missing", { runner: "codex", reason: "無い" })).toBeNull();
      c.db.sqlite.query("UPDATE tasks SET routing = NULL WHERE id = ?").run(t.id); // no routing (a Cloud Task, a shadow): nothing to attach to
      const logged = c.db.routingLog().length;
      expect(c.tasks.attachLlmSuggestion(t.id, { runner: "codex", reason: "無い" })).toBeNull();
      expect(c.db.routingLog()).toHaveLength(logged);
      expect(c.db.getTask(t.id)?.routing).toBeNull();
      expect(broadcasts).not.toHaveBeenCalled();

      // a task that errored or was aborted keeps the advice like a finished one
      for (const status of ["error", "aborted"] as const) {
        const other = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: status, prompt: "p", runner: "claude" }) }).then(j);
        await waitFor(async () => (await fetch(`${b}/api/tasks/${other.id}`).then(j)).task.status === "done");
        c.db.sqlite.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, other.id);
        expect(c.tasks.attachLlmSuggestion(other.id, { runner: "codex", reason: status })).toMatchObject({ status, routing: { llm: { reason: status } } });
      }
    } finally {
      broadcasts.mockRestore();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("routing stats: agreement per suggester over the window", async () => {
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
        byRunner: [{ runner: "claude", total: 2, outcomes: { finished: 0, needs_action: 0, waits: 0, failed: 0, unknown: 2 }, medianCostUsd: 0, medianDurationMs: 0 }],
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

  test("routing stats: per-runner outcomes, cost and duration medians", async () => {
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
      task("task_x1", "codex", "finished", 0.1, 1000);
      task("task_x2", "codex", "finished", 0.5, 3000);
      task("task_x3", "codex", "failed", 0.3, 2000);
      task("task_c1", "claude", "needs_action", 0, 1000, now, true); // (a) rule + llm rows: one task
      task("task_c2", "claude", "finished", 1, 4000);
      task("task_d1", "dak", "finished", 9, 9000, now - 40 * day); // (b) outside the 30-day window
      task("task_c3", "claude", "judged_later", 0, 0, now - 40 * day); // outside too, and a value this version does not know
      task("task_c4", "claude", "toString", 0, 0, now - 40 * day); // not an own key of the counts either
      const stats = (await fetch(`${b}/api/routing/stats?days=30`).then(j)) as RoutingStats;
      expect(stats.byRunner).toEqual([
        // (c) an odd count takes the middle value
        { runner: "codex", total: 3, outcomes: { finished: 2, needs_action: 0, waits: 0, failed: 1, unknown: 0 }, medianCostUsd: 0.3, medianDurationMs: 2000 },
        // an even count the mean of the middle two
        { runner: "claude", total: 2, outcomes: { finished: 1, needs_action: 1, waits: 0, failed: 0, unknown: 0 }, medianCostUsd: 0.5, medianDurationMs: 2500 },
      ]); // (d) dak has no record in the window, so no entry; most tasks first
      expect(stats.llm.total).toBe(1); // the LLM row still counts for agreement
      const wide = (await fetch(`${b}/api/routing/stats?days=90`).then(j)) as RoutingStats;
      expect(wide.byRunner.map((r) => [r.runner, r.total])).toEqual([["claude", 4], ["codex", 3], ["dak", 1]]); // ties by name
      expect(wide.byRunner[0]!.outcomes).toEqual({ finished: 1, needs_action: 1, waits: 0, failed: 0, unknown: 2 });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
