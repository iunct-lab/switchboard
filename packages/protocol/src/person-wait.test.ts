import { describe, expect, test } from "bun:test";
import type { Task } from "./model/task.ts";
import { personWait, type PersonWait } from "./person-wait.ts";

type T = Pick<Task, "status" | "reviewedAt" | "outcome">;
const t = (status: T["status"], outcome: T["outcome"], reviewedAt: number | null = null): T => ({ status, outcome, reviewedAt });

const rows: Array<[string, T, PersonWait]> = [
  ["reviewed beats everything", t("waiting", "needs_action", 5), "none"],
  ["running", t("running", "needs_action"), "none"],
  ["background", t("background", "failed"), "none"],
  ["idle", t("idle", "unknown"), "none"],
  ["approval open", t("waiting", "finished"), "needs"],
  ["approval open beats a failed outcome", t("waiting", "failed"), "needs"],
  ["failed", t("error", "failed"), "failed"],
  ["needs_action", t("done", "needs_action"), "needs"],
  ["unknown", t("done", "unknown"), "unjudged"],
  ["waits: only waits on something else", t("done", "waits"), "waits"],
  ["finished", t("done", "finished"), "none"],
];

describe("personWait", () => {
  for (const [name, task, want] of rows) test(name, () => expect(personWait(task)).toBe(want));
});
