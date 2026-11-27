import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { readStoredBacklog, withStageTask } from "./backlog-stored.ts";
import { autoActionsOf, awaitingReply, isUnblocked, pickNext, flowCounted } from "./backlog-pick.ts";

// Met waits lift only the release they came with: once an 実装 or 閉じる started after them, how that Task stopped holds
// the PBI (waiting for the person, the gate), and the stage it would start next is the one `autoHeld` answers for.

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-unblocked-"));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE = { service: "github" as const, host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const at = (d: number) => Date.parse(`2026-10-0${d}T00:00:00Z`);
const iso = (d: number) => new Date(at(d)).toISOString();
const issue = (n: number, labels: string[], over: object = {}): BacklogSnapshotEntry => ({
  objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched",
  remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: iso(1), updatedAt: iso(2), closedAt: null, ...over },
});

function setup(extra: BacklogSnapshotEntry[] = [], subs = [51]) {
  const ws = db.upsertWorkspace({ name: "app", path: "/work/app", kind: "repo" });
  db.putBacklogSnapshot(SOURCE, {
    records: [
      issue(5, ["type:pbi"], { subIssues: subs }),
      issue(51, ["type:task"], { parent: 5 }),
      // what PBI 5 waited for: closed on day 3
      issue(9, ["type:task"], { state: "CLOSED", stateReason: "COMPLETED", closedAt: iso(3) }),
      { objectKind: "project-item", externalId: "PVTI_5", fetchState: "fetched", remote: { issue: 5, owner: "acme", project: 1, fields: { Status: "In progress" } } },
      { objectKind: "comment", externalId: "c1", fetchState: "fetched", remote: { issue: 5, body: "<!-- pbi-complete:release waits=9 -->", createdAt: iso(2) } },
      ...extra,
    ],
    cursor: null,
    syncedAt: at(8),
  });
  db.setWorkspaceBacklogSource(ws.id, SOURCE);
  return ws;
}

const task = (ws: { id: string }, id: string, day: number, auto: boolean, outcome: "finished" | "needs_action") =>
  db.insertTask({ id, workspaceId: ws.id, title: id, runner: "claude", cwd: "/work/app", scope: ["/work/app"], status: "done", runnerSessionId: "s", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 5, action: "complete", ...(auto ? { auto: true as const } : {}) }, statusAt: at(day) + 10, createdAt: at(day), updatedAt: at(day) + 10 } as Parameters<Db["insertTask"]>[0]);

const read = (ws: ReturnType<typeof setup>) => withStageTask(db, readStoredBacklog(db, ws, { now: at(8) }).items.find((i) => i.number === 5)!);

test("a button's 実装 that ended asking the person is not started over by itself", () => {
  const ws = setup();
  task(ws, "t_release", 1, true, "finished"); // the automatic 実装 that wrote the release, before the wait closed
  task(ws, "t_button", 4, false, "needs_action"); // the button, after: asks the person, no claim written
  const i = read(ws);
  expect(awaitingReply(i)).toBe(true);
  expect(pickNext([i], "implement")).toBeNull();
  expect(flowCounted([{ ...i, flow: true }])).toEqual([]);
});

test("an automatic 実装 that ended asking the person stays held when an unrelated event arrives", () => {
  // Task 52 of the PBI closed on day 6: an event after the automatic start, not an answer
  const ws = setup([issue(52, ["type:task"], { parent: 5, state: "CLOSED", stateReason: "COMPLETED", closedAt: iso(6) })], [51, 52]);
  task(ws, "t_auto", 4, true, "needs_action");
  const i = read(ws);
  expect(awaitingReply(i)).toBe(true);
  expect(pickNext([i], "implement")).toBeNull();
});

test("a closable PBI whose waits closed and whose automatic 実装 failed before claiming is still closed", () => {
  const ws = db.upsertWorkspace({ name: "app", path: "/work/app", kind: "repo" });
  db.putBacklogSnapshot(SOURCE, {
    records: [
      issue(5, ["type:pbi"], { subIssues: [51] }),
      // the PBI waited for its last Task; it closed on day 3
      issue(51, ["type:task"], { parent: 5, state: "CLOSED", stateReason: "COMPLETED", closedAt: iso(3) }),
      { objectKind: "project-item", externalId: "PVTI_5", fetchState: "fetched", remote: { issue: 5, owner: "acme", project: 1, fields: { Status: "In progress" } } },
      { objectKind: "comment", externalId: "c1", fetchState: "fetched", remote: { issue: 5, body: "<!-- pbi-complete:release waits=51 -->", createdAt: iso(2) } },
    ],
    cursor: null,
    syncedAt: at(8),
  });
  db.setWorkspaceBacklogSource(ws.id, SOURCE);
  // the automatic 実装 the closed wait started: the runner's usage limit, nothing written
  db.insertTask({ id: "t_auto", workspaceId: ws.id, title: "t", runner: "claude", cwd: "/work/app", scope: ["/work/app"], status: "error", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "failed", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 5, action: "complete", auto: true }, statusAt: at(4) + 10, createdAt: at(4), updatedAt: at(4) + 10 } as Parameters<Db["insertTask"]>[0]);
  const i = withStageTask(db, readStoredBacklog(db, ws, { now: at(8) }).items.find((x) => x.number === 5)!);
  expect(i.closable).toBe(true);
  // the stage the item names and the stage `autoHeld` answers for are the same one
  if (i.autoHeld) expect(i.autoHeld.action).toBe(autoActionsOf(i)[0]!);
  expect(pickNext([i], "implement")).toMatchObject({ item: { number: 5 }, action: "close" });
});

// A 状況確認 after the 実装 only reads: the 実装 still counts as the work that went on since the waits (`lastWorkAt`)
function setupClosable() {
  const ws = db.upsertWorkspace({ name: "app", path: "/work/app", kind: "repo" });
  db.putBacklogSnapshot(SOURCE, {
    records: [
      issue(5, ["type:pbi"], { subIssues: [51] }),
      issue(51, ["type:task"], { parent: 5, state: "CLOSED", stateReason: "COMPLETED", closedAt: iso(3) }),
      { objectKind: "project-item", externalId: "PVTI_5", fetchState: "fetched", remote: { issue: 5, owner: "acme", project: 1, fields: { Status: "In progress" } } },
      { objectKind: "comment", externalId: "c1", fetchState: "fetched", remote: { issue: 5, body: "<!-- pbi-complete:release waits=51 -->", createdAt: iso(2) } },
    ],
    cursor: null,
    syncedAt: at(8),
  });
  db.setWorkspaceBacklogSource(ws.id, SOURCE);
  return ws;
}

const stageTask = (ws: { id: string }, id: string, day: number, action: "complete" | "close" | "check", auto: boolean, outcome: "finished" | "needs_action" | "failed") =>
  db.insertTask({ id, workspaceId: ws.id, title: id, runner: "claude", cwd: "/work/app", scope: ["/work/app"], status: outcome === "failed" ? "error" : "done", runnerSessionId: "s", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 5, action, ...(auto ? { auto: true as const } : {}) }, statusAt: at(day) + 10, createdAt: at(day), updatedAt: at(day) + 10 } as Parameters<Db["insertTask"]>[0]);

const readClosable = (ws: ReturnType<typeof setupClosable>) => withStageTask(db, readStoredBacklog(db, ws, { now: at(8) }).items.find((i) => i.number === 5)!);

test("automatic 実装 failed, then 状況確認: the never-run 閉じる is not held", () => {
  const ws = setupClosable();
  stageTask(ws, "t_auto", 4, "complete", true, "failed");
  stageTask(ws, "t_check", 5, "check", false, "finished");
  expect(pickNext([readClosable(ws)], "implement")).toMatchObject({ action: "close" });
});

test("button 実装, then a 状況確認 that ended asking the person: nothing starts over it", () => {
  const ws = setupClosable();
  stageTask(ws, "t_button", 4, "complete", false, "finished");
  stageTask(ws, "t_check", 5, "check", false, "needs_action");
  const i = readClosable(ws);
  expect(isUnblocked(i)).toBe(false);
  expect(pickNext([i], "implement")).toBeNull();
});

test("button 実装, then 状況確認: the closable PBI is closed, not 実装 again", () => {
  const ws = setupClosable();
  stageTask(ws, "t_button", 4, "complete", false, "finished");
  stageTask(ws, "t_check", 5, "check", false, "finished");
  expect(pickNext([readClosable(ws)], "implement")).toMatchObject({ action: "close" });
});

test("a 閉じる after the waits is the work that went on too", () => {
  const ws = setupClosable();
  stageTask(ws, "t_close", 4, "close", false, "needs_action"); // the button's 閉じる, after the waits: asks the person
  const i = readClosable(ws);
  expect(i.lastWorkAt).toBe(at(4));
  expect(isUnblocked(i)).toBe(false);
  expect(pickNext([i], "implement")).toBeNull();
});
