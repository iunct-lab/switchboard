/** Run after `bun run --cwd apps/web build`: bun scripts/feedback-e2e.ts. Requires Chrome (CHROME_BIN overrides). CAPTURED=<file.png> saves the captured picture, SCREENSHOT=<file.png> the Task screen after すぐ直す. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-feedback-e2e-"));
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
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}

async function scenario(capture: boolean) {
  const profile = join(home, capture ? "capture" : "denied");
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", ...(capture ? ["--auto-select-tab-capture-source-by-title=Switchboard", "--enable-usermedia-screen-capturing"] : []), "about:blank"], { stdout: "ignore", stderr: "ignore" });
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
    const click = async (label: string) => {
      const point = await evaluate(`(() => {const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length > 0); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      assert(point, `clickable ${label}`);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    await call("Runtime.enable");
    await call("Log.enable");
    await call("Page.enable");
    // Records whether the feedback dialog is open when capture starts and when the first frame arrives (#262).
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
    await click("フィードバック");
    await until(() => evaluate(`!!document.querySelector('dialog[open]')`), "dialog");
    assert(await evaluate(`document.querySelector('dialog button[type=submit]').disabled`), "empty text cannot send");
    await evaluate(`document.querySelector('dialog textarea').focus()`);
    await call("Input.insertText", { text: capture ? "E2E 撮影" : "E2E 貼り付け・ドロップ" });
    const typed = await evaluate(`document.querySelector('dialog textarea').value`);
    await click("画面を撮る");
    let shot: Record<string, unknown> = {};
    if (capture) {
      await until(() => evaluate(`document.querySelector('dialog img')?.naturalWidth > 0`), "captured thumbnail");
      console.log("capture naturalWidth", await evaluate(`document.querySelector('dialog img').naturalWidth`));
      if (process.env.CAPTURED) { // CAPTURED=<file.png> keeps the picture that was taken, to look at what it shows
        const data = await evaluate(`(() => { const i = document.querySelector('dialog img'); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png').split(',')[1]; })()`);
        await Bun.write(process.env.CAPTURED, Buffer.from(data, "base64"));
      }
      shot = await evaluate(`({ dialogOpenAtCapture: window.__captureDialogOpen, dialogOpenAtFrame: window.__frameDialogOpen, dialogReopened: document.querySelector('dialog.feedback-dialog').open, textKept: document.querySelector('dialog textarea').value === ${JSON.stringify(typed)} })`);
      assert(shot.dialogOpenAtCapture === false && shot.dialogOpenAtFrame === false && shot.dialogReopened === true && shot.textKept === true, `capture: ${JSON.stringify(shot)}`);
    } else {
      await until(() => evaluate(`document.querySelector('dialog').textContent.includes('貼り付けかドロップで添付してください')`), "denied capture guidance");
      shot = await evaluate(`({ dialogReopened: document.querySelector('dialog.feedback-dialog').open, textKept: document.querySelector('dialog textarea').value === ${JSON.stringify(typed)} })`);
      assert(shot.dialogReopened === true && shot.textKept === true, `denied: ${JSON.stringify(shot)}`);
      for (const event of ["paste", "drop"]) {
        await evaluate(`(() => {
          const c = document.createElement('canvas'); c.width=16; c.height=16; c.getContext('2d').fillRect(0,0,16,16);
          return new Promise(resolve => c.toBlob(blob => {
            const dt = new DataTransfer(); dt.items.add(new File([blob], '${event}.png', {type:'image/png'}));
            const target = document.querySelector('${event === "paste" ? "dialog textarea" : "dialog .dropzone"}');
            target.dispatchEvent(new ${event === "paste" ? "ClipboardEvent('paste', {clipboardData:dt" : "DragEvent('drop', {dataTransfer:dt"},bubbles:true,cancelable:true})); resolve(true);
          },'image/png'));
        })()`);
      }
      await until(() => evaluate(`document.querySelectorAll('dialog img').length === 2 && [...document.querySelectorAll('dialog img')].every(i => i.naturalWidth > 0)`), "paste and drop thumbnails");
    }
    await until(() => evaluate(`!document.querySelector('dialog button[type=submit]').disabled`), "send enabled");
    await click("登録"); // the default mode, not chosen (#263)
    await until(() => evaluate(`!document.querySelector('dialog[open]')`), "sent dialog closes");
    const tasks = await (await fetch(`${base}/api/tasks`)).json() as Task[];
    const task = tasks.find((t) => t.title === (capture ? "要望: E2E 撮影" : "要望: E2E 貼り付け・ドロップ"));
    assert(task?.cwd === cfg.repoRoot, "task targets meta workspace");
    await until(() => starts.find((s) => s.prompt.includes(capture ? "E2E 撮影" : "E2E 貼り付け・ドロップ")), "runner prompt");
    const prompt = starts.find((s) => s.prompt.includes(capture ? "E2E 撮影" : "E2E 貼り付け・ドロップ"))!.prompt;
    assert(prompt.includes(join(home, "attachments", task!.id)), "runner gets attachment path");
    assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
    assert(prompt.includes(`\n画面: Home`), "the prompt names the screen it was sent from");
    await click("フィードバック");
    assert(await evaluate(`document.querySelector('dialog textarea').value === '' && !document.querySelector('dialog img')`), "successful send clears composer");
    // the send opened the new Task, so the dialog now names that screen (#262)
    const screen = await evaluate(`document.querySelector('dialog .feedback-screen')?.textContent ?? ''`) as string;
    const screenShown = screen === `送信元: Task「${task!.title}」(${task!.id})`;
    assert(screenShown, `screen: ${screen}`);
    shot = { ...shot, screenShown, defaultModeTitle: task!.title };
    assert(await evaluate(`document.querySelector('dialog input[value=request]').checked`), "the dialog starts on 要望として登録 again");
    if (capture) {
      // すぐ直す (#263): capture → 直す → the new Task's screen, titled 「直す: …」
      await evaluate(`document.querySelector('dialog input[value=fix]').click()`);
      await until(() => evaluate(`document.querySelector('dialog').textContent.includes('要望 Issue は作りません')`), "fix hint");
      await evaluate(`document.querySelector('dialog textarea').focus()`);
      await call("Input.insertText", { text: "E2E ここを直して" });
      await click("画面を撮る");
      await until(() => evaluate(`document.querySelector('dialog img')?.naturalWidth > 0`), "captured thumbnail (fix)");
      await click("直す");
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), "fix dialog closes");
      const fixTask = await until(async () => ((await (await fetch(`${base}/api/tasks`)).json()) as Task[]).find((t) => t.title.startsWith("直す: ")), "fix task");
      // the Rail marks the Task on screen: only the fix Task's own item may be the one that is on
      const openedTask = await until(() => evaluate(`[...document.querySelectorAll('.rail .it.on')].some(b => b.querySelector('.t')?.textContent === ${JSON.stringify(fixTask.title)}) && !document.querySelector('main.home') ? true : null`), "fix Task screen");
      const fixPrompt = await until(() => starts.find((s) => s.prompt.includes("E2E ここを直して"))?.prompt, "fix prompt");
      assert(!fixPrompt.includes("request-to-backlog") && fixPrompt.includes(join(home, "attachments", fixTask.id)), "fix prompt");
      if (process.env.SCREENSHOT) {
        const png = await call("Page.captureScreenshot", { format: "png" });
        await Bun.write(process.env.SCREENSHOT, Buffer.from(png.data, "base64"));
      }
      shot = { ...shot, fixModeTitle: fixTask.title, openedTask };
    } else {
      // すぐ直す chosen, then closed without sending: the next opening is back on 要望として登録
      await evaluate(`document.querySelector('dialog input[value=fix]').click()`);
      await until(() => evaluate(`document.querySelector('dialog input[value=fix]').checked`), "fix chosen");
      await click("閉じる");
      await until(() => evaluate(`!document.querySelector('dialog[open]')`), "dialog closed without sending");
      await click("フィードバック");
      await until(() => evaluate(`!!document.querySelector('dialog[open]')`), "dialog reopened");
      const modeReset = await until(() => evaluate(`document.querySelector('dialog input[value=request]').checked || null`), "a dialog closed on すぐ直す reopens on 要望として登録") as boolean;
      shot = { ...shot, modeReset };
      await click("閉じる");
    }
    console.log(JSON.stringify({ scenario: capture ? "capture" : "denied/paste/drop", meta: true, ...shot, consoleErrors: errors.length }));
  } finally {
    ws?.close();
    chrome.kill();
    await chrome.exited;
  }
}
try { await scenario(true); await scenario(false); }
finally { await core.stop(); rmSync(home, { recursive: true, force: true }); }
