import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

/**
 * Local API token (issue #31). Generated once at ~/.switchboard/token (0600). Required on /api and /ws when the daemon
 * listens on anything but loopback; `/api/health` always reports `authRequired` so the UI knows to ask for it.
 * Workspace MCP endpoints use a separate, per-task, disposable token (see mcp.ts).
 */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  }
  const token = `sb_${crypto.randomUUID().replace(/-/g, "")}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return token;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Host names (as `URL.hostname` spells them) that mean this machine. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * DNS rebinding defence (#1135): on loopback no token is asked, and a page on a name that now resolves to 127.0.0.1
 * sends that name as both Origin and Host, so `sameOrigin` passes. The Host's name must be one of `allowed` (the
 * loopback names, plus SWITCHBOARD_PUBLIC_URL's). The port is not compared; the Origin is not looked at (a same-origin
 * GET has none). No Host header = the request URL's host. Unparsable = refused.
 */
export function hostAllowed(req: Request, allowed: ReadonlySet<string>): boolean {
  try {
    return allowed.has(new URL("http://" + (req.headers.get("host") ?? new URL(req.url).host)).hostname);
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from `Authorization: Bearer …`, or — only where a client cannot set headers (WebSocket
 * upgrade, some MCP clients) — from `?token=…`. Plain API routes never accept the query form, so the token does not
 * end up in browser history, Referer headers or access logs.
 */
export function tokenFromRequest(req: Request, allowQuery = false): string | null {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return allowQuery ? new URL(req.url).searchParams.get("token") : null;
}

/**
 * Browser cross-site defence: a request that carries an Origin must come from the daemon's own origin (the web UI,
 * or the Vite dev server proxying to it). Non-browser clients send no Origin and are unaffected.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

/** Length-guarded constant-time comparison. */
export function tokenEquals(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The header CloudFront adds on its way to the origin (#181); the value lives in Parameter Store, never in the repository. */
export const EDGE_HEADER = "x-switchboard-edge";

/**
 * Only requests that came through the CDN reach a cloud host (#181, same idea as capsule-host's aws-handler): with
 * `value` set, a request must carry EDGE_HEADER equal to it. Unset (a Mac) = everything passes. Requests from this
 * machine itself pass too, judged by the peer address, not the listen host: the host listens on 0.0.0.0, and the
 * runners' /mcp calls and sb-rescue's health probe come from 127.0.0.1.
 */
export function edgeOk(req: Request, value: string | undefined, remoteAddress: string | undefined): boolean {
  if (!value) return true;
  if (remoteAddress && isLoopbackAddress(remoteAddress)) return true;
  const got = req.headers.get(EDGE_HEADER);
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The failure limit's key: IPv4 as is, IPv6 by its /64. The expression of aws/auth.ts `addressKey` (that package is
 *  bundled alone into the Lambda and imports nothing from core, so it is copied, not shared), plus the unmapping of
 *  `::ffff:a.b.c.d`: a dual-stack socket reports an IPv4 peer that way, and as IPv6 all of them would share one /64. */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${full.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** Refusals at the entrance or the login per address before it waits (#1492); the same numbers as the Starter's. */
export const MAX_FAILURES = 10;
export const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 1000;

/** Counts refusals per key; `limited` is true once `MAX_FAILURES` fall inside the window (the window slides). */
export function makeFailureLimit(o: { now?: () => number } = {}): { limited(key: string): boolean; failed(key: string): void } {
  const now = o.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const recent = (key: string) => (failures.get(key) ?? []).filter((t) => t > now() - FAILURE_WINDOW_MS);
  return {
    limited: (key) => recent(key).length >= MAX_FAILURES,
    failed(key) {
      const times = [...recent(key), now()];
      failures.delete(key);
      failures.set(key, times); // re-inserted: the map's order is the least recently failed first
      if (failures.size > MAX_TRACKED) {
        for (const [k, ts] of failures) if (!ts.some((t) => t > now() - FAILURE_WINDOW_MS)) failures.delete(k);
        while (failures.size > MAX_TRACKED) failures.delete(failures.keys().next().value!);
      }
    },
  };
}

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** The session cookie the cloud host's login (the starter Lambda, #211) issues after a passkey check. */
export const SESSION_COOKIE = "sb_session";
/** The login's limits (#498): 7 days from the sign-in, 24 hours from the last action. The same values as aws/auth.ts and
 *  rescue/src/server.ts (aws/session-contract.test.ts pins them). */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
export const SESSION_IDLE_MS = 24 * 3600_000;

/**
 * A valid `sb_session` cookie (#211, #701): `<body>.<sig>` where `body` = base64url of the UTF-8 text
 * `<passkeyId>.<idleUntilMs>.<expiresMs>` and `sig` = base64url of the Ed25519 signature over the base64url **text** of `body`, made by
 * the Starter with a seed only it can read (aws/auth.ts `sessionValue`). Checked here with the public key
 * (SWITCHBOARD_SESSION_PUBLIC_KEY, the raw 32 bytes in base64url), so nothing on this machine can make one. Neither time has passed (idle-until, the cap), and idle-until is not past the cap.
 * Every `sb_session=` pair is tried (a stale one for a narrower path can come first). No key (a Mac) = never valid.
 */
export function sessionOk(req: Request, publicKey: string | undefined, now = Date.now()): boolean {
  return sessionValues(req).some((v) => sessionValueOk(v, publicKey, now));
}

/** Every `sb_session=` value in the request's cookies. */
function sessionValues(req: Request): string[] {
  const pairs = (req.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${SESSION_COOKIE}=`));
  return pairs.map((pair) => pair.slice(SESSION_COOKIE.length + 1));
}

/** How long a Starter answer about a cookie is trusted (#708): a removed passkey is shut out within this. */
export const SESSION_RECHECK_MS = 5 * 60_000;

/**
 * The cookie check with revocation (#708): a cookie that verifies is then asked about at the Starter's
 * `GET /_auth/status` (`loggedIn` is true only while its passkey is still registered), and the answer is kept per cookie
 * for SESSION_RECHECK_MS. No answer (down, 5 s, not 200) refuses and is not kept. Without the Starter's URL or the
 * public key (a Mac) no cookie is valid. Returns the cookie value that passed, so a WebSocket can be checked again;
 * `fresh` asks the Starter whatever is kept (an open socket's recheck, so it ends within one period).
 */
export function makeSessionCheck(o: { publicKey?: string; starterUrl?: string; edge?: string; fetch?: typeof fetch; now?: () => number; keepMs?: number }): (req: Request, fresh?: boolean) => Promise<string | undefined> {
  const now = o.now ?? Date.now;
  const keep = o.keepMs ?? SESSION_RECHECK_MS;
  const get = o.fetch ?? fetch;
  const answers = new Map<string, { ok: boolean; at: number }>();
  const asking = new Map<string, Promise<boolean>>();
  const ask = (value: string): Promise<boolean> => {
    const pending = asking.get(value);
    if (pending) return pending;
    const p = (async () => {
      try {
        const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${value}` };
        if (o.edge) headers[EDGE_HEADER] = o.edge;
        const r = await get(`${o.starterUrl!.replace(/\/+$/, "")}/_auth/status`, { headers, signal: AbortSignal.timeout(5000) });
        if (!r.ok) return false;
        const ok = ((await r.json()) as { loggedIn?: unknown }).loggedIn === true;
        const t = now();
        for (const [k, v] of answers) if (t - v.at >= keep) answers.delete(k);
        answers.set(value, { ok, at: t });
        return ok;
      } catch {
        return false;
      } finally {
        asking.delete(value);
      }
    })();
    asking.set(value, p);
    return p;
  };
  return async (req, fresh = false) => {
    if (!o.publicKey || !o.starterUrl) return undefined;
    const t = now();
    for (const v of sessionValues(req)) {
      if (!sessionValueOk(v, o.publicKey, t)) continue;
      const hit = answers.get(v);
      if (!fresh && hit && t - hit.at < keep ? hit.ok : await ask(v)) return v;
    }
    return undefined;
  };
}

/** One cookie value: signed by the public key's seed and not expired. */
function sessionValueOk(raw: string, publicKey: string | undefined, now: number): boolean {
  return signedPasskeyId(raw, publicKey, "", now) !== undefined;
}

/**
 * The passkey id of one cookie value signed over `prefix + body` by the public key's seed and not expired, else undefined.
 * `prefix` is "" for `sb_session` (body `<id>.<idleUntil>.<expires>`) and "recent:" for `sb_recent` (`<id>.<expires>`), so one
 * value never passes as the other. Every time must be after `now`, and idle-until may not pass the cap.
 */
function signedPasskeyId(raw: string, publicKey: string | undefined, prefix: string, now: number): string | undefined {
  if (!publicKey || !raw || raw.length > 512) return undefined;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = raw.slice(0, dot);
  const sigText = raw.slice(dot + 1);
  const sig = Buffer.from(sigText, "base64url");
  // One spelling per signature: decoding skips characters outside the alphabet, so only the canonical text passes (the
  // revocation check, #708, keeps its answers by the cookie's value).
  if (sig.length !== 64 || sig.toString("base64url") !== sigText) return undefined;
  try {
    if (!verify(null, Buffer.from(prefix + body), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), sig)) return undefined;
  } catch {
    return undefined;
  }
  const [id, ...at] = Buffer.from(body, "base64url").toString("utf8").split(".");
  const ms = at.map(Number);
  if (!id || ms.length !== (prefix === "" ? 2 : 1) || !ms.every((t) => Number.isFinite(t) && t > now)) return undefined;
  return ms.every((t, i) => i === 0 || t >= ms[i - 1]!) ? id : undefined;
}

/** The Starter's "checked by passkey just now" cookie (5 minutes, #497); the daemon's strongest operations ask for it (#1491). */
export const RECENT_COOKIE = "sb_recent";

/**
 * True when some valid `sb_recent=` pair names the same passkey as `session` (the `sb_session` value `authorize` accepted).
 * The signature is over "recent:" + body, so an `sb_session` value pasted into `sb_recent` does not pass.
 */
export function recentOk(req: Request, publicKey: string | undefined, session: string, now = Date.now()): boolean {
  const who = signedPasskeyId(session, publicKey, "", now);
  if (who === undefined) return false;
  const pairs = (req.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${RECENT_COOKIE}=`));
  return pairs.some((pair) => signedPasskeyId(pair.slice(RECENT_COOKIE.length + 1), publicKey, "recent:", now) === who);
}
