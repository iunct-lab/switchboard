// test-reads: apps/web/src/asks.ts apps/web/src/inProgress.ts apps/web/src/terminalReconnect.ts apps/web/src/i18n.ts apps/web/src/i18n/task.ts
import { describe, expect, test } from "bun:test";
import type { StopSummary } from "@switchboard/protocol";
import { personStops, shownStops, stopDisplay } from "./stops.ts";

const s = (over: Partial<StopSummary> = {}): StopSummary => ({
  key: "k", work: { workspaceId: "ws", issue: 939, taskId: "t" }, op: "gh pr merge", target: "PR #12", reason: "depends", evidence: "CI が終わっていない", safety: "unknown",
  count: 1, state: "waiting", firstAt: 1, lastAt: 2, lastAnswer: null, conditions: [], actions: [], changes: [], unchanged: false, next: "wait", ...over,
});

describe("stopDisplay", () => {
  test("a disk-full stop reads in words", () => {
    expect(stopDisplay(s({ reason: "disk-full" })).title).toContain("ディスクの空き切れ");
  });

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

describe("in English (#2444)", () => {
  // the language is read once when i18n.ts loads: a fresh process with the browser's choice set to en
  test("a stop, a question's badge, a backlog row's wait and the terminal's end read in English", () => {
    const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
    const code = `globalThis.localStorage = { getItem: (k) => (k === "switchboard.lang" ? "en" : null) };
const { stopDisplay } = await import(${at("./stops.ts")});
const { resumeLabel, KIND_LABEL } = await import(${at("./asks.ts")});
const { ago } = await import(${at("./inProgress.ts")});
const { afterClose } = await import(${at("./terminalReconnect.ts")});
const d = stopDisplay(${JSON.stringify(s({ count: 2, changes: [{ kind: "answer", detail: "x" }], next: "decide", actions: [{ attempt: 1, what: "retry", ok: false }] }))});
console.log(JSON.stringify([d.count, d.changes, d.next, d.actions, resumeLabel({ state: "answered", resume: { state: "queued", reason: "budget" } }).text, KIND_LABEL.check, ago(0, 3 * 3_600_000), afterClose(1000, null, 0).message]));`;
    const r = Bun.spawnSync([process.execPath, "-e", code]);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual(["seen 2 times", "A new answer (x)", "Needs your decision", ["Attempt 1: retry (failed)"], "Waiting to resume: budget", "Question", "3 h ago", "The terminal has exited."]);
  });
});

describe("personStops", () => {
  test("keeps only the series that need a person, in the order shownStops gives", () => {
    const stops = [s({ key: "wait", next: "wait", lastAt: 9 }), s({ key: "d1", next: "decide", lastAt: 3 }), s({ key: "d2", next: "decide", lastAt: 5 }), s({ key: "resolved", next: "decide", state: "resolved", count: 1 })];
    expect(personStops(stops).map((x) => x.key)).toEqual(["d2", "d1"]);
  });
  test("none when nothing needs a person", () => {
    expect(personStops([s({ next: "retry" })])).toEqual([]);
  });
});
