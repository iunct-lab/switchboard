/**
 * Run after `bun run --cwd apps/web build`: bun scripts/release-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * Promoting from the settings screen (#1660): a fake sb-rescue runs the commit before HEAD, a fake runner keeps a Task
 * running, and the header's 「新しい版 →」, the 「動いている版」 section, the two-step confirmation and the Brief are
 * driven in headless Chrome. SCREENSHOT=<file.png> also saves what the settings screen looked like.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-release-e2e-"));
const repo = join(home, "app");
mkdirSync(repo);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "feat: first");
git("commit", "-q", "--allow-empty", "-m", "feat: the newer version");
const head = git("rev-parse", "HEAD");
let running = git("rev-parse", "HEAD~1");
const promoted: string[] = [];
const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/api/status") return Response.json({ current: running, previous: null, state: "running", busy: null, lastError: null, history: [] });
  if (url.pathname === "/api/promote") { promoted.push(((await req.json()) as { commit: string }).commit); return Response.json({ started: "promote" }, { status: 202 }); }
  return new Response("no", { status: 404 });
} });
// Stays running until it is stopped, waiting on an approval: the Task counts as busy.
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  models: [{ value: "m-e2e", label: "m-e2e" }],
  start(_opts, emit) {
    queueMicrotask(() => emit({ t: "permission.ask", id: "perm-e2e", kind: "exec", tool: "Bash", input: { command: "ls" }, detail: "ls" }));
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
let core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const daemonPort = core.server.port;
const base = `http://127.0.0.1:${daemonPort}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,1400", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const pageUrl = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  ws = new WebSocket(pageUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown") errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  /** Presses the button `find` (a JS expression) returns, once it has stayed where it is. */
  const press = async (find: string, label: string) => {
    const at = `(() => { const b = ${find}; if (!b || b.disabled) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return b.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`;
    const point = await until(async () => {
      const first = await evaluate(at) as { x: number; y: number } | null;
      if (!first) return null;
      await Bun.sleep(100);
      const second = await evaluate(at) as { x: number; y: number } | null;
      return second && second.x === first.x && second.y === first.y ? second : null;
    }, label);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const byText = (text: string, scope = "button") => `[...document.querySelectorAll('${scope}')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const panelText = () => evaluate(`document.querySelector('#release')?.textContent ?? ''`) as Promise<string>;
  const short = head.slice(0, 7);

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");

  // (a) the header says there is a newer version; it opens the settings section
  const mark = await until(() => evaluate(`document.querySelector('.new-version')?.textContent ?? null`), "新しい版 in the header");
  assert(mark === `新しい版 ${short} →`, `header mark: ${mark}`);
  await press(`document.querySelector('.new-version')`, "新しい版 →");
  await until(() => evaluate(`!!document.querySelector('#release')`), "the 動いている版 section");
  const ahead = await until(async () => { const t = await panelText(); return t.includes("1 コミット先") ? t : null; }, "1 コミット先");
  assert(ahead.includes("動いている版") && ahead.includes(`HEAD: ${short} feat: the newer version — 1 コミット先`), `section: ${ahead}`);
  assert(await until(() => evaluate(`document.getElementById('release').getBoundingClientRect().top < innerHeight`), "the section is scrolled into view"), "the section is below the viewport");
  assert(await evaluate(`!!document.querySelector('#release a[href]')`), "the section links the rescue page");
  if (process.env.SCREENSHOT) writeFileSync(process.env.SCREENSHOT, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // (b) no Task is running: one press sends HEAD once
  assert(!(await evaluate(`document.querySelector('#release').textContent.includes('動いている Task')`)), "no busy-task line with nothing running");
  await press(byText("この版を昇格", "#release button"), "この版を昇格");
  await until(() => promoted.length === 1, "one promotion sent");
  assert(promoted[0] === head, `promoted ${promoted[0]}`);
  await until(async () => (await panelText()).includes(`${short} を別ポートで起動して確認しています`), "the result line");

  // (c) a running Task: the first press only asks, 待たずに昇格する sends
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const task = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: meta.path, workspaceId: meta.id, title: "busy task", prompt: "p", runner: "claude" }) })).json() as { id: string };
  await until(() => core.db.listTasksByStatus("waiting").length + core.db.listTasksByStatus("running").length > 0, "the Task runs");
  await until(async () => (await panelText()).includes("動いている Task 1 件: 昇格するとデーモンが再起動します"), "the busy-task line");
  await press(byText("この版を昇格", "#release button"), "この版を昇格 (busy)");
  await until(() => evaluate(`!!(${byText("待たずに昇格する")})`), "the confirmation");
  await Bun.sleep(300);
  assert(promoted.length === 1, "the first press with a running Task must not send");
  await press(byText("待たずに昇格する"), "待たずに昇格する");
  await until(() => promoted.length === 2, "promotion sent after the confirmation");
  assert(promoted[1] === head, `forced promotion sent ${promoted[1]}`);

  // (d) the Task's own screen shows the same section
  if (!(await evaluate(`!!document.querySelector('.rail .it[title="busy task"]')`))) await press(`document.querySelector('.rail-tasks')`, "the Task list");
  await press(`document.querySelector('.rail .it[title="busy task"]')`, "the Task in the rail");
  await until(() => evaluate(`!!document.querySelector('#release-panel') && document.querySelector('#release') === null`), "ReleasePanel in the Brief (the side panel at 1200px)");
  const brief = await evaluate(`document.querySelector('#release-panel').textContent`) as string;
  assert(brief.includes("1 コミット先") && brief.includes("この版を昇格"), `Brief: ${brief}`);

  // (e) sb-rescue now runs HEAD and the daemon restarts: the page reconnects, the mark goes, the section says so
  running = head;
  await fetch(`${base}/api/tasks/${task.id}/abort`, { method: "POST" }).catch(() => undefined);
  await core.stop();
  core = await startServer(cfg, [adapter], { port: daemonPort, selfdevChecks: false, dryRunRestart: true });
  await until(async () => (await evaluate(`document.querySelector('.new-version') === null && document.querySelector('.conn')?.textContent.includes('connected')`)) || null, "the mark is gone after reconnecting");
  await press(byText("Settings", ".tabs button"), "Settings");
  await until(async () => (await panelText()).includes("最新の版が動いています"), "最新の版が動いています");
  assert(await evaluate(`${byText("この版を昇格", "#release button")}.disabled`), "ahead 0 must disable the button");

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ mark, section: ahead.slice(0, 80), promoted: promoted.length, brief: brief.slice(0, 60) }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rescue.stop(true);
  rmSync(home, { recursive: true, force: true });
}
