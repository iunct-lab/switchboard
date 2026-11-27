// test-reads: rescue/src/ rescue/install.ts rescue/package.json packages/core/src/promotion-log.ts
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { snapshotNeeds, type Ctx } from "./promote.ts";
import { buildRelease, currentOf, listReleases, readHistory, run, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
import { DISK_FLOOR_BYTES, sweepTmp } from "./tmp.ts";
import { Supervisor } from "./supervisor.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
let ctx: Ctx;
let v2: string;
let rescue: ReturnType<typeof startRescue>;
let base: string;
/** A fake /tmp: one old working directory that may go, one new one that may not. */
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
  ctx = { home: f.home, repo: f.repo, source: null, port, sup: new Supervisor({ home: f.home, repo: f.repo, port, backoffMs: 50 }) };
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
  expect(specifiers.filter((s) => !/: (\.\/(src\/)?[\w.-]+|node:[\w/]+|bun:[\w]+|bun)$/.test(s))).toEqual([]);
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
  expect(html).toContain("強制クリア"); // the /tmp section
  expect(html).toContain("api/tmp/clean");
  expect(html).toContain('id="core-row"'); // the core line, shown only when it differs from the current version
  expect(html).toContain("昇格した（再起動なし）");
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

test("ifNoRestart: a release that needs a restart is refused with 409 before anything is built; status says the question is understood", async () => {
  expect((await fetch(`${base}/api/status`).then((r) => r.json()) as { promoteWithoutRestart?: boolean }).promoteWithoutRestart).toBe(true);
  // the mark the daemon needs before it asks `ifNoRestart` under running tasks: such a request never ends in a restart
  expect((await fetch(`${base}/api/status`).then((r) => r.json()) as { promoteKeepsTasks?: boolean }).promoteKeepsTasks).toBe(true);
  const core = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v3"), "third version (core)");
  const built = listReleases(f.home).sort();
  const r = await post("/api/promote", { commit: core, ifNoRestart: true });
  expect([r.status, await r.json()]).toEqual([409, { error: "this release needs a restart", restart: true, files: ["packages/core/src/main.ts"], fileCount: 1 }]);
  expect([listReleases(f.home).sort(), (await status()).busy]).toEqual([built, null]);
});

test("ifNoRestart refused: the answer names the files that need the restart, and the daemon's reader takes exactly those", async () => {
  // Switchboard's own reader of the answer, loaded by a computed path: the bundle itself shares no code with it (the test above)
  const { refusedFiles } = (await import(join(import.meta.dir, "..", "..", "packages", "core", "src", "promotion-log.ts"))) as typeof import("../../packages/core/src/promotion-log.ts");
  const running = ctx.sup.running!;
  for (const n of [1, 2, 3, 4, 5, 6]) await commitFile(f.repo, `scripts/named-${n}.ts`, `export const n = ${n};\n`, `file ${n}`);
  await commitFile(f.repo, "packages/core/src/main.ts", `${daemonSource("v3")}\n// named\n`, "a file the daemon reads");
  const sha = await commitFile(f.repo, "apps/web/src/only-the-ui.ts", "export const ui = 1;\n", "a Web UI file");
  const differ = (await run(["git", "-C", f.repo, "diff", "--name-only", "-z", "--no-renames", running, sha], f.repo, true)).split("\0").filter(Boolean);
  const needs = differ.filter((x) => !x.startsWith("apps/web/"));
  expect(needs).toContain("packages/core/src/main.ts");
  expect(needs.length).toBeGreaterThanOrEqual(7); // the seven above, and what earlier tests changed when the file runs whole
  const r = await post("/api/promote", { commit: sha, ifNoRestart: true });
  const body = (await r.json()) as { restart: boolean; files: string[]; fileCount: number };
  expect([r.status, body.restart]).toEqual([409, true]);
  // the daemon's own reader, on the real answer
  expect(refusedFiles(body)).toEqual({ files: needs.slice(0, 5), fileCount: needs.length });
  expect(body.files.some((x) => x.startsWith("apps/web/"))).toBe(false);
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

test("a spoofed Host on loopback is refused before anything runs", async () => {
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
 * The Starter's side (aws/auth.ts): an Ed25519 seed signs, sb-rescue holds only the public key. A test names a key
 * by a label; its seed is the label's SHA-256.
 */
const privateOf = (label: string) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(label).digest()]), format: "der", type: "pkcs8" });
const publicOf = (label: string) => createPublicKey(privateOf(label)).export({ format: "jwk" }).x!;
/** A stand-in for the Starter's GET /_auth/status: `loggedIn` (or a 500) as set. */
const authStarter = { answer: true as boolean | 500, asked: 0, edge: null as string | null };
const authStarterServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (authStarter.asked++, (authStarter.edge = req.headers.get("x-switchboard-edge")), authStarter.answer === 500 ? new Response("", { status: 500 }) : Response.json({ loggedIn: authStarter.answer })) });
afterAll(() => void authStarterServer.stop(true));
const cloudLogin = (label: string) => ({ sessionPublicKey: publicOf(label), starter: { url: `http://127.0.0.1:${authStarterServer.port}`, token: "t" } });

test("the cloud host's login cookie opens the page and the API off loopback; an expired, foreign-key or host-forged one does not", async () => {
  const key = "k".repeat(64);
  const cookie = (k: string, expires: number, idleUntil = expires) => {
    const body = Buffer.from(`pk1.${idleUntil}.${expires}`).toString("base64url");
    return `sb_session=${body}.${sign(null, Buffer.from(body), privateOf(k)).toString("base64url")}`;
  };
  // what a process on the host could make: an HMAC keyed with the only value it has, the public key
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
    // past the cap even with idle time left, past the idle time within the cap, idle beyond the cap, and the old two-field body
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

/** The Starter's cookies (aws/auth.ts): sb_session, and sb_recent signed over "recent:" + body. */
const signed = (name: string, k: string, id: string, times: number[], prefix = "") => {
  const body = Buffer.from([id, ...times].join(".")).toString("base64url");
  return `${name}=${body}.${sign(null, Buffer.from(prefix + body), privateOf(k)).toString("base64url")}`;
};
const session = (k: string, expires = Date.now() + 60_000, id = "pk1", idleUntil = expires) => signed("sb_session", k, id, [idleUntil, expires]);
const recent = (k: string, expires = Date.now() + 60_000, id = "pk1") => signed("sb_recent", k, id, [expires], "recent:");
test("sb-rescue refuses a removed passkey's cookie within SESSION_RECHECK_MS", async () => {
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

test("sb-rescue on the cloud host refuses the token from off the machine, keeps it on loopback", async () => {
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
/** The bodies each POST is tried with: /tmp's clean in all three of its forms. */
const BODIES: Record<string, unknown[]> = { "/api/tmp/clean": [{ names: [OLD_DIR] }, { names: [OLD_DIR], staleMs: 30 * 60 * 1000 }, { force: true }] };
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

test("with the login cookie, every state-changing POST needs a passkey check within 5 minutes; status and the page do not", async () => {
  const key = "k".repeat(64);
  await onCloud(async (url) => {
    const cookie = session(key);
    for (const path of CHANGES) {
      for (const body of BODIES[path] ?? [{}]) {
        const r = await fetch(`${url}${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
        expect(r.status).toBe(401);
        expect(await r.json()).toMatchObject({ reason: "recent" });
      }
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

test("a recent cookie that is expired, signed with another key, is a session value, or names another passkey is refused", async () => {
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
function loadPage(answers: Record<string, Array<{ status: number; body?: unknown }>>, o: { credential?: unknown; lastError?: string | null; hostname?: string; stop?: boolean; current?: string | null; running?: string | null } = {}) {
  const html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const src = html.slice(html.indexOf("const short ="), html.indexOf('$("restart").onclick')) + html.slice(html.indexOf("var stopPressed"), html.indexOf('$("agent-start").onclick'));
  const sent: string[] = [];
  const el = () => ({ textContent: "", value: "", hidden: true, disabled: false, onclick: null as null | (() => Promise<void>), replaceChildren() {}, append() {} });
  const els = new Map<string, ReturnType<typeof el>>();
  const $ = (id: string) => els.get(id) ?? (els.set(id, el()), els.get(id)!);
  const status = { current: o.current ?? null, running: o.running ?? null, previous: null, releases: [], snapshots: [], history: [], log: [], busy: null, lastError: o.lastError ?? null, unhealthy: null, port: 1, state: "running", rebuild: false, stop: o.stop ?? false, agent: { running: false, exitCode: null, output: "" } };
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
  return { page, $, sent };
}
async function runAct(answers: Parameters<typeof loadPage>[0], o: Parameters<typeof loadPage>[1] = {}) {
  const { page, $, sent } = loadPage(answers, o);
  const ok = await page.act("api/restart", {}, "?");
  await page.refresh(); // the next 2 s refresh
  return { ok, sent, error: $("error").textContent };
}
test("after a change that went through, the page asks the Starter to renew the login once per 10 minutes, off loopback only", async () => {
  const cloud = await runAct({ "api/restart": [{ status: 202 }], "/_auth/renew": [{ status: 200 }] });
  expect(cloud).toMatchObject({ ok: true, sent: ["api/restart", "/_auth/renew"] });
  const refused = await runAct({ "api/restart": [{ status: 500, body: { error: "x" } }] });
  expect(refused.sent).toEqual(["api/restart"]);
  const local = await runAct({ "api/restart": [{ status: 202 }] }, { hostname: "127.0.0.1" });
  expect(local.sent).toEqual(["api/restart"]);
});
test("the core line shows only when the daemon runs from another version than the current one (a web-only promotion)", async () => {
  const shown = async (o: Parameters<typeof loadPage>[1]) => {
    const { page, $ } = loadPage({}, o);
    await page.refresh();
    return { hidden: $("core-row").hidden, running: $("running").textContent, label: $("current-label").textContent };
  };
  expect((await shown({ current: "a".repeat(40), running: "b".repeat(40) })).hidden).toBe(false);
  expect((await shown({ current: "a".repeat(40), running: "b".repeat(40) })).running).toContain("bbbbbbb");
  expect((await shown({ current: "a".repeat(40), running: "b".repeat(40) })).label).toBe("再起動なしで入った版"); // the current version then went in without a restart
  expect((await shown({ current: "a".repeat(40), running: "a".repeat(40) })).hidden).toBe(true);
  expect((await shown({ current: "a".repeat(40), running: "a".repeat(40) })).label).toBe("今の版");
  expect((await shown({ current: "a".repeat(40), running: null })).hidden).toBe(true);
});
const needsCheck = { status: 401, body: { error: "操作の前にパスキーで確かめてください", reason: "recent" } };
const challengeOk = { status: 200, body: { challenge: "AAAA", rpId: "d111.cloudfront.net" } };

test("the page checks the passkey on 401 recent and sends the same request once more; a failed or cancelled check sends nothing more and stays on the page", async () => {
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

test("停止する shows only with a Starter: the status says so and the page hides the row without it", async () => {
  const off = loadPage({}, { stop: false });
  await off.page.refresh();
  expect(off.$("stop-row").hidden).toBe(true);
  const on = loadPage({}, { stop: true });
  await on.page.refresh();
  expect(on.$("stop-row").hidden).toBe(false);
});

test("停止する posts /_auth/stop after a passkey check when asked for one, then says how to come back and stays pressed", async () => {
  const { $, page, sent } = loadPage({ "/_auth/stop": [needsCheck, { status: 202 }], "/_auth/challenge": [challengeOk], "/_auth/login": [{ status: 200 }] }, { stop: true });
  await page.refresh();
  expect($("stop-sent").hidden).toBe(true);
  await $("stop").onclick!();
  expect(sent).toEqual(["/_auth/stop", "/_auth/challenge", "/_auth/login", "/_auth/stop"]); // no renew: the login was just signed
  expect($("stop-sent").hidden).toBe(false);
  await page.refresh(); // the machine is going down: a second press would only answer 409
  expect($("stop").disabled).toBe(true);
  await $("stop").onclick!();
  expect(sent.filter((p) => p === "/_auth/stop")).toHaveLength(2);
  const html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  expect(html.slice(html.indexOf('id="stop-sent"'))).toContain('停止しています。止まったら <a href="/_auth/">/_auth/</a> の 起動する で戻せます');
});

test("停止する refused: the answer's error shows and the button is pressable again", async () => {
  const { $, page, sent } = loadPage({ "/_auth/stop": [{ status: 409, body: { error: "the machine is stopping", reason: "stopping" } }] }, { stop: true });
  await page.refresh();
  await $("stop").onclick!();
  expect(sent).toEqual(["/_auth/stop"]);
  expect($("error").textContent).toBe("the machine is stopping");
  expect($("stop-sent").hidden).toBe(true);
  await page.refresh();
  expect($("error").textContent).toBe("the machine is stopping");
  expect($("stop").disabled).toBe(false);
});

test("the token and loopback need no passkey check", async () => {
  await onCloud(async (url) => {
    expect((await fetch(`${url}/api/restart`, { method: "POST", headers: { authorization: "Bearer sb_secret" } })).status).toBe(202);
    await until(async () => ((await fetch(`${url}/api/status`, { headers: { authorization: "Bearer sb_secret" } }).then((r) => r.json())) as { busy: string | null }).busy === null, "restart finished");
  });
  expect((await post("/api/agent/stop")).status).toBe(200); // loopback
});

test("作り直す saves the runners' records first: the Starter is asked only after the save command succeeded", async () => {
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
    expect(edges).toEqual(["edge-xyz"]); // the Starter refuses a call without CloudFront's shared header
    // the save failed: no rebuild, and the page shows why
    const b = await fetch(`http://127.0.0.1:${bad.server.port}/api/rebuild`, { method: "POST" });
    expect(b.status).toBe(424); // not 502: CloudFront would show the start page instead of the reason
    const body = (await b.json()) as { error: string };
    expect(body.error).toContain("not rebuilding");
    expect(body.error).toContain("upload failed: no network");
    expect(seen).toEqual(["/rebuild"]);
    // the reason stays in the status the page re-reads every 2 s, instead of being wiped by the next render
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

test("作り直す pressed again after a refusal does not show the last reason while the new save runs", async () => {
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

test("作り直す's save has a time limit and a missing command is a reason, not a 500 (CloudFront cuts at 30 s)", async () => {
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

test("作り直す answers at the limit even when the save's own children keep its stderr open (aws under bash)", async () => {
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

test("作り直す: off without a Starter; with one, the rescue page asks it to rebuild with the start token", async () => {
  expect(await fetch(`${base}/api/status`).then((r) => r.json())).toMatchObject({ rebuild: false, stop: false });
  expect((await post("/api/rebuild")).status).toBe(404);

  const seen: Array<{ path: string; token: string | null }> = [];
  let answer = 202;
  const starter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push({ path: new URL(req.url).pathname, token: req.headers.get("x-switchboard-start-token") }), Response.json({}, { status: answer })) });
  const cloud = startRescue(ctx, { port: 0, starter: { url: `http://127.0.0.1:${starter.port}/`, token: "start-tok" } });
  const cb = `http://127.0.0.1:${cloud.server.port}`;
  try {
    expect(await fetch(`${cb}/api/status`).then((r) => r.json())).toMatchObject({ rebuild: true, stop: true });
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

test("with SWITCHBOARD_RESCUE_RESTART_BY_EXIT the restart ends sb-rescue, and the next start hands the daemon the new environment", async () => {
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
    expect(readFileSync(join(g.home, "releases", "history.jsonl"), "utf8")).toContain("the environment and the host scripts are read again");
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(g.root, { recursive: true, force: true });
  }
}, 90_000);

test("the status lists the running and waiting tasks a restart would stop, and nothing for done ones, from the health and not the task list", async () => {
  writeFileSync(join(f.home, "token"), "sb_secret\n");
  const seen: (string | null)[] = [];
  const asked: string[] = [];
  const busyTasks = [
    { id: "t1", title: "走っている <b>Task</b>", status: "running" },
    { id: "t2", title: "承認を待つ Task", status: "waiting" },
    { id: "t4", title: "裏で動く Task", status: "background" },
    { id: "t3", title: "終わった Task", status: "done" }, // a daemon's answer is not trusted as is
  ];
  const daemon = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => {
      const path = new URL(req.url).pathname;
      seen.push(req.headers.get("authorization"));
      asked.push(`${req.method} ${path}`);
      if (path === "/api/health") return Response.json({ ok: true, busyTasks });
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
      return Response.json([]);
    },
    websocket: { message() {} },
  });
  const r = startRescue({ ...ctx, port: daemon.port as number }, { port: 0 });
  try {
    const s = (await fetch(`http://127.0.0.1:${r.server.port}/api/status`).then((x) => x.json())) as { stopping: unknown };
    expect(s.stopping).toEqual([
      { id: "t1", title: "走っている <b>Task</b>", status: "running" },
      { id: "t2", title: "承認を待つ Task", status: "waiting" },
      { id: "t4", title: "裏で動く Task", status: "background" },
    ]);
    expect(seen).toContain("Bearer sb_secret"); // the daemon's token, as checkDaemon sends it
    expect(asked).toContain("GET /api/health");
    expect(asked.filter((a) => a === "GET /api/tasks")).toEqual([]); // one status, not the whole task list
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

test("tmp: sweep — without a press, the old working directory goes on the interval and GET /api/tmp says so; another app's kind only where /tmp is Switchboard's; local CI's leftovers everywhere, the caches and docker only there, and the root disk's usage", async () => {
  type Sweep = { at: number; removed: number; freedBytes: number };
  type Answer = { owned: boolean; disk: { used: number; total: number; percent: number }; sweeps: Record<"tmp" | "work" | "cache" | "docker" | "reclaim", Sweep | null> };
  const before = (await fetch(`${base}/api/tmp`).then((r) => r.json())) as Answer & { sweep?: unknown };
  expect(before.sweeps).toEqual({ tmp: null, work: null, cache: null, docker: null, reclaim: null }); // this server has the default 30 minutes
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
    // one sweep walks /proc and blocks the loop: 100+ ms on a busy host, over 1 s under a full local CI. With an
    // interval well over that (and over the 50 ms polling) the first sweep's answer is read before a later, empty one
    // replaces it. 4 s was too close (ordering, a flake seen on a busy host): with /proc walks of 0.8 s a sweep outlasted it and the
    // second sweep's empty answer was read
    const dockerSh = async (argv: string[]) => (docker.push(argv), argv[2] === "ls" ? "" : "Deleted Images:\ndeleted: sha256:aaa\n\nTotal reclaimed space: 2kB\n"); // no stopped container
    const fast = startRescue(ctx, { port: 0, tmpDir: root, cacheDir: join(home, ".cache"), home, dockerSh, tmpSweepMs: 8000, tmpOwned });
    try {
      const get = () => fetch(`http://127.0.0.1:${fast.server.port}/api/tmp`).then((r) => r.json()) as Promise<Answer>;
      return await until(async () => {
        const r = await get();
        return r.sweeps.work && (!tmpOwned || r.sweeps.docker) ? r : null; // the kinds are filled in turn
      }, "the sweep ran", 20_000);
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
    expect(docker[0]).toEqual(["docker", "container", "ls", "-a", "--filter", "status=exited", "--format", "{{.ID}}"]);
    expect(docker[1]).toEqual(["docker", "image", "prune", "-a", "-f", "--filter", "until=24h"]);
    expect(owned.owned).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 50_000); // load (a flake seen on a busy host): two sweeps in turn, each allowed its 20 s wait; 21 s failed on the old 20 s limit (docs/design/perf.md "Test flakiness")

/** A Switchboard home (`<user home>/.switchboard`) with a database of some size, as the rescue reads the reserve from it. */
function reserveHome() {
  const user = mkdtempSync(join(tmpdir(), "sb-rescue-reserve-"));
  const sb = join(user, ".switchboard");
  mkdirSync(sb, { recursive: true });
  const db = new Database(join(sb, "switchboard.db"));
  db.exec("CREATE TABLE t (a TEXT)");
  for (let i = 0; i < 50; i++) db.query("INSERT INTO t VALUES (?)").run("x".repeat(2000));
  const reserve = snapshotNeeds(db);
  db.close();
  return { user, sb, reserve };
}

test("tmp: reserve — GET /api/tmp gives the reserve (what a snapshot of the database needs) and the target above it", async () => {
  const { user, sb, reserve } = reserveHome();
  const server = startRescue({ ...ctx, home: sb }, { port: 0, tmpDir: tmpRoot, cacheDir: join(user, ".cache"), home: user });
  try {
    const r = (await fetch(`http://127.0.0.1:${server.server.port}/api/tmp`).then((r) => r.json())) as { disk: { reserve: number; target: number } };
    expect(r.disk.reserve).toBe(reserve);
    expect(reserve).toBeGreaterThan(0);
    expect(r.disk.target).toBe(reserve + 1024 ** 3);
    expect(DISK_FLOOR_BYTES).toBe(1024 ** 3);
  } finally {
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
});

test("tmp: reserve — a database that cannot be read answers no reserve and no target, and GET /api/tmp still answers", async () => {
  const { user, sb } = reserveHome();
  writeFileSync(join(sb, "switchboard.db"), "not a database ".repeat(1000));
  const server = startRescue({ ...ctx, home: sb }, { port: 0, tmpDir: tmpRoot, cacheDir: join(user, ".cache"), home: user });
  try {
    const r = await fetch(`http://127.0.0.1:${server.server.port}/api/tmp`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { disk: { reserve: unknown; target: unknown } }).disk).toMatchObject({ reserve: null, target: null });
  } finally {
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
});

test("tmp: reserve — at the target or above it, the sweeps run and the reclaim does not", async () => {
  const { user, sb, reserve } = reserveHome();
  const docker: string[][] = [];
  const dockerSh = async (argv: string[]) => (docker.push(argv), "");
  const server = startRescue({ ...ctx, home: sb }, { port: 0, tmpDir: mkdtempSync(join(tmpdir(), "sb-rescue-reserve-tmp-")), cacheDir: join(user, ".cache"), home: user, dockerSh, tmpOwned: true, tmpSweepMs: 2000, diskFree: () => reserve + DISK_FLOOR_BYTES });
  try {
    const r = (await until(async () => {
      const a = (await fetch(`http://127.0.0.1:${server.server.port}/api/tmp`).then((r) => r.json())) as { sweeps: { docker: unknown; reclaim: unknown } };
      return a.sweeps.docker ? a : null;
    }, "the sweeps ran", 20_000)) as { sweeps: { reclaim: unknown } };
    expect(r.sweeps.reclaim).toBeNull();
    expect(docker.every((a) => a.includes("--filter"))).toBe(true); // only the age-based prune
  } finally {
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
}, 30_000);

test("tmp: reserve — short of the target while an operation runs (a promotion's build installs into the caches), the reclaim waits", async () => {
  const { user, sb, reserve } = reserveHome();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const sup = { restart: () => held, stop: async () => {} } as unknown as Ctx["sup"];
  const server = startRescue({ ...ctx, home: sb, sup }, { port: 0, tmpDir: mkdtempSync(join(tmpdir(), "sb-rescue-reserve-tmp-")), cacheDir: join(user, ".cache"), home: user, dockerSh: async () => "", tmpOwned: true, tmpSweepMs: 2000, diskFree: () => reserve });
  const url = `http://127.0.0.1:${server.server.port}`;
  try {
    expect((await fetch(`${url}/api/restart`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: "{}" })).status).toBe(202);
    const r = (await until(async () => {
      const a = (await fetch(`${url}/api/tmp`).then((r) => r.json())) as { sweeps: { docker: unknown; reclaim: unknown } };
      return a.sweeps.docker ? a : null;
    }, "the sweeps ran", 20_000)) as { sweeps: { reclaim: unknown } };
    expect(r.sweeps.reclaim).toBeNull();
  } finally {
    release();
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
}, 30_000);

test("tmp: sweep — the image prune fails while the container list answers: the docker row is not moved (no clean run shows)", async () => {
  const { user, sb } = reserveHome();
  let prunes = 0;
  const dockerSh = async (argv: string[]) => {
    if (argv[1] !== "image") return "";
    prunes++;
    throw new Error("docker image prune exited 1: fake failure");
  };
  const server = startRescue({ ...ctx, home: sb }, { port: 0, tmpDir: mkdtempSync(join(tmpdir(), "sb-rescue-row-tmp-")), cacheDir: join(user, ".cache"), home: user, dockerSh, tmpOwned: true, tmpSweepMs: 1000 });
  try {
    const a = (await until(async () => {
      const r = (await fetch(`http://127.0.0.1:${server.server.port}/api/tmp`).then((r) => r.json())) as { sweeps: { cache: unknown; docker: unknown } };
      return prunes >= 2 && r.sweeps.cache ? r : null; // two timer rounds, each with the cache row written
    }, "the sweeps ran", 20_000)) as { sweeps: { docker: unknown } };
    expect(a.sweeps.docker).toBeNull();
  } finally {
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
}, 30_000);

test("tmp: reserve — short of the target, one sweep takes back only what can be made again: the old uv entry goes; the one in use, the transcripts, the database, the snapshots, the releases and a Task's worktree stay", async () => {
  const { user, sb, reserve } = reserveHome();
  const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000; // past RECLAIM_STALE_MS
  const put = (dir: string, name: string, at = hourAgo) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "f"), "x".repeat(4096));
    utimesSync(join(dir, name, "f"), at, at);
    utimesSync(join(dir, name), at, at);
  };
  const uv = join(user, ".cache/uv/archive-v0");
  put(uv, "old1");
  put(uv, "busy1");
  mkdirSync(join(user, ".claude/projects/p"), { recursive: true });
  writeFileSync(join(user, ".claude/projects/p/s.jsonl"), "{}\n");
  mkdirSync(join(sb, "snapshots"), { recursive: true });
  writeFileSync(join(sb, "snapshots/2026-01-01-x.db.gz"), "snap");
  mkdirSync(join(sb, "releases/abc123"), { recursive: true });
  writeFileSync(join(sb, "releases/abc123/f"), "release");
  put(join(user, "repos"), "proj-topic");
  put(join(user, ".npm"), "_cacache"); // the npm cache goes too
  const busy = Bun.spawn(["sleep", "60"], { cwd: join(uv, "busy1") });
  const docker: string[][] = [];
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const dockerSh = async (argv: string[]) => {
    docker.push(argv);
    if (argv[2] === "ls") return "stale\nlately\n"; // two stopped containers
    if (argv[2] === "inspect") return argv[5] === "stale" ? hoursAgo(25) : hoursAgo(1);
    if (argv[2] === "rm") return argv[3]!;
    return "Deleted Images:\ndeleted: sha256:aaa\n\nTotal reclaimed space: 2kB\n";
  };
  const asked: number[] = [];
  // the free space is faked below the target; the reclaim, the sweeps and sb-rescue are the real ones
  const server = startRescue({ ...ctx, home: sb }, { port: 0, tmpDir: mkdtempSync(join(tmpdir(), "sb-rescue-reserve-tmp-")), cacheDir: join(user, ".cache"), home: user, dockerSh, tmpOwned: true, tmpSweepMs: 8000, diskFree: () => (asked.push(reserve), reserve + DISK_FLOOR_BYTES - 1) });
  try {
    const r = (await until(async () => {
      const a = (await fetch(`http://127.0.0.1:${server.server.port}/api/tmp`).then((r) => r.json())) as { sweeps: { reclaim: { removed: number } | null } };
      return a.sweeps.reclaim ? a : null;
    }, "the reclaim ran", 20_000)) as { sweeps: { reclaim: { removed: number } } };
    expect(asked.length).toBeGreaterThan(0);
    expect(r.sweeps.reclaim.removed).toBe(4); // old1, the npm cache, the container stopped 25 hours ago and the one docker image
    expect([...new Set(docker.filter((a) => a[2] === "rm").map((a) => a[3]))]).toEqual(["stale"]); // the one stopped an hour ago stays (the fake lists both on every pass)
    expect(existsSync(join(user, ".npm/_cacache"))).toBe(false);
    expect(readdirSync(uv)).toEqual(["busy1"]);
    expect(docker.at(-1)).toEqual(["docker", "image", "prune", "-a", "-f"]); // no age
    expect(readFileSync(join(user, ".claude/projects/p/s.jsonl"), "utf8")).toBe("{}\n");
    expect(existsSync(join(sb, "switchboard.db"))).toBe(true);
    expect(readdirSync(join(sb, "snapshots"))).toEqual(["2026-01-01-x.db.gz"]);
    expect(readdirSync(join(sb, "releases/abc123"))).toEqual(["f"]);
    expect(readdirSync(join(user, "repos/proj-topic"))).toEqual(["f"]);
  } finally {
    busy.kill();
    await busy.exited;
    await server.stop();
    rmSync(user, { recursive: true, force: true });
  }
}, 50_000);

test("tmp: GET /api/tmp shows the usage and the entries; POST /api/tmp/clean removes only the old working directory", async () => {
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
}, 30_000); // time assumption (a flake seen on a busy host): inUse walks the host's /proc on each read, over the 5 s default under load (6 s failed; docs/design/perf.md "Test flakiness")

test("tmp: the owner's press takes the age they pick and any name; force takes everything of theirs; the sweep's judgment stays its own", async () => {
  const at = (name: string, hoursAgo: number) => {
    mkdirSync(join(tmpRoot, name), { recursive: true });
    const t = (Date.now() - hoursAgo * 60 * 60 * 1000) / 1000;
    utimesSync(join(tmpRoot, name), t, t);
  };
  at("notes", 3); // no known kind
  at("hour", 1);
  type Answer = { staleMs: number; cleanable: { names: string[] }; forcible: { count: number; bytes: number } };
  const get = (q = "") => fetch(`${base}/api/tmp${q}`).then((r) => r.json()) as Promise<Answer>;
  try {
    const two = await get();
    expect(two.staleMs).toBe(2 * 60 * 60 * 1000);
    expect(two.cleanable.names.sort()).toEqual(["notes", OLD_DIR]);
    expect(two.forcible.count).toBe(4);
    expect((await get("?staleMs=1800000")).cleanable.names.sort()).toEqual(["hour", "notes", OLD_DIR]);
    expect((await get("?staleMs=1")).staleMs).toBe(2 * 60 * 60 * 1000); // not a choice: the default
    expect((await post("/api/tmp/clean", { names: ["hour"], staleMs: 1 })).status).toBe(400);
    expect(await post("/api/tmp/clean", { names: ["hour"] }).then((r) => r.json())).toMatchObject({ removed: [], skipped: [{ name: "hour", keep: "recent" }] });
    expect(await post("/api/tmp/clean", { names: ["hour"], staleMs: 30 * 60 * 1000 }).then((r) => r.json())).toMatchObject({ removed: ["hour"] });
    // after the presses, the sweep still takes only the old directory of a known kind
    expect(sweepTmp(tmpRoot, { owned: false }).removed).toBe(1);
    expect(readdirSync(tmpRoot).sort()).toEqual(["notes", NEW_DIR]);
    const forced = await post("/api/tmp/clean", { force: true, names: ["../etc"] }).then((r) => r.json());
    expect(forced).toMatchObject({ skipped: [] });
    expect((forced as { removed: string[] }).removed.sort()).toEqual(["notes", NEW_DIR]);
    expect(readdirSync(tmpRoot)).toEqual([]);
  } finally {
    for (const n of readdirSync(tmpRoot)) rmSync(join(tmpRoot, n), { recursive: true, force: true });
    oldDir(); // back for the tests that follow
    mkdirSync(join(tmpRoot, NEW_DIR));
  }
}, 30_000); // inUse walks the host's /proc on each read (see above)

/**
 * The page's disk section (loadTmp and its buttons) against fakes: GET /api/tmp answers per age, the status names the
 * running tasks, and confirm answers `yes`. What was posted, and what the confirm asked, are kept.
 */
async function loadTmpPage(o: { yes: boolean; stopping?: Array<{ title: string; status: string }> }) {
  const html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const src = html.slice(html.indexOf("const short ="), html.indexOf('$("restart").onclick')) + html.slice(html.indexOf("// the disk and /tmp"), html.indexOf("// Every 2 s while"));
  type El = { textContent: string; value: string; className: string; hidden: boolean; disabled: boolean; onclick: null | (() => Promise<void>); onchange: null | (() => Promise<void>); children: El[]; replaceChildren(...c: El[]): void; append(...c: El[]): void };
  const el = (): El => ({ textContent: "", value: "", className: "", hidden: true, disabled: false, onclick: null, onchange: null, children: [], replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); } });
  const els = new Map<string, ReturnType<typeof el>>();
  const $ = (id: string) => els.get(id) ?? (els.set(id, el()), els.get(id)!);
  $("tmp-age").value = "7200000";
  const status = { current: null, previous: null, releases: [], snapshots: [], history: [], log: [], busy: null, lastError: null, unhealthy: null, port: 1, state: "running", rebuild: false, stop: false, stopping: o.stopping ?? [], agent: { running: false, exitCode: null, output: "" } };
  const tmp = (age: number) => ({
    usage: { used: 1, total: 2, percent: 50 },
    disk: { used: 1, total: 2, percent: 50 },
    sweeps: { tmp: null, work: null, cache: null, docker: null },
    owned: true,
    staleMs: age,
    entries: [{ name: "new", bytes: 1024, newestMs: Date.now(), removable: false, keep: "recent" }],
    cleanable: age === 1800000 ? { names: ["a", "b", "c"], bytes: 3072 } : { names: ["a"], bytes: 1024 },
    forcible: { count: 5, bytes: 5 * 1024 * 1024 },
  });
  const posts: Array<{ path: string; body: unknown }> = [];
  const asked: string[] = [];
  const slow: Record<string, number> = { "1800000": 50 }; // the 30-minute read answers late
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "api/status") return Response.json(status);
    if (path.startsWith("api/tmp?staleMs=")) {
      const age = path.split("=")[1]!;
      await Bun.sleep(slow[age] ?? 0);
      return Response.json(tmp(Number(age)));
    }
    posts.push({ path, body: JSON.parse(init!.body!) });
    return Response.json({ removed: [], freedBytes: 0, skipped: [] });
  };
  const confirm = (q: string) => (asked.push(q), o.yes);
  const page = new Function("fetch", "confirm", "navigator", "$", "document", "headers", "rebuilding", "location", `${src}\nreturn { refresh, loadTmp };`)(fetch, confirm, {}, $, { createElement: el }, {}, false, { hostname: "127.0.0.1" }) as { refresh: () => Promise<void>; loadTmp: () => Promise<void> };
  await page.refresh();
  await page.loadTmp();
  return { $, posts, asked };
}

test("tmp page: the picked age changes the clean button's count and what it sends; the force clean's confirm names the running tasks, and a cancel posts nothing", async () => {
  const { $, posts, asked } = await loadTmpPage({ yes: true, stopping: [{ title: "PBI を進める", status: "running" }, { title: "レビュー", status: "waiting" }] });
  expect($("tmp-clean").textContent).toBe("2 時間以上更新の無いものを消す（1 件、合計 1.0 KB）");
  expect($("tmp-force").textContent).toBe("強制クリア（5 件、合計 5.0 MB）");
  expect($("tmp-list").children[0]!.children[1]!.textContent).toStartWith("2 時間以内に更新 · ");
  // changed twice quickly: the late 30-minute answer does not overwrite the 6-hour one
  $("tmp-age").value = "1800000";
  const late = $("tmp-age").onchange!();
  $("tmp-age").value = "21600000";
  await $("tmp-age").onchange!();
  await late;
  expect($("tmp-clean").textContent).toStartWith("6 時間以上更新の無いものを消す");
  expect($("tmp-list").children[0]!.children[1]!.textContent).toStartWith("6 時間以内に更新 · ");
  $("tmp-age").value = "1800000";
  await $("tmp-age").onchange!();
  expect($("tmp-clean").textContent).toBe("30 分以上更新の無いものを消す（3 件、合計 3.0 KB）");
  await $("tmp-clean").onclick!();
  expect(posts[0]).toEqual({ path: "api/tmp/clean", body: { names: ["a", "b", "c"], staleMs: 1800000 } });
  await $("tmp-force").onclick!();
  expect(posts[1]).toEqual({ path: "api/tmp/clean", body: { force: true } });
  expect(asked[1]).toContain("5 件（合計 5.0 MB）");
  expect(asked[1]).toContain("\nPBI を進める（実行中）\nレビュー（承認待ち）");

  const none = await loadTmpPage({ yes: false });
  await none.$("tmp-force").onclick!();
  await none.$("tmp-clean").onclick!();
  expect(none.posts).toEqual([]);
  expect(none.asked[0]).toContain("動いている Task はありません");
});

test("release-tree: unpacks the tagged tarball without git and diffs it against the current release; no update source is a 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard.reltree."));
  const home = join(root, "home");
  const cur = "1".repeat(40);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  mkdirSync(join(home, "releases", cur, "node_modules"), { recursive: true });
  writeFileSync(join(home, "releases", cur, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(home, "releases", cur, "kept.txt"), "same\n");
  writeFileSync(join(home, "releases", cur, "changed.txt"), "old line\n");
  writeFileSync(join(home, "releases", cur, "node_modules", "x.js"), "installed only here\n");
  switchTo(home, cur);
  const top = join(root, "src", `o-n-${sha.slice(0, 7)}`);
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, "package.json"), JSON.stringify({ version: "1.1.0" }));
  writeFileSync(join(top, "kept.txt"), "same\n");
  writeFileSync(join(top, "changed.txt"), "new line\n");
  writeFileSync(join(top, "added.txt"), "brand new file\n");
  const tgz = join(root, "v1.1.0.tgz");
  Bun.spawnSync(["tar", "-czf", tgz, "-C", join(root, "src"), `o-n-${sha.slice(0, 7)}`]);
  let tarballCalls = 0;
  const api = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/repos/o/n/commits/v1.1.0") return Response.json({ sha });
      if (p === "/repos/o/n/releases/latest") return Response.json({ tag_name: "v1.1.0" });
      if (p === "/repos/o/n/tarball/v1.1.0") {
        tarballCalls++;
        return new Response(readFileSync(tgz));
      }
      return new Response("no", { status: 404 });
    },
  });
  const bin = join(root, "bin"); // tar, gzip and diff only: a git that is called would not be found
  mkdirSync(bin);
  for (const n of ["tar", "gzip", "diff"]) symlinkSync(Bun.which(n)!, join(bin, n));
  const oldPath = process.env.PATH;
  process.env.SWITCHBOARD_GITHUB_API = `http://localhost:${api.port}`;
  process.env.PATH = bin;
  const sctx: Ctx = { home, repo: join(home, "releases", "current"), source: "o/n", port: 1, sup: new Supervisor({ home, repo: f.repo, port: 1 }) };
  const noSource: Ctx = { ...sctx, source: null };
  const r1 = startRescue(sctx, { port: 0, tmpDir: tmpRoot });
  const r2 = startRescue(noSource, { port: 0, tmpDir: tmpRoot });
  const ask = (r: typeof r1, body: unknown) => fetch(`http://127.0.0.1:${r.server.port}/api/release-tree`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // two at once share one run
    const [res, again] = await Promise.all([ask(r1, { tag: "v1.1.0" }), ask(r1, { tag: "v1.1.0" })]);
    expect([res.status, again.status]).toEqual([200, 200]);
    expect(tarballCalls).toBe(1);
    const out = (await res.json()) as { tag: string; sha: string; tree: string; diffFile: string; stat: string[] };
    expect(await again.json()).toEqual(out);
    expect([out.tag, out.sha, out.tree, out.diffFile]).toEqual(["v1.1.0", sha, join(home, "release-review", "v1.1.0", cur, "tree"), join(home, "release-review", "v1.1.0", cur, "diff.patch")]);
    const patch = readFileSync(out.diffFile, "utf8");
    expect(patch).toContain("-old line");
    expect(patch).toContain("+new line");
    expect(patch).toContain("+brand new file"); // a file only the new version has
    expect(patch).not.toContain("installed only here"); // node_modules is not a change
    expect(out.stat.join("\n")).toContain("added.txt");
    expect(patch).toContain("+++ b/added.txt"); // the trees are a/ and b/: no host path reaches the review
    expect(`${patch}\n${out.stat.join("\n")}`).not.toContain(root);
    expect(readFileSync(join(out.tree, "added.txt"), "utf8")).toBe("brand new file\n");
    // the same tag again answers from what is there, without fetching
    expect(await ask(r1, { tag: "v1.1.0" }).then((r) => r.json())).toEqual(out);
    expect(tarballCalls).toBe(1);
    expect((await ask(r1, { tag: "main" })).status).toBe(400);
    expect((await ask(r1, { tag: "v9.9.9" })).status).toBe(502);
    expect(readdirSync(join(home, "release-review"))).toEqual(["v1.1.0"]);
    expect((await ask(r2, { tag: "v1.1.0" })).status).toBe(404);
    // the update source and the newest release, for the daemon: no git is asked
    const get = (r: typeof r1, path: string) => fetch(`http://127.0.0.1:${r.server.port}${path}`);
    expect(((await get(r1, "/api/status").then((r) => r.json())) as { source: string | null }).source).toBe("o/n");
    expect(((await get(r2, "/api/status").then((r) => r.json())) as { source: string | null }).source).toBeNull();
    // newer only when the tag is above the running release's: none to compare with, the same, or a lower tag is not
    const latestWith = async (runningTag: string | null) => {
      if (runningTag) writeFileSync(join(home, "releases", cur, ".release.json"), JSON.stringify({ tag: runningTag, sha: cur }));
      else rmSync(join(home, "releases", cur, ".release.json"), { force: true });
      return get(r1, "/api/latest-release").then((r) => r.json());
    };
    expect(await latestWith(null)).toEqual({ tag: "v1.1.0", sha, newer: false });
    expect(await latestWith("v1.0.9")).toEqual({ tag: "v1.1.0", sha, newer: true });
    expect(await latestWith("v1.1.0")).toEqual({ tag: "v1.1.0", sha, newer: false });
    expect(await latestWith("v1.10.0")).toEqual({ tag: "v1.1.0", sha, newer: false });
    expect((await get(r2, "/api/latest-release")).status).toBe(404);
    // /api/promote carries the checked commit to the promotion: a malformed one is refused, and one the tag no longer
    // names is rejected before anything is fetched or built
    const promoteAsk = (body: unknown) => fetch(`http://127.0.0.1:${r1.server.port}/api/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await promoteAsk({ commit: "v1.1.0", expectSha: "abc" })).status).toBe(400);
    const calls = tarballCalls;
    expect((await promoteAsk({ commit: "v1.1.0", expectSha: "e".repeat(40) })).status).toBe(202);
    const moved = await until(() => readHistory(home).find((h) => h.action === "rejected") ?? null, "promotion rejected");
    expect([moved.to, moved.reason.includes("checked version"), tarballCalls]).toEqual(["e".repeat(40), true, calls]);
    // another release runs now (a rollback): the difference is made again against it
    const other = "2".repeat(40);
    mkdirSync(join(home, "releases", other), { recursive: true });
    writeFileSync(join(home, "releases", other, "changed.txt"), "rolled back line\n");
    switchTo(home, other);
    const redo = (await ask(r1, { tag: "v1.1.0" }).then((r) => r.json())) as typeof out;
    expect(tarballCalls).toBe(2);
    expect(readFileSync(redo.diffFile, "utf8")).toContain("-rolled back line");
    // beside the first one, which a running check may still read
    expect(readFileSync(out.diffFile, "utf8")).toContain("-old line");
    // no current release to compare with
    rmSync(join(home, "releases", "current"));
    expect((await ask(r1, { tag: "v1.1.0" })).status).toBe(409);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.SWITCHBOARD_GITHUB_API;
    await r1.stop();
    await r2.stop();
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
