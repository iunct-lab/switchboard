import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import type { Ctx } from "./promote.ts";
import { buildRelease, currentOf, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
let ctx: Ctx;
let v2: string;
let rescue: ReturnType<typeof startRescue>;
let base: string;
/** A fake /tmp (#797): one old working directory that may go, one new one that may not. */
let tmpRoot: string;
const OLD_DIR = "x.review1.aaaaaa";
const NEW_DIR = "x.review2.bbbbbb";
function oldDir() {
  mkdirSync(join(tmpRoot, OLD_DIR), { recursive: true });
  writeFileSync(join(tmpRoot, OLD_DIR, "f"), "x");
  const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
  utimesSync(join(tmpRoot, OLD_DIR, "f"), old, old);
  utimesSync(join(tmpRoot, OLD_DIR), old, old);
}
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const status = () => fetch(`${base}/api/status`).then((r) => r.json()) as Promise<{ current: string; previous: string | null; state: string; unhealthy: string | null; busy: string | null; releases: Array<{ sha: string; subject: string; tag: string | null }>; history: Array<{ action: string }>; log: string[] }>;

beforeAll(async () => {
  f = await makeRepo();
  await buildRelease(f.repo, "HEAD", f.home);
  v2 = await buildRelease(f.repo, await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2"), "second version"), f.home);
  switchTo(f.home, f.v1);
  switchTo(f.home, v2);
  const port = await freePort();
  ctx = { home: f.home, repo: f.repo, port, sup: new Supervisor({ home: f.home, repo: f.repo, port, backoffMs: 50 }) };
  ctx.sup.start();
  await until(() => health(port), "v2 up");
  tmpRoot = mkdtempSync(join(tmpdir(), "sb-rescue-tmp-"));
  oldDir();
  mkdirSync(join(tmpRoot, NEW_DIR));
  rescue = startRescue(ctx, { port: 0, tmpDir: tmpRoot });
  base = `http://127.0.0.1:${rescue.server.port}`;
});
afterAll(async () => {
  await rescue.stop();
  await ctx.sup.stop();
  rmSync(f.root, { recursive: true, force: true });
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("sb-rescue shares no code with Switchboard: only relative, node: and bun: imports", () => {
  const dir = join(import.meta.dir);
  const files = [...readdirSync(dir).filter((n) => n.endsWith(".ts")).map((n) => join(dir, n)), join(dir, "..", "install.ts")];
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const specifiers = files.flatMap((file) => transpiler.scanImports(readFileSync(file, "utf8")).map((i) => `${file.split("/").pop()}: ${i.path}`));
  expect(specifiers.length).toBeGreaterThan(10);
  expect(specifiers.filter((s) => !/: (\.\/[\w.-]+|node:[\w/]+|bun:[\w]+|bun)$/.test(s))).toEqual([]);
  expect(Object.keys(JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf8")).dependencies ?? {})).toEqual([]);
});

test("status shows version, state, history and the log; the page is one self-contained document", async () => {
  const s = await status();
  expect(s).toMatchObject({ current: v2, previous: f.v1, state: "running", unhealthy: null, busy: null });
  expect(s.releases.find((r) => r.sha === v2)?.subject).toBe("second version");
  expect(s.log.some((l) => l.includes("fixture daemon v2"))).toBe(true);
  const page = await fetch(`${base}/`);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.text();
  expect(html).toContain("前の版に戻す");
  expect(html).toContain("古い作業ディレクトリを消す"); // the /tmp section (#797)
  expect(html).toContain("api/tmp/clean");
  expect(() => new Function(html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>")))).not.toThrow(); // the script parses
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/); // nothing to fetch from a daemon that may be down
});

test("a release tag shows up next to its release, also when the tag came after the release was first listed", async () => {
  expect((await status()).releases.find((r) => r.sha === v2)?.tag).toBeNull(); // listed before the tag exists
  Bun.spawnSync(["git", "-C", f.repo, "tag", "v0.2.0", v2]);
  Bun.spawnSync(["git", "-C", f.repo, "tag", "not-a-release", f.v1]);
  const releases = (await status()).releases;
  expect(releases.find((r) => r.sha === v2)?.tag).toBe("v0.2.0");
  expect(releases.find((r) => r.sha === f.v1)?.tag).toBeNull(); // only v* tags
  // an annotated tag names the commit too, the highest version wins, and a tag moved by hand shows at once
  Bun.spawnSync(["git", "-C", f.repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "v1.0.0", "-m", "1.0", v2]);
  expect((await status()).releases.find((r) => r.sha === v2)?.tag).toBe("v1.0.0");
  Bun.spawnSync(["git", "-C", f.repo, "tag", "-d", "v1.0.0"]);
  expect((await status()).releases.find((r) => r.sha === v2)?.tag).toBe("v0.2.0");
});

test("with Switchboard down, rollback brings the previous release up; a second operation meanwhile is refused", async () => {
  expect((await post("/api/restart")).status).toBe(202); // stopping the daemon takes a moment: the next request meets a busy service
  expect((await post("/api/rollback")).status).toBe(409);
  await until(async () => (await status()).busy === null, "restart finished");
  await ctx.sup.stop();
  expect((await status()).unhealthy).toContain("no answer");
  expect((await post("/api/rollback")).status).toBe(202);
  expect((await until(() => health(ctx.port), "v1 up")).version).toBe("v1");
  await until(async () => (await status()).busy === null, "operation finished");
  expect(currentOf(f.home)).toBe(f.v1);
  expect((await status()).history[0]!.action).toBe("rollback");
  expect((await post("/api/rollback", { commit: v2 })).status).toBe(202); // choose a release
  expect((await until(async () => ((await health(ctx.port))?.version === "v2" ? true : null), "v2 chosen"))).toBe(true);
  await until(async () => (await status()).busy === null, "operation finished");
});

test("bad input and foreign origins are refused before anything runs", async () => {
  expect((await post("/api/rollback", {}, { origin: "https://evil.example" })).status).toBe(403);
  expect((await post("/api/rollback", { commit: "--upload-pack=x" })).status).toBe(400);
  expect((await post("/api/rollback", { commit: "0".repeat(40) })).status).toBe(400);
  expect((await post("/api/restore-db", { snapshot: "../switchboard.db" })).status).toBe(400);
  expect((await post("/api/promote", {})).status).toBe(400);
  const cutOff = await fetch(`${base}/api/rollback`, { method: "POST", body: `{"commit": "${f.v1.slice(0, 20)}` });
  expect(cutOff.status).toBe(400); // not "no arguments", which would mean "the previous release"
  expect((await fetch(`${base}/api/rollback`, { method: "POST", body: "[]" })).status).toBe(400);
  expect((await post("/api/tmp/clean", { names: [OLD_DIR] }, { origin: "https://evil.example" })).status).toBe(403);
  expect(existsSync(join(tmpRoot, OLD_DIR))).toBe(true);
  expect((await post("/api/nope")).status).toBe(404);
  expect((await status()).busy).toBeNull();
});

test("a spoofed Host on loopback is refused before anything runs (#1135)", async () => {
  // A page on a DNS-rebinding name sends that name as both Host and Origin, so the Origin check alone lets it through.
  const evil = { host: "evil.example:47841" };
  for (const [method, path] of [["GET", "/"], ["GET", "/api/status"], ["GET", "/api/tmp"], ["POST", "/api/rollback"]] as const) {
    const r = await fetch(`${base}${path}`, { method, headers: evil });
    expect(r.status, path).toBe(403);
    expect(await r.text(), path).toContain("host not allowed");
  }
  const rebound = await post("/api/rollback", {}, { ...evil, origin: "http://evil.example:47841" });
  expect(rebound.status).toBe(403);
  expect(await rebound.text()).toContain("host not allowed");
  expect((await post("/api/tmp/clean", { names: [OLD_DIR] }, { ...evil, origin: "http://evil.example:47841" })).status).toBe(403);
  expect(existsSync(join(tmpRoot, OLD_DIR))).toBe(true);
  expect((await status()).busy).toBeNull();
  for (const host of ["localhost:1", "[::1]:1"]) expect((await fetch(`${base}/api/status`, { headers: { host } })).status, host).toBe(200);
  // Off loopback the token rule stands: 401, not 403.
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  const open = startRescue(ctx, { port: 0, host: "0.0.0.0" });
  try {
    expect((await fetch(`http://127.0.0.1:${open.server.port}/api/status`, { headers: evil })).status).toBe(401);
  } finally {
    await open.stop();
    rmSync(join(f.home, "token"));
  }
});

test("off loopback every request needs the token; the page takes it from ?token=", async () => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  const open = startRescue(ctx, { port: 0, host: "0.0.0.0" });
  const url = `http://127.0.0.1:${open.server.port}`;
  try {
    expect((await fetch(`${url}/api/status`)).status).toBe(401);
    expect((await fetch(`${url}/`)).status).toBe(401);
    expect((await fetch(`${url}/api/status?token=sb_secret`)).status).toBe(401); // the API never takes it from the URL
    expect((await fetch(`${url}/?token=sb_secret`)).status).toBe(200);
    expect((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } })).status).toBe(200);
    expect((await fetch(`${url}/api/restart`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${url}/api/tmp`)).status).toBe(401);
  } finally {
    await open.stop();
    rmSync(join(f.home, "token"));
  }
});

/**
 * The Starter's side (aws/auth.ts, #701): an Ed25519 seed signs, sb-rescue holds only the public key. A test names a key
 * by a label; its seed is the label's SHA-256.
 */
const privateOf = (label: string) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(label).digest()]), format: "der", type: "pkcs8" });
const publicOf = (label: string) => createPublicKey(privateOf(label)).export({ format: "jwk" }).x!;
/** A stand-in for the Starter's GET /_auth/status (#708): `loggedIn` (or a 500) as set. */
const authStarter = { answer: true as boolean | 500, asked: 0, edge: null as string | null };
const authStarterServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (authStarter.asked++, (authStarter.edge = req.headers.get("x-switchboard-edge")), authStarter.answer === 500 ? new Response("", { status: 500 }) : Response.json({ loggedIn: authStarter.answer })) });
afterAll(() => void authStarterServer.stop(true));
const cloudLogin = (label: string) => ({ sessionPublicKey: publicOf(label), starter: { url: `http://127.0.0.1:${authStarterServer.port}`, token: "t" } });

test("the cloud host's login cookie (#211) opens the page and the API off loopback; an expired, foreign-key or host-forged one does not", async () => {
  const key = "k".repeat(64);
  const cookie = (k: string, expires: number, idleUntil = expires) => {
    const body = Buffer.from(`pk1.${idleUntil}.${expires}`).toString("base64url");
    return `sb_session=${body}.${sign(null, Buffer.from(body), privateOf(k)).toString("base64url")}`;
  };
  // what a process on the host could make: an HMAC keyed with the only value it has, the public key (#701)
  const forged = (expires: number) => {
    const body = Buffer.from(`pk1.${expires}.${expires}`).toString("base64url");
    return `sb_session=${body}.${createHmac("sha256", publicOf(key)).update(body).digest("base64url")}`;
  };
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  authStarter.answer = true;
  const cloud = startRescue(ctx, { port: 0, host: "0.0.0.0", ...cloudLogin(key) });
  const url = `http://127.0.0.1:${cloud.server.port}`;
  try {
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie(key, Date.now() + 60_000) } })).status).toBe(200);
    expect((await fetch(`${url}/`, { headers: { cookie: cookie(key, Date.now() + 60_000) } })).status).toBe(200);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie(key, Date.now() - 1) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie("z".repeat(64), Date.now() + 60_000) } })).status).toBe(401);
    // #498: past the cap even with idle time left, past the idle time within the cap, idle beyond the cap, and the old two-field body
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie(key, Date.now() - 1, Date.now() + 60_000) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie(key, Date.now() + 60_000, Date.now() - 1) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: cookie(key, Date.now() + 60_000, Date.now() + 120_000) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: signed("sb_session", key, "pk1", [Date.now() + 60_000]) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: forged(Date.now() + 60_000) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: `${cookie(key, Date.now() + 60_000)}=` } })).status).toBe(401); // another spelling
    expect((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } })).status).toBe(200); // the token still works
    // every pair is tried: a stale one first does not hide the good one
    expect((await fetch(`${url}/api/status`, { headers: { cookie: `${cookie(key, Date.now() - 1)}; ${cookie(key, Date.now() + 60_000)}` } })).status).toBe(200);
  } finally {
    await cloud.stop();
    rmSync(join(f.home, "token"));
  }
  // no key: a cookie is never enough
  const plain = startRescue(ctx, { port: 0, host: "0.0.0.0" });
  try {
    writeFileSync(join(f.home, "token"), "sb_secret\n");
    expect((await fetch(`http://127.0.0.1:${plain.server.port}/api/status`, { headers: { cookie: cookie(key, Date.now() + 60_000) } })).status).toBe(401);
  } finally {
    await plain.stop();
    rmSync(join(f.home, "token"));
  }
});

/** The Starter's cookies (aws/auth.ts): sb_session, and sb_recent signed over "recent:" + body (#497). */
const signed = (name: string, k: string, id: string, times: number[], prefix = "") => {
  const body = Buffer.from([id, ...times].join(".")).toString("base64url");
  return `${name}=${body}.${sign(null, Buffer.from(prefix + body), privateOf(k)).toString("base64url")}`;
};
const session = (k: string, expires = Date.now() + 60_000, id = "pk1", idleUntil = expires) => signed("sb_session", k, id, [idleUntil, expires]);
const recent = (k: string, expires = Date.now() + 60_000, id = "pk1") => signed("sb_recent", k, id, [expires], "recent:");
test("sb-rescue refuses a removed passkey's cookie within SESSION_RECHECK_MS (#701)", async () => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  authStarter.answer = true;
  authStarter.asked = 0;
  const cloud = startRescue(ctx, { port: 0, host: "0.0.0.0", ...cloudLogin("k".repeat(64)), sessionKeepMs: 200, edge: "edge-xyz" });
  const url = `http://127.0.0.1:${cloud.server.port}`;
  try {
    const cookie = session("k".repeat(64));
    expect((await fetch(`${url}/api/status`, { headers: { cookie } })).status).toBe(200);
    authStarter.answer = false; // the passkey is removed
    expect((await fetch(`${url}/api/status`, { headers: { cookie } })).status).toBe(200); // the kept answer
    expect(authStarter.asked).toBe(1);
    expect(authStarter.edge).toBe("edge-xyz"); // CloudFront's shared header: the Starter refuses without it
    await Bun.sleep(250);
    expect((await fetch(`${url}/api/status`, { headers: { cookie } })).status).toBe(401);
    authStarter.answer = 500;
    expect((await fetch(`${url}/api/status`, { headers: { cookie: session("k".repeat(64), Date.now() + 90_000) } })).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } })).status).toBe(200); // the token is not asked about
  } finally {
    await cloud.stop();
    rmSync(join(f.home, "token"));
    authStarter.answer = true;
  }
});

test("sb-rescue on the cloud host refuses the token from off the machine, keeps it on loopback (#701)", async () => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  authStarter.answer = true;
  let peer = "10.0.1.5";
  const cloud = startRescue(ctx, { port: 0, host: "0.0.0.0", ...cloudLogin("k".repeat(64)), peerAddress: () => peer });
  const mac = startRescue(ctx, { port: 0, host: "0.0.0.0", peerAddress: () => "10.0.1.5" });
  const url = `http://127.0.0.1:${cloud.server.port}`;
  try {
    const r = await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("/_auth/");
    expect((await fetch(`${url}/?token=sb_secret`)).status).toBe(401);
    expect((await fetch(`${url}/api/status`, { headers: { cookie: session("k".repeat(64)) } })).status).toBe(200); // the cookie still works
    peer = "127.0.0.1"; // this machine: the daemon's own checks, a person on the host
    expect((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } })).status).toBe(200);
    // a Mac (no public key): the token from elsewhere as before
    expect((await fetch(`http://127.0.0.1:${mac.server.port}/api/status`, { headers: { authorization: "Bearer sb_secret" } })).status).toBe(200);
  } finally {
    await cloud.stop();
    await mac.stop();
    rmSync(join(f.home, "token"));
  }
});

const CHANGES = ["/api/restart", "/api/rollback", "/api/promote", "/api/restore-db", "/api/rebuild", "/api/agent/start", "/api/agent/stop", "/api/tmp/clean"];
const onCloud = async (run: (url: string) => Promise<void>) => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  authStarter.answer = true;
  const cloud = startRescue(ctx, { port: 0, host: "0.0.0.0", ...cloudLogin("k".repeat(64)), tmpDir: tmpRoot });
  try {
    await run(`http://127.0.0.1:${cloud.server.port}`);
  } finally {
    await cloud.stop();
    rmSync(join(f.home, "token"));
  }
};

test("with the login cookie, every state-changing POST needs a passkey check within 5 minutes; status and the page do not (#497)", async () => {
  const key = "k".repeat(64);
  await onCloud(async (url) => {
    const cookie = session(key);
    for (const path of CHANGES) {
      const r = await fetch(`${url}${path}`, { method: "POST", headers: { cookie }, body: path === "/api/tmp/clean" ? JSON.stringify({ names: [OLD_DIR] }) : "{}" });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ reason: "recent" });
    }
    const seen = await fetch(`${url}/api/status`, { headers: { cookie } });
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { busy: string | null }).busy).toBeNull(); // nothing ran
    expect(existsSync(join(tmpRoot, OLD_DIR))).toBe(true);
    expect((await fetch(`${url}/api/tmp`, { headers: { cookie } })).status).toBe(200); // reading /tmp needs no check
    const page = await fetch(`${url}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data.reason === "recent"'); // the page checks the passkey and sends once more
    expect((await fetch(`${url}/api/restart`, { method: "POST", headers: { cookie: `${cookie}; ${recent(key)}` } })).status).toBe(202);
    await until(async () => ((await fetch(`${url}/api/status`, { headers: { cookie } }).then((r) => r.json())) as { busy: string | null }).busy === null, "restart finished");
  });
});

test("a recent cookie that is expired, signed with another key, is a session value, or names another passkey is refused (#497)", async () => {
  const key = "k".repeat(64);
  await onCloud(async (url) => {
    for (const bad of [
      recent(key, Date.now() - 1), // expired
      recent("z".repeat(64)), // another key
      session(key).replace("sb_session=", "sb_recent="), // the session's value pasted into sb_recent
      recent(key, Date.now() + 60_000, "pk2"), // another passkey's check
    ]) {
      const r = await fetch(`${url}/api/agent/stop`, { method: "POST", headers: { cookie: `${session(key)}; ${bad}` } });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ reason: "recent" });
    }
    // a recent value is not a session either: alone it lets nothing in
    expect((await fetch(`${url}/api/status`, { headers: { cookie: recent(key).replace("sb_recent=", "sb_session=") } })).status).toBe(401);
    expect((await fetch(`${url}/api/agent/stop`, { method: "POST", headers: { cookie: `${session(key)}; ${recent(key)}` } })).status).toBe(200);
  });
});

/**
 * The page's script from its helpers to act() (render, refresh, confirmPasskey) runs against fakes: what was sent, in
 * order, and what the error line shows after the next 2 s refresh, with the service's status saying `lastError`.
 */
async function runAct(answers: Record<string, Array<{ status: number; body?: unknown }>>, o: { credential?: unknown; lastError?: string | null; hostname?: string } = {}) {
  const html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const src = html.slice(html.indexOf("const short ="), html.indexOf('$("restart").onclick'));
  const sent: string[] = [];
  const el = () => ({ textContent: "", value: "", replaceChildren() {}, append() {} });
  const els = new Map<string, ReturnType<typeof el>>();
  const $ = (id: string) => els.get(id) ?? (els.set(id, el()), els.get(id)!);
  const status = { current: null, previous: null, releases: [], snapshots: [], history: [], log: [], busy: null, lastError: o.lastError ?? null, unhealthy: null, port: 1, state: "running", rebuild: false, agent: { running: false, exitCode: null, output: "" } };
  const fetch = async (path: string) => {
    if (path === "api/status") return Response.json(status);
    sent.push(path);
    const a = answers[path]!.shift()!;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
  };
  const credential = "credential" in o ? o.credential : { id: "pk1", response: { clientDataJSON: new Uint8Array([1]), authenticatorData: new Uint8Array([2]), signature: new Uint8Array([3]) } };
  const page = new Function("fetch", "confirm", "navigator", "$", "document", "headers", "rebuilding", "location", `${src}\nreturn { act, refresh };`)(
    fetch, () => true, { credentials: { get: async () => (credential instanceof Error ? Promise.reject(credential) : credential) } }, $, { createElement: el }, {}, false, { hostname: o.hostname ?? "d111.cloudfront.net" },
  ) as { act: (path: string, body: unknown, question: string) => Promise<boolean | null>; refresh: () => Promise<void> };
  const ok = await page.act("api/restart", {}, "?");
  await page.refresh(); // the next 2 s refresh
  return { ok, sent, error: $("error").textContent };
}
test("after a change that went through, the page asks the Starter to renew the login once per 10 minutes, off loopback only (#498)", async () => {
  const cloud = await runAct({ "api/restart": [{ status: 202 }], "/_auth/renew": [{ status: 200 }] });
  expect(cloud).toMatchObject({ ok: true, sent: ["api/restart", "/_auth/renew"] });
  const refused = await runAct({ "api/restart": [{ status: 500, body: { error: "x" } }] });
  expect(refused.sent).toEqual(["api/restart"]);
  const local = await runAct({ "api/restart": [{ status: 202 }] }, { hostname: "127.0.0.1" });
  expect(local.sent).toEqual(["api/restart"]);
});
const needsCheck = { status: 401, body: { error: "操作の前にパスキーで確かめてください", reason: "recent" } };
const challengeOk = { status: 200, body: { challenge: "AAAA", rpId: "d111.cloudfront.net" } };

test("the page checks the passkey on 401 recent and sends the same request once more; a failed or cancelled check sends nothing more and stays on the page (#497)", async () => {
  const done = await runAct({ "api/restart": [needsCheck, { status: 202 }], "/_auth/challenge": [challengeOk], "/_auth/login": [{ status: 200 }] });
  expect(done).toMatchObject({ ok: true, sent: ["api/restart", "/_auth/challenge", "/_auth/login", "api/restart"], error: "" });
  // the reason stays over the refresh, also when the service still shows an older failure
  const cancelled = await runAct({ "api/restart": [needsCheck], "/_auth/challenge": [challengeOk] }, { credential: null, lastError: "restart: an older failure" });
  expect(cancelled).toMatchObject({ ok: false, sent: ["api/restart", "/_auth/challenge"], error: "キャンセルしました" });
  // a browser that closes the sheet rejects with NotAllowedError instead of answering null: the same cancel
  const closed = await runAct({ "api/restart": [needsCheck], "/_auth/challenge": [challengeOk] }, { credential: Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" }) });
  expect(closed).toMatchObject({ ok: false, sent: ["api/restart", "/_auth/challenge"], error: "キャンセルしました" });
  const refusedLogin = await runAct({ "api/restart": [needsCheck], "/_auth/challenge": [challengeOk], "/_auth/login": [{ status: 401, body: { error: "パスキーを確かめられませんでした" } }] });
  expect(refusedLogin).toMatchObject({ ok: false, sent: ["api/restart", "/_auth/challenge", "/_auth/login"], error: "パスキーを確かめられませんでした" });
  // once only: a second 401 recent is shown, not checked again
  const again = await runAct({ "api/restart": [needsCheck, needsCheck], "/_auth/challenge": [challengeOk], "/_auth/login": [{ status: 200 }] });
  expect(again).toMatchObject({ ok: false, sent: ["api/restart", "/_auth/challenge", "/_auth/login", "api/restart"], error: "操作の前にパスキーで確かめてください" });
  // the token's answers never ask for a check
  expect(await runAct({ "api/restart": [{ status: 202 }], "/_auth/renew": [{ status: 200 }] })).toMatchObject({ ok: true, sent: ["api/restart", "/_auth/renew"], error: "" });
  expect((await runAct({ "api/restart": [{ status: 202 }] }, { lastError: "restart: failed later" })).error).toBe("restart: failed later"); // the service's own failure still shows
});

test("the token and loopback need no passkey check (#497)", async () => {
  await onCloud(async (url) => {
    expect((await fetch(`${url}/api/restart`, { method: "POST", headers: { authorization: "Bearer sb_secret" } })).status).toBe(202);
    await until(async () => ((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } }).then((r) => r.json())) as { busy: string | null }).busy === null, "restart finished");
  });
  expect((await post("/api/agent/stop")).status).toBe(200); // loopback
});

test("作り直す saves the runners' records first (#403): the Starter is asked only after the save command succeeded", async () => {
  const seen: string[] = [];
  const edges: Array<string | null> = [];
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), edges.push(req.headers.get("x-switchboard-edge")), Response.json({}, { status: 202 })) });
  const marker = join(f.root, "saved");
  const ok = startRescue(ctx, { port: 0, edge: "edge-xyz", starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: ["sh", "-c", `echo saved > '${marker}'`] });
  const bad = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: ["sh", "-c", "echo 'upload failed: no network' >&2; exit 3"] });
  try {
    const r = await fetch(`http://127.0.0.1:${ok.server.port}/api/rebuild`, { method: "POST" });
    expect(r.status).toBe(202);
    expect(readFileSync(marker, "utf8")).toBe("saved\n");
    expect(seen).toEqual(["/rebuild"]);
    expect(edges).toEqual(["edge-xyz"]); // the Starter refuses a call without CloudFront's shared header (#1493)
    // the save failed: no rebuild, and the page shows why
    const b = await fetch(`http://127.0.0.1:${bad.server.port}/api/rebuild`, { method: "POST" });
    expect(b.status).toBe(424); // not 502: CloudFront would show the start page instead of the reason
    const body = (await b.json()) as { error: string };
    expect(body.error).toContain("not rebuilding");
    expect(body.error).toContain("upload failed: no network");
    expect(seen).toEqual(["/rebuild"]);
    // the reason stays in the status the page re-reads every 2 s, instead of being wiped by the next render (review #405)
    const st = (await fetch(`http://127.0.0.1:${bad.server.port}/api/status`).then((x) => x.json())) as { lastError: string | null };
    expect(st.lastError).toContain("作り直す: the runners' records were not saved");
    // and the page gives the button back on a refusal by the answer, not by the error text the next render clears
    const html = readFileSync(join(import.meta.dir, "page.html"), "utf8");
    expect(html).toContain("if (sent !== true) { rebuilding = false;");
  } finally {
    await ok.stop();
    await bad.stop();
    await starter.stop(true);
  }
});

test("作り直す pressed again after a refusal does not show the last reason while the new save runs (#409)", async () => {
  const seen: string[] = [];
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), Response.json({}, { status: 202 })) });
  const once = join(f.root, "refused-once");
  // the first save fails; the next one takes a while, as a real upload does
  const r1 = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: ["sh", "-c", `if [ -e '${once}' ]; then sleep 1; else touch '${once}'; echo 'no network' >&2; exit 3; fi`] });
  const url = `http://127.0.0.1:${r1.server.port}`;
  const lastError = async () => ((await fetch(`${url}/api/status`).then((x) => x.json())) as { lastError: string | null }).lastError;
  try {
    expect((await fetch(`${url}/api/rebuild`, { method: "POST" })).status).toBe(424);
    expect(await lastError()).toContain("not rebuilding");
    const again = fetch(`${url}/api/rebuild`, { method: "POST" });
    await Bun.sleep(300); // the second save is still running
    expect(await lastError()).toBeNull();
    expect((await again).status).toBe(202);
    expect(seen).toEqual(["/rebuild"]);
  } finally {
    await r1.stop();
    await starter.stop(true);
  }
});

test("作り直す's save has a time limit and a missing command is a reason, not a 500 (review #405: CloudFront cuts at 30 s)", async () => {
  const seen: string[] = [];
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), Response.json({}, { status: 202 })) });
  const slow = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: ["sleep", "30"], beforeRebuildLimitMs: 300 });
  const missing = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: [join(f.root, "no-such-command")] });
  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${slow.server.port}/api/rebuild`, { method: "POST" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.status).toBe(424);
    expect(((await r.json()) as { error: string }).error).toContain("did not finish within");
    const m = await fetch(`http://127.0.0.1:${missing.server.port}/api/rebuild`, { method: "POST" });
    expect(m.status).toBe(424);
    expect(((await m.json()) as { error: string }).error).toContain("not rebuilding");
    expect(seen).toEqual([]);
  } finally {
    await slow.stop();
    await missing.stop();
    await starter.stop(true);
  }
});

test("作り直す answers at the limit even when the save's own children keep its stderr open (review #405: aws under bash)", async () => {
  const seen: string[] = [];
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), Response.json({}, { status: 202 })) });
  const r1 = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}`, token: "t" }, beforeRebuild: ["bash", "-c", "sleep 5; true"], beforeRebuildLimitMs: 300 });
  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${r1.server.port}/api/rebuild`, { method: "POST" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.status).toBe(424);
    expect(seen).toEqual([]);
  } finally {
    await r1.stop();
    await starter.stop(true);
  }
});

test("作り直す (#181): off without a Starter; with one, the rescue page asks it to rebuild with the start token", async () => {
  expect((await fetch(`${base}/api/status`).then((r) => r.json()) as { rebuild: boolean }).rebuild).toBe(false);
  expect((await post("/api/rebuild")).status).toBe(404);

  const seen: Array<{ path: string; token: string | null }> = [];
  let answer = 202;
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push({ path: new URL(req.url).pathname, token: req.headers.get("x-switchboard-start-token") }), Response.json({}, { status: answer })) });
  const cloud = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}/`, token: "start-tok" } });
  const cb = `http://127.0.0.1:${cloud.server.port}`;
  try {
    expect((await fetch(`${cb}/api/status`).then((r) => r.json()) as { rebuild: boolean }).rebuild).toBe(true);
    const r = await fetch(`${cb}/api/rebuild`, { method: "POST" });
    expect(r.status).toBe(202);
    expect(seen).toEqual([{ path: "/rebuild", token: "start-tok" }]);
    expect((await status()).history[0]).toMatchObject({ action: "rebuild", ok: true });
    answer = 403;
    expect((await fetch(`${cb}/api/rebuild`, { method: "POST" })).status).toBe(424); // the reason reaches the page (not 502)
  } finally {
    await cloud.stop();
    await starter.stop(true);
  }
});

test("without SWITCHBOARD_RESCUE_RESTART_BY_EXIT the restart keeps sb-rescue and restarts the daemon alone", async () => {
  expect(((await fetch(`${base}/api/status`).then((r) => r.json())) as { restartReloads: boolean }).restartReloads).toBe(false);
  expect((await post("/api/restart")).status).toBe(202);
  await until(async () => (await status()).busy === null, "restart finished");
  expect((await status()).state).toBe("running"); // the same sb-rescue answers, its daemon up again
  expect(((await status()).history[0] as { reason?: string }).reason).toBe("restarted from the rescue page");
});

test("with SWITCHBOARD_RESCUE_RESTART_BY_EXIT the restart ends sb-rescue, and the next start hands the daemon the new environment (#435)", async () => {
  const g = await makeRepo();
  await buildRelease(g.repo, "HEAD", g.home);
  switchTo(g.home, g.v1);
  const [port, rescuePort] = [await freePort(), await freePort()];
  const envFile = join(g.root, "switchboard.env");
  const env = (web: string) =>
    writeFileSync(envFile, `SWITCHBOARD_REPO_ROOT=${g.repo}\nSWITCHBOARD_HOME=${g.home}\nSWITCHBOARD_PORT=${port}\nSWITCHBOARD_RESCUE_PORT=${rescuePort}\nSWITCHBOARD_RESCUE_RESTART_BY_EXIT=1\nSWITCHBOARD_WEB_URL=${web}\nSWITCHBOARD_STARTER_TOKEN=tok\n`);
  env("https://old.example");
  // systemd's part: read the EnvironmentFile and start sb-rescue again whenever it ends
  const loop = `trap 'kill $pid 2>/dev/null; wait $pid; exit 0' TERM; while :; do set -a; . "$1"; set +a; ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "main.ts"))} & pid=$!; wait $pid; echo "exit $?" >> "$2"; done`;
  const exits = join(g.root, "exits");
  // nothing from this process's environment (on the cloud host it has SWITCHBOARD_RESCUE_HOST=0.0.0.0): only the file
  const proc = Bun.spawn(["bash", "-c", loop, "_", envFile, exits], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: g.root }, stdout: "ignore", stderr: "ignore" });
  type Health = { version: string; webUrl: string | null; starterToken: string | null };
  const daemon = () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => (r.ok ? (r.json() as Promise<Health>) : null));
  try {
    expect((await until(daemon, "daemon up", 30_000)).webUrl).toBe("https://old.example");
    const st = (await until(() => fetch(`http://127.0.0.1:${rescuePort}/api/status`).then((r) => r.json() as Promise<{ restartReloads: boolean }>), "sb-rescue up"));
    expect(st.restartReloads).toBe(true);
    env("https://new.example");
    expect((await fetch(`http://127.0.0.1:${rescuePort}/api/restart`, { method: "POST" })).status).toBe(202);
    await until(() => existsSync(exits) && readFileSync(exits, "utf8").includes("exit 75"), "sb-rescue ended with 75", 30_000);
    const after = await until(async () => ((await daemon())?.webUrl === "https://new.example" ? daemon() : null), "daemon with the new environment", 30_000);
    expect(after!.starterToken).toBeNull(); // the start token still stays with sb-rescue
    expect(readFileSync(join(g.home, "releases", "history.jsonl"), "utf8")).toContain("the environment and the host scripts are read again (#435)");
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(g.root, { recursive: true, force: true });
  }
}, 90_000);

test("the status lists the running and waiting tasks a restart would stop, and nothing for done ones (#435)", async () => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  const seen: (string | null)[] = [];
  const tasks = [
    { id: "t1", title: "走っている <b>Task</b>", status: "running" },
    { id: "t2", title: "承認を待つ Task", status: "waiting" },
    { id: "t3", title: "終わった Task", status: "done" },
  ];
  const daemon = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(req.headers.get("authorization")), new URL(req.url).pathname === "/api/tasks" ? Response.json(tasks) : new Response("", { status: 404 })) });
  const r = startRescue({ ...ctx, port: daemon.port as number }, { port: 0 });
  try {
    const s = (await fetch(`http://127.0.0.1:${r.server.port}/api/status`).then((x) => x.json())) as { stopping: unknown };
    expect(s.stopping).toEqual([
      { id: "t1", title: "走っている <b>Task</b>", status: "running" },
      { id: "t2", title: "承認を待つ Task", status: "waiting" },
    ]);
    expect(seen).toContain("Bearer sb_secret"); // the daemon's token, as checkDaemon sends it
  } finally {
    rmSync(join(f.home, "token"), { force: true });
    await r.stop();
    await daemon.stop(true);
  }
});

test("a daemon that does not answer gives an empty list, not an error", async () => {
  const r = startRescue({ ...ctx, port: await freePort() }, { port: 0 });
  const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ not: "a list" }) });
  const r2 = startRescue({ ...ctx, port: odd.port as number }, { port: 0 });
  try {
    const s = await fetch(`http://127.0.0.1:${r.server.port}/api/status`);
    expect(s.status).toBe(200);
    expect(((await s.json()) as { stopping: unknown }).stopping).toEqual([]);
    expect(((await fetch(`http://127.0.0.1:${r2.server.port}/api/status`).then((x) => x.json())) as { stopping: unknown }).stopping).toEqual([]);
  } finally {
    await r.stop();
    await r2.stop();
    await odd.stop(true);
  }
});

test("tmp: sweep — without a press, the old working directory goes on the interval and GET /api/tmp says so (#1720); another app's kind only where /tmp is Switchboard's (#2058); local CI's leftovers everywhere, the caches and docker only there, and the root disk's usage (#2549)", async () => {
  type Sweep = { at: number; removed: number; freedBytes: number };
  type Answer = { owned: boolean; disk: { used: number; total: number; percent: number }; sweeps: Record<"tmp" | "work" | "cache" | "docker", Sweep | null> };
  const before = (await fetch(`${base}/api/tmp`).then((r) => r.json())) as Answer & { sweep?: unknown };
  expect(before.sweeps).toEqual({ tmp: null, work: null, cache: null, docker: null }); // this server has the default 30 minutes
  expect(before.sweep).toBeUndefined();
  expect(before.owned).toBe(false);
  expect(before.disk.total).toBeGreaterThan(0);
  expect(before.disk.used).toBeLessThanOrEqual(before.disk.total);
  const root = mkdtempSync(join(tmpdir(), "sb-rescue-sweep-"));
  const home = mkdtempSync(join(tmpdir(), "sb-rescue-sweep-home-"));
  const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000;
  const stale = (dir: string, name: string, at = old) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "f"), "x".repeat(4096));
    utimesSync(join(dir, name, "f"), at, at);
    utimesSync(join(dir, name), at, at);
  };
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  const twoWeeksAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
  const docker: string[][] = [];
  const sweepOnce = async (tmpOwned: boolean) => {
    // one sweep walks /proc and blocks the loop: 100+ ms on a busy host, over 1 s under a full local CI (#2200). With an
    // interval well over that (and over the 50 ms polling) the first sweep's answer is read before a later, empty one
    // replaces it (#1939)
    const dockerSh = async (argv: string[]) => (docker.push(argv), "Deleted Images:\ndeleted: sha256:aaa\n\nTotal reclaimed space: 2kB\n");
    const fast = startRescue(ctx, { port: 0, tmpDir: root, cacheDir: join(home, ".cache"), home, dockerSh, tmpSweepMs: 4000, tmpOwned });
    try {
      const get = () => fetch(`http://127.0.0.1:${fast.server.port}/api/tmp`).then((r) => r.json()) as Promise<Answer>;
      return await until(async () => {
        const r = await get();
        return r.sweeps.work && (!tmpOwned || r.sweeps.docker) ? r : null; // the kinds are filled in turn
      }, "the sweep ran");
    } finally {
      await fast.stop();
    }
  };
  try {
    stale(root, "x.review3.Ab12Cd");
    stale(root, "switchboard.flow.Ab12Cd");
    mkdirSync(join(root, "switchboard.flow.Zz98Yy"));
    stale(join(home, ".cache"), "switchboard.local-ci-12.Ab12Cd", dayAgo);
    stale(join(home, ".cache"), "switchboard.local-ci-13.Ab12Cd", dayAgo);
    stale(join(home, ".cache/uv/archive-v0"), "old1", twoWeeksAgo);
    const shared = await sweepOnce(false);
    expect(readdirSync(root).sort()).toEqual(["switchboard.flow.Ab12Cd", "switchboard.flow.Zz98Yy"]);
    expect(shared.sweeps.tmp!.removed).toBe(1);
    expect(shared.sweeps.tmp!.freedBytes).toBeGreaterThan(0);
    expect(shared.sweeps.work!.removed).toBe(2);
    expect(shared.sweeps.cache).toBeNull();
    expect(shared.sweeps.docker).toBeNull();
    expect(docker).toEqual([]);
    expect(readdirSync(join(home, ".cache/uv/archive-v0"))).toEqual(["old1"]);
    expect(shared.owned).toBe(false);
    const owned = await sweepOnce(true);
    expect(readdirSync(root)).toEqual(["switchboard.flow.Zz98Yy"]);
    expect(owned.sweeps.tmp!.removed).toBe(1);
    expect(owned.sweeps.work!.removed).toBe(0);
    expect(owned.sweeps.cache!.removed).toBe(1);
    expect(readdirSync(join(home, ".cache/uv/archive-v0"))).toEqual([]);
    expect(owned.sweeps.docker).toMatchObject({ removed: 1, freedBytes: 2000 });
    expect(docker[0]).toEqual(["docker", "image", "prune", "-a", "-f", "--filter", "until=24h"]);
    expect(owned.owned).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000); // two sweeps in turn, each after a 4 s interval: over bun's 5 s (#2200)

test("tmp: GET /api/tmp shows the usage and the entries; POST /api/tmp/clean removes only the old working directory (#797)", async () => {
  const r = (await fetch(`${base}/api/tmp`).then((r) => r.json())) as { usage: { total: number; percent: number }; entries: Array<{ name: string; removable: boolean }>; cleanable: { names: string[]; bytes: number } };
  expect(r.usage.total).toBeGreaterThan(0);
  expect(r.usage.percent).toBeGreaterThanOrEqual(0);
  expect(r.usage.percent).toBeLessThanOrEqual(100);
  expect(r.entries.map((e) => e.name).sort()).toEqual([OLD_DIR, NEW_DIR]);
  expect(r.cleanable.names).toEqual([OLD_DIR]);
  expect((await post("/api/tmp/clean", {})).status).toBe(400);
  expect((await post("/api/tmp/clean", { names: [1] })).status).toBe(400);
  const cleaned = await post("/api/tmp/clean", { names: [OLD_DIR, NEW_DIR, "../etc"] });
  expect(cleaned.status).toBe(200);
  expect(await cleaned.json()).toMatchObject({ removed: [OLD_DIR], skipped: [{ name: NEW_DIR, keep: "recent" }, { name: "../etc", keep: "name" }] });
  expect(readdirSync(tmpRoot)).toEqual([NEW_DIR]);
  oldDir(); // back for the tests that follow
});
