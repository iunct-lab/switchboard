/**
 * Run after `bun run --cwd apps/web build`: bun scripts/routing-advice-e2e.ts. Requires Chromium (CHROME_BIN overrides).
 * The LLM's proposal comes after the Task (#1143), with a fake runner and a fake suggester: a Task ends with the suggester
 * still held and its Brief opens; released, the proposal appears without a reload next to the real runner and outcome,
 * which do not change, and it is there after a reload. Off, a failure and a timeout show no proposal and keep the Task.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-routing-advice-e2e-"));
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: `reply to ${opts.prompt}` });
      emit({ t: "session.end", status: "ok", summary: opts.prompt });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
let release!: () => void;
const held = new Promise<void>((r) => (release = r));
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], {
  port: 0, selfdevChecks: false, dryRunRestart: true,
  llmSuggester: () => ({
    kind: "llm",
    async suggest(ctx, signal) {
      if (ctx.title === "advice-fails") throw new Error("runner said no");
      if (ctx.title === "advice-timeout") await new Promise((r) => signal.addEventListener("abort", r));
      else await held;
      return { runner: "codex", reason: "長い調査に向く", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
    },
  }),
});
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const settings = (llm: object) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm } }) });
const stored = async (title: string) => ((await (await fetch(`${base}/api/tasks`)).json()) as Task[]).find((t) => t.title === title);
const create = async (title: string) => {
  const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title, prompt: title, runner: "claude" }) });
  assert(res.status === 201, `${title}: ${res.status}`);
  return await until(async () => { const t = await stored(title); return t?.status === "done" && t; }, `${title} done`);
};

const profile = join(home, "chrome");
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
try {
  await settings({ enabled: true, timeoutMs: 60_000 }); // each proposal takes the deadline saved when it is asked
  const late = await create("advice-late"); // the suggester stays held: the Task ended without it
  assert(late.routing?.llm === null, `held: ${JSON.stringify(late.routing)}`);
  await create("advice-fails");
  await settings({ timeoutMs: 1000 });
  await create("advice-timeout");
  await Bun.sleep(1100); // its deadline passes
  await settings({ enabled: false });
  await create("advice-off");

  chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
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
  const click = (js: string, label: string) => until(() => evaluate(`(() => { const el = ${js}; if (!el || el.disabled) return false; el.click(); return true; })()`), label);
  const openFromRail = (title: string) => click(`[...document.querySelectorAll('.rail-list button.it')].find((b) => b.querySelector('.t')?.textContent === ${JSON.stringify(title)})`, `open ${title}`);
  const brief = async (title: string) => {
    await openFromRail(title);
    await until(() => evaluate(`document.querySelector('.task-head')?.textContent.includes(${JSON.stringify(title)})`), `${title} open`);
    await click(`document.querySelector('button.brief-toggle')`, "Brief");
    return (await until(() => evaluate(`document.querySelector('.brief-close')?.parentElement.textContent`), `${title} Brief`)) as string;
  };
  const briefText = () => evaluate(`document.querySelector('.brief-close')?.parentElement.textContent ?? ''`) as Promise<string>;
  const load = async () => {
    await call("Page.navigate", { url: `${base}/` });
    await until(() => evaluate(`document.querySelectorAll('.rail-list button.it').length >= 4`), "the rail lists the Tasks");
  };

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await load();

  // (a) the Task ended and the suggester is held: the Brief opens, with the runner and no proposal
  const before = await brief("advice-late");
  assert(before.includes("ランナー") && !before.includes("LLM の提案"), `(a) ${before}`);

  // (b) released: the proposal appears in the open Brief, without a reload, next to the real runner and outcome
  release();
  const line = (await until(async () => { const t = await briefText(); return t.includes("LLM の提案") && t; }, "the proposal appears")) as string;
  const WANT = "LLM の提案: codex — 長い調査に向く · 実際: claude（未判定）";
  assert(line.includes(WANT), `(b) ${line}`);
  const after = await stored("advice-late");
  assert(after?.runner === late.runner && after?.status === late.status && after?.outcome === late.outcome, `(b) stored ${JSON.stringify(after)}`);

  // (c) a reload shows what was saved
  await load();
  const reloaded = await brief("advice-late");
  assert(reloaded.includes(WANT), `(c) ${reloaded}`);

  // (d) off, a failure, a timeout: no proposal, the rule table's line and the Task stay
  const plain: Record<string, boolean> = {};
  for (const title of ["advice-off", "advice-fails", "advice-timeout"]) {
    const text = await brief(title);
    assert(text.includes("推奨どおり") && !text.includes("LLM の提案"), `(d) ${title}: ${text}`);
    const t = await stored(title);
    assert(t?.status === "done" && t.outcome === "unknown" && t.runner === "claude" && t.routing?.llm === null, `(d) ${title}: ${JSON.stringify(t)}`);
    plain[title] = true;
  }

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ a: "Brief opens before the proposal", b: WANT, c: "kept after reload", d: plain }));
} finally {
  release();
  ws?.close();
  chrome?.kill();
  await chrome?.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
