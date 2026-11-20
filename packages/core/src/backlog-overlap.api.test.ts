// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogItem } from "@switchboard/protocol";
import { type CoreServer } from "./server.ts";
import { buildStartPrompt } from "./backlog-prompt.ts";
import { pickNext } from "./backlog-pick.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { withOverlap, overlapHolderLines, overlapLine, isOverlapLine } from "./backlog-overlap.ts";
import { judge as guardJudge } from "../../../scripts/parallel-guard.ts";
import { overlapTurnOf } from "./backlog-overlap.ts";
import { backlogNextSchedule, boot, closeTried, holdingClaude, item, metaId, metaName, overlapReadyGh, refreshed, releaseBody, runSchedule, scheduleLogAll, start, startedTasks, sweepAll, threeWorkspaces, useBacklogDaemon, waitsGh, waitsOfItem } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("backlog-next overlap: a Ready PBI whose Task names a file an open PR changes is not started and the log names the PR; once it closes the next firing starts it; nothing is written to GitHub", async () => {
  const claude = holdingClaude();
  const fake = waitsGh({}, {}, undefined);
  const withTask: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    const q = args.find((a) => a.startsWith("query="));
    if (!q?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [3041, 3042].map((number) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: "触る場所: `src/a.ts`", comments: { nodes: [] } })) } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  const writes: string[][] = [];
  const calls: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    calls.push(args.find((a) => a.startsWith("query=")) ?? args.join(" "));
    if (args[0] === "issue" || args.includes("POST") || args.includes("PATCH")) writes.push(args);
    return withTask(args, cwd);
  };
  // Issue 901's files are cut (120 of 100 read): it cannot be judged, and the log says so next to the PR that overlaps
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }, { number: 901, files: [], filesTotal: 120, headRefName: "sb/998-x" }];
  const base = await boot(gh, claude.adapter);
  expect((await waitsOfItem(base, 304)).overlap).toEqual({ hits: [{ ref: "PR #900", path: "src/a.ts", working: true }], unknown: "PR #901 の変更ファイルが記録に無い" });
  const id = await backlogNextSchedule(base);
  const before = calls.length;
  expect((await runSchedule(base, id)).status).toBe(201);
  // deciding reads no PR / Issue list from GitHub
  expect(calls.slice(before).filter((q) => q.includes("pullRequests(") || q.includes("issues(first"))).toEqual([]);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なり: #304（PR #900: src/a.ts）`));
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なりを判定できない: #304（PR #901 の変更ファイルが記録に無い）`));
  expect(writes).toEqual([]);
  // the PR closes: the next import reads it and Issue 304 is picked again (the implement slot is Issue 307's 閉じる meanwhile)
  openPulls = [];
  await fetch(`${base}/api/backlog?refresh=1`);
  const ready = (await refreshed(base)).items.find((i) => i.number === 304)!;
  expect(ready.overlap).toBeNull();
  expect(pickNext([ready], "implement")).toMatchObject({ item: { number: 304 }, action: "complete" });
});

/** waitsGh whose Ready PBI 304 has one open Task per file given. */
function tasksOf304Gh(...files: string[]): GhRunner {
  const fake = waitsGh({}, {});
  return async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: files.map((f, n) => ({ number: 3041 + n, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: `触る場所: \`${f}\``, comments: { nodes: [] } })) } };
    return { ...r, stdout: JSON.stringify(body) };
  };
}

test("start overlap: the row's 実装 of a Ready PBI whose Task names a file an open PR changes is 409 with the log's reason and starts no Task; to-tasks and a PBI with no overlap start", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/a.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap).toEqual({ hits: [{ ref: "PR #900", path: "src/a.ts", working: true }], unknown: null });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  const { error } = (await r.json()) as { error: string };
  expect(error.startsWith("重なり: #304（")).toBe(true);
  expect(error).toContain("PR #900: src/a.ts");
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).not.toContain("#304 実装");
  // the other stages are not the overlap's: to-tasks starts
  expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
  // no overlap: another PBI's 実装 starts
  openPulls = [];
  await fetch(`${base}/api/backlog?refresh=1`);
  expect((await refreshed(base)).items.find((i) => i.number === 304)!.overlap).toBeNull();
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
});

test("start overlap: a PBI with one Task that can start (a file no open PR changes) starts from the row even while another Task's file overlaps", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/b.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap).toBeNull();
  expect((await start(base, 304, { action: "complete" })).status).toBe(201);
});

test("start overlap: a PBI whose 実装 already runs answers 409 with that Task's id (the row opens it), not the overlap refusal", async () => {
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(tasksOf304Gh("src/a.ts", "src/a.ts"), holdingClaude().adapter);
  expect((await waitsOfItem(base, 304)).overlap?.hits).toEqual([{ ref: "PR #900", path: "src/a.ts", working: true }]);
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_run304", workspaceId: metaId(), title: "#304 実装: PBI: Ready の PBI", runner: "claude", cwd: home!, scope: [home!], status: "running", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 304, action: "complete" }, statusAt: now, createdAt: now, updatedAt: now });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.json()).toMatchObject({ taskId: "tsk_run304" });
});

test("backlog-next overlap: in one firing of implement 2, a Ready PBI whose Task names the path of the PBI started before it is not started, and the log names that Task and the path; the one with another path is", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#310 実装"]);
  const log = await scheduleLogAll(base);
  expect(log).toContainEqual(expect.stringContaining(`${metaName()}: 実装の枠: 重なり: #309（Task #3041: src/a.ts）`));
  expect(log.filter((l) => l.includes("実装の枠: 重なり: "))).toHaveLength(1);
});

test("backlog-next overlap: two workspaces with the same name: a start in one keeps the other's overlap line", async () => {
  const { base, ids } = await threeWorkspaces(holdingClaude().adapter, undefined, overlapReadyGh({ 304: "src/a.ts", 309: "src/a.ts", 310: "src/c.ts" }));
  closeTried(...Object.values(ids));
  const patch = (ws: string, sweep: unknown) => fetch(`${base}/api/workspaces/${ws}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep }) });
  expect((await patch(metaId(), { implement: 0, plan: 0 })).status).toBe(200);
  for (const ws of [ids.lib!, ids.app!]) expect((await patch(ws, { implement: 2, plan: 0 })).status).toBe(200);
  // the names are not unique: both workspaces are called twin
  for (const ws of [ids.lib!, ids.app!]) core!.db["sqlite"].query("UPDATE workspaces SET name = 'twin' WHERE id = ?").run(ws);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  // each workspace started 304 and 310 (309 names 304's file)
  expect(startedTasks().map((t) => `${t.workspaceId === ids.lib ? "lib" : "app"}${t.title.split(":")[0]}`).sort()).toEqual(["app#304 実装", "app#310 実装", "lib#304 実装", "lib#310 実装"]);
  // each said its own 重なり line after its starts; the second's reread did not take the first's out
  expect((await scheduleLogAll(base)).filter((l) => l.includes("twin: 実装の枠: 重なり: #309（Task #3041: src/a.ts）"))).toHaveLength(2);
});

test("backlog-next overlap: Ready PBIs whose Tasks name different paths all start in one firing", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]); // implement 2: two places
  expect((await scheduleLogAll(base)).some((l) => l.includes("重なり"))).toBe(false);
});

test("backlog-next overlap: a Task that only refers to a root file in the middle of a step does not hold back the PBI that touches it", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }, { 304: "1. 昇格は CLAUDE.md の規則に従う。`CLAUDE.md` も読む", 309: "触る場所: CLAUDE.md" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#309 実装"]);
  expect((await scheduleLogAll(base)).some((l) => l.includes("重なり"))).toBe(false);
});

test("backlog-next overlap: a Task that names a root file at the head of a step holds back the PBI that touches it, and the log names the file", async () => {
  const base = await boot(overlapReadyGh({ 304: "src/a.ts", 309: "src/b.ts", 310: "src/c.ts" }, { 304: "1. CLAUDE.md: 追記する", 309: "触る場所: CLAUDE.md" }), holdingClaude().adapter);
  closeTried();
  expect((await sweepAll(base, { implement: 2, plan: 0 })).status).toBe(200);
  const id = await backlogNextSchedule(base);
  expect((await runSchedule(base, id)).status).toBe(201);
  expect(startedTasks().map((t) => t.title.split(":")[0]).sort()).toEqual(["#304 実装", "#310 実装"]);
  expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("実装の枠: 重なり: #309（Task #3041: CLAUDE.md）"));
});

/** The stored records of the overlap judgement's tests: PBIs with their Tasks, each Task's body naming what it touches. */
function overlapWorld(pbis: Record<number, Record<number, string>>) {
  const root = mkdtempSync(join(tmpdir(), "switchboard.overlap-world."));
  mkdirSync(join(root, "src"));
  const now = new Date().toISOString();
  const issue = (number: number, labels: string[], parent: number | null, subIssues: number[], body: string): BacklogIssueData => ({ number, title: `#${number}`, url: "u", state: "OPEN", stateReason: null, body, labels, milestone: null, parent, subIssues, createdAt: now, updatedAt: now, closedAt: null });
  const issues = new Map<number, BacklogIssueData>();
  for (const [pbi, tasks] of Object.entries(pbis)) {
    issues.set(Number(pbi), issue(Number(pbi), ["type:pbi"], null, Object.keys(tasks).map(Number), ""));
    for (const [task, paths] of Object.entries(tasks)) issues.set(Number(task), issue(Number(task), ["type:task"], Number(pbi), [], `触る場所: ${paths.split(" ").map((p) => `\`${p}\``).join("、")}`));
  }
  const pr = (number: number, closes: number[], files: string[], more: { isDraft?: boolean; state?: string } = {}) => ({ number, isDraft: false, labels: [], closes, updatedAt: now, files, state: "OPEN", ...more });
  return { root, issues, now, pr, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("overlap free tasks", () => {
  // the shape that stopped sessions: a Task in review with its PR counted as free, while the one left to start overlaps
  const world = () => overlapWorld({ 1: { 11: "src/x.ts", 12: "src/server.ts" }, 2: { 21: "src/server.ts" } });

  test("a Task in review with its own PR is not a free Task: the PBI overlaps on the one left to start, and a free unstarted Task lets it go", () => {
    const w = world();
    try {
      const statuses = new Map<number, string | number | null>([[11, "In review"], [21, "In progress"]]);
      const pulls = [w.pr(90, [11], ["src/x.ts"])];
      const items = [item({ number: 1, stage: "in-progress" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(items, w.issues, new Map([[1, [11, 12]]]), pulls, statuses, w.root);
      expect(items[0]!.overlap).toEqual({ hits: [{ ref: "Task #21", path: "src/server.ts", working: false }], unknown: null });
      expect(items[0]!.freeTasks).toBeUndefined();
      // one more Task, not started and touching nothing others touch
      w.issues.get(1)!.subIssues.push(13);
      w.issues.set(13, { ...w.issues.get(12)!, number: 13, body: "触る場所: `src/free.ts`" });
      const again = [item({ number: 1, stage: "in-progress" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(again, w.issues, new Map([[1, [11, 12, 13]]]), pulls, statuses, w.root);
      expect(again[0]!.overlap).toBeNull();
      expect(again[0]!.freeTasks).toEqual([13]);
    } finally {
      w.done();
    }
  });

  test("a PBI with only the review and the merge left (every open Task in review with a PR) is not held", () => {
    const w = overlapWorld({ 1: { 11: "src/server.ts" }, 2: { 21: "src/server.ts" } });
    try {
      const items = [item({ number: 1, stage: "in-progress" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(items, w.issues, new Map([[1, [11]]]), [w.pr(90, [11], ["src/server.ts"])], new Map<number, string | number | null>([[11, "In review"], [21, "In progress"]]), w.root);
      expect(items[0]!.overlap).toBeNull();
    } finally {
      w.done();
    }
  });

  test("a Task the app names free is a go for the guard's judge against the same other work", () => {
    const w = overlapWorld({ 1: { 11: "src/x.ts", 12: "src/server.ts", 13: "src/free.ts" }, 2: { 21: "src/server.ts" } });
    try {
      const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
      withOverlap(items, w.issues, new Map([[1, [12, 13]]]), [], new Map<number, string | number | null>([[21, "In progress"]]), w.root);
      expect(items[0]!.freeTasks).toEqual([13]);
      const others = [{ ref: "Task #21", task: 21, paths: ["src/server.ts"], updatedAt: w.now }];
      expect(guardJudge({ paths: ["src/free.ts"] }, others, new Date()).verdict).toBe("go");
      expect(guardJudge({ paths: ["src/server.ts"] }, others, new Date()).verdict).toBe("defer");
    } finally {
      w.done();
    }
  });

  test("free tasks line: the 実装 prompt names them; a resume, another stage and a PBI with none do not", () => {
    const line = "重ならないと判定した Task: #5, #7（アプリの判定。この Task から着手の判定にかける）。";
    expect(buildStartPrompt({ number: 1, freeTasks: [5, 7] }, "complete")).toContain(`${line}\n\n対象: #1。`);
    for (const p of [buildStartPrompt({ number: 1 }, "complete"), buildStartPrompt({ number: 1, freeTasks: [] }, "complete"), buildStartPrompt({ number: 1, freeTasks: [5, 7] }, "complete", { resume: { tasksDone: 0 } }), buildStartPrompt({ number: 1, freeTasks: [5, 7] }, "to-tasks")]) {
      expect(p).not.toContain("重ならないと判定した Task");
    }
  });
});

test("backlog-next overlap: two PBIs held by each other's idle In progress Task: one starts, then holds the other", () => {
  // each PBI has an In progress Task that nobody works on (no claim, no stage Task) and one to start that names the other's path
  const w = overlapWorld({ 1: { 11: "src/a.ts", 12: "src/b.ts" }, 2: { 21: "src/b.ts", 22: "src/a.ts" } });
  try {
    const statuses = new Map<number, string | number | null>([[11, "In progress"], [21, "In progress"]]);
    const startable = new Map([[1, [12]], [2, [22]]]);
    const read = (active: (n: number) => boolean) => {
      const items = [item({ number: 1, stage: "ready" }), item({ number: 2, stage: "ready" })];
      withOverlap(items, w.issues, startable, [], statuses, w.root, { active, commentsOf: () => [] });
      return items;
    };
    // the firing: neither is held, so the first in the queue starts
    const before = read(() => false);
    expect(before.map((i) => i.overlap)).toEqual([null, null]);
    expect(pickNext(before, "implement")).toMatchObject({ item: { number: 1 }, action: "complete" });
    // reread with its stage Task running: its Tasks are the other work, so the other PBI is held by the started one's Task
    const after = read((n) => n === 1);
    expect(after[0]!.overlap).toBeNull();
    expect(after[1]!.overlap).toEqual({ hits: [{ ref: "Task #11", path: "src/a.ts", working: true }], unknown: null });
    expect(pickNext(after.filter((i) => i.number !== 1), "implement")).toBeNull();
  } finally {
    w.done();
  }
});

describe("shared files", () => {
  test("an overlap only on a shared file does not hold the PBI; one on another file too does, and only that file is the hit", () => {
    const w = overlapWorld({ 1: { 11: "src/server.ts" }, 2: { 21: "src/server.ts src/asks.ts" }, 3: { 31: "src/server.ts src/asks.ts" } });
    try {
      const statuses = new Map<number, string | number | null>([[21, "In progress"]]);
      const run = (sharedFiles?: string[]) => {
        const items = [item({ number: 1, stage: "ready" }), item({ number: 3, stage: "ready" }), item({ number: 2, stage: "in-progress" })];
        withOverlap(items, w.issues, new Map([[1, [11]], [3, [31]]]), [], statuses, w.root, { sharedFiles });
        return items;
      };
      const shared = run(["src/server.ts"]);
      expect(shared[0]!.overlap).toBeNull();
      expect(shared[0]!.freeTasks).toEqual([11]);
      expect(shared[1]!.overlap).toEqual({ hits: [{ ref: "Task #21", path: "src/asks.ts", working: false }], unknown: null });
      // no list: every overlap holds, as before
      expect(run()[0]!.overlap).toEqual({ hits: [{ ref: "Task #21", path: "src/server.ts", working: false }], unknown: null });
    } finally {
      w.done();
    }
  });
});

describe("overlap turn", () => {
  const T0 = Date.now() - 3 * 3600_000;
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const mark = (body: string, min: number) => ({ body, createdAt: at(min) });

  test("a PBI that yielded holds a place from its first release with overlap=; a claim keeps it and a release without it ends it", () => {
    const yielded = [mark(releaseBody("重なり", [90], true), 0)];
    expect(overlapTurnOf(yielded)).toEqual({ since: at(0), waits: [90], last: at(0) });
    const again = [...yielded, mark("<!-- pbi-complete:claim tok -->", 10), mark(releaseBody("重なり", [91], true), 20)];
    expect(overlapTurnOf(again)).toEqual({ since: at(0), waits: [90, 91], last: at(20) });
    expect(overlapTurnOf([...again, mark("<!-- pbi-complete:claim tok2 -->", 30)])).toEqual({ since: at(0), waits: [90, 91], last: at(30) });
    expect(overlapTurnOf([...again, mark(releaseBody("完了"), 30)])).toBeNull();
    expect(overlapTurnOf([mark(releaseBody("前提待ち", [5]), 0)])).toBeNull();
  });

  // X (`#1`, PR 90 on src/a.ts) is what P (`#2`) yielded to; Y (`#3`) came later and names the same path; Z (`#4`) names another
  const world = () => overlapWorld({ 1: { 11: "src/a.ts" }, 2: { 21: "src/a.ts src/p.ts" }, 3: { 31: "src/a.ts" }, 4: { 41: "src/z.ts" } });
  const judgeAll = (w: ReturnType<typeof world>, opts: { xOpen: boolean; p?: Partial<BacklogItem>; comments?: Record<number, { body: string; createdAt: string }[]>; parked?: (n: number) => boolean; pClosed?: boolean }) => {
    const pulls = [w.pr(90, [11], ["src/a.ts"], { state: opts.xOpen ? "OPEN" : "MERGED" })];
    const comments = opts.comments ?? { 2: [mark(releaseBody("重なり", [90], true), 0)] };
    const items = [...(opts.pClosed ? [] : [item({ number: 2, stage: "ready", ...opts.p })]), item({ number: 3, stage: "ready" }), item({ number: 4, stage: "ready" })];
    const turns = withOverlap(items, w.issues, new Map([[2, [21]], [3, [31]], [4, [41]]]), pulls, new Map(), w.root, { commentsOf: (n) => comments[n] ?? [], parked: opts.parked });
    return { turns, of: (n: number) => items.find((i) => i.number === n)?.overlap ?? null };
  };
  const turnHit = { hits: [{ ref: "Task #21", path: "src/a.ts", working: false, turn: 2 }], unknown: null };

  test("the PBI that yielded holds the path it yielded on; the one that came later waits for it even once the first holder closed, and it starts itself", () => {
    const w = world();
    try {
      const open = judgeAll(w, { xOpen: true });
      expect(open.turns).toEqual([{ pbi: 2, since: at(0), task: 21, paths: ["src/a.ts"] }]);
      const closed = judgeAll(w, { xOpen: false });
      expect(closed.of(2)).toBeNull();
      expect(closed.of(3)).toEqual(turnHit);
      // only the path it yielded on is kept: a PBI on another path goes
      expect(closed.of(4)).toBeNull();
      expect(overlapLine([item({ number: 3, overlap: closed.of(3) })])).toEqual(["重なり: #3（順番待ち: #2（src/a.ts））"]);
      expect(overlapLine([item({ number: 3, overlap: closed.of(3) })]).every(isOverlapLine)).toBe(true);
      expect(overlapHolderLines([item({ number: 3, overlap: closed.of(3) })])).toEqual([]);
    } finally {
      w.done();
    }
  });

  test("the place is gone once the PBI is closed, released without an overlap, or its Task no longer names the path", () => {
    const w = world();
    try {
      expect(judgeAll(w, { xOpen: false, pClosed: true }).of(3)).toBeNull();
      expect(judgeAll(w, { xOpen: false, comments: { 2: [mark(releaseBody("重なり", [90], true), 0), mark(releaseBody("完了"), 5)] } }).of(3)).toBeNull();
      w.issues.set(21, { ...w.issues.get(21)!, body: "触る場所: `src/p.ts`" });
      expect(judgeAll(w, { xOpen: false }).turns).toEqual([]);
    } finally {
      w.done();
    }
  });

  test("a place whose PBI cannot move now is passed over, and counts again once it can; two places go in the order they yielded", () => {
    const w = world();
    try {
      const pending = { number: 9, kind: "issue" as const, need: "done" as const, state: "pending" as const, via: [], confirming: false };
      for (const p of [{ stage: "needs-decision" as const }, { onHold: true }, { waitsUntil: { at: at(600), met: false } }, { prereqs: [pending] }]) {
        expect(judgeAll(w, { xOpen: false, p }).of(3)).toBeNull();
      }
      expect(judgeAll(w, { xOpen: false, parked: (n) => n === 2 }).of(3)).toBeNull();
      // no mark for longer than the guard's stale time: a session that died does not hold the line
      const old = new Date(Date.now() - 73 * 3600_000).toISOString();
      expect(judgeAll(w, { xOpen: false, comments: { 2: [{ body: releaseBody("重なり", [90], true), createdAt: old }] } }).of(3)).toBeNull();
      // it can move again: the same place
      expect(judgeAll(w, { xOpen: false }).of(3)).toEqual(turnHit);
      // Y yielded too, later: P is still first, and Y waits for P, not P for Y
      const both = judgeAll(w, { xOpen: false, comments: { 2: [mark(releaseBody("重なり", [90], true), 0)], 3: [mark(releaseBody("重なり", [90], true), 5)] } });
      expect(both.of(2)).toBeNull();
      expect(both.of(3)).toEqual(turnHit);
    } finally {
      w.done();
    }
  });
});
