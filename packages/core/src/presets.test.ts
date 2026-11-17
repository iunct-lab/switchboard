import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Preset, PresetExpansion, PresetList, RunnerAdapter, Task } from "@switchboard/protocol";
import type { GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { expandPreset, parseTarget, presetUses, recordPresetUse } from "./presets.ts";
import { startServer, type CoreServer } from "./server.ts";

/* Saved instructions: the pure parts, then /api/presets on a daemon with a fake runner and a fake gh. */

const REPO = "example-org/app";

/** Runs `fn` with AWS_CONFIG_FILE on a made-up config holding one account id, which it is given bare. */
async function withHostAccount<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "presets.aws."));
  writeFileSync(join(dir, "config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const saved = process.env.AWS_CONFIG_FILE;
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  try {
    return await fn(id);
  } finally {
    if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved;
    rmSync(dir, { recursive: true });
  }
}

describe("presets", () => {
  test("parseTarget", () => {
    expect(parseTarget("12")).toEqual({ repo: null, number: 12 });
    expect(parseTarget(" #12 ")).toEqual({ repo: null, number: 12 });
    expect(parseTarget("owner/name#12")).toEqual({ repo: "owner/name", number: 12 });
    expect(parseTarget("https://github.com/owner/name/issues/12")).toEqual({ repo: "owner/name", number: 12 });
    expect(parseTarget("https://github.com/owner/name/pull/12")).toEqual({ repo: "owner/name", number: 12 });
    for (const bad of ["abc", "#0", "owner#3", "", "https://example.com/owner/name/issues/1"]) expect(parseTarget(bad)).toBeNull();
  });

  test("expandPreset replaces every {{target}} and names the target in the title", () => {
    const p: Preset = { id: "pre_1", name: "レビュー対応からマージまで", text: "PR {{target}} の指摘に対応し、{{target}} をマージまで", createdAt: 1, updatedAt: 1 };
    expect(expandPreset(p, REPO, 12)).toEqual({ title: `レビュー対応からマージまで ${REPO}#12`, text: `PR ${REPO}#12 の指摘に対応し、${REPO}#12 をマージまで`, repo: REPO, target: `${REPO}#12` });
    const plain = { ...p, text: "状況を確認して" };
    expect(expandPreset(plain, null, null)).toEqual({ title: p.name, text: "状況を確認して", repo: null, target: null });
  });
});

describe("preset uses", () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;
  const mk = (id: string): Preset => ({ id, name: id, text: "x", createdAt: 1, updatedAt: 1 });
  const withDb = (fn: (db: Db) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "presets.uses."));
    const db = new Db(join(dir, "x.db"));
    try {
      fn(db);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("counts the last 14 days per scene, with the latest time", () =>
    withDb((db) => {
      recordPresetUse(db, "a", "home", NOW - 20 * DAY);
      recordPresetUse(db, "a", "home", NOW - 13 * DAY);
      recordPresetUse(db, "a", "task", NOW - 2 * DAY);
      recordPresetUse(db, "a", "task", NOW - 1 * DAY);
      expect(presetUses(db, [mk("a"), mk("b")], NOW)).toEqual([
        { id: "a", home: 1, task: 2, lastAt: NOW - 1 * DAY },
        { id: "b", home: 0, task: 0, lastAt: null },
      ]);
    }));

  test("without a scene nothing is recorded", () =>
    withDb((db) => {
      recordPresetUse(db, "a", undefined, NOW);
      expect(db.getSetting("presetUses", null)).toBeNull();
      expect(presetUses(db, [mk("a")], NOW)).toEqual([{ id: "a", home: 0, task: 0, lastAt: null }]);
    }));

  test("a use older than 30 days is dropped on the next record", () =>
    withDb((db) => {
      recordPresetUse(db, "a", "task", NOW - 31 * DAY);
      recordPresetUse(db, "a", "task", NOW - 29 * DAY);
      recordPresetUse(db, "a", "task", NOW);
      expect((db.getSetting<{ at: number }[]>("presetUses", []) ?? []).map((u) => u.at)).toEqual([NOW - 29 * DAY, NOW]);
    }));

  test("a deleted preset is not counted", () =>
    withDb((db) => {
      recordPresetUse(db, "gone", "task", NOW);
      recordPresetUse(db, "a", "task", NOW);
      expect(presetUses(db, [mk("a")], NOW).map((u) => u.id)).toEqual(["a"]);
    }));
});

const idle: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start: () => {
    throw new Error("no Task is started by a preset");
  },
};

let core: CoreServer | null = null;
let home = "";
let ghFails = false;
afterEach(async () => {
  await core?.stop();
  core = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const gh: GhRunner = async (args) => (args[0] === "repo" && !ghFails ? { code: 0, stdout: `${REPO} true\n`, stderr: "" } : { code: 1, stdout: "", stderr: "boom" });

async function boot(keepHome = false) {
  if (!keepHome) home = mkdtempSync(join(tmpdir(), "sb-presets-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [idle], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
  return `http://127.0.0.1:${core.server.port}`;
}
const send = (base: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const listAll = async (base: string) => (await (await fetch(`${base}/api/presets`)).json()) as PresetList;
const list = async (base: string) => (await listAll(base)).presets;

describe("/api/presets", () => {
  test("crud", async () => {
    const base = await boot();
    const r = await send(base, "POST", "/api/presets", { name: "レビュー対応からマージまで", text: "PR {{target}} のレビューに対応してマージまで" });
    expect(r.status).toBe(201);
    const p = (await r.json()) as Preset;
    expect(p.id).toStartWith("pre_");
    expect((await list(base)).map((x) => x.name)).toEqual(["レビュー対応からマージまで"]);
    expect((await send(base, "POST", "/api/presets", { name: "レビュー対応からマージまで", text: "別" })).status).toBe(409);
    expect((await send(base, "POST", "/api/presets", { name: " ", text: "x" })).status).toBe(400);
    expect((await send(base, "POST", "/api/presets", { name: "許可つき", text: "x", permissionMode: "bypassPermissions" })).status).toBe(400);
    expect((await send(base, "POST", "/api/presets", { name: "秘密", text: `token ghp_${"a1B2".repeat(9)}` })).status).toBe(400);
    // an account id of the host's AWS config, written bare
    expect((await withHostAccount((id) => send(base, "POST", "/api/presets", { name: "アカウント", text: `メモ ${id}` }))).status).toBe(400);
    const e = await send(base, "PATCH", `/api/presets/${p.id}`, { name: "マージまで", text: "PR {{target}} をマージまで" });
    expect(e.status).toBe(200);
    expect(await list(base)).toEqual([expect.objectContaining({ id: p.id, name: "マージまで", text: "PR {{target}} をマージまで" })]);
    expect((await send(base, "PATCH", `/api/presets/${p.id}`, { runner: "codex" })).status).toBe(400);
    expect((await send(base, "PATCH", "/api/presets/pre_none", { name: "x" })).status).toBe(404);
    expect((await send(base, "DELETE", "/api/presets/pre_none")).status).toBe(404);
    expect((await send(base, "DELETE", `/api/presets/${p.id}`)).status).toBe(200);
    expect(await list(base)).toEqual([]);
  });

  test("survives restart", async () => {
    const base = await boot();
    await send(base, "POST", "/api/presets", { name: "状況の確認", text: "今の状況を確認して" });
    await core!.stop();
    core = null;
    const again = await boot(true);
    expect((await list(again)).map((x) => x.name)).toEqual(["状況の確認"]);
  });

  test("expand", async () => {
    const base = await boot();
    const ws = core!.db.upsertWorkspace({ path: home, name: "dev", kind: "repo" });
    const p = (await (await send(base, "POST", "/api/presets", { name: "マージまで", text: "PR {{target}} の指摘に対応して {{target}} をマージ" })).json()) as Preset;
    const plain = (await (await send(base, "POST", "/api/presets", { name: "状況の確認", text: "今の状況を確認して" })).json()) as Preset;
    const expand = (id: string, body: unknown) => send(base, "POST", `/api/presets/${id}/expand`, body);
    const ok = await expand(p.id, { workspaceId: ws.id, target: "#12" });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as PresetExpansion).toEqual({ title: `マージまで ${REPO}#12`, text: `PR ${REPO}#12 の指摘に対応して ${REPO}#12 をマージ`, repo: REPO, target: `${REPO}#12` });
    expect(((await (await expand(p.id, { workspaceId: ws.id, target: "EXAMPLE-ORG/App#12" })).json()) as PresetExpansion).target).toBe(`${REPO}#12`);
    expect(((await (await expand(plain.id, { workspaceId: ws.id })).json()) as PresetExpansion).text).toBe("今の状況を確認して");
    const refused = async (body: unknown, status: number, id = p.id) => {
      const r = await expand(id, body);
      expect(r.status).toBe(status);
      return ((await r.json()) as { error: string }).error;
    };
    expect(await refused({ workspaceId: ws.id, target: " " }, 400)).toContain("対象");
    expect(await refused({ target: "#12" }, 400)).toContain("Workspace");
    expect(await refused({ workspaceId: ws.id, target: "abc" }, 400)).toContain("書き方");
    expect(await refused({ workspaceId: ws.id, target: "other/repo#3" }, 409)).toBe(`対象 other/repo#3 は Workspace dev のリポジトリ ${REPO} ではありません`);
    await refused({ workspaceId: ws.id, target: "#3" }, 400, plain.id);
    await refused({ workspaceId: "ws_none", target: "#3" }, 404);
    await refused({ workspaceId: ws.id, target: "#3" }, 404, "pre_none");
    await refused({ workspaceId: ws.id, target: "#3", permissionMode: "acceptEdits" }, 400);
    ghFails = true;
    try {
      await refused({ workspaceId: ws.id, target: "#12" }, 424);
    } finally {
      ghFails = false;
    }
    expect((await (await fetch(`${base}/api/tasks`)).json()) as Task[]).toEqual([]);
  });

  test("expand with a scene is recorded and listed in uses; without one it is not", async () => {
    const base = await boot();
    const ws = core!.db.upsertWorkspace({ path: home, name: "dev", kind: "repo" });
    const p = (await (await send(base, "POST", "/api/presets", { name: "マージまで", text: "PR {{target}} をマージ" })).json()) as Preset;
    const plain = (await (await send(base, "POST", "/api/presets", { name: "状況の確認", text: "今の状況を確認して" })).json()) as Preset;
    const expand = (id: string, body: unknown) => send(base, "POST", `/api/presets/${id}/expand`, body);
    expect((await expand(p.id, { workspaceId: ws.id, target: "#1" })).status).toBe(200);
    expect((await listAll(base)).uses.find((u) => u.id === p.id)).toEqual({ id: p.id, home: 0, task: 0, lastAt: null });
    expect((await expand(p.id, { workspaceId: ws.id, target: "#1", scene: "task" })).status).toBe(200);
    expect((await expand(plain.id, { scene: "home" })).status).toBe(200);
    expect((await expand(p.id, { workspaceId: ws.id, target: "abc", scene: "home" })).status).toBe(400);
    expect((await expand(p.id, { workspaceId: ws.id, target: "#1", scene: "other" })).status).toBe(400);
    expect((await expand(p.id, { workspaceId: ws.id, target: "other/repo#1", scene: "home" })).status).toBe(409);
    ghFails = true;
    try {
      expect((await expand(p.id, { workspaceId: ws.id, target: "#1", scene: "home" })).status).toBe(424);
    } finally {
      ghFails = false;
    }
    const uses = (await listAll(base)).uses;
    expect(uses.find((u) => u.id === p.id)).toEqual({ id: p.id, home: 0, task: 1, lastAt: expect.any(Number) });
    expect(uses.find((u) => u.id === plain.id)).toEqual({ id: plain.id, home: 1, task: 0, lastAt: expect.any(Number) });
    await core!.stop();
    core = null;
    expect((await listAll(await boot(true))).uses.find((u) => u.id === p.id)?.task).toBe(1);
  });
});
