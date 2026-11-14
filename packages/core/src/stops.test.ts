import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StopRecord, type Task } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { compareStopConditions, FenceReader, issueOf, reduceStops, reportedLimit, reserveStopRetry, StopFenceReader, lastStopMark, stopKey, stopMarks, stopRecordsFor, stopRecoveryPrompt, stopWork, stuckSchedule } from "./stops.ts";
import { parseArtifactFence } from "./artifacts.ts";

let n = 0;
/** A stop of Issue 939 in workspace ws1 by default: the PR merge waiting on CI. */
const stop = (over: Partial<Omit<StopRecord, "work">> & { work?: Partial<StopRecord["work"]> } = {}): StopRecord =>
  StopRecord.parse({
    id: `s${++n}`,
    op: "gh pr merge",
    target: "PR #12",
    reason: "depends",
    evidence: "CI が終わっていない",
    at: n * 1000,
    ...over,
    work: { workspaceId: "ws1", issue: 939, taskId: `t${n}`, ...over.work },
  });

describe("stopKey", () => {
  test("the same cause in other words is one series", () => {
    const a = stop({ reason: "transient", evidence: "HTTP 503 from api.github.com" });
    const b = stop({ reason: "transient", evidence: "接続がタイムアウトしました" });
    expect(stopKey(a)).toBe(stopKey(b));
    const [s] = reduceStops([a, b]);
    expect(s).toMatchObject({ count: 2, unchanged: true, next: "wait" });
  });

  test("similar words with another reason code are another series, shown as a new cause", () => {
    const a = stop({ reason: "transient", evidence: "gh: HTTP 503" });
    const b = stop({ reason: "auth", evidence: "gh: HTTP 401" });
    expect(stopKey(a)).not.toBe(stopKey(b));
    const out = reduceStops([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ reason: "auth", count: 1, unchanged: false, next: "decide" });
    expect(out[0]!.changes).toEqual([{ kind: "cause", detail: "transient → auth" }]);
  });

  test("unknown stops join only on the same evidence", () => {
    const a = stop({ reason: "unknown", evidence: "exit 1" });
    const b = stop({ reason: "unknown", evidence: "  EXIT   1 " });
    const c = stop({ reason: "unknown", evidence: "segfault" });
    expect(stopKey(a)).toBe(stopKey(b));
    expect(stopKey(a)).not.toBe(stopKey(c));
    expect(reduceStops([a, b, c]).map((s) => s.count)).toEqual([1, 2]);
  });

  test("the same Issue number in another repository is other work; another task on the same Issue is the same work", () => {
    const a = stop({ work: { workspaceId: "ws1", issue: 939 } });
    const b = stop({ work: { workspaceId: "ws2", issue: 939 } });
    const c = stop({ work: { workspaceId: "ws1", issue: 939, taskId: "other" } });
    expect(stopKey(a)).not.toBe(stopKey(b));
    expect(stopKey(a)).toBe(stopKey(c));
    expect(stopKey(stop({ work: { issue: null, taskId: "x" } }))).not.toBe(stopKey(stop({ work: { issue: null, taskId: "y" } })));
  });
});

describe("reduceStops", () => {
  const ci = (value: string, met = false) => [{ key: "pr#12 CI", value, met }];

  test("an Issue comment URL a runner named is a pointer, not an answer: it does not make a new answer", () => {
    const a = stop({ reason: "decision" });
    const b = stop({ reason: "decision", answer: { ref: "https://github.com/o/r/issues/939#issuecomment-1", at: a.at + 1 } });
    const [s] = reduceStops([a, b]);
    expect(s).toMatchObject({ count: 2, changes: [], unchanged: true, next: "decide" });
    // even with a condition met at the same time, the URL is not shown as the person's answer
    const open = stop({ reason: "decision", conditions: [{ key: "pr#12", value: "open", met: false }] });
    const c = stop({ reason: "decision", conditions: [{ key: "pr#12", value: "merged", met: true }], answer: b.answer });
    expect(reduceStops([open, c])[0]).toMatchObject({ lastAnswer: null, next: "resume" });
  });

  test("the same conditions again: counted, unchanged, waiting — no new question", () => {
    const a = stop({ reason: "decision" });
    const answer = { ref: "seq:7", at: a.at + 1 };
    const b = stop({ reason: "decision", answer });
    expect(reduceStops([a, b])[0]!.next).toBe("resume"); // answered since: go on once
    const c = stop({ reason: "decision", answer });
    const [s] = reduceStops([c, a, b]);
    expect(s).toMatchObject({ count: 3, changes: [], unchanged: true, lastAnswer: answer, next: "wait", firstAt: a.at, lastAt: c.at });
    // Never answered: the person is asked.
    expect(reduceStops([stop({ reason: "decision" }), stop({ reason: "decision" })])[0]!.next).toBe("decide");
    // A condition still unmet: wait for it.
    expect(reduceStops([stop({ conditions: ci("pending") }), stop({ conditions: ci("pending") })])[0]).toMatchObject({ unchanged: true, next: "wait" });
  });

  test("a new answer is a change and resumes once", () => {
    const a = stop({ reason: "decision", answer: { ref: "seq:4", at: 100 } });
    const nine = { ref: "seq:9", at: a.at + 1 }; // given after the first stop
    const b = stop({ reason: "decision", answer: nine });
    const [s] = reduceStops([a, b]);
    expect(s).toMatchObject({ count: 2, unchanged: false, next: "resume", lastAnswer: nine });
    expect(s!.changes).toEqual([{ kind: "answer", detail: "seq:9" }]);
  });

  test("a condition met is told from one that only moved", () => {
    const a = stop({ conditions: ci("pending") });
    const moved = stop({ conditions: ci("running") });
    const met = stop({ conditions: ci("success", true) });
    expect(compareStopConditions(a, moved)).toEqual([{ kind: "condition", detail: "pr#12 CI: pending → running" }]);
    expect(compareStopConditions(moved, met)).toEqual([{ kind: "condition-met", detail: "pr#12 CI: success" }]);
    expect(reduceStops([a, moved])[0]!.next).toBe("wait");
    expect(reduceStops([a, moved, met])[0]).toMatchObject({ count: 3, next: "resume" });
  });

  test("one condition met while another still holds the work back: wait, not resume", () => {
    const both = [{ key: "pr#12 CI", value: "pending", met: false }, { key: "pr#12 review", value: "pending", met: false }];
    const one = [{ key: "pr#12 CI", value: "success", met: true }, { key: "pr#12 review", value: "pending", met: false }];
    const [s] = reduceStops([stop({ conditions: both }), stop({ conditions: one })]);
    expect(s!.changes.map((c) => c.kind)).toEqual(["condition-met"]);
    expect(s!.next).toBe("wait");
  });

  test("an answer already used before is not new when the same stop comes back after another cause", () => {
    const a0 = stop({ reason: "decision" });
    const answer = { ref: "seq:1", at: a0.at + 1 };
    const a = stop({ reason: "decision", answer });
    const b = stop({ reason: "auth" });
    const c = stop({ reason: "decision", answer });
    const s = reduceStops([a0, a, b, c]).find((x) => x.reason === "decision")!;
    expect(s.changes).toEqual([{ kind: "cause", detail: "auth → decision" }]);
    expect(s.next).toBe("wait");
  });

  test("an answer given before this series first stopped is not an answer to it", () => {
    const a = stop({ reason: "auth" });
    const sent = { ref: "seq:1", at: a.at + 1 };
    const b = stop({ reason: "decision", answer: sent, at: a.at + 2 });
    const c = stop({ reason: "decision", answer: sent, at: a.at + 3 });
    expect(reduceStops([a, b, c]).find((x) => x.reason === "decision")).toMatchObject({ count: 2, next: "decide" });
    // never answered at all, with another cause in between: asked
    const d = stop({ reason: "decision" });
    const e = stop({ reason: "auth", at: d.at + 1 });
    const f = stop({ reason: "decision", at: d.at + 2 });
    expect(reduceStops([d, e, f]).find((x) => x.reason === "decision")!.next).toBe("decide");
    // answered while another cause's stop was the one on screen: that answer is not this series'
    const g = stop({ reason: "decision" });
    const h = stop({ reason: "auth", at: g.at + 1000 });
    const toAuth = { ref: "seq:7", at: h.at + 500 };
    const i = stop({ reason: "decision", answer: toAuth, at: h.at + 1000 });
    const k = stop({ reason: "decision", answer: toAuth, at: h.at + 2000 });
    expect(reduceStops([g, h, i]).find((x) => x.reason === "decision")).toMatchObject({ changes: [{ kind: "cause", detail: "auth → decision" }], next: "decide" });
    expect(reduceStops([g, h, i, k]).find((x) => x.reason === "decision")!.next).toBe("decide");
    // an answer from before anything stopped here answers nothing
    const early = stop({ reason: "decision" }).at;
    const m = stop({ reason: "decision", answer: { ref: "seq:0", at: early - 10 }, at: early + 1000 });
    const p = stop({ reason: "decision", answer: { ref: "seq:0", at: early - 10 }, at: early + 2000 });
    expect(reduceStops([m, p])[0]).toMatchObject({ count: 2, next: "decide" });
  });

  test("an answer goes to the newest stop at its own target, not to a newer stop of another target of the same work", () => {
    const a = stop({ reason: "decision", target: "PR #12" });
    const b = stop({ reason: "decision", target: "PR #13", at: a.at + 1000 });
    const toA = { ref: "seq:5", at: b.at + 500 }; // after both stopped; the newest stop at PR 12 is a
    const a2 = stop({ reason: "decision", target: "PR #12", answer: toA, at: b.at + 1000 });
    expect(reduceStops([a, b, a2]).find((x) => x.target === "PR #12")).toMatchObject({ changes: [{ kind: "answer" }], next: "resume" });
  });

  test("an answered series whose conditions only moved or went away waits: no new question for the same stop", () => {
    const a = stop({ reason: "decision", conditions: [{ key: "x", value: "1", met: true }] });
    const answer = { ref: "seq:2", at: a.at + 1 };
    const b = stop({ reason: "decision", answer, conditions: [{ key: "x", value: "1", met: true }] });
    const c = stop({ reason: "decision", answer, conditions: [{ key: "x", value: "2", met: true }] });
    const d = stop({ reason: "decision", answer });
    expect(reduceStops([a, b, c])[0]).toMatchObject({ changes: [{ kind: "condition" }], next: "wait" });
    expect(reduceStops([a, b, c, d])[0]).toMatchObject({ changes: [{ kind: "condition", detail: "x: なし" }], next: "wait" });
  });

  test("a record with a seen id updates that stop instead of counting again", () => {
    const a = stop({ reason: "transient", state: "retrying", actions: [{ attempt: 1, at: 1, what: "再試行", ok: null }] });
    const a2 = { ...a, at: a.at + 10, state: "resolved" as const, actions: [{ attempt: 1, at: 1, what: "再試行", ok: true }] };
    const [s] = reduceStops([a, a2]);
    expect(s).toMatchObject({ count: 1, state: "resolved", next: "none", actions: [{ attempt: 1, ok: true }] });
    const ex = stop({ reason: "transient", state: "exhausted" });
    expect(reduceStops([ex])[0]!.next).toBe("decide");
  });

  test("missing fields read as unknown, never as a reason", () => {
    const s = StopRecord.parse({ id: "x", work: { workspaceId: null, issue: null, taskId: "t" }, op: "exec.run", reason: "made-up", state: "?", at: 1 });
    expect(s).toMatchObject({ reason: "unknown", state: "waiting", target: "", evidence: "", conditions: [], answer: null, actions: [] });
  });

  test("over-long text and lists are cut, never refused", () => {
    const s = stop({ evidence: "x".repeat(500), conditions: Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, value: "v", met: false })) });
    expect(s.evidence).toHaveLength(300);
    expect(s.conditions).toHaveLength(20);
    expect(s.conditions[19]!.key).toBe("k24");
    // the id is what tells an update from a new stop: refused when too long, never cut into another stop's id
    expect(StopRecord.safeParse({ ...s, id: "x".repeat(201) }).success).toBe(false);
  });
});

describe("StopFenceReader", () => {
  const report = { id: "ci", op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI pending" };
  const fence = (o: object) => "```switchboard-stop\n" + JSON.stringify(o) + "\n```";

  test("a fence split across deltas is read once it closes, the message's end closing a last line with no newline", () => {
    const r = new StopFenceReader();
    const text = `待ちます。\n${fence(report)}`;
    const cut = [7, 20, 45];
    const parts = [text.slice(0, cut[0]), text.slice(cut[0], cut[1]), text.slice(cut[1], cut[2]), text.slice(cut[2])];
    expect(parts.flatMap((p) => r.feed(p, "m1"))).toEqual([]);
    expect(r.end()).toMatchObject([{ id: "ci", reason: "depends", state: "waiting" }]);
    expect(r.end()).toEqual([]);
    // a closing line with its newline is read at once; a new message id closes the previous message too
    expect(r.feed(fence({ ...report, id: "a" }) + "\n", "m2")).toMatchObject([{ id: "a" }]);
    r.feed(fence({ ...report, id: "b" }), "m3");
    expect(r.feed("next", "m4")).toMatchObject([{ id: "b" }]);
  });

  test("a quoted example, an unclosed fence and a report that is not one are never read", () => {
    const r = new StopFenceReader();
    const quoted = "````md\n" + fence(report) + "\n````\n> " + fence(report).replace(/\n/g, "\n> ") + "\n";
    expect(r.feed(quoted, "m")).toEqual([]);
    expect(r.feed(fence({ id: "no-op" }) + "\n" + fence({ ...report, id: "" }) + "\n```switchboard-stop\nnot json\n```\n", "m")).toEqual([]);
    expect(r.feed("```switchboard-stop\n" + "x".repeat(9_000) + "\n" + JSON.stringify(report) + "\n```\n", "m")).toEqual([]);
    expect(r.feed(fence(report) + "\n", "m")).toMatchObject([{ id: "ci" }]); // and it still reads the next one
  });

  test("issueOf: a stage Task's #n of its workspace; none without a workspace or a stage", () => {
    expect(issueOf({ workspaceId: "w", stage: { issue: 939, action: "complete" } })).toBe(939);
    expect(issueOf({ workspaceId: null, stage: { issue: 939, action: "complete" } })).toBeNull();
    expect(issueOf({ workspaceId: "w", stage: null })).toBeNull();
  });
});

describe("reserveStopRetry / stopRecoveryPrompt", () => {
  const tried = (n: number, state: StopRecord["state"] = "retrying") => stop({ reason: "transient", safety: "read-only", state, actions: Array.from({ length: n }, (_, i) => ({ attempt: i + 1, at: 1, what: "再試行", ok: null })) });

  test("two more tries, 5 s then 30 s, of a passing failure that is harmless to repeat; a resolved stop starts over", () => {
    const next = { reason: "transient" as const, safety: "read-only" as const };
    expect(reserveStopRetry(undefined, next)).toEqual({ ok: true, attempt: 1, delayMs: 5_000 });
    expect(reserveStopRetry(tried(1), { ...next, safety: "before-effect" })).toEqual({ ok: true, attempt: 2, delayMs: 30_000 });
    expect(reserveStopRetry(tried(2), next)).toMatchObject({ ok: false, exhausted: true });
    expect(reserveStopRetry(tried(2, "resolved"), next)).toMatchObject({ ok: true, attempt: 1 });
  });

  test("never retried: an auth / permission / input error, or an operation that may have done something", () => {
    for (const reason of ["auth", "permission", "input", "decision", "unknown"] as const) expect(reserveStopRetry(undefined, { reason, safety: "read-only" })).toMatchObject({ ok: false, exhausted: false });
    expect(reserveStopRetry(undefined, { reason: "transient", safety: "unknown" })).toMatchObject({ ok: false, exhausted: false });
  });

  test("the prompt says how to report and the rule, and lists the work's open stops with the retries left", () => {
    const [s] = reduceStops([tried(1)]);
    const p = stopRecoveryPrompt([s!]);
    expect(p).toContain("```switchboard-stop");
    expect(p).toContain("最大 2 回（5 秒後、30 秒後）");
    expect(p).toContain("- gh pr merge PR #12: transient（止まったのは 1 回、retrying、再試行の残り 1 回）");
    expect(stopRecoveryPrompt([])).not.toContain("まだ解けていない");
  });

  test("stop grant: the newest stop's grant is the series' grant; the prompt says to write one for a permission stop", () => {
    const a = stop({ reason: "permission", grant: "PR #12 をマージすることだけ許可します" });
    const b = stop({ reason: "permission" });
    expect(reduceStops([a])[0]!.grant).toBe("PR #12 をマージすることだけ許可します");
    expect(reduceStops([a, b])[0]!.grant).toBeNull();
    expect(StopRecord.parse({ ...a, grant: "x".repeat(400) }).grant).toHaveLength(300);
    expect(stopRecoveryPrompt([])).toContain('許可文を "grant" に 1 文で書く');
  });

  test("prompt asks for wait conditions: a depends stop names its PRs / Issues as pr#N / issue#N, copied from overlap", () => {
    const p = stopRecoveryPrompt([]);
    expect(p).toContain('"conditions":[{"key":"pr#12","value":"open","met":false}]');
    expect(p).toContain("pr#N / issue#N");
    expect(p).toContain("overlap が重なり（defer）で進めないと言ったら、その出力の conditions をそのまま写す");
  });

  test("stop prompt names the after condition of a date wait and the route for waits over 7 days", () => {
    const p = stopRecoveryPrompt([]);
    expect(p).toContain('{"key":"after","value":"<ISO 8601 のタイムゾーンつき日時>"}');
    expect(p).toContain("7 日を超えるなら PBI の工程 Task は占有の解放の --after で引き渡す");
  });

  test("stop prompt names the runner condition of a usage-limit stop: runner#<runner> with the time, read by reportedLimit", () => {
    const p = stopRecoveryPrompt([]);
    expect(p).toContain("使用上限（usage-limit）は止めたランナーを runner#<ランナー>");
    expect(p).toContain("分からなければ unknown");
    const limit = (over: Partial<Omit<StopRecord, "work">> = {}) => stop({ reason: "usage-limit", state: "waiting", conditions: [{ key: "runner#codex", value: "2026-11-04T15:39:00+09:00", met: false }], ...over });
    expect(reportedLimit(limit())).toEqual({ runner: "codex", resetsAt: Date.parse("2026-11-04T06:39:00Z") });
    expect(reportedLimit(limit({ conditions: [{ key: "runner#codex", value: "unknown", met: false }] }))).toEqual({ runner: "codex" });
    expect(reportedLimit(limit({ conditions: [{ key: "runner#custom:foo", value: "soon", met: false }] }))).toEqual({ runner: "custom:foo" });
    expect(reportedLimit(limit({ state: "resolved" }))).toBeUndefined();
    expect(reportedLimit(limit({ state: "exhausted" }))).toBeUndefined();
    expect(reportedLimit(limit({ reason: "depends" }))).toBeUndefined();
    expect(reportedLimit(limit({ conditions: [] }))).toBeUndefined();
    expect(reportedLimit(limit({ conditions: [{ key: "pr#12", value: "open", met: false }] }))).toBeUndefined();
    expect(reportedLimit(limit({ conditions: [{ key: "runner#nobody", value: "unknown", met: false }] }))).toBeUndefined(); // not a runner id
  });

  test("recovery prompt forbids out-of-scope writes", () => {
    const p = stopRecoveryPrompt([]);
    expect(p).toContain("依頼の範囲外の書き込み");
    expect(p).toContain("計画モードでの commit・push・マージ");
    expect(p).toContain("リポジトリの CLAUDE.md が認めていない昇格");
    expect(p).not.toContain("聞かずに昇格");
  });
});

describe("FenceReader", () => {
  test("reads its own kind of fence only: another kind, a quoted example and broken JSON are not reports", () => {
    const r = new FenceReader("switchboard-artifact", parseArtifactFence);
    const fence = (body: string) => "```switchboard-artifact\n" + body + "\n```\n";
    expect(r.feed(fence(JSON.stringify({ path: "a.html", title: "A" })))).toEqual([{ ok: true, report: { path: "a.html", title: "A" } }]);
    expect(r.feed(fence("{not json"))).toEqual([{ ok: false, why: "JSON として読めません" }]); // a broken one is reported, not dropped
    expect(r.feed("~~~text\n" + fence(JSON.stringify({ path: "q.html" })) + "~~~\n")).toEqual([]); // quoted inside another fence
    expect(r.feed("```switchboard-stop\n" + JSON.stringify({ id: "x" }) + "\n```\n")).toEqual([]); // another kind
    expect(r.feed(fence(JSON.stringify({ path: "" }))).map((f) => f.ok)).toEqual([false]); // not an ArtifactReport
    // split across deltas, closed by the message's end
    expect(r.feed("途中\n```switchboard-artifact\n" + JSON.stringify({ path: "b.html" }))).toEqual([]);
    expect(r.feed("\n```")).toEqual([]);
    expect(r.end()).toEqual([{ ok: true, report: { path: "b.html" } }]);
  });
});

describe("stops of a schedule", () => {
  const mk = (id: string, scheduleId: string | null, createdAt: number) =>
    ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: createdAt, createdAt, updatedAt: createdAt }) as Task;
  const open = () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.t4495."));
    return { db: new Db(join(dir, "t.db")), dir };
  };
  const stopOf = (task: Task, over: Partial<Omit<StopRecord, "work">> = {}) =>
    stop({ op: "schedule run", target: "", reason: "input", evidence: "need input", ...over, work: { workspaceId: null, issue: null, taskId: task.id, ...(task.scheduleId ? { scheduleId: task.scheduleId } : {}) } });

  test("two Tasks of one schedule are one series; another schedule is another", () => {
    const a1 = mk("a1", "sa", 1), a2 = mk("a2", "sa", 2), b1 = mk("b1", "sb", 3);
    expect(stopWork(a1)).toMatchObject({ scheduleId: "sa" });
    expect(stopKey(stopOf(a1))).toBe(stopKey(stopOf(a2)));
    expect(stopKey(stopOf(a1))).not.toBe(stopKey(stopOf(b1)));
    expect(reduceStops([stopOf(a1), stopOf(a2)])).toMatchObject([{ count: 2 }]);
    expect(reduceStops([stopOf(a1), stopOf(b1)])).toHaveLength(2);
    // a record without scheduleId (an old one) stays the Task's own work
    expect(stopKey(stopOf(mk("x", null, 4)))).not.toBe(stopKey(stopOf(mk("y", null, 5))));
  });

  test("stuckSchedule: returned at two stops; null after an answer or a Task that did not stop", () => {
    const { db, dir } = open();
    try {
      const t = [mk("a1", "sa", 1), mk("a2", "sa", 2), mk("a3", "sa", 3)];
      for (const x of t) db.insertTask(x);
      expect(db.recentScheduleTaskIds("sa", 2)).toEqual(["a3", "a2"]);
      db.appendEvent("a1", { t: "stop.record", stop: stopOf(t[0]!) });
      expect(stuckSchedule(db, { id: "sa", lastTaskId: "a1" })).toBeNull(); // once
      const s2 = stopOf(t[1]!);
      db.appendEvent("a2", { t: "stop.record", stop: s2 });
      expect(stuckSchedule(db, { id: "sa", lastTaskId: "a2" })).toMatchObject({ count: 2, state: "waiting" });
      expect(stuckSchedule(db, { id: "sa", lastTaskId: "a3" })).toBeNull(); // the latest Task ended without stopping
      expect(stuckSchedule(db, { id: "sa", lastTaskId: null })).toBeNull();
      expect(stuckSchedule(db, { id: "sb", lastTaskId: "a2" })).toBeNull();
      expect(stopRecordsFor(db, t[2]!)).toHaveLength(2);
      // the person answered: a resumable series is not stuck
      db.appendEvent("a2", { t: "stop.record", stop: { ...s2, answer: { ref: "seq:9", at: s2.at + 1 }, at: s2.at + 1 } });
      expect(stuckSchedule(db, { id: "sa", lastTaskId: "a2" })).toBeNull();
    } finally {
      db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stuckSchedule: a Task whose stop ended resolved breaks the run", () => {
    const { db, dir } = open();
    try {
      const t = [mk("d1", "sd", 1), mk("d2", "sd", 2)];
      for (const x of t) db.insertTask(x);
      const s1 = stopOf(t[0]!);
      db.appendEvent("d1", { t: "stop.record", stop: s1 });
      db.appendEvent("d1", { t: "stop.record", stop: { ...s1, state: "resolved", at: s1.at + 1 } });
      db.appendEvent("d2", { t: "stop.record", stop: stopOf(t[1]!) });
      expect(stuckSchedule(db, { id: "sd", lastTaskId: "d2" })).toBeNull();
    } finally {
      db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stuckSchedule: only consecutive Tasks count; an exhausted stop is released by the person writing or its conditions met", () => {
    const { db, dir } = open();
    try {
      const t = [mk("c1", "sc", 1), mk("c2", "sc", 2), mk("c3", "sc", 3), mk("c4", "sc", 4)];
      for (const x of t) db.insertTask(x);
      db.appendEvent("c1", { t: "stop.record", stop: stopOf(t[0]!) });
      // c2 ended without stopping: c1 and c3 are not consecutive
      db.appendEvent("c3", { t: "stop.record", stop: stopOf(t[2]!) });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c3" })).toBeNull();
      const s4 = stopOf(t[3]!, { state: "exhausted" });
      db.appendEvent("c4", { t: "stop.record", stop: s4 });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c4" })).toMatchObject({ count: 2, state: "exhausted", firstAt: db.listStopRecords(["c3"])[0]!.at });
      // its conditions all met: released
      db.appendEvent("c4", { t: "stop.record", stop: { ...s4, conditions: [{ key: "lock", value: "gone", met: true }], at: s4.at + 1 } });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c4" })).toBeNull();
      db.appendEvent("c4", { t: "stop.record", stop: { ...s4, at: s4.at + 2 } });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c4" })).not.toBeNull();
      // a daemon's own turn (a user-role message) is no answer, nor is an answer older than the stop: still stuck
      db.appendEvent("c4", { t: "message.delta", role: "user", text: "続けてください" });
      db.appendEvent("c4", { t: "stop.record", stop: { ...s4, answer: { ref: "seq:1", at: s4.at - 1 }, at: s4.at + 3 } });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c4" })).not.toBeNull();
      // the person answered the exhausted stop (TaskManager.send records it, answerableStops): released
      db.appendEvent("c4", { t: "stop.record", stop: { ...s4, answer: { ref: "seq:7", at: s4.at + 4 }, at: s4.at + 4 } });
      expect(stuckSchedule(db, { id: "sc", lastTaskId: "c4" })).toBeNull();
    } finally {
      db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stopMarks", () => {
  const mk = (id: string, over: Partial<Task> = {}) =>
    ({ id, workspaceId: null, title: id, runner: "claude", cwd: "/tmp", scope: [], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "needs_action", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1, ...over }) as Task;
  const own = (t: Task, over: Partial<Omit<StopRecord, "work">> = {}) => stop({ ...over, work: { workspaceId: null, issue: null, taskId: t.id } });

  test("the newest series of a stopped Task; no record and 確認済み are left out; a Task judged done is read too", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.t4520."));
    const db = new Db(join(dir, "t.db"));
    try {
      const a = mk("a"), none = mk("none"), reviewed = mk("rv", { reviewedAt: 5 }), done = mk("dn", { outcome: "done" }), running = mk("rn", { status: "running" }), idle = mk("id", { status: "idle" }), archived = mk("ar", { archivedAt: 5 });
      for (const t of [a, none, reviewed, done, running, idle, archived]) {
        db.insertTask(t);
        if (t.id !== "none") db.appendEvent(t.id, { t: "stop.record", stop: own(t, { reason: "transient", evidence: "HTTP 503" }) });
      }
      db.appendEvent("a", { t: "stop.record", stop: own(a, { reason: "decision", evidence: "どちらか決めてください", conditions: [{ key: "pr#7", value: "open", met: false }] }) });
      // the Task's own stops are read, in one query, only for the stopped Tasks that are not 確認済み
      const marks = stopMarks(db, db.listTasks());
      expect(Object.keys(marks).sort()).toEqual(["a", "dn"]);
      // an archived Task is not on the list, and its records are not read either
      expect([...db.listStopRecordsOfStopped().keys()].sort()).toEqual(["a", "dn"]);
      expect(marks.dn).toMatchObject({ reason: "transient", state: "waiting" });
      expect(marks.a).toEqual({ key: expect.any(String), reason: "decision", state: "waiting", conditions: [{ key: "pr#7", value: "open", met: false }], count: 1, answered: false });
      // the Tasks passed in decide too, by personWait: one reviewed or back at work since the read has no mark
      expect(stopMarks(db, [{ ...a, reviewedAt: 9 }, { ...done, status: "running" }])).toEqual({});
    } finally {
      db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a newer stop of another Task of the same schedule is not this Task's last stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.t4520."));
    const db = new Db(join(dir, "t.db"));
    try {
      const older = mk("old", { scheduleId: "sch1", createdAt: 1 }), newer = mk("new", { scheduleId: "sch1", createdAt: 2 });
      for (const t of [older, newer]) db.insertTask(t);
      db.appendEvent("old", { t: "stop.record", stop: stop({ reason: "decision", evidence: "どちらか決めてください", work: { workspaceId: "ws1", issue: 939, taskId: "old" } }) });
      db.appendEvent("new", { t: "stop.record", stop: stop({ reason: "depends", state: "resolved", work: { workspaceId: "ws1", issue: 939, taskId: "new" } }) });
      // more newer Tasks of the schedule than stopRecordsFor reads: the old Task's own stop is still its mark
      for (let i = 0; i < 40; i++) db.insertTask(mk(`later${i}`, { scheduleId: "sch1", createdAt: 10 + i, status: "running" }));
      const marks = stopMarks(db, db.listTasks());
      expect(marks.old).toMatchObject({ reason: "decision", state: "waiting" });
      expect(marks.new).toMatchObject({ reason: "depends", state: "resolved" });
    } finally {
      db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("answered", () => {
  const seq = (at: number) => ({ ref: "seq:9", at });
  test("the newest stop answered after it came; not a URL answer, not one carried over to a stop that came after it", () => {
    const answered = (rs: StopRecord[]) => [reduceStops(rs)[0]!.answered, lastStopMark(rs)!.answered];
    // the person answered stop 1 (the answer is recorded on it)
    expect(answered([stop({ id: "s1", at: 1 }), stop({ id: "s1", at: 3, answer: seq(2) })])).toEqual([true, true]);
    // a runner's URL is a pointer, not the person's answer
    expect(answered([stop({ id: "s1", at: 1 }), stop({ id: "s1", at: 3, answer: { ref: "https://github.com/o/r/issues/1#issuecomment-1", at: 2 } })])).toEqual([false, false]);
    // stopped again after the answer: the new stop carries the old answer (recordStop), and is not answered
    expect(answered([stop({ id: "s1", at: 1 }), stop({ id: "s1", at: 3, answer: seq(2) }), stop({ id: "s2", at: 5, answer: seq(2) })])).toEqual([false, false]);
  });
});

describe("lastStopMark", () => {
  const mark = (records: StopRecord[]) => {
    const s = reduceStops(records)[0];
    return s ? { key: s.key, reason: s.reason, state: s.state, conditions: s.conditions, count: s.count, answered: s.answered } : null;
  };
  const reasons = ["decision", "depends", "unknown", "transient"] as const;
  const states = ["waiting", "retrying", "resolved", "exhausted"] as const;

  test("is the mark of reduceStops(...)[0]: none, one series, a new cause, a state moving on the same id, ties, unknown evidence", () => {
    expect(lastStopMark([])).toBeNull();
    const a = stop({ id: "a", reason: "depends", at: 10 });
    const cases: StopRecord[][] = [
      [a],
      [a, stop({ id: "a", reason: "depends", state: "resolved", at: 20 })],
      [a, stop({ id: "b", reason: "decision", at: 30, conditions: [{ key: "pr#7", value: "open", met: false }] })],
      [stop({ id: "c", reason: "unknown", evidence: "exit 1", at: 5 }), stop({ id: "d", reason: "unknown", evidence: "segfault", at: 5 })],
      [stop({ id: "e", reason: "transient", at: 1 }), stop({ id: "f", reason: "transient", at: 2 }), stop({ id: "g", reason: "decision", at: 3 }), stop({ id: "h", reason: "transient", at: 4 })],
    ];
    for (const c of cases) expect(lastStopMark(c)).toEqual(mark(c));
  });

  test("agrees with reduceStops over many generated records", () => {
    let seed = 7;
    const rnd = (k: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
    for (let round = 0; round < 200; round++) {
      const rs: StopRecord[] = [];
      for (let i = 0, len = 1 + rnd(8); i < len; i++) {
        rs.push(stop({ id: `r${rnd(4)}`, reason: reasons[rnd(4)]!, state: states[rnd(4)]!, evidence: `e${rnd(2)}`, at: rnd(6) * 10, op: rnd(2) ? "op1" : "op2", answer: rnd(3) ? null : { ref: rnd(2) ? `seq:${rnd(9)}` : "https://github.com/o/r/issues/1#issuecomment-1", at: rnd(6) * 10 } }));
      }
      expect(lastStopMark(rs)).toEqual(mark(rs));
    }
  });
});
