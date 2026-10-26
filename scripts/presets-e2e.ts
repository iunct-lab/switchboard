/**
 * Run after `bun run --cwd apps/web build`: bun scripts/presets-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * 定型の指示 (#940) end to end on a daemon with a fake runner and a fake gh: saved, listed and
 * edited in 設定, kept over a reload, put into the request box with a target and started with one 開始, refused when
 * the target is empty / 自動 / another repository / the Workspace changed, put into a reply, and deleted. The Task it
 * starts still stops on the runner's write approval with 許可 / 拒否 (a preset is not a standing permission).
 * SCREENSHOT_DIR=<dir> saves Home and 設定 at 1280 and 390 wide.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, Task } from "@switchboard/protocol";

const REPO = "example-org/app";
const home = mkdtempSync(join(tmpdir(), "sb-presets-e2e-"));
const dev = join(home, "dev");
const other = join(home, "other");
for (const d of [dev, other]) mkdirSync(d);
/** Every text the runner was given: the first prompt of a start and each reply. */
const received: string[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  // two modes: the request box's choice, not the preset, decides which one the Task runs with
  permissionModes: [{ value: "auto", label: "Auto", description: "the runner decides" }, { value: "default", label: "Default", description: "ask for every edit" }],
  defaultPermissionMode: "auto",
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    received.push(opts.prompt);
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-presets", cwd: opts.cwd });
      // as the real adapters do: the prompt is the Task's first user message
      emit({ t: "message.delta", role: "user", text: opts.prompt });
      emit({ t: "permission.ask", id: `p${received.length}`, kind: "write", tool: "Write", input: { file_path: "src/a.ts" }, detail: "write src/a.ts" });
    });
    return {
      send(text) {
        received.push(text);
        queueMicrotask(() => emit({ t: "message.delta", role: "user", text }));
      },
      respondPermission(id, decision) {
        emit({ t: "permission.resolved", id, decision, by: "user" });
        emit({ t: "session.end", status: "ok" });
        exit(0);
      },
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
// the Workspace `dev` is REPO, `other` is another repository: what expanding a preset asks gh (`gh repo view`)
const gh = async (args: string[], cwd: string) => (args[0] === "repo" ? { code: 0, stdout: `${cwd === other ? "other/repo" : REPO}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no gh in this e2e" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh, judge: () => new Promise(() => undefined) });
const wsDev = core.db.upsertWorkspace({ path: dev, name: "dev", kind: "repo" });
const wsOther = core.db.upsertWorkspace({ path: other, name: "other", kind: "repo" });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const tasks = async () => (await (await fetch(`${base}/api/tasks`)).json()) as Task[];

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  // the port file can come before the first page target
  const tab = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  // React reads a typed value from the native setter + an input / change event
  const page = (body: string) => evaluate(`(() => {
    const set = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
    const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const picker = () => document.querySelector('.preset-picker');
    const pick = (name) => { const s = picker().querySelector('select'); set(s, [...s.options].find((o) => o.textContent === name).value); };
    ${body}
  })()`);
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOT_DIR) return;
    const s = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await Bun.write(join(process.env.SCREENSHOT_DIR, name), Buffer.from(s.data, "base64"));
  };
  const nav = async (label: string, ready: string) => {
    await until(() => evaluate(`!!document.querySelector('nav button')`), "nav");
    await page(`button(document.querySelector('nav'), ${JSON.stringify(label)}).click()`);
    await until(() => evaluate(`!!document.querySelector(${JSON.stringify(ready)})`), `${label}: ${ready}`).catch(async (e) => { console.error(await evaluate(`document.querySelector(".main")?.innerText.slice(0, 600)`)); throw e; });
  };
  const open = async (label: string, ready: string) => {
    await call("Page.navigate", { url: base });
    await nav(label, ready);
  };
  // the picker reads its list only when opened (no request with the screen)
  const openPicker = async () => {
    await until(() => evaluate(`!!document.querySelector('.preset-picker button')`), "the picker's button");
    await page(`button(picker(), '定型の指示…').click()`);
    await until(() => evaluate(`!!document.querySelector('.preset-picker select')`), "the picker open");
  };
  const rows = () => evaluate(`[...document.querySelectorAll('.preset-row .t')].map((e) => e.textContent)`) as Promise<string[]>;
  const rowsAre = (names: string[]) => until(async () => { const r = await rows(); return JSON.stringify([...r].sort()) === JSON.stringify([...names].sort()) && r; }, `rows ${names}`);
  const sleep = () => Bun.sleep(60);
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // 1. 設定: add two, list them, edit a name, keep them over a reload (acceptance 1, 3)
  await open("Settings", ".card.presets .preset-new");
  await until(() => evaluate(`document.querySelector('.card.presets').innerText.includes('保存した指示はありません')`), "empty list");
  const add = async (name: string, text: string) => {
    await page(`const f = document.querySelector('.preset-new'); set(f.querySelector('input'), ${JSON.stringify(name)}); set(f.querySelector('textarea'), ${JSON.stringify(text)});`);
    await sleep();
    await page(`button(document.querySelector('.preset-new'), '保存').click()`);
  };
  await add("レビュー対応", "PR {{target}} のレビュー指摘に対応してマージまで進めてください（review-triage-and-merge）");
  await rowsAre(["レビュー対応"]);
  await add("状況の確認", "今の状況を確認して報告してください");
  await rowsAre(["レビュー対応", "状況の確認"]);
  await page(`button([...document.querySelectorAll('.preset-row')].find((r) => r.querySelector('.t').textContent === 'レビュー対応'), '編集').click()`);
  await sleep();
  await page(`set(document.querySelector('.preset-row .policy-edit input'), 'レビュー対応からマージまで')`);
  await sleep();
  await page(`button(document.querySelector('.preset-row .policy-edit'), '保存').click()`);
  await rowsAre(["レビュー対応からマージまで", "状況の確認"]);
  await call("Page.reload");
  await nav("Settings", ".card.presets .preset-new");
  const listed = await rowsAre(["レビュー対応からマージまで", "状況の確認"]);

  // 2. 誤送信を防ぐ (acceptance 3): an empty target, 自動, another repository, then a Workspace change after putting it in
  await nav("Home", ".compose .preset-picker");
  await openPicker();
  const before = (await tasks()).length;
  await page(`pick('レビュー対応からマージまで')`);
  await sleep();
  const disabled = () => page(`return ({ put: button(document.querySelector('.preset-picker'), '本文に入れる').disabled, hint: document.querySelector('.preset-picker .hint')?.textContent ?? null })`);
  const empty = await disabled();
  assert(empty.put && empty.hint?.includes("対象"), `empty target: ${JSON.stringify(empty)}`);
  await page(`set(document.querySelector('.preset-picker input'), '#12')`);
  await sleep();
  const auto = await disabled();
  assert(auto.put && auto.hint?.includes("Workspace"), `自動: ${JSON.stringify(auto)}`);
  await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsDev.id)})`);
  await sleep();
  await page(`set(document.querySelector('.compose select.mode'), 'default')`);
  await page(`set(document.querySelector('.preset-picker input'), 'other/repo#3')`);
  await sleep();
  await page(`button(picker(), '本文に入れる').click()`);
  const otherRepo = await until(() => evaluate(`document.querySelector('.preset-picker .warn')?.textContent`), "another repository refused");
  assert(otherRepo.includes(`other/repo#3 は Workspace dev のリポジトリ ${REPO} ではありません`), `another repository: ${otherRepo}`);
  assert((await evaluate(`document.querySelector('.compose textarea').value`)) === "", "the request box stays empty on a refusal");

  // 3. 新規依頼 (acceptance 2): the target swapped into the text, the title named after it, one 開始
  await page(`set(document.querySelector('.preset-picker input'), '#12')`);
  await sleep();
  await page(`button(picker(), '本文に入れる').click()`);
  const box = await until(() => evaluate(`(() => { const v = document.querySelector('.compose textarea').value; return v.includes('#12') && { text: v, title: document.querySelector('.compose input:not([type])').value }; })()`), "the text in the request box");
  assert(box.text === `PR ${REPO}#12 のレビュー指摘に対応してマージまで進めてください（review-triage-and-merge）`, `text: ${box.text}`);
  assert(box.title === `レビュー対応からマージまで ${REPO}#12`, `title: ${box.title}`);
  const chosenMode = await evaluate(`document.querySelector('.compose select.mode').value`);
  assert(chosenMode === "default", `the request box's approval mode stays as chosen: ${chosenMode}`);
  await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsOther.id)})`);
  await sleep();
  const stale = await page(`return ({ start: button(document.querySelector('.compose'), '開始').disabled, inbox: button(document.querySelector('.compose'), 'Inbox に保存').disabled, warn: document.querySelector('.compose > .warn')?.textContent ?? null })`);
  assert(stale.start && stale.inbox && stale.warn?.includes("入れ直して"), `changed Workspace: ${JSON.stringify(stale)}`);
  assert((await tasks()).length === before, "nothing was sent by the refusals");
  await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsDev.id)})`);
  await sleep();
  await shot("home-1280.png");
  await page(`button(document.querySelector('.compose'), '開始').click()`);
  const task = await until(async () => (await tasks()).find((t) => t.title === box.title), "the Task");
  assert((await tasks()).length === before + 1, "one 開始 made one Task");
  await until(() => received.length >= 1, "the runner's first prompt");
  assert(received[0] === box.text, `the runner got the request box's text: ${received[0]}`);

  // 4. 承認は従来どおり (acceptance 4): the write waits with 許可 / 拒否, nothing answered it
  await until(() => evaluate(`!!document.querySelector('.perm')`), "the approval in the Task");
  const perm = await evaluate(`({ buttons: [...document.querySelectorAll('.perm .actions button')].map((b) => b.textContent.trim()), detail: document.querySelector('.perm code').textContent })`);
  assert(JSON.stringify(perm.buttons) === JSON.stringify(["許可", "拒否"]), `approval buttons: ${JSON.stringify(perm)}`);
  const detail = (await (await fetch(`${base}/api/tasks/${task.id}`)).json()) as { task: Task; events: Array<{ ev: { t: string; role?: string; text?: string } }> };
  assert(detail.task.status === "waiting" && !detail.events.some((e) => e.ev.t === "permission.resolved"), `waiting, unanswered: ${detail.task.status}`);
  const first = detail.events.find((e) => e.ev.t === "message.delta" && e.ev.role === "user")?.ev.text;
  assert(first === box.text, `the Task's first message is the request box's text: ${first}`);
  const mode = detail.task.permissionMode;
  assert(mode === chosenMode, `the Task runs with the request box's mode: ${mode}`);
  await page(`button(document.querySelector('.perm'), '許可').click()`);
  await until(async () => (await tasks()).find((t) => t.id === task.id)?.status !== "waiting", "answered by the person");

  // 5. 返信 (acceptance 2): the same picker over the reply box, a new target, 送信
  await until(() => evaluate(`!!document.querySelector('.main .preset-picker') && !document.querySelector('.compose')`), "the reply picker");
  await openPicker();
  await page(`pick('レビュー対応からマージまで')`);
  await sleep();
  await page(`set(document.querySelector('.preset-picker input'), '#13')`);
  await sleep();
  await page(`button(picker(), '本文に入れる').click()`);
  const reply = await until(() => evaluate(`(() => { const v = document.querySelector('.composer textarea').value; return v.includes('#13') && v; })()`), "the text in the reply box");
  await page(`button(document.querySelector('.composer'), '送信').click()`);
  await until(() => received.some((t, i) => i > 0 && t.includes(reply)), "the runner got the reply");

  // 6. 削除 (acceptance 1): gone from the list over a reload, and from the request box's select
  await nav("Settings", ".card.presets .preset-new");
  await rowsAre(["レビュー対応からマージまで", "状況の確認"]);
  await page(`window.confirm = () => true; button([...document.querySelectorAll('.preset-row')].find((r) => r.querySelector('.t').textContent === '状況の確認'), '削除').click()`);
  await rowsAre(["レビュー対応からマージまで"]);
  await call("Page.reload");
  await nav("Settings", ".card.presets .preset-new");
  const left = await rowsAre(["レビュー対応からマージまで"]);
  await shot("settings-1280.png");
  await nav("Home", ".compose .preset-picker");
  await openPicker();
  const options = await evaluate(`[...document.querySelector('.preset-picker select').options].slice(1).map((o) => o.textContent)`);
  assert(JSON.stringify(options) === JSON.stringify(["レビュー対応からマージまで"]), `Home's select: ${JSON.stringify(options)}`);

  // 7. 390 × 844: the Home picker and the 設定 card do not scroll sideways
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page(`pick('レビュー対応からマージまで')`);
  await sleep();
  const widthHome = await evaluate("document.documentElement.scrollWidth");
  await shot("home-390.png");
  await nav("Settings", ".card.presets .preset-new");
  await evaluate(`document.querySelector('.card.presets').scrollIntoView()`);
  const widthSettings = await evaluate("document.documentElement.scrollWidth");
  await shot("settings-390.png");
  assert(widthHome <= 390 && widthSettings <= 390, `scrolls sideways at 390px: Home ${widthHome}, 設定 ${widthSettings}`);
  assert(!errors.length, `page errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ listed, refused: { empty: empty.hint, auto: auto.hint, otherRepo, stale: stale.warn }, sent: { title: box.title, text: box.text, permissionMode: mode, approval: perm.buttons }, reply, left, options, scrollWidth: { home: widthHome, settings: widthSettings } }, null, 1));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
