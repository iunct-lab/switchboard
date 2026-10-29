import { describe, expect, test } from "bun:test";
import type { EvalsListRow, JudgeEval, RuleEval, TaskEvals } from "@switchboard/protocol";
import type { EvalsSortKey } from "./evals.ts";
import { endLabel, evalCells, evalFilterOptions, evalRowWarn, filterEvalRows, firstSortDir, fmtDuration, gapLabel, humanLabel, judgeAverage, judgeRows, metricRows, modelsLabel, sortEvalRows } from "./evals.ts";

const rules = (over: Partial<RuleEval["metrics"]> = {}): RuleEval => ({
  metrics: { turns: 2, toolCalls: 7, toolFailures: 0, errors: 0, asks: 1, denials: 0, stops: 0, stopReasons: {}, userInstructions: 1, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false, durationMs: 184_000, ...over },
  status: "done", outcome: "unknown", costUsd: 0.0123, by: "rules@2", ts: 1,
});
const evals = (r: RuleEval | null, judge: JudgeEval | null = null): TaskEvals => ({ rules: r, judge, human: null, models: [] });

describe("evals rows (#1218)", () => {
  test("metricRows: the fixed order; a failure, error, denial or stop marks its row", () => {
    const rows = metricRows(evals(rules()));
    expect(rows.map((r) => r.label)).toEqual(["ツール呼び出し", "失敗", "エラー", "追加指示", "承認 / 拒否", "停止", "デーモン停止", "ターン", "所要時間", "終わり方"]);
    expect(rows.map((r) => r.value)).toEqual(["7", "0", "0", "1", "1 / 0", "0", "0", "2", "3 分 4 秒", "正常"]);
    expect(rows.some((r) => r.warn)).toBe(false);
    const bad = metricRows(evals(rules({ toolFailures: 2, errors: 1, denials: 1, stops: 3, stopReasons: { "usage-limit": 2, transient: 1 }, lastEnd: "error" })));
    expect(bad.filter((r) => r.warn).map((r) => r.label)).toEqual(["失敗", "エラー", "承認 / 拒否", "停止", "終わり方"]);
    expect(bad.find((r) => r.label === "停止")?.value).toBe("3（usage-limit 2, transient 1）");
  });

  test("metricRows: a turn cut by the daemon marks デーモン停止, not 終わり方 (#2089)", () => {
    const warns = (over: Partial<RuleEval["metrics"]>) => metricRows(evals(rules(over))).filter((r) => r.warn).map((r) => r.label);
    expect(warns({ lastEnd: "aborted", daemonStops: 1, lastCutByDaemon: true })).toEqual(["デーモン停止"]);
    expect(warns({ lastEnd: "error", daemonStops: 1, lastCutByDaemon: true })).toEqual(["デーモン停止"]);
    // an earlier stop, then a turn that failed by itself: both are marked
    expect(warns({ lastEnd: "aborted", daemonStops: 1, lastCutByDaemon: false })).toEqual(["デーモン停止", "終わり方"]);
    expect(metricRows(evals(rules({ daemonStops: 2 }))).find((r) => r.label === "デーモン停止")?.value).toBe("2");
  });

  test("metricRows: nothing without a rules row", () => {
    expect(metricRows(evals(null))).toEqual([]);
  });

  test("fmtDuration: -, seconds, minutes and seconds, hours and minutes", () => {
    expect(fmtDuration(null)).toBe("-");
    expect(fmtDuration(12_400)).toBe("12 秒");
    expect(fmtDuration(184_000)).toBe("3 分 4 秒");
    expect(fmtDuration(3_720_000)).toBe("1 時間 2 分");
  });

  test("endLabel", () => {
    expect(["ok", "error", "aborted", null].map((e) => endLabel(e as "ok" | "error" | "aborted" | null))).toEqual(["正常", "エラー", "中断", "-"]);
  });
});

describe("judge rows (#1219)", () => {
  const judge = (scores: JudgeEval["scores"]): JudgeEval => ({ scores, summary: "総評", rubric: "switchboard-default@1", by: "codex:gpt-6-luna", ts: 1 });
  test("judgeRows: the rubric's order for known ids, unknown ids after with their id as title, 2 or below marked; nothing without a judge row", () => {
    const rows = judgeRows(evals(null, judge({ safety: { score: 5, reason: "ok" }, goal: { score: 2, reason: "半分" }, custom: { score: 3, reason: "x" }, efficiency: { score: 1, reason: "繰り返し" } })));
    expect(rows.map((r) => [r.id, r.title, r.score, r.warn])).toEqual([
      ["goal", "依頼の達成", 2, true],
      ["efficiency", "効率", 1, true],
      ["safety", "安全", 5, false],
      ["custom", "custom", 3, false],
    ]);
    expect(rows[0]!.reason).toBe("半分");
    expect(judgeRows(evals(null))).toEqual([]);
  });

  test("judgeAverage: one decimal; null without scores", () => {
    expect(judgeAverage(evals(null, judge({ goal: { score: 4, reason: "" }, safety: { score: 5, reason: "" }, efficiency: { score: 2, reason: "" } })))).toBe(3.7);
    expect(judgeAverage(evals(null, judge({})))).toBeNull();
    expect(judgeAverage(evals(null))).toBeNull();
  });
});

describe("human label (#1220)", () => {
  test("humanLabel: null without a rating; the rating alone; the rating with the note", () => {
    expect(humanLabel(evals(null))).toBeNull();
    expect(humanLabel({ rules: null, judge: null, human: { rating: 3, comment: "", by: "user", ts: 1 }, models: [] })).toBe("3 / 5");
    expect(humanLabel({ rules: null, judge: null, human: { rating: 5, comment: "早くて正確", by: "user", ts: 1 }, models: [] })).toBe("5 / 5 · 早くて正確");
  });
});

describe("evals list rows (#1221)", () => {
  const row = (taskId: string, over: Partial<EvalsListRow> = {}): EvalsListRow => ({
    taskId, title: taskId, runner: "claude", workspaceId: null, status: "done", outcome: "done", updatedAt: 1, costUsd: 0, models: [], effort: null,
    rules: { toolCalls: 3, toolFailures: 0, errors: 0, userInstructions: 0, stops: 0, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false }, judge: null, human: null, ...over,
  });
  const rows = [row("a", { updatedAt: 3, judge: { average: 4.2, scores: {}, rubric: "r@1", by: "x" } }), row("b", { updatedAt: 2, rules: null }), row("c", { updatedAt: 1, judge: { average: 2.0, scores: {}, rubric: "r@1", by: "x" }, rules: { toolCalls: 1, toolFailures: 2, errors: 0, userInstructions: 1, stops: 0, lastEnd: "error", daemonStops: 0, lastCutByDaemon: false } })];

  test("sortEvalRows: by a key both ways, rows without the value last either way, equal values keep their order", () => {
    expect(sortEvalRows(rows, "judge", "asc").map((r) => r.taskId)).toEqual(["c", "a", "b"]);
    expect(sortEvalRows(rows, "judge", "desc").map((r) => r.taskId)).toEqual(["a", "c", "b"]);
    expect(sortEvalRows(rows, "toolFailures", "desc").map((r) => r.taskId)).toEqual(["c", "a", "b"]);
    expect(sortEvalRows(rows, "updatedAt", "desc").map((r) => r.taskId)).toEqual(["a", "b", "c"]);
    expect(sortEvalRows(rows, "human", "asc").map((r) => r.taskId)).toEqual(["a", "b", "c"]); // nobody rated: the order stays
  });

  test("evalRowWarn: daemon stops alone do not mark the row (#2089); they sort like the other counts", () => {
    const d = row("d", { rules: { toolCalls: 1, toolFailures: 0, errors: 0, userInstructions: 0, stops: 0, lastEnd: "aborted", daemonStops: 3, lastCutByDaemon: true } });
    expect(evalRowWarn(d)).toBe(false);
    expect(firstSortDir("daemonStops")).toBe("desc");
    expect(sortEvalRows([...rows, d], "daemonStops", "desc").map((r) => r.taskId)).toEqual(["d", "a", "c", "b"]);
  });

  test("firstSortDir: a score column starts with the weak tasks, a count or the date with the heavy / newest", () => {
    expect(["judge", "human"].map((k) => firstSortDir(k as EvalsSortKey))).toEqual(["asc", "asc"]);
    expect(["toolFailures", "costUsd", "updatedAt"].map((k) => firstSortDir(k as EvalsSortKey))).toEqual(["desc", "desc", "desc"]);
  });

  test("evalCells and evalRowWarn", () => {
    expect(evalCells(rows[0]!)).toEqual({ judge: "4.2", human: "-", end: "正常", model: "-", mixed: false, effort: "CLI 既定" });
    expect(evalCells(rows[1]!)).toEqual({ judge: "-", human: "-", end: "-", model: "-", mixed: false, effort: "CLI 既定" });
    expect(evalCells(row("h", { human: { rating: 2, comment: "" } })).human).toBe("2 / 5");
    expect(rows.map(evalRowWarn)).toEqual([false, false, true]);
    expect(evalRowWarn(row("h", { human: { rating: 2, comment: "" } }))).toBe(true);
    expect(evalRowWarn(row("j", { judge: { average: 2.5, scores: {}, rubric: "r@1", by: "x" } }))).toBe(true);
  });

  test("evalCells: every model in the order first used (混在 with two or more) and the effort by the runner's label (#1801)", () => {
    const runner = { efforts: [{ value: "high", label: "高" }] };
    expect(evalCells(row("one", { models: ["claude-opus-5-5"], effort: "high" }), runner)).toMatchObject({ model: "claude-opus-5-5", mixed: false, effort: "高" });
    // opus → sonnet → opus reads ["opus", "sonnet"] (distinct): the cell names both rather than claim sonnet ran last
    expect(evalCells(row("two", { models: ["claude-opus-5-5", "claude-sonnet-5-5"], effort: "xhigh" }), runner)).toMatchObject({ model: "claude-opus-5-5 → claude-sonnet-5-5", mixed: true, effort: "xhigh" });
    expect(evalCells(row("none", { models: [], effort: null }))).toMatchObject({ model: "-", mixed: false, effort: "CLI 既定" });
  });

  test("modelsLabel: null when not known, the one, or every one with （混在） (#1801)", () => {
    expect(modelsLabel({ models: [] })).toBeNull();
    expect(modelsLabel({ models: ["claude-opus-5-5"] })).toBe("claude-opus-5-5");
    expect(modelsLabel({ models: ["claude-opus-5-5", "claude-sonnet-5-5"] })).toBe("claude-opus-5-5 → claude-sonnet-5-5（混在）");
  });

  test("filterEvalRows and evalFilterOptions: by a model used, by the effort (- = the CLI default), both (#1801)", () => {
    const list = [
      row("a", { models: ["claude-opus-5-5", "claude-sonnet-5-5"], effort: "high" }),
      row("b", { models: ["claude-sonnet-5-5"], effort: null }),
      row("c", { models: [], effort: "low" }),
    ];
    const ids = (rs: EvalsListRow[]) => rs.map((r) => r.taskId);
    expect(ids(filterEvalRows(list, { model: "", effort: "" }))).toEqual(["a", "b", "c"]);
    expect(ids(filterEvalRows(list, { model: "claude-sonnet-5-5", effort: "" }))).toEqual(["a", "b"]);
    expect(ids(filterEvalRows(list, { model: "claude-opus-5-5", effort: "" }))).toEqual(["a"]);
    expect(ids(filterEvalRows(list, { model: "", effort: "-" }))).toEqual(["b"]);
    expect(ids(filterEvalRows(list, { model: "", effort: "low" }))).toEqual(["c"]);
    expect(ids(filterEvalRows(list, { model: "claude-sonnet-5-5", effort: "high" }))).toEqual(["a"]);
    expect(ids(filterEvalRows(list, { model: "claude-opus-5-5", effort: "-" }))).toEqual([]);
    expect(evalFilterOptions(list)).toEqual({ models: ["claude-opus-5-5", "claude-sonnet-5-5"], efforts: ["-", "high", "low"] });
    expect(evalFilterOptions([])).toEqual({ models: [], efforts: [] });
  });
});

describe("gapLabel (#1877)", () => {
  test("none rated → the line says so; otherwise the signed mean to one decimal and the count", () => {
    expect(gapLabel({ count: 0, mean: null })).toBe("人の評価がまだありません");
    expect(gapLabel({ count: 12, mean: 0.4 })).toBe("人 − 判定: +0.4（12 件）");
    expect(gapLabel({ count: 2, mean: -2.1 })).toBe("人 − 判定: −2.1（2 件）");
    expect(gapLabel({ count: 1, mean: 0 })).toBe("人 − 判定: 0.0（1 件）");
    expect(gapLabel({ count: 3, mean: 1 })).toBe("人 − 判定: +1.0（3 件）");
  });
});
