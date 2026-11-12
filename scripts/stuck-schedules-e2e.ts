/**
 * Run after `bun run --cwd apps/web build`: env -u SWITCHBOARD_SUPERVISED bun scripts/stuck-schedules-e2e.ts. Requires
 * Chrome (CHROME_BIN overrides; default /usr/local/bin/chromium). No GitHub, no real runner (#4479, #4501).
 *
 * The daemon is the real one (startServer, a throwaway SWITCHBOARD_HOME); the fake runner reports a stop the way a real
 * one does (a `switchboard-stop` fence) for the first two runs of a schedule and ends without one from the third. Checked
 * in headless Chrome at 1280 and 390 px: a schedule whose Task stopped the same way twice is one row on Home (name, count,
 * reason, since when, "not firing") and pressing it opens the newest Task; a due time does not fire it and the schedule
 * log says why; the person's reply to the Task takes the row away and the next due time fires again. The fake runner
 * counts what it was started with, so the numbers are not read off the screen only.
 * SCREENSHOT_DIR=<dir> saves home-stuck-1280.png / home-stuck-390.png (the row on Home).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { StopReport } from "../packages/core/src/stops.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "switchboard.stuck-e2e."));
const fence = (r: object) => `\n\`\`\`switchboard-stop\n${JSON.stringify(r)}\n\`\`\`\n`;
const lock = fence({ id: "lock", op: "gh pr merge", target: "PR #12", reason: "decision", safety: "unknown", state: "waiting", evidence: "lock が残っている", conditions: [{ key: "pr#12", value: "open", met: false }] });
const JOB = "stuck-job";
const started: string[] = []; // the prompts the fake runner was started with, in order
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    if (opts.prompt === JOB || opts.prompt.startsWith("reply:")) started.push(opts.prompt);
    const runs = started.filter((p) => p === JOB).length;
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    // a real runner echoes the person's turn at once; the daemon reads the answer to the Task's open stops off that echo
    if (opts.prompt.startsWith("reply:")) emit({ t: "message.delta", role: "user", text: opts.prompt });
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${started.length}-${Math.random()}`, cwd: opts.cwd });
      // runs 1 and 2 stop on the same thing; the person's reply and run 3 end without stopping
      if (opts.prompt === JOB && runs <= 2) emit({ t: "message.delta", role: "assistant", text: lock, messageId: `m-${Math.random()}` });
      emit({ t: "session.end", status: "ok", summary: opts.prompt });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_PORT: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined) });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const j = (r: Response) => r.json() as Promise<any>;
const post = (path: string, body: object = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
const schedules = async (): Promise<any[]> => fetch(`${base}/api/schedules`).then(j);
const TITLE = "公開リポジトリへの同期（E2E）";

try {
  const meta = ((await fetch(`${base}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
  const made = await post("/api/schedules", { title: TITLE, cron: "0 0 1 1 *", workspaceId: meta.id, runner: "claude", prompt: JOB });
  const runOnce = async (): Promise<string> => {
    const before = (await schedules()).find((s) => s.id === made.id).lastTaskId;
    await post(`/api/schedules/${made.id}/run`);
    const id = await until(async () => { const x = (await schedules()).find((s) => s.id === made.id).lastTaskId; return x && x !== before ? x : null; }, "the run started");
    await until(async () => ["done", "waiting", "error"].includes((await fetch(`${base}/api/tasks/${id}`).then(j)).task.status), "the run stopped");
    return id;
  };

  // (a) one stop is not stuck; the second one in a row is
  const first = await runOnce();
  assert((await schedules()).find((s) => s.id === made.id).stuck === null, "(a) one stop is not stuck");
  const second = await runOnce();
  const row = (await schedules()).find((s) => s.id === made.id);
  assert(row.stuck?.count === 2 && row.stuck.taskId === second && row.stuck.reason === "decision", `(a) ${JSON.stringify(row.stuck)}`);
  assert(first !== second && started.filter((p) => p === JOB).length === 2, "(a) two runs");

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
      if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
    };
    const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 15_000); pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } }); ws!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await call("Runtime.enable");
    await call("Page.enable");
    const section = `document.querySelector('.stuck-schedules')?.innerText ?? ''`;
    const overflow = `document.documentElement.scrollWidth > document.documentElement.clientWidth`;

    // (b) Home: one row with name / count / reason / since / "not firing"; pressing it opens the newest Task. At 1280 and 390
    for (const [width, mobile] of [[1280, false], [390, true]] as const) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile });
      await call("Page.navigate", { url: `${base}/` });
      const text: string = await until(async () => { const t = await evaluate(section); return t.includes(TITLE) ? t : null; }, `${width}: the row on Home`);
      for (const want of ["止まり続けている定期実行 · 1", "2 回続けて同じ理由", "判断待ち: lock が残っている", "から", "発火を止めている"]) assert(text.includes(want), `(b) ${width}px lacks ${JSON.stringify(want)}: ${text}`);
      assert(await evaluate(`document.querySelectorAll('.stuck-schedules .row').length === 1`), "(b) one row");
      assert(!(await evaluate(overflow)), `(b) ${width}px overflows sideways`);
      await evaluate(`document.querySelector('.stuck-schedules').scrollIntoView({ block: 'center' })`);
      if (process.env.SCREENSHOT_DIR) await Bun.write(join(process.env.SCREENSHOT_DIR, `home-stuck-${width}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
      await evaluate(`document.querySelector('.stuck-schedules .row').click()`);
      await until(async () => (await evaluate(`location.pathname`)) === `/task/${second}`, `${width}: the row opens the newest Task`);
      shown[`${width}`] = text.replace(/\n/g, " ");
    }

    // (c) the next due time does not fire it, and the schedule log says why
    core.db.updateSchedule(made.id, { nextRunAt: Date.now() - 1_000 });
    const logged = await until(async () => ((await fetch(`${base}/api/schedules/log`).then(j)) as string[]).find((l) => l.includes(TITLE) && l.includes("飛ばした (due)")), "the due time was skipped and logged", 45_000);
    assert(started.filter((p) => p === JOB).length === 2, "(c) nothing was started by the due time");
    assert((await schedules()).find((s) => s.id === made.id).nextRunAt > Date.now(), "(c) the next time moved on");

    // (d) the person's reply to the Task takes the row away — from the Home already open, without reloading it
    await call("Page.navigate", { url: `${base}/` });
    await until(async () => ((await evaluate(section)) as string).includes(TITLE) || null, "the row on Home before the reply");
    // a stop resolved (and stopped again) within a turn moves no Task's row: the open Home follows the stop records all the same
    const report = (state: "resolved" | "waiting") => StopReport.parse({ id: "lock", op: "gh pr merge", target: "PR #12", reason: "decision", safety: "unknown", state, evidence: "lock が残っている", conditions: [{ key: "pr#12", value: "open", met: false }] });
    const rowAt = async () => (await fetch(`${base}/api/tasks/${second}`).then(j)).task.updatedAt;
    const at = await rowAt();
    assert(core.tasks.recordStop(second, report("resolved")).ok, "(d) resolved recorded");
    await until(async () => !(await evaluate(section)) || null, "the row is gone from the open Home once the stop resolved");
    assert((await rowAt()) === at, "(d) resolving the stop did not move the Task's row");
    assert(core.tasks.recordStop(second, report("waiting")).ok, "(d) stopped again");
    await until(async () => ((await evaluate(section)) as string).includes(TITLE) || null, "the row is back on the open Home");
    const sent = await post(`/api/tasks/${second}/send`, { text: "reply: lock は外した" });
    if (process.env.E2E_DEBUG) console.log(JSON.stringify({ sent: sent?.status ?? sent, started }));
    await until(async () => (await schedules()).find((s) => s.id === made.id).stuck === null, "the reply cleared stuck");
    await until(async () => (await evaluate(`location.pathname`)) === "/" && !(await evaluate(section)) ? true : null, "the row is gone from the open Home");

    // (e) and the clock fires it again
    core.db.updateSchedule(made.id, { nextRunAt: Date.now() - 1_000 });
    await until(() => started.filter((p) => p === JOB).length === 3, "the next due time fired", 45_000);
    assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
    console.log(JSON.stringify({ stuck: { count: row.stuck.count, reason: row.stuck.reason }, shown, skipped: logged, started: started.length, consoleErrors: errors.length }));
  } finally {
    ws?.close();
    chrome.kill();
    await chrome.exited;
  }
} finally {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
