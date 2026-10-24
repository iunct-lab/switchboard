/**
 * Run after `bun run --cwd apps/web build`: bun scripts/mobile-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The phone layout (#359): at 390 × 844 (iPhone 14), 844 × 390 (its landscape) and a PC window narrowed to 390px, the task list
 * opens from the bottom bar, a task opens from it, and the list opens again to go to another task. On a phone the task screen
 * does not scroll sideways with long lines in it, a reply and an approval reach the runner, and 詳細 opens the task's Brief.
 * Home's new-task form fits a phone and 開始 starts a task from it (#391). Knowledge stacks its list, the note and its
 * details, and a note picked from the list can be read (#392). Ledger, Backlog and Schedules (its form open too) do not
 * scroll sideways, and a schedule is added from a phone (#393). At 1280 and 390 the top bar's Rescue opens the rescue page
 * the daemon names (a fake sb-rescue standing in for the host's /rescue/, #399); when its answer comes late the tabs keep their
 * places and a tap before it lands on the tab, not on Rescue (#1485).
 * SCREENSHOT_DIR=<dir> saves Home and a task at 1280 × 800 first (compare them before and after a layout change).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-mobile-e2e-"));
const sent: string[] = [];
const started: string[] = [];
const answered: string[] = [];
/** One unbroken line, as a URL or a path in a runner's output is: it must wrap or scroll inside its box, not the page. */
const LONG = `https://example.com/${"a-very-long-path-segment/".repeat(12)}index.html`;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    started.push(opts.prompt);
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    // "mobile-long" stays open with a question: every reply is recorded and asks again.
    let asks = 0;
    const ask = () => emit({ t: "permission.ask", id: `p${++asks}`, kind: "write", tool: "Write", input: { file_path: LONG }, detail: `write ${LONG}` });
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: `reply to ${opts.prompt}${opts.prompt === "mobile-long" ? ` ${LONG}` : ""}` });
      if (opts.prompt === "mobile-long") {
        emit({ t: "tool.call", id: "t1", name: "Read", input: { file_path: LONG }, summary: LONG });
        emit({ t: "tool.result", id: "t1", ok: true, summary: LONG });
        ask();
        return;
      }
      // A model id with nothing to break at, as Ledger shows it in its task rows (#393).
      emit({ t: "usage", source: "reported", model: `claude-sonnet-5@${"0123456789abcdef".repeat(4)}`, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return {
      send(text) { sent.push(text); ask(); },
      respondPermission(id, decision) { answered.push(`${id}:${decision}`); emit({ t: "permission.resolved", id, decision, by: "user" }); },
      async abort() { exit(null); }, async close() { exit(0); }, exited,
    };
  },
};
// A note with a long unbroken line, for Knowledge (#392).
mkdirSync(join(home, "knowledge", "notes"), { recursive: true });
writeFileSync(join(home, "knowledge", "notes", "2026-09-27-mobile.md"), `---\ntitle: mobile note\ntags: [mobile]\n---\n# Mobile note\n\nRead on a phone.\n\n${LONG}\n`);
// A fake sb-rescue (#399): its status makes the daemon "managed", and its /rescue/ stands in for the host's rescue page.
let holdStatus: Promise<void> | null = null;
const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api/status" && holdStatus) await holdStatus;
  if (path === "/api/status") return Response.json({ current: "c".repeat(40), previous: null, state: "running", busy: null, lastError: null, history: [] });
  if (path === "/rescue/") return new Response("<!doctype html><title>救援画面</title><h1>救援画面</h1><button>作り直す</button>", { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("no", { status: 404 });
} });
const rescueOrigin = `http://127.0.0.1:${rescue.port}`;
const rescuePage = `${rescueOrigin}/rescue/`;
const cfg = loadConfig({ SWITCHBOARD_RESCUE_URL: rescueOrigin, SWITCHBOARD_WEB_URL: rescueOrigin, SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
// A title as long as people write them (#391): Home's lists must cut it, not widen their card.
const LONG_TITLE = "スマホアクセス版の画面が欲しい。PCからの表示は今のままでよいが、スマホからアクセスすると見づらいので最適化してほしい";
for (const title of ["mobile-a", "mobile-b", "mobile-long", LONG_TITLE]) {
  await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title, prompt: title, runner: "claude" }) });
}

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
  const visible = (selector: string) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`) as Promise<boolean>;
  const heading = () => evaluate(`document.querySelector('.main.task h2')?.textContent ?? null`) as Promise<string | null>;
  /** A tap on a phone, a click on a PC — at the element's centre, so something drawn over it gets the event instead. */
  const tap = async (expression: string, touch: boolean) => {
    const point = await evaluate(`(() => { const e = ${expression}; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (touch) {
      await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    }
  };
  const railTask = (title: string) => `[...document.querySelectorAll('.rail-list button.it')].find(b => b.querySelector('.t')?.textContent === ${JSON.stringify(title)})`;
  const size = async (width: number, height: number, mobile: boolean) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    await call("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`document.querySelectorAll('.rail-list button.it').length >= 2`), `task list at ${width}x${height}`);
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  // The PC layout first: 1280 × 800 keeps the rail's list, no 一覧 button.
  await size(1280, 800, false);
  const shots = process.env.SCREENSHOT_DIR;
  const shoot = async (name: string) => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await Bun.write(join(shots, name), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  await shoot("home-1280.png");
  await tap(railTask("mobile-a"), false);
  await until(async () => (await heading()) === "mobile-a" && (await evaluate(`document.querySelector('.transcript')?.textContent.includes('reply to mobile-a')`)), "task at 1280");
  await shoot("task-1280.png");
  const pc = { list: await visible(".rail-list"), button: await visible(".rail-tasks"), side: await visible(".side"), brief: await visible(".brief-toggle") };
  assert(pc.list && !pc.button && pc.side && !pc.brief, `1280: ${JSON.stringify(pc)}`);

  const results: Record<string, unknown> = { pc };
  // The rescue page (#399): Rescue in the top bar, on Home, inside the screen on a phone too; it opens the page the daemon names.
  for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]] as const) {
    const label = `rescue ${width}x${height}`;
    await size(width, height, mobile);
    const link = await until(() => evaluate(`(() => { const a = document.querySelector('header.chrome a.rescue-link'); if (!a || !document.querySelector('.main.home')) return null; const r = a.getBoundingClientRect(); return { href: a.href, text: a.textContent, inView: a.checkVisibility() && r.left >= 0 && r.right <= ${width} && r.top >= 0 && r.bottom <= ${height} }; })()`), `${label}: the link on Home`);
    assert(link.href === rescuePage && link.text === "Rescue" && link.inView, `${label}: ${JSON.stringify(link)}`);
    await tap(`document.querySelector('header.chrome a.rescue-link')`, mobile);
    await until(() => evaluate(`location.href === ${JSON.stringify(rescuePage)} && !!document.querySelector('h1')?.textContent.includes('救援画面') && !!document.querySelector('button')?.textContent.includes('作り直す')`), `${label}: the rescue page opens`);
    results[label] = { ...link, opened: rescuePage };
  }
  {
    // #1485: the link's answer is held, so the tabs are measured and tapped before it comes, then again after.
    const label = "rescue link arrives late 390x844";
    let release!: () => void;
    holdStatus = new Promise<void>((resolve) => { release = resolve; });
    const rects = () => evaluate(`(() => { document.querySelector('header.chrome nav')?.scrollTo(0, 0); const n = document.querySelector('header.chrome nav').getBoundingClientRect(); return JSON.stringify([['nav', n.x, n.width], ...[...document.querySelectorAll('header.chrome nav button')].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent, r.x, r.width]; })]); })()`) as Promise<string>;
    try {
      await size(390, 844, true);
      const before = await rects();
      assert(JSON.parse(before).length >= 6, `${label}: tabs ${before}`);
      assert(!(await evaluate(`!!document.querySelector('a.rescue-link')`)), `${label}: the link came before its answer`);
      // A tap before the answer lands on the tab, and the row has the width it will have after.
      await tap(`[...document.querySelectorAll('header.chrome nav button')].find((b) => b.textContent === 'Ledger')`, true);
      await until(() => evaluate(`!!document.querySelector('.main.ledger') && location.pathname === '/'`), `${label}: Ledger opens, not /rescue/`);
      release();
      await until(() => evaluate(`!!document.querySelector('a.rescue-link')`), `${label}: the link arrives`);
      await tap(`[...document.querySelectorAll('header.chrome nav button')].find((b) => b.textContent === 'Home')`, true);
      await until(() => evaluate(`!!document.querySelector('.main.home')`), `${label}: back on Home`);
      const after = await rects();
      assert(after === before, `${label}: tabs moved ${before} → ${after}`);
      results[label] = { tabs: "same before and after", ledger: "opened" };
    } finally { release(); holdStatus = null; }
  }
  for (const [width, height, mobile] of [[390, 844, true], [844, 390, true], [390, 844, false]] as const) {
    const label = `${width}x${height}${mobile ? "" : " (PC window)"}`;
    await size(width, height, mobile);
    const closed = { list: await visible(".rail-list"), button: await visible(".rail-tasks") };
    assert(!closed.list && closed.button, `${label} closed: ${JSON.stringify(closed)}`);
    await tap(`document.querySelector('.rail-tasks')`, mobile);
    await until(() => visible(".rail-list"), `${label}: the list opens`);
    await tap(railTask("mobile-a"), mobile);
    await until(async () => (await heading()) === "mobile-a" && !(await visible(".rail-list")), `${label}: mobile-a opens and the list closes`);
    await tap(`document.querySelector('.rail-tasks')`, mobile);
    await until(() => visible(".rail-list"), `${label}: the list opens again`);
    const short = await evaluate(`[...document.querySelectorAll('.rail-list button.it, .rail-tasks, .rail-approvals')].filter(b => b.getBoundingClientRect().height < 44).length`);
    assert(short === 0, `${label}: ${short} target(s) shorter than 44px`);
    await tap(railTask("mobile-b"), mobile);
    await until(async () => (await heading()) === "mobile-b" && !(await visible(".rail-list")), `${label}: mobile-b opens`);
    results[label] = "list → mobile-a → list → mobile-b";
  }

  // The task screen on a phone: long lines stay inside their boxes; a reply and an approval reach the runner.
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    const label = `task ${width}x${height}`;
    await size(width, height, true);
    await tap(`document.querySelector('.rail-tasks')`, true);
    await until(() => visible(".rail-list"), `${label}: the list opens`);
    await tap(railTask("mobile-long"), true);
    await until(async () => (await heading()) === "mobile-long" && (await visible(".perm")), `${label}: the question shows`);
    // The Read's detail, with the long line in it (the last row is the question's, whose detail is empty).
    await tap(`[...document.querySelectorAll('.tool .tool-row')].find(r => r.textContent.startsWith('Read'))`, true);
    await until(() => evaluate(`[...document.querySelectorAll('.tool-detail pre')].some(p => p.checkVisibility() && p.textContent.includes('index.html'))`), `${label}: the Read's detail opens`);
    // Neither the page nor the task screen (it scrolls by itself) may scroll sideways.
    const scrollWidth = await evaluate(`Math.max(document.documentElement.scrollWidth, (() => { const m = document.querySelector('.main.task'); return m.scrollWidth - m.clientWidth + ${width}; })())`) as number;
    const wide = scrollWidth > width ? await evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > ${width + 1}).slice(0, 6).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right))`) : [];
    assert(scrollWidth <= width, `${label}: scrolls sideways (${scrollWidth}): ${JSON.stringify(wide)}`);
    if (shots) await shoot(`task-${width}x${height}.png`);
    const short = await evaluate(`[...document.querySelectorAll('.perm .actions button, .composer button')].filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent)`) as string[];
    assert(short.length === 0, `${label}: shorter than 44px: ${JSON.stringify(short)}`);
    const reply = `from the phone at ${width}x${height}`;
    const cards = await evaluate(`document.querySelectorAll('.perm').length`) as number;
    await tap(`document.querySelector('.composer textarea')`, true);
    await call("Input.insertText", { text: reply });
    await tap(`[...document.querySelectorAll('.composer button.pri')].pop()`, true);
    await until(() => sent.includes(reply), `${label}: the reply reaches the runner`);
    await until(() => evaluate(`document.querySelectorAll('.perm').length === ${cards + 1}`), `${label}: the runner asks again`); // tap after the layout settles
    const before = answered.length;
    await tap(`document.querySelector('.perm .actions .pri')`, true);
    await until(() => answered.length === before + 1 && answered.at(-1)!.endsWith(":allow"), `${label}: allow reaches the runner`);
    await until(() => evaluate(`document.querySelectorAll('.perm').length === ${cards}`), `${label}: the answered card leaves`); // tap after the layout settles

    // The Brief (#369): hidden beside the chat on a phone, 詳細 lays it over the screen and 閉じる goes back.
    assert(!(await visible(".side")), `${label}: the Brief shows before 詳細`);
    await tap(`document.querySelector('.brief-toggle')`, true);
    await until(() => visible(".side"), `${label}: 詳細 opens the Brief`);
    const brief = await evaluate(`(() => { const s = document.querySelector('.side'); const r = s.getBoundingClientRect(); return { text: s.textContent.includes('Task の概要') && s.textContent.includes('Claude'), width: Math.round(r.width) }; })()`);
    assert(brief.text && brief.width === width, `${label}: Brief ${JSON.stringify(brief)}`);
    if (shots) await shoot(`brief-${width}x${height}.png`);
    await tap(`document.querySelector('.brief-close')`, true);
    await until(async () => !(await visible(".side")) && (await visible(".transcript")), `${label}: 閉じる goes back to the chat`);
    // The tabs stay above it, and a task opened after leaving opens without it.
    await tap(`document.querySelector('.brief-toggle')`, true);
    await until(() => visible(".side"), `${label}: 詳細 again`);
    await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'Home')`, true);
    await until(async () => (await heading()) === null && !(await visible(".side")), `${label}: Home from the tabs over the Brief`);
    await tap(`document.querySelector('.rail-tasks')`, true);
    await until(() => visible(".rail-list"), `${label}: the list opens`);
    await tap(railTask("mobile-a"), true);
    await until(async () => (await heading()) === "mobile-a", `${label}: mobile-a opens`);
    assert(!(await visible(".side")), `${label}: mobile-a opens with the Brief over it`);
    results[label] = { scrollWidth, sent: reply, answered: answered.at(-1), brief: "詳細 → Brief → 閉じる" };
  }

  // Home (#391): the new-task form is one column that fits the screen, and 開始 starts a task from it.
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    const label = `home ${width}x${height}`;
    await size(width, height, true);
    const sideways = await evaluate(`(() => { const m = document.querySelector('.main.home'); return { over: Math.max(document.documentElement.scrollWidth - ${width}, m.scrollWidth - m.clientWidth), wide: [...m.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > ${width + 1}).slice(0, 6).map(e => e.tagName + '.' + e.className) }; })()`);
    assert(sideways.over <= 0, `${label}: scrolls sideways by ${sideways.over}: ${JSON.stringify(sideways.wide)}`);
    const short = await evaluate(`[...document.querySelectorAll('.compose > .row > button')].filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent)`) as string[];
    assert(short.length === 0, `${label}: shorter than 44px: ${JSON.stringify(short)}`);
    if (shots) await shoot(`home-${width}x${height}.png`);
    // A registered Workspace, so 開始 does not ask a runner to pick one.
    assert(await evaluate(`document.querySelector('.compose .fields select').options.length > 1`), `${label}: no registered Workspace to pick`);
    await evaluate(`(() => { const s = document.querySelector('.compose .fields select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, s.options[1].value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const text = `started from Home at ${width}x${height}`;
    await tap(`document.querySelector('.compose textarea')`, true);
    await call("Input.insertText", { text });
    await tap(`document.querySelector('.compose > .row > button.pri')`, true);
    await until(() => started.some((p) => p.includes(text)), `${label}: 開始 reaches the runner`);
    await until(async () => (await heading()) === text, `${label}: the new task opens`); // untitled: the title is the prompt (Home.tsx takes its first 48 characters)
    results[label] = { sideways: sideways.over, started: text };
  }

  // Knowledge (#392): the list, the note and its details one under another; a note picked from the list can be read.
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    const label = `knowledge ${width}x${height}`;
    await size(width, height, true);
    await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'Knowledge')`, true);
    await until(() => evaluate(`!!document.querySelector('.kn-tree button.it')`), `${label}: the list`);
    await tap(`[...document.querySelectorAll('.kn-tree button.it')].find(b => b.textContent.includes('mobile note'))`, true);
    await until(() => evaluate(`!!document.querySelector('.kn-doc .kn-body')?.textContent.includes('Read on a phone')`), `${label}: the note shows`);
    const layout = await evaluate(`(() => { const m = document.querySelector('.main.knowledge'); const list = document.querySelector('.kn-list').getBoundingClientRect(), doc = document.querySelector('.kn-doc').getBoundingClientRect(), mat = document.querySelector('.kn-mat').getBoundingClientRect(); return { over: Math.max(document.documentElement.scrollWidth - ${width}, m.scrollWidth - m.clientWidth), below: doc.top >= list.bottom && mat.top >= doc.bottom, short: [...document.querySelectorAll('.kn-tree .it')].filter(b => b.getBoundingClientRect().height < 44).length, wide: [...m.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > ${width + 1} && !e.closest('.kn-body, .diff')).slice(0, 6).map(e => e.tagName + '.' + e.className) }; })()`);
    assert(layout.over <= 0 && layout.below && layout.short === 0, `${label}: ${JSON.stringify(layout)}`); // list, note, details in that order; 44px items
    if (shots) await shoot(`knowledge-${width}x${height}.png`);
    results[label] = { sideways: layout.over, listNoteDetails: layout.below, itemsUnder44px: layout.short };
  }

  // Ledger, Backlog, Schedules (#393): nothing scrolls sideways (a table only inside itself); a schedule is added.
  const overflow = (width: number) => evaluate(`(() => { const m = document.querySelector('.main'); return { over: Math.max(document.documentElement.scrollWidth - ${width}, m.scrollWidth - m.clientWidth), wide: [...m.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > ${width + 1} && !e.closest('table')).slice(0, 6).map(e => e.tagName + '.' + e.className) }; })()`);
  const openTab = async (name: string, cls: string) => {
    await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent === ${JSON.stringify(name)})`, true);
    await until(() => evaluate(`!!document.querySelector('.main.${cls}')`), `${name} opens`);
    await Bun.sleep(500); // its data (the ledger, gh's answer) lands after the first paint
  };
  for (const [width, height] of [[390, 844], [844, 390]] as const) {
    const label = `screens ${width}x${height}`;
    await size(width, height, true);
    const measured: Record<string, number> = {};
    for (const [name, cls] of [["Ledger", "ledger"], ["Backlog", "backlog"], ["Schedules", "schedules"]] as const) {
      await openTab(name, cls);
      if (cls === "ledger") await until(() => evaluate(`[...document.querySelectorAll('.ledger .row .hint.mono')].some(e => e.textContent.includes('0123456789abcdef'))`), `${label}: Ledger shows the long model id`);
      if (cls === "schedules") {
        await tap(`[...document.querySelectorAll('.schedules .card .row.head button')].find(b => b.textContent.includes('追加'))`, true);
        await until(() => evaluate(`!!document.querySelector('.schedules .fields textarea')`), `${label}: the schedule form opens`);
      }
      const o = await overflow(width);
      assert(o.over <= 0, `${label}: ${name} scrolls sideways by ${o.over}: ${JSON.stringify(o.wide)}`);
      if (shots) await shoot(`${cls}-${width}x${height}.png`);
      measured[name] = o.over;
    }
    if (width === 390) {
      const short = await evaluate(`[...document.querySelectorAll('.schedules .fields button')].filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent)`) as string[];
      assert(short.length === 0, `${label}: shorter than 44px: ${JSON.stringify(short)}`);
      const name = "phone schedule";
      await tap(`document.querySelector('.schedules .fields input:not(.mono)')`, true);
      await call("Input.insertText", { text: name });
      await tap(`document.querySelector('.schedules .fields textarea')`, true);
      await call("Input.insertText", { text: "added from a phone" });
      await tap(`document.querySelector('.schedules .fields button.pri')`, true);
      await until(() => evaluate(`[...document.querySelectorAll('.schedules .row .t')].some(t => t.textContent.includes(${JSON.stringify(name)}))`), `${label}: the schedule is listed`);
      const listed = await overflow(width); // the new schedule's row (cron, next run, three buttons) fits too
      assert(listed.over <= 0, `${label}: the schedule row scrolls sideways by ${listed.over}: ${JSON.stringify(listed.wide)}`);
      measured.added = 1;
    }
    results[label] = measured;
  }
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ...results, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rescue.stop(true);
  rmSync(home, { recursive: true, force: true });
}
