import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogQueue, BacklogSource } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db, type BacklogSnapshotEntry } from "./db.ts";
import { EMPTY_QUEUE, ENDED_KEEP, noteQueue, pruneClosed, QUEUE_KEY, readQueue, saveQueue } from "./backlog-queue.ts";
import { startServer } from "./server.ts";

const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };
const SOURCE: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };
const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });

const withDb = (fn: (db: Db) => void) => {
  const h = mkdtempSync(join(tmpdir(), "switchboard-test-queue-"));
  const db = new Db(join(h, "db.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(h, { recursive: true, force: true });
  }
};

describe("backlog queue (#3955)", () => {
  test("readQueue: none stored, or a row that does not parse, is the empty disabled queue", () =>
    withDb((db) => {
      expect(readQueue(db)).toEqual(EMPTY_QUEUE);
      db.setSetting(QUEUE_KEY, { enabled: "yes" });
      expect(readQueue(db)).toEqual(EMPTY_QUEUE);
    }));

  test("a queue stored before lastNoteAt existed is read with it null after the migration (#4055)", () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-queue-migrate-"));
    try {
      const first = new Db(join(h, "db.sqlite"));
      const old = { enabled: true, concurrency: 2 as const, items: [{ workspaceId: "w", number: 4 }], ended: [], lastNote: "キューが空" };
      first.setSetting(QUEUE_KEY, old);
      expect(readQueue(first)).toEqual(EMPTY_QUEUE);
      first.close();
      const again = new Db(join(h, "db.sqlite"));
      expect(readQueue(again)).toEqual({ ...old, lastNoteAt: null });
      again.close();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("noteQueue keeps the lines and their time (#4055)", () =>
    withDb((db) => {
      saveQueue(db, { items: [{ workspaceId: "w", number: 1 }] });
      expect(noteQueue(db, ["a", "b"], 42)).toMatchObject({ lastNote: "a\nb", lastNoteAt: 42, items: [{ workspaceId: "w", number: 1 }] });
    }));

  test("saveQueue keeps the order, each PBI once, the fields left out, and moves the dropped ones to ended as removed", () =>
    withDb((db) => {
      const a = { workspaceId: "w1", number: 3 };
      const b = { workspaceId: "w2", number: 3 };
      const c = { workspaceId: "w1", number: 7 };
      expect(saveQueue(db, { items: [c, a, c, b] }, () => null, 1).items).toEqual([c, a, b]);
      saveQueue(db, { enabled: true, concurrency: 2 }, () => null, 2);
      expect(readQueue(db)).toMatchObject({ enabled: true, concurrency: 2, items: [c, a, b], ended: [] });
      const q = saveQueue(db, { items: [b, c] }, (e) => (e.workspaceId === "w1" && e.number === 3 ? "PBI three" : null), 3);
      expect(q.items).toEqual([b, c]);
      expect(q.ended).toEqual([{ workspaceId: "w1", number: 3, title: "PBI three", at: 3, reason: "removed" }]);
      expect(readQueue(db)).toEqual(q);
    }));

  test("saveQueue keeps the newest ENDED_KEEP of the ended", () =>
    withDb((db) => {
      const items = Array.from({ length: ENDED_KEEP + 5 }, (_, i) => ({ workspaceId: "w", number: i + 1 }));
      saveQueue(db, { items });
      const q = saveQueue(db, { items: [] });
      expect(q.ended.length).toBe(ENDED_KEEP);
    }));

  test("pruneClosed moves the PBIs answered closed to ended as closed and keeps the rest (not stored, not read) in order", () => {
    const queue: BacklogQueue = { ...EMPTY_QUEUE, items: [{ workspaceId: "w1", number: 1 }, { workspaceId: "w1", number: 2 }, { workspaceId: "w2", number: 9 }] };
    expect(pruneClosed(queue, () => null)).toBe(queue);
    const pruned = pruneClosed(queue, (e) => (e.number === 1 ? { title: "closed one" } : null), 5);
    expect(pruned.items).toEqual([{ workspaceId: "w1", number: 2 }, { workspaceId: "w2", number: 9 }]);
    expect(pruned.ended).toEqual([{ workspaceId: "w1", number: 1, title: "closed one", at: 5, reason: "closed" }]);
  });

  test("PUT then reopen keeps the order, enabled and concurrency; a bad body is 400", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-test-queue-api-"));
    const cfg = loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
    const boot = () => startServer(cfg, [], { port: 0, selfdevChecks: false, gh: NO_GH });
    let c = await boot();
    const url = () => `http://127.0.0.1:${c.server.port}/api/backlog/queue`;
    const put = (body: unknown) => fetch(url(), { method: "PUT", body: JSON.stringify(body) });
    try {
      expect(await (await fetch(url())).json()).toEqual(EMPTY_QUEUE);
      const items = [{ workspaceId: "w2", number: 5 }, { workspaceId: "w1", number: 8 }];
      const r = await put({ items, enabled: true, concurrency: 3 });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ items, enabled: true, concurrency: 3 });
      expect((await put({ concurrency: 4 })).status).toBe(400);
      expect((await put({ items: [{ workspaceId: "w", number: 0 }] })).status).toBe(400);
      expect((await put({ other: 1 })).status).toBe(400);
      await c.stop();
      c = await boot();
      expect(await (await fetch(url())).json()).toMatchObject({ enabled: true, concurrency: 3, items, ended: [] });
      // the stored Issue closed: GET moves it to ended with its title, and stores that; one still open or not stored stays
      const ws = c.db.upsertWorkspace({ name: "app", path: h, kind: "repo" });
      const issue = (n: number, state: "OPEN" | "CLOSED"): BacklogSnapshotEntry => ({ objectKind: "issue", externalId: `I_${n}`, fetchState: "fetched", remote: { number: n, title: `PBI ${n}`, url: `https://github.com/acme/app/issues/${n}`, state, stateReason: null, body: "", labels: ["type:pbi"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", closedAt: null } });
      c.db.putBacklogSnapshot(SOURCE, { records: [issue(5, "OPEN"), issue(8, "CLOSED")], cursor: null, syncedAt: 5000 });
      c.db.setWorkspaceBacklogSource(ws.id, SOURCE);
      const queued = [{ workspaceId: ws.id, number: 8 }, { workspaceId: ws.id, number: 5 }, { workspaceId: ws.id, number: 77 }];
      await put({ items: queued });
      const got = (await (await fetch(url())).json()) as BacklogQueue;
      expect(got.items).toEqual(queued.slice(1));
      expect(got.ended[0]).toMatchObject({ workspaceId: ws.id, number: 8, title: "PBI 8", reason: "closed" });
      expect(readQueue(c.db).items).toEqual(queued.slice(1));
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  }, 30_000);
});
