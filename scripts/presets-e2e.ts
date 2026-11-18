/**
 * Run after `bun run --cwd apps/web build`: bun scripts/presets-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * 定型の指示 end to end on a daemon with a fake runner and a fake gh: saved, listed and
 * edited in 設定, kept over a reload, put into the request box with a target and started with one 開始, refused when
 * the target is empty / 自動 / another repository / the Workspace changed, put into a reply, and deleted. The Task it
 * starts still stops on the runner's write approval with 許可 / 拒否 (a preset is not a standing permission).
 * The call is the box itself: the cursor in the request / reply box lays the 3 most sent presets over it, typing narrows them,
 * Tab or a press puts one in. Also measures the 評価項目 (preset-ops, preset-ops-typed, preset-height, preset-shift,
 * preset-reply-ops) and checks them against the values in the table of docs/design/presets.md.
 * The reply buttons under a stop: offered for the kind of stop a preset was sent to before and not for another kind, sent
 * after the 5 seconds' 取り消す (cancelled, nothing is sent; left behind by opening the Task, it is sent once), no height
 * without a stop, the same height with 4 and 30 presets, no sideways scroll at 390 wide.
 * SCREENSHOT_DIR=<dir> saves Home and 設定 at 1280 and 390 wide, both boxes with the candidates shown, and the reply
 * buttons (reply-buttons-*.png).
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
    // a prompt `STOP:<reason>` makes the turn end on that stop (a `switchboard-stop` fence in the reply); the Task's reply then
    // starts the turn that asks for a write, as every other Task here does
    const stopReason = /^STOP:([a-z-]+)/.exec(opts.prompt)?.[1];
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-presets", cwd: opts.cwd });
      // as the real adapters do: the prompt is the Task's first user message
      emit({ t: "message.delta", role: "user", text: opts.prompt });
      if (stopReason) {
        const report = { id: "ask", op: "ask", target: "方針", reason: stopReason, evidence: "どちらにするか", conditions: stopReason === "depends" ? [{ key: "pr#9", value: "CI 待ち", met: false }] : [] };
        emit({ t: "message.delta", role: "assistant", text: "止まります。\n```switchboard-stop\n" + JSON.stringify(report) + "\n```\n" });
        emit({ t: "session.end", status: "ok" });
        exit(0);
        return;
      }
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
const gh = async (args: string[], cwd: string) => (args[0] === "repo" ? { code: 0, stdout: `${cwd === other ? "other/repo" : REPO} true\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no gh in this e2e" });
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
  /** Opens the folded Settings card with this title, once Settings has drawn it: a card shows only its title until opened. */
  const openSettingsCard = (title: string) => until(() => evaluate(`(() => { const d = [...document.querySelectorAll('.settings details.card')].find((d) => d.querySelector('summary').textContent.trim() === ${JSON.stringify(title)}); if (d) d.open = true; return !!d; })()`), `the ${title} card`);
  // React reads a typed value from the native setter + an input / change event
  const page = (body: string) => evaluate(`(() => {
    const set = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
    const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    const opt = (name) => [...document.querySelectorAll('.preset-suggest .preset-opt')].find((o) => o.querySelector('.preset-name').textContent === name);
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
    if (label === "Settings") await openSettingsCard("定型の指示");
  };
  const open = async (label: string, ready: string) => {
    await call("Page.navigate", { url: base });
    await nav(label, ready);
  };
  // the list is read when the box first takes the cursor (no request with the screen); the cursor in the box shows the candidates
  const focusBox = async (box: string) => {
    await page(`const el = document.querySelector(${JSON.stringify(box)}); el.blur(); el.focus({ preventScroll: true });`);
    await until(() => evaluate(`!!document.querySelector('.preset-suggest .preset-opt')`), "the candidates over the box");
  };
  const suggestions = () => evaluate(`[...document.querySelectorAll('.preset-suggest .preset-opt .preset-name')].map((e) => e.textContent)`) as Promise<string[]>;
  const KEYS = { Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 } } as const;
  const press = async (k: keyof typeof KEYS) => { await call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...KEYS[k] }); await call("Input.dispatchKeyEvent", { type: "keyUp", ...KEYS[k] }); };
  const typeChars = async (text: string) => { for (const c of text) await call("Input.insertText", { text: c }); };
  const targetHint = () => evaluate(`document.querySelector('.preset-target .hint')?.textContent ?? ''`) as Promise<string>;
  const rows = () => evaluate(`[...document.querySelectorAll('.preset-row .t')].map((e) => e.textContent)`) as Promise<string[]>;
  const rowsAre = (names: string[]) => until(async () => { const r = await rows(); return JSON.stringify([...r].sort()) === JSON.stringify([...names].sort()) && r; }, `rows ${names}`);
  const sleep = () => Bun.sleep(60);
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setFocusEmulationEnabled", { enabled: true }); // a headless page takes no cursor otherwise
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
  await nav("Home", ".compose .preset-box");
  const before = (await tasks()).length;
  await focusBox(".compose textarea");
  await page(`opt('レビュー対応からマージまで').click()`);
  await until(() => evaluate(`!!document.querySelector('.preset-target input')`), "the target field in place of the candidates");
  await press("Enter");
  const empty = { hint: await targetHint(), text: await evaluate(`document.querySelector('.compose textarea').value`) };
  assert(empty.hint.includes("対象") && empty.text === "", `empty target: ${JSON.stringify(empty)}`);
  await page(`set(document.querySelector('.preset-target input'), '#12')`);
  await sleep();
  await press("Enter");
  const auto = { hint: await targetHint() };
  assert(auto.hint.includes("Workspace"), `自動: ${JSON.stringify(auto)}`);
  await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsDev.id)})`);
  await sleep();
  await page(`set(document.querySelector('.compose select.mode'), 'default')`);
  await page(`set(document.querySelector('.preset-target input'), 'other/repo#3')`);
  await sleep();
  await press("Enter");
  const otherRepo = await until(() => evaluate(`document.querySelector('.preset-target .hint.warn')?.textContent`), "another repository refused");
  assert(otherRepo.includes(`other/repo#3 は Workspace dev のリポジトリ ${REPO} ではありません`), `another repository: ${otherRepo}`);
  assert((await evaluate(`document.querySelector('.compose textarea').value`)) === "", "the request box stays empty on a refusal");

  // 3. 新規依頼 (acceptance 2): the target swapped into the text, the title named after it, one 開始
  await page(`set(document.querySelector('.preset-target input'), '#12')`);
  await sleep();
  await press("Enter");
  const box = await until(() => evaluate(`(() => { const v = document.querySelector('.compose textarea').value; return v.includes('#12') && { text: v, title: document.querySelector('.compose-details input:not([type])').value }; })()`), "the text in the request box");
  assert(box.text === `PR ${REPO}#12 のレビュー指摘に対応してマージまで進めてください（review-triage-and-merge）`, `text: ${box.text}`);
  assert(box.title === `レビュー対応からマージまで ${REPO}#12`, `title: ${box.title}`);
  const chosenMode = await evaluate(`document.querySelector('.compose select.mode').value`);
  assert(chosenMode === "default", `the request box's approval mode stays as chosen: ${chosenMode}`);
  await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsOther.id)})`);
  await sleep();
  const stale = await page(`return ({ start: button(document.querySelector('.compose'), '開始').disabled, warn: document.querySelector('.compose > .warn')?.textContent ?? null })`);
  assert(stale.start && stale.warn?.includes("入れ直して"), `changed Workspace: ${JSON.stringify(stale)}`);
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

  // 5. 返信 (acceptance 2): the same call over the reply box, a new target, 送信
  await until(() => evaluate(`!!document.querySelector('.main .preset-box') && !document.querySelector('.compose')`), "the reply box");
  await focusBox(".composer textarea");
  await page(`opt('レビュー対応からマージまで').click()`);
  await until(() => evaluate(`!!document.querySelector('.preset-target input')`), "the target field in the reply box");
  await page(`set(document.querySelector('.preset-target input'), '#13')`);
  await sleep();
  await press("Enter");
  const reply = await until(() => evaluate(`(() => { const v = document.querySelector('.composer textarea').value; return v.includes('#13') && v; })()`), "the text in the reply box");
  await page(`button(document.querySelector('.composer'), '送信').click()`);
  await until(() => received.some((t, i) => i > 0 && t.includes(reply)), "the runner got the reply");

  // 6. 削除 (acceptance 1): gone from the list over a reload, and from the request box's select
  await nav("Settings", ".card.presets .preset-new");
  await rowsAre(["レビュー対応からマージまで", "状況の確認"]);
  await page(`window.confirm = () => true; button([...document.querySelectorAll('.preset-row')].find((r) => r.querySelector('.t').textContent === '状況の確認'), '削除').click()`);
  await rowsAre(["レビュー対応からマージまで"]);
  // the box read the list before (the reply box above): Settings dropped the cache, so Home shows what is left
  await nav("Home", ".compose .preset-box");
  await focusBox(".compose textarea");
  const options = await suggestions();
  assert(JSON.stringify(options) === JSON.stringify(["レビュー対応からマージまで"]), `Home's candidates: ${JSON.stringify(options)}`);
  await call("Page.reload");
  await nav("Settings", ".card.presets .preset-new");
  const left = await rowsAre(["レビュー対応からマージまで"]);
  await shot("settings-1280.png");

  // 7. 390 × 844: the Home picker and the 設定 card do not scroll sideways
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav("Home", ".compose .preset-box");
  await focusBox(".compose textarea");
  await shot("home-suggest-390.png");
  await page(`opt('レビュー対応からマージまで').click()`);
  await until(() => evaluate(`!!document.querySelector('.preset-target input')`), "the target field");
  const widthHome = await evaluate("document.documentElement.scrollWidth");
  await shot("home-390.png");
  await nav("Settings", ".card.presets .preset-new");
  await evaluate(`document.querySelector('.card.presets').scrollIntoView()`);
  const widthSettings = await evaluate("document.documentElement.scrollWidth");
  await shot("settings-390.png");
  assert(widthHome <= 390 && widthSettings <= 390, `scrolls sideways at 390px: Home ${widthHome}, 設定 ${widthSettings}`);
  // 7a. 操作数: how many operations the call takes, 4 ways. One click or one key press is 1; the characters typed (into the
  // target field, or to narrow the candidates 1 each) are counted only for narrowing. Counting starts when the request / reply box
  // is visible and ends when the expanded text is in it. The cursor in the box is 1, a press on a candidate is 1, and a target
  // is confirmed with Enter 1. The Workspace on Home is chosen before counting: the request needs one whatever the preset (自動
  // cannot check a target).
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const planText = "今の状況を確認して報告してください";
  const created = await fetch(`${base}/api/presets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "状況の確認", text: planText }) });
  assert(created.status === 201, `the plain preset: ${created.status}`);
  const targetPreset = "レビュー対応からマージまで";
  const targetTemplate = "PR {{target}} のレビュー指摘に対応してマージまで進めてください（review-triage-and-merge）";
  const targetText = `PR ${REPO}#12 のレビュー指摘に対応してマージまで進めてください（review-triage-and-merge）`;
  const presetRequests = () => evaluate(`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/presets')).length`) as Promise<number>;
  const boxOf = (where: "home" | "task") => (where === "home" ? ".compose textarea" : ".composer textarea");
  const gotoBox = async (where: "home" | "task") => {
    await call("Page.navigate", { url: where === "home" ? base : `${base}/task/${task.id}` });
    await until(() => evaluate(`!!document.querySelector(${JSON.stringify(boxOf(where))}) && !!document.querySelector('.preset-box')`), `${where}: the box and its wrapper`);
    if (where === "home") {
      await until(() => evaluate(`[...document.querySelectorAll('.compose select option')].some((o) => o.value === ${JSON.stringify(wsDev.id)})`), "the Workspace in the request box");
      await page(`set(document.querySelector('.compose select'), ${JSON.stringify(wsDev.id)})`);
      await sleep();
    }
    // the screen is still filling in (banners, lists): wait until the box has not moved for 300 ms
    const sel = JSON.stringify(boxOf(where));
    let last = NaN, since = Date.now();
    await until(async () => {
      const y = (await evaluate(`document.querySelector(${sel}).getBoundingClientRect().top + scrollY`)) as number;
      if (y !== last) { last = y; since = Date.now(); }
      return Date.now() - since >= 300;
    }, `${where}: the box stops moving`);
  };
  const measure = async (where: "home" | "task", withTarget: boolean) => {
    await gotoBox(where);
    const requestsOnOpen = await presetRequests();
    let n = 0;
    const name = withTarget ? targetPreset : "状況の確認";
    n += 1; // the cursor in the box
    await focusBox(boxOf(where));
    // the first line of both presets is in the candidates (a preset with a target shows its template's first line, not the filled-in one)
    const shown = await evaluate(`document.querySelector('.preset-suggest').innerText`) as string;
    const visible = (await suggestions()).length === 2 && shown.includes(planText) && shown.includes(targetTemplate.split("\n")[0].slice(0, 80));
    n += 1; // a press on the candidate
    await page(`opt(${JSON.stringify(name)}).click()`);
    if (withTarget) {
      await until(() => evaluate(`!!document.querySelector('.preset-target input')`), `${where}: the target field`);
      await page(`set(document.querySelector('.preset-target input'), '#12')`); // the characters are not counted
      await sleep();
      n += 1; // Enter
      await press("Enter");
    }
    const text = await until(() => evaluate(`document.querySelector(${JSON.stringify(boxOf(where))}).value`), `${where} ${withTarget ? "target" : "plain"}: the text in the box`).catch(async (e) => { console.error(await evaluate(`document.querySelector('.compose, .composer').innerText + ' | ' + document.querySelector('.compose select')?.value`)); throw e; });
    assert(text === (withTarget ? targetText : planText), `${where} ${withTarget ? "target" : "plain"}: ${text}`);
    assert(!(await evaluate(`!!document.querySelector('.preset-suggest')`)), `${where}: the candidates close once the text is in`);
    return { n, visible, requestsOnOpen };
  };
  const m = { "home-plain": await measure("home", false), "task-plain": await measure("task", false), "home-target": await measure("home", true), "task-target": await measure("task", true) };
  const ops = Object.entries(m).map(([k, v]) => `${k}=${v.n}`).join(" ");
  console.log(`preset-ops ${ops}`);
  // the after values of the 評価項目 table: a change to the call has to update both
  assert(ops === "home-plain=2 task-plain=2 home-target=3 task-target=3", `preset-ops differs from the 評価項目 table: ${ops}`);
  console.log(`preset-first-line-visible home=${m["home-plain"].visible} task=${m["task-plain"].visible}`);
  assert(m["home-plain"].visible && m["task-plain"].visible && m["home-target"].visible && m["task-target"].visible, "the candidates show the first line of both presets");
  console.log(`preset-requests-on-open home=${m["home-plain"].requestsOnOpen} task=${m["task-plain"].requestsOnOpen}`);
  assert(m["home-plain"].requestsOnOpen === 0 && m["task-plain"].requestsOnOpen === 0, "opening Home or a Task asks for no list");

  // 7b. 評価項目 (added 2026-11-15): the height the call takes outside the box when unused, how far the box moves when the
  // candidates are shown, and the operations from seeing a question to sending a preset reply.
  const sized = (w: number) => call("Emulation.setDeviceMetricsOverride", w === 390 ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  /** What the wrapper around the box takes besides the box: its own margin, padding and border, and the children in the flow that are not the box. 0 when nothing is added. */
  const taken = (where: "home" | "task") => gotoBox(where).then(() => evaluate(`(() => { const ta = document.querySelector(${JSON.stringify(boxOf(where))}); const w = ta.closest('.preset-box'); if (!w) return 0; const c = getComputedStyle(w); const px = (k) => parseFloat(c[k]) || 0; let h = px('marginTop') + px('marginBottom') + px('paddingTop') + px('paddingBottom') + px('borderTopWidth') + px('borderBottomWidth'); for (const k of w.children) if (k !== ta && getComputedStyle(k).position !== 'absolute') h += k.getBoundingClientRect().height; return Math.round(h * 10) / 10; })()`)) as Promise<number>;
  const heights = async (n: number) => {
    const out: Record<string, number> = {};
    for (const w of [390, 1280]) {
      await sized(w);
      out[`w${w}-n${n}`] = Math.max(await taken("home"), await taken("task"));
    }
    return out;
  };
  const fill = async (to: number) => {
    const have = ((await (await fetch(`${base}/api/presets`)).json()) as { presets: unknown[] }).presets.length;
    for (let i = have; i < to; i++) {
      const r = await fetch(`${base}/api/presets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `定型 ${i + 1}`, text: `返事 ${i + 1}` }) });
      assert(r.status === 201, `preset ${i + 1}: ${r.status}`);
    }
  };
  await fill(4);
  const h4 = await heights(4);
  // how far the box's top (and the page's height) moves when the candidates are shown, the larger of the two widths
  const shift: Record<string, number> = {};
  const byWidth: string[] = [];
  for (const w of [390, 1280]) {
    await sized(w);
    for (const where of ["home", "task"] as const) {
      await gotoBox(where);
      const probe = () => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(boxOf(where))}).getBoundingClientRect(); return [r.top + scrollY, document.documentElement.scrollHeight]; })()`) as Promise<[number, number]>;
      const was = await probe();
      await focusBox(boxOf(where));
      await sleep();
      const now = await probe();
      await page(`document.querySelector(${JSON.stringify(boxOf(where))}).scrollIntoView({ block: "center" })`);
      await shot(`${where}-suggest-${w}.png`);
      const d = Math.round(Math.max(Math.abs(now[0] - was[0]), Math.abs(now[1] - was[1])) * 10) / 10; byWidth.push(`w${w}-${where}=${d}`); shift[where] = Math.max(shift[where] ?? 0, d);
    }
  }
  // The reply buttons under a stop. Tasks 1, 2, 4 and 5 stop on a decision, 3 on depends (a `switchboard-stop` in the runner's reply).
  // The operations from seeing the question to sending a preset reply: one press on the button (the 5 seconds' wait and 取り消す are not counted).
  await sized(1280);
  const UNDO_MS = 5000;
  const marksNow = async () => (await (await fetch(`${base}/api/tasks/stops`)).json()) as Record<string, { reason: string; replies: Array<{ name: string; text: string }> }>;
  const stopTask = async (title: string, reason: string) => {
    const r = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dev, title, prompt: `STOP:${reason}`, runner: "claude" }) });
    assert(r.ok, `${title}: ${r.status}`);
    const t = (await r.json()) as Task;
    await until(async () => (await marksNow())[t.id]?.reason === reason, `the stop mark of ${title}`);
    return t;
  };
  const openTask = async (id: string) => {
    await call("Page.navigate", { url: `${base}/task/${id}` });
    await until(() => evaluate(`!!document.querySelector('.composer textarea')`), "the Task's reply box");
  };
  const rowSel = (title: string) => `[...document.querySelectorAll('.attn-group, .waiting-folded > div')].find((g) => g.querySelector('button.row .t')?.textContent === ${JSON.stringify(title)})`;
  const homeRow = async (title: string) => {
    await gotoBox("home");
    await until(() => evaluate(`!!(${rowSel(title)})`), `the Home row of ${title}`);
  };
  /** The one-press buttons in the scope (the whole page, or the Home row of a Task): their texts. */
  const replyButtons = (title?: string) => evaluate(`[...((${title ? `${rowSel(title)}` : "document"})?.querySelectorAll('.preset-replies button') ?? [])].map((b) => b.textContent.trim())`) as Promise<string[]>;
  /** The height the reply buttons' rows take (0 when none is drawn). */
  const replyHeight = async (title?: string) => {
    const read = () => evaluate(`[...(${title ? `${rowSel(title)}` : "document"}).querySelectorAll('.preset-replies')].reduce((a, e) => a + e.getBoundingClientRect().height, 0)`) as Promise<number>;
    // the screen is still filling in: the value counts once it has not moved for 300 ms
    let last = NaN, since = Date.now();
    return until(async () => { const h = await read(); if (h !== last) { last = h; since = Date.now(); } return Date.now() - since >= 300 && (h > 0 || h === 0 ? { h } : null); }, "the reply row's height to settle").then((v) => v.h);
  };
  const showReplies = (title?: string) => evaluate(`(${title ? `${rowSel(title)}` : "document"}).querySelector('.preset-replies')?.scrollIntoView({ block: "center" })`);
  const sideways = () => evaluate(`document.documentElement.scrollWidth`) as Promise<number>;
  const approvalBy = async (id: string) => {
    await openTask(id);
    await until(() => evaluate(`!!document.querySelector('.perm')`), "the write approval of the Task");
    const buttons = await evaluate(`[...document.querySelectorAll('.perm .actions button')].map((b) => b.textContent.trim())`);
    assert(JSON.stringify(buttons) === JSON.stringify(["許可", "拒否"]), `the write still waits for 許可 / 拒否: ${JSON.stringify(buttons)}`);
    // answered, so the run frees its slot (the daemon runs 3 at a time; a reply to another Task would wait for one)
    await page(`button(document.querySelector('.perm'), '許可').click()`);
    await until(async () => (await tasks()).find((x) => x.id === id)?.status !== "waiting", "the approval answered");
  };

  // nothing is drawn, and no height is taken, with no question: the Home with no stopped Task of this kind and a Task that has no stop
  await gotoBox("home");
  assert((await replyButtons()).length === 0 && (await replyHeight()) === 0, "Home with no stop reports takes no height for the reply buttons");
  await gotoBox("task");
  assert((await replyButtons()).length === 0 && (await replyHeight()) === 0, "a Task with no question takes no height for the reply buttons");

  const t1 = await stopTask("stop 1", "decision");
  const t2 = await stopTask("stop 2", "decision");
  const t3 = await stopTask("stop 3", "depends");
  const t4 = await stopTask("stop 4", "decision");
  const t5 = await stopTask("stop 5", "decision");
  const unanswered = await marksNow();
  assert([t1, t2, t3, t4, t5].every((x) => unanswered[x.id]?.replies.length === 0), `no reply is offered before a preset was sent to a decision stop: ${JSON.stringify(unanswered)}`);

  // Task 1: the person answers with the preset X (no target) from its reply box; the use is recorded with the stop's kind
  await openTask(t1.id);
  await focusBox(".composer textarea");
  await page(`opt('状況の確認').click()`);
  await until(async () => (await evaluate(`document.querySelector('.composer textarea').value`)) === planText, "the preset in Task 1's reply box");
  await page(`button(document.querySelector('.composer'), '送信').click()`);
  await until(() => received[received.length - 1] === planText, "the runner got Task 1's reply");
  const uses = core.db.getSetting<Array<{ scene: string; kind: string | null }>>("presetUses", []);
  assert(uses.at(-1)?.scene === "task" && uses.at(-1)?.kind === "decision", `the use is recorded with the stop's kind: ${JSON.stringify(uses.at(-1))}`);

  // X is offered under Task 2's question and in its Home row, and not for Task 3 (a depends stop has no record of a reply)
  await openTask(t2.id);
  await until(async () => JSON.stringify(await replyButtons()) === JSON.stringify([planText]), "X under Task 2's question");
  const taskH4 = await replyHeight();
  await openTask(t3.id);
  // opening reloads the page, and App reads the stop marks again (from `GET /api/tasks` or `GET /api/tasks/stops`):
  // wait until those reads have answered, then a little for the screen to draw with them
  await until(async () => (await evaluate(`performance.getEntriesByType('resource').some((e) => /\\/api\\/tasks(\\/stops)?$/.test(new URL(e.name).pathname) && e.responseEnd > 0)`)) === true, "the stop marks read for Task 3's screen");
  await Bun.sleep(600);
  assert((await replyButtons()).length === 0 && (await replyHeight()) === 0, "Task 3 (depends) has no reply buttons");
  await homeRow(t2.title);
  await until(async () => JSON.stringify(await replyButtons(t2.title)) === JSON.stringify([planText]), "X in Task 2's Home row");
  assert((await replyButtons(t3.title)).length === 0 && (await replyHeight(t3.title)) === 0, "Task 3's Home row has no reply buttons");
  const homeH4 = await replyHeight(t2.title);
  assert(taskH4 > 0 && homeH4 > 0, `the buttons take a line: ${taskH4} ${homeH4}`);
  await showReplies(t2.title);
  await shot("reply-buttons-home-1280.png");
  // 4 presets and 30 presets: the same height (the buttons are what was sent, not the list)
  await fill(30);
  await openTask(t2.id);
  await until(async () => (await replyButtons()).length === 1, "X under Task 2's question with 30 presets");
  const taskH30 = await replyHeight();
  await homeRow(t2.title);
  await until(async () => (await replyButtons(t2.title)).length === 1, "X in Task 2's Home row with 30 presets");
  const homeH30 = await replyHeight(t2.title);
  assert(Math.abs(taskH4 - taskH30) <= 1 && Math.abs(homeH4 - homeH30) <= 1, `the row's height with 4 and 30 presets: Task ${taskH4} ${taskH30}, Home ${homeH4} ${homeH30}`);

  // 390 wide: no sideways scroll with the buttons, nor while a press waits
  await sized(390);
  await openTask(t4.id);
  await until(async () => (await replyButtons()).length === 1, "X under Task 4's question at 390");
  const w390 = { task: await sideways(), home: 0 };
  // the row is a flex child of the Task's column and must keep the height of its button (it can shrink to its padding when the screen is tight)
  const clip = (await evaluate(`(() => { const r = document.querySelector('.preset-replies'); const b = r.querySelector('button'); return { row: r.getBoundingClientRect().height, button: b.getBoundingClientRect().height }; })()`)) as { row: number; button: number };
  assert(clip.row >= clip.button, `the reply buttons are cut at 390: the row is ${clip.row}px high, the button ${clip.button}px`);
  await showReplies();
  await shot("reply-buttons-task-390.png");
  await page(`document.querySelector('.preset-replies button').click()`);
  await until(() => evaluate(`!!document.querySelector('.preset-replies') && document.querySelector('.preset-replies').innerText.includes('取り消す')`), "the wait with 取り消す at 390");
  w390.task = Math.max(w390.task, await sideways());
  await showReplies();
  await shot("reply-buttons-task-390-waiting.png");
  await page(`button(document.querySelector('.preset-replies'), '取り消す').click()`);
  await homeRow(t2.title);
  w390.home = await sideways();
  await showReplies(t2.title);
  await shot("reply-buttons-home-390.png");
  assert(w390.task <= 390 && w390.home <= 390, `the reply buttons scroll sideways at 390: ${JSON.stringify(w390)}`);
  await sized(1280);

  // Home: a press waits with 取り消す; cancelled inside the 5 seconds, nothing reaches the runner
  await homeRow(t2.title);
  let replyHome = 0;
  const sentBefore = received.length;
  replyHome += 1; // the press on the button
  await evaluate(`${rowSel(t2.title)}.querySelector('.preset-replies button').click()`);
  await until(() => evaluate(`${rowSel(t2.title)}?.querySelector('.preset-replies')?.innerText.includes('取り消す') ?? false`), "the wait with 取り消す on Home (a press must not send at once)");
  await evaluate(`[...${rowSel(t2.title)}.querySelectorAll('.preset-replies button')].find((b) => b.textContent.trim() === '取り消す').click()`);
  await Bun.sleep(UNDO_MS + 700);
  assert(received.length === sentBefore, `a cancelled press sent something: ${received.slice(sentBefore).join(" | ")}`);
  await until(async () => JSON.stringify(await replyButtons(t2.title)) === JSON.stringify([planText]), "the button back after cancelling");
  // pressed again and left: one message arrives, with X's text, and the write still waits for 許可 / 拒否
  await evaluate(`${rowSel(t2.title)}.querySelector('.preset-replies button').click()`);
  await until(() => received.length > sentBefore, "the runner got the reply after the wait");
  await Bun.sleep(500);
  assert(received.length === sentBefore + 1 && received[sentBefore] === planText, `one message with X's text: ${received.slice(sentBefore).join(" | ")}`);
  await approvalBy(t2.id);
  const usesHome = core.db.getSetting<Array<{ scene: string; kind: string | null }>>("presetUses", []);
  assert(usesHome.at(-1)?.scene === "task" && usesHome.at(-1)?.kind === "decision", `the press is recorded with the stop's kind: ${JSON.stringify(usesHome.at(-1))}`);

  // Task 4, from inside the Task: one press, then the same
  await openTask(t4.id);
  await until(async () => (await replyButtons()).length === 1, "X under Task 4's question");
  let replyTask = 0;
  const sentTask = received.length;
  replyTask += 1; // the press on the button
  await page(`document.querySelector('.preset-replies button').click()`);
  await until(() => received.length > sentTask, "the runner got Task 4's reply after the wait").catch(async (e) => { console.error(await evaluate(`document.querySelector('.main').innerText.slice(0, 800)`), JSON.stringify(received.slice(-4))); throw e; });
  await Bun.sleep(500);
  assert(received.length === sentTask + 1 && received[sentTask] === planText, `Task 4: one message with X's text: ${received.slice(sentTask).join(" | ")}`);
  await approvalBy(t4.id);

  // Task 5: pressed on Home, then the Task is opened (Home is left) inside the 5 seconds: not cancelled, so exactly one message arrives
  await homeRow(t5.title);
  const sentLeave = received.length;
  await evaluate(`${rowSel(t5.title)}.querySelector('.preset-replies button').click()`);
  await until(() => evaluate(`${rowSel(t5.title)}?.querySelector('.preset-replies')?.innerText.includes('取り消す') ?? false`), "the wait with 取り消す before leaving Home");
  await evaluate(`${rowSel(t5.title)}.querySelector('button.row').click()`);
  await until(() => received.length > sentLeave, "the runner got the reply of the press left behind");
  await Bun.sleep(UNDO_MS + 700);
  assert(received.length === sentLeave + 1 && received[sentLeave] === planText, `leaving Home during the wait: one message with X's text: ${received.slice(sentLeave).join(" | ")}`);
  await approvalBy(t5.id);
  await fill(30); // already 30 from the reply buttons above
  const h30 = await heights(30);
  // a preset that is not among the top 3 (each box uses another one, as the one just put in is the latest used): 2 characters narrow the 30 to it, then Tab. The cursor 1 + 2 characters + Tab 1.
  const typedOps = async (where: "home" | "task", i: string) => {
    await gotoBox(where);
    let n = 0;
    n += 1;
    await focusBox(boxOf(where));
    assert(!(await suggestions()).includes(`定型 ${i}`), `${where}: 定型 ${i} is not among the top 3`);
    n += 2;
    await typeChars(i);
    await until(async () => JSON.stringify(await suggestions()) === JSON.stringify([`定型 ${i}`]), `${where}: the candidates narrowed to 定型 ${i}`);
    n += 1;
    await press("Tab");
    await until(() => evaluate(`document.querySelector(${JSON.stringify(boxOf(where))}).value === '返事 ${i}'`), `${where}: the text in the box`);
    assert(!(await evaluate(`!!document.querySelector('.preset-suggest')`)), `${where} typed: the candidates close once the text is in`);
    return n;
  };
  const typedHome = await typedOps("home", "17");
  const typedTask = await typedOps("task", "18");
  console.log(`preset-ops-typed home=${typedHome} task=${typedTask}`);
  assert(typedHome <= 4 && typedTask <= 4, `preset-ops-typed: ${typedHome} ${typedTask}`);
  const heightLine = [h4["w390-n4"], h30["w390-n30"], h4["w1280-n4"], h30["w1280-n30"]].map((v, i) => `${["w390-n4", "w390-n30", "w1280-n4", "w1280-n30"][i]}=${v}`).join(" ");
  const shiftLine = `home=${shift.home} task=${shift.task}`;
  console.log(`preset-height ${heightLine}`);
  console.log(`preset-shift ${shiftLine}`);
  console.log(`preset-shift-by-width ${byWidth.join(" ")}`);
  console.log(`preset-reply-ops home=${replyHome} task=${replyTask}`);
  // heights are compared within 1 px; the operation counts are exact
  const near = (got: Record<string, number>, want: Record<string, number>) => Object.entries(want).every(([k, v]) => Math.abs((got[k] ?? NaN) - v) <= 1);
  assert(near({ ...h4, ...h30 }, { "w390-n4": 0, "w390-n30": 0, "w1280-n4": 0, "w1280-n30": 0 }), `preset-height differs from the 評価項目 table: ${heightLine}`);
  assert(near(shift, { home: 0, task: 0 }), `preset-shift differs from the 評価項目 table: ${shiftLine}`);
  assert(`home=${replyHome} task=${replyTask}` === "home=1 task=1", `preset-reply-ops differs from the 評価項目 table: ${replyHome} ${replyTask}`);

  // 7c. the keys and the cases where nothing is offered: Esc, the arrows, Tab on an empty box, 390 wide, an IME, 1 character
  await sized(1280);
  const listShown = () => evaluate(`!!document.querySelector('.preset-suggest .preset-opt')`) as Promise<boolean>;
  const selectedAt = () => evaluate(`[...document.querySelectorAll('.preset-suggest .preset-opt')].findIndex((o) => o.getAttribute('aria-selected') === 'true')`) as Promise<number>;
  const valueOf = (where: "home" | "task") => evaluate(`document.querySelector(${JSON.stringify(boxOf(where))}).value`) as Promise<string>;
  for (const where of ["home", "task"] as const) {
    // Esc closes the list; it stays closed while typing and comes back once the box is emptied
    await gotoBox(where);
    await focusBox(boxOf(where));
    await press("Escape");
    await sleep();
    assert(!(await listShown()), `${where}: Esc closes the list`);
    await typeChars("定型");
    await sleep();
    assert(!(await listShown()), `${where}: the list stays closed while typing after Esc`);
    await page(`set(document.querySelector(${JSON.stringify(boxOf(where))}), '')`);
    await until(listShown, `${where}: the list again once the box is emptied`);
    // the arrows choose (and wrap around)
    assert((await selectedAt()) === 0, `${where}: the first candidate is chosen at first`);
    await press("ArrowDown");
    assert((await selectedAt()) === 1, `${where}: Down chooses the second`);
    await press("ArrowDown"); await press("ArrowDown");
    assert((await selectedAt()) === 0, `${where}: Down from the last wraps to the first`);
    await press("ArrowUp");
    assert((await selectedAt()) === 2, `${where}: Up from the first wraps to the last`);
    // Tab on an empty box puts nothing in until an arrow was used
    await focusBox(boxOf(where));
    await press("Tab");
    await sleep();
    assert((await valueOf(where)) === "" && !(await evaluate(`!!document.querySelector('.preset-target input')`)), `${where}: Tab on an empty box puts nothing in`);
    await focusBox(boxOf(where));
    await press("ArrowDown");
    await press("Tab");
    await until(() => evaluate(`document.querySelector(${JSON.stringify(boxOf(where))}).value !== '' || !!document.querySelector('.preset-target input')`), `${where}: Tab after an arrow puts the chosen preset in`);
  }
  // IME: nothing is offered between compositionstart and compositionend
  await gotoBox("home");
  await focusBox(boxOf("home"));
  await page(`document.querySelector(${JSON.stringify(boxOf("home"))}).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`);
  await sleep();
  assert(!(await listShown()), "no list while an IME is composing");
  await page(`document.querySelector(${JSON.stringify(boxOf("home"))}).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`);
  await until(listShown, "the list after the composition ends");
  // 1 character: nothing is offered, and Tab leaves the box without putting a preset in
  const alpha = await fetch(`${base}/api/presets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Alpha", text: "返事 alpha" }) });
  assert(alpha.status === 201, `the Alpha preset: ${alpha.status}`);
  for (const where of ["home", "task"] as const) {
    await gotoBox(where);
    await focusBox(boxOf(where));
    await typeChars("A");
    await sleep();
    assert(!(await listShown()), `${where}: 1 character offers nothing`);
    await press("Tab");
    await sleep();
    assert((await valueOf(where)) === "A", `${where}: Tab after 1 character leaves the text as typed: ${await valueOf(where)}`);
  }
  // 2 characters that are only in a preset's text ("ok" in "token"): offered, but Tab leaves the text as typed; an arrow then Tab takes it
  const token = await fetch(`${base}/api/presets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Beta", text: "token を確かめる" }) });
  assert(token.status === 201, `the Beta preset: ${token.status}`);
  for (const where of ["home", "task"] as const) {
    await gotoBox(where);
    await focusBox(boxOf(where));
    await typeChars("ok");
    await until(async () => (await suggestions()).includes("Beta"), `${where}: "ok" offers Beta by its text`);
    await press("Tab");
    await sleep();
    assert((await valueOf(where)) === "ok", `${where}: Tab after a text-only match leaves the text as typed: ${await valueOf(where)}`);
    await focusBox(boxOf(where));
    await press("ArrowDown"); await press("ArrowUp");
    await press("Tab");
    await until(() => evaluate(`document.querySelector(${JSON.stringify(boxOf(where))}).value === 'token を確かめる'`), `${where}: an arrow then Tab takes the text-only match`);
  }
  // an arrow, then typing and emptying the box: Tab on the empty box takes nothing again
  await gotoBox("home");
  await focusBox(boxOf("home"));
  await press("ArrowDown");
  await typeChars("x");
  await page(`set(document.querySelector(${JSON.stringify(boxOf("home"))}), '')`);
  await until(listShown, "the list again once the box is emptied after an arrow");
  await press("Tab");
  await sleep();
  assert((await valueOf("home")) === "" && !(await evaluate(`!!document.querySelector('.preset-target input')`)), "Tab on an emptied box takes nothing after the text changed");
  // 390 wide: with no room above the box the list lies over what is under it; 1280 wide keeps it above
  await gotoBox("home");
  await focusBox(boxOf("home"));
  assert(!(await evaluate(`!!document.querySelector('.preset-suggest.below')`)), "1280 wide: the list lies above the box");
  await sized(390);
  await gotoBox("home");
  await focusBox(boxOf("home"));
  await sleep();
  assert(await evaluate(`!!document.querySelector('.preset-suggest.below')`), "390 wide: the list lies below the box");
  await sized(1280);

  // 7d. a press on the target field's frame (not the input) keeps the field and what was typed; coming back to the box after a
  // preset was put in does not offer that preset again, and rewriting the box does
  await gotoBox("home");
  await focusBox(boxOf("home"));
  await page(`opt(${JSON.stringify(targetPreset)}).click()`);
  await until(() => evaluate(`!!document.querySelector('.preset-target input')`), "7d: the target field");
  await page(`set(document.querySelector('.preset-target input'), '#12')`);
  await sleep();
  const hintAt = (await evaluate(`(() => { const r = document.querySelector('.preset-target .hint').getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; })()`)) as { x: number; y: number };
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: hintAt.x, y: hintAt.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: hintAt.x, y: hintAt.y, button: "left", clickCount: 1 });
  await sleep();
  const kept = await evaluate(`({ value: document.querySelector('.preset-target input')?.value ?? null, focused: document.activeElement === document.querySelector('.preset-target input') })`);
  assert(kept.value === "#12" && kept.focused, `a press on the target field's frame keeps the field and the typed target: ${JSON.stringify(kept)}`);
  await gotoBox("home");
  await focusBox(boxOf("home"));
  await page(`opt('状況の確認').click()`);
  await until(async () => (await valueOf("home")) === planText, "7d: the plain preset's text in the box");
  await page(`document.activeElement.blur()`);
  await sleep();
  await page(`document.querySelector(${JSON.stringify(boxOf("home"))}).focus({ preventScroll: true })`);
  await sleep();
  assert(!(await listShown()), "coming back to the box with the text just put in offers nothing");
  await page(`set(document.querySelector(${JSON.stringify(boxOf("home"))}), '状況')`);
  await page(`document.activeElement.blur()`);
  await sleep();
  await page(`document.querySelector(${JSON.stringify(boxOf("home"))}).focus({ preventScroll: true })`);
  await until(listShown, "coming back after rewriting the box offers the candidates");

  assert(!errors.length, `page errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ listed, refused: { empty: empty.hint, auto: auto.hint, otherRepo, stale: stale.warn }, sent: { title: box.title, text: box.text, permissionMode: mode, approval: perm.buttons }, reply, left, options, scrollWidth: { home: widthHome, settings: widthSettings } }, null, 1));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
