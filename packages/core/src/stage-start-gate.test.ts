// test-reads: packages/core/fixtures/
import { describe, expect, test } from "bun:test";
import type { Ask, AskAnswerResult, Backlog, BacklogEvent, BacklogItem, Task } from "@switchboard/protocol";
import type { BacklogSnapshotEntry } from "./db.ts";
import { backlogNextSchedule, boot, commentingGh, fakeGh, getQueue, holdingClaude, item, metaId, metaName, putQueue, refreshed, runSchedule, scheduleLogAll, start, until, useBacklogDaemon } from "./api-test-harness.ts";
import type { CoreServer } from "./server.ts";
import { flowCounted, pickNext } from "./backlog-pick.ts";
import { autoStartHeld, eventsOf, type EventsInput } from "./stage-start-gate.ts";

/* The rule for a stage Task that starts by itself: the same Issue's same stage starts again only when an event came since the last automatic start. */

const state = { core: undefined as CoreServer | undefined, home: undefined as string | undefined, openPulls: [] as Array<Record<string, unknown>> };
useBacklogDaemon(state);

const PREV = { id: "tsk_prev", createdAt: 1_000, endedAt: 2_000 };
const KINDS = ["sub-added", "sub-closed", "pr", "answer", "reviewed", "wait-closed", "release", "after"];

describe("autoStartHeld", () => {
  test("without a previous automatic start nothing is held, with or without events", () => {
    expect(autoStartHeld([], null)).toBeNull();
    expect(autoStartHeld([{ key: "pr:1", at: 5 }], null)).toBeNull();
  });

  test("no event, or only older ones: held for the previous Task", () => {
    expect(autoStartHeld([], PREV)).toEqual({ previousTaskId: "tsk_prev" });
    expect(autoStartHeld([{ key: "sub-closed:7", at: 999 }], PREV)).toEqual({ previousTaskId: "tsk_prev" });
  });

  test("an event at the very time of the previous start is not counted; one after it is, whatever its kind", () => {
    for (const kind of KINDS.filter((k) => k !== "after")) {
      expect([kind, autoStartHeld([{ key: `${kind}:1`, at: PREV.createdAt }], PREV)]).toEqual([kind, { previousTaskId: "tsk_prev" }]);
      expect([kind, autoStartHeld([{ key: `${kind}:1`, at: PREV.createdAt + 1 }], PREV)]).toEqual([kind, null]);
    }
  });

  test("a due date counts only when it is later than the end of the previous Task, not merely later than its start", () => {
    expect(autoStartHeld([{ key: "after:2026-11-21", at: 1_500 }], PREV)).toEqual({ previousTaskId: "tsk_prev" });
    expect(autoStartHeld([{ key: "after:2026-11-21", at: 2_000 }], PREV)).toEqual({ previousTaskId: "tsk_prev" });
    expect(autoStartHeld([{ key: "after:2026-11-21", at: 2_001 }], PREV)).toBeNull();
    // a previous Task that has not ended yet has no later due date
    expect(autoStartHeld([{ key: "after:x", at: 9_999_999 }], { ...PREV, endedAt: null })).toEqual({ previousTaskId: "tsk_prev" });
  });

  test("one event of many that is later is enough", () => {
    expect(autoStartHeld([{ key: "pr:1", at: 10 }, { key: "answer", at: 1_001 }], PREV)).toBeNull();
  });

});

describe("startStage with auto", () => {
  const withEvents = (n: number, events: BacklogEvent[]): BacklogItem => ({ ...item({ number: n }), events });
  const bootStart = async () => {
    const base = await boot(fakeGh().gh, holdingClaude().adapter);
    const core = state.core!;
    const ws = core.db.listWorkspaces().find((w) => w.id === metaId())!;
    const finish = (t: Task) => core.db.sqlite.run("UPDATE tasks SET status = 'done', status_at = ? WHERE id = ?", [t.createdAt + 1, t.id]);
    const start = (i: BacklogItem, auto = true) => (auto ? core.startStage({ ws, meta: ws, item: i, action: "complete", auto: true }) : core.startStage({ ws, meta: ws, item: i, action: "complete" }));
    return { base, core, ws, finish, start };
  };
  const started = (r: unknown): Task => {
    expect(r).toHaveProperty("task");
    return (r as { task: Task }).task;
  };

  test("each event allows exactly one start", async () => {
    const { finish, start } = await bootStart();
    let n = 400;
    for (const kind of KINDS) {
      n++;
      // the first automatic start has no previous one
      const first = started(await start(withEvents(n, [])));
      expect(first.stage).toEqual({ issue: n, action: "complete", auto: true });
      finish(first);
      // nothing since: held for that Task
      expect([kind, await start(withEvents(n, []))]).toEqual([kind, { held: { previousTaskId: first.id } }]);
      // an event after it: one start, then held again for the new one
      await Bun.sleep(3);
      const at = first.createdAt + 2; // after the first start, and no later than the second's, whose own start the same event cannot lift
      const second = started(await start(withEvents(n, [{ key: `${kind}:1`, at }])));
      finish(second);
      expect([kind, await start(withEvents(n, [{ key: `${kind}:1`, at }]))]).toEqual([kind, { held: { previousTaskId: second.id } }]);
    }
  });

  /* The items below are read as the daemon reads them (the stored records, `eventsOf`, the Task rows) and started the way the queue starts them; only the runner and GitHub are fake. */
  const iso = (ms: number) => new Date(ms).toISOString();
  const issueRec = (n: number, over: Record<string, unknown> = {}): BacklogSnapshotEntry => ({
    objectKind: "issue", externalId: `I_gate${n}`, fetchState: "fetched",
    remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels: ["type:task"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null, ...over },
  });
  const commentRec = (n: number, id: string, body: string, createdAt: string): BacklogSnapshotEntry => ({ objectKind: "comment", externalId: id, remote: { issue: n, body, createdAt }, fetchState: "fetched" });
  const pullRec = (n: number, closes: number[]): BacklogSnapshotEntry => ({ objectKind: "pull-request", externalId: `PR_gate${n}`, fetchState: "fetched", remote: { number: n, state: "MERGED", isDraft: false, labels: [], closes, mergeCommit: "a".repeat(40), updatedAt: "2026-10-06T00:00:00Z", files: null, closedAt: "2026-10-05T00:00:00Z", mergedAt: "2026-10-05T00:00:00Z", head: null } });
  const world = async () => {
    const h = await bootStart();
    const source = h.core.db.getWorkspaceBacklogSource(h.ws.id)!;
    const status = (n: number): BacklogSnapshotEntry => ({ objectKind: "project-item", externalId: `PVTI_gate${n}`, fetchState: "fetched", remote: { issue: n, owner: source.project.owner, project: source.project.number, fields: { Status: "Ready" } } });
    const put = (...records: BacklogSnapshotEntry[]) => h.core.db.putBacklogSnapshot(source, { records, cursor: h.core.db.getBacklogRepository(source)!.cursor, syncedAt: Date.now() });
    const read = async (n: number) => ((await (await fetch(`${h.base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === n)!;
    const finishNow = (t: Task) => h.core.db.sqlite.run("UPDATE tasks SET status = 'done', status_at = ? WHERE id = ?", [Date.now(), t.id]);
    const tasksOf = (n: number) => h.core.db.listTasks().filter((t) => t.stage?.issue === n);
    return { ...h, put, status, read, finishNow, tasksOf };
  };

  test("nothing a stage Task writes lets it start again: its comments, 状況, claim, release (a wait on a closed one, a date it names, a merged PR), body and labels, on the item as the daemon reads it", async () => {
    const h = await world();
    const { start, put, status, read, finishNow, tasksOf } = h;
    put(
      status(9201), issueRec(9201, { labels: ["type:pbi"], subIssues: [9202, 9203] }), issueRec(9202, { parent: 9201 }), issueRec(9203, { parent: 9201, state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-10-03T00:00:00Z" }),
      issueRec(9210, { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-10-05T00:00:00Z" }), pullRec(9211, []),
      issueRec(9213, { labels: ["type:pbi"], subIssues: [9212] }), issueRec(9212, { parent: 9213 }),
      // a question answered where no comment shows it (in a Task's conversation): a ## 回答 the Task writes later is no answer to it
      commentRec(9201, "C0", "## 判断待ち\n**問い**: Q", "2026-10-01T00:00:00Z"),
    );
    const first = started(await start(await read(9201)));
    await Bun.sleep(5);
    finishNow(first);
    await Bun.sleep(5);
    const held = { held: { previousTaskId: first.id } };
    expect(await start(await read(9201))).toEqual(held);
    // what the Task writes while it runs, one more at each step (the times are the moment it is written); it ends after the last write
    h.core.db.sqlite.run("UPDATE tasks SET status = 'running' WHERE id = ?", [first.id]);
    const writes: Array<[string, () => BacklogSnapshotEntry[]]> = [
      ["a plain comment", () => [commentRec(9201, "C1", "着手のコメント", iso(Date.now()))]],
      ["a claim", () => [commentRec(9201, "C2", "<!-- pbi-complete:claim 00000000-0000-4000-8000-000000000001 -->\n開始", iso(Date.now()))]],
      ["a 状況", () => [commentRec(9201, "C3", "## 状況\n全部終えた", iso(Date.now()))]],
      ["a ## 回答 recording a confirmation it counted", () => [commentRec(9201, "C6", "## 回答\n受け入れ条件 1「x」は、判断待ち #9202 への回答を確認として数えました。", iso(Date.now()))]],
      ["the body and a label", () => [issueRec(9201, { labels: ["type:pbi", "flow-improvement"], subIssues: [9202, 9203], body: "決定ログを足した", updatedAt: iso(Date.now()) })]],
      // an overlap wait on what already closed, on a Task of a PBI nobody works on (met at once), and a date it names that is already past
      ["a release naming a closed Issue, an idle Task and a date", () => [commentRec(9201, "C4", `<!-- pbi-complete:release overlap=9210,9212 after=${iso(Date.now() - 1)} -->\n後回し`, iso(Date.now()))]],
      ["a release naming a merged PR", () => [commentRec(9201, "C5", "<!-- pbi-complete:release waits=9211 -->\n待つ", iso(Date.now()))]],
    ];
    for (const [what, make] of writes) {
      await Bun.sleep(3);
      put(...make());
      await Bun.sleep(3);
      finishNow(first);
      await Bun.sleep(3);
      expect([what, await start(await read(9201))]).toEqual([what, held]);
      if (what.startsWith("a release naming a closed")) {
        // the closed Issue it names counts at the time it closed, not when it was named; the idle Task (not closed) and the date it wrote are not later than the Task's own end
        const events = Object.fromEntries((await read(9201)).events.map((e) => [e.key, e.at]));
        expect(events["wait-closed:issue#9210"]).toBe(Date.parse("2026-10-05T00:00:00Z"));
        expect(Object.keys(events).filter((k) => k.includes("9212"))).toEqual([]);
        expect(Object.keys(events).some((k) => k.startsWith("after:"))).toBe(true);
      }
    }
    // the world did not change: the list has what it had (the Tasks closed and added, then the closed ones the waits name at the time they closed)
    const item = await read(9201);
    expect(item.events.map((e) => e.key).sort()).toEqual(["sub-added:#9202", "sub-added:#9203", "sub-closed:#9203", "wait-closed:pr#9211"]);
    expect(item.events.find((e) => e.key === "wait-closed:pr#9211")!.at).toBe(Date.parse("2026-10-05T00:00:00Z"));
    expect(tasksOf(9201)).toHaveLength(1);
    // a thing that did happen still lets exactly one start
    put(issueRec(9202, { parent: 9201, state: "CLOSED", stateReason: "COMPLETED", closedAt: iso(Date.now()), updatedAt: iso(Date.now()) }));
    const second = started(await start(await read(9201)));
    finishNow(second);
    await Bun.sleep(3);
    expect(await start(await read(9201))).toEqual({ held: { previousTaskId: second.id } });
    expect(tasksOf(9201)).toHaveLength(2);
  });

  test("an overlap wait met at once does not restart it: the 5972 sequence", async () => {
    const { start, put, status, read, finishNow, tasksOf } = await world();
    // two Tasks that cannot start, and an overlap with Tasks of a PBI no session works on: the wait is met as soon as it is written
    put(
      status(9301), issueRec(9301, { labels: ["type:pbi"], subIssues: [9302, 9303] }), issueRec(9302, { parent: 9301 }), issueRec(9303, { parent: 9301 }),
      issueRec(9304, { labels: ["type:pbi"], subIssues: [9305, 9306] }), issueRec(9305, { parent: 9304 }), issueRec(9306, { parent: 9304 }),
    );
    const first = started(await start(await read(9301)));
    await Bun.sleep(5);
    put(commentRec(9301, "R1", "<!-- pbi-complete:claim 00000000-0000-4000-8000-000000000001 -->", iso(Date.now())));
    await Bun.sleep(3);
    put(commentRec(9301, "R2", "<!-- pbi-complete:release overlap=9305,9306 -->\n後回し", iso(Date.now())));
    await Bun.sleep(3);
    finishNow(first);
    await Bun.sleep(3);
    const item = await read(9301);
    // the sequence is the real one: the wait is on the item and is met, though neither Task it names is closed
    expect(item.waits.map((w) => [w.number, w.state, w.open])).toEqual([[9305, "met", false], [9306, "met", false]]);
    expect(item.events.some((e) => e.key.startsWith("wait-closed"))).toBe(false);
    expect(await start(item)).toEqual({ held: { previousTaskId: first.id } });
    expect(await start(await read(9301))).toEqual({ held: { previousTaskId: first.id } });
    expect(tasksOf(9301)).toHaveLength(1);
  });

  test("the stops of the removed rules stay stopped: a failed or aborted Task, a resume that did not move, a resume that ended before its 状況, a 閉じる that did not close start once, and nothing starts or counts until an event", async () => {
    const h = await world();
    const { put, read, tasksOf } = h;
    const inProgress = (n: number): BacklogSnapshotEntry => ({ objectKind: "project-item", externalId: `PVTI_gate${n}`, fetchState: "fetched", remote: { issue: n, owner: h.core.db.getWorkspaceBacklogSource(h.ws.id)!.project.owner, project: h.core.db.getWorkspaceBacklogSource(h.ws.id)!.project.number, fields: { Status: "In progress" } } });
    const all = async () => ((await (await fetch(`${h.base}/api/backlog`)).json()) as Backlog).items;
    const status = (t: Task, to: "done" | "error" | "aborted") => h.core.db.sqlite.run("UPDATE tasks SET status = ?, status_at = ? WHERE id = ?", [to, Date.now(), t.id]);
    // [PBI, how the Task ends, the stage the item's automatic start is, extra records before the start, the sub-issues still open]
    const scenes: Array<[number, string, "done" | "error" | "aborted", "complete" | "close", BacklogSnapshotEntry[], number]> = [
      [9401, "failed", "error", "complete", [], 2],
      [9411, "aborted", "aborted", "complete", [], 2],
      [9421, "a resume that wrote a 状況 and did not move", "done", "complete", [commentRec(9421, "M1", "## 状況\n進んでいない", "2026-10-02T00:00:00Z")], 2],
      [9431, "a resume that ended before writing its 状況", "done", "complete", [], 2],
      [9441, "a 閉じる that did not close", "done", "close", [], 0],
    ];
    for (const [n, what, end, action, before, open] of scenes) {
      const subs = [n + 1, n + 2, n + 3].slice(0, open + 1);
      put(
        inProgress(n), issueRec(n, { labels: ["type:pbi", "flow-improvement"], subIssues: subs }),
        issueRec(subs[0]!, { parent: n, state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-10-03T00:00:00Z" }),
        ...subs.slice(1).map((m) => issueRec(m, { parent: n })), ...before,
      );
      const before0 = await read(n);
      expect([what, before0.stage, before0.autoHeld, before0.closable]).toEqual([what, "in-progress", null, action === "close"]);
      const startItem = (item: BacklogItem, a: "complete" | "close") => h.core.startStage({ ws: h.ws, meta: h.ws, item, action: a, auto: true });
      // the automatic start the removed rules would have kept stopping happens once
      const first = started(await startItem(before0, action));
      await Bun.sleep(5);
      status(first, end);
      await Bun.sleep(5);
      const item = await read(n);
      expect([what, item.autoHeld]).toEqual([what, { previousTaskId: first.id, action }]);
      expect([what, await startItem(item, action)]).toEqual([what, { held: { previousTaskId: first.id } }]);
      // and no second start: the pick leaves it, the flow count does not count it, and nothing started
      expect([what, pickNext((await all()).filter((i) => i.number === n), "implement")]).toEqual([what, null]);
      expect([what, flowCounted((await all()).filter((i) => i.number === n)).map((i) => i.number)]).toEqual([what, []]);
      expect([what, tasksOf(n).length]).toEqual([what, 1]);
      // an event lets exactly one more start: a Task added to the PBI
      put(issueRec(n, { labels: ["type:pbi", "flow-improvement"], subIssues: [...subs, n + 9] }), issueRec(n + 9, { parent: n, createdAt: iso(Date.now()) }));
      const again = await read(n);
      expect([what, again.autoHeld]).toEqual([what, null]);
      expect([what, pickNext((await all()).filter((i) => i.number === n), "implement")?.item.number]).toEqual([what, n]);
      expect([what, flowCounted((await all()).filter((i) => i.number === n)).map((i) => i.number)]).toEqual([what, [n]]);
      const second = started(await startItem(again, "complete"));
      status(second, "done");
      expect([what, tasksOf(n).length]).toEqual([what, 2]);
    }
  });

  test("a start without auto (the button) is never held and is not the last automatic start", async () => {
    const { core, finish, start } = await bootStart();
    const auto = started(await start(withEvents(430, [])));
    finish(auto);
    const button = started(await start(withEvents(430, []), false));
    expect(button.stage).toEqual({ issue: 430, action: "complete" });
    finish(button);
    // the previous automatic start is still the first one, not the button's
    expect(core.db.lastAutoStageTask(metaId(), 430, "complete")?.id).toBe(auto.id);
    expect(await start(withEvents(430, []))).toEqual({ held: { previousTaskId: auto.id } });
    // and a button's start with no automatic one before it records none
    const only = started(await start(withEvents(431, []), false));
    finish(only);
    expect(core.db.lastAutoStageTask(metaId(), 431, "complete")).toBeNull();
    expect(started(await start(withEvents(431, [])))).toBeDefined();
  });

  /* The three entries start a stage Task by themselves, so each passes `auto`: a PBI whose last automatic Task ended and that only got a plain comment since (the one thing that lets the older "nothing changed" check pass again) is not started a second time. */
  const heldLine = (log: string[], n: number, id: string) => log.some((l) => l.includes(`前回の開始から出来事が増えていない: #${n}（前回 ${id}）`));
  const close307 = () => core().db.listTasks().filter((t) => t.stage?.issue === 307);
  const core = () => state.core!;

  test("no second automatic start without a new event: the schedule", async () => {
    const c = commentingGh();
    const base = await boot(c.gh, holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    const [first] = close307();
    expect(first!.stage).toEqual({ issue: 307, action: "close", auto: true });
    await Bun.sleep(5);
    core().db.updateTask(first!.id, { status: "done" });
    await Bun.sleep(5);
    c.on.v = true; // the Task's own plain comment, after it ended
    await refreshed(base);
    await runSchedule(base, id);
    expect(close307()).toHaveLength(1);
    expect(heldLine(await scheduleLogAll(base), 307, first!.id)).toBe(true);
  });

  test("no second automatic start without a new event: the queue", async () => {
    const c = commentingGh();
    const base = await boot(c.gh, holdingClaude().adapter);
    await putQueue(base, { items: [{ workspaceId: metaId(), number: 307 }], enabled: true });
    await until(() => close307().length === 1);
    const [first] = close307();
    expect(first!.stage).toEqual({ issue: 307, action: "close", auto: true });
    await fetch(`${base}/api/tasks/${first!.id}/abort`, { method: "POST" }); // its end starts the queue again
    await until(async () => (await getQueue(base)).lastNote?.includes("前回の開始から出来事が増えていない") ?? false);
    await Bun.sleep(5);
    c.on.v = true; // the Task's own plain comment, after it ended
    await refreshed(base);
    await putQueue(base, { concurrency: 1 }); // the queue is looked at again
    await until(async () => (await getQueue(base)).lastNote?.includes("前回の開始から出来事が増えていない") ?? false);
    const note = (await getQueue(base)).lastNote!;
    expect(heldLine([note], 307, first!.id)).toBe(true);
    expect(note.split("\n").filter((l) => l.includes("#307"))).toHaveLength(1);
    expect(note).toContain(`${metaName()}: 前回の開始から出来事が増えていない: #307`); // the slot's one gate line, not a second one from the start
    expect(close307()).toHaveLength(1);
  });

  test("no second automatic start without a new event: the resume after an answer", async () => {
    const base = await boot(fakeGh().gh, holdingClaude().adapter);
    const ws = core().db.listWorkspaces().find((w) => w.id === metaId())!;
    // the previous automatic 実装 of Issue 306 was made later than the answer will be written (the answer is the only new thing, and it is older than that start)
    const at = Date.now() + 3_600_000;
    core().db.insertTask({ id: "tsk_prev306", workspaceId: ws.id, title: "#306 実装", stage: { issue: 306, action: "complete", auto: true }, runner: "claude", cwd: ws.path, scope: [ws.path], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at });
    const asks = ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Ask[] }).asks;
    const ask = asks.find((a) => a.kind === "decision" && a.pbi?.number === 306)!;
    const r = await fetch(`${base}/api/asks/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ id: ask.id, answer: { kind: "text", text: "B で" } }) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as AskAnswerResult;
    expect(body.ask!.resume).toEqual({ state: "queued", reason: "前回の開始から出来事が増えていない（前回 tsk_prev306）", taskId: null, at: expect.any(Number) });
    expect(core().db.listTasks().filter((t) => t.stage?.issue === 306)).toHaveLength(1);
    // the button is not held
    expect((await start(base, 306, { action: "complete" })).status).toBe(201);
    expect(core().db.listTasks().filter((t) => t.stage?.issue === 306)).toHaveLength(2);
  });
});

const T = (iso: string) => Date.parse(iso);
const NOW = T("2026-11-21T00:00:00Z");
const issueOf = (state: "OPEN" | "CLOSED", createdAt: string, closedAt: string | null, subIssues: number[] = []) => ({ state, createdAt, closedAt, subIssues });
const pullOf = (number: number, state: "OPEN" | "CLOSED" | "MERGED", closes: number[], mergedAt: string | null, closedAt: string | null) => ({ number, state, closes, mergedAt, closedAt });
const waitOf = (number: number, kind: "issue" | "pr", reason: "overlap" | "prerequisite" = "overlap") => ({ number, kind, open: false, state: "met" as const, reason, pbi: null });
const prereqOf = (number: number, need: "done" | "merged" | "release", state: "met" | "pending", kind: "issue" | "pr" | null = "issue") => ({ number, kind, need, state, via: [], confirming: false });

/** An input with the item 100 and its Tasks 101 (open since 09-02) and 102 (closed 09-04), the way the stored read gives it. */
const base = ({ item, ...over }: Partial<Omit<EventsInput, "item">> & { item?: Partial<EventsInput["item"]> } = {}): EventsInput => ({
  item: { number: 100, waits: [], prereqs: [], waitsUntil: null, ...item },
  issues: new Map([
    [100, issueOf("OPEN", "2026-09-01T00:00:00Z", null, [101, 102])],
    [101, issueOf("OPEN", "2026-09-02T00:00:00Z", null)],
    [102, issueOf("CLOSED", "2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z")],
    [200, issueOf("CLOSED", "2026-08-01T00:00:00Z", "2026-10-05T00:00:00Z")],
    [201, issueOf("OPEN", "2026-08-01T00:00:00Z", null)],
  ]),
  pulls: [],
  commentsOf: () => [],
  now: NOW,
  runningSince: null,
  ...over,
});
const keys = (e: BacklogEvent[]) => Object.fromEntries(e.map((x) => [x.key, x.at]));

describe("eventsOf", () => {
  test("Tasks added and closed are dated by when they were created and closed", () => {
    expect(keys(eventsOf(base()))).toEqual({ "sub-added:#101": T("2026-09-02T00:00:00Z"), "sub-added:#102": T("2026-09-03T00:00:00Z"), "sub-closed:#102": T("2026-09-04T00:00:00Z") });
  });

  test("a PR that closes the item or one of its Tasks counts when merged (mergedAt) or closed, not while open", () => {
    const pulls = [
      pullOf(300, "MERGED", [101], "2026-10-01T00:00:00Z", "2026-10-01T00:00:01Z"),
      pullOf(301, "CLOSED", [100], null, "2026-10-02T00:00:00Z"),
      pullOf(302, "OPEN", [100], null, null),
      pullOf(303, "MERGED", [999], "2026-10-03T00:00:00Z", null),
    ];
    const e = keys(eventsOf(base({ pulls })));
    expect(e["pr:#300"]).toBe(T("2026-10-01T00:00:00Z"));
    expect(e["pr:#301"]).toBe(T("2026-10-02T00:00:00Z"));
    expect(Object.keys(e).filter((k) => k.startsWith("pr:"))).toEqual(["pr:#300", "pr:#301"]);
  });

  test("the answer to a ## 判断待ち on the item or one of its Tasks counts once per question at the time it was written; a confirmation, the record of a criterion confirmed and other comments do not", () => {
    const comments: Record<number, Array<{ body: string; createdAt: string }>> = {
      100: [
        { body: "## 判断待ち\nQ", createdAt: "2026-10-09T00:00:00Z" },
        { body: "## 回答\nA", createdAt: "2026-10-10T00:00:00Z" },
        { body: "ふつうのコメント", createdAt: "2026-10-11T00:00:00Z" },
        { body: "## 状況\n進めた", createdAt: "2026-10-12T00:00:00Z" },
        // what a stage Task writes itself: the record of a confirmation it counted, with no question before it
        { body: "## 回答\n受け入れ条件 1「x」は、判断待ち #7 への回答を確認として数えました。", createdAt: "2026-10-12T01:00:00Z" },
      ],
      101: [{ body: "## 判断待ち\nQ", createdAt: "2026-10-12T00:00:00Z" }, { body: "## 回答\nB", createdAt: "2026-10-13T00:00:00Z" }, { body: "## 回答\n受け入れ条件 2「y」を確認しました。", createdAt: "2026-10-13T01:00:00Z" }],
      // a question answered where no comment shows it (in a Task's conversation), then the records a Task writes: none counts
      102: [{ body: "## 判断待ち\nQ", createdAt: "2026-10-12T00:00:00Z" }, { body: "## 回答\n\n受け入れ条件 3「z」は、判断待ち #102 への回答を確認として数えました。", createdAt: "2026-10-13T02:00:00Z" }, { body: "## 回答\n受け入れ条件 4「w」を確認しました。", createdAt: "2026-10-13T03:00:00Z" }],
      // a question the person confirmed as recommended: taken up without counting, so a later answer counts no more
      103: [{ body: "## 判断待ち\nQ", createdAt: "2026-10-12T00:00:00Z" }, { body: "## 回答\n**確定**: 推奨のまま A — 問い 2026-10-12T00:00:00Z", createdAt: "2026-10-13T04:00:00Z" }, { body: "## 回答\nC", createdAt: "2026-10-13T05:00:00Z" }],
      555: [{ body: "## 回答\nほかの Issue", createdAt: "2026-10-14T00:00:00Z" }],
    };
    const issues = new Map(base().issues);
    issues.set(100, issueOf("OPEN", "2026-09-01T00:00:00Z", null, [101, 102, 103]));
    issues.set(103, issueOf("OPEN", "2026-09-05T00:00:00Z", null));
    const e = keys(eventsOf(base({ issues, commentsOf: (n) => comments[n] ?? [] })));
    expect(Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith("answer:")))).toEqual({
      "answer:#100@2026-10-10T00:00:00Z": T("2026-10-10T00:00:00Z"),
      "answer:#101@2026-10-13T00:00:00Z": T("2026-10-13T00:00:00Z"),
    });
  });

  test("a wait counts when what it names closed, merged or was closed, at that time; waits on open ones, and the prerequisite lines, are named the same way", () => {
    const pulls = [pullOf(310, "MERGED", [], "2026-10-20T00:00:00Z", "2026-10-20T00:00:05Z"), pullOf(311, "OPEN", [], null, null)];
    const item = { waits: [waitOf(200, "issue"), waitOf(201, "issue"), waitOf(311, "pr")], prereqs: [prereqOf(310, "merged", "met", "pr"), prereqOf(200, "done", "met"), prereqOf(201, "done", "pending"), prereqOf(404, "done", "pending", null)] };
    const e = keys(eventsOf(base({ pulls, item })));
    expect(Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith("wait-closed:")))).toEqual({
      "wait-closed:issue#200": T("2026-10-05T00:00:00Z"),
      "wait-closed:pr#310": T("2026-10-20T00:00:00Z"),
    });
  });

  test("a （リリース） prerequisite counts from when the running version started, only when it is met in it", () => {
    const item = { prereqs: [prereqOf(210, "release", "met", "pr"), prereqOf(211, "release", "pending", "pr")] };
    const at = T("2026-11-20T10:00:00Z");
    const e = keys(eventsOf(base({ item, runningSince: at })));
    expect(Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith("release:")))).toEqual({ "release:#210": at });
    expect(Object.keys(keys(eventsOf(base({ item, runningSince: null })))).some((k) => k.startsWith("release:"))).toBe(false);
  });

  test("a due date is an event only once it has passed, at the date; one still ahead is none", () => {
    const passed = { waitsUntil: { at: "2026-11-20T00:00:00Z", met: true } };
    expect(keys(eventsOf(base({ item: passed })))["after:2026-11-20T00:00:00Z"]).toBe(T("2026-11-20T00:00:00Z"));
    // `met` is the read's own: a date later than the time of this read is not listed even if the flag was stale
    const ahead = { waitsUntil: { at: "2026-11-22T00:00:00Z", met: false } };
    expect(Object.keys(keys(eventsOf(base({ item: ahead })))).some((k) => k.startsWith("after:"))).toBe(false);
    expect(Object.keys(keys(eventsOf(base({ item: { waitsUntil: { at: "2026-11-22T00:00:00Z", met: true } } })))).some((k) => k.startsWith("after:"))).toBe(false);
  });

  test("the list is in time order", () => {
    const at = eventsOf(base()).map((e) => e.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  test("nothing a stage Task writes lets it start again (events): comments, a 状況, a claim and a release change none, and a wait on what is already closed stays at the time it closed", () => {
    const quiet = eventsOf(base());
    const written = [
      { body: "<!-- pbi-complete:claim 00000000-0000-4000-8000-000000000001 -->\n開始", createdAt: "2026-11-20T23:00:00Z" },
      { body: "## 状況\n全部終えた", createdAt: "2026-11-20T23:30:00Z" },
      { body: "<!-- pbi-complete:release overlap=200,201 -->\n後回し", createdAt: "2026-11-20T23:59:00Z" },
      { body: "着手のコメント", createdAt: "2026-11-20T23:59:30Z" },
    ];
    const withWrites = eventsOf(base({ commentsOf: (n) => (n === 100 ? written : []), item: { waits: [waitOf(200, "issue"), waitOf(201, "issue")], waitsUntil: { at: "2026-11-22T00:00:00Z", met: false } } }));
    // the closed one it named counts, at the time it closed (not at the 23:59 it was named); the open one and the not yet passed date are none
    expect(keys(withWrites)).toEqual({ ...keys(quiet), "wait-closed:issue#200": T("2026-10-05T00:00:00Z") });
    expect(Math.max(...withWrites.map((e) => e.at))).toBeLessThan(T("2026-11-20T23:00:00Z"));
  });
});
