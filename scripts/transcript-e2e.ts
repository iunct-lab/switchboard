/**
 * Run after `bun run --cwd apps/web build`: bun scripts/transcript-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * A long Task's transcript (#1142): a fake runner streams 1,000 events; the Task opens on its last 200 (the rows match
 * foldTranscript of the daemon's tail), 「以前の会話を読む」 adds the pages before it (GET /api/tasks/:id?before=) without
 * moving the view, until the whole conversation is there and the button goes. A failed catch-up after a reconnect (its
 * ?after= read failed over CDP) drops the detail; it is read from its tail again and the button is back. A reply's end reads the rest only
 * (?limit=0): never the whole detail, never the list again, and the rail shows the daemon's status. Requests are
 * counted over CDP.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { foldTranscript } from "../apps/web/src/transcript.ts";
import type { AgentEvent, EventEnvelope, RunnerAdapter, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-transcript-e2e-"));
function longEvents(): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let i = 0; out.length < 1000; i++) {
    out.push({ t: "tool.call", id: `c${i}`, name: "Read", input: { file_path: `src/file${i}.ts` }, summary: `Read src/file${i}.ts` });
    out.push({ t: "tool.result", id: `c${i}`, ok: true, summary: `${40 + (i % 7)} lines` });
    out.push({ t: "message.delta", role: "assistant", text: `Step ${i}: the file reads as expected.`, messageId: `m${i}` });
  }
  return out.slice(0, 1000);
}
// prompt `long` → 1,000 events; a reply → one message. The process stays for the reply.
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const reply = (text: string) => queueMicrotask(() => {
      emit({ t: "message.delta", role: "assistant", text: `reply to ${text}`, messageId: `r-${text}` });
      emit({ t: "session.end", status: "ok" });
    });
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-long", cwd: opts.cwd });
      if (opts.prompt !== "long") return reply(opts.prompt);
      for (const ev of longEvents()) emit(ev);
      emit({ t: "session.end", status: "ok" });
    });
    return { send: (text: string) => reply(text), respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
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
const created = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: "long", prompt: "long", runner: "claude" }) })).json()) as Task;
const id = created.id;
await until(async () => core.db.getTask(id)?.status === "done", "the long Task ends");
// the rows the screen draws: what foldTranscript makes of these events, without the hint rows (notes / artifacts)
const rowsOf = (events: EventEnvelope[]) => foldTranscript(events).items.filter((it) => it.kind === "user" || it.kind === "assistant" || it.kind === "tool" || it.kind === "end").length;

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
  const requests: URL[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Network.requestWillBeSent" && m.params.request.method === "GET") requests.push(new URL(m.params.request.url));
    if (m.method === "Fetch.requestPaused") void call("Fetch.failRequest", { requestId: m.params.requestId, errorReason: "Failed" });
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const n = ++seq; pending.set(n, { resolve, reject }); ws!.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const count = (path: string, search: string) => requests.filter((u) => u.pathname === path && (search === "*" || u.search === search)).length;
  const list = () => count("/api/tasks", "");
  const detail = (search: string) => count(`/api/tasks/${id}`, search);
  const older = () => requests.filter((u) => u.pathname === `/api/tasks/${id}` && u.searchParams.has("before")).length;
  const rows = async () => (await evaluate(`document.querySelectorAll('.transcript > .msg, .transcript > .tool, .transcript > .end').length`)) as number;
  const button = () => evaluate(`!!document.querySelector('.transcript button.older')`) as Promise<boolean>;

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Network.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `window.__ws = []; const W = window.WebSocket; window.WebSocket = class extends W { constructor(url, p) { super(url, p); window.__ws.push(this); } };` });
  await call("Page.navigate", { url: `${base}/` });

  // (a) open it from the rail: the last 200 events drawn, the button above them
  await until(() => evaluate(`(() => { const b = [...document.querySelectorAll('.rail-list button.it')].find((b) => b.querySelector('.t')?.textContent === 'long'); if (!b) return false; b.click(); return true; })()`), "open long");
  const tailRows = rowsOf(core.db.listEventsTail(id, 200));
  await until(async () => (await rows()) === tailRows, `(a) ${tailRows} rows`);
  assert(await button(), "(a) the button is there");
  assert(detail("") === 1 && list() === 1, `(a) detail ${detail("")} list ${list()}`);

  // (b) 「以前の会話を読む」 until it goes: one ?before= read each, the view stays on the row it showed
  const all = core.db.listEvents(id);
  const pages = Math.floor((all.length - 200) / 200) + 1; // the last page comes back short, which takes the button away
  let kept: { before: number; after: number } | null = null;
  for (let i = 1; i <= pages; i++) {
    const top = `(() => { const main = document.querySelector('main.task'); const first = [...document.querySelectorAll('.transcript > .msg, .transcript > .tool, .transcript > .end')].find((el) => el.getBoundingClientRect().top >= main.getBoundingClientRect().top); return first ? [first.textContent, first.getBoundingClientRect().top] : null; })()`;
    const seen = (await evaluate(top)) as [string, number];
    await until(() => evaluate(`(() => { const b = document.querySelector('.transcript button.older'); if (!b || b.disabled) return false; b.click(); return true; })()`), `(b) click ${i}`);
    await until(() => older() === i && evaluate(`!document.querySelector('.transcript button.older:disabled')`), `(b) page ${i}`);
    if (i === 1) {
      await Bun.sleep(100);
      const where = (await evaluate(`(() => { const el = [...document.querySelectorAll('.transcript > .msg, .transcript > .tool, .transcript > .end')].find((el) => el.textContent === ${JSON.stringify(seen[0])}); return el ? el.getBoundingClientRect().top : null; })()`)) as number | null;
      kept = { before: seen[1], after: where ?? NaN };
      assert(where !== null && Math.abs(where - seen[1]) <= 2, `(b) the view moved: ${JSON.stringify(kept)}`);
    }
  }
  await until(async () => !(await button()), "(b) the button goes");
  const allRows = rowsOf(all);
  await until(async () => (await rows()) === allRows, `(b) ${allRows} rows`);
  assert(older() === pages && detail("") === 1, `(b) before ${older()} / ${pages}, whole ${detail("")}`);

  // (b2) a reconnect whose catch-up read fails: the detail is dropped and read from its tail again, and the button is back
  await call("Fetch.enable", { patterns: [{ urlPattern: `*/api/tasks/${id}?after=*` }] });
  await evaluate(`(() => { for (const s of window.__ws) s.close(); })()`);
  await until(() => detail("") === 2, "(b2) read whole again");
  await call("Fetch.disable");
  await until(async () => (await rows()) === tailRows && (await button()), "(b2) the tail and the button again");
  const base2 = { whole: detail(""), list: list() };
  const tailFirst = core.db.listEventsTail(id, 200)[0]!.seq;

  // (c) a reply: its end reads ?limit=0 once, nothing whole, not the list; the rows and the rail follow the daemon
  const sent = await fetch(`${base}/api/tasks/${id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) });
  assert(sent.ok, `(c) send ${sent.status}`);
  await until(async () => core.db.getTask(id)?.status === "done" && detail("?limit=0") >= 1, "(c) the reply ends");
  const after = core.db.listEvents(id);
  // the page holds the tail it read again in (b2) and the reply that came live
  await until(async () => (await rows()) === rowsOf(after.filter((e) => e.seq >= tailFirst)), `(c) ${rowsOf(after.filter((e) => e.seq >= tailFirst))} rows`);
  const railDot = await until(() => evaluate(`(() => { let on = false; for (const n of document.querySelectorAll('.rail-list > *')) { if (n.classList.contains('grp')) { on = n.textContent === 'Tasks'; continue; } if (on && n.querySelector('.t')?.textContent === 'long') return n.querySelector('.dot')?.className; } return null; })()`), "(c) the rail row");
  const listed = ((await (await fetch(`${base}/api/tasks`)).json()) as Task[]).find((t) => t.id === id)!;
  assert(listed.status === "done" && railDot === "dot idle", `(c) daemon ${listed.status}, rail ${railDot}`);
  await Bun.sleep(300);
  assert(detail("?limit=0") === 1 && detail("") === base2.whole && list() === base2.list, `(c) ?limit=0 ${detail("?limit=0")}, whole ${detail("")} (${base2.whole}), list ${list()} (${base2.list})`);

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ events: all.length, tailRows, pages, kept, allRows, afterReply: rowsOf(after.filter((e) => e.seq >= tailFirst)), refetchedAfterFailedCatchUp: base2.whole, requests: { list: list(), whole: detail(""), before: older(), limit0: detail("?limit=0") }, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
