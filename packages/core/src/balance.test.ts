import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, BacklogIssueData, BacklogSource, Task } from "@switchboard/protocol";
import { balanceRows, issuesByNumber, kindOf, perDelivered } from "./balance.ts";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { readStoredRecords } from "./backlog.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard.balance."));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.parse("2026-10-20T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SOURCE: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

const issue = (n: number, labels: string[], over: Partial<BacklogIssueData> = {}, kind?: string): BacklogSnapshotEntry[] => [
  { objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched", remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: iso(NOW - 10 * DAY), updatedAt: iso(NOW), closedAt: null, ...over } },
  ...(kind ? [{ objectKind: "project-item" as const, externalId: `P_${n}`, fetchState: "fetched" as const, remote: { issue: n, owner: "acme", project: 1, fields: { Kind: kind } } }] : []),
];
const closed = { state: "CLOSED" as const, closedAt: iso(NOW - DAY) };

function workspace(name: string, records: BacklogSnapshotEntry[] | null) {
  const ws = db.upsertWorkspace({ name, path: join(dir, name), kind: "repo" });
  const source = { ...SOURCE, repository: `acme/${name}` };
  if (records) db.putBacklogSnapshot(source, { records, cursor: null, syncedAt: NOW });
  db.setWorkspaceBacklogSource(ws.id, source);
  return ws;
}

let n = 0;
/** A Task created at `createdAt` with ledger rows `[costUsd, billedUsd, ts]`. */
function task(workspaceId: string, title: string, createdAt: number, ledger: Array<[number, number, number]>): string {
  const id = `t${++n}`;
  db.insertTask({
    id, workspaceId, title, runner: "claude", cwd: "/x", scope: { read: [], write: [] }, status: "done", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: null,
    permissionMode: "default", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null,
    judgedResult: null, judgedReason: null, judgedBy: null, statusAt: createdAt, createdAt, updatedAt: createdAt, executionMode: "local", cloudSession: null, sourceCloudTaskId: null,
    stage: null, judgingAt: null,
  } as unknown as Task);
  for (const [costUsd, billedUsd, ts] of ledger) db.insertLedger({ taskId: id, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd, source: "reported", ts });
  return id;
}

/** Workspace `app`: PBI 3 (feature, closed yesterday, Task 30), 4 (bug), 5 (feature + flow-improvement), 6 (no Kind), 7 (closed 20 days ago, before it a request); `solo`: never imported; `idle`: nothing closed. */
function fixture() {
  const app = workspace("app", [
    ...issue(3, ["type:pbi"], { subIssues: [30], ...closed }, "feature"),
    ...issue(30, ["type:task"], { parent: 3 }),
    ...issue(4, ["type:pbi"], {}, "bug"),
    ...issue(5, ["type:pbi", "flow-improvement"], {}, "feature"),
    ...issue(6, ["type:pbi"]),
    ...issue(9, ["type:pbi"], {}, "docs"), // a Kind outside the six
    ...issue(7, ["type:pbi"], { createdAt: iso(NOW - 50 * DAY), state: "CLOSED", closedAt: iso(NOW - 20 * DAY) }, "feature"),
  ]);
  const solo = workspace("solo", null);
  const idle = workspace("idle", [...issue(8, ["type:pbi"], {}, "feature")]);
  const t30 = task(app.id, "#30 実装", NOW - 5 * DAY, [[2, 0.5, NOW - 5 * DAY], [100, 100, NOW - 40 * DAY]]); // the old row is outside both periods
  task(app.id, "#4 直す", NOW - 3 * DAY, [[1, 0, NOW - 3 * DAY]]);
  task(app.id, "#5 流れ", NOW - 3 * DAY, [[4, 0, NOW - 3 * DAY]]);
  task(app.id, "#99 どこにも無い", NOW - 2 * DAY, [[3, 0, NOW - 2 * DAY]]);
  task(app.id, "#3 前に作った", NOW - 20 * DAY, [[1, 0, NOW - 6 * DAY]]); // created before the 7 days; its cost is inside
  task(solo.id, "#1 x", NOW - 2 * DAY, [[2, 0, NOW - 2 * DAY]]);
  task(idle.id, "#8 y", NOW - 2 * DAY, [[1, 0, NOW - 2 * DAY]]);
  // the person: a first request, then an answer to Task 30 (PBI 3)
  db.appendEventAt(t30, { t: "message.delta", role: "user", text: "request" } as AgentEvent, NOW - 5 * DAY);
  db.appendEventAt(t30, { t: "status", text: "x" } as AgentEvent, NOW - 5 * DAY + 1);
  db.appendEventAt(t30, { t: "message.delta", role: "user", text: "こうして" } as AgentEvent, NOW - 4 * DAY + 10 * MIN);
  return { app, solo, idle };
}
const byName = (rows: ReturnType<typeof balanceRows>) => Object.fromEntries(rows.map((r) => [r.name, r]));

describe("balanceRows", () => {
  test("30 days: every column of each workspace", () => {
    fixture();
    const r = byName(balanceRows(db, db.listWorkspaces(), 30, NOW));
    expect(r.app).toMatchObject({ tasks: 5, costUsd: 11, billedUsd: 0.5, interventions: 1, deliveredPbis: 2, net: 3, costPerPbi: 5.5, interventionsPerPbi: 0.5 });
    expect(r.app!.costShare).toBeCloseTo(11 / 14);
    expect(r.app!.kinds).toEqual({ build: { tasks: 2, costUsd: 3 }, maintain: { tasks: 1, costUsd: 1 }, selfImprove: { tasks: 1, costUsd: 4 }, unlinked: { tasks: 1, costUsd: 3 } });
    expect(r.solo).toMatchObject({ tasks: 1, costUsd: 2, interventions: null, deliveredPbis: null, net: null, costPerPbi: null, interventionsPerPbi: null });
    expect(r.solo!.kinds.unlinked).toEqual({ tasks: 1, costUsd: 2 });
    expect(r.idle).toMatchObject({ tasks: 1, costUsd: 1, deliveredPbis: 0, costPerPbi: null, interventionsPerPbi: null });
  });

  test("7 days: the period cuts the Tasks, the ledger, the interventions and the PBIs", () => {
    fixture();
    const r = byName(balanceRows(db, db.listWorkspaces(), 7, NOW));
    expect(r.app).toMatchObject({ tasks: 4, costUsd: 11, deliveredPbis: 1, net: -1, costPerPbi: 11 });
    const old = byName(balanceRows(db, db.listWorkspaces(), 7, NOW + 5 * DAY)).app!; // five days on: only the Task and row of exactly 2 days before the start remain
    expect(old).toMatchObject({ tasks: 1, costUsd: 3, interventions: 0 });
  });

  test("an intervention on a Task of a workspace not in the list (deleted) is skipped, not a crash", () => {
    const { app } = fixture();
    const gone = workspace("gone", [...issue(1, ["type:pbi"], {}, "feature")]);
    const t = task(gone.id, "名前だけ", NOW - 2 * DAY, []); // no Issue: its interventions are kept with no PBI
    db.appendEventAt(t, { t: "message.delta", role: "user", text: "request" } as AgentEvent, NOW - 2 * DAY);
    db.appendEventAt(t, { t: "status", text: "x" } as AgentEvent, NOW - 2 * DAY + 1);
    db.appendEventAt(t, { t: "message.delta", role: "user", text: "こうして" } as AgentEvent, NOW - DAY);
    const rows = balanceRows(db, db.listWorkspaces().filter((w) => w.id !== gone.id), 30, NOW);
    expect(byName(rows).app).toMatchObject({ workspaceId: app.id, interventions: 1 });
    expect(rows.map((r) => r.name)).not.toContain("gone");
  });

  test("the four kinds add up to the workspace's Tasks and cost", () => {
    fixture();
    for (const days of [7, 30] as const)
      for (const row of balanceRows(db, db.listWorkspaces(), days, NOW)) {
        const all = Object.values(row.kinds);
        expect(all.reduce((s, k) => s + k.tasks, 0)).toBe(row.tasks);
        expect(all.reduce((s, k) => s + k.costUsd, 0)).toBeCloseTo(row.costUsd);
      }
  });
});

describe("kindOf / perDelivered", () => {
  test("a Task Issue is read through its PBI; flow-improvement wins over Kind; no Issue or no Kind is unlinked", () => {
    const app = fixture().app;
    const rec = issuesByNumber(readStoredRecords(db, app));
    expect([30, 3, 4, 5, 6, 9, 99, null].map((i) => kindOf(i, rec))).toEqual(["build", "build", "maintain", "selfImprove", "unlinked", "unlinked", "unlinked", "unlinked"]);
    expect(kindOf(3, issuesByNumber(null))).toBe("unlinked");
  });

  test("a ratio over no delivered PBI is null", () => {
    expect([perDelivered(5, 2), perDelivered(5, 0), perDelivered(5, null), perDelivered(0, 3)]).toEqual([2.5, null, null, 0]);
  });
});
