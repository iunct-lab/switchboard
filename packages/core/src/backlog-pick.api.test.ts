// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogAction, BacklogItem, TaskStatus } from "@switchboard/protocol";
import { listProcesses, loadProcess, parseProcessDef } from "./process-defs.ts";
import { type CoreServer } from "./server.ts";
import { fmtTime } from "./ratelimit.ts";
import { buildStartPrompt, tasksDoneMark, TASKS_DONE_MARK } from "./backlog-prompt.ts";
import { pickNext, dueSoonIssues, dueSoonOf, spinningIn, unchangedIn, heldIn, awaitingReply, isAnswered, failedIn, failedSince, plannedResumeLine, checksOnlyLine, checkingLine, isReplyWaiting, replyWaitingIn, stopHeld } from "./backlog-pick.ts";
import { toItem, requestTextChars, chooseProcess, type RawBacklogIssue } from "./backlog-item.ts";
import { STOPPED, backlogNextSchedule, boot, fixtureStage, holdingClaude, item, metaId, raw, runSchedule, scheduleLogAll, subTask, taskDecisionGh, useBacklogDaemon, wait } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("pickNext: Priority (none last), then Ready before 分解待ち before 要望, then the oldest; skips decisions and running items", () => {
  const items = [
    item({ number: 1, stage: "request", priority: "P0" }),
    item({ number: 2, stage: "needs-tasks", priority: "P0" }),
    item({ number: 3, stage: "ready", priority: null }),
    item({ number: 4, stage: "ready", priority: "P1", createdAt: "2026-09-03T00:00:00Z" }),
    item({ number: 5, stage: "ready", priority: "P1", createdAt: "2026-09-02T00:00:00Z" }),
    item({ number: 6, stage: "ready", priority: "P0", activeTaskId: "tsk" }),
    item({ number: 7, stage: "needs-decision", priority: "P0" }),
    item({ number: 8, stage: "in-progress", priority: "P0" }),
  ];
  expect(pickNext(items, "implement")).toEqual({ item: items[4]!, action: "complete" });
  // the plan slot: 分解待ち before 要望, never a Ready PBI
  expect(pickNext(items, "plan")).toMatchObject({ item: { number: 2 }, action: "to-tasks" });
  expect(pickNext([items[0]!], "plan")).toMatchObject({ item: { number: 1 }, action: "to-pbi" });
  expect(pickNext([items[0]!], "implement")).toBeNull();
  expect(pickNext(items.slice(5), "implement")).toBeNull();
  expect(pickNext(items.slice(5), "plan")).toBeNull();
});

describe("pickNext: a PBI of a known failure near its end goes before Priority", () => {
  const NOW = Date.parse("2026-11-14T12:00:00Z");
  const items = [
    item({ number: 1, stage: "ready", priority: "P0" }),
    item({ number: 2, stage: "ready", priority: "P1", origin: 50 }),
    item({ number: 3, stage: "ready", priority: "P3" }),
  ];
  const pick = (until: string) => pickNext(items, "implement", undefined, undefined, [], dueSoonIssues([{ test: "a.test.ts > t", issue: 50, until }], NOW))!.item.number;
  test("the day before `until` and after it: its PBI first; two days before: Priority as before", () => {
    expect(pick("2026-11-15")).toBe(2);
    expect(pick("2026-11-14")).toBe(2);
    expect(pick("2026-11-10")).toBe(2);
    expect(pick("2026-11-16")).toBe(1);
  });
  test("the Issue itself counts, and an answered in-progress PBI still goes first", () => {
    const due = dueSoonIssues([{ test: "a.test.ts > t", issue: 3, until: "2026-11-15" }], NOW);
    expect(pickNext(items, "implement", undefined, undefined, [], due)).toMatchObject({ item: { number: 3 } });
    const t = Date.parse("2026-11-13T00:00:00Z");
    const answered = item({ number: 9, stage: "in-progress", priority: "P3", answeredAt: "2026-11-14T00:00:00Z", lastTask: { id: "tsk_old", status: "done", statusAt: t, createdAt: t, updatedAt: t, action: "complete", outcome: "unknown", reviewedAt: null, resumeAt: null, started: true } });
    expect(pickNext([...items, answered], "implement", undefined, undefined, [], new Set([2]))!.item.number).toBe(9);
  });
  test("dueSoonOf reads the checkout's registry; an absent or broken file is no tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-known-"));
    try {
      expect([...dueSoonOf(dir, NOW)]).toEqual([]);
      writeFileSync(join(dir, "known-failures.json"), "{not json");
      expect([...dueSoonOf(dir, NOW)]).toEqual([]);
      writeFileSync(join(dir, "known-failures.json"), JSON.stringify([{ test: "a.test.ts > t", issue: 50, until: "2026-11-15" }, { test: "b.test.ts > t", issue: 51, until: "2026-12-30" }]));
      expect([...dueSoonOf(dir, NOW)]).toEqual([50]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test("pickNext queue: the queue's order over Priority, only the queued items, a held head gives the next, no order is as before", () => {
  const items = [
    item({ number: 1, stage: "ready", priority: "P0" }),
    item({ number: 2, stage: "ready", priority: "P3" }),
    item({ number: 3, stage: "ready", priority: "P1", waits: [wait(778, "pr", true)] }),
    item({ number: 4, stage: "needs-tasks", priority: "P0" }),
  ];
  expect(pickNext(items, "implement", [2, 1])).toEqual({ item: items[1]!, action: "complete" });
  // a Ready PBI not in the queue is never picked from it
  expect(pickNext(items, "implement", [4])).toBeNull();
  expect(pickNext(items, "implement", [])).toBeNull();
  // the head waits for a PR still open: the second goes
  expect(pickNext(items, "implement", [3, 2, 1])).toMatchObject({ item: { number: 2 } });
  // the plan slot does not follow the queue
  expect(pickNext(items, "plan", [2])).toMatchObject({ item: { number: 4 }, action: "to-tasks" });
  expect(pickNext(items, "implement")).toMatchObject({ item: { number: 1 } });
});

test("pickNext: a request goes to 直行で直す or PBI にする by chooseProcess; one a direct Task ran on is left unless it came back", () => {
  const at = "2026-09-28T00:00:00Z";
  const direct = (status: TaskStatus) => ({ id: "tsk_direct", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "direct" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true });
  const defs = listProcesses();
  const items = [
    item({ number: 1, stage: "request", type: "request", priority: "P0", lastTask: direct("done"), commentedAt: "2026-09-28T01:00:00Z" }),
    item({ number: 2, stage: "request", type: "request", priority: "P0", lastTask: direct("error") }),
    item({ number: 3, stage: "request", type: "request", priority: "P3", bodyChars: 5000 }),
  ];
  // the one a direct Task ran on (done or failed) is not made a PBI; the large one is
  expect(pickNext(items, "plan", undefined, undefined, defs)).toMatchObject({ item: { number: 3 }, action: "to-pbi", reason: expect.stringContaining("auto pipeline") });
  expect(pickNext(items.slice(0, 2), "plan", undefined, undefined, defs)).toBeNull();
  // a small one starts directly, with the reason; without the definitions every request is a PBI にする
  const small = item({ number: 4, stage: "request", type: "request", bodyChars: 100 });
  expect(pickNext([small], "plan", undefined, undefined, defs)).toMatchObject({ action: "direct", reason: expect.stringContaining("auto direct") });
  expect(pickNext([small], "plan")?.action).toBe("to-pbi");
  // brought back by the direct Task: the pipeline takes it, whatever its size
  const back = item({ number: 1, stage: "request", type: "request", bodyChars: 100, labels: ["direct-returned"], lastTask: direct("done") });
  expect(pickNext([back], "plan", undefined, undefined, defs)).toMatchObject({ action: "to-pbi", reason: "direct returned" });
  expect(pickNext([item({ number: 5, stage: "ready" })], "implement", undefined, undefined, defs)?.reason).toBeUndefined();
  // a direct Task that never started (queued at the limit, its start cancelled) does not hold the request
  const unstarted = item({ number: 6, stage: "request", type: "request", bodyChars: 100, lastTask: { ...direct("idle"), started: false } });
  expect(pickNext([unstarted], "plan", undefined, undefined, defs)).toMatchObject({ item: { number: 6 }, action: "direct" });
  expect(pickNext([{ ...unstarted, lastTask: direct("idle") }], "plan", undefined, undefined, defs)).toBeNull();
});

test("buildStartPrompt: to-tasks on a PBI that already has Tasks asks to make it Ready without decomposing again", () => {
  const decomposed = buildStartPrompt({ number: 7, tasks: { total: 2, done: 0, doneAt: null } }, "to-tasks");
  for (const s of ["分解済み", "作り直さず", "最新の `## 回答` を PBI と Task に反映", "受け入れ条件の被覆", "PBI #7 を Ready にしてください"]) expect(decomposed).toContain(s);
  expect(decomposed).not.toContain("Task に分解して Ready にしてください");
  for (const item of [{ number: 7, tasks: { total: 0, done: 0, doneAt: null } }, { number: 7, tasks: null }, { number: 7 }]) {
    const p = buildStartPrompt(item, "to-tasks");
    expect(p).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #7 を Task に分解して Ready にしてください。");
    expect(p).not.toContain("分解済み");
  }
});

test("buildStartPrompt: the stage text comes from the p0-pipeline definition — a swapped entry changes the prompt, a missing entry refuses to start", () => {
  const def = loadProcess("p0-pipeline");
  const swapped = { ...def, entries: { ...def.entries, complete: "TEST {{n}} swapped" } };
  expect(buildStartPrompt({ number: 305 }, "complete", {}, swapped).startsWith("TEST 305 swapped\n\n対象: #305。")).toBe(true);
  // the parts the daemon adds around the entry (the answer to read, the scope of the request) stay
  expect(buildStartPrompt({ number: 305 }, "complete", {}, swapped)).toContain("この依頼は、マージ判定");
  expect(buildStartPrompt({ number: 305 }, "check", {}, swapped)).toBe(buildStartPrompt({ number: 305 }, "check"));
  const { complete: _dropped, ...rest } = def.entries;
  expect(() => buildStartPrompt({ number: 305 }, "check", {}, { ...def, entries: rest })).toThrow("lacks entries complete");
  // the tasks-done mark is given only on a resume: an entry that asks for it otherwise does not render a 0
  expect(() => buildStartPrompt({ number: 305 }, "complete", {}, { ...def, entries: { ...def.entries, complete: "X {{tasksDoneMark}}" } })).toThrow("uses {{tasksDoneMark}}, which was not given");
  const bare = parseProcessDef("---\nid: x\nversion: 1\ntitle: X\n---\n## entry complete\nonly\n", "x.md");
  expect(() => buildStartPrompt({ number: 1 }, "complete", {}, bare)).toThrow("lacks entries to-pbi, to-tasks, to-tasks-ready, complete-other, complete-resume, check, close");
});

test("pickNext answered: an in-progress PBI answered after its last stage Task goes on with complete, before Ready", () => {
  const finished = (at: string) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true });
  const items = [
    item({ number: 1, stage: "ready", priority: "P0" }),
    item({ number: 2, stage: "in-progress", priority: "P3", answeredAt: null, lastTask: finished("2026-09-28T00:00:00Z") }), // no answer
    item({ number: 3, stage: "in-progress", priority: "P3", answeredAt: "2026-09-27T00:00:00Z", lastTask: finished("2026-09-28T00:00:00Z") }), // older than its last Task
    item({ number: 4, stage: "in-progress", priority: "P3", answeredAt: "2026-09-28T01:00:00Z", lastTask: finished("2026-09-28T00:00:00Z"), createdAt: "2026-09-02T00:00:00Z" }),
    // never started from the backlog: whoever runs it (a session outside the backlog) reads the answer itself
    item({ number: 5, stage: "in-progress", priority: "P0", answeredAt: "2026-09-28T01:00:00Z", lastTask: null }),
  ];
  expect(pickNext(items, "implement")).toEqual({ item: items[3]!, action: "complete" });
  expect(pickNext([items[0]!, items[4]!], "implement")).toMatchObject({ item: { number: 1 } });
  // only answered ones: without Issue 4 and Issue 5, Ready is next; the plan slot never takes them
  expect(pickNext(items.slice(0, 3), "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  expect(pickNext(items.slice(1), "plan")).toBeNull();
  // a status check that finished after the answer has taken it up; a running stage Task holds it
  expect(pickNext([items[0]!, { ...items[3]!, lastTask: { id: "tsk_check", status: "done", statusAt: Date.parse("2026-09-28T02:00:00Z"), createdAt: Date.parse("2026-09-28T02:00:00Z"), updatedAt: Date.parse("2026-09-28T02:00:00Z"), action: "check", outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } }], "implement")).toMatchObject({ item: { number: 1 } });
  expect(pickNext([items[0]!, { ...items[3]!, activeTaskId: "tsk_run" }], "implement")).toMatchObject({ item: { number: 1 } });
});

test("pickNext answered: a PBI still waiting on a decision, its own or a Task's, is left and Ready goes on", () => {
  const answered = { answeredAt: "2026-09-28T01:00:00Z", lastTask: null };
  const waiting = item({ number: 2, stage: "needs-decision", priority: "P0", ...answered, decision: { body: "## 判断待ち", at: "2026-09-28T02:00:00Z", issue: 20 } });
  const ready = item({ number: 1, stage: "ready", priority: "P3" });
  expect(pickNext([waiting, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(pickNext([waiting], "implement")).toBeNull();
});

test("pickNext answered: backlog-next starts 実装 on an in-progress PBI whose Task was answered after its last stage Task", async () => {
  const claude = holdingClaude();
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", [], [["## 回答\n\nB で", new Date(Date.now() + 60_000).toISOString()]])], i307: [] });
  const base = await boot(fake.gh, claude.adapter);
  // Issue 305's last stage Task stopped on the question before it was answered
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_last305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  const titles = core!.db.listTasks().map((t) => t.title);
  expect(titles).toContainEqual(expect.stringMatching(/^#305 実装: /));
  expect(titles.some((t) => t.startsWith("#304 "))).toBe(false); // the implement slot went to Issue 305, before Ready Issue 304
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#305 を complete で開始"));
  // the answer may be on a Task: the prompt points there too
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.find((x) => x.prompt.includes("/pbi-complete 305"))!.prompt).toContain("`## 回答` コメント（sub-issue の Task のものも）を読み");
});

test("pickNext waiting: an in-progress PBI whose waits all closed goes on with complete, after an answered one and before Ready; an open wait holds Ready and in-progress alike", () => {
  const finished = { id: "tsk_last", status: "done" as const, statusAt: Date.parse("2026-09-28T00:00:00Z"), createdAt: Date.parse("2026-09-28T00:00:00Z"), updatedAt: Date.parse("2026-09-28T00:00:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
  const closed = [wait(778, "pr", false), wait(603, "issue", false)];
  const open = [wait(778, "pr", true), wait(603, "issue", false)];
  const ready = item({ number: 1, stage: "ready", priority: "P0" });
  // the release came before its 実装 finished, so the Issue looks unchanged since: an unblocked PBI is taken all the same
  const unblocked = item({ number: 2, stage: "in-progress", priority: "P3", waits: closed, waitsAt: STOPPED, lastTask: finished });
  const answered = item({ number: 3, stage: "in-progress", priority: "P3", answeredAt: "2026-09-28T01:00:00Z", lastTask: finished });
  expect(pickNext([ready, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
  expect(pickNext([ready, unblocked, answered], "implement")).toMatchObject({ item: { number: 3 }, action: "complete" });
  expect(pickNext([unblocked], "plan")).toBeNull();
  // a Ready PBI stopped the same way, unchanged since its last 実装, goes on once its waits closed
  const unblockedReady = item({ number: 4, stage: "ready", waits: closed, waitsAt: STOPPED, lastTask: finished });
  expect(pickNext([unblockedReady], "implement")).toEqual({ item: unblockedReady, action: "complete" });
  // one open wait: neither a Ready nor an in-progress PBI is taken, and the slot lists them
  const waitingReady = item({ number: 5, stage: "ready", priority: "P0", waits: open });
  const waitingBuilding = { ...unblocked, number: 6, waits: open };
  expect(pickNext([waitingReady, waitingBuilding], "implement")).toBeNull();
  expect(pickNext([waitingReady, waitingBuilding, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(heldIn([waitingReady, waitingBuilding, ready, unblocked], "implement").map((h) => h.item).map((i) => i.number)).toEqual([5, 6]);
  expect(heldIn([waitingReady, waitingBuilding], "plan").map((h) => h.item)).toEqual([]);
  // a running one is busy, not held by its wait
  expect(heldIn([{ ...waitingReady, activeTaskId: "tsk_run" }], "implement").map((h) => h.item)).toEqual([]);
  // a wait not read holds it as an open one does: neither taken as unblocked nor started
  const unread = { ...unblocked, number: 7, waits: [...closed, wait(999, "issue", null)] };
  expect(pickNext([unread, ready], "implement")).toMatchObject({ item: { number: 1 } });
  expect(heldIn([unread], "implement").map((h) => h.item).map((i) => i.number)).toEqual([7]);
});

test("pickNext waiting: a Ready PBI whose waits closed goes before untried Ready, reviewed or not", () => {
  const at = Date.parse("2026-09-28T00:00:00Z");
  const finished = { id: "tsk_last", status: "done" as const, statusAt: at, createdAt: at, updatedAt: at, action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, started: true };
  const closed = [wait(778, "pr", false)];
  const untried = item({ number: 1, stage: "ready", priority: "P0" });
  const lastUpdated = "2026-09-28T01:00:00Z";
  const unreviewed = item({ number: 2, stage: "ready", priority: "P3", waits: closed, waitsAt: STOPPED, lastTask: finished, commentedAt: lastUpdated });
  const reviewed = { ...unreviewed, number: 3, lastTask: { ...finished, reviewedAt: at + 1 } };
  const answered = item({ number: 4, stage: "in-progress", priority: "P3", answeredAt: lastUpdated, lastTask: finished });
  const closable = item({ number: 5, stage: "in-progress", priority: "P3", tasks: { total: 1, done: 1, doneAt: null }, closable: true });
  // no update since the stopped Task: it awaits a reply, and is taken all the same
  const quiet = { ...unreviewed, number: 6, commentedAt: "2026-09-01T00:00:00Z" };
  for (const unblocked of [unreviewed, reviewed, quiet]) {
    expect(pickNext([untried, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
    expect(pickNext([closable, untried, unblocked], "implement")).toEqual({ item: unblocked, action: "complete" });
    expect(pickNext([unblocked, answered], "implement")).toMatchObject({ item: { number: 4 }, action: "complete" });
  }
});

test("pickNext stalled: an in-progress PBI with every Task closed is closed; one with Tasks left is resumed unless it did not move since its last resume", () => {
  const report = (n: number | null, at = "2026-09-29T00:00:00Z") => ({ body: `## 状況\n### 残り\n- #12${n === null ? "" : `\n${TASKS_DONE_MARK(n)}`}`, at });
  const closable = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true });
  const stalled = item({ number: 2, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null } });
  expect(pickNext([closable], "implement")).toEqual({ item: closable, action: "close" });
  expect(pickNext([stalled], "implement")).toEqual({ item: stalled, action: "complete", resume: true });
  expect(pickNext([closable, stalled], "plan")).toBeNull();
  // a confirmation left (not closable) with every Task closed: neither closed nor resumed
  expect(pickNext([{ ...closable, closable: false, confirmations: [{ n: 1, text: "見た目（利用者確認: 画面）", after: null }] }], "implement")).toBeNull();
  // a running stage Task or a question holds it
  expect(pickNext([{ ...closable, activeTaskId: "tsk_run" }, { ...stalled, activeTaskId: "tsk_run" }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, stage: "needs-decision", decision: { body: "## 判断待ち", at: "2026-09-29T00:00:00Z", issue: 2 } }], "implement")).toBeNull();
  // a 閉じる that finished with no update since is not started again; an update brings it back
  const triedClose = { ...closable, lastTask: { id: "tsk_close", status: "error" as const, statusAt: Date.parse("2026-09-29T00:00:00Z"), createdAt: Date.parse("2026-09-29T00:00:00Z"), updatedAt: Date.parse("2026-09-29T00:00:00Z"), action: "close" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } };
  expect(pickNext([triedClose], "implement")).toBeNull();
  expect(pickNext([{ ...triedClose, commentedAt: "2026-09-29T01:00:00Z" }], "implement")).toMatchObject({ action: "close" });
  expect(unchangedIn([triedClose, closable], "implement").map((i) => i.number)).toEqual([1]);
  expect(unchangedIn([{ ...triedClose, commentedAt: "2026-09-29T01:00:00Z" }], "implement")).toEqual([]);
  expect(unchangedIn([triedClose], "plan")).toEqual([]);
  // started for another reason or listed under 待ち: not named as unchanged
  expect(unchangedIn([{ ...triedClose, answeredAt: "2026-09-29T01:00:00Z" }, { ...triedClose, number: 9, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  // the mark of the last resume: the same count → left (and listed); a Task closed since → resumed; an answer after it → resumed
  const spun = { ...stalled, report: report(1) };
  expect(pickNext([spun], "implement")).toBeNull();
  expect(spinningIn([spun, stalled, closable], "implement").map((i) => i.number)).toEqual([2]);
  expect(spinningIn([spun], "plan")).toEqual([]);
  expect(pickNext([{ ...spun, tasks: { total: 3, done: 2, doneAt: null } }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...spun, answeredAt: "2026-09-29T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...spun, answeredAt: "2026-09-28T23:00:00Z" }], "implement")).toBeNull();
  // a ## 状況 without the mark (a 状況確認's) does not hold it
  expect(pickNext([{ ...stalled, report: report(null) }], "implement")).toMatchObject({ action: "complete", resume: true });
  // a resume that ended (done: a failed one is held by 前回の Task が失敗したまま更新が無い) before writing its mark is left until the Issue, a Task or an answer moves past its start
  const died = { ...stalled, lastTask: { id: "tsk_resume", status: "done" as const, statusAt: Date.parse("2026-09-30T00:00:00Z"), createdAt: Date.parse("2026-09-30T00:00:00Z"), updatedAt: Date.parse("2026-09-30T00:10:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } };
  expect(pickNext([died], "implement")).toBeNull();
  expect(spinningIn([died], "implement").map((i) => i.number)).toEqual([2]);
  expect(pickNext([{ ...died, commentedAt: "2026-09-30T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true }); // a comment (also: a Ready 実装 that logged its start, then stopped)
  expect(pickNext([{ ...died, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true }); // a Task closed since
  expect(pickNext([{ ...died, answeredAt: "2026-09-30T01:00:00Z" }], "implement")?.item.number).toBe(2); // an answer
  expect(pickNext([{ ...died, tasks: { total: 3, done: 1, doneAt: "2026-09-29T00:00:00Z" } }], "implement")).toBeNull(); // a Task closed before the resume
  expect(pickNext([{ ...died, lastTask: { ...died.lastTask, action: "check" as const } }], "implement")).toMatchObject({ action: "complete", resume: true }); // the last Task was a 状況確認
  // a resume that failed (error) before writing its mark is held by 前回の Task が失敗したまま更新が無い: held until the Issue, an answer or a closed Task is newer than its end
  const failed = { ...died, lastTask: { ...died.lastTask, status: "error" as const } };
  expect(pickNext([failed], "implement")).toBeNull();
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...failed, tasks: { total: 3, done: 2, doneAt: "2026-09-30T00:05:00Z" } }], "implement")).toBeNull(); // closed before it ended
  // a Task closing does not answer a question the resume asked the person
  const asking = { ...died, lastTask: { ...died.lastTask, outcome: "needs_action" as const } };
  expect(pickNext([{ ...asking, tasks: { total: 3, done: 2, doneAt: "2026-09-30T01:00:00Z" } }], "implement")).toBeNull();
  expect(tasksDoneMark(report(4))).toBe(4);
  expect(tasksDoneMark(report(null))).toBeNull();
  expect(tasksDoneMark(null)).toBeNull();
});

test("pickNext stalled: the implement slot's order is 回答済みの実装中 → 閉じられる実装中 → 止まった実装中 → Ready", () => {
  const finished = { id: "tsk_last", status: "done" as const, statusAt: Date.parse("2026-09-28T00:00:00Z"), createdAt: Date.parse("2026-09-28T00:00:00Z"), updatedAt: Date.parse("2026-09-28T00:00:00Z"), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
  const ready = item({ number: 1, stage: "ready", priority: "P0" });
  const stalled = item({ number: 2, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null } });
  const closable = item({ number: 3, stage: "in-progress", priority: "P3", tasks: { total: 2, done: 2, doneAt: null }, closable: true });
  const answered = item({ number: 4, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null }, answeredAt: "2026-09-28T01:00:00Z", lastTask: finished });
  const all = [ready, stalled, closable, answered];
  expect(pickNext(all, "implement")).toEqual({ item: answered, action: "complete" });
  expect(pickNext(all.slice(0, 3), "implement")).toEqual({ item: closable, action: "close" });
  expect(pickNext(all.slice(0, 2), "implement")).toEqual({ item: stalled, action: "complete", resume: true });
  expect(pickNext(all.slice(0, 1), "implement")).toEqual({ item: ready, action: "complete" });
  // an open wait holds a stalled PBI too
  expect(pickNext([{ ...stalled, waits: [wait(778, "pr", true)] }, ready], "implement")).toMatchObject({ item: { number: 1 } });
});

test("pickNext tried: an item whose last stage Task is of the same stage is picked after the untried of its Priority, however it ended and whatever was written since; the gate, not the pick, decides whether it starts again", () => {
  const last = (action: BacklogAction, at = "2026-09-28T00:00:00Z", status: TaskStatus = "done") => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true });
  const updated = "2026-09-28T01:00:00Z"; // after the last Task finished
  const triedReady = item({ number: 1, stage: "ready", priority: "P0", lastTask: last("complete") });
  const freshReady = item({ number: 2, stage: "ready", priority: "P3" });
  // 1: tried (done, failed or aborted alike) with nothing written since is still a candidate: the untried goes first within a Priority, the tried one alone is picked
  expect(pickNext([triedReady, freshReady], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" }); // P0 before P3
  expect(pickNext([triedReady, { ...freshReady, priority: "P0" }], "implement")).toMatchObject({ item: { number: 2 } });
  expect(pickNext([triedReady], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  // a Task that failed is held by `failedSince` (kept: the flow count and the overlap places read it too), not by the gate
  expect(pickNext([{ ...triedReady, lastTask: last("complete", undefined, "error") }], "implement")).toBeNull();
  // the same for 分解待ち and 要望 in the plan slot
  const triedTasks = item({ number: 3, stage: "needs-tasks", priority: "P0", lastTask: last("to-tasks") });
  const triedRequest = item({ number: 4, stage: "request", type: "request", priority: "P0", lastTask: last("to-pbi") });
  const freshRequest = item({ number: 5, stage: "request", type: "request", priority: "P0" });
  expect(pickNext([triedTasks, triedRequest, freshRequest], "plan")).toMatchObject({ item: { number: 5 }, action: "to-pbi" });
  expect(pickNext([triedTasks, triedRequest], "plan")).toMatchObject({ item: { number: 3 }, action: "to-tasks" });
  // nothing is listed as unchanged for them: that line is for a repeated stop and a 閉じる that did not close
  expect(unchangedIn([triedReady, freshReady, triedTasks, triedRequest, freshRequest], "plan")).toEqual([]);
  expect(unchangedIn([triedReady], "implement")).toEqual([]);
  // 2: a last Task of another stage (split into Tasks, now Ready) is not worked on at this stage yet: it goes with the untried
  expect(pickNext([item({ number: 6, stage: "ready", lastTask: last("to-tasks") }), { ...triedReady, number: 7, priority: item({}).priority }], "implement")).toMatchObject({ item: { number: 6 } });
  // an answered in-progress PBI stays first
  const answered = item({ number: 8, stage: "in-progress", priority: "P3", answeredAt: updated, commentedAt: updated, lastTask: last("complete") });
  expect(pickNext([triedReady, freshReady, answered], "implement")).toMatchObject({ item: { number: 8 }, action: "complete" });
});

test("pickNext priority: a Ready P0 worked on before goes before an untried Ready P3; a resume or a close of an in-progress PBI still goes first", () => {
  const at = "2026-09-28T00:00:00Z";
  const done = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
  const triedP0 = item({ number: 1, stage: "ready", priority: "P0", lastTask: done, commentedAt: "2026-09-28T01:00:00Z" });
  const freshP3 = item({ number: 2, stage: "ready", priority: "P3" });
  expect(pickNext([freshP3, triedP0], "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
  // a stalled in-progress PBI (resumed) and a closable one go before the P0 Ready, whatever their Priority
  const stalled = item({ number: 3, stage: "in-progress", priority: "P3", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: at });
  const closable = item({ number: 4, stage: "in-progress", priority: "P3", tasks: { total: 2, done: 2, doneAt: null }, closable: true, commentedAt: at });
  expect(pickNext([freshP3, triedP0, stalled], "implement")).toMatchObject({ item: { number: 3 }, action: "complete", resume: true });
  expect(pickNext([freshP3, triedP0, stalled, closable], "implement")).toMatchObject({ item: { number: 4 }, action: "close" });
  // within one Priority: not yet worked on first, then the oldest
  const triedP2 = { ...triedP0, number: 5, priority: "P2", createdAt: "2026-01-01T00:00:00Z" };
  const freshP2New = item({ number: 6, stage: "ready", priority: "P2", createdAt: "2026-09-02T00:00:00Z" });
  const freshP2Old = item({ number: 7, stage: "ready", priority: "P2", createdAt: "2026-09-01T00:00:00Z" });
  expect(pickNext([triedP2, freshP2New], "implement")).toMatchObject({ item: { number: 6 } });
  expect(pickNext([triedP2, freshP2New, freshP2Old], "implement")).toMatchObject({ item: { number: 7 } });
});

test("pickNext priority: the plan slot takes a 分解待ち PBI by Priority, before a request with none", () => {
  const at = "2026-09-28T00:00:00Z";
  const done = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "to-tasks" as const, outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true };
  const triedP1 = item({ number: 1, stage: "needs-tasks", priority: "P1", lastTask: done, commentedAt: "2026-09-28T01:00:00Z", createdAt: "2026-09-02T00:00:00Z" });
  const freshRequest = item({ number: 2, stage: "request", type: "request", priority: null, createdAt: "2026-09-01T00:00:00Z" });
  expect(pickNext([freshRequest, triedP1], "plan")).toMatchObject({ item: { number: 1 }, action: "to-tasks" });
  // the same Priority (none): 分解待ち before 要望
  expect(pickNext([freshRequest, { ...triedP1, lastTask: null, priority: null }], "plan")).toMatchObject({ item: { number: 1 } });
});

test("pickNext failed: an item whose last stage Task failed with no update to the Issue since is left in any stage; an update, a reply's resume or a closed wait brings it back", () => {
  const at = "2026-09-28T00:00:00Z";
  const failed = (status: TaskStatus = "error", resumeAt: number | null = null) => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "failed" as const, reviewedAt: null, resumeAt, started: true });
  // an in-progress PBI with Tasks left: resumed unless its last Task failed and the Issue was not updated since — the usage-limit case (resumeAt set) and an aborted one alike
  const stalled = item({ number: 1, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: at });
  expect(pickNext([stalled], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed("error", Date.parse("2026-09-30T11:01:00Z")) }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, lastTask: failed("aborted") }], "implement")).toBeNull();
  // the Issue updated after it (a comment, a ## 回答) → resumed; an Issue updated at the very time is not newer
  expect(pickNext([{ ...stalled, lastTask: failed(), commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z", commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  // a closable one is held the same way; its waits closing still goes on
  const closable = item({ number: 2, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, commentedAt: at, lastTask: failed() });
  expect(pickNext([closable], "implement")).toBeNull();
  expect(pickNext([{ ...closable, waits: [wait(778, "pr", false)], waitsAt: at }], "implement")).toMatchObject({ item: { number: 2 } });
  // a Ready item too, and the plan slot's stages
  expect(pickNext([item({ number: 3, stage: "ready", commentedAt: at, lastTask: failed() })], "implement")).toBeNull();
  expect(pickNext([item({ number: 4, stage: "needs-tasks", commentedAt: at, lastTask: { ...failed(), action: "to-tasks" } })], "plan")).toBeNull();
  // listed for the log by slot; a running one or one waiting for a PR is not
  const items = [{ ...stalled, lastTask: failed() }, closable, item({ number: 3, stage: "ready", commentedAt: at, lastTask: failed() }), item({ number: 4, stage: "needs-tasks", commentedAt: at, lastTask: { ...failed(), action: "to-tasks" as const } })];
  expect(failedIn(items, "implement").map((i) => i.number)).toEqual([1, 2, 3]);
  expect(failedIn(items, "plan").map((i) => i.number)).toEqual([4]);
  expect(failedIn([{ ...stalled, lastTask: failed(), activeTaskId: "tsk_run" }, { ...closable, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  expect(failedSince(stalled)).toBe(false);
  expect(failedSince({ ...stalled, lastTask: failed("done") })).toBe(false);
  // a ## 回答 on a child Task sets answeredAt without touching the parent's updatedAt: that counts as an update too
  expect(pickNext([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  expect(failedIn([{ ...stalled, lastTask: failed(), answeredAt: "2026-09-28T01:00:00Z" }], "implement")).toEqual([]);
});

test("a planned resume is named in the queue log", () => {
  const at = "2026-09-28T00:00:00Z";
  const resumeAt = Date.parse("2026-11-17T03:41:00Z");
  const last = (resume: number | null, outcome: "failed" | "unknown") => ({ id: "tsk_last", status: "error" as TaskStatus, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome, reviewedAt: null, resumeAt: resume, started: true });
  // held by the reservation: the Issue was updated after the Task, so failedIn does not name it
  const planned = item({ number: 2999, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: "2026-09-28T01:00:00Z", lastTask: last(resumeAt, "failed"), activeTaskId: "tsk_last" });
  // held the same way but failed with no update since: failedIn names it (with its time), so not here
  const failed = item({ number: 3000, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: at, lastTask: last(resumeAt, "failed"), activeTaskId: "tsk_last" });
  // a running Task with no resume time is not a reservation
  const running = item({ number: 3001, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: at, lastTask: last(null, "unknown"), activeTaskId: "tsk_last" });
  const now = Date.parse("2026-11-17T01:00:00Z");
  expect(failedIn([failed], "implement").map((i) => i.number)).toEqual([3000]);
  expect(plannedResumeLine([planned, failed, running], "implement", now, fmtTime)).toBe("再開の予約: #2999（12:41 に再開）");
  expect(plannedResumeLine([planned, failed, running], "plan", now, fmtTime)).toBeNull();
  expect(plannedResumeLine([failed], "implement", now, fmtTime)).toBeNull();
});

test("a PBI left with only the person's checks is named", () => {
  const confirm = [{ n: 1, text: "画面で確かめる", after: null }];
  const at = "2026-09-28T00:00:00Z";
  const asked = { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true };
  const only = (n: number, extra: object = {}) => item({ number: n, stage: "in-progress", tasks: { total: 3, done: 3, doneAt: null }, confirmations: confirm, ...extra });
  const items = [
    only(3467),
    only(2799),
    // no check left: closable, not named
    only(1, { confirmations: [], closable: true }),
    // Tasks still open
    only(2, { tasks: { total: 3, done: 2, doneAt: null } }),
    // a stage Task running
    only(3, { activeTaskId: "tsk_run" }),
    // the last stage Task ended asking the person: named as 返事待ち, not here
    only(4, { commentedAt: at, lastTask: asked }),
    // a ## 回答 since the last stage Task: backlog-next starts it, so it is not left
    only(5, { commentedAt: "2026-09-28T01:00:00Z", answeredAt: "2026-09-28T01:00:00Z", lastTask: { ...asked, outcome: "finished" as const } }),
  ];
  expect(awaitingReply(items[5]!)).toBe(true);
  expect(isAnswered(items[6]!)).toBe(true);
  expect(checksOnlyLine(items, "implement")).toBe("利用者確認だけ: #3467 #2799");
  expect(checksOnlyLine(items, "plan")).toBeNull();
  expect(checksOnlyLine(items.slice(2), "implement")).toBeNull();
});

describe("a checking PBI (only after-merge checks left)", () => {
  const at = "2026-09-28T00:00:00Z";
  const checking = (n: number, extra: object = {}) => item({ number: n, stage: "in-progress", tasks: { total: 3, done: 3, doneAt: null }, postMerge: [{ n: 1, text: "昇格後に画面で見る", kind: "画面" as const, after: null }], ...extra });

  test("pickNext does not close or resume a checking PBI", () => {
    const c = checking(10);
    expect(c.progress.checking).toBe(true);
    expect(c.closable).toBe(false);
    expect(pickNext([c], "implement")).toBeNull();
    // the same PBI without the after-merge line is closable and is closed
    expect(pickNext([item({ number: 11, stage: "in-progress", tasks: { total: 3, done: 3, doneAt: null }, closable: true })], "implement")).toMatchObject({ action: "close" });
  });

  test("an answered checking PBI still resumes", () => {
    const answered = checking(12, { commentedAt: "2026-09-28T01:00:00Z", answeredAt: "2026-09-28T01:00:00Z", lastTask: { id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "finished" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true } });
    expect(isAnswered(answered)).toBe(true);
    expect(pickNext([answered], "implement")).toMatchObject({ item: { number: 12 } });
    expect(checkingLine([answered], "implement")).toBeNull();
  });

  test("the log names checking PBIs on one line", () => {
    const items = [checking(10), checking(13), checking(14, { activeTaskId: "tsk_run" }), checking(15, { tasks: { total: 3, done: 2, doneAt: null }, progress: { closableByApi: false, closesOnAnswer: null, checking: false } })];
    expect(checkingLine(items, "implement")).toBe("確認中: #10 #13");
    expect(checkingLine(items, "plan")).toBeNull();
    // named on this line only: a checking PBI with a user check is not also "利用者確認だけ"
    const both = checking(16, { confirmations: [{ n: 2, text: "見る", after: null }] });
    expect(checksOnlyLine([both], "implement")).toBeNull();
    expect(checkingLine([both], "implement")).toBe("確認中: #16");
  });
});

test("pickNext awaiting reply: an item whose last stage Task ended asking the person (needs_action, not reviewed) is left until a ## 回答 or the Task reviewed", () => {
  const at = "2026-09-28T00:00:00Z";
  const asked = (over: Partial<NonNullable<BacklogItem["lastTask"]>> = {}) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, started: true, ...over });
  const stalled = item({ number: 1, stage: "in-progress", tasks: { total: 3, done: 1, doneAt: null }, commentedAt: at, lastTask: asked() });
  expect(pickNext([stalled], "implement")).toBeNull();
  // reviewed (the person read it) → resumed; an outcome set by hand to done → resumed; a Task that ended without asking → resumed
  expect(pickNext([{ ...stalled, lastTask: asked({ reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(pickNext([{ ...stalled, commentedAt: "2026-09-28T00:30:00Z", lastTask: asked({ outcome: "finished" }) }], "implement")).toMatchObject({ action: "complete", resume: true });
  // the Issue updated since with no ## 回答 (a label, another Task's comment) → still left; a ## 回答 → resumed
  expect(pickNext([{ ...stalled, commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toBeNull();
  expect(pickNext([{ ...stalled, answeredAt: "2026-09-28T01:00:00Z", commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ action: "complete" });
  // a Task still waiting (status waiting) is not finished: activeTaskId holds the item, not this rule
  expect(awaitingReply({ ...stalled, lastTask: asked({ status: "waiting" }) })).toBe(false);
  // a Ready item whose 実装 stopped asking, and the plan slot's stages
  const ready = item({ number: 2, stage: "ready", commentedAt: at, lastTask: asked() });
  expect(pickNext([ready], "implement")).toBeNull();
  expect(pickNext([{ ...ready, commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toBeNull();
  expect(pickNext([{ ...ready, answeredAt: "2026-09-28T01:00:00Z", commentedAt: "2026-09-28T01:00:00Z" }], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  const request = item({ number: 3, stage: "request", type: "request", commentedAt: at, lastTask: asked({ action: "to-pbi" }) });
  expect(pickNext([request], "plan")).toBeNull();
  // a request's ## 回答 is not read: any update to it still lets it go, as before
  expect(pickNext([{ ...request, commentedAt: "2026-09-28T01:00:00Z" }], "plan")).toMatchObject({ item: { number: 3 } });
  // listed for the log by slot, apart from the failed ones
  expect(replyWaitingIn([stalled, ready, request], "implement").map((i) => i.number)).toEqual([1, 2]);
  expect(replyWaitingIn([stalled, ready, request], "plan").map((i) => i.number)).toEqual([3]);
  expect(failedIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement")).toEqual([]);
  expect(replyWaitingIn([{ ...stalled, lastTask: asked({ status: "error" }) }], "implement").map((i) => i.number)).toEqual([1]);
  expect(replyWaitingIn([{ ...stalled, activeTaskId: "tsk_run" }, { ...ready, waits: [wait(778, "pr", true)] }], "implement")).toEqual([]);
  // a ## 回答 on a child Task (answeredAt newer, the parent's updatedAt not): answered, so resumed first — not listed as awaiting
  const childAnswered = { ...stalled, answeredAt: "2026-09-28T01:00:00Z" };
  expect(pickNext([childAnswered], "implement")).toMatchObject({ action: "complete" });
  expect(replyWaitingIn([childAnswered], "implement")).toEqual([]);
  // reviewed releases a Ready item and a closable one too, which 前回の再開から進んでいない would otherwise hold until the Issue changes
  const reviewed = asked({ reviewedAt: Date.parse("2026-09-28T02:00:00Z") });
  expect(pickNext([{ ...ready, lastTask: reviewed }], "implement")).toMatchObject({ item: { number: 2 }, action: "complete" });
  expect(unchangedIn([{ ...ready, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([item({ number: 4, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, closable: true, commentedAt: at, lastTask: { ...reviewed, action: "close" } })], "implement")).toMatchObject({ action: "close" });
  // a stalled PBI held by 前回の再開から進んでいない (its last resume's tasks-done mark matches): reviewed releases it as well; a done resume reviewed does not
  const spun = { ...stalled, report: { body: `## 状況\n### 残り\n- #12\n${TASKS_DONE_MARK(1)}`, at: "2026-09-27T23:00:00Z" } };
  expect(pickNext([spun], "implement")).toBeNull();
  expect(pickNext([{ ...spun, lastTask: reviewed }], "implement")).toMatchObject({ action: "complete", resume: true });
  expect(spinningIn([{ ...spun, lastTask: reviewed }], "implement")).toEqual([]);
  expect(pickNext([{ ...spun, lastTask: asked({ outcome: "finished", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toBeNull();
  // one that ended done (nothing asked) and was marked reviewed is picked like any tried one; the gate decides whether it starts again
  expect(pickNext([{ ...ready, lastTask: asked({ outcome: "finished", reviewedAt: Date.parse("2026-09-28T02:00:00Z") }) }], "implement")).toMatchObject({ item: { number: 2 } });
});

test("replyWaiting: the row's waiting for a reply is backlog-next's awaitingReply, read from the last stage Task's outcome alone", () => {
  const at = "2026-09-28T00:00:00Z";
  const later = "2026-09-28T01:00:00Z";
  const last = (over: Partial<NonNullable<BacklogItem["lastTask"]>> = {}) => ({ id: "tsk_last", status: "done" as const, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, started: true, ...over });
  const stopOf = (over: Partial<BacklogItem["stopSummary"][number]> = {}): BacklogItem["stopSummary"][number] => ({
    key: "k", work: { workspaceId: "ws_meta", issue: 1, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "decision", evidence: "マージしてよいか", safety: "before-effect",
    count: 1, state: "waiting", firstAt: 1, lastAt: 2, contentAt: 1, lastAnswer: null, answered: false, grant: null, conditions: [], actions: [], changes: [], unchanged: false, next: "decide", ...over,
  });
  const asked = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, commentedAt: at, lastTask: last() });
  const stopped = { ...asked, lastTask: last({ outcome: "unknown" }), stopSummary: [stopOf()] };
  // [name, item, replyWaiting, awaitingReply (backlog-next's skip as 返事待ち)]
  const rows: [string, BacklogItem, boolean, boolean][] = [
    ["(a) done, needs_action, not reviewed, the Issue older", asked, true, true],
    ["(b) unknown with the newest stop next = decide: the outcome is not judged, so the stop alone does not wait", stopped, false, false],
    ["(c) (a) reviewed", { ...asked, lastTask: last({ reviewedAt: Date.parse(later) }) }, false, false],
    ["(d) (a) with the Issue newer than the Task but no ## 回答: still waiting", { ...asked, commentedAt: later }, true, true],
    ["(e) (a) with a newer ## 回答", { ...asked, answeredAt: later }, false, false],
    ["(f) (b) answered: the answer leaves the stop waiting, with answered (moveOpenStops)", { ...stopped, stopSummary: [stopOf({ next: "resume", answered: true, lastAnswer: { ref: "seq:9", at: 3 }, changes: [{ kind: "answer", detail: "seq:9" }] })] }, false, false],
    ["(f2) done + a decision stop answered, the Task resumed and ended done: not waiting", { ...asked, lastTask: last({ outcome: "finished" }), stopSummary: [stopOf({ answered: true, lastAnswer: { ref: "seq:9", at: 3 } })] }, false, false],
    // the outcome decides, whatever the stop is: a stop waiting for a decision under outcome finished / waits does not wait on the person, needs_action does
    ["(g) done + newest stop decision waiting, outcome finished", { ...asked, lastTask: last({ outcome: "finished" }), stopSummary: [stopOf()] }, false, false],
    ["(g2) the same with outcome waits", { ...asked, lastTask: last({ outcome: "waits" }), stopSummary: [stopOf()] }, false, false],
    ["(h) needs_action + newest stop depends waiting", { ...asked, stopSummary: [stopOf({ reason: "depends", next: "wait" })] }, true, true],
  ];
  for (const [name, i, want, skip] of rows) {
    expect([name, isReplyWaiting(i)]).toEqual([name, want]);
    expect([name, awaitingReply(i)]).toEqual([name, skip]);
  }
  // awaitingReply is the same judgment as isReplyWaiting; a running Task is not waiting
  expect(isReplyWaiting({ ...asked, stopSummary: [stopOf({ work: { workspaceId: "ws_meta", issue: 1, taskId: "tsk_old" } })] })).toBe(true);
  expect(isReplyWaiting({ ...asked, lastTask: last({ status: "running", outcome: "unknown" }) })).toBe(false);
});

test("awaitingReply: a last stage Task still in background is not waiting for a reply even when its outcome is needs_action; the same Task done is", () => {
  const at = "2026-09-28T00:00:00Z";
  const last = (status: "background" | "done") => ({ id: "tsk_last", status, statusAt: Date.parse(at), createdAt: Date.parse(at), updatedAt: Date.parse(at), action: "complete" as const, outcome: "needs_action" as const, reviewedAt: null, resumeAt: null, started: true });
  const base = item({ number: 1, stage: "in-progress", tasks: { total: 2, done: 2, doneAt: null }, commentedAt: at });
  expect(awaitingReply({ ...base, lastTask: last("background") })).toBe(false);
  expect(isReplyWaiting({ ...base, lastTask: last("background") })).toBe(false);
  expect(awaitingReply({ ...base, lastTask: last("done") })).toBe(true);
});

test("a stop that came again with nothing changed holds the item through an unrelated Issue update; an answer, a met condition or a new cause lets it go once", () => {
  const last = { id: "tsk_last", status: "done" as const, statusAt: 1, createdAt: 1, updatedAt: Date.parse("2026-09-10T00:00:00Z"), action: "complete" as const, outcome: "finished" as const, reviewedAt: null, resumeAt: null, started: true };
  const stopOf = (over: Partial<BacklogItem["stopSummary"][number]> = {}): BacklogItem["stopSummary"][number] => ({
    key: "k", work: { workspaceId: "ws_meta", issue: 3, taskId: "tsk_last" }, op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI", safety: "unknown",
    count: 2, state: "waiting", firstAt: 1, lastAt: 2, contentAt: 1, lastAnswer: null, answered: false, grant: null, conditions: [], actions: [], changes: [], unchanged: true, next: "wait", ...over,
  });
  const touched = "2026-09-12T00:00:00Z"; // the Issue was updated after the Task ended
  const base = item({ number: 3, stage: "ready", lastTask: last, commentedAt: touched, stopSummary: [stopOf()] });
  // an in-progress PBI moved since its last resume (its ## 状況 written): resumed unless a stop holds it
  const progressOf = (i: BacklogItem): BacklogItem => ({ ...i, stage: "in-progress", tasks: { done: 1, total: 3, doneAt: null } });
  expect(pickNext([{ ...progressOf(base), stopSummary: [] }], "implement")?.item.number).toBe(3);
  // same condition, restopped: an update to the Issue alone starts nothing, and the item is listed as left alone
  expect(stopHeld(base)).toBe(true);
  expect(pickNext([base], "implement")).toBeNull();
  expect(unchangedIn([base], "implement").map((i) => i.number)).toEqual([3]);
  // without the stop the same update does start it again (the earlier behaviour)
  expect(pickNext([{ ...base, stopSummary: [] }], "implement")?.item.number).toBe(3);
  // a first stop with nothing waited on is not held — an unrelated update still lets it start once
  expect(stopHeld({ ...base, stopSummary: [stopOf({ count: 1, unchanged: false })] })).toBe(false);
  // a first stop with a condition still unmet is held; once the item's own prerequisite is met it goes
  const waitingOn = stopOf({ count: 1, unchanged: false, conditions: [{ key: "pr#12", value: "open", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [waitingOn] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [waitingOn], prereqs: [{ number: 12, kind: "pr", need: "merged", state: "met", via: [], confirming: false }] })).toBe(false);
  expect(stopHeld({ ...base, stopSummary: [waitingOn], prereqs: [{ number: 12, kind: "pr", need: "merged", state: "pending", via: [], confirming: false }] })).toBe(true);
  // retries used up: held until something changes
  expect(stopHeld({ ...base, stopSummary: [stopOf({ count: 1, state: "exhausted", next: "decide" })] })).toBe(true);
  // a first stop waiting for the person's decision (asked to merge): stopHeld does not hold it, the Task's outcome does — the
  // writer sets needs_action, and awaitingReply keeps the queue from starting the stage again on top of the Task that asked
  // (two PBIs that asked to merge, and the queue started their 実装 again within a second), through an unrelated update to
  // the Issue too (base's: the Issue updated after the Task). A reply in that Task (a new turn, outcome unknown), a ## 回答
  // or 確認済み lets it go
  const ask = stopOf({ count: 1, unchanged: false, reason: "decision", next: "decide" });
  const asking = { ...progressOf(base), stopSummary: [ask], lastTask: { ...last, outcome: "needs_action" as const } };
  expect(stopHeld({ ...base, stopSummary: [ask] })).toBe(false);
  expect(pickNext([asking], "implement")).toBeNull();
  expect(pickNext([{ ...asking, lastTask: { ...asking.lastTask, outcome: "unknown" as const } }], "implement")?.item.number).toBe(3);
  expect(pickNext([{ ...asking, answeredAt: "2026-09-13T00:00:00Z" }], "implement")?.item.number).toBe(3);
  expect(pickNext([{ ...asking, lastTask: { ...asking.lastTask, reviewedAt: Date.parse("2026-09-13T00:00:00Z") } }], "implement")?.item.number).toBe(3);
  // one of two conditions met: the other still holds it
  const two = stopOf({ count: 1, unchanged: false, changes: [{ kind: "condition-met", detail: "pr#12: merged" }], conditions: [{ key: "pr#12", value: "merged", met: true }, { key: "review", value: "pending", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [two] })).toBe(true);
  // a new answer, a condition met, another cause: not held
  for (const kind of ["answer", "condition-met", "cause"] as const)
    expect(stopHeld({ ...base, stopSummary: [stopOf({ unchanged: false, changes: [{ kind, detail: "x" }], next: "resume" })] })).toBe(false);
  // resolved or of an older Task: not held; a ## 回答 on the PBI releases it too
  expect(stopHeld({ ...base, stopSummary: [stopOf({ state: "resolved" })] })).toBe(false);
  expect(stopHeld({ ...base, stopSummary: [stopOf({ work: { workspaceId: "ws_meta", issue: 3, taskId: "tsk_old" } })] })).toBe(false);
  const progress = item({ number: 4, stage: "in-progress", tasks: { done: 1, total: 3, doneAt: null }, lastTask: last, commentedAt: touched, stopSummary: [stopOf()] });
  expect(pickNext([progress], "implement")).toBeNull();
  expect(pickNext([{ ...progress, answeredAt: "2026-09-13T00:00:00Z" }], "implement")?.item.number).toBe(4);
  // a different item still goes first
  expect(pickNext([base, item({ number: 5, stage: "ready" })], "implement")?.item.number).toBe(5);
  // the newest series decides: an older one that stayed the same does not hold back a new cause
  const newCause = stopOf({ key: "k2", reason: "input", count: 1, lastAt: 9, unchanged: false, changes: [{ kind: "cause", detail: "depends → input" }], next: "wait", conditions: [] });
  expect(stopHeld({ ...base, stopSummary: [stopOf(), newCause] })).toBe(false);
  // ...and one that waits for the person's decision (CI waited on, then asked to merge) is the outcome's side: needs_action holds it through awaitingReply
  const nowAsks = stopOf({ key: "k2", reason: "decision", count: 1, lastAt: 9, unchanged: false, changes: [{ kind: "cause", detail: "depends → decision" }], next: "decide" });
  expect(stopHeld({ ...base, stopSummary: [stopOf(), nowAsks] })).toBe(false);
  expect(awaitingReply({ ...asking, stopSummary: [stopOf(), nowAsks] })).toBe(true);
  // a question asked after an old depends stop (the question itself records no stop): the newer signal is the Task's outcome, so
  // the item waits for the reply and the stage is not started again on top of it; a depends stop recorded after the question
  // makes the outcome `waits`, and then it is not a reply that is awaited
  const askedAfterStop = { ...asking, stopSummary: [waitingOn] };
  expect(awaitingReply(askedAfterStop)).toBe(true);
  expect(pickNext([askedAfterStop], "implement")).toBeNull();
  expect(replyWaitingIn([askedAfterStop], "implement").map((i) => i.number)).toEqual([3]);
  expect(awaitingReply({ ...askedAfterStop, lastTask: { ...asking.lastTask, outcome: "waits" as const } })).toBe(false);
  // an unmet condition's value moving is not a condition met; and an Issue 12 met is not PR 12 met
  const moved = stopOf({ unchanged: false, changes: [{ kind: "condition", detail: "pr#12: open → draft" }], conditions: [{ key: "pr#12", value: "draft", met: false }] });
  expect(stopHeld({ ...base, stopSummary: [moved] })).toBe(true);
  expect(stopHeld({ ...base, stopSummary: [moved], prereqs: [{ number: 12, kind: "issue", need: "done", state: "met", via: [], confirming: false }] })).toBe(true);
});

describe("chooseProcess: the candidate a request starts in", () => {
  const defs = (max: number) => [
    parseProcessDef("---\nid: p0-pipeline\nversion: 1\ntitle: p0\n---\n", "p0.md"),
    parseProcessDef(`---\nid: p1-direct\nversion: 1\ntitle: p1\nauto: { maxBodyChars: ${max}, excludeLabels: [needs-decision, flow-improvement] }\n---\n`, "p1.md"),
  ];
  const small = item({ type: "request", stage: "request", bodyChars: 120, labels: ["type:request"] });
  const big = item({ type: "request", stage: "request", bodyChars: 2000, labels: ["type:request"] });

  test("a small request goes direct and a large one to the pipeline, each with its reason", () => {
    expect(chooseProcess(small, defs(600))).toEqual({ process: "p1-direct", reason: "auto direct: 本文 120 字 ≤ 600" });
    const c = chooseProcess(big, defs(600));
    expect(c.process).toBe("p0-pipeline");
    expect(c.reason).toBe("auto pipeline: p1-direct: 本文 2000 字 > 600");
  });

  test("changing only the definition's maxBodyChars changes the choice of the same request", () => {
    expect(chooseProcess(big, defs(600)).process).toBe("p0-pipeline");
    expect(chooseProcess(big, defs(5000)).process).toBe("p1-direct");
    expect(chooseProcess(small, defs(100)).process).toBe("p0-pipeline");
  });

  test("an excluded label keeps it out of the candidate; direct-returned goes to the pipeline", () => {
    const flagged = item({ ...small, labels: ["type:request", "needs-decision"] });
    expect(chooseProcess(flagged, defs(600))).toEqual({ process: "p0-pipeline", reason: "auto pipeline: p1-direct: ラベル needs-decision" });
    expect(chooseProcess(item({ ...small, labels: ["direct-returned"] }), defs(600))).toEqual({ process: "p0-pipeline", reason: "direct returned" });
  });

  const ws = { id: "ws_meta", name: "switchboard" };
  const asItem = (body: string) => toItem(raw(["type:request"], body), 11, ws)!;
  const req = (text: string, extra = "") => `## 要望\n\n${text}\n\n## 原文\n\n\`\`\`text\n元の文\n\`\`\`\n${extra}`;

  test("two requests with the same 要望 and a different 解釈メモ length start in the same candidate", () => {
    const short = asItem(req("ボタンの色を直す"));
    const long = asItem(req("ボタンの色を直す", `\n## 解釈メモ\n\n${"あ".repeat(2000)}\n`));
    expect(long.bodyChars).toBeGreaterThan(600);
    expect(long.requestChars).toBe(short.requestChars);
    expect(chooseProcess(long, defs(600))).toEqual(chooseProcess(short, defs(600)));
    expect(chooseProcess(long, defs(600)).process).toBe("p1-direct");
  });

  test("pickNext allocation: toItem carries the 出典's speaker (null when none)", () => {
    expect(asItem(req("x", "\n## 出典\n- 誰の言葉: 定期の検査\n")).requestFrom).toBe("定期の検査");
    expect(asItem(req("x")).requestFrom).toBeNull();
  });

  test("pickNext allocation: toItem carries the Project's Kind (null when none)", () => {
    const withKind: RawBacklogIssue = { ...raw(["type:pbi"], ""), projectItems: { nodes: [{ project: { number: 11 }, fieldValues: { nodes: [{ name: "Ready", field: { name: "Status" } }, { name: "deps", field: { name: "Kind" } }] } }] } };
    expect(toItem(withKind, 11, ws)!.kind).toBe("deps");
    expect(toItem(raw(["type:pbi"], "", "Ready"), 11, ws)!.kind).toBeNull();
  });

  test("a request's own words are counted without the fence lines; a body with no 要望 section is counted whole", () => {
    expect(requestTextChars("## 要望\n\n```text\nabc\n```\n")).toBe(3);
    expect(requestTextChars("## 原文\nabc")).toBeNull();
    // a `## 要望` line quoted inside a fence is not the section, and an empty section has no words: both fall back to the body
    const quoted = asItem("## 原文\n\n```text\n## 要望\nabc\n```\n" + "x".repeat(900));
    expect(quoted.requestChars).toBeNull();
    expect(chooseProcess(quoted, defs(600)).process).toBe("p0-pipeline");
    expect(requestTextChars("## 要望\n\n```text\n```\n## 解釈メモ\nabc")).toBeNull();
    const plain = asItem("x".repeat(700));
    expect(plain.requestChars).toBeNull();
    expect(chooseProcess(plain, defs(600))).toEqual({ process: "p0-pipeline", reason: "auto pipeline: p1-direct: 本文 700 字 > 600" });
  });

  test("the reason names the request's own words and their length", () => {
    expect(chooseProcess(asItem("## 要望\n\nabcde\n"), defs(600)).reason).toBe("auto direct: 要望の文 5 字 ≤ 600");
    expect(chooseProcess(asItem(`## 要望\n\n${"a".repeat(700)}\n`), defs(600)).reason).toBe("auto pipeline: p1-direct: 要望の文 700 字 > 600");
  });

  test("the kit's own definitions: p1-direct has the criteria and p0-pipeline has none", () => {
    const kit = listProcesses();
    expect(chooseProcess(small, kit).process).toBe("p1-direct");
    expect(chooseProcess(item({ ...small, labels: ["flow-improvement"] }), kit).process).toBe("p0-pipeline");
  });
});
