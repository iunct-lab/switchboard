import { expect, test } from "bun:test";
import type { Task, TaskOutcome, TaskStatus } from "@switchboard/protocol";
import { attentionList, judgementNote, needsAttention, outcomeDotClass, outcomeLabel, terminalMark } from "./attention.ts";

const task = (id: string, status: TaskStatus, outcome: TaskOutcome, reviewedAt: number | null = null, updatedAt = 1): Task => ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/w", scope: ["/w"], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt });

test("needsAttention: a stopped task not reviewed yet that did not come to 完了; never a running or idle one", () => {
  for (const status of ["waiting", "done", "error", "aborted"] as const) {
    expect(needsAttention(task("t", status, "done")), `${status} done`).toBe(false);
    for (const outcome of ["needs_action", "failed", "unknown"] as const) {
      expect(needsAttention(task("t", status, outcome)), `${status} ${outcome}`).toBe(true);
      expect(needsAttention(task("t", status, outcome, 5)), `${status} ${outcome} reviewed`).toBe(false);
    }
  }
  for (const status of ["running", "idle"] as const) for (const outcome of ["done", "needs_action", "failed", "unknown"] as const) expect(needsAttention(task("t", status, outcome))).toBe(false);
});

test("attentionList: 要対応 → 失敗 → 未判定, newest first within each; 完了, reviewed and running ones left out", () => {
  const list = attentionList([
    task("done-old", "done", "done", null, 1),
    task("unknown-new", "done", "unknown", null, 9),
    task("failed", "error", "failed", null, 2),
    task("ask-old", "waiting", "needs_action", null, 3),
    task("ask-new", "done", "needs_action", null, 8),
    task("reviewed", "done", "needs_action", 7, 10),
    task("running", "running", "unknown", null, 11),
  ]);
  expect(list.map((t) => t.id)).toEqual(["ask-new", "ask-old", "failed", "unknown-new"]);
});

test("labels and dots per outcome", () => {
  expect((["needs_action", "failed", "done", "unknown"] as const).map(outcomeLabel)).toEqual(["要対応", "失敗", "完了", "未判定"]);
  expect((["needs_action", "failed", "done", "unknown"] as const).map(outcomeDotClass)).toEqual(["wait", "err", "ok", "idle"]);
});

test("judgementNote (#493): the judge's reason with who judged; the judged result is named only when the outcome differs (set by hand)", () => {
  const judged = (outcome: TaskOutcome, result: "done" | "needs_action"): Task => ({ ...task("t", "done", outcome), judgedResult: result, judgedReason: "A か B を聞いている", judgedBy: "codex:gpt-6-luna" });
  expect(judgementNote(task("t", "done", "unknown"))).toBeNull();
  expect(judgementNote(judged("needs_action", "needs_action"))).toEqual({ text: "A か B を聞いている", title: "自動判定（codex:gpt-6-luna）: 要対応" });
  expect(judgementNote(judged("done", "needs_action"))).toEqual({ text: "自動判定: 要対応 — A か B を聞いている", title: "自動判定（codex:gpt-6-luna）: 要対応" });
  // judged on the runner's CLI default model (model "", saved when the runner is changed): no dangling colon
  expect(judgementNote({ ...judged("done", "done"), judgedBy: "codex:" })?.title).toBe("自動判定（codex:CLI 既定）: 完了");
});

test("terminalMark: working / waiting show a mark, done and none do not", () => {
  expect(terminalMark("working")).toEqual({ text: "端末: 作業中", className: "m" });
  expect(terminalMark("waiting")).toEqual({ text: "端末: 返事待ち", className: "m term-wait" });
  expect(terminalMark("done")).toBeNull();
  expect(terminalMark(undefined)).toBeNull();
});
