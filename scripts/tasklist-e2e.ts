/**
 * Run after `bun run --cwd apps/web build`: bun scripts/tasklist-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The rail's Task list (#1142) with 120 Tasks (task-001〜task-010 end in error): 50 rows, 100 after 「さらに表示」, the
 * search and the state filter narrow it, アーカイブ on a stopped Task takes it out of the list without reading the
 * archived ones, 「アーカイブ済みを表示」 reads them once (GET /api/tasks?archived=1, counted over CDP), and
 * 「アーカイブを戻す」 brings it back. With the archived ones shown, a Task archived while the page is cut off (its
 * WebSocket held closed) is in the list after the reconnect. SCREENSHOT=<file.png> saves the rail with the search.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-tasklist-e2e-"));
// prompt `err` → ends in error; anything else → ends ok
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: `reply to ${opts.prompt}` });
      emit({ t: "session.end", status: opts.prompt === "err" ? "error" : "ok", summary: opts.prompt });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const tasks = async (q = "") => (await (await fetch(`${base}/api/tasks${q}`)).json()) as Task[];
for (let i = 1; i <= 120; i++) {
  const title = `task-${String(i).padStart(3, "0")}`;
  await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title, prompt: i <= 10 ? "err" : "ok", runner: "claude" }) });
}
await until(async () => { const l = await tasks(); return l.length === 120 && l.every((t) => t.status === "done" || t.status === "error"); }, "120 stopped");

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const page = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  const requests: string[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const archivedReads = () => requests.filter((u) => new URL(u).pathname === "/api/tasks" && new URL(u).searchParams.get("archived") === "1").length;
  // the titles of the Tasks group's rows: the `.it` rows after the Tasks heading
  const rows = async () => (await evaluate(`(() => { const out = []; let on = false; for (const n of document.querySelectorAll('.rail-list > *')) {
    if (n.classList.contains('grp')) { on = n.textContent === 'Tasks'; continue; } if (on && n.matches('button.it')) out.push(n.querySelector('.t')?.textContent ?? ''); } return out; })()`)) as string[];
  const rowsAre = (n: number, label: string) => until(async () => { const r = await rows(); return r.length === n && r; }, `${label}: ${n} rows`);
  const click = (js: string, label: string) => until(() => evaluate(`(() => { const el = ${js}; if (!el || el.disabled) return false; el.click(); return true; })()`), label);
  const setValue = (selector: string, proto: "HTMLInputElement" | "HTMLSelectElement", value: string, event: "input" | "change") =>
    until(() => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      Object.getOwnPropertyDescriptor(${proto}.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`), selector);
  const search = (q: string) => setValue('.rail input[aria-label="Task を検索"]', "HTMLInputElement", q, "input");
  const status = (s: string) => setValue('.rail select[aria-label="状態"]', "HTMLSelectElement", s, "change");
  const toggleArchived = () => click(`document.querySelector('.rail input[aria-label="アーカイブ済みを表示"]')`, "アーカイブ済みを表示");

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Network.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // the page's sockets, and a switch that sends its reconnects to a path that is no WebSocket (a cut-off connection)
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `window.__ws = []; window.__hold = false; const W = window.WebSocket;
    window.WebSocket = class extends W { constructor(url, p) { super(window.__hold ? String(url).replace(/\\/ws$/, "/ws-held") : url, p); window.__ws.push(this); } };` });
  await call("Page.navigate", { url: `${base}/` });

  // (a) 50 rows, newest first; 「さらに表示」 → 100
  const a = await rowsAre(50, "(a) first page");
  assert(a[0] === "task-120" && a[49] === "task-071", `(a) ${a[0]} … ${a[49]}`);
  await click(`document.querySelector('.rail button.rail-more')`, "さらに表示");
  await rowsAre(100, "(a) after さらに表示");
  // (b) the search: task-07 → task-070〜079
  await search("task-07");
  const b = await rowsAre(10, "(b) search");
  assert(b.every((t) => t.startsWith("task-07")), `(b) ${b}`);
  if (process.env.SCREENSHOT) await Bun.write(process.env.SCREENSHOT, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  // (c) the state filter: エラー・中断 → task-001〜010
  await search("");
  await status("stopped");
  const c = await rowsAre(10, "(c) エラー・中断");
  assert(c.every((t) => Number(t.slice(5)) <= 10), `(c) ${c}`);
  await status("all");
  await search("task-005");
  await rowsAre(1, "(d) task-005 found");
  // (d) open task-005, アーカイブ → out of the list; the archived ones are not read
  await click(`[...document.querySelectorAll('.rail-list button.it')].find((b) => b.querySelector('.t')?.textContent === 'task-005')`, "open task-005");
  await click(`[...document.querySelectorAll('.task-head button.archive-toggle')].find((b) => b.textContent === 'アーカイブ')`, "アーカイブ");
  await rowsAre(0, "(d) archived");
  assert((await tasks("?archived=1")).map((t) => t.title).join() === "task-005", "(d) stored");
  assert(archivedReads() === 0, `(d) ?archived=1 read ${archivedReads()} times`);
  // (e) アーカイブ済みを表示 → read once, task-005 there
  await toggleArchived();
  await rowsAre(1, "(e) archived shown");
  assert(archivedReads() === 1, `(e) ?archived=1 read ${archivedReads()} times`);
  // (f) アーカイブを戻す → out of the archived list; with the toggle off it is back
  await click(`[...document.querySelectorAll('.task-head button.archive-toggle')].find((b) => b.textContent === 'アーカイブを戻す')`, "アーカイブを戻す");
  await rowsAre(0, "(f) restored, archived list");
  await toggleArchived();
  const f = await rowsAre(1, "(f) restored, list");
  assert(f[0] === "task-005" && (await tasks()).length === 120, `(f) ${f}`);
  // (g) archived shown, the page cut off, task-006 archived meanwhile (the task.updated is missed) → there after the reconnect
  await search("");
  await toggleArchived();
  await rowsAre(0, "(g) none archived");
  await evaluate(`(() => { window.__hold = true; for (const s of window.__ws) s.close(); })()`);
  await until(() => evaluate(`window.__ws.every((s) => s.readyState !== 1)`), "(g) cut off");
  const archived006 = await fetch(`${base}/api/tasks/${(await tasks()).find((t) => t.title === "task-006")!.id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
  assert(archived006.ok, "(g) archive task-006");
  await Bun.sleep(300);
  assert((await rows()).length === 0, "(g) not seen while cut off");
  await evaluate(`window.__hold = false`);
  const g = await rowsAre(1, "(g) after the reconnect");
  assert(g[0] === "task-006", `(g) ${g}`);

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ a: [a.length, a[0], a[49]], more: 100, search: b.length, stopped: c.length, archivedReads: archivedReads(), restored: f, reconnect: g, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
