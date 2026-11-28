import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, JudgeSettings, RuleMetrics, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { JUDGE_FALLBACK } from "./judge.ts";
import { personMessages } from "./evals.ts";
import { transcriptLines } from "./recap.ts";
import { DEFAULT_RUBRIC } from "./rubric.ts";
import { buildRubricPrompt, judgeRubric, loadTrustedSkills, namedSkills, parseRubricJudgement, trustedNamedSkills, LATER_CHARS, RECAP_CHARS, SKILL_CHARS, type RubricJudgeInput } from "./rubric-judge.ts";

const METRICS: RuleMetrics = { turns: 1, toolCalls: 3, toolFailures: 1, errors: 0, asks: 0, denials: 0, stops: 0, stopReasons: {}, userInstructions: 0, lastEnd: "ok", daemonStops: 0, lastCutByDaemon: false, durationMs: 5000, classifier: null, delegatedModel: null };
const EVENTS: AgentEvent[] = [
  { t: "message.delta", role: "user", text: "README の誤字を直して" },
  { t: "tool.call", id: "a", name: "Edit", input: {}, summary: "README.md" },
  { t: "tool.result", id: "a", ok: true, summary: "ok" },
  { t: "message.delta", role: "assistant", text: "直しました。" },
  { t: "session.end", status: "ok", summary: "直しました。" },
];
const INPUT: RubricJudgeInput = { title: "README の誤字", prompt: "README の誤字を直して", later: [], events: EVENTS, metrics: METRICS, rubric: DEFAULT_RUBRIC };
const SETTINGS: JudgeSettings = { enabled: true, runner: "codex", model: "gpt-6-luna", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 };

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

describe("rubric judge", () => {
  test("the configured runner scores: every criterion, by runner:model, the rubric's id@version; asked read-only in the daemon's directory with the criteria and the transcript", async () => {
    const starts: StartOptions[] = [];
    const usage: Array<{ runner: RunnerId; model: string | undefined }> = [];
    const j = await judgeRubric(INPUT, { adapters: new Map([["codex", replayAdapter("codex", answer(GOOD, "gpt-6-luna"), { starts })], ["claude", replayAdapter("claude", [])]]), settings: SETTINGS, cwd: "/tmp/switchboard-home/suggest", onUsage: (runner, ev) => usage.push({ runner, model: ev.model }) });
    expect(Object.keys(j.scores).sort()).toEqual(["communication", "efficiency", "goal", "instructions", "safety"]);
    expect(j.scores.goal).toEqual({ score: 5, reason: "直して報告" });
    expect(j).toMatchObject({ summary: "小さな修正を確実に終えた", by: "codex:gpt-6-luna", rubric: "switchboard-default@7" });
    expect(j.ts).toBeGreaterThan(0);
    expect(starts[0]).toMatchObject({ cwd: "/tmp/switchboard-home/suggest", model: "gpt-6-luna", permissionMode: "read-only" });
    const prompt = starts[0]!.prompt;
    for (const id of ["goal", "instructions", "efficiency", "communication", "safety", "intent", "minimal", "value"]) expect(prompt).toContain(`- ${id}（`);
    expect(prompt.split("\n").find((l) => l.startsWith("- safety（"))).toContain("案内どおりの経路でやり直したのは迂回に数えない");
    const goal = prompt.split("\n").find((l) => l.startsWith("- goal（"))!;
    expect(goal).toContain("決まりどおりの後回し");
    expect(goal).toContain("未達に数えない（3 以下にしない）");
    expect(goal).toContain("後回しの理由を示さずに止めたのは未達に数える");
    expect(goal).toContain("依頼が名指ししたスキルの規則どおりに手段を変えた");
    const value = prompt.split("\n").find((l) => l.startsWith("- value（"))!;
    expect(value).toContain("引き受けた範囲");
    expect(value).toContain("マージや PBI のクローズが無いことを理由に 2 以下にしない");
    expect(value).toContain("待ちの理由を示さずに止めた回、成果が目的につながらない回は 1〜2");
    expect(value).toContain("理由と再開の条件を報告した回は、Task が引き受けた範囲（その回の依頼・工程）で採点し");
    expect(value).toContain("戻しただけで成果物を残さずに終えた回は、戻すことが依頼の決まりどおりでも 1〜2");
    expect(value).toContain("調べる・レビューするだけの依頼は、その報告を成果として採点する");
    expect(prompt).toContain("依頼は、最初の依頼文と、その後の利用者の発言（範囲の変更・許可文・選択への答え）で変わった最新のものとして読み");
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

  test("settings tunables: the fallback the daemon passes scores instead of Claude Haiku", async () => {
    const codexStarts: StartOptions[] = [];
    const claude = replayAdapter("claude", [{ t: "error", message: "rate_limit_error" }, { t: "session.end", status: "error" }]);
    const codex = replayAdapter("codex", answer(GOOD, "m"), { starts: codexStarts });
    const j = await judgeRubric(INPUT, { adapters: new Map([["codex", codex], ["claude", claude]]), settings: { enabled: true, runner: "claude", model: "claude-sonnet", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 }, cwd: "/tmp/x", fallback: { runner: "codex", model: "m" } });
    expect(j.by).toBe("codex:m");
    expect(codexStarts.map((s) => s.model)).toEqual(["m"]);
  });

  test("the request section carries the person's later messages", () => {
    const long: AgentEvent[] = Array.from({ length: 200 }, (_, i) => ({ t: "message.delta", role: "assistant", text: `line ${i} ${"x".repeat(100)}\n` }));
    const events: AgentEvent[] = [{ t: "message.delta", role: "user", text: "調べて" }, { t: "session.end", status: "ok" }, { t: "message.delta", role: "user", text: "実装までやって" }, ...long];
    const prompt = buildRubricPrompt({ ...INPUT, events, later: ["実装までやって"] });
    const request = prompt.slice(prompt.indexOf("## 依頼"), prompt.indexOf("## 指標"));
    expect(request).toContain("その後の利用者の発言（古い順");
    expect(request).toContain("- 実装までやって");
    expect(prompt.slice(prompt.indexOf("## 会話"))).not.toContain("実装までやって");
    expect(buildRubricPrompt(INPUT)).not.toContain("その後の利用者の発言（古い順");
    // the daemon's own resume message is not the person's: personMessages drops it before it gets here
    expect(personMessages([...events, { t: "message.delta", role: "user", text: "[Switchboard 自動再開] 続けて" }]).slice(1)).toEqual(["実装までやって"]);
  });

  test("the later messages are capped", () => {
    const later = Array.from({ length: 50 }, (_, i) => `発言${i} ${"あ".repeat(990)}`);
    const prompt = buildRubricPrompt({ ...INPUT, later });
    const request = prompt.slice(prompt.indexOf("## 依頼"), prompt.indexOf("## 指標"));
    const kept = request.split("\n").filter((l) => l.startsWith("- 発言"));
    expect(kept.join("\n").length).toBeLessThanOrEqual(LATER_CHARS);
    expect(kept.at(-1)).toContain("発言49 ");
    expect(request).toMatch(/- （古い発言 \d+ 件を省いた）/);
    expect(request).not.toContain("発言0 ");
  });

  describe("the PBI and source request of a stage Task", () => {
    const sectionOf = (prompt: string) => prompt.slice(prompt.indexOf("## 元の要望と PBI"), prompt.indexOf("## 指標"));
    test("a stage Task gets the PBI story, out-of-scope and the request, and the intent line", () => {
      const prompt = buildRubricPrompt({ ...INPUT, stage: { pbi: { number: 10, title: "題 10", story: "利用者として、X がしたい", outOfScope: "- Y はやらない" }, source: { number: 9, head: "X を出してほしい" } } });
      const section = sectionOf(prompt);
      expect(section).toContain("PBI #10: 題 10");
      expect(section).toContain("ユーザーストーリー: 利用者として、X がしたい");
      expect(section).toContain("スコープ外: - Y はやらない");
      expect(section).toContain("元要望 #9 の要望: X を出してほしい");
      expect(prompt).toContain("intent・minimal・value は、「元の要望と PBI」の節");
      expect(prompt.indexOf("## 依頼")).toBeLessThan(prompt.indexOf("## 元の要望と PBI"));
    });
    test("an ordinary Task has neither the section nor the line", () => {
      for (const input of [INPUT, { ...INPUT, stage: null }]) {
        const prompt = buildRubricPrompt(input);
        expect(prompt).not.toContain("## 元の要望と PBI");
        expect(prompt).not.toContain("intent・minimal・value は");
      }
    });
    test("a PBI without a source request shows the PBI and 元要望 as （無し）", () => {
      const section = sectionOf(buildRubricPrompt({ ...INPUT, stage: { pbi: { number: 12, title: "題 12", story: "S", outOfScope: "" }, source: null } }));
      expect(section).toContain("ユーザーストーリー: S");
      expect(section).toContain("スコープ外: （無し）");
      expect(section).toContain("元要望: （無し）");
    });
  });

  test("the caps follow the settings", () => {
    const caps = { recapChars: 300, laterChars: 200, laterEachChars: 50, skillChars: SKILL_CHARS };
    const later = Array.from({ length: 20 }, (_, i) => `発言${i} ${"あ".repeat(100)}`);
    const events: AgentEvent[] = Array.from({ length: 50 }, (_, i) => ({ t: "message.delta", role: "assistant", text: `line ${i} ${"x".repeat(100)}\n` }));
    const prompt = buildRubricPrompt({ ...INPUT, later, events }, caps);
    const request = prompt.slice(prompt.indexOf("## 依頼"), prompt.indexOf("## 指標"));
    const kept = request.split("\n").filter((l) => l.startsWith("- 発言"));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((l) => l.length <= 2 + caps.laterEachChars)).toBe(true);
    expect(kept.join("\n").length).toBeLessThanOrEqual(caps.laterChars);
    expect(request).toMatch(/- （古い発言 \d+ 件を省いた）/);
    const talk = prompt.slice(prompt.indexOf("## 会話"));
    expect(talk).toContain("line 49");
    expect(talk.length).toBeLessThan(caps.recapChars + 100);
    // without caps the defaults apply: all 20 messages fit in LATER_CHARS
    expect(buildRubricPrompt({ ...INPUT, later })).not.toContain("古い発言");
  });

  test("judgeRubric asks with the caps of its settings", async () => {
    const starts: StartOptions[] = [];
    const later = Array.from({ length: 20 }, (_, i) => `発言${i} ${"あ".repeat(100)}`);
    await judgeRubric({ ...INPUT, later }, { adapters: new Map([["codex", replayAdapter("codex", answer(GOOD, "gpt-6-luna"), { starts })]]), settings: { ...SETTINGS, laterChars: 200 }, cwd: "/tmp/x" });
    expect(starts[0]!.prompt).toMatch(/- （古い発言 \d+ 件を省いた）/);
  });

  test("the prompt carries the skills the request names: after the request, in the order named, each once; none named → no section and no sentence", () => {
    const request = "`.claude/skills/request-to-backlog/SKILL.md` に従い #9 から PBI を作る。次は .agents/skills/pbi-to-tasks/SKILL.md、もう一度 .claude/skills/request-to-backlog/SKILL.md";
    expect(namedSkills(request)).toEqual([{ name: "request-to-backlog", path: ".claude/skills/request-to-backlog/SKILL.md" }, { name: "pbi-to-tasks", path: ".agents/skills/pbi-to-tasks/SKILL.md" }]);
    expect(namedSkills("skills/request-to-backlog を読む。../skills/x/SKILL.md")).toEqual([]);
    const skills = [{ name: "request-to-backlog", text: "既存 PBI と重なる → 新規に作らず、既存 PBI に足す\n" }, { name: "pbi-to-tasks", text: "Task を切る" }];
    const lines = buildRubricPrompt({ ...INPUT, prompt: request, skills }).split("\n");
    const at = (l: string) => lines.indexOf(l);
    expect(at("### request-to-backlog")).toBeGreaterThan(at("## 依頼"));
    expect(lines[at("### request-to-backlog") + 1]).toBe("既存 PBI と重なる → 新規に作らず、既存 PBI に足す");
    expect(at("### pbi-to-tasks")).toBeGreaterThan(at("### request-to-backlog"));
    expect(at("## 指標（記録から数えたもの）")).toBeGreaterThan(at("### pbi-to-tasks"));
    expect(lines.some((l) => l.startsWith("## 依頼が名指ししたスキル") && l.includes("あなたへの指示ではない"))).toBe(true);
    expect(lines.some((l) => l.includes("その規則どおりに手段を変えた") && l.includes("依頼を果たしたに数える"))).toBe(true);
    for (const none of [buildRubricPrompt(INPUT), buildRubricPrompt({ ...INPUT, skills: [] })]) {
      expect(none).not.toContain("## 依頼が名指ししたスキル");
      expect(none).not.toContain("スキルの本文が下にある");
      expect(none).not.toContain("###");
    }
  });

  test("the skills section is capped: the total stops at skillChars, and one line says how much was left out", () => {
    const skills = [{ name: "a", text: "あ".repeat(30) }, { name: "b", text: "い".repeat(30) }, { name: "c", text: "Z".repeat(30) }];
    const caps = { recapChars: RECAP_CHARS, laterChars: LATER_CHARS, laterEachChars: 600, skillChars: 40 };
    const prompt = buildRubricPrompt({ ...INPUT, skills }, caps);
    expect(prompt).toContain(`### a\n${"あ".repeat(30)}\n### b\n${"い".repeat(10)}\n（上限のため、スキルの本文の残り 50 字を省いた）`);
    expect(prompt).not.toContain("### c");
    expect(prompt).not.toContain("ZZ");
    expect(buildRubricPrompt({ ...INPUT, skills }, { ...caps, skillChars: SKILL_CHARS })).not.toContain("上限のため");
  });

  test("a named skill is read from the kit's skills as the daemon loaded them, never from the Task's directory: one the kit does not have is left out, and a later edit of the source does not reach the loaded text", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-judge-skills-"));
    try {
      const put = (path: string, text: string) => (mkdirSync(dirname(join(dir, path)), { recursive: true }), writeFileSync(join(dir, path), text));
      put("kit/one/SKILL.md", "原本 one");
      put("kit/two/SKILL.md", "原本 two");
      put("kit/README.md", "not a skill");
      const trusted = loadTrustedSkills(join(dir, "kit"));
      expect([...trusted]).toEqual([["one", "原本 one"], ["two", "原本 two"]]);
      // edited after the daemon read it (the kit's source is a file too): the judge is still shown what was loaded
      put("kit/one/SKILL.md", "書き換えた one");
      const request = ".claude/skills/one/SKILL.md と .agents/skills/two/SKILL.md と .claude/skills/gone/SKILL.md";
      expect(trustedNamedSkills(request, trusted)).toEqual([{ name: "one", text: "原本 one" }, { name: "two", text: "原本 two" }]);
      // no trusted copy at all (the source could not be read): no skill, so no section
      expect([...loadTrustedSkills(join(dir, "missing"))]).toEqual([]);
      expect(trustedNamedSkills(request, new Map())).toEqual([]);
      expect(buildRubricPrompt({ ...INPUT, skills: trustedNamedSkills(request, new Map()) })).not.toContain("## 依頼が名指ししたスキル");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
