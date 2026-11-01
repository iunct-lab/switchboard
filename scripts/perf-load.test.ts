import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importGithubSnapshot } from "../packages/core/src/backlog-sync.ts";
import { Db } from "../packages/core/src/db.ts";
import { loadGh, overlap, seedLoad } from "./perf-load.ts";

const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-perf-load-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const count = (db: Db, table: string) => (db.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const SIZE = { tasks: 30, backlogRecords: 600, operations: 90 }; // 60 Issues: more than a page of the import's 50

test("seedLoad makes the counts asked for (#2822)", async () => {
  const dir = home();
  const { taskIds } = await seedLoad(dir, SIZE);
  const db = new Db(join(dir, "switchboard.db"));
  expect([count(db, "tasks"), count(db, "backlog_records"), count(db, "backlog_operations")]).toEqual([30, 600, 90]);
  expect(taskIds).toHaveLength(30);
  expect(db.listPendingBacklogOperations()).toHaveLength(10);
  // an edit marked done shows nothing on top of the record: only the kept ones do
  expect((db.sqlite.query("SELECT count(*) AS n FROM backlog_records WHERE local IS NOT NULL").get() as { n: number }).n).toBe(10);
  db.close();
});

test("seedLoad: fewer Issues than the edits it keeps still makes the count asked for (#2822)", async () => {
  const dir = home();
  await seedLoad(dir, { tasks: 2, backlogRecords: 50, operations: 40 });
  const db = new Db(join(dir, "switchboard.db"));
  expect(count(db, "backlog_operations")).toBe(40);
  db.close();
});

test("seedLoad refuses a count no number of Issues makes (#2822)", async () => {
  await expect(seedLoad(home(), { tasks: 1, backlogRecords: 205, operations: 1 })).rejects.toThrow("tens");
});

test("loadGh: a new generation rewrites every Issue (#2822)", async () => {
  const dir = home();
  const { workspaceId } = await seedLoad(dir, SIZE);
  const db = new Db(join(dir, "switchboard.db"));
  const ws = db.getWorkspace(workspaceId)!;
  const same = await importGithubSnapshot(loadGh(60, { generation: 0 }), db, ws);
  expect(same.changed).toBe(false);
  const next = await importGithubSnapshot(loadGh(60, { generation: 1 }), db, ws);
  expect(next.changed).toBe(true);
  expect(count(db, "backlog_records")).toBe(600);
  db.close();
});

/** What overlap reads, on a server of its own: `sync` answers the import. */
function lab(sync: () => Response) {
  const sockets = { opened: 0 };
  const server = Bun.serve({ port: 0, routes: { "/api/health": () => Response.json({ ok: true, busyTasks: [] }), "/api/backlog/sync": { POST: sync } }, websocket: { open() { sockets.opened++; }, message() {} }, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 404 }); } });
  return { server, sockets, d: { base: `http://127.0.0.1:${server.port}`, port: server.port!, home: home(), github: { generation: 0 }, workspaceId: "ws" } };
}

test("overlap: a stall of this process counts, from when /api/health was due (#2822)", async () => {
  const { server, sockets, d } = lab(() => Response.json({}));
  const ms = await overlap(d, async () => {
    await Bun.sleep(120);
    Bun.sleepSync(400);
    await Bun.sleep(120);
  });
  server.stop(true);
  expect(ms).toBeGreaterThanOrEqual(350);
  expect(d.github.generation).toBe(1);
  expect(sockets.opened).toBeGreaterThan(0); // the rescue page's check ran: it is the one that opens /ws
});

test("overlap: an import that fails fails the run (#2822)", async () => {
  const { server, d } = lab(() => new Response("no GitHub", { status: 502 }));
  await expect(overlap(d, () => Bun.sleep(10))).rejects.toThrow("the import failed: 502");
  server.stop(true);
});

test("overlap: the window lasts until the import answers (#2822)", async () => {
  let answered = false;
  const { server, d } = lab(() => Bun.sleep(150).then(() => ((answered = true), Response.json({}))) as unknown as Response);
  await overlap(d, async () => {});
  server.stop(true);
  expect(answered).toBe(true);
});
