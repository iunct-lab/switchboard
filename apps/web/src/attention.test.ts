import { expect, test } from "bun:test";
import type { StopReasonCode, StopState, Task, TaskOutcome, TaskStatus, TaskStopMark } from "@switchboard/protocol";
import { activeLabel, attentionGroups, isActive, judgementNote, outcomeDotClass, outcomeIsDerived, outcomeIsSettable, outcomeLabel, outcomeOptions, marksFromList, stopCandidates, stopsToRead, terminalMark } from "./attention.ts";

const task = (id: string, status: TaskStatus, outcome: TaskOutcome, reviewedAt: number | null = null, updatedAt = 1): Task => ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/w", scope: ["/w"], status, runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome, reviewedAt, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 0, createdAt: 0, updatedAt, queuedAt: null });

const mark = (reason: StopReasonCode, state: StopState, key = "k", conditions: TaskStopMark["conditions"] = []): TaskStopMark => ({ key, reason, state, conditions, count: 1, answered: false });
// what 要対応 shows of one Task, and the order of its Tasks: Home and the rail read attentionGroups
const needsAttention = (x: Task, m?: TaskStopMark) => attentionGroups([x], m ? { [x.id]: m } : null).needs.length > 0;
const attentionList = (xs: Task[], marks: Record<string, TaskStopMark> | null) => attentionGroups(xs, marks).needs.flatMap((g) => g.tasks);
test("needsAttention: by outcome — a stopped task not reviewed yet whose outcome is 要対応 / 失敗 / 未判定; an open approval always; never 完了 or 待ち, a running or idle one", () => {
  for (const status of ["done", "error", "aborted"] as const) {
    expect(needsAttention(task("t", status, "finished")), `${status} finished`).toBe(false);
    expect(needsAttention(task("t", status, "waits")), `${status} waits`).toBe(false);
    for (const outcome of ["needs_action", "failed", "unknown"] as const) {
      expect(needsAttention(task("t", status, outcome)), `${status} ${outcome}`).toBe(true);
      expect(needsAttention(task("t", status, outcome, 5)), `${status} ${outcome} reviewed`).toBe(false);
    }
  }
  // an open approval needs the person whatever the judge guessed
  expect(needsAttention(task("t", "waiting", "finished"))).toBe(true);
  // the stop mark decides nothing: 完了 stays out whatever the mark says, 要対応 stays in
  expect(needsAttention(task("t", "done", "finished"), mark("decision", "waiting"))).toBe(false);
  expect(needsAttention(task("t", "done", "needs_action"), mark("depends", "waiting"))).toBe(true);
  for (const status of ["running", "background", "idle"] as const) for (const outcome of ["finished", "needs_action", "waits", "failed", "unknown"] as const) expect(needsAttention(task("t", status, outcome))).toBe(false);
});

test("stopCandidates: the stopped tasks not reviewed yet, 待ち ones too; not 完了, running, idle or reviewed ones", () => {
  const ids = stopCandidates([
    task("done", "done", "finished"),
    task("waits", "done", "waits"),
    task("ask", "waiting", "finished"),
    task("failed", "error", "failed"),
    task("reviewed", "done", "needs_action", 5),
    task("running", "running", "unknown"),
    task("idle", "idle", "finished"),
  ]).map((t) => t.id);
  expect(ids).toEqual(["waits", "ask", "failed"]);
});

test("stopsToRead: read when a candidate comes, moves status or a stop record comes; not when one goes away, only changes other fields, or there is none", () => {
  const done = task("done", "done", "unknown");
  const run = task("running", "running", "unknown");
  expect(stopsToRead(null, [run], 0).read).toBe(false);
  const first = stopsToRead(null, [done, run], 0);
  expect(first.read).toBe(true);
  // the same candidates and the same rev (what the list already covered): not read
  expect(stopsToRead(first.seen, [done, run], 0).read).toBe(false);
  // a stop record came: read, once
  const rec = stopsToRead(first.seen, [done, run], 1);
  expect(rec.read).toBe(true);
  expect(stopsToRead(rec.seen, [done, run], 1).read).toBe(false);
  // a title or a judged outcome moves updatedAt, not the mark
  expect(stopsToRead(first.seen, [{ ...done, updatedAt: 9, title: "renamed", outcome: "finished" }, task("running", "running", "unknown", null, 9)], 0).read).toBe(false);
  expect(stopsToRead(first.seen, [run], 0).read).toBe(false);
  expect(stopsToRead(first.seen, [done, task("running", "done", "unknown")], 0).read).toBe(true);
  expect(stopsToRead(first.seen, [{ ...done, statusAt: 5 }], 0).read).toBe(true);
  // no candidate: nothing to read, even for a new record
  expect(stopsToRead(first.seen, [run], 2).read).toBe(false);
  // one that went away and came back (確認済み undone) is read again
  const gone = stopsToRead(first.seen, [task("done", "done", "unknown", 3)], 0);
  expect(gone.read).toBe(false);
  expect(stopsToRead(gone.seen, [done], 0).read).toBe(true);
});

test("marksFromList: only the items with a stop become marks, by Task id", () => {
  const mark = { key: "k", reason: "done_report", state: "open", conditions: [], count: 1, answered: false } as unknown as TaskStopMark;
  const a = { ...task("a", "done", "unknown"), stop: mark };
  const b = task("b", "done", "unknown");
  expect(marksFromList([a, b])).toEqual({ a: mark });
  expect(marksFromList([b])).toEqual({});
});

test("attentionList: 要対応 → 失敗 → 未判定, newest first within each; 完了, 待ち, reviewed and running ones left out, whatever their stop mark says", () => {
  const list = attentionList([
    task("done-old", "done", "finished", null, 1),
    task("unknown-new", "done", "unknown", null, 9),
    task("failed", "error", "failed", null, 2),
    task("ask-old", "waiting", "needs_action", null, 3),
    task("ask-new", "done", "needs_action", null, 8),
    task("stopped-done", "done", "finished", null, 4),
    task("waits", "done", "waits", null, 12),
    task("reviewed", "done", "needs_action", 7, 10),
    task("running", "running", "unknown", null, 11),
  ], { "stopped-done": mark("decision", "waiting") });
  expect(list.map((t) => t.id)).toEqual(["ask-new", "ask-old", "failed", "unknown-new"]);
});

test("labels and dots per outcome", () => {
  expect((["needs_action", "failed", "finished", "waits", "unknown"] as const).map(outcomeLabel)).toEqual(["要対応", "失敗", "完了", "待ち", "未判定"]);
  expect((["needs_action", "failed", "finished", "waits", "unknown"] as const).map(outcomeDotClass)).toEqual(["wait", "err", "ok", "idle", "idle"]);
});

test("judgementNote: the judge's reason with who judged, never the judged result (the outcome is the one result shown)", () => {
  const judged = (outcome: TaskOutcome, result: "finished" | "needs_action"): Task => ({ ...task("t", "done", outcome), judgedResult: result, judgedReason: "A か B を聞いている", judgedBy: "codex:gpt-6-luna" });
  expect(judgementNote(task("t", "done", "unknown"))).toBeNull();
  const same = judgementNote(judged("needs_action", "needs_action"));
  expect(same).toEqual({ text: "A か B を聞いている", title: "自動判定（codex:gpt-6-luna）" });
  // set by hand to a different outcome: the same note, no result word
  expect(judgementNote(judged("finished", "needs_action"))).toEqual(same);
  // judged on the runner's CLI default model (model "", saved when the runner is changed): no dangling colon
  expect(judgementNote({ ...judged("finished", "finished"), judgedBy: "codex:" })?.title).toBe("自動判定（codex:CLI 既定）");
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

const split = (outcome: TaskOutcome, m?: TaskStopMark) => {
  const r = attentionGroups([task("t", "done", outcome)], m ? { t: m } : null);
  return r.needs.length === 1 && r.waiting.length === 0 ? "needs" : r.waiting.length === 1 && r.needs.length === 0 ? "waiting" : r.needs.length + r.waiting.length === 0 ? "none" : "?";
};

test("attentionGroups: split by outcome alone — 要対応 / 失敗 / 未判定 under needs, 待ち folded, 完了 in neither; the stop mark changes none of it", () => {
  const marks = [undefined, mark("decision", "waiting"), mark("depends", "waiting"), mark("decision", "resolved"), mark("transient", "retrying")];
  for (const m of marks) {
    for (const outcome of ["needs_action", "failed", "unknown"] as const) expect(split(outcome, m), `${outcome} ${m?.reason}/${m?.state}`).toBe("needs");
    expect(split("waits", m), `waits ${m?.reason}/${m?.state}`).toBe("waiting");
    expect(split("finished", m), `finished ${m?.reason}/${m?.state}`).toBe("none");
  }
  // marks not loaded yet hide nothing
  expect(split("needs_action")).toBe("needs");
  expect(split("waits")).toBe("waiting");
});

test("attentionGroups: the stop mark only gives a 待ち row its reason and conditions (none when there is no mark), and a 要対応 row its key", () => {
  const conditions = [{ key: "pr#12", value: "open", met: false }];
  const r = attentionGroups([task("t", "done", "waits"), task("u", "done", "waits")], { t: mark("depends", "waiting", "k", conditions) });
  expect(r.needs).toEqual([]);
  expect(r.waiting.map((w) => [w.task.id, w.reason, w.conditions])).toEqual([["t", "depends", conditions], ["u", null, []]]);
  const n = attentionGroups([task("a", "done", "needs_action")], { a: mark("decision", "waiting", "series") }).needs;
  expect(n.map((g) => [g.key, g.reason])).toEqual([["series", "decision"]]);
});

test("attentionGroups: Home's heading counts the rows (groups) and the rail's the same list — three Tasks of one key are one row, count 3", () => {
  const ts = [task("a", "done", "needs_action", null, 5), task("b", "done", "failed", null, 7), task("c", "done", "unknown", null, 6)];
  const { needs } = attentionGroups(ts, { a: mark("decision", "waiting", "same"), b: mark("decision", "waiting", "same"), c: mark("decision", "waiting", "same") });
  expect(needs.length).toBe(1);
  expect(needs[0]!.count).toBe(3);
});

test("attentionGroups: Tasks of the same key are one group with the count, placed at the newest; order as attentionList", () => {
  const ts = [task("a", "done", "needs_action", null, 5), task("f", "error", "failed", null, 9), task("b", "done", "needs_action", null, 7), task("c", "done", "needs_action", null, 6), task("n", "done", "needs_action", null, 8)];
  const marks = { a: mark("decision", "waiting", "same"), b: mark("decision", "waiting", "same"), c: mark("decision", "waiting", "same"), n: mark("input", "waiting", "other") };
  const { needs } = attentionGroups(ts, marks);
  expect(needs.map((g) => [g.key, g.count, g.tasks.map((x) => x.id)])).toEqual([["other", 1, ["n"]], ["same", 3, ["b", "c", "a"]], ["task:f", 1, ["f"]]]);
});

test("outcomeIsDerived: derived outcome — only the statuses the outcome follows from cannot be set by hand", () => {
  for (const status of ["waiting", "error", "aborted"] as const) expect(outcomeIsDerived(status), status).toBe(true);
  for (const status of ["idle", "running", "background", "done"] as const) expect(outcomeIsDerived(status), status).toBe(false);
});

test("outcomeIsSettable: derived outcome aside, idle and running store none either — only an ended turn takes one by hand", () => {
  for (const status of ["done", "background"] as const) expect(outcomeIsSettable(status), status).toBe(true);
  for (const status of ["idle", "running", "waiting", "error", "aborted"] as const) expect(outcomeIsSettable(status), status).toBe(false);
});

test("the outcome select offers the three a person can pick, and shows a failed or waits Task's own value without offering it", () => {
  const picks = [{ value: "needs_action", disabled: false }, { value: "finished", disabled: false }, { value: "unknown", disabled: false }];
  expect(outcomeOptions("finished")).toEqual(picks);
  expect(outcomeOptions("waits")).toEqual([...picks, { value: "waits", disabled: true }]);
  expect(outcomeOptions("failed")).toEqual([...picks, { value: "failed", disabled: true }]);
});
