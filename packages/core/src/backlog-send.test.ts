// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { BacklogIssueData } from "@switchboard/protocol";
import { Db, inSendWindow, SEND_DELAY_MS } from "./db.ts";
import { commentStoredIssue as commentWindowed, cancelStoredOperation, createStoredIssue, editStoredIssue, retryStoredOperation, withdrawStoredOperation } from "./backlog-edit.ts";
import { readStoredIssue } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { Limit, sendGithubOperations, theirEdit } from "./backlog-send.ts";
import { backlogFieldValue, conflictRevision } from "./backlog-merge.ts";
import { S, answerStoredDecision, clock, commentStoredIssue, fakeGithub, importsToo, later, makeSync, seed, send, useSendDb } from "./api-test-harness.ts";

let dir: string;
let db: Db;
let t = 1_000_000;
useSendDb({ get dir() { return dir; }, set dir(v) { dir = v; }, get db() { return db; }, set db(v) { db = v; }, get t() { return t; }, set t(v) { t = v; } });

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

test("an edit an import held as a conflict is not written; one whose conflict is chosen on during a run is not sent", async () => {
  const g = fakeGithub();
  // Issue 3 first: the run reaches Issue 12 after it
  editStoredIssue(db, S, 3, { title: "親の新しい題" });
  editStoredIssue(db, S, 12, { title: "手元の題" });
  // an import reads another title on GitHub: held before any send
  const twelve = db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote as BacklogIssueData;
  g.issues.get(12)!.title = "GitHub の題";
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: { ...twelve, title: "GitHub の題" }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  const held = db.listPendingBacklogOperations(S).find((o) => o.issue === "I_12")!;
  expect(held.status).toBe("conflict");
  // while the run writes Issue 3, the user keeps GitHub's title of Issue 12
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

test("A's window, replayed: an edit on GitHub between the check and the write is overwritten and not seen; one after the write is held — neither is told as kept", async () => {
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
  // for the edit — with one, the read after the write holds the edit: the history tests below)
  expect(g.issues.get(12)!.title).toBe("手元の v3");
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  // what is told with the Issue says so, and does not claim it was kept
  const told = readStoredIssue(db, ws, 12)!;
  expect(told.limits).toContain("上書きしうる");
  expect(told.limits).toContain("同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません");
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

test("close with a reason: the close, then state_reason=not_planned; a completed one changed alone; a close without a reason sends none", async () => {
  const g = fakeGithub();
  const patches: string[][] = [];
  const gh: GhRunner = async (args, cwd) => {
    if (args.includes("PATCH")) patches.push(args.filter((a, k) => args[k - 1] === "-f"));
    return g.gh(args, cwd);
  };
  editStoredIssue(db, S, 12, { state: "CLOSED", stateReason: "NOT_PLANNED" });
  expect(await send(gh)).toBe(2);
  expect(patches).toEqual([["state=closed"], ["state=closed", "state_reason=not_planned"]]);
  expect(g.issues.get(12)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  expect(statuses()).toEqual([]);
  const shown = () => {
    const r = db.listBacklogRecords(S, "issue").find((x) => x.externalId === "I_12")!;
    const v = (r.local ?? r.remote) as BacklogIssueData;
    return { state: v.state, stateReason: v.stateReason };
  };
  expect(shown()).toEqual({ state: "CLOSED", stateReason: "NOT_PLANNED" });

  // one closed completed on GitHub: only its reason is changed
  g.issues.get(3)!.state = "CLOSED";
  g.issues.get(3)!.stateReason = "COMPLETED";
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_3", remote: { number: 3, title: "親", url: "", state: "CLOSED", stateReason: "COMPLETED", body: "", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-02T00:00:00Z" }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  patches.length = 0;
  editStoredIssue(db, S, 3, { state: "CLOSED", stateReason: "NOT_PLANNED" });
  expect(await send(gh)).toBe(1);
  expect(patches).toEqual([["state=closed", "state_reason=not_planned"]]);
  expect(g.issues.get(3)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });

  // another login's reason in the window, read through the history after the write: held with its value
  g.history.push({ issue: 3, by: "them", at: later(), field: "stateReason", value: "DUPLICATE" });
  editStoredIssue(db, S, 3, { state: "CLOSED", stateReason: "COMPLETED" }, t);
  expect(await send(gh)).toBe(0);
  expect(db.listPendingBacklogOperations(S).find((o) => o.field === "stateReason")).toMatchObject({ status: "conflict", overwritten: { value: "DUPLICATE", editor: "them" } });

  // a reopen still waiting taken back by a close COMPLETED: nothing is reopened, the reason alone is changed
  g.issues.get(3)!.stateReason = "NOT_PLANNED";
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_3", remote: { number: 3, title: "親", url: "", state: "CLOSED", stateReason: "NOT_PLANNED", body: "", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-02T00:00:00Z" }, fetchState: "fetched" }], cursor: null, syncedAt: 3 });
  for (const o of db.listPendingBacklogOperations(S)) db.setBacklogOperationResult(o.id, { status: "done" });
  patches.length = 0;
  editStoredIssue(db, S, 3, { state: "OPEN" });
  editStoredIssue(db, S, 3, { state: "CLOSED", stateReason: "COMPLETED" });
  await send(gh);
  expect(patches).toEqual([["state=closed", "state_reason=completed"]]);
  expect(g.issues.get(3)).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });

  // without a reason: the close alone, completed as before
  const d2 = new Db(join(dir, "plain.db"));
  seed(d2);
  const g2 = fakeGithub();
  const plain: string[][] = [];
  editStoredIssue(d2, S, 12, { state: "CLOSED" });
  await sendGithubOperations(async (args, cwd) => (args.includes("PATCH") && plain.push(args.filter((a, k) => args[k - 1] === "-f")), g2.gh(args, cwd)), d2, dir, S, clock);
  expect(plain).toEqual([["state=closed"]]);
  expect(g2.issues.get(12)).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
  d2.close();
});

test("close with a reason: another login's reason in the window is held", () => {
  const after = (stateReason: string) => ({ events: [{ __typename: "ClosedEvent", actor: { login: "them" }, createdAt: "2026-10-02T00:00:00Z", stateReason }], edits: [], viewer: "me" });
  expect(theirEdit("stateReason", after("DUPLICATE"), "2026-10-01T00:00:00Z", "", "NOT_PLANNED")).toMatchObject({ value: "DUPLICATE", editor: "them" });
  expect(theirEdit("stateReason", after("NOT_PLANNED"), "2026-10-01T00:00:00Z", "", "NOT_PLANNED")).toBeNull();
});

test("Status の順の変更が競合しない: two Status edits stored one after the other are sent as the later; one written to GitHub around the store is held", async () => {
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

test("後の編集が GitHub と同じなら競合にしない: GitHub already at the last of the field's edits settles all of them; another last value is still held", async () => {
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

test("GitHub の Project の自動化が動かした Status は競合にしない: open → the edit goes over it; closed → it stays; a person's move is still held", async () => {
  const statusWrites = (g: ReturnType<typeof fakeGithub>) => g.writes.filter((w) => w.includes("updateProjectV2ItemFieldValue"));
  const automation = "github-project-automation";

  // a PR linked with Closes moved it to In progress seconds before the Task's In review, on a base of Backlog
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { fields: { Status: "In review" } });
  g.items.get("PVTI_I_12")!.fields.Status = "In progress";
  g.history.push({ issue: 12, by: automation, at: "2026-10-30T13:32:13Z", field: "field:Status", value: "In progress" });
  // the import reads it first: it leaves the choice to the send, which reads who moved it
  db.putBacklogSnapshot(S, { records: [{ objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "In progress" } }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  expect(db.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["pending"]);
  await send(g.gh);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  expect(g.items.get("PVTI_I_12")!.fields.Status).toBe("In review");

  // merged meanwhile: the Issue is closed and the automation has Done; the waiting In review is not sent over it
  const d2 = new Db(join(dir, "b.db"));
  seed(d2);
  const g2 = fakeGithub();
  editStoredIssue(d2, S, 12, { fields: { Status: "In review" } });
  g2.issues.get(12)!.state = "CLOSED";
  g2.issues.get(12)!.closedAt = "2026-10-30T18:18:23Z";
  g2.items.get("PVTI_I_12")!.fields.Status = "Done";
  g2.history.push({ issue: 12, by: automation, at: "2026-10-30T18:18:26Z", field: "field:Status", value: "Done" });
  await sendGithubOperations(g2.gh, d2, dir, S, clock);
  expect(d2.listPendingBacklogOperations(S)).toEqual([]);
  expect(d2.listBacklogOperations(S).at(-1)).toMatchObject({ status: "done", error: expect.stringContaining("Project の自動化") });
  expect(statusWrites(g2)).toEqual([]);
  d2.close();

  // a person's move, in the same place: held, nothing written
  const d3 = new Db(join(dir, "c.db"));
  seed(d3);
  const g3 = fakeGithub();
  editStoredIssue(d3, S, 12, { fields: { Status: "In review" } });
  g3.items.get("PVTI_I_12")!.fields.Status = "In progress";
  g3.history.push({ issue: 12, by: "someone", at: "2026-10-30T13:32:13Z", field: "field:Status", value: "In progress" });
  await sendGithubOperations(g3.gh, d3, dir, S, clock);
  expect(d3.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
  expect(statusWrites(g3)).toEqual([]);
  d3.close();
});

test("closed, on a Project without the close workflow: the automation's value is older than the close, so the edit is sent", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { fields: { Status: "Done" } });
  g.issues.get(12)!.state = "CLOSED";
  g.issues.get(12)!.closedAt = "2026-10-30T18:18:00Z";
  g.items.get("PVTI_I_12")!.fields.Status = "In progress";
  g.history.push({ issue: 12, by: "github-project-automation", at: "2026-10-30T13:32:13Z", field: "field:Status", value: "In progress" });
  await send(g.gh);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  expect(g.items.get("PVTI_I_12")!.fields.Status).toBe("Done");
});

test("the automation moving the Status between the check and the write is not another person's edit", () => {
  const after = { events: [{ __typename: "ProjectV2ItemStatusChangedEvent", actor: { login: "github-project-automation" }, createdAt: "2026-10-30T00:00:02Z", status: "Done", project: { id: "P_1" } }], edits: [], viewer: "me" };
  expect(theirEdit("field:Status", after, "2026-10-30T00:00:00Z", "P_1", "In review")).toBeNull();
  const person = { ...after, events: [{ ...after.events[0]!, actor: { login: "someone" } }] };
  expect(theirEdit("field:Status", person, "2026-10-30T00:00:00Z", "P_1", "In review")).toMatchObject({ value: "Done", editor: "someone" });
});

test("an edit after an item's first one is made on that edit's value, before GitHub has the item", () => {
  editStoredIssue(db, S, 3, { fields: { Status: "In progress" } });
  commentStoredIssue(db, S, 3, "PR: #1");
  editStoredIssue(db, S, 3, { fields: { Status: "In review" } });
  const status = db.listPendingBacklogOperations(S).filter((o) => o.field === "field:Status");
  expect(status.map((o) => [o.payload, o.base])).toEqual([["In progress", null], ["In review", "In progress"]]);
});

test("a later edit that reaches GitHub's stored value lets a held Status go, with the comments behind it, though no import comes", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { fields: { Status: "In review" } });
  g.items.get("PVTI_I_12")!.fields.Status = "Done";
  await send(g.gh);
  expect(db.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
  db.putBacklogSnapshot(S, { records: [{ objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Done" } }, fetchState: "fetched" }], cursor: null, syncedAt: 2 });
  commentStoredIssue(db, S, 12, "## 結果");
  editStoredIssue(db, S, 12, { fields: { Status: "Done" } });
  // the conflict is gone; the new edit still goes through the check, as the stored value may be old
  expect(db.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["pending", "pending"]);
  await send(g.gh);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
});

test("a Status conflict held before the send could tell the automation is looked at again; one found by the write stays", () => {
  const path = join(dir, "m.db");
  const d = new Db(path);
  seed(d);
  editStoredIssue(d, S, 12, { fields: { Status: "In review" } });
  editStoredIssue(d, S, 12, { title: "新しい題" });
  const [title, status] = [...d.listPendingBacklogOperations(S)].sort((a, b) => (a.field === "title" ? -1 : b.field === "title" ? 1 : 0));
  d.setBacklogOperationResult(status!.id, { status: "conflict", error: "競合" });
  d.setBacklogOperationResult(title!.id, { status: "conflict", error: "競合" });
  editStoredIssue(d, S, 3, { fields: { Status: "Ready" } });
  const written = d.listPendingBacklogOperations(S).at(-1)!;
  d.setBacklogOperationResult(written.id, { status: "conflict", overwritten: { editor: "someone", at: null }, error: "書いた後" });
  // from before this migration: the mark of an opened database is taken off
  d.close();
  const old = new Database(path);
  old.exec("PRAGMA user_version = 0");
  old.close();
  const again = new Db(path);
  expect(again.getBacklogOperation(status!.id)).toMatchObject({ status: "pending", error: null });
  expect(again.getBacklogOperation(title!.id)).toMatchObject({ status: "conflict" });
  expect(again.getBacklogOperation(written.id)).toMatchObject({ status: "conflict" });
  // once: a conflict held after it stays one through a restart, until it is chosen on
  again.setBacklogOperationResult(status!.id, { status: "conflict", error: "本当の競合" });
  again.close();
  const third = new Db(path);
  expect(third.getBacklogOperation(status!.id)).toMatchObject({ status: "conflict" });
  third.close();
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

test("a failed create retried after its cause is put right: the Issue is not made twice, its Project item and fields are set and the edits after it are sent", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "Project に入れない PBI", body: "", labels: [], milestone: null, parent: null, fields: { Status: "Ready" } });
  // the token cannot write the Project: the Issue is made, its Project item refused
  g.fail.push({ match: (a) => a.some((x) => x.includes("addProjectV2ItemById")), status: 403 });
  expect(await send(g.gh)).toBe(0);
  const made = [...g.issues.values()].find((i) => i.title === "Project に入れない PBI")!;
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "failed", remoteId: made.node_id });
  // an edit after it waits behind the failed create
  editStoredIssue(db, S, made.number, { title: "直した題" });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["create", null, "failed"], ["set", "title", "pending"]]);
  expect(made.title).toBe("Project に入れない PBI");

  // the cause put right, sent again
  const issues = g.issues.size;
  expect(retryStoredOperation(db, S, made.number, localId)).toEqual({ operation: localId });
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.size).toBe(issues);
  expect([...g.items.values()].filter((i) => i.issue === made.node_id)).toEqual([{ issue: made.node_id, fields: { Status: "Ready" } }]);
  expect(made.title).toBe("直した題");
  expect(statuses()).toEqual([]);
});

test("a retried operation refused again is failed with the new reason and not tried again by itself", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { title: "書けない題" });
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 403, stderr: "HTTP 403: 最初の理由" });
  expect(await send(g.gh)).toBe(0);
  const id = db.listPendingBacklogOperations(S)[0]!.id;
  expect(db.getBacklogOperation(id)).toMatchObject({ status: "failed", error: expect.stringContaining("最初の理由") });
  retryStoredOperation(db, S, 12, id, t);
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 422, stderr: "HTTP 422: 次の理由" });
  expect(await send(g.gh)).toBe(0);
  expect(db.getBacklogOperation(id)).toMatchObject({ status: "failed", error: expect.stringContaining("次の理由") });
  // not sent again without being asked to
  g.writes.length = 0;
  t += 24 * 3_600_000;
  expect(await send(g.gh)).toBe(0);
  expect(g.writes).toEqual([]);
  expect(g.issues.get(12)!.title).toBe("PBI");
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

test("a Project field emptied here: GitHub's field is cleared, and a closed Issue's stored item has no value for it after the send's read-back", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  db.putBacklogSnapshot(S, { records: [], cursor: "2026-10-01T00:00:00Z", syncedAt: 1 });
  g.items.get("PVTI_I_12")!.fields["Story Points"] = 3;
  const reads = importsToo(g);
  const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const values = () => Object.entries(g.items.get("PVTI_I_12")!.fields).map(([name, v]) => ({ ...(typeof v === "number" ? { number: v } : { name: v }), field: { name } }));
  const item12 = () => ({ number: 12, projectItems: { totalCount: 1, nodes: [{ id: "PVTI_I_12", project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: values().length, nodes: values() } }] } });
  let closed = false;
  let closing: unknown = null;
  const gh: GhRunner = async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (/w\d+: issue\(number:/.test(q)) return answer({ repository: { w12: item12() } });
    // closed, the Issue is on no list: only the read by number after the send has its item
    if (q.includes("issues(first:100")) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: closed ? [] : [item12()] } } });
    if (q.includes("states:[OPEN,CLOSED]")) {
      // the Issues updated since: the closing, read with the item as it was then
      if (!closing) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
      const r = JSON.parse((await reads(args, cwd)).stdout);
      r.data.repository.issues.nodes[0].projectItems = closing;
      closing = null;
      return { code: 0, stdout: JSON.stringify(r), stderr: "" };
    }
    return reads(args, cwd);
  };
  const sync = makeSync(db, gh, () => Date.parse("2026-10-20T00:00:00Z"));
  await sync.sync(ws);
  expect(readStoredIssue(db, ws, 12)!.fields).toEqual({ Status: "Backlog", "Story Points": 3 });
  g.issues.get(12)!.state = "CLOSED";
  closed = true;
  closing = item12().projectItems;
  await sync.sync(ws);
  expect(readStoredIssue(db, ws, 12)!).toMatchObject({ issue: { state: "CLOSED" }, fields: { "Story Points": 3 } });
  editStoredIssue(db, S, 12, { fields: { "Story Points": null } });
  await sync.send(ws);
  expect(g.writes).toEqual([expect.stringContaining("clearProjectV2ItemFieldValue")]);
  expect(g.items.get("PVTI_I_12")!.fields).toEqual({ Status: "Backlog" });
  await sync.sync(ws);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
  expect(readStoredIssue(db, ws, 12)!.issue.state).toBe("CLOSED");
  expect(readStoredIssue(db, ws, 12)!.fields).toEqual({ Status: "Backlog" });
  // already empty: nothing is stored to send
  expect(editStoredIssue(db, S, 12, { fields: { "Story Points": null } }).operations).toEqual([]);
});

test("emptying a field of an Issue not in the Project stores nothing and does not put it there, as the set outside a Task", () => {
  expect(editStoredIssue(db, S, 3, { fields: { "Story Points": null } }).operations).toEqual([]);
  expect(db.listBacklogRecords(S, "project-item").map((r) => r.externalId)).toEqual(["PVTI_I_12"]);
  // a value still puts it there
  editStoredIssue(db, S, 3, { fields: { "Story Points": 5, Area: null } });
  expect(statuses()).toEqual([["set", "member", "pending"], ["set", "field:Story Points", "pending"], ["set", "field:Area", "pending"]]);
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

test("422 で断られた set: GitHub が既に送る値なら done で後ろも送られ、読み直しても違う値なら failed", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  commentStoredIssue(db, S, 12, "閉じた後の結果");
  editStoredIssue(db, S, 3, { state: "CLOSED" });
  // Issue 12: the Project's Auto-close closes it between the check and the PATCH, which GitHub refuses with 422
  const gh: GhRunner = async (args, cwd) => {
    if (args.includes("PATCH") && args.includes("repos/acme/app/issues/12")) g.issues.get(12)!.state = "CLOSED";
    return g.gh(args, cwd);
  };
  g.fail.push({ match: (a) => a.includes("PATCH") && a.includes("repos/acme/app/issues/12"), status: 422 });
  // Issue 3: refused, and GitHub is still OPEN
  g.fail.push({ match: (a) => a.includes("PATCH") && a.includes("repos/acme/app/issues/3"), status: 422 });
  const [closing] = db.listPendingBacklogOperations(S);
  expect(await send(gh)).toBe(2);
  expect(db.getBacklogOperation(closing!.id)).toMatchObject({ status: "done", error: expect.stringContaining("読み直すと GitHub は既に送る値") });
  expect(statuses()).toEqual([["set", "state", "failed"]]);
  expect(g.issues.get(12)!.comments.map((c) => c.body)).toEqual([expect.stringContaining("閉じた後の結果")]);
  expect(g.issues.get(3)!.state).toBe("OPEN");
});

test("422 で断られた set の読み直し: 上限なら待って送り直し、ほかの失敗なら failed", async () => {
  const g = fakeGithub();
  editStoredIssue(db, S, 12, { state: "CLOSED" });
  // the read after the refusal meets a limit: the run stops, the edit waits for the time and is not failed
  const readAfterPatch = (status: number, headers?: string): GhRunner => async (args, cwd) => {
    if (args.includes("PATCH")) {
      g.issues.get(12)!.state = "CLOSED";
      g.fail.push({ match: (a) => a[1] === "graphql", status, headers });
    }
    return g.gh(args, cwd);
  };
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 422 });
  await expect(send(readAfterPatch(429, "retry-after: 120\n"))).rejects.toMatchObject({ kind: "limit" });
  expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "pending", retryAt: t + 120_000 });
  // GitHub not reached, or the login refused, on the read: the same, waiting and not failed
  for (const [answer, kind] of [["error connecting to api.github.com", "offline"], ["HTTP 401: Bad credentials", "auth"]] as const) {
    t += 3_600_000;
    g.issues.get(12)!.state = "OPEN";
    let patched = false;
    const gh: GhRunner = async (args, cwd) => {
      if (args.includes("PATCH")) {
        patched = true;
        g.issues.get(12)!.state = "CLOSED";
      } else if (patched && args[1] === "graphql") return { code: 1, stdout: kind === "auth" ? "HTTP/2.0 401 X\ncontent-type: application/json\n\n{}" : "", stderr: answer };
      return g.gh(args, cwd);
    };
    g.fail.push({ match: (a) => a.includes("PATCH"), status: 422 });
    await expect(send(gh)).rejects.toMatchObject({ kind, until: kind === "offline" ? t + 60_000 : t });
    // not a try and no time of its own: the host's wait decides when it goes again
    expect(db.listPendingBacklogOperations(S)[0]).toMatchObject({ status: "pending", retryAt: null });
  }
  // another failure of the read: failed as before
  db.sqlite.query("DELETE FROM backlog_operations").run();
  g.issues.get(12)!.state = "OPEN";
  editStoredIssue(db, S, 3, { state: "CLOSED" });
  const other: GhRunner = async (args, cwd) => {
    if (args.includes("PATCH")) g.fail.push({ match: (a) => a[1] === "graphql", status: 404 });
    return g.gh(args, cwd);
  };
  g.fail.push({ match: (a) => a.includes("PATCH"), status: 422 });
  expect(await send(other)).toBe(0);
  expect(statuses()).toEqual([["set", "state", "failed"]]);
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

test("a create whose answer was lost and that GitHub does not have is made again once every page is read", async () => {
  const g = fakeGithub();
  createStoredIssue(db, S, { title: "新しい", body: "", labels: [], milestone: null, parent: null, fields: null });
  // GitHub answers 502 and makes nothing
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST"), status: 502 });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["create", null, "unknown"]]);
  expect(g.issues.size).toBe(2);
  // the next send reads every page, finds no marker, and makes it with the same marker
  expect(await send(g.gh)).toBe(1);
  expect(statuses()).toEqual([]);
  const made = [...g.issues.values()].filter((i) => i.title === "新しい");
  expect(made).toHaveLength(1);
  expect(made[0]!.body).toMatch(/<!-- switchboard-op:[0-9a-f-]+ -->$/);
});

test("a comment whose answer was lost and that GitHub does not have is posted again; its label waits for it", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "A で");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502 });
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["comment", null, "unknown"], ["set", "label:needs-decision", "pending"]]);
  // a look that cannot read the comments keeps it, the first 502 still told in the Issue's held line
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  g.fail.push({ match: (a) => a[1]!.includes("/comments?"), status: 503 });
  expect(await send(g.gh)).toBe(0);
  expect(g.issues.get(12)!.comments).toHaveLength(0);
  expect(readStoredIssue(db, ws, 12)!.held).toEqual([expect.objectContaining({ kind: "comment", status: "unknown", reason: expect.stringMatching(/^最初の失敗: .*HTTP 502 \/ 照合: .*HTTP 503/) })]);
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  expect(g.issues.get(12)!.labels).toEqual(["type:pbi"]);
});

test("an unknown create whose look cannot read the list is not made again: it waits unknown, its first error kept in front", async () => {
  const g = fakeGithub();
  createStoredIssue(db, S, { title: "新しい", body: "", labels: [], milestone: null, parent: null, fields: null });
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST"), status: 502 });
  await send(g.gh);
  g.fail.push({ match: (a) => a[1]!.startsWith("repos/acme/app/issues?"), status: 502, stderr: "HTTP 502 list" });
  g.writes.length = 0;
  expect(await send(g.gh)).toBe(0);
  expect(g.writes).toEqual([]);
  const op = () => db.listPendingBacklogOperations(S)[0]!;
  expect(op()).toMatchObject({ status: "unknown", error: expect.stringMatching(/^最初の失敗: gh api repos\/acme\/app\/issues: HTTP 502 \/ 照合: .*HTTP 502 list/) });
  // and again: the first one stays in front, once
  g.fail.push({ match: (a) => a[1]!.startsWith("repos/acme/app/issues?"), status: 503 });
  await send(g.gh);
  expect(op().error).toMatch(/^最初の失敗: gh api repos\/acme\/app\/issues: HTTP 502 \/ 照合: .*HTTP 503$/);
  expect(op().error!.match(/最初の失敗/g)).toHaveLength(1);
});

test("a held failed edit and an unknown comment taken back: nothing written, the held lines and the waiting count go, the edits after them are sent", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  editStoredIssue(db, S, 12, { title: "断られる題" });
  answerStoredDecision(db, S, 12, "A で");
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues/12" && a.includes("PATCH"), status: 422 });
  expect(await send(g.gh)).toBe(0);
  expect(readStoredIssue(db, ws, 12)!.held).toEqual([expect.objectContaining({ field: "title", status: "failed" })]);
  const title = db.listPendingBacklogOperations(S).find((o) => o.field === "title")!;
  const before = readStoredIssue(db, ws, 12)!.pending;
  g.writes.length = 0;
  expect(withdrawStoredOperation(db, S, 12, { operation: title.id, reason: "題は GitHub のままでよい" })).toEqual({ operation: title.id });
  expect(g.writes).toEqual([]);
  expect(readStoredIssue(db, ws, 12)).toMatchObject({ held: [], pending: before - 1, issue: { title: "PBI" } });
  expect(db.getBacklogOperation(title.id)).toMatchObject({ status: "done", error: "取り下げました: 題は GitHub のままでよい" });
  // a comment left unknown: taken back the same way, its unsent record gone, the label after it goes out
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502 });
  expect(await send(g.gh)).toBe(0);
  const note = db.listPendingBacklogOperations(S).find((o) => o.kind === "comment")!;
  expect(note.status).toBe("unknown");
  withdrawStoredOperation(db, S, 12, { operation: note.id, reason: "回答は別に書き直す" });
  expect(db.getBacklogRecord({ ...S, objectKind: "comment", externalId: note.target })).toBeNull();
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(12)!.labels).toEqual(["type:pbi"]);
  expect(g.issues.get(12)!.comments).toEqual([]);
  expect(statuses()).toEqual([]);
  // only a held one of the Issue: a pending one or another Issue's is refused
  editStoredIssue(db, S, 12, { title: "待っている題" });
  const pending = db.listPendingBacklogOperations(S)[0]!;
  expect(() => withdrawStoredOperation(db, S, 12, { operation: pending.id, reason: "x" })).toThrow("結果不明か失敗で保留されていません");
  expect(() => withdrawStoredOperation(db, S, 3, { operation: pending.id, reason: "x" })).toThrow("取り下げられる操作");
});

test("an unknown comment is not taken back while it is being looked for and sent; an operation of the enabling of GitHub sync never is", async () => {
  const g = fakeGithub();
  answerStoredDecision(db, S, 12, "A で");
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502 });
  await send(g.gh);
  const note = db.listPendingBacklogOperations(S).find((o) => o.kind === "comment")!;
  expect(note.status).toBe("unknown");
  // the withdraw comes while the send looks for its marker: refused, and the send goes on to post it once
  let refused: unknown = null;
  const gh: GhRunner = async (args, cwd) => {
    if (args[1]?.includes("/comments?") && !refused) refused = (() => { try { withdrawStoredOperation(db, S, 12, { operation: note.id, reason: "x" }); return "taken"; } catch (e) { return (e as Error).message; } })();
    return g.gh(args, cwd);
  };
  expect(await send(gh)).toBe(2);
  expect(refused).toBe("この操作は結果不明か失敗で保留されていません");
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  // an `sb:` create (the enabling, backlog-enable.ts) held failed: sent again, not taken back
  const { localId } = createStoredIssue(db, S, { title: "有効化", body: "", labels: [], milestone: null, parent: null, fields: null });
  db.sqlite.query("UPDATE backlog_operations SET target = 'sb:7', status = 'failed' WHERE id = ?").run(localId);
  expect(() => db.withdrawBacklogOperation(S, localId, "x")).toThrow("GitHub 同期の有効化の操作は取り下げられません");
});

test("an unknown create of an Issue never made, taken back: the edits made to it go with it, and nothing is left to send", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "作らない", body: "", labels: [], milestone: null, parent: null, fields: null });
  editStoredIssue(db, S, localId, { title: "作らない（直した）" });
  db.setBacklogOperationResult(localId, { status: "unknown" });
  const create = db.getBacklogOperation(localId)!;
  withdrawStoredOperation(db, S, localId, { operation: create.id, reason: "作らないと決めた" });
  expect(statuses()).toEqual([]);
  expect(db.listBacklogRecords(S, "issue").some((r) => r.externalId === create.target)).toBe(false);
  expect(await send(g.gh)).toBe(0);
  expect(g.writes).toEqual([]);
});

test("a create failed after the Issue was made (its Project item refused), taken back: the Issue stays, no Project step is sent, and the comment behind it is sent", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "Project に入れない作成", body: "", labels: [], milestone: null, parent: null, fields: { Status: "Ready" } });
  g.fail.push({ match: (a) => a.some((x) => x.includes("addProjectV2ItemById")), status: 403 });
  expect(await send(g.gh)).toBe(0);
  const made = [...g.issues.values()].find((i) => i.title === "Project に入れない作成")!;
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "failed", remoteId: made.node_id });
  commentStoredIssue(db, S, made.number, "後ろのコメント");
  expect(await send(g.gh)).toBe(0);
  expect(statuses()).toEqual([["create", null, "failed"], ["comment", null, "pending"]]);

  expect(withdrawStoredOperation(db, S, made.number, { operation: localId, reason: "Project には入れない" })).toEqual({ operation: localId });
  g.fail.length = 0;
  g.writes.length = 0;
  expect(await send(g.gh)).toBe(1);
  expect(g.writes).toEqual([`POST repos/acme/app/issues/${made.number}/comments`]);
  expect(g.writes.some((w) => w.includes("addProjectV2ItemById") || w.includes("updateProjectV2ItemFieldValue"))).toBe(false);
  expect([...g.items.values()].filter((i) => i.issue === made.node_id)).toEqual([]);
  expect([...g.issues.values()].filter((i) => i.title === "Project に入れない作成")).toHaveLength(1);
  expect(made.comments.map((c) => c.body)).toEqual([expect.stringContaining("後ろのコメント")]);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", error: "取り下げました: Project には入れない" });
  // unlike a create never made, the Issue's record stays here too
  expect(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: made.node_id })?.remote).toMatchObject({ number: made.number });
  expect(statuses()).toEqual([]);
});

test("both answers lost (the first post and the one made again): the next look finds two, keeps the first made and drops the other", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "二度失う", body: "", labels: [], milestone: null, parent: null, fields: null });
  answerStoredDecision(db, S, 12, "A で");
  const op = db.getBacklogOperation(localId)!;
  const comment = db.listPendingBacklogOperations(S).find((o) => o.kind === "comment")!;
  // two of each already on GitHub with the operation's marker (both posts carried out, both answers lost)
  const issueBody = `\n\n<!-- switchboard-op:${op.id} -->`;
  for (const number of [200, 201]) g.issues.set(number, { node_id: `I_${number}`, number, title: "二度失う", body: issueBody, state: "OPEN", labels: [], parent: null, comments: [] });
  g.issues.get(12)!.comments.push(...[0, 1].map((k) => ({ node_id: `IC_12_${k}`, body: `## 回答\n\nA で\n\n<!-- switchboard-op:${comment.id} -->`, created_at: `2026-10-08T00:00:0${k}Z` })));
  for (const id of [op.id, comment.id]) db.setBacklogOperationResult(id, { status: "unknown" });
  g.writes.length = 0;
  expect(await send(g.gh)).toBe(3);
  // the list is newest first: the first made stays, Issue 201 is closed; the older comment stays
  expect(db.getBacklogOperation(localId)!.remoteId).toBe("I_200");
  expect([g.issues.get(200)!.state, g.issues.get(201)!.state, g.issues.get(201)!.stateReason]).toEqual(["OPEN", "CLOSED", "NOT_PLANNED"]);
  expect(g.issues.get(12)!.comments.map((c) => c.node_id)).toEqual(["IC_12_0"]);
  expect(g.writes.filter((w) => w.startsWith("PATCH") || w.includes("deleteIssueComment"))).toEqual(["PATCH repos/acme/app/issues/201", expect.stringContaining("deleteIssueComment")]);
});

test("a limit on the close of the second one: the operation is done with the first, and the run stops for GitHub's time", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "制限", body: "", labels: [], milestone: null, parent: null, fields: null });
  editStoredIssue(db, S, 12, { title: "後ろの編集" });
  const op = db.getBacklogOperation(localId)!;
  for (const number of [200, 201]) g.issues.set(number, { node_id: `I_${number}`, number, title: "制限", body: `<!-- switchboard-op:${op.id} -->`, state: "OPEN", labels: [], parent: null, comments: [] });
  db.setBacklogOperationResult(localId, { status: "unknown" });
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues/201" && a.includes("PATCH"), status: 429, headers: "retry-after: 600\n" });
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: "I_200" });
  // the edit after it waits for the limit, not sent in the same run
  expect(g.issues.get(12)!.title).toBe("PBI");
});

test("a limit on the close of the second one holds the create's own steps too: its parent waits, then is set from the Issue kept", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "親つき", body: "", labels: [], milestone: null, parent: 3, fields: null });
  const op = db.getBacklogOperation(localId)!;
  for (const number of [200, 201]) g.issues.set(number, { node_id: `I_${number}`, number, title: "親つき", body: `<!-- switchboard-op:${op.id} -->`, state: "OPEN", labels: [], parent: null, comments: [] });
  db.setBacklogOperationResult(localId, { status: "unknown" });
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues/201" && a.includes("PATCH"), status: 429, headers: "retry-after: 600\n" });
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  expect(g.issues.get(200)!.parent).toBeNull();
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "unknown", remoteId: "I_200" });
  // after the wait: the steps go on from the Issue kept, nothing made again
  t += 700_000;
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(200)!.parent).toBe(3);
  expect(db.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: "I_200" });
  expect([...g.issues.values()].filter((i) => i.title === "親つき")).toHaveLength(2);
});

test("made again and the first one shows up after all: the later one is closed (an Issue) or deleted (a comment), one left", async () => {
  const g = fakeGithub();
  const { localId } = createStoredIssue(db, S, { title: "新しい", body: "", labels: [], milestone: null, parent: null, fields: null });
  answerStoredDecision(db, S, 12, "A で");
  // both carried out, both answers lost
  g.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST"), status: 502, after: true });
  g.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502, after: true });
  await send(g.gh);
  expect(statuses().map((s) => s[2])).toEqual(["unknown", "unknown", "pending"]);
  const first = [...g.issues.values()].find((i) => i.title === "新しい")!;
  // the first look misses them (the lists lag behind), the one after the post made again sees both
  const lag = new Set(["issues", "comments"]);
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    const list = /^repos\/acme\/app\/issues(\/12\/comments)?\?/.exec(args[1] ?? "");
    const kind = list ? (list[1] ? "comments" : "issues") : null;
    if (!kind || !lag.delete(kind)) return r;
    const [head, body] = r.stdout.split("\n\n");
    return { ...r, stdout: `${head}\n\n${JSON.stringify((JSON.parse(body!) as Array<{ body: string }>).filter((x) => !x.body.includes("switchboard-op")))}` };
  };
  expect(await send(gh)).toBe(3);
  const made = [...g.issues.values()].filter((i) => i.title === "新しい");
  expect(made.map((i) => [i.number, i.state, i.stateReason ?? null])).toEqual([[first.number, "OPEN", null], [first.number + 1, "CLOSED", "NOT_PLANNED"]]);
  expect(db.getBacklogOperation(localId)!.remoteId).toBe(first.node_id);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  expect(g.issues.get(12)!.comments[0]!.node_id).toBe("IC_12_0");
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
  expect(db.listPendingBacklogOperations(S).map((o) => [o.status, o.attempt, o.retryAt])).toEqual([["pending", 0, null], ["pending", 0, t], ["pending", 0, null]]); // the comment's window ended at t
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

test("a run stops before the next operation once the sync is turned off; the rest waits as it is", async () => {
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

test("a set whose read was out when the sync was turned off writes nothing; it waits as it was", async () => {
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

test("a comment is sent only after its window (60 s), and can be taken back inside it; a set after it waits for it", async () => {
  const g = fakeGithub();
  const kept = commentWindowed(db, S, 12, "送る", t).operation;
  expect(db.getBacklogOperation(kept)).toMatchObject({ status: "pending", retryAt: t + SEND_DELAY_MS });
  // inside the window: not asked, and a `set` queued after the comment waits behind it (the held rule as it is)
  editStoredIssue(db, S, 12, { title: "コメントのあと" });
  expect(await send(g.gh)).toBe(0);
  expect(g.writes).toEqual([]);
  t += SEND_DELAY_MS;
  expect(await send(g.gh)).toBe(2);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  expect(g.issues.get(12)!.title).toBe("コメントのあと");

  // taken back inside the window: never sent, done with why
  const gone = commentWindowed(db, S, 12, "取り消す", t).operation;
  expect(cancelStoredOperation(db, S, 12, gone, t + 1)).toEqual({ operation: gone });
  const kept2 = db.getBacklogOperation(gone)!;
  expect(kept2).toMatchObject({ status: "done", error: "送る前に取り消しました" });
  // and the comment kept here goes with it (as a withdrawn post's does): nothing reads its words any more
  expect(kept2.target).toStartWith("local:");
  expect(db.getBacklogRecord({ ...S, objectKind: "comment", externalId: kept2.target })).toBeNull();
  t += 10 * SEND_DELAY_MS;
  expect(await send(g.gh)).toBe(0);
  expect(g.issues.get(12)!.comments).toHaveLength(1);
});

test("a comment whose window ends during a send run still gets its timer", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  // the run takes longer than the window: the edit of Issue 3 after the comment moves the clock past the comment's time
  const gh: GhRunner = async (args, cwd) => {
    const r = await g.gh(args, cwd);
    if (args.includes("PATCH")) t += 2 * SEND_DELAY_MS;
    return r;
  };
  const sync = makeSync(db, gh, clock);
  const timers: number[] = [];
  (sync as unknown as { later: (w: unknown, s: unknown, at: number) => void }).later = (_w, _s, at) => void timers.push(at);
  const kept = commentWindowed(db, S, 12, "窓の中", t).operation;
  const due = db.getBacklogOperation(kept)!.retryAt!;
  editStoredIssue(db, S, 3, { title: "別の Issue" });
  await sync.send(ws);
  expect(g.issues.get(3)!.title).toBe("別の Issue");
  expect(db.getBacklogOperation(kept)!.status).toBe("pending");
  expect(timers).toEqual([due]);
  // the next run sends it, and leaves no timer behind
  timers.length = 0;
  await sync.send(ws);
  expect(g.issues.get(12)!.comments.some((c) => c.body.startsWith("窓の中"))).toBe(true);
  expect(timers).toEqual([]);
});

test("inSendWindow: only a comment still in the window it was written with — not one waiting out a backoff or a limit", () => {
  const op = { kind: "comment" as const, status: "pending" as const, attempt: 0, createdAt: t, retryAt: t + SEND_DELAY_MS };
  expect(inSendWindow(op, t)).toBe(true);
  expect(inSendWindow(op, t + SEND_DELAY_MS)).toBe(false);
  expect(inSendWindow({ ...op, attempt: 1 }, t)).toBe(false);
  expect(inSendWindow({ ...op, retryAt: t + 5 * 60_000 }, t)).toBe(false);
  expect(inSendWindow({ ...op, kind: "set" }, t)).toBe(false);
});

test("a comment past its window, sent, or not a comment is not taken back: 409; no such operation: 404", async () => {
  const g = fakeGithub();
  const late = commentWindowed(db, S, 12, "遅い", t).operation;
  expect(() => cancelStoredOperation(db, S, 12, late, t + SEND_DELAY_MS)).toThrow(expect.objectContaining({ status: 409 }));
  expect(await send(g.gh)).toBe(0);
  t += SEND_DELAY_MS;
  expect(await send(g.gh)).toBe(1);
  // sent: no longer to send, so nothing to take back
  expect(() => cancelStoredOperation(db, S, 12, late, t)).toThrow(expect.objectContaining({ status: 409 }));
  // an edit is not a comment
  const [title] = editStoredIssue(db, S, 12, { title: "題" }).operations;
  expect(() => cancelStoredOperation(db, S, 12, title!, t)).toThrow(expect.objectContaining({ status: 409 }));
  expect(() => db.cancelBacklogOperation(S, "no-such", t)).toThrow(expect.objectContaining({ status: 404 }));
});
