/**
 * Run after `bun run --cwd apps/web build`: bun scripts/backlog-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The daemon's `gh` answers from packages/core/fixtures/backlog-graphql.json (the meta workspace, acme/app) and
 * backlog-graphql-2.json (a second registered workspace, acme/lib; #294), so no GitHub access is needed.
 * SCREENSHOT=<file.png> also saves what the screen looked like.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { importing, sending } from "../packages/core/fixtures/github-import.ts";
import type { RunnerAdapter } from "@switchboard/protocol";
import { releaseBody } from "./parallel-guard.ts";

const fixtures = join(import.meta.dir, "..", "packages", "core", "fixtures");
const pages = JSON.parse(readFileSync(join(fixtures, "backlog-graphql.json"), "utf8")) as Array<{ data: { repository: { issues: { nodes: Array<{ number: number; labels: { nodes: Array<{ name: string }> } }> } } } }>;
const decisions = JSON.parse(readFileSync(join(fixtures, "backlog-decisions.json"), "utf8")) as { data: { repository: Record<string, { subIssues?: { nodes: Array<{ number: number; labels: { nodes: Array<{ name: string }> } }> } }> } };
const libPage = readFileSync(join(fixtures, "backlog-graphql-2.json"), "utf8");
// a request in acme/lib, answered only while the backlog-next step runs (#561): lib then has an item for each slot
const libWithRequest = (() => {
  const page = JSON.parse(libPage) as { data: { repository: { issues: { nodes: Array<Record<string, unknown>> } } } };
  page.data.repository.issues.nodes.push({ number: 308, title: "lib の要望", url: "https://github.com/acme/lib/issues/308", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", body: "## 原文\n\n元の文\n\n## 派生 PBI\n（まだ無い）", labels: { nodes: [{ name: "type:request" }] }, subIssuesSummary: { total: 0, completed: 0 }, projectItems: { nodes: [] } });
  return JSON.stringify(page);
})();
let libRequest = false;
/** The open PRs of acme/app (#1044): `{ number, files, headRefName? }`. */
let openPulls: Array<Record<string, unknown>> = [];
const home = mkdtempSync(join(tmpdir(), "sb-backlog-e2e-"));
const libDir = join(home, "lib");
mkdirSync(libDir);
let failing = false;
let delayMs = 0; // GitHub being slow (#441)
let writeDelayMs = (_cwd: string) => 0;
let graphqlCalls = 0;
const issueWrites: string[][] = [];
/** The states of the PRs / Issues a PBI waits for (#817), as `issueOrPullRequest` answers; a number not here is not found. */
const waitStates: Record<string, { __typename: string; state: string; stateReason?: string; parent?: { number: number }; body?: string; headRefName?: string }> = {};
const gh: GhRunner = async (args, cwd) => {
  if (failing) return { code: 1, stdout: "", stderr: "gh auth login が必要です" };
  if (args[0] === "repo") return { code: 0, stdout: cwd === libDir ? "acme/lib\n" : "acme/app\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args[0] === "issue") {
    issueWrites.push(args);
    await Bun.sleep(writeDelayMs(cwd));
    // Like GitHub: once the label is off, the item is no longer needs-decision.
    if (args.includes("--remove-label")) {
      for (const p of pages) for (const n of p.data.repository.issues.nodes) if (String(n.number) === args[2]) n.labels.nodes = n.labels.nodes.filter((l) => l.name !== "needs-decision");
      for (const i of Object.values(decisions.data.repository)) for (const t of i.subIssues?.nodes ?? []) if (String(t.number) === args[2]) t.labels.nodes = t.labels.nodes.filter((l) => l.name !== "needs-decision");
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  graphqlCalls++;
  await Bun.sleep(delayMs);
  if (cwd === libDir) return { code: 0, stdout: args.some((a) => a.includes("comments(last:")) ? '{"data":{"repository":{"i306":{"comments":{"nodes":[]}},"i304":{"comments":{"nodes":[]}}}}}' : libRequest ? libWithRequest : libPage, stderr: "" };
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: JSON.stringify({ data: { repository: waitStates } }), stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
delete process.env.SWITCHBOARD_PROJECT_URL;

// Stays running: a started stage Task keeps its row at 実行中 (#265).
const prompts: string[] = [];
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  models: [{ value: "m-e2e", label: "m-e2e" }],
  start(opts, emit) {
    prompts.push(opts.prompt);
    // waits on an approval, so the backlog's 承認待ち N 件 has something to count
    queueMicrotask(() => emit({ t: "permission.ask", id: `perm-e2e-${prompts.length}`, kind: "exec", tool: "Bash", input: { command: "ls" }, detail: "ls" }));
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};
// Releases (#626): the meta checkout is tagged v0.1.0 and a fake sb-rescue runs that commit, so no promotion waits
// until the last step tags v0.2.0.
const repo = join(home, "app");
mkdirSync(repo);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "feat: first (#1)");
git("tag", "v0.1.0");
const running = git("rev-parse", "HEAD");
const releaseHistory: Array<{ ts: number; action: string; from: string | null; to: string | null; ok: boolean; reason: string }> = [];
const promoted: string[] = [];
const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/api/status") return Response.json({ current: running, previous: null, state: "running", busy: null, lastError: null, history: releaseHistory });
  if (url.pathname === "/api/promote") { promoted.push(((await req.json()) as { commit: string }).commit); return Response.json({ started: "promote" }, { status: 202 }); }
  return new Response("no", { status: 404 });
} });
const rescueUrl = `http://127.0.0.1:${rescue.port}`;
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: rescueUrl });
const core = await startServer(cfg, [adapter, { ...adapter, id: "codex" }], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(sending(gh), () => openPulls) });
const base = `http://127.0.0.1:${core.server.port}`;
await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: libDir, name: "lib" }) });
await fetch(`${base}/api/backlog?refresh=1`); // both workspaces imported before the screen first reads what is stored (#885)
const metaName = core.db.listWorkspaces().find((w) => w.kind === "meta")!.name;
const libId = core.db.listWorkspaces().find((w) => w.name === "lib")!.id;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,1400", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  // the port file can come before the page: wait for the page in /json/list
  const pageUrl = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  ws = new WebSocket(pageUrl);
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
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  /**
   * Presses the button `find` (a JS expression) returns, once it has stayed where it is: a line that arrives later
   * (承認待ち N 件 →) moves the rows, and a click between measuring and pressing lands on whatever moved in. So
   * measure, wait 100ms, measure again, and press only when the point is the same and still hits the button.
   */
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
  const click = (label: string) => press(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`, `clickable ${label}`);
  /** The backlog's workspace switch: its buttons read "<name> <count>". */
  const tab = (name: string) => press(`[...document.querySelectorAll('.backlog-ws button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(name + " ")}))`, `workspace tab ${name}`);
  /** Back on the backlog, the last list shows first (#441); read = the new one has replaced it. */
  const read = `!!document.querySelector('.backlog') && !document.querySelector('.backlog .head .hint')?.textContent.includes('読み込み中')`;
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");

  await click("Backlog");
  await until(() => evaluate(`document.querySelectorAll('.backlog section[data-stage]').length === 5`), "stage cards");
  // no promotion waits: the newest tag is what runs
  assert(!(await evaluate(`!!document.querySelector('.backlog .promotion')`)), "no promotion line while the newest tag runs");
  const columns = await evaluate(`Object.fromEntries([...document.querySelectorAll('.backlog section[data-stage]')].map(s => [s.dataset.stage, [...s.querySelectorAll('.backlog-item a')].map(a => a.textContent.split(' ')[0])]))`) as Record<string, string[]>;
  // acme/lib's Ready #304 and 判断待ち #306 sit next to acme/app's (#294); the workspaces come repo first, meta last;
  // in a workspace the newest created first (#885)
  const expected = { "needs-decision": ["#306", "#306"], request: ["#302"], "needs-tasks": ["#303"], ready: ["#304", "#304"], "in-progress": ["#305", "#307", "#308"] };
  assert(JSON.stringify(columns) === JSON.stringify(expected), `columns: ${JSON.stringify(columns)}`);
  const row = await evaluate(`(() => { const r = [...document.querySelectorAll('section[data-stage="in-progress"] .backlog-item')].find(r => r.querySelector('a').href.endsWith('/305')); const a = r.querySelector('a'); return { text: r.textContent, href: a.href, target: a.target, rel: a.rel }; })()`);
  assert(row.text.includes("PBI: 実装中の PBI") && row.text.includes("Task 1/3") && row.text.includes("SP 5 · P0"), `row: ${row.text}`);
  assert(row.href === "https://github.com/acme/app/issues/305" && row.target === "_blank" && row.rel === "noreferrer", `link: ${JSON.stringify(row)}`);
  assert(!(await evaluate(`document.querySelector('section[data-stage="request"] .backlog-item').textContent.includes('Task')`)), "a request has no Task count");
  // each row names its workspace, and every workspace's rows have their stage buttons
  const readyRows = (await evaluate(`[...document.querySelectorAll('section[data-stage="ready"] .backlog-item')].map(r => ({ ws: r.querySelector('.workspace')?.textContent, href: r.querySelector('a').href, buttons: [...r.querySelectorAll('button')].map(b => b.textContent) }))`) as Array<{ ws: string; href: string; buttons: string[] }>).sort((a, b) => a.href.localeCompare(b.href));
  const workspaceNames = readyRows.map((r) => r.ws);
  assert(JSON.stringify(readyRows) === JSON.stringify([
    { ws: metaName, href: "https://github.com/acme/app/issues/304", buttons: ["実装する"] },
    { ws: "lib", href: "https://github.com/acme/lib/issues/304", buttons: ["実装する"] },
  ]), `ready rows: ${JSON.stringify(readyRows)}`);
  // acme/lib's 判断待ち has its own answer box too (the answer names its workspace)
  const libDecision = await evaluate(`(() => { const c = [...document.querySelectorAll('section[data-stage="needs-decision"] .decision-card')].find(c => c.querySelector('a').href.includes('/acme/lib/')); return { textarea: !!c.querySelector('textarea'), button: !!c.querySelector('button'), text: c.textContent }; })()`) as { textarea: boolean; button: boolean; text: string };
  assert(libDecision.textarea && libDecision.button && libDecision.text.includes("lib"), `lib decision: ${JSON.stringify(libDecision)}`);

  // the workspace switch: すべて / each workspace with its count; one workspace shows its rows only, and stays chosen
  const wsTabs = await evaluate(`[...document.querySelectorAll('.backlog-ws button')].map(b => b.textContent.trim())`) as string[];
  assert(JSON.stringify([...wsTabs].sort()) === JSON.stringify(["すべて 9", "lib 2", `${metaName} 7`].sort()) && wsTabs[0] === "すべて 9", `tabs: ${JSON.stringify(wsTabs)}`);
  await tab(metaName);
  await until(() => evaluate(`[...document.querySelectorAll('.backlog .backlog-item a')].every(a => a.href.includes('/acme/app/')) && document.querySelectorAll('section[data-stage="ready"] .backlog-item').length === 1`), "meta rows only");
  const workspaceSwitch = wsTabs.length;

  const before = graphqlCalls;
  await click("再読込");
  await until(() => graphqlCalls > before, "再読込 asks GitHub again");

  await click("要望を登録");
  await until(() => evaluate(`!!document.querySelector('dialog.feedback-dialog[open]')`), "feedback dialog");
  const feedbackOpened = true;
  // the dialog's own: #307's row has a 閉じる too (#531)
  await press(`[...document.querySelectorAll('dialog.feedback-dialog[open] button')].find(b => b.textContent.trim() === "閉じる")`, "the dialog's 閉じる");

  // A row's stage button (#265): Ready → 実装する → the Task screen → back on the backlog the row says 実行中
  const buttons = await evaluate(`Object.fromEntries([...document.querySelectorAll('.backlog section[data-stage]')].map(s => [s.dataset.stage, [...s.querySelectorAll('.backlog-item button')].map(b => b.textContent)]))`) as Record<string, string[]>;
  const expectedButtons = { "needs-decision": [], request: ["PBI にする"], "needs-tasks": ["Task に分解"], ready: ["実装する"], "in-progress": ["状況を確認", "状況を確認", "閉じる", "状況を確認"] };
  assert(JSON.stringify(buttons) === JSON.stringify(expectedButtons), `buttons: ${JSON.stringify(buttons)}`);
  await click("実装する");
  const startedTitle = await until(() => evaluate(`document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].map(e => e.textContent.trim()).find(t => t.startsWith('#304 実装: ')) ?? null`), "Task screen");
  assert(prompts[0]?.includes("/pbi-complete 304"), `prompt: ${prompts[0]}`);
  await click("Backlog");
  // the screen first shows the list from before the start, not yet loading (`read` holds for that frame): wait for 実行中
  await until(() => evaluate(`${read} && [...document.querySelectorAll('section[data-stage="ready"] .backlog-item button')].some(b => b.textContent === '実行中')`), "backlog again with the row 実行中");
  const readyButtons = await evaluate(`[...document.querySelectorAll('section[data-stage="ready"] .backlog-item button')].map(b => b.textContent)`) as string[];
  const rowShowsRunning = JSON.stringify(readyButtons) === JSON.stringify(["実行中"]);
  assert(rowShowsRunning, `ready row: ${JSON.stringify(readyButtons)}`);
  // the started Task waits on an approval: 承認待ち 1 件 → opens the Schedules screen (its queue), then back
  await until(() => evaluate(`[...document.querySelectorAll('.backlog button')].some(b => b.textContent.trim() === '承認待ち 1 件 →')`), "承認待ち 1 件");
  await click("承認待ち 1 件 →");
  await until(() => evaluate(`!document.querySelector('.backlog')`), "承認待ち opens Schedules");
  await click("Backlog");
  await until(() => evaluate(`${read} && !!document.querySelector('section[data-stage="ready"] .backlog-item') && [...document.querySelectorAll('.backlog button')].some(b => b.textContent.trim() === '承認待ち 1 件 →')`), "backlog after 承認待ち");
  const approvalsLink = true;
  await click("実行中");
  await until(() => evaluate(`!document.querySelector('.backlog')`), "実行中 opens the Task");
  await click("Backlog");
  await until(() => evaluate(`${read} && !!document.querySelector('section[data-stage="ready"] .backlog-item')`), "backlog once more");

  // 判断待ち (#266): the question as plain text, an answer → ## 回答 + label off → the item leaves the column
  const question = await evaluate(`document.querySelector('section[data-stage="needs-decision"] pre.wrap')?.textContent ?? ""`) as string;
  const decisionShown = question.startsWith("## 判断待ち\n**問い**: 保存先をどちらにするか") && question.includes("- B: ファイル");
  assert(decisionShown, `question: ${question}`);
  if (process.env.SCREENSHOT) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  await evaluate(`document.querySelector('section[data-stage="needs-decision"] textarea').focus()`);
  await call("Input.insertText", { text: "B で。移行は不要" });
  await click("回答する");
  // only acme/app's #306 leaves; acme/lib's #306 (same number) stays
  await until(() => evaluate(`document.querySelectorAll('section[data-stage="needs-decision"] .backlog-item a').length === 0`), "answered item leaves");
  await tab("すべて");
  await until(() => evaluate(`(() => { const links = [...document.querySelectorAll('section[data-stage="needs-decision"] .backlog-item a')].map(a => a.href); return links.length === 1 && links[0] === 'https://github.com/acme/lib/issues/306'; })()`), "the other workspace's stays");
  // kept at once, then sent to GitHub (#886): the comment, then the label off
  await until(() => issueWrites.length >= 2 || null, "the answer sent");
  const ghCalls = issueWrites.map((a) => a.slice(0, 3).join(" ") + (a.includes("--remove-label") ? " --remove-label " + a[a.indexOf("--remove-label") + 1] : ""));
  const answered = JSON.stringify(issueWrites[0]) === JSON.stringify(["issue", "comment", "306", "-R", "acme/app", "--body", "## 回答\n\nB で。移行は不要"]) && ghCalls[1] === "issue edit 306 --remove-label needs-decision";
  assert(answered, `gh: ${JSON.stringify(issueWrites)}`);

  // 実装中 (#522): each row says whether it moves, its Project Status, how long since the Issue changed, its last stage
  // Task, and the head of its newest ## 状況; 状況を確認 starts a check and the row turns 実行中
  const ipRow = (n: number) => `[...document.querySelectorAll('section[data-stage="in-progress"] .backlog-item')].find(r => r.querySelector('a').href === 'https://github.com/acme/app/issues/${n}')`;
  const clickIn = (rowExpr: string, prefix: string) => press(`[...(${rowExpr})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith(${JSON.stringify(prefix)}))`, `clickable ${prefix}`);
  const rowText = (n: number) => evaluate(`${ipRow(n)}?.textContent ?? ""`) as Promise<string>;
  // (a) #305: In review, and the newest ## 状況 — its date and first 3 lines after the heading, the rest cut
  const report = await evaluate(`(() => { const r = ${ipRow(305)}.nextElementSibling; return r?.classList.contains('backlog-report') ? { at: r.querySelector('.hint').textContent, head: r.querySelector('pre').textContent } : null; })()`) as { at: string; head: string } | null;
  const n305 = await rowText(305);
  assert(n305.includes("In review") && report?.at === `${new Date("2026-09-27T05:00:00Z").toLocaleString()} の状況` && report.head === "### 済んだこと\n- #310 をマージ\n### 残り\n…", `#305: ${n305} ${JSON.stringify(report)}`);
  // (b) #307: every Task done with the PBI open, and days since its last update; no ## 状況 → nothing under the row
  const n307 = await rowText(307);
  assert(n307.includes("In progress") && n307.includes("止まっている: Task は全部完了、PBI は開いたまま") && /更新 \d+ 日前/.test(n307) && !(await evaluate(`${ipRow(307)}.nextElementSibling?.classList.contains('backlog-report') ?? false`)), `#307: ${n307}`);
  // #531: every Task closed and no 利用者確認 left → 閉じられる, and a 閉じる next to 状況を確認 (pressed below)
  const closableShown = n307.includes("閉じられる") && !(await rowText(305)).includes("閉じられる") && !(await rowText(308)).includes("閉じられる");
  assert(closableShown, `閉じられる: #307 ${n307}`);
  const stoppedState = await evaluate(`${ipRow(307)}.querySelector('[data-state]').dataset.state`);
  assert(stoppedState === "stopped" && n305.includes("止まっている: 工程 Task なし"), `states: ${stoppedState} / ${n305}`);
  // (c) a finished stage Task of #305 → 最後の Task: 完了, which opens that Task
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const finishedAt = Date.now() - 3 * 60 * 60_000;
  const finished = core.db.insertTask({ id: "task_e2e305", workspaceId: meta.id, title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: meta.path, scope: [meta.path], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, stage: { issue: 305, action: "complete" }, statusAt: finishedAt, createdAt: finishedAt, updatedAt: finishedAt });
  await click("再読込");
  await until(() => evaluate(`${read} && (${ipRow(305)}?.textContent ?? "").includes("最後の Task: 完了 3 時間前")`), "#305 last Task");
  const lastTaskShown = (await rowText(305)).includes("止まっている: 最後の工程 Task は完了");
  assert(lastTaskShown, `#305 after its Task: ${await rowText(305)}`);
  await clickIn(ipRow(305), "最後の Task:");
  await until(() => evaluate(`document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].some(e => e.textContent.trim().startsWith('#305 実装: '))`), "the last Task's screen");
  await click("Backlog");
  // the 承認待ち link (read after the list) pushes the rows down when it arrives: click after it is there
  await until(() => evaluate(`${read} && !!(${ipRow(307)}) && [...document.querySelectorAll('.backlog button')].some(b => b.textContent.trim().startsWith('承認待ち'))`), "backlog after the last Task");
  // 待ち (#817, #1046): #307 stopped on an overlap with PR #778 and Task #30501 of #305, which itself waits for PR #779.
  // The line under the row names them with their states and links, how it comes undone, and whether backlog-next goes
  // on by itself (an enabled バックログを進める); the chain folds under a <details>
  const comments = (n: number) => ((decisions.data.repository[`i${n}`] as { comments: { nodes: Array<{ body: string; createdAt: string }> } }).comments.nodes);
  // after #305's 実装 above: an 実装 started after the waits would make them old (#817)
  let at = Date.now();
  const release = (n: number, reason: string, waits: number[] = [], overlap = false) => comments(n).push({ body: releaseBody(reason, waits, overlap), createdAt: new Date((at += 60_000)).toISOString() });
  release(307, "後回し: #30x（PR #778 と重なる）", [778, 30501], true);
  release(305, "後回し: #31x（前提 PR #779）", [779]);
  Object.assign(waitStates, { w778: { __typename: "PullRequest", state: "OPEN" }, w779: { __typename: "PullRequest", state: "OPEN" }, w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } } });
  const sweep = (await (await fetch(`${base}/api/schedules`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "待ちの E2E", cron: "0 0 1 1 *", workspaceId: meta.id, runner: "claude", prompt: "", action: "backlog-next", enabled: true }) })).json()) as { id: string };
  const waitsOf = (n: number) => `document.querySelector('.backlog-waits[data-issue="https://github.com/acme/app/issues/${n}"]')`;
  const waitsText = (n: number) => evaluate(`${waitsOf(n)}?.textContent ?? ""`) as Promise<string>;
  /** Back on the backlog (it reads the schedules when opened) and 再読込 until #307's line says `text`. */
  const waitsSay = async (text: string, label: string) => {
    await click("Schedules");
    await until(() => evaluate(`!!document.querySelector('main.schedules')`), "Schedules");
    await click("Backlog");
    await until(() => evaluate(read), "backlog");
    await click("再読込");
    return until(async () => ((await waitsText(307)).includes(text) ? waitsText(307) : null), label);
  };
  const open307 = await waitsSay("待ち: PR #778（開いている） ← 不明・#30501（開いている） ← #305 PBI: 実装中の PBI の Task task_e2e305", "#307 waits");
  const links307 = await evaluate(`[...${waitsOf(307)}.children[0].querySelectorAll('a')].map(a => [a.textContent, a.href, a.target].join(' '))`) as string[];
  assert(open307.includes("相手が閉じてファイルの重なりが解けたら") && open307.includes("次の定期実行で再開") && JSON.stringify(links307) === JSON.stringify(["PR #778 https://github.com/acme/app/pull/778 _blank", "#30501 https://github.com/acme/app/issues/30501 _blank", "#305 PBI: 実装中の PBI https://github.com/acme/app/issues/305 _blank"]), `#307 waits: ${open307} ${JSON.stringify(links307)}`);
  await evaluate(`${waitsOf(307)}.querySelector('details').open = true`);
  const chain307 = await evaluate(`${waitsOf(307)}.querySelector('details').textContent`) as string;
  assert(chain307.includes("待ちの先（1）") && chain307.includes("#30501 の先: #305 が待つ PR #779（開いている）"), `chain: ${chain307}`);
  // 相手の PBI (#1045): PR #778 closes #30501 of #305, whose stage Task task_e2e305 has stopped → its Task opens, and
  // 続きを始める resumes #305 (complete); while that runs the line only opens it, with no second start
  Object.assign(waitStates.w778!, { body: "Closes #30501", headRefName: "sb/30501-link" });
  const owner307 = await waitsSay("PR #778（開いている） ← #305 PBI: 実装中の PBI の Task task_e2e305（止まっている: 完了） 続きを始める", "#307 wait's PBI and its stopped Task");
  const inWaits = (prefix: string) => press(`[...${waitsOf(307)}.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(prefix)}))`, `wait's ${prefix}`);
  const taskScreen = (prefix: string) => `document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].some(e => e.textContent.trim().startsWith(${JSON.stringify(prefix)}))`;
  await inWaits("Task task_e2e305");
  await until(() => evaluate(taskScreen("#305 実装: ")), "the wait's stopped Task screen");
  await click("Backlog");
  await until(() => evaluate(`${read} && !!${waitsOf(307)}`), "backlog after the wait's Task");
  const before305 = core.db.listTasks().filter((t) => t.title.startsWith("#305 実装: ")).length;
  await inWaits("続きを始める");
  await until(() => evaluate(taskScreen("#305 実装: ")), "the resumed Task screen");
  const resumed = core.db.listTasks().filter((t) => t.title.startsWith("#305 実装: ")).find((t) => t.id !== finished.id)!;
  assert(core.db.listTasks().filter((t) => t.title.startsWith("#305 実装: ")).length === before305 + 1 && prompts.at(-1)!.includes("実装中のまま止まっています"), `resume: ${prompts.at(-1)}`);
  await click("Backlog");
  await until(() => evaluate(read), "backlog after the resume");
  await click("再読込");
  const running307 = await until(async () => { const t = await waitsText(307); return t.includes(`Task ${resumed.id}（動いている）`) ? t : null; }, "#307 wait's PBI moving");
  assert(!running307.includes("続きを始める"), `moving: ${running307}`);
  await inWaits(`Task ${resumed.id}`);
  await until(() => evaluate(taskScreen("#305 実装: ")), "the moving Task screen");
  assert(core.db.listTasks().filter((t) => t.title.startsWith("#305 実装: ")).length === before305 + 1, "opening the moving Task started nothing");
  // 390px: the line wraps, every link and button stays on screen and the Task opens
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await click("Backlog");
  await until(() => evaluate(`${read} && !!${waitsOf(307)}`), "backlog at 390px");
  const narrow = await evaluate(`(() => ({ scroll: document.documentElement.scrollWidth, right: Math.max(...[...${waitsOf(307)}.querySelectorAll('a, button')].map(e => e.getBoundingClientRect().right)) }))()`) as { scroll: number; right: number };
  assert(narrow.scroll <= 390 && narrow.right <= 390, `390px: ${JSON.stringify(narrow)}`);
  await inWaits(`Task ${resumed.id}`);
  await until(() => evaluate(taskScreen("#305 実装: ")), "the Task screen at 390px");
  await call("Emulation.clearDeviceMetricsOverride");
  await click("Backlog");
  await until(() => evaluate(read), "backlog back at full width");
  const waitOwner: Record<string, unknown> = { stopped: owner307.includes("止まっている: 完了"), started: resumed.id, moving: !running307.includes("続きを始める"), narrow };
  // backlog-next off: the person's button
  await fetch(`${base}/api/schedules/${sweep.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  const off307 = await waitsSay("定期実行が無効: /pbi-complete 307 を手で始める", "#307 waits with backlog-next off");
  // a number GitHub does not know: 未取得, not taken as closed
  release(307, "後回し: #30x（#999 と重なる）", [778, 999], true);
  const unread307 = await waitsSay("#999（未取得）", "#307 waits for a number not found");
  assert(unread307.includes("PR #778（開いている）") && unread307.includes("未取得の相手は状態が分からない") && unread307.includes("定期実行は再開しない"), `unread: ${unread307}`);
  // all closed, backlog-next on again: 待ちが解けた
  release(307, "後回し: #30x（PR #778 と重なる）", [778], true);
  waitStates.w778!.state = "MERGED";
  await fetch(`${base}/api/schedules/${sweep.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  const done307 = await waitsSay("待ちが解けた: PR #778（完了）", "#307 waits closed");
  // a closed wait still names its PBI and Task (#1045), with no 続きを始める
  assert(done307.includes("次の定期実行で再開") && done307.includes("PR #778（完了） ← #305 PBI: 実装中の PBI の Task") && !done307.includes("続きを始める") && (await evaluate(`${waitsOf(307)}.dataset.done`)) === "true", `done: ${done307}`);
  const waits = { open307, chain: chain307.includes("#305 が待つ"), off: off307.includes("定期実行が無効"), unread: unread307.includes("未取得"), done307 };
  // (d) 状況を確認 on #307, its wait still recorded (#817: the button starts all the same) → its check Task's screen;
  // back on the backlog the row is 実行中 without the button
  await clickIn(ipRow(307), "状況を確認");
  const checkTitle = await until(() => evaluate(`document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].map(e => e.textContent.trim()).find(t => t.startsWith('#307 状況確認: ')) ?? null`), "check Task screen");
  assert(prompts.at(-1)!.includes("PBI #307 の今の状況を確認してください") && core.db.getTask(finished.id)!.status === "done", `check prompt: ${prompts.at(-1)}`);
  await click("Backlog");
  await until(() => evaluate(`${read} && [...(${ipRow(307)})?.querySelectorAll('button') ?? []].some(b => b.textContent.trim() === '実行中')`), "backlog after the check with #307 実行中");
  const checkRow = await evaluate(`(() => { const r = ${ipRow(307)}; return { buttons: [...r.querySelectorAll('button')].map(b => b.textContent.trim()), state: r.querySelector('[data-state]').dataset.state, text: r.textContent }; })()`) as { buttons: string[]; state: string; text: string };
  const checkRunning = JSON.stringify(checkRow.buttons) === JSON.stringify(["実行中"]) && checkRow.state === "running" && checkRow.text.includes("動いている");
  assert(checkRunning, `#307 while checking: ${JSON.stringify(checkRow)}`);
  const inProgress = { report: report!.head.split("\n").length, lastTaskShown, checkTitle, checkRunning, waits };
  // the waits leave with a release without them, and the scene's schedule too: the firing below starts what it did before
  release(307, "完了");
  release(305, "完了");
  await fetch(`${base}/api/schedules/${sweep.id}`, { method: "DELETE" });
  await until(async () => ((await (await fetch(`${base}/api/backlog?refresh=1`)).json()) as { items: Array<{ number: number; waitsAt: string | null }> }).items.every((i) => i.waitsAt === null), "waits cleared");

  // 前提 (#937): #304's body names #940 (an Issue not done), PR #941 (closed unmerged), #942 (GitHub does not know it)
  // and #305, whose body names #304 back (a cycle) → under the meta row 「前提: #940（未完）」 and, in the warning colour,
  // 「進められない: PR #941 取り下げ・#942 見つからない・#305 と循環」, linked; lib's #304 names none and says nothing.
  // #940 completed and #941 merged → the 前提 line leaves; the bodies back as they were → nothing is left
  const nodeOf = (n: number) => pages.flatMap((p) => p.data.repository.issues.nodes).find((x) => x.number === n) as unknown as { body: string };
  const [body304, body305] = [nodeOf(304).body, nodeOf(305).body];
  nodeOf(304).body = `${body304}\n\n**前提**: #940, #941, #942, #305`;
  nodeOf(305).body = `${body305}\n\n**前提**: #304`;
  Object.assign(waitStates, { w940: { __typename: "Issue", state: "OPEN" }, w941: { __typename: "PullRequest", state: "CLOSED" } });
  const prereqsOf = (repo: string) => `document.querySelector('.backlog-prereqs[data-issue="https://github.com/acme/${repo}/issues/304"]')`;
  const prereqsNow = () => evaluate(`(() => { const p = ${prereqsOf("app")}; return p && { lines: [...p.children].map(d => [d.className, d.textContent]), links: [...p.querySelectorAll('a')].map(a => a.href) }; })()`) as Promise<{ lines: string[][]; links: string[] } | null>;
  await click("再読込");
  const prereqLines = await until(async () => { const p = await prereqsNow(); return p?.lines.length === 2 ? p : null; }, "#304 prerequisites");
  const libPrereqs = await evaluate(`!!${prereqsOf("lib")}`);
  const stuckLine = "進められない: PR #941 取り下げ・#942 見つからない・#305 と循環";
  assert(JSON.stringify(prereqLines.lines) === JSON.stringify([["", "前提: #940（未完）"], ["warn", stuckLine]]) && JSON.stringify(prereqLines.links) === JSON.stringify(["https://github.com/acme/app/issues/940", "https://github.com/acme/app/pull/941", "https://github.com/acme/app/issues/942", "https://github.com/acme/app/issues/305"]) && !libPrereqs, `prerequisites: ${JSON.stringify(prereqLines)} lib ${libPrereqs}`);
  Object.assign(waitStates, { w940: { __typename: "Issue", state: "CLOSED", stateReason: "COMPLETED" }, w941: { __typename: "PullRequest", state: "MERGED" } });
  await click("再読込");
  const left = await until(async () => { const p = await prereqsNow(); return p?.lines.length === 1 ? p : null; }, "#304 prerequisites done but the stuck ones");
  assert(JSON.stringify(left.lines) === JSON.stringify([["warn", "進められない: #942 見つからない・#305 と循環"]]), `left: ${JSON.stringify(left)}`);
  [nodeOf(304).body, nodeOf(305).body] = [body304, body305];
  await click("再読込");
  await until(() => evaluate(`${read} && !${prereqsOf("app")}`), "#304 prerequisites gone");
  const prereqs = { lines: prereqLines.lines.map((l) => l[1]), links: prereqLines.links.length, lib: libPrereqs, left: left.lines.map((l) => l[1]), done: true };

  // A backlog-next schedule (#267): + 追加 → 種類「バックログを進める」→ 作成 → 今すぐ実行 → a stage Task and "#N を" in the log.
  // The stage Task started above is still in flight (waiting on its approval) and would make the firing skip, so stop it first.
  const stopAll = async () => {
    for (const t of [...core.db.listTasksByStatus("running"), ...core.db.listTasksByStatus("waiting")]) { // waiting: on its approval
      await fetch(`${base}/api/tasks/${t.id}/abort`, { method: "POST" });
      await until(() => !["running", "waiting"].includes(core.db.getTask(t.id)?.status ?? ""), "stage Task stopped");
    }
  };
  await stopAll();
  // a Ready row's last stage Task (#1045): the meta's #304, started above and stopped → 最後の Task: 中断, which opens it
  const readyRow = (n: number) => `[...document.querySelectorAll('section[data-stage="ready"] .backlog-item')].find(r => r.querySelector('a').href === 'https://github.com/acme/app/issues/${n}')`;
  await click("再読込");
  await until(() => evaluate(`${read} && (${readyRow(304)}?.textContent ?? "").includes("最後の Task: 中断")`), "Ready #304's last Task");
  await clickIn(readyRow(304), "最後の Task:");
  await until(() => evaluate(`document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].some(e => e.textContent.trim().startsWith('#304 実装: '))`), "Ready #304's last Task screen");
  waitOwner.readyLastTask = true;
  await click("Backlog");
  await until(() => evaluate(read), "backlog after Ready #304's last Task");
  // 重なり (#1044): #304's Task names `src/overlap.ts` and an open PR (#950, not its own) changes it → under the row
  // 「重なり: PR #950（src/overlap.ts）」 with the PR linked; the row's 実装する still starts it, with pbi-complete as before
  // (the session's own `overlap` judges); the scheduled firing below leaves it and logs why
  const dec304 = decisions.data.repository.i304 as { subIssues?: unknown };
  dec304.subIssues = { nodes: [{ number: 3041, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: "触る場所: `src/overlap.ts`", comments: { nodes: [] } }] };
  openPulls = [{ number: 950, files: ["src/overlap.ts"], headRefName: "sb/999-x" }];
  const overlapOf = (repo: string) => `document.querySelector('.backlog-overlap[data-issue="https://github.com/acme/${repo}/issues/304"]')`;
  await click("再読込");
  const overlapShown = await until(() => evaluate(`(() => { const o = ${overlapOf("app")}; return o && { text: o.textContent, links: [...o.querySelectorAll('a')].map(a => a.href) }; })()`) as Promise<{ text: string; links: string[] } | null>, "#304's overlap line");
  assert(overlapShown.text === "重なり: PR #950（src/overlap.ts）" && JSON.stringify(overlapShown.links) === JSON.stringify(["https://github.com/acme/app/pull/950"]) && !(await evaluate(`!!${overlapOf("lib")}`)), `overlap: ${JSON.stringify(overlapShown)}`);
  const startedBefore = prompts.length;
  await clickIn(readyRow(304), "実装する");
  await until(() => evaluate(taskScreen("#304 実装: ")), "#304's Task from the button despite the overlap");
  assert(prompts.length === startedBefore + 1 && prompts.at(-1)!.startsWith("/pbi-complete 304"), `overlap button prompt: ${prompts.at(-1)}`);
  await click("Backlog");
  await until(() => evaluate(read), "backlog after the overlapping 実装する");
  // (e) 閉じる on #307 (#531), its check Task stopped above → the close Task's screen, its prompt asks for pbi-complete's
  // step 6; back on the backlog the row is 実行中 without 閉じられる
  // the list still has the check Task as running until it is read again
  await click("再読込");
  await until(() => evaluate(`${read} && [...(${ipRow(307)})?.querySelectorAll('button') ?? []].some(b => b.textContent.trim() === '閉じる')`), "#307 閉じる after its check stopped");
  await clickIn(ipRow(307), "閉じる");
  const closeTitle = await until(() => evaluate(`document.querySelector('.backlog') ? null : [...document.querySelectorAll('h1,h2,h3,h4,h5,.title,.t')].map(e => e.textContent.trim()).find(t => t.startsWith('#307 閉じる: ')) ?? null`), "close Task screen");
  assert(prompts.at(-1)!.includes("pbi-complete/SKILL.md の「6. PBI を閉じる」") && prompts.at(-1)!.includes("PBI #307"), `close prompt: ${prompts.at(-1)}`);
  await click("Backlog");
  await until(() => evaluate(`${read} && [...(${ipRow(307)})?.querySelectorAll('button') ?? []].some(b => b.textContent.trim() === '実行中')`), "backlog after 閉じる with #307 実行中");
  const closeRow = await evaluate(`(() => { const r = ${ipRow(307)}; return { buttons: [...r.querySelectorAll('button')].map(b => b.textContent.trim()), text: r.textContent }; })()`) as { buttons: string[]; text: string };
  assert(JSON.stringify(closeRow.buttons) === JSON.stringify(["実行中"]) && !closeRow.text.includes("閉じられる"), `#307 while closing: ${JSON.stringify(closeRow)}`);
  const closable = closableShown && closeTitle.startsWith("#307 閉じる: ");
  await stopAll();
  // the meta's #304 was updated after its stopped Task (a minute ahead: the Task's row may still be written as its process goes), or backlog-next leaves it (#627)
  for (const p of pages) for (const n of p.data.repository.issues.nodes) if (n.number === 304) (n as { updatedAt?: string }).updatedAt = new Date(Date.now() + 60_000).toISOString();
  // 自動で始まる Task の既定 (#832): the new schedule's form starts from the saved runner and model
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autoStart: { model: "m-e2e" } }) });
  await click("Schedules");
  await until(() => evaluate(`!!document.querySelector('main.schedules')`), "Schedules screen");
  await click("+ 追加");
  await until(() => evaluate(`!!document.querySelector('main.schedules .fields select')`), "the new schedule form");
  const setField = (selector: string, value: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no field ${selector}`)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  await until(() => evaluate(`document.querySelector('main.schedules .fields select[aria-label="モデル"]')?.value === "m-e2e"`), "the form's model starts at the saved default");
  await setField("main.schedules .fields select", "backlog-next");
  await until(() => evaluate(`!!document.querySelector('.backlog-next-hint') && !document.querySelector('main.schedules .fields textarea')`), "hint instead of the prompt box");
  await setField("main.schedules .fields input", "バックログを進める");
  await click("作成");
  await until(async () => ((await (await fetch(`${base}/api/schedules`)).json()) as Array<{ model: string }>).some((x) => x.model === "m-e2e"), "the schedule is saved with the default's model");
  await until(() => evaluate(`[...document.querySelectorAll('main.schedules .tag')].some(t => t.textContent === 'バックログを進める')`), "schedule row with its tag");
  // #307 has every Task closed, so backlog-next would close it first (#578) and take the meta's implement slot: a 閉じる
  // that ended with no update to the Issue since leaves it, as one that did not close
  const closedAt = Date.now();
  core.db.insertTask({ ...core.db.getTask(finished.id)!, id: "task_e2e307close", title: "#307 閉じる: PBI", stage: { issue: 307, action: "close" }, status: "done", createdAt: closedAt, updatedAt: closedAt });
  const tasksBefore = core.db.listTasks().length;
  // two implement slots for this firing: #306 takes the first, and #304 would take the second but for its overlap (#1044)
  const setSweep = (implement: number) => fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ backlogSweep: { implement } }) });
  await setSweep(2);
  libRequest = true;
  await click("今すぐ実行");
  await until(() => core.db.listTasks().length > tasksBefore, "scheduled stage Task");
  // the screen moves to the started Task when the daemon answers, which is after the Task is in the DB: go back after that
  await until(() => evaluate(`!document.querySelector('main.schedules')`), "今すぐ実行 opens the Task");
  await click("Schedules");
  await until(() => evaluate(`!!document.querySelector('main.schedules pre.diff')`), "Schedules screen with its log");
  // one line per workspace and slot (#561): the meta's #306 (in progress with Tasks left since its answer above, so it is
  // resumed before Ready #304: #578) and 分解待ち #303, lib's Ready #304 and 要望 #308
  const expectedStarts = [`${metaName} #306 を complete で開始`, `${metaName} #303 を to-tasks で開始`, "lib #304 を complete で開始", "lib #308 を to-pbi で開始"];
  const scheduleLog = await until(async () => {
    const lines = (await evaluate(`[...document.querySelectorAll('main.schedules pre.diff')].map(p => p.textContent).join('').split('\\n')`) as string[]).filter((l) => l.includes(" で開始 "));
    return expectedStarts.every((e) => lines.some((l) => l.includes(e))) ? lines.map((l) => l.replace(/^\S+ /, "")) : null;
  }, "a log line per workspace and slot");
  libRequest = false;
  // #304 overlaps PR #950: the firing does not start it and the log names the PR; GitHub was not written to for that
  const overlapLog = await evaluate(`[...document.querySelectorAll('main.schedules pre.diff')].map(p => p.textContent).join('')`) as string;
  assert(overlapLog.includes(`${metaName}: 実装の枠: 重なり: #304（PR #950: src/overlap.ts）`), `overlap log: ${overlapLog}`);
  const metaId = core.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
  const startedFor304 = core.db.listTasks().filter((t) => t.scheduleId && t.workspaceId === metaId && t.title.startsWith("#304 実装: "));
  assert(startedFor304.length === 0, `#304 was started by the firing: ${startedFor304.map((t) => t.title).join(" / ")}`);
  await setSweep(1);
  openPulls = [];
  delete dec304.subIssues;
  // one firing starts an implement and a plan stage Task per workspace (#561); the meta's implementation is the resume of
  // #306, which goes on with pbi-complete's SKILL.md and leaves the merge procedure to the skill (#788)
  const scheduled = core.db.listTasks().find((t) => t.scheduleId && t.title.startsWith("#306 実装: ") && t.workspaceId === core.db.listWorkspaces().find((w) => w.kind === "meta")!.id);
  const scheduledPrompt = await until(() => prompts.findLast((p) => p.startsWith("PBI #306 は実装中のまま止まっています")), "the scheduled implementation's prompt");
  assert(scheduled && scheduledPrompt.includes(".claude/skills/pbi-complete/SKILL.md") && !scheduledPrompt.includes("merge-gate"), `scheduled: ${core.db.listTasks().filter((t) => t.scheduleId).map((t) => t.title).join(" / ")}`);

  // the slots per workspace (#561): on the 設定 screen (#839), implement 1 → 2, 保存, and a reload still shows 2
  await click("Settings");
  await until(() => evaluate(`!!document.querySelector('main.settings')`), "設定 screen");
  await until(() => evaluate(`document.querySelector('input[aria-label="実装の枠"]')?.value === "1" && document.querySelector('input[aria-label="計画の枠"]')?.value === "1"`), "slots at their default");
  await setField('input[aria-label="実装の枠"]', "2");
  await click("保存");
  await until(() => evaluate(`document.querySelector('.backlog-sweep')?.textContent.includes('保存済み: 実装 2 · 計画 1')`), "slots saved");
  await call("Page.reload");
  await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail after the reload");
  await click("Settings");
  const slotsAfterReload = await until(() => evaluate(`(() => { const i = document.querySelector('input[aria-label="実装の枠"]'); const p = document.querySelector('input[aria-label="計画の枠"]'); return i && p && i.value !== "" ? i.value + "/" + p.value : null; })()`), "slots after the reload") as string;
  const savedSlots = (await (await fetch(`${base}/api/settings`)).json() as { backlogSweep: unknown }).backlogSweep;
  assert(slotsAfterReload === "2/1" && JSON.stringify(savedSlots) === JSON.stringify({ implement: 2, plan: 1 }), `slots: ${slotsAfterReload} ${JSON.stringify(savedSlots)}`);
  // an emptied box is refused, not saved as 0 (which would switch the slot off)
  await setField('input[aria-label="計画の枠"]', "");
  await click("保存");
  await until(() => evaluate(`document.body.textContent.includes('枠の数は 0〜3 の整数で入力してください')`), "blank slot refused");
  const afterBlank = (await (await fetch(`${base}/api/settings`)).json() as { backlogSweep: unknown }).backlogSweep;
  assert(JSON.stringify(afterBlank) === JSON.stringify({ implement: 2, plan: 1 }), `after a blank: ${JSON.stringify(afterBlank)}`);

  // the kinds of 自動で始まる Task (#1337): 7 lines on 共通 with the common selects only; 変える on 実装 → codex; a reload
  // shows the selects on 実装 alone. lib's 実装する below then starts on codex
  const kindLines = `[...document.querySelectorAll('.auto-start-kinds .row')].map(r => r.textContent.trim())`;
  const runnerSelects = `[...document.querySelector('.auto-start-kinds').closest('section').querySelectorAll('select')].map(s => s.getAttribute('aria-label')).filter(l => l.endsWith('のランナー'))`;
  const kindsBefore = await until(async () => { const l = await evaluate(kindLines) as string[]; return l.length === 7 ? l : null; }, "7 kind lines") as string[];
  assert(kindsBefore.every((l) => l.endsWith("共通変える")) && JSON.stringify(await evaluate(runnerSelects)) === JSON.stringify(["自動で始まる Task のランナー"]), `kinds: ${kindsBefore.join(" / ")}`);
  await clickIn(`[...document.querySelectorAll('.auto-start-kinds .row')].find(r => r.textContent.startsWith('実装'))`, "変える");
  await until(() => evaluate(`!!document.querySelector('select[aria-label="実装 のランナー"]')`), "実装's selects");
  await setField('select[aria-label="実装 のランナー"]', "codex");
  await until(async () => (await (await fetch(`${base}/api/settings`)).json() as { autoStart: { byKind: { complete?: { runner: string } } } }).autoStart.byKind.complete?.runner === "codex", "実装 saved as codex");
  await call("Page.reload");
  await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail after the reload");
  await click("Settings");
  const kindsAfter = await until(async () => { const l = await evaluate(kindLines) as string[]; return l.length === 7 ? l : null; }, "7 kind lines after the reload") as string[];
  const selectsAfter = await evaluate(runnerSelects) as string[];
  const kindRunner = await evaluate(`document.querySelector('select[aria-label="実装 のランナー"]')?.value`);
  const savedKinds = (await (await fetch(`${base}/api/settings`)).json() as { autoStart: { byKind: unknown } }).autoStart.byKind;
  assert(kindsAfter.filter((l) => l.endsWith("共通変える")).length === 6 && JSON.stringify(selectsAfter) === JSON.stringify(["自動で始まる Task のランナー", "実装 のランナー"]) && kindRunner === "codex" && JSON.stringify(savedKinds) === JSON.stringify({ complete: { runner: "codex", model: "", effort: "" } }), `after the reload: ${kindsAfter.join(" / ")} ${JSON.stringify(selectsAfter)} ${kindRunner} ${JSON.stringify(savedKinds)}`);

  // another workspace's stage button: the Task runs in that repository and reads the skills from the meta workspace
  await stopAll();
  await click("Backlog");
  await until(() => evaluate(`${read} && !!document.querySelector('.backlog-ws')`), "backlog with the switch");
  await tab("lib");
  await until(() => evaluate(`(() => { const rows = [...document.querySelectorAll('section[data-stage="ready"] .backlog-item')]; return rows.length === 1 && rows[0].querySelector('a').href.includes('/acme/lib/') && rows[0].textContent.includes('実装する'); })()`), "lib's Ready row");
  await click("実装する");
  await until(() => evaluate(`!document.querySelector('.backlog')`), "lib's Task screen");
  const libTask = await until(() => core.db.listTasks().find((t) => t.workspaceId === libId && ["running", "waiting"].includes(t.status)) ?? null, "lib stage Task");
  assert(libTask.title.startsWith("#304 実装: ") && libTask.runner === "codex" && libTask.cwd === libDir && prompts.at(-1)!.includes(".claude/skills/pbi-complete/SKILL.md に従い、PBI #304") && prompts.at(-1)!.includes("Switchboard のリポジトリ"), `lib task: ${libTask.title} ${libTask.cwd} ${prompts.at(-1)}`);
  await stopAll();
  // 共通に戻す (#1337): 実装 is one word again and the saved byKind is empty
  await click("Settings");
  await until(() => evaluate(`!!document.querySelector('select[aria-label="実装 のランナー"]')`), "実装's selects again");
  await click("共通に戻す");
  await until(async () => { const l = await evaluate(kindLines) as string[]; return l.length === 7 && l.every((x) => x.endsWith("共通変える")); }, "every kind on 共通 again");
  const resetKinds = (await (await fetch(`${base}/api/settings`)).json() as { autoStart: { byKind: unknown } }).autoStart.byKind;
  assert(JSON.stringify(resetKinds) === "{}", `after 共通に戻す: ${JSON.stringify(resetKinds)}`);
  await click("Backlog");
  await until(() => evaluate(`${read} && !!document.querySelector('.backlog-ws')`), "backlog with the switch again");
  await tab("すべて");

  // gh failing: the screen says which workspace could not be read and why, instead of showing empty stages
  await until(() => evaluate(`!!document.querySelector('.backlog') && !document.querySelector('.backlog button.ghost')?.disabled`), "backlog with 再読込 enabled");
  failing = true;
  await click("再読込");
  const failures = await until(async () => {
    const lines = await evaluate(`[...document.querySelectorAll('.backlog .backlog-error-msg')].map(e => e.textContent)`) as string[];
    return lines.length === 2 ? lines.sort() : null;
  }, "failure message per workspace");
  assert(JSON.stringify(failures) === JSON.stringify([metaName, "lib"].sort().map((n) => `${n} を読めませんでした: gh repo view: gh auth login が必要です`)), `failures: ${JSON.stringify(failures)}`);

  // the failing row takes the repository variable its Project URL is under; saved per workspace, shown again after a reload
  const libInput = `#pv-${libId}`;
  // the backlog may be read again meanwhile (the stage Tasks stopped above): wait for the row's input to be there
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(libInput)})`), "lib's projectVar input");
  await setField(libInput, "LIB_PROJECT_URL");
  await evaluate(`document.querySelector(${JSON.stringify(libInput)}).closest('.backlog-error').querySelector('button').click()`);
  await until(() => core.db.getWorkspace(libId)?.projectVar === "LIB_PROJECT_URL" || null, "projectVar saved");
  await click("Schedules");
  await until(() => evaluate(`!document.querySelector('.backlog')`), "Schedules before the backlog again");
  await click("Backlog");
  const shownVar = await until(async () => ((await evaluate(`document.querySelector(${JSON.stringify(libInput)})?.value ?? ""`)) as string) || null, "saved projectVar shown");
  assert(shownVar === "LIB_PROJECT_URL" && core.db.listWorkspaces().find((w) => w.kind === "meta")!.projectVar === undefined, `projectVar: ${shownVar}`);

  // #441: coming back to the tab shows the last list at once, with when it was read, while a slow GitHub is read again;
  // the screen stays on the backlog (no /_auth/, no Home) and the new list replaces it
  failing = false;
  await until(() => evaluate(`!document.querySelector('.backlog button.ghost')?.disabled`), "再読込 enabled");
  await click("再読込");
  await until(() => evaluate(`document.querySelectorAll('.backlog .backlog-item').length > 0 && !document.querySelector('.backlog-error-msg')`), "the list again");
  const hintNow = () => evaluate(`document.querySelector('.backlog .head .hint')?.textContent ?? ""`) as Promise<string>;
  const readAt = (await hintNow()).replace(/ に GitHub から取得.*/, "");
  // GitHub slow (#441): 再読込 imports first (#885), six calls here at 2.5 s — longer than Bun's default idle timeout
  await until(() => evaluate(`!document.querySelector('.backlog button.ghost')?.disabled`), "再読込 enabled");
  delayMs = 2_500;
  await Bun.sleep(1_100); // the hint shows seconds: the import below starts in another second than the one shown
  await click("再読込");
  const back = Date.now();
  const lastShown = await until(async () => (await hintNow()).includes("読み込み中") && (await evaluate(`document.querySelectorAll('.backlog .backlog-item').length`)) as number || null, "the last list");
  const lastShownMs = Date.now() - back;
  const loadingHint = await hintNow();
  assert(lastShownMs < 1_000 && loadingHint === `${readAt} に GitHub から取得 · 読み込み中…`, `last list after ${lastShownMs} ms, hint: ${loadingHint}`);
  const onBacklog = () => evaluate(`location.pathname === "/" && !!document.querySelector('.backlog') && document.querySelector('nav.tabs button.on')?.textContent.trim() === "Backlog"`) as Promise<boolean>;
  while (Date.now() - back < 15_000) { assert(await onBacklog(), `left the backlog after ${Date.now() - back} ms`); await Bun.sleep(250); }
  let replaced = "";
  while (Date.now() - back < 45_000 && !replaced) { assert(await onBacklog(), `left the backlog after ${Date.now() - back} ms`); const h = await hintNow(); if (!h.includes("読み込み中") && !h.startsWith(readAt)) replaced = h; else await Bun.sleep(250); }
  assert(replaced, `the list was not replaced: ${await hintNow()}`);
  const slowGitHub = { lastShown, lastShownMs, loadingHint, stayedMs: Date.now() - back, replaced };

  // two answers in flight at once: the one answered first does not come back when the second one lands (#441 review)
  for (const p of pages) for (const n of p.data.repository.issues.nodes) if (n.number === 306) n.labels.nodes.push({ name: "needs-decision" });
  delayMs = 0;
  await click("再読込");
  await until(async () => (await evaluate(`${read} && document.querySelectorAll('section[data-stage="needs-decision"] .decision-card').length === 2`)) || null, "both 判断待ち again");
  writeDelayMs = (cwd) => (cwd === libDir ? 1_000 : 300);
  delayMs = 3_000; // the reads after the answers stay out until the check below
  const writesBefore = issueWrites.length;
  await evaluate(`(() => { for (const c of document.querySelectorAll('section[data-stage="needs-decision"] .decision-card')) { const t = c.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'A で'); t.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await evaluate(`[...document.querySelectorAll('section[data-stage="needs-decision"] .decision-card button')].forEach((b) => b.click())`);
  await until(() => issueWrites.length >= writesBefore + 4 || null, "both answers written"); // comment + label, per answer
  await Bun.sleep(1_500);
  const cardsWhileReading = await evaluate(`document.querySelectorAll('section[data-stage="needs-decision"] .decision-card').length`) as number;
  assert(cardsWhileReading === 0 && (await hintNow()).includes("読み込み中"), `判断待ち after both answers: ${cardsWhileReading}, hint: ${await hintNow()}`);
  writeDelayMs = () => 0;
  delayMs = 0;
  await fetch(`${base}/api/workspaces/${libId}`, { method: "PATCH", body: JSON.stringify({ projectVar: null }) });

  // a Task's 判断待ち (#562): Task #330 of in-progress #307 asks → #307 waits with "Task #330 の判断待ち" → the answer goes to #330
  decisions.data.repository.i307!.subIssues!.nodes.push({ number: 330, state: "OPEN", labels: { nodes: [{ name: "type:task" }, { name: "needs-decision" }] }, comments: { nodes: [{ body: "## 判断待ち\n**問い**: 表示をどちらにするか", createdAt: "2026-09-28T03:00:00Z" }] } } as never);
  const card307 = `[...document.querySelectorAll('section[data-stage="needs-decision"] .decision-card')].find(c => c.querySelector('a').href === 'https://github.com/acme/app/issues/307')`;
  await until(async () => (await evaluate(read)) || null, "read before 再読込");
  await click("再読込");
  await until(async () => (await evaluate(`${read} && !!${card307}`)) || null, "#307 waits on its Task");
  const taskDecision = await evaluate(`(() => { const c = ${card307}; const l = c.querySelector('.task-decision'); return { line: l?.textContent ?? "", href: l?.querySelector('a')?.href ?? "", question: c.querySelector('pre.wrap').textContent }; })()`) as { line: string; href: string; question: string };
  assert(taskDecision.line === "Task #330 の判断待ち" && taskDecision.href === "https://github.com/acme/app/issues/330" && taskDecision.question.includes("表示をどちらにするか"), `task decision: ${JSON.stringify(taskDecision)}`);
  const writesBeforeTask = issueWrites.length;
  await evaluate(`(() => { const t = ${card307}.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'A で'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`${card307}.querySelector('button').click()`);
  await until(async () => (await evaluate(`${read} && !${card307}`)) || null, "#307 leaves 判断待ち");
  await until(() => issueWrites.length >= writesBeforeTask + 2 || null, "the Task's answer sent");
  const taskAnswer = issueWrites.slice(writesBeforeTask).map((a) => a.slice(0, 3).join(" ") + (a.includes("--remove-label") ? " --remove-label " + a[a.indexOf("--remove-label") + 1] : ""));
  assert(JSON.stringify(taskAnswer) === JSON.stringify(["issue comment 330", "issue edit 330 --remove-label needs-decision"]), `task answer: ${JSON.stringify(taskAnswer)}`);

  // The promotion line (#626): a newer tag while a Task runs → 昇格待ち; that tag went back by itself → 失敗 + 救援画面.
  git("commit", "-q", "--allow-empty", "-m", "feat: second (#2)");
  git("tag", "v0.2.0");
  const tagged = git("rev-parse", "HEAD");
  const busyTasks = () => core.db.listTasksByStatus("running").length + core.db.listTasksByStatus("waiting").length;
  // a Task that runs (it waits on its approval) for the promotion to wait on
  assert((await fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId: libId, title: "動いている Task", prompt: "ls" }) })).status === 201, "a running Task");
  await until(() => busyTasks() > 0, "the Task runs");
  const scheduleId = ((await (await fetch(`${base}/api/schedules`)).json()) as Array<{ id: string; action?: string }>).find((x) => x.action === "backlog-next")!.id;
  const promotionShown = async () => {
    await fetch(`${base}/api/schedules/${scheduleId}/run`, { method: "POST" });
    await until(async () => (await evaluate(read)) || null, "read before 再読込");
    await click("再読込");
    return until(async () => (await evaluate(`(() => { const l = document.querySelector('.backlog .promotion'); return l && { text: l.textContent, href: l.querySelector('a')?.href ?? null, target: l.querySelector('a')?.target ?? null }; })()`)) as { text: string; href: string | null; target: string | null } | null, "promotion line");
  };
  const waiting = await promotionShown();
  assert(waiting.text === `v0.2.0 の昇格待ち: 動いている Task ${busyTasks()} 件が終わると入る` && waiting.href === null && promoted.length === 0, `waiting: ${JSON.stringify(waiting)}`);
  releaseHistory.unshift({ ts: Date.now(), action: "auto-rollback", from: tagged, to: running, ok: false, reason: "went back by itself: health" });
  const failed = await until(async () => { const l = await promotionShown(); return l.text.startsWith("昇格に失敗した版のまま") ? l : null; }, "failed promotion line");
  assert(failed.text === "昇格に失敗した版のまま: v0.2.0 救援画面 →" && failed.href === `${rescueUrl}/` && failed.target === "_blank" && promoted.length === 0, `failed: ${JSON.stringify(failed)}`);
  const promotionLine = { waiting: waiting.text, failed: failed.text, rescueLink: failed.href };

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ columns: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])), workspaceNames, workspaceSwitch, libTask: libTask.title, feedbackOpened, startedTitle, rowShowsRunning, approvalsLink, decisionShown, answered, ghCalls, scheduleLog, slotsAfterReload, kinds: { after: kindsAfter, selects: selectsAfter, saved: savedKinds, libRunner: libTask.runner, reset: resetKinds }, failures: failures.length, shownVar, slowGitHub, overlappingAnswers: cardsWhileReading, inProgress, closable, waitOwner, prereqs, overlap: overlapShown.text, taskDecision: taskDecision.line, taskAnswer, promotionLine, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rescue.stop(true);
  rmSync(home, { recursive: true, force: true });
}
