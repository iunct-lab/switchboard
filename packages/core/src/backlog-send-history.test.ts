// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { BacklogIssueData } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { editStoredIssue } from "./backlog-edit.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { Limit, sendGithubOperations } from "./backlog-send.ts";
import { conflictRevision } from "./backlog-merge.ts";
import { S, clock, commentStoredIssue, fakeGithub, later, seed, send, useSendDb } from "./api-test-harness.ts";

let dir: string;
let db: Db;
let t = 1_000_000;
useSendDb({ get dir() { return dir; }, set dir(v) { dir = v; }, get db() { return db; }, set db(v) { db = v; }, get t() { return t; }, set t(v) { t = v; } });

test("history: another login's edit between the check and the write is held with its value, editor and time — for each field the history tells; one that made the field the value sent is nothing lost", async () => {
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

test("history: the history refused or not read whole after the write holds the edit as unverified — never failed or pending; a write refused with 412 or 409 is held too", async () => {
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

test("history: two edits of theirs in the same second keep the newer; another Project's Status change is not this one's; a limit met by the read after the write keeps the outcome and stops the run", async () => {
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

test("unreadable の未確認の競合: 上限が戻った後の送信で履歴を読み直し、ほかの編集が無ければ done、あれば競合、読み切れない・旧形式は今どおり", async () => {
  const afterRead = (a: string[]) => a.some((x) => x.includes("timelineItems"));
  const unverified = async (d: Db, g: ReturnType<typeof fakeGithub>) => {
    g.fail.push({ match: afterRead, status: 429, headers: "retry-after: 120\n" });
    editStoredIssue(d, S, 12, { title: "v3" }, t);
    commentStoredIssue(d, S, 12, "題の後のコメント", t);
    await expect(sendGithubOperations(g.gh, d, dir, S, clock)).rejects.toBeInstanceOf(Limit);
    const [op] = d.listPendingBacklogOperations(S);
    expect(op).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("429"), since: expect.any(String) } });
    t += 3_600_000;
    return op!;
  };
  // the history read again: no one else's edit → done, and the comment behind it goes out
  const g = fakeGithub();
  const op = await unverified(db, g);
  expect(await send(g.gh)).toBe(2);
  expect(db.getBacklogOperation(op.id)).toMatchObject({ status: "done", overwritten: null, error: expect.stringContaining("確かめました") });
  expect(g.issues.get(12)!.comments).toHaveLength(1);
  // another login's edit in the window → the conflict with it, the comment still held
  const g2 = fakeGithub();
  const d2 = new Db(join(dir, "two.db"));
  seed(d2);
  const op2 = await unverified(d2, g2);
  g2.history.push({ issue: 12, by: "them", at: op2.overwritten!.since!, field: "title", value: "相手の題" });
  expect(await sendGithubOperations(g2.gh, d2, dir, S, clock)).toBe(0);
  expect(d2.getBacklogOperation(op2.id)).toMatchObject({ status: "conflict", overwritten: { value: "相手の題", editor: "them" } });
  expect(g2.issues.get(12)!.comments).toHaveLength(0);
  d2.close();
  // still not read whole, or the history read refused again: held as it was
  const g3 = fakeGithub();
  const d3 = new Db(join(dir, "three.db"));
  seed(d3);
  const op3 = await unverified(d3, g3);
  g3.state.historyNext = true;
  expect(await sendGithubOperations(g3.gh, d3, dir, S, clock)).toBe(0);
  g3.state.historyNext = false;
  g3.fail.push({ match: afterRead, status: 403 });
  expect(await sendGithubOperations(g3.gh, d3, dir, S, clock)).toBe(0);
  expect(d3.getBacklogOperation(op3.id)).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("429") } });
  // a limit on the read again: the run stops, the conflict stays as it was
  g3.fail.push({ match: afterRead, status: 429, headers: "retry-after: 120\n" });
  await expect(sendGithubOperations(g3.gh, d3, dir, S, clock)).rejects.toBeInstanceOf(Limit);
  expect(d3.getBacklogOperation(op3.id)).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("429") } });
  d3.close();
  // stored before `since` was kept (no since): not read again, the user chooses as before
  const g4 = fakeGithub();
  const d4 = new Db(join(dir, "four.db"));
  seed(d4);
  const op4 = await unverified(d4, g4);
  d4.sqlite.query("UPDATE backlog_operations SET overwritten = ? WHERE id = ?").run(JSON.stringify({ editor: null, at: null, unreadable: "古い保留" }), op4.id);
  let reads = 0;
  const counting: GhRunner = async (a, c) => {
    if (afterRead(a)) reads++;
    return g4.gh(a, c);
  };
  expect(await sendGithubOperations(counting, d4, dir, S, clock)).toBe(0);
  expect(reads).toBe(0);
  expect(d4.getBacklogOperation(op4.id)).toMatchObject({ status: "conflict", overwritten: { unreadable: "古い保留" } });
  d4.close();
});

test("unreadable の未確認の競合: Project の Status は自動化の変更を相手の編集と数えず、Project の読みの上限は送信を止めて保留のまま", async () => {
  const afterRead = (a: string[]) => a.some((x) => x.includes("timelineItems"));
  const projectRead = (a: string[]) => a.some((x) => x.includes("projectV2(number:"));
  const g = fakeGithub();
  g.fail.push({ match: afterRead, status: 429, headers: "retry-after: 120\n" });
  editStoredIssue(db, S, 12, { fields: { Status: "Ready" } }, t);
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  const [op] = db.listPendingBacklogOperations(S);
  expect(op).toMatchObject({ field: "field:Status", status: "conflict", overwritten: { since: expect.any(String) } });
  t += 3_600_000;
  // the Project's id read again by the new run meets a limit: the run stops, the conflict stays as it was
  g.fail.push({ match: projectRead, status: 429, headers: "retry-after: 120\n" });
  await expect(send(g.gh)).rejects.toBeInstanceOf(Limit);
  expect(db.getBacklogOperation(op!.id)).toMatchObject({ status: "conflict", overwritten: { unreadable: expect.stringContaining("429") } });
  // the automation moving the Status in the window is nobody's edit: done
  g.history.push({ issue: 12, by: "github-project-automation", at: op!.overwritten!.since!, field: "field:Status", value: "In progress" });
  t += 3_600_000;
  expect(await send(g.gh)).toBe(1);
  expect(db.getBacklogOperation(op!.id)).toMatchObject({ status: "done", error: expect.stringContaining("確かめました") });
});

test("history: a title write does not ask for the body's edits — a body edit of theirs in the history is not its concern", async () => {
  const g = fakeGithub();
  g.history.push({ issue: 12, by: "them", at: later(), field: "body", value: "相手の本文" });
  editStoredIssue(db, S, 12, { title: "v3" }, t);
  expect(await send(g.gh)).toBe(1);
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
});

test("history: the body's edits have no since — a page that reaches back before the check read is whole, however many edits the body had; one that does not is not", async () => {
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

test("history: one's own login's edit is not another's; the read after the write stays one call", async () => {
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

test("chosen: remote on a conflict found after the write sends the other's value back on the next run, and GitHub comes to it", async () => {
  const g = fakeGithub();
  g.history.push({ issue: 12, by: "them", at: later(), field: "title", value: "相手の題" });
  editStoredIssue(db, S, 12, { title: "手元の題" }, t);
  expect(await send(g.gh)).toBe(0);
  const op = db.listPendingBacklogOperations(S)[0]!;
  expect(g.issues.get(12)!.title).toBe("手元の題");
  // the import after the run reads the local value back: the conflict stays
  db.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: { ...(db.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_12" })!.remote as BacklogIssueData), title: "手元の題" }, fetchState: "fetched" }], cursor: null, syncedAt: t });
  expect(db.getBacklogOperation(op.id)).toMatchObject({ status: "conflict" });
  db.resolveBacklogConflict(S, op.id, "remote", conflictRevision(db.getBacklogOperation(op.id)!, db.backlogRemoteValue(db.getBacklogOperation(op.id)!)));
  g.history.length = 0;
  t += 2000;
  expect(await send(g.gh)).toBe(1);
  expect(g.issues.get(12)!.title).toBe("相手の題");
  expect(db.listPendingBacklogOperations(S)).toEqual([]);
});
