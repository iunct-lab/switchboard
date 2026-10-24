/**
 * Run after `bun run --cwd apps/web build`: CHROME_BIN=/usr/local/bin/chromium bun scripts/schedules-e2e.ts.
 * Editing a schedule from its row (#1480) in the real screen: the form opens with the registered values (the kind is
 * shown, not an input), 「やめる」 sends nothing, a bad cron shows the error and leaves the row, a save changes only the
 * row's fields (same id, the nightly result's scheduleTitle follows), and a backlog-next row keeps its Workspace on meta.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-schedules-e2e-"));
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }), efforts: [{ value: "high", label: "high" }], models: [{ value: "e2e-model", label: "e2e-model" }],
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-sched", cwd: opts.cwd });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
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
const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;

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
  const cspErrors: unknown[] = []; // kept apart: the 40x waiver below must not swallow a CSP violation
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") cspErrors.push(m);
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

  // Setup: a prompt schedule (fired once, so the nightly results list it) and a backlog-next one that is never fired
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const made = await post("/api/schedules", { title: "編集前", cron: "0 3 * * *", workspaceId: meta.id, runner: "claude", model: "e2e-model", effort: "high", prompt: "夜の確認", budgetUsd: 2 });
  const sweep = await post("/api/schedules", { title: "待ちの E2E", cron: "0 0 1 1 *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next" });
  assert(made.id && sweep.id, "schedules created");
  await post(`/api/schedules/${made.id}/run`, {});
  await until(async () => (await get("/api/queue")).scheduled.some((s: any) => s.scheduleTitle === "編集前"), "the nightly result");
  await call("Page.navigate", { url: `${base}/` });
  await until(() => evaluate(`!!document.querySelector('.conn.ok')`), "connected");
  const tabButton = `[...document.querySelectorAll('.tabs button')].find(b => b.textContent.trim() === 'Schedules')`;
  await until(() => evaluate(`!!${tabButton}`), "the Schedules tab");
  await tap(tabButton);
  await until(() => evaluate(`!!document.querySelector('main.schedules')`), "the Schedules screen");
  const rowOf = (title: string) => `[...document.querySelectorAll('main.schedules .card .row')].find(r => r.tagName === 'DIV' && r.querySelector('.t')?.textContent.startsWith('${title}') && !!r.querySelector('.mono.hint'))`;
  const editOf = async (title: string) => {
    const button = `[...${rowOf(title)}.querySelectorAll('button')].find(b => b.textContent.trim() === '編集')`;
    await until(() => evaluate(`!!${rowOf(title)} && !!${button}`), `the 編集 button of ${title}`);
    await tap(button);
  };
  const form = `document.querySelector('.schedule-edit')`;
  const fieldOf = (label: string) => `[...${form}.querySelectorAll('label')].find(l => l.textContent.startsWith('${label}')).querySelector('input,select')`;
  const setValue = (el: string, value: string) => evaluate(`(() => { const e = ${el}; const proto = e.tagName === 'SELECT' ? HTMLSelectElement : HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  const press = (text: string) => tap(`[...${form}.querySelectorAll('button')].find(b => b.textContent.trim() === '${text}')`);

  // 1: the form holds the registered values; the kind is a label, not an input
  await until(() => evaluate(`!!${rowOf("編集前")}`), "the row");
  await editOf("編集前");
  await until(() => evaluate(`!!${form}`), "the edit form");
  const values = await evaluate(`({ title: ${fieldOf("タイトル")}.value, cron: ${fieldOf("cron")}.value, budget: ${fieldOf("予算")}.value, prompt: ${form}.querySelector('textarea').value, runner: ${fieldOf("ランナー")}.value, workspace: ${fieldOf("Workspace")}.value, model: ${form}.querySelector('select[aria-label="モデル"]').value, effort: ${form}.querySelector('select[aria-label="思考の深さ"]').value, kindIsInput: !!${form}.querySelector('select option[value="backlog-next"]') })`);
  assert(values.title === "編集前" && values.cron === "0 3 * * *" && values.budget === "2" && values.prompt === "夜の確認" && values.runner === "claude" && values.workspace === meta.id && values.model === "e2e-model" && values.effort === "high" && !values.kindIsInput, `values: ${JSON.stringify(values)}`);
  console.log("1 form values match:", JSON.stringify(values));

  // 7: 「やめる」 after a change sends nothing
  await setValue(fieldOf("タイトル"), "やめる前");
  await press("やめる");
  await until(() => evaluate(`!${form}`), "the form closes");
  assert((await get("/api/schedules")).find((s: any) => s.id === made.id).title === "編集前", "title unchanged after やめる");
  console.log("7 やめる sends nothing");

  // 5: a bad cron shows the error and leaves the row
  await editOf("編集前");
  await until(() => evaluate(`!!${form}`), "the edit form again");
  await setValue(fieldOf("cron"), "bad");
  await press("保存");
  await until(() => evaluate(`!!document.querySelector('.banner.error[role=alert]')`), "the error banner");
  assert((await get("/api/schedules")).find((s: any) => s.id === made.id).cron === "0 3 * * *", "cron unchanged after the error");
  console.log("5 bad cron: error shown, row unchanged");

  // 2: a good edit changes the row; id and the nightly result's schedule name follow
  const before = (await get("/api/schedules")).find((s: any) => s.id === made.id);
  await setValue(fieldOf("cron"), "30 4 * * *");
  await setValue(fieldOf("タイトル"), "編集後");
  await press("保存");
  await until(() => evaluate(`!${form} && ${rowOf("編集後")}?.textContent.includes('30 4 * * *')`), "the row shows the new values");
  const shownNext = await evaluate(`${rowOf("編集後")}.textContent`);
  const after = (await get("/api/schedules")).find((s: any) => s.id === made.id);
  assert(after && after.cron === "30 4 * * *" && after.title === "編集後" && after.nextRunAt !== before.nextRunAt, `after: ${JSON.stringify(after)}`);
  // formatted in Chrome, the locale the screen uses
  const [afterText, beforeText] = await evaluate(`[${after.nextRunAt}, ${before.nextRunAt}].map((t) => new Date(t).toLocaleString())`);
  assert(shownNext.includes(afterText) && !shownNext.includes(beforeText), `row 次回: ${shownNext}`);
  const queue = await get("/api/queue");
  assert(queue.scheduled.some((s: any) => s.scheduleId === made.id && s.scheduleTitle === "編集後"), `queue: ${JSON.stringify(queue.scheduled)}`);
  console.log("2 saved: same id, new cron/title/next, scheduleTitle follows");

  // 6: backlog-next keeps its Workspace on meta and has no prompt box
  await editOf("待ちの E2E");
  await until(() => evaluate(`!!${form}`), "the backlog-next edit form");
  const wsField = await evaluate(`({ disabled: ${fieldOf("Workspace")}.disabled, value: ${fieldOf("Workspace")}.value, prompt: !!${form}.querySelector('textarea') })`);
  assert(wsField.disabled && wsField.value === meta.id && !wsField.prompt, `workspace: ${JSON.stringify(wsField)}`);
  console.log("6 backlog-next: Workspace disabled on meta, no prompt");
  assert(!cspErrors.length, `CSP violations: ${JSON.stringify(cspErrors)}`);
  assert(!errors.length || errors.every((m: any) => /40\d/.test(JSON.stringify(m))), `console errors: ${JSON.stringify(errors)}`);
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
