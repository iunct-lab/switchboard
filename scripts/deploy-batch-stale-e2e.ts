/**
 * Run after `bun run --cwd apps/web build`: bun scripts/deploy-batch-stale-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 *
 * The 配備のまとまり end to end, with a stale card: two Tasks stop on a deploy (`sam deploy`, a permission stop); the
 * card lists both. Task A's stop is reported again with another operation (a new question) after the card was drawn,
 * and 「承認」 is pressed on the card as it was: the answer is 409 with 「問いが新しくなりました」 and nothing is sent to
 * either Task, and the screen's error banner says 「問いが変わったので…」. The screen read again shows the batch as it is; with one Task's
 * box cleared, 「承認」 sends the approval to the chosen Task only (the other stays in the batch), and approving the rest
 * then sends it to the other once. SCREENSHOT_DIR=<dir> saves the card at 390x844 and 1280x900 (390-deploy-batch.png, 1280-deploy-batch.png).
 * The daemon is the real one (startServer); the runner (it stops on a deploy and resolves on an approval) and `gh` are fakes.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const home = mkdtempSync(join(tmpdir(), "switchboard.deploy-e2e."));
const stop = (op: string) => "配備を試します。\n```switchboard-stop\n" + JSON.stringify({ id: "deploy", op, target: "switchboard-host", reason: "permission", safety: "before-effect", evidence: "配備の権限がありません", state: "waiting", conditions: [], actions: [] }) + "\n```\n";
const OP_A = "sam deploy switchboard-host";
const OP_A_AGAIN = "sam deploy switchboard-host --force";
const TITLES = ["deploy-a", "deploy-b"] as const;
const sent: Record<string, string[]> = {};
const idOf: Record<string, string> = {};
const REPORT_AGAIN = "stop again";
let base = "";
const adapter: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start(opts, emit) {
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const title = opts.prompt;
    const end = (text: string) => [{ t: "message.delta", role: "assistant", text, messageId: `m${Math.random()}` }, { t: "session.end", status: "ok", summary: text }] as AgentEvent[];
    // the daemon's own helper turns (the rubric judge) are not the scenario's: they end at once with no stop
    const scenario = (TITLES as readonly string[]).includes(title);
    queueMicrotask(() => end(scenario ? stop(OP_A) : "採点").forEach((ev) => emit(ev)));
    return {
      send(text: string) {
        if (!scenario) return;
        (sent[title] ??= []).push(text);
        queueMicrotask(() => {
          // a deploy stop reported again with another operation: a new question for the same Task
          const reply = text === REPORT_AGAIN ? stop(OP_A_AGAIN) : "承認して配備しました。";
          end(reply).forEach((ev) => emit(ev));
        });
      },
      respondPermission() {},
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => ({ code: 1, stdout: "", stderr: "no gh in this e2e" }), judge: () => new Promise(() => undefined) });
base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
const deployBatch = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { batches: Array<{ id: string; asks: Array<{ taskId: string; askId: string; op?: string }> }> }).batches.find((b) => b.id === "batch:deploy") ?? null;
const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;

// 1. two Tasks stop on a deploy: one batch of both
for (const title of TITLES) {
  const t = await post("/api/tasks", { workspaceId: meta.id, title, prompt: title, runner: "claude" });
  idOf[title] = t.id;
  await until(() => core.db.getTask(t.id)?.status === "done", `task ${title}`);
}
const first = await until(deployBatch, "the deploy batch");
assert(first.asks.length === 2, `batch: ${JSON.stringify(first)}`);
const oldA = first.asks.find((a) => a.taskId === idOf["deploy-a"])!.askId;

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(tabs.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
  };
  const call = (method: string, params: object = {}): Promise<Json> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string): Promise<Json> => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${JSON.stringify(result.exceptionDetails.exception?.description)} in ${expression.slice(0, 200)}`);
    return result.result.value;
  };
  const CARD = `document.querySelector('[data-batch="batch:deploy"]')`;
  const cardLines = () => evaluate(`${CARD} ? [...${CARD}.querySelectorAll('li[data-task]')].map(l => l.dataset.task) : null`);
  // the answers the screen sends, as the page recorded them (the status and the reply)
  const recordAnswers = () => evaluate(`(() => { window.__answers = []; const f = window.fetch.bind(window); window.fetch = async (...a) => { const u = String(a[0]); if (!u.includes('/api/asks/answer')) return f(...a); try { const r = await f(...a); window.__answers.push({ status: r.status, body: await r.clone().text() }); return r; } catch (e) { window.__answers.push({ failed: String(e) }); throw e; } }; return true; })()`);

  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `${base}/approvals` });
  // 2. the card lists both Tasks
  const drawn = await until(async () => { const l = await cardLines(); return Array.isArray(l) && l.length === 2 ? l : null; }, "the deploy card with both Tasks");
  assert(drawn.includes(idOf["deploy-a"]) && drawn.includes(idOf["deploy-b"]), `card: ${JSON.stringify(drawn)}`);

  const shots = process.env.SCREENSHOT_DIR;
  if (shots) {
    for (const [prefix, width, height, mobile] of [["390", 390, 844, true], ["1280", 1280, 900, false]] as const) {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await Bun.sleep(300);
      await evaluate(`${CARD}.scrollIntoView({ block: 'center' })`);
      const png = await call("Page.captureScreenshot", { format: "png" });
      await Bun.write(join(shots, `${prefix}-deploy-batch.png`), Buffer.from(png.data, "base64"));
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  }

  // 3. A's stop is reported again with another operation: a new question, the card still shows the old one
  await recordAnswers();
  await post(`/api/tasks/${idOf["deploy-a"]}/send`, { text: REPORT_AGAIN });
  await until(async () => (await deployBatch())?.asks.some((a) => a.taskId === idOf["deploy-a"] && a.askId !== oldA), "A's stop reported again");
  // 4. 「承認」 on the card as it was (a real press): 409, nothing sent to either Task
  await evaluate(`(() => { const b = [...${CARD}.querySelectorAll('.approval-actions button')].find(b => !b.disabled); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return true; })()`);
  await evaluate(`[...${CARD}.querySelectorAll('.approval-actions button')].find(b => !b.disabled).click()`);
  const answer = await until(() => evaluate(`window.__answers.find(a => a.status !== undefined) ?? null`), "the approval's reply") as { status: number; body: string };
  assert(answer.status === 409 && answer.body.includes("問いが新しくなりました"), `the stale approval's reply: ${JSON.stringify(answer)}`);
  await Bun.sleep(500);
  const approvedBeforeRead = TITLES.map((t) => (sent[t] ?? []).filter((x) => x !== REPORT_AGAIN));
  assert(approvedBeforeRead.every((x) => x.length === 0), `something was sent for the approval: ${JSON.stringify(sent)}`);
  // the screen says the question changed (「問いが変わったので、もう一度確かめてから答えてください」): the card hands it to the
  // screen's error banner at the top (BatchCard's onError), not under the card itself
  await until(() => evaluate(`[...document.querySelectorAll('.banner.error[role=alert]')].some(b => b.innerText.includes('問いが変わったので'))`), "the changed notice in the screen's error banner");
  // 5. the screen read again: the batch as it is. One Task's box is cleared and 「承認」 pressed: only the chosen Task gets the approval
  await call("Page.navigate", { url: `${base}/approvals` });
  await until(async () => { const l = await cardLines(); return Array.isArray(l) && l.length === 2 ? l : null; }, "the card read again");
  await recordAnswers();
  const boxB = `${CARD}.querySelector('li[data-task="${idOf["deploy-b"]}"] input[type=checkbox]')`;
  await evaluate(`${boxB}.click()`);
  assert(await evaluate(`${boxB}.checked === false`), "deploy-b's box should be cleared");
  await evaluate(`[...${CARD}.querySelectorAll('.approval-actions button')].find(b => !b.disabled).click()`);
  const partial = await until(() => evaluate(`window.__answers.find(a => a.status !== undefined) ?? null`), "the approval's reply (one chosen)") as { status: number; body: string };
  assert(partial.status === 200, `approval of the chosen Task: ${JSON.stringify(partial)}`);
  await until(() => (sent["deploy-a"] ?? []).filter((x) => x !== REPORT_AGAIN).length === 1, "the approval sent to the chosen Task");
  await Bun.sleep(500);
  const chosenOnly = { chosen: (sent["deploy-a"] ?? []).filter((x) => x !== REPORT_AGAIN).length, unchosen: (sent["deploy-b"] ?? []).length };
  assert(chosenOnly.chosen === 1 && chosenOnly.unchosen === 0, `chosen only: ${JSON.stringify(sent)}`);
  // deploy-b is still in the batch (and still has its own question)
  await until(async () => (await deployBatch())?.asks.some((a) => a.taskId === idOf["deploy-b"]), "deploy-b stays in the batch");
  assert(!(await deployBatch())!.asks.some((a) => a.taskId === idOf["deploy-a"]), "deploy-a left the batch");
  // approving what is left sends it to deploy-b once; each got one in all
  await until(async () => { const l = await cardLines(); return Array.isArray(l) && l.length === 1 && l[0] === idOf["deploy-b"] ? l : null; }, "the card with deploy-b only");
  await recordAnswers();
  // the card keeps deploy-b's box cleared (nothing is chosen, the button is off): tick it, as a person would
  if (await evaluate(`${boxB}.checked === false`)) await evaluate(`${boxB}.click()`);
  await until(() => evaluate(`[...${CARD}.querySelectorAll('.approval-actions button')].some(b => !b.disabled)`), "the approval button is on");
  await evaluate(`[...${CARD}.querySelectorAll('.approval-actions button')].find(b => !b.disabled).click()`);
  const ok = await until(() => evaluate(`window.__answers.find(a => a.status !== undefined) ?? null`), "the approval's reply (the rest)") as { status: number; body: string };
  assert(ok.status === 200, `approval of the rest: ${JSON.stringify(ok)}`);
  await until(() => TITLES.every((t) => (sent[t] ?? []).filter((x) => x !== REPORT_AGAIN).length === 1), "the approval sent to both once");
  await until(async () => (await deployBatch()) === null, "no deploy batch left");
  console.log(JSON.stringify({ stale: { status: answer.status, body: answer.body.slice(0, 80) }, approvedAfterRead: TITLES.map((t) => sent[t]!.filter((x) => x !== REPORT_AGAIN).length), sentBeforeRead: approvedBeforeRead.map((x) => x.length), chosenOnly }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
