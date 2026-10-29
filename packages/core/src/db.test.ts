import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogRepositoryKey } from "@switchboard/protocol";
import { createdIssuesOf, Db, deferredOf, DEFERRED_WORDS, EVENTS_PAGE_MAX, issuesInText, sizeClass, type BacklogSnapshotEntry, type NewBacklogOperation } from "./db.ts";
import { backlogFieldValue, conflictRevision } from "./backlog-merge.ts";

// The stored backlog (#885): records per repository, kept across a restart and a backup.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-db-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const A: BacklogRepositoryKey = { service: "github", host: "github.com", repository: "acme/app" };
const B: BacklogRepositoryKey = { service: "github", host: "github.com", repository: "acme/tool" };

const issue = (over: Partial<BacklogIssueData> = {}): BacklogIssueData => ({
  number: 12, title: "PBI: stored", url: "https://github.com/acme/app/issues/12", state: "OPEN", stateReason: null, body: "## ユーザーストーリー\n本文",
  labels: ["type:pbi", "needs-decision"], milestone: "Phase 2 — 同期", parent: 3, subIssues: [20, 21],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null, ...over,
});

/** An Issue with one comment and its Project item: everything one import stores for it. */
const entries = (data: BacklogIssueData, id = "I_12"): BacklogSnapshotEntry[] => [
  { objectKind: "issue", externalId: id, remote: data, fetchState: "fetched" },
  { objectKind: "comment", externalId: `${id}_c1`, remote: { issue: data.number, body: "## 回答\nA", createdAt: "2026-10-02T01:00:00Z" }, fetchState: "fetched" },
  { objectKind: "project-item", externalId: `${id}_p`, remote: { issue: data.number, owner: "acme", project: 1, fields: { Status: "Ready", Priority: "P1", "Story Points": 5, Phase: null } }, fetchState: "fetched" },
];

const remotes = (db: Db, repo: BacklogRepositoryKey) => db.listBacklogRecords(repo).map((r) => ({ kind: r.objectKind, id: r.externalId, remote: r.remote, state: r.fetchState }));

test("an import keeps every attribute, per repository: the same Issue number of two repositories does not mix", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: "c1", syncedAt: 1000 });
  db.putBacklogSnapshot(B, { records: entries(issue({ title: "other", url: "https://github.com/acme/tool/issues/12", labels: [] }), "I_other"), cursor: "c2", syncedAt: 2000 });

  expect(db.listBacklogRecords(A, "issue").map((r) => r.remote)).toEqual([issue()]);
  expect(db.listBacklogRecords(B, "issue").map((r) => (r.remote as BacklogIssueData).title)).toEqual(["other"]);
  expect(remotes(db, A).map((r) => r.id)).toEqual(["I_12_c1", "I_12", "I_12_p"]);
  expect(db.getBacklogRecord({ ...A, objectKind: "project-item", externalId: "I_12_p" })).toEqual({
    ...A, objectKind: "project-item", externalId: "I_12_p", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Ready", Priority: "P1", "Story Points": 5, Phase: null } },
    base: { issue: 12, owner: "acme", project: 1, fields: { Status: "Ready", Priority: "P1", "Story Points": 5, Phase: null } }, local: null, fetchedAt: 1000, fetchState: "fetched",
  });
  expect(db.getBacklogRecord({ ...B, objectKind: "issue", externalId: "I_12" })).toBeNull();
  expect(db.getBacklogRepository(A)).toEqual({ ...A, cursor: "c1", lastSuccessfulSync: 1000, retryAt: null });
  expect(db.getBacklogRepository(B)).toEqual({ ...B, cursor: "c2", lastSuccessfulSync: 2000, retryAt: null });
  db.close();
});

test("close and reopen are stored as they are, and every attribute survives reopening the database", () => {
  const path = join(dir, "switchboard.db");
  let db = new Db(path);
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.putBacklogSnapshot(A, { records: entries(issue({ state: "CLOSED", updatedAt: "2026-10-03T00:00:00Z" })), cursor: null, syncedAt: 2000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.remote).toEqual(issue({ state: "CLOSED", updatedAt: "2026-10-03T00:00:00Z" }));
  db.putBacklogSnapshot(A, { records: entries(issue({ updatedAt: "2026-10-04T00:00:00Z" })), cursor: null, syncedAt: 3000 });
  const before = db.listBacklogRecords(A);
  db.close();

  db = new Db(path);
  expect(db.listBacklogRecords(A)).toEqual(before);
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ remote: issue({ updatedAt: "2026-10-04T00:00:00Z" }), fetchedAt: 3000 });
  db.close();
});

test("a record not read keeps what it had and says why; one never read says unfetched with no value", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: "c1", syncedAt: 1000 });
  db.putBacklogSnapshot(A, {
    records: [
      { objectKind: "issue", externalId: "I_12", remote: null, fetchState: "forbidden" },
      { objectKind: "comment", externalId: "I_12_c1", remote: null, fetchState: "unavailable" },
      { objectKind: "issue", externalId: "I_99", remote: null, fetchState: "unfetched" },
    ],
    cursor: "c2",
    syncedAt: 2000,
  });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ remote: issue(), fetchedAt: 1000, fetchState: "forbidden" });
  expect(db.getBacklogRecord({ ...A, objectKind: "comment", externalId: "I_12_c1" })).toMatchObject({ remote: { body: "## 回答\nA" }, fetchState: "unavailable" });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_99" })).toMatchObject({ remote: null, base: null, fetchedAt: null, fetchState: "unfetched" });
  db.close();
});

test("an import that fails half-way stores nothing: the records and the sync state stay as the last complete one left them", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: "c1", syncedAt: 1000 });
  const before = db.listBacklogRecords(A);
  const broken = [...entries(issue({ title: "changed" })), { objectKind: "issue", externalId: "I_13", remote: null, fetchState: "fetched" } as BacklogSnapshotEntry];
  expect(() => db.putBacklogSnapshot(A, { records: broken, cursor: "c2", syncedAt: 2000 })).toThrow("has no value");
  expect(db.listBacklogRecords(A)).toEqual(before);
  expect(db.getBacklogRepository(A)).toMatchObject({ cursor: "c1", lastSuccessfulSync: 1000 });

  db.setBacklogRetryAt(A, 5000);
  expect(db.getBacklogRepository(A)).toEqual({ ...A, cursor: "c1", lastSuccessfulSync: 1000, retryAt: 5000 });
  db.putBacklogSnapshot(A, { records: [], cursor: "c3", syncedAt: 6000 });
  expect(db.getBacklogRepository(A)).toEqual({ ...A, cursor: "c3", lastSuccessfulSync: 6000, retryAt: null });
  db.close();
});

test("an import does not move the base of a record with an edit waiting to be sent", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local: issue({ title: "edited here" }) }], operations: [{ issue: "I_12", targetKind: "issue", target: "I_12", kind: "set", field: "title", payload: "edited here", base: "PBI: stored" }] });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "edited there" })), cursor: null, syncedAt: 2000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ remote: { title: "edited there" }, base: { title: "PBI: stored" }, local: { title: "edited here" } });
  db.close();
});

test("putBacklogSnapshot: a write that throws midway keeps the stored values and the next import catches up (#2815)", () => {
  const path = join(dir, "switchboard.db");
  let db = new Db(path);
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: "c1", syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local: issue({ title: "edited here" }) }], operations: [{ issue: "I_12", targetKind: "issue", target: "I_12", kind: "set", field: "title", payload: "edited here", base: "PBI: stored" }] });
  const before = db.listBacklogRecords(A);
  const moved = issue({ updatedAt: "2026-10-05T00:00:00Z" });
  // the bad record sits between good ones: what came before it in the same write must not stay either
  const [first, ...rest] = entries(moved);
  const broken = [first!, { objectKind: "issue", externalId: "I_13", remote: null, fetchState: "fetched" } as BacklogSnapshotEntry, ...rest];
  expect(() => db.putBacklogSnapshot(A, { records: broken, cursor: "c2", syncedAt: 2000 })).toThrow("has no value");
  expect(db.listBacklogRecords(A)).toEqual(before);
  expect(db.getBacklogRepository(A)).toEqual({ ...A, cursor: "c1", lastSuccessfulSync: 1000, retryAt: null });
  db.close();

  // the daemon stopped there; the next start opens the same file and imports again
  db = new Db(path);
  expect(db.listBacklogRecords(A)).toEqual(before);
  db.putBacklogSnapshot(A, { records: entries(moved), cursor: "c2", syncedAt: 2000 });
  expect(db.getBacklogRepository(A)).toEqual({ ...A, cursor: "c2", lastSuccessfulSync: 2000, retryAt: null });
  expect(remotes(db, A).map((r) => [r.id, r.state])).toEqual([["I_12_c1", "fetched"], ["I_12", "fetched"], ["I_12_p", "fetched"]]);
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ remote: moved, base: issue(), local: issue({ title: "edited here", updatedAt: "2026-10-05T00:00:00Z" }), fetchedAt: 2000 });
  db.close();
});

test("the backlog operations are found by their target (#2815)", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const sqlite = new Database(path, { readonly: true });
  expect(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'backlog_operations_target'").get()).toEqual({ name: "backlog_operations_target" });
  // the same SELECT an import runs for every record it read (mergeBacklogRecord)
  const plan = sqlite
    .query("EXPLAIN QUERY PLAN SELECT * FROM backlog_operations WHERE service = ? AND host = ? AND repository = ? AND target_kind = ? AND target = ? AND kind = 'set' AND status != 'done' ORDER BY seq")
    .all("github", "github.com", "acme/app", "issue", "I_12") as Array<{ detail: string }>;
  expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX backlog_operations_target");
  sqlite.close();
});

test("a backup (snapshotTo) restores the stored backlog and the sync state", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: "c1", syncedAt: 1000 });
  db.putBacklogSnapshot(B, { records: entries(issue({ labels: [] }), "I_b"), cursor: "c2", syncedAt: 2000 });
  db.snapshotTo(join(dir, "backup.db"));
  const restored = new Db(join(dir, "backup.db"));
  for (const repo of [A, B]) {
    expect(restored.listBacklogRecords(repo)).toEqual(db.listBacklogRecords(repo));
    expect(restored.getBacklogRepository(repo)).toEqual(db.getBacklogRepository(repo));
  }
  restored.close();
  db.close();
});

test("a database from before #885 gains the backlog tables and keeps its rows", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  raw.exec("DROP TABLE backlog_records; DROP TABLE backlog_repositories; DROP TABLE backlog_operations");
  raw.query("INSERT INTO settings (key, json) VALUES ('k', '{\"a\":1}')").run();
  raw.close();

  const db = new Db(path);
  expect(db.sqlite.query("SELECT json FROM settings WHERE key = 'k'").get()).toEqual({ json: '{"a":1}' });
  expect(db.listBacklogRecords(A)).toEqual([]);
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  expect(db.listBacklogRecords(A)).toHaveLength(3);
  expect(db.listPendingBacklogOperations()).toEqual([]);
  db.close();
});

test("a pull request stored before #1183 reads as closing nothing; one with closes keeps them", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  const put = raw.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', ?, ?, ?, ?, NULL, 1000, 'fetched')");
  put.run("pull-request", "PR_40", '{"number":40,"state":"OPEN","isDraft":false,"labels":[],"updatedAt":"x","files":[]}', '{"number":40,"state":"OPEN","isDraft":false,"labels":[],"updatedAt":"x","files":[]}');
  put.run("pull-request", "PR_41", '{"number":41,"state":"OPEN","isDraft":false,"labels":[],"closes":[7],"updatedAt":"x","files":[]}', null);
  raw.close();

  const db = new Db(path);
  const byId = Object.fromEntries(db.listBacklogRecords(A).map((r) => [r.externalId, r]));
  expect(byId.PR_40).toMatchObject({ remote: { number: 40, closes: [] }, base: { number: 40, closes: [] }, local: null });
  expect(byId.PR_41).toMatchObject({ remote: { number: 41, closes: [7] }, base: null });
  db.close();
});

test("a pull request stored before #1059 (no updatedAt / files) is dropped, so the next import reads it again", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  const put = raw.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', 'pull-request', ?, ?, NULL, NULL, 1000, 'fetched')");
  put.run("PR_40", '{"number":40,"state":"OPEN","isDraft":false,"labels":[],"closes":[],"mergeCommit":null}');
  put.run("PR_41", '{"number":41,"state":"OPEN","isDraft":false,"labels":[],"closes":[],"mergeCommit":null,"updatedAt":"x","files":["a.ts"]}');
  raw.close();
  const db = new Db(path);
  expect(db.listBacklogRecords(A).map((r) => r.externalId)).toEqual(["PR_41"]);
  db.close();
});

test("migration: records stored before #651 gain closedAt / mergedAt as null, and the next import reads every Issue again, once", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  const put = raw.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', ?, ?, ?, ?, NULL, 1000, 'fetched')");
  const issue = '{"number":12,"title":"t","url":"","state":"CLOSED","stateReason":"COMPLETED","body":"","labels":[],"milestone":null,"parent":null,"subIssues":[],"createdAt":"x","updatedAt":"x"}';
  const pr = '{"number":40,"state":"MERGED","isDraft":false,"labels":[],"closes":[],"mergeCommit":"m","updatedAt":"x","files":[]}';
  put.run("issue", "I_12", issue, issue);
  put.run("pull-request", "PR_40", pr, null);
  raw.query("INSERT INTO backlog_repositories (service, host, repository, cursor, last_successful_sync, retry_at) VALUES ('github', 'github.com', 'acme/app', '2026-10-01T00:00:00Z', 1000, NULL)").run();
  raw.close();

  let db = new Db(path);
  const byId = Object.fromEntries(db.listBacklogRecords(A).map((r) => [r.externalId, r]));
  expect(byId.I_12).toMatchObject({ remote: { number: 12, closedAt: null, stateReason: "COMPLETED" }, base: { closedAt: null }, local: null });
  expect(byId.PR_40).toMatchObject({ remote: { number: 40, closedAt: null, mergedAt: null, mergeCommit: "m" } });
  expect(db.getBacklogRepository(A)).toMatchObject({ cursor: null, lastSuccessfulSync: 1000 }); // the next import starts from the beginning
  db.putBacklogSnapshot(A, { records: [], cursor: "2026-10-02T00:00:00Z", syncedAt: 2000 });
  db.close();
  db = new Db(path); // once: the cursor stored after it stays
  expect(db.getBacklogRepository(A)).toMatchObject({ cursor: "2026-10-02T00:00:00Z" });
  db.close();
});

test("migration: records stored before #1014 gain stateReason / mergeCommit as null, and the next import reads every Issue again", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  const put = raw.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', ?, ?, ?, ?, NULL, 1000, 'fetched')");
  const issue = '{"number":12,"title":"t","url":"","state":"CLOSED","body":"","labels":[],"milestone":null,"parent":null,"subIssues":[],"createdAt":"x","updatedAt":"x"}';
  put.run("issue", "I_12", issue, issue);
  put.run("pull-request", "PR_40", '{"number":40,"state":"MERGED","isDraft":false,"labels":[],"closes":[],"updatedAt":"x","files":[]}', null);
  raw.query("INSERT INTO backlog_repositories (service, host, repository, cursor, last_successful_sync, retry_at) VALUES ('github', 'github.com', 'acme/app', '2026-10-01T00:00:00Z', 1000, NULL)").run();
  raw.close();
  // made here and not sent: only `local`; the remote records already have both fields, so only it is old
  let db = new Db(path);
  db.close();
  const old = new Database(path);
  old.query("INSERT INTO backlog_records (service, host, repository, object_kind, external_id, remote, base, local, fetched_at, fetch_state) VALUES ('github', 'github.com', 'acme/app', 'issue', 'local:x', NULL, NULL, ?, NULL, 'unfetched')").run(issue.replace('"number":12', '"number":0'));
  old.close();

  db = new Db(path);
  expect(db.listBacklogRecords(A).find((r) => r.externalId === "local:x")).toMatchObject({ local: { number: 0, stateReason: null } });
  db.close();
  db = new Db(path);
  const byId = Object.fromEntries(db.listBacklogRecords(A).map((r) => [r.externalId, r]));
  expect(byId.I_12).toMatchObject({ remote: { number: 12, stateReason: null }, base: { stateReason: null }, local: null });
  expect(byId.PR_40).toMatchObject({ remote: { number: 40, mergeCommit: null } });
  expect(db.getBacklogRepository(A)).toMatchObject({ cursor: null, lastSuccessfulSync: 1000 });
  // once: a cursor stored after it stays
  db.putBacklogSnapshot(A, { records: [], cursor: "2026-10-02T00:00:00Z", syncedAt: 2000 });
  db.close();
  db = new Db(path);
  expect(db.getBacklogRepository(A)).toMatchObject({ cursor: "2026-10-02T00:00:00Z" });
  db.close();
});

// Edits made here and the operations that send them (#886).

const set = (field: string, value: unknown, base: unknown, issue = "I_12"): NewBacklogOperation => ({ issue, targetKind: "issue", target: issue, kind: "set", field, payload: value, base });
const comment = (body: string, issue = "I_12"): NewBacklogOperation => ({ issue, targetKind: "comment", target: `local:${body}`, kind: "comment", payload: { body } });
const ops = (db: Db, repo?: BacklogRepositoryKey) => db.listPendingBacklogOperations(repo).map((o) => [o.kind, o.field, o.payload]);

test("an edit and its operations are stored together: a failure half-way stores neither", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  const local = issue({ title: "edited here" });
  // the second operation cannot be stored (its payload is not JSON), after the record and the first one were
  expect(() => db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local }], operations: [set("title", "edited here", "PBI: stored"), set("body", 1n, "")] })).toThrow();
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.local).toBeNull();
  expect(db.listPendingBacklogOperations()).toEqual([]);

  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local }], operations: [set("title", "edited here", "PBI: stored")] });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.local).toEqual(local);
  expect(db.listPendingBacklogOperations(A)).toMatchObject([{ kind: "set", field: "title", payload: "edited here", base: "PBI: stored", status: "pending", attempt: 0, retryAt: null, remoteId: null }]);
  db.close();
});

test("the same Issue number of two repositories keeps its own operations", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "a", "x")] });
  db.applyBacklogEdit(B, { records: [], operations: [set("title", "b", "x")] });
  expect(ops(db, A)).toEqual([["set", "title", "a"]]);
  expect(ops(db, B)).toEqual([["set", "title", "b"]]);
  expect(ops(db)).toHaveLength(2);
  db.close();
});

test("edits of one field not sent yet become one operation with the last value; comments stay one each, in order", () => {
  const db = new Db(join(dir, "switchboard.db"));
  for (const [i, body] of ["one", "two", "three"].entries()) db.applyBacklogEdit(A, { records: [], operations: [set("body", body, i === 0 ? "orig" : "ignored")] });
  for (const body of ["c1", "c2", "c3"]) db.applyBacklogEdit(A, { records: [], operations: [comment(body)] });
  expect(ops(db)).toEqual([["set", "body", "three"], ["comment", null, { body: "c1" }], ["comment", null, { body: "c2" }], ["comment", null, { body: "c3" }]]);
  // the base stays the value the first edit was made on
  expect(db.listPendingBacklogOperations()[0]?.base).toBe("orig");
  // one already out is not changed: the next edit is its own operation
  db.setBacklogOperationResult(db.listPendingBacklogOperations()[0]!.id, { status: "sending" });
  db.applyBacklogEdit(A, { records: [], operations: [set("body", "four", "three")] });
  expect(ops(db).filter((o) => o[0] === "set")).toEqual([["set", "body", "three"], ["set", "body", "four"]]);
  db.close();
});

test("an answer is followed by its label change: a label edit queued before the answer is not moved after it", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.applyBacklogEdit(A, { records: [], operations: [set("label:needs-decision", true, false)] });
  db.applyBacklogEdit(A, { records: [], operations: [comment("## 回答\n\nA"), set("label:needs-decision", false, true)] });
  expect(ops(db)).toEqual([["set", "label:needs-decision", true], ["comment", null, { body: "## 回答\n\nA" }], ["set", "label:needs-decision", false]]);
  // a later edit of the label merges into the one after the answer
  db.applyBacklogEdit(A, { records: [], operations: [set("label:needs-decision", true, false)] });
  expect(ops(db)).toEqual([["set", "label:needs-decision", true], ["comment", null, { body: "## 回答\n\nA" }], ["set", "label:needs-decision", true]]);
  db.close();
});

test("a request out when the daemon stopped is unknown after a restart; a backup restores the edits and their operations", () => {
  const path = join(dir, "switchboard.db");
  const db = new Db(path);
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local: issue({ title: "edited" }) }], operations: [set("title", "edited", "PBI: stored"), comment("c1"), comment("c2")] });
  const [first, second] = db.listPendingBacklogOperations();
  db.setBacklogOperationResult(first!.id, { status: "done" });
  db.setBacklogOperationResult(second!.id, { status: "sending", attempt: 1 });
  db.snapshotTo(join(dir, "backup.db"));
  const before = db.listPendingBacklogOperations();
  db.close();

  for (const p of [path, join(dir, "backup.db")]) {
    const reopened = new Db(p);
    // opening the file changes nothing (main.ts export opens it while the daemon runs); the sender's start does
    expect(reopened.listPendingBacklogOperations()).toEqual(before);
    reopened.recoverBacklogOperations();
    expect(reopened.listPendingBacklogOperations()).toEqual(before.map((o) => (o.status === "sending" ? { ...o, status: "unknown" } : o)));
    expect(reopened.listPendingBacklogOperations().map((o) => o.status)).toEqual(["unknown", "pending"]);
    expect(reopened.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.local).toMatchObject({ title: "edited" });
    reopened.close();
  }
});

test("a field no import could apply is refused; an edit given only as operations shows on the record", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  expect(() => db.applyBacklogEdit(A, { records: [], operations: [set("assignee", "me", null)] })).toThrow("has no field assignee");
  expect(() => db.applyBacklogEdit(A, { records: [], operations: [{ ...set("title", "x", ""), field: undefined }] })).toThrow();
  expect(() => db.applyBacklogEdit(A, { records: [], operations: [{ issue: "I_12", targetKind: "project-item", target: "I_12_p", kind: "set", field: "title", payload: "x" }] })).toThrow();
  expect(db.listPendingBacklogOperations()).toEqual([]);
  db.applyBacklogEdit(A, { records: [], operations: [set("label:needs-decision", false, true), { issue: "I_12", targetKind: "project-item", target: "I_12_p", kind: "set", field: "field:Status", payload: "In progress", base: "Ready" }] });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.local).toMatchObject({ labels: ["type:pbi"] });
  expect(db.getBacklogRecord({ ...A, objectKind: "project-item", externalId: "I_12_p" })?.local).toMatchObject({ fields: { Status: "In progress", Priority: "P1" } });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "read again" })), cursor: null, syncedAt: 2000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })?.local).toMatchObject({ title: "read again", labels: ["type:pbi"] });
  // an edit of a record not imported yet shows once the import stores it
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "edited first", "", "I_13")] });
  db.putBacklogSnapshot(A, { records: entries(issue({ number: 13 }), "I_13"), cursor: null, syncedAt: 3000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_13" })?.local).toMatchObject({ number: 13, title: "edited first" });
  db.close();
});

test("an import shows an edit not sent on top of what was read; once sent, the record follows the service again", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "I_12", local: issue({ title: "edited here" }) }], operations: [set("title", "edited here", "PBI: stored")] });
  db.putBacklogSnapshot(A, { records: entries(issue({ body: "changed there" })), cursor: null, syncedAt: 2000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ local: { title: "edited here", body: "changed there" }, base: { title: "PBI: stored" } });
  db.setBacklogOperationResult(db.listPendingBacklogOperations()[0]!.id, { status: "done" });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "edited here", body: "changed there" })), cursor: null, syncedAt: 3000 });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })).toMatchObject({ local: null, base: { title: "edited here" } });
  db.close();
});

test("a new Issue is told apart by its local id until created; then it and the operations after it take the service's id", () => {
  const db = new Db(join(dir, "switchboard.db"));
  const draft = issue({ number: 0, url: "", labels: ["type:pbi"], parent: null, subIssues: [] });
  const [create] = db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "local:u1", local: draft }], operations: [{ issue: "local:u1", targetKind: "issue", target: "local:u1", kind: "create", payload: draft }] });
  // while it is pending, an edit of it replaces what is created
  db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: "local:u1", local: { ...draft, title: "renamed" } }], operations: [{ issue: "local:u1", targetKind: "issue", target: "local:u1", kind: "create", payload: { ...draft, title: "renamed" }, replace: create }] });
  db.setBacklogOperationResult(create!, { status: "sending", attempt: 1 });
  expect(() => db.applyBacklogEdit(A, { records: [], operations: [{ ...set("title", "x", ""), replace: create }] })).toThrow("no longer pending");
  // a replace names an operation of the same record and field: another one's payload is not overwritten
  const [title] = db.applyBacklogEdit(A, { records: [], operations: [set("title", "t", "")] });
  expect(() => db.applyBacklogEdit(A, { records: [], operations: [{ ...set("body", "b", ""), replace: title }] })).toThrow("no longer pending");
  expect(db.getBacklogOperation(title!)?.payload).toBe("t");
  db.setBacklogOperationResult(title!, { status: "done" });
  db.applyBacklogEdit(A, { records: [], operations: [set("label:needs-decision", true, false, "local:u1")] });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "local:u1" })).toMatchObject({ remote: null, fetchState: "unfetched", local: { number: 0, title: "renamed" } });

  const created = { ...draft, title: "renamed", number: 30, url: "https://github.com/acme/app/issues/30" };
  db.setBacklogOperationResult(create!, { status: "done", remoteId: "I_30", record: { externalId: "I_30", remote: created }, follow: [set("parent", 12, null, "I_30")] });
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "local:u1" })).toBeNull();
  // the operations queued after the create show on it at once
  expect(db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_30" })).toMatchObject({ remote: created, base: created, fetchState: "fetched", local: { number: 30, labels: ["type:pbi", "needs-decision"], parent: 12 } });
  expect(db.listPendingBacklogOperations().map((o) => [o.issue, o.target, o.field])).toEqual([["I_30", "I_30", "label:needs-decision"], ["I_30", "I_30", "parent"]]);
  expect(db.getBacklogOperation(create!)).toMatchObject({ status: "done", remoteId: "I_30" });
  db.close();
});

// What an import decides about the edits waiting to be sent, and the user's choice on a conflict (#887, 初期方式 A).

const statusOf = (db: Db) => Object.fromEntries(db.listPendingBacklogOperations(A).map((o) => [o.field ?? o.kind, o.status]));
const issueRec = (db: Db) => db.getBacklogRecord({ ...A, objectKind: "issue", externalId: "I_12" })!;
const op = (db: Db, field: string) => db.listPendingBacklogOperations(A).find((o) => o.field === field)!;
const revision = (db: Db, field: string) => conflictRevision(op(db, field), backlogFieldValue("issue", issueRec(db).remote, field));

test("an import compares each edit with GitHub's value: one side taken, other fields merged, both sides on one field held", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "here", "PBI: stored"), set("body", "same", "## ユーザーストーリー\n本文"), set("state", "CLOSED", "OPEN"), set("label:needs-decision", false, true), set("parent", 4, 3)] });
  db.applyBacklogEdit(A, { records: [], operations: [{ issue: "I_12", targetKind: "project-item", target: "I_12_p", kind: "set", field: "field:Status", payload: "Done", base: "Ready" }] });
  // GitHub: the same body, another parent, a new milestone (a field not edited here); the rest as it was
  db.putBacklogSnapshot(A, { records: entries(issue({ body: "same", parent: 7, milestone: "Phase 3" })), cursor: null, syncedAt: 2000 });

  // the body GitHub already has is done (not listed as waiting any more)
  expect(statusOf(db)).toEqual({ title: "pending", state: "pending", "label:needs-decision": "pending", parent: "conflict", "field:Status": "pending" });
  expect(op(db, "parent").error).toContain("GitHub は 7");
  // all three are kept: the edit's base and value with it, GitHub's as remote; the screen shows the edits on GitHub's
  expect(op(db, "parent")).toMatchObject({ base: 3, payload: 4 });
  expect(issueRec(db).remote).toMatchObject({ parent: 7, milestone: "Phase 3" });
  expect(issueRec(db).local).toMatchObject({ title: "here", body: "same", state: "CLOSED", labels: ["type:pbi"], parent: 4, milestone: "Phase 3" });
  db.close();
});

test("overwritten (#1329): a conflict found after the write survives an import at the local value; remote sends the found value back, none there is 409, an old revision 409", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "v3", "PBI: stored"), set("body", "b3", "## ユーザーストーリー\n本文")] });
  // the send wrote v3 and found, in the history, that someone wrote v2 between the check and the write
  const found = { value: "v2", editor: "them", at: "2026-10-12T10:00:00Z" };
  db.setBacklogOperationResult(op(db, "title").id, { status: "conflict", error: "書く直前に them が v2 にしていました", overwritten: found });
  // (a) GitHub reads back the local value: the conflict stays, its reason too
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "v3" })), cursor: null, syncedAt: 2000 });
  expect(op(db, "title")).toMatchObject({ status: "conflict", error: "書く直前に them が v2 にしていました", overwritten: found });
  // (d) a choice on an older screen is refused
  const seen = revision(db, "title");
  db.setBacklogOperationResult(op(db, "title").id, { status: "conflict", overwritten: { ...found, at: "2026-10-12T10:00:01Z" } });
  expect(() => db.resolveBacklogConflict(A, op(db, "title").id, "remote", seen)).toThrow(expect.objectContaining({ status: 409 }));
  // (b) remote: the found value goes back as a new set on GitHub's current value; the local view shows it
  db.resolveBacklogConflict(A, op(db, "title").id, "remote", revision(db, "title"));
  expect(op(db, "title")).toMatchObject({ status: "pending", payload: "v2", base: "v3", overwritten: null, error: null });
  expect(issueRec(db).local).toMatchObject({ title: "v2" });
  // (c) a found edit whose revision content is gone: remote is refused, local goes on at GitHub's value
  db.setBacklogOperationResult(op(db, "body").id, { status: "conflict", error: "版の内容は履歴から消されています", overwritten: { editor: "them", at: "2026-10-12T10:00:00Z" } });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "v3", body: "b3" })), cursor: null, syncedAt: 3000 });
  expect(op(db, "body").status).toBe("conflict");
  expect(() => db.resolveBacklogConflict(A, op(db, "body").id, "remote", revision(db, "body"))).toThrow(expect.objectContaining({ status: 409 }));
  db.resolveBacklogConflict(A, op(db, "body").id, "local", revision(db, "body"));
  expect(op(db, "body")).toMatchObject({ status: "pending", payload: "b3", base: "b3", overwritten: null });
  db.close();
});

test("resumeReason (#550): a database made before the column gets it on open, and its rows read as null", () => {
  const path = join(dir, "old-tasks.db");
  const raw = new Database(path);
  raw.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL, runner TEXT NOT NULL, cwd TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, runner_session_id TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, routing TEXT, budget_usd REAL, schedule_id TEXT, permission_mode TEXT, origin TEXT NOT NULL DEFAULT 'switchboard', resume_at INTEGER, shadow_of TEXT, shadow_stopped INTEGER NOT NULL DEFAULT 0, workspace_reason TEXT, outcome TEXT NOT NULL DEFAULT 'unknown', reviewed_at INTEGER, judged_result TEXT, judged_reason TEXT, judged_by TEXT, execution_mode TEXT NOT NULL DEFAULT 'local', cloud_session TEXT, source_cloud_task_id TEXT, effort TEXT)");
  raw.exec("INSERT INTO tasks (id, title, runner, cwd, scope, status, created_at, updated_at, resume_at) VALUES ('t_old', 'old', 'claude', '/work/app', '[]', 'done', 1, 1, 1000)");
  raw.close();
  const db = new Db(path);
  expect((db.sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("resume_reason");
  expect(db.getTask("t_old")).toMatchObject({ resumeAt: 1000, resumeReason: null });
  db.close();
});

test("archivedAt (#1164): listTasks() leaves archived Tasks out, listTasks(true) lists only them, and null brings one back", () => {
  const db = new Db(join(dir, "archive.db"));
  const mk = (id: string, updatedAt: number) => db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: "/work/app", scope: ["/work/app"], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "done", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: updatedAt, createdAt: updatedAt, updatedAt });
  mk("t_a", 1);
  mk("t_b", 2);
  expect(db.updateTask("t_a", { archivedAt: 5, updatedAt: 1 })).toMatchObject({ archivedAt: 5, updatedAt: 1 });
  expect(db.listTasks().map((t) => t.id)).toEqual(["t_b"]);
  expect(db.listTasks(true).map((t) => t.id)).toEqual(["t_a"]);
  expect(db.getTask("t_a")!.archivedAt).toBe(5);
  db.updateTask("t_a", { archivedAt: null, updatedAt: 1 });
  expect(db.listTasks().map((t) => t.id)).toEqual(["t_b", "t_a"]);
  expect(db.listTasks(true)).toEqual([]);
  db.close();
});

test("listEventsTail / listEventsBefore (#1165): the last `limit` events, and the page before a seq, both in seq order", () => {
  const db = new Db(join(dir, "events.db"));
  db.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES ('t_ev', 't', 'claude', '/work/app', '[]', 'done', 'switchboard', 0, 'done', 1, 1, 1)").run();
  for (let i = 0; i < 500; i++) db.appendEvent("t_ev", { t: "message.delta", role: "assistant", text: `${i}` });
  const seqs = (es: Array<{ seq: number }>) => es.map((e) => e.seq);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  expect(seqs(db.listEventsTail("t_ev", 200))).toEqual(range(301, 500));
  expect(seqs(db.listEventsBefore("t_ev", 301, 200))).toEqual(range(101, 300));
  expect(seqs(db.listEventsBefore("t_ev", 101, 200))).toEqual(range(1, 100));
  expect(db.listEventsBefore("t_ev", 1, 200)).toEqual([]);
  expect(db.listEventsTail("t_nope", 200)).toEqual([]);
  db.close();
});

/** A done task row for the events of #1878's readers. */
const eventsTask = (db: Db, id: string) =>
  db.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES (?, 't', 'claude', '/work/app', '[]', 'done', 'switchboard', 0, 'done', 1, 1, 1)").run(id);

test("created issues from events (#1878): the Issue URLs in the successful results of gh issue create / request_issue.sh, and the app's stored creates by localId, once each", () => {
  const db = new Db(join(dir, "created.db"));
  eventsTask(db, "t_c");
  const call = (id: string, command: string) => db.appendEvent("t_c", { t: "tool.call", id, name: "Bash", input: { command }, summary: command });
  const result = (id: string, summary: string, ok = true) => db.appendEvent("t_c", { t: "tool.result", id, ok, summary });
  call("a", 'gh issue create -R "$REPO" --title x --body-file b.md');
  result("a", "https://github.com/Acme/App/issues/41");
  call("b", "bash scripts/setup/request_issue.sh --title y");
  result("b", "created: https://github.com/acme/app/issues/42\nproject: added");
  call("c", "gh issue view 7 --json url");
  result("c", "https://github.com/acme/app/issues/7");
  call("d", "gh issue create --title z");
  result("d", "https://github.com/acme/app/issues/43", false);
  call("e", "gh issue create --title again");
  result("e", "https://github.com/acme/app/issues/41");
  call("f", "gh issue create -R other/tool --title w");
  result("f", "https://github.com/other/tool/issues/5");
  expect(createdIssuesOf(db.sqlite, "t_c")).toEqual([
    { repo: "acme/app", number: 41 },
    { repo: "acme/app", number: 42 },
    { repo: "other/tool", number: 5 },
  ]);
  expect(createdIssuesOf(db.sqlite, "t_none")).toEqual([]);

  // in the app's Task the create is stored first and printed as its localId, whatever command ran it; read back once it has a number
  const draft = issue({ number: 0, url: "", labels: ["type:request"], parent: null, subIssues: [] });
  const store = (localId: string) => db.applyBacklogEdit(A, { records: [{ objectKind: "issue", externalId: `local:${localId}`, local: draft }], operations: [{ id: localId, issue: `local:${localId}`, targetKind: "issue", target: `local:${localId}`, kind: "create", payload: draft }] });
  const sent = "11111111-1111-4111-8111-111111111111", waiting = "22222222-2222-4222-8222-222222222222";
  eventsTask(db, "t_app");
  db.appendEventAt("t_app", { t: "tool.call", id: "g", name: "Bash", input: { command: "bun scripts/check-models.ts" }, summary: "check-models" }, Date.now() - 1);
  const [create] = store(sent);
  store(waiting);
  db.setBacklogOperationResult(create!, { status: "done", remoteId: "I_50", record: { externalId: "I_50", remote: { ...draft, number: 50, url: "https://github.com/acme/app/issues/50" } } });
  db.appendEvent("t_app", { t: "tool.result", id: "g", ok: true, summary: `作りました（送信待ち）: localId ${sent}。番号が付く前も backlog view ${sent} で読める\n作りました（送信待ち）: localId ${waiting}。` });
  db.appendEvent("t_app", { t: "tool.call", id: "h", name: "Bash", input: { command: "ops-kit backlog create --title x" }, summary: "create" });
  db.appendEvent("t_app", { t: "tool.result", id: "h", ok: true, summary: `#50 を作りました（localId ${sent}）` });
  expect(createdIssuesOf(db.sqlite, "t_app")).toEqual([{ repo: "acme/app", number: 50 }]);
  // the same line shown again later (a log read back) is another Task's create, stored before this call ran
  eventsTask(db, "t_reader");
  db.appendEventAt("t_reader", { t: "tool.call", id: "r", name: "Bash", input: { command: "cat task.log" }, summary: "cat" }, Date.now() + 60_000);
  db.appendEventAt("t_reader", { t: "tool.result", id: "r", ok: true, summary: `作りました（送信待ち）: localId ${sent}。` }, Date.now() + 61_000);
  expect(createdIssuesOf(db.sqlite, "t_reader")).toEqual([]);
  expect(issuesInText("https://github.com/acme/app/issues/12#issuecomment-1 https://github.com/acme/app/pull/13")).toEqual([{ repo: "acme/app", number: 12 }]);
  db.close();
});

test("deferred from final summary (#1878): the last session.end's summary has a word that puts something off", () => {
  const db = new Db(join(dir, "deferred.db"));
  ["残した", "見送り", "後回し", "スコープ外", "別 Issue", "別Issue"].forEach((word, i) => {
    eventsTask(db, `t_${i}`);
    db.appendEvent(`t_${i}`, { t: "session.end", status: "ok", summary: `完了。${word}: #12` });
    expect(deferredOf(db.sqlite, `t_${i}`)).toBe(true);
  });
  eventsTask(db, "t_earlier");
  db.appendEvent("t_earlier", { t: "session.end", status: "ok", summary: "後回しにした" });
  db.appendEvent("t_earlier", { t: "session.end", status: "ok", summary: "全部できた" });
  expect(deferredOf(db.sqlite, "t_earlier")).toBe(false);
  eventsTask(db, "t_open");
  db.appendEvent("t_open", { t: "message.delta", role: "assistant", text: "見送り" });
  expect(deferredOf(db.sqlite, "t_open")).toBe(false);
  expect(DEFERRED_WORDS.test("全部できた")).toBe(false);
  db.close();
});

test("listEventsBefore (#1142): a page that starts inside a streamed message reaches back to the message's first delta", () => {
  const db = new Db(join(dir, "events-msg.db"));
  db.sqlite.query("INSERT INTO tasks (id, title, runner, cwd, scope, status, origin, shadow_stopped, outcome, created_at, updated_at, status_at) VALUES ('t_msg', 't', 'claude', '/work/app', '[]', 'done', 'switchboard', 0, 'done', 1, 1, 1)").run();
  db.appendEvent("t_msg", { t: "tool.call", id: "c1", name: "Read", summary: "Read a" }); // 1
  for (let i = 0; i < 10; i++) db.appendEvent("t_msg", { t: "message.delta", role: "assistant", text: `a${i}`, messageId: "m1" }); // 2..11
  db.appendEvent("t_msg", { t: "status", text: "thinking" }); // 12
  for (let i = 0; i < 10; i++) db.appendEvent("t_msg", { t: "message.delta", role: "assistant", text: `b${i}`, messageId: "m2" }); // 13..22
  db.appendEvent("t_msg", { t: "session.end", status: "ok" }); // 23
  const seqs = (es: Array<{ seq: number }>) => es.map((e) => e.seq);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  expect(seqs(db.listEventsTail("t_msg", 5))).toEqual(range(13, 23)); // starts at m2's first delta
  expect(seqs(db.listEventsTail("t_msg", 12))).toEqual(range(12, 23)); // starts on a status: nothing to reach for
  expect(seqs(db.listEventsBefore("t_msg", 12, 3))).toEqual(range(2, 11)); // inside m1
  expect(seqs(db.listEventsBefore("t_msg", 2, 3))).toEqual([1]);
  // seqs with holes (events moved to S3): the message's first delta is found by rows, not by seq distance
  db.sqlite.query("INSERT INTO events (task_id, seq, ts, json) VALUES ('t_hole', 1, 1, ?), ('t_hole', 9000, 2, ?), ('t_hole', 9001, 3, ?)").run(JSON.stringify({ t: "message.delta", role: "assistant", text: "a", messageId: "mh" }), JSON.stringify({ t: "message.delta", role: "assistant", text: "b", messageId: "mh" }), JSON.stringify({ t: "message.delta", role: "assistant", text: "c", messageId: "mh" }));
  expect(seqs(db.listEventsTail("t_hole", 1))).toEqual([1, 9000, 9001]);
  // a message longer than a page is cut at EVENTS_PAGE_MAX
  for (let i = 0; i < EVENTS_PAGE_MAX + 100; i++) db.appendEvent("t_msg", { t: "message.delta", role: "assistant", text: "c", messageId: "m3" });
  const page = db.listEventsTail("t_msg", 200);
  expect(page).toHaveLength(EVENTS_PAGE_MAX);
  expect(page.at(-1)!.seq).toBe(23 + EVENTS_PAGE_MAX + 100);
  db.close();
});

test("overwritten (#1329): a database made before the column gets it on open", () => {
  const path = join(dir, "old.db");
  const raw = new Database(path);
  raw.exec("CREATE TABLE backlog_operations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, service TEXT NOT NULL, host TEXT NOT NULL, repository TEXT NOT NULL, issue TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, field TEXT, payload TEXT NOT NULL, base TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, remote_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  raw.close();
  const db = new Db(path);
  expect((db.sqlite.query("PRAGMA table_info(backlog_operations)").all() as Array<{ name: string }>).map((c) => c.name)).toContain("overwritten");
  db.close();
});

test("an import decides on the first edit of a field only: the next one was made on the value the first sends", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  // on, an answer, off again: the second edit's base is the first one's value, which GitHub does not have yet
  db.applyBacklogEdit(A, { records: [], operations: [set("label:needs-decision", false, true)] });
  db.applyBacklogEdit(A, { records: [], operations: [comment("## 回答\nA"), set("label:needs-decision", true, false)] });
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 2000 });
  expect(db.listPendingBacklogOperations(A).map((o) => o.status)).toEqual(["pending", "pending", "pending"]);
  db.close();
});

test("a record not read in full decides nothing, and GitHub's own read-back of a sent edit queues nothing", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "here", "PBI: stored")] });
  db.putBacklogSnapshot(A, { records: [{ objectKind: "issue", externalId: "I_12", remote: null, fetchState: "unavailable" }], cursor: null, syncedAt: 2000 });
  expect(statusOf(db)).toEqual({ title: "pending" });

  // sent; the import after it reads it back
  db.setBacklogOperationResult(op(db, "title").id, { status: "done" });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "here" })), cursor: null, syncedAt: 3000 });
  expect(db.listPendingBacklogOperations(A)).toEqual([]);
  expect(issueRec(db).local).toBeNull();
  db.close();
});

test("a conflict is chosen on with the revision it was seen at: an old one is refused, GitHub's value or the local one is kept", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "here", "PBI: stored"), set("body", "mine", "## ユーザーストーリー\n本文")] });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "theirs", body: "theirs too" })), cursor: null, syncedAt: 2000 });
  const seen = revision(db, "title");

  // GitHub moved again after the screen read it: that choice is refused, and nothing changed
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "theirs again", body: "theirs too" })), cursor: null, syncedAt: 3000 });
  expect(op(db, "title").error).toContain('GitHub は "theirs again"');
  // back to the base on GitHub: still held (it was chosen on by no one), its reason names the value now
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "PBI: stored", body: "theirs too" })), cursor: null, syncedAt: 3500 });
  expect(op(db, "title")).toMatchObject({ status: "conflict", error: expect.stringContaining('GitHub は "PBI: stored"') });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "theirs again", body: "theirs too" })), cursor: null, syncedAt: 3600 });
  expect(() => db.resolveBacklogConflict(A, op(db, "title").id, "local", seen)).toThrow(expect.objectContaining({ status: 409 }));
  expect(statusOf(db)).toEqual({ title: "conflict", body: "conflict" });
  expect(() => db.resolveBacklogConflict(B, op(db, "title").id, "local", revision(db, "title"))).toThrow(expect.objectContaining({ status: 404 }));

  // the local value: sent again, now made on GitHub's value
  db.resolveBacklogConflict(A, op(db, "title").id, "local", revision(db, "title"));
  expect(op(db, "title")).toMatchObject({ status: "pending", base: "theirs again", payload: "here", error: null });
  expect(issueRec(db).local).toMatchObject({ title: "here" });
  // GitHub's value: the edit is dropped and GitHub's shows
  const body = op(db, "body").id;
  db.resolveBacklogConflict(A, body, "remote", revision(db, "body"));
  expect(db.getBacklogOperation(body)).toMatchObject({ status: "done", payload: "mine" });
  expect(issueRec(db).local).toMatchObject({ title: "here", body: "theirs too" });
  // chosen once: not a conflict any more
  expect(() => db.resolveBacklogConflict(A, op(db, "title").id, "remote", revision(db, "title"))).toThrow(expect.objectContaining({ status: 409 }));
  db.close();
});

test("a conflict whose value GitHub came to is done; the local value of one GitHub cannot read is not sent", () => {
  const db = new Db(join(dir, "switchboard.db"));
  db.putBacklogSnapshot(A, { records: entries(issue()), cursor: null, syncedAt: 1000 });
  db.applyBacklogEdit(A, { records: [], operations: [set("title", "here", "PBI: stored"), set("body", "mine", "## ユーザーストーリー\n本文")] });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "theirs", body: "theirs" })), cursor: null, syncedAt: 2000 });
  db.putBacklogSnapshot(A, { records: entries(issue({ title: "here", body: "theirs" })), cursor: null, syncedAt: 3000 });
  expect(statusOf(db)).toEqual({ body: "conflict" });

  db.putBacklogSnapshot(A, { records: [{ objectKind: "issue", externalId: "I_12", remote: null, fetchState: "forbidden" }], cursor: null, syncedAt: 4000 });
  const r = conflictRevision(op(db, "body"), undefined);
  expect(() => db.resolveBacklogConflict(A, op(db, "body").id, "local", r)).toThrow(expect.objectContaining({ status: 409 }));
  db.resolveBacklogConflict(A, op(db, "body").id, "remote", r);
  expect(db.listPendingBacklogOperations(A)).toEqual([]);
  db.close();
});

test("opening the database while another connection writes waits instead of failing (BUSY_SNAPSHOT, #1597)", async () => {
  const path = join(dir, "busy.sqlite");
  new Db(path).sqlite.close();
  // a busy daemon: small write transactions one after another for about 2 s
  const writer = Bun.spawn(
    ["bun", "-e", `import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]); d.exec("PRAGMA busy_timeout = 5000"); d.exec("CREATE TABLE IF NOT EXISTS w (x)"); console.log("ready"); const end = Date.now() + 2000; while (Date.now() < end) { d.exec("BEGIN IMMEDIATE"); d.exec("INSERT INTO w VALUES (1)"); d.exec("COMMIT"); }`, path],
    { stdout: "pipe" },
  );
  const reader = writer.stdout.getReader();
  await reader.read(); // "ready"
  let opened = 0;
  while (writer.exitCode === null) {
    new Db(path).sqlite.close(); // the CLI (events-archive) opens the file the same way while the daemon writes
    opened++;
    await Bun.sleep(1);
  }
  expect(await writer.exited).toBe(0);
  expect(opened).toBeGreaterThan(0);
}, 15_000);

test("stage: a database from before #1139 takes the Issue and stage of a stage Task from its title once, and four lookups read the columns", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  raw.exec("DROP INDEX tasks_stage; ALTER TABLE tasks DROP COLUMN stage_issue; ALTER TABLE tasks DROP COLUMN stage_action");
  const put = raw.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, created_at, updated_at, status_at) VALUES (?1, 'ws', ?2, 'claude', '/tmp', '[]', ?3, ?4, ?5, ?5)");
  put.run("t_impl", "#305 実装: 題", "running", 1, 1);
  put.run("t_check", "#305 状況確認: 題", "done", 2, 2);
  put.run("t_memo", "#12 メモ", "running", 3, 3);
  put.run("t_renamed", "#305 実装 (改名)", "running", 4, 4);
  raw.close();

  const db = new Db(path);
  expect(db.getTask("t_impl")!.stage).toEqual({ issue: 305, action: "complete" });
  expect(db.getTask("t_check")!.stage).toEqual({ issue: 305, action: "check" });
  expect(db.getTask("t_memo")!.stage).toBeNull();
  expect(db.getTask("t_renamed")!.stage).toBeNull();
  expect(db.activeStageTask("ws", 305)!.id).toBe("t_impl");
  expect(db.lastStageTask("ws", 305)!.id).toBe("t_check");
  expect(db.lastStageTask("ws", 305, "complete")!.id).toBe("t_impl");
  expect(db.lastStageTask("other", 305)).toBeNull();
  expect(db.stageTaskIds("ws", 305).sort()).toEqual(["t_check", "t_impl"]);
  expect(db.listActiveStageTasks().map((t) => t.id)).toEqual(["t_impl"]);

  const t = { ...db.getTask("t_impl")!, id: "t_new", stage: { issue: 9, action: "close" as const } };
  db.insertTask(t);
  expect(db.getTask("t_new")!.stage).toEqual({ issue: 9, action: "close" });
  db.close();
  // opening again does not read the titles a second time: a title that now looks like a stage Task's stays a plain Task
  const raw2 = new Database(path);
  raw2.query("UPDATE tasks SET title = '#306 実装: 後から' WHERE id = 't_memo'").run();
  raw2.close();
  const again = new Db(path);
  expect(again.getTask("t_memo")!.stage).toBeNull();
  again.close();
});

test("ask_answers: an answer and a failed start are kept apart, one never drops the other, and the old ones are pruned (#1139)", () => {
  const db = new Db(join(dir, "asks.db"));
  const result = { ask: null, already: false, changes: [] };
  db.rememberAskAnswer("a", { at: 100, failure: { at: 100, reason: "no runner" } });
  expect(db.askAnswer("a")).toEqual({ at: 100, result: null, failure: { at: 100, reason: "no runner" } });
  db.rememberAskAnswer("a", { at: 200, result });
  expect(db.askAnswer("a")).toEqual({ at: 200, result, failure: { at: 100, reason: "no runner" } });
  db.rememberAskAnswer("b", { at: 300, result });
  expect(db.askAnswer("nothing")).toBeNull();
  db.pruneAskAnswers(200); // 200 itself stays
  expect(db.askAnswer("a")).not.toBeNull();
  db.pruneAskAnswers(201);
  expect(db.askAnswer("a")).toBeNull();
  expect(db.askAnswer("b")).not.toBeNull();
  db.close();
});

test("ledger day is the JST date (#2028): a row at 15:30 UTC falls on the next day, whatever the daemon's time zone", () => {
  const db = new Db(join(dir, "switchboard.db"));
  const row = (ts: number, costUsd: number) => ({ taskId: "t1", runner: "claude" as const, model: null, inputTokens: 1, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd, billedUsd: 0, source: "reported", ts });
  db.insertLedger(row(Date.parse("2026-10-19T14:59:00Z"), 1)); // 23:59 JST on 10/19
  db.insertLedger(row(Date.parse("2026-10-19T15:30:00Z"), 2)); // 00:30 JST on 10/20
  const now = Date.parse("2026-10-19T16:00:00Z"); // 01:00 JST on 10/20
  expect(db.ledgerDaily(2, now).map((r) => [r.day, r.costUsd])).toEqual([["2026-10-19", 1], ["2026-10-20", 2]]);
  expect(db.ledgerSummary(now).todayUsd).toBe(2);
  expect(db.ledgerDaily(1, now).map((r) => r.day)).toEqual(["2026-10-20"]);
  db.close();
});

test("statusAt moves only on a status change (#2029): title, outcome, 確認済み and a patch to the same status leave it", () => {
  const db = new Db(join(dir, "switchboard.db"));
  const base = { id: "t1", workspaceId: null, title: "t", runner: "claude" as const, cwd: "/w", scope: ["/w"], status: "running" as const, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard" as const, resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown" as const, reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1_000, createdAt: 1_000, updatedAt: 1_000 };
  db.insertTask(base);
  expect(db.getTask("t1")!.statusAt).toBe(1_000);
  db.updateTask("t1", { title: "renamed", updatedAt: 2_000 });
  db.updateTask("t1", { status: "running", updatedAt: 2_500 });
  expect(db.getTask("t1")!).toMatchObject({ statusAt: 1_000, updatedAt: 2_500 });
  db.updateTask("t1", { status: "done", updatedAt: 3_000 });
  expect(db.getTask("t1")!.statusAt).toBe(3_000);
  db.updateTask("t1", { outcome: "done", updatedAt: 4_000 });
  db.updateTask("t1", { reviewedAt: 5_000, updatedAt: 5_000 });
  db.updateTask("t1", { judgedResult: "done", judgedReason: "ok", judgedBy: "claude:x", updatedAt: 6_000 });
  expect(db.getTask("t1")!).toMatchObject({ status: "done", statusAt: 3_000, updatedAt: 6_000 });
  // a reply runs it again: running from that turn on
  db.updateTask("t1", { status: "running", updatedAt: 7_000 });
  expect(db.getTask("t1")!).toMatchObject({ statusAt: 7_000, createdAt: 1_000 });
  db.close();
});

test("statusAt migration (#2029): a tasks table without status_at gets each row's updated_at", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  raw.exec("ALTER TABLE tasks DROP COLUMN status_at");
  const put = raw.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, created_at, updated_at) VALUES (?, 'ws', ?, 'claude', '/tmp', '[]', ?, ?, ?)");
  put.run("t_old", "old", "done", 1_000, 9_000);
  put.run("t_run", "run", "running", 2_000, 3_000);
  raw.close();
  const db = new Db(path);
  expect(db.getTask("t_old")!).toMatchObject({ statusAt: 9_000, updatedAt: 9_000 });
  expect(db.getTask("t_run")!).toMatchObject({ statusAt: 3_000, updatedAt: 3_000 });
  db.close();
  const check = new Database(path);
  expect((check.query("SELECT count(*) AS n FROM tasks WHERE status_at IS NULL").get() as { n: number }).n).toBe(0);
  check.close();
});

test("migration (#2656): the global backlogSweep moves to every workspace once and leaves settings", () => {
  const path = join(dir, "switchboard.db");
  const pre = new Db(path);
  pre.upsertWorkspace({ name: "sb", path: "/w/sb", kind: "meta" });
  pre.upsertWorkspace({ name: "lib", path: "/w/lib", kind: "repo" });
  pre.setSetting("settings", { backlogSweep: { implement: 2, plan: 0 }, titles: { auto: false } });
  pre.close();
  const raw = new Database(path);
  raw.exec("ALTER TABLE workspaces DROP COLUMN sweep_implement");
  raw.exec("ALTER TABLE workspaces DROP COLUMN sweep_plan");
  raw.close();
  const db = new Db(path);
  expect(db.listWorkspaces().map((w) => [w.name, w.sweep])).toEqual([["lib", { implement: 2, plan: 0 }], ["sb", { implement: 2, plan: 0 }]]);
  const settings = db.getSetting<Record<string, unknown>>("settings", {});
  expect(settings).toMatchObject({ titles: { auto: false } });
  expect("backlogSweep" in settings).toBe(false);
  // once: a later change is not undone by the next open, and a new workspace starts with 1 / 1
  db.setWorkspaceSweep(db.listWorkspaces().find((w) => w.name === "lib")!.id, { plan: 3 });
  db.close();
  const again = new Db(path);
  expect(again.listWorkspaces().map((w) => [w.name, w.sweep])).toEqual([["lib", { implement: 2, plan: 3 }], ["sb", { implement: 2, plan: 0 }]]);
  expect(again.upsertWorkspace({ name: "app", path: "/w/app", kind: "repo" }).sweep).toEqual({ implement: 1, plan: 1 });
  expect(again.listWorkspaces().find((w) => w.name === "app")!.sweep).toEqual({ implement: 1, plan: 1 });
  again.close();
});

test("api requests (#2101): saved as given, rows older than 7 days dropped on the next save", () => {
  const db = new Db(join(dir, "switchboard.db"));
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  const row = (ts: number, route: string) => ({ ts, method: "GET", route, status: 200, ms: 1.5, bytes: null });
  db.insertApiRequests([row(now - 8 * DAY, "/api/old")], now - 8 * DAY);
  db.insertApiRequests([row(now - 6 * DAY, "/api/kept"), { ts: now, method: "POST", route: "/api/tasks/:id/send", status: 202, ms: 80.25, bytes: 17 }], now);
  expect(db.sqlite.query("SELECT method, route, status, ms, bytes FROM api_requests ORDER BY ts").all()).toEqual([
    { method: "GET", route: "/api/kept", status: 200, ms: 1.5, bytes: null },
    { method: "POST", route: "/api/tasks/:id/send", status: 202, ms: 80.25, bytes: 17 },
  ]);
  db.close();
});

test("size classes (#2103): small up to 1,000 events, medium up to 5,000, large above; no count is no class", () => {
  expect([0, 1000, 1001, 5000, 5001, null].map(sizeClass)).toEqual(["small", "small", "medium", "medium", "large", null]);
});

test("ledger migration (#2353): a Task's Claude rows become the difference of the running totals; one-shot rows stay", () => {
  const path = join(dir, "switchboard.db");
  new Db(path).close();
  const raw = new Database(path);
  raw.exec("ALTER TABLE ledger DROP COLUMN reported_total");
  const put = raw.query("INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, billed_usd, source, ts) VALUES (?, ?, 'm', 1, 1, 0, 0, ?, ?, ?, ?)");
  const ev = raw.query("INSERT INTO events (task_id, seq, ts, json) VALUES (?, ?, ?, ?)");
  const usage = (source: string) => JSON.stringify({ t: "usage", source, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  // t1: three turns of one process (1.0 → 1.5 → 2.25), a repeat (2.25), then a new session that started from 0 (0.4)
  // t1 resumes s1 on its next turn; t2 has no session to resume
  raw.query("INSERT INTO tasks (id, workspace_id, title, runner, cwd, scope, status, status_at, created_at, updated_at, runner_session_id) VALUES (?, 'ws', 't', 'claude', '/w', '[]', 'done', 1, 1, 1, ?)").run("t1", "s1");
  [1.0, 1.5, 2.25, 2.25, 0.4].forEach((c, i) => {
    put.run("t1", "claude", c, i === 1 ? 7 : c, "reported", 100 + i);
    ev.run("t1", i + 1, 100 + i, usage("reported"));
  });
  put.run("t1", "claude", 0.02, 0.02, "reported", 500); // the judge's one-shot row: no usage event at its time
  put.run("t2", "claude", 3.0, 0, "reported", 600);
  ev.run("t2", 1, 600, usage("reported"));
  put.run("t3", "codex", 0.5, 0.5, "priced", 700); // other runners: left alone
  ev.run("t3", 1, 700, usage("turn"));
  raw.close();
  new Db(path).close();
  const check = new Database(path);
  expect(check.query("SELECT task_id AS t, cost_usd AS c, billed_usd AS b, reported_total AS r FROM ledger ORDER BY id").all()).toEqual([
    { t: "t1", c: 1.0, b: 1.0, r: '{"costUsd":1,"migrated":true,"session":"s1"}' },
    { t: "t1", c: 0.5, b: 7, r: '{"costUsd":1.5,"migrated":true,"session":"s1"}' }, // a billed figure that was not the cost stays
    { t: "t1", c: 0.75, b: 0.75, r: '{"costUsd":2.25,"migrated":true,"session":"s1"}' },
    { t: "t1", c: 0, b: 0, r: '{"costUsd":2.25,"migrated":true,"session":"s1"}' },
    { t: "t1", c: 0.4, b: 0.4, r: '{"costUsd":0.4,"migrated":true,"session":"s1"}' },
    { t: "t1", c: 0.02, b: 0.02, r: null },
    { t: "t2", c: 3.0, b: 0, r: '{"costUsd":3,"migrated":true}' },
    { t: "t3", c: 0.5, b: 0.5, r: null },
  ]);
  check.close();
  // the next start does not move them again
  new Db(path).close();
  const again = new Database(path);
  expect((again.query("SELECT SUM(cost_usd) AS s FROM ledger WHERE task_id = 't1'").get() as { s: number }).s).toBeCloseTo(2.67, 10);
  again.close();
});
