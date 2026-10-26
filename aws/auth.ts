/**
 * Passkey login for the cloud host (#211, #234): served by the Starter Lambda, which runs while the machine is stopped,
 * under the distribution's own origin (`/_auth/*`, a CloudFront behavior to the Function URL with the shared header).
 *   GET  /_auth/           the one page: register (with a one-time link) / log in / start / 作り直す
 *   GET  /_auth/status     { state, registered, loggedIn } (open: tells nothing but those)
 *   POST /_auth/challenge  a signed challenge (nothing stored until a ceremony uses it)
 *   POST /_auth/register   { code, challenge, clientDataJSON, authenticatorData, publicKey, algorithm } → Set-Cookie
 *                          (code = the agent's /switchboard/register-code, or a device code below)
 *   POST /_auth/device-code { challenge, id, clientDataJSON, authenticatorData, signature } with the cookie → { code, expires }:
 *                          a one-time code for 10 minutes to register another device (#414). The passkey signature is made
 *                          for this request (the cookie alone, or sb_recent, is not enough); at MAX_PASSKEYS it is 409
 *   POST /_auth/login      { challenge, id, clientDataJSON, authenticatorData, signature } → Set-Cookie
 *                          (an id not in the list: 401 reason "unknown", #1312)
 *   GET  /_auth/passkeys   { passkeys: [{ id, device, created, lastUsed, current }] } with the cookie (no public keys)
 *   POST /_auth/passkeys/delete { target, challenge, id, clientDataJSON, authenticatorData, signature } with the cookie and a
 *                          passkey signature made for this request (#414): removes one passkey, never the last one (409)
 *   POST /_auth/start | /_auth/stop | /_auth/rebuild   with the cookie + a passkey check within 5 minutes (sb_recent, #497; the
 *                          machine token paths /start /rebuild stay for CI)
 *   GET  /_auth/countries  { base, allowance, active } — the always-allowed countries and the one temporary allowance (#1639;
 *                          the cookie only; 404 when the Starter has no countries)
 *   POST /_auth/countries  { countries, from?, until } / POST /_auth/countries/clear   with the cookie + a passkey check within
 *                          5 minutes: set / drop the temporary extra countries of the geo restriction (400 for a bad allowance)
 *   POST /_auth/renew      with the cookie: the same cookie with the idle time 24 hours on (the cap does not move; #498)
 *   POST /_auth/logout     clears the cookies
 *
 * The session cookie is the contract with the daemon and sb-rescue (#235), which verify it with the public key only (#701):
 *   sb_session=<base64url("<passkeyId>.<idleUntilMs>.<expiresMs>")>.<base64url(Ed25519 signature over that first part's text)>
 * The private key is /switchboard/session-signing-key (a 32-byte seed in hex), which only this Lambda reads; the host gets
 * publicKeyOf(seed) as /switchboard/session-public-key, so nothing on the host can make a cookie. Replacing the seed logs
 * every browser out. Every login and registration also sets sb_recent (5 minutes, the same body, the signature over
 * "recent:" + body so a session value is not a recent one), which the strong operations here and on sb-rescue ask for (#497). The WebAuthn checks and the signed challenge
 * follow capsule-host (src/webauthn.ts, src/cloud-host.ts). One person uses this host: every passkey is theirs.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { DeleteParameterCommand, GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { rpIdOf, verifyAssertion, verifyRegistration, type Passkey } from "./webauthn.ts";
import { parseAllowance } from "./countries.ts";
import pageText from "./auth-page.html" with { type: "text" };

export interface Sender {
  send(command: object): Promise<unknown>;
}
export interface AuthDeps {
  ssm: Sender;
  /** Parameter Store reads with the shared cache (makeParams). */
  param: Param;
  s3: Sender;
  /** The distribution's https origin: WebAuthn's expected origin, and rp.id is its host. */
  publicOrigin: string;
  bucket: string;
  /** The machine's state, and starting / rebuilding it (the Starter's own code). */
  state(): Promise<string>;
  start(): Promise<Result>;
  /** StopInstances; `force` only for a machine that stays in stopping (#1394). */
  stop(force: boolean): Promise<Result>;
  rebuild(): Promise<Result>;
  /** Temporary extra countries (#1639); absent = the routes answer 404. */
  countries?: ReturnType<typeof import("./countries.ts").makeCountries>;
  now?: () => number;
}
export interface Request {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  cookies: string[];
  body: string;
  sourceIp: string;
}
export interface Result {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

export const SESSION_COOKIE = "sb_session";
/** The login's two limits: at most 7 days from the sign-in, and 24 hours from the last action (#498). The same values as
 *  packages/core/src/auth.ts and rescue/src/server.ts (aws/session-contract.test.ts pins them). */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
export const SESSION_IDLE_MS = 24 * 3600_000;
export const RECENT_COOKIE = "sb_recent";
export const RECENT_MS = 5 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
/** A device code (#414) lasts this long, and registers at most one passkey. */
export const DEVICE_CODE_MS = 10 * 60_000;
/** Passkeys a device code may bring the list to; the agent's register-code (the first passkey, recovery) is not capped. */
export const MAX_PASSKEYS = 5;
const PASSKEYS_KEY = "auth/passkeys.json";
// a text import is a string at run time; Bun's types call every *.html an HTMLBundle
const page = String(pageText);
const PARAMS = { sessionKey: "/switchboard/session-signing-key", registerCode: "/switchboard/register-code", edge: "/switchboard/edge-header" };
/** Failed logins or registrations per address before it waits (per warm Lambda; enough for one person's host). */
export const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;
/** Addresses remembered at most (the oldest go first): rotating addresses must not grow a warm Lambda's memory. */
const MAX_TRACKED = 1000;
/** The session key and the edge header are read again after this long (and at once after a check fails), so a rotation
 *  takes effect without recycling the Lambda. */
export const SECRET_TTL_MS = 60_000;
export const FORCED_REREAD_MS = 10_000;
/** The signing key is an Ed25519 seed: exactly 32 random bytes in hex. Anything else refuses everything (never sign with ""). */
const SEED = /^[0-9a-f]{64}$/i;

/** The rate limit's key: IPv4 as is, IPv6 by its /64 (a host rotates freely inside one). */
export function addressKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${full.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** `deviceCode` holds only the SHA-256 of the code: the object is read by the Starter alone, and not even it keeps the code. */
type Stored = { passkeys: Array<Passkey & { device: string; lastUsed?: number }>; spent: Array<{ challenge: string; expires: number }>; deviceCode?: { hash: string; expires: number } };

/** The page runs its inline script and fetches this origin only; it is never framed. */
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
};
const json = (statusCode: number, body: unknown, cookies?: string[]): Result => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body), ...(cookies ? { cookies } : {}) });
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const deviceOf = (ua: string | undefined) => (/iPhone|iPad/.test(ua ?? "") ? "iPhone / iPad" : /Android/.test(ua ?? "") ? "Android" : /Mac OS X/.test(ua ?? "") ? "Mac" : /Windows/.test(ua ?? "") ? "Windows" : "browser");

/** The private key of an Ed25519 seed (hex): PKCS#8 is a fixed 16-byte prefix and the 32 bytes. */
function signingKeyOf(seedHex: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}
/** The public key the daemon and sb-rescue verify with: the raw 32 bytes in base64url (43 characters). */
export function publicKeyOf(seedHex: string): string {
  return createPublicKey(signingKeyOf(seedHex)).export({ format: "jwk" }).x!;
}
function signed(seedHex: string, prefix: string, passkeyId: string, ...times: number[]): string {
  const body = b64([passkeyId, ...times].join("."));
  return `${body}.${b64(sign(null, Buffer.from(prefix + body), signingKeyOf(seedHex)))}`;
}
/** `times` = how many time fields the body carries: 2 for a session (idle-until, then the cap), 1 for a recent check. Every one must be in the future, and the idle time may not pass the cap. */
function signedOf(publicKey: string, prefix: string, times: 1 | 2, value: string | undefined, now: number): string | undefined {
  if (!value || value.length > 512) return; // the same limit as the daemon and sb-rescue (#498)
  const [body, sig] = value.split(".");
  const raw = Buffer.from(sig ?? "", "base64url");
  if (!body || raw.length !== 64) return;
  try {
    if (!verify(null, Buffer.from(prefix + body), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), raw)) return;
  } catch {
    return;
  }
  const [id, ...at] = Buffer.from(body, "base64url").toString().split(".");
  const ms = at.map(Number);
  if (!id || ms.length !== times || !ms.every((t) => Number.isFinite(t) && t > now)) return;
  return ms.every((t, i) => i === 0 || t >= ms[i - 1]!) ? id : undefined;
}

/**
 * Signs `<passkeyId>.<idleUntilMs>.<expiresMs>` into the cookie value (exported for tests and the contract): Ed25519 with the seed,
 * over the base64url body text (not its bytes) — exactly what the daemon and sb-rescue verify with the public key (#701).
 */
export function sessionValue(seedHex: string, passkeyId: string, idleUntil: number, expires: number): string {
  return signed(seedHex, "", passkeyId, idleUntil, expires);
}
/** The passkey id of a valid, unexpired cookie value under the public key, else undefined. */
export function sessionOf(publicKey: string, value: string | undefined, now: number): string | undefined {
  return signedOf(publicKey, "", 2, value, now);
}

/** Signs a passkey check made just now: the session's body, the signature over "recent:" + body (#497). */
export function recentValue(seedHex: string, passkeyId: string, expires: number): string {
  return signed(seedHex, "recent:", passkeyId, expires);
}
/** The passkey id of a valid, unexpired recent-check value, else undefined. */
export function recentOf(publicKey: string, value: string | undefined, now: number): string | undefined {
  return signedOf(publicKey, "recent:", 1, value, now);
}

export type Param = (name: string, fresh?: boolean) => Promise<string>;
/** SecureString reads shared by the Starter's edge check, its start token and the passkey login. */
export function makeParams(ssm: Sender, now: () => number): Param {
  const cache = new Map<string, { value: string; at: number }>();
  return async (name, fresh = false) => {
    const hit = cache.get(name);
    // A forced re-read (a check failed: maybe the value was rotated) happens at most every FORCED_REREAD_MS, so a caller
    // sending garbage cannot turn every request into a SecureString read (KMS charges, SSM's shared GetParameter quota).
    if (hit && now() - hit.at < (fresh ? FORCED_REREAD_MS : SECRET_TTL_MS)) return hit.value;
    try {
      const r = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))) as { Parameter?: { Value?: string } };
      const v = r.Parameter?.Value ?? "";
      if (name !== PARAMS.registerCode) cache.set(name, { value: v, at: now() }); // the code is consumed: always read fresh
      return v;
    } catch (e) {
      if ((e as { name?: string }).name === "ParameterNotFound") return "";
      throw e;
    }
  };
}

export function makeAuth(d: AuthDeps) {
  const now = d.now ?? Date.now;
  const origin = d.publicOrigin.replace(/\/+$/, "");
  const rpId = rpIdOf(origin);
  const secure = origin.startsWith("https:") ? "Secure; " : "";
  const failures = new Map<string, number[]>();

  const param = d.param;
  class NoKey extends Error {}
  /** The signing seed, or NoKey (→ 503): with no key nothing may be signed or accepted. */
  const sessionKey = async (fresh = false): Promise<string> => {
    const k = await param(PARAMS.sessionKey, fresh);
    if (!SEED.test(k)) throw new NoKey();
    return k;
  };
  const publicKey = async (fresh = false) => publicKeyOf(await sessionKey(fresh));
  type Loaded = Stored & { etag?: string };
  const load = async (): Promise<Loaded> => {
    try {
      const r = (await d.s3.send(new GetObjectCommand({ Bucket: d.bucket, Key: PASSKEYS_KEY }))) as { ETag?: string; Body?: { transformToString(): Promise<string> } };
      const s = JSON.parse((await r.Body?.transformToString()) ?? "{}") as Partial<Stored>;
      return { passkeys: s.passkeys ?? [], spent: s.spent ?? [], ...(s.deviceCode ? { deviceCode: s.deviceCode } : {}), etag: r.ETag };
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return { passkeys: [], spent: [] };
      throw e;
    }
  };
  /** Writes only over the version that was read (If-Match; If-None-Match for the first write): a login and a
   *  registration at the same moment cannot overwrite each other. On 412, `change` runs again on a fresh read, once. */
  const update = async (s: Loaded, change: (s: Stored) => void): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      change(s);
      try {
        const { etag, ...body } = s;
        await d.s3.send(new PutObjectCommand({ Bucket: d.bucket, Key: PASSKEYS_KEY, Body: JSON.stringify(body), ContentType: "application/json", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }) }));
        return;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
        // 412: the ETag moved; 409 ConditionalRequestConflict: another conditional PUT raced this one
        const name = (e as { name?: string }).name;
        if (attempt > 0 || (status !== 412 && status !== 409 && name !== "PreconditionFailed" && name !== "ConditionalRequestConflict")) throw e;
        s = await load();
      }
    }
  };

  // Signed rather than stored (capsule-host): nothing is written until a ceremony uses it; a used one is kept until it
  // expires so it cannot be replayed.
  const challenge = async () => {
    const head = Buffer.alloc(24);
    randomBytes(16).copy(head);
    head.writeDoubleBE(now() + CHALLENGE_MS, 16);
    return b64(Buffer.concat([head, createHmac("sha256", await sessionKey()).update(Buffer.concat([Buffer.from("challenge:"), head])).digest()]));
  };
  const challengeOk = async (s: Stored, c: string): Promise<boolean> => {
    const raw = Buffer.from(c, "base64url");
    if (raw.length !== 56) return false;
    const head = raw.subarray(0, 24), mac = raw.subarray(24);
    const want = createHmac("sha256", await sessionKey()).update(Buffer.concat([Buffer.from("challenge:"), head])).digest();
    if (!timingSafeEqual(mac, want) || head.readDoubleBE(16) <= now()) return false;
    return !s.spent.some((x) => x.challenge === c);
  };
  const spend = (s: Stored, c: string) => {
    s.spent = s.spent.filter((x) => x.expires > now());
    s.spent.push({ challenge: c, expires: now() + CHALLENGE_MS });
  };
  /** A login cookie: the cap is 7 days from now, or `expires` (a renewal keeps the cap it had); the idle time is 24 hours from now, never past the cap. */
  const cookie = async (passkeyId: string, expires = now() + SESSION_MAX_MS) => {
    const idleUntil = Math.min(now() + SESSION_IDLE_MS, expires);
    return `${SESSION_COOKIE}=${sessionValue(await sessionKey(), passkeyId, idleUntil, expires)}; HttpOnly; ${secure}SameSite=Lax; Path=/; Max-Age=${Math.floor((expires - now()) / 1000)}`;
  };
  const recentCookie = async (passkeyId: string) =>
    `${RECENT_COOKIE}=${recentValue(await sessionKey(), passkeyId, now() + RECENT_MS)}; HttpOnly; ${secure}SameSite=Lax; Path=/; Max-Age=${RECENT_MS / 1000}`;
  const cookieValue = (req: Request, name: string) => req.cookies.map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  /** The (already verified) session cookie's two times: when the idle time and the cap end (#498). */
  const timesOf = (req: Request) => {
    const [, idleUntil, expiresAt] = Buffer.from(cookieValue(req, SESSION_COOKIE)!.split(".")[0]!, "base64url").toString().split(".");
    return { idleUntil: Number(idleUntil), expiresAt: Number(expiresAt) };
  };
  /** The request's own (valid) session cookie with the idle time moved on; the cap stays. */
  const renewed = async (req: Request, id: string) => cookie(id, timesOf(req).expiresAt);
  /** The passkey id of a valid session cookie, else undefined. */
  const sessionId = async (req: Request, s?: Stored): Promise<string | undefined> => {
    const value = cookieValue(req, SESSION_COOKIE);
    if (!value) return;
    // a cookie that does not verify may be signed with a key rotated a moment ago: read the key again once
    const id = sessionOf(await publicKey(), value, now()) ?? sessionOf(await publicKey(true), value, now());
    if (!id) return;
    return (s ?? (await load())).passkeys.some((p) => p.id === id) ? id : undefined; // a removed passkey ends its sessions here
  };
  /** A passkey check within RECENT_MS by the session's own passkey (#497). */
  const checkedRecently = async (req: Request, id: string): Promise<boolean> => {
    const value = cookieValue(req, RECENT_COOKIE);
    if (!value) return false;
    return (recentOf(await publicKey(), value, now()) ?? recentOf(await publicKey(true), value, now())) === id;
  };
  const recent = (ip: string) => (failures.get(addressKey(ip)) ?? []).filter((t) => t > now() - FAILURE_WINDOW_MS);
  const limited = (ip: string) => recent(ip).length >= MAX_FAILURES;
  /** One JSON line per failure, to the function's log (CloudWatch Logs, #1490). The address is the limiter's key; nothing the caller sent is in it. */
  const logFailure = (ip: string, path: string, status: number, message: string) =>
    console.log(JSON.stringify({ log: "auth", t: new Date(now()).toISOString(), ip: addressKey(ip), path, status, reason: message }));
  const failed = (ip: string, path: string, status: number, message: string, reason?: string) => {
    logFailure(ip, path, status, message);
    const k = addressKey(ip), times = [...recent(ip), now()];
    failures.delete(k);
    failures.set(k, times); // re-inserted: the map's order is the least recently failed first
    if (failures.size > MAX_TRACKED) {
      for (const [key, ts] of failures) if (!ts.some((t) => t > now() - FAILURE_WINDOW_MS)) failures.delete(key);
      while (failures.size > MAX_TRACKED) failures.delete(failures.keys().next().value!);
    }
    return json(status, reason ? { error: message, reason } : { error: message });
  };
  const body = (req: Request): Record<string, unknown> => {
    try {
      const v = JSON.parse(req.body || "{}") as unknown;
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const str = (v: unknown) => (typeof v === "string" && v.length <= 4096 ? v : "");
  /**
   * A passkey signature over challenge `c` (already checked by challengeOk): the passkey's counter is saved and the
   * challenge spent, with `also` in the same write. The passkey's id, or the refusal to answer with.
   */
  const assertPasskey = async (req: Request, path: string, s: Loaded, v: Record<string, unknown>, c: string, also?: (x: Stored) => void): Promise<string | Result> => {
    const passkey = s.passkeys.find((p) => p.id === str(v.id));
    let counter: number | undefined;
    if (passkey) {
      try {
        counter = verifyAssertion({ clientDataJSON: str(v.clientDataJSON), authenticatorData: str(v.authenticatorData), signature: str(v.signature) }, { challenge: c, origin, rpId }, passkey);
      } catch {
        /* refused below, the same way as an unknown passkey */
      }
    }
    // an id that is not in the list (removed, #1312) is told apart so the page can tell the device; a signature that fails is not
    if (!passkey) return failed(req.sourceIp, path, 401, "このパスキーは Switchboard から外されています", "unknown");
    if (counter === undefined) return failed(req.sourceIp, path, 401, "パスキーを確かめられませんでした");
    let replayed = false, removed = false;
    await update(s, (x) => {
      // a retry after a concurrent write sees that write: the same challenge used by the other one is a replay, and a
      // passkey removed meanwhile signs nothing (its `also` does not run)
      replayed = x.spent.some((y) => y.challenge === c);
      const p = x.passkeys.find((y) => y.id === passkey.id);
      removed = !p;
      if (replayed || !p) return;
      p.counter = counter!;
      p.lastUsed = now(); // the list's 最後に使った: a login, a device code or a delete
      spend(x, c);
      also?.(x);
    });
    if (replayed) return failed(req.sourceIp, path, 400, "やり直してください（画面を読み込み直してください）");
    if (removed) return failed(req.sourceIp, path, 401, "このパスキーは Switchboard から外されています", "unknown");
    return passkey.id;
  };

  const handle = async (req: Request): Promise<Result> => {
    const path = req.path.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/_auth") return { statusCode: 200, headers: PAGE_HEADERS, body: page };
    // open, so kept cheap: no S3 read unless the browser shows a cookie; registered is asked with the cookie-less page
    if (req.method === "GET" && path === "/_auth/status") {
      const hasCookie = req.cookies.some((c) => c.trim().startsWith(`${SESSION_COOKIE}=`));
      const s = hasCookie || req.headers["x-switchboard-ask"] === "registered" ? await load() : undefined;
      const loggedIn = hasCookie ? !!(await sessionId(req, s)) : false;
      return json(200, { state: await d.state(), registered: s ? s.passkeys.length > 0 : null, loggedIn, ...(loggedIn ? { session: timesOf(req) } : {}), rpId });
    }
    if (req.method === "GET" && path === "/_auth/countries") {
      if (!(await sessionId(req))) return json(401, { error: "パスキーでログインしてください" });
      return d.countries ? json(200, await d.countries.view()) : json(404, { error: "国の設定はこの環境にはありません" });
    }
    if (req.method === "GET" && path === "/_auth/passkeys") {
      const s = await load();
      const id = await sessionId(req, s);
      if (!id) return json(401, { error: "パスキーでログインしてください" });
      return json(200, { passkeys: s.passkeys.map((p) => ({ id: p.id, device: p.device, created: p.created, lastUsed: p.lastUsed ?? null, current: p.id === id })) });
    }
    if (req.method !== "POST") return json(404, { error: "not found" });
    if (path === "/_auth/challenge") return json(200, { challenge: await challenge(), rpId });
    if (path === "/_auth/renew") {
      // The screens call this after an action (#498): the idle time moves 24 hours on, the cap and the passkey stay. Only this
      // Lambda holds the seed, so only here can a cookie be signed again (#701).
      const id = await sessionId(req);
      if (!id) return json(401, { error: "パスキーでログインしてください" });
      return json(200, { ok: true }, [await renewed(req, id)]);
    }
    if (path === "/_auth/logout") return json(200, { ok: true }, [SESSION_COOKIE, RECENT_COOKIE].map((n) => `${n}=; HttpOnly; ${secure}SameSite=Lax; Path=/; Max-Age=0`));

    if (path === "/_auth/register" || path === "/_auth/login" || path === "/_auth/device-code" || path === "/_auth/passkeys/delete") {
      if (limited(req.sourceIp)) {
        const message = "失敗が続いたので、しばらく待ってからもう一度試してください";
        logFailure(req.sourceIp, path, 429, message);
        return json(429, { error: message });
      }
      const v = body(req);
      const s = await load();
      // only a logged-in browser asks for a device code; the passkey signature below is what lets it
      if ((path === "/_auth/device-code" || path === "/_auth/passkeys/delete") && !(await sessionId(req, s))) return json(401, { error: "パスキーでログインしてください" });
      const c = str(v.challenge);
      if (!c || !(await challengeOk(s, c))) return failed(req.sourceIp, path, 400, "やり直してください（画面を読み込み直してください）");
      const expected = { challenge: c, origin, rpId };
      if (path === "/_auth/device-code") {
        const code = b64(randomBytes(24)), expires = now() + DEVICE_CODE_MS;
        let full = false;
        const id = await assertPasskey(req, path, s, v, c, (x) => {
          full = x.passkeys.length >= MAX_PASSKEYS;
          if (full) return;
          x.deviceCode = { hash: sha256(code), expires }; // a new code replaces the last one
        });
        if (typeof id !== "string") return id;
        if (full) return json(409, { error: `パスキーは ${MAX_PASSKEYS} 本までです。使っていないものを消してから追加してください`, reason: "full" });
        return json(200, { code, expires });
      }
      if (path === "/_auth/passkeys/delete") {
        const target = str(v.target);
        let refused: "missing" | "last" | undefined;
        const id = await assertPasskey(req, path, s, v, c, (x) => {
          // decided on the read the write goes over: of two deletes at once, the second re-reads (412) and sees one left
          refused = !x.passkeys.some((p) => p.id === target) ? "missing" : x.passkeys.length <= 1 ? "last" : undefined;
          if (!refused) x.passkeys = x.passkeys.filter((p) => p.id !== target);
        });
        if (typeof id !== "string") return id;
        if (refused === "missing") return json(404, { error: "そのパスキーは登録されていません" });
        if (refused === "last") return json(409, { error: "最後の 1 本は消せません", reason: "last" });
        return json(200, { ok: true });
      }
      if (path === "/_auth/register") {
        // one-time, expiring code the agent put in Parameter Store and sent as a link (the first passkey, recovery), or the
        // device code a logged-in browser asked for (#414); consumed only by a passkey that verifies
        const given = str(v.code);
        const [code, expires] = (await param(PARAMS.registerCode)).split(".");
        const admin = !!code && Number(expires) > now() && same(given, code);
        const hash = sha256(given);
        const device = !admin && !!given && !!s.deviceCode && s.deviceCode.expires > now() && same(hash, s.deviceCode.hash);
        if (!admin && !device) return failed(req.sourceIp, path, 403, "登録リンクが無効か期限切れです。新しいリンクをもらってください");
        let passkey: Passkey;
        try {
          passkey = verifyRegistration({ clientDataJSON: str(v.clientDataJSON), authenticatorData: str(v.authenticatorData), publicKey: str(v.publicKey), algorithm: Number(v.algorithm) }, expected, now());
        } catch {
          return failed(req.sourceIp, path, 400, "パスキーを登録できませんでした");
        }
        if (s.passkeys.some((p) => p.id === passkey.id)) return failed(req.sourceIp, path, 400, "このパスキーは登録済みです");
        const full = `パスキーは ${MAX_PASSKEYS} 本までです。使っていないものを消してから追加してください`;
        if (device) {
          if (s.passkeys.length >= MAX_PASSKEYS) return failed(req.sourceIp, path, 409, full);
          // the code is consumed in the write that saves the passkey: a second submission re-reads (412) and finds it gone
          let refused: "used" | "full" | undefined;
          await update(s, (x) => {
            refused = x.deviceCode?.hash !== hash || !(x.deviceCode.expires > now()) ? "used" : x.passkeys.length >= MAX_PASSKEYS ? "full" : undefined;
            if (refused) return;
            delete x.deviceCode;
            if (!x.passkeys.some((p) => p.id === passkey.id)) x.passkeys.push({ ...passkey, device: deviceOf(req.headers["user-agent"]) });
            spend(x, c);
          });
          if (refused === "used") return failed(req.sourceIp, path, 403, "登録リンクは使用済みです。新しいリンクをもらってください");
          if (refused === "full") return failed(req.sourceIp, path, 409, full);
          return json(201, { ok: true }, [await cookie(passkey.id), await recentCookie(passkey.id)]);
        }
        // the code is consumed before anything is saved: of two submissions of one link only the one that deletes it wins
        try {
          await d.ssm.send(new DeleteParameterCommand({ Name: PARAMS.registerCode }));
        } catch (e) {
          if ((e as { name?: string }).name === "ParameterNotFound") return failed(req.sourceIp, path, 403, "登録リンクは使用済みです。新しいリンクをもらってください");
          throw e;
        }
        await update(s, (x) => {
          if (!x.passkeys.some((p) => p.id === passkey.id)) x.passkeys.push({ ...passkey, device: deviceOf(req.headers["user-agent"]) });
          spend(x, c);
        });
        return json(201, { ok: true }, [await cookie(passkey.id), await recentCookie(passkey.id)]);
      }
      const id = await assertPasskey(req, path, s, v, c);
      if (typeof id !== "string") return id;
      return json(200, { ok: true }, [await cookie(id), await recentCookie(id)]);
    }

    if (path === "/_auth/start" || path === "/_auth/stop" || path === "/_auth/rebuild") {
      const id = await sessionId(req);
      if (!id) return json(401, { error: "パスキーでログインしてください" });
      if (!(await checkedRecently(req, id))) return json(401, { error: "操作の前にパスキーで確かめてください", reason: "recent" });
      const r = await (path === "/_auth/stop" ? d.stop(body(req).force === true) : path === "/_auth/start" ? d.start() : d.rebuild());
      // an action that went through counts as use (#498): the cookie comes back with the idle time moved on
      return r.statusCode < 300 ? { ...r, cookies: [...(r.cookies ?? []), await renewed(req, id)] } : r;
    }
    if (path === "/_auth/countries" || path === "/_auth/countries/clear") {
      const id = await sessionId(req);
      if (!id) return json(401, { error: "パスキーでログインしてください" });
      if (!d.countries) return json(404, { error: "国の設定はこの環境にはありません" });
      if (!(await checkedRecently(req, id))) return json(401, { error: "操作の前にパスキーで確かめてください", reason: "recent" });
      if (path === "/_auth/countries/clear") await d.countries.clear();
      else {
        const a = parseAllowance(body(req), now());
        if ("error" in a) return json(400, { error: a.error });
        await d.countries.set(a);
      }
      return json(200, await d.countries.view());
    }
    return json(404, { error: "not found" });
  };
  return async (req: Request): Promise<Result> => {
    try {
      return await handle(req);
    } catch (e) {
      if (e instanceof NoKey) return json(503, { error: "ログインの鍵（/switchboard/session-signing-key）が未設定です。管理者に連絡してください" });
      throw e;
    }
  };
}
