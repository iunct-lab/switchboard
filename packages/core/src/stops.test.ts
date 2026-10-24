import { describe, expect, test } from "bun:test";
import { StopRecord } from "@switchboard/protocol";
import { compareStopConditions, FenceReader, issueOf, reduceStops, reserveStopRetry, StopFenceReader, stopKey, stopRecoveryPrompt } from "./stops.ts";
import { parseArtifactFence } from "./artifacts.ts";

let n = 0;
/** A stop of #939 in workspace ws1 by default: the PR merge waiting on CI. */
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
    const toA = { ref: "seq:5", at: b.at + 500 }; // after both stopped; the newest stop at PR #12 is a
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

describe("reserveStopRetry / stopRecoveryPrompt (#949)", () => {
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

  test("recovery prompt forbids out-of-scope writes (#1987)", () => {
    const p = stopRecoveryPrompt([]);
    expect(p).toContain("依頼の範囲外の書き込み");
    expect(p).toContain("計画モードでの commit・push・マージ");
  });
});

describe("FenceReader (#1778)", () => {
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
