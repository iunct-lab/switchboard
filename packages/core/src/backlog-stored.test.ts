import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BacklogEditInput, type BacklogIssueData, type BacklogSource } from "@switchboard/protocol";
import { BacklogEditError, createStoredIssue, editStoredIssue, commentStoredIssue, isUnblocked, overlapIn, pickNext, readStoredBacklog, readStoredIssue, heldIn, workspaceSyncOf } from "./backlog.ts";
import { Db, type BacklogSnapshotEntry } from "./db.ts";

// The backlog read from what the last import stored: no GitHub involved — readStoredBacklog takes no gh at all.

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-stored-"));
  db = new Db(join(dir, "switchboard.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

const issue = (n: number, labels: string[], over: Partial<BacklogIssueData> = {}): BacklogSnapshotEntry => ({
  objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched",
  remote: { number: n, title: `#${n}`, url: `https://github.com/acme/app/issues/${n}`, state: "OPEN", stateReason: null, body: "", labels, milestone: null, parent: null, subIssues: [], createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}Z`, updatedAt: "2026-10-02T00:00:00Z", closedAt: null, ...over },
});
const comment = (n: number, id: string, body: string, createdAt: string): BacklogSnapshotEntry => ({ objectKind: "comment", externalId: id, remote: { issue: n, body, createdAt }, fetchState: "fetched" });
const item = (n: number, fields: Record<string, string | number>, owner = "acme"): BacklogSnapshotEntry => ({ objectKind: "project-item", externalId: `PVTI_${owner}_${n}`, remote: { issue: n, owner, project: 1, fields }, fetchState: "fetched" });

/** A workspace whose last import stored `records`. */
function imported(records: BacklogSnapshotEntry[]) {
  const ws = db.upsertWorkspace({ name: "app", path: "/Users/dev/app", kind: "repo" });
  db.putBacklogSnapshot(SOURCE, { records, cursor: null, syncedAt: 5000 });
  db.setWorkspaceBacklogSource(ws.id, SOURCE);
  return ws;
}

const byNumber = (ws: { id: string; name: string; path: string }) => Object.fromEntries(readStoredBacklog(db, ws).items.map((i) => [i.number, i]));

test("a GitHub Issue 12 and a GitLab Issue 12 are two records: each workspace reads its own, with its comments", () => {
  const LAB: BacklogSource = { service: "gitlab", host: "gitlab.example.com", repository: "acme/app", project: { owner: "acme/app", number: 0 } };
  const hub = imported([issue(12, ["type:pbi"], { title: "GitHub の #12" }), comment(12, "IC_1", "GitHub のコメント", "2026-10-02T00:00:00Z")]);
  const lab = db.upsertWorkspace({ name: "lab", path: "/Users/dev/lab", kind: "repo" });
  db.putBacklogSnapshot(LAB, { records: [{ ...issue(12, ["type:pbi"], { title: "GitLab の #12", url: "https://gitlab.example.com/acme/app/-/issues/12" }), externalId: "gitlab:issue:900" }, { ...comment(12, "gitlab:note:5", "GitLab のコメント", "2026-10-02T00:00:00Z") }], cursor: null, syncedAt: 6000 });
  db.setWorkspaceBacklogSource(lab.id, LAB);
  expect(byNumber(hub)[12]).toMatchObject({ title: "GitHub の #12" });
  expect(byNumber(lab)[12]).toMatchObject({ title: "GitLab の #12" });
  expect(readStoredIssue(db, hub, 12)!.comments.map((c) => c.body)).toEqual(["GitHub のコメント"]);
  expect(readStoredIssue(db, lab, 12)!.comments.map((c) => c.body)).toEqual(["GitLab のコメント"]);
  // the same external id under the other key is another record too
  expect(db.listBacklogRecords(SOURCE).map((r) => r.externalId).sort()).toEqual(["IC_1", "I_12"]);
  expect(db.listBacklogRecords(LAB).map((r) => r.externalId).sort()).toEqual(["gitlab:issue:900", "gitlab:note:5"]);
});

test("a comment made here keeps its seq across the send", () => {
  const ws = imported([issue(12, ["type:pbi"]), comment(12, "IC_old", "取り込んだだけ", "2026-10-01T00:00:00Z")]);
  const first = commentStoredIssue(db, SOURCE, 12, "1 件目", Date.parse("2026-10-03T00:00:00Z")).operation;
  commentStoredIssue(db, SOURCE, 12, "2 件目", Date.parse("2026-10-03T00:00:01Z"));
  const seqs = () => Object.fromEntries(readStoredIssue(db, ws, 12)!.comments.map((c) => [c.body, c.seq]));
  const before = seqs();
  expect(before["1 件目"]!).toBeLessThan(before["2 件目"]!);
  expect(before["取り込んだだけ"]).toBeNull();

  // GitHub's node id, and a time after the second comment's local one
  db.setBacklogOperationResult(first, { status: "done", remoteId: "IC_sent", record: { externalId: "IC_sent", remote: { issue: 12, body: "1 件目", createdAt: "2026-10-03T00:05:00Z" } } });
  expect(readStoredIssue(db, ws, 12)!.comments.find((c) => c.body === "1 件目")).toMatchObject({ id: "IC_sent", createdAt: "2026-10-03T00:05:00Z" });
  expect(seqs()).toEqual(before);

  // sent again when GitHub is turned on on a backlog kept here: a comment made in between does not come before it
  db.applyBacklogEdit(SOURCE, { records: [], operations: [{ issue: "I_12", targetKind: "comment", target: "IC_sent", kind: "comment", payload: { body: "1 件目" } }] });
  expect(seqs()).toEqual(before);
});

test("a workspace never imported answers no items with no fetchedAt — not an empty list as if read", () => {
  const ws = db.upsertWorkspace({ name: "app", path: "/Users/dev/app", kind: "repo" });
  expect(readStoredBacklog(db, ws)).toEqual({ fetchedAt: null, items: [], changes: [] });
  db.setWorkspaceBacklogSource(ws.id, SOURCE); // a source with no complete import yet
  expect(readStoredBacklog(db, ws)).toEqual({ fetchedAt: null, items: [], changes: [] });
});

test("stages, Project fields of the workspace's Project and Task counts come from the stored records", () => {
  const ws = imported([
    issue(1, ["type:request"]),
    issue(2, ["type:request"], { body: "## 派生 PBI\n- #3" }),
    issue(3, ["type:pbi"], { subIssues: [30, 31] }), item(3, { Status: "Ready", Priority: "P1", "Story Points": 5 }),
    issue(30, ["type:task"], { state: "CLOSED" }), issue(31, ["type:task"]),
    issue(4, ["type:pbi"]), item(4, { Status: "Ready" }, "other"), // another owner's Project 1
    issue(5, ["type:pbi"]), item(5, { Status: "In review" }),
    issue(6, ["type:pbi"], { state: "CLOSED" }),
    { ...issue(7, ["type:pbi"]), fetchState: "unavailable" },
  ]);
  const got = readStoredBacklog(db, ws);
  expect(got.fetchedAt).toBe(5000);
  expect(got.items.map((i) => [i.number, i.stage])).toEqual([[5, "in-progress"], [4, "needs-tasks"], [3, "ready"], [1, "request"]]);
  expect(got.items.find((i) => i.number === 3)).toMatchObject({ priority: "P1", storyPoints: 5, projectStatus: "Ready", tasks: { total: 2, done: 1 }, workspaceId: ws.id, workspaceName: "app" });
  expect(got.items.find((i) => i.number === 4)).toMatchObject({ projectStatus: null, priority: null });
});

test("questions, reports and answers are read from every stored comment, a Task's question holding its PBI", () => {
  const ws = imported([
    issue(10, ["type:pbi", "needs-decision"]),
    comment(10, "c1", "## 判断待ち\n古い問い", "2026-10-02T00:00:00Z"), comment(10, "c2", "## 判断待ち\n今の問い", "2026-10-03T00:00:00Z"),
    issue(11, ["type:pbi"], { subIssues: [110] }), item(11, { Status: "In progress" }), issue(110, ["type:task"]),
    comment(11, "c3", "## 状況\n動いている", "2026-10-02T00:00:00Z"), comment(110, "c4", "## 回答\nA", "2026-10-04T00:00:00Z"),
    issue(12, ["type:pbi"], { subIssues: [120] }), item(12, { Status: "In progress" }), issue(120, ["type:task", "needs-decision"]),
    comment(120, "c5", "## 判断待ち\nTask の問い", "2026-10-05T00:00:00Z"),
  ]);
  const items = byNumber(ws);
  expect(items[10]).toMatchObject({ stage: "needs-decision", decision: { body: "## 判断待ち\n今の問い", at: "2026-10-03T00:00:00Z", issue: 10 } });
  expect(items[11]).toMatchObject({ stage: "in-progress", report: { body: "## 状況\n動いている" }, answeredAt: "2026-10-04T00:00:00Z", decision: null });
  expect(items[12]).toMatchObject({ stage: "needs-decision", decision: { body: "## 判断待ち\nTask の問い", issue: 120 } });
});

test("a PBI's waits carry the stored states; a Draft or needs-decision pull request is not waited for, nor a decision Task in an overlap wait", () => {
  const pr = (n: number, isDraft: boolean, labels: string[] = []): BacklogSnapshotEntry => ({ objectKind: "pull-request", externalId: `PR_${n}`, remote: { number: n, state: "OPEN", isDraft, labels, closes: [], mergeCommit: null, updatedAt: "2026-10-01T00:00:00Z", files: [], closedAt: null, mergedAt: null }, fetchState: "fetched" });
  const ws = imported([
    issue(20, ["type:pbi"]), item(20, { Status: "Ready" }),
    comment(20, "c1", "<!-- pbi-complete:release waits=40,41,42,13,14 -->", "2026-10-02T00:00:00Z"),
    issue(21, ["type:pbi"]), item(21, { Status: "Ready" }),
    comment(21, "c2", "<!-- pbi-complete:release overlap=14,40 -->", "2026-10-02T00:00:00Z"),
    issue(13, ["type:task"], { state: "CLOSED" }), issue(14, ["type:task", "needs-decision"]),
    pr(40, false), pr(41, true), pr(42, false, ["needs-decision"]),
  ]);
  const items = byNumber(ws);
  // a prerequisite waits for a Task even while it asks; an overlap wait does not
  expect(items[20]).toMatchObject({ waits: [{ number: 40, kind: "pr", open: true }, { number: 13, kind: "issue", open: false }, { number: 14, kind: "issue", open: true }], waitsAt: "2026-10-02T00:00:00Z" });
  expect(items[21]!.waits).toEqual([{ number: 40, kind: "pr", open: true, state: "pending", reason: "overlap", pbi: null }]);
});

test("waiting: each wait says why (overlap / prerequisite) and the PBI that moves it (an Issue's parent, the parent of what a PR closes); a number not stored stays, neither open nor closed", () => {
  const ws = imported([
    issue(20, ["type:pbi"]), item(20, { Status: "In progress" }),
    comment(20, "c1", "<!-- pbi-complete:release waits=13,99 -->", "2026-10-02T00:00:00Z"),
    issue(21, ["type:pbi"]), item(21, { Status: "Ready" }),
    comment(21, "c2", "<!-- pbi-complete:release overlap=13,40 -->", "2026-10-02T00:00:00Z"),
    issue(13, ["type:task"], { state: "CLOSED", parent: 30 }), issue(30, ["type:pbi"]),
    { objectKind: "pull-request", externalId: "PR_40", remote: { number: 40, state: "MERGED", isDraft: false, labels: [], closes: [13], mergeCommit: "m40", updatedAt: "2026-10-01T00:00:00Z", files: [], closedAt: null, mergedAt: null }, fetchState: "fetched" },
  ]);
  const items = byNumber(ws);
  expect(items[20]!.waits).toEqual([
    { number: 13, kind: "issue", open: false, state: "met", reason: "prerequisite", pbi: { number: 30, title: "#30" } },
    { number: 99, kind: "issue", open: null, state: "missing", reason: "prerequisite", pbi: null },
  ]);
  expect(items[21]!.waits).toEqual([
    { number: 13, kind: "issue", open: false, state: "met", reason: "overlap", pbi: { number: 30, title: "#30" } },
    { number: 40, kind: "pr", open: false, state: "met", reason: "overlap", pbi: { number: 30, title: "#30" } },
  ]);
  // not read is not closed: Issue 20 is held and listed under 待ち, Issue 21 (all closed) goes on
  expect(heldIn(Object.values(items), "implement").map((h) => h.item.number)).toEqual([20]);
  expect(isUnblocked(items[20]!)).toBe(false);
  expect(pickNext([items[20]!], "implement")).toBeNull();
  expect(pickNext([items[20]!, items[21]!], "implement")).toMatchObject({ item: { number: 21 }, action: "complete" });
});

describe("pickNext prerequisite", () => {
  const pbi = (n: number, priority: string, body = "", over: Partial<BacklogIssueData> = {}) => [issue(n, ["type:pbi"], { body, ...over }), item(n, { Status: "Ready", Priority: priority })];
  const closed = (n: number, stateReason: BacklogIssueData["stateReason"]) => issue(n, ["type:pbi"], { state: "CLOSED", stateReason });
  const pick = (ws: { id: string; name: string; path: string }) => pickNext(readStoredBacklog(db, ws).items, "implement")?.item.number ?? null;

  test("A waits on B: B goes first, then A once B is done; B withdrawn holds A as stuck while C goes on", () => {
    const ws = imported([...pbi(1, "P0", "**前提**: #2"), ...pbi(2, "P1"), ...pbi(3, "P2")]);
    expect(byNumber(ws)[1]!.prereqs).toEqual([{ number: 2, kind: "issue", need: "done", state: "pending", via: null }]);
    expect(pick(ws)).toBe(2);
    expect(heldIn(readStoredBacklog(db, ws).items, "implement")).toMatchObject([{ item: { number: 1 }, pending: [{ number: 2 }], stuck: [] }]);
    db.putBacklogSnapshot(SOURCE, { records: [closed(2, "COMPLETED")], cursor: null, syncedAt: 6000 });
    expect(pick(ws)).toBe(1);
    db.putBacklogSnapshot(SOURCE, { records: [closed(2, "NOT_PLANNED")], cursor: null, syncedAt: 7000 });
    expect(pick(ws)).toBe(3);
    expect(heldIn(readStoredBacklog(db, ws).items, "implement")).toMatchObject([{ item: { number: 1 }, pending: [], stuck: [{ number: 2, state: "withdrawn" }] }]);
  });

  test("a PBI is held by its Tasks' prerequisites only when every open Task has one not met; its own Tasks are its order", () => {
    const ws = imported([
      ...pbi(1, "P0", "", { subIssues: [10, 11] }), issue(10, ["type:task"], { body: "**前提**: #2" }), issue(11, ["type:task"], { body: "**前提**: #10, #40（リリース）" }),
      ...pbi(2, "P1"),
      { objectKind: "pull-request", externalId: "PR_40", remote: { number: 40, state: "MERGED", isDraft: false, labels: [], closes: [], mergeCommit: "m40", updatedAt: "2026-10-01T00:00:00Z", files: [], closedAt: null, mergedAt: null }, fetchState: "fetched" },
    ]);
    expect(byNumber(ws)[1]!.prereqs).toEqual([
      { number: 2, kind: "issue", need: "done", state: "pending", via: 10 },
      { number: 40, kind: "pr", need: "release", state: "unknown", via: 11 },
    ]);
    expect(pick(ws)).toBe(2);
    // released: Issue 11 is free to go, so the PBI goes on
    const released = readStoredBacklog(db, ws, { released: (oid) => oid === "m40" }).items;
    expect(released.find((i) => i.number === 1)!.prereqs).toEqual([]);
    expect(pickNext(released, "implement")?.item.number).toBe(1);
  });

  test("A and D wait on each other: both are a cycle, and the independent C goes on", () => {
    const ws = imported([...pbi(1, "P0", "**前提**: #4"), ...pbi(4, "P0", "", { subIssues: [40] }), issue(40, ["type:task"], { body: "**前提**: #1" }), ...pbi(3, "P2")]);
    const items = byNumber(ws);
    expect(items[1]!.prereqs).toEqual([{ number: 4, kind: "issue", need: "done", state: "cycle", via: null }]);
    expect(items[4]!.prereqs).toEqual([{ number: 1, kind: "issue", need: "done", state: "cycle", via: 40 }]);
    expect(pick(ws)).toBe(3);
  });

  test("a closed PBI's open Tasks lead nowhere: A → B → closed C (whose open Task names A) is pending, not a cycle", () => {
    const ws = imported([...pbi(1, "P0", "**前提**: #2"), ...pbi(2, "P1", "**前提**: #3"), issue(3, ["type:pbi"], { state: "CLOSED", stateReason: "COMPLETED", subIssues: [30] }), issue(30, ["type:task"], { body: "**前提**: #1" })]);
    expect(byNumber(ws)[1]!.prereqs).toEqual([{ number: 2, kind: "issue", need: "done", state: "pending", via: null }]);
  });

  test("a prerequisite not stored is missing and holds; the fenced and the free-text ones are not read", () => {
    const ws = imported([...pbi(1, "P0", "**前提**: #99\n前提: #3 が Done"), ...pbi(3, "P2", "```\n**前提**: #1\n```")]);
    const items = byNumber(ws);
    expect(items[1]!.prereqs).toEqual([{ number: 99, kind: null, need: "done", state: "missing", via: null }]);
    expect(items[3]!.prereqs).toEqual([]);
    expect(pick(ws)).toBe(3);
  });
});

test("waiting: a waits= pull request closed unmerged holds the PBI as withdrawn; an overlap= one closed unmerged lets it go on", () => {
  const ws = imported([
    issue(20, ["type:pbi"]), item(20, { Status: "In progress" }), comment(20, "c1", "<!-- pbi-complete:release waits=40 -->", "2026-10-02T00:00:00Z"),
    issue(21, ["type:pbi"]), item(21, { Status: "In progress" }), comment(21, "c2", "<!-- pbi-complete:release overlap=40 -->", "2026-10-02T00:00:00Z"),
    { objectKind: "pull-request", externalId: "PR_40", remote: { number: 40, state: "CLOSED", isDraft: false, labels: [], closes: [], mergeCommit: null, updatedAt: "2026-10-01T00:00:00Z", files: [], closedAt: null, mergedAt: null }, fetchState: "fetched" },
  ]);
  const items = byNumber(ws);
  expect(items[20]!.waits).toEqual([{ number: 40, kind: "pr", open: null, state: "withdrawn", reason: "prerequisite", pbi: null }]);
  expect(items[21]!.waits).toEqual([{ number: 40, kind: "pr", open: false, state: "met", reason: "overlap", pbi: null }]);
  expect(isUnblocked(items[20]!)).toBe(false);
  expect(heldIn([items[20]!, items[21]!], "implement")).toMatchObject([{ item: { number: 20 }, stuck: [{ number: 40, state: "withdrawn" }] }]);
  expect(pickNext([items[20]!, items[21]!], "implement")).toMatchObject({ item: { number: 21 }, action: "complete" });
});

test("the Project owner is compared without case; changing the workspace's Project variable forgets the stored source", () => {
  const ws = imported([issue(3, ["type:pbi"]), item(3, { Status: "Ready" }, "Acme")]);
  expect(byNumber(ws)[3]!.stage).toBe("ready");
  db.setWorkspaceProjectVar(ws.id, "OTHER_PROJECT_URL");
  expect(readStoredBacklog(db, ws)).toEqual({ fetchedAt: null, items: [], changes: [] });
});

test("a database restored from a backup (snapshotTo) answers the same backlog and questions", () => {
  const ws = imported([issue(10, ["type:pbi", "needs-decision"]), comment(10, "c1", "## 判断待ち\n問い", "2026-10-03T00:00:00Z"), issue(1, ["type:request"])]);
  const before = readStoredBacklog(db, ws);
  db.snapshotTo(join(dir, "backup.db"));
  const restored = new Db(join(dir, "backup.db"));
  try {
    expect(readStoredBacklog(restored, ws)).toEqual(before);
    expect(before.items.find((i) => i.number === 10)!.decision!.body).toBe("## 判断待ち\n問い");
  } finally {
    restored.close();
  }
});

describe("pickNext overlap", () => {
  // PBI n with one open Task n0 naming `file`, Ready
  const pbi = (n: number, priority: string, file: string, status = "Ready") => [
    issue(n, ["type:pbi"], { subIssues: [n * 10] }), item(n, { Status: status, Priority: priority }), issue(n * 10, ["type:task"], { body: `触る場所: \`${file}\``, parent: n }),
  ];
  const pr = (n: number, files: string[] | null, over: { isDraft?: boolean; labels?: string[]; closes?: number[]; state?: "OPEN" | "CLOSED" | "MERGED"; updatedAt?: string } = {}): BacklogSnapshotEntry => ({
    objectKind: "pull-request", externalId: `PR_${n}`, fetchState: "fetched",
    remote: { number: n, state: over.state ?? "OPEN", isDraft: over.isDraft ?? false, labels: over.labels ?? [], closes: over.closes ?? [], mergeCommit: null, updatedAt: over.updatedAt ?? new Date().toISOString(), files, closedAt: null, mergedAt: null },
  });
  const pick = (ws: { id: string; name: string; path: string }) => pickNext(readStoredBacklog(db, ws).items, "implement")?.item.number ?? null;

  test("a PBI whose Task names a file an open PR changes is skipped; the next one that does not overlap is picked, and all overlapping picks nothing", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), ...pbi(2, "P1", "src/b.ts"), pr(50, ["src/a.ts"], { closes: [9] })]);
    expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }], unknown: null });
    expect(byNumber(ws)[2]!.overlap).toBeNull();
    expect(pick(ws)).toBe(2);
    db.putBacklogSnapshot(SOURCE, { records: [pr(51, ["src/b.ts"])], cursor: null, syncedAt: 6000 });
    expect(pick(ws)).toBeNull();
    expect(overlapIn(readStoredBacklog(db, ws).items, "implement").map((i) => i.number)).toEqual([1, 2]);
  });

  test("a Draft or needs-decision PR, and the PBI's own PR, are not the other work; a closed PR is gone from the next pick", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), pr(50, ["src/a.ts"], { isDraft: true }), pr(51, ["src/a.ts"], { labels: ["needs-decision"] }), pr(52, ["src/a.ts"], { closes: [10] }), pr(53, ["src/a.ts"], { closes: [1] })]);
    expect(pick(ws)).toBe(1);
    db.putBacklogSnapshot(SOURCE, { records: [pr(54, ["src/a.ts"])], cursor: null, syncedAt: 6000 });
    expect(pick(ws)).toBeNull();
    db.putBacklogSnapshot(SOURCE, { records: [pr(54, ["src/a.ts"], { state: "MERGED" })], cursor: null, syncedAt: 7000 });
    expect(pick(ws)).toBe(1);
  });

  test("an In progress Task of another PBI is the other work unless it asks (needs-decision); a PR untouched for 72 hours does not hold", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), issue(60, ["type:task"], { body: "`src/a.ts`", parent: 6, updatedAt: new Date().toISOString() }), item(60, { Status: "In progress" })]);
    expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "Task #60", path: "src/a.ts" }], unknown: null });
    db.putBacklogSnapshot(SOURCE, { records: [issue(60, ["type:task", "needs-decision"], { body: "`src/a.ts`", parent: 6, updatedAt: new Date().toISOString() })], cursor: null, syncedAt: 6000 });
    expect(pick(ws)).toBe(1);
    db.putBacklogSnapshot(SOURCE, { records: [pr(61, ["src/a.ts"], { updatedAt: "2026-01-01T00:00:00Z" })], cursor: null, syncedAt: 7000 });
    expect(pick(ws)).toBe(1);
  });

  test("pickNext overlap: a free Task lets the PBI go while another of its Tasks overlaps; a Task waiting on its sibling does not count", () => {
    const task = (n: number, parent: number, file: string, prereq = "") => issue(n, ["type:task"], { body: `触る場所: \`${file}\`${prereq}`, parent });
    const two = (a: BacklogSnapshotEntry, b: BacklogSnapshotEntry) => [issue(1, ["type:pbi"], { subIssues: [10, 11] }), item(1, { Status: "Ready" }), a, b];
    const busy = pr(50, ["src/a.ts", "src/c.ts"]);
    // one of the two overlaps: the PBI goes
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), task(11, 1, "src/b.ts")), busy]);
      expect(byNumber(ws)[1]!.overlap).toBeNull();
      expect(pick(ws)).toBe(1);
    }
    // both overlap: skipped, the hits of both
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), task(11, 1, "src/c.ts")), busy]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }, { ref: "PR #50", path: "src/c.ts" }], unknown: null });
      expect(pick(ws)).toBeNull();
    }
    // the free one names the overlapping one: only that one can start, and the hit is its alone
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), task(11, 1, "src/b.ts", "\n\n**前提**: #10")), busy]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }], unknown: null });
      expect(pick(ws)).toBeNull();
    }
    // the free one waits on another PBI: only the overlapping one can start
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), task(11, 1, "src/b.ts", "\n\n**前提**: #70")), issue(70, ["type:pbi"]), busy]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }], unknown: null });
      expect(pick(ws)).toBeNull();
    }
    // none can start: all the open Tasks as one, as before
    {
      const ws = imported([...two(task(10, 1, "src/a.ts", "\n\n**前提**: #70"), task(11, 1, "src/b.ts", "\n\n**前提**: #70")), issue(70, ["type:pbi"]), busy]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }], unknown: null });
    }
    // a Task naming no path is not judged, so it counts as free
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), issue(11, ["type:task"], { body: "パスの名指し無し", parent: 1 })), busy]);
      expect(byNumber(ws)[1]!.overlap).toBeNull();
    }
    // a PR not judged stays on the whole PBI, a free Task or not
    {
      const ws = imported([...two(task(10, 1, "src/a.ts"), task(11, 1, "src/b.ts")), busy, pr(51, null)]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [], unknown: "PR #51 の変更ファイルが記録に無い" });
      expect(pick(ws)).toBeNull();
    }
    // so it does when the only Task that can start names no path, as long as an open Task names one
    {
      const ws = imported([...two(issue(10, ["type:task"], { body: "パスの名指し無し", parent: 1 }), task(11, 1, "src/b.ts", "\n\n**前提**: #10")), pr(51, null)]);
      expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [], unknown: "PR #51 の変更ファイルが記録に無い" });
    }
  });

  test("a PBI whose stage Task runs (active) holds its open Tasks as the other work, Ready or not; one that does not overlap starts too; without active nothing changes", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), ...pbi(2, "P1", "src/a.ts"), ...pbi(3, "P2", "src/c.ts")]);
    const read = (active?: (n: number) => boolean) => readStoredBacklog(db, ws, { active }).items;
    const at = (items: ReturnType<typeof read>, n: number) => items.find((i) => i.number === n)!;
    const on = read((n) => n === 1);
    expect(at(on, 2).overlap).toEqual({ hits: [{ ref: "Task #10", path: "src/a.ts" }], unknown: null });
    expect(at(on, 1).overlap).toBeNull();
    expect(at(on, 3).overlap).toBeNull();
    expect(pickNext(on.filter((i) => i.number !== 1), "implement")?.item.number).toBe(3);
    // both start when the paths do not overlap
    expect(at(read((n) => n === 3), 2).overlap).toBeNull();
    expect(pickNext(read((n) => n === 3).filter((i) => i.number !== 3), "implement")?.item.number).toBe(1);
    // the default: nobody is active
    expect(at(read(), 2).overlap).toBeNull();
    expect(at(read(() => false), 2).overlap).toBeNull();
  });

  test("a PR whose files are not all stored cannot be judged: it is not started and says why", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), pr(50, null)]);
    expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [], unknown: "PR #50 の変更ファイルが記録に無い" });
    expect(pick(ws)).toBeNull();
  });

  test("a directory only a Draft PR adds is still read as a directory in the Tasks' bodies (the vocabulary is every open PR's)", () => {
    const task = (n: number, parent: number) => issue(n, ["type:task"], { body: "`fresh/component/`", parent, updatedAt: new Date().toISOString() });
    const ws = imported([
      issue(1, ["type:pbi"], { subIssues: [10] }), item(1, { Status: "Ready" }), task(10, 1),
      issue(60, ["type:task"], { body: "fresh/component/ に足す", parent: 6, updatedAt: new Date().toISOString() }), item(60, { Status: "In progress" }),
      pr(50, ["fresh/component/a.ts"], { isDraft: true }),
    ]);
    expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "Task #60", path: "fresh/component/" }], unknown: null });
  });

  test("a PR that overlaps and one whose files are not all stored are both told: hits and the reason it cannot be judged", () => {
    const ws = imported([...pbi(1, "P0", "src/a.ts"), pr(50, ["src/a.ts"]), pr(51, null)]);
    expect(byNumber(ws)[1]!.overlap).toEqual({ hits: [{ ref: "PR #50", path: "src/a.ts" }], unknown: "PR #51 の変更ファイルが記録に無い" });
  });

  test("a PBI whose Tasks name no path is not judged", () => {
    const ws = imported([issue(1, ["type:pbi"], { subIssues: [10] }), item(1, { Status: "Ready" }), issue(10, ["type:task"], { body: "ふつうの文", parent: 1 }), pr(50, ["src/a.ts"])]);
    expect(byNumber(ws)[1]!.overlap).toBeNull();
    expect(pick(ws)).toBe(1);
  });
});

describe("sync of each item and of the workspace", () => {
  const NOW = 10_000;
  const sync = (ws: { id: string; name: string; path: string }, over: Parameters<typeof readStoredBacklog>[2] = {}) =>
    Object.fromEntries(readStoredBacklog(db, ws, { now: NOW, ...over }).items.map((i) => [i.number, i.sync]));
  const edit = (ws: { id: string }, n: number, value: string) => {
    const [id] = db.applyBacklogEdit(SOURCE, { records: [], operations: [{ issue: `I_${n}`, targetKind: "issue", target: `I_${n}`, kind: "set", field: "title", payload: value, base: `#${n}` }] }, 1);
    return id!;
  };

  test("a read Issue with nothing waiting is synced, with the time it was read", () => {
    const ws = imported([issue(1, ["type:request"])]);
    expect(sync(ws)[1]).toEqual({ state: "synced", reason: null, lastSuccessfulSync: 5000, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" });
  });

  test("an incremental import vouches for an Issue it did not return: the last complete import is its time", () => {
    const ws = imported([issue(1, ["type:request"]), issue(2, ["type:request"])]);
    db.putBacklogSnapshot(SOURCE, { records: [issue(2, ["type:request"], { title: "changed" })], cursor: "C", syncedAt: 7000 });
    expect(sync(ws)[1]!.lastSuccessfulSync).toBe(7000);
  });

  test("an edit kept for a Task of a PBI is the PBI's pending too (its stage and completion come from the Tasks)", () => {
    const ws = imported([issue(1, ["type:pbi"], { subIssues: [10] }), item(1, { Status: "In progress" }), issue(10, ["type:task"])]);
    expect(sync(ws)[1]).toMatchObject({ state: "synced", pendingCount: 0 });
    edit(ws, 10, "task title");
    expect(sync(ws)[1]).toMatchObject({ state: "pending", pendingCount: 1 });
    // its detail says the same as its row
    expect(readStoredIssue(db, ws, 1, { now: NOW })!.sync).toMatchObject({ state: "pending", pendingCount: 1 });
    // the Task no longer readable (403) keeps its edit, in the row and in the detail alike
    db.putBacklogSnapshot(SOURCE, { records: [{ ...issue(10, ["type:task"]), fetchState: "forbidden", remote: null }], cursor: null, syncedAt: 6000 });
    expect(sync(ws)[1]).toMatchObject({ state: "pending", pendingCount: 1 });
    expect(readStoredIssue(db, ws, 1, { now: NOW })!.sync).toMatchObject({ state: "pending", pendingCount: 1 });
  });

  test("a stored edit is pending, a lost answer is pending as unknown, a refused one is an error", () => {
    const ws = imported([issue(1, ["type:request"]), issue(2, ["type:request"]), issue(3, ["type:request"])]);
    edit(ws, 1, "one");
    db.setBacklogOperationResult(edit(ws, 2, "two"), { status: "unknown" });
    db.setBacklogOperationResult(edit(ws, 3, "three"), { status: "failed", error: "permission" });
    const got = sync(ws);
    expect(got[1]).toMatchObject({ state: "pending", reason: null, pendingCount: 1 });
    expect(got[2]).toMatchObject({ state: "pending", reason: "unknown", pendingCount: 1 });
    expect(got[3]).toMatchObject({ state: "error", reason: "failed", pendingCount: 1 });
  });

  test("a held conflict carries the field and the three values, and wins over what waits", () => {
    const ws = imported([issue(1, ["type:request"])]);
    db.setBacklogOperationResult(edit(ws, 1, "mine"), { status: "conflict", error: "moved" });
    edit(ws, 1, "mine again");
    const c = sync(ws)[1]!;
    expect(c.state).toBe("conflict");
    expect(c.conflicts).toHaveLength(1);
    expect(c.conflicts[0]).toMatchObject({ field: "title", base: "#1", local: "mine", revision: expect.any(String) });
  });

  test("an import that failed or is held back is an error, and the last successful time does not move", () => {
    const ws = imported([issue(1, ["type:request"])]);
    db.setBacklogRetryAt(SOURCE, NOW + 60_000);
    expect(sync(ws)[1]).toMatchObject({ state: "error", reason: "import", lastSuccessfulSync: 5000, retryAt: NOW + 60_000 });
    db.setBacklogRetryAt(SOURCE, NOW - 1);
    expect(sync(ws)[1]).toMatchObject({ state: "synced", retryAt: null });
    expect(sync(ws, { importFailed: true })[1]).toMatchObject({ state: "error", reason: "import", lastSuccessfulSync: 5000 });
  });

  test("an edit waiting while GitHub is out of reach is pending (reason import, retryAt), not an error", () => {
    const ws = imported([issue(1, ["type:request"])]);
    edit(ws, 1, "one");
    db.setBacklogRetryAt(SOURCE, NOW + 60_000);
    expect(sync(ws)[1]).toMatchObject({ state: "pending", reason: "import", pendingCount: 1, retryAt: NOW + 60_000 });
  });

  test("a record GitHub no longer shows is not listed; its detail tells how it was last answered", () => {
    const ws = imported([issue(1, ["type:request"]), issue(2, ["type:request"]), issue(3, ["type:request"])]);
    // the next import: GitHub answered 404 / 403 for them; they keep the value they had
    db.putBacklogSnapshot(SOURCE, { records: [issue(1, ["type:request"]), { ...issue(2, ["type:request"]), fetchState: "unavailable", remote: null }, { ...issue(3, ["type:request"]), fetchState: "forbidden", remote: null }], cursor: null, syncedAt: 6000 });
    expect(Object.keys(sync(ws))).toEqual(["1"]);
    expect(readStoredIssue(db, ws, 1, { now: NOW })!.sync.state).toBe("synced");
    expect(readStoredIssue(db, ws, 2, { now: NOW })!.sync).toMatchObject({ state: "error", reason: "unavailable", lastSuccessfulSync: 5000 });
    expect(readStoredIssue(db, ws, 3, { now: NOW })!.sync).toMatchObject({ state: "error", reason: "forbidden" });
  });

  test("the workspace is told apart from another's: never imported is unfetched, an Issue made here has a localId and no number", () => {
    const other = db.upsertWorkspace({ name: "other", path: "/work/other", kind: "repo" });
    expect(workspaceSyncOf(db, other, { now: NOW }).sync).toMatchObject({ state: "error", reason: "unfetched", lastSuccessfulSync: null });
    const ws = imported([issue(1, ["type:request"])]);
    expect(workspaceSyncOf(db, ws, { now: NOW }).sync).toMatchObject({ state: "synced", lastSuccessfulSync: 5000 });
    const [id] = db.applyBacklogEdit(SOURCE, {
      records: [{ objectKind: "issue", externalId: "local:L1", local: { number: 0, title: "new", url: "", state: "OPEN", stateReason: null, body: "", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "", updatedAt: "" } }],
      operations: [{ issue: "local:L1", targetKind: "issue", target: "local:L1", kind: "create", payload: { title: "new" } }],
    }, 1);
    const w = workspaceSyncOf(db, ws, { now: NOW });
    expect(w.creates).toEqual([{ localId: id!, title: "new", state: "pending" }]);
    expect(w.sync).toMatchObject({ state: "pending", pendingCount: 1 });
    // the items stay the numbered ones: nothing is started on a number not given yet
    expect(readStoredBacklog(db, ws).items.map((i) => i.number)).toEqual([1]);
    // its detail says pending too, not unfetched; an unknown send is told by its reason
    db.setBacklogOperationResult(id!, { status: "unknown" });
    expect(readStoredIssue(db, ws, id!, { now: NOW })!.sync).toMatchObject({ state: "pending", reason: "unknown" });
    expect(workspaceSyncOf(db, ws, { now: NOW }).creates[0]).toMatchObject({ state: "pending" });
  });

  test("the workspace is the worst of its Issues; a create that GitHub already numbered is not a numberless one", () => {
    const ws = imported([issue(1, ["type:request"]), issue(2, ["type:request"])]);
    db.putBacklogSnapshot(SOURCE, { records: [issue(1, ["type:request"]), { ...issue(2, ["type:request"]), fetchState: "forbidden", remote: null }], cursor: null, syncedAt: 6000 });
    expect(workspaceSyncOf(db, ws, { now: NOW }).sync).toMatchObject({ state: "error", reason: "forbidden" });
    const [id] = db.applyBacklogEdit(SOURCE, { records: [], operations: [{ issue: "I_1", targetKind: "issue", target: "I_1", kind: "create", payload: { title: "made" } }] }, 1);
    db.setBacklogOperationResult(id!, { status: "pending", remoteId: "I_9" });
    expect(workspaceSyncOf(db, ws, { now: NOW }).creates).toEqual([]);
  });

  test("the workspace lists the Issues that hold operations, Closed ones too, by number", () => {
    const ws = imported([issue(1, ["type:pbi"]), issue(2, ["type:pbi"], { state: "CLOSED" }), issue(3, ["type:pbi"], { state: "CLOSED" }), issue(4, ["type:pbi"], { state: "CLOSED" })]);
    db.setBacklogOperationResult(edit(ws, 2, "mine"), { status: "conflict", error: "moved" });
    db.applyBacklogEdit(SOURCE, { records: [], operations: [{ issue: "I_3", targetKind: "comment", target: "local:c3", kind: "comment", payload: { body: "hi" } }] }, 1);
    db.setBacklogOperationResult(edit(ws, 4, "sent"), { status: "done" });
    const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
    expect(workspaceSyncOf(db, ws, { now: NOW }).issues).toEqual([
      // the title as shown: the edit held in the conflict over what GitHub answered
      { number: 2, title: "mine", url: url(2), closed: true, state: "conflict", pendingCount: 1, conflictCount: 1 },
      { number: 3, title: "#3", url: url(3), closed: true, state: "pending", pendingCount: 1, conflictCount: 0 },
    ]);
    // they are not items: the list keeps the open ones
    expect(readStoredBacklog(db, ws).items.map((i) => i.number)).toEqual([1]);
  });

  test("the detail of an Issue is an error while the workspace's import failed, as its list row is", () => {
    const ws = imported([issue(1, ["type:request"])]);
    expect(readStoredIssue(db, ws, 1, { now: NOW, importFailed: true })!.sync).toMatchObject({ state: "error", reason: "import" });
    expect(readStoredIssue(db, ws, 1, { now: NOW })!.sync.state).toBe("synced");
  });
});

describe("close with a reason", () => {
  const reasonOf = (ws: { id: string }, ref: number | string) => {
    const i = readStoredIssue(db, ws, ref)!.issue;
    return { state: i.state, stateReason: i.stateReason };
  };
  const ops = () => db.listPendingBacklogOperations(SOURCE).map((o) => ({ field: o.field, payload: o.payload, base: o.base, status: o.status }));

  test("an open Issue closed NOT_PLANNED shows it while the edit waits: the close, then the reason changed from completed", () => {
    const ws = imported([issue(1, ["type:task"])]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(ops()).toEqual([
      { field: "state", payload: "CLOSED", base: "OPEN", status: "pending" },
      { field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "pending" },
    ]);
    // an import before the close is sent: GitHub's open Issue is not in conflict with the reason waiting on the close
    db.putBacklogSnapshot(SOURCE, { records: [issue(1, ["type:task"])], cursor: null, syncedAt: 6000 });
    expect(ops().map((o) => o.status)).toEqual(["pending", "pending"]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a reason change of one closed, reopened on GitHub before it is sent, is held as a conflict", () => {
    imported([issue(1, ["type:task"], { state: "CLOSED", stateReason: "COMPLETED" })]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    db.putBacklogSnapshot(SOURCE, { records: [issue(1, ["type:task"], { stateReason: "REOPENED" })], cursor: null, syncedAt: 6000 });
    expect(ops()).toEqual([{ field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "conflict" }]);
  });

  test("a completed Issue gets its reason changed alone; COMPLETED on an open one is the close alone", () => {
    const ws = imported([issue(1, ["type:task"], { state: "CLOSED", stateReason: "COMPLETED" }), issue(2, ["type:task"])]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    editStoredIssue(db, SOURCE, 2, { state: "CLOSED", stateReason: "COMPLETED" });
    expect(ops()).toEqual([
      { field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "pending" },
      { field: "state", payload: "CLOSED", base: "OPEN", status: "pending" },
    ]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
    // the same reason again changes nothing
    expect(editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" }).operations).toEqual([]);
  });

  test("a reason added while a close without one waits is changed from completed, what GitHub has once the close is sent", () => {
    const ws = imported([issue(1, ["type:task"])]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED" });
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(ops()).toEqual([
      { field: "state", payload: "CLOSED", base: "OPEN", status: "pending" },
      { field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "pending" },
    ]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a reopened Issue (REOPENED) closed and then given a reason: changed from completed; GitHub's null reason is the base as it is", () => {
    const ws = imported([issue(1, ["type:task"], { stateReason: "REOPENED" }), issue(2, ["type:task"], { state: "CLOSED", stateReason: null })]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED" });
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "COMPLETED" });
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    editStoredIssue(db, SOURCE, 2, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    expect(ops()).toEqual([
      { field: "state", payload: "CLOSED", base: "OPEN", status: "pending" },
      { field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "pending" },
      { field: "stateReason", payload: "NOT_PLANNED", base: null, status: "pending" },
    ]);
  });

  test("a reopen, a comment, then a close NOT_PLANNED of one closed NOT_PLANNED: an import before the send leaves the reason to the send", () => {
    const ws = imported([issue(1, ["type:task"], { state: "CLOSED", stateReason: "NOT_PLANNED" })]);
    editStoredIssue(db, SOURCE, 1, { state: "OPEN" });
    expect(reasonOf(ws, 1)).toEqual({ state: "OPEN", stateReason: null });
    // the comment keeps the reopen apart from the close: both are sent, and GitHub's reason after them is completed
    commentStoredIssue(db, SOURCE, 1, "重複でした");
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    db.putBacklogSnapshot(SOURCE, { records: [issue(1, ["type:task"], { state: "CLOSED", stateReason: "NOT_PLANNED" })], cursor: null, syncedAt: 6000 });
    expect(ops().filter((o) => o.field === "stateReason")).toEqual([{ field: "stateReason", payload: "NOT_PLANNED", base: "COMPLETED", status: "pending" }]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a reopen still waiting taken back by a close COMPLETED of one closed NOT_PLANNED: the reason is changed from GitHub's", () => {
    const ws = imported([issue(1, ["type:task"], { state: "CLOSED", stateReason: "NOT_PLANNED" })]);
    editStoredIssue(db, SOURCE, 1, { state: "OPEN" });
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "COMPLETED" });
    // the two state edits are one that writes nothing; the reason is what changes GitHub
    expect(ops()).toEqual([
      { field: "state", payload: "CLOSED", base: "CLOSED", status: "pending" },
      { field: "stateReason", payload: "COMPLETED", base: "NOT_PLANNED", status: "pending" },
    ]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "COMPLETED" });
  });

  test("a reason still waiting from before the reopen: closing back to GitHub's reason takes it back", () => {
    const ws = imported([issue(1, ["type:task"], { state: "CLOSED", stateReason: "NOT_PLANNED" })]);
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "COMPLETED" });
    editStoredIssue(db, SOURCE, 1, { state: "OPEN" });
    editStoredIssue(db, SOURCE, 1, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    // the reason waiting is one with the new one: GitHub already has it, so the send writes nothing
    expect(ops()).toEqual([
      { field: "stateReason", payload: "NOT_PLANNED", base: "NOT_PLANNED", status: "pending" },
      { field: "state", payload: "CLOSED", base: "CLOSED", status: "pending" },
    ]);
    expect(reasonOf(ws, 1)).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("an Issue whose create is not sent is refused with 409 and nothing kept", () => {
    const ws = imported([]);
    const { localId } = createStoredIssue(db, SOURCE, { title: "new", body: "", labels: [], milestone: null, parent: null, fields: null });
    const before = ops();
    let err: unknown;
    try {
      editStoredIssue(db, SOURCE, localId, { state: "CLOSED", stateReason: "NOT_PLANNED" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BacklogEditError);
    expect((err as BacklogEditError).status).toBe(409);
    expect(ops()).toEqual(before);
    expect(reasonOf(ws, localId)).toEqual({ state: "OPEN", stateReason: null });
  });

  test("the API input takes a reason only with state CLOSED (400 otherwise), and no DUPLICATE", () => {
    const ok = (e: object) => BacklogEditInput.safeParse({ workspaceId: "ws", ...e }).success;
    expect(ok({ state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe(true);
    expect(ok({ state: "CLOSED", stateReason: "COMPLETED" })).toBe(true);
    expect(ok({ stateReason: "NOT_PLANNED" })).toBe(false);
    expect(ok({ state: "OPEN", stateReason: "NOT_PLANNED" })).toBe(false);
    expect(ok({ state: "CLOSED", stateReason: "DUPLICATE" })).toBe(false);
  });
});
