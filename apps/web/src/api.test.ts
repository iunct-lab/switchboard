import { expect, test } from "bun:test";
import { api, RENEW_EVERY_MS, renewLogin, resetRenewal, wsUrl } from "./api.ts";

test("wsUrl: the page's host, ws/wss by the page's scheme, the token and the query escaped", () => {
  const http = { protocol: "http:", host: "localhost:5173" };
  expect(wsUrl("/ws", {}, http, null)).toBe("ws://localhost:5173/ws");
  expect(wsUrl("/ws", {}, http, "sb_a+b/c")).toBe("ws://localhost:5173/ws?token=sb_a%2Bb%2Fc");
  expect(wsUrl("/ws/pty", { task: "task_1&x" }, http, "sb_t")).toBe("ws://localhost:5173/ws/pty?task=task_1%26x&token=sb_t");
  expect(wsUrl("/ws/pty", { task: "t" }, { protocol: "https:", host: "sb.example" }, null)).toBe("wss://sb.example/ws/pty?task=t");
});

// One request answered with CloudFront's start page while the daemon is up: the screen stays (what is typed survives);
// the start page from /api/health as well means the host is off → the login page (#211), asked first when text is typed.
test("req: the start page goes to /_auth/ only when /api/health is the start page too", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, location: g.location, localStorage: g.localStorage, document: g.document, confirm: g.confirm };
  const replaced: string[] = [];
  g.location = { pathname: "/backlog", search: "", replace: (u: string) => replaced.push(u), assign: () => {} };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  let typed = "";
  g.document = { querySelectorAll: () => [{ value: typed }] };
  const asked: string[] = [];
  let answer = false;
  g.confirm = (m: string) => (asked.push(m), answer);
  const start = () => new Response("<html>start</html>", { status: 503, headers: { "content-type": "text/html" } });
  const health = () => Response.json({ ok: true });
  try {
    let healthUp = true;
    g.fetch = async (url: string) => (url === "/api/health" ? (healthUp ? health() : start()) : start());
    await expect(api.workspaces()).rejects.toThrow();
    expect(replaced).toEqual([]);

    healthUp = false;
    await expect(api.workspaces()).rejects.toThrow();
    expect(replaced).toEqual(["/_auth/?next=%2Fbacklog"]);
    expect(asked).toEqual([]); // nothing typed: no question

    // text typed: leaving would lose it, so the user is asked; 移らない holds for the next requests of the minute
    typed = "書きかけの本文";
    await expect(api.workspaces()).rejects.toThrow();
    await expect(api.workspaces()).rejects.toThrow();
    expect(asked).toHaveLength(1);
    expect(replaced).toHaveLength(1);
  } finally {
    Object.assign(g, saved);
  }
}, 20_000); // each stopped check waits the real 2 s between its two asks

test("runnerLogin: the Anthropic Console button posts billing=api, the Claude account one does not", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, localStorage: g.localStorage };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const urls: string[] = [];
  g.fetch = async (url: string) => (urls.push(url), Response.json({ runner: "claude", state: "waiting", needsCode: true }));
  try {
    await api.runnerLogin("claude");
    await api.runnerLogin("claude", "console");
    await api.runnerLogout("claude");
    expect(urls).toEqual(["/api/runners/claude/login", "/api/runners/claude/login?billing=api", "/api/runners/claude/logout"]);
  } finally {
    Object.assign(g, saved);
  }
});

test("renameTask: PATCH /api/tasks/:id with the title (#491)", async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, localStorage: g.localStorage };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  g.fetch = async (url: string, init?: { method?: string; body?: string }) => (seen.push({ url, method: init?.method, body: init?.body }), Response.json({ id: "t1", title: "新しい名前" }));
  try {
    expect((await api.renameTask("t1", "新しい名前")).title).toBe("新しい名前");
    expect(seen[0]).toMatchObject({ url: "/api/tasks/t1", method: "PATCH", body: JSON.stringify({ title: "新しい名前" }) });
  } finally {
    g.fetch = saved.fetch;
    g.localStorage = saved.localStorage;
  }
});

test("renewLogin: only a passkey login's changing request asks the Starter, at most once per RENEW_EVERY_MS (#498)", () => {
  resetRenewal();
  let sent = 0;
  const send = () => { sent++; return Promise.resolve(); };
  expect(renewLogin("passkey", "GET", 1_000_000, send)).toBe(false);
  expect(renewLogin("passkey", undefined, 1_000_000, send)).toBe(false);
  expect(renewLogin("passkey", "HEAD", 1_000_000, send)).toBe(false);
  expect(renewLogin("token", "POST", 1_000_000, send)).toBe(false);
  expect(renewLogin(undefined, "POST", 1_000_000, send)).toBe(false);
  expect(renewLogin("passkey", "POST", 1_000_000, send)).toBe(true);
  expect(renewLogin("passkey", "PATCH", 1_000_000 + RENEW_EVERY_MS - 1, send)).toBe(false);
  expect(renewLogin("passkey", "DELETE", 1_000_000 + RENEW_EVERY_MS, send)).toBe(true);
  expect(sent).toBe(2);
  expect(() => renewLogin("passkey", "POST", 9e9, () => Promise.reject(new Error("offline")))).not.toThrow();
  resetRenewal();
});
