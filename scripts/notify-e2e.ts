/**
 * Run after `bun run --cwd apps/web build`: CHROME_BIN=/usr/local/bin/chromium bun scripts/notify-e2e.ts.
 * OS notices for approval waits (#1138) through a fake window.Notification: a fake runner asks once per task; the
 * notice opens its Task, a reconnect and an answer do not notify again, a needs_action does, and with the permission
 * denied nothing is shown while the 承認 list and badge still answer. The 設定 → 端末通知 card asks only from its button.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-notify-e2e-"));
const answered: string[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: { file_path: "src/a.ts" }, detail: `write src/a.ts for ${opts.prompt}` });
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
const post = async (path: string, body: object) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

// The page's Notification (and WebSocket, to drop it): the permission comes from localStorage (granted unless set), each notice goes to __notices
const fakeNotification = `(() => {
  window.__notices = [];
  class FakeNotification {
    static get permission() { return localStorage.getItem('e2e-perm') ?? 'granted'; }
    static async requestPermission() { localStorage.setItem('e2e-perm', 'granted'); return 'granted'; }
    constructor(title, options = {}) { Object.assign(this, { title, body: options.body, tag: options.tag, onclick: null }); window.__notices.push(this); }
    close() {}
  }
  window.Notification = FakeNotification;
  // the app's sockets, so the test can drop them and watch it reconnect
  window.__sockets = [];
  const Ws = window.WebSocket;
  window.WebSocket = class extends Ws { constructor(...args) { super(...args); window.__sockets.push(this); } };
})()`;

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
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const notices = () => evaluate(`window.__notices.map(n => ({ title: n.title, body: n.body }))`) as Promise<Array<{ title: string; body: string }>>;
  const tap = async (selector: string) => {
    const point = await evaluate(`(() => { const e = ${selector}; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Network.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: fakeNotification });
  await call("Page.navigate", { url: `${base}/` });
  await until(() => evaluate(`!!document.querySelector('.conn.ok')`), "connected");

  // (a) an ask → one notice, the task's title and the tool only (no detail)
  const a = (await post("/api/tasks", { cwd: cfg.repoRoot, title: "notify-a", prompt: "notify-a", runner: "claude" })).id as string;
  assert(a, "task notify-a created");
  await until(async () => (await notices()).length === 1, "one notice");
  const first = (await notices())[0]!;
  assert(first.title === "notify-a" && first.body === "ツール承認待ち: Write" && !first.body.includes("src/a.ts"), `first notice: ${JSON.stringify(first)}`);
  // (b) clicking it opens the Task
  await evaluate(`window.__notices[0].onclick(new Event('click'))`);
  const opened = await until(() => evaluate(`document.querySelector('.tabs button.on')?.textContent === 'Task' && document.querySelector('main.task .task-head h2')?.textContent`), "task screen") as string;
  assert(opened === "notify-a", `opened: ${opened}`);
  // (c) a reconnect reads GET /api/approvals again and does not notify
  const approvalsBefore = await evaluate(`performance.getEntriesByType('resource').filter(e => e.name.endsWith('/api/approvals')).length`);
  await evaluate(`window.__sockets.forEach(s => s.close())`);
  await until(() => evaluate(`!!document.querySelector('.conn.off')`), "disconnected");
  await until(() => evaluate(`!!document.querySelector('.conn.ok') && performance.getEntriesByType('resource').filter(e => e.name.endsWith('/api/approvals')).length > ${approvalsBefore}`), "reconnected and approvals read again");
  await Bun.sleep(500);
  const afterReconnect = (await notices()).length;
  assert(afterReconnect === 1, `after reconnect: ${afterReconnect}`);
  // (d) answering from the 判断待ち screen (opened from the rail, the same page) resolves the ask: no notice
  await tap(`document.querySelector('.rail-approvals')`);
  // 承認して続行 once the card's facts are in (#936): tapping the earlier 許可 races its replacement
  await until(() => evaluate(`document.querySelectorAll('.approval').length === 1 && !!document.querySelector('.approval .ask-buttons .pri')`), "the approval");
  await tap(`[...document.querySelectorAll('.approval')].find(c => c.textContent.includes('notify-a')).querySelector('.ask-buttons .pri')`);
  await until(() => answered.includes("notify-a:allow"), "the runner got allow");
  await until(() => evaluate(`document.querySelectorAll('.approval').length === 0`), "the answered one leaves");
  await Bun.sleep(500);
  const afterAnswer = (await notices()).length;
  assert(afterAnswer === 1, `after answer: ${afterAnswer}`);
  // (e) the finished task turned needs_action → one notice; the same outcome again does not notify
  await until(async () => ((await (await fetch(`${base}/api/tasks/${a}`)).json()) as any).task?.status === "done", "notify-a done");
  await post(`/api/tasks/${a}/outcome`, { outcome: "needs_action" });
  await until(async () => (await notices()).length === 2, "needs_action notice");
  const needs = (await notices())[1]!;
  assert(needs.title === "notify-a" && needs.body === "要対応: 回答を待っています", `needs_action notice: ${JSON.stringify(needs)}`);
  await post(`/api/tasks/${a}/outcome`, { outcome: "needs_action" });
  await Bun.sleep(500);
  const afterRepeat = (await notices()).length;
  assert(afterRepeat === 2, `the same outcome again: ${afterRepeat}`);

  // (f) not asked yet: the settings card offers the button, and the browser's answer shows at once
  await evaluate(`localStorage.setItem('e2e-perm', 'default')`);
  await call("Page.reload");
  await until(() => evaluate(`!!document.querySelector('.conn.ok')`), "connected after reload");
  await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'Settings')`);
  await until(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '通知を許可する')`), "the allow button");
  await tap(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '通知を許可する')`);
  await until(() => evaluate(`document.body.textContent.includes('許可済み。承認待ちが来ると通知します') && ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === '通知を許可する')`), "granted text");
  const settings = { allowButton: true, afterAllow: "granted" };
  // (g) denied: the settings card says so, nothing is shown, and the list and badge still answer
  await evaluate(`localStorage.setItem('e2e-perm', 'denied')`);
  await call("Page.reload");
  await until(() => evaluate(`!!document.querySelector('.conn.ok')`), "connected again");
  await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'Settings')`);
  await until(() => evaluate(`document.body.textContent.includes('ブラウザが拒否しています')`), "denied text in settings");
  const b = (await post("/api/tasks", { cwd: cfg.repoRoot, title: "notify-b", prompt: "notify-b", runner: "claude" })).id as string;
  assert(b, "task notify-b created");
  const badge = await until(() => evaluate(`document.querySelector('.rail-approvals .badge')?.textContent`), "badge");
  await Bun.sleep(500);
  const deniedNotices = (await notices()).length;
  await tap(`document.querySelector('.rail-approvals')`);
  await until(() => evaluate(`document.querySelectorAll('.approval').length === 1 && !!document.querySelector('.approval .ask-buttons .pri')`), "the approval of notify-b");
  await tap(`document.querySelector('.approval .ask-buttons .pri')`);
  await until(() => answered.includes("notify-b:allow"), "the runner got allow for notify-b");
  const denied = { notices: deniedNotices, badge, answered: true };
  assert(deniedNotices === 0 && badge === "1", `denied: ${JSON.stringify(denied)}`);
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ notices: afterRepeat, first, opened, afterReconnect, afterAnswer, needs, afterRepeat, settings, denied, answered, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
