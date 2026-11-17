// test-reads: none
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { checkDaemon, checkFeatures, KEEP_SNAPSHOTS, listSnapshots, promote, restoreDb, rollback, snapshotDb, type Ctx } from "./promote.ts";
import { appendHistory, buildRelease, currentOf, previousOf, readHistory, restartNeeded, run, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
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
  ctx = { home: f.home, repo: f.repo, source: null, port, sup: new Supervisor({ home: f.home, repo: f.repo, port, backoffMs: 50 }) };
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
    await snapshotDb(f.home, `filler${listSnapshots(f.home).length}`);
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
    await snapshotDb(f.home, `n${i}`);
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

const unzipped = (name: string) => Bun.gunzipSync(readFileSync(join(f.home, "snapshots", name)));

test("a snapshot is gzipped and smaller than the database; it opens once unpacked", async () => {
  const db = new Database(join(f.home, "switchboard.db"));
  db.exec("create table bulk (x); insert into bulk select hex(zeroblob(2000)) from (with recursive c(n) as (select 1 union all select n + 1 from c where n < 500) select n from c)");
  db.close();
  const name = (await snapshotDb(f.home, "gz"))!;
  expect(name).toEndWith(".db.gz");
  expect(statSync(join(f.home, "snapshots", name)).size).toBeLessThan(statSync(join(f.home, "switchboard.db")).size / 4);
  expect(readdirSync(join(f.home, "snapshots")).filter((n) => !n.endsWith(".db.gz"))).toEqual([]);
  const copy = Database.deserialize(unzipped(name));
  expect(copy.query("select count(*) n from bulk").get()).toEqual({ n: 500 });
  copy.close();
});

test("a .db already in the folder is compressed with the next snapshot: one a killed run left, one from before gzip", async () => {
  const dir = join(f.home, "snapshots");
  mkdirSync(dir, { recursive: true });
  const old = new Database(join(dir, "2026-01-01T00-00-00-000Z-old.db"));
  old.exec("create table marker (x)");
  old.close();
  await snapshotDb(f.home, "new");
  expect(readdirSync(dir).filter((n) => !n.endsWith(".db.gz"))).toEqual([]);
});

test("a failed compression stops the snapshot and leaves no half-written file", async () => {
  const dir = join(f.home, "snapshots");
  mkdirSync(dir, { recursive: true });
  const stuck = join(dir, "2026-01-01T00-00-00-000Z-stuck.db");
  writeFileSync(stuck, "x");
  chmodSync(stuck, 0o000);
  try {
    await expect(snapshotDb(f.home, "failed")).rejects.toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith(".part") || n.endsWith(".tmp") || n.endsWith("-failed.db"))).toEqual([]);
  } finally {
    rmSync(stuck, { force: true });
  }
});

test("what a killed run left is gone with the next snapshot", async () => {
  const dir = join(f.home, "snapshots");
  mkdirSync(dir, { recursive: true });
  for (const n of ["2026-01-01T00-00-00-000Z-a.db.tmp", "2026-01-01T00-00-00-000Z-b.db.gz.part", "2026-01-01T00-00-00-000Z-c.db.tmp-journal"]) writeFileSync(join(dir, n), "x");
  await snapshotDb(f.home, "after-kill");
  expect(readdirSync(dir).filter((n) => n.endsWith(".part") || n.endsWith(".tmp") || n.endsWith("-journal"))).toEqual([]);
});

test("a snapshot that does not fit first drops the snapshots beyond the kept ones, then stops before writing and says how much it needs", async () => {
  const dir = join(f.home, "snapshots");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const old = ["01", "02", "03", "04", "05"].map((d) => `2026-01-${d}T00-00-00-000Z-old.db.gz`);
  for (const n of old) writeFileSync(join(dir, n), "x");
  const gz = () => readdirSync(dir).filter((n) => n.endsWith(".db.gz"));
  // room only once every snapshot beyond the newest KEEP_SNAPSHOTS - 1 is gone (old[2] is the newest of them); the one being restored stays
  const name = (await snapshotDb(f.home, "fits-after-drop", old[0], () => (existsSync(join(dir, old[2]!)) ? 0 : Number.MAX_SAFE_INTEGER)))!;
  expect(gz().sort()).toEqual([old[0]!, old[3]!, old[4]!, name].sort());
  // no room even then: nothing new is written, and the error names both amounts
  const before = readdirSync(dir).sort();
  await expect(snapshotDb(f.home, "no-room", undefined, () => 0)).rejects.toThrow(/not enough disk for the database snapshot: needs \d+ MB, 0 MB free/);
  expect(readdirSync(dir).filter((n) => n.includes("no-room"))).toEqual([]);
  expect(readdirSync(dir).every((n) => before.includes(n))).toBe(true);
});

test("a snapshot that does not unpack leaves the database alone and the daemon running", async () => {
  const name = (await snapshotDb(f.home, "broken"))!;
  const file = join(f.home, "snapshots", name);
  writeFileSync(file, readFileSync(file).subarray(0, 40));
  const before = rows();
  await expect(restoreDb(ctx, name)).rejects.toThrow();
  expect(existsSync(join(f.home, "switchboard.db.restore"))).toBe(false);
  expect(existsSync(join(f.home, "switchboard.db.restore.part"))).toBe(false);
  expect(rows()).toEqual(before);
  expect((await until(() => health(ctx.port), "daemon up after the failed restore")).ok).toBe(true);
}, 30_000);

test("SWITCHBOARD_DB moves the database sb-rescue snapshots, like it does for the daemon", async () => {
  const elsewhere = join(f.root, "elsewhere.db");
  const db = new Database(elsewhere);
  db.exec("create table marker (x)");
  db.close();
  process.env.SWITCHBOARD_DB = elsewhere;
  try {
    const name = (await snapshotDb(f.home, "elsewhere"))!;
    const copy = Database.deserialize(unzipped(name));
    expect((copy.query("select name from sqlite_master where name = 'marker'").all() as unknown[]).length).toBe(1);
    copy.close();
  } finally {
    delete process.env.SWITCHBOARD_DB;
  }
});

test("a promotion removes releases beyond KEEP_RELEASES; a rejected one removes nothing; the candidate boots on the unpacked database, without sb-rescue's starter token (#2077)", async () => {
  const fakes = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).repeat(40));
  for (const sha of fakes) {
    mkdirSync(join(f.home, "releases", sha), { recursive: true });
    appendHistory(f.home, { action: "promote", from: null, to: sha, ok: true, reason: "old" });
  }
  const bad = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("bad2", `throw new Error("boom again");`), "throws again");
  expect((await promote(ctx, bad, FAST)).action).toBe("rejected");
  for (const sha of fakes) expect(existsSync(join(f.home, "releases", sha))).toBe(true);
  const cur = currentOf(f.home)!;
  const opens = `const { Database } = require("bun:sqlite"); new Database(process.env.SWITCHBOARD_DB ?? process.env.SWITCHBOARD_HOME + "/switchboard.db").query("select name from notes").all();`;
  const refuses = `if (process.env.SWITCHBOARD_STARTER_TOKEN) throw new Error("the candidate got the starter token");`;
  const good = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v-keep", opens + refuses), "good again");
  // sb-rescue's own secret for 作り直す: the daemon never gets it (supervisor.ts), and neither does a candidate
  process.env.SWITCHBOARD_STARTER_TOKEN = "tok";
  let r: Awaited<ReturnType<typeof promote>>;
  try {
    r = await promote(ctx, good, FAST);
  } finally {
    delete process.env.SWITCHBOARD_STARTER_TOKEN;
  }
  expect(((await health(ctx.port)) as { starterToken?: string | null } | null)?.starterToken ?? null).toBeNull();
  expect(r).toMatchObject({ action: "promote", ok: true, to: good });
  expect(r.reason).toMatch(/removed \d+ old releases/);
  expect(fakes.slice(0, 3).some((sha) => existsSync(join(f.home, "releases", sha)))).toBe(false);
  expect(fakes.slice(3).every((sha) => existsSync(join(f.home, "releases", sha)))).toBe(true);
  expect([currentOf(f.home), previousOf(f.home)]).toEqual([good, cur]);
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
    expect(asked).not.toContain("/api/tasks"); // the features are checkFeatures, asked once, not every 200 ms
  } finally {
    for (const s of servers) await s.stop(true);
  }
});

test("a release whose task list fails is rejected on the candidate; one that breaks it after the switch goes back by itself; an empty list passes", async () => {
  const cur = currentOf(f.home);
  const noList = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("no-list", `tasks = "500";`), "task list 500");
  const rejected = await promote(ctx, noList, FAST);
  expect(rejected).toMatchObject({ action: "rejected", ok: false, to: noList });
  expect(rejected.reason).toContain("/api/tasks answered 500");
  expect(currentOf(f.home)).toBe(cur);

  const late = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("late-list", `if (!process.env.SWITCHBOARD_CANDIDATE) tasks = "500";`), "task list 500 after the switch");
  const back = await promote(ctx, late, FAST);
  expect(back).toMatchObject({ action: "auto-rollback", ok: false, from: late, to: cur });
  expect(back.reason).toContain("/api/tasks answered 500");
  expect(currentOf(f.home)).toBe(cur);
  expect((await until(() => health(ctx.port), "back after the task list failed")).ok).toBe(true);

  const empty = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("empty-list", `tasks = "empty";`), "no task yet");
  expect(await promote(ctx, empty, FAST)).toMatchObject({ action: "promote", ok: true, to: empty });

  // the first task does not read back (as the API answers it: `{ task, … }`): rejected with the path
  const now = currentOf(f.home);
  for (const [name, why] of [["html", "/api/tasks answered something that is not a list"], ["detail500", "/api/tasks/t1 answered 500"], ["other", "/api/tasks/t1 answered another task"]] as const) {
    const bad = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource(`detail-${name}`, `tasks = "${name}";`), `task detail ${name}`);
    const r = await promote(ctx, bad, FAST);
    expect(r).toMatchObject({ action: "rejected", ok: false, to: bad });
    expect(r.reason).toContain(why);
    expect(currentOf(f.home)).toBe(now);
  }
}, 90_000);

test("a promotion whose database snapshot fails is rejected with the reason in the history and current stays", async () => {
  const dir = join(f.home, "snapshots");
  const aside = `${dir}.aside`;
  renameSync(dir, aside);
  writeFileSync(dir, "not a folder"); // the snapshot cannot make its folder
  try {
    const cur = currentOf(f.home);
    const good = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v-snap", ""), "good but no snapshot");
    const r = await promote(ctx, good, FAST);
    expect(r).toMatchObject({ action: "rejected", ok: false, to: good, from: cur });
    expect(r.reason).toStartWith("could not take the database snapshot: ");
    expect(readHistory(f.home).at(-1)).toEqual(r);
    expect(currentOf(f.home)).toBe(cur);
  } finally {
    rmSync(dir, { force: true });
    renameSync(aside, dir);
  }
}, 30_000);

test("a promotion whose candidate cannot be set up is rejected with the reason in the history and current stays", async () => {
  const was = process.env.TMPDIR;
  process.env.TMPDIR = join(f.root, "no-such-temp"); // the candidate cannot make its home
  try {
    const cur = currentOf(f.home);
    const good = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v-cand", ""), "good but no candidate home");
    const r = await promote(ctx, good, FAST);
    expect(r).toMatchObject({ action: "rejected", ok: false, to: good, from: cur });
    expect(r.reason).toStartWith("could not start the candidate: ");
    expect(readHistory(f.home).at(-1)).toEqual(r);
    expect(currentOf(f.home)).toBe(cur);
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
}, 30_000);

test("from a source repository (no git): promote by tag builds from the tarball, the page lists tags, rollback goes back; a wrong tarball is rejected without a build", async () => {
  const short = (sha: string) => sha.slice(0, 7);
  const tarOf = async (tag: string, top: string, daemon: string) => {
    const sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource(daemon), tag);
    const head = (await run(["git", "rev-parse", "HEAD"], f.repo)) as string;
    const out = join(f.root, `${tag}-${top}.tgz`);
    await run(["git", "archive", "--format=tar.gz", `--prefix=${top === "ok" ? `o-n-${short(head)}` : top}/`, "-o", out, head], f.repo);
    return { sha: head, out, parent: sha };
  };
  const t2 = await tarOf("v0.2.0", "ok", "s2");
  const t3 = await tarOf("v0.3.0", "ok", "s3");
  const t3other = await tarOf("v0.3.1", "o-n-fffffff", "s31"); // the top directory names another commit
  const shaOf: Record<string, string> = { "v0.2.0": t2.sha, "v0.3.0": t3.sha, "v0.3.1": t3other.sha };
  const files: Record<string, string> = { "v0.2.0": t2.out, "v0.3.0": t3.out, "v0.3.1": t3other.out };
  let cut = false;
  let down = false;
  const api = Bun.serve({
    port: 0,
    fetch(req) {
      const parts = new URL(req.url).pathname.split("/");
      const tag = parts.at(-1) ?? "";
      if (down) return new Response("unavailable", { status: 503 });
      if (parts[4] === "commits") return shaOf[tag] ? Response.json({ sha: shaOf[tag] }) : new Response("no", { status: 404 });
      const body = readFileSync(files[tag]!);
      return new Response(cut ? body.subarray(0, 30) : body, { headers: { "content-length": String(body.length) } });
    },
  });
  const home = join(f.root, "home-src");
  mkdirSync(home, { recursive: true });
  const bin = join(f.root, "bin-no-git"); // tar, gzip and mkdir (the fixture build), nothing else: a git that is called is not found
  mkdirSync(bin, { recursive: true });
  for (const tool of ["tar", "gzip", "mkdir"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  const oldPath = process.env.PATH;
  const port = await freePort();
  const sup = new Supervisor({ home, repo: join(home, "releases", "current"), source: "o/n", port, backoffMs: 50 });
  const sctx: Ctx = { home, repo: join(home, "releases", "current"), source: "o/n", port, sup };
  process.env.SWITCHBOARD_GITHUB_API = `http://localhost:${api.port}`;
  process.env.PATH = bin;
  try {
    expect(await promote(sctx, "v0.2.0", FAST)).toMatchObject({ action: "promote", ok: true, from: null, to: t2.sha });
    expect(await promote(sctx, "v0.3.0", FAST)).toMatchObject({ action: "promote", ok: true, from: t2.sha, to: t3.sha });
    expect([currentOf(home), previousOf(home)]).toEqual([t3.sha, t2.sha]);
    const h = await until(() => health(port), "s3 up");
    expect([h.version, h.repoRoot]).toEqual(["s3", realpathSync(join(home, "releases", "current"))]);
    expect(JSON.parse(readFileSync(join(home, "releases", t3.sha, ".release.json"), "utf8"))).toEqual({ tag: "v0.3.0", sha: t3.sha });

    const rescue = startRescue(sctx, { port: 0 });
    const base = `http://127.0.0.1:${rescue.server.port}`;
    try {
      const st = (await fetch(`${base}/api/status`).then((r) => r.json())) as { releases: Array<{ sha: string; subject: string; tag: string | null }> };
      expect(st.releases.map((r) => [r.tag, r.subject]).sort()).toEqual([["v0.2.0", "v0.2.0"], ["v0.3.0", "v0.3.0"]]);
      expect((await fetch(`${base}/api/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(202);
      await until(() => currentOf(home) === t2.sha && health(port).then((x) => x?.version === "s2"), "back to s2");
    } finally {
      await rescue.stop();
    }

    // rejected without building: nothing new under releases/, and the reason is in the history
    const before = readdirSync(join(home, "releases")).sort();
    const bad = async (tag: string) => {
      const r = await promote(sctx, tag, FAST);
      expect(r).toMatchObject({ action: "rejected", ok: false });
      expect(readdirSync(join(home, "releases")).sort()).toEqual(before);
      return r.reason;
    };
    expect(await bad("v0.3.1")).toContain("is not the tree of");
    // the caller checked another commit than the tag now points at: nothing is built
    const moved = await promote(sctx, "v0.3.0", FAST, "f".repeat(40));
    expect(moved).toMatchObject({ action: "rejected", ok: false });
    expect(moved.reason).toContain("checked version");
    expect(moved.to).toBe("f".repeat(40)); // the commit the daemon asked for: it finds the failure by commit
    // GitHub not reached (a limit, a server error): the version is held like any failure, named by the checked commit
    down = true;
    const unreached = await promote(sctx, "v0.3.0", FAST, "f".repeat(40));
    down = false;
    expect([unreached.action, unreached.to]).toEqual(["rejected", "f".repeat(40)]); // held like any failure: the daemon reports it
    // a download cut short is held the same way (a stub fetch: Bun.serve sets content-length itself)
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("/tarball/") ? new Response("short", { headers: { "content-length": "999" } }) : realFetch(url, init)) as typeof fetch;
    let cutShort: Awaited<ReturnType<typeof promote>>;
    try {
      cutShort = await promote(sctx, "v0.3.1", FAST, t3other.sha);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect([cutShort.action, cutShort.to]).toEqual(["rejected", t3other.sha]);
    expect(cutShort.reason).toContain("cut short");
    expect(readdirSync(join(home, "releases")).sort()).toEqual(before);
    expect(readdirSync(join(home, "releases")).sort()).toEqual(before);
    expect(await bad("v0.3.0-rc")).toContain("version tag");
    cut = true;
    expect(await bad("v0.3.1")).toMatch(/cut short|unexpected end of file/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.SWITCHBOARD_GITHUB_API;
    await sup.stop();
    api.stop(true);
  }
}, 120_000);

// A release whose difference from the running daemon's is only the Web UI is read again by the daemon (SIGHUP), not restarted.
// These tests share one repository and one running daemon, one after the other: what the daemon started from moves only with a restart.
let w: Awaited<ReturnType<typeof makeRepo>> & { ctx: Ctx; web: (page: string, extra?: Record<string, string>) => Promise<string> };
const webTimes = { ...FAST, webMs: 2500 };
const rootPage = async (port: number) => (await fetch(`http://127.0.0.1:${port}/`)).text();
async function webFixture() {
  if (w) return w;
  const g = await makeRepo();
  switchTo(g.home, await buildRelease(g.repo, "HEAD", g.home));
  const port = await freePort();
  const wctx: Ctx = { home: g.home, repo: g.repo, source: null, port, sup: new Supervisor({ home: g.home, repo: g.repo, port, backoffMs: 50 }) };
  wctx.sup.start();
  await until(() => health(port), "web fixture up");
  // The Web UI of a release is what its build writes from `page.txt` (the daemon serves apps/web/dist/index.html).
  const web = async (page: string, extra: Record<string, string> = {}) => {
    for (const [name, content] of Object.entries(extra)) writeFileSync(join(g.repo, name), content);
    const pkg = { name: "web", private: true, scripts: { build: "mkdir -p dist && cp page.txt dist/index.html" } };
    writeFileSync(join(g.repo, "apps", "web", "package.json"), JSON.stringify(pkg));
    return commitFile(g.repo, "apps/web/page.txt", page, `web ${page}`);
  };
  return (w = { ...g, ctx: wctx, web });
}
afterAll(async () => {
  if (!w) return;
  await w.ctx.sup.stop();
  rmSync(w.root, { recursive: true, force: true });
});

test("restartNeeded: only files under apps/web/ and packages/core/config/ are read again; anything else, or no way to compare, means a restart", async () => {
  const g = await webFixture();
  const base = g.v1;
  const ui = await g.web("ui0");
  const config = await commitFile(g.repo, "packages/core/config/routing.yaml", "a: 1\n", "config");
  const mixed = await commitFile(g.repo, "bun.lock-ish.txt", "x", "outside");
  const core = await commitFile(g.repo, "packages/core/src/main.ts", daemonSource("v1", "// touched"), "core touched");
  expect(await restartNeeded(g.repo, base, ui)).toBe(false);
  expect(await restartNeeded(g.repo, base, config)).toBe(false); // the default settings count as the Web UI
  expect(await restartNeeded(g.repo, base, mixed)).toBe(true); // one file outside is enough, though the others are inside
  expect(await restartNeeded(g.repo, ui, config)).toBe(false);
  expect(await restartNeeded(g.repo, base, core)).toBe(true);
  expect(await restartNeeded(g.repo, ui, ui)).toBe(true); // nothing differs: nothing to read again
  expect(await restartNeeded(g.repo, null, ui)).toBe(true); // the daemon is not known to have started from anything
  expect(await restartNeeded(g.repo, "0".repeat(40), ui)).toBe(true); // git cannot compare
  expect(await restartNeeded(join(g.root, "not-a-repo"), base, ui)).toBe(true);
  await run(["git", "reset", "-q", "--hard", base], g.repo); // the other tests build on the first release, not on these commits
});

test("a Web UI only release is read again by the running daemon: same process, new page, history says so; a later release with core changes restarts it", async () => {
  const g = await webFixture();
  const pid = (await health(g.ctx.port))!.pid;
  writeFileSync(join(g.home, "busy"), ""); // a task is running: a restart would stop it
  const w1 = await g.web("UI one");
  const r = await promote(g.ctx, w1, webTimes);
  expect(r).toMatchObject({ action: "promote-web", ok: true, from: g.v1, to: w1 });
  expect(g.ctx.sup.running).toBe(g.v1); // the daemon was not started again
  const h = (await health(g.ctx.port))!;
  expect([h.pid, h.webRelease, currentOf(g.home), previousOf(g.home)]).toEqual([pid, w1, w1, g.v1]);
  expect(await rootPage(g.ctx.port)).toBe("UI one");
  expect(readHistory(g.home).at(-1)).toEqual(r);

  // compared with what the daemon started from (v1), not with the Web UI release before: this one differs in core code
  const core = await commitFile(g.repo, "packages/core/src/main.ts", daemonSource("v2"), "core");
  expect(await promote(g.ctx, core, webTimes)).toMatchObject({ action: "promote", ok: true, to: core });
  const after = (await until(() => health(g.ctx.port), "restarted"))!;
  expect([after.pid === pid, after.version, g.ctx.sup.running]).toEqual([false, "v2", core]);

  // and the next Web UI release is compared with the core release that runs now: no restart, and what it started from stays on disk
  const w2 = await g.web("UI two");
  const second = await promote(g.ctx, w2, webTimes);
  expect(second).toMatchObject({ action: "promote-web", ok: true, from: core, to: w2 });
  expect([(await health(g.ctx.port))!.pid, g.ctx.sup.running]).toEqual([after.pid, core]);
  rmSync(join(g.home, "busy"));
});

test("a file outside apps/web/ in the difference means a restart, also when the Web UI changed too", async () => {
  const g = await webFixture();
  const pid = (await health(g.ctx.port))!.pid;
  const mixed = await g.web("UI mixed", { "notes.txt": "outside the web ui" });
  expect(await promote(g.ctx, mixed, webTimes)).toMatchObject({ action: "promote", ok: true, to: mixed });
  const h = (await until(() => health(g.ctx.port), "restarted"))!;
  expect([h.pid === pid, g.ctx.sup.running, await rootPage(g.ctx.port)]).toEqual([false, mixed, "UI mixed"]);
});

test("a Web UI only release whose candidate fails is rejected and nothing moves; one the daemon does not take up is put back", async () => {
  const g = await webFixture();
  const pid = (await health(g.ctx.port))!.pid;
  const was = currentOf(g.home);
  const bad = await g.web("BAD page");
  expect(await promote(g.ctx, bad, webTimes)).toMatchObject({ action: "rejected", ok: false, to: bad });
  expect([currentOf(g.home), (await health(g.ctx.port))!.pid]).toEqual([was, pid]);

  writeFileSync(join(g.home, "no-reload"), ""); // SIGHUP changes nothing: the daemon keeps serving the old release
  const stuck = await g.web("UI stuck");
  const r = await promote(g.ctx, stuck, webTimes);
  expect(r).toMatchObject({ action: "auto-rollback", ok: false, from: stuck, to: was });
  expect(r.reason).toContain("did not report");
  // going back restarts the daemon on the older release: a fresh process serves the older page
  const back = (await until(() => health(g.ctx.port), "restarted on the older release"))!;
  expect([currentOf(g.home), back.pid === pid, g.ctx.sup.running, await rootPage(g.ctx.port)]).toEqual([was, false, was, "UI mixed"]);
  rmSync(join(g.home, "no-reload"));
});

test("a daemon that does not report its web release is not sent SIGHUP: the release is switched by a restart", async () => {
  const g = await webFixture();
  const pid = (await health(g.ctx.port))!.pid;
  writeFileSync(join(g.home, "no-web-release"), ""); // an old daemon, for which SIGHUP would end the process
  const rescue = startRescue(g.ctx, { port: 0 });
  try {
    const ui = await g.web("UI old daemon");
    const ask = await fetch(`http://127.0.0.1:${rescue.server.port}/api/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: ui, ifNoRestart: true }) });
    expect(ask.status).toBe(409);
    expect(await ask.json()).toEqual({ error: "this release needs a restart", restart: true });
    expect(currentOf(g.home)).not.toBe(ui);
    // the question is asked again after the build and the candidate: a caller that asked for no restart never gets one
    const was = currentOf(g.home);
    const history = readHistory(g.home).length;
    await expect(promote(g.ctx, ui, webTimes, undefined, true)).rejects.toThrow("needs a restart now");
    expect([currentOf(g.home), (await health(g.ctx.port))!.pid, readHistory(g.home).length]).toEqual([was, pid, history]);
    expect(await promote(g.ctx, ui, webTimes)).toMatchObject({ action: "promote", ok: true, to: ui });
    expect((await until(() => health(g.ctx.port), "restarted"))!.pid).not.toBe(pid);
  } finally {
    await rescue.stop();
    rmSync(join(g.home, "no-web-release"), { force: true });
  }
});

test("ifNoRestart on a Web UI only release is taken: 202, the running daemon reads it again, its process and tasks stay", async () => {
  const g = await webFixture();
  const pid = (await health(g.ctx.port))!.pid;
  writeFileSync(join(g.home, "busy"), "");
  const rescue = startRescue(g.ctx, { port: 0 });
  try {
    const ui = await g.web("UI asked quietly");
    const ask = await fetch(`http://127.0.0.1:${rescue.server.port}/api/promote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commit: ui, ifNoRestart: true }) });
    expect(ask.status).toBe(202);
    const done = await until(() => readHistory(g.home).find((e) => e.to === ui), "promoted", 30_000);
    expect(done).toMatchObject({ action: "promote-web", ok: true });
    expect([(await health(g.ctx.port))!.pid, await rootPage(g.ctx.port)]).toEqual([pid, "UI asked quietly"]);
  } finally {
    await rescue.stop();
    rmSync(join(g.home, "busy"), { force: true });
  }
});

test("a daemon that dies on SIGHUP and is started again by the supervisor is not a switch without a restart: it goes back, and says why", async () => {
  const g = await webFixture();
  const was = currentOf(g.home);
  const pid = (await health(g.ctx.port))!.pid;
  writeFileSync(join(g.home, "die-on-reload"), ""); // reports webRelease, but SIGHUP ends it; the retry starts from the new current
  try {
    const ui = await g.web("UI crash");
    const r = await promote(g.ctx, ui, webTimes);
    expect(r).toMatchObject({ action: "auto-rollback", ok: false, from: ui, to: was });
    expect(r.reason).toMatch(/did not survive the reload|stopped after the reload/); // which one depends on whether the retry has started yet
    expect(currentOf(g.home)).toBe(was);
  } finally {
    rmSync(join(g.home, "die-on-reload"), { force: true });
  }
  expect((await until(() => health(g.ctx.port), "started again"))!.pid).not.toBe(pid);
});
