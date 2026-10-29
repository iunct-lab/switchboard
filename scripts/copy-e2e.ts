/**
 * Run after `bun run --cwd apps/web build`: bun scripts/copy-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The task screen's copy buttons (#695) at 390 × 844: a fake runner answers in three messages split by tool rows (one
 * tool result 300 lines long) and another stays mid-reply; each button's text is read back with clipboard.readText().
 * Prints one `ok` line per check, (a) to (g) of #698. Not in CI, like approvals-e2e: it needs Chrome.
 * On Linux, Chrome's --headless=new writes to a clipboard it cannot read back; chrome-headless-shell keeps one in memory.
 * Without CHROME_BIN, Linux uses the newest Playwright headless shell
 * (~/.cache/ms-playwright/chromium_headless_shell-<n>/chrome-headless-shell-linux-<arch>/chrome-headless-shell, which
 * `playwright install chromium` puts there). A CHROME_BIN on Linux has to be a chrome-headless-shell too
 * (/usr/local/bin/chromium cannot read the clipboard back).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";

const SHELLS = join(homedir(), ".cache", "ms-playwright");
const SHELL_GLOB = `${SHELLS}/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell`;
/** The newest Playwright headless shell (the highest chromium_headless_shell-<n>, like aws/host/chromium.sh), or null. */
function headlessShell(): string | null {
  const dirs = existsSync(SHELLS) ? readdirSync(SHELLS).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const d of dirs) {
    const bin = readdirSync(join(SHELLS, d)).filter((p) => p.startsWith("chrome-headless-shell-linux")).map((p) => join(SHELLS, d, p, "chrome-headless-shell")).find(existsSync);
    if (bin) return bin;
  }
  return null;
}
const CHROME = process.env.CHROME_BIN ?? (process.platform === "linux" ? headlessShell() : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
if (!CHROME) {
  console.error(`no chrome-headless-shell at ${SHELL_GLOB}: install it with \`npx playwright install chromium-headless-shell\`, or pass CHROME_BIN=<…>/chrome-headless-shell`);
  process.exit(1);
}
const home = mkdtempSync(join(tmpdir(), "sb-copy-e2e-"));
const FIRST = "一通目\n  二行目";
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const say = (text: string): AgentEvent => ({ t: "message.delta", role: "assistant", text });
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "message.delta", role: "user", text: opts.prompt });
      if (opts.prompt === "running") return emit(say("書きかけ")); // never ends: abort / close exit it
      for (const ev of [
        say(FIRST),
        { t: "tool.call", id: "t1", name: "Bash", input: { command: "seq 300" }, summary: "seq 300" },
        { t: "tool.result", id: "t1", ok: true, summary: LONG },
        say("二通目"),
        { t: "tool.call", id: "t2", name: "Read", input: { file_path: "README.md" }, summary: "README.md" },
        { t: "tool.result", id: "t2", ok: true, summary: "readme" },
        say("三通目"),
        { t: "session.end", status: "ok" },
      ] as AgentEvent[]) emit(ev);
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
for (const prompt of ["done", "running"]) {
  await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: `copy-${prompt}`, prompt, runner: "claude" }) });
}

/** A CDP connection (the page's, or the browser's for Browser.grantPermissions). */
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
const chrome = Bun.spawn([CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
const sockets: WebSocket[] = [];
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const browser = await connect(version.webSocketDebuggerUrl);
  sockets.push(browser.ws);
  await browser.call("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const { ws, call, errors } = await connect(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  sockets.push(ws);
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const ok = (label: string, detail: unknown = "") => console.log(`ok ${label} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.trimEnd());
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }); // clipboard.writeText needs a focused page
  await call("Page.navigate", { url: base });

  const open = async (title: string) => {
    await until(() => evaluate(`!!document.querySelector('.rail-tasks')`), "rail");
    await evaluate(`document.querySelector('.rail-tasks').click()`);
    await until(() => evaluate(`(() => { const b = [...document.querySelectorAll('.rail-list button.it')].find((b) => b.title.startsWith(${JSON.stringify(title)})); b?.click(); return !!b; })()`), `open ${title}`);
  };
  /** Presses the n-th copy button labelled `label` (under `scope`); returns what the clipboard holds and the button's text right after. */
  const press = async (scope: string, label: string, n = 0) => {
    await evaluate(`navigator.clipboard.writeText('')`);
    const shown = await evaluate(`(async () => {
      const b = document.querySelectorAll(${JSON.stringify(`${scope} button.copy[aria-label="${label}"]`)})[${n}];
      if (!b) return null;
      b.click();
      for (let i = 0; i < 100 && b.textContent === ${JSON.stringify(label)}; i++) await new Promise((r) => setTimeout(r, 20));
      return b.textContent;
    })()`) as string | null;
    assert(shown !== null, `no button ${label} #${n} under ${scope}`);
    return { text: await evaluate(`navigator.clipboard.readText()`) as string, shown: shown! };
  };

  await evaluate(`navigator.clipboard.writeText("probe")`);
  assert((await evaluate(`navigator.clipboard.readText()`)) === "probe", `this Chrome (${CHROME}) cannot read its clipboard back (Linux --headless=new): run without CHROME_BIN, or with CHROME_BIN=<…>/chrome-headless-shell (Playwright's: ${SHELL_GLOB})`);
  await open("copy-done");
  await until(() => evaluate(`document.querySelector('.end.ok') !== null && document.querySelectorAll('.msg.assistant').length === 3`), "the finished reply");

  // (a) each YOU / runner row copies its own text as it is
  const rows = await evaluate(`[...document.querySelectorAll('.msg')].map((m) => m.querySelector('.tx')?.textContent ?? '')`) as string[];
  assert(JSON.stringify(rows) === JSON.stringify(["done", FIRST, "二通目", "三通目"]), `rows: ${JSON.stringify(rows)}`);
  for (let i = 0; i < rows.length; i++) {
    const got = await press(".msg", "コピー", i);
    assert(got.text === rows[i], `row ${i}: ${JSON.stringify(got.text)} != ${JSON.stringify(rows[i])}`);
    assert(got.shown === "コピーしました", `row ${i} shows ${got.shown}`);
  }
  ok("(a) row buttons", rows);

  // (b) the last runner row of the turn copies the three replies, one blank line apart; it is there only once
  const turnButtons = await evaluate(`[...document.querySelectorAll('.msg')].flatMap((m, i) => m.querySelector('button.copy[aria-label="ターンの返答をコピー"]') ? [i] : [])`) as number[];
  assert(JSON.stringify(turnButtons) === "[3]", `turn button on rows ${JSON.stringify(turnButtons)}`);
  const turn = await press(".msg", "ターンの返答をコピー");
  assert(turn.text === `${FIRST}\n\n二通目\n\n三通目`, `turn: ${JSON.stringify(turn.text)}`);
  ok("(b) turn reply", JSON.stringify(turn.text));

  // (c) the head copies the conversation as Markdown: headings, one line per tool, no tool result
  const md = (await press(".task-head", "会話をコピー")).text;
  const expected = ["### YOU\n\ndone", `### claude\n\n${FIRST}`, "- Bash seq 300 ✓", "### claude\n\n二通目", "- Read README.md ✓", "### claude\n\n三通目", "— 完了 —"].join("\n\n");
  assert(md === expected, `markdown: ${JSON.stringify(md)}`);
  assert(!md.includes("line 150"), "the tool result is in the Markdown");
  ok("(c) conversation markdown", `${md.length} chars`);

  // (d) the tool's result: all 300 lines, also those scrolled out of the 240px box
  await evaluate(`document.querySelector('.tool .tool-row').click()`);
  await until(() => evaluate(`!!document.querySelector('.tool-detail button.copy[aria-label="結果をコピー"]')`), "tool detail");
  const box = await evaluate(`(() => { const p = document.querySelectorAll('.tool-detail pre')[1]; return { client: p.clientHeight, scroll: p.scrollHeight }; })()`) as { client: number; scroll: number };
  assert(box.scroll > box.client, `the result does not scroll: ${JSON.stringify(box)}`);
  const result = (await press(".tool-detail", "結果をコピー")).text;
  assert(result === LONG && result.split("\n").length - 1 === 299, `result: ${result.length} chars`);
  const input = (await press(".tool-detail", "入力をコピー")).text;
  assert(input === JSON.stringify({ command: "seq 300" }, null, 2), `input: ${JSON.stringify(input)}`);
  ok("(d) tool result", { length: result.length, newlines: 299, box });

  // (f) every copy button is on screen, 44px or taller, and the one hit at its centre
  const targets = await evaluate(`(() => [...document.querySelectorAll('button.copy')].map((b) => {
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { label: b.getAttribute('aria-label'), h: r.height, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, hit: hit === b || b.contains(hit) };
  }))()`) as Array<{ label: string; h: number; inside: boolean; hit: boolean }>;
  const bad = targets.filter((t) => t.h < 44 || !t.inside || !t.hit);
  assert(targets.length === 4 + 1 + 1 + 2 && !bad.length, `targets: ${JSON.stringify(bad.length ? bad : targets)}`);
  ok("(f) 44px targets", `${targets.length} buttons, min ${Math.min(...targets.map((t) => t.h))}px`);

  // (g) the text is still selectable by dragging
  const span = await evaluate(`(() => { const t = document.querySelectorAll('.msg .tx')[1]; t.scrollIntoView({ block: 'center' }); const r = t.getBoundingClientRect(); return { x0: r.left + 2, x1: r.right - 2, y: r.top + 8 }; })()`) as { x0: number; x1: number; y: number };
  await evaluate(`getSelection().removeAllRanges()`);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: span.x0, y: span.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 5; i++) await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: span.x0 + ((span.x1 - span.x0) * i) / 5, y: span.y, button: "left", buttons: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: span.x1, y: span.y, button: "left", clickCount: 1 });
  const selected = await evaluate(`getSelection().toString()`) as string;
  assert(selected.length > 0, "dragging over the text selects nothing");
  ok("(g) drag selects", selected);

  // (e) 「コピーしました」 on the finished task (above); on a running one 「途中までコピーしました」 and the text so far
  await open("copy-running");
  await until(() => evaluate(`[...document.querySelectorAll('.msg.assistant .tx')].some((t) => t.textContent === '書きかけ')`), "the reply so far");
  const partial = await press(".msg.assistant", "コピー");
  assert(partial.text === "書きかけ" && partial.shown === "途中までコピーしました", `running: ${JSON.stringify(partial)}`);
  ok("(e) running task", partial);

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
} finally {
  for (const ws of sockets) ws.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
