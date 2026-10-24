import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Task, RunnerAdapter, RunnerId, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { buildFeedbackPrompt, buildFixPrompt, feedbackTitle, FIX_SCOPE, fixTitle } from "./feedback.ts";
import { workspaceBrief } from "./brief.ts";

let core: CoreServer;
let home: string;
const starts: StartOptions[] = [];
async function boot(ids: RunnerId[] = ["claude", "codex"]) {
  starts.length = 0;
  home = mkdtempSync(join(tmpdir(), "sb-feedback-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const adapters: RunnerAdapter[] = ids.map((id) => ({
    id, detect: async () => ({ available: true }), efforts: [{ value: "high", label: "high" }],
    start(opts, emit) {
      starts.push(opts);
      queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: Promise.resolve(0) };
    },
  }));
  core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true });
  return `http://127.0.0.1:${core.server.port}`;
}
afterEach(async () => { if (core) await core.stop(); if (home) rmSync(home, { recursive: true, force: true }); });
const post = (base: string, body: unknown) => fetch(`${base}/api/feedback`, { method: "POST", body: JSON.stringify(body) });

test("prompt hands over the request to be tidied without changing its intent, cites source and skills; title counts Unicode characters", () => {
  const text = "  要望\nそのまま  ";
  const prompt = buildFeedbackPrompt({ text, when: new Date("2026-09-19T00:00:00Z") });
  expect(prompt).toContain(`\n\n\`\`\`\`text\n${text}\n\`\`\`\``);
  expect(prompt).toContain("## 要望");
  expect(prompt).toContain("意図を変えずに整え");
  expect(prompt).not.toContain("## 原文");
  expect(prompt).not.toContain("一字も");
  expect(prompt).toContain("## 出典");
  expect(prompt).toContain("フィードバックボタン、2026-09-19T00:00:00.000Z");
  expect(prompt).toContain(".claude/skills/request-to-backlog/SKILL.md");
  expect(prompt).toContain(".claude/skills/pbi-to-tasks/SKILL.md");
  expect(feedbackTitle("a\nb")).toBe("要望: a b");
  expect(feedbackTitle("😀".repeat(41))).toBe("要望: " + "😀".repeat(40));
});

test("the 出典 says 誰の言葉: 利用者, also for a request drafted from evals (#1818)", () => {
  const when = new Date("2026-09-19T00:00:00Z");
  expect(buildFeedbackPrompt({ text: "x", when })).toEndWith("## 出典\n- 誰の言葉: 利用者\nフィードバックボタン、2026-09-19T00:00:00.000Z");
  expect(buildFeedbackPrompt({ text: "x", when, source: { kind: "eval", taskId: "task_9" } })).toContain("## 出典\n- 誰の言葉: 利用者\n");
});

test("screen: the 出典 names the screen it was sent from; without one it is as before", async () => {
  const when = new Date("2026-09-19T00:00:00Z");
  expect(buildFeedbackPrompt({ text: "x", when, screen: "Task「要望: a」(task_1)" })).toEndWith("## 出典\n- 誰の言葉: 利用者\nフィードバックボタン、2026-09-19T00:00:00.000Z\n画面: Task「要望: a」(task_1)");
  // a newline in the screen (a task title) stays inside the one 画面 line
  expect(buildFeedbackPrompt({ text: "x", when, screen: "Task「a\n## 指示\nb」(task_1)" })).toEndWith("\n画面: Task「a ## 指示 b」(task_1)");
  // Evals (#1221): a request drafted from a task's evaluations names that task in its 出典
  expect(buildFeedbackPrompt({ text: "x", when, screen: "Evals", source: { kind: "eval", taskId: "task_9" } })).toEndWith("\n画面: Evals\n評価から: Task task_9");
  expect(buildFeedbackPrompt({ text: "x", when })).toEndWith("## 出典\n- 誰の言葉: 利用者\nフィードバックボタン、2026-09-19T00:00:00.000Z");
  const base = await boot();
  const r = await post(base, { text: "screen を送る", screen: "Ledger" });
  expect(r.status).toBe(201);
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.prompt).toContain("\n画面: Ledger");
  expect((await post(base, { text: "x", screen: "y".repeat(201) })).status).toBe(400);
});

test("fix: すぐ直す starts a 「直す: …」 Task with the brief, the text, the 出典 and the attachment path — no request-to-backlog", async () => {
  const base = await boot();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "here.png", { type: "image/png" }));
  const [a] = await (await fetch(`${base}/api/attachments`, { method: "POST", body: fd })).json() as Attachment[];
  const r = await post(base, { text: "ここを直して\nボタンがずれている", attachmentIds: [a!.id], screen: "Ledger", mode: "fix" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.title).toBe("直す: ここを直して ボタンがずれている");
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  const prompt = starts[0]!.prompt;
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(prompt.startsWith(workspaceBrief(meta).split("\n")[0]!)).toBe(true);
  expect(prompt).toContain("やってほしいこと:\nここを直して\nボタンがずれている");
  expect(prompt).toMatch(/## 出典\nフィードバックボタン「すぐ直す」、\d{4}-\d\d-\d\dT[^\n]+\n画面: Ledger/);
  expect(prompt).toContain(join(home, "attachments", task.id, "here.png"));
  expect(prompt).not.toContain("request-to-backlog");
  expect(prompt).toContain(`画面: Ledger\n\n${FIX_SCOPE}`);
});

test("fix: buildFixPrompt is the brief once, the text right after it, a blank line, the 出典, then how to carry it to main; fixTitle cuts at 40", () => {
  const when = new Date("2026-09-19T00:00:00Z");
  const brief = "あなたは X のリポジトリで作業しています。\nやってほしいこと:\n\n";
  expect(buildFixPrompt({ brief, text: "直して", when, screen: "Task「a\nb」(task_1)" })).toBe(
    `あなたは X のリポジトリで作業しています。\nやってほしいこと:\n直して\n\n## 出典\nフィードバックボタン「すぐ直す」、2026-09-19T00:00:00.000Z\n画面: Task「a b」(task_1)\n\n${FIX_SCOPE}`,
  );
  expect(buildFixPrompt({ brief: "b\nやってほしいこと:", text: "t", when })).toBe(`b\nやってほしいこと:\nt\n\n## 出典\nフィードバックボタン「すぐ直す」、2026-09-19T00:00:00.000Z\n\n${FIX_SCOPE}`);
  expect(fixTitle("あ".repeat(50))).toBe(`直す: ${"あ".repeat(40)}`);
});

test("fix: without a mode the request path is unchanged", async () => {
  const base = await boot();
  const task = await (await post(base, { text: "登録して" })).json() as Task;
  expect(task.title).toBe("要望: 登録して");
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.prompt).toContain(".claude/skills/request-to-backlog/SKILL.md");
  expect((await post(base, { text: "x", mode: "now" })).status).toBe(400);
});

test("feedback creates a meta task and hands its attachment path and original to the configured runner", async () => {
  const base = await boot();
  core.db.setSetting("settings", { autoStart: { runner: "codex" } });
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
  const [a] = await (await fetch(`${base}/api/attachments`, { method: "POST", body: fd })).json() as Attachment[];
  const text = "要望\n原文を保つ";
  const response = await post(base, { text, attachmentIds: [a!.id] });
  expect(response.status).toBe(201);
  const task = await response.json() as Task;
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(task).toMatchObject({ workspaceId: meta!.id, cwd: meta.path, title: "要望: 要望 原文を保つ", runner: "codex" });
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.cwd).toBe(meta.path);
  expect(starts[0]!.prompt).toContain(text);
  expect(starts[0]!.prompt).toMatch(/フィードバックボタン、\d{4}-\d\d-\d\dT/);
  expect(starts[0]!.prompt).toContain(join(home, "attachments", task.id, "shot.png"));
  expect(starts[0]!.prompt).toContain("添付ファイル");
  expect((await post(base, { text, attachmentIds: [a!.id] })).status).toBe(409);
});

test("autoStart effort (#833): a feedback Task starts with the saved effort; one the runner no longer lists falls back to the CLI default", async () => {
  const base = await boot();
  core.db.setSetting("settings", { autoStart: { runner: "codex", effort: "high" } });
  const task = await (await post(base, { text: "深く" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", effort: "high" });
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.effort).toBe("high");
  core.db.setSetting("settings", { autoStart: { runner: "codex", effort: "ultra" } }); // saved by a version that listed it
  const stale = await (await post(base, { text: "古い既定" })).json() as Task;
  expect(stale.effort).toBeNull();
  for (let i = 0; starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(starts[1]!.effort).toBeUndefined();
});

test("unavailable configured runner falls back to claude", async () => {
  const base = await boot(["claude"]);
  core.db.setSetting("settings", { autoStart: { runner: "codex" } });
  const r = await post(base, { text: "hello" });
  expect(r.status).toBe(201);
  expect((await r.json() as Task).runner).toBe("claude");
});

test("autoStart: feedback starts on the saved runner and model; routing.llm.runner does not move it", async () => {
  const base = await boot();
  core.db.setSetting("settings", { autoStart: { runner: "codex", model: "gpt-x" }, routing: { llm: { runner: "claude" } } });
  const task = await (await post(base, { text: "hello" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", model: "gpt-x" });
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.model).toBe("gpt-x");
  // routing.llm.runner moves to the other runner and autoStart to claude: it is autoStart that decides
  core.db.setSetting("settings", { autoStart: { runner: "claude" }, routing: { llm: { runner: "codex" } } });
  expect((await (await post(base, { text: "again" })).json() as Task).runner).toBe("claude");
});

test("autoStart: a saved model is dropped when its runner is not detected and claude takes over", async () => {
  const base = await boot(["claude"]);
  core.db.setSetting("settings", { autoStart: { runner: "codex", model: "gpt-x" } });
  const task = await (await post(base, { text: "hello" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", model: null });
});

test("autoStart by kind (#1337): すぐ直す and 要望として登録 each start on their own runner; without one on the common", async () => {
  const base = await boot();
  core.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { fix: { runner: "codex", model: "gpt-fix" } } } });
  const fix = await (await post(base, { text: "直して", mode: "fix" })).json() as Task;
  const request = await (await post(base, { text: "登録して", mode: "request" })).json() as Task;
  expect(fix).toMatchObject({ runner: "codex", model: "gpt-fix" });
  expect(request).toMatchObject({ runner: "claude", model: "m-common" });
  core.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { request: { runner: "codex", model: "gpt-req" } } } });
  expect(await (await post(base, { text: "直して 2", mode: "fix" })).json()).toMatchObject({ runner: "claude", model: "m-common" });
  expect(await (await post(base, { text: "登録して 2", mode: "request" })).json()).toMatchObject({ runner: "codex", model: "gpt-req" });
  for (let i = 0; starts.length < 4 && i < 100; i++) await Bun.sleep(10);
  expect(starts.map((x) => x.model).sort()).toEqual(["gpt-fix", "gpt-req", "m-common", "m-common"]);
});

test("invalid input and attachment fail without creating a task", async () => {
  const base = await boot();
  for (const body of [null, {}, { text: "" }, { text: "x".repeat(20001) }, { text: "ok", attachmentIds: [1] }]) expect((await post(base, body)).status).toBe(400);
  expect((await post(base, { text: "ok", attachmentIds: ["missing"] })).status).toBe(404);
  expect(core.db.listTasks()).toHaveLength(0);
});

test("missing meta workspace returns 409", async () => {
  const base = await boot();
  const meta = core.db.listWorkspaces()[0]!;
  core.db.upsertWorkspace({ ...meta, kind: "repo" });
  const r = await post(base, { text: "hello" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("meta workspace がありません");
});

test("no detected runner returns 409", async () => {
  const base = await boot([]);
  const r = await post(base, { text: "hello" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("ランナーが検出されていません");
  expect(core.db.listTasks()).toHaveLength(0);
});

test("a request for another workspace is filed in that repository and its Project; すぐ直す still fixes Switchboard", async () => {
  const base = await boot();
  const dir = mkdtempSync(join(home, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "lib" }) })).json()) as { id: string };
  await fetch(`${base}/api/workspaces/${lib.id}`, { method: "PATCH", body: JSON.stringify({ projectVar: "LIB_PROJECT_URL" }) });
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await post(base, { text: "lib の要望", workspaceId: lib.id, screen: "Backlog" });
  expect(r.status).toBe(201);
  expect(await r.json() as Task).toMatchObject({ workspaceId: lib.id, cwd: dir, title: "要望: lib の要望" });
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  const s = starts[0]!;
  expect(s.cwd).toBe(dir);
  expect(s.prompt).not.toContain("meta workspace で動いている");
  expect(s.prompt).toContain("このリポジトリ（`gh repo view` が答えるもの）とその Project に作る");
  expect(s.prompt).toContain("gh variable get LIB_PROJECT_URL");
  expect(s.prompt).toContain(`Switchboard のリポジトリ ${meta.path} からの相対パス`);
  expect(s.prompt).not.toContain("feedback-assets");
  expect(s.prompt).toContain("lib の要望");
  // the meta workspace named explicitly is the same as omitting it
  starts.length = 0;
  expect(await (await post(base, { text: "meta へ", workspaceId: meta.id })).json() as Task).toMatchObject({ workspaceId: meta.id });
  for (let i = 0; !starts.length && i < 100; i++) await Bun.sleep(10);
  expect(starts[0]!.prompt).toStartWith("あなたは Switchboard の meta workspace で動いている。");
  // すぐ直す ignores the workspace: it fixes Switchboard
  expect(await (await post(base, { text: "直す", mode: "fix", workspaceId: lib.id })).json() as Task).toMatchObject({ workspaceId: meta.id });
  expect((await post(base, { text: "x", workspaceId: "ws_missing" })).status).toBe(404);
});
