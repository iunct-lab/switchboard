// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { BacklogEditError, commentStoredIssue as commentWindowed, createStoredIssue, editStoredIssue } from "./backlog-edit.ts";
import { readStoredBacklog, readStoredIssue, workspaceSyncOf } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { fakeGithub } from "./backlog-fake-github.ts";
import { ExportError, readBacklogExport, writeBacklogExports } from "./backlog-export.ts";
import { importBacklogExport, replicaTakenAt, Workbench } from "./backlog-replica.ts";
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
let exportsS3: ReturnType<typeof memoryS3>;
const issue = (number: number, more: Partial<BacklogIssueData> = {}): BacklogIssueData => ({ number, title: `Issue ${number}`, url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null, ...more });

/** The instance writes the exports as it does after an intake, and the PC reads its own and takes it in (`write` false: the export in the bucket is left as it is). */
async function copy(write = true) {
  if (write) await writeBacklogExports(ec2, { uplink: { machines: MACHINES } }, exportsS3);
  return importBacklogExport(pc, await readBacklogExport(exportsS3, "pc1", "Acme/App"), { workspaceId: wsPc }, t);
}
const sendFromEc2 = (gh: GhRunner) => sendGithubOperations(gh, ec2, dir, S, clock);

beforeEach(() => {
  t = 1_000_000;
  exportsS3 = memoryS3();
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
  test("holds what the instance stored, dated by the instance's import, and is replaced whole by the next one", async () => {
    expect(await copy()).toEqual({ records: 3, replicaSyncedAt: 777, settled: 0 });
    expect(pc.getWorkspaceBacklogSource(wsPc)).toEqual(S);
    expect(pc.getBacklogRepository(S)?.lastSuccessfulSync).toBe(777);
    expect(replicaTakenAt(pc, S)).toBe(t);
    // the sync row says it is a copy and when it was taken; the instance's own row does not
    expect(workspaceSyncOf(pc, { id: wsPc }).sync).toMatchObject({ lastSuccessfulSync: 777, replica: { takenAt: t } });
    expect(workspaceSyncOf(ec2, { id: wsEc2 }).sync.replica).toBeUndefined();
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PBI");
    const before = readStoredBacklog(pc, { id: wsPc, name: "app", path: "/pc/app" }).items.map((i) => i.number).sort();
    // twice: nothing more
    await copy();
    expect(pc.listBacklogRecords(S).length).toBe(3);
    expect(readStoredBacklog(pc, { id: wsPc, name: "app", path: "/pc/app" }).items.map((i) => i.number).sort()).toEqual(before);
    // the instance moved on: a title changed, a record gone
    ec2.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "直った題" }), fetchState: "fetched" }], cursor: null, syncedAt: 888 });
    ec2.deleteBacklogRecord({ ...S, objectKind: "issue", externalId: "I_3" });
    await copy();
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("直った題");
    expect(pc.getBacklogRecord({ ...S, objectKind: "issue", externalId: "I_3" })).toBeNull();
    expect(pc.getBacklogRepository(S)?.lastSuccessfulSync).toBe(888);
  });

  test("4,000 Issues come in with the same counts as the instance has, in under three seconds, and an edit waiting on the PC shows on top", async () => {
    const records = Array.from({ length: 4000 }, (_, i) => ({ objectKind: "issue" as const, externalId: `I_big${i}`, remote: issue(1000 + i, { labels: [i % 4 === 0 ? "type:pbi" : "type:task"] }), fetchState: "fetched" as const }));
    ec2.putBacklogSnapshot(S, { records, cursor: null, syncedAt: 999 });
    await copy();
    editStoredIssue(pc, S, 1000, { title: "PC で直した題" });
    const began = performance.now();
    expect((await copy()).records).toBe(4003);
    expect(performance.now() - began).toBeLessThan(3000);
    const count = (db: Db, label: string) => db.listBacklogRecords(S, "issue").filter((r) => (r.remote as BacklogIssueData).labels.includes(label)).length;
    expect(count(pc, "type:pbi")).toBe(count(ec2, "type:pbi"));
    expect(pc.listBacklogRecords(S, "issue").length).toBe(ec2.listBacklogRecords(S, "issue").length);
    expect(readStoredIssue(pc, { id: wsPc }, 1000)?.issue.title).toBe("PC で直した題");
    expect(pc.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["pending"]);
  });

  test("an export of a newer shape, or none for the repository, is refused with its reason and changes nothing", async () => {
    await copy();
    const key = "backlog-export/pc1/acme/app.json.zst";
    const had = exportsS3.objects.get(key)!.body;
    const body = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(had)));
    await exportsS3.put(key, Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ ...body, v: body.v + 1 }))));
    await expect(copy(false)).rejects.toThrow(ExportError);
    await expect(copy(false)).rejects.toThrow("EC2 の写しのほうが新しい形です");
    expect(pc.listBacklogRecords(S).length).toBe(3);
    // no export for it (the instance does not read the repository, or this machine is not registered for it)
    await expect(readBacklogExport(exportsS3, "pc1", "acme/other")).rejects.toThrow("EC2 に acme/other の写しがありません");
  });
});

describe("what a work machine writes", () => {
  test("a new Issue goes through the uplink bucket and the instance to GitHub once, and its number comes back with the next copy", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    await copy();
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
    expect((await copy()).settled).toBe(1);
    expect(readStoredIssue(pc, { id: wsPc }, made[0]!.number)?.issue.title).toBe("PC で作った");
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
    expect(pc.getBacklogRecord({ ...S, objectKind: "issue", externalId: `local:${localId}` })).toBeNull();
    expect(pc.getBacklogOperation(localId)).toMatchObject({ status: "done", remoteId: made[0]!.node_id });
  });

  test("what was written while the instance was stopped — three Issues, a comment on one of them and one on a stored Issue, a field — is all sent at its next start, in order", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    await copy();
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
    expect((await copy()).settled).toBe(4);
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PC で直した題");
    expect(pc.listPendingBacklogOperations(S).map((o) => o.kind)).toEqual(["set"]);
    ec2.putBacklogSnapshot(S, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "PC で直した題", labels: ["type:pbi", "needs-decision"] }), fetchState: "fetched" }], cursor: null, syncedAt: t });
    expect((await copy()).settled).toBe(1);
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
    expect(ids.every((id) => pc.getBacklogOperation(id)?.status === "done")).toBe(true);
    expect(readStoredIssue(pc, { id: wsPc }, 12)?.issue.title).toBe("PC で直した題");
  });

  test("a field changed on GitHub since the PC's copy is held as a conflict on the instance, and on the PC after its next copy", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    await copy();
    editStoredIssue(pc, S, 12, { title: "PC の題" });
    await uploadBacklogOperations(pc, s3, S, "pc1", t);
    g.issues.get(12)!.title = "GitHub で変わった題";
    await importBacklogOperations(ec2, s3, MACHINES);
    await sendFromEc2(g.gh);
    expect(g.issues.get(12)!.title).toBe("GitHub で変わった題");
    expect(ec2.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
    await copy();
    // held on the PC too, so its screen offers the choice the instance's does
    expect(pc.listPendingBacklogOperations(S).map((o) => o.status)).toEqual(["conflict"]);
  });

  test("an edit changed after it was put is put again as a later version, and the instance sends the later value", async () => {
    const g = fakeGithub(clock);
    const s3 = memoryS3();
    await copy();
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
    expect((await copy()).settled).toBe(1);
    expect(pc.listPendingBacklogOperations(S)).toEqual([]);
  });

  test("a text with a value that signs in is refused before it waits anywhere: not in the PC's queue, not in the bucket", async () => {
    const s3 = memoryS3();
    await copy();
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
    await copy();
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
    const s3 = exportsS3;
    const sync = new BacklogSync(pc, gh, clock);
    // how many times the export itself was read
    let exportReads = 0;
    const reads = () => exportReads;
    const store = { ...s3, get: async (key: string, opts?: { maxBytes?: number }) => (key.startsWith("backlog-export/") && exportReads++, s3.get(key, opts)) };
    sync.workbench = new Workbench(pc, { intervalMs: 3_600_000, machine: "pc1", store, repositoryOf: () => "acme/app", clock });
    await writeBacklogExports(ec2, { uplink: { machines: MACHINES } }, s3);
    const ws = { id: wsPc, name: "app", path: "/pc/app", projectVar: undefined };
    try {
      await sync.sync(ws);
      expect(sync.read(ws).items.map((i) => i.number)).toContain(12);
      expect(sync.read(ws).fetchedAt).toBe(777);
      // within the interval the copy here answers; 再読込 reads the export again
      const first = reads();
      await sync.settle(ws);
      sync.request(ws);
      sync.hint(ws);
      expect(reads()).toBe(first);
      await sync.sync(ws, undefined, { full: true });
      expect(reads()).toBe(first + 1);
      // an edit is put in the bucket and stays pending; GitHub is not asked
      const made = comment(pc, 12, "PC から");
      await sync.send(ws);
      expect([...s3.objects.keys()].filter((k) => k.startsWith("backlog/pc1/"))).toHaveLength(1);
      expect(pc.getBacklogOperation(made.operation)?.status).toBe("pending");
      // the copy cannot be taken: the one before stays, with the reason where the backlog shows errors
      s3.objects.delete("backlog-export/pc1/acme/app.json.zst");
      await expect(sync.sync(ws, undefined, { full: true })).rejects.toThrow("EC2 に acme/app の写しがありません");
      expect(sync.state(ws).error).toContain("EC2 に acme/app の写しがありません");
      expect(sync.read(ws).items.map((i) => i.number)).toContain(12);
      expect(asked).toBe(0);
    } finally {
      sync.stop();
    }
  });
});
