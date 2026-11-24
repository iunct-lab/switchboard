import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource, CreatedIssue, Workspace } from "@switchboard/protocol";
import { readStoredBacklog } from "../backlog-stored.ts";
import { Db, type BacklogSnapshotEntry } from "../db.ts";
import { createdRowsOf } from "./created-rows.ts";

// The rows of the Issues a Task opened, read from the stored backlog without starting the daemon.

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-created-rows-"));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const source = (repository: string): BacklogSource => ({ service: "github", host: "github.com", repository, project: { owner: "acme", number: 1 } });

const issue = (repo: string, n: number, labels: string[], over: Partial<BacklogIssueData> = {}): BacklogSnapshotEntry => ({
  objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched",
  remote: { number: n, title: `題 ${n}`, url: `https://github.com/${repo}/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null, ...over },
});

/** A workspace of `repository` whose last import stored `records`. */
function imported(name: string, repository: string, records: BacklogSnapshotEntry[], kind: Workspace["kind"] = "repo") {
  const ws = db.upsertWorkspace({ name, path: `/Users/dev/${name}`, kind });
  db.putBacklogSnapshot(source(repository), { records, cursor: null, syncedAt: 5000 });
  db.setWorkspaceBacklogSource(ws.id, source(repository));
  return ws;
}

/** The context the function reads: the stored backlog as read here, the meta workspace not read, and the stage Task each item gets. */
function context() {
  const reads: string[] = [];
  const sc = {
    db,
    backlogReads: (ws: Pick<Workspace, "kind">) => ws.kind !== "meta",
    storedBacklog: (ws: Workspace) => (reads.push(ws.name), { ...readStoredBacklog(db, ws), syncing: false, error: null, errorKind: null }),
    withActive: (b: Parameters<Parameters<typeof createdRowsOf>[0]["withActive"]>[0]) => ({ ...b, items: b.items.map((i) => ({ ...i, activeTaskId: `t_${i.number}` })) }),
  };
  return { sc, reads };
}

const rowsOf = (sc: ReturnType<typeof context>["sc"], created: CreatedIssue[]) => createdRowsOf(sc, created).map(({ item, ...r }) => ({ ...r, stage: item?.stage ?? null, activeTaskId: item?.activeTaskId ?? null }));

test("a Task that opened no Issue reads nothing", () => {
  imported("app", "acme/app", [issue("acme/app", 12, ["type:request"])]);
  const { sc, reads } = context();
  expect(createdRowsOf(sc, [])).toEqual([]);
  expect(reads).toEqual([]);
});

test("one request: its row in the workspace of its repository, with its item through withActive", () => {
  // another repository's workspace, listed first, has an Issue of the same number
  imported("lib", "acme/lib", [issue("acme/lib", 12, ["type:pbi"])]);
  const app = imported("app", "acme/app", [issue("acme/app", 12, ["type:request"])]);
  const { sc, reads } = context();
  expect(rowsOf(sc, [{ repo: "acme/app", number: 12 }])).toEqual([
    { repo: "acme/app", number: 12, workspaceId: app.id, title: "題 12", url: "https://github.com/acme/app/issues/12", kind: "request", stage: "request", activeTaskId: "t_12" },
  ]);
  expect(reads).toEqual(["app"]);
});

test("a request with a derived PBI has no item; the PBI has its own; one read of the workspace, in the order they were opened", () => {
  const app = imported("app", "acme/app", [
    issue("acme/app", 20, ["type:request"], { body: "## 派生 PBI\n\n- #21\n" }),
    issue("acme/app", 21, ["type:pbi"], { body: "## 元要望\n\n#20\n" }),
  ]);
  const { sc, reads } = context();
  expect(rowsOf(sc, [{ repo: "acme/app", number: 20 }, { repo: "acme/app", number: 21 }])).toEqual([
    { repo: "acme/app", number: 20, workspaceId: app.id, title: "題 20", url: "https://github.com/acme/app/issues/20", kind: "request", stage: null, activeTaskId: null },
    { repo: "acme/app", number: 21, workspaceId: app.id, title: "題 21", url: "https://github.com/acme/app/issues/21", kind: "pbi", stage: "needs-tasks", activeTaskId: "t_21" },
  ]);
  expect(reads).toEqual(["app"]);
});

test("a closed Issue, a Task Issue, one not stored and one of a repository no read workspace has (another repository's number 32 too) are left out", () => {
  imported("app", "acme/app", [
    issue("acme/app", 30, ["type:request"], { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-10-03T00:00:00Z" }),
    issue("acme/app", 31, ["type:task"]),
    issue("acme/app", 32, ["type:pbi"]),
  ]);
  // the meta workspace's backlog is not read (backlogReads): its Issue has no row
  imported("meta", "acme/meta", [issue("acme/meta", 40, ["type:request"])], "meta");
  const { sc } = context();
  expect(rowsOf(sc, [{ repo: "acme/app", number: 30 }, { repo: "acme/app", number: 31 }, { repo: "acme/app", number: 33 }, { repo: "other/tool", number: 32 }, { repo: "acme/meta", number: 40 }, { repo: "acme/app", number: 32 }]).map((r) => r.number)).toEqual([32]);
});
