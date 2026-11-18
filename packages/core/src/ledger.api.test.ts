// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, home, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
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

  test("settings prices: a price entered in the settings prices the next usage without a restart, wins over pricing.json's row, and null brings the row back", async () => {
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

  test("db ledger summary is empty on a fresh database", () => {
    const db = new Db(join(home, "fresh.db"));
    const s = db.ledgerSummary();
    expect(s.todayUsd).toBe(0);
    expect(s.topTasks).toEqual([]);
    db.close();
  });
});

describe("ledger: Claude's running totals", () => {
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

describe("ledger models", () => {
  test("ledger billing: daily, tasks and models take a billing kind and count only its rows; none is every kind together; the same model is one row per kind; a wrong kind is 400", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-ledger-billing-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the Task list of the ledger joins the Tasks: two rows are enough for it
      const mk = (id: string) => (c.db.sqlite.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, status_at, created_at, updated_at) VALUES (?1, 'ws', ?1, 'claude', '/w', '[]', 'done', 1, 1, 1)").run(id), id);
      const [plan, both] = [mk("plan"), mk("both")];
      const row = (over: Partial<Parameters<typeof c.db.insertLedger>[0]>) => c.db.insertLedger({ taskId: plan, runner: "claude", model: "claude-opus-5-5", inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, billing: "claude.ai", source: "reported", ts: Date.now(), ...over });
      row({});
      row({ taskId: both, costUsd: 2 });
      row({ taskId: both, costUsd: 4, billedUsd: 4, billing: "console" }); // the same Task and model after the login changed
      row({ taskId: both, model: "global.anthropic.claude-haiku-5-5", costUsd: 8, billedUsd: 8, billing: "bedrock" });
      type Model = { model: string | null; billing: string; tasks: number; costUsd: number; billedUsd: number };
      const models = (q = "") => fetch(`${b}/api/ledger/models?days=7${q}`).then(j) as Promise<Model[]>;
      const daily = (q = "") => fetch(`${b}/api/ledger/daily?days=7${q}`).then(j) as Promise<Array<{ costUsd: number; billedUsd: number }>>;
      const tasks = (q = "") => fetch(`${b}/api/ledger/tasks?days=7${q}`).then(j) as Promise<Array<{ title: string; costUsd: number; billedUsd: number }>>;
      // no kind: everything together, the same model on one row per kind
      expect((await models()).map((r) => [r.model, r.billing, r.tasks, r.costUsd, r.billedUsd])).toEqual([
        ["global.anthropic.claude-haiku-5-5", "bedrock", 1, 8, 8],
        ["claude-opus-5-5", "console", 1, 4, 4],
        ["claude-opus-5-5", "claude.ai", 2, 3, 0],
      ]);
      expect((await daily()).map((d) => [d.costUsd, d.billedUsd])).toEqual([[15, 12]]);
      expect((await tasks()).map((t) => [t.title, t.costUsd, t.billedUsd])).toEqual([["both", 14, 12], ["plan", 1, 0]]);
      // one kind: only its rows, on all three
      expect((await models("&billing=console")).map((r) => [r.model, r.billing, r.costUsd])).toEqual([["claude-opus-5-5", "console", 4]]);
      expect((await daily("&billing=console")).map((d) => [d.costUsd, d.billedUsd])).toEqual([[4, 4]]);
      expect((await tasks("&billing=console")).map((t) => [t.title, t.costUsd])).toEqual([["both", 4]]);
      expect((await daily("&billing=claude.ai")).map((d) => [d.costUsd, d.billedUsd])).toEqual([[3, 0]]);
      expect((await tasks("&billing=claude.ai")).map((t) => [t.title, t.costUsd])).toEqual([["both", 2], ["plan", 1]]);
      expect(await daily("&billing=api")).toEqual([]);
      for (const path of ["daily", "tasks", "models"]) expect([path, (await fetch(`${b}/api/ledger/${path}?billing=free`)).status]).toEqual([path, 400]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

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
