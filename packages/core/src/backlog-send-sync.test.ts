// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Db } from "./db.ts";
import { editStoredIssue } from "./backlog-edit.ts";
import { readStoredBacklog, readStoredIssue } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { conflictRevision } from "./backlog-merge.ts";
import { isUnchanged } from "./backlog-pick.ts";
import { S, answerStoredDecision, clock, commentStoredIssue, fakeGithub, importsToo, makeSync, useSendDb } from "./api-test-harness.ts";

let dir: string;
let db: Db;
let t = 1_000_000;
useSendDb({ get dir() { return dir; }, set dir(v) { dir = v; }, get db() { return db; }, set db(v) { db = v; }, get t() { return t; }, set t(v) { t = v; } });

test("BacklogSync: the Project item the daemon wrote is read by number by the next light import, and no more after it stored", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  db.putBacklogSnapshot(S, { records: [], cursor: "2026-10-01T00:00:00Z", syncedAt: 1 });
  const reads = importsToo(g);
  const numbered: string[] = [];
  const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const open12 = () => ({ number: 12, projectItems: { totalCount: 1, nodes: [{ id: "PVTI_I_12", project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: 1, nodes: [{ name: g.items.get("PVTI_I_12")!.fields.Status, field: { name: "Status" } }] } }] } });
  const gh: GhRunner = async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (/w\d+: issue\(number:/.test(q)) {
      numbered.push(q.match(/w(\d+): /)![1]!);
      return answer({ repository: { w12: open12() } });
    }
    if (q.includes("issues(first:100")) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [open12()] } } });
    if (q.includes("states:[OPEN,CLOSED]")) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    return reads(args, cwd);
  };
  const sync = makeSync(db, gh, () => Date.parse("2026-10-20T00:00:00Z"));
  await sync.sync(ws); // the first is full
  editStoredIssue(db, S, 12, { title: "本文の変更は項目を読まない" });
  await sync.send(ws);
  await sync.sync(ws);
  expect(numbered).toEqual([]);
  editStoredIssue(db, S, 12, { fields: { Status: "Done" } });
  await sync.send(ws);
  await sync.sync(ws);
  expect(g.items.get("PVTI_I_12")!.fields.Status).toBe("Done");
  expect(numbered).toEqual(["12"]);
  await sync.sync(ws);
  expect(numbered).toEqual(["12"]);
});

test("BacklogSync: a Project field sent without a write, or held as a conflict, is read by number too; what an import did not store is read again", async () => {
  const g = fakeGithub();
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  db.putBacklogSnapshot(S, { records: [], cursor: "2026-10-01T00:00:00Z", syncedAt: 1 });
  const reads = importsToo(g);
  const numbered: string[] = [];
  let failing = false;
  let hold = false;
  let release = () => {};
  const answer = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const open12 = () => ({ number: 12, projectItems: { totalCount: 1, nodes: [{ id: "PVTI_I_12", project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: 1, nodes: [{ name: g.items.get("PVTI_I_12")!.fields.Status, field: { name: "Status" } }] } }] } });
  const gh: GhRunner = async (args, cwd) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (/w\d+: issue\(number:/.test(q)) return numbered.push("12"), answer({ repository: { w12: open12() } });
    if (q.includes("issues(first:100")) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [open12()] } } });
    if (q.includes("states:[OPEN,CLOSED]")) return answer({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    if (q.includes("pullRequests(") && failing) return answer({ repository: {} });
    if (q.includes("pullRequests(") && hold) await new Promise<void>((r) => (hold = false, release = r));
    return reads(args, cwd);
  };
  const sync = makeSync(db, gh, () => Date.parse("2026-10-20T00:00:00Z"));
  await sync.sync(ws);
  const look = async () => {
    await sync.sync(ws).catch(() => undefined);
    await sync.sync(ws).catch(() => undefined);
  };

  // GitHub already has the value: nothing is written, the item is read all the same
  editStoredIssue(db, S, 12, { fields: { Status: "In progress" } });
  g.items.get("PVTI_I_12")!.fields.Status = "In progress";
  await sync.send(ws);
  await look();
  expect(numbered).toEqual(["12"]);

  // held as a conflict: GitHub's value is what the choice is offered on
  numbered.length = 0;
  editStoredIssue(db, S, 12, { fields: { Status: "In review" } });
  g.items.get("PVTI_I_12")!.fields.Status = "Done";
  await sync.send(ws);
  await look();
  expect(numbered).toEqual(["12"]);
  expect(db.listPendingBacklogOperations(S).filter((o) => o.field === "field:Status").map((o) => o.status)).toEqual(["conflict"]);
  db.listPendingBacklogOperations(S).forEach((o) => db.resolveBacklogConflict(S, o.id, "remote", conflictRevision(db.getBacklogOperation(o.id)!, "Done")));
  await sync.send(ws);
  await look();

  // an import that failed stored nothing: the next one reads it again
  numbered.length = 0;
  failing = true;
  editStoredIssue(db, S, 12, { fields: { Status: "Ready" } });
  await sync.send(ws);
  await sync.sync(ws).catch(() => undefined);
  failing = false;
  await look();
  expect(numbered.length).toBeGreaterThanOrEqual(2);

  // one a write superseded stored nothing either
  numbered.length = 0;
  hold = true;
  editStoredIssue(db, S, 12, { fields: { Status: "Backlog" } });
  await sync.send(ws);
  await Bun.sleep(10);
  editStoredIssue(db, S, 12, { title: "読む間の書き込み" });
  await sync.send(ws);
  release();
  await look();
  expect(numbered.length).toBeGreaterThanOrEqual(2);
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

test("BacklogSync: an import that read before a write of a send run under way stores nothing, so the next edit of the field is not judged on the older value", async () => {
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

test("BacklogSync: the notice of the daemon's own send reads what it wrote, sends nothing more, and leaves the notice window as it was", async () => {
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

test("BacklogSync: an edit held at the check before the write is offered with GitHub's value it found (an import reads it); a refused write is held as failed with why", async () => {
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

/** The fake GitHub's reads with Issue 12's comments as GitHub has them (their own time, the one it received them at), and the PBI In progress. */
function readsWithComments(g: ReturnType<typeof fakeGithub>): GhRunner {
  const reads = importsToo(g);
  const patch = (n: { number: number; comments: unknown; projectItems: unknown }) => {
    if (n.number !== 12) return;
    n.comments = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: g.issues.get(12)!.comments.map((c) => ({ id: c.node_id, body: c.body, createdAt: c.created_at })) };
    n.projectItems = { totalCount: 1, nodes: [{ id: "PVTI_I_12", project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: 1, nodes: [{ name: "In progress", field: { name: "Status" } }] } }] };
  };
  return async (args, cwd) => {
    const r = await reads(args, cwd);
    if (r.code !== 0 || !r.stdout.startsWith("{")) return r;
    const data = JSON.parse(r.stdout).data?.repository;
    for (const n of data?.issues?.nodes ?? []) patch(n);
    for (const k of Object.keys(data ?? {})) if (/^w\d+$/.test(k)) patch(data[k]);
    return { ...r, stdout: JSON.stringify({ data: { repository: data } }) };
  };
}

test("BacklogSync: a comment written here keeps the written time after it is sent and after it is imported; one written on GitHub keeps GitHub's", async () => {
  const g = fakeGithub();
  g.issues.get(12)!.labels = ["type:pbi"];
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, readsWithComments(g), clock);
  await sync.sync(ws);
  const written = t - 60_000; // commentStoredIssue writes it as if its send window had passed
  commentStoredIssue(db, S, 12, "手元のコメント");
  await sync.send(ws);
  const sent = db.listBacklogRecords(S, "comment").map((r) => r.remote as { body: string; createdAt: string });
  expect(sent).toEqual([expect.objectContaining({ body: expect.stringContaining("手元のコメント"), createdAt: new Date(written).toISOString() })]);
  // a teammate's comment, then an import a minute later reads both as GitHub dated them
  g.issues.get(12)!.comments.push({ node_id: "IC_other", body: "あちらのコメント", created_at: "2026-10-09T00:00:00Z" });
  t += 61_000;
  await sync.sync(ws);
  const byBody = Object.fromEntries(db.listBacklogRecords(S, "comment").map((r) => [(r.remote as { body: string }).body.split("\n")[0]!, r]));
  expect(g.issues.get(12)!.comments[0]!.created_at).toBe("2026-10-08T00:00:00Z"); // what GitHub has for it
  for (const col of ["remote", "base"] as const) expect((byBody["手元のコメント"]![col] as { createdAt: string }).createdAt).toBe(new Date(written).toISOString());
  expect((byBody["あちらのコメント"]!.remote as { createdAt: string }).createdAt).toBe("2026-10-09T00:00:00Z");
});

test("BacklogSync: a comment whose operation is dated after the service received it (a clock running ahead) keeps the service's time", async () => {
  const g = fakeGithub();
  g.issues.get(12)!.labels = ["type:pbi"];
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, readsWithComments(g), clock);
  await sync.sync(ws);
  t = Date.parse("2026-10-08T00:03:00Z"); // the fake GitHub dates what it receives 2026-10-08T00:00:00Z
  commentStoredIssue(db, S, 12, "先の時計のコメント", t - 60_000);
  await sync.send(ws);
  t += 61_000;
  await sync.sync(ws);
  const [rec] = db.listBacklogRecords(S, "comment");
  for (const col of ["remote", "base"] as const) expect((rec![col] as { createdAt: string }).createdAt).toBe("2026-10-08T00:00:00Z");
});

test("BacklogSync: a comment GitHub dates to the second it was written in (the time cut to the second) keeps its written time", async () => {
  const g = fakeGithub();
  g.issues.get(12)!.labels = ["type:pbi"];
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, readsWithComments(g), clock);
  await sync.sync(ws);
  t = Date.parse("2026-10-08T00:02:00.400Z"); // its operation is dated a send window before (00:00:00.400); the fake GitHub dates what it receives 2026-10-08T00:00:00Z
  commentStoredIssue(db, S, 12, "同じ秒のコメント", t - 60_000);
  await sync.send(ws);
  t += 61_000;
  await sync.sync(ws);
  const [rec] = db.listBacklogRecords(S, "comment");
  for (const col of ["remote", "base"] as const) expect((rec![col] as { createdAt: string }).createdAt).toBe("2026-10-08T00:00:00.400Z");
});

test("BacklogSync: a release written after its claim still waits after the claim is sent", async () => {
  const g = fakeGithub();
  g.issues.get(12)!.labels = ["type:pbi"];
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, readsWithComments(g), clock);
  await sync.sync(ws);
  commentStoredIssue(db, S, 12, "<!-- pbi-complete:claim 1 -->");
  await sync.send(ws); // only the claim is there to send
  commentStoredIssue(db, S, 12, "<!-- pbi-complete:release overlap=40 -->", t + 5_000);
  t += 5_000;
  await sync.sync(ws); // reads the claim as GitHub received it (2026-10-08), which is after the release was written
  const item = readStoredBacklog(db, ws).items.find((i) => i.number === 12)!;
  expect(item.waits.map((w) => w.number)).toEqual([40]);
});

test("BacklogSync: a stage Task's own comment sent after it ended leaves the item unchanged; one written after the Task releases it", async () => {
  const g = fakeGithub();
  g.issues.get(12)!.labels = ["type:pbi"];
  const ws = db.upsertWorkspace({ name: "app", path: dir, kind: "repo" });
  db.setWorkspaceBacklogSource(ws.id, S);
  const sync = makeSync(db, readsWithComments(g), clock);
  t = Date.parse("2026-09-30T12:00:00Z"); // before the Issue's updatedAt the fake GitHub reports (2026-10-01)
  await sync.sync(ws);
  const start = t;
  // the Task writes its comment while it runs (written start + 10 s) and ends a minute after it started
  commentStoredIssue(db, S, 12, "<!-- pbi-complete:claim 1 -->", start + 70_000);
  db.insertTask({ id: "t_12", workspaceId: ws.id, title: "t", runner: "claude", cwd: dir, scope: [dir], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: { issue: 12, action: "complete" }, statusAt: start + 60_000, createdAt: start, updatedAt: start + 60_000 });
  // the comment reaches GitHub after the Task ended, and is read back
  t = start + 180_000;
  await sync.send(ws);
  await sync.sync(ws);
  const lastTask = () => {
    const r = db.lastStageTask(ws.id, 12)!;
    return { id: r.id, status: r.status, statusAt: r.statusAt, createdAt: r.createdAt, updatedAt: r.updatedAt, action: r.stage?.action ?? null, outcome: r.outcome, reviewedAt: r.reviewedAt, resumeAt: r.resumeAt, started: false };
  };
  // the fake reads put Issue 12 In progress; `isUnchanged` judges the stages Ready and before, so the item is read as the Ready one it was
  const read = () => ({ ...readStoredBacklog(db, ws).items.find((i) => i.number === 12)!, stage: "ready" as const, lastTask: lastTask() });
  expect(isUnchanged(read())).toBe(true);
  // a comment written after the Task ended (written start + 120 s) counts, sent or not
  commentStoredIssue(db, S, 12, "Task の後に書いたコメント", start + 180_000);
  expect(isUnchanged(read())).toBe(false);
});
