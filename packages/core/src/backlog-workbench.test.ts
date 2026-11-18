// test-reads: none
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { BacklogEditError, commentStoredIssue as commentWindowed, createStoredIssue, editStoredIssue } from "./backlog-edit.ts";
import { readStoredBacklog, readStoredIssue, workspaceSyncOf } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { fakeGithub } from "./backlog-fake-github.ts";
import { fetchReplica, importReplica, ReplicaError, replicaTakenAt, Workbench } from "./backlog-replica.ts";
import { sendGithubOperations } from "./backlog-send.ts";
import { BacklogSync } from "./backlog-sync.ts";
import { importBacklogOperations, importedId, listRefused, uploadBacklogOperations } from "./backlog-upbox.ts";
import { Db, SEND_DELAY_MS } from "./db.ts";
import { memoryS3 } from "./s3.ts";

// A work machine (the PC) and the instance (EC2) as two databases, the uplink bucket kept in memory, and a fake GitHub
// only the instance may ask: what the PC reads is the instance's copy, what it writes goes out through the instance.

const S: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
/** The instance's registry: the work machine of these tests and what it is registered for. */
const MACHINES = { pc1: ["acme/app"] };
let t = 1_000_000;
const clock = () => t;
const comment = (db: Db, n: number, text: string) => commentWindowed(db, S, n, text, t - SEND_DELAY_MS);

let dir: string;
let ec2: Db;
let pc: Db;
let wsEc2: string;
let wsPc: string;
let copies = 0;
const issue = (number: number, more: Partial<BacklogIssueData> = {}): BacklogIssueData => ({ number, title: `Issue ${number}`, url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null, ...more });

/** A copy of the instance's database as it is now, taken in by the PC. */
function copy() {
  const file = join(dir, `copy-${copies++}.db`);
  ec2.snapshotTo(file);
  return importReplica(pc, file, { workspaceId: wsPc, repository: "Acme/App" }, t);
}
const sendFromEc2 = (gh: GhRunner) => sendGithubOperations(gh, ec2, dir, S, clock);

beforeEach(() => {
  t = 1_000_000;
  dir = mkdtempSync(join(tmpdir(), "switchboard-workbench-"));
  ec2 = new Db(join(dir, "ec2.db"));
  pc = new Db(join(dir, "pc.db"));
  wsEc2 = ec2.upsertWorkspace({ path: "/srv/app", name: "app", kind: "repo" }).id;
  wsPc = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" }).id;
  ec2.setWorkspaceBacklogSource(wsEc2, S);
  ec2.putBacklogSnapshot(S, { records: [
    { objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "PBI", labels: ["type:pbi", "needs-decision"] }), fetchState: "fetched" },
    { objectKind: "issue", externalId: "I_3", remote: issue(3, { title: "親" }), fetchState: "fetched" },
    { objectKind: "project-item", externalId: "PVTI_I_12", remote: { issue: 12, owner: "acme", project: 1, fields: { Status: "Backlog" } }, fetchState: "fetched" },
  ], cursor: null, syncedAt: 777 });
});
afterEach(() => {
  ec2.close();
  pc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the copy a work machine reads", () => {
  test("holds what the instance stored, dated by the instance's import, and is replaced whole by the next one", () => {
    expect(copy()).toEqual({ records: 3, replicaSyncedAt: 777, settled: 0 });
    expect(pc.getWorkspaceBacklogSource(wsPc)).toEqual(S);
    expect(pc.getBacklogRepository(S)?.lastSuccessfulSync).toBe(777);
    expect(replicaTakenAt(pc, S)).toBe(t);
    // the sync row says it is a copy and when it was taken; the instance's own row does not
    expect(workspaceSyncOf(pc, { id: wsPc }).sync).toMatchObject({ lastSuccessfulSync: 777, replica: { takenAt: t } });
    expect(workspaceSyncOf(ec2, { id: wsEc2 }).sync.replica).toBeUndefined();
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PBI");
    const before = readStoredBacklog(pc, { id: wsPc, name: "app", path: "/pc/app" }).items.map((i) => i.number).sort();
    // twice: nothing more
    copy();
    expect(pc.listBacklogRecords(S).length).toBe(3);
    expect(readStoredBacklog(pc, { id: wsPc, name: "app", path: "/pc/app" }).items.map((i) => i.number).sort()).toEqual(before);
    // the instance moved on: a title changed, a record gone
    ec2.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "直った題" }), fetchState: "fetched" }], cursor: null, syncedAt: 888 });
    ec2.deleteBacklogRecord({ ...S, objectKind: "issue", externalId: "I_3" });
    copy();
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("直った題");
    expect(pc.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_3" })).toBeNull();
    expect(pc.getBacklogRepository(S)?.lastSuccessfulSync).toBe(888);
  });

  test("4,000 Issues come in with the same counts as the instance has, in under three seconds, and an edit waiting on the PC shows on top", () => {
    const records = Array.from({ length: 4000 }, (_, i) => ({ objectKind: "issue" as const, externalId: `I_big${i}`, remote: issue(1000 + i, { labels: [i % 4 === 0 ? "type:pbi" : "type:task"] }), fetchState: "fetched" as const }));
    ec2.putBacklogSnapshot(S, { records, cursor: null, syncedAt: 999 });
    copy();
    editStoredIssue(pc, S, 1000, { title: "PC で直した題" });
    const began = performance.now();
    expect(copy().records).toBe(4003);
    expect(performance.now() - began).toBeLessThan(3000);
    const count = (db: Db, label: string) => db.listBacklogRecords(S, "issue").filter((r) => (r.remote as BacklogIssueData).labels.includes(label)).length;
    expect(count(pc, "type:pbi")).toBe(count(ec2, "type:pbi"));
    expect(pc.listBacklogRecords(S, "issue").length).toBe(ec2.listBacklogRecords(S, "issue").length);
    expect(readStoredIssue(pc, { id: wsPc }, 1000)?.issue.title).toBe("PC で直した題");
    expect(pc.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["pending"]);
  });

  test("a copy of a newer database, of a repository the instance does not read, or one it never imported is refused with its reason and changes nothing", () => {
    copy();
    ec2.sqlite.exec("ALTER TABLE backlog_records ADD COLUMN later TEXT");
    expect(() => copy()).toThrow(ReplicaError);
    expect(() => copy()).toThrow("EC2 の DB のほうが新しい形です");
    expect(pc.listBacklogRecords(S).length).toBe(3);
    const file = join(dir, "other.db");
    const other = new Db(file);
    other.close();
    expect(() => importReplica(pc, file, { workspaceId: wsPc, repository: "acme/app" }, t)).toThrow("EC2 に acme/app を読む workspace がありません");
  });

  test("the copy is restored by litestream beside its place and renamed in; no replica or a failure leaves the copy before it", async () => {
    const out = join(dir, "replica", "switchboard.db");
    const seen: string[][] = [];
    await fetchReplica({ url: "s3://bucket/litestream/switchboard.db", out, run: async (cmd) => (seen.push(cmd), writeFileSync(cmd[3]!, "copy 1"), { code: 0, stdout: "", stderr: "" }) });
    expect(seen[0]!.slice(0, 2)).toEqual(["litestream", "restore"]);
    expect(seen[0]!.slice(-2)).toEqual(["-if-replica-exists", "s3://bucket/litestream/switchboard.db"]);
    expect(seen[0]![3]).not.toBe(out);
    expect(await Bun.file(out).text()).toBe("copy 1");
    await expect(fetchReplica({ url: "s3://b/x", out, run: async () => ({ code: 0, stdout: "", stderr: "" }) })).rejects.toThrow("複製がありません");
    await expect(fetchReplica({ url: "s3://b/x", out, run: async (cmd) => (writeFileSync(cmd[3]!, "half"), { code: 1, stdout: "", stderr: "AccessDenied" }) })).rejects.toThrow("写しを取れません: AccessDenied");
    expect(await Bun.file(out).text()).toBe("copy 1");
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false);
  });
});

describe("what stays on a work machine of the instance's database", () => {
  test("only the backlog part: no Task, no conversation, no setting, and of the waiting edits only that machine's own", async () => {
    ec2.insertTask({ id: "t-secret", workspaceId: wsEc2, title: "会話", runner: "claude", cwd: "/srv/app", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumePlannedAt: null, resumeSince: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
    ec2.appendEventAt("t-secret", { t: "status", text: "conversation-marker" }, 1);
    ec2.setSetting("policies", [{ id: "p" }]);
    comment(ec2, 12, "own-draft-marker");
    const s3 = memoryS3();
    copy();
    comment(pc, 3, "PC から");
    await uploadBacklogOperations(pc, s3, S, "pc1", t);
    await importBacklogOperations(ec2, s3, MACHINES);
    const out = join(dir, "replica", "switchboard.db");
    await fetchReplica({ url: "s3://bucket/litestream/switchboard.db", out, machine: "pc1", run: async (cmd) => (ec2.snapshotTo(cmd[3]!), { code: 0, stdout: "", stderr: "" }) });
    const kept = new Database(out, { readonly: true });
    try {
      expect((kept.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(["backlog_operations", "backlog_records", "backlog_repositories", "workspaces"]);
      expect((kept.query("SELECT name FROM pragma_table_info('workspaces')").all() as Array<{ name: string }>).map((r) => r.name)).toEqual(["backlog_source"]);
      const ops = kept.query("SELECT id FROM backlog_operations").all() as Array<{ id: string }>;
      expect(ops.length).toBe(1);
      expect(ops[0]!.id.startsWith("m:pc1:")).toBe(true);
    } finally {
      kept.close();
    }
    const bytes = new TextDecoder("latin1").decode(await Bun.file(out).arrayBuffer());
    for (const marker of ["conversation-marker", "own-draft-marker", "t-secret", "policies"]) expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
    expect(existsSync(`${out}.tmp-${process.pid}`)).toBe(false);
    // and it is all the copy needs
    expect(importReplica(pc, out, { workspaceId: wsPc, repository: "acme/app" }, t).records).toBe(3);
  });
});

describe("what a work machine writes", () => {
  test("a new Issue goes through the uplink bucket and the instance to GitHub once, and its number comes back with the next copy", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    copy();
    const { localId } = createStoredIssue(pc, S, { title: "PC で作った", body: "本文", labels: ["type:request"], milestone: null, parent: null, fields: null });
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(1);
    expect([...s3.objects.keys()]).toEqual(["backlog/pc1/000000000001.json"]);
    // put again: one key, and the operation still waits on the PC, readable by its local id
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(0);
    expect(s3.objects.size).toBe(1);
    expect(pc.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["pending"]);
    expect(readStoredIssue(pc, { id: wsPc }, localId)?.issue.title).toBe("PC で作った");
    expect(g.writes).toEqual([]);

    expect(await importBacklogOperations(ec2, s3, MACHINES)).toEqual([wsEc2]);
    expect(ec2.getBacklogOperation(importedId("pc1", localId))?.status).toBe("pending"); // kept under the machine's name
    // taken in twice: one operation, one Issue made — also when the mark of what was taken is lost
    expect(await importBacklogOperations(ec2, s3, MACHINES)).toEqual([]);
    ec2.setSetting("upbox.taken", {});
    expect(await importBacklogOperations(ec2, s3, MACHINES, { log: () => undefined })).toEqual([]);
    expect(listRefused(ec2)).toEqual([]);
    expect(ec2.listBacklogOperations(S).length).toBe(1);
    await sendFromEc2(g.gh);
    await sendFromEc2(g.gh);
    const made = [...g.issues.values()].filter((i) => i.title === "PC で作った");
    expect(made.length).toBe(1);
    expect(ec2.getBacklogOperation(importedId("pc1", localId))?.status).toBe("done");

    // before the next copy the PC still reads it by its local id; after it, by the number too, and nothing waits
    expect(readStoredIssue(pc, { id: wsPc }, localId)?.issue.number).toBe(0);
    expect(copy().settled).toBe(1);
    expect(readStoredIssue(pc, { id: wsPc }, made[0]!.number)?.issue.title).toBe("PC で作った");
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
    expect(pc.getBacklogRecord({ ...S, objectKind: "issue", externalId: `local:${localId}` })).toBeNull();
    expect(pc.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: made[0]!.node_id });
  });

  test("what was written while the instance was stopped — three Issues, a comment on one of them and one on a stored Issue, a field — is all sent at its next start, in order", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    copy();
    const ids = ["一", "二", "三"].map((title) => createStoredIssue(pc, S, { title, body: "", labels: [], milestone: null, parent: null, fields: null }).localId);
    comment(pc, 12, "PC からのコメント");
    editStoredIssue(pc, S, 12, { title: "PC で直した題" });
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(5);
    expect(g.writes).toEqual([]);
    // the instance starts
    expect(await importBacklogOperations(ec2, s3, MACHINES)).toEqual([wsEc2]);
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.kind)).toEqual(["create", "create", "create", "comment", "set"]);
    for (let i = 0; i < 4; i++) await sendFromEc2(g.gh);
    expect([...g.issues.values()].map((i) => i.title).filter((x) => ["一", "二", "三"].includes(x))).toEqual(["一", "二", "三"]);
    expect(g.issues.get(12)!.title).toBe("PC で直した題");
    expect(g.issues.get(12)!.comments.map((c) => c.body.split("\n")[0])).toEqual(["PC からのコメント"]);
    expect(ec2.listPendingBacklogOperations(S)).toEqual([]);
    // a copy taken before the instance read its own write back still has the old title: the PC's edit stays on top
    expect(copy().settled).toBe(4);
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PC で直した題");
    expect(pc.listPendingBacklogOperations(S).map((o) => o.kind)).toEqual(["set"]);
    ec2.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "PC で直した題", labels: ["type:pbi", "needs-decision"] }), fetchState: "fetched" }], cursor: null, syncedAt: t });
    expect(copy().settled).toBe(1);
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
    expect(ids.every((id) => pc.getBacklogOperation(id)?.status === "done")).toBe(true);
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PC で直した題");
  });

  test("a field changed on GitHub since the PC's copy is held as a conflict on the instance, and on the PC after its next copy", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    copy();
    editStoredIssue(pc, S, 12, { title: "PC の題" });
    await uploadBacklogOperations(pc, s3, S, "pc1", t);
    g.issues.get(12)!.title = "GitHub で変わった題";
    await importBacklogOperations(ec2, s3, MACHINES);
    await sendFromEc2(g.gh);
    expect(g.issues.get(12)!.title).toBe("GitHub で変わった題");
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
    copy();
    // held on the PC too, so its screen offers the choice the instance's does
    expect(pc.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
  });

  test("an edit changed after it was put is put again as a later version, and the instance sends the later value", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    copy();
    editStoredIssue(pc, S, 12, { title: "一回目" });
    await uploadBacklogOperations(pc, s3, S, "pc1", t);
    t += 1000;
    editStoredIssue(pc, S, 12, { title: "二回目" }, t);
    expect(pc.listPendingBacklogOperations(S).length).toBe(1); // the same operation on the PC
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(1);
    expect(s3.objects.size).toBe(2);
    await importBacklogOperations(ec2, s3, MACHINES);
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.payload)).toEqual(["二回目"]);
    await sendFromEc2(g.gh);
    expect(g.issues.get(12)!.title).toBe("二回目");
    ec2.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "二回目", labels: ["type:pbi", "needs-decision"] }), fetchState: "fetched" }], cursor: null, syncedAt: t });
    expect(copy().settled).toBe(1);
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
  });

  test("a text with a value that signs in is refused before it waits anywhere: not in the PC's queue, not in the bucket", async () => {
    const s3 = memoryS3();
    copy();
    const secret = `ghp_${"a".repeat(36)}`;
    let refused: unknown;
    try {
      createStoredIssue(pc, S, { title: "題", body: `token: ${secret}`, labels: [], milestone: null, parent: null, fields: null });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(BacklogEditError);
    expect((refused as BacklogEditError).status).toBe(422);
    expect((refused as BacklogEditError).message).toContain("認証に使える値");
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
    expect(await uploadBacklogOperations(pc, s3, S, "pc1", t)).toBe(0);
    expect(s3.objects.size).toBe(0);
  });

  test("an edit of a repository no workspace of the instance reads is refused with its reason and does not hold the ones after it", async () => {
    const s3 = memoryS3();
    copy();
    const other: BacklogSource = { ...S, repository: "acme/other" };
    pc.putBacklogSnapshot(other, { records: [{ objectKind: "issue", externalId: "I_o", remote: issue(5), fetchState: "fetched" }], cursor: null, syncedAt: 1 });
    editStoredIssue(pc, other, 5, { title: "よその題" });
    await uploadBacklogOperations(pc, s3, other, "pc1", t);
    editStoredIssue(pc, S, 12, { title: "PC の題" });
    await uploadBacklogOperations(pc, s3, S, "pc1", t);
    const lines: string[] = [];
    expect(await importBacklogOperations(ec2, s3, MACHINES, { log: (l) => lines.push(l) })).toEqual([wsEc2]);
    expect(listRefused(ec2).map((r) => r.reason)).toEqual(["pc1 is not registered for acme/other"]);
    expect(lines.length).toBe(1);
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.payload)).toEqual(["PC の題"]);
  });
});

describe("a work machine's BacklogSync", () => {
  test("never asks the backlog's service: import, settle, a Webhook's notice and a send all go by the copy and the bucket, and a copy that cannot be taken says why", async () => {
    let asked = 0;
    const gh: GhRunner = async () => (asked++, { code: 1, stdout: "", stderr: "must not be called" });
    const s3 = memoryS3();
    const sync = new BacklogSync(pc, gh, clock);
    let restores = 0;
    let fail = false;
    sync.workbench = new Workbench(pc, {
      file: join(dir, "replica", "switchboard.db"),
      url: "s3://bucket/litestream/switchboard.db",
      intervalMs: 3_600_000,
      machine: "pc1",
      store: s3,
      repositoryOf: () => "acme/app",
      clock,
      run: async (cmd) => {
        if (fail) return { code: 1, stdout: "", stderr: "no route to host" };
        restores++;
        ec2.snapshotTo(cmd[3]!);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const ws = { id: wsPc, name: "app", path: "/pc/app", projectVar: undefined };
    try {
      await sync.sync(ws);
      expect(sync.read(ws).items.map((i) => i.number)).toContain(12);
      expect(sync.read(ws).fetchedAt).toBe(777);
      // within the interval the copy here answers; 再読込 takes a new one
      await sync.settle(ws);
      sync.request(ws);
      sync.hint(ws);
      expect(restores).toBe(1);
      await sync.sync(ws, undefined, { full: true });
      expect(restores).toBe(2);
      // an edit is put in the bucket and stays pending; GitHub is not asked
      const made = comment(pc, 12, "PC から");
      await sync.send(ws);
      expect(s3.objects.size).toBe(1);
      expect(pc.getBacklogOperation(made.operation)?.status).toBe("pending");
      // the copy cannot be taken: the one before stays, with the reason where the backlog shows errors
      fail = true;
      await expect(sync.sync(ws, undefined, { full: true })).rejects.toThrow("写しを取れません: no route to host");
      expect(sync.state(ws).error).toBe("写しを取れません: no route to host");
      expect(sync.read(ws).items.map((i) => i.number)).toContain(12);
      expect(asked).toBe(0);
    } finally {
      sync.stop();
    }
  });
});
