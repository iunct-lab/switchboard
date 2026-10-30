import { describe, expect, test } from "bun:test";
import type { AgentEvent, JudgeSettings, RuleMetrics, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { JUDGE_FALLBACK } from "./judge.ts";
import { transcriptLines } from "./recap.ts";
import { DEFAULT_RUBRIC } from "./rubric.ts";
import { buildRubricPrompt, judgeRubric, parseRubricJudgement, RECAP_CHARS, type RubricJudgeInput } from "./rubric-judge.ts";

const METRICS: RuleMetrics = { turns: 1, toolCalls: 3, toolFailures: 1, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false, durationMs: 5000, classifier: null };
const EVENTS: AgentEvent[] = [
  { t: "message.delta", role: "user", text: "README の誤字を直して" },
  { t: "tool.call", id: "a", name: "Edit", input: {}, summary: "README.md" },
  { t: "tool.result", id: "a", ok: true, summary: "ok" },
  { t: "message.delta", role: "assistant", text: "直しました。" },
  { t: "session.end", status: "ok", summary: "直しました。" },
];
const INPUT: RubricJudgeInput = { title: "README の誤字", prompt: "README の誤字を直して", events: EVENTS, metrics: METRICS, rubric: DEFAULT_RUBRIC };
const SETTINGS: JudgeSettings = { enabled: true, runner: "codex", model: "gpt-6-luna" };

/** Replays `events` for every turn of `id`; the same shape as judge.test.ts's. */
function replayAdapter(id: RunnerId, events: AgentEvent[], opts: { starts?: StartOptions[] } = {}): RunnerAdapter {
  return {
    id,
    permissionModes: [{ value: id === "claude" ? "plan" : "read-only", label: "ro", description: "ro" }],
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      opts.starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}
const usageOf = (model: string): AgentEvent => ({ t: "usage", source: "reported", model, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
const answer = (t: string, model: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, usageOf(model), { t: "session.end", status: "ok" }];
const GOOD = '{"scores": {"goal": {"score": 5, "reason": "直して報告"}, "instructions": {"score": 4, "reason": "沿っている"}, "efficiency": {"score": 5, "reason": "無駄なし"}, "communication": {"score": 4, "reason": "短いが分かる"}, "safety": {"score": 5, "reason": "範囲内"}}, "summary": "小さな修正を確実に終えた"}';

describe("rubric judge (#1219)", () => {
  test("the configured runner scores: every criterion, by runner:model, the rubric's id@version; asked read-only in the daemon's directory with the criteria and the transcript", async () => {
    const starts: StartOptions[] = [];
    const usage: Array<{ runner: RunnerId; model: string | undefined }> = [];
    const j = await judgeRubric(INPUT, { adapters: new Map([["codex", replayAdapter("codex", answer(GOOD, "gpt-6-luna"), { starts })], ["claude", replayAdapter("claude", [])]]), settings: SETTINGS, cwd: "/tmp/switchboard-home/suggest", onUsage: (runner, ev) => usage.push({ runner, model: ev.model }) });
    expect(Object.keys(j.scores).sort()).toEqual(["communication", "efficiency", "goal", "instructions", "safety"]);
    expect(j.scores.goal).toEqual({ score: 5, reason: "直して報告" });
    expect(j).toMatchObject({ summary: "小さな修正を確実に終えた", by: "codex:gpt-6-luna", rubric: "switchboard-default@1" });
    expect(j.ts).toBeGreaterThan(0);
    expect(starts[0]).toMatchObject({ cwd: "/tmp/switchboard-home/suggest", model: "gpt-6-luna", permissionMode: "read-only" });
    const prompt = starts[0]!.prompt;
    for (const id of ["goal", "instructions", "efficiency", "communication", "safety"]) expect(prompt).toContain(`- ${id}（`);
    expect(prompt).toContain("## 会話");
    expect(prompt).toContain("利用者: README の誤字を直して");
    expect(prompt).toContain("ツール呼び出し 3 / 失敗 1");
    expect(usage).toEqual([{ runner: "codex", model: "gpt-6-luna" }]);
  });

  test("parse: a preamble and a code fence are fine; an unknown id and a score outside 1–5 are dropped; no scores → throws", () => {
    const r = parseRubricJudgement('採点します。\n```json\n{"scores": {"goal": {"score": 3, "reason": "一部"}, "bogus": {"score": 5, "reason": "x"}, "safety": {"score": 7, "reason": "x"}, "efficiency": {"score": 2.5, "reason": "x"}}, "summary": "途中"}\n```', DEFAULT_RUBRIC);
    expect(r).toEqual({ scores: { goal: { score: 3, reason: "一部" } }, summary: "途中" });
    expect(parseRubricJudgement('{"scores": {"goal": {"score": 4}}}', DEFAULT_RUBRIC).scores.goal).toEqual({ score: 4, reason: "（理由なし）" });
    expect(() => parseRubricJudgement('{"result": "done"}', DEFAULT_RUBRIC)).toThrow(/no scores/);
    expect(() => parseRubricJudgement('{"scores": {"bogus": {"score": 5}}}', DEFAULT_RUBRIC)).toThrow(/no scores/);
  });

  test("the configured runner fails: Claude Haiku scores instead, and both turns' usage is reported", async () => {
    const claudeStarts: StartOptions[] = [];
    const usage: Array<{ runner: RunnerId; model: string | undefined }> = [];
    const logs: string[] = [];
    const codex = replayAdapter("codex", [{ t: "error", message: "You've hit your usage limit." }, usageOf("gpt-6-luna"), { t: "session.end", status: "error" }]);
    const claude = replayAdapter("claude", answer(GOOD, "claude-haiku-4-5-20251001"), { starts: claudeStarts });
    const j = await judgeRubric(INPUT, { adapters: new Map([["codex", codex], ["claude", claude]]), settings: SETTINGS, cwd: "/tmp/x", onUsage: (runner, ev) => usage.push({ runner, model: ev.model }), log: (m) => logs.push(m) });
    expect(j.by).toBe(`claude:${JUDGE_FALLBACK.model}`);
    expect(claudeStarts[0]).toMatchObject({ model: JUDGE_FALLBACK.model, permissionMode: "plan" });
    expect(usage).toEqual([
      { runner: "codex", model: "gpt-6-luna" },
      { runner: "claude", model: "claude-haiku-4-5-20251001" },
    ]);
    expect(logs.join("\n")).toMatch(/codex.*usage limit/);
  });

  test("settings tunables (#835): the fallback the daemon passes scores instead of Claude Haiku", async () => {
    const codexStarts: StartOptions[] = [];
    const claude = replayAdapter("claude", [{ t: "error", message: "rate_limit_error" }, { t: "session.end", status: "error" }]);
    const codex = replayAdapter("codex", answer(GOOD, "m"), { starts: codexStarts });
    const j = await judgeRubric(INPUT, { adapters: new Map([["codex", codex], ["claude", claude]]), settings: { enabled: true, runner: "claude", model: "claude-sonnet" }, cwd: "/tmp/x", fallback: { runner: "codex", model: "m" } });
    expect(j.by).toBe("codex:m");
    expect(codexStarts.map((s) => s.model)).toEqual(["m"]);
  });

  test("transcriptLines keeps the newest part past maxChars, marked; the prompt uses RECAP_CHARS", () => {
    const long: AgentEvent[] = Array.from({ length: 200 }, (_, i) => ({ t: "message.delta", role: "assistant", text: `line ${i} ${"x".repeat(100)}\n` }));
    const cut = transcriptLines(long, 500);
    expect(cut.startsWith("…（前半は省略）\n")).toBe(true);
    expect(cut).toContain("line 199");
    expect(cut).not.toContain("line 0 ");
    expect(buildRubricPrompt({ ...INPUT, events: long }).length).toBeLessThan(RECAP_CHARS + 3000);
  });
});
