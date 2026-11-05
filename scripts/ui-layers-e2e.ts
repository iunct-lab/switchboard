/**
 * Run after `bun run --cwd apps/web build`: CHROME_BIN=/usr/local/bin/chromium bun scripts/ui-layers-e2e.ts.
 * The monthly floor / ceiling / walls check (#3353) through the real daemon with a fake runner: the schedule is there from
 * the start; a firing starts the check's Task, whose reply registers the HTML report (written by the real
 * `ui-layers-report.ts`, the history under SWITCHBOARD_HOME) and the report leads `GET /api/reports`; the second firing's
 * report has the first's values and the difference; the same findings filed twice create no request the second time (a
 * fake `create`); a hot 7-day window skips the firing with the reason in the log; Insights shows the report's row.
 * Prints one `ok` line per check and exits 0, or throws.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { UI_LAYERS_PROMPT } from "../packages/core/src/scheduler.ts";
import { startServer } from "../packages/core/src/server.ts";
import { readUiMetrics } from "./ui-layers-metrics.ts";
import { fileRequests, type Finding } from "./ui-layers-requests.ts";

const root = join(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "switchboard.e2e."));
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const ok = (line: string) => console.log(`ok  ${line}`);

/** The check's Task, as a fake runner: it writes the report with the real script, as the instruction says, and registers it. */
let run = 0;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }), efforts: [{ value: "high", label: "high" }],
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    // the daemon's judges start claude too: only the check's own Task writes a report
    if (opts.prompt !== UI_LAYERS_PROMPT) {
      queueMicrotask(() => { emit({ t: "session.start", runner: "claude", runnerSessionId: "s-other", cwd: opts.cwd }); emit({ t: "session.end", status: "ok" }); exit(0); });
      return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
    }
    const n = ++run;
    const w = mkdtempSync(join(home, `check${n}-`));
    // the second run sees one more visible input than the first, so the difference is not 0
    const metrics = readUiMetrics(root);
    metrics.homeComposeVisible += n - 1;
    writeFileSync(join(w, "metrics.json"), JSON.stringify(metrics));
    writeFileSync(join(w, "placement.json"), JSON.stringify({ checked: 1, missing: [{ number: 9, title: "PBI: 行の無い画面の PBI" }] }));
    writeFileSync(join(w, "ratings.json"), JSON.stringify({ floor: "床の評価", ceiling: "天井の評価", walls: "壁の評価" }));
    const out = join(w, "ui-layers.html");
    const made = Bun.spawnSync(["bun", join(root, "scripts/ui-layers-report.ts"), "--metrics", join(w, "metrics.json"), "--placement", join(w, "placement.json"), "--ratings", join(w, "ratings.json"), "--out", out], { env: { ...process.env, SWITCHBOARD_HOME: home } });
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-ui-layers-${n}`, cwd: opts.cwd });
      const fence = "```switchboard-artifact\n" + JSON.stringify({ path: out, title: `床・天井・壁の点検 ${n}` }) + "\n```\n";
      emit({ t: "message.delta", role: "assistant", text: made.exitCode === 0 ? `点検しました。\n${fence}` : `レポートを作れませんでした: ${made.stderr}` });
      emit({ t: "session.end", status: "ok", summary: "done" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};

const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const base = `http://127.0.0.1:${core.server.port}`;
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;
const fire = (id: string) => fetch(`${base}/api/schedules/${id}/run`, { method: "POST" });

let chrome: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
try {
  // 1. the schedule is there from the start, and a firing's report leads the reports
  const check = ((await get("/api/schedules")) as any[]).find((s) => s.action === "ui-layers");
  assert(check && check.runner === "claude" && check.enabled, `the monthly check is there from the start: ${JSON.stringify(check)}`);
  ok(`既定の定期実行: ${check.title} (${check.cron})`);
  const reportOf = async (n: number) => {
    const res = await fire(check.id);
    if (res.status !== 201) throw new Error(`firing ${n}: ${res.status} ${await res.text()}`);
    const task = await res.json();
    await until(async () => (await get(`/api/tasks/${task.id}`)).task.status === "done", `the check's Task ${n} ends`);
    const reports = await until(async () => { const r = (await get("/api/reports")) as any[]; return r[0]?.title === `床・天井・壁の点検 ${n}` ? r : null; }, `report ${n} leads /api/reports`);
    return { task, report: reports[0], html: readFileSync(join(home, "artifacts", task.id, reports[0].id, reports[0].entry), "utf8") };
  };
  const first = await reportOf(1);
  assert(first.html.includes("<td>初回</td>"), "the first report says 初回");
  ok(`1 回目: Task ${first.task.id} の HTML が /api/reports の先頭（${first.report.title}）`);

  // 2. the second report has the first's values and the difference
  const second = await reportOf(2);
  const m = readUiMetrics(root);
  const row = `<td>Home の作成フォームで常に見える操作の数</td><td>${m.homeComposeVisible + 1}</td><td>${m.homeComposeVisible}</td><td>+1</td>`;
  assert(second.html.includes(row), `the second report's row: ${row}`);
  assert(readFileSync(join(home, "ui-layers", "history.jsonl"), "utf8").trim().split("\n").length === 2, "two lines in the history");
  ok(`2 回目: 前回 ${m.homeComposeVisible} → 今回 ${m.homeComposeVisible + 1}、差 +1（履歴 2 行）`);

  // 3. the same findings twice: the second files nothing
  const open: string[] = [];
  const deps = { listOpenRequestTitles: async () => [...open], create: async (title: string) => (open.push(title), `#${open.length}`) };
  const findings: Finding[] = [{ key: "home", title: "Home の入口が重くなった", detail: "操作が 1 つ増えた", source: "定期の検査" }];
  const a = await fileRequests(findings, deps, "2026-11-04");
  const b = await fileRequests(findings, deps, "2026-11-04");
  assert(a.created.length === 1 && b.created.length === 0 && b.duplicates === 1, `requests: ${JSON.stringify({ a, b })}`);
  ok("同じ所見の 2 回目: 要望 0 件（重複 1）");

  // 4. a hot 7-day window: no Task, the reason in the log
  core.db.upsertQuota("claude", "seven_day", 0.95, Date.now() / 1000 + 3600);
  const tasksBefore = ((await get("/api/tasks")) as any[]).length;
  const skipped = await fire(check.id);
  assert(skipped.status === 409, `a hot window: ${skipped.status}`);
  assert(((await get("/api/tasks")) as any[]).length === tasksBefore, "no Task for a hot window");
  const line = ((await get("/api/schedules/log")) as string[]).at(-1) ?? "";
  assert(line.includes("ui-layers を飛ばした") && line.includes("95%"), `the log: ${line}`);
  ok(`閾値以上: 409、Task は増えない、ログ「${line}」`);

  // 5. Insights shows the report's row
  const profile = join(home, "chrome");
  chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (event) => { const msg = JSON.parse(String(event.data)); if (msg.id) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); } };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await call("Page.enable");
  await call("Page.navigate", { url: `${base}/insights` });
  const shown = await until(() => evaluate(`document.querySelector('main')?.innerText.includes('床・天井・壁の点検 2') ? document.querySelector('main').innerText.split('\\n').find((l) => l.includes('床・天井・壁の点検 2')) : null`), "Insights lists the report");
  ok(`Insights の画面に「${shown}」`);
} finally {
  ws?.close();
  chrome?.kill();
  await chrome?.exited; // before its profile goes with the directory
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
