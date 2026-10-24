import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { addressKey, edgeOk, EDGE_HEADER, FAILURE_WINDOW_MS, hostAllowed, LOOPBACK_HOSTNAMES, makeFailureLimit, makeSessionCheck, RECENT_COOKIE, recentOk, sameOrigin, SESSION_COOKIE, SESSION_RECHECK_MS, sessionOk } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:47831/api/tasks", { headers });

/** The rule is exact: Origin host must equal the Host header. Nothing about loopback is special (see devproxy.test.ts for why the dev proxy must therefore leave Host alone). */
describe("sameOrigin", () => {
  test.each([
    ["no Origin (non-browser client)", {}, true],
    ["same origin", { origin: "http://127.0.0.1:47831", host: "127.0.0.1:47831" }, true],
    ["same origin via localhost (the dev proxy, Host forwarded)", { origin: "http://localhost:5173", host: "localhost:5173" }, true],
    ["dev proxy with Host rewritten (changeOrigin) — the bug", { origin: "http://localhost:5173", host: "127.0.0.1:47831" }, false],
    ["another loopback port", { origin: "http://127.0.0.1:1", host: "127.0.0.1:47831" }, false],
    ["foreign site", { origin: "http://evil.example", host: "127.0.0.1:47831" }, false],
    ["localhost lookalike", { origin: "http://localhost.evil.example:47831", host: "127.0.0.1:47831" }, false],
    ["opaque origin", { origin: "null", host: "127.0.0.1:47831" }, false],
    ["garbage origin", { origin: "not a url", host: "127.0.0.1:47831" }, false],
  ])("%s", (_name, headers, ok) => {
    expect(sameOrigin(req(headers as Record<string, string>))).toBe(ok);
  });
});

/** DNS rebinding (#1135): on loopback the Host must name this machine, whatever the Origin says. The port is not compared. */
describe("hostAllowed (#1135)", () => {
  const withPublic = new Set([...LOOPBACK_HOSTNAMES, "host.docker.internal"]);
  test.each([
    ["Vite dev server", "localhost:5173", LOOPBACK_HOSTNAMES, true],
    ["daemon by address", "127.0.0.1:47831", LOOPBACK_HOSTNAMES, true],
    ["IPv6 loopback", "[::1]:47831", LOOPBACK_HOSTNAMES, true],
    ["no port", "localhost", LOOPBACK_HOSTNAMES, true],
    ["SWITCHBOARD_PUBLIC_URL's host, not configured", "host.docker.internal:47831", LOOPBACK_HOSTNAMES, false],
    ["SWITCHBOARD_PUBLIC_URL's host, configured", "host.docker.internal:47831", withPublic, true],
    ["rebinding name", "evil.example:47831", LOOPBACK_HOSTNAMES, false],
    ["loopback address as a prefix", "127.0.0.1.evil.example:47831", LOOPBACK_HOSTNAMES, false],
    ["localhost as a subdomain", "localhost.evil.example:5173", LOOPBACK_HOSTNAMES, false],
    ["unclosed IPv6", "[::1", LOOPBACK_HOSTNAMES, false],
    ["empty", "", LOOPBACK_HOSTNAMES, false],
  ])("%s", (_name, host, allowed, ok) => {
    expect(hostAllowed(req({ host }), allowed)).toBe(ok);
  });

  test("no Host header: the request URL's host", () => {
    expect(hostAllowed(new Request("http://127.0.0.1:47831/api/tasks"), LOOPBACK_HOSTNAMES)).toBe(true);
    expect(hostAllowed(new Request("http://evil.example:47831/api/tasks"), LOOPBACK_HOSTNAMES)).toBe(false);
  });
});

// The daemon end to end (#1135): a page on a rebinding name whose address became 127.0.0.1 sends its own name as Host and
// Origin, so they match; the Host check stops it on every route before the Origin check or the (loopback-off) token.
describe("loopback Host check (#1135)", () => {
  const homes: string[] = [];
  afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
  const boot = async (extra: Record<string, string> = {}) => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-host-"));
    homes.push(home);
    const env: Record<string, string> = { SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...extra };
    return startServer(loadConfig(env), [], { port: 0, selfdevChecks: false });
  };
  const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };

  test("a foreign Host gets 403 on every route, a matching Origin included; loopback names get through", async () => {
    const core = await boot();
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      for (const path of ["/api/tasks", "/api/health", "/", "/mcp/task_x", "/ws", "/ws/pty?task=x"]) {
        const r = await fetch(`${base}${path}`, { headers: { host: "evil.example:47831", ...(path.startsWith("/ws") ? upgrade : {}) } });
        expect(r.status, path).toBe(403);
        expect(await r.text(), path).toContain("host not allowed");
      }
      const shell = await fetch(`${base}/ws/pty?task=x`, { headers: { host: "evil.example:47831", origin: "http://evil.example:47831", ...upgrade } });
      expect(shell.status).toBe(403);
      expect(await shell.text()).toContain("host not allowed");
      for (const host of ["localhost:5173", "[::1]:1", `127.0.0.1:${core.server.port}`]) expect((await fetch(`${base}/api/tasks`, { headers: { host } })).status, host).toBe(200);
      expect((await fetch(`${base}/api/tasks`)).status).toBe(200);
    } finally {
      await core.stop();
    }
  });

  test("SWITCHBOARD_PUBLIC_URL's host name is allowed too", async () => {
    const core = await boot({ SWITCHBOARD_PUBLIC_URL: "http://host.docker.internal:47831" });
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`, { headers: { host: "host.docker.internal:47831" } })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`, { headers: { host: "evil.example:47831" } })).status).toBe(403);
    } finally {
      await core.stop();
    }
  });

  test("an unparsable SWITCHBOARD_PUBLIC_URL adds no name and does not stop the daemon", async () => {
    const core = await boot({ SWITCHBOARD_PUBLIC_URL: "http://" });
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`, { headers: { host: "evil.example:47831" } })).status).toBe(403);
    } finally {
      await core.stop();
    }
  });

  test("off loopback the token rule stands: a foreign Host gets 401, not 403", async () => {
    const core = await boot({ SWITCHBOARD_HOST: "0.0.0.0" });
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`, { headers: { host: "evil.example:47831" } })).status).toBe(401);
    } finally {
      await core.stop();
    }
  });
});

describe("edge header (#181)", () => {
  const withHeader = (v?: string) => new Request("http://example/api/tasks", { headers: v === undefined ? {} : { [EDGE_HEADER]: v } });
  test.each([
    ["not configured: everything passes", undefined, undefined, "203.0.113.5", true],
    ["configured, header missing", "s3cret-value", undefined, "203.0.113.5", false],
    ["configured, header matches", "s3cret-value", "s3cret-value", "203.0.113.5", true],
    ["configured, header differs (same length)", "s3cret-value", "s3cret-vaLue", "203.0.113.5", false],
    ["configured, header differs (other length)", "s3cret-value", "s3cret", "203.0.113.5", false],
    ["this machine (IPv4 loopback) needs no header", "s3cret-value", undefined, "127.0.0.1", true],
    ["this machine (IPv6 loopback)", "s3cret-value", undefined, "::1", true],
    ["this machine (IPv4-mapped loopback)", "s3cret-value", undefined, "::ffff:127.0.0.1", true],
    ["peer address unknown", "s3cret-value", undefined, undefined, false],
  ])("%s", (_name, value, header, peer, ok) => {
    expect(edgeOk(withHeader(header), value, peer)).toBe(ok);
  });

  // The daemon end to end, over real sockets and the registered routes (not `server.fetch()`, which only reaches the
  // fallback handler): `peerAddress` makes 127.0.0.1 look like another machine, since this Mac's firewall refuses
  // connections to its own LAN address. Every path needs the header, health, static, /ws and /mcp included.
  const homes: string[] = [];
  afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
  const boot = async (value?: string, peer?: string) => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-edge-"));
    homes.push(home);
    const env: Record<string, string> = { SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
    if (value) env.SWITCHBOARD_EDGE_HEADER_VALUE = value;
    return startServer(loadConfig(env), [], { port: 0, selfdevChecks: false, peerAddress: peer ? () => peer : undefined });
  };
  const wsOpens = (url: string, headers: Record<string, string> = {}) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      ws.onopen = () => (ws.close(), resolve(true));
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });

  test("a request from elsewhere without the header gets 403 on every registered route; the header gets through", async () => {
    const core = await boot("s3cret-value", "203.0.113.9");
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      for (const path of ["/api/health", "/", "/api/tasks", "/api/settings", "/mcp/task_x", "/ws", "/ws/pty?task=x"]) {
        const r = await fetch(`${base}${path}`, { headers: path.startsWith("/ws") ? { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } : {} });
        expect(r.status, path).toBe(403);
        expect(await r.text(), path).toContain("配信元を経由してください");
      }
      expect((await fetch(`${base}/api/health`, { headers: { [EDGE_HEADER]: "s3cret-value" } })).status).toBe(200);
      expect((await fetch(`${base}/api/tasks`, { headers: { [EDGE_HEADER]: "wrong-value!" } })).status).toBe(403);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`)).toBe(false);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`, { [EDGE_HEADER]: "s3cret-value" })).toBe(true);
    } finally {
      await core.stop();
    }
  });

  test("this machine (127.0.0.1: the runners' /mcp, sb-rescue's health) needs no header", async () => {
    const core = await boot("s3cret-value");
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/health`)).status).toBe(200);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`)).toBe(true);
    } finally {
      await core.stop();
    }
  });

  test("not configured: nothing changes for a request from elsewhere", async () => {
    const core = await boot(undefined, "203.0.113.9");
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/health`)).status).toBe(200);
    } finally {
      await core.stop();
    }
  });
});

// The cloud host's login cookie (#211): the starter Lambda signs `sb_session` after a passkey check; the daemon checks it.
describe("sb_session cookie", () => {
  // The Starter's side (aws/auth.ts): an Ed25519 seed signs; the daemon holds only the public key.
  const privateOf = (seedHex: string) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const publicOf = (seedHex: string) => createPublicKey(privateOf(seedHex)).export({ format: "jwk" }).x!;
  const SEED = "a".repeat(64);
  const KEY = publicOf(SEED);
  const cookieOf = (seedHex: string, passkeyId: string, expires: number) => {
    const body = Buffer.from(`${passkeyId}.${expires}`).toString("base64url");
    return `${SESSION_COOKIE}=${body}.${sign(null, Buffer.from(body), privateOf(seedHex)).toString("base64url")}`;
  };
  /** What a process on the host could make: an HMAC keyed with the only value it has, the public key. */
  const forgedOf = (passkeyId: string, expires: number) => {
    const body = Buffer.from(`${passkeyId}.${expires}`).toString("base64url");
    return `${SESSION_COOKIE}=${body}.${createHmac("sha256", KEY).update(body).digest("base64url")}`;
  };
  const withCookie = (cookie: string) => new Request("http://127.0.0.1:47831/api/tasks", { headers: { cookie: `other=1; ${cookie}` } });

  test("sessionOk: a cookie signed by the Starter's key passes; expired, tampered, another key's, or an HMAC keyed with the public key does not (#701)", () => {
    const now = 1_800_000_000_000;
    expect(sessionOk(withCookie(cookieOf(SEED, "pk1", now + 60_000)), KEY, now)).toBe(true);
    expect(sessionOk(withCookie(cookieOf(SEED, "pk1", now - 1)), KEY, now)).toBe(false);
    expect(sessionOk(withCookie(cookieOf("b".repeat(64), "pk1", now + 60_000)), KEY, now)).toBe(false);
    expect(sessionOk(withCookie(forgedOf("pk1", now + 60_000)), KEY, now)).toBe(false);
    const good = cookieOf(SEED, "pk1", now + 60_000);
    expect(sessionOk(withCookie(`${good}=`), KEY, now)).toBe(false); // another spelling of the same signature
    expect(sessionOk(withCookie(good), "not-a-key", now)).toBe(false);
    const tampered = good.replace(/=([A-Za-z0-9_-]+)\./, (_m, body: string) => `=${Buffer.from(Buffer.from(body, "base64url").toString().replace("pk1", "pk2")).toString("base64url")}.`);
    expect(sessionOk(withCookie(tampered), KEY, now)).toBe(false);
    expect(sessionOk(withCookie(good), undefined, now)).toBe(false);
    expect(sessionOk(new Request("http://x/"), KEY, now)).toBe(false);
  });

  const homes: string[] = [];
  /** A stand-in for the Starter's GET /_auth/status (#708): `loggedIn` (or a 500) as set, each request kept. */
  const starter = { answer: true as boolean | 500, seen: [] as Array<{ path: string; edge: string | null; cookie: string | null }> };
  const starterServer = Bun.serve({ port: 0, fetch: (req) => (starter.seen.push({ path: new URL(req.url).pathname, edge: req.headers.get(EDGE_HEADER), cookie: req.headers.get("cookie") }), starter.answer === 500 ? new Response("", { status: 500 }) : Response.json({ state: "running", registered: true, loggedIn: starter.answer })) });
  const starterUrl = `http://127.0.0.1:${starterServer.port}/`;
  afterAll(() => {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
    void starterServer.stop(true);
  });
  const boot = async (key?: string, edge?: { value: string; peer: string }, o: { starterUrl?: string | null; recheckMs?: number } = {}) => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-session-"));
    homes.push(home);
    starter.answer = true;
    starter.seen = [];
    const env: Record<string, string> = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
    if (key) env.SWITCHBOARD_SESSION_PUBLIC_KEY = key;
    if (edge) env.SWITCHBOARD_EDGE_HEADER_VALUE = edge.value;
    if (o.starterUrl !== null) env.SWITCHBOARD_STARTER_URL = o.starterUrl ?? starterUrl;
    return startServer(loadConfig(env), [], { port: 0, selfdevChecks: false, peerAddress: edge ? () => edge.peer : undefined, sessionRecheckMs: o.recheckMs });
  };
  const wsOpens = (url: string, headers: Record<string, string> = {}) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { headers } as unknown as string[]);
      ws.onopen = () => (ws.close(), resolve(true));
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
    });

  test("off loopback the cookie stands in for the token on /api and /ws; expired or tampered cookies get 401", async () => {
    const core = await boot(KEY);
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      const good = cookieOf(SEED, "pk1", Date.now() + 60_000);
      expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: good } })).status).toBe(200);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk1", Date.now() - 1) } })).status).toBe(401);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: cookieOf("c".repeat(64), "pk1", Date.now() + 60_000) } })).status).toBe(401);
      const forged = forgedOf("pk1", Date.now() + 60_000); // made with what the host holds (#701)
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: forged } })).status).toBe(401);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`, { cookie: forged })).toBe(false);
      expect((await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${core.token}` } })).status).toBe(200); // the token still works
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`)).toBe(false);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`, { cookie: good })).toBe(true);
    } finally {
      await core.stop();
    }
  });

  test("the cookie also opens /ws/pty's auth like /ws, never /mcp (per-task tokens); health says the login is a passkey", async () => {
    const core = await boot(KEY);
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      const good = cookieOf(SEED, "pk1", Date.now() + 60_000);
      const upgrade = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
      expect((await fetch(`${base}/ws/pty?task=nope`, { headers: upgrade })).status).toBe(401);
      expect(await (await fetch(`${base}/ws/pty?task=nope`, { headers: { ...upgrade, cookie: good } })).json()).toMatchObject({ reason: "recent" }); // authenticated, but the shell needs sb_recent (#1491)
      const recent = (() => { const body = Buffer.from(`pk1.${Date.now() + 60_000}`).toString("base64url"); return `${RECENT_COOKIE}=${body}.${sign(null, Buffer.from(`recent:${body}`), privateOf(SEED)).toString("base64url")}`; })();
      expect((await fetch(`${base}/ws/pty?task=nope`, { headers: { ...upgrade, cookie: `${good}; ${recent}` } })).status).toBe(404); // past auth (the task does not exist)
      expect((await fetch(`${base}/mcp/task_x`, { method: "POST", headers: { cookie: good, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ authRequired: true, login: "passkey" });
    } finally {
      await core.stop();
    }
  });

  test("a valid cookie does not replace the CDN's shared header: without it, 403", async () => {
    const core = await boot(KEY, { value: "edge-secret-1", peer: "203.0.113.9" });
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      const good = cookieOf(SEED, "pk1", Date.now() + 60_000);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: good } })).status).toBe(403);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: good, [EDGE_HEADER]: "edge-secret-1" } })).status).toBe(200);
    } finally {
      await core.stop();
    }
  });

  // The cloud host's request log (#1490): one JSON line per request, metadata only.
  const logLines = (spy: { mock: { calls: unknown[][] } }, kind: string) =>
    spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("{") && l.includes(`"log":"${kind}"`)).map((l) => JSON.parse(l) as Record<string, unknown>);

  test("access log: 401 and 200 each leave one line with path (no query), status and the kind of credential; no value is in it", async () => {
    const core = await boot(KEY);
    const base = `http://127.0.0.1:${core.server.port}`;
    const spy = spyOn(console, "log");
    try {
      const good = cookieOf(SEED, "pk1", Date.now() + 60_000);
      expect((await fetch(`${base}/api/tasks?q=secret`)).status).toBe(401);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: good } })).status).toBe(200);
      const lines = logLines(spy, "access");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ log: "access", method: "GET", path: "/api/tasks", status: 401, auth: "none" });
      expect(lines[1]).toMatchObject({ path: "/api/tasks", status: 200, auth: "cookie" });
      const all = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).not.toContain("secret");
      expect(all).not.toContain(good.slice(SESSION_COOKIE.length + 1));
    } finally {
      spy.mockRestore();
      await core.stop();
    }
  });

  test("access log: the viewer address counts only with the shared header; a token is 'token'", async () => {
    const core = await boot(KEY, { value: "edge-secret-1", peer: "10.0.0.5" });
    const base = `http://127.0.0.1:${core.server.port}`;
    const spy = spyOn(console, "log");
    try {
      const viewer = { "cloudfront-viewer-address": "203.0.113.7:4444" };
      await fetch(`${base}/api/tasks`, { headers: { ...viewer, [EDGE_HEADER]: "edge-secret-1" } });
      await fetch(`${base}/api/tasks`, { headers: viewer }); // no shared header: 403, and the claimed address is not believed
      await fetch(`${base}/api/tasks`, { headers: { [EDGE_HEADER]: "edge-secret-1", authorization: "Bearer nope" } });
      await fetch(`${base}/api/tasks`, { headers: { ...viewer, [EDGE_HEADER]: "wrong" } }); // a wrong shared header: not believed either
      const lines = logLines(spy, "access");
      expect(lines.map((l) => [l.from, l.status, l.auth])).toEqual([["203.0.113.7:4444", 401, "none"], ["10.0.0.5", 403, "none"], ["10.0.0.5", 401, "token"], ["10.0.0.5", 403, "none"]]);
    } finally {
      spy.mockRestore();
      await core.stop();
    }
  });

  test("access log: from a loopback peer a wrong shared header does not make the viewer address believed", async () => {
    const core = await boot(KEY, { value: "edge-secret-1", peer: "127.0.0.1" });
    const base = `http://127.0.0.1:${core.server.port}`;
    const spy = spyOn(console, "log");
    try {
      await fetch(`${base}/api/tasks`, { headers: { "cloudfront-viewer-address": "203.0.113.7:4444", [EDGE_HEADER]: "wrong" } });
      await fetch(`${base}/api/tasks`, { headers: { "cloudfront-viewer-address": "203.0.113.7:4444" } });
      expect(logLines(spy, "access").map((l) => l.from)).toEqual(["127.0.0.1", "127.0.0.1"]);
    } finally {
      spy.mockRestore();
      await core.stop();
    }
  });

  test("access log: a daemon on loopback logs nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-nolog-"));
    homes.push(home);
    const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [], { port: 0, selfdevChecks: false });
    const spy = spyOn(console, "log");
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`)).status).toBe(200);
      expect(logLines(spy, "access")).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await core.stop();
    }
  });

  test("operation log: a workspace registration and a settings change leave a line with the changed key names only", async () => {
    const core = await boot(KEY);
    const base = `http://127.0.0.1:${core.server.port}`;
    const spy = spyOn(console, "log");
    try {
      const h = { authorization: `Bearer ${core.token}`, "content-type": "application/json" };
      expect((await fetch(`${base}/api/workspaces`, { method: "POST", headers: h, body: JSON.stringify({ path: tmpdir() }) })).status).toBe(201);
      expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: h, body: JSON.stringify({ shadowRunner: null }) })).status).toBe(200);
      const ops = logLines(spy, "op");
      expect(ops.map((o) => o.op)).toEqual(["workspace.add", "settings.update"]);
      expect(ops[0]).toMatchObject({ detail: { path: tmpdir() } });
      expect(ops[1]).toMatchObject({ detail: { keys: ["shadowRunner"] } });
    } finally {
      spy.mockRestore();
      await core.stop();
    }
  });

  test("every sb_session pair is tried: a stale one first does not hide a good one", () => {
    const now = 1_800_000_000_000;
    const req2 = new Request("http://x/", { headers: { cookie: `${cookieOf(SEED, "old", now - 1)}; ${cookieOf(SEED, "pk1", now + 60_000)}` } });
    expect(sessionOk(req2, KEY, now)).toBe(true);
  });

  test("only a 32-byte public key in base64url turns the cookie login on; the old HMAC key is not read (#701)", () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-shortkey-"));
    homes.push(home);
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_SESSION_PUBLIC_KEY: "short-key" }).sessionPublicKey).toBeUndefined();
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_SESSION_KEY: "a".repeat(64) }).sessionPublicKey).toBeUndefined();
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_SESSION_PUBLIC_KEY: KEY }).sessionPublicKey).toBe(KEY);
  });

  test("the rescue page a person opens (#399): the host's outside URL + /rescue/, sb-rescue's own address on a Mac, none outside sb-rescue", () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-rescuepage-"));
    homes.push(home);
    const rescue = "http://127.0.0.1:47841";
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_RESCUE_URL: rescue, SWITCHBOARD_WEB_URL: "https://d1.example.net" }).rescuePageUrl).toBe("https://d1.example.net/rescue/");
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_RESCUE_URL: rescue, SWITCHBOARD_WEB_URL: "https://d1.example.net/" }).rescuePageUrl).toBe("https://d1.example.net/rescue/");
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_RESCUE_URL: rescue }).rescuePageUrl).toBe(rescue);
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_WEB_URL: "https://d1.example.net" }).rescuePageUrl).toBeUndefined();
  });

  test("a removed passkey's cookie is refused within SESSION_RECHECK_MS: the daemon asks the Starter and caches the answer (#701)", async () => {
    let t = 1_800_000_000_000;
    const seen: Request[] = [];
    let loggedIn = true;
    const check = makeSessionCheck({ publicKey: KEY, starterUrl, edge: "edge-1", now: () => t, fetch: (async (url: string, init: RequestInit) => (seen.push(new Request(url, init)), Response.json({ loggedIn }))) as unknown as typeof fetch });
    const good = cookieOf(SEED, "pk1", t + 24 * 3600_000);
    const value = good.slice(SESSION_COOKIE.length + 1);
    expect(await check(withCookie(good))).toBe(value);
    loggedIn = false; // the passkey is removed from auth/passkeys.json
    t += SESSION_RECHECK_MS - 1;
    expect(await check(withCookie(good))).toBe(value); // still the kept answer
    expect(seen).toHaveLength(1);
    t += 1;
    expect(await check(withCookie(good))).toBeUndefined(); // asked again: gone
    expect(seen).toHaveLength(2);
    expect(await check(withCookie(good))).toBeUndefined(); // the refusal is kept too: no request per call
    expect(seen).toHaveLength(2);
    // an open socket's recheck asks afresh, whatever is kept: one period is the most a removed passkey's socket stays
    loggedIn = true;
    expect(await check(withCookie(good), true)).toBe(value);
    expect(seen).toHaveLength(3);
    // a cookie that does not verify is never asked about
    expect(await check(withCookie(forgedOf("pk1", t + 60_000)))).toBeUndefined();
    expect(seen).toHaveLength(3);
    // the daemon's API, through a stand-in Starter
    const core = await boot(KEY);
    try {
      const base = `http://127.0.0.1:${core.server.port}`;
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) } })).status).toBe(200);
      starter.answer = false;
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk2", Date.now() + 60_000) } })).status).toBe(401);
    } finally {
      await core.stop();
    }
  });

  test("no answer from the Starter refuses the cookie; the edge header is sent (#701)", async () => {
    const core = await boot(KEY, { value: "edge-secret-1", peer: "203.0.113.9" });
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      const cookie = cookieOf(SEED, "pk1", Date.now() + 60_000);
      starter.answer = 500;
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie, [EDGE_HEADER]: "edge-secret-1" } })).status).toBe(401);
      starter.answer = true; // back: the failure was not kept
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie, [EDGE_HEADER]: "edge-secret-1" } })).status).toBe(200);
      const asked = starter.seen.at(-1)!;
      expect(asked).toEqual({ path: "/_auth/status", edge: "edge-secret-1", cookie });
    } finally {
      await core.stop();
    }
    const down = await boot(KEY, undefined, { starterUrl: "http://127.0.0.1:1/" });
    try {
      expect((await fetch(`http://127.0.0.1:${down.server.port}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) } })).status).toBe(401);
    } finally {
      await down.stop();
    }
  });

  test("a WebSocket's upgrade asks the Starter afresh, while plain requests use the kept answer (#708)", async () => {
    const core = await boot(KEY, undefined, { recheckMs: 60_000 });
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      const cookie = cookieOf(SEED, "pk1", Date.now() + 3600_000);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status).toBe(200); // kept: true, for a minute
      starter.answer = false; // the passkey is removed
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status).toBe(200); // the kept answer
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`, { cookie })).toBe(false); // asked again: refused
    } finally {
      await core.stop();
    }
  });

  test("an open WebSocket authorized by a revoked cookie is closed at the next recheck (#701)", async () => {
    const core = await boot(KEY, undefined, { recheckMs: 100 });
    const port = core.server.port;
    const open = (headers: Record<string, string>, url = `ws://127.0.0.1:${port}/ws`) =>
      new Promise<{ ws: WebSocket; code: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(url, { headers } as unknown as string[]);
        const code = new Promise<number>((done) => (ws.onclose = (e) => done(e.code)));
        ws.onopen = () => resolve({ ws, code });
        ws.onerror = () => reject(new Error("did not open"));
      });
    try {
      const byCookie = await open({ cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) });
      const byToken = await open({}, `ws://127.0.0.1:${port}/ws?token=${core.token}`);
      starter.answer = false; // the passkey is removed
      expect(await Promise.race([byCookie.code, Bun.sleep(3000).then(() => -1)])).toBe(4401);
      expect(byToken.ws.readyState).toBe(WebSocket.OPEN);
      byToken.ws.close();
    } finally {
      await core.stop();
    }
  });

  test("on the cloud host a token from off the machine is refused: API, WebSocket ?token= and /mcp; the cookie still works (#701)", async () => {
    let peer = "10.0.1.5";
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-offhost-"));
    homes.push(home);
    starter.answer = true;
    const idle: RunnerAdapter = {
      id: "claude",
      detect: async () => ({ available: true }),
      start(_o, emit) {
        queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" }));
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: new Promise(() => undefined) };
      },
    };
    const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_SESSION_PUBLIC_KEY: KEY, SWITCHBOARD_STARTER_URL: starterUrl };
    const core = await startServer(loadConfig(env), [idle], { port: 0, selfdevChecks: false, peerAddress: () => peer });
    const base = `http://127.0.0.1:${core.server.port}`;
    const bearer = { authorization: `Bearer ${core.token}` };
    try {
      // a task and its MCP endpoint, made from this machine
      peer = "127.0.0.1";
      const task = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "t", prompt: "p", runner: "claude" }) })).json()) as { id: string };
      const ep = (await (await fetch(`${base}/api/tasks/${task.id}/mcp`, { headers: bearer })).json()) as { token: string };
      const mcpPost = () => fetch(`${base}/mcp/${task.id}?token=${ep.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect((await mcpPost()).status).toBe(400); // past the token: "send initialize first"
      // from elsewhere (CloudFront's VPC origin, another machine)
      peer = "10.0.1.5";
      expect((await fetch(`${base}/api/tasks`, { headers: bearer })).status).toBe(401);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws?token=${core.token}`)).toBe(false);
      expect((await mcpPost()).status).toBe(401);
      expect((await fetch(`${base}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) } })).status).toBe(200);
      expect(await wsOpens(`ws://127.0.0.1:${core.server.port}/ws`, { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) })).toBe(true);
    } finally {
      await core.stop();
    }
  });

  test("on the cloud host the token still works from loopback, and a Mac is unchanged (#701)", async () => {
    const cloud = await boot(KEY, { value: "", peer: "127.0.0.1" });
    try {
      expect((await fetch(`http://127.0.0.1:${cloud.server.port}/api/tasks`, { headers: { authorization: `Bearer ${cloud.token}` } })).status).toBe(200);
      expect(await wsOpens(`ws://127.0.0.1:${cloud.server.port}/ws?token=${cloud.token}`)).toBe(true);
    } finally {
      await cloud.stop();
    }
    const mac = await boot(undefined, { value: "", peer: "10.0.1.5" }, { starterUrl: null });
    try {
      expect((await fetch(`http://127.0.0.1:${mac.server.port}/api/tasks`, { headers: { authorization: `Bearer ${mac.token}` } })).status).toBe(200);
      expect(await wsOpens(`ws://127.0.0.1:${mac.server.port}/ws?token=${mac.token}`)).toBe(true);
    } finally {
      await mac.stop();
    }
  });

  test("no key (a Mac or a host without the login): a cookie is never enough", async () => {
    const core = await boot();
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/tasks`, { headers: { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) } })).status).toBe(401);
      expect(await (await fetch(`http://127.0.0.1:${core.server.port}/api/health`)).json()).toMatchObject({ login: "token" });
    } finally {
      await core.stop();
    }
  });

  // The daemon's failure limit (#1492): the Starter's rule (aws/auth.ts) — 10 refusals in 10 minutes, then 429.
  describe("failure limit", () => {
    const EDGE = "edge-secret-1";
    const VIEWER = "cloudfront-viewer-address";
    const get = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/api/tasks`, { headers: { [EDGE_HEADER]: EDGE, ...headers } }).then((r) => r.status);
    const statuses = async (n: number, f: () => Promise<number>) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(await f());
      return out;
    };

    test("the 11th unauthorized request is 429, also with a valid cookie; another viewer address is not affected", async () => {
      const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        const bad = { [VIEWER]: "198.51.100.7:40000" };
        expect(await statuses(10, () => get(base, bad))).toEqual(Array(10).fill(401));
        expect(await get(base, bad)).toBe(429);
        const good = cookieOf(SEED, "pk1", Date.now() + 60_000);
        expect(await get(base, { ...bad, cookie: good })).toBe(429);
        expect((await fetch(`${base}/`, { headers: { [EDGE_HEADER]: EDGE, ...bad } })).status).toBe(429);
        expect(await get(base, { [VIEWER]: "198.51.100.8:40000", cookie: good })).toBe(200);
        expect(await get(base, { [VIEWER]: "198.51.100.8:40000" })).toBe(401);
      } finally {
        await core.stop();
      }
    });

    test("an IPv6 viewer is keyed by its /64", async () => {
      const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        expect(await statuses(10, (i = 0) => get(base, { [VIEWER]: `2001:db8:1:2::${i + 1}:5000` }))).toEqual(Array(10).fill(401));
        expect(await get(base, { [VIEWER]: "2001:db8:1:2:aaaa:bbbb:cccc:dddd:6000" })).toBe(429);
        expect(await get(base, { [VIEWER]: "2001:db8:1:3::1:6000" })).toBe(401);
      } finally {
        await core.stop();
      }
    });

    test("a request without the viewer address (edge header set) is never counted", async () => {
      const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        expect(new Set(await statuses(20, () => get(base)))).toEqual(new Set([401]));
        expect(await get(base, { cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) })).toBe(200);
      } finally {
        await core.stop();
      }
    });

    test("a peer on this machine is never counted", async () => {
      const core = await boot(KEY, { value: EDGE, peer: "127.0.0.1" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        expect(new Set(await statuses(20, () => get(base, { [VIEWER]: "198.51.100.7:40000" })))).toEqual(new Set([401]));
      } finally {
        await core.stop();
      }
    });

    test("a handler's own 403 is not counted", async () => {
      const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        const ws = core.db.listWorkspaces()[0]!;
        const task = (id: string) => ({ id, workspaceId: ws.id, title: id, runner: "claude" as const, cwd: ws.path, scope: [ws.path], status: "idle" as const, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto" as const, effort: null, origin: "switchboard" as const, resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown" as const, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
        core.db.insertTask(task("tsk_a"));
        core.db.insertTask(task("tsk_b"));
        core.db.insertStaged({ id: "stg_1", taskId: "tsk_b", path: join(ws.path, "x"), rel: "x", kind: "modify", before: "", after: "", status: "pending", ts: 1, decidedAt: null, diff: "", stat: "" } as never);
        const headers = { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.7:40000", cookie: cookieOf(SEED, "pk1", Date.now() + 60_000) };
        const codes = await statuses(11, async () => (await fetch(`${base}/api/tasks/tsk_a/staging/stg_1/reject`, { method: "POST", headers })).status);
        expect(codes).toEqual(Array(11).fill(403));
        expect(await get(base, { [VIEWER]: "198.51.100.7:40000", cookie: headers.cookie })).toBe(200);
      } finally {
        await core.stop();
      }
    });

    test("each kind of refusal counts: another Origin (also on a socket), a socket and a terminal without a cookie, a static file without the CDN's header, a per-task token off this machine, a request without the CDN's header", async () => {
      // each on a server of its own: without the CDN's header the key is the peer, shared by those two kinds
      const refusals: Array<(base: string) => Promise<number>> = [
        (base) => fetch(`${base}/api/tasks`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.20:1", origin: "https://evil.example" } }).then((r) => r.status),
        (base) => fetch(`${base}/ws`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.21:1" } }).then((r) => r.status),
        (base) => fetch(`${base}/mcp/tsk_x`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.22:1" } }).then((r) => r.status),
        (base) => fetch(`${base}/api/tasks`, { headers: { [VIEWER]: "198.51.100.23:1" } }).then((r) => r.status),
        (base) => fetch(`${base}/ws`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.24:1", origin: "https://evil.example" } }).then((r) => r.status),
        (base) => fetch(`${base}/ws/pty?task=tsk_x`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.25:1" } }).then((r) => r.status),
        (base) => fetch(`${base}/ws/pty?task=tsk_x`, { headers: { [EDGE_HEADER]: EDGE, [VIEWER]: "198.51.100.27:1", origin: "https://evil.example" } }).then((r) => r.status),
        (base) => fetch(`${base}/index.html`, { headers: { [VIEWER]: "198.51.100.26:1" } }).then((r) => r.status), // the static fetch: no CDN header
      ];
      for (const [i, refuse] of refusals.entries()) {
        const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
        const base = `http://127.0.0.1:${core.server.port}`;
        try {
          const first = await refuse(base);
          expect([401, 403], `kind ${i} got ${first}`).toContain(first);
          for (let n = 1; n < 10; n++) await refuse(base);
          expect(await refuse(base), `kind ${i}`).toBe(429);
        } finally {
          await core.stop();
        }
      }
    });

    test("a refused request is in the access log with its 429", async () => {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      const core = await boot(KEY, { value: EDGE, peer: "203.0.113.9" });
      const base = `http://127.0.0.1:${core.server.port}`;
      try {
        for (let i = 0; i < 11; i++) await get(base, { [VIEWER]: "198.51.100.30:1" });
        const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"log":"access"'));
        expect(lines.some((l) => l.includes('"status":429') && l.includes("198.51.100.30"))).toBe(true);
      } finally {
        spy.mockRestore();
        await core.stop();
      }
    });

    test("makeFailureLimit: the window slides, so the key is free 10 minutes after the 10th refusal; addressKey keeps IPv4 and cuts IPv6 to /64", () => {
      let t = 1_000;
      const lim = makeFailureLimit({ now: () => t });
      for (let i = 0; i < 9; i++) lim.failed("k");
      expect(lim.limited("k")).toBe(false);
      lim.failed("k");
      expect(lim.limited("k")).toBe(true);
      expect(lim.limited("other")).toBe(false);
      t += FAILURE_WINDOW_MS;
      expect(lim.limited("k")).toBe(false);
      expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
      expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7"); // a dual-stack peer is not one /64 for everyone
      expect(addressKey("::ffff:198.51.100.7")).not.toBe(addressKey("::ffff:203.0.113.5"));
      expect(addressKey("2001:db8:1:2::9")).toBe(addressKey("2001:db8:1:2:1:2:3:4"));
    });
  });

  describe("sb_recent (#1491)", () => {
    // The Starter's "checked just now" cookie: the same body, signed over "recent:" + body (aws/auth.ts recentValue).
    const recentCookieOf = (seedHex: string, passkeyId: string, expires: number) => {
      const body = Buffer.from(`${passkeyId}.${expires}`).toString("base64url");
      return `${RECENT_COOKIE}=${body}.${sign(null, Buffer.from(`recent:${body}`), privateOf(seedHex)).toString("base64url")}`;
    };
    const valueOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

    test("recentOk: needs the session's own passkey, a valid signature over \"recent:\" + body, and an unexpired value", () => {
      const now = 1_800_000_000_000;
      const session = valueOf(cookieOf(SEED, "pk1", now + 3600_000));
      const req = (cookie: string) => new Request("http://x/", { headers: { cookie } });
      expect(recentOk(req(recentCookieOf(SEED, "pk1", now + 60_000)), KEY, session, now)).toBe(true);
      expect(recentOk(req(`${recentCookieOf(SEED, "pk2", now + 60_000)}; ${recentCookieOf(SEED, "pk1", now + 60_000)}`), KEY, session, now)).toBe(true); // any pair
      expect(recentOk(req(recentCookieOf(SEED, "pk2", now + 60_000)), KEY, session, now)).toBe(false); // another passkey
      expect(recentOk(req(recentCookieOf(SEED, "pk1", now - 1)), KEY, session, now)).toBe(false); // expired
      expect(recentOk(req(recentCookieOf("b".repeat(64), "pk1", now + 60_000)), KEY, session, now)).toBe(false); // another key
      expect(recentOk(req(`${RECENT_COOKIE}=${session}`), KEY, session, now)).toBe(false); // the session value pasted in
      expect(recentOk(req(recentCookieOf(SEED, "pk1", now + 60_000)), undefined, session, now)).toBe(false);
      expect(recentOk(new Request("http://x/"), KEY, session, now)).toBe(false);
    });

    const idle: RunnerAdapter = {
      id: "claude",
      permissionModes: [{ value: "default", label: "default", description: "default" }, { value: "bypass", label: "bypass", description: "bypass", danger: true }],
      defaultPermissionMode: "default",
      detect: async () => ({ available: true }),
      start(_o, emit) {
        queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" }));
        return { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: new Promise(() => undefined) };
      },
    };
    const bootStrong = async (peerRef: { peer: string }) => {
      const home = mkdtempSync(join(tmpdir(), "switchboard-test-recent-"));
      homes.push(home);
      starter.answer = true;
      const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_SESSION_PUBLIC_KEY: KEY, SWITCHBOARD_STARTER_URL: starterUrl };
      const core = await startServer(loadConfig(env), [idle], { port: 0, selfdevChecks: false, dryRunRestart: true, peerAddress: () => peerRef.peer });
      return { core, home };
    };

    test("Cookie-only requests to the seven strongest operations get 401 recent; with a same-passkey sb_recent they pass; a token from this machine never needs it", async () => {
      const peerRef = { peer: "127.0.0.1" };
      const { core, home } = await bootStrong(peerRef);
      const base = `http://127.0.0.1:${core.server.port}`;
      const bearer = { authorization: `Bearer ${core.token}` };
      const post = (path: string, headers: Record<string, string>, body: unknown = {}, method = "POST") =>
        fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      try {
        const task = (await (await post("/api/tasks", bearer, { cwd: home, title: "t", prompt: "p", runner: "claude" })).json()) as { id: string };
        peerRef.peer = "10.0.1.5"; // CloudFront's VPC origin: only the cookie counts
        const session = cookieOf(SEED, "pk1", Date.now() + 3600_000);
        const recent = recentCookieOf(SEED, "pk1", Date.now() + 60_000);
        // [name, the status a request that passes the check gets, the call]
        const calls: Array<[string, number, (h: Record<string, string>) => Promise<Response>]> = [
          ["restart", 200, (h) => post("/api/daemon/restart", h, { force: true })], // dry run (a task is running)
          ["promote", 409, (h) => post("/api/daemon/promote", h)], // no rescueUrl
          ["workspaces", 201, (h) => post("/api/workspaces", h, { path: home })],
          ["settings", 200, (h) => post("/api/settings", h, {}, "PATCH")],
          ["danger task", 201, (h) => post("/api/tasks", h, { cwd: home, title: "d", prompt: "p", runner: "claude", permissionMode: "bypass" })],
          ["danger switch", 200, (h) => post(`/api/tasks/${task.id}/permission-mode`, h, { mode: "bypass" })],
          ["pty", 426, (h) => fetch(`${base}/ws/pty?task=${task.id}`, { headers: h })], // a plain GET is past the check, then not an upgrade
        ];
        for (const [name, passes, call] of calls) {
          const refused = await call({ cookie: session });
          expect([name, refused.status]).toEqual([name, 401]);
          expect(await refused.json()).toEqual({ error: "操作の前にパスキーで確かめてください", reason: "recent" });
          for (const cookie of [`${session}; ${recentCookieOf(SEED, "pk2", Date.now() + 60_000)}`, `${session}; ${recentCookieOf(SEED, "pk1", Date.now() - 1)}`, `${session}; ${RECENT_COOKIE}=${valueOf(session)}`]) {
            expect([name, (await call({ cookie })).status]).toEqual([name, 401]);
          }
          expect([name, (await call({ cookie: `${session}; ${recent}` })).status]).toEqual([name, passes]);
        }
        expect(await new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${core.server.port}/ws/pty?task=${task.id}`, { headers: { cookie: `${session}; ${recent}` } } as unknown as string[]);
          ws.onopen = () => (ws.close(), resolve(true));
          ws.onerror = () => resolve(false);
        })).toBe(true);
        // not strong: a mode that is not dangerous, and the other guarded routes
        expect((await post("/api/tasks", { cookie: session }, { cwd: home, title: "ok", prompt: "p", runner: "claude", permissionMode: "default" })).status).toBe(201);
        expect((await fetch(`${base}/api/tasks`, { headers: { cookie: session } })).status).toBe(200);
        // the token from this machine needs no sb_recent
        peerRef.peer = "127.0.0.1";
        for (const [name, , call] of calls) expect([name, (await call(bearer)).status === 401]).toEqual([name, false]);
      } finally {
        await core.stop();
      }
    });

    test("answer policies (#938): saving or editing one needs the passkey check from a cookie and is refused to a token — a Task can read it — while a plain answer is not", async () => {
      const peerRef = { peer: "127.0.0.1" };
      const { core, home } = await bootStrong(peerRef);
      void home;
      const base = `http://127.0.0.1:${core.server.port}`;
      const bearer = { authorization: `Bearer ${core.token}` };
      const send = (path: string, headers: Record<string, string>, body: unknown, method = "POST") =>
        fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const policy = { scope: "repo", target: "bun test*", when: [], expiresAt: Date.now() + 86_400_000 };
      const save = (h: Record<string, string>) => send("/api/asks/answer", h, { id: "approval:t:p", answer: { kind: "allow" }, policy });
      const edit = (h: Record<string, string>) => send("/api/policies/pol_x", h, { revoked: true }, "PATCH");
      try {
        const session = cookieOf(SEED, "pk1", Date.now() + 3600_000);
        const recent = recentCookieOf(SEED, "pk1", Date.now() + 60_000);
        // the token, from this machine (what a runner's Task has), with or without the page's Origin
        for (const call of [save, edit]) {
          for (const h of [bearer, { ...bearer, origin: "http://evil.example" }, { ...bearer, origin: base }] as Array<Record<string, string>>) {
            const r = await call(h);
            expect(r.status).toBe(403);
            if (h.origin !== "http://evil.example") expect(await r.json()).toMatchObject({ reason: "human" });
          }
        }
        peerRef.peer = "10.0.1.5"; // the person's browser, through CloudFront
        for (const call of [save, edit]) {
          const refused = await call({ cookie: session });
          expect(refused.status).toBe(401);
          expect(await refused.json()).toMatchObject({ reason: "recent" });
        }
        expect((await edit({ cookie: `${session}; ${recent}` })).status).toBe(404); // past the checks: no such policy
        expect((await save({ cookie: `${session}; ${recent}` })).status).toBe(409); // past the checks: no such question
        // an answer with no policy needs neither (a Task answers its own approval as before)
        peerRef.peer = "127.0.0.1";
        expect((await send("/api/asks/answer", bearer, { id: "approval:t:p", answer: { kind: "allow" } })).status).toBe(409);
      } finally {
        await core.stop();
      }
    });

    test("a cookie that ends while the body of a danger-mode request is still arriving is refused, not taken for a token", async () => {
      const peerRef = { peer: "127.0.0.1" };
      const { core, home } = await bootStrong(peerRef);
      const base = `http://127.0.0.1:${core.server.port}`;
      const bearer = { authorization: `Bearer ${core.token}` };
      try {
        const task = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "t", prompt: "p", runner: "claude" }) })).json()) as { id: string };
        peerRef.peer = "10.0.1.5";
        const slow = (path: string, body: unknown) => {
          const cookie = cookieOf(SEED, "pk1", Date.now() + 300); // good at the entrance, over before the body is in
          const stream = new ReadableStream({ async start(c) { await Bun.sleep(700); c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close(); } });
          return fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
        };
        expect((await slow("/api/tasks", { cwd: home, title: "d", prompt: "p", runner: "claude", permissionMode: "bypass" })).status).toBe(401);
        expect((await slow(`/api/tasks/${task.id}/permission-mode`, { mode: "bypass" })).status).toBe(401);
        peerRef.peer = "127.0.0.1";
        expect(((await (await fetch(`${base}/api/tasks`, { headers: bearer })).json()) as unknown[]).length).toBe(1); // no dangerous task was made
      } finally {
        await core.stop();
      }
    });
  });
});
