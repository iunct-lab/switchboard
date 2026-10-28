import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { checkDaemon, KEEP_SNAPSHOTS, listSnapshots, promote, restoreDb, rollback, snapshotDb, type Ctx } from "./promote.ts";
import { appendHistory, buildRelease, currentOf, previousOf, readHistory, switchTo } from "./releases.ts";
import { Supervisor } from "./supervisor.ts";

const FAST = { candidateMs: 8000, confirmMs: 6000, settleMs: 800 };
let f: Awaited<ReturnType<typeof makeRepo>>;
let ctx: Ctx;
const rows = () => {
  const db = new Database(join(f.home, "switchboard.db"));
  try {
    return (db.query("select name from notes order by name").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  f = await makeRepo();
  switchTo(f.home, await buildRelease(f.repo, "HEAD", f.home));
  const db = new Database(join(f.home, "switchboard.db"));
  db.exec("PRAGMA journal_mode = WAL; create table notes (name text); insert into notes values ('before')");
  db.close();
  const port = await freePort();
  ctx = { home: f.home, repo: f.repo, port, sup: new Supervisor({ home: f.home, repo: f.repo, port, backoffMs: 50 }) };
  ctx.sup.start();
  await until(() => health(port), "v1 up");
});
afterAll(async () => {
  await ctx.sup.stop();
  rmSync(f.root, { recursive: true, force: true });
});

test("a release that throws at boot is rejected: current does not move and the reason is recorded", async () => {
  const bad = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("bad", `throw new Error("boom at boot");`), "throws");
  const r = await promote(ctx, bad, FAST);
  expect(r).toMatchObject({ action: "rejected", ok: false, to: bad });
  expect(r.reason).toContain("boom at boot");
  expect(currentOf(f.home)).toBe(f.v1);
  expect((await health(ctx.port))?.version).toBe("v1"); // the running daemon was never touched
  expect(readHistory(f.home).at(-1)).toEqual(r);
});

test("a release that dies after the switch goes back by itself, and previous is not left pointing at it", async () => {
  const dies = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("dies", `if (!process.env.SWITCHBOARD_CANDIDATE) setTimeout(() => process.exit(1), 400);`), "dies after the switch");
  const r = await promote(ctx, dies, FAST);
  expect(r).toMatchObject({ action: "auto-rollback", ok: false, from: dies, to: f.v1 });
  expect(r.reason).toContain("crashed after the switch");
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([f.v1, null]);
  expect((await until(() => health(ctx.port), "v1 back")).version).toBe("v1");
});

test("a good release is promoted with a database snapshot; the snapshot brings the database back; rollback returns to previous", async () => {
  const v2 = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2"), "v2");
  const r = await promote(ctx, v2, FAST);
  expect(r).toMatchObject({ action: "promote", ok: true, from: f.v1, to: v2 });
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([v2, f.v1]);
  expect((await health(ctx.port))?.version).toBe("v2");
  const snapshot = listSnapshots(f.home).find((s) => s.includes(`before-${v2.slice(0, 7)}`))!;
  expect(snapshot).toBeDefined();

  const db = new Database(join(f.home, "switchboard.db"));
  db.exec("insert into notes values ('after')");
  db.close();
  expect(rows()).toEqual(["after", "before"]);
  await expect(restoreDb(ctx, "../switchboard.db")).rejects.toThrow(/no such snapshot/);
  const restored = await restoreDb(ctx, snapshot);
  expect(restored.action).toBe("restore-db");
  expect(rows()).toEqual(["before"]);
  expect(listSnapshots(f.home).some((s) => s.includes("pre-restore"))).toBe(true); // what was replaced is kept
  expect((await until(() => health(ctx.port), "v2 back after restore")).version).toBe("v2");

  expect(await rollback(ctx)).toMatchObject({ action: "rollback", from: v2, to: f.v1 });
  expect((await until(() => health(ctx.port), "v1 after rollback")).version).toBe("v1");
  expect((await promote(ctx, f.v1, FAST)).reason).toContain("already current");
}, 30_000);

test("a release that first answers late in the window still gets its full settle time", async () => {
  const slow = await commitFile(f.repo, "packages/core/src/main.ts", `if (!process.env.SWITCHBOARD_CANDIDATE) await Bun.sleep(1000);\n${daemonSource("slow")}`, "slow start");
  const r = await promote(ctx, slow, { candidateMs: 8000, confirmMs: 1500, settleMs: 1000 }); // first answer at ~1.1 s, settled at ~2.1 s > 1.5 s
  expect(r).toMatchObject({ action: "promote", ok: true, to: slow });
  expect(currentOf(f.home)).toBe(slow);
}, 30_000);

test("restoring the oldest snapshot at the retention limit keeps that snapshot and brings its rows back", async () => {
  while (listSnapshots(f.home).length < KEEP_SNAPSHOTS) {
    snapshotDb(f.home, `filler${listSnapshots(f.home).length}`);
    await Bun.sleep(5);
  }
  const oldest = listSnapshots(f.home).at(-1)!;
  await restoreDb(ctx, oldest); // the pre-restore snapshot is the newest: pruning must not take the one being restored
  expect(existsSync(join(f.home, "snapshots", oldest))).toBe(true);
  expect(listSnapshots(f.home).length).toBe(KEEP_SNAPSHOTS + 1);
  expect(rows()).toEqual(["before"]);
  expect((await until(() => health(ctx.port), "daemon up after the restore")).ok).toBe(true);
}, 30_000);

test("snapshots keep only the newest KEEP_SNAPSHOTS and the one being restored", async () => {
  expect(KEEP_SNAPSHOTS).toBe(3); // the decided value (#1429)
  for (let i = 0; i < KEEP_SNAPSHOTS + 1; i++) {
    snapshotDb(f.home, `n${i}`);
    await Bun.sleep(5);
  }
  const all = listSnapshots(f.home);
  expect(all.length).toBe(KEEP_SNAPSHOTS);
  expect(all[0]).toContain(`n${KEEP_SNAPSHOTS}`);
  expect(all.some((n) => n.includes("n0"))).toBe(false);
  const oldest = all.at(-1)!;
  await restoreDb(ctx, oldest);
  const after = listSnapshots(f.home);
  expect(after).toContain(oldest);
  expect(after.some((n) => n.includes("pre-restore"))).toBe(true);
  expect(after.length).toBe(KEEP_SNAPSHOTS + 1); // the newest KEEP_SNAPSHOTS plus the protected one
}, 30_000);

test("SWITCHBOARD_DB moves the database sb-rescue snapshots, like it does for the daemon", () => {
  const elsewhere = join(f.root, "elsewhere.db");
  const db = new Database(elsewhere);
  db.exec("create table marker (x)");
  db.close();
  process.env.SWITCHBOARD_DB = elsewhere;
  try {
    const name = snapshotDb(f.home, "elsewhere")!;
    const copy = new Database(join(f.home, "snapshots", name), { readonly: true });
    expect((copy.query("select name from sqlite_master where name = 'marker'").all() as unknown[]).length).toBe(1);
    copy.close();
  } finally {
    delete process.env.SWITCHBOARD_DB;
  }
});

test("a promotion removes releases beyond KEEP_RELEASES; a rejected one removes nothing", async () => {
  const fakes = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).repeat(40));
  for (const sha of fakes) {
    mkdirSync(join(f.home, "releases", sha), { recursive: true });
    appendHistory(f.home, { action: "promote", from: null, to: sha, ok: true, reason: "old" });
  }
  const bad = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("bad2", `throw new Error("boom again");`), "throws again");
  expect((await promote(ctx, bad, FAST)).action).toBe("rejected");
  for (const sha of fakes) expect(existsSync(join(f.home, "releases", sha))).toBe(true);
  const cur = currentOf(f.home)!;
  const good = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v-keep"), "good again");
  const r = await promote(ctx, good, FAST);
  expect(r).toMatchObject({ action: "promote", ok: true, to: good });
  expect(r.reason).toMatch(/removed \d+ old releases/);
  expect(fakes.slice(0, 3).some((sha) => existsSync(join(f.home, "releases", sha)))).toBe(false);
  expect(fakes.slice(3).every((sha) => existsSync(join(f.home, "releases", sha)))).toBe(true);
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([good, cur]);
}, 60_000);

test("the candidate does not get sb-rescue's starter token (#2077)", async () => {
  // sb-rescue's own secret for 作り直す: the daemon never gets it (supervisor.ts), and neither does a candidate
  process.env.SWITCHBOARD_STARTER_TOKEN = "tok";
  try {
    const clean = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("clean", `if (process.env.SWITCHBOARD_STARTER_TOKEN) throw new Error("the candidate got the starter token");`), "refuses the token");
    const r = await promote(ctx, clean, FAST);
    expect(r).toMatchObject({ action: "promote", ok: true, to: clean });
    expect(((await health(ctx.port)) as { starterToken?: string | null } | null)?.starterToken ?? null).toBeNull();
  } finally {
    delete process.env.SWITCHBOARD_STARTER_TOKEN;
  }
}, 60_000);

test("checkDaemon says why the daemon is unhealthy, in the same words (#2814)", async () => {
  const asked: string[] = [];
  const fake = (health: () => Response, upgrade = true) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => {
        const path = new URL(req.url).pathname;
        asked.push(path);
        if (path === "/api/health") return health();
        if (path === "/ws" && upgrade) return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
        return new Response("no", { status: 404 });
      },
      websocket: { message() {} },
    });
  const down = await freePort();
  expect(await checkDaemon(down, f.home)).toStartWith(`no answer on port ${down} (`);
  const servers = [fake(() => new Response("boom", { status: 500 })), fake(() => Response.json({ ok: false })), fake(() => Response.json({ ok: true }), false), fake(() => Response.json({ ok: true }))];
  try {
    const [err, notOk, noWs, fine] = servers.map((s) => s.port as number);
    expect(await checkDaemon(err!, f.home)).toBe("/api/health answered 500");
    expect(await checkDaemon(notOk!, f.home)).toBe("/api/health answered 200");
    expect(["WebSocket /ws refused", "WebSocket /ws did not open"]).toContain((await checkDaemon(noWs!, f.home))!);
    expect(await checkDaemon(fine!, f.home)).toBeNull();
    expect(asked).not.toContain("/api/tasks");
  } finally {
    for (const s of servers) await s.stop(true);
  }
});
