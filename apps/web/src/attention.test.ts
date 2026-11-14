import { expect, test } from "bun:test";
import type { StopReasonCode, StopState, Task, TaskOutcome, TaskStatus, TaskStopMark } from "@switchboard/protocol";
import { activeLabel, attentionGroups, isActive, judgementNote, outcomeDotClass, outcomeLabel, stopCandidates, terminalMark } from "./attention.ts";

const task = (id: string, status: TaskStatus, outcome: TaskOutcome, reviewedAt: number | null = null, updatedAt = 1): Task => ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/w", scope: ["/w"], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt, queuedAt: null });

const mark = (reason: StopReasonCode, state: StopState, key = "k", conditions: TaskStopMark["conditions"] = []): TaskStopMark => ({ key, reason, state, conditions, count: 1, answered: false });
// what 要対応 shows of one Task, and the order of its Tasks: Home and the rail read attentionGroups
const needsAttention = (x: Task, m?: TaskStopMark) => attentionGroups([x], m ? { [x.id]: m } : null).needs.length > 0;
const attentionList = (xs: Task[], marks: Record<string, TaskStopMark> | null) => attentionGroups(xs, marks).needs.flatMap((g) => g.tasks);
test("needsAttention: by personWait — a stopped task not reviewed yet whose outcome is not 完了; an open approval always; never a running or idle one", () => {
  for (const status of ["done", "error", "aborted"] as const) {
    expect(needsAttention(task("t", status, "done")), `${status} done`).toBe(false);
    for (const outcome of ["needs_action", "failed", "unknown"] as const) {
      expect(needsAttention(task("t", status, outcome)), `${status} ${outcome}`).toBe(true);
      expect(needsAttention(task("t", status, outcome, 5)), `${status} ${outcome} reviewed`).toBe(false);
    }
  }
  // an open approval needs the person whatever the judge guessed
  expect(needsAttention(task("t", "waiting", "done"))).toBe(true);
  // a stop that waits on the person decides before the outcome; one that waits on something else does not need them
  expect(needsAttention(task("t", "done", "done"), mark("decision", "waiting"))).toBe(true);
  expect(needsAttention(task("t", "done", "needs_action"), mark("depends", "waiting"))).toBe(false);
  for (const status of ["running", "background", "idle"] as const) for (const outcome of ["done", "needs_action", "failed", "unknown"] as const) expect(needsAttention(task("t", status, outcome))).toBe(false);
});

test("stopCandidates: the stopped tasks not reviewed yet, 完了 ones too; not running, idle or reviewed ones", () => {
  const ids = stopCandidates([
    task("done", "done", "done"),
    task("ask", "waiting", "done"),
    task("failed", "error", "failed"),
    task("reviewed", "done", "done", 5),
    task("running", "running", "unknown"),
    task("idle", "idle", "done"),
  ]).map((t) => t.id);
  expect(ids).toEqual(["done", "ask", "failed"]);
});

test("attentionList: 要対応 → 失敗 → 未判定, newest first within each; 完了, reviewed and running ones left out; a 完了 task stopped on a decision ranks as 要対応", () => {
  const list = attentionList([
    task("done-old", "done", "done", null, 1),
    task("unknown-new", "done", "unknown", null, 9),
    task("failed", "error", "failed", null, 2),
    task("ask-old", "waiting", "needs_action", null, 3),
    task("ask-new", "done", "needs_action", null, 8),
    task("stopped-done", "done", "done", null, 4),
    task("reviewed", "done", "needs_action", 7, 10),
    task("running", "running", "unknown", null, 11),
  ], { "stopped-done": mark("decision", "waiting") });
  expect(list.map((t) => t.id)).toEqual(["ask-new", "stopped-done", "ask-old", "failed", "unknown-new"]);
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

test("activeLabel: running / waiting / background / an idle Task in the run-slot queue; nothing else", () => {
  const q = (status: TaskStatus, queuedAt: number | null) => ({ ...task("t", status, "unknown"), queuedAt });
  expect(activeLabel(q("running", null))).toBe("実行中");
  expect(activeLabel(q("waiting", null))).toBe("承認待ち");
  expect(activeLabel(q("background", null))).toBe("裏で実行中");
  expect(activeLabel(q("idle", 5))).toBe("実行枠待ち");
  for (const status of ["idle", "done", "error", "aborted"] as const) {
    expect(activeLabel(q(status, null)), status).toBeNull();
    expect(isActive(q(status, null)), status).toBe(false);
  }
  expect(isActive(q("idle", 5))).toBe(true);
  expect(isActive(q("running", null))).toBe(true);
});

const split = (m: TaskStopMark | undefined, outcome: TaskOutcome = "needs_action") => {
  const r = attentionGroups([task("t", "done", outcome)], m ? { t: m } : {});
  return r.needs.length === 1 && r.waiting.length === 0 ? "needs" : r.waiting.length === 1 && r.needs.length === 0 ? "waiting" : "?";
};

test("attentionGroups: waiting / exhausted on a reason that needs the person stays under needs", () => {
  for (const reason of ["decision", "auth", "permission", "input", "disk-full", "unknown"] as const) for (const state of ["waiting", "exhausted"] as const) expect(split(mark(reason, state)), `${reason} ${state}`).toBe("needs");
});

test("attentionGroups: a 完了 task stopped on a decision is under needs, a needs_action one stopped on depends under waiting; 完了 with no mark is in neither", () => {
  expect(split(mark("decision", "waiting"), "done")).toBe("needs");
  expect(split(mark("depends", "waiting"), "needs_action")).toBe("waiting");
  const r = attentionGroups([task("t", "done", "done")], null);
  expect([r.needs, r.waiting]).toEqual([[], []]);
});

test("attentionGroups: resolved, and depends waiting with its conditions, go to waiting", () => {
  expect(split(mark("decision", "resolved"))).toBe("waiting");
  const conditions = [{ key: "pr#12", value: "open", met: false }];
  const r = attentionGroups([task("t", "done", "needs_action")], { t: mark("depends", "waiting", "k", conditions) });
  expect(r.needs).toEqual([]);
  expect(r.waiting.map((w) => [w.task.id, w.conditions])).toEqual([["t", conditions]]);
});

test("attentionGroups: no mark, a failed Task and marks not loaded stay under needs; other reasons fold whatever their state", () => {
  expect(split(undefined)).toBe("needs");
  expect(split(mark("depends", "resolved"), "failed")).toBe("needs");
  expect(split(mark("depends", "exhausted"))).toBe("waiting");
  expect(split(mark("transient", "exhausted"))).toBe("waiting");
  expect(split(mark("transient", "retrying"))).toBe("waiting");
  expect(split(mark("usage-limit", "waiting"))).toBe("waiting");
  const r = attentionGroups([task("a", "done", "needs_action"), task("b", "done", "needs_action")], null);
  expect(r.needs.length).toBe(2);
  expect(r.waiting).toEqual([]);
});

test("attentionGroups: Tasks of the same key are one group with the count, placed at the newest; order as attentionList", () => {
  const ts = [task("a", "done", "needs_action", null, 5), task("f", "error", "failed", null, 9), task("b", "done", "needs_action", null, 7), task("c", "done", "needs_action", null, 6), task("n", "done", "needs_action", null, 8)];
  const marks = { a: mark("decision", "waiting", "same"), b: mark("decision", "waiting", "same"), c: mark("decision", "waiting", "same"), n: mark("input", "waiting", "other") };
  const { needs } = attentionGroups(ts, marks);
  expect(needs.map((g) => [g.key, g.count, g.tasks.map((x) => x.id)])).toEqual([["other", 1, ["n"]], ["same", 3, ["b", "c", "a"]], ["task:f", 1, ["f"]]]);
});
