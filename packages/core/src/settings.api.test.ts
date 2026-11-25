// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartOptions, Task } from "@switchboard/protocol";
import { Settings, SettingsPatch } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import type { Suggester } from "./routing.ts";
import { JUDGE_FALLBACK, JUDGE_TIMEOUT_MS } from "./judge.ts";
import { FALLBACK_DELAY_MS, fmtTime, MAX_CONSECUTIVE_STOPS, MAX_FALLBACK_DELAY_MS, RESUME_MARGIN_MS, RESUME_PROMPT } from "./ratelimit.ts";
import { QUOTA_LIMIT } from "./backlog-pick.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import { MAX_STOP_RESUMES } from "./interrupted.ts";
import { DEPENDS_LIMIT_MS, SILENT_AFTER_MS, WAIT_LIMIT_MS } from "./waits.ts";
import { NO_HISTORY, SCRIPT, base, core, fakeAdapter, j, startServer, useCoreDaemon } from "./api-test-harness.ts";

useCoreDaemon();

describe("core daemon", () => {
  test("settings: reviewRunner is other until set, keeps what PATCH saved, and refuses other values", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-review-runner-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT)], { port: 0 });
    const b = `http://${"127.0.0.1"}:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = async () => (await fetch(`${b}/api/settings`).then(j)).reviewRunner;
    try {
      expect(await saved()).toBe("other");
      expect((await patch({ reviewRunner: "same" })).status).toBe(200);
      expect(await saved()).toBe("same");
      expect((await patch({ titles: { auto: false } })).status).toBe(200);
      expect(await saved()).toBe("same");
      expect((await patch({ reviewRunner: "codex" })).status).toBe(400);
      expect(await saved()).toBe("same");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 20000);

  test("settings: recheckRunner and the review model / effort are saved by PATCH and shown by GET; null unsets them", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-recheck-runner-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT), fakeAdapter(SCRIPT, { id: "codex", models: ["m-a"], efforts: ["low", "high"] })], { port: 0 });
    const b = `http://${"127.0.0.1"}:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const get = async () => (await fetch(`${b}/api/settings`).then(j)) as Settings;
    try {
      // nothing saved: no recheck setting of its own (it follows the review setting), no review model or effort (the Task's default)
      const fresh = await get();
      expect(fresh).not.toHaveProperty("recheckRunner");
      expect(fresh.reviewModel).toEqual({});
      expect(fresh.reviewEffort).toEqual({});
      expect((await patch({ recheckRunner: "same", reviewModel: { codex: "m-a" }, reviewEffort: { codex: "high" } })).status).toBe(200);
      expect(await get()).toMatchObject({ recheckRunner: "same", reviewModel: { codex: "m-a" }, reviewEffort: { codex: "high" } });
      // an effort the runner does not list, a runner that is not installed and a value that is not a choice are refused
      expect((await patch({ reviewEffort: { codex: "nope" } })).status).toBe(400);
      expect((await patch({ reviewModel: { gone: "x" } })).status).toBe(400);
      expect((await patch({ recheckRunner: "codex" })).status).toBe(400);
      expect(await get()).toMatchObject({ recheckRunner: "same", reviewModel: { codex: "m-a" }, reviewEffort: { codex: "high" } });
      expect((await patch({ recheckRunner: null, reviewModel: { codex: null }, reviewEffort: { codex: null } })).status).toBe(200);
      const back = await get();
      expect(back).not.toHaveProperty("recheckRunner");
      expect(back.reviewModel).toEqual({});
      expect(back.reviewEffort).toEqual({});
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 20000);

  test("autoStart: the default is claude with the CLI's model; PATCH is partial, refuses an undetected runner and resets the model with the runner", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { runner: "dak" } })).status).toBe(400); // not detected here
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart.runner).toBe("claude");
      expect((await patch({ autoStart: { model: "m1" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m1", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      // a runner change on its own goes back to that runner's CLI default; with a model it takes the model
      expect((await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { runner: "claude", model: "m2" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m2", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { runner: "claude" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m2", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" }); // same runner: the model stays
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart effort: empty by default; PATCH keeps one the runner lists, refuses another, and empties it with a runner change; a settings row from before reads as empty", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-effort-"));
    const pre = new Db(join(h, "switchboard.db"));
    pre.setSetting("settings", { autoStart: { runner: "claude", model: "m" } }); // saved before the effort existed
    pre.close();
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, efforts: ["low", "high"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, efforts: ["medium"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { effort: "high" } }).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart.effort).toBe("high");
      const bad = await patch({ autoStart: { effort: "max" } });
      expect(bad.status).toBe(400);
      expect((await j(bad)).error).toContain('unknown effort "max"');
      expect((await patch({ autoStart: { runner: "codex", effort: "high" } })).status).toBe(400); // high is claude's, not codex's
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" }); // a refused PATCH saves nothing
      expect((await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "", effort: "", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { runner: "codex", effort: "medium" } }).then(j)).autoStart.effort).toBe("medium");
      expect((await patch({ autoStart: { effort: "" } }).then(j)).autoStart.effort).toBe(""); // back to the CLI default
      const saved = c.db.getSetting("settings", {}) as Record<string, unknown>;
      c.db.setSetting("settings", { ...saved, autoStart: { runner: "codex", model: "", effort: "ultra" } }); // kept from a version whose list had it
      expect((await patch({ autoStart: { model: "m3" } }).then(j)).autoStart).toEqual({ runner: "codex", model: "m3", effort: "ultra", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" }); // not checked again
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("settings models: no row = the bundled list; PATCH adds, removes and reorders without a restart; null brings the bundled list back; an empty list, a blank or duplicate id, dak and an undetected runner are 400; Bedrock lists the saved list as Bedrock ids", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-settings-models-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { models: ["big", "small"], bedrockModel: (m) => ({ value: `global.${m.value}`, label: m.label }) }), fakeAdapter(SCRIPT, { id: "dak" })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const models = async () => ((await fetch(`${b}/api/health`).then(j)).runners as { id: string; models: { value: string; label: string }[] }[]).find((r) => r.id === "claude")!.models;
    const opt = (value: string, label = value) => ({ value, label });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).models).toEqual({});
      expect(await models()).toEqual([opt("big"), opt("small")]);
      expect((await patch({ models: { claude: [opt("small"), opt(" new ", " "), opt("big", " Big ")] } })).status).toBe(200); // trimmed; a blank label is the id
      expect(await models()).toEqual([opt("small"), opt("new"), opt("big", "Big")]);
      expect((await patch({ models: { claude: [opt("big", "Big"), opt("small")] } })).status).toBe(200); // removed and reordered
      expect(await models()).toEqual([opt("big", "Big"), opt("small")]);
      const saved = await fetch(`${b}/api/settings`).then(j);
      for (const body of [{ claude: [] }, { claude: [opt(" ")] }, { claude: [opt("big"), opt(" big")] }, { dak: [opt("x")] }, { codex: [opt("x")] }]) {
        expect((await patch({ models: body })).status).toBe(400);
        expect(await fetch(`${b}/api/settings`).then(j)).toEqual(saved); // a refused PATCH saves nothing
      }
      expect((await patch({ bedrock: { claude: { region: "us-east-1" } } })).status).toBe(200);
      expect(await models()).toEqual([opt("global.big", "Big"), opt("global.small", "small")]); // the saved list, in its order, as Bedrock ids
      expect((await patch({ bedrock: { claude: null }, models: { claude: null } })).status).toBe(200);
      expect((await fetch(`${b}/api/settings`).then(j)).models).toEqual({});
      expect(await models()).toEqual([opt("big"), opt("small")]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("model candidates: read only when asked; the CLI's models neither listed nor hidden, with the table's names; 載せない hides one until null brings it back; a runner not detected, a missing CLI, an empty table and a failed read answer why", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-model-candidates-"));
    const asked: string[] = [];
    const tables: Record<string, () => string | null> = {
      claude: () => '{id:"big",family:"x",display_name:"Big"},{id:"claude-opus-4-0",family:"x",display_name:"Opus 4"},{id:"claude-test-1",family:"x",display_name:"Test 1"},{id:"claude-test-2",family:"x",display_name:"Test 2"}',
    };
    const modelCatalog = async (runner: "claude" | "codex") => {
      asked.push(runner);
      return tables[runner]!();
    };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { models: ["big", "small"] }), fakeAdapter(SCRIPT, { id: "dak" })], { port: 0, modelCatalog });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const candidates = () => fetch(`${b}/api/settings/model-candidates`).then(j);
    const opt = (value: string, label = value) => ({ value, label });
    try {
      await fetch(`${b}/api/health`).then(j);
      expect(asked).toEqual([]); // booting and reading the settings never read a CLI's table
      expect((await fetch(`${b}/api/settings`).then(j)).defaults.hiddenModels.claude).toContain("claude-opus-4-0");
      // big is listed, claude-opus-4-0 is hidden by the bundled list's 載せない (no row saved yet)
      expect(await candidates()).toEqual([
        { runner: "claude", candidates: [opt("claude-test-1", "Test 1"), opt("claude-test-2", "Test 2")] },
        { runner: "codex", error: "ランナーが検出されていない" }, // no codex adapter here: its 足す / 載せない would be refused
      ]);
      expect(asked).toEqual(["claude"]);
      // 足す = the list's PATCH with the candidate at the end
      expect((await patch({ models: { claude: [opt("big"), opt("small"), opt("claude-test-1", "Test 1")] } })).status).toBe(200);
      expect(((await fetch(`${b}/api/health`).then(j)).runners as { id: string; models: unknown }[]).find((r) => r.id === "claude")!.models).toEqual([opt("big"), opt("small"), opt("claude-test-1", "Test 1")]);
      // 載せない: gone from the candidates and stays gone; null brings the bundled list's 載せない back
      expect((await patch({ hiddenModels: { claude: [" claude-test-2 ", "", "claude-test-2"] } })).status).toBe(200);
      expect((await fetch(`${b}/api/settings`).then(j)).hiddenModels).toEqual({ claude: ["claude-test-2"] });
      expect((await candidates())[0]).toEqual({ runner: "claude", candidates: [opt("claude-opus-4-0", "Opus 4")] });
      expect((await patch({ hiddenModels: { claude: [] } })).status).toBe(200); // [] hides nothing, not even the bundled list's 載せない
      expect((await candidates())[0]).toEqual({ runner: "claude", candidates: [opt("claude-opus-4-0", "Opus 4"), opt("claude-test-2", "Test 2")] });
      expect((await patch({ hiddenModels: { claude: null } })).status).toBe(200);
      expect((await candidates())[0]).toEqual({ runner: "claude", candidates: [opt("claude-test-2", "Test 2")] });
      for (const body of [{ dak: ["x"] }, { codex: ["x"] }]) expect((await patch({ hiddenModels: body })).status).toBe(400);
      // a CLI not on PATH, an empty table, a failed read
      tables.claude = () => null;
      expect((await candidates())[0]).toEqual({ runner: "claude", error: "CLI が PATH に無い" });
      tables.claude = () => "no table";
      expect((await candidates())[0]).toEqual({ runner: "claude", error: "モデル表が 0 件（CLI の形式が変わった）" });
      tables.claude = () => {
        throw new Error("claude: read failed");
      };
      expect((await candidates())[0]).toEqual({ runner: "claude", error: "claude: read failed" });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart by kind: PATCH saves one kind and leaves the others to 共通; null removes it; an undetected runner and an unknown effort are 400; a runner change resets that kind's model and effort; a row without byKind reads as {}", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-kind-"));
    const pre = new Db(join(h, "switchboard.db"));
    pre.setSetting("settings", { autoStart: { runner: "claude", model: "m", effort: "high" } }); // saved before autoStart by kind
    pre.close();
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, efforts: ["low", "high"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, efforts: ["medium"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await get()).autoStart).toEqual({ runner: "claude", model: "m", effort: "high", byKind: {}, fallback: [], fallbackAt: 0.9, completeTaskModel: "" }); // every kind follows 共通
      // a runner change on one kind: that kind's model and effort go back to the CLI default; the others stay on 共通
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex" } } } }).then(j)).autoStart.byKind).toEqual({ check: { runner: "codex", model: "", effort: "" } });
      // without a runner, the base is the common values
      expect((await patch({ autoStart: { byKind: { complete: { model: "m-big" } } } }).then(j)).autoStart.byKind).toEqual({ check: { runner: "codex", model: "", effort: "" }, complete: { runner: "claude", model: "m-big", effort: "high" } });
      // over a kind's saved choice
      expect((await patch({ autoStart: { byKind: { check: { model: "gpt-mini", effort: "medium" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "gpt-mini", effort: "medium" });
      expect((await patch({ autoStart: { byKind: { fix: { runner: "dak" } } } })).status).toBe(400); // not detected here
      const bad = await patch({ autoStart: { byKind: { check: { effort: "high" } } } }); // high is claude's, not codex's
      expect(bad.status).toBe(400);
      expect((await j(bad)).error).toContain('unknown effort "high"');
      expect((await patch({ autoStart: { byKind: { request: { runner: "codex", effort: "high" } } } })).status).toBe(400);
      expect((await get()).autoStart.byKind).toEqual({ check: { runner: "codex", model: "gpt-mini", effort: "medium" }, complete: { runner: "claude", model: "m-big", effort: "high" } }); // a refused PATCH saves nothing
      // a runner change on a kind with its own model and effort: compared with that kind's runner, not the common one (claude here)
      expect((await patch({ autoStart: { byKind: { check: { runner: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "claude", model: "", effort: "" });
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", model: "gpt-mini", effort: "medium" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "gpt-mini", effort: "medium" });
      // the common runner's change leaves the kinds alone
      const common = (await patch({ autoStart: { runner: "codex" } }).then(j)).autoStart;
      expect(common).toEqual({ runner: "codex", model: "", effort: "", byKind: { check: { runner: "codex", model: "gpt-mini", effort: "medium" }, complete: { runner: "claude", model: "m-big", effort: "high" } }, fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      // null: back to 共通
      expect((await patch({ autoStart: { byKind: { check: null } } }).then(j)).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
      expect((await get()).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
      expect((await patch({ autoStart: { byKind: { nope: { runner: "codex" } } } })).status).toBe(200); // unknown keys are dropped, like the rest of SettingsPatch
      expect((await get()).autoStart.byKind).toEqual({ complete: { runner: "claude", model: "m-big", effort: "high" } });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart permission by kind: PATCH keeps a mode the kind's runner lists, refuses a danger one and an unknown one, null goes back to the default, a runner change clears it", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-mode-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, modes: ["auto", "plan", "bypass"], dangerModes: ["bypass"], defaultMode: "auto", models: ["claude-sonnet-5-5", "m-x"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, modes: ["read-only", "plan"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // a mode alone: the kind keeps following the common runner (no runner of its own)
      expect((await patch({ autoStart: { byKind: { check: { permissionMode: "plan" } } } }).then(j)).autoStart.byKind).toEqual({ check: { model: "", effort: "", permissionMode: "plan" } });
      expect((await patch({ autoStart: { byKind: { check: { permissionMode: "bogus" } } } })).status).toBe(400); // claude does not list it
      const danger = await patch({ autoStart: { byKind: { check: { permissionMode: "bypass" } } } });
      expect(danger.status).toBe(400);
      expect(((await danger.json()) as { error: string }).error).toContain("cannot be a default");
      expect((await get()).autoStart.byKind.check.permissionMode).toBe("plan"); // a refused PATCH saves nothing
      // a model on a kind without its own runner pins the common runner, as it does on a kind with no choice (a model belongs to one runner)
      await patch({ autoStart: { byKind: { close: { permissionMode: "plan" } } } });
      expect((await patch({ autoStart: { byKind: { close: { model: "m-x" } } } }).then(j)).autoStart.byKind.close).toEqual({ runner: "claude", model: "m-x", effort: "", permissionMode: "plan" });
      // naming the runner it already follows is no runner change: the mode stays
      expect((await patch({ autoStart: { byKind: { check: { runner: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "claude", model: "", effort: "", permissionMode: "plan" });
      // Task ごとの実装のモデル reads 実装's runner through a choice without one (the common claude here)
      await patch({ autoStart: { byKind: { complete: { permissionMode: "plan" } } } });
      expect((await patch({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } })).status).toBe(200);
      // the kind's own runner decides what is listed
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", permissionMode: "auto" } } } })).status).toBe(400);
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", permissionMode: "read-only" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "", effort: "", permissionMode: "read-only" });
      // a runner change clears the mode (it belongs to one runner)
      expect((await patch({ autoStart: { byKind: { check: { runner: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "claude", model: "", effort: "" });
      // null goes back to the default; a choice left empty is removed
      await patch({ autoStart: { byKind: { request: { permissionMode: "plan" } } } });
      expect((await patch({ autoStart: { byKind: { request: { permissionMode: null } } } }).then(j)).autoStart.byKind.request).toBeUndefined();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart budget and shadow by kind: PATCH saves and clears them; a shadow on the kind's own runner or an undetected one is 400", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-autostart-budget-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // a budget and a shadow alone: the kind keeps following the common runner
      expect((await patch({ autoStart: { byKind: { complete: { budgetUsd: 5, shadow: "codex" } } } }).then(j)).autoStart.byKind).toEqual({ complete: { model: "", effort: "", budgetUsd: 5, shadow: "codex" } });
      expect((await patch({ autoStart: { byKind: { complete: { shadow: "off" } } } }).then(j)).autoStart.byKind.complete).toEqual({ model: "", effort: "", budgetUsd: 5, shadow: "off" });
      // the common runner is claude: a shadow on it, an undetected one and a budget of 0 are refused, and nothing is saved
      expect((await patch({ autoStart: { byKind: { complete: { shadow: "claude" } } } })).status).toBe(400);
      expect((await patch({ autoStart: { byKind: { complete: { shadow: "dak" } } } })).status).toBe(400);
      expect((await patch({ autoStart: { byKind: { complete: { budgetUsd: 0 } } } })).status).toBe(400);
      expect((await get()).autoStart.byKind.complete).toEqual({ model: "", effort: "", budgetUsd: 5, shadow: "off" });
      // the kind's own runner is the one a shadow must differ from
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", shadow: "codex" } } } })).status).toBe(400);
      expect((await patch({ autoStart: { byKind: { check: { runner: "codex", shadow: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "codex", model: "", effort: "", shadow: "claude" });
      // moving the kind onto its 並走's runner drops that 並走 (as a runner change drops the mode); a 並走 sent with it is still checked
      expect((await patch({ autoStart: { byKind: { check: { runner: "claude" } } } }).then(j)).autoStart.byKind.check).toEqual({ runner: "claude", model: "", effort: "" });
      // null clears each; a choice left empty is removed
      expect((await patch({ autoStart: { byKind: { complete: { budgetUsd: null } } } }).then(j)).autoStart.byKind.complete).toEqual({ model: "", effort: "", shadow: "off" });
      expect((await patch({ autoStart: { byKind: { complete: { shadow: null } } } }).then(j)).autoStart.byKind.complete).toBeUndefined();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("shadow default: a detected runner is saved and read back; an undetected one is 400 and nothing changes", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-shadow-default-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await patch({ shadowRunner: "codex" })).status).toBe(200);
      expect((await fetch(`${b}/api/settings`).then(j)).shadowRunner).toBe("codex");
      const refused = await patch({ shadowRunner: "dak" });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe(`runner "dak" is not installed`);
      expect((await fetch(`${b}/api/settings`).then(j)).shadowRunner).toBe("codex");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("complete task model: 同じ by default; PATCH saves a Claude model of claude's list and GET reads it; another runner's 実装, an unknown model or one without a subagent alias is 400; \"\" goes back to 同じ", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-task-model-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true, models: ["claude-opus-5-5", "claude-sonnet-5-5", "m-plain"] }), fakeAdapter(SCRIPT, { id: "codex", lingers: true, models: ["gpt-6"] })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await get()).autoStart.completeTaskModel).toBe("");
      expect((await patch({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } })).status).toBe(200);
      expect((await get()).autoStart.completeTaskModel).toBe("claude-sonnet-5-5");
      expect((await patch({ autoStart: { completeTaskModel: "claude-haiku-9" } })).status).toBe(400); // not in claude's list
      expect((await patch({ autoStart: { completeTaskModel: "m-plain" } })).status).toBe(400); // listed, but no subagent alias
      expect((await patch({ autoStart: { completeTaskModel: "gpt-6" } })).status).toBe(400); // another runner's
      // 実装 on codex: no trial there, even with a Claude model
      expect((await patch({ autoStart: { byKind: { complete: { runner: "codex" } }, completeTaskModel: "claude-opus-5-5" } })).status).toBe(400);
      expect((await get()).autoStart).toMatchObject({ byKind: {}, completeTaskModel: "claude-sonnet-5-5" }); // a refused PATCH saves nothing
      // 実装 following 共通 on codex is refused too; "" (同じ) is always accepted
      expect((await patch({ autoStart: { runner: "codex" } })).status).toBe(200);
      expect((await patch({ autoStart: { completeTaskModel: "claude-opus-5-5" } })).status).toBe(400);
      expect((await patch({ autoStart: { completeTaskModel: "" } })).status).toBe(200);
      expect((await get()).autoStart.completeTaskModel).toBe("");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart fallback: the order is empty and the threshold 0.9 by default; PATCH replaces the order whole and refuses an undetected runner or a threshold out of range", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-fallback-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toMatchObject({ fallback: [], fallbackAt: 0.9, completeTaskModel: "" });
      expect((await patch({ autoStart: { fallback: ["codex", "claude"], fallbackAt: 0.85 } }).then(j)).autoStart).toMatchObject({ runner: "claude", fallback: ["codex", "claude"], fallbackAt: 0.85 });
      expect((await patch({ autoStart: { fallback: ["codex"] } }).then(j)).autoStart).toMatchObject({ fallback: ["codex"], fallbackAt: 0.85 });
      for (const body of [{ autoStart: { fallback: ["codex", "dak"] } }, { autoStart: { fallbackAt: 0.4 } }, { autoStart: { fallbackAt: 1.1 } }]) expect((await patch(body)).status).toBe(400);
      expect((await fetch(`${b}/api/settings`).then(j)).autoStart).toMatchObject({ fallback: ["codex"], fallbackAt: 0.85 }); // a refused PATCH saves nothing
      expect((await patch({ autoStart: { fallback: [] } }).then(j)).autoStart.fallback).toEqual([]);
      // a runner saved in the order that is no longer detected does not lock it: the order can be edited around it
      const saved = c.db.getSetting("settings", {}) as Record<string, any>;
      c.db.setSetting("settings", { ...saved, autoStart: { ...saved.autoStart, fallback: ["codex", "dak"] } });
      expect((await patch({ autoStart: { fallback: ["dak"] } }).then(j)).autoStart.fallback).toEqual(["dak"]);
      expect((await patch({ autoStart: { fallback: ["dak", "codex"] } }).then(j)).autoStart.fallback).toEqual(["dak", "codex"]);
      expect((await patch({ autoStart: { fallback: ["codex"] } }).then(j)).autoStart.fallback).toEqual(["codex"]);
      expect((await patch({ autoStart: { fallback: ["codex", "dak"] } })).status).toBe(400); // once out of the order, dak is new again
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart fallback: feedback and a prompt schedule start on the order's next runner while the decided one is at its limit, on the CLI default model, with a status line; not when every runner is, nor with an empty order", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-fallback-start-"));
    const claudeStarts: StartOptions[] = [];
    const codexStarts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "quota"), { starts: claudeStarts }), fakeAdapter(SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "quota"), { id: "codex", starts: codexStarts })], { port: 0, selfdevChecks: false, dryRunRestart: true });
    const b = `http://127.0.0.1:${c.server.port}`;
    const feedback = (text: string, mode?: "fix") => fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text, ...(mode ? { mode } : {}) }) }).then(async (r) => [r.status, await r.json()] as [number, Task]);
    const statuses = (id: string) => c.db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
    const until = async (ok: () => boolean) => { for (let i = 0; !ok() && i < 200; i++) await Bun.sleep(10); };
    try {
      const inHour = Math.floor(Date.now() / 1000) + 3600;
      c.db.upsertQuota("claude", "five_hour", 0.95, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-claude", effort: "high", fallback: ["codex"] } });
      // (b, c) the feedback button: codex starts it, without claude's model / effort, and the transcript says why
      const [status, task] = await feedback("上限の間の要望");
      expect(status).toBe(201);
      expect(task.runner).toBe("codex");
      await until(() => codexStarts.length > 0);
      expect(claudeStarts).toHaveLength(0);
      expect(codexStarts[0]!.model).toBeUndefined();
      expect(codexStarts[0]!.effort).toBeUndefined();
      expect(statuses(task.id)).toEqual([`claude が上限（0.95、${fmtTime(inHour * 1000, Date.now())} に戻る）のため codex で開始`]);
      // a kind's own runner at its limit gives way the same
      c.db.setSetting("settings", { autoStart: { runner: "codex", byKind: { fix: { runner: "claude", model: "m-fix", effort: "" } }, fallback: ["claude", "codex"] } });
      const [, fixed] = await feedback("直して", "fix");
      expect(fixed.runner).toBe("codex");
      await until(() => codexStarts.length > 1);
      expect(codexStarts[1]!.model).toBeUndefined();
      // (f) a prompt schedule
      const wsId = c.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
      const sch = await fetch(`${b}/api/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "nightly", cron: "@nightly", workspaceId: wsId, runner: "claude", model: "m-sch", prompt: "run" }) }).then(j);
      const ran = (await fetch(`${b}/api/schedules/${sch.id}/run`, { method: "POST" }).then(j)) as Task;
      expect(ran.runner).toBe("codex");
      await until(() => codexStarts.length > 2);
      expect(codexStarts[2]!.model).toBeUndefined();
      expect(statuses(ran.id)).toEqual([`claude が上限（0.95、${fmtTime(inHour * 1000, Date.now())} に戻る）のため codex で開始`]);
      expect(JSON.stringify(await fetch(`${b}/api/schedules/log`).then(j))).toContain("nightly: claude が上限");
      // (d) codex at its limit too: the decided runner, held until it resets ("defers an automatic start at the limit")
      c.db.upsertQuota("codex", "seven_day", 0.97, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude", fallback: ["codex"] } });
      const [, both] = await feedback("どちらも上限");
      expect(both.runner).toBe("claude");
      expect(both.resumeReason).toBe("start");
      expect(claudeStarts).toHaveLength(0);
      // (e) an empty order: the decided runner, held the same
      c.db.upsertQuota("codex", "seven_day", 0.1, inHour);
      c.db.setSetting("settings", { autoStart: { runner: "claude" } });
      const [, none] = await feedback("順が空");
      expect(none.runner).toBe("claude");
      // a window that has reset is not at its limit
      c.db.upsertQuota("claude", "five_hour", 0.99, Math.floor(Date.now() / 1000) - 60);
      c.db.setSetting("settings", { autoStart: { runner: "claude", fallback: ["codex"] } });
      const [, reset] = await feedback("戻った後");
      expect(reset.runner).toBe("claude");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("defers an automatic start at the limit: with no runner to give way to, feedback is made without starting a runner and starts when the window resets; a runner in the order still takes it now", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-defer-start-"));
    const claudeStarts: StartOptions[] = [];
    const codexStarts: StartOptions[] = [];
    const quiet = SCRIPT.filter((e) => e.t !== "permission.ask" && e.t !== "quota");
    const asked: string[] = []; // the LLM routing advice: a held Task asks none (it would spend the quota it waits for)
    const advice: Suggester = { async suggest(ctx) { asked.push(ctx.title); return { runner: "codex", reason: "llm", ruleId: "llm", model: null, available: true, alternatives: [], llm: null }; } };
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(quiet, { starts: claudeStarts }), fakeAdapter(quiet, { id: "codex", starts: codexStarts })], { port: 0, selfdevChecks: false, dryRunRestart: true, llmSuggester: () => advice });
    const b = `http://127.0.0.1:${c.server.port}`;
    const feedback = (text: string) => fetch(`${b}/api/feedback`, { method: "POST", body: JSON.stringify({ text }) }).then(async (r) => [r.status, await r.json()] as [number, Task]);
    const statuses = (id: string) => c.db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
    try {
      const resetSec = Math.floor(Date.now() / 1000) + 3600;
      c.db.upsertQuota("claude", "seven_day", 0.99, resetSec);
      c.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-claude", fallback: [] }, routing: { llm: { enabled: true, runner: "claude", model: "", timeoutMs: 5000 } } });
      const [status, task] = await feedback("上限の間の要望");
      expect(status).toBe(201);
      expect(task).toMatchObject({ runner: "claude", status: "idle", resumeReason: "start", resumeAt: resetSec * 1000 + RESUME_MARGIN_MS, model: "m-claude" });
      expect(statuses(task.id)).toEqual([`claude が上限（0.99、${fmtTime(resetSec * 1000, Date.now())} に戻る）のため戻る時刻に開始`]);
      await Bun.sleep(100);
      expect(claudeStarts).toHaveLength(0);
      expect(asked).toEqual([]);
      // a runner to give way to: started now on it, as before
      c.db.setSetting("settings", { autoStart: { runner: "claude", fallback: ["codex"] }, routing: { llm: { enabled: true, runner: "claude", model: "", timeoutMs: 5000 } } });
      const [, other] = await feedback("代わりがある");
      expect(other).toMatchObject({ runner: "codex", resumeReason: null, resumeAt: null });
      for (let i = 0; codexStarts.length === 0 && i < 200; i++) await Bun.sleep(10);
      expect(codexStarts).toHaveLength(1);
      expect(claudeStarts).toHaveLength(0);
      for (let i = 0; asked.length === 0 && i < 200; i++) await Bun.sleep(10);
      expect(asked).toHaveLength(1); // a Task started now still gets the advice
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("settings fable default budget: the initial value is null; PATCH saves it, null clears it, a non-positive value is 400", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-fablebudget-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await get()).quotaAndResume.fableBudgetUsd).toBeNull();
      expect((await patch({ quotaAndResume: { fableBudgetUsd: 150 } })).status).toBe(200);
      expect((await get()).quotaAndResume).toMatchObject({ fableBudgetUsd: 150, defaultBudgetUsd: null });
      expect((await patch({ quotaAndResume: { fableBudgetUsd: 0 } })).status).toBe(400);
      expect((await get()).quotaAndResume.fableBudgetUsd).toBe(150);
      expect((await patch({ quotaAndResume: { fableBudgetUsd: null } })).status).toBe(200);
      expect((await get()).quotaAndResume.fableBudgetUsd).toBeNull();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("defaultBudgetUsd: the settings' one value is the budget of a Task made without one; an explicit budget is kept; null puts it back to none", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-defbudget-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const create = (body: object) => fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "t", prompt: "go", ...body }) }).then(j);
    try {
      expect((await create({})).budgetUsd).toBeNull(); // the default of the default: no budget
      expect((await patch({ quotaAndResume: { defaultBudgetUsd: 2 } })).status).toBe(200);
      expect((await create({})).budgetUsd).toBe(2);
      expect((await create({ budgetUsd: 5 })).budgetUsd).toBe(5);
      // a Fable Task takes the Fable value first; other models and an unset Fable value keep the general one
      expect((await create({ model: "claude-fable-5-1" })).budgetUsd).toBe(2);
      expect((await patch({ quotaAndResume: { fableBudgetUsd: 7 } })).status).toBe(200);
      expect((await create({ model: "claude-fable-5-1" })).budgetUsd).toBe(7);
      expect((await create({ model: "claude-opus-5" })).budgetUsd).toBe(2);
      expect((await create({ model: "claude-fable-5-1", budgetUsd: 5 })).budgetUsd).toBe(5);
      expect((await patch({ quotaAndResume: { fableBudgetUsd: null } })).status).toBe(200);
      expect((await patch({ quotaAndResume: { defaultBudgetUsd: 0 } })).status).toBe(400); // positive only
      expect((await patch({ quotaAndResume: { defaultBudgetUsd: null } })).status).toBe(200);
      expect((await create({})).budgetUsd).toBeNull();
    } finally {
      await c.stop();
    }
  });

  test("settings tunables: the defaults are the constants core used; PATCH is partial per group, null puts a group back, out of range is 400 and saves nothing", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-tunables-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // (a) the defaults are today's constants, and GET says what they are
      const first = await get();
      const constants = {
        quotaAndResume: { backlogQuotaLimit: QUOTA_LIMIT, retryDelayMs: FALLBACK_DELAY_MS, retryMaxDelayMs: MAX_FALLBACK_DELAY_MS, maxLimitStops: MAX_CONSECUTIVE_STOPS, resumePrompt: first.quotaAndResume.resumePrompt, maxStopResumes: MAX_STOP_RESUMES, silentAfterMs: SILENT_AFTER_MS, waitLimitMs: WAIT_LIMIT_MS, queueStallMs: 3_600_000, dependsLimitMs: DEPENDS_LIMIT_MS, thinSample: 5, flowLimit: 1, flowShareLimit: 0.25, defaultBudgetUsd: null, fableBudgetUsd: null },
        judgeAndChoice: { judgeFallbackRunner: JUDGE_FALLBACK.runner, judgeFallbackModel: JUDGE_FALLBACK.model, judgeFallbackEffort: "", judgeTimeoutMs: JUDGE_TIMEOUT_MS, workspaceChoiceTimeoutMs: 60_000 },
        newDefaults: { taskRunner: "claude", taskModel: "", taskEffort: "", scheduleCron: "0 3 * * *" },
      };
      expect(`${AUTO_RESUME_HEAD} ${first.quotaAndResume.resumePrompt}`).toBe(RESUME_PROMPT);
      for (const k of ["quotaAndResume", "judgeAndChoice", "newDefaults"] as const) {
        expect(first[k]).toEqual(constants[k]);
        expect(first.defaults[k]).toEqual(constants[k]);
      }
      // (b) a partial patch keeps the other items; null puts the group back
      const changed = await patch({ quotaAndResume: { backlogQuotaLimit: 0.5, maxLimitStops: 3 }, judgeAndChoice: { judgeFallbackRunner: "codex", judgeFallbackModel: "m" }, newDefaults: { scheduleCron: "0 4 * * *" } }).then(j);
      expect(changed.quotaAndResume).toEqual({ ...constants.quotaAndResume, backlogQuotaLimit: 0.5, maxLimitStops: 3 });
      expect(changed.judgeAndChoice).toEqual({ ...constants.judgeAndChoice, judgeFallbackRunner: "codex", judgeFallbackModel: "m" });
      expect(changed.newDefaults).toEqual({ taskRunner: "claude", taskModel: "", taskEffort: "", scheduleCron: "0 4 * * *" });
      expect(changed.defaults.quotaAndResume).toEqual(constants.quotaAndResume);
      expect((await patch({ quotaAndResume: { retryDelayMs: 60_000 } }).then(j)).quotaAndResume).toMatchObject({ backlogQuotaLimit: 0.5, maxLimitStops: 3, retryDelayMs: 60_000 });
      expect((await patch({ quotaAndResume: null }).then(j)).quotaAndResume).toEqual(constants.quotaAndResume);
      const reset = await get();
      expect(reset.quotaAndResume).toEqual(constants.quotaAndResume);
      expect(reset.judgeAndChoice.judgeFallbackRunner).toBe("codex"); // the other groups stay
      const back = await patch({ judgeAndChoice: null, newDefaults: null }).then(j);
      expect(back.judgeAndChoice).toEqual(constants.judgeAndChoice);
      expect(back.newDefaults).toEqual(constants.newDefaults);
      // (c, d) out of range is 400, and nothing of that patch is saved
      await patch({ quotaAndResume: { maxLimitStops: 4 }, newDefaults: { taskRunner: "codex" } });
      const saved = await get();
      for (const body of [
        { quotaAndResume: { backlogQuotaLimit: 0 } },
        { quotaAndResume: { backlogQuotaLimit: 1.1 } },
        { quotaAndResume: { backlogQuotaLimit: -0.1 } },
        { quotaAndResume: { maxLimitStops: 0 } },
        { quotaAndResume: { maxStopResumes: 0 } },
        { quotaAndResume: { thinSample: 0 } },
        { quotaAndResume: { retryDelayMs: -1 } },
        { quotaAndResume: { retryDelayMs: 7_200_000, retryMaxDelayMs: 3_600_000 } },
        { quotaAndResume: { retryDelayMs: 20_000_000 } }, // past the saved maximum of 4 h
        { quotaAndResume: { resumePrompt: "  " } },
        { judgeAndChoice: { judgeTimeoutMs: -5 } },
        { judgeAndChoice: { judgeFallbackRunner: "dak" } }, // not detected here
        { newDefaults: { taskRunner: "dak" } },
        { newDefaults: { scheduleCron: "bogus" } },
        { quotaAndResume: { maxLimitStops: 9 }, newDefaults: { scheduleCron: "bogus" } }, // the valid half is not saved either
      ]) {
        const r = await patch(body);
        expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400]);
      }
      expect(await get()).toEqual(saved);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("settings reset to defaults: GET's defaults hold every setting, and a key sent as null goes back to its default", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-reset-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(SCRIPT, { lingers: true }), fakeAdapter(SCRIPT, { id: "codex", lingers: true })], { port: 0 });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = () => fetch(`${b}/api/settings`).then(j);
    const patch = (body: unknown) => fetch(`${b}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const first = await get();
      // the defaults are the settings of an empty row (the 載せない lists are the bundled ones), and every key of the settings can be patched
      const { hiddenModels, ...defaults } = first.defaults;
      const { hiddenModels: _none, ...fresh } = Settings.parse({});
      expect(defaults).toEqual(fresh);
      expect(Object.keys(SettingsPatch.shape).sort()).toEqual(Object.keys(Settings.shape).sort());
      expect(SettingsPatch.safeParse(Object.fromEntries(Object.keys(Settings.shape).map((k) => [k, null]))).success).toBe(true);
      // each key changed, then put back by null: it reads as the answer's default again, and the keys not sent stay
      const changes: Record<string, unknown> = {
        outbound: { classifierLog: true, runnerTelemetry: true },
        titles: { auto: !first.defaults.titles.auto },
        maxRunners: 5,
        reviewRunner: "same",
        developSelf: !first.defaults.developSelf,
        shadowRunner: "codex",
        judge: { enabled: !first.defaults.judge.enabled },
        evals: { judge: { enabled: !first.defaults.evals.judge.enabled } },
        routing: { llm: { timeoutMs: 30_000 } },
        autoStart: { runner: "codex", fallbackAt: 0.6, byKind: { fix: { budgetUsd: 3 } } },
        release: { checkMinutes: 99 },
        quotaAndResume: { maxLimitStops: 3 },
        prices: { "model-x": { input: 1, output: 2 } },
        autoResume: { claude: true },
      };
      const changed = await patch(changes);
      expect([changed.status, changed.status === 200 ? "" : await changed.text()]).toEqual([200, ""]);
      const saved = await get();
      for (const key of Object.keys(changes)) expect({ key, changed: JSON.stringify(saved[key]) !== JSON.stringify(first[key]) }).toEqual({ key, changed: true });
      for (const key of Object.keys(changes)) {
        const back = await patch({ [key]: null }).then(j);
        expect({ key, value: back[key] }).toEqual({ key, value: key === "hiddenModels" ? {} : back.defaults[key] });
      }
      const { runners: _r, ...end } = await get();
      const { runners: _r0, ...start } = first;
      expect(end).toEqual(start);
      // a value inside a key goes back by sending its default: the key's other values stay
      await patch({ quotaAndResume: { maxLimitStops: 3, fableBudgetUsd: 7 } });
      const one = await patch({ quotaAndResume: { maxLimitStops: first.defaults.quotaAndResume.maxLimitStops } }).then(j);
      expect(one.quotaAndResume).toEqual({ ...first.defaults.quotaAndResume, fableBudgetUsd: 7 });
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("autoStart: a database saved before it starts at the runner of routing.llm; one that has it is left alone", () => {
    const p = join(mkdtempSync(join(tmpdir(), "switchboard-test-autostart-mig-")), "sb.db");
    const first = new Db(p);
    first.setSetting("settings", { routing: { llm: { enabled: true, runner: "codex" } } });
    first.close();
    const migrated = new Db(p);
    expect(migrated.getSetting("settings", {})).toEqual({ routing: { llm: { enabled: true, runner: "codex" } }, autoStart: { runner: "codex", model: "" } });
    migrated.setSetting("settings", { routing: { llm: { runner: "codex" } }, autoStart: { runner: "claude", model: "m" } });
    migrated.close();
    const again = new Db(p);
    expect((again.getSetting("settings", {}) as { autoStart: unknown }).autoStart).toEqual({ runner: "claude", model: "m" });
    again.close();
    const empty = new Db(join(mkdtempSync(join(tmpdir(), "switchboard-test-autostart-mig-")), "sb.db"));
    expect(empty.getSetting("settings", { none: true })).toEqual({ none: true }); // no row: nothing to move
    empty.close();
  });

  test("backlogSweep is gone from the settings: GET has no such key, a PATCH of it changes nothing", async () => {
    const patch = (body: unknown) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect("backlogSweep" in (await fetch(`${base}/api/settings`).then(j))).toBe(false);
    expect("backlogSweep" in (await patch({ backlogSweep: { implement: 2 } }).then(j))).toBe(false);
    expect("backlogSweep" in (core.db.getSetting("settings", {}) as object)).toBe(false);
    expect(core.db.listWorkspaces().every((w) => w.sweep.implement === 1)).toBe(true);
  });
});
