// test-reads: none
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { seedWorkspaces } from "./server/helpers.ts";
import { loadConfig, type CoreConfig } from "./config.ts";

// The meta workspace the daemon registers at each start: one row, at the repo root this start was given. A second meta
// row left at a removed release's directory would be the one read (the first by name), and every Task started or resumed
// would get that release's hook path, which no longer exists, so all its Bash calls would be blocked.

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

const open = () => {
  root = mkdtempSync(join(tmpdir(), "switchboard.meta."));
  return new Db(join(root, "db.sqlite"));
};
const seed = (db: Db, repoRoot: string) => seedWorkspaces(db, { repoRoot } as CoreConfig);
const metas = (db: Db) => db.listWorkspaces().filter((w) => w.kind === "meta");
const inUse = (db: Db) => db.listWorkspaces().find((w) => w.kind === "meta")?.id;
const mkTask = (id: string, workspaceId: string | null, cwd: string, scope: string[]): Task => {
  const at = Date.now();
  return { id, workspaceId, title: "t", stage: null, runner: "claude", cwd, scope, status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
};

test("on an install from a Release, the meta row at a release directory moves to releases/current and keeps its id", () => {
  const db = open();
  seed(db, `/h/releases/${"f".repeat(40)}`);
  const [first] = metas(db);
  seed(db, "/h/releases/current");
  expect(metas(db)).toEqual([expect.objectContaining({ id: first!.id, path: "/h/releases/current", name: "current" })]);
  seed(db, "/h/releases/current");
  expect(metas(db).map((w) => w.id)).toEqual([first!.id]);
});

test("the meta row in use at a release that is still kept moves too, with its settings and Tasks", () => {
  const db = open();
  const rel = join(root, "releases");
  const kept = join(rel, "a".repeat(40));
  mkdirSync(kept, { recursive: true });
  const used = db.upsertWorkspace({ name: "a".repeat(40), path: kept, kind: "meta" });
  db.setWorkspaceRules(used.id, "the person's rules");
  db.insertTask(mkTask("t1", used.id, kept, [kept]));
  seed(db, join(rel, "current"));
  expect(db.listWorkspaces().find((w) => w.kind === "meta")).toMatchObject({ id: used.id, rules: "the person's rules", path: join(rel, "current") });
  expect(db.getTask("t1")?.cwd).toBe(join(rel, "current"));
});

test("of the meta rows earlier releases left, the one read so far is moved, the others become repos and their Tasks join it", () => {
  const db = open();
  const newer = db.upsertWorkspace({ name: "9".repeat(40), path: `/h/releases/${"9".repeat(40)}`, kind: "meta" });
  const read = db.upsertWorkspace({ name: "0".repeat(40), path: `/h/releases/${"0".repeat(40)}`, kind: "meta" });
  db.insertTask(mkTask("t1", read.id, `/h/releases/${"0".repeat(40)}`, [`/h/releases/${"0".repeat(40)}`]));
  db.insertTask(mkTask("t2", newer.id, `/h/releases/${"9".repeat(40)}/sub`, [`/h/releases/${"9".repeat(40)}/sub`, "/r/other"]));
  db.insertTask(mkTask("t3", null, `/h/releases/${"0".repeat(40)}x`, [`/h/releases/${"0".repeat(40)}x`]));
  expect(inUse(db)).toBe(read.id);
  seed(db, "/h/releases/current");
  expect(metas(db).map((w) => [w.id, w.path])).toEqual([[read.id, "/h/releases/current"]]);
  expect(db.getWorkspace(newer.id)?.kind).toBe("repo");
  expect([db.getTask("t1")?.cwd, db.getTask("t1")?.scope, db.getTask("t1")?.workspaceId]).toEqual(["/h/releases/current", ["/h/releases/current"], read.id]);
  expect([db.getTask("t2")?.cwd, db.getTask("t2")?.scope, db.getTask("t2")?.workspaceId]).toEqual(["/h/releases/current/sub", ["/h/releases/current/sub", "/r/other"], read.id]);
  // a path that only shares the prefix is not under the release
  expect([db.getTask("t3")?.cwd, db.getTask("t3")?.scope]).toEqual([`/h/releases/${"0".repeat(40)}x`, [`/h/releases/${"0".repeat(40)}x`]]);
});

test("with a checkout, the earlier meta row (gone or not) is not moved: a new row is the meta, the old one a repo with its Tasks as they were", () => {
  const db = open();
  const other = join(root, "other");
  mkdirSync(other);
  const old = db.upsertWorkspace({ name: "other", path: other, kind: "meta" });
  const gone = db.upsertWorkspace({ name: "gone", path: "/r/gone", kind: "meta" });
  db.insertTask(mkTask("t1", old.id, other, [other]));
  db.insertTask(mkTask("t2", gone.id, "/r/gone", ["/r/gone"]));
  seed(db, "/r/switchboard");
  expect(metas(db).map((w) => w.path)).toEqual(["/r/switchboard"]);
  expect([db.getWorkspace(old.id)?.kind, db.getWorkspace(gone.id)?.kind]).toEqual(["repo", "repo"]);
  expect([db.getTask("t1")?.cwd, db.getTask("t2")?.cwd, db.getTask("t2")?.scope]).toEqual([other, "/r/gone", ["/r/gone"]]);
});

test("a repo already registered at the path becomes the meta workspace, and the old meta a repo", () => {
  const db = open();
  const meta = db.upsertWorkspace({ name: "a", path: "/r/a", kind: "meta" });
  const repo = db.upsertWorkspace({ name: "b", path: "/r/b", kind: "repo" });
  seed(db, "/r/b");
  expect(metas(db).map((w) => w.id)).toEqual([repo.id]);
  expect(db.getWorkspace(meta.id)?.kind).toBe("repo");
});

test("a checkout named current is not a Release install: a meta row at a sibling checkout is not moved", () => {
  const db = open();
  const src = join(root, "src");
  mkdirSync(join(src, "switchboard"), { recursive: true });
  const old = db.upsertWorkspace({ name: "switchboard", path: join(src, "switchboard"), kind: "meta" });
  db.insertTask(mkTask("t1", old.id, join(src, "switchboard"), [join(src, "switchboard")]));
  seed(db, join(src, "current"));
  expect(db.getWorkspace(old.id)).toMatchObject({ kind: "repo", path: join(src, "switchboard") });
  expect([db.getTask("t1")?.cwd, db.getTask("t1")?.workspaceId]).toEqual([join(src, "switchboard"), old.id]);
});

test("an sb-rescue from before the link (it names the release directory) still gets the link: the rows of earlier releases fold into it", () => {
  const db = open();
  const rel = join(root, "home", "releases");
  const [a, b] = ["0".repeat(40), "9".repeat(40)];
  mkdirSync(join(rel, a), { recursive: true });
  mkdirSync(join(rel, b));
  symlinkSync(b, join(rel, "current"));
  const used = db.upsertWorkspace({ name: a, path: join(rel, a), kind: "meta" });
  db.insertTask(mkTask("t1", used.id, join(rel, a), [join(rel, a)]));
  seedWorkspaces(db, loadConfig({ SWITCHBOARD_HOME: join(root, "home"), SWITCHBOARD_REPO_ROOT: join(rel, b) }));
  expect(metas(db).map((w) => [w.id, w.path])).toEqual([[used.id, join(rel, "current")]]);
  expect(db.getTask("t1")?.cwd).toBe(join(rel, "current"));
});
