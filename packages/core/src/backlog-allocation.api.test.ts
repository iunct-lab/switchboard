// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { BacklogItem } from "@switchboard/protocol";
import { FLOW_LIMIT_FIELD } from "@switchboard/protocol";
import { type CoreServer } from "./server.ts";
import { pickNext, allocationHeldLines, flowShareHeldIn, flowCounted, flowHeldIn, flowHeldLine, flowLimitOf, flowOutsideQueueLine, flowRunning, flowStopped } from "./backlog-pick.ts";
import { requestFromOf } from "./backlog-item.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { backlogNextSchedule, boot, closeTried, fakeGh, holdingClaude, item, moreReadyGh, runSchedule, scheduleLogAll, shutdown, start, startedTasks, threeWorkspaces, useBacklogDaemon, wait } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("allocation: a share and a mode are saved per workspace and read back; the sum over 1, a range outside 0〜1 and an unknown mode are 400; null unsets", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter);
  const patch = (id: string, allocation: unknown) => fetch(`${base}/api/workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allocation }) });
  const list = async () => (await (await fetch(`${base}/api/workspaces`)).json()) as Array<{ id: string; allocation: { share: number | null; mode: string } }>;
  // a new workspace has no share and continues
  expect((await list()).every((w) => w.allocation.share === null && w.allocation.mode === "continuing")).toBe(true);
  expect((await patch(ids.lib!, { share: 0.5, mode: "maintenance" })).status).toBe(200);
  expect((await list()).find((w) => w.id === ids.lib!)!.allocation).toEqual({ share: 0.5, mode: "maintenance" });
  // a side not given stays
  expect((await patch(ids.lib!, { mode: "new" })).status).toBe(200);
  expect((await list()).find((w) => w.id === ids.lib!)!.allocation).toEqual({ share: 0.5, mode: "new" });
  // 0.5 + 0.6 is over 1, and nothing is saved
  const over = await patch(ids.app!, { share: 0.6 });
  expect(over.status).toBe(400);
  expect(((await over.json()) as { error: string }).error).toContain("取り分の和が 1 を超える: 1.1");
  expect((await list()).find((w) => w.id === ids.app!)!.allocation.share).toBeNull();
  expect((await patch(ids.app!, { share: 0.5 })).status).toBe(200);
  // changing the same workspace's share counts its new value, not the old one
  expect((await patch(ids.lib!, { share: 0.3 })).status).toBe(200);
  for (const bad of [{ share: 1.2 }, { share: -0.1 }, { mode: "sleeping" }, { share: "half" }, { extra: 1 }]) expect((await patch(ids.app!, bad)).status).toBe(400);
  expect((await list()).find((w) => w.id === ids.app!)!.allocation).toEqual({ share: 0.5, mode: "continuing" });
  // null returns it to unset
  expect((await patch(ids.app!, { share: null })).status).toBe(200);
  expect((await list()).find((w) => w.id === ids.app!)!.allocation.share).toBeNull();
  // on its own, like sweep
  expect((await fetch(`${base}/api/workspaces/${ids.app!}`, { method: "PATCH", body: JSON.stringify({ allocation: { share: 0.1 }, sweep: { plan: 1 } }) })).status).toBe(400);
  expect((await list()).find((w) => w.id === ids.app!)!.allocation.share).toBeNull();
});

test("allocation API: GET /api/backlog/allocation returns each workspace's actual part of the window's spend (billed included) and the flow-improvement part", async () => {
  // Issue 304 carries flow-improvement in every workspace's copy of the fake repository
  const inner = fakeGh().gh;
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, undefined, gh);
  const get = async () => (await (await fetch(`${base}/api/backlog/allocation`)).json()) as { windowStart: number; workspaces: Array<{ workspaceId: string; share: number | null; mode: string; actual: number; shortfall: number | null }>; flow: { limit: number; actual: number } };
  // nothing spent: every actual is 0
  const idle = await get();
  expect(idle.workspaces.map((w) => w.actual)).toEqual(idle.workspaces.map(() => 0));
  expect(idle.flow).toEqual({ limit: 0.25, actual: 0 });
  const patch = (id: string, allocation: unknown) => fetch(`${base}/api/workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allocation }) });
  expect((await patch(ids.lib!, { share: 0.5 })).status).toBe(200);
  expect((await patch(ids.app!, { share: 0.2 })).status).toBe(200);
  for (const ws of Object.values(ids)) await fetch(`${base}/api/backlog/sync`, { method: "POST", body: JSON.stringify({ workspaceId: ws }) });
  const now = Date.now();
  const spend = (id: string, workspaceId: string, issue: number | null, costUsd: number, billedUsd: number, ts = now) => {
    core!.db.insertTask({ id, workspaceId, title: id, runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: issue === null ? null : { issue, action: "complete" }, statusAt: now, createdAt: now, updatedAt: now });
    core!.db.insertLedger({ taskId: id, runner: "claude", model: null, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd, source: "reported", ts });
  };
  spend("tsk_alloc_lib", ids.lib!, 304, 20, 0); // a flow Issue of lib
  spend("tsk_alloc_app", ids.app!, 305, 0, 60); // billed only
  spend("tsk_alloc_meta", ids.switchboard!, null, 20, 0);
  spend("tsk_alloc_old", ids.lib!, 304, 500, 0, now - 30 * 86400_000); // outside the window
  const r = await get();
  const by = Object.fromEntries(r.workspaces.map((w) => [w.workspaceId, w]));
  expect(by[ids.lib!]!.actual).toBeCloseTo(0.2);
  expect(by[ids.lib!]!.shortfall).toBeCloseTo(0.3);
  expect(by[ids.app!]!.actual).toBeCloseTo(0.6);
  expect(by[ids.app!]!.shortfall).toBeCloseTo(-0.4);
  expect(by[ids.switchboard!]).toMatchObject({ share: null, shortfall: null });
  expect(by[ids.switchboard!]!.actual).toBeCloseTo(0.2);
  expect(r.flow.actual).toBeCloseTo(0.2);
  expect(now - r.windowStart).toBeGreaterThanOrEqual(0);
  expect(now - r.windowStart).toBeLessThanOrEqual(7 * 86400_000 + 1000);
});

test("flowShareLimit: the default is 0.25 and PATCH /api/settings changes it", async () => {
  const base = await boot(fakeGh().gh);
  const get = async () => ((await (await fetch(`${base}/api/settings`)).json()) as { quotaAndResume: { flowShareLimit: number } }).quotaAndResume.flowShareLimit;
  expect(await get()).toBe(0.25);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ quotaAndResume: { flowShareLimit: 0.4 } }) })).status).toBe(200);
  expect(await get()).toBe(0.4);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ quotaAndResume: { flowShareLimit: 1.5 } }) })).status).toBe(400);
  expect(await get()).toBe(0.4);
});

describe("flow-improvement limit", () => {
  const flowItem = (over: Partial<BacklogItem>) => item({ flow: true, ...over });
  const working = flowItem({ number: 1, stage: "in-progress", projectStatus: "In progress", activeTaskId: "t1", tasks: { total: 3, done: 1, doneAt: null } });
  const limit = (n: number, items: BacklogItem[]) => flowLimitOf(n, flowCounted(items).map((i) => i.number), flowStopped(items));

  test("flow: with one flow PBI in progress, the next flow Ready is left and the one without the label is taken", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const plain = item({ number: 3, priority: "P3" });
    const all = [working, next, plain];
    expect(flowRunning(all)).toBe(1);
    expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 3 } });
    expect(pickNext([working, next], "implement", undefined, limit(1, all))).toBeNull();
    expect(flowHeldIn(all, "implement", limit(1, all)).map((i) => i.number)).toEqual([2]);
    expect(pickNext(all, "implement")).toMatchObject({ item: { number: 2 } });
  });

  test("flow: the running count comes from the caller, not from the candidates passed (a queue's few, the picked taken out)", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const plain = item({ number: 3, priority: "P3" });
    // the in-progress one is outside the candidates (not queued, or already picked to resume), yet it counts
    expect(pickNext([next, plain], "implement", undefined, { limit: 1, running: 1 })).toMatchObject({ item: { number: 3 } });
    expect(pickNext([next, plain], "implement", undefined, { limit: 1, running: 0 })).toMatchObject({ item: { number: 2 } });
  });

  test("a checking flow PBI is not counted and a Ready flow PBI starts", () => {
    const checking = flowItem({ number: 1, stage: "in-progress", projectStatus: "In review", tasks: { total: 3, done: 3, doneAt: null }, postMerge: [{ n: 1, text: "昇格後に画面で見る", kind: "画面" as const, after: null }] });
    const next = flowItem({ number: 2, priority: "P1" });
    const all = [checking, next];
    expect(checking.progress.checking).toBe(true);
    expect(flowCounted(all)).toEqual([]);
    expect(flowRunning(all)).toBe(0);
    expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 2 } });
    // an answered one resumes (`pickNext` takes it), so it counts: the firing that resumes it starts no Ready flow PBI past the limit
    const answered = { ...checking, updatedAt: "2026-09-28T01:00:00Z", answeredAt: "2026-09-28T01:00:00Z", lastTask: { id: "tsk_last", status: "done" as const, statusAt: 1, createdAt: 1, updatedAt: 1, action: "complete" as const, outcome: "finished" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true } };
    expect(pickNext([answered], "implement")).toMatchObject({ item: { number: 1 } });
    expect(flowCounted([answered, next]).map((i) => i.number)).toEqual([1]);
    expect(pickNext([next], "implement", undefined, limit(1, [answered, next]))).toBeNull();
    // a stage Task running on it counts again
    const running = { ...checking, activeTaskId: "t9" };
    expect(flowCounted([running]).map((i) => i.number)).toEqual([1]);
    expect(pickNext([running, next], "implement", undefined, limit(1, [running, next]))).toBeNull();
  });

  test("flow: a P0 flow PBI is taken whatever the count", () => {
    const urgent = flowItem({ number: 2, priority: "P0" });
    expect(pickNext([working, urgent], "implement", undefined, limit(1, [working]))).toMatchObject({ item: { number: 2 } });
    expect(flowHeldIn([working, urgent], "implement", limit(1, [working]))).toEqual([]);
  });

  test("flow: the resume or close of an in-progress flow PBI is not held", () => {
    const stalled = flowItem({ number: 1, stage: "in-progress", projectStatus: "In progress", tasks: { total: 3, done: 3, doneAt: null }, closable: true });
    expect(pickNext([stalled], "implement", undefined, { limit: 1, running: 1 })).toMatchObject({ item: { number: 1 }, action: "close" });
    const resumed = flowItem({ number: 4, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } });
    expect(pickNext([resumed], "implement", undefined, { limit: 1, running: 2 })).toEqual({ item: resumed, action: "complete", resume: true });
    expect(flowHeldIn([stalled, resumed], "implement", { limit: 1, running: 2 })).toEqual([]);
  });

  test("flow: with limit 2 the second flow PBI starts", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    expect(pickNext([working, next], "implement", undefined, limit(2, [working]))).toMatchObject({ item: { number: 2 } });
    expect(flowHeldIn([working, next], "implement", limit(2, [working]))).toEqual([]);
  });

  // an in-progress flow PBI backlog-next leaves (a reply, decision or wait it is stuck on) does not use the limit
  const at = "2026-09-28T00:00:00Z";
  const asked = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true };
  const progress = { stage: "in-progress" as const, projectStatus: "In progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: at };

  test("flow: a flow PBI in progress that waits for a reply, a decision or a dependency is not counted, so a Ready flow PBI is taken", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const reply = flowItem({ number: 10, ...progress, lastTask: asked });
    // a stop that ran out of retries on a Task that ended done (no reply waited for): only the stop holds it
    const decided = { ...asked, outcome: "finished" as const };
    const ask: BacklogItem["stopSummary"][number] = {
      key: "k", work: { workspaceId: "ws_meta", issue: 11, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "large", safety: "before-effect",
      count: 1, state: "exhausted", firstAt: 1, lastAt: 2, lastAnswer: null, answered: false, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide",
    };
    const free = flowItem({ number: 11, ...progress, lastTask: decided, updatedAt: "2026-09-29T00:00:00Z" }); // moved since the Task
    expect(flowRunning([free])).toBe(1);
    const decide = { ...free, stopSummary: [ask] };
    const waiting = flowItem({ number: 12, ...progress, waits: [wait(778, "pr", true)] });
    for (const stuck of [reply, decide, waiting]) {
      const all = [stuck, next];
      expect(flowRunning(all)).toBe(0);
      expect(flowStopped(all)).toBe(1);
      expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 2 } });
    }
  });

  test("flow: one with a stage Task running, and one that backlog-next resumes next, are still counted", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    expect(flowRunning([working])).toBe(1);
    expect(flowStopped([working])).toBe(0);
    expect(pickNext([working, next], "implement", undefined, limit(1, [working, next]))).toBeNull();
    // no stop holds it, so it is the next resume: counted
    const stalled = flowItem({ number: 13, ...progress });
    expect(pickNext([stalled], "implement")).toMatchObject({ action: "complete", resume: true });
    expect(flowRunning([stalled])).toBe(1);
    expect(flowStopped([stalled])).toBe(0);
    expect(pickNext([stalled, next], "implement", undefined, limit(1, [stalled, next]))).toMatchObject({ item: { number: 13 } });
    // a closable one is closed next: counted
    expect(flowRunning([flowItem({ number: 14, ...progress, tasks: { total: 3, done: 3, doneAt: null }, closable: true })])).toBe(1);
    // on hold is stopped
    expect(flowStopped([flowItem({ number: 15, ...progress, onHold: true })])).toBe(1);
  });

  const overlapHit = { hits: [{ ref: "Task #9", path: "src/a.ts", working: true }], unknown: null };

  test("an overlapped in-progress flow PBI does not count against flowLimit", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    for (const overlap of [overlapHit, { hits: [], unknown: "no files named" }]) {
      const overlapped = flowItem({ number: 20, ...progress, overlap });
      expect(flowRunning([overlapped])).toBe(0);
      expect(flowStopped([overlapped])).toBe(1);
      const all = [overlapped, next];
      expect(flowRunning(all)).toBe(0);
    }
  });

  test("a Ready flow PBI starts while the in-progress one is overlapped", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const overlapped = flowItem({ number: 20, ...progress, overlap: overlapHit });
    const all = [overlapped, next];
    expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 2 } });
    expect(pickNext(all, "implement", [2, 20], limit(1, all))).toMatchObject({ item: { number: 2 } });
  });

  test("the flow PBI counts again once its overlap clears", () => {
    const next = flowItem({ number: 2, priority: "P1" });
    const cleared = flowItem({ number: 20, ...progress, overlap: null });
    const all = [cleared, next];
    expect(flowRunning(all)).toBe(1);
    expect(flowHeldIn(all, "implement", limit(1, all)).map((i) => i.number)).toEqual([2]);
    expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 20 } });
  });

  test("an overlapped flow PBI with a stage Task running still counts as 1", () => {
    const busy = flowItem({ number: 21, ...progress, activeTaskId: "t9", overlap: overlapHit });
    expect(flowRunning([busy])).toBe(1);
    expect(flowStopped([busy])).toBe(0);
    // a close does not look at the overlap: an overlapped closable one still counts
    const closing = flowItem({ number: 22, ...progress, tasks: { total: 3, done: 3, doneAt: null }, closable: true, overlap: overlapHit });
    expect(flowRunning([closing])).toBe(1);
  });

  describe("with the queue's order", () => {
    const at = "2026-09-30T00:00:00Z";
    const decided = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "finished" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true };
    // in progress, its wait resolved (moved since its last Task): backlog-next would resume it
    const outside = flowItem({ number: 1, stage: "in-progress", projectStatus: "In progress", tasks: { total: 3, done: 1, doneAt: null }, lastTask: decided, updatedAt: "2026-10-01T00:00:00Z" });
    const next = flowItem({ number: 2, priority: "P1" });

    test("flow: a resumable flow PBI outside the queue is not counted, so the queue's Ready flow PBI starts", () => {
      const all = [outside, next];
      expect(flowRunning(all, [2])).toBe(0);
      expect(flowStopped(all, [2])).toBe(1);
      expect(pickNext(all, "implement", [2], { limit: 1, running: flowRunning(all, [2]), stopped: flowStopped(all, [2]) })).toMatchObject({ item: { number: 2 } });
    });

    test("flow: without the queue's order it is counted as before, and the one in the queue is counted too", () => {
      const all = [outside, next];
      expect(flowRunning(all)).toBe(1);
      expect(pickNext(all, "implement", undefined, limit(1, all))).toMatchObject({ item: { number: 1 } });
      expect(flowRunning(all, [1, 2])).toBe(1);
      expect(flowRunning([{ ...outside, activeTaskId: "t9" }, next], [2])).toBe(1);
    });

    test("flowOutsideQueueLine: names the in-progress flow PBIs outside the queue; not the queued ones or those with a Task running", () => {
      const running = flowItem({ number: 3, stage: "in-progress", projectStatus: "In progress", activeTaskId: "t3" });
      const queued = flowItem({ number: 4, stage: "in-progress", projectStatus: "In progress" });
      const plain = item({ number: 5, stage: "in-progress", projectStatus: "In progress" });
      expect(flowOutsideQueueLine([outside, running, queued, plain, next], [2, 4])).toBe("キューに無い実装中: #1（再開されない。順に足すかは利用者が決める）");
      expect(flowOutsideQueueLine([running, queued, plain, next], [2, 4])).toBeNull();
    });
  });

  test("flowHeldLine: says how many in-progress flow PBIs were left out of the count", () => {
    const a = flowItem({ number: 4077, priority: "P1" });
    const stuck = flowItem({ number: 10, ...progress, lastTask: asked });
    const all = [working, stuck, a];
    expect(flowRunning(all)).toBe(1);
    expect(flowHeldLine(flowHeldIn(all, "implement", limit(1, all)), limit(1, all))).toBe("開発の流れの PBI は同時 1 件まで（Settings の「開発の流れの同時の上限」。実装中 1 件: #1、止まっていて数に入れない 1 件）: 待ち #4077");
  });

  test("flowHeldLine: names the held PBIs with the limit and the running count; null when none", () => {
    const a = flowItem({ number: 4077, priority: "P1" });
    const b = flowItem({ number: 4078, priority: "P2" });
    expect(flowHeldLine(flowHeldIn([working, a, b], "implement", limit(1, [working])), limit(1, [working]))).toBe("開発の流れの PBI は同時 1 件まで（Settings の「開発の流れの同時の上限」。実装中 1 件: #1）: 待ち #4077 #4078");
    expect(flowHeldLine(flowHeldIn([a], "implement", limit(1, [a])), limit(1, [a]))).toBeNull();
    const second = flowItem({ number: 5, stage: "in-progress", projectStatus: "In progress", activeTaskId: "t2" });
    const all = [working, second, a];
    expect(flowHeldLine(flowHeldIn(all, "implement", limit(2, all)), limit(2, all))).toBe("開発の流れの PBI は同時 2 件まで（Settings の「開発の流れの同時の上限」。実装中 2 件: #1 #5）: 待ち #4077");
  });

  test("flowHeldLine: names the counted PBIs and the Settings field", () => {
    const a = flowItem({ number: 4077, priority: "P1" });
    const line = flowHeldLine([a], flowLimitOf(1, [7, 9], 0))!;
    // the field's name is the screen's label: one constant for both
    expect(line).toContain(`Settings の「${FLOW_LIMIT_FIELD}」`);
    expect(line).toContain("実装中 2 件: #7 #9）");
    // a limit of 0 holds with nothing counted: no numbers, the field still named
    expect(flowHeldLine([a], flowLimitOf(0, [], 0))).toBe(`開発の流れの PBI は同時 0 件まで（Settings の「${FLOW_LIMIT_FIELD}」。実装中 0 件）: 待ち #4077`);
    // flowCounted is what flowRunning counts
    expect(flowCounted([working, a]).map((i) => i.number)).toEqual([1]);
    expect(flowRunning([working, a])).toBe(1);
  });
});

describe("pickNext allocation", () => {
  const over = { flowShare: { actual: 0.4, limit: 0.25 } };
  const flowItem = (over: Partial<BacklogItem>) => item({ flow: true, ...over });

  test("pickNext allocation: over the flow-share limit, a flow Ready (not P0) is left, P0 and plain PBIs are taken, and the lines say why", () => {
    const held = flowItem({ number: 1, priority: "P1" });
    const urgent = flowItem({ number: 2, priority: "P0", createdAt: "2026-09-02T00:00:00Z" });
    const plain = item({ number: 3, priority: "P3" });
    expect(pickNext([held, plain], "implement", undefined, undefined, [], new Set(), over)).toMatchObject({ item: { number: 3 } });
    expect(pickNext([held, urgent, plain], "implement", undefined, undefined, [], new Set(), over)).toMatchObject({ item: { number: 2 } });
    expect(pickNext([held], "implement", undefined, undefined, [], new Set(), over)).toBeNull();
    expect(allocationHeldLines([held, urgent, plain], "implement", over)).toEqual(["飛ばした: #1: 自己改善の上限（実績 40% / 上限 25%）"]);
    // under the limit, or with no hold, nothing is left
    expect(pickNext([held], "implement", undefined, undefined, [], new Set(), { flowShare: { actual: 0.1, limit: 0.25 } })).toMatchObject({ item: { number: 1 } });
    expect(pickNext([held], "implement")).toMatchObject({ item: { number: 1 } });
    // an in-progress flow PBI goes on (its resume is not a new start)
    const going = flowItem({ number: 4, stage: "in-progress", projectStatus: "In progress", tasks: { total: 3, done: 1, doneAt: null }, updatedAt: "2026-09-05T00:00:00Z" });
    expect(flowShareHeldIn([going], "implement", over)).toEqual([]);
  });

  test("pickNext allocation: in maintenance mode a feature PBI is left, bug / deps PBIs and a routine-check request are taken, and the lines say why", () => {
    const hold = { mode: "maintenance" as const };
    const feature = item({ number: 1, kind: "feature", priority: "P0" });
    const unset = item({ number: 5, kind: null });
    const bug = item({ number: 2, kind: "bug", priority: "P2" });
    const deps = item({ number: 3, kind: "deps", priority: "P3" });
    const routine = item({ number: 4, type: "request", stage: "request", requestFrom: "定期の検査" });
    const person = item({ number: 6, type: "request", stage: "request", requestFrom: "利用者" });
    expect(pickNext([feature, unset, bug, deps], "implement", undefined, undefined, [], new Set(), hold)).toMatchObject({ item: { number: 2 } });
    expect(pickNext([feature, deps], "implement", undefined, undefined, [], new Set(), hold)).toMatchObject({ item: { number: 3 } });
    expect(pickNext([feature, person, routine], "plan", undefined, undefined, [], new Set(), hold)).toMatchObject({ item: { number: 4 } });
    expect(pickNext([person], "plan", undefined, undefined, [], new Set(), hold)).toBeNull();
    expect(allocationHeldLines([feature, unset, bug], "implement", hold)).toEqual(["飛ばした: #1: メンテのモード（Kind feature）", "飛ばした: #5: メンテのモード（Kind 未設定）"]);
    // the other modes pick as before
    for (const mode of ["new", "continuing"] as const) expect(pickNext([feature, bug], "implement", undefined, undefined, [], new Set(), { mode })).toMatchObject({ item: { number: 1 } });
  });

  test("pickNext allocation: requestFromOf reads the 出典 line outside fences", () => {
    expect(requestFromOf("## 要望\nx\n\n## 出典\n- 誰の言葉: 定期の検査（使い捨てアプリから）\n自動")).toBe("定期の検査");
    expect(requestFromOf("## 出典\n- 誰の言葉: 利用者\n")).toBe("利用者");
    expect(requestFromOf("## 出典\n```\n- 誰の言葉: 利用者\n```\n")).toBeNull();
    expect(requestFromOf("## 要望\n```\n## 出典\n- 誰の言葉: 利用者\n```\n")).toBeNull();
    expect(requestFromOf("## 出典\n- 誰の言葉: 誰か\n")).toBeNull();
  });
});

/** A done Task of a workspace that spent `costUsd` in the current window. */
const spendIn = (id: string, workspaceId: string, costUsd: number) => {
  core!.db.insertTask({ id, workspaceId, title: id, runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
  core!.db.insertLedger({ taskId: id, runner: "claude", model: null, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: 0, source: "reported", ts: Date.now() });
};

/** The Tasks a firing started: not the ones that only carry spend. */
const firedTasks = () => startedTasks().filter((t) => !t.id.startsWith("tsk_alloc"));

const shareOf = (base: string, id: string, share: number | null) => fetch(`${base}/api/workspaces/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ allocation: { share } }) });

test("backlog-next allocation: a workspace over its share is skipped (and logged) while another can start, and starts when nothing else can", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter);
  closeTried(...Object.values(ids));
  expect((await shareOf(base, ids.app!, 0.2)).status).toBe(200);
  expect((await shareOf(base, ids.lib!, 0.5)).status).toBe(200);
  spendIn("tsk_alloc_app", ids.app!, 60);
  spendIn("tsk_alloc_lib", ids.lib!, 20);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  // lib (under its share) and switchboard (no share) start; app is over its share and other work started
  expect([...new Set(firedTasks().map((t) => t.workspaceId))].sort()).toEqual([ids.lib!, ids.switchboard!].sort());
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("飛ばした: app: 取り分 20% に対し実績 75%"));
  await shutdown();
  // the same, with nothing else to start: the workspace over its share is swept
  const again = await threeWorkspaces(holdingClaude().adapter);
  closeTried(...Object.values(again.ids));
  expect((await shareOf(again.base, again.ids.app!, 0.2)).status).toBe(200);
  spendIn("tsk_alloc_app2", again.ids.app!, 60);
  for (const w of ["lib", "switchboard"]) await fetch(`${again.base}/api/workspaces/${again.ids[w]!}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep: { implement: 0, plan: 0 } }) });
  expect((await runSchedule(again.base, await backlogNextSchedule(again.base))).status).toBe(201);
  expect([...new Set(firedTasks().map((t) => t.workspaceId))]).toEqual([again.ids.app!]);
});

test("backlog-next allocation: a workspace skipped for its share still gets its anomaly line, and the share is the reason only when it had work to start", async () => {
  // app is over its share and its directory is gone: the firing that starts elsewhere still says so, and not the share
  const { base, ids, dirs } = await threeWorkspaces(holdingClaude().adapter);
  closeTried(...Object.values(ids));
  expect((await shareOf(base, ids.app!, 0.2)).status).toBe(200);
  expect((await shareOf(base, ids.lib!, 0.5)).status).toBe(200);
  spendIn("tsk_alloc_app", ids.app!, 60);
  spendIn("tsk_alloc_lib", ids.lib!, 20);
  rmSync(dirs.app!, { recursive: true, force: true });
  expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  expect(firedTasks().map((t) => t.workspaceId)).not.toContain(ids.app!);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining("app: workspace directory does not exist"));
  expect(log.some((l) => l.includes("飛ばした: app: 取り分"))).toBe(false);
  await shutdown();
  // app is over its share with no slot of its own to fill: nothing there was held back by the share
  const idle = await threeWorkspaces(holdingClaude().adapter);
  closeTried(...Object.values(idle.ids));
  expect((await shareOf(idle.base, idle.ids.app!, 0.2)).status).toBe(200);
  expect((await shareOf(idle.base, idle.ids.lib!, 0.5)).status).toBe(200);
  spendIn("tsk_alloc_app3", idle.ids.app!, 60);
  spendIn("tsk_alloc_lib3", idle.ids.lib!, 20);
  expect((await fetch(`${idle.base}/api/workspaces/${idle.ids.app!}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep: { implement: 0, plan: 0 } }) })).status).toBe(200);
  expect((await runSchedule(idle.base, await backlogNextSchedule(idle.base))).status).toBe(201);
  expect(firedTasks().map((t) => t.workspaceId)).not.toContain(idle.ids.app!);
  expect((await scheduleLogAll(idle.base)).some((l) => l.includes("飛ばした: app: 取り分"))).toBe(false);
});

test("allocation API flow limit: the PBIs counted against the limit and the Ready ones it holds, per workspace", async () => {
  // Issue 307 (In progress), Issue 304 and its copy Issue 309 (Ready) carry flow-improvement
  const inner = moreReadyGh(309);
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if ([304, 307, 309].includes(node.number)) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const base = await boot(gh, holdingClaude().adapter);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
  const get = async () => ((await (await fetch(`${base}/api/backlog/allocation`)).json()) as { flowLimit: { limit: number; workspaces: Array<{ workspaceId: string; counted: number[]; held: number[] }> } }).flowLimit;
  // a stage Task runs on the one in progress: it is counted, and with the limit of 1 the two Ready ones wait
  expect((await start(base, 307, { action: "complete" })).status).toBe(201);
  expect(await get()).toEqual({ limit: 1, workspaces: [{ workspaceId: meta, counted: [307], held: [304, 309] }] });
  // a higher limit holds none; the counted one stays
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ quotaAndResume: { flowLimit: 2 } }) })).status).toBe(200);
  expect(await get()).toEqual({ limit: 2, workspaces: [{ workspaceId: meta, counted: [307], held: [] }] });
});

test("flow share button: over the flow-share limit a firing skips a flow Ready and says why, while the button still starts it (201)", async () => {
  const inner = fakeGh().gh;
  const gh: GhRunner = async (args, cwd) => {
    const r = await inner(args, cwd);
    if (!r.stdout.includes('"subIssuesSummary"')) return r;
    const page = JSON.parse(r.stdout) as { data?: { repository?: { issues?: { nodes: { number: number; labels: { nodes: { name: string }[] } }[] } } } };
    for (const node of page.data?.repository?.issues?.nodes ?? []) if (node.number === 304) node.labels.nodes.push({ name: "flow-improvement" });
    return { ...r, stdout: JSON.stringify(page) };
  };
  const base = await boot(gh, holdingClaude().adapter);
  closeTried();
  // a limit of 0 is reached with nothing spent
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ quotaAndResume: { flowShareLimit: 0 } }) })).status).toBe(200);
  expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("飛ばした: #304: 自己改善の上限（実績 0% / 上限 0%）"));
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
});

test("backlog-next allocation: when every workspace is over its share something still starts (no slot is left idle)", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter);
  closeTried(...Object.values(ids));
  for (const w of Object.keys(ids)) {
    expect((await shareOf(base, ids[w]!, 0.1)).status).toBe(200);
    spendIn(`tsk_alloc_${w}`, ids[w]!, 30);
  }
  expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  expect(new Set(firedTasks().map((t) => t.workspaceId)).size).toBe(3);
});
