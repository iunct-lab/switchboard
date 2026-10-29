/**
 * Run after `bun run --cwd apps/web build`: bun scripts/approval-batch-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The SSO batch end to end (#2046): two Tasks of a fake runner report an SSO login stop (a `switchboard-stop` fence in
 * their reply) → GET /api/asks has one batch of both, and the 判断待ち screen one card for them (their own cards left out)
 * → 「ログインする」 sends the older Task on, which puts a device code (as the kit's `device-auth` does) shown on the card,
 * while the other is not sent anything → that Task logs in and ends its turn with no stop → the other is sent on, and the
 * card goes. Before the screen, an approval-window schedule (#2054) fired by hand puts one notice of the batch in 判断待ち (#2866).
 * SCREENSHOT_DIR=<dir> saves the three screens and the card's page as one HTML file (styles inlined).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AskList, RunnerAdapter } from "@switchboard/protocol";
import { SSO_REST_TEXT, SSO_RESUME_TEXT } from "../packages/core/src/approval-batch.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const home = mkdtempSync(join(tmpdir(), "switchboard.e2e."));
const STOP = "SSO のトークンが切れました。\n```switchboard-stop\n" + JSON.stringify({ id: "sso", op: "aws sso login", target: "", reason: "auth", safety: "before-effect", evidence: "token expired", state: "waiting" }) + "\n```\n";
const CODE = "XXXX-XXXX";
/** What each Task was sent after its prompt, by title. */
const sent: Record<string, string[]> = {};
/** Task id by title (the prompt is the title). */
const idOf: Record<string, string> = {};
let base = "";
let release!: () => void;
const loggedIn = new Promise<void>((r) => (release = r));

/**
 * The first turn reports the login stop. Sent SSO_RESUME_TEXT, it puts a device code and holds its turn until `release`
 * (the person approving in their browser), then clears it and ends with no stop; any other reply ends at once.
 */
const runner: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true, version: "fake" }),
  start(opts, emit) {
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const title = opts.prompt;
    const end = (text: string) => [{ t: "message.delta", role: "assistant", text, messageId: `m${Math.random()}` }, { t: "session.end", status: "ok", summary: text }] as AgentEvent[];
    queueMicrotask(() => end(STOP).forEach((ev) => emit(ev)));
    return {
      send(text: string) {
        (sent[title] ??= []).push(text);
        // like the real adapters, the reply is echoed at once (the daemon answers the open stops with it)
        emit({ t: "message.delta", role: "user", text });
        queueMicrotask(async () => {
          if (text === SSO_RESUME_TEXT) {
            const id = idOf[title]!;
            const r = await fetch(`${base}/api/tasks/${id}/device-auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://device.sso.example/start", code: CODE, command: "aws sso login --use-device-code", expiresInSec: 600 }) });
            if (!r.ok) throw new Error(`device-auth: ${r.status} ${await r.text()}`);
            await loggedIn;
            await fetch(`${base}/api/tasks/${id}/device-auth`, { method: "DELETE" });
          }
          // went on: the stop is reported resolved, as the stop report preamble asks
          end("ログインして続けました。\n```switchboard-stop\n" + JSON.stringify({ id: "sso", op: "aws sso login", target: "", reason: "auth", safety: "before-effect", evidence: "logged in", state: "resolved" }) + "\n```\n").forEach((ev) => emit(ev));
        });
      },
      respondPermission() {},
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [runner], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async () => ({ code: 1, stdout: "", stderr: "no gh in this e2e" }), judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
const batches = async () => ((await (await fetch(`${base}/api/asks`)).json()) as AskList).batches;
const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
const report: Json = {};

// 1. two Tasks stop on the SSO login; the API has one batch of both, the older first
const ids: string[] = [];
for (const title of ["配備を準備する Task", "ログを集める Task"]) {
  const t = await post("/api/tasks", { workspaceId: meta.id, title, prompt: title, runner: "claude" });
  idOf[title] = t.id;
  await until(() => core.db.getTask(t.id)?.status === "done", `task ${title}`);
  ids.push(t.id);
  await Bun.sleep(5);
}
const [first, second] = ids as [string, string];
const b1 = await until(async () => (await batches()).find((b) => b.id === "batch:sso"), "the sso batch");
assert(JSON.stringify(b1.asks.map((a) => a.taskId)) === JSON.stringify([first, second]), `batch: ${JSON.stringify(b1)}`);
report.api = { batches: (await batches()).map((b) => ({ id: b.id, tasks: b.asks.length })) };

// #2054: an approval-window schedule fired now puts one notice of the batch in 判断待ち (#2866), no inbox note
const sch = await post("/api/schedules", { title: "承認待ちのお知らせ", cron: "0 0 * * *", workspaceId: meta.id, runner: "claude", action: "approval-window" });
assert(sch.id, `schedule: ${JSON.stringify(sch)}`);
await post(`/api/schedules/${sch.id}/run`, {});
const note = await until(async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Json[] }).asks.find((a) => a.kind === "notice" && a.question?.startsWith("SSO・配備の承認待ち")), "the approval-window notice");
assert(note.question === "SSO・配備の承認待ち: 2" && note.reason.includes("配備を準備する Task — aws sso login"), `notice: ${JSON.stringify(note)}`);
assert(((await (await fetch(`${base}/api/inbox`)).json()) as Json[]).length === 0, "no inbox note");
report.note = { title: note.question, body: note.reason };

const shots = process.env.SCREENSHOT_DIR;
const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
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
    const s = await call("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, name), Buffer.from(s.data, "base64"));
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `${base}/approvals` });
  const CARD = `document.querySelector('[data-batch="batch:sso"]')`;

  // 2. one card with both Tasks; their own cards are not in the list
  const lines = await until(() => evaluate(`${CARD} && [...${CARD}.querySelectorAll('li')].map(l => l.textContent.trim())`), "the sso card") as string[];
  assert(lines.length === 2 && lines[0]!.startsWith("配備を準備する Task — aws sso login — ") && lines[1]!.startsWith("ログを集める Task — "), `lines: ${JSON.stringify(lines)}`);
  const own = await evaluate(`${JSON.stringify(b1.asks.map((a) => a.askId))}.filter(id => document.querySelector('.card.ask[data-ask="' + id + '"]')).length`);
  assert(own === 0, `${own} of the Tasks' own cards are still listed`);
  report.card = { head: await evaluate(`${CARD}.querySelector('h5').textContent`), lines };
  await shot("batch-1-card.png");

  // 3. 「ログインする」: the older Task alone is sent on; its device code shows on the card
  await evaluate(`[...${CARD}.querySelectorAll('button')].find(b => b.textContent.trim() === 'ログインする').click()`);
  const code = await until(() => evaluate(`${CARD}?.querySelector('.device-code')?.textContent ?? null`), "the device code on the card", 15_000);
  assert(code === CODE, `code: ${code}`);
  assert(JSON.stringify(sent["配備を準備する Task"]) === JSON.stringify([SSO_RESUME_TEXT]) && !sent["ログを集める Task"], `sent: ${JSON.stringify(sent)}`);
  // the Task logging in has no card of its own meanwhile
  assert(await evaluate(`![...document.querySelectorAll('.card.ask[data-ask]')].some(c => c.textContent.includes('配備を準備する Task'))`), "the Task logging in still has its own card");
  report.loggingIn = { login: await evaluate(`${CARD}.querySelector('.ask-batch-login .hint').textContent`), code, remaining: await evaluate(`${CARD}.querySelector('li')?.textContent ?? null`) };
  await shot("batch-2-logging-in.png");
  if (shots) {
    // the card as a page of its own, styles inlined: the screen mockup (issue-workflow 画面イメージ)
    const html = await evaluate(`(() => { const css = [...document.styleSheets].map(s => { try { return [...s.cssRules].map(r => r.cssText).join("\\n"); } catch { return ""; } }).join("\\n"); return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>判断待ち: SSO のまとまり</title><style>' + css + '</style></head><body><div id="root">' + document.querySelector('main').outerHTML + '</div></body></html>'; })()`);
    await Bun.write(join(shots, "batch-card.html"), html);
  }

  // 4. it logs in and ends its turn with no stop → the other Task is sent on; the card goes
  release();
  await until(() => sent["ログを集める Task"]?.includes(SSO_REST_TEXT), "the rest sent on");
  assert(sent["ログを集める Task"]!.length === 1, `rest: ${JSON.stringify(sent)}`);
  await until(async () => (await batches()).length === 0, "no batch left");
  await until(() => evaluate(`${CARD} === null`), "the card gone", 15_000);
  // and once both went on, their stops are resolved (no longer the person's)
  const left = await until(async () => {
    const asks = ((await (await fetch(`${base}/api/asks`)).json()) as AskList).asks.filter((a) => a.kind === "stop" && ids.includes(a.task?.id ?? ""));
    return asks.length === 2 && asks.every((a) => a.state === "resolved") ? asks : null;
  }, "both stops resolved");
  report.resolved = left.map((a) => [a.task?.title, a.state]);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  await until(() => evaluate(`!document.querySelector('.ask-group-person')`), "nothing of the person's left", 15_000);
  await shot("batch-3-done.png");
  report.done = { sent, batches: await batches() };

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify(report, null, 1));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
