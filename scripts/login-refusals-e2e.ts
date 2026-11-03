/**
 * Run after `bun run --cwd apps/web build`: bun scripts/login-refusals-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * What a browser with no cookie gets counted against the daemon's failure limit (#1851, the limit is #1492): (a) opening `/`
 * until the page moves to /_auth/; (b) `/?from=auth`, the page that stays put when the login did not take, for 30 seconds, with Settings opened.
 * The daemon is the real one behind a stand-in for the edge: the shared header and the Viewer-Address come from CDP, and
 * /_auth/* is answered by CDP (the real one is the Starter's Lambda). Counted: the access log's 401 / 403 for the viewer.
 * Each case has its own viewer, so one does not use up the other's limit. Exit 1 when either is over the budget.
 * (c) health failing at first (a daemon restarting): the page asks again by itself and still gets to /_auth/.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { EDGE_HEADER } from "../packages/core/src/auth.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const BUDGET = 5; // half of the limit (10): the page's reads must leave room for the attempts the limit is there to count
const STAY_MS = 30_000;
const EDGE = "edge-e2e";
const home = mkdtempSync(join(tmpdir(), "sb-login-refusals-e2e-"));
const seed = "a".repeat(64);
const key = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]), format: "der", type: "pkcs8" })).export({ format: "jwk" }).x!;

type Access = { from: string | null; path: string; status: number };
const access: Access[] = [];
const log = console.log;
console.log = (...args: unknown[]) => {
  const line = String(args[0]);
  if (line.startsWith("{") && line.includes('"log":"access"')) access.push(JSON.parse(line) as Access);
  else log(...args);
};

const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_SESSION_PUBLIC_KEY: key, SWITCHBOARD_EDGE_HEADER_VALUE: EDGE, SWITCHBOARD_STARTER_URL: "http://127.0.0.1:9/" };
const core = await startServer(loadConfig(env), [], { port: 0, selfdevChecks: false, dryRunRestart: true, peerAddress: () => "203.0.113.9" });
const base = `http://127.0.0.1:${core.server.port}`;
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 20_000): Promise<NonNullable<T> | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  if (label) throw new Error(`Timeout: ${label}`);
  return null;
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
let failed = false;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const page = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(page!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const handlers = new Map<string, (params: any) => void>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method) handlers.get(m.method)?.(m.params);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const href = async () => (await call("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result.value as string;
  let failHealth = 0;
  handlers.set("Fetch.requestPaused", (p) => {
    if (new URL(p.request.url).pathname === "/api/health") {
      if (failHealth-- > 0) void call("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionRefused" });
      else void call("Fetch.continueRequest", { requestId: p.requestId });
      return;
    }
    void call("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }], body: Buffer.from("<!doctype html><title>login</title>").toString("base64") });
  });
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Fetch.enable", { patterns: [{ urlPattern: "*/_auth/*" }, { urlPattern: "*/api/health*" }] });

  const open = async (viewer: string, path: string) => {
    await call("Page.navigate", { url: "about:blank" });
    await call("Network.setExtraHTTPHeaders", { headers: { [EDGE_HEADER]: EDGE, "cloudfront-viewer-address": `${viewer}:40000` } });
    await call("Page.navigate", { url: `${base}${path}` });
  };
  const report = (name: string, viewer: string) => {
    const refused = access.filter((a) => a.from?.split(":")[0] === viewer && (a.status === 401 || a.status === 403));
    const seen = access.filter((a) => a.from?.split(":")[0] === viewer);
    const counts: Record<string, number> = {};
    for (const a of refused) counts[a.path] = (counts[a.path] ?? 0) + 1;
    log(JSON.stringify({ case: name, refused: refused.length, budget: BUDGET, paths: counts, requests: seen.length, limited: seen.filter((a) => a.status === 429).length }));
    if (seen.length === 0) throw new Error(`${name}: no request of this viewer reached the daemon`);
    if (refused.length > BUDGET) failed = true;
  };

  await open("198.51.100.7", "/");
  const moved = await until(async () => (await href()).includes("/_auth/"), "", 15_000);
  log(JSON.stringify({ case: "a", movedToLogin: !!moved, at: new URL(await href()).pathname }));
  if (!moved) failed = true;
  report("a", "198.51.100.7");

  await open("198.51.100.8", "/?from=auth");
  await Bun.sleep(1_000);
  // a tab is there before the login is
  const opened = await call("Runtime.evaluate", { expression: `[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'Settings').click()` });
  if (opened.exceptionDetails) throw new Error("(b) no Settings tab");
  await Bun.sleep(STAY_MS);
  const stayed = new URL(await href());
  if (stayed.pathname.includes("/_auth/")) throw new Error(`(b) moved to ${stayed.pathname}: this case is the page that stays`);
  const logoutWay = await call("Runtime.evaluate", { expression: `!!document.querySelector('.banner a[href="/_auth/#devices"]')`, returnByValue: true });
  if (!logoutWay.result.value) throw new Error("(b) no way to the login page, where logging out is");
  report("b", "198.51.100.8");

  failHealth = 1;
  await open("198.51.100.9", "/");
  const recovered = await until(async () => (await href()).includes("/_auth/"), "", 15_000);
  log(JSON.stringify({ case: "c", movedToLogin: !!recovered }));
  if (!recovered) failed = true;
  report("c", "198.51.100.9");
} catch (e) {
  log(String(e));
  failed = true;
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop?.();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
