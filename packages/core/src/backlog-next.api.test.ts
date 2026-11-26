// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogItem, RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import type { Suggester } from "./routing.ts";
import { startServer, type CoreServer } from "./server.ts";
import { importing } from "../fixtures/github-import.ts";
import { fmtTime } from "./ratelimit.ts";
import { buildStartPrompt } from "./backlog-prompt.ts";
import { pickNext, onHoldIn, GATE_LINE } from "./backlog-pick.ts";
import { leftLines } from "./server/backlog-next.ts";
import type { GhRunner } from "./backlog-gh.ts";
import type { RawBacklogIssue } from "./backlog-item.ts";
import { DECOMPOSED_READY, overlapReadyGh, FAKE_ORIGIN, backlogNextSchedule, boot, budgetGh, closeTried, resumeTried, commentingGh, decisions, decomposedGh, fakeGh, fixtureStage, holdingClaude, item, metaId, metaName, moreReadyGh, pages, refreshed, runSchedule, scheduleLog, scheduleLogAll, shutdown, start, startedTasks, subTask, sweepAll, taskDecisionGh, threeWorkspaces, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

/** fakeGh with `numbers` labelled on-hold. */
function onHoldGh(...numbers: number[]) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (numbers.includes(node.number)) node.labels.nodes.push({ name: "on-hold" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}

/** fakeGh with two more requests: Issue 320 large, and Issue 302 (small) brought back by its direct Task when `returned` is set. */
function requestsGh(returned: { on: boolean }) {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: Array<{ number: number; body: string; updatedAt: string; labels: { nodes: { name: string }[] } }> } } } };
    const nodes = page.data?.repository?.issues?.nodes;
    if (!nodes) return r;
    const small = nodes.find((n) => n.number === 302);
    if (!small) return r;
    nodes.push({ ...structuredClone(small), number: 320, body: `${small.body}\n${"長い要望。".repeat(300)}`, createdAt: "2026-09-20T03:00:00Z" } as (typeof nodes)[number]);
    if (returned.on) { small.labels.nodes.push({ name: "direct-returned" }); small.updatedAt = "2026-09-30T00:00:00Z"; }
    return { ...r, stdout: JSON.stringify(page) };
  };
  return { ...fake, gh };
}

test("backlog-next: each request starts in the candidate its own criteria choose, with the reason; a returned one goes to PBI にする, once; the buttons keep their reasons", async () => {
  const claude = holdingClaude();
  const returned = { on: false };
  const base = await boot(requestsGh(returned).gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  const provenance = async (n: number) => {
    const t = startedTasks().find((x) => x.stage?.issue === n)!;
    return { title: t.title.split(":")[0], ...((await fetch(`${base}/api/tasks/${t.id}/provenance`).then((r) => r.json())) as { process: { id: string }; processReason: string }) };
  };
  const small = await provenance(302);
  const big = await provenance(320);
  expect(small).toMatchObject({ title: "#302 直行で直す", process: { id: "p1-direct" }, processReason: expect.stringMatching(/^auto direct: 本文 \d+ 字 ≤ 600$/) });
  expect(big).toMatchObject({ title: "#320 PBI にする", process: { id: "p0-pipeline" }, processReason: expect.stringMatching(/^auto pipeline: p1-direct: 本文 \d+ 字 > 600$/) });
  expect(small.processReason).not.toBe(big.processReason);
  // the direct Task ends and the request comes back: PBI にする starts with `direct returned`; no second 直行 on it
  core!.db.updateTask(startedTasks().find((x) => x.stage?.issue === 302)!.id, { status: "done" });
  returned.on = true;
  await refreshed(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().filter((x) => x.stage?.issue === 302).map((x) => x.stage!.action).sort()).toEqual(["direct", "to-pbi"]);
  const t2 = startedTasks().find((x) => x.stage?.issue === 302 && x.stage.action === "to-pbi")!;
  expect(await fetch(`${base}/api/tasks/${t2.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline" }, processReason: "direct returned" });
  core!.db.updateTask(t2.id, { status: "done" });
  expect((await runSchedule(base, id)).status).toBe(409); // nothing left to start
  expect(startedTasks().filter((x) => x.stage?.issue === 302 && x.stage.action === "direct")).toHaveLength(1);
});

test("backlog-next: 直行で直す is the meta workspace's only — another repository's small request goes to PBI にする", async () => {
  const claude = holdingClaude();
  const { base, ids } = await threeWorkspaces(claude.adapter, undefined, requestsGh({ on: false }).gh);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  const of = (ws: string) => startedTasks().find((t) => t.workspaceId === ws && t.stage?.issue === 302)!;
  expect(of(ids.switchboard!).stage!.action).toBe("direct");
  for (const ws of [ids.lib!, ids.app!]) {
    const t = of(ws);
    expect(t.stage!.action).toBe("to-pbi");
    expect(await fetch(`${base}/api/tasks/${t.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline" }, processReason: "auto pipeline: 自動の基準を持つ候補なし" });
  }
});

test("backlog-next: unreadable candidate definitions start no request, and say why; other stages go on", async () => {
  const claude = holdingClaude();
  const base = await boot(requestsGh({ on: false }).gh, claude.adapter);
  // the meta checkout with a broken p1-direct.md (the real p0-pipeline.md beside it)
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const root = mkdtempSync(join(home!, "meta-"));
  mkdirSync(join(root, "ops-kit/processes"), { recursive: true });
  copyFileSync(join(meta.path, "ops-kit/processes/p0-pipeline.md"), join(root, "ops-kit/processes/p0-pipeline.md"));
  writeFileSync(join(root, "ops-kit/processes/p1-direct.md"), "---\nid: p1-direct\nauto: 600\n---\n");
  core!.db.sqlite.query("UPDATE workspaces SET path = ? WHERE id = ?").run(root, meta.id);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 302 || t.stage?.issue === 320)).toEqual([]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#302 を始めない: 候補の定義を読めません"));
});

test("start: the buttons record their own reason, not the criteria's", async () => {
  const base = await boot(requestsGh({ on: false }).gh, holdingClaude().adapter);
  const d = (await (await start(base, 302, { action: "direct" })).json()) as Task;
  const p = (await (await start(base, 320, { action: "to-pbi" })).json()) as Task;
  expect(await fetch(`${base}/api/tasks/${d.id}/provenance`).then((r) => r.json())).toMatchObject({ processReason: "direct button" });
  expect(await fetch(`${base}/api/tasks/${p.id}/provenance`).then((r) => r.json())).toMatchObject({ processReason: "backlog stage to-pbi" });
});

test("backlog-next stalled: the closable Issue 307 is closed and Issue 305, unmoved since its last resume, is left", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "OPEN", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  resumeTried();
  const id = await backlogNextSchedule(base);
  // implement 2: one firing would take both if both could go
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#307 閉じる"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining("#307 を close で開始"));
});

test("backlog-next stalled: Issue 305, which the gate does not hold, is resumed with 実装 before Ready", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(310, "CLOSED", ["type:task"], []), subTask(311, "CLOSED", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  closeTried();
  core!.db.sqlite.run("DELETE FROM tasks WHERE id LIKE 'tsk_close307_resume305_%'"); // no automatic start of it before: nothing holds it
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#305 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#305 を complete で開始"));
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("#305"))!.prompt;
  expect(prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: { tasksDone: 2 } }));
  expect(prompt).toContain("`<!-- tasks-done: 2 -->` を 1 行そのまま入れて");
});

describe("on-hold", () => {
  const at = "2026-09-20T00:00:00Z";
  const answered = { answeredAt: at, tasks: { total: 3, done: 1, doneAt: null } };
  const held: Array<[string, "implement" | "plan", Partial<BacklogItem>]> = [
    ["Ready", "implement", { stage: "ready" }],
    ["閉じられる実装中", "implement", { stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true }],
    ["止まった実装中", "implement", { stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } }],
    ["回答済みの実装中", "implement", { stage: "in-progress", ...answered }],
    ["分解待ち", "plan", { stage: "needs-tasks" }],
    ["要望", "plan", { stage: "request", type: "request" }],
  ];

  test.each(held)("%s: pickNext takes the one without the label; on-hold alone is null; off the label it is taken again", (_, slot, over) => {
    const onHold = item({ number: 1, priority: "P0", onHold: true, ...over });
    const plain = item({ number: 2, priority: "P3", stage: slot === "implement" ? "ready" : "needs-tasks" });
    expect(pickNext([onHold, plain], slot)).toMatchObject({ item: { number: 2 } });
    expect(pickNext([onHold], slot)).toBeNull();
    expect(onHoldIn([onHold, plain], slot).map((i) => i.number)).toEqual([1]);
    expect(pickNext([{ ...onHold, onHold: false }, plain], slot)).toMatchObject({ item: { number: 1 } });
  });

  test("a firing logs 保留: #N on that line only, starts the next item, and the row's button still starts it", async () => {
    // Issue 304 (Ready) also had an 実装 finish with no update since: the 保留 line is the reason it gives, never 前回から更新が無い
    const base = await boot(onHoldGh(304, 303).gh, holdingClaude().adapter);
    const now = Date.now();
    core!.db.insertTask({ id: "tsk_last304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#304 実装: PBI: Ready の PBI"), statusAt: now, createdAt: now, updatedAt: now });
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    const titles = startedTasks().map((t) => t.title);
    expect(titles.filter((t) => t.startsWith("#304 ") || t.startsWith("#303 "))).toEqual(["#304 実装: PBI: Ready の PBI"]); // only the inserted one
    const log = await scheduleLogAll(base);
    expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 保留: #304`));
    expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 計画の枠: 保留: #303`));
    expect(log.filter((l) => l.includes("#304"))).toHaveLength(1);
    const r = await start(base, 304, { action: "complete" });
    expect(r.status).toBe(201);
    expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
  });
});

test("backlog-next failed / awaiting reply: a firing leaves a PBI whose last Task failed on the usage limit or stopped asking, and the log names each, the failed one with its resume time", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  resumeTried();
  const now = Date.now();
  const resumeAt = now + 3_600_000;
  const row = { workspaceId: metaId(), runner: "claude" as const, cwd: home!, scope: [home!], runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto" as const, effort: null, origin: "switchboard" as const, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now };
  // Issue 307 (closable, in progress): its 閉じる hit the weekly limit at once, auto-resume planned; Issue 304 (Ready): its 実装 ended asking the person in its conversation
  core!.db.insertTask({ ...row, id: "tsk_limit307", title: "#307 閉じる: PBI: Task が全部閉じた実装中の PBI", stage: { issue: 307, action: "close" }, status: "error", resumeAt, resumeReason: "limit", resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, outcome: "failed", reviewedAt: null, archivedAt: null });
  core!.db.insertTask({ ...row, id: "tsk_ask304", title: "#304 実装: PBI: Ready の PBI", stage: { issue: 304, action: "complete" }, status: "done", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, outcome: "needs_action", reviewedAt: null, archivedAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#307 閉じる"]); // only the two inserted ones
  // a stopped Task with its resume planned takes no slot (slot does not count a resume): the firing names it as failed
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 返事待ち: #304`));
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 再開の予約: #307（${fmtTime(resumeAt, now)} に再開）`));
  expect(log).not.toContainEqual(expect.stringContaining("前回から更新が無い: #304"));
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // reviewed (the person read the question): the 実装 is started again next firing, with no update to the Issue
  core!.db.updateTask("tsk_ask304", { reviewedAt: now + 1 });
  expect((await runSchedule(base, id)).status).toBe(201);
  const again = (await scheduleLogAll(base)).slice(log.length);
  expect(again).not.toContainEqual(expect.stringContaining("返事待ち"));
  expect(again).not.toContainEqual(expect.stringContaining("前回から更新が無い: #304"));
  expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
});

test("backlog-next held: a Ready PBI whose last 実装 was started by itself and nothing happened since is not started and the log names the gate's line once; the button still starts it", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  // Issue 304 (updated 2026-09-20) had an 実装 that finished after that
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { ...fixtureStage("#304 実装: PBI: Ready の PBI")!, auto: true }, statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]); // only the old Issue 304 実装
  const log = await scheduleLogAll(base);
  // one line for every item the gate holds (closeTried's 305 and 307 too)
  expect(log).toContainEqual(expect.stringMatching(new RegExp(`飛ばした \\(manual\\): ${metaName()}: 実装の枠: 前回の開始から出来事が増えていない: .*#304（前回 tsk_last304）`)));
  expect(log.filter((l) => l.includes("#304"))).toHaveLength(1); // said once: not again for the item the slot picked
  expect(log).not.toContainEqual(expect.stringContaining("前回から更新が無い"));
  // the row's button is not held by it
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 実装: "))).toHaveLength(2);
});

test("a held PBI is named in the log and not started", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  // a conversation Task claims Issue 304 by a comment of the parallel guard, as /pbi-complete does
  const holder = ((await (await fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), title: "会話", prompt: "会話", runner: "claude" }) })).json()) as { id: string }).id;
  const token = ((await (await fetch(`${base}/api/tasks/${holder}/mcp`)).json()) as { token: string }).token;
  const said = await fetch(`${base}/api/backlog/304/comment`, { method: "POST", headers: { "x-task-id": holder, "x-task-token": token }, body: JSON.stringify({ workspaceId: metaId(), text: "<!-- pbi-complete:claim t1 -->\n着手" }) });
  expect(said.status).toBe(202);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().filter((t) => t.title.startsWith("#304 "))).toHaveLength(0);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 占有中: #304（Task ${holder}）`));
});

test("backlog-next: a firing starts the picked item's stage Task, and the scheduled complete uses the button prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  const r = await runSchedule(base, id);
  expect(r.status).toBe(201);
  const task = core!.db.listTasks().find((t) => t.title.startsWith("#304 実装: "))!;
  expect(task.scheduleId).toBe(id);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#304 を complete で開始"));
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("/pbi-complete 304"))!.prompt;
  expect(prompt).toBe(buildStartPrompt({ number: 304 }, "complete"));
});

test("backlog-next: a firing starts on the schedule's model and effort, and not on autoStart's (schedule model, schedule effort)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto", effort: "high" } });
  const id = await backlogNextSchedule(base, undefined, "m-sched", "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(core!.db.listTasks().find((t) => t.scheduleId === id)).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
  expect(claude.starts[0]!.model).toBe("m-sched");
  expect(claude.starts.map((s) => s.effort)).toEqual(claude.starts.map(() => "low"));
});

test("backlog-next: a schedule without a model or an effort starts on the CLI default, not on autoStart's (schedule model, schedule effort)", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto", effort: "high" } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.model).toBeUndefined();
  expect(claude.starts[0]!.effort).toBeUndefined();
});

test("backlog-next by kind: the schedule's runner and model win over a kind's own runner", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-auto", byKind: { complete: { runner: "codex", model: "m-impl" } } } });
  const id = await backlogNextSchedule(base, undefined, "m-sched", "low");
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = core!.db.listTasks().filter((t) => t.scheduleId === id);
  expect(started.map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect(started.find((t) => t.title.startsWith("#304 実装"))).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
  expect(started.find((t) => t.title.startsWith("#303 Task に分解"))).toMatchObject({ runner: "claude", model: "m-sched", effort: "low" });
});

test("backlog-next: the prompt of a button start names the merge gate only as the request's scope", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await start(base, 304, { action: "complete" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ");
  expect(claude.starts[0]!.prompt).not.toContain("--allow-large");
});

test("backlog-next slots: a running plan Task (from a button too) holds that workspace's plan slot only; its implement slot still starts", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  const manual = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 計画の枠が埋まっている: 工程 Task ${manual.id}`));
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next slots: 実行枠待ちの工程 Task は枠を埋め、その Issue のボタンは 409 で taskId を返す", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRunners: 1 }) });
  const manual = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const queued = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(core!.db.getTask(queued.id)!.queuedAt).not.toBeNull();
  const again = await start(base, 304, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(queued.id);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(409); // nothing started: both slots are held
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠が埋まっている: 工程 Task ${queued.id}`));
  expect((await scheduleLogAll(base)).join("\n")).toContain("が 実行枠待ち");
  expect(startedTasks()).toHaveLength(2);
});

test("backlog-next slots: a running implement Task leaves the plan slot open", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  const manual = await (await start(base, 304, { action: "complete" })).json() as Task;
  for (let i = 0; core!.db.getTask(manual.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠が埋まっている: 工程 Task ${manual.id}`));
});

test("backlog-next slots: Claude usage at 0.8 or more — one stage Task only while none runs anywhere; none while one runs", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  const later = Math.floor(Date.now() / 1000) + 3600; // resetsAt is in seconds, as Claude reports it
  core!.db.upsertQuota("claude", "seven_day", 0.5, later);
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(startedTasks()[0]!.title.startsWith("#304 実装: ")).toBe(true);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: claude の使用量 five_hour が 85%`));
  // the one it started runs: the next firing starts nothing, and says which window
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain("飛ばした (manual): claude の使用量 five_hour が 85%（80% 以上）: 工程 Task が動いているので始めない");
  expect(startedTasks()).toHaveLength(1);
});

/** backlog quota: a backlog-next schedule on `runner`, with Claude and Codex both detected and holding. */
async function bootTwo(runner: "claude" | "codex") {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  closeTried();
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: metaId(), runner, prompt: "", action: "backlog-next" }) });
  expect(r.status).toBe(201);
  return { base, id: (await r.json() as { id: string }).id, claude: claude.starts, codex: codex.starts };
}

test("backlog quota: a codex schedule is not held back by Claude's usage; Codex's own at 0.85 holds it to one", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("codex");
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  core!.db.upsertQuota("claude", "seven_day", 1, later); // even at its limit
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]); // both slots, as with no usage
  expect((await scheduleLogAll(a.base)).some((l) => l.includes("の使用量"))).toBe(false);
  await shutdown();
  const b = await bootTwo("codex");
  core!.db.upsertQuota("codex", "five_hour", 0.85, later);
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(b.base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: codex の使用量 five_hour が 85%`));
});

test("backlog quota: a claude schedule at Claude's limit with the fallback codex starts on codex and is judged by Codex's usage", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("claude");
  core!.db.upsertQuota("claude", "five_hour", 0.95, later);
  core!.db.setSetting("settings", { autoStart: { fallback: ["codex"] } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]); // Codex has no usage: as the slots allow
  expect(a.claude).toHaveLength(0);
  expect(core!.db.listEvents(startedTasks()[0]!.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("claude が上限（0.95、"))).toBe(true);
  await shutdown();
  const b = await bootTwo("claude");
  core!.db.upsertQuota("claude", "seven_day", 1, later); // at its limit: no longer "start nothing" while codex can take it
  core!.db.upsertQuota("codex", "five_hour", 0.85, later);
  core!.db.setSetting("settings", { autoStart: { fallback: ["codex"] } });
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex"]);
  expect(await scheduleLogAll(b.base)).toContainEqual(expect.stringContaining("codex の使用量 five_hour が 85%（80% 以上）: 全体で 1 件まで"));
});

test("backlog quota: the schedule's runner is judged, not the kind's own — claude at its limit does not hold 実装 of a codex schedule whose kind default is claude", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const a = await bootTwo("codex");
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  core!.db.setSetting("settings", { autoStart: { byKind: { complete: { runner: "claude", model: "", effort: "" } } } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => [t.title.split(":")[0], t.runner, !!t.scheduleId]).sort()).toEqual([["#303 Task に分解", "codex", true], ["#304 実装", "codex", true]]);
  expect(a.claude).toHaveLength(0);
});

/** backlog-next login: a Claude and a Codex that say `login` / `loginExpiresAt` from detect() (read again after a minute); the schedule runs on `runner`. */
type LoginState = { login?: "ok" | "expired" | "unknown"; loginExpiresAt?: number };

async function bootLogin(runner: "claude" | "codex", login: { claude?: LoginState; codex?: LoginState }, bedrock = false) {
  const state: { claude: LoginState; codex: LoginState } = { claude: { login: "ok", ...login.claude }, codex: { login: "ok", ...login.codex } };
  const claude = holdingClaude();
  const codex = holdingClaude();
  const withBedrock = bedrock ? { bedrockModel: (m: { value: string; label: string }) => ({ value: `global.anthropic.${m.value}`, label: m.label }) } : {};
  const base = await boot(fakeGh().gh, [{ ...claude.adapter, ...withBedrock, detect: async () => ({ available: true, ...state.claude }) }, { ...codex.adapter, id: "codex", detect: async () => ({ available: true, ...state.codex }) }]);
  closeTried();
  const r = await fetch(`${base}/api/schedules`, { method: "POST", body: JSON.stringify({ title: "バックログを進める", cron: "0 */3 * * *", workspaceId: metaId(), runner, prompt: "", action: "backlog-next" }) });
  expect(r.status).toBe(201);
  return { base, id: (await r.json() as { id: string }).id, state };
}

const HOUR = 3600_000;

const titles = () => startedTasks().map((t) => t.title.split(":")[0]).sort();

test("backlog-next login: a runner whose login lapsed (claude) starts no stage Task in any slot and the log says so", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(a.base)).toContain("飛ばした (manual): claude のログインが切れている: 始めない");
});

test("backlog-next login: codex expired holds a codex schedule the same way, and a claude schedule is not held by it", async () => {
  const a = await bootLogin("codex", { codex: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(a.base)).toContain("飛ばした (manual): codex のログインが切れている: 始めない");
  await shutdown();
  const b = await bootLogin("claude", { codex: { login: "expired" } });
  expect((await runSchedule(b.base, b.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: claude's login lapsing in 23 hours holds the implement slot only, naming the time", async () => {
  const at = Date.now() + 23 * HOUR;
  const a = await bootLogin("claude", { claude: { loginExpiresAt: at } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(a.base)).toContainEqual(expect.stringContaining(`claude のログインが ${fmtTime(at, Date.now())} に切れる: 実装の枠を始めない`));
});

test("backlog-next login: with 25 hours left both slots start", async () => {
  const a = await bootLogin("claude", { claude: { loginExpiresAt: Date.now() + 25 * HOUR } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
  expect((await scheduleLogAll(a.base)).some((l) => l.includes("のログインが"))).toBe(false);
});

test("backlog-next login: the expiry hold does not apply to a codex schedule, whatever Claude's expiry", async () => {
  const a = await bootLogin("codex", { claude: { loginExpiresAt: Date.now() + HOUR }, codex: { loginExpiresAt: Date.now() + HOUR } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(startedTasks().map((t) => t.runner)).toEqual(["codex", "codex"]);
});

test("backlog-next login: Claude on Bedrock (login reads ok, no expiry) is not held, even if its own login lapsed", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired", loginExpiresAt: Date.now() + HOUR } }, true);
  core!.db.setSetting("settings", { bedrock: { claude: { region: "ap-northeast-1" } } });
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: an unknown expiry does not hold", async () => {
  const a = await bootLogin("claude", {});
  expect((await runSchedule(a.base, a.id)).status).toBe(201);
  expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next login: the row's button still starts a stage Task while the login is expired", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect((await start(a.base, 304, { action: "complete" })).status).toBe(201);
});

test("backlog-next login: after logging in again (ok, expiry in 30 days) the next firing starts as before", async () => {
  const a = await bootLogin("claude", { claude: { login: "expired" } });
  expect((await runSchedule(a.base, a.id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  a.state.claude = { login: "ok", loginExpiresAt: Date.now() + 30 * 24 * HOUR };
  const realNow = Date.now.bind(Date);
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 61_000); // the health check reads the status again after a minute
  try {
    await fetch(`${a.base}/api/health`);
    expect((await runSchedule(a.base, a.id)).status).toBe(201);
    expect(titles()).toEqual(["#303 Task に分解", "#304 実装"]);
  } finally {
    clock.mockRestore();
  }
});

test("backlog-next slots: settings tunables — backlogQuotaLimit 0.5 holds back at Claude usage 0.6, read at each firing", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  core!.db.upsertQuota("claude", "five_hour", 0.6, Math.floor(Date.now() / 1000) + 3600);
  core!.db.setSetting("settings", { quotaAndResume: { backlogQuotaLimit: 0.5 } });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 計画の枠: claude の使用量 five_hour が 60%`));
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain("飛ばした (manual): claude の使用量 five_hour が 60%（50% 以上）: 工程 Task が動いているので始めない");
});

test("backlog-next slots: settings tunables — with the default threshold, Claude usage 0.6 starts per slot", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  core!.db.upsertQuota("claude", "five_hour", 0.6, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
});

test("backlog-next slots: Claude usage at 0.8 or more — a stage Task that starts while GitHub is read counts; the firing starts nothing", async () => {
  const ok = fakeGh();
  let during: (() => void) | null = null;
  const gh: GhRunner = async (args, cwd) => {
    // a read of the backlog, not of GitHub's budget, which comes before the quota check
    if (args[0] === "api" && !args.some((a) => a.includes("rateLimit")) && during) { during(); during = null; }
    return ok.gh(args, cwd);
  };
  const base = await boot(gh, holdingClaude().adapter);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  // Issue 303's plan Task (a button's) is running by the time GitHub answers: after the firing's quota check, before its start
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  during = () => { core!.db.insertTask({ id: "task_button303", workspaceId: meta.id, title: "#303 Task に分解: x", runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#303 Task に分解: x"), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() }); };
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: claude の使用量 five_hour が 85%`));
});

test("backlog-next slots: Claude usage at 0.8 or more — one start per firing, even when the one it started has already ended", async () => {
  // a runner whose turn is over right after it starts: the Task started first is no longer running when the next is picked
  const quick: RunnerAdapter = { ...holdingClaude().adapter, start(opts, emit) {
    queueMicrotask(() => { for (const t of core!.db.listTasksByStatus("running")) core!.db.updateTask(t.id, { status: "done" }); });
    return holdingClaude().adapter.start(opts, emit);
  } };
  const base = await boot(fakeGh().gh, quick);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("backlog-next slots: a button's Task holds that slot while its routing turn is still thinking; the other slot starts", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const slow: Suggester = { suggest: async () => (await held, { runner: "claude", reason: "slow", ruleId: "llm", model: null, available: true, alternatives: [], llm: null }) };
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter, {}, () => slow);
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  const id = await backlogNextSchedule(base);
  const button = await start(base, 304, { action: "complete" }); // answered with the suggester still held
  expect(button.status).toBe(201);
  expect(core!.db.listTasks().map((t) => [t.title.split(":")[0], t.status, t.routing?.llm])).toEqual([["#304 実装", "running", null]]);
  // the button holds the implement slot; the plan slot still starts Issue 303
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  release();
});

test("backlog-next slots: Claude usage at 100% — the firing starts nothing and names the window and when it is back; a reset row does not count", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  const now = Date.now();
  const later = Math.floor(now / 1000) + 3600;
  core!.db.upsertQuota("claude", "five_hour", 0.2, later);
  core!.db.upsertQuota("claude", "seven_day", 1, later);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(0);
  expect(await scheduleLog(base)).toContain(`飛ばした (manual): claude の使用量 seven_day が 100%: ${fmtTime(later * 1000, now)} に戻るまで始めない`);
  // the window reset: the 0.8 rule applies again (one start while none runs)
  core!.db.upsertQuota("claude", "seven_day", 1, Math.floor(now / 1000) - 60);
  core!.db.upsertQuota("claude", "five_hour", 0.85, later);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks()).toHaveLength(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("claude の使用量 five_hour が 85%（80% 以上）: 全体で 1 件まで"));
});

test("backlog-next: a high usage row whose window has already reset does not hold the sweep", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) - 60);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(2);
});

test("backlog-next picks a local Ready PBI with gh throwing", async () => {
  const throwing: GhRunner = async () => { throw new Error("spawn gh ENOENT"); };
  const claude = holdingClaude();
  const base = await boot(throwing, claude.adapter);
  const dir = mkdtempSync(join(home!, "local-"));
  copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(dir, "ops.config.json"));
  const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "local", backlog: "switchboard" }) })).json()) as { id: string };
  const made = await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "PBI: ローカル", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1" } }) });
  expect(made.status).toBe(202);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const t = startedTasks().find((x) => x.workspaceId === ws.id);
  expect(t?.stage).toEqual({ issue: 1, action: "complete", auto: true });
  for (let i = 0; !claude.starts.length && i < 200; i++) await Bun.sleep(10);
  expect(claude.starts.map((s) => s.prompt).join("\n")).toContain("PBI #1 を完了させてください");
  expect((await scheduleLogAll(base)).filter((l) => l.includes("local: GitHub"))).toEqual([]);
});

describe("backlog-next auth", () => {
  // the import's `gh api` is refused for the login; every other call goes to the fake
  const refused = (stderr: string): GhRunner => {
    const ok = budgetGh(5000);
    let on = false;
    const gh: GhRunner = async (args, cwd) => (on && args[0] === "api" && !args.some((a) => a.includes("rateLimit")) ? { code: 1, stdout: "", stderr } : ok.gh(args, cwd));
    return Object.assign(gh, { refuse: () => { on = true; }, allow: () => { on = false; } });
  };
  const run = async (stderr: string) => {
    const gh = refused(stderr);
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    return { base, status: (await runSchedule(base, id)).status };
  };

  test("backlog-next auth: an import refused with HTTP 401 holds the implement slot and logs it", async () => {
    const { base } = await run("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/実装の枠: GitHub の認証切れ: 始めない（.*HTTP 401: Bad credentials.*）/));
  });

  test("backlog-next auth: gh auth login wording holds it too", async () => {
    const { base } = await run("To get started with GitHub CLI, please run:  gh auth login");
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/実装の枠: GitHub の認証切れ: 始めない（.*gh auth login.*）/));
  });

  test("backlog-next auth: the read right before a start refused with HTTP 401 holds the implement slot too", async () => {
    // one settle is 4 `gh api` calls here: the firing's first read gets through, the read right before the start is refused
    const ok = budgetGh(5000);
    let calls = -1;
    const gh: GhRunner = async (args, cwd) => (calls >= 0 && args[0] === "api" && ++calls > 4 ? { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" } : ok.gh(args, cwd));
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    calls = 0;
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().filter((t) => t.title.includes("実装"))).toHaveLength(0);
    const log = await scheduleLogAll(base);
    const held = log.findIndex((l) => /実装の枠: GitHub の認証切れ: 始めない（.*HTTP 401.*）/.test(l));
    expect(held).toBeGreaterThanOrEqual(0);
    // held by the read right before the start: the firing's first read got through, so no "照合できない" line comes before it
    expect(log.slice(0, held).filter((l) => l.includes("GitHub と照合できない"))).toEqual([]);
  });

  // an ended implement-slot stage Task of an Issue that is not in the fake backlog, with one stop.record
  const endedOnStop = async (state: "waiting" | "resolved") => {
    await Bun.sleep(50); // the import the boot started has finished: the stop is after the last successful one
    const now = Date.now();
    const id = "tsk_authstop399";
    core!.db.insertTask({ id, workspaceId: metaId(), title: "#399 実装: PBI: 認証で止まった", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 399, action: "complete" }, statusAt: now, createdAt: now, updatedAt: now });
    core!.db.appendEvent(id, { t: "stop.record", stop: { id: "s399", work: { workspaceId: metaId(), issue: 399, taskId: id }, op: "gh", target: "", reason: "auth", evidence: "HTTP 401", safety: "before-effect", conditions: [], answer: null, actions: [], state, at: now } });
  };
  const implementStarts = () => startedTasks().filter((t) => t.title.includes("実装") && t.id !== "tsk_authstop399");

  test("backlog-next auth: a last implement Task stopped on auth holds the slot while the import fails for another reason", async () => {
    const gh = refused("dial tcp: i/o timeout");
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("waiting");
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("実装の枠: GitHub の認証切れ: 始めない（直前の工程 Task tsk_authstop399 が認証で止まり"));
  });

  test("backlog-next auth: an import that succeeds after the auth stop lets the next firing start", async () => {
    // a failure that is neither the login nor a transient one: no wait before the next firing's import
    const gh = refused("gh: unexpected error") as GhRunner & { refuse(): void; allow(): void };
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("waiting");
    gh.refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(0);
    // the fake gh is back: the next firing's import succeeds and lifts the hold
    gh.allow();
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(1);
  });

  test("backlog-next auth: a resolved auth stop does not hold", async () => {
    const gh = refused("dial tcp: i/o timeout");
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    await endedOnStop("resolved");
    (gh as unknown as { refuse(): void }).refuse();
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementStarts()).toHaveLength(1);
    expect((await scheduleLogAll(base)).filter((l) => l.includes("認証切れ"))).toEqual([]);
  });

  test("backlog-next auth: the plan slot still starts while login is refused", async () => {
    const { status } = await run("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    expect(status).toBe(201);
    expect(startedTasks().map((t) => t.title.split(":")[0])).toContain("#303 Task に分解");
  });

  test("backlog-next auth: a workspace kept here (backlog: switchboard) still starts its implement slot", async () => {
    const gh = refused("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    const claude = holdingClaude();
    const base = await boot(gh, claude.adapter);
    (gh as unknown as { refuse(): void }).refuse();
    const dir = mkdtempSync(join(home!, "local-"));
    copyFileSync(join(import.meta.dir, "../../../ops.config.json"), join(dir, "ops.config.json"));
    const ws = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "local", backlog: "switchboard" }) })).json()) as { id: string };
    await fetch(`${base}/api/backlog`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "PBI: ローカル", labels: ["type:pbi"], fields: { Status: "Ready", Priority: "P1" } }) });
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(startedTasks().find((x) => x.workspaceId === ws.id)?.stage).toEqual({ issue: 1, action: "complete", auto: true });
    expect((await scheduleLogAll(base)).filter((l) => l.includes("local: ") && l.includes("認証切れ"))).toEqual([]);
  });

  test("backlog-next auth: the start button still answers 201 while login is refused", async () => {
    const gh = refused("HTTP 401: Bad credentials (https://api.github.com/graphql)");
    const base = await boot(gh, holdingClaude().adapter);
    (gh as unknown as { refuse(): void }).refuse();
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  });
});

test("backlog-next: the unattended stage Task gets no shadow and carries the schedule's budget", async () => {
  const dakStarts: StartOptions[] = [];
  const dak: RunnerAdapter = { id: "dak", detect: async () => ({ available: true }), start(opts) { dakStarts.push(opts); return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }; } };
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [holdingClaude().adapter, dak], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(fakeGh().gh) });
  const base = `http://127.0.0.1:${core.server.port}`;
  // a default shadow is saved: the button path would mirror to it, the unattended sweep must not
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ shadowRunner: "dak" }) })).status).toBe(200);
  const id = await backlogNextSchedule(base, 5);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks()).toHaveLength(2);
  for (const t of core!.db.listTasks()) expect(t).toMatchObject({ budgetUsd: 5, shadowOf: null });
});

test("backlog-next: a decomposed PBI in 分解待ち starts with the make-Ready prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(decomposedGh().gh, claude.adapter);
  closeTried();
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#303 を to-tasks で開始"));
  for (let i = 0; !claude.starts.some((x) => x.prompt.includes("PBI #303")) && i < 100; i++) await Bun.sleep(10);
  const prompt = claude.starts.find((x) => x.prompt.includes("PBI #303"))!.prompt;
  expect(prompt).toContain(DECOMPOSED_READY(303, 2));
  expect(prompt).toContain("既にある Task を作り直さずに");
  expect(prompt).not.toContain("Task に分解して Ready にしてください");
});

test("backlog-next slots: one firing starts an implement and a plan stage Task on every workspace; a second firing starts nothing more", async () => {
  const claude = holdingClaude();
  const { base, ids, dirs } = await threeWorkspaces(claude.adapter);
  closeTried(...Object.values(ids));
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = startedTasks();
  expect(tasks).toHaveLength(6);
  for (const ws of Object.values(ids)) expect(tasks.filter((t) => t.workspaceId === ws).map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装"]);
  const log = await scheduleLogAll(base);
  for (const name of [meta.name, "lib", "app"]) {
    expect(log).toContainEqual(expect.stringContaining(`${name} #304 を complete で開始`));
    expect(log).toContainEqual(expect.stringContaining(`${name} #303 を to-tasks で開始`));
  }
  // another repository's Task runs there, and its unattended merge goes through merge-gate for that repository
  for (let i = 0; claude.starts.length < 6 && i < 100; i++) await Bun.sleep(10);
  const lib = claude.starts.find((x) => x.cwd === dirs.lib && x.prompt.includes("PBI #304"))!;
  expect(lib.prompt).toContain("`--repo <このリポジトリの owner/name>`");
  expect(lib.prompt).toContain(`${meta.path}/docs/merge-gate.md`);
  expect(lib.prompt).not.toContain("定期実行が始めた無人の実装");
  // every slot is taken: the same firing again starts nothing and says why per workspace
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(startedTasks()).toHaveLength(6);
  const again = (await scheduleLogAll(base)).slice(log.length);
  expect(again.filter((l) => l.includes("の枠が埋まっている"))).toHaveLength(6);
});

test("backlog-next slots: the workspace's sweep applies from the next firing — implement 2 starts two implementations on one workspace, plan 0 none", async () => {
  // a second Ready PBI (Issue 309, a copy of Issue 304) on the first page
  const page = structuredClone(pages[0]) as { data: { repository: { issues: { nodes: RawBacklogIssue[] } } } };
  const nodes = page.data.repository.issues.nodes;
  nodes.push({ ...structuredClone(nodes.find((n) => n.number === 304)!), number: 309, title: "もう 1 件の Ready" });
  const ok = fakeGh();
  // its comments too: a Ready PBI's are read for its waits
  const comments = structuredClone(decisions) as { data: { repository: Record<string, unknown> } };
  comments.data.repository.i309 = { comments: { nodes: [] } };
  const gh: GhRunner = async (args, cwd) =>
    args.some((a) => a.includes("comments(last:")) ? { code: 0, stdout: JSON.stringify(comments), stderr: "" }
    : args[0] === "api" && !args.includes("after=CURSOR1") ? { code: 0, stdout: JSON.stringify(page), stderr: "" } : ok.gh(args, cwd);
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  const settings = (body: { implement?: number; plan?: number }) => sweepAll(base, body);
  const id = await backlogNextSchedule(base);
  // plan 0 with no plan Task running: Issue 303 waits to be split, yet no plan Task starts, and the log says nothing of that slot
  expect((await settings({ implement: 1, plan: 0 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).toEqual(["#304 実装"]);
  expect((await scheduleLogAll(base)).some((l) => l.includes("計画の枠"))).toBe(false);
  // implement 2 from the next firing: the second Ready PBI starts on the same workspace
  expect((await settings({ implement: 2 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect((await runSchedule(base, id)).status).toBe(409);
  expect(await scheduleLog(base)).toContain(`${metaName()}: 実装の枠が埋まっている`);
  // back to plan 1: the next firing starts Issue 303
  expect((await settings({ plan: 1 })).status).toBe(200);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#304 実装", "#309 実装"]);
});

test("backlog-next flow limit: with implement 2, a firing starts one flow PBI, logs the other as waiting, and starts the one without the label", async () => {
  // Issue 304 and its copies Issue 309 / Issue 310 are Ready; Issue 304 and Issue 309 carry flow-improvement
  const inner = moreReadyGh(309, 310);
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304 || node.number === 309) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = startedTasks().map((t) => t.title.split(":")[0]);
  // one flow PBI from Ready, then not the second in the same firing: the one without the label instead
  expect(started.filter((t) => t === "#304 実装" || t === "#309 実装")).toHaveLength(1);
  expect(started).toContain("#310 実装");
  const waiting = started.includes("#304 実装") ? 309 : 304;
  // the line names the one counted (started in this firing) and where the limit is changed
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 開発の流れの PBI は同時 1 件まで（Settings の「開発の流れの同時の上限」。実装中 1 件: #${waiting === 309 ? 304 : 309}）: 待ち #${waiting}`));
});

test("backlog-next flow limit: a flow PBI that became in progress after the first read counts against the limit after a start", async () => {
  // Issue 307 (in progress; its close was tried, so the first read does not count it) and Issue 309 (Ready) carry flow-improvement; the limit is 1
  const inner = moreReadyGh(309, 310);
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 307 || node.number === 309) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  let first = true;
  // while the firing starts Issue 304, a stage Task of Issue 307 starts elsewhere (a button): the first read did not count it
  const routing: Suggester = { suggest: async () => {
    if (first) { first = false; runningStage("#307 閉じる: PBI: Task が全部閉じた実装中の PBI"); }
    return { runner: "claude", reason: "r", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
  } };
  const base = await boot(gh, holdingClaude().adapter, {}, () => routing);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  await sweepAll(base, { implement: 3, plan: 0 });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const started = startedTasks().map((t) => t.title.split(":")[0]);
  // 309 is held by the limit once 307 runs; 304 and 310 (no label) start
  expect(started.filter((t) => t?.startsWith("#309"))).toEqual([]);
  expect(started).toEqual(expect.arrayContaining(["#304 実装", "#310 実装"]));
});

test("backlog-next slots per workspace: lib implement 2 starts two, app and meta at implement 0 start none and log no slot line", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, undefined, moreReadyGh(309));
  closeTried(...Object.values(ids));
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const patch = (ws: string, sweep: unknown) => fetch(`${base}/api/workspaces/${ws}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep }) });
  expect((await patch(ids.lib!, { implement: 2, plan: 0 })).status).toBe(200);
  for (const ws of [ids.app!, meta.id]) expect((await patch(ws, { implement: 0, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = startedTasks();
  expect(tasks.filter((t) => t.workspaceId === ids.lib).map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect(tasks.filter((t) => t.workspaceId !== ids.lib)).toHaveLength(0);
  const log = await scheduleLogAll(base);
  expect(log.some((l) => l.includes("app:") || l.includes(`${meta.name}:`))).toBe(false);
  // lib's slot is full now: the next firing names it there only
  expect((await runSchedule(base, id)).status).toBe(409);
  const again = await scheduleLog(base);
  expect(again).toContain("lib: 実装の枠が埋まっている");
  expect(again.includes("app:") || again.includes(`${meta.name}:`)).toBe(false);
});

const runningStage = (title: string) => {
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  core!.db.insertTask({ id: `task_${title.split(" ")[0]!.slice(1)}`, workspaceId: meta.id, title, runner: "claude", cwd: meta.path, scope: [meta.path], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
};

test("start race: a button start and a backlog-next firing on the same item make one Task", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  closeTried();
  await sweepAll(base, { implement: 2, plan: 1 });
  const id = await backlogNextSchedule(base);
  // implement 2: the slot has room for both; whichever of the two makes Issue 304's stage Task first, the other finds it
  const [button, firing] = await Promise.all([start(base, 304, { action: "complete" }), runSchedule(base, id)]);
  expect(firing.status).toBe(201);
  expect([201, 409]).toContain(button.status);
  const mine = startedTasks().filter((t) => t.title.startsWith("#304 "));
  expect(mine.length).toBe(1);
  if (button.status === 409) expect(((await button.json()) as { taskId: string }).taskId).toBe(mine[0]!.id);
});

test("start race: a firing skips an item whose stage Task started after GitHub was read, and starts the next one", async () => {
  let first = true;
  // while the firing starts Issue 304, a stage Task of Issue 309 starts elsewhere (a button, an answer's resume): GitHub was read before it
  const routing: Suggester = { suggest: async () => {
    if (first) { first = false; runningStage("#309 実装: Ready の写し 309"); }
    return { runner: "claude", reason: "r", ruleId: "llm", model: null, available: true, alternatives: [], llm: null };
  } };
  const base = await boot(moreReadyGh(309, 310), holdingClaude().adapter, {}, () => routing);
  closeTried();
  await fetch(`${base}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ routing: { llm: { enabled: true } } }) });
  await sweepAll(base, { implement: 3, plan: 0 });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装", "#310 実装"]);
  // Issue 309 is not picked at all now: the read after Issue 304's start already shows its stage Task, so there is no "工程 Task が動いている" skip line
  expect(startedTasks().filter((t) => t.title.startsWith("#309 実装"))).toHaveLength(1); // the one started elsewhere only
});

test("backlog-next slots: a workspace whose GitHub cannot be read goes on with what is stored (nothing, never imported); the others start", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, "lib");
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const tasks = core!.db.listTasks();
  expect(tasks).toHaveLength(4);
  expect(tasks.filter((t) => t.workspaceId === ids.lib)).toHaveLength(0);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("飛ばした (manual): lib: GitHub と照合できない（保存データで進める）: gh repo view: HTTP 404"));
});

test("backlog-next held without a new event is logged and the button still starts it", async () => {
  const c = commentingGh();
  const base = await boot(c.gh, holdingClaude().adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const first = startedTasks().find((t) => t.stage?.issue === 307)!;
  expect(first.stage).toEqual({ issue: 307, action: "close", auto: true });
  core!.db.updateTask(first.id, { status: "done" });
  await Bun.sleep(5);
  // the Task's own plain comment, after it ended: the older check lets the PBI pass, and no event came
  c.on.v = true;
  await refreshed(base);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 307)).toHaveLength(1);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`飛ばした (manual): ${metaName()}: 実装の枠: 前回の開始から出来事が増えていない: #307（前回 ${first.id}）`));
  expect((await start(base, 307, { action: "close" })).status).toBe(201);
  expect(startedTasks().filter((t) => t.stage?.issue === 307)).toHaveLength(2);
});

test.each([
  ["a failed Task with no update since", 304, "complete", "error", 1],
  ["a resume whose mark did not move", 305, "complete", "done", 1],
  ["a resume that ended before writing its mark", 305, "complete", "done", 2],
  ["a 閉じる that did not close", 307, "close", "done", 1],
] as const)("a held item has one reason in the log: %s", async (_, n, action, status, closed) => {
  const subs = [subTask(310, "CLOSED", ["type:task"], []), subTask(311, closed === 2 ? "CLOSED" : "OPEN", ["type:task"], []), subTask(312, "OPEN", ["type:task"], [])];
  const base = await boot(taskDecisionGh({ i305: subs, i307: [] }).gh, holdingClaude().adapter);
  const now = Date.now();
  const title = `#${n} ${action === "close" ? "閉じる" : "実装"}: PBI`;
  // its last stage Task was started by itself (`auto`) and ended; nothing the gate counts happened since
  core!.db.insertTask({ id: `tsk_prev${n}`, workspaceId: metaId(), title, runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: status === "error" ? "failed" : "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: n, action, auto: true }, statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 3, plan: 0 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === n).map((t) => t.id)).toEqual([`tsk_prev${n}`]); // only the inserted one
  const log = (await scheduleLogAll(base)).filter((l) => new RegExp(`#${n}(?!\\d)`).test(l));
  expect(log).toEqual([expect.stringContaining(`${metaName()}: 実装の枠: 前回の開始から出来事が増えていない: #${n}（前回 tsk_prev${n}）`)]);
  expect((await scheduleLogAll(base)).join("\n")).not.toMatch(/前回の Task が失敗したまま更新が無い|前回の再開から進んでいない/);
});

describe("the gate line is the start's answer", () => {
  const insert = (id: string, n: number, action: "complete" | "close", createdAt: number) =>
    core!.db.insertTask({ id, workspaceId: metaId(), title: `#${n} ${action === "close" ? "閉じる" : "実装"}: PBI`, runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: n, action, auto: true }, statusAt: createdAt + 500, createdAt, updatedAt: createdAt + 500 });
  const fire = async (base: string) => {
    const id = await backlogNextSchedule(base);
    expect((await sweepAll(base, { implement: 3, plan: 0 })).status).toBe(200);
    await runSchedule(base, id);
    return scheduleLogAll(base);
  };
  const naming = (log: string[], n: number) => log.filter((l) => new RegExp(`#${n}(?!\\d)`).test(l));
  const answered = (now: number) => ({ i307: [{ body: "## 回答\n受け入れ条件 1 を確認した", createdAt: new Date(now - 500).toISOString() }] });

  test("an answered closable PBI the gate holds for 実装 is named on the gate line", async () => {
    const now = Date.now();
    const base = await boot(taskDecisionGh({ i305: [], i307: [] }, answered(now)).gh, holdingClaude().adapter);
    insert("tsk_auto307", 307, "complete", now - 2000);
    const log = await fire(base);
    expect(startedTasks().filter((t) => t.stage?.issue === 307).map((t) => t.id)).toEqual(["tsk_auto307"]);
    expect(naming(log, 307)).toEqual([expect.stringContaining("前回の開始から出来事が増えていない: #307（前回 tsk_auto307）")]);
  });

  test("an item the firing starts is not called held", async () => {
    const now = Date.now();
    const base = await boot(taskDecisionGh({ i305: [], i307: [subTask(320, "CLOSED", ["type:task"], [])] }, answered(now)).gh, holdingClaude().adapter);
    insert("tsk_old_complete", 307, "complete", 1000); // events came after it: 実装 may start
    insert("tsk_new_close", 307, "close", now - 2000); // nothing since: 閉じる would be held
    const log = await fire(base);
    expect(startedTasks().some((t) => t.stage?.issue === 307 && !t.id.startsWith("tsk_"))).toBe(true);
    expect(naming(log, 307).filter((l) => l.includes("前回の開始から出来事が増えていない"))).toEqual([]);
  });

  test("an item another line names is not named on the gate line too", () => {
    const autoHeld = { previousTaskId: "tsk_prev", action: "complete" as const };
    const checksOnly = item({ number: 5, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, confirmations: [{ n: 1, text: "見る" }] as never, autoHeld });
    const claimed = item({ number: 6, stage: "ready", claim: { taskId: null } as never, autoHeld });
    for (const i of [checksOnly, claimed]) expect(leftLines(null, [i], "implement").filter((l) => new RegExp(`#${i.number}(?!\\d)`).test(l))).toHaveLength(1);
  });
});

// the gate line for a held item the first read did not name, and the lines said again after a start leave it to that line
function insertHeld(id: string, n: number, action: "complete" | "to-pbi" | "direct", ago = 2000, status: "done" | "idle" = "done", workspaceId = metaId()) {
  const at = Date.now() - ago; // nothing the gate counts happened since
  core!.db.insertTask({ id, workspaceId, title: `#${n} ${action}: x`, runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: n, action, auto: true }, statusAt: at + 500, createdAt: at, updatedAt: at + 500 });
}
const namingOf = (log: string[], n: number) => log.filter((l) => new RegExp(`#${n}(?!\\d)`).test(l));

/** fakeGh plus a large request numbered 320 (its criteria choose PBI にする). */
function largeRequestGh(): GhRunner {
  const fake = fakeGh();
  return async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout);
    const nodes = page.data?.repository?.issues?.nodes;
    const small = nodes?.find((n: { number: number }) => n.number === 302);
    if (!small) return r;
    nodes.push({ ...structuredClone(small), number: 320, body: `${small.body}\n${"長い要望。".repeat(300)}`, createdAt: "2026-09-20T03:00:00Z" });
    return { ...r, stdout: JSON.stringify(page) };
  };
}

test("a request the gate holds for PBI にする is named on the gate line", async () => {
  const base = await boot(largeRequestGh(), holdingClaude().adapter);
  insertHeld("tsk_prev320", 320, "to-pbi");
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 320).map((t) => t.id)).toEqual(["tsk_prev320"]); // held
  expect(namingOf(await scheduleLogAll(base), 320)).toEqual([expect.stringContaining("前回の開始から出来事が増えていない: #320（前回 tsk_prev320）")]);
});

describe("a gate-held item another line comes to name after a start is said once", () => {
  test("overlap with the PBI this firing starts", async () => {
    const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/a.ts" }), holdingClaude().adapter);
    closeTried();
    insertHeld("tsk_prev310", 310, "complete");
    const id = await backlogNextSchedule(base);
    expect((await sweepAll(base, { implement: 3, plan: 0 })).status).toBe(200);
    await runSchedule(base, id);
    expect(startedTasks().some((t) => t.stage?.issue === 304)).toBe(true);
    expect(namingOf(await scheduleLogAll(base), 310)).toEqual([expect.stringContaining("#310")]);
  });

  test("the flow limit reached by the PBI this firing starts", async () => {
    const inner = moreReadyGh(309, 310);
    const gh: GhRunner = async (args, cwd) => {
      const r = await inner(args, cwd);
      if (!r.stdout.includes('"subIssuesSummary"')) return r;
      const page = JSON.parse(r.stdout);
      for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304 || node.number === 309) node.labels.nodes.push({ name: "flow-improvement" });
      return { ...r, stdout: JSON.stringify(page) };
    };
    const base = await boot(gh, holdingClaude().adapter);
    closeTried();
    insertHeld("tsk_prev309", 309, "complete");
    const id = await backlogNextSchedule(base);
    expect((await sweepAll(base, { implement: 3, plan: 0 })).status).toBe(200);
    await runSchedule(base, id);
    expect(startedTasks().some((t) => t.stage?.issue === 304)).toBe(true);
    expect(namingOf(await scheduleLogAll(base), 309)).toEqual([expect.stringContaining("#309")]);
  });
});

test("a request held for both ways, picked for the second one, is on one gate line", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  insertHeld("tsk_topbi302", 302, "to-pbi", 20_000);
  insertHeld("tsk_direct302", 302, "direct", 2000, "idle"); // queued at the limit, its start cancelled
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 302).map((t) => t.id).sort()).toEqual(["tsk_direct302", "tsk_topbi302"]);
  expect(namingOf(await scheduleLogAll(base), 302)).toEqual([expect.stringContaining(`${GATE_LINE}: #302（前回 `)]);
});

test("two workspaces of the same name each name their own held request", async () => {
  const { base, ids, dirs } = await threeWorkspaces(holdingClaude().adapter);
  core!.db.upsertWorkspace({ path: dirs.lib!, name: "app", kind: "repo" }); // a name is not unique, only the path is
  insertHeld("tsk_a302", 302, "to-pbi", 2000, "done", ids.app!);
  insertHeld("tsk_b302", 302, "to-pbi", 2000, "done", ids.lib!);
  const id = await backlogNextSchedule(base);
  expect((await sweepAll(base, { implement: 0, plan: 3 })).status).toBe(200);
  await runSchedule(base, id);
  expect(startedTasks().filter((t) => t.stage?.issue === 302 && (t.workspaceId === ids.app || t.workspaceId === ids.lib)).map((t) => t.id).sort()).toEqual(["tsk_a302", "tsk_b302"]);
  const naming = (await scheduleLogAll(base)).filter((l) => /#302（前回 tsk_[ab]302）/.test(l));
  // each line begins with its own time, so the order of the two is not compared
  expect(naming).toHaveLength(2);
  expect(naming).toEqual(expect.arrayContaining([expect.stringContaining("#302（前回 tsk_a302）"), expect.stringContaining("#302（前回 tsk_b302）")]));
});
