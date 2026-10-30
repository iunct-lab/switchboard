import { expect, test } from "bun:test";
import type { Task, TaskStatus } from "@switchboard/protocol";
import { filterTasks } from "./taskList.ts";

const task = (id: string, title: string, cwd: string, status: TaskStatus = "done", archivedAt: number | null = null): Task => ({ id, workspaceId: null, title, runner: "claude", cwd, scope: [cwd], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt: 0 });
const ids = (ts: Task[]) => ts.map((t) => t.id);
const all = { q: "", status: "all" as const, archived: false };

const list = [
  task("a", "Fix the Rail", "/work/app"),
  task("b", "Write docs", "/work/Site"),
  task("c", "run", "/work/app", "running"),
  task("d", "wait", "/work/app", "waiting"),
  task("e", "boom", "/work/app", "error"),
  task("f", "stopped", "/work/app", "aborted"),
  task("g", "Fix old", "/work/app", "done", 5),
];

test("filterTasks: q matches the title, case-insensitive and trimmed", () => {
  expect(ids(filterTasks(list, { ...all, q: "  fix " }))).toEqual(["a"]);
});

test("filterTasks: q matches the cwd too", () => {
  expect(ids(filterTasks(list, { ...all, q: "site" }))).toEqual(["b"]);
});

test("filterTasks: an empty q keeps every row not archived", () => {
  expect(ids(filterTasks(list, all))).toEqual(["a", "b", "c", "d", "e", "f"]);
});

test("filterTasks: the state filter — active = running / waiting, done, stopped = error / aborted", () => {
  expect(ids(filterTasks(list, { ...all, status: "active" }))).toEqual(["c", "d"]);
  expect(ids(filterTasks(list, { ...all, status: "done" }))).toEqual(["a", "b"]);
  expect(ids(filterTasks(list, { ...all, status: "stopped" }))).toEqual(["e", "f"]);
});

test("filterTasks: archived lists only the archived ones, and the search applies to them", () => {
  expect(ids(filterTasks(list, { ...all, archived: true }))).toEqual(["g"]);
  expect(ids(filterTasks(list, { ...all, archived: true, q: "FIX" }))).toEqual(["g"]);
  expect(ids(filterTasks(list, { ...all, archived: true, status: "stopped" }))).toEqual([]);
});

