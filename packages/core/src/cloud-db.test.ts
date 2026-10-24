import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { abortOrphanedTasks, Db } from "./db.ts";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const task = (): Task => ({
  id: "task_cloud", workspaceId: null, title: "Cloud", runner: "claude", cwd: "/tmp", scope: [], status: "idle",
  executionMode: "cloud", cloudSession: null, sourceCloudTaskId: null, runnerSessionId: null, model: null, routing: null, budgetUsd: null,
  scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false,
  workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null,
  statusAt: 1, createdAt: 1, updatedAt: 1,
});
function path() { const d = mkdtempSync(join(tmpdir(), "switchboard-cloud-db-")); dirs.push(d); return join(d, "test.db"); }

test("Cloud roundtrip, update and reopen preserve the reference separately from Local ID", () => {
  const file = path(); let db = new Db(file); db.insertTask(task());
  const id = "session_0123456789abcdefghijklmn", ref = { id, url: `https://claude.ai/code/${id}` };
  db.updateTask("task_cloud", { cloudSession: ref }); db.close(); db = new Db(file);
  expect(db.getTask("task_cloud")).toMatchObject({ executionMode: "cloud", cloudSession: ref, runnerSessionId: null });
  expect(() => db.updateTask("task_cloud", { cloudSession: { id, url: "https://example.com" } })).toThrow();
  expect(db.getTask("task_cloud")!.cloudSession).toEqual(ref); db.close();
});

test("old DB migrates once to Local without fallback parsing", () => {
  const file = path(); let db = new Db(file);
  db.insertTask({ ...task(), executionMode: "local" });
  db.sqlite.exec("ALTER TABLE tasks DROP COLUMN execution_mode; ALTER TABLE tasks DROP COLUMN cloud_session"); db.close();
  db = new Db(file); expect(db.getTask("task_cloud")).toMatchObject({ executionMode: "local", cloudSession: null }); db.close();
  db = new Db(file); expect(db.getTask("task_cloud")!.executionMode).toBe("local"); db.close();
});

test("Teleport relationship persists and rejects invalid ownership", () => {
  const file = path(); let db = new Db(file); db.insertTask(task());
  const local: Task = { ...task(), id: "local", executionMode: "local", runnerSessionId: "local-session", sourceCloudTaskId: "task_cloud" };
  db.insertTask(local);
  expect(db.listLocalTasksForCloud("task_cloud").map(t => t.id)).toEqual(["local"]);
  expect(() => db.insertTask({ ...local, id: "other" })).toThrow();
  expect(() => db.insertTask({ ...local, id: "unlinked-duplicate", sourceCloudTaskId: null })).toThrow();
  expect(() => db.insertTask({ ...local, id: "wrong-workspace", workspaceId: "other", runnerSessionId: "other-session" })).toThrow("same working directory and Workspace");
  expect(() => db.insertTask({ ...local, id: "wrong-runner", runner: "codex", runnerSessionId: "other-session" })).toThrow();
  db.insertTask({ ...local, id: "second-import", runnerSessionId: "second-session" });
  expect(db.listLocalTasksForCloud("task_cloud")).toHaveLength(2);
  expect(() => db.insertTask({ ...local, id: "wrong-repo", cwd: "/elsewhere", runnerSessionId: "other-session" })).toThrow();
  expect(() => db.updateTask("task_cloud", { sourceCloudTaskId: "task_cloud" })).toThrow();
  expect(() => db.updateTask("local", { sourceCloudTaskId: "missing" })).toThrow();
  expect(() => db.updateTask("local", { runnerSessionId: null })).toThrow("same working directory and Workspace");
  db.updateTask("local", { status: "running", runnerSessionId: "local-session" });
  expect(db.getTask("local")!.sourceCloudTaskId).toBe("task_cloud");
  expect(db.getTask("task_cloud")!.executionMode).toBe("cloud");
  db.close(); db = new Db(file);
  expect(db.getTask("local")!.sourceCloudTaskId).toBe("task_cloud");
  expect(db.listLocalTasksForCloud("task_cloud")).toHaveLength(2); db.close();
});

test("existing rows migrate to an unlinked Local task", () => {
  const file = path(); let db = new Db(file);
  db.insertTask({ ...task(), executionMode: "local" });
  db.sqlite.exec("ALTER TABLE tasks DROP COLUMN source_cloud_task_id"); db.close();
  db = new Db(file); expect(db.getTask("task_cloud")!.sourceCloudTaskId).toBeNull(); db.close();
});

test("Teleport ownership accepts a physical cwd alias and keeps both stored paths", () => {
  const file = path(), root = join(file, ".."), repo = join(root, "repo"), alias = join(root, "alias");
  mkdirSync(repo); symlinkSync(repo, alias);
  const db = new Db(file); db.insertTask({ ...task(), cwd: alias });
  db.insertTask({ ...task(), id: "local", cwd: repo, executionMode: "local", runnerSessionId: "local-session", sourceCloudTaskId: "task_cloud" });
  expect(db.getTask("local")!.cwd).toBe(repo); expect(db.getTask("task_cloud")!.cwd).toBe(alias);
  expect(db.listLocalTasksForCloud("task_cloud")).toHaveLength(1);
  const otherRepo = join(root, "other-repo"), otherAlias = join(root, "other-alias");
  mkdirSync(otherRepo); symlinkSync(otherRepo, otherAlias);
  expect(() => db.insertTask({ ...task(), id: "wrong-physical", cwd: otherAlias, executionMode: "local", runnerSessionId: "other-session", sourceCloudTaskId: "task_cloud" })).toThrow();
  rmSync(alias);
  expect(db.updateTask("local", { status: "running" })!.status).toBe("running");
  expect(abortOrphanedTasks(db)).toEqual(["local"]);
  expect(db.getTask("local")!.status).toBe("aborted");
  expect(() => db.updateTask("local", { runnerSessionId: null })).toThrow();
  db.insertTask({ ...task(), id: "other-cloud", cwd: alias });
  expect(() => db.updateTask("local", { sourceCloudTaskId: "other-cloud" })).toThrow();
  db.close();
});
