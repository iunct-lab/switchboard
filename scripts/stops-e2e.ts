/**
 * Run after `bun run --cwd apps/web build`: env -u SWITCHBOARD_SUPERVISED bun scripts/stops-e2e.ts. Requires Chrome
 * (CHROME_BIN overrides; default /usr/local/bin/chromium). No GitHub, no real runner (#939, #952).
 *
 * A fake runner reports its stops the way a real one does — a `switchboard-stop` fence in its reply — and the daemon is
 * the real one (startServer). Checked: the same condition stopping again is one series with a count and no new question;
 * a different reason code in similar words is its own series; a bounded retry that succeeds ends resolved, one that
 * keeps failing ends as one decision item with what was done; a restart forgets nothing; a tool approval of another
 * target is not suppressed; and the Task screen at 1280 and 390 px shows count / last answer / change / next / actions
 * with 0 console errors. The retries themselves are the runner's (the daemon only records and bounds them, repeated-stops.md), so the
 * fake runner plays them as reports; the inbox card of a series is asks.test.ts / asks-e2e.ts's. The fake runner counts what it was told to run, so the numbers are not read off the screen only.
 * SCREENSHOT=<file.png> saves the 1280 Task screen.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter, StopSummary } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "switchboard.stops-e2e."));
const fence = (r: object) => `\n\`\`\`switchboard-stop\n${JSON.stringify(r)}\n\`\`\`\n`;
const ci = { op: "gh pr merge", target: "PR #12", reason: "depends", safety: "unknown", state: "waiting", conditions: [{ key: "pr#12", value: "open", met: false }] };
const net = (id: string, state: string, actions: object[], evidence = "HTTP 503") => fence({ id, op: "gh pr checks", target: "PR #12", reason: "transient", safety: "read-only", evidence, state, actions });
const turns = new Map<string, number>(); // what the fake runner was started with, by prompt
const scripts: Record<string, string[]> = {
  ci: [fence({ ...ci, id: "ci", evidence: "CI が終わっていない" })],
  // similar words, another reason code: its own series
  auth: [fence({ ...ci, id: "auth", reason: "auth", evidence: "CI が終わっていない（認証が切れている）", conditions: [] })],
  // a retry that works
  netok: [net("net-ok", "retrying", [{ attempt: 1, what: "5 秒後に再実行", ok: null }]), net("net-ok", "resolved", [{ attempt: 1, what: "5 秒後に再実行", ok: true }])],
  // a retry that keeps failing: two tries, then one decision item
  netbad: [
    net("net-bad", "retrying", [{ attempt: 1, what: "5 秒後に再実行", ok: null }]),
    net("net-bad", "retrying", [{ attempt: 1, what: "5 秒後に再実行", ok: false }, { attempt: 2, what: "30 秒後に再実行", ok: null }]),
    net("net-bad", "exhausted", [{ attempt: 1, what: "5 秒後に再実行", ok: false }, { attempt: 2, what: "30 秒後に再実行", ok: false }]),
  ],
};
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    // the daemon's own helper turns (the rubric judge) are not the scenario's runs
    if (opts.prompt in scripts || opts.prompt === "ask-other") turns.set(opts.prompt, (turns.get(opts.prompt) ?? 0) + 1);
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${turns.size}-${Math.random()}`, cwd: opts.cwd });
      if (opts.prompt === "ask-other") return void emit({ t: "permission.ask", id: "p-other", kind: "exec", tool: "Bash", input: { command: "rm -rf build" }, detail: "rm -rf build" });
      for (const text of scripts[opts.prompt] ?? []) emit({ t: "message.delta", role: "assistant", text, messageId: `m-${Math.random()}` });
      emit({ t: "session.end", status: "ok", summary: opts.prompt });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
const boot = () => startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined) });
let core = await boot();
let base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const j = (r: Response) => r.json() as Promise<any>;
const meta = ((await fetch(`${base}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
const titles: string[] = [];
async function run(prompt: string): Promise<string> {
  const title = `#939 実装: PBI: ${prompt} ${titles.length}`;
  titles.push(title);
  const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: meta.id, title, prompt, runner: "claude" }) }).then(j);
  await until(async () => ["done", "waiting", "error"].includes((await fetch(`${base}/api/tasks/${t.id}`).then(j)).task.status), `${title} stopped`);
  return t.id;
}
const series = async (id: string, op: string, reason?: string): Promise<StopSummary> =>
  (await fetch(`${base}/api/tasks/${id}`).then(j)).stopSummary.find((s: StopSummary) => s.op === op && (!reason || s.reason === reason));

try {
// (a) the same condition stopping three times: one series, counted, unchanged, waiting for the condition — no new question
let last = "";
for (let n = 0; n < 3; n++) last = await run("ci");
const a = await series(last, "gh pr merge", "depends");
assert(a.count === 3 && a.unchanged && a.changes.length === 0 && a.next === "wait" && a.lastAnswer === null, `(a) ${JSON.stringify(a)}`);
assert(turns.get("ci") === 3, `(a) the fake runner ran ${turns.get("ci")} times`);

// (b) similar words, another reason code: its own series, shown as a new cause; (a)'s series stays 3
last = await run("auth");
const b = await series(last, "gh pr merge", "auth");
assert(b.count === 1 && b.changes.some((c) => c.kind === "cause") && b.next === "decide", `(b) ${JSON.stringify(b)}`);
assert((await series(last, "gh pr merge", "depends")).count === 3, "(b) the depends series is still 3");

// (c) a bounded retry that works, and one that keeps failing
last = await run("netok");
const c = await series(last, "gh pr checks");
assert(c.state === "resolved" && c.next === "none" && c.actions.length === 1 && c.actions[0]!.ok === true, `(c) ${JSON.stringify(c)}`);
last = await run("netbad");
const d = (await fetch(`${base}/api/tasks/${last}`).then(j)).stopSummary.find((s: StopSummary) => s.op === "gh pr checks" && s.state === "exhausted") as StopSummary;
assert(d && d.next === "decide" && d.actions.length === 2 && d.actions.every((x) => x.ok === false), `(d) ${JSON.stringify(d)}`);
// one decision item: of the work's series exactly one is a failed retry waiting for the person (the inbox card is that
// series, keyed by its series key — asks.test.ts / asks-e2e.ts; this runs without GitHub, so no backlog item to list)
const decide = ((await fetch(`${base}/api/tasks/${last}`).then(j)).stopSummary as StopSummary[]).filter((s) => s.next === "decide" && s.reason === "transient");
assert(decide.length === 1 && decide[0]!.key === d.key, `(d) one decision item for the failed retries: ${JSON.stringify(decide)}`);
const retryAsks = decide;

// (e) a tool approval of another target is not suppressed by the stops of the same work
const askTask = await run("ask-other");
assert(core.tasks.pendingApprovals().some((p) => p.taskId === askTask && p.id === "p-other"), "(e) the approval of another target is pending");

// (f) a restart forgets nothing
await core.stop();
core = await boot();
base = `http://127.0.0.1:${core.server.port}`;
const f = await series(last, "gh pr merge", "depends");
assert(f.count === 3 && f.unchanged, `(f) after restart ${JSON.stringify(f)}`);
assert(turns.get("ci") === 3 && turns.get("netbad") === 1, "(f) nothing was started again by itself");

// (g) the Task screen, at 1280 and 390
const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
const shown: Record<string, string> = {};
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const page = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15_000); pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  const open = async (title: string) => {
    await until(() => evaluate(`(() => { const rows = [...document.querySelectorAll('.rail-list button.it')]; const b = rows.find((x) => x.querySelector('.t')?.textContent === ${JSON.stringify(title)}); if (b && b.getBoundingClientRect().height > 0) { b.click(); return true; } document.querySelector('.rail-tasks')?.click(); return false; })()`), `open ${title}`);
  };
  for (const [width, mobile] of [[1280, false], [390, true]] as const) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile });
    await call("Page.navigate", { url: `${base}/` });
    // the last "ci" run: third time, nothing changed, waits for the condition; no answer yet
    await open(titles[2]!);
    const text = await until(async () => { const t = await evaluate(`document.querySelector('.backlog-stops')?.innerText ?? ''`); return t.includes("3 回目") ? t : null; }, `${width}: the stops of the third ci run`);
    await evaluate(`document.querySelectorAll('.backlog-stops details').forEach((d) => (d.open = true))`);
    const all = await evaluate(`document.querySelector('.backlog-stops').innerText`);
    for (const want of ["gh pr merge PR #12: depends", "3 回目", "条件の変化待ち・操作不要", "前回の回答: なし", "前回からの変化: なし（同じ条件）"]) assert(all.includes(want), `(g) ${width}px lacks ${JSON.stringify(want)}: ${all}`);
    // the failed retries: what was done and that a person decides
    await open(titles[5]!);
    const failed = await until(async () => { const t = await evaluate(`(() => { document.querySelectorAll('.backlog-stops details').forEach((d) => (d.open = true)); return document.querySelector('.backlog-stops')?.innerText ?? ''; })()`); return t.includes("あなたの判断が必要です") && t.includes("30 秒後に再実行") ? t : null; }, `${width}: the failed retries`);
    assert(failed.includes("1 回目: 5 秒後に再実行（失敗）") && failed.includes("2 回目: 30 秒後に再実行（失敗）"), `(g) ${width}px actions: ${failed}`);
    shown[`${width}`] = `${text.split("\n")[0]} | ${failed.split("\n")[0]}`;
    if (width === 1280 && process.env.SCREENSHOT) await Bun.write(process.env.SCREENSHOT, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ a: { count: a.count, next: a.next }, b: { count: b.count, changes: b.changes }, c: c.state, d: { state: d.state, actions: d.actions.length }, retryAsks: retryAsks.length, started: Object.fromEntries(turns), shown, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
}
} finally {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
