// test-reads: apps/web/src/screen.ts apps/web/src/components/Feedback.tsx apps/web/src/i18n.ts apps/web/src/i18n/panels.ts
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
  expect(screenLabel({ name: "resources" })).toBe("Resources");
});

test("in English the name sent stays as it is; only the feedback dialog shows it in English, a Task's line with English quotes (#2445, #2450)", () => {
  // the language is read once when i18n.ts loads: a fresh process with the browser's choice set to en
  const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
  const code = `globalThis.localStorage = { getItem: (k) => (k === "switchboard.lang" ? "en" : null) };
const { screenLabel } = await import(${at("./screen.ts")});
const { shownScreen } = await import(${at("./components/Feedback.tsx")});
const sent = [screenLabel({ name: "approvals" }), screenLabel({ name: "backlog" }), screenLabel({ name: "task", id: "task_1" }, { id: "task_1", title: "要望: a" })];
console.log(JSON.stringify({ sent, shown: sent.map(shownScreen) }));`;
  const r = Bun.spawnSync([process.execPath, "-e", code]);
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual({
    sent: ["判断待ち", "Backlog", "Task「要望: a」(task_1)"],
    shown: ["Awaiting you", "Backlog", 'Task "要望: a" (task_1)'],
  });
});
