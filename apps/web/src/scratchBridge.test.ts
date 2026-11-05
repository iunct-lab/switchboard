import { describe, expect, test } from "bun:test";
import { apiRaw } from "./api.ts";
import { BRIDGE_MAX, BRIDGE_WINDOW_MS, BridgeLimiter, type BridgeResult, createBridge, parseBridgeRequest } from "./scratchBridge.ts";

const get = (path: string, extra: Record<string, unknown> = {}) => ({ type: "switchboard-api", id: "r1", method: "GET", path, ...extra });

describe("parseBridgeRequest", () => {
  test("a GET under /api/ passes, with its query", () => {
    expect(parseBridgeRequest(get("/api/tasks"))).toEqual({ ok: true, req: { type: "switchboard-api", id: "r1", method: "GET", path: "/api/tasks" } });
    expect(parseBridgeRequest(get("/api/tasks?archived=1")).ok).toBe(true);
  });

  test("any other method is refused with 405", () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) expect(parseBridgeRequest(get("/api/tasks", { method }))).toMatchObject({ ok: false, status: 405 });
  });

  test("a path outside /api/, climbing out of it, or too long is refused with 400", () => {
    for (const path of ["/foo", "/api", "api/tasks", "https://x.example/api/tasks", "/api/../x", "/api/%2e%2e/x", "/api/%2E%2E%2Fx", "/api//x", "/api/a\\b", "/api/a%00", "/api/%zz", `/api/${"a".repeat(2_000)}`])
      expect(parseBridgeRequest(get(path))).toMatchObject({ ok: false, status: 400 });
    expect(parseBridgeRequest(get(`/api/${"a".repeat(2_000 - 5)}`)).ok).toBe(true);
  });

  test("the checks are on the path part; the query may hold // and .., but not refresh (#3726)", () => {
    expect(parseBridgeRequest(get("/api/artifacts?q=https://x..y")).ok).toBe(true);
    for (const path of ["/api/backlog?refresh=1", "/api/flow?x=1&refresh=0", "/api/backlog?refresh"]) expect(parseBridgeRequest(get(path))).toMatchObject({ ok: false, status: 400 });
  });

  test("a message of another shape is refused", () => {
    for (const data of [null, "x", 1, {}, { type: "other", id: "r1", method: "GET", path: "/api/tasks" }, get("/api/tasks", { id: 1 }), get("/api/tasks", { path: 3 }), get("/api/tasks", { method: undefined })])
      expect(parseBridgeRequest(data)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("BridgeLimiter", () => {
  test("the 21st request in 10 s is refused, and passes once the window has moved on", () => {
    const l = new BridgeLimiter();
    for (let i = 0; i < BRIDGE_MAX; i++) expect(l.take(1_000 + i)).toBe(true);
    expect(l.take(1_000 + BRIDGE_MAX)).toBe(false);
    expect(l.take(1_000 + BRIDGE_WINDOW_MS)).toBe(true);
  });
});

describe("createBridge", () => {
  const setup = (read = async (path: string) => ({ status: 200, body: { path } })) => {
    const frame = { name: "mine" };
    const other = { name: "other" };
    const sent: { to: unknown; result: BridgeResult }[] = [];
    const reads: string[] = [];
    let t = 0;
    const bridge = createBridge({
      frames: () => [frame],
      read: (p) => (reads.push(p), read(p)),
      reply: (to, result) => sent.push({ to, result }),
      now: () => t,
    });
    return { frame, other, sent, reads, bridge, tick: (ms: number) => (t += ms) };
  };

  test("reads a GET for its frame and answers that frame with the status and body", async () => {
    const s = setup();
    await s.bridge({ source: s.frame, data: get("/api/tasks") });
    expect(s.sent).toEqual([{ to: s.frame, result: { type: "switchboard-api-result", id: "r1", ok: true, status: 200, body: { path: "/api/tasks" } } }]);
  });

  test("a failed read comes back with its status, not ok", async () => {
    const s = setup(async () => ({ status: 404, body: { error: "not found" } }));
    await s.bridge({ source: s.frame, data: get("/api/tasks/x") });
    expect(s.sent[0]?.result).toMatchObject({ ok: false, status: 404, body: { error: "not found" } });
  });

  test("a message from another window or frame is dropped without a read or a reply", async () => {
    const s = setup();
    await s.bridge({ source: s.other, data: get("/api/tasks") });
    await s.bridge({ source: null, data: get("/api/tasks") });
    expect(s.reads).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  test("a message that is not a bridge request is ignored", async () => {
    const s = setup();
    await s.bridge({ source: s.frame, data: { type: "resize", h: 3 } });
    expect(s.sent).toEqual([]);
  });

  test("a refused request is answered without reading", async () => {
    const s = setup();
    await s.bridge({ source: s.frame, data: get("/api/tasks", { method: "POST" }) });
    await s.bridge({ source: s.frame, data: get("/api/../x") });
    expect(s.reads).toEqual([]);
    expect(s.sent.map((x) => x.result.status)).toEqual([405, 400]);
  });

  test("the 21st request in 10 s gets 429 without a read; after 10 s it is read again", async () => {
    const s = setup();
    for (let i = 0; i < BRIDGE_MAX; i++) await s.bridge({ source: s.frame, data: get("/api/tasks") });
    await s.bridge({ source: s.frame, data: get("/api/tasks") });
    expect(s.reads.length).toBe(BRIDGE_MAX);
    expect(s.sent.at(-1)?.result).toMatchObject({ ok: false, status: 429 });
    s.tick(BRIDGE_WINDOW_MS);
    await s.bridge({ source: s.frame, data: get("/api/tasks") });
    expect(s.reads.length).toBe(BRIDGE_MAX + 1);
    expect(s.sent.at(-1)?.result.status).toBe(200);
  });
});

describe("apiRaw", () => {
  test("the status and JSON of a read, a failure's status, and a 2xx that is not JSON as status 0 (#3726)", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, localStorage: g.localStorage, location: g.location };
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    g.location = { pathname: "/", search: "", replace: () => {}, assign: () => {} };
    const answers: Record<string, () => Response> = {
      "/api/a": () => Response.json([1], { status: 200 }),
      "/api/b": () => Response.json({ error: "not found" }, { status: 404 }),
      "/api/c": () => new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }),
    };
    g.fetch = async (url: string) => answers[url]!();
    try {
      expect(await apiRaw("/api/a")).toEqual({ status: 200, body: [1] });
      expect(await apiRaw("/api/b")).toEqual({ status: 404, body: { error: "not found" } });
      expect((await apiRaw("/api/c")).status).toBe(0);
    } finally {
      g.fetch = saved.fetch;
      g.localStorage = saved.localStorage;
      g.location = saved.location;
    }
  });
});
