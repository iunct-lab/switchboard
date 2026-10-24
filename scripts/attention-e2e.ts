/**
 * Run after `bun run --cwd apps/web build`: bun scripts/attention-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * 要対応 (#492) in and out, in one go: a fake runner stops three tasks as 要対応 / 失敗 / 未判定; Home and the rail list
 * them; 確認済み on the Task screen moves one to Home's 最近, taking it back returns it, and setting its outcome to
 * 要対応 moves it to the top, and to 完了 moves it out to 最近. 実行中 sits above 要対応 on both. SCREENSHOT=<file.png> saves Home with the three; SCREENSHOT_TASK=<file.png> the Task screen.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-attention-e2e-"));
// prompt `ask` → waits on a permission; `err` → ends in error; `ok` → ends ok
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      if (opts.prompt === "ask") return void emit({ t: "permission.ask", id: "p1", kind: "write", tool: "Write", input: { file_path: "src/a.ts" }, detail: "write src/a.ts" });
      emit({ t: "message.delta", role: "assistant", text: `reply to ${opts.prompt}` });
      emit({ t: "session.end", status: opts.prompt === "err" ? "error" : "ok", summary: opts.prompt });
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
const tasks = async () => (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
// ok last: the newest, so when it is set to 要対応 it goes above ask
for (const p of ["ask", "err", "ok"]) {
  await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: `task-${p}`, prompt: p, runner: "claude" }) });
  await until(async () => (await tasks()).find((t) => t.title === `task-${p}` && t.status !== "running" && t.status !== "idle"), `task-${p} stopped`);
  await Bun.sleep(5);
}
const outcomes = Object.fromEntries((await tasks()).map((t) => [t.title, `${t.status}/${t.outcome}`]));
assert(JSON.stringify(outcomes) === JSON.stringify({ "task-ok": "done/unknown", "task-err": "error/failed", "task-ask": "waiting/needs_action" }), `outcomes: ${JSON.stringify(outcomes)}`);

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const page = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const shot = async (file: string | undefined) => { if (file) await Bun.write(file, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64")); };
  // The rows of a group: rail = the `.it` rows after the 要対応 heading up to the next heading; Home = the card's rows
  // between its 要対応 and 最近 headings, and those after 最近. Titles only. `order` = the headings, top to bottom.
  const lists = `(() => {
    const after = (nodes, isStart, isEnd) => { const out = []; let on = false; for (const n of nodes) { if (isStart(n)) { on = true; continue; } if (on && isEnd(n)) break; if (on) out.push(n.querySelector('.t')?.textContent ?? ''); } return out.filter(Boolean); };
    const rail = [...document.querySelectorAll('.rail-list > *')];
    const card = [...document.querySelectorAll('.card')].find((c) => [...c.querySelectorAll('h5')].some((h) => h.textContent.startsWith('要対応')));
    const kids = card ? [...card.children] : [];
    return {
      rail: after(rail, (n) => n.classList.contains('grp') && n.textContent.startsWith('要対応'), (n) => n.classList.contains('grp')),
      home: after(kids, (n) => n.tagName === 'H5' && n.textContent.startsWith('要対応'), (n) => n.tagName === 'H5'),
      recent: after(kids, (n) => n.tagName === 'H5' && n.textContent === '最近', (n) => n.tagName === 'H5'),
      onHome: !!card,
      order: { rail: rail.filter((n) => n.classList.contains('grp')).map((n) => n.textContent.split(' · ')[0]), home: kids.filter((n) => n.tagName === 'H5').map((n) => n.textContent.split(' · ')[0]) },
    };
  })()`;
  const state = async () => (await evaluate(lists)) as { rail: string[]; home: string[]; recent: string[]; onHome: boolean; order: { rail: string[]; home: string[] } };
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const click = (js: string, label: string) => until(() => evaluate(`(() => { const el = ${js}; if (!el || el.disabled) return false; el.click(); return true; })()`), label);
  const openFromRail = (title: string) => click(`[...document.querySelectorAll('.rail-list button.it')].find((b) => b.querySelector('.t')?.textContent === ${JSON.stringify(title)})`, `open ${title}`);
  const goHome = () => click(`[...document.querySelectorAll('button, a')].find((b) => b.textContent.trim() === 'Home')`, "Home tab");

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `${base}/` });

  // (a) the three under 要対応, in outcome order, on Home and in the rail; 最近 empty
  const a = await until(async () => { const s = await state(); return s.home.length === 3 && s.rail.length === 3 && s; }, "three under 要対応");
  assert(same(a.home, ["task-ask", "task-err", "task-ok"]) && same(a.rail, a.home) && a.recent.length === 0, `(a) ${JSON.stringify(a)}`);
  assert(same(a.order.rail.slice(0, 2), ["Running", "要対応"]) && same(a.order.home.slice(0, 2), ["実行中", "要対応"]), `(a) order ${JSON.stringify(a.order)}`);
  await shot(process.env.SCREENSHOT);

  // (b) open task-ok, 確認済みにする → out of 要対応, into Home's 最近
  await openFromRail("task-ok");
  await click(`[...document.querySelectorAll('.task-head button.review-toggle')].find((b) => b.textContent === '確認済みにする')`, "確認済みにする");
  await until(() => evaluate(`document.querySelector('.task-head button.review-toggle')?.textContent === '確認済みを取り消す'`), "button flips");
  await shot(process.env.SCREENSHOT_TASK);
  const bRail = await until(async () => { const s = await state(); return s.rail.length === 2 && s; }, "rail drops task-ok");
  await goHome();
  const b = await until(async () => { const s = await state(); return s.onHome && s.home.length === 2 && s; }, "Home drops task-ok");
  assert(same(bRail.rail, ["task-ask", "task-err"]) && same(b.home, ["task-ask", "task-err"]) && b.recent.includes("task-ok"), `(b) ${JSON.stringify({ rail: bRail.rail, ...b })}`);
  assert((await tasks()).find((t) => t.title === "task-ok")!.reviewedAt !== null, "(b) reviewedAt stored");

  // (c) take it back → under 要対応 again, gone from 最近
  await openFromRail("task-ok");
  await click(`[...document.querySelectorAll('.task-head button.review-toggle')].find((b) => b.textContent === '確認済みを取り消す')`, "確認済みを取り消す");
  await until(async () => (await state()).rail.length === 3, "rail has task-ok again");
  await goHome();
  const c = await until(async () => { const s = await state(); return s.onHome && s.home.length === 3 && s; }, "Home has task-ok again");
  assert(same(c.home, ["task-ask", "task-err", "task-ok"]) && !c.recent.includes("task-ok"), `(c) ${JSON.stringify(c)}`);

  // (d) set task-ok's outcome to 要対応 → first under 要対応 (newest of the 要対応 ones)
  await openFromRail("task-ok");
  await until(() => evaluate(`(() => { const s = document.querySelector('.task-head select.outcome'); if (!s || s.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'needs_action'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), "outcome select");
  const dRail = await until(async () => { const s = await state(); return s.rail[0] === "task-ok" && s; }, "task-ok first in the rail");
  await goHome();
  const d = await until(async () => { const s = await state(); return s.onHome && s.home[0] === "task-ok" && s; }, "task-ok first on Home");
  assert(same(d.home, ["task-ok", "task-ask", "task-err"]) && same(dRail.rail, d.home), `(d) ${JSON.stringify({ rail: dRail.rail, ...d })}`);
  assert((await tasks()).find((t) => t.title === "task-ok")!.outcome === "needs_action", "(d) outcome stored");

  // (e) set task-ok's outcome to 完了 → out of 要対応 (still not 確認済み), into Home's 最近
  await openFromRail("task-ok");
  await until(() => evaluate(`(() => { const s = document.querySelector('.task-head select.outcome'); if (!s || s.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'done'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), "outcome select");
  const eRail = await until(async () => { const s = await state(); return s.rail.length === 2 && s; }, "rail drops task-ok (完了)");
  await goHome();
  const e = await until(async () => { const s = await state(); return s.onHome && s.home.length === 2 && s; }, "Home drops task-ok (完了)");
  assert(same(e.home, ["task-ask", "task-err"]) && same(eRail.rail, e.home) && e.recent.includes("task-ok"), `(e) ${JSON.stringify({ rail: eRail.rail, ...e })}`);
  const ok = (await tasks()).find((t) => t.title === "task-ok")!;
  assert(ok.outcome === "done" && ok.reviewedAt === null, `(e) stored ${ok.outcome} ${ok.reviewedAt}`);

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ outcomes, a, b: { rail: bRail.rail, home: b.home, recent: b.recent }, c: { home: c.home, recent: c.recent }, d: { rail: dRail.rail, home: d.home }, e: { rail: eRail.rail, home: e.home, recent: e.recent }, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
