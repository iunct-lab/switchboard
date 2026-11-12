/**
 * Run after `bun run --cwd apps/web build`: bun scripts/release-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * Promoting from the settings screen (#1660): a fake sb-rescue runs the commit before HEAD, a fake runner keeps a Task
 * running, and the header's 「新しい版 →」, the 「動いている版」 section, the two-step confirmation and the Brief are
 * driven in headless Chrome. The daily promotion notice (#2148): with the Task running, a tag on HEAD is held by a
 * backlog-next firing, and an approval-window firing shows 「昇格待ち: <tag>」 in 判断待ち, from where 「新しい版 →」 and
 * 「待たずに昇格する」 promote HEAD. SCREENSHOT=<file.png> also saves what the settings screen looked like, and
 * <file>-asks.png the 判断待ち with the notice.
 * A public copy's clone (#4569): the fixture's origin is a bare copy named like `publicSync.target`, the fake runner answers
 * the check Task with the `switchboard-release-review` fence (v1.0.0: ok, v1.1.0: one concern), the first tag is promoted
 * by itself after the check and the second only through 「懸念を見たうえで更新する」 and its dialog. <file>-public.png is the
 * settings section at 390 px (phone width).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const home = mkdtempSync(join(tmpdir(), "sb-release-e2e-"));
const repo = join(home, "app");
mkdirSync(repo);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "feat: first");
git("commit", "-q", "--allow-empty", "-m", "feat: the newer version");
const head = git("rev-parse", "HEAD");
let running = git("rev-parse", "HEAD~1");
const promoted: string[] = [];
const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/api/status") return Response.json({ current: running, previous: null, state: "running", busy: null, lastError: null, history: [] });
  if (url.pathname === "/api/promote") { promoted.push(((await req.json()) as { commit: string }).commit); return Response.json({ started: "promote" }, { status: 202 }); }
  return new Response("no", { status: 404 });
} });
// Stays running until it is stopped, waiting on an approval: the Task counts as busy.
// The public copy's check (#4569) is a read-only (`plan`) Task: it answers at once with the fence the prompt asks for.
const checks: Array<{ cwd: string; permissionMode?: string; prompt: string }> = [];
// A check answers once the gate is open, so a tag can be seen with its check still running.
let openGate = () => {};
let gate: Promise<void> = Promise.resolve();
const closeGate = () => { gate = new Promise<void>((r) => (openGate = r)); };
const fence = (j: object) => "確認した。\n```switchboard-release-review\n" + JSON.stringify(j) + "\n```";
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  models: [{ value: "m-e2e", label: "m-e2e" }],
  permissionModes: [{ value: "plan", label: "plan", description: "" }],
  start(opts, emit) {
    if (opts.cwd.includes("/release-review/")) {
      checks.push({ cwd: opts.cwd, permissionMode: opts.permissionMode, prompt: opts.prompt });
      const concern = opts.prompt.includes("v1.1.0");
      void gate.then(() => emit({ t: "session.end", status: "ok", summary: fence(concern ? { verdict: "concern", findings: [{ path: "packages/core/src/exfil.ts", why: "起動時に process.env を外の URL へ POST している" }] } : { verdict: "ok", findings: [] }) }));
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise<number | null>(() => {}) };
    }
    queueMicrotask(() => emit({ t: "permission.ask", id: "perm-e2e", kind: "exec", tool: "Bash", input: { command: "ls" }, detail: "ls" }));
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
let core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true });
const daemonPort = core.server.port;
const base = `http://127.0.0.1:${daemonPort}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,1400", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const pageUrl = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  ws = new WebSocket(pageUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const errors: unknown[] = [];
  // window.confirm: remember the message, answer with `answer` (the update button's dialog)
  const dialogs: string[] = [];
  let answer = true;
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); void call("Page.handleJavaScriptDialog", { accept: answer }); }
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown") errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  /** Presses the button `find` (a JS expression) returns, once it has stayed where it is. */
  const press = async (find: string, label: string) => {
    const at = `(() => { const b = ${find}; if (!b || b.disabled) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return b.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`;
    const point = await until(async () => {
      const first = await evaluate(at) as { x: number; y: number } | null;
      if (!first) return null;
      await Bun.sleep(100);
      const second = await evaluate(at) as { x: number; y: number } | null;
      return second && second.x === first.x && second.y === first.y ? second : null;
    }, label);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  };
  const byText = (text: string, scope = "button") => `[...document.querySelectorAll('${scope}')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const panelText = () => evaluate(`document.querySelector('#release')?.textContent ?? ''`) as Promise<string>;
  const short = head.slice(0, 7);

  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");

  // (a) the header says there is a newer version; it opens the settings section
  const mark = await until(() => evaluate(`document.querySelector('.new-version')?.textContent ?? null`), "新しい版 in the header");
  assert(mark === `新しい版 ${short} →`, `header mark: ${mark}`);
  await press(`document.querySelector('.new-version')`, "新しい版 →");
  await until(() => evaluate(`!!document.querySelector('#release')`), "the 動いている版 section");
  // the cards are folded (#3849): the link opens the one it points at
  assert(await until(() => evaluate(`document.querySelector('#release').open`), "the 動いている版 section open"), "the section is folded");
  const ahead = await until(async () => { const t = await panelText(); return t.includes("1 コミット先") ? t : null; }, "1 コミット先");
  assert(ahead.includes("動いている版") && ahead.includes(`HEAD: ${short} feat: the newer version — 1 コミット先`), `section: ${ahead}`);
  assert(await until(() => evaluate(`document.getElementById('release').getBoundingClientRect().top < innerHeight`), "the section is scrolled into view"), "the section is below the viewport");
  assert(await evaluate(`!!document.querySelector('#release a[href]')`), "the section links the rescue page");
  if (process.env.SCREENSHOT) writeFileSync(process.env.SCREENSHOT, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));

  // (b) no Task is running: one press sends HEAD once
  assert(!(await evaluate(`document.querySelector('#release').textContent.includes('動いている Task')`)), "no busy-task line with nothing running");
  await press(byText("この版を昇格", "#release button"), "この版を昇格");
  await until(() => promoted.length === 1, "one promotion sent");
  assert(promoted[0] === head, `promoted ${promoted[0]}`);
  await until(async () => (await panelText()).includes(`${short} を別ポートで起動して確認しています`), "the result line");

  // (c) a running Task: the first press only asks, 待たずに昇格する sends
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const task = await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: meta.path, workspaceId: meta.id, title: "busy task", prompt: "p", runner: "claude" }) })).json() as { id: string };
  await until(() => core.db.listTasksByStatus("waiting").length + core.db.listTasksByStatus("running").length > 0, "the Task runs");
  await until(async () => (await panelText()).includes("動いている Task 1 件: 昇格するとデーモンが再起動します"), "the busy-task line");

  // (c') the newest tag waits for the running Task; the daily firing (approval-window) tells it in 判断待ち (#2148)
  git("tag", "v0.0.1", head);
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const fire = async (title: string, action: string) => {
    const s = await (await post("/api/schedules", { title, cron: "0 0 * * *", workspaceId: meta.id, runner: "claude", prompt: "", action })).json() as { id?: string; error?: string };
    assert(s.id, `schedule ${action}: ${JSON.stringify(s)}`);
    const r = await post(`/api/schedules/${s.id}/run`, {});
    // backlog-next answers 409 when it started nothing (here: it held the tag for the running Task)
    assert(r.ok || (action === "backlog-next" && r.status === 409), `run ${action}: ${r.status} ${await r.text()}`);
  };
  await fire("バックログを進める", "backlog-next");
  const hold = await until(async () => ((await (await fetch(`${base}/api/daemon/release`)).json()) as { hold: { tag: string; failed: boolean; since: number } | null }).hold, "the promotion hold");
  assert(hold.tag === "v0.0.1" && !hold.failed && hold.since > 0, `hold: ${JSON.stringify(hold)}`);
  assert(promoted.length === 1, "a held promotion must not send");
  await fire("承認待ち", "approval-window");
  await press(`document.querySelector('.rail-approvals')`, "判断待ち");
  const notice = await until(() => evaluate(`document.querySelector('[data-ask^="notice:promotion:"]')?.textContent ?? null`), "the promotion notice in 判断待ち") as string;
  assert(notice.includes("昇格待ち: v0.0.1（0 時間、動いている Task 1 件）— ヘッダーの「新しい版 →」から昇格できる") && notice.includes("待たずに昇格する"), `notice: ${notice}`);
  if (process.env.SCREENSHOT) writeFileSync(process.env.SCREENSHOT.replace(/\.png$/, "") + "-asks.png", Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await press(`document.querySelector('.new-version')`, "新しい版 → (from 判断待ち)");
  await until(async () => (await panelText()).includes("動いている Task 1 件"), "the 動いている版 section again");
  assert(await evaluate(`document.querySelector('#release').open`), "the section is folded (from 判断待ち)");

  await press(byText("この版を昇格", "#release button"), "この版を昇格 (busy)");
  await until(() => evaluate(`!!(${byText("待たずに昇格する")})`), "the confirmation");
  await Bun.sleep(300);
  assert(promoted.length === 1, "the first press with a running Task must not send");
  await press(byText("待たずに昇格する"), "待たずに昇格する");
  await until(() => promoted.length === 2, "promotion sent after the confirmation");
  assert(promoted[1] === head, `forced promotion sent ${promoted[1]}`);

  // (d) the Task's own screen shows the same section
  // a rail row's title is the Task's title, then its times on the next lines
  const railTask = `[...document.querySelectorAll('.rail .it')].find((b) => b.title.split('\\n')[0] === 'busy task')`;
  if (!(await evaluate(`!!${railTask}`))) await press(`document.querySelector('.rail-tasks')`, "the Task list");
  await press(railTask, "the Task in the rail");
  await until(() => evaluate(`!!document.querySelector('#release-panel') && document.querySelector('#release') === null`), "ReleasePanel in the Brief (the side panel at 1200px)");
  const brief = await evaluate(`document.querySelector('#release-panel').textContent`) as string;
  assert(brief.includes("1 コミット先") && brief.includes("この版を昇格"), `Brief: ${brief}`);

  // (e) sb-rescue now runs HEAD and the daemon restarts: the page reconnects, the mark goes, the section says so
  running = head;
  await fetch(`${base}/api/tasks/${task.id}/abort`, { method: "POST" }).catch(() => undefined);
  await core.stop();
  core = await startServer(cfg, [adapter], { port: daemonPort, selfdevChecks: false, dryRunRestart: true });
  await until(async () => (await evaluate(`document.querySelector('.new-version') === null && document.querySelector('.conn')?.textContent.includes('connected')`)) || null, "the mark is gone after reconnecting");
  await press(byText("Settings", ".tabs button"), "Settings");
  await until(async () => (await panelText()).includes("最新の版が動いています"), "最新の版が動いています");
  assert(await evaluate(`${byText("この版を昇格", "#release button")}.disabled`), "ahead 0 must disable the button");

  // (f) a public copy's clone (#4569): origin is a bare copy named like publicSync.target; the new tags are checked first
  const bare = join(home, "fake-org", "pub-copy.git");
  mkdirSync(bare, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  writeFileSync(join(repo, "ops.config.json"), JSON.stringify({ publicSync: { target: "fake-org/pub-copy" } }));
  git("add", "ops.config.json");
  git("commit", "-q", "-m", "chore: the public copy's config");
  git("remote", "add", "origin", bare);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  running = git("rev-parse", "HEAD");
  const pub = join(home, "publisher");
  // the branch that was pushed, not the bare HEAD (it names init.defaultBranch, which may not exist): the tags must descend from what runs
  Bun.spawnSync(["git", "clone", "-q", "--branch", "main", bare, pub]);
  assert(Bun.spawnSync(["git", "-C", pub, "merge-base", "--is-ancestor", running, "HEAD"]).exitCode === 0, "the publisher's clone starts from the running version");
  const release = (tag: string, file: string, body: string) => {
    writeFileSync(join(pub, file), body);
    const g = (...a: string[]) => Bun.spawnSync(["git", "-C", pub, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    g("add", file); g("commit", "-q", "-m", `feat: ${tag}`); g("tag", tag); g("push", "-q", "origin", "HEAD", "--tags");
    return g("rev-parse", "HEAD");
  };
  const releaseInfo = async () => (await (await fetch(`${base}/api/daemon/release`)).json()) as { latestRelease: { tag: string } | null; review: { state: string; findings: unknown[] } | null; hold: { reason: string } | null };
  const stopped = promoted.length;

  // (f1) v1.0.0: backlog-next starts the check (not a promotion); once it says ok the tag is promoted by itself
  closeGate();
  const sha1 = release("v1.0.0", "a.txt", "one\n");
  await fire("バックログを進める (公開側 v1.0.0)", "backlog-next");
  await until(() => checks.length === 1, "the check of v1.0.0 starts");
  assert(promoted.length === stopped, "a tag with no check result must not be promoted");
  await Bun.sleep(400);
  assert(promoted.length === stopped, "a tag with the check still running must not be promoted");
  assert((await releaseInfo()).review?.state === "running", "the check is running");
  assert(checks[0].permissionMode === "plan" && checks[0].cwd.endsWith("/release-review/v1.0.0"), `check: ${JSON.stringify(checks[0])}`);
  assert(checks[0].prompt.includes("diff.patch") && checks[0].prompt.includes(`${running}`) && checks[0].prompt.includes(sha1), "the prompt names the diff and the range");
  openGate();
  await until(() => promoted.length === stopped + 1, "v1.0.0 promoted after the check said ok");
  assert(promoted[stopped] === sha1, `promoted ${promoted[stopped]}`);
  assert(checks.length === 1, "one check for the tag");
  await until(() => !existsSync(checks[0].cwd), "the check's tree is removed");
  running = sha1; // sb-rescue switched

  // (f2) v1.1.0: the check finds a concern; nothing is promoted by itself
  release("v1.1.0", "b.txt", "two\n");
  await fire("バックログを進める (公開側 v1.1.0)", "backlog-next");
  const info = await until(async () => { const i = await releaseInfo(); return i.review?.state === "concern" ? i : null; }, "the concern of v1.1.0");
  assert(info.latestRelease?.tag === "v1.1.0" && info.review?.findings.length === 1, `review: ${JSON.stringify(info.review)}`);
  assert(checks.length === 2 && checks[1].prompt.includes("v1.1.0"), "the second tag has its own check");
  await fire("バックログを進める (公開側 v1.1.0 もう一度)", "backlog-next");
  await Bun.sleep(400);
  assert(promoted.length === stopped + 1 && checks.length === 2, `a concern must not be promoted nor checked again (promoted ${promoted.length - stopped}, checks ${checks.length})`);
  assert((await releaseInfo()).hold?.reason.includes("懸念 1 件"), "hold says the concern");

  // the header marks the tag; the settings section shows the concern, and the button asks first
  // (the page reads the release once per connection, so it is opened again)
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`document.querySelector('.new-version')?.textContent === '新しい版 v1.1.0 →'`), "新しい版 v1.1.0 → in the header");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await press(`document.querySelector('.new-version')`, "新しい版 v1.1.0 →");
  const concern = await until(async () => { const t = await panelText(); return t.includes("懸念あり 1 件") ? t : null; }, "懸念あり 1 件 in the section");
  assert(concern.includes("packages/core/src/exfil.ts: 起動時に process.env を外の URL へ POST している") && concern.includes("確認を通っていない版は自動では上がりません"), `section: ${concern}`);
  assert(await evaluate(`!!(${byText("確かめ直す", "#release button")})`), "the check-again button for a concern");
  await evaluate(`document.getElementById('release').scrollIntoView()`);
  if (process.env.SCREENSHOT) {
    const r = await evaluate(`(() => { const b = document.getElementById('release').getBoundingClientRect(); return { y: b.top + scrollY, height: b.height }; })()`) as { y: number; height: number };
    writeFileSync(process.env.SCREENSHOT.replace(/\.png$/, "") + "-public.png", Buffer.from((await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: r.y, width: 390, height: Math.min(r.height, 1800), scale: 1 } })).data, "base64"));
  }
  assert(!(await panelText()).includes("昇格を依頼"), "no promotion asked yet");
  await call("Emulation.clearDeviceMetricsOverride");

  // the dialog lists the concern; Cancel sends nothing, OK sends the tag
  answer = false;
  await press(byText("懸念を見たうえで更新する（v1.1.0）", "#release button"), "懸念を見たうえで更新する");
  await until(() => dialogs.length === 1, "the dialog (cancel)");
  await Bun.sleep(300);
  assert(promoted.length === stopped + 1, "Cancel in the dialog must not promote");
  answer = true;
  await press(byText("懸念を見たうえで更新する（v1.1.0）", "#release button"), "懸念を見たうえで更新する (OK)");
  await until(() => promoted.length === stopped + 2, "v1.1.0 promoted after OK in the dialog");
  assert(promoted[stopped + 1] === "v1.1.0", `promoted ${promoted[stopped + 1]}`);
  assert(dialogs.length === 2 && dialogs[1].includes("v1.1.0") && dialogs[1].includes("packages/core/src/exfil.ts") && dialogs[1].includes("起動時に process.env を外の URL へ POST している"), `dialog: ${dialogs[1]}`);

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ mark, section: ahead.slice(0, 80), notice: notice.slice(0, 80), promoted: promoted.length, checks: checks.length, dialog: dialogs[1]?.slice(0, 40), brief: brief.slice(0, 60) }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rescue.stop(true);
  rmSync(home, { recursive: true, force: true });
}
