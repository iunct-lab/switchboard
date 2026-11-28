// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { abortOrphanedTasks, Db, schemaLevel, tasksOfIssues } from "./db.ts";
import { writeTarZst } from "./transfer.ts";
import { applyDelta, buildDelta, type Cursor, listApplied, listSkipped, OVERLAP_MS, readCursor, remapWorkspaces, writeCursor } from "./uplink.ts";

const tmp = mkdtempSync(join(tmpdir(), "sb-uplink-test-"));
// Bun's recursive rm now and then fails with EFAULT here; a second try removes what is left
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

/** Where the deltas below lie, as the instance knows it: the registered machine and what it is registered for. */
const PC = { machine: "pc1", repositories: ["me/repo"] };

let n = 0;
/** A HOME of its own: database, folders and the delta folder. */
function home() {
  const root = join(tmp, `h${n++}`);
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(root, "sb"), SWITCHBOARD_CLAUDE_PROJECTS: join(root, "claude"), SWITCHBOARD_CODEX_HOME: join(root, "codex"), SWITCHBOARD_KNOWLEDGE: join(root, "k"), SWITCHBOARD_PORT: "1" });
  mkdirSync(cfg.home, { recursive: true });
  return { root, cfg, db: new Db(cfg.dbPath) };
}

function ledger(db: Db, taskId: string, ts: number) {
  db.sqlite.query("INSERT INTO ledger (task_id, runner, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, source, ts) VALUES (?, 'claude', 'm', 1, 1, 0, 0, 0.5, 'test', ?)").run(taskId, ts);
}

/** delta.json and the names of `files/…` of a built delta. */
async function open(file: string, root: string) {
  const out = join(root, `un-${n++}`);
  mkdirSync(out, { recursive: true });
  await new Bun.Archive(Bun.zstdDecompressSync(readFileSync(file))).extract(out);
  const files = (readdirSync(out, { recursive: true }) as string[]).filter((f) => f.startsWith("files/") && statSync(join(out, f)).isFile()).sort();
  return { delta: JSON.parse(readFileSync(join(out, "delta.json"), "utf8")), files, dir: out };
}
/** A mark at `at` with nothing else sent. */
const mark = (at: number, more: Partial<Cursor> = {}): Cursor => ({ at, ledger: 0, routing: 0, seqs: {}, files: {}, ...more });
const ids = (rows: Array<{ id?: string; task_id?: string }>) => rows.map((r) => r.id ?? r.task_id).sort();

describe("buildDelta", () => {
  test("holds the rows of the Tasks that changed, and of those only what is newer", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-old", 5_000));
    db.appendEventAt("t-old", { t: "status", text: "old" }, 5_000);
    ledger(db, "t-old", 5_000);
    db.insertTask(task("t-late", 5_000)); // its row is old; a new ledger row alone brings it in
    ledger(db, "t-late", 5_000);
    const sent = mark(900_000, { ledger: 2, seqs: { "t-old": 1 } }); // the rows above were sent before
    db.insertTask(task("t-new", 900_000));
    db.appendEventAt("t-new", { t: "status", text: "new" }, 900_000);
    ledger(db, "t-late", 880_000);
    const [d, ...more] = await buildDelta(db, cfg, sent, "pc1", { now: 1_000_000 });
    expect(more).toEqual([]);
    expect(d!.deltaId).toBe("pc1-1000000-000000");
    expect(d!.cursor).toEqual({ at: 1_000_000, named: 1_000_000, ledger: 3, routing: 0, seqs: { "t-old": 1, "t-new": 1 }, files: {} });
    const { delta } = await open(d!.file, root);
    expect(delta.machine).toBe("pc1");
    expect(delta.createdAt).toBe(1_000_000);
    expect(delta.schemaLevel).toBe(schemaLevel());
    expect(ids(delta.tables.tasks)).toEqual(["t-late", "t-new"]); // t-old is not in it
    expect(ids(delta.tables.events)).toEqual(["t-new"]);
    expect(delta.tables.ledger.length).toBe(1); // t-late's 880,000, not its 5,000
    expect(delta.tables.ledger[0].task_id).toBe("t-late");
  });

  test("rows written after a send with an older time (a terminal session taken in late) go in the next delta; the runner's session file never goes", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-term", 5_000));
    db.appendEventAt("t-term", { t: "status", text: "first" }, 5_000);
    ledger(db, "t-term", 5_000);
    const [first] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 1_000_000 });
    writeCursor(db, first!.cursor);
    // the import catches up: rows from before the mark, the Task's row not touched, a new Task whose session file is old
    db.appendEventAt("t-term", { t: "status", text: "late" }, 6_000);
    ledger(db, "t-term", 6_000);
    db.sqlite.query("INSERT INTO routing_log (task_id, cwd, suggested, rule_id, reason, chosen, ts) VALUES ('t-term', '/work/repo', 'claude', 'r', 'why', 'claude', 6000)").run();
    db.insertTask(task("t-late", 7_000, { runnerSessionId: "s-late" }));
    db.appendEventAt("t-late", { t: "status", text: "x" }, 7_000);
    mkdirSync(join(cfg.claudeProjectsDir, "-work-repo"), { recursive: true });
    const session = join(cfg.claudeProjectsDir, "-work-repo", "s-late.jsonl");
    writeFileSync(session, "{}\n");
    utimesSync(session, 7, 7);
    const [d, ...more] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 2_000_000 });
    expect(more).toEqual([]);
    const { delta, files } = await open(d!.file, root);
    expect(ids(delta.tables.tasks)).toEqual(["t-late", "t-term"]);
    expect((delta.tables.events as Array<{ task_id: string; seq: number }>).filter((e) => e.task_id === "t-term").map((e) => e.seq)).toEqual([2]);
    expect((delta.tables.ledger as Array<{ ts: number }>).map((r) => r.ts)).toEqual([6_000]);
    expect((delta.tables.routing_log as Array<{ ts: number }>).map((r) => r.ts)).toEqual([6_000]);
    expect(files).toEqual([]);
    writeCursor(db, d!.cursor);
    expect(await buildDelta(db, cfg, readCursor(db), "pc1", { now: 3_000_000 })).toEqual([]);
  });

  test("an attachment uploaded before the mark and tied to the Task after it goes with its file once", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-a", 5_000));
    db.appendEventAt("t-a", { t: "status", text: "start" }, 5_000);
    const at = join(cfg.attachmentsDir, "t-a");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "shot.png"), "png");
    const [first] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 1_000_000 });
    writeCursor(db, first!.cursor);
    // uploaded at 5,000 (before the mark), tied to the Task with the message that sends it
    db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-a', 'shot.png', 'image/png', 3, ?, 5000)").run(join(at, "shot.png"));
    db.appendEventAt("t-a", { t: "status", text: "with a picture" }, 2_000_000);
    const [d] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 2_100_000 });
    const opened = await open(d!.file, root);
    expect(ids(opened.delta.tables.attachments)).toEqual(["a1"]);
    expect(opened.files).toEqual(["files/attachments/t-a/shot.png"]);
    writeCursor(db, d!.cursor);
    db.appendEventAt("t-a", { t: "status", text: "later" }, 3_000_000);
    const [again] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 3_100_000 });
    const later = await open(again!.file, root);
    expect(later.delta.tables.attachments).toEqual([]);
    expect(later.files).toEqual([]);
  });

  test("evals, check runs, staged changes (a decision counts) and artifacts go when newer than the mark", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-c", 5_000));
    const row = (sql: string, ...v: Array<string | number>) => db.sqlite.query(sql).run(...v);
    row("INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES ('t-c', 'old', 'r', NULL, '{}', 5000)");
    row("INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES ('t-c', 'new', 'r', NULL, '{}', 900000)");
    row("INSERT INTO check_runs (task_id, ok, json, ts) VALUES ('t-c', 1, '{}', 900000)");
    row("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts, decided_at) VALUES ('s-old', 't-c', '/p', 'p', 'edit', NULL, 'x', 'applied', 5000, 6000)");
    row("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts, decided_at) VALUES ('s-decided', 't-c', '/p', 'p', 'edit', NULL, 'x', 'applied', 5000, 900000)");
    row("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, created_at, updated_at) VALUES ('ar-old', 't-c', 'T', 'html', 'agent', 'index.html', 'text/html', 3, 5000, 5000)");
    row("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, created_at, updated_at) VALUES ('ar-new', 't-c', 'T', 'html', 'agent', 'index.html', 'text/html', 3, 5000, 900000)");
    const [d] = await buildDelta(db, cfg, mark(900_000), "pc1");
    const { delta } = await open(d!.file, root);
    expect((delta.tables.task_evals as Array<{ source: string }>).map((r) => r.source)).toEqual(["new"]);
    expect(delta.tables.check_runs.length).toBe(1);
    expect(ids(delta.tables.staging)).toEqual(["s-decided"]);
    expect(ids(delta.tables.artifacts)).toEqual(["ar-new"]);
  });

  test("an artifact's use as an app (a day counted, a request made from it) goes without its time moving, once, and replaces the row there", async () => {
    const pc = home();
    const here = home();
    pc.db.insertTask(task("t-app", 5_000));
    pc.db.sqlite.query("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, created_at, updated_at) VALUES ('ar-app', 't-app', 'T', 'html', 'agent', 'index.html', 'text/html', 3, 5000, 5000)").run();
    const [first] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 900_000 });
    await applyDelta(here.db, here.cfg, first!.file, PC);
    writeCursor(pc.db, first!.cursor);
    expect(await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 })).toEqual([]);
    expect(pc.db.markArtifactAppUse("ar-app", "2026-11-17")?.counted).toBe(true);
    pc.db.setArtifactAppRequest("ar-app", "t-req");
    expect(pc.db.getArtifact("ar-app")!.updatedAt).toBe(5_000); // the list's order is not moved by a look
    const [second] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 2_000_000 });
    expect(second!.cursor.apps).toEqual({ "ar-app": "1:t-req" });
    await applyDelta(here.db, here.cfg, second!.file, PC);
    expect(here.db.getArtifact("ar-app")).toMatchObject({ appDays: 1, appRequestTaskId: "t-req" });
    writeCursor(pc.db, second!.cursor);
    expect(await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 3_000_000 })).toEqual([]);
  });

  test("a delta that cannot be written takes the ones written before it away", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-big", 5_000));
    for (let i = 0; i < 20; i++) db.appendEventAt("t-big", { t: "status", text: `e${i} ${"x".repeat(400)}` }, 5_000 + i);
    const dir = join(root, "out");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pc1-9000-000001.tar.zst"), "in the way");
    await expect(buildDelta(db, cfg, readCursor(db), "pc1", { maxBytes: 3_000, now: 9_000, dir })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["pc1-9000-000001.tar.zst"]);
  });

  test("an attachment whose folder is a link out of the attachments folder is not sent", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-l", 5_000));
    db.appendEventAt("t-l", { t: "status", text: "start" }, 5_000);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not this machine's to send");
    mkdirSync(cfg.attachmentsDir, { recursive: true });
    symlinkSync(outside, join(cfg.attachmentsDir, "t-l"));
    db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-l', 'secret.txt', 'text/plain', 26, ?, 5000)").run(join(cfg.attachmentsDir, "t-l", "secret.txt"));
    const [d] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 1_000_000 });
    const opened = await open(d!.file, root);
    expect(opened.files).toEqual([]);
    expect(Object.keys(d!.cursor.files)).toEqual([]);
    expect(ids(opened.delta.tables.attachments)).toEqual(["a1"]); // the row goes by its time, as one whose file is refused does
  });

  test("an attachment gone before it is packed is sent again by the next delta", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-g", 5_000));
    db.appendEventAt("t-g", { t: "status", text: "start" }, 5_000);
    const dir = join(cfg.attachmentsDir, "t-g");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "shot.png");
    writeFileSync(path, "png");
    db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-g', 'shot.png', 'image/png', 3, ?, 5000)").run(path);
    const name = "attachments/t-g/shot.png";
    // the file is removed when the mark is asked for it: after its size was taken, before the tar is opened
    const since = readCursor(db);
    since.files = new Proxy({} as Record<string, number>, {
      get(target, key) {
        if (key === name) rmSync(path, { force: true });
        return target[key as string];
      },
    });
    const [first] = await buildDelta(db, cfg, since, "pc1", { now: 1_000_000 });
    expect((await open(first!.file, root)).files).toEqual([]);
    expect(first!.cursor.files[name]).toBeUndefined();
    writeFileSync(path, "png"); // back, the same size
    writeCursor(db, first!.cursor);
    db.appendEventAt("t-g", { t: "status", text: "later" }, 2_000_000);
    const [again] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 2_100_000 });
    expect((await open(again!.file, root)).files).toEqual(["files/attachments/t-g/shot.png"]);
  });

  test("no delta unpacks to more than maxBytes", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-m", 5_000));
    for (let i = 0; i < 30; i++) db.appendEventAt("t-m", { t: "status", text: `e${i} ${"x".repeat(200)}` }, 5_000 + i);
    mkdirSync(join(cfg.artifactsDir, "t-m", "r"), { recursive: true });
    writeFileSync(join(cfg.artifactsDir, "t-m", "r", "a.bin"), "a".repeat(3_000));
    // a name that is not plain ASCII takes a pax record before its header in the tar
    writeFileSync(join(cfg.artifactsDir, "t-m", "r", "スクリーンショット.bin"), "s".repeat(1_000));
    const unpacked = (file: string) => Bun.zstdDecompressSync(readFileSync(file)).length;
    const [whole] = await buildDelta(db, cfg, readCursor(db), "pc1", { now: 9_000 });
    const total = unpacked(whole!.file);
    // the limits are just under the size of all of it unpacked: a delta counted by its rows and file bytes alone would
    // pass them by what the tar adds (headers, padding, delta.json's frame)
    for (const [i, maxBytes] of [total - 4_000, total - 2_000, total - 500, total - 1].entries()) {
      const out = await buildDelta(db, cfg, readCursor(db), "pc1", { maxBytes, now: 10_000 + i });
      expect(out.length).toBeGreaterThan(1);
      for (const d of out) expect(unpacked(d.file)).toBeLessThanOrEqual(maxBytes);
      expect((await Promise.all(out.map((d) => open(d.file, root)))).flatMap((o) => o.files).sort()).toEqual(["files/artifacts/t-m/r/a.bin", "files/artifacts/t-m/r/スクリーンショット.bin"]);
    }
  });

  test("a file bigger than the limit goes in a delta of its own", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-f", 5_000));
    for (let i = 0; i < 5; i++) db.appendEventAt("t-f", { t: "status", text: `e${i} ${"x".repeat(400)}` }, 5_000 + i);
    mkdirSync(join(cfg.artifactsDir, "t-f", "r"), { recursive: true });
    writeFileSync(join(cfg.artifactsDir, "t-f", "r", "big.bin"), "b".repeat(20_000));
    const out = await buildDelta(db, cfg, readCursor(db), "pc1", { maxBytes: 5_000 });
    const opened = await Promise.all(out.map((d) => open(d.file, root)));
    const alone = opened.filter((o) => o.files.includes("files/artifacts/t-f/r/big.bin"));
    expect(alone.length).toBe(1);
    expect(alone[0]!.files).toEqual(["files/artifacts/t-f/r/big.bin"]);
    expect(Object.values(alone[0]!.delta.tables as Record<string, unknown[]>).every((rows) => rows.length === 0)).toBe(true);
  });

  test("a row up to the overlap before the mark is sent again, an older one is not", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-in", 1_000_000 - OVERLAP_MS + 1));
    db.insertTask(task("t-out", 1_000_000 - OVERLAP_MS));
    const [d] = await buildDelta(db, cfg, mark(1_000_000), "pc1");
    expect(ids((await open(d!.file, root)).delta.tables.tasks)).toEqual(["t-in"]);
  });

  test("nothing new makes no file; a Task taken in from another machine is never sent on", async () => {
    const { cfg, db } = home();
    db.insertTask(task("t-here", 5_000));
    db.insertTask(task("t-there", 900_000, { machine: "other" }));
    expect(await buildDelta(db, cfg, mark(500_000), "pc1")).toEqual([]);
    expect(await buildDelta(db, cfg, mark(5_000_000), "pc1")).toEqual([]);
  });

  test("the files of the Task go with it: attachments and reports, only the newer ones; a runner's session file is not sent", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-f", 900_000, { runnerSessionId: "sess1", cwd: "/work/my repo" }));
    db.insertTask(task("t-codex", 900_000, { runner: "codex", runnerSessionId: "cx1" }));
    const at = join(cfg.attachmentsDir, "t-f");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "shot.png"), "png");
    db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-f', 'shot.png', 'image/png', 3, ?, 900000)").run(join(at, "shot.png"));
    db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a2', 't-f', 'passwd', 'text/plain', 3, '/etc/passwd', 900000)").run();
    const art = join(cfg.artifactsDir, "t-f", "r1");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "index.html"), "<p>new</p>");
    writeFileSync(join(art, "stale.html"), "<p>old</p>");
    utimesSync(join(art, "stale.html"), 1, 1); // sent before
    mkdirSync(join(cfg.claudeProjectsDir, "-work-my-repo"), { recursive: true });
    writeFileSync(join(cfg.claudeProjectsDir, "-work-my-repo", "sess1.jsonl"), "{}\n");
    mkdirSync(join(cfg.codexHome, "sessions", "2026", "11", "14"), { recursive: true });
    writeFileSync(join(cfg.codexHome, "sessions", "2026", "11", "14", "rollout-2026-11-14T00-00-00-cx1.jsonl"), "{}\n");
    const [d] = await buildDelta(db, cfg, mark(900_000), "pc1");
    const { files, dir } = await open(d!.file, root);
    expect(files).toEqual(["files/artifacts/t-f/r1/index.html", "files/attachments/t-f/shot.png"]);
    expect(readFileSync(join(dir, "files/artifacts/t-f/r1/index.html"), "utf8")).toBe("<p>new</p>");
  });

  test("a first send is cut at the limit: every event once, the Task row in the first delta only", async () => {
    const { root, cfg, db } = home();
    db.insertTask(task("t-big", 5_000));
    for (let i = 0; i < 40; i++) db.appendEventAt("t-big", { t: "status", text: `e${i} ${"x".repeat(400)}` }, 5_000 + i);
    db.insertTask(task("t-small", 6_000));
    const out = await buildDelta(db, cfg, readCursor(db), "pc1", { maxBytes: 5_000, now: 9_000 });
    expect(out.length).toBeGreaterThan(3);
    expect(out.map((d) => d.deltaId)).toEqual(out.map((_, i) => `pc1-9000-${String(i).padStart(6, "0")}`));
    expect(new Set(out.map((d) => d.cursor.at))).toEqual(new Set([9_000]));
    expect(out[0]!.cursor.seqs).toEqual({ "t-big": 40 });
    const opened = await Promise.all(out.map((d) => open(d.file, root)));
    const seqs = opened.flatMap((o) => (o.delta.tables.events as Array<{ seq: number }>).map((e) => e.seq));
    expect(seqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(opened.flatMap((o) => ids(o.delta.tables.tasks))).toEqual(["t-big", "t-small"]);
    expect(ids(opened[0]!.delta.tables.tasks)).toEqual(["t-big"]);
  });

  test("repos maps each workspace to its GitHub repository, null for one without", async () => {
    const { root, cfg, db } = home();
    const a = db.upsertWorkspace({ path: "/w/a", name: "a", kind: "repo" });
    const b = db.upsertWorkspace({ path: "/w/b", name: "b", kind: "repo" });
    db.setWorkspaceBacklogSource(a.id, { service: "github", host: "github.com", repository: "me/a-repo" } as never);
    db.insertTask(task("t-r", 5_000));
    const [d] = await buildDelta(db, cfg, readCursor(db), "pc1");
    expect((await open(d!.file, root)).delta.repos).toEqual({ [a.id]: "me/a-repo", [b.id]: null });
  });

  test("a machine name that is not a file name is refused", async () => {
    const { cfg, db } = home();
    await expect(buildDelta(db, cfg, readCursor(db), "../x")).rejects.toThrow("not usable");
  });
});

describe("cursor", () => {
  test("starts at nothing sent, and moves only when written", () => {
    const { db } = home();
    expect(readCursor(db)).toEqual(mark(0));
    writeCursor(db, mark(12_345, { ledger: 4, seqs: { t1: 9 } }));
    expect(readCursor(db)).toEqual(mark(12_345, { ledger: 4, seqs: { t1: 9 } }));
    expect(db.getSetting<Cursor | null>("uplink.cursor", null)).toEqual(mark(12_345, { ledger: 4, seqs: { t1: 9 } }));
  });
});

describe("writeTarZst", () => {
  test("a file that is gone when its turn comes is left out; the rest is written", async () => {
    const dir = mkdtempSync(join(tmp, "tar-"));
    writeFileSync(join(dir, "here.txt"), "here");
    const out = join(dir, "a.tar.zst");
    await writeTarZst(out, [{ name: "gone.txt", path: join(dir, "gone.txt") }, { name: "here.txt", path: join(dir, "here.txt") }]);
    const un = join(dir, "un");
    mkdirSync(un);
    await new Bun.Archive(Bun.zstdDecompressSync(readFileSync(out))).extract(un);
    expect(readdirSync(un)).toEqual(["here.txt"]);
  });

  test("a file that shrinks while it is packed fails the write and leaves no partial file", async () => {
    const dir = mkdtempSync(join(tmp, "tar-"));
    const path = join(dir, "big.bin");
    writeFileSync(path, "0123456789");
    // the name is read for the header, after the size was taken: the file is cut there
    const entry = {
      path,
      get name() {
        truncateSync(path, 0);
        return "big.bin";
      },
    };
    const out = join(dir, "b.tar.zst");
    await expect(writeTarZst(out, [entry])).rejects.toThrow("shrank");
    expect(existsSync(out)).toBe(false);
  });
});

/** Every table's rows as the database has them (settings included): what "the same" means below. */
function snapshot(db: Db, cfg: { home: string }): Record<string, string> {
  const names = (db.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return Object.fromEntries(names.map((t) => [t, new Bun.CryptoHasher("sha256").update(JSON.stringify((db.sqlite.query(`SELECT * FROM ${t}`).all() as unknown[]).map((r) => JSON.stringify(r).replaceAll(cfg.home, "HOME")).sort())).digest("hex")]));
}

/** A work machine with one Task of every kind of row, a workspace for `me/repo`, and the files of the Task. */
function pcWithTask(ts = 900_000) {
  const h = home();
  const ws = h.db.upsertWorkspace({ path: "/pc/repo", name: "repo", kind: "repo" });
  h.db.setWorkspaceBacklogSource(ws.id, { service: "github", host: "github.com", repository: "me/repo" } as never);
  h.db.insertTask(task("t-1", ts, { workspaceId: ws.id, title: "#12 do it", runnerSessionId: "sess1", cwd: "/work/repo" }));
  for (let i = 0; i < 5; i++) h.db.appendEventAt("t-1", { t: "status", text: `e${i}` }, ts + i);
  ledger(h.db, "t-1", ts);
  ledger(h.db, "t-1", ts + 1);
  h.db.sqlite.query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_model, chosen_model) VALUES ('t-1', ?, '/work/repo', 'claude', 'r', 'why', 'claude', ?, 'claude-haiku-5-5', 'claude-fable-5-2')").run(ws.id, ts);
  h.db.sqlite.query("INSERT INTO task_evals (task_id, source, by, rubric, json, ts) VALUES ('t-1', 'rule', 'r', NULL, '{}', ?)").run(ts);
  h.db.sqlite.query("INSERT INTO check_runs (task_id, ok, json, ts) VALUES ('t-1', 1, '{}', ?)").run(ts);
  h.db.sqlite.query("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts, decided_at) VALUES ('s1', 't-1', '/p', 'p', 'edit', NULL, 'x', 'applied', ?, ?)").run(ts, ts);
  h.db.sqlite.query("INSERT INTO staging (id, task_id, path, rel, kind, before_text, after_text, status, ts) VALUES ('s2', 't-1', '/q', 'q', 'edit', NULL, 'y', 'pending', ?)").run(ts); // the work machine's to decide
  h.db.sqlite.query("INSERT INTO artifacts (id, task_id, title, kind, source, entry, mime, size, created_at, updated_at) VALUES ('ar1', 't-1', 'T', 'html', 'agent', 'index.html', 'text/html', 3, ?, ?)").run(ts, ts);
  const at = join(h.cfg.attachmentsDir, "t-1");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "shot.png"), "png");
  h.db.sqlite.query("INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-1', 'shot.png', 'image/png', 3, ?, ?)").run(join(at, "shot.png"), ts);
  mkdirSync(join(h.cfg.artifactsDir, "t-1", "ar1"), { recursive: true });
  writeFileSync(join(h.cfg.artifactsDir, "t-1", "ar1", "index.html"), "<p>x</p>");
  mkdirSync(join(h.cfg.claudeProjectsDir, "-work-repo"), { recursive: true });
  writeFileSync(join(h.cfg.claudeProjectsDir, "-work-repo", "sess1.jsonl"), "{}\n");
  return { ...h, ws };
}

/** An instance of its own with a workspace for `me/repo` under another id than the work machine's. */
function instance() {
  const h = home();
  const ws = h.db.upsertWorkspace({ id: "ws-here", path: "/srv/repo", name: "repo", kind: "repo" });
  h.db.setWorkspaceBacklogSource(ws.id, { service: "github", host: "github.com", repository: "Me/Repo" } as never);
  h.db.insertTask(task("t-own", 800_000, { title: "#12 its own", workspaceId: ws.id }));
  return { ...h, ws };
}

describe("applyDelta", () => {
  test("routing_log models: the proposed and the started model of a row come over with it", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(here.db.sqlite.query("SELECT suggested_model, chosen_model FROM routing_log").all()).toEqual([{ suggested_model: "claude-haiku-5-5", chosen_model: "claude-fable-5-2" }]);
    expect(here.db.routingLog()[0]).toMatchObject({ suggestedModel: "claude-haiku-5-5", chosenModel: "claude-fable-5-2" });
  });

  test("taking a delta in twice changes no row and no value, and every table has what the Task has", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    const first = await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(first).toMatchObject({ status: "applied", deltaId: d!.deltaId, machine: "pc1", rows: { tasks: 1, events: 5, ledger: 2, routing_log: 1, task_evals: 1, check_runs: 1, staging: 1, artifacts: 1, attachments: 1 }, files: 2 });
    const after = snapshot(here.db, here.cfg);
    const again = await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(again).toMatchObject({ status: "applied", rows: { tasks: 0, events: 0, ledger: 0, routing_log: 0, task_evals: 0, check_runs: 0, staging: 0, artifacts: 0, attachments: 0 }, files: 0 });
    expect(snapshot(here.db, here.cfg)).toEqual(after);
    expect(listApplied(here.db)).toEqual([d!.deltaId]);
    const q = (sql: string) => here.db.sqlite.query(sql).all() as Array<Record<string, unknown>>;
    expect(q("SELECT id, machine, workspace_id FROM tasks ORDER BY id")).toEqual([
      { id: "t-1", machine: "pc1", workspace_id: here.ws.id },
      { id: "t-own", machine: null, workspace_id: here.ws.id },
    ]);
    expect(q("SELECT id, task_id, src_id FROM ledger ORDER BY id")).toEqual([
      { id: 1, task_id: "t-1", src_id: 1 },
      { id: 2, task_id: "t-1", src_id: 2 },
    ]);
    expect(q("SELECT workspace_id, src_id FROM routing_log")).toEqual([{ workspace_id: here.ws.id, src_id: 1 }]);
    expect(q("SELECT path FROM attachments")).toEqual([{ path: join(here.cfg.attachmentsDir, "t-1", "shot.png") }]);
    expect(readFileSync(join(here.cfg.attachmentsDir, "t-1", "shot.png"), "utf8")).toBe("png");
    expect(readFileSync(join(here.cfg.artifactsDir, "t-1", "ar1", "index.html"), "utf8")).toBe("<p>x</p>");
    // nothing of a delta is ever written to a runner's folder
    expect(existsSync(here.cfg.claudeProjectsDir)).toBe(false);
    expect(existsSync(here.cfg.codexHome)).toBe(false);
  });

  test("quota: a work machine's usage limits come in by account — the newer report stays, an older one changes nothing, twice adds no row", async () => {
    const pc = pcWithTask();
    const here = instance();
    const quota = () => here.db.quotaAll().map((q) => [q.runner, q.account, q.window, q.utilization, q.ts]);
    // the same account on both machines: the instance heard it later than the work machine did
    here.db.upsertQuota("claude", "five_hour", 0.5, 100, 2_000, "5a3eacc000000000");
    pc.db.upsertQuota("claude", "five_hour", 0.3, 100, 1_000, "5a3eacc000000000");
    // an account only the work machine uses
    pc.db.upsertQuota("claude", "five_hour", 0.8, 300, 1_500, "0cacc00000000000");
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    const { delta } = await open(d!.file, pc.root);
    expect(delta.tables.quota_by_account).toHaveLength(2);
    expect(await applyDelta(here.db, here.cfg, d!.file, PC)).toMatchObject({ status: "applied", rows: { quota_by_account: 1 } });
    const taken = [["claude", "0cacc00000000000", "five_hour", 0.8, 1_500], ["claude", "5a3eacc000000000", "five_hour", 0.5, 2_000]];
    expect(quota()).toEqual(taken); // two accounts, two rows; the older report of the shared one changed nothing
    expect(await applyDelta(here.db, here.cfg, d!.file, PC)).toMatchObject({ rows: { quota_by_account: 0 } });
    expect(quota()).toEqual(taken);
    // a newer report from the work machine replaces the instance's
    pc.db.upsertQuota("claude", "five_hour", 0.9, 100, 3_000, "5a3eacc000000000");
    pc.db.appendEventAt("t-1", { t: "status", text: "the turn that reported it" }, 3_000);
    const [d2] = await buildDelta(pc.db, pc.cfg, d!.cursor, "pc1", { now: d!.cursor.at + 1 });
    await applyDelta(here.db, here.cfg, d2!.file, PC);
    expect(quota()).toEqual([taken[0]!, ["claude", "5a3eacc000000000", "five_hour", 0.9, 3_000]]);
  });

  test("a ledger row of the instance's own does not collide with one taken in (the instance's ids, the sender's in src_id)", async () => {
    const pc = pcWithTask();
    const here = instance();
    ledger(here.db, "t-own", 1_000); // id 1 here
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(here.db.sqlite.query("SELECT id, task_id, src_id FROM ledger ORDER BY id").all()).toEqual([
      { id: 1, task_id: "t-own", src_id: null },
      { id: 2, task_id: "t-1", src_id: 1 },
      { id: 3, task_id: "t-1", src_id: 2 },
    ]);
  });

  test("a newer row of a Task, an eval or a check run replaces the older, an older one does not replace the newer", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d1] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 });
    await applyDelta(here.db, here.cfg, d1!.file, PC);
    pc.db.sqlite.query("UPDATE tasks SET title = 'later', updated_at = 2_000_000 WHERE id = 't-1'").run();
    pc.db.sqlite.query("UPDATE task_evals SET json = '{\"v\":2}', ts = 2_000_000").run();
    pc.db.sqlite.query("UPDATE check_runs SET ok = 0, ts = 2_000_000").run();
    const [d2] = await buildDelta(pc.db, pc.cfg, d1!.cursor, "pc1", { now: 2_100_000 });
    await applyDelta(here.db, here.cfg, d2!.file, PC);
    const read = () => ({ t: here.db.sqlite.query("SELECT title FROM tasks WHERE id = 't-1'").get(), e: here.db.sqlite.query("SELECT json FROM task_evals").get(), c: here.db.sqlite.query("SELECT ok FROM check_runs").get() });
    expect(read()).toEqual({ t: { title: "later" }, e: { json: '{"v":2}' }, c: { ok: 0 } });
    await applyDelta(here.db, here.cfg, d1!.file, PC); // the first one again, after the second
    expect(read()).toEqual({ t: { title: "later" }, e: { json: '{"v":2}' }, c: { ok: 0 } });
  });

  test("the Task is on the workspace here that reads the same repository, and the flow's Task cost finds it", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    expect(tasksOfIssues(here.db.sqlite, [12], [here.ws.id]).map((t) => t.id)).toEqual(["t-own"]);
    await applyDelta(here.db, here.cfg, d!.file, PC);
    const found = tasksOfIssues(here.db.sqlite, [12], [here.ws.id]);
    expect(found.map((t) => t.id).sort()).toEqual(["t-1", "t-own"]);
    expect(found.find((t) => t.id === "t-1")!.costUsd).toBe(1); // its two ledger rows
  });

  test("a workspace with no repository here, or none at all, leaves the Task with no workspace; the Task still comes in", async () => {
    const pc = pcWithTask();
    const other = home();
    other.db.upsertWorkspace({ path: "/srv/other", name: "o", kind: "repo" }); // no backlog source
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    expect(remapWorkspaces(other.db, { w1: "me/repo", w2: null })).toEqual({ w1: null, w2: null });
    await applyDelta(other.db, other.cfg, d!.file, PC);
    expect(other.db.sqlite.query("SELECT workspace_id, machine FROM tasks").all()).toEqual([{ workspace_id: null, machine: "pc1" }]);
  });

  test("a delta from a newer database puts nothing in and leaves its reason; the rest of the state is the same", async () => {
    const pc = pcWithTask();
    const here = instance();
    const before = snapshot(here.db, here.cfg);
    const [built] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    // the same delta as newer code writes it: one more column than this code knows
    const { delta: head, files, dir } = await open(built!.file, pc.root);
    const d = { deltaId: built!.deltaId, file: join(pc.root, "newer.tar.zst") };
    await writeTarZst(d.file, [{ name: "delta.json", bytes: Buffer.from(JSON.stringify({ ...head, schemaLevel: schemaLevel() + 1 })) }, ...files.map((f) => ({ name: f, path: join(dir, f) }))]);
    const r = await applyDelta(here.db, here.cfg, d.file, PC, { now: 77 });
    expect(r.status).toBe("skipped");
    expect(r.status === "skipped" && r.reason).toContain("left out");
    expect(listSkipped(here.db)).toEqual([{ machine: "pc1", deltaId: d!.deltaId, theirs: schemaLevel() + 1, ours: schemaLevel(), at: 77 }]);
    await applyDelta(here.db, here.cfg, d!.file, PC, { now: 78 }); // again: one entry per delta
    expect(listSkipped(here.db).length).toBe(1);
    expect(listApplied(here.db)).toEqual([]);
    expect(existsSync(join(here.cfg.claudeProjectsDir, "-work-repo"))).toBe(false);
    const { settings: a, ...rest } = snapshot(here.db, here.cfg);
    const { settings: b, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(a).not.toBe(b);
  });

  test("deltas laid down while the instance was stopped go in by their ids and end as one delta of everything would", async () => {
    const pc = pcWithTask(500_000);
    const [d1] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 });
    for (let i = 0; i < 4; i++) pc.db.appendEventAt("t-1", { t: "status", text: `l${i}` }, 2_000_000 + i);
    ledger(pc.db, "t-1", 2_000_000);
    pc.db.sqlite.query("UPDATE tasks SET title = 'second', updated_at = 2_000_000 WHERE id = 't-1'").run();
    const [d2] = await buildDelta(pc.db, pc.cfg, d1!.cursor, "pc1", { now: 2_100_000 });
    pc.db.insertTask(task("t-2", 3_000_000));
    pc.db.appendEventAt("t-2", { t: "status", text: "n" }, 3_000_000);
    pc.db.sqlite.query("UPDATE tasks SET title = 'third', updated_at = 3_000_000 WHERE id = 't-1'").run();
    const [d3] = await buildDelta(pc.db, pc.cfg, d2!.cursor, "pc1", { now: 3_100_000 });
    const [whole] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 4_000_000, dir: join(pc.root, "whole") });
    const stepwise = instance();
    for (const d of [d1!, d2!, d3!]) await applyDelta(stepwise.db, stepwise.cfg, d.file, PC);
    const once = instance();
    await applyDelta(once.db, once.cfg, whole!.file, PC);
    const { settings: s1, workspaces: w1, ...a } = snapshot(stepwise.db, stepwise.cfg);
    const { settings: s2, workspaces: w2, ...b } = snapshot(once.db, once.cfg);
    expect(a).toEqual(b);
    expect(listApplied(stepwise.db)).toEqual([d1!.deltaId, d2!.deltaId, d3!.deltaId]);
    expect(stepwise.db.sqlite.query("SELECT title FROM tasks WHERE id = 't-1'").get()).toEqual({ title: "third" });
    expect((stepwise.db.sqlite.query("SELECT count(*) AS n FROM events WHERE task_id = 't-1'").get() as { n: number }).n).toBe(9);
  });

  test("a delta cannot put a file in a runner's folder: a memory file or a session file under the runner's projects refuses the delta, and nothing is written", async () => {
    const here = instance();
    const memory = join(here.cfg.claudeProjectsDir, "-srv-repo", "memory", "MEMORY.md");
    mkdirSync(join(here.cfg.claudeProjectsDir, "-srv-repo", "memory"), { recursive: true });
    writeFileSync(memory, "mine\n");
    const before = snapshot(here.db, here.cfg);
    const head = (id: string) => Buffer.from(JSON.stringify({ machine: "pc1", deltaId: id, schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [], events: [] } }));
    for (const [i, name] of ["files/sessions/claude/-srv-repo/memory/MEMORY.md", "files/sessions/claude/-srv-repo/0b0e7a1c-1111-4222-8333-444455556666.jsonl", "files/sessions/codex/2026/11/14/rollout-2026-11-14T00-00-00-0b0e7a1c-1111-4222-8333-444455556666.jsonl", "files/attachments/t-1/../../../../claude/-srv-repo/memory/MEMORY.md", "files/artifacts/t-1/ar1/.claude/settings.json", "files/attachments/inbox/x.png"].entries()) {
      const file = join(here.root, `runner-${n++}.tar.zst`);
      await writeTarZst(file, [{ name: "delta.json", bytes: head(`pc1-${i + 1}-000000`) }, { name, bytes: Buffer.from("theirs, and longer than what is there\n") }]);
      await expect(applyDelta(here.db, here.cfg, file, PC)).rejects.toThrow(/not a place a delta writes to|names no Task|not a plain file name|not the shape/);
    }
    expect(readFileSync(memory, "utf8")).toBe("mine\n");
    expect((readdirSync(here.cfg.claudeProjectsDir, { recursive: true }) as string[]).sort()).toEqual(["-srv-repo", "-srv-repo/memory", "-srv-repo/memory/MEMORY.md"]);
    expect(existsSync(here.cfg.codexHome)).toBe(false);
    expect(existsSync(here.cfg.attachmentsDir) ? readdirSync(here.cfg.attachmentsDir) : []).toEqual([]);
    expect(snapshot(here.db, here.cfg)).toEqual(before);
  });

  test("an artifact's file that changed in place (same size) is written", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    writeFileSync(join(pc.cfg.artifactsDir, "t-1", "ar1", "index.html"), "<p>y</p>");
    const [d2] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: Date.now() + 1, dir: join(pc.root, "again") });
    await applyDelta(here.db, here.cfg, d2!.file, PC);
    expect(readFileSync(join(here.cfg.artifactsDir, "t-1", "ar1", "index.html"), "utf8")).toBe("<p>y</p>");
  });

  test("a Task in flight on the work machine comes in idle with nothing this instance acts on: start-up, resume and the queue leave it", async () => {
    const pc = pcWithTask();
    pc.db.sqlite.query("UPDATE tasks SET status = 'running', resume_at = 5, resume_reason = 'limit', queued_at = 4, judging_at = 3 WHERE id = 't-1'").run();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(here.db.sqlite.query("SELECT status, resume_at, resume_reason, queued_at, judging_at, updated_at FROM tasks WHERE id = 't-1'").get()).toEqual({ status: "idle", resume_at: null, resume_reason: null, queued_at: null, judging_at: null, updated_at: 900_000 });
    expect(abortOrphanedTasks(here.db)).toEqual([]);
    expect(here.db.listTasksWithResume()).toEqual([]);
    expect(here.db.listQueuedTasks()).toEqual([]);
  });

  test("a Task that is this instance's own is left as it is, with its rows and files, when a work machine sends it back", async () => {
    const pc = pcWithTask();
    const here = instance();
    here.db.sqlite.query("UPDATE tasks SET runner_session_id = 'sess-own', cwd = '/work/repo' WHERE id = 't-own'").run();
    pc.db.insertTask(task("t-own", 950_000, { title: "sent back", runnerSessionId: "sess-own" })); // the work machine's database came from this one
    pc.db.appendEventAt("t-own", { t: "status", text: "x" }, 950_000);
    ledger(pc.db, "t-own", 950_000);
    mkdirSync(join(pc.cfg.artifactsDir, "t-own", "r"), { recursive: true });
    writeFileSync(join(pc.cfg.artifactsDir, "t-own", "r", "index.html"), "theirs");
    const before = here.db.sqlite.query("SELECT * FROM tasks WHERE id = 't-own'").get();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(here.db.sqlite.query("SELECT * FROM tasks WHERE id = 't-own'").get()).toEqual(before);
    expect(here.db.sqlite.query("SELECT count(*) AS n FROM events WHERE task_id = 't-own'").get()).toEqual({ n: 0 });
    expect(here.db.sqlite.query("SELECT count(*) AS n FROM ledger WHERE task_id = 't-own'").get()).toEqual({ n: 0 });
    expect(existsSync(join(here.cfg.artifactsDir, "t-own"))).toBe(false);
    expect(here.db.getTask("t-1")?.machine).toBe("pc1"); // the rest of the delta came in
  });

  test("a change waiting for its approval does not come in; once decided it does", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 });
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(here.db.sqlite.query("SELECT id, status FROM staging ORDER BY id").all()).toEqual([{ id: "s1", status: "applied" }]);
    pc.db.sqlite.query("UPDATE staging SET status = 'rejected', decided_at = 2000000 WHERE id = 's2'").run();
    const [d2] = await buildDelta(pc.db, pc.cfg, d!.cursor, "pc1", { now: 2_100_000 });
    await applyDelta(here.db, here.cfg, d2!.file, PC);
    expect(here.db.sqlite.query("SELECT id, status FROM staging ORDER BY id").all()).toEqual([{ id: "s1", status: "applied" }, { id: "s2", status: "rejected" }]);
  });

  test("a delta of files alone does not write over the files of a Task that is this instance's own", async () => {
    const here = instance();
    mkdirSync(join(here.cfg.attachmentsDir, "t-own"), { recursive: true });
    writeFileSync(join(here.cfg.attachmentsDir, "t-own", "shot.png"), "mine");
    const head = Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [], events: [] } }));
    const file = join(here.root, `files-only-${n++}.tar.zst`);
    await writeTarZst(file, [{ name: "delta.json", bytes: head }, { name: "files/attachments/t-own/shot.png", bytes: Buffer.from("theirs") }, { name: "files/artifacts/t-own/r/index.html", bytes: Buffer.from("x") }]);
    const r = await applyDelta(here.db, here.cfg, file, PC);
    expect(r.status === "applied" && r.files).toBe(0);
    expect(readFileSync(join(here.cfg.attachmentsDir, "t-own", "shot.png"), "utf8")).toBe("mine");
    expect(existsSync(join(here.cfg.artifactsDir, "t-own"))).toBe(false);
  });

  test("a folder on the way that is a link out refuses the delta before any file is placed", async () => {
    const here = instance();
    const outside = join(tmp, `outside-${n++}`);
    mkdirSync(outside);
    mkdirSync(here.cfg.artifactsDir, { recursive: true });
    symlinkSync(outside, join(here.cfg.artifactsDir, "t-x"));
    const head = Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [{ id: "t-a" }, { id: "t-x" }], events: [] } }));
    const file = join(outside, "..", `linked-${n++}.tar.zst`);
    await writeTarZst(file, [{ name: "delta.json", bytes: head }, { name: "files/artifacts/t-a/r/ok.txt", bytes: Buffer.from("x") }, { name: "files/artifacts/t-x/deep/in.txt", bytes: Buffer.from("x") }]);
    await expect(applyDelta(here.db, here.cfg, file, PC)).rejects.toThrow("behind a link");
    expect(existsSync(join(here.cfg.artifactsDir, "t-a"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a stale temp link next to a file is not written through", async () => {
    const pc = pcWithTask();
    const here = instance();
    const outside = join(tmp, `outside-${n++}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.txt"), "mine");
    mkdirSync(join(here.cfg.attachmentsDir, "t-1"), { recursive: true });
    symlinkSync(join(outside, "victim.txt"), join(here.cfg.attachmentsDir, "t-1", `.tmp-${process.pid}-shot.png`));
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(here.cfg.attachmentsDir, "t-1", "shot.png"), "utf8")).toBe("png");
  });

  test("an older delta taken in again does not put back an artifact's older file", async () => {
    const pc = pcWithTask();
    const here = instance();
    const file = join(here.cfg.artifactsDir, "t-1", "ar1", "index.html");
    const [d1] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 });
    writeFileSync(join(pc.cfg.artifactsDir, "t-1", "ar1", "index.html"), "<p>new</p>");
    pc.db.sqlite.query("UPDATE artifacts SET updated_at = 950000 WHERE id = 'ar1'").run();
    const [d2] = await buildDelta(pc.db, pc.cfg, d1!.cursor, "pc1", { now: Date.now() + 1, dir: join(pc.root, "again") });
    await applyDelta(here.db, here.cfg, d1!.file, PC);
    await applyDelta(here.db, here.cfg, d2!.file, PC);
    expect(readFileSync(file, "utf8")).toBe("<p>new</p>");
    await applyDelta(here.db, here.cfg, d1!.file, PC);
    expect(here.db.sqlite.query("SELECT updated_at FROM artifacts WHERE id = 'ar1'").get()).toEqual({ updated_at: 950_000 });
    expect(readFileSync(file, "utf8")).toBe("<p>new</p>");
  });

  test("an artifact's file whose row the delta does not bring is not placed when the row here is newer than the delta", async () => {
    const pc = pcWithTask();
    const here = instance();
    const [d1] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { now: 1_000_000 });
    await applyDelta(here.db, here.cfg, d1!.file, PC);
    const head = Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-2-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [], events: [] } }));
    const file = join(here.root, `rowless-${n++}.tar.zst`);
    await writeTarZst(file, [{ name: "delta.json", bytes: head }, { name: "files/artifacts/t-1/ar1/index.html", bytes: Buffer.from("<p>rowless</p>") }]);
    const r = await applyDelta(here.db, here.cfg, file, PC);
    expect(r.status === "applied" && r.files).toBe(0);
    expect(readFileSync(join(here.cfg.artifactsDir, "t-1", "ar1", "index.html"), "utf8")).toBe("<p>x</p>");
  });

  test("a send cut into several deltas places an artifact's file that comes without its row", async () => {
    const pc = pcWithTask();
    const here = instance();
    const big = "<p>" + "b".repeat(20_000) + "</p>";
    writeFileSync(join(pc.cfg.artifactsDir, "t-1", "ar1", "index.html"), big);
    const parts = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { maxBytes: 5_000 });
    const opened = await Promise.all(parts.map((d) => open(d.file, here.root)));
    const rowAt = opened.findIndex((o) => (o.delta as { tables: { artifacts?: unknown[] } }).tables.artifacts?.length);
    const fileAt = opened.findIndex((o) => o.files.includes("files/artifacts/t-1/ar1/index.html"));
    expect(rowAt).toBeLessThan(fileAt);
    for (const d of parts) await applyDelta(here.db, here.cfg, d.file, PC);
    expect(readFileSync(join(here.cfg.artifactsDir, "t-1", "ar1", "index.html"), "utf8")).toBe(big);
  });

  test("an attachment row with .. in task_id is refused", async () => {
    const here = instance();
    const row = { id: "a-evil", task_id: "..", name: "switchboard.db", mime: "x/y", size: 1, path: "/x/switchboard.db", created_at: 1 };
    const head = Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [], events: [], attachments: [row] } }));
    const file = join(here.root, `dotdot-${n++}.tar.zst`);
    await writeTarZst(file, [{ name: "delta.json", bytes: head }]);
    await expect(applyDelta(here.db, here.cfg, file, PC)).rejects.toThrow();
    expect(here.db.sqlite.query("SELECT count(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  });

  test("a link in the store to a local Task's folder is not written through", async () => {
    const here = instance();
    mkdirSync(join(here.cfg.attachmentsDir, "t-own"), { recursive: true });
    writeFileSync(join(here.cfg.attachmentsDir, "t-own", "shot.png"), "mine");
    symlinkSync(join(here.cfg.attachmentsDir, "t-own"), join(here.cfg.attachmentsDir, "alias"));
    const head = Buffer.from(JSON.stringify({ machine: "pc1", deltaId: "pc1-1-000000", schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [{ id: "alias" }], events: [] } }));
    const file = join(here.root, `alias-${n++}.tar.zst`);
    await writeTarZst(file, [{ name: "delta.json", bytes: head }, { name: "files/attachments/alias/shot.png", bytes: Buffer.from("theirs") }]);
    await expect(applyDelta(here.db, here.cfg, file, PC)).rejects.toThrow("behind a link");
    expect(readFileSync(join(here.cfg.attachmentsDir, "t-own", "shot.png"), "utf8")).toBe("mine");
  });

  test("what a process that is gone left unpacked is removed; a living one's stays", async () => {
    const pc = pcWithTask();
    const here = instance();
    const gone = join(here.cfg.home, "uplink-in-2147483646-1");
    const living = join(here.cfg.home, `uplink-in-${process.ppid}-1`);
    mkdirSync(gone);
    mkdirSync(living);
    const [d] = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1");
    await applyDelta(here.db, here.cfg, d!.file, PC);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(living)).toBe(true);
  });

  test("a name that leaves its folder, or a place a delta may not write to, refuses the delta whole: nothing is placed and no row is written", async () => {
    const here = instance();
    const head = (id: string) => Buffer.from(JSON.stringify({ machine: "pc1", deltaId: id, schemaLevel: schemaLevel(), createdAt: 1, repos: {}, tables: { tasks: [{ id: "t-ok" }], events: [] } }));
    const evil = join(tmp, `evil-${n++}`);
    mkdirSync(evil);
    const before = snapshot(here.db, here.cfg);
    const escaping = join(evil, "a.tar.zst");
    await writeTarZst(escaping, [{ name: "delta.json", bytes: head("pc1-1-000000") }, { name: "files/artifacts/t-ok/r/ok.txt", bytes: Buffer.from("x") }, { name: "files/artifacts/../../../escaped.txt", bytes: Buffer.from("x") }]);
    await expect(applyDelta(here.db, here.cfg, escaping, PC)).rejects.toThrow("names no Task");
    expect(existsSync(join(here.cfg.home, "escaped.txt")) || existsSync(join(tmp, "escaped.txt")) || existsSync(join(here.root, "escaped.txt"))).toBe(false);
    const elsewhere = join(evil, "b.tar.zst");
    await writeTarZst(elsewhere, [{ name: "delta.json", bytes: head("pc1-2-000000") }, { name: "files/artifacts/t-ok/r/ok.txt", bytes: Buffer.from("x") }, { name: "files/etc/passwd", bytes: Buffer.from("x") }]);
    await expect(applyDelta(here.db, here.cfg, elsewhere, PC)).rejects.toThrow("not a place");
    const absolute = join(evil, "c.tar.zst");
    await writeTarZst(absolute, [{ name: "delta.json", bytes: head("pc1-3-000000") }, { name: "/etc/cron.d/x", bytes: Buffer.from("x") }]);
    await expect(applyDelta(here.db, here.cfg, absolute, PC)).rejects.toThrow("not a place");
    expect(existsSync(join(here.cfg.artifactsDir, "t-ok"))).toBe(false); // nothing was placed
    expect(snapshot(here.db, here.cfg)).toEqual(before);
  });

  test("a big first send goes in: every Task and event, events in batches, the log of the database kept small", async () => {
    const pc = home();
    const here = instance();
    const tasks = 200;
    const per = 750; // a tenth of a copy of the real data (2,000 Tasks, 1.5 million events); the full size is measured by hand
    pc.db.sqlite.transaction(() => {
      for (let i = 0; i < tasks; i++) {
        pc.db.insertTask(task(`t${String(i).padStart(4, "0")}`, 5_000 + i));
        const q = pc.db.sqlite.query("INSERT INTO events (task_id, seq, ts, json) VALUES (?, ?, ?, ?)");
        for (let s = 1; s <= per; s++) q.run(`t${String(i).padStart(4, "0")}`, s, 5_000 + i, `{"t":"status","text":"event ${s} ${"x".repeat(60)}"}`);
      }
    })();
    const built = await buildDelta(pc.db, pc.cfg, readCursor(pc.db), "pc1", { maxBytes: 8 * 1024 * 1024 });
    expect(built.length).toBeGreaterThan(1);
    const started = performance.now();
    for (const d of built) await applyDelta(here.db, here.cfg, d.file, PC, { eventBatch: 10_000 });
    const ms = performance.now() - started;
    expect(here.db.sqlite.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: tasks * per });
    expect(here.db.sqlite.query("SELECT count(*) AS n FROM tasks WHERE machine = 'pc1'").get()).toEqual({ n: tasks });
    expect(ms).toBeLessThan(60_000);
    expect(statSync(`${here.cfg.dbPath}-wal`).size).toBeLessThan(64 * 1024 * 1024);
  });
});
