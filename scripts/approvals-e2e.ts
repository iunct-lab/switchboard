/**
 * Run after `bun run --cwd apps/web build`: bun scripts/approvals-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * A fake runner asks for a write in two tasks; the 承認 screen at 390 × 844 (iPhone 14) answers one with one tap (#26).
 * SCREENSHOT=<file.png> saves the phone-sized screen before the answer.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-approvals-e2e-"));
const answered: string[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: { file_path: "src/a.ts" }, detail: `write src/a.ts for ${opts.prompt}\nsecond line\nthird line` });
    });
    return {
      send() {},
      respondPermission(id, decision) {
        answered.push(`${opts.prompt}:${decision}`);
        emit({ t: "permission.resolved", id, decision, by: "user" });
        emit({ t: "session.end", status: "ok" });
        exit(0);
      },
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
for (const title of ["approve-a", "approve-b"]) {
  await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title, prompt: title, runner: "claude" }) });
  await until(async () => ((await (await fetch(`${base}/api/approvals`)).json()) as unknown[]).length >= (title === "approve-a" ? 1 : 2), `ask of ${title}`);
  await Bun.sleep(5);
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  const responses: Array<{ url: string; fromServiceWorker: boolean }> = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Network.responseReceived") responses.push({ url: m.params.response.url, fromServiceWorker: !!m.params.response.fromServiceWorker });
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Page.navigate", { url: `${base}/approvals` });
  await until(() => evaluate(`document.querySelectorAll('.approval').length === 2`), "two approvals");
  const titles = await evaluate(`[...document.querySelectorAll('.approval .t')].map(b => b.textContent)`) as string[];
  assert(JSON.stringify(titles) === JSON.stringify(["approve-b", "approve-a"]), `newest first: ${titles}`);
  const badge = await evaluate(`document.querySelector('.rail-approvals .badge')?.textContent`);
  const width = await evaluate("document.documentElement.scrollWidth") as number;
  const wide = width > 390 ? await evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 391).slice(0, 6).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))`) : [];
  assert(width <= 390, `scrolls sideways at 390px (${width}): ${JSON.stringify(wide)}`);
  const small = await evaluate(`[...document.querySelectorAll('.approval-actions button, .ask-buttons button, .rail-approvals')].filter(b => b.getBoundingClientRect().height < 44).length`);
  assert(small === 0, `${small} target(s) shorter than 44px`);
  if (process.env.SCREENSHOT) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  // the 判断待ち cards carry their facts (#935), so the second one may start below the fold: scroll its button in, then one tap
  // (承認して続行 once the list has it, #936; 許可 before)
  const point = await evaluate(`(() => { const e = [...document.querySelectorAll('.approval')].find(c => c.textContent.includes('approve-a')).querySelector('.approval-actions .pri, .ask-buttons .pri'); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until(() => evaluate(`document.querySelectorAll('.approval').length === 1`), "the answered one leaves");
  await until(() => answered.includes("approve-a:allow"), "the runner got allow");
  const after = await evaluate(`({ left: [...document.querySelectorAll('.approval .t')].map(b => b.textContent), badge: document.querySelector('.rail-approvals .badge')?.textContent })`);
  assert(JSON.stringify(after) === JSON.stringify({ left: ["approve-b"], badge: "1" }), `after: ${JSON.stringify(after)}`);
  // PWA (#26): installable, the service worker controls the page, and the API never goes through it.
  const types = Object.fromEntries(await Promise.all(["/sw.js", "/manifest.webmanifest"].map(async (p) => [p, (await fetch(`${base}${p}`)).headers.get("content-type")])));
  assert(String(types["/sw.js"]).includes("javascript"), `sw.js content-type: ${types["/sw.js"]}`);
  assert(String(types["/manifest.webmanifest"]).includes("manifest+json"), `manifest content-type: ${types["/manifest.webmanifest"]}`);
  await until(() => evaluate(`navigator.serviceWorker.ready.then(() => true)`), "service worker ready");
  await call("Network.enable");
  await call("Page.reload");
  await until(() => evaluate(`!!navigator.serviceWorker.controller && document.querySelectorAll('.approval').length === 1`), "controlled page");
  const installErrors = (await call("Page.getInstallabilityErrors")).installabilityErrors as unknown[];
  const manifest = await call("Page.getAppManifest");
  await evaluate(`fetch('/api/health').then((r) => r.ok)`);
  const health = await until(() => responses.find((r) => r.url.endsWith("/api/health")), "health response");
  const viaSw = health.fromServiceWorker;
  const shellViaSw = responses.find((r) => r.url === `${base}/approvals`)?.fromServiceWorker ?? null;
  assert(installErrors.length === 0, `installability: ${JSON.stringify(installErrors)}`);
  assert(viaSw === false && shellViaSw === true, `api via sw: ${viaSw}, shell via sw: ${shellViaSw}`);
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  // the live approval is still answered with one tap when GET /api/asks does not answer (#935)
  await call("Network.setBlockedURLs", { urls: ["*/api/asks*"] });
  await call("Page.reload");
  // the screen says the list failed (the block took effect), and the approval is still there to answer
  await until(() => evaluate(`!!document.querySelector('.ask-failed') && document.querySelectorAll('.approval .approval-actions .pri').length === 1 && !document.querySelector('.ask-group')`), "the approval without /api/asks");
  await call("Network.setBlockedURLs", { urls: [] });
  console.log(JSON.stringify({ titles, badge, scrollWidth: width, answered, after, pwa: { types, installErrors, manifestErrors: manifest.errors, apiViaServiceWorker: viaSw, shellViaServiceWorker: shellViaSw }, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
