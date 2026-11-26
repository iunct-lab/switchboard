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

test("of the meta rows earlier releases left, the one read so far is moved, the others are removed and their Tasks join it", () => {
  const db = open();
  const newer = db.upsertWorkspace({ name: "9".repeat(40), path: `/h/releases/${"9".repeat(40)}`, kind: "meta" });
  const read = db.upsertWorkspace({ name: "0".repeat(40), path: `/h/releases/${"0".repeat(40)}`, kind: "meta" });
  db.insertTask(mkTask("t1", read.id, `/h/releases/${"0".repeat(40)}`, [`/h/releases/${"0".repeat(40)}`]));
  db.insertTask(mkTask("t2", newer.id, `/h/releases/${"9".repeat(40)}/sub`, [`/h/releases/${"9".repeat(40)}/sub`, "/r/other"]));
  db.insertTask(mkTask("t3", null, `/h/releases/${"0".repeat(40)}x`, [`/h/releases/${"0".repeat(40)}x`]));
  expect(inUse(db)).toBe(read.id);
  seed(db, "/h/releases/current");
  expect(metas(db).map((w) => [w.id, w.path])).toEqual([[read.id, "/h/releases/current"]]);
  expect(db.getWorkspace(newer.id)).toBeFalsy();
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

// An install from a Release: sb-rescue hands the daemon `<home>/releases/current`, and every update switches the link to a
// new release directory. The one meta row stays at the link, and the rows earlier versions left at release directories
// (meta ones, and the ones a version before this turned into repos) are folded into it with everything that named them.
const releaseHome = () => {
  const home = join(root, "home");
  const rel = join(home, "releases");
  const [a, b] = [join(rel, "a".repeat(40)), join(rel, "b".repeat(40))];
  mkdirSync(a, { recursive: true });
  mkdirSync(b);
  symlinkSync(a, join(rel, "current"));
  const env = { SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(rel, "current"), SWITCHBOARD_RESCUE_URL: "http://127.0.0.1:47841", SWITCHBOARD_PORT: "0" };
  return { home, rel, a, b, env };
};
const switchTo = (rel: string, dir: string) => {
  rmSync(join(rel, "current"));
  symlinkSync(dir, join(rel, "current"));
};
const rawOf = (db: Db) => (db as unknown as { sqlite: import("bun:sqlite").Database }).sqlite;
const mkSchedule = (id: string, workspaceId: string) => ({ id, title: id, cron: "@nightly", workspaceId, runner: "claude", model: "", effort: "", prompt: "p", action: "prompt", budgetUsd: null, enabled: true, lastRunAt: null, lastTaskId: null, nextRunAt: null, lastResult: null, stuck: null, createdAt: Date.now() }) as never;

test("releaseOnly: sb-rescue's link is a Release install; a checkout, a run without sb-rescue and a candidate are not", () => {
  open();
  const { rel, b, env } = releaseHome();
  expect(loadConfig(env).releaseOnly).toBe(true);
  // an sb-rescue from before the link names the release directory: it is read as the link
  expect(loadConfig({ ...env, SWITCHBOARD_REPO_ROOT: b }).releaseOnly).toBe(true);
  expect(loadConfig({ ...env, SWITCHBOARD_RESCUE_URL: undefined }).releaseOnly).toBe(false);
  expect(loadConfig({ ...env, SWITCHBOARD_REPO_ROOT: join(root, "checkout") }).releaseOnly).toBe(false);
  expect(loadConfig({ ...env, SWITCHBOARD_REPO_ROOT: b, SWITCHBOARD_CANDIDATE: "1" }).releaseOnly).toBe(false);
  expect(loadConfig(env).repoRoot).toBe(join(rel, "current"));
});

test("release-only: an update from A to B adds no row; the one meta row stays at the link with its id", () => {
  const db = open();
  const { rel, b, env } = releaseHome();
  seedWorkspaces(db, loadConfig(env));
  const [first] = metas(db);
  switchTo(rel, b);
  seedWorkspaces(db, loadConfig(env));
  expect(db.listWorkspaces()).toEqual([expect.objectContaining({ id: first!.id, kind: "meta", path: join(rel, "current") })]);
});

test("release-only: rows left by earlier versions become one and keep their tasks and schedules", () => {
  const db = open();
  const { rel, env } = releaseHome();
  const dir = (c: string) => join(rel, c.repeat(40));
  // two meta rows, and one an earlier version of this fold turned into a repo
  const rows = [["1", "meta"], ["2", "meta"], ["3", "repo"]].map(([c, kind]) => {
    const w = db.upsertWorkspace({ name: c!.repeat(40), path: dir(c!), kind: kind as "meta" | "repo" });
    db.insertTask(mkTask(`t${c}`, w.id, dir(c!), [dir(c!)]));
    db.insertSchedule(mkSchedule(`s${c}`, w.id));
    rawOf(db).query("INSERT INTO routing_log (task_id, workspace_id, cwd, suggested, rule_id, reason, chosen, ts, suggested_by) VALUES (?, ?, ?, 'claude', 'r', 'x', 'claude', 1, 'rule')").run(`t${c}`, w.id, dir(c!));
    rawOf(db).query("INSERT INTO workspace_config_changes (workspace_id, at, source, keys, state) VALUES (?, 1, 'ui', '[]', 'confirmed')").run(w.id);
    db.upsertRequestEval(w.id, c === "1" ? 7 : 8, { ts: 5 } as never);
    return w;
  });
  db.upsertRequestEval(rows[1]!.id, 7, { ts: 9 } as never); // the same request evaluated under a row that goes: the kept row's entry stays
  // a change still waiting under a row that goes has nothing left to change (its before is that row's settings): it is closed, as on removal
  rawOf(db).query("INSERT INTO workspace_config_changes (workspace_id, at, source, keys, state) VALUES (?, 2, 'ui', '[]', 'pending')").run(rows[1]!.id);
  db.setSetting("backlogQueue", { enabled: true, concurrency: 1, items: [{ workspaceId: rows[2]!.id, number: 5 }, { workspaceId: rows[0]!.id, number: 5 }, { workspaceId: rows[1]!.id, number: 6 }], ended: [{ workspaceId: rows[1]!.id, number: 4 }] });
  const other = db.upsertWorkspace({ name: "other", path: join(root, "other"), kind: "repo" });
  db.insertTask(mkTask("tother", other.id, join(root, "other"), []));
  const before = (t: string) => (rawOf(db).query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const [tasks, schedules] = [before("tasks"), before("schedules")];

  seedWorkspaces(db, loadConfig(env));

  const keep = rows[0]!.id; // the one read so far: the first meta row by name
  expect(db.listWorkspaces().map((w) => [w.id, w.kind, w.path])).toEqual(expect.arrayContaining([[keep, "meta", join(rel, "current")], [other.id, "repo", join(root, "other")]]));
  expect(db.listWorkspaces()).toHaveLength(2);
  const count = (t: string, w?: string) => (rawOf(db).query(`SELECT count(*) AS n FROM ${t}${w ? " WHERE workspace_id = ?" : ""}`).get(...(w ? [w] : [])) as { n: number }).n;
  expect([count("tasks"), count("tasks", keep), count("tasks", other.id)]).toEqual([tasks, 3, 1]);
  expect([count("schedules"), count("schedules", keep)]).toEqual([schedules, 3]);
  expect([count("routing_log", keep), count("workspace_config_changes", keep)]).toEqual([3, 4]);
  expect(rawOf(db).query("SELECT state FROM workspace_config_changes WHERE workspace_id = ? AND at = 2").all(keep)).toEqual([{ state: "superseded" }]);
  expect(rawOf(db).query("SELECT issue, json FROM request_evals WHERE workspace_id = ? ORDER BY issue").all(keep)).toEqual([{ issue: 7, json: '{"ts":5}' }, { issue: 8, json: '{"ts":5}' }]);
  expect(count("request_evals")).toBe(2);
  expect(["t1", "t2", "t3"].map((t) => db.getTask(t)?.cwd)).toEqual([0, 1, 2].map(() => join(rel, "current")));
  const queue = db.getSetting<{ items: { workspaceId: string; number: number }[]; ended: { workspaceId: string; number: number }[] }>("backlogQueue", null as never);
  expect(queue.items).toEqual([{ workspaceId: keep, number: 5 }, { workspaceId: keep, number: 6 }]);
  expect(queue.ended).toEqual([{ workspaceId: keep, number: 4 }]);
});
