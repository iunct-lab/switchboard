// test-reads: apps/web/src/interventions.ts apps/web/src/flow.ts apps/web/src/artifacts.ts apps/web/src/i18n.ts apps/web/src/i18n/panels.ts
import { describe, expect, test } from "bun:test";
import type { InterventionReason, InterventionWindow } from "@switchboard/protocol";
import { interventionRows, populationLine, reasonRows, unknownLine } from "./interventions.ts";

const window = (over: Partial<InterventionWindow> = {}): InterventionWindow => ({
  days: 7, from: 0, to: 1, total: 10, byKind: { approval: 2, decision: 5, resume: 3, classifier: 1 }, unknown: 0, reAsks: 4,
  resumesAfterWaits: { count: 1, unknown: 0 }, open: { pbis: 2, interventions: 6 }, done: { pbis: 3, interventions: 4 },
  completed: { pbis: 3, perPbi: 2.5, unknownPbis: 0 }, reasons: [], ...over,
});
const byKey = (rows: ReturnType<typeof interventionRows>) => Object.fromEntries(rows.map((r) => [r.key, r]));

describe("interventions screen", () => {
  test("rows and unknown", () => {
    const rows = byKey(interventionRows(window(), window({ total: 7, byKind: { approval: 3, decision: 2, resume: 2, classifier: 0 }, reAsks: 4, completed: { pbis: 2, perPbi: 3, unknownPbis: 1 } })));
    expect(rows.approval).toMatchObject({ now: "2", before: "3", change: "-1" });
    expect(rows.classifier).toMatchObject({ label: "分類器の後", now: "1", before: "0", change: "+1" });
    expect(rows.decision).toMatchObject({ change: "+3" });
    expect(rows.total).toMatchObject({ now: "10", before: "7", change: "+3" });
    expect(rows.reAsks.change).toBe("±0");
    expect(rows.perPbi).toMatchObject({ now: "2.5", before: "3", change: "-0.5" });
    // places that could not be counted: the counts are "at least" and no difference is told
    const partial = byKey(interventionRows(window({ unknown: 1 }), window({ unknown: 1, total: 5, byKind: { approval: 0, decision: 0, resume: 0, classifier: 0 } })));
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

describe("in English (#2445)", () => {
  // the language is read once when i18n.ts loads: a fresh process with the browser's choice set to en
  test("the interventions' rows and lines, the flow's times and the artifacts tab read in English", () => {
    const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
    const code = `globalThis.localStorage = { getItem: (k) => (k === "switchboard.lang" ? "en" : null) };
const { interventionRows, populationLine, unknownLine, REASON_LABEL } = await import(${at("./interventions.ts")});
const { span, slowRow } = await import(${at("./flow.ts")});
const { artifactsLabel } = await import(${at("./artifacts.ts")});
const w = ${JSON.stringify(window({ unknown: 2, completed: { pbis: 3, perPbi: null, unknownPbis: 1 } }))};
const rows = Object.fromEntries(interventionRows(w, w).map((r) => [r.key, r]));
console.log(JSON.stringify([rows.total.label, rows.total.now, rows.perPbi.now, populationLine(w), unknownLine(w).split(" (")[0], REASON_LABEL.decision, span(30_000), span(90 * 60_000), slowRow({ number: 7, title: "x", url: "u", stages: { wait: 3 * 3_600_000 } }).longest, artifactsLabel(2)]));`;
    const r = Bun.spawnSync([process.execPath, "-e", code]);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual([
      "Total",
      "10 or more",
      "Unknown",
      "PBIs done: 3 (1 unknown) · interventions on open PBIs: 6 (PBIs: 2) · interventions on done PBIs: 4",
      "Places that could not be counted: 2",
      "Awaiting you",
      "under 1 min",
      "1.5 h",
      "Waiting to start 3 h",
      "Artifacts (2)",
    ]);
  });
});
