// test-reads: packages/core/src/config.ts
// The promotion candidate on the disk: its home holds what is its own (the database copy, its Knowledge), a leftover does
// not stop the next one, and the live database is never written. The real tryCandidate / promote.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFile, daemonSource, freePort, makeRepo } from "./fixture.ts";
import { promote, snapshotDb, tryCandidate, type Ctx } from "./promote.ts";
import { buildRelease, readHistory, switchTo } from "./releases.ts";
import { Supervisor } from "./supervisor.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
let ctx: Ctx;
let home: string;
const saved = { knowledge: process.env.SWITCHBOARD_KNOWLEDGE, db: process.env.SWITCHBOARD_DB };

const newDb = (path: string) => {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; create table notes (name text)");
  db.close();
};

beforeAll(async () => {
  delete process.env.SWITCHBOARD_KNOWLEDGE; // aws/host/switchboard.service sets none
  delete process.env.SWITCHBOARD_DB;
  f = await makeRepo();
  home = mkdtempSync(join(tmpdir(), "sb-candidate-home-"));
  switchTo(home, await buildRelease(f.repo, "HEAD", home));
  newDb(join(home, "switchboard.db"));
  const port = await freePort();
  ctx = { home, repo: f.repo, source: null, port, sup: new Supervisor({ home, repo: f.repo, port, backoffMs: 50 }) };
}, 60_000);

afterAll(() => {
  if (saved.knowledge === undefined) delete process.env.SWITCHBOARD_KNOWLEDGE;
  else process.env.SWITCHBOARD_KNOWLEDGE = saved.knowledge;
  if (saved.db === undefined) delete process.env.SWITCHBOARD_DB;
  else process.env.SWITCHBOARD_DB = saved.db;
  if (home) rmSync(home, { recursive: true, force: true });
  if (f) rmSync(f.root, { recursive: true, force: true });
});

test("the candidate's Knowledge folder is inside its throwaway home", async () => {
  // the candidate resolves its configuration with the real core loadConfig, prints it and exits
  const config = resolve(import.meta.dir, "../../packages/core/src/config.ts");
  const probe = `{ const { loadConfig } = await import(${JSON.stringify(config)}); console.log("KNOWLEDGE=" + loadConfig().knowledgeDir); process.exit(3); }`;
  const sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("probe", probe), "probe");
  await buildRelease(f.repo, sha, home);
  // sb-rescue's own value, and the default the candidate would take from a home that is no temp folder, are the user's notes
  process.env.SWITCHBOARD_KNOWLEDGE = join(home, "the-users-Knowledge");
  try {
    const reason = await tryCandidate(ctx, sha, await snapshotDb(home, "knowledge"), 8000);
    expect(/KNOWLEDGE=(.*)/.exec(reason ?? "")?.[1]).toBe(join(home, `candidate-${process.pid}`, "Knowledge"));
  } finally {
    delete process.env.SWITCHBOARD_KNOWLEDGE;
  }
}, 60_000);

test("a candidate home left under this process id by a killed run does not stop the next candidate", async () => {
  const left = join(home, `candidate-${process.pid}`);
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, "switchboard.db"), "left by a killed run whose pid this process now has");
  try {
    const sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("same-pid"), "same pid");
    await buildRelease(f.repo, sha, home);
    expect(await tryCandidate(ctx, sha, await snapshotDb(home, "same-pid"), 8000)).toBeNull();
  } finally {
    rmSync(left, { recursive: true, force: true });
  }
}, 60_000);

test("a leftover candidate home is removed also when the promotion stops at the database snapshot", async () => {
  const orphan = join(home, "candidate-99999999");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "switchboard.db"), "a copy of the database holding the room the snapshot needs");
  rmSync(join(home, "snapshots"), { recursive: true, force: true });
  writeFileSync(join(home, "snapshots"), "not a folder"); // the snapshot step fails, as it does on a full disk
  try {
    const sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("next"), "next");
    const r = await promote(ctx, sha, { candidateMs: 8000 });
    expect(r.reason).toStartWith("could not take the database snapshot: ");
    expect(existsSync(orphan)).toBe(false);
  } finally {
    rmSync(join(home, "snapshots"), { force: true });
    rmSync(orphan, { recursive: true, force: true });
  }
}, 60_000);

test("with SWITCHBOARD_DB set, checking a candidate leaves the live database as it is", async () => {
  const live = join(home, "moved.db");
  newDb(live);
  process.env.SWITCHBOARD_DB = live;
  try {
    const sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("moved-db"), "moved db");
    await buildRelease(f.repo, sha, home);
    const snapshot = await snapshotDb(home, "moved-db");
    const after = new Database(live);
    after.exec("insert into notes values ('written after the snapshot')");
    after.close();
    const inode = statSync(live).ino;
    expect(await tryCandidate(ctx, sha, snapshot, 8000)).toBeNull();
    const db = new Database(live, { readonly: true });
    const rows = db.query("select name from notes").all();
    db.close();
    expect({ sameFile: statSync(live).ino === inode, rows }).toEqual({ sameFile: true, rows: [{ name: "written after the snapshot" }] });
  } finally {
    delete process.env.SWITCHBOARD_DB;
  }
}, 60_000);

/** The snapshot step fails, as it does on a full disk. */
const breakSnapshots = () => {
  rmSync(join(home, "snapshots"), { recursive: true, force: true });
  writeFileSync(join(home, "snapshots"), "not a folder");
};
let sha: string;
beforeAll(async () => {
  sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("after-leftovers"), "after leftovers");
  await buildRelease(f.repo, sha, home);
}, 60_000);

test("a leftover that cannot be removed still ends in a rejection recorded in the history", async () => {
  const orphan = join(home, "candidate-99999999");
  mkdirSync(join(orphan, "locked", "inner"), { recursive: true });
  chmodSync(join(orphan, "locked"), 0);
  breakSnapshots(); // never reaches a real switch
  try {
    const r = await promote(ctx, sha, { candidateMs: 8000 });
    expect(r).toMatchObject({ action: "rejected", ok: false });
    expect(readHistory(home).at(-1)).toEqual(r);
  } finally {
    chmodSync(join(orphan, "locked"), 0o700);
    rmSync(orphan, { recursive: true, force: true });
    rmSync(join(home, "snapshots"), { force: true });
  }
}, 60_000);

test("a leftover under this process id is removed also when the promotion stops at the database snapshot", async () => {
  const own = join(home, `candidate-${process.pid}`);
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "switchboard.db"), "a copy left by a killed sb-rescue whose pid came back");
  breakSnapshots();
  try {
    const r = await promote(ctx, sha, { candidateMs: 8000 });
    expect(r.reason).toStartWith("could not take the database snapshot: ");
    expect(existsSync(own)).toBe(false);
  } finally {
    rmSync(own, { recursive: true, force: true });
    rmSync(join(home, "snapshots"), { force: true });
  }
}, 60_000);

test("a leftover is removed also when the promotion stops at the build", async () => {
  const orphan = join(home, "candidate-99999999");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "switchboard.db"), "a copy holding the room the build needs");
  try {
    const r = await promote(ctx, "no-such-revision", { candidateMs: 8000 }); // the build fails, as it does on a full disk
    expect(r.reason).toStartWith("could not build the release: ");
    expect(existsSync(orphan)).toBe(false);
  } finally {
    rmSync(orphan, { recursive: true, force: true });
  }
}, 60_000);

test("the removable leftovers are removed at the start of a promotion even when another one cannot be", async () => {
  // several that cannot be removed, so that some come before the removable ones in whatever order the folder is read
  // (made before and after the removable ones too: a tmpfs lists the newest first)
  const stuck = Array.from({ length: 10 }, (_, i) => join(home, `candidate-${999999800 + i}`));
  const lock = (s: string) => {
    mkdirSync(join(s, "locked", "inner"), { recursive: true });
    chmodSync(join(s, "locked"), 0);
  };
  stuck.slice(0, 5).forEach(lock);
  const others = [`candidate-${process.pid}`, ...Array.from({ length: 20 }, (_, i) => `candidate-${999999900 + i}`)];
  for (const name of others) {
    mkdirSync(join(home, name));
    writeFileSync(join(home, name, "switchboard.db"), "a whole copy of the database");
  }
  stuck.slice(5).forEach(lock);
  rmSync(join(home, "snapshots"), { recursive: true, force: true });
  writeFileSync(join(home, "snapshots"), "not a folder"); // the snapshot step fails, as on a full disk
  try {
    const r = await promote(ctx, sha, { candidateMs: 8000 });
    expect(r.action).toBe("rejected");
    expect(others.filter((n) => existsSync(join(home, n)))).toEqual([]);
  } finally {
    for (const s of stuck) chmodSync(join(s, "locked"), 0o700);
    for (const path of [...stuck, ...others.map((n) => join(home, n))]) rmSync(path, { recursive: true, force: true });
    rmSync(join(home, "snapshots"), { force: true });
  }
}, 60_000);
