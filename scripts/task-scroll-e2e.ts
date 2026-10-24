/**
 * Run after `bun run --cwd apps/web build`: bun scripts/task-scroll-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * A long task (#1311): a fake runner answers in 60 turns (a reply of two or three lines, a tool call and its result each),
 * and the task is opened at 1280 × 800 and at 390 × 844 (mobile). At each size: (a) right after opening, the end of the
 * conversation is on screen; (b) scrolled to the end, the task's head is still inside the scroll area and its ターミナル
 * tab is the element hit at its centre and switches to the terminal, 会話 back; (e) the task's instruction is read in full
 * in the Brief (beside the chat on a PC, after 詳細 on a phone) and the chat stays at its end; (f) 最新へ is absent at the
 * end, shows inside the scroll area once scrolled to the top, and one click brings the end back and hides it; (d) nothing scrolls
 * sideways; and at 390 × 844 (c) the head takes at most a third of the screen's height. Prints one `ok` line per check; a failure throws.
 * SCREENSHOT_DIR=<dir> saves each size scrolled to the end. Not in CI, like copy-e2e: it needs Chrome.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-task-scroll-e2e-"));
const TITLE = `task-scroll ${"とても長い題名の Task ".repeat(20)}`; // wraps to many lines on a phone: the stuck head must still stay short
const PROMPT = ["最初の指示 長い Task の見出しを確かめる", "1 行目: 見出しは末尾でも見える", "2 行目: 指示文は上へ戻らずに読める", "3 行目: 最新へ で末尾に戻る", "4 行目: スマホ幅でも同じ", "5 行目: 横にはみ出さない"].join("\n");
const TURNS = 60;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-scroll", cwd: opts.cwd });
      emit({ t: "message.delta", role: "user", text: opts.prompt });
      for (let i = 1; i <= TURNS; i++) {
        for (const ev of [
          { t: "message.delta", role: "assistant", text: `ターン ${i} の返答\n調べた結果をまとめる${i % 2 ? "\n次は Read で確かめる" : ""}` },
          { t: "tool.call", id: `t${i}`, name: "Read", input: { file_path: `src/file-${i}.ts` }, summary: `src/file-${i}.ts` },
          { t: "tool.result", id: `t${i}`, ok: true, summary: `file ${i}` },
        ] as AgentEvent[]) emit(ev);
      }
      emit({ t: "message.delta", role: "assistant", text: "最後の返答" });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined) });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: TITLE, prompt: PROMPT, runner: "claude" }) });

/** A CDP connection to the page. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, call, errors };
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let socket: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  const { ws, call, errors } = await connect(page.webSocketDebuggerUrl);
  socket = ws;
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const ok = (label: string, detail: unknown = "") => console.log(`ok ${label} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.trimEnd());
  /** Whether `sel`'s first element lies inside `.main`'s visible box (1px slack for rounding). */
  const inMain = (sel: string) => evaluate(`(() => {
    const m = document.querySelector('.main.task').getBoundingClientRect(), e = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
    return !!e && e.top >= m.top - 1 && e.bottom <= m.bottom + 1 && e.left >= m.left - 1 && e.right <= m.right + 1;
  })()`) as Promise<boolean>;
  const frames = () => evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  /** Clicks the subtab named `label` where a finger would: the element at its centre must be the button itself. */
  const tap = async (label: string) => {
    const hit = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.task-head .subtabs button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return 'no button';
      const r = b.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (at !== b && !b.contains(at)) return 'covered by ' + (at?.className || at?.tagName);
      b.click();
      return 'ok';
    })()`);
    assert(hit === "ok", `${label}: ${hit}`);
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]] as const) {
    const size = `${width}x${height}`;
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    await call("Page.navigate", { url: base });
    // A phone opens the task list from the bottom bar; a PC window shows it in the rail.
    await until(() => evaluate(`!!document.querySelector('.rail-tasks')`), "rail");
    if (mobile) await evaluate(`document.querySelector('.rail-tasks').click()`);
    await until(() => evaluate(`(() => { const b = [...document.querySelectorAll('.rail-list button.it')].find((b) => b.title.startsWith(${JSON.stringify(TITLE)})); b?.click(); return !!b; })()`), `open ${TITLE}`);
    await until(() => evaluate(`document.querySelector('.end.ok') !== null && document.querySelectorAll('.msg.assistant').length === ${TURNS + 1}`), "the whole conversation");
    await frames();

    // (a) right after opening, the end of the conversation is on screen
    assert(await inMain(".transcript > :last-child"), `${size}: the end of the conversation is not on screen after opening`);
    ok(`(a) ${size} opens at the end`, await evaluate(`(() => { const m = document.querySelector('.main.task'); return { scrollTop: Math.round(m.scrollTop), scrollHeight: m.scrollHeight }; })()`));

    // (b) scrolled to the end, the head is on screen and its ターミナル tab switches the pane
    await evaluate(`(() => { const m = document.querySelector('.main.task'); m.scrollTop = m.scrollHeight; })()`);
    await frames();
    assert(await inMain(".task-head"), `${size}: the task head is out of view at the end`);
    if (process.env.SCREENSHOT_DIR) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(process.env.SCREENSHOT_DIR, `task-scroll-${size}.png`), Buffer.from(shot.data, "base64"));
    }
    await tap("ターミナル");
    await until(() => evaluate(`(() => { const p = document.querySelector('.terminal-pane'); return !!p && !p.hidden; })()`), `${size}: the terminal pane`);
    await tap("会話");
    await until(() => evaluate(`!document.querySelector('.transcript').hidden && document.querySelector('.terminal-pane').hidden`), `${size}: back to 会話`);
    ok(`(b) ${size} head at the end`, await evaluate(`(() => { const r = document.querySelector('.task-head').getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; })()`));

    // (e) at the end, the task's instruction is read in full from the Brief: beside the chat on a PC, after 詳細 on a phone
    const atEnd = () => evaluate(`(() => { const m = document.querySelector('.main.task'); return m.scrollHeight - m.scrollTop - m.clientHeight <= 1; })()`) as Promise<boolean>;
    await evaluate(`(() => { const m = document.querySelector('.main.task'); m.scrollTop = m.scrollHeight; })()`); // the terminal tab in (b) shrank the scroll
    await frames();
    assert(await atEnd(), `${size}: not at the end before (e)`);
    if (mobile) {
      await evaluate(`document.querySelector('.task-head .brief-toggle').click()`);
      await until(() => evaluate(`document.querySelector('.side')?.classList.contains('open')`), `${size}: 詳細 opens the Brief`);
    }
    const shown = await evaluate(`(() => {
      const t = document.querySelector('.side .brief-instruction .tx'), r = t?.getBoundingClientRect();
      return t ? { text: t.innerText, inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 0 } : null;
    })()`) as { text: string; inside: boolean } | null;
    assert(shown?.text === PROMPT, `${size}: the Brief's instruction is ${JSON.stringify(shown?.text)}`);
    assert(shown.inside, `${size}: the Brief's instruction is off screen`);
    if (mobile) {
      if (process.env.SCREENSHOT_DIR) {
        const shot = await call("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(process.env.SCREENSHOT_DIR, `task-scroll-${size}-brief.png`), Buffer.from(shot.data, "base64"));
      }
      await evaluate(`document.querySelector('.side .brief-close').click()`);
      await until(() => evaluate(`!document.querySelector('.side')?.classList.contains('open')`), `${size}: 閉じる`);
    }
    assert(await atEnd(), `${size}: reading the instruction moved the chat off its end`);
    ok(`(e) ${size} instruction in the Brief`, `${shown.text.split("\n").length} lines${mobile ? ", 詳細 → 閉じる" : ""}, still at the end`);

    // (f) 最新へ: not there at the end; scrolled to the top it shows inside `.main`, and one click brings the end back
    assert(!(await evaluate(`!!document.querySelector('.jump-latest')`)), `${size}: 最新へ is shown at the end`);
    await evaluate(`document.querySelector('.main.task').scrollTop = 0`);
    await until(() => evaluate(`!!document.querySelector('.jump-latest')`), `${size}: 最新へ after scrolling up`);
    await frames();
    assert(await inMain(".jump-latest"), `${size}: 最新へ is out of view`);
    const fill = await evaluate(`getComputedStyle(document.querySelector('.jump-latest')).backgroundColor`) as string;
    assert(fill !== "rgba(0, 0, 0, 0)" && fill !== "transparent", `${size}: 最新へ is see-through (${fill})`);
    // a round trip through 差分 from halfway up keeps it (the short 差分 tab clamps the scroll): the end is still out of view
    await evaluate(`(() => { const m = document.querySelector('.main.task'); m.scrollTop = m.scrollHeight / 2; })()`);
    await frames();
    await tap("差分");
    await until(() => evaluate(`document.querySelector('.transcript').hidden`), `${size}: 差分`);
    await frames(); // the clamped scroll's event lands while 差分 is shown
    await tap("会話");
    await until(() => evaluate(`!!document.querySelector('.jump-latest')`), `${size}: 最新へ after 差分 → 会話`);
    await frames();
    if (mobile && process.env.SCREENSHOT_DIR) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(process.env.SCREENSHOT_DIR, `task-scroll-${size}-latest.png`), Buffer.from(shot.data, "base64"));
    }
    const jump = await evaluate(`(() => {
      const b = document.querySelector('.jump-latest'), r = b.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (at !== b && !b.contains(at)) return 'covered by ' + (at?.className || at?.tagName);
      b.click();
      return 'ok';
    })()`);
    assert(jump === "ok", `${size}: 最新へ ${jump}`);
    await until(() => evaluate(`!document.querySelector('.jump-latest')`), `${size}: 最新へ goes away at the end`);
    assert(await inMain(".transcript > :last-child"), `${size}: 最新へ did not bring the end into view`);
    ok(`(f) ${size} 最新へ`, `absent at the end → shown at the top (${fill}), also after 差分 → 会話 from halfway → click → end in view, gone`);

    // (d) nothing scrolls sideways
    const widths = await evaluate(`(() => { const m = document.querySelector('.main.task'); return { page: document.documentElement.scrollWidth, main: m.scrollWidth, client: m.clientWidth }; })()`) as { page: number; main: number; client: number };
    assert(widths.page <= width && widths.main <= widths.client, `${size}: scrolls sideways ${JSON.stringify(widths)}`);
    ok(`(d) ${size} no sideways scroll`, widths);

    if (!mobile) continue;
    // (c) the stuck head is at most a third of a phone's screen
    const head = await evaluate(`document.querySelector('.task-head').getBoundingClientRect().height`) as number;
    assert(head <= height / 3, `${size}: the head is ${head}px tall, more than ${height / 3}px`);
    ok(`(c) ${size} head height`, `${Math.round(head)}px <= ${Math.round(height / 3)}px`);
  }

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
} finally {
  socket?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
