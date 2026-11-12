// test-reads: apps/web/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

// Test daemons must not read the developer's real ~/.claude/projects: point the importer at a folder that does not exist.
const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/**
 * The development setup as a person actually runs it: the real Vite dev server (apps/web/vite.config.ts) proxying
 * to a real daemon, driven the way a browser drives it — page at http://localhost:<vite>, requests carrying
 * `Origin: http://localhost:<vite>`. Regression for "CORS error, nothing works": with `changeOrigin` on the proxy the
 * daemon saw Host 127.0.0.1:<core> next to that Origin and refused every POST and the WebSocket upgrade (403).
 * Unit tests on `sameOrigin` alone cannot catch this — the bug lived in the proxy config.
 */
const webRoot = join(import.meta.dir, "..", "..", "..", "apps", "web");
let home: string;
let core: Awaited<ReturnType<typeof startServer>>;
let vite: ReturnType<typeof Bun.spawn>;
let page: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "sb-devproxy-"));
  core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [], { port: 0 });
  const vitePort = 5300 + Math.floor(Math.random() * 500);
  page = `http://localhost:${vitePort}`;
  vite = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort", "--clearScreen", "false"], {
    cwd: webRoot,
    env: { ...process.env, SWITCHBOARD_CORE_URL: `http://127.0.0.1:${core.server.port}`, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    try {
      if ((await fetch(`${page}/`)).ok) return;
    } catch {
      /* vite still starting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`vite never came up on ${page}: ${await new Response(vite.stderr as ReadableStream).text()}`);
}, 30_000);

afterAll(async () => {
  vite?.kill();
  await vite?.exited;
  await core?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("dev UI through the Vite proxy (apps/web/vite.config.ts)", () => {
  const browser = { origin: page } as Record<string, string>;
  beforeAll(() => {
    browser.origin = page;
  });

  test("a POST from the dev page reaches the daemon", async () => {
    const r = await fetch(`${page}/api/workspaces`, { method: "POST", headers: { ...browser, "content-type": "application/json" }, body: JSON.stringify({ path: home, name: "w" }) });
    expect(r.status).toBe(201);
    expect((await fetch(`${page}/api/workspaces`, { headers: browser })).status).toBe(200);
  });

  test("the WebSocket upgrade from the dev page is accepted", async () => {
    const hello = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${page.replace("http", "ws")}/ws`, { headers: browser } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error("no hello within 3s")), 3000);
      ws.onmessage = (m) => {
        clearTimeout(timer);
        resolve(String(m.data));
        ws.close();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket handshake refused"));
      };
    });
    expect(JSON.parse(hello).type).toBe("hello");
  });

  test("a report's own URL (/artifacts/<key>/…) reaches the daemon, not Vite's page", async () => {
    const r = await fetch(`${page}/artifacts/${"a".repeat(20)}/index.html`, { headers: browser });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden" });
  });

  test("the dev page answers with frame-src 'self': a link in a report's frame cannot load another site into it", async () => {
    const csp = (await fetch(`${page}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src 'self'");
  });

  test("a report served through the proxy keeps the daemon's sandbox CSP, not the dev page's", async () => {
    // A task row is all the artifact store needs (no runner is started); its scope is the folder the report sits in.
    const work = join(home, "report");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "index.html"), "<h1>r</h1>");
    const at = Date.now();
    core.db.insertTask({ id: "tsk_devproxy", workspaceId: null, title: "t", stage: null, runner: "claude", cwd: work, scope: [work], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Parameters<typeof core.db.insertTask>[0]);
    const json = { ...browser, "content-type": "application/json" };
    const a = (await (await fetch(`${page}/api/tasks/tsk_devproxy/artifacts`, { method: "POST", headers: json, body: JSON.stringify({ source: join(work, "index.html") }) })).json()) as { id: string };
    const { url } = (await (await fetch(`${page}/api/artifacts/${a.id}/view`, { method: "POST", headers: browser })).json()) as { url: string };
    const r = await fetch(`${page}${url}`, { headers: browser });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe("sandbox allow-scripts; frame-ancestors 'self'");
  });

  test("the terminal socket (/ws/pty) goes through the same proxy rule: the daemon answers, not the Origin check", async () => {
    const r = await fetch(`${page}/ws/pty?task=nope`, { headers: { ...browser, upgrade: "websocket", connection: "upgrade" } });
    // 404 from the daemon's own route — a refused Origin would be 403, an unproxied path would be Vite's index.html (200).
    // Which 404 depends on whether this machine can open a PTY; both come after the Origin check.
    expect(r.status).toBe(404);
    expect(await r.text()).toMatch(/task not found|no terminal in this distribution/);
  });

  test("the proxy does not launder a foreign Origin: a cross-site page is still refused", async () => {
    expect((await fetch(`${page}/api/workspaces`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });
});
