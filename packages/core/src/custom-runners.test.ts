import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomRunner, RunnerId, type RunnerAdapter, type RunnerSession, type StartOptions, type Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { CUSTOM_RUNNERS_KEY, Db } from "./db.ts";
import { startServer, type CoreServer } from "./server.ts";

/* The ADK servers added in Settings (#3384): the `custom:<name>` id, the saved list and GET/PUT /api/custom-runners. */

const SAMPLE: CustomRunner = { port: "adk", name: "sample", label: "Sample agent", url: "http://127.0.0.1:8100", app: "sample_agent", tokenEnv: "SAMPLE_AGENT_TOKEN" };

describe("custom:<name> ids and the list's shape", () => {
  test("RunnerId takes the three built-ins and custom:<name>, nothing else", () => {
    for (const ok of ["claude", "codex", "dak", "custom:sample", "custom:a", "custom:my-agent-2"]) expect(RunnerId.safeParse(ok).success).toBe(true);
    for (const bad of ["custom:", "custom:Sample", "custom:-x", `custom:${"a".repeat(33)}`, "custom:a b", "gemini", "dak2"]) expect(RunnerId.safeParse(bad).success).toBe(false);
  });

  test("an entry has no field for a token's value, and the env name is an env name", () => {
    expect(CustomRunner.safeParse(SAMPLE).success).toBe(true);
    expect(CustomRunner.safeParse({ ...SAMPLE, token: "x" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...SAMPLE, tokenEnv: "lower" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...SAMPLE, url: "file:///etc/passwd" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...SAMPLE, name: "custom:sample" }).success).toBe(false);
  });
});

describe("port: adk | agui (#3407)", () => {
  const AGUI: CustomRunner = { port: "agui", name: "ag", label: "AG-UI agent", url: "http://127.0.0.1:8200/agent", tokenEnv: "AG_TOKEN", sendWorkspaceMcp: false };

  test("agui takes name, label, url, tokenEnv and sendWorkspaceMcp (default false); no ADK fields, no token value", () => {
    expect(CustomRunner.safeParse(AGUI).success).toBe(true);
    const { sendWorkspaceMcp: _, ...bare } = AGUI;
    expect(CustomRunner.parse(bare)).toMatchObject({ sendWorkspaceMcp: false });
    expect(CustomRunner.safeParse({ ...AGUI, app: "x" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...AGUI, token: "x" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...AGUI, port: "other" }).success).toBe(false);
    expect(CustomRunner.safeParse({ ...SAMPLE, sendWorkspaceMcp: true }).success).toBe(false);
  });

  test("a row saved before `port` existed reads as adk; a row with no port that is not an ADK entry is left out", () => {
    const db = new Db(":memory:");
    const { port: _, ...old } = SAMPLE;
    db.setSetting(CUSTOM_RUNNERS_KEY, [old, AGUI, { name: "Bad" }, "x", null]);
    expect(db.getCustomRunners()).toEqual([SAMPLE, AGUI]);
  });

  test("PUT saves an agui entry; the token's value is in neither the table nor the response", async () => {
    const b = await boot([fake("claude", [])]);
    const put = await send(b, "PUT", "/api/custom-runners", [AGUI]);
    expect(put.status).toBe(200);
    expect(await j(put)).toEqual([AGUI]);
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([AGUI]);
    expect((await send(b, "PUT", "/api/custom-runners", [{ ...AGUI, token: "secret-value" }])).status).toBe(400);
    const rows = core!.db.sqlite.query("SELECT json FROM settings").all() as Array<{ json: string }>;
    expect(rows.some((r) => r.json.includes("secret-value"))).toBe(false);
    expect(rows.some((r) => r.json.includes("AG_TOKEN"))).toBe(true);
  });
});

describe("sending the Workspace MCP endpoint to an AG-UI agent (#3408)", () => {
  const AGUI: CustomRunner = { port: "agui", name: "ag", label: "AG-UI agent", url: "http://127.0.0.1:8200/agent", sendWorkspaceMcp: false };
  const KEY = "A".repeat(43);

  /** Start a Task on `custom:ag` and return what the adapter was given. */
  async function mcpOf(runners: CustomRunner[], withAdk = false, env: Record<string, string> = {}, after?: CustomRunner[]) {
    const got: Array<StartOptions["mcpServers"]> = [];
    const adapter = fake("custom:ag", []);
    const start = adapter.start.bind(adapter);
    adapter.start = (opts, emit) => (got.push(opts.mcpServers), start(opts, emit));
    const b = await boot([fake("claude", []), adapter], withAdk ? [{ ...SAMPLE, name: "ag" }] : runners, env);
    if (after) core!.db.setCustomRunners(after); // saved while running: takes effect on the next start
    const t = (await send(b, "POST", "/api/tasks", { cwd: home, title: "t", prompt: "p", runner: "custom:ag" }).then(j)) as Task;
    await new Promise((r) => setTimeout(r, 50));
    return { got, task: t, b };
  }

  test("off by default and when off: no Workspace MCP is handed over", async () => {
    expect(CustomRunner.parse({ port: "agui", name: "ag", label: "x", url: "http://127.0.0.1:1" })).toMatchObject({ sendWorkspaceMcp: false });
    const { got } = await mcpOf([AGUI]);
    expect(got).toEqual([undefined]);
  });

  test("on: the Task's own endpoint and token, only that; the token is in no event and no row", async () => {
    const { got, task, b } = await mcpOf([{ ...AGUI, sendWorkspaceMcp: true }]);
    expect(got.length).toBe(1);
    expect(Object.keys(got[0]!)).toEqual(["workspace"]);
    const ws = got[0]!.workspace!;
    expect(ws.url).toContain(`/mcp/${task.id}`);
    const token = ws.headers!.authorization!.replace("Bearer ", "");
    expect(token.length).toBeGreaterThan(8);
    const events = JSON.stringify(await send(b, "GET", `/api/tasks/${task.id}`).then(j));
    expect(events).not.toContain(token);
    const rows = core!.db.sqlite.query("SELECT json FROM settings").all() as Array<{ json: string }>;
    expect(rows.some((r) => r.json.includes(token))).toBe(false);
  });

  test("an ADK entry is never given it", async () => {
    const { got } = await mcpOf([], true);
    expect(got).toEqual([undefined]);
  });

  test("the list as it was at start decides: removing the entry while running still sends to the adapter built from it", async () => {
    const on = { ...AGUI, sendWorkspaceMcp: true };
    expect((await mcpOf([on], false, {}, [])).got.map((m) => Object.keys(m ?? {}))).toEqual([["workspace"]]);
  });

  test("an entry saved while running sends nothing until the next start, and a custom: runner never gets mcp.yaml's servers", async () => {
    expect((await mcpOf([], false, {}, [{ ...AGUI, sendWorkspaceMcp: true }])).got).toEqual([undefined]);
  });

  test("with passkey login an entry saved before it was turned on is not sent to a non-local URL", async () => {
    const remote = { ...AGUI, url: "https://agents.example.com/agent", sendWorkspaceMcp: true };
    expect((await mcpOf([remote], false, { SWITCHBOARD_SESSION_PUBLIC_KEY: KEY })).got).toEqual([undefined]);
  });

  test("with passkey login a non-local URL is refused when on, and allowed when off; a local one passes", async () => {
    home = mkdtempSync(join(tmpdir(), "sb-custom-runners-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_SESSION_PUBLIC_KEY: KEY });
    core = await startServer(cfg, [fake("claude", [])], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => ({ code: 1, stdout: "", stderr: "no gh" }) });
    const b = `http://127.0.0.1:${core.server.port}`;
    const remote = { ...AGUI, url: "https://agents.example.com/agent" };
    const refused = await send(b, "PUT", "/api/custom-runners", [{ ...remote, sendWorkspaceMcp: true }]);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await j(refused))).toContain("passkey");
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([]);
    expect((await send(b, "PUT", "/api/custom-runners", [remote])).status).toBe(200);
    for (const url of ["http://127.0.0.1:8200/a", "http://localhost:8200/a", "http://[::1]:8200/a"]) {
      expect((await send(b, "PUT", "/api/custom-runners", [{ ...AGUI, url, sendWorkspaceMcp: true }])).status).toBe(200);
    }
  });

  test("without passkey login a non-local URL is accepted when on", async () => {
    const b = await boot([fake("claude", [])]);
    expect((await send(b, "PUT", "/api/custom-runners", [{ ...AGUI, url: "https://agents.example.com/agent", sendWorkspaceMcp: true }])).status).toBe(200);
  });
});

describe("Db.getCustomRunners", () => {
  test("round trip; a row that is not a list reads as none; an entry that does not parse is left out", () => {
    const db = new Db(":memory:");
    expect(db.getCustomRunners()).toEqual([]);
    db.setCustomRunners([SAMPLE]);
    expect(db.getCustomRunners()).toEqual([SAMPLE]);
    db.setSetting(CUSTOM_RUNNERS_KEY, { not: "a list" });
    expect(db.getCustomRunners()).toEqual([]);
    db.setSetting(CUSTOM_RUNNERS_KEY, [SAMPLE, { name: "Bad" }]);
    expect(db.getCustomRunners()).toEqual([SAMPLE]);
  });
});

/** A runner that answers "ok" to every turn. */
function fake(id: RunnerId, starts: string[]): RunnerAdapter {
  return {
    id,
    detect: async () => ({ available: true, version: "fake" }),
    start(opts, emit) {
      starts.push(opts.prompt);
      queueMicrotask(() => {
        emit({ t: "session.start", runner: id, runnerSessionId: `${id}-1`, cwd: opts.cwd });
        emit({ t: "message.delta", role: "assistant", text: "ok" });
        emit({ t: "session.end", status: "ok" });
      });
      const session: RunnerSession = { send: () => {}, respondPermission: () => {}, abort: async () => {}, close: async () => {}, exited: Promise.resolve(0) };
      return session;
    },
  };
}

let core: CoreServer | null = null;
let home = "";
afterEach(async () => {
  await core?.stop();
  core = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

/** `saved`: the list as it was saved before this start (what main.ts built the adapters from). */
async function boot(adapters: RunnerAdapter[], saved?: CustomRunner[], env: Record<string, string> = {}) {
  home = mkdtempSync(join(tmpdir(), "sb-custom-runners-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...env });
  if (saved) {
    const d = new Db(cfg.dbPath);
    d.setCustomRunners(saved);
    d.close();
  }
  core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => ({ code: 1, stdout: "", stderr: "no gh" }) });
  return `http://127.0.0.1:${core.server.port}`;
}
const send = (base: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const j = (r: Response) => r.json() as Promise<any>;

describe("/api/custom-runners", () => {
  test("PUT replaces the list, GET reads it; a token, a bad entry and a name used twice are refused", async () => {
    const b = await boot([fake("claude", [])]);
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([]);
    const second = { port: "adk", name: "other", label: "Other", url: "https://agents.example.com/adk", app: "other_agent" };
    const put = await send(b, "PUT", "/api/custom-runners", [SAMPLE, second]);
    expect(put.status).toBe(200);
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([SAMPLE, second]);

    for (const body of [[{ ...SAMPLE, token: "secret-value" }], [{ ...SAMPLE, url: "ftp://x" }], [SAMPLE, { ...second, name: SAMPLE.name }], { runners: [SAMPLE] }, null]) {
      expect((await send(b, "PUT", "/api/custom-runners", body)).status).toBe(400);
    }
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([SAMPLE, second]);

    // only the env name is kept: no value anywhere in the settings table
    const rows = core!.db.sqlite.query("SELECT key, json FROM settings").all() as Array<{ key: string; json: string }>;
    expect(rows.some((r) => r.json.includes("secret-value"))).toBe(false);
    expect(rows.find((r) => r.key === CUSTOM_RUNNERS_KEY)?.json).toContain("SAMPLE_AGENT_TOKEN");
    // and not in the `settings` row the older daemons read and write back
    expect(JSON.stringify(core!.db.getSetting("settings", {}))).not.toContain("sample");

    expect((await send(b, "PUT", "/api/custom-runners", [])).status).toBe(200);
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([]);
  });

  test("an older daemon writing back `Settings` (no customRunners in it) leaves the list in place", async () => {
    const b = await boot([fake("claude", [])]);
    await send(b, "PUT", "/api/custom-runners", [SAMPLE]);
    // what an older daemon does: read the settings row into the Settings it knows and save it again
    core!.db.setSetting("settings", { defaultPermissionMode: { claude: "plan" }, shadowRunner: null });
    expect((await send(b, "PATCH", "/api/settings", { shadowRunner: null })).status).toBe(200);
    expect(await send(b, "GET", "/api/custom-runners").then(j)).toEqual([SAMPLE]);
  });
});

describe("Tasks on dak and custom:<name>", () => {
  test("the past dak Task, schedule and ledger rows read as before", async () => {
    const b = await boot([fake("claude", []), fake("dak", [])]);
    const t = (await send(b, "POST", "/api/tasks", { cwd: home, title: "on dak", prompt: "p", runner: "dak" }).then(j)) as Task;
    expect(t.runner).toBe("dak");
    const meta = ((await send(b, "GET", "/api/workspaces").then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
    const s = await send(b, "POST", "/api/schedules", { title: "nightly", cron: "@nightly", workspaceId: meta.id, runner: "dak", prompt: "night" }).then(j);
    expect(s.runner).toBe("dak");
    expect((await send(b, "GET", `/api/tasks/${t.id}`).then(j)).task.runner).toBe("dak");
    expect(((await send(b, "GET", "/api/schedules").then(j)) as Array<{ id: string; runner: string }>).find((x) => x.id === s.id)?.runner).toBe("dak");
    expect((await send(b, "GET", "/api/ledger/tasks")).status).toBe(200);
  });

  test("the saved shadow default is not put on a Task whose runner is custom:<name>; an explicit one still is", async () => {
    const claudeStarts: string[] = [];
    const b = await boot([fake("claude", claudeStarts), fake("custom:sample", [])]);
    expect((await send(b, "PATCH", "/api/settings", { shadowRunner: "claude" }).then(j)).shadowRunner).toBe("claude");
    const t = (await send(b, "POST", "/api/tasks", { cwd: home, title: "custom", prompt: "p", runner: "custom:sample" }).then(j)) as Task;
    expect(t.runner).toBe("custom:sample");
    expect(core!.db.shadowTaskOf(t.id)).toBeNull();
    const t2 = (await send(b, "POST", "/api/tasks", { cwd: home, title: "custom2", prompt: "q", runner: "custom:sample", shadowRunner: "claude" }).then(j)) as Task;
    expect(core!.db.shadowTaskOf(t2.id)).toMatchObject({ runner: "claude" });
  });
});
