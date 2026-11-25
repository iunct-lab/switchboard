/**
 * Run after `bun run --cwd apps/web build`: bun scripts/compose-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The Home box (`Compose`) end to end on a daemon with a fake runner and the fixtures' fake gh: 今すぐ始める starts a Task,
 * バックログに積む files a request (the agent turns it into a PBI), there is no switch to choose between them, 要望にしてすぐ直す
 * is in 詳細 while developSelf is on and absent when it is off, 詳細 also holds 自分で書いて保存 (an Issue saved as written,
 * no Task), and a draft kept for 自分で書いて保存 opens it. Prints how many controls the box shows unfolded.
 * SHOTS=<dir> picks where the pictures of the opened 詳細 at 390 and 1280 wide go; the directory is printed at the end.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { GhRunner } from "../packages/core/src/backlog-gh.ts";
import { importing, sending } from "../packages/core/fixtures/github-import.ts";
import type { RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";

const fixtures = join(import.meta.dir, "..", "packages", "core", "fixtures");
const pages = JSON.parse(readFileSync(join(fixtures, "backlog-graphql.json"), "utf8"));
const decisions = readFileSync(join(fixtures, "backlog-decisions.json"), "utf8");
const libPage = readFileSync(join(fixtures, "backlog-graphql-2.json"), "utf8");
const home = mkdtempSync(join(tmpdir(), "sb-compose-e2e-"));
const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "sb-compose-e2e-shots-"));
mkdirSync(shots, { recursive: true });
const libDir = join(home, "lib");
mkdirSync(libDir);
const starts: StartOptions[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    starts.push(opts);
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: Promise.resolve(0) };
  },
};
// the gh of backlog-e2e: acme/app is the meta workspace, acme/lib a registered one; the fixtures answer the lists
const gh: GhRunner = async (args, cwd) => {
  if (args[0] === "repo") return { code: 0, stdout: cwd === libDir ? "acme/lib true\n" : "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args[0] === "issue") return { code: 0, stdout: "", stderr: "" };
  if (args.some((a) => a.includes("rateLimit {"))) return { code: 0, stdout: '{"data":{"rateLimit":{"remaining":0,"cost":1}}}', stderr: "" };
  if (cwd === libDir) return { code: 0, stdout: args.some((a) => a.includes("comments(last:")) ? '{"data":{"repository":{"i306":{"comments":{"nodes":[]}},"i304":{"comments":{"nodes":[]}}}}}' : libPage, stderr: "" };
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: '{"data":{"repository":{}}}', stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: decisions, stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
delete process.env.SWITCHBOARD_PROJECT_URL;
const repo = join(home, "app");
mkdirSync(repo);
cpSync(join(import.meta.dir, "../ops-kit/processes"), join(repo, "ops-kit/processes"), { recursive: true });
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: repo });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(sending(gh)) });
const base = `http://127.0.0.1:${core.server.port}`;
await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: libDir, name: "lib" }) });
await fetch(`${base}/api/backlog?refresh=1`);
const libId = core.db.listWorkspaces().find((w) => w.name === "lib")!.id;
const metaId = core.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const tasks = async () => (await (await fetch(`${base}/api/tasks`)).json()) as Task[];

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tab = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
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
  const pressAt = async (point: { x: number; y: number } | null, what: string) => {
    assert(point, `clickable ${what}`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  /** Waits until the element stopped moving (Home fills in under it as its data arrives), so a press lands on it. */
  const settled = async (selector: string) => {
    let last = "";
    await until(async () => { const now = await evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect() ?? null)`) as string; const same = now === last && now !== "null"; last = now; if (!same) await Bun.sleep(150); return same; }, `${selector} is still`);
  };
  const clickEl = async (selector: string) => (await settled(selector), pressAt(await evaluate(`(() => {const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled || b.getClientRects().length === 0) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`), selector));
  const clickText = async (label: string, scope: string) => pressAt(await evaluate(`(() => {const b = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length > 0); if (!b || b.disabled) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`), `${label} in ${scope}`);
  /** Sets a field as a person does: the native setter and an input / change event (React reads it). */
  const setField = (selector: string, value: string) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
  const BOX = "main.home section.card.compose";
  const openHome = async () => {
    await evaluate(`window.__before = 1`).catch(() => undefined);
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`window.__before === undefined`).catch(() => false), "the page is new");
    await until(() => evaluate(`!!document.querySelector('${BOX}[data-compose]') || !!document.querySelector('main.home [data-compose]')`), "Home box");
  };
  const openDetails = async () => {
    await until(() => evaluate(`!!document.querySelector('${BOX} details.compose-details')`), "詳細 is drawn");
    if (!(await evaluate(`document.querySelector('${BOX} details.compose-details').open`))) await clickEl(`${BOX} details.compose-details > summary`);
    await until(() => evaluate(`document.querySelector('${BOX} details.compose-details').open`), "詳細 open");
  };
  /** Types into the box's text and leaves its repository where the test says ("" keeps the default). */
  const write = async (text: string, workspaceId = "") => {
    if (workspaceId) {
      await until(() => evaluate(`!![...document.querySelectorAll('${BOX} .fields select option')].find(o => o.value === ${JSON.stringify(workspaceId)})`), "the workspace is listed");
      await setField(`${BOX} .fields select`, workspaceId);
      await until(() => evaluate(`document.querySelector('${BOX} .fields select').value === ${JSON.stringify(workspaceId)}`), "the workspace is chosen");
    }
    await setField(`${BOX} textarea`, text);
  };
  const tasksAfter = async (known: Set<string>) => until(async () => { const fresh = (await tasks()).filter((t) => !known.has(t.id)); return fresh.length === 1 ? fresh[0] : null; }, "one more Task");
  const knownIds = async () => new Set((await tasks()).map((t) => t.id));
  const openedTitle = (title: string) => until(() => evaluate(`[...document.querySelectorAll('.rail .it.on')].some(b => b.querySelector('.t')?.textContent === ${JSON.stringify(title)}) && !document.querySelector('main.home') ? true : null`), `the Task "${title}" is open`);
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  const result: Record<string, unknown> = {};

  // 6197 (a): 今すぐ始める → one more Task, its screen opens, the runner got the text
  await openHome();
  const startText = "E2E 今すぐ始める";
  let known = await knownIds();
  await write(startText, libId);
  await until(() => evaluate(`!document.querySelector('${BOX} [data-compose-start]').disabled`), "start enabled");
  await clickEl(`${BOX} [data-compose-start]`);
  const started = await tasksAfter(known);
  await openedTitle(started.title);
  const startPrompt = (await until(() => starts.find((s) => s.prompt.includes(startText)), "the runner's prompt of 今すぐ始める")).prompt;
  assert(!started.title.startsWith("要望: ") && startPrompt.includes(startText), `今すぐ始める: ${started.title}`);
  result.start = started.title;

  // 6197 (b): バックログに積む with the same text → a 要望 Task is started, its prompt has the text
  await openHome();
  known = await knownIds();
  await write(startText);
  await until(() => evaluate(`!document.querySelector('${BOX} [data-compose-backlog]').disabled`), "backlog button enabled");
  await clickEl(`${BOX} [data-compose-backlog]`);
  const filed = await tasksAfter(known);
  assert(filed.title.startsWith("要望: "), `バックログに積む made: ${filed.title}`);
  await until(() => starts.filter((s) => s.prompt.includes(startText)).length >= 2, "the runner's prompt of バックログに積む");
  result.backlog = filed.title;

  // 6197 (c): no switch to choose how the text is handled; the two buttons are the choice, and only 今すぐ始める is primary
  await openHome();
  const shape = await evaluate(`(() => { const c = document.querySelector('${BOX}'); return { radios: c.querySelectorAll('input[name="feedback-mode"]').length, pri: [...c.querySelectorAll('.pri')].map(b => b.getAttribute('data-compose-start') !== null ? 'start' : b.textContent.trim()), backlog: c.querySelectorAll('[data-compose-backlog]').length, start: c.querySelectorAll('[data-compose-start]').length, boxes: document.querySelectorAll('.compose').length }; })()`) as { radios: number; pri: string[]; backlog: number; start: number; boxes: number };
  assert(shape.radios === 0 && shape.backlog === 1 && shape.start === 1 && JSON.stringify(shape.pri) === JSON.stringify(["start"]) && shape.boxes === 1, `box shape: ${JSON.stringify(shape)}`);

  // 6197 (e): the controls shown without opening anything (the same expression on origin/main's build gives one fewer)
  const shown = await evaluate(`[...document.querySelector('${BOX}').querySelectorAll('input, select, textarea, button')].filter(e => e.getClientRects().length > 0 && !e.closest('details:not([open])')).length`) as number;
  console.log(`unfolded controls in the Home box: ${shown}`);
  result.unfoldedControls = shown;

  // 6199 (a): 詳細 holds the per-runner model / budget fields, 要望にしてすぐ直す (developSelf on) and 自分で書いて保存
  await openDetails();
  const parts = await evaluate(`(() => { const d = document.querySelector('${BOX} details.compose-details'); return { runners: !!d.querySelector('.runners select, .runners input.model'), fix: !!d.querySelector('[data-compose-fix]'), save: !!d.querySelector('details.compose-save[data-compose-save]') }; })()`) as { runners: boolean; fix: boolean; save: boolean };
  assert(parts.runners && parts.fix && parts.save, `詳細: ${JSON.stringify(parts)}`);

  // 6197 (d): [data-compose-fix] in 詳細 starts a 「直す: 」 Task
  known = await knownIds();
  await write("E2E ここを直して");
  await clickEl(`${BOX} [data-compose-fix]`);
  const fixed = await tasksAfter(known);
  assert(fixed.title.startsWith("直す: "), `fix: ${fixed.title}`);
  await until(() => starts.find((s) => s.prompt.includes("E2E ここを直して")), "the runner's prompt of the fix");
  result.fix = fixed.title;

  // 6199 (b): 自分で書いて保存 with kind PBI and a title → the Backlog lists it, no Task starts
  await openHome();
  await openDetails();
  const saveTitle = "PBI: 欄から保存した";
  const taskCount = (await tasks()).length;
  await until(() => evaluate(`!!document.querySelector('${BOX} details.compose-save')`), "自分で書いて保存 drawn");
  if (!(await evaluate(`document.querySelector('${BOX} details.compose-save').open`))) await clickEl(`${BOX} details.compose-save > summary`);
  await until(() => evaluate(`document.querySelector('${BOX} details.compose-save').open`), "自分で書いて保存 open");
  // the form's selects are the repository and the kind, in that order
  await evaluate(`(() => { const s = document.querySelectorAll('${BOX} details.compose-save select')[1]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'type:pbi'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setField(`${BOX} details.compose-save input`, saveTitle);
  await clickText("手元に保存", `${BOX} details.compose-save`);
  await until(() => evaluate(`document.querySelector('${BOX} details.compose-save').textContent.includes('手元に保存しました')`), "the save answered");
  // a new Issue has no number until GitHub gives it one, so the list does not carry it: its local id (shown under the form) finds it
  const localId = await until(() => evaluate(`document.querySelector('${BOX} details.compose-save .backlog-made')?.getAttribute('data-local')`), "the made line under the form") as string;
  const saved = await until(async () => {
    for (const id of [libId, metaId]) {
      const r = await fetch(`${base}/api/backlog/${localId}?workspaceId=${id}`);
      if (r.status === 200) { const d = (await r.json()) as { issue: { title: string; labels: string[] } }; if (d.issue.title === saveTitle) return d.issue; }
    }
    return null;
  }, "the saved Issue by its local id");
  assert(saved.labels.includes("type:pbi"), `the saved Issue is a PBI: ${JSON.stringify(saved)}`);
  assert((await tasks()).length === taskCount, `saving started no Task: ${taskCount} -> ${(await tasks()).length}`);
  await clickText("Backlog", "nav");
  await until(() => evaluate(`!!document.querySelector('.backlog') && document.querySelector('.backlog').textContent.includes(${JSON.stringify(saveTitle)})`), "the Backlog lists the saved title");
  result.saved = saveTitle;

  // 6199 (c): a draft kept under the key the form reads opens 自分で書いて保存 with its kind, title and body
  const draft = JSON.stringify({ title: "下書きの題", body: "下書きの本文", kind: "type:pbi" });
  await openHome();
  await evaluate(`for (const id of ${JSON.stringify([metaId, libId])}) localStorage.setItem('switchboard.backlog.text.new:' + id, ${JSON.stringify(draft)})`);
  await openHome();
  await openDetails();
  const drafted = await until(() => evaluate(`(() => { const f = document.querySelector('${BOX} details.compose-save'); if (!f || !f.open) return null; return { kind: f.querySelectorAll('select')[1]?.value, title: f.querySelector('input')?.value, body: f.querySelector('textarea')?.value }; })()`), "自分で書いて保存 opens on the draft") as { kind: string; title: string; body: string };
  assert(drafted.kind === "type:pbi" && drafted.title === "下書きの題" && drafted.body === "下書きの本文", `draft: ${JSON.stringify(drafted)}`);
  result.draft = drafted;

  // the dialog opened over Home writes the same stored draft: Home's form, drawn before, shows what the dialog wrote
  // (it does not keep its older copy and write that back over it)
  const D = "dialog.feedback-dialog[open]";
  await evaluate(`document.querySelector('.rail-feedback').click()`);
  await until(() => evaluate(`!!document.querySelector('${D} details.compose-details')`), "the dialog over Home");
  await evaluate(`(() => { const d = document.querySelector('${D} details.compose-details'); if (!d.open) d.querySelector('summary').click(); })()`);
  await until(() => evaluate(`document.querySelector('${D} details.compose-save input')?.value === "下書きの題"`), "the dialog's 自分で書いて保存 on the same draft");
  await setField(`${D} details.compose-save input`, "ダイアログで直した題");
  const both = await until(() => evaluate(`(() => { const t = document.querySelector('${BOX} details.compose-save input')?.value; return t === "ダイアログで直した題" ? { home: t, body: document.querySelector('${BOX} details.compose-save textarea')?.value, stored: ${JSON.stringify([metaId, libId])}.map((id) => JSON.parse(localStorage.getItem('switchboard.backlog.text.new:' + id))) } : null; })()`), "Home's form follows the draft the dialog wrote") as { home: string; body: string; stored: Array<{ title: string; body: string }> };
  // the two forms are on the same workspace (the first one); its stored draft has the new title and still the body
  assert(both.body === "下書きの本文" && both.stored.filter((d) => d.title === "ダイアログで直した題" && d.body === "下書きの本文").length === 1, `the shared draft: ${JSON.stringify(both)}`);
  await evaluate(`document.querySelector('${D} [data-compose-cancel]').click()`);
  await until(() => evaluate(`!document.querySelector('dialog[open]')`), "the dialog closes");
  result.sharedDraft = both.home;

  // the opened 詳細 (自分で書いて保存 open) at 390 and 1280: nothing runs sideways; the pictures go to SHOTS
  for (const width of [390, 1280]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
    await until(() => evaluate(`window.innerWidth === ${width}`), `viewport ${width}`);
    await Bun.sleep(150);
    const over = await evaluate(`Math.max(document.documentElement.scrollWidth - window.innerWidth, (() => { const c = document.querySelector('${BOX}'); return c.scrollWidth - c.clientWidth; })())`) as number;
    assert(over <= 1, `at ${width}px the opened 詳細 runs sideways by ${over}`);
    // the two buttons sit on one row without a sideways run: they are looked at in the box's own picture
    const rows = await evaluate(`(() => { const a = document.querySelector('${BOX} [data-compose-backlog]').getBoundingClientRect(); const b = document.querySelector('${BOX} [data-compose-start]').getBoundingClientRect(); return { sameRow: Math.abs(a.top - b.top) < 4, wide: Math.min(a.width, b.width) }; })()`) as { sameRow: boolean; wide: number };
    assert(rows.sameRow && rows.wide >= 60, `at ${width}px the two buttons are on one row and readable: ${JSON.stringify(rows)}`);
    await evaluate(`document.querySelector('${BOX}').scrollIntoView({ block: 'start' })`);
    await Bun.write(join(shots, `compose-box-${width}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await evaluate(`document.querySelector('${BOX} details.compose-save').scrollIntoView({ block: 'center' })`);
    const png = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await Bun.write(join(shots, `compose-details-${width}.png`), Buffer.from(png.data, "base64"));
  }
  await call("Emulation.clearDeviceMetricsOverride");

  // 6197 (d), the other side: developSelf off → no 要望にしてすぐ直す in 詳細
  const patched = await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ developSelf: false }) });
  assert(patched.status === 200, `PATCH developSelf: ${patched.status}`);
  await openHome();
  await openDetails();
  await until(() => evaluate(`!!document.querySelector('${BOX} [data-compose-save]')`), "自分で書いて保存 is drawn");
  await Bun.sleep(500); // the form reads the setting once, after it is drawn
  assert(await evaluate(`!document.querySelector('${BOX} [data-compose-fix]') && !!document.querySelector('${BOX} [data-compose-save]')`), "with developSelf off there is no 要望にしてすぐ直す, and 自分で書いて保存 stays");

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ...result, consoleErrors: errors.length }));
  console.log(`screenshots: ${shots}`);
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
