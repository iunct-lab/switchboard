import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Task, TaskStatus } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { commitEventsArchive, EVENTS_ARCHIVE_DAYS, prepareEventsArchive, type ManifestEntry } from "./events-archive.ts";
import { ruleMetrics } from "./evals.ts";

const tmp = mkdtempSync(join(tmpdir(), "sb-events-archive-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - (EVENTS_ARCHIVE_DAYS + 1) * DAY;

function task(id: string, status: TaskStatus, updatedAt: number): Task {
  return { id, workspaceId: null, title: id, runner: "claude", cwd: "/w", scope: ["/w"], status, runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: updatedAt - 10_000, createdAt: updatedAt - 10_000, updatedAt };
}

const BIG = "x".repeat(2_000);

/** A task whose conversation has every kind of event; `end` is the time of its last one. */
function seed(db: Db, id: string, status: TaskStatus, end: number, opts: { endsOnAssistant?: boolean } = {}) {
  db.insertTask(task(id, status, end));
  const evs: AgentEvent[] = [
    { t: "session.start", runner: "claude", cwd: "/w" },
    { t: "message.delta", role: "user", text: "do it", messageId: "u1" },
    { t: "message.delta", role: "assistant", text: "I will ", messageId: "a1" },
    { t: "message.delta", role: "assistant", text: BIG, messageId: "a1" },
    { t: "tool.call", id: "c1", name: "Bash", input: { command: BIG }, summary: BIG },
    { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: {}, detail: "ls" },
    { t: "permission.resolved", id: "p1", decision: "deny", by: "user" },
    { t: "tool.result", id: "c1", ok: false, summary: BIG },
    { t: "message.delta", role: "assistant", text: "failed", messageId: "a2" },
    { t: "session.end", status: "ok", summary: "last reply" },
    { t: "message.delta", role: "user", text: "again", messageId: "u2" },
    { t: "message.delta", role: "assistant", text: BIG, messageId: "a3" },
    { t: "message.delta", role: "assistant", text: BIG, messageId: "a3" },
  ];
  if (!opts.endsOnAssistant) evs.push({ t: "session.end", status: "ok", summary: "final" });
  evs.forEach((ev, i) => db.appendEventAt(id, ev, end - (evs.length - 1 - i) * 100));
  db.insertLedger({ taskId: id, runner: "claude", model: null, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 0.5, billedUsd: 0.5, source: "reported", ts: end });
  db.upsertEval({ taskId: id, source: "human", by: "u", rubric: null, json: { rating: 4 }, ts: end });
}

const open = (name: string) => new Db(join(tmp, `${name}.db`));
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ManifestEntry[];
const upload = (entries: ManifestEntry[]) => new Map(entries.map((e) => [e.taskId, `history/events/2026/${e.file}`]));

describe("events archive", () => {
  test("prepare writes one file per old finished task and skips running and recent ones", async () => {
    const db = open("prepare");
    seed(db, "old-done", "done", LONG_AGO);
    seed(db, "old-error", "error", LONG_AGO);
    seed(db, "old-running", "running", LONG_AGO);
    seed(db, "recent", "done", NOW - DAY);
    const dir = join(tmp, "prepare-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    expect(entries.map((e) => e.taskId).sort()).toEqual(["old-done", "old-error"]);
    const e = entries.find((x) => x.taskId === "old-done")!;
    expect(e.count).toBe(db.listEvents("old-done").length);
    expect(e.maxSeq).toBe(e.count);
    const lines = new TextDecoder().decode(Bun.zstdDecompressSync(readFileSync(join(dir, e.file)))).trim().split("\n");
    expect(lines).toHaveLength(e.count);
    expect(JSON.parse(JSON.parse(lines[3]!).json)).toMatchObject({ t: "message.delta", text: BIG });
    expect(manifestOf(dir)).toEqual(entries);
    db.close();
  });

  test("commit skeletonizes only uploaded tasks and records key and count", async () => {
    const db = open("commit");
    seed(db, "a", "done", LONG_AGO);
    seed(db, "b", "done", LONG_AGO);
    const dir = join(tmp, "commit-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    const before = db.listEvents("a").length;
    const moved = commitEventsArchive(db.sqlite, dir, upload(entries.filter((e) => e.taskId === "a")), { now: NOW });
    expect(moved).toEqual(["a"]);
    const row = db.sqlite.query("SELECT events_archive_key AS k, events_archived_at AS at, events_archived_count AS n FROM tasks WHERE id = 'a'").get() as { k: string; at: number; n: number };
    expect(row).toEqual({ k: `history/events/2026/a.${before}.jsonl.zst`, at: NOW, n: before });
    expect(db.listEvents("b").some((e) => JSON.stringify(e.ev).includes(BIG))).toBe(true); // not uploaded: untouched
    const evs = db.listEvents("a");
    expect(JSON.stringify(evs)).not.toContain(BIG);
    expect(evs.find((e) => e.ev.t === "tool.call")!.ev).toMatchObject({ id: "c1", name: "Bash" });
    expect(evs.find((e) => e.ev.t === "tool.result")!.ev).toMatchObject({ id: "c1", ok: false });
    expect(evs.filter((e) => e.ev.t === "message.delta" && e.ev.role === "user").map((e) => (e.ev as { text: string }).text)).toEqual(["do it", "again"]);
    // a1's two rows are one, a3's two rows are one; a task archived once is not written again
    expect(evs.filter((e) => e.ev.t === "message.delta" && e.ev.role === "assistant")).toHaveLength(3);
    expect((await prepareEventsArchive(db.sqlite, join(tmp, "commit-again"), { now: NOW })).map((e) => e.taskId)).toEqual(["b"]);
    db.close();
  });

  test("ruleMetrics, durations, stop records, permission events and lastReply are the same before and after", async () => {
    for (const endsOnAssistant of [false, true]) {
      const db = open(`same-${endsOnAssistant}`);
      seed(db, "t", "done", LONG_AGO, { endsOnAssistant });
      const durationOf = () => (db.sqlite.query("SELECT MAX(COALESCE((SELECT MAX(ts) FROM events e WHERE e.task_id = t.id), t.updated_at) - t.created_at, 0) AS d FROM tasks t WHERE id = 't'").get() as { d: number }).d;
      const snap = () => ({
        metrics: ruleMetrics(db.listEvents("t")),
        duration: durationOf(),
        stops: db.listStopRecords(["t"]),
        permissions: db.listPermissionEvents(["t"]).map((e) => ({ ...e, seq: undefined })),
        lastReply: db.lastReply("t")?.text,
        lastTs: db.listEvents("t").at(-1)!.ts,
      });
      const before = snap();
      const dir = join(tmp, `same-out-${endsOnAssistant}`);
      const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
      commitEventsArchive(db.sqlite, dir, upload(entries), { now: NOW });
      expect(snap()).toEqual(before);
      db.close();
    }
  });

  test("a task that got new events after prepare is not removed", async () => {
    const db = open("changed");
    seed(db, "t", "done", LONG_AGO);
    const dir = join(tmp, "changed-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    db.appendEventAt("t", { t: "message.delta", role: "user", text: "one more" }, NOW);
    expect(commitEventsArchive(db.sqlite, dir, upload(entries), { now: NOW })).toEqual([]);
    expect(JSON.stringify(db.listEvents("t"))).toContain(BIG);
    expect(db.sqlite.query("SELECT events_archived_at AS at FROM tasks WHERE id = 't'").get()).toEqual({ at: null });
    db.close();
  });

  test("commit is not stopped by another connection writing after its first read (SQLITE_BUSY_SNAPSHOT)", async () => {
    const db = open("snapshot");
    seed(db, "t", "done", LONG_AGO);
    const dir = join(tmp, "snapshot-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    // The daemon: a second connection that does not wait, writing right after commit's first read.
    const daemon = new Database(join(tmp, "snapshot.db"));
    daemon.exec("PRAGMA busy_timeout = 0");
    let daemonWrote = true;
    const proxy = new Proxy(db.sqlite, {
      get(target, prop) {
        if (prop === "query")
          return (sql: string) => {
            const q = target.query(sql);
            if (!sql.startsWith("SELECT status, events_archive_key")) return q;
            return { get: (...a: unknown[]) => {
              const row = (q.get as (...x: unknown[]) => unknown)(...a);
              try { daemon.exec("UPDATE tasks SET title = 'touched' WHERE id = 't'"); } catch { daemonWrote = false; }
              return row;
            } };
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Database;
    expect(commitEventsArchive(proxy, dir, upload(entries), { now: NOW })).toEqual(["t"]);
    // Writing first made the daemon wait (and here fail); a deferred transaction lets it in and then fails itself.
    expect(daemonWrote).toBe(false);
    daemon.close();
    db.close();
  });

  test("a new event after archiving continues the seq", async () => {
    const db = open("seq");
    seed(db, "t", "done", LONG_AGO);
    const maxBefore = db.nextSeq("t") - 1;
    const dir = join(tmp, "seq-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    commitEventsArchive(db.sqlite, dir, upload(entries), { now: NOW });
    const ev = db.appendEvent("t", { t: "message.delta", role: "user", text: "later" });
    expect(ev.seq).toBe(maxBefore + 1);
    db.close();
  });

  test("a task resumed and finished again after it was archived is written again under a new key", async () => {
    const db = open("again");
    seed(db, "t", "done", LONG_AGO);
    const first = await prepareEventsArchive(db.sqlite, join(tmp, "again-1"), { now: NOW });
    commitEventsArchive(db.sqlite, join(tmp, "again-1"), upload(first), { now: NOW });
    expect(await prepareEventsArchive(db.sqlite, join(tmp, "again-none"), { now: NOW })).toEqual([]);
    db.appendEventAt("t", { t: "message.delta", role: "user", text: "later" }, NOW + DAY);
    db.sqlite.query("UPDATE tasks SET updated_at = ? WHERE id = 't'").run(NOW + DAY);
    const later = NOW + (EVENTS_ARCHIVE_DAYS + 2) * DAY;
    const second = await prepareEventsArchive(db.sqlite, join(tmp, "again-2"), { now: later });
    expect(second).toHaveLength(1);
    expect(second[0]!.file).not.toBe(first[0]!.file);
    expect(commitEventsArchive(db.sqlite, join(tmp, "again-2"), upload(second), { now: later })).toEqual(["t"]);
    expect(commitEventsArchive(db.sqlite, join(tmp, "again-2"), upload(second), { now: later })).toEqual([]); // the same manifest twice
    const keys = (db.sqlite.query("SELECT events_archive_key AS k FROM tasks WHERE id = 't'").get() as { k: string }).k.split("\n");
    expect(keys).toEqual([`history/events/2026/${first[0]!.file}`, `history/events/2026/${second[0]!.file}`]);
    // a record imported after the archive keeps its old time; its seq still makes the task eligible
    db.sqlite.query("INSERT INTO events (task_id, seq, ts, json) VALUES ('t', ?, 1, ?)").run(db.nextSeq("t"), JSON.stringify({ t: "message.delta", role: "assistant", text: BIG }));
    expect(await prepareEventsArchive(db.sqlite, join(tmp, "again-imp"), { now: later + 40 * DAY })).toHaveLength(1);
    db.sqlite.query("DELETE FROM events WHERE task_id = 't' AND ts = 1").run();
    // a metadata-only update makes it neither eligible nor writable again
    db.sqlite.query("UPDATE tasks SET updated_at = ? WHERE id = 't'").run(later + DAY);
    expect(await prepareEventsArchive(db.sqlite, join(tmp, "again-3"), { now: later + 40 * DAY })).toEqual([]);
    db.close();
  });

  test("page_count drops after commit", async () => {
    const db = open("pages");
    for (let i = 0; i < 20; i++) seed(db, `t${i}`, "done", LONG_AGO);
    db.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(db.sqlite.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    const pages = () => (db.sqlite.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const before = pages();
    const dir = join(tmp, "pages-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    commitEventsArchive(db.sqlite, dir, upload(entries), { now: NOW });
    expect(pages()).toBeLessThan(before);
    db.close();
  });

  test("ledger and task_evals rows are unchanged", async () => {
    const db = open("ledger");
    seed(db, "t", "done", LONG_AGO);
    const snap = () => ({ cost: db.taskCost("t"), human: db.getEval("t", "human"), rows: db.sqlite.query("SELECT * FROM ledger").all() });
    const before = snap();
    const dir = join(tmp, "ledger-out");
    const entries = await prepareEventsArchive(db.sqlite, dir, { now: NOW });
    commitEventsArchive(db.sqlite, dir, upload(entries), { now: NOW });
    expect(snap()).toEqual(before);
    db.close();
  });

  test("an existing database in the default auto_vacuum mode is switched once on open", () => {
    const path = join(tmp, "legacy.db");
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA auto_vacuum = NONE; CREATE TABLE t (x)");
    raw.close();
    const db = new Db(path);
    expect(db.sqlite.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    db.close();
  });
});
