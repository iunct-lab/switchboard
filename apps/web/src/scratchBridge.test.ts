import { describe, expect, test } from "bun:test";
import { apiRaw } from "./api.ts";
import { BRIDGE_MAX, BRIDGE_REFUSED, BRIDGE_WINDOW_MS, BridgeLimiter, type BridgePending, type BridgeRequest, type BridgeResult, createBridge, DECLINED, parseBridgeRequest } from "./scratchBridge.ts";

const get = (path: string, extra: Record<string, unknown> = {}) => ({ type: "switchboard-api", id: "r1", method: "GET", path, ...extra });

describe("parseBridgeRequest", () => {
  test("a GET under /api/ passes, with its query", () => {
    expect(parseBridgeRequest(get("/api/tasks"))).toEqual({ ok: true, req: { type: "switchboard-api", id: "r1", method: "GET", path: "/api/tasks" }, confirm: false });
    expect(parseBridgeRequest(get("/api/tasks?archived=1")).ok).toBe(true);
  });

  test("a write passes with confirm, carrying its body (#3681)", () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT", "post"])
      expect(parseBridgeRequest(get("/api/backlog/12/start", { method, body: { a: 1 } }))).toEqual({
        ok: true,
        req: { type: "switchboard-api", id: "r1", method: method.toUpperCase(), path: "/api/backlog/12/start", body: { a: 1 } },
        confirm: true,
      });
    const noBody = parseBridgeRequest(get("/api/tasks/x/abort", { method: "POST" }));
    expect(noBody).toMatchObject({ ok: true, confirm: true });
    expect(noBody.ok && noBody.req).not.toHaveProperty("body");
  });

  test("any other method is refused with 405", () => {
    for (const method of ["OPTIONS", "HEAD", "TRACE", "CONNECT", ""]) expect(parseBridgeRequest(get("/api/tasks", { method }))).toMatchObject({ ok: false, status: 405 });
  });

  test("a write to a sign-in, an approval, a setting or a key is refused with 403 without asking; its read is not (#3681)", () => {
    const refused = [
      "/api/runners/claude/login",
      "/api/runners/x/login/code",
      "/api/tasks/t1/device-auth",
      "/api/tasks/t1/permission",
      "/api/tasks/t1/permission-mode",
      "/api/runners/claude/logout",
      "/api/asks/answer",
      "/api/policies",
      "/api/policies/p1",
      "/api/settings",
      "/api/custom-runners",
      "/api/workspaces/w1/runner-config",
      "/api/artifacts/a1/view",
      "/api/tasks/t1/mcp/rotate",
      "/api/runners/x/%6cogin", // decoded before the table
    ];
    for (const path of refused) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(parseBridgeRequest(get(path, { method }))).toMatchObject({ ok: false, status: 403 });
      expect(parseBridgeRequest(get(path)).ok).toBe(true);
    }
    expect(BRIDGE_REFUSED.length).toBeGreaterThan(0);
    for (const path of ["/api/settings/model-candidates", "/api/tasks/t1/abort", "/api/artifacts/a1/restore", "/api/backlog/1/start"])
      expect(parseBridgeRequest(get(path, { method: "POST" }))).toMatchObject({ ok: true, confirm: true });
  });

  test("a write is checked on its path like a read: outside /api/ or climbing out is 400, not a confirm", () => {
    for (const path of ["/foo", "/api", "/api/../settings", "/api/%2e%2e/x", "/api//x", "/api/backlog?refresh=1", "/api/artifacts/a1/view#x", "/api/tasks/x/abort#y", "/api/tasks?q=#", "/api/artifacts/a1/vi\tew", "/api/artifacts/a1/vi\new", "/api/artifacts/a1/view\r", "/api/artifacts/a1/view ", "/api/artifacts/a1/view\u007f", "/api/settings?ref\tresh=1"])
      expect(parseBridgeRequest(get(path, { method: "POST" }))).toMatchObject({ ok: false, status: 400 });
  });

  test("a path outside /api/, climbing out of it, or too long is refused with 400", () => {
    for (const path of ["/foo", "/api", "api/tasks", "https://x.example/api/tasks", "/api/../x", "/api/%2e%2e/x", "/api/%2E%2E%2Fx", "/api//x", "/api/a\\b", "/api/a%00", "/api/%zz", `/api/${"a".repeat(2_000)}`])
      expect(parseBridgeRequest(get(path))).toMatchObject({ ok: false, status: 400 });
    expect(parseBridgeRequest(get(`/api/${"a".repeat(2_000 - 5)}`)).ok).toBe(true);
    expect(parseBridgeRequest(get("/api/artifacts?q=日本")).ok).toBe(true); // a query the parser would encode stays a read
    expect(parseBridgeRequest(get("/api/workspaces/%E6%97%A5")).ok).toBe(true);
  });

  test("the checks are on the path part; the query may hold // and .., but not refresh (#3726)", () => {
    expect(parseBridgeRequest(get("/api/artifacts?q=https://x..y")).ok).toBe(true);
    for (const path of ["/api/backlog?refresh=1", "/api/flow?x=1&refresh=0", "/api/backlog?refresh"]) expect(parseBridgeRequest(get(path))).toMatchObject({ ok: false, status: 400 });
  });

  test("a body JSON cannot write (a cycle, a BigInt) is refused with 400 before any confirm (#3880)", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const body of [cycle, 1n, { n: 2n }]) expect(parseBridgeRequest(get("/api/tasks/x/abort", { method: "POST", body }))).toMatchObject({ ok: false, status: 400 });
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
  const setup = (read = async (path: string) => ({ status: 200, body: { path } }), confirm: (req: BridgeRequest) => Promise<boolean> = async () => true) => {
    const frame = { name: "mine" };
    const other = { name: "other" };
    const sent: { to: unknown; result: BridgeResult }[] = [];
    const pending: BridgePending[] = [];
    const reads: string[] = [];
    const calls: BridgeRequest[] = [];
    let t = 0;
    const bridge = createBridge({
      frames: () => [frame],
      call: (r) => (reads.push(r.path), calls.push(r), read(r.path)),
      confirm,
      reply: (to, result) => (result.type === "switchboard-api-pending" ? pending.push(result) : sent.push({ to, result })),
      now: () => t,
    });
    return { frame, other, sent, pending, reads, calls, bridge, tick: (ms: number) => (t += ms) };
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
    await s.bridge({ source: s.frame, data: get("/api/tasks", { method: "OPTIONS" }) });
    await s.bridge({ source: s.frame, data: get("/api/../x") });
    await s.bridge({ source: s.frame, data: get("/api/settings", { method: "PATCH" }) });
    expect(s.reads).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(s.sent.map((x) => x.result.status)).toEqual([405, 400, 403]);
  });

  test("a GET is read without a confirm (#3681)", async () => {
    let asked = 0;
    const s = setup(undefined, async () => (asked++, true));
    await s.bridge({ source: s.frame, data: get("/api/tasks") });
    expect(asked).toBe(0);
    expect(s.pending).toEqual([]);
  });

  test("a write waits for the confirm: pending first, then the call with its method and body once 実行する (#3681)", async () => {
    let yes!: (v: boolean) => void;
    const asked: BridgeRequest[] = [];
    const s = setup(async () => ({ status: 200, body: { started: true } }), (req) => (asked.push(req), new Promise((r) => (yes = r))));
    const done = s.bridge({ source: s.frame, data: get("/api/backlog/12/start", { method: "POST", body: { runner: "claude" } }) });
    await Promise.resolve();
    expect(s.pending).toEqual([{ type: "switchboard-api-pending", id: "r1" }]);
    expect(asked).toMatchObject([{ method: "POST", path: "/api/backlog/12/start", body: { runner: "claude" } }]);
    expect(s.calls).toEqual([]);
    yes(true);
    await done;
    expect(s.calls).toMatchObject([{ method: "POST", path: "/api/backlog/12/start", body: { runner: "claude" } }]);
    expect(s.sent.map((x) => x.result)).toEqual([{ type: "switchboard-api-result", id: "r1", ok: true, status: 200, body: { started: true } }]);
  });

  test("やめる (or a failing confirm) calls nothing and answers 利用者が断った (#3681)", async () => {
    for (const confirm of [async () => false, async () => Promise.reject(new Error("gone"))]) {
      const s = setup(undefined, confirm);
      await s.bridge({ source: s.frame, data: get("/api/tasks/x/abort", { method: "POST" }) });
      expect(s.calls).toEqual([]);
      expect(s.sent.map((x) => x.result)).toEqual([{ type: "switchboard-api-result", id: "r1", ok: false, status: 0, body: { error: DECLINED } }]);
    }
  });

  test("a second write waits until the first confirm is closed: one dialog at a time (#3681)", async () => {
    const answers: ((v: boolean) => void)[] = [];
    const s = setup(undefined, () => new Promise((r) => answers.push(r)));
    const first = s.bridge({ source: s.frame, data: get("/api/tasks/a/abort", { method: "POST", id: "w1" }) });
    const second = s.bridge({ source: s.frame, data: get("/api/tasks/b/abort", { method: "POST", id: "w2" }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.pending.map((p) => p.id)).toEqual(["w1", "w2"]);
    expect(answers.length).toBe(1); // only the first is shown
    answers[0]!(false);
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(answers.length).toBe(2); // now the second
    answers[1]!(true);
    await second;
    expect(s.calls.map((c) => c.path)).toEqual(["/api/tasks/b/abort"]);
    expect(s.sent.map((x) => [x.result.id, x.result.status])).toEqual([["w1", 0], ["w2", 200]]);
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
