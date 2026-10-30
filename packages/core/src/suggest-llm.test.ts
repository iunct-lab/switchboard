import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { describe, expect, test } from "bun:test";
import type { AgentEvent, RoutingLogRow, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { createClaudeParser } from "@switchboard/adapter-claude";
import type { RoutingContext } from "./routing.ts";
import { buildPrompt, LlmSuggester, parseSuggestion, runSuggestionTurn } from "./suggest-llm.ts";

// Recorded 2026-09-13 with Claude Code 2.1.269, `--model claude-haiku-4-5 --permission-mode plan`, fed the prompt
// buildPrompt() produces for the context below. Washed: the `control_response` init line is dropped and `system/init`
// keeps only the five fields the parser reads — the originals listed this machine's MCP connectors, plugins, skills,
// agents and socket paths, none of which the replay uses. Thinking blocks keep their structure, not their content.
const fixture = recordingText("packages/core/fixtures/suggest-claude.jsonl");

const EXAMPLES: RoutingLogRow[] = [
  { taskId: "task_1", title: "PR のレビューコメントに返信する", suggested: "codex", ruleId: "single-repo-long", reason: "単一リポジトリで完結・長時間", chosen: "codex", suggestedBy: "rule", status: "done", outcome: "done", costUsd: 0.42, durationMs: 900_000, ts: 1 },
  { taskId: "task_2", title: "Switchboard の Ledger 画面にカードを足す", suggested: "claude", ruleId: "self-dev", reason: "自分自身の改善", chosen: "claude", suggestedBy: "rule", status: "waiting", outcome: "needs_action", costUsd: 1.8, durationMs: 2_400_000, ts: 2 },
];

const CTX: RoutingContext = {
  title: "Codex のレビュー指摘に返信する",
  prompt: "PR #123 のレビュー指摘 8 件を読み、採否を判断して返信する。",
  scope: ["/tmp/one-repo"],
  kind: "review",
  workspaceKind: "repo",
  available: new Set<RunnerId>(["claude", "codex", "dak"]),
};

/** An adapter that replays recorded events instead of spawning a runner. */
function replayAdapter(events: AgentEvent[], opts: { starts?: StartOptions[]; closes?: number[]; never?: boolean } = {}): RunnerAdapter {
  return {
    id: "claude",
    permissionModes: [{ value: "plan", label: "plan", description: "plan" }],
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      opts.starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      if (!opts.never) queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      const session: RunnerSession = {
        send: () => undefined,
        respondPermission: () => undefined,
        abort: async () => resolveExit(0),
        close: async (o) => {
          opts.closes?.push(o?.graceMs ?? -1);
          resolveExit(0);
        },
        exited,
      };
      return session;
    },
  };
}

const recorded = (): AgentEvent[] => {
  const p = createClaudeParser();
  return fixture.split("\n").flatMap((l) => p.feed(l));
};

describe("LlmSuggester (recorded Claude replay)", () => {
  test.skipIf(skipRecordings("packages/core/fixtures/suggest-claude.jsonl"))("the recorded answer becomes a {runner, reason} suggestion, read-only and in the daemon's own directory", async () => {
    assertRecordings("packages/core/fixtures/suggest-claude.jsonl");
    const starts: StartOptions[] = [];
    const closes: number[] = [];
    const usage: Array<Extract<AgentEvent, { t: "usage" }>> = [];
    const s = new LlmSuggester({ adapter: replayAdapter(recorded(), { starts, closes }), cwd: "/tmp/switchboard-home", model: "claude-haiku-4-5", permissionMode: "plan", examples: () => EXAMPLES, onUsage: (u) => usage.push(u) });
    const out = await s.suggest(CTX, new AbortController().signal);
    // the model wrapped its JSON in a ```json fence; the answer is still read out of it
    expect(out).toMatchObject({ runner: "codex", ruleId: "llm", available: true, alternatives: [], llm: null });
    expect(out.reason).toContain("Codex");
    // the turn runs read-only, in the daemon's directory (never a repository), with the configured model
    expect(starts[0]).toMatchObject({ cwd: "/tmp/switchboard-home", scope: ["/tmp/switchboard-home"], model: "claude-haiku-4-5", permissionMode: "plan" });
    expect(starts[0]!.prompt).toContain("候補のランナー: claude, codex, dak");
    // the session is always released, and what the turn cost is reported so the caller can bill it
    expect(closes).toEqual([0]);
    // the recording carries a per-call `turn` counter as well as the runner's final `reported` figures, one per model
    // of `modelUsage` (#2353); only the reported ones may be billed (they carry a model and a cost — TaskManager makes the
    // same choice), and together they are the turn's `total_cost_usd`
    expect(recorded().filter((e) => e.t === "usage")).toHaveLength(3);
    expect(usage.map((u) => [u.source, u.model])).toEqual([["reported", "claude-haiku-4-5-20251001"], ["reported", "claude-haiku-4-5"]]);
    expect(usage.reduce((a, u) => a + (u.costUsd ?? 0), 0)).toBeCloseTo(0.0212325, 6);
  });

  test("an answer without JSON, or one naming a runner that is not a candidate, throws (the rule table then stands)", async () => {
    const text = (t: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, { t: "session.end", status: "ok" }];
    const run = (events: AgentEvent[], available: RunnerId[] = ["claude", "codex", "dak"]) =>
      new LlmSuggester({ adapter: replayAdapter(events), cwd: "/tmp/h", examples: () => [] }).suggest({ ...CTX, available: new Set(available) }, new AbortController().signal);
    await expect(run(text("わかりません"))).rejects.toThrow(/no JSON object/);
    await expect(run(text('{"runner": "codex"'))).rejects.toThrow(/no JSON object/); // unterminated: not a candidate span
    await expect(run(text('{"runner": "gpt-9", "reason": "x"}'))).rejects.toThrow(/none of which is one of/);
    // a real runner that this daemon does not have is refused too: suggesting it would be useless
    await expect(run(text('{"runner": "dak", "reason": "x"}'), ["claude", "codex"])).rejects.toThrow(/none of which is one of claude, codex/);
    await expect(run([{ t: "session.end", status: "ok" }])).rejects.toThrow(/answered nothing/);
    await expect(run([{ t: "error", message: "usage limit reached" }])).rejects.toThrow(/usage limit reached/);
    // a model that echoes the prompt's format line (which contains a placeholder runner) still gets read
    expect(await run(text('形式: {"runner": "<候補のいずれか>", "reason": "…"}\n答え: {"runner": "codex", "reason": "こちら"}'))).toMatchObject({ runner: "codex" });
    // …and an answer nested inside a wrapper object is found, not just the outermost one
    expect(await run(text('{"thinking": "まよった", "answer": {"runner": "dak", "reason": "ローカル"}}'))).toMatchObject({ runner: "dak", reason: "ローカル" });
    // an answer that already arrived is not voided by a later ask or error (plan mode makes Claude reach for ExitPlanMode)
    expect(await run([{ t: "message.delta", role: "assistant", text: '{"runner": "codex", "reason": "済んだ"}' }, { t: "permission.ask", id: "p1", kind: "other", tool: "ExitPlanMode", detail: "計画を承認" }])).toMatchObject({ runner: "codex" });
  });

  test("runSuggestionTurn starts the runner with persistSession false (#2908)", async () => {
    const starts: StartOptions[] = [];
    const events: AgentEvent[] = [{ t: "message.delta", role: "assistant", text: "答え" }, { t: "session.end", status: "ok" }];
    expect(await runSuggestionTurn({ adapter: replayAdapter(events, { starts }), cwd: "/tmp/h" }, "p", new AbortController().signal)).toBe("答え");
    expect(starts[0]!.persistSession).toBe(false);
  });

  test("a runner that never answers is given up on when the caller aborts", async () => {
    const ac = new AbortController();
    const s = new LlmSuggester({ adapter: replayAdapter([], { never: true }), cwd: "/tmp/h", examples: () => [] });
    const p = s.suggest(CTX, ac.signal);
    ac.abort(new Error("no answer in 5000ms"));
    await expect(p).rejects.toThrow(/no answer in 5000ms/);
  });

  test("parseSuggestion reads the first object, fenced or after prose", () => {
    expect(parseSuggestion('```json\n{"runner": "dak", "reason": "ローカルで足りる"}\n```', ["dak"])).toEqual({ runner: "dak", reason: "ローカルで足りる" });
    expect(parseSuggestion('考えました。{"runner": "claude", "reason": "対話が要る"} 以上です', ["claude"])).toEqual({ runner: "claude", reason: "対話が要る" });
    expect(parseSuggestion('{"runner": "claude", "reason": "  "}', ["claude"]).reason).toBe("（理由なし）");
    // a leading object that is not a suggestion must not stop the search
    expect(parseSuggestion('{"note": "{not it}"}\n{"runner": "codex", "reason": "ok"}', ["codex"])).toEqual({ runner: "codex", reason: "ok" });
  });

  test("the prompt carries the task, the candidates and the past decisions with their outcome", () => {
    const p = buildPrompt(CTX, EXAMPLES);
    expect(p).toContain("JSON だけを返してください");
    expect(p).toContain("title: Codex のレビュー指摘に返信する");
    expect(p).toContain("| 提案元 | 提案 | 実際 | 状態 | 結果 | USD | 所要 | title |");
    expect(p).toContain("| rule | codex | codex | done | done | 0.4200 | 900s | PR のレビューコメントに返信する |");
    // the status says only that the runner stopped; the outcome says whether it needs the person (#612)
    expect(p).toContain("| rule | claude | claude | waiting | needs_action | 1.8000 | 2400s |");
    expect(buildPrompt(CTX, [])).toContain("（まだ記録がありません）");
    // an untrusted title cannot run over the table or break its columns
    const long = buildPrompt(CTX, [{ ...EXAMPLES[0]!, title: `${"あ".repeat(400)}|x|y` }]);
    const row = long.split("\n").find((l) => l.startsWith("| rule |"))!;
    expect(row.split("|")).toHaveLength(10); // still one table row: the title's own pipes are replaced
    expect(long).not.toContain("あ".repeat(121)); // and it is capped at 120 characters
  });
});
