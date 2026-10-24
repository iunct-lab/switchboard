import { describe, expect, test } from "bun:test";
import type { InterventionReason, InterventionWindow } from "@switchboard/protocol";
import { interventionRows, populationLine, reasonRows, unknownLine } from "./interventions.ts";

const window = (over: Partial<InterventionWindow> = {}): InterventionWindow => ({
  days: 7, from: 0, to: 1, total: 10, byKind: { approval: 2, decision: 5, resume: 3 }, unknown: 0, reAsks: 4,
  resumesAfterWaits: { count: 1, unknown: 0 }, open: { pbis: 2, interventions: 6 }, done: { pbis: 3, interventions: 4 },
  completed: { pbis: 3, perPbi: 2.5, unknownPbis: 0 }, reasons: [], ...over,
});
const byKey = (rows: ReturnType<typeof interventionRows>) => Object.fromEntries(rows.map((r) => [r.key, r]));

describe("interventions screen", () => {
  test("rows and unknown", () => {
    const rows = byKey(interventionRows(window(), window({ total: 7, byKind: { approval: 3, decision: 2, resume: 2 }, reAsks: 4, completed: { pbis: 2, perPbi: 3, unknownPbis: 1 } })));
    expect(rows.approval).toMatchObject({ now: "2", before: "3", change: "-1" });
    expect(rows.decision).toMatchObject({ change: "+3" });
    expect(rows.total).toMatchObject({ now: "10", before: "7", change: "+3" });
    expect(rows.reAsks.change).toBe("±0");
    expect(rows.perPbi).toMatchObject({ now: "2.5", before: "3", change: "-0.5" });
    // places that could not be counted: the counts are "at least" and no difference is told
    const partial = byKey(interventionRows(window({ unknown: 1 }), window({ unknown: 1, total: 5, byKind: { approval: 0, decision: 0, resume: 0 } })));
    expect(partial.total).toMatchObject({ now: "10 以上", before: "5 以上", change: "—" });
    expect(partial.approval).toMatchObject({ now: "2 以上", before: "0 以上", change: "—" }); // 0 is not shown as 0
    expect(partial.perPbi.change).toBe("—");

    // not known is 不明, never 0, and no change is told against it
    const unknown = byKey(interventionRows(window({ completed: { pbis: 0, perPbi: null, unknownPbis: 2 }, resumesAfterWaits: { count: 0, unknown: 2 } }), window()));
    expect(unknown.perPbi).toMatchObject({ now: "不明", before: "2.5", change: "—" });
    expect(unknown.afterWaits).toMatchObject({ now: "0（不明 2）", before: "1", change: "—" });

    expect(populationLine(window({ completed: { pbis: 3, perPbi: 2.5, unknownPbis: 1 } }))).toBe("完了した PBI 3 件（不明 1 件）· 未完了 2 件の介入 6 回 · 完了済みの PBI への介入 4 回");
    expect(unknownLine(window())).toBeNull();
    expect(unknownLine(window({ unknown: 2 }))).toContain("2 件");
  });

  test("reasons link", () => {
    const reason = (r: InterventionReason["reason"], issues: Array<[string | null, number | null]>): InterventionReason => ({
      reason: r, count: issues.length, notAutoResumed: 1,
      evidence: issues.map(([workspaceId, issue], i) => ({ workspaceId, issue, pbi: null, taskId: `t${i}`, url: issue === null ? null : `https://github.com/o/r/issues/${issue}`, evidence: "判断待ち", at: i })),
    });
    const w = window({ reasons: [reason("decision", [["a", 30], ["b", 31], [null, null]]), reason("depends", [["a", 7]])] });
    const prev = window({ reasons: [reason("depends", [["a", 8], ["a", 9]]), reason("auth", [["a", 5]])] });
    const rows = reasonRows(w, prev);
    // this period's most first, then what only the one before had; the change is told against the one before
    expect(rows.map((r) => [r.label, r.count, r.before, r.change])).toEqual([["判断待ち", 3, 0, "+3"], ["依存の待ち", 1, 2, "-1"], ["認証", 0, 1, "-1"]]);
    expect(rows[2]!.links).toEqual([]);
    expect(rows[2]!.linksBefore.map((l) => l.issue)).toEqual([5]); // a reason only the one before had: its stops are the ones to look at
    expect(rows[1]).toMatchObject({ notAutoResumed: 1, notAutoResumedBefore: 1 });
    expect(rows[1]!.linksBefore.map((l) => l.issue)).toEqual([8, 9]); // and the one before's stops stay reachable when this period had the reason too
    expect(rows[0]!.links[0]).toMatchObject({ issue: 30, url: "https://github.com/o/r/issues/30", taskId: "t0" });
    expect(rows[0]!.links[2]).toMatchObject({ issue: null, url: null, taskId: "t2" }); // no Issue: the Task is still there to open
    // narrowed to a workspace: the links narrow, the counts stay the whole
    const narrowed = reasonRows(w, prev, (id) => id === null || id === "a");
    expect(narrowed[0]!.count).toBe(3);
    expect(narrowed[0]!.links.map((l) => l.taskId)).toEqual(["t0", "t2"]);
  });
});
