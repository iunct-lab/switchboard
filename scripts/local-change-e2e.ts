/**
 * `bun scripts/local-change-e2e.ts` (#2491): a workspace without GitHub and without a remote goes from a request to a
 * merge on a fake-runner daemon, with no call to GitHub. A request, a PBI and its Task are made through the API; the
 * PBI's 実装 is started and its first prompt must choose local changes (#2490); the Task's branch gets two commits and a
 * change (#2485) with a `[claude] review` summary and a triage table; then, as a Task would, `scripts/local-ci.ts
 * --change` (#2488), `scripts/merge-gate.ts --change` (#2487) and `scripts/local-merge.ts` (#2489) run as child
 * processes with BACKLOG_URL / BACKLOG_WORKSPACE, with a `gh` first on PATH that records any call and fails.
 * Checked: main has the two commits in order and no merge commit, the branch is gone, the change is closed with its
 * merge commit, the Task is closed and the PBI's done count is 1, and `gh` was never called. Prints each stage and `ok`.
 * SCREENSHOT=<file.png> (after `bun run --cwd apps/web build`, with Chrome: CHROME_BIN) also saves the Backlog screen
 * with the change opened (#2486). Its temporary directory is removed at the end.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, RunnerAdapter, Workspace } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const W = mkdtempSync(join(tmpdir(), "switchboard.e2e."));
const repoRoot = join(import.meta.dir, "..");
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const step = (s: string) => console.log(`✓ ${s}`);

// a gh that is never to be called: it writes down its arguments and fails
const bin = join(W, "bin");
mkdirSync(bin);
const ghCalls = join(W, "gh-calls");
writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${ghCalls}'\nexit 1\n`);
chmodSync(join(bin, "gh"), 0o755);

// the repository: no remote; its CI is one step
const repo = join(W, "repo");
mkdirSync(join(repo, ".github/workflows"), { recursive: true });
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgSign=false", ...a]);
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
git("init", "-q", "-b", "main");
writeFileSync(join(repo, ".github/workflows/ci.yml"), "jobs:\n  check:\n    steps:\n      - run: test -f a.txt\n");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

const prompts: string[] = [];
const runner: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    prompts.push(opts.prompt);
    queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
  },
};
const home = join(W, "home");
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_CANDIDATE: "1" });
// the daemon's gh: recorded with where it ran, and refused (its PATH also has the recording gh first, for a direct
// spawn). The daemon still reads its own meta workspace from GitHub (its checkout, the API budget): that is not this
// workspace's, and only calls for this workspace's checkout are counted
const daemonGh: Array<{ args: string[]; cwd: string | undefined }> = [];
process.env.PATH = `${bin}:${process.env.PATH}`;
const core = await startServer(cfg, [runner], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: async (args, cwd) => { daemonGh.push({ args, cwd }); throw new Error("gh called"); } });
const base = `http://127.0.0.1:${core.server.port}`;
const api = `${base}/api/backlog`;
let failed = false;
try {
  const send = async (method: string, path: string, body: object) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await r.json()) as any;
    assert(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const ws = (await send("POST", "/api/workspaces", { path: repo, backlog: "switchboard" })) as Workspace;
  const create = async (input: object) => ((await send("POST", "/api/backlog", { workspaceId: ws.id, ...input })).number as number);
  const view = async (n: number) => (await (await fetch(`${api}/${n}?workspaceId=${ws.id}`)).json()) as BacklogIssueDetail;

  // request → PBI → Task
  const req = await create({ title: "要望: e2e", labels: ["type:request"], body: "## 原文\n\nローカルでマージしたい" });
  const pbi = await create({ title: "PBI: e2e", labels: ["type:pbi"], body: `## 元要望\n#${req}`, fields: { Status: "Ready" } });
  const task = await create({ title: "Task: e2e", labels: ["type:task"], parent: pbi, body: "## 親 PBI\n#" + pbi });
  step(`要望 #${req} → PBI #${pbi} → Task #${task}`);

  // the PBI's 実装: its first prompt chooses local changes
  await send("POST", `/api/backlog/${pbi}/start`, { workspaceId: ws.id, action: "complete" });
  for (let i = 0; !prompts.length && i < 400; i++) await Bun.sleep(10);
  const prompt = prompts.at(-1) ?? "";
  assert(prompt.includes("この workspace の変更はアプリに置く") && prompt.includes("scripts/local-merge.ts <変更>"), "the stage prompt does not choose local changes");
  // what the stage Task does first (pbi-complete's 2): the fake runner does nothing, so the E2E stands in for it
  await send("PATCH", `/api/backlog/${pbi}`, { workspaceId: ws.id, fields: { Status: "In progress" } });
  step("実装の指示はローカルの変更（localForge）");

  // the Task's branch, two commits, and its change
  const branch = `sb/${task}-e2e`;
  git("checkout", "-q", "-b", branch);
  for (const name of ["b", "c"]) {
    writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `add ${name}`);
  }
  git("checkout", "-q", "main");
  const change = await create({ title: "Task e2e の変更", body: `Backlog-Task: ${task}\n\nb と c を足す`, change: { head: branch, base: "main" } });
  await send("POST", `/api/backlog/${task}/comment`, { workspaceId: ws.id, text: `変更: #${change}` });
  await send("POST", `/api/backlog/${change}/comment`, { workspaceId: ws.id, text: "[claude] review\n\n### Intent and design\nb と c を足すだけ。\n### Security / License / Personal data\n- security: none\n- license: none\n- personal data: none" });
  await send("POST", `/api/backlog/${change}/comment`, { workspaceId: ws.id, text: "## レビュー対応\n| 指摘（引用） | 振り分け | 返信 |\n|---|---|---|\n| なし | — | — |" });
  step(`変更 #${change}（${branch} → main）とレビューの要約・振り分け`);

  // as a Task runs them: in the checkout, with the app's address and workspace, gh first on PATH
  const env = { ...process.env, BACKLOG_URL: api, BACKLOG_WORKSPACE: ws.id, SWITCHBOARD_SUPERVISED: "" };
  const run = async (args: string[]) => {
    const p = Bun.spawn(["bun", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: `${out}${err}` };
  };
  const ci = await run([join(repoRoot, "scripts/local-ci.ts"), "--change", String(change)]);
  assert(ci.code === 0, `local-ci exit ${ci.code}:\n${ci.out}`);
  assert((await view(change)).comments.some((c) => c.body.startsWith(`[local-ci] pass ${git("rev-parse", branch)} base=${git("rev-parse", "main")}`)), "no local-ci pass mark on the change");
  step("local-ci --change: pass の印が変更に付いた");
  const gate = await run([join(repoRoot, "scripts/merge-gate.ts"), "--change", String(change)]);
  assert(gate.code === 0 && gate.out.includes('"verdict": "merge"'), `merge-gate exit ${gate.code}:\n${gate.out}`);
  step("merge-gate --change: merge");

  if (process.env.SCREENSHOT) {
    await screenshot(`${base}/backlog`, change, process.env.SCREENSHOT);
    step(`画面: ${process.env.SCREENSHOT}`);
  }

  const merge = await run([join(repoRoot, "scripts/local-merge.ts"), String(change)]);
  assert(merge.code === 0, `local-merge exit ${merge.code}:\n${merge.out}`);
  const subjects = git("log", "--format=%s", "main").split("\n");
  assert(JSON.stringify(subjects) === JSON.stringify(["add c", "add b", "init"]), `main: ${subjects.join(", ")}`);
  assert(git("rev-list", "--merges", "main") === "", "a merge commit on main");
  assert(!git("branch", "--format=%(refname:short)").split("\n").includes(branch), "the branch is still there");
  const merged = await view(change);
  assert(merged.issue.state === "CLOSED" && merged.issue.change?.mergeCommit === git("rev-parse", "main"), `change: ${JSON.stringify(merged.issue)}`);
  assert((await view(task)).issue.state === "CLOSED", "the Task is open");
  const item = ((await (await fetch(api)).json()) as Backlog).items.find((i) => i.workspaceId === ws.id && i.number === pbi);
  assert(item?.tasks?.done === 1, `PBI tasks: ${JSON.stringify(item?.tasks)}`);
  step(`local-merge: main ${subjects.length - 1} コミット（マージコミットなし）、枝なし、変更 CLOSED（${merged.issue.change!.mergeCommit!.slice(0, 7)}）、Task #${task} CLOSED、PBI の Task ${item!.tasks!.done}/${item!.tasks!.total}`);

  assert(!existsSync(ghCalls), `gh was called: ${existsSync(ghCalls) ? readFileSync(ghCalls, "utf8") : ""}`);
  const forThis = daemonGh.filter((c) => c.cwd === repo);
  assert(forThis.length === 0, `the daemon called gh for this workspace: ${JSON.stringify(forThis)}`);
  step(`gh の呼び出し 0 回（この workspace。デーモンが自分のメタの workspace に ${daemonGh.length} 回）`);
  console.log("ok");
} catch (e) {
  failed = true;
  console.error(`✗ ${(e as Error).message}`);
} finally {
  await core.stop();
  rmSync(W, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/** The Backlog screen with the change opened, by headless Chrome (CDP), saved to `file`. */
async function screenshot(url: string, change: number, file: string) {
  const profile = join(W, "chrome");
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--window-size=1280,1400", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const until = async <T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v as NonNullable<T>;
      await Bun.sleep(100);
    }
    throw new Error(`Timeout: ${label}`);
  };
  try {
    const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
    const page = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("CDP socket failed")); });
    let seq = 0;
    const pending = new Map<number, (v: any) => void>();
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id) pending.get(m.id)?.(m.result), pending.delete(m.id);
    };
    const call = (method: string, params: object = {}) => new Promise<any>((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
    await call("Page.navigate", { url });
    await until(() => evaluate(`!!document.querySelector('.change-row[data-change="${change}"]')`), "the change's row");
    await evaluate(`document.querySelector('.change-row[data-change="${change}"]').click()`);
    await until(() => evaluate(`!!document.querySelector('.change-detail .change-marks') && document.querySelectorAll('.change-comment').length >= 3`), "the change's detail");
    const marks = await evaluate(`document.querySelector('.change-detail .change-marks').textContent`);
    assert(String(marks).includes("最新のレビュー: claude") && String(marks).includes("local-ci 合格"), `marks: ${marks}`);
    await evaluate(`document.querySelector('.backlog-changes').scrollIntoView()`);
    await Bun.write(file, Buffer.from((await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).data, "base64"));
    ws.close();
  } finally {
    chrome.kill();
  }
}
