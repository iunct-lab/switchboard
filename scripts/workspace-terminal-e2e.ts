/**
 * Run after `bun run --cwd apps/web build`: bun scripts/workspace-terminal-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * A Workspace's shell with no Task: at 1280 × 800 and 390 × 844 (a phone) the Rail's 「ターミナル」 on a Workspace row (on a
 * phone, in the list the bottom bar opens) opens the shell in that Workspace's path; `pwd` typed into it prints the path;
 * going to Home and back (the socket closes and connects again) shows the earlier `pwd` output; and no Task is made until the last step.
 * Each size starts from a new shell, so the phone's run cannot pass on the output the PC's run left.
 * The page, the terminal and the screen's text are small functions (openPage, openWorkspaceTerminal, terminalScreen,
 * typeInTerminal, goHome) so a later check on the same screen can reuse them.
 * The row of keys under the terminal (the keys a phone's keyboard lacks): at 1280 × 800 it is not shown; at 390 × 844, with
 * `cat -vT` (-T shows a Tab as ^I) running in the Workspace's shell, tapping ↑ ↓ ← → Esc Tab Enter prints their sequences and ^C ends `cat`. Then
 * one local Task is made (the only moment the daemon has one) and its Terminal tab, at 390 × 844, shows the row and ↓ arrives.
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}

// A plain `sh` with its own prompt: the Workspace's path appears on the screen only once `pwd` has printed it.
process.env.SHELL = "/bin/sh";
const home = mkdtempSync(join(tmpdir(), "sb-wst-e2e-"));
const workspacePath = join(realpathSync(home), "ws");
mkdirSync(workspacePath);
const git = (...args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd: workspacePath, stdout: "ignore", stderr: "pipe" }); assert(r.exitCode === 0, `git ${args.join(" ")}: ${r.stderr}`); };
git("init", "-b", "main");
// One commit, so the last step can make a Local Task on this Workspace.
git("-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "--allow-empty", "-q", "-m", "init");
// No runner starts before the last step (mayStart): until then a Task would show up in started.
const started: string[] = [];
let mayStart = false;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    started.push(opts.prompt);
    if (!mayStart) throw new Error("no Task may start");
    // the one Task of the last step: it answers and ends; only its terminal tab is looked at
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    // its reply holds stop reports (the Stops list under the terminal takes height there, which a phone's pane must not give up)
    const stops = ["a", "b", "c", "d"].map((id) => "```switchboard-stop\n" + JSON.stringify({ id, op: "gh pr merge", target: `PR #${id}`, reason: "depends", evidence: "CI pending" }) + "\n```\n").join("");
    queueMicrotask(() => { emit({ t: "message.delta", role: "assistant", text: `ok\n${stops}`, messageId: "m1" }); emit({ t: "session.end", status: "ok", summary: "ok" }); });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
const registered = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: workspacePath }) });
assert(registered.ok, `register the Workspace: ${registered.status}`);
const workspace = (await registered.json()) as { id: string; name: string };
const taskCount = async () => ((await (await fetch(`${base}/api/tasks`)).json()) as unknown[]).length;

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,800", "about:blank"], { stdout: "ignore", stderr: "ignore" });
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
  /** A tap on a phone, a click on a PC, at the element's centre. */
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
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  /** Home at that size, with the Rail's Workspace row drawn. */
  const openPage = async (width: number, height: number, mobile: boolean) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    await call("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`!!document.querySelector('.main.home') && [...document.querySelectorAll('.rail .it .t')].some(e => e.textContent.includes(${JSON.stringify(workspace.name)}))`).catch(() => false), `Home at ${width}x${height}`);
  };
  /** The Workspace row's 「ターミナル」 (on a phone the list opens from the bottom bar first), then the shell's screen. */
  const openWorkspaceTerminal = async (mobile: boolean) => {
    if (mobile && !(await visible(".rail-list"))) {
      await tap(`document.querySelector('.rail-tasks')`, true);
      await until(() => visible(".rail-list"), "the list opens");
    }
    await tap(`document.querySelector('.rail-term')`, mobile);
    await until(() => evaluate(`!!document.querySelector('.main.workspace-terminal .terminal .xterm-helper-textarea') && location.pathname === '/terminal/${workspace.id}'`), "the Workspace's terminal opens");
  };
  const terminalScreen = () => evaluate(`document.querySelector('.main.workspace-terminal .terminal')?.textContent ?? ''`) as Promise<string>;
  const typeInTerminal = async (text: string, touch: boolean) => {
    await tap(`document.querySelector('.terminal .xterm-helper-textarea') ?? document.querySelector('.terminal')`, touch);
    await evaluate(`document.querySelector('.terminal .xterm-helper-textarea').focus()`);
    await call("Input.insertText", { text });
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  /** The row's button by its label, tapped like a finger (the buttons keep xterm's focus on pointerdown). */
  const pressKey = (label: string) => tap(`[...document.querySelectorAll('.term-keys button')].find(b => b.textContent === ${JSON.stringify(label)})`, true);
  const goHome = async (mobile: boolean) => {
    await tap(`[...document.querySelectorAll('.tabs button')].find(b => b.textContent === 'Home')`, mobile);
    await until(() => evaluate(`!!document.querySelector('.main.home') && !document.querySelector('.terminal')`), "Home");
  };

  const results: Record<string, unknown> = {};
  assert((await taskCount()) === 0, "the daemon starts with a Task");
  for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]] as const) {
    const label = `${width}x${height}`;
    await openPage(width, height, mobile);
    await openWorkspaceTerminal(mobile);
    // `sh` is up once it prints its prompt; the first characters typed before that are lost to the pty's startup otherwise.
    await until(async () => (await terminalScreen()).includes("$"), `${label}: the shell's prompt`);
    assert(!(await terminalScreen()).includes(workspacePath), `${label}: the path is on the screen before pwd`);
    await typeInTerminal("pwd", mobile);
    await until(async () => (await terminalScreen()).includes(workspacePath), `${label}: pwd prints ${workspacePath}`);
    // Home and back: the terminal's socket closes and connects again to the same shell, and the earlier output is drawn again.
    await goHome(mobile);
    await openWorkspaceTerminal(mobile);
    await until(async () => (await terminalScreen()).includes(workspacePath), `${label}: pwd's output is back after Home`);
    assert((await taskCount()) === 0 && started.length === 0, `${label}: a Task was made`);
    results[label] = { path: workspacePath, afterReconnect: "pwd output shown" };
    if (!mobile) {
      assert(await evaluate(`!!document.querySelector('.term-keys')`) && !(await visible(".term-keys")), `${label}: the row of keys is shown on a PC`);
      // A shorter window makes the terminal shorter (the pane is not held at the rows xterm drew), and it still fits on the screen.
      const paneHeight = () => evaluate(`document.querySelector('.terminal-pane').getBoundingClientRect().height`) as Promise<number>;
      const tall = await paneHeight();
      await call("Emulation.setDeviceMetricsOverride", { width, height: height - 300, deviceScaleFactor: 1, mobile: false });
      await until(async () => (await paneHeight()) < tall - 100, `${label}: the Workspace's terminal gets shorter with the window (${tall}px before)`);
      assert(await evaluate(`document.querySelector('.terminal-pane').getBoundingClientRect().bottom <= document.querySelector('.main').getBoundingClientRect().bottom + 1`), `${label}: the shorter terminal runs past the screen`);
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    } else {
      // The row on a phone: `cat -vT` prints each key's bytes (arrows in the normal cursor mode: ESC [ x).
      assert(await visible(".term-keys"), `${label}: the row of keys is not shown`);
      await typeInTerminal("cat -vT", mobile);
      await Bun.sleep(300); // cat is reading (a key pressed before it would meet the shell)
      for (const key of ["↑", "↓", "←", "→", "Esc", "Tab", "Enter"]) await pressKey(key);
      await until(async () => (await terminalScreen()).includes("^[[A^[[B^[[D^[[C^[^I"), `${label}: cat -vT prints the keys' bytes`);
      await pressKey("^C");
      // cat is gone when the shell runs the next command: only its output, not what was typed, has 21 after ok
      await typeInTerminal("echo ok$((20+1))", mobile);
      await until(async () => (await terminalScreen()).includes("ok21"), `${label}: ^C ended cat`);
      results[label] = { ...(results[label] as object), keys: "↑ ↓ ← → Esc Tab Enter printed, ^C ended cat" };
    }
    // End this size's shell: the next size opens a new one, whose screen holds nothing this run typed.
    await goHome(mobile);
    core.pty!.close(workspace.id);
    await until(() => core.pty!.pid(workspace.id) === undefined, `${label}: the shell ends`);
  }

  // A Task's Terminal tab: the daemon has no Task until here, and now one.
  mayStart = true;
  const made = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, title: "term keys", prompt: "term keys", runner: "claude" }) });
  assert(made.ok, `make a Task: ${made.status}`);
  const task = (await made.json()) as { id: string };
  await call("Page.navigate", { url: `${base}/task/${encodeURIComponent(task.id)}` });
  await until(() => evaluate(`[...document.querySelectorAll('.subtabs button')].some(b => b.textContent === 'ターミナル')`).catch(() => false), "the Task's Terminal tab");
  await tap(`[...document.querySelectorAll('.subtabs button')].find(b => b.textContent === 'ターミナル')`, true);
  await until(() => evaluate(`!!document.querySelector('.terminal-pane .terminal .xterm-helper-textarea') && !document.querySelector('.terminal-pane').hidden`), "the Task's terminal opens");
  const taskScreen = () => evaluate(`document.querySelector('.terminal-pane .terminal')?.textContent ?? ''`) as Promise<string>;
  await until(async () => (await taskScreen()).includes("$"), "the Task shell's prompt");
  assert(await visible(".terminal-pane .term-keys"), "the Task's row of keys is not shown");
  // The Stops list is under the terminal: the pane keeps its content's height (the keys do not run into the list) and the screen scrolls instead.
  await until(() => visible(".backlog-stops"), "the Task's stop list");
  const layout = await evaluate(`(() => { const pane = document.querySelector('.terminal-pane'); const keys = document.querySelector('.terminal-pane .term-keys').getBoundingClientRect(); const next = document.querySelector('.backlog-stops').getBoundingClientRect(); return { keysBottom: keys.bottom, nextTop: next.top, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight }; })()`) as { keysBottom: number; nextTop: number; scrollHeight: number; clientHeight: number };
  assert(layout.keysBottom <= layout.nextTop + 0.5, `the row of keys runs into the stop list: ${JSON.stringify(layout)}`);
  assert(layout.scrollHeight <= layout.clientHeight + 1, `the terminal pane is lower than its content: ${JSON.stringify(layout)}`);
  // A phone's keyboard does not change the layout's height and covers about the lower 44% of the screen (a user's Android screenshot):
  // with the pane's top scrolled into view, the row of keys must end above 56% of 844 px, or the keyboard hides it.
  // The temporary-directory banner of this run's home is not on a real instance: hidden while measuring, then shown again.
  const keyboard = await evaluate(`(() => { const banners = [...document.querySelectorAll('.banner')]; banners.forEach((b) => (b.style.display = 'none')); document.querySelector('.terminal-pane').scrollIntoView({ block: "start" }); const r = { keysBottom: document.querySelector('.terminal-pane .term-keys').getBoundingClientRect().bottom, edge: window.innerHeight * 0.56 }; banners.forEach((b) => (b.style.display = '')); return r; })()`) as { keysBottom: number; edge: number };
  assert(keyboard.keysBottom <= keyboard.edge, `the row of keys ends below the keyboard's top edge (${keyboard.keysBottom}px > ${keyboard.edge}px)`);
  await typeInTerminal("cat -v", true);
  await Bun.sleep(300);
  await pressKey("↓");
  await pressKey("Enter");
  await until(async () => (await taskScreen()).split("^[[B").length > 2, "the Task's terminal: ↓ arrives as ^[[B (printed by cat)");
  results.task = { keys: "row shown at 390x844, ↓ printed as ^[[B" };
  // The same Task on a PC, with the stop list under it: the terminal keeps a height of its own and does not run into the list,
  // and a shorter window still makes it shorter.
  const pcPane = () => evaluate(`(() => { const p = document.querySelector('.terminal-pane').getBoundingClientRect(); return { height: p.height, bottom: p.bottom, nextTop: document.querySelector('.backlog-stops').getBoundingClientRect().top }; })()`) as Promise<{ height: number; bottom: number; nextTop: number }>;
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  for (const h of [900, 600]) {
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: h, deviceScaleFactor: 1, mobile: false });
    await until(async () => !(await visible(".terminal-pane .term-keys")), `the Task's terminal at 1280x${h}: the row of keys is hidden`);
    const pc = await pcPane();
    assert(pc.height >= 259 && pc.bottom <= pc.nextTop + 0.5, `the Task's terminal at 1280x${h} is squeezed or runs into the stop list: ${JSON.stringify(pc)}`);
    results[`task 1280x${h}`] = { paneHeight: Math.round(pc.height) };
  }
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ...results, tasks: await taskCount(), consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
