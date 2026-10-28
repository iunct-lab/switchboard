/**
 * bun scripts/backlog-local-e2e.ts (#2265): a workspace without GitHub, from its registration to the 実装 stage Task, in
 * headless Chrome (CDP) against the daemon with a gh that throws (every call recorded) and a fake runner that stays
 * running. The daemon gets no test hook. Build the screen first: `bun run --cwd apps/web build`.
 *
 * (1) 設定: 「Workspace」 → ホストにあるディレクトリを追加 with 「GitHub と連携しない」 checked → (2) `ops-kit backlog create` a request #1 → the
 * Backlog screen lists it under 要望のまま → (3) 「PBI にする」 → a to-pbi Task → (4) as that Task would: PBI #2
 * (`--field Status=Backlog`) and #1's `## 派生 PBI` → #2 under 分解待ち → (5) 「Task に分解」 → a to-tasks Task →
 * (6) Task #3 under #2 and `ops-kit backlog set 2 Status Ready` → #2 under Ready → (7) 「実装する」 → a complete Task.
 * The Tasks' work is done here with `ops-kit backlog` (BACKLOG_URL / BACKLOG_WORKSPACE, as the daemon gives them), the
 * runner being a fake. Then the Home form at 390px. Screenshots and result.json stay in the directory it prints; a JSON
 * of pass / fail per case on stdout; exit 1 when one fails.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer, type CoreServer } from "../packages/core/src/server.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import type { RunnerAdapter, StartOptions, Workspace } from "@switchboard/protocol";
import { runBacklog } from "../ops-kit/src/backlog-client.ts";

const out = mkdtempSync(join(tmpdir(), "switchboard.backlog-local-e2e."));
const shots = join(out, "shots");
mkdirSync(shots);
const home = join(out, "home");
// the workspace: a Git checkout with no origin, and this repository's ops.config.json (its field choices)
const repo = join(out, "repo");
mkdirSync(repo);
Bun.spawnSync(["git", "init", "-q", repo]);
copyFileSync(join(import.meta.dir, "../ops.config.json"), join(repo, "ops.config.json"));

const ghCalls: Array<{ cwd: string; args: string[] }> = [];
const gh: GhRunner = async (args, cwd) => {
  ghCalls.push({ cwd, args });
  throw new Error("spawn gh ENOENT");
};
const starts: StartOptions[] = [];
/** Ends a stage Task's turn, as the real one does when its work is done (`finish`). */
const enders = new Map<string, () => void>();
// a runner whose turn runs until the script has done the Task's work for it
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    starts.push(opts);
    enders.set(opts.env?.SWITCHBOARD_TASK_ID ?? "", () => emit({ t: "session.end", status: "ok" }));
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};

/** A free port from 47911 up (the dev daemon and other sessions' checks use the lower ones). */
function freePort(): number {
  for (let port = 47911; port < 48911; port++) {
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return port;
    } catch {
      // taken
    }
  }
  throw new Error("no free port from 47911");
}

const cases: Record<string, boolean> = {};
const check = (name: string, ok: boolean, detail?: unknown) => {
  cases[name] = ok;
  if (!ok) console.error(`✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail));
};
async function until<T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timed out: ${what}`);
}

const port = freePort();
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: String(port), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
let core: CoreServer | null = await startServer(cfg, [adapter], { port, selfdevChecks: false, dryRunRestart: true, gh, backlogAutoImport: true });
const base = `http://127.0.0.1:${core.server.port}`;
const profile = join(out, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1100,1500", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let sock: WebSocket | undefined;
let ws: Workspace | undefined;
const kitLog: string[] = [];
/** `ops-kit backlog …` as the stage Task runs it: the daemon's BACKLOG_URL and the workspace it gives, in the checkout. */
const kit = async (...argv: string[]) => {
  const lines: string[] = [];
  const code = await runBacklog(argv, { BACKLOG_URL: `${base}/api/backlog`, BACKLOG_WORKSPACE: ws!.id }, { out: (s) => lines.push(s), err: (s) => lines.push(s) }, { cwd: repo });
  kitLog.push(`$ ops-kit backlog ${argv.join(" ")}\n${lines.join("\n")}\n(exit ${code})`);
  if (code !== 0) throw new Error(`ops-kit backlog ${argv.join(" ")}: exit ${code}: ${lines.join(" ")}`);
  return lines.join("\n");
};
const bodyFile = (name: string, text: string) => {
  const p = join(out, name);
  writeFileSync(p, text);
  return p;
};

try {
  const cdpPort = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port", 20_000);
  const target = await until(async () => ((await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  sock = new WebSocket(target);
  await new Promise<void>((resolve, reject) => { sock!.onopen = () => resolve(); sock!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  sock.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); sock!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)} in: ${expression.slice(0, 160)}`);
    return r.result.value;
  };
  /** Presses what `find` returns once it has stayed still (rows move while the list reads). */
  const press = async (find: string, label: string) => {
    const at = `(() => { const b = ${find}; if (!b || b.disabled) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return b.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`;
    const point = await until(async () => {
      const a = (await evaluate(at)) as { x: number; y: number } | null;
      if (!a) return null;
      await Bun.sleep(100);
      const b = (await evaluate(at)) as { x: number; y: number } | null;
      return b && b.x === a.x && b.y === a.y ? b : null;
    }, `pressable ${label}`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const shot = async (name: string) => writeFileSync(join(shots, `${name}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const addCard = `[...document.querySelectorAll('section.card')].find(s => s.querySelector('h5')?.textContent.trim() === 'Workspace')`;
  const pathField = `(${addCard})?.querySelector('input[placeholder="/absolute/path/to/repo"]')`;
  const localBox = `(${addCard})?.querySelector('label input[type=checkbox]')`;
  const openHome = async () => {
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");
    await press(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Settings')`, "Settings");
    await until(() => evaluate(`!!(${addCard})`), "設定's Workspace card");
    await press(`[...(${addCard})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === 'ホストにあるディレクトリを追加')`, "ホストにあるディレクトリを追加");
    await until(() => evaluate(`!!(${pathField})`), "the path field");
  };
  const openBacklog = async () => {
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");
    await press(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Backlog')`, "Backlog");
    await until(() => evaluate(`document.querySelectorAll('.backlog section[data-stage]').length === 5 && !document.querySelector('.backlog .head .hint')?.textContent.includes('読み込み中')`), "the list");
  };
  /** The row of #n of the local workspace, in the section of `stage` (null = not there). */
  const rowIn = (stage: string, n: number) => `[...document.querySelectorAll('.backlog section[data-stage="${stage}"] .backlog-item')].find(r => r.querySelector('.t')?.textContent.trim().startsWith('#${n} ') && r.querySelector('.workspace')?.textContent.trim() === ${JSON.stringify("repo")})`;
  const listed = async (stage: string, n: number) => (await evaluate(`!!(${rowIn(stage, n)})`)) as boolean;
  const startPressed = async (stage: string, n: number, label: string, action: string) => {
    await press(`[...(${rowIn(stage, n)}).querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`, `${label} #${n}`);
    return until(() => core!.db.listTasks().find((t) => t.workspaceId === ws!.id && t.stage?.issue === n && t.stage.action === action), `the ${action} Task of #${n}`);
  };
  const finish = async (taskId: string) => {
    enders.get(taskId)!();
    await until(() => core!.db.getTask(taskId)?.status === "done", `${taskId} done`);
  };
  const promptOf = async (taskId: string) => (await until(() => starts.find((s) => s.env?.SWITCHBOARD_TASK_ID === taskId), `the runner start of ${taskId}`));
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  // (1) 設定: the path, 「GitHub と連携しない」, 追加
  await openHome();
  check("the GitHub-less box is off by default", (await evaluate(`(${localBox}).checked`)) === false);
  await evaluate(`(() => { const e = ${pathField}; e.focus(); e.select(); })()`);
  await call("Input.insertText", { text: repo });
  await press(localBox, "GitHub と連携しない");
  await until(() => evaluate(`(${localBox}).checked`), "the box checked");
  await shot("1-home-add");
  await press(`[...(${addCard})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === '追加')`, "追加");
  ws = await until(() => core!.db.listWorkspaces().find((w) => w.path === repo), "the workspace registered");
  check("the workspace is registered without GitHub", ws.backlog === "switchboard" && core!.db.getWorkspaceBacklogSource(ws.id)?.service === "switchboard", ws);
  await until(async () => (await evaluate(`(${pathField}).value`)) === "" && (await evaluate(`(${localBox}).checked`)) === false, "the form cleared");
  check("after adding, the path and the box are cleared", true);

  // (2) a request through the kit → the Backlog lists it under 要望のまま
  const made = await kit("create", "--title", "要望: ローカルで回す", "--label", "type:request", "--body-file", bodyFile("req.md", "## 要望\nGitHub 無しで回したい\n\n## 出典\nE2E"));
  check("ops-kit backlog create gives #1", made.startsWith("#1 を作りました"), made);
  await openBacklog();
  await until(() => listed("request", 1), "#1 under 要望のまま");
  check("#1 is listed under 要望のまま", true);
  await shot("2-request");

  // (3) 「PBI にする」 → a to-pbi Task, told to use the kit only, given the workspace
  const toPbi = await startPressed("request", 1, "PBI にする", "to-pbi");
  const s1 = await promptOf(toPbi.id);
  check("the to-pbi Task's prompt says ops-kit backlog, not gh repo view", s1.prompt.includes("ops-kit backlog") && !s1.prompt.includes("gh repo view"), s1.prompt.slice(-400));
  check("the to-pbi Task gets BACKLOG_WORKSPACE", s1.env?.BACKLOG_WORKSPACE === ws.id, s1.env?.BACKLOG_WORKSPACE);
  await shot("3-to-pbi");

  // (4) as the to-pbi Task: PBI #2 and #1's ## 派生 PBI → #2 under 分解待ち
  const pbi = await kit("create", "--title", "PBI: ローカルで回せる", "--label", "type:pbi", "--field", "Status=Backlog", "--body-file", bodyFile("pbi.md", "## ユーザーストーリー\nx\n\n## 到達点 / 受け入れ条件\n- [ ] 1. x（検証: y）\n\n## スコープ外\nなし\n\n## 元要望\n#1"));
  check("the PBI is #2", pbi.startsWith("#2 を作りました"), pbi);
  await kit("edit", "1", "--body-file", bodyFile("req2.md", "## 要望\nGitHub 無しで回したい\n\n## 出典\nE2E\n\n## 派生 PBI\n- #2 ローカルで回せる — P2"));
  await finish(toPbi.id);
  await openBacklog();
  await until(() => listed("needs-tasks", 2), "#2 under 分解待ち");
  check("#2 is listed under 分解待ち and #1 left 要望のまま", !(await listed("request", 1)));
  await shot("4-needs-tasks");

  // (5) 「Task に分解」 → a to-tasks Task
  const toTasks = await startPressed("needs-tasks", 2, "Task に分解", "to-tasks");
  check("the to-tasks Task's prompt says ops-kit backlog", (await promptOf(toTasks.id)).prompt.includes("ops-kit backlog"));

  // (6) as the to-tasks Task: Task #3 under #2, then #2 Ready
  const task = await kit("create", "--title", "Task: 実装する", "--label", "type:task", "--parent", "2", "--field", "Status=Backlog", "--body-file", bodyFile("task.md", "## 親 PBI\n#2\n\n## やること\n`src/index.ts`"));
  check("the Task is #3", task.startsWith("#3 を作りました"), task);
  await kit("set", "2", "Status", "Ready");
  await finish(toTasks.id);
  const view = await kit("view", "2");
  check("#2 reads Status=Ready through the kit", view.includes("Status=Ready"), view);
  await openBacklog();
  await until(() => listed("ready", 2), "#2 under Ready");
  check("#2 is listed under Ready with its one Task", ((await evaluate(`(${rowIn("ready", 2)}).textContent`)) as string).includes("Task 0/1"));
  await shot("5-ready");

  // (7) 「実装する」 → the complete Task
  const complete = await startPressed("ready", 2, "実装する", "complete");
  const s3 = await promptOf(complete.id);
  check("the complete Task asks to complete PBI #2 with the kit", s3.prompt.includes("PBI #2 を完了させてください") && s3.prompt.includes("ops-kit backlog") && !s3.prompt.includes("gh repo view"), s3.prompt.slice(0, 300));
  await shot("6-complete");

  // the Home form at a phone's width: the box under the field, nothing off the screen
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await openHome();
  await evaluate(`(${addCard}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await until(async () => {
    const top = (await evaluate(`(${addCard}).getBoundingClientRect().top`)) as number;
    return top >= 0 && top < 844;
  }, "the card in view");
  await Bun.sleep(200);
  const fit = (await evaluate(`(() => { const f = (${pathField}).getBoundingClientRect(), b = (${localBox}).closest('label').getBoundingClientRect(); return { below: b.top >= f.bottom - 1, right: b.right <= window.innerWidth + 1, overflow: document.documentElement.scrollWidth - window.innerWidth }; })()`)) as { below: boolean; right: boolean; overflow: number };
  check("at 390px the box is under the field and fits", fit.below && fit.right && fit.overflow <= 1, fit);
  // the whole page at that width (the card is at the bottom of Home)
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 2600, deviceScaleFactor: 1, mobile: true });
  await Bun.sleep(300);
  await shot("7-home-390");
  check("no CSP security entries", errors.length === 0, errors);
  const local = ghCalls.filter((c) => c.cwd === repo);
  check("gh was never called for the workspace without GitHub", local.length === 0, local);
} catch (e) {
  check("ran to the end", false, { error: String((e as Error)?.message ?? e) });
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify({ cases, ghCalls: { local: ghCalls.filter((c) => c.cwd === repo).length, all: ghCalls.length, otherWorkspaces: [...new Set(ghCalls.map((c) => c.cwd))].filter((c) => c !== repo).length }, kit: kitLog }, null, 2));
  sock?.close();
  chrome.kill();
  await chrome.exited;
  await core?.stop();
  core = null;
  console.error(`artifacts: ${out}`);
}
const failed = Object.entries(cases).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ pass: failed.length === 0, cases: Object.keys(cases).length, failed, ghCallsLocal: ghCalls.filter((c) => c.cwd === repo).length }, null, 2));
process.exit(failed.length ? 1 : 0);
