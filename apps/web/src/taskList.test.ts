import { expect, test } from "bun:test";
import { TaskSummary, taskSummary, type Task, type TaskStatus } from "@switchboard/protocol";
import { filterTasks, openTask, upsertSummary } from "./taskList.ts";

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
  task("h", "bg", "/work/app", "background"),
];

test("filterTasks: q matches the title, case-insensitive and trimmed", () => {
  expect(ids(filterTasks(list, { ...all, q: "  fix " }))).toEqual(["a"]);
});

test("filterTasks: q matches the cwd too", () => {
  expect(ids(filterTasks(list, { ...all, q: "site" }))).toEqual(["b"]);
});

test("filterTasks: an empty q keeps every row not archived", () => {
  expect(ids(filterTasks(list, all))).toEqual(["a", "b", "c", "d", "e", "f", "h"]);
});

test("filterTasks: the state filter — active = running / waiting / background, done, stopped = error / aborted", () => {
  expect(ids(filterTasks(list, { ...all, status: "active" }))).toEqual(["c", "d", "h"]);
  expect(ids(filterTasks(list, { ...all, status: "done" }))).toEqual(["a", "b"]);
  expect(ids(filterTasks(list, { ...all, status: "stopped" }))).toEqual(["e", "f"]);
});

test("filterTasks: archived lists only the archived ones, and the search applies to them", () => {
  expect(ids(filterTasks(list, { ...all, archived: true }))).toEqual(["g"]);
  expect(ids(filterTasks(list, { ...all, archived: true, q: "FIX" }))).toEqual(["g"]);
  expect(ids(filterTasks(list, { ...all, archived: true, status: "stopped" }))).toEqual([]);
});


test("upsertSummary keeps a task.updated in the list shape", () => {
  const listed = list.map(taskSummary);
  const keys = Object.keys(TaskSummary.shape).sort();
  const updated = { ...task("b", "Renamed", "/work/Site", "running"), model: "m", scope: ["/x"], budgetUsd: 3 };
  const replaced = upsertSummary(listed, updated);
  expect(replaced.map((t) => t.id)).toEqual(ids(list));
  expect(replaced[1]!.title).toBe("Renamed");
  expect(replaced[1]!.status).toBe("running");
  const added = upsertSummary(listed, task("z", "New", "/work/new"));
  expect(added.map((t) => t.id)).toEqual(["z", ...ids(list)]);
  for (const t of [...replaced, ...added]) expect(Object.keys(t).sort()).toEqual(keys);
  expect(keys.length).toBe(21);
});

test("openTask keeps the Task last shown while its detail is forgotten", () => {
  const a = task("a", "Shown", "/work/a");
  expect(openTask(a, "a", { ...a, title: "Read" })?.title).toBe("Read");
  // the detail forgotten after a failed catch-up: the one last shown stays
  expect(openTask(a, "a", undefined)).toBe(a);
  // another Task opened: the last one is not shown for it
  expect(openTask(a, "b", undefined)).toBeUndefined();
});
