/**
 * Run after `bun run --cwd apps/web build`: bun scripts/recent-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * 直近のパスキー確認 (#1491) in the browser: a device with only the 30-day `sb_session` opens a task's ターミナル tab, is
 * asked 「操作の前にパスキーで確かめてください」 (no /ws/pty 101 yet), checks the passkey (a virtual authenticator), and the shell
 * opens; a settings save within the 5 minutes is not asked again. The Starter in front is a fake that verifies nothing
 * (aws/auth.test.ts holds that); the front proxy relays HTTP and /ws/pty to the daemon. The two screens go to SCREENSHOT_DIR (default: a new folder under the temp dir; the paths are printed).
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyOf, recentValue, sessionValue } from "../aws/auth.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-recent-e2e-"));
const shotDir = process.env.SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "switchboard.recent-shots."));
const shots: string[] = [];
const seed = randomBytes(32).toString("hex");
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-1", cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: "reply" });
      emit({ t: "session.end", status: "ok", summary: "done" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const freePort = () => Array.from({ length: 100 }, (_, i) => 47911 + i).find((p) => Bun.spawnSync(["lsof", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdout: "ignore", stderr: "ignore" }).exitCode === 1)!;

// The fake Starter + front proxy in one server: /_auth/* answered here, the rest relayed to the daemon.
const proxyPort = freePort();
const daemonPort = Array.from({ length: 100 }, (_, i) => 47911 + i).find((p) => p !== proxyPort && Bun.spawnSync(["lsof", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdout: "ignore", stderr: "ignore" }).exitCode === 1)!;
const daemon = `127.0.0.1:${daemonPort}`;
const cookieOf = (req: Request) => req.headers.get("cookie") ?? "";
const relayHeaders = (req: Request) => { const h = new Headers(req.headers); h.delete("origin"); return h; }; // the browser's Origin is the proxy's, not the daemon's
type Relay = { url: string; cookie: string; up?: WebSocket; queue: Array<string | ArrayBuffer | Uint8Array> };
const front = Bun.serve<Relay>({
  port: proxyPort, hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/_auth/status") return Response.json({ loggedIn: true });
    if (url.pathname === "/_auth/challenge") return Response.json({ challenge: randomBytes(32).toString("base64url"), rpId: "localhost" });
    if (url.pathname === "/_auth/login") {
      const now = Date.now();
      return new Response(JSON.stringify({ ok: true }), { headers: [["content-type", "application/json"], ["set-cookie", `sb_session=${sessionValue(seed, "pk1", now + 86_400_000)}; Path=/; Max-Age=86400`], ["set-cookie", `sb_recent=${recentValue(seed, "pk1", now + 300_000)}; Path=/; Max-Age=300`]] });
    }
    const target = `http://${daemon}${url.pathname}${url.search}`;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      // connect to the daemon first: a refusal is answered as the HTTP response the browser reads, not as a 101
      const up = new WebSocket(target.replace(/^http/, "ws"), { headers: { cookie: cookieOf(req) } } as never);
      const opened = await new Promise<boolean>((resolve) => { up.onopen = () => resolve(true); up.onerror = () => resolve(false); up.onclose = () => resolve(false); });
      if (!opened) return fetch(target, { headers: relayHeaders(req) });
      return srv.upgrade(req, { data: { url: target, cookie: cookieOf(req), up, queue: [] } }) ? undefined : new Response("upgrade failed", { status: 426 });
    }
    return fetch(target, { method: req.method, headers: relayHeaders(req), body: req.body, redirect: "manual" });
  },
  websocket: {
    open(ws) { const { up } = ws.data; up!.onmessage = (e) => ws.send(e.data as string); up!.onclose = () => ws.close(); },
    message(ws, m) { ws.data.up!.send(m as string); },
    close(ws) { ws.data.up?.close(); },
  },
});

const cfg = loadConfig({
  SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0",
  SWITCHBOARD_HOST: "0.0.0.0", SWITCHBOARD_SESSION_PUBLIC_KEY: publicKeyOf(seed), SWITCHBOARD_STARTER_URL: `http://127.0.0.1:${proxyPort}`,
});
const core = await startServer(cfg, [adapter], { port: daemonPort, selfdevChecks: false, dryRunRestart: true });
const page = `http://localhost:${proxyPort}`;
const session = sessionValue(seed, "pk1", Date.now() + 86_400_000);
const asCookie = { cookie: `sb_session=${session}`, "content-type": "application/json" };
const created = (await (await fetch(`http://${daemon}/api/tasks`, { method: "POST", headers: asCookie, body: JSON.stringify({ cwd: cfg.repoRoot, title: "task-e2e", prompt: "hi", runner: "claude" }) })).json()) as Task;
assert(created.id, "task created");
await until(async () => ((await (await fetch(`http://${daemon}/api/tasks`, { headers: asCookie })).json()) as Task[]).find((t) => t.id === created.id && t.status !== "running"), "task stopped");
// the daemon itself: a cookie alone is refused for the shell's URL, with the reason
const refusal = await fetch(`http://${daemon}/ws/pty?task=${created.id}`, { headers: { cookie: `sb_session=${session}` } });
assert(refusal.status === 401 && ((await refusal.json()) as { reason?: string }).reason === "recent", "daemon refuses a cookie without sb_recent");

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tab = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0, ptyIds = new Set<string>(), opened101 = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Network.webSocketCreated" && String(m.params.url).includes("/ws/pty")) ptyIds.add(m.params.requestId);
    if (m.method === "Network.webSocketHandshakeResponseReceived" && ptyIds.has(m.params.requestId) && m.params.response.status === 101) opened101++;
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = (js: string, label: string) => until(() => evaluate(`(() => { const el = ${js}; if (!el || el.disabled) return false; el.click(); return true; })()`), label);
  const shot = async (name: string) => { const file = join(shotDir, name); await Bun.write(file, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64")); shots.push(file); };

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Network.enable");
  await call("Page.enable");
  // a virtual authenticator holding a resident passkey for localhost: `navigator.credentials.get` answers without a sheet
  await call("WebAuthn.enable");
  const { authenticatorId } = await call("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  await call("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: randomBytes(16).toString("base64"), isResidentCredential: true, rpId: "localhost", privateKey: key, userHandle: Buffer.from("pk1").toString("base64"), signCount: 0 } });
  await call("Network.setCookie", { name: "sb_session", value: session, url: page });
  await call("Page.navigate", { url: `${page}/` });

  await click(`[...document.querySelectorAll('.rail-list button.it')].find((b) => b.querySelector('.t')?.textContent === 'task-e2e')`, "open the task from the rail");
  await click(`[...document.querySelectorAll('.subtabs button')].find((b) => b.textContent.trim() === 'ターミナル')`, "ターミナル tab");

  const message = await until(() => evaluate(`document.querySelector('.recent-check')?.innerText ?? ''`), "the passkey question appears");
  assert(message.includes("操作の前にパスキーで確かめてください"), `question text: ${message}`);
  assert(opened101 === 0, `no shell before the check (101: ${opened101})`);
  await shot("recent-1-question.png");

  await click(`[...document.querySelectorAll('.recent-check button')].find((b) => b.textContent.trim() === 'パスキーで確かめる')`, "パスキーで確かめる");
  await until(() => opened101 === 1, "the shell socket opens once after the check");
  await until(() => evaluate(`!document.querySelector('.recent-check')`), "the question closes");
  await until(() => evaluate(`(() => { const t = document.querySelector('.xterm-helper-textarea'); if (!t) return false; t.focus(); return true; })()`), "terminal focus");
  await Bun.sleep(500); // the shell's prompt
  await call("Input.insertText", { text: "echo e2e-ok" });
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until(() => evaluate(`(document.querySelector('.xterm-rows')?.innerText ?? '').split('\\n').some((l) => l.trim() === 'e2e-ok')`), "echo e2e-ok is answered");
  await shot("recent-2-shell.png");

  // within the 5 minutes a strong operation goes straight through: no question
  const saved = await evaluate(`fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
  assert(saved === 200, `settings save status ${saved}`);
  assert(await evaluate(`!document.querySelector('.recent-check')`), "no question after the check");
  assert(opened101 === 1, `one shell socket (${opened101})`);
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ question: message, ptyOpens: opened101, settingsSave: saved, consoleErrors: errors.length, screenshots: shots }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  front.stop(true);
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
