import { describe, expect, test } from "bun:test";
import type { AgentEvent, JudgeSettings, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { buildConsentPrompt, consentCandidates, parseConsent, readConsent } from "./merge-consent.ts";

const SETTINGS: JudgeSettings = { enabled: true, runner: "codex", model: "gpt-6-luna", effort: "", recapChars: 12_000, laterChars: 4_000, laterEachChars: 600, pbiChars: 800, requestChars: 800, skillChars: 20_000 };
const INPUT = { said: "merge許可する", asked: "PR #5741 を判定の外でマージしてよいですか。" };

function replayAdapter(id: RunnerId, events: AgentEvent[], starts?: StartOptions[]): RunnerAdapter {
  return {
    id,
    permissionModes: [id === "claude" ? "plan" : "read-only"].map((value) => ({ value, label: value, description: value })),
    async detect() {
      return { available: true, version: "replay" };
    },
    start(startOpts, emit) {
      starts?.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => (events.forEach(emit), resolveExit(0)));
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(0), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}
const answer = (t: string): AgentEvent[] => [{ t: "message.delta", role: "assistant", text: t }, { t: "session.end", status: "ok" }];
const limited: AgentEvent[] = [{ t: "error", message: "rate_limit_error" }, { t: "session.end", status: "error" }];
const read = (adapters: RunnerAdapter[]) => readConsent(INPUT, { adapters: new Map(adapters.map((a) => [a.id, a])), settings: SETTINGS, cwd: "/tmp/switchboard-home/suggest" });

describe("consentCandidates", () => {
  test("candidates are the numbers of the person's text and of the reply before it", () => {
    expect(consentCandidates("#12 はマージして OK。Task #7 も", "PR #5741 を #12 でマージしてよいですか")).toEqual([12, 7, 5741]);
    expect(consentCandidates("はい", "PR #1 / #2 / #3 / #4")).toEqual([4, 3, 2]);
    expect(consentCandidates("merge許可する", "Task #5813 の PR #5836 を出した。親 PBI #5812。\nPR #5741 を判定の外でマージしてよいですか")).toEqual([5741, 5812, 5836]);
    expect(consentCandidates("> PR #99 を判定の外でマージしてよい\nはい", "")).toEqual([]);
  });
});

describe("buildConsentPrompt", () => {
  test("only the person's text consents; the reply before it only says what it points at", () => {
    const p = buildConsentPrompt({ ...INPUT, candidates: [5741] });
    expect(p).toContain("#5741");
    expect(p).toMatch(/利用者の文」だけ/);
    expect(p).toMatch(/迷ったら許可にしない/);
    expect(p).not.toContain('{"grants":[]}');
  });

  test("a long reply keeps its end, where the question is", () => {
    const p = buildConsentPrompt({ said: "はい", asked: `${"報告。".repeat(1000)}PR #5741 をマージしてよいですか`, candidates: [5741] });
    expect(p).toContain("PR #5741 をマージしてよいですか");
  });
});

describe("parseConsent", () => {
  test("grants of the three kinds on a candidate number are read", () => {
    expect(parseConsent('{"grants":[{"kind":"merge","target":5741},{"kind":"answer","target":5741},{"kind":"scope","target":5813}]}', [5741, 5813])).toEqual([
      { kind: "merge", target: 5741 },
      { kind: "answer", target: 5741 },
      { kind: "scope", target: 5813 },
    ]);
  });

  test("a grant of a number outside the candidates is dropped", () => {
    expect(parseConsent('{"grants":[{"kind":"merge","target":1},{"kind":"merge","target":5741},{"kind":"delete","target":5741}]}', [5741])).toEqual([{ kind: "merge", target: 5741 }]);
  });

  test("a broken answer reads as no grant", () => {
    for (const text of ["許可します", "{grants", '{"grants":"merge"}', '{"grants":[{"kind":"merge","target":"5741"}]}', ""]) expect(parseConsent(text, [5741])).toEqual([]);
  });
});

describe("readConsent", () => {
  test("the configured runner answers: its grants, asked read-only", async () => {
    const starts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", answer('{"grants":[{"kind":"merge","target":5741}]}'), starts), replayAdapter("claude", [])]);
    expect(out).toEqual([{ kind: "merge", target: 5741 }]);
    expect(starts[0]).toMatchObject({ permissionMode: "read-only", model: "gpt-6-luna" });
  });

  test("the fallback is asked once when the configured runner fails", async () => {
    const claudeStarts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", limited), replayAdapter("claude", answer('{"grants":[{"kind":"merge","target":5741}]}'), claudeStarts)]);
    expect(out).toEqual([{ kind: "merge", target: 5741 }]);
    expect(claudeStarts).toHaveLength(1);
    await expect(read([replayAdapter("codex", limited), replayAdapter("claude", limited)])).rejects.toThrow(/rate_limit_error/);
  });

  test("an answer with no grants list is a failure, not a refusal: the fallback is asked, then it throws", async () => {
    const claudeStarts: StartOptions[] = [];
    const out = await read([replayAdapter("codex", answer("許可します")), replayAdapter("claude", answer('{"grants":[]}'), claudeStarts)]);
    expect(out).toEqual([]);
    expect(claudeStarts).toHaveLength(1);
    await expect(read([replayAdapter("codex", answer("許可します")), replayAdapter("claude", answer("{grants"))])).rejects.toThrow(/no grants list/);
  });
});
