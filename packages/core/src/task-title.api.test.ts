// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { suggestTitle } from "./suggest-title.ts";
import { NO_GH, NO_HISTORY, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("title: without one a task gets the head of the prompt, pending; one the person gave or changed is kept (PATCH)", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-title-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "session.end", status: "ok" }])], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const send = (method: string, path: string, body: unknown) => fetch(`${b}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const prompt = `  line one\nand a long second line that goes past the forty-eighth character of the prompt`;
      const auto = await send("POST", "/api/tasks", { cwd: h, prompt, runner: "claude" }).then(j);
      expect(auto.titlePending).toBe(true);
      expect(auto.title).toBe("line one and a long second line that goes past t");
      expect(auto.title).toHaveLength(48);
      const given = await send("POST", "/api/tasks", { cwd: h, title: "mine", prompt, runner: "claude" }).then(j);
      expect(given).toMatchObject({ title: "mine", titlePending: false });
      const ws = new WebSocket(`${b.replace("http", "ws")}/ws`);
      const updates: Array<{ id: string; title: string }> = [];
      ws.onmessage = (m) => { const msg = JSON.parse(String(m.data)); if (msg.type === "task.updated") updates.push(msg.task); };
      await new Promise((r) => (ws.onopen = r));
      const renamed = await send("PATCH", `/api/tasks/${auto.id}`, { title: "  New name " }).then(j);
      expect(renamed).toMatchObject({ title: "New name", titlePending: false });
      await waitFor(async () => updates.some((t) => t.id === auto.id && t.title === "New name"));
      ws.close();
      expect(c.db.getTask(auto.id)).toMatchObject({ title: "New name", titlePending: false });
      expect((await send("PATCH", `/api/tasks/${auto.id}`, { title: "  " })).status).toBe(400);
      expect((await send("PATCH", `/api/tasks/${auto.id}`, {})).status).toBe(400);
      expect((await send("PATCH", "/api/tasks/nope", { title: "x" })).status).toBe(404);
      // an imported terminal session keeps Claude's title: the import would put it back
      c.db.updateTask(given.id, { updatedAt: Date.now() });
      c.db.sqlite.query("UPDATE tasks SET origin = 'terminal' WHERE id = ?").run(given.id);
      expect((await send("PATCH", `/api/tasks/${given.id}`, { title: "x" })).status).toBe(409);
      expect(c.db.getTask(given.id)!.title).toBe("mine");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("title: the first turn names a provisional task once; a given title, a stage / feedback title, a failed namer, the setting off and a later turn leave it", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-title-turn-"));
    const calls: Array<{ prompt: string; reply: string }> = [];
    let mode: "ok" | "throw" = "ok";
    let held: Promise<void> | null = null; // a naming that waits here, to rename meanwhile
    let heldCalls = 0;
    const titleSuggester: typeof suggestTitle = async (input, o) => {
      calls.push(input);
      if (held) { heldCalls++; await held; }
      if (mode === "throw") {
        o.onUsage?.("codex", { t: "usage", source: "reported", model: "gpt-6-luna", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
        throw new Error("namer is down");
      }
      o.onUsage?.("claude", { t: "usage", source: "reported", model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return { title: "README の誤字を直す", runner: "claude", model: "claude-haiku-4-5" };
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "message.delta", role: "assistant", text: "直しました" }, { t: "session.end", status: "ok", summary: "直しました" }])], { port: 0, selfdevChecks: false, gh: NO_GH, titleSuggester });
    const b = `http://127.0.0.1:${c.server.port}`;
    const send = (method: string, path: string, body: unknown) => fetch(`${b}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const create = (body: Record<string, unknown>) => send("POST", "/api/tasks", { cwd: h, runner: "claude", ...body }).then(j);
    const done = (id: string) => waitFor(async () => c.db.getTask(id)?.status === "done");
    const settle = () => new Promise((r) => setTimeout(r, 150));
    try {
      const auto = await create({ prompt: "README の誤字を直して" });
      await done(auto.id);
      await waitFor(async () => c.db.getTask(auto.id)?.title === "README の誤字を直す");
      expect(c.db.getTask(auto.id)).toMatchObject({ titlePending: false });
      expect(calls).toEqual([{ prompt: "README の誤字を直して", reply: "直しました" }]);
      // the usage of the naming turn is on this task's ledger
      expect(c.db.taskCost(auto.id).tokens).toBeGreaterThanOrEqual(1100);
      // a second turn does not name it again
      await send("POST", `/api/tasks/${auto.id}/send`, { text: "もう一度" });
      await done(auto.id);
      await settle();
      expect(calls).toHaveLength(1);
      // a title the person gave, or that a stage / feedback Task came with, stays
      const given = await create({ title: "自分の名前", prompt: "p" });
      await done(given.id);
      await settle();
      expect(calls).toHaveLength(1);
      expect(c.db.getTask(given.id)!.title).toBe("自分の名前");
      // a namer that throws: the task is done, the provisional title stays
      mode = "throw";
      const failing = await create({ prompt: "失敗する依頼" });
      await done(failing.id);
      await waitFor(async () => calls.length === 2);
      await settle();
      expect(c.db.getTask(failing.id)).toMatchObject({ status: "done", title: "失敗する依頼", titlePending: false });
      // its failed turn's usage is billed to the task all the same
      expect(c.db.taskCost(failing.id).tokens).toBeGreaterThanOrEqual(1100);
      // the person renamed meanwhile: theirs wins
      mode = "ok";
      const slow = await create({ prompt: "手で変える依頼" });
      await send("PATCH", `/api/tasks/${slow.id}`, { title: "手で付けた" });
      await done(slow.id);
      await settle();
      expect(c.db.getTask(slow.id)!.title).toBe("手で付けた");
      // the person PATCHes the very same text while the title is being made: still theirs
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      held = gate;
      const same = await create({ prompt: "同じ文字の依頼" });
      await done(same.id);
      await waitFor(async () => calls.length > 0 && heldCalls > 0);
      await send("PATCH", `/api/tasks/${same.id}`, { title: "同じ文字の依頼" });
      release();
      await settle();
      expect(c.db.getTask(same.id)!.title).toBe("同じ文字の依頼");
      held = null;
      // the setting off: not asked
      expect((await send("PATCH", "/api/settings", { titles: { auto: false } })).status).toBe(200);
      const before = calls.length;
      const off = await create({ prompt: "オフの依頼" });
      await done(off.id);
      await settle();
      expect(calls).toHaveLength(before);
      expect(c.db.getTask(off.id)!.title).toBe("オフの依頼");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("title: a turn that ended in an error is not named and keeps the title pending for the next one", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-title-error-"));
    let calls = 0;
    const titleSuggester: typeof suggestTitle = async () => (calls++, { title: "名前", runner: "claude", model: "claude-haiku-4-5" });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "session.end", status: "error", summary: "boom" }])], { port: 0, selfdevChecks: false, gh: NO_GH, titleSuggester });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, runner: "claude", prompt: "失敗する依頼" }) }).then(j);
      await waitFor(async () => c.db.getTask(t.id)?.status === "error");
      await new Promise((r) => setTimeout(r, 150));
      expect(calls).toBe(0);
      expect(c.db.getTask(t.id)).toMatchObject({ title: "失敗する依頼", titlePending: true });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("skill command title: /pbi-complete <n> is named by the Issue's title at once and is not pending; without one gh can read it stays provisional", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-skill-title-"));
    let ghOk = true;
    const gh = async (args: string[]) => (args[0] === "issue" && ghOk ? { code: 0, stdout: "タイトルを見分ける\n", stderr: "" } : { code: 1, stdout: "", stderr: "no gh in this test" });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "session.end", status: "ok" }])], { port: 0, selfdevChecks: false, gh });
    const b = `http://127.0.0.1:${c.server.port}`;
    const create = (body: Record<string, unknown>) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, runner: "claude", ...body }) }).then(j);
    try {
      expect(await create({ prompt: "/pbi-complete 491" })).toMatchObject({ title: "/pbi-complete #491 タイトルを見分ける", titlePending: false });
      expect(await create({ title: "mine", prompt: "/pbi-complete 491" })).toMatchObject({ title: "mine", titlePending: false });
      expect(await create({ prompt: "ただの依頼" })).toMatchObject({ title: "ただの依頼", titlePending: true });
      ghOk = false;
      expect(await create({ prompt: "/pbi-complete 491" })).toMatchObject({ title: "/pbi-complete 491", titlePending: true });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
