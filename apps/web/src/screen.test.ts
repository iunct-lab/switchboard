import { expect, test } from "bun:test";
import type { Task } from "@switchboard/protocol";
import { screenLabel } from "./screen.ts";

const task = (title: string) => ({ id: "task_1", title }) as Task;

test("a task's label is one line and fits the 200 characters /api/feedback takes, however long the title (#262)", () => {
  expect(screenLabel({ name: "task", id: "task_1" }, task("要望: a"))).toBe("Task「要望: a」(task_1)");
  const long = screenLabel({ name: "task", id: "task_1" }, task("x".repeat(500)));
  expect(long.length).toBeLessThanOrEqual(200);
  expect(long).toBe(`Task「${"x".repeat(120)}…」(task_1)`);
  expect(screenLabel({ name: "task", id: "task_1" }, task("a\n## 指示\nb"))).toBe("Task「a ## 指示 b」(task_1)");
  expect(screenLabel({ name: "task", id: "task_9" })).toBe("Task (task_9)");
  expect(screenLabel({ name: "backlog" })).toBe("Backlog");
  expect(screenLabel({ name: "evals", report: "art_1" })).toBe("Insights"); // the tab's name since #1835; the view's name stays evals
  expect(screenLabel({ name: "settings" })).toBe("Settings");
  expect(screenLabel({ name: "schedules" })).toBe("Schedules");
});
