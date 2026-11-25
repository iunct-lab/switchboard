// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StartOptions, Task } from "@switchboard/protocol";
import { TaskSummary } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { claudeBedrockModel } from "@switchboard/adapter-claude";
import { codexBedrockModel } from "@switchboard/adapter-codex";
import { NO_GH, NO_HISTORY, SCRIPT, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("runner choice: a settings row saved before the runner defaults starts a Task by itself on the runner, model and effort it had", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-runner-choice-saved-"));
    const claudeStarts: StartOptions[] = [];
    const ok: AgentEvent[] = [{ t: "message.delta", role: "assistant", text: "直しました" }, { t: "session.end", status: "ok", summary: "直しました" }];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { starts: claudeStarts, models: ["claude-opus-5-5", "claude-sonnet-5-5"], efforts: ["low", "high"] }), fakeAdapter(ok, { id: "codex", models: ["gpt-6-luna"], efforts: ["low", "high"] })], { port: 0, selfdevChecks: false, gh: NO_GH, judge: undefined, titleSuggester: undefined });
    const b = `http://127.0.0.1:${c.server.port}`;
    try {
      // the auto-start part of a real row saved before defaultModel / defaultEffort existed: a common choice and a kind of its own
      c.db.setSetting("settings", { autoStart: { runner: "codex", model: "gpt-6-luna", effort: "", byKind: { request: { runner: "claude", model: "claude-opus-5-5", effort: "high" } }, fallback: [], fallbackAt: 1, completeTaskModel: "claude-sonnet-5-5" } });
      const t = await fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text: "要望" }) }).then(j);
      await waitFor(async () => claudeStarts.some((s) => s.persistSession !== false));
      expect(t.runner).toBe("claude");
      expect(claudeStarts.find((s) => s.persistSession !== false)).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    } finally {
      await c.stop();
    }
  });

  test("runner choice: an auto-started Task with an empty model takes the runner's default model; the judge's turn, the title's turn and the fallback get their model and effort, the empty ones from the runner's default", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-runner-choice-"));
    const claudeStarts: StartOptions[] = [];
    const codexStarts: StartOptions[] = [];
    const ok: AgentEvent[] = [{ t: "message.delta", role: "assistant", text: "直しました" }, { t: "session.end", status: "ok", summary: "直しました" }];
    const failing: AgentEvent[] = [{ t: "error", message: "limit" }, { t: "session.end", status: "error" }];
    // the judge and the title are asked through the same adapters as the Tasks: told apart by the prompt, and by persistSession false
    const asked = (starts: StartOptions[], what: "judge" | "title") => starts.filter((s) => s.persistSession === false && s.prompt.startsWith(what === "title" ? "あなたはエージェントのタスクに短いタイトル" : "あなたはエージェントのタスクが"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(ok, { starts: claudeStarts, efforts: ["low", "high"] }), fakeAdapter(failing, { id: "codex", starts: codexStarts, models: ["m-a", "m-b"], efforts: ["low", "high"] })], { port: 0, selfdevChecks: false, gh: NO_GH, judge: undefined, titleSuggester: undefined });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // an auto-started Task (feedback) on codex with no model of its own: the runner's saved default, and a new default moves it
      expect((await patch({ autoStart: { runner: "codex" }, defaultModel: { codex: "m-a" } })).status).toBe(200);
      const first = await fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text: "要望 1" }) }).then(j);
      await waitFor(async () => codexStarts.some((s) => s.persistSession !== false));
      expect(first.runner).toBe("codex");
      expect(codexStarts.find((s) => s.persistSession !== false)!.model).toBe("m-a");
      expect((await patch({ defaultModel: { codex: "m-b" } })).status).toBe(200);
      codexStarts.length = 0;
      await fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text: "要望 2" }) }).then(j);
      await waitFor(async () => codexStarts.some((s) => s.persistSession !== false));
      expect(codexStarts.find((s) => s.persistSession !== false)!.model).toBe("m-b");

      // the judge: its model empty = codex's default; the effort saved is sent; titles: their own model and effort; both fall to the judge's fallback
      expect((await patch({ judge: { model: "", effort: "low" }, titles: { model: "t-model", effort: "high" }, judgeAndChoice: { judgeFallbackEffort: "low" } })).status).toBe(200);
      expect((await patch({ judge: { effort: "nope" } })).status).toBe(400);
      expect((await patch({ titles: { effort: "nope" } })).status).toBe(400);
      codexStarts.length = 0;
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, runner: "claude", prompt: "README の誤字を直して" }) }).then(j);
      await waitFor(async () => asked(claudeStarts, "title").length > 0);
      await waitFor(async () => asked(claudeStarts, "judge").length > 0);
      expect(asked(codexStarts, "judge")[0]).toMatchObject({ model: "m-b", effort: "low" });
      expect(asked(codexStarts, "title")[0]).toMatchObject({ model: "t-model", effort: "high" });
      expect(asked(claudeStarts, "judge")[0]).toMatchObject({ model: "claude-haiku-4-5", effort: "low" });
      expect(asked(claudeStarts, "title")[0]).toMatchObject({ model: "claude-haiku-4-5", effort: "low" });

      // a runner change goes back to the runner's default; the same runner keeps what was saved
      const changed = await patch({ judge: { runner: "claude" }, titles: { runner: "claude" }, judgeAndChoice: { judgeFallbackRunner: "codex" }, routing: { llm: { runner: "codex" } } }).then(j);
      expect(changed.judge).toMatchObject({ runner: "claude", model: "", effort: "" });
      expect(changed.titles).toMatchObject({ runner: "claude", model: "", effort: "" });
      expect(changed.judgeAndChoice).toMatchObject({ judgeFallbackRunner: "codex", judgeFallbackModel: "", judgeFallbackEffort: "" });
      expect((await patch({ newDefaults: { taskRunner: "codex", taskModel: "m-x", taskEffort: "high" } }).then(j)).newDefaults).toMatchObject({ taskRunner: "codex", taskModel: "m-x", taskEffort: "high" });
      expect((await patch({ newDefaults: { taskRunner: "claude" } }).then(j)).newDefaults).toMatchObject({ taskRunner: "claude", taskModel: "", taskEffort: "" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("既定に戻す of the jobs card is taken on an instance without every runner of the shipped defaults: a default's runner is accepted as it is on a new instance, another missing runner is still 400", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-reset-jobs-"));
    // claude alone is installed; the shipped defaults name other runners for some rows
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { efforts: ["low", "high"] })], { port: 0, selfdevChecks: false, gh: NO_GH, judge: undefined, titleSuggester: undefined });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const d = (await fetch(`${b}/api/settings`).then(j)).defaults;
      const named = [d.newDefaults.taskRunner, d.judge.runner, d.judgeAndChoice.judgeFallbackRunner, d.routing.llm.runner, d.titles.runner];
      expect(named.some((r: string) => r !== "claude")).toBe(true); // else this instance proves nothing
      expect((await patch({ judge: { runner: "claude" }, titles: { runner: "claude" } })).status).toBe(200);
      // what the card's button sends (apps/web/src/settingsDefaults.ts, `jobsCard`)
      const reset = {
        autoStart: null,
        reviewRunner: null,
        newDefaults: { taskRunner: d.newDefaults.taskRunner, taskModel: d.newDefaults.taskModel, taskEffort: d.newDefaults.taskEffort },
        judge: { runner: d.judge.runner, model: d.judge.model, effort: d.judge.effort },
        judgeAndChoice: { judgeFallbackRunner: d.judgeAndChoice.judgeFallbackRunner, judgeFallbackModel: d.judgeAndChoice.judgeFallbackModel, judgeFallbackEffort: d.judgeAndChoice.judgeFallbackEffort },
        routing: { llm: { runner: d.routing.llm.runner, model: d.routing.llm.model, effort: d.routing.llm.effort } },
        titles: { runner: d.titles.runner, model: d.titles.model, effort: d.titles.effort },
      };
      const r = await patch(reset);
      expect([r.status, r.status === 200 ? "" : await r.text()]).toEqual([200, ""]);
      const now = await fetch(`${b}/api/settings`).then(j);
      expect([now.newDefaults.taskRunner, now.judge.runner, now.judgeAndChoice.judgeFallbackRunner, now.routing.llm.runner, now.titles.runner]).toEqual(named);
      // a runner that is neither installed nor the default of that row is refused as before
      for (const body of [{ judge: { runner: "dak" } }, { titles: { runner: "dak" } }, { routing: { llm: { runner: "dak" } } }, { judgeAndChoice: { judgeFallbackRunner: "dak" } }, { newDefaults: { taskRunner: "dak" } }]) {
        expect([JSON.stringify(body), (await patch(body)).status]).toEqual([JSON.stringify(body), 400]);
      }
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("bedrock: PATCH saves a region per runner, null goes back, a runner without bedrockModel is 400, the health lists the Bedrock models and the kind", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-bedrock-"));
    const cwd = mkdtempSync(join(tmpdir(), "switchboard-bedrock-cwd-"));
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    // the Claude account's login is expired: the lapse must never turn into Bedrock by itself
    const claude = fakeAdapter(script, { starts, models: ["claude-haiku-5-5"], bedrockModel: claudeBedrockModel, detect: () => ({ login: "expired", loginKind: undefined, loginExpiresAt: 1_800_000_000_000 }) });
    const cx = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [claude, fakeAdapter(script, { id: "dak" })], { port: 0 });
    const b = `http://127.0.0.1:${cx.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = (id: string) => fetch(`${b}/api/health`).then(j).then((x) => x.runners.find((r: { id: string }) => r.id === id));
    const create = () => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, title: "t", prompt: "p", runner: "claude" }) }).then(j);
    try {
      // no saved setting: the runner's own login (expired here), own models
      expect(await run("claude")).toMatchObject({ login: "expired", bedrockAvailable: true });
      expect((await run("claude")).models.map((x: { value: string }) => x.value)).toEqual(["claude-haiku-5-5"]);
      expect((await run("claude")).loginKind).toBeUndefined();
      expect((await fetch(`${b}/api/settings`).then(j)).bedrock).toEqual({});
      // only the region is kept; a bad region and a runner without Bedrock models are refused and save nothing
      expect((await patch({ bedrock: { claude: { region: "nowhere" } } })).status).toBe(400);
      expect((await patch({ bedrock: { dak: { region: "us-east-1" } } })).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).bedrock).toEqual({});
      const saved = await patch({ bedrock: { claude: { region: "ap-northeast-1", accessKey: "x" } } }).then(j);
      expect(saved.bedrock).toEqual({ claude: { region: "ap-northeast-1" } });
      expect(await run("claude")).toMatchObject({ login: "ok", loginKind: "bedrock" });
      expect((await run("claude")).loginExpiresAt).toBeUndefined(); // the Claude account's expiry does not apply on Bedrock
      expect((await run("claude")).models.map((x: { value: string }) => x.value)).toEqual(["global.anthropic.claude-haiku-5-5"]);
      expect((await run("dak")).bedrockAvailable).toBe(false);
      await create();
      await Bun.sleep(50);
      expect(starts[0]?.bedrock).toEqual({ region: "ap-northeast-1" });
      // null goes back; a Bedrock turn did not vouch for the Claude account, so the lapse stays
      expect((await patch({ bedrock: { claude: null } })).status).toBe(200);
      expect(await run("claude")).toMatchObject({ login: "expired" });
      expect((await run("claude")).models.map((x: { value: string }) => x.value)).toEqual(["claude-haiku-5-5"]);
      // the lapsed login is not worked around: the next start carries no Bedrock
      await create();
      await Bun.sleep(50);
      expect(starts[1]?.bedrock).toBeUndefined();
    } finally {
      await cx.stop();
      rmSync(h, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("bedrock from the CLI: health says so and the ledger bills bedrock", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-bedrock-cli-"));
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    // the CLI's own settings put it on Bedrock: nothing is saved here
    const claude = fakeAdapter(script, { models: ["claude-haiku-5-5"], detect: () => ({ login: "ok", loginKind: "bedrock", bedrockFrom: "cli" }) });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [claude], { port: 0, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const run = () => fetch(`${b}/api/health`).then(j).then((x) => x.runners.find((r: { id: string }) => r.id === "claude"));
    try {
      expect(await run()).toMatchObject({ login: "ok", loginKind: "bedrock", bedrockFrom: "cli" });
      expect((await fetch(`${b}/api/settings`).then(j)).bedrock).toEqual({});
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude", model: "claude-haiku-5-5" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      const rows = await fetch(`${b}/api/ledger/tasks?billing=bedrock`).then(j);
      expect(rows.map((r: { taskId: string }) => r.taskId)).toEqual([t.id]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("bedrockRunning counts live tasks started on Bedrock", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-bedrock-running-"));
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const claude = fakeAdapter(script, { models: ["claude-haiku-5-5"], bedrockModel: claudeBedrockModel, gate, detect: () => ({ login: "ok", loginKind: "claude.ai" }) });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [claude], { port: 0, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = () => fetch(`${b}/api/health`).then(j).then((x) => x.runners.find((r: { id: string }) => r.id === "claude"));
    try {
      expect((await run()).bedrockRunning).toBeUndefined();
      expect((await patch({ bedrock: { claude: { region: "ap-northeast-1" } } })).status).toBe(200);
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude" }) }).then(j);
      await waitFor(async () => (await run()).bedrockRunning === 1);
      // the setting goes back: the Task still runs on Bedrock, and the count says so
      expect((await patch({ bedrock: { claude: null } })).status).toBe(200);
      expect(await run()).toMatchObject({ loginKind: "claude.ai", bedrockRunning: 1 });
      expect((await run()).bedrockFrom).toBeUndefined();
      release();
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect((await run()).bedrockRunning).toBeUndefined();
    } finally {
      release();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("bedrock models follow the saved list", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-bedrock-list-"));
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const claude = fakeAdapter(script, { starts, models: ["claude-haiku-5-5"], bedrockModel: claudeBedrockModel, detect: () => ({ login: "ok", loginKind: "claude.ai" }) });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [claude], { port: 0, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = () => fetch(`${b}/api/health`).then(j).then((x) => x.runners.find((r: { id: string }) => r.id === "claude"));
    const values = (l: { value: string }[]) => l.map((m) => m.value);
    try {
      // not on Bedrock: `models` is the list, and there is no separate one to edit
      expect(values((await run()).models)).toEqual(["claude-haiku-5-5"]);
      expect((await run()).listModels).toBeUndefined();
      expect((await patch({ bedrock: { claude: { region: "ap-northeast-1" } } })).status).toBe(200);
      expect(values((await run()).models)).toEqual(["global.anthropic.claude-haiku-5-5"]);
      expect(values((await run()).listModels)).toEqual(["claude-haiku-5-5"]);
      // a model saved in the list shows by its Bedrock id, and the list to edit keeps the original id
      expect((await patch({ models: { claude: [{ value: "claude-haiku-5-5", label: "haiku" }, { value: "claude-fable-5-2", label: "fable" }] } })).status).toBe(200);
      expect(values((await run()).models)).toEqual(["global.anthropic.claude-haiku-5-5", "global.anthropic.claude-fable-5-2"]);
      expect(values((await run()).listModels)).toEqual(["claude-haiku-5-5", "claude-fable-5-2"]);
      // one added later shows too
      expect((await patch({ models: { claude: [{ value: "claude-haiku-5-5", label: "haiku" }, { value: "claude-fable-5-2", label: "fable" }, { value: "claude-opus-5-5", label: "opus" }] } })).status).toBe(200);
      expect(values((await run()).models)).toContain("global.anthropic.claude-opus-5-5");
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "claude", model: "global.anthropic.claude-fable-5-2" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(starts[0]).toMatchObject({ model: "global.anthropic.claude-fable-5-2", bedrock: { region: "ap-northeast-1" } });
      // back: the saved list as it is
      expect((await patch({ bedrock: { claude: null } })).status).toBe(200);
      expect(values((await run()).models)).toEqual(["claude-haiku-5-5", "claude-fable-5-2", "claude-opus-5-5"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("runner default model: PATCH saves a model / effort per runner (undetected, no-model runner, empty, bad effort are 400), a Task made without them gets them, given ones win, none saved stays empty", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-runner-default-model-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { id: "codex", starts, models: ["fake-big", "fake-small"], efforts: ["low", "high"] }), fakeAdapter(script, { id: "dak" })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const post = (body: unknown) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    try {
      // (d) nothing saved: as before
      const none = await post({ cwd: h, title: "n", prompt: "p", runner: "codex" });
      expect(none.model).toBeNull();
      expect(none.effort).toBeNull();
      expect(starts[0]?.model).toBeUndefined();
      expect(starts[0]?.effort).toBeUndefined();
      expect((await patch({ defaultModel: { gone: "x" } })).status).toBe(400);
      expect((await patch({ defaultModel: { dak: "x" } })).status).toBe(400);
      expect((await patch({ defaultModel: { codex: "" } })).status).toBe(400);
      expect((await patch({ defaultEffort: { codex: "nope" } })).status).toBe(400);
      // (a) saved and shown in settings and in the runner list
      expect((await patch({ defaultModel: { codex: "fake-big" }, defaultEffort: { codex: "high" } })).status).toBe(200);
      const s = await fetch(`${b}/api/settings`).then(j);
      expect(s.defaultModel).toEqual({ codex: "fake-big" });
      expect(s.defaultEffort).toEqual({ codex: "high" });
      expect(s.runners.find((r: { id: string }) => r.id === "codex")).toMatchObject({ defaultModel: "fake-big", defaultEffort: "high" });
      // (b) a Task created without them gets them
      const t = await post({ cwd: h, title: "t", prompt: "p", runner: "codex" });
      expect(t).toMatchObject({ model: "fake-big", effort: "high" });
      expect(starts[1]).toMatchObject({ model: "fake-big", effort: "high" });
      // (c) the given ones win
      const g = await post({ cwd: h, title: "g", prompt: "p", runner: "codex", model: "fake-small", effort: "low" });
      expect(g).toMatchObject({ model: "fake-small", effort: "low" });
      expect(starts[2]).toMatchObject({ model: "fake-small", effort: "low" });
      // null removes
      expect((await patch({ defaultModel: { codex: null }, defaultEffort: { codex: null } })).status).toBe(200);
      expect((await fetch(`${b}/api/settings`).then(j)).defaultModel).toEqual({});
      const back = await post({ cwd: h, title: "b", prompt: "p", runner: "codex" });
      expect(back.model).toBeNull();
    } finally {
      await c.stop();
    }
  });

  test("runner default model: a saved effort the CLI no longer offers is dropped (the Task is still made), and the Fable budget follows the saved default model", async () => {
    const starts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-runner-default-stale-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { id: "claude", starts, models: ["claude-fable-5-2", "claude-sonnet-5-5"], efforts: ["low", "high"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const post = (body: unknown) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    try {
      // a model of only spaces is empty
      expect((await patch({ defaultModel: { claude: "  " } })).status).toBe(400);
      expect((await patch({ defaultModel: { claude: "claude-fable-5-2" }, quotaAndResume: { defaultBudgetUsd: 5, fableBudgetUsd: 20 } })).status).toBe(200);
      // an effort saved before the CLI dropped it (written as the stored row, which PATCH would refuse now)
      c.db.setSetting("settings", { ...(c.db.getSetting("settings", {}) as object), defaultEffort: { claude: "max" } });
      const t = await post({ cwd: h, title: "t", prompt: "p", runner: "claude" });
      expect(t).toMatchObject({ model: "claude-fable-5-2", effort: null, budgetUsd: 20 });
      expect(starts[0]?.effort).toBeUndefined();
      // a given non-Fable model takes the plain default budget
      const g = await post({ cwd: h, title: "g", prompt: "p", runner: "claude", model: "claude-sonnet-5-5" });
      expect(g).toMatchObject({ model: "claude-sonnet-5-5", budgetUsd: 5 });
    } finally {
      await c.stop();
    }
  });

  test("subagentModel: PATCH saves a value for claude (other runner / empty or blank is 400, null removes), a local claude Task fixes it at creation and a resume keeps it, codex gets none", async () => {
    const starts: StartOptions[] = [];
    const cxStarts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-subagent-model-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { starts }), fakeAdapter(script, { id: "codex", starts: cxStarts })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).subagentModel).toEqual({});
      expect((await patch({ subagentModel: { codex: "x" } })).status).toBe(400);
      expect((await patch({ subagentModel: { claude: "" } })).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).subagentModel).toEqual({});
      expect((await patch({ subagentModel: { claude: "x" } }).then(j)).subagentModel).toEqual({ claude: "x" });
      const info = (await fetch(`${b}/api/settings`).then(j)).runners as Array<{ id: string; subagentModel?: string; subagents?: boolean }>;
      expect(info.find((r) => r.id === "claude")).toMatchObject({ subagentModel: "x", subagents: true });
      expect(info.find((r) => r.id === "codex")?.subagents).toBeUndefined();
      const t = await post("/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude" }).then(j);
      expect(t.subagentModel).toBe("x");
      expect(starts[0]?.subagentModel).toBe("x");
      await waitFor(async () => c.db.getTask(t.id)?.status === "done");
      // the setting changes later; this Task keeps what it was created with, read back from its row
      expect((await patch({ subagentModel: { claude: "y" } })).status).toBe(200);
      await c.tasks.release(t.id);
      await post(`/api/tasks/${t.id}/send`, { text: "again" });
      expect(starts[1]).toMatchObject({ subagentModel: "x", resumeSessionId: "sess-1" });
      expect((await patch({ subagentModel: { claude: "  " } })).status).toBe(400);
      const cx = await post("/api/tasks", { cwd: h, title: "cx", prompt: "p", runner: "codex" }).then(j);
      expect(cx.subagentModel).toBeNull();
      expect(cxStarts[0]?.subagentModel).toBeUndefined();
      expect((await patch({ subagentModel: { claude: null } }).then(j)).subagentModel).toEqual({});
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("subagentEffort: PATCH saves a value for claude (bad value / other runner is 400, null removes), a local claude Task fixes it at creation and a resume keeps it, codex gets none", async () => {
    const starts: StartOptions[] = [];
    const cxStarts: StartOptions[] = [];
    const script = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "tool.call" && e.t !== "tool.result");
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-subagent-effort-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script, { starts, efforts: ["low", "medium"] }), fakeAdapter(script, { id: "codex", starts: cxStarts, efforts: ["medium"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const post = (path: string, body: unknown) => fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const task = (id: string) => fetch(`${b}/api/tasks/${id}`).then(j);
    const done = (id: string) => waitFor(async () => (await task(id)).task.status === "done");
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).subagentEffort).toEqual({});
      expect((await patch({ subagentEffort: { claude: "nope" } })).status).toBe(400);
      expect((await patch({ subagentEffort: { gone: "low" } })).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).subagentEffort).toEqual({});
      expect((await patch({ subagentEffort: { claude: "medium" } }).then(j)).subagentEffort).toEqual({ claude: "medium" });
      expect((await fetch(`${b}/api/settings`).then(j)).subagentEffort).toEqual({ claude: "medium" });
      const t = await post("/api/tasks", { cwd: h, title: "t", prompt: "p", runner: "claude" }).then(j);
      expect(t.subagentEffort).toBe("medium");
      expect(starts[0]?.subagentEffort).toBe("medium");
      await done(t.id);
      // the setting changes later; this Task keeps what it was created with
      expect((await patch({ subagentEffort: { claude: "low" } })).status).toBe(200);
      await c.tasks.release(t.id);
      await post(`/api/tasks/${t.id}/send`, { text: "again" });
      expect(starts[1]).toMatchObject({ subagentEffort: "medium", resumeSessionId: "sess-1" });
      // only a Task created after the change gets the new value; codex never does
      const t2 = await post("/api/tasks", { cwd: h, title: "t2", prompt: "p", runner: "claude" }).then(j);
      expect(t2.subagentEffort).toBe("low");
      expect((await patch({ subagentEffort: { codex: "medium" } })).status).toBe(400);
      const cx = await post("/api/tasks", { cwd: h, title: "cx", prompt: "p", runner: "codex" }).then(j);
      expect(cx.subagentEffort).toBeNull();
      expect(cxStarts[0]?.subagentEffort).toBeUndefined();
      // a claude shadow of a codex Task takes claude's setting too
      const lowStarts = () => starts.filter((s) => s.subagentEffort === "low").length;
      const before = lowStarts();
      const cx2 = await post("/api/tasks", { cwd: h, title: "cx2", prompt: "p", runner: "codex", shadowRunner: "claude" }).then(j);
      const shadowId = ((await fetch(`${b}/api/tasks`).then(j)) as TaskSummary[]).find((x) => x.shadowOf === cx2.id)!.id;
      const shadow = (await fetch(`${b}/api/tasks/${shadowId}`).then(j)).task as Task;
      expect(shadow).toMatchObject({ runner: "claude", subagentEffort: "low" });
      await waitFor(async () => lowStarts() > before);
      expect((await patch({ subagentEffort: { claude: null, codex: null } }).then(j)).subagentEffort).toEqual({});
      const t3 = await post("/api/tasks", { cwd: h, title: "t3", prompt: "p", runner: "claude" }).then(j);
      expect(t3.subagentEffort).toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("bedrock: codex with bedrockModel can be switched, lists the Bedrock models, shows no expired login and bills at the API price", async () => {
    const starts: StartOptions[] = [];
    const h = mkdtempSync(join(tmpdir(), "switchboard-bedrock-codex-"));
    // a codex-like runner: tokens only, the model it was started with
    const script: AgentEvent[] = [
      { t: "session.start", runner: "codex", runnerSessionId: "c1", cwd: "/tmp", model: "openai.gpt-6-luna" },
      { t: "usage", source: "reported", model: "openai.gpt-6-luna", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { t: "session.end", status: "ok" },
    ];
    // the OpenAI login is expired: on Bedrock that must not show
    const codex = fakeAdapter(script, { id: "codex", starts, models: ["gpt-6-luna"], bedrockModel: codexBedrockModel, detect: () => ({ login: "expired" }) });
    const cx = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [codex], { port: 0, gh: NO_GH });
    const b = `http://127.0.0.1:${cx.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const run = () => fetch(`${b}/api/health`).then(j).then((x) => x.runners.find((r: { id: string }) => r.id === "codex"));
    try {
      expect(await run()).toMatchObject({ login: "expired", bedrockAvailable: true });
      expect((await run()).models.map((x: { value: string }) => x.value)).toEqual(["gpt-6-luna"]);
      expect((await patch({ bedrock: { codex: { region: "ap-northeast-1", apiKey: "x" } } }).then(j)).bedrock).toEqual({ codex: { region: "ap-northeast-1" } });
      expect((await fetch(`${b}/api/settings`).then(j)).bedrock).toEqual({ codex: { region: "ap-northeast-1" } });
      expect(await run()).toMatchObject({ login: "ok", loginKind: "bedrock" });
      expect((await run()).models.map((x: { value: string }) => x.value)).toEqual(["openai.gpt-6-luna"]);
      const t = await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "p", runner: "codex", model: "openai.gpt-6-luna" }) }).then(j);
      await waitFor(async () => (await fetch(`${b}/api/tasks/${t.id}`).then(j)).task.status === "done");
      expect(starts[0]?.bedrock).toEqual({ region: "ap-northeast-1" });
      // AWS bills Bedrock: actual cost = the API price of GPT-6 Luna ($0.1 / 1M input), not 0, not unpriced
      const rows = await fetch(`${b}/api/ledger/tasks`).then(j);
      expect(rows[0]).toMatchObject({ taskId: t.id, model: "openai.gpt-6-luna", unpriced: false });
      const s = await fetch(`${b}/api/ledger/summary`).then(j);
      expect(s.todayUsd).toBeCloseTo(0.1, 6);
      expect(s.billedTodayUsd).toBeCloseTo(0.1, 6);
      // back to the subscription: its own models and its own (expired) login again
      expect((await patch({ bedrock: { codex: null } })).status).toBe(200);
      expect(await run()).toMatchObject({ login: "expired" });
      expect((await run()).models.map((x: { value: string }) => x.value)).toEqual(["gpt-6-luna"]);
    } finally {
      await cx.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
