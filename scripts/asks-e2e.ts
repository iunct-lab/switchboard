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
 * #1675: the すぐ答えられる badge (the tool approval and #306, not #303) and its toggle — the person's narrowed to them in
 * their order, together with the second Workspace, and back — at 1280; the toggle a 44px target at 390.
 * #1674: #306's decision, which the Ready #309 names as its prerequisite, is the first of the person's with 答えると 1 件が進められる.
 * #2221: a decision and an operational check that name a Task's two screen mockups — a button each on their cards, the
 * pressed one opened in the card, the same buttons over the Backlog's answer box — at 1280 and 390.
 * #3058: a question tool's three questions (two with options, one without) on one card — a free-text field only on the
 * one without, one 回答する once all are answered, one reply — on the 判断待ち screen at 1280 and the Task screen at 390;
 * a card whose one question has no options takes no answer (its link 「Task の会話で答える」); nothing sideways at 390.
 * #3124: the operational checks are a question tool's question (`question.ask`), answered by choosing an option and 回答する.
 * Rows: the person's questions are a row per PBI (else Task) that opens in place, the tool approvals cards of their own above them, and where to go is a
 * link (「Task の会話を見る」 / 「Task の会話で答える」); the Workspace counts and the heading's are rows; an opened row stays opened when the list is read again.
 * #4786: a question tool's question is on its card once, line breaks kept, with no 次回も使う form; a Task whose PR moved, and one
 * with an old stop, are answered with the option and the reply reaches the Task — at 1280 and 390 (nothing sideways).
 * A stage Task's stop that took a long last reply: its row opens to the reason, the last reply (six lines, 全文 for the rest), where the
 * reply goes and the box; the reply reaches the Task once and it runs; at 390 nothing sideways and the button a 44px target.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Ask, AskQuestion, RunnerAdapter, RunnerId, Task } from "@switchboard/protocol";
import { importing, sending } from "../packages/core/fixtures/github-import.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { rowKey } from "../apps/web/src/asks.ts";
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
// two Ready PBIs whose stage Tasks stop below with a long last reply (they are in the first import: a PBI added later is not read)
for (const [n, title] of [[310, "返信を待つ工程 Task"], [311, "スマホで見る工程 Task"]] as const) pages[0].data.repository.issues.nodes.push({ ...structuredClone(issue(304)), number: n, title: `PBI: ${title}`, url: `https://github.com/acme/app/issues/${n}`, body: "**Story Points**: 2\n", subIssuesSummary: { total: 0, completed: 0 } });
const waitStates: Json = { w779: { __typename: "PullRequest", state: "OPEN" }, w306: { __typename: "Issue", state: "OPEN" } };

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
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: JSON.stringify({ data: { repository: waitStates } }), stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
delete process.env.SWITCHBOARD_PROJECT_URL;
// the checkout's origin reads as the fake registration (#2799 starts no Task in a clone of another repository)
const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: import.meta.dir, encoding: "utf8" });
if (origin.status === 0) Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/acme/app.git.insteadOf", GIT_CONFIG_VALUE_0: origin.stdout.trim() });

/** #3124: an operational check is a question tool's question (`question.ask`), not a block in a reply. */
const OPTION = "マージする (Recommended)";
const mergeQuestion = (pr: number, more = ""): AskQuestion => ({ header: null, question: `PR #${pr} をマージしてよいか${more}`, options: [{ label: OPTION, description: "影響: main に入る" }, { label: "待つ", description: "影響: 後続が止まる" }], multiSelect: false });
const confirmQuestion = (yes: string, no?: string): AskQuestion => ({ header: null, question: "続けるか", options: [{ label: yes, description: "影響: 進む" }, ...(no ? [{ label: no, description: "影響: 止まる" }] : [])], multiSelect: false });
/** The question of a check prompt ("check" / "check13" / "check14": a merge check of that PR). */
const CHECKS: Record<string, AskQuestion> = {
  check: mergeQuestion(12),
  check13: mergeQuestion(13),
  checkstale: mergeQuestion(15),
  checkmulti: mergeQuestion(14, "\n理由: 差分は小さい\n影響: main に入る"),
  checknopr: confirmQuestion("はい", "いいえ"),
  limit: confirmQuestion("続ける"),
  budget: confirmQuestion("続ける"),
  checkmock: { header: null, question: "どちらの画面にするか", options: [{ label: "上に並べる (Recommended)", description: "影響: 1 回で届く" }, { label: "下に並べる", description: "影響: 2 回で届く" }], multiSelect: false },
};
const LIMIT = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
const answered: string[] = [];
/** #3058: the question tool's questions of the "questions" and "questionfree" prompts. */
const QUESTION_SCRIPTS: Record<string, AskQuestion[]> = {
  questions: [
    { header: "場所", question: "どこを直すか", options: [{ label: "web", description: "画面" }, { label: "core", description: "デーモン" }], multiSelect: false },
    { header: null, question: "何を足すか", options: [{ label: "テスト", description: null }, { label: "文書", description: null }], multiSelect: true },
    { header: null, question: "ほかに", options: [], multiSelect: false },
  ],
  questionfree: [{ header: null, question: "何を直せばよいか", options: [], multiSelect: false }],
};
const replies: Array<{ prompt: string; text: string }> = [];
// the last reply of a stage Task that stopped: eight lines, the last a long unbroken one (it wraps at 390), the end of it only under 全文
const STOP_REPLY = ["調べた結果を報告します。", "- 1 つ目: 型は通りました", "- 2 つ目: テストは 1 件だけ落ちています", "- 3 つ目: 原因は設定の読み違いです", "- 4 つ目: 直し方は 2 通りあります", "- 5 つ目: どちらも小さな変更です", "- 6 つ目: 影響は画面だけです", "- 7 つ目: 続けてよいか教えてください https://example.com/a/very/long/path/that/does/not/break/anywhere/at/all/0123456789/0123456789", "以上です。返信を待ちます。"].join("\n");
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
    const execAsk = (command: string): AgentEvent[] => [{ t: "permission.ask", id: "perm1", kind: "exec", tool: "Bash", input: { command }, detail: command }];
    const asked = CHECKS[opts.prompt] ? [CHECKS[opts.prompt]!] : QUESTION_SCRIPTS[opts.prompt];
    const script: AgentEvent[] = asked ? [{ t: "question.ask", id: "q1", questions: asked }, { t: "session.end", status: "ok", summary: "Waiting for your choices" }] : opts.prompt.includes("/pbi-complete") ? [] : opts.prompt === "exec" ? execAsk("bun test packages/core") : opts.prompt === "exec2" ? execAsk("bun test apps/web") : opts.prompt === "exec3" ? execAsk("git status --short") : opts.prompt === "stopreply" ? [{ t: "session.end", status: "ok", summary: STOP_REPLY }] : opts.prompt === "write" ? [{ t: "permission.ask", id: "perm1", kind: "write", tool: "Write", input: { file_path: "/tmp/x" }, detail: "write x" }] : [{ t: "session.end", status: "ok", summary: "done" }];
    queueMicrotask(() => script.forEach((ev) => emit(ev)));
    return {
      send(text: string) {
        replies.push({ prompt: opts.prompt, text });
        // a stage Task that goes on after a reply echoes it and says so, as a real runner does: the stop's answer is read from the echoed message
        if (opts.prompt === "stopreply") queueMicrotask(() => [{ t: "message.delta", role: "user", text } as AgentEvent, { t: "message.delta", role: "assistant", text: "続けます" } as AgentEvent].forEach((ev) => emit(ev)));
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
async function until<T>(fn: () => T | Promise<T>, label: string, seen?: () => unknown): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  let last: unknown;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; last = seen ? await seen() : value; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}（最後の値: ${(JSON.stringify(last) ?? String(last)).slice(0, 200)}）`);
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Json>);
// A comment waits 60 s before it goes to GitHub, so it can be taken back (a8bcd189, #3719). This script's answers are not waited out for a minute each: the window is over as soon as it is looked at, as the unit tests of backlog-send write it
// (the comment's `retry_at` is its window's end; null = due), and the screen's refresh sends what is due (GET /api/backlog?refresh=1). The window itself is backlog-send.test.ts's and backlog.test.ts's.
const imported = async (refresh: boolean) => {
  let b = await (await fetch(`${base}/api/backlog${refresh ? "?refresh=1" : ""}`)).json() as Json;
  while (b.syncs.some((s: Json) => s.syncing)) { await Bun.sleep(20); b = await (await fetch(`${base}/api/backlog`)).json(); }
};
const windowOver = async () => { core.db.sqlite.query("UPDATE backlog_operations SET retry_at = NULL WHERE kind = 'comment' AND status = 'pending' AND attempt = 0").run(); await imported(true); return true; };
await imported(false);
// #1177: a Task past settings.maxRunners (default 3) waits idle in the run-slot queue and is no card or resume. The seed Tasks below that stay running / waiting
// (a tool approval, a stage Task, the checks) are more than 3, so the limit is raised to its largest (8), as a person would in Settings.
const limit = await fetch(`${base}/api/settings`, { method: "PATCH", headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ maxRunners: 8 }) });
assert(limit.ok && (await limit.json() as Json).maxRunners === 8, `maxRunners 8: ${limit.status}`);
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
// the judge of this script never answers (judge: never resolves), and since 95b76b3c a Task whose reply is still being judged counts as working: #306's stage Task would be the active one and
// the answer below would not start a 実装. Its judgement is over here, as a real daemon's is by the time the person answers.
core.db.updateTask(stage, { judgingAt: null });
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
  // an expression that names a question's card (card(prefix) below) opens the row the card is in first: the rows are closed
  // when the screen opens. A question the list does not have (answered here and kept, or not come yet) has no row to open;
  // one the list has whose row does not open throws here, where the cause is
  let openRowOf: (prefix: string) => Promise<void> = async () => undefined;
  const evaluate = async (expression: string): Promise<Json> => {
    for (const m of expression.matchAll(/dataset\.ask\.startsWith\(("(?:[^"\\]|\\.)*")\)/g)) await openRowOf(JSON.parse(m[1]!));
    return evaluateNow(expression);
  };
  const evaluateNow = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300) + " in " + expression.slice(0, 260));
    return result.result.value;
  };
  /** Opens the folded Settings card with this title (#3849), once Settings has drawn it: a card shows only its title until opened. */
  const openSettingsCard = (title: string) => until(() => evaluate(`(() => { const d = [...document.querySelectorAll('.settings details.card')].find((d) => d.querySelector('summary').textContent.trim() === ${JSON.stringify(title)}); if (d) d.open = true; return !!d; })()`), `the ${title} card`);
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");

  /** The screen as groups of `<kind>` labels, e.g. { person: ["ツール承認", …] }. */
  const groups = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.ask-group')].map(g => [g.className.match(/ask-group-(\\w+)/)[1], [...g.querySelectorAll('.card.ask .ask-kind, .ask-row-head .ask-kind')].map(k => k.textContent).sort()]))`) as Promise<Record<string, string[]>>;
  const card = (prefix: string) => `[...document.querySelectorAll('[data-ask]')].find(c => c.dataset.ask.startsWith(${JSON.stringify(prefix)}))`;
  /** The folded group (`auto` / `done`) opened, so its cards are on the screen. */
  const unfold = (key: string) => evaluate(`(() => { const d = document.querySelector('.ask-group-${key}'); if (!d.open) d.querySelector('summary').click(); })()`);
  /** The row a question is in (a tool approval is a card of its own, so it has none): opened if it is closed, so the question's card is on the screen. */
  const openRow = async (prefix: string) => {
    if (await evaluateNow(`!!${card(prefix)}`)) return;
    const found = ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks.find((x) => x.id.startsWith(prefix));
    assert(found, `no question ${prefix} among ${JSON.stringify(((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks.map((x) => x.id.slice(0, 40)))}`);
    const row = JSON.stringify(rowKey(found!));
    // a question with no row (a tool approval, another group's card) is a card of its own once the screen has read the list
    await until(() => evaluateNow(`!!document.querySelector('[data-row=' + JSON.stringify(${row}) + ']') || !!${card(prefix)}`), `the row or the card of ${prefix}`);
    if (await evaluateNow(`!!${card(prefix)}`)) return;
    await evaluateNow(`(() => { const b = document.querySelector('[data-row=' + JSON.stringify(${row}) + '] > button'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
    await until(() => evaluateNow(`!!${card(prefix)}`), `the card of ${prefix}`);
  };
  /** openRow for a question the list has; one it does not have (answered here and kept, or not come yet) is left as it is. */
  const openListed = async (prefix: string) => {
    if (await evaluateNow(`!!${card(prefix)}`)) return;
    const listed = ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks.some((x) => x.id.startsWith(prefix));
    if (listed) await openRow(prefix);
  };
  openRowOf = openListed;
  const facts = async (prefix: string) => { await openListed(prefix); return evaluate(`Object.fromEntries([...${card(prefix)}.querySelectorAll('.ask-fact')].map(f => [f.querySelector('dt').textContent, { text: f.querySelector('dd').textContent, href: f.querySelector('a')?.href ?? null }]))`) as Promise<Record<string, { text: string; href: string | null }>> };
  /** #4068: the card's question (above the answer buttons, not a fact row) and the one 「不明: …」 line that names the facts the records do not have. */
  const questionOf = async (prefix: string) => { await openListed(prefix); return evaluate(`${card(prefix)}.querySelector('.ask-question')?.textContent ?? null`) as Promise<string | null> };
  const unknownOf = async (prefix: string) => { await openListed(prefix); return evaluate(`${card(prefix)}.querySelector('.ask-unknown')?.textContent ?? null`) as Promise<string | null> };
  /** A link under a row (or a card of its own): a button or an anchor with this text. */
  const link = async (prefix: string, label: string) => { await openRow(prefix); return evaluate(`(() => { const c = ${card(prefix)}; (c.closest('.ask-row') ?? c.parentElement).querySelector('.ask-links') && [...(c.closest('.ask-row') ?? c.parentElement).querySelectorAll('.ask-links .link')].find(l => l.textContent.trim().startsWith(${JSON.stringify(label)})).click(); })()`); };
  const press = async (prefix: string, label: string) => { await openRow(prefix); return evaluate(`[...${card(prefix)}.querySelectorAll('button')].find(b => (b.childNodes[0]?.textContent ?? '').trim() === ${JSON.stringify(label)}).click()`); };
  /** #3124: a question tool's check is answered by choosing an option and pressing 回答する. */
  const choose = async (prefix: string, label: string) => { await openListed(prefix); return evaluate(`[...${card(prefix)}.querySelectorAll('.ask-questions label.opt')].find(l => l.textContent.trim().startsWith(${JSON.stringify(label)})).querySelector('input').click()`) };
  const answerCheck = async (prefix: string, label: string) => {
    await choose(prefix, label);
    await evaluate(`[...${card(prefix)}.querySelectorAll('.ask-questions button')].find(b => b.textContent.trim() === '回答する').click()`);
  };
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
  const before = await until(async () => { const g = await groups(); return g.person?.length === 6 ? g : null; }, "six of the person's", groups);
  // a row per target: the two approvals (a card each), #308's two criteria (one row), #306, #303 and the Task that asks (one row each)
  assert(same(before.person, ["ツール承認", "ツール承認", "利用者確認", "実装の判断", "実装の判断", "質問"]), `person: ${JSON.stringify(before.person)}`);
  assert(same(before.auto, ["依存待ち", "停止"]), `auto: ${JSON.stringify(before.auto)}`);
  assert(same(before.done, ["停止"]), `done: ${JSON.stringify(before.done)}`);
  // the two groups nothing is to be done in are folded into one line with their count: closed on opening, their cards not on the screen, no state kept
  const folds = () => evaluate(`[...document.querySelectorAll('details.ask-fold')].map(d => ({ key: d.className.match(/ask-group-(\\w+)/)[1], open: d.open, head: d.querySelector('summary').textContent.trim(), h: d.querySelector('summary').getBoundingClientRect().height, shown: [...d.querySelectorAll('.card.ask')].filter(c => c.checkVisibility()).length }))`) as Promise<Array<{ key: string; open: boolean; head: string; h: number; shown: number }>>;
  const closed = await folds();
  assert(same(closed.map((f) => f.key), ["auto", "done"]) && closed.every((f) => !f.open && f.shown === 0 && f.h >= 44) && closed[0]!.head === "自動で待っている（操作不要） 2" && closed[1]!.head === "済んだもの 1", `the folded groups: ${JSON.stringify(closed)}`);
  assert(await evaluate(`!document.querySelector('.ask-group-person details.ask-fold') && !document.querySelector('.ask-group-person summary.ask-fold-head')`), "the person's group is not folded");
  // a Workspace that could not be read is told in one card after every group, not above the rows
  const errs = await evaluate(`(() => { const e = document.querySelector('.ask-errors'); const p = document.querySelector('.ask-group-person'); return { text: e?.textContent ?? null, after: !!e && !!p && !!(p.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING), last: !!e && e === document.querySelector('main').lastElementChild, inHead: !!document.querySelector('main > section.card')?.textContent?.includes('second:') }; })()`) as { text: string | null; after: boolean; last: boolean; inHead: boolean };
  assert(errs.text?.includes("second:") && errs.after && errs.last && !errs.inHead, `the Workspace error comes last: ${JSON.stringify(errs)}`);
  // pressing the line opens the cards, the hint with them; pressing again closes them
  await evaluate(`document.querySelector('.ask-group-auto > summary').click()`);
  assert(await evaluate(`document.querySelector('.ask-group-auto').open && document.querySelector('.ask-group-auto').textContent.includes('操作は要りません') && [...document.querySelectorAll('.ask-group-auto .card.ask')].every(c => c.checkVisibility())`), "pressing the automatic group's line opens its cards and the hint");
  await evaluate(`document.querySelector('.ask-group-auto > summary').click()`);
  assert(await evaluate(`!document.querySelector('.ask-group-auto').open`), "pressing the line again closes the group");
  // the rows are closed when the screen opens; a press opens one in place, another press closes it
  const r306 = JSON.stringify(`${meta.id}:pbi:306`);
  const rowState = () => evaluateNow(`(() => { const r = document.querySelector('[data-row=' + JSON.stringify(${r306}) + ']'); return { open: r.querySelector(':scope > button').getAttribute('aria-expanded'), cards: r.querySelectorAll('[data-ask]').length, anyOpen: document.querySelectorAll('.ask-row > button[aria-expanded="true"]').length, cardsInRows: document.querySelectorAll('.ask-row [data-ask]').length }; })()`) as Promise<{ open: string; cards: number; anyOpen: number; cardsInRows: number }>;
  const rowClosed = await rowState();
  assert(rowClosed.open === "false" && rowClosed.cards === 0 && rowClosed.anyOpen === 0 && rowClosed.cardsInRows === 0, `the rows are closed at first: ${JSON.stringify(rowClosed)}`);
  await evaluateNow(`document.querySelector('[data-row=' + JSON.stringify(${r306}) + '] > button').click()`);
  const opened = await until(async () => { const st = await rowState(); return st.open === "true" && st.cards === 1 ? st : null; }, "#306's row opens on a press", rowState);
  await evaluateNow(`document.querySelector('[data-row=' + JSON.stringify(${r306}) + '] > button').click()`);
  const closedAgain = await until(async () => { const st = await rowState(); return st.open === "false" && st.cards === 0 ? st : null; }, "#306's row closes on the second press", rowState);
  report.toggle = { rowClosed, opened, closedAgain };
  await openRow(`decision:${meta.id}#306@`);
  await openRow(`decision:${meta.id}#303@`);
  const full = await facts(`decision:${meta.id}#306@`);
  assert((await questionOf(`decision:${meta.id}#306@`)) === "保存先をどちらにするか" && !((await unknownOf(`decision:${meta.id}#306@`)) ?? "").match(/問い|推奨と根拠|PBI|元の記録/) && full["推奨と根拠"]!.text === "B — 小さい" && full["PBI"]!.href === "https://github.com/acme/app/issues/306" && full["元の記録"]!.href === "https://github.com/acme/app/issues/306" && full["対象リポジトリ"]!.text === meta.name, `#306: ${JSON.stringify(full)} q=${await questionOf(`decision:${meta.id}#306@`)} u=${await unknownOf(`decision:${meta.id}#306@`)} name=${meta.name}`);
  const missing = await facts(`decision:${meta.id}#303@`);
  // 不明 facts are one line now: 「不明: 問い・推奨と根拠…」, no question, no rows of their own
  const missingUnknown = await unknownOf(`decision:${meta.id}#303@`);
  assert((await questionOf(`decision:${meta.id}#303@`)) === null && missingUnknown !== null && missingUnknown.startsWith("不明:") && missingUnknown.includes("問い") && missingUnknown.includes("推奨と根拠") && !missing["問い"] && !missing["推奨と根拠"] && missing["PBI"]!.text.startsWith("#303 "), `#303: ${JSON.stringify(missing)}`);
  const wait = await facts(`wait:${meta.id}#304@`);
  assert(wait["停止理由"]!.text === "PR #779 の完了待ち" && wait["条件"]!.text === "pr#779: open", `#304: ${JSON.stringify(wait)}`);
  // #1674: the question other PBIs wait on comes first, with how many and which
  // the tool approvals go first (a card each); the first row is #306's, with how many it unblocks on its line and the PBI in its question
  const first = await evaluate(`(() => { const r = document.querySelector('.ask-group-person .ask-row'); return { id: r.dataset.row, line: r.querySelector('.ask-row-head .ask-unblocks')?.textContent ?? null, links: [...r.querySelectorAll('.ask-unblocks-list a')].map(a => a.href), before: [...document.querySelectorAll('.ask-group-person > [data-ask]')].length }; })()`) as { id: string; line: string | null; links: string[]; before: number };
  assert(first.id === `${meta.id}:pbi:306` && first.line === "答えると 1 件が進められる" && same(first.links, ["https://github.com/acme/app/issues/309"]) && first.before === 2, `first of the person's: ${JSON.stringify(first)}`);
  assert(await evaluate(`[...document.querySelectorAll('.ask-row-head')].filter(c => c.querySelector('.ask-unblocks')).length`) === 1, "only #306's row says how many it unblocks");
  report.first = first;
  report.before = before;
  await shot("asks-1280.png");

  // #1673: a button per Workspace with the person's count; second narrows every group to its one approval, すべて goes back
  const chips = () => evaluate(`[...document.querySelectorAll('.ask-workspaces button')].map(b => b.textContent.trim())`) as Promise<string[]>;
  const headCount = () => evaluate(`document.querySelector('.approvals .row.head h5 .hint').textContent`) as Promise<string>;
  const shown = () => evaluate(`[...document.querySelectorAll('.card.ask, .ask-row')].map(c => c.dataset.ask ?? c.dataset.row)`) as Promise<string[]>;
  const all = await chips();
  // the count is the rows (a PBI's, else a Task's questions) and the tool approvals, which stay a card each
  assert(same(all, ["すべて", `${meta.name} 5`, "second 1"]), `Workspace buttons: ${JSON.stringify(all)}`);
  assert((await headCount()) === "6", `the heading's count: ${await headCount()}`);
  const sections = await evaluate(`[...document.querySelectorAll('.ask-group-person .ask-workspace-head')].map(h => h.textContent)`) as string[];
  assert(same(sections, [`${meta.name} 4`]), `the person's Workspace headings (rows; the approvals are cards above them): ${JSON.stringify(sections)}`);
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'second 1').click()`);
  const narrowed = await until(async () => { const s = await shown(); return s.length === 1 ? s : null; }, "only the second Workspace's card");
  assert(narrowed[0]!.startsWith(`approval:${s2}:`), `narrowed to: ${JSON.stringify(narrowed)}`);
  assert(same(await groups(), { person: ["ツール承認"] }) && (await headCount()) === "1", `narrowed groups: ${JSON.stringify(await groups())}, count ${await headCount()}`);
  await shot("asks-workspace-1280.png");
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'すべて').click()`);
  await until(async () => (await groups()).person?.length === 6 && (await headCount()) === "6", "すべて shows every Workspace again");
  report.workspaces = { buttons: all, narrowed: narrowed.length };

  // #1675: すぐ答えられる — the tool approval and #306 (recommended) have the badge, #303 (its question 不明) not; the toggle
  // counts the person's badged cards, narrows the person's to them (#303 goes), stacks with the Workspace filter, and goes back
  const quickButton = `document.querySelector('.ask-quick-row button')`;
  const quickOf = (prefix: string) => evaluate(`!!${card(prefix)}?.querySelector('.ask-tags .ask-quick')`) as Promise<boolean>;
  const personIds = () => evaluate(`[...document.querySelectorAll('.ask-group-person .card.ask, .ask-group-person .ask-row')].map(c => c.dataset.ask ?? c.dataset.row)`) as Promise<string[]>;
  const personQuick = () => evaluate(`[...document.querySelectorAll('.ask-group-person .card.ask, .ask-group-person .ask-row')].filter(c => c.querySelector('.ask-tags .ask-quick, .ask-row-head .ask-quick')).length`) as Promise<number>;
  const quick303 = `decision:${meta.id}#303@`;
  assert((await quickOf(`approval:${a}:`)) && (await quickOf(`decision:${meta.id}#306@`)) && !(await quickOf(quick303)), "the approval and #306 are すぐ答えられる, #303 is not");
  const quickCount = await personQuick();
  const quickLabel = await evaluate(`${quickButton}.textContent.trim()`) as string;
  assert(quickLabel === `すぐ答えられる ${quickCount}` && quickCount < 6, `the toggle: ${quickLabel}, badged ${quickCount}`);
  // the screen's half: the fixture has one card without the badge (#303), so this shows the toggle, the count and the
  // stacking work; which questions are quick (and the order kept) is asks.test.ts' -t "quick"
  const order = await personIds();
  await evaluate(`${quickButton}.click()`);
  const quickOnly = await until(async () => { const s = await personIds(); return s.length === quickCount ? s : null; }, "only the すぐ答えられる cards");
  assert(!quickOnly.some((id) => id.startsWith(quick303)) && (await personQuick()) === quickCount, `narrowed to the quick ones: ${JSON.stringify(quickOnly)}`);
  assert(same(quickOnly, order.filter((id) => quickOnly.includes(id))), `the order is kept: ${JSON.stringify(quickOnly)}`);
  await shot("asks-quick-1280.png");
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'second 1').click()`);
  const both = await until(async () => { const s = await personIds(); return s.length === 1 ? s : null; }, "quick and the second Workspace");
  assert(both[0]!.startsWith(`approval:${s2}:`) && (await evaluate(`${quickButton}.textContent.trim()`)) === "すぐ答えられる 1", `quick + second: ${JSON.stringify(both)}`);
  await evaluate(`[...document.querySelectorAll('.ask-workspaces button')].find(b => b.textContent.trim() === 'すべて').click()`);
  await until(async () => (await personIds()).length === quickCount, "すべて keeps the quick filter");
  await evaluate(`${quickButton}.click()`);
  await until(async () => same(await personIds(), order), "pressed again, every card of the person's is back in its order");
  report.quick = { count: quickCount, shown: quickOnly.length, withSecond: both.length };

  // 3. answer (#936): the approval with 承認して続行, tapped twice at once → the runner hears once, the card says 実行中;
  // #306 with its button B: ファイル（推奨） and the one line that says what is written where → ## 回答 and the label off, one 実装 starts, 実行中.
  // The stop that went on is 解消済み
  const badge = async (prefix: string) => { await openListed(prefix); return evaluate(`${card(prefix)}?.querySelector('.ask-resume')?.textContent ?? null`) as Promise<string | null> };
  await evaluate(`(() => { const b = [...${card(`approval:${a}:`)}.querySelectorAll('button')].find(b => b.textContent.trim() === '承認して続行'); b.click(); b.click(); })()`);
  await until(() => answered.includes("perm1:allow"), "the runner got allow");
  await until(async () => (await badge(`approval:${a}:`))?.startsWith("実行中"), "the approval's card says 実行中");
  assert(answered.filter((x) => x === "perm1:allow").length === 1, `allow sent ${answered.length} times`);
  stop(a, "permission", "resolved"); // as a runner reports once it went on: the stop of the approval is resolved
  const d306 = `decision:${meta.id}#306@`;
  const line306 = await evaluate(`(() => { const c = ${card(d306)}; return { button: [...c.querySelectorAll('.ask-button button')].find(b => b.firstChild.textContent === 'B: ファイル（推奨）')?.textContent ?? null, route: [...c.querySelectorAll('.ask-answer-route')].map(r => r.textContent), text: c.textContent }; })()`) as Json;
  assert(line306.button === "B: ファイル（推奨）影響: 移行が要らない", `#306's button: ${line306.button}`);
  assert(line306.route.length === 1 && line306.route[0].includes("答えは Issue #306 に書かれます。続き: #306 の続きの工程 Task"), `#306's route: ${line306.route}`);
  assert(!line306.text.includes("送る:"), "#306's card repeats a 送る line");
  const asked306 = "保存先をどちらにするか";
  assert(line306.text.split(asked306).length - 1 === 1, `#306's question appears ${line306.text.split(asked306).length - 1} times in its card`);
  await press(d306, "B: ファイル（推奨）");
  await until(async () => (await badge(d306))?.startsWith("実行中"), "#306's card says 実行中", () => badge(d306));
  await until(async () => (await windowOver()) && comments(306).some((c: Json) => c.body === "## 回答\n\nB: ファイル — 影響: 移行が要らない") && !issue(306).labels.nodes.some((l: Json) => l.name === "needs-decision"), "#306's ## 回答 and its label off reach GitHub");
  const impl306 = core.db.listTasks().filter((t) => t.title.startsWith("#306 実装: "));
  assert(impl306.length === 1, `#306 実装 Tasks: ${impl306.length}`);
  await imported(true);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  // #306's answered question stays in its row (with the result), not in the answered group
  const after = await until(async () => { const g = await groups(); return (await evaluate(`${card(d306)}?.querySelector('.ask-state')?.textContent === '回答済み'`)) ? g : null; }, "#306 is answered");
  assert(same(after.person, ["ツール承認", "利用者確認", "実装の判断", "実装の判断", "質問"]), `person after: ${JSON.stringify(after.person)}`);
  assert(same(after.done, ["ツール承認", "停止", "停止"]), `done after: ${JSON.stringify(after.done)}`);
  report.after = after;
  // one PBI's two criteria waiting on the user's check are one row, not two cards; opened in place, one is answered with 確認した
  const c308 = `confirm:${meta.id}#308:`;
  await openRow(c308);
  const row308 = await evaluate(`(() => { const r = document.querySelector('[data-row=${JSON.stringify(`${meta.id}:pbi:308`)}]'); return { cards: [...r.querySelectorAll('[data-ask]')].map(c => c.dataset.ask), rows: document.querySelectorAll('.ask-group-person [data-row$=":pbi:308"]').length, open: r.querySelector('button').getAttribute('aria-expanded') }; })()`) as { cards: string[]; rows: number; open: string };
  assert(row308.rows === 1 && row308.open === "true" && row308.cards.length === 2 && row308.cards.every((id) => id.startsWith(c308)), `#308's row: ${JSON.stringify(row308)}`);
  await press(`${c308}2`, "確認した");
  await until(() => evaluate(`${card(`${c308}2`)}?.querySelector('.ask-state')?.textContent === '回答済み'`), "the first criterion of #308 (its line 2) is answered here");
  // the daemon no longer asks it (what reaches GitHub is backlog.test.ts's answerStoredConfirmation)
  await until(async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks.find((x) => x.id === `${c308}2`)?.state !== "open", "#308's criterion is no longer open in the list");
  // a list read again (再読込, and a tool approval that comes) does not close the opened row, and the answered criterion stays in it
  await evaluate(`window.__asksReads = 0; const f = window.fetch; window.fetch = (...a) => { if (String(a[0]).includes('/api/asks')) window.__asksReads++; return f(...a); }`);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  const arriving = await task("読み直しの間に来る承認", "claude", "write", (st) => st === "waiting");
  await until(() => evaluate(`window.__asksReads >= 2 && !!document.querySelector('[data-ask^="approval:${arriving}:"]')`), "the list is read again for the reload and the approval", () => evaluate("window.__asksReads"));
  await Bun.sleep(300);
  const kept308 = await evaluate(`(() => { const r = document.querySelector('[data-row=${JSON.stringify(`${meta.id}:pbi:308`)}]'); return { open: r.querySelector('button').getAttribute('aria-expanded'), cards: r.querySelectorAll('[data-ask]').length }; })()`) as { open: string; cards: number };
  assert(kept308.open === "true" && kept308.cards >= 2, `the opened row after the list was read again: ${JSON.stringify(kept308)}`);
  // the tool approvals are open cards of their own, before every row (never inside one, never folded)
  const firstOrder = await evaluate(`(() => { const g = document.querySelector('.ask-group-person'); const kids = [...g.children].filter(e => e.matches('[data-ask], .ask-workspace')).map(e => e.matches('[data-ask]') ? 'approval' : 'rows'); return { kids, inRow: document.querySelectorAll('.ask-row [data-ask^="approval:"]').length, folded: document.querySelectorAll('.ask-group-person details:not(.ask-record):not(.ask-policy):not(.ask-question)').length }; })()`) as { kids: string[]; inRow: number; folded: number };
  assert(firstOrder.kids.lastIndexOf("approval") < firstOrder.kids.indexOf("rows") && firstOrder.kids.filter((k) => k === "approval").length >= 2 && firstOrder.inRow === 0 && firstOrder.folded === 0, `the approvals go first, open: ${JSON.stringify(firstOrder)}`);
  await Promise.all([post(`/api/tasks/${arriving}/abort`, {})]);
  // where to go is a link, from each state: a row's Issue and Task, a resolved stop's Task, an answered approval's Task; none of them leads to the Backlog tab
  assert((await facts(`decision:${meta.id}#303@`))["元の記録"]!.href === "https://github.com/acme/app/issues/303", "#303's record");
  const links = async (prefix: string) => { await openRow(prefix); return evaluate(`(() => { const c = ${card(prefix)}; const s = c.closest('.ask-row') ?? c.parentElement; return [...s.querySelectorAll('.ask-links .link')].map(l => ({ tag: l.tagName, text: l.textContent.trim(), href: l.href ?? null })); })()`) as Promise<Array<{ tag: string; text: string; href: string | null }>>; };
  const l303 = await links(`decision:${meta.id}#303@`);
  // a decision has no Task of its own: its Issue is the one link of its row; the Task that asks is the one link of its row
  const l306 = await links(`decision:${meta.id}#306@`);
  const lb = await links(`check:${b}:`);
  const issueLink = (n: number) => [["A", "Issue を開く", `https://github.com/acme/app/issues/${n}`]];
  assert(same(l303.map((l) => [l.tag, l.text, l.href]), issueLink(303)) && same(l306.map((l) => [l.tag, l.text, l.href]), issueLink(306)) && same(lb.map((l) => [l.tag, l.text]), [["BUTTON", "Task の会話を見る"]]), `links: #303 ${JSON.stringify(l303)}, #306 ${JSON.stringify(l306)}, the Task's ${JSON.stringify(lb)}`);
  assert(await evaluate(`!/Backlog\\sで答える/.test(document.body.textContent)`), "the screen has a way to answer in the Backlog tab");
  await link(`check:${b}:`, "Task の会話を見る");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task の会話を見る opens the row's Task");
  await open();
  await unfold("done");
  await link(`stop:task:${d}`, "Task の会話を見る");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task の会話を見る opens the task of a stop that went on");
  await open();
  await link(`approval:${a}:`, "Task の会話を見る");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "an answered approval opens its task");

  // 4. 390 × 844: the same groups, nothing sideways, every button a 44px target; the routes again
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await open();
  const phone = await until(async () => { const g = await groups(); return g.person?.length === 4 ? g : null; }, "the groups at 390");
  // opened again, #306 and #308 answered here (the comment of #308 writes its own ## 回答) are in the done group (it stayed in its row only while the screen was open)
  assert(same(phone, { ...after, person: ["ツール承認", "利用者確認", "実装の判断", "質問"], done: ["ツール承認", "停止", "停止", "実装の判断", "実装の判断"] }), `390: ${JSON.stringify(phone)}`);
  const width = await evaluate("document.documentElement.scrollWidth") as number;
  const wide = width > 390 ? await evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > 391).slice(0, 6).map(e => e.tagName + '.' + e.className)`) : [];
  assert(width <= 390, `scrolls sideways at 390px (${width}): ${JSON.stringify(wide)}`);
  assert(await evaluate(`!!document.querySelector('.ask-workspaces')`), "the Workspace buttons at 390");
  assert(await evaluate(`!!document.querySelector('.ask-quick-row button')`), "the すぐ答えられる toggle at 390");
  // the toggle comes first in the sideways row: however many Workspaces there are, it is on the first screen
  assert(await evaluate(`(() => { const f = document.querySelector('.ask-filters'); const r = document.querySelector('.ask-quick-row button').getBoundingClientRect(); return f.firstElementChild.matches('.ask-quick-row') && r.left >= 0 && r.right <= window.innerWidth; })()`), "the すぐ答えられる toggle is first in the row, not scrolled off at 390");
  const small = await evaluate(`[...document.querySelectorAll('.ask-row-head, .ask .approval-actions button, .ask-workspaces button, .ask-quick-row button')].filter(b => b.getBoundingClientRect().height < 44).length`);
  assert(small === 0, `${small} button(s) shorter than 44px`);
  await shot("asks-390.png");
  // a row opens in place at 390 too, its links 44px targets and nothing sideways; then a resolved stop's Task
  await openRow(`decision:${meta.id}#303@`);
  const smallLinks = await evaluate(`[...document.querySelectorAll('.ask-links .link')].filter(b => b.getBoundingClientRect().height < 44).length`);
  assert(smallLinks === 0 && (await evaluate("document.documentElement.scrollWidth")) <= 390, `the opened row at 390: ${smallLinks} short link(s)`);
  await unfold("done");
  await link(`stop:task:${d}`, "Task の会話を見る");
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task の会話を見る at 390");
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
  const cardOf = (prefix: string) => until(async () => { await openListed(prefix); return evaluate(`!!${card(prefix)}`); }, `card ${prefix}`);
  // the merge check whose PR is as its [merge-ask] named: the reply goes, 実行中
  await cardOf(`check:${m12}:`);
  await answerCheck(`check:${m12}:`, OPTION);
  await until(async () => (await badge(`check:${m12}:`))?.startsWith("実行中"), "#12's check says 実行中");
  assert(replies.some((r) => r.prompt === "check" && r.text === `- PR #12 をマージしてよいか: ${OPTION}`), `replies: ${JSON.stringify(replies)}`);
  // a second plain check naming a PR: answered with the option, the one reply reaches the Task (the card reads no PR; that
  // nothing is refused on a PR that moved is the core test "question tool answer goes on whatever the PR")
  await answerCheck(`check:${m13}:`, OPTION);
  await until(() => replies.some((r) => r.prompt === "check13" && r.text === `- PR #13 をマージしてよいか: ${OPTION}`), "#13's answer reaches the Task", () => replies);
  assert(replies.filter((r) => r.prompt === "check13").length === 1, "#13 got more than one reply");
  // a Task with an old stop (CI failed): its question is answered as any other
  const stale = await checkTask("古い停止のある Task", "checkstale");
  core.db.appendEvent(stale, { t: "stop.record", stop: { id: "s-stale", work: { workspaceId: meta.id, issue: null, taskId: stale }, op: "gh pr merge", target: "#15", reason: "input", evidence: "CI が失敗", safety: "before-effect", conditions: [{ key: "ci", value: "failure", met: false }], answer: null, actions: [], state: "waiting", at: Date.now() - 3_600_000 } } as AgentEvent);
  await open();
  await cardOf(`check:${stale}:`);
  assert(await evaluate(`!${card(`check:${stale}:`)}.querySelector('.ask-blocker')`), "an old stop shows a blocker on a question card");
  await answerCheck(`check:${stale}:`, OPTION);
  await until(() => replies.some((r) => r.prompt === "checkstale" && r.text === `- PR #15 をマージしてよいか: ${OPTION}`), "the answer of the Task with an old stop reaches it", () => replies);
  await Promise.all([m13, stale].map((id) => post(`/api/tasks/${id}/abort`, {}))); // their slots are the later checks'
  // a reply the Task refuses (its budget): 再開失敗 with the reason, nothing sent
  await answerCheck(`check:${bud}:`, "続ける");
  const failed = await until(() => badge(`check:${bud}:`).then((b) => (b?.startsWith("再開失敗") ? b : null)), "the refused reply says 再開失敗", () => evaluate(`${card(`check:${bud}:`)}?.textContent ?? "no card"`));
  assert(failed.includes("budget exceeded") && !replies.some((r) => r.prompt === "budget"), `budget: ${failed}`);
  // the reply's turn hits the usage limit: the Task waits for it to lift, among the automatic ones
  await answerCheck(`check:${lim}:`, "続ける");
  await until(() => core.db.getTask(lim)!.resumeAt !== null, "the limit's resumeAt");
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  await unfold("auto");
  await until(() => evaluate(`!![...document.querySelectorAll('.ask-group-auto .card.ask')].find(c => c.dataset.ask.startsWith('resume:${lim}@') && c.textContent.includes('使用上限の解除待ち'))`), "the usage limit's wait among the automatic ones");
  // 保留 on #303: only a ## 保留 is written, the label stays, the card is 保留 and still the person's
  const d303 = `decision:${meta.id}#303@`;
  await press(d303, "保留");
  await until(() => evaluate(`${card(d303)}?.querySelector('.ask-state')?.textContent === '保留'`), "#303 held");
  await until(async () => (await windowOver()) && comments(303).some((c: Json) => c.body.startsWith("## 保留")), "#303's ## 保留 reaches GitHub");
  assert(issue(303).labels.nodes.some((l: Json) => l.name === "needs-decision"), "#303 lost its label");
  await imported(true);
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '再読込').click()`);
  await until(() => evaluate(`!!document.querySelector('.ask-group-person ${"[data-ask^=\\'" + d303 + "\\']"}')`), "#303 held, still the person's");
  // #304: the answer is written but a stop condition still holds it — 再開待ち with the reason, no 実装
  const d304 = `decision:${meta.id}#304@`;
  await cardOf(d304);
  const blocked = await evaluate(`${card(d304)}.querySelector('.ask-blocker')?.textContent ?? ''`) as string;
  assert(blocked === "回答だけでは解除されません: ci: failure", `#304 blocker: ${blocked}`);
  await press(d304, "A: 小さく（推奨）");
  const queued = await until(() => badge(d304).then((b) => (b?.startsWith("再開待ち") ? b : null)), "#304 says 再開待ち");
  assert(queued.includes("ci: failure") && core.db.listTasks().filter((t) => t.title.startsWith("#304 実装: ")).length === 1, `#304: ${queued}`);
  // a Task the runner refused: no answer buttons, and why
  await openRow(`stop:task:${refused}`);
  const ref = await evaluate(`(() => { const c = ${card(`stop:task:${refused}`)}; return { buttons: c.querySelectorAll('.ask-button, .ask-text').length, blocker: c.querySelector('.ask-blocker')?.textContent ?? '', talk: [...c.querySelectorAll('.ask-talk')].map(b => b.textContent.trim()) }; })()`) as Json;
  assert(ref.buttons === 0 && ref.blocker === "op : permission の停止（ランナー側の拒否。回答では解除されません）" && same(ref.talk, ["Task の会話で答える"]), `refused: ${JSON.stringify(ref)}`);
  await shot("asks-answer-1280.png");
  // the one way to answer it is a link to the Task's conversation: pressing it opens that Task's screen
  await evaluate(`${card(`stop:task:${refused}`)}.querySelector('.ask-talk').click()`);
  await until(() => evaluate(`!!document.querySelector('main.task')`), "Task の会話で答える opens the Task");
  await open();
  report.answered1280 = { m12: "実行中", m13: "replied", budget: failed, limit: "usage-limit", hold: "#303", blocked: queued };

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
  await press(d305, "A: 小さく（推奨）");
  await until(async () => (await policies()).length === 2, "the PBI policy is saved");
  const pbi = (await policies()).find((p) => p.scope === "pbi")!;
  assert(pbi.pbi === 305 && pbi.op === "decide" && pbi.target === "approach" && pbi.answer.choice.startsWith("A:"), `pbi policy: ${JSON.stringify(pbi)}`);
  await until(async () => (await windowOver()) && comments(305).some((c: Json) => c.body.startsWith("## 回答")), "#305's ## 回答 reaches GitHub");

  // (c) the settings list the two with range, operation and expiry
  const settings = async () => {
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Settings').click()`);
    await openSettingsCard("回答の方針");
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
  await until(async () => (await windowOver()) && comments(305).some((c: Json) => c.body.includes("（方針 ") && c.body.includes("を適用: この PBI 内 / decide approach / 条件 なし / 期限 ")), "the policy answers #305 again, with its basis");
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

  // the Tasks answered above (their cards are checked) are ended, so they do not hold the run slots the Tasks from here on need (#1177: a Task past the limit waits idle and is no card)
  await Promise.all([a2, p1, p2, m12].map((id) => post(`/api/tasks/${id}/abort`, {})));
  // (f) what always asks: the runner's refusal, a Knowledge confirm rule
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
  await Promise.all([p4, p5, p6, p7].map((id) => post(`/api/tasks/${id}/abort`, {})));
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

  // #4786: a question tool's question on its card at 390 — once, line breaks kept, no 次回も使う form, nothing sideways
  const c390 = await checkTask("390 の質問", "checkmulti");
  await open();
  await cardOf(`check:${c390}:`);
  await evaluate(`${card(`check:${c390}:`)}.scrollIntoView()`);
  const shape390 = await evaluate(`(() => { const c = ${card(`check:${c390}:`)}; return { n: c.textContent.split('PR #14 をマージしてよいか').length - 1, lines: c.querySelector('.ask-question')?.textContent, pre: getComputedStyle(c.querySelector('.ask-question')).whiteSpace, legends: c.querySelectorAll('legend').length, policy: !!c.querySelector('.ask-policy'), reuse: c.textContent.includes('次回も使う'), height: c.querySelector('.ask-questions > button').getBoundingClientRect().height }; })()`) as Json;
  assert(shape390.n === 1 && shape390.lines === "PR #14 をマージしてよいか\n理由: 差分は小さい\n影響: main に入る" && shape390.pre.startsWith("pre") && shape390.legends === 0 && !shape390.policy && !shape390.reuse && shape390.height >= 44, `the question card at 390: ${JSON.stringify(shape390)}`);
  assert((await evaluate("document.documentElement.scrollWidth") as number) <= 390, "the question card scrolls sideways at 390px");
  await shot("asks-check-390.png");
  await choose(`check:${c390}:`, OPTION);
  await answerCheck(`check:${c390}:`, OPTION);
  await until(() => replies.some((r) => r.prompt === "checkmulti" && r.text === `- PR #14 をマージしてよいか\n理由: 差分は小さい\n影響: main に入る: ${OPTION}`), "the multi-line question's answer reaches the Task", () => replies);
  await Promise.all([p3, p8, c390].map((id) => post(`/api/tasks/${id}/abort`, {})));
  // 9. #2221: screen mockups — a Task with two HTML artifacts; #307's ## 判断待ち and an operational check name it
  const mockDir = join(home, "mock");
  mkdirSync(mockDir);
  const mt = await post("/api/tasks", { cwd: mockDir, title: "画面イメージを作る Task", prompt: "done", runner: "codex" });
  await until(() => status(mt.id) !== "running", "the mockup Task");
  for (const [k, name] of [["a", "A: 上に並べる"], ["b", "B: 下に並べる"]] as const) {
    writeFileSync(join(mockDir, `${k}.html`), `<!doctype html><meta charset="utf-8"><body><h1>案 ${k.toUpperCase()} の画面</h1></body>`);
    const r = await post(`/api/tasks/${mt.id}/artifacts`, { source: join(mockDir, `${k}.html`), title: `画面イメージ ${name}` });
    assert(r.id, `artifact ${k}: ${JSON.stringify(r)}`);
  }
  issue(307).labels.nodes.push({ name: "needs-decision" });
  comments(307).push({ body: `## 判断待ち\n**問い**: どちらの画面にするか\n**選択肢**:\n- A: 上に並べる — 影響: 1 回で届く\n- B: 下に並べる — 影響: 2 回で届く\n**推奨**: A — 手数が少ない\n**画面イメージ**: ${mt.id}`, createdAt: new Date().toISOString() });
  const mc = await checkTask("画面を選ぶ確認", "checkmock");
  // #3124: the check's mockups are its own Task's artifacts, titled 画面イメージ A: … / B: …
  for (const [k, name] of [["a", "A: 上に並べる"], ["b", "B: 下に並べる"]] as const) {
    const r = await post(`/api/tasks/${mc}/artifacts`, { source: join(mockDir, `${k}.html`), title: `画面イメージ ${name}` });
    assert(r.id, `check artifact ${k}: ${JSON.stringify(r)}`);
  }
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
      assert(await evaluate(`!!${card(prefix)}.querySelector('.ask-button, textarea, .ask-questions')`), `${prefix}: answer area at ${width}`);
    }
    await evaluate(`${card(`check:${mc}:`)}.querySelector('.mockups').scrollIntoView({ block: "start" })`);
    await shot(`asks-mockups-${width}.png`);
    const w = await evaluate("document.documentElement.scrollWidth") as number;
    assert(w <= width, `the 判断待ち screen with a mockup scrolls sideways at ${width}px (${w})`);
    // the Backlog's own answer box for #307 (reached by its tab; the 判断待ち screen no longer leads there): the same buttons over it, B opens, the answer box is still there
    await evaluate(`[...document.querySelectorAll('button, a')].find(b => b.textContent.trim() === 'Backlog').click()`);
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

  // #3058: the question tool's questions, answered together on the same card on both screens
  const qTask = async (title: string, prompt: string) => {
    const t = await post("/api/tasks", { workspaceId: meta.id, title, prompt, runner: "codex" });
    await until(() => status(t.id) === "done", `task ${title}`);
    return t.id as string;
  };
  const q1 = await qTask("質問ツールの Task", "questions");
  const q2 = await qTask("質問ツールの Task（Task 画面）", "questions");
  const qf = await qTask("選択肢の無い問いだけの Task", "questionfree");
  const REPLY = "- どこを直すか: core\n- 何を足すか: テスト, 文書\n- ほかに: 急ぎで";
  const shape = (scope: string) => evaluate(`(() => { const c = ${scope}; const fs = [...c.querySelectorAll('.ask-questions fieldset')]; return { fieldsets: fs.length, free: fs.map(f => !!f.querySelector('textarea')), textareas: c.querySelectorAll('textarea').length, submit: [...c.querySelectorAll('button')].some(b => b.textContent.trim() === '回答する'), talk: !!c.querySelector('.ask-talk') }; })()`) as Promise<Json>;
  const submitOff = (scope: string) => evaluate(`[...(${scope}).querySelectorAll('.ask-questions button')].find(b => b.textContent.trim() === '回答する').disabled`) as Promise<boolean>;
  const answerAll = async (scope: string, where: string) => {
    assert(await submitOff(scope), `${where}: 回答する is off before any answer`);
    for (const label of ["core", "テスト", "文書"]) await evaluate(`[...(${scope}).querySelectorAll('.ask-questions label.opt')].find(l => l.textContent.trim().startsWith(${JSON.stringify(label)})).querySelector('input').click()`);
    assert(await submitOff(scope), `${where}: 回答する is still off with the free-text question unanswered`);
    await evaluate(`(() => { const t = (${scope}).querySelector('.ask-questions textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '急ぎで'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert(!(await submitOff(scope)), `${where}: 回答する is on once every question has an answer`);
    await evaluate(`[...(${scope}).querySelectorAll('.ask-questions button')].find(b => b.textContent.trim() === '回答する').click()`);
  };
  const sideways = async (w: number, where: string) => {
    const sw = await evaluate("document.documentElement.scrollWidth") as number;
    assert(sw <= w, `${where} scrolls sideways at ${w}px (${sw})`);
  };
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await open();
  await cardOf(`check:${q1}:`);
  await cardOf(`check:${qf}:`);
  const q1Shape = await shape(card(`check:${q1}:`));
  assert(same(q1Shape, { fieldsets: 3, free: [false, false, true], textareas: 1, submit: true, talk: false }), `the questions' card: ${JSON.stringify(q1Shape)}`);
  const qfShape = await shape(card(`check:${qf}:`));
  assert(same(qfShape, { fieldsets: 0, free: [], textareas: 0, submit: false, talk: true }), `the card of a question without options (its one way is the link to the Task's conversation): ${JSON.stringify(qfShape)}`);
  await evaluate(`${card(`check:${q1}:`)}.scrollIntoView({ block: "start" })`);
  await shot("asks-questions-1280.png");
  await answerAll(card(`check:${q1}:`), "判断待ち");
  await until(() => replies.filter((r) => r.prompt === "questions").length === 1, "the answers reach the Task");
  assert(same(replies.filter((r) => r.prompt === "questions").map((r) => r.text), [REPLY]), `the reply: ${JSON.stringify(replies.filter((r) => r.prompt === "questions"))}`);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await open();
  await cardOf(`check:${qf}:`);
  await sideways(390, "the 判断待ち screen with the questions' cards");
  await evaluate(`${card(`check:${qf}:`)}.scrollIntoView({ block: "start" })`);
  await shot("asks-questions-390.png");
  await link(`check:${q2}:`, "Task の会話を見る");
  const taskAsks = "document.querySelector('.task-asks')";
  await until(() => evaluate(`!!${taskAsks}?.querySelector('.ask-questions')`), "the questions on the Task screen");
  const onTask = await shape(taskAsks);
  assert(same({ ...onTask, talk: undefined }, { fieldsets: 3, free: [false, false, true], textareas: 1, submit: true, talk: undefined }), `the questions on the Task screen: ${JSON.stringify(onTask)}`);
  await sideways(390, "the Task screen with the questions");
  await evaluate(`${taskAsks}.scrollIntoView({ block: "start" })`);
  await shot("task-questions-390.png");
  await answerAll(taskAsks, "Task 画面");
  await until(() => replies.filter((r) => r.prompt === "questions").length === 2, "the answers on the Task screen reach the Task");
  assert(replies.filter((r) => r.prompt === "questions")[1]!.text === REPLY, "the reply from the Task screen");
  report.questions = { tasks: [q1, q2, qf], reply: REPLY, widths: [1280, 390] };

  // a stage Task that stopped and ended its turn with a long reply: the stop's row opens to the reason, the Task's last reply
  // (six lines, 全文 for the rest), the line that says where the reply goes, and the box that sends it to the Task
  const stageStop = async (n: number) => {
    const id = await qTask(`#${n} 実装`, "stopreply");
    stageOf(id, n);
    core.db.appendEvent(id, { t: "stop.record", stop: { id: `s-${n}`, work: { workspaceId: meta.id, issue: n, taskId: id }, op: "ask", target: "", reason: "input", evidence: "返信が要る", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 3_600_000 } } as AgentEvent);
    await imported(true);
    const ask = ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks.find((x) => x.kind === "stop" && x.task?.id === id);
    assert(ask && ask.state === "open" && ask.answers.includes("text") && ask.lastReply === STOP_REPLY, `the stage Task's stop: ${JSON.stringify(ask)}`);
    return { id, ask: ask!.id };
  };
  const stopA = await stageStop(310);
  const stopB = await stageStop(311);
  const replyShape = (prefix: string) => evaluate(`(() => { const c = ${card(prefix)}; const d = c.querySelector('details.ask-lastreply-text'); const b = [...c.querySelectorAll('.ask-text button')][0]; return { reason: c.querySelector('.ask-stop-reason')?.textContent ?? null, label: c.querySelector('.ask-lastreply-label')?.textContent ?? null, open: d?.open ?? null, shown: d ? d.querySelector('summary').innerText : null, whole: d?.innerText ?? null, pre: d ? getComputedStyle(d).whiteSpace : null, target: c.querySelector('.ask-reply-target')?.textContent ?? null, route: !!c.querySelector('.ask-answer-route'), box: !!c.querySelector('.ask-text textarea'), button: b?.textContent.trim() ?? null, height: b?.getBoundingClientRect().height ?? 0, policy: !!c.querySelector('.ask-policy') || c.textContent.includes('次回も使う') }; })()`) as Promise<Json>;
  const stageReply = async (who: { id: string; ask: string }, width: number) => {
    await open();
    await cardOf(who.ask);
    await evaluate(`${card(who.ask)}.scrollIntoView({ block: "start" })`);
    const r = await replyShape(who.ask);
    assert(r.reason === "input: 返信が要る" && r.label === "Task の最後の返答" && r.open === false && r.target === `返信は Task「${who.id}」に届き、その Task が続きます` && r.box && r.button === "返信して続ける" && !r.route && !r.policy && r.pre.startsWith("pre"), `the stop's row at ${width}: ${JSON.stringify(r)}`);
    assert(r.shown.includes("調べた結果を報告します。") && r.shown.includes("全文") && !r.shown.includes("以上です"), `the last reply's head at ${width}: ${r.shown}`);
    await sideways(width, "the opened stop row");
    await shot(`asks-stop-reply-${width}.png`);
    await evaluate(`${card(who.ask)}.querySelector('details.ask-lastreply-text > summary').click()`);
    const whole = await replyShape(who.ask);
    assert(whole.open === true && whole.whole.includes("以上です。返信を待ちます。") && whole.whole.includes("/0123456789/0123456789"), `全文 at ${width}: ${JSON.stringify(whole)}`);
    await sideways(width, "the opened stop row with the whole reply");
    assert(r.height >= 44 || width > 390, `the 返信して続ける button is ${r.height}px at ${width}`);
    return r;
  };
  // 1280: the whole reply opens, a reply reaches the Task once and it runs
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await stageReply(stopA, 1280);
  assert(await evaluate(`${card(stopA.ask)}.querySelector('.ask-text button').disabled`), "返信して続ける is off with nothing typed");
  await evaluate(`(() => { const t = ${card(stopA.ask)}.querySelector('.ask-text textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '2 通りのうち小さい方で進めてください'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`${card(stopA.ask)}.querySelector('.ask-text button').click()`);
  await until(() => replies.some((r) => r.prompt === "stopreply" && r.text === "2 通りのうち小さい方で進めてください"), "the reply reaches the stage Task", () => replies);
  await until(async () => (await badge(stopA.ask))?.startsWith("実行中"), "the stage Task runs after the reply", () => badge(stopA.ask));
  assert(replies.filter((r) => r.prompt === "stopreply").length === 1, "the stage Task got more than one reply");
  // 390: the other stop's row, nothing sideways, the button a 44px target
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await stageReply(stopB, 390);
  assert((await evaluate("document.documentElement.scrollWidth") as number) <= 390, "the stop row scrolls sideways at 390px");
  report.stopReply = { tasks: [stopA.id, stopB.id], widths: [1280, 390] };
  await Promise.all([stopA.id, stopB.id].map((id) => post(`/api/tasks/${id}/abort`, {})));


  assert(!errors.length, `console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ...report, answered, consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
