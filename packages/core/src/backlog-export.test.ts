// test-reads: none
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { commentStoredIssue } from "./backlog-edit.ts";
import { buildBacklogExport, exportKey, ExportError, readBacklogExport, writeBacklogExports } from "./backlog-export.ts";
import { dropBacklogCopy, importBacklogExport } from "./backlog-replica.ts";
import { readStoredBacklog, readStoredIssue } from "./backlog-stored.ts";
import { importBacklogOperations, uploadBacklogOperations } from "./backlog-upbox.ts";
import { Db, SEND_DELAY_MS } from "./db.ts";
import { memoryS3 } from "./s3.ts";
import { uplinkRound } from "./server/lease.ts";

// The instance writes what each registered work machine may read of its backlog into the uplink bucket, and a work
// machine reads only its own prefix. The bucket is the in-memory one every uplink test uses.

const APP: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const TOOLS: BacklogSource = { service: "github", host: "github.com", repository: "acme/tools", project: { owner: "acme", number: 2 } };
const MACHINES = { pc1: ["acme/app"], pc2: ["acme/app", "acme/tools"] };
const t = 1_000_000;
const issue = (number: number, more: Partial<BacklogIssueData> = {}): BacklogIssueData => ({ number, title: `Issue ${number}`, url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null, ...more });
const cfg = { uplink: { machines: MACHINES } };
const text = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(body)));

let dir: string;
let ec2: Db;
let s3: ReturnType<typeof memoryS3>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-export-"));
  ec2 = new Db(join(dir, "ec2.db"));
  s3 = memoryS3();
  for (const source of [APP, TOOLS]) ec2.setWorkspaceBacklogSource(ec2.upsertWorkspace({ path: `/srv/${source.repository}`, name: source.repository, kind: "repo" }).id, source);
  ec2.putBacklogSnapshot(APP, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "PBI" }), fetchState: "fetched" }, { objectKind: "issue", externalId: "I_3", remote: issue(3, { title: "親" }), fetchState: "fetched" }], cursor: null, syncedAt: 777 });
  ec2.putBacklogSnapshot(TOOLS, { records: [{ objectKind: "issue", externalId: "I_tools", remote: issue(1, { title: "tools-marker" }), fetchState: "fetched" }], cursor: null, syncedAt: 888 });
});
afterEach(() => {
  ec2.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the instance writes one object per registered machine and repository", () => {
  test("only the repositories a machine is registered for, under that machine's own prefix", async () => {
    const written = await writeBacklogExports(ec2, cfg, s3);
    expect(written.sort()).toEqual(["backlog-export/pc1/acme/app.json.zst", "backlog-export/pc2/acme/app.json.zst", "backlog-export/pc2/acme/tools.json.zst"]);
    expect([...s3.objects.keys()].sort()).toEqual(written.sort());
    // pc1 is not registered for acme/tools: nothing of it is written for pc1, and nothing of it is in what pc1 reads
    expect(s3.objects.has(exportKey("pc1", "acme/tools"))).toBe(false);
    for (const [key, o] of s3.objects) if (key.startsWith("backlog-export/pc1/")) expect(new TextDecoder("latin1").decode(Bun.zstdDecompressSync(o.body))).not.toContain("tools-marker");
    // the key names the repository without case, as the registry has it
    expect(exportKey("pc1", "Acme/App")).toBe("backlog-export/pc1/acme/app.json.zst");
  });

  test("a repository no workspace reads, or one not imported yet, gets no object; with no registry the prefix is only listed (to withdraw what an earlier registry wrote)", async () => {
    const some = await writeBacklogExports(ec2, { uplink: { machines: { pc1: ["acme/app", "acme/none"], pc3: ["acme/new"] } } }, s3);
    expect(some).toEqual(["backlog-export/pc1/acme/app.json.zst"]);
    ec2.setWorkspaceBacklogSource(ec2.upsertWorkspace({ path: "/srv/acme/new", name: "new", kind: "repo" }).id, { ...APP, repository: "acme/new" });
    expect(await writeBacklogExports(ec2, { uplink: { machines: { pc3: ["acme/new"] } } }, s3)).toEqual([]);
    const quiet = memoryS3();
    expect(await writeBacklogExports(ec2, { uplink: { machines: {} } }, quiet)).toEqual([]);
    expect([quiet.calls, quiet.objects.size]).toEqual([1, 0]);
  });

  test("it holds the records as the service has them, the time of the last import and only that machine's operations — nothing else of the instance's database", async () => {
    ec2.insertTask({ id: "t-secret", workspaceId: ec2.listWorkspaces()[0]!.id, title: "会話", runner: "claude", cwd: "/srv/app", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumePlannedAt: null, resumeSince: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 });
    ec2.appendEventAt("t-secret", { t: "status", text: "conversation-marker" }, 1);
    ec2.setSetting("policies", [{ id: "p" }]);
    // the instance's own unsent draft, and an edit from each of two machines
    commentStoredIssue(ec2, APP, 12, "own-draft-marker", t - SEND_DELAY_MS);
    for (const machine of ["pc1", "pc2"]) {
      const pc = new Db(join(dir, `${machine}.db`));
      try {
        importBacklogExport(pc, buildBacklogExport(ec2, machine, "acme/app")!, { workspaceId: pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" }).id }, t);
        commentStoredIssue(pc, APP, 3, `from-${machine}`, t - SEND_DELAY_MS);
        await uploadBacklogOperations(pc, s3, APP, machine, t);
      } finally {
        pc.close();
      }
    }
    await importBacklogOperations(ec2, s3, MACHINES, { now: t, log: () => undefined });
    await writeBacklogExports(ec2, cfg, s3);
    const mine = text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body);
    expect(mine).toMatchObject({ kind: "backlog-export", machine: "pc1", importedAt: 777, source: APP });
    expect(mine.records.map((r: { externalId: string }) => r.externalId)).toEqual(["I_12", "I_3"]);
    expect(mine.records[0].remote.title).toBe("PBI");
    expect(mine.operations.map((o: { id: string }) => o.id.slice(0, 6))).toEqual(["m:pc1:"]);
    const bytes = new TextDecoder("latin1").decode(Bun.zstdDecompressSync(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body));
    for (const marker of ["conversation-marker", "own-draft-marker", "t-secret", "policies", "from-pc2", "m:pc2:"]) expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
    expect(text(s3.objects.get("backlog-export/pc2/acme/app.json.zst")!.body).operations.map((o: { id: string }) => o.id.slice(0, 6))).toEqual(["m:pc2:"]);
    // pc2's edit of acme/app is not in its acme/tools export
    expect(text(s3.objects.get("backlog-export/pc2/acme/tools.json.zst")!.body).operations).toEqual([]);
  });

  test("a registered pair whose put fails this round keeps its last export: no tombstone is written over it", async () => {
    await writeBacklogExports(ec2, cfg, s3, t);
    const key = "backlog-export/pc1/acme/app.json.zst";
    // the export's put fails once; a put right after it to the same key would succeed
    let failed = false;
    const failing = { ...s3, put: async (k: string, body: Uint8Array, opts?: unknown) => { if (k === key && !failed) { failed = true; throw new Error("SlowDown"); } return (s3.put as (k: string, b: Uint8Array, o?: unknown) => Promise<unknown>)(k, body, opts); } } as typeof s3;
    await expect(writeBacklogExports(ec2, cfg, failing, t + 1000)).rejects.toThrow("SlowDown");
    expect(text(s3.objects.get(key)!.body).removed).toBeUndefined();
    expect((await readBacklogExport(s3, "pc1", "acme/app")).records).toHaveLength(2);
  });
});

describe("a work machine reads its own prefix and takes the export in", () => {
  test("what the instance wrote shows in the work machine's backlog list and Issue", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const pc = new Db(join(dir, "pc.db"));
    try {
      const ws = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" });
      expect(importBacklogExport(pc, await readBacklogExport(s3, "pc1", "Acme/App"), { workspaceId: ws.id }, t)).toEqual({ records: 2, replicaSyncedAt: 777, settled: 0 });
      expect(readStoredBacklog(pc, { id: ws.id, name: "app", path: "/pc/app" }).items.map((i) => i.number).sort()).toEqual([12, 3].sort());
      expect(readStoredIssue(pc, { id: ws.id }, 12)?.issue.title).toBe("PBI");
      expect(pc.getBacklogRepository(APP)?.lastSuccessfulSync).toBe(777);
    } finally {
      pc.close();
    }
  });

  test("another machine's export is not read, and an object that is not for this machine is refused", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    // pc1 has no object for acme/tools even though pc2 has: the read is by its own prefix, never by the repository alone
    await expect(readBacklogExport(s3, "pc1", "acme/tools")).rejects.toThrow(ExportError);
    await expect(readBacklogExport(s3, "pc1", "acme/tools")).rejects.toThrow("EC2 に acme/tools の写しがありません");
    expect((await readBacklogExport(s3, "pc2", "acme/tools")).machine).toBe("pc2");
    // an object of pc2's put under pc1's key is not taken as pc1's
    await s3.put(exportKey("pc1", "acme/app"), s3.objects.get(exportKey("pc2", "acme/app"))!.body);
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("pc2 宛て");
    // what is not an export at all
    await s3.put(exportKey("pc1", "acme/app"), new TextEncoder().encode("not zstd"));
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("写しを読めません");
    await s3.put(exportKey("pc1", "acme/app"), Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify({ kind: "backlog-export", v: 1, machine: "pc1" }))));
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("形が違います");
  });

  test("an export is refused unless it is this machine's export of the asked repository with records of the stored shapes, and a tombstone too is checked", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const put = (value: unknown) => s3.put(exportKey("pc1", "acme/app"), Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(value))));
    // pc1's export of acme/tools under its acme/app key would rebind the workspace to acme/tools
    await put({ ...buildBacklogExport(ec2, "pc2", "acme/tools")!, machine: "pc1" });
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("pc1 の acme/tools 宛て");
    // a record whose body is not of the stored shape
    const app = buildBacklogExport(ec2, "pc1", "acme/app")!;
    await put({ ...app, records: [{ ...app.records[0], remote: {} }] });
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("形が違います（records.0.remote");
    // a tombstone addressed to another machine, or of a newer shape, does not drop pc1's copy
    await put({ kind: "backlog-export", v: 1, machine: "pc2", repository: "acme/app", removed: true, at: t });
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toMatchObject({ kind: "fetch", removed: false });
    // one of another repository under this key withdraws nothing here
    await put({ kind: "backlog-export", v: 1, machine: "pc1", repository: "acme/tools", removed: true, at: t });
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toThrow("pc1 の acme/tools 宛て");
    await put({ kind: "backlog-export", v: 2, machine: "pc1", repository: "acme/app", removed: true, at: t });
    await expect(readBacklogExport(s3, "pc1", "acme/app")).rejects.toMatchObject({ kind: "newer", removed: false });
  });

  test("a bucket that does not answer is told as a failed read, and an object over the limit is not held", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const down = { ...s3, get: async () => { throw new Error("aws get-object failed (255): AccessDenied"); } };
    await expect(readBacklogExport(down, "pc1", "acme/app")).rejects.toMatchObject({ kind: "fetch" });
    await expect(readBacklogExport({ ...s3, get: async () => ({ body: new Uint8Array(1), etag: "x", more: true as const }) }, "pc1", "acme/app")).rejects.toThrow("上限");
    const listDown = { ...s3, list: async () => { throw new Error("aws list-objects-v2 failed (255): AccessDenied"); } };
    await expect(readBacklogExport(listDown, "pc1", "acme/app")).rejects.toMatchObject({ kind: "fetch" });
  });

  test("a key that is not listed is missing without a GET (S3 answers a GET of a missing key as refused to a role that lists by prefix), and one listed over the limit is not fetched", async () => {
    // a GET of any key is refused, as S3 answers a role whose list permission has a prefix condition
    const refused = { ...s3, get: async () => { throw new Error("aws get-object failed (255): AccessDenied"); } };
    await expect(readBacklogExport(refused, "pc1", "acme/app")).rejects.toMatchObject({ kind: "missing", removed: false });
    await writeBacklogExports(ec2, cfg, s3);
    let gets = 0;
    const counted = { ...s3, get: (k: string, o?: { maxBytes?: number }) => (gets++, s3.get(k, o)) };
    await expect(readBacklogExport(counted, "pc1", "acme/app", 1)).rejects.toThrow("上限 1 バイト");
    expect(gets).toBe(0);
  });
});

describe("an export that must no longer be read", () => {
  test("a repository leaving the registry gets a tombstone, read as not registered and dropped on the work machine; it is not written again each round", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const pc = new Db(join(dir, "pc.db"));
    try {
      const ws = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" });
      importBacklogExport(pc, await readBacklogExport(s3, "pc2", "acme/tools"), { workspaceId: ws.id }, t);
      expect(pc.listBacklogRecords(TOOLS).length).toBe(1);
      // pc2 is no longer registered for acme/tools, and pc1 is gone altogether
      const shrunk = { uplink: { machines: { pc2: ["acme/app"] } } };
      expect(await writeBacklogExports(ec2, shrunk, s3, t)).toEqual(["backlog-export/pc2/acme/app.json.zst"]);
      const key = "backlog-export/pc2/acme/tools.json.zst";
      expect(text(s3.objects.get(key)!.body)).toMatchObject({ removed: true, machine: "pc2", repository: "acme/tools", at: t });
      expect(text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body)).toMatchObject({ removed: true, machine: "pc1" });
      // the same message as a key that was never there
      await expect(readBacklogExport(s3, "pc2", "acme/tools")).rejects.toThrow("EC2 に acme/tools の写しがありません");
      await expect(readBacklogExport(s3, "pc2", "acme/tools")).rejects.toMatchObject({ kind: "missing", removed: true });
      expect(s3.objects.has(exportKey("pc2", "acme/app"))).toBe(true);
      // not written again: the object keeps its etag; a live export is written over every round
      const etag = s3.objects.get(key)!.etag;
      const live = s3.objects.get("backlog-export/pc2/acme/app.json.zst")!.etag;
      await writeBacklogExports(ec2, shrunk, s3, t + 1000);
      expect(s3.objects.get(key)!.etag).toBe(etag);
      expect(s3.objects.get("backlog-export/pc2/acme/app.json.zst")!.etag).not.toBe(live);
      // registered again: a real export is written over the tombstone
      await writeBacklogExports(ec2, cfg, s3, t + 2000);
      expect((await readBacklogExport(s3, "pc2", "acme/tools")).records).toHaveLength(1);
      // the copy is dropped (the records the service had), the workspace's source stays
      dropBacklogCopy(pc, ws.id, "acme/tools");
      expect(pc.listBacklogRecords(TOOLS)).toEqual([]);
    } finally {
      pc.close();
    }
  });

  test("a tombstone remembered by a database restored from before a later export does not keep that export readable", async () => {
    const key = "backlog-export/pc2/acme/tools.json.zst";
    const shrunk = { uplink: { machines: { pc2: ["acme/app"] } } };
    await writeBacklogExports(ec2, cfg, s3, t);
    await writeBacklogExports(ec2, shrunk, s3, t + 1000);
    const snapshot = ec2.getSetting<Record<string, string>>("backlogExport.withdrawn", {});
    expect(Object.keys(snapshot)).toContain(key);
    // registered again for a while: a real export is written over the tombstone
    await writeBacklogExports(ec2, cfg, s3, t + 2000);
    expect((await readBacklogExport(s3, "pc2", "acme/tools")).records).toHaveLength(1);
    // the instance's database is restored from the snapshot taken after the tombstone, and the pair is removed again
    ec2.setSetting("backlogExport.withdrawn", snapshot);
    await writeBacklogExports(ec2, shrunk, s3, t + 3000);
    await expect(readBacklogExport(s3, "pc2", "acme/tools")).rejects.toMatchObject({ kind: "missing", removed: true });
  });

  test("a withdrawal is written before the live exports, so a live put that does not answer does not hold it back", async () => {
    await writeBacklogExports(ec2, cfg, s3, t);
    const stalled = { ...s3, put: (k: string, body: Uint8Array, c?: unknown) => (k === "backlog-export/pc2/acme/app.json.zst" ? new Promise<never>(() => undefined) : (s3.put as (k: string, b: Uint8Array, c?: unknown) => Promise<{ etag: string } | "conflict">)(k, body, c)) } as typeof s3;
    void writeBacklogExports(ec2, { uplink: { machines: { pc2: ["acme/app"] } } }, stalled, t + 1000);
    await Bun.sleep(20);
    expect(text(s3.objects.get("backlog-export/pc2/acme/tools.json.zst")!.body).removed).toBe(true);
  });

  test("a repository path that two services or hosts have is not exported: the registry does not say which one is meant", async () => {
    const gitlab = { ...APP, service: "gitlab", host: "gitlab.example" } as BacklogSource;
    ec2.setWorkspaceBacklogSource(ec2.upsertWorkspace({ path: "/srv/gitlab/acme/app", name: "app-gl", kind: "repo" }).id, gitlab);
    ec2.putBacklogSnapshot(gitlab, { records: [{ objectKind: "issue", externalId: "G_1", remote: issue(1, { title: "gitlab-marker" }), fetchState: "fetched" }], cursor: null, syncedAt: 999 });
    expect(buildBacklogExport(ec2, "pc1", "acme/app")).toBeNull();
    expect(await writeBacklogExports(ec2, cfg, s3)).toEqual(["backlog-export/pc2/acme/tools.json.zst"]);
    // the GitHub workspace disabled: the GitLab one with the same path is still not taken for it
    for (const w of ec2.listWorkspaces()) if (ec2.getWorkspaceBacklogSource(w.id)?.service === "github" && ec2.getWorkspaceBacklogSource(w.id)?.repository === "acme/app") ec2.setWorkspaceBacklogSource(w.id, { ...APP, disabled: true });
    expect(buildBacklogExport(ec2, "pc1", "acme/app")).toBeNull();
  });

  test("an export's operations are only those of the export's service and host", async () => {
    // operations of pc1 on acme/app, one at the export's host and one at another, put straight in the instance's table
    const op = ec2.sqlite.query("INSERT INTO backlog_operations (id, service, host, repository, issue, target_kind, target, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, 'acme/app', '12', 'comment', 'local:x', 'create', '{}', 'done', 1, 1)");
    op.run("m:pc1:same-host", "github", "github.com");
    op.run("m:pc1:other-host", "gitlab", "gitlab.example");
    expect(buildBacklogExport(ec2, "pc1", "acme/app")!.operations.map((o) => o.id)).toEqual(["m:pc1:same-host"]);
  });

  test("a tombstone drops the copy only of the repository it withdraws: a workspace that reads another repository keeps it", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const pc = new Db(join(dir, "pc.db"));
    try {
      const ws = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" });
      importBacklogExport(pc, await readBacklogExport(s3, "pc1", "acme/app"), { workspaceId: ws.id }, t);
      dropBacklogCopy(pc, ws.id, "acme/tools");
      expect(pc.listBacklogRecords(APP).length).toBe(2);
      dropBacklogCopy(pc, ws.id, "Acme/App");
      expect(pc.listBacklogRecords(APP)).toEqual([]);
      // nor does it keep the time of the instance's import, which the readers would show for a copy that is gone
      expect(pc.getBacklogRepository(APP)).toBeNull();
    } finally {
      pc.close();
    }
  });

  test("a workspace that is gone or disabled withdraws its exports; a work machine's Workbench drops its copy on a tombstone", async () => {
    await writeBacklogExports(ec2, cfg, s3);
    const { Workbench } = await import("./backlog-replica.ts");
    const pc = new Db(join(dir, "pc.db"));
    try {
      const ws = pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" });
      const bench = new Workbench(pc, { intervalMs: 0, machine: "pc1", store: s3, repositoryOf: () => "acme/app" });
      await bench.pull(ws);
      expect(pc.listBacklogRecords(APP).length).toBe(2);
      for (const w of ec2.listWorkspaces()) if (ec2.getWorkspaceBacklogSource(w.id)?.repository === "acme/app") ec2.setWorkspaceBacklogSource(w.id, { ...APP, disabled: true });
      await writeBacklogExports(ec2, cfg, s3, t);
      expect(text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body).removed).toBe(true);
      await expect(bench.pull(ws, true)).rejects.toThrow("EC2 に acme/app の写しがありません");
      expect(pc.listBacklogRecords(APP)).toEqual([]);
    } finally {
      pc.close();
    }
  });

  test("an export's operations are only that machine's own operations of that repository; the read limit can be set", async () => {
    const small = await (async () => { await writeBacklogExports(ec2, cfg, s3); return readBacklogExport(s3, "pc1", "acme/app", 10); })().catch((e: ExportError) => e);
    expect(String(small)).toContain("上限 10 バイト");
    const tools = buildBacklogExport(ec2, "pc2", "acme/tools")!;
    expect(tools.operations).toEqual([]);
  });
});

describe("after each intake of the uplink round", () => {
  test("the instance writes the exports, after the edits taken in, and a round with nothing registered writes none (it only lists the prefix)", async () => {
    const sc = (machines: Record<string, string[]>, store: typeof s3 = s3) => ({ s3: store, uplinkBusy: false, uplink: { mode: "receive" as const, machines }, db: ec2, cfg: { home: dir, uplink: { machines } }, backlogReads: () => true, backlog: { send: async () => undefined } }) as unknown as Parameters<typeof uplinkRound>[0];
    await uplinkRound(sc({}));
    expect([...s3.objects.keys()]).toEqual([]);
    // an edit pc1 put before the round: the round takes it in before it writes the export, so pc1's export has it
    const pc = new Db(join(dir, "pc1.db"));
    try {
      importBacklogExport(pc, buildBacklogExport(ec2, "pc1", "acme/app")!, { workspaceId: pc.upsertWorkspace({ path: "/pc/app", name: "app", kind: "repo" }).id }, t);
      commentStoredIssue(pc, APP, 3, "from-pc1", t - SEND_DELAY_MS);
      await uploadBacklogOperations(pc, s3, APP, "pc1", t);
    } finally {
      pc.close();
    }
    await uplinkRound(sc(MACHINES));
    expect([...s3.objects.keys()].filter((k) => k.startsWith("backlog-export/")).sort()).toEqual(["backlog-export/pc1/acme/app.json.zst", "backlog-export/pc2/acme/app.json.zst", "backlog-export/pc2/acme/tools.json.zst"]);
    expect(text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body).operations.map((o: { id: string }) => o.id.slice(0, 6))).toEqual(["m:pc1:"]);
    // an intake that fails (the uplink cannot be listed) does not keep a withdrawal from being written
    const failing = { ...s3, list: async (prefix: string, after?: string) => { if (!prefix.startsWith("backlog-export/")) throw new Error("aws list-objects-v2 failed (255): SlowDown"); return s3.list(prefix, after); } } as typeof s3;
    await uplinkRound(sc({ pc2: ["acme/app", "acme/tools"] }, failing));
    expect(text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body).removed).toBe(true);
    // the instance imports again: the next round's object holds it
    ec2.putBacklogSnapshot(APP, { records: [{ objectKind: "issue", externalId: "I_12", remote: issue(12, { title: "直った題" }), fetchState: "fetched" }], cursor: null, syncedAt: 999 });
    await uplinkRound(sc(MACHINES));
    expect(text(s3.objects.get("backlog-export/pc1/acme/app.json.zst")!.body)).toMatchObject({ importedAt: 999 });
  });
});
