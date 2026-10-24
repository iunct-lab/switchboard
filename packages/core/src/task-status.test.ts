import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Task, TaskStatus } from "@switchboard/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, abortOrphanedTasks } from "./db.ts";
import { canTransition, InvalidTaskTransitionError, outcomeOnStatus } from "./task-status.ts";

const ALL: TaskStatus[] = ["idle", "running", "waiting", "done", "error", "aborted"];
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  idle: ["running", "error", "aborted"],
  running: ["waiting", "done", "error", "aborted", "idle"],
  waiting: ["running", "done", "error", "aborted", "idle"],
  done: ["running", "error"],
  error: ["running"],
  aborted: ["running", "error"],
};

describe("task status transitions (#1140)", () => {
  let home: string;
  let db: Db;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "switchboard-task-status-"));
    db = new Db(join(home, "switchboard.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const mk = (id: string, status: TaskStatus, extra: Partial<Task> = {}) => {
    const now = Date.now();
    db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: home, scope: [home], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: now, createdAt: now, updatedAt: now, ...extra });
  };

  test("canTransition matches the table for every pair of statuses", () => {
    for (const from of ALL) for (const to of ALL) expect(canTransition(from, to)).toBe(from === to || ALLOWED[from].includes(to));
  });

  test("updateTask throws on a move the table lacks and leaves the row as it was", () => {
    for (const [id, from, to] of [["a", "done", "waiting"], ["b", "error", "aborted"], ["c", "idle", "done"]] as const) {
      mk(id, from, { updatedAt: 1 });
      expect(() => db.updateTask(id, { status: to })).toThrow(InvalidTaskTransitionError);
      expect(db.getTask(id)).toMatchObject({ status: from, outcome: "unknown", updatedAt: 1 });
    }
  });

  test("a status change sets the outcome by rule; a Cloud Task stays unknown", () => {
    const judged = { reviewedAt: 5, archivedAt: null, judgedResult: "done", judgedReason: "r", judgedBy: "codex:m" } as const;
    mk("l", "running");
    expect(db.updateTask("l", { status: "waiting" })?.outcome).toBe("needs_action");
    db.updateTask("l", judged);
    expect(db.updateTask("l", { status: "running" })).toMatchObject({ outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
    expect(db.updateTask("l", { status: "error" })?.outcome).toBe("failed");
    mk("d", "running");
    db.updateTask("d", { outcome: "done" });
    expect(db.updateTask("d", { status: "done" })?.outcome).toBe("done");
    mk("c0", "idle", { executionMode: "cloud", outcome: "needs_action", ...judged });
    expect(db.updateTask("c0", { status: "running" })).toMatchObject({ outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null });
    mk("c1", "running", { executionMode: "cloud" });
    expect(db.updateTask("c1", { status: "idle" })?.outcome).toBe("unknown");
    mk("c2", "running", { executionMode: "cloud" });
    expect(db.updateTask("c2", { status: "error" })?.outcome).toBe("unknown");
    expect(outcomeOnStatus("aborted", "local")).toEqual({ outcome: "failed" });
    expect(outcomeOnStatus("waiting", "cloud")).toEqual({ outcome: "unknown" });
  });

  test("orphan recovery: local running → aborted / failed, cloud with a session → idle / unknown, without → error / unknown", () => {
    mk("loc", "running");
    mk("cs", "running", { executionMode: "cloud", cloudSession: { id: "session_s1", url: "https://claude.ai/code/session_s1" }, outcome: "needs_action" });
    mk("cn", "waiting", { executionMode: "cloud", outcome: "needs_action" });
    expect(abortOrphanedTasks(db).sort()).toEqual(["cn", "cs", "loc"]);
    expect(db.getTask("loc")).toMatchObject({ status: "aborted", outcome: "failed" });
    expect(db.getTask("cs")).toMatchObject({ status: "idle", outcome: "unknown" });
    expect(db.getTask("cn")).toMatchObject({ status: "error", outcome: "unknown" });
  });
});
