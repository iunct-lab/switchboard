/**
 * Run after `bun run --cwd apps/web build`: bun scripts/stop-grant-stale-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 *
 * A stop card's 「この操作だけ許可して続ける」 answered after the stop changed: the fake runner reports a stop with a
 * grant (A), the 判断待ち screen shows its card; the list is then not read again (its GET blocked, as a slow read would
 * leave it), the same stop is reported again with another grant (B) and the card's own button is pressed — the answer
 * is 409 with 「問いが新しくなりました」, the card says so, and nothing reaches the runner. When the list is read again
 * the card is B. Then the card of B is pressed: the grant B reaches the runner once and the Task goes on; the card stays,
 * answered (its buttons gone), until the screen is opened again, and then it is gone.
 * SCREENSHOT_DIR=<dir> saves the card when it is first shown, at 390x844 and 1280x900 (390-stop-grant.png, 1280-stop-grant.png).
 * The daemon is the real one (startServer); the runner and `gh` are fakes (nothing reaches GitHub).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-stop-grant-stale-e2e-"));
const fence = (r: object) => `\n\`\`\`switchboard-stop\n${JSON.stringify(r)}\n\`\`\`\n`;
const stop = (grant: string) => fence({ id: "merge-12", op: "gh pr merge", target: "PR #12", reason: "permission", safety: "before-effect", evidence: "PR #12 をマージする権限がありません", state: "waiting", conditions: [], actions: [], grant });
const GRANT_A = "PR #12 をマージしてよい";
const GRANT_B = "PR #12 を判定の外でマージしてよい";
const started: string[] = [];
// what the scenario's Task was sent or started with: the daemon's own helper turns (the rubric judge runs when a Task ends) are not counted
const scenarioDeliveries = () => sent.length + started.filter((p) => p === "stop-grant").length;
const sent: string[] = [];
// what the runner got that carries grant B (a sent line or a resumed start's prompt): the scenario's delivery
// (the daemon's judge turn quotes the conversation, so its prompt carries the grant too: it is not the delivery)
const delivered: string[] = [];
const isGrant = (text: string) => text.includes(GRANT_B) && !text.includes("ルーブリック");
let reportB: (() => void) | undefined;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    started.push(opts.prompt);
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const granted = isGrant(opts.prompt);
    if (granted) delivered.push(opts.prompt);
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      // the grant went through: the Task goes on and ends its turn with no stop
      if (granted) { emit({ t: "message.delta", role: "assistant", text: "許可を受けて続けました。", messageId: `g-${Math.random()}` }); emit({ t: "session.end", status: "ok", summary: "stop-grant" }); exit(0); return; }
      emit({ t: "message.delta", role: "assistant", text: stop(GRANT_A), messageId: `a-${Math.random()}` });
      // the stop changes only when the scenario says so: the same run reports the stop again with another grant
      reportB = () => {
        emit({ t: "message.delta", role: "assistant", text: stop(GRANT_B), messageId: `b-${Math.random()}` });
        emit({ t: "session.end", status: "ok", summary: "stop-grant" });
        exit(0);
      };
    });
    return { send(text: string) { sent.push(text); if (isGrant(text)) { delivered.push(text); emit({ t: "message.delta", role: "assistant", text: "許可を受けて続けました。", messageId: `g-${Math.random()}` }); emit({ t: "session.end", status: "ok", summary: "stop-grant" }); } }, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => ({ code: 1, stdout: "", stderr: "no gh in this e2e" }), judge: async () => ({ result: "finished", reason: "許可を受けて続けた", runner: "claude", model: "fake" }) });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const meta = ((await (await fetch(`${base}/api/workspaces`)).json()) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
const t = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: meta.id, cwd: cfg.repoRoot, title: "stop-grant", prompt: "stop-grant", runner: "claude" }) })).json() as { id: string };
const stopAsk = () => until(async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; grant?: string | null }> }).asks.find((a) => a.id.startsWith("stop:") && a.grant === GRANT_A), "the stop with grant A");
await stopAsk();

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  ws = new WebSocket(tabs.find((x) => x.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `${base}/approvals` });
  // the card of grant A on the screen, its grant button among its buttons
  const grantButton = `[...document.querySelectorAll('[data-ask]')].find(c => c.textContent.includes(${JSON.stringify(GRANT_A)}))?.querySelectorAll('button')`;
  // the groups and the rows are folded until opened (as the screen's own buttons open them): open them, then the card is there
  const reveal = () => evaluate(`(() => { document.querySelectorAll('details.ask-fold').forEach(d => { d.open = true; }); document.querySelectorAll('[data-row] > button[aria-expanded="false"]').forEach(b => b.click()); return true; })()`);
  await until(async () => { await reveal(); return evaluate(`[...(${grantButton} ?? [])].some(b => b.textContent.trim() === 'この操作だけ許可して続ける')`); }, "the card of grant A with its button").catch(async (e) => {
    const shown = await evaluate(`JSON.stringify({ asks: [...document.querySelectorAll('[data-ask]')].map(c => c.dataset.ask), rows: [...document.querySelectorAll('[data-row]')].map(r => r.dataset.row), text: (document.querySelector('main') ?? document.body).innerText.slice(0, 600) })`);
    const api = await (await fetch(`${base}/api/asks`)).json();
    throw new Error(`${(e as Error).message}\npage: ${shown}\napi: ${JSON.stringify(api).slice(0, 900)}`);
  });
  // the screen shown to a person: the card as it is first shown, at the phone's width first and then the desktop's
  const shots = process.env.SCREENSHOT_DIR;
  if (shots) {
    for (const [prefix, width, height, mobile] of [["390", 390, 844, true], ["1280", 1280, 900, false]] as const) {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await Bun.sleep(300);
      await evaluate(`[...document.querySelectorAll('[data-ask]')].find(c => c.textContent.includes(${JSON.stringify(GRANT_A)}))?.scrollIntoView({ block: 'center' })`);
      const png = await call("Page.captureScreenshot", { format: "png" });
      await Bun.write(join(shots, `${prefix}-stop-grant.png`), Buffer.from(png.data, "base64"));
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  // stop the list from being read again, then report the stop again with grant B
  await call("Network.enable");
  // no block: the list is read again every 5 s, so the click follows the report at once (a read that lands first shows B, and the check below says so)
  const sentBefore = scenarioDeliveries();
  reportB!();
  await until(async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ grant?: string | null }> }).asks.some((a) => a.grant === GRANT_B), "the stop with grant B");
  // the card on the screen is still A (the list is not read); its button answers with A's id and grant, as the button does
  assert(await evaluate(`[...document.querySelectorAll('[data-ask]')].some(c => c.textContent.includes(${JSON.stringify(GRANT_A)}))`), "the card should still show grant A");
  // what the screen's own requests answer, recorded from the page (the button's request is the one the screen makes)
  await evaluate(`(() => { window.__answers = []; const f = window.fetch.bind(window); window.fetch = async (...a) => { const u = String(a[0]); if (!u.includes('/api/asks')) return f(...a); window.__answers.push({ sent: u, method: a[1] && a[1].method }); try { const r = await f(...a); window.__answers.push({ status: r.status, body: await r.clone().text() }); return r; } catch (e) { window.__answers.push({ failed: String(e) }); throw e; } }; return true; })()`);
  // a real pointer press on the button (what a person does), its centre found on the page
  const at = await evaluate(`(() => { const b = [...(${grantButton} ?? [])].find(b => b.textContent.trim() === 'この操作だけ許可して続ける'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await Bun.sleep(1500);
  const answersSeen = await evaluate(`JSON.stringify({ answers: window.__answers, text: [...document.querySelectorAll('[data-ask]')].map(c => c.textContent.slice(0, 300)) })`);
  console.log(`answers: ${answersSeen}`);
  // the answer itself is refused: 409 from the screen's own request (not the notice the screen draws when a later read shows the change)
  const answerStatus = JSON.parse(answersSeen as string).answers.find((a: { status?: number }) => a.status !== undefined)?.status;
  assert(answerStatus === 409, `the stale answer's reply: ${answerStatus} (${answersSeen})`);
  // the reply: 「問いが新しくなりました」 on the card, the newer question as it is now
  const said = await until(() => evaluate(`(() => { const c = [...document.querySelectorAll('[data-ask]')].find(c => c.textContent.includes(${JSON.stringify(GRANT_A)})) ?? [...document.querySelectorAll('[data-ask]')].find(c => c.textContent.includes('問いが新しくなりました')); return c && c.textContent.includes('問いが新しくなりました') ? c.textContent : null; })()`), "the changed notice on the card");
  assert(said.includes("問いが新しくなりました"), `notice: ${said}`);
  await Bun.sleep(500);
  assert(scenarioDeliveries() === sentBefore, `the runner got something after the stale answer: sent=${JSON.stringify(sent)} started=${JSON.stringify(started)}`);
  // the list is read again: the card is B
  await until(() => evaluate(`[...document.querySelectorAll('[data-ask]')].some(c => c.textContent.includes(${JSON.stringify(GRANT_B)}))`), "the card shows grant B after the list is read");
  const runnerAfterStale = scenarioDeliveries() - sentBefore;
  // the card of B, pressed now (it is the Task's current question): B reaches the runner once, as the grant itself, and the card goes
  const cardB = `[...document.querySelectorAll('[data-ask]')].find(c => c.textContent.includes(${JSON.stringify(GRANT_B)}))?.querySelectorAll('button')`;
  await evaluate(`window.__answers = []`);
  const atB = await evaluate(`(() => { const b = [...(${cardB} ?? [])].find(b => b.textContent.trim() === 'この操作だけ許可して続ける'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number };
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: atB.x, y: atB.y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: atB.x, y: atB.y, button: "left", clickCount: 1 });
  const granted = await until(() => evaluate(`window.__answers.find(a => a.status !== undefined) ?? null`), "the grant's reply") as { status: number; body: string };
  assert(granted.status === 200, `the grant's reply: ${JSON.stringify(granted)}`);
  await until(() => delivered.length > 0, "grant B delivered to the runner");
  await Bun.sleep(500);
  assert(delivered.length === 1 && delivered[0]!.includes(GRANT_B), `delivered: ${JSON.stringify(delivered)}`);
  // the list keeps a closed question for a while as history (resolved): what is gone is the open one
  await until(async () => !((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; state: string }> }).asks.some((a) => a.id.startsWith("stop:") && a.state === "open"), "no open stop question left");
  // a question answered here stays in the person's row, with what the answer did, until the screen is opened again: no button to press on it
  await until(() => evaluate(`![...document.querySelectorAll('[data-ask] button')].some(b => b.textContent.trim() === 'この操作だけ許可して続ける')`), "the answered card has no grant button");
  // opened again: no question awaits, and the stop is only under 済んだもの as 解消済み (no grant, no button to press)
  await call("Page.navigate", { url: `${base}/approvals` });
  await until(async () => { await reveal(); return evaluate(`(() => { const cards = [...document.querySelectorAll('[data-ask]')]; return cards.length > 0 && cards.every(c => c.textContent.includes('解消済み') && !c.textContent.includes(${JSON.stringify(GRANT_B)}) && !c.querySelector('button')) && /判断待ち\\s*0/.test(document.body.innerText); })()`); }, "the card is gone from the questions once the screen is opened again");
  console.log(JSON.stringify({ notice: "問いが新しくなりました", runnerAfterStale, cardAfterRead: GRANT_B, grantDelivered: delivered[0], deliveredCount: delivered.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
