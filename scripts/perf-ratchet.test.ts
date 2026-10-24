import { describe, expect, test } from "bun:test";
import { BUDGET_PATH, ENVS, envOf, judge, lowered, raisedAgainst, type Budget, type Budgets } from "./perf-ratchet";

const budget: Budget = {
  journeys: { send: { requests: 6, layoutCount: 4, recalcStyleCount: 5, layoutShift: 0.0727 } },
  bundle: { js: 185095, css: 6009 },
};
/** A perf-bench result: the budget's shape plus the times, which are never compared. */
const result = (send: Partial<Budget["journeys"][string]>, bundle: Partial<Budget["bundle"]> = {}) => ({
  runs: 1,
  journeys: { send: { msMedian: 9999, msP90: 9999, ...budget.journeys.send!, ...send } },
  bundle: { ...budget.bundle, ...bundle },
});

describe("perf-ratchet judge", () => {
  test("over: a count above its ceiling, with its name, value and ceiling", () => {
    expect(judge(result({ layoutCount: 5 }, { js: 185096 }), budget)).toEqual({
      over: [{ key: "journeys.send.layoutCount", value: 5, ceiling: 4 }, { key: "bundle.js", value: 185096, ceiling: 185095 }],
      improved: [],
    });
  });
  test("improved: a count more than its band below the measured value — below ceiling − 2 × band (a bundle has no band)", () => {
    expect(judge(result({ requests: 3, layoutShift: 0.0126 }, { css: 6008 }), budget)).toEqual({
      over: [],
      improved: [
        { key: "journeys.send.requests", value: 3, ceiling: 6 },
        { key: "journeys.send.layoutShift", value: 0.0126, ceiling: 0.0727 },
        { key: "bundle.css", value: 6008, ceiling: 6009 },
      ],
    });
  });
  test("equal: the ceiling itself and anything down to ceiling − 2 × band pass (a new low of the same code's wobble); times are not compared", () => {
    expect(judge(result({}), budget)).toEqual({ over: [], improved: [] });
    expect(judge(result({ requests: 5, layoutCount: 3, recalcStyleCount: 4, layoutShift: 0.0427 }), budget)).toEqual({ over: [], improved: [] });
    expect(judge(result({ requests: 4, layoutCount: 2, recalcStyleCount: 3, layoutShift: 0.0127 }), budget)).toEqual({ over: [], improved: [] });
  });
  test("a ceiling the result has no value for throws", () => {
    expect(() => judge({ journeys: {}, bundle: budget.bundle }, budget)).toThrow("journeys.send.requests");
  });
});

describe("perf-ratchet update", () => {
  test("update lowers only: a beaten ceiling becomes the value + its band; worse counts leave theirs", () => {
    const r = result({ requests: 3, layoutCount: 9, layoutShift: 0.001 }, { js: 185000, css: 7000 });
    expect(lowered(judge(r, budget).improved, budget)).toEqual({
      journeys: { send: { requests: 4, layoutCount: 4, recalcStyleCount: 5, layoutShift: 0.031 } },
      bundle: { js: 185000, css: 6009 },
    });
  });
  test("a lowered budget judges the same result as equal", () => {
    const r = result({ requests: 3, layoutShift: 0.001 }, { js: 185000 });
    expect(judge(r, lowered(judge(r, budget).improved, budget))).toEqual({ over: [], improved: [] });
  });
});

describe("perf-ratchet raisedAgainst", () => {
  test("raised: a ceiling above main's in either environment; lower, equal and new keys are not", () => {
    const mine: Budgets = {
      github: {
        journeys: { send: { ...budget.journeys.send!, layoutCount: 5, requests: 5 }, launch: { requests: 99, layoutCount: 99, recalcStyleCount: 99, layoutShift: 1 } },
        bundle: { ...budget.bundle, js: 200000 },
      },
      local: { ...budget, bundle: { ...budget.bundle, css: 6010 } },
    };
    expect(raisedAgainst(mine, { github: budget, local: budget })).toEqual([
      { key: "github.journeys.send.layoutCount", value: 5, ceiling: 4 },
      { key: "github.bundle.js", value: 200000, ceiling: 185095 },
      { key: "local.bundle.css", value: 6010, ceiling: 6009 },
    ]);
  });
  test("an environment main does not have yet is not a raise", () => {
    expect(raisedAgainst({ github: budget, local: { ...budget, bundle: { js: 1e9, css: 1e9 } } }, { github: budget })).toEqual([]);
  });
});

describe("perf-ratchet environments (#644)", () => {
  test("the approved unstable metrics stay out of the gate in both environments (#644 answer A)", async () => {
    const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
    for (const env of ENVS) {
      const b = budgets[env];
      expect(b.journeys["open-task"]).not.toHaveProperty("layoutShift");
      expect(b.journeys.send).not.toHaveProperty("layoutCount");
      for (const name of ["launch", "new-task", "open-task", "send"]) {
        const expected = ["requests", "layoutCount", "recalcStyleCount", "layoutShift"].filter((key) => !(name === "open-task" && key === "layoutShift") && !(name === "send" && key === "layoutCount"));
        expect(Object.keys(b.journeys[name]!).sort()).toEqual(expected.sort());
      }
      for (const [layoutShift, layoutCount] of [[0.0002, 4], [0.047, 7], [0.5, 30]]) {
        const r = structuredClone(b);
        r.journeys["open-task"]!.layoutShift = layoutShift!;
        r.journeys.send!.layoutCount = layoutCount!;
        expect(judge(r, b)).toEqual({ over: [], improved: [] });
        expect(lowered(judge(r, b).improved, b)).toEqual(b);
      }
      const regression = structuredClone(b);
      regression.journeys.send!.requests!++;
      expect(judge(regression, b).over).toContainEqual({ key: "journeys.send.requests", value: b.journeys.send!.requests + 1, ceiling: b.journeys.send!.requests });
    }
  });
  test("github in Actions, local elsewhere (local-ci's CI=true is not Actions); --env overrides", () => {
    expect(envOf(undefined, { GITHUB_ACTIONS: "true", CI: "true" })).toBe("github");
    expect(envOf(undefined, { CI: "true" })).toBe("local");
    expect(envOf("github", {})).toBe("github");
    expect(() => envOf("mac", {})).toThrow("--env");
  });
  test("perf-budget.json has the four journeys and the bundle for each environment", async () => {
    const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
    expect(Object.keys(budgets).sort()).toEqual([...ENVS].sort());
    for (const env of ENVS) {
      expect(Object.keys(budgets[env].journeys).sort()).toEqual(["launch", "new-task", "open-task", "send"]);
      expect(Object.keys(budgets[env].bundle).sort()).toEqual(["css", "js"]);
    }
  });
});
