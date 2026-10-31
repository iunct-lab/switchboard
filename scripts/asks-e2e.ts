/**
 * Run after `bun run --cwd apps/web build`: bun scripts/asks-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * The 判断待ち screen end to end (#935): a fake runner and the backlog fixtures' fake `gh` (as
 * scripts/backlog-e2e.ts) give every kind of question, twice where the same question comes from two records; the screen
 * is read at 1280 × 800, answered, and read again at 390 × 844. SCREENSHOT_DIR=<dir> saves both widths.
 * #1673: a second Workspace with one tool approval; its button narrows every group to it, すべて goes back.
 * #936: the questions are answered with the cards' buttons and go on — a tool approval, #306's decision, merge checks
 * (one whose PR moved), a refused reply, the usage limit, a hold, a decision a stop condition still holds, and a Task the
 * runner refused — then an approval and a decision at 390.
 * #938: answers saved as policies — three ranges' worth read back in the settings, applied to the next approval and
 * decision with the basis on record, shown again with what differs, refused where the runner or a rule always asks, edited
 * and revoked from the settings and taking effect at once — at 1280, and the form and the list at 390.
 * #1674: #306's decision, which the Ready #309 names as its prerequisite, is the first of the person's with 答えると 1 件が進められる.
 * #2221: a decision and an operational check that name a Task's two screen mockups — a button each on their cards, the
 * pressed one opened in the card, the same buttons over the Backlog's answer box — at 1280 and 390.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, Task } from "@switchboard/protocol";
import { importing, sending } from "../packages/core/fixtures/github-import.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { releaseBody } from "./parallel-guard.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixtures = join(import.meta.dir, "..", "packages", "core", "fixtures");
const pages = JSON.parse(readFileSync(join(fixtures, "backlog-graphql.json"), "utf8")) as Json[];
const decisions = JSON.parse(readFileSync(join(fixtures, "backlog-decisions.json"), "utf8")) as Json;
const issue = (n: number) => pages.flatMap((p) => p.data.repository.issues.nodes).find((x: Json) => x.number === n);
const comments = (n: number): Json[] => (decisions.data.repository[`i${n}`] ??= { comments: { nodes: [] } }).comments.nodes;
// #306 asks with its ## 判断待ち (question, choices, recommendation); #303 is labelled but its ## 判断待ち is not there (不明)
issue(303).labels.nodes.push({ name: "needs-decision" });
comments(303);
// #308 has two acceptance criteria waiting on the user's check (the fixture); #304 (Ready) waits for the open PR #779
comments(304).push({ body: releaseBody("後回し: 前提 PR #779", [779]), createdAt: new Date().toISOString() });
// #1674: #309, a Ready PBI no other check uses, names #306 as its prerequisite, so #306's question is the first of the
// person's, unblocking one
pages[0].data.repository.issues.nodes.push({ ...structuredClone(issue(304)), number: 309, title: "PBI: #306 を待つ PBI", url: "https://github.com/acme/app/issues/309", body: "**Story Points**: 2\n\n**前提**: #306\n", subIssuesSummary: { total: 0, completed: 0 } });
const waitStates: Json = { w779: { __typename: "PullRequest", state: "OPEN" }, w306: { __typename: "Issue", state: "OPEN" } };
// #936: the PRs merge checks stop at — #12's head is the one its [merge-ask] named, #13 was pushed to since
const ASKED = "a".repeat(40);
const heads: Record<string, string> = { "12": ASKED, "13": "d".repeat(40), "14": "e".repeat(40) };

const home = mkdtempSync(join(tmpdir(), "sb-asks-e2e-"));
const gh: GhRunner = async (args, cwd) => {
  // #1673: the second Workspace is no GitHub repository (its one question is a Task's tool approval)
  if (cwd.endsWith("/second")) return { code: 1, stdout: "", stderr: "not a git repository" };
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args[0] === "issue") {
    // like GitHub: the answer is a comment, and once the label is off the item is no longer needs-decision
    if (args[1] === "comment") comments(Number(args[2])).push({ body: args[args.indexOf("--body") + 1], createdAt: new Date().toISOString() });
    if (args.includes("--remove-label")) issue(Number(args[2])).labels.nodes = issue(Number(args[2])).labels.nodes.filter((l: Json) => l.name !== "needs-decision");
    return { code: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "view") {
    // #14 is a size check (a policy may answer it); the others are security checks (always asked)
    const mark = { body: args[2] === "14" ? `[merge-ask] size ${heads["14"]}` : `[merge-ask] security ${ASKED}`, createdAt: new Date(Date.now() - 3_600_000).toISOString() };
    return { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: heads[args[2]!], comments: [mark], commits: [] }), stderr: "" };
  }
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: JSON.stringify({ data: { repository: waitStates } }), stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
delete process.env.SWITCHBOARD_PROJECT_URL;
// the checkout's origin reads as the fake registration (#2799 starts no Task in a clone of another repository)
const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: import.meta.dir, encoding: "utf8" });
if (origin.status === 0) Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/acme/app.git.insteadOf", GIT_CONFIG_VALUE_0: origin.stdout.trim() });

const checkOf = (pr: number) => `PR #${pr} を出しました。\n\n**確認**: PR #${pr} をマージしてよいか\n**選択肢**:\n- A: マージする — 影響: main に入る\n- B: 待つ — 影響: 後続が止まる\n**推奨**: A — CI が緑\n**止めた場所**: PR #${pr}`;
const CHECK = checkOf(12);
// #2221: the Task whose artifacts are the screen mockups, named by the "checkmock" reply
let mockTask = "";
const mockCheck = () => `**確認**: どちらの画面にするか\n**選択肢**:\n- A: 上に並べる — 影響: 1 回で届く\n- B: 下に並べる — 影響: 2 回で届く\n**推奨**: A — 手数が少ない\n**画面イメージ**: ${mockTask}`;
const LIMIT = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
const answered: string[] = [];
const replies: Array<{ prompt: string; text: string }> = [];
/**
 * Either runner: "write" asks for a Write and keeps running after the answer, a stage Task's /pbi-complete just runs, any
 * other prompt ends its turn with the prompt's reply ("check" / "check13": a merge check, "limit": a check whose reply's
 * turn hits Claude's usage limit). Every reply a Task is sent is kept in `replies`.
 */
const runner = (id: RunnerId): RunnerAdapter => ({
  id,
  detect: async () => ({ available: true, version: "fake" }),
  start(opts, emit) {
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    const summary = opts.prompt === "checkmock" ? mockCheck() : opts.prompt === "check" ? CHECK : opts.prompt === "check14" ? checkOf(14) : opts.prompt === "checknopr" ? "**確認**: 続けるか\n**選択肢**:\n- A: はい — 影響: 進む\n- B: いいえ — 影響: 止まる" : opts.prompt === "check13" ? checkOf(13) : opts.prompt === "limit" || opts.prompt === "budget" ? "**確認**: 続けるか" : "done";
    const execAsk = (command: string): AgentEvent[] => [{ t: "permission.ask", id: "perm1", kind: "exec", tool: "Bash", input: { command }, detail: command }];
    const script: AgentEvent[] = opts.prompt.includes("/pbi-complete") ? [] : opts.prompt === "exec" ? execAsk("bun test packages/core") : opts.prompt === "exec2" ? execAsk("bun test apps/web") : opts.prompt === "exec3" ? execAsk("git status --short") : opts.prompt === "write" ? [{ t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" }] : [{ t: "session.end", status: "ok", summary }];
    queueMicrotask(() => script.forEach((ev) => emit(ev)));
    return {
      send(text: string) {
        replies.push({ prompt: opts.prompt, text });
        if (opts.prompt !== "limit") return;
        const resetsAt = Math.floor(Date.now() / 1000) + 3600;
        queueMicrotask(() => [{ t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.06, resetsAt } }, status: "rejected", limitType: "five_hour" } as AgentEvent, { t: "message.delta", role: "assistant", text: LIMIT } as AgentEvent, { t: "session.end", status: "error", summary: LIMIT } as AgentEvent].forEach((ev) => emit(ev)));
      },
      respondPermission(pid, decision) {
        answered.push(`${pid}:${decision}`);
        emit({ t: "permission.resolved", id: pid, decision, by: "user" });
      },
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
});
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
const core = await startServer(cfg, [runner("claude"), runner("codex")], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(sending(gh)), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
const imported = async (refresh: boolean) => {
  let b = await (await fetch(`${base}/api/backlog${refresh ? "?refresh=1" : ""}`)).json() as Json;
  while (b.syncs.some((s: Json) => s.syncing)) { await Bun.sleep(20); b = await (await fetch(`${base}/api/backlog`)).json(); }
};
await imported(false);
const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
const status = (id: string) => core.db.getTask(id)!.status;
const task = async (title: string, runnerId: RunnerId, prompt: string, until_: (t: Task["status"]) => boolean, workspaceId = meta.id): Promise<string> => {
  const t = await post("/api/tasks", { workspaceId, title, prompt, runner: runnerId });
  await until(() => until_(status(t.id)), `task ${title}`);
  return t.id;
};
const stop = (taskId: string, reason: string, state: string) =>
  core.db.appendEvent(taskId, { t: "stop.record", stop: { id: `s-${taskId}`, work: { workspaceId: meta.id, issue: null, taskId }, op: "op", target: "", reason, evidence: `${reason} の停止`, safety: "unknown", conditions: [], answer: null, actions: [], state, at: Date.now() } } as AgentEvent);

// A: a tool approval, and the permission stop of the same Task (one question)
const a = await task("ツールを使う Task", "claude", "write", (s) => s === "waiting");
stop(a, "permission", "waiting");
// B: an operational check in its last reply, 要対応
const b = await task("PR を出す Task", "codex", "check", (s) => s !== "running");
await post(`/api/tasks/${b}/outcome`, { outcome: "needs_action" });
// #306's stage Task wrote ## 判断待ち and ended 要対応 (one question with #306's decision)
const stage = await task("#306 実装", "codex", "check", (s) => s !== "running");
await post(`/api/tasks/${stage}/outcome`, { outcome: "needs_action" });
// the Issue of a stage Task is its stage column, not its title (#1170)
const stageOf = (id: string, issueNo: number) => core.db.sqlite.query("UPDATE tasks SET stage_issue = ?, stage_action = 'complete' WHERE id = ?").run(issueNo, id);
stageOf(stage, 306);
// C: waits for the usage limit to lift
const c = await task("使用上限の Task", "codex", "done", (s) => s !== "running");
await post(`/api/tasks/${c}/outcome`, { reviewed: true });
core.db.updateTask(c, { resumeAt: Date.now() + 3_600_000 });
// D: a stop that went on (resolved)
const d = await task("止まって進んだ Task", "codex", "done", (s) => s !== "running");
await post(`/api/tasks/${d}/outcome`, { reviewed: true });
stop(d, "input", "resolved");
// #1673: a second Workspace whose one Task waits on a tool approval
const secondDir = join(home, "second");
mkdirSync(secondDir);
const second = await post("/api/workspaces", { path: secondDir, name: "second" });
assert(second.id && second.name === "second", `second Workspace: ${JSON.stringify(second)}`);
const s2 = await task("2 つ目の Workspace の Task", "claude", "write", (s) => s === "waiting", second.id);

const shots = process.env.SCREENSHOT_DIR;
const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
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
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(m);
    if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) errors.push(m);
  };
  const call = (method: string, params: object = {}): Promise<Json> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const callIn = (sessionId: string, method: string, params: object = {}): Promise<Json> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params, sessionId })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  /** The screen as groups of `<kind>` labels, e.g. { person: ["ツール承認", …] }. */
  const groups = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.ask-group')].map(g => [g.className.match(/ask-group-(\\w+)/)[1], [...g.querySelectorAll('.card.ask .ask-kind')].map(k => k.textContent).sort()]))`) as Promise<Record<string, string[]>>;
  const card = (prefix: string) => `[...document.querySelectorAll('.card.ask')].find(c => c.dataset.ask.startsWith(${JSON.stringify(prefix)}))`;
  const facts = (prefix: string) => evaluate(`Object.fromEntries([...${card(prefix)}.querySelectorAll('.ask-fact')].map(f => [f.querySelector('dt').textContent, { text: f.querySelector('dd').textContent, href: f.querySelector('a')?.href ?? null }]))`) as Promise<Record<string, { text: string; href: string | null }>>;
  const press = (prefix: string, label: string) => evaluate(`(${card(prefix)}).querySelector('.approval-actions') && [...${card(prefix)}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const open = async () => {
    await call("Page.navigate", { url: `${base}/approvals` });
    await until(() => evaluate(`!!document.querySelector('.ask-group')`), "the 判断待ち screen");
  };
  const shot = async (name: string) => {
    if (!shots) return;
    const s = await call("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(shots, name), Buffer.from(s.data, "base64"));
  };
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const report: Json = {};

  // 2. 1280 × 800: the person's seven (the two pairs one each, and the second Workspace's approval), the full card and the
  // one with 不明, the automatic two
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await open();
  const before = await until(async () => { const g = await groups(); return g.person?.length === 7 ? g : null; }, "seven of the person's");
  assert(same(before.person, ["ツール承認", "ツール承認", "利用者確認", "利用者確認", "実装の判断", "実装の判断", "運用の確認"]), `person: ${JSON.stringify(before.person)}`);
  assert(same(before.auto, ["依存待ち", "停止"]), `auto: ${JSON.stringify(before.auto)}`);
  assert(same(before.resolved, ["停止"]), `resolved: ${JSON.stringify(before.resolved)}`);
  assert(await evaluate(`document.querySelector('.ask-group-auto').textContent.includes('操作は要りません')`), "the automatic group says no action is needed");
  const full = await facts(`decision:${meta.id}#306@`);
  assert(full["問い"]!.text === "保存先をどちらにするか" && full["推奨と根拠"]!.text === "B — 小さい" && full["PBI"]!.href === "https://github.com/acme/app/issues/306" && full["元の記録"]!.href === "https://github.com/acme/app/issues/306" && full["対象リポジトリ"]!.text === meta.name, `#306: ${JSON.stringify(full)}`);
  const missing = await facts(`decision:${meta.id}#303@`);
  assert(missing["問い"]!.text === "不明" && missing["推奨と根拠"]!.text === "不明" && missing["PBI"]!.text.startsWith("#303 "), `#303: ${JSON.stringify(missing)}`);
  const wait = await facts(`wait:${meta.id}#304@`);
  assert(wait["停止理由"]!.text === "PR #779 の完了待ち" && wait["条件"]!.text === "pr#779: open", `#304: ${JSON.stringify(wait)}`);
  // #1674: the question other PBIs wait on comes first, with how many and which
  const first = await evaluate(`(() => { const c = document.querySelector('.ask-group-person .card.ask'); return { id: c.dataset.ask, line: c.querySelector('.ask-unblocks')?.textContent ?? null, links: [...c.querySelectorAll('.ask-unblocks-list a')].map(a => a.href) }; })()`) as { id: string; line: string | null; links: string[] };
  assert(first.id.startsWith(`decision:${meta.id}#306@`) && first.line === "答えると 1 件が進められる" && same(first.links, ["https://github.com/acme/app/issues/309"]), `first of the person's: ${JSON.stringify(first)}`);
  assert(await evaluate(`[...document.querySelectorAll('.card.ask')].filter(c => c.querySelector('.ask-unblocks')).length`) === 1, "only #306's card says how many it unblocks");
  report.first = first;
  report.before = before;
  await shot("asks-1280.png");

  // #1673: a button per Workspace with the person's count; second narrows every group to its one approval, すべて goes back
  const chips = () => evaluate(`[...document.querySelectorAll('.ask-workspaces button')].map(b => b.textContent.trim())`) as Promise<string[]>;
  const headCount = () => evaluate(`document.querySelector('.approvals .row.head h5 .hint').textContent`) as Promise<string>;
  const shown = () => evaluate(`[...document.querySelectorAll('.card.ask')].map(c => c.dataset.ask)`) as Promise<string[]>;
  const all = await chips();
  assert(same(all, ["すべて", `${meta.name} 6`, "second 1"]), `Workspace buttons: ${JSON.stringify(all)}`);
  assert((await headCount()) === "7", `the heading's count: ${await headCount()}`);
  const sections = await evaluate(`[...document.querySelectorAll('.ask-group-person .ask-workspace-head')].map(h => h.textContent)`) as string[];
  assert(same(sections, [`${meta.name} 6`, "second 1"]), `the person's Workspace headings: ${JSON.stringify(sections)}`);
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'second 1').click()`);
  const narrowed = await until(async () => { const s = await shown(); return s.length === 1 ? s : null; }, "only the second Workspace's card");
  assert(narrowed[0]!.startsWith(`approval:${s2}:`), `narrowed to: ${JSON.stringify(narrowed)}`);
  assert(same(await groups(), { person: ["ツール承認"] }) && (await headCount()) === "1", `narrowed groups: ${JSON.stringify(await groups())}, count ${await headCount()}`);
  await shot("asks-workspace-1280.png");
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'すべて').click()`);
  await until(async () => (await groups()).person?.length === 7 && (await headCount()) === "7", "すべて shows every Workspace again");
  report.workspaces = { buttons: all, narrowed: narrowed.length };

  // 3. answer (#936): the approval with 承認して続行, tapped twice at once → the runner hears once, the card says 実行中;
  // #306 with 推奨案で進める (B), whose line says what is written where → ## 回答 and the label off, one 実装 starts, 実行中.
  // The stop that went on is 解消済み
  const badge = (prefix: string) => evaluate(`${card(prefix)}?.querySelector('.ask-resume')?.textContent ?? null`) as Promise<string | null>;
  await evaluate(`(() => { const b = [...${card(`approval:${a}:`)}.querySelectorAll('button')].find(b => b.textContent.trim() === '承認して続行'); b.click(); b.click(); })()`);
  await until(() => answered.includes("perm1:allow"), "the runner got allow");
  await until(async () => (await badge(`approval:${a}:`))?.startsWith("実行中"), "the approval's card says 実行中");
  assert(answered.filter((x) => x === "perm1:allow").length === 1, `allow sent ${answered.length} times`);
  stop(a, "permission", "resolved"); // as a runner reports once it went on: the stop of the approval is resolved
  const d306 = `decision:${meta.id}#306@`;
  const line306 = await evaluate(`[...${card(d306)}.querySelectorAll('.ask-button')].find(b => b.querySelector('button').textContent.startsWith('推奨案で進める')).textContent`) as string;
  assert(line306.includes("推奨案で進める（B）") && line306.includes("送る: B: ファイル — 影響: 移行が要らない → Issue #306、続き: #306 の続きの工程 Task"), `#306's button: ${line306}`);
  await press(d306, "推奨案で進める（B）");
  await until(async () => (await badge(d306))?.startsWith("実行中"), "#306's card says 実行中");
  await until(() => comments(306).some((c: Json) => c.body === "## 回答\n\nB: ファイル — 影響: 移行が要らない") && !issue(306).labels.nodes.some((l: Json) => l.name === "needs-decision"), "#306's ## 回答 and its label off reach GitHub");
  const impl306 = core.db.listTasks().filter((t) => t.title.startsWith("#306 実装: "));
  assert(impl306.length === 1, `#306 実装 Tasks: ${impl306.length}`);
  await imported(true);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  const after = await until(async () => { const g = await groups(); return g.answered?.includes("実装の判断") ? g : null; }, "#306 is answered");
  assert(same(after.person, ["ツール承認", "利用者確認", "利用者確認", "実装の判断", "運用の確認"]), `person after: ${JSON.stringify(after.person)}`);
  assert(same(after.answered, ["ツール承認", "実装の判断"]), `answered: ${JSON.stringify(after.answered)}`);
  assert(same(after.resolved, ["停止", "停止"]), `resolved after: ${JSON.stringify(after.resolved)}`);
  report.after = after;
  // the way to answer and the record, from each state: an open decision → Backlog, a resolved stop → its Task
  assert((await facts(`decision:${meta.id}#303@`))["元の記録"]!.href === "https://github.com/acme/app/issues/303", "#303's record");
  await press(`decision:${meta.id}#303@`, "Backlog で答える");
  await until(() => evaluate(`!!document.querySelector('main.backlog')`), "Backlog で答える opens the backlog");
  await open();
  await press(`stop:task:${d}`, "Task を開く");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task を開く opens the task");
  await open();
  await press(`approval:${a}:`, "Task を開く");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "an answered approval opens its task");

  // 4. 390 × 844: the same groups, nothing sideways, every button a 44px target; the routes again
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await open();
  const phone = await until(async () => { const g = await groups(); return g.person?.length === 5 ? g : null; }, "the groups at 390");
  assert(same(phone, after), `390: ${JSON.stringify(phone)}`);
  const width = await evaluate("document.documentElement.scrollWidth") as number;
  const wide = width > 390 ? await evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 391).slice(0, 6).map(e => e.tagName + '.' + e.className)`) : [];
  assert(width <= 390, `scrolls sideways at 390px (${width}): ${JSON.stringify(wide)}`);
  assert(await evaluate(`!!document.querySelector('.ask-workspaces')`), "the Workspace buttons at 390");
  const small = await evaluate(`[...document.querySelectorAll('.ask .approval-actions button, .ask-workspaces button')].filter(b => b.getBoundingClientRect().height < 44).length`);
  assert(small === 0, `${small} button(s) shorter than 44px`);
  await shot("asks-390.png");
  await press(`decision:${meta.id}#303@`, "Backlog で答える");
  await until(() => evaluate(`!!document.querySelector('main.backlog')`), "Backlog で答える at 390");
  await open();
  await press(`stop:task:${d}`, "Task を開く");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task を開く at 390");
  report.scrollWidth = width;

  // 5. 1280 × 800 (#936): merge checks, a refused reply, the usage limit, a hold, a decision a stop condition holds, the runner's refusal
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const checkTask = async (title: string, prompt: string, extra: object = {}) => {
    const t = await post("/api/tasks", { workspaceId: meta.id, title, prompt, runner: prompt === "limit" ? "claude" : "codex", ...extra });
    await until(() => status(t.id) !== "running", `task ${title}`);
    await post(`/api/tasks/${t.id}/outcome`, { outcome: "needs_action" });
    return t.id as string;
  };
  const m12 = await checkTask("PR #12 のマージ確認", "check");
  const m13 = await checkTask("PR #13 のマージ確認", "check13");
  const lim = await checkTask("返信が上限で止まる Task", "limit");
  const bud = await checkTask("予算を超えた Task", "budget", { budgetUsd: 0.01 });
  core.db.insertLedger({ taskId: bud, runner: "codex", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: Date.now() });
  const refused = await task("拒否された Task", "codex", "done", (s) => s !== "running");
  stop(refused, "permission", "waiting");
  // #304 asks now (its ## 判断待ち with A / B), and its last stage Task stopped on CI: answering it does not take that away
  issue(304).labels.nodes.push({ name: "needs-decision" });
  comments(304).push({ body: "## 判断待ち\n**問い**: どちらで作るか\n**選択肢**:\n- A: 小さく — 影響: 速い\n- B: 大きく — 影響: 遅い\n**推奨**: A — 小さい", createdAt: new Date().toISOString() });
  const ci = await task("#304 実装: PBI: Ready の PBI", "codex", "done", (s) => s !== "running");
stageOf(ci, 304);
  core.db.appendEvent(ci, { t: "stop.record", stop: { id: "s-ci", work: { workspaceId: meta.id, issue: 304, taskId: ci }, op: "gh pr merge", target: "#20", reason: "depends", evidence: "CI が失敗", safety: "before-effect", conditions: [{ key: "ci", value: "failure", met: false }], answer: null, actions: [], state: "waiting", at: Date.now() } } as AgentEvent);
  await imported(true);
  await open();
  const cardOf = (prefix: string) => until(() => evaluate(`!!${card(prefix)}`), `card ${prefix}`);
  // the merge check whose PR is as its [merge-ask] named: the reply goes, 実行中
  await cardOf(`check:${m12}:`);
  await press(`check:${m12}:`, "推奨案で進める（A）");
  await until(async () => (await badge(`check:${m12}:`))?.startsWith("実行中"), "#12's check says 実行中");
  assert(replies.some((r) => r.prompt === "check" && r.text === "A: マージする — 影響: main に入る"), `replies: ${JSON.stringify(replies)}`);
  // the one whose PR moved: what changed and why to look again, nothing sent
  await press(`check:${m13}:`, "推奨案で進める（A）");
  const changed13 = await until(async () => { const t = await evaluate(`${card(`check:${m13}:`)}?.querySelector('.ask-changes')?.textContent ?? ''`) as string; return t || null; }, "#13's change");
  assert(changed13.includes("問いが変わったので") && changed13.includes(`PR #13 の差分が変わりました（${ASKED.slice(0, 7)} → ddddddd）`), `#13: ${changed13}`);
  assert(!replies.some((r) => r.prompt === "check13"), "#13 got a reply");
  // a reply the Task refuses (its budget): 再開失敗 with the reason, nothing sent
  await evaluate(`(() => { const c = ${card(`check:${bud}:`)}; const t = c.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '続けて'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await press(`check:${bud}:`, "回答を送る");
  const failed = await until(() => badge(`check:${bud}:`).then((b) => (b?.startsWith("再開失敗") ? b : null)), "the refused reply says 再開失敗");
  assert(failed.includes("budget exceeded") && !replies.some((r) => r.prompt === "budget"), `budget: ${failed}`);
  // the reply's turn hits the usage limit: the Task waits for it to lift, among the automatic ones
  await evaluate(`(() => { const c = ${card(`check:${lim}:`)}; const t = c.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '続けて'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await press(`check:${lim}:`, "回答を送る");
  await until(() => core.db.getTask(lim)!.resumeAt !== null, "the limit's resumeAt");
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  await until(() => evaluate(`!![...document.querySelectorAll('.ask-group-auto .card.ask')].find(c => c.dataset.ask.startsWith('resume:${lim}@') && c.textContent.includes('使用上限の解除待ち'))`), "the usage limit's wait among the automatic ones");
  // 保留 on #303: only a ## 保留 is written, the label stays, the card is 保留 and still the person's
  const d303 = `decision:${meta.id}#303@`;
  await press(d303, "保留");
  await until(() => evaluate(`${card(d303)}?.querySelector('.ask-state')?.textContent === '保留'`), "#303 held");
  await until(() => comments(303).some((c: Json) => c.body.startsWith("## 保留")), "#303's ## 保留 reaches GitHub");
  assert(issue(303).labels.nodes.some((l: Json) => l.name === "needs-decision"), "#303 lost its label");
  await imported(true);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  await until(() => evaluate(`!!document.querySelector('.ask-group-person ${"[data-ask^=\\'" + d303 + "\\']"}')`), "#303 held, still the person's");
  // #304: the answer is written but a stop condition still holds it — 再開待ち with the reason, no 実装
  const d304 = `decision:${meta.id}#304@`;
  await cardOf(d304);
  const blocked = await evaluate(`${card(d304)}.querySelector('.ask-blocker')?.textContent ?? ''`) as string;
  assert(blocked === "回答だけでは解除されません: ci: failure", `#304 blocker: ${blocked}`);
  await press(d304, "推奨案で進める（A）");
  const queued = await until(() => badge(d304).then((b) => (b?.startsWith("再開待ち") ? b : null)), "#304 says 再開待ち");
  assert(queued.includes("ci: failure") && core.db.listTasks().filter((t) => t.title.startsWith("#304 実装: ")).length === 1, `#304: ${queued}`);
  // a Task the runner refused: no answer buttons, and why
  const ref = await evaluate(`(() => { const c = ${card(`stop:task:${refused}`)}; return { buttons: c.querySelectorAll('.ask-button, .ask-text').length, blocker: c.querySelector('.ask-blocker')?.textContent ?? '' }; })()`) as Json;
  assert(ref.buttons === 0 && ref.blocker === "op : permission の停止（ランナー側の拒否。回答では解除されません）", `refused: ${JSON.stringify(ref)}`);
  await shot("asks-answer-1280.png");
  report.answered1280 = { m12: "実行中", m13: changed13, budget: failed, limit: "usage-limit", hold: "#303", blocked: queued };

  // 6. 390 × 844: an approval and a decision answered, nothing sideways
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  const a2 = await task("390 で承認する Task", "claude", "write", (s) => s === "waiting");
  await open();
  await cardOf(`approval:${a2}:`);
  await press(`approval:${a2}:`, "承認して続行");
  await until(async () => (await badge(`approval:${a2}:`))?.startsWith("実行中"), "the approval at 390 says 実行中");
  await evaluate(`(() => { const c = ${card(d303)}; const t = c.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'A で進めて'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await press(d303, "回答を送る");
  await until(() => evaluate(`${card(d303)}?.querySelector('.ask-state')?.textContent === '回答済み'`), "#303 answered at 390");
  const width390 = await evaluate("document.documentElement.scrollWidth") as number;
  assert(width390 <= 390, `scrolls sideways at 390px after answering (${width390})`);
  await shot("asks-answer-390.png");
  report.answered390 = { scrollWidth: width390 };

  // 7. 1280 × 800 (#938): answers saved as policies, applied, shown again, refused where something always asks, edited
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const typeInto = (selector: string, value: string) =>
    evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const openForm = (prefix: string) => evaluate(`(${card(prefix)}).querySelector('.ask-policy').open = true`);
  const pickScope = (prefix: string, label: string) => evaluate(`[...${card(prefix)}.querySelectorAll('.ask-policy-scope')].find(l => l.textContent.includes(${JSON.stringify(label)})).querySelector('input').click()`);
  const policies = async () => ((await (await fetch(`${base}/api/policies`)).json()) as Json).policies as Json[];
  const approvedBy = (taskId: string) => core.db.listEvents(taskId).flatMap((e) => (e.ev.t === "permission.ask" && e.ev.rule?.mode === "allow" ? [e.ev.rule.source as string] : []));
  const asksNow = async () => ((await (await fetch(`${base}/api/asks`)).json()) as Json).asks as Json[];
  const answerWith = (id: string, a: Json, policy: Json) => fetch(`${base}/api/asks/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ id, answer: a, policy }) });
  const expires = (days: number) => Date.now() + days * 86_400_000;

  // (a) the approval card: 次回も使う → このリポジトリ, the target widened to bun test*, the lines to confirm, 承認して続行
  const p1 = await task("方針を保存する Task", "claude", "exec", (s) => s === "waiting");
  await open();
  await cardOf(`approval:${p1}:`);
  await openForm(`approval:${p1}:`);
  await pickScope(`approval:${p1}:`, "このリポジトリ");
  // a broad target (#1765) is warned about in the lines to confirm, then narrowed again
  await typeInto(`.card.ask[data-ask^='approval:${p1}:'] .ask-policy-field input`, "bun *");
  const broad = await evaluate(`[...${card(`approval:${p1}:`)}.querySelectorAll('.ask-policy-summary li')].map(l => l.textContent)`) as string[];
  assert(broad[2] === "広い指定: bun のどのサブコマンドにも当たります", `broad summary: ${JSON.stringify(broad)}`);
  await typeInto(`.card.ask[data-ask^='approval:${p1}:'] .ask-policy-field input`, "bun test*");
  const lines = await evaluate(`[...${card(`approval:${p1}:`)}.querySelectorAll('.ask-policy-summary li')].map(l => l.textContent)`) as string[];
  assert(lines[0] === "操作: exec" && lines[1] === "対象: bun test*" && lines[2] === "条件: なし" && lines[3]!.startsWith("期限: ") && lines[4] === "回答: Bash を許可", `summary: ${JSON.stringify(lines)}`);
  await shot("asks-policy-form-1280.png");
  await press(`approval:${p1}:`, "承認して続行");
  await until(async () => (await policies()).length === 1, "the repository policy is saved");
  const repo = (await policies())[0]!;
  assert(repo.scope === "repo" && repo.target === "bun test*" && repo.expiresAt > Date.now() && repo.from.target === "bun test packages/core", `repo policy: ${JSON.stringify(repo)}`);

  // (b) a PBI's decision (#305, whose stage Task stopped on it): 次回も使う → この PBI 内
  issue(305).labels.nodes.push({ name: "needs-decision" });
  comments(305).push({ body: "## 判断待ち\n**問い**: どの方針で進めるか\n**選択肢**:\n- A: 小さく — 影響: 速い\n- B: 大きく — 影響: 遅い\n**推奨**: A — 小さい", createdAt: new Date(Date.now() - 600_000).toISOString() });
  const st305 = await task("#305 計画", "codex", "done", (s) => s !== "running");
  stageOf(st305, 305);
  const stopOf = (target: string, taskId: string, issueNo: number, id: string) =>
    core.db.appendEvent(taskId, { t: "stop.record", stop: { id, work: { workspaceId: meta.id, issue: issueNo, taskId }, op: "decide", target, reason: "decision", evidence: "判断が要る", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 3_600_000 } } as AgentEvent);
  stopOf("approach", st305, 305, "s-305");
  await imported(true);
  await open();
  const d305 = `decision:${meta.id}#305@`;
  await cardOf(d305);
  const scopes305 = await evaluate(`[...${card(d305)}.querySelectorAll('.ask-policy-scope')].map(l => l.textContent.trim())`) as string[];
  assert(scopes305.length === 3 && scopes305[1]!.startsWith("この PBI 内（#305）"), `#305 scopes: ${JSON.stringify(scopes305)}`);
  await openForm(d305);
  await pickScope(d305, "この PBI 内");
  await press(d305, "推奨案で進める（A）");
  await until(async () => (await policies()).length === 2, "the PBI policy is saved");
  const pbi = (await policies()).find((p) => p.scope === "pbi")!;
  assert(pbi.pbi === 305 && pbi.op === "decide" && pbi.target === "approach" && pbi.answer.choice.startsWith("A:"), `pbi policy: ${JSON.stringify(pbi)}`);
  await until(() => comments(305).some((c: Json) => c.body.startsWith("## 回答")), "#305's ## 回答 reaches GitHub");

  // (c) the settings list the two with range, operation and expiry
  const settings = async () => {
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Settings').click()`);
    await until(() => evaluate(`!!document.querySelector('.policies .policy-row')`), "the policy list");
    await evaluate(`document.querySelector('.policies').scrollIntoView()`);
  };
  await settings();
  const rows = await evaluate(`[...document.querySelectorAll('.policy-row')].map(r => r.querySelector('.policy-main').textContent)`) as string[];
  assert(rows.length === 2 && rows.some((r) => r.includes("有効") && r.includes("exec: bun test*") && r.includes("このリポジトリ（") && r.includes("期限: ")) && rows.some((r) => r.includes("decide: approach") && r.includes("この PBI 内（#305）")), `rows: ${JSON.stringify(rows)}`);
  await shot("asks-policy-settings-1280.png");

  // (d) applied: the same PBI asks again → written as ## 回答 with the basis; a command that matches is allowed by the policy
  const fire = await task("きっかけの Task", "codex", "done", (s) => s !== "running");
  issue(305).labels.nodes.push({ name: "needs-decision" });
  comments(305).push({ body: "## 判断待ち\n**問い**: 次はどの方針で進めるか\n**選択肢**:\n- A: 小さく — 影響: 速い\n- B: 大きく — 影響: 遅い\n**推奨**: A — 小さい", createdAt: new Date().toISOString() });
  await imported(true);
  await post(`/api/tasks/${fire}/outcome`, { reviewed: true });
  await until(() => comments(305).some((c: Json) => c.body.includes("（方針 ") && c.body.includes("を適用: この PBI 内 / decide approach / 条件 なし / 期限 ")), "the policy answers #305 again, with its basis");
  const p2 = await task("方針で許可される Task", "claude", "exec", (s) => s === "waiting" || approvedBy(core.db.listTasks().find((t) => t.title === "方針で許可される Task")!.id).length > 0);
  await until(() => approvedBy(p2).length > 0, "the approval is allowed by the policy");
  assert(approvedBy(p2)[0] === `policy:${repo.id}`, `allowed by ${approvedBy(p2)}`);
  await imported(true);
  await open();
  await until(async () => (await asksNow()).some((x) => x.id.startsWith(d305) && x.state === "answered" && x.policy.applied), "the answered card names its policy");
  await open();
  assert(await evaluate(`${card(d305)}?.querySelector('.ask-applied')?.textContent.startsWith('方針で回答: pbi / decide approach')`), "the card says 方針で回答");
  assert(!(await asksNow()).some((x) => x.kind === "approval" && x.task?.id === p2 && x.state === "open"), "an allowed approval is not asked");
  assert((await policies()).every((p) => p.uses.length >= 1), "each policy keeps its use");
  await shot("asks-policy-applied-1280.png");

  // (e) another PBI asking the same: not answered, the card says why and what differs
  issue(308).labels.nodes.push({ name: "needs-decision" });
  comments(308).push({ body: "## 判断待ち\n**問い**: こちらはどの方針で進めるか\n**選択肢**:\n- A: 小さく — 影響: 速い\n- B: 大きく — 影響: 遅い\n**推奨**: A — 小さい", createdAt: new Date().toISOString() });
  const st308 = await task("#308 計画", "codex", "done", (s) => s !== "running");
  stageOf(st308, 308);
  stopOf("approach-b", st308, 308, "s-308");
  await imported(true);
  await post(`/api/tasks/${fire}/outcome`, { reviewed: false });
  await open();
  const d308 = `decision:${meta.id}#308@`;
  await cardOf(d308);
  const prev = await until(async () => { const t = await evaluate(`${card(d308)}?.querySelector('.ask-previous')?.textContent ?? ''`) as string; return t || null; }, "#308 says why it asks again");
  assert(prev.includes("前回と違うので確認します") && prev.includes("適用しなかった理由: 別の PBI") && prev.includes("対象: approach → approach-b"), `previous: ${prev}`);
  assert(((await asksNow()).find((x) => x.id.startsWith(d308))?.state) === "open", "#308 stays open");

  // (f) what always asks: a security merge check, the runner's refusal, a Knowledge confirm rule
  const sec = await checkTask("セキュリティの確認 Task", "check");
  core.db.appendEvent(sec, { t: "stop.record", stop: { id: "s-sec", work: { workspaceId: meta.id, issue: null, taskId: sec }, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "merge check", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 3_600_000 } } as AgentEvent);
  const secAsk = (await asksNow()).find((x) => x.id.startsWith(`check:${sec}:`))!;
  const repliesBefore = replies.length;
  const refusedSave = await answerWith(secAsk.id, { kind: "choice", choice: secAsk.choices[0] }, { scope: "repo", target: "PR #12", when: [], expiresAt: expires(7) });
  const refusedBody = (await refusedSave.json()) as Json;
  assert(refusedSave.status === 409 && refusedBody.error === "セキュリティのマージ確認は毎回聞きます" && replies.length === repliesBefore && (await policies()).length === 2, `security check: ${refusedSave.status} ${JSON.stringify(refusedBody)}`);
  const refusedCard = await evaluate(`${card(`stop:task:${refused}`)}.querySelector('.ask-policy-note')?.textContent ?? ''`) as string;
  assert(refusedCard === "ランナー側の拒否は保存した方針では解除できません", `refused note: ${refusedCard}`);
  // (g) edit from the settings: narrowed to bun test packages/*, the next command outside it is asked; revoked, nothing matches; restored, it matches again
  await open();
  await settings();
  const rowOf = (id: string) => `document.querySelector('.policy-row[data-policy=${JSON.stringify(id)}]')`;
  await evaluate(`[...${rowOf(repo.id)}.querySelectorAll('button')].find(b => b.textContent.trim() === '編集').click()`);
  await typeInto(`.policy-row[data-policy='${repo.id}'] .policy-edit input:not([type])`, "bun *");
  const editHint = await evaluate(`[...${rowOf(repo.id)}.querySelectorAll('.policy-edit .hint')].map(h => h.textContent)`) as string[];
  assert(editHint.includes("広い指定: bun のどのサブコマンドにも当たります"), `edit warning: ${JSON.stringify(editHint)}`);
  await typeInto(`.policy-row[data-policy='${repo.id}'] .policy-edit input:not([type])`, "bun test packages/*");
  await evaluate(`[...${rowOf(repo.id)}.querySelectorAll('button')].find(b => b.textContent.trim() === '保存').click()`);
  await until(async () => (await policies()).find((p) => p.id === repo.id)?.target === "bun test packages/*", "the edited target is saved");
  const p4 = await task("編集後に聞かれる Task", "claude", "exec2", (s) => s === "waiting");
  assert(approvedBy(p4).length === 0 && status(p4) === "waiting", "a command outside the edited target is asked");
  const p5 = await task("編集後に許可される Task", "claude", "exec", (s) => s === "waiting" || approvedBy(core.db.listTasks().find((t) => t.title === "編集後に許可される Task")!.id).length > 0);
  await until(() => approvedBy(p5).length > 0, "a command inside the edited target is allowed");
  await evaluate(`[...${rowOf(repo.id)}.querySelectorAll('button')].find(b => b.textContent.trim() === '無効にする').click()`);
  await until(() => evaluate(`${rowOf(repo.id)}?.querySelector('.badge')?.textContent === '無効'`), "the badge says 無効");
  const p6 = await task("無効後に聞かれる Task", "claude", "exec", (s) => s === "waiting");
  assert(approvedBy(p6).length === 0 && status(p6) === "waiting", "a revoked policy asks again");
  await evaluate(`[...${rowOf(repo.id)}.querySelectorAll('button')].find(b => b.textContent.trim() === '有効にする').click()`);
  await until(() => evaluate(`${rowOf(repo.id)}?.querySelector('.badge')?.textContent === '有効'`), "the badge says 有効 again");
  const p7 = await task("再有効後に許可される Task", "claude", "exec", (s) => s === "waiting" || approvedBy(core.db.listTasks().find((t) => t.title === "再有効後に許可される Task")!.id).length > 0);
  await until(() => approvedBy(p7).length > 0, "the restored policy allows again");
  // what always asks, after the edits above (so that the edited policy is what is tested there): a Knowledge confirm rule
  mkdirSync(join(home, "knowledge", "rules"), { recursive: true });
  writeFileSync(join(home, "knowledge", "rules", "confirm.md"), "---\napproval: { confirm: ['bun test packages*'] }\n---\nrules\n");
  await fetch(`${base}/api/knowledge/reindex`, { method: "POST" });
  const p3 = await task("都度確認の Task", "claude", "exec", (s) => s === "waiting");
  await open();
  await cardOf(`approval:${p3}:`);
  const confirmNote = await evaluate(`${card(`approval:${p3}:`)}.querySelector('.ask-policy-note')?.textContent ?? ''`) as string;
  assert(confirmNote.startsWith("都度確認のルール rules/confirm.md: bun test packages* に当たります"), `confirm note: ${confirmNote}`);
  assert(approvedBy(p3).length === 0 && status(p3) === "waiting", "a confirm rule keeps the approval asked");
  await shot("asks-policy-edited-1280.png");
  // (h) 今回のみ: the form opened and left at 今回のみ keeps the answer as a one-time policy, listed in the settings
  const stopFor = (taskId: string, op: string, target: string, id: string) =>
    core.db.appendEvent(taskId, { t: "stop.record", stop: { id, work: { workspaceId: meta.id, issue: null, taskId }, op, target, reason: "decision", evidence: "判断が要る", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 3_600_000 } } as AgentEvent);
  const n0 = (await policies()).length;
  const once = await checkTask("今回のみの Task", "checknopr");
  stopFor(once, "ask-user", "continue", "s-once");
  await open();
  await cardOf(`check:${once}:`);
  await openForm(`check:${once}:`);
  await press(`check:${once}:`, "A で進める");
  await until(async () => (await policies()).length === n0 + 1, "the one-time policy is saved");
  const onePolicy = (await policies()).find((p) => p.scope === "once")!;
  assert(onePolicy.askId?.startsWith(`check:${once}:`) && onePolicy.expiresAt === null && onePolicy.target === "continue", `once policy: ${JSON.stringify(onePolicy)}`);
  await open();
  await settings();
  assert(await evaluate(`!![...document.querySelectorAll('.policy-row')].find(r => r.textContent.includes('ask-user: continue') && r.textContent.includes('今回のみ'))`), "the settings list the one-time policy");

  // (i) the PR's head changed since a policy was saved on it: nothing is answered, the card says what differs
  const pr14 = await checkTask("PR #14 の確認", "check14");
  stopFor(pr14, "gh pr merge", "PR #14", "s-pr14");
  await open();
  await cardOf(`check:${pr14}:`);
  await openForm(`check:${pr14}:`);
  await pickScope(`check:${pr14}:`, "このリポジトリ");
  await press(`check:${pr14}:`, "推奨案で進める（A）");
  await until(async () => (await policies()).some((p) => p.target === "PR #14"), "the PR #14 policy is saved");
  const on14 = (await policies()).find((p) => p.target === "PR #14")!;
  assert(on14.from.head === heads["14"], `saved on head ${on14.from.head}`);
  const repliesBefore14 = replies.filter((r) => r.prompt === "check14").length;
  heads["14"] = "f".repeat(40);
  const pr14b = await checkTask("PR #14 の確認（更新後）", "check14");
  stopFor(pr14b, "gh pr merge", "PR #14", "s-pr14b");
  await post(`/api/tasks/${pr14b}/outcome`, { reviewed: false });
  await open();
  await cardOf(`check:${pr14b}:`);
  const moved = await until(async () => { const t = await evaluate(`${card(`check:${pr14b}:`)}?.querySelector('.ask-previous')?.textContent ?? ''`) as string; return t || null; }, "the changed head is said on the card");
  assert(moved.includes("前回と違うので確認します") && moved.includes("適用しなかった理由: PR の差分が変わった") && moved.includes("PR の差分が変わりました（eeeeeee → fffffff）"), `moved: ${moved}`);
  assert(replies.filter((r) => r.prompt === "check14").length === repliesBefore14, "the changed PR was answered by the old policy");
  await shot("asks-policy-head-1280.png");
  report.policies = { saved: 2, applied: ["decision", "approval"], again: prev, edited: "bun test packages/*", broadWarned: [broad[2], editHint[0]] };

  // 8. 390 × 844: the form on a card, and the list in the settings, nothing sideways
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  const n390 = (await policies()).length;
  const p8 = await task("390 で方針を保存する Task", "claude", "exec3", (s) => s === "waiting");
  await open();
  await cardOf(`approval:${p8}:`);
  await evaluate(`(() => { const c = ${card(`approval:${p8}:`)}; c.scrollIntoView(); })()`);
  await openForm(`approval:${p8}:`);
  await pickScope(`approval:${p8}:`, "このリポジトリ");
  const w390 = await evaluate("document.documentElement.scrollWidth") as number;
  assert(w390 <= 390, `the form scrolls sideways at 390px (${w390})`);
  await shot("asks-policy-form-390.png");
  await press(`approval:${p8}:`, "承認して続行");
  await until(async () => (await policies()).length === n390 + 1, "the policy saved at 390");
  await settings();
  const wList = await evaluate("document.documentElement.scrollWidth") as number;
  assert(wList <= 390, `the policy list scrolls sideways at 390px (${wList})`);
  await shot("asks-policy-settings-390.png");
  report.policies390 = { form: w390, list: wList };

  // 9. #2221: screen mockups — a Task with two HTML artifacts; #307's ## 判断待ち and an operational check name it
  const mockDir = join(home, "mock");
  mkdirSync(mockDir);
  const mt = await post("/api/tasks", { cwd: mockDir, title: "画面イメージを作る Task", prompt: "done", runner: "codex" });
  await until(() => status(mt.id) !== "running", "the mockup Task");
  mockTask = mt.id;
  for (const [k, name] of [["a", "A: 上に並べる"], ["b", "B: 下に並べる"]] as const) {
    writeFileSync(join(mockDir, `${k}.html`), `<!doctype html><meta charset="utf-8"><body><h1>案 ${k.toUpperCase()} の画面</h1></body>`);
    const r = await post(`/api/tasks/${mt.id}/artifacts`, { source: join(mockDir, `${k}.html`), title: `画面イメージ ${name}` });
    assert(r.id, `artifact ${k}: ${JSON.stringify(r)}`);
  }
  issue(307).labels.nodes.push({ name: "needs-decision" });
  comments(307).push({ body: `## 判断待ち\n**問い**: どちらの画面にするか\n**選択肢**:\n- A: 上に並べる — 影響: 1 回で届く\n- B: 下に並べる — 影響: 2 回で届く\n**推奨**: A — 手数が少ない\n**画面イメージ**: ${mt.id}`, createdAt: new Date().toISOString() });
  const mc = await checkTask("画面を選ぶ確認", "checkmock");
  await imported(true);
  /** The mockup buttons under `scope`, and the text inside the opened one's frame (its own opaque origin: read over CDP). */
  const mockButtons = (scope: string) => evaluate(`[...(${scope}).querySelectorAll('.mockups button.mockup')].map(b => b.textContent.trim())`) as Promise<string[]>;
  const frameText = async (scope: string) => {
    const src = await until(() => evaluate(`(${scope}).querySelector('.mockups iframe.art-frame')?.src ?? null`) as Promise<string | null>, "the opened mockup's frame");
    // a sandboxed frame is a process of its own (an out-of-process iframe): attach to its target and read it there
    const read = async () => {
      const target = ((await call("Target.getTargets")).targetInfos as Json[]).find((t) => t.type === "iframe" && t.url === src);
      if (!target) return null;
      const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      try {
        const r = await callIn(sessionId, "Runtime.evaluate", { expression: "document.body?.innerText ?? ''", returnByValue: true });
        return (r.result.value as string) || null;
      } finally {
        await call("Target.detachFromTarget", { sessionId });
      }
    };
    return until(read, "the mockup's text in its frame");
  };
  const checkMock = async (width: number) => {
    await open();
    for (const prefix of [`decision:${meta.id}#307@`, `check:${mc}:`]) {
      await cardOf(prefix);
      const names = await until(async () => { const n = await mockButtons(card(prefix)); return n.length ? n : null; }, `mockup buttons on ${prefix}`);
      assert(same(names, ["画面イメージ A: 上に並べる", "画面イメージ B: 下に並べる"]), `${prefix} at ${width}: ${JSON.stringify(names)}`);
      await evaluate(`[...${card(prefix)}.querySelectorAll('.mockups button.mockup')][1].click()`);
      const text = await frameText(card(prefix));
      assert(text.includes("案 B の画面"), `${prefix} B at ${width}: ${text}`);
      assert(await evaluate(`${card(prefix)}.querySelector('.mockups button.mockup[aria-pressed="true"]').textContent.includes('B:')`), `${prefix}: B pressed`);
      // the buttons to answer stay on the card
      assert(await evaluate(`!!${card(prefix)}.querySelector('.ask-button, textarea')`), `${prefix}: answer area at ${width}`);
    }
    await evaluate(`${card(`check:${mc}:`)}.querySelector('.mockups').scrollIntoView({ block: "start" })`);
    await shot(`asks-mockups-${width}.png`);
    const w = await evaluate("document.documentElement.scrollWidth") as number;
    assert(w <= width, `the 判断待ち screen with a mockup scrolls sideways at ${width}px (${w})`);
    // the Backlog's answer box for #307: the same buttons over it, B opens, the answer box is still there
    await press(`decision:${meta.id}#307@`, "Backlog で答える");
    const decisionCard = `[...document.querySelectorAll('section[data-stage="needs-decision"] .decision-card')].find(c => c.querySelector('a').href.endsWith('/307'))`;
    await until(() => evaluate(`!!(${decisionCard})?.querySelector('.decision')`).catch(() => false), "#307 in the Backlog");
    const inBacklog = await until(async () => { const n = await mockButtons(decisionCard); return n.length ? n : null; }, "mockup buttons in the Backlog");
    assert(same(inBacklog, ["画面イメージ A: 上に並べる", "画面イメージ B: 下に並べる"]), `Backlog at ${width}: ${JSON.stringify(inBacklog)}`);
    await evaluate(`[...(${decisionCard}).querySelectorAll('.mockups button.mockup')][1].click()`);
    assert((await frameText(decisionCard)).includes("案 B の画面"), `Backlog B at ${width}`);
    assert(await evaluate(`!!(${decisionCard}).querySelector('.decision textarea') && [...(${decisionCard}).querySelectorAll('.decision button')].some(b => b.textContent.trim() === '回答する')`), `the Backlog's answer box at ${width}`);
    const wb = await evaluate("document.documentElement.scrollWidth") as number;
    assert(wb <= width, `the Backlog with a mockup scrolls sideways at ${width}px (${wb})`);
    await evaluate(`(${decisionCard}).querySelector('.mockups').scrollIntoView({ block: "start" })`);
    await shot(`backlog-mockups-${width}.png`);
  };
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await checkMock(1280);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await checkMock(390);
  report.mockups = { task: mt.id, widths: [1280, 390] };

  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ...report, answered, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
