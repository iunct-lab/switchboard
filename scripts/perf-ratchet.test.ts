// test-reads: scripts/perf-ratchet.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedExceptions, BUDGET_PATH, BUNDLE_GROWTH_LIMIT, bundleGrowth, BYTES_RECORDS_HEADER, bytesGrowth, bytesHistoryTable, bytesRows, parseBytesRows, ENVS, envOf, historyTable, judge, judgeDurations, knownExceptions, lowered, loweredBudgets, parseRows, raisedAgainst, recordRow, RECORDS_HEADER, shapeOf, type Budget, type Budgets } from "./perf-ratchet";

const budget: Budget = {
  journeys: { send: { requests: 6, layoutCount: 4, recalcStyleCount: 5, layoutShift: 0.0727 } },
};
/** A perf-bench result: the budget's shape plus the times, which are never compared, and the bundle, which has no ceiling. */
const result = (send: Partial<Budget["journeys"][string]>) => ({
  runs: 1,
  journeys: { send: { msMedian: 9999, msP90: 9999, ...budget.journeys.send!, ...send } },
  bundle: { js: 185095, css: 6009 },
});

describe("perf-ratchet judge", () => {
  const withLoaded: Budget = { ...budget, loaded: { healthMaxMs: 5000 } };
  const loaded = (healthMaxMs: number) => ({ ...result({}), loaded: { healthMaxMs, healthMaxMsP90: 99999 } });
  test("judge: loaded.healthMaxMs over its ceiling is over (#2822)", () => {
    expect(judge(loaded(5001), withLoaded)).toEqual({ over: [{ key: "loaded.healthMaxMs", value: 5001, ceiling: 5000 }], improved: [] });
  });
  test("judge: loaded.healthMaxMs far below its ceiling is not improved, so update keeps it (#3574)", () => {
    const b: Budgets = { github: budget, local: { ...budget, loaded: { healthMaxMs: 5440 } } };
    // a quiet host: 1714 far below the ceiling (5440 − 2 × 1750 = 1940 with the band then), yet not improved
    const { over, improved } = judge(loaded(1714), b.local);
    expect([over, improved]).toEqual([[], []]);
    expect(loweredBudgets(b, "local", improved).local.loaded).toEqual({ healthMaxMs: 5440 });
    expect(judge(loaded(5441), b.local)).toEqual({ over: [{ key: "loaded.healthMaxMs", value: 5441, ceiling: 5440 }], improved: [] });
    // a journey count below ceiling − 2 × band is still improved
    expect(judge({ ...result({ requests: 3 }), loaded: { healthMaxMs: 1714, healthMaxMsP90: 1901 } }, b.local).improved.map((i) => i.key)).toEqual(["journeys.send.requests"]);
  });
  test("judge: a result that skipped loaded leaves its ceiling out; one without loaded and no reason still throws (#3635)", () => {
    expect(judge({ ...result({}), loadedSkipped: "変更 1 ファイルのどれも scripts/perf-bench.ts に届かない" }, withLoaded)).toEqual({ over: [], improved: [] });
    expect(judge({ ...result({ requests: 9 }), loadedSkipped: "docs only" }, withLoaded).over.map((i) => i.key)).toEqual(["journeys.send.requests"]);
    expect(() => judge(result({}), withLoaded)).toThrow("the result has no loaded.healthMaxMs");
  });
  test("judge: a budget without loaded does not need it in the result (#2822)", () => {
    expect(judge(result({}), budget)).toEqual({ over: [], improved: [] });
  });
  test("over: a count above its ceiling, with its name, value and ceiling", () => {
    expect(judge(result({ layoutCount: 5 }), budget)).toEqual({
      over: [{ key: "journeys.send.layoutCount", value: 5, ceiling: 4 }],
      improved: [],
    });
  });
  test("improved: a count more than its band below the measured value — below ceiling − 2 × band", () => {
    expect(judge(result({ requests: 3, layoutShift: 0.0126 }), budget)).toEqual({
      over: [],
      improved: [
        { key: "journeys.send.requests", value: 3, ceiling: 6 },
        { key: "journeys.send.layoutShift", value: 0.0126, ceiling: 0.0727 },
      ],
    });
  });
  test("equal: the ceiling itself and anything down to ceiling − 2 × band pass (a new low of the same code's wobble); times are not compared", () => {
    expect(judge(result({}), budget)).toEqual({ over: [], improved: [] });
    expect(judge(result({ requests: 5, layoutCount: 3, recalcStyleCount: 4, layoutShift: 0.0427 }), budget)).toEqual({ over: [], improved: [] });
    expect(judge(result({ requests: 4, layoutCount: 2, recalcStyleCount: 3, layoutShift: 0.0127 }), budget)).toEqual({ over: [], improved: [] });
  });
  test("a ceiling the result has no value for throws", () => {
    expect(() => judge({ journeys: {} }, budget)).toThrow("journeys.send.requests");
  });
});

describe("perf-ratchet update", () => {
  test("update lowers only: a beaten ceiling becomes the value + its band; worse counts leave theirs", () => {
    const r = result({ requests: 3, layoutCount: 9, layoutShift: 0.001 });
    expect(lowered(judge(r, budget).improved, budget)).toEqual({
      journeys: { send: { requests: 4, layoutCount: 4, recalcStyleCount: 5, layoutShift: 0.031 } },
    });
  });
  test("a lowered budget judges the same result as equal", () => {
    const r = result({ requests: 3, layoutShift: 0.001 });
    expect(judge(r, lowered(judge(r, budget).improved, budget))).toEqual({ over: [], improved: [] });
  });
});

describe("perf-ratchet bytes against main's (#3921)", () => {
  const evals = (n: number) => ({ "/api/tasks/:id": { count: 2, bytes: 30000 }, "/api/tasks/:id/evals": { count: 2, bytes: n } });
  const main = { "open-task": { bytes: 35597, responses: evals(1000) }, "open-task-huge": { bytes: 36106, responses: evals(1000) } };
  test("shapeOf: a task id, a uuid and digits are :id; words stay", () => {
    expect(shapeOf("/api/tasks/task_0002103a4e35/evals")).toBe("/api/tasks/:id/evals");
    expect(shapeOf("/api/backlog/0b9f4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("/api/backlog/:id");
    expect(shapeOf("/api/issues/3921/comments")).toBe("/api/issues/:id/comments");
    expect(shapeOf("/api/workspaces")).toBe("/api/workspaces");
  });
  test("bytesGrowth: +44 B (0.12%) is a bytes line and the response that grew, no grew:", () => {
    const merged = { "open-task": { bytes: 35641, responses: evals(1044) }, "open-task-huge": { bytes: 36150, responses: evals(1044) } };
    expect(bytesGrowth(merged, main)).toEqual({
      lines: [
        "bytes: open-task 35641 B (main 35597 B, +44 B, +0.12%)",
        "  /api/tasks/:id/evals +22 B × 2",
        "bytes: open-task-huge 36150 B (main 36106 B, +44 B, +0.12%)",
        "  /api/tasks/:id/evals +22 B × 2",
      ],
      grew: [],
    });
  });
  test("bytesGrowth: 1% or more is grew:, the same limit as the bundle; a response read more often says both counts", () => {
    const merged = { "open-task": { bytes: 35953, responses: { ...evals(1000), "/api/tasks/:id/diff": { count: 1, bytes: 356 } } }, "open-task-huge": { bytes: 36106, responses: evals(1000) } };
    const g = bytesGrowth(merged, main);
    expect(g.grew).toEqual(["grew: bytes.open-task +1.00% (35597 → 35953 B) ≥ 1%: merging is the user's call (docs/design/perf.md)"]);
    expect(g.lines).toEqual(["bytes: open-task 35953 B (main 35597 B, +356 B, +1.00%)", "  /api/tasks/:id/diff +356 B（1 回、main 0 回）", "bytes: open-task-huge 36106 B (main 36106 B, +0 B, +0.00%)"]);
  });
  test("bytesGrowth: a main without responses judges bytes alone; a main without journeys judges nothing", () => {
    const merged = { "open-task": { bytes: 36000, responses: evals(1000) }, "open-task-huge": { bytes: 36106, responses: evals(1000) } };
    expect(bytesGrowth(merged, { "open-task": { bytes: 35597 }, "open-task-huge": { bytes: 36106 } })).toEqual({
      lines: ["bytes: open-task 36000 B (main 35597 B, +403 B, +1.13%)", "bytes: open-task-huge 36106 B (main 36106 B, +0 B, +0.00%)"],
      grew: ["grew: bytes.open-task +1.13% (35597 → 36000 B) ≥ 1%: merging is the user's call (docs/design/perf.md)"],
    });
    expect(bytesGrowth(merged, undefined).grew).toEqual([]);
    expect(() => bytesGrowth({ "open-task": merged["open-task"] }, main)).toThrow("journeys.open-task-huge.bytes");
  });
  test("check: +0.12% bytes is exit 0 with the bytes and response lines; 1% or more is exit 1 with grew:", async () => {
    const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
    const dir = mkdtempSync(join(tmpdir(), "sb-perf-ratchet-test-"));
    try {
      const bundle = { js: 100000, css: 10000 };
      const base = join(dir, "base.json");
      writeFileSync(base, JSON.stringify({ sha: "a".repeat(40), bundle, journeys: main }));
      const run = async (openTask: number, evalsBytes: number) => {
        const r = join(dir, "result.json");
        const journeys = { ...budgets.local.journeys, "open-task": { ...budgets.local.journeys["open-task"], bytes: openTask, responses: evals(evalsBytes) }, "open-task-huge": { bytes: 36106, responses: evals(1000) } };
        writeFileSync(r, JSON.stringify({ runs: 5, journeys, bundle, loaded: budgets.local.loaded }));
        const p = Bun.spawn([process.execPath, "scripts/perf-ratchet.ts", "check", r, "--base", base, "--env", "local"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { out: out + err, code };
      };
      const small = await run(35641, 1044);
      expect([small.code, small.out.includes("grew:")]).toEqual([0, false]);
      expect(small.out).toContain("bytes: open-task 35641 B (main 35597 B, +44 B, +0.12%)\n  /api/tasks/:id/evals +22 B × 2\n");
      const big = await run(35953, 1356);
      expect(big.code).toBe(1);
      expect(big.out).toContain("grew: bytes.open-task +1.00% (35597 → 35953 B)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("bytes has no ceiling: judge leaves a result's bytes and responses out", () => {
    const r = { journeys: { "open-task": { requests: 9, bytes: 99999, responses: evals(1) } } } as unknown as Budget;
    expect(judge(r, { journeys: { "open-task": { requests: 9 } } })).toEqual({ over: [], improved: [] });
  });
});

describe("perf-ratchet raisedAgainst", () => {
  test("raised: a ceiling above main's in either environment; lower, equal and new keys are not", () => {
    const mine: Budgets = {
      github: {
        journeys: { send: { ...budget.journeys.send!, layoutCount: 5, requests: 5 }, launch: { requests: 99, layoutCount: 99, recalcStyleCount: 99, layoutShift: 1 } },
      },
      local: { journeys: { send: { ...budget.journeys.send!, recalcStyleCount: 6 } } },
    };
    expect(raisedAgainst(mine, { github: budget, local: budget })).toEqual([
      { key: "github.journeys.send.layoutCount", value: 5, ceiling: 4 },
      { key: "local.journeys.send.recalcStyleCount", value: 6, ceiling: 5 },
    ]);
    // main's bundle ceilings (before they went) are not raised by a budget without them
    expect(raisedAgainst({ github: budget, local: budget }, { github: { ...budget, bundle: { js: 1, css: 1 } } as Budget, local: budget })).toEqual([]);
  });
  test("an environment main does not have yet is not a raise", () => {
    expect(raisedAgainst({ github: budget, local: { journeys: { send: { ...budget.journeys.send!, requests: 1e9 } } } }, { github: budget })).toEqual([]);
  });
});

describe("perf-ratchet durations (#1887)", () => {
  const timed: Budget = { ...budget, durations: { typecheck: 60, test: 50 } };
  test("test duration ceiling: the ceiling itself passes, 0.1 over is over, far below is no failure", () => {
    expect(judgeDurations({ typecheck: 60, test: 50 }, timed)).toEqual([]);
    expect(judgeDurations({ typecheck: 60, test: 50.1 }, timed)).toEqual([{ key: "durations.test", value: 50.1, ceiling: 50 }]);
    expect(judgeDurations({ typecheck: 60.1, test: 50.1 }, timed).map((i) => i.key)).toEqual(["durations.typecheck", "durations.test"]);
    expect(judgeDurations({ typecheck: 1, test: 1 }, timed)).toEqual([]);
  });
  test("test duration ceiling: a budget without durations compares nothing", () => {
    expect(judgeDurations({ typecheck: 1e6, test: 1e6 }, budget)).toEqual([]);
  });
  test("test duration ceiling: judge does not ask a perf-bench result for the seconds", () => {
    expect(judge(result({}), timed)).toEqual({ over: [], improved: [] });
  });
  test("test duration ceiling: raising one is raised; lowering one or adding the first is not", () => {
    const main = { github: budget, local: timed };
    const mine = (durations: Budget["durations"]): Budgets => ({ github: budget, local: { ...budget, durations } });
    expect(raisedAgainst(mine({ typecheck: 60, test: 51 }), main)).toEqual([{ key: "local.durations.test", value: 51, ceiling: 50 }]);
    expect(raisedAgainst(mine({ typecheck: 59, test: 50 }), main)).toEqual([]);
    expect(raisedAgainst(mine({ typecheck: 60, test: 50 }), { github: budget, local: budget })).toEqual([]);
  });
});

describe("perf-ratchet exceptions (#1890)", () => {
  const item = { key: "journeys.send.layoutShift", value: 0.1, ceiling: 0.0727 };
  const other = { key: "journeys.send.requests", value: 7, ceiling: 6 };
  const exceptions = [{ key: "local.journeys.send.layoutShift", issue: 7 }];
  test("known exception by open issue: only the named count, in its environment, while its Issue is open", () => {
    const open = (n: number) => n === 7;
    expect(knownExceptions([item, other], "local", exceptions, open)).toEqual({ known: [{ ...item, issue: 7 }], over: [other] });
    expect(knownExceptions([item], "local", exceptions, () => false)).toEqual({ known: [], over: [item] });
    expect(knownExceptions([item], "github", exceptions, open)).toEqual({ known: [], over: [item] });
    expect(knownExceptions([], "local", exceptions, () => { throw new Error("no Issue to read"); })).toEqual({ known: [], over: [] });
  });
  test("known exception by open issue: a count under its ceiling is not over, so nothing is printed for it", () => {
    expect(judge(result({ layoutShift: 0.07 }), budget).over).toEqual([]);
  });
  test("known exception by open issue: an exception main does not have is added; the same key for another Issue too", () => {
    const budgets = { exceptions, github: budget, local: budget };
    expect(addedExceptions(budgets, {})).toEqual(exceptions);
    expect(addedExceptions(budgets, { exceptions })).toEqual([]);
    expect(addedExceptions(budgets, { exceptions: [{ ...exceptions[0]!, issue: 8 }] })).toEqual(exceptions);
    expect(addedExceptions({ github: budget, local: budget }, { exceptions })).toEqual([]);
  });
  test("update keeps the exceptions", () => {
    expect(loweredBudgets({ exceptions, github: budget, local: budget }, "local", []).exceptions).toEqual(exceptions);
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
      // bytes is judged against main's tip, not a ceiling (#3921): open-task-huge has none
      expect(b.journeys["open-task"]).not.toHaveProperty("bytes");
      expect(b.journeys).not.toHaveProperty("open-task-huge");
      for (const [layoutShift, layoutCount] of [[0.0002, 4], [0.047, 7], [0.5, 30]]) {
        const r = structuredClone(b);
        r.journeys["open-task"]!.layoutShift = layoutShift!;
        r.journeys.send!.layoutCount = layoutCount!;
        expect(judge(r, b)).toEqual({ over: [], improved: [] });
        expect(lowered(judge(r, b).improved, b)).toEqual(b);
      }
      const regression = structuredClone(b);
      regression.journeys.send!.requests!++;
      expect(judge(regression, b).over).toContainEqual({ key: "journeys.send.requests", value: b.journeys.send!.requests! + 1, ceiling: b.journeys.send!.requests });
    }
  });
  test("github in Actions, local elsewhere (local-ci's CI=true is not Actions); --env overrides", () => {
    expect(envOf(undefined, { GITHUB_ACTIONS: "true", CI: "true" })).toBe("github");
    expect(envOf(undefined, { CI: "true" })).toBe("local");
    expect(envOf("github", {})).toBe("github");
    expect(() => envOf("mac", {})).toThrow("--env");
  });
  test("perf-budget.json has the four journeys for each environment and no bundle or bytes", async () => {
    const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
    expect(Object.keys(budgets).filter((k) => k !== "exceptions").sort()).toEqual([...ENVS].sort());
    for (const env of ENVS) {
      expect(Object.keys(budgets[env].journeys).sort()).toEqual(["launch", "new-task", "open-task", "send"]);
      expect(budgets[env]).not.toHaveProperty("bundle");
    }
    // the seconds local-ci compares: `local` only (no ceilings for Actions)
    expect(Object.keys(budgets.local.durations!).sort()).toEqual(["test", "typecheck"]);
    expect(budgets.github.durations).toBeUndefined();
  });
});

describe("perf-ratchet bundle growth (#3167)", () => {
  test("bundleGrowth: the bundle line either way; grew only at 1% or more, js and css each", () => {
    expect(BUNDLE_GROWTH_LIMIT).toBe(0.01);
    expect(bundleGrowth({ js: 1005, css: 100 }, { js: 1000, css: 100 })).toEqual({ line: "bundle: js 1005 B (main 1000 B, +5 B, +0.50%) / css 100 B (main 100 B, +0 B, +0.00%)", grew: [] });
    // smaller: a minus, never grew
    expect(bundleGrowth({ js: 980, css: 90 }, { js: 1000, css: 100 })).toEqual({ line: "bundle: js 980 B (main 1000 B, -20 B, -2.00%) / css 90 B (main 100 B, -10 B, -10.00%)", grew: [] });
    // exactly 1% is grew; css alone
    expect(bundleGrowth({ js: 1009, css: 101 }, { js: 1000, css: 100 }).grew).toEqual(["grew: bundle.css +1.00% (100 → 101 B) ≥ 1%: merging is the user's call (docs/design/perf.md)"]);
  });

  test("bundle: 0.5% over main is exit 0 with the bundle line; 1.1% is exit 1 with grew:; a requests over its ceiling stays exit 1", async () => {
    const budgets = (await Bun.file(BUDGET_PATH).json()) as Budgets;
    const dir = mkdtempSync(join(tmpdir(), "sb-perf-ratchet-test-"));
    try {
      const base = join(dir, "base.json");
      writeFileSync(base, JSON.stringify({ sha: "a".repeat(40), bundle: { js: 100000, css: 10000 } }));
      // the journeys exactly at the local ceilings: neither over nor improved
      const run = async (bundle: { js: number; css: number }, journeys = budgets.local.journeys, args = ["--base", base], loaded: object | undefined = budgets.local.loaded) => {
        const r = join(dir, "result.json");
        writeFileSync(r, JSON.stringify({ runs: 5, journeys, bundle, loaded }));
        const p = Bun.spawn([process.execPath, "scripts/perf-ratchet.ts", "check", r, ...args, "--env", "local"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { out: out + err, code };
      };
      const small = await run({ js: 100500, css: 10000 });
      expect([small.code, small.out]).toEqual([0, expect.stringContaining("bundle: js 100500 B (main 100000 B, +500 B, +0.50%) / css 10000 B (main 10000 B, +0 B, +0.00%)")]);
      expect(small.out).not.toContain("grew:");
      // a quiet host's loaded.healthMaxMs far below its ceiling: exit 0, no improved: line (#3574)
      const quiet = await run({ js: 100000, css: 10000 }, budgets.local.journeys, ["--base", base], { healthMaxMs: 1714, healthMaxMsP90: 1901 });
      expect([quiet.code, quiet.out.includes("improved:")]).toEqual([0, false]);
      const big = await run({ js: 101100, css: 10000 });
      expect(big.code).toBe(1);
      expect(big.out).toContain("bundle: js 101100 B (main 100000 B, +1100 B, +1.10%)");
      expect(big.out).toContain("grew: bundle.js +1.10% (100000 → 101100 B) ≥ 1%: merging is the user's call (docs/design/perf.md)");
      const more = structuredClone(budgets.local.journeys);
      more.launch!.requests++;
      const over = await run({ js: 100000, css: 10000 }, more);
      expect(over.code).toBe(1);
      expect(over.out).toContain(`over: journeys.launch.requests = ${more.launch!.requests} > ceiling ${budgets.local.journeys.launch!.requests}`);
      expect(over.out).toContain("bundle: js 100000 B (main 100000 B, +0 B, +0.00%)");
      // no --base: usage, exit 2
      expect((await run({ js: 1, css: 1 }, budgets.local.journeys, [])).code).toBe(2);
      // base without its ref or its file: usage, exit 2, nothing built
      for (const a of [["origin/main"], []]) {
        const p = Bun.spawnSync([process.execPath, "scripts/perf-ratchet.ts", "base", ...a], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "/nonexistent" } });
        expect([a.length, p.exitCode, p.stderr.toString().includes("usage: bun scripts/perf-ratchet.ts base <ref> <out.json>")]).toEqual([a.length, 2, true]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("perf-ratchet bundle records", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  test("history: rows in time order with the increase from the first row; --since drops earlier rows; the same main measured twice is two rows", () => {
    const tsv = [
      RECORDS_HEADER,
      recordRow("2026-11-03T09:00:00.000Z", { sha: B, bundle: { js: 1010, css: 99 } }),
      "a broken row",
      recordRow("2026-11-01T09:00:00.000Z", { sha: A, bundle: { js: 1000, css: 100 } }),
      recordRow("2026-11-02T09:00:00.000Z", { sha: A, bundle: { js: 1000, css: 100 } }),
      "",
    ].join("\n");
    const rows = parseRows(tsv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ measuredAt: "2026-11-03T09:00:00.000Z", js: 1010, css: 99, main: B });
    expect(historyTable(rows)).toEqual([
      "| 測った日時 | js B | css B | js 初めから | css 初めから | main |",
      "|---|---|---|---|---|---|",
      `| 2026-11-01T09:00:00.000Z | 1000 | 100 | +0 B (+0.00%) | +0 B (+0.00%) | ${A.slice(0, 7)} |`,
      `| 2026-11-02T09:00:00.000Z | 1000 | 100 | +0 B (+0.00%) | +0 B (+0.00%) | ${A.slice(0, 7)} |`,
      `| 2026-11-03T09:00:00.000Z | 1010 | 99 | +10 B (+1.00%) | -1 B (-1.00%) | ${B.slice(0, 7)} |`,
      "期間の増加: js +10 B (+1.00%) / css -1 B (-1.00%)",
    ]);
    // --since: the first row of the period is the one the increase is from
    expect(historyTable(rows, "2026-11-02")).toEqual([
      "| 測った日時 | js B | css B | js 初めから | css 初めから | main |",
      "|---|---|---|---|---|---|",
      `| 2026-11-02T09:00:00.000Z | 1000 | 100 | +0 B (+0.00%) | +0 B (+0.00%) | ${A.slice(0, 7)} |`,
      `| 2026-11-03T09:00:00.000Z | 1010 | 99 | +10 B (+1.00%) | -1 B (-1.00%) | ${B.slice(0, 7)} |`,
      "期間の増加: js +10 B (+1.00%) / css -1 B (-1.00%)",
    ]);
    expect(historyTable(rows, "2026-11-04")).toEqual(["記録なし"]);
    expect(historyTable(parseRows(RECORDS_HEADER))).toEqual(["記録なし"]);
  });
  test("history: a bad --since, a --repo without its value or a word left over is usage, exit 2, before any read", () => {
    for (const a of [["--since", "2026-1"], ["--repo"], ["extra"]]) {
      const p = Bun.spawnSync([process.execPath, "scripts/perf-ratchet.ts", "history", ...a], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "/nonexistent" } });
      expect([a.join(" "), p.exitCode]).toEqual([a.join(" "), 2]);
      expect(p.stderr.toString()).toContain("usage: bun scripts/perf-ratchet.ts history");
    }
  });
});

describe("perf-ratchet bytes records (#3921)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const responses = (evals: number) => ({ "/api/tasks/:id/evals": { count: 2, bytes: evals }, "/api/tasks/:id": { count: 1, bytes: 30000 } });
  test("bytesRows: a row per journey and response's path, sorted; a journey without responses is one (total) row", () => {
    expect(bytesRows("2026-11-05T01:00:00.000Z", { sha: A, journeys: { "open-task": { bytes: 31000, responses: responses(1000) }, "open-task-huge": { bytes: 36106 } } })).toEqual([
      `2026-11-05T01:00:00.000Z\topen-task\t/api/tasks/:id\t1\t30000\t${A}`,
      `2026-11-05T01:00:00.000Z\topen-task\t/api/tasks/:id/evals\t2\t1000\t${A}`,
      `2026-11-05T01:00:00.000Z\topen-task-huge\t(total)\t0\t36106\t${A}`,
    ]);
  });
  test("history: per measure the journeys' sums in time order with the increase from the first; --since drops earlier ones; bad rows are passed over", () => {
    const tsv = [
      BYTES_RECORDS_HEADER,
      ...bytesRows("2026-11-06T09:00:00.000Z", { sha: B, journeys: { "open-task": { bytes: 31044, responses: responses(1044) }, "open-task-huge": { bytes: 36150, responses: responses(6150) } } }),
      ...bytesRows("2026-11-05T09:00:00.000Z", { sha: A, journeys: { "open-task": { bytes: 31000, responses: responses(1000) }, "open-task-huge": { bytes: 36106 } } }),
      "2026-11-05T10:00:00.000Z\topen-task\t/api/x\tmany\t1\tc",
      "",
    ].join("\n");
    const rows = parseBytesRows(tsv);
    expect(rows).toHaveLength(7);
    expect(bytesHistoryTable(rows)).toEqual([
      "| 測った日時 | open-task B | open-task-huge B | open-task 初めから | open-task-huge 初めから | main |",
      "|---|---|---|---|---|---|",
      "| 2026-11-05T09:00:00.000Z | 31000 | 36106 | +0 B (+0.00%) | +0 B (+0.00%) | aaaaaaa |",
      "| 2026-11-06T09:00:00.000Z | 31044 | 36150 | +44 B (+0.14%) | +44 B (+0.12%) | bbbbbbb |",
      "期間の増加: open-task +44 B (+0.14%) / open-task-huge +44 B (+0.12%)",
    ]);
    expect(bytesHistoryTable(rows, "2026-11-06")).toHaveLength(4);
    expect(bytesHistoryTable(rows, "2026-11-07")).toEqual(["bytes: 記録なし"]);
    expect(bytesHistoryTable([])).toEqual(["bytes: 記録なし"]);
  });
});
