// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { saveQueue } from "./backlog-queue.ts";
import { importing } from "../fixtures/github-import.ts";
import type { GhRunner } from "./backlog-gh.ts";
import type { Suggester } from "./routing.ts";
import { FAKE_ORIGIN, STOPPED, backlogNextSchedule, boot, closeTried, endableClaude, fakeGh, getQueue, holdingClaude, metaId, metaName, moreReadyGh, overlapReadyGh, putQueue, refreshed, releaseBody, runSchedule, scheduleLogAll, start, startedTasks, until, useBacklogDaemon, threeWorkspaces, waitsGh } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("backlog-next queue: with the queue enabled a firing starts no Ready PBI, logs 実装の枠: キューに任せる, and still moves the 計画 slot", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  saveQueue(core!.db, { enabled: true, items: [{ workspaceId: metaId(), number: 304 }] });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: キューに任せる`));
  // disabled: the firing picks as before
  saveQueue(core!.db, { enabled: false });
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
});

test("backlog-next queue: the queue enabled while a firing reads GitHub takes the 実装 slot from that firing", async () => {
  const claude = holdingClaude();
  const fake = fakeGh();
  let enableOnRead = false;
  const gh: GhRunner = async (args, cwd) => {
    if (enableOnRead) {
      enableOnRead = false;
      saveQueue(core!.db, { enabled: true });
    }
    return fake.gh(args, cwd);
  };
  const base = await boot(gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  enableOnRead = true;
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: キューに任せる`));
});

const queueOf = (...numbers: number[]) => numbers.map((number) => ({ workspaceId: metaId(), number }));

const startedTitles = () => startedTasks().map((t) => t.title.split(":")[0]);

test("startFromQueue: enabling starts the head with no schedule; its Task's end starts the next; nothing starts while disabled", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect(core!.db.listSchedules().filter((s) => s.action === "backlog-next")).toEqual([]);
  // Issue 307 can be closed, Issue 304 is Ready: the queue's order, not Priority, says which goes first
  expect((await putQueue(base, { items: queueOf(307, 304) })).status).toBe(200);
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  await putQueue(base, { enabled: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#307 閉じる"]);
  await until(async () => (await getQueue(base)).lastNote?.includes("#307 を close で開始") ?? false);
  // its Task ends (aborted: Issue 307 is then left until the Issue moves): the second starts
  const first = startedTasks()[0]!;
  await fetch(`${base}/api/tasks/${first.id}/abort`, { method: "POST" });
  await until(() => startedTitles().length > 1);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  // disabled: a Task's end starts nothing
  await putQueue(base, { enabled: false, items: queueOf(304, 305) });
  await fetch(`${base}/api/tasks/${startedTasks().find((t) => t.title.startsWith("#304"))!.id}/abort`, { method: "POST" });
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
});

test("startFromQueue: concurrency 2 starts two, and no third", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { items: queueOf(307, 304, 305), concurrency: 2, enabled: true });
  await until(() => startedTitles().length >= 2);
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  await putQueue(base, { concurrency: 2 });
  await until(async () => (await getQueue(base)).lastNote === "同時に動かす数 2 に達している");
  expect((await getQueue(base)).lastNote).toBe("同時に動かす数 2 に達している");
});

test("startFromQueue: a head waiting for a PR still open is left and named as backlog-next names it; the second starts", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "OPEN" } });
  const base = await boot(fake.gh, claude.adapter);
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#307 閉じる"]);
  await until(async () => (await getQueue(base)).lastNote?.includes("#307 を close で開始") ?? false);
  const note = (await getQueue(base)).lastNote!;
  expect(note).toContain(`${metaName()}: 前提: #304（PR #778 マージ待ち）`);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`キュー: ${metaName()}: 前提: #304（PR #778 マージ待ち） (enabled)`));
});

test("startFromQueue: an empty queue says so and starts nothing", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { enabled: true });
  await until(async () => (await getQueue(base)).lastNote !== null);
  expect((await getQueue(base)).lastNote).toBe("キューが空");
  expect(startedTasks()).toEqual([]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: キューが空 (enabled)"));
});

test("startFromQueue: a resumable flow PBI outside the queue does not hold the queue's flow PBI, and the note names it", async () => {
  // Issue 307 (in progress, closable) and Issue 304 (Ready) carry flow-improvement; only 304 is queued
  const inner = fakeGh().gh;
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304 || node.number === 307) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const base = await boot(gh, holdingClaude().adapter);
  await putQueue(base, { items: queueOf(304), enabled: true });
  await until(() => startedTitles().includes("#304 実装"));
  expect(startedTitles()).toEqual(["#304 実装"]);
  expect((await getQueue(base)).lastNote ?? "").toContain(`${metaName()}: キューに無い実装中: #307（再開されない。`);
});

test("startFromQueue: a queued PBI not yet split is named; a 計画 Task's end runs the queue again", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await putQueue(base, { items: queueOf(303), enabled: true });
  await until(async () => (await getQueue(base)).lastNote !== null);
  expect((await getQueue(base)).lastNote).toContain(`${metaName()}: まだ Ready でない: #303（Task 分解前）`);
  expect(startedTasks()).toEqual([]);
  // its Task に分解 (the button) ends: the queue looks again
  const r = await start(base, 303, { action: "to-tasks" });
  expect(r.status).toBe(201);
  await fetch(`${base}/api/tasks/${((await r.json()) as Task).id}/abort`, { method: "POST" });
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`キュー: ${metaName()}: まだ Ready でない: #303（Task 分解前） (task-end)`));
});

test("startFromQueue: the queue's start and a backlog-next firing at once start one Task per PBI", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  await putQueue(base, { items: queueOf(304) });
  const id = await backlogNextSchedule(base);
  await Promise.all([runSchedule(base, id), putQueue(base, { enabled: true })]);
  await until(() => startedTitles().includes("#304 実装"));
  await Bun.sleep(300);
  expect(startedTitles().filter((t) => t === "#304 実装")).toHaveLength(1);
});

test("startFromQueue: with concurrency 2, a queued PBI whose Task names the path of the PBI started before it is not started in the same run; the one with another path is", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  await putQueue(base, { items: queueOf(304, 309, 310), concurrency: 2, enabled: true });
  await until(() => startedTitles().length >= 2);
  await Bun.sleep(300);
  expect(startedTitles().sort()).toEqual(["#304 実装", "#310 実装"]);
  expect((await getQueue(base)).lastNote ?? "").toContain("重なり: #309（Task #3041: src/a.ts）");
});

test("startFromQueue: two workspaces with the same name: one's start keeps the other's overlap line in lastNote", async () => {
  // Issue 309's Task names a file an open PR changes; Issue 304's names another
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, undefined, overlapReadyGh({ 304: "src/b.ts", 309: "src/a.ts", 310: "src/c.ts" }));
  closeTried(...Object.values(ids));
  // the names are not unique: both workspaces are called twin
  for (const ws of [ids.lib!, ids.app!]) core!.db["sqlite"].query("UPDATE workspaces SET name = 'twin' WHERE id = ?").run(ws);
  // one workspace has only the overlapped PBI queued and starts nothing; the other starts its PBI and reads its backlog again
  expect((await putQueue(base, { items: [{ workspaceId: ids.lib!, number: 309 }, { workspaceId: ids.app!, number: 304 }], concurrency: 2, enabled: true })).status).toBe(200);
  const queueLog = async () => (await scheduleLogAll(base)).filter((l) => l.includes("キュー:"));
  await until(async () => (await queueLog()).some((l) => l.includes("開始")));
  expect(startedTasks().map((t) => t.workspaceId)).toEqual([ids.app!]);
  // the run that started the PBI says the other workspace's overlap line too (a later run says it again, so the line is read from this run's notes: one timestamp)
  const log = await queueLog();
  const at = log.find((l) => l.includes("開始"))!.slice(0, 24);
  expect(log.filter((l) => l.startsWith(at))).toContainEqual(expect.stringContaining("キュー: twin: 重なり: #309（PR #900: src/a.ts）"));
});

test("startFromQueue: a flow PBI that became in progress after the first read counts against the limit after a start", async () => {
  // Issue 307 (in progress, not queued) and Issue 309 (Ready, queued) carry flow-improvement; the limit is 1
  const inner = moreReadyGh(309, 310);
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 307 || node.number === 309) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  let first = true;
  // while the queue starts Issue 304, a stage Task of Issue 307 starts elsewhere (a button): the first read did not count it
  const routing: Suggester = { suggest: async () => {
    if (first) {
      first = false;
      const now = Date.now();
      core!.db.insertTask({ id: "task_307", workspaceId: metaId(), title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 307, action: "close" }, statusAt: now, createdAt: now, updatedAt: now });
    }
    return { runner: "claude", reason: "r", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
  } };
  const base = await boot(gh, holdingClaude().adapter, {}, () => routing);
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  expect((await putQueue(base, { items: queueOf(304, 309, 310), concurrency: 3, enabled: true })).status).toBe(200);
  await until(() => startedTitles().includes("#310 実装"));
  await Bun.sleep(300);
  // 309 is held by the limit once 307 runs; 310 (no label) goes on
  expect(startedTitles().filter((t) => t?.startsWith("#309"))).toEqual([]);
  expect(startedTitles()).toContain("#304 実装");
});

test("startFromQueue, developSelf off: a queued PBI of the meta workspace is not started, and the note says why", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf: false }) })).status).toBe(200);
  await putQueue(base, { items: queueOf(304), enabled: true });
  await until(async () => (await getQueue(base)).lastNote?.includes("開発しない設定") ?? false);
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  expect((await getQueue(base)).lastNote ?? "").toContain("開発しない設定なので読まない: #304");
});

test("startFromQueue: at boot an enabled queue goes on", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  // stored as a PUT stores it, without the PUT's start: only the boot starts it
  saveQueue(core!.db, { items: queueOf(304), enabled: true });
  await Bun.sleep(100);
  expect(startedTitles()).toEqual([]);
  void base;
  await core!.stop();
  const cfg = loadConfig({ SWITCHBOARD_HOME: home!, SWITCHBOARD_KNOWLEDGE: join(home!, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home!, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh, () => openPulls), backlogAutoImport: true });
  await until(() => startedTitles().length > 0);
  expect(startedTitles()).toEqual(["#304 実装"]);
});

/** boot, with daemon options the default boot leaves out (a judge, a job command). */
async function bootWith(adapter: RunnerAdapter, opts: Partial<Parameters<typeof startServer>[2]>) {
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh, () => openPulls), backlogAutoImport: true, ...opts });
  const base = `http://127.0.0.1:${core.server.port}`;
  await refreshed(base, false);
  return base;
}

test("startFromQueue: a stage Task whose turn ended on a job it asked the daemon for keeps its place until the job ends, and the job's end runs the queue", async () => {
  const claude = endableClaude();
  const gate = join(tmpdir(), `sb-job-gate-${process.pid}-${Date.now()}`);
  const base = await bootWith(claude.adapter, { jobCommand: () => ({ argv: ["sh", "-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done`], tail: "" }) });
  core!.db.setSetting("settings", { judge: { enabled: false } });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  expect(task.title.startsWith("#304 実装")).toBe(true);
  // the Task asks the daemon for local CI (ops-kit job request) and ends its turn on it: its work is not over
  const r = await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "local-ci", taskId: task.id, pr: 900, cwd: task.cwd }) });
  expect(r.status).toBe(202);
  const job = (await r.json()) as { id: number };
  claude.end(0);
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(core!.db.getTask(task.id)!.status).toBe("done");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (task-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
  // the job ends: its end runs the queue; Issue 304 is not started again on top of it, the next goes
  writeFileSync(gate, "");
  try {
    await until(() => startedTitles().length > 1, 10_000);
  } finally {
    rmSync(gate, { force: true });
  }
  expect(core!.db.getJob(job.id)!.status).toBe("pass");
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("(job-end)"));
}, 30_000);

test("startFromQueue: a stage Task that stopped on its job# is resumed by the job's end before the queue looks, and keeps its place", async () => {
  const claude = endableClaude();
  const gate = join(tmpdir(), `sb-job-gate-${process.pid}-${Date.now()}`);
  const base = await bootWith(claude.adapter, { jobCommand: () => ({ argv: ["sh", "-c", `while [ ! -e '${gate}' ]; do sleep 0.05; done`], tail: "" }) });
  core!.db.setSetting("settings", { judge: { enabled: false } });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  claude.emit(0, { t: "session.start", runnerSessionId: "sess-304" } as AgentEvent);
  const job = (await (await fetch(`${base}/api/jobs`, { method: "POST", body: JSON.stringify({ kind: "local-ci", taskId: task.id, pr: 900, cwd: task.cwd }) })).json()) as { id: number };
  // as `ops-kit job request` asks: a depends stop on job#<id>, then the turn ends
  expect(core!.tasks.recordStop(task.id, { id: `job-${job.id}`, op: "ops-kit job request local-ci", target: "PR #900", reason: "depends", safety: "read-only", evidence: `job#${job.id}`, state: "waiting", conditions: [{ key: `job#${job.id}`, value: "done", met: false }], actions: [] }).ok).toBe(true);
  claude.end(0);
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  writeFileSync(gate, "");
  try {
    await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(job-end)")), 10_000);
  } finally {
    rmSync(gate, { force: true });
  }
  // the job's end resumed the Task first: the queue found its place taken, and Issue 304 runs once
  expect(core!.db.getTask(task.id)!.status).toBe("running");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (job-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
}, 30_000);

test("startFromQueue: a stage Task's place stays taken while its last reply is judged, and the judgement runs the queue again", async () => {
  const claude = endableClaude();
  let judged: (r: { result: "needs_action"; reason: string; runner: "claude"; model: string }) => void = () => {};
  const base = await bootWith(claude.adapter, { judge: () => new Promise((r) => (judged = r)), rubricJudge: () => new Promise(() => undefined), titleSuggester: () => new Promise(() => undefined) });
  await putQueue(base, { items: queueOf(304, 307), enabled: true });
  await claude.started(1);
  const task = startedTasks()[0]!;
  // the turn ends asking the person; its outcome is known only once the judge answers
  claude.emit(0, { t: "session.end", status: "ok", summary: "確認: PR をマージしてよいですか" });
  await until(async () => (await scheduleLogAll(base)).some((l) => l.includes("(task-end)")));
  expect(core!.db.getTask(task.id)).toMatchObject({ status: "done", outcome: "unknown", judgingAt: expect.any(Number) });
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("キュー: 同時に動かす数 1 に達している (task-end)"));
  await Bun.sleep(200);
  expect(startedTitles()).toEqual(["#304 実装"]);
  judged({ result: "needs_action", reason: "マージの確認", runner: "claude", model: "m" });
  await until(() => startedTitles().length > 1);
  expect(core!.db.getTask(task.id)).toMatchObject({ outcome: "needs_action", judgingAt: null });
  expect(startedTitles().sort()).toEqual(["#304 実装", "#307 閉じる"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("(judged)"));
}, 30_000);
