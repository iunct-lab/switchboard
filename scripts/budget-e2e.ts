/**
 * Run after `bun run --cwd apps/web build`: ops-kit heavy -- bun scripts/budget-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The Fable default budget and the choice over a Task's budget end to end (llm-routing.md): a fake runner and headless Chrome.
 * (a) the Settings box 「Fable の Task の既定の予算」 saved as 150 and read back after a reload (and emptied back to none);
 * (b) a Fable Task with a $0.01 budget whose turn cost more: 「このまま続ける」 and 「新しい Task に切る」 show over the composer,
 *     and 「このまま続ける」 doubles the budget so the next turn is sent;
 * (c) over the budget again: 「新しい Task に切る」 opens a new Task of the same Workspace and runner whose first instruction names
 *     the old Task's title and id, and the old Task stays as it was.
 * SCREENSHOT_DIR=<dir> saves the over-budget Task at 390 × 844 and 1280 × 800 and the Settings card.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const home = mkdtempSync(join(tmpdir(), "sb-budget-e2e-"));
const starts: string[] = [];
const replies: string[] = [];
/** Every prompt ends its turn at once; a turn a Task is sent (live or resumed) is kept. */
const claude: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start(opts, emit) {
    starts.push(opts.prompt);
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => emit({ t: "session.end", status: "ok", summary: "done" } as AgentEvent));
    return {
      send(text: string) { replies.push(text); queueMicrotask(() => emit({ t: "session.end", status: "ok", summary: "done" } as AgentEvent)); },
      respondPermission() {},
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};
const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [claude], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string, seen?: () => unknown): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  let last: unknown;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; last = seen ? await seen() : value; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}（最後の値: ${(JSON.stringify(last) ?? String(last)).slice(0, 200)}）`);
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
const settingsNow = () => fetch(`${base}/api/settings`).then((r) => r.json() as Promise<Json>);
const ok = (line: string) => console.log(`ok  ${line}`);

const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
const ledger = (taskId: string, costUsd: number) => core.db.insertLedger({ taskId, runner: "claude", model: "claude-fable-5-1", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: 0, source: "reported", ts: Date.now() });
const shots = process.env.SCREENSHOT_DIR;
const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(tabs.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<Json> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async (name: string) => {
    if (!shots) return;
    await Bun.write(join(shots, name), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  const buttons = () => evaluate(`[...document.querySelectorAll('.budget-choice button')].map(b => b.textContent.trim())`) as Promise<string[]>;
  const press = (label: string) => evaluate(`(() => { const b = [...document.querySelectorAll('.budget-choice button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  const openTask = async (id: string) => { await call("Page.navigate", { url: `${base}/task/${id}` }); await until(() => evaluate(`!!document.querySelector('.composer')`), "the Task screen"); };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // (a) Settings: the box starts empty (none), takes 150, and 150 is there after a reload; emptied it is none again
  const LABEL = "Fable の Task の既定の予算（USD、空 = なし）";
  const openSettings = async () => {
    await call("Page.navigate", { url: `${base}/settings` });
    await until(() => evaluate(`(() => { const d = [...document.querySelectorAll('.settings details.card')].find((d) => d.querySelector('summary').textContent.trim() === '使用量と自動再開'); if (d) d.open = true; return !!d?.querySelector('input[aria-label=${JSON.stringify(LABEL)}]'); })()`), "the 使用量と自動再開 card");
  };
  const box = `document.querySelector('input[aria-label=${JSON.stringify(LABEL)}]')`;
  const typeIn = (value: string) => evaluate(`(() => { const i = ${box}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  assert((await settingsNow()).quotaAndResume.fableBudgetUsd === null, "the default budget starts as none");
  await openSettings();
  assert((await evaluate(`${box}.value`)) === "", "the box starts empty");
  await typeIn("150");
  await until(async () => (await settingsNow()).quotaAndResume.fableBudgetUsd === 150, "150 saved", async () => (await settingsNow()).quotaAndResume);
  await openSettings();
  assert((await evaluate(`${box}.value`)) === "150", "150 after a reload");
  await shot("settings-1280.png");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evaluate(`${box}.scrollIntoView({ block: "center" })`);
  await shot("settings-390.png");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  ok("(a) 設定の Fable の既定の予算を 150 にして再読み込み → 150");
  await typeIn("");
  await until(async () => (await settingsNow()).quotaAndResume.fableBudgetUsd === null, "emptied saved as none");
  ok("(a) 欄を空にすると保存は null（なし）");

  // (b) a Fable Task with a $0.01 budget whose turn cost $0.015: both buttons; 「このまま続ける」 doubles the budget and a turn goes
  const t = await post("/api/tasks", { workspaceId: meta.id, title: "予算を超えた Fable の Task", prompt: "go", runner: "claude", model: "claude-fable-5-1", budgetUsd: 0.01 });
  await until(() => core.db.getTask(t.id)!.status !== "running", "the first turn ends");
  ledger(t.id, 0.015);
  await openTask(t.id);
  await until(async () => (await buttons()).length === 2, "two buttons", buttons);
  assert(JSON.stringify(await buttons()) === JSON.stringify(["このまま続ける", "新しい Task に切る"]), `buttons: ${JSON.stringify(await buttons())}`);
  assert(await evaluate(`(() => { const c = document.querySelector('.budget-choice'), k = document.querySelector('.composer'); return !!(c.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING); })()`), "the buttons are above the composer");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await shot("over-budget-390.png");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await shot("over-budget-1280.png");
  ok("(b) 予算 $0.01 を超えた Fable の Task に 「このまま続ける」「新しい Task に切る」が送信欄の上に出た");
  assert((await post(`/api/tasks/${t.id}/send`, { text: "refused" }).then((r) => JSON.stringify(r))).includes("budget exceeded"), "a turn is refused while over budget");
  assert(await press("このまま続ける"), "press 続ける");
  await until(() => core.db.getTask(t.id)!.budgetUsd === 0.02, "the budget is doubled", () => core.db.getTask(t.id)!.budgetUsd);
  await until(async () => (await buttons()).length === 0, "the buttons go once under budget", buttons);
  await evaluate(`(() => { const a = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(a, '続きをお願い'); a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('.composer button.pri').click()`);
  await until(() => [...starts, ...replies].some((p) => p.includes("続きをお願い")), "the turn is sent", () => ({ starts, replies }));
  ok("(b) 「このまま続ける」で予算が 0.01 → 0.02 になり、次のターン「続きをお願い」が通った");

  // (c) over the budget again: 「新しい Task に切る」 opens the new Task naming the old one; the old one is untouched
  await until(() => core.db.getTask(t.id)!.status !== "running", "the second turn ends");
  ledger(t.id, 0.01);
  const before = core.db.getTask(t.id)!;
  await openTask(t.id);
  await until(async () => (await buttons()).length === 2, "two buttons again", buttons);
  assert(await press("新しい Task に切る"), "press 切る");
  const cut = await until(() => core.db.listTasks().find((x) => x.id !== t.id && x.title.includes(t.id)), "the new Task", () => core.db.listTasks().map((x) => x.title));
  await until(() => evaluate(`location.pathname === ${JSON.stringify(`/task/${cut.id}`)}`), "the new Task is selected", () => evaluate("location.pathname"));
  assert(cut.workspaceId === before.workspaceId && cut.runner === before.runner && cut.model === before.model, `same Workspace / runner / model: ${JSON.stringify([cut.workspaceId, cut.runner, cut.model])}`);
  assert(starts.some((p) => p === `Task「${before.title}」（${t.id}）の続き。元の Task は予算 $0.02 を超えたのでここで続ける。`), `the first instruction: ${JSON.stringify(starts)}`);
  const after = core.db.getTask(t.id)!;
  assert(after.budgetUsd === before.budgetUsd && after.status === before.status && after.title === before.title, "the old Task is as it was");
  assert((await post(`/api/tasks/${t.id}/send`, { text: "refused" }).then((r) => JSON.stringify(r))).includes("budget exceeded"), "the old Task still cannot send");
  ok("(c) 「新しい Task に切る」で新しい Task が選ばれ、最初の指示に元の題と id がある。元の Task は予算 $0.02 のまま送れない");
  assert(!errors.length, `console errors: ${JSON.stringify(errors).slice(0, 300)}`);
  ok("コンソールのエラーなし");
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
