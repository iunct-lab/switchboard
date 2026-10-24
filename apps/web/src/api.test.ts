import { expect, test } from "bun:test";
import { api, wsUrl } from "./api.ts";

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
