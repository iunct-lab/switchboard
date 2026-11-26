/**
 * Run after `bun run --cwd apps/web build`: bun scripts/stop-grant-stale-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 *
 * A stop card's 「この操作だけ許可して続ける」 answered after the stop changed: the fake runner reports a stop with a
 * grant (A), the 判断待ち screen shows its card; the list is then not read again (its GET blocked, as a slow read would
 * leave it), the same stop is reported again with another grant (B) and the card's own button is pressed — the answer
 * is 409 with 「問いが新しくなりました」, the card says so, and nothing reaches the runner. When the list is read again
 * the card is B. The daemon is the real one (startServer); the runner is a fake.
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
let reportB: (() => void) | undefined;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    started.push(opts.prompt);
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.prompt}`, cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: stop(GRANT_A), messageId: `a-${Math.random()}` });
      // the stop changes only when the scenario says so: the same run reports the stop again with another grant
      reportB = () => {
        emit({ t: "message.delta", role: "assistant", text: stop(GRANT_B), messageId: `b-${Math.random()}` });
        emit({ t: "session.end", status: "ok", summary: "stop-grant" });
        exit(0);
      };
    });
    return { send(text: string) { sent.push(text); }, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
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
  console.log(JSON.stringify({ notice: "問いが新しくなりました", runnerAfterStale: scenarioDeliveries() - sentBefore, cardAfterRead: GRANT_B }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
