import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { answerStoredDecision, commentStoredIssue, createStoredIssue, editStoredIssue, readStoredIssue, type GhRunner } from "./backlog.ts";
import { forgeKind, Limit, sendGithubOperations } from "./backlog-send.ts";
import { backlogFieldValue, conflictRevision } from "./backlog-merge.ts";
import { BacklogSync } from "./backlog-sync.ts";
import { fakeGithub as makeFakeGithub, type Issue } from "./backlog-fake-github.ts";

// Sending the edits kept here (#886) to a fake GitHub: what it ends up with, and what was asked of it.

const S: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const fakeGithub = () => makeFakeGithub(() => t);

/** The fake GitHub answering an import's reads too (backlog-sync.ts), from the same Issues. */
function importsToo(g: ReturnType<typeof fakeGithub>): GhRunner {
  const raw = (i: Issue) => ({ id: i.node_id, number: i.number, title: i.title, url: "", state: i.state, body: i.body, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", milestone: null, parent: null,
    labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) }, subIssues: { totalCount: 0, nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, projectItems: { totalCount: 0, nodes: [] } });
  const page = (nodes: unknown[]) => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" });
  return async (args, cwd) => {
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/orgs/acme/projects/1\n", stderr: "" };
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes("states:[OPEN,CLOSED]")) return page([raw(g.issues.get(12)!)]);
    if (q.includes("states:OPEN")) return page([]);
    if (q.includes("issueOrPullRequest")) return { code: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries([...q.matchAll(/w(\d+): /g)].map((m) => [`w${m[1]}`, { __typename: "Issue", ...raw(g.issues.get(Number(m[1]))!) }])) } }), stderr: "" };
    return g.gh(args, cwd);
  };
}

const syncs: BacklogSync[] = [];
function makeSync(...args: ConstructorParameters<typeof BacklogSync>): BacklogSync {
  const sync = new BacklogSync(...args);
  syncs.push(sync);
  return sync;
}

let dir: string;
let db: Db;
let t = 1_000_000;
const clock = () => t;
function seed(db: Db) {
  const issue: BacklogIssueData = { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "needs-decision"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null };
  db.putBacklogSnapshot(S, { records: [
    { objectKind: "issue", externalId: "I_12", remote: issue, fetchState: "fetched" },
    { objectKind: "issue", externalId: "I_3", remote: { ...issue, number: 3, title: "親", labels: ["type:pbi"] }, fetchState: "fetched" },
    { objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Backlog" } }, fetchState: "fetched" },
  ], cursor: null, syncedAt: 1 });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-send-"));
  db = new Db(join(dir, "switchboard.db"));
  seed(db);
});
afterEach(() => {
  for (const sync of syncs.splice(0)) sync.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const send = (gh: GhRunner) => sendGithubOperations(gh, db, dir, S, clock);
const statuses = () => db.listPendingBacklogOperations(S).map((o) => [o.kind, o.field, o.status]);

test("a field is written only while GitHub still has the value it was made on; one changed there is held and nothing is written", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "直した題" });
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(12)!.title).toBe("直した題");
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/12"]);

  editStoredIssue(db, S, 12, { body: "手元の本文" });
  g.issues.get(12)!.body = "GitHub で書いた本文";
  g.writes.length = 0;
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["set", "body", "conflict"]]);
  expect(g.writes).toEqual([]);
  expect(g.issues.get(12)!.body).toBe("GitHub で書いた本文");
});

test("an edit an import held as a conflict is not written; one whose conflict is chosen on during a run is not sent (#887)", async () => {
  const g = fakeGithub();
  // #3 first: the run reaches #12 after it
  editStoredIssue(db, S, 3, { title: "親の新しい題" });
  editStoredIssue(db, S, 12, { title: "手元の題" });
  // an import reads another title on GitHub: held before any send
  const twelve = db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote as BacklogIssueData;
  g.issues.get(12)!.title = "GitHub の題";
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: { ...twelve, title: "GitHub の題" }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  const held = db.listPendingBacklogOperations(S).find((o) => o.issue === "I_12")!;
  expect(held.status).toBe("conflict");
  // while the run writes #3, the user keeps GitHub's title of #12
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (args.includes("PATCH") && db.getBacklogOperation(held.id)!.status === "conflict") db.resolveBacklogConflict(S, held.id, "remote", conflictRevision(db.getBacklogOperation(held.id)!, "GitHub の題"));
    return r;
  };
  expect(await send(gh)).toBe(1);
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/3"]);
  expect(db.getBacklogOperation(held.id)!.status).toBe("done");
  expect(g.issues.get(12)!.title).toBe("GitHub の題");
  expect(backlogFieldValue("issue", db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.local ?? db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote, "title")).toBe("GitHub の題");
});

test("A's window, replayed (#887): an edit on GitHub between the check and the write is overwritten and not seen; one after the write is held — neither is told as kept", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  // someone writes on GitHub right after the check read (v1 → v2), then this write lands (v3)
  let between: (() => void) | null = () => (g.issues.get(12)!.title = "GitHub の v2");
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (between && args.some((a) => a.includes("issue(number:$n)"))) between(), (between = null);
    return r;
  };
  editStoredIssue(db, S, 12, { title: "手元の v3" });
  expect(await send(gh)).toBe(1);
  // v2 is gone and nothing here saw it: the check after the write reads its own v3 (the fake's history has no event
  // for the edit — with one, the read after the write holds the edit: the tests of #1329 below)
  expect(g.issues.get(12)!.title).toBe("手元の v3");
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  // what is told with the Issue says so, and does not claim it was kept
  const told = readStoredIssue(db, ws, 12)!;
  expect(told.limits).toContain("上書きしうる");
  expect(told.limits).toContain("#1329");
  expect(told.limits).toContain("Project フィールド");
  expect(told.limits).not.toMatch(/保証します|防ぎます/);

  // someone writes right after this write, before the check after it: seen, held with GitHub's value
  let written = false;
  const gh2: GhRunner = async (args, cwd) => {
    if (written && args.some((a) => a.includes("issue(number:$n)"))) (g.issues.get(12)!.title = "GitHub の v5"), (written = false);
    const r = await g.gh(args, cwd);
    if (args.includes("PATCH")) written = true;
    return r;
  };
  editStoredIssue(db, S, 12, { title: "手元の v4" });
  expect(await send(gh2)).toBe(0);
  expect(g.issues.get(12)!.title).toBe("GitHub の v5");
  expect(readStoredIssue(db, ws, 12)!.held).toEqual([expect.objectContaining({ field: "title", status: "conflict", reason: expect.stringContaining("GitHub の v5") })]);
});

test("an answer is posted with its marker, then the label comes off; the comment takes GitHub's id", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "A で");
  expect(await send(g.gh)).toBe(2);
  expect(g.writes).toEqual(["POST repos/acme/app/issues/12/comments", "DELETE repos/acme/app/issues/12/labels/needs-decision"]);
  expect(g.issues.get(12)!.comments[0]!.body).toMatch(/^## 回答\n\nA で\n\n<!-- switchboard-op:[0-9a-f-]+ -->$/);
  expect(g.issues.get(12)!.labels).toEqual(["type:pbi"]);
  expect(db.getBacklogRecord({ ...S, objectKind: "comment", externalId: "IC_12_0" })).toMatchObject({ fetchState: "fetched", local: null });
  expect(statuses()).toEqual([]);
});

test("an answer GitHub posted but whose reply was lost is found by its marker, not posted again; the label waits for it", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "A で");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502, after: true });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["comment", null, "unknown"], ["set", "label:needs-decision", "pending"]]);
  expect(g.issues.get(12)!.labels).toContain("needs-decision");
  // the daemon restarts in between: nothing changes for an unknown one
  db.recoverBacklogOperations();
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  expect(g.issues.get(12)!.labels).toEqual(["type:pbi"]);
});

test("GitHub not reached at all: nothing left, so a post waits as it was and is sent once GitHub answers; it is not a try", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "オフラインで書いた");
  const offline = { code: 1, stdout: "", stderr: "error connecting to api.github.com" };
  await expect(send(async () => offline)).rejects.toBeInstanceOf(Limit);
  // it waits for the repository (BacklogSync keeps the time), not for a time of its own: once GitHub answers it goes
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "pending", attempt: 0, retryAt: null });
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
});

test("the state and a Project field of an Issue are written, each checked first", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED", fields: { Status: "Ready" }, labels: { add: ["TYPE:PBI"], remove: [] } });
  // a label GitHub has under another case is already there
  expect(await send(g.gh)).toBe(3);
  expect(g.issues.get(12)!.state).toBe("CLOSED");
  expect(g.items.get("PVTI_I_12")!.fields.Status).toBe("Ready");
  expect(g.writes.map((w) => (w.includes("updateProjectV2ItemFieldValue") ? "updateProjectV2ItemFieldValue" : w))).toEqual(["PATCH repos/acme/app/issues/12", "updateProjectV2ItemFieldValue"]);
});

test("Status の順の変更が競合しない (#2694): two Status edits stored one after the other are sent as the later; one written to GitHub around the store is held", async () => {
  // a Task's order: In progress, then In review, both stored here; the second is made on the first
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { fields: { Status: "In progress" } });
  editStoredIssue(db, S, 12, { fields: { Status: "In review" } });
  await send(g.gh);
  expect(db.listPendingBacklogOperations(S).filter((o) => o.status === "conflict")).toEqual([]);
  expect(g.items.get("PVTI_I_12")!.fields.Status).toBe("In review");

  // what happened before: In progress written to GitHub directly, In review stored on the Backlog it had not seen
  const d2 = new Db(join(dir, "other.db"));
  seed(d2);
  const g2 = fakeGithub();
  g2.items.get("PVTI_I_12")!.fields.Status = "In progress";
  editStoredIssue(d2, S, 12, { fields: { Status: "In review" } });
  await sendGithubOperations(g2.gh, d2, dir, S, clock);
  expect(d2.listPendingBacklogOperations(S).map((o) => [o.field, o.status])).toEqual([["field:Status", "conflict"]]);
  expect(g2.items.get("PVTI_I_12")!.fields.Status).toBe("In progress");
  d2.close();
});

test("後の編集が GitHub と同じなら競合にしない (#2924): GitHub already at the last of the field's edits settles all of them; another last value is still held", async () => {
  const done = () => db.listPendingBacklogOperations(S).filter((o) => o.field === "field:Status");
  // a Task's comment between its Status edits keeps them apart (a pending set is replaced only while nothing follows it)
  const stack = (d: Db, ...values: string[]) => values.forEach((v, i) => { if (i) commentStoredIssue(d, S, 12, `PR: #${i}`); editStoredIssue(d, S, 12, { fields: { Status: v } }); });
  const writes = (g: ReturnType<typeof fakeGithub>) => g.writes.filter((w) => w.includes("updateProjectV2ItemFieldValue"));

  // (a) the import reads GitHub at Done (its automation closed the Issue) before anything was sent
  const g = fakeGithub();
  stack(db, "In progress", "In review", "Done");
  g.items.get("PVTI_I_12")!.fields.Status = "Done";
  db.putBacklogSnapshot(S, { records: [{ objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Done" } }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  expect(done()).toEqual([]);
  await send(g.gh);
  expect(writes(g)).toEqual([]);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);

  // (b) no import between: the check before each write finds GitHub at the last value
  const d2 = new Db(join(dir, "b.db"));
  seed(d2);
  const g2 = fakeGithub();
  stack(d2, "In progress", "In review", "Done");
  g2.items.get("PVTI_I_12")!.fields.Status = "Done";
  await sendGithubOperations(g2.gh, d2, dir, S, clock);
  expect(d2.listPendingBacklogOperations(S).map((o) => [o.field, o.status])).toEqual([]);
  expect(writes(g2)).toEqual([]);
  d2.close();

  // (b′) back to where GitHub is: the first edit's base is GitHub's value too, and still nothing is written
  const d4 = new Db(join(dir, "d.db"));
  seed(d4);
  const g4 = fakeGithub();
  stack(d4, "In progress", "Backlog");
  await sendGithubOperations(g4.gh, d4, dir, S, clock);
  expect(d4.listPendingBacklogOperations(S)).toEqual([]);
  expect(writes(g4)).toEqual([]);
  d4.close();

  // (c) the last edit is not GitHub's value: the conflict stays
  const d3 = new Db(join(dir, "c.db"));
  seed(d3);
  const g3 = fakeGithub();
  stack(d3, "In progress", "In review");
  g3.items.get("PVTI_I_12")!.fields.Status = "Done";
  await sendGithubOperations(g3.gh, d3, dir, S, clock);
  expect(d3.listPendingBacklogOperations(S).map((o) => [o.field, o.status])).toEqual([["field:Status", "conflict"], [null, "pending"], ["field:Status", "pending"]]);
  expect(writes(g3)).toEqual([]);
  d3.close();
});

test("a label added, a milestone, a parent and leaving the Project are each sent", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { labels: { add: ["P1"], remove: [] }, milestone: "Phase 2", parent: 3, project: false });
  expect(await send(g.gh)).toBe(4);
  expect(g.issues.get(12)).toMatchObject({ labels: ["type:pbi", "needs-decision", "P1"], milestone: 7, parent: 3 });
  expect(g.items.has("PVTI_I_12")).toBe(false);
  // and back: the milestone off, under no parent
  editStoredIssue(db, S, 12, { milestone: null, parent: null });
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)).toMatchObject({ milestone: null, parent: null });
});

test("a look for an unknown post that fails keeps it unknown: it is looked for again, never posted again", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "A で");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502, after: true });
  await send(g.gh);
  g.fail.push({ match: (a) => a[1]!.includes("/comments?"), status: 503 });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()[0]).toEqual(["comment", null, "unknown"]);
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
});

test("a post GitHub refused is failed, not unknown; a limit on a post stops the run with it pending", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "長すぎる");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 422 });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["comment", null, "failed"], ["set", "label:needs-decision", "pending"]]);
  db.sqlite.query("DELETE FROM backlog_operations").run();
  answerStoredDecision(db, S, 12, "制限中");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 429 });
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  expect(statuses()[0]).toEqual(["comment", null, "pending"]);
  expect(g.issues.get(12)!.comments).toHaveLength(0);
});

test("a create whose later step fails for good keeps the Issue it made: the record takes its id, nothing is made twice", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "選択肢の無い Status", body: "", labels: [], milestone: null, parent: null, fields: { Status: "無い選択肢" } });
  expect(await send(g.gh)).toBe(0);
  const made = [...g.issues.values()].find((i) => i.title === "選択肢の無い Status")!;
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "failed", remoteId: made.node_id, target: made.node_id });
  expect(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: made.node_id })?.remote).toMatchObject({ number: made.number });
  await send(g.gh);
  expect([...g.issues.values()].filter((i) => i.title === "選択肢の無い Status")).toHaveLength(1);
});

test("a permission refused on one thing fails that operation only; the login refused stops the run and says why", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "ロックされた Issue へ");
  editStoredIssue(db, S, 3, { title: "別の Issue" });
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 403 });
  expect(await send(g.gh)).toBe(1);
  expect(statuses()).toEqual([["comment", null, "failed"], ["set", "label:needs-decision", "pending"]]);
  expect(g.issues.get(3)!.title).toBe("別の Issue");
  db.sqlite.query("DELETE FROM backlog_operations").run();
  editStoredIssue(db, S, 12, { title: "期限切れ" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 401 });
  await expect(send(g.gh)).rejects.toMatchObject({ kind: "auth" });
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "pending", attempt: 0, error: expect.stringContaining("ログイン") });
});

test("a field read again right after it was written: another value there is held as a conflict", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "こちらの題" });
  // someone writes the title between this write and the read after it
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (args.includes("PATCH")) g.issues.get(12)!.title = "あちらの題";
    return r;
  };
  expect(await send(gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", error: expect.stringContaining('GitHub は "あちらの題"') });
});

test("a field edit left unknown by a restart is checked again like any edit: refused, it is failed, not unknown", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "再起動の前" });
  db.setBacklogOperationResult(db.listPendingBacklogOperations(S)[0]!.id, { status: "sending" });
  db.recoverBacklogOperations();
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 422 });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["set", "title", "failed"]]);
});

test("a Project item added and taken out again before anything was sent: nothing is sent for it, and the Issue goes on", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 3, { fields: { Status: "Ready" } });
  editStoredIssue(db, S, 3, { project: false });
  editStoredIssue(db, S, 3, { title: "その後の編集" });
  // the add and its removal end in one (taken out: nothing to do), its field is not sent, the title is
  expect(await send(g.gh)).toBe(2);
  expect(statuses()).toEqual([]);
  // the item never made is not shown, and in the Project again makes a new one
  expect(db.listBacklogRecords(S, "project-item").filter((r) => r.externalId.startsWith("local:")).map((r) => r.local)).toEqual([null]);
  editStoredIssue(db, S, 3, { project: true });
  expect(statuses()).toEqual([["set", "member", "pending"]]);
  expect([...g.items.values()].some((i) => i.issue === "I_3")).toBe(false);
  expect(g.issues.get(3)!.title).toBe("その後の編集");
});

// The read after a write carries the history (#1329): what another login wrote in the window is held, not lost.

const later = () => new Date(t + 1000).toISOString();

test("history (#1329): another login's edit between the check and the write is held with its value, editor and time — for each field the history tells; one that made the field the value sent is nothing lost", async () => {
  const cases: Array<{ edit: object; field: string; theirs: { field: string; value?: unknown; deleted?: boolean }; expect: Record<string, unknown> | "done" }> = [
    { edit: { title: "手元の題" }, field: "title", theirs: { field: "title", value: "相手の題" }, expect: { value: "相手の題" } },
    { edit: { body: "手元の本文" }, field: "body", theirs: { field: "body", value: "相手の本文" }, expect: { value: "相手の本文" } },
    { edit: { body: "手元の本文" }, field: "body", theirs: { field: "body", deleted: true }, expect: { editor: "them" } },
    { edit: { state: "CLOSED" }, field: "state", theirs: { field: "state", value: "CLOSED" }, expect: "done" },
    { edit: { labels: { add: [], remove: ["needs-decision"] } }, field: "label:needs-decision", theirs: { field: "label:needs-decision", value: true }, expect: { value: true } },
    { edit: { milestone: "Phase 2" }, field: "milestone", theirs: { field: "milestone", value: "Phase 3" }, expect: { value: "Phase 3" } },
    { edit: { parent: 3 }, field: "parent", theirs: { field: "parent", value: null }, expect: { value: null } },
    { edit: { fields: { Status: "Ready" } }, field: "field:Status", theirs: { field: "field:Status", value: "Done" }, expect: { value: "Done" } },
  ];
  for (const [i, c] of cases.entries()) {
    const g = fakeGithub();
    const d = new Db(join(dir, `case${i}.db`));
    seed(d);
    g.history.push({ issue: 12, by: "them", at: later(), ...c.theirs });
    editStoredIssue(d, S, 12, c.edit as never, t);
    const n = await sendGithubOperations(g.gh, d, dir, S, clock);
    const op = d.listPendingBacklogOperations(S).find((o) => o.field === c.field);
    if (c.expect === "done") {
      expect([c.field, n, op]).toEqual([c.field, 1, undefined]);
    } else {
      expect([c.field, n]).toEqual([c.field, 0]);
      expect(op).toMatchObject({ status: "conflict", overwritten: { editor: "them", at: later(), ...c.expect }, error: expect.stringContaining("them") });
      if (!("value" in c.expect)) expect(op!.overwritten).not.toHaveProperty("value");
    }
    d.close();
  }
});

test("history (#1329): the history refused or not read whole after the write holds the edit as unverified — never failed or pending; a write refused with 412 or 409 is held too", async () => {
  const g = fakeGithub();
  const afterRead = (a: string[]) => a.some((x) => x.includes("timelineItems"));
  // refused (403): GitHub has the value, nothing is known of the window
  g.fail.push({ match: afterRead, status: 403 });
  editStoredIssue(db, S, 12, { title: "v3" }, t);
  expect(await send(g.gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", overwritten: { editor: null, at: null, unreadable: expect.stringContaining("403") }, error: expect.stringContaining("読めませんでした") });
  expect(g.issues.get(12)!.title).toBe("v3");
  // not read whole (a second page): the same
  const g2 = fakeGithub();
  const d2 = new Db(join(dir, "two.db"));
  seed(d2);
  g2.state.historyNext = true;
  editStoredIssue(d2, S, 12, { title: "v4" }, t);
  expect(await sendGithubOperations(g2.gh, d2, dir, S, clock)).toBe(0);
  expect(d2.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("読み切れ") } });
  d2.close();
  // a write GitHub refuses for the state it is in: checked again and held, not failed
  const g3 = fakeGithub();
  const d3 = new Db(join(dir, "three.db"));
  seed(d3);
  g3.fail.push({ match: (a) => a.includes("PATCH"), status: 412 });
  editStoredIssue(d3, S, 12, { title: "v5" }, t);
  expect(await sendGithubOperations(g3.gh, d3, dir, S, clock)).toBe(0);
  expect(d3.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", error: expect.stringContaining("412") });
  d3.close();
});

test("history (#1329): two edits of theirs in the same second keep the newer; another Project's Status change is not this one's; a limit met by the read after the write keeps the outcome and stops the run", async () => {
  // two revisions of the body at the same second, the older one the value sent: the newer is what was overwritten
  const g = fakeGithub();
  g.history.push({ issue: 12, by: "them", at: later(), field: "body", value: "手元の本文" }, { issue: 12, by: "them", at: later(), field: "body", value: "相手の新しい本文" });
  editStoredIssue(db, S, 12, { body: "手元の本文" }, t);
  expect(await send(g.gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", overwritten: { value: "相手の新しい本文" } });
  // a Status change of another Project is not an edit of this field
  const g2 = fakeGithub();
  const d2 = new Db(join(dir, "two.db"));
  seed(d2);
  g2.history.push({ issue: 12, by: "them", at: later(), field: "field:Status", value: "Other" });
  editStoredIssue(d2, S, 12, { fields: { Status: "Ready" } }, t);
  expect(await sendGithubOperations(g2.gh, d2, dir, S, clock)).toBe(1);
  expect(d2.listPendingBacklogOperations(S)).toEqual([]);
  d2.close();
  // a limit on the read after the write: the edit is held as unverified, and the run stops before the next Issue's edits
  const g3 = fakeGithub();
  const d3 = new Db(join(dir, "three.db"));
  seed(d3);
  g3.fail.push({ match: (a) => a.some((x) => x.includes("timelineItems")), status: 429, headers: "retry-after: 120\n" });
  editStoredIssue(d3, S, 12, { title: "v3" }, t);
  editStoredIssue(d3, S, 3, { title: "親の v3" }, t);
  await expect(sendGithubOperations(g3.gh, d3, dir, S, clock)).rejects.toBeInstanceOf(Limit);
  expect(d3.listPendingBacklogOperations(S).map((o) => [o.issue, o.status])).toEqual([["I_12", "conflict"], ["I_3", "pending"]]);
  expect(g3.issues.get(3)!.title).toBe("親");
  d3.close();
});

test("history (#1329): a title write does not ask for the body's edits — a body edit of theirs in the history is not its concern", async () => {
  const g = fakeGithub();
  g.history.push({ issue: 12, by: "them", at: later(), field: "body", value: "相手の本文" });
  editStoredIssue(db, S, 12, { title: "v3" }, t);
  expect(await send(g.gh)).toBe(1);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
});

test("history (#1329): the body's edits have no since — a page that reaches back before the check read is whole, however many edits the body had; one that does not is not", async () => {
  // an old edit of theirs (before the check read) on a body edited many times: the newest page reaches past the window
  const g = fakeGithub();
  g.state.editsNext = true;
  g.history.push({ issue: 12, by: "them", at: new Date(t - 600_000).toISOString(), field: "body", value: "ずっと前の本文" });
  editStoredIssue(db, S, 12, { body: "v3" }, t);
  expect(await send(g.gh)).toBe(1);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  // every edit on the page is inside the window and there is another page: not whole, held as unverified
  const g2 = fakeGithub();
  const d2 = new Db(join(dir, "two.db"));
  seed(d2);
  g2.state.editsNext = true;
  g2.history.push({ issue: 12, by: "them", at: later(), field: "body", value: "相手の本文" });
  editStoredIssue(d2, S, 12, { body: "v4" }, t);
  expect(await sendGithubOperations(g2.gh, d2, dir, S, clock)).toBe(0);
  expect(d2.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("読み切れ") } });
  d2.close();
});

test("history (#1329): one's own login's edit is not another's; the read after the write stays one call", async () => {
  const g = fakeGithub();
  let reads = 0;
  const counted: GhRunner = async (args, cwd) => {
    if (args.includes("graphql")) reads++;
    return g.gh(args, cwd);
  };
  g.history.push({ issue: 12, by: "me", at: later(), field: "title", value: "自分の v2" });
  editStoredIssue(db, S, 12, { title: "v3" }, t);
  expect(await send(counted)).toBe(1);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  // the check before and the read after: two GraphQL reads, as before the history came along
  expect(reads).toBe(2);
});

test("chosen (#1329): remote on a conflict found after the write sends the other's value back on the next run, and GitHub comes to it", async () => {
  const g = fakeGithub();
  g.history.push({ issue: 12, by: "them", at: later(), field: "title", value: "相手の題" });
  editStoredIssue(db, S, 12, { title: "手元の題" }, t);
  expect(await send(g.gh)).toBe(0);
  const op = db.listPendingBacklogOperations(S)[0]!;
  expect(g.issues.get(12)!.title).toBe("手元の題");
  // the import after the run reads the local value back: the conflict stays (#1354)
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: { ...(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote as BacklogIssueData), title: "手元の題" }, fetchState: "fetched" }], cursor: null, syncedAt: t });
  expect(db.getBacklogOperation(op.id)).toMatchObject({ status: "conflict" });
  db.resolveBacklogConflict(S, op.id, "remote", conflictRevision(db.getBacklogOperation(op.id)!, db.backlogRemoteValue(db.getBacklogOperation(op.id)!)));
  g.history.length = 0;
  t += 2000;
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(12)!.title).toBe("相手の題");
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
});

test("BacklogSync: a limit is kept for the repository and the host and nothing is asked before it; the login refused is shown; what was written is imported back", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const calls: string[][] = [];
  const gh: GhRunner = (args, cwd) => (calls.push(args), g.gh(args, cwd));
  const sync = makeSync(db, gh, clock);
  editStoredIssue(db, S, 12, { title: "制限の前" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 403, headers: `x-ratelimit-remaining: 0\nx-ratelimit-reset: ${(t + 120_000) / 1000}\n` });
  await sync.send(ws);
  expect(db.getBacklogRepository(S)?.retryAt).toBe(t + 120_000);
  calls.length = 0;
  await sync.send(ws);
  expect(calls).toEqual([]);
  t += 120_000;
  await sync.send(ws);
  expect(g.issues.get(12)!.title).toBe("制限の前");
  // the write is read back: an import is asked for (it begins with the repository)
  expect(calls.some((a) => a[0] === "repo")).toBe(true);

  editStoredIssue(db, S, 12, { title: "期限切れ" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 401 });
  await sync.send(ws);
  expect(sync.read(ws).error).toContain("ログイン");
});

test("BacklogSync: an import that read before a write of a send run under way stores nothing, so the next edit of the field is not judged on the older value (#887)", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  // the title twice, an answer between: the second edit is made on the first one's value
  editStoredIssue(db, S, 12, { title: "一つ目" });
  answerStoredDecision(db, S, 12, "A");
  editStoredIssue(db, S, 12, { title: "二つ目" });
  let wrote!: () => void;
  const written = new Promise<void>((r) => (wrote = r));
  let reading!: () => void;
  const begun = new Promise<void>((r) => (reading = r));
  let imported!: () => void;
  const read = new Promise<void>((r) => (imported = r));
  let first = true;
  const answers = importsToo(g);
  const gh: GhRunner = async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes("states:[OPEN,CLOSED]")) {
      const answer = await answers(args, cwd); // what GitHub has when it is read
      if (first) (first = false), reading(), await written;
      return answer;
    }
    if (args.some((a) => a.endsWith("/comments")) && args.includes("POST")) await read;
    const r = await answers(args, cwd);
    if (args.includes("PATCH")) wrote();
    return r;
  };
  const sync = makeSync(db, gh, clock);
  const importing = sync.sync(ws); // reads the title before the send writes it
  await begun;
  // the send's answer waits until that import is over (stored, or not)
  void importing.then(imported);
  await Promise.all([importing, sync.send(ws)]);
  expect(g.issues.get(12)!.title).toBe("二つ目");
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
});

test("BacklogSync: the notice of the daemon's own send (#887) reads what it wrote, sends nothing more, and leaves the notice window as it was", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, importsToo(g), clock);
  sync.startPolling();
  const idle = async () => {
    for (let i = 0; i < 200 && sync.read(ws).syncing; i++) await Bun.sleep(2);
  };
  editStoredIssue(db, S, 12, { title: "手元の題" });
  await sync.send(ws); // written, then read back
  await idle();
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/12"]);
  // GitHub's Webhook of that edit arrives a moment later
  t += 5_000;
  expect(sync.hint(ws)).toBe(true);
  await idle();
  await sync.send(ws);
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/12"]);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  expect(readStoredIssue(db, ws, 12)!.issue.title).toBe("手元の題");
  // the echo found nothing new, but the window stays a minute: a teammate's edit next is read at once
  t += 61_000;
  g.issues.get(12)!.title = "あちらの題";
  expect(sync.hint(ws)).toBe(true);
  await idle();
  expect(readStoredIssue(db, ws, 12)!.issue.title).toBe("あちらの題");
  sync.stop();
});

test("BacklogSync: an echo that comes while the read-back runs, or to another checkout of the repository, is folded and read without widening the notice window", async () => {
  const g = fakeGithub();
  const a = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  const b = db.upsertWorkspace({ name: "app2", path: join(dir, "b"), kind: "repo" });
  db.setWorkspaceBacklogSource(a.id, S);
  db.setWorkspaceBacklogSource(b.id, S);
  const sync = makeSync(db, importsToo(g), clock);
  sync.startPolling();
  const idle = async () => {
    for (let i = 0; i < 200 && (sync.read(a).syncing || sync.read(b).syncing); i++) await Bun.sleep(2);
  };
  await sync.sync(b);
  editStoredIssue(db, S, 12, { title: "手元の題" });
  await sync.send(a); // written; its read-back starts
  t += 1_000;
  expect(sync.read(a).syncing).toBe(true);
  expect(sync.hint(a)).toBe(false); // during the read-back: folded
  await idle();
  expect(sync.hint(b)).toBe(true); // the other checkout of the same repository, after the read-back stored the write
  await idle();
  // the folded echo is read at its minute and finds nothing new
  t += 60_000;
  await sync.sync(a);
  // neither window widened: a teammate's edit next is read within a minute through both
  expect([sync.hintWindow(a.id), sync.hintWindow(b.id)]).toEqual([60_000, 60_000]);
  t += 61_000;
  g.issues.get(12)!.title = "あちらの題";
  expect(sync.hint(a)).toBe(true);
  await idle();
  expect(readStoredIssue(db, a, 12)!.issue.title).toBe("あちらの題");
  sync.stop();
});

test("BacklogSync: an edit held at the check before the write is offered with GitHub's value it found (an import reads it); a refused write is held as failed with why (#887)", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, importsToo(g), clock);
  const idle = async () => {
    for (let i = 0; i < 200 && sync.read(ws).syncing; i++) await Bun.sleep(2);
  };
  editStoredIssue(db, S, 12, { title: "手元の題" });
  g.issues.get(12)!.title = "GitHub の題";
  await sync.send(ws);
  await Bun.sleep(5);
  await idle();
  expect(g.writes).toEqual([]);
  const held = readStoredIssue(db, ws, 12)!.held;
  expect(held).toEqual([expect.objectContaining({ field: "title", status: "conflict", conflict: expect.objectContaining({ base: "PBI", local: "手元の題", remote: "GitHub の題", remoteRead: true }) })]);

  // GitHub refuses the write (403 on that Issue): failed, held with GitHub's reason, never told as sent
  db.resolveBacklogConflict(S, held[0]!.operation, "remote", held[0]!.conflict!.revision);
  editStoredIssue(db, S, 12, { body: "書けない本文" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 403 });
  await sync.send(ws);
  expect(readStoredIssue(db, ws, 12)!.held).toEqual([expect.objectContaining({ field: "body", status: "failed", reason: expect.stringContaining("403"), conflict: null })]);
  expect(g.issues.get(12)!.body).toBe("本文");
});

test("a post left sending by a run that broke off is looked for, not posted again; an answer with no id is unknown", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "途中で切れた");
  // GitHub took it, but its answer had no id: the result cannot be stored
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    return args.includes("POST") ? { ...r, stdout: r.stdout.replace(/"node_id":"[^"]+",/, "") } : r;
  };
  expect(await send(gh)).toBe(0);
  expect(statuses()[0]).toEqual(["comment", null, "unknown"]);
  // and one left sending without a restart in between
  db.setBacklogOperationResult(db.listPendingBacklogOperations(S)[0]!.id, { status: "sending" });
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
});

test("an outage: a field edit waits a minute, then twice as long, and after five tries is failed — not retried for ever", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "障害の間" });
  const waits: number[] = [];
  for (let k = 0; k < 5; k++) {
    g.fail.push({ match: (a) => a.includes("PATCH"), status: 502 });
    const before = t;
    expect(await send(g.gh)).toBe(0);
    const op = db.listPendingBacklogOperations(S)[0]!;
    if (op.status === "failed") break;
    waits.push(op.retryAt! - before);
    t = op.retryAt!;
  }
  expect(waits).toEqual([60_000, 120_000, 240_000, 480_000]);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "failed", attempt: 5, error: expect.stringContaining("5 回") });
  // and it is not sent again by itself
  g.writes.length = 0;
  t += 3_600_000;
  expect(await send(g.gh)).toBe(0);
  expect(g.writes).toEqual([]);
});

test("GitHub's \"Something went wrong\" is an outage: a create's step waits and goes on, it is not failed at once; one failed so before is sent again when the database opens", async () => {
  const g = fakeGithub();
  const wrong = "gh: Something went wrong while executing your query on 2026-10-21T22:52:17Z. Please include `AE90:1` when reporting this issue.";
  const { localId } = createStoredIssue(db, S, { title: "Task: 障害の間", body: "", labels: [], milestone: null, parent: 12, fields: { Status: "Ready" } });
  g.fail.push({ match: (a) => a.some((x) => x.includes("addSubIssue")), status: 200, stderr: wrong });
  expect(await send(g.gh)).toBe(0);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "pending", retryAt: t + 60_000 });
  t += 60_000;
  expect(await send(g.gh)).toBe(1);
  const made = [...g.issues.values()].filter((i) => i.title === "Task: 障害の間");
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ parent: 12 });
  // what the sender before the fix left: failed at once with GitHub's words — the one that gave up after 5 tries stays failed
  const again = createStoredIssue(db, S, { title: "Task: 前に失敗", body: "", labels: [], milestone: null, parent: null, fields: null }).localId;
  const tried = createStoredIssue(db, S, { title: "Task: 5 回", body: "", labels: [], milestone: null, parent: null, fields: null }).localId;
  await send(g.gh);
  db.sqlite.query("UPDATE backlog_operations SET status = 'failed', error = ? WHERE id = ?").run(`gh api graphql: ${wrong}`, again);
  db.sqlite.query("UPDATE backlog_operations SET status = 'failed', error = ? WHERE id = ?").run(`5 回送れませんでした: gh api graphql: ${wrong}`, tried);
  db.close();
  db = new Db(join(dir, "switchboard.db"));
  expect(db.getBacklogOperation(again)).toMatchObject({ status: "pending", attempt: 0 });
  expect(db.getBacklogOperation(tried)).toMatchObject({ status: "failed" });
  await send(g.gh);
  expect(db.getBacklogOperation(again)).toMatchObject({ status: "done" });
  expect([...g.issues.values()].filter((i) => i.title === "Task: 前に失敗")).toHaveLength(1);
});

test("the marker a post left is not shown, and an unchanged body (CRLF too) is not sent back without it", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const { localId } = createStoredIssue(db, S, { title: "印の付く Issue", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  expect(await send(g.gh)).toBe(1);
  const made = readStoredIssue(db, ws, localId)!;
  expect(made.issue.body).toBe("本文");
  expect(editStoredIssue(db, S, localId, { body: "本文" }).operations).toEqual([]);
  // GitHub gave it back with CRLF
  const rec = db.getBacklogRecord({ ...S, objectKind: "issue", externalId: db.getBacklogOperation(localId)!.target })!;
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: rec.externalId, remote: { ...(rec.remote as BacklogIssueData), body: (rec.remote as BacklogIssueData).body.replaceAll("\n", "\r\n") }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  expect(readStoredIssue(db, ws, localId)!.issue.body).toBe("本文");
});

test("a daemon that must not write (the candidate on a copy of the database) sends nothing", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  answerStoredDecision(db, S, 12, "候補からは送らない");
  await makeSync(db, g.gh, clock, undefined, false).send(ws);
  expect(g.writes).toEqual([]);
  expect(statuses().map((o) => o[2])).toEqual(["pending", "pending"]);
});

test("gh that cannot start sent nothing: a post waits as it was, not unknown", async () => {
  answerStoredDecision(db, S, 12, "gh が無い");
  await expect(send(async () => ({ code: 127, stdout: "", stderr: "gh を起動できません: not found" }))).rejects.toMatchObject({ kind: "offline" });
  expect(statuses()[0]).toEqual(["comment", null, "pending"]);
});

test("a GraphQL error GitHub answered (an input it refuses) fails the operation at once, not after five tries", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { fields: { Status: "Ready" } });
  const gh: GhRunner = async (args, cwd) =>
    args.some((a) => a.includes("updateProjectV2ItemFieldValue"))
      ? { code: 1, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify({ errors: [{ type: "UNPROCESSABLE", message: "invalid value" }] })}`, stderr: "" }
      : g.gh(args, cwd);
  expect(await send(gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "failed", attempt: 1 });
});

test("a post whose result is unknown and not found stays unknown: nothing is posted again by itself", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "新しい", body: "", labels: [], milestone: null, parent: null, fields: null });
  db.setBacklogOperationResult(localId, { status: "sending" });
  db.recoverBacklogOperations();
  expect(await send(g.gh)).toBe(0);
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["create", null, "unknown"]]);
  expect(g.writes).toEqual([]);
  expect(g.issues.size).toBe(2); // #12 and #3 only
});

test("a limit stops sending until GitHub's time, then it goes on; an auth refusal stops the run without failing anything", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "制限のあと" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 403, headers: `x-ratelimit-remaining: 0\nx-ratelimit-reset: ${(t + 60_000) / 1000}\n` });
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "pending", retryAt: t + 60_000 });
  g.writes.length = 0;
  expect(await send(g.gh)).toBe(0); // before the time: not asked
  expect(g.writes).toEqual([]);
  t += 60_000;
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(12)!.title).toBe("制限のあと");

  // the login refused: the run stops, nothing is failed for it, and the next send (a token renewed) goes on
  editStoredIssue(db, S, 12, { title: "認証切れ" });
  answerStoredDecision(db, S, 12, "B");
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 401 });
  const auth = await send(g.gh).catch((e) => e);
  expect(auth).toMatchObject({ kind: "auth" });
  expect(db.listPendingBacklogOperations(S).map((o) => [o.status, o.attempt, o.retryAt])).toEqual([["pending", 0, null], ["pending", 0, null], ["pending", 0, null]]);
  expect(g.issues.get(12)!.comments).toHaveLength(0);
  expect(await send(g.gh)).toBe(3);
  expect(g.issues.get(12)!.title).toBe("認証切れ");
});

test("a new Issue is made once with its marker, put in the Project with its fields and under its parent; its local id finds it", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "Task: 新しい", body: "本文", labels: ["type:task"], milestone: null, parent: 12, fields: { Status: "Ready" } });
  editStoredIssue(db, S, localId, { title: "Task: 直した" });
  // an outage after the Issue was made: the steps after it go on without making it again
  g.fail.push({ match: (a) => a.some((x) => x.includes("addSubIssue")), status: 502 });
  expect(await send(g.gh)).toBe(0);
  t += 3_600_000;
  expect(await send(g.gh)).toBe(1);
  const made = [...g.issues.values()].filter((i) => i.title === "Task: 直した");
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ parent: 12, labels: ["type:task"] });
  expect(made[0]!.body).toMatch(/^本文\n\n<!-- switchboard-op:/);
  expect([...g.items.values()].filter((i) => i.issue === made[0]!.node_id)).toEqual([{ issue: made[0]!.node_id, fields: { Status: "Ready" } }]);
  // the record took the Issue's id when it was made, before the step that failed
  expect(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: `local:${localId}` })).toBeNull();
  const op = db.getBacklogOperation(localId)!;
  expect(op).toMatchObject({ status: "done", remoteId: made[0]!.node_id, target: made[0]!.node_id });
  expect(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: made[0]!.node_id })?.remote).toMatchObject({ number: made[0]!.number, title: "Task: 直した" });
});

test("a new Issue the Project's auto-add put in first is not failed: the item there takes its fields", async () => {
  const g = fakeGithub();
  g.state.autoAdd = true;
  const { localId } = createStoredIssue(db, S, { title: "Task: 自動で入る", body: "", labels: [], milestone: null, parent: null, fields: { Status: "Ready" } });
  expect(await send(g.gh)).toBe(1);
  const made = [...g.issues.values()].find((i) => i.title === "Task: 自動で入る")!;
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: made.node_id });
  expect([...g.items.values()].filter((i) => i.issue === made.node_id)).toEqual([{ issue: made.node_id, fields: { Status: "Ready" } }]);
});

test("a create failed before by the auto-add's item is sent again when the database opens: its Issue is not made twice", async () => {
  const g = fakeGithub();
  g.state.autoAdd = true;
  const { localId } = createStoredIssue(db, S, { title: "Task: 前に失敗", body: "", labels: [], milestone: null, parent: null, fields: { Status: "Ready" } });
  // what the sender before the fix left: the Issue made, the add refused, the operation failed
  g.fail.push({ match: (a) => a.some((x) => x.includes("addProjectV2ItemById")), status: 200 });
  expect(await send(g.gh)).toBe(0);
  db.sqlite.query("UPDATE backlog_operations SET error = 'gh api graphql: gh: Content already exists in this project' WHERE id = ?").run(localId);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "failed" });
  db.close();
  db = new Db(join(dir, "switchboard.db"));
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "pending", attempt: 0 });
  expect(await send(g.gh)).toBe(1);
  expect([...g.issues.values()].filter((i) => i.title === "Task: 前に失敗")).toHaveLength(1);
  const made = [...g.issues.values()].find((i) => i.title === "Task: 前に失敗")!;
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done" });
  expect(g.items.get(`PVTI_${made.node_id}`)).toEqual({ issue: made.node_id, fields: { Status: "Ready" } });
});

test("an add to the Project failed before as already there is sent again and takes the item; a create with no Issue made stays failed", async () => {
  const g = fakeGithub();
  g.state.autoAdd = true;
  g.items.set("PVTI_I_3", { issue: "I_3", fields: {} });
  editStoredIssue(db, S, 3, { project: true });
  const { localId } = createStoredIssue(db, S, { title: "作れていない", body: "", labels: [], milestone: null, parent: null, fields: null });
  db.sqlite.query("UPDATE backlog_operations SET status = 'failed', error = 'gh api graphql: gh: Content already exists in this project'").run();
  db.close();
  db = new Db(join(dir, "switchboard.db"));
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "failed" });
  const member = db.listPendingBacklogOperations(S).find((o) => o.field === "member")!;
  expect(member.status).toBe("pending");
  await send(g.gh);
  expect(db.getBacklogOperation(member.id)).toMatchObject({ status: "done", remoteId: "PVTI_I_3" });
  expect([...g.issues.values()].filter((i) => i.title === "作れていない")).toHaveLength(0);
});

/* ---------- the forge operation of the repository's service (#920) ---------- */

test("an operation is sent through its service's forge operation: a service not supported, or a value that signs in, is held as failed and nothing is sent", async () => {
  const g = fakeGithub();
  // a value that signs in, written past the edit's own check (a copy restored from an older store): checked again right before it goes out
  editStoredIssue(db, S, 12, { title: "直した題" });
  db.sqlite.query("UPDATE backlog_operations SET payload = ?").run(JSON.stringify("ghp_" + "a".repeat(36)));
  expect(await send(g.gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S).map((o) => [o.status, o.error?.includes("認証に使える値")])).toEqual([["failed", true]]);
  expect(g.writes).toEqual([]);
  expect(g.issues.get(12)!.title).toBe("PBI");
  // another service's repository: the same operation is not sent some other way, it says the service is not supported
  const L: BacklogSource = { ...S, service: "gitea" as "github", host: "gitea.example.com" };
  seed(db);
  db.putBacklogSnapshot(L, { records: [{ objectKind: "issue", externalId: "I_12", remote: { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: [], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null }, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
  editStoredIssue(db, L, 12, { title: "別のサービス" });
  expect(await sendGithubOperations(g.gh, db, dir, L, clock)).toBe(0);
  expect(db.listPendingBacklogOperations(L).map((o) => [o.status, o.error])).toEqual([["failed", "サービス gitea には対応していません（対応: github, gitlab）"]]);
  expect(g.writes).toEqual([]);
});

/* ---------- GitLab (#2910) ---------- */

const LAB: BacklogSource = { service: "gitlab", host: "gitlab.example.com", repository: "group/app", project: { owner: "group/app", number: 0 } };

/**
 * A fake GitLab behind glab (REST API v4): its Issues by iid and their notes. `fail` answers a call (method and path)
 * with an HTTP status instead — after doing it when `after` (an answer lost).
 */
function fakeGitlab() {
  type I = { id: number; iid: number; title: string; description: string; state: "opened" | "closed"; labels: string[]; milestone: { id: number; title: string } | null; notes: Array<{ id: number; body: string; system: boolean; created_at: string }> };
  const issues = new Map<number, I>([[12, { id: 9001, iid: 12, title: "PBI", description: "本文", state: "opened", labels: ["type:pbi", "needs-decision"], milestone: null, notes: [] }]]);
  const milestones = [{ id: 5, title: "Phase 2" }];
  const writes: string[] = [];
  let fail: { on: (m: string, p: string) => boolean; status: number; after?: boolean } | null = null;
  let next = 9100;
  const raw = (i: I) => ({ id: i.id, iid: i.iid, title: i.title, description: i.description, state: i.state, labels: i.labels, milestone: i.milestone, web_url: `https://gitlab.example.com/group/app/-/issues/${i.iid}`, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", closed_at: null });
  const glab = async (cmd: string[]) => {
    expect(cmd.slice(0, 4)).toEqual(["glab", "api", "--hostname", "gitlab.example.com"]);
    const m = cmd[cmd.indexOf("-X") + 1]!;
    const path = cmd[cmd.length - 1]!.replace("projects/group%2Fapp", "");
    const f: Record<string, string> = {};
    cmd.forEach((a, k) => cmd[k - 1] === "-f" && (f[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1)));
    const failing = fail?.on(m, path) ? fail : null;
    if (failing && !failing.after) throw new Error(`glab: error (HTTP ${failing.status})`);
    let out: unknown;
    const one = /^\/issues\/(\d+)(\/notes)?(\?.*)?$/.exec(path);
    if (m !== "GET") writes.push(`${m} ${path.replace(/\?.*/, "")}`);
    if (m === "GET" && path.startsWith("/milestones")) out = milestones;
    else if (m === "GET" && path.startsWith("/issues?")) out = [...issues.values()].reverse().map(raw);
    else if (one && !one[2]) {
      const i = issues.get(Number(one[1]));
      if (!i) throw new Error("glab: 404 Not Found (HTTP 404)");
      if (m === "PUT") {
        if (f.title) i.title = f.title;
        if (f.description !== undefined) i.description = f.description;
        if (f.state_event) i.state = f.state_event === "close" ? "closed" : "opened";
        if (f.add_labels) i.labels.push(f.add_labels);
        if (f.remove_labels) i.labels = i.labels.filter((l) => l !== f.remove_labels);
        if (f.milestone_id) i.milestone = milestones.find((x) => String(x.id) === f.milestone_id) ?? null;
      }
      out = raw(i);
    } else if (one && one[2]) {
      const i = issues.get(Number(one[1]))!;
      if (m === "POST") i.notes.push({ id: next++, body: f.body!, system: false, created_at: "2026-10-02T00:00:00Z" });
      out = m === "POST" ? i.notes.at(-1) : [...i.notes].reverse();
    } else if (m === "POST" && path === "/issues") {
      const iid = Math.max(...issues.keys()) + 1;
      issues.set(iid, { id: next++, iid, title: f.title!, description: f.description!, state: "opened", labels: f.labels ? f.labels.split(",") : [], milestone: milestones.find((x) => String(x.id) === f.milestone_id) ?? null, notes: [] });
      out = raw(issues.get(iid)!);
    } else throw new Error(`fake GitLab: ${m} ${path}`);
    if (failing) throw new Error(`glab: error (HTTP ${failing.status})`);
    return JSON.stringify(out);
  };
  return { issues, writes, glab, failWith: (f: typeof fail) => void (fail = f) };
}
const noGh: GhRunner = async (args) => {
  throw new Error(`gh is not asked for GitLab: ${args.join(" ")}`);
};
function seedLab() {
  db.putBacklogSnapshot(LAB, { records: [{ objectKind: "issue", externalId: "gitlab:issue:9001", remote: { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "needs-decision"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null }, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
}
const sendLab = (g: ReturnType<typeof fakeGitlab>) => sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, g.glab);
const labStatuses = () => db.listPendingBacklogOperations(LAB).map((o) => [o.kind, o.field, o.status, o.error]);

test("GitLab: a field is written only while GitLab still has the value it was made on, and read again after; gh is never asked", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { title: "直した題", state: "CLOSED", milestone: "Phase 2", labels: { add: ["P1"], remove: ["needs-decision"] } });
  expect(await sendLab(g)).toBe(5);
  expect(g.issues.get(12)).toMatchObject({ title: "直した題", state: "closed", milestone: { id: 5 }, labels: ["type:pbi", "P1"] });
  expect(g.writes).toEqual(["PUT /issues/12", "PUT /issues/12", "PUT /issues/12", "PUT /issues/12", "PUT /issues/12"]);
  // changed on GitLab since the edit was made: held, nothing written
  editStoredIssue(db, LAB, 12, { body: "手元の本文" });
  g.issues.get(12)!.description = "GitLab で書いた本文";
  g.writes.length = 0;
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "body", "conflict", 'GitLab の値が編集の元から変わっています（body: GitLab は "GitLab で書いた本文"）']]);
  expect(g.writes).toEqual([]);
});

test("GitLab: what it does not have (a parent, a Project field) is failed with why and nothing is sent", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { parent: 3 });
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "parent", "failed", "GitLab には無いフィールドです（parent）。親は本文の ## 親 PBI で書きます"]]);
  db.sqlite.query("DELETE FROM backlog_operations").run();
  db.putBacklogSnapshot(LAB, { records: [{ objectKind: "project-item", externalId: "item_12", remote: { issue: 12, owner: "group/app", project: 0, fields: { Status: "Backlog" } }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  editStoredIssue(db, LAB, 12, { fields: { Status: "Ready" } });
  expect(await sendLab(g)).toBe(0);
  expect(labStatuses()).toEqual([["set", "field:Status", "failed", "サービス gitlab の project には対応していません"]]);
  expect(g.writes).toEqual([]);
});

test("GitLab: a comment and a create carry their marker; a lost answer is looked for, never posted twice", async () => {
  const g = fakeGitlab();
  seedLab();
  answerStoredDecision(db, LAB, 12, "A で");
  // the post went out and its answer was lost
  g.failWith({ on: (m, p) => m === "POST" && p.endsWith("/notes"), status: 502, after: true });
  await sendLab(g);
  expect(labStatuses().find((o) => o[0] === "comment")?.[2]).toBe("unknown");
  g.failWith(null);
  await sendLab(g);
  expect(g.issues.get(12)!.notes).toHaveLength(1);
  expect(g.issues.get(12)!.notes[0]!.body).toMatch(/^## 回答\n\nA で\n\n<!-- switchboard-op:/);
  expect(db.listPendingBacklogOperations(LAB).filter((o) => o.kind === "comment")).toEqual([]);
  createStoredIssue(db, LAB, { title: "新しい Task", body: "## 親 PBI\n#12", labels: ["type:task"], milestone: "Phase 2", parent: 12, fields: { Status: "Ready" } });
  g.writes.length = 0;
  await sendLab(g);
  const made = g.issues.get(13)!;
  expect(made).toMatchObject({ title: "新しい Task", labels: ["type:task"], milestone: { id: 5 }, state: "opened" });
  expect(made.description).toMatch(/^## 親 PBI\n#12\n\n<!-- switchboard-op:/);
  // the Project's fields are not sent (GitLab has no Project); the parent is the body's
  expect(g.writes).toEqual(["POST /issues"]);
  expect(db.listBacklogRecords(LAB, "issue").find((r) => r.externalId === `gitlab:issue:${made.id}`)?.remote).toMatchObject({ number: 13, parent: 12, state: "OPEN" });
});

test("GitLab: a lost create is found by its marker; a failed look for it keeps it unknown, never posted twice; a value moved right after the write is a conflict", async () => {
  const g = fakeGitlab();
  seedLab();
  createStoredIssue(db, LAB, { title: "答えを失う", body: "本文", labels: [], milestone: null, parent: null, fields: null });
  g.failWith({ on: (m, p) => m === "POST" && p === "/issues", status: 502, after: true });
  await sendLab(g);
  expect(labStatuses()).toEqual([["create", null, "unknown", expect.stringContaining("502")]]);
  // the look for its marker fails too: still unknown, nothing posted
  g.failWith({ on: (m, p) => m === "GET" && p.startsWith("/issues?"), status: 503 });
  await sendLab(g);
  expect(labStatuses()).toEqual([["create", null, "unknown", expect.stringContaining("503")]]);
  g.failWith(null);
  await sendLab(g);
  expect(labStatuses()).toEqual([]);
  expect([...g.issues.values()].filter((i) => i.title === "答えを失う")).toHaveLength(1);
  expect(g.writes.filter((w) => w === "POST /issues")).toHaveLength(1);
  // another edit lands between the write and the read after it
  editStoredIssue(db, LAB, 12, { title: "手元の題" });
  const glab = g.glab;
  const racing = async (cmd: string[]) => {
    const out = await glab(cmd);
    if (cmd.includes("PUT")) g.issues.get(12)!.title = "誰かの題";
    return out;
  };
  await sendGithubOperations(noGh, db, dir, LAB, clock, undefined, undefined, undefined, racing);
  expect(labStatuses()).toEqual([["set", "title", "conflict", '送った直後の GitLab の値が送った値と違います（title: GitLab は "誰かの題"）。ほかの編集と重なりました']]);
});

test("GitLab: GitHub's wait does not hold a GitLab project's sends", async () => {
  const g = fakeGitlab();
  seedLab();
  const ws = db.upsertWorkspace({ name: "lab", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, LAB);
  const sync = makeSync(db, noGh, clock);
  sync.glab = g.glab;
  (sync as unknown as { limits: { failed: (h: string, r: unknown) => unknown } }).limits.failed("github.com", { status: 429, headers: { "retry-after": "3600" } });
  editStoredIssue(db, LAB, 12, { title: "待たずに送る" });
  await sync.send(ws);
  expect(g.issues.get(12)!.title).toBe("待たずに送る");
});

test("GitLab: 401 and 429 stop the run with nothing failed; a 4xx fails the operation; a 5xx before the write waits", async () => {
  const g = fakeGitlab();
  seedLab();
  editStoredIssue(db, LAB, 12, { title: "題" });
  g.failWith({ on: (m) => m === "GET", status: 401 });
  await expect(sendLab(g)).rejects.toMatchObject({ kind: "auth" });
  g.failWith({ on: (m) => m === "GET", status: 429 });
  await expect(sendLab(g)).rejects.toMatchObject({ kind: "limit" });
  expect(labStatuses()).toEqual([["set", "title", "pending", expect.any(String)]]);
  g.failWith({ on: (m) => m === "PUT", status: 503 });
  await sendLab(g);
  expect(labStatuses()[0]![2]).toBe("pending");
  g.failWith({ on: (m) => m === "PUT", status: 403 });
  t += 3_600_000;
  await sendLab(g);
  expect(labStatuses()[0]!.slice(0, 3)).toEqual(["set", "title", "failed"]);
  expect(g.writes).toEqual([]);
});

test("forgeKind: a Project item and its fields are project, a create and a comment their own, any other field write", () => {
  expect(forgeKind({ kind: "create", field: null, targetKind: "issue" })).toBe("create");
  expect(forgeKind({ kind: "comment", field: null, targetKind: "comment" })).toBe("comment");
  expect(forgeKind({ kind: "set", field: "member", targetKind: "project-item" })).toBe("project");
  expect(forgeKind({ kind: "set", field: "field:Status", targetKind: "project-item" })).toBe("project");
  for (const field of ["title", "body", "state", "label:type:pbi", "milestone", "parent"]) expect(forgeKind({ kind: "set", field, targetKind: "issue" })).toBe("write");
});

test("a run stops before the next operation once the sync is turned off; the rest waits as it is (#2266)", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 3, { title: "親の新しい題" });
  editStoredIssue(db, S, 12, { title: "手元の題" });
  let on = true;
  // the first write turns the sync off while it runs
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (args.includes("PATCH")) on = false;
    return r;
  };
  expect(await sendGithubOperations(gh, db, dir, S, clock, undefined, () => on)).toBe(1);
  expect(g.writes).toEqual(["PATCH repos/acme/app/issues/3"]);
  expect(statuses()).toEqual([["set", "title", "pending"]]);
});

test("a set whose read was out when the sync was turned off writes nothing; it waits as it was (#2266)", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "手元の題" });
  let on = true;
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (!args.includes("PATCH")) on = false;
    return r;
  };
  await expect(sendGithubOperations(gh, db, dir, S, clock, undefined, () => on)).rejects.toMatchObject({ kind: "off" });
  expect(g.writes).toEqual([]);
  expect(statuses()).toEqual([["set", "title", "pending"]]);
});
