// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { loadConfig, UPLINK_PREVIEW } from "./config.ts";
import { Db, schemaLevel, tasksOfIssues } from "./db.ts";
import { memoryS3 } from "./s3.ts";
import { listSkipped, readCursor } from "./uplink.ts";
import { receiveUplink, sendUplink } from "./uplink-s3.ts";

const tmp = mkdtempSync(join(tmpdir(), "sb-uplink-s3-test-"));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function task(id: string, updatedAt: number, extra: Partial<Task> = {}): Task {
  return { id, workspaceId: null, title: id, runner: "claude", cwd: "/work/repo", scope: ["/work/repo"], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumePlannedAt: null, resumeSince: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: updatedAt, createdAt: 1_000, updatedAt, ...extra };
}

let n = 0;
function home(env: Record<string, string> = {}) {
  const root = join(tmp, `h${n++}`);
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(root, "sb"), SWITCHBOARD_CLAUDE_PROJECTS: join(root, "claude"), SWITCHBOARD_CODEX_HOME: join(root, "codex"), SWITCHBOARD_KNOWLEDGE: join(root, "k"), SWITCHBOARD_PORT: "1", ...env });
  mkdirSync(cfg.home, { recursive: true });
  return { root, cfg, db: new Db(cfg.dbPath) };
}
const PC = { ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b" };
/** The instance, with the two work machines of these tests registered. */
const EC2 = { ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive", SWITCHBOARD_UPLINK_MACHINES: "pc1=o/r,pc2=o/r" };
const quiet = { log: () => undefined };

describe("the uplink through S3", () => {
  test("what the work machine puts, the instance takes in: the Task is listed there with its machine, and a second round does nothing", async () => {
    const pc = home(PC);
    const ec2 = home(EC2);
    const s3 = memoryS3();
    pc.db.insertTask(task("t-pc", 5_000));
    pc.db.appendEventAt("t-pc", { t: "status", text: "hello" }, 5_000);
    expect(await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 })).toEqual(["pc1-1000000-000000"]);
    expect([...s3.objects.keys()]).toEqual(["uplink/pc1/pc1-1000000-000000.tar.zst"]);
    // the mark moved and the file built is gone
    expect(readCursor(pc.db).at).toBe(1_000_000);
    expect(existsSync(join(pc.cfg.home, "uplink")) ? readdirSync(join(pc.cfg.home, "uplink")) : []).toEqual([]);
    // nothing new: nothing is put
    const calls = s3.calls;
    expect(await sendUplink(pc.db, pc.cfg, s3, { now: 2_000_000 })).toEqual([]);
    expect(s3.calls).toBe(calls);

    const got = await receiveUplink(ec2.db, ec2.cfg, s3, quiet);
    expect(got.map((r) => r.status)).toEqual(["applied"]);
    expect(ec2.db.getTask("t-pc")?.machine).toBe("pc1");
    expect(ec2.db.listTasks().map((t) => t.id)).toContain("t-pc");
    // a second round reads the list and takes nothing
    const before = s3.calls;
    expect(await receiveUplink(ec2.db, ec2.cfg, s3, quiet)).toEqual([]);
    expect(s3.calls - before).toBe(2); // one list per registered machine, nothing fetched
    expect(readdirSync(ec2.cfg.home).filter((f) => f.startsWith("uplink-"))).toEqual([]);
  });

  test("a key that is there is never written over: the same delta put again leaves what was put first", async () => {
    const pc = home(PC);
    const s3 = memoryS3();
    pc.db.insertTask(task("t-1", 5_000));
    await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 });
    const key = "uplink/pc1/pc1-1000000-000000.tar.zst";
    const first = (await s3.get(key))!;
    // the mark was lost (the send is tried again from the start), the Task changed meanwhile: the same key is built again
    pc.db.setSetting("uplink.cursor", { at: 0, ledger: 0, routing: 0, seqs: {}, files: {} });
    pc.db.updateTask("t-1", { title: "changed" });
    expect(await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 })).toEqual(["pc1-1000000-000000"]);
    const again = (await s3.get(key))!;
    expect(again.etag).toBe(first.etag);
    expect(Buffer.from(again.body).equals(Buffer.from(first.body))).toBe(true);
  });

  test("three deltas put while the instance was stopped all go in at its next start, in their order", async () => {
    const pc = home(PC);
    const ec2 = home(EC2);
    const s3 = memoryS3();
    for (const [i, id] of ["t-a", "t-b", "t-c"].entries()) {
      pc.db.insertTask(task(id, 1_000_000 * (i + 1) - 10));
      pc.db.appendEventAt(id, { t: "status", text: id }, 1_000_000 * (i + 1) - 10);
      await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 * (i + 1) });
    }
    expect(s3.objects.size).toBe(3);
    const got = await receiveUplink(ec2.db, ec2.cfg, s3, quiet);
    expect(got.map((r) => r.deltaId)).toEqual(["pc1-1000000-000000", "pc1-2000000-000000", "pc1-3000000-000000"]);
    expect(["t-a", "t-b", "t-c"].map((id) => ec2.db.getTask(id)?.machine)).toEqual(["pc1", "pc1", "pc1"]);
  });

  test("a delta from a newer database holds that machine's later ones, says why, and goes in once it can; another machine's are not held", async () => {
    const pc = home(PC);
    const pc2 = home({ ...PC, SWITCHBOARD_MACHINE: "pc2" });
    const ec2 = home(EC2);
    const s3 = memoryS3();
    pc.db.insertTask(task("t-1", 900_000));
    await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 });
    pc.db.insertTask(task("t-2", 1_900_000));
    await sendUplink(pc.db, pc.cfg, s3, { now: 2_000_000 });
    pc2.db.insertTask(task("t-other", 900_000));
    await sendUplink(pc2.db, pc2.cfg, s3, { now: 1_500_000 });
    // the first of pc1's is made to look like one of a newer database
    const key = "uplink/pc1/pc1-1000000-000000.tar.zst";
    const real = s3.objects.get(key)!;
    const { writeTarZst } = await import("./transfer.ts");
    const newer = join(tmp, "newer.tar.zst");
    await writeTarZst(newer, [{ name: "delta.json", bytes: Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1000000-000000", schemaLevel: schemaLevel() + 1, createdAt: 1_000_000, repos: {}, tables: {} })) }]);
    s3.objects.set(key, { body: new Uint8Array(await Bun.file(newer).arrayBuffer()), etag: '"newer"' });
    const lines: string[] = [];
    const got = await receiveUplink(ec2.db, ec2.cfg, s3, { log: (l) => lines.push(l) });
    expect(got.map((r) => `${r.machine} ${r.status}`)).toEqual(["pc1 skipped", "pc2 applied"]);
    expect(lines.join("\n")).toContain(`level ${schemaLevel() + 1}`);
    expect(listSkipped(ec2.db).map((s) => s.deltaId)).toEqual(["pc1-1000000-000000"]);
    expect(ec2.db.getTask("t-2")).toBeNull();
    expect(ec2.db.getTask("t-other")?.machine).toBe("pc2");
    // the instance is upgraded (here: the delta is the real one again): both of pc1's go in and the reason is gone
    s3.objects.set(key, real);
    expect((await receiveUplink(ec2.db, ec2.cfg, s3, quiet)).map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(listSkipped(ec2.db)).toEqual([]);
    expect(ec2.db.getTask("t-2")?.machine).toBe("pc1");
  });

  test("a stage Task whose Issue number was put right after it was sent arrives with the new number, and the flow's cost finds it", async () => {
    const pc = home(PC);
    const ec2 = home(EC2);
    const s3 = memoryS3();
    const source = { service: "github" as const, host: "github.com", repository: "o/r", project: { owner: "o", number: 1 } };
    const wsPc = pc.db.upsertWorkspace({ name: "r", path: join(pc.root, "r"), kind: "repo" });
    const wsEc2 = ec2.db.upsertWorkspace({ name: "r", path: join(ec2.root, "r"), kind: "repo" });
    pc.db.setWorkspaceBacklogSource(wsPc.id, source);
    ec2.db.setWorkspaceBacklogSource(wsEc2.id, source);
    pc.db.insertTask(task("t-stage", 5_000, { workspaceId: wsPc.id, stage: { issue: 3, action: "complete" } }));
    await sendUplink(pc.db, pc.cfg, s3, { now: 1_000_000 });
    await receiveUplink(ec2.db, ec2.cfg, s3, quiet);
    expect(ec2.db.getTask("t-stage")?.stage?.issue).toBe(3);
    pc.db.renumberStageIssues(wsPc.id, [{ from: 3, to: 4321 }], Date.now() + 1);
    expect(await sendUplink(pc.db, pc.cfg, s3)).toHaveLength(1);
    await receiveUplink(ec2.db, ec2.cfg, s3, quiet);
    expect(ec2.db.getTask("t-stage")?.stage?.issue).toBe(4321);
    expect(tasksOfIssues(ec2.db.sqlite, [4321], [wsEc2.id]).map((t) => t.id)).toEqual(["t-stage"]);
  });
});
