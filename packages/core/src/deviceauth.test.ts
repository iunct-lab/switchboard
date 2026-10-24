import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentEvent, RunnerAdapter, RunnerSession, ServerMessage, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { DeviceAuths } from "./deviceauth.ts";
import { startServer } from "./server.ts";

// Made-up values: never a real login.
const URL_ = "https://login.example/device";
const CODE = "WXYZ-98765";

/** A runner that stays attached after its turn (like `claude -p --input-format stream-json`) until closed or aborted. */
function lingering(starts: StartOptions[]): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true, version: "fake" };
    },
    start(opts, emit) {
      starts.push(opts);
      let exit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      const script: AgentEvent[] = [
        { t: "session.start", runner: "claude", runnerSessionId: "s-auth", cwd: opts.cwd },
        { t: "message.delta", role: "assistant", text: "waiting for the approval" },
        { t: "session.end", status: "ok", summary: "ok" },
      ];
      queueMicrotask(() => script.forEach(emit));
      const session: RunnerSession = {
        send: () => undefined,
        respondPermission: () => undefined,
        abort: async () => exit(null),
        close: async () => exit(0),
        exited,
      };
      return session;
    },
  };
}

const j = (r: Response) => r.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("DeviceAuths (#662)", () => {
  test("refuses a URL that is not https, an over-long code and a wait outside 1–900 s, without the value in the message", () => {
    const auths = new DeviceAuths(() => undefined);
    const ok = { url: URL_, code: CODE, command: "cloud login", expiresInSec: 60 };
    for (const bad of [{ ...ok, url: "http://login.example/device" }, { ...ok, url: "javascript:alert(1)" }, { ...ok, code: "X".repeat(65) }, { ...ok, expiresInSec: 0 }, { ...ok, expiresInSec: 901 }, { ...ok, command: "" }]) {
      let message = "";
      try {
        auths.put("t", bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(bad.code);
      expect(message).not.toContain("login.example");
    }
    expect(auths.get("t")).toBeNull();
    auths.stop();
  });

  test("a second put for the same Task replaces the first, and the first one's timer does not clear it", async () => {
    const changes: Array<string | null> = [];
    const auths = new DeviceAuths((_t, a) => changes.push(a?.code ?? null));
    auths.put("t", { url: URL_, code: ["AAAA", "BBBB"].join("-"), command: "login", expiresInSec: 1 });
    auths.put("t", { url: URL_, code: CODE, command: "login", expiresInSec: 60 });
    await Bun.sleep(1200);
    expect(auths.get("t")?.code).toBe(CODE);
    expect(changes).toEqual([["AAAA", "BBBB"].join("-"), CODE]);
    auths.stop();
  });
});

describe("/api/tasks/:id/device-auth (#662)", () => {
  let home: string;
  let core: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  const starts: StartOptions[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "switchboard-test-deviceauth-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "no-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    core = await startServer(cfg, [lingering(starts)], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
    base = `http://127.0.0.1:${core.server.port}`;
  });
  afterAll(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, method = "POST") => fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await ok()); i++) await Bun.sleep(10);
    expect(await ok()).toBe(true);
  };

  test("the runner gets the address; put → GET and WS carry it; it expires; no event, task update or DB row has it; an ended Task gets 409", async () => {
    const msgs: ServerMessage[] = [];
    const raw: string[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.onmessage = (m) => {
      raw.push(String(m.data));
      msgs.push(JSON.parse(String(m.data)));
    };

    const task = await post("/api/tasks", { cwd: home, title: "needs a cloud login", prompt: "deploy", runner: "claude" }).then(j);
    await until(async () => (await fetch(`${base}/api/tasks/${task.id}`).then(j)).task.status === "done");
    const env = starts.at(-1)?.env ?? {};
    expect(env.DEVICE_AUTH_URL).toBe(`${base}/api/tasks/${task.id}/device-auth`);
    expect(env.DEVICE_AUTH_TOKEN_FILE).toBe(join(home, "token"));
    // the kit's `backlog` reaches the stored backlog the same way (#918)
    expect([env.BACKLOG_URL, env.BACKLOG_TOKEN_FILE]).toEqual([`${base}/api/backlog`, join(home, "token")]);

    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toBeNull();
    const put = await post(`/api/tasks/${task.id}/device-auth`, { url: URL_, code: CODE, command: "cloud login --device", expiresInSec: 1 });
    expect(put.status).toBe(200);
    const got = await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j);
    expect(got).toMatchObject({ url: URL_, code: CODE, command: "cloud login --device" });
    expect(got.expiresAt).toBeGreaterThan(Date.now());
    await until(() => msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth?.code === CODE));

    // a bad body is refused with nothing of it in the answer
    const refused = await post(`/api/tasks/${task.id}/device-auth`, { url: "http://login.example/x", code: CODE, command: "x", expiresInSec: 1 });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(CODE);

    // expiry: GET is null again and the screen is told
    await until(() => msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth === null));
    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toBeNull();

    // DELETE (the kit's helper once the command ended): gone at once, and the screen is told
    await post(`/api/tasks/${task.id}/device-auth`, { url: URL_, code: CODE, command: "cloud login --device", expiresInSec: 600 });
    const nullsBeforeDelete = msgs.filter((m) => m.type === "task.deviceAuth" && m.auth === null).length;
    const del = await fetch(`${base}/api/tasks/${task.id}/device-auth`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toBeNull();
    await until(() => msgs.filter((m) => m.type === "task.deviceAuth" && m.auth === null).length > nullsBeforeDelete);

    // put again, then the Task ends: the wait goes with it, and a new one is refused
    await post(`/api/tasks/${task.id}/device-auth`, { url: URL_, code: CODE, command: "cloud login --device", expiresInSec: 600 });
    const nulls = () => msgs.filter((m) => m.type === "task.deviceAuth" && m.auth === null).length;
    const before = nulls();
    await fetch(`${base}/api/tasks/${task.id}/abort`, { method: "POST" });
    await until(() => nulls() > before);
    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toBeNull();
    expect((await post(`/api/tasks/${task.id}/device-auth`, { url: URL_, code: CODE, command: "x", expiresInSec: 60 })).status).toBe(409);
    expect((await post(`/api/tasks/task_nope/device-auth`, { url: URL_, code: CODE, command: "x", expiresInSec: 60 })).status).toBe(404);
    ws.close();

    // nothing stored or broadcast as a record carries the values
    const detail = await fetch(`${base}/api/tasks/${task.id}`).then(j);
    expect(JSON.stringify(detail)).not.toContain(CODE);
    expect(raw.filter((r) => !r.includes('"task.deviceAuth"')).join("\n")).not.toContain(CODE);
    const db = new Database(join(home, "switchboard.db"), { readonly: true });
    try {
      for (const table of db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()) {
        const rows = db.query(`select * from "${table.name}"`).all();
        expect(JSON.stringify(rows)).not.toContain(CODE);
        expect(JSON.stringify(rows)).not.toContain(URL_);
      }
    } finally {
      db.close();
    }
  });
});
