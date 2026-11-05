/**
 * Run after `bun run --cwd apps/web build`: bun scripts/depends-resume-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * A Task started by hand stops on another session's PR (#2045): its runner reports a depends stop with `pr#12`, and,
 * asked how it stands, checks the overlap again and stops a second time. The fake GitHub then has PR #12 merged; the
 * next backlog import reads it again, and the same Task gets one follow-up turn in its runner session and its stops are
 * resolved. The Task's screen shows the series waiting before and resolved after (a series that stopped once and was
 * resolved is not listed, apps/web/src/stops.ts `shownStops`: twice is).
 * The fake GitHub and runner are scripts/backlog-e2e.ts's; no GitHub access is needed.
 * SCREENSHOT=<prefix> saves `<prefix>-before.png` and `<prefix>-after.png`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { dependsResumePrompt } from "../packages/core/src/depends-resume.ts";
import { importing } from "../packages/core/fixtures/github-import.ts";

const home = mkdtempSync(join(tmpdir(), "sb-depends-e2e-"));
const repo = join(home, "app");
mkdirSync(repo);
const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
git("init", "-q");
git("commit", "-q", "--allow-empty", "-m", "first");

// the fake GitHub: no Issues; PR #12 open until `merged`, then gone from the open list and answered as merged by number
let merged = false;
const legacy: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args.some((a) => a.includes("rateLimit {"))) return { code: 0, stdout: '{"data":{"rateLimit":{"remaining":0,"cost":1}}}', stderr: "" };
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: JSON.stringify({ data: { repository: merged ? { w12: { __typename: "PullRequest", state: "MERGED", headRefName: "sb/40-other" } } : {} } }), stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: '{"data":{"repository":{}}}', stderr: "" };
  return { code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" };
};
const gh = importing(legacy, () => (merged ? [] : [{ number: 12, headRefName: "sb/40-other", files: ["packages/core/src/a.ts"] }]));
delete process.env.SWITCHBOARD_PROJECT_URL;

// the runner: its first turn stops on PR #12 (the fence the stop prompt asks for); asked how it stands, it stops again on
// it; every later turn is recorded and ends ok
const STOP = { id: "overlap", op: "parallel-guard overlap", target: "Task #52", reason: "depends", safety: "read-only", evidence: "PR #12 と packages/core/src/a.ts が重なる", state: "waiting", conditions: [{ key: "pr#12", value: "open", met: false }], actions: [] };
const sent: string[] = [];
let sends = 0;
const turn = (text: string): AgentEvent[] => [{ t: "session.start", runner: "claude", runnerSessionId: "sess-e2e", cwd: repo }, { t: "message.delta", role: "assistant", text }, { t: "session.end", status: "ok", summary: "ok" }];
const adapter: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true }),
  start(_opts, emit) {
    queueMicrotask(() => turn(`重なりで止まります。\n\n\`\`\`switchboard-stop\n${JSON.stringify(STOP)}\n\`\`\`\n`).forEach(emit));
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    return {
      send(text) {
        sent.push(text);
        emit({ t: "message.delta", role: "user", text });
        const again = ++sends === 1 ? `まだ重なっています。\n\n\`\`\`switchboard-stop\n${JSON.stringify({ ...STOP, id: "overlap-2" })}\n\`\`\`\n` : "続けました。";
        queueMicrotask(() => turn(again).forEach(emit));
      },
      respondPermission() {},
      async abort() { exit(null); },
      async close() { exit(0); },
      exited,
    };
  },
};

const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_REPO_ROOT: repo });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
type Detail = { task: { status: string; runnerSessionId: string | null }; stopSummary: Array<{ key: string; state: string; reason: string; count: number; conditions: Array<{ key: string; met: boolean }> }> };
const detail = async (id: string) => (await (await fetch(`${base}/api/tasks/${id}`)).json()) as Detail;

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,1400", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  // 1. the meta workspace's backlog is imported with PR #12 open; a Task started by hand stops on it
  await fetch(`${base}/api/backlog?refresh=1`);
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const task = core.tasks.create({ cwd: repo, workspaceId: meta.id, title: "重なりで止まる Task", prompt: "Task #52 に着手", runner: "claude" });
  const stopped = await until(async () => { const d = await detail(task.id); return d.task.status === "done" && d.stopSummary.find((s) => s.reason === "depends") ? d : null; }, "the depends stop");
  assert(stopped.stopSummary.find((s) => s.reason === "depends")!.state === "waiting", `stop before: ${JSON.stringify(stopped.stopSummary)}`);
  console.log(`stopped: ${task.id} depends ${JSON.stringify(stopped.stopSummary[0]!.conditions)} waiting`);
  // asked how it stands: it checks the overlap again and stops a second time on the same PR
  await core.tasks.send(task.id, "状況を確認して");
  const twice = await until(async () => { const d = await detail(task.id); const s = d.stopSummary.find((x) => x.reason === "depends"); return d.task.status === "done" && s?.count === 2 ? s : null; }, "the second stop");
  console.log(`stopped again: count ${twice.count} ${twice.state}`);
  sent.length = 0;

  // the Task's screen shows the stop
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const pageUrl = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  ws = new WebSocket(pageUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async (name: string) => {
    if (!process.env.SCREENSHOT) return;
    const { data } = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${process.env.SCREENSHOT}-${name}.png`, Buffer.from(data, "base64"));
  };
  const stopsOnScreen = `[...document.querySelectorAll('.backlog-stops summary')].map(s => s.textContent)`;
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url: `${base}/task/${encodeURIComponent(task.id)}` });
  const before = await until(async () => { const s = (await evaluate(stopsOnScreen)) as string[]; return s.length ? s : null; }, "the stop on the Task's screen");
  assert(before.some((s) => s.includes("parallel-guard overlap") && s.includes("depends") && s.includes("2 回目") && !s.includes("解消済み")), `screen before: ${JSON.stringify(before)}`);
  console.log(`screen before: ${JSON.stringify(before)}`);
  await shot("before");

  // 2. PR #12 is merged on GitHub; the next import reads it again and continues the same Task
  merged = true;
  await fetch(`${base}/api/backlog?refresh=1`);
  await until(() => sent.length > 0, "the follow-up turn");
  assert(JSON.stringify(sent) === JSON.stringify([dependsResumePrompt(["pr#12"])]), `turns sent: ${JSON.stringify(sent)}`);
  console.log(`follow-up turn in session sess-e2e: ${sent[0]}`);
  const after = await until(async () => { const d = await detail(task.id); return d.task.status === "done" ? d : null; }, "the turn's end");
  const s = after.stopSummary.find((x) => x.reason === "depends")!;
  assert(s.state === "resolved" && s.count === 2 && s.conditions.every((c) => c.met), `stop after: ${JSON.stringify(s)}`);
  assert(after.task.runnerSessionId === "sess-e2e", `session: ${after.task.runnerSessionId}`);
  console.log(`stop after: ${s.state} ${JSON.stringify(s.conditions)}`);
  // another import finds nothing more to send
  await fetch(`${base}/api/backlog?refresh=1`);
  await Bun.sleep(200);
  assert(sent.length === 1, `sent again: ${sent.length}`);

  // the Task's screen shows the series resolved
  await call("Page.navigate", { url: `${base}/task/${encodeURIComponent(task.id)}` });
  await until(() => evaluate(`document.body.textContent.includes('続けました。')`), "the follow-up on the Task's screen");
  const shown = (await evaluate(stopsOnScreen)) as string[];
  assert(shown.length === 1 && shown[0]!.includes("2 回目") && shown[0]!.includes("解消済み・操作不要"), `screen after: ${JSON.stringify(shown)}`);
  console.log(`screen after: ${JSON.stringify(shown)}`);
  await shot("after");
  console.log("depends-resume-e2e: ok");
} finally {
  ws?.close();
  chrome.kill();
  await core.close?.();
  rmSync(home, { recursive: true, force: true });
}
process.exit(0);
