// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { loadConfig, UPLINK_PREVIEW } from "./config.ts";
import { Db, schemaLevel } from "./db.ts";
import { memoryS3 } from "./s3.ts";
import { type TarEntry, writeTarZst } from "./transfer.ts";
import { ArtifactStore } from "./artifacts.ts";
import { applyDelta, buildDelta, listApplied, readCursor, writeCursor } from "./uplink.ts";
import { placeOf, UPLINK_LIMITS } from "./uplink-in.ts";
import { listRefusedDeltas, receiveUplink } from "./uplink-s3.ts";

/* What the instance does with a delta as input from a machine it trusts less than itself. */

const tmp = mkdtempSync(join(tmpdir(), "sb-uplink-in-test-"));
afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    rmSync(tmp, { recursive: true, force: true });
  }
});

let n = 0;
function home(env: Record<string, string> = {}) {
  const root = join(tmp, `h${n++}`);
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(root, "sb"), SWITCHBOARD_CLAUDE_PROJECTS: join(root, "claude"), SWITCHBOARD_CODEX_HOME: join(root, "codex"), SWITCHBOARD_KNOWLEDGE: join(root, "k"), SWITCHBOARD_PORT: "1", ...env });
  mkdirSync(cfg.home, { recursive: true });
  return { root, cfg, db: new Db(cfg.dbPath) };
}
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/work/repo", scope: ["/work/repo"], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumePlannedAt: null, resumeSince: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 5_000, createdAt: 1_000, updatedAt: 5_000, ...extra });
const PC = { machine: "pc1", repositories: ["me/repo"] };
/** An account as an adapter names one: 16 hex characters. */
const ACCOUNT = "acc0000000000000";
const RECEIVE = { ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive", SWITCHBOARD_UPLINK_MACHINES: "pc1=me/repo,pc2=me/repo" };

/** A delta written by hand: what a machine with the work machine's credentials could put. */
async function forged(root: string, delta: Record<string, unknown>, files: TarEntry[] = []): Promise<string> {
  const file = join(root, `forged-${n++}.tar.zst`);
  await writeTarZst(file, [{ name: "delta.json", bytes: Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: {}, ...delta })) }, ...files]);
  return file;
}
/** A work machine's database with one Task, and its first delta as bytes. */
async function sent(machine: string, id: string, extra: Partial<Task> = {}) {
  const pc = home();
  const ws = pc.db.upsertWorkspace({ path: "/pc/repo", name: "repo", kind: "repo" });
  pc.db.setWorkspaceBacklogSource(ws.id, { service: "github", host: "github.com", repository: "me/repo" } as never);
  pc.db.insertTask(task(id, { workspaceId: ws.id, ...extra }));
  pc.db.appendEventAt(id, { t: "status", text: "on the PC" }, 5_000);
  const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), machine, { now: 1_000_000 });
  return { ...pc, delta: d!, bytes: new Uint8Array(await Bun.file(d!.file).arrayBuffer()) };
}

describe("a file's place", () => {
  const cfg = { attachmentsDir: "/sb/attachments", artifactsDir: "/sb/artifacts" };
  test("only a Task's attachment or a file of a Task's artifact has one, inside that Task's folder", () => {
    expect(placeOf(cfg, "attachments/t-1/shot.png")).toEqual({ kind: "attachments", task: "t-1", dest: "/sb/attachments/t-1/shot.png" });
    expect(placeOf(cfg, "artifacts/t-1/ar1/css/site.css")).toEqual({ kind: "artifacts", task: "t-1", dest: "/sb/artifacts/t-1/ar1/css/site.css" });
    for (const bad of ["sessions/claude/-p/x.jsonl", "attachments/t-1/a/b.png", "attachments/../x", "attachments/inbox/x", "artifacts/t-1/x.html", "artifacts/t-1/ar1/../../../x", "artifacts/t-1/ar1/.hidden", "artifacts/t-1/ar1/a\\b", "/etc/passwd", "artifacts/t-1/ar1/x\u0000y", "artifacts/t 1/ar1/x", "artifacts/t-1/ar1.old/x", "attachments/t-1/", "memory/MEMORY.md"]) expect([bad, "refusal" in placeOf(cfg, bad)]).toEqual([bad, true]);
  });
});

describe("applyDelta, on what it is given", () => {
  test("a delta that says it is from another machine than the one it lay under is refused, and so is one whose id carries another name", async () => {
    const here = home();
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { machine: "pc2", deltaId: "pc2-1-000000" }), PC)).rejects.toThrow("lay under pc1");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { deltaId: "pc2-1-000000" }), PC)).rejects.toThrow("does not carry the name of pc1");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { machine: ".." }), PC)).rejects.toThrow("not usable");
  });

  test("a machine cannot write over another machine's Task, nor move a row of another Task to one of its own", async () => {
    const here = home();
    const pc2 = await sent("pc2", "t-pc2");
    await applyDelta(here.db, here.cfg, pc2.delta.file, { machine: "pc2", repositories: [] });
    here.db.insertTask(task("t-own"));
    here.db.sqlite.query("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, created_at, updated_at) VALUES ('ar-own', 't-own', 'T', 'html', 'agent', 'index.html', 'text/html', 3, 1, 1)").run();
    const before = here.db.sqlite.query("SELECT * FROM tasks ORDER BY id").all();
    // pc1 names pc2's Task with a newer time
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ ...(here.db.sqlite.query("SELECT * FROM tasks WHERE id = 't-pc2'").get() as object), title: "taken over", updated_at: 9_000_000 }] } }), PC)).rejects.toThrow("names Task t-pc2 of pc2");
    // pc1 brings a Task of its own and an artifact row with the id of the instance's own artifact
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "t-new" }], artifacts: [{ id: "ar-own", task_id: "t-new", title: "theirs", updated_at: 9_000_000 }] } }), PC)).rejects.toThrow("belongs to another Task here");
    // rows or files of a Task nobody has
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { events: [{ task_id: "t-ghost", seq: 1, ts: 1, json: "{}" }] } }), PC)).rejects.toThrow("does not bring");
    expect(here.db.sqlite.query("SELECT * FROM tasks ORDER BY id").all()).toEqual(before);
    expect(here.db.sqlite.query("SELECT task_id, title FROM artifacts").all()).toEqual([{ task_id: "t-own", title: "T" }]);
  });

  test("a table a delta does not carry, or a value that is not a column's, refuses it", async () => {
    const here = home();
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { task_grants: [{ task_id: "t", repo: "me/repo" }] } }), PC)).rejects.toThrow("not a table a delta carries");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { settings: [{ key: "policies", value: "[]" }] } }), PC)).rejects.toThrow("not a table a delta carries");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "t", title: { $: 1 } }] } }), PC)).rejects.toThrow("not a text or a number");
  });

  test("a Task comes in with nothing this instance acts on, on a workspace only when its repository is one the machine is registered for", async () => {
    const here = home();
    const ws = here.db.upsertWorkspace({ id: "ws-here", path: "/srv/repo", name: "repo", kind: "repo" });
    here.db.setWorkspaceBacklogSource(ws.id, { service: "github", host: "github.com", repository: "me/repo" } as never);
    const pc = await sent("pc1", "t-a", { status: "running", resumeAt: 9_999, resumeReason: "limit", queuedAt: 5, deferredPrompt: "run this here", scheduleId: "sch_instance" });
    await applyDelta(here.db, here.cfg, pc.delta.file, { machine: "pc1", repositories: ["other/repo"] });
    expect(here.db.sqlite.query("SELECT machine, workspace_id, status, resume_at, queued_at, deferred_prompt, schedule_id FROM tasks WHERE id = 't-a'").get()).toEqual({ machine: "pc1", workspace_id: null, status: "idle", resume_at: null, queued_at: null, deferred_prompt: null, schedule_id: null });
    const other = home();
    const ws2 = other.db.upsertWorkspace({ id: "ws-here", path: "/srv/repo", name: "repo", kind: "repo" });
    other.db.setWorkspaceBacklogSource(ws2.id, { service: "github", host: "github.com", repository: "me/repo" } as never);
    await applyDelta(other.db, other.cfg, pc.delta.file, PC);
    expect(other.db.getTask("t-a")?.workspaceId).toBe("ws-here");
  });

  test("a usage report dated ahead of this clock, or a limit said to reset later than any window lasts, is dropped", async () => {
    const here = home();
    const now = 1_800_000_000_000;
    here.db.upsertQuota("claude", "five_hour", 0.2, now / 1000 + 60, now - 1_000, ACCOUNT);
    const row = (over: object) => ({ runner: "claude", account: ACCOUNT, window: "five_hour", utilization: 1, resets_at: now / 1000 + 3600, ts: now, ...over });
    const r = await applyDelta(here.db, here.cfg, await forged(here.root, { tables: { quota_by_account: [row({ ts: now + 24 * 3600_000 }), row({ window: "weekly", resets_at: now / 1000 + 400 * 24 * 3600 }), row({ window: "x", utilization: "NaN" })] } }), PC, { now });
    expect(r).toMatchObject({ status: "applied", rows: { quota_by_account: 0 } });
    expect(here.db.quotaAll().map((q) => [q.window, q.utilization])).toEqual([["five_hour", 0.2]]);
    // a report no runner here could make: a runner or a window that is not one's name, a share past any limit, an
    // account that is not an adapter's name — and one under no account, which is where this instance's own reports wait
    const odd = [row({ runner: "gpt" }), row({ runner: "custom:../x" }), row({ window: "Five Hour; --" }), row({ utilization: 99 }), row({ utilization: -1 }), row({ utilization: "0.5" }), row({ account: "someone@example.com" }), row({ account: "" })];
    expect(await applyDelta(here.db, here.cfg, await forged(here.root, { deltaId: "pc1-3-000000", tables: { quota_by_account: odd } }), PC, { now })).toMatchObject({ status: "applied", rows: { quota_by_account: 0 } });
    expect(here.db.quotaAll().map((q) => [q.runner, q.account, q.window, q.utilization])).toEqual([["claude", ACCOUNT, "five_hour", 0.2]]);
    // one in bounds is taken, as before
    expect(await applyDelta(here.db, here.cfg, await forged(here.root, { deltaId: "pc1-2-000000", tables: { quota_by_account: [row({})] } }), PC, { now })).toMatchObject({ rows: { quota_by_account: 1 } });
  });

  test("a row whose id is not a plain name, or whose time is not a number, refuses the whole delta; the artifacts' sweep goes on past such a row", async () => {
    const here = home();
    const art = (over: object) => ({ id: "ar1", task_id: "t-b", title: "r", kind: "file", source: "/pc/r.md", entry: "r.md", mime: "text/plain", size: 1, removed_at: null, created_at: 1, updated_at: 1, ...over });
    const with_ = (tables: Record<string, unknown[]>) => forged(here.root, { tables: { tasks: [{ id: "t-b" }], ...tables } });
    await expect(applyDelta(here.db, here.cfg, await with_({ artifacts: [art({ id: "../x", removed_at: 1 })] }), PC)).rejects.toThrow("not a plain name");
    await expect(applyDelta(here.db, here.cfg, await with_({ artifacts: [art({ removed_at: "soon" })] }), PC)).rejects.toThrow("removed_at");
    await expect(applyDelta(here.db, here.cfg, await with_({ artifacts: [art({ updated_at: "9e99" })] }), PC)).rejects.toThrow("updated_at");
    await expect(applyDelta(here.db, here.cfg, await with_({ attachments: [{ id: "a/b", task_id: "t-b", path: "/pc/x.png", created_at: 1 }] }), PC)).rejects.toThrow("not a plain name");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "../t" }] } }), PC)).rejects.toThrow("names no Task");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "t-b" }], events: [{ task_id: "t/b", seq: 1 }] } }), PC)).rejects.toThrow("names no Task");
    expect([here.db.getTask("t-b"), here.db.sqlite.query("SELECT count(*) AS n FROM artifacts").get(), listApplied(here.db)]).toEqual([null, { n: 0 }, []]);
    // a row like that, however it got in: the start's sweep passes it over and still removes the others
    here.db.insertTask(task("t-b"));
    const row = { taskId: "t-b", title: "r", kind: "file" as const, source: "/pc/r.md", entry: "r.md", mime: "text/plain", size: 1, removedAt: 1, createdAt: 1, updatedAt: 1, appDays: 0, appRequestTaskId: null };
    here.db.insertArtifact({ ...row, id: "../x" });
    here.db.insertArtifact({ ...row, id: "ar2" });
    const store = new ArtifactStore(here.db, here.cfg.artifactsDir, { privateTmp: () => join(here.root, "tmp"), deny: [], tmpRoots: [] });
    expect(store.sweep(1_000_000_000_000)).toBe(1);
    expect(here.db.sqlite.query("SELECT id FROM artifacts").all()).toEqual([{ id: "../x" }]);
  });

  test("a file whose place goes through a link into another Task's folder refuses the delta, and the other Task's file is as it was", async () => {
    const here = home();
    const dir = here.cfg.artifactsDir;
    mkdirSync(join(dir, "t-other", "x"), { recursive: true });
    writeFileSync(join(dir, "t-other", "x", "report.md"), "the other Task's report");
    mkdirSync(join(dir, "t-b"), { recursive: true });
    // the artifact's folder of this Task is a link to the other Task's
    symlinkSync(join(dir, "t-other", "x"), join(dir, "t-b", "ar1"));
    const delta = () => forged(here.root, { tables: { tasks: [{ id: "t-b", title: "t", runner: "claude", cwd: "/pc", scope: "[]", status: "done", status_at: 1, created_at: 1, updated_at: 1 }] } }, [{ name: "files/artifacts/t-b/ar1/report.md", bytes: Buffer.from("written from the work machine") }]);
    await expect(applyDelta(here.db, here.cfg, await delta(), PC)).rejects.toThrow("behind a link");
    expect(readFileSync(join(dir, "t-other", "x", "report.md"), "utf8")).toBe("the other Task's report");
    expect(here.db.getTask("t-b")).toBeNull();
    // the Task's own folder being a link to another Task's is the same
    rmSync(join(dir, "t-b"), { recursive: true });
    symlinkSync(join(dir, "t-other"), join(dir, "t-b"));
    const moved = forged(here.root, { tables: { tasks: [{ id: "t-b" }] } }, [{ name: "files/artifacts/t-b/x/report.md", bytes: Buffer.from("written from the work machine") }]);
    await expect(applyDelta(here.db, here.cfg, await moved, PC)).rejects.toThrow("behind a link");
    expect(readFileSync(join(dir, "t-other", "x", "report.md"), "utf8")).toBe("the other Task's report");
    // without a link the same file goes in
    rmSync(join(dir, "t-b"));
    expect(await applyDelta(here.db, here.cfg, await delta(), PC)).toMatchObject({ status: "applied", files: 1 });
    expect(readFileSync(join(dir, "t-b", "ar1", "report.md"), "utf8")).toBe("written from the work machine");
  });

  test("an object that unpacks past the limit, holds too many entries, or holds something that is not a plain file is refused without being unpacked whole", async () => {
    const here = home();
    const small = { ...UPLINK_LIMITS, expandedBytes: 64 * 1024, jsonBytes: 16 * 1024, fileBytes: 8 * 1024, entries: 3 };
    // 4 MiB of zeros: a few hundred bytes compressed
    const bomb = await forged(here.root, { tables: { tasks: [{ id: "t-b" }] } }, [{ name: "files/artifacts/t-b/r/zeros.bin", bytes: new Uint8Array(4 * 1024 * 1024) }]);
    expect((await Bun.file(bomb).arrayBuffer()).byteLength).toBeLessThan(4096);
    // each limit by itself: the whole of what it unpacks to, and one file
    await expect(applyDelta(here.db, here.cfg, bomb, PC, { limits: { ...small, fileBytes: 64 * 1024 * 1024 } })).rejects.toThrow("more than 65536 bytes");
    await expect(applyDelta(here.db, here.cfg, bomb, PC, { limits: { ...small, expandedBytes: 64 * 1024 * 1024 } })).rejects.toThrow("over the limit of 8192");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "t-b", title: "x".repeat(20_000) }] } }), PC, { limits: small })).rejects.toThrow("delta.json is");
    await expect(applyDelta(here.db, here.cfg, await forged(here.root, { tables: { tasks: [{ id: "t-b" }] } }, [1, 2, 3, 4].map((i) => ({ name: `files/artifacts/t-b/r/${i}.txt`, bytes: Buffer.from("x") }))), PC, { limits: small })).rejects.toThrow("more than 3 files");
    // a tar with a link in it (made by hand: the type byte of a header set to a symlink's)
    const linked = join(here.root, "linked.tar.zst");
    const header = Buffer.alloc(512);
    header.write("files/artifacts/t-b/r/link", 0);
    header.write("0000644\0", 100);
    header.write("00000000000\0", 124);
    header.write("2", 156);
    header.write("ustar\0", 257);
    writeFileSync(linked, Bun.zstdCompressSync(Buffer.concat([header, Buffer.alloc(1024)])));
    await expect(applyDelta(here.db, here.cfg, linked, PC)).rejects.toThrow("not a plain file");
    expect(existsSync(here.cfg.artifactsDir)).toBe(false);
    expect(readdirSync(here.cfg.home).filter((f) => f.startsWith("uplink-in-"))).toEqual([]);
    expect(here.db.getTask("t-b")).toBeNull();
  });
});

describe("receiveUplink, on what lies in the bucket", () => {
  test("with no machine registered the bucket is never asked, and a prefix nobody registered is never read", async () => {
    const s3 = memoryS3();
    const pc = await sent("pc9", "t-9");
    await s3.put(`uplink/pc9/${pc.delta.deltaId}.tar.zst`, pc.bytes);
    const none = home({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive" });
    const before = s3.calls;
    expect(await receiveUplink(none.db, none.cfg, s3)).toEqual([]);
    expect(s3.calls).toBe(before);
    const here = home(RECEIVE);
    expect(await receiveUplink(here.db, here.cfg, s3, { log: () => undefined })).toEqual([]);
    expect(here.db.getTask("t-9")).toBeNull();
  });

  test("a delta put under another machine's prefix is refused there, remembered, and not fetched again", async () => {
    const s3 = memoryS3();
    const here = home(RECEIVE);
    const pc2 = await sent("pc2", "t-pc2");
    // pc2's delta, copied under pc1's prefix with a name of pc1's
    await s3.put("uplink/pc1/pc1-0000000000001-000000.tar.zst", pc2.bytes);
    const lines: string[] = [];
    expect(await receiveUplink(here.db, here.cfg, s3, { log: (l) => lines.push(l), now: 2_000_000 })).toEqual([]);
    expect(listRefusedDeltas(here.db)).toMatchObject([{ machine: "pc1", key: "uplink/pc1/pc1-0000000000001-000000.tar.zst", reason: expect.stringContaining("lay under pc1") }]);
    expect(here.db.getTask("t-pc2")).toBeNull();
    const gets = () => s3.calls;
    const before = gets();
    await receiveUplink(here.db, here.cfg, s3, { log: (l) => lines.push(l), now: 2_000_001 });
    expect(gets() - before).toBe(2); // one list per registered machine, no download
    expect(lines).toHaveLength(1); // said once
  });

  test("one refused object does not hold what the machine sends after it: it is recorded once and passed over, the next delta goes in, and a delta that continues what the refused one held is refused for that — not put on the hole", async () => {
    const s3 = memoryS3();
    const here = home(RECEIVE);
    const lines: string[] = [];
    const round = (now: number) => receiveUplink(here.db, here.cfg, s3, { log: (l) => lines.push(l), now });
    // anything with the work machine's credentials can put this in front of everything else
    await s3.put("uplink/pc1/pc1-2.tar.zst", new Uint8Array([1, 2, 3]));
    const pc = await sent("pc1", "t-a");
    await s3.put(`uplink/pc1/${pc.delta.deltaId}.tar.zst`, pc.bytes);
    expect((await round(2_000_000)).map((r) => r.status)).toEqual(["applied"]);
    expect(here.db.getTask("t-a")?.machine).toBe("pc1");
    expect(listRefusedDeltas(here.db).map((r) => [r.key, r.reason])).toEqual([["uplink/pc1/pc1-2.tar.zst", "its name is not a delta of this machine"]]);
    await round(2_000_001);
    expect(lines.filter((l) => l.includes("pc1-2.tar.zst"))).toHaveLength(1);
    // the work machine goes on: its second delta is refused for what it holds, its third continues the same Task
    writeCursor(pc.db, pc.delta.cursor);
    pc.db.appendEventAt("t-a", { t: "status", text: "second" }, 1_100_000);
    const [second] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_200_000, dir: join(pc.root, "second") });
    writeCursor(pc.db, second!.cursor);
    pc.db.appendEventAt("t-a", { t: "status", text: "third" }, 1_300_000);
    pc.db.insertTask(task("t-b"));
    pc.db.appendEventAt("t-b", { t: "status", text: "another Task" }, 1_300_000);
    const [third] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_400_000, dir: join(pc.root, "third") });
    writeCursor(pc.db, third!.cursor);
    pc.db.appendEventAt("t-b", { t: "status", text: "its next" }, 1_500_000);
    const [fourth] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_600_000, dir: join(pc.root, "fourth") });
    // the second arrives broken (cut short on the way): refused for what it holds
    await s3.put(`uplink/pc1/${second!.deltaId}.tar.zst`, new Uint8Array(await Bun.file(second!.file).arrayBuffer()).slice(0, 40));
    await s3.put(`uplink/pc1/${third!.deltaId}.tar.zst`, new Uint8Array(await Bun.file(third!.file).arrayBuffer()));
    await s3.put(`uplink/pc1/${fourth!.deltaId}.tar.zst`, new Uint8Array(await Bun.file(fourth!.file).arrayBuffer()));
    const before = here.db.listEvents("t-a").length;
    await round(2_000_002);
    const refused = listRefusedDeltas(here.db);
    expect(refused.map((r) => r.key)).toEqual(["uplink/pc1/pc1-2.tar.zst", `uplink/pc1/${second!.deltaId}.tar.zst`, `uplink/pc1/${third!.deltaId}.tar.zst`, `uplink/pc1/${fourth!.deltaId}.tar.zst`]);
    // the third continued t-a past the hole (and brought t-b with it): refused whole, with the reason; the fourth then
    // continues t-b, whose first event went with the third
    expect(refused[2]!.reason).toContain("continues Task t-a from event 3, and this instance has it up to 1: it depends on a delta that was not taken in");
    expect(refused[3]!.reason).toContain("continues Task t-b from event 2, and this instance has it up to 0: it depends on a delta that was not taken in");
    expect(here.db.listEvents("t-a")).toHaveLength(before);
    expect(here.db.getTask("t-b")).toBeNull();
    // every key was passed: the next round lists nothing and fetches nothing
    const calls = s3.calls;
    await round(2_000_003);
    expect(s3.calls - calls).toBe(2);
  });

  test("a delta that does not depend on the refused one goes in after it", async () => {
    const s3 = memoryS3();
    const here = home(RECEIVE);
    const pc = await sent("pc1", "t-a");
    await s3.put(`uplink/pc1/${pc.delta.deltaId}.tar.zst`, pc.bytes.slice(0, 40)); // broken on the way
    writeCursor(pc.db, pc.delta.cursor);
    pc.db.insertTask(task("t-new"));
    pc.db.appendEventAt("t-new", { t: "status", text: "a Task of its own" }, 1_100_000);
    const [next] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_200_000, dir: join(pc.root, "next") });
    await s3.put(`uplink/pc1/${next!.deltaId}.tar.zst`, new Uint8Array(await Bun.file(next!.file).arrayBuffer()));
    const got = await receiveUplink(here.db, here.cfg, s3, { log: () => undefined, now: 2_000_000 });
    expect(got.map((r) => r.status)).toEqual(["applied"]);
    expect([here.db.getTask("t-a"), here.db.getTask("t-new")?.machine]).toEqual([null, "pc1"]);
    expect(listRefusedDeltas(here.db)).toHaveLength(1);
  });

  test("a key that is not a delta's name, one dated ahead of this clock, or an object over the size limit is not fetched", async () => {
    const s3 = memoryS3();
    const here = home(RECEIVE);
    const pc = await sent("pc1", "t-a");
    const limits = { ...UPLINK_LIMITS, objectBytes: pc.bytes.length - 1 };
    await s3.put(`uplink/pc1/${pc.delta.deltaId}.tar.zst`, pc.bytes);
    let fetched = 0;
    const counting = { ...s3, list: s3.list, put: s3.put, get: (k: string) => (fetched++, s3.get(k)) };
    await receiveUplink(here.db, here.cfg, counting, { log: () => undefined, now: 2_000_000, limits });
    expect(listRefusedDeltas(here.db)[0]?.reason).toContain("over the limit");
    const far = home(RECEIVE);
    const s3b = memoryS3();
    await s3b.put("uplink/pc1/pc1-9999999999999999-000000.tar.zst", pc.bytes);
    const countingB = { ...s3b, list: s3b.list, put: s3b.put, get: (k: string) => (fetched++, s3b.get(k)) };
    await receiveUplink(far.db, far.cfg, countingB, { log: () => undefined, now: 2_000_000 });
    expect(listRefusedDeltas(far.db)[0]?.reason).toContain("ahead of this instance's clock");
    const odd = home(RECEIVE);
    const s3c = memoryS3();
    await s3c.put("uplink/pc1/..%2f..%2fx.tar.zst", pc.bytes);
    const countingC = { ...s3c, list: s3c.list, put: s3c.put, get: (k: string) => (fetched++, s3c.get(k)) };
    await receiveUplink(odd.db, odd.cfg, countingC, { log: () => undefined, now: 2_000_000 });
    expect(listRefusedDeltas(odd.db)[0]?.reason).toContain("not a delta of this machine");
    expect(fetched).toBe(0);
    // a refused object was passed over: it is not read again, whatever the limits are later, and the record of it stays
    await receiveUplink(here.db, here.cfg, counting, { log: () => undefined, now: 2_000_000 });
    expect(fetched).toBe(0);
    expect(here.db.getTask("t-a")).toBeNull();
    expect(listRefusedDeltas(here.db)).toHaveLength(1);
  });

  test("an object that holds another delta's id than its key says is refused before anything of it is taken in", async () => {
    const here = home(RECEIVE);
    const s3 = memoryS3();
    const file = await forged(here.root, { deltaId: "pc1-9-000000", tables: { tasks: [{ id: "t-b", title: "under another id", runner: "claude", cwd: "/pc", scope: "[]", status: "done", created_at: 1, updated_at: 1 }] } });
    await s3.put("uplink/pc1/pc1-5-000000.tar.zst", new Uint8Array(await Bun.file(file).arrayBuffer()));
    expect(await receiveUplink(here.db, here.cfg, s3, { log: () => undefined, now: 2_000_000 })).toEqual([]);
    expect(listRefusedDeltas(here.db).map((r) => [r.key, r.reason])).toEqual([["uplink/pc1/pc1-5-000000.tar.zst", "it holds delta pc1-9-000000, not the one its name says"]]);
    // refused means not taken in: no Task, no mark that the delta went in
    expect([here.db.getTask("t-b"), listApplied(here.db)]).toEqual([null, []]);
  });

  test("a work machine whose clock went back still names its next delta after the last one, so the instance does not pass it over", async () => {
    const pc = await sent("pc1", "t-a");
    writeCursor(pc.db, pc.delta.cursor);
    pc.db.appendEventAt("t-a", { t: "status", text: "later, by an earlier clock" }, 6_000);
    const [next] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 500_000, dir: join(pc.root, "again") });
    expect(next!.deltaId > pc.delta.deltaId).toBe(true);
    expect(next!.deltaId).toBe("pc1-1000001-000000");
  });
});
