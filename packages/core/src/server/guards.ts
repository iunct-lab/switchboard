import type { RunnerId } from "@switchboard/protocol";
import { accessLine, authKind, opLine } from "../accesslog.ts";
import { TASK_HEADER, TASK_TOKEN_HEADER, addressKey, edgeOk, hostAllowed, isLoopbackAddress, recentOk, sameOrigin, tokenEquals, tokenFromRequest, isLoopback, LOOPBACK_HOSTNAMES, loadOrCreateToken, makeFailureLimit, makeSessionCheck, SESSION_COOKIE, SESSION_RECHECK_MS } from "../auth.ts";
import type { Routes, Peer, AnyHandler, ServerContext, ServerContextInit, WsData } from "./context.ts";
import type { ServerWebSocket } from "bun";
import { API_REQUESTS_FLUSH_MS } from "./helpers.ts";

// The /mcp endpoint has its own per-task token; health is open so the UI can learn whether a token is needed; a GitHub
// Webhook cannot carry the token and only asks for an import, once the user opened it.
// The CDN's origin header and, on loopback, the Host come before everything, the open routes included: a
// cloud host answers nothing to a request that went around CloudFront, a Mac nothing to a page on a rebinding name.
export function guardAll<T extends Routes>(sc: Pick<ServerContext, "logged" | "limitedGuard" | "entryGuard" | "webhookOpen" | "guard">, routes: T): T {
  return Object.fromEntries(Object.entries(routes).map(([path, h]) => [path, sc.logged(path, sc.limitedGuard(sc.entryGuard(path === "/api/health" || path === "/ws" || path === "/ws/pty" || path.startsWith("/mcp/") || path.startsWith("/otel/") || path.startsWith("/artifacts/") || (path === "/api/backlog/webhooks/github" && sc.webhookOpen) ? (h as AnyHandler) : sc.guard(h as AnyHandler))))])) as T;
}

export const hostOk = (sc: Pick<ServerContext, "authRequired" | "allowedHosts">, req: Request) => sc.authRequired || hostAllowed(req, sc.allowedHosts);

export const peerOf = (sc: Pick<ServerContext, "opts">, req: Request, srv: Peer) => (sc.opts.peerAddress ? sc.opts.peerAddress(req) : srv?.requestIP(req)?.address);

export const tokenCounts = (sc: Pick<ServerContext, "cfg" | "peerOf">, req: Request, srv: Peer) => {
  if (!sc.cfg.sessionPublicKey) return true;
  const peer = sc.peerOf(req, srv);
  return peer !== undefined && isLoopbackAddress(peer);
};

/**
 * The Task a request comes from, or null: `x-task-id` names it and `x-task-token` carries the token
 * of that Task's own endpoint (`WorkspaceMcp.issue`, gone when the Task ends) — the same proof the /mcp and /otel routes
 * ask for, counted where they count it. A Task's id in a request's body is a statement, not this: what a request may do
 * as a Task (be left out of a promotion's count, end its own turn) is decided by this value only. The proof is what the
 * daemon hands a caller that already holds the local API token, so it says which Task a request was made for, not that
 * no other local process could have made it (`docs/design/workspace-mcp.md`, "Local API token").
 */
export const callingTask = (sc: Pick<ServerContext, "tokenCounts" | "mcp">, req: Request, srv: Peer): string | null => {
  const id = req.headers.get(TASK_HEADER);
  return id && sc.tokenCounts(req, srv) && sc.mcp.verify(id, req.headers.get(TASK_TOKEN_HEADER)) ? id : null;
};

// `fresh`: a WebSocket's upgrade asks the Starter whatever is kept, so the socket's first answer is new and the
// periodic recheck below ends it within one period.
export const authorize = async (sc: Pick<ServerContext, "authRequired" | "tokenCounts" | "token" | "sessionCheck">, req: Request, srv: Peer, allowQuery = false, fresh = false): Promise<{ ok: boolean; session?: string }> => {
  if (!sc.authRequired || (sc.tokenCounts(req, srv) && tokenEquals(tokenFromRequest(req, allowQuery), sc.token))) return { ok: true };
  const session = await sc.sessionCheck(req, fresh);
  return { ok: session !== undefined, session };
};

export const authorized = async (sc: Pick<ServerContext, "authorize">, req: Request, srv: Peer, allowQuery = false) => (await sc.authorize(req, srv, allowQuery)).ok;

export const localUrl = (sc: Pick<ServerContext, "localHost" | "server" | "cfg">) => `http://${sc.localHost}:${sc.server?.port ?? sc.cfg.port}`;

export const publicUrl = (sc: Pick<ServerContext, "cfg" | "server">) => sc.cfg.publicUrl ?? `http://${sc.cfg.host === "0.0.0.0" ? "127.0.0.1" : sc.cfg.host}:${sc.server?.port ?? sc.cfg.port}`;

// The strongest operations: a request that came in on the cookie also needs the Starter's 5-minute passkey
// check (`sb_recent`), as sb-rescue's screen does. A token (this machine, a Mac) is unchanged: `session` is unset.
export const recentRefusal = (sc: Pick<ServerContext, "cfg" | "json">, req: Request, session: string | undefined) =>
  session !== undefined && !recentOk(req, sc.cfg.sessionPublicKey, session) ? sc.json({ error: "操作の前にパスキーで確かめてください", reason: "recent" }, 401) : null;

// `authorize` again (the answer is kept): a session that ended while the body was still arriving is refused, not taken for a token.
export const recentCheck = async (sc: Pick<ServerContext, "authorize" | "recentRefusal" | "json">, req: Request, srv: Peer) => {
  const auth = await sc.authorize(req, srv);
  return auth.ok ? sc.recentRefusal(req, auth.session) : sc.json({ error: "unauthorized" }, 401);
};

export const strong = (sc: Pick<ServerContext, "recentCheck">, fn: AnyHandler): AnyHandler => async (req, srv) => (await sc.recentCheck(req, srv)) ?? fn(req, srv);

/**
 * Making or changing a saved answer policy lasts past one answer, so it is a person's: it needs the passkey check
 * of `strong`, and it is refused to a Task. A runner can read the daemon's token, so a token is taken only from the web
 * UI's own page (this origin and Sec-Fetch-Site: same-origin); on the cloud host, where the passkey login is on, only the
 * cookie counts. Without the passkey login that is a check on how the request looks, not a proof: a Task on this machine,
 * which runs as the same user, can forge both headers. Answers a Task gives to its own approval are unchanged: they allow one thing, once.
 */
export const humanCheck = async (sc: Pick<ServerContext, "authorize" | "json" | "recentRefusal" | "cfg">, req: Request, srv: Peer): Promise<Response | null> => {
  const auth = await sc.authorize(req, srv);
  if (!auth.ok) return sc.json({ error: "unauthorized" }, 401);
  const recent = sc.recentRefusal(req, auth.session);
  if (recent) return recent;
  if (auth.session === undefined && (sc.cfg.sessionPublicKey || !fromPage(req))) return sc.json({ error: "回答の方針は画面（ブラウザ）から作ります。Task のトークンからは作れません", reason: "human" }, 403);
  return null;
};

// the browser adds Sec-Fetch-Site itself and a page cannot change it; a Task's curl has to forge it with the origin
const fromPage = (req: Request) => !!req.headers.get("origin") && sameOrigin(req) && req.headers.get("sec-fetch-site") === "same-origin";

/**
 * Whether a request looks like the web UI's (the look `humanCheck` asks for, without its passkey check): the login's
 * cookie where the passkey login is on, else this origin with Sec-Fetch-Site: same-origin. It says how a text came in, so
 * that a merge grant read from it is recorded as the screen's or as a bare call's (merge-grants.ts). It is not a proof and
 * no boundary: without the passkey login a Task on this machine can send the same headers.
 */
export const screenLook = async (sc: Pick<ServerContext, "authorize" | "cfg">, req: Request, srv: Peer): Promise<boolean> => {
  const auth = await sc.authorize(req, srv);
  if (!auth.ok) return false;
  if (auth.session !== undefined) return true;
  return !sc.cfg.sessionPublicKey && fromPage(req);
};

export const dangerMode = (sc: Pick<ServerContext, "adapterMap">, runner: string, mode: string | undefined) => !!mode && sc.adapterMap.get(runner as RunnerId)?.permissionModes?.find((m) => m.value === mode)?.danger === true;

export const viaEdge = (sc: Pick<ServerContext, "cfg" | "peerOf">, req: Request, srv: Peer) =>
  edgeOk(req, sc.cfg.edgeHeaderValue, sc.peerOf(req, srv));

export const notViaEdge = (sc: Pick<ServerContext, "json">) => sc.json({ error: "配信元を経由してください" }, 403);

export const notAllowedHost = (sc: Pick<ServerContext, "json" | "server" | "cfg">) => sc.json({ error: `host not allowed: open http://127.0.0.1:${sc.server?.port ?? sc.cfg.port} or set SWITCHBOARD_PUBLIC_URL` }, 403);

// The request log, only where a login guards the daemon (off loopback). The client is CloudFront's viewer
// address, believed only on a request that carried the shared header; otherwise the connection's peer.
export const clientOf = (sc: Pick<ServerContext, "cfg" | "peerOf">, req: Request, srv: Peer) => {
  // the header itself must match (peer left out): a loopback peer is let through by viaEdge without one
  const viewer = sc.cfg.edgeHeaderValue && edgeOk(req, sc.cfg.edgeHeaderValue, undefined) ? req.headers.get("cloudfront-viewer-address") : null;
  return viewer || sc.peerOf(req, srv);
};

export const limitKeyOf = (sc: Pick<ServerContext, "peerOf" | "cfg" | "clientOf">, req: Request, srv: Peer): string | undefined => {
  const peer = sc.peerOf(req, srv);
  if (peer && isLoopbackAddress(peer)) return undefined;
  if (sc.cfg.edgeHeaderValue && !req.headers.get("cloudfront-viewer-address")) return undefined;
  // clientOf is CloudFront's viewer address ("ip:port", IPv6 bracketed or not; believed only with the shared header)
  // or else the connection's peer, a bare address
  const from = sc.clientOf(req, srv);
  if (!from) return undefined;
  return addressKey(from === peer ? from : from.slice(0, from.lastIndexOf(":")).replace(/^\[|\]$/g, ""));
};

export const refused = (sc: Pick<ServerContext, "limitKeyOf" | "failures">, req: Request, srv: Peer, res: Response): Response => {
  const key = sc.limitKeyOf(req, srv);
  if (key) sc.failures.failed(key);
  return res;
};

export const limitedGuard = (sc: Pick<ServerContext, "limitKeyOf" | "failures" | "bad">, h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
  const wrap = (fn: AnyHandler): AnyHandler => (req, srv) => {
    const key = sc.limitKeyOf(req, srv);
    return key && sc.failures.limited(key) ? sc.bad("too many failed attempts; wait and try again", 429) : fn(req, srv);
  };
  if (typeof h === "function") return wrap(h);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
};

export const logOp = (sc: Pick<ServerContext, "clientOf" | "authRequired">, req: Request, srv: Peer, op: string, extra: { task?: string; detail?: unknown } = {}, from = sc.clientOf(req, srv)) => {
  if (sc.authRequired) console.log(opLine({ t: Date.now(), from, op, ...extra }));
};

export const flushApiRequests = (sc: Pick<ServerContext, "apiRequests" | "db" | "apiRequestsFailed">) => {
  if (sc.apiRequests.length === 0) return;
  const rows = sc.apiRequests;
  sc.apiRequests = [];
  try {
    sc.db.insertApiRequests(rows);
  } catch (e) {
    // a timing record is not worth the daemon (a lock held past the busy timeout): drop the batch, say it once
    if (!sc.apiRequestsFailed) console.warn(`api_requests: write failed (${String((e as Error).message ?? e)})`);
    sc.apiRequestsFailed = true;
  }
};

export const logged = (sc: Pick<ServerContext, "authRequired" | "clientOf" | "apiRequests">, route: string | null, h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
  if (!sc.authRequired && route === null) return h;
  const wrap = (fn: AnyHandler): AnyHandler => async (req, srv) => {
    const t0 = performance.now();
    // read before the handler runs: a socket's peer is gone once it has been upgraded
    const who = sc.authRequired ? { from: sc.clientOf(req, srv), method: req.method, path: new URL(req.url).pathname.replace(/^(\/artifacts\/)[^/]*/, "$1<key>"), auth: authKind(req) } : null;
    const done = (status: number, res?: Response) => {
      const ms = performance.now() - t0;
      if (who) console.log(accessLine({ t: Date.now(), ...who, status, ms }));
      // a WebSocket upgrade's time is not a request's speed
      if (route !== null && status !== 101) sc.apiRequests.push({ ts: Date.now(), method: req.method, route, status, ms, bytes: Number(res?.headers.get("content-length")) || null });
    };
    try {
      const res = await fn(req, srv);
      if (res instanceof Response) done(res.status, res);
      else done(101); // undefined = a WebSocket upgrade
      return res;
    } catch (e) {
      done(500);
      throw e;
    }
  };
  if (typeof h === "function") return wrap(h);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
};

// The entrance of every route: the CDN's header, then the Host on loopback.
export const entryGuard = (sc: Pick<ServerContext, "viaEdge" | "refused" | "notViaEdge" | "hostOk" | "notAllowedHost">, h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
  const wrap = (fn: AnyHandler): AnyHandler => (req, srv) => (!sc.viaEdge(req, srv) ? sc.refused(req, srv, sc.notViaEdge()) : !sc.hostOk(req) ? sc.refused(req, srv, sc.notAllowedHost()) : fn(req, srv));
  if (typeof h === "function") return wrap(h);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
};

export const guard = (sc: Pick<ServerContext, "refused" | "bad" | "authorized" | "cfg">, h: AnyHandler | Record<string, AnyHandler>): AnyHandler | Record<string, AnyHandler> => {
  const wrap = (fn: AnyHandler): AnyHandler => async (req, srv) => {
    if (!sameOrigin(req)) return sc.refused(req, srv, sc.bad("cross-origin request refused", 403));
    if (await sc.authorized(req, srv)) return fn(req, srv);
    return sc.refused(req, srv, sc.bad(sc.cfg.sessionPublicKey ? "unauthorized: log in with the passkey (/_auth/)" : "unauthorized: set Authorization: Bearer <~/.switchboard/token>", 401));
  };
  if (typeof h === "function") return wrap(h);
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, wrap(v)]));
};

export function setupEntrance(sc: Pick<ServerContextInit, "token" | "cfg" | "authRequired" | "allowedHosts" | "sessionCheck" | "opts" | "localHost">): void {
  // Local API token: enforced only off-loopback. Workspace MCP always needs its per-task token.
  sc.token = loadOrCreateToken(sc.cfg.tokenPath);
  sc.authRequired = !isLoopback(sc.cfg.host);
  // DNS rebinding: with no token asked, every route checks the Host names this machine (or the configured public
  // URL, which is what its clients send). Off loopback the token / cookie guards instead and the Host is not looked at.
  sc.allowedHosts = new Set(LOOPBACK_HOSTNAMES);
  if (sc.cfg.publicUrl && URL.canParse(sc.cfg.publicUrl)) sc.allowedHosts.add(new URL(sc.cfg.publicUrl).hostname);
  else if (sc.cfg.publicUrl) console.warn(`SWITCHBOARD_PUBLIC_URL is not a URL (${sc.cfg.publicUrl}); only loopback names are allowed as Host`);
  // The token, or on the cloud host the login cookie from the starter Lambda whose passkey the Starter still
  // knows; /mcp keeps its per-task tokens. `session` is the cookie that let it in, for a WebSocket's recheck.
  sc.sessionCheck = makeSessionCheck({ publicKey: sc.cfg.sessionPublicKey, starterUrl: sc.cfg.starterUrl, edge: sc.cfg.edgeHeaderValue, keepMs: sc.opts.sessionRecheckMs });
  // The runners are on this machine: the kit's `device-auth` reaches the daemon here, with the token file's contents.
  sc.localHost = sc.cfg.host === "0.0.0.0" || sc.cfg.host === "::" ? "127.0.0.1" : sc.cfg.host.includes(":") ? `[${sc.cfg.host}]` : sc.cfg.host;
}

export function setupSockets(sc: Pick<ServerContextInit, "wsCount" | "cookieSockets" | "recheckTimer" | "sessionCheck" | "opts">): void {
  // Stopping an idle cloud host: only where the environment set a stop command. Core decides when; the command
  // (sb-stop on the host) registers the wake-up and shuts the machine down.
  sc.wsCount = 0;
  // Sockets let in by a login cookie: asked about afresh every SESSION_RECHECK_MS (not from the kept answers, so one
  // period is the most a removed passkey's socket stays), closed once the passkey is gone.
  sc.cookieSockets = new Set<ServerWebSocket<WsData>>();
  sc.recheckTimer = setInterval(() => {
    for (const ws of sc.cookieSockets) {
      const session = ws.data?.session;
      if (!session) continue;
      void sc.sessionCheck(new Request("http://127.0.0.1/", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }), true).then((ok) => {
        if (ok === undefined && sc.cookieSockets.has(ws)) ws.close(4401, "session revoked");
      });
    }
  }, sc.opts.sessionRecheckMs ?? SESSION_RECHECK_MS);
}

export function setupRequestLog(sc: Pick<ServerContextInit, "UPSTREAM_FAILED" | "WEBHOOK_MAX_BYTES" | "failures" | "apiRequests" | "apiRequestsFailed" | "apiRequestsTimer" | "flushApiRequests">): void {
  /**
   * What the daemon answers when something it depends on (gh / GitHub, sb-rescue) failed. Never 502/504: on the cloud
   * host CloudFront replaces an origin's 502/504 with the "stopped" start page, and the app then leaves for the login page.
   */
  sc.UPSTREAM_FAILED = 424;
  /** The largest Webhook delivery read: GitHub's Issue payloads are a few KiB; a larger body is refused unread. */
  sc.WEBHOOK_MAX_BYTES = 64 * 1024;

  // Failed entrances and logins per address, the Starter's rule: 10 in 10 minutes, then 429 for everything.
  // Not counted: this machine's own peers (the runners' /mcp, sb-rescue's probe), and on the cloud host a request
  // without CloudFront's viewer address (until it is delivered everyone looks like one address and would lock out
  // the person). Only refusals made by the entrance and the guards go through `refused`, never a handler's 403.
  sc.failures = makeFailureLimit();
  // Every guardAll route's time and size go to api_requests, written every 10 s; `route` = the route's key, so
  // the fallback `fetch` (route null: static files, unknown paths) is not recorded. The access log stays the cloud host's.
  sc.apiRequests = [];
  sc.apiRequestsFailed = false;
  sc.apiRequestsTimer = setInterval(sc.flushApiRequests, API_REQUESTS_FLUSH_MS);
  sc.apiRequestsTimer.unref();
}
