import { describe, expect, test } from "bun:test";
import type { AgentEvent, JudgeSettings, RunnerAdapter, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { buildConsentPrompt, consentCandidates, grantsFor, parseConsent, readConsent, requestedGrants } from "./merge-consent.ts";

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

describe("requestedGrants and grantsFor", () => {
  test("the grants a task asked for are read from the sentences written in its reply", () => {
    expect(requestedGrants(["PR #6044 に [merge-answer] yes を投稿してよい"])).toEqual([{ kind: "answer", target: 6044 }]);
    // inside backticks and a longer line; not a question; not another repository's; not a quoted line
    expect(requestedGrants(["次の文で通ります: `PR #7 を判定の外でマージしてよい` を送ってください。\nPR #8 を判定の外でマージしてよいですか\nacme/lib の PR #9 を判定の外でマージしてよい\n> PR #10 を判定の外でマージしてよい"])).toEqual([{ kind: "merge", target: 7 }]);
    expect(requestedGrants(["PR #6 に [merge-answer] yes を投稿してよい", "`PR #6 に [merge-answer] yes を投稿してよい`"])).toEqual([{ kind: "answer", target: 6 }]);
    expect(requestedGrants(["PR #6 をマージしてよい"])).toEqual([]);
    // another repository named in backticks before the sentence is another repository's too
    expect(requestedGrants(["`acme/lib` の PR #9 を判定の外でマージしてよい", "「acme/lib」の `PR #9 を判定の外でマージしてよい`", "**acme/lib** の **PR #9 を判定の外でマージしてよい**"])).toEqual([]);
  });

  test("a merge consent covers the answer mark of the same pull request; nothing else is added to what the reader read", () => {
    expect(grantsFor([{ kind: "merge", target: 12 }])).toEqual([
      { kind: "merge", target: 12 },
      { kind: "answer", target: 12 },
    ]);
    // the weaker consent does not become the stronger one
    expect(grantsFor([{ kind: "answer", target: 12 }])).toEqual([{ kind: "answer", target: 12 }]);
    expect(grantsFor([{ kind: "answer", target: 12 }, { kind: "merge", target: 12 }])).toEqual([
      { kind: "answer", target: 12 },
      { kind: "merge", target: 12 },
    ]);
  });

  test("no consent read is no grant, whatever the task asked for", () => {
    expect(grantsFor([])).toEqual([]);
  });

  test("the prompt lists what the task asked for, and the candidates are the person's numbers, then the reply's from its end", () => {
    const requested = [{ kind: "answer" as const, target: 6044 }, { kind: "merge" as const, target: 6044 }];
    const p = buildConsentPrompt({ said: "merge許可する", asked: "x", candidates: [6044], requested });
    expect(p).toContain("- answer: PR #6044 に [merge-answer] yes を投稿してよい");
    expect(p).toContain("- merge: PR #6044 を判定の外でマージしてよい");
    expect(p).toContain("種類を言い当てる必要はない");
    expect(p).toContain("認めたものだけを返す"); // offered two, allowed one: not both
    expect(buildConsentPrompt({ said: "はい", asked: "x", candidates: [1] })).not.toContain("Task が求めている許可");
    // a sentence for a number the reader may not return is not put to it
    expect(buildConsentPrompt({ said: "はい", asked: "x", candidates: [1], requested })).not.toContain("Task が求めている許可");
    // sentences earlier in a reply do not push out the question at its end, nor the number the person names
    expect(consentCandidates("はい", "`PR #1 を判定の外でマージしてよい` `PR #2 を判定の外でマージしてよい` `PR #3 を判定の外でマージしてよい`\nでは PR #12 はどうしますか")).toEqual([12, 3, 2]);
    expect(consentCandidates("#20 はマージして OK", "`PR #1 を判定の外でマージしてよい` PR #2 PR #3")).toEqual([20, 3, 2]);
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
  test("grants of the two kinds on a candidate number are read", () => {
    expect(parseConsent('{"grants":[{"kind":"merge","target":5741},{"kind":"answer","target":5741}]}', [5741, 5813])).toEqual([
      { kind: "merge", target: 5741 },
      { kind: "answer", target: 5741 },
    ]);
    // a kind that is not a grant any more is dropped
    expect(parseConsent('{"grants":[{"kind":"scope","target":5813}]}', [5741, 5813])).toEqual([]);
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
