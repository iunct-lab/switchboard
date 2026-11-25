/**
 * Run after `bun run --cwd apps/web build`: bun scripts/feedback-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The ＋ 指示 dialog is the Home box (`Compose`) in a dialog: opened from Backlog (narrowed to one repository), Schedules and a
 * Task screen, it holds the same `[data-compose]` with バックログに積む and 今すぐ始める; a picture of the screen, paste and drop
 * attach as before; 要望にする / 改善要望にする open it with a draft. Pictures of the opened box and of 詳細 at 390 and 1280
 * wide go to a directory that is printed at the end (SHOTS=<dir> picks it). CAPTURED=<file.png> saves the captured picture,
 * SCREENSHOT=<file.png> the Task screen after 要望にしてすぐ直す.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-feedback-e2e-"));
const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), "sb-feedback-e2e-shots-"));
mkdirSync(shots, { recursive: true });
const second = join(home, "second");
mkdirSync(second);
const starts: StartOptions[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    starts.push(opts);
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: Promise.resolve(0) };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
// no GitHub here: the Backlog only has to draw its tabs (they come from the registered workspaces)
const gh = async (args: string[], cwd: string) => (args[0] === "repo" ? { code: 0, stdout: `${cwd === second ? "example-org/second" : "example-org/app"} true\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no gh in this e2e" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
const secondWs = core.db.upsertWorkspace({ path: second, name: "second", kind: "repo" });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const tasks = async () => (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
const DIALOG = "dialog.feedback-dialog[open]";

async function scenario(capture: boolean) {
  const profile = join(home, capture ? "capture" : "denied");
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", ...(capture ? ["--auto-select-tab-capture-source-by-title=Switchboard", "--enable-usermedia-screen-capturing"] : []), "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let ws: WebSocket | undefined;
  try {
    const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
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
    // Reject through the browser policy: native headless pickers can otherwise wait indefinitely.
    if (!capture) {
      const handler = ws.onmessage!;
      ws.onmessage = (event) => {
        handler.call(ws!, event);
        const m = JSON.parse(String(event.data));
        if (m.method === "Fetch.requestPaused") void call("Fetch.continueResponse", {
          requestId: m.params.requestId, responseCode: m.params.responseStatusCode,
          responseHeaders: [...m.params.responseHeaders, { name: "Permissions-Policy", value: "display-capture=()" }],
        });
      };
      await call("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
    }
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
    /** Presses the visible, enabled button with this text inside `scope` (a selector; the whole page by default). */
    /** The point to press, read again until it stops moving (the box fills in as its data arrives). */
    const still = async (read: string) => { let last = ""; let point: { x: number; y: number } | null = null; for (let i = 0; i < 40; i++) { point = await evaluate(read) as typeof point; const now = JSON.stringify(point); if (now === last && point) return point; last = now; await Bun.sleep(100); } return point; };
    const click = async (label: string, scope = "body") => pressAt(await still(`(() => {const b = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length > 0); if (!b || b.disabled) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`), `${label} in ${scope}`);
    const clickEl = async (selector: string) => pressAt(await still(`(() => {const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.disabled || b.getClientRects().length === 0) return null; b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`), selector);
    /** Sets a <select> as a person does (the native setter and a change event). */
    const choose = (selector: string, value: string) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const openDialog = async () => {
      await click("＋ 指示", ".rail");
      await until(() => evaluate(`!!document.querySelector('${DIALOG} [data-compose]')`), "the box in the dialog");
    };
    const closeDialog = async () => {
      await click("やめる", DIALOG);
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), "dialog closes");
    };
    const openDetails = () => evaluate(`(() => { const d = document.querySelector('${DIALOG} details.compose-details'); if (!d.open) d.querySelector('summary').click(); })()`);
    /** The same box as Home's: its marks, and the two buttons that decide what is done with the text; no mode radios. */
    const boxIn = (scope: string) => evaluate(`(() => { const c = document.querySelector(${JSON.stringify(scope + " [data-compose]")}); return { box: !!c, backlog: !!c?.querySelector('[data-compose-backlog]'), start: !!c?.querySelector('[data-compose-start]'), modeRadios: document.querySelectorAll(${JSON.stringify(scope + ' input[name="feedback-mode"]')}).length }; })()`) as Promise<{ box: boolean; backlog: boolean; start: boolean; modeRadios: number }>;
    const assertBox = async (scope: string, label: string) => {
      const b = await boxIn(scope);
      assert(b.box && b.backlog && b.start && b.modeRadios === 0, `${label}: ${JSON.stringify(b)}`);
    };
    await call("Runtime.enable");
    await call("Log.enable");
    await call("Page.enable");
    // Records whether the feedback dialog is open when capture starts and when the first frame arrives.
    await call("Page.addScriptToEvaluateOnNewDocument", { source: `
      const dialogOpen = () => !!document.querySelector("dialog.feedback-dialog")?.open;
      if (navigator.mediaDevices?.getDisplayMedia) {
        const gdm = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = (o) => { window.__captureDialogOpen = dialogOpen(); return gdm(o); };
      }
      const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) { return rvfc.call(this, (...a) => { window.__frameDialogOpen = dialogOpen(); cb(...a); }); };
    ` });
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail").catch(async (e) => { console.error(await evaluate(`({url:location.href,body:document.body.innerText})`), errors); throw e; });
    let shot: Record<string, unknown> = {};

    // (a) the box on Home, and the same box (same marks) in the dialog from Backlog, Schedules and a Task screen
    await until(() => evaluate(`!!document.querySelector('main.home [data-compose]')`), "Home box");
    await assertBox("main.home", "Home box");
    // a closed dialog draws no box: Home has one .compose, so a script reading `.compose` cannot take a hidden one
    assert(await evaluate(`document.querySelectorAll('.compose').length === 1 && !document.querySelector('dialog.feedback-dialog [data-compose]')`), "a closed dialog holds no box");
    if (capture) {
      // (b) Backlog narrowed to one repository: the box's repository is that one
      await click("Backlog", "nav");
      await until(() => evaluate(`!![...document.querySelectorAll('.backlog-ws button')].find(b => b.textContent.trim().startsWith('second'))`), "the Backlog's repository tabs");
      await evaluate(`[...document.querySelectorAll('.backlog-ws button')].find(b => b.textContent.trim().startsWith('second')).click()`);
      await until(() => evaluate(`[...document.querySelectorAll('.backlog-ws button.on')].some(b => b.textContent.trim().startsWith('second'))`), "narrowed to second");
      await openDialog();
      await assertBox(DIALOG, "Backlog dialog");
      const narrowed = await until(() => evaluate(`document.querySelector('${DIALOG} [data-compose] .fields select')?.value || null`), "the box's repository");
      assert(narrowed === secondWs.id, `the box opens on the narrowed repository: ${narrowed} (want ${secondWs.id})`);
      await closeDialog();
      await click("Schedules", "nav");
      await until(() => evaluate(`!!document.querySelector('main.schedules')`), "Schedules");
      await openDialog();
      await assertBox(DIALOG, "Schedules dialog");
      await closeDialog();
      await click("Home", "nav");
      await until(() => evaluate(`!!document.querySelector('main.home [data-compose]')`), "Home again");
      shot = { ...shot, boxOn: ["home", "backlog", "schedules"], narrowedTo: narrowed };
    }
    // on Home too ＋ 指示 opens the dialog: the same box, with 画面を撮る (Home's own box has none), as the feedback button did there
    await openDialog();
    await assertBox(DIALOG, "Home dialog");
    assert(await evaluate(`!!document.querySelector('${DIALOG} [data-compose-capture]') && !document.querySelector('main.home [data-compose-capture]')`), "the dialog opened on Home can take a picture of the screen");
    // two forms on one page: each keeps its own runner chosen (one radio group each)
    const chosen = await evaluate(`[document.querySelectorAll('main.home .compose input[type=radio]:checked').length, document.querySelectorAll('${DIALOG} .compose input[type=radio]:checked').length]`) as number[];
    assert(chosen[0] === 1 && chosen[1] === 1, `a runner is chosen in Home's box and in the dialog's: ${JSON.stringify(chosen)}`);
    await closeDialog();
    // the rest is the dialog, opened from Schedules (a screen without a box of its own)
    await click("Schedules", "nav");
    await until(() => evaluate(`!!document.querySelector('main.schedules')`), "Schedules for the dialog");
    await openDialog();
    assert(await evaluate(`document.querySelector('${DIALOG} [data-compose-backlog]').disabled && document.querySelector('${DIALOG} [data-compose-start]').disabled`), "empty text cannot send");
    await evaluate(`document.querySelector('${DIALOG} textarea').focus()`);
    await call("Input.insertText", { text: capture ? "E2E 撮影" : "E2E 貼り付け・ドロップ" });
    const typed = await evaluate(`document.querySelector('${DIALOG} textarea').value`);
    await click("画面を撮る", DIALOG);
    if (capture) {
      await until(() => evaluate(`document.querySelector('dialog img')?.naturalWidth > 0`), "captured thumbnail");
      console.log("capture naturalWidth", await evaluate(`document.querySelector('dialog img').naturalWidth`));
      if (process.env.CAPTURED) { // CAPTURED=<file.png> keeps the picture that was taken, to look at what it shows
        const data = await evaluate(`(() => { const i = document.querySelector('dialog img'); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png').split(',')[1]; })()`);
        await Bun.write(process.env.CAPTURED, Buffer.from(data, "base64"));
      }
      const captured = await evaluate(`({ dialogOpenAtCapture: window.__captureDialogOpen, dialogOpenAtFrame: window.__frameDialogOpen, dialogReopened: document.querySelector('dialog.feedback-dialog').open, textKept: document.querySelector('${DIALOG} textarea')?.value === ${JSON.stringify(typed)} })`);
      assert(captured.dialogOpenAtCapture === false && captured.dialogOpenAtFrame === false && captured.dialogReopened === true && captured.textKept === true, `capture: ${JSON.stringify(captured)}`);
      shot = { ...shot, ...captured };
    } else {
      await until(() => evaluate(`document.querySelector('dialog').textContent.includes('貼り付けかドロップで添付してください')`), "denied capture guidance");
      const denied = await evaluate(`({ dialogReopened: document.querySelector('dialog.feedback-dialog').open, textKept: document.querySelector('${DIALOG} textarea')?.value === ${JSON.stringify(typed)} })`);
      assert(denied.dialogReopened === true && denied.textKept === true, `denied: ${JSON.stringify(denied)}`);
      shot = { ...shot, ...denied };
      for (const event of ["paste", "drop"]) {
        await evaluate(`(() => {
          const c = document.createElement('canvas'); c.width=16; c.height=16; c.getContext('2d').fillRect(0,0,16,16);
          return new Promise(resolve => c.toBlob(blob => {
            const dt = new DataTransfer(); dt.items.add(new File([blob], '${event}.png', {type:'image/png'}));
            const target = ${event === "paste" ? `document.querySelector('${DIALOG} textarea')` : `(document.querySelector('${DIALOG} .dropzone') ?? document.querySelector('${DIALOG} textarea'))`};
            target.dispatchEvent(new ${event === "paste" ? "ClipboardEvent('paste', {clipboardData:dt" : "DragEvent('drop', {dataTransfer:dt"},bubbles:true,cancelable:true})); resolve(true);
          },'image/png'));
        })()`);
      }
      await until(() => evaluate(`document.querySelectorAll('dialog img').length === 2 && [...document.querySelectorAll('dialog img')].every(i => i.naturalWidth > 0)`), "paste and drop thumbnails");
    }
    // (d) バックログに積む: a 要望 Task; the prompt has the text, the screen it was sent from and the attachment path
    await until(() => evaluate(`!document.querySelector('${DIALOG} [data-compose-backlog]').disabled`), "send enabled");
    await clickEl(`${DIALOG} [data-compose-backlog]`);
    await until(() => evaluate(`!document.querySelector('dialog[open]')`), "sent dialog closes");
    const text = capture ? "E2E 撮影" : "E2E 貼り付け・ドロップ";
    const task = (await tasks()).find((t) => t.title === `要望: ${text}`);
    assert(task?.cwd === cfg.repoRoot, "task targets meta workspace");
    const prompt = (await until(() => starts.find((s) => s.prompt.includes(text)), "runner prompt")).prompt;
    assert(prompt.includes(join(home, "attachments", task!.id)), "runner gets attachment path");
    assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
    assert(prompt.includes(`\n画面: Schedules`), "the prompt names the screen it was sent from");
    // the send opened the new Task: its screen has the same box in the dialog, now empty, naming that Task as the source
    await openDialog();
    await assertBox(DIALOG, "Task dialog");
    assert(await evaluate(`document.querySelector('${DIALOG} textarea').value === '' && !document.querySelector('dialog img')`), "successful send clears composer");
    const sentFrom = `送信元: Task「${task!.title}」(${task!.id})`;
    const dialogText = await evaluate(`document.querySelector('${DIALOG}').textContent`) as string;
    const screenShown = dialogText.includes(sentFrom);
    assert(screenShown, `screen: ${dialogText.slice(0, 300)}`);
    shot = { ...shot, screenShown, backlogTitle: task!.title };

    // 今すぐ始める: the same text box starts a plain Task (not an Issue); the dialog closes and that Task opens
    const startText = capture ? "E2E 今すぐ撮影" : "E2E 今すぐ";
    await choose(`${DIALOG} [data-compose] .fields select`, secondWs.id);
    await evaluate(`document.querySelector('${DIALOG} textarea').focus()`);
    await call("Input.insertText", { text: startText });
    const known = new Set((await tasks()).map((t) => t.id));
    await until(() => evaluate(`!document.querySelector('${DIALOG} [data-compose-start]').disabled`), "start enabled");
    await clickEl(`${DIALOG} [data-compose-start]`);
    await until(() => evaluate(`!document.querySelector('dialog[open]')`), "start closes the dialog");
    const startedTask = await until(async () => { const fresh = (await tasks()).filter((t) => !known.has(t.id)); return fresh.length === 1 ? fresh[0] : null; }, "one more Task");
    await until(() => evaluate(`[...document.querySelectorAll('.rail .it.on')].some(b => b.querySelector('.t')?.textContent === ${JSON.stringify(startedTask.title)}) && !document.querySelector('main.home')`), "the started Task is open");
    assert(!startedTask.title.startsWith("要望: "), `今すぐ始める made a plain Task, not a request: ${startedTask.title}`);
    await until(() => starts.find((s) => s.prompt.includes(startText)), "runner prompt of the started Task");
    shot = { ...shot, startedTitle: startedTask.title };

    if (capture) {
      // 要望にしてすぐ直す (in 詳細): capture → 直す → the new Task's screen, titled 「直す: …」
      await openDialog();
      await openDetails();
      await until(() => evaluate(`!!document.querySelector('${DIALOG} [data-compose-fix]')`), "the fix button in 詳細");
      await evaluate(`document.querySelector('${DIALOG} textarea').focus()`);
      await call("Input.insertText", { text: "E2E ここを直して" });
      await click("画面を撮る", DIALOG);
      await until(() => evaluate(`document.querySelector('dialog img')?.naturalWidth > 0`), "captured thumbnail (fix)");
      await clickEl(`${DIALOG} [data-compose-fix]`);
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), "fix dialog closes");
      const fixTask = await until(async () => (await tasks()).find((t) => t.title.startsWith("直す: ")), "fix task");
      // the Rail marks the Task on screen: only the fix Task's own item may be the one that is on
      const openedTask = await until(() => evaluate(`[...document.querySelectorAll('.rail .it.on')].some(b => b.querySelector('.t')?.textContent === ${JSON.stringify(fixTask.title)}) && !document.querySelector('main.home') ? true : null`), "fix Task screen");
      const fixPrompt = await until(() => starts.find((s) => s.prompt.includes("E2E ここを直して"))?.prompt, "fix prompt");
      assert(!fixPrompt.includes("request-to-backlog") && fixPrompt.includes(join(home, "attachments", fixTask.id)), "fix prompt");
      if (process.env.SCREENSHOT) {
        const png = await call("Page.captureScreenshot", { format: "png" });
        await Bun.write(process.env.SCREENSHOT, Buffer.from(png.data, "base64"));
      }
      shot = { ...shot, fixModeTitle: fixTask.title, openedTask };

      // (f) widths 390 and 1280: the opened box and 詳細 do not run sideways, the buttons share a line, ＋ 指示 is reachable at 390
      const layout: Record<string, unknown> = {};
      for (const width of [390, 1280]) {
        await call("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1, mobile: width === 390 });
        await until(() => evaluate(`window.innerWidth === ${width}`), `viewport ${width}`);
        if (width === 390) {
          const railButton = await evaluate(`(() => { const b = document.querySelector('.rail-feedback'); if (!b || b.getClientRects().length === 0) return null; const r = b.getBoundingClientRect(); return { height: r.height, right: r.right, left: r.left, text: b.textContent.trim() }; })()`) as { height: number; right: number; left: number; text: string } | null;
          assert(railButton && railButton.text === "＋ 指示" && railButton.height >= 44 && railButton.left >= 0 && railButton.right <= width + 1, `.rail-feedback at 390: ${JSON.stringify(railButton)}`);
          layout.railButton = railButton;
        }
        await openDialog();
        for (const folded of [false, true]) {
          if (folded) await openDetails();
          else await evaluate(`(() => { const d = document.querySelector('${DIALOG} details.compose-details'); if (d.open) d.querySelector('summary').click(); })()`);
          await Bun.sleep(150);
          const m = await evaluate(`(() => { const d = document.querySelector('${DIALOG}'); const c = d.querySelector('[data-compose]'); const row = [c.querySelector('[data-compose-backlog]'), c.querySelector('[data-compose-start]'), [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'やめる')].filter(Boolean); return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, dialogScroll: d.scrollWidth - d.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, tops: row.map(b => Math.round(b.getBoundingClientRect().top)), buttons: row.length }; })()`) as { scrollWidth: number; clientWidth: number; dialogScroll: number; page: number; tops: number[]; buttons: number };
          const where = `${width} ${folded ? "詳細" : "box"}`;
          assert(m.scrollWidth <= m.clientWidth && m.dialogScroll <= 0 && m.page <= 1, `${where} runs sideways: ${JSON.stringify(m)}`);
          assert(m.buttons === 3 && new Set(m.tops).size === 1, `${where} buttons are not on one line: ${JSON.stringify(m)}`);
          const png = await call("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(shots, `compose-dialog-${width}${folded ? "-details" : ""}.png`), Buffer.from(png.data, "base64"));
          layout[`${width}${folded ? "-details" : ""}`] = m;
        }
        await closeDialog();
        if (width === 390) {
          // Home with the list open (the list hides Home at this width): ＋ 指示 still opens the dialog
          await evaluate(`[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Home').click()`);
          await until(() => evaluate(`!!document.querySelector('main.home [data-compose]')`), "Home at 390");
          await evaluate(`document.querySelector('.rail-tasks').click()`);
          await until(() => evaluate(`document.querySelector('.rail').classList.contains('open')`), "the list opens at 390");
          await evaluate(`document.querySelector('.rail-feedback').click()`);
          await until(() => evaluate(`!!document.querySelector('${DIALOG} [data-compose]')`), "＋ 指示 on Home with the list open opens the dialog");
          await closeDialog();
          await evaluate(`document.querySelector('.rail-tasks').click()`);
          layout.homeListOpen = true;
          await evaluate(`[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'Schedules').click()`);
          await until(() => evaluate(`!!document.querySelector('main.schedules')`), "Schedules again at 390");
        }
      }
      await call("Emulation.clearDeviceMetricsOverride");
      shot = { ...shot, layout };
    } else {
      // やめる closes without sending
      await openDialog();
      const count = (await tasks()).length;
      await closeDialog();
      assert((await tasks()).length === count, "やめる sends nothing");
      // (e) 要望にする / 改善要望にする: the box opens with the draft and the two buttons; バックログに積む sends the source as before
      await evaluate(`window.dispatchEvent(new CustomEvent('switchboard:open-feedback', { detail: { text: 'E2E 下書き', source: { kind: 'eval', taskId: ${JSON.stringify(task!.id)} } } }))`);
      await until(() => evaluate(`!!document.querySelector('${DIALOG} [data-compose]')`), "dialog opened with a draft");
      await assertBox(DIALOG, "draft dialog");
      assert(await evaluate(`document.querySelector('${DIALOG} textarea').value === 'E2E 下書き'`), "the draft is in the box");
      await clickEl(`${DIALOG} [data-compose-backlog]`);
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), "draft sent");
      const sourced = await until(() => starts.find((s) => s.prompt.includes("E2E 下書き"))?.prompt, "draft prompt");
      assert(sourced.includes(`評価から: Task ${task!.id}`), `the source is sent as before: ${sourced.slice(-300)}`);
      shot = { ...shot, draftSource: true };
    }
    assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
    console.log(JSON.stringify({ scenario: capture ? "capture" : "denied/paste/drop", meta: true, ...shot, consoleErrors: errors.length }));
  } finally {
    ws?.close();
    chrome.kill();
    await chrome.exited;
  }
}
try { await scenario(true); await scenario(false); console.log(`screenshots: ${shots}`); }
finally { await core.stop(); rmSync(home, { recursive: true, force: true }); }
