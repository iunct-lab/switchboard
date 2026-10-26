import { GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";
import { describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DeleteParameterCommand, GetParameterCommand } from "@aws-sdk/client-ssm";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { addressKey, DEVICE_CODE_MS, MAX_FAILURES, MAX_PASSKEYS, publicKeyOf, RECENT_COOKIE, RECENT_MS, recentOf, recentValue, SESSION_COOKIE, SESSION_IDLE_MS, SESSION_MAX_MS, sessionOf, sessionValue } from "./auth.ts";
import { makeHandler, type Sender, type UrlEvent } from "./starter.ts";

const ORIGIN = "https://d111.cloudfront.net";
const EDGE = "edge-secret-value";
/** The Ed25519 seed the Starter signs with (/switchboard/session-signing-key), and the public key the host gets. */
const KEY = "a".repeat(64);
const PUB = publicKeyOf(KEY);
const OTHER = "b".repeat(64);

/** A platform authenticator in software (as capsule-host's test-fixture.ts): the two byte strings a browser sends. */
function authenticator(origin = ORIGIN) {
  const rpId = new URL(origin).hostname, b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(20);
  const authData = (flags: number, attested: boolean) => {
    const head = Buffer.alloc(37);
    createHash("sha256").update(rpId).digest().copy(head);
    head[32] = flags;
    head.writeUInt32BE(0, 33); // an iPhone passkey never counts
    if (!attested) return head;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, credentialId, Buffer.from([0xa5, 0x01, 0x02])]);
  };
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64(credentialId),
    register: (challenge: string) => ({ clientDataJSON: b64(clientData("webauthn.create", challenge)), authenticatorData: b64(authData(0x45, true)), publicKey: b64(pair.publicKey.export({ format: "der", type: "spki" })), algorithm: -7 }),
    assert: (challenge: string) => {
      const data = authData(0x05, false), client = clientData("webauthn.get", challenge);
      return { id: b64(credentialId), clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(sign("sha256", Buffer.concat([data, createHash("sha256").update(client).digest()]), pair.privateKey)) };
    },
  };
}

function setup(o: { state?: string; code?: string; sessionKey?: string | null; conflictOnce?: boolean; startError?: string; base?: string[] } = {}) {
  let now = 1_800_000_000_000;
  const params = new Map<string, string>([["/switchboard/edge-header", EDGE], ["/switchboard/start-token", "tok"]]);
  if (o.sessionKey !== null) params.set("/switchboard/session-signing-key", o.sessionKey ?? KEY);
  let etag = 0;
  let conflict = o.conflictOnce ?? false;
  /** Another write that won the race (`conflictNext`'s argument): what the losing write finds on its re-read. */
  let rival: ((objects: Map<string, string>) => void) | undefined;
  if (o.code !== undefined) params.set("/switchboard/register-code", o.code);
  const objects = new Map<string, string>();
  const sent: object[] = [];
  const client = (answer: (c: object) => unknown): Sender => ({ send: async (c) => (sent.push(c), answer(c)) });
  const notFound = (name: string) => Object.assign(new Error(name), { name });
  // the geo restriction (#1639): a whitelist the fake CloudFront reads and writes
  let whitelist = o.base ?? [];
  params.set("/switchboard/distribution-id", "EDIST");
  const cloudfront = client((c) => {
    if (c instanceof GetDistributionConfigCommand) return { ETag: "e", DistributionConfig: { Restrictions: { GeoRestriction: { RestrictionType: "whitelist", Quantity: whitelist.length, Items: whitelist } } } };
    if (c instanceof UpdateDistributionCommand) whitelist = c.input.DistributionConfig!.Restrictions!.GeoRestriction!.Items!;
    return {};
  });
  const h = makeHandler({
    countries: o.base ? { cloudfront, base: o.base } : undefined,
    ec2: client((c) => {
      if (c instanceof StartInstancesCommand && o.startError) throw Object.assign(new Error(o.startError), { name: o.startError });
      return c instanceof DescribeInstancesCommand ? { Reservations: [{ Instances: [{ State: { Name: o.state ?? "stopped" } }] }] } : {};
    }),
    ssm: client((c) => {
      if (c instanceof GetParameterCommand) {
        const v = params.get(c.input.Name!);
        if (v === undefined) throw notFound("ParameterNotFound");
        return { Parameter: { Value: v } };
      }
      if (c instanceof DeleteParameterCommand && !params.delete(c.input.Name!)) throw notFound("ParameterNotFound");
      return {};
    }),
    instanceId: "i-0abc",
    tokenParam: "/switchboard/start-token",
    auth: {
      s3: client((c) => {
        if (c instanceof GetObjectCommand) {
          const v = objects.get(c.input.Key!);
          if (v === undefined) throw notFound("NoSuchKey");
          return { ETag: `"${etag}"`, Body: { transformToString: async () => v } };
        }
        if (c instanceof PutObjectCommand) {
          const exists = objects.has(c.input.Key!);
          // like S3: If-Match must name the current version, If-None-Match "*" only creates; `conflictOnce` = another write won once
          if (conflict || (c.input.IfMatch && c.input.IfMatch !== `"${etag}"`) || (c.input.IfNoneMatch === "*" && exists)) {
            conflict = false;
            rival?.(objects);
            rival = undefined;
            etag++;
            throw Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          }
          objects.set(c.input.Key!, String(c.input.Body));
          etag++;
        }
        return {};
      }),
      bucket: "data-bucket",
      publicOrigin: ORIGIN,
    },
    now: () => now,
  });
  const call = async (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = { "x-switchboard-edge": EDGE }, viewer = "198.51.100.7:51234") => {
    const r = await h({ rawPath: path, headers: { "cloudfront-viewer-address": viewer, "x-forwarded-for": "203.0.113.200, 130.176.0.9", "user-agent": "iPhone", ...headers }, cookies: cookie ? cookie.split("; ") : [], body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method, sourceIp: "130.176.0.1" } } } satisfies UrlEvent);
    return { ...r, json: () => JSON.parse(r.body) };
  };
  /** Every Set-Cookie of a response as one Cookie header (sb_session and sb_recent). */
  const cookieOf = (r: { cookies?: string[] }) => (r.cookies ?? []).map((c) => c.split(";")[0]).join("; ");
  return { call, sent, params, objects, whitelist: () => whitelist, cookieOf, advance: (ms: number) => (now += ms), nowOf: () => now, conflictNext: (then?: (objects: Map<string, string>) => void) => ((conflict = true), (rival = then)) };
}
const challenge = async (t: ReturnType<typeof setup>) => (await t.call("POST", "/_auth/challenge", {})).json().challenge as string;

describe("aws/auth.ts — passkey login on the Starter (#211, #234)", () => {
  test("register with the one-time code → cookie → start; the code is consumed; login later with the same passkey", async () => {
    const t = setup({ code: "reg-code-1234567890.1900000000000" });
    const a = authenticator();
    const status0 = (await t.call("GET", "/_auth/status", undefined, undefined, { "x-switchboard-edge": EDGE, "x-switchboard-ask": "registered" })).json();
    expect(status0).toEqual({ state: "stopped", registered: false, loggedIn: false, rpId: "d111.cloudfront.net" });
    // a bare call (no cookie, not asking) does not read S3: it is open, so it stays cheap
    const reads = t.sent.filter((x) => x instanceof GetObjectCommand).length;
    expect((await t.call("GET", "/_auth/status")).json()).toMatchObject({ state: "stopped", registered: null, loggedIn: false });
    expect(t.sent.filter((x) => x instanceof GetObjectCommand).length).toBe(reads);

    const c = await challenge(t);
    const reg = await t.call("POST", "/_auth/register", { code: "reg-code-1234567890", challenge: c, ...a.register(c) });
    expect(reg.statusCode).toBe(201);
    expect(reg.cookies?.[0]).toMatch(/^sb_session=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/);
    expect(t.params.has("/switchboard/register-code")).toBe(false); // consumed
    expect(JSON.parse(t.objects.get("auth/passkeys.json")!).passkeys[0]).toMatchObject({ id: a.id, device: "iPhone / iPad" });

    const cookie = t.cookieOf(reg);
    const status = (await t.call("GET", "/_auth/status", undefined, cookie)).json();
    expect(status).toMatchObject({ registered: true, loggedIn: true });
    expect(status.session).toEqual({ idleUntil: t.nowOf() + SESSION_IDLE_MS, expiresAt: t.nowOf() + SESSION_MAX_MS }); // #498: the page shows it
    expect((await t.call("GET", "/_auth/status")).json().session).toBeUndefined(); // not logged in: nothing
    t.advance(60_000); // inside the 5 minutes of the passkey check
    const start = await t.call("POST", "/_auth/start", {}, cookie);
    expect(start.statusCode).toBe(202);
    // a start that went through counts as use (#498): the cookie comes back with the idle time moved on, the cap kept
    const [, idle, cap] = Buffer.from(t.cookieOf(start).slice(`${SESSION_COOKIE}=`.length).split(".")[0]!, "base64url").toString().split(".");
    expect(Number(idle)).toBe(t.nowOf() + SESSION_IDLE_MS);
    expect(Number(cap)).toBe(t.nowOf() - 60_000 + SESSION_MAX_MS);
    expect(t.sent.filter((x) => x instanceof StartInstancesCommand)).toHaveLength(1);

    // another day, another browser: log in with the passkey
    t.advance(24 * 3600_000);
    const c2 = await challenge(t);
    const login = await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) });
    expect(login.statusCode).toBe(200);
    expect((await t.call("POST", "/_auth/start", {}, t.cookieOf(login))).statusCode).toBe(202);
  });

  test("/_auth/renew moves the idle time 24 hours on and keeps the cap and the passkey; without a valid cookie it is 401 (#498)", async () => {
    const t = setup({ code: "reg-code-1234567890.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    const reg = await t.call("POST", "/_auth/register", { code: "reg-code-1234567890", challenge: c, ...a.register(c) });
    const cookie = t.cookieOf(reg).split("; ")[0]!;
    const first = t.nowOf();
    const parts = (value: string) => Buffer.from(value.slice(`${SESSION_COOKIE}=`.length).split(".")[0]!, "base64url").toString().split(".");
    expect(parts(cookie)).toEqual([a.id, `${first + SESSION_IDLE_MS}`, `${first + SESSION_MAX_MS}`]);
    t.advance(23 * 3600_000);
    const r = await t.call("POST", "/_auth/renew", {}, cookie);
    expect(r.statusCode).toBe(200);
    const renewed = (r.cookies ?? [])[0]!;
    expect(renewed).toMatch(/^sb_session=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=\d+$/);
    expect(parts(renewed.split(";")[0]!)).toEqual([a.id, `${t.nowOf() + SESSION_IDLE_MS}`, `${first + SESSION_MAX_MS}`]); // the cap did not move
    expect(Number(/Max-Age=(\d+)/.exec(renewed)![1])).toBe((first + SESSION_MAX_MS - t.nowOf()) / 1000);
    // the old cookie is dead 24 hours after its last action, the renewed one is not
    t.advance(2 * 3600_000);
    expect((await t.call("POST", "/_auth/renew", {}, cookie)).statusCode).toBe(401);
    const again = await t.call("POST", "/_auth/renew", {}, renewed.split(";")[0]!);
    expect(again.statusCode).toBe(200);
    // renewed every 23 hours the login lasts to the cap and no further: the idle time stops at the cap, then 401
    let current = t.cookieOf(again);
    while (t.nowOf() + 23 * 3600_000 < first + SESSION_MAX_MS) {
      t.advance(23 * 3600_000);
      const next = await t.call("POST", "/_auth/renew", {}, current);
      expect(next.statusCode).toBe(200);
      current = t.cookieOf(next);
      const [, idle, cap] = parts(current);
      expect(Number(idle)).toBeLessThanOrEqual(Number(cap));
      expect(cap).toBe(`${first + SESSION_MAX_MS}`);
    }
    t.advance(23 * 3600_000);
    expect((await t.call("POST", "/_auth/renew", {}, current)).statusCode).toBe(401); // past the cap
    expect((await t.call("POST", "/_auth/renew", {})).statusCode).toBe(401);
  });

  test("/_auth/renew signs nothing for a removed passkey's cookie or a recent-check value pasted as the session (#498)", async () => {
    const t = setup({ code: "reg-code-1234567890.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    await t.call("POST", "/_auth/register", { code: "reg-code-1234567890", challenge: c, ...a.register(c) });
    const later = t.nowOf() + SESSION_IDLE_MS;
    expect((await t.call("POST", "/_auth/renew", {}, `${SESSION_COOKIE}=${sessionValue(KEY, "no-such-passkey", later, later)}`)).statusCode).toBe(401); // removed passkey
    expect((await t.call("POST", "/_auth/renew", {}, `${SESSION_COOKIE}=${recentValue(KEY, a.id, later)}`)).statusCode).toBe(401); // sb_recent's value
    expect((await t.call("POST", "/_auth/renew", {}, `${SESSION_COOKIE}=${sessionValue(KEY, a.id, later, later)}`)).statusCode).toBe(200); // the same passkey, a real session
  });

  test("a start with the cookie when AWS has no Spot capacity is 409 with reason capacity, not a Lambda error (#443)", async () => {
    const t = setup({ code: "reg-code-1234567890.1900000000000", startError: "InsufficientInstanceCapacity" });
    const a = authenticator();
    const c = await challenge(t);
    const cookie = t.cookieOf(await t.call("POST", "/_auth/register", { code: "reg-code-1234567890", challenge: c, ...a.register(c) }));
    const r = await t.call("POST", "/_auth/start", {}, cookie);
    expect(r.statusCode).toBe(409);
    expect(r.cookies).toBeUndefined(); // a refused start does not renew
    expect(r.json()).toMatchObject({ reason: "capacity" });
    expect(r.json().error).toContain("Spot の空きがありません");
  });

  test("the cookie is the #235 contract: base64url(\"id.idleUntil.expires\").Ed25519(seed, first part), 7 days and 24 hours idle (#701)", async () => {
    const t = setup({ code: "c0de-c0de-c0de-c0de.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    const value = t.cookieOf(await t.call("POST", "/_auth/register", { code: "c0de-c0de-c0de-c0de", challenge: c, ...a.register(c) })).split("; ")[0]!.slice(`${SESSION_COOKIE}=`.length);
    expect(value).toBe(sessionValue(KEY, a.id, t.nowOf() + SESSION_IDLE_MS, t.nowOf() + SESSION_MAX_MS));
    const [body] = value.split(".");
    expect(Buffer.from(body!, "base64url").toString()).toBe(`${a.id}.${t.nowOf() + SESSION_IDLE_MS}.${t.nowOf() + SESSION_MAX_MS}`);
    expect(sessionOf(PUB, value, t.nowOf())).toBe(a.id);
    expect(sessionOf(PUB, value, t.nowOf() + 31 * 24 * 3600_000)).toBeUndefined(); // expired
    expect(sessionOf(publicKeyOf(OTHER), value, t.nowOf())).toBeUndefined(); // another key (rotated)
    expect(sessionOf(PUB, value.slice(0, -2) + "xx", t.nowOf())).toBeUndefined(); // tampered
  });

  test("a cookie made from what the host can read is refused: HMAC keyed with the public key, or signed by another Ed25519 key (#701)", async () => {
    const t = setup({ code: "hosthosthosthosthost.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    const good = t.cookieOf(await t.call("POST", "/_auth/register", { code: "hosthosthosthosthost", challenge: c, ...a.register(c) }));
    expect((await t.call("POST", "/_auth/start", {}, good)).statusCode).toBe(202);
    const later = t.nowOf() + 1000, body = Buffer.from(`${a.id}.${later}`).toString("base64url");
    const hmac = (prefix: string) => `${body}.${createHmac("sha256", PUB).update(prefix + body).digest("base64url")}`; // the old shape, keyed with the host's value
    const flip = (v: string) => v.slice(0, -2) + (v.at(-2) === "A" ? "B" : "A") + v.at(-1);
    for (const [session, recent] of [
      [hmac(""), hmac("recent:")],
      [sessionValue(OTHER, a.id, later, later), recentValue(OTHER, a.id, later)],
      [flip(sessionValue(KEY, a.id, later, later)), recentValue(KEY, a.id, later)],
    ]) {
      expect((await t.call("POST", "/_auth/start", {}, `${SESSION_COOKIE}=${session}; ${RECENT_COOKIE}=${recent}`)).statusCode).toBe(401);
      expect((await t.call("GET", "/_auth/status", undefined, `${SESSION_COOKIE}=${session}`)).json()).toMatchObject({ loggedIn: false });
    }
    expect(t.sent.filter((x) => x instanceof StartInstancesCommand)).toHaveLength(1);
  });

  test("a cookie the Starter signed passes; an expired or tampered one does not (Ed25519 contract, #701)", () => {
    const now = 1_800_000_000_000, value = sessionValue(KEY, "pk-1", now + 1000, now + 1000);
    expect(sessionOf(PUB, value, now)).toBe("pk-1");
    expect(sessionOf(PUB, value, now + 1000)).toBeUndefined(); // expired
    const [, sig] = value.split(".");
    expect(sessionOf(PUB, `${Buffer.from(`pk-2.${now + 1000}`).toString("base64url")}.${sig}`, now)).toBeUndefined(); // another passkey id
    expect(sessionOf(PUB, `${Buffer.from(`pk-1.${now + 9e9}`).toString("base64url")}.${sig}`, now)).toBeUndefined(); // a later expiry
    expect(sessionOf(PUB, `${value.split(".")[0]}.${sig!.slice(0, 40)}`, now)).toBeUndefined(); // a short signature
    expect(sessionOf("not-a-key", value, now)).toBeUndefined();
  });

  test("a session ends at the 7-day cap or the 24-hour idle time, whichever comes first; the old two-field body is refused (#498)", () => {
    const now = 1_800_000_000_000;
    expect(sessionOf(PUB, sessionValue(KEY, "pk-1", now + SESSION_IDLE_MS, now + SESSION_MAX_MS), now)).toBe("pk-1");
    expect(sessionOf(PUB, sessionValue(KEY, "pk-1", now + 1000, now + SESSION_MAX_MS), now + 1000)).toBeUndefined(); // idle time over, cap left
    expect(sessionOf(PUB, sessionValue(KEY, "pk-1", now + SESSION_IDLE_MS, now + 1000), now + 1000)).toBeUndefined(); // cap over, idle time left
    expect(sessionOf(PUB, sessionValue(KEY, "pk-1", now + 2000, now + 1000), now)).toBeUndefined(); // idle time past the cap
    // the old two-field body, correctly signed as a session (no "recent:" prefix): refused for its shape alone
    const old = Buffer.from(`pk-1.${now + 1000}`).toString("base64url");
    const seed = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(KEY, "hex")]), format: "der", type: "pkcs8" });
    expect(sessionOf(PUB, `${old}.${sign(null, Buffer.from(old), seed).toString("base64url")}`, now)).toBeUndefined();
    expect(sessionOf(PUB, recentValue(KEY, "pk-1", now + 1000), now)).toBeUndefined(); // a recent body
  });

  test("publicKeyOf matches the key openssl derives from the same seed", () => {
    // RFC 8032 §7.1 TEST 1 (openssl pkey -pubout gives the same 32 bytes)
    expect(publicKeyOf("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")).toBe("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
    expect(PUB).toHaveLength(43);
  });

  test("a used, expired or wrong code is refused and registers nothing", async () => {
    for (const [stored, given] of [["good-code-good-code.1900000000000", "wrong-code"], ["good-code-good-code.1700000000000", "good-code-good-code"], [undefined, "anything"]] as const) {
      const t = setup({ code: stored });
      const a = authenticator();
      const c = await challenge(t);
      const r = await t.call("POST", "/_auth/register", { code: given, challenge: c, ...a.register(c) });
      expect(r.statusCode).toBe(403);
      expect(r.cookies).toBeUndefined();
      expect(t.objects.has("auth/passkeys.json")).toBe(false);
    }
  });

  test("login: an unknown passkey, a replayed challenge, a forged challenge and another origin are refused", async () => {
    const t = setup({ code: "abcabcabcabcabcabc.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    await t.call("POST", "/_auth/register", { code: "abcabcabcabcabcabc", challenge: c, ...a.register(c) });
    const c2 = await challenge(t);
    expect((await t.call("POST", "/_auth/login", { challenge: c2, ...authenticator().assert(c2) })).statusCode).toBe(401); // not registered
    const ok = await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) });
    expect(ok.statusCode).toBe(200);
    expect((await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) })).statusCode).toBe(400); // spent
    const forged = Buffer.from(randomBytes(56)).toString("base64url");
    expect((await t.call("POST", "/_auth/login", { challenge: forged, ...a.assert(forged) })).statusCode).toBe(400);
    const c3 = await challenge(t);
    expect((await t.call("POST", "/_auth/login", { challenge: c3, ...authenticator("https://evil.example").assert(c3), id: a.id })).statusCode).toBe(401);
    t.advance(6 * 60_000); // a challenge lives 5 minutes
    const c4 = await challenge(t);
    t.advance(6 * 60_000);
    expect((await t.call("POST", "/_auth/login", { challenge: c4, ...a.assert(c4) })).statusCode).toBe(400);
  });

  test("an unknown passkey is 401 reason unknown; a registered one that fails is 401 without a reason (#1312)", async () => {
    const t = setup({ code: "abcabcabcabcabcabc.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    await t.call("POST", "/_auth/register", { code: "abcabcabcabcabcabc", challenge: c, ...a.register(c) });
    const c2 = await challenge(t);
    const unknown = await t.call("POST", "/_auth/login", { challenge: c2, ...authenticator().assert(c2) });
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(unknown.body).reason).toBe("unknown");
    const c3 = await challenge(t);
    const bad = await t.call("POST", "/_auth/login", { challenge: c3, ...authenticator("https://evil.example").assert(c3), id: a.id });
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body).reason).toBeUndefined();
  });

  test("the page tells the device about a removed passkey, or says how to remove it (#1312)", async () => {
    const page = await Bun.file(new URL("./auth-page.html", import.meta.url)).text();
    const src = page.slice(page.indexOf("async function forgetPasskey"), page.indexOf("async function login"));
    expect(page.indexOf("async function forgetPasskey")).toBeGreaterThanOrEqual(0);
    expect(page.indexOf("async function login")).toBeGreaterThan(page.indexOf("async function forgetPasskey"));
    const run = async (reason: string | undefined, signal: unknown) => {
      const signalled: unknown[] = [];
      const pkc = signal === "fn" ? { signalUnknownCredential: async (o: unknown) => void signalled.push(o) } : signal === "reject" ? { signalUnknownCredential: async () => { throw new Error("no"); } } : {};
      const api = async () => { throw Object.assign(new Error("x"), { status: 401, reason }); };
      const credentials = { get: async () => ({ id: "cred-1", response: { clientDataJSON: new Uint8Array(1), authenticatorData: new Uint8Array(1), signature: new Uint8Array(1) } }) };
      const f = new Function("api", "navigator", "PublicKeyCredential", "say", "b64", "unb64", "cancelled", `${src}\nreturn confirmPasskey;`)(
        async (p: string) => (p === "challenge" ? { challenge: "AA", rpId: "sb.example" } : api()), { credentials }, pkc, () => {}, () => "", () => new Uint8Array(1), () => null,
      ) as () => Promise<boolean>;
      const error = await f().then(() => undefined, (e: Error) => e);
      return { signalled, error };
    };
    const a = await run("unknown", "fn");
    expect(a.signalled).toEqual([{ rpId: "sb.example", credentialId: "cred-1" }]);
    expect(a.error?.message).toContain("この端末に知らせた");
    const b = await run("unknown", "none");
    expect(b.signalled).toEqual([]);
    expect(b.error?.message).toContain("設定から消せます");
    const d = await run("unknown", "reject");
    expect(d.error?.message).toContain("設定から消せます"); // a signal that fails is not reported as sent
    const c = await run(undefined, "fn");
    expect(c.signalled).toEqual([]);
    expect(c.error?.message).toBe("x");
  });

  test(`after ${MAX_FAILURES} failures from one address it waits (429), others are not affected`, async () => {
    const t = setup();
    for (let i = 0; i < MAX_FAILURES; i++) expect((await t.call("POST", "/_auth/login", { challenge: "x" })).statusCode).toBe(400);
    expect((await t.call("POST", "/_auth/login", { challenge: "x" })).statusCode).toBe(429);
    t.advance(11 * 60_000);
    expect((await t.call("POST", "/_auth/login", { challenge: "x" })).statusCode).toBe(400);
  });

  test("without the shared header (not through CloudFront) every /_auth path is 403; start and rebuild need the cookie", async () => {
    const t = setup();
    for (const [m, p] of [["GET", "/_auth/"], ["GET", "/_auth/status"], ["POST", "/_auth/challenge"], ["POST", "/_auth/start"]] as const) {
      expect((await t.call(m, p, m === "POST" ? {} : undefined, undefined, {})).statusCode).toBe(403);
      expect((await t.call(m, p, m === "POST" ? {} : undefined, undefined, { "x-switchboard-edge": "wrong-value-here!" })).statusCode).toBe(403);
    }
    expect((await t.call("POST", "/_auth/start", {})).statusCode).toBe(401);
    expect((await t.call("POST", "/_auth/rebuild", {})).statusCode).toBe(401);
    expect((await t.call("POST", "/_auth/start", {}, `${SESSION_COOKIE}=${sessionValue(KEY, "no-such-passkey", t.nowOf() + 1000, t.nowOf() + 1000)}`)).statusCode).toBe(401); // removed passkey
    expect(t.sent.some((x) => x instanceof StartInstancesCommand)).toBe(false);
  });

  test("auth log (#1490): a failed login and the 429 each leave one JSON line with the address key, path and status — no challenge or cookie value", async () => {
    const t = setup({ code: "abcabcabcabcabcabc.1900000000000" });
    const spy = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const a = authenticator();
      const c = await challenge(t);
      await t.call("POST", "/_auth/register", { code: "abcabcabcabcabcabc", challenge: c, ...a.register(c) });
      spy.mockClear();
      const c2 = await challenge(t);
      const cookie = `${SESSION_COOKIE}=cookie-secret-value`;
      expect((await t.call("POST", "/_auth/login", { challenge: c2, ...authenticator().assert(c2) }, cookie)).statusCode).toBe(401);
      const lines = () => spy.mock.calls.map((x) => String(x[0])).filter((l) => l.includes('"log":"auth"'));
      expect(lines()).toHaveLength(1);
      expect(JSON.parse(lines()[0]!)).toMatchObject({ log: "auth", ip: addressKey("198.51.100.7"), path: "/_auth/login", status: 401 });
      expect(lines()[0]).not.toContain(c2);
      expect(lines()[0]).not.toContain("cookie-secret-value");
      for (let i = 0; i < MAX_FAILURES; i++) await t.call("POST", "/_auth/login", { challenge: "x" });
      expect(JSON.parse(lines().at(-1)!)).toMatchObject({ path: "/_auth/login", status: 429 });
      expect(spy.mock.calls.map((x) => String(x[0])).join("\n")).not.toContain("51234"); // the key, never the port
    } finally {
      spy.mockRestore();
    }
  });

  test("the page reads the registration code from the fragment, not the query (#1490)", async () => {
    const page = await setup().call("GET", "/_auth/");
    expect(page.body).toContain("location.hash");
    expect(page.body).not.toContain('q.get("register")');
  });

  test("GET /_auth/ is the page (no token field anywhere); logout clears the cookie", async () => {
    const t = setup();
    const page = await t.call("GET", "/_auth/");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("navigator.credentials.get");
    expect(page.body).toContain('userVerification: "required"');
    // nothing to type for the login; the only inputs are the countries section's (#1639)
    expect([...page.body.matchAll(/<input id="(\w+)"/g)].map((m) => m[1])).toEqual(["cCountries", "cFrom", "cUntil"]);
    expect(page.body).not.toMatch(/type="(password|text)"/i);
    const out = await t.call("POST", "/_auth/logout", {});
    expect(out.cookies?.[0]).toMatch(/^sb_session=; .*Max-Age=0$/);
    expect(out.cookies?.[1]).toMatch(/^sb_recent=; .*Max-Age=0$/);
  });

  test("the page's next is a page of this site only: no open redirect, never back into /_auth (review #348)", async () => {
    const html = (await setup().call("GET", "/_auth/")).body;
    const src = html.slice(html.indexOf("function safeNext"), html.indexOf("const next = safeNext"));
    const safeNext = new Function("location", `${src}; return safeNext;`)({ origin: ORIGIN }) as (raw: string | null) => string;
    for (const bad of ["/\\evil.example", "//evil.example", "/\\/evil.example", "https://evil.example/", "javascript:alert(1)", "evil", "/_auth/", "/_auth?next=/x", null, ""]) expect(safeNext(bad)).toBe("/");
    expect(safeNext("/tasks/x?tab=diff#end")).toBe("/tasks/x?tab=diff#end");
    expect(safeNext("/rescue/")).toBe("/rescue/");
  });

  test("the page goes on only when the daemon lets this browser in (health with runners), not on any 200", async () => {
    const html = (await setup().call("GET", "/_auth/")).body;
    expect(html).toContain("return Array.isArray(h.runners);");
  });

  test("no session key, or a short one: 503, never a challenge or a cookie signed with an empty key (review #349)", async () => {
    for (const key of [null, "", "short-key", "g".repeat(64), "a".repeat(66)]) {
      const t = setup({ sessionKey: key, code: "abcabcabcabcabcabc.1900000000000" });
      expect((await t.call("POST", "/_auth/challenge", {})).statusCode).toBe(503);
      const forged = `${SESSION_COOKIE}=${sessionValue(KEY, "any", t.nowOf() + 1000, t.nowOf() + 1000)}`;
      const r = await t.call("POST", "/_auth/start", {}, forged);
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toContain("session-signing-key");
      expect(t.sent.some((x) => x instanceof StartInstancesCommand)).toBe(false);
    }
  });

  test("a rotated session key takes effect within a minute without recycling the Lambda: old cookies stop, new ones are signed with it (review #349)", async () => {
    const t = setup({ code: "rotaterotaterotate.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    const old = t.cookieOf(await t.call("POST", "/_auth/register", { code: "rotaterotaterotate", challenge: c, ...a.register(c) }));
    expect((await t.call("POST", "/_auth/start", {}, old)).statusCode).toBe(202);
    t.params.set("/switchboard/session-signing-key", OTHER);
    t.advance(61_000); // the key is read again within a minute
    expect((await t.call("POST", "/_auth/start", {}, old)).statusCode).toBe(401);
    const c2 = await challenge(t);
    const fresh = t.cookieOf(await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) }));
    expect(sessionOf(publicKeyOf(OTHER), fresh.split("; ")[0]!.slice(SESSION_COOKIE.length + 1), t.nowOf())).toBe(a.id);
  });

  test("the rate limit is per viewer (CloudFront-Viewer-Address, IPv6 by /64), not per edge node (review #349)", async () => {
    const t = setup();
    for (let i = 0; i < MAX_FAILURES; i++) await t.call("POST", "/_auth/login", { challenge: "x" }, undefined, undefined, `2001:db8:1:2::${i + 1}:443`);
    expect((await t.call("POST", "/_auth/login", { challenge: "x" }, undefined, undefined, "2001:db8:1:2:ffff::9:443")).statusCode).toBe(429); // same /64
    expect((await t.call("POST", "/_auth/login", { challenge: "x" }, undefined, undefined, "2001:db8:1:3::1:443")).statusCode).toBe(400); // another /64
    expect((await t.call("POST", "/_auth/login", { challenge: "x" }, undefined, undefined, "198.51.100.8:1")).statusCode).toBe(400); // the owner behind the same edge node
    expect(addressKey("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
  });

  test("the register code is consumed before the passkey is saved: two submissions of one link register one passkey (review #349)", async () => {
    const t = setup({ code: "onceonceonceonceonce.1900000000000" });
    const a = authenticator(), b = authenticator();
    const c1 = await challenge(t), c2 = await challenge(t);
    const [r1, r2] = await Promise.all([t.call("POST", "/_auth/register", { code: "onceonceonceonceonce", challenge: c1, ...a.register(c1) }), t.call("POST", "/_auth/register", { code: "onceonceonceonceonce", challenge: c2, ...b.register(c2) })]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 403]);
    expect(JSON.parse(t.objects.get("auth/passkeys.json")!).passkeys).toHaveLength(1);
  });

  test("a write that lost to another (412) is redone on a fresh read, so neither is lost (review #349)", async () => {
    const t = setup({ code: "raceraceraceraceracer.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    await t.call("POST", "/_auth/register", { code: "raceraceraceraceracer", challenge: c, ...a.register(c) });
    t.conflictNext();
    const c2 = await challenge(t);
    expect((await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) })).statusCode).toBe(200);
    const stored = JSON.parse(t.objects.get("auth/passkeys.json")!);
    expect(stored.passkeys).toHaveLength(1);
    expect(stored.spent.map((x: { challenge: string }) => x.challenge)).toContain(c2);
  });

  test("the page may not be framed and runs only its own script (review #349)", async () => {
    const page = await setup().call("GET", "/_auth/");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  test("back to the page asked for with from=auth, its query and hash kept (#235's loop guard)", async () => {
    const html = (await setup().call("GET", "/_auth/")).body;
    const src = html.slice(html.indexOf("function safeNext"), html.indexOf("async function api"));
    const back = (next: string) => new Function("location", "q", `${src}; return back();`)({ origin: ORIGIN }, new URLSearchParams({ next })) as string;
    expect(back("/tasks/x?tab=diff#end")).toBe("/tasks/x?tab=diff&from=auth#end");
    expect(back("/")).toBe("/?from=auth");
    expect(html).not.toContain("location.replace(next)");
  });

  test("the machine-token paths are unchanged (CI and sb-rescue)", async () => {
    const t = setup();
    expect((await t.call("POST", "/start", undefined, undefined, { "x-switchboard-edge": EDGE, "x-switchboard-start-token": "tok" })).statusCode).toBe(202);
    expect((await t.call("POST", "/start", undefined, undefined, { "x-switchboard-edge": EDGE, "x-switchboard-start-token": "nope" })).statusCode).toBe(403);
  });

  const registered = async (state?: string, base?: string[]) => {
    const t = setup({ state, base, code: "recentrecentrecent.1900000000000" });
    const a = authenticator();
    const c = await challenge(t);
    const reg = await t.call("POST", "/_auth/register", { code: "recentrecentrecent", challenge: c, ...a.register(c) });
    const session = reg.cookies![0]!.split(";")[0]!;
    const login = async () => {
      const c2 = await challenge(t);
      return t.cookieOf(await t.call("POST", "/_auth/login", { challenge: c2, ...a.assert(c2) }));
    };
    return { t, a, reg, session, login };
  };

  test("start and rebuild need a passkey check within 5 minutes: the session cookie alone is 401 recent, right after login it is 202 (#497)", async () => {
    for (const [path, state] of [["/_auth/rebuild", "running"], ["/_auth/start", "stopped"], ["/_auth/stop", "running"]] as const) {
      const { t, session, login } = await registered(state);
      expect((await t.call("POST", path, {}, await login())).statusCode).toBe(202);
      t.advance(RECENT_MS + 1);
      const stale = await t.call("POST", path, {}, session);
      expect(stale.statusCode).toBe(401);
      expect(stale.json()).toMatchObject({ reason: "recent" });
      expect((await t.call("GET", "/_auth/status", undefined, session)).json()).toMatchObject({ loggedIn: true }); // seeing needs no check
      const ran = t.sent.length;
      expect((await t.call("POST", path, {}, session)).statusCode).toBe(401);
      expect(t.sent.slice(ran).map((x) => x.constructor.name).filter((n) => /Start|Stop|Replace/.test(n))).toEqual([]); // nothing ran
      expect((await t.call("POST", path, {}, await login())).statusCode).toBe(202);
    }
  });

  test("countries: reading needs the cookie, saving needs a recent passkey check (#1639)", async () => {
    const { t, session, login } = await registered("stopped", ["JP"]);
    const until = t.nowOf() + 24 * 3600_000;
    const logs: Array<Record<string, unknown>> = [];
    const log = console.log;
    console.log = (l: string) => void logs.push(JSON.parse(l));
    try {
      expect((await t.call("GET", "/_auth/countries")).statusCode).toBe(401);
      expect((await t.call("POST", "/_auth/countries", { countries: ["US"], until })).statusCode).toBe(401);
      expect((await t.call("GET", "/_auth/countries", undefined, session)).json()).toEqual({ base: ["JP"], allowance: null, active: false });
      const cookieOnly = await t.call("POST", "/_auth/countries", { countries: ["US"], until }, session);
      expect(cookieOnly.statusCode).toBe(401);
      expect(cookieOnly.json()).toMatchObject({ reason: "recent" });
      expect(t.whitelist()).toEqual(["JP"]);
      const ok = await t.call("POST", "/_auth/countries", { countries: ["US"], until }, await login());
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ active: true, allowance: { countries: ["US"], until } });
      expect(t.whitelist()).toEqual(["JP", "US"]);
      expect(logs.map((l) => l.action)).toEqual(["set", "apply"]);
      expect(logs[0]).toMatchObject({ log: "countries", countries: ["US"], until });
      t.advance(RECENT_MS + 1);
      expect((await t.call("POST", "/_auth/countries/clear", {}, session)).json()).toMatchObject({ reason: "recent" });
      expect((await t.call("POST", "/_auth/countries/clear", {}, await login())).statusCode).toBe(200);
      expect(t.whitelist()).toEqual(["JP"]);
      expect(logs.map((l) => l.action).slice(-2)).toEqual(["clear", "revert"]);
    } finally {
      console.log = log;
    }
  });

  test("countries: a bad allowance is 400 and nothing is saved", async () => {
    const { t, login } = await registered("stopped", ["JP"]);
    const now = t.nowOf();
    const day = 24 * 3600_000;
    const cookie = await login();
    for (const bad of [
      { countries: ["usa"], until: now + day },
      { countries: ["US"], until: now - 1 },
      { countries: ["US"], from: now + 2 * day, until: now + day },
      { countries: ["US"], until: now + 91 * day },
      { countries: ["US"] },
    ]) {
      const r = await t.call("POST", "/_auth/countries", bad, cookie);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBeTruthy();
    }
    expect(t.objects.has("auth/countries.json")).toBe(false);
    expect(t.whitelist()).toEqual(["JP"]);
  });

  test("countries: 404 when the starter has no countries", async () => {
    const { t, session } = await registered();
    expect((await t.call("GET", "/_auth/countries", undefined, session)).statusCode).toBe(404);
  });

  test("stop needs the cookie and a passkey check within 5 minutes; it stops only a running machine, and a stopping one only with force (#1394)", async () => {
    const stops = (t: { sent: object[] }) => t.sent.filter((x): x is StopInstancesCommand => x instanceof StopInstancesCommand);
    const noCookie = setup({ state: "running" });
    expect((await noCookie.call("POST", "/_auth/stop", {})).statusCode).toBe(401);
    expect(stops(noCookie)).toHaveLength(0);

    const running = await registered("running");
    expect((await running.t.call("POST", "/_auth/stop", {}, running.session)).statusCode).toBe(401); // the cookie alone
    expect((await running.t.call("POST", "/_auth/stop", {}, await running.login())).statusCode).toBe(202);
    expect(stops(running.t)[0]!.input).toEqual({ InstanceIds: ["i-0abc"], Force: false });
    running.t.advance(RECENT_MS + 1);
    const stale = await running.t.call("POST", "/_auth/stop", {}, running.session);
    expect(stale.json()).toMatchObject({ reason: "recent" });
    expect(stops(running.t)).toHaveLength(1);

    const stopping = await registered("stopping");
    const refused = await stopping.t.call("POST", "/_auth/stop", {}, await stopping.login());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "stopping" });
    expect(stops(stopping.t)).toHaveLength(0);
    expect((await stopping.t.call("POST", "/_auth/stop", { force: true }, await stopping.login())).statusCode).toBe(202);
    expect(stops(stopping.t)[0]!.input).toEqual({ InstanceIds: ["i-0abc"], Force: true });

    const forced = await registered("running");
    expect((await forced.t.call("POST", "/_auth/stop", { force: true }, await forced.login())).statusCode).toBe(409); // Force only for a stopping one
    const pending = await registered("pending");
    expect((await pending.t.call("POST", "/_auth/stop", {}, await pending.login())).statusCode).toBe(409);
    expect(stops(forced.t)).toHaveLength(0);
    expect(stops(pending.t)).toHaveLength(0);

    const stopped = await registered("stopped");
    expect((await stopped.t.call("POST", "/_auth/stop", { force: true }, await stopped.login())).statusCode).toBe(409);
    expect(stops(stopped.t)).toHaveLength(0);
  });

  test("a recent cookie that is expired, signed with another key, is a session value, or names another passkey is refused (#497)", async () => {
    const { t, a, session } = await registered();
    const later = t.nowOf() + RECENT_MS;
    for (const recent of [
      recentValue(KEY, a.id, t.nowOf() - 1), // expired
      recentValue(OTHER, a.id, later), // another key
      sessionValue(KEY, a.id, later, later), // the session's value pasted into sb_recent
      recentValue(KEY, "another-passkey", later), // another passkey's check
    ]) {
      const r = await t.call("POST", "/_auth/start", {}, `${session}; ${RECENT_COOKIE}=${recent}`);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ reason: "recent" });
    }
    expect(recentOf(PUB, sessionValue(KEY, a.id, later, later), t.nowOf())).toBeUndefined();
    expect(sessionOf(PUB, recentValue(KEY, a.id, later), t.nowOf())).toBeUndefined(); // nor a recent value a session
    expect((await t.call("POST", "/_auth/start", {}, `${session}; ${RECENT_COOKIE}=${recentValue(KEY, a.id, later)}`)).statusCode).toBe(202);
  });

  test("the recent cookie is HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=300 and comes with login and register (#497)", async () => {
    const { t, a, reg, login } = await registered();
    const shape = /^sb_recent=([^;]+); HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=300$/;
    expect(reg.cookies?.[1]).toMatch(shape);
    expect(recentOf(PUB, reg.cookies![1]!.match(shape)![1], t.nowOf())).toBe(a.id);
    expect((await login()).split("; ")[1]).toStartWith(`${RECENT_COOKIE}=`);
  });

  test("the page checks the passkey and sends start / 作り直す once more on 401 recent (#497)", async () => {
    const html = (await setup().call("GET", "/_auth/")).body;
    expect(html).toContain('e.reason !== "recent"');
    expect(html).toContain('withRecent(() => api("start", {}))');
    expect(html).toContain('withRecent(() => api("rebuild", {}))');
    expect(html).toContain('withRecent(() => api("stop", { force }))');
  });
});

describe("aws/auth.ts — another device from a logged-in one (#414)", () => {
  const ADMIN = "admin-code-admin-code";
  /** One passkey registered with the agent's code: its authenticator and the browser's cookies. */
  async function first(t: ReturnType<typeof setup>) {
    const a = authenticator();
    const c = await challenge(t);
    const r = await t.call("POST", "/_auth/register", { code: ADMIN, challenge: c, ...a.register(c) });
    expect(r.statusCode).toBe(201);
    return { a, cookie: t.cookieOf(r) };
  }
  /** Asks for a device code with a passkey signature made for this request. */
  async function deviceCode(t: ReturnType<typeof setup>, a: ReturnType<typeof authenticator>, cookie?: string) {
    const c = await challenge(t);
    return t.call("POST", "/_auth/device-code", { challenge: c, ...a.assert(c) }, cookie);
  }
  const register = async (t: ReturnType<typeof setup>, code: string, b = authenticator()) => {
    const c = await challenge(t);
    return t.call("POST", "/_auth/register", { code, challenge: c, ...b.register(c) });
  };
  const stored = (t: ReturnType<typeof setup>) => JSON.parse(t.objects.get("auth/passkeys.json")!);

  test("device-code: the cookie alone is 401; with a fresh passkey assertion it returns a one-time code for 10 minutes", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    // the cookie (sb_session and sb_recent, right after the registration) without a signature
    expect((await t.call("POST", "/_auth/device-code", {}, cookie)).statusCode).toBe(400);
    const c0 = await challenge(t);
    expect((await t.call("POST", "/_auth/device-code", { challenge: c0 }, cookie)).statusCode).toBe(401);
    // a signature without the cookie, and a signature for another origin
    expect((await deviceCode(t, a)).statusCode).toBe(401);
    const c1 = await challenge(t);
    expect((await t.call("POST", "/_auth/device-code", { challenge: c1, ...authenticator("https://evil.example").assert(c1), id: a.id }, cookie)).statusCode).toBe(401);
    expect(stored(t).deviceCode).toBeUndefined();

    const r = await deviceCode(t, a, cookie);
    expect(r.statusCode).toBe(200);
    expect(r.cookies).toBeUndefined();
    const { code, expires } = r.json();
    expect(code).toMatch(/^[\w-]{32}$/);
    expect(expires).toBe(t.nowOf() + DEVICE_CODE_MS);
    expect(DEVICE_CODE_MS).toBe(10 * 60_000);
    // only its hash is kept, and nothing went to Parameter Store
    const text = t.objects.get("auth/passkeys.json")!;
    expect(text).not.toContain(code);
    expect(stored(t).deviceCode).toEqual({ hash: createHash("sha256").update(code).digest("hex"), expires });
    expect(t.params.has("/switchboard/register-code")).toBe(false); // the agent's code was used by the first passkey
    expect(t.sent.some((x) => x.constructor.name === "PutParameterCommand")).toBe(false);
  });

  test("a device code registers one passkey once; a used, expired (10 min) or replaced code is refused", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    const { code } = (await deviceCode(t, a, cookie)).json();
    const b = authenticator();
    const ok = await register(t, code, b);
    expect(ok.statusCode).toBe(201);
    expect(t.cookieOf(ok)).toContain(`${SESSION_COOKIE}=`);
    expect(stored(t).passkeys.map((p: { id: string }) => p.id)).toEqual([a.id, b.id]);
    expect(stored(t).deviceCode).toBeUndefined();
    expect((await register(t, code)).statusCode).toBe(403); // used

    const late = (await deviceCode(t, a, cookie)).json().code;
    t.advance(DEVICE_CODE_MS + 1);
    expect((await register(t, late)).statusCode).toBe(403); // expired

    const old = (await deviceCode(t, a, cookie)).json().code;
    const fresh = (await deviceCode(t, a, cookie)).json().code;
    expect((await register(t, old)).statusCode).toBe(403); // replaced by the newer one
    expect((await register(t, "")).statusCode).toBe(403);
    expect((await register(t, fresh)).statusCode).toBe(201);
    expect(stored(t).passkeys).toHaveLength(3);
  });

  test(`at ${MAX_PASSKEYS} passkeys device-code is 409 and a device-code registration is refused; the admin register-code is not capped`, async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    // a code asked for at 4 passkeys, kept while the fifth comes in by another code
    for (let n = 1; n < MAX_PASSKEYS - 1; n++) expect((await register(t, (await deviceCode(t, a, cookie)).json().code)).statusCode).toBe(201);
    const kept = (await deviceCode(t, a, cookie)).json().code;
    t.objects.set("auth/passkeys.json", JSON.stringify({ ...stored(t), passkeys: [...stored(t).passkeys, { ...stored(t).passkeys[0], id: "fifth" }] }));
    expect(stored(t).passkeys).toHaveLength(MAX_PASSKEYS);
    const full = await deviceCode(t, a, cookie);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ reason: "full" });
    expect(full.json().error).toContain("5 本まで");
    expect((await register(t, kept)).statusCode).toBe(409);
    expect(stored(t).passkeys).toHaveLength(MAX_PASSKEYS);
    // the agent's link (the first passkey, recovery) still registers a sixth
    t.params.set("/switchboard/register-code", `${ADMIN}.1900000000000`);
    expect((await register(t, ADMIN)).statusCode).toBe(201);
    expect(stored(t).passkeys).toHaveLength(MAX_PASSKEYS + 1);
  });

  test("a passkey removed while its device-code request was writing gets no code (412 re-read)", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    t.conflictNext((objects) => {
      const s = JSON.parse(objects.get("auth/passkeys.json")!);
      objects.set("auth/passkeys.json", JSON.stringify({ ...s, passkeys: s.passkeys.filter((p: { id: string }) => p.id !== a.id) }));
    });
    const r = await deviceCode(t, a, cookie);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: "unknown" });
    expect(stored(t).deviceCode).toBeUndefined();
  });

  test("two submissions of one device code register one passkey (412 re-read)", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    const { code } = (await deviceCode(t, a, cookie)).json();
    const [r1, r2] = await Promise.all([register(t, code), register(t, code)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 403]);
    expect(stored(t).passkeys).toHaveLength(2);
    // the write that loses after its re-read (another write moved the version) also finds the code gone
    const again = (await deviceCode(t, a, cookie)).json().code;
    t.conflictNext();
    expect((await register(t, again)).statusCode).toBe(201);
    expect(stored(t).passkeys).toHaveLength(3);
  });

  /** Deletes `target` with a passkey signature made for this request. */
  async function remove(t: ReturnType<typeof setup>, a: ReturnType<typeof authenticator>, target: string, cookie?: string) {
    const c = await challenge(t);
    return t.call("POST", "/_auth/passkeys/delete", { target, challenge: c, ...a.assert(c) }, cookie);
  }
  const list = async (t: ReturnType<typeof setup>, cookie?: string) => t.call("GET", "/_auth/passkeys", undefined, cookie);

  test("the passkey list needs the cookie and shows device, created, last used and which is this browser — never the public key", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    expect((await list(t)).statusCode).toBe(401);
    const created = t.nowOf();
    t.advance(60_000);
    const { code } = (await deviceCode(t, a, cookie)).json(); // a passkey check: a's last use
    const b = authenticator();
    const rb = await register(t, code, b);
    expect(rb.statusCode).toBe(201);
    const r = await list(t, cookie);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      passkeys: [
        { id: a.id, device: "iPhone / iPad", created, lastUsed: created + 60_000, current: true },
        { id: b.id, device: "iPhone / iPad", created: expect.any(Number), lastUsed: null, current: false },
      ],
    });
    expect(r.body).not.toContain(stored(t).passkeys[0].publicKey);
    expect(r.body).not.toContain("counter");
    expect((await list(t, t.cookieOf(rb))).json().passkeys.map((p: { current: boolean }) => p.current)).toEqual([false, true]);
    // a login and a delete are uses too
    t.advance(60_000);
    const c = await challenge(t);
    expect((await t.call("POST", "/_auth/login", { challenge: c, ...b.assert(c) })).statusCode).toBe(200);
    expect(stored(t).passkeys[1].lastUsed).toBe(t.nowOf());
    t.advance(60_000);
    const third = await register(t, (await deviceCode(t, a, cookie)).json().code);
    expect(third.statusCode).toBe(201);
    t.advance(60_000);
    expect((await remove(t, b, stored(t).passkeys[2].id, cookie)).statusCode).toBe(200);
    expect(stored(t).passkeys[1].lastUsed).toBe(t.nowOf());
  });

  test("delete needs a fresh passkey assertion (the cookie alone is 401); the deleted passkey's cookie no longer starts the machine", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    const b = authenticator();
    const rb = await register(t, (await deviceCode(t, a, cookie)).json().code, b);
    const cookieB = t.cookieOf(rb);
    // the cookie (sb_session and sb_recent) without a signature, a signature without the cookie, another origin's signature
    expect((await t.call("POST", "/_auth/passkeys/delete", { target: b.id }, cookie)).statusCode).toBe(400);
    const c0 = await challenge(t);
    expect((await t.call("POST", "/_auth/passkeys/delete", { target: b.id, challenge: c0 }, cookie)).statusCode).toBe(401);
    expect((await remove(t, a, b.id)).statusCode).toBe(401);
    const c1 = await challenge(t);
    expect((await t.call("POST", "/_auth/passkeys/delete", { target: b.id, challenge: c1, ...authenticator("https://evil.example").assert(c1), id: a.id }, cookie)).statusCode).toBe(401);
    expect((await remove(t, a, "not-a-passkey", cookie)).statusCode).toBe(404);
    expect(stored(t).passkeys).toHaveLength(2);

    expect((await t.call("POST", "/_auth/start", {}, cookieB)).statusCode).toBe(202); // b's own cookie, recent from its registration
    const r = await remove(t, a, b.id, cookie);
    expect(r.statusCode).toBe(200);
    expect(stored(t).passkeys.map((p: { id: string }) => p.id)).toEqual([a.id]);
    expect((await t.call("POST", "/_auth/start", {}, cookieB)).statusCode).toBe(401);
    expect((await t.call("GET", "/_auth/status", undefined, cookieB)).json()).toMatchObject({ loggedIn: false });
    expect((await list(t, cookieB)).statusCode).toBe(401);
  });

  test("the last passkey cannot be deleted (409), also when two deletes race (412 re-read)", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    const last = await remove(t, a, a.id, cookie);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ error: "最後の 1 本は消せません", reason: "last" });
    const b = authenticator();
    await register(t, (await deviceCode(t, a, cookie)).json().code, b);
    // two browsers delete each other's passkey at once: one of them wins, one passkey stays
    const [r1, r2] = await Promise.all([remove(t, a, b.id, cookie), remove(t, a, a.id, cookie)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    expect(stored(t).passkeys).toHaveLength(1);
  });

  test("the page adds a device and deletes a passkey only after a fresh passkey check (credentials.get before device-code and passkeys/delete), with nothing to type", async () => {
    const t = setup();
    const page = (await t.call("GET", "/_auth/")).body;
    const fn = (name: string) => page.slice(page.indexOf(`async function ${name}(`), page.indexOf("\n}\n", page.indexOf(`async function ${name}(`)));
    const fresh = fn("assertFresh");
    expect(fresh).toContain("navigator.credentials.get");
    expect(fresh).toContain('userVerification: "required"');
    for (const [name, call] of [["addDevice", 'api("device-code"'], ["removePasskey", 'api("passkeys/delete"']] as const) {
      const body = fn(name);
      expect(body.indexOf("await assertFresh()")).toBeGreaterThanOrEqual(0);
      expect(body.indexOf(call)).toBeGreaterThan(body.indexOf("await assertFresh()"));
    }
    expect(fn("removePasskey").indexOf("confirm(")).toBeLessThan(fn("removePasskey").indexOf("await assertFresh()"));
    // the card has no field to type in: the link is shown and copied
    const card = page.slice(page.indexOf('<div class="card" id="devices"'), page.indexOf("</div>\n<div class=\"dim\"><a href=\"#\" id=\"logout\""));
    expect(card).toContain('id="addDevice"');
    expect(card).not.toContain("<input");
    expect(page).toContain("/_auth/#register=${code}"); // the fragment, as the agent's link (#1490)
  });

  test("a passkey removed while its delete was writing deletes nothing (412 re-read, review #2507)", async () => {
    const t = setup({ code: `${ADMIN}.1900000000000` });
    const { a, cookie } = await first(t);
    const b = authenticator(), c = authenticator();
    await register(t, (await deviceCode(t, a, cookie)).json().code, b);
    await register(t, (await deviceCode(t, a, cookie)).json().code, c);
    // b deletes c while a's delete of b wins the write
    t.conflictNext((objects) => {
      const s = JSON.parse(objects.get("auth/passkeys.json")!);
      objects.set("auth/passkeys.json", JSON.stringify({ ...s, passkeys: s.passkeys.filter((p: { id: string }) => p.id !== b.id) }));
    });
    const r = await remove(t, b, c.id, cookie);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ reason: "unknown" });
    expect(stored(t).passkeys.map((p: { id: string }) => p.id)).toEqual([a.id, c.id]);
  });
});
