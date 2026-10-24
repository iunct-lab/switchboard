import { describe, expect, test } from "bun:test";
import type { AgentEvent, JudgeSettings, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { buildJudgePrompt, JUDGE_FALLBACK, judgeTurn, parseJudgement, type JudgeInput } from "./judge.ts";

const INPUT: JudgeInput = { title: "README の誤字を直す", prompt: "README のインストール手順の誤字を直してください。", lastReply: "直しました。コミットは abc123 です。" };
const SETTINGS: JudgeSettings = { enabled: true, runner: "codex", model: "gpt-6-luna" };

/** Replays `events` for every turn of `id`; same shape as the replay adapter in suggest-workspace.test.ts. */
function replayAdapter(id: RunnerId, events: AgentEvent[], opts: { starts?: StartOptions[]; modes?: string[] } = {}): RunnerAdapter {
  return {
    id,
    permissionModes: (opts.modes ?? [id === "claude" ? "plan" : "read-only"]).map((value) => ({ value, label: value, description: value })),
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
const limited = (runner: RunnerId): AgentEvent[] => [{ t: "error", message: runner === "codex" ? "You've hit your usage limit. Try again later." : "rate_limit_error" }, { t: "session.end", status: "error" }];

function run(adapters: RunnerAdapter[], settings: JudgeSettings = SETTINGS) {
  const usage: Array<{ runner: RunnerId; model: string | undefined }> = [];
  const logs: string[] = [];
  const out = judgeTurn(INPUT, { adapters: new Map(adapters.map((a) => [a.id, a])), settings, cwd: "/tmp/switchboard-home/suggest", onUsage: (runner, ev) => usage.push({ runner, model: ev.model }), log: (m) => logs.push(m) });
  return { out, usage, logs };
}

describe("judgeTurn", () => {
  test("the configured runner answers: its judgement, asked read-only with the configured model in the daemon's directory", async () => {
    const starts: StartOptions[] = [];
    const claudeStarts: StartOptions[] = [];
    const { out, usage } = run([replayAdapter("codex", answer('{"result": "done", "reason": "誤字を直して報告している"}', "gpt-6-luna"), { starts }), replayAdapter("claude", [], { starts: claudeStarts })]);
    expect(await out).toEqual({ result: "done", reason: "誤字を直して報告している", runner: "codex", model: "gpt-6-luna" });
    expect(starts[0]).toMatchObject({ cwd: "/tmp/switchboard-home/suggest", scope: ["/tmp/switchboard-home/suggest"], model: "gpt-6-luna", permissionMode: "read-only" });
    expect(claudeStarts).toHaveLength(0);
    expect(usage).toEqual([{ runner: "codex", model: "gpt-6-luna" }]);
  });

  test("the configured runner hits its limit: Claude Haiku judges once, and both turns' usage is reported", async () => {
    const claudeStarts: StartOptions[] = [];
    const codex = replayAdapter("codex", [limited("codex")[0]!, usageOf("gpt-6-luna"), { t: "session.end", status: "error" }]);
    const claude = replayAdapter("claude", answer('{"result": "needs_action", "reason": "どちらにするか聞いている"}', "claude-haiku-4-5-20251001"), { starts: claudeStarts });
    const { out, usage, logs } = run([codex, claude]);
    expect(await out).toEqual({ result: "needs_action", reason: "どちらにするか聞いている", runner: "claude", model: "claude-haiku-4-5" });
    expect(claudeStarts[0]).toMatchObject({ model: JUDGE_FALLBACK.model, permissionMode: "plan" });
    expect(usage).toEqual([
      { runner: "codex", model: "gpt-6-luna" },
      { runner: "claude", model: "claude-haiku-4-5-20251001" },
    ]);
    expect(logs.join("\n")).toMatch(/codex.*usage limit/);
  });

  test("the configured runner answers something that is not a judgement: Claude Haiku judges once", async () => {
    const codex = replayAdapter("codex", answer("完了です", "gpt-6-luna"));
    const claude = replayAdapter("claude", answer('{"result": "done", "reason": "報告している"}', "claude-haiku-4-5-20251001"));
    const { out, usage, logs } = run([codex, claude]);
    expect(await out).toMatchObject({ result: "done", runner: "claude", model: "claude-haiku-4-5" });
    expect(usage.map((u) => u.runner)).toEqual(["codex", "claude"]);
    expect(logs.join("\n")).toMatch(/no judgement/);
  });

  test("both fail: the last error is thrown", async () => {
    const { out } = run([replayAdapter("codex", limited("codex")), replayAdapter("claude", limited("claude"))]);
    await expect(out).rejects.toThrow(/rate_limit_error/);
  });

  test("the configured runner is not installed, or has no read-only mode: straight to the fallback", async () => {
    const haiku = () => replayAdapter("claude", answer('{"result": "done", "reason": "終わっている"}', "claude-haiku-4-5-20251001"));
    expect(await run([haiku()]).out).toMatchObject({ result: "done", runner: "claude", model: "claude-haiku-4-5" });
    const codexStarts: StartOptions[] = [];
    const writable = replayAdapter("codex", answer('{"result": "needs_action", "reason": "x"}', "gpt-6-luna"), { starts: codexStarts, modes: ["workspace-write"] });
    expect(await run([writable, haiku()]).out).toMatchObject({ runner: "claude" });
    expect(codexStarts).toHaveLength(0);
  });

  test("the daemon is stopping: the signal ends the turn and no fallback is tried", async () => {
    const claudeStarts: StartOptions[] = [];
    const stop = new AbortController();
    const hung: RunnerAdapter = { ...replayAdapter("codex", []), start: (_o, _emit) => (setTimeout(() => stop.abort(), 10), { send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: new Promise<number | null>(() => undefined) }) };
    const out = judgeTurn(INPUT, { adapters: new Map([["codex", hung], ["claude", replayAdapter("claude", answer('{"result": "done", "reason": "x"}', "h"), { starts: claudeStarts })]]), settings: SETTINGS, cwd: "/tmp/h", signal: stop.signal });
    await expect(out).rejects.toThrow();
    expect(claudeStarts).toHaveLength(0);
  });

  test("configured as the fallback itself: one turn, no second try", async () => {
    const starts: StartOptions[] = [];
    const { out } = run([replayAdapter("claude", limited("claude"), { starts })], { enabled: true, ...JUDGE_FALLBACK });
    await expect(out).rejects.toThrow(/rate_limit_error/);
    expect(starts).toHaveLength(1);
  });
});

describe("judgeTurn settings tunables (#835)", () => {
  const CLAUDE_JUDGE: JudgeSettings = { enabled: true, runner: "claude", model: "claude-sonnet" };
  test("the fallback from the settings: the configured runner fails, the given runner and model judge once", async () => {
    const codexStarts: StartOptions[] = [];
    const adapters = new Map<RunnerId, RunnerAdapter>([["claude", replayAdapter("claude", limited("claude"))], ["codex", replayAdapter("codex", answer('{"result": "done", "reason": "終わっている"}', "m"), { starts: codexStarts })]]);
    const out = await judgeTurn(INPUT, { adapters, settings: CLAUDE_JUDGE, cwd: "/tmp/h", fallback: { runner: "codex", model: "m" } });
    expect(out).toMatchObject({ result: "done", runner: "codex", model: "m" });
    expect(codexStarts.map((s) => s.model)).toEqual(["m"]);
  });

  test("the timeout from the settings: a runner that does not answer is given up after timeoutMs, then the fallback judges", async () => {
    const hung: RunnerAdapter = { ...replayAdapter("codex", []), start: () => ({ send: () => undefined, respondPermission: () => undefined, abort: async () => undefined, close: async () => undefined, exited: new Promise<number | null>(() => undefined) }) };
    const adapters = new Map<RunnerId, RunnerAdapter>([["codex", hung], ["claude", replayAdapter("claude", answer('{"result": "done", "reason": "x"}', "h"))]]);
    const t0 = Date.now();
    const out = await judgeTurn(INPUT, { adapters, settings: SETTINGS, cwd: "/tmp/h", timeoutMs: 50 });
    expect(out).toMatchObject({ runner: "claude", model: JUDGE_FALLBACK.model });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("parseJudgement", () => {
  test("reads the answer after prose, inside a fence, and past the echoed format line", () => {
    expect(parseJudgement('判定します。\n{"result": "done", "reason": "報告している"}')).toEqual({ result: "done", reason: "報告している" });
    expect(parseJudgement('```json\n{"result": "needs_action", "reason": "  確認を\\n求めている "}\n```')).toEqual({ result: "needs_action", reason: "確認を 求めている" });
    expect(parseJudgement('形式: {"result": "done|needs_action", "reason": "…"}\n{"result": "done", "reason": ""}')).toEqual({ result: "done", reason: "（理由なし）" });
  });

  test("a reason longer than asked is cut at 200 characters", () => {
    expect(parseJudgement(`{"result": "done", "reason": "${"ゑ".repeat(500)}"}`).reason).toHaveLength(200);
  });

  test("a result outside done / needs_action, or no JSON at all, throws", () => {
    expect(() => parseJudgement('{"result": "failed", "reason": "x"}')).toThrow(/no judgement/);
    expect(() => parseJudgement("完了だと思います")).toThrow(/no judgement/);
  });
});

describe("buildJudgePrompt", () => {
  test("caps the request at 1200 and the reply at 2000 characters", () => {
    const p = buildJudgePrompt({ title: "t", prompt: "ゑ".repeat(5000), lastReply: "ゐ".repeat(5000) });
    expect(p.match(/ゑ+/)![0].length).toBe(1200);
    expect(p.match(/ゐ+/)![0].length).toBe(2000);
    expect(p).toContain('{"result": "done|needs_action"');
  });
});
