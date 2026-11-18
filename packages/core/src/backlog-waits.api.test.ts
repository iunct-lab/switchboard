// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog, BacklogIssueData, BacklogItem, TaskStatus } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { importing } from "../fixtures/github-import.ts";
import { prereqsOf } from "./backlog-item.ts";
import { prereqState, type WaitTarget, waitsOf } from "./backlog-waits.ts";
import { pickNext, heldIn, isUnblocked } from "./backlog-pick.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { withOverlap, overlapHolderLines, overlapLine, isOverlapLine, isOverlapped, swapOverlapLines } from "./backlog-overlap.ts";
import { FAKE_ORIGIN, STOPPED, backlogNextSchedule, boot, fixtureStage, getQueue, holdingClaude, item, metaId, metaName, putQueue, refreshed, releaseBody, runSchedule, scheduleLogAll, start, subTask, sweepAll, until, useBacklogDaemon, wait, waitsGh, waitsOfItem, withProcesses } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

const LATER = "2026-09-30T01:00:00Z";

const openPrMerged = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "MERGED" } };

describe("backlog waiting", () => {
  test("waiting: a decision Task releases an explicit overlap wait but not a prerequisite wait", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN", labels: { nodes: [{ name: "needs-decision" }] } } };
    const fake = waitsGh({ i304: [[releaseBody("重複", [603], true), STOPPED]], i307: [[releaseBody("前提", [603]), STOPPED]] }, states);
    const base = await boot(fake.gh);
    const ready = await waitsOfItem(base, 304);
    expect(ready).toMatchObject({ waits: [], waitsAt: STOPPED });
    expect(pickNext([ready], "implement")).toMatchObject({ item: { number: 304 } });
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(603, "issue", true)]);
  });

  test("waiting: a Draft or decision PR releases the old overlap wait without closing it, while Issue prerequisites remain", async () => {
    for (const deferred of [{ isDraft: true }, { isDraft: false, labels: { nodes: [{ name: "needs-decision" }] } }]) {
      const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]], i307: [[releaseBody("後回し", [778, 603]), STOPPED]] }, {
        w778: { __typename: "PullRequest", state: "OPEN", ...deferred }, w603: { __typename: "Issue", state: "OPEN" },
      });
      const base = await boot(fake.gh);
      const ready = await waitsOfItem(base, 304);
      expect(ready).toMatchObject({ waits: [], waitsAt: STOPPED });
      expect(pickNext([{ ...ready, lastTask: { id: "tsk_old", status: "done", statusAt: Date.parse(LATER), createdAt: Date.parse(LATER), updatedAt: Date.parse(LATER), action: "complete", outcome: "unknown" as const, reviewedAt: null, resumeAt: null, started: true } }], "implement")).toMatchObject({ item: { number: 304 }, action: "complete" });
      const building = await waitsOfItem(base, 307);
      expect(building.waits).toEqual([wait(603, "issue", true)]);
      expect(pickNext([building], "implement")).toBeNull();
      expect(fake.waitsCalls[0]).toContain("isDraft");
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
  });

  test("waiting: a Draft made ready blocks again on the next read", async () => {
    const states = { w778: { __typename: "PullRequest", state: "OPEN", isDraft: true } };
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states);
    const base = await boot(fake.gh);
    expect((await waitsOfItem(base, 307)).waits).toEqual([]);
    states.w778.isDraft = false;
    const again = (await refreshed(base)).items.find((i) => i.number === 307)!;
    expect(again.waits).toEqual([wait(778, "pr", true)]);
  });

  test("waiting: an in-progress PBI whose newest pbi-complete mark is a release with waits carries them with their states", async () => {
    const fake = waitsGh({ i307: [["着手", "2026-09-29T00:00:00Z"], [releaseBody("後回し: #330（PR #778 と重なる）", [778, 603]), STOPPED], ["ふつうのコメント", LATER]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [wait(603, "issue", true), wait(778, "pr", false)], waitsAt: STOPPED });
    expect(fake.waitsCalls).toHaveLength(1);
    expect(fake.waitsCalls[0]).toContain("w603: issueOrPullRequest(number:603)");
    expect(fake.waitsCalls[0]).toContain("w778: issueOrPullRequest(number:778)");
    expect((await waitsOfItem(base, 305)).waits).toEqual([]);
  });

  test("waiting: a later release without waits, or a later claim, clears the wait", async () => {
    for (const later of [releaseBody("完了"), "<!-- pbi-complete:claim t1 -->\n/pbi-complete 開始。"]) {
      const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED], [later, LATER]] }, openPrMerged);
      const base = await boot(fake.gh);
      expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
      expect(fake.waitsCalls).toHaveLength(0);
      await core!.stop(); core = undefined;
      rmSync(home!, { recursive: true, force: true });
    }
  });

  test("waiting: a later ## 回答 clears the wait", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED], ["## 回答\n\nA で", LATER]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect((await waitsOfItem(base, 307)).waits).toEqual([]);
  });

  test("waiting: a Ready PBI carries its waits too, and its newest ## 回答 (what lets 返事待ち go), and nothing else from its comments", async () => {
    const fake = waitsGh({ i304: [["## 状況\n### 済んだこと", "2026-09-29T00:00:00Z"], ["## 回答\n\nA", "2026-09-29T01:00:00Z"], [releaseBody("後回し", [778]), STOPPED]] }, openPrMerged);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 304)).toMatchObject({ stage: "ready", waits: [wait(778, "pr", false)], report: null, decision: null, answeredAt: "2026-09-29T01:00:00Z" });
  });

  test("waiting: an in-progress PBI held by a Task's question is needs-decision and carries no waits", async () => {
    const question = subTask(330, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: x", LATER]]);
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, openPrMerged, [question]);
    const base = await boot(fake.gh);
    expect(await waitsOfItem(base, 307)).toMatchObject({ stage: "needs-decision", waits: [] });
  });

  test("waiting: each wait says why it waits; a number GitHub did not find stays as not read and holds the PBI (the parent PBI: backlog-stored.test.ts)", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "MERGED" }, w999: null };
    const fake = waitsGh({ i304: [[releaseBody("重複", [778, 603], true), STOPPED]], i307: [[releaseBody("前提", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
    const base = await boot(fake.gh);
    const ready = await waitsOfItem(base, 304);
    expect(ready.waits).toEqual([wait(603, "issue", true, { reason: "overlap" }), wait(778, "pr", false, { reason: "overlap" })]);
    const building = await waitsOfItem(base, 307);
    expect(building.waits).toEqual([wait(603, "issue", true), wait(999, "issue", null)]);
    // not read is not closed: still held once Issue 603 closed
    expect(pickNext([{ ...building, waits: [wait(603, "issue", false), wait(999, "issue", null)] }], "implement")).toBeNull();
  });

  test("waits owner: a PR's PBI is the parent of the Task it closes; that PBI's stage Task is read from its own item", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778, 30501]), STOPPED]] }, {
      w778: { __typename: "PullRequest", state: "OPEN", body: "## 何を\n\nCloses #30501", headRefName: "sb/30501-x" },
      w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } },
    });
    const base = await boot(fake.gh);
    const now = Date.now();
    core!.db.insertTask({ id: "tsk_owner305", workspaceId: metaId(), title: "#305 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "error", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#305 実装: PBI: 実装中の PBI"), statusAt: now, createdAt: now, updatedAt: now });
    const owner = { number: 305, title: "PBI: 実装中の PBI" };
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(778, "pr", true, { pbi: owner }), wait(30501, "issue", true, { pbi: owner })]);
    expect(await waitsOfItem(base, 305)).toMatchObject({ lastTask: { id: "tsk_owner305", status: "error" }, activeTaskId: null });
  });

  test("waits owner: a branch alone names the Task, a PBI waited for is its own, and a PR that names nothing is not found", async () => {
    const fake = waitsGh({ i307: [[releaseBody("後回し", [305, 778, 779, 30501]), STOPPED]] }, {
      w778: { __typename: "PullRequest", state: "OPEN", body: "Task は無い", headRefName: "fix-something" },
      w779: { __typename: "PullRequest", state: "OPEN", body: null, headRefName: "sb/30501-only-branch" },
      w30501: { __typename: "Issue", state: "OPEN", parent: { number: 305 } },
    });
    const base = await boot(fake.gh);
    const owner = { number: 305, title: "PBI: 実装中の PBI" };
    expect((await waitsOfItem(base, 307)).waits).toEqual([wait(305, "issue", true, { pbi: owner }), wait(778, "pr", true), wait(779, "pr", true, { pbi: owner }), wait(30501, "issue", true, { pbi: owner })]);
  });

  test("waiting: with no waits anywhere the states are not asked for", async () => {
    const fake = waitsGh({});
    const base = await boot(fake.gh);
    const items = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items;
    expect(items.every((i) => i.waits.length === 0)).toBe(true);
    expect(fake.waitsCalls).toHaveLength(0);
  });
});

test("backlog-next waiting: an open wait is not started and the log names it; once it closed the next firing starts 実装 on the in-progress PBI first", async () => {
  const claude = holdingClaude();
  const states = { w603: { __typename: "Issue", state: "OPEN" }, w778: { __typename: "PullRequest", state: "OPEN" } };
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]], i307: [[releaseBody("後回し", [778, 603]), STOPPED]] }, states);
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#303 Task に分解"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #304（PR #778 マージ待ち） #307（#603 未完・PR #778 マージ待ち）`));
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められる項目が無い`));
  // both closed: Issue 307 (in progress) goes before Ready Issue 304
  states.w603.state = "CLOSED";
  states.w778.state = "MERGED";
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#303 Task に分解", "#307 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#307 を complete で開始"));
});

describe("resume when waits clear", () => {
  /** Issue 307 (in progress) waits on PR 778, open; a backlog-next schedule is saved (enabled). */
  async function waitingOn778() {
    const claude = holdingClaude();
    const states: Record<string, Record<string, unknown>> = { w778: { __typename: "PullRequest", state: "OPEN" } };
    const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, states);
    const base = await boot(fake.gh, claude.adapter);
    const id = await backlogNextSchedule(base);
    return { claude, states, base, id, waitsCalls: fake.waitsCalls };
  }
  const implementing307 = () => core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "));
  /** Until `f` holds or `ms` passed: what an import sets off runs after the import's answer. */
  const until = async (f: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !f() && Date.now() < end; ) await Bun.sleep(10);
  };
  /** An import that reads the PR merged, and time for what it sets off. */
  const merge778 = async (base: string, states: Record<string, Record<string, unknown>>) => {
    states.w778 = { ...states.w778, state: "MERGED" };
    await refreshed(base);
    await Bun.sleep(300);
  };

  test("resume when waits clear: an import that reads the waited PR merged starts 実装 on the PBI, before the next firing", async () => {
    const { claude, states, base, id, waitsCalls } = await waitingOn778();
    const before = core!.db.getSchedule(id)!;
    states.w778 = { ...states.w778, state: "MERGED" };
    const reads = waitsCalls.length;
    await refreshed(base);
    await until(() => claude.starts.length > 0);
    expect(claude.starts).toHaveLength(1);
    // the import that cleared the waits and the read right before the start: the narrow firing does not read once more first
    expect(waitsCalls.length - reads).toBe(2);
    // that PBI only, in the implement slot: Ready Issue 304 and Issue 303 (the plan slot) wait for the firing
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#307 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/#307 を complete で開始 \S+ \(待ちが解けた\)$/));
    // the schedule's times stay: the next firing comes when it was due
    expect(core!.db.getSchedule(id)).toMatchObject({ lastRunAt: before.lastRunAt, nextRunAt: before.nextRunAt, lastTaskId: implementing307()[0]!.id });
  });

  test("resume when waits clear respects slots: a full implement slot, a high usage, a disabled schedule start nothing; two imports start one", async () => {
    // the implement slot is full: the firing started Ready Issue 304 (and Issue 303 in the plan slot) while Issue 778 was open
    {
      const { claude, states, base, id } = await waitingOn778();
      expect((await runSchedule(base, id)).status).toBe(201);
      const firing = claude.starts.length;
      await merge778(base, states);
      expect(claude.starts).toHaveLength(firing);
      expect(implementing307()).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // usage at backlogQuotaLimit or more and a stage Task running: one at a time, though the slot has room
    {
      const { claude, states, base, id } = await waitingOn778();
      core!.db.upsertQuota("claude", "five_hour", 0.85, Math.floor(Date.now() / 1000) + 3600); // over the backlog limit, under fallbackAt (at it the start is held)
      await sweepAll(base, { implement: 2, plan: 0 });
      expect((await runSchedule(base, id)).status).toBe(201);
      expect(claude.starts).toHaveLength(1);
      await merge778(base, states);
      expect(claude.starts).toHaveLength(1);
      expect(implementing307()).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // backlog-next disabled
    {
      const { claude, states, base, id } = await waitingOn778();
      expect((await fetch(`${base}/api/schedules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
      await merge778(base, states);
      expect(claude.starts).toHaveLength(0);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
    }
    // two imports that each store a change: the second sees the stage Task running and starts no other
    {
      const { claude, states, base } = await waitingOn778();
      await merge778(base, states);
      // the second import stores a change too (a PR opened: what calls the resume)
      openPulls = [{ number: 900, files: [] }];
      await refreshed(base);
      await Bun.sleep(300);
      expect(core!.db.listBacklogRecords(core!.db.getWorkspaceBacklogSource(metaId())!, "pull-request").some((r) => (r.remote as { number?: number }).number === 900)).toBe(true);
      expect(claude.starts).toHaveLength(1);
      expect(implementing307()).toHaveLength(1);
    }
  });
});

test("backlog-next waiting: a wait GitHub did not find is not taken as closed, and the log says it was not read", async () => {
  const claude = holdingClaude();
  const states = { w603: { __typename: "Issue", state: "CLOSED" }, w999: null };
  const fake = waitsGh({ i307: [[releaseBody("後回し", [603, 999]), STOPPED]] }, states, undefined, [{ type: "NOT_FOUND", path: ["repository", "w999"], message: "not found" }]);
  const base = await boot(fake.gh, claude.adapter);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#307 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められない: #307（#999 見つからない）`));
});

test("backlog-next waiting: resumes a Ready PBI with a free Task", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({ i304: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const task = (number: number, file: string) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: `触る場所: \`${file}\``, comments: { nodes: [] } });
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [task(3041, "src/a.ts"), task(3042, "src/b.ts")] } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(gh, claude.adapter);
  expect(await waitsOfItem(base, 304)).toMatchObject({ stage: "ready", overlap: null, waits: [{ number: 778, state: "met" }] });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#304 を complete で開始"));
});

test("backlog-next waiting: a 状況確認 started after the waits were written leaves them; once they closed the next firing starts 実装", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  // the row's 状況を確認 only reads and reports: it does not claim, and the waits stand
  core!.db.insertTask({ id: "tsk_check", workspaceId: metaId(), title: "#307 状況確認: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 状況確認: PBI: 実装中の PBI"), statusAt: Date.parse(LATER), createdAt: Date.parse(LATER), updatedAt: Date.now() });
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [{ number: 778, open: false }], waitsAt: STOPPED });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#307 実装");
});

test("backlog-next waiting: a 状況確認 after an 実装 that made the waits old does not bring them back", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const task = (id: string, title: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title, runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage(title), statusAt: at, createdAt: at, updatedAt: Date.now() });
  // the resumed 実装 failed before it claimed, then the row's 状況を確認 ran: the newest stage Task is the check
  task("tsk_impl", "#307 実装: PBI: 実装中の PBI", Date.parse(LATER), "error");
  task("tsk_check", "#307 状況確認: PBI: 実装中の PBI", Date.parse(LATER) + 60_000, "done");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "))).toHaveLength(1);
});

test("backlog-next waiting: a stage Task started after the waits were written makes them old — a resumed 実装 that failed before claiming is not started again", async () => {
  const fake = waitsGh({ i307: [[releaseBody("後回し", [778]), STOPPED]] }, { w778: { __typename: "PullRequest", state: "MERGED" } });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const task = (id: string, at: number, status: TaskStatus) => core!.db.insertTask({ id, workspaceId: metaId(), title: "#307 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 実装: PBI: 実装中の PBI"), statusAt: at, createdAt: at, updatedAt: Date.now() });
  // the 実装 that wrote the release started before it: the waits stand
  task("tsk_before", Date.parse(STOPPED) - 3_600_000, "done");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [{ number: 778, open: false }], waitsAt: STOPPED });
  // the resumed one started after it and failed before it claimed: the waits are old, shown nowhere, and nothing restarts it
  task("tsk_after", Date.parse(LATER), "error");
  expect(await waitsOfItem(base, 307)).toMatchObject({ waits: [], waitsAt: null });
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 実装: "))).toHaveLength(2);
});

describe("backlog-next prerequisite", () => {
  type Pbi = { status?: string; labels?: string[]; priority: string; body?: string; comments?: Array<[string, string]>; tasks?: Array<{ number: number; state: string; body?: string }> };
  /**
   * A GitHub of Ready PBIs (`pbis`, by number) and what they name (`others`: the answers to the import's recheck, by
   * `w<n>`; a number not there is NOT_FOUND), in the shape the fixtures' gh answers (`importing` reads it).
   */
  function prereqGh(pbis: Record<number, Pbi>, others: Record<string, unknown> = {}) {
    const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
    const gh: GhRunner = async (args) => {
      if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
      if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
      if (args[0] === "issue") return { code: 0, stdout: "", stderr: "" };
      const q = args.find((a) => a.startsWith("query=")) ?? "";
      const open = Object.entries(pbis).map(([n, p]) => [Number(n), p] as const);
      if (q.includes("comments(last:"))
        return answer({ repository: Object.fromEntries(open.map(([n, p]) => [`i${n}`, { comments: { nodes: (p.comments ?? []).map(([body, createdAt]) => ({ body, createdAt })) }, subIssues: { nodes: (p.tasks ?? []).map((t) => ({ ...t, labels: { nodes: [{ name: "type:task" }] }, comments: { nodes: [] } })) } }])) });
      if (q.includes("issueOrPullRequest")) return answer({ repository: others });
      return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: open.map(([n, p]) => ({
        number: n, title: `PBI ${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", body: p.body ?? "", createdAt: `2026-09-01T00:00:${String(n % 60).padStart(2, "0")}Z`, updatedAt: "2026-09-10T00:00:00Z",
        labels: { nodes: ["type:pbi", ...(p.labels ?? [])].map((name) => ({ name })) }, subIssuesSummary: { total: p.tasks?.length ?? 0, completed: (p.tasks ?? []).filter((t) => t.state === "CLOSED").length, doneAt: null },
        projectItems: { nodes: [{ project: { number: 11 }, fieldValues: { nodes: [{ name: p.status ?? "Ready", field: { name: "Status" } }, { name: p.priority, field: { name: "Priority" } }] } }] },
      })) } } });
    };
    return gh;
  }
  const closedIssue = (stateReason: string) => ({ __typename: "Issue", state: "CLOSED", stateReason, labels: { nodes: [{ name: "type:pbi" }] } });
  const slots = (base: string, implement: number) => sweepAll(base, { implement, plan: 0 });
  const implementing = (n: number) => core!.db.listTasks().filter((t) => t.title.startsWith(`#${n} 実装: `));

  test("A→B and independent C: B and C start, A is logged as waiting on B; once B is done the next firing starts A once", async () => {
    const pbis: Record<number, Pbi> = { 401: { priority: "P0", body: "**前提**: #402" }, 402: { priority: "P1" }, 403: { priority: "P2" } };
    const others: Record<string, unknown> = {};
    const base = await boot(prereqGh(pbis, others), holdingClaude().adapter);
    expect((await slots(base, 2)).status).toBe(200);
    const id = await backlogNextSchedule(base);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#402 実装", "#403 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #401（#402 未完）`));
    // B is closed as completed: the next import reads it again, and A goes
    delete pbis[402];
    others.w402 = closedIssue("COMPLETED");
    await fetch(`${base}/api/backlog?refresh=1`); // this GitHub lists open Issues only: a light import would not see it close
    await slots(base, 3);
    expect((await runSchedule(base, id)).status).toBe(201);
    expect(implementing(401)).toHaveLength(1);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#401 を complete で開始"));
  });

  test("fires twice, restart: A is started once — not again while it runs, after it ended, or after the daemon restarted", async () => {
    const claude = holdingClaude();
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #402" } }, { w402: closedIssue("COMPLETED") });
    const base = await boot(gh, claude.adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    await runSchedule(base, id);
    expect(implementing(401)).toHaveLength(1);
    for (const t of core!.db.listTasksByStatus("running")) core!.db.updateTask(t.id, { status: "done" });
    await runSchedule(base, id);
    expect(implementing(401)).toHaveLength(1);
    // the same home again: what ran is read from the database
    for (const t of core!.db.listTasks()) core!.db.updateTask(t.id, { status: "running" });
    await core!.stop();
    const cfg = loadConfig({ SWITCHBOARD_HOME: home!, SWITCHBOARD_KNOWLEDGE: join(home!, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home!, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
    core = await startServer(cfg, [claude.adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh), backlogAutoImport: true });
    const again = `http://127.0.0.1:${core.server.port}`;
    await refreshed(again, false);
    await runSchedule(again, id);
    expect(implementing(401)).toHaveLength(1);
  });

  test("button and firing: while the row's button starts A, a firing does not start it too", async () => {
    const base = await boot(prereqGh({ 401: { priority: "P0", body: "**前提**: #402" } }, { w402: closedIssue("COMPLETED") }), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    const [button] = await Promise.all([start(base, 401, { action: "complete" }), runSchedule(base, id)]);
    expect([201, 409]).toContain(button.status);
    expect(implementing(401)).toHaveLength(1);
  });

  test("release: a merged prerequisite not in the running release waits, starts once it is; without sb-rescue it cannot be told", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
    withProcesses(repo);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "running");
    const running = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "the prerequisite (#450)");
    const merged = git("rev-parse", "HEAD");
    let current = running;
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/status" ? Response.json({ current, previous: null, state: "running", busy: null, lastError: null, history: [] }) : new Response("no", { status: 404 })) });
    // Issue 451's merge commit is not in this checkout: git cannot tell, which is not "not released"
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #450（リリース）" }, 402: { priority: "P1", body: "**前提**: #451（リリース）" } }, {
      w450: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: merged } },
      w451: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: "0".repeat(40) } },
    });
    try {
      const base = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
      const id = await backlogNextSchedule(base);
      await runSchedule(base, id);
      expect(implementing(401)).toHaveLength(0);
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #401（PR #450 リリース待ち）`));
      expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 進められない: #402（PR #451 の反映を確かめられない）`));
      expect((await refreshed(base, false)).items.find((i) => i.number === 401)!.prereqs).toEqual([{ number: 450, kind: "pr", need: "release", state: "pending", via: [], confirming: false }]);
      // what runs is not in this checkout: git cannot tell, which is not "not released"
      current = "f".repeat(40);
      await runSchedule(base, id);
      expect((await scheduleLogAll(base)).some((l) => l.includes("進められない: ") && l.includes("#401（PR #450 の反映を確かめられない）"))).toBe(true);
      current = merged;
      await runSchedule(base, id);
      expect(implementing(401)).toHaveLength(1);
      await core!.stop(); core = undefined; rmSync(home!, { recursive: true, force: true });
      // not under sb-rescue: nothing tells what runs
      const alone = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo });
      await runSchedule(alone, await backlogNextSchedule(alone));
      expect(implementing(401)).toHaveLength(0);
      expect((await scheduleLogAll(alone)).find((l) => l.includes("進められない:"))).toContain("#401（PR #450 の反映を確かめられない）");
    } finally {
      rescue.stop(true);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("GET /api/backlog reads each workspace's stored records once when the release's answers are known", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sb-backlog-repo-"));
    withProcesses(repo);
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]).stdout.toString().trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "running");
    git("commit", "-q", "--allow-empty", "-m", "the prerequisite (#450)");
    const merged = git("rev-parse", "HEAD");
    const rescue = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/status" ? Response.json({ current: merged, previous: null, state: "running", busy: null, lastError: null, history: [] }) : new Response("no", { status: 404 })) });
    const gh = prereqGh({ 401: { priority: "P0", body: "**前提**: #450（リリース）" } }, { w450: { __typename: "PullRequest", state: "MERGED", mergeCommit: { oid: merged } } });
    try {
      const base = await boot(gh, holdingClaude().adapter, { SWITCHBOARD_REPO_ROOT: repo, SWITCHBOARD_RESCUE_URL: `http://127.0.0.1:${rescue.port}` });
      const source = core!.db.getWorkspaceBacklogSource(metaId())!;
      const issueReads = () => spy.mock.calls.filter(([s, kind]) => kind === "issue" && s.repository === source.repository).length;
      const get = async () => ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === 401)!;
      const original = core!.db.listBacklogRecords.bind(core!.db);
      const spy = spyOn(core!.db, "listBacklogRecords").mockImplementation(original);
      const first = await get(); // the merge commit's answer is asked of git and kept
      expect(first.prereqs).toEqual([{ number: 450, kind: "pr", need: "release", state: "met", via: [], confirming: false }]);
      const reads = issueReads();
      await get();
      // the answer is known now: no read to find what to ask. 3 = the one full read + the two the stage Tasks' rows (withActive) make; a read to find what to ask made it 4
      expect(issueReads() - reads).toBe(3);
      spy.mockRestore();
    } finally {
      rescue.stop(true);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("withdrawn / missing / cycle: each is logged as 進められない, and the independent Ready starts", async () => {
    const pbis: Record<number, Pbi> = {
      401: { priority: "P0", body: "**前提**: #402" }, 404: { priority: "P0", body: "**前提**: #499" },
      405: { priority: "P0", body: "**前提**: #406" }, 406: { priority: "P0", body: "**前提**: #405" }, 403: { priority: "P3" },
    };
    const base = await boot(prereqGh(pbis, { w402: closedIssue("NOT_PLANNED") }), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#403 実装"]);
    const line = (await scheduleLogAll(base)).find((l) => l.includes("進められない:"))!;
    for (const part of ["#404（#499 見つからない）", "#405（#406 と循環）", "#406（#405 と循環）"]) expect(line).toContain(part);
    // the withdrawn one is asked about instead (the next test)
    expect(line).not.toContain("#401");
  });

  test("a withdrawn prerequisite asks once: the firing and the queue write one ## 判断待ち, and the PBI is a question, not a 進められない line", async () => {
    const base = await boot(prereqGh({ 401: { priority: "P0", body: "**前提**: #402" }, 403: { priority: "P3" } }, { w402: closedIssue("NOT_PLANNED") }), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    const asked = () => core!.db.listBacklogOperations(core!.db.getWorkspaceBacklogSource(metaId())!).filter((o) => o.kind === "comment" && String((o.payload as { body?: unknown }).body).startsWith("## 判断待ち"));
    const labelled = () => core!.db.listBacklogOperations(core!.db.getWorkspaceBacklogSource(metaId())!).filter((o) => o.kind === "set" && o.field === "label:needs-decision" && o.payload === true);
    expect(asked()).toHaveLength(1);
    expect(labelled()).toHaveLength(1);
    const body = String((asked()[0]!.payload as { body: string }).body);
    expect(body).toContain("**問い**: 前提 #402 は取り下げられた");
    expect(body).toContain("**進め方**: 止めて待つ");
    expect(body).toContain("<!-- prereq-withdrawn:402 -->");
    const log = await scheduleLogAll(base);
    expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 取り下げた前提を判断待ちにした: #401`));
    expect(log.some((l) => l.includes("進められない:") && l.includes("#401"))).toBe(false);
    // it is the person's question now
    const asks = (await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; kind: string; state: string; pbi: { number: number } | null }> };
    expect(asks.asks.filter((a) => a.pbi?.number === 401).map((a) => [a.kind, a.state])).toEqual([["decision", "open"]]);
    // a second firing and the queue write nothing more
    await runSchedule(base, id);
    await putQueue(base, { items: [{ workspaceId: metaId(), number: 401 }], enabled: true });
    await until(async () => (await getQueue(base)).lastNote !== null);
    const note = (await getQueue(base)).lastNote!;
    expect(note).toContain("まだ Ready でない: #401（判断待ち）");
    expect(note).not.toContain("進められない");
    expect(asked()).toHaveLength(1);
    expect(labelled()).toHaveLength(1);
    // what is kept to send to GitHub is that one comment and the label, for `#401` only
    expect(core!.db.listPendingBacklogOperations().map((o) => [o.kind, o.field])).toEqual([["comment", null], ["set", "label:needs-decision"]]);
  });

  /** A PBI left in review: its Tasks as given, its criteria the given lines (checked ones first). */
  const reviewing = (lines: string[], tasks: string[]): Pbi => ({
    status: "In review", priority: "P3", body: `## 到達点 / 受け入れ条件\n${lines.join("\n")}\n`,
    tasks: tasks.map((state, n) => ({ number: 480 + n, state })),
  });
  const mine = "- [ ] 2. Mac で動く（利用者確認: 手で確かめる）";

  test("a prerequisite left with only the person's checks is met", async () => {
    const pbis: Record<number, Pbi> = { 401: { priority: "P0", body: "**前提**: #402" }, 402: reviewing(["- [x] 1. 実装した", mine], ["CLOSED", "CLOSED"]) };
    const base = await boot(prereqGh(pbis), holdingClaude().adapter);
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(implementing(401)).toHaveLength(1);
    expect((await refreshed(base, false)).items.find((i) => i.number === 401)!.prereqs).toEqual([{ number: 402, kind: "issue", need: "done", state: "met", via: [], confirming: true }]);
  });

  const kept: Record<string, Pbi> = {
    "a plain unchecked line": reviewing(["- [ ] 1. 実装する", mine], ["CLOSED"]),
    "an open Task": reviewing(["- [x] 1. 実装した", mine], ["CLOSED", "OPEN"]),
    "needs-decision": { ...reviewing(["- [x] 1. 実装した", mine], ["CLOSED"]), labels: ["needs-decision"] },
    "no unchecked line": reviewing(["- [x] 1. 実装した"], ["CLOSED"]),
  };
  for (const [name, p] of Object.entries(kept)) {
    test(`an unchecked line that is not the person's keeps the prerequisite pending: ${name}`, async () => {
      const base = await boot(prereqGh({ 401: { priority: "P0", body: "**前提**: #402" }, 402: p }), holdingClaude().adapter);
      await runSchedule(base, await backlogNextSchedule(base));
      expect(implementing(401)).toHaveLength(0);
      expect((await refreshed(base, false)).items.find((i) => i.number === 401)!.prereqs).toEqual([{ number: 402, kind: "issue", need: "done", state: "pending", via: [], confirming: false }]);
    });
  }

  test("a prerequisite left with only the person's checks is met: on-hold does not change it", async () => {
    const held: Pbi = { ...reviewing(["- [x] 1. 実装した", mine], ["CLOSED"]), labels: ["on-hold"] };
    const base = await boot(prereqGh({ 401: { priority: "P0", body: "**前提**: #402" }, 402: held }), holdingClaude().adapter);
    await runSchedule(base, await backlogNextSchedule(base));
    expect(implementing(401)).toHaveLength(1);
    expect((await refreshed(base, false)).items.find((i) => i.number === 401)!.prereqs).toEqual([{ number: 402, kind: "issue", need: "done", state: "met", via: [], confirming: true }]);
  });

  test("a PBI waiting only on a Draft PR's overlap goes on, while one with a prerequisite not done does not", async () => {
    const pbis: Record<number, Pbi> = {
      407: { priority: "P1", comments: [[releaseBody("後回し", [460], true), STOPPED]] },
      408: { priority: "P0", body: "**前提**: #409" }, 409: { status: "Backlog", priority: "P3" },
    };
    const base = await boot(prereqGh(pbis, { w460: { __typename: "PullRequest", state: "OPEN", isDraft: true } }), holdingClaude().adapter);
    await slots(base, 1); // Issue 409 is not Ready: the plan slot would take it
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toEqual(["#407 実装"]);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 前提: #408（#409 未完）`));
  });
});

describe("backlog waitsUntil", () => {
  const AT = "2026-11-20T09:00:00+09:00";
  const T = Date.parse(AT);
  /** The item Issue 307 (in progress) as the daemon builds it at `now`; time is set only while the backlog is built. */
  const at = async (base: string, now: number) => {
    setSystemTime(new Date(now));
    try { return await waitsOfItem(base, 307); } finally { setSystemTime(); }
  };

  test("a release with only after= waits: before the date it is a wait, at the date and after it is a resumption target", async () => {
    const fake = waitsGh({ i307: [[releaseBody("期日待ち", [], false, AT), STOPPED]] });
    const base = await boot(fake.gh);
    const before = await at(base, T - 1);
    expect(before).toMatchObject({ waits: [], waitsAt: STOPPED, waitsUntil: { at: AT, met: false } });
    expect(pickNext([before], "implement")).toBeNull();
    expect(isUnblocked(before)).toBe(false);
    expect(heldIn([before], "implement")).toHaveLength(1);
    for (const now of [T, T + 1]) {
      const due = await at(base, now);
      expect(due.waitsUntil).toEqual({ at: AT, met: true });
      expect(isUnblocked(due)).toBe(true);
      expect(heldIn([due], "implement")).toHaveLength(0);
    }
  });

  test("waits= with after=: it resumes only once both are done", async () => {
    const states = { w603: { __typename: "Issue", state: "OPEN" } };
    const fake = waitsGh({ i307: [[releaseBody("両方待ち", [603], false, AT), STOPPED]] }, states);
    const base = await boot(fake.gh);
    expect(isUnblocked(await at(base, T - 1))).toBe(false);
    const after = await at(base, T + 1);
    expect(after.waitsUntil!.met).toBe(true);
    expect(after.waits).toEqual([wait(603, "issue", true)]);
    expect(isUnblocked(after)).toBe(false);
    states.w603.state = "CLOSED";
    const both = (await (async () => { setSystemTime(new Date(T + 1)); try { return await refreshed(base); } finally { setSystemTime(); } })()).items.find((i) => i.number === 307)!;
    expect(isUnblocked(both)).toBe(true);
  });

  test("a date that is no time with a zone is no wait; a later release without it clears it", () => {
    const c = (body: string) => [{ body, createdAt: STOPPED }];
    expect(waitsOf(c("<!-- pbi-complete:release after=2026-11-20T09:00:00 -->"))).toBeNull();
    expect(waitsOf(c("<!-- pbi-complete:release after=あした -->"))).toBeNull();
    expect(waitsOf(c(releaseBody("x", [], false, AT)))).toEqual({ numbers: [], at: STOPPED, overlap: false, after: AT });
    expect(waitsOf(c(releaseBody("x", [5], true, AT)))).toEqual({ numbers: [5], at: STOPPED, overlap: true, after: AT });
    expect(waitsOf([...c(releaseBody("x", [], false, AT)), { body: releaseBody("完了"), createdAt: LATER }])).toBeNull();
  });

  test("withOverlap: an In progress Task of a PBI that waits for a date is not the other work; once the date has passed it is", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.t4618."));
    mkdirSync(join(root, "src"));
    try {
      const now = new Date().toISOString();
      const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
      const issues = new Map([
        [1, issue(1, ["type:pbi"], null, [11], "")],
        [11, issue(11, ["type:task"], 1, [], "触る場所: `src/a.ts`")],
        [2, issue(2, ["type:pbi"], null, [22], "")],
        [22, issue(22, ["type:task"], 2, [], "触る場所: `src/a.ts`")],
      ]);
      const statuses = new Map<number, string | number | null>([[22, "In progress"]]);
      const run = (until: BacklogItem["waitsUntil"]) => {
        const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress", waitsAt: STOPPED, waitsUntil: until })];
        withOverlap(items, issues, new Map(), [], statuses, root);
        return items[0]!.overlap;
      };
      expect(run({ at: AT, met: true })).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts", working: false }], unknown: null });
      expect(run(null)).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts", working: false }], unknown: null });
      expect(run({ at: AT, met: false })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("overlap by holder: counts the PBIs each holder stops, most first, and says whether it is at work", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.holder."));
    mkdirSync(join(root, "src"));
    try {
      const now = new Date().toISOString();
      const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
      const issues = new Map([
        [3000, issue(3000, ["type:pbi"], null, [3007], "")],
        [3007, issue(3007, ["type:task"], 3000, [], "触る場所: `src/a.ts`")],
        ...[1, 2, 3].flatMap((k) => [[k, issue(k, ["type:pbi"], null, [k * 10], "")], [k * 10, issue(k * 10, ["type:task"], k, [], "触る場所: `src/a.ts`")]] as const),
        [4, issue(4, ["type:pbi"], null, [40], "")],
        [40, issue(40, ["type:task"], 4, [], "触る場所: `src/b.ts`")],
      ]);
      const statuses = new Map<number, string | number | null>([[3007, "In progress"]]);
      const pr = { number: 900, isDraft: false, labels: [], closes: [], updatedAt: now, files: ["src/b.ts"], state: "OPEN" };
      const items = [1, 2, 3, 4].map((n) => item({ number: n, stage: "ready" }));
      items.push(item({ number: 3000, stage: "in-progress" }));
      withOverlap(items, issues, new Map(), [pr], statuses, root, { active: () => false });
      expect(overlapHolderLines(items)).toEqual(["Task #3007 が 3 件を止めている（作業していない）", "PR #900 が 1 件を止めている（作業中）"]);
      // the re-read after the starts swaps these lines with the 重なり ones, and no others
      expect(overlapHolderLines(items).every(isOverlapLine)).toBe(true);
      expect(overlapLine(items.filter(isOverlapped)).every(isOverlapLine)).toBe(true);
      expect(isOverlapLine("保留: #1")).toBe(false);
      // the first read's holder count (2) is swapped for the reread's (3); the other lines and other workspaces' stay
      const log = ["app: 実装の枠: 保留: #9", "app: 実装の枠: Task #3007 が 2 件を止めている（作業していない）", "app: 実装の枠: 重なり: #1（Task #3007: src/a.ts）", "other: 実装の枠: 重なり: #5（PR #7: x.ts）"];
      swapOverlapLines(log, "app: 実装の枠: ", ["保留: #9", ...overlapHolderLines(items), ...overlapLine(items.filter(isOverlapped))]);
      expect(log.slice(0, 2)).toEqual(["app: 実装の枠: 保留: #9", "other: 実装の枠: 重なり: #5（PR #7: x.ts）"]);
      expect(log.slice(2, 4)).toEqual(["app: 実装の枠: Task #3007 が 3 件を止めている（作業していない）", "app: 実装の枠: PR #900 が 1 件を止めている（作業中）"]);
      expect(log.filter((l) => l.includes("2 件"))).toEqual([]);
      // the PBI's stage Task runs: the same Task is at work
      const again = [1, 2, 3, 4].map((n) => item({ number: n, stage: "ready" }));
      again.push(item({ number: 3000, stage: "in-progress" }));
      withOverlap(again, issues, new Map(), [pr], statuses, root, { active: (n) => n === 3000 });
      expect(overlapHolderLines(again)[0]).toBe("Task #3007 が 3 件を止めている（作業中）");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("withOverlap: another PBI's Task with a ready PR is judged by the PR's files; a glob or a command in its body is not a path", () => {
    const root = mkdtempSync(join(tmpdir(), "switchboard.overlap-pr."));
    mkdirSync(join(root, "src"));
    try {
      const now = new Date().toISOString();
      const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
      const issues = new Map([
        [1, issue(1, ["type:pbi"], null, [11], "")],
        [11, issue(11, ["type:task"], 1, [], "触る場所: `src/a.ts`、`src/b.ts`")],
        [2, issue(2, ["type:pbi"], null, [22, 23], "")],
        [22, issue(22, ["type:task"], 2, [], "触る場所: `src/a.ts`、`src/c.ts`")],
        [23, issue(23, ["type:task"], 2, [], "触る場所: `src/d.ts`。探し方: `grep -n x src/*.ts`、確認: `bun test src/b.ts`")],
      ]);
      const statuses = new Map<number, string | number | null>([[22, "In progress"], [23, "In progress"]]);
      const pr = (isDraft: boolean) => ({ number: 90, isDraft, labels: [], closes: [22], updatedAt: now, files: ["src/c.ts"], state: "OPEN" });
      const run = (isDraft: boolean) => {
        const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
        withOverlap(items, issues, new Map(), [pr(isDraft)], statuses, root);
        return items[0]!.overlap;
      };
      expect(run(false)).toBeNull();
      expect(run(true)).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts", working: false }], unknown: null });
      // a ready PR and a stacked Draft: the body still holds what the Draft carries
      const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(items, issues, new Map(), [pr(false), { ...pr(true), number: 91 }], statuses, root);
      expect(items[0]!.overlap).toEqual({ hits: [{ ref: "Task #22", path: "src/a.ts", working: false }], unknown: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("prereqsOf: the first **前提** line outside fences, its numbers once each and （リリース） after one", () => {
  expect(prereqsOf("## 背景\nx\n\n**前提**: #12, #34（リリース）\n**Story Points**: 3")).toEqual([{ number: 12, release: false }, { number: 34, release: true }]);
  expect(prereqsOf("**前提**: なし")).toEqual([]);
  expect(prereqsOf("**前提**: #7, #7（リリース）, #7\r\n")).toEqual([{ number: 7, release: true }]);
  // inside a fence, a second line, free text and the 依存関係 section are not read
  expect(prereqsOf("```\n**前提**: #1\n```\n**前提**: #2\n**前提**: #3")).toEqual([{ number: 2, release: false }]);
  expect(prereqsOf("前提: #9 が Done\n## 依存関係\n#10 の後")).toEqual([]);
  expect(prereqsOf("")).toEqual([]);
});

test("prereqState: Issues, pull requests and releases by how they closed; not stored is missing", () => {
  const issue = (state: string, stateReason: string | null = null): WaitTarget => ({ kind: "issue", state, isDraft: false, labels: [], closes: [], stateReason, mergeCommit: null, confirmOnly: false });
  const pr = (state: string, more: Partial<WaitTarget> = {}): WaitTarget => ({ kind: "pr", state, isDraft: false, labels: [], closes: [], stateReason: null, mergeCommit: state === "MERGED" ? "m1" : null, confirmOnly: false, ...more });
  const none = () => null;
  expect(prereqState(issue("OPEN"), "done", none)).toBe("pending");
  expect(prereqState(issue("CLOSED", "COMPLETED"), "done", none)).toBe("met");
  expect(prereqState(issue("CLOSED"), "done", none)).toBe("met"); // closed before the reason was read
  expect(prereqState(issue("CLOSED", "NOT_PLANNED"), "done", none)).toBe("withdrawn");
  expect(prereqState(issue("CLOSED", "DUPLICATE"), "done", none)).toBe("withdrawn");
  expect(prereqState(issue("CLOSED", "COMPLETED"), "release", () => true)).toBe("unknown"); // an Issue has no merge commit
  expect(prereqState(pr("OPEN"), "merged", none)).toBe("pending");
  expect(prereqState(pr("OPEN", { isDraft: true }), "merged", none)).toBe("pending");
  expect(prereqState(pr("MERGED"), "merged", none)).toBe("met");
  expect(prereqState(pr("CLOSED"), "merged", none)).toBe("withdrawn");
  expect(prereqState(pr("MERGED"), "release", (oid) => oid === "m1")).toBe("met");
  expect(prereqState(pr("MERGED"), "release", () => false)).toBe("pending");
  expect(prereqState(pr("MERGED"), "release", none)).toBe("unknown");
  expect(prereqState(pr("MERGED", { mergeCommit: null }), "release", () => true)).toBe("unknown");
  expect(prereqState(undefined, "done", none)).toBe("missing");
});
