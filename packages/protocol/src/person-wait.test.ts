import { describe, expect, test } from "bun:test";
import type { StopReasonCode, StopState } from "./events.ts";
import type { Task } from "./model.ts";
import { personWait, type PersonWait } from "./person-wait.ts";

type T = Pick<Task, "status" | "reviewedAt" | "outcome">;
const t = (status: T["status"], outcome: T["outcome"], reviewedAt: number | null = null): T => ({ status, outcome, reviewedAt });
const s = (reason: StopReasonCode, state: StopState, answered = false) => ({ reason, state, answered });

const rows: Array<[string, T, ReturnType<typeof s> | null, PersonWait]> = [
  ["reviewed beats everything", t("waiting", "needs_action", 5), s("decision", "waiting"), "none"],
  ["running", t("running", "needs_action"), null, "none"],
  ["background", t("background", "failed"), null, "none"],
  ["idle", t("idle", "unknown"), null, "none"],
  ["approval open", t("waiting", "done"), null, "needs"],
  ["approval open beats a stop that waits", t("waiting", "done"), s("depends", "waiting"), "needs"],
  ["failed", t("error", "failed"), null, "failed"],
  ["failed beats a human stop", t("done", "failed"), s("decision", "waiting"), "failed"],
  ["failed + depends", t("done", "failed"), s("depends", "waiting"), "failed"],
  ["judged done + decision waiting", t("done", "done"), s("decision", "waiting"), "needs"],
  ["judged done + auth exhausted", t("done", "done"), s("auth", "exhausted"), "needs"],
  ["judged done + unknown waiting", t("aborted", "done"), s("unknown", "waiting"), "needs"],
  ["judged needs_action + depends waiting", t("done", "needs_action"), s("depends", "waiting"), "waits"],
  ["needs_action + usage-limit exhausted", t("done", "needs_action"), s("usage-limit", "exhausted"), "waits"],
  ["needs_action + decision resolved", t("done", "needs_action"), s("decision", "resolved"), "waits"],
  ["needs_action + decision retrying", t("done", "needs_action"), s("decision", "retrying"), "waits"],
  ["judged done + transient", t("done", "done"), s("transient", "waiting"), "waits"],
  ["judged done + decision answered: the person acted", t("done", "done"), s("decision", "waiting", true), "none"],
  ["needs_action + decision answered: the outcome after the answer decides", t("done", "needs_action"), s("decision", "waiting", true), "needs"],
  ["needs_action + depends answered", t("done", "needs_action"), s("depends", "waiting", true), "needs"],
  ["judged done + transient resolved: the stop is over", t("done", "done"), s("transient", "resolved"), "none"],
  ["unknown + transient resolved", t("done", "unknown"), s("transient", "resolved"), "unjudged"],
  ["no stop, needs_action", t("done", "needs_action"), null, "needs"],
  ["no stop, unknown", t("done", "unknown"), null, "unjudged"],
  ["no stop, done", t("done", "done"), null, "none"],
];

describe("personWait", () => {
  for (const [name, task, stop, want] of rows) test(name, () => expect(personWait(task, stop)).toBe(want));
});
