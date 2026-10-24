import { describe, expect, test } from "bun:test";
import type { StopSummary } from "@switchboard/protocol";
import { shownStops, stopDisplay } from "./stops.ts";

const s = (over: Partial<StopSummary> = {}): StopSummary => ({
  key: "k", work: { workspaceId: "ws", issue: 939, taskId: "t" }, op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI が終わっていない", safety: "unknown",
  count: 1, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, conditions: [], actions: [], changes: [], unchanged: false, next: "wait", ...over,
});

describe("stopDisplay", () => {
  test("first stop: no previous answer, no change, waiting needs no action", () => {
    expect(stopDisplay(s())).toMatchObject({ count: "初回", answer: "なし", changes: "なし", next: "条件の変化待ち・操作不要", needsPerson: false });
  });
  test("again with nothing changed says so; with a previous answer says which kind", () => {
    const d = stopDisplay(s({ count: 3, unchanged: true, lastAnswer: { ref: "seq:7", at: 5 } }));
    expect(d).toMatchObject({ count: "3 回目", answer: "あなたの回答あり", changes: "なし（同じ条件）" });
  });
  test("changes are named; a new cause is told apart from a met condition", () => {
    const d = stopDisplay(s({ count: 2, changes: [{ kind: "cause", detail: "depends → auth" }, { kind: "condition-met", detail: "pr#12: merged" }], next: "resume" }));
    expect(d.changes).toBe("別の原因（depends → auth）、条件が成立（pr#12: merged）");
    expect(d.next).toContain("再開");
  });
  test("a new cause is a series of its own (first count) and still shows the change", () => {
    expect(stopDisplay(s({ count: 1, changes: [{ kind: "cause", detail: "depends → auth" }], next: "decide" })).changes).toBe("別の原因（depends → auth）");
  });
  test("exhausted retries ask the person and list what was done", () => {
    const d = stopDisplay(s({ reason: "transient", state: "exhausted", next: "decide", count: 2, actions: [{ attempt: 1, at: 1, what: "5 秒後に再実行", ok: false }, { attempt: 2, at: 2, what: "30 秒後に再実行", ok: false }] }));
    expect(d).toMatchObject({ needsPerson: true, next: "あなたの判断が必要です" });
    expect(d.actions).toEqual(["1 回目: 5 秒後に再実行（失敗）", "2 回目: 30 秒後に再実行（失敗）"]);
  });
  test("an unknown cause with no evidence says 不明; long text is cut", () => {
    expect(stopDisplay(s({ reason: "unknown", evidence: "" })).evidence).toBe("不明");
    expect(stopDisplay(s({ evidence: "x".repeat(500) })).evidence.length).toBeLessThan(130);
  });
});

describe("shownStops", () => {
  test("a person's first, resolved one-offs hidden, resolved repeats kept", () => {
    const out = shownStops([s({ key: "a", lastAt: 9 }), s({ key: "b", next: "decide", lastAt: 1 }), s({ key: "c", state: "resolved", next: "none" }), s({ key: "d", state: "resolved", next: "none", count: 2 })]);
    expect(out.map((x) => x.key)).toEqual(["b", "a", "d"]);
  });
});
